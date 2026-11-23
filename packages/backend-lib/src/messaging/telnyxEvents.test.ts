import { generateKeyPairSync, randomUUID, sign } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { v5 as uuidv5 } from "uuid";

import config from "../config";
import { db } from "../db";
import {
  telnyxEmailReceipt,
  telnyxEmailSend,
  workspace,
} from "../db/schema";
import * as kafka from "../kafka";
import { InternalEventType, SubscriptionChange, TelnyxEvent } from "../types";
import { findUserEvents } from "../userEvents";
import { deleteAllUsers } from "../users";
import { createWorkspace } from "../workspaces";
import {
  drainTelnyxEmailEvents,
  normalizeTelnyxEmailEvent,
  persistTelnyxEmailEvent,
  verifyTelnyxSignature,
} from "./telnyxEvents";
import { completeTelnyxSend, prepareTelnyxSend } from "./telnyxState";

function fixture(): { event: TelnyxEvent; mapping: typeof telnyxEmailSend.$inferSelect } {
  const providerMessageId = randomUUID();
  return {
    event: { data: {
      id: randomUUID(), event_type: "email.delivered", record_type: "event",
      occurred_at: "2026-07-06T18:24:00.000Z",
      payload: { id: providerMessageId, to: { email: "primary@example.com", kind: "to" } },
    } },
    mapping: {
      id: randomUUID(), workspaceId: randomUUID(), credentialWorkspaceId: randomUUID(),
      messageId: randomUUID(), userId: "original-contact", primaryEmail: "primary@example.com",
      requestHash: "hash", providerMessageId, createdAt: new Date(),
      metadata: { templateId: randomUUID(), journeyId: randomUUID() },
    },
  };
}

describe("Telnyx Ed25519 verification", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const timestamp = "1795200000";
  const now = Number(timestamp) * 1000;
  const rawBody = Buffer.from('{ "data": {"unicode":"é", "id": "original"} }\n');
  const signature = sign(null, new TextEncoder().encode(`${timestamp}|${rawBody.toString("utf8")}`), keys.privateKey).toString("base64");
  const valid = { rawBody, signature, timestamp, publicKey, now };

  it("verifies the exact original bytes with the raw Mission Control public key", () => {
    expect(verifyTelnyxSignature(valid)).toBe(true);
    expect(verifyTelnyxSignature({ ...valid, rawBody: JSON.stringify(JSON.parse(rawBody.toString())) })).toBe(false);
    expect(verifyTelnyxSignature({ ...valid, rawBody: Buffer.from(`${rawBody.toString("utf8")} `) })).toBe(false);
  });

  it.each([-301, 301])("rejects a correctly signed callback %s seconds outside the replay window", (offset) => {
    expect(verifyTelnyxSignature({ ...valid, now: now + offset * 1000 })).toBe(false);
  });

  it.each([-300, 300])("accepts the exact %s-second boundary", (offset) => {
    expect(verifyTelnyxSignature({ ...valid, now: now + offset * 1000 })).toBe(true);
  });

  it("fails closed for missing keys, malformed headers and the wrong account", () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    expect(verifyTelnyxSignature({ ...valid, publicKey: undefined })).toBe(false);
    expect(verifyTelnyxSignature({ ...valid, publicKey: other })).toBe(false);
    expect(verifyTelnyxSignature({ ...valid, signature: undefined })).toBe(false);
    expect(verifyTelnyxSignature({ ...valid, timestamp: `${timestamp}.0` })).toBe(false);
    expect(verifyTelnyxSignature({ ...valid, publicKey: "not-a-key" })).toBe(false);
    expect(verifyTelnyxSignature({ ...valid, signature: `${signature}!` })).toBe(false);
  });
});

describe("Telnyx primary-contact normalization", () => {
  it("uses durable sender identity, envelope event time and event identity, without requiring recipient_id", () => {
    const { event, mapping } = fixture();
    event.data.payload.metadata = { workspaceId: randomUUID(), userId: "attacker", messageId: "forged" };
    const normalized = normalizeTelnyxEmailEvent(event, mapping);
    expect(normalized.item).toMatchObject({
      event: InternalEventType.EmailDelivered, userId: mapping.userId,
      timestamp: event.data.occurred_at, messageId: uuidv5(`telnyx:${event.data.id}`, mapping.workspaceId),
      properties: { workspaceId: mapping.workspaceId, messageId: mapping.messageId, templateId: mapping.metadata.templateId },
    });
    expect(normalizeTelnyxEmailEvent(event, mapping)).toEqual(normalized);
    const another = { data: { ...event.data, id: randomUUID() } };
    expect(normalizeTelnyxEmailEvent(another, mapping).item?.messageId).not.toEqual(normalized.item?.messageId);
  });

  it.each([
    { cc: { email: "primary@example.com" } },
    { bcc: { email: "redacted+sha256:1234567890123456@bcc.invalid" } },
    { to: { email: "different@example.com" } },
    { to: [{ email: "primary@example.com" }] },
    { to: { email: "primary@example.com", kind: "cc" } },
    { to: { email: 123 } },
    {},
  ])("retains unexpected/non-primary recipients without attributing them: %j", (recipient) => {
    const { event, mapping } = fixture();
    event.data.payload = { id: mapping.providerMessageId, ...recipient };
    expect(normalizeTelnyxEmailEvent(event, mapping)).toEqual({ disposition: "raw_only_non_primary_recipient" });
  });

  it("rejects ambiguous recipient fields even when to matches", () => {
    const { event, mapping } = fixture();
    event.data.payload.cc = null;
    expect(normalizeTelnyxEmailEvent(event, mapping).item).toBeUndefined();
  });

  it.each(["email.opened", "email.clicked"])("labels %s as observed, never verified human", (type) => {
    const { event, mapping } = fixture();
    event.data.event_type = type;
    Object.assign(event.data.payload, { url: "https://example.com/link", ip_address: "192.0.2.1", user_agent: "privacy proxy", first_open: true });
    const properties = normalizeTelnyxEmailEvent(event, mapping).item?.properties;
    expect(properties).toMatchObject({
      engagementClassification: "observed_unqualified", evidenceSource: "telnyx_webhook",
      url: "https://example.com/link", ip_address: "192.0.2.1", user_agent: "privacy proxy", first_open: true,
    });
    expect(properties).not.toHaveProperty("verifiedHuman");
  });

  it("retains precise click time and provider recipient evidence across retries and repeated observations", () => {
    const { event, mapping } = fixture();
    event.data.event_type = "email.clicked";
    event.data.occurred_at = "2026-11-20T07:23:45.123-05:00";
    Object.assign(event.data.payload, {
      url: "https://example.com/article?edition=1#chapter", recipient_id: "provider-recipient",
      metadata: { messageId: "forged", clickedAt: "2099-01-01T00:00:00Z" },
    });
    const first = normalizeTelnyxEmailEvent(event, mapping).item;
    expect(first).toMatchObject({
      timestamp: "2026-11-20T12:23:45.123Z",
      properties: {
        clickedAt: "2026-11-20T12:23:45.123Z", messageId: mapping.messageId,
        providerMessageId: mapping.providerMessageId, providerEventId: event.data.id,
        providerRecipientId: "provider-recipient", url: event.data.payload.url,
        evidenceSource: "telnyx_webhook", engagementClassification: "observed_unqualified",
      },
    });
    expect(normalizeTelnyxEmailEvent(event, mapping).item).toEqual(first);
    const repeated = { data: { ...event.data, id: randomUUID() } };
    expect(normalizeTelnyxEmailEvent(repeated, mapping).item?.messageId).not.toBe(first?.messageId);
    expect(normalizeTelnyxEmailEvent(repeated, mapping).item?.properties).toMatchObject({ messageId: mapping.messageId });
  });

  it("does not turn deferred delivery into a terminal failure", () => {
    const { event, mapping } = fixture();
    event.data.event_type = "email.deferred";
    expect(normalizeTelnyxEmailEvent(event, mapping)).toEqual({ disposition: "raw_only_unsupported" });
    event.data.event_type = "email.failed";
    expect(normalizeTelnyxEmailEvent(event, mapping).item).toMatchObject({
      event: InternalEventType.EmailDropped, properties: { reason: "email.failed" },
    });
  });

  it("emits a correctly scoped native unsubscribe only with the originating subscription group", () => {
    const { event, mapping } = fixture();
    event.data.event_type = "email.unsubscribed";
    expect(normalizeTelnyxEmailEvent(event, mapping)).toEqual({ disposition: "raw_only_provider_unsubscribe" });
    const subscriptionGroupId = randomUUID();
    mapping.metadata.subscriptionGroupId = subscriptionGroupId;
    expect(normalizeTelnyxEmailEvent(event, mapping).item).toMatchObject({
      event: InternalEventType.SubscriptionChange, userId: mapping.userId,
      properties: { subscriptionId: subscriptionGroupId, action: SubscriptionChange.Unsubscribe },
    });
  });
});

describe("Telnyx synchronous native projection", () => {
  it("persists native events before marking receipts projected even when Kafka writes are configured", async () => {
    const previousWriteMode = config().writeMode;
    const workspaceIds: string[] = [];
    const kafkaSend = jest.fn().mockResolvedValue({});
    const producer = jest.spyOn(kafka, "kafkaProducer").mockResolvedValue({
      send: kafkaSend,
    } as never);
    try {
      const sendingWorkspace = await createWorkspace({
        name: randomUUID(),
      }).then(unwrap);
      workspaceIds.push(sendingWorkspace.id);
      const credentialOwner = await createWorkspace({
        name: randomUUID(),
      }).then(unwrap);
      workspaceIds.push(credentialOwner.id);
      const { event, mapping } = fixture();
      const input = {
        workspaceId: sendingWorkspace.id,
        credentialWorkspaceId: credentialOwner.id,
        messageId: mapping.messageId,
        userId: mapping.userId,
        primaryEmail: mapping.primaryEmail,
        requestHash: mapping.requestHash,
        metadata: mapping.metadata,
      };
      const prepared = await prepareTelnyxSend(input);
      await completeTelnyxSend({
        id: prepared.id,
        providerMessageId: String(event.data.payload.id),
      });
      event.data.payload.metadata = {
        workspaceId: credentialOwner.id,
        userId: "forged-contact",
        messageId: "forged-message",
      };
      await persistTelnyxEmailEvent({
        credentialWorkspaceId: credentialOwner.id,
        rawBody: JSON.stringify(event),
        headers: {},
      });
      const [pending] = await db()
        .select()
        .from(telnyxEmailReceipt)
        .where(eq(telnyxEmailReceipt.eventId, event.data.id));
      expect(pending).toMatchObject({
        disposition: "pending",
        processedAt: null,
      });

      config().writeMode = "kafka";
      await drainTelnyxEmailEvents();

      const messageId = uuidv5(`telnyx:${event.data.id}`, input.workspaceId);
      const native = await findUserEvents({
        workspaceId: input.workspaceId,
        messageId,
      });
      expect(native).toHaveLength(1);
      expect(native[0]).toMatchObject({
        user_id: input.userId,
        event: InternalEventType.EmailDelivered,
        message_id: messageId,
      });
      expect(JSON.parse(native[0]?.properties ?? "{}")).toMatchObject({
        messageId: input.messageId,
        templateId: input.metadata.templateId,
        providerMessageId: event.data.payload.id,
        providerEventId: event.data.id,
      });
      const [projected] = await db()
        .select()
        .from(telnyxEmailReceipt)
        .where(eq(telnyxEmailReceipt.eventId, event.data.id));
      expect(projected).toMatchObject({
        disposition: "projected",
        attempts: 1,
      });
      expect(projected?.processedAt).toBeInstanceOf(Date);
      expect(await findUserEvents({
        workspaceId: credentialOwner.id,
        messageId: uuidv5(`telnyx:${event.data.id}`, credentialOwner.id),
      })).toHaveLength(0);
      expect(producer).not.toHaveBeenCalled();
      expect(kafkaSend).not.toHaveBeenCalled();

      await deleteAllUsers({ workspaceId: input.workspaceId });
      await persistTelnyxEmailEvent({
        credentialWorkspaceId: credentialOwner.id,
        rawBody: JSON.stringify({
          data: { ...event.data, id: randomUUID() },
        }),
        headers: {},
      });
      await drainTelnyxEmailEvents();
      expect(await db()
        .select()
        .from(telnyxEmailReceipt)
        .where(eq(telnyxEmailReceipt.credentialWorkspaceId, credentialOwner.id)),
      ).toHaveLength(0);
      expect(await db()
        .select()
        .from(telnyxEmailSend)
        .where(eq(telnyxEmailSend.workspaceId, input.workspaceId)),
      ).toHaveLength(0);
      expect(kafkaSend).not.toHaveBeenCalled();
    } finally {
      config().writeMode = previousWriteMode;
      producer.mockRestore();
      if (workspaceIds.length)
        await db().delete(workspace).where(inArray(workspace.id, workspaceIds));
    }
  });
});

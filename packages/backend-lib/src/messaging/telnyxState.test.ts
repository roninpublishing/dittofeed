import { createHash, randomUUID } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { EventEmitter, once } from "events";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { v5 as uuidv5 } from "uuid";

import * as batch from "../apps/batch";
import { db } from "../db";
import {
  subscriptionGroup, telnyxEmailDeletedSend as deletedSend,
  telnyxEmailReceipt as receipt, telnyxEmailSend as send,
  workspace as dbWorkspace,
} from "../db/schema";
import { InternalEventType, TelnyxEvent } from "../types";
import { findUserEvents } from "../userEvents";
import { deleteAllUsers, deleteUsers } from "../users";
import { createWorkspace } from "../workspaces";
import { drainTelnyxEmailEvents, persistTelnyxEmailEvent } from "./telnyxEvents";
import { completeTelnyxSend, deleteTelnyxUserData, prepareTelnyxSend, TelnyxSendConflictError } from "./telnyxState";

describe("durable Telnyx inbox and correlation", () => {
  let workspaceId: string;
  let ownerId: string;
  let input: Parameters<typeof prepareTelnyxSend>[0];
  let event: TelnyxEvent;

  beforeEach(async () => {
    workspaceId = (await createWorkspace({ name: randomUUID() }).then(unwrap)).id;
    ownerId = (await createWorkspace({ name: randomUUID() }).then(unwrap)).id;
    input = {
      workspaceId, credentialWorkspaceId: ownerId, messageId: randomUUID(),
      userId: randomUUID(), primaryEmail: "primary@example.com", requestHash: "stable-body-hash",
      metadata: { templateId: randomUUID(), arbitrarySecret: "must-not-persist" },
    };
    event = { data: {
      id: randomUUID(), event_type: "email.delivered", record_type: "event",
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
      payload: { id: randomUUID(), to: { email: input.primaryEmail, kind: "to" } },
    }, meta: { attempt: 1 } };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db().delete(dbWorkspace).where(inArray(dbWorkspace.id, [workspaceId, ownerId]));
  });

  async function persist(value = event, credentialWorkspaceId = ownerId) {
    await persistTelnyxEmailEvent({ credentialWorkspaceId, rawBody: JSON.stringify(value), headers: {
      "telnyx-signature-ed25519": "evidence-signature", "telnyx-timestamp": "1795200000",
      "content-type": "application/json", "user-agent": "Telnyx", authorization: "must-not-persist", cookie: "must-not-persist",
    } });
  }

  async function mapping() {
    const prepared = await prepareTelnyxSend(input);
    await completeTelnyxSend({ id: prepared.id, providerMessageId: String(event.data.payload.id) });
    return prepared;
  }

  async function receipts() {
    return db().select().from(receipt).where(eq(receipt.credentialWorkspaceId, ownerId));
  }

  it("converges concurrent logical retries without changing UUID, creation time or identity", async () => {
    const prepared = await Promise.all(Array.from({ length: 8 }, () => prepareTelnyxSend(input)));
    expect(new Set(prepared.map((value) => value.id)).size).toBe(1);
    expect(new Set(prepared.map((value) => value.createdAt.getTime())).size).toBe(1);
    const [row] = await db().select().from(send).where(eq(send.workspaceId, workspaceId));
    expect(row?.metadata).toEqual({
      templateId: input.metadata.templateId, workspaceId, userId: input.userId, messageId: input.messageId,
    });
    for (const changed of [
      { requestHash: "different" }, { credentialWorkspaceId: workspaceId },
      { userId: "different" }, { primaryEmail: "different@example.com" },
    ]) {
      await expect(prepareTelnyxSend({ ...input, ...changed })).rejects.toBeInstanceOf(TelnyxSendConflictError);
    }
    const id = prepared[0]?.id;
    if (!id) throw new Error("Missing prepared send");
    const providerMessageId = String(event.data.payload.id);
    await completeTelnyxSend({ id, providerMessageId });
    expect(await prepareTelnyxSend(input)).toMatchObject({ id, providerMessageId });
    await expect(completeTelnyxSend({ id, providerMessageId: randomUUID() })).rejects.toBeInstanceOf(TelnyxSendConflictError);
  });

  it("retains an early callback, drains after mapping, and does not ordinarily reproject duplicates", async () => {
    const original = JSON.stringify(event);
    await persist();
    await drainTelnyxEmailEvents();
    expect((await receipts())[0]?.disposition).toBe("pending");
    await mapping();
    await Promise.all([drainTelnyxEmailEvents(), drainTelnyxEmailEvents()]);
    await persist({ ...event, meta: { attempt: 2 } });
    await drainTelnyxEmailEvents();
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rawBody: original, disposition: "projected", attempts: 1 });
    expect(rows[0]?.evidenceHeaders).not.toHaveProperty("authorization");
    expect(rows[0]?.evidenceHeaders).not.toHaveProperty("cookie");
    const projected = await findUserEvents({ workspaceId, messageId: uuidv5(`telnyx:${event.data.id}`, workspaceId) });
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ user_id: input.userId, event: InternalEventType.EmailDelivered });
    expect(JSON.parse(projected[0]?.properties ?? "{}")).toMatchObject({ messageId: input.messageId, templateId: input.metadata.templateId });
    expect(await findUserEvents({ workspaceId: ownerId, messageId: uuidv5(`telnyx:${event.data.id}`, ownerId) })).toHaveLength(0);
  });

  it("never correlates an event authenticated under another credential owner's key", async () => {
    await mapping();
    await persist(event, workspaceId);
    await drainTelnyxEmailEvents();
    const [row] = await db().select().from(receipt).where(eq(receipt.credentialWorkspaceId, workspaceId));
    expect(row?.disposition).toBe("pending");
    expect(await findUserEvents({ workspaceId, messageId: uuidv5(`telnyx:${event.data.id}`, workspaceId) })).toHaveLength(0);
  });

  it("retains projection failures for a bounded backoff retry", async () => {
    await mapping();
    await persist();
    const projection = jest.spyOn(batch, "submitBatch").mockRejectedValueOnce(new Error("downstream unavailable"));
    await drainTelnyxEmailEvents();
    const [failed] = await receipts();
    expect(failed).toMatchObject({ disposition: "pending", attempts: 1, processedAt: null });
    expect(failed?.nextAttemptAt.getTime()).toBeGreaterThan(failed?.receivedAt.getTime() ?? 0);
    await drainTelnyxEmailEvents();
    expect(projection).toHaveBeenCalledTimes(1);
    await db().update(receipt).set({ nextAttemptAt: new Date(0) }).where(eq(receipt.credentialWorkspaceId, ownerId));
    await drainTelnyxEmailEvents();
    expect((await receipts())[0]).toMatchObject({ disposition: "projected", attempts: 2 });
  });

  it("limits each drain to 50 eligible receipts and leaves the remainder durable", async () => {
    await mapping();
    for (let i = 0; i < 55; i += 1) {
      await persist({ data: {
        ...event.data, id: randomUUID(),
        payload: { id: event.data.payload.id, cc: { email: input.primaryEmail } },
      } });
    }
    await drainTelnyxEmailEvents();
    const first = await receipts();
    expect(first.filter((row) => row.disposition === "pending")).toHaveLength(5);
    expect(first.filter((row) => row.disposition === "raw_only_non_primary_recipient")).toHaveLength(50);
    await drainTelnyxEmailEvents();
    expect((await receipts()).filter((row) => row.disposition === "pending")).toHaveLength(0);
  });

  it("waits for an in-flight projection before contact evidence erasure completes", async () => {
    await mapping();
    await persist();
    const signals = new EventEmitter();
    const entered = once(signals, "entered");
    const released = once(signals, "release");
    const original = batch.submitBatch;
    jest.spyOn(batch, "submitBatch").mockImplementationOnce(async (...args) => {
      signals.emit("entered");
      await released;
      return original(...args);
    });
    const draining = drainTelnyxEmailEvents();
    let deleting: Promise<void> | undefined;
    try {
      await Promise.race([
        entered,
        draining.then(() => { throw new Error("Projection exited before the erasure barrier"); }),
      ]);
      let deletionCompleted = false;
      deleting = deleteTelnyxUserData({ workspaceId, userIds: [input.userId] }).then(() => {
        deletionCompleted = true;
      });
      // Observe the actual exclusive erasure lock, rather than guessing with a sleep.
      let deletionStarted = false;
      for (let i = 0; i < 100 && !deletionStarted; i += 1) {
        deletionStarted = await db().transaction(async (tx) => {
          const result = await tx.execute<{ deleting: boolean }>(sql`select not pg_try_advisory_xact_lock_shared(hashtextextended(${workspaceId}, 0)) as deleting`);
          return result.rows[0]?.deleting ?? false;
        });
      }
      expect(deletionStarted).toBe(true);
      expect(deletionCompleted).toBe(false);
    } finally {
      signals.emit("release");
      await Promise.all([draining, deleting]);
    }
    expect(await receipts()).toHaveLength(0);
    expect(await db().select().from(send).where(eq(send.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("keeps CC/BCC, unknown/domain and malformed recipient shapes as raw evidence only", async () => {
    await mapping();
    const events: TelnyxEvent[] = [
      { data: { ...event.data, id: randomUUID(), payload: { id: event.data.payload.id, cc: { email: input.primaryEmail } } } },
      { data: { ...event.data, id: randomUUID(), payload: { id: event.data.payload.id, bcc: { email: "redacted+sha256:1234567890123456@bcc.invalid" } } } },
      { data: { ...event.data, id: randomUUID(), payload: { id: event.data.payload.id, to: [input.primaryEmail] } } },
      { data: { ...event.data, id: randomUUID(), event_type: "email_domain.verified", payload: { domain: "example.com" } } },
      { data: { ...event.data, id: randomUUID(), event_type: "email.deferred" } },
    ];
    for (const value of events) await persist(value);
    await drainTelnyxEmailEvents();
    const rows = await receipts();
    expect(rows).toHaveLength(events.length);
    expect(rows.every((row) => row.disposition.startsWith("raw_only_"))).toBe(true);
    expect(await findUserEvents({ workspaceId, userId: input.userId })).toHaveLength(0);
  });

  it("validates unsubscribe group ownership before creating a native subscription change", async () => {
    const id = randomUUID();
    const subscriptionGroupId = `${id.slice(0, 14)}7${id.slice(15)}`;
    await db().insert(subscriptionGroup).values({
      id: subscriptionGroupId, workspaceId: ownerId, name: randomUUID(), type: "OptOut", channel: "Email",
    });
    input.metadata.subscriptionGroupId = subscriptionGroupId;
    event.data.event_type = "email.unsubscribed";
    await mapping();
    await persist();
    await drainTelnyxEmailEvents();
    expect((await receipts())[0]?.disposition).toBe("raw_only_unknown_subscription_group");
    await db().update(subscriptionGroup).set({ workspaceId }).where(eq(subscriptionGroup.id, subscriptionGroupId));
    event.data.id = randomUUID();
    await persist();
    await drainTelnyxEmailEvents();
    const projected = await findUserEvents({ workspaceId, messageId: uuidv5(`telnyx:${event.data.id}`, workspaceId) });
    expect(projected[0]?.event).toBe(InternalEventType.SubscriptionChange);
    expect(JSON.parse(projected[0]?.properties ?? "{}")).toEqual({ subscriptionId: subscriptionGroupId, action: "Unsubscribe" });
  });

  it("really expires raw receipts after 30 days while preserving send correlation", async () => {
    const prepared = await mapping();
    await persist();
    await db().update(receipt).set({ receivedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(receipt.credentialWorkspaceId, ownerId));
    await drainTelnyxEmailEvents();
    expect(await receipts()).toHaveLength(0);
    expect(await prepareTelnyxSend(input)).toMatchObject({ id: prepared.id });
  });

  it("purges an early callback when accepted provider identity arrives after contact erasure", async () => {
    input.messageId = "caller@example.com";
    const prepared = await prepareTelnyxSend(input);
    await persist();
    await deleteTelnyxUserData({ workspaceId, userIds: [input.userId] });
    await expect(completeTelnyxSend({ id: prepared.id, providerMessageId: String(event.data.payload.id) })).rejects.toBeInstanceOf(TelnyxSendConflictError);
    expect(await receipts()).toHaveLength(0);
    const [tombstone] = await db().select().from(deletedSend).where(eq(deletedSend.id, prepared.id));
    expect(tombstone).toMatchObject({
      providerMessageId: event.data.payload.id,
      messageIdHash: createHash("sha256").update(input.messageId).digest("hex"),
    });
    expect(JSON.stringify(tombstone)).not.toContain(input.messageId);
    expect(JSON.stringify(tombstone)).not.toContain(input.userId);
    await persist();
    expect(await receipts()).toHaveLength(0);
    await expect(prepareTelnyxSend(input)).rejects.toBeInstanceOf(TelnyxSendConflictError);
  });

  it.each(["one", "all"])("native %s-user deletion erases only the originating workspace's send and evidence", async (scope) => {
    await mapping();
    await persist();
    const other = await prepareTelnyxSend({ ...input, workspaceId: ownerId, messageId: randomUUID() });
    const otherProviderId = randomUUID();
    await completeTelnyxSend({ id: other.id, providerMessageId: otherProviderId });
    const otherEvent = { data: { ...event.data, id: randomUUID(), payload: { ...event.data.payload, id: otherProviderId } } };
    await persist(otherEvent);
    if (scope === "one") await deleteUsers({ workspaceId, userIds: [input.userId] });
    else await deleteAllUsers({ workspaceId });
    expect(await db().select().from(send).where(eq(send.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db().select().from(send).where(and(eq(send.workspaceId, ownerId), eq(send.id, other.id)))).toHaveLength(1);
    expect((await receipts()).map((row) => row.eventId)).toEqual([otherEvent.data.id]);
    await persist();
    expect((await receipts()).map((row) => row.eventId)).toEqual([otherEvent.data.id]);
  });
});

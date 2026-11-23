import { createPublicKey, verify } from "crypto";
import { isValid, parseISO } from "date-fns";
import { and, eq, sql } from "drizzle-orm";
import { SourceType } from "isomorphic-lib/src/constants";
import { schemaValidate } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { v5 as uuidv5 } from "uuid";

import { submitBatch } from "../apps/batch";
import config from "../config";
import { db } from "../db";
import {
  subscriptionGroup,
  telnyxEmailDeletedSend as deletedSend,
  telnyxEmailReceipt as receipt,
  telnyxEmailSend as send,
} from "../db/schema";
import { buildSubscriptionChangeEventInner } from "../subscriptionGroups";
import {
  BatchTrackData, EmailProviderType, EventType, InternalEventType,
  SubscriptionChange, TelnyxEvent,
} from "../types";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;
const eventNames: Record<string, InternalEventType> = {
  "email.queued": InternalEventType.EmailProcessed,
  "email.sent": InternalEventType.EmailProcessed,
  "email.delivered": InternalEventType.EmailDelivered,
  "email.opened": InternalEventType.EmailOpened,
  "email.clicked": InternalEventType.EmailClicked,
  "email.bounced": InternalEventType.EmailBounced,
  "email.complained": InternalEventType.EmailMarkedSpam,
  "email.failed": InternalEventType.EmailDropped,
  "email.cancelled": InternalEventType.EmailDropped,
  "email.daily_limit_exceeded": InternalEventType.EmailDropped,
};

export function verifyTelnyxSignature({ rawBody, signature, timestamp, publicKey, now = Date.now() }: {
  rawBody: Buffer | string;
  signature?: string;
  timestamp?: string;
  publicKey?: string;
  now?: number;
}): boolean {
  if (!signature || !timestamp || !publicKey || !/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;
  try {
    const keyBytes = Buffer.from(publicKey, "base64");
    const signatureBytes = Buffer.from(signature, "base64");
    if (keyBytes.length !== 32 || keyBytes.toString("base64") !== publicKey ||
        signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature) return false;
    // RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
    const keyDer = Buffer.allocUnsafe(ED25519_SPKI_PREFIX.length + keyBytes.length);
    keyDer.set(ED25519_SPKI_PREFIX);
    keyDer.set(keyBytes, ED25519_SPKI_PREFIX.length);
    const key = createPublicKey({ key: keyDer, format: "der", type: "spki" });
    const prefix = Buffer.from(`${timestamp}|`);
    const bodyBytes = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix);
    message.set(bodyBytes, prefix.length);
    const signatureView = new Uint8Array(
      signatureBytes.buffer, signatureBytes.byteOffset, signatureBytes.byteLength,
    );
    return verify(null, message, key, signatureView);
  } catch {
    return false;
  }
}

export class InvalidTelnyxEventError extends Error {
  constructor() {
    super("Invalid Telnyx event envelope.");
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "InvalidTelnyxEventError";
  }
}

export async function persistTelnyxEmailEvent({ credentialWorkspaceId, rawBody, headers }: {
  credentialWorkspaceId: string;
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<void> {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  if (Buffer.isBuffer(rawBody) && !Buffer.from(body, "utf8").equals(
    new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength),
  )) {
    throw new InvalidTelnyxEventError();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new InvalidTelnyxEventError(); }
  const validated = schemaValidate(parsed, TelnyxEvent);
  if (validated.isErr()) throw new InvalidTelnyxEventError();
  const { data } = validated.value;
  if (!UUID_PATTERN.test(data.id) || !RFC3339_PATTERN.test(data.occurred_at) ||
      !isValid(parseISO(data.occurred_at))) {
    throw new InvalidTelnyxEventError();
  }
  const providerMessageId = typeof data.payload.id === "string" ? data.payload.id : null;
  const evidenceHeaders: Record<string, string> = {};
  for (const key of ["telnyx-signature-ed25519", "telnyx-timestamp", "content-type", "user-agent"]) {
    const value = headers[key];
    if (typeof value === "string") evidenceHeaders[key] = value;
  }
  const supported = Object.hasOwn(eventNames, data.event_type) || data.event_type === "email.unsubscribed";
  await db().transaction(async (tx) => {
    // Lock any known send before insertion so contact erasure removes its receipts too.
    if (providerMessageId) {
      await tx.select({ id: send.id }).from(send).where(and(
        eq(send.credentialWorkspaceId, credentialWorkspaceId), eq(send.providerMessageId, providerMessageId),
      )).for("update");
    }
    if (providerMessageId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${credentialWorkspaceId}:${providerMessageId}`}, 0))`);
    }
    const [deleted] = providerMessageId ? await tx.select({ id: deletedSend.id }).from(deletedSend).where(and(
      eq(deletedSend.credentialWorkspaceId, credentialWorkspaceId),
      eq(deletedSend.providerMessageId, providerMessageId),
    )).limit(1) : [];
    // A deleted send must not regain contact evidence through a late delivery.
    if (deleted) return;
    const disposition = supported && providerMessageId ? "pending" : "raw_only_unsupported";
    // First receipt wins even if delivery meta.attempt or serialization changes on retry.
    await tx.insert(receipt).values({
      credentialWorkspaceId, eventId: data.id, eventType: data.event_type,
      providerMessageId, rawBody: body, evidenceHeaders,
      disposition, processedAt: disposition === "pending" ? null : sql`now()`,
    }).onConflictDoNothing({ target: [receipt.credentialWorkspaceId, receipt.eventId] });
  });
}

export function normalizeTelnyxEmailEvent(event: TelnyxEvent, mapping: typeof send.$inferSelect): {
  item?: BatchTrackData;
  disposition: string;
} {
  const { data } = event;
  const { payload } = data;
  // Never use callback metadata/tags, email lookup, CC or redacted BCC for identity.
  const to = payload.to;
  if (payload.id !== mapping.providerMessageId || !to || typeof to !== "object" || Array.isArray(to) ||
      Object.hasOwn(payload, "cc") || Object.hasOwn(payload, "bcc")) {
    return { disposition: "raw_only_non_primary_recipient" };
  }
  const recipient = to as Record<string, unknown>;
  if ((recipient.kind !== undefined && recipient.kind !== "to") || typeof recipient.email !== "string" ||
      recipient.email.trim().toLowerCase() !== mapping.primaryEmail.trim().toLowerCase()) {
    return { disposition: "raw_only_non_primary_recipient" };
  }
  const timestamp = new Date(data.occurred_at).toISOString();
  const messageId = uuidv5(`telnyx:${data.id}`, mapping.workspaceId);
  if (data.event_type === "email.unsubscribed") {
    const subscriptionGroupId = mapping.metadata.subscriptionGroupId;
    if (!subscriptionGroupId) return { disposition: "raw_only_provider_unsubscribe" };
    return {
      disposition: "projected",
      item: buildSubscriptionChangeEventInner({
        messageId, userId: mapping.userId, subscriptionGroupId, timestamp,
        action: SubscriptionChange.Unsubscribe,
      }),
    };
  }
  const eventName = Object.hasOwn(eventNames, data.event_type) ? eventNames[data.event_type] : undefined;
  if (!eventName) return { disposition: "raw_only_unsupported" };
  const properties: Record<string, unknown> = {
    ...mapping.metadata, workspaceId: mapping.workspaceId, userId: mapping.userId,
    messageId: mapping.messageId, email: mapping.primaryEmail,
    provider: EmailProviderType.Telnyx,
    providerMessageId: mapping.providerMessageId, providerEventId: data.id,
    providerEventType: data.event_type, evidenceSource: "telnyx_webhook",
  };
  if (data.canonical_event_type) properties.canonicalEventType = data.canonical_event_type;
  if (typeof payload.recipient_id === "string") properties.providerRecipientId = payload.recipient_id;
  if (data.event_type === "email.opened" || data.event_type === "email.clicked") {
    properties.engagementClassification = "observed_unqualified";
    const observations = payload as Record<string, unknown>;
    for (const key of ["url", "ip", "ip_address", "user_agent", "first_open"]) {
      const value = observations[key];
      if (typeof value === "string" || typeof value === "boolean") properties[key] = value;
    }
  }
  if (eventName === InternalEventType.EmailClicked) properties.clickedAt = timestamp;
  if (eventName === InternalEventType.EmailOpened) properties.openedAt = timestamp;
  if (eventName === InternalEventType.EmailDropped) properties.reason = data.event_type;
  return { disposition: "projected", item: {
    type: EventType.Track, event: eventName, userId: mapping.userId, messageId, timestamp, properties,
  } };
}

export async function drainTelnyxEmailEvents(): Promise<void> {
  const deadline = Date.now() + 45_000;
  // Bound cleanup as well as projection; raw receipts expire at configured retention.
  await db().execute(sql`delete from "TelnyxEmailReceipt" where "id" in (
    select "id" from "TelnyxEmailReceipt"
    where "receivedAt" < now() - (${config().telnyxWebhookRetentionDays} * interval '1 day')
    order by "receivedAt" limit 1000 for update skip locked
  )`);
  for (let i = 0; i < 50 && Date.now() < deadline; i += 1) {
    // Acquire the workspace barrier before row locks: native ingestion can now
    // coordinate publication automations while erasure waits for this projection.
    const [candidate] = await db().select({ receiptId: receipt.id, workspaceId: send.workspaceId })
      .from(receipt).innerJoin(send, and(
        eq(receipt.credentialWorkspaceId, send.credentialWorkspaceId),
        eq(receipt.providerMessageId, send.providerMessageId),
      )).where(and(eq(receipt.disposition, "pending"), sql`${receipt.nextAttemptAt} <= now()`))
      .orderBy(receipt.nextAttemptAt).limit(1);
    if (!candidate) break;
    const handled = await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${candidate.workspaceId}, 0))`);
      const [row] = await tx.select({ receipt, send }).from(receipt).innerJoin(send, and(
        eq(receipt.credentialWorkspaceId, send.credentialWorkspaceId),
        eq(receipt.providerMessageId, send.providerMessageId),
      )).where(and(
        eq(receipt.disposition, "pending"), sql`${receipt.nextAttemptAt} <= now()`,
        eq(receipt.id, candidate.receiptId),
      )).orderBy(receipt.nextAttemptAt).limit(1).for("update", { skipLocked: true });
      // Unmapped receipts remain pending: an early callback is drained after completeTelnyxSend.
      if (!row) return false;
      try {
        const event = JSON.parse(row.receipt.rawBody) as TelnyxEvent;
        const normalized = normalizeTelnyxEmailEvent(event, row.send);
        if (normalized.item?.event === InternalEventType.SubscriptionChange) {
          const [group] = UUID_PATTERN.test(row.send.metadata.subscriptionGroupId ?? "") ? await tx.select({ id: subscriptionGroup.id }).from(subscriptionGroup).where(and(
            eq(subscriptionGroup.workspaceId, row.send.workspaceId),
            eq(subscriptionGroup.id, row.send.metadata.subscriptionGroupId ?? ""),
          )).limit(1) : [];
          if (!group) {
            normalized.item = undefined;
            normalized.disposition = "raw_only_unknown_subscription_group";
          }
        }
        if (normalized.item) {
          // PG evidence is authoritative. CH MergeTree cannot atomically commit with PG:
          // a crash after projection/before this receipt update can reproject (at-least-once).
          // A stable event messageId helps downstream dedup; it is NOT exactly-once storage.
          await submitBatch({ workspaceId: row.send.workspaceId, data: {
            context: { source: SourceType.Webhook, provider: EmailProviderType.Telnyx },
            batch: [normalized.item],
          } }, { writeModeOverride: "ch-sync", workspaceLockHeld: true });
        }
        await tx.update(receipt).set({
          processedAt: sql`now()`, disposition: normalized.disposition,
          attempts: row.receipt.attempts + 1,
        }).where(eq(receipt.id, row.receipt.id));
      } catch {
        // No provider body, address, header or downstream error goes into general logs.
        await tx.update(receipt).set({
          attempts: row.receipt.attempts + 1,
          nextAttemptAt: sql`now() + (${Math.min(3_600_000, 30_000 * 2 ** Math.min(row.receipt.attempts, 7))} * interval '1 millisecond')`,
        }).where(eq(receipt.id, row.receipt.id));
      }
      return true;
    });
    if (!handled) break;
  }
}

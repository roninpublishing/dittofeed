import { Type } from "@sinclair/typebox";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { jsonParseSafeWithSchema } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { classify, EventClass } from "isomorphic-lib/src/tracking/classify";
import {
  PUBLISHED_NETWORKS,
  publishedNetworkLookup,
} from "isomorphic-lib/src/tracking/networks";

import { clickhouseClient } from "../clickhouse";
import { Db } from "../db";
import {
  emailOpenTrackingReceipt as receipt,
  emailOpenTrackingSend as send,
  newsletter,
  newsletterSend,
  newsletterWebhookReceipt,
} from "../db/schema";
import { decrypt } from "../secrets";
import { InternalEventType } from "../types";
import type { OpenTrackingRequest } from "./openTracking";

const RAW_RETENTION_MS = 30 * 86_400_000;
const DUPLICATE_WINDOW_MS = 30_000;
type StoredReceipt = typeof receipt.$inferSelect;
type StoredSend = typeof send.$inferSelect;

const StoredHeaderValues = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Array(Type.String())]),
);
const StoredEmailOpenEnvelope = Type.Object({
  id: Type.String(),
  sendId: Type.String(),
  request: Type.Object({
    receivedAt: Type.String(),
    method: Type.Union([Type.Literal("GET"), Type.Literal("HEAD")]),
    path: Type.String(),
    query: Type.Record(Type.String(), Type.String()),
    headers: StoredHeaderValues,
    untrustedProxyHeaders: StoredHeaderValues,
    encrypted: Type.Boolean(),
    remoteAddress: Type.Optional(Type.String()),
    httpVersion: Type.Optional(Type.String()),
    edgeObserved: Type.Optional(
      Type.Object({
        source: Type.Literal("cloudflare_worker"),
        hostname: Type.String(),
        receivedAt: Type.String(),
        remoteAddress: Type.Optional(Type.String()),
        httpVersion: Type.Optional(Type.String()),
        tlsVersion: Type.Optional(Type.String()),
        asOrganization: Type.Optional(Type.String()),
        asn: Type.Optional(Type.Number()),
        country: Type.Optional(Type.String()),
        network: Type.Optional(
          Type.Object({ id: Type.String(), version: Type.String() }),
        ),
        networkSetVersion: Type.Optional(
          Type.Union([Type.String(), Type.Null()]),
        ),
      }),
    ),
  }),
});
const StoredDeliveryEvent = Type.Object({
  event: Type.String(),
  timestamp: Type.Number(),
  sg_message_id: Type.Optional(Type.String()),
});

export interface TrackingEvent {
  eventId: string;
  workspaceId: string;
  messageId: string;
  userId: string;
  newsletterId: string | null;
  kind: "open";
  occurredAt: string;
  ip: string | null;
  userAgent: string | null;
  asnOrg: string;
  asn: number | null;
  country: string;
  method: "GET" | "HEAD";
  secondsSinceDelivery: number | null;
  class: EventClass;
  reason: string;
  counted: boolean;
  rulesVersion: string;
  networkId: string | null;
  networkVersion: string | null;
}

export function readEmailOpenRequest(
  row: StoredReceipt,
  key: string,
): OpenTrackingRequest {
  const plaintext = decrypt({ ...row.encryptedRequest, secretKey: key });
  if (!plaintext) throw new Error("Invalid tracking evidence");
  const parsed = jsonParseSafeWithSchema(plaintext, StoredEmailOpenEnvelope, {
    method: "standard",
  });
  if (parsed.isErr()) throw new Error("Invalid tracking evidence");
  const envelope = parsed.value;
  if (
    envelope.id !== row.id ||
    envelope.sendId !== row.sendId ||
    envelope.request.method !== row.method ||
    envelope.request.receivedAt !== row.receivedAt.toISOString()
  ) {
    throw new Error("Invalid tracking evidence");
  }
  return envelope.request;
}

function actor(request: OpenTrackingRequest): {
  ip: string;
  userAgent: string;
} {
  const value = request.headers["user-agent"];
  return {
    // Forwarded headers are never used for actor identity.
    ip: request.edgeObserved
      ? request.edgeObserved.remoteAddress ?? ""
      : request.remoteAddress ?? "",
    userAgent: typeof value === "string" ? value : value?.join(" ") ?? "",
  };
}

/** Scan only the same-send preceding 30s; encrypted evidence never leaves here.
 * Keyset pages bound memory without silently losing actors in a busy send.
 * Occurrence + UUID gives equal-time receipts a stable total order. HEAD and
 * GET have independent histories, so scanner probes cannot hide a real open.
 */
async function recentActorHitMs(
  tx: Pick<Db, "select">,
  row: StoredReceipt,
  request: OpenTrackingRequest,
  key: string,
): Promise<number | null> {
  const current = actor(request);
  if (!current.ip || !current.userAgent) return null;
  let before = { time: row.receivedAt, id: row.id };
  for (;;) {
    // Each bounded keyset page depends on the preceding page's final key.
    // eslint-disable-next-line no-await-in-loop
    const preceding = await tx
      .select()
      .from(receipt)
      .where(
        and(
          eq(receipt.sendId, row.sendId),
          eq(receipt.method, row.method),
          gt(
            receipt.receivedAt,
            new Date(row.receivedAt.getTime() - DUPLICATE_WINDOW_MS),
          ),
          or(
            lt(receipt.receivedAt, before.time),
            and(eq(receipt.receivedAt, before.time), lt(receipt.id, before.id)),
          ),
        ),
      )
      .orderBy(desc(receipt.receivedAt), desc(receipt.id))
      .limit(100);
    for (const previous of preceding) {
      const priorActor = actor(readEmailOpenRequest(previous, key));
      if (
        priorActor.ip === current.ip &&
        priorActor.userAgent === current.userAgent
      ) {
        return row.receivedAt.getTime() - previous.receivedAt.getTime();
      }
    }
    const last = preceding[preceding.length - 1];
    if (preceding.length < 100 || !last) return null;
    before = { time: last.receivedAt, id: last.id };
  }
}

/** Native delivery is actual provider delivery, never accepted/MessageSent. */
async function nativeDeliveryTime(mapping: StoredSend): Promise<number | null> {
  const result = await clickhouseClient().query({
    query: `SELECT minOrNull(toUnixTimestamp64Milli(event_time)) AS deliveredAt
      FROM internal_events
      WHERE workspace_id = {workspaceId:String} AND user_id = {userId:String}
        AND origin_message_id = {messageId:String} AND event = {event:String}`,
    query_params: {
      workspaceId: mapping.workspaceId,
      userId: mapping.userId,
      messageId: mapping.messageId,
      event: InternalEventType.EmailDelivered,
    },
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ deliveredAt: string | number | null }>();
  return row?.deliveredAt === null || row?.deliveredAt === undefined
    ? null
    : Number(row.deliveredAt);
}

export async function getEmailOpenProjectionContext(
  tx: Pick<Db, "select">,
  mapping: StoredSend,
  row: StoredReceipt,
  request: OpenTrackingRequest,
  key: string,
): Promise<{
  deliveryMs: number | null;
  newsletterId: string | null;
  recentActorHitMs: number | null;
}> {
  const [nativeTime, history, newsletters, sends] = await Promise.all([
    nativeDeliveryTime(mapping),
    recentActorHitMs(tx, row, request, key),
    tx
      .select({ id: newsletter.workspaceId })
      .from(newsletter)
      .where(eq(newsletter.workspaceId, mapping.workspaceId))
      .limit(1),
    tx
      .select({
        id: newsletterSend.id,
        connectionId: newsletterSend.connectionId,
        mailboxHash: newsletterSend.mailboxHash,
        providerMessageId: newsletterSend.providerMessageId,
      })
      .from(newsletterSend)
      .where(
        and(
          eq(newsletterSend.workspaceId, mapping.workspaceId),
          eq(newsletterSend.userId, mapping.userId),
          eq(newsletterSend.logicalMessageId, mapping.messageId),
          isNull(newsletterSend.erasedAt),
        ),
      )
      .limit(1),
  ]);
  let deliveryMs = nativeTime;
  const [nativeSend] = sends;
  if (nativeSend) {
    // The provider has already correlated these receipts to an immutable send.
    // Read persisted callbacks even if their native projection is still pending.
    let after: string | undefined;
    for (;;) {
      // Preserve bounded memory and ordered keyset pagination on this transaction.
      // eslint-disable-next-line no-await-in-loop
      const callbacks = await tx
        .select({
          id: newsletterWebhookReceipt.id,
          encryptedPayload: newsletterWebhookReceipt.encryptedPayload,
        })
        .from(newsletterWebhookReceipt)
        .where(
          and(
            eq(newsletterWebhookReceipt.sendId, nativeSend.id),
            eq(newsletterWebhookReceipt.connectionId, nativeSend.connectionId),
            eq(newsletterWebhookReceipt.mailboxHash, nativeSend.mailboxHash),
            after ? gt(newsletterWebhookReceipt.id, after) : undefined,
          ),
        )
        .orderBy(newsletterWebhookReceipt.id)
        .limit(100);
      for (const callback of callbacks) {
        if (!callback.encryptedPayload) continue;
        const raw = decrypt({ ...callback.encryptedPayload, secretKey: key });
        if (!raw) throw new Error("Invalid delivery evidence");
        const parsed = jsonParseSafeWithSchema(raw, StoredDeliveryEvent, {
          method: "standard",
        });
        if (parsed.isErr()) throw new Error("Invalid delivery evidence");
        const event = parsed.value;
        if (
          event.event !== "delivered" ||
          Math.abs(event.timestamp * 1000) > 8_640_000_000_000_000
        )
          continue;
        if (
          nativeSend.providerMessageId &&
          typeof event.sg_message_id === "string" &&
          nativeSend.providerMessageId.split(".")[0] !==
            event.sg_message_id.split(".")[0]
        )
          continue;
        const at = event.timestamp * 1000;
        deliveryMs = deliveryMs === null ? at : Math.min(deliveryMs, at);
      }
      if (callbacks.length < 100) break;
      after = callbacks[callbacks.length - 1]?.id;
    }
  }
  return {
    deliveryMs,
    newsletterId: newsletters[0]?.id ?? null,
    recentActorHitMs: history,
  };
}

export function buildEmailOpenTrackingEvent(input: {
  mapping: StoredSend;
  receipt: StoredReceipt;
  request: OpenTrackingRequest;
  deliveryMs: number | null;
  newsletterId: string | null;
  recentActorHitMs: number | null;
  selfIps: readonly string[];
  now?: number;
}): TrackingEvent {
  const { mapping, receipt: row, request } = input;
  const at = row.receivedAt.getTime();
  const edge = request.edgeObserved;
  const current = actor(request);
  const ageMs = input.deliveryMs === null ? null : at - input.deliveryMs;
  const hasLiveEvidence =
    edge?.networkSetVersion !== undefined || edge?.network !== undefined;
  const network = hasLiveEvidence
    ? PUBLISHED_NETWORKS.find((item) => item.id === edge.network?.id) ?? null
    : publishedNetworkLookup(current.ip);
  const classification = classify(
    {
      kind: "open",
      method: request.method,
      userAgent: current.userAgent,
      ip: current.ip,
      asOrganization: edge?.asOrganization ?? "",
      ownerVerified: false,
      ageMs,
      otherLinksInBurst: 0,
      selfIps: input.selfIps,
      recentActorHitMs: input.recentActorHitMs,
    },
    () => network,
  );
  const retainRaw = at > (input.now ?? Date.now()) - RAW_RETENTION_MS;
  return {
    eventId: row.id,
    workspaceId: mapping.workspaceId,
    messageId: mapping.messageId,
    userId: mapping.userId,
    newsletterId: input.newsletterId,
    kind: "open",
    occurredAt: row.receivedAt.toISOString(),
    ip: retainRaw ? current.ip || null : null,
    userAgent: retainRaw ? current.userAgent || null : null,
    asnOrg: edge?.asOrganization ?? "",
    asn: edge?.asn ?? null,
    country: edge?.country ?? "",
    method: request.method,
    secondsSinceDelivery: ageMs === null ? null : ageMs / 1000,
    ...classification,
    networkId: network?.id ?? null,
    networkVersion: hasLiveEvidence
      ? edge.network?.version ?? edge.networkSetVersion ?? null
      : "reference:51ea4e7551564f6ddb55b60a34754863400e9133",
  };
}

export async function insertEmailOpenTrackingEvents(
  events: TrackingEvent[],
): Promise<void> {
  // Synchronous completion is part of the workspace erasure barrier. Slice for
  // callers other than the 50-receipt drainer as well; never async_insert.
  for (let offset = 0; offset < events.length; offset += 50) {
    const cutoff = Date.now() - RAW_RETENTION_MS;
    const values = events
      .slice(offset, offset + 50)
      .map((event) =>
        Date.parse(event.occurredAt) <= cutoff &&
        (event.ip !== null || event.userAgent !== null)
          ? { ...event, ip: null, userAgent: null }
          : event,
      );
    // Bound each synchronous insert while retaining the caller's erasure lock.
    // eslint-disable-next-line no-await-in-loop
    await clickhouseClient().insert({
      table: "trackingEvent",
      values,
      format: "JSONEachRow",
      clickhouse_settings: {
        wait_end_of_query: 1,
        async_insert: 0,
        date_time_input_format: "best_effort",
      },
    });
  }
}

export async function findExistingEmailOpenTrackingReceiptIds(
  workspaceId: string,
  eventIds: string[],
): Promise<Set<string>> {
  if (!eventIds.length) return new Set();
  const result = await clickhouseClient().query({
    query: `SELECT eventId FROM trackingEvent FINAL WHERE workspaceId = {workspaceId:String}
      AND eventId IN {eventIds:Array(UUID)}`,
    query_params: { workspaceId, eventIds },
    format: "JSONEachRow",
  });
  return new Set(
    (await result.json<{ eventId: string }>()).map((row) => row.eventId),
  );
}

/** FINAL is mandatory for crash retries; a read-time cutoff enforces privacy
 * immediately while ClickHouse's column TTL is waiting for its next merge.
 */
export async function findEmailOpenTrackingEvents(input: {
  workspaceId: string;
  userId?: string;
  messageId?: string;
  limit?: number;
}): Promise<TrackingEvent[]> {
  const result = await clickhouseClient().query({
    query: `SELECT * EXCEPT (ip, userAgent),
        if(occurredAt > now64(3) - INTERVAL 30 DAY, ip, NULL) AS ip,
        if(occurredAt > now64(3) - INTERVAL 30 DAY, userAgent, NULL) AS userAgent
      FROM trackingEvent FINAL WHERE workspaceId = {workspaceId:String}
        ${input.userId !== undefined ? "AND userId = {userId:String}" : ""}
        ${input.messageId !== undefined ? "AND messageId = {messageId:String}" : ""}
      ORDER BY occurredAt, eventId LIMIT {limit:UInt32}`,
    query_params: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      messageId: input.messageId,
      limit: Math.min(1000, Math.max(1, input.limit ?? 100)),
    },
    format: "JSONEachRow",
  });
  return result.json<TrackingEvent>();
}

/** Caller holds the exclusive workspace advisory lock through completion. */
export async function deleteEmailOpenTrackingEvents(
  workspaceId: string,
  userIds?: string[],
): Promise<void> {
  if (userIds && !userIds.length) return;
  await clickhouseClient().command({
    query: `ALTER TABLE trackingEvent DELETE WHERE workspaceId = {workspaceId:String}
      ${userIds ? "AND userId IN {userIds:Array(String)}" : ""}`,
    query_params: { workspaceId, userIds },
    clickhouse_settings: { mutations_sync: "2", wait_end_of_query: 1 },
  });
}

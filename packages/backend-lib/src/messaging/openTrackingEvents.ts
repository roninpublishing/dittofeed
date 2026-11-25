import { Type } from "@sinclair/typebox";
import { createHash } from "crypto";
import { and, gt, inArray } from "drizzle-orm";
import { stableJsonStringify } from "isomorphic-lib/src/equality";
import { jsonParseSafeWithSchema } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { classify, EventClass } from "isomorphic-lib/src/tracking/classify";
import { PUBLISHED_NETWORKS, publishedNetworkLookup } from "isomorphic-lib/src/tracking/networks";

import { clickhouseClient } from "../clickhouse";
import config from "../config";
import { Db } from "../db";
import { newsletterSend, newsletterWebhookReceipt } from "../db/schema";
import { decrypt, encrypt } from "../secrets";
import { InternalEventType } from "../types";
import type { OpenTrackingRequest } from "./openTracking";

const RAW_RETENTION_MS = 30 * 86_400_000;
const DUPLICATE_WINDOW_MS = 30_000;
type StoredSend = typeof newsletterSend.$inferSelect;

const StoredHeaderValues = Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]));
const StoredEmailOpenEnvelope = Type.Object({
  id: Type.String(), sendId: Type.String(),
  request: Type.Object({
    receivedAt: Type.String(),
    method: Type.Union([Type.Literal("GET"), Type.Literal("HEAD")]),
    path: Type.String(), query: Type.Record(Type.String(), Type.String()),
    headers: StoredHeaderValues, untrustedProxyHeaders: StoredHeaderValues,
    encrypted: Type.Boolean(), remoteAddress: Type.Optional(Type.String()),
    httpVersion: Type.Optional(Type.String()),
    edgeObserved: Type.Optional(Type.Object({
      source: Type.Literal("cloudflare_worker"), hostname: Type.String(), receivedAt: Type.String(),
      remoteAddress: Type.Optional(Type.String()), httpVersion: Type.Optional(Type.String()),
      tlsVersion: Type.Optional(Type.String()), asOrganization: Type.Optional(Type.String()),
      asn: Type.Optional(Type.Number()), country: Type.Optional(Type.String()),
      network: Type.Optional(Type.Object({ id: Type.String(), version: Type.String() })),
      networkSetVersion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    })),
  }),
});
const StoredDeliveryEvent = Type.Object({
  event: Type.String(), timestamp: Type.Number(), sg_message_id: Type.Optional(Type.String()),
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
  encryptedRequest: string | null;
  rawExpiresAt: string;
  requestHash: string;
}

export interface EmailOpenObservation {
  eventId: string;
  mapping: StoredSend;
  request: OpenTrackingRequest;
  requestHash: string;
}

// Object key order is not part of the signed observation's identity. Origin
// transport socket/TLS fields may change on Queue retries; edge evidence may not.

export function emailOpenRequestHash(sendId: string, request: OpenTrackingRequest): string {
  return createHash("sha256").update(stableJsonStringify({
    sendId, receivedAt: request.receivedAt, method: request.method,
    query: request.query, headers: request.headers,
    untrustedProxyHeaders: request.untrustedProxyHeaders, edgeObserved: request.edgeObserved,
  })).digest("hex");
}

export function readEmailOpenRequest(row: TrackingEvent, sendId: string, key: string): OpenTrackingRequest {
  if (!row.encryptedRequest || Date.parse(row.rawExpiresAt) <= Date.now() ||
      Date.parse(row.occurredAt) <= Date.now() - config().openTrackingRetentionDays * 86_400_000) throw new Error("Expired tracking evidence");
  const ciphertext = JSON.parse(row.encryptedRequest) as Parameters<typeof decrypt>[0];
  const plaintext = decrypt({ ...ciphertext, secretKey: key });
  if (!plaintext) throw new Error("Invalid tracking evidence");
  const parsed = jsonParseSafeWithSchema(plaintext, StoredEmailOpenEnvelope, { method: "standard" });
  if (parsed.isErr()) throw new Error("Invalid tracking evidence");
  const envelope = parsed.value;
  if (envelope.id !== row.eventId || envelope.sendId !== sendId ||
      envelope.request.method !== row.method ||
      Date.parse(envelope.request.receivedAt) !== Date.parse(row.occurredAt) ||
      emailOpenRequestHash(sendId, envelope.request) !== row.requestHash) throw new Error("Invalid tracking evidence");
  return envelope.request;
}

function actor(request: OpenTrackingRequest): { ip: string; userAgent: string } {
  const value = request.headers["user-agent"];
  return {
    ip: request.edgeObserved ? request.edgeObserved.remoteAddress ?? "" : request.remoteAddress ?? "",
    userAgent: typeof value === "string" ? value : value?.join(" ") ?? "",
  };
}

interface ActorHit {
  eventId: string; messageId: string; method: string;
  ip: string | null; userAgent: string | null; at: number;
}

/** Fetch the batch's actor history once. Future/self hits are excluded again
 * per occurrence below; GET and HEAD have independent actor histories. */
async function actorHistory(workspaceId: string, observations: readonly EmailOpenObservation[]): Promise<ActorHit[]> {
  if (!observations.length) return [];
  const times = observations.map((item) => Date.parse(item.request.receivedAt));
  const result = await clickhouseClient().query({
    query: `SELECT eventId, messageId, method, ip, userAgent,
        toUnixTimestamp64Milli(occurredAt) AS at FROM trackingEvent FINAL
      WHERE workspaceId = {workspaceId:String} AND messageId IN {messageIds:Array(String)}
        AND occurredAt >= fromUnixTimestamp64Milli({start:Int64})
        AND occurredAt <= fromUnixTimestamp64Milli({end:Int64})
        AND occurredAt > now64(3) - INTERVAL 30 DAY`,
    query_params: { workspaceId,
      messageIds: [...new Set(observations.map((item) => item.mapping.logicalMessageId))],
      start: Math.min(...times) - DUPLICATE_WINDOW_MS, end: Math.max(...times) },
    format: "JSONEachRow",
  });
  return (await result.json<ActorHit>()).map((row) => ({ ...row, at: Number(row.at) }));
}

/** Delivery means a native delivered event or a correlated provider receipt,
 * never acceptance or a synthetic send-time approximation. */
async function deliveryTimes(
  tx: Pick<Db, "select">, workspaceId: string, mappings: readonly StoredSend[], key: string,
): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  if (!mappings.length) return times;
  const sends = new Map(mappings.map((mapping) => [mapping.id, mapping]));
  const byMessage = new Map(mappings.map((mapping) => [mapping.logicalMessageId, mapping]));
  const result = await clickhouseClient().query({
    query: `SELECT origin_message_id AS messageId, user_id AS userId,
        min(toUnixTimestamp64Milli(event_time)) AS at FROM internal_events
      WHERE workspace_id = {workspaceId:String} AND origin_message_id IN {messageIds:Array(String)}
        AND event = {event:String} GROUP BY origin_message_id, user_id`,
    query_params: { workspaceId, messageIds: [...byMessage.keys()], event: InternalEventType.EmailDelivered },
    format: "JSONEachRow",
  });
  for (const row of await result.json<{ messageId: string; userId: string; at: number | string }>()) {
    const mapping = byMessage.get(row.messageId);
    if (mapping?.userId === row.userId) times.set(mapping.id, Number(row.at));
  }
  let after: string | undefined;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const callbacks = await tx.select().from(newsletterWebhookReceipt).where(and(
      inArray(newsletterWebhookReceipt.sendId, [...sends.keys()]),
      after ? gt(newsletterWebhookReceipt.id, after) : undefined,
    )).orderBy(newsletterWebhookReceipt.id).limit(100);
    for (const callback of callbacks) {
      const mapping = callback.sendId ? sends.get(callback.sendId) : undefined;
      if (!mapping || !callback.encryptedPayload || callback.connectionId !== mapping.connectionId ||
          callback.mailboxHash !== mapping.mailboxHash) continue;
      const raw = decrypt({ ...callback.encryptedPayload, secretKey: key });
      if (!raw) throw new Error("Invalid delivery evidence");
      const parsed = jsonParseSafeWithSchema(raw, StoredDeliveryEvent, { method: "standard" });
      if (parsed.isErr()) throw new Error("Invalid delivery evidence");
      const event = parsed.value;
      if (event.event !== "delivered" || !Number.isFinite(event.timestamp) ||
          Math.abs(event.timestamp * 1000) > 8_640_000_000_000_000) continue;
      if (mapping.providerMessageId && event.sg_message_id &&
          mapping.providerMessageId.split(".")[0] !== event.sg_message_id.split(".")[0]) continue;
      const at = event.timestamp * 1000;
      times.set(mapping.id, Math.min(times.get(mapping.id) ?? at, at));
    }
    if (callbacks.length < 100) break;
    after = callbacks[callbacks.length - 1]?.id;
  }
  return times;
}

export async function buildEmailOpenTrackingEvents(
  tx: Pick<Db, "select">, workspaceId: string,
  observations: readonly EmailOpenObservation[], key: string,
): Promise<TrackingEvent[]> {
  if (!observations.length) return [];
  const mappings = [...new Map(observations.map((item) => [item.mapping.id, item.mapping])).values()];
  const [history, deliveries] = await Promise.all([
    actorHistory(workspaceId, observations), deliveryTimes(tx, workspaceId, mappings, key),
  ]);
  const events: TrackingEvent[] = [];
  const ordered = [...observations].sort((a, b) =>
    Date.parse(a.request.receivedAt) - Date.parse(b.request.receivedAt) || a.eventId.localeCompare(b.eventId));
  for (const observation of ordered) {
    const { mapping, request, eventId, requestHash } = observation;
    const at = Date.parse(request.receivedAt);
    const current = actor(request);
    let recentActorHitMs: number | null = null;
    if (current.ip && current.userAgent) {
      for (const previous of history) {
        const delta = at - previous.at;
        if (previous.eventId === eventId || previous.messageId !== mapping.logicalMessageId ||
            previous.method !== request.method || previous.ip !== current.ip ||
            previous.userAgent !== current.userAgent || delta < 0 || delta >= DUPLICATE_WINDOW_MS ||
            (delta === 0 && previous.eventId >= eventId)) continue;
        recentActorHitMs = Math.min(recentActorHitMs ?? delta, delta);
      }
    }
    const deliveryMs = deliveries.get(mapping.id);
    const ageMs = deliveryMs === undefined ? null : at - deliveryMs;
    const edge = request.edgeObserved;
    const hasLiveEvidence = edge?.networkSetVersion !== undefined || edge?.network !== undefined;
    const network = hasLiveEvidence
      ? PUBLISHED_NETWORKS.find((item) => item.id === edge?.network?.id) ?? null
      : publishedNetworkLookup(current.ip);
    const classification = classify({
      kind: "open", method: request.method, userAgent: current.userAgent, ip: current.ip,
      asOrganization: edge?.asOrganization ?? "", ownerVerified: false, ageMs,
      otherLinksInBurst: 0, selfIps: config().openTrackingSelfIps, recentActorHitMs,
    }, () => network);
    const rawExpiresAt = new Date(at + config().openTrackingRetentionDays * 86_400_000).toISOString();
    const event: TrackingEvent = {
      eventId, workspaceId, messageId: mapping.logicalMessageId, userId: mapping.userId,
      newsletterId: workspaceId, kind: "open", occurredAt: request.receivedAt,
      ip: at > Date.now() - RAW_RETENTION_MS ? current.ip || null : null,
      userAgent: at > Date.now() - RAW_RETENTION_MS ? current.userAgent || null : null,
      asnOrg: edge?.asOrganization ?? "", asn: edge?.asn ?? null, country: edge?.country ?? "",
      method: request.method, secondsSinceDelivery: ageMs === null ? null : ageMs / 1000,
      ...classification, networkId: network?.id ?? null,
      networkVersion: hasLiveEvidence ? edge?.network?.version ?? edge?.networkSetVersion ?? null
        : "reference:51ea4e7551564f6ddb55b60a34754863400e9133",
      encryptedRequest: Date.parse(rawExpiresAt) > Date.now()
        ? JSON.stringify(encrypt(JSON.stringify({ id: eventId, sendId: mapping.id, request }), key)) : null,
      rawExpiresAt, requestHash,
    };
    events.push(event);
    history.push({ eventId, messageId: event.messageId, method: event.method,
      ip: current.ip, userAgent: current.userAgent, at });
  }
  return events;
}

export async function insertEmailOpenTrackingEvents(events: readonly TrackingEvent[]): Promise<void> {
  for (let offset = 0; offset < events.length; offset += 100) {
    const now = Date.now();
    const values = events.slice(offset, offset + 100).map((event) => ({
      ...event,
      ...(Date.parse(event.occurredAt) <= now - RAW_RETENTION_MS ? { ip: null, userAgent: null } : {}),
      ...(Date.parse(event.rawExpiresAt) <= now ? { encryptedRequest: null } : {}),
    }));
    // eslint-disable-next-line no-await-in-loop
    await clickhouseClient().insert({ table: "trackingEvent", values, format: "JSONEachRow",
      clickhouse_settings: { wait_end_of_query: 1, async_insert: 0, date_time_input_format: "best_effort" } });
  }
}

function normalizeTrackingEvent(event: TrackingEvent): TrackingEvent {
  const timestamp = (value: string) => new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toISOString();
  return { ...event, occurredAt: timestamp(event.occurredAt), rawExpiresAt: timestamp(event.rawExpiresAt) };
}

export async function findExistingEmailOpenTrackingEvents(
  workspaceId: string, eventIds: readonly string[],
): Promise<TrackingEvent[]> {
  if (!eventIds.length) return [];
  const result = await clickhouseClient().query({
    query: `SELECT * EXCEPT (ip, userAgent, encryptedRequest),
        if(occurredAt > now64(3) - INTERVAL 30 DAY, ip, NULL) AS ip,
        if(occurredAt > now64(3) - INTERVAL 30 DAY, userAgent, NULL) AS userAgent,
        if(rawExpiresAt > now64(3) AND occurredAt > fromUnixTimestamp64Milli({rawCutoff:Int64}), encryptedRequest, NULL) AS encryptedRequest
      FROM trackingEvent FINAL WHERE workspaceId = {workspaceId:String} AND eventId IN {eventIds:Array(UUID)}`,
    query_params: { workspaceId, eventIds, rawCutoff: Date.now() - config().openTrackingRetentionDays * 86_400_000 }, format: "JSONEachRow",
  });
  return (await result.json<TrackingEvent>()).map(normalizeTrackingEvent);
}

export async function findProjectedEmailOpenEventIds(workspaceId: string, eventIds: readonly string[]): Promise<Set<string>> {
  if (!eventIds.length) return new Set();
  const result = await clickhouseClient().query({
    query: `SELECT DISTINCT message_id AS eventId FROM internal_events
      WHERE workspace_id = {workspaceId:String} AND event = {event:String}
        AND message_id IN {eventIds:Array(String)}`,
    query_params: { workspaceId, eventIds, event: InternalEventType.EmailOpened }, format: "JSONEachRow",
  });
  return new Set((await result.json<{ eventId: string }>()).map((row) => row.eventId));
}

/** FINAL deduplicates transport retries. Read cutoffs enforce privacy before
 * background column-TTL merges have physically discarded expired evidence. */
export async function findEmailOpenTrackingEvents(input: {
  workspaceId: string; userId?: string; messageId?: string; evidenceId?: string; limit?: number;
}): Promise<TrackingEvent[]> {
  const result = await clickhouseClient().query({
    query: `SELECT * EXCEPT (ip, userAgent, encryptedRequest),
        if(occurredAt > now64(3) - INTERVAL 30 DAY, ip, NULL) AS ip,
        if(occurredAt > now64(3) - INTERVAL 30 DAY, userAgent, NULL) AS userAgent,
        if(rawExpiresAt > now64(3) AND occurredAt > fromUnixTimestamp64Milli({rawCutoff:Int64}), encryptedRequest, NULL) AS encryptedRequest
      FROM trackingEvent FINAL WHERE workspaceId = {workspaceId:String}
        ${input.userId !== undefined ? "AND userId = {userId:String}" : ""}
        ${input.messageId !== undefined ? "AND messageId = {messageId:String}" : ""}
        ${input.evidenceId !== undefined ? "AND eventId = {evidenceId:UUID}" : ""}
      ORDER BY occurredAt, eventId LIMIT {limit:UInt32}`,
    query_params: { ...input, rawCutoff: Date.now() - config().openTrackingRetentionDays * 86_400_000,
      limit: Math.min(1000, Math.max(1, input.limit ?? 100)) }, format: "JSONEachRow",
  });
  return (await result.json<TrackingEvent>()).map(normalizeTrackingEvent);
}

/** Caller holds the exclusive workspace advisory lock through completion. */
export async function deleteEmailOpenTrackingEvents(workspaceId: string, userIds?: string[]): Promise<void> {
  if (userIds && !userIds.length) return;
  await clickhouseClient().command({
    query: `ALTER TABLE trackingEvent DELETE WHERE workspaceId = {workspaceId:String}
      ${userIds ? "AND userId IN {userIds:Array(String)}" : ""}`,
    query_params: { workspaceId, userIds },
    clickhouse_settings: { mutations_sync: "2", wait_end_of_query: 1 },
  });
}

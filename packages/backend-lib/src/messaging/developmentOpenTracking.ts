import { createHash } from "crypto";
import { and, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { stableJsonStringify } from "isomorphic-lib/src/equality";
import { jsonParseSafeWithSchema } from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  DEVELOPMENT_PIXEL_BATCH_BYTES, DEVELOPMENT_PIXEL_BATCH_EVENTS, DEVELOPMENT_PIXEL_EVENT_BYTES, DEVELOPMENT_PIXEL_TABLE,
  DevelopmentPixelEvent, DevelopmentPixelEventSchema, DevelopmentPixelEvidence,
  DevelopmentPixelEvidenceSchema, isDevelopmentPixelSecret,
} from "isomorphic-lib/src/tracking/development";
import { isIP } from "net";

import { clickhouseClient } from "../clickhouse";
import config from "../config";
import { db, Db } from "../db";
import { newsletterErasure, newsletterSend, newsletterTrackingDomain } from "../db/schema";
import { newsletterContactHash } from "../newsletterSubscriptions";
import { decrypt, encrypt } from "../secrets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const REDACTED = "[REDACTED]";
export const DEVELOPMENT_PIXEL_ERASURE_LOCK = "development-open-pixel-erasure";
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class DevelopmentOpenTrackingError extends Error {
  constructor(public readonly status = 503) {
    super("Development open tracking unavailable");
    this.name = "DevelopmentOpenTrackingError";
    Object.setPrototypeOf(this, DevelopmentOpenTrackingError.prototype);
  }
}

interface StoredEvent {
  eventId: string; workspaceId: string; hostname: string;
  sendId: string | null; userId: string | null; messageId: string | null;
  status: "matched" | "unmatched" | "invalid"; method: string;
  occurredAt: string; receivedAt: string; rawExpiresAt: string;
  ip: string | null; userAgent: string | null; requestHash: string;
  tokenHash: string | null; encryptedEvidence: string | null;
}
export type DevelopmentPixelEventRecord = Omit<StoredEvent, "encryptedEvidence" | "tokenHash"> & {
  evidence: DevelopmentPixelEvidence | null;
};
export interface CaptureDevelopmentPixelEventInput { workspaceId: string; event: DevelopmentPixelEvent }
export interface DevelopmentPixelEventsPage { events: DevelopmentPixelEventRecord[]; nextCursor?: string }

function key(): string {
  const value = config().secretKey;
  if (typeof value !== "string" || Buffer.from(value, "base64").length !== 32) throw new DevelopmentOpenTrackingError();
  return value;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function tokenBarrier(tokenHash: string): string {
  return hash(`development-open-token\0${tokenHash}`);
}
function timestamp(value: string): string {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toISOString();
}
function normalize(row: StoredEvent): StoredEvent {
  return { ...row, occurredAt: timestamp(row.occurredAt), receivedAt: timestamp(row.receivedAt), rawExpiresAt: timestamp(row.rawExpiresAt) };
}

/** Redact again at the trust boundary, including token-bearing URLs and structured bodies. */
function sanitize(event: DevelopmentPixelEvent): DevelopmentPixelEvidence {
  const redactions = new Set(event.evidence.redactions);
  const scrubText = (text: string): string => {
    let result = event.token ? text.split(event.token).join(REDACTED) : text;
    result = result.replace(/(\/api\/public\/email\/open\/)[^/?#\s]+/g, `$1${REDACTED}.gif`);
    if (result !== text) redactions.add("backend:pixel-token");
    return result;
  };
  const scrubUrl = (text: string): string => {
    try {
      const url = new URL(text);
      if (url.username || url.password) { url.username = ""; url.password = ""; redactions.add("backend:url-credentials"); }
      for (const name of [...url.searchParams.keys()]) if (isDevelopmentPixelSecret(name)) {
        url.searchParams.set(name, REDACTED); redactions.add(`backend:query:${name}`);
      }
      return scrubText(url.toString());
    } catch { return scrubText(text); }
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return /^https?:\/\//i.test(value) ? scrubUrl(value) : scrubText(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [name, item] of Object.entries(value)) {
        const safeName = scrubText(name);
        if (isDevelopmentPixelSecret(name)) { result[safeName] = REDACTED; redactions.add(`backend:field:${name}`); }
        else result[safeName] = walk(item);
      }
      return result;
    }
    return value;
  };
  // Structured representations are inspected again. Opaque bytes remain evidence;
  // only known pixel capabilities can be recognized in arbitrary binary content.
  const { body, ...request } = event.evidence.request;
  const evidence = walk({ ...event.evidence, request: { ...request, body: { ...body, data: "" } } }) as DevelopmentPixelEvidence;
  const credentials = event.evidence.request.properties.credentials;
  if (credentials === "omit" || credentials === "same-origin" || credentials === "include") {
    evidence.request.properties.credentials = credentials;
    redactions.delete("backend:field:credentials");
  }
  if (body.data) {
    const bytes = Buffer.from(body.data, "base64");
    const text = bytes.toString("utf8");
    const validBase64 = bytes.toString("base64") === body.data;
    const inspectable = validBase64 && Buffer.from(text, "utf8").equals(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const contentType = Object.entries(event.evidence.request.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]?.split(";")[0]?.trim().toLowerCase();
    const representation = event.evidence.request.properties.developmentBodyRepresentation;
    let cleaned: Buffer | undefined;
    if (representation === "multipart-parts-json") {
      if (inspectable && !body.truncated) {
        try {
          const parts: unknown = JSON.parse(text);
          if (!Array.isArray(parts)) throw new Error("Invalid multipart representation");
          const safeParts = parts.map((part: unknown) => {
            if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("Invalid multipart part");
            const item = part as Record<string, unknown>;
            if (typeof item.name !== "string") throw new Error("Invalid multipart name");
            const name = scrubText(item.name);
            if (isDevelopmentPixelSecret(item.name)) {
              redactions.add(`backend:body:${name}`);
              return { name, value: REDACTED };
            }
            if (typeof item.value === "string") return { name, value: walk(item.value) };
            if (!item.file || typeof item.file !== "object" || Array.isArray(item.file)) throw new Error("Invalid multipart file");
            const file = item.file as Record<string, unknown>;
            if (typeof file.name !== "string" || typeof file.type !== "string" || typeof file.base64 !== "string") throw new Error("Invalid multipart file");
            const fileBytes = Buffer.from(file.base64, "base64");
            if (fileBytes.toString("base64") !== file.base64) throw new Error("Invalid multipart file encoding");
            const safeBytes = Buffer.from(scrubText(fileBytes.toString("latin1")), "latin1");
            return { name, file: { name: scrubText(file.name), type: scrubText(file.type), base64: safeBytes.toString("base64") } };
          });
          cleaned = Buffer.from(JSON.stringify(safeParts), "utf8");
        } catch { /* Malformed structured representations cannot be safely credential-redacted. */ }
      }
    } else if (representation === "redacted-json" || contentType === "application/json" || contentType?.endsWith("+json")) {
      if (inspectable && !body.truncated) {
        try { cleaned = Buffer.from(JSON.stringify(walk(JSON.parse(text))), "utf8"); }
        catch { /* Incomplete JSON is not safely inspectable. */ }
      }
    } else if (representation === "redacted-form-urlencoded" || contentType === "application/x-www-form-urlencoded") {
      if (inspectable && !body.truncated) {
        const params = new URLSearchParams(text);
        const form = new URLSearchParams();
        for (const [name, value] of params) {
          form.append(scrubText(name), isDevelopmentPixelSecret(name) ? REDACTED : scrubText(value));
          if (isDevelopmentPixelSecret(name)) redactions.add(`backend:body:${name}`);
        }
        cleaned = Buffer.from(form.toString(), "utf8");
      }
    } else if (validBase64 && !contentType?.startsWith("multipart/")) {
      // Latin-1 is a reversible byte mapping, unlike UTF-8 decoding of opaque files.
      cleaned = Buffer.from(scrubText(bytes.toString("latin1")), "latin1");
    }
    if (!cleaned) {
      evidence.request.body = { ...body, data: "", capturedBytes: 0, unavailable: "backend:uninspectable-body" };
      evidence.unavailable.push("backend:uninspectable-body");
    } else {
      evidence.request.body.data = cleaned.toString("base64");
      evidence.request.body.capturedBytes = cleaned.length;
    }
  }
  evidence.redactions = [...redactions].map(scrubText).sort();
  return evidence;
}

function identity(row: StoredEvent): Record<string, unknown> {
  return { eventId: row.eventId, workspaceId: row.workspaceId, hostname: row.hostname,
    sendId: row.sendId, userId: row.userId, messageId: row.messageId, status: row.status,
    method: row.method, occurredAt: row.occurredAt, rawExpiresAt: row.rawExpiresAt,
    tokenHash: row.tokenHash, requestHash: row.requestHash };
}

/** Capture only: this module deliberately has no classification or native event dependency. */
export async function captureDevelopmentPixelEvents(inputs: readonly CaptureDevelopmentPixelEventInput[]): Promise<void> {
  try {
    if (!config().enableOpenTracking || !config().enableOpenTrackingDevLake) throw new DevelopmentOpenTrackingError();
    if (inputs.length > DEVELOPMENT_PIXEL_BATCH_EVENTS) throw new DevelopmentOpenTrackingError();
    if (!inputs.length) return;
    const secretKey = key();
    const groups = new Map<string, { event: DevelopmentPixelEvent; evidence: DevelopmentPixelEvidence; tokenHash: string | null; requestHash: string }[]>();
    let batchBytes = Buffer.byteLength('{"v":3,"events":[]}');
    for (const input of inputs) {
      const encoded = JSON.stringify(input.event);
      const eventBytes = Buffer.byteLength(encoded);
      batchBytes += eventBytes + 1;
      if (!UUID.test(input.workspaceId) || eventBytes > DEVELOPMENT_PIXEL_EVENT_BYTES || batchBytes > DEVELOPMENT_PIXEL_BATCH_BYTES) throw new DevelopmentOpenTrackingError();
      const parsed = jsonParseSafeWithSchema(encoded, DevelopmentPixelEventSchema, { method: "standard" });
      if (parsed.isErr() || Date.parse(input.event.occurredAt) > Date.now() + 300_000) throw new DevelopmentOpenTrackingError();
      const workspaceId = input.workspaceId.toLowerCase();
      const event = { ...parsed.value, eventId: parsed.value.eventId.toLowerCase(), occurredAt: new Date(parsed.value.occurredAt).toISOString() };
      const evidence = sanitize(event);
      const tokenHash = event.token ? hash(event.token) : null;
      const requestHash = hash(stableJsonStringify({ workspaceId, eventId: event.eventId, hostname: event.hostname, occurredAt: event.occurredAt, tokenHash, evidence }));
      const group = groups.get(workspaceId) ?? [];
      group.push({ event, evidence, tokenHash, requestHash }); groups.set(workspaceId, group);
    }
    for (const [workspaceId, group] of groups) await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${DEVELOPMENT_PIXEL_ERASURE_LOCK}, 1))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
      const domains = await tx.select().from(newsletterTrackingDomain).where(and(
        eq(newsletterTrackingDomain.newsletterId, workspaceId),
        inArray(newsletterTrackingDomain.hostname, [...new Set(group.map(({ event }) => event.hostname))]),
        isNotNull(newsletterTrackingDomain.verifiedAt),
      ));
      const hosts = new Set(domains.map((domain) => domain.hostname));
      if (group.some(({ event }) => !hosts.has(event.hostname))) throw new DevelopmentOpenTrackingError();
      const hashes = group.flatMap((item) => item.tokenHash ? [item.tokenHash] : []);
      const mappings = hashes.length ? await tx.select().from(newsletterSend).where(and(
        eq(newsletterSend.workspaceId, workspaceId), inArray(newsletterSend.openTrackingTokenHash, hashes),
      )) : [];
      const tokenBarriers = hashes.map(tokenBarrier);
      const userBarriers = mappings.map((row) => newsletterContactHash(workspaceId, row.userId));
      const erased = new Set(tokenBarriers.length || userBarriers.length ? (await tx.select({ hash: newsletterErasure.userHash }).from(newsletterErasure).where(or(
        tokenBarriers.length ? inArray(newsletterErasure.userHash, tokenBarriers) : undefined,
        userBarriers.length ? and(eq(newsletterErasure.workspaceId, workspaceId), inArray(newsletterErasure.userHash, userBarriers)) : undefined,
      ))).map((row) => row.hash) : []);
      const byHash = new Map(mappings.map((row) => [row.openTrackingTokenHash, row]));
      const events = new Map<string, StoredEvent>();
      for (const { event, evidence, tokenHash, requestHash } of group) {
        const mapping = tokenHash ? byHash.get(tokenHash) : undefined;
        if ((tokenHash && erased.has(tokenBarrier(tokenHash))) ||
            (mapping && (mapping.erasedAt || erased.has(newsletterContactHash(workspaceId, mapping.userId))))) continue;
        const expiry = Date.parse(event.occurredAt) + config().openTrackingRetentionDays * DAY;
        if (expiry <= Date.now()) continue;
        let originalHostMatches = false;
        try { originalHostMatches = new URL(event.evidence.request.url).hostname === event.hostname; } catch { /* Retain invalid original URLs without assigning contact identity. */ }
        let matched = false;
        if (originalHostMatches && mapping?.openTrackingOrigin && mapping.encryptedOpenTrackingToken && new URL(mapping.openTrackingOrigin).hostname === event.hostname) {
          const plaintext = decrypt({ ...mapping.encryptedOpenTrackingToken, secretKey });
          if (!plaintext) throw new DevelopmentOpenTrackingError();
          const token = JSON.parse(plaintext) as { id?: unknown; token?: unknown };
          if (token.id !== mapping.id || token.token !== event.token) throw new DevelopmentOpenTrackingError();
          matched = true;
        }
        const previous = events.get(event.eventId);
        if (previous && previous.requestHash !== requestHash) throw new DevelopmentOpenTrackingError();
        if (previous) continue;
        const ip = Object.entries(evidence.request.headers).find(([name]) => name.toLowerCase() === "cf-connecting-ip")?.[1];
        const userAgent = Object.entries(evidence.request.headers).find(([name]) => name.toLowerCase() === "user-agent")?.[1] ?? null;
        const row: StoredEvent = { eventId: event.eventId, workspaceId, hostname: event.hostname,
          sendId: matched ? mapping!.id : null, userId: matched ? mapping!.userId : null,
          messageId: matched ? mapping!.logicalMessageId : null,
          status: matched ? "matched" : originalHostMatches && event.token && !mapping ? "unmatched" : "invalid",
          method: evidence.request.method, occurredAt: event.occurredAt, receivedAt: new Date().toISOString(),
          rawExpiresAt: new Date(expiry).toISOString(), ip: ip && isIP(ip) ? ip : null, userAgent,
          tokenHash, requestHash, encryptedEvidence: null };
        row.encryptedEvidence = JSON.stringify(encrypt(JSON.stringify({ ...identity(row), evidence }), secretKey));
        events.set(row.eventId, row);
      }
      if (!events.size) return;
      const result = await clickhouseClient().query({
        query: `SELECT * FROM ${DEVELOPMENT_PIXEL_TABLE} FINAL WHERE workspaceId = {workspaceId:String} AND eventId IN {eventIds:Array(UUID)}`,
        query_params: { workspaceId, eventIds: [...events.keys()] }, format: "JSONEachRow",
      });
      const stored = await result.json<StoredEvent>();
      for (const row of stored) {
        if (events.get(row.eventId)?.requestHash !== row.requestHash) throw new DevelopmentOpenTrackingError();
        events.delete(row.eventId); // Freeze the first durable record, including its correlation and retention deadline.
      }
      if (events.size) await clickhouseClient().insert({ table: DEVELOPMENT_PIXEL_TABLE,
        values: [...events.values()], format: "JSONEachRow",
        clickhouse_settings: { wait_end_of_query: 1, async_insert: 0, date_time_input_format: "best_effort" } });
    });
  } catch { throw new DevelopmentOpenTrackingError(); }
}

export async function findDevelopmentPixelEvents(input: {
  workspaceId: string; eventId?: string; userId?: string; messageId?: string; limit?: number; before?: string;
}): Promise<DevelopmentPixelEventsPage> {
  try {
    if (!UUID.test(input.workspaceId) || (input.eventId !== undefined && !UUID.test(input.eventId))) throw new DevelopmentOpenTrackingError(400);
    const workspaceId = input.workspaceId.toLowerCase();
    const limit = Math.min(1000, Math.max(1, input.limit ?? 100));
    if (!Number.isInteger(input.limit ?? 100) || !Number.isFinite(input.limit ?? 100)) throw new DevelopmentOpenTrackingError(400);
    const scope = hash(stableJsonStringify({ workspaceId, eventId: input.eventId?.toLowerCase() ?? null,
      userId: input.userId ?? null, messageId: input.messageId ?? null }));
    let cursor: { occurredAt: string; eventId: string; scope: string } | undefined;
    if (input.before) {
      try { cursor = JSON.parse(Buffer.from(input.before, "base64url").toString("utf8")) as typeof cursor; }
      catch { throw new DevelopmentOpenTrackingError(400); }
      if (!cursor || !UUID.test(cursor.eventId) || !Number.isFinite(Date.parse(cursor.occurredAt)) || cursor.scope !== scope) throw new DevelopmentOpenTrackingError(400);
    }
    return await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${DEVELOPMENT_PIXEL_ERASURE_LOCK}, 1))`);
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${workspaceId}, 0))`);
      const result = await clickhouseClient().query({
        query: `SELECT * FROM ${DEVELOPMENT_PIXEL_TABLE} FINAL WHERE workspaceId = {workspaceId:String}
          AND rawExpiresAt > now64(3) AND occurredAt > fromUnixTimestamp64Milli({cutoff:Int64})
          ${input.userId !== undefined ? "AND userId = {userId:String}" : ""}
          ${input.messageId !== undefined ? "AND messageId = {messageId:String}" : ""}
          ${input.eventId !== undefined ? "AND eventId = {eventId:UUID}" : ""}
          ${cursor ? "AND (occurredAt, eventId) < (parseDateTime64BestEffort({beforeTime:String}, 3), {beforeId:UUID})" : ""}
          ORDER BY occurredAt DESC, eventId DESC LIMIT {limit:UInt32}`,
        query_params: { ...input, workspaceId, cutoff: Date.now() - config().openTrackingRetentionDays * DAY,
          beforeTime: cursor?.occurredAt, beforeId: cursor?.eventId, limit: limit + 1 }, format: "JSONEachRow",
      });
      const rows = (await result.json<StoredEvent>()).map(normalize);
      const tokenBarriers = rows.flatMap((row) => row.tokenHash ? [tokenBarrier(row.tokenHash)] : []);
      const userBarriers = rows.flatMap((row) => row.userId ? [newsletterContactHash(workspaceId, row.userId)] : []);
      const erased = new Set(tokenBarriers.length || userBarriers.length ? (await tx.select({ hash: newsletterErasure.userHash }).from(newsletterErasure).where(or(
        tokenBarriers.length ? inArray(newsletterErasure.userHash, tokenBarriers) : undefined,
        userBarriers.length ? and(eq(newsletterErasure.workspaceId, workspaceId), inArray(newsletterErasure.userHash, userBarriers)) : undefined,
      ))).map((row) => row.hash) : []);
      const secretKey = key();
      const events: DevelopmentPixelEventRecord[] = [];
      for (const row of rows.slice(0, limit)) {
        if (row.workspaceId !== workspaceId || Date.parse(row.rawExpiresAt) <= Date.now() ||
            Date.parse(row.occurredAt) <= Date.now() - config().openTrackingRetentionDays * DAY ||
            (row.userId && erased.has(newsletterContactHash(workspaceId, row.userId))) ||
            (row.tokenHash && erased.has(tokenBarrier(row.tokenHash)))) continue;
        let evidence: DevelopmentPixelEvidence | null = null;
        if (row.encryptedEvidence) {
          const plaintext = decrypt({ ...JSON.parse(row.encryptedEvidence) as Parameters<typeof decrypt>[0], secretKey });
          if (!plaintext) throw new DevelopmentOpenTrackingError();
          const envelope = JSON.parse(plaintext) as Record<string, unknown>;
          for (const [name, value] of Object.entries(identity(row))) if (envelope[name] !== value) throw new DevelopmentOpenTrackingError();
          const parsed = jsonParseSafeWithSchema(JSON.stringify(envelope.evidence), DevelopmentPixelEvidenceSchema, { method: "standard" });
          if (parsed.isErr()) throw new DevelopmentOpenTrackingError();
          evidence = parsed.value;
        }
        const { encryptedEvidence: _encrypted, tokenHash: _tokenHash, ...metadata } = row;
        events.push({ ...metadata, evidence });
      }
      const last = rows[Math.min(rows.length, limit) - 1];
      return { events, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ occurredAt: last.occurredAt, eventId: last.eventId, scope })).toString("base64url") } : {}) };
    });
  } catch (error) {
    if (error instanceof DevelopmentOpenTrackingError && error.status === 400) throw error;
    throw new DevelopmentOpenTrackingError();
  }
}

/** Caller holds the exclusive workspace erasure lock. */
export async function deleteDevelopmentPixelEvents(workspaceId: string, userIds?: string[]): Promise<void> {
  if (userIds && !userIds.length) return;
  await clickhouseClient().command({
    query: `ALTER TABLE ${DEVELOPMENT_PIXEL_TABLE} DELETE WHERE workspaceId = {workspaceId:String}
      ${userIds ? "AND userId IN {userIds:Array(String)}" : ""}`,
    query_params: { workspaceId, userIds }, clickhouse_settings: { mutations_sync: "2", wait_end_of_query: 1 },
  });
}

/** Caller holds global exclusive erasure lock before the workspace lock. Preserve token
 * barriers before canonical hashes disappear; uncorrelated receipts can exist on any host. */
export async function eraseDevelopmentPixelEvents(tx: Transaction, workspaceId: string, userIds?: string[]): Promise<void> {
  if (userIds && !userIds.length) return;
  for (let offset = 0; offset < (userIds?.length ?? 1); offset += 500) {
    const scopeIds = userIds?.slice(offset, offset + 500);
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const rows = await tx.select({ id: newsletterSend.id, hash: newsletterSend.openTrackingTokenHash }).from(newsletterSend).where(and(
        eq(newsletterSend.workspaceId, workspaceId), gt(newsletterSend.id, after), isNotNull(newsletterSend.openTrackingTokenHash),
        scopeIds ? inArray(newsletterSend.userId, scopeIds) : undefined,
      )).orderBy(newsletterSend.id).limit(500);
      if (!rows.length) break;
      const hashes = rows.flatMap((row) => row.hash ? [row.hash] : []);
      await tx.insert(newsletterErasure).values(hashes.map((value) => ({ workspaceId, userHash: tokenBarrier(value) }))).onConflictDoNothing();
      await clickhouseClient().command({
        query: `ALTER TABLE ${DEVELOPMENT_PIXEL_TABLE} DELETE WHERE tokenHash IN {hashes:Array(String)}`,
        query_params: { hashes }, clickhouse_settings: { mutations_sync: "2", wait_end_of_query: 1 },
      });
      after = rows[rows.length - 1]!.id;
    }
    await deleteDevelopmentPixelEvents(workspaceId, scopeIds);
  }
}

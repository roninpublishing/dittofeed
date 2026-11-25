import { createHash, randomBytes } from "crypto";
import { isValid, parseISO } from "date-fns";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import escapeHtml from "escape-html";
import { SourceType } from "isomorphic-lib/src/constants";
import { PUBLISHED_NETWORKS } from "isomorphic-lib/src/tracking/networks";
import { isIP } from "net";

import { submitBatch } from "../apps/batch";
import { clickhouseClient } from "../clickhouse";
import config from "../config";
import { db, Db } from "../db";
import { newsletter, newsletterErasure, newsletterSend } from "../db/schema";
import type { NewsletterCiphertext } from "../db/publisherSchema";
import { newsletterContactHash } from "../newsletterSubscriptions";
import { getNewsletterTrackingOrigin } from "../newsletterTracking";
import { decrypt, encrypt } from "../secrets";
import { EventType, InternalEventType } from "../types";
import {
  buildEmailOpenTrackingEvents, deleteEmailOpenTrackingEvents, EmailOpenObservation,
  emailOpenRequestHash, findEmailOpenTrackingEvents, findExistingEmailOpenTrackingEvents,
  findProjectedEmailOpenEventIds, insertEmailOpenTrackingEvents, readEmailOpenRequest,
} from "./openTrackingEvents";

export const OPEN_TRACKING_PIXEL_PATH = "/api/public/email/open/:token.gif";
export const OPEN_TRACKING_REQUEST_LIMITS = {
  headerValueChars: 512,
  headerArrayLength: 4,
  headerArrayValueChars: 128,
  totalHeaderChars: 3072,
  queryValueChars: 20,
  envelopeBytes: 16_384,
} as const;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;
const HEADERS: Record<string, true> = {
  "user-agent": true, accept: true, "accept-language": true, "accept-encoding": true,
  "cache-control": true, pragma: true, range: true, "if-modified-since": true,
  "if-none-match": true, "sec-fetch-dest": true, "sec-fetch-mode": true,
  "sec-fetch-site": true, "sec-fetch-user": true, "sec-ch-ua": true,
  "sec-ch-ua-mobile": true, "sec-ch-ua-platform": true,
};
const PROXY_HEADERS: Record<string, true> = {
  forwarded: true, "x-forwarded-for": true, "x-real-ip": true, via: true,
  "cf-connecting-ip": true, "cf-ipcountry": true,
};
type HeaderValues = Record<string, string | string[]>;

export interface OpenTrackingEdgeObservation {
  source: "cloudflare_worker";
  hostname: string;
  receivedAt: string;
  remoteAddress?: string;
  httpVersion?: string;
  tlsVersion?: string;
  asOrganization?: string;
  asn?: number;
  country?: string;
  network?: { id: string; version: string };
  networkSetVersion?: string | null;
}

export interface OpenTrackingRequestInput {
  receivedAt: string;
  method: string;
  path?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  remoteAddress?: string;
  httpVersion?: string;
  encrypted?: boolean;
  edgeObserved?: OpenTrackingEdgeObservation;
}

export interface OpenTrackingRequest {
  receivedAt: string;
  method: "GET" | "HEAD";
  path: string;
  query: Record<string, string>;
  headers: HeaderValues;
  // Client-controlled hints, never the authoritative socket address or identity.
  untrustedProxyHeaders: HeaderValues;
  remoteAddress?: string;
  httpVersion?: string;
  encrypted: boolean;
  edgeObserved?: OpenTrackingEdgeObservation;
}

export class OpenTrackingError extends Error {
  constructor() {
    super("Email open tracking operation failed.");
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "OpenTrackingError";
  }
}

/** Only bounded, deliberately selected request fields are encrypted and retained. */
export function sanitizeOpenTrackingRequest(input: OpenTrackingRequestInput): OpenTrackingRequest | null {
  if ((input.method !== "GET" && input.method !== "HEAD") ||
      typeof input.receivedAt !== "string" || input.receivedAt.length > 40 ||
      !TIMESTAMP_PATTERN.test(input.receivedAt)) return null;
  const receivedAt = parseISO(input.receivedAt);
  if (!isValid(receivedAt)) return null;
  const headers: HeaderValues = {};
  const untrustedProxyHeaders: HeaderValues = {};
  let remaining = OPEN_TRACKING_REQUEST_LIMITS.totalHeaderChars as number;
  let inspected = 0;
  const inputHeaders = input.headers ?? {};
  for (const originalName in inputHeaders) {
    if (!Object.hasOwn(inputHeaders, originalName)) continue;
    inspected += 1;
    if (inspected > 64 || remaining === 0) break;
    const name = originalName.toLowerCase();
    if (!Object.hasOwn(HEADERS, name) && !Object.hasOwn(PROXY_HEADERS, name)) continue;
    const value = inputHeaders[originalName];
    const target = Object.hasOwn(PROXY_HEADERS, name) ? untrustedProxyHeaders : headers;
    if (Object.hasOwn(target, name)) continue;
    if (typeof value === "string") {
      const bounded = value.slice(0, Math.min(remaining, OPEN_TRACKING_REQUEST_LIMITS.headerValueChars));
      target[name] = bounded;
      remaining -= bounded.length;
    } else if (Array.isArray(value)) {
      const bounded: string[] = [];
      for (const item of value.slice(0, OPEN_TRACKING_REQUEST_LIMITS.headerArrayLength)) {
        if (typeof item !== "string" || remaining === 0) continue;
        const part = item.slice(0, Math.min(remaining, OPEN_TRACKING_REQUEST_LIMITS.headerArrayValueChars));
        bounded.push(part);
        remaining -= part.length;
      }
      if (bounded.length) target[name] = bounded;
    }
  }
  const query: Record<string, string> = {};
  for (const key of ["v", "cb"]) {
    const value = input.query?.[key];
    if (typeof value === "string" && /^\d{1,20}$/.test(value)) query[key] = value;
  }
  const edge = input.edgeObserved;
  let edgeObserved: OpenTrackingEdgeObservation | undefined;
  if (edge?.source === "cloudflare_worker" &&
      /^dt\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(edge.hostname) &&
      edge.hostname.length <= 253 && typeof edge.receivedAt === "string" &&
      edge.receivedAt.length <= 40 && TIMESTAMP_PATTERN.test(edge.receivedAt) &&
      isValid(parseISO(edge.receivedAt))) {
    edgeObserved = {
      source: "cloudflare_worker", hostname: edge.hostname,
      receivedAt: parseISO(edge.receivedAt).toISOString(),
      ...(typeof edge.remoteAddress === "string" && isIP(edge.remoteAddress) ? { remoteAddress: edge.remoteAddress } : {}),
      ...(typeof edge.httpVersion === "string" && /^HTTP\/(?:1\.[01]|2|3)$/.test(edge.httpVersion) ? { httpVersion: edge.httpVersion } : {}),
      ...(typeof edge.asOrganization === "string" ? { asOrganization: edge.asOrganization.slice(0, 256) } : {}),
      ...(typeof edge.asn === "number" && Number.isSafeInteger(edge.asn) && edge.asn >= 0 && edge.asn <= 4_294_967_295
        ? { asn: edge.asn } : {}),
      ...(typeof edge.country === "string" && /^[A-Z]{2}$/.test(edge.country) ? { country: edge.country } : {}),
      ...(edge.network && typeof edge.network.id === "string" &&
        PUBLISHED_NETWORKS.some((network) => network.id === edge.network?.id) &&
        typeof edge.network.version === "string" && /^[a-z0-9_.:-]{1,128}$/i.test(edge.network.version)
        ? { network: { id: edge.network.id, version: edge.network.version } } : {}),
      ...(edge.networkSetVersion === null || (typeof edge.networkSetVersion === "string" &&
        /^[a-z0-9_.:-]{1,128}$/i.test(edge.networkSetVersion))
        ? { networkSetVersion: edge.networkSetVersion } : {}),
      ...(typeof edge.tlsVersion === "string" && /^TLSv1\.[23]$/.test(edge.tlsVersion) ? { tlsVersion: edge.tlsVersion } : {}),
    };
  }
  return {
    receivedAt: receivedAt.toISOString(), method: input.method,
    // Never retain a literal URL, token, arbitrary query or caller-supplied path.
    path: OPEN_TRACKING_PIXEL_PATH, query, headers, untrustedProxyHeaders,
    ...(typeof input.remoteAddress === "string" && input.remoteAddress.length <= 64 && isIP(input.remoteAddress)
      ? { remoteAddress: input.remoteAddress } : {}),
    ...(typeof input.httpVersion === "string" && /^\d(?:\.\d)?$/.test(input.httpVersion)
      ? { httpVersion: input.httpVersion } : {}),
    encrypted: input.encrypted === true,
    ...(edgeObserved ? { edgeObserved } : {}),
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function secretKey(): string {
  const key = config().secretKey;
  // The existing helpers can log malformed configuration. Fail before calling
  // them so no missing/malformed secret is ever attached to an error or log.
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 32) throw new OpenTrackingError();
  return key;
}

function addPixel(html: string, url: string): string {
  const untracked = html.replace(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, (image) =>
    /\bdata-df-open-tracking\s*=\s*(?:"owned_pixel"|'owned_pixel')/i.test(image) ? "" : image,
  );
  const pixel = `<img data-df-open-tracking="owned_pixel" src="${escapeHtml(url)}" width="1" height="1" alt="" aria-hidden="true" style="display:block;width:1px;height:1px;border:0;" />`;
  return /<\/body\s*>/i.test(untracked)
    ? untracked.replace(/<\/body\s*>/i, `${pixel}</body>`)
    : `${untracked}${pixel}`;
}

/** Issue once before inserting the canonical send. Its transaction owns the
 * erasure barrier and persists these fields with the encrypted transport body. */
export async function prepareEmailOpenTracking(input: {
  sendId: string; workspaceId: string; html: string;
}, executor: Pick<Db, "select"> = db()): Promise<{
  html: string; openTrackingTokenHash: string;
  encryptedOpenTrackingToken: NewsletterCiphertext; openTrackingOrigin: string;
}> {
  try {
    if (!config().enableOpenTracking || !UUID_PATTERN.test(input.workspaceId) ||
        !UUID_PATTERN.test(input.sendId)) throw new OpenTrackingError();
    const key = secretKey();
    const origin = await getNewsletterTrackingOrigin(input.workspaceId, executor);
    if (!origin) throw new OpenTrackingError();
    const token = randomBytes(32).toString("base64url");
    return {
      html: addPixel(input.html, `${origin}${OPEN_TRACKING_PIXEL_PATH.replace(":token", token)}`),
      openTrackingTokenHash: tokenHash(token),
      encryptedOpenTrackingToken: encrypt(JSON.stringify({ id: input.sendId.toLowerCase(), token }), key),
      openTrackingOrigin: origin,
    };
  } catch {
    // Database/client failures may contain bind values; never expose causes.
    throw new OpenTrackingError();
  }
}

export interface CaptureEmailOpenRequestInput {
  token: string;
  request: OpenTrackingRequestInput;
  expectedHostname: string;
  expectedWorkspaceId: string;
  eventId: string;
}

/** Queue retries are the only recovery mechanism. Never acknowledge partial
 * classification/native projection success, and never create a PG hit row. */
export async function captureEmailOpenRequests(inputs: readonly CaptureEmailOpenRequestInput[]): Promise<void> {
  try {
    if (!config().enableOpenTracking || !inputs.length) return;
    const key = secretKey();
    const groups = new Map<string, { input: CaptureEmailOpenRequestInput; request: OpenTrackingRequest; hash: string }[]>();
    const now = Date.now();
    for (const input of inputs) {
      if (!TOKEN_PATTERN.test(input.token) || !UUID_PATTERN.test(input.eventId) ||
          !UUID_PATTERN.test(input.expectedWorkspaceId) || !input.expectedHostname) continue;
      const request = sanitizeOpenTrackingRequest(input.request);
      if (!request || Date.parse(request.receivedAt) > now + 300_000 ||
          (request.edgeObserved && request.edgeObserved.hostname !== input.expectedHostname)) continue;
      if (request.edgeObserved && request.edgeObserved.networkSetVersion === undefined) {
        request.edgeObserved.networkSetVersion = request.edgeObserved.network?.version ?? null;
      }
      const envelope = JSON.stringify({ id: input.eventId, sendId: input.expectedWorkspaceId, request });
      if (Buffer.byteLength(envelope, "utf8") > OPEN_TRACKING_REQUEST_LIMITS.envelopeBytes) throw new OpenTrackingError();
      const workspaceId = input.expectedWorkspaceId.toLowerCase();
      const group = groups.get(workspaceId) ?? [];
      group.push({ input, request, hash: tokenHash(input.token) });
      groups.set(workspaceId, group);
    }
    for (const [workspaceId, group] of groups) {
      // Exclusive serialization makes actor history and erasure agree across
      // concurrently consumed batches. No row locks or per-hit PG writes.
      await db().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
        const mappings = await tx.select().from(newsletterSend).where(and(
          eq(newsletterSend.workspaceId, workspaceId), isNull(newsletterSend.erasedAt),
          inArray(newsletterSend.openTrackingTokenHash, [...new Set(group.map((item) => item.hash))]),
        ));
        if (!mappings.length) return;
        const barriers = await tx.select({ hash: newsletterErasure.userHash }).from(newsletterErasure).where(and(
          eq(newsletterErasure.workspaceId, workspaceId),
          inArray(newsletterErasure.userHash, [...new Set(mappings.map((mapping) => newsletterContactHash(workspaceId, mapping.userId)))]),
        ));
        const erased = new Set(barriers.map((row) => row.hash));
        const byHash = new Map(mappings.map((mapping) => [mapping.openTrackingTokenHash, mapping]));
        const observations = new Map<string, EmailOpenObservation>();
        for (const { input, request, hash } of group) {
          const mapping = byHash.get(hash);
          if (!mapping || !mapping.openTrackingOrigin || !mapping.encryptedOpenTrackingToken ||
              erased.has(newsletterContactHash(workspaceId, mapping.userId)) ||
              new URL(mapping.openTrackingOrigin).hostname !== input.expectedHostname) continue;
          const plaintext = decrypt({ ...mapping.encryptedOpenTrackingToken, secretKey: key });
          if (!plaintext) throw new OpenTrackingError();
          const tokenEnvelope = JSON.parse(plaintext) as { id?: unknown; token?: unknown };
          if (tokenEnvelope.id !== mapping.id || tokenEnvelope.token !== input.token) throw new OpenTrackingError();
          const eventId = input.eventId.toLowerCase();
          const requestHash = emailOpenRequestHash(mapping.id, request);
          const existing = observations.get(eventId);
          if (existing && existing.requestHash !== requestHash) throw new OpenTrackingError();
          if (!existing) observations.set(eventId, { eventId, mapping, request, requestHash });
        }
        if (!observations.size) return;
        const stored = await findExistingEmailOpenTrackingEvents(workspaceId, [...observations.keys()]);
        const existing = new Map(stored.map((event) => [event.eventId, event]));
        for (const event of stored) {
          const observation = observations.get(event.eventId);
          if (!observation || event.requestHash !== observation.requestHash ||
              event.messageId !== observation.mapping.logicalMessageId ||
              event.userId !== observation.mapping.userId) throw new OpenTrackingError();
        }
        const events = await buildEmailOpenTrackingEvents(tx, workspaceId,
          [...observations.values()].filter((observation) => !existing.has(observation.eventId)), key);
        await insertEmailOpenTrackingEvents(events);
        const allEvents = [...stored, ...events];
        const opens = allEvents.filter((event) => event.method === "GET");
        const projected = await findProjectedEmailOpenEventIds(workspaceId, opens.map((event) => event.eventId));
        const pending = opens.filter((event) => !projected.has(event.eventId));
        if (pending.length) await submitBatch({ workspaceId, data: {
          context: { source: SourceType.Webhook },
          batch: pending.map((event) => ({
            type: EventType.Track, event: InternalEventType.EmailOpened,
            userId: event.userId, messageId: event.eventId,
            timestamp: new Date(event.occurredAt).toISOString(),
            properties: {
              workspaceId, userId: event.userId, messageId: event.messageId,
              evidenceId: event.eventId, evidenceSource: "owned_pixel",
              engagementClassification: "observed_unqualified",
              openedAt: new Date(event.occurredAt).toISOString(),
            },
          })),
        } }, { writeModeOverride: "ch-sync", workspaceLockHeld: true });
      });
    }
  } catch {
    throw new OpenTrackingError();
  }
}

export async function deleteEmailOpenData({ workspaceId, userIds }: {
  workspaceId: string; userIds?: string[];
}): Promise<void> {
  if (userIds && !userIds.length) return;
  try {
    await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
      const [registered] = await tx.select({ id: newsletter.workspaceId }).from(newsletter)
        .where(eq(newsletter.workspaceId, workspaceId)).limit(1);
      if (registered) {
        if (userIds) {
          const ids = [...new Set(userIds)];
          for (let offset = 0; offset < ids.length; offset += 500) {
            await tx.insert(newsletterErasure).values(ids.slice(offset, offset + 500).map((id) => ({
              workspaceId, userHash: newsletterContactHash(workspaceId, id),
            }))).onConflictDoNothing();
          }
        } else {
          // Known contacts without sends must also bar stale queued send work.
          // Native event contacts and PG assignments cover the existing registry.
          let after = "";
          for (;;) {
            const result = await clickhouseClient().query({
              query: `SELECT DISTINCT user_id AS userId FROM user_events_v2
                WHERE workspace_id = {workspaceId:String} AND user_id > {after:String}
                ORDER BY userId LIMIT 500`,
              query_params: { workspaceId, after }, format: "JSONEachRow",
            });
            const rows = await result.json<{ userId: string }>();
            if (!rows.length) break;
            await tx.insert(newsletterErasure).values(rows.map((row) => ({
              workspaceId, userHash: newsletterContactHash(workspaceId, row.userId),
            }))).onConflictDoNothing();
            if (rows.length < 500) break;
            after = rows[rows.length - 1]!.userId;
          }
          let afterUser = "";
          for (;;) {
            const rows = await tx.execute<{ userId: string }>(sql`
              select distinct "userId" from (
                select "userId" from "NewsletterSend" where "workspaceId" = ${workspaceId}
                union select "userId" from "UserPropertyAssignment" where "workspaceId" = ${workspaceId}
                union select "userId" from "SegmentAssignment" where "workspaceId" = ${workspaceId}
                union select "userId" from "PublicationAutomationIdentity" where "newsletterId" = ${workspaceId}
              ) contacts where "userId" > ${afterUser} order by "userId" limit 500`);
            if (!rows.rows.length) break;
            await tx.insert(newsletterErasure).values(rows.rows.map((row) => ({
              workspaceId, userHash: newsletterContactHash(workspaceId, row.userId),
            }))).onConflictDoNothing();
            if (rows.rows.length < 500) break;
            afterUser = rows.rows[rows.rows.length - 1]!.userId;
          }
        }
        for (let offset = 0; offset < (userIds?.length ?? 1); offset += 500) {
          const scopeIds = userIds?.slice(offset, offset + 500);
          await tx.update(newsletterSend).set({
            openTrackingTokenHash: null, encryptedOpenTrackingToken: null, openTrackingOrigin: null,
          }).where(and(eq(newsletterSend.workspaceId, workspaceId),
            scopeIds ? inArray(newsletterSend.userId, scopeIds) : undefined));
        }
      }
      // Synchronous CH mutations finish while the same exclusive lock is held.
      for (let offset = 0; offset < (userIds?.length ?? 1); offset += 500) {
        await deleteEmailOpenTrackingEvents(workspaceId, userIds?.slice(offset, offset + 500));
      }
    });
  } catch {
    throw new OpenTrackingError();
  }
}

export async function getEmailOpenEvidence({ workspaceId, userId, messageId, evidenceId }: {
  workspaceId: string; userId: string; messageId: string; evidenceId: string;
}): Promise<Record<string, unknown> | null> {
  if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(evidenceId)) return null;
  try {
    return await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${workspaceId}, 0))`);
      const [mapping] = await tx.select({ id: newsletterSend.id }).from(newsletterSend).where(and(
        eq(newsletterSend.workspaceId, workspaceId), eq(newsletterSend.userId, userId),
        eq(newsletterSend.logicalMessageId, messageId), isNull(newsletterSend.erasedAt),
      )).limit(1);
      if (!mapping) return null;
      const [barrier] = await tx.select({ hash: newsletterErasure.userHash }).from(newsletterErasure).where(and(
        eq(newsletterErasure.workspaceId, workspaceId),
        eq(newsletterErasure.userHash, newsletterContactHash(workspaceId, userId)),
      )).limit(1);
      if (barrier) return null;
      const [event] = await findEmailOpenTrackingEvents({ workspaceId, userId, messageId, evidenceId, limit: 1 });
      if (!event?.encryptedRequest || Date.parse(event.rawExpiresAt) <= Date.now()) return null;
      return {
        evidenceId: event.eventId, evidenceSource: "owned_pixel", classification: "observed_unqualified",
        receivedAt: new Date(event.occurredAt).toISOString(), isOpenObservation: event.method === "GET",
        request: readEmailOpenRequest(event, mapping.id, secretKey()),
      };
    });
  } catch {
    throw new OpenTrackingError();
  }
}

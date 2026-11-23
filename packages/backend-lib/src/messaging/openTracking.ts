import { createHash, randomBytes, randomUUID } from "crypto";
import { isValid, parseISO } from "date-fns";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import escapeHtml from "escape-html";
import { SourceType } from "isomorphic-lib/src/constants";
import { isIP } from "net";

import { submitBatch } from "../apps/batch";
import config from "../config";
import { db } from "../db";
import {
  emailOpenTrackingReceipt as receipt,
  emailOpenTrackingSend as send,
  emailOpenTrackingTombstone as tombstone,
} from "../db/schema";
import { getNewsletterTrackingOrigin } from "../newsletterTracking";
import { decrypt, encrypt } from "../secrets";
import { EventType, InternalEventType } from "../types";

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

function identityHash(workspaceId: string, kind: string, identity: string): string {
  return createHash("sha256").update(JSON.stringify(["owned_email_open", workspaceId, kind, identity])).digest("hex");
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

export async function prepareEmailOpenTracking(input: {
  workspaceId: string; userId: string; messageId: string; html: string;
}): Promise<string> {
  try {
    const settings = config();
    if (!settings.enableOpenTracking) return input.html;
    if (!UUID_PATTERN.test(input.workspaceId) ||
        !input.userId || !input.messageId) throw new OpenTrackingError();
    const key = secretKey();
    const mapping = await db().transaction(async (tx) => {
      // Every operation takes the workspace barrier BEFORE touching row locks.
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${input.workspaceId}, 0))`);
      const [deleted] = await tx.select({ hash: tombstone.identityHash }).from(tombstone).where(and(
        eq(tombstone.workspaceId, input.workspaceId), or(
          and(eq(tombstone.kind, "contact"), eq(tombstone.identityHash, identityHash(input.workspaceId, "contact", input.userId))),
          and(eq(tombstone.kind, "send"), eq(tombstone.identityHash, identityHash(input.workspaceId, "send", input.messageId))),
        ),
      )).limit(1);
      if (deleted) throw new OpenTrackingError();
      const [existing] = await tx.select().from(send).where(and(
        eq(send.workspaceId, input.workspaceId), eq(send.messageId, input.messageId),
      )).limit(1);
      if (existing) {
        if (existing.userId !== input.userId) throw new OpenTrackingError();
        return existing;
      }
      const baseUrl = await getNewsletterTrackingOrigin(input.workspaceId, tx) ?? settings.openTrackingBaseUrl;
      if (!baseUrl) throw new OpenTrackingError();
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      await tx.insert(send).values({
        id, workspaceId: input.workspaceId, userId: input.userId, messageId: input.messageId,
        tokenHash: tokenHash(token), encryptedToken: encrypt(JSON.stringify({ id, token }), key),
        baseUrl,
      }).onConflictDoNothing({ target: [send.workspaceId, send.messageId] });
      const [created] = await tx.select().from(send).where(and(
        eq(send.workspaceId, input.workspaceId), eq(send.messageId, input.messageId),
      )).limit(1);
      if (!created || created.userId !== input.userId) throw new OpenTrackingError();
      return created;
    });
    const plaintext = decrypt({ ...mapping.encryptedToken, secretKey: key });
    if (!plaintext) throw new OpenTrackingError();
    const decoded = JSON.parse(plaintext) as { id?: unknown; token?: unknown };
    if (decoded.id !== mapping.id || typeof decoded.token !== "string" ||
        !TOKEN_PATTERN.test(decoded.token) || tokenHash(decoded.token) !== mapping.tokenHash) throw new OpenTrackingError();
    // Persisting the original origin also makes a changed deployment setting
    // incapable of silently changing the pixel URL on an accepted-send retry.
    return addPixel(input.html, `${mapping.baseUrl}${OPEN_TRACKING_PIXEL_PATH.replace(":token", decoded.token)}`);
  } catch {
    // SQL/client failures may include bind values. Never propagate their causes.
    throw new OpenTrackingError();
  }
}

export async function captureEmailOpenRequest({ token, request, expectedHostname, expectedWorkspaceId }: {
  token: string; request: OpenTrackingRequestInput;
  expectedHostname?: string; expectedWorkspaceId?: string;
}): Promise<void> {
  try {
    if (!TOKEN_PATTERN.test(token) || !config().enableOpenTracking) return;
    const sanitized = sanitizeOpenTrackingRequest(request);
    if (!sanitized) return;
    const hash = tokenHash(token);
    // The preliminary read acquires no row locks. Recheck after the barrier to
    // close capture-vs-erasure races without reversing the projection lock order.
    const [candidate] = await db().select({ workspaceId: send.workspaceId }).from(send).where(eq(send.tokenHash, hash)).limit(1);
    if (!candidate) return;
    await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${candidate.workspaceId}, 0))`);
      const [mapping] = await tx.select({ id: send.id, baseUrl: send.baseUrl }).from(send).where(and(
        eq(send.workspaceId, candidate.workspaceId), eq(send.tokenHash, hash),
      )).limit(1);
      if (!mapping) return;
      if ((expectedWorkspaceId !== undefined && expectedWorkspaceId !== candidate.workspaceId) ||
          (expectedHostname !== undefined && new URL(mapping.baseUrl).hostname !== expectedHostname)) return;
      const id = randomUUID();
      const plaintext = JSON.stringify({ id, sendId: mapping.id, request: sanitized });
      if (Buffer.byteLength(plaintext, "utf8") > OPEN_TRACKING_REQUEST_LIMITS.envelopeBytes) throw new OpenTrackingError();
      await tx.insert(receipt).values({
        id, sendId: mapping.id, encryptedRequest: encrypt(plaintext, secretKey()),
        receivedAt: new Date(sanitized.receivedAt), method: sanitized.method,
        disposition: sanitized.method === "GET" ? "pending" : "raw_only_head",
      });
    });
  } catch {
    throw new OpenTrackingError();
  }
}

export async function drainEmailOpenEvents(): Promise<void> {
  try {
    const deadline = Date.now() + 45_000;
    const retentionDays = config().openTrackingRetentionDays;
    // Cleanup does not acquire workspace barriers or later touch send rows;
    // SKIP LOCKED keeps it from waiting behind an in-flight native projection.
    await db().execute(sql`delete from "EmailOpenTrackingReceipt" where "id" in (
      select "id" from "EmailOpenTrackingReceipt"
      where "receivedAt" < now() - (${retentionDays} * interval '1 day')
      order by "receivedAt", "id" limit 1000 for update skip locked
    )`);
    // Read a bounded candidate set without row locks; concurrent drains can skip
    // another worker's receipt and still make progress on the other candidates.
    const candidates = await db().select({ id: receipt.id, workspaceId: send.workspaceId }).from(receipt)
      .innerJoin(send, eq(send.id, receipt.sendId)).where(and(
        eq(receipt.disposition, "pending"), eq(receipt.method, "GET"),
        sql`${receipt.nextAttemptAt} <= now()`,
        sql`${receipt.receivedAt} >= now() - (${retentionDays} * interval '1 day')`,
      )).orderBy(receipt.nextAttemptAt, receipt.id).limit(50);
    for (const candidate of candidates) {
      if (Date.now() >= deadline) break;
      // No receipt row lock until AFTER the shared workspace lock. Deletion
      // takes the exclusive workspace lock first, so neither can deadlock.
      await db().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${candidate.workspaceId}, 0))`);
        const [row] = await tx.select({ receipt, send }).from(receipt).innerJoin(send, eq(send.id, receipt.sendId)).where(and(
          eq(receipt.id, candidate.id), eq(send.workspaceId, candidate.workspaceId),
          eq(receipt.disposition, "pending"), eq(receipt.method, "GET"),
          sql`${receipt.nextAttemptAt} <= now()`,
          sql`${receipt.receivedAt} >= now() - (${retentionDays} * interval '1 day')`,
        )).limit(1).for("update", { of: receipt, skipLocked: true });
        if (!row) return;
        try {
          // Keep the shared barrier through ClickHouse completion. Erasure can
          // then delete native history only AFTER every older projection ends.
          // PG and native storage are not atomic: crash recovery is at-least-once.
          const timestamp = row.receipt.receivedAt.toISOString();
          await submitBatch({ workspaceId: row.send.workspaceId, data: {
            context: { source: SourceType.Webhook },
            batch: [{
              type: EventType.Track, event: InternalEventType.EmailOpened,
              userId: row.send.userId, messageId: row.receipt.id, timestamp,
              properties: {
                workspaceId: row.send.workspaceId, userId: row.send.userId,
                messageId: row.send.messageId, evidenceId: row.receipt.id,
                evidenceSource: "owned_pixel", engagementClassification: "observed_unqualified",
                openedAt: timestamp,
              },
            }],
          } }, { writeModeOverride: "ch-sync", workspaceLockHeld: true });
          await tx.update(receipt).set({
            disposition: "projected", processedAt: sql`now()`, attempts: row.receipt.attempts + 1,
          }).where(eq(receipt.id, row.receipt.id));
        } catch {
          // No downstream exceptions or encrypted/raw evidence go into logs.
          await tx.update(receipt).set({
            attempts: row.receipt.attempts + 1,
            nextAttemptAt: sql`now() + (${Math.min(3_600_000, 30_000 * 2 ** Math.min(row.receipt.attempts, 7))} * interval '1 millisecond')`,
          }).where(eq(receipt.id, row.receipt.id));
        }
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
      // Explicit contact deletion also bars a stale sender that has not yet
      // prepared its first pixel. Hashes are intentionally retained indefinitely.
      // Bound both SQL parameter counts and loaded correlations on bulk erasure.
      for (let offset = 0; offset < (userIds?.length ?? 1); offset += 500) {
        const scopeIds = userIds?.slice(offset, offset + 500);
        if (scopeIds) {
          await tx.insert(tombstone).values(scopeIds.map((id) => ({
            workspaceId, kind: "contact", identityHash: identityHash(workspaceId, "contact", id),
          }))).onConflictDoNothing();
        }
        // Whole-workspace erasure covers every known owned-pixel correlation,
        // without permanently disabling tracking for future, new contact IDs.
        for (;;) {
          const rows = await tx.select({ id: send.id, userId: send.userId, messageId: send.messageId }).from(send).where(and(
            eq(send.workspaceId, workspaceId), scopeIds ? inArray(send.userId, scopeIds) : undefined,
          )).limit(500).for("update");
          if (!rows.length) break;
          await tx.insert(tombstone).values(rows.flatMap((row) => [
            { workspaceId, kind: "contact", identityHash: identityHash(workspaceId, "contact", row.userId) },
            { workspaceId, kind: "send", identityHash: identityHash(workspaceId, "send", row.messageId) },
          ])).onConflictDoNothing();
          // The FK cascades encrypted receipts and pending outbox entries atomically.
          await tx.delete(send).where(inArray(send.id, rows.map((row) => row.id)));
        }
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
      const [row] = await tx.select({ receipt }).from(receipt).innerJoin(send, eq(send.id, receipt.sendId)).where(and(
        eq(send.workspaceId, workspaceId), eq(send.userId, userId), eq(send.messageId, messageId),
        eq(receipt.id, evidenceId),
        sql`${receipt.receivedAt} >= now() - (${config().openTrackingRetentionDays} * interval '1 day')`,
      )).limit(1);
      if (!row) return null;
      const plaintext = decrypt({ ...row.receipt.encryptedRequest, secretKey: secretKey() });
      if (!plaintext) throw new OpenTrackingError();
      const envelope = JSON.parse(plaintext) as { id?: unknown; sendId?: unknown; request?: OpenTrackingRequest };
      if (envelope.id !== row.receipt.id || envelope.sendId !== row.receipt.sendId ||
          !envelope.request || envelope.request.method !== row.receipt.method ||
          envelope.request.receivedAt !== row.receipt.receivedAt.toISOString()) throw new OpenTrackingError();
      return {
        evidenceId: row.receipt.id, evidenceSource: "owned_pixel",
        classification: "observed_unqualified", receivedAt: row.receipt.receivedAt.toISOString(),
        isOpenObservation: row.receipt.method === "GET", request: envelope.request,
      };
    });
  } catch {
    throw new OpenTrackingError();
  }
}

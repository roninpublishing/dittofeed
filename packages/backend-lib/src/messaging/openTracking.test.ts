import { createHash, randomBytes, randomUUID } from "crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { EventEmitter, once } from "events";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

import * as batch from "../apps/batch";
import config, { Config } from "../config";
import { db } from "../db";
import {
  emailOpenTrackingReceipt as receipt,
  emailOpenTrackingSend as send,
  emailOpenTrackingTombstone as tombstone,
  workspace,
} from "../db/schema";
import { decrypt } from "../secrets";
import { InternalEventType } from "../types";
import { findUserEvents } from "../userEvents";
import { createWorkspace } from "../workspaces";
import * as trackingDomains from "../newsletterTracking";
import {
  captureEmailOpenRequest, deleteEmailOpenData, drainEmailOpenEvents,
  getEmailOpenEvidence, OPEN_TRACKING_PIXEL_PATH, OPEN_TRACKING_REQUEST_LIMITS,
  OpenTrackingError, OpenTrackingRequestInput, prepareEmailOpenTracking,
  sanitizeOpenTrackingRequest,
} from "./openTracking";

describe("owned email open evidence", () => {
  let workspaceId: string;
  let otherWorkspaceId: string;
  let input: Parameters<typeof prepareEmailOpenTracking>[0];
  let request: OpenTrackingRequestInput;
  let originalSettings: Pick<Config,
    "enableOpenTracking" | "openTrackingBaseUrl" | "openTrackingRetentionDays" | "secretKey" | "writeMode">;

  beforeEach(async () => {
    const settings = config();
    originalSettings = {
      enableOpenTracking: settings.enableOpenTracking,
      openTrackingBaseUrl: settings.openTrackingBaseUrl,
      openTrackingRetentionDays: settings.openTrackingRetentionDays,
      secretKey: settings.secretKey, writeMode: settings.writeMode,
    };
    Object.assign(settings, {
      enableOpenTracking: true, openTrackingBaseUrl: "https://pixels.example.com",
      openTrackingRetentionDays: 30,
    });
    workspaceId = (await createWorkspace({ name: randomUUID() }).then(unwrap)).id;
    otherWorkspaceId = (await createWorkspace({ name: randomUUID() }).then(unwrap)).id;
    input = {
      workspaceId, userId: randomUUID(), messageId: randomUUID(),
      html: '<html><body><p>Original</p><img src="https://example.com/logo.png"></body></html>',
    };
    request = {
      receivedAt: new Date(Date.now() - 60_000).toISOString(), method: "GET",
      path: "/never-persist/a-secret-token.gif?password=secret",
      query: { cb: "123456", v: "2", password: "query-secret", email: "private@example.com" },
      headers: {
        "User-Agent": "privacy-proxy-observation", accept: "image/avif,image/*",
        authorization: "Bearer authorization-secret", cookie: "session=cookie-secret",
        "set-cookie": "response-secret", referer: "https://example.com/private?secret=referer-secret",
        "x-forwarded-for": "203.0.113.77", "cf-ipcountry": "CA", via: "proxy.example.com",
      },
      remoteAddress: "192.0.2.11", httpVersion: "1.1", encrypted: true,
    };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    Object.assign(config(), originalSettings);
    await db().delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspaceId]));
  });

  async function prepare(overrides: Partial<typeof input> = {}) {
    const html = await prepareEmailOpenTracking({ ...input, ...overrides });
    const matched = html.match(/src="(https?:\/\/[^\"]+\/api\/public\/email\/open\/([A-Za-z0-9_-]{43})\.gif)"/);
    if (!matched?.[1] || !matched[2]) throw new Error("Expected an owned pixel in prepared HTML");
    return { html, url: matched[1], token: matched[2] };
  }

  async function receipts(scope = workspaceId) {
    return db().select({ receipt }).from(receipt).innerJoin(send, eq(send.id, receipt.sendId))
      .where(eq(send.workspaceId, scope)).then((rows) => rows.map((row) => row.receipt));
  }

  async function evidence(evidenceId: string, overrides: Partial<Parameters<typeof getEmailOpenEvidence>[0]> = {}) {
    return getEmailOpenEvidence({ workspaceId, userId: input.userId, messageId: input.messageId, evidenceId, ...overrides });
  }
  it("keeps the original branded origin on retries and never falls back for an unverified newsletter", async () => {
    const origin = jest.spyOn(trackingDomains, "getNewsletterTrackingOrigin").mockResolvedValue("https://dt.first.example");
    const first = await prepare();
    origin.mockRejectedValue(new Error("Newsletter domain pending"));
    expect((await prepare()).url).toBe(first.url);
    expect(first.url).toContain("https://dt.first.example/");
    await expect(prepare({ messageId: randomUUID() })).rejects.toBeInstanceOf(OpenTrackingError);
  });

  // Observe actual database lock queues, never timing sleeps. Hash halves are
  // PostgreSQL's documented pg_locks representation of bigint advisory keys.
  async function waitForLock(mode: "ShareLock" | "ExclusiveLock") {
    for (let i = 0; i < 200; i += 1) {
      const result = await db().execute<{ waiting: number }>(sql`select count(*)::integer as waiting from pg_locks
        where locktype = 'advisory' and not granted and mode = ${mode}
        and classid = ((hashtextextended(${workspaceId}, 0) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${workspaceId}, 0) & 4294967295)::oid`);
      if ((result.rows[0]?.waiting ?? 0) > 0) return;
    }
    throw new Error("Expected the erasure serialization lock to be queued");
  }

  it("creates one opaque encrypted mapping before send and converges simultaneous logical retries", async () => {
    const prepared = await Promise.all(Array.from({ length: 6 }, () => prepare()));
    expect(new Set(prepared.map((value) => value.url)).size).toBe(1);
    const [first] = prepared;
    if (!first) throw new Error("Missing prepared pixel");
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expect(first.url).not.toContain(input.userId);
    expect(first.url).not.toContain(workspaceId);
    expect(first.url).not.toContain(input.messageId);
    const rows = await db().select().from(send).where(eq(send.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(createHash("sha256").update(first.token).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(first.token);
    const tokenEnvelope = JSON.parse(decrypt(rows[0]!.encryptedToken)!);
    expect(tokenEnvelope).toEqual({ id: rows[0]?.id, token: first.token });
    config().openTrackingBaseUrl = "https://changed.example.com";
    const retried = await prepare({ html: first.html });
    expect(retried.url).toBe(first.url);
    expect(retried.html.match(/data-df-open-tracking=/g)).toHaveLength(1);
    expect(retried.html).toContain('<img src="https://example.com/logo.png">');
    expect(retried.html.indexOf('data-df-open-tracking=')).toBeLessThan(retried.html.indexOf("</body>"));
    expect(input.html).not.toContain("owned_pixel");
  });

  it("fails closed on a different recipient reusing a logical send identity", async () => {
    await prepare();
    await expect(prepare({ userId: "another-contact@example.com" })).rejects.toBeInstanceOf(OpenTrackingError);
    expect(await db().select().from(send).where(eq(send.workspaceId, workspaceId))).toHaveLength(1);
  });

  it("uses independent opaque pixels for other sends and tenants, including identical caller IDs", async () => {
    const first = await prepare();
    const second = await prepare({ messageId: randomUUID() });
    const other = await prepare({ workspaceId: otherWorkspaceId });
    expect(new Set([first.token, second.token, other.token]).size).toBe(3);
    expect(await db().select().from(send).where(eq(send.workspaceId, workspaceId))).toHaveLength(2);
  });

  it("is disabled by default at the module boundary and never creates state for disabled sends or requests", async () => {
    const first = await prepare();
    config().enableOpenTracking = false;
    expect(await prepareEmailOpenTracking(input)).toBe(input.html);
    await captureEmailOpenRequest({ token: first.token, request });
    expect(await receipts()).toHaveLength(0);
  });

  it("bounds and allowlists evidence without retaining URL secrets or trusting proxy hints", async () => {
    const sanitized = sanitizeOpenTrackingRequest(request);
    expect(sanitized).toMatchObject({
      receivedAt: request.receivedAt, method: "GET", path: OPEN_TRACKING_PIXEL_PATH,
      query: { cb: "123456", v: "2" },
      headers: { "user-agent": "privacy-proxy-observation", accept: "image/avif,image/*" },
      untrustedProxyHeaders: { "x-forwarded-for": "203.0.113.77", "cf-ipcountry": "CA", via: "proxy.example.com" },
      remoteAddress: "192.0.2.11", httpVersion: "1.1", encrypted: true,
    });
    const serialized = JSON.stringify(sanitized);
    for (const secret of ["query-secret", "private@example.com", "authorization-secret", "cookie-secret", "referer-secret", "a-secret-token"]) {
      expect(serialized).not.toContain(secret);
    }
    const oversized = sanitizeOpenTrackingRequest({ ...request,
      headers: {
        "user-agent": "🕵".repeat(20_000), accept: Array(50).fill("x".repeat(5_000)),
        forwarded: "f".repeat(20_000), "x-real-ip": "a".repeat(20_000),
        via: "b".repeat(20_000), "cf-connecting-ip": "c".repeat(20_000),
        "cf-ipcountry": "d".repeat(20_000), "sec-ch-ua": "e".repeat(20_000),
      },
      query: { cb: "9".repeat(21), v: "numeric-but-secret-token", arbitrary: "secret" },
      remoteAddress: "invalid-address", httpVersion: "HTTP/1.1-secret",
    });
    expect(oversized?.headers["user-agent"]?.length).toBe(OPEN_TRACKING_REQUEST_LIMITS.headerValueChars);
    expect(oversized?.headers.accept).toEqual(Array(4).fill("x".repeat(128)));
    expect(oversized?.query).toEqual({});
    expect(oversized).not.toHaveProperty("remoteAddress");
    expect(oversized).not.toHaveProperty("httpVersion");
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(OPEN_TRACKING_REQUEST_LIMITS.envelopeBytes - 256);
  });

  it.each([
    { method: "POST" }, { receivedAt: "not-a-time" }, { receivedAt: "2026-02-31T12:00:00Z" },
    { receivedAt: "2026-01-01" },
  ])("rejects non-observations before any durable capture: %j", async (overrides) => {
    const pixel = await prepare();
    expect(sanitizeOpenTrackingRequest({ ...request, ...overrides })).toBeNull();
    await captureEmailOpenRequest({ token: pixel.token, request: { ...request, ...overrides } });
    expect(await receipts()).toHaveLength(0);
  });

  it("ignores unknown, malformed and deleted tokens without creating receipts", async () => {
    for (const token of ["", "cookie-secret", randomBytes(32).toString("base64url")]) {
      await captureEmailOpenRequest({ token, request });
    }
    expect(await receipts()).toHaveLength(0);
    const pixel = await prepare();
    await deleteEmailOpenData({ workspaceId, userIds: [input.userId] });
    await captureEmailOpenRequest({ token: pixel.token, request });
    expect(await receipts()).toHaveLength(0);
  });

  it("encrypts bounded GET evidence and scopes retrieval to workspace, contact, send and receipt", async () => {
    const pixel = await prepare();
    await captureEmailOpenRequest({ token: pixel.token, request });
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ disposition: "pending", method: "GET", attempts: 0 });
    for (const sensitive of [request.remoteAddress!, "privacy-proxy-observation", "203.0.113.77", pixel.token]) {
      expect(JSON.stringify(row)).not.toContain(sensitive);
    }
    expect(await evidence(row.id)).toEqual({
      evidenceId: row.id, evidenceSource: "owned_pixel", classification: "observed_unqualified",
      receivedAt: request.receivedAt, isOpenObservation: true,
      request: sanitizeOpenTrackingRequest(request),
    });
    for (const overrides of [
      { workspaceId: otherWorkspaceId }, { userId: randomUUID() },
      { messageId: randomUUID() }, { evidenceId: randomUUID() }, { evidenceId: "not-a-uuid" },
    ]) expect(await evidence(row.id, overrides)).toBeNull();
    expect(JSON.stringify(await evidence(row.id))).not.toContain(pixel.token);
  });

  it("retains HEAD as encrypted raw evidence but never emits an open", async () => {
    const pixel = await prepare();
    await captureEmailOpenRequest({ token: pixel.token, request: { ...request, method: "HEAD" } });
    const row = (await receipts())[0]!;
    expect(row.disposition).toBe("raw_only_head");
    const projection = jest.spyOn(batch, "submitBatch");
    await drainEmailOpenEvents();
    expect(projection).not.toHaveBeenCalled();
    expect(await findUserEvents({ workspaceId, messageId: row.id })).toHaveLength(0);
    expect(await evidence(row.id)).toMatchObject({ isOpenObservation: false, request: { method: "HEAD" } });
  });

  it("projects GET synchronously through native ingestion with stable occurrence identity and no raw PII", async () => {
    const pixel = await prepare();
    await captureEmailOpenRequest({ token: pixel.token, request });
    const row = (await receipts())[0]!;
    // Async deployment settings must not weaken the erasure boundary.
    config().writeMode = "ch-async";
    const projection = jest.spyOn(batch, "submitBatch");
    await Promise.all([drainEmailOpenEvents(), drainEmailOpenEvents()]);
    expect(projection).toHaveBeenCalledTimes(1);
    const events = await findUserEvents({ workspaceId, messageId: row.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ user_id: input.userId, event: InternalEventType.EmailOpened });
    expect(JSON.parse(events[0]?.properties ?? "{}")).toEqual({
      workspaceId, userId: input.userId, messageId: input.messageId,
      evidenceId: row.id, evidenceSource: "owned_pixel", engagementClassification: "observed_unqualified",
      openedAt: request.receivedAt,
    });
    for (const sensitive of [pixel.token, request.remoteAddress!, "privacy-proxy-observation", "203.0.113.77"]) {
      expect(JSON.stringify(events)).not.toContain(sensitive);
    }
    await drainEmailOpenEvents();
    expect(projection).toHaveBeenCalledTimes(1);
    expect((await receipts())[0]).toMatchObject({ disposition: "projected", attempts: 1 });
  });

  it("keeps a durable backoff outbox and recovers from a crash after native insertion with the same identity", async () => {
    const pixel = await prepare();
    await captureEmailOpenRequest({ token: pixel.token, request });
    const row = (await receipts())[0]!;
    const original = batch.submitBatch;
    const projection = jest.spyOn(batch, "submitBatch").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("simulated crash with private downstream context");
    });
    await drainEmailOpenEvents();
    expect((await receipts())[0]).toMatchObject({ disposition: "pending", attempts: 1, processedAt: null });
    expect((await receipts())[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await drainEmailOpenEvents();
    expect(projection).toHaveBeenCalledTimes(1);
    await db().update(receipt).set({ nextAttemptAt: new Date(0) }).where(eq(receipt.id, row.id));
    await drainEmailOpenEvents();
    expect(projection).toHaveBeenCalledTimes(2);
    expect(projection.mock.calls[0]?.[0].data.batch[0]).toEqual(projection.mock.calls[1]?.[0].data.batch[0]);
    expect((await receipts())[0]).toMatchObject({ disposition: "projected", attempts: 2 });
    const events = await findUserEvents({ workspaceId, messageId: row.id });
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => `${event.message_id}:${event.event_time}`)).size).toBe(1);
  });

  it("limits each projection drain to 50 real native observations", async () => {
    const pixel = await prepare();
    for (let i = 0; i < 52; i += 1) await captureEmailOpenRequest({ token: pixel.token, request });
    await drainEmailOpenEvents();
    expect((await receipts()).filter((row) => row.disposition === "projected")).toHaveLength(50);
    expect((await receipts()).filter((row) => row.disposition === "pending")).toHaveLength(2);
    await drainEmailOpenEvents();
    expect((await receipts()).filter((row) => row.disposition === "pending")).toHaveLength(0);
  });

  it("hides expired raw evidence immediately, cleans it without projecting, and preserves logical retry tokens", async () => {
    const pixel = await prepare();
    await captureEmailOpenRequest({ token: pixel.token, request: {
      ...request, receivedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
    } });
    const old = (await receipts())[0]!;
    expect(await evidence(old.id)).toBeNull();
    const projection = jest.spyOn(batch, "submitBatch");
    await drainEmailOpenEvents();
    expect(projection).not.toHaveBeenCalled();
    expect(await receipts()).toHaveLength(0);
    expect((await prepare()).token).toBe(pixel.token);
  });

  it("bounds raw cleanup to 1000 rows per pass and honors configured retention", async () => {
    const pixel = await prepare();
    await captureEmailOpenRequest({ token: pixel.token, request: { ...request, method: "HEAD" } });
    const row = (await receipts())[0]!;
    const old = new Date(Date.now() - 3 * 86_400_000);
    await db().insert(receipt).values(Array.from({ length: 1001 }, () => ({
      id: randomUUID(), sendId: row.sendId, encryptedRequest: row.encryptedRequest,
      receivedAt: old, method: "HEAD", disposition: "raw_only_head",
    })));
    config().openTrackingRetentionDays = 2;
    await drainEmailOpenEvents();
    expect(await receipts()).toHaveLength(2);
    await drainEmailOpenEvents();
    expect(await receipts()).toHaveLength(1);
  });

  it.each(["contact", "workspace"])("erases %s correlation and raw data, keeps hash-only barriers, and leaves other tenants usable", async (scope) => {
    const first = await prepare();
    const retainedContact = randomUUID();
    const second = await prepare({ userId: retainedContact, messageId: randomUUID() });
    const other = await prepare({ workspaceId: otherWorkspaceId });
    await captureEmailOpenRequest({ token: first.token, request });
    await captureEmailOpenRequest({ token: second.token, request });
    await captureEmailOpenRequest({ token: other.token, request });
    const firstId = (await receipts())[0]!.id;
    await deleteEmailOpenData({ workspaceId, ...(scope === "contact" ? { userIds: [input.userId] } : {}) });
    expect(await receipts()).toHaveLength(scope === "contact" ? 1 : 0);
    expect(await receipts(otherWorkspaceId)).toHaveLength(1);
    expect(await evidence(firstId)).toBeNull();
    await captureEmailOpenRequest({ token: first.token, request });
    await expect(prepare()).rejects.toBeInstanceOf(OpenTrackingError);
    await expect(prepare({ userId: randomUUID() })).rejects.toBeInstanceOf(OpenTrackingError);
    await expect(prepare({ messageId: randomUUID() })).rejects.toBeInstanceOf(OpenTrackingError);
    const barriers = await db().select().from(tombstone).where(eq(tombstone.workspaceId, workspaceId));
    expect(barriers.length).toBeGreaterThan(0);
    for (const sensitive of [input.userId, input.messageId, first.token]) expect(JSON.stringify(barriers)).not.toContain(sensitive);
    await expect(prepare({ userId: randomUUID(), messageId: randomUUID() })).resolves.toHaveProperty("token");
    await expect(prepare({ workspaceId: otherWorkspaceId })).resolves.toHaveProperty("token", other.token);
  });

  it("tombstones explicit absent contacts and treats an empty contact list as a no-op", async () => {
    await deleteEmailOpenData({ workspaceId, userIds: [] });
    expect(await db().select().from(tombstone).where(eq(tombstone.workspaceId, workspaceId))).toHaveLength(0);
    await deleteEmailOpenData({ workspaceId, userIds: [input.userId] });
    await expect(prepare()).rejects.toBeInstanceOf(OpenTrackingError);
    await expect(prepare({ workspaceId: otherWorkspaceId })).resolves.toHaveProperty("token");
  });

  it.each(["capture", "delete"])("serializes %s-first capture and erasure without resurrecting a stale token", async (first) => {
    const pixel = await prepare();
    const signals = new EventEmitter();
    const locked = once(signals, "locked");
    const released = once(signals, "release");
    const blocker = db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
      signals.emit("locked");
      await released;
    });
    await locked;
    let capturing: Promise<void> | undefined;
    let deleting: Promise<void> | undefined;
    try {
      if (first === "capture") {
        capturing = captureEmailOpenRequest({ token: pixel.token, request });
        await waitForLock("ShareLock");
        deleting = deleteEmailOpenData({ workspaceId, userIds: [input.userId] });
        await waitForLock("ExclusiveLock");
      } else {
        deleting = deleteEmailOpenData({ workspaceId, userIds: [input.userId] });
        await waitForLock("ExclusiveLock");
        capturing = captureEmailOpenRequest({ token: pixel.token, request });
        await waitForLock("ShareLock");
      }
    } finally {
      signals.emit("release");
      await Promise.all([blocker, capturing, deleting]);
    }
    expect(await receipts()).toHaveLength(0);
    expect(await db().select().from(send).where(eq(send.workspaceId, workspaceId))).toHaveLength(0);
    await captureEmailOpenRequest({ token: pixel.token, request });
    expect(await receipts()).toHaveLength(0);
  });

  it("waits for real native insertion before erasure and never deadlocks a second queued drainer", async () => {
    const pixel = await prepare();
    await captureEmailOpenRequest({ token: pixel.token, request });
    const signals = new EventEmitter();
    const entered = once(signals, "entered");
    const released = once(signals, "release");
    const original = batch.submitBatch;
    jest.spyOn(batch, "submitBatch").mockImplementationOnce(async (...args) => {
      signals.emit("entered");
      await released;
      return original(...args);
    });
    const draining = drainEmailOpenEvents();
    let deleting: Promise<void> | undefined;
    let secondDraining: Promise<void> | undefined;
    let deletionCompleted = false;
    try {
      await Promise.race([entered, draining.then(() => { throw new Error("Projection ended before serialization barrier"); })]);
      deleting = deleteEmailOpenData({ workspaceId, userIds: [input.userId] }).then(() => { deletionCompleted = true; });
      await waitForLock("ExclusiveLock");
      secondDraining = drainEmailOpenEvents();
      await waitForLock("ShareLock");
      expect(deletionCompleted).toBe(false);
    } finally {
      signals.emit("release");
      await Promise.all([draining, deleting, secondDraining]);
    }
    expect(deletionCompleted).toBe(true);
    expect(await receipts()).toHaveLength(0);
    await captureEmailOpenRequest({ token: pixel.token, request });
    await drainEmailOpenEvents();
    expect(await receipts()).toHaveLength(0);
  });

  it("fails closed without exposing a malformed secret or persisting plaintext", async () => {
    config().secretKey = "private-invalid-encryption-secret";
    await expect(prepare()).rejects.toThrow("Email open tracking operation failed.");
    expect(await db().select().from(send).where(eq(send.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("rejects ciphertext transplanted from a different scoped receipt", async () => {
    const first = await prepare();
    const second = await prepare({ messageId: randomUUID() });
    await captureEmailOpenRequest({ token: first.token, request });
    const a = (await receipts())[0];
    await captureEmailOpenRequest({ token: second.token, request });
    const b = (await receipts()).find((row) => row.id !== a?.id);
    if (!a || !b) throw new Error("Expected both receipt envelopes");
    await db().update(receipt).set({ encryptedRequest: b.encryptedRequest }).where(eq(receipt.id, a.id));
    await expect(evidence(a.id)).rejects.toThrow("Email open tracking operation failed.");
  });
});

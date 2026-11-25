import { createHash, randomBytes, randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { EventEmitter, once } from "events";
import { Pool } from "pg";
import { setImmediate as yieldToIo } from "timers/promises";

import { installNewsletterSecretFixture } from "../../test/newsletterSecretFixture";
import {
  createTrackedSendFixture, createTrackingNewsletterFixture,
  TrackedSendFixture, TrackingNewsletterFixture,
} from "../../test/openTrackingFixture";
import * as batch from "../apps/batch";
import { clickhouseClient } from "../clickhouse";
import config, { Config } from "../config";
import { db, pool } from "../db";
import { newsletterErasure, newsletterSend, newsletterTrackingDomain, newsletterWebhookReceipt } from "../db/schema";
import { newsletterContactHash } from "../newsletterSubscriptions";
import { decrypt, encrypt } from "../secrets";
import { EventType, InternalEventType } from "../types";
import { findUserEvents } from "../userEvents";
import {
  captureEmailOpenRequests, CaptureEmailOpenRequestInput, deleteEmailOpenData,
  getEmailOpenEvidence, OPEN_TRACKING_PIXEL_PATH, OPEN_TRACKING_REQUEST_LIMITS,
  OpenTrackingError, OpenTrackingRequestInput, prepareEmailOpenTracking, sanitizeOpenTrackingRequest,
} from "./openTracking";
import * as trackingEvents from "./openTrackingEvents";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

describe("canonical send Queue-to-ClickHouse opens", () => {
  let newsletter: TrackingNewsletterFixture;
  let send: TrackedSendFixture;
  let request: OpenTrackingRequestInput;
  let restoreSecret: () => void;
  let settings: Pick<Config, "enableOpenTracking" | "openTrackingRetentionDays" | "openTrackingSelfIps" | "writeMode">;

  beforeEach(async () => {
    settings = {
      enableOpenTracking: config().enableOpenTracking, openTrackingRetentionDays: config().openTrackingRetentionDays,
      openTrackingSelfIps: config().openTrackingSelfIps, writeMode: config().writeMode,
    };
    restoreSecret = installNewsletterSecretFixture();
    Object.assign(config(), { enableOpenTracking: true, openTrackingRetentionDays: 30, openTrackingSelfIps: [] });
    newsletter = await createTrackingNewsletterFixture();
    send = await createTrackedSendFixture(newsletter);
    const receivedAt = new Date(Date.now() - 120_000).toISOString();
    request = {
      receivedAt, method: "GET", path: `/private/${send.token}?secret=password`,
      query: { cb: "123", v: "2", email: "private@example.com", secret: "password" },
      headers: {
        "User-Agent": BROWSER, cookie: "private-cookie", authorization: "Bearer private-key",
        referer: "https://example.com/private", "x-forwarded-for": "203.0.113.77",
      },
      remoteAddress: "192.0.2.11", httpVersion: "1.1", encrypted: true,
      edgeObserved: {
        source: "cloudflare_worker", hostname: newsletter.hostname, receivedAt,
        remoteAddress: "198.51.100.11", networkSetVersion: null,
      },
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.assign(config(), settings);
    restoreSecret();
  });

  function hit(overrides: Partial<CaptureEmailOpenRequestInput> = {}): CaptureEmailOpenRequestInput {
    return {
      eventId: randomUUID(), token: send.token, expectedHostname: newsletter.hostname,
      expectedWorkspaceId: newsletter.workspaceId, request, ...overrides,
    };
  }

  function evidence(eventId: string, overrides: Partial<Parameters<typeof getEmailOpenEvidence>[0]> = {}) {
    return getEmailOpenEvidence({
      workspaceId: newsletter.workspaceId, userId: send.userId, messageId: send.messageId,
      evidenceId: eventId, ...overrides,
    });
  }

  function events() {
    return trackingEvents.findEmailOpenTrackingEvents({ workspaceId: newsletter.workspaceId });
  }

  async function waitForLocks(count = 1) {
    expect(pool()).toBeInstanceOf(Pool);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await db().execute<{ waiting: number }>(sql`select count(*)::integer as waiting from pg_locks
        where locktype = 'advisory' and not granted and mode = 'ExclusiveLock'
        and classid = ((hashtextextended(${newsletter.workspaceId}, 0) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${newsletter.workspaceId}, 0) & 4294967295)::oid`);
      if ((result.rows[0]?.waiting ?? 0) >= count) return;
      await yieldToIo();
    }
    throw new Error("Expected workspace advisory lock waiters");
  }

  it("issues only metadata for the existing send identity, with no insert or global fallback", async () => {
    const sendId = randomUUID();
    const prepared = await db().transaction((tx) => prepareEmailOpenTracking({
      sendId, workspaceId: newsletter.workspaceId, html: "<body><p>Original</p></body>",
    }, tx));
    expect(await db().select().from(newsletterSend).where(eq(newsletterSend.id, sendId))).toHaveLength(0);
    const envelope = JSON.parse(decrypt(prepared.encryptedOpenTrackingToken)!);
    expect(envelope.id).toBe(sendId);
    expect(Buffer.from(envelope.token, "base64url")).toHaveLength(32);
    expect(prepared.openTrackingTokenHash).toBe(createHash("sha256").update(envelope.token).digest("hex"));
    expect(prepared.openTrackingOrigin).toBe(`https://${newsletter.hostname}`);
    expect(prepared.html).toContain(`${prepared.openTrackingOrigin}/api/public/email/open/${envelope.token}.gif`);
    expect(prepared.html.indexOf("owned_pixel")).toBeLessThan(prepared.html.indexOf("</body>"));
    config().enableOpenTracking = false;
    await expect(prepareEmailOpenTracking({ sendId, workspaceId: newsletter.workspaceId, html: "" }))
      .rejects.toBeInstanceOf(OpenTrackingError);
    await captureEmailOpenRequests([hit()]);
    expect(await events()).toHaveLength(0);
    config().enableOpenTracking = true;
    await db().update(newsletterTrackingDomain).set({ status: "pending", cnameVerified: false })
      .where(eq(newsletterTrackingDomain.newsletterId, newsletter.workspaceId));
    await expect(prepareEmailOpenTracking({ sendId, workspaceId: newsletter.workspaceId, html: "" }))
      .rejects.toBeInstanceOf(OpenTrackingError);
    await expect(prepareEmailOpenTracking({ sendId, workspaceId: newsletter.publisherId, html: "" }))
      .rejects.toBeInstanceOf(OpenTrackingError);
  });

  it("requires a private key and binds encrypted token envelopes to their canonical send UUID", async () => {
    config().secretKey = "private-invalid-key";
    await expect(prepareEmailOpenTracking({ sendId: randomUUID(), workspaceId: newsletter.workspaceId, html: "" }))
      .rejects.toThrow("Email open tracking operation failed.");
    restoreSecret();
    restoreSecret = installNewsletterSecretFixture();
    const other = await createTrackedSendFixture(newsletter);
    const [row] = await db().select().from(newsletterSend).where(eq(newsletterSend.id, other.sendId));
    await db().update(newsletterSend).set({ encryptedOpenTrackingToken: row!.encryptedOpenTrackingToken })
      .where(eq(newsletterSend.id, send.sendId));
    await expect(captureEmailOpenRequests([hit()])).rejects.toBeInstanceOf(OpenTrackingError);
    expect(await events()).toHaveLength(0);
  });

  it("bounds selected evidence, strips URL secrets and never promotes forwarded actor hints", () => {
    const sanitized = sanitizeOpenTrackingRequest(request)!;
    expect(sanitized).toMatchObject({
      path: OPEN_TRACKING_PIXEL_PATH, query: { cb: "123", v: "2" },
      headers: { "user-agent": BROWSER }, untrustedProxyHeaders: { "x-forwarded-for": "203.0.113.77" },
    });
    for (const secret of [send.token, "private-cookie", "private-key", "private@example.com", "password"]) {
      expect(JSON.stringify(sanitized)).not.toContain(secret);
    }
    const bounded = sanitizeOpenTrackingRequest({ ...request, headers: {
      "user-agent": "🕵".repeat(20_000), accept: Array(50).fill("x".repeat(5_000)),
      forwarded: "f".repeat(20_000), via: "v".repeat(20_000),
    }, query: { cb: "1".repeat(21) } })!;
    expect(bounded.headers["user-agent"]?.length).toBe(OPEN_TRACKING_REQUEST_LIMITS.headerValueChars);
    expect(bounded.headers.accept).toEqual(Array(4).fill("x".repeat(128)));
    expect(bounded.query).toEqual({});
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(OPEN_TRACKING_REQUEST_LIMITS.envelopeBytes - 256);
  });

  it("retains every repeated GET/HEAD/bot load in one CH batch but projects only observed GETs", async () => {
    const insertion = jest.spyOn(trackingEvents, "insertEmailOpenTrackingEvents");
    const inputs = [
      hit(), hit(), hit({ request: { ...request, method: "HEAD" } }),
      hit({ request: { ...request, method: "HEAD" } }),
      hit({ request: { ...request, headers: { "user-agent": "curl/8.0" } } }),
    ];
    await captureEmailOpenRequests(inputs);
    expect(insertion).toHaveBeenCalledTimes(1);
    expect(insertion.mock.calls[0]?.[0]).toHaveLength(5);
    const rows = await events();
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.method === "GET" && row.counted)).toHaveLength(1);
    expect(rows.filter((row) => row.class === "scanner" && !row.counted)).toHaveLength(3);
    expect(await findUserEvents({ workspaceId: newsletter.workspaceId, event: [InternalEventType.EmailOpened] })).toHaveLength(3);
    for (const input of inputs) {
      expect(await evidence(input.eventId)).toMatchObject({ isOpenObservation: input.request.method === "GET" });
    }
  });

  it("deduplicates retry UUIDs within/concurrent batches, freezes origin evidence and rejects body conflicts", async () => {
    const input = hit();
    const projection = jest.spyOn(batch, "submitBatch");
    await Promise.all(Array.from({ length: 4 }, () => captureEmailOpenRequests([input, input])));
    await captureEmailOpenRequests([{ ...input, request: {
      ...request, remoteAddress: "192.0.2.99", httpVersion: "2", encrypted: false,
      headers: Object.fromEntries(Object.entries(request.headers!).reverse()),
    } }]);
    expect(await events()).toHaveLength(1);
    expect(projection).toHaveBeenCalledTimes(1);
    expect(await evidence(input.eventId)).toMatchObject({ request: {
      remoteAddress: "192.0.2.11", httpVersion: "1.1", encrypted: true,
    } });
    for (const changed of [
      { ...input, request: { ...request, method: "HEAD" } },
      { ...input, request: { ...request, query: { cb: "456" } } },
    ]) await expect(captureEmailOpenRequests([changed])).rejects.toBeInstanceOf(OpenTrackingError);
    const other = await createTrackedSendFixture(newsletter);
    await expect(captureEmailOpenRequests([{ ...input, token: other.token }])).rejects.toBeInstanceOf(OpenTrackingError);
    const conflict = hit();
    await expect(captureEmailOpenRequests([conflict, { ...conflict, request: { ...request, method: "HEAD" } }]))
      .rejects.toBeInstanceOf(OpenTrackingError);
    expect(await events()).toHaveLength(1);
  });

  it("requires exact workspace and original hostname bindings even after a verified domain changes", async () => {
    const other = await createTrackingNewsletterFixture();
    const inputs = [
      hit({ expectedWorkspaceId: other.workspaceId }), hit({ expectedHostname: other.hostname }),
      hit({ token: randomBytes(32).toString("base64url") }), hit({ token: "bad" }),
      hit({ eventId: "bad" }), hit({ request: { ...request, method: "POST" } }),
      hit({ request: { ...request, receivedAt: new Date(Date.now() + 301_000).toISOString() } }),
      hit({ request: { ...request, receivedAt: "not-a-time" } }),
    ];
    await captureEmailOpenRequests(inputs);
    expect(await events()).toHaveLength(0);
    await db().update(newsletterTrackingDomain).set({ isCurrent: false })
      .where(eq(newsletterTrackingDomain.newsletterId, newsletter.workspaceId));
    const input = hit();
    await captureEmailOpenRequests([input]);
    expect(await events()).toHaveLength(1);
    for (const scope of [
      { workspaceId: other.workspaceId }, { userId: randomUUID() },
      { messageId: randomUUID() }, { evidenceId: randomUUID() },
    ]) expect(await evidence(input.eventId, scope)).toBeNull();
    const row = (await events())[0]!;
    expect(row.encryptedRequest).not.toContain(send.token);
    expect(row.encryptedRequest).not.toContain("private-cookie");
    expect(await evidence(input.eventId)).toMatchObject({ request: {
      edgeObserved: { remoteAddress: "198.51.100.11" }, path: OPEN_TRACKING_PIXEL_PATH,
    } });
  });

  it("orders same-batch and persisted actors by occurrence, excludes future/self and isolates send/method/UA", async () => {
    const other = await createTrackedSendFixture(newsletter);
    const base = Date.now() - 120_000;
    const at = (offset: number, changes: Partial<OpenTrackingRequestInput> = {}) => ({
      ...request, receivedAt: new Date(base + offset).toISOString(), ...changes,
    });
    const future = hit({ request: at(40_000) });
    await captureEmailOpenRequests([future]);
    const first = hit({ request: at(1_000) });
    const duplicate = hit({ request: at(2_000) });
    const differentUa = hit({ request: at(3_000, { headers: { "user-agent": "Thunderbird/128.0" } }) });
    const head = hit({ request: at(0, { method: "HEAD" }) });
    const otherSend = hit({ token: other.token, request: at(2_000) });
    await captureEmailOpenRequests([duplicate, differentUa, otherSend, head, first, future]);
    const rows = await events();
    expect(rows.find((row) => row.eventId === first.eventId)).toMatchObject({ counted: true });
    expect(rows.find((row) => row.eventId === duplicate.eventId)).toMatchObject({ counted: false, reason: expect.stringContaining("duplicate") });
    for (const eventId of [differentUa.eventId, otherSend.eventId, future.eventId]) {
      expect(rows.find((row) => row.eventId === eventId)).toMatchObject({ counted: true });
    }
    await captureEmailOpenRequests([hit({ request: at(4_000) })]);
    expect((await events()).filter((row) => row.reason.includes("duplicate"))).toHaveLength(2);
  });

  it("propagates native failure, freezes the first classification, and retries only the missing native GET", async () => {
    const input = hit({ request: { ...request, headers: { "user-agent": "Mozilla/5.0 (via ggpht.com GoogleImageProxy)" } } });
    const original = batch.submitBatch;
    const projection = jest.spyOn(batch, "submitBatch").mockRejectedValueOnce(new Error("private downstream failure"));
    await expect(captureEmailOpenRequests([input])).rejects.toThrow("Email open tracking operation failed.");
    const initial = (await events())[0]!;
    expect(initial).toMatchObject({ class: "gmail_proxy", counted: true, secondsSinceDelivery: null });
    await clickhouseClient().insert({
      table: "internal_events", format: "JSONEachRow",
      values: [{
        workspace_id: newsletter.workspaceId, user_id: send.userId, origin_message_id: send.messageId,
        event: InternalEventType.EmailDelivered, event_time: new Date(Date.parse(request.receivedAt) - 6_000).toISOString(),
      }],
      clickhouse_settings: { wait_end_of_query: 1, date_time_input_format: "best_effort" },
    });
    await captureEmailOpenRequests([input]);
    expect(await events()).toEqual([initial]);
    expect(projection).toHaveBeenCalledTimes(2);
    expect(projection.mock.calls[0]?.[0].data.batch).toEqual(projection.mock.calls[1]?.[0].data.batch);
    const subsequent = hit({ request: { ...input.request, receivedAt: new Date(Date.parse(request.receivedAt) + 1000).toISOString() } });
    await captureEmailOpenRequests([subsequent]);
    expect((await events()).find((row) => row.eventId === subsequent.eventId)).toMatchObject({
      class: "prefetch", counted: false, secondsSinceDelivery: 7,
    });
    projection.mockImplementationOnce(async (...args) => { await original(...args); throw new Error("after native write"); });
    const crashedAfterNative = hit();
    await expect(captureEmailOpenRequests([crashedAfterNative])).rejects.toBeInstanceOf(OpenTrackingError);
    const calls = projection.mock.calls.length;
    await captureEmailOpenRequests([crashedAfterNative]);
    expect(projection).toHaveBeenCalledTimes(calls);
    expect(await findUserEvents({ workspaceId: newsletter.workspaceId, messageId: crashedAfterNative.eventId })).toHaveLength(1);
  });

  it("uses only actual correlated provider delivery receipts and never acceptance timestamps", async () => {
    const at = Date.parse(request.receivedAt);
    await db().update(newsletterSend).set({ state: "accepted", providerMessageId: "provider-fixture", acceptedEventAt: new Date(at - 1000) })
      .where(eq(newsletterSend.id, send.sendId));
    await db().insert(newsletterWebhookReceipt).values([
      {
        connectionId: newsletter.connectionId, sendId: send.sendId, mailboxHash: "fixture", eventId: randomUUID(),
        encryptedPayload: encrypt(JSON.stringify({ event: "delivered", timestamp: (at - 6000) / 1000, sg_message_id: "provider-fixture.suffix" })),
      },
      {
        connectionId: newsletter.connectionId, sendId: send.sendId, mailboxHash: "other-contact", eventId: randomUUID(),
        encryptedPayload: encrypt(JSON.stringify({ event: "delivered", timestamp: (at - 500_000) / 1000 })),
      },
      {
        connectionId: newsletter.connectionId, sendId: send.sendId, mailboxHash: "fixture", eventId: randomUUID(),
        encryptedPayload: encrypt(JSON.stringify({ event: "processed", timestamp: (at - 400_000) / 1000 })),
      },
    ]);
    await captureEmailOpenRequests([hit()]);
    expect(await events()).toEqual([expect.objectContaining({ secondsSinceDelivery: 6, class: "prefetch", counted: false })]);
  });

  it("propagates CH failure without native projection and recovers through the unchanged Queue observation", async () => {
    const input = hit();
    const insert = jest.spyOn(trackingEvents, "insertEmailOpenTrackingEvents").mockRejectedValueOnce(new Error("CH failed"));
    const project = jest.spyOn(batch, "submitBatch");
    await expect(captureEmailOpenRequests([input])).rejects.toBeInstanceOf(OpenTrackingError);
    expect(project).not.toHaveBeenCalled();
    expect(await events()).toHaveLength(0);
    await captureEmailOpenRequests([input]);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(await events()).toHaveLength(1);
  });

  it("preserves observed native identities, event times and late-event maxima, independent of classification", async () => {
    config().writeMode = "ch-async";
    const latest = hit({ request: { ...request, headers: { "user-agent": "curl/8.0" } } });
    const early = hit({ request: { ...request, receivedAt: new Date(Date.parse(request.receivedAt) - 60_000).toISOString() } });
    await captureEmailOpenRequests([latest]);
    await captureEmailOpenRequests([early, latest, hit({ request: { ...request, method: "HEAD" } })]);
    const native = await findUserEvents({ workspaceId: newsletter.workspaceId, event: [InternalEventType.EmailOpened] });
    expect(native).toHaveLength(2);
    expect(new Set(native.map((event) => event.message_id))).toEqual(new Set([latest.eventId, early.eventId]));
    const properties = native.map((event) => JSON.parse(event.properties));
    expect(properties).toEqual(expect.arrayContaining([expect.objectContaining({
      messageId: send.messageId, evidenceId: latest.eventId, evidenceSource: "owned_pixel",
      engagementClassification: "observed_unqualified", openedAt: latest.request.receivedAt,
    })]));
    expect(Math.max(...properties.map((value) => Date.parse(value.openedAt)))).toBe(Date.parse(latest.request.receivedAt));
    for (const secret of [send.token, BROWSER, "198.51.100.11", "203.0.113.77"]) {
      expect(JSON.stringify(native)).not.toContain(secret);
    }
  });

  it("retains aged Queue classification/native history after raw expiry, with independent 30-day actor columns", async () => {
    config().openTrackingRetentionDays = 1;
    const aged = hit({ request: { ...request, receivedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() } });
    const older = hit({ request: { ...request, receivedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() } });
    await captureEmailOpenRequests([aged, older]);
    const rows = await events();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: aged.eventId, encryptedRequest: null, ip: "198.51.100.11", userAgent: BROWSER }),
      expect.objectContaining({ eventId: older.eventId, encryptedRequest: null, ip: null, userAgent: null }),
    ]));
    expect(await evidence(aged.eventId)).toBeNull();
    expect(await evidence(older.eventId)).toBeNull();
    await captureEmailOpenRequests([aged, older]);
    expect(await events()).toHaveLength(2);
    expect(await findUserEvents({ workspaceId: newsletter.workspaceId, event: [InternalEventType.EmailOpened] })).toHaveLength(2);
    const original = rows.find((row) => row.eventId === aged.eventId)!;
    await trackingEvents.insertEmailOpenTrackingEvents([original, original]);
    expect(await events()).toHaveLength(2);
  });

  it("enforces encrypted raw expiry immediately and materializes actual ciphertext/IP/UA column TTLs", async () => {
    const input = hit();
    await captureEmailOpenRequests([input]);
    const initial = (await events())[0]!;
    const expired = {
      ...initial, eventId: randomUUID(), occurredAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      rawExpiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await trackingEvents.insertEmailOpenTrackingEvents([expired]);
    const bypassId = randomUUID();
    await clickhouseClient().insert({
      table: "trackingEvent", values: [{ ...expired, eventId: bypassId }], format: "JSONEachRow",
      clickhouse_settings: { wait_end_of_query: 1, date_time_input_format: "best_effort" },
    });
    expect(await evidence(bypassId)).toBeNull();
    expect(await events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: bypassId, encryptedRequest: null, ip: null, userAgent: null }),
    ]));
    await clickhouseClient().command({
      query: "ALTER TABLE trackingEvent MATERIALIZE TTL",
      clickhouse_settings: { mutations_sync: "2", wait_end_of_query: 1 },
    });
    const result = await clickhouseClient().query({
      query: `SELECT encryptedRequest, ip, userAgent FROM trackingEvent FINAL
        WHERE workspaceId = {workspaceId:String} AND eventId = {eventId:UUID}`,
      query_params: { workspaceId: newsletter.workspaceId, eventId: bypassId }, format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ encryptedRequest: null, ip: null, userAgent: null }]);
    expect(await evidence(input.eventId)).not.toBeNull();
    config().openTrackingRetentionDays = 2;
    const short = hit({ request: { ...request, method: "HEAD" } });
    await captureEmailOpenRequests([short]);
    const shortRow = (await events()).find((row) => row.eventId === short.eventId)!;
    expect(Date.parse(shortRow.rawExpiresAt) - Date.parse(shortRow.occurredAt)).toBe(2 * 86_400_000);
  });

  it.each(["contact", "workspace"])("erases %s CH data and canonical tokens while preserving hash barriers and other tenants", async (scope) => {
    const otherNewsletter = await createTrackingNewsletterFixture();
    const otherSend = await createTrackedSendFixture(otherNewsletter);
    const retained = await createTrackedSendFixture(newsletter);
    const input = hit();
    const retainedHit = hit({ token: retained.token });
    const otherHit = hit({
      token: otherSend.token, expectedWorkspaceId: otherNewsletter.workspaceId, expectedHostname: otherNewsletter.hostname,
      request: { ...request, edgeObserved: { ...request.edgeObserved!, hostname: otherNewsletter.hostname } },
    });
    await captureEmailOpenRequests([input, retainedHit, otherHit]);
    await deleteEmailOpenData({ workspaceId: newsletter.workspaceId, ...(scope === "contact" ? { userIds: [send.userId] } : {}) });
    expect(await events()).toHaveLength(scope === "contact" ? 1 : 0);
    expect(await trackingEvents.findEmailOpenTrackingEvents({ workspaceId: otherNewsletter.workspaceId })).toHaveLength(1);
    const [row] = await db().select().from(newsletterSend).where(eq(newsletterSend.id, send.sendId));
    expect(row).toMatchObject({ openTrackingTokenHash: null, encryptedOpenTrackingToken: null, openTrackingOrigin: null });
    const barriers = await db().select().from(newsletterErasure).where(eq(newsletterErasure.workspaceId, newsletter.workspaceId));
    expect(barriers).toEqual(expect.arrayContaining([expect.objectContaining({ userHash: newsletterContactHash(newsletter.workspaceId, send.userId) })]));
    expect(JSON.stringify(barriers)).not.toContain(send.userId);
    expect(await evidence(input.eventId)).toBeNull();
    await captureEmailOpenRequests([input, hit()]);
    expect(await events()).toHaveLength(scope === "contact" ? 1 : 0);
  });

  it("bars explicit missing contacts and whole-workspace known contacts without send rows", async () => {
    const missing = randomUUID();
    await deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [] });
    expect(await db().select().from(newsletterErasure).where(eq(newsletterErasure.workspaceId, newsletter.workspaceId))).toHaveLength(0);
    await deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [missing, missing] });
    const stale = await createTrackedSendFixture(newsletter, { userId: missing });
    await captureEmailOpenRequests([hit({ token: stale.token })]);
    expect(await events()).toHaveLength(0);
    await db().update(newsletterSend).set({ erasedAt: new Date() }).where(eq(newsletterSend.id, send.sendId));
    await captureEmailOpenRequests([hit()]);
    expect(await events()).toHaveLength(0);
    const known = randomUUID();
    await batch.submitBatch({ workspaceId: newsletter.workspaceId, data: {
      batch: [{ type: EventType.Identify, userId: known, messageId: randomUUID(), traits: { email: "fixture@example.invalid" } }],
    } }, { writeModeOverride: "ch-sync" });
    await deleteEmailOpenData({ workspaceId: newsletter.workspaceId });
    const hashes = await db().select().from(newsletterErasure).where(eq(newsletterErasure.workspaceId, newsletter.workspaceId));
    expect(hashes.map((row) => row.userHash)).toEqual(expect.arrayContaining([
      newsletterContactHash(newsletter.workspaceId, missing), newsletterContactHash(newsletter.workspaceId, known),
    ]));
  });

  it.each(["capture", "erase"])("serializes actual PostgreSQL %s-first locks without stale-token resurrection", async (first) => {
    const signals = new EventEmitter();
    const locked = once(signals, "locked");
    const released = once(signals, "release");
    const blocker = db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${newsletter.workspaceId}, 0))`);
      signals.emit("locked");
      await released;
    });
    await locked;
    const input = hit();
    let capture: Promise<void> | undefined;
    let erase: Promise<void> | undefined;
    try {
      if (first === "capture") {
        capture = captureEmailOpenRequests([input]);
        await waitForLocks();
        erase = deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [send.userId] });
      } else {
        erase = deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [send.userId] });
        await waitForLocks();
        capture = captureEmailOpenRequests([input]);
      }
      await waitForLocks(2);
    } finally {
      signals.emit("release");
      await Promise.all([blocker, capture, erase]);
    }
    expect(await events()).toHaveLength(0);
    await captureEmailOpenRequests([input]);
    expect(await events()).toHaveLength(0);
  });

  it("holds the exclusive workspace lock through real native insertion before erasure and a second batch", async () => {
    const signals = new EventEmitter();
    const entered = once(signals, "entered");
    const released = once(signals, "release");
    const original = batch.submitBatch;
    jest.spyOn(batch, "submitBatch").mockImplementationOnce(async (...args) => {
      signals.emit("entered");
      await released;
      return original(...args);
    });
    const capture = captureEmailOpenRequests([hit()]);
    let erase: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    let erased = false;
    try {
      await Promise.race([entered, capture.then(() => { throw new Error("Expected native barrier"); })]);
      erase = deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [send.userId] }).then(() => { erased = true; });
      await waitForLocks();
      second = captureEmailOpenRequests([hit()]);
      await waitForLocks(2);
      expect(erased).toBe(false);
    } finally {
      signals.emit("release");
      await Promise.all([capture, erase, second]);
    }
    expect(erased).toBe(true);
    expect(await events()).toHaveLength(0);
    expect(await db().select().from(newsletterErasure).where(and(
      eq(newsletterErasure.workspaceId, newsletter.workspaceId),
      eq(newsletterErasure.userHash, newsletterContactHash(newsletter.workspaceId, send.userId)),
    ))).toHaveLength(1);
  });
});

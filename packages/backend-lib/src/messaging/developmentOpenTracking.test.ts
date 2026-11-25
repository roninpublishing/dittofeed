import { randomBytes, randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { EventEmitter, once } from "events";
import { DevelopmentPixelEvent, DEVELOPMENT_PIXEL_TABLE } from "isomorphic-lib/src/tracking/development";
import * as classification from "isomorphic-lib/src/tracking/classify";
import { setImmediate as yieldToIo } from "timers/promises";

import { installNewsletterSecretFixture } from "../../test/newsletterSecretFixture";
import { createTrackedSendFixture, createTrackingNewsletterFixture, TrackedSendFixture, TrackingNewsletterFixture } from "../../test/openTrackingFixture";
import * as batch from "../apps/batch";
import { clickhouseClient } from "../clickhouse";
import config, { Config } from "../config";
import { db } from "../db";
import { newsletterErasure, newsletterSend, newsletterTrackingDomain } from "../db/schema";
import { deleteNewsletterDeliveryData } from "../newsletterDelivery";
import { decrypt, encrypt } from "../secrets";
import { CREATE_DEVELOPMENT_OPEN_PIXEL_EVENT_TABLE_QUERY } from "../userEvents/clickhouse";
import {
  captureDevelopmentPixelEvents, CaptureDevelopmentPixelEventInput, DEVELOPMENT_PIXEL_ERASURE_LOCK,
  DevelopmentOpenTrackingError, findDevelopmentPixelEvents,
} from "./developmentOpenTracking";
import { captureEmailOpenRequests, deleteEmailOpenData } from "./openTracking";

const DAY = 86_400_000;

describe("development-only open pixel evidence", () => {
  let newsletter: TrackingNewsletterFixture;
  let send: TrackedSendFixture;
  let settings: Pick<Config, "enableOpenTracking" | "enableOpenTrackingDevLake" | "openTrackingRetentionDays">;
  let restoreSecret: () => void;

  beforeEach(async () => {
    settings = { enableOpenTracking: config().enableOpenTracking,
      enableOpenTrackingDevLake: config().enableOpenTrackingDevLake,
      openTrackingRetentionDays: config().openTrackingRetentionDays };
    restoreSecret = installNewsletterSecretFixture();
    Object.assign(config(), { enableOpenTracking: true, enableOpenTrackingDevLake: true, openTrackingRetentionDays: 30 });
    newsletter = await createTrackingNewsletterFixture();
    send = await createTrackedSendFixture(newsletter);
  });
  afterEach(() => { jest.restoreAllMocks(); Object.assign(config(), settings); restoreSecret(); });

  function hit(overrides: Partial<DevelopmentPixelEvent> = {}): CaptureDevelopmentPixelEventInput {
    const event: DevelopmentPixelEvent = {
      v: 3, eventId: randomUUID(), hostname: newsletter.hostname, token: send.token,
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      evidence: {
        request: {
          url: `https://${newsletter.hostname}${send.path}?cb=1&cb=2&api_key=private-query`, method: "GET",
          headers: { "user-agent": "Development fixture browser", "cf-connecting-ip": "198.51.100.1",
            authorization: "Bearer private-header", cookie: "private-cookie", referer: "https://ref.example/?access_token=private-referrer&safe=yes" },
          properties: { redirect: "follow", credentials: "same-origin", cf: { nested: true } },
          body: { encoding: "base64", data: "", capturedBytes: 0, declaredBytes: null, truncated: false, unavailable: null },
        },
        cloudflare: { country: "US", botManagement: { score: 1, verifiedBot: true }, tlsVersion: "TLSv1.3" },
        response: { status: 200, headers: { "content-type": "image/gif", "set-cookie": "private-response-cookie" } },
        network: { setVersion: null, match: null }, redactions: [], truncations: [], unavailable: [],
      }, ...overrides,
    };
    return { workspaceId: newsletter.workspaceId, event };
  }
  function read(input: { eventId?: string; userId?: string; messageId?: string; limit?: number; before?: string } = {}) {
    return findDevelopmentPixelEvents({ workspaceId: newsletter.workspaceId, ...input });
  }
  async function raw(workspaceId = newsletter.workspaceId) {
    const result = await clickhouseClient().query({ query: `SELECT * FROM ${DEVELOPMENT_PIXEL_TABLE} FINAL WHERE workspaceId = {workspaceId:String}`,
      query_params: { workspaceId }, format: "JSONEachRow" });
    return result.json<{ eventId: string; requestHash: string; encryptedEvidence: string; rawExpiresAt: string; tokenHash: string | null }>();
  }
  async function waitForGlobalLock(mode: "ExclusiveLock" | "ShareLock") {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await db().execute<{ waiting: number }>(sql`select count(*)::integer as waiting from pg_locks
        where locktype = 'advisory' and not granted and mode = ${mode}
        and classid = ((hashtextextended(${DEVELOPMENT_PIXEL_ERASURE_LOCK}, 1) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${DEVELOPMENT_PIXEL_ERASURE_LOCK}, 1) & 4294967295)::oid`);
      if (result.rows[0]?.waiting) return;
      await yieldToIo();
    }
    throw new Error("Expected development erasure lock waiter");
  }

  it("stores broad decryptable evidence only, with no native/classification writes or per-hit PG rows", async () => {
    const native = jest.spyOn(batch, "submitBatch");
    const classify = jest.spyOn(classification, "classify");
    const events = [hit(), hit(), hit(), hit({ token: null }), hit({ token: randomBytes(32).toString("base64url") })];
    events[1]!.event.evidence.request.method = "HEAD";
    events[2]!.event.evidence.request.method = "PATCH";
    events[2]!.event.evidence.response.status = 405;
    await captureDevelopmentPixelEvents(events);
    expect(native).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled();
    const page = await read();
    expect(page.events).toHaveLength(5);
    expect(page.events.filter((event) => event.status === "matched")).toHaveLength(3);
    expect(page.events.find((event) => event.status === "unmatched")).toMatchObject({ userId: null, sendId: null, messageId: null });
    expect(page.events.find((event) => event.status === "invalid")).toBeDefined();
    expect(page.events[0]?.evidence?.cloudflare).toMatchObject({ botManagement: { score: 1, verifiedBot: true }, tlsVersion: "TLSv1.3" });
    const nativeRows = await clickhouseClient().query({ query: `SELECT count() AS count FROM user_events_v2 WHERE workspace_id = {workspaceId:String}`,
      query_params: { workspaceId: newsletter.workspaceId }, format: "JSONEachRow" });
    expect((await nativeRows.json<{ count: string }>())[0]?.count).toBe("0");
    const normalRows = await clickhouseClient().query({ query: `SELECT count() AS count FROM trackingEvent FINAL WHERE workspaceId = {workspaceId:String}`,
      query_params: { workspaceId: newsletter.workspaceId }, format: "JSONEachRow" });
    expect((await normalRows.json<{ count: string }>())[0]?.count).toBe("0");
    expect(await db().select().from(newsletterSend).where(eq(newsletterSend.workspaceId, newsletter.workspaceId))).toHaveLength(1);
    expect(await db().select().from(newsletterErasure).where(eq(newsletterErasure.workspaceId, newsletter.workspaceId))).toHaveLength(0);
  });

  it("defensively strips credentials and bearer tokens, preserves repeats and safely handles prototype keys", async () => {
    const input = hit();
    const body = JSON.stringify({ email: "available@example.invalid", password: "private-body", nested: { access_token: send.token }, __proto__: null });
    input.event.evidence.request.headers["content-type"] = "application/json";
    input.event.evidence.request.body = { encoding: "base64", data: Buffer.from(body).toString("base64"), capturedBytes: Buffer.byteLength(body), declaredBytes: Buffer.byteLength(body), truncated: false, unavailable: null };
    input.event.evidence.cloudflare = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"safe":true},"apiKey":"private-cf","nested":[{"cookie":"private-nested"}]}') as Record<string, unknown>;
    await captureDevelopmentPixelEvents([input]);
    const [stored] = await raw();
    expect(stored).toBeDefined();
    const plaintext = decrypt(JSON.parse(stored!.encryptedEvidence));
    expect(plaintext).toBeTruthy();
    for (const secret of [send.token, "private-query", "private-header", "private-cookie", "private-referrer", "private-response-cookie", "private-cf", "private-nested"]) expect(plaintext).not.toContain(secret);
    const evidence = (await read()).events[0]!.evidence!;
    const decodedBody = Buffer.from(evidence.request.body.data, "base64").toString("utf8");
    expect(decodedBody).not.toContain("private-body"); expect(decodedBody).not.toContain(send.token);
    expect(decodedBody).toContain("available@example.invalid");
    expect(new URL(evidence.request.url).searchParams.getAll("cb")).toEqual(["1", "2"]);
    expect(evidence.request.properties.credentials).toBe("same-origin");
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(evidence.cloudflare).toHaveProperty("__proto__");
    expect(JSON.stringify(stored)).not.toContain(send.token);
    expect((await read()).events[0]).not.toHaveProperty("tokenHash");
  });

  // Zero-copy views bridge the repository's legacy Buffer and newer TypedArray typings.
  function bufferView(buffer: Buffer): Uint8Array {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  it("redacts represented form bodies and preserves opaque binary bytes except known capabilities", async () => {
    const form = hit(); form.event.evidence.request.headers["content-type"] = "application/x-www-form-urlencoded";
    form.event.evidence.request.properties.developmentBodyRepresentation = "redacted-form-urlencoded";
    const formText = `password=private-form&safe=1&safe=2&value=${send.token}`;
    form.event.evidence.request.body = { encoding: "base64", data: Buffer.from(formText).toString("base64"), capturedBytes: formText.length, declaredBytes: formText.length, truncated: false, unavailable: null };
    const bytes = Buffer.from([0, 255, 128, 254, 13, 10, 65]);
    const binary = hit(); binary.event.evidence.request.headers["content-type"] = "application/octet-stream";
    binary.event.evidence.request.body = { encoding: "base64", data: bytes.toString("base64"), capturedBytes: bytes.length, declaredBytes: bytes.length, truncated: false, unavailable: null };
    const capability = hit(); capability.event.evidence.request.headers["content-type"] = "application/octet-stream";
    const secretBytes = Buffer.concat([bufferView(bytes), bufferView(Buffer.from(send.token)), bufferView(bytes)]);
    capability.event.evidence.request.body = { encoding: "base64", data: secretBytes.toString("base64"), capturedBytes: secretBytes.length, declaredBytes: secretBytes.length, truncated: false, unavailable: null };
    await captureDevelopmentPixelEvents([form, binary, capability]);
    const page = await read();
    const formBody = Buffer.from(page.events.find((event) => event.eventId === form.event.eventId)!.evidence!.request.body.data, "base64").toString("utf8");
    expect(formBody).not.toContain("private-form"); expect(formBody).not.toContain(send.token);
    expect(new URLSearchParams(formBody).getAll("safe")).toEqual(["1", "2"]);
    expect(page.events.find((event) => event.eventId === binary.event.eventId)?.evidence?.request.body).toMatchObject({ data: bytes.toString("base64"), capturedBytes: bytes.length, unavailable: null });
    expect(page.events.find((event) => event.eventId === capability.event.eventId)?.evidence?.request.body.data)
      .toBe(Buffer.concat([bufferView(bytes), bufferView(Buffer.from("[REDACTED]")), bufferView(bytes)]).toString("base64"));
  });

  it("preserves ordered multipart representations while redacting credentials and file capabilities", async () => {
    const bytes = Buffer.from([255, 0, 254, 128, 10]);
    const input = hit();
    input.event.evidence.request.headers["content-type"] = "multipart/form-data; boundary=fixture";
    input.event.evidence.request.properties.developmentBodyRepresentation = "multipart-parts-json";
    const parts = [
      { name: "safe", value: "first" }, { name: "password", value: "private-multipart" },
      { name: "safe", value: "second" },
      { name: "upload", file: { name: "opaque.bin", type: "application/octet-stream", base64: bytes.toString("base64") } },
      { name: "capability", file: { name: `${send.token}.bin`, type: "application/octet-stream", base64: Buffer.concat([bufferView(bytes), bufferView(Buffer.from(send.token)), bufferView(bytes)]).toString("base64") } },
      { name: "api_key", file: { name: "private-file", type: "text/plain", base64: Buffer.from("private-multipart-file").toString("base64") } },
      { name: "referrer", value: `https://ref.example/?access_token=private-referrer&pixel=${send.token}` },
    ];
    const body = Buffer.from(JSON.stringify(parts));
    input.event.evidence.request.body = { encoding: "base64", data: body.toString("base64"), capturedBytes: body.length, declaredBytes: body.length, truncated: false, unavailable: null };
    await captureDevelopmentPixelEvents([input]);
    const evidence = (await read()).events[0]!.evidence!;
    const decoded = Buffer.from(evidence.request.body.data, "base64").toString("utf8");
    const cleaned = JSON.parse(decoded) as typeof parts;
    expect(cleaned.map((part) => part.name)).toEqual(parts.map((part) => part.name));
    expect(cleaned.filter((part) => part.name === "safe").map((part) => part.value)).toEqual(["first", "second"]);
    expect(cleaned[1]).toEqual({ name: "password", value: "[REDACTED]" });
    expect(cleaned[3]?.file?.base64).toBe(bytes.toString("base64"));
    expect(cleaned[4]?.file?.base64).toBe(Buffer.concat([bufferView(bytes), bufferView(Buffer.from("[REDACTED]")), bufferView(bytes)]).toString("base64"));
    expect(cleaned[5]).toEqual({ name: "api_key", value: "[REDACTED]" });
    for (const secret of [send.token, "private-multipart", "private-multipart-file", "private-file", "private-referrer"]) expect(decoded).not.toContain(secret);
    expect(evidence.request.properties.developmentBodyRepresentation).toBe("multipart-parts-json");
    expect(evidence.request.body.unavailable).toBeNull();
  });

  it("marks malformed or truncated structured bodies unavailable and preserves error instanceof", async () => {
    const error = new DevelopmentOpenTrackingError(400);
    expect(error).toBeInstanceOf(DevelopmentOpenTrackingError);
    expect(error.status).toBe(400);
    const malformed = hit(); malformed.event.evidence.request.headers["content-type"] = "application/json";
    malformed.event.evidence.request.properties.developmentBodyRepresentation = "redacted-json";
    malformed.event.evidence.request.body = { encoding: "base64", data: Buffer.from('{"password":"partial').toString("base64"), capturedBytes: 20, declaredBytes: null, truncated: true, unavailable: null };
    const multipart = hit(); multipart.event.evidence.request.properties.developmentBodyRepresentation = "multipart-parts-json";
    multipart.event.evidence.request.body = { encoding: "base64", data: Buffer.from('[{"name":"password"}]').toString("base64"), capturedBytes: 21, declaredBytes: null, truncated: true, unavailable: null };
    await captureDevelopmentPixelEvents([malformed, multipart]);
    for (const event of (await read()).events) expect(event.evidence?.request.body).toMatchObject({ data: "", capturedBytes: 0, unavailable: "backend:uninspectable-body" });
  });

  it("retains repeated HTTP requests but freezes transport retries and rejects UUID body conflicts", async () => {
    const first = hit(); const second = hit({ occurredAt: first.event.occurredAt });
    await captureDevelopmentPixelEvents([first, second, first]);
    const original = await raw();
    await captureDevelopmentPixelEvents([first]);
    expect(await raw()).toEqual(expect.arrayContaining(original));
    expect(await raw()).toHaveLength(2);
    const conflicting = structuredClone(first); conflicting.event.evidence.cloudflare.country = "DE";
    await expect(captureDevelopmentPixelEvents([conflicting])).rejects.toBeInstanceOf(DevelopmentOpenTrackingError);
    await expect(captureDevelopmentPixelEvents([hit({ eventId: first.event.eventId, occurredAt: first.event.occurredAt }), conflicting])).rejects.toBeInstanceOf(DevelopmentOpenTrackingError);
    expect(await raw()).toHaveLength(2);
  });

  it("fails partial delivery and converges a retry after an acknowledged-late durable CH insert", async () => {
    const client = clickhouseClient(); const insert = client.insert.bind(client);
    const input = hit();
    jest.spyOn(client, "insert").mockImplementationOnce(async (args) => { await insert(args); throw new Error("Simulated acknowledgement loss"); });
    await expect(captureDevelopmentPixelEvents([input])).rejects.toThrow("Development open tracking unavailable");
    jest.restoreAllMocks();
    await captureDevelopmentPixelEvents([input]);
    expect(await raw()).toHaveLength(1);
    expect((await read()).events).toHaveLength(1);
  });

  it("rejects invalid canonical ciphertext and unavailable CH without swallowing failure", async () => {
    await db().update(newsletterSend).set({ encryptedOpenTrackingToken: encrypt(JSON.stringify({ id: send.sendId, token: "wrong" })) }).where(eq(newsletterSend.id, send.sendId));
    await expect(captureDevelopmentPixelEvents([hit()])).rejects.toThrow("Development open tracking unavailable");
    expect(await raw()).toHaveLength(0);
    const unknown = hit({ token: randomBytes(32).toString("base64url") });
    jest.spyOn(clickhouseClient(), "insert").mockRejectedValueOnce(new Error("private bind details"));
    await expect(captureDevelopmentPixelEvents([unknown])).rejects.toThrow("Development open tracking unavailable");
  });

  it("checks verified host ownership and never borrows another tenant's canonical identity", async () => {
    const other = await createTrackingNewsletterFixture();
    const wrongWorkspace = hit(); wrongWorkspace.workspaceId = other.workspaceId;
    await expect(captureDevelopmentPixelEvents([wrongWorkspace])).rejects.toBeInstanceOf(DevelopmentOpenTrackingError);
    const foreign = hit({ hostname: other.hostname }); foreign.workspaceId = other.workspaceId;
    foreign.event.evidence.request.url = `https://${other.hostname}${send.path}`;
    await captureDevelopmentPixelEvents([foreign]);
    const page = await findDevelopmentPixelEvents({ workspaceId: other.workspaceId });
    expect(page.events[0]).toMatchObject({ status: "unmatched", userId: null, sendId: null, messageId: null });
    const badOriginal = hit(); badOriginal.event.evidence.request.url = `https://${other.hostname}${send.path}`;
    await captureDevelopmentPixelEvents([badOriginal]);
    expect((await read()).events[0]).toMatchObject({ status: "invalid", userId: null, sendId: null });
    await db().update(newsletterTrackingDomain).set({ status: "pending", verifiedAt: null }).where(eq(newsletterTrackingDomain.newsletterId, newsletter.workspaceId));
    await expect(captureDevelopmentPixelEvents([hit()])).rejects.toBeInstanceOf(DevelopmentOpenTrackingError);
  });

  it("enforces capture-only mode on direct callers while allowing historical reads after toggle-off", async () => {
    await captureDevelopmentPixelEvents([hit()]);
    await expect(captureEmailOpenRequests([{ expectedWorkspaceId: newsletter.workspaceId, expectedHostname: newsletter.hostname,
      eventId: randomUUID(), token: send.token, request: { receivedAt: new Date().toISOString(), method: "GET", path: send.path, query: {}, headers: {}, encrypted: true } }])).rejects.toThrow();
    config().enableOpenTrackingDevLake = false;
    await expect(captureDevelopmentPixelEvents([hit()])).rejects.toThrow();
    expect((await read()).events).toHaveLength(1);
    config().enableOpenTrackingDevLake = true; config().enableOpenTracking = false;
    await expect(captureDevelopmentPixelEvents([hit()])).rejects.toThrow();
  });

  it("uses configurable TTL and excludes expired evidence at read time before TTL merges", async () => {
    expect(CREATE_DEVELOPMENT_OPEN_PIXEL_EVENT_TABLE_QUERY).toContain("TTL toDateTime(rawExpiresAt)");
    expect(CREATE_DEVELOPMENT_OPEN_PIXEL_EVENT_TABLE_QUERY).toContain("TTL toDateTime(rawExpiresAt) + INTERVAL 1 DAY");
    expect(CREATE_DEVELOPMENT_OPEN_PIXEL_EVENT_TABLE_QUERY).toContain("ORDER BY (workspaceId, occurredAt, eventId)");
    const old = hit({ occurredAt: new Date(Date.now() - 2 * DAY).toISOString() });
    const recent = hit();
    await captureDevelopmentPixelEvents([old, recent]);
    config().openTrackingRetentionDays = 1;
    expect((await read()).events.map((event) => event.eventId)).toEqual([recent.event.eventId]);
    await captureDevelopmentPixelEvents([hit({ occurredAt: old.event.occurredAt })]);
    expect(await raw()).toHaveLength(2);
    await clickhouseClient().command({ query: `ALTER TABLE ${DEVELOPMENT_PIXEL_TABLE} UPDATE rawExpiresAt = now64(3) - INTERVAL 1 SECOND WHERE workspaceId = {workspaceId:String} AND eventId = {eventId:UUID}`,
      query_params: { workspaceId: newsletter.workspaceId, eventId: recent.event.eventId }, clickhouse_settings: { mutations_sync: "2", wait_end_of_query: 1 } });
    expect((await read()).events).toHaveLength(0);
  });

  it("scopes every read and cursor to workspace, contact, message and event", async () => {
    await captureDevelopmentPixelEvents([hit(), hit(), hit()]);
    const first = await read({ limit: 1, userId: send.userId, messageId: send.messageId });
    expect(first.events).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const second = await read({ limit: 1, userId: send.userId, messageId: send.messageId, before: first.nextCursor });
    expect(second.events).toHaveLength(1); expect(second.events[0]?.eventId).not.toBe(first.events[0]?.eventId);
    expect((await read({ userId: "other" })).events).toHaveLength(0);
    expect((await read({ messageId: "other" })).events).toHaveLength(0);
    expect((await read({ eventId: randomUUID() })).events).toHaveLength(0);
    expect((await findDevelopmentPixelEvents({ workspaceId: randomUUID() })).events).toHaveLength(0);
    await expect(read({ before: "not-a-cursor" })).rejects.toMatchObject({ status: 400 });
    await expect(read({ before: first.nextCursor })).rejects.toMatchObject({ status: 400 });
    await expect(findDevelopmentPixelEvents({ workspaceId: randomUUID(), userId: send.userId, messageId: send.messageId, before: first.nextCursor })).rejects.toMatchObject({ status: 400 });
  });

  it("authenticates ciphertext correlation instead of accepting evidence moved between rows", async () => {
    const first = hit(); const second = hit(); await captureDevelopmentPixelEvents([first, second]);
    const rows = await raw(); const ciphertext = rows.find((row) => row.eventId === first.event.eventId)!.encryptedEvidence;
    await clickhouseClient().command({ query: `ALTER TABLE ${DEVELOPMENT_PIXEL_TABLE} UPDATE encryptedEvidence = {ciphertext:String} WHERE workspaceId = {workspaceId:String} AND eventId = {eventId:UUID}`,
      query_params: { workspaceId: newsletter.workspaceId, eventId: second.event.eventId, ciphertext }, clickhouse_settings: { mutations_sync: "2", wait_end_of_query: 1 } });
    await expect(read({ eventId: second.event.eventId })).rejects.toBeInstanceOf(DevelopmentOpenTrackingError);
  });

  it.each([
    { direct: false, wholeWorkspace: false }, { direct: true, wholeWorkspace: false },
    { direct: false, wholeWorkspace: true }, { direct: true, wholeWorkspace: true },
  ])("erases cross-host unmatched receipts and bars late tokens: %j", async ({ direct, wholeWorkspace }) => {
    const other = await createTrackingNewsletterFixture();
    const matching = hit(); const foreign = hit({ hostname: other.hostname }); foreign.workspaceId = other.workspaceId;
    foreign.event.evidence.request.url = `https://${other.hostname}${send.path}`;
    await captureDevelopmentPixelEvents([matching, foreign]);
    const scope = { workspaceId: newsletter.workspaceId, ...(wholeWorkspace ? {} : { userIds: [send.userId] }) };
    if (direct) await deleteNewsletterDeliveryData(scope);
    else await deleteEmailOpenData(scope);
    expect(await raw()).toHaveLength(0); expect(await raw(other.workspaceId)).toHaveLength(0);
    await captureDevelopmentPixelEvents([matching, foreign, { ...foreign, event: { ...foreign.event, eventId: randomUUID() } }]);
    expect(await raw()).toHaveLength(0); expect(await raw(other.workspaceId)).toHaveLength(0);
    const unknown = hit({ token: randomBytes(32).toString("base64url") });
    await captureDevelopmentPixelEvents([unknown]);
    expect((await read()).events).toHaveLength(1);
    const [mapping] = await db().select().from(newsletterSend).where(eq(newsletterSend.id, send.sendId));
    expect(mapping?.openTrackingTokenHash).toBeNull();
    expect(await db().select().from(newsletterErasure).where(eq(newsletterErasure.workspaceId, newsletter.workspaceId))).toHaveLength(2);
  });

  it("whole-workspace deletion removes unmatched/malformed receipts but not other newsletters", async () => {
    const other = await createTrackingNewsletterFixture(); const foreign = hit({ hostname: other.hostname, token: null }); foreign.workspaceId = other.workspaceId;
    foreign.event.evidence.request.url = `https://${other.hostname}/api/public/email/open/not-valid.gif`;
    await captureDevelopmentPixelEvents([hit(), hit({ token: null }), hit({ token: randomBytes(32).toString("base64url") }), foreign]);
    await deleteEmailOpenData({ workspaceId: newsletter.workspaceId });
    expect(await raw()).toHaveLength(0); expect(await raw(other.workspaceId)).toHaveLength(1);
  });

  it("does not clear canonical hashes or commit barriers when synchronous CH erasure fails", async () => {
    const input = hit(); await captureDevelopmentPixelEvents([input]);
    jest.spyOn(clickhouseClient(), "command").mockRejectedValueOnce(new Error("Simulated mutation failure"));
    await expect(deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [send.userId] })).rejects.toThrow();
    const [mapping] = await db().select().from(newsletterSend).where(eq(newsletterSend.id, send.sendId));
    expect(mapping?.openTrackingTokenHash).toBeTruthy();
    expect(await db().select().from(newsletterErasure).where(eq(newsletterErasure.workspaceId, newsletter.workspaceId))).toHaveLength(0);
    await deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [send.userId] });
    await captureDevelopmentPixelEvents([input]);
    expect((await read()).events).toHaveLength(0);
  });

  it("serializes an in-flight foreign-host capture before canonical contact erasure", async () => {
    const client = clickhouseClient(); const insert = client.insert.bind(client);
    const signals = new EventEmitter();
    const inserted = once(signals, "inserted"); const gate = once(signals, "release");
    jest.spyOn(client, "insert").mockImplementationOnce(async (args) => { signals.emit("inserted"); await gate; return insert(args); });
    const other = await createTrackingNewsletterFixture();
    const input = hit({ hostname: other.hostname }); input.workspaceId = other.workspaceId;
    input.event.evidence.request.url = `https://${other.hostname}${send.path}`;
    const capture = captureDevelopmentPixelEvents([input]);
    await inserted;
    const erasure = deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [send.userId] });
    try { await waitForGlobalLock("ExclusiveLock"); } finally { signals.emit("release"); }
    await capture; await erasure;
    await captureDevelopmentPixelEvents([input]);
    expect((await findDevelopmentPixelEvents({ workspaceId: other.workspaceId })).events).toHaveLength(0);
  });

  it("blocks readers and queued captures behind erasure, then prevents resurrection", async () => {
    const input = hit(); await captureDevelopmentPixelEvents([input]);
    const client = clickhouseClient(); const command = client.command.bind(client);
    const signals = new EventEmitter();
    const deleting = once(signals, "deleting"); const gate = once(signals, "release");
    jest.spyOn(client, "command").mockImplementationOnce(async (args) => { signals.emit("deleting"); await gate; return command(args); });
    const erasure = deleteEmailOpenData({ workspaceId: newsletter.workspaceId, userIds: [send.userId] });
    await deleting;
    const capture = captureDevelopmentPixelEvents([input]); const reader = read();
    try { await waitForGlobalLock("ShareLock"); } finally { signals.emit("release"); }
    await erasure; await capture;
    expect((await reader).events).toHaveLength(0); expect(await raw()).toHaveLength(0);
  });
});

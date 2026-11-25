import * as batch from "backend-lib/src/apps/batch";
import config, { Config } from "backend-lib/src/config";
import { db } from "backend-lib/src/db";
import { newsletterSend } from "backend-lib/src/db/publisherSchema";
import { getDeliveryOpens } from "backend-lib/src/deliveries";
import * as tracking from "backend-lib/src/messaging/openTracking";
import * as events from "backend-lib/src/messaging/openTrackingEvents";
import * as domains from "backend-lib/src/newsletterTracking";
import { DittofeedFastifyInstance } from "backend-lib/src/types";
import {
  createTrackedSendFixture,
  createTrackingNewsletterFixture,
  TrackedSendFixture,
  TrackingNewsletterFixture,
} from "backend-lib/test/openTrackingFixture";
import { createHmac, randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import Fastify from "fastify";

import {
  buildFastifyAppOpts,
  configureOpenTrackingRequestLogging,
} from "../buildApp";
import openTrackingController, {
  QueuedOpenEvent,
} from "./openTrackingController";

const batchPath = "/api/public/email/open/batch";
const relaySecret = Buffer.alloc(32, 19).toString("base64");
const browser = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

describe("queued open HTTP capture into ClickHouse", () => {
  let app: DittofeedFastifyInstance | undefined;
  let logs: string[];
  let fixture: TrackingNewsletterFixture;
  let send: TrackedSendFixture;
  let original: Pick<Config, "enableOpenTracking" | "openTrackingRelaySecret" | "openTrackingRetentionDays">;

  beforeEach(async () => {
    original = {
      enableOpenTracking: config().enableOpenTracking,
      openTrackingRelaySecret: config().openTrackingRelaySecret,
      openTrackingRetentionDays: config().openTrackingRetentionDays,
    };
    Object.assign(config(), {
      enableOpenTracking: true, openTrackingRelaySecret: relaySecret,
      openTrackingRetentionDays: 30,
    });
    fixture = await createTrackingNewsletterFixture();
    send = await createTrackedSendFixture(fixture);
    logs = [];
    app = Fastify({
      ...buildFastifyAppOpts(),
      logger: { level: "info", stream: { write(line: string) { logs.push(line); } } },
    });
    configureOpenTrackingRequestLogging(app);
    await app.register(openTrackingController, { prefix: "/api/public" });
    await app.ready();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
    Object.assign(config(), original);
  });

  function event(overrides: Partial<QueuedOpenEvent> = {}): QueuedOpenEvent {
    return {
      v: 2, eventId: randomUUID(), hostname: fixture.hostname, token: send.token,
      method: "GET", query: { cb: "42" },
      headers: { "user-agent": browser, authorization: "do-not-store", cookie: "do-not-store" },
      edge: {
        receivedAt: new Date(Date.now() - 60_000).toISOString(),
        remoteAddress: "192.0.2.8", asOrganization: "Fixture residential network",
        asn: 64500, country: "US", httpVersion: "HTTP/2", tlsVersion: "TLSv1.3",
        networkSetVersion: null,
      },
      ...overrides,
    };
  }

  function signature(raw: string, timestamp = String(Math.floor(Date.now() / 1000))) {
    const key = Buffer.from(relaySecret, "base64");
    return {
      "content-type": "application/json",
      "x-df-tracking-timestamp": timestamp,
      "x-df-tracking-signature": createHmac("sha256",
        new Uint8Array(key.buffer, key.byteOffset, key.byteLength))
        .update(`${timestamp}.${raw}`).digest("hex"),
    };
  }

  async function rawPost(raw: string, headers = signature(raw)) {
    if (!app) throw new Error("Capture test server unavailable");
    return app.inject({ method: "POST", url: batchPath, headers, payload: raw });
  }

  async function post(items: QueuedOpenEvent[]) {
    return rawPost(JSON.stringify({ v: 2, events: items }));
  }

  async function history() {
    return getDeliveryOpens({ workspaceId: fixture.workspaceId, userId: send.userId, messageId: send.messageId });
  }

  async function classified() {
    return events.findEmailOpenTrackingEvents({ workspaceId: fixture.workspaceId, messageId: send.messageId });
  }

  it("records every GET/HEAD load in ClickHouse, keeps duplicate loads, and does not change the send row", async () => {
    const [before] = await db().select().from(newsletterSend).where(eq(newsletterSend.id, send.sendId));
    const get = event();
    const head = event({ method: "HEAD", edge: get.edge });
    const repeat = event({ edge: { ...get.edge, receivedAt: new Date(Date.parse(get.edge.receivedAt) + 1000).toISOString() } });
    expect((await post([get, head, repeat])).statusCode).toBe(204);
    expect((await post([get, head, repeat])).statusCode).toBe(204);
    const rows = await classified();
    expect(rows.map((row) => row.eventId).sort()).toEqual([get.eventId, head.eventId, repeat.eventId].sort());
    expect(rows.find((row) => row.eventId === repeat.eventId)).toMatchObject({ class: "human", counted: false });
    expect(rows.find((row) => row.eventId === head.eventId)).toMatchObject({ method: "HEAD", counted: false });
    expect((await history()).openCount).toBe(2);
    expect(await db().select().from(newsletterSend).where(eq(newsletterSend.id, send.sendId))).toEqual([before]);
    const evidence = await tracking.getEmailOpenEvidence({
      workspaceId: fixture.workspaceId, userId: send.userId,
      messageId: send.messageId, evidenceId: get.eventId,
    });
    expect(evidence).toMatchObject({ request: {
      method: "GET", headers: { "user-agent": browser },
      edgeObserved: { remoteAddress: "192.0.2.8", asn: 64500, country: "US", networkSetVersion: null },
    } });
    expect(JSON.stringify(evidence)).not.toContain("do-not-store");
    expect(JSON.stringify(evidence)).not.toContain(send.token);
    expect(logs.join("\n")).not.toContain(send.token);
  });

  it("retains scanner observations even though they do not count as human-like engagement", async () => {
    const scanner = event({ headers: { "user-agent": "Proofpoint URL Scanner/1.0" } });
    expect((await post([scanner])).statusCode).toBe(204);
    expect(await classified()).toEqual([expect.objectContaining({
      eventId: scanner.eventId, class: "scanner", counted: false, method: "GET",
    })]);
    expect((await history()).openCount).toBe(1);
  });

  it("authenticates batches above the obsolete single-relay body limit", async () => {
    const first = event();
    const items = Array.from({ length: 8 }, () => ({
      ...first, eventId: randomUUID(),
      headers: { "user-agent": browser, accept: "x".repeat(512),
        "accept-language": "x".repeat(512), "cache-control": "x".repeat(512), pragma: "x".repeat(512) },
    }));
    expect(Buffer.byteLength(JSON.stringify({ v: 2, events: items }))).toBeGreaterThan(16_384);
    expect((await post(items)).statusCode).toBe(204);
    expect((await classified()).map((row) => row.eventId).sort()).toEqual(items.map((item) => item.eventId).sort());
    expect((await history()).openCount).toBe(8);
  });

  it("rejects missing, stale and body-modified signatures before hostname lookup", async () => {
    const lookup = jest.spyOn(domains, "getTrackingHostnameNewsletter");
    const raw = JSON.stringify({ v: 2, events: [event()] });
    await Promise.all([
      { "content-type": "application/json" },
      signature(raw, String(Math.floor(Date.now() / 1000) - 301)),
      signature(`${raw} `),
    ].map(async (headers) => {
      if (!app) throw new Error("Capture test server unavailable");
      expect((await app.inject({ method: "POST", url: batchPath, headers, payload: raw })).statusCode).toBe(403);
    }));
    expect(lookup).not.toHaveBeenCalled();
    expect(await classified()).toEqual([]);
  });

  it("bounds batch shape and refuses unknown hostname ownership", async () => {
    expect((await post([])).statusCode).toBe(400);
    expect((await post(Array.from({ length: 51 }, () => event()))).statusCode).toBe(400);
    expect((await post([event({ hostname: "dt.unowned.example" })])).statusCode).toBe(403);
    expect(await classified()).toEqual([]);
  });

  it("cannot assign a real token to another newsletter or branded host", async () => {
    const sibling = await createTrackingNewsletterFixture();
    expect((await post([event({ hostname: sibling.hostname })])).statusCode).toBe(204);
    jest.spyOn(domains, "getTrackingHostnameNewsletter").mockResolvedValue(sibling.workspaceId);
    expect((await post([event()])).statusCode).toBe(204);
    expect(await classified()).toEqual([]);
    expect((await history()).openCount).toBe(0);
  });

  it("drops unknown and erased tokens without recreating event history", async () => {
    expect((await post([event({ token: "A".repeat(43) })])).statusCode).toBe(204);
    const hit = event();
    expect((await post([hit])).statusCode).toBe(204);
    await tracking.deleteEmailOpenData({ workspaceId: fixture.workspaceId, userIds: [send.userId] });
    expect((await post([hit, event()])).statusCode).toBe(204);
    expect(await classified()).toEqual([]);
    expect(await tracking.getEmailOpenEvidence({
      workspaceId: fixture.workspaceId, userId: send.userId,
      messageId: send.messageId, evidenceId: hit.eventId,
    })).toBeNull();
  });

  it("requires retry when ClickHouse cannot persist and never reflects private failure details", async () => {
    const hit = event();
    const storage = jest.spyOn(events, "insertEmailOpenTrackingEvents")
      .mockRejectedValueOnce(new Error("private-capture-failure"));
    const failed = await post([hit]);
    expect(failed.statusCode).toBe(503);
    expect(failed.payload).toBe("");
    expect(await classified()).toEqual([]);
    storage.mockRestore();
    expect((await post([hit])).statusCode).toBe(204);
    expect(await classified()).toEqual([expect.objectContaining({ eventId: hit.eventId })]);
    expect(logs.join("\n")).not.toContain("private-capture-failure");
  });

  it("recovers when classification was saved but native projection failed, without duplicating either history", async () => {
    const hit = event();
    const projection = jest.spyOn(batch, "submitBatch")
      .mockRejectedValueOnce(new Error("private-projection-failure"));
    expect((await post([hit])).statusCode).toBe(503);
    expect(await classified()).toEqual([expect.objectContaining({ eventId: hit.eventId })]);
    expect((await history()).openCount).toBe(0);
    projection.mockRestore();
    expect((await post([hit])).statusCode).toBe(204);
    expect((await post([hit])).statusCode).toBe(204);
    expect(await classified()).toEqual([expect.objectContaining({ eventId: hit.eventId })]);
    expect((await history()).openCount).toBe(1);
    expect(logs.join("\n")).not.toContain("private-projection-failure");
  });

  it("fails closed when capture is disabled and exposes no unsigned backend pixel or v1 relay bypass", async () => {
    if (!app) throw new Error("Capture test server unavailable");
    expect((await app.inject({ method: "GET", url: send.path })).statusCode).toBe(404);
    expect((await app.inject({ method: "HEAD", url: send.path })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/public/email/open/relay", payload: {} })).statusCode).toBe(404);
    config().enableOpenTracking = false;
    expect((await post([event()])).statusCode).toBe(503);
    expect(await classified()).toEqual([]);
    expect(logs.join("\n")).not.toContain(send.token);
  });
});

import * as batch from "backend-lib/src/apps/batch";
import config, { Config } from "backend-lib/src/config";
import { db } from "backend-lib/src/db";
import { newsletterSend } from "backend-lib/src/db/publisherSchema";
import { getDeliveryOpens } from "backend-lib/src/deliveries";
import { installNewsletterSecretFixture } from "backend-lib/test/newsletterSecretFixture";
import * as development from "backend-lib/src/messaging/developmentOpenTracking";
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
  DEVELOPMENT_PIXEL_BATCH_PATH,
  DEVELOPMENT_PIXEL_EVENT_BYTES,
  DevelopmentPixelEvent,
} from "isomorphic-lib/src/tracking/development";

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
  let restoreSecret: () => void;
  let original: Pick<Config, "enableOpenTracking" | "enableOpenTrackingDevLake" | "openTrackingRelaySecret" | "openTrackingRetentionDays">;

  beforeEach(async () => {
    restoreSecret = installNewsletterSecretFixture();
    original = {
      enableOpenTracking: config().enableOpenTracking,
      enableOpenTrackingDevLake: config().enableOpenTrackingDevLake,
      openTrackingRelaySecret: config().openTrackingRelaySecret,
      openTrackingRetentionDays: config().openTrackingRetentionDays,
    };
    Object.assign(config(), {
      enableOpenTracking: true, enableOpenTrackingDevLake: false,
      openTrackingRelaySecret: relaySecret,
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
    restoreSecret();
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

  describe("isolated development pixel collection", () => {
    beforeEach(() => {
      config().enableOpenTrackingDevLake = true;
    });

    function developmentEvent(overrides: Partial<DevelopmentPixelEvent> = {}): DevelopmentPixelEvent {
      return {
        v: 3, eventId: randomUUID(), hostname: fixture.hostname, token: send.token,
        occurredAt: new Date(Date.now() - 1000).toISOString(),
        evidence: {
          request: {
            url: `https://${fixture.hostname}/o/[redacted]?experiment=one&experiment=two`,
            method: "GET",
            headers: { "user-agent": browser, "x-unusual-evidence": "retained", authorization: "private-header" },
            properties: { redirect: "manual", cf: { nested: [1, "two", true] } },
            body: {
              encoding: "base64", data: "", capturedBytes: 0,
              declaredBytes: null, truncated: false, unavailable: null,
            },
          },
          cloudflare: { colo: "SJC", tlsClientExtensionsSha1: "extension-hash",
            botManagement: { score: 7, verifiedBot: true }, arbitraryFutureField: ["a", { b: 2 }] },
          response: { status: 200, headers: { "content-type": "image/gif" } },
          network: { setVersion: "fixture-v1", match: null },
          redactions: [], truncations: [], unavailable: [],
        },
        ...overrides,
      };
    }

    async function developmentPost(items: DevelopmentPixelEvent[]) {
      const raw = JSON.stringify({ v: 3, events: items });
      if (!app) throw new Error("Capture test server unavailable");
      return app.inject({
        method: "POST", url: DEVELOPMENT_PIXEL_BATCH_PATH,
        headers: signature(raw), payload: raw,
      });
    }

    async function developmentRows() {
      return (await development.findDevelopmentPixelEvents({ workspaceId: fixture.workspaceId })).events;
    }

    async function expectNoNativeOpens() {
      expect(await classified()).toEqual([]);
      expect((await history()).openCount).toBe(0);
    }

    it("retains broad evidence for every GET, HEAD, bot and unsupported method without native side effects", async () => {
      const native = jest.spyOn(batch, "submitBatch");
      const normal = jest.spyOn(tracking, "captureEmailOpenRequests");
      const [before] = await db().select().from(newsletterSend).where(eq(newsletterSend.id, send.sendId));
      const get = developmentEvent();
      const head = developmentEvent({ evidence: { ...get.evidence,
        request: { ...get.evidence.request, method: "HEAD" } } });
      const scanner = developmentEvent({ evidence: { ...get.evidence,
        request: { ...get.evidence.request, headers: { "user-agent": "Proofpoint URL Scanner/1.0" } } } });
      const unsupported = developmentEvent({ evidence: { ...get.evidence,
        request: { ...get.evidence.request, method: "POST" },
        response: { status: 405, headers: { allow: "GET, HEAD" } } } });
      expect((await developmentPost([get, head, scanner, unsupported])).statusCode).toBe(204);
      expect((await developmentPost([get, head, scanner, unsupported])).statusCode).toBe(204);
      const rows = await developmentRows();
      expect(rows.map((row) => row.eventId).sort()).toEqual([get, head, scanner, unsupported].map((item) => item.eventId).sort());
      expect(rows.find((row) => row.eventId === get.eventId)).toMatchObject({
        status: "matched", userId: send.userId, messageId: send.messageId,
        evidence: {
          request: {
            url: get.evidence.request.url,
            headers: { "x-unusual-evidence": "retained" },
            properties: get.evidence.request.properties,
          },
          cloudflare: get.evidence.cloudflare,
        },
      });
      expect(rows.find((row) => row.eventId === unsupported.eventId)).toMatchObject({ method: "POST", evidence: { response: { status: 405 } } });
      expect(JSON.stringify(rows)).not.toContain("private-header");
      expect(JSON.stringify(rows)).not.toContain(send.token);
      expect(await db().select().from(newsletterSend).where(eq(newsletterSend.id, send.sendId))).toEqual([before]);
      expect(native).not.toHaveBeenCalled();
      expect(normal).not.toHaveBeenCalled();
      await expectNoNativeOpens();
      expect(logs.join("\n")).not.toContain(send.token);
    });

    it("retains unknown and malformed-token observations only within verified host ownership", async () => {
      const unknown = developmentEvent({ token: "A".repeat(43) });
      const malformed = developmentEvent({ token: null, evidence: {
        ...unknown.evidence, response: { status: 404, headers: {} },
      } });
      expect((await developmentPost([unknown, malformed])).statusCode).toBe(204);
      const rows = await developmentRows();
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.eventId === unknown.eventId)).toMatchObject({ status: "unmatched", userId: null, messageId: null, sendId: null });
      expect(rows.find((row) => row.eventId === malformed.eventId)).toMatchObject({ status: "invalid", userId: null, messageId: null, sendId: null });
      const valid = developmentEvent();
      expect((await developmentPost([valid, developmentEvent({ hostname: "dt.unowned.example" })])).statusCode).toBe(403);
      expect((await developmentRows()).map((row) => row.eventId).sort()).toEqual([unknown.eventId, malformed.eventId].sort());
      await expectNoNativeOpens();
    });

    it("prevents a real token from crossing newsletter and original-host boundaries", async () => {
      const sibling = await createTrackingNewsletterFixture();
      const base = developmentEvent();
      const hit = { ...base, hostname: sibling.hostname, evidence: {
        ...base.evidence,
        request: { ...base.evidence.request, url: `https://${sibling.hostname}/o/[redacted]` },
      } };
      expect((await developmentPost([hit])).statusCode).toBe(204);
      expect(await developmentRows()).toEqual([]);
      const siblingRows = (await development.findDevelopmentPixelEvents({ workspaceId: sibling.workspaceId })).events;
      expect(siblingRows).toEqual([expect.objectContaining({
        eventId: hit.eventId, userId: null, messageId: null, sendId: null,
      })]);
      const forgedOrigin = developmentEvent({ evidence: hit.evidence });
      expect((await developmentPost([forgedOrigin])).statusCode).toBe(204);
      expect(await developmentRows()).toEqual([expect.objectContaining({
        eventId: forgedOrigin.eventId, status: "invalid",
        userId: null, messageId: null, sendId: null,
      })]);
      await expectNoNativeOpens();
    });

    it("verifies the exact signed bytes before resolving hosts and keeps rejected evidence private", async () => {
      if (!app) throw new Error("Capture test server unavailable");
      const lookup = jest.spyOn(domains, "getTrackingHostnameNewsletter");
      const raw = JSON.stringify({ v: 3, events: [developmentEvent()] });
      for (const headers of [
        { "content-type": "application/json" },
        signature(raw, String(Math.floor(Date.now() / 1000) - 301)),
        signature(`${raw} `),
      ]) {
        // eslint-disable-next-line no-await-in-loop -- Independently assert each rejected signature.
        const result = await app.inject({ method: "POST", url: DEVELOPMENT_PIXEL_BATCH_PATH, headers, payload: raw });
        expect(result.statusCode).toBe(403);
        expect(result.payload).toBe("");
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(await developmentRows()).toEqual([]);
      expect(logs.join("\n")).not.toContain("private-header");
    });

    it("silences malformed JSON and invalid v3 envelopes without reflecting request evidence", async () => {
      if (!app) throw new Error("Capture test server unavailable");
      const capture = jest.spyOn(development, "captureDevelopmentPixelEvents");
      const invalid = [
        '{"private-development-malformed":',
        JSON.stringify({ v: 3, events: [{ ...developmentEvent(), token: "malformed-private-token" }] }),
        JSON.stringify({ v: 2, events: [developmentEvent()] }),
      ];
      for (const raw of invalid) {
        // eslint-disable-next-line no-await-in-loop -- Verify the private error contract for every malformed envelope.
        const response = await app.inject({
          method: "POST", url: DEVELOPMENT_PIXEL_BATCH_PATH,
          headers: signature(raw), payload: raw,
        });
        expect(response.statusCode).toBe(400);
        expect(response.payload).toBe("");
      }
      expect(capture).not.toHaveBeenCalled();
      expect(await developmentRows()).toEqual([]);
      expect(logs.join("\n")).not.toContain("private-development-malformed");
      expect(logs.join("\n")).not.toContain("malformed-private-token");
    });

    it("enforces item count, UTF-8 event bytes and the total batch limit before persistence", async () => {
      expect((await developmentPost([])).statusCode).toBe(400);
      expect((await developmentPost(Array.from({ length: 51 }, () => developmentEvent()))).statusCode).toBe(400);
      const large = developmentEvent();
      large.evidence.cloudflare.padding = "é".repeat(DEVELOPMENT_PIXEL_EVENT_BYTES / 2);
      expect((await developmentPost([large])).statusCode).toBe(413);
      const items = Array.from({ length: 12 }, () => {
        const item = developmentEvent();
        item.evidence.cloudflare.padding = "x".repeat(95_000);
        return item;
      });
      expect((await developmentPost(items)).statusCode).toBe(413);
      expect(await developmentRows()).toEqual([]);
      await expectNoNativeOpens();
    });

    it("fails partial persistence privately and retries stable IDs without duplicate or conflicting evidence", async () => {
      const first = developmentEvent();
      const second = developmentEvent();
      const capture = development.captureDevelopmentPixelEvents;
      const storage = jest.spyOn(development, "captureDevelopmentPixelEvents")
        .mockImplementationOnce(async (inputs) => {
          await capture(inputs.slice(0, 1));
          throw new Error("private-development-storage-failure");
        });
      const failed = await developmentPost([first, second]);
      expect(failed.statusCode).toBe(503);
      expect(failed.payload).toBe("");
      expect((await developmentRows()).map((row) => row.eventId)).toEqual([first.eventId]);
      storage.mockRestore();
      expect((await developmentPost([first, second])).statusCode).toBe(204);
      expect((await developmentPost([first, second])).statusCode).toBe(204);
      expect((await developmentRows()).map((row) => row.eventId).sort()).toEqual([first.eventId, second.eventId].sort());
      const conflicting = { ...first, evidence: { ...first.evidence, cloudflare: { changed: true } } };
      expect((await developmentPost([conflicting])).statusCode).toBe(503);
      expect((await developmentRows()).find((row) => row.eventId === first.eventId)?.evidence?.cloudflare).toEqual(first.evidence.cloudflare);
      expect(logs.join("\n")).not.toContain("private-development-storage-failure");
      await expectNoNativeOpens();
    });

    it("requires both flags and rejects wrong-mode queues before invoking either pipeline", async () => {
      const normal = jest.spyOn(tracking, "captureEmailOpenRequests");
      const capture = jest.spyOn(development, "captureDevelopmentPixelEvents");
      expect((await post([event()])).statusCode).toBe(503);
      config().enableOpenTracking = false;
      expect((await developmentPost([developmentEvent()])).statusCode).toBe(503);
      config().enableOpenTracking = true;
      config().enableOpenTrackingDevLake = false;
      expect((await developmentPost([developmentEvent()])).statusCode).toBe(503);
      config().enableOpenTrackingDevLake = true;
      config().openTrackingRelaySecret = "";
      expect((await developmentPost([developmentEvent()])).statusCode).toBe(503);
      expect(normal).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      await expectNoNativeOpens();
    });
  });
});

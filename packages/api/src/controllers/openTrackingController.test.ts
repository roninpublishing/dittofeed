import config from "backend-lib/src/config";
import { db } from "backend-lib/src/db";
import { workspace } from "backend-lib/src/db/schema";
import { getDeliveryOpens } from "backend-lib/src/deliveries";
import * as tracking from "backend-lib/src/messaging/openTracking";
import * as domains from "backend-lib/src/newsletterTracking";
import { DittofeedFastifyInstance } from "backend-lib/src/types";
import { createHmac, randomUUID } from "crypto";
import Fastify from "fastify";

import {
  buildFastifyAppOpts,
  configureOpenTrackingRequestLogging,
} from "../buildApp";
import openTrackingController, {
  QueuedOpenEvent,
} from "./openTrackingController";

let app: DittofeedFastifyInstance;
let logs: string[];
let originalEnabled: boolean;
let originalBase: string | undefined;
let originalRelaySecret: string | undefined;
let workspaceId: string;
let messageId: string;
const userId = "pixel-test-contact";

async function pixelPath() {
  const html = await tracking.prepareEmailOpenTracking({
    workspaceId,
    userId,
    messageId,
    html: "<html><body>Email</body></html>",
  });
  const match = html.match(
    /http:\/\/localhost:3000(\/api\/public\/email\/open\/[A-Za-z0-9_-]{43}\.gif)/,
  );
  if (!match?.[1])
    throw new Error("Tracking image missing from transport HTML");
  return match[1];
}

describe("owned open HTTP evidence", () => {
  beforeEach(async () => {
    originalEnabled = config().enableOpenTracking;
    originalBase = config().openTrackingBaseUrl;
    config().enableOpenTracking = true;
    originalRelaySecret = config().openTrackingRelaySecret;
    config().openTrackingBaseUrl = "http://localhost:3000";
    workspaceId = randomUUID();
    messageId = randomUUID();
    await db()
      .insert(workspace)
      .values({ id: workspaceId, name: `Pixel HTTP tests ${workspaceId}` });
    logs = [];
    app = Fastify({
      ...buildFastifyAppOpts(),
      logger: {
        level: "info",
        stream: {
          write(line: string) {
            logs.push(line);
          },
        },
      },
    });
    configureOpenTrackingRequestLogging(app);
    await app.register(openTrackingController, { prefix: "/api/public" });
    await app.ready();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- beforeEach can fail before constructing the app.
    await app?.close();
    config().enableOpenTracking = originalEnabled;
    config().openTrackingBaseUrl = originalBase;
    config().openTrackingRelaySecret = originalRelaySecret;
  });

  it("captures GET but not HEAD as an observed open, without storing request credentials", async () => {
    const path = await pixelPath();
    const head = await app.inject({ method: "HEAD", url: path });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.byteLength).toBe(0);
    const get = await app.inject({
      method: "GET",
      url: `${path}?cb=42&secret=do-not-store`,
      headers: {
        "user-agent": "Apple privacy proxy test",
        "x-forwarded-for": "192.0.2.55",
        authorization: "Bearer do-not-store",
        cookie: "session=do-not-store",
      },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toContain("image/gif");
    expect(get.headers["cache-control"]).toContain("no-store");
    expect(get.rawPayload.subarray(0, 6).toString()).toBe("GIF89a");
    await tracking.drainEmailOpenEvents();
    const history = await getDeliveryOpens({ workspaceId, userId, messageId });
    expect(history.openCount).toBe(1);
    expect(history.items[0]).toMatchObject({
      evidenceSource: "owned_pixel",
      classification: "observed_unqualified",
    });
    const evidenceId = history.items[0]?.evidenceId;
    if (!evidenceId) throw new Error("Durable request evidence missing");
    const evidence = await tracking.getEmailOpenEvidence({
      workspaceId,
      userId,
      messageId,
      evidenceId,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).toContain("Apple privacy proxy test");
    expect(serialized).toContain("192.0.2.55");
    expect(serialized).not.toContain("do-not-store");
    expect(serialized).not.toContain(path);
    expect(logs.join("\n")).not.toContain(path);
  });

  it("serves the same image for unknown and erased tokens without recreating erased history", async () => {
    const path = await pixelPath();
    const unknown = await app.inject({
      method: "GET",
      url: path.replace(/[^/]+\.gif$/, `${"a".repeat(43)}.gif`),
    });
    await tracking.deleteEmailOpenData({ workspaceId, userIds: [userId] });
    const erased = await app.inject({ method: "GET", url: path });
    expect(erased.statusCode).toBe(200);
    expect(erased.rawPayload).toEqual(unknown.rawPayload);
    await tracking.drainEmailOpenEvents();
    expect(
      (await getDeliveryOpens({ workspaceId, userId, messageId })).openCount,
    ).toBe(0);
  });

  it("returns retryable failure when durability fails and never logs even unmatched pixel URLs", async () => {
    const path = await pixelPath();
    jest
      .spyOn(tracking, "captureEmailOpenRequest")
      .mockRejectedValueOnce(new Error("private-capture-context"));
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(
      503,
    );
    expect(
      (await app.inject({ method: "POST", url: `${path}?secret=do-not-log` }))
        .statusCode,
    ).toBe(404);
    const output = logs.join("\n");
    expect(output).not.toContain(path);
    expect(output).not.toContain("do-not-log");
    expect(output).not.toContain("private-capture-context");
  });

  describe("Cloudflare edge relay", () => {
    const relayPath = "/api/public/email/open/relay";
    const relaySecret = Buffer.alloc(32, 19).toString("base64");
    const hostname = "dt.newsletter.example";

    async function relayPayload() {
      config().openTrackingRelaySecret = relaySecret;
      config().openTrackingBaseUrl = `https://${hostname}`;
      const html = await tracking.prepareEmailOpenTracking({
        workspaceId,
        userId,
        messageId,
        html: "<p>Fixture only, never sent.</p>",
      });
      const match = /\/api\/public\/email\/open\/([A-Za-z0-9_-]{43})\.gif/.exec(
        html,
      );
      if (!match?.[1]) throw new Error("Fixture mapping missing");
      return {
        v: 1,
        hostname,
        token: match[1],
        method: "GET",
        query: { cb: "42" },
        headers: {
          "user-agent": "Apple privacy proxy fixture café",
          authorization: "Bearer do-not-store",
          cookie: "session=do-not-store",
          referer: "https://example.invalid/?do-not-store",
        },
        edge: {
          receivedAt: new Date().toISOString(),
          remoteAddress: "198.51.100.9",
          httpVersion: "HTTP/2",
          tlsVersion: "TLSv1.3",
        },
      };
    }

    function signature(
      payload: string,
      timestamp = String(Math.floor(Date.now() / 1000)),
    ) {
      const key = Buffer.from(relaySecret, "base64");
      return {
        "content-type": "application/json",
        "x-df-tracking-timestamp": timestamp,
        "x-df-tracking-signature": createHmac(
          "sha256",
          new Uint8Array(key.buffer, key.byteOffset, key.byteLength),
        )
          .update(`${timestamp}.${payload}`)
          .digest("hex"),
      };
    }

    it("durably records signed GET/HEAD with edge and origin evidence separated and secrets removed", async () => {
      const body = await relayPayload();
      jest
        .spyOn(domains, "getTrackingHostnameNewsletter")
        .mockResolvedValue(workspaceId);
      const raw = JSON.stringify(body, null, 2);
      expect(
        (
          await app.inject({
            method: "POST",
            url: relayPath,
            headers: signature(raw),
            payload: raw,
          })
        ).statusCode,
      ).toBe(204);
      const headRaw = JSON.stringify({ ...body, method: "HEAD" });
      expect(
        (
          await app.inject({
            method: "POST",
            url: relayPath,
            headers: signature(headRaw),
            payload: headRaw,
          })
        ).statusCode,
      ).toBe(204);
      await tracking.drainEmailOpenEvents();
      const history = await getDeliveryOpens({
        workspaceId,
        userId,
        messageId,
      });
      expect(history.openCount).toBe(1);
      const evidenceId = history.items[0]?.evidenceId;
      if (!evidenceId) throw new Error("Relay evidence missing");
      const evidence = await tracking.getEmailOpenEvidence({
        workspaceId,
        userId,
        messageId,
        evidenceId,
      });
      expect(evidence).toMatchObject({
        request: {
          method: "GET",
          encrypted: false,
          query: { cb: "42" },
          headers: { "user-agent": "Apple privacy proxy fixture café" },
          edgeObserved: {
            source: "cloudflare_worker",
            hostname,
            remoteAddress: "198.51.100.9",
            httpVersion: "HTTP/2",
            tlsVersion: "TLSv1.3",
          },
        },
      });
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain(body.token);
      expect(serialized).not.toContain("do-not-store");
      expect(logs.join("\n")).not.toContain(body.token);
    });

    it("rejects unsigned, expired, and body-modified requests before hostname lookup", async () => {
      const body = await relayPayload();
      const lookup = jest.spyOn(domains, "getTrackingHostnameNewsletter");
      const raw = JSON.stringify(body);
      const variants = [
        { headers: { "content-type": "application/json" }, payload: raw },
        {
          headers: signature(raw, String(Math.floor(Date.now() / 1000) - 301)),
          payload: raw,
        },
        {
          headers: signature(raw),
          payload: JSON.stringify({ ...body, hostname: "dt.other.example" }),
        },
      ];
      await Promise.all(
        variants.map(async (variant) => {
          expect(
            (await app.inject({ method: "POST", url: relayPath, ...variant }))
              .statusCode,
          ).toBe(403);
        }),
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(logs.join("\n")).not.toContain(body.token);
    });

    it("cannot replay a token through a different branded hostname or newsletter", async () => {
      const body = await relayPayload();
      const lookup = jest
        .spyOn(domains, "getTrackingHostnameNewsletter")
        .mockResolvedValue(workspaceId);
      const wrongHost = JSON.stringify({
        ...body,
        hostname: "dt.other.example",
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: relayPath,
            headers: signature(wrongHost),
            payload: wrongHost,
          })
        ).statusCode,
      ).toBe(204);
      lookup.mockResolvedValue(randomUUID());
      const raw = JSON.stringify(body);
      expect(
        (
          await app.inject({
            method: "POST",
            url: relayPath,
            headers: signature(raw),
            payload: raw,
          })
        ).statusCode,
      ).toBe(204);
      await tracking.drainEmailOpenEvents();
      expect(
        (await getDeliveryOpens({ workspaceId, userId, messageId })).openCount,
      ).toBe(0);
    });

    it("fails closed for unknown hostnames, capture failures, and disabled collection", async () => {
      const body = await relayPayload();
      const raw = JSON.stringify(body);
      const lookup = jest
        .spyOn(domains, "getTrackingHostnameNewsletter")
        .mockResolvedValue(null);
      expect(
        (
          await app.inject({
            method: "POST",
            url: relayPath,
            headers: signature(raw),
            payload: raw,
          })
        ).statusCode,
      ).toBe(403);
      lookup.mockResolvedValue(workspaceId);
      jest
        .spyOn(tracking, "captureEmailOpenRequest")
        .mockRejectedValueOnce(new Error("do-not-log-private-capture"));
      expect(
        (
          await app.inject({
            method: "POST",
            url: relayPath,
            headers: signature(raw),
            payload: raw,
          })
        ).statusCode,
      ).toBe(503);
      config().enableOpenTracking = false;
      expect(
        (
          await app.inject({
            method: "POST",
            url: relayPath,
            headers: signature(raw),
            payload: raw,
          })
        ).statusCode,
      ).toBe(503);
      expect(logs.join("\n")).not.toContain("do-not-log-private-capture");
    });

    describe("queued v2 batches", () => {
      const batchPath = "/api/public/email/open/batch";

      async function event(): Promise<QueuedOpenEvent> {
        const body = await relayPayload();
        return {
          ...body,
          method: "GET",
          v: 2,
          eventId: randomUUID(),
          edge: {
            ...body.edge,
            asOrganization: "Fixture residential network",
            asn: 64500,
            country: "US",
            networkSetVersion: null,
          },
        };
      }

      async function post(events: QueuedOpenEvent[]) {
        const raw = JSON.stringify({ v: 2, events });
        return app.inject({
          method: "POST",
          url: batchPath,
          headers: signature(raw),
          payload: raw,
        });
      }

      it("deduplicates queue retries, preserves edge occurrence and keeps HEAD out of observed opens", async () => {
        const get = await event();
        get.edge.receivedAt = new Date(Date.now() - 60_000).toISOString();
        const head: QueuedOpenEvent = {
          ...get,
          eventId: randomUUID(),
          method: "HEAD",
        };
        jest
          .spyOn(domains, "getTrackingHostnameNewsletter")
          .mockResolvedValue(workspaceId);
        expect((await post([get, head])).statusCode).toBe(204);
        expect((await post([get, head])).statusCode).toBe(204);
        await tracking.drainEmailOpenEvents();
        const history = await getDeliveryOpens({
          workspaceId,
          userId,
          messageId,
        });
        expect(history.openCount).toBe(1);
        expect(history.items[0]?.evidenceId).toBe(get.eventId);
        const evidence = await tracking.getEmailOpenEvidence({
          workspaceId,
          userId,
          messageId,
          evidenceId: get.eventId,
        });
        expect(evidence).toMatchObject({
          receivedAt: get.edge.receivedAt,
          request: {
            edgeObserved: {
              asOrganization: "Fixture residential network",
              asn: 64500,
              country: "US",
              networkSetVersion: null,
            },
          },
        });
        expect(JSON.stringify(evidence)).not.toContain("do-not-store");
        expect(logs.join("\n")).not.toContain(get.token);
      });

      it("authenticates full batches above the legacy relay body limit", async () => {
        const fixture = await event();
        const events = Array.from({ length: 8 }, () => ({
          ...fixture,
          eventId: randomUUID(),
          headers: {
            "user-agent": "Mozilla/5.0 (Fixture)",
            accept: "x".repeat(512),
            "accept-language": "x".repeat(512),
            "cache-control": "x".repeat(512),
            pragma: "x".repeat(512),
          },
        }));
        jest
          .spyOn(domains, "getTrackingHostnameNewsletter")
          .mockResolvedValue(workspaceId);
        expect(
          Buffer.byteLength(JSON.stringify({ v: 2, events })),
        ).toBeGreaterThan(16_384);
        expect((await post(events)).statusCode).toBe(204);
        await tracking.drainEmailOpenEvents();
        expect(
          (await getDeliveryOpens({ workspaceId, userId, messageId }))
            .openCount,
        ).toBe(8);
      });

      it("rejects tampering, stale signatures, oversized batches and unverified hosts", async () => {
        const fixture = await event();
        const lookup = jest
          .spyOn(domains, "getTrackingHostnameNewsletter")
          .mockResolvedValue(null);
        const raw = JSON.stringify({ v: 2, events: [fixture] });
        await Promise.all(
          [
            { "content-type": "application/json" },
            signature(raw, String(Math.floor(Date.now() / 1000) - 301)),
            signature(`${raw} `),
          ].map(async (headers) => {
            expect(
              (
                await app.inject({
                  method: "POST",
                  url: batchPath,
                  headers,
                  payload: raw,
                })
              ).statusCode,
            ).toBe(403);
          }),
        );
        expect(lookup).not.toHaveBeenCalled();
        expect(
          (await post(Array.from({ length: 51 }, () => fixture))).statusCode,
        ).toBe(400);
        expect((await post([])).statusCode).toBe(400);
        expect((await post([fixture])).statusCode).toBe(403);
        lookup.mockResolvedValue(randomUUID());
        expect((await post([fixture])).statusCode).toBe(204);
        lookup.mockResolvedValue(workspaceId);
        expect(
          (await post([{ ...fixture, hostname: "dt.other.example" }]))
            .statusCode,
        ).toBe(204);
        await tracking.drainEmailOpenEvents();
        expect(
          (await getDeliveryOpens({ workspaceId, userId, messageId }))
            .openCount,
        ).toBe(0);
        expect(logs.join("\n")).not.toContain(fixture.token);
      });

      it("retries partial persistence without duplicating accepted receipts", async () => {
        const first = await event();
        const second = { ...first, eventId: randomUUID() };
        jest
          .spyOn(domains, "getTrackingHostnameNewsletter")
          .mockResolvedValue(workspaceId);
        const originalCapture = tracking.captureEmailOpenRequest;
        const capture = jest
          .spyOn(tracking, "captureEmailOpenRequest")
          .mockImplementationOnce(originalCapture)
          .mockRejectedValueOnce(new Error("private-queue-retry-context"));
        expect((await post([first, second])).statusCode).toBe(503);
        capture.mockRestore();
        expect((await post([first, second])).statusCode).toBe(204);
        await tracking.drainEmailOpenEvents();
        expect(
          (await getDeliveryOpens({ workspaceId, userId, messageId }))
            .openCount,
        ).toBe(2);
        expect(logs.join("\n")).not.toContain("private-queue-retry-context");
        config().enableOpenTracking = false;
        expect((await post([first])).statusCode).toBe(503);
      });
    });
  });
});

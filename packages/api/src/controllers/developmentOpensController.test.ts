import { createAdminApiKey } from "backend-lib/src/adminApiKeys";
import { clickhouseClient } from "backend-lib/src/clickhouse";
import config, { Config } from "backend-lib/src/config";
import {
  captureDevelopmentPixelEvents,
  DevelopmentPixelEventsPage,
} from "backend-lib/src/messaging/developmentOpenTracking";
import * as development from "backend-lib/src/messaging/developmentOpenTracking";
import { deleteEmailOpenData } from "backend-lib/src/messaging/openTracking";
import { installNewsletterSecretFixture } from "backend-lib/test/newsletterSecretFixture";
import {
  createTrackedSendFixture,
  createTrackingNewsletterFixture,
  TrackedSendFixture,
  TrackingNewsletterFixture,
} from "backend-lib/test/openTrackingFixture";
import { randomUUID } from "crypto";
import fastify, { FastifyInstance } from "fastify";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { DEVELOPMENT_PIXEL_TABLE, DevelopmentPixelEvent } from "isomorphic-lib/src/tracking/development";
import { AdminApiKeyScope } from "isomorphic-lib/src/types";

import adminAuth from "../buildApp/adminAuth";
import deliveriesController from "./deliveriesController";

const path = "/api/deliveries/development-opens";

describe("authorized development open evidence review", () => {
  let app: FastifyInstance;
  let restoreSecret: () => void;
  let fixture: TrackingNewsletterFixture;
  let sibling: TrackingNewsletterFixture;
  let send: TrackedSendFixture;
  let first: DevelopmentPixelEvent;
  let second: DevelopmentPixelEvent;
  let authorization: string;
  let original: Pick<Config, "enableOpenTracking" | "enableOpenTrackingDevLake" | "openTrackingRetentionDays">;

  async function key(scopes: AdminApiKeyScope[]) {
    return `Bearer ${unwrap(await createAdminApiKey({
      workspaceId: fixture.workspaceId, name: randomUUID(), scopes,
    })).apiKey}`;
  }

  function event(host: TrackingNewsletterFixture, tracked: TrackedSendFixture): DevelopmentPixelEvent {
    return {
      v: 3, eventId: randomUUID(), hostname: host.hostname, token: tracked.token,
      occurredAt: new Date(Date.now() - 1000).toISOString(),
      evidence: {
        request: {
          url: `https://${host.hostname}/o/[redacted]?a=1&a=2`, method: "GET",
          headers: { "user-agent": "development review fixture", "x-custom-observation": "retained", cookie: "private-cookie" },
          properties: { cache: "no-store", nestedFutureProperty: { enabled: true } },
          body: { encoding: "base64", data: "", capturedBytes: 0, declaredBytes: null, truncated: false, unavailable: null },
        },
        cloudflare: { colo: "SJC", nestedMetadata: { scores: [1, 2, 3] } },
        response: { status: 200, headers: { "content-type": "image/gif" } },
        network: { setVersion: null, match: null },
        redactions: [], truncations: [], unavailable: [],
      },
    };
  }

  beforeEach(async () => {
    restoreSecret = installNewsletterSecretFixture();
    original = {
      enableOpenTracking: config().enableOpenTracking,
      enableOpenTrackingDevLake: config().enableOpenTrackingDevLake,
      openTrackingRetentionDays: config().openTrackingRetentionDays,
    };
    Object.assign(config(), {
      enableOpenTracking: true, enableOpenTrackingDevLake: true,
      openTrackingRetentionDays: 30,
    });
    fixture = await createTrackingNewsletterFixture();
    sibling = await createTrackingNewsletterFixture();
    send = await createTrackedSendFixture(fixture);
    const siblingSend = await createTrackedSendFixture(sibling);
    first = event(fixture, send);
    second = event(fixture, send);
    second.occurredAt = new Date(Date.parse(first.occurredAt) + 1).toISOString();
    await captureDevelopmentPixelEvents([
      { workspaceId: fixture.workspaceId, event: first },
      { workspaceId: fixture.workspaceId, event: second },
      { workspaceId: sibling.workspaceId, event: event(sibling, siblingSend) },
    ]);
    authorization = await key(["sensitive"]);
    app = fastify();
    await app.register(adminAuth);
    await app.register(deliveriesController, { prefix: "/api/deliveries" });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (app) await app.close();
    Object.assign(config(), original);
    restoreSecret();
  });

  async function read(payload: Record<string, unknown> = {}, auth = authorization) {
    return app.inject({
      method: "POST", url: path, headers: { authorization: auth },
      payload: { workspaceId: fixture.workspaceId, ...payload },
    });
  }

  it("requires an authenticated sensitive grant and enforces the requested workspace", async () => {
    expect((await app.inject({ method: "POST", url: path, payload: { workspaceId: fixture.workspaceId } })).statusCode).toBe(401);
    expect((await read({}, await key(["read"]))).statusCode).toBe(403);
    expect((await read({}, await key(["write"]))).statusCode).toBe(403);
    expect((await read({ workspaceId: sibling.workspaceId })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST", url: path,
      headers: { authorization, [WORKSPACE_ID_HEADER]: sibling.workspaceId },
      payload: { workspaceId: fixture.workspaceId },
    })).statusCode).toBe(400);
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json<DevelopmentPixelEventsPage>().events.map((row) => row.eventId).sort()).toEqual([first.eventId, second.eventId].sort());
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("returns decrypted broad evidence only through the scoped endpoint, without stored secrets or ciphertext", async () => {
    const response = await read({ eventId: first.eventId, userId: send.userId, messageId: send.messageId });
    expect(response.statusCode).toBe(200);
    expect(response.json<DevelopmentPixelEventsPage>().events).toEqual([expect.objectContaining({
      eventId: first.eventId, workspaceId: fixture.workspaceId,
      userId: send.userId, messageId: send.messageId, status: "matched",
      evidence: expect.objectContaining({
        request: expect.objectContaining({ properties: first.evidence.request.properties,
          headers: expect.objectContaining({ "x-custom-observation": "retained" }) }),
        cloudflare: first.evidence.cloudflare,
      }),
    })]);
    expect(response.payload).not.toContain(send.token);
    expect(response.payload).not.toContain("private-cookie");
    expect(response.payload).not.toContain("encryptedEvidence");
    for (const filter of [
      { eventId: randomUUID() }, { userId: randomUUID() }, { messageId: randomUUID() },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- Check independent contact/send/event scopes.
      const missing = await read(filter);
      expect(missing.statusCode).toBe(200);
      expect(missing.json<DevelopmentPixelEventsPage>().events).toEqual([]);
    }
  });

  it("paginates actual rows without duplication and rejects invalid or cross-scope cursors", async () => {
    const response = await read({ limit: 1 });
    expect(response.statusCode).toBe(200);
    const page = response.json<DevelopmentPixelEventsPage>();
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await read({ limit: 1, before: page.nextCursor });
    expect(next.statusCode).toBe(200);
    expect(next.json<DevelopmentPixelEventsPage>().events).toHaveLength(1);
    expect(new Set([...page.events, ...next.json<DevelopmentPixelEventsPage>().events].map((row) => row.eventId))).toEqual(new Set([first.eventId, second.eventId]));
    expect((await read({ before: "not-a-cursor" })).statusCode).toBe(400);
    expect((await read({ before: page.nextCursor, userId: randomUUID() })).statusCode).toBe(400);
    for (const invalid of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { eventId: "malformed" }, { workspaceId: "malformed" }]) {
      // eslint-disable-next-line no-await-in-loop -- Independently verify each public request bound.
      expect((await read(invalid)).statusCode).toBe(400);
    }
  });

  it("never exposes expired evidence or actor columns before asynchronous ClickHouse TTL cleanup", async () => {
    await clickhouseClient().command({
      query: `ALTER TABLE ${DEVELOPMENT_PIXEL_TABLE}
        UPDATE rawExpiresAt = now64(3) - INTERVAL 1 SECOND
        WHERE workspaceId = {workspaceId:String} AND eventId = {eventId:UUID}`,
      query_params: { workspaceId: fixture.workspaceId, eventId: first.eventId },
      clickhouse_settings: { mutations_sync: "2", wait_end_of_query: 1 },
    });
    const response = await read({ eventId: first.eventId });
    expect(response.statusCode).toBe(200);
    expect(response.json<DevelopmentPixelEventsPage>().events).toEqual([]);
    expect((await read({ eventId: second.eventId })).json<DevelopmentPixelEventsPage>().events[0]?.evidence).toEqual(expect.any(Object));
  });

  it("keeps private storage and decryption failures out of response bodies", async () => {
    jest.spyOn(development, "findDevelopmentPixelEvents")
      .mockRejectedValueOnce(new Error("private-development-query-failure"));
    const response = await read();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ message: "Development evidence unavailable" });
    expect(response.payload).not.toContain("private-development-query-failure");
  });

  it("allows authorized historical review after collection is disabled and respects user erasure", async () => {
    config().enableOpenTrackingDevLake = false;
    config().enableOpenTracking = false;
    expect((await read()).json<DevelopmentPixelEventsPage>().events).toHaveLength(2);
    await deleteEmailOpenData({ workspaceId: fixture.workspaceId, userIds: [send.userId] });
    expect((await read()).json<DevelopmentPixelEventsPage>().events).toEqual([]);
    expect((await read({ eventId: first.eventId })).json<DevelopmentPixelEventsPage>().events).toEqual([]);
  });
});

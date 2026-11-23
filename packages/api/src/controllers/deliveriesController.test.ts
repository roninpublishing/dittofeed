import { createAdminApiKey } from "backend-lib/src/adminApiKeys";
import { submitBatch } from "backend-lib/src/apps/batch";
import { createWorkspace } from "backend-lib/src/workspaces";
import { randomUUID } from "crypto";
import fastify, { FastifyInstance } from "fastify";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  EventType,
  GetDeliveryClicksResponse,
  GetDeliveryOpensResponse,
  InternalEventType,
  KnownBatchTrackData,
} from "isomorphic-lib/src/types";

import adminAuth from "../buildApp/adminAuth";
import deliveriesController from "./deliveriesController";

describe("delivery clicks API", () => {
  let app: FastifyInstance;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let messageId: string;
  let authorization: string;
  const olderAt = "2025-01-01T01:02:03.123Z";
  const newerAt = "2025-01-02T01:02:03.987Z";

  beforeEach(async () => {
    workspaceId = unwrap(await createWorkspace({ name: randomUUID() })).id;
    otherWorkspaceId = unwrap(await createWorkspace({ name: randomUUID() })).id;
    userId = randomUUID();
    messageId = randomUUID();
    authorization = `Bearer ${unwrap(await createAdminApiKey({ workspaceId, name: "click-history-test" })).apiKey}`;
    app = fastify();
    await app.register(adminAuth);
    await app.register(deliveriesController, { prefix: "/api/deliveries" });
    const click: KnownBatchTrackData = {
      type: EventType.Track,
      event: InternalEventType.EmailClicked,
      userId,
      messageId: randomUUID(),
      timestamp: newerAt,
      properties: {
        messageId,
        url: "https://example.com/read",
        ip: "192.0.2.1",
        user_agent: "scanner",
      },
    };
    await submitBatch({
      workspaceId,
      data: {
        batch: [
          click,
          click,
          {
            ...click,
            messageId: randomUUID(),
            timestamp: olderAt,
            properties: { messageId },
          },
        ],
      },
    });
    await submitBatch({
      workspaceId: otherWorkspaceId,
      data: { batch: [{ ...click, timestamp: "2025-01-03T00:00:00.000Z" }] },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns actual deduplicated, scoped observations and bounded pages without raw request evidence", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/deliveries/clicks",
      headers: { authorization },
      payload: { workspaceId, userId, messageId, limit: 1 },
    });
    expect(first.statusCode).toBe(200);
    const page = unwrap(
      schemaValidateWithErr(first.json(), GetDeliveryClicksResponse),
    );
    expect(page).toMatchObject({
      workspaceId,
      userId,
      messageId,
      lastClickedAt: newerAt,
      clickCount: 2,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      clickedAt: newerAt,
      url: "https://example.com/read",
      classification: "observed_unqualified",
    });
    expect(page.items[0]).not.toHaveProperty("ip");
    expect(page.items[0]).not.toHaveProperty("user_agent");
    expect(page.cursor).toBeDefined();
    const second = await app.inject({
      method: "POST",
      url: "/api/deliveries/clicks",
      headers: { authorization },
      payload: {
        workspaceId,
        userId,
        messageId,
        limit: 1,
        cursor: page.cursor,
      },
    });
    expect(second.statusCode).toBe(200);
    const next = unwrap(
      schemaValidateWithErr(second.json(), GetDeliveryClicksResponse),
    );
    expect(next).toMatchObject({ clickCount: 2, lastClickedAt: newerAt });
    expect(next.items.map((item) => [item.clickedAt, item.url])).toEqual([
      [olderAt, null],
    ]);
    expect(next.cursor).toBeUndefined();
  });

  it("requires authorization for the requested workspace and does not mix contacts or sends", async () => {
    const missingAuth = await app.inject({
      method: "POST",
      url: "/api/deliveries/clicks",
      payload: { workspaceId, userId, messageId },
    });
    expect(missingAuth.statusCode).toBe(401);
    const wrongTenant = await app.inject({
      method: "POST",
      url: "/api/deliveries/clicks",
      headers: { authorization },
      payload: { workspaceId: otherWorkspaceId, userId, messageId },
    });
    expect(wrongTenant.statusCode).toBe(401);
    await Promise.all(
      [
        { userId: randomUUID(), messageId },
        { userId, messageId: randomUUID() },
      ].map(async (scope) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/deliveries/clicks",
          headers: { authorization },
          payload: { workspaceId, ...scope },
        });
        expect(response.statusCode).toBe(200);
        expect(
          unwrap(
            schemaValidateWithErr(response.json(), GetDeliveryClicksResponse),
          ),
        ).toEqual({
          workspaceId,
          ...scope,
          lastClickedAt: null,
          clickCount: 0,
          items: [],
        });
      }),
    );
  });

  it("rejects invalid bounds and malformed or cross-scope cursors", async () => {
    await Promise.all(
      [0, 101, 1.5].map(async (limit) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/deliveries/clicks",
          headers: { authorization },
          payload: { workspaceId, userId, messageId, limit },
        });
        expect(response.statusCode).toBe(400);
      }),
    );
    const first = await app.inject({
      method: "POST",
      url: "/api/deliveries/clicks",
      headers: { authorization },
      payload: { workspaceId, userId, messageId, limit: 1 },
    });
    const page = unwrap(
      schemaValidateWithErr(first.json(), GetDeliveryClicksResponse),
    );
    await Promise.all(
      [
        { userId, messageId, cursor: "invalid-json" },
        { userId: randomUUID(), messageId, cursor: page.cursor },
      ].map(async (request) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/deliveries/clicks",
          headers: { authorization },
          payload: { workspaceId, ...request },
        });
        expect(response.statusCode).toBe(400);
      }),
    );
  });
});
describe("delivery opens API", () => {
  let app: FastifyInstance;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let messageId: string;
  let authorization: string;
  const olderAt = "2025-01-01T01:02:03.123Z";
  const newerAt = "2025-01-02T01:02:03.987Z";

  beforeEach(async () => {
    workspaceId = unwrap(await createWorkspace({ name: randomUUID() })).id;
    otherWorkspaceId = unwrap(await createWorkspace({ name: randomUUID() })).id;
    userId = randomUUID();
    messageId = randomUUID();
    authorization = `Bearer ${unwrap(await createAdminApiKey({ workspaceId, name: "open-history-test", scopes: ["read", "sensitive"] })).apiKey}`;
    app = fastify();
    await app.register(adminAuth);
    await app.register(deliveriesController, { prefix: "/api/deliveries" });
    const open: KnownBatchTrackData = {
      type: EventType.Track,
      event: InternalEventType.EmailOpened,
      userId,
      messageId: randomUUID(),
      timestamp: newerAt,
      properties: {
        messageId,
        evidenceSource: "owned_pixel",
        evidenceId: randomUUID(),
        ip: "192.0.2.1",
        user_agent: "scanner",
      },
    };
    await submitBatch({
      workspaceId,
      data: {
        batch: [
          open,
          open,
          {
            ...open,
            messageId: randomUUID(),
            timestamp: olderAt,
            properties: { messageId },
          },
        ],
      },
    });
    await submitBatch({
      workspaceId: otherWorkspaceId,
      data: { batch: [{ ...open, timestamp: "2025-01-03T00:00:00.000Z" }] },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns actual deduplicated, scoped observations and bounded pages without raw request evidence", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/deliveries/opens",
      headers: { authorization },
      payload: { workspaceId, userId, messageId, limit: 1 },
    });
    expect(first.statusCode).toBe(200);
    const page = unwrap(
      schemaValidateWithErr(first.json(), GetDeliveryOpensResponse),
    );
    expect(page).toMatchObject({
      workspaceId,
      userId,
      messageId,
      lastOpenedAt: newerAt,
      openCount: 2,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      openedAt: newerAt,
      evidenceSource: "owned_pixel",
      classification: "observed_unqualified",
    });
    expect(page.items[0]).not.toHaveProperty("ip");
    expect(page.items[0]).not.toHaveProperty("user_agent");
    expect(page.cursor).toBeDefined();
    const second = await app.inject({
      method: "POST",
      url: "/api/deliveries/opens",
      headers: { authorization },
      payload: {
        workspaceId,
        userId,
        messageId,
        limit: 1,
        cursor: page.cursor,
      },
    });
    expect(second.statusCode).toBe(200);
    const next = unwrap(
      schemaValidateWithErr(second.json(), GetDeliveryOpensResponse),
    );
    expect(next).toMatchObject({ openCount: 2, lastOpenedAt: newerAt });
    expect(next.items.map((item) => item.openedAt)).toEqual([olderAt]);
    expect(next.cursor).toBeUndefined();
  });

  it("requires authorization for the requested workspace and does not mix contacts or sends", async () => {
    const missingAuth = await app.inject({
      method: "POST",
      url: "/api/deliveries/opens",
      payload: { workspaceId, userId, messageId },
    });
    expect(missingAuth.statusCode).toBe(401);
    const wrongTenant = await app.inject({
      method: "POST",
      url: "/api/deliveries/opens",
      headers: { authorization },
      payload: { workspaceId: otherWorkspaceId, userId, messageId },
    });
    expect(wrongTenant.statusCode).toBe(401);
    await Promise.all(
      [
        { userId: randomUUID(), messageId },
        { userId, messageId: randomUUID() },
      ].map(async (scope) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/deliveries/opens",
          headers: { authorization },
          payload: { workspaceId, ...scope },
        });
        expect(response.statusCode).toBe(200);
        expect(
          unwrap(
            schemaValidateWithErr(response.json(), GetDeliveryOpensResponse),
          ),
        ).toEqual({
          workspaceId,
          ...scope,
          lastOpenedAt: null,
          openCount: 0,
          items: [],
        });
      }),
    );
  });

  it("rejects invalid bounds and malformed or cross-scope cursors", async () => {
    await Promise.all(
      [0, 101, 1.5].map(async (limit) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/deliveries/opens",
          headers: { authorization },
          payload: { workspaceId, userId, messageId, limit },
        });
        expect(response.statusCode).toBe(400);
      }),
    );
    const first = await app.inject({
      method: "POST",
      url: "/api/deliveries/opens",
      headers: { authorization },
      payload: { workspaceId, userId, messageId, limit: 1 },
    });
    const page = unwrap(
      schemaValidateWithErr(first.json(), GetDeliveryOpensResponse),
    );
    await Promise.all(
      [
        { userId, messageId, cursor: "invalid-json" },
        { userId: randomUUID(), messageId, cursor: page.cursor },
      ].map(async (request) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/deliveries/opens",
          headers: { authorization },
          payload: { workspaceId, ...request },
        });
        expect(response.statusCode).toBe(400);
      }),
    );
  });

  it("requires scoped authorization for explicit raw evidence and returns 404 when absent", async () => {
    const payload = {
      workspaceId,
      userId,
      messageId,
      evidenceId: randomUUID(),
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/deliveries/opens/evidence",
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/deliveries/opens/evidence",
          headers: { authorization },
          payload: { ...payload, workspaceId: otherWorkspaceId },
        })
      ).statusCode,
    ).toBe(401);
    await Promise.all(
      [
        payload,
        { ...payload, userId: randomUUID() },
        { ...payload, messageId: randomUUID() },
      ].map(async (scope) => {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/deliveries/opens/evidence",
              headers: { authorization },
              payload: scope,
            })
          ).statusCode,
        ).toBe(404);
      }),
    );
  });
});

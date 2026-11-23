import { createHash, randomUUID } from "crypto";
import { createAdminApiKey } from "backend-lib/src/adminApiKeys";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import logger from "backend-lib/src/logger";
import { createWorkspace } from "backend-lib/src/workspaces";
import { and, eq } from "drizzle-orm";
import fastify, { FastifyInstance } from "fastify";
import { API_OPERATION_SCOPES } from "isomorphic-lib/src/apiOperations";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  AdminApiKeyPermission,
  AdminApiKeyScope,
  AdminApiKeyType,
  CreateAdminApiKeyResponse,
  WorkspaceStatusDbEnum,
  WorkspaceTypeAppEnum,
} from "isomorphic-lib/src/types";

import apiKeyController from "../controllers/apiKeyController";
import componentConfigurationsController from "../controllers/componentConfigurationsController";
import deliveriesController from "../controllers/deliveriesController";
import secretsController from "../controllers/secretsController";
import adminAuth, { authenticateAdminApiKeyFull } from "./adminAuth";

describe("scoped machine API credentials", () => {
  let app: FastifyInstance;
  let workspaceId: string;
  let readKey: CreateAdminApiKeyResponse;

  const createKey = async (scopes?: AdminApiKeyScope[]) =>
    unwrap(await createAdminApiKey({ workspaceId, name: randomUUID(), scopes }));
  const headers = (key: string) => ({
    authorization: `Bearer ${key}`,
    [WORKSPACE_ID_HEADER]: workspaceId,
  });

  beforeEach(async () => {
    workspaceId = unwrap(await createWorkspace({ name: randomUUID() })).id;
    readKey = await createKey();
    app = fastify();
    await app.register(adminAuth);
    await app.register(apiKeyController, { prefix: "/api/admin/admin-keys" });
    await app.register(componentConfigurationsController, {
      prefix: "/api/admin/component-configurations",
    });
    await app.register(deliveriesController, { prefix: "/api/admin/deliveries" });
    await app.register(secretsController, { prefix: "/api/admin/secrets" });
  });

  afterEach(async () => { await app.close(); });

  it("defaults new keys to read and permits real read-only POST queries", async () => {
    expect(readKey.scopes).toEqual(["read"]);
    const persisted = await db().query.secret.findFirst({
      where: and(
        eq(schema.secret.workspaceId, workspaceId),
        eq(schema.secret.name, `df-admin-api-key-${readKey.name}`),
      ),
    });
    expect(persisted?.configValue).toEqual({
      type: AdminApiKeyType.AdminApiKey,
      permissions: [AdminApiKeyPermission.Admin],
      keyHash: createHash("sha256").update(readKey.apiKey).digest("hex"),
      scopes: ["read"],
    });
    expect(JSON.stringify(persisted)).not.toContain(readKey.apiKey);
    const payload = { workspaceId, userId: randomUUID(), messageId: randomUUID() };
    for (const suffix of ["clicks", "opens"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/deliveries/${suffix}`,
        headers: headers(readKey.apiKey),
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toEqual([]);
    }
    const write = await app.inject({
      method: "PUT",
      url: "/api/admin/component-configurations",
      headers: headers(readKey.apiKey),
      payload: { workspaceId, name: randomUUID() },
    });
    expect(write.statusCode).toBe(403);
  });

  it("keeps write, destructive, and sensitive grants independent", async () => {
    const writeKey = await createKey(["write"]);
    for (const key of [readKey, writeKey]) {
      expect((await app.inject({
        method: "DELETE",
        url: `/api/admin/component-configurations?workspaceId=${workspaceId}&id=${randomUUID()}`,
        headers: headers(key.apiKey),
      })).statusCode).toBe(403);
      expect((await app.inject({
        method: "POST",
        url: "/api/admin/deliveries/opens/evidence",
        headers: headers(key.apiKey),
        payload: { workspaceId, userId: randomUUID(), messageId: randomUUID(), evidenceId: randomUUID() },
      })).statusCode).toBe(403);
    }
    const destructiveKey = await createKey(["destructive"]);
    expect((await app.inject({
      method: "DELETE",
      url: `/api/admin/component-configurations?workspaceId=${workspaceId}&id=${randomUUID()}`,
      headers: headers(destructiveKey.apiKey),
    })).statusCode).toBe(204);
    const sensitiveKey = await createKey(["sensitive"]);
    expect((await app.inject({
      method: "POST",
      url: "/api/admin/deliveries/opens/evidence",
      headers: headers(sensitiveKey.apiKey),
      payload: { workspaceId, userId: randomUUID(), messageId: randomUUID(), evidenceId: randomUUID() },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET",
      url: `/api/admin/component-configurations?workspaceId=${workspaceId}`,
      headers: headers(sensitiveKey.apiKey),
    })).statusCode).toBe(403);
  });

  it("blocks partial-grant key minting and direct secret-definition escalation", async () => {
    const partialKeys = [
      readKey,
      await createKey(["sensitive"]),
      await createKey(["read", "write", "sensitive"]),
    ];
    for (const key of partialKeys) {
      expect((await app.inject({
        method: "POST",
        url: "/api/admin/admin-keys",
        headers: headers(key.apiKey),
        payload: { workspaceId, name: randomUUID(), scopes: API_OPERATION_SCOPES },
      })).statusCode).toBe(403);
      expect((await app.inject({
        method: "PUT",
        url: "/api/admin/secrets",
        headers: headers(key.apiKey),
        payload: {
          workspaceId,
          name: `df-admin-api-key-${readKey.name}`,
          configValue: { scopes: API_OPERATION_SCOPES },
        },
      })).statusCode).toBe(403);
      expect((await app.inject({
        method: "GET",
        url: `/api/admin/secrets?workspaceId=${workspaceId}`,
        headers: headers(key.apiKey),
      })).statusCode).toBe(403);
    }
    expect((await authenticateAdminApiKeyFull({ workspaceId, actualKey: readKey.apiKey }))?.scopes).toEqual(["read"]);
  });

  it("allows full-authority creation, returns scopes, and never lists secret keys", async () => {
    const administrator = await createKey([...API_OPERATION_SCOPES]);
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/admin-keys",
      headers: headers(administrator.apiKey),
      payload: { workspaceId, name: randomUUID(), scopes: ["read", "write"] },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().scopes).toEqual(["read", "write"]);
    expect(created.json().apiKey).toEqual(expect.any(String));
    const list = await app.inject({
      method: "GET",
      url: `/api/admin/admin-keys?workspaceId=${workspaceId}`,
      headers: headers(administrator.apiKey),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toContainEqual(expect.objectContaining({ id: readKey.id, scopes: ["read"] }));
    expect(list.body).not.toContain(readKey.apiKey);
    expect(list.body).not.toContain(administrator.apiKey);
    expect(list.body).not.toContain(created.json().apiKey);
    for (const key of list.json()) expect(key).not.toHaveProperty("apiKey");
  });

  it("keeps persisted keys without scopes fully authorized", async () => {
    const [secret] = await db().insert(schema.secret).values({
      workspaceId,
      name: randomUUID(),
      configValue: {
        type: AdminApiKeyType.AdminApiKey,
        key: "legacy-administrator-secret",
        permissions: [AdminApiKeyPermission.Admin],
      },
    }).returning();
    if (!secret) throw new Error("Failed to create legacy test secret");
    await db().insert(schema.adminApiKey).values({ workspaceId, name: randomUUID(), secretId: secret.id });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/admin-keys",
      headers: headers("legacy-administrator-secret"),
      payload: { workspaceId, name: randomUUID(), scopes: API_OPERATION_SCOPES },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().scopes).toEqual(API_OPERATION_SCOPES);
  });

  it("revokes permanently, rotates old orphaned secrets, and does not disclose duplicate live keys", async () => {
    const administrator = await createKey([...API_OPERATION_SCOPES]);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/admin/admin-keys",
      headers: headers(administrator.apiKey),
      payload: { workspaceId, name: readKey.name, scopes: API_OPERATION_SCOPES },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).not.toContain(readKey.apiKey);
    expect(await authenticateAdminApiKeyFull({ workspaceId, actualKey: readKey.apiKey })).not.toBeNull();
    expect((await app.inject({
      method: "DELETE",
      url: `/api/admin/admin-keys?workspaceId=${workspaceId}&id=${readKey.id}`,
      headers: headers(administrator.apiKey),
    })).statusCode).toBe(204);
    const replacement = unwrap(await createAdminApiKey({ workspaceId, name: readKey.name }));
    expect(replacement.apiKey).not.toBe(readKey.apiKey);
    expect(await authenticateAdminApiKeyFull({ workspaceId, actualKey: readKey.apiKey })).toBeNull();
    await db().delete(schema.adminApiKey).where(eq(schema.adminApiKey.id, replacement.id));
    const afterOldRevocation = unwrap(await createAdminApiKey({ workspaceId, name: readKey.name }));
    expect(afterOldRevocation.apiKey).not.toBe(replacement.apiKey);
    expect(await authenticateAdminApiKeyFull({ workspaceId, actualKey: replacement.apiKey })).toBeNull();
    expect(await authenticateAdminApiKeyFull({ workspaceId, actualKey: afterOldRevocation.apiKey })).not.toBeNull();
  });

  it("rejects invalid credentials and does not log supplied or persisted secrets", async () => {
    const debug = jest.spyOn(logger(), "debug");
    const info = jest.spyOn(logger(), "info");
    const error = jest.spyOn(logger(), "error");
    try {
      const supplied = "incorrect-credential-never-log";
      const response = await app.inject({
        method: "GET",
        url: `/api/admin/component-configurations?workspaceId=${workspaceId}&contact=contact-query-never-log`,
        headers: { ...headers(supplied), "x-admin-api-scopes": "read,write,destructive,sensitive" },
      });
      expect(response.statusCode).toBe(401);
      const created = await createKey();
      const logs = JSON.stringify([debug.mock.calls, info.mock.calls, error.mock.calls]);
      expect(logs).not.toContain(supplied);
      expect(logs).not.toContain(readKey.apiKey);
      expect(logs).not.toContain(created.apiKey);
      expect(logs).not.toContain("contact-query-never-log");
      expect(response.body).not.toContain(supplied);
      expect(response.body).not.toContain(readKey.apiKey);
    } finally {
      debug.mockRestore();
      info.mockRestore();
      error.mockRestore();
    }
  });

  it("rejects mismatched or ambiguous tenants and inactive workspaces", async () => {
    const other = unwrap(await createWorkspace({ name: randomUUID() }));
    expect((await app.inject({
      method: "GET",
      url: `/api/admin/component-configurations?workspaceId=${other.id}`,
      headers: headers(readKey.apiKey),
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "GET",
      url: `/api/admin/component-configurations?workspaceId=${workspaceId}&externalId=${other.id}`,
      headers: headers(readKey.apiKey),
    })).statusCode).toBe(400);
    await db().update(schema.workspace).set({ status: WorkspaceStatusDbEnum.Paused }).where(eq(schema.workspace.id, workspaceId));
    expect((await app.inject({
      method: "GET",
      url: `/api/admin/component-configurations?workspaceId=${workspaceId}`,
      headers: headers(readKey.apiKey),
    })).statusCode).toBe(401);
  });

  it("preserves parent-child authorization without widening the parent's grants", async () => {
    await db().update(schema.workspace).set({ type: WorkspaceTypeAppEnum.Parent }).where(eq(schema.workspace.id, workspaceId));
    const child = unwrap(await createWorkspace({ name: randomUUID(), type: WorkspaceTypeAppEnum.Child, parentWorkspaceId: workspaceId }));
    const query = `/api/admin/component-configurations?workspaceId=${child.id}`;
    const childHeaders = { authorization: `Bearer ${readKey.apiKey}`, [WORKSPACE_ID_HEADER]: child.id };
    expect((await app.inject({ method: "GET", url: query, headers: childHeaders })).statusCode).toBe(200);
    expect((await app.inject({
      method: "DELETE",
      url: `${query}&id=${randomUUID()}`,
      headers: childHeaders,
    })).statusCode).toBe(403);
    await db().update(schema.workspace).set({ status: WorkspaceStatusDbEnum.Paused }).where(and(eq(schema.workspace.id, workspaceId), eq(schema.workspace.type, WorkspaceTypeAppEnum.Parent)));
    expect((await app.inject({ method: "GET", url: query, headers: childHeaders })).statusCode).toBe(401);
  });
});

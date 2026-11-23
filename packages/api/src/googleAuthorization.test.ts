import { fastifyRequestContext } from "@fastify/request-context";
import secureSession from "@fastify/secure-session";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  createAccountSession,
  GoogleAccountPrincipal,
  revokeAccountSession,
} from "backend-lib/src/accounts";
import { createAdminApiKey } from "backend-lib/src/adminApiKeys";
import * as configModule from "backend-lib/src/config";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import {
  GOOGLE_ACCOUNT_COOKIE_NAME,
  GOOGLE_ACCOUNT_SESSION_NAME,
  googleSessionPluginOptions,
} from "backend-lib/src/googleSessions";
import { DittofeedFastifyInstance, Logger } from "backend-lib/src/types";
import { createHash, randomBytes, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import fastify, {
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { API_OPERATION_SCOPES } from "isomorphic-lib/src/apiOperations";
import { SecretNames, WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  AdminApiKeyPermission,
  AdminApiKeyType,
  EmailProviderType,
} from "isomorphic-lib/src/types";

import adminAuth, { authenticateAdminApiKeyFull } from "./buildApp/adminAuth";
import requestContext from "./buildApp/requestContext";
import apiKeyController from "./controllers/apiKeyController";
import publicationsController from "./controllers/publicationsController";
import secretsController from "./controllers/secretsController";
import { registerGoogleAccounts } from "./googleAccounts";

const originalConfig = configModule.default;
const origin = "http://localhost:3000";
let app: DittofeedFastifyInstance;
let memberId: string;
let workspaceId: string;
let cookies: Record<string, string>;
let principal: GoogleAccountPrincipal;

beforeEach(async () => {
  const base = originalConfig();
  jest.spyOn(configModule, "default").mockImplementation(() => ({
    ...base,
    authMode: "google",
    dashboardUrl: origin,
    secretKey: randomBytes(32).toString("hex"),
  }));
  // The configured key is stable during each server's lifetime.
  const settings = configModule.default();
  jest.mocked(configModule.default).mockReturnValue(settings);
  memberId = randomUUID();
  workspaceId = randomUUID();
  await db()
    .insert(schema.workspace)
    .values({ id: workspaceId, name: "Authorization test" });
  await db()
    .insert(schema.workspaceMember)
    .values({
      id: memberId,
      email: `${memberId}@example.test`,
      emailVerified: true,
      lastWorkspaceId: workspaceId,
    });
  await db()
    .insert(schema.googleAccount)
    .values({
      memberId,
      googleSubject: memberId,
      normalizedEmail: `${memberId}@example.test`,
    });
  await db()
    .insert(schema.workspaceMemberRole)
    .values({ workspaceId, workspaceMemberId: memberId, role: "Viewer" });
  const session = await createAccountSession({ memberId });
  principal = session.principal;
  app = fastify<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    Logger
  >().withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyRequestContext);
  await app.register(secureSession, googleSessionPluginOptions(settings));
  await registerGoogleAccounts(app);
  await app.register(async (scope) => {
    await scope.register(requestContext);
    scope.get("/api/users", (_request, reply) => reply.send({ allowed: true }));
    scope.post("/api/users", (_request, reply) =>
      reply.send({ allowed: true }),
    );
    scope.put("/api/content/templates", (_request, reply) =>
      reply.send({ allowed: true }),
    );
    scope.post("/api/content/templates/render", (_request, reply) =>
      reply.send({ allowed: true }),
    );
    scope.get("/api/settings/probe", (_request, reply) =>
      reply.send({ allowed: true }),
    );
    await scope.register(apiKeyController, { prefix: "/api/admin-keys" });
    await scope.register(secretsController, { prefix: "/api/secrets" });
    await scope.register(publicationsController, {
      prefix: "/api/publications",
    });
  });
  await app.register(async (scope) => {
    await scope.register(adminAuth);
    await scope.register(apiKeyController, { prefix: "/api/admin/admin-keys" });
    await scope.register(secretsController, { prefix: "/api/admin/secrets" });
  });
  await app.ready();
  cookies = {
    [GOOGLE_ACCOUNT_COOKIE_NAME]: app.encodeSecureSession(
      app.createSecureSession({ token: session.token }),
      GOOGLE_ACCOUNT_SESSION_NAME,
    ),
  };
});

afterEach(async () => {
  await app.close();
  jest.restoreAllMocks();
  await db()
    .delete(schema.workspace)
    .where(eq(schema.workspace.id, workspaceId));
  await db()
    .delete(schema.workspaceMember)
    .where(eq(schema.workspaceMember.id, memberId));
});

test("public OAuth status is not captured by the protected API hook", async () => {
  expect((await app.inject("/api/public/auth/google/status")).statusCode).toBe(
    200,
  );
  expect(
    (await app.inject(`/api/users?workspaceId=${workspaceId}`)).statusCode,
  ).toBe(401);
});

test.each(["membership", "origin", "role"])(
  "authorization failures preserve HTTP 403 on publication routes: %s",
  async (reason) => {
    if (reason === "membership") {
      await db()
        .delete(schema.workspaceMemberRole)
        .where(
          and(
            eq(schema.workspaceMemberRole.workspaceId, workspaceId),
            eq(schema.workspaceMemberRole.workspaceMemberId, memberId),
          ),
        );
    }
    const response = await app.inject({
      method: reason === "membership" ? "GET" : "POST",
      url: `/api/publications/?workspaceId=${workspaceId}`,
      cookies,
      headers: {
        origin: reason === "origin" ? "https://foreign.example.test" : origin,
      },
      payload:
        reason === "membership"
          ? undefined
          : { workspaceId, name: "Forbidden", slug: "forbidden" },
    });
    expect(response.statusCode).toBe(403);
    const body = response.json<{ code: string; message: string }>();
    expect(body.code).toBe(reason === "membership" ? "no_access" : "forbidden");
    expect(typeof body.message).toBe("string");
  },
);

test("legacy session and identity headers cannot authenticate the standard API", async () => {
  const response = await app.inject({
    url: `/api/users?workspaceId=${workspaceId}`,
    headers: {
      cookie: "session=legacy",
      "x-session": "true",
      "x-workspace-member-id": memberId,
      authorization: "Bearer eyJhbGciOiJub25lIn0.e30.",
    },
  });
  expect(response.statusCode).toBe(401);
});

test("Viewers can browse and search but cannot enter settings or mutate drafts", async () => {
  expect(
    (
      await app.inject({
        url: `/api/users?workspaceId=${workspaceId}`,
        cookies,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/users?workspaceId=${workspaceId}`,
        cookies,
        headers: { origin },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/content/templates?workspaceId=${workspaceId}`,
        cookies,
        headers: { origin },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/content/templates/render?workspaceId=${workspaceId}`,
        cookies,
        headers: { origin },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: `/api/settings/probe?workspaceId=${workspaceId}`,
        cookies,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: `/api/admin-keys?workspaceId=${workspaceId}`,
        cookies,
      })
    ).statusCode,
  ).toBe(403);
});

test("workspace isolation and session revocation apply to standard data APIs", async () => {
  expect(
    (
      await app.inject({
        url: `/api/users?workspaceId=${randomUUID()}`,
        cookies,
      })
    ).statusCode,
  ).toBe(403);
  await revokeAccountSession(principal, principal.sessionId);
  expect(
    (
      await app.inject({
        url: `/api/users?workspaceId=${workspaceId}`,
        cookies,
      })
    ).statusCode,
  ).toBe(401);
});

test("Origin and current database roles are enforced rather than trusting stale cookies", async () => {
  await db()
    .update(schema.workspaceMemberRole)
    .set({ role: "Admin" })
    .where(
      and(
        eq(schema.workspaceMemberRole.workspaceId, workspaceId),
        eq(schema.workspaceMemberRole.workspaceMemberId, memberId),
      ),
    );
  expect(
    (
      await app.inject({
        url: `/api/admin-keys?workspaceId=${workspaceId}`,
        cookies,
      })
    ).statusCode,
  ).toBe(200);
  await Promise.all(
    [undefined, "https://untrusted.example"].map(async (suppliedOrigin) => {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/content/templates?workspaceId=${workspaceId}`,
            cookies,
            headers: suppliedOrigin ? { origin: suppliedOrigin } : {},
          })
        ).statusCode,
      ).toBe(403);
    }),
  );
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/content/templates?workspaceId=${workspaceId}`,
        cookies,
        headers: { origin },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url: `/api/users?workspaceId=${workspaceId}`,
        cookies,
        headers: { origin: "https://untrusted.example" },
      })
    ).statusCode,
  ).toBe(403);
  await db()
    .update(schema.workspaceMemberRole)
    .set({ role: "Viewer" })
    .where(
      and(
        eq(schema.workspaceMemberRole.workspaceId, workspaceId),
        eq(schema.workspaceMemberRole.workspaceMemberId, memberId),
      ),
    );
  expect(
    (
      await app.inject({
        url: `/api/admin-keys?workspaceId=${workspaceId}`,
        cookies,
      })
    ).statusCode,
  ).toBe(403);
});

test("WorkspaceManagers cannot replace a persisted reader credential through provider secrets", async () => {
  await db()
    .update(schema.workspaceMemberRole)
    .set({ role: "WorkspaceManager" })
    .where(
      and(
        eq(schema.workspaceMemberRole.workspaceId, workspaceId),
        eq(schema.workspaceMemberRole.workspaceMemberId, memberId),
      ),
    );
  const readKey = unwrap(
    await createAdminApiKey({ workspaceId, name: "reader", scopes: ["read"] }),
  );
  const secret = await db().query.secret.findFirst({
    where: and(
      eq(schema.secret.workspaceId, workspaceId),
      eq(schema.secret.name, "df-admin-api-key-reader"),
    ),
  });
  if (!secret) throw new Error("Missing persisted reader credential");
  const chosenToken = "manager-chosen-replacement-token";
  const replacement = {
    keyHash: createHash("sha256").update(chosenToken).digest("hex"),
    permissions: [AdminApiKeyPermission.Admin],
    scopes: API_OPERATION_SCOPES,
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin-keys",
        cookies,
        headers: { origin },
        payload: {
          workspaceId,
          name: "manager-minted",
          scopes: API_OPERATION_SCOPES,
        },
      })
    ).statusCode,
  ).toBe(403);

  // Omitted and spoofed types must not bypass the persisted credential boundary.
  await Promise.all(
    [
      { configValue: replacement },
      { configValue: { ...replacement, type: EmailProviderType.Telnyx } },
      { value: chosenToken },
    ].map(async (patch) => {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/secrets",
            cookies,
            headers: { origin },
            payload: { workspaceId, name: secret.name, ...patch },
          })
        ).statusCode,
      ).toBe(403);
    }),
  );
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/secrets?workspaceId=${workspaceId}&id=${secret.id}`,
        cookies,
        headers: { origin },
      })
    ).statusCode,
  ).toBe(403);
  await Promise.all(
    [
      {
        workspaceId,
        name: "provider-looking-secret",
        configValue: { ...replacement, type: AdminApiKeyType.AdminApiKey },
      },
      {
        workspaceId,
        name: "df-admin-api-key-new",
        configValue: { type: EmailProviderType.Telnyx },
      },
    ].map(async (payload) => {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/secrets",
            cookies,
            headers: { origin },
            payload,
          })
        ).statusCode,
      ).toBe(403);
    }),
  );
  expect(
    await db().query.secret.findFirst({
      where: eq(schema.secret.id, secret.id),
    }),
  ).toEqual(secret);
  expect(
    await authenticateAdminApiKeyFull({
      workspaceId,
      actualKey: readKey.apiKey,
    }),
  ).toMatchObject({ keyId: readKey.id, scopes: ["read"] });
  expect(
    await authenticateAdminApiKeyFull({
      workspaceId,
      actualKey: chosenToken,
    }),
  ).toBeNull();
  await Promise.all(
    (
      [
        [chosenToken, 401],
        [readKey.apiKey, 403],
      ] as const
    ).map(async ([token, status]) => {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/admin-keys",
            headers: {
              authorization: `Bearer ${token}`,
              [WORKSPACE_ID_HEADER]: workspaceId,
            },
            payload: {
              workspaceId,
              name: "escalated",
              scopes: API_OPERATION_SCOPES,
            },
          })
        ).statusCode,
      ).toBe(status);
    }),
  );
  expect(
    await db()
      .select()
      .from(schema.adminApiKey)
      .where(eq(schema.adminApiKey.workspaceId, workspaceId)),
  ).toHaveLength(1);

  // Provider writes still merge partial updates for an authorized manager.
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/secrets",
        cookies,
        headers: { origin },
        payload: {
          workspaceId,
          name: SecretNames.Telnyx,
          configValue: {
            type: EmailProviderType.Telnyx,
            apiKey: "provider-credential",
            sandboxMode: false,
          },
        },
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/secrets",
        cookies,
        headers: { origin },
        payload: {
          workspaceId,
          name: SecretNames.Telnyx,
          configValue: { sandboxMode: true },
        },
      })
    ).statusCode,
  ).toBe(204);
  const providerSecret = await db().query.secret.findFirst({
    where: and(
      eq(schema.secret.workspaceId, workspaceId),
      eq(schema.secret.name, SecretNames.Telnyx),
    ),
  });
  expect(providerSecret?.configValue).toEqual({
    type: EmailProviderType.Telnyx,
    apiKey: "provider-credential",
    sandboxMode: true,
  });
  if (!providerSecret) throw new Error("Missing provider secret");
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/secrets?workspaceId=${workspaceId}&id=${providerSecret.id}`,
        cookies,
        headers: { origin },
      })
    ).statusCode,
  ).toBe(204);
});

test.each([false, true])(
  "linked credentials stay protected after renaming with a spoofed stored type: %s",
  async (spoofStoredType) => {
    await db()
      .update(schema.workspaceMemberRole)
      .set({ role: "WorkspaceManager" })
      .where(
        and(
          eq(schema.workspaceMemberRole.workspaceId, workspaceId),
          eq(schema.workspaceMemberRole.workspaceMemberId, memberId),
        ),
      );
    const readKey = unwrap(
      await createAdminApiKey({
        workspaceId,
        name: "reader",
        scopes: ["read"],
      }),
    );
    const key = await db().query.adminApiKey.findFirst({
      where: eq(schema.adminApiKey.id, readKey.id),
    });
    if (!key) throw new Error("Missing persisted reader key");
    const [secret] = await db()
      .update(schema.secret)
      .set({
        name: "provider-looking-secret",
        ...(spoofStoredType
          ? {
              configValue: {
                type: EmailProviderType.Telnyx,
                apiKey: "stale-provider-value",
              },
            }
          : {}),
      })
      .where(eq(schema.secret.id, key.secretId))
      .returning();
    if (!secret) throw new Error("Missing linked credential secret");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/secrets",
          cookies,
          headers: { origin },
          payload: {
            workspaceId,
            name: secret.name,
            configValue: {
              type: EmailProviderType.Telnyx,
              keyHash: createHash("sha256")
                .update("renamed-replacement-token")
                .digest("hex"),
              scopes: API_OPERATION_SCOPES,
            },
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/secrets?workspaceId=${workspaceId}&id=${secret.id}`,
          cookies,
          headers: { origin },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      await db().query.secret.findFirst({
        where: eq(schema.secret.id, secret.id),
      }),
    ).toEqual(secret);
    expect(
      await db().query.adminApiKey.findFirst({
        where: eq(schema.adminApiKey.id, readKey.id),
      }),
    ).toEqual(key);
  },
);

test("scoped bearer keys cannot use generic secrets to acquire credential administration", async () => {
  const readKey = unwrap(
    await createAdminApiKey({ workspaceId, name: "reader", scopes: ["read"] }),
  );
  const partialKey = unwrap(
    await createAdminApiKey({
      workspaceId,
      name: "partial",
      scopes: ["read", "write", "sensitive"],
    }),
  );
  const fullKey = unwrap(
    await createAdminApiKey({
      workspaceId,
      name: "full",
      scopes: [...API_OPERATION_SCOPES],
    }),
  );
  const chosenToken = "machine-chosen-replacement-token";
  await Promise.all(
    [partialKey.apiKey, fullKey.apiKey].map(async (token) => {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/admin/secrets",
            headers: {
              authorization: `Bearer ${token}`,
              [WORKSPACE_ID_HEADER]: workspaceId,
            },
            payload: {
              workspaceId,
              name: "df-admin-api-key-reader",
              configValue: {
                keyHash: createHash("sha256").update(chosenToken).digest("hex"),
                scopes: API_OPERATION_SCOPES,
              },
            },
          })
        ).statusCode,
      ).toBe(403);
    }),
  );
  expect(
    await authenticateAdminApiKeyFull({
      workspaceId,
      actualKey: readKey.apiKey,
    }),
  ).toMatchObject({ keyId: readKey.id, scopes: ["read"] });
  expect(
    await authenticateAdminApiKeyFull({
      workspaceId,
      actualKey: chosenToken,
    }),
  ).toBeNull();
  await Promise.all(
    (
      [
        [chosenToken, 401],
        [readKey.apiKey, 403],
        [partialKey.apiKey, 403],
        [fullKey.apiKey, 200],
      ] as const
    ).map(async ([token, status]) => {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/admin-keys",
            headers: {
              authorization: `Bearer ${token}`,
              [WORKSPACE_ID_HEADER]: workspaceId,
            },
            payload: {
              workspaceId,
              name: "dedicated-lifecycle-key",
              scopes: API_OPERATION_SCOPES,
            },
          })
        ).statusCode,
      ).toBe(status);
    }),
  );
});

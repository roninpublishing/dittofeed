import { fastifyRequestContext } from "@fastify/request-context";
import secureSession from "@fastify/secure-session";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  createAccountSession,
  GoogleAccountPrincipal,
  revokeAccountSession,
} from "backend-lib/src/accounts";
import * as configModule from "backend-lib/src/config";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import {
  GOOGLE_ACCOUNT_COOKIE_NAME,
  GOOGLE_ACCOUNT_SESSION_NAME,
  googleSessionPluginOptions,
} from "backend-lib/src/googleSessions";
import { DittofeedFastifyInstance, Logger } from "backend-lib/src/types";
import { randomBytes, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import fastify, {
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import requestContext from "./buildApp/requestContext";
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
    scope.get("/api/admin-keys", (_request, reply) =>
      reply.send({ allowed: true }),
    );
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

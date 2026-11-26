import { fastifyRequestContext } from "@fastify/request-context";
import { createAccountSession } from "backend-lib/src/accounts";
import { createAdminApiKey, provisionOwnerAdminApiKey } from "backend-lib/src/adminApiKeys";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import fastify, { FastifyInstance } from "fastify";
import { API_OPERATION_SCOPES, requiredApiScopes } from "isomorphic-lib/src/apiOperations";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  AdminApiKeyScope,
  ChannelType,
  CreateAdminApiKeyResponse,
  EmailContentsType,
  EmailTemplateResource,
  GetMessageTemplatesResponse,
  JsonResultType,
  RenderMessageTemplateResponse,
  RenderMessageTemplateType,
  UpsertMessageTemplateValidationErrorType,
} from "isomorphic-lib/src/types";
import { TYPE_REFS } from "isomorphic-lib/src/typeRefs";

import adminAuth, { authenticateAdminApiKeyFull } from "../buildApp/adminAuth";
import accountController from "./accountController";
import apiKeyController from "./apiKeyController";
import broadcastsController from "./broadcastsController";
import contentController from "./contentController";
import publicationsController from "./publicationsController";

let app: FastifyInstance;
let workspaceId: string;
let foreignWorkspaceId: string;
let ownerId: string;
let viewerId: string;
let foreignMemberId: string;
let ownerKey: CreateAdminApiKeyResponse;
const createdWorkspaces: string[] = [];

const headers = (key = ownerKey.apiKey, scope = workspaceId) => ({
  authorization: `Bearer ${key}`,
  [WORKSPACE_ID_HEADER]: scope,
});

beforeEach(async () => {
  workspaceId = randomUUID();
  foreignWorkspaceId = randomUUID();
  ownerId = randomUUID();
  viewerId = randomUUID();
  foreignMemberId = randomUUID();
  createdWorkspaces.push(workspaceId, foreignWorkspaceId);
  await db().insert(schema.workspace).values([
    { id: workspaceId, name: randomUUID() },
    { id: foreignWorkspaceId, name: randomUUID() },
  ]);
  for (const [memberId, scope, role] of [
    [ownerId, workspaceId, "Admin"], [viewerId, workspaceId, "Viewer"], [foreignMemberId, foreignWorkspaceId, "Admin"],
  ] as const) {
    await db().insert(schema.workspaceMember).values({ id: memberId, email: `${memberId}@example.test`, emailVerified: true });
    await db().insert(schema.googleAccount).values({ memberId, googleSubject: memberId, normalizedEmail: `${memberId}@example.test`, isInstanceAdmin: memberId === ownerId });
    await db().insert(schema.workspaceMemberRole).values({ workspaceId: scope, workspaceMemberId: memberId, role });
  }
  ownerKey = unwrap(await provisionOwnerAdminApiKey({ workspaceId, name: randomUUID(), scopes: [...API_OPERATION_SCOPES] }, ownerId));
  app = fastify();
  TYPE_REFS.forEach((definition) => app.addSchema(definition));
  await app.register(fastifyRequestContext);
  await app.register(adminAuth);
  await app.register(accountController, { prefix: "/api/admin/account" });
  await app.register(apiKeyController, { prefix: "/api/admin/admin-keys" });
  await app.register(contentController, { prefix: "/api/admin/content" });
  await app.register(publicationsController, { prefix: "/api/admin/publications" });
  await app.register(broadcastsController, { prefix: "/api/admin/broadcasts", admin: true });
});

afterEach(async () => {
  await app.close();
  await db().delete(schema.workspace).where(inArray(schema.workspace.id, createdWorkspaces.splice(0)));
  await db().delete(schema.workspaceMember).where(inArray(schema.workspaceMember.id, [ownerId, viewerId, foreignMemberId]));
});

test("requires all four scopes for every account operation, including reads", async () => {
  for (const method of ["GET", "PATCH", "POST", "DELETE"]) {
    expect(requiredApiScopes(method, "/api/admin/account/team")).toEqual(API_OPERATION_SCOPES);
  }
  for (const scopes of [["read"], ["write", "sensitive"], ["read", "write", "sensitive"]] as AdminApiKeyScope[][]) {
    const session = await createAccountSession({ memberId: ownerId });
    const key = unwrap(await createAdminApiKey({ workspaceId, name: randomUUID(), scopes }, session.principal));
    expect((await app.inject({ url: "/api/admin/account", headers: headers(key.apiKey) })).statusCode).toBe(403);
  }
  const unowned = unwrap(await createAdminApiKey({ workspaceId, name: randomUUID(), scopes: [...API_OPERATION_SCOPES] }));
  expect((await app.inject({ url: "/api/admin/account", headers: headers(unowned.apiKey) })).statusCode).toBe(401);
});

test("exposes genuine delegated profile/name/workspace controls, without accepting owner input", async () => {
  const profile = await app.inject({ url: "/api/admin/account", headers: headers() });
  expect(profile.statusCode).toBe(200);
  expect(profile.json()).toMatchObject({ member: { id: ownerId }, currentKeyId: ownerKey.id });
  expect(profile.json()).not.toHaveProperty("currentSessionId");
  const changed = await app.inject({ method: "PATCH", url: "/api/admin/account", headers: headers(), payload: { name: "Machine owner", memberId: viewerId, ownerMemberId: viewerId, isInstanceAdmin: false } });
  expect(changed.statusCode).toBe(200);
  expect(changed.json()).toMatchObject({ member: { id: ownerId, name: "Machine owner" }, isInstanceAdmin: true });
  expect((await app.inject({ method: "POST", url: "/api/admin/account/workspace", headers: headers(), payload: { workspaceId } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/api/admin/account/workspace", headers: headers(), payload: { workspaceId: foreignWorkspaceId } })).statusCode).toBe(400);
  const inherited = await app.inject({ method: "POST", url: "/api/admin/admin-keys", headers: headers(), payload: { workspaceId, name: randomUUID(), ownerMemberId: viewerId, scopes: [...API_OPERATION_SCOPES] } });
  expect(inherited.statusCode).toBe(200);
  const child = inherited.json<CreateAdminApiKeyResponse>();
  expect((await app.inject({ url: "/api/admin/account", headers: headers(child.apiKey) })).json()).toMatchObject({ member: { id: ownerId } });
});

test("administers invitations and team roles without bypassing last-admin or tenant guards", async () => {
  const invite = await app.inject({ method: "POST", url: "/api/admin/account/invitations", headers: headers(), payload: { workspaceId, email: "invite@example.test", role: "Author" } });
  expect(invite.statusCode).toBe(200);
  expect(invite.json().url).toContain("/dashboard/auth/invite#token=");
  const invitationId: string = invite.json().invitation.id;
  expect((await app.inject({ url: `/api/admin/account/team?workspaceId=${workspaceId}`, headers: headers() })).json().invitations).toEqual(expect.arrayContaining([expect.objectContaining({ id: invitationId })]));
  expect((await app.inject({ method: "DELETE", url: `/api/admin/account/invitations/${invitationId}?workspaceId=${workspaceId}`, headers: headers() })).statusCode).toBe(200);
  expect((await app.inject({ method: "PATCH", url: `/api/admin/account/members/${viewerId}/role`, headers: headers(), payload: { workspaceId, role: "Author" } })).statusCode).toBe(200);
  expect((await app.inject({ method: "PATCH", url: `/api/admin/account/members/${ownerId}/role`, headers: headers(), payload: { workspaceId, role: "Viewer" } })).statusCode).toBe(409);
  expect((await app.inject({ method: "DELETE", url: `/api/admin/account/members/${ownerId}?workspaceId=${workspaceId}`, headers: headers() })).statusCode).toBe(409);
  expect((await app.inject({ method: "DELETE", url: `/api/admin/account/members/${foreignMemberId}?workspaceId=${workspaceId}`, headers: headers() })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: `/api/admin/account/members/${foreignMemberId}/disabled`, headers: headers(), payload: { disabled: true } })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: `/api/admin/account/members/${viewerId}/disabled`, headers: headers(), payload: { disabled: true } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/admin/account/members/${viewerId}/disabled`, headers: headers(), payload: { disabled: false } })).statusCode).toBe(200);
  expect((await app.inject({ method: "DELETE", url: `/api/admin/account/members/${viewerId}?workspaceId=${workspaceId}`, headers: headers() })).statusCode).toBe(200);
});

test("revokes real browser sessions and logout revokes the actual current machine key", async () => {
  const browser = await createAccountSession({ memberId: ownerId });
  const listed = await app.inject({ url: "/api/admin/account/sessions", headers: headers() });
  expect(listed.json()).toEqual([expect.objectContaining({ id: browser.principal.sessionId, current: false })]);
  expect((await app.inject({ method: "DELETE", url: `/api/admin/account/sessions/${browser.principal.sessionId}`, headers: headers() })).statusCode).toBe(200);
  const second = await createAccountSession({ memberId: ownerId });
  expect((await app.inject({ method: "POST", url: "/api/admin/account/sessions/revoke-others", headers: headers() })).statusCode).toBe(200);
  const revoked = await db().query.accountSession.findFirst({ where: eq(schema.accountSession.id, second.principal.sessionId) });
  expect(revoked?.revokedAt).not.toBeNull();
  expect((await app.inject({ method: "POST", url: "/api/admin/account/logout", headers: headers() })).statusCode).toBe(200);
  expect((await app.inject({ url: "/api/admin/account", headers: headers() })).statusCode).toBe(401);
  expect(await db().query.adminApiKey.findFirst({ where: eq(schema.adminApiKey.id, ownerKey.id) })).toBeUndefined();
});

test("takes owner demotion, disablement, removal and key revocation into account on the next product call", async () => {
  await db().update(schema.workspaceMemberRole).set({ role: "Viewer" }).where(and(eq(schema.workspaceMemberRole.workspaceId, workspaceId), eq(schema.workspaceMemberRole.workspaceMemberId, ownerId)));
  expect((await app.inject({ method: "PUT", url: "/api/admin/content/templates", headers: headers(), payload: { workspaceId, name: randomUUID() } })).statusCode).toBe(403);
  await db().update(schema.googleAccount).set({ disabledAt: new Date() }).where(eq(schema.googleAccount.memberId, ownerId));
  expect(await authenticateAdminApiKeyFull({ workspaceId, actualKey: ownerKey.apiKey })).toBeNull();
  expect((await app.inject({ url: `/api/admin/content/templates?workspaceId=${workspaceId}`, headers: headers() })).statusCode).toBe(401);
  await db().update(schema.googleAccount).set({ disabledAt: null }).where(eq(schema.googleAccount.memberId, ownerId));
  await db().delete(schema.workspaceMemberRole).where(and(eq(schema.workspaceMemberRole.workspaceId, workspaceId), eq(schema.workspaceMemberRole.workspaceMemberId, ownerId)));
  expect((await app.inject({ url: `/api/admin/content/templates?workspaceId=${workspaceId}`, headers: headers() })).statusCode).toBe(403);
  await db().delete(schema.adminApiKey).where(eq(schema.adminApiKey.id, ownerKey.id));
  expect((await app.inject({ url: `/api/admin/content/templates?workspaceId=${workspaceId}`, headers: headers() })).statusCode).toBe(401);
});

test("uses the bound owner for Gmail inspection and creating a new workspace, without sending or changing providers", async () => {
  const gmail = await app.inject({ url: `/api/admin/broadcasts/gmail-authorization?workspaceId=${workspaceId}`, headers: headers() });
  expect(gmail.statusCode).toBe(200);
  expect(gmail.json()).toEqual({ authorized: false });
  const unowned = unwrap(await createAdminApiKey({ workspaceId, name: randomUUID(), scopes: [...API_OPERATION_SCOPES] }));
  expect((await app.inject({ url: `/api/admin/broadcasts/gmail-authorization?workspaceId=${workspaceId}`, headers: headers(unowned.apiKey) })).statusCode).toBe(403);
  const created = await app.inject({ method: "POST", url: "/api/admin/publications/publisher", headers: headers(), payload: { workspaceId, name: randomUUID(), createNewWorkspace: true } });
  expect(created.statusCode).toBe(200);
  const newWorkspaceId: string = created.json().data.id;
  createdWorkspaces.push(newWorkspaceId);
  expect(await db().query.workspaceMemberRole.findFirst({ where: and(eq(schema.workspaceMemberRole.workspaceId, newWorkspaceId), eq(schema.workspaceMemberRole.workspaceMemberId, ownerId)) })).toMatchObject({ role: "Admin" });
  // Creation grants the human a workspace, not this workspace-bound machine key.
  expect((await app.inject({ url: "/api/admin/account", headers: headers(ownerKey.apiKey, newWorkspaceId) })).statusCode).toBe(401);
});

test("full owner control creates, reads, edits and renders templates without any send", async () => {
  const name = randomUUID();
  const missingContent = await app.inject({
    method: "PUT",
    url: "/api/admin/content/templates",
    headers: headers(),
    payload: { workspaceId, name },
  });
  expect(missingContent.statusCode).toBe(400);
  expect(missingContent.json()).toMatchObject({
    type: UpsertMessageTemplateValidationErrorType.MissingContent,
  });
  expect(await db().query.messageTemplate.findFirst({
    where: and(
      eq(schema.messageTemplate.workspaceId, workspaceId),
      eq(schema.messageTemplate.name, name),
    ),
  })).toBeUndefined();

  const definition = {
    type: ChannelType.Email,
    emailContentsType: EmailContentsType.Code,
    from: "owner@example.test",
    subject: "Original subject",
    body: "Original hello {{ user.firstName }}",
  } satisfies EmailTemplateResource;
  const created = await app.inject({
    method: "PUT",
    url: "/api/admin/content/templates",
    headers: headers(),
    payload: { workspaceId, name, definition },
  });
  expect(created.statusCode).toBe(200);
  const id: string = created.json().id;
  const editedDefinition = {
    ...definition,
    subject: "Edited subject",
    body: "Edited hello {{ user.firstName }}",
  };
  const changed = await app.inject({
    method: "PUT",
    url: "/api/admin/content/templates",
    headers: headers(),
    payload: {
      workspaceId,
      id,
      name: "Machine-edited template",
      definition: editedDefinition,
    },
  });
  expect(changed.statusCode).toBe(200);
  const listed = await app.inject({
    url: `/api/admin/content/templates?workspaceId=${workspaceId}`,
    headers: headers(),
  });
  expect(listed.statusCode).toBe(200);
  const saved = listed.json<GetMessageTemplatesResponse>().templates.find(
    (template) => template.id === id,
  );
  expect(saved).toMatchObject({
    id,
    name: "Machine-edited template",
    definition: editedDefinition,
  });
  if (saved?.definition?.type !== ChannelType.Email ||
      typeof saved.definition.body !== "string") {
    throw new Error("Expected the saved code email definition");
  }
  const rendered = await app.inject({
    method: "POST",
    url: "/api/admin/content/templates/render",
    headers: headers(),
    payload: {
      workspaceId,
      channel: saved.definition.type,
      userProperties: { firstName: "Owner" },
      contents: {
        body: {
          type: RenderMessageTemplateType.PlainText,
          value: saved.definition.body,
        },
        subject: {
          type: RenderMessageTemplateType.PlainText,
          value: saved.definition.subject,
        },
      },
    },
  });
  expect(rendered.statusCode).toBe(200);
  expect(rendered.json<RenderMessageTemplateResponse>()).toEqual({
    contents: {
      body: { type: JsonResultType.Ok, value: "Edited hello Owner" },
      subject: { type: JsonResultType.Ok, value: "Edited subject" },
    },
  });
});

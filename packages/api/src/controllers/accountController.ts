import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  AccountError,
  ApiKeyAccountPrincipal,
  createWorkspaceInvitation,
  getAccountProfile,
  getAccountTeam,
  listAccountSessions,
  logoutApiKeyAccount,
  removeAccountMember,
  revokeAccountSession,
  revokeOtherAccountSessions,
  revokeWorkspaceInvitation,
  selectAccountWorkspace,
  setAccountDisabled,
  updateAccountMemberRole,
  updateAccountProfile,
} from "backend-lib/src/accounts";
import config from "backend-lib/src/config";
import { FastifyInstance, FastifyRequest } from "fastify";
import {
  AccountSessionResource,
  AccountSuccess,
  AccountTeamResponse,
  CreateAccountInvitationRequest,
  CreateAccountInvitationResponse,
  MachineAccountProfile,
  UpdateAccountMemberRoleRequest,
  UpdateAccountProfileRequest,
} from "isomorphic-lib/src/accounts";

const WorkspaceQuery = Type.Object({ workspaceId: Type.String({ format: "uuid" }) });
const MemberParams = Type.Object({ memberId: Type.String({ format: "uuid" }) });
const AccountFailure = Type.Object({ code: Type.Optional(Type.String()), message: Type.String() });
const failures = { 400: AccountFailure, 401: AccountFailure, 403: AccountFailure, 409: AccountFailure, 500: AccountFailure };

function principal(request: FastifyRequest): ApiKeyAccountPrincipal {
  if (!request.apiKeyAccountPrincipal) throw new AccountError("not_authenticated", 401);
  return request.apiKeyAccountPrincipal;
}

/** Account controls use only server-bound machine identity, never ambient cookies. */
// eslint-disable-next-line @typescript-eslint/require-await
export default async function accountController(app: FastifyInstance) {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>();
  const options = { bodyLimit: 8192, logLevel: "silent" as const };
  const base = { tags: ["Account", "Admin"] };
  routes.addHook("onRequest", async (_request, reply) => {
    void reply.header("Cache-Control", "no-store");
    void reply.header("Pragma", "no-cache");
    void reply.header("Referrer-Policy", "no-referrer");
  });
  routes.setErrorHandler((error, _request, reply) => {
    if (error instanceof AccountError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.code });
    }
    const status = error.validation ? 400 : 500;
    const code = status === 400 ? "invalid_request" : "account_error";
    return reply.code(status).send({ code, message: code });
  });
  routes.get("/", {
    ...options,
    schema: { ...base, description: "Read the delegated owner's profile, scoped membership and current machine key. No browser session is current.", response: { 200: MachineAccountProfile, ...failures } },
  }, async (request) => getAccountProfile(principal(request)));
  routes.patch("/", {
    ...options,
    schema: { ...base, description: "Update the delegated owner's display name. Identity and privileges are immutable through profile input.", body: UpdateAccountProfileRequest, response: { 200: MachineAccountProfile, ...failures } },
  }, async (request) => updateAccountProfile(principal(request), request.body));
  routes.post("/workspace", {
    ...options,
    schema: { ...base, description: "Set the owner's last workspace to the authenticated scope only. Does not change the machine client's configured binding.", body: WorkspaceQuery, response: { 200: AccountSuccess, ...failures } },
  }, async (request) => {
    await selectAccountWorkspace(principal(request), request.body.workspaceId);
    return { success: true as const };
  });
  routes.get("/sessions", {
    ...options,
    schema: { ...base, description: "List the owner's live browser sessions. A machine key marks none as current.", response: { 200: Type.Array(AccountSessionResource), ...failures } },
  }, async (request) => listAccountSessions(principal(request)));
  routes.delete("/sessions/:sessionId", {
    ...options,
    schema: { ...base, description: "Revoke one browser session belonging to the delegated owner.", params: Type.Object({ sessionId: Type.String({ format: "uuid" }) }), response: { 200: AccountSuccess, ...failures } },
  }, async (request) => {
    await revokeAccountSession(principal(request), request.params.sessionId);
    return { success: true as const };
  });
  routes.post("/sessions/revoke-others", {
    ...options,
    schema: { ...base, description: "Revoke all of the owner's browser sessions, retaining this machine credential. A key has no browser session to exempt.", response: { 200: AccountSuccess, ...failures } },
  }, async (request) => {
    await revokeOtherAccountSessions(principal(request));
    return { success: true as const };
  });
  routes.post("/logout", {
    ...options,
    schema: { ...base, description: "Revoke this machine API key and its secret. Subsequent calls using it are unauthorized; browser sessions are unchanged.", response: { 200: AccountSuccess, ...failures } },
  }, async (request) => {
    await logoutApiKeyAccount(principal(request));
    return { success: true as const };
  });
  routes.get("/team", {
    ...options,
    schema: { ...base, description: "Read authorized workspace members, invitations and the owner's current management role.", querystring: WorkspaceQuery, response: { 200: AccountTeamResponse, ...failures } },
  }, async (request) => getAccountTeam(principal(request), request.query.workspaceId));
  routes.post("/invitations", {
    ...options,
    schema: { ...base, description: "Create an invitation within the delegated owner's role authority. Returns a private sign-in link; does not send email.", body: CreateAccountInvitationRequest, response: { 200: CreateAccountInvitationResponse, ...failures } },
  }, async (request) => {
    const result = await createWorkspaceInvitation(principal(request), request.body);
    return { invitation: result.invitation, url: `${new URL(config().dashboardUrl).origin}/dashboard/auth/invite#token=${encodeURIComponent(result.token)}` };
  });
  routes.delete("/invitations/:id", {
    ...options,
    schema: { ...base, description: "Revoke a pending invitation in the authorized workspace.", params: Type.Object({ id: Type.String({ format: "uuid" }) }), querystring: WorkspaceQuery, response: { 200: AccountSuccess, ...failures } },
  }, async (request) => {
    await revokeWorkspaceInvitation(principal(request), { workspaceId: request.query.workspaceId, invitationId: request.params.id });
    return { success: true as const };
  });
  routes.patch("/members/:memberId/role", {
    ...options,
    schema: { ...base, description: "Change a member role without exceeding the owner's authority or removing the last active administrator.", params: MemberParams, body: UpdateAccountMemberRoleRequest, response: { 200: AccountSuccess, ...failures } },
  }, async (request) => {
    await updateAccountMemberRole(principal(request), { ...request.body, memberId: request.params.memberId });
    return { success: true as const };
  });
  routes.delete("/members/:memberId", {
    ...options,
    schema: { ...base, description: "Remove workspace access, preserving the account, other memberships and authored resources. Protects the last administrator.", params: MemberParams, querystring: WorkspaceQuery, response: { 200: AccountSuccess, ...failures } },
  }, async (request) => {
    await removeAccountMember(principal(request), { workspaceId: request.query.workspaceId, memberId: request.params.memberId });
    return { success: true as const };
  });
  routes.post("/members/:memberId/disabled", {
    ...options,
    schema: { ...base, description: "An instance-admin owner may disable or enable an account belonging exclusively to the authorized workspace. Shared/foreign identities and last administrators are protected.", params: MemberParams, body: Type.Object({ disabled: Type.Boolean() }, { additionalProperties: false }), response: { 200: AccountSuccess, ...failures } },
  }, async (request) => {
    await setAccountDisabled(principal(request), { memberId: request.params.memberId, disabled: request.body.disabled });
    return { success: true as const };
  });
}

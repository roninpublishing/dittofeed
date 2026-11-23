import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  AccountError,
  completeGoogleSignIn,
  consumeAccountRateLimit,
  consumeGoogleFlow,
  createAccountSession,
  createGoogleFlow,
  createWorkspaceInvitation,
  getAccountProfile,
  getAccountTeam,
  GoogleAccountPrincipal,
  listAccountSessions,
  previewWorkspaceInvitation,
  removeAccountMember,
  resolveAccountSession,
  revokeAccountSession,
  revokeOtherAccountSessions,
  revokeWorkspaceInvitation,
  selectAccountWorkspace,
  setAccountDisabled,
  updateAccountMemberRole,
  updateAccountProfile,
  VerifiedGoogleProfile,
} from "backend-lib/src/accounts";
import config from "backend-lib/src/config";
import {
  GOOGLE_ACCOUNT_TOKEN_KEY,
  GOOGLE_OAUTH_FLOW_KEY,
  googleAccountCookieOptions,
  PendingGoogleFlow,
} from "backend-lib/src/googleSessions";
import { DittofeedFastifyInstance } from "backend-lib/src/types";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { FastifyRequest } from "fastify";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import {
  AccountProfile,
  AccountSessionResource,
  AccountSuccess,
  AccountTeamResponse,
  containsAccountControlCharacters,
  CreateAccountInvitationRequest,
  CreateAccountInvitationResponse,
  GoogleAuthStatus,
  UpdateAccountMemberRoleRequest,
  UpdateAccountProfileRequest,
  WorkspaceInvitationResource,
} from "isomorphic-lib/src/accounts";

const FLOW_SECONDS = 600;
const CALLBACK_PATH = "/api/public/auth/google/callback";
const LOGIN_PATH = "/dashboard/auth/google";
const utf8 = new TextEncoder();

function equalSecret(a: string, b: string): boolean {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function returnPath(value?: string): string {
  if (!value) return "/dashboard/home";
  // Reject encoded separators/controls too; nested dashboard routes need no escapes.
  if (
    !value.startsWith("/dashboard/") ||
    containsAccountControlCharacters(value) ||
    value.includes(" ") ||
    value.includes("\\") ||
    /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  ) {
    throw new AccountError("invalid_return_to", 400);
  }
  const parsed = new URL(value, "https://return.invalid");
  if (
    parsed.origin !== "https://return.invalid" ||
    !parsed.pathname.startsWith("/dashboard/")
  ) {
    throw new AccountError("invalid_return_to", 400);
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

const safeErrors: Record<string, true> = {
  not_authenticated: true,
  forbidden: true,
  no_access: true,
  not_invited: true,
  invalid_invitation: true,
  identity_conflict: true,
  already_member: true,
  invitation_email_mismatch: true,
  last_administrator: true,
  last_instance_administrator: true,
  rate_limited: true,
  invalid_profile: true,
  invalid_return_to: true,
  invalid_google_response: true,
  invalid_state: true,
  not_configured: true,
  bootstrap_subject_required: true,
};

function safeErrorCode(error: unknown): string {
  return error instanceof AccountError &&
    Object.prototype.hasOwnProperty.call(safeErrors, error.code)
    ? error.code
    : "google_auth_failed";
}

/** Google SDK owns the fixed Google certificate trust and signature verification. */
async function verifyGoogleCode(
  client: OAuth2Client,
  code: string,
  flow: PendingGoogleFlow,
  clientId: string,
  callbackUrl: string,
): Promise<VerifiedGoogleProfile> {
  try {
    const { tokens } = await client.getToken({
      code,
      codeVerifier: flow.codeVerifier,
      redirect_uri: callbackUrl,
    });
    if (!tokens.id_token)
      throw new AccountError("invalid_google_response", 400);
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (
      !payload ||
      !["https://accounts.google.com", "accounts.google.com"].includes(
        payload.iss,
      ) ||
      payload.aud !== clientId ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= Date.now() / 1000 ||
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      typeof payload.nonce !== "string" ||
      !equalSecret(payload.nonce, flow.nonce) ||
      payload.email_verified !== true ||
      typeof payload.email !== "string" ||
      payload.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 255
    ) {
      throw new AccountError("invalid_google_response", 400);
    }
    return {
      subject: payload.sub,
      email: payload.email,
      emailVerified: true,
      ...(typeof payload.hd === "string" ? { hostedDomain: payload.hd } : {}),
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(typeof payload.picture === "string"
        ? { picture: payload.picture }
        : {}),
    };
  } finally {
    // No Google credentials survive the exchange or become an application session.
    client.setCredentials({});
  }
}

const Token = Type.String({ minLength: 32, maxLength: 256 });
const WorkspaceQuery = Type.Object({
  workspaceId: Type.String({ format: "uuid" }),
});
const MemberParams = Type.Object({ memberId: Type.String({ format: "uuid" }) });
const ReturnTo = Type.Optional(Type.String({ maxLength: 2048 }));

/** Register after both secure-session namespaces, before core authorization hooks. */
export async function registerGoogleAccounts(app: DittofeedFastifyInstance) {
  const settings = config();
  const enabled = settings.authMode === "google";
  const configured = Boolean(
    settings.googleClientId && settings.googleClientSecret,
  );
  const { origin } = new URL(settings.dashboardUrl);
  const callbackUrl = `${origin}${CALLBACK_PATH}`;
  const cookieOptions = enabled
    ? googleAccountCookieOptions(settings.dashboardUrl)
    : undefined;

  app.decorateRequest("googleAccountPrincipal", undefined);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const privatePath =
      path === "/api/account" || path.startsWith("/api/account/");
    const publicPath = path.startsWith("/api/public/auth/google/");
    if (privatePath || publicPath) {
      void reply.header("Cache-Control", "no-store");
      void reply.header("Pragma", "no-cache");
      void reply.header("Referrer-Policy", "no-referrer");
    }
    if (!enabled) {
      if (privatePath) return reply.code(404).send({ code: "not_found" });
      return;
    }
    // eslint-disable-next-line no-param-reassign -- This server-owned marker prevents raw-request authentication from being repeated.
    request.raw.googleAccountSessionChecked = true;
    if (
      path.startsWith("/dashboard/_next/static/") ||
      path.startsWith("/dashboard/_next/image") ||
      path.startsWith("/dashboard/branding/") ||
      path === "/dashboard/favicon.ico"
    )
      return;
    const token = request.googleAccountSession.get(GOOGLE_ACCOUNT_TOKEN_KEY);
    const principal =
      typeof token === "string" && token.length <= 256
        ? await resolveAccountSession(token)
        : null;
    // eslint-disable-next-line no-param-reassign -- Fastify request metadata carries only the database-resolved identity.
    request.googleAccountPrincipal = principal ?? undefined;
    // eslint-disable-next-line no-param-reassign -- SSR consumes the same server-resolved identity on the raw request.
    request.raw.googleAccountPrincipal = principal ?? undefined;
    if (token && !principal) request.googleAccountSession.delete();
    if (privatePath) {
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (
        (unsafe || request.headers.origin !== undefined) &&
        request.headers.origin !== origin
      ) {
        return reply.code(403).send({ code: "forbidden" });
      }
      if (!principal)
        return reply.code(401).send({ code: "not_authenticated" });
    }
  });

  await app.register((scope, _options, done) => {
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    // Never pass provider exceptions (which can contain full tokens) to Fastify logging.
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof AccountError) {
        const code = safeErrorCode(error);
        return reply.code(error.statusCode).send({ code, message: code });
      }
      if (error.validation) {
        return reply.code(400).send({
          code: "invalid_request",
          message: "invalid_request",
        });
      }
      if (error.statusCode === 413) {
        return reply.code(413).send({
          code: "request_too_large",
          message: "request_too_large",
        });
      }
      return reply.code(500).send({
        code: "account_error",
        message: "account_error",
      });
    });

    const principal = (request: FastifyRequest): GoogleAccountPrincipal => {
      if (!request.googleAccountPrincipal)
        throw new AccountError("not_authenticated", 401);
      return request.googleAccountPrincipal;
    };
    const requireOrigin = (request: FastifyRequest) => {
      if (request.headers.origin !== origin)
        throw new AccountError("forbidden", 403);
    };
    const requireConfigured = () => {
      if (!enabled) throw new AccountError("not_configured", 404);
      if (
        !settings.googleClientId ||
        !settings.googleClientSecret ||
        !cookieOptions
      ) {
        throw new AccountError("not_configured", 503);
      }
      return {
        clientId: settings.googleClientId,
        clientSecret: settings.googleClientSecret,
        cookieOptions,
      };
    };
    const rateLimit = async (
      request: FastifyRequest,
      kind: string,
      maxAttempts = 30,
    ) => {
      if (!settings.secretKey) throw new AccountError("not_configured", 503);
      const key = createHmac("sha256", settings.secretKey)
        .update(`google-account:${kind}:${request.ip}`)
        .digest("hex");
      await consumeAccountRateLimit({ key, maxAttempts, windowSeconds: 600 });
    };
    const start = async (
      request: FastifyRequest,
      input: { invitationToken?: string; returnTo?: string },
    ) => {
      const credentials = requireConfigured();
      await rateLimit(request, "start");
      const destination = returnPath(input.returnTo);
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(32).toString("base64url");
      const flow = await createGoogleFlow({
        state,
        invitationToken: input.invitationToken,
      });
      request.googleOAuthSession.set(GOOGLE_OAUTH_FLOW_KEY, {
        flowId: flow.id,
        state,
        nonce,
        codeVerifier,
        returnTo: destination,
        expiresAt: flow.expiresAt,
      });
      request.googleOAuthSession.options(
        googleAccountCookieOptions(settings.dashboardUrl, FLOW_SECONDS),
      );
      const client = new OAuth2Client(
        credentials.clientId,
        credentials.clientSecret,
        callbackUrl,
      );
      return client.generateAuthUrl({
        scope: ["openid", "email", "profile"],
        response_type: "code",
        access_type: "online",
        prompt: "select_account",
        state,
        nonce,
        code_challenge: createHash("sha256")
          .update(codeVerifier)
          .digest("base64url"),
        code_challenge_method: CodeChallengeMethod.S256,
      });
    };
    const publicOptions = { bodyLimit: 8192, logLevel: "silent" as const };
    const privateOptions = {
      ...publicOptions,
      preHandler: async (request: FastifyRequest) => {
        if (!enabled) throw new AccountError("not_configured", 404);
        const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
        if (unsafe || request.headers.origin !== undefined)
          requireOrigin(request);
        await rateLimit(request, `private:${principal(request).memberId}`, 120);
      },
    };

    routes.get(
      "/api/public/auth/google/status",
      {
        ...publicOptions,
        schema: { response: { 200: GoogleAuthStatus } },
      },
      (_request, reply) => {
        void reply.send({
          enabled,
          configured: enabled && configured,
          callbackUrl,
          loginUrl: `${origin}/api/public/auth/google/start`,
        });
      },
    );

    routes.get(
      "/api/public/auth/google/start",
      {
        ...publicOptions,
        schema: {
          querystring: Type.Object(
            { returnTo: ReturnTo },
            { additionalProperties: false },
          ),
        },
      },
      async (request, reply) => {
        if (request.headers.origin !== undefined) requireOrigin(request);
        return reply.redirect(await start(request, request.query));
      },
    );

    routes.post(
      "/api/public/auth/google/start",
      {
        ...publicOptions,
        schema: {
          body: Type.Object(
            { invitationToken: Token, returnTo: ReturnTo },
            { additionalProperties: false },
          ),
        },
      },
      async (request) => {
        requireOrigin(request);
        return { url: await start(request, request.body) };
      },
    );

    routes.post(
      "/api/public/auth/google/invitation",
      {
        ...publicOptions,
        schema: {
          body: Type.Object({ token: Token }, { additionalProperties: false }),
          response: { 200: WorkspaceInvitationResource },
        },
      },
      async (request) => {
        requireConfigured();
        requireOrigin(request);
        await rateLimit(request, "invitation");
        return previewWorkspaceInvitation(request.body.token);
      },
    );

    routes.get(
      CALLBACK_PATH,
      {
        ...publicOptions,
        schema: {
          querystring: Type.Object({
            code: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
            state: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            error: Type.Optional(Type.String({ maxLength: 256 })),
          }),
        },
      },
      async (request, reply) => {
        const flow = request.googleOAuthSession.get(GOOGLE_OAUTH_FLOW_KEY);
        request.googleOAuthSession.delete();
        try {
          const credentials = requireConfigured();
          await rateLimit(request, "callback", 60);
          if (
            !flow ||
            flow.expiresAt <= Date.now() ||
            !request.query.state ||
            !equalSecret(flow.state, request.query.state)
          )
            throw new AccountError("invalid_state", 400);
          // Atomic DB consumption happens before any Google request, even on denial.
          const consumed = await consumeGoogleFlow({
            id: flow.flowId,
            state: request.query.state,
          });
          if (request.query.error || !request.query.code)
            throw new AccountError("invalid_google_response", 400);
          const client = new OAuth2Client(
            credentials.clientId,
            credentials.clientSecret,
            callbackUrl,
          );
          const profile = await verifyGoogleCode(
            client,
            request.query.code,
            flow,
            credentials.clientId,
            callbackUrl,
          );
          const account = await completeGoogleSignIn({
            profile,
            invitationId: consumed.invitationId,
          });
          if (request.googleAccountPrincipal) {
            await revokeAccountSession(
              request.googleAccountPrincipal,
              request.googleAccountPrincipal.sessionId,
            );
          }
          const session = await createAccountSession({
            memberId: account.memberId,
            userAgent: request.headers["user-agent"]?.slice(0, 512),
          });
          // eslint-disable-next-line no-param-reassign -- Replace deleted or stale cookie state before issuing the rotated session.
          request.googleAccountSession = app.createSecureSession({
            [GOOGLE_ACCOUNT_TOKEN_KEY]: session.token,
          });
          request.googleAccountSession.touch();
          request.googleAccountSession.options(credentials.cookieOptions);
          return reply.redirect(`${origin}${returnPath(flow.returnTo)}`);
        } catch (error) {
          return reply.redirect(
            `${origin}${LOGIN_PATH}?error=${safeErrorCode(error)}`,
          );
        }
      },
    );

    routes.get(
      "/api/account",
      { ...privateOptions, schema: { response: { 200: AccountProfile } } },
      async (request) => getAccountProfile(principal(request)),
    );
    routes.patch(
      "/api/account",
      {
        ...privateOptions,
        schema: {
          body: UpdateAccountProfileRequest,
          response: { 200: AccountProfile },
        },
      },
      async (request) => updateAccountProfile(principal(request), request.body),
    );
    routes.post(
      "/api/account/workspace",
      {
        ...privateOptions,
        schema: {
          body: Type.Object(
            { workspaceId: Type.String({ format: "uuid" }) },
            { additionalProperties: false },
          ),
          response: { 200: AccountSuccess },
        },
      },
      async (request) => {
        await selectAccountWorkspace(
          principal(request),
          request.body.workspaceId,
        );
        return { success: true as const };
      },
    );
    routes.get(
      "/api/account/sessions",
      {
        ...privateOptions,
        schema: { response: { 200: Type.Array(AccountSessionResource) } },
      },
      async (request) => listAccountSessions(principal(request)),
    );
    routes.delete(
      "/api/account/sessions/:sessionId",
      {
        ...privateOptions,
        schema: {
          params: Type.Object({ sessionId: Type.String({ format: "uuid" }) }),
          response: { 200: AccountSuccess },
        },
      },
      async (request) => {
        const identity = principal(request);
        await revokeAccountSession(identity, request.params.sessionId);
        if (request.params.sessionId === identity.sessionId)
          request.googleAccountSession.delete();
        return { success: true as const };
      },
    );
    routes.post(
      "/api/account/sessions/revoke-others",
      { ...privateOptions, schema: { response: { 200: AccountSuccess } } },
      async (request) => {
        await revokeOtherAccountSessions(principal(request));
        return { success: true as const };
      },
    );
    routes.post(
      "/api/account/logout",
      { ...privateOptions, schema: { response: { 200: AccountSuccess } } },
      async (request) => {
        const identity = principal(request);
        await revokeAccountSession(identity, identity.sessionId);
        request.googleAccountSession.delete();
        return { success: true as const };
      },
    );
    routes.get(
      "/api/account/team",
      {
        ...privateOptions,
        schema: {
          querystring: WorkspaceQuery,
          response: { 200: AccountTeamResponse },
        },
      },
      async (request) =>
        getAccountTeam(principal(request), request.query.workspaceId),
    );
    routes.post(
      "/api/account/invitations",
      {
        ...privateOptions,
        schema: {
          body: CreateAccountInvitationRequest,
          response: { 200: CreateAccountInvitationResponse },
        },
      },
      async (request) => {
        const result = await createWorkspaceInvitation(
          principal(request),
          request.body,
        );
        return {
          invitation: result.invitation,
          url: `${origin}/dashboard/auth/invite#token=${encodeURIComponent(result.token)}`,
        };
      },
    );
    routes.delete(
      "/api/account/invitations/:id",
      {
        ...privateOptions,
        schema: {
          params: Type.Object({ id: Type.String({ format: "uuid" }) }),
          querystring: WorkspaceQuery,
          response: { 200: AccountSuccess },
        },
      },
      async (request) => {
        await revokeWorkspaceInvitation(principal(request), {
          workspaceId: request.query.workspaceId,
          invitationId: request.params.id,
        });
        return { success: true as const };
      },
    );
    routes.patch(
      "/api/account/members/:memberId/role",
      {
        ...privateOptions,
        schema: {
          params: MemberParams,
          body: UpdateAccountMemberRoleRequest,
          response: { 200: AccountSuccess },
        },
      },
      async (request) => {
        await updateAccountMemberRole(principal(request), {
          ...request.body,
          memberId: request.params.memberId,
        });
        return { success: true as const };
      },
    );
    routes.delete(
      "/api/account/members/:memberId",
      {
        ...privateOptions,
        schema: {
          params: MemberParams,
          querystring: WorkspaceQuery,
          response: { 200: AccountSuccess },
        },
      },
      async (request) => {
        await removeAccountMember(principal(request), {
          workspaceId: request.query.workspaceId,
          memberId: request.params.memberId,
        });
        return { success: true as const };
      },
    );
    routes.post(
      "/api/account/members/:memberId/disabled",
      {
        ...privateOptions,
        schema: {
          params: MemberParams,
          body: Type.Object(
            { disabled: Type.Boolean() },
            { additionalProperties: false },
          ),
          response: { 200: AccountSuccess },
        },
      },
      async (request) => {
        await setAccountDisabled(principal(request), {
          memberId: request.params.memberId,
          disabled: request.body.disabled,
        });
        return { success: true as const };
      },
    );
    done();
  });
}

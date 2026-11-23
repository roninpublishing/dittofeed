import secureSession from "@fastify/secure-session";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  createAccountSession,
  GoogleAccountPrincipal,
  resolveAccountSession,
  revokeAccountSession,
} from "backend-lib/src/accounts";
import * as accountsModule from "backend-lib/src/accounts";
import * as configModule from "backend-lib/src/config";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import {
  GOOGLE_ACCOUNT_COOKIE_NAME,
  GOOGLE_ACCOUNT_SESSION_NAME,
  GOOGLE_OAUTH_COOKIE_NAME,
  GOOGLE_OAUTH_SESSION_NAME,
  googleAccountCookieOptions,
  googleSessionPluginOptions,
  PendingGoogleFlow,
  resolveGoogleRequestPrincipal,
} from "backend-lib/src/googleSessions";
import { DittofeedFastifyInstance, Logger } from "backend-lib/src/types";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "crypto";
import { eq, inArray } from "drizzle-orm";
import fastify, {
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { OAuth2Client, TokenPayload } from "google-auth-library";
import { CertificateFormat } from "google-auth-library/build/src/auth/oauth2client";
import {
  AccountProfile,
  AccountSuccess,
  CreateAccountInvitationResponse,
  GoogleAuthStatus,
} from "isomorphic-lib/src/accounts";

import { registerGoogleAccounts } from "./googleAccounts";

function pendingFlow(
  server: DittofeedFastifyInstance,
  cookieValue: string,
): PendingGoogleFlow {
  const flow: unknown = server
    .decodeSecureSession(cookieValue, undefined, GOOGLE_OAUTH_SESSION_NAME)
    ?.get("flow");
  if (
    typeof flow !== "object" ||
    flow === null ||
    !("flowId" in flow) ||
    typeof flow.flowId !== "string" ||
    !("state" in flow) ||
    typeof flow.state !== "string" ||
    !("nonce" in flow) ||
    typeof flow.nonce !== "string" ||
    !("codeVerifier" in flow) ||
    typeof flow.codeVerifier !== "string" ||
    !("returnTo" in flow) ||
    typeof flow.returnTo !== "string" ||
    !("expiresAt" in flow) ||
    typeof flow.expiresAt !== "number"
  ) {
    throw new Error("Expected a complete pending OAuth flow");
  }
  return {
    flowId: flow.flowId,
    state: flow.state,
    nonce: flow.nonce,
    codeVerifier: flow.codeVerifier,
    returnTo: flow.returnTo,
    expiresAt: flow.expiresAt,
  };
}

interface TestOAuthCallbackInput {
  flow: PendingGoogleFlow;
  cookies: Record<string, string>;
}

// Only network transports are replaced. Google SDK signature/issuer/audience/expiry
// verification and the real database single-use/session logic run unchanged.
// These tests are not a claim of live Google SSO verification.
describe("owned Google account protocol", () => {
  const origin = "http://localhost:3000";
  const clientId = "test-client.apps.googleusercontent.com";
  const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreignKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let app: DittofeedFastifyInstance;
  let memberId: string;
  let workspaceId: string;
  let subject: string;
  let email: string;
  let secret: string;
  let flowIds: string[];
  let claims: Partial<TokenPayload>;
  let invalidSignature: boolean;
  let exchange: jest.SpyInstance;
  const originalConfig = configModule.default;

  function jwt(nonce: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "local-test-key", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: clientId,
        sub: subject,
        iat: now - 1,
        exp: now + 3600,
        nonce,
        email,
        email_verified: true,
        name: "Protocol Test",
        ...claims,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign(
      "RSA-SHA256",
      new TextEncoder().encode(input),
      invalidSignature ? foreignKeys.privateKey : signingKeys.privateKey,
    ).toString("base64url")}`;
  }

  beforeEach(async () => {
    memberId = randomUUID();
    workspaceId = randomUUID();
    subject = randomUUID();
    email = `${randomUUID()}@example.test`;
    secret = randomBytes(32).toString("hex");
    flowIds = [];
    claims = {};
    invalidSignature = false;
    const base = originalConfig();
    jest.spyOn(configModule, "default").mockImplementation(() => ({
      ...base,
      authMode: "google",
      dashboardUrl: origin,
      googleClientId: clientId,
      googleClientSecret: "test-client-secret",
      secretKey: secret,
    }));
    await db()
      .insert(schema.workspace)
      .values({ id: workspaceId, name: randomUUID() });
    await db().insert(schema.workspaceMember).values({
      id: memberId,
      email,
      emailVerified: true,
      name: "Protocol Test",
      lastWorkspaceId: workspaceId,
    });
    await db().insert(schema.googleAccount).values({
      memberId,
      googleSubject: subject,
      normalizedEmail: email,
      isInstanceAdmin: true,
    });
    await db()
      .insert(schema.workspaceMemberRole)
      .values({ workspaceId, workspaceMemberId: memberId, role: "Admin" });
    jest
      .spyOn(OAuth2Client.prototype, "getFederatedSignonCertsAsync")
      .mockResolvedValue({
        certs: {
          "local-test-key": signingKeys.publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
        },
        format: CertificateFormat.PEM,
      });
    exchange = jest.spyOn(OAuth2Client.prototype, "getToken");
    app = fastify<
      RawServerDefault,
      RawRequestDefaultExpression,
      RawReplyDefaultExpression,
      Logger
    >().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(secureSession, [
      {
        key: randomBytes(32),
        sessionName: GOOGLE_ACCOUNT_SESSION_NAME,
        cookieName: GOOGLE_ACCOUNT_COOKIE_NAME,
        cookie: googleAccountCookieOptions(origin),
      },
      {
        key: randomBytes(32),
        sessionName: GOOGLE_OAUTH_SESSION_NAME,
        cookieName: GOOGLE_OAUTH_COOKIE_NAME,
        cookie: googleAccountCookieOptions(origin, 600),
      },
    ]);
    await registerGoogleAccounts(app);
    // Verify both transport objects expose exactly the server-resolved principal.
    app.get("/principal-probe", (request, reply) =>
      reply.send({
        fastify: request.googleAccountPrincipal,
        raw: request.raw.googleAccountPrincipal,
      }),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    if (flowIds.length)
      await db()
        .delete(schema.googleOAuthFlow)
        .where(inArray(schema.googleOAuthFlow.id, flowIds));
    await db()
      .delete(schema.workspace)
      .where(eq(schema.workspace.id, workspaceId));
    await db()
      .delete(schema.workspaceMember)
      .where(eq(schema.workspaceMember.id, memberId));
    const rateKeys = [
      "start",
      "callback",
      "invitation",
      `private:${memberId}`,
    ].map((kind) =>
      createHmac("sha256", secret)
        .update(`google-account:${kind}:127.0.0.1`)
        .digest("hex"),
    );
    await db()
      .delete(schema.accountRateLimit)
      .where(inArray(schema.accountRateLimit.key, rateKeys));
  });

  async function begin(returnTo?: string) {
    const response = await app.inject({
      method: "GET",
      url: `/api/public/auth/google/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
    });
    expect(response.statusCode).toBe(302);
    if (typeof response.headers.location !== "string")
      throw new Error("Expected a Google authorization redirect");
    const authorization = new URL(response.headers.location);
    const cookie = response.cookies.find(
      (item) => item.name === GOOGLE_OAUTH_COOKIE_NAME,
    );
    if (!cookie) throw new Error("Expected encrypted OAuth cookie");
    const flow = pendingFlow(app, cookie.value);
    flowIds.push(flow.flowId);
    exchange.mockResolvedValue({
      tokens: {
        id_token: jwt(flow.nonce),
        access_token: "discard-this-access-token",
      },
      res: null,
    });
    return {
      response,
      authorization,
      flow,
      cookies: { [GOOGLE_OAUTH_COOKIE_NAME]: cookie.value },
    };
  }

  function callback(flow: TestOAuthCallbackInput, state = flow.flow.state) {
    return app.inject({
      method: "GET",
      url: `/api/public/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
      cookies: flow.cookies,
    });
  }

  async function authenticated() {
    const session = await createAccountSession({ memberId });
    const value = app.encodeSecureSession(
      app.createSecureSession({ token: session.token }),
      GOOGLE_ACCOUNT_SESSION_NAME,
    );
    return { ...session, cookies: { [GOOGLE_ACCOUNT_COOKIE_NAME]: value } };
  }

  it("exposes unauthenticated status and uses only code, PKCE S256 and identity scopes", async () => {
    const status = await app.inject("/api/public/auth/google/status");
    expect(status.statusCode).toBe(200);
    expect(status.json<GoogleAuthStatus>()).toEqual({
      enabled: true,
      configured: true,
      callbackUrl: `${origin}/api/public/auth/google/callback`,
      loginUrl: `${origin}/api/public/auth/google/start`,
    });
    expect(status.headers["cache-control"]).toBe("no-store");
    const started = await begin();
    expect(started.authorization.origin).toBe("https://accounts.google.com");
    expect(started.authorization.searchParams.get("response_type")).toBe(
      "code",
    );
    expect(started.authorization.searchParams.get("scope")).toBe(
      "openid email profile",
    );
    expect(started.authorization.searchParams.get("access_type")).toBe(
      "online",
    );
    expect(started.authorization.searchParams.get("nonce")).toBe(
      started.flow.nonce,
    );
    expect(
      started.authorization.searchParams.get("code_challenge_method"),
    ).toBe("S256");
    expect(started.authorization.searchParams.get("code_challenge")).toBe(
      createHash("sha256")
        .update(started.flow.codeVerifier)
        .digest("base64url"),
    );
    const rows = await db()
      .select()
      .from(schema.googleOAuthFlow)
      .where(eq(schema.googleOAuthFlow.id, started.flow.flowId));
    expect(rows[0]?.stateHash).not.toBe(started.flow.state);
    expect(String(started.response.headers["set-cookie"])).toContain(
      "HttpOnly",
    );
    expect(String(started.response.headers["set-cookie"])).toContain(
      "SameSite=Lax",
    );
  });

  it("consumes state before exchange, signs in, discards Google tokens, and rejects replay", async () => {
    const started = await begin("/dashboard/account");
    exchange.mockImplementation(async (input) => {
      const [stored] = await db()
        .select()
        .from(schema.googleOAuthFlow)
        .where(eq(schema.googleOAuthFlow.id, started.flow.flowId));
      expect(stored?.consumedAt).toBeInstanceOf(Date);
      expect(input).toMatchObject({
        code: "test-code",
        codeVerifier: started.flow.codeVerifier,
        redirect_uri: `${origin}/api/public/auth/google/callback`,
      });
      return {
        tokens: {
          id_token: jwt(started.flow.nonce),
          access_token: "not-an-app-session",
        },
        res: null,
      };
    });
    const response = await callback(started);
    expect(response.headers.location).toBe(`${origin}/dashboard/account`);
    const cookie = response.cookies.find(
      (item) => item.name === GOOGLE_ACCOUNT_COOKIE_NAME,
    );
    if (!cookie) throw new Error("Expected an application session cookie");
    const data: unknown = app
      .decodeSecureSession(cookie.value, undefined, GOOGLE_ACCOUNT_SESSION_NAME)
      ?.data();
    if (
      typeof data !== "object" ||
      data === null ||
      !("token" in data) ||
      typeof data.token !== "string"
    ) {
      throw new Error("Expected an application session token");
    }
    expect(Object.keys(data)).toEqual(["token"]);
    expect(data.token).not.toBe("not-an-app-session");
    expect(await resolveAccountSession(data.token)).toMatchObject({
      memberId,
    });
    const replay = await callback(started);
    expect(replay.headers.location).toContain("/dashboard/auth/google?error=");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects forged state before exchanging any code", async () => {
    const started = await begin();
    const response = await callback(started, "forged-state");
    expect(response.headers.location).toBe(
      `${origin}/dashboard/auth/google?error=invalid_state`,
    );
    expect(exchange).not.toHaveBeenCalled();
    expect(
      response.cookies.find((item) => item.name === GOOGLE_OAUTH_COOKIE_NAME)
        ?.value,
    ).toBe("");
  });

  it("rejects absent pending cookies even with a real state", async () => {
    const started = await begin();
    const response = await app.inject(
      `/api/public/auth/google/callback?code=test-code&state=${started.flow.state}`,
    );
    expect(response.headers.location).toContain("error=invalid_state");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects database-expired flows before exchange", async () => {
    const started = await begin();
    await db()
      .update(schema.googleOAuthFlow)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.googleOAuthFlow.id, started.flow.flowId));
    const response = await callback(started);
    expect(response.headers.location).toContain(
      "/dashboard/auth/google?error=",
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects cookie-expired flows before database consumption", async () => {
    const started = await begin();
    started.cookies[GOOGLE_OAUTH_COOKIE_NAME] = app.encodeSecureSession(
      app.createSecureSession({
        flow: { ...started.flow, expiresAt: Date.now() - 1000 },
      }),
      GOOGLE_OAUTH_SESSION_NAME,
    );
    expect((await callback(started)).headers.location).toContain(
      "error=invalid_state",
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it("passes hosted domain only from the SDK-verified signed identity payload", async () => {
    const complete = jest.spyOn(accountsModule, "completeGoogleSignIn");
    claims = { hd: "example.test" };
    const verified = await begin();
    expect((await callback(verified)).headers.location).toBe(
      `${origin}/dashboard/home`,
    );
    expect(complete.mock.calls[0]?.[0].profile.hostedDomain).toBe(
      "example.test",
    );

    claims = {};
    const untrusted = await begin();
    const response = await app.inject({
      url: `/api/public/auth/google/callback?code=test-code&state=${untrusted.flow.state}&hd=attacker.example`,
      cookies: untrusted.cookies,
      headers: { "x-google-hosted-domain": "attacker.example" },
    });
    expect(response.headers.location).toBe(`${origin}/dashboard/home`);
    expect(complete.mock.calls[1]?.[0].profile).not.toHaveProperty(
      "hostedDomain",
    );
  });

  it.each(["email_mismatch", "expired", "revoked"])(
    "preserves the safe invitation failure code for %s",
    async (kind) => {
      const session = await authenticated();
      const invitation = await accountsModule.createWorkspaceInvitation(
        session.principal,
        {
          workspaceId,
          email: `${randomUUID()}@example.test`,
          role: "Viewer",
        },
      );
      const started = await app.inject({
        method: "POST",
        url: "/api/public/auth/google/start",
        headers: { origin },
        payload: { invitationToken: invitation.token },
      });
      expect(started.statusCode).toBe(200);
      const cookie = started.cookies.find(
        (item) => item.name === GOOGLE_OAUTH_COOKIE_NAME,
      );
      if (!cookie) throw new Error("Expected an encrypted OAuth cookie");
      const flow = pendingFlow(app, cookie.value);
      flowIds.push(flow.flowId);
      if (kind === "expired")
        await db()
          .update(schema.workspaceInvitation)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.workspaceInvitation.id, invitation.invitation.id));
      if (kind === "revoked")
        await db()
          .update(schema.workspaceInvitation)
          .set({ revokedAt: new Date() })
          .where(eq(schema.workspaceInvitation.id, invitation.invitation.id));
      exchange.mockResolvedValue({
        tokens: { id_token: jwt(flow.nonce) },
        res: null,
      });
      const response = await callback({
        flow,
        cookies: { [GOOGLE_OAUTH_COOKIE_NAME]: cookie.value },
      });
      const expected =
        kind === "email_mismatch"
          ? "invitation_email_mismatch"
          : "invalid_invitation";
      expect(response.headers.location).toBe(
        `${origin}/dashboard/auth/google?error=${expected}`,
      );
      expect(
        response.cookies.find(
          (item) => item.name === GOOGLE_ACCOUNT_COOKIE_NAME,
        ),
      ).toBeUndefined();
      expect(response.headers.location).not.toContain(invitation.token);
    },
  );

  it.each([
    ["wrong nonce", { nonce: "forged-nonce" }],
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["wrong audience", { aud: "another-client" }],
    ["wrong authorized presenter", { azp: "another-client" }],
    ["unverified email", { email_verified: false }],
    ["expired ID token", { exp: Math.floor(Date.now() / 1000) - 600 }],
    ["missing nonce", { nonce: undefined }],
    ["missing subject", { sub: "" }],
  ])(
    "rejects %s without creating an app session",
    async (_label, overrides) => {
      claims = overrides;
      const started = await begin();
      const response = await callback(started);
      expect(response.headers.location).toContain(
        "/dashboard/auth/google?error=",
      );
      expect(
        response.cookies.find(
          (item) => item.name === GOOGLE_ACCOUNT_COOKIE_NAME,
        ),
      ).toBeUndefined();
      const sessions = await db()
        .select()
        .from(schema.accountSession)
        .where(eq(schema.accountSession.memberId, memberId));
      expect(sessions).toHaveLength(0);
    },
  );

  it("rejects a cryptographically invalid Google signature using the real SDK verifier", async () => {
    invalidSignature = true;
    const started = await begin();
    const response = await callback(started);
    expect(response.headers.location).toBe(
      `${origin}/dashboard/auth/google?error=google_auth_failed`,
    );
    expect(
      response.cookies.find((item) => item.name === GOOGLE_ACCOUNT_COOKIE_NAME),
    ).toBeUndefined();
    expect(response.body).not.toContain("test-code");
  });

  it("consumes denied/failed exchanges and never reflects provider secrets", async () => {
    const started = await begin();
    exchange.mockRejectedValue(
      new Error("SECRET provider token URL https://example.test/?code=SECRET"),
    );
    const response = await callback(started);
    expect(response.headers.location).toBe(
      `${origin}/dashboard/auth/google?error=google_auth_failed`,
    );
    expect(response.body).not.toContain("SECRET");
    expect((await callback(started)).headers.location).toContain("error=");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/dashboard/../../outside",
    "/dashboard/\\evil",
    "/dashboard/%2f%2fevil",
    "/dashboard/a\n",
  ])("rejects arbitrary returnTo %s", async (returnTo) => {
    const response = await app.inject(
      `/api/public/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`,
    );
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it("requires exact Origin on all cookie writes and rejects foreign Origin on private reads", async () => {
    const session = await authenticated();
    await Promise.all(
      [undefined, "https://evil.example", `${origin}/`, "null"].map(
        async (suppliedOrigin) => {
          const response = await app.inject({
            method: "PATCH",
            url: "/api/account",
            payload: { name: "Forged" },
            cookies: session.cookies,
            headers: suppliedOrigin ? { origin: suppliedOrigin } : {},
          });
          expect(response.statusCode).toBe(403);
          const preview = await app.inject({
            method: "POST",
            url: "/api/public/auth/google/invitation",
            payload: { token: "a".repeat(43) },
            headers: suppliedOrigin ? { origin: suppliedOrigin } : {},
          });
          expect(preview.statusCode).toBe(403);
        },
      ),
    );
    expect(
      (
        await app.inject({
          url: "/api/account",
          cookies: session.cookies,
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/account", cookies: session.cookies }))
        .statusCode,
    ).toBe(200);
    const update = await app.inject({
      method: "PATCH",
      url: "/api/account",
      cookies: session.cookies,
      headers: { origin },
      payload: { name: "Owned Name" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json<AccountProfile>().member.name).toBe("Owned Name");
  });

  it("selects only an explicit workspace through an Origin-bound authenticated POST", async () => {
    const session = await authenticated();
    await db()
      .update(schema.workspaceMember)
      .set({ lastWorkspaceId: null })
      .where(eq(schema.workspaceMember.id, memberId));
    await Promise.all(
      [undefined, "https://evil.example"].map(async (suppliedOrigin) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/account/workspace",
          cookies: session.cookies,
          headers: suppliedOrigin ? { origin: suppliedOrigin } : {},
          payload: { workspaceId },
        });
        expect(response.statusCode).toBe(403);
      }),
    );
    const selected = await app.inject({
      method: "POST",
      url: "/api/account/workspace",
      cookies: session.cookies,
      headers: { origin },
      payload: { workspaceId },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json<AccountSuccess>()).toEqual({ success: true });
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/account/workspace",
      cookies: session.cookies,
      headers: { origin },
      payload: { workspaceId: randomUUID() },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/account/workspace?workspaceId=${randomUUID()}`,
          cookies: session.cookies,
        })
      ).statusCode,
    ).toBe(404);
    const [member] = await db()
      .select()
      .from(schema.workspaceMember)
      .where(eq(schema.workspaceMember.id, memberId));
    expect(member?.lastWorkspaceId).toBe(workspaceId);
  });

  it("does not trust profile bodies, identity headers, bearer JWTs or old shared cookies", async () => {
    const response = await app.inject({
      url: "/api/account",
      headers: {
        "x-google-subject": subject,
        "x-workspace-member-id": memberId,
        authorization: `Bearer ${jwt("anything")}`,
        cookie: "session=old-shared-login",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/account",
          headers: { origin },
          payload: { name: "Spoofed", memberId, email, googleSubject: subject },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("attaches the database principal to both Fastify and the raw request", async () => {
    const session = await authenticated();
    const response = await app.inject({
      url: "/principal-probe",
      cookies: session.cookies,
    });
    expect(
      response.json<{
        fastify: GoogleAccountPrincipal;
        raw: GoogleAccountPrincipal;
      }>(),
    ).toEqual({
      fastify: session.principal,
      raw: session.principal,
    });
  });

  it("verifies the same encrypted account cookie in standalone SSR and honors revocation", async () => {
    const session = await createAccountSession({ memberId });
    const signer = fastify();
    await signer.register(
      secureSession,
      googleSessionPluginOptions(configModule.default()),
    );
    await signer.ready();
    try {
      const cookie = signer.encodeSecureSession(
        signer.createSecureSession({ token: session.token }),
        GOOGLE_ACCOUNT_SESSION_NAME,
      );
      const request = {
        headers: {
          cookie: `${GOOGLE_ACCOUNT_COOKIE_NAME}=${encodeURIComponent(cookie)}`,
        },
      };
      expect(await resolveGoogleRequestPrincipal(request)).toEqual(
        session.principal,
      );
      await revokeAccountSession(
        session.principal,
        session.principal.sessionId,
      );
      expect(await resolveGoogleRequestPrincipal(request)).toBeUndefined();
      expect(
        await resolveGoogleRequestPrincipal({
          headers: { cookie: `${GOOGLE_ACCOUNT_COOKIE_NAME}=corrupt` },
        }),
      ).toBeUndefined();
      expect(
        await resolveGoogleRequestPrincipal({
          headers: { authorization: `Bearer ${jwt("forged")}` },
          googleAccountPrincipal: session.principal,
        }),
      ).toBeUndefined();
    } finally {
      await signer.close();
    }
  });

  it.each(["expired", "revoked", "disabled"])(
    "rejects %s database sessions despite a valid encrypted cookie",
    async (kind) => {
      const session = await authenticated();
      if (kind === "expired")
        await db()
          .update(schema.accountSession)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.accountSession.id, session.principal.sessionId));
      if (kind === "revoked")
        await revokeAccountSession(
          session.principal,
          session.principal.sessionId,
        );
      if (kind === "disabled")
        await db()
          .update(schema.googleAccount)
          .set({ disabledAt: new Date() })
          .where(eq(schema.googleAccount.memberId, memberId));
      const response = await app.inject({
        url: "/api/account",
        cookies: session.cookies,
      });
      expect(response.statusCode).toBe(401);
      expect(
        response.cookies.find(
          (item) => item.name === GOOGLE_ACCOUNT_COOKIE_NAME,
        )?.value,
      ).toBe("");
    },
  );

  it("rotates an existing application session after successful Google login", async () => {
    const previous = await authenticated();
    const started = await begin();
    const response = await app.inject({
      url: `/api/public/auth/google/callback?code=test-code&state=${started.flow.state}`,
      cookies: { ...started.cookies, ...previous.cookies },
    });
    expect(response.headers.location).toBe(`${origin}/dashboard/home`);
    expect(await resolveAccountSession(previous.token)).toBeNull();
    expect(
      response.cookies.find((item) => item.name === GOOGLE_ACCOUNT_COOKIE_NAME),
    ).toBeDefined();
  });

  it("replaces a revoked cookie with a fresh session after successful Google login", async () => {
    const previous = await authenticated();
    await revokeAccountSession(
      previous.principal,
      previous.principal.sessionId,
    );
    const started = await begin();
    const response = await app.inject({
      url: `/api/public/auth/google/callback?code=test-code&state=${started.flow.state}`,
      cookies: { ...started.cookies, ...previous.cookies },
    });
    expect(response.headers.location).toBe(`${origin}/dashboard/home`);
    const cookie = response.cookies.find(
      (item) => item.name === GOOGLE_ACCOUNT_COOKIE_NAME,
    );
    if (!cookie?.value) throw new Error("Expected a fresh session cookie");
    const token: unknown = app
      .decodeSecureSession(cookie.value, undefined, GOOGLE_ACCOUNT_SESSION_NAME)
      ?.get("token");
    if (typeof token !== "string")
      throw new Error("Expected a fresh application session token");
    expect(await resolveAccountSession(token)).toMatchObject({ memberId });
  });

  it("revokes and clears the current session on authenticated Origin-bound logout", async () => {
    const session = await authenticated();
    const response = await app.inject({
      method: "POST",
      url: "/api/account/logout",
      headers: { origin },
      cookies: session.cookies,
    });
    expect(response.statusCode).toBe(200);
    expect(await resolveAccountSession(session.token)).toBeNull();
    expect(
      response.cookies.find((item) => item.name === GOOGLE_ACCOUNT_COOKIE_NAME)
        ?.value,
    ).toBe("");
  });

  it("creates private invitation URLs with fragment-only secrets and public Origin-bound preview/start", async () => {
    const session = await authenticated();
    const invitation = await app.inject({
      method: "POST",
      url: "/api/account/invitations",
      headers: { origin },
      cookies: session.cookies,
      payload: {
        workspaceId,
        email: `${randomUUID()}@example.test`,
        role: "Viewer",
      },
    });
    expect(invitation.statusCode).toBe(200);
    const url = new URL(invitation.json<CreateAccountInvitationResponse>().url);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/dashboard/auth/invite");
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    if (!token) throw new Error("Expected a fragment-only invitation token");
    const preview = await app.inject({
      method: "POST",
      url: "/api/public/auth/google/invitation",
      headers: { origin },
      payload: { token },
    });
    expect(preview.statusCode).toBe(200);
    const started = await app.inject({
      method: "POST",
      url: "/api/public/auth/google/start",
      headers: { origin },
      payload: { invitationToken: token },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json<{ url: string }>().url).not.toContain(token);
    const cookie = started.cookies.find(
      (item) => item.name === GOOGLE_OAUTH_COOKIE_NAME,
    );
    if (!cookie) throw new Error("Expected an encrypted OAuth cookie");
    const flow = pendingFlow(app, cookie.value);
    flowIds.push(flow.flowId);
  });

  it("enforces database-backed start rate limits and bounded request bodies", async () => {
    const key = createHmac("sha256", secret)
      .update("google-account:start:127.0.0.1")
      .digest("hex");
    await db()
      .insert(schema.accountRateLimit)
      .values({ key, attempts: 30, expiresAt: new Date(Date.now() + 600_000) });
    expect((await app.inject("/api/public/auth/google/start")).statusCode).toBe(
      429,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/public/auth/google/invitation",
      headers: { origin },
      payload: { token: "x".repeat(10_000) },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  it("keeps status public but disables owned routes outside Google mode", async () => {
    const settings = configModule.default();
    jest
      .mocked(configModule.default)
      .mockReturnValue({ ...settings, authMode: "anonymous" });
    const disabledApp: DittofeedFastifyInstance = fastify<
      RawServerDefault,
      RawRequestDefaultExpression,
      RawReplyDefaultExpression,
      Logger
    >().withTypeProvider<TypeBoxTypeProvider>();
    try {
      await registerGoogleAccounts(disabledApp);
      const status = await disabledApp.inject("/api/public/auth/google/status");
      expect(status.statusCode).toBe(200);
      expect(status.json<GoogleAuthStatus>()).toMatchObject({
        enabled: false,
        configured: false,
      });
      expect((await disabledApp.inject("/api/account")).statusCode).toBe(404);
      expect(
        (await disabledApp.inject("/api/public/auth/google/start")).statusCode,
      ).toBe(404);
    } finally {
      await disabledApp.close();
    }
  });

  it("emits Secure production pending cookies on the configured HTTPS origin", async () => {
    const settings = configModule.default();
    const productionOrigin = "https://accounts.example.test";
    jest
      .mocked(configModule.default)
      .mockReturnValue({ ...settings, dashboardUrl: productionOrigin });
    const productionApp: DittofeedFastifyInstance = fastify<
      RawServerDefault,
      RawRequestDefaultExpression,
      RawReplyDefaultExpression,
      Logger
    >().withTypeProvider<TypeBoxTypeProvider>();
    try {
      await productionApp.register(secureSession, [
        {
          key: randomBytes(32),
          sessionName: GOOGLE_ACCOUNT_SESSION_NAME,
          cookieName: GOOGLE_ACCOUNT_COOKIE_NAME,
          cookie: googleAccountCookieOptions(productionOrigin),
        },
        {
          key: randomBytes(32),
          sessionName: GOOGLE_OAUTH_SESSION_NAME,
          cookieName: GOOGLE_OAUTH_COOKIE_NAME,
          cookie: googleAccountCookieOptions(productionOrigin, 600),
        },
      ]);
      await registerGoogleAccounts(productionApp);
      const response = await productionApp.inject(
        "/api/public/auth/google/start",
      );
      expect(response.statusCode).toBe(302);
      expect(String(response.headers["set-cookie"])).toContain("; Secure;");
      expect(String(response.headers["set-cookie"])).toContain("; HttpOnly;");
      expect(String(response.headers["set-cookie"])).toContain("SameSite=Lax");
      const cookie = response.cookies.find(
        (item) => item.name === GOOGLE_OAUTH_COOKIE_NAME,
      );
      if (!cookie) throw new Error("Expected a Secure OAuth cookie");
      const flow = pendingFlow(productionApp, cookie.value);
      flowIds.push(flow.flowId);
    } finally {
      await productionApp.close();
    }
  });

  it("uses Secure, HttpOnly and Lax production cookies and permits only loopback HTTP", () => {
    expect(googleAccountCookieOptions("https://app.example")).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 14 * 24 * 60 * 60,
    });
    expect(googleAccountCookieOptions(origin).secure).toBe(false);
    expect(() => googleAccountCookieOptions("http://app.example")).toThrow();
  });
});

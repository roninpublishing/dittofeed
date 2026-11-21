import secureSession, {
  SecureSessionPluginOptions,
  Session,
} from "@fastify/secure-session";
import { createHash } from "crypto";
import fastify, { FastifyInstance } from "fastify";
import { IncomingMessage } from "http";

import { GoogleAccountPrincipal, resolveAccountSession } from "./accounts";
import config, { Config, DEFAULT_BACKEND_CONFIG } from "./config";

export const GOOGLE_ACCOUNT_SESSION_NAME = "googleAccountSession";
export const GOOGLE_ACCOUNT_COOKIE_NAME = "dittofeed_google_account";
export const GOOGLE_OAUTH_SESSION_NAME = "googleOAuthSession";
export const GOOGLE_OAUTH_COOKIE_NAME = "dittofeed_google_oauth";
export const GOOGLE_ACCOUNT_TOKEN_KEY = "token";
export const GOOGLE_OAUTH_FLOW_KEY = "flow";
const SESSION_SECONDS = 14 * 24 * 60 * 60;

export interface PendingGoogleFlow {
  flowId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

declare module "fastify" {
  interface FastifyRequest {
    googleAccountPrincipal?: GoogleAccountPrincipal;
    googleAccountSession: Session<{ token?: string }>;
    googleOAuthSession: Session<{ flow?: PendingGoogleFlow }>;
  }
}

declare module "http" {
  interface IncomingMessage {
    googleAccountPrincipal?: GoogleAccountPrincipal;
    googleAccountSessionChecked?: boolean;
  }
}

/** Public-origin policy is shared by API cookies and standalone dashboard SSR. */
export function googleAccountCookieOptions(
  dashboardUrl: string,
  maxAge = SESSION_SECONDS,
) {
  const url = new URL(dashboardUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Google authentication requires HTTPS except on loopback.");
  }
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: url.protocol === "https:",
    maxAge,
  };
}

export function googleSessionPluginOptions(
  settings: Pick<Config, "dashboardUrl" | "secretKey">,
): (SecureSessionPluginOptions & { sessionName: string })[] {
  if (
    !settings.secretKey ||
    settings.secretKey === DEFAULT_BACKEND_CONFIG.secretKey ||
    Buffer.byteLength(settings.secretKey) < 32
  ) {
    throw new Error(
      "Google authentication requires a random SECRET_KEY of at least 32 bytes.",
    );
  }
  const key = createHash("sha256").update(settings.secretKey).digest();
  return [
    {
      sessionName: GOOGLE_ACCOUNT_SESSION_NAME,
      cookieName: GOOGLE_ACCOUNT_COOKIE_NAME,
      key,
      cookie: googleAccountCookieOptions(settings.dashboardUrl),
    },
    {
      sessionName: GOOGLE_OAUTH_SESSION_NAME,
      cookieName: GOOGLE_OAUTH_COOKIE_NAME,
      key,
      cookie: googleAccountCookieOptions(settings.dashboardUrl, 600),
    },
  ];
}

let cookieReader: Promise<FastifyInstance> | undefined;

/** Lite reuses its server-owned principal; standalone Next verifies the same cookie itself. */
export async function resolveGoogleRequestPrincipal(
  request: Pick<
    IncomingMessage,
    "headers" | "googleAccountPrincipal" | "googleAccountSessionChecked"
  >,
): Promise<GoogleAccountPrincipal | undefined> {
  if (config().authMode !== "google") return undefined;
  if (request.googleAccountSessionChecked)
    return request.googleAccountPrincipal;
  if (!request.headers.cookie) return undefined;
  cookieReader ??= (async () => {
    // No listening socket, routes, request logger, or alternative cryptographic implementation.
    const app = fastify({ logger: false });
    await app.register(secureSession, googleSessionPluginOptions(config()));
    await app.ready();
    return app;
  })();
  const reader = await cookieReader;
  const cookie = reader.parseCookie(request.headers.cookie)[
    GOOGLE_ACCOUNT_COOKIE_NAME
  ];
  if (!cookie) return undefined;
  const session = reader.decodeSecureSession(
    cookie,
    undefined,
    GOOGLE_ACCOUNT_SESSION_NAME,
  );
  const token: unknown = session?.get(GOOGLE_ACCOUNT_TOKEN_KEY);
  return typeof token === "string" && token.length <= 256
    ? (await resolveAccountSession(token)) ?? undefined
    : undefined;
}

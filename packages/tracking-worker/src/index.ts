interface Env {
  ENABLED?: string;
  TRACKING_ORIGIN?: string;
  OPEN_TRACKING_RELAY_SECRET?: string;
  /** Local-only opt-in; never set on a deployed Worker. */
  LOCAL_DEVELOPMENT?: string;
}

const PIXEL_PATH = /^\/api\/public\/email\/open\/([A-Za-z0-9_-]{43})\.gif$/;
const RELAY_PATH = "/api/public/email/open/relay";
const RELAY_TIMEOUT_MS = 5_000;
const MAX_ENVELOPE_BYTES = 16_384;
const encoder = new TextEncoder();
const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (character) => character.charCodeAt(0),
);

// Deliberately mirrors backend openTracking HEADERS and PROXY_HEADERS. These
// are evidence in the signed body, never HTTP headers on the origin request.
const EVIDENCE_HEADERS = [
  "user-agent", "accept", "accept-language", "accept-encoding", "cache-control",
  "pragma", "range", "if-modified-since", "if-none-match", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "sec-ch-ua",
  "sec-ch-ua-mobile", "sec-ch-ua-platform", "forwarded", "x-forwarded-for",
  "x-real-ip", "via", "cf-connecting-ip", "cf-ipcountry",
] as const;

function response(status: number, method: string, pixel = false): Response {
  const headers = new Headers({
    "cache-control": "private, no-store, no-cache, max-age=0, must-revalidate",
    "pragma": "no-cache",
    "expires": "0",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  if (status === 405) headers.set("allow", "GET, HEAD");
  if (pixel) {
    headers.set("content-type", "image/gif");
    headers.set("content-length", String(PIXEL.byteLength));
  }
  return new Response(pixel && method !== "HEAD" ? PIXEL : null, {
    status,
    headers,
  });
}

function brandedHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  return hostname.length <= 253 && labels.length >= 3 && labels[0] === "dt" &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function relayUrl(env: Env): URL | null {
  if (!env.TRACKING_ORIGIN) return null;
  const url = new URL(env.TRACKING_ORIGIN);
  // URL.origin equality also excludes empty '?', '#', escaped paths, and
  // normalization tricks: configuration must be an origin, not a destination.
  if (env.TRACKING_ORIGIN !== url.origin &&
      env.TRACKING_ORIGIN !== `${url.origin}/`) return null;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" &&
      !(env.LOCAL_DEVELOPMENT === "true" && loopback && url.protocol === "http:")) {
    return null;
  }
  return new URL(RELAY_PATH, url.origin);
}

function secretBytes(secret: string | undefined): Uint8Array | null {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) return null;
  const decoded = atob(secret);
  if (decoded.length !== 32 || btoa(decoded) !== secret) return null;
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function evidenceHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  let remaining = 3_072;
  for (const name of EVIDENCE_HEADERS) {
    if (remaining === 0) break;
    const value = headers.get(name);
    if (value === null) continue;
    const bounded = value.slice(0, Math.min(512, remaining));
    result[name] = bounded;
    remaining -= bounded.length;
  }
  return result;
}

function evidenceQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  for (const name of ["cb", "v"]) {
    const values = url.searchParams.getAll(name);
    const value = values[0];
    if (values.length === 1 && value && /^\d{1,20}$/.test(value)) query[name] = value;
  }
  return query;
}

function boundedHint(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  const localHttp = env.LOCAL_DEVELOPMENT === "true" &&
    hostname.endsWith(".localhost") && url.protocol === "http:";
  const token = PIXEL_PATH.exec(url.pathname)?.[1];
  if (!brandedHostname(hostname) || !token || url.username || url.password ||
      (!localHttp && (url.protocol !== "https:" || url.port !== ""))) {
    return response(404, request.method);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return response(405, request.method);
  }
  if (env.ENABLED !== "true") return response(503, request.method);
  const origin = relayUrl(env);
  const secret = secretBytes(env.OPEN_TRACKING_RELAY_SECRET);
  if (!origin || !secret) return response(503, request.method);

  const now = new Date();
  const body = JSON.stringify({
    v: 1,
    hostname,
    token,
    method: request.method,
    query: evidenceQuery(url),
    headers: evidenceHeaders(request.headers),
    edge: {
      receivedAt: now.toISOString(),
      remoteAddress: boundedHint(request.headers.get("cf-connecting-ip"), 64),
      httpVersion: boundedHint(request.cf?.httpProtocol, 32),
      tlsVersion: boundedHint(request.cf?.tlsVersion, 32),
    },
  });
  const bodyBytes = encoder.encode(body);
  if (bodyBytes.byteLength > MAX_ENVELOPE_BYTES) return response(503, request.method);
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const key = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  const signature = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    // Never forward request.headers, client credentials, or the pixel URL. No
    // retries: an uncertain acknowledgement is not a claim of exactly-once.
    const acknowledgement = await fetch(origin.href, {
      method: "POST",
      // workerd does not implement redirect:"error". Manual mode never follows;
      // the strict 204 check below rejects every redirect without another fetch.
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-df-tracking-timestamp": timestamp,
        "x-df-tracking-signature": signature,
      },
      body: bodyBytes,
      signal: controller.signal,
    });
    // Consume no origin response body or headers, even on errors. In particular,
    // no redirects, Set-Cookie, error text, or cache policy reach the client.
    if (acknowledgement.body) await acknowledgement.body.cancel();
    if (acknowledgement.status === 403) return response(404, request.method);
    if (acknowledgement.status !== 204) return response(503, request.method);
    return response(200, request.method, true);
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      // Includes malformed configuration, crypto, redirect, network and timeout
      // errors. Never log or reflect exception text (it may contain secrets).
      return response(503, request.method);
    }
  },
} satisfies ExportedHandler<Env>;

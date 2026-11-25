/* eslint-disable filenames/no-index -- Existing Wrangler entrypoint, not a barrel module. */
import type { DevelopmentPixelEvent } from "isomorphic-lib/src/tracking/development";
import { DEVELOPMENT_PIXEL_BATCH_PATH, DEVELOPMENT_PIXEL_EVENT_BYTES } from "isomorphic-lib/src/tracking/development";
import { networkLookup } from "isomorphic-lib/src/tracking/networks";

import type { DevelopmentPixelSnapshot } from "./development";
import { boundDevelopmentPixel, snapshotDevelopmentPixel } from "./development";
import { loadActiveNetworkSet, refreshNetworks } from "./refresh";

export interface TrackingEvent {
  v: 2;
  eventId: string;
  hostname: string;
  token: string;
  method: "GET" | "HEAD";
  query: Record<string, string>;
  headers: Record<string, string>;
  edge: {
    receivedAt: string;
    remoteAddress?: string;
    httpVersion?: string;
    tlsVersion?: string;
    asOrganization?: string;
    asn?: number;
    country?: string;
    networkSetVersion: string | null;
    network?: { id: string; version: string };
  };
}

export interface Env {
  ENABLED?: string;
  ENABLE_OPEN_TRACKING_DEV_LAKE?: string;
  TRACKING_ORIGIN?: string;
  /** DNS-only shared CNAME target; never a newsletter pixel origin. */
  CLOUDFLARE_TRACKING_CNAME_TARGET?: string;
  OPEN_TRACKING_RELAY_SECRET?: string;
  TRACKING_QUEUE?: Queue<TrackingEvent | DevelopmentPixelEvent>;
  NETWORK_SETS?: KVNamespace;
  /** Local-only opt-in; never set on a deployed Worker. */
  LOCAL_DEVELOPMENT?: string;
}

const PIXEL_PATH = /^\/api\/public\/email\/open\/([A-Za-z0-9_-]{43})\.gif$/;
const RELAY_PATH = "/api/public/email/open/batch";
const RELAY_TIMEOUT_MS = 5_000;
const MAX_ENVELOPE_BYTES = 16_384;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_EVENTS = 50;
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

async function enqueue(event: TrackingEvent, env: Env): Promise<void> {
  try {
    const { NETWORK_SETS, TRACKING_QUEUE } = env;
    if (!NETWORK_SETS || !TRACKING_QUEUE) throw new Error("tracking bindings unavailable");
    const set = await loadActiveNetworkSet(NETWORK_SETS);
    const match = set ? networkLookup(set.ranges)(event.edge.remoteAddress ?? "") : null;
    const enriched: TrackingEvent = {
      ...event,
      edge: {
        ...event.edge,
        networkSetVersion: set?.version ?? null,
        ...(set && match ? { network: { id: match.id, version: set.version } } : {}),
      },
    };
    if (encoder.encode(JSON.stringify(enriched)).byteLength > MAX_ENVELOPE_BYTES) {
      throw new Error("oversized tracking evidence");
    }
    await TRACKING_QUEUE.send(enriched);
  } catch {
    // Failed background work must remain observable to the runtime, without
    // logging request metadata or reflecting capability-bearing exception text.
    throw new Error("tracking enqueue failed");
  }
}

async function enqueueDevelopment(snapshot: DevelopmentPixelSnapshot, env: Env, bodyCapture: Promise<void>): Promise<void> {
  try {
    await bodyCapture;
    const { event } = snapshot;
    try {
      if (!env.NETWORK_SETS) throw new Error("network namespace unavailable");
      const set = await loadActiveNetworkSet(env.NETWORK_SETS);
      const ip = event.evidence.request.headers["cf-connecting-ip"] ?? "";
      const match = set ? networkLookup(set.ranges)(ip) : null;
      event.evidence.network = {
        setVersion: set?.version ?? null,
        match: set && match ? { id: match.id, version: set.version } : null,
      };
      if (!set) event.evidence.unavailable.push("network:no-active-set");
    } catch {
      event.evidence.unavailable.push("network:lookup-failed");
    }
    boundDevelopmentPixel(event);
    if (!env.TRACKING_QUEUE) throw new Error("queue unavailable");
    await env.TRACKING_QUEUE.send(event);
  } catch {
    throw new Error("tracking enqueue failed");
  }
}

function handle(request: Request, env: Env, ctx: ExecutionContext): Response {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  const localHttp = env.LOCAL_DEVELOPMENT === "true" &&
    hostname.endsWith(".localhost") && url.protocol === "http:";
  const token = PIXEL_PATH.exec(url.pathname)?.[1];
  const validHost = brandedHostname(hostname) &&
    hostname !== env.CLOUDFLARE_TRACKING_CNAME_TARGET?.toLowerCase() &&
    !url.username && !url.password &&
    (localHttp || (url.protocol === "https:" && url.port === ""));
  const development = env.ENABLE_OPEN_TRACKING_DEV_LAKE === "true";
  const pixelRoute = /^\/api\/public\/email\/open\/[^/]*\.gif$/.test(url.pathname);
  const supported = request.method === "GET" || request.method === "HEAD";
  let status = !validHost || !token ? 404 : !supported ? 405 : 200;
  // Preserve normal status ordering; development capture also covers rejected
  // methods and malformed tokens on pixel routes, never application paths.
  const shouldCapture = validHost && pixelRoute && env.ENABLED === "true";
  let configured = false;
  if ((development && shouldCapture) || status === 200) {
    try {
      configured = env.ENABLED === "true" && Boolean(relayUrl(env)) &&
        Boolean(secretBytes(env.OPEN_TRACKING_RELAY_SECRET)) && Boolean(env.TRACKING_QUEUE) &&
        (development || Boolean(env.NETWORK_SETS));
    } catch {
      configured = false;
    }
  }
  if (status === 200 && !configured) status = 503;
  if (development) {
    const reply = response(status, request.method, status === 200);
    if (shouldCapture && configured) {
      const snapshot = snapshotDevelopmentPixel(request, reply, url, token ?? null);
      const bodyCapture = snapshot.finishBody();
      ctx.waitUntil(enqueueDevelopment(snapshot, env, bodyCapture));
      if (!supported && request.body) {
        // workerd invalidates incoming body streams once the response is fully
        // sent. Send headers/status now, but keep this zero-byte response open
        // only until bounded body capture finishes, never for KV or Queue I/O.
        let canceled = false;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const close = () => { if (!canceled) controller.close(); };
            void bodyCapture.then(close, close);
          },
          cancel() { canceled = true; },
        }), { status: reply.status, headers: reply.headers });
      }
    }
    return reply;
  }
  if (status !== 200 || !token) return response(status, request.method);
  const asn = request.cf?.asn;
  const country = request.cf?.country;
  const event: TrackingEvent = {
    v: 2,
    eventId: crypto.randomUUID(),
    hostname,
    token,
    method: request.method === "HEAD" ? "HEAD" : "GET",
    query: evidenceQuery(url),
    headers: evidenceHeaders(request.headers),
    edge: {
      receivedAt: new Date().toISOString(),
      remoteAddress: boundedHint(request.headers.get("cf-connecting-ip"), 64),
      httpVersion: boundedHint(request.cf?.httpProtocol, 32),
      tlsVersion: boundedHint(request.cf?.tlsVersion, 32),
      asOrganization: boundedHint(request.cf?.asOrganization, 256),
      asn: typeof asn === "number" && Number.isSafeInteger(asn) && asn >= 0 && asn <= 0xffffffff ? asn : undefined,
      country: typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : undefined,
      networkSetVersion: null,
    },
  };
  ctx.waitUntil(enqueue(event, env));
  return response(200, request.method, true);
}

async function deliver(body: string, origin: URL, secret: Uint8Array): Promise<void> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const key = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  const signature = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const acknowledgement = await fetch(origin.href, {
      method: "POST",
      // Manual mode prevents following redirects (workerd lacks redirect:error).
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-df-tracking-timestamp": timestamp,
        "x-df-tracking-signature": signature,
      },
      body: encoder.encode(body),
      signal: controller.signal,
    });
    if (acknowledgement.body) await acknowledgement.body.cancel();
    if (acknowledgement.status !== 204) throw new Error("tracking batch not acknowledged");
  } finally {
    clearTimeout(timeout);
  }
}

async function consume(batch: MessageBatch, env: Env): Promise<void> {
  let origin: URL | null;
  let secret: Uint8Array | null;
  try {
    origin = relayUrl(env);
    secret = secretBytes(env.OPEN_TRACKING_RELAY_SECRET);
  } catch {
    batch.retryAll();
    return;
  }
  if (env.ENABLED !== "true" || !origin || !secret) {
    batch.retryAll();
    return;
  }
  // Queue mode is immutable event data, not the current producer feature flag.
  // This prevents an old development message ever entering the native pipeline.
  for (const version of [2, 3] as const) {
    const destination = version === 3 ? new URL(DEVELOPMENT_PIXEL_BATCH_PATH, origin.origin) : origin;
    const signingKey = secret;
    let messages: Message[] = [];
    let events: string[] = [];
    const emptyBodyBytes = encoder.encode(`{"v":${version},"events":[]}`).byteLength;
    let size = emptyBodyBytes;
    const flush = async () => {
      if (messages.length === 0) return;
      try {
        await deliver(`{"v":${version},"events":[${events.join(",")}]}`, destination, signingKey);
        for (const message of messages) message.ack();
      } catch {
        for (const message of messages) message.retry();
      }
      messages = [];
      events = [];
      size = emptyBodyBytes;
    };
    for (const message of batch.messages) {
      let serialized: string;
      try {
        const { body } = message;
        if (typeof body !== "object" || body === null || !("v" in body) ||
            (body.v !== 2 && body.v !== 3)) {
          if (version === 2) message.retry();
          continue;
        }
        if (body.v !== version) continue;
        serialized = JSON.stringify(body);
      } catch {
        message.retry();
        continue;
      }
      const bytes = encoder.encode(serialized).byteLength;
      if (bytes + emptyBodyBytes > MAX_BATCH_BYTES ||
          (version === 3 && bytes > DEVELOPMENT_PIXEL_EVENT_BYTES)) {
        message.retry();
        continue;
      }
      if (messages.length === MAX_BATCH_EVENTS || size + bytes + (events.length ? 1 : 0) > MAX_BATCH_BYTES) {
        // eslint-disable-next-line no-await-in-loop -- Flush before reusing bounded batch buffers.
        await flush();
      }
      size += bytes + (events.length ? 1 : 0);
      messages.push(message);
      events.push(serialized);
    }
    // eslint-disable-next-line no-await-in-loop -- Keep mode-separated batches independently acknowledged.
    await flush();
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response {
    try {
      return handle(request, env, ctx);
    } catch {
      return response(503, request.method);
    }
  },
  queue: consume,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.ENABLED !== "true") return;
    if (!env.NETWORK_SETS) throw new Error("network namespace unavailable");
    await refreshNetworks(env.NETWORK_SETS);
  },
} satisfies ExportedHandler<Env>;

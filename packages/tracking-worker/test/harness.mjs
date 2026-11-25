import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";

const bundles = new Map();
/** Real workerd, KV and Queue; origin must be an explicitly supplied local backend. */
export async function trackingWorkerOptions({ origin, secret, cf = {}, bindings = {}, consume = true, fetchMock, developmentFixture = false } = {}) {
  const entry = developmentFixture ? "./development-fixture.ts" : "../src/index.ts";
  if (!bundles.has(entry)) bundles.set(entry, build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", logLevel: "silent",
  }));
  const built = await bundles.get(entry);
  return {
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: "2025-11-09",
    bindings: {
      ENABLED: "true", TRACKING_ORIGIN: origin,
      OPEN_TRACKING_RELAY_SECRET: secret, LOCAL_DEVELOPMENT: "true", ...bindings,
    },
    kvNamespaces: ["NETWORK_SETS"],
    queueProducers: { TRACKING_QUEUE: "tracking-local" },
    queueConsumers: consume ? { "tracking-local": { maxBatchSize: 50, maxBatchTimeout: 0, retryDelay: 1, maxRetries: 2 } } : {},
    cf: { httpProtocol: "HTTP/2", tlsVersion: "TLSv1.3", asOrganization: "Example Broadband", asn: 64500, country: "US", ...cf },
    log: new Log(LogLevel.NONE),
    ...(fetchMock ? { fetchMock } : {}),
  };
}

export async function createTrackingWorker(options) {
  return new Miniflare(await trackingWorkerOptions(options));
}

/** Preserve raw header names through Node HTTP rather than fetch dictionary conversion. */
export async function dispatchTrackingHttp(worker, input, { method = "GET", headers = [], body } = {}) {
  const runtime = new URL(await worker.ready);
  const publicUrl = new URL(input);
  runtime.pathname = publicUrl.pathname;
  runtime.search = publicUrl.search;
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(runtime, {
      method,
      // Node's raw-header array path skips automatic HTTP/1.1 Host generation.
      headers: [["Host", runtime.host], ...headers, ["MF-Original-URL", input], ["MF-Disable-Pretty-Error", "true"]].flat(),
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

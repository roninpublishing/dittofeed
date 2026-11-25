import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";

let bundle;
/** Real workerd, KV and Queue; origin must be an explicitly supplied local backend. */
export async function trackingWorkerOptions({ origin, secret, cf = {}, bindings = {}, consume = true, fetchMock } = {}) {
  bundle ??= build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", logLevel: "silent",
  });
  const built = await bundle;
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

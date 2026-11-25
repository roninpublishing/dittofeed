import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createTrackingWorker, dispatchTrackingHttp, trackingWorkerOptions } from "./harness.mjs";

const TOKEN = "A".repeat(43);
const URL = `https://dt.newsletter.test/api/public/email/open/${TOKEN}.gif`;
const DEV_PATH = "/api/public/email/open/development-batch";
const NORMAL_PATH = "/api/public/email/open/batch";
const SECRET = Buffer.alloc(32, 19).toString("base64");
const EVENT_CAP = 120 * 1024;
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

async function backendFixture(t) {
  const records = [];
  const signals = new EventEmitter();
  let status = 204;
  let hold;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const record = { path: request.url, headers: request.headers, body: Buffer.concat(chunks) };
    records.push(record);
    if (hold) hold(response);
    else response.writeHead(status).end();
    signals.emit("record", record);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`, records,
    status(value) { status = value; }, hold(handler) { hold = handler; },
    async next() { return (await once(signals, "record", { signal: AbortSignal.timeout(10_000) }))[0]; },
  };
}
function signature(record, path = DEV_PATH) {
  assert.equal(record.path, path);
  const timestamp = record.headers["x-df-tracking-timestamp"];
  assert.match(timestamp, /^\d+$/);
  assert.equal(record.headers["x-df-tracking-signature"], createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(`${timestamp}.`).update(record.body).digest("hex"));
  assert.ok(record.body.length <= 1024 * 1024);
}
function parsed(record) {
  signature(record);
  const batch = JSON.parse(record.body);
  assert.equal(batch.v, 3);
  for (const event of batch.events) {
    assert.equal(event.v, 3);
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= EVENT_CAP);
    assert.ok(!JSON.stringify(event.evidence).includes(TOKEN));
    for (const name of ["redactions", "truncations", "unavailable"]) {
      assert.ok(event.evidence[name].every((entry) => typeof entry === "string" && entry.length > 0));
    }
  }
  return batch.events[0];
}
function normalEvent() {
  return { v: 2, eventId: randomUUID(), hostname: "dt.newsletter.test", token: TOKEN,
    method: "GET", query: {}, headers: {}, edge: { receivedAt: new Date().toISOString(), networkSetVersion: null } };
}
function developmentEvent(padding = "") {
  return { v: 3, eventId: randomUUID(), hostname: "dt.newsletter.test", token: TOKEN, occurredAt: new Date().toISOString(),
    evidence: { request: { url: "https://dt.newsletter.test/[REDACTED]", method: "GET", headers: { "x-padding": padding }, properties: {},
      body: { encoding: "base64", data: "", capturedBytes: 0, declaredBytes: null, truncated: false, unavailable: null } },
    cloudflare: {}, response: { status: 200, headers: {} }, network: { setVersion: null, match: null }, redactions: [], truncations: [], unavailable: [] } };
}

test("development Worker broadly snapshots requests without changing pixel responses", { timeout: 120_000 }, async (t) => {
  const backend = await backendFixture(t);
  const options = await trackingWorkerOptions({ origin: backend.origin, secret: SECRET, developmentFixture: true,
    bindings: { ENABLE_OPEN_TRACKING_DEV_LAKE: "true", CLOUDFLARE_TRACKING_CNAME_TARGET: "dt.service.test", FIXTURE_METADATA: JSON.stringify({ mutable: "at-fetch", __nested: { useful: [1, true, "ok"], apiKey: "private-nested-key" } }) },
    cf: { city: "Fixture City", tlsCipher: "AEAD-AES128-GCM-SHA256", tlsClientAuth: { certPresented: "1", certVerified: "SUCCESS", certSubjectDN: "CN=fixture" },
      botManagement: { score: 12, verifiedBot: true, staticResource: false, nested: { unknownFutureField: [1, "retained"] } } },
  });
  const worker = new Miniflare(options);
  t.after(() => worker.dispose());

  await t.test("response precedes origin acknowledgement; headers, URL, cf, properties and response survive", async () => {
    let acknowledge;
    backend.hold((response) => { acknowledge = () => response.writeHead(204).end(); });
    const next = backend.next();
    try {
      const response = await Promise.race([
        dispatchTrackingHttp(worker, `${URL}?plain=one&api_key=private-query&plain=two&access_token=private-token`, { headers: [
          ["user-agent", "x".repeat(2048)], ["x-custom-observation", "y".repeat(4096)], ["__proto__", "unusual-header"],
          ["cookie", "private-cookie"], ["authorization", "Bearer private-authorization"], ["cf-connecting-ip", "192.0.2.10"],
          ["referer", `https://referrer.test/path?plain=retained&token=private-referrer&again=${TOKEN}`],
          ["x-source-url", "https://source.test/?password=private-source&harmless=ok"],
        ] }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("pixel waited for origin")), 2000).unref()),
      ]);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), GIF);
      const event = parsed(await next);
      const { evidence } = event;
      assert.equal(event.token, TOKEN);
      assert.match(event.eventId, /^[0-9a-f-]{36}$/);
      assert.equal(evidence.request.headers["user-agent"], "x".repeat(2048));
      assert.equal(evidence.request.headers["x-custom-observation"], "y".repeat(4096));
      assert.equal(evidence.request.headers.__proto__, "unusual-header");
      assert.equal(evidence.request.headers.cookie, "[REDACTED]");
      assert.equal(evidence.request.headers.authorization, "[REDACTED]");
      const retainedUrl = new globalThis.URL(evidence.request.url);
      assert.deepEqual(retainedUrl.searchParams.getAll("plain"), ["one", "two"]);
      assert.deepEqual([...retainedUrl.searchParams.keys()], ["plain", "api_key", "plain", "access_token"]);
      assert.equal(retainedUrl.searchParams.get("api_key"), "[REDACTED]");
      assert.equal(evidence.cloudflare.city, "Fixture City");
      assert.equal(evidence.cloudflare.tlsClientAuth.certSubjectDN, "CN=fixture");
      assert.deepEqual(evidence.cloudflare.botManagement.nested.unknownFutureField, [1, "retained"]);
      assert.equal(evidence.request.properties.fixtureMetadata.mutable, "at-fetch");
      assert.equal(evidence.request.properties.fixtureMetadata.__nested.apiKey, "[REDACTED]");
      assert.equal(evidence.request.properties.credentials, "same-origin");
      assert.ok(evidence.request.properties.redirect || evidence.unavailable.includes("request.properties.redirect:not-exposed"));
      assert.ok(evidence.request.properties.signal || evidence.unavailable.some((entry) => entry.startsWith("request.properties.signal:")));
      assert.ok(evidence.unavailable.includes("cloudflare.postalCode:not-exposed"));
      assert.equal(evidence.response.status, 200);
      assert.equal(evidence.response.headers["content-type"], "image/gif");
      assert.match(evidence.response.headers["cache-control"], /no-store/);
      assert.deepEqual(evidence.truncations, []);
      assert.ok(!JSON.stringify(evidence).includes("private-"));
    } finally { acknowledge?.(); backend.hold(undefined); }
  });

  await t.test("HEAD, duplicate, unknown, malformed and unsupported requests each retain their original status", async () => {
    const ids = new Set();
    for (const [url, method, expected, token] of [
      [URL, "HEAD", 200, TOKEN], [URL, "GET", 200, TOKEN], [URL, "GET", 200, TOKEN],
      [URL.replace(TOKEN, "B".repeat(43)), "GET", 200, "B".repeat(43)],
      [URL.replace(TOKEN, "bad%2Dtoken"), "GET", 404, null],
      [URL.replace(TOKEN, ""), "GET", 404, null],
      [URL, "POST", 405, TOKEN], [URL, "OPTIONS", 405, TOKEN],
      [URL.replace(TOKEN, "malformed"), "DELETE", 404, null],
    ]) {
      const next = backend.next();
      const response = await worker.dispatchFetch(url, { method });
      assert.equal(response.status, expected);
      if (method === "HEAD") assert.equal((await response.arrayBuffer()).byteLength, 0);
      const event = parsed(await next);
      assert.equal(event.token, token);
      assert.equal(event.evidence.request.method, method);
      assert.equal(event.evidence.response.status, expected);
      assert.ok(!ids.has(event.eventId));
      ids.add(event.eventId);
      assert.ok(!event.evidence.request.url.includes("bad%2Dtoken"));
      assert.ok(!event.evidence.request.url.includes("malformed"));
    }
  });

  await t.test("nonpixel paths and wrong hosts do not enter capture", async () => {
    const before = backend.records.length;
    for (const url of ["https://dt.newsletter.test/dashboard", "https://dt.newsletter.test/api/public/email/open/batch", "https://dt.newsletter.test/api/public/email/open/development-batch", URL.replace("dt.newsletter.test", "dt.service.test"), URL.replace("dt.newsletter.test", "newsletter.test"), `${URL}/extra`]) {
      assert.equal((await worker.dispatchFetch(url)).status, 404);
    }
    assert.equal(backend.records.length, before);
  });

  await t.test("JSON, forms and opaque binary bodies retain observations and redact named credentials", async () => {
    const cases = [
      ["application/json", JSON.stringify({ password: "private-password", safe: "retained", large: "z".repeat(20_000), nested: { sessionToken: "private-session", values: [1, true] }, tokenCopy: TOKEN }), (data) => {
        const value = JSON.parse(data); assert.equal(value.password, "[REDACTED]"); assert.equal(value.safe, "retained"); assert.equal(value.large, "z".repeat(20_000));
        assert.equal(value.nested.sessionToken, "[REDACTED]"); assert.deepEqual(value.nested.values, [1, true]);
      }],
      ["application/x-www-form-urlencoded", `plain=one&api_key=private-key&plain=two&cap=${TOKEN}`, (data) => {
        const value = new URLSearchParams(data.toString("utf8")); assert.deepEqual(value.getAll("plain"), ["one", "two"]); assert.equal(value.get("api_key"), "[REDACTED]");
      }],
      ["application/octet-stream", Buffer.from([0, 255, 128, 10, 1]), (data) => assert.deepEqual(data, Buffer.from([0, 255, 128, 10, 1]))],
    ];
    for (const [contentType, body, inspect] of cases) {
      const next = backend.next();
      assert.equal((await worker.dispatchFetch(URL, { method: "POST", headers: { "content-type": contentType }, body })).status, 405);
      const event = parsed(await next);
      const captured = Buffer.from(event.evidence.request.body.data, "base64");
      inspect(captured);
      assert.equal(event.evidence.request.body.capturedBytes, captured.length);
      assert.equal(event.evidence.request.body.truncated, false);
      assert.equal(event.evidence.request.body.unavailable, null);
      assert.ok(!captured.includes(Buffer.from("private-")));
      assert.ok(!captured.includes(Buffer.from(TOKEN)));
    }
  });

  await t.test("bounded native multipart parsing preserves ordered repeated parts and files with redaction", async () => {
    const body = [
      "--fixture", 'Content-Disposition: form-data; name="plain"', "", "one",
      "--fixture", 'Content-Disposition: form-data; name="password"', "", "private-password",
      "--fixture", 'Content-Disposition: form-data; name="plain"', "", "two",
      "--fixture", 'Content-Disposition: form-data; name="attachment"; filename="fixture.bin"', "Content-Type: application/octet-stream", "", `binary-${TOKEN}`,
      "--fixture--", "",
    ].join("\r\n");
    const next = backend.next();
    assert.equal((await worker.dispatchFetch(URL, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=fixture" }, body })).status, 405);
    const event = parsed(await next);
    assert.equal(event.evidence.request.body.unavailable, null);
    assert.equal(event.evidence.request.properties.developmentBodyRepresentation, "multipart-parts-json");
    const parts = JSON.parse(Buffer.from(event.evidence.request.body.data, "base64").toString("utf8"));
    assert.deepEqual(parts.slice(0, 3), [{ name: "plain", value: "one" }, { name: "password", value: "[REDACTED]" }, { name: "plain", value: "two" }]);
    assert.equal(parts[3].file.name, "fixture.bin");
    assert.equal(parts[3].file.type, "application/octet-stream");
    const file = Buffer.from(parts[3].file.base64, "base64").toString("utf8");
    assert.ok(file.startsWith("binary-"));
    assert.ok(!file.includes(TOKEN));
    assert.ok(!JSON.stringify(parts).includes("private-password"));
  });

  await t.test("malformed multipart and unsafe JSON are explicit rather than secret-bearing", async () => {
    for (const [contentType, body, unavailable] of [
      ["multipart/form-data; boundary=fixture", "not-a-multipart-message", "invalid-multipart-redaction-unsafe"],
      ["application/json", '{"password":"private-password"', "invalid-json-redaction-unsafe"],
      ["application/json", JSON.stringify({ safe: "x".repeat(EVENT_CAP * 2), password: "private-password" }), "truncated-json-redaction-unsafe"],
    ]) {
      const next = backend.next();
      assert.equal((await worker.dispatchFetch(URL, { method: "POST", headers: { "content-type": contentType }, body })).status, 405);
      const event = parsed(await next);
      assert.equal(event.evidence.request.body.data, "");
      assert.equal(event.evidence.request.body.unavailable, unavailable);
      assert.ok(event.evidence.unavailable.includes(`request.body:${unavailable}`));
      if (body.length > EVENT_CAP) assert.equal(event.evidence.request.body.truncated, true);
    }
  });

  await t.test("development evidence retains the available active network set and match", async () => {
    const kv = await worker.getKVNamespace("NETWORK_SETS");
    await kv.put("sets:development-fixture", JSON.stringify({ version: "development-fixture", generatedAt: new Date().toISOString(), ranges: {
      "apple-private-relay": ["172.224.226.0/27"], "google-services": ["66.249.80.0/20"],
      "microsoft-exchange-online": ["40.107.0.0/16"], mimecast: ["205.139.110.0/24"], "proofpoint-essentials": ["148.163.128.0/19"],
    } }));
    await kv.put("active", "development-fixture");
    const next = backend.next();
    assert.equal((await worker.dispatchFetch(URL, { headers: { "cf-connecting-ip": "172.224.226.5" } })).status, 200);
    assert.deepEqual(parsed(await next).evidence.network, { setVersion: "development-fixture", match: { id: "apple-private-relay", version: "development-fixture" } });
  });

  await t.test("KV lookup failure or absence cannot discard a development hit", async () => {
    const kv = await worker.getKVNamespace("NETWORK_SETS");
    await kv.put("active", "missing-version");
    const next = backend.next();
    assert.equal((await worker.dispatchFetch(URL)).status, 200);
    const event = parsed(await next);
    assert.ok(event.evidence.unavailable.includes("network:lookup-failed"));
    assert.deepEqual(event.evidence.network, { setVersion: null, match: null });
    await worker.setOptions({ ...options, kvNamespaces: [] });
    try {
      const absent = backend.next();
      assert.equal((await worker.dispatchFetch(URL)).status, 200);
      assert.ok(parsed(await absent).evidence.unavailable.includes("network:lookup-failed"));
    } finally { await worker.setOptions(options); }
    await (await worker.getKVNamespace("NETWORK_SETS")).put("active", "development-fixture");
  });

  await t.test("UTF8 metadata and body caps produce valid under120KiB events with explicit flags", async () => {
    await worker.setOptions({ ...options, bindings: { ...options.bindings, FIXTURE_METADATA: JSON.stringify({ text: "界😀".repeat(40_000), keys: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`field-${i}`, "value"])) }) } });
    try {
      const next = backend.next();
      assert.equal((await worker.dispatchFetch(URL, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x".repeat(EVENT_CAP * 2) })).status, 405);
      const event = parsed(await next);
      assert.ok(event.evidence.truncations.length > 0);
      assert.equal(event.evidence.request.body.truncated, true);
      assert.equal(Buffer.from(event.evidence.request.body.data, "base64").length, event.evidence.request.body.capturedBytes);
      assert.ok(!JSON.stringify(event.evidence).includes("�"));
    } finally { await worker.setOptions(options); }
  });

  await t.test("deep structures and oversized metadata keys terminate with explicit physical bounds", async () => {
    const deep = {};
    let branch = deep;
    for (let i = 0; i < 40; i += 1) branch = branch.child = {};
    const fixtures = [deep, { ["界".repeat(50_000)]: "short-value" }];
    for (const metadata of fixtures) {
      await worker.setOptions({ ...options, bindings: { ...options.bindings, FIXTURE_METADATA: JSON.stringify(metadata) } });
      const next = backend.next();
      assert.equal((await worker.dispatchFetch(URL)).status, 200);
      const event = parsed(await next);
      assert.ok(event.evidence.truncations.length > 0);
    }
    await worker.setOptions(options);
  });

  await t.test("body read failures and deadlines never delay HTTP or discard the envelope", async () => {
    for (const mode of ["stall", "error"]) {
      await worker.setOptions({ ...options, bindings: { ...options.bindings, FIXTURE_BODY: mode } });
      const next = backend.next();
      const started = Date.now();
      assert.equal((await worker.dispatchFetch(URL, { method: "POST" })).status, 405);
      assert.ok(Date.now() - started < 900, "response awaited body consumption");
      const event = parsed(await next);
      assert.equal(event.evidence.request.body.unavailable, mode === "stall" ? "read-timeout" : "read-failed");
      if (mode === "stall") assert.equal(Buffer.from(event.evidence.request.body.data, "base64").toString("utf8"), "partial");
      assert.ok(!JSON.stringify(event.evidence).includes("private stream diagnostic"));
    }
    await worker.setOptions(options);
  });

  await t.test("incomplete relay configuration preserves rejected-request status and never recaptures relay endpoints", async () => {
    await worker.setOptions({ ...options, bindings: { ...options.bindings, TRACKING_ORIGIN: "invalid private origin" } });
    const before = backend.records.length;
    assert.equal((await worker.dispatchFetch(URL)).status, 503);
    assert.equal((await worker.dispatchFetch(URL, { method: "POST" })).status, 405);
    assert.equal((await worker.dispatchFetch(URL.replace(TOKEN, "bad"))).status, 404);
    assert.equal((await worker.dispatchFetch("https://dt.newsletter.test/api/public/email/open/development-batch", { method: "POST" })).status, 404);
    assert.equal(backend.records.length, before);
    await worker.setOptions(options);
  });

  await t.test("disabled normal tracking prevents development collection and flagfalse restores v2", async () => {
    const before = backend.records.length;
    await worker.setOptions({ ...options, bindings: { ...options.bindings, ENABLED: "false" } });
    assert.equal((await worker.dispatchFetch(URL)).status, 503);
    assert.equal((await worker.dispatchFetch(URL, { method: "POST" })).status, 405);
    assert.equal(backend.records.length, before);
    await worker.setOptions({ ...options, bindings: { ...options.bindings, ENABLE_OPEN_TRACKING_DEV_LAKE: "false" } });
    const next = backend.next();
    assert.equal((await worker.dispatchFetch(URL)).status, 200);
    const record = await next;
    signature(record, NORMAL_PATH);
    assert.equal(JSON.parse(record.body).v, 2);
    await worker.setOptions(options);
  });
});

test("native Queue pins each message mode across mixed batches, toggles, mismatch and retries", { timeout: 120_000 }, async (t) => {
  const backend = await backendFixture(t);
  const options = await trackingWorkerOptions({ origin: backend.origin, secret: SECRET, consume: false });
  const worker = new Miniflare(options);
  t.after(() => worker.dispose());
  const dispatch = async (events) => (await worker.getWorker()).queue("tracking-local", events.map((body) => ({ id: body.eventId, timestamp: new Date(), attempts: 1, body })));

  await t.test("modeoff mixed messages use distinct signed endpoints", async () => {
    const events = [developmentEvent(), normalEvent(), developmentEvent(), normalEvent()];
    const result = await dispatch(events);
    assert.equal(result.explicitAcks.length, 4);
    assert.deepEqual(backend.records.map((record) => record.path), [NORMAL_PATH, DEV_PATH]);
    for (const record of backend.records) {
      const body = JSON.parse(record.body);
      signature(record, body.v === 3 ? DEV_PATH : NORMAL_PATH);
      assert.ok(body.events.every((event) => event.v === body.v));
    }
  });

  await t.test("backend503 mismatch retries identical evidence and UUID even after toggling producer mode", async () => {
    const event = developmentEvent("immutable-request-evidence");
    backend.status(503);
    assert.equal((await dispatch([event])).retryMessages.length, 1);
    const failed = backend.records.at(-1);
    signature(failed);
    await worker.setOptions({ ...options, bindings: { ...options.bindings, ENABLE_OPEN_TRACKING_DEV_LAKE: "true" } });
    backend.status(204);
    assert.equal((await dispatch([event])).explicitAcks.length, 1);
    const retry = backend.records.at(-1);
    signature(retry);
    assert.deepEqual(retry.body, failed.body);
    assert.deepEqual(JSON.parse(retry.body).events[0], event);
    await worker.setOptions(options);
  });

  await t.test("development batches obey50items,1MiB and120KiB individual serialized bounds", async () => {
    const before = backend.records.length;
    const events = Array.from({ length: 53 }, () => developmentEvent("界".repeat(30_000)));
    const result = await dispatch(events);
    assert.equal(result.explicitAcks.length, events.length);
    assert.equal(result.retryMessages.length, 0);
    const records = backend.records.slice(before);
    assert.ok(records.length > 1);
    for (const record of records) { signature(record); assert.ok(JSON.parse(record.body).events.length <= 50); }
    assert.deepEqual(records.flatMap((record) => JSON.parse(record.body).events), events);
    const oversized = developmentEvent("界".repeat(50_000));
    const recordCount = backend.records.length;
    assert.equal((await dispatch([oversized])).retryMessages.length, 1);
    assert.equal(backend.records.length, recordCount);
    const many = Array.from({ length: 51 }, () => developmentEvent());
    assert.equal((await dispatch(many)).explicitAcks.length, 51);
    assert.deepEqual(backend.records.slice(recordCount).map((record) => JSON.parse(record.body).events.length), [50, 1]);
  });
});

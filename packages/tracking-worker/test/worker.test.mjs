import assert from "node:assert/strict";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createTrackingWorker, trackingWorkerOptions } from "./harness.mjs";

const TOKEN = "A".repeat(43);
const PIXEL_PATH = `/api/public/email/open/${TOKEN}.gif`;
const PUBLIC_URL = `https://dt.newsletter.test${PIXEL_PATH}`;
const SECRET = Buffer.alloc(32, 19).toString("base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const FIXTURE_RANGES = {
  "apple-private-relay": ["172.224.226.0/27"],
  "google-services": ["66.249.80.0/20"],
  "microsoft-exchange-online": ["40.107.0.0/16"],
  mimecast: ["205.139.110.0/24"],
  "proofpoint-essentials": ["148.163.128.0/19"],
};

function assertPrivate(response) {
  for (const directive of ["private", "no-store", "no-cache"]) assert.ok(response.headers.get("cache-control")?.includes(directive));
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("location"), null);
}
async function assertFailure(response, status) {
  assert.equal(response.status, status);
  assertPrivate(response);
  assert.equal(response.headers.get("content-type"), null);
  assert.equal(await response.text(), "");
}
function event(overrides = {}) {
  return {
    v: 2, eventId: randomUUID(), hostname: "dt.newsletter.test", token: TOKEN,
    method: "GET", query: {}, headers: { "user-agent": "Fixture browser" },
    edge: { receivedAt: new Date().toISOString(), networkSetVersion: null }, ...overrides,
  };
}
async function originFixture(t) {
  const records = [];
  const signals = new EventEmitter();
  let reply = (_request, response) => response.writeHead(204).end();
  const origin = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const record = { method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks) };
    records.push(record);
    reply(request, response, record);
    signals.emit("record", record);
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  t.after(async () => {
    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
  });
  return {
    origin: `http://127.0.0.1:${origin.address().port}`, records,
    reply(handler) { reply = handler; },
    async next() { return (await once(signals, "record", { signal: AbortSignal.timeout(10_000) }))[0]; },
  };
}
function assertSignature(record) {
  assert.equal(record.path, "/api/public/email/open/batch");
  assert.equal(record.method, "POST");
  assert.equal(record.headers["content-type"], "application/json");
  const timestamp = record.headers["x-df-tracking-timestamp"];
  const signature = record.headers["x-df-tracking-signature"];
  assert.match(timestamp, /^\d+$/);
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.ok(Math.abs(Number(timestamp) * 1000 - Date.now()) < 10_000);
  const expected = createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(`${timestamp}.`).update(record.body).digest();
  assert.ok(timingSafeEqual(expected, Buffer.from(signature, "hex")));
}

test("respond-first production Worker with real workerd Queue, KV and HTTP backend", { timeout: 120_000 }, async (t) => {
  const backend = await originFixture(t);
  const options = await trackingWorkerOptions({ origin: backend.origin, secret: SECRET });
  const worker = new Miniflare(options);
  t.after(() => worker.dispose());

  await t.test("wrong hosts, routes, transport and methods never enqueue", async () => {
    for (const url of [
      `https://newsletter.test${PIXEL_PATH}`, `https://dt.newsletter..test${PIXEL_PATH}`,
      `https://dt.-newsletter.test${PIXEL_PATH}`, `https://dt.newsletter${PIXEL_PATH}`,
      `https://dt.newsletter.test:444${PIXEL_PATH}`, `http://dt.newsletter.test${PIXEL_PATH}`,
      "https://dt.newsletter.test/dashboard?secret=private",
      "https://dt.newsletter.test/api/public/email/open/relay",
      "https://dt.newsletter.test/api/public/email/open/batch",
      `${PUBLIC_URL}/extra`, PUBLIC_URL.replace(TOKEN, TOKEN.slice(1)),
      PUBLIC_URL.replace(TOKEN, `${TOKEN}A`), PUBLIC_URL.replace(TOKEN, `${TOKEN.slice(1)}%41`),
    ]) await assertFailure(await worker.dispatchFetch(url), 404);
    for (const method of ["POST", "PUT", "OPTIONS", "DELETE"]) {
      const response = await worker.dispatchFetch(PUBLIC_URL, { method });
      await assertFailure(response, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    }
    await assertFailure(await worker.dispatchFetch("https://dt.newsletter.test/missing", { method: "HEAD" }), 404);
    assert.equal(backend.records.length, 0);
  });

  await t.test("disabled or incomplete configuration fails closed", async () => {
    for (const override of [
      { ENABLED: "false" }, { ENABLED: "TRUE" }, { ENABLED: "" },
      { TRACKING_ORIGIN: "" }, { TRACKING_ORIGIN: "not an origin; private diagnostic" },
      { TRACKING_ORIGIN: `${backend.origin}/private` }, { TRACKING_ORIGIN: `${backend.origin}?secret=private` },
      { TRACKING_ORIGIN: `${backend.origin}#private` }, { TRACKING_ORIGIN: backend.origin.replace("//", "//user:private@") },
      { TRACKING_ORIGIN: "http://origin.example.test" }, { LOCAL_DEVELOPMENT: "false" },
      { OPEN_TRACKING_RELAY_SECRET: "" }, { OPEN_TRACKING_RELAY_SECRET: Buffer.alloc(31).toString("base64") },
      { OPEN_TRACKING_RELAY_SECRET: `${SECRET.slice(0, -2)}B=` },
    ]) {
      await worker.setOptions({ ...options, bindings: { ...options.bindings, ...override } });
      await assertFailure(await worker.dispatchFetch(PUBLIC_URL), 503);
    }
    for (const override of [{ kvNamespaces: [] }, { queueProducers: {} }]) {
      await worker.setOptions({ ...options, ...override, queueConsumers: {} });
      await assertFailure(await worker.dispatchFetch(PUBLIC_URL), 503);
    }
    assert.equal(backend.records.length, 0);
    await worker.setOptions(options);
  });

  await t.test("returns GIF before backend acknowledgement and signs bounded v2 evidence", async () => {
    let acknowledge;
    backend.reply((_request, response) => { acknowledge = () => response.writeHead(204, {
      "set-cookie": "origin-private=secret", "cache-control": "public, max-age=999999", "x-private": "private diagnostic",
    }).end(); });
    const next = backend.next();
    try {
      const response = await Promise.race([
        worker.dispatchFetch(`${PUBLIC_URL}?cb=123&v=7&email=private-query&redirect=https://private.test`, {
          headers: {
            cookie: "private-cookie", authorization: "Bearer private-authorization", referer: "https://private-referrer.test/",
            "x-private": "private-header", "x-df-tracking-signature": "private-forged-signature", "x-df-tracking-timestamp": "1",
            "user-agent": "Probe/1.0 (ASCII fixture)", "accept-language": "en-US", forwarded: "for=192.0.2.10;proto=https",
            "x-forwarded-for": "192.0.2.10", "cf-connecting-ip": "192.0.2.11", "cf-ipcountry": "ZZ",
          },
        }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("pixel waited for backend")), 2000).unref()),
      ]);
      assert.equal(response.status, 200);
      assertPrivate(response);
      assert.equal(response.headers.get("content-type"), "image/gif");
      assert.equal(response.headers.get("x-private"), null);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), GIF);
      const record = await next;
      assertSignature(record);
      const batch = JSON.parse(record.body);
      assert.equal(batch.v, 2);
      assert.equal(batch.events.length, 1);
      const envelope = batch.events[0];
      assert.match(envelope.eventId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
      assert.equal(envelope.v, 2);
      assert.equal(envelope.hostname, "dt.newsletter.test");
      assert.equal(envelope.token, TOKEN);
      assert.equal(envelope.method, "GET");
      assert.deepEqual(envelope.query, { cb: "123", v: "7" });
      assert.equal(envelope.headers["user-agent"], "Probe/1.0 (ASCII fixture)");
      assert.equal(envelope.headers.forwarded, "for=192.0.2.10;proto=https");
      assert.equal(envelope.headers["x-forwarded-for"], "192.0.2.10");
      assert.equal(envelope.edge.remoteAddress, "192.0.2.11");
      assert.equal(envelope.edge.httpVersion, "HTTP/2");
      assert.equal(envelope.edge.tlsVersion, "TLSv1.3");
      assert.equal(envelope.edge.asOrganization, "Example Broadband");
      assert.equal(envelope.edge.asn, 64500);
      assert.equal(envelope.edge.country, "US");
      assert.equal(envelope.edge.networkSetVersion, null);
      assert.equal(envelope.edge.network, undefined);
      for (const forbidden of ["private-", PIXEL_PATH, PUBLIC_URL, SECRET]) assert.ok(!record.body.toString().includes(forbidden));
      for (const name of ["cookie", "authorization", "referer", "x-private"]) {
        assert.equal(record.headers[name], undefined);
        assert.equal(envelope.headers[name], undefined);
      }
    } finally {
      acknowledge?.();
      backend.reply((_request, response) => response.writeHead(204).end());
    }
  });

  await t.test("bounds evidence and only retains singular numeric query hints", async () => {
    const names = [
      "user-agent", "accept", "accept-language", "accept-encoding", "cache-control", "pragma", "range",
      "if-modified-since", "if-none-match", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
      "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "forwarded", "x-forwarded-for", "x-real-ip", "via",
      "cf-connecting-ip", "cf-ipcountry",
    ];
    const next = backend.next();
    assert.equal((await worker.dispatchFetch(`${PUBLIC_URL}?cb=1&cb=2&v=${"1".repeat(21)}&unknown=private`, {
      headers: Object.fromEntries(names.map((name) => [name, "x".repeat(700)])),
    })).status, 200);
    const record = await next;
    const envelope = JSON.parse(record.body).events[0];
    assert.deepEqual(envelope.query, {});
    assert.ok(Object.keys(envelope.headers).every((name) => names.includes(name)));
    assert.equal(Object.values(envelope.headers).reduce((sum, value) => sum + value.length, 0), 3072);
    assert.ok(Object.values(envelope.headers).every((value) => value.length <= 512));
    assert.equal(envelope.edge.remoteAddress.length, 64);
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 16_384);
    for (const [query, expected] of [["cb=-1&v=1.5", {}], [`cb=0&v=${"9".repeat(20)}`, { cb: "0", v: "9".repeat(20) }]]) {
      const nextRecord = backend.next();
      await worker.dispatchFetch(`${PUBLIC_URL}?${query}`);
      assert.deepEqual(JSON.parse((await nextRecord).body).events[0].query, expected);
    }
  });

  await t.test("bounds organization to the backend contract and drops invalid edge countries", async () => {
    await worker.setOptions({
      ...options, cf: { ...options.cf, asOrganization: "x".repeat(700), country: "USA" },
    });
    try {
      const next = backend.next();
      assert.equal((await worker.dispatchFetch(PUBLIC_URL)).status, 200);
      const edge = JSON.parse((await next).body).events[0].edge;
      assert.equal(edge.asOrganization, "x".repeat(256));
      assert.equal(edge.country, undefined);
    } finally {
      await worker.setOptions(options);
    }
  });

  await t.test("HEAD queues evidence without a body; HTTP remains local only", async () => {
    const next = backend.next();
    const response = await worker.dispatchFetch(PUBLIC_URL, { method: "HEAD" });
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.equal(response.headers.get("content-length"), String(GIF.length));
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(JSON.parse((await next).body).events[0].method, "HEAD");
    const local = backend.next();
    assert.equal((await worker.dispatchFetch(`http://dt.newsletter.localhost${PIXEL_PATH}`)).status, 200);
    assert.equal(JSON.parse((await local).body).events[0].hostname, "dt.newsletter.localhost");
    await assertFailure(await worker.dispatchFetch(`http://dt.newsletter.test${PIXEL_PATH}`), 404);
  });

  await t.test("active network set is recorded for matches and unmatched IPs", async () => {
    const kv = await worker.getKVNamespace("NETWORK_SETS");
    await kv.put("sets:fixture", JSON.stringify({ version: "fixture", generatedAt: new Date().toISOString(), ranges: FIXTURE_RANGES }));
    await kv.put("active", "fixture");
    for (const [ip, id] of [["172.224.226.5", "apple-private-relay"], ["205.139.110.9", "mimecast"], ["192.0.2.10", null]]) {
      const next = backend.next();
      await worker.dispatchFetch(PUBLIC_URL, { headers: { "cf-connecting-ip": ip } });
      const edge = JSON.parse((await next).body).events[0].edge;
      assert.equal(edge.networkSetVersion, "fixture");
      assert.deepEqual(edge.network, id ? { id, version: "fixture" } : undefined);
    }
  });

  await t.test("unknown well-formed tokens still get a GIF while failed queue deliveries retry", async () => {
    backend.reply((_request, response) => response.writeHead(503).end("private failure"));
    const first = backend.next();
    const response = await worker.dispatchFetch(PUBLIC_URL.replace(TOKEN, "B".repeat(43)));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), GIF);
    const failed = JSON.parse((await first).body).events[0];
    assert.equal(failed.token, "B".repeat(43));
    backend.reply((_request, reply) => reply.writeHead(204).end());
    const retried = JSON.parse((await backend.next()).body).events[0];
    assert.equal(retried.eventId, failed.eventId);
  });
});

test("native queue consumer acknowledgements, byte bounds and stable retries", { timeout: 120_000 }, async (t) => {
  const backend = await originFixture(t);
  const worker = await createTrackingWorker({ origin: backend.origin, secret: SECRET, consume: false });
  t.after(() => worker.dispose());
  const service = await worker.getWorker();
  const dispatch = (events) => service.queue("tracking-local", events.map((body) => ({
    id: body.eventId, timestamp: new Date(), attempts: 1, body,
  })));

  await t.test("splits by fifty events and signs each exact body", async () => {
    const events = Array.from({ length: 100 }, () => event());
    const result = await dispatch(events);
    assert.equal(result.retryMessages.length, 0);
    assert.equal(result.explicitAcks.length, 100);
    assert.equal(backend.records.length, 2);
    assert.deepEqual(backend.records.map((record) => JSON.parse(record.body).events.length), [50, 50]);
    backend.records.forEach(assertSignature);
    assert.deepEqual(backend.records.flatMap((record) => JSON.parse(record.body).events.map((item) => item.eventId)), events.map((item) => item.eventId));
  });

  await t.test("splits on UTF-8 bytes, not character count", async () => {
    const before = backend.records.length;
    const events = Array.from({ length: 13 }, () => event({ headers: { "user-agent": "界".repeat(30_000) } }));
    const result = await dispatch(events);
    assert.equal(result.explicitAcks.length, events.length);
    assert.equal(result.retryMessages.length, 0);
    const records = backend.records.slice(before);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.body.length <= 1024 * 1024));
    assert.equal(records.flatMap((record) => JSON.parse(record.body).events).length, events.length);
    records.forEach(assertSignature);
  });

  await t.test("every non-204 retries without following redirects or changing event IDs", async () => {
    const body = event();
    for (const status of [200, 202, 301, 302, 307, 308, 401, 403, 404, 429, 500, 503]) {
      const before = backend.records.length;
      backend.reply((_request, response) => response.writeHead(status, {
        location: `${backend.origin}/private-redirect`, "set-cookie": "private=secret",
      }).end("private origin diagnostic"));
      const result = await dispatch([body]);
      assert.equal(result.explicitAcks.length, 0);
      assert.equal(result.retryMessages.length, 1);
      assert.equal(backend.records.length, before + 1);
      assertSignature(backend.records.at(-1));
      assert.equal(JSON.parse(backend.records.at(-1).body).events[0].eventId, body.eventId);
    }
    backend.reply((_request, response) => response.writeHead(204).end());
    assert.equal((await dispatch([body])).explicitAcks.length, 1);
  });

  await t.test("successful chunks are acknowledged independently of a later failed chunk", async () => {
    let calls = 0;
    backend.reply((_request, response) => response.writeHead(++calls === 1 ? 204 : 503).end());
    const result = await dispatch(Array.from({ length: 51 }, () => event()));
    assert.equal(result.explicitAcks.length, 50);
    assert.equal(result.retryMessages.length, 1);
  });

  await t.test("network failures and timeouts retry safely", { timeout: 12_000 }, async () => {
    backend.reply((request) => request.socket.destroy());
    assert.equal((await dispatch([event()])).retryMessages.length, 1);
    let hanging;
    backend.reply((_request, response) => { hanging = response; });
    const started = Date.now();
    assert.equal((await dispatch([event()])).retryMessages.length, 1);
    assert.ok(Date.now() - started >= 4500);
    hanging?.destroy();
  });

  await t.test("oversized individual messages retry without HTTP", async () => {
    const before = backend.records.length;
    const result = await dispatch([event({ headers: { "user-agent": "x".repeat(1024 * 1024) } })]);
    assert.equal(result.retryMessages.length, 1);
    assert.equal(backend.records.length, before);
  });
});

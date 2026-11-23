import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";

// This suite executes the production Worker bundle in native workerd. The
// origin is a real loopback HTTP server, not a replacement for global fetch.
// Only inbound pixel/relay requests occur; there is no account or email setup.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  logLevel: "silent",
});
const script = bundled.outputFiles[0].text;
const TOKEN = "A".repeat(43);
const PIXEL_PATH = `/api/public/email/open/${TOKEN}.gif`;
const PUBLIC_URL = `https://dt.newsletter.test${PIXEL_PATH}`;
const SECRET = Buffer.alloc(32, 19).toString("base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function assertPrivate(response) {
  const cacheControl = response.headers.get("cache-control");
  for (const directive of ["private", "no-store", "no-cache"]) {
    assert.ok(cacheControl?.includes(directive));
  }
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

test("native workerd branded tracking relay", { timeout: 120_000 }, async (t) => {
  const received = [];
  let reply = (_request, response) => response.writeHead(204).end();
  const origin = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const record = { method: request.method, path: request.url, headers: request.headers, body };
    received.push(record);
    reply(request, response, record);
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const bindings = {
    ENABLED: "true",
    TRACKING_ORIGIN: originUrl,
    OPEN_TRACKING_RELAY_SECRET: SECRET,
    LOCAL_DEVELOPMENT: "true",
  };
  const options = {
    modules: true,
    script,
    compatibilityDate: "2025-11-09",
    bindings,
    cf: { httpProtocol: "HTTP/2", tlsVersion: "TLSv1.3" },
    log: new Log(LogLevel.NONE),
  };
  const worker = new Miniflare(options);
  t.after(async () => {
    await worker.dispose();
    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
  });

  await t.test("wrong hosts, routes, transport and methods never contact origin", async () => {
    const before = received.length;
    for (const url of [
      `https://newsletter.test${PIXEL_PATH}`,
      `https://dt.newsletter..test${PIXEL_PATH}`,
      `https://dt.-newsletter.test${PIXEL_PATH}`,
      `https://dt.newsletter${PIXEL_PATH}`,
      `https://dt.newsletter.test:444${PIXEL_PATH}`,
      `http://dt.newsletter.test${PIXEL_PATH}`,
      `https://dt.newsletter.test/dashboard?secret=private`,
      `https://dt.newsletter.test/api/public/email/open/relay`,
      `${PUBLIC_URL}/extra`,
      PUBLIC_URL.replace(TOKEN, TOKEN.slice(1)),
      PUBLIC_URL.replace(TOKEN, `${TOKEN}A`),
      PUBLIC_URL.replace(TOKEN, `${TOKEN.slice(1)}%41`),
    ]) {
      await assertFailure(await worker.dispatchFetch(url), 404);
    }
    for (const method of ["POST", "PUT", "OPTIONS", "DELETE"]) {
      const response = await worker.dispatchFetch(PUBLIC_URL, { method });
      await assertFailure(response, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    }
    await assertFailure(await worker.dispatchFetch("https://dt.newsletter.test/missing", {
      method: "HEAD",
    }), 404);
    assert.equal(received.length, before);
  });

  await t.test("disabled and malformed configuration fail closed without fetching", async () => {
    const before = received.length;
    for (const override of [
      { ENABLED: "false" },
      { ENABLED: "TRUE" },
      { ENABLED: "" },
      { TRACKING_ORIGIN: "" },
      { TRACKING_ORIGIN: "not an origin; private diagnostic" },
      { TRACKING_ORIGIN: `${originUrl}/private` },
      { TRACKING_ORIGIN: `${originUrl}?secret=private` },
      { TRACKING_ORIGIN: `${originUrl}#private` },
      { TRACKING_ORIGIN: originUrl.replace("//", "//user:private@") },
      { TRACKING_ORIGIN: "http://origin.example.test" },
      { LOCAL_DEVELOPMENT: "false" },
      { OPEN_TRACKING_RELAY_SECRET: "" },
      { OPEN_TRACKING_RELAY_SECRET: Buffer.alloc(31).toString("base64") },
      { OPEN_TRACKING_RELAY_SECRET: `${SECRET.slice(0, -2)}B=` },
    ]) {
      await worker.setOptions({ ...options, bindings: { ...bindings, ...override } });
      await assertFailure(await worker.dispatchFetch(PUBLIC_URL), 503);
    }
    await worker.setOptions({ ...options, bindings: {} });
    await assertFailure(await worker.dispatchFetch(PUBLIC_URL), 503);
    assert.equal(received.length, before);
    await worker.setOptions(options);
  });

  await t.test("exact body bytes are signed; client secrets and URL are not forwarded", async () => {
    reply = (_request, response) => response.writeHead(204, {
      "set-cookie": "origin-private=secret",
      "cache-control": "public, max-age=999999",
      "x-private": "private diagnostic",
    }).end();
    const before = Date.now();
    const response = await worker.dispatchFetch(
      `${PUBLIC_URL}?cb=123&v=7&email=private-query&redirect=https://private.test`,
      { headers: {
        cookie: "private-cookie",
        authorization: "Bearer private-authorization",
        referer: "https://private-referrer.test/",
        "x-private": "private-header",
        "x-df-tracking-signature": "private-forged-signature",
        "x-df-tracking-timestamp": "1",
        "user-agent": "Probe/1.0 (ASCII fixture)",
        "accept-language": "en-US",
        forwarded: "for=192.0.2.10;proto=https",
        "x-forwarded-for": "192.0.2.10",
        "cf-connecting-ip": "192.0.2.11",
      } },
    );
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.equal(response.headers.get("content-type"), "image/gif");
    assert.equal(response.headers.get("x-private"), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), GIF);
    const record = received.at(-1);
    assert.equal(record.path, "/api/public/email/open/relay");
    assert.equal(record.method, "POST");
    assert.equal(record.headers["content-type"], "application/json");
    const timestamp = record.headers["x-df-tracking-timestamp"];
    const signature = record.headers["x-df-tracking-signature"];
    assert.match(timestamp, /^\d+$/);
    assert.match(signature, /^[a-f0-9]{64}$/);
    assert.ok(Math.abs(Number(timestamp) * 1000 - before) < 10_000);
    const expected = createHmac("sha256", Buffer.from(SECRET, "base64"))
      .update(`${timestamp}.`).update(record.body).digest();
    assert.ok(timingSafeEqual(expected, Buffer.from(signature, "hex")));
    const envelope = JSON.parse(record.body);
    assert.deepEqual(Object.keys(envelope).sort(), [
      "edge", "headers", "hostname", "method", "query", "token", "v",
    ]);
    assert.equal(envelope.v, 1);
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
    assert.ok(Date.parse(envelope.edge.receivedAt) >= before);
    const body = record.body.toString("utf8");
    for (const forbidden of ["private-", PIXEL_PATH, PUBLIC_URL, SECRET]) {
      assert.ok(!body.includes(forbidden));
    }
    for (const name of ["cookie", "authorization", "referer", "x-private"]) {
      assert.equal(record.headers[name], undefined);
      assert.equal(envelope.headers[name], undefined);
    }
    assert.notEqual(record.headers["user-agent"], envelope.headers["user-agent"]);
    assert.notEqual(record.headers["x-forwarded-for"], "192.0.2.10");
  });

  await t.test("bounded allowlist and duplicate/nonnumeric queries", async () => {
    const names = [
      "user-agent", "accept", "accept-language", "accept-encoding", "cache-control",
      "pragma", "range", "if-modified-since", "if-none-match", "sec-fetch-dest",
      "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "sec-ch-ua",
      "sec-ch-ua-mobile", "sec-ch-ua-platform", "forwarded", "x-forwarded-for",
      "x-real-ip", "via", "cf-connecting-ip", "cf-ipcountry",
    ];
    const headers = Object.fromEntries(names.map((name) => [name, "x".repeat(700)]));
    const response = await worker.dispatchFetch(
      `${PUBLIC_URL}?cb=1&cb=2&v=${"1".repeat(21)}&unknown=private`, { headers },
    );
    assert.equal(response.status, 200);
    const record = received.at(-1);
    const envelope = JSON.parse(record.body);
    assert.deepEqual(envelope.query, {});
    assert.ok(Object.keys(envelope.headers).every((name) => names.includes(name)));
    assert.equal(Object.values(envelope.headers).reduce((sum, value) => sum + value.length, 0), 3072);
    assert.ok(Object.values(envelope.headers).every((value) => value.length <= 512));
    assert.equal(envelope.edge.remoteAddress.length, 64);
    assert.ok(record.body.length <= 16_384);
    await worker.dispatchFetch(`${PUBLIC_URL}?cb=-1&v=1.5`);
    assert.deepEqual(JSON.parse(received.at(-1).body).query, {});
    await worker.dispatchFetch(`${PUBLIC_URL}?cb=0&v=${"9".repeat(20)}`);
    assert.deepEqual(JSON.parse(received.at(-1).body).query, { cb: "0", v: "9".repeat(20) });
  });


  await t.test("HEAD persists evidence and has the same image headers but no body", async () => {
    const response = await worker.dispatchFetch(PUBLIC_URL, { method: "HEAD" });
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.equal(response.headers.get("content-type"), "image/gif");
    assert.equal(response.headers.get("content-length"), String(GIF.length));
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(JSON.parse(received.at(-1).body).method, "HEAD");
    assert.equal(received.at(-1).method, "POST");
  });

  await t.test("HTTP is local-only even when development is opted in", async () => {
    const response = await worker.dispatchFetch(`http://dt.newsletter.localhost${PIXEL_PATH}`);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(received.at(-1).body).hostname, "dt.newsletter.localhost");
    await assertFailure(await worker.dispatchFetch(`http://dt.newsletter.test${PIXEL_PATH}`), 404);
  });

  await t.test("only 204 acknowledges persistence; redirects are never followed", async () => {
    for (const status of [200, 202, 301, 302, 307, 308, 401, 403, 404, 429, 500, 503]) {
      const before = received.length;
      reply = (_request, response) => response.writeHead(status, {
        location: `${originUrl}/private-redirect`,
        "set-cookie": "private=secret",
        "content-type": "image/gif",
      }).end("private origin diagnostic");
      await assertFailure(await worker.dispatchFetch(PUBLIC_URL), status === 403 ? 404 : 503);
      assert.equal(received.length, before + 1);
      assert.equal(received.at(-1).path, "/api/public/email/open/relay");
    }
    reply = (_request, response) => response.writeHead(500).end("private failure");
    await assertFailure(await worker.dispatchFetch(PUBLIC_URL, { method: "HEAD" }), 503);
  });

  await t.test("a pixel is not released before durable acknowledgement", { timeout: 8_000 }, async () => {
    let acknowledge;
    let observed;
    const started = new Promise((resolve) => { observed = resolve; });
    reply = (_request, response) => {
      acknowledge = () => response.writeHead(204).end();
      observed();
    };
    let settled = false;
    const pending = worker.dispatchFetch(PUBLIC_URL).then((response) => {
      settled = true;
      return response;
    });
    try {
      await Promise.race([
        started,
        pending.then((response) => {
          assert.fail(`Worker returned ${response.status} before origin receipt`);
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(settled, false);
    } finally {
      acknowledge?.();
    }
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), GIF);
  });

  await t.test("network failures and bounded timeouts are generic failures", { timeout: 12_000 }, async () => {
    reply = (request) => request.socket.destroy();
    await assertFailure(await worker.dispatchFetch(PUBLIC_URL), 503);
    let hangingResponse;
    reply = (_request, response) => { hangingResponse = response; };
    const started = Date.now();
    await assertFailure(await worker.dispatchFetch(PUBLIC_URL), 503);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4_500 && elapsed < 10_000, `timeout took ${elapsed}ms`);
    hangingResponse?.destroy();
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { createFetchMock } from "miniflare";
import { createTrackingWorker } from "./harness.mjs";

const SECRET = Buffer.alloc(32, 19).toString("base64");
const APPLE = Array.from({ length: 5 }, (_unused, index) => `172.224.${226 + index}.0/27,US,region,city,`).join("\n");
function sourceFixture() {
  return {
    apple: { statusCode: 200, data: APPLE },
    google: { statusCode: 200, data: { prefixes: [{ ipv4Prefix: "66.249.80.0/20" }, { ipv4Prefix: "198.51.100.0/24" }, { ipv6Prefix: "2001:db8::/32" }] } },
    cloud: { statusCode: 200, data: { prefixes: [{ ipv4Prefix: "198.51.100.0/24" }] } },
    microsoft: { statusCode: 200, data: [{ serviceArea: "Exchange", ips: ["40.107.0.0/16"] }, { serviceArea: "SharePoint", ips: ["192.0.2.0/24"] }] },
    mimecast: { statusCode: 200, data: { Status: 0, Answer: [{ type: 16, data: '"v=spf1 incl" "ude:region.mimecast.com ip4:205.139.110.0/24 ~all"' }] } },
    region: { statusCode: 200, data: { Status: 0, Answer: [{ type: 16, data: '"v=spf1 ip4:207.211.30.0/24 ip6:2001:db8:ffff::/48 -all"' }] } },
  };
}

test("weekly production scheduled refresh uses real KV and official HTTP/DoH parsers", { timeout: 120_000 }, async (t) => {
  let sources = sourceFixture();
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const register = (origin, path, key, headers) => fetchMock.get(origin).intercept({ path, headers }).reply(() => {
    const source = sources[key];
    return { statusCode: source.statusCode, data: typeof source.data === "string" ? source.data : JSON.stringify(source.data) };
  }).persist();
  register("https://mask-api.icloud.com", "/egress-ip-ranges.csv", "apple");
  register("https://www.gstatic.com", "/ipranges/goog.json", "google");
  register("https://www.gstatic.com", "/ipranges/cloud.json", "cloud");
  register("https://endpoints.office.com", /^\/endpoints\/worldwide\?clientrequestid=[0-9a-f-]+$/, "microsoft");
  register("https://cloudflare-dns.com", "/dns-query?name=_netblocks.mimecast.com&type=TXT", "mimecast", { accept: "application/dns-json" });
  register("https://cloudflare-dns.com", "/dns-query?name=region.mimecast.com&type=TXT", "region", { accept: "application/dns-json" });
  const worker = await createTrackingWorker({ origin: "http://127.0.0.1:1", secret: SECRET, consume: false, fetchMock });
  t.after(() => worker.dispose());
  const service = await worker.getWorker();
  const kv = await worker.getKVNamespace("NETWORK_SETS");
  const refresh = () => service.scheduled({ cron: "0 3 * * 1" });

  await t.test("initial missing data is not silently bootstrapped from committed ranges", async () => {
    assert.equal(await kv.get("active"), null);
    assert.deepEqual((await kv.list()).keys, []);
    sources.apple.statusCode = 503;
    assert.notEqual((await refresh()).outcome, "ok");
    assert.equal(await kv.get("active"), null);
    assert.deepEqual((await kv.list()).keys, []);
    sources = sourceFixture();
  });

  await t.test("publishes one immutable version only after all sources succeed", async () => {
    assert.equal((await refresh()).outcome, "ok");
    const version = await kv.get("active");
    assert.ok(version.length <= 128);
    const set = await kv.get(`sets:${version}`, "json");
    assert.equal(set.version, version);
    assert.ok(Number.isFinite(Date.parse(set.generatedAt)));
    assert.equal(set.ranges["apple-private-relay"].length, 5);
    assert.deepEqual(set.ranges["google-services"], ["66.249.80.0/20", "2001:db8::/32"]);
    assert.deepEqual(set.ranges["microsoft-exchange-online"], ["40.107.0.0/16"]);
    assert.deepEqual(set.ranges.mimecast, ["205.139.110.0/24", "207.211.30.0/24", "2001:db8:ffff::/48"]);
    assert.ok(set.ranges["proofpoint-essentials"].includes("148.163.128.0/19"));
    const previous = await kv.get(`sets:${version}`);
    assert.equal((await refresh()).outcome, "ok");
    assert.notEqual(await kv.get("active"), version);
    assert.equal(await kv.get(`sets:${version}`), previous);
  });

  await t.test("accepts the larger official Apple CSV while preserving its bounded failure policy", async () => {
    sources.apple.data = APPLE.split("\n").map((line) => `${line}${"x".repeat(1_300_000)}`).join("\n");
    assert.equal((await refresh()).outcome, "ok");
    const version = await kv.get("active");
    assert.equal((await kv.get(`sets:${version}`, "json")).ranges["apple-private-relay"].length, 5);
    sources.apple.data = `${APPLE}\n${" ".repeat(16 * 1024 * 1024)}`;
    assert.notEqual((await refresh()).outcome, "ok");
    assert.equal(await kv.get("active"), version);
    sources = sourceFixture();
  });

  await t.test("source HTTP, parsing, empty and DNS failures retain the entire prior set", async () => {
    const beforeVersion = await kv.get("active");
    const before = await kv.get(`sets:${beforeVersion}`);
    const beforeKeys = (await kv.list()).keys.map(({ name }) => name);
    for (const [key, replacement] of [
      ["apple", { statusCode: 503, data: "private upstream error" }],
      ["apple", { statusCode: 200, data: "not-an-address,US,,," }],
      ["apple", { statusCode: 200, data: "" }],
      ["google", { statusCode: 200, data: { prefixes: [{ invalid: "66.249.80.0/20" }] } }],
      ["cloud", { statusCode: 200, data: "invalid JSON" }],
      ["microsoft", { statusCode: 200, data: [{ serviceArea: "Exchange", ips: ["invalid CIDR"] }] }],
      ["microsoft", { statusCode: 200, data: [{ serviceArea: "SharePoint", ips: ["192.0.2.0/24"] }] }],
      ["mimecast", { statusCode: 200, data: { Status: 2 } }],
      ["mimecast", { statusCode: 200, data: { Status: 0, Answer: [{ type: 16, data: "unquoted garbage" }] } }],
      ["region", { statusCode: 503, data: "DNS unavailable" }],
      ["region", { statusCode: 200, data: { Status: 0, Answer: [{ type: 16, data: '"v=spf1 include:_netblocks.mimecast.com -all"' }] } }],
    ]) {
      sources = sourceFixture();
      sources[key] = replacement;
      assert.notEqual((await refresh()).outcome, "ok", key);
      assert.equal(await kv.get("active"), beforeVersion, key);
      assert.equal(await kv.get(`sets:${beforeVersion}`), before, key);
      assert.deepEqual((await kv.list()).keys.map(({ name }) => name), beforeKeys, key);
    }
    sources = sourceFixture();
  });

  await t.test("greater-than-20-percent block or address shrink fails; exactly 20 percent may publish", async () => {
    const previous = await kv.get("active");
    sources.apple.data = APPLE.split("\n").slice(0, 3).join("\n");
    assert.notEqual((await refresh()).outcome, "ok");
    assert.equal(await kv.get("active"), previous);
    sources = sourceFixture();
    // Same number of blocks, but much less coverage must also fail.
    sources.apple.data = APPLE.replaceAll("/27", "/28");
    assert.notEqual((await refresh()).outcome, "ok");
    assert.equal(await kv.get("active"), previous);
    sources = sourceFixture();
    sources.apple.data = APPLE.split("\n").slice(0, 4).join("\n");
    assert.equal((await refresh()).outcome, "ok");
    assert.notEqual(await kv.get("active"), previous);
    sources = sourceFixture();
  });

  await t.test("missing active version data fails loudly without overwriting the pointer", async () => {
    await kv.put("active", "missing-version");
    assert.notEqual((await refresh()).outcome, "ok");
    assert.equal(await kv.get("active"), "missing-version");
  });
});

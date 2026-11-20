import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { InitializeResult, ListToolsResult, ReadResourceResult } from "@modelcontextprotocol/server";

type ToolReply = { isError: boolean; content: { type: "text"; text: string }[] };
import { ApiBridge, ApiDocument, BridgeConfig, createOperations, loadBridgeConfig } from "../src/api";

const workspaceId = "6d38dd4e-781f-4ca0-8ee4-cf671721656b";
const config: BridgeConfig = { baseUrl: new URL("http://127.0.0.1:3000"), workspaceId, apiKey: "test-private-key", scopes: ["read"] };
const document: ApiDocument = {
  paths: {
    "/api/admin/users/": { post: {
      description: "Query contacts", requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["workspaceId", "limit"],
        properties: { workspaceId: { type: "string" }, limit: { type: "integer", minimum: 1 }, filter: { $ref: "#/components/schemas/Filter" } },
      } } } },
    } },
    "/api/admin/segments/": { put: { requestBody: { required: true, content: { "application/json": { schema: {
      allOf: [
        { type: "object", required: ["workspaceId"], properties: { workspaceId: { type: "string" } } },
        { anyOf: [
          { type: "object", required: ["name"], properties: { name: { type: "string" } } },
          { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        ] },
      ],
    } } } } } },
    "/api/admin/users/v2": { delete: {} },
    "/api/admin/secrets/": { get: {} },
    "/api/admin/events/": { get: { parameters: [
      { name: "workspaceId", in: "query", required: true, schema: { type: "string" } },
      { name: "event", in: "query", schema: { type: "array", items: { type: "string" } } },
    ] } },
    "/api/admin/segments/upload-csv": { post: { parameters: [{ name: "df-segment-id", in: "header", required: true, schema: { type: "string" } }] } },
  },
  components: { schemas: {
    Filter: { type: "object", properties: { child: { $ref: "#/components/schemas/Filter" } } },
    Unused: { type: "string" },
  } },
};

function operation(path: string, scopes = config.scopes) {
  const value = [...createOperations(document, scopes).values()].find((item) => item.path === path);
  assert.ok(value, `Missing operation ${path}`);
  return value;
}

test("read-only keys can query POST contacts but cannot discover writes, deletion or secret access", () => {
  assert.deepEqual([...createOperations(document, ["read"]).values()].map((item) => item.path).sort(), ["/api/admin/events/", "/api/admin/users/"]);
  assert.equal(createOperations(document, ["sensitive"]).size, 0, "sensitive alone must not expose credentials");
});

test("JSON calls inject only the fixed workspace, retain recursive schema and reject invalid consumer input", async () => {
  let received: { url: URL; init: RequestInit } | undefined;
  const bridge = new ApiBridge(config, async (input, init) => {
    received = { url: new URL(String(input)), init: init! };
    return new Response('{"users":[],"nextCursor":"next"}', { headers: { "content-type": "application/json" } });
  });
  const query = operation("/api/admin/users/");
  assert.deepEqual(Object.keys(query.tool.inputSchema.$defs as object), ["Filter"]);
  const result = await bridge.invoke(query, { body: { limit: 3, filter: { child: {} } } });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).nextCursor, "next");
  assert.equal(new Headers(received!.init.headers).get("df-workspace-id"), workspaceId);
  assert.equal(new Headers(received!.init.headers).get("authorization"), `Bearer ${config.apiKey}`);
  assert.deepEqual(JSON.parse(String(received!.init.body)), { limit: 3, filter: { child: {} }, workspaceId });
  assert.equal(received!.init.redirect, "error");
  await assert.rejects(bridge.invoke(query, { body: { limit: 0 } }), /Invalid tool arguments/);
  await assert.rejects(bridge.invoke(query, { body: { limit: 3, workspaceId: "other" } }), /Invalid tool arguments|configured workspace/);
  await assert.rejects(bridge.invoke(query, { headers: { authorization: "Bearer attacker" }, body: { limit: 3 } }), /Invalid tool arguments/);
  await assert.rejects(bridge.invoke(operation("/api/admin/segments/", ["write"]), { body: {} }), /not granted/);
});

test("union/intersection request bodies inject workspace without weakening consumer fields", async () => {
  const bridge = new ApiBridge({ ...config, scopes: ["write"] }, async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init!.body)), { name: "Audience", workspaceId });
    return new Response('{"id":"segment-created"}', { headers: { "content-type": "application/json" } });
  });
  const upsert = operation("/api/admin/segments/", ["write"]);
  assert.equal((await bridge.invoke(upsert, { body: { name: "Audience" } })).status, 200);
  await assert.rejects(bridge.invoke(upsert, { body: {} }), /Invalid tool arguments/);
  await assert.rejects(bridge.invoke(upsert, { body: { name: "Audience", workspaceId: "other" } }), /configured workspace/);
});

test("query arrays round-trip through API qs format and downloads are not coerced into JSON", async () => {
  const bridge = new ApiBridge(config, async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("event[0]"), "DFEmailOpened");
    assert.equal(url.searchParams.get("event[1]"), "DFEmailClicked");
    assert.equal(url.searchParams.get("workspaceId"), workspaceId);
    return new Response("id,email\nu1,one@example.com\n", { headers: { "content-type": "text/csv" } });
  });
  const result = await bridge.invoke(operation("/api/admin/events/"), { query: { event: ["DFEmailOpened", "DFEmailClicked"] } });
  assert.equal(result.encoding, "utf8");
  assert.equal(result.body, "id,email\nu1,one@example.com\n");
});

test("multipart uploads accept declared application headers, never a caller-selected tenant or credential", async () => {
  const bridge = new ApiBridge({ ...config, scopes: ["write"] }, async (_input, init) => {
    const form = init!.body as FormData;
    const file = form.get("file") as File;
    assert.equal(await file.text(), "id\nu1\n");
    assert.equal(new Headers(init!.headers).get("df-segment-id"), "segment-1");
    assert.equal(new Headers(init!.headers).get("df-workspace-id"), workspaceId);
    return new Response(null, { status: 204 });
  });
  const upload = operation("/api/admin/segments/upload-csv", ["write"]);
  const input = { headers: { "df-segment-id": "segment-1" }, file: { filename: "contacts.csv", contentBase64: Buffer.from("id\nu1\n").toString("base64") } };
  assert.equal((await bridge.invoke(upload, input)).status, 204);
  await assert.rejects(bridge.invoke(upload, { ...input, headers: { ...input.headers, "df-workspace-id": "other" } }), /Invalid tool arguments/);
});

test("configured endpoint requires TLS off loopback and catalogs cannot select an arbitrary route", () => {
  const env = { DITTOFEED_API_URL: "http://example.com", DITTOFEED_WORKSPACE_ID: workspaceId, DITTOFEED_API_KEY: config.apiKey };
  assert.throws(() => loadBridgeConfig(env), /HTTPS/);
  assert.throws(() => loadBridgeConfig({ ...env, DITTOFEED_API_URL: "https://user:pass@example.com" }), /credentials/);
  assert.throws(() => createOperations({ paths: { "https://attacker.test/": { get: {} } } }, ["read"]), /outside the machine API/);
  assert.throws(() => createOperations({ paths: { "/api/admin/../public/": { get: {} } } }, ["read"]), /outside the machine API/);
});

test("redirects cannot forward the bearer key to a second server", async () => {
  let leaked = false;
  const destination = createServer((_request, response) => { leaked = true; response.end("unexpected"); });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const origin = createServer((_request, response) => { response.writeHead(307, { location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/` }); response.end(); });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  try {
    const bridge = new ApiBridge({ ...config, baseUrl: new URL(`http://127.0.0.1:${(origin.address() as AddressInfo).port}`) });
    await assert.rejects(bridge.discover());
    assert.equal(leaked, false);
  } finally { origin.closeAllConnections(); destination.closeAllConnections(); await Promise.all([new Promise<void>((resolve) => origin.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]); }
});

test("real stdio MCP initialization, typed tool call, API failure and contract resource", async () => {
  const api = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${config.apiKey}`);
    assert.equal(request.headers["df-workspace-id"], workspaceId);
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/admin/openapi.json")) { response.end(JSON.stringify(document)); return; }
    if (request.method === "POST" && request.url?.startsWith("/api/admin/users/")) {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        assert.equal(JSON.parse(body).workspaceId, workspaceId);
        response.end('{"users":[{"id":"contact-1"}]}');
      });
      return;
    }
    response.statusCode = 401;
    response.end('{"message":"revoked"}');
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [require.resolve("../src/index")], { env: { ...process.env,
    DITTOFEED_API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, DITTOFEED_WORKSPACE_ID: workspaceId,
    DITTOFEED_API_KEY: config.apiKey, DITTOFEED_MCP_SCOPES: "read" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: unknown) => void>();
  lines.on("line", (line) => {
    const value: unknown = JSON.parse(line);
    assert.ok(value && typeof value === "object" && "id" in value && typeof value.id === "number");
    if ("result" in value) pending.get(value.id)?.(value.result);
    else throw new Error("Unexpected MCP error response");
  });
  let id = 0;
  // Node 20 support precludes Promise.withResolvers. This deadline bounds real child-process I/O, not a timing assertion.
  const rpc = <T,>(method: string, params?: object): Promise<T> => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 15_000);
    pending.set(requestId, (value) => {
      clearTimeout(timer);
      pending.delete(requestId);
      // The protocol operation fixes T; assertions below verify the returned consumer contract.
      resolve(value as T);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  try {
    const initialize = await rpc<InitializeResult>("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "regression", version: "1" } });
    assert.equal(initialize.serverInfo.name, "ronin-dittofeed");
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await rpc<ListToolsResult>("tools/list");
    const query = listed.tools.find((tool) => tool.description?.includes("POST /api/admin/users/"));
    assert.ok(query);
    const success = await rpc<ToolReply>("tools/call", { name: query.name, arguments: { body: { limit: 1 } } });
    assert.equal(success.isError, false);
    assert.equal(JSON.parse(JSON.parse(success.content[0]!.text).body).users[0].id, "contact-1");
    const events = listed.tools.find((tool) => tool.description?.includes("GET /api/admin/events/"));
    assert.ok(events);
    const revoked = await rpc<ToolReply>("tools/call", { name: events.name, arguments: {} });
    assert.equal(revoked.isError, true);
    assert.equal(JSON.parse(revoked.content[0]!.text).status, 401);
    const resource = await rpc<ReadResourceResult>("resources/read", { uri: "dittofeed://api/openapi" });
    const contract = resource.contents[0];
    assert.ok(contract && "text" in contract);
    assert.ok(JSON.parse(contract.text).paths["/api/admin/users/"]);
    const denied = await rpc<ToolReply>("tools/call", { name: "unknown", arguments: {} });
    assert.equal(denied.isError, true);
  } finally {
    lines.close(); child.kill(); api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

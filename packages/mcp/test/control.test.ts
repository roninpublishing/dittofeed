import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { ListToolsResult } from "@modelcontextprotocol/server";
import { UpdateAccountProfileRequest } from "isomorphic-lib/src/accounts";
import { API_OPERATION_SCOPES, requiredApiScopes } from "isomorphic-lib/src/apiOperations";
import {
  ChannelType,
  GetMessageTemplatesRequest,
  LowCodeEmailJsonBody,
  RenderMessageTemplateRequest,
  RenderMessageTemplateType,
  UpsertMessageTemplateResource,
} from "isomorphic-lib/src/types";
import { ApiBridge, ApiDocument, createOperations } from "../src/api";

type ToolReply = { isError: boolean; content: { type: "text"; text: string }[] };
type Json = Record<string, unknown>;
const workspaceId = "6d38dd4e-781f-4ca0-8ee4-cf671721656b";
const fullKey = "isolated-fixture-owner-key";
const readKey = "isolated-fixture-reader-key";
const body = (schema: object) => ({ required: true, content: { "application/json": { schema } } });
const parameterSchema = GetMessageTemplatesRequest;
const document = JSON.parse(JSON.stringify({
  paths: {
    "/api/admin/content/templates": {
      get: { parameters: Object.entries(parameterSchema.properties).map(([name, schema]) => ({
        name, in: "query", required: parameterSchema.required?.includes(name), schema,
      })) },
      put: { requestBody: body(UpsertMessageTemplateResource) },
    },
    "/api/admin/content/templates/render": { post: { requestBody: body(RenderMessageTemplateRequest) } },
    "/api/admin/account": { get: {}, patch: { requestBody: body(UpdateAccountProfileRequest) } },
    "/api/admin/account/logout": { post: {} },
    "/api/admin/account/team": { get: {} },
  },
  components: { schemas: { LowCodeEmailJsonBody } },
}, (name, value: unknown) => name === "$ref" && typeof value === "string" && !value.startsWith("#/")
  ? `#/components/schemas/${value}` : value)) as ApiDocument;

async function consumer(baseUrl: string, scopes: string, apiKey = fullKey) {
  const child = spawn(process.execPath, [require.resolve("../src/index")], {
    env: { ...process.env, DITTOFEED_API_URL: baseUrl, DITTOFEED_WORKSPACE_ID: workspaceId,
      DITTOFEED_API_KEY: apiKey, DITTOFEED_MCP_SCOPES: scopes },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const fail = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("MCP consumer exited before replying")));
  lines.on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error("MCP protocol request failed"));
    else waiter?.resolve(message.result);
  });
  let nextId = 0;
  // Node 20 lacks Promise.withResolvers. This deadline bounds child-process I/O;
  // replies resolve on real protocol events, never on a guessed sleep.
  const rpc = <T,>(method: string, params?: object): Promise<T> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 15_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value as T); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const close = async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  };
  try {
    await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "control-regression", version: "1" } });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await rpc<ListToolsResult>("tools/list");
    return { rpc, listed, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// A deterministic isolated HTTP fixture exercises the real compiled bridge and
// stdio server. It performs no application/provider mutations or message sends.
async function fixture() {
  const templates = new Map<string, Json>();
  const requests: { method: string; path: string; body: Json }[] = [];
  let ownerEnabled = true;
  let keyRevoked = false;
  const api = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    assert.equal(request.headers["df-workspace-id"], workspaceId);
    const credential = request.headers.authorization;
    assert.ok([`Bearer ${fullKey}`, `Bearer ${readKey}`].includes(String(credential)));
    if (url.pathname === "/api/admin/openapi.json") { response.end(JSON.stringify(document)); return; }
    assert.equal(url.searchParams.get("workspaceId"), workspaceId);
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const input = (raw ? JSON.parse(raw) : {}) as Json;
    requests.push({ method: request.method!, path: url.pathname, body: input });
    const send = (status: number, result: unknown) => { response.statusCode = status; response.end(JSON.stringify(result)); };
    if (keyRevoked) { send(401, { code: "not_authenticated" }); return; }
    if (!ownerEnabled) { send(403, { code: "owner_disabled" }); return; }
    if (credential === `Bearer ${readKey}` && !requiredApiScopes(request.method!, url.pathname).every((scope) => scope === "read")) {
      send(403, { code: "scope_not_granted" }); return;
    }
    if (input.workspaceId !== undefined) assert.equal(input.workspaceId, workspaceId);
    if (url.pathname === "/api/admin/content/templates" && request.method === "PUT") {
      const id = typeof input.id === "string" ? input.id : "fixture-template";
      const template = { ...input, id };
      templates.set(id, template);
      send(200, template);
    } else if (url.pathname === "/api/admin/content/templates" && request.method === "GET") {
      const id = url.searchParams.get("ids[0]");
      send(200, { templates: [...templates.values()].filter((template) => !id || template.id === id) });
    } else if (url.pathname === "/api/admin/content/templates/render" && request.method === "POST") {
      const contents = input.contents as Record<string, { type: string; value: string }>;
      assert.equal(contents.body!.type, RenderMessageTemplateType.PlainText);
      send(200, { contents: { body: { type: "Ok", value: contents.body!.value } } });
    } else if (url.pathname === "/api/admin/account/logout") {
      keyRevoked = true;
      send(200, { success: true });
    } else if (url.pathname === "/api/admin/account" && request.method === "GET") {
      send(200, { currentKeyId: "fixture-key", member: { name: "Owner" } });
    } else if (url.pathname === "/api/admin/account" && request.method === "PATCH") {
      send(200, { currentKeyId: "fixture-key", member: input });
    } else send(404, { code: "unsupported_fixture_operation" });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, requests,
    disableOwner: () => { ownerEnabled = false; }, enableOwner: () => { ownerEnabled = true; },
    close: async () => { api.closeAllConnections(); await new Promise<void>((resolve) => api.close(() => resolve())); } };
}

function tool(listed: ListToolsResult, method: string, path: string) {
  const found = listed.tools.find((candidate) => candidate.description?.includes(`[${method} ${path};`));
  assert.ok(found, `Missing consumer tool ${method} ${path}`);
  return found;
}

function payload(reply: ToolReply): Json {
  assert.equal(reply.isError, false, reply.content[0]?.text);
  const result = JSON.parse(reply.content[0]!.text) as { status: number; body: string };
  assert.equal(result.status, 200);
  return JSON.parse(result.body) as Json;
}

test("full-control stdio discovers every declared operation and creates, edits, reads and renders a template", async () => {
  const api = await fixture();
  const client = await consumer(api.baseUrl, API_OPERATION_SCOPES.join(","));
  try {
    const declared = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.keys(methods as Record<string, unknown>)
        .filter((method) => ["get", "post", "put", "patch", "delete", "head"].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`));
    const exposed = client.listed.tools.map(({ description }) =>
      description?.match(/\[(GET|POST|PUT|PATCH|DELETE|HEAD) ([^;]+); scopes:/)?.slice(1).join(" "));
    assert.deepEqual(exposed.sort(), declared.sort());
    const upsert = tool(client.listed, "PUT", "/api/admin/content/templates");
    const read = tool(client.listed, "GET", "/api/admin/content/templates");
    const render = tool(client.listed, "POST", "/api/admin/content/templates/render");
    const definition = { type: ChannelType.Email, from: "fixture@example.test", subject: "First", body: "<p>Original</p>" };
    const created = payload(await client.rpc<ToolReply>("tools/call", { name: upsert.name, arguments: { body: { name: "Fixture", definition } } }));
    assert.equal(created.id, "fixture-template");
    assert.equal(created.workspaceId, workspaceId);
    const edited = payload(await client.rpc<ToolReply>("tools/call", { name: upsert.name, arguments: {
      body: { id: created.id, name: "Edited fixture", definition: { ...definition, subject: "Edited", body: "<p>Edited</p>" } },
    } }));
    const fetched = payload(await client.rpc<ToolReply>("tools/call", { name: read.name, arguments: { query: { ids: [created.id] } } }));
    assert.deepEqual(fetched.templates, [edited]);
    const editedDefinition = edited.definition as Json;
    const rendered = payload(await client.rpc<ToolReply>("tools/call", { name: render.name, arguments: {
      body: { channel: ChannelType.Email, contents: { body: { type: RenderMessageTemplateType.PlainText, value: editedDefinition.body } }, userProperties: {} },
    } }));
    assert.deepEqual(rendered.contents, { body: { type: "Ok", value: "<p>Edited</p>" } });
    const before = api.requests.length;
    const invalid = await client.rpc<ToolReply>("tools/call", { name: upsert.name, arguments: { body: { name: 123 } } });
    assert.equal(invalid.isError, true);
    assert.equal(api.requests.length, before, "invalid template input must not reach HTTP");
    const account = tool(client.listed, "GET", "/api/admin/account");
    assert.equal("newsletterId" in (account.inputSchema.properties ?? {}), false);
    const foreign = await client.rpc<ToolReply>("tools/call", { name: account.name, arguments: { newsletterId: "7bb3105f-5dcf-4d49-a2e2-3585b5795261" } });
    assert.equal(foreign.isError, true);
    assert.equal(api.requests.length, before, "account control cannot redirect even to a verified child");
    const profile = payload(await client.rpc<ToolReply>("tools/call", { name: account.name, arguments: {} }));
    assert.equal(profile.currentKeyId, "fixture-key");
    assert.equal("currentSessionId" in profile, false);
    api.disableOwner();
    const disabled = await client.rpc<ToolReply>("tools/call", { name: account.name, arguments: {} });
    assert.equal(disabled.isError, true);
    assert.equal(JSON.parse(disabled.content[0]!.text).status, 403);
    api.enableOwner();
    payload(await client.rpc<ToolReply>("tools/call", { name: tool(client.listed, "POST", "/api/admin/account/logout").name, arguments: {} }));
    const revoked = await client.rpc<ToolReply>("tools/call", { name: account.name, arguments: {} });
    assert.equal(revoked.isError, true);
    assert.equal(JSON.parse(revoked.content[0]!.text).status, 401);
    assert.equal(api.requests.filter(({ path }) => path.endsWith("/logout")).length, 1, "no automatic mutation retry");
  } finally { await client.close(); await api.close(); }
});

test("read-only stdio cannot discover or invoke full-control operations, and local grants cannot expand a server credential", async () => {
  const api = await fixture();
  const reader = await consumer(api.baseUrl, "read", readKey);
  const overconfigured = await consumer(api.baseUrl, API_OPERATION_SCOPES.join(","), readKey);
  try {
    assert.deepEqual(reader.listed.tools.map(({ description }) =>
      description?.match(/\[(GET|POST) ([^;]+); scopes:/)?.slice(1).join(" ")).sort(),
    ["GET /api/admin/content/templates", "POST /api/admin/content/templates/render"]);
    const privileged = tool(overconfigured.listed, "PATCH", "/api/admin/account");
    const before = api.requests.length;
    const hidden = await reader.rpc<ToolReply>("tools/call", { name: privileged.name, arguments: { body: { name: "Forbidden" } } });
    assert.equal(hidden.isError, true);
    assert.equal(api.requests.length, before, "unknown/ungranted tool cannot dispatch HTTP");
    const denied = await overconfigured.rpc<ToolReply>("tools/call", { name: privileged.name, arguments: { body: { name: "Forbidden" } } });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0]!.text).status, 403, "HTTP authorization remains authoritative");
    const operation = [...createOperations(document, API_OPERATION_SCOPES).values()].find(({ path }) => path === "/api/admin/account")!;
    const bridge = new ApiBridge({ baseUrl: new URL(api.baseUrl), workspaceId, apiKey: readKey, scopes: ["read"] });
    await assert.rejects(bridge.invoke(operation, {}), /not granted/);
  } finally { await reader.close(); await overconfigured.close(); await api.close(); }
});

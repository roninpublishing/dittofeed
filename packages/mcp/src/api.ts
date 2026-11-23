import { createHash } from "node:crypto";
import Ajv2020, { ValidateFunction } from "ajv/dist/2020";
import { Tool } from "@modelcontextprotocol/server";
import {
  API_OPERATION_SCOPES,
  ApiOperationScope,
  classifyApiOperation,
  requiredApiScopes,
} from "isomorphic-lib/src/apiOperations";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants/headers";
import qs from "qs";

type ObjectValue = Record<string, unknown>;
export interface ApiDocument extends ObjectValue {
  paths: Record<string, ObjectValue>;
  components?: { schemas?: Record<string, ObjectValue> };
}
export interface BridgeConfig {
  baseUrl: URL;
  workspaceId: string;
  apiKey: string;
  scopes: readonly ApiOperationScope[];
}
interface Parameter extends ObjectValue {
  name: string;
  in: string;
  required?: boolean;
  schema?: ObjectValue;
}
interface Operation {
  method: string;
  path: string;
  tool: Tool;
  validate: ValidateFunction;
  parameters: Parameter[];
  bodyType?: string;
  bodyWorkspace: boolean;
  multipart: boolean;
  newsletterScoped: boolean;
}
export interface ApiResult {
  status: number;
  contentType: string;
  encoding: "utf8" | "base64";
  body: string;
}
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);
const BLOCKED_HEADERS = new Set([
  "authorization", "cookie", "host", "origin", "referer", "connection",
  "content-length", "content-type", "x-workspace-id", "workspace-id",
  WORKSPACE_ID_HEADER, "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
]);

function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as ObjectValue;
}

/** Read operator configuration only; no tool may choose a host, credential, or tenant. */
export function loadBridgeConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  if (!env.DITTOFEED_API_URL || !env.DITTOFEED_WORKSPACE_ID || !env.DITTOFEED_API_KEY) {
    throw new Error("Set DITTOFEED_API_URL, DITTOFEED_WORKSPACE_ID, and DITTOFEED_API_KEY");
  }
  const baseUrl = new URL(env.DITTOFEED_API_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
  if ((baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback)) ||
      baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("API URL must use HTTPS (HTTP is loopback-only), without credentials, query, or fragment");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.DITTOFEED_WORKSPACE_ID)) {
    throw new Error("DITTOFEED_WORKSPACE_ID must be a UUID");
  }
  const scopes = (env.DITTOFEED_MCP_SCOPES ?? "read").split(",").map((value) => value.trim());
  if (scopes.some((value) => !API_OPERATION_SCOPES.includes(value as ApiOperationScope))) {
    throw new Error("DITTOFEED_MCP_SCOPES must be comma-separated read,write,destructive,sensitive");
  }
  return { baseUrl, workspaceId: env.DITTOFEED_WORKSPACE_ID,
    apiKey: env.DITTOFEED_API_KEY, scopes: scopes as ApiOperationScope[] };
}

/** Keep local references, including recursion, while dropping schema IDs that collide across tools. */
function toolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toolSchema);
  if (value === null || typeof value !== "object") return value;
  const result: ObjectValue = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$id" || key === "$schema") continue;
    if (key === "$ref") {
      if (typeof child !== "string" || !child.startsWith("#/components/schemas/")) {
        throw new Error("Only local OpenAPI schema references are supported");
      }
      result[key] = child.replace("#/components/schemas/", "#/$defs/");
    } else result[key] = toolSchema(child);
  }
  return result;
}

/** Include only transitively referenced definitions; listing tools must not repeat the entire API schema. */
function inputContract(schema: ObjectValue, document: ApiDocument): Tool["inputSchema"] {
  const definitions: ObjectValue = {};
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as ObjectValue;
    if (typeof record.$ref === "string") {
      const prefix = "#/components/schemas/";
      if (!record.$ref.startsWith(prefix)) throw new Error("External schema references are forbidden");
      const name = record.$ref.slice(prefix.length).replace(/~1/g, "/").replace(/~0/g, "~");
      if (!Object.prototype.hasOwnProperty.call(definitions, name)) {
        const definition = document.components?.schemas?.[name];
        if (!definition) throw new Error("Missing API schema definition");
        definitions[name] = definition;
        visit(definition);
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return toolSchema({ ...schema, $defs: definitions }) as Tool["inputSchema"];
}

function resolve(value: unknown, document: ApiDocument): ObjectValue {
  const candidate = object(value);
  if (typeof candidate.$ref !== "string") return candidate;
  const parts = candidate.$ref.split("/");
  if (parts[0] !== "#" || parts.length !== 4 || parts[1] !== "components") {
    throw new Error("Unsupported OpenAPI reference");
  }
  const group = object(object(document.components)[parts[2]!]);
  return object(group[parts[3]!.replace(/~1/g, "/").replace(/~0/g, "~")]);
}

/** Workspace selectors inside root unions/intersections still belong to the process, not the model. */
function scopedBodyContract(value: unknown, document: ApiDocument): { schema: ObjectValue; hasWorkspace: boolean } {
  const schema = { ...resolve(value, document) };
  let hasWorkspace = false;
  if (schema.properties) {
    const properties = { ...object(schema.properties) };
    if ("workspaceId" in properties) {
      hasWorkspace = true;
      delete properties.workspaceId;
      schema.properties = properties;
      if (Array.isArray(schema.required)) schema.required = schema.required.filter((name) => name !== "workspaceId");
    }
  }
  for (const combinator of ["allOf", "anyOf", "oneOf"]) {
    if (!Array.isArray(schema[combinator])) continue;
    schema[combinator] = schema[combinator].map((branch) => {
      const scoped = scopedBodyContract(branch, document);
      hasWorkspace ||= scoped.hasWorkspace;
      return scoped.schema;
    });
  }
  return { schema, hasWorkspace };
}

function parameterGroup(parameters: Parameter[], location: string): ObjectValue {
  const selected = parameters.filter((parameter) => parameter.in === location);
  return {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries(selected.map((parameter) => [parameter.name, parameter.schema ?? {}])),
    required: selected.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  };
}

/** Typed, deterministic tools come from the running server, not a drifting list of endpoints. */
export function createOperations(document: ApiDocument, scopes: readonly ApiOperationScope[]): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  const validator = new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
  for (const [path, pathValue] of Object.entries(document.paths)) {
    if (!path.startsWith("/api/admin/") || /[?#\\%]/.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("Catalog contains a route outside the machine API");
    }
    for (const [method, raw] of Object.entries(pathValue)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!requiredApiScopes(method, path).every((scope) => scopes.includes(scope))) continue;
      const operation = object(raw);
      const parameters = [...(pathValue.parameters as unknown[] ?? []), ...(operation.parameters as unknown[] ?? [])]
        .map((value) => resolve(value, document) as Parameter)
        .filter((parameter) => parameter.name !== "workspaceId" && parameter.name !== "externalId" &&
          !(parameter.in === "header" && BLOCKED_HEADERS.has(parameter.name.toLowerCase())));
      if (parameters.some((parameter) => !["path", "query", "header"].includes(parameter.in))) {
        throw new Error(`Unsupported parameter location for ${method} ${path}`);
      }
      const properties: ObjectValue = {};
      const newsletterScoped = !/^\/api\/admin\/publications(?:\/|$)/.test(path);
      if (newsletterScoped) {
        properties.newsletterId = {
          type: "string",
          pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          description: "Optional direct-child newsletter of the configured publisher. The server relationship is verified before this call; cannot select a foreign workspace.",
        };
      }
      const required: string[] = [];
      for (const [location, name] of [["query", "query"], ["path", "path"], ["header", "headers"]]) {
        if (!parameters.some((parameter) => parameter.in === location)) continue;
        const group = parameterGroup(parameters, location!);
        properties[name!] = group;
        if ((group.required as string[]).length) required.push(name!);
      }
      let bodyType: string | undefined;
      let bodyWorkspace = false;
      const multipart = path.endsWith("/upload-csv");
      if (multipart) {
        properties.file = {
          type: "object", additionalProperties: false,
          properties: { filename: { type: "string", minLength: 1 }, contentBase64: { type: "string", maxLength: 6990508 } },
          required: ["filename", "contentBase64"],
        };
        required.push("file");
      } else if (operation.requestBody) {
        const body = resolve(operation.requestBody, document);
        const content = object(body.content);
        bodyType = ["application/json", "text/plain", "application/x-www-form-urlencoded"].find((type) => content[type]);
        if (!bodyType) throw new Error(`Unsupported request media type for ${method} ${path}`);
        const scoped = scopedBodyContract(object(content[bodyType]).schema ?? {}, document);
        bodyWorkspace = scoped.hasWorkspace;
        properties.body = scoped.schema;
        if (body.required) required.push("body");
      }
      const inputSchema = inputContract({ type: "object", properties, required, additionalProperties: false }, document);
      const hash = createHash("sha256").update(`${method} ${path}`).digest("hex").slice(0, 10);
      const slug = `${method}_${path.slice("/api/admin/".length)}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50);
      const name = `${slug}_${hash}`;
      const category = classifyApiOperation(method, path);
      const tool: Tool = {
        name, description: `${String(operation.description ?? operation.summary ?? "Application operation")} [${method.toUpperCase()} ${path}; scopes: ${requiredApiScopes(method, path).join(", ")}]`,
        inputSchema,
        annotations: { readOnlyHint: category === "read", destructiveHint: category !== "read",
          idempotentHint: method === "get" || method === "head", openWorldHint: true },
      };
      operations.set(name, { method: method.toUpperCase(), path, tool,
        validate: validator.compile(inputSchema), parameters, bodyType, bodyWorkspace, multipart, newsletterScoped });
    }
  }
  return operations;
}

/** Bounded reads never silently truncate downloads or successful mutations. */
async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error("API response exceeds 16 MiB; use API pagination or download directly");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, size);
}

export class ApiBridge {
  constructor(readonly config: BridgeConfig, private readonly request: typeof fetch = fetch) {}

  private url(path: string): URL {
    const url = new URL(this.config.baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
    return url;
  }

  private async send(url: URL, init: RequestInit, signal?: AbortSignal, workspaceId = this.config.workspaceId): Promise<ApiResult> {
    const timeout = AbortSignal.timeout(60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.apiKey}`);
    headers.set(WORKSPACE_ID_HEADER, workspaceId);
    const response = await this.request(url, { ...init, headers, signal: combined, redirect: "error" });
    const bytes = await responseBytes(response);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const text = /json|text|csv|xml/.test(contentType);
    return { status: response.status, contentType, encoding: text ? "utf8" : "base64",
      body: bytes.toString(text ? "utf8" : "base64").split(this.config.apiKey).join("[REDACTED]") };
  }

  async discover(signal?: AbortSignal): Promise<ApiDocument> {
    const result = await this.send(this.url("/api/admin/openapi.json"), { method: "GET" }, signal);
    if (result.status !== 200) throw new Error(`API discovery failed (HTTP ${result.status})`);
    const document = object(JSON.parse(result.body));
    object(document.paths);
    return document as ApiDocument;
  }

  async invoke(operation: Operation, input: unknown, signal?: AbortSignal): Promise<ApiResult> {
    if (!requiredApiScopes(operation.method, operation.path).every((scope) => this.config.scopes.includes(scope))) {
      throw new Error("Operation not granted by MCP configuration");
    }
    const args = object(input ?? {});
    if (!operation.validate(args)) {
      throw new Error(`Invalid tool arguments: ${operation.validate.errors?.[0]?.instancePath ?? ""} ${operation.validate.errors?.[0]?.message ?? "schema mismatch"}`);
    }
    let workspaceId = this.config.workspaceId;
    if (args.newsletterId !== undefined) {
      if (!operation.newsletterScoped) throw new Error("Publisher management operations cannot change newsletter scope");
      const requested = String(args.newsletterId);
      const contextUrl = this.url("/api/admin/publications/context");
      contextUrl.searchParams.set("workspaceId", requested);
      const result = await this.send(contextUrl, { method: "GET" }, signal, requested);
      const context = result.status === 200 ? object(object(JSON.parse(result.body)).data) : {};
      if (context.publisherId !== this.config.workspaceId || context.workspaceId !== requested || requested === this.config.workspaceId) {
        throw new Error("Newsletter is not an authorized direct child of the configured publisher");
      }
      workspaceId = requested;
    }
    let path = operation.path;
    const pathArgs = args.path ? object(args.path) : {};
    for (const parameter of operation.parameters.filter((value) => value.in === "path")) {
      const value = String(pathArgs[parameter.name]);
      if (value === "." || value === ".." || /[\/\\]/.test(value)) throw new Error("Invalid path parameter");
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
    }
    if (/[{}]/.test(path)) throw new Error("Missing path parameter");
    const query = args.query ? { ...object(args.query) } : {};
    const body = args.body;
    for (const source of [query, body]) {
      if (source && typeof source === "object" && !Array.isArray(source)) {
        const record = source as ObjectValue;
        if ((record.workspaceId !== undefined && record.workspaceId !== workspaceId) || record.externalId !== undefined) {
          throw new Error("Tool arguments cannot change the configured workspace");
        }
      }
    }
    const url = this.url(path);
    // Header is always present; query schemas can independently require workspaceId.
    query.workspaceId = workspaceId;
    url.search = qs.stringify(query, { arrayFormat: "indices" });
    const headers = new Headers();
    if (args.headers) {
      for (const [name, value] of Object.entries(object(args.headers))) {
        if (BLOCKED_HEADERS.has(name.toLowerCase()) || !operation.parameters.some((parameter) => parameter.in === "header" && parameter.name === name)) {
          throw new Error("Header is not an application parameter");
        }
        headers.set(name, String(value));
      }
    }
    let payload: BodyInit | undefined;
    if (operation.multipart) {
      const file = object(args.file);
      const encoded = String(file.contentBase64);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("File must be canonical base64");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length > MAX_REQUEST_BYTES) throw new Error("Upload exceeds 5 MiB");
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "text/csv" }), String(file.filename));
      payload = form;
    } else if (body !== undefined || operation.bodyWorkspace) {
      const scopedBody = operation.bodyWorkspace ? { ...object(body ?? {}), workspaceId } : body;
      payload = operation.bodyType === "text/plain" ? String(scopedBody) : operation.bodyType === "application/x-www-form-urlencoded" ? qs.stringify(scopedBody) : JSON.stringify(scopedBody);
      headers.set("content-type", operation.bodyType ?? "application/json");
      if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) throw new Error("Request exceeds 5 MiB");
    }
    return this.send(url, { method: operation.method, headers, body: payload }, signal, workspaceId);
  }
}

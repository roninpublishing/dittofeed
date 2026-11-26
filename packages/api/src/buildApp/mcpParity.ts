import { FastifySchema } from "fastify";
import {
  API_OPERATION_SCOPES,
  requiredApiScopes,
} from "isomorphic-lib/src/apiOperations";
import assert from "node:assert/strict";

export interface RegisteredApplicationRoute {
  method: string;
  url: string;
  schema?: FastifySchema;
}

export interface McpParityDocument {
  openapi: string;
  paths?: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

export interface RouteParityEntry {
  operation: string;
  machineOperation?: string;
  protocolReason?: string;
}

// Exact protocol operations, never product namespaces. New routes fail closed,
// including hidden routes and routes added beneath these protocol prefixes.
const PROTOCOL_OPERATIONS: Readonly<Record<string, string>> = {
  "GET /api": "Internal liveness/version probe; no application control.",
  "GET /api/admin/openapi.json": "Authenticated discovery transport; exposed as the MCP contract resource, not recursively as a tool.",
  "GET /api/public/auth/google/status": "Authentication-provider readiness and browser login URL.",
  "GET /api/public/auth/google/start": "Interactive Google consent with browser-bound state, nonce and PKCE.",
  "POST /api/public/auth/google/start": "Interactive Google invitation consent with browser-bound state, nonce and PKCE.",
  "POST /api/public/auth/google/invitation": "Invitation-token preview used before authentication/consent; account invitation administration has machine equivalents.",
  "GET /api/public/auth/google/callback": "Google-signed identity callback bound to one browser consent flow.",
  "POST /api/public/single-tenant/login": "Browser password authentication and cookie issuance; not machine impersonation.",
  "GET /api/public/single-tenant/signout": "Browser authentication-cookie removal; machine logout revokes the actual invoking key.",
  "PUT /api/public/subscription-management/user-subscriptions": "Recipient subscription protocol authenticated by a signed subscriber hash.",
  "GET /api/public/subscription-management/page": "Recipient HTML protocol authenticated by a signed subscriber hash.",
  "POST /api/public/subscription-management/page": "Recipient form protocol authenticated by a signed subscriber hash.",
  "GET /api/public/view-in-browser": "Recipient archive protocol authenticated by a signed message hash.",
  "POST /api/public/email/open/batch": "Raw tracking evidence protocol authenticated by a signed relay envelope.",
  "POST /api/public/email/open/development-batch": "Development tracking evidence protocol authenticated by a signed relay envelope.",
  "GET /internal-api/debug/ok": "Internal telemetry probe, not application state/control.",
  "GET /internal-api/debug/boom": "Internal telemetry error probe, not application state/control.",
  "OPTIONS *": "Framework CORS preflight transport; no application operation.",
  "GET /documentation": "Generated OpenAPI viewer redirect, not application control.",
  "GET /documentation/uiConfig": "Generated OpenAPI viewer configuration transport.",
  "GET /documentation/initOAuth": "Generated OpenAPI viewer authentication configuration transport.",
  "GET /documentation/json": "Generated OpenAPI document transport; MCP uses authenticated admin discovery.",
  "GET /documentation/yaml": "Generated OpenAPI document transport; MCP uses authenticated admin discovery.",
  "GET /documentation/static/*": "Generated OpenAPI viewer static asset transport.",
  "GET /documentation/*": "Generated OpenAPI viewer reference/static-file transport.",
};

const PROVIDER_PROTOCOLS: Readonly<Record<string, string>> = {
  sendgrid: "SendGrid signed webhook event protocol.",
  "sendgrid/connections/{connectionId}": "SendGrid connection-specific signed webhook event protocol.",
  "amazon-ses": "Amazon SNS signed notification/subscription handshake protocol.",
  telnyx: "Telnyx signed webhook event protocol.",
};

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function normalizePath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}").replace(/\/+$/, "") || "/";
}

function protocolReason(operation: string): string | undefined {
  const provider = /^POST \/api\/(?:public\/)?webhooks\/(.+)$/.exec(operation);
  if (provider) {
    const name = provider[1]!;
    return Object.hasOwn(PROVIDER_PROTOCOLS, name) ? PROVIDER_PROTOCOLS[name] : undefined;
  }
  return Object.hasOwn(PROTOCOL_OPERATIONS, operation) ? PROTOCOL_OPERATIONS[operation] : undefined;
}

function machinePath(path: string): string | undefined {
  if (path.startsWith("/api/admin/")) return path;
  if (path === "/api/public/single-tenant/workspace") return "/api/admin/account/workspace";
  if (path.startsWith("/api/public/apps/")) return path.replace("/api/public/apps/", "/api/admin/apps/");
  if (path.startsWith("/api/") && !path.startsWith("/api/public/")) return path.replace("/api/", "/api/admin/");
  return undefined;
}

const OPERATOR_FIELDS: Readonly<Record<string, true>> = {
  workspaceId: true,
  externalId: true,
};
const CREDENTIAL_HEADERS: Readonly<Record<string, true>> = {
  authorization: true,
  cookie: true,
  "df-workspace-id": true,
};

// Tenant selectors and credentials belong to the operator, not tool arguments.
// Keep every business field, validation constraint, required bit and union branch.
function consumerSchema(value: unknown, root = true, headers = false): unknown {
  if (Array.isArray(value)) return value.map((child) => consumerSchema(child, false));
  const schema = record(value);
  if (!schema) return value;
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(schema)) {
    if (["$id", "$schema", "description", "title", "examples"].includes(key)) continue;
    if (root && key === "properties") {
      result.properties = Object.fromEntries(Object.entries(record(child) ?? {})
        .filter(([name]) => !Object.hasOwn(OPERATOR_FIELDS, name) && !(headers && Object.hasOwn(CREDENTIAL_HEADERS, name.toLowerCase())))
        .map(([name, property]) => [name, consumerSchema(property, false)]));
    } else if (root && key === "required" && Array.isArray(child)) {
      result.required = child.filter((name) => !Object.hasOwn(OPERATOR_FIELDS, String(name)) && !(headers && Object.hasOwn(CREDENTIAL_HEADERS, String(name).toLowerCase())));
    } else if (root && ["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(child)) {
      result[key] = child.map((branch) => consumerSchema(branch, true, headers));
    } else result[key] = consumerSchema(child, false);
  }
  if (root && result.properties && Object.keys(record(result.properties) ?? {}).length === 0) {
    delete result.additionalProperties;
  }
  return result;
}

function typedSchema(value: unknown): boolean {
  const schema = record(value);
  return !!schema && ["type", "$ref", "anyOf", "oneOf", "allOf", "enum", "const"].some((key) => key in schema);
}

/** Compare real Fastify registrations to authenticated discovery, not documentation inventories. */
export function checkMcpRouteParity(
  routes: readonly RegisteredApplicationRoute[],
  document: McpParityDocument,
): RouteParityEntry[] {
  assert.ok("openapi" in document, "MCP parity requires OpenAPI 3");
  const registered = new Map(routes.map((route) => [
    `${route.method.toUpperCase()} ${normalizePath(route.url)}`,
    route,
  ]));
  const discovered = new Map<string, JsonObject>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "trace"]) {
      const operation = record(record(item)?.[method]);
      if (operation) discovered.set(`${method.toUpperCase()} ${normalizePath(path)}`, operation);
    }
  }
  const inventory: RouteParityEntry[] = [];
  for (const [operation, route] of registered) {
    const method = route.method.toUpperCase();
    const path = normalizePath(route.url);
    // Fastify synthesizes HEAD from GET; it adds no separate business capability.
    if (method === "HEAD" && registered.has(`GET ${path}`)) continue;
    const reason = protocolReason(operation);
    if (reason) {
      inventory.push({ operation, protocolReason: reason });
      continue;
    }
    const target = machinePath(path);
    assert.ok(target, `MCP parity: ${operation} has no machine equivalent or specific protocol reason`);
    const targetOperation = `${method} ${target}`;
    const machine = registered.get(targetOperation);
    assert.ok(machine, `MCP parity: ${operation} is browser-only; register ${targetOperation}`);
    assert.ok(route.schema && machine.schema, `MCP parity: ${operation} needs explicit usable schemas`);
    const exposed = discovered.get(targetOperation);
    assert.ok(exposed, `MCP parity: ${targetOperation} is registered but hidden from machine discovery`);
    assert.ok(Array.isArray(exposed.security) && exposed.security.some((entry: unknown) =>
      Object.hasOwn(record(entry) ?? {}, "bearerAuth")), `MCP parity: ${targetOperation} lacks bearer authentication`);
    for (const location of ["body", "querystring", "params", "headers"] as const) {
      const sourceSchema: unknown = route.schema[location];
      if (sourceSchema !== undefined) {
        assert.ok(typedSchema(sourceSchema), `MCP parity: ${operation} has an untyped ${location}`);
        assert.ok(typedSchema(machine.schema[location]), `MCP parity: ${targetOperation} lost its ${location} schema`);
        assert.deepEqual(consumerSchema(machine.schema[location], true, location === "headers"), consumerSchema(sourceSchema, true, location === "headers"),
          `MCP parity: ${targetOperation} changes browser ${location} business inputs`);
      }
    }
    const parameters = Array.isArray(exposed.parameters) ? exposed.parameters : [];
    for (const [location, schemaName] of [["query", "querystring"], ["path", "params"], ["header", "headers"]] as const) {
      const schema = record(machine.schema[schemaName]);
      for (const [name, property] of Object.entries(record(schema?.properties) ?? {})) {
        if (Object.hasOwn(OPERATOR_FIELDS, name) || (location === "header" && Object.hasOwn(CREDENTIAL_HEADERS, name.toLowerCase()))) continue;
        const parameter = parameters.map(record).find((candidate) => candidate?.in === location && candidate.name === name);
        assert.ok(parameter && typedSchema(parameter.schema) && typedSchema(property),
          `MCP parity: ${targetOperation} lost typed ${location} parameter ${name}`);
        if (Array.isArray(schema?.required) && schema.required.includes(name)) {
          assert.equal(parameter.required, true, `MCP parity: ${targetOperation} weakened required parameter ${name}`);
        }
      }
    }
    if (machine.schema.body !== undefined || machine.schema["x-machine-request-body"] !== undefined) {
      const content = record(record(exposed.requestBody)?.content);
      assert.ok(content && Object.values(content).some((media) => typedSchema(record(media)?.schema)),
        `MCP parity: ${targetOperation} lost its typed request body in discovery`);
    }
    const responses = record(machine.schema.response);
    assert.ok(responses && Object.entries(responses).some(([code, schema]) => /^2(?:\d\d|xx)$/i.test(code) && typedSchema(schema)),
      `MCP parity: ${targetOperation} needs a typed success response`);
    for (const [code, schema] of Object.entries(responses ?? {})) {
      assert.ok(typedSchema(schema), `MCP parity: ${targetOperation} has an untyped response ${code}`);
      const responseCode = /^[1-5]xx$/i.test(code) ? code.toUpperCase() : code;
      const content = record(record(record(exposed.responses)?.[responseCode])?.content);
      // Empty responses (204/null) deliberately have no content in OpenAPI.
      if (code !== "204" && record(schema)?.type !== "null") {
        assert.ok(content && Object.values(content).some((media) => typedSchema(record(media)?.schema)),
          `MCP parity: ${targetOperation} lost response ${code} in discovery`);
      }
    }
    const scopes = requiredApiScopes(method, target);
    assert.ok(scopes.length && scopes.every((scope) => API_OPERATION_SCOPES.includes(scope)),
      `MCP parity: ${targetOperation} has no enforceable scopes`);
    if (/^\/api\/admin\/(?:account|admin-keys|permissions)(?:\/|$)/.test(target)) {
      assert.deepEqual([...scopes].sort(), [...API_OPERATION_SCOPES].sort(),
        `MCP parity: ${targetOperation} must require every independent grant`);
    }
    inventory.push({ operation, machineOperation: targetOperation });
  }
  for (const operation of discovered.keys()) {
    assert.ok(registered.has(operation), `MCP parity: discovered operation ${operation} has no actual handler`);
  }
  return inventory;
}

import { Type } from "@sinclair/typebox";
import * as configModule from "backend-lib/src/config";
import fastify from "fastify";
import {
  API_OPERATION_SCOPES,
  ApiOperationScope,
  requiredApiScopes,
} from "isomorphic-lib/src/apiOperations";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { OpenAPIV3_1 } from "openapi-types";

import { buildFastifyAppOpts, registerApp } from "../buildApp";
import { adminOpenApi } from "../controllers/operationsController";
import { checkMcpRouteParity, McpParityDocument, RegisteredApplicationRoute } from "./mcpParity";

type DiscoveredTool = { method: string; path: string; tool: { inputSchema: object }; validate: unknown };
interface BridgeModule {
  createOperations(document: McpParityDocument, scopes: readonly ApiOperationScope[]): Map<string, DiscoveredTool>;
}

// Exercise the compiled, shipped consumer, not a second imitation of its generator.
// The mandatory check script builds this package before invoking the gate.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bridge = require(join(process.cwd(), "packages/mcp/dist/src/api")) as BridgeModule;

const originalConfig = configModule.default;
const input = Type.Object({ value: Type.String() }, { additionalProperties: false });
const success = Type.Object({ success: Type.Boolean() });

async function application(authMode: "google" | "single-tenant" | "anonymous" | "multi-tenant") {
  const base = originalConfig();
  const settings = jest.spyOn(configModule, "default").mockReturnValue({
    ...base,
    authMode,
    secretKey: Buffer.alloc(32, 7).toString("base64"),
    dashboardUrl: "http://localhost:3000",
  });
  const app = fastify(buildFastifyAppOpts());
  const routes: RegisteredApplicationRoute[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      // Retain the route object: subsequent production onRoute hooks attach security.
      routes.push({ method, url: route.url, get schema() { return route.schema; } });
    }
  });
  try {
    await registerApp(app);
    await app.ready();
    return { app, routes, settings, document: adminOpenApi(app.swagger()) };
  } catch (error) {
    await app.close();
    settings.mockRestore();
    throw error;
  }
}

function operationSet(document: McpParityDocument): Set<string> {
  const operations = new Set<string>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const) {
      if (item && typeof item === "object" && Reflect.get(item, method)) operations.add(`${method.toUpperCase()} ${path.replace(/\/+$/, "")}`);
    }
  }
  return operations;
}

function toolSet(tools: Map<string, DiscoveredTool>): Set<string> {
  return new Set([...tools.values()].map(({ method, path }) => `${method} ${path.replace(/\/+$/, "")}`));
}

describe("mandatory registered application/MCP parity", () => {
  beforeAll(() => {
    expect(process.env.MCP_PARITY_ISOLATED).toBe("true");
    expect(new URL(process.env.DATABASE_URL!).host).toBe("127.0.0.1:1");
    expect(new URL(process.env.CLICKHOUSE_HOST!).host).toBe("127.0.0.1:1");
    expect(process.env.TEMPORAL_ADDRESS).toBe("127.0.0.1:1");
  });

  afterEach(() => {
    // Also fail if a newly registered controller catches an attempted I/O error.
    expect(Reflect.get(globalThis, Symbol.for("dittofeed.mcpParity.deniedIo"))).toEqual([]);
    expect(globalThis.POOL).toBeNull();
    expect(globalThis.DB).toBeNull();
  });

  it.each(["google", "single-tenant", "anonymous", "multi-tenant"] as const)(
    "exposes every actual typed product/control registration in %s mode",
    async (mode) => {
      const { app, routes, settings, document } = await application(mode);
      try {
        const inventory = checkMcpRouteParity(routes, document);
        expect(inventory.some(({ operation }) => operation === "GET /api/account")).toBe(true);
        expect(inventory.some(({ operation }) => operation === "GET /api/admin/account")).toBe(true);
        const tools = bridge.createOperations(document, API_OPERATION_SCOPES);
        expect(toolSet(tools)).toEqual(operationSet(document));
        for (const resource of ["events", "deliveries", "segments"]) {
          const exported = document.paths[`/api/admin/${resource}/download`]?.get?.responses?.["200"];
          expect(exported).toMatchObject({
            content: {
              "text/csv": { schema: { type: "string", format: "binary" } },
            },
          });
          expect(exported).not.toHaveProperty(["content", "application/json"]);
        }
        for (const operation of tools.values()) {
          expect(typeof operation.validate).toBe("function");
          expect(operation.tool.inputSchema).toHaveProperty("type", "object");
        }
        if (mode === "google") {
          // Independent grants: every strict subset is checked, including three-of-four.
          for (let mask = 0; mask < 2 ** API_OPERATION_SCOPES.length - 1; mask += 1) {
            const scopes = API_OPERATION_SCOPES.filter((_scope, bit) => mask & (1 << bit));
            const actual = toolSet(bridge.createOperations(document, scopes));
            const expected = new Set([...tools.values()]
              .filter(({ method, path }) => requiredApiScopes(method, path).every((scope) => scopes.includes(scope)))
              .map(({ method, path }) => `${method} ${path.replace(/\/+$/, "")}`));
            expect(actual).toEqual(expected);
            expect([...actual].some((operation) => / \/api\/admin\/(?:account|admin-keys|permissions)(?:\/|$)/.test(operation))).toBe(false);
          }
        }
      } finally {
        await app.close();
        settings.mockRestore();
      }
    },
    120_000,
  );

  it("fails new browser-only, hidden, untyped and schema-truncated business controls", async () => {
    const app = fastify();
    const routes: RegisteredApplicationRoute[] = [];
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        routes.push({ method, url: route.url, schema: route.schema });
      }
    });
    const schema = { body: input, response: { 200: success } };
    app.post("/api/new-product-control", { schema }, () => ({ success: true }));
    await app.ready();
    try {
      const empty: OpenAPIV3_1.Document = { openapi: "3.1.0", info: { title: "gate", version: "1" }, paths: {} };
      expect(() => checkMcpRouteParity(routes, empty)).toThrow("browser-only");
      const machine: RegisteredApplicationRoute = { method: "POST", url: "/api/admin/new-product-control", schema };
      expect(() => checkMcpRouteParity([...routes, machine], empty)).toThrow("hidden from machine discovery");
      const exposed: OpenAPIV3_1.Document = {
        ...empty,
        paths: { [machine.url]: { post: {
          security: [{ bearerAuth: [] }],
          requestBody: { content: { "application/json": { schema: input } } },
          responses: { 200: { description: "ok", content: { "application/json": { schema: success } } } },
        } } },
      };
      expect(() => checkMcpRouteParity([...routes, machine], exposed)).not.toThrow();
      expect(() => checkMcpRouteParity([...routes, { ...machine, schema: { ...schema, body: {} } }], exposed)).toThrow("lost its body schema");
      expect(() => checkMcpRouteParity([...routes, { ...machine, schema: { body: input } }], exposed)).toThrow("needs a typed success response");
      const withoutBody = JSON.parse(JSON.stringify(exposed)) as typeof exposed;
      delete withoutBody.paths![machine.url]!.post!.requestBody;
      expect(() => checkMcpRouteParity([...routes, machine], withoutBody)).toThrow("lost its typed request body");
      const withoutAuthentication = JSON.parse(JSON.stringify(exposed)) as typeof exposed;
      delete withoutAuthentication.paths![machine.url]!.post!.security;
      expect(() => checkMcpRouteParity([...routes, machine], withoutAuthentication)).toThrow("lacks bearer authentication");
      const hiddenProtocolBusiness = { ...machine, url: "/api/public/auth/google/new-business-control" };
      expect(() => checkMcpRouteParity([hiddenProtocolBusiness], empty)).toThrow("no machine equivalent or specific protocol reason");
    } finally {
      await app.close();
    }
  });

  it("rejects new Next API handlers instead of letting a second browser-only API escape inventory", () => {
    const root = join(process.cwd(), "packages/dashboard/src");
    const handlers = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
      .filter((path) => /^pages\/api\/.+\.page\.[jt]sx?$/.test(path) || /^app\/(?:.+\/)?route\.[jt]s$/.test(path));
    // Existing Next handlers are only health transport and OAuth browser-CSRF consent.
    // All product handlers must be registered with the application router above.
    expect(handlers.sort()).toEqual(["pages/api/index.page.ts", "pages/api/oauth/set-csrf-cookie.page.ts"]);
  });
});

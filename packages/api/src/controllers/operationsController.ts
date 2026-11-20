import { Type } from "@sinclair/typebox";
import { FastifyInstance } from "fastify";
import { classifyApiOperation, requiredApiScopes } from "isomorphic-lib/src/apiOperations";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";

declare module "fastify" {
  interface FastifySchema {
    // Streaming multipart bodies cannot use Fastify's ordinary JSON validation.
    "x-machine-request-body"?: OpenAPIV3_1.RequestBodyObject;
  }
}

// Swagger supports both OpenAPI 3.0 and 3.1; preserve their schema dialects.
type MachineOperation = Omit<OpenAPIV3.OperationObject, "parameters" | "requestBody" | "responses" | "callbacks"> & {
  parameters?: OpenAPI.Parameter[];
  requestBody?: OpenAPIV3.OperationObject["requestBody"] | OpenAPIV3_1.OperationObject["requestBody"];
  responses?: OpenAPIV3.OperationObject["responses"] | OpenAPIV3_1.OperationObject["responses"];
  callbacks?: OpenAPIV3.OperationObject["callbacks"] | OpenAPIV3_1.OperationObject["callbacks"];
};
type MachinePathItem = Partial<Record<typeof METHODS[number], MachineOperation>> & {
  parameters?: OpenAPI.Parameter[];
};

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

/** Project registered routes, not a second maintained operation allowlist. */
export function adminOpenApi(document: OpenAPI.Document) {
  if (!("openapi" in document)) {
    throw new Error("The machine API requires OpenAPI 3.");
  }
  const paths: Record<string, MachinePathItem> = {};
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!path.startsWith("/api/admin/") || path === "/api/admin/openapi.json" || !item) {
      continue;
    }
    const projected: MachinePathItem = {};
    // Preserve path-level parameter definitions, but never externally supplied refs.
    if ("$ref" in item) throw new Error(`Unsupported referenced admin path: ${path}`);
    if (item.parameters) projected.parameters = item.parameters;
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      // Swagger preserves the vendor extension authored beside stream handlers.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const streamBody = (operation as OpenAPIV3_1.OperationObject & { "x-machine-request-body"?: OpenAPIV3_1.RequestBodyObject })["x-machine-request-body"];
      projected[method] = {
        ...operation,
        security: [{ bearerAuth: [] }],
        ...(streamBody ? { requestBody: streamBody } : {}),
        parameters: [
          ...(operation.parameters ?? []).filter((parameter) =>
            "$ref" in parameter || !(parameter.in === "header" && parameter.name.toLowerCase() === WORKSPACE_ID_HEADER.toLowerCase())),
          {
            in: "header",
            name: WORKSPACE_ID_HEADER,
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Workspace authorized by the bearer key. Must agree with any workspaceId in the request.",
          },
        ],
      };
    }
    if (METHODS.some((method) => projected[method])) paths[path] = projected;
  }
  return {
    ...document,
    paths,
    security: [{ bearerAuth: [] }],
    components: {
      ...document.components,
      securitySchemes: {
        ...document.components?.securitySchemes,
        bearerAuth: { type: "http", scheme: "bearer", description: "Workspace admin API key with the required operation scopes." },
      },
    },
  };
}

/** Authenticated discovery for API clients and the local MCP bridge. */
export default async function operationsController(fastify: FastifyInstance) {
  fastify.get("/openapi.json", {
    schema: {
      description: "Live registered machine operations and their request/response schemas. Excludes this discovery endpoint itself.",
      tags: ["Operations"],
    },
  }, async () => adminOpenApi(fastify.swagger()));

  fastify.get("/operations", {
    schema: {
      description: "Coverage manifest derived from the live authenticated OpenAPI document. Scopes are enforced by the server.",
      tags: ["Operations"],
      response: {
        200: Type.Object({
          operations: Type.Array(Type.Object({
            method: Type.String(),
            path: Type.String(),
            scope: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("destructive"), Type.Literal("sensitive")]),
            requiredScopes: Type.Array(Type.String()),
            description: Type.String(),
          })),
        }),
      },
    },
  }, async () => {
    const document = adminOpenApi(fastify.swagger());
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      METHODS.flatMap((method) => {
        const operation = item?.[method];
        return operation ? [{ method: method.toUpperCase(), path, scope: classifyApiOperation(method, path), requiredScopes: [...requiredApiScopes(method, path)], description: operation.description ?? operation.summary ?? "" }] : [];
      }));
    return { operations };
  });
}

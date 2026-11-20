import swagger from "@fastify/swagger";
import fastify from "fastify";
import { WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";

import operationsController, { adminOpenApi } from "./operationsController";

// Real Fastify/Swagger registration without databases, cookies, or auth bypasses.
// The production router places this plugin under adminAuth.
describe("machine operation discovery", () => {
  it("projects only registered admin operations and preserves reusable schemas", async () => {
    const app = fastify();
    await app.register(swagger, { openapi: { info: { title: "test", version: "1" }, components: { schemas: { Contact: { type: "object", properties: { id: { type: "string" } } } } } } });
    app.addSchema({ $id: "Contact", type: "object", properties: { id: { type: "string" } } });
    app.get("/api/public/auth/start", async () => "browser only");
    app.get("/internal-api/debug/ok", async () => "private");
    app.post("/api/admin/users", { schema: { body: { type: "object", properties: { workspaceId: { type: "string" } } }, response: { 200: { $ref: "Contact#" } } } }, async () => ({ id: "contact" }));
    await app.register(operationsController, { prefix: "/api/admin" });
    try {
      await app.ready();
      const before = JSON.stringify(app.swagger());
      const response = await app.inject("/api/admin/openapi.json");
      expect(response.statusCode).toBe(200);
      const document = response.json();
      expect(Object.keys(document.paths).sort()).toEqual(["/api/admin/operations", "/api/admin/users"]);
      expect(document.components.schemas.Contact).toBeDefined();
      expect(document.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
      expect(document.paths["/api/admin/users"].post.security).toEqual([{ bearerAuth: [] }]);
      expect(document.paths["/api/admin/users"].post.parameters).toContainEqual(expect.objectContaining({ in: "header", name: WORKSPACE_ID_HEADER, required: true }));
      expect(JSON.stringify(app.swagger())).toBe(before);
      const manifest = await app.inject("/api/admin/operations");
      expect(manifest.json().operations).toContainEqual(expect.objectContaining({ method: "POST", path: "/api/admin/users", scope: "read", requiredScopes: ["read"] }));
    } finally {
      await app.close();
    }
  });

  it("fails closed on unsupported Swagger versions", () => {
    expect(() => adminOpenApi({ swagger: "2.0", info: { title: "test", version: "1" }, paths: {} })).toThrow("requires OpenAPI 3");
  });

  it("projects streaming multipart metadata without treating streams as JSON", () => {
    const body = { required: true, content: { "multipart/form-data": { schema: { type: "object" as const, properties: { file: { type: "string" as const, format: "binary" } } } } } };
    const operation = { responses: { 200: { description: "Uploaded" } }, "x-machine-request-body": body };
    const document = adminOpenApi({ openapi: "3.1.0", info: { title: "test", version: "1" }, paths: { "/api/admin/segments/upload-csv": { post: operation } } });
    expect(document.paths["/api/admin/segments/upload-csv"]?.post?.requestBody).toEqual(body);
  });
});

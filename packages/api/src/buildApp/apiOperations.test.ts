import {
  API_OPERATION_SCOPES,
  classifyApiOperation,
  requiredApiScopes,
} from "isomorphic-lib/src/apiOperations";

describe("machine API operation policy", () => {
  it.each([
    "/users",
    "/users/count",
    "/deliveries",
    "/deliveries/clicks",
    "/deliveries/opens",
    "/content/templates/render",
  ])("recognizes read-only POST %s independently of method", (path) => {
    expect(classifyApiOperation("POST", `/api/admin${path}/?workspaceId=ignored`)).toBe("read");
    expect(requiredApiScopes("POST", `/api/admin${path}`)).toEqual(["read"]);
  });

  it.each([
    ["POST", "/apps/identify"],
    ["POST", "/apps/batch"],
    ["POST", "/content/templates/test"],
    ["POST", "/content/templates/batch-send"],
    ["PUT", "/journeys"],
    ["POST", "/resources/duplicate"],
    ["POST", "/unknown-query"],
  ])("does not reinterpret %s %s as a read", (method, path) => {
    expect(classifyApiOperation(method, `/api/admin${path}`)).toBe("write");
    expect(requiredApiScopes(method, `/api/admin${path}`)).toEqual(["write"]);
  });

  it.each([
    ["DELETE", "/users"],
    ["DELETE", "/journeys/v2"],
    ["POST", "/segments/manual-segment/clear"],
    ["PUT", "/content/templates/reset"],
    ["PUT", "/broadcasts/archive"],
    ["PUT", "/broadcasts/cancel"],
  ])("requires an explicit destructive grant for %s %s", (method, path) => {
    expect(classifyApiOperation(method, `/api/admin${path}`)).toBe("destructive");
    expect(requiredApiScopes(method, `/api/admin${path}`)).toEqual(["destructive"]);
  });

  it.each(["admin-keys", "secrets", "settings", "integrations", "permissions", "oauth"])(
    "requires full independent authority for %s administration", (root) => {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        expect(classifyApiOperation(method, `/api/admin/${root}`)).toBe("sensitive");
        expect(requiredApiScopes(method, `/api/admin/${root}`)).toEqual(API_OPERATION_SCOPES);
      }
    },
  );

  it("distinguishes raw evidence from public observations without granting unrelated authority", () => {
    expect(requiredApiScopes("POST", "/api/admin/deliveries/opens/evidence")).toEqual(["sensitive"]);
    expect(requiredApiScopes("POST", "/api/admin/deliveries/opens")).toEqual(["read"]);
    expect(requiredApiScopes("GET", "/api/admin/openapi.json")).toEqual(["read"]);
    expect(requiredApiScopes("GET", "/api/admin/operations")).toEqual(["read"]);
    expect(requiredApiScopes("GET", "/api/settings-not-credentials")).toEqual(["read"]);
  });
});

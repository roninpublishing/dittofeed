import type { AdminApiKeyScope } from "./types";

export type ApiOperationScope = AdminApiKeyScope;

export const API_OPERATION_SCOPES: readonly ApiOperationScope[] = [
  "read",
  "write",
  "destructive",
  "sensitive",
];

function normalizeApiPath(path: string): string {
  return (
    path.split("?")[0]
      ?.replace(/^\/api\/admin(?=\/|$)/, "/api")
      .replace(/\/+$/, "") || "/"
  );
}

/** Credential administration can issue credentials or change authorization. */
export function isApiCredentialAdministration(path: string): boolean {
  return /^\/api\/(admin-keys|secrets|settings|integrations|permissions|oauth)(?:\/|$)/.test(
    normalizeApiPath(path),
  );
}

const readPostPaths: Record<string, true | undefined> = {
  "/api/users": true,
  "/api/users/count": true,
  "/api/deliveries": true,
  "/api/deliveries/clicks": true,
  "/api/deliveries/opens": true,
  "/api/content/templates/render": true,
};

/**
 * Classify authenticated application operations, not HTTP methods alone.
 * Grants are independent: write does not imply read, destructive, or sensitive.
 * Unknown mutations require write; credential administration is always sensitive.
 */
export function classifyApiOperation(
  method: string,
  path: string,
): ApiOperationScope {
  const normalizedPath = normalizeApiPath(path);
  const normalizedMethod = method.toUpperCase();
  if (
    isApiCredentialAdministration(normalizedPath) ||
    normalizedPath === "/api/deliveries/opens/evidence"
  ) {
    return "sensitive";
  }
  if (
    normalizedMethod === "DELETE" ||
    normalizedPath === "/api/segments/manual-segment/clear" ||
    normalizedPath === "/api/content/templates/reset" ||
    normalizedPath === "/api/broadcasts/archive" ||
    normalizedPath === "/api/broadcasts/cancel"
  ) {
    return "destructive";
  }
  if (
    normalizedMethod === "GET" ||
    normalizedMethod === "HEAD" ||
    normalizedMethod === "OPTIONS" ||
    (normalizedMethod === "POST" && readPostPaths[normalizedPath] === true)
  ) {
    return "read";
  }
  return "write";
}

/**
 * Return every independent grant required by the server and machine clients.
 * Administrating credentials requires full authority: a partial grant must not
 * be exchanged for a new key, write key, or altered permissions.
 */
export function requiredApiScopes(
  method: string,
  path: string,
): readonly ApiOperationScope[] {
  return isApiCredentialAdministration(path)
    ? API_OPERATION_SCOPES
    : [classifyApiOperation(method, path)];
}

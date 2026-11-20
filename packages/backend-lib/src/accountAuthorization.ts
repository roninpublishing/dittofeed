import { Role, RoleEnum } from "isomorphic-lib/src/types";

import { AccountError } from "./accounts";
import config from "./config";

const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const readPostPaths = new Set([
  "/api/users",
  "/api/users/count",
  "/api/deliveries",
  "/api/deliveries/clicks",
  "/api/deliveries/opens",
]);
const dashboardReadPaths = new Set([
  "/",
  "/home",
  "/analysis",
  "/deliveries",
  "/journeys",
  "/templates",
  "/broadcasts",
  "/users",
  "/segments",
  "/user-properties",
  "/subscription-groups",
  "/events",
  "/account",
]);

export function requireGoogleOrigin(
  origin: string | undefined,
  method: string,
): void {
  const expected = new URL(config().dashboardUrl).origin;
  if (
    origin !== expected &&
    (!readMethods.has(method) || origin !== undefined)
  ) {
    throw new AccountError("forbidden", 403);
  }
}

export function requiredGoogleApiRole(method: string, url: string): Role {
  const normalized = (url.split("?")[0] ?? "")
    .replace(/^\/dashboard(?=\/|$)/, "")
    .replace(/\/$/, "");
  const path = normalized.length === 0 ? "/" : normalized;
  if (path.startsWith("/api/admin-keys")) return RoleEnum.Admin;
  if (
    path.startsWith("/api/settings") ||
    path.startsWith("/api/secrets") ||
    path.startsWith("/api/integrations") ||
    path.startsWith("/api/permissions") ||
    path.startsWith("/api/oauth") ||
    path === "/api/deliveries/opens/evidence"
  )
    return RoleEnum.WorkspaceManager;
  if (readMethods.has(method) || (method === "POST" && readPostPaths.has(path)))
    return RoleEnum.Viewer;
  return RoleEnum.Author;
}

export function requiredGoogleDashboardRole(url: string): Role {
  const rawPath = url.split("?")[0] ?? "";
  const normalized = rawPath
    .replace(/^\/dashboard(?=\/|$)/, "")
    .replace(/\/$/, "");
  const path = normalized.length === 0 ? "/" : normalized;
  if (
    path === "/settings" ||
    path.startsWith("/settings/") ||
    path.startsWith("/oauth")
  )
    return RoleEnum.WorkspaceManager;
  if (dashboardReadPaths.has(path) || /^\/users\/[^/]+$/.test(path))
    return RoleEnum.Viewer;
  // Editor GET loaders can persist drafts; a Viewer must not enter them.
  return RoleEnum.Author;
}

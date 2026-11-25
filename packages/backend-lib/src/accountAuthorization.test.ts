import {
  containsAccountControlCharacters,
  googleAuthSensitiveUrl,
} from "isomorphic-lib/src/accounts";
import { RoleEnum } from "isomorphic-lib/src/types";

import {
  requiredGoogleApiRole,
  requiredGoogleDashboardRole,
  requireGoogleOrigin,
} from "./accountAuthorization";
import config, { DEFAULT_BACKEND_CONFIG } from "./config";
import { googleSessionPluginOptions } from "./googleSessions";

describe("Google browser authorization boundaries", () => {
  it.each([
    "/api/publications/tracking-domains",
    "/api/publications/tracking-domains/provision",
    "/api/publications/tracking-domains/verify",
  ])(
    "restricts hostname configuration and activation to managers: %s",
    (path) => {
      expect(requiredGoogleApiRole("PUT", path)).toBe(
        RoleEnum.WorkspaceManager,
      );
      expect(requiredGoogleApiRole("POST", path)).toBe(
        RoleEnum.WorkspaceManager,
      );
      expect(requiredGoogleApiRole("GET", path)).toBe(RoleEnum.Viewer);
    },
  );
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "rejects missing or foreign Origin on %s",
    (method) => {
      expect(() => requireGoogleOrigin(undefined, method)).toThrow("forbidden");
      expect(() =>
        requireGoogleOrigin("https://untrusted.example", method),
      ).toThrow("forbidden");
      requireGoogleOrigin(new URL(config().dashboardUrl).origin, method);
    },
  );

  it("permits normal read navigation but rejects explicitly foreign read origins", () => {
    requireGoogleOrigin(undefined, "GET");
    expect(() =>
      requireGoogleOrigin("https://untrusted.example", "GET"),
    ).toThrow("forbidden");
  });

  it.each(["GET", "POST", "DELETE"])(
    "keeps credentials and integration operations privileged for %s",
    (method) => {
      expect(
        requiredGoogleApiRole(method, "/api/admin-keys?workspaceId=x"),
      ).toBe(RoleEnum.Admin);
      expect(
        requiredGoogleApiRole(method, "/api/settings/email-providers"),
      ).toBe(RoleEnum.WorkspaceManager);
      expect(requiredGoogleApiRole(method, "/api/secrets/")).toBe(
        RoleEnum.WorkspaceManager,
      );
      expect(
        requiredGoogleApiRole(method, "/dashboard/api/oauth/set-csrf-cookie"),
      ).toBe(RoleEnum.WorkspaceManager);
      expect(
        requiredGoogleApiRole(method, "/api/deliveries/opens/evidence"),
      ).toBe(RoleEnum.WorkspaceManager);
    },
  );

  it("allows read-only POST searches without granting draft mutations", () => {
    expect(requiredGoogleApiRole("POST", "/api/users?workspaceId=x")).toBe(
      RoleEnum.Viewer,
    );
    expect(requiredGoogleApiRole("POST", "/api/deliveries/opens")).toBe(
      RoleEnum.Viewer,
    );
    expect(requiredGoogleApiRole("POST", "/api/content/templates")).toBe(
      RoleEnum.Author,
    );
    expect(requiredGoogleApiRole("POST", "/api/content/templates/render")).toBe(
      RoleEnum.Author,
    );
    expect(requiredGoogleApiRole("PUT", "/api/journeys")).toBe(RoleEnum.Author);
  });

  it("blocks Viewers from SSR editor loaders while keeping browsing and profiles available", () => {
    expect(
      requiredGoogleDashboardRole("/dashboard/templates/email/create"),
    ).toBe(RoleEnum.Author);
    expect(
      requiredGoogleDashboardRole("/dashboard/journeys/example?edit=true"),
    ).toBe(RoleEnum.Author);
    expect(requiredGoogleDashboardRole("/dashboard/settings/access")).toBe(
      RoleEnum.WorkspaceManager,
    );
    expect(requiredGoogleDashboardRole("/dashboard/oauth/callback")).toBe(
      RoleEnum.WorkspaceManager,
    );
    expect(requiredGoogleDashboardRole("/dashboard/home")).toBe(
      RoleEnum.Viewer,
    );
    expect(requiredGoogleDashboardRole("/dashboard/account")).toBe(
      RoleEnum.Viewer,
    );
    expect(requiredGoogleDashboardRole("/dashboard/users/contact-id")).toBe(
      RoleEnum.Viewer,
    );
  });

  it.each([
    "/dashboard/workspace",
    "/workspace?view=subscribers",
    "/dashboard/workspace?view=settings",
  ])("allows Viewers to browse the workspace dashboard: %s", (path) => {
    expect(requiredGoogleDashboardRole(path)).toBe(RoleEnum.Viewer);
  });

  it("recognizes OAuth secrets even on malformed or unmatched callback URLs", () => {
    expect(
      googleAuthSensitiveUrl(
        "/api/public/auth/google/callback?code=secret&state=secret",
      ),
    ).toBe(true);
    expect(
      googleAuthSensitiveUrl("/api/public/auth/google/unmatched?code=secret"),
    ).toBe(true);
    expect(
      googleAuthSensitiveUrl("/dashboard/auth/invite?token=misplaced-secret"),
    ).toBe(true);
    expect(googleAuthSensitiveUrl("/api/users")).toBe(false);
  });
});

test("account control validation rejects invisible ASCII controls without rejecting ordinary names", () => {
  expect(
    containsAccountControlCharacters(`bad${String.fromCharCode(0)}name`),
  ).toBe(true);
  expect(
    containsAccountControlCharacters(`bad${String.fromCharCode(31)}name`),
  ).toBe(true);
  expect(
    containsAccountControlCharacters(`bad${String.fromCharCode(127)}name`),
  ).toBe(true);
  expect(containsAccountControlCharacters("Ronin Publishing")).toBe(false);
});

test.each(["", "short-key", DEFAULT_BACKEND_CONFIG.secretKey])(
  "Google mode rejects missing, short, or publicly known signing keys",
  (secretKey) => {
    expect(() =>
      googleSessionPluginOptions({
        dashboardUrl: "https://mail.example.com",
        secretKey,
      }),
    ).toThrow("random SECRET_KEY");
  },
);

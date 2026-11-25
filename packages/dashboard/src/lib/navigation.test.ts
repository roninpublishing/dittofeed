import { activeNavigationUrl } from "./navigation";

const workspaceLinks = [
  "/workspace",
  "/workspace/newsletters",
  "/workspace/esp-accounts",
  "/workspace/ips",
  "/workspace/ip-pools",
  "/workspace/subscribers",
  "/workspace/reports",
  "/workspace/settings",
];

describe("activeNavigationUrl", () => {
  it.each(workspaceLinks)("selects the workspace section %s", (href) => {
    expect(activeNavigationUrl(href, workspaceLinks)).toBe(href);
  });

  it("keeps Overview active at the workspace root", () => {
    expect(activeNavigationUrl("/workspace", workspaceLinks)).toBe(
      "/workspace",
    );
  });

  it("ignores filters and fragments when matching a section", () => {
    expect(
      activeNavigationUrl(
        "/workspace/reports?accountId=example#activity",
        workspaceLinks,
      ),
    ).toBe("/workspace/reports");
  });

  it("keeps ESP accounts active inside an account detail", () => {
    expect(
      activeNavigationUrl("/workspace/esp-accounts/account-id", workspaceLinks),
    ).toBe("/workspace/esp-accounts");
  });

  it("selects the nearest parent for a nested editor, not a path prefix sibling", () => {
    expect(
      activeNavigationUrl("/users/123?tab=events", ["/", "/user", "/users"]),
    ).toBe("/users");
  });

  it("prefers a more specific nested route and tolerates a trailing slash", () => {
    expect(
      activeNavigationUrl("/settings/access/", [
        "/settings",
        "/settings/access",
      ]),
    ).toBe("/settings/access");
  });

  it("does not mark an unrelated or external link as active", () => {
    expect(
      activeNavigationUrl("/users", ["/reports", "https://example.com/users"]),
    ).toBeUndefined();
  });
});

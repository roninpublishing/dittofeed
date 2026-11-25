import { activeNavigationUrl } from "./navigation";

const publisherLinks = [
  "/workspace",
  "/workspace?view=subscribers",
  "/workspace?view=reports",
  "/workspace?view=settings",
];

describe("activeNavigationUrl", () => {
  it.each(["subscribers", "reports", "settings"])(
    "selects the %s workspace view instead of Newsletters",
    (view) => {
      expect(
        activeNavigationUrl(`/workspace?view=${view}`, publisherLinks),
      ).toBe(`/workspace?view=${view}`);
    },
  );

  it("keeps Newsletters active when no view is selected", () => {
    expect(activeNavigationUrl("/workspace", publisherLinks)).toBe(
      "/workspace",
    );
  });

  it("ignores unrelated filters and fragments when matching a view", () => {
    expect(
      activeNavigationUrl(
        "/workspace?search=some%20name&view=reports#activity",
        publisherLinks,
      ),
    ).toBe("/workspace?view=reports");
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

import { parseWorkspaceRoute, workspaceSections } from "./workspaceRoutes";

const id = "11111111-1111-4111-8111-111111111111";

describe("workspace dashboard routes", () => {
  it("opens Overview at the workspace root", () => {
    expect(parseWorkspaceRoute(undefined)).toEqual({
      section: "overview",
      resourceId: null,
    });
  });
  it.each(workspaceSections.filter((section) => section !== "overview"))(
    "opens %s directly",
    (section) => {
      expect(parseWorkspaceRoute([section])).toEqual({
        section,
        resourceId: null,
      });
    },
  );
  it.each(["newsletters", "esp-accounts", "ips", "ip-pools"])(
    "opens a %s resource without changing workspace context",
    (section) => {
      expect(parseWorkspaceRoute([section, id])).toEqual({
        section,
        resourceId: id,
      });
    },
  );
  it.each([
    ["missing"],
    ["ips", "not-an-id"],
    ["reports", id],
    ["settings", id],
    ["esp-accounts", id, "extra"],
  ])("rejects unavailable route %j", (...parts) => {
    expect(parseWorkspaceRoute(parts)).toBeNull();
  });
});

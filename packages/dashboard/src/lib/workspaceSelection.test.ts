import type { WorkspaceMemberRoleResource } from "isomorphic-lib/src/types";

import { workspaceSelection } from "./workspaceSelection";

function membership(
  workspaceId: string,
  parentWorkspaceId: string | null = null,
): WorkspaceMemberRoleResource {
  return {
    workspaceId,
    workspaceName: workspaceId,
    parentWorkspaceId,
    workspaceMemberId: "member",
    role: "Viewer",
  };
}

const memberships = [
  membership("workspace"),
  membership("newsletter", "workspace"),
  membership("sibling", "workspace"),
  membership("other-workspace"),
  membership("other-newsletter", "other-workspace"),
];

describe("workspace selection", () => {
  it("lists authorized newsletters from the current workspace", () => {
    const selection = workspaceSelection(memberships, { id: "workspace" });
    expect(selection.currentWorkspace?.id).toBe("workspace");
    expect(selection.newsletters.map((option) => option.id)).toEqual([
      "newsletter",
      "sibling",
    ]);
    expect(selection.currentNewsletter).toBeUndefined();
  });

  it("keeps the parent and current newsletter selected in a native newsletter", () => {
    const selection = workspaceSelection(memberships, {
      id: "newsletter",
      parentWorkspaceId: "workspace",
    });
    expect(selection.currentWorkspace?.id).toBe("workspace");
    expect(selection.currentNewsletter?.id).toBe("newsletter");
    expect(selection.newsletters.map((option) => option.id)).toEqual([
      "newsletter",
      "sibling",
    ]);
  });

  it("never invents parent or sibling access for newsletter-only members", () => {
    const selection = workspaceSelection(
      [membership("newsletter", "workspace")],
      { id: "newsletter", parentWorkspaceId: "workspace" },
    );
    expect(selection.workspaces).toEqual([]);
    expect(selection.currentWorkspace).toBeUndefined();
    expect(selection.newsletters).toEqual([
      { id: "newsletter", label: "newsletter" },
    ]);
    expect(selection.currentNewsletter?.id).toBe("newsletter");
  });

  it("preserves directly authorized newsletters outside owned workspaces", () => {
    const selection = workspaceSelection(
      [...memberships, membership("standalone", "unavailable-parent")],
      { id: "workspace" },
    );
    expect(selection.newsletters.map((option) => option.id)).toEqual([
      "newsletter",
      "sibling",
      "standalone",
    ]);
    expect(
      selection.workspaces.some((option) => option.id === "unavailable-parent"),
    ).toBe(false);
  });

  it("does not infer options from the selected workspace alone", () => {
    const selection = workspaceSelection([], {
      id: "newsletter",
      parentWorkspaceId: "workspace",
    });
    expect(selection.workspaces).toEqual([]);
    expect(selection.newsletters).toEqual([]);
    expect(selection.currentWorkspace).toBeUndefined();
    expect(selection.currentNewsletter).toBeUndefined();
  });
});

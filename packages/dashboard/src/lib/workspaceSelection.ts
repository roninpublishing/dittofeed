import type { WorkspaceMemberRoleResource } from "isomorphic-lib/src/types";

export function workspaceSelection(
  memberships: readonly WorkspaceMemberRoleResource[],
  current: { id: string; parentWorkspaceId?: string | null } | null,
) {
  const workspaceRoles = memberships.filter((role) => !role.parentWorkspaceId);
  const workspaceIds = new Set(workspaceRoles.map((role) => role.workspaceId));
  const workspaces = workspaceRoles.map((role) => ({
    id: role.workspaceId,
    label: role.workspaceName,
  }));
  const currentWorkspaceId = current?.parentWorkspaceId ?? current?.id;
  // Keep newsletter-only memberships reachable without inventing parent access.
  const otherNewsletters = memberships
    .filter(
      (role) =>
        role.parentWorkspaceId && !workspaceIds.has(role.parentWorkspaceId),
    )
    .map((role) => ({ id: role.workspaceId, label: role.workspaceName }));
  return {
    workspaces,
    currentWorkspace: workspaces.find(
      (option) => option.id === currentWorkspaceId,
    ),
    otherNewsletters,
    currentNewsletter: otherNewsletters.find(
      (option) => option.id === current?.id,
    ),
  };
}

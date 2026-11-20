import { Static, Type } from "@sinclair/typebox";

import { Role, WorkspaceMemberResource, WorkspaceMemberRoleResource } from "./types";

export const AccountProfile = Type.Object({
  member: WorkspaceMemberResource,
  isInstanceAdmin: Type.Boolean(),
  memberships: Type.Array(WorkspaceMemberRoleResource),
  currentSessionId: Type.String(),
});
export type AccountProfile = Static<typeof AccountProfile>;

export const AccountSessionResource = Type.Object({
  id: Type.String(),
  createdAt: Type.String(),
  expiresAt: Type.String(),
  current: Type.Boolean(),
  userAgent: Type.Optional(Type.String()),
});
export type AccountSessionResource = Static<typeof AccountSessionResource>;

export const WorkspaceInvitationResource = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  workspaceName: Type.String(),
  email: Type.String(),
  role: Role,
  createdAt: Type.String(),
  expiresAt: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("revoked"),
    Type.Literal("expired"),
  ]),
});
export type WorkspaceInvitationResource = Static<typeof WorkspaceInvitationResource>;

export const WorkspaceAccountMember = Type.Object({
  member: WorkspaceMemberResource,
  role: Role,
  googleLinked: Type.Boolean(),
  disabled: Type.Boolean(),
  isInstanceAdmin: Type.Boolean(),
});
export type WorkspaceAccountMember = Static<typeof WorkspaceAccountMember>;

export const AccountTeamResponse = Type.Object({
  members: Type.Array(WorkspaceAccountMember),
  invitations: Type.Array(WorkspaceInvitationResource),
  currentRole: Role,
  canManageInstanceAccounts: Type.Boolean(),
});
export type AccountTeamResponse = Static<typeof AccountTeamResponse>;

export const CreateAccountInvitationRequest = Type.Object({
  workspaceId: Type.String({ format: "uuid" }),
  email: Type.String({ minLength: 3, maxLength: 254 }),
  role: Role,
});
export type CreateAccountInvitationRequest = Static<typeof CreateAccountInvitationRequest>;

export const CreateAccountInvitationResponse = Type.Object({
  invitation: WorkspaceInvitationResource,
  url: Type.String(),
});
export type CreateAccountInvitationResponse = Static<typeof CreateAccountInvitationResponse>;

export const UpdateAccountProfileRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
});
export type UpdateAccountProfileRequest = Static<typeof UpdateAccountProfileRequest>;

export const UpdateAccountMemberRoleRequest = Type.Object({
  workspaceId: Type.String({ format: "uuid" }),
  role: Role,
});
export type UpdateAccountMemberRoleRequest = Static<typeof UpdateAccountMemberRoleRequest>;

export const AccountSuccess = Type.Object({ success: Type.Literal(true) });
export type AccountSuccess = Static<typeof AccountSuccess>;

export const GoogleAuthStatus = Type.Object({
  enabled: Type.Boolean(),
  configured: Type.Boolean(),
  callbackUrl: Type.String(),
  loginUrl: Type.String(),
});
export type GoogleAuthStatus = Static<typeof GoogleAuthStatus>;

// OAuth authorization codes and state must not enter ordinary access logs/traces.
export function googleAuthSensitiveUrl(url: string | undefined): boolean {
  const path = url?.split("?")[0] ?? "";
  return path.startsWith("/api/public/auth/google/") ||
    path === "/dashboard/auth/invite";
}

export function containsAccountControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

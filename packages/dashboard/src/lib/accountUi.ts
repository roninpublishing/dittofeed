import axios from "axios";
import { Role, RoleEnum } from "isomorphic-lib/src/types";

const accountErrors: Record<string, string> = {
  not_authenticated: "Your session has ended. Sign in with Google again.",
  forbidden:
    "You do not have permission to make this change. Refresh to see your current access.",
  no_access:
    "This Google account has no active workspace access. Contact a workspace administrator.",
  not_invited:
    "This Google account has not been invited. Ask an administrator for a private invitation link.",
  invalid_invitation:
    "This invitation is invalid, expired, revoked, or already used. Ask an administrator for a new link.",
  invitation_email_mismatch:
    "You chose a different Google account from the one invited. Your invitation remains valid. Reopen the original PRIVATE invitation link and choose the Google account named on it.",
  identity_conflict:
    "This Google identity conflicts with an existing account. Contact an administrator; accounts cannot be merged automatically.",
  already_member: "This account is already a member of this workspace.",
  last_administrator:
    "This change would leave a workspace without an enabled Google-linked administrator. Assign another administrator first.",
  last_instance_administrator:
    "You cannot disable the last enabled instance administrator.",
  rate_limited: "Too many attempts. Wait a few minutes before trying again.",
  invalid_profile: "Enter a display name between 1 and 120 characters.",
  invalid_origin:
    "This request could not be verified. Open the configured dashboard address and try again.",
  not_configured:
    "Google sign-in is not configured. Contact the instance administrator.",
  bootstrap_subject_required:
    "Initial owner setup requires an additional identity check for this Google account. Ask the instance administrator to configure GOOGLE_BOOTSTRAP_ADMIN_SUBJECT with the intended owner's verified Google subject, alongside the bootstrap owner email and existing workspace. Do not substitute an email address for the Google subject.",
  invalid_google_response:
    "Google could not verify this account. Start again and choose the invited Google account.",
  google_auth_failed:
    "Google sign-in could not be completed. Start again and choose the invited Google account.",
  invalid_state:
    "This sign-in attempt expired or was already used. Start again.",
};

export function accountErrorMessage(error: unknown): string {
  if (axios.isAxiosError<{ code?: string }>(error)) {
    const code = error.response?.data.code;
    const message =
      code && Object.prototype.hasOwnProperty.call(accountErrors, code)
        ? accountErrors[code]
        : undefined;
    if (message) {
      return message;
    }
    if (error.response?.status === 401) {
      return accountErrors.not_authenticated ?? "Sign in again.";
    }
    if (error.response?.status === 403) {
      return accountErrors.forbidden ?? "You do not have permission.";
    }
    if (error.response?.status === 429) {
      return (
        accountErrors.rate_limited ?? "Too many requests. Try again later."
      );
    }
  }
  return "The request could not be completed. Try again or contact an administrator.";
}

export function authErrorMessage(code: string): string {
  return (
    (Object.prototype.hasOwnProperty.call(accountErrors, code)
      ? accountErrors[code]
      : undefined) ?? "Google sign-in could not be completed. Start again."
  );
}

// Read once into component memory, then replace (never push) the current history
// entry before making any request. No invitation secret goes into a query key.
export function takeInvitationToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): string | null {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}`,
  );
  const tokens = fragment.getAll("token");
  return tokens.length === 1 && tokens[0] ? tokens[0] : null;
}

export function manageableAccountRoles(role: Role): Role[] {
  if (role === RoleEnum.Admin) {
    return [
      RoleEnum.Admin,
      RoleEnum.WorkspaceManager,
      RoleEnum.Author,
      RoleEnum.Viewer,
    ];
  }
  if (role === RoleEnum.WorkspaceManager) {
    return [RoleEnum.Author, RoleEnum.Viewer];
  }
  return [];
}

export function accountDate(value: string): string {
  return new Date(value).toLocaleString();
}

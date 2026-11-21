import { LoadingButton } from "@mui/lab";
import {
  Alert,
  Box,
  Button,
  Chip,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import {
  AccountTeamResponse,
  CreateAccountInvitationResponse,
  WorkspaceAccountMember,
} from "isomorphic-lib/src/accounts";
import { CompletionStatus, Role, RoleEnum } from "isomorphic-lib/src/types";
import { GetServerSideProps } from "next";
import { FormEvent, useState } from "react";

import AccountConfirmationButton from "../../components/accountConfirmationButton";
import DashboardContent from "../../components/dashboardContent";
import {
  accountDate,
  accountErrorMessage,
  manageableAccountRoles,
} from "../../lib/accountUi";
import { addInitialStateToProps } from "../../lib/addInitialStateToProps";
import { useAppStorePick } from "../../lib/appStore";
import { useBaseApiUrl } from "../../lib/authModeProvider";
import { requestContext } from "../../lib/requestContext";
import { PropsWithInitialState } from "../../lib/types";

export const getServerSideProps: GetServerSideProps<PropsWithInitialState> =
  requestContext(async ({ res }, dfContext) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return { props: addInitialStateToProps({ props: {}, dfContext }) };
  });

type TeamAction =
  | { type: "role"; memberId: string; role: Role }
  | { type: "remove"; memberId: string }
  | { type: "disabled"; memberId: string; disabled: boolean }
  | { type: "revoke"; invitationId: string };

function MemberAccess({
  entry,
  team,
  busy,
  act,
}: {
  entry: WorkspaceAccountMember;
  team: AccountTeamResponse;
  busy: boolean;
  act: (action: TeamAction) => void;
}) {
  const [role, setRole] = useState(entry.role);
  const roles = manageableAccountRoles(team.currentRole);
  const canManage = roles.includes(entry.role);
  const identity = entry.member.name ? entry.member.name : entry.member.email;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h5" sx={{ overflowWrap: "anywhere" }}>
            {identity}
          </Typography>
          <Typography color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            {entry.member.email}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip size="small" label={entry.role} />
          <Chip
            size="small"
            label={entry.googleLinked ? "Google linked" : "Not Google linked"}
          />
          {entry.disabled && (
            <Chip size="small" color="error" label="Account disabled" />
          )}
          {entry.isInstanceAdmin && (
            <Chip size="small" label="Instance administrator" />
          )}
        </Stack>
        {canManage && (
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            alignItems={{ sm: "center" }}
          >
            <TextField
              select
              label={`Role for ${entry.member.email}`}
              value={role}
              disabled={busy}
              onChange={(event) => {
                const selected = roles.find(
                  (candidate) => candidate === event.target.value,
                );
                if (selected) setRole(selected);
              }}
              sx={{ minWidth: 180 }}
            >
              {roles.map((available) => (
                <MenuItem key={available} value={available}>
                  {available}
                </MenuItem>
              ))}
            </TextField>
            <AccountConfirmationButton
              pending={busy}
              disabled={role === entry.role}
              confirmationTitle="Change workspace role?"
              confirmationMessage={`Change ${identity}'s role in this workspace from ${entry.role} to ${role}? Their other workspace roles are unchanged.`}
              confirmLabel="Save role"
              onConfirm={() =>
                act({ type: "role", memberId: entry.member.id, role })
              }
            >
              Save role
            </AccountConfirmationButton>
            <AccountConfirmationButton
              color="error"
              pending={busy}
              confirmationTitle="Remove workspace member?"
              confirmationMessage={`Remove ${identity} from this workspace? Their other workspace memberships and Google account are unchanged.`}
              confirmLabel="Remove from workspace"
              onConfirm={() =>
                act({ type: "remove", memberId: entry.member.id })
              }
            >
              Remove from workspace
            </AccountConfirmationButton>
          </Stack>
        )}
        {team.canManageInstanceAccounts && entry.googleLinked && (
          <Box>
            <AccountConfirmationButton
              color={entry.disabled ? "primary" : "error"}
              pending={busy}
              confirmationTitle={
                entry.disabled
                  ? "Re-enable account across instance?"
                  : "Disable account across instance?"
              }
              confirmationMessage={
                entry.disabled
                  ? `Re-enable ${identity}'s account across this instance? They can sign in again to their existing workspaces. This is not limited to this workspace.`
                  : `Disable ${identity}'s account across ALL workspaces and revoke their application sessions? This is not limited to this workspace. Their Google credentials are unaffected.`
              }
              confirmLabel={
                entry.disabled ? "Re-enable account" : "Disable account"
              }
              onConfirm={() =>
                act({
                  type: "disabled",
                  memberId: entry.member.id,
                  disabled: !entry.disabled,
                })
              }
            >
              {entry.disabled
                ? "Re-enable account across instance"
                : "Disable account across instance"}
            </AccountConfirmationButton>
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

function TeamAccess({ workspaceId }: { workspaceId: string }) {
  const apiUrl = useBaseApiUrl();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(RoleEnum.Viewer);
  const [created, setCreated] =
    useState<CreateAccountInvitationResponse | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const team = useQuery({
    queryKey: ["owned-account-team", apiUrl, workspaceId],
    queryFn: async () =>
      (
        await axios.get<AccountTeamResponse>(`${apiUrl}/account/team`, {
          params: { workspaceId },
          withCredentials: true,
        })
      ).data,
    retry: false,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["owned-account-team", apiUrl, workspaceId],
    });
  const change = useMutation({
    mutationFn: async (action: TeamAction) => {
      switch (action.type) {
        case "role":
          await axios.patch(
            `${apiUrl}/account/members/${encodeURIComponent(action.memberId)}/role`,
            { workspaceId, role: action.role },
            { withCredentials: true },
          );
          break;
        case "remove":
          await axios.delete(
            `${apiUrl}/account/members/${encodeURIComponent(action.memberId)}`,
            { params: { workspaceId }, withCredentials: true },
          );
          break;
        case "disabled":
          await axios.post(
            `${apiUrl}/account/members/${encodeURIComponent(action.memberId)}/disabled`,
            { disabled: action.disabled },
            { withCredentials: true },
          );
          break;
        case "revoke":
          await axios.delete(
            `${apiUrl}/account/invitations/${encodeURIComponent(action.invitationId)}`,
            { params: { workspaceId }, withCredentials: true },
          );
          break;
      }
    },
    onSuccess: async (_, action) => {
      if (
        action.type === "revoke" &&
        created?.invitation.id === action.invitationId
      )
        setCreated(null);
      await invalidate();
    },
  });
  const invite = useMutation({
    mutationFn: async () => {
      const response = await axios.post<CreateAccountInvitationResponse>(
        `${apiUrl}/account/invitations`,
        { workspaceId, email: email.trim(), role },
        { withCredentials: true },
      );
      // Keep the private link only in this mounted workspace view, not mutation data.
      setCreated(response.data);
      setCopyStatus(null);
      setEmail("");
    },
    onSuccess: invalidate,
  });
  const busy = change.isPending || invite.isPending;
  const teamData = team.data;
  const allowedRoles = teamData
    ? manageableAccountRoles(teamData.currentRole)
    : [];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && email.trim() && allowedRoles.includes(role)) invite.mutate();
  };

  return (
    <Stack spacing={3}>
      {team.isPending && (
        <Typography role="status">Loading workspace access…</Typography>
      )}
      {team.isError && (
        <Alert
          severity="error"
          action={
            <Button
              onClick={() => {
                void team.refetch();
              }}
            >
              Retry
            </Button>
          }
        >
          {accountErrorMessage(team.error)}
        </Alert>
      )}
      {change.isError && (
        <Alert severity="error">{accountErrorMessage(change.error)}</Alert>
      )}
      {change.isSuccess && (
        <Alert severity="success">Access change saved.</Alert>
      )}
      {teamData && (
        <>
          <Typography variant="body2" color="text.secondary">
            Your workspace role: {teamData.currentRole}. Managers manage Authors
            and Viewers; administrators manage all workspace roles. The server
            checks every change, including self-escalation and
            last-administrator protection.
          </Typography>
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Stack component="form" spacing={2} onSubmit={submit}>
              <Typography component="h2" variant="h5">
                Invite a teammate
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Create an expiring private link for one verified Google email.
                No invitation email is sent automatically; deliver the link
                privately to that person.
              </Typography>
              <TextField
                label="Google email"
                type="email"
                required
                value={email}
                disabled={busy}
                inputProps={{ maxLength: 254 }}
                onChange={(event) => {
                  setEmail(event.target.value);
                  invite.reset();
                }}
              />
              <TextField
                select
                label="Workspace role"
                value={role}
                disabled={busy}
                onChange={(event) => {
                  const selected = allowedRoles.find(
                    (candidate) => candidate === event.target.value,
                  );
                  if (selected) setRole(selected);
                }}
              >
                {allowedRoles.map((available) => (
                  <MenuItem key={available} value={available}>
                    {available}
                  </MenuItem>
                ))}
              </TextField>
              {invite.isError && (
                <Alert severity="error">
                  {accountErrorMessage(invite.error)}
                </Alert>
              )}
              <Box>
                <LoadingButton
                  type="submit"
                  loading={invite.isPending}
                  disabled={
                    busy || !email.trim() || !allowedRoles.includes(role)
                  }
                  variant="contained"
                >
                  Create invitation link
                </LoadingButton>
              </Box>
            </Stack>
          </Paper>
          {created && (
            <Alert
              severity="success"
              onClose={() => {
                setCreated(null);
                setCopyStatus(null);
              }}
            >
              <Stack spacing={1}>
                <Typography>
                  Private invitation created for {created.invitation.email}.
                  Expires {accountDate(created.invitation.expiresAt)}.
                </Typography>
                <TextField
                  label="Private invitation link"
                  value={created.url}
                  InputProps={{ readOnly: true }}
                  fullWidth
                  onFocus={(event) => event.target.select()}
                />
                <Box>
                  <Button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(created.url);
                        setCopyStatus("copied");
                      } catch {
                        setCopyStatus("failed");
                      }
                    }}
                  >
                    Copy private link
                  </Button>
                </Box>
                {copyStatus === "copied" && (
                  <Typography role="status">
                    Copied. Share only with the invited person.
                  </Typography>
                )}
                {copyStatus === "failed" && (
                  <Typography role="alert">
                    Clipboard access failed. Select and copy the link above
                    manually.
                  </Typography>
                )}
                <Typography variant="body2">
                  The secret link is shown only in this view and cannot be
                  recovered from the invitation list. Revoke it and create a new
                  one if it is lost.
                </Typography>
              </Stack>
            </Alert>
          )}
          <Typography component="h2" variant="h5">
            Workspace members
          </Typography>
          {teamData.members.length === 0 && (
            <Typography>No members found.</Typography>
          )}
          {teamData.members.map((entry) => (
            <MemberAccess
              key={`${entry.member.id}:${entry.role}:${entry.disabled}`}
              entry={entry}
              team={teamData}
              busy={busy}
              act={(action) => change.mutate(action)}
            />
          ))}
          <Typography component="h2" variant="h5">
            Pending invitations
          </Typography>
          {!teamData.invitations.some(
            (invitation) => invitation.status === "pending",
          ) && <Typography>No pending invitations.</Typography>}
          {teamData.invitations
            .filter((invitation) => invitation.status === "pending")
            .map((invitation) => (
              <Paper key={invitation.id} variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={1}>
                  <Typography sx={{ overflowWrap: "anywhere" }}>
                    {invitation.email} · {invitation.role}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Expires {accountDate(invitation.expiresAt)}
                  </Typography>
                  {allowedRoles.includes(invitation.role) && (
                    <Box>
                      <AccountConfirmationButton
                        color="error"
                        pending={busy}
                        confirmationTitle="Revoke workspace invitation?"
                        confirmationMessage={`Revoke the invitation for ${invitation.email} to this workspace? Its private link will stop working.`}
                        confirmLabel="Revoke invitation"
                        onConfirm={() =>
                          change.mutate({
                            type: "revoke",
                            invitationId: invitation.id,
                          })
                        }
                      >
                        Revoke invitation
                      </AccountConfirmationButton>
                    </Box>
                  )}
                </Stack>
              </Paper>
            ))}
          <Typography variant="body2" color="text.secondary">
            Global account disable/re-enable is available only to instance
            administrators. Disabling revokes all application sessions; Google
            credentials are unaffected. Members not linked to Google are not
            silently converted into Google accounts.
          </Typography>
        </>
      )}
    </Stack>
  );
}

export default function AccessPage() {
  const { authMode, workspace, memberRoles } = useAppStorePick([
    "authMode",
    "workspace",
    "memberRoles",
  ]);
  const membership =
    workspace.type === CompletionStatus.Successful
      ? memberRoles.find((entry) => entry.workspaceId === workspace.value.id)
      : undefined;
  const canManage =
    membership?.role === RoleEnum.Admin ||
    membership?.role === RoleEnum.WorkspaceManager;
  return (
    <DashboardContent>
      <Stack
        spacing={3}
        sx={{ maxWidth: 1100, mx: "auto", p: { xs: 2, md: 4 } }}
      >
        <Typography component="h1" variant="h3">
          Team &amp; access
        </Typography>
        {authMode !== "google" && (
          <Alert severity="info">
            Team account management is available when Google sign-in is enabled.
          </Alert>
        )}
        {authMode === "google" &&
          workspace.type !== CompletionStatus.Successful && (
            <Alert severity="warning">
              Select a workspace to manage access.
            </Alert>
          )}
        {authMode === "google" &&
          workspace.type === CompletionStatus.Successful &&
          !canManage && (
            <Alert severity="warning">
              A workspace Manager or Admin role is required to manage team
              access.
            </Alert>
          )}
        {authMode === "google" &&
          workspace.type === CompletionStatus.Successful &&
          canManage && (
            <TeamAccess
              key={workspace.value.id}
              workspaceId={workspace.value.id}
            />
          )}
      </Stack>
    </DashboardContent>
  );
}

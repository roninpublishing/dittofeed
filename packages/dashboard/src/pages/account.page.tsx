import { LoadingButton } from "@mui/lab";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import {
  AccountProfile,
  AccountSessionResource,
} from "isomorphic-lib/src/accounts";
import { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { FormEvent, useState } from "react";

import AccountConfirmationButton from "../components/accountConfirmationButton";
import DashboardContent from "../components/dashboardContent";
import { accountDate, accountErrorMessage } from "../lib/accountUi";
import { addInitialStateToProps } from "../lib/addInitialStateToProps";
import { useAppStorePick } from "../lib/appStore";
import { useBaseApiUrl } from "../lib/authModeProvider";
import { requestContext } from "../lib/requestContext";
import { PropsWithInitialState } from "../lib/types";

export const getServerSideProps: GetServerSideProps<PropsWithInitialState> =
  requestContext(async ({ res }, dfContext) => {
    res.setHeader("Cache-Control", "no-store");
    return { props: addInitialStateToProps({ props: {}, dfContext }) };
  });

function ProfileForm({
  profile,
  apiUrl,
}: {
  profile: AccountProfile;
  apiUrl: string;
}) {
  const [name, setName] = useState(profile.member.name ?? "");
  const queryClient = useQueryClient();
  const router = useRouter();
  const save = useMutation({
    mutationFn: async () =>
      (
        await axios.patch<AccountProfile>(
          `${apiUrl}/account`,
          { name: name.trim() },
          { withCredentials: true },
        )
      ).data,
    onSuccess: async (updated) => {
      queryClient.setQueryData(["owned-account", apiUrl], updated);
      setName(updated.member.name ?? "");
      await router.replace(router.asPath);
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!save.isPending && name.trim()) save.mutate();
  };
  return (
    <Stack component="form" onSubmit={submit} spacing={2}>
      <Typography component="h2" variant="h5">
        Your profile
      </Typography>
      <TextField
        label="Display name"
        value={name}
        required
        inputProps={{ maxLength: 120 }}
        onChange={(event) => {
          setName(event.target.value);
          save.reset();
        }}
      />
      <TextField
        label="Google email"
        value={profile.member.email}
        InputProps={{ readOnly: true }}
        helperText="Your verified Google identity is managed by Google, not this profile form."
      />
      {save.isError && (
        <Alert severity="error">{accountErrorMessage(save.error)}</Alert>
      )}
      {save.isSuccess && <Alert severity="success">Display name saved.</Alert>}
      <Box>
        <LoadingButton
          type="submit"
          loading={save.isPending}
          disabled={!name.trim()}
          variant="contained"
        >
          Save display name
        </LoadingButton>
      </Box>
    </Stack>
  );
}

function AccountSettings() {
  const apiUrl = useBaseApiUrl();
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ["owned-account", apiUrl],
    queryFn: async () =>
      (
        await axios.get<AccountProfile>(`${apiUrl}/account`, {
          withCredentials: true,
        })
      ).data,
    retry: false,
  });
  const sessions = useQuery({
    queryKey: ["owned-account-sessions", apiUrl],
    queryFn: async () =>
      (
        await axios.get<AccountSessionResource[]>(
          `${apiUrl}/account/sessions`,
          { withCredentials: true },
        )
      ).data,
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: async (session: AccountSessionResource | null) => {
      if (session) {
        await axios.delete(
          `${apiUrl}/account/sessions/${encodeURIComponent(session.id)}`,
          { withCredentials: true },
        );
      } else {
        await axios.post(
          `${apiUrl}/account/sessions/revoke-others`,
          {},
          { withCredentials: true },
        );
      }
    },
    onSuccess: async (_, session) => {
      if (session?.current) {
        queryClient.clear();
        window.location.assign("/dashboard/auth/google");
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: ["owned-account-sessions", apiUrl],
      });
    },
  });

  return (
    <Stack spacing={3} sx={{ maxWidth: 900, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Typography component="h1" variant="h3">
        Account
      </Typography>
      {profile.isPending && (
        <Typography role="status">Loading profile…</Typography>
      )}
      {profile.isError && (
        <Alert
          severity="error"
          action={
            <Button
              onClick={() => {
                void profile.refetch();
              }}
            >
              Retry
            </Button>
          }
        >
          {accountErrorMessage(profile.error)}
        </Alert>
      )}
      {profile.data && (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <ProfileForm
            key={profile.data.member.id}
            profile={profile.data}
            apiUrl={apiUrl}
          />
        </Paper>
      )}
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Typography component="h2" variant="h5">
            Signed-in sessions
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Revoke sessions you no longer recognize. Device descriptions are
            supplied by browsers and are not verified identities.
          </Typography>
          {sessions.isPending && (
            <Typography role="status">Loading sessions…</Typography>
          )}
          {sessions.isError && (
            <Alert
              severity="error"
              action={
                <Button
                  onClick={() => {
                    void sessions.refetch();
                  }}
                >
                  Retry
                </Button>
              }
            >
              {accountErrorMessage(sessions.error)}
            </Alert>
          )}
          {revoke.isError && (
            <Alert severity="error">{accountErrorMessage(revoke.error)}</Alert>
          )}
          {revoke.isSuccess && (
            <Alert severity="success">Sessions updated.</Alert>
          )}
          {sessions.data?.length === 0 && (
            <Typography>No active sessions.</Typography>
          )}
          {sessions.data?.map((session) => (
            <Stack
              key={session.id}
              spacing={1}
              sx={{ py: 2, borderBottom: 1, borderColor: "divider" }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography sx={{ overflowWrap: "anywhere" }}>
                  {session.userAgent ? session.userAgent : "Unknown browser"}
                </Typography>
                {session.current && (
                  <Chip label="Current" size="small" color="primary" />
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Created {accountDate(session.createdAt)} · Expires{" "}
                {accountDate(session.expiresAt)}
              </Typography>
              <Box>
                <AccountConfirmationButton
                  color="error"
                  pending={revoke.isPending}
                  confirmationTitle={
                    session.current ? "Revoke and sign out?" : "Revoke session?"
                  }
                  confirmationMessage={
                    session.current
                      ? "This application session will be revoked and you will be signed out. Your Google account is unaffected."
                      : "This device will need to sign in again to DITTO Email Client. Your other sessions and Google account are unaffected."
                  }
                  confirmLabel={
                    session.current ? "Revoke and sign out" : "Revoke session"
                  }
                  onConfirm={() => revoke.mutate(session)}
                >
                  {session.current ? "Revoke and sign out" : "Revoke session"}
                </AccountConfirmationButton>
              </Box>
            </Stack>
          ))}
          <Box>
            <AccountConfirmationButton
              pending={revoke.isPending}
              disabled={!sessions.data?.some((session) => !session.current)}
              confirmationTitle="Revoke all other sessions?"
              confirmationMessage="All your other DITTO Email Client sessions will be signed out. This session and your Google account are unaffected."
              confirmLabel="Revoke other sessions"
              onConfirm={() => revoke.mutate(null)}
            >
              Revoke all other sessions
            </AccountConfirmationButton>
          </Box>
        </Stack>
      </Paper>
      <Divider />
      <Stack spacing={1}>
        <Typography component="h2" variant="h5">
          Google security and recovery
        </Typography>
        <Typography>
          Your Google password, two-step verification, and recovery methods are
          managed by Google. Workspace membership, roles, and these application
          sessions are managed by DITTO Email Client. Contact an administrator
          to recover workspace access.
        </Typography>
        <Link
          href="https://myaccount.google.com/security"
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage Google account security
        </Link>
        <Link
          href="https://accounts.google.com/signin/recovery"
          target="_blank"
          rel="noopener noreferrer"
        >
          Recover your Google account
        </Link>
      </Stack>
    </Stack>
  );
}

export default function AccountPage() {
  const { authMode } = useAppStorePick(["authMode"]);
  return (
    <DashboardContent>
      {authMode === "google" ? (
        <AccountSettings />
      ) : (
        <Alert severity="info" sx={{ m: 3 }}>
          Owned account settings are available when Google sign-in is enabled.
        </Alert>
      )}
    </DashboardContent>
  );
}

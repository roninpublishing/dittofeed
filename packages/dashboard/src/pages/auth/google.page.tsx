import {
  Alert,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import backendConfig from "backend-lib/src/config";
import { GoogleAuthStatus } from "isomorphic-lib/src/accounts";
import { GetServerSideProps } from "next";
import { useRouter } from "next/router";

import AccountAuthFrame from "../../components/accountAuthFrame";
import { accountErrorMessage, authErrorMessage } from "../../lib/accountUi";

interface GoogleSignInProps {
  apiBase: string;
}

export const getServerSideProps: GetServerSideProps<
  GoogleSignInProps
> = async ({ res }) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return { props: { apiBase: backendConfig().apiBase } };
};

export default function GoogleSignIn({ apiBase }: GoogleSignInProps) {
  const router = useRouter();
  const status = useQuery({
    queryKey: ["google-auth-status", apiBase],
    queryFn: async () =>
      (
        await axios.get<GoogleAuthStatus>(
          `${apiBase}/api/public/auth/google/status`,
          { withCredentials: true },
        )
      ).data,
    retry: false,
  });
  const errorCode =
    typeof router.query.error === "string" ? router.query.error : null;

  return (
    <AccountAuthFrame title="Sign in with Google">
      <Typography color="text.secondary">
        Use the Google account invited to your workspace. Google verifies your
        identity; DITTO Email Client manages workspace access.
      </Typography>
      {errorCode && (
        <Alert severity="error">{authErrorMessage(errorCode)}</Alert>
      )}
      {status.isPending && (
        <CircularProgress size={24} aria-label="Checking Google sign-in" />
      )}
      {status.isError && (
        <Stack spacing={1}>
          <Alert severity="error">{accountErrorMessage(status.error)}</Alert>
          <Button
            onClick={() => {
              void status.refetch();
            }}
          >
            Try again
          </Button>
        </Stack>
      )}
      {status.data && (!status.data.enabled || !status.data.configured) && (
        <Alert severity="warning">
          {!status.data.enabled
            ? "Google sign-in is not enabled. The instance administrator must select AUTH_MODE=google to use this page."
            : "Google sign-in is not configured. Ask the instance administrator to configure the Google OAuth client ID and secret, the initial owner email, and an existing bootstrap workspace."}
          {status.data.callbackUrl && (
            <Typography
              variant="body2"
              sx={{ mt: 1, overflowWrap: "anywhere" }}
            >
              Authorized Google redirect URI: {status.data.callbackUrl}
            </Typography>
          )}
        </Alert>
      )}
      {status.data?.enabled && status.data.configured && (
        <Button
          variant="contained"
          size="large"
          href={`${apiBase}/api/public/auth/google/start?returnTo=${encodeURIComponent("/dashboard/home")}`}
        >
          Continue with Google
        </Button>
      )}
      <Typography variant="body2" color="text.secondary">
        No invitation? Contact your workspace administrator. Your password,
        two-step verification, and recovery options are managed by Google.
      </Typography>
    </AccountAuthFrame>
  );
}

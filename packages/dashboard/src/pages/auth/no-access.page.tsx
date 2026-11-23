import { LoadingButton } from "@mui/lab";
import { Alert, Link, Typography } from "@mui/material";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import backendConfig from "backend-lib/src/config";
import { GetServerSideProps } from "next";
import NextLink from "next/link";
import { useRouter } from "next/router";

import AccountAuthFrame from "../../components/accountAuthFrame";
import { accountErrorMessage, authErrorMessage } from "../../lib/accountUi";

interface NoAccessProps {
  apiBase: string;
}

export const getServerSideProps: GetServerSideProps<NoAccessProps> = async ({
  res,
}) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return { props: { apiBase: backendConfig().apiBase } };
};

export default function NoAccess({ apiBase }: NoAccessProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: async () => {
      await axios.post(
        `${apiBase}/api/account/logout`,
        {},
        { withCredentials: true },
      );
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/dashboard/auth/google");
    },
  });
  const code =
    typeof router.query.error === "string" ? router.query.error : "no_access";
  return (
    <AccountAuthFrame title="Workspace access required">
      <Alert severity="warning">{authErrorMessage(code)}</Alert>
      <Typography>
        Ask a workspace administrator for a new private invitation link. Use the
        Google account named in the invitation. Disabled accounts must be
        re-enabled by an instance administrator.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        If you lost access to Google, recover that Google account first. DITTO
        Email Client does not store or reset Google passwords.
      </Typography>
      <Link
        href="https://accounts.google.com/signin/recovery"
        target="_blank"
        rel="noopener noreferrer"
      >
        Recover your Google account
      </Link>
      {logout.isError && (
        <Alert severity="error">{accountErrorMessage(logout.error)}</Alert>
      )}
      <LoadingButton
        variant="contained"
        loading={logout.isPending}
        onClick={() => logout.mutate()}
      >
        Sign out and choose another Google account
      </LoadingButton>
      <Link component={NextLink} href="/auth/google">
        Return to sign in
      </Link>
    </AccountAuthFrame>
  );
}

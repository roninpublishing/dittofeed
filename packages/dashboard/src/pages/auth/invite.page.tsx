import { LoadingButton } from "@mui/lab";
import {
  Alert,
  Button,
  CircularProgress,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import { useMutation } from "@tanstack/react-query";
import axios from "axios";
import backendConfig from "backend-lib/src/config";
import { WorkspaceInvitationResource } from "isomorphic-lib/src/accounts";
import { GetServerSideProps } from "next";
import NextLink from "next/link";
import { useEffect, useRef, useState } from "react";

import AccountAuthFrame from "../../components/accountAuthFrame";
import {
  accountDate,
  accountErrorMessage,
  takeInvitationToken,
} from "../../lib/accountUi";

interface InvitationProps {
  apiBase: string;
}

export const getServerSideProps: GetServerSideProps<InvitationProps> = async ({
  res,
}) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return { props: { apiBase: backendConfig().apiBase } };
};

export default function Invitation({ apiBase }: InvitationProps) {
  const captured = useRef(false);
  const previewed = useRef(false);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const preview = useMutation({
    mutationFn: async () => {
      if (!token) {
        throw new Error("Invitation unavailable");
      }
      const response = await axios.post<WorkspaceInvitationResource>(
        `${apiBase}/api/public/auth/google/invitation`,
        { token },
        { withCredentials: true },
      );
      return response.data;
    },
    retry: false,
    gcTime: 0,
  });
  const start = useMutation({
    mutationFn: async () => {
      if (!token) {
        throw new Error("Invitation unavailable");
      }
      const response = await axios.post<{ url: string }>(
        `${apiBase}/api/public/auth/google/start`,
        { invitationToken: token, returnTo: "/dashboard/home" },
        { withCredentials: true },
      );
      window.location.assign(response.data.url);
    },
    retry: false,
    gcTime: 0,
  });

  useEffect(() => {
    if (captured.current) {
      return;
    }
    captured.current = true;
    const invitationToken = takeInvitationToken(
      window.location,
      window.history,
    );
    setToken(invitationToken);
    setReady(true);
  }, []);

  const { mutate: previewInvitation } = preview;
  useEffect(() => {
    if (token && !previewed.current) {
      previewed.current = true;
      previewInvitation();
    }
  }, [token, previewInvitation]);

  return (
    <AccountAuthFrame title="Workspace invitation">
      {(!ready || preview.isPending) && (
        <CircularProgress size={24} aria-label="Reading invitation" />
      )}
      {ready && !token && (
        <Alert severity="warning">
          No invitation token is available. Open the complete private link from
          your administrator. After opening a link, refreshing this page
          intentionally removes it from memory.
        </Alert>
      )}
      {preview.isError && (
        <Stack spacing={1}>
          <Alert severity="error">{accountErrorMessage(preview.error)}</Alert>
          <Button disabled={!token} onClick={() => preview.mutate()}>
            Try preview again
          </Button>
        </Stack>
      )}
      {preview.data && (
        <Stack spacing={2}>
          <Typography>
            You are invited to <strong>{preview.data.workspaceName}</strong> as{" "}
            <strong>{preview.data.role}</strong>.
          </Typography>
          <Typography>
            Sign in with <strong>{preview.data.email}</strong>. A different
            Google account cannot accept this invitation.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Expires {accountDate(preview.data.expiresAt)}. Access is granted
            only after Google verifies the invited email and the server accepts
            the invitation.
          </Typography>
          {start.isError && (
            <Alert severity="error">{accountErrorMessage(start.error)}</Alert>
          )}
          <LoadingButton
            loading={start.isPending}
            variant="contained"
            onClick={() => start.mutate()}
          >
            Accept with Google
          </LoadingButton>
        </Stack>
      )}
      <Typography variant="body2" color="text.secondary">
        Keep invitation links private. Google manages your password, two-step
        verification, and account recovery.
      </Typography>
      <Link component={NextLink} href="/auth/google">
        Back to sign in
      </Link>
    </AccountAuthFrame>
  );
}

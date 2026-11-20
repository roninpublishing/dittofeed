import { LoadingButton } from "@mui/lab";
import { Stack, TextField, Typography, useTheme } from "@mui/material";
import { AxiosError } from "axios";
import backendConfig, { DEFAULT_BACKEND_CONFIG } from "backend-lib/src/config";
import { SESSION_KEY } from "backend-lib/src/requestContext";
import { UNAUTHORIZED_PAGE } from "isomorphic-lib/src/constants";
import { GetServerSideProps, NextPage } from "next";
import { useRouter } from "next/router";
import React from "react";

import DashboardHead from "../../components/dashboardHead";
import NavCard from "../../components/layout/drawer/drawerContent/navCard";
import { useSingleTenantLoginMutation } from "../../lib/useSingleTenantLoginMutation";
import { getWarningStyles } from "../../lib/warningTheme";

interface SingleTenantAuthProps {
  warnings: string[];
  apiBaseUrl: string;
}

export const getServerSideProps: GetServerSideProps<
  SingleTenantAuthProps
> = async (ctx) => {
  if (backendConfig().authMode !== "single-tenant") {
    return {
      redirect: {
        permanent: false,
        destination: UNAUTHORIZED_PAGE,
      },
    };
  }
  if (ctx.req.headers[SESSION_KEY] === "true") {
    return {
      redirect: {
        permanent: false,
        destination: "/",
      },
    };
  }
  const warnings: string[] = [];

  const {
    password,
    databasePassword,
    clickhousePassword,
    secretKey,
    sessionCookieSecure,
    bootstrap,
  } = backendConfig();

  if (password === DEFAULT_BACKEND_CONFIG.password) {
    warnings.push(
      "Default password is being used. Please configure the PASSWORD environment variable.",
    );
  }

  if (bootstrap) {
    warnings.push(
      "Bootstrap is enabled. Please set BOOTSTRAP to 'false' after initial setup.",
    );
  }

  if (databasePassword === DEFAULT_BACKEND_CONFIG.databasePassword) {
    warnings.push(
      "Default database password is being used. Please configure the DATABASE_PASSWORD environment variable.",
    );
  }

  if (clickhousePassword === DEFAULT_BACKEND_CONFIG.clickhousePassword) {
    warnings.push(
      "Default clickhouse password is being used. Please configure the CLICKHOUSE_PASSWORD environment variable.",
    );
  }

  if (secretKey === DEFAULT_BACKEND_CONFIG.secretKey) {
    warnings.push(
      "Default secret key is being used. Please configure the SECRET_KEY environment variable.",
    );
  }

  if (!sessionCookieSecure) {
    warnings.push(
      "Single tenant cookie is not secure. Please use tls and set SESSION_COOKIE_SECURE='true'.",
    );
  }

  return {
    props: {
      warnings,
      apiBaseUrl: backendConfig().apiBase,
    },
  };
};

const APPLICATION_ERROR = "API Error: something wen't wrong.";

const SingleTenantAuth: NextPage<SingleTenantAuthProps> =
  function SingleTenantAuth({ warnings, apiBaseUrl }) {
    const path = useRouter();
    const theme = useTheme();
    const [password, setPassword] = React.useState("");
    const [error, setError] = React.useState("");

    const loginMutation = useSingleTenantLoginMutation(apiBaseUrl, {
      onSuccess: () => {
        path.push("/");
      },
      onError: (e) => {
        if (!(e instanceof AxiosError) || e.response?.status !== 401) {
          setError(APPLICATION_ERROR);
          return;
        }
        setError("Invalid password");
      },
    });

    const submit = async () => {
      if (loginMutation.isPending) {
        return;
      }
      setError("");
      loginMutation.mutate({ password });
    };

    return (
      <>
        <DashboardHead />
        <Stack
          sx={{
            width: "100%",
            minHeight: "100dvh",
            bgcolor: "background.default",
            px: { xs: 2, sm: 3 },
            py: 6,
          }}
          alignItems="center"
          justifyContent="center"
          spacing={3}
        >
          <Stack
            sx={{
              width: "100%",
              maxWidth: 440,
              bgcolor: "background.paper",
              border: 1,
              borderColor: "divider",
              borderRadius: 3,
              boxShadow: 1,
            }}
          >
            <NavCard />
            <Stack spacing={1} sx={{ px: 3, pt: 2, pb: 3 }}>
              <Typography component="h1" variant="h3">
                Sign in
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Enter your administrator password to continue.
              </Typography>
            </Stack>
            <Stack spacing={2} sx={{ px: 3, pb: 3 }}>
              <TextField
                fullWidth
                error={!!error}
                label="Admin Password"
                type="password"
                value={password}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    submit();
                  }
                }}
                helperText={error}
                onChange={(e) => {
                  setError("");
                  setPassword(e.target.value);
                }}
              />
              <LoadingButton
                disabled={loginMutation.isPending}
                loading={loginMutation.isPending}
                onClick={submit}
                sx={{ minHeight: "3rem" }}
                variant="contained"
              >
                Login
              </LoadingButton>
            </Stack>
          </Stack>
          {Boolean(warnings.length) && (
            <Stack
              direction="column"
              spacing={1}
              sx={{
                p: 2,
                width: "100%",
                maxWidth: 720,
                fontWeight: 600,
                ...getWarningStyles(theme),
              }}
            >
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </Stack>
          )}
        </Stack>
      </>
    );
  };

export default SingleTenantAuth;

import { Box, Paper, Stack, Typography } from "@mui/material";
import { ReactNode } from "react";

import DashboardHead from "./dashboardHead";

export default function AccountAuthFrame({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <>
      <DashboardHead />
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{
          minHeight: "100dvh",
          bgcolor: "background.default",
          px: 2,
          py: 6,
        }}
      >
        <Paper
          variant="outlined"
          sx={{ width: "100%", maxWidth: 520, p: 3, borderRadius: 3 }}
        >
          <Stack spacing={3}>
            <Box
              component="img"
              src="/dashboard/branding/ronin/ronin-logo.png"
              alt="Ronin Publishing"
              sx={{ width: 208, maxWidth: "100%", height: "auto" }}
            />
            <Typography component={title ? "p" : "h1"} variant="h5">
              DITTO Email Client
            </Typography>
            {title && (
              <Typography component="h1" variant="h3">
                {title}
              </Typography>
            )}
            {children}
          </Stack>
        </Paper>
      </Stack>
    </>
  );
}

// assets
import {
  AccountCircle,
  Group,
  Logout,
  Settings,
  SettingsApplications,
} from "@mui/icons-material";
import {
  Alert,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
// material-ui
import { useTheme } from "@mui/material/styles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { CompletionStatus, RoleEnum } from "isomorphic-lib/src/types";
import Link from "next/link";

import { accountErrorMessage } from "../../../../../lib/accountUi";
import { useAppStorePick } from "../../../../../lib/appStore";

// ==============================|| HEADER PROFILE - PROFILE TAB ||============================== //

function ProfileTab() {
  const theme = useTheme();
  const {
    authMode,
    apiBase,
    workspace,
    memberRoles,
    signoutUrl,
    enableAdditionalDashboardSettings,
    additionalDashboardSettingsPath,
    additionalDashboardSettingsTitle,
  } = useAppStorePick([
    "authMode",
    "apiBase",
    "workspace",
    "memberRoles",
    "signoutUrl",
    "enableAdditionalDashboardSettings",
    "additionalDashboardSettingsPath",
    "additionalDashboardSettingsTitle",
  ]);
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
  const currentRole =
    workspace.type === CompletionStatus.Successful
      ? memberRoles.find(
          (membership) => membership.workspaceId === workspace.value.id,
        )?.role
      : undefined;
  const canManageTeam =
    currentRole === RoleEnum.Admin || currentRole === RoleEnum.WorkspaceManager;

  return (
    <List
      component="nav"
      sx={{
        p: 0,
        "& .MuiListItemIcon-root": {
          minWidth: 32,
          color: theme.palette.grey[500],
        },
      }}
    >
      {authMode === "google" && (
        <>
          <ListItemButton LinkComponent={Link} href="/account">
            <ListItemIcon>
              <AccountCircle />
            </ListItemIcon>
            <ListItemText primary="Account" />
          </ListItemButton>
          {canManageTeam && (
            <ListItemButton LinkComponent={Link} href="/settings/access">
              <ListItemIcon>
                <Group />
              </ListItemIcon>
              <ListItemText primary="Team & access" />
            </ListItemButton>
          )}
        </>
      )}
      <ListItemButton LinkComponent={Link} href="/settings">
        <ListItemIcon>
          <Settings />
        </ListItemIcon>
        <ListItemText primary="Settings" />
      </ListItemButton>
      {enableAdditionalDashboardSettings && additionalDashboardSettingsPath ? (
        <ListItemButton href={additionalDashboardSettingsPath}>
          <ListItemIcon>
            <SettingsApplications />
          </ListItemIcon>
          <ListItemText
            primary={additionalDashboardSettingsTitle ?? "Additional Settings"}
          />
        </ListItemButton>
      ) : null}
      {authMode === "google" && (
        <>
          {logout.isError && (
            <Alert severity="error">{accountErrorMessage(logout.error)}</Alert>
          )}
          <ListItemButton
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            <ListItemIcon>
              <Logout />
            </ListItemIcon>
            <ListItemText
              primary={logout.isPending ? "Signing out…" : "Sign Out"}
            />
          </ListItemButton>
        </>
      )}
      {authMode !== "google" && signoutUrl && (
        <ListItemButton href={signoutUrl}>
          <ListItemIcon>
            <Logout />
          </ListItemIcon>
          <ListItemText primary="Sign Out" />
        </ListItemButton>
      )}
    </List>
  );
}

export default ProfileTab;

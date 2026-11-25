// material-ui
// assets
import { MenuOpenOutlined, MenuOutlined } from "@mui/icons-material";
import {
  AppBar,
  Box,
  ButtonBase,
  IconButton,
  Toolbar,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  CompletionStatus,
  WhiteLabelFeatureConfig,
} from "isomorphic-lib/src/types";
import { useMemo } from "react";

// project import
import { useAppStorePick } from "../../lib/appStore";
import useWorkspaceSwitch from "../../lib/useWorkspaceSwitch";
import { workspaceSelection } from "../../lib/workspaceSelection";
import { drawerWidth } from "../config";
import WorkspaceLink from "../workspace/navigation";
import HeaderContent from "./header/headerContent";

// ==============================|| MAIN LAYOUT - HEADER ||============================== //

function Header({
  open,
  handleDrawerToggle,
}: {
  open: boolean;
  handleDrawerToggle: () => void;
}) {
  const theme = useTheme();
  const {
    features,
    workspace: workspaceResult,
    memberRoles,
  } = useAppStorePick(["features", "workspace", "memberRoles"]);
  const workspace =
    workspaceResult.type === CompletionStatus.Successful
      ? workspaceResult.value
      : null;
  const selection = useMemo(
    () => workspaceSelection(memberRoles, workspace),
    [memberRoles, workspace],
  );
  const { switchWorkspace, switchingWorkspace } = useWorkspaceSwitch();
  const parentWorkspaceId = workspace?.parentWorkspaceId
    ? selection.currentWorkspace?.id
    : undefined;
  const brandDestination =
    !workspace?.parentWorkspaceId || parentWorkspaceId ? "/workspace" : "/home";
  const whiteLabelConfig = useMemo(() => {
    if (!features.WhiteLabel) {
      return null;
    }
    return schemaValidateWithErr(
      features.WhiteLabel,
      WhiteLabelFeatureConfig,
    ).unwrapOr(null);
  }, [features.WhiteLabel]);

  return (
    <AppBar
      position="fixed"
      color="inherit"
      elevation={0}
      sx={{
        zIndex: theme.zIndex.drawer + 1,
        borderBottom: `1px solid ${theme.palette.divider}`,
        boxShadow: "none",
      }}
    >
      <Toolbar disableGutters sx={{ minHeight: 56, height: 56 }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            alignSelf: "stretch",
            gap: 1,
            width: { lg: drawerWidth },
            flexShrink: 0,
            boxSizing: "border-box",
            pl: { xs: 1, sm: 2 },
            pr: 1,
          }}
        >
          {!whiteLabelConfig ? (
            <ButtonBase
              {...(parentWorkspaceId
                ? {
                    onClick: () => {
                      void switchWorkspace(parentWorkspaceId, "/workspace");
                    },
                    disabled: switchingWorkspace,
                  }
                : {
                    component: WorkspaceLink,
                    href: brandDestination,
                    prefetch: false,
                  })}
              aria-label={
                parentWorkspaceId
                  ? "Open workspace dashboard"
                  : "Open dashboard"
              }
              aria-busy={switchingWorkspace}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                minWidth: 0,
                textAlign: "left",
                borderRadius: 1,
                color: "text.primary",
                "&.Mui-focusVisible": {
                  outline: "2px solid",
                  outlineColor: "primary.main",
                },
              }}
            >
              <Box
                component="img"
                src="/dashboard/branding/ronin/ronin-mark.png"
                alt="Ronin Publishing"
                sx={{
                  width: 28,
                  height: 32,
                  objectFit: "contain",
                  flexShrink: 0,
                }}
              />
              <Box
                component="span"
                sx={{ display: "flex", flexDirection: "column", gap: "2px" }}
              >
                <Typography
                  component="span"
                  sx={{
                    fontFamily: '"Avenir Next", Avenir, "Segoe UI", sans-serif',
                    fontSize: 22,
                    fontWeight: 800,
                    letterSpacing: "-0.055em",
                    lineHeight: 1,
                  }}
                >
                  DITTO
                </Typography>
                <Typography
                  component="span"
                  sx={{
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: "0.16em",
                    lineHeight: 1.2,
                    color: "text.secondary",
                    whiteSpace: "nowrap",
                  }}
                >
                  EMAIL CLIENT
                </Typography>
              </Box>
            </ButtonBase>
          ) : null}
          <IconButton
            aria-label={open ? "Close navigation" : "Open navigation"}
            aria-expanded={open}
            aria-controls="primary-navigation"
            onClick={handleDrawerToggle}
            color="secondary"
            sx={{
              color: "text.primary",
              ml: "auto",
              width: 32,
              height: 32,
              "&:hover": { bgcolor: "primary.lighter" },
              "&.Mui-focusVisible": {
                outline: "2px solid",
                outlineColor: "primary.main",
              },
            }}
          >
            {!open ? <MenuOutlined /> : <MenuOpenOutlined />}
          </IconButton>
        </Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            flexGrow: 1,
            minWidth: 0,
            gap: 1,
            px: { xs: 1, sm: 2, lg: 3 },
          }}
        >
          <HeaderContent />
        </Box>
      </Toolbar>
    </AppBar>
  );
}
export default Header;

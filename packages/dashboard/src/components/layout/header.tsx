// material-ui
// assets
import { MenuOpenOutlined, MenuOutlined } from "@mui/icons-material";
import {
  AppBar,
  Box,
  IconButton,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { WhiteLabelFeatureConfig } from "isomorphic-lib/src/types";
import { useMemo } from "react";

// project import
import { useAppStorePick } from "../../lib/appStore";
import { drawerWidth } from "../config";
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
  const { features } = useAppStorePick(["features"]);
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
        boxShadow: theme.customShadows.z1,
      }}
    >
      <Toolbar disableGutters>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            alignSelf: "stretch",
            gap: 1,
            width: { lg: drawerWidth },
            flexShrink: 0,
            boxSizing: "border-box",
            px: { xs: 1, sm: 2 },
            borderRight: { lg: 1 },
            borderColor: "divider",
          }}
        >
          {!whiteLabelConfig ? (
            <Stack
              direction={{ xs: "row", lg: "column" }}
              alignItems={{ xs: "center", lg: "flex-start" }}
              spacing={{ xs: 0.75, lg: 0.25 }}
            >
              <Box
                component="img"
                src="/dashboard/branding/ronin/ronin-mark.png"
                alt="Ronin Publishing"
                sx={{
                  display: { xs: "block", lg: "none" },
                  width: 24,
                  height: 24,
                  objectFit: "contain",
                }}
              />
              <Box
                component="img"
                src="/dashboard/branding/ronin/ronin-logo.png"
                alt="Ronin Publishing"
                sx={{
                  display: { xs: "none", lg: "block" },
                  width: 92,
                  height: "auto",
                }}
              />
              <Typography
                variant="subtitle1"
                sx={{
                  fontSize: { xs: "0.75rem", sm: "0.875rem" },
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                DITTO Email Client
              </Typography>
            </Stack>
          ) : null}
          <IconButton
            disableRipple
            aria-label={open ? "close drawer" : "open drawer"}
            onClick={handleDrawerToggle}
            color="secondary"
            sx={{
              color: "text.primary",
              bgcolor: open ? "grey.200" : "grey.100",
              ml: "auto",
              p: { xs: 0.75, lg: 1 },
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
            px: { xs: 0.5, sm: 2 },
          }}
        >
          <HeaderContent />
        </Box>
      </Toolbar>
    </AppBar>
  );
}
export default Header;

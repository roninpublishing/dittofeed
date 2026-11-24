import { Box, Drawer, Toolbar, useMediaQuery } from "@mui/material";
// material-ui
import { useTheme } from "@mui/material/styles";
import { useMemo } from "react";

import { drawerWidth } from "../config";
// project import
import DrawerContent from "./drawer/drawerContent";
import MiniDrawerStyled from "./drawer/miniDrawerStyled";

// ==============================|| MAIN LAYOUT - DRAWER ||============================== //

function MainDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const matchDownMD = useMediaQuery(theme.breakpoints.down("lg"));

  // responsive drawer container

  // header content
  const drawerContent = useMemo(() => <DrawerContent />, []);

  return (
    <Box
      component="nav"
      sx={{
        flexShrink: { md: 0 },
        zIndex: theme.zIndex.drawer,
      }}
      aria-label="Primary navigation"
    >
      {!matchDownMD ? (
        <MiniDrawerStyled
          id="primary-navigation"
          variant="permanent"
          open={open}
        >
          <Toolbar sx={{ flexShrink: 0, minHeight: 56 }} />
          {drawerContent}
        </MiniDrawerStyled>
      ) : (
        <Drawer
          id="primary-navigation"
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          container={global?.window.document.body}
          variant="temporary"
          open={open}
          onClose={onClose}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: "block", lg: "none" },
            zIndex: theme.zIndex.drawer,
            "& .MuiBackdrop-root": { top: 56 },
            "& .MuiDrawer-paper": {
              boxSizing: "border-box",
              width: drawerWidth,
              top: 56,
              height: "calc(100% - 56px)",
              borderRight: `1px solid ${theme.palette.divider}`,
              backgroundImage: "none",
              boxShadow: "none",
            },
          }}
        >
          {open && drawerContent}
        </Drawer>
      )}
    </Box>
  );
}

export default MainDrawer;

// material-ui
import { Box, Toolbar, useMediaQuery, useTheme } from "@mui/material";
import { useRouter } from "next/router";
import React, { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../lib/appStore";
import { LayoutContext, LayoutContextValues } from "./layout/context";
// project import
import Drawer from "./layout/drawer";
import Header from "./layout/header";

function Layout({
  items,
  children,
  navigationRenderer,
  backLink,
  pageTitle,
}: {
  children?: React.ReactElement | null;
} & LayoutContextValues) {
  const drawerOpen = useAppStore((state) => state.drawerOpen);
  const toggleDrawer = useAppStore((state) => state.toggleDrawer);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("lg"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const open = isMobile ? mobileOpen : drawerOpen;
  const router = useRouter();

  useEffect(() => {
    const closeMobileNavigation = () => setMobileOpen(false);
    router.events.on("routeChangeComplete", closeMobileNavigation);
    return () =>
      router.events.off("routeChangeComplete", closeMobileNavigation);
  }, [router.events]);

  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  const handleDrawerToggle = () => {
    if (isMobile) {
      setMobileOpen((previous) => !previous);
    } else {
      toggleDrawer();
    }
  };
  const layoutProps = useMemo(
    () => ({
      items,
      navigationRenderer,
      backLink,
      pageTitle,
    }),
    [items, navigationRenderer, backLink, pageTitle],
  );

  return (
    <LayoutContext.Provider value={layoutProps}>
      <Box
        sx={{
          display: "flex",
          width: "100%",
          height: "100dvh",
          overflow: "hidden",
        }}
      >
        <Header open={open} handleDrawerToggle={handleDrawerToggle} />
        <Drawer open={open} onClose={() => setMobileOpen(false)} />
        <Box
          component="main"
          sx={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            flexGrow: 1,
            height: "100%",
            minWidth: 0,
          }}
        >
          <Toolbar />

          <Box
            id="layout-contents"
            sx={{
              display: "flex",
              alignItems: "stretch",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              minHeight: 0,
            }}
          >
            {children}
          </Box>
        </Box>
      </Box>
    </LayoutContext.Provider>
  );
}

export default Layout;

import { Box } from "@mui/material";

import NavCard from "./drawerContent/navCard";
import Navigation from "./drawerContent/navigation";

// ==============================|| DRAWER CONTENT ||============================== //

function DrawerContent() {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        overflowX: "hidden",
        overscrollBehavior: "contain",
      }}
    >
      <NavCard showDefault={false} />
      <Navigation />
    </Box>
  );
}

export default DrawerContent;

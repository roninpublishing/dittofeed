// material-ui
import { styled } from "@mui/material/styles";
import Drawer from "@mui/material/Drawer";

// project import
import { drawerWidth } from "../../config";

const openedMixin = (theme) => ({
  width: drawerWidth,
  visibility: "visible",
  borderRight: `1px solid ${theme.palette.divider}`,
  overflowX: "hidden",
  boxShadow: "none",
});

const closedMixin = () => ({
  overflowX: "hidden",
  visibility: "hidden",
  width: 0,
  borderRight: "none",
  boxShadow: "none",
});

// ==============================|| DRAWER - MINI STYLED ||============================== //

const MiniDrawerStyled = styled(Drawer, {
  shouldForwardProp: (prop) => prop !== "open",
})(({ theme, open }) => ({
  width: drawerWidth,
  flexShrink: 0,
  whiteSpace: "nowrap",
  boxSizing: "border-box",
  ...(open && {
    ...openedMixin(theme),
    "& .MuiDrawer-paper": openedMixin(theme),
  }),
  ...(!open && {
    ...closedMixin(),
    "& .MuiDrawer-paper": closedMixin(),
  }),
}));

export default MiniDrawerStyled;

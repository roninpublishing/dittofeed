// material-ui
import { alpha, Theme } from "@mui/material/styles";

// ==============================|| DEFAULT THEME - CUSTOM SHADOWS  ||============================== //

const CustomShadows = (theme: Theme) => ({
  button: `0 1px 2px ${alpha(theme.palette.grey[900], 0.06)}`,
  text: "none",
  z1: `0 4px 16px ${alpha(theme.palette.grey[900], 0.08)}`,
  inset:
    "inset 0px 2px 1px -1px rgb(0 0 0 / 20%), inset 0px 1px 1px 0px rgb(0 0 0 / 14%), inset 0px 1px 3px 0px rgb(0 0 0 / 12%)",
});

export default CustomShadows;

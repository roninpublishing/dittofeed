// material-ui
import { createTheme } from "@mui/material/styles";

// third-party
import { presetPalettes } from "@ant-design/colors";

// project import
import ThemeOption from "./theme";

// ==============================|| DEFAULT THEME - PALETTE  ||============================== //

const grey = [
  "#FFFFFF",
  "#FAF8F6",
  "#F3EFEC",
  "#E4DDD8",
  "#C6BDB8",
  "#9E9590",
  "#706865",
  "#554D4A",
  "#302A28",
  "#231F1D",
  "#161312",
  "#FAF8F6",
  "#C6BDB8",
  "#443C38",
  "#231F1D",
  "#FAF8F6",
  "#EAE4DF",
];

const burgundy = [
  "#FBF1F4",
  "#F3DFE5",
  "#E4B8C5",
  "#D693A7",
  "#B34261",
  "#9C1235",
  "#650B2B",
  "#550118",
  "#34000F",
  "#24000B",
];

const colors = { ...presetPalettes, grey, burgundy };

const Palette = (mode) => {
  const paletteColor = ThemeOption(colors);

  return createTheme({
    palette: {
      mode,
      common: {
        black: "#000",
        white: "#fff",
      },
      ...paletteColor,
      text: {
        primary: paletteColor.grey[700],
        secondary: paletteColor.grey[500],
        disabled: paletteColor.grey[400],
      },
      action: {
        disabled: paletteColor.grey[400],
        disabledBackground: paletteColor.grey[100],
        hover: "rgba(48, 42, 40, 0.04)",
        selected: "rgba(156, 18, 53, 0.08)",
        focus: "rgba(156, 18, 53, 0.12)",
      },
      divider: paletteColor.grey[200],
      background: {
        paper: paletteColor.grey[0],
        default: paletteColor.grey.A50,
      },
    },
  });
};

export default Palette;

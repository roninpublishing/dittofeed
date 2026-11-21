// ==============================|| PRESET THEME - THEME SELECTOR ||============================== //

const Theme = (colors) => {
  const { blue, burgundy, red, gold, cyan, green, grey } = colors;
  const greyColors = {
    0: grey[0],
    50: grey[1],
    100: grey[2],
    200: grey[3],
    300: grey[4],
    400: grey[5],
    500: grey[6],
    600: grey[7],
    700: grey[8],
    800: grey[9],
    900: grey[10],
    A50: grey[15],
    A100: grey[11],
    A200: grey[12],
    A400: grey[13],
    A700: grey[14],
    A800: grey[16],
  };
  const contrastText = "#fff";

  return {
    primary: {
      lighter: burgundy[0],
      100: burgundy[1],
      200: burgundy[2],
      light: burgundy[3],
      400: burgundy[4],
      main: burgundy[5],
      dark: burgundy[6],
      700: burgundy[7],
      darker: burgundy[8],
      900: burgundy[9],
      contrastText,
    },
    blue: {
      default: blue[6],
      100: blue[1],
      200: blue[2],
      300: blue[3],
    },
    secondary: {
      lighter: greyColors[100],
      100: greyColors[100],
      200: greyColors[200],
      light: greyColors[300],
      400: greyColors[400],
      main: greyColors[500],
      600: greyColors[600],
      dark: greyColors[700],
      800: greyColors[800],
      darker: greyColors[900],
      A100: greyColors[0],
      A200: greyColors.A400,
      A300: greyColors.A700,
      contrastText: greyColors[0],
    },
    error: {
      lighter: red[0],
      light: red[2],
      main: red[7],
      dark: red[8],
      darker: red[9],
      contrastText,
    },

    warning: {
      postIt: "#FFFAE5",
      postItContrastText: "#8B6F03",
      lighter: gold[0],
      light: gold[3],
      main: gold[5],
      dark: gold[7],
      darker: gold[9],
      contrastText: greyColors[800],
    },
    info: {
      lighter: cyan[0],
      light: cyan[3],
      main: cyan[7],
      dark: cyan[8],
      darker: cyan[9],
      contrastText,
    },
    success: {
      lighter: green[0],
      light: green[3],
      main: green[7],
      dark: green[8],
      darker: green[9],
      contrastText,
    },
    grey: greyColors,
  };
};

export default Theme;

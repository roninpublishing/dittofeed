import { useMemo } from "react";

// material-ui
import { CssBaseline } from "@mui/material";
import { createTheme, ThemeProvider } from "@mui/material/styles";

// project import
import Palette from "./palette";
import Typography from "./typography";
import CustomShadows from "./shadows";
import componentsOverride from "./overrides";

// ==============================|| DEFAULT THEME - MAIN  ||============================== //

export default function ThemeCustomization({ children }) {
  const theme = useMemo(() => Palette("light"), []);

  const themeTypography = useMemo(
    () =>
      Typography(
        "Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,Noto Sans,sans-serif,Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol,Noto Color Emoji",
      ),
    [],
  );

  const themeCustomShadows = useMemo(() => CustomShadows(theme), [theme]);

  const themeOptions = useMemo(
    () => ({
      breakpoints: {
        values: {
          xs: 0,
          sm: 768,
          md: 1024,
          lg: 1266,
          xl: 1536,
        },
      },
      direction: "ltr",
      mixins: {
        toolbar: {
          minHeight: 56,
          paddingTop: 0,
          paddingBottom: 0,
        },
      },
      palette: theme.palette,
      shape: {
        borderRadius: 8,
      },
      customShadows: themeCustomShadows,
      typography: themeTypography,
    }),
    [theme, themeTypography, themeCustomShadows],
  );

  const themes = useMemo(() => {
    const nextTheme = createTheme(themeOptions);
    nextTheme.components = componentsOverride(nextTheme);
    return nextTheme;
  }, [themeOptions]);

  return (
    <ThemeProvider theme={themes}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}

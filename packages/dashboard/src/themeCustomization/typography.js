// ==============================|| DEFAULT THEME - TYPOGRAPHY  ||============================== //

const Typography = (fontFamily) => ({
  htmlFontSize: 16,
  fontSize: 14,
  fontFamily,
  fontWeightLight: 300,
  fontWeightRegular: 400,
  fontWeightMedium: 500,
  fontWeightBold: 600,
  h1: {
    fontWeight: 600,
    fontSize: "1.875rem",
    lineHeight: 1.2,
    letterSpacing: "-0.025em",
  },
  h2: {
    fontWeight: 600,
    fontSize: "1.5rem",
    lineHeight: 1.3,
    letterSpacing: "-0.02em",
  },
  h3: {
    fontWeight: 600,
    fontSize: "1.25rem",
    lineHeight: 1.4,
    letterSpacing: "-0.015em",
  },
  h4: {
    fontWeight: 600,
    fontSize: "1.125rem",
    lineHeight: 1.4,
    letterSpacing: "-0.01em",
  },
  h5: {
    fontWeight: 600,
    fontSize: "0.9375rem",
    lineHeight: 1.4,
  },
  h6: {
    fontWeight: 600,
    fontSize: "0.875rem",
    lineHeight: 1.45,
  },
  caption: {
    fontWeight: 400,
    fontSize: "0.75rem",
    lineHeight: 1.45,
  },
  body1: {
    fontSize: "0.875rem",
    lineHeight: 1.45,
  },
  body2: {
    fontSize: "0.875rem",
    lineHeight: 1.45,
  },
  subtitle1: {
    fontSize: "0.875rem",
    fontWeight: 600,
    lineHeight: 1.45,
  },
  subtitle2: {
    fontSize: "0.8125rem",
    fontWeight: 500,
    lineHeight: 1.45,
  },
  overline: {
    lineHeight: 1.66,
  },
  button: {
    textTransform: "none",
    fontWeight: 600,
    lineHeight: 1.5,
  },
});

export default Typography;

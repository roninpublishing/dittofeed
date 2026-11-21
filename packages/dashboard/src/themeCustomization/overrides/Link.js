// ==============================|| OVERRIDES - LINK ||============================== //

export default function Link(theme) {
  return {
    MuiLink: {
      defaultProps: {
        underline: "hover",
      },
      styleOverrides: {
        root: {
          textUnderlineOffset: "0.2em",
          "&:focus-visible": {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: 3,
            borderRadius: 2,
          },
        },
      },
    },
  };
}

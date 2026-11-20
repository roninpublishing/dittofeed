// ==============================|| OVERRIDES - BUTTON BASE ||============================== //

export default function ButtonBase(theme) {
  return {
    MuiButtonBase: {
      styleOverrides: {
        root: {
          "&.Mui-focusVisible": {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: 3,
          },
        },
      },
    },
  };
}

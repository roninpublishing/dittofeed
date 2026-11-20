// ==============================|| OVERRIDES - BUTTON ||============================== //

export default function Button(theme) {
  const disabledStyle = {
    "&.Mui-disabled": {
      backgroundColor: theme.palette.action.disabledBackground,
      color: theme.palette.text.disabled,
    },
  };

  return {
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: theme.shape.borderRadius,
          padding: "8px 16px",
          transition: theme.transitions.create(
            ["background-color", "border-color", "box-shadow"],
            { duration: theme.transitions.duration.short },
          ),
        },
        contained: {
          ...disabledStyle,
        },
        outlined: {
          ...disabledStyle,
        },
        sizeSmall: {
          padding: "5px 12px",
        },
        sizeLarge: {
          padding: "11px 20px",
        },
      },
    },
  };
}

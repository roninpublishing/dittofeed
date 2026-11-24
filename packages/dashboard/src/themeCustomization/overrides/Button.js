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
        size: "small",
      },
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: theme.shape.borderRadius,
          minHeight: 32,
          padding: "6px 12px",
          transition: theme.transitions.create(
            ["background-color", "border-color", "box-shadow"],
            { duration: theme.transitions.duration.shortest },
          ),
        },
        contained: {
          ...disabledStyle,
        },
        outlined: {
          ...disabledStyle,
        },
        sizeSmall: {
          padding: "5px 10px",
        },
        sizeLarge: {
          padding: "9px 16px",
        },
      },
    },
  };
}

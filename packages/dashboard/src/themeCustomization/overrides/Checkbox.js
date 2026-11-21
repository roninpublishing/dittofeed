// ==============================|| OVERRIDES - CHECKBOX ||============================== //

export default function Checkbox(theme) {
  return {
    MuiCheckbox: {
      styleOverrides: {
        root: {
          color: theme.palette.grey[500],
        },
      },
    },
  };
}

// ==============================|| OVERRIDES - CARD ||============================== //

export default function Card(theme) {
  return {
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: theme.palette.background.paper,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: theme.shape.borderRadius,
          boxShadow: "none",
        },
      },
    },
  };
}

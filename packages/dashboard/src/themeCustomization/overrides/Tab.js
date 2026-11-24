// ==============================|| OVERRIDES - TAB ||============================== //

export default function Tab(theme) {
  return {
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 40,
          padding: "8px 16px",
          color: theme.palette.text.secondary,
          fontWeight: 500,
          "&.Mui-selected": {
            fontWeight: 600,
          },
        },
      },
    },
  };
}

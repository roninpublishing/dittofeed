// ==============================|| OVERRIDES - TABLE CELL ||============================== //

export default function TableCell(theme) {
  return {
    MuiTable: {
      defaultProps: { size: "small" },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          fontSize: "0.875rem",
          padding: "8px 12px",
          borderColor: theme.palette.divider,
        },
        head: {
          fontWeight: 600,
          color: theme.palette.text.secondary,
          backgroundColor: theme.palette.grey[50],
          paddingTop: 10,
          paddingBottom: 10,
        },
        sizeSmall: {
          padding: "8px 12px",
        },
      },
    },
  };
}

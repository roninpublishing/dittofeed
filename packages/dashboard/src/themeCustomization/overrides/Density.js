export default function Density(theme) {
  return {
    MuiToolbar: {
      styleOverrides: {
        root: {
          minHeight: 56,
          flexShrink: 0,
          [theme.breakpoints.up("sm")]: { minHeight: 56 },
        },
      },
    },
    MuiCardHeader: {
      styleOverrides: {
        root: { padding: theme.spacing(2) },
        action: { margin: 0, alignSelf: "center" },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          padding: theme.spacing(2),
          fontSize: theme.typography.h4.fontSize,
        },
      },
    },
    MuiDialogContent: {
      styleOverrides: {
        root: { padding: theme.spacing(2) },
      },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: {
          padding: theme.spacing(1.5, 2),
          gap: theme.spacing(1),
          "& > :not(:first-of-type)": { marginLeft: 0 },
        },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          boxShadow: "none",
          "&.Mui-expanded": { margin: 0 },
        },
      },
    },
    MuiAccordionSummary: {
      styleOverrides: {
        root: {
          minHeight: 40,
          padding: theme.spacing(0, 2),
          "&.Mui-expanded": { minHeight: 40 },
        },
        content: {
          margin: theme.spacing(1.25, 0),
          "&.Mui-expanded": { margin: theme.spacing(1.25, 0) },
        },
      },
    },
    MuiAccordionDetails: {
      styleOverrides: {
        root: { padding: theme.spacing(0, 2, 2) },
      },
    },
    MuiMenuItem: {
      defaultProps: { dense: true },
      styleOverrides: {
        root: {
          minHeight: 36,
          [theme.breakpoints.up("sm")]: { minHeight: 36 },
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { padding: theme.spacing(0.5, 1.5), alignItems: "center" },
      },
    },
  };
}

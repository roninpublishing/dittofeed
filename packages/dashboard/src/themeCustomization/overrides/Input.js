import { alpha } from "@mui/material/styles";

// ==============================|| OVERRIDES - INPUT ||============================== //

export default function Input(theme) {
  return {
    MuiTextField: {
      defaultProps: { size: "small" },
    },
    MuiFormControl: {
      defaultProps: { size: "small" },
    },
    MuiSelect: {
      defaultProps: { size: "small" },
    },
    MuiAutocomplete: {
      defaultProps: { size: "small" },
    },
    MuiInputBase: {
      styleOverrides: {
        input: {
          "&::placeholder": {
            color: theme.palette.text.secondary,
            opacity: 1,
          },
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ ownerState }) => ({
          backgroundColor: theme.palette.background.paper,
          borderRadius: theme.shape.borderRadius,
          "&:hover:not(.Mui-disabled):not(.Mui-focused):not(.Mui-error) .MuiOutlinedInput-notchedOutline":
            {
              borderColor: theme.palette.grey[500],
            },
          "&.Mui-focused": {
            boxShadow: `0 0 0 3px ${alpha(
              theme.palette[
                ownerState.error ? "error" : ownerState.color || "primary"
              ].main,
              0.12,
            )}`,
          },
          "&.Mui-disabled": {
            backgroundColor: theme.palette.action.disabledBackground,
          },
        }),
        notchedOutline: {
          borderColor: theme.palette.grey[300],
        },
      },
    },
  };
}

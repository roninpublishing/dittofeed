import {
  Button,
  ButtonProps,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import { useId, useState } from "react";

interface AccountConfirmationButtonProps extends Omit<ButtonProps, "onClick"> {
  confirmationTitle: string;
  confirmationMessage: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
}

export default function AccountConfirmationButton({
  confirmationTitle,
  confirmationMessage,
  confirmLabel,
  pending = false,
  onConfirm,
  children,
  disabled,
  color = "primary",
  ...buttonProps
}: AccountConfirmationButtonProps) {
  const [open, setOpen] = useState(false);
  const isDisabled = disabled === true || pending;
  const id = useId();
  const titleId = `${id}-title`;
  const messageId = `${id}-message`;
  const close = () => setOpen(false);

  return (
    <>
      <Button
        {...buttonProps}
        type="button"
        color={color}
        disabled={isDisabled}
        onClick={() => setOpen(true)}
      >
        {children}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <DialogTitle id={titleId}>{confirmationTitle}</DialogTitle>
        <DialogContent>
          <DialogContentText id={messageId}>
            {confirmationMessage}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button type="button" onClick={close} autoFocus>
            Cancel
          </Button>
          <Button
            type="button"
            color={color}
            variant="contained"
            disabled={isDisabled}
            onClick={() => {
              close();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

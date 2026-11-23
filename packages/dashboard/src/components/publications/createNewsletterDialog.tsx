import { ExpandMoreOutlined } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import axios from "axios";
import { useState } from "react";

export default function CreateNewsletterDialog({
  workspaceId,
  apiBase,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  apiBase: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [customSlug, setCustomSlug] = useState<string | null>(null);
  const [customize, setCustomize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug =
    customSlug ??
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  return (
    <Dialog open fullWidth maxWidth="sm" onClose={busy ? undefined : onClose}>
      <Box
        component="form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!slug) {
            setCustomize(true);
            setError("Choose a sending ID using letters and numbers.");
            return;
          }
          setBusy(true);
          setError(null);
          try {
            await axios.post(`${apiBase}/api/publications/`, {
              workspaceId,
              name: name.trim(),
              slug,
            });
            await onCreated();
          } catch (failure) {
            const message = axios.isAxiosError<{ message?: string }>(failure)
              ? failure.response?.data?.message
              : undefined;
            setError(
              typeof message === "string"
                ? message
                : "Could not create the newsletter.",
            );
            setCustomize(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <DialogTitle>New newsletter</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography color="text.secondary">
              Give it a name. You can set up sending when you’re ready.
            </Typography>
            <TextField
              autoFocus
              required
              fullWidth
              label="Newsletter name"
              placeholder="e.g. Morning Brief"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            <Box>
              <Button
                size="small"
                color="inherit"
                startIcon={<ExpandMoreOutlined />}
                aria-expanded={customize}
                onClick={() => setCustomize(!customize)}
              >
                Customize sending ID
              </Button>
              <Collapse in={customize}>
                <TextField
                  fullWidth
                  label="Sending ID"
                  value={slug}
                  disabled={busy}
                  sx={{ mt: 2 }}
                  onChange={(event) => setCustomSlug(event.target.value)}
                  helperText="Letters, numbers and hyphens. Used for the sending account; cannot be changed later."
                />
              </Collapse>
            </Box>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button onClick={onClose} disabled={busy} color="inherit">
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {busy ? "Creating…" : "Create newsletter"}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

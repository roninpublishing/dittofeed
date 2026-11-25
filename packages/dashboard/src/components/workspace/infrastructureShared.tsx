import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import axios from "axios";
import { FormEvent, ReactNode, useState } from "react";

import {
  errorText,
  record,
  RecordValue,
  rows,
  text,
} from "../publications/settingsShared";

export interface InfrastructureProps {
  workspaceId: string;
  apiBase: string;
  infrastructure: RecordValue;
  onComplete: () => Promise<void>;
  accountId?: string;
  resourceId?: string;
  kind?: "ips" | "pools";
}

export const providers = {
  SendGrid: {
    label: "SendGrid",
    domains: true,
    ips: true,
    pools: true,
    webhook: true,
  },
};

export function strings(input: unknown): string[] {
  return Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string")
    : [];
}

export function list(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function date(input: unknown): string {
  if (typeof input !== "string") return "Unknown";
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

export function value(input: unknown): string {
  return input === undefined || input === null ? "Unknown" : text(input);
}

export function Readiness({ account }: { account: RecordValue }) {
  const provisioning = record(account.provisioning);
  const checked = typeof provisioning.inspectedAt === "string";
  let label = "Not checked";
  if (checked)
    label = provisioning.ready === true ? "Verified" : "Needs attention";
  return (
    <Chip
      size="small"
      color={checked && provisioning.ready === true ? "success" : "default"}
      label={label}
    />
  );
}

export function DataTable({
  label,
  columns,
  data,
}: {
  label: string;
  columns: { label: string; render: (item: RecordValue) => ReactNode }[];
  data: RecordValue[];
}) {
  return (
    <TableContainer sx={{ maxWidth: "100%", overflowX: "auto" }}>
      <Table size="small" aria-label={label} sx={{ minWidth: 520 }}>
        <TableHead>
          <TableRow>
            {columns.map((column) => (
              <TableCell key={column.label}>{column.label}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {data.map((item, index) => (
            <TableRow key={text(item.id ?? index)}>
              {columns.map((column, columnIndex) => (
                <TableCell
                  key={column.label}
                  component={columnIndex === 0 ? "th" : "td"}
                  scope={columnIndex === 0 ? "row" : undefined}
                  sx={{ maxWidth: 360, overflowWrap: "anywhere" }}
                >
                  {column.render(item)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {!data.length && (
            <TableRow>
              <TableCell colSpan={columns.length}>No records</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function DnsRecords({ domains }: { domains: RecordValue[] }) {
  return (
    <Stack spacing={2}>
      {domains.length ? (
        domains.map((domain) => (
          <Stack
            key={`${text(domain.domain)}-${text(domain.subdomain)}`}
            spacing={1}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle2">{text(domain.domain)}</Typography>
              <Chip
                size="small"
                label={domain.valid === true ? "Verified" : "Not verified"}
                color={domain.valid === true ? "success" : "default"}
              />
            </Stack>
            <DataTable
              label={`DNS records for ${text(domain.domain)}`}
              data={rows(domain.dns)}
              columns={[
                { label: "Type", render: (item) => text(item.type) },
                { label: "Host", render: (item) => text(item.host) },
                {
                  label: "Value",
                  render: (item) => (
                    <Box component="code" sx={{ overflowWrap: "anywhere" }}>
                      {text(item.data)}
                    </Box>
                  ),
                },
                {
                  label: "Status",
                  render: (item) => (item.valid === true ? "Valid" : "Pending"),
                },
              ]}
            />
          </Stack>
        ))
      ) : (
        <Typography color="text.secondary">No domain observations</Typography>
      )}
    </Stack>
  );
}

export function EditorDialog({
  title,
  action = "Save",
  children,
  onSubmit,
  onClose,
  disabled = false,
  confirmation,
}: {
  title: string;
  action?: string;
  children: ReactNode;
  onSubmit: () => Promise<void>;
  onClose: () => void;
  disabled?: boolean;
  confirmation?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (confirmation && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (failure) {
      setError(
        failure instanceof Error && !axios.isAxiosError(failure)
          ? failure.message
          : errorText(failure),
      );
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  let actionLabel = action;
  if (confirming) actionLabel = `Confirm ${action.toLowerCase()}`;
  if (busy) actionLabel = "Saving…";
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      aria-labelledby="infrastructure-editor-title"
      onClose={busy ? undefined : onClose}
    >
      <Box
        component="form"
        onSubmit={submit}
        sx={{
          display: "flex",
          flexDirection: "column",
          maxHeight: "calc(100dvh - 64px)",
        }}
      >
        <DialogTitle id="infrastructure-editor-title">
          {confirming ? `Confirm ${action.toLowerCase()}` : title}
        </DialogTitle>
        <DialogContent sx={{ minHeight: 0 }}>
          <Box
            component="fieldset"
            disabled={busy}
            sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}
          >
            <Stack spacing={2} sx={{ pt: 1 }}>
              {confirming ? (
                <Alert severity="warning">{confirmation}</Alert>
              ) : (
                children
              )}
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {confirming && (
            <Button disabled={busy} onClick={() => setConfirming(false)}>
              Back
            </Button>
          )}
          <Button variant="contained" type="submit" disabled={busy || disabled}>
            {actionLabel}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import type {
  NewsletterTrackingDomain,
  NewsletterTrackingResponse,
} from "isomorphic-lib/src/publications";
import { useEffect, useState } from "react";

import { errorText, Option } from "./settingsShared";

function DomainStatus({
  domain,
  cnameTarget,
}: {
  domain: NewsletterTrackingDomain;
  cnameTarget: string | null;
}) {
  const records = [...domain.dnsRecords];
  if (
    !records.some(
      (item) => item.type === "CNAME" && item.name === domain.hostname,
    )
  ) {
    records.unshift({
      type: "CNAME",
      name: domain.hostname,
      value: cnameTarget ?? "Not configured",
    });
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography fontWeight={600}>{domain.hostname}</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={domain.isCurrent ? "Current" : "Historical"}
          />
          <Chip size="small" variant="outlined" label={domain.status} />
        </Stack>
        <Typography variant="body2">
          Hostname: {domain.cloudflareStatus ?? "Not provisioned"} · TLS:{" "}
          {domain.sslStatus ?? "Not provisioned"} · CNAME:{" "}
          {domain.cnameVerified ? "Verified" : "Not verified"}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Last checked: {domain.lastCheckedAt ?? "Never"}
        </Typography>
        <Box sx={{ overflowX: "auto" }}>
          <Table
            size="small"
            aria-label={`DNS requirements for ${domain.hostname}`}
          >
            <TableHead>
              <TableRow>
                <TableCell>Type</TableCell>
                <TableCell>Host</TableCell>
                <TableCell>Value</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {records.map((item) => (
                <TableRow
                  key={JSON.stringify([item.type, item.name, item.value])}
                >
                  <TableCell>
                    {item.type === "CNAME" ? "CNAME (DNS only)" : item.type}
                  </TableCell>
                  <TableCell sx={{ overflowWrap: "anywhere" }}>
                    {item.name}
                  </TableCell>
                  <TableCell sx={{ overflowWrap: "anywhere" }}>
                    {item.value}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </Stack>
    </Paper>
  );
}

export function NewsletterDomainSetup({
  workspaceId,
  apiBase,
  newsletterId,
  newsletterName,
  selectedHostname,
  onComplete,
}: {
  workspaceId: string;
  apiBase: string;
  newsletterId: string;
  newsletterName: string;
  selectedHostname?: string;
  onComplete?: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const endpoint = `${apiBase}/api/publications/tracking-domains`;
  const queryKey = [
    "publication-management",
    apiBase,
    workspaceId,
    "tracking-domains",
    newsletterId,
  ];
  const configuration = useQuery({
    queryKey,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<NewsletterTrackingResponse>(endpoint, {
        params: { workspaceId, newsletterId },
        signal,
      });
      return response.data.data;
    },
  });
  const current = configuration.data?.domains.find(
    (item) => item.newsletterId === newsletterId && item.isCurrent,
  );
  const selected = configuration.data?.domains.find(
    (item) =>
      item.newsletterId === newsletterId && item.hostname === selectedHostname,
  );
  const historical = selected?.isCurrent === false;
  const unavailable = !!selectedHostname && !!configuration.data && !selected;
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState<"save" | "provision" | "verify" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmProvision, setConfirmProvision] = useState(false);
  useEffect(() => {
    setDomain(current?.domain ?? "");
  }, [current?.domain, newsletterId]);
  const normalized = domain.trim().toLowerCase();
  const locked = configuration.isFetching || busy !== null;
  const unsaved = normalized !== (current?.domain ?? "");
  const run = async (action: "save" | "provision" | "verify") => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const identity = { workspaceId, newsletterId };
      const response =
        action === "save"
          ? await axios.put<NewsletterTrackingResponse>(endpoint, {
              ...identity,
              domain: normalized,
            })
          : await axios.post<NewsletterTrackingResponse>(
              `${endpoint}/${action}`,
              identity,
            );
      queryClient.setQueryData(queryKey, response.data.data);
      setConfirmProvision(false);
      await onComplete?.();
      const notices = {
        save: "Saved locally.",
        verify: "Status checked.",
        provision: "Provisioning completed.",
      };
      setNotice(notices[action]);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h6">Tracking · {newsletterName}</Typography>
        <Button disabled={locked} onClick={() => void configuration.refetch()}>
          Refresh
        </Button>
        {configuration.isFetching && (
          <CircularProgress size={18} aria-label="Loading tracking domain" />
        )}
      </Stack>
      {(error || configuration.error) && (
        <Alert severity="error">
          {error ?? errorText(configuration.error)}
        </Alert>
      )}
      {notice && <Alert severity="success">{notice}</Alert>}
      {unavailable && (
        <Alert severity="warning">Domain no longer available</Alert>
      )}
      {!unavailable && historical && (
        <Alert severity="warning">
          Keep historical DNS and HTTPS service active.
        </Alert>
      )}
      {!unavailable && !historical && configuration.data && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack
            component="form"
            spacing={1.5}
            onSubmit={(event) => {
              event.preventDefault();
              void run("save");
            }}
          >
            <TextField
              size="small"
              label="Newsletter base domain"
              placeholder="brand.example"
              value={domain}
              onChange={(event) => {
                setDomain(event.target.value);
                setConfirmProvision(false);
              }}
              disabled={locked}
              required
              inputProps={{ maxLength: 250 }}
            />
            <Typography variant="body2" color="text.secondary">
              {normalized ? `dt.${normalized}` : "dt.<newsletter-domain>"}
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Button
                type="submit"
                variant="contained"
                disabled={locked || !normalized || !unsaved}
              >
                Save locally
              </Button>
              <Button
                disabled={
                  locked ||
                  !current ||
                  unsaved ||
                  !configuration.data.configured
                }
                onClick={() => void run("verify")}
              >
                Check DNS &amp; TLS
              </Button>
              <Button
                disabled={
                  locked ||
                  !current ||
                  unsaved ||
                  !configuration.data.configured ||
                  !configuration.data.provisioningEnabled
                }
                onClick={() => setConfirmProvision(true)}
              >
                Provision
              </Button>
            </Stack>
          </Stack>
        </Paper>
      )}
      {confirmProvision && (
        <Alert
          severity="warning"
          action={
            <Button
              disabled={
                locked ||
                unavailable ||
                historical ||
                unsaved ||
                !current ||
                !configuration.data?.configured ||
                !configuration.data.provisioningEnabled
              }
              onClick={() => void run("provision")}
            >
              Confirm provision
            </Button>
          }
          onClose={() => setConfirmProvision(false)}
        >
          Create or adopt this hostname in Cloudflare?
        </Alert>
      )}
      {(selected
        ? [selected]
        : configuration.data?.domains.filter(
            (item) => item.newsletterId === newsletterId,
          ) ?? []
      ).map((item) => (
        <DomainStatus
          key={item.id}
          domain={item}
          cnameTarget={configuration.data?.cnameTarget ?? null}
        />
      ))}
    </Stack>
  );
}

export default function TrackingDomains({
  workspaceId,
  apiBase,
  newsletters,
  onComplete,
}: {
  workspaceId: string;
  apiBase: string;
  newsletters: Option[];
  onComplete?: () => Promise<void>;
}) {
  const [newsletterId, setNewsletterId] = useState("");
  const selected = newsletters.find((item) => item.value === newsletterId);
  return (
    <Stack spacing={2}>
      <TextField
        size="small"
        select
        label="Newsletter"
        value={selected?.value ?? ""}
        onChange={(event) => setNewsletterId(event.target.value)}
      >
        <MenuItem value="">Choose a newsletter</MenuItem>
        {newsletters.map((item) => (
          <MenuItem key={item.value} value={item.value}>
            {item.label}
          </MenuItem>
        ))}
      </TextField>
      {selected && (
        <NewsletterDomainSetup
          key={`${workspaceId}:${selected.value}`}
          workspaceId={workspaceId}
          apiBase={apiBase}
          newsletterId={selected.value}
          newsletterName={selected.label}
          onComplete={onComplete}
        />
      )}
    </Stack>
  );
}

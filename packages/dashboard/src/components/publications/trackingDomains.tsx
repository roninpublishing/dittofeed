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
import axios from "axios";
import { useCallback, useEffect, useState } from "react";

interface NewsletterOption {
  value: string;
  label: string;
}
interface DnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
}
interface TrackingDomain {
  id: string;
  newsletterId: string;
  domain: string;
  hostname: string;
  isCurrent: boolean;
  status: "pending" | "active";
  cloudflareStatus: string | null;
  sslStatus: string | null;
  lastCheckedAt: string | null;
  dnsRecords: DnsRecord[];
}
interface TrackingConfiguration {
  domains: TrackingDomain[];
  cnameTarget: string | null;
  provisioningEnabled: boolean;
  configured: boolean;
}

function operationError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data: unknown = error.response?.data;
    const messages: Record<string, string> = {
      tracking_domain_invalid:
        "Enter a valid newsletter base domain, without a URL scheme, path, or dt. prefix.",
      tracking_hostname_owned:
        "This tracking hostname already belongs to a different newsletter and cannot be reassigned.",
      tracking_domain_not_configured:
        "Save a current tracking domain for this newsletter first.",
      tracking_provisioning_disabled:
        "Cloudflare provisioning is disabled by the server release gate.",
      tracking_provider_not_configured:
        "The deployment operator must configure Cloudflare provider access and the SaaS CNAME target.",
      tracking_configuration_changed:
        "The current domain changed during this operation. Refresh its status before trying again.",
      tracking_provider_failed:
        "Cloudflare status could not be read or updated. No active status can be assumed; refresh and try again.",
      newsletter_not_found:
        "This newsletter no longer exists or is not managed by this workspace.",
    };
    if (
      data &&
      typeof data === "object" &&
      "code" in data &&
      typeof data.code === "string"
    ) {
      const message = messages[data.code];
      if (message) return message;
    }
    if (
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof data.message === "string"
    ) {
      return data.message.slice(0, 512);
    }
    if (error.response?.status === 403)
      return "Workspace management permission is required.";
    if (error.response?.status === 401)
      return "Your session has expired. Sign in again.";
    if (!error.response)
      return "The tracking-domain service could not be reached. Try again.";
  }
  return "The tracking-domain operation failed. Refresh the status and try again.";
}

function DomainStatus({
  domain,
  cnameTarget,
}: {
  domain: TrackingDomain;
  cnameTarget: string | null;
}) {
  const cnameRecord = domain.dnsRecords.find(
    (record) => record.type === "CNAME" && record.name === domain.hostname,
  );
  const validationRecords = domain.dnsRecords.filter(
    (record) => record !== cnameRecord,
  );
  const requiredTarget = cnameRecord?.value ?? cnameTarget;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="h6" sx={{ overflowWrap: "anywhere" }}>
            {domain.hostname}
          </Typography>
          <Chip
            label={domain.isCurrent ? "Current domain" : "Historical domain"}
            variant="outlined"
          />
          <Chip
            label={domain.status === "active" ? "Active" : "Pending"}
            color={domain.status === "active" ? "success" : "warning"}
          />
        </Stack>
        <Typography>
          Cloudflare hostname: {domain.cloudflareStatus ?? "Not provisioned"} ·
          TLS certificate: {domain.sslStatus ?? "Not provisioned"}
        </Typography>
        <Typography color="text.secondary">
          Last checked: {domain.lastCheckedAt ?? "Never"}
        </Typography>
        {domain.status !== "active" && (
          <Alert severity="info">
            Pending: the hostname and TLS certificate must both be active in
            Cloudflare, and a matching DNS-only CNAME must be verified. A CNAME
            alone does not provision HTTPS.
          </Alert>
        )}
        <Box sx={{ overflowX: "auto" }}>
          <Table
            size="small"
            aria-label={`DNS requirements for ${domain.hostname}`}
          >
            <TableHead>
              <TableRow>
                <TableCell>Type</TableCell>
                <TableCell>Name / host</TableCell>
                <TableCell>Value / target</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <TableRow>
                <TableCell>CNAME (DNS only)</TableCell>
                <TableCell sx={{ overflowWrap: "anywhere" }}>
                  {domain.hostname}
                </TableCell>
                <TableCell sx={{ overflowWrap: "anywhere" }}>
                  {requiredTarget ??
                    "Not configured by the deployment operator"}
                </TableCell>
              </TableRow>
              {validationRecords.map((record) => (
                <TableRow
                  key={JSON.stringify([
                    domain.id,
                    record.type,
                    record.name,
                    record.value,
                  ])}
                >
                  <TableCell>{record.type}</TableCell>
                  <TableCell sx={{ overflowWrap: "anywhere" }}>
                    {record.name}
                  </TableCell>
                  <TableCell sx={{ overflowWrap: "anywhere" }}>
                    {record.value}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        <Typography color="text.secondary">
          Publish the returned TXT / certificate validation records exactly as
          shown.{" "}
          {validationRecords.length === 0
            ? "No additional provider validation records have been returned yet."
            : ""}
        </Typography>
      </Stack>
    </Paper>
  );
}

function NewsletterDomainSetup({
  workspaceId,
  apiBase,
  newsletterId,
  newsletterName,
}: {
  workspaceId: string;
  apiBase: string;
  newsletterId: string;
  newsletterName: string;
}) {
  const [configuration, setConfiguration] =
    useState<TrackingConfiguration | null>(null);
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "provision" | "verify" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const endpoint = `${apiBase}/api/publications/tracking-domains`;
  const loadConfiguration = useCallback(
    async (signal?: AbortSignal) => {
      const response = await axios.get<{ data: TrackingConfiguration }>(
        endpoint,
        {
          params: { workspaceId, newsletterId },
          signal,
        },
      );
      return response.data.data;
    },
    [endpoint, newsletterId, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void loadConfiguration(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setConfiguration(result);
        setDomain(result.domains.find((item) => item.isCurrent)?.domain ?? "");
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(operationError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadConfiguration]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setConfiguration(await loadConfiguration());
    } catch (failure) {
      setError(operationError(failure));
    } finally {
      setLoading(false);
    }
  };
  const run = async (action: "save" | "provision" | "verify") => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const identity = { workspaceId, newsletterId };
      const response =
        action === "save"
          ? await axios.put<{ data: TrackingConfiguration }>(endpoint, {
              ...identity,
              domain: domain.trim().toLowerCase(),
            })
          : await axios.post<{ data: TrackingConfiguration }>(
              `${endpoint}/${action}`,
              identity,
            );
      const result = response.data.data;
      setConfiguration(result);
      if (action === "save") {
        setDomain(result.domains.find((item) => item.isCurrent)?.domain ?? "");
        setNotice(
          "Saved locally. No provider resources were provisioned and no DNS records were changed.",
        );
      } else if (action === "provision") {
        setNotice(
          "Explicit Cloudflare provisioning completed. Review the returned DNS and TLS requirements; this does not make a pending domain active.",
        );
      } else {
        setNotice(
          "Read-only verification completed. Review the current hostname, TLS, and DNS status below.",
        );
      }
    } catch (failure) {
      setError(operationError(failure));
    } finally {
      setBusy(null);
    }
  };

  const domains =
    configuration?.domains.filter(
      (item) => item.newsletterId === newsletterId,
    ) ?? [];
  const current = domains.find((item) => item.isCurrent);
  const history = domains.filter((item) => !item.isCurrent);
  const normalizedDomain = domain.trim().toLowerCase();
  const locked = loading || busy !== null;
  const unsavedChanges = normalizedDomain !== (current?.domain ?? "");

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography variant="h5">Tracking for {newsletterName}</Typography>
        <Button onClick={() => void refresh()} disabled={locked}>
          Refresh local status
        </Button>
        {loading && (
          <CircularProgress
            size={20}
            aria-label="Loading tracking-domain status"
          />
        )}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}
      {configuration && !configuration.configured && (
        <Alert severity="warning">
          Cloudflare tracking is not fully configured on this deployment. You
          can save a pending domain locally; the deployment operator must
          configure the SaaS CNAME target and provider access before
          provisioning or verification can succeed.
        </Alert>
      )}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            void run("save");
          }}
        >
          <Stack spacing={2}>
            <TextField
              label="Newsletter base domain"
              placeholder="brand.example"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              required
              disabled={locked}
              autoComplete="off"
              helperText="Enter your newsletter's domain only, without https://, a path, or the dt. tracking prefix."
              inputProps={{ maxLength: 250 }}
            />
            <Typography sx={{ overflowWrap: "anywhere" }}>
              Tracking hostname preview:{" "}
              <strong>
                {normalizedDomain
                  ? `dt.${normalizedDomain}`
                  : "dt.<newsletter-domain>"}
              </strong>
            </Typography>
            <Typography color="text.secondary">
              Save is local configuration only. It does not contact Cloudflare,
              change DNS, issue certificates, enable capture, or send email.
              Changing this domain keeps previous domains in history.
            </Typography>
            <Button
              type="submit"
              variant="contained"
              disabled={locked || !normalizedDomain}
            >
              {busy === "save"
                ? "Saving locally…"
                : "Save pending tracking domain"}
            </Button>
          </Stack>
        </Box>
      </Paper>
      <Stack spacing={2}>
        <Typography variant="h6">Explicit infrastructure actions</Typography>
        <Typography color="text.secondary">
          Provision contacts Cloudflare to create or adopt the saved current
          hostname. Verify only reads Cloudflare status and DNS; it does not
          provision resources or publish DNS records. Neither action runs
          automatically.
        </Typography>
        <Stack direction="row" spacing={2} flexWrap="wrap">
          <Button
            variant="outlined"
            disabled={
              locked ||
              !current ||
              !configuration?.configured ||
              !configuration.provisioningEnabled ||
              unsavedChanges
            }
            onClick={() => void run("provision")}
          >
            {busy === "provision" ? "Provisioning…" : "Provision in Cloudflare"}
          </Button>
          <Button
            variant="outlined"
            disabled={
              locked || !current || !configuration?.configured || unsavedChanges
            }
            onClick={() => void run("verify")}
          >
            {busy === "verify" ? "Verifying…" : "Verify DNS & TLS (read-only)"}
          </Button>
        </Stack>
        <Alert severity="info">
          {configuration?.provisioningEnabled
            ? "The server provisioning gate is enabled; provisioning still requires an explicit button click."
            : "Cloudflare provisioning is disabled by default. Only the deployment operator can enable the server provisioning gate; saving a domain does not enable it."}{" "}
          {unsavedChanges
            ? "Save your changes before running actions on the current domain."
            : ""}
        </Alert>
      </Stack>
      <Typography variant="h5">Current domain</Typography>
      {current ? (
        <DomainStatus
          domain={current}
          cnameTarget={configuration?.cnameTarget ?? null}
        />
      ) : (
        <Typography color="text.secondary">
          No current tracking domain saved for this newsletter.
        </Typography>
      )}
      <Typography variant="h5">Domain history</Typography>
      <Alert severity="warning">
        Keep old tracking domains, their DNS records, and their HTTPS service
        alive. Previously delivered emails retain their original pixel hostname;
        switching the current domain does not rewrite them.
      </Alert>
      {history.length ? (
        history.map((item) => (
          <DomainStatus
            key={item.id}
            domain={item}
            cnameTarget={configuration?.cnameTarget ?? null}
          />
        ))
      ) : (
        <Typography color="text.secondary">
          No historical tracking domains.
        </Typography>
      )}
    </Stack>
  );
}

export default function TrackingDomains({
  workspaceId,
  apiBase,
  newsletters,
}: {
  workspaceId: string;
  apiBase: string;
  newsletters: NewsletterOption[];
}) {
  const [newsletterId, setNewsletterId] = useState("");
  const selectedNewsletter = newsletters.find(
    (newsletter) => newsletter.value === newsletterId,
  );
  return (
    <Stack spacing={3}>
      <Typography variant="h4">Newsletter tracking domains</Typography>
      <Alert severity="info">
        Each native newsletter uses its own dt.&lt;newsletter-domain&gt;
        hostname. The global open-capture toggle is separate and remains
        unchanged here. An active hostname verifies infrastructure, not a human
        open or unique person.
      </Alert>
      <Typography color="text.secondary">
        Use a DNS-only CNAME to the deployment&apos;s SaaS target, not a proxied
        or flattened record. Both Cloudflare hostname status and TLS status must
        be active before read-only verification can activate a matching CNAME.
      </Typography>
      <TextField
        select
        label="Newsletter for tracking setup"
        value={selectedNewsletter?.value ?? ""}
        onChange={(event) => setNewsletterId(event.target.value)}
      >
        <MenuItem value="">Choose a newsletter</MenuItem>
        {newsletters.map((newsletter) => (
          <MenuItem key={newsletter.value} value={newsletter.value}>
            {newsletter.label}
          </MenuItem>
        ))}
      </TextField>
      {!newsletters.length && (
        <Alert severity="info">
          Create a native newsletter in Overview &amp; subscribers before
          configuring a tracking domain.
        </Alert>
      )}
      {selectedNewsletter && (
        <NewsletterDomainSetup
          key={`${workspaceId}:${selectedNewsletter.value}`}
          workspaceId={workspaceId}
          apiBase={apiBase}
          newsletterId={selectedNewsletter.value}
          newsletterName={selectedNewsletter.label}
        />
      )}
    </Stack>
  );
}

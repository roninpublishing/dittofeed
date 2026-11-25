import { MoreVert } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import axios from "axios";
import { useState } from "react";

import {
  errorText,
  Option,
  PublisherSettingsProps,
  record,
  RecordValue,
  rows,
  text,
} from "./settingsShared";

type View = "connections" | "domains";
type Values = Record<string, string>;
interface Field {
  name: string;
  label: string;
  type?: "password" | "email" | "url";
  required?: boolean;
  multiline?: boolean;
  disabled?: boolean;
  options?: Option[];
  maxLength?: number;
  pattern?: string;
}
type FormKind =
  | "account"
  | "connection"
  | "domain"
  | "webhook"
  | "provision"
  | "sender";
interface ActiveDialog {
  kind: FormKind | "report";
  connection?: RecordValue;
  domain?: string;
  subdomain?: string;
}
interface Checked {
  fingerprint: string;
  report: RecordValue;
}

function requiredValue(values: Values, key: string, label: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function list(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function finding(value: string): string {
  const labels: Record<string, string> = {
    subuser_missing: "Sending account missing",
    subuser_disabled: "Sending account disabled",
    administrative_identity_mismatch: "Account email does not match",
    subuser_region_mismatch: "Account region does not match",
    runtime_credentials_required: "Sending API key required",
    restricted_key_required: "Mail-send-only API key required",
    sender_identity_not_verified: "Sender identity not verified",
    callback_origin_required: "Webhook callback URL required",
    signed_webhook_not_ready: "Signed webhook needs setup",
  };
  return labels[value] ?? value.replace(/_/g, " ");
}

function checkedAt(value: unknown): string {
  if (typeof value !== "string") return "Not checked";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not checked" : date.toLocaleString();
}

function Status({ ready, label }: { ready: boolean; label?: string }) {
  return (
    <Chip
      size="small"
      color={ready ? "success" : "default"}
      label={label ?? (ready ? "Verified" : "Not verified")}
    />
  );
}

function DnsRecords({ domain }: { domain: RecordValue }) {
  const dns = rows(domain.dns);
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="subtitle2">{text(domain.domain)}</Typography>
        <Status ready={domain.valid === true} />
        {typeof domain.subdomain === "string" && (
          <Typography variant="caption" color="text.secondary">
            {domain.subdomain}
          </Typography>
        )}
      </Stack>
      {dns.length ? (
        <TableContainer>
          <Table
            size="small"
            aria-label={`DNS records for ${text(domain.domain)}`}
          >
            <TableHead>
              <TableRow>
                <TableCell>Type</TableCell>
                <TableCell>Host</TableCell>
                <TableCell>Value</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {dns.map((dnsRecord) => (
                <TableRow
                  key={`${text(dnsRecord.type)}-${text(dnsRecord.host)}-${text(dnsRecord.data)}`}
                >
                  <TableCell>{text(dnsRecord.type)}</TableCell>
                  <TableCell sx={{ overflowWrap: "anywhere" }}>
                    {text(dnsRecord.host)}
                  </TableCell>
                  <TableCell
                    sx={{
                      overflowWrap: "anywhere",
                      fontFamily: "monospace",
                      fontSize: 12,
                    }}
                  >
                    {text(dnsRecord.data)}
                  </TableCell>
                  <TableCell>
                    <Status
                      ready={dnsRecord.valid === true}
                      label={dnsRecord.valid === true ? "Valid" : "Pending"}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No DNS records returned.
        </Typography>
      )}
    </Stack>
  );
}

function InspectionReport({ report }: { report: RecordValue }) {
  const key = record(report.key);
  const webhook = record(report.webhook);
  const findings = strings(report.findings);
  return (
    <Stack spacing={2}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
      >
        <Status
          ready={report.ready === true}
          label={report.ready === true ? "Checks passed" : "Setup needed"}
        />
        <Typography variant="caption" color="text.secondary">
          Checked {checkedAt(report.inspectedAt)}
        </Typography>
      </Stack>
      {findings.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {findings.map((item) => (
            <Typography component="li" variant="body2" key={item}>
              {finding(item)}
            </Typography>
          ))}
        </Box>
      )}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Status
          ready={
            key.present === true &&
            key.restricted === true &&
            key.credentialStored === true
          }
          label={
            key.present === true &&
            key.restricted === true &&
            key.credentialStored === true
              ? "Sending key verified"
              : "Sending key needs attention"
          }
        />
        <Status
          ready={webhook.ready === true}
          label={
            webhook.ready === true ? "Webhook ready" : "Webhook needs setup"
          }
        />
        <Status
          ready={webhook.signed === true}
          label={
            webhook.signed === true ? "Webhook signed" : "Webhook unsigned"
          }
        />
        <Status
          ready={webhook.enabled === true}
          label={
            webhook.enabled === true ? "Webhook enabled" : "Webhook disabled"
          }
        />
      </Stack>
      {rows(report.domains).map((domain) => (
        <DnsRecords
          key={`${text(domain.id)}-${text(domain.domain)}-${text(domain.subdomain)}`}
          domain={domain}
        />
      ))}
      {rows(report.bindings).length > 0 && (
        <TableContainer>
          <Table size="small" aria-label="Checked sending pools">
            <TableHead>
              <TableRow>
                <TableCell>Sending pool</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows(report.bindings).map((binding) => (
                <TableRow key={text(binding.poolId)}>
                  <TableCell>{text(binding.providerPoolName)}</TableCell>
                  <TableCell>
                    <Status ready={binding.valid === true} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {rows(report.ips).length > 0 && (
        <TableContainer>
          <Table size="small" aria-label="Checked sending IPs">
            <TableHead>
              <TableRow>
                <TableCell>IP address</TableCell>
                <TableCell>Reverse DNS</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows(report.ips).map((ip) => (
                <TableRow key={text(ip.address)}>
                  <TableCell>{text(ip.address)}</TableCell>
                  <TableCell>
                    <Status ready={ip.reverseDnsVerified === true} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}

function SettingsForm({
  title,
  fields,
  initial,
  submitLabel,
  confirmation,
  onSubmit,
  onClose,
}: {
  title: string;
  fields: Field[];
  initial: Values;
  submitLabel: string;
  confirmation?: string;
  onSubmit: (values: Values) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let actionLabel = submitLabel;
  if (confirming) actionLabel = `Confirm ${submitLabel.toLowerCase()}`;
  if (busy) actionLabel = "Saving…";
  return (
    <Dialog open fullWidth maxWidth="sm" onClose={busy ? undefined : onClose}>
      <Box
        component="form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (confirmation && !confirming) {
            setConfirming(true);
            setError(null);
            return;
          }
          setBusy(true);
          setError(null);
          try {
            await onSubmit(values);
          } catch (failure) {
            setError(
              failure instanceof Error && !axios.isAxiosError(failure)
                ? failure.message
                : errorText(failure),
            );
            setConfirming(false);
          } finally {
            setValues((current) => {
              const cleared = { ...current };
              fields.forEach((field) => {
                if (field.type === "password") cleared[field.name] = "";
              });
              return cleared;
            });
            setBusy(false);
          }
        }}
      >
        <DialogTitle>{confirming ? "Confirm changes" : title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {confirming ? (
              <Typography variant="body2">{confirmation}</Typography>
            ) : (
              fields.map((field) => (
                <TextField
                  key={field.name}
                  fullWidth
                  size="small"
                  label={field.label}
                  value={values[field.name] ?? ""}
                  required={field.required}
                  disabled={busy || field.disabled}
                  type={field.type ?? "text"}
                  autoComplete={
                    field.type === "password" ? "new-password" : "off"
                  }
                  select={Boolean(field.options)}
                  multiline={field.multiline}
                  minRows={field.multiline ? 2 : undefined}
                  inputProps={{
                    maxLength: field.maxLength,
                    pattern: field.pattern,
                  }}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                >
                  {field.options?.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              ))
            )}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {confirming && (
            <Button
              color="inherit"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Back
            </Button>
          )}
          <Button type="submit" variant="contained" disabled={busy}>
            {actionLabel}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function SendingSettingsContent({
  workspaceId,
  apiBase,
  infrastructure,
  newsletters,
  onComplete,
  view,
}: PublisherSettingsProps & { view: View }) {
  const account = record(infrastructure.account);
  const connections = rows(infrastructure.connections);
  const providerWrites = account.allowProviderWrites === true;
  const managementKeyStored = account.hasManagementKey === true;
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  const [connectionMenu, setConnectionMenu] = useState<{
    anchor: HTMLElement;
    connection: RecordValue;
  } | null>(null);
  const [checks, setChecks] = useState<Record<string, Checked>>({});
  const [domainResults, setDomainResults] = useState<
    Record<string, { revision: unknown; domains: RecordValue[] }>
  >({});
  const [invalidated, setInvalidated] = useState<Record<string, boolean>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `${apiBase}/api/publications/infrastructure`;
  const name = (connection: RecordValue) =>
    newsletters.find(
      (newsletter) => newsletter.value === connection.newsletterId,
    )?.label ?? "Newsletter";
  const fingerprint = (connection: RecordValue) =>
    JSON.stringify([
      workspaceId,
      connection.id,
      connection.revision,
      connection.senderDomains,
      connection.senderEmails,
      account.region,
      account.callbackBaseUrl,
      account.updatedAt,
    ]);
  const currentReport = (connection: RecordValue): RecordValue | undefined => {
    const checked = checks[text(connection.id)];
    return checked?.fingerprint === fingerprint(connection)
      ? checked.report
      : undefined;
  };
  const invalidate = (connectionId?: string, clearDomains = true) => {
    if (connectionId) {
      setChecks((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => id !== connectionId),
        ),
      );
      if (clearDomains)
        setDomainResults((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([id]) => id !== connectionId),
          ),
        );
      setInvalidated((current) => ({ ...current, [connectionId]: true }));
    } else {
      setChecks({});
      setDomainResults({});
      setInvalidated(
        Object.fromEntries(
          connections.map((connection) => [text(connection.id), true]),
        ),
      );
    }
  };
  const saveReport = (connection: RecordValue, report: RecordValue) => {
    const id = text(connection.id);
    setChecks((current) => ({
      ...current,
      [id]: { fingerprint: fingerprint(connection), report },
    }));
    setInvalidated((current) => ({ ...current, [id]: false }));
  };
  const refresh = async () => {
    try {
      await onComplete();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const check = async (connection: RecordValue) => {
    setChecking(text(connection.id));
    setError(null);
    setNotice(null);
    try {
      const response = await axios.post(`${base}/connections/inspect`, {
        workspaceId,
        connectionId: connection.id,
      });
      saveReport(connection, record(record(response.data).data));
      setDialog({ kind: "report", connection });
      await refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setChecking(null);
    }
  };
  const availableNewsletters = newsletters.filter(
    (newsletter) =>
      !connections.some(
        (connection) => connection.newsletterId === newsletter.value,
      ),
  );
  let paused: string | undefined;
  if (!managementKeyStored) paused = "Management key required";
  if (!providerWrites) paused = "Provider changes paused";
  const domainsFor = (connection: RecordValue) => {
    const stored = domainResults[text(connection.id)];
    const results =
      stored && stored.revision === connection.revision ? stored.domains : [];
    const domains = [...rows(currentReport(connection)?.domains)];
    results.forEach((domain) => {
      const index = domains.findIndex(
        (existing) =>
          existing.domain === domain.domain &&
          existing.subdomain === domain.subdomain,
      );
      if (index >= 0) domains[index] = domain;
      else domains.push(domain);
    });
    strings(connection.senderDomains).forEach((domain) => {
      if (!domains.some((existing) => existing.domain === domain))
        domains.push({ domain });
    });
    return domains;
  };

  let form:
    | {
        title: string;
        fields: Field[];
        initial: Values;
        submitLabel: string;
        confirmation?: string;
      }
    | undefined;
  const selected = dialog?.connection
    ? connections.find(
        (connection) => connection.id === dialog.connection?.id,
      ) ?? dialog.connection
    : undefined;
  if (dialog?.kind === "account") {
    form = {
      title: "SendGrid credentials",
      submitLabel: "Save credentials",
      initial: {
        managementApiKey: "",
        region: typeof account.region === "string" ? account.region : "global",
        callbackBaseUrl:
          typeof account.callbackBaseUrl === "string"
            ? account.callbackBaseUrl
            : "",
      },
      fields: [
        {
          name: "managementApiKey",
          label: managementKeyStored
            ? "Replacement management API key (optional)"
            : "Management API key",
          type: "password",
          maxLength: 512,
        },
        {
          name: "region",
          label: "Region",
          options: [
            { value: "global", label: "Global" },
            { value: "eu", label: "Europe" },
          ],
        },
        {
          name: "callbackBaseUrl",
          label: "Webhook callback base URL",
          type: "url",
          maxLength: 2048,
        },
      ],
    };
  } else if (dialog?.kind === "connection") {
    form = {
      title: selected
        ? `Edit credentials · ${name(selected)}`
        : "Add connection",
      submitLabel: selected ? "Save connection" : "Add connection",
      initial: {
        newsletterId: selected
          ? text(selected.newsletterId)
          : availableNewsletters[0]?.value ?? "",
        apiKey: "",
        apiKeyId: "",
        senderDomains: strings(selected?.senderDomains).join("\n"),
        senderEmails: strings(selected?.senderEmails).join("\n"),
      },
      fields: [
        {
          name: "newsletterId",
          label: "Newsletter",
          required: true,
          options: selected ? newsletters : availableNewsletters,
          disabled: Boolean(selected),
        },
        {
          name: "apiKey",
          label:
            selected?.hasApiKey === true
              ? "Replacement sending API key (optional)"
              : "Existing mail-send-only API key (optional)",
          type: "password",
          maxLength: 512,
        },
        { name: "apiKeyId", label: "API key ID (optional)", maxLength: 256 },
        {
          name: "senderDomains",
          label: "Sender domains · one per line",
          multiline: true,
        },
        {
          name: "senderEmails",
          label: "Sender emails · one per line",
          multiline: true,
        },
      ],
    };
  } else if (dialog?.kind === "domain") {
    form = {
      title: `Domain authentication${selected ? ` · ${name(selected)}` : ""}`,
      submitLabel: dialog.domain ? "Verify domain" : "Authenticate domain",
      confirmation:
        "Create or update this SendGrid domain authentication and check its DNS records?",
      initial: {
        connectionId: text(selected?.id ?? connections[0]?.id ?? ""),
        domain: dialog.domain ?? "",
        subdomain: dialog.subdomain ?? "",
        validate: "true",
      },
      fields: [
        {
          name: "connectionId",
          label: "Newsletter",
          required: true,
          options: connections.map((connection) => ({
            value: text(connection.id),
            label: name(connection),
          })),
          disabled: Boolean(selected),
        },
        { name: "domain", label: "Domain", required: true, maxLength: 253 },
        {
          name: "subdomain",
          label: "Return-path subdomain (optional)",
          maxLength: 63,
          pattern: "[a-z0-9][a-z0-9-]{0,62}",
        },
        {
          name: "validate",
          label: "DNS verification",
          options: [
            { value: "true", label: "Check DNS records" },
            { value: "false", label: "Set up authentication only" },
          ],
        },
      ],
    };
  } else if (dialog?.kind === "webhook") {
    form = {
      title: `Webhook setup · ${selected ? name(selected) : ""}`,
      fields: [],
      initial: {},
      submitLabel: "Set up webhook",
      confirmation:
        "Create or repair this connection’s signed SendGrid event webhook?",
    };
  } else if (dialog?.kind === "provision") {
    form = {
      title: `Finish setup · ${selected ? name(selected) : ""}`,
      submitLabel: "Finish setup",
      confirmation: "Configure this newsletter’s SendGrid resources?",
      initial: { configureWebhook: "true" },
      fields: [
        {
          name: "configureWebhook",
          label: "Event webhook",
          options: [
            { value: "true", label: "Set up signed webhook" },
            { value: "false", label: "Keep current webhook" },
          ],
        },
      ],
    };
  } else if (dialog?.kind === "sender") {
    form = {
      title: "Advanced · Sender identity verification",
      submitLabel: "Send verification email",
      confirmation:
        "Send a SendGrid verification email to this sender address?",
      initial: {
        connectionId: text(selected?.id ?? connections[0]?.id ?? ""),
      },
      fields: [
        {
          name: "connectionId",
          label: "Newsletter",
          required: true,
          options: connections.map((connection) => ({
            value: text(connection.id),
            label: name(connection),
          })),
          disabled: Boolean(selected),
        },
        {
          name: "nickname",
          label: "Sender nickname",
          required: true,
          maxLength: 256,
        },
        {
          name: "fromEmail",
          label: "Sender email",
          type: "email",
          required: true,
          maxLength: 320,
        },
        {
          name: "replyTo",
          label: "Reply-to email",
          type: "email",
          required: true,
          maxLength: 320,
        },
        { name: "fromName", label: "Sender name (optional)", maxLength: 256 },
        { name: "address", label: "Street address (optional)", maxLength: 256 },
        { name: "city", label: "City (optional)", maxLength: 128 },
        {
          name: "state",
          label: "State or province (optional)",
          maxLength: 128,
        },
        { name: "zip", label: "Postal code (optional)", maxLength: 32 },
        { name: "country", label: "Country (optional)", maxLength: 128 },
      ],
    };
  }

  const submit = async (values: Values) => {
    if (!dialog || dialog.kind === "report") return;
    const { kind } = dialog;
    setError(null);
    setNotice(null);
    if (
      ["domain", "webhook", "provision", "sender"].includes(kind) &&
      (!providerWrites || !managementKeyStored)
    )
      throw new Error(paused ?? "Provider changes unavailable");
    if (kind === "account") {
      await axios.put(`${base}/account`, {
        workspaceId,
        region: values.region,
        ...(values.managementApiKey?.trim()
          ? { managementApiKey: values.managementApiKey.trim() }
          : {}),
        ...(values.callbackBaseUrl?.trim()
          ? { callbackBaseUrl: values.callbackBaseUrl.trim() }
          : {}),
      });
      invalidate();
      setNotice("Credentials saved; check connections to verify.");
    } else if (kind === "connection") {
      const domains = list(values.senderDomains ?? "");
      const emails = list(values.senderEmails ?? "");
      if (domains.length > 100 || emails.length > 100)
        throw new Error(
          "Use at most 100 sender domains and 100 sender emails.",
        );
      await axios.put(`${base}/connections`, {
        workspaceId,
        newsletterId: values.newsletterId,
        ...(values.apiKey?.trim() ? { apiKey: values.apiKey.trim() } : {}),
        ...(values.apiKeyId?.trim()
          ? { apiKeyId: values.apiKeyId.trim() }
          : {}),
        senderDomains: domains,
        senderEmails: emails,
      });
      if (selected) invalidate(text(selected.id));
      setNotice("Connection saved; verification required.");
    } else {
      const connectionId = selected
        ? text(selected.id)
        : requiredValue(values, "connectionId", "Newsletter");
      const connection = connections.find((item) => item.id === connectionId);
      if (!connection) throw new Error("Choose a connection.");
      const payload: RecordValue = { workspaceId, connectionId };
      let endpoint: string;
      if (kind === "domain") {
        endpoint = "domains";
        payload.domain = requiredValue(values, "domain", "Domain");
        payload.validate = values.validate === "true";
        if (values.subdomain?.trim())
          payload.subdomain = values.subdomain.trim();
      } else if (kind === "sender") {
        endpoint = "senders";
        payload.nickname = requiredValue(values, "nickname", "Sender nickname");
        payload.fromEmail = requiredValue(values, "fromEmail", "Sender email");
        payload.replyTo = requiredValue(values, "replyTo", "Reply-to email");
        payload.sendVerificationEmail = true;
        ["fromName", "address", "city", "state", "zip", "country"].forEach(
          (field) => {
            const value = values[field]?.trim();
            if (value) payload[field] = value;
          },
        );
      } else if (kind === "provision") {
        endpoint = "connections/provision";
        payload.configureWebhook = values.configureWebhook === "true";
      } else {
        endpoint = "webhooks";
      }
      const response = await axios.post(`${base}/${endpoint}`, payload);
      const result = record(record(response.data).data);
      invalidate(connectionId, kind !== "domain");
      if (kind === "domain") {
        setDomainResults((current) => ({
          ...current,
          [connectionId]: {
            revision: connection.revision,
            domains: [
              ...(current[connectionId]?.domains ?? []).filter(
                (domain) =>
                  domain.domain !== result.domain ||
                  domain.subdomain !== result.subdomain,
              ),
              result,
            ],
          },
        }));
        setNotice(
          result.valid === true
            ? "Domain verified."
            : "Domain authentication saved; DNS verification pending.",
        );
      } else if (kind === "sender") {
        setNotice(
          result.verified === true
            ? "Sender identity verified."
            : "Sender verification pending; check the sender’s inbox.",
        );
      } else {
        saveReport(connection, result);
        setNotice(
          result.ready === true
            ? "Connection ready."
            : "Setup updated; review connection findings.",
        );
      }
    }
    setDialog(null);
    await refresh();
  };
  let emptyMessage = "Add a sending connection before authenticating domains.";
  if (view === "connections") {
    emptyMessage = newsletters.length
      ? "No sending connections."
      : "Create a newsletter to add a connection.";
  }

  return (
    <Stack spacing={2}>
      {view === "connections" && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            justifyContent="space-between"
            alignItems={{ sm: "center" }}
          >
            <Stack spacing={1}>
              <Typography variant="subtitle1">SendGrid</Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip
                  size="small"
                  label={
                    managementKeyStored ? "Credentials saved" : "Not connected"
                  }
                />
                <Chip
                  size="small"
                  label={
                    account.allowRealSends === true &&
                    account.allTrafficControlled === true
                      ? "Sending permitted"
                      : "Sending paused"
                  }
                />
              </Stack>
            </Stack>
            <Button
              size="small"
              variant="outlined"
              disabled={Boolean(checking)}
              onClick={() => setDialog({ kind: "account" })}
            >
              {managementKeyStored ? "Edit credentials" : "Connect SendGrid"}
            </Button>
          </Stack>
        </Paper>
      )}
      <Stack
        direction="row"
        justifyContent="space-between"
        spacing={1}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
      >
        <Typography variant="h6">
          {view === "connections"
            ? "Newsletter connections"
            : "Sending domains"}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="contained"
            disabled={
              Boolean(checking) ||
              (view === "connections"
                ? !availableNewsletters.length
                : Boolean(paused) || !connections.length)
            }
            onClick={() =>
              setDialog({
                kind: view === "connections" ? "connection" : "domain",
              })
            }
          >
            {view === "connections" ? "Add connection" : "Authenticate domain"}
          </Button>
        </Stack>
      </Stack>
      {paused && (
        <Typography variant="caption" color="text.secondary">
          {paused}
        </Typography>
      )}
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {!connections.length && (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Typography variant="body2" color="text.secondary">
            {emptyMessage}
          </Typography>
        </Paper>
      )}
      {connections.length > 0 && view === "connections" && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label="Newsletter sending connections">
            <TableHead>
              <TableRow>
                <TableCell>Newsletter</TableCell>
                <TableCell>Sending account</TableCell>
                <TableCell>Credentials</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connections.map((connection) => {
                const id = text(connection.id);
                const report = currentReport(connection);
                const provisioning = record(connection.provisioning);
                const status = report ?? (invalidated[id] ? {} : provisioning);
                const hasCheck = typeof status.inspectedAt === "string";
                const ready =
                  hasCheck &&
                  status.ready === true &&
                  connection.status === "ready";
                let statusLabel = "Not checked";
                if (hasCheck)
                  statusLabel =
                    status.ready === true ? "Checks passed" : "Setup needed";
                if (ready) statusLabel = "Ready";
                if (connection.status === "paused") statusLabel = "Paused";
                return (
                  <TableRow key={id}>
                    <TableCell>{name(connection)}</TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {text(connection.username)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {text(connection.administrativeEmail)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={
                          connection.hasApiKey === true
                            ? "Key saved"
                            : "Key required"
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.5}>
                        <Status ready={ready} label={statusLabel} />
                        <Typography variant="caption" color="text.secondary">
                          {checkedAt(status.inspectedAt)}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Stack
                        direction="row"
                        justifyContent="flex-end"
                        spacing={0.5}
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <Button
                          size="small"
                          disabled={Boolean(checking) || !managementKeyStored}
                          onClick={() => {
                            void check(connection);
                          }}
                        >
                          {checking === id ? "Checking…" : "Check connection"}
                        </Button>
                        <IconButton
                          size="small"
                          aria-label={`More actions for ${name(connection)}`}
                          aria-haspopup="menu"
                          aria-controls={
                            connectionMenu?.connection.id === connection.id
                              ? "sending-connection-actions"
                              : undefined
                          }
                          aria-expanded={
                            connectionMenu?.connection.id === connection.id
                              ? true
                              : undefined
                          }
                          disabled={Boolean(checking)}
                          onClick={(event) =>
                            setConnectionMenu({
                              anchor: event.currentTarget,
                              connection,
                            })
                          }
                        >
                          <MoreVert fontSize="small" />
                        </IconButton>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {connections.length > 0 && view === "domains" && (
        <Stack spacing={2}>
          {connections.map((connection) => {
            const domains = domainsFor(connection);
            return (
              <Paper key={text(connection.id)} variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={2}>
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    spacing={1}
                  >
                    <Box>
                      <Typography variant="subtitle2">
                        {name(connection)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {text(connection.username)}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1}>
                      <Button
                        size="small"
                        disabled={Boolean(checking) || !managementKeyStored}
                        onClick={() => {
                          void check(connection);
                        }}
                      >
                        {checking === connection.id
                          ? "Checking…"
                          : "Check domains"}
                      </Button>
                      <Button
                        size="small"
                        disabled={Boolean(checking) || Boolean(paused)}
                        onClick={() =>
                          setDialog({ kind: "domain", connection })
                        }
                      >
                        Add domain
                      </Button>
                    </Stack>
                  </Stack>
                  {!domains.length && (
                    <Typography variant="body2" color="text.secondary">
                      No sending domains.
                    </Typography>
                  )}
                  {domains.map((domain) => (
                    <Box
                      key={`${text(domain.id)}-${text(domain.domain)}-${text(domain.subdomain)}`}
                    >
                      {Array.isArray(domain.dns) ? (
                        <DnsRecords domain={domain} />
                      ) : (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="body2">
                            {text(domain.domain)}
                          </Typography>
                          <Chip size="small" label="Not checked" />
                        </Stack>
                      )}
                      <Button
                        size="small"
                        sx={{ mt: 1 }}
                        disabled={Boolean(checking) || Boolean(paused)}
                        onClick={() =>
                          setDialog({
                            kind: "domain",
                            connection,
                            domain: text(domain.domain),
                            subdomain:
                              typeof domain.subdomain === "string"
                                ? domain.subdomain
                                : undefined,
                          })
                        }
                      >
                        Verify domain
                      </Button>
                    </Box>
                  ))}
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}
      <Menu
        id="sending-connection-actions"
        anchorEl={connectionMenu?.anchor}
        open={Boolean(connectionMenu)}
        onClose={() => setConnectionMenu(null)}
      >
        {(
          [
            { kind: "connection", label: "Edit credentials" },
            { kind: "webhook", label: "Set up webhook" },
            { kind: "provision", label: "Finish setup" },
            { kind: "sender", label: "Sender verification" },
          ] as const
        ).map((action) => (
          <MenuItem
            key={action.kind}
            disabled={
              Boolean(checking) ||
              (action.kind !== "connection" && Boolean(paused))
            }
            onClick={() => {
              if (!connectionMenu) return;
              setDialog({
                kind: action.kind,
                connection: connectionMenu.connection,
              });
              setConnectionMenu(null);
            }}
          >
            {action.label}
          </MenuItem>
        ))}
      </Menu>
      {form && dialog && (
        <SettingsForm
          key={`${workspaceId}-${dialog.kind}-${text(selected?.id)}-${dialog.domain ?? ""}`}
          {...form}
          onSubmit={submit}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "report" && selected && (
        <Dialog open fullWidth maxWidth="md" onClose={() => setDialog(null)}>
          <DialogTitle>Connection check · {name(selected)}</DialogTitle>
          <DialogContent>
            {currentReport(selected) ? (
              <InspectionReport report={currentReport(selected) ?? {}} />
            ) : (
              <Typography variant="body2">
                Check the connection again for current results.
              </Typography>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDialog(null)}>Close</Button>
          </DialogActions>
        </Dialog>
      )}
    </Stack>
  );
}

export default function SendingSettings({
  workspaceId,
  ...props
}: PublisherSettingsProps & { view: View }) {
  return (
    <SendingSettingsContent
      key={workspaceId}
      workspaceId={workspaceId}
      {...props}
    />
  );
}

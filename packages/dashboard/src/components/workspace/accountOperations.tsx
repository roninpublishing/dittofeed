import { Alert, MenuItem, Stack, TextField, Typography } from "@mui/material";
import axios from "axios";
import { useState } from "react";

import { record, RecordValue, text } from "../publications/settingsShared";
import {
  DnsRecords,
  EditorDialog,
  InfrastructureProps,
} from "./infrastructureShared";

export type AccountOperation = "domain" | "webhook" | "sender";

export default function AccountOperations({
  workspaceId,
  apiBase,
  account,
  operation,
  domain: initialDomain,
  onComplete,
  onClose,
  onDomain,
}: Pick<InfrastructureProps, "workspaceId" | "apiBase" | "onComplete"> & {
  account: RecordValue;
  operation: AccountOperation;
  domain?: RecordValue;
  onClose: () => void;
  onDomain?: (domain: RecordValue) => void;
}) {
  const [domain, setDomain] = useState(
    typeof initialDomain?.domain === "string" ? initialDomain.domain : "",
  );
  const [subdomain, setSubdomain] = useState(
    typeof initialDomain?.subdomain === "string" ? initialDomain.subdomain : "",
  );
  const [validate, setValidate] = useState("true");
  const [sender, setSender] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RecordValue | null>(null);
  const allowed =
    account.allowProviderWrites === true &&
    account.hasManagementKey === true &&
    typeof account.connectionId === "string";
  const actions = {
    domain: initialDomain ? "Verify domain" : "Authenticate domain",
    webhook: "Set up signed webhook",
    sender: "Send verification email",
  };
  const confirmations = {
    domain: `Create or update SendGrid domain authentication for ${text(account.name)}?`,
    webhook: `Create or repair the signed event webhook for ${text(account.name)}?`,
    sender: `Send a SendGrid verification email for ${text(account.name)}?`,
  };
  if (result)
    return (
      <EditorDialog
        title="Domain authentication result"
        action="Done"
        onClose={onClose}
        onSubmit={async () => onClose()}
      >
        <DnsRecords domains={[result]} />
      </EditorDialog>
    );
  return (
    <EditorDialog
      title={`${actions[operation]} · ${text(account.name)}`}
      action={actions[operation]}
      confirmation={confirmations[operation]}
      disabled={!allowed}
      onClose={onClose}
      onSubmit={async () => {
        if (!allowed) throw new Error("Provider changes are not authorized.");
        const payload: RecordValue = {
          workspaceId,
          connectionId: account.connectionId,
        };
        let endpoint: string;
        if (operation === "domain") {
          endpoint = "domains";
          payload.domain = domain.trim();
          payload.validate = validate === "true";
          if (subdomain.trim()) payload.subdomain = subdomain.trim();
        } else if (operation === "webhook") endpoint = "webhooks";
        else {
          endpoint = "senders";
          payload.sendVerificationEmail = true;
          Object.entries(sender).forEach(([key, entry]) => {
            if (entry.trim()) payload[key] = entry.trim();
          });
        }
        const response = await axios.post(
          `${apiBase}/api/publications/infrastructure/${endpoint}`,
          payload,
        );
        if (operation === "domain") {
          const domainResult = record(record(response.data).data);
          onDomain?.(domainResult);
          setResult(domainResult);
        }
        await onComplete();
        if (operation !== "domain") onClose();
      }}
    >
      {!allowed && <Alert severity="info">Provider changes paused</Alert>}
      {operation === "domain" && (
        <>
          <TextField
            size="small"
            required
            label="Domain"
            value={domain}
            inputProps={{ maxLength: 253 }}
            onChange={(event) => setDomain(event.target.value)}
          />
          <TextField
            size="small"
            label="Return-path subdomain (optional)"
            value={subdomain}
            inputProps={{ maxLength: 63, pattern: "[a-z0-9][a-z0-9-]{0,62}" }}
            onChange={(event) => setSubdomain(event.target.value)}
          />
          <TextField
            size="small"
            select
            label="DNS verification"
            value={validate}
            onChange={(event) => setValidate(event.target.value)}
          >
            <MenuItem value="true">Check DNS records</MenuItem>
            <MenuItem value="false">Set up authentication only</MenuItem>
          </TextField>
        </>
      )}
      {operation === "webhook" && (
        <Typography variant="body2">{text(account.callbackBaseUrl)}</Typography>
      )}
      {operation === "sender" && (
        <Stack spacing={2}>
          {[
            { key: "nickname", label: "Sender nickname", required: true },
            {
              key: "fromEmail",
              label: "Sender email",
              required: true,
              type: "email",
            },
            {
              key: "replyTo",
              label: "Reply-to email",
              required: true,
              type: "email",
            },
            { key: "fromName", label: "Sender name" },
            { key: "address", label: "Street address" },
            { key: "city", label: "City" },
            { key: "state", label: "State or province" },
            { key: "zip", label: "Postal code" },
            { key: "country", label: "Country" },
          ].map((field) => (
            <TextField
              key={field.key}
              size="small"
              label={field.label}
              required={field.required}
              type={field.type ?? "text"}
              value={sender[field.key] ?? ""}
              inputProps={{ maxLength: field.type === "email" ? 320 : 256 }}
              onChange={(event) =>
                setSender((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
            />
          ))}
        </Stack>
      )}
    </EditorDialog>
  );
}

import { MenuItem, TextField } from "@mui/material";
import axios from "axios";
import { useState } from "react";

import { RecordValue } from "../publications/settingsShared";
import {
  EditorDialog,
  InfrastructureProps,
  list,
  providers,
  strings,
} from "./infrastructureShared";

export default function AccountEditor({
  workspaceId,
  apiBase,
  account,
  onComplete,
  onClose,
}: Pick<InfrastructureProps, "workspaceId" | "apiBase" | "onComplete"> & {
  account?: RecordValue;
  onClose: () => void;
}) {
  const [name, setName] = useState(
    typeof account?.name === "string" ? account.name : "",
  );
  const [region, setRegion] = useState(
    typeof account?.region === "string" ? account.region : "global",
  );
  const [username, setUsername] = useState(
    typeof account?.username === "string" ? account.username : "",
  );
  const [callbackBaseUrl, setCallbackBaseUrl] = useState(
    typeof account?.callbackBaseUrl === "string" ? account.callbackBaseUrl : "",
  );
  const [managementKey, setManagementKey] = useState("");
  const [sendingKey, setSendingKey] = useState("");
  const [emails, setEmails] = useState(
    strings(account?.senderEmails).join("\n"),
  );
  const clear = () => {
    setManagementKey("");
    setSendingKey("");
  };
  return (
    <EditorDialog
      title={account ? `Edit ${name || "ESP account"}` : "Add ESP account"}
      action={account ? "Save account" : "Add account"}
      onClose={() => {
        clear();
        onClose();
      }}
      onSubmit={async () => {
        try {
          await axios.put(
            `${apiBase}/api/publications/infrastructure/accounts`,
            {
              workspaceId,
              ...(account ? { id: account.id } : {}),
              name: name.trim(),
              provider: "SendGrid",
              region,
              ...(username.trim() ? { username: username.trim() } : {}),
              ...(callbackBaseUrl.trim()
                ? { callbackBaseUrl: callbackBaseUrl.trim() }
                : {}),
              ...(managementKey.trim()
                ? { managementApiKey: managementKey.trim() }
                : {}),
              ...(sendingKey.trim() ? { apiKey: sendingKey.trim() } : {}),
              senderEmails: list(emails),
            },
          );
          clear();
          await onComplete();
          onClose();
        } finally {
          clear();
        }
      }}
    >
      <TextField
        size="small"
        label="Account name"
        required
        value={name}
        inputProps={{ maxLength: 256 }}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField size="small" select label="Provider" value="SendGrid" disabled>
        {Object.entries(providers).map(([id, provider]) => (
          <MenuItem key={id} value={id}>
            {provider.label}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        select
        label="Region"
        value={region}
        onChange={(event) => setRegion(event.target.value)}
      >
        <MenuItem value="global">Global</MenuItem>
        <MenuItem value="eu">Europe</MenuItem>
      </TextField>
      <TextField
        size="small"
        label="Existing subuser username (optional)"
        value={username}
        inputProps={{ maxLength: 64 }}
        onChange={(event) => setUsername(event.target.value)}
      />
      <TextField
        size="small"
        type="password"
        autoComplete="new-password"
        label={
          account?.hasManagementKey === true
            ? "Replacement management API key (optional)"
            : "Management API key (optional)"
        }
        value={managementKey}
        inputProps={{ maxLength: 512 }}
        onChange={(event) => setManagementKey(event.target.value)}
      />
      <TextField
        size="small"
        type="password"
        autoComplete="new-password"
        label={
          account?.hasApiKey === true
            ? "Replacement sending API key (optional)"
            : "Mail-send-only API key (optional)"
        }
        value={sendingKey}
        inputProps={{ maxLength: 512 }}
        onChange={(event) => setSendingKey(event.target.value)}
      />
      <TextField
        size="small"
        type="url"
        label="Webhook callback base URL (optional)"
        value={callbackBaseUrl}
        inputProps={{ maxLength: 2048 }}
        onChange={(event) => setCallbackBaseUrl(event.target.value)}
      />
      <TextField
        size="small"
        multiline
        minRows={2}
        label="Sender emails · comma or newline separated"
        value={emails}
        onChange={(event) => setEmails(event.target.value)}
      />
    </EditorDialog>
  );
}

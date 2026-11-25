import {
  Alert,
  Checkbox,
  MenuItem,
  TextField,
} from "@mui/material";
import axios from "axios";
import { useState } from "react";

import { RecordValue, rows, text } from "../publications/settingsShared";
import { EditorDialog, InfrastructureProps } from "./infrastructureShared";

export default function ResourceEditor({
  workspaceId,
  apiBase,
  infrastructure,
  accountId,
  kind = "ips",
  item,
  onComplete,
  onClose,
}: InfrastructureProps & { item?: RecordValue; onClose: () => void }) {
  const accounts = rows(infrastructure.accounts);
  const ips = rows(infrastructure.ips);
  const [owner, setOwner] = useState(
    typeof item?.accountId === "string" ? item.accountId : accountId ?? "",
  );
  const [address, setAddress] = useState(
    typeof item?.address === "string" ? item.address : "",
  );
  const [name, setName] = useState(
    typeof item?.name === "string" ? item.name : "",
  );
  const [status, setStatus] = useState(
    typeof item?.status === "string" ? item.status : "paused",
  );
  const [ipIds, setIpIds] = useState(() =>
    rows(infrastructure.memberships)
      .filter((member) => item && member.poolId === item.id)
      .map((member) => text(member.ipId)),
  );
  const ownedIps = ips.filter((ip) => ip.accountId === owner);
  return (
    <EditorDialog
      title={`${item ? "Edit" : "Add"} ${kind === "ips" ? "dedicated IP" : "shared IP pool"}`}
      disabled={
        !owner ||
        (kind === "ips" ? !address.trim() : !name.trim() || !ipIds.length || ipIds.length > 100)
      }
      onClose={onClose}
      onSubmit={async () => {
        if (!accounts.some((account) => account.id === owner))
          throw new Error("Choose an ESP account.");
        if (
          kind === "ips" &&
          !item &&
          ips.some(
            (ip) => ip.accountId === owner && ip.address === address.trim(),
          )
        )
          throw new Error(
            "This IP is already registered for this account. Edit its existing record.",
          );
        await axios.put(`${apiBase}/api/publications/infrastructure/${kind}`, {
          workspaceId,
          accountId: owner,
          ...(item ? { id: item.id } : {}),
          ...(kind === "ips"
            ? {
                address: address.trim(),
                ...(item ? { status } : {}),
              }
            : {
                name: name.trim(),
                ipIds,
              }),
        });
        await onComplete();
        onClose();
      }}
    >
      <TextField
        select
        size="small"
        label="ESP account"
        required
        value={owner}
        disabled={Boolean(item) || Boolean(accountId)}
        onChange={(event) => {
          setOwner(event.target.value);
          setIpIds([]);
        }}
      >
        {accounts.map((account) => (
          <MenuItem key={text(account.id)} value={text(account.id)}>
            {text(account.name)}
          </MenuItem>
        ))}
      </TextField>
      {kind === "ips" ? (
        <>
          <TextField
            size="small"
            label="IP address"
            required
            disabled={Boolean(item)}
            value={address}
            inputProps={{ maxLength: 45 }}
            onChange={(event) => setAddress(event.target.value)}
          />
          {item && (
            <TextField
              select
              size="small"
              label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <MenuItem value="active" disabled={!Number(item.hourlyLimit) || !Number(item.dailyLimit)}>
                Active
              </MenuItem>
              <MenuItem value="paused">Paused</MenuItem>
            </TextField>
          )}
        </>
      ) : (
        <>
          <TextField
            size="small"
            required
            label="Shared IP pool name"
            value={name}
            inputProps={{ maxLength: 64 }}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            select
            size="small"
            label="Dedicated IPs"
            value={ipIds}
            SelectProps={{
              multiple: true,
              renderValue: () =>
                ipIds
                  .map((id) =>
                    text(ownedIps.find((ip) => ip.id === id)?.address),
                  )
                  .join(", "),
            }}
            onChange={(event) => {
              const selected = event.target.value;
              setIpIds(
                typeof selected === "string" ? selected.split(",") : selected,
              );
            }}
          >
            {ownedIps.map((ip) => (
              <MenuItem key={text(ip.id)} value={text(ip.id)}>
                <Checkbox checked={ipIds.includes(text(ip.id))} />
                {text(ip.address)}
              </MenuItem>
            ))}
          </TextField>
          {!ownedIps.length && (
            <Alert severity="info">No dedicated IPs for this account</Alert>
          )}
        </>
      )}
    </EditorDialog>
  );
}

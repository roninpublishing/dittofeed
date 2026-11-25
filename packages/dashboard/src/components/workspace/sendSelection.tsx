import {
  Alert,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { EspSelection } from "isomorphic-lib/src/publications";
import { CompletionStatus } from "isomorphic-lib/src/types";

import { useAppStorePick } from "../../lib/appStore";
import {
  errorText,
  record,
  RecordValue,
  rows,
  text,
} from "../publications/settingsShared";

interface SelectionProps {
  options: RecordValue;
  selection: EspSelection | null | undefined;
  onChange: (selection: EspSelection | undefined) => void;
  disabled?: boolean;
  emptyLabel?: string;
}

export default function SendSelection({
  options,
  selection,
  onChange,
  disabled,
  emptyLabel = "None",
}: SelectionProps) {
  const accounts = rows(options.accounts);
  const selectedAccount = accounts.find(
    (account) => account.id === selection?.accountId,
  );
  const capabilities = record(selectedAccount?.capabilities);
  const pools = rows(options.pools).filter(
    (pool) => pool.accountId === selection?.accountId,
  );
  const ips = rows(options.ips).filter(
    (ip) =>
      ip.accountId === selection?.accountId &&
      ip.eligibleSingletonPool === true,
  );
  let routingValue = "automatic";
  if (selection?.mode === "pool") routingValue = `pool:${selection.poolId}`;
  else if (selection?.mode === "ip") routingValue = `ip:${selection.ipId}`;
  return (
    <Stack spacing={1.5}>
      <TextField
        select
        label="ESP account"
        value={selection?.accountId ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const accountId = event.target.value;
          onChange(accountId ? { accountId, mode: "automatic" } : undefined);
        }}
      >
        <MenuItem value="">{emptyLabel}</MenuItem>
        {accounts.map((account) => (
          <MenuItem key={text(account.id)} value={text(account.id)}>
            {text(account.name)} · {text(account.provider)}
          </MenuItem>
        ))}
        {selection && !selectedAccount && (
          <MenuItem value={selection.accountId} disabled>
            Unavailable account
          </MenuItem>
        )}
      </TextField>
      {selection && selectedAccount && (
        <TextField
          select
          label="IP selection"
          value={routingValue}
          disabled={disabled}
          onChange={(event) => {
            const choice = event.target.value;
            if (choice === "automatic") {
              onChange({ accountId: selection.accountId, mode: "automatic" });
            } else if (choice.startsWith("pool:")) {
              onChange({
                accountId: selection.accountId,
                mode: "pool",
                poolId: choice.slice(5),
              });
            } else if (choice.startsWith("ip:")) {
              onChange({
                accountId: selection.accountId,
                mode: "ip",
                ipId: choice.slice(3),
              });
            }
          }}
        >
          {capabilities.automatic === true && (
            <MenuItem value="automatic">Automatic</MenuItem>
          )}
          {capabilities.pool === true &&
            pools.map((pool) => (
              <MenuItem
                key={`pool:${text(pool.id)}`}
                value={`pool:${text(pool.id)}`}
              >
                Pool · {text(pool.name)}
              </MenuItem>
            ))}
          {capabilities.ip === true &&
            ips.map((ip) => (
              <MenuItem key={`ip:${text(ip.id)}`} value={`ip:${text(ip.id)}`}>
                IP via pool · {text(ip.address)}
              </MenuItem>
            ))}
          {selection.mode === "pool" &&
            !pools.some((pool) => pool.id === selection.poolId) && (
              <MenuItem value={routingValue} disabled>
                Unavailable pool
              </MenuItem>
            )}
          {selection.mode === "ip" &&
            !ips.some((ip) => ip.id === selection.ipId) && (
              <MenuItem value={routingValue} disabled>
                Unavailable IP
              </MenuItem>
            )}
        </TextField>
      )}
    </Stack>
  );
}

export function isEspSelection(value: unknown): value is EspSelection {
  const candidate = record(value);
  if (typeof candidate.accountId !== "string") return false;
  if (candidate.mode === "automatic") return true;
  if (candidate.mode === "pool") return typeof candidate.poolId === "string";
  if (candidate.mode === "ip") return typeof candidate.ipId === "string";
  return false;
}
export function NativeSendSelection({
  selection,
  onChange,
  disabled,
}: Omit<SelectionProps, "options">) {
  const { workspace, apiBase } = useAppStorePick(["workspace", "apiBase"]);
  const workspaceId =
    workspace.type === CompletionStatus.Successful ? workspace.value.id : "";
  const isNewsletter =
    workspace.type === CompletionStatus.Successful &&
    Boolean(workspace.value.parentWorkspaceId);
  const options = useQuery({
    queryKey: ["newsletter-sending-options", apiBase, workspaceId],
    enabled: isNewsletter,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{ data: RecordValue }>(
        `${apiBase}/api/publications/sending-options`,
        { params: { workspaceId }, signal },
      );
      return record(response.data.data);
    },
  });
  if (!isNewsletter) return null;
  if (options.isPending)
    return <CircularProgress size={20} aria-label="Loading sending accounts" />;
  if (options.error)
    return <Alert severity="error">{errorText(options.error)}</Alert>;
  const defaultSelection = options.data.selection;
  let effectiveSelection = selection;
  if (selection === undefined) {
    effectiveSelection = isEspSelection(defaultSelection)
      ? defaultSelection
      : undefined;
  }
  return (
    <SendSelection
      options={options.data}
      selection={effectiveSelection}
      onChange={onChange}
      disabled={disabled}
      emptyLabel={
        isEspSelection(defaultSelection)
          ? "Newsletter default"
          : "No account selected"
      }
    />
  );
}

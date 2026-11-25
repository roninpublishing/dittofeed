import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
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
import { FormEvent, ReactNode, useRef, useState } from "react";

import {
  errorText,
  Option,
  PublisherSettingsProps,
  record,
  RecordValue,
  rows,
  text,
} from "./settingsShared";

type Save = (
  path: string,
  payload: RecordValue,
  method?: "put" | "post",
) => Promise<void>;

type Editor =
  | { kind: "ip"; item?: RecordValue }
  | { kind: "pool"; item?: RecordValue }
  | { kind: "route"; item?: RecordValue }
  | { kind: "binding"; pool: RecordValue; item?: RecordValue }
  | { kind: "advanced"; pool: RecordValue }
  | null;

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <TextField
      select
      required
      fullWidth
      size="small"
      label={label}
      value={value}
      disabled={disabled === true || options.length === 0}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <MenuItem key={option.value} value={option.value}>
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

function IpSelect({
  ips,
  selected,
  onChange,
}: {
  ips: RecordValue[];
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <TextField
      select
      fullWidth
      size="small"
      label="IP addresses"
      value={selected}
      SelectProps={{
        multiple: true,
        renderValue: () =>
          selected
            .map((id) => text(ips.find((ip) => ip.id === id)?.address))
            .join(", "),
      }}
      onChange={(event) => {
        const { value } = event.target;
        onChange(typeof value === "string" ? value.split(",") : value);
      }}
    >
      {ips.map((ip) => (
        <MenuItem key={text(ip.id)} value={text(ip.id)}>
          <Checkbox size="small" checked={selected.includes(text(ip.id))} />
          {text(ip.address)}
        </MenuItem>
      ))}
    </TextField>
  );
}

function SettingsDialog({
  title,
  action = "Save",
  onClose,
  onSubmit,
  disabled = false,
  children,
  danger = false,
}: {
  title: string;
  action?: string;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  disabled?: boolean;
  children: ReactNode;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
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
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open fullWidth maxWidth="sm" onClose={busy ? undefined : onClose}>
      <Box component="form" onSubmit={submit}>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Box
            component="fieldset"
            disabled={busy}
            sx={{
              border: 0,
              p: 0,
              m: 0,
              minWidth: 0,
              pointerEvents: busy ? "none" : undefined,
            }}
          >
            <Stack spacing={2} sx={{ pt: 1 }}>
              {children}
            </Stack>
          </Box>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button color="inherit" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            color={danger ? "error" : "primary"}
            disabled={busy || disabled}
          >
            {busy ? "Saving…" : action}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function IpDialog({
  item,
  ips,
  save,
  onClose,
}: {
  item?: RecordValue;
  ips: RecordValue[];
  save: Save;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(item ? text(item.address) : "");
  const [status, setStatus] = useState(item ? text(item.status) : "paused");
  const [hourly, setHourly] = useState(item ? text(item.hourlyLimit) : "");
  const [daily, setDaily] = useState(item ? text(item.dailyLimit) : "");
  const [warmupStart, setWarmupStart] = useState(
    typeof item?.warmupStartedAt === "string" ? item.warmupStartedAt : "",
  );
  const [stages, setStages] = useState(() =>
    rows(item?.warmupSchedule).map((stage, index) => ({
      id: index,
      afterDays: text(stage.afterDays),
      hourlyLimit: text(stage.hourlyLimit),
      dailyLimit: text(stage.dailyLimit),
    })),
  );
  const nextStageId = useRef(stages.length);
  function updateStage(
    id: number,
    field: "afterDays" | "hourlyLimit" | "dailyLimit",
    value: string,
  ) {
    setStages((current) =>
      current.map((stage) =>
        stage.id === id ? { ...stage, [field]: value } : stage,
      ),
    );
  }
  return (
    <SettingsDialog
      title={item ? "Edit IP address" : "Add IP address"}
      onClose={onClose}
      onSubmit={async () => {
        if (item?.warmupStartedAt && !warmupStart) {
          throw new Error("Keep or update the existing warm-up start date.");
        }
        if (!item && ips.some((ip) => ip.address === address.trim())) {
          throw new Error(
            "This IP address is already listed; use Edit instead.",
          );
        }
        const schedule = stages.map((stage) => ({
          afterDays: Number(stage.afterDays),
          hourlyLimit: Number(stage.hourlyLimit),
          dailyLimit: Number(stage.dailyLimit),
        }));
        if (
          schedule.some((stage, index) => {
            const previous = schedule[index - 1];
            return (
              previous !== undefined && stage.afterDays <= previous.afterDays
            );
          })
        ) {
          throw new Error("Warm-up stages must use increasing day numbers.");
        }
        await save("/infrastructure/ips", {
          ...(item ? { id: item.id } : {}),
          address: address.trim(),
          status,
          hourlyLimit: Number(hourly),
          dailyLimit: Number(daily),
          ...(warmupStart ? { warmupStartedAt: warmupStart } : {}),
          warmupSchedule: schedule,
        });
      }}
    >
      <TextField
        size="small"
        label="Existing IP address"
        value={address}
        disabled={!!item}
        required
        inputProps={{ maxLength: 45 }}
        onChange={(event) => setAddress(event.target.value)}
      />
      <SelectField
        label="Status"
        value={status}
        options={[
          { value: "active", label: "Active" },
          { value: "paused", label: "Paused" },
        ]}
        onChange={setStatus}
      />
      <Stack direction="row" spacing={2}>
        <TextField
          fullWidth
          size="small"
          required
          type="number"
          label="Hourly limit"
          value={hourly}
          inputProps={{ min: 1, max: 100000000, step: 1 }}
          onChange={(event) => setHourly(event.target.value)}
        />
        <TextField
          fullWidth
          size="small"
          required
          type="number"
          label="Daily limit"
          value={daily}
          inputProps={{ min: 1, max: 1000000000, step: 1 }}
          onChange={(event) => setDaily(event.target.value)}
        />
      </Stack>
      <TextField
        size="small"
        type="datetime-local"
        label="Warm-up start (UTC)"
        InputLabelProps={{ shrink: true }}
        inputProps={{ step: 0.001 }}
        value={
          warmupStart ? new Date(warmupStart).toISOString().slice(0, -1) : ""
        }
        onChange={(event) =>
          setWarmupStart(event.target.value ? `${event.target.value}Z` : "")
        }
      />
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle2">Warm-up stages</Typography>
        <Button
          size="small"
          disabled={stages.length >= 366}
          onClick={() => {
            const id = nextStageId.current;
            nextStageId.current += 1;
            setStages((current) => {
              const previous = current[current.length - 1];
              return [
                ...current,
                {
                  id,
                  afterDays: previous
                    ? String(Number(previous.afterDays) + 1)
                    : "0",
                  hourlyLimit: "",
                  dailyLimit: "",
                },
              ];
            });
          }}
        >
          Add stage
        </Button>
      </Stack>
      {stages.map((stage, index) => (
        <Stack key={stage.id} direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            required
            type="number"
            label="After days"
            value={stage.afterDays}
            inputProps={{ min: 0, step: 1 }}
            onChange={(event) =>
              updateStage(stage.id, "afterDays", event.target.value)
            }
          />
          <TextField
            size="small"
            required
            type="number"
            label="Hourly"
            value={stage.hourlyLimit}
            inputProps={{ min: 1, max: 2147483647, step: 1 }}
            onChange={(event) =>
              updateStage(stage.id, "hourlyLimit", event.target.value)
            }
          />
          <TextField
            size="small"
            required
            type="number"
            label="Daily"
            value={stage.dailyLimit}
            inputProps={{ min: 1, max: 2147483647, step: 1 }}
            onChange={(event) =>
              updateStage(stage.id, "dailyLimit", event.target.value)
            }
          />
          <Button
            size="small"
            color="inherit"
            aria-label={`Remove warm-up stage ${index + 1}`}
            onClick={() =>
              setStages((current) =>
                current.filter((candidate) => candidate.id !== stage.id),
              )
            }
          >
            Remove
          </Button>
        </Stack>
      ))}
    </SettingsDialog>
  );
}

function PoolDialog({
  item,
  ips,
  memberships,
  save,
  onClose,
}: {
  item?: RecordValue;
  ips: RecordValue[];
  memberships: RecordValue[];
  save: Save;
  onClose: () => void;
}) {
  const [name, setName] = useState(item ? text(item.name) : "");
  const [ipIds, setIpIds] = useState(() =>
    memberships
      .filter((membership) => membership.poolId === item?.id)
      .map((membership) => text(membership.ipId)),
  );
  return (
    <SettingsDialog
      title={item ? "Edit pool" : "Add pool"}
      onClose={onClose}
      disabled={!ipIds.length || ipIds.length > 100}
      onSubmit={() =>
        save("/infrastructure/pools", {
          ...(item ? { id: item.id } : {}),
          name: name.trim(),
          ipIds,
        })
      }
    >
      <TextField
        size="small"
        required
        label="Pool name"
        value={name}
        inputProps={{ maxLength: 64 }}
        onChange={(event) => setName(event.target.value)}
      />
      <IpSelect ips={ips} selected={ipIds} onChange={setIpIds} />
      {!ips.length && <Alert severity="info">Add an IP address first.</Alert>}
    </SettingsDialog>
  );
}

function connectionLabel(connection: RecordValue) {
  if (typeof connection.username === "string" && connection.username) {
    return connection.username;
  }
  if (
    typeof connection.administrativeEmail === "string" &&
    connection.administrativeEmail
  ) {
    return connection.administrativeEmail;
  }
  return "Sending connection";
}

function RouteDialog({
  item,
  newsletters,
  connections,
  pools,
  memberships,
  bindings,
  save,
  onClose,
}: {
  item?: RecordValue;
  newsletters: Option[];
  connections: RecordValue[];
  pools: RecordValue[];
  memberships: RecordValue[];
  bindings: RecordValue[];
  save: Save;
  onClose: () => void;
}) {
  const [newsletterId, setNewsletterId] = useState(
    item ? text(item.newsletterId) : "",
  );
  const [connectionId, setConnectionId] = useState(
    item ? text(item.connectionId) : "",
  );
  const [poolId, setPoolId] = useState(item ? text(item.poolId) : "");
  const [confirming, setConfirming] = useState(false);
  const availableConnections = connections.filter(
    (connection) => connection.newsletterId === newsletterId,
  );
  const availablePools = pools.filter(
    (pool) =>
      memberships.filter((membership) => membership.poolId === pool.id)
        .length === 1 &&
      bindings.some(
        (binding) =>
          binding.poolId === pool.id && binding.connectionId === connectionId,
      ),
  );
  const changed =
    !item || connectionId !== item.connectionId || poolId !== item.poolId;
  const title = item ? "Edit route" : "Add route";
  const action = item ? "Continue" : "Save route";
  return (
    <SettingsDialog
      title={confirming ? "Change route?" : title}
      action={confirming ? "Change route" : action}
      onClose={onClose}
      disabled={
        !newsletterId ||
        !connectionId ||
        !availablePools.some((pool) => pool.id === poolId) ||
        !changed
      }
      onSubmit={async () => {
        if (item && !confirming) {
          setConfirming(true);
          return;
        }
        await save("/infrastructure/routes", {
          newsletterId,
          connectionId,
          poolId,
        });
      }}
    >
      {confirming ? (
        <>
          <Alert severity="warning">
            Future sends use this route; existing attempts keep their pinned
            route.
          </Alert>
          <Typography>
            {
              newsletters.find(
                (newsletter) => newsletter.value === newsletterId,
              )?.label
            }{" "}
            →{" "}
            {connectionLabel(
              connections.find(
                (connection) => connection.id === connectionId,
              ) ?? {},
            )}{" "}
            · {text(pools.find((pool) => pool.id === poolId)?.name)}
          </Typography>
          <Button
            size="small"
            color="inherit"
            onClick={() => setConfirming(false)}
          >
            Back
          </Button>
        </>
      ) : (
        <>
          <SelectField
            label="Newsletter"
            value={newsletterId}
            options={newsletters}
            disabled={!!item}
            onChange={(value) => {
              setNewsletterId(value);
              setConnectionId("");
              setPoolId("");
            }}
          />
          <SelectField
            label="Sending connection"
            value={connectionId}
            options={availableConnections.map((connection) => ({
              value: text(connection.id),
              label: connectionLabel(connection),
            }))}
            onChange={(value) => {
              setConnectionId(value);
              setPoolId("");
            }}
          />
          <SelectField
            label="Pool"
            value={poolId}
            options={availablePools.map((pool) => ({
              value: text(pool.id),
              label: text(pool.name),
            }))}
            onChange={setPoolId}
          />
          {newsletterId && !availableConnections.length && (
            <Alert severity="info">
              No sending connections for this newsletter.
            </Alert>
          )}
          {connectionId && !availablePools.length && (
            <Alert severity="info">
              Map a single-IP pool to this connection first.
            </Alert>
          )}
        </>
      )}
    </SettingsDialog>
  );
}

function BindingDialog({
  pool,
  item,
  connections,
  newsletters,
  allowProviderWrites,
  singleIp,
  save,
  onClose,
}: {
  pool: RecordValue;
  item?: RecordValue;
  connections: RecordValue[];
  newsletters: Option[];
  allowProviderWrites: boolean;
  singleIp: boolean;
  save: Save;
  onClose: () => void;
}) {
  const [connectionId, setConnectionId] = useState(
    item ? text(item.connectionId) : "",
  );
  const [providerPoolName, setProviderPoolName] = useState(
    item ? text(item.providerPoolName) : "",
  );
  const [confirming, setConfirming] = useState(false);
  const title = item
    ? `SendGrid pool · ${text(pool.name)}`
    : `Link account · ${text(pool.name)}`;
  return (
    <SettingsDialog
      title={confirming ? "Sync SendGrid pool?" : title}
      action={confirming ? "Sync pool" : "Save link"}
      danger={confirming}
      onClose={onClose}
      disabled={
        !connectionId ||
        !providerPoolName.trim() ||
        (confirming && (!allowProviderWrites || !singleIp))
      }
      onSubmit={async () => {
        if (confirming && !allowProviderWrites)
          throw new Error("Provider changes are paused.");
        if (confirming && !singleIp)
          throw new Error("SendGrid sync requires a single-IP pool.");
        await save(
          confirming
            ? "/infrastructure/pool-bindings/reconcile"
            : "/infrastructure/pool-bindings",
          {
            connectionId,
            poolId: pool.id,
            providerPoolName: providerPoolName.trim(),
          },
          confirming ? "post" : "put",
        );
      }}
    >
      {confirming ? (
        <>
          <Alert severity="warning">
            This may create or change the SendGrid pool for the selected
            connection.
          </Alert>
          <Typography>
            {connectionLabel(
              connections.find(
                (connection) => connection.id === connectionId,
              ) ?? {},
            )}{" "}
            · {providerPoolName}
          </Typography>
          <Button
            size="small"
            color="inherit"
            onClick={() => setConfirming(false)}
          >
            Back
          </Button>
        </>
      ) : (
        <>
          <SelectField
            label="Sending connection"
            value={connectionId}
            options={connections.map((connection) => ({
              value: text(connection.id),
              label: `${newsletters.find((newsletter) => newsletter.value === connection.newsletterId)?.label ?? "Newsletter"} · ${connectionLabel(connection)}`,
            }))}
            onChange={(value) => {
              setConnectionId(value);
              setProviderPoolName("");
            }}
          />
          <TextField
            size="small"
            required
            label="SendGrid pool name"
            value={providerPoolName}
            inputProps={{ maxLength: 64 }}
            onChange={(event) => setProviderPoolName(event.target.value)}
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              size="small"
              disabled={
                !allowProviderWrites ||
                !singleIp ||
                !connectionId ||
                !providerPoolName.trim()
              }
              onClick={() => setConfirming(true)}
            >
              Sync with SendGrid…
            </Button>
            {!allowProviderWrites && (
              <Chip size="small" label="Provider changes paused" />
            )}
          </Stack>
          {!singleIp && (
            <Alert severity="info">
              SendGrid sync requires a single-IP pool.
            </Alert>
          )}
        </>
      )}
    </SettingsDialog>
  );
}

function ReassignmentDialog({
  pool,
  connections,
  newsletters,
  ips,
  memberIds,
  allowed,
  save,
  onClose,
}: {
  pool: RecordValue;
  connections: RecordValue[];
  newsletters: Option[];
  ips: RecordValue[];
  memberIds: string[];
  allowed: boolean;
  save: Save;
  onClose: () => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [ipIds, setIpIds] = useState(memberIds);
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingsDialog
      title={
        confirming ? "Reassign physical IPs?" : `Advanced · ${text(pool.name)}`
      }
      action={confirming ? "Reassign IPs" : "Continue"}
      danger
      onClose={onClose}
      disabled={!allowed || !connectionId || !ipIds.length}
      onSubmit={async () => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        if (!allowed) throw new Error("IP reassignment is paused.");
        await save(
          "/infrastructure/ip-reassignment",
          { connectionId, ipIds, confirm: true },
          "post",
        );
      }}
    >
      {confirming ? (
        <>
          <Alert severity="warning">
            This replaces the connection’s physical IP assignment in SendGrid
            and may affect live traffic.
          </Alert>
          <Typography>
            {connectionLabel(
              connections.find(
                (connection) => connection.id === connectionId,
              ) ?? {},
            )}{" "}
            →{" "}
            {ipIds
              .map((id) => text(ips.find((ip) => ip.id === id)?.address))
              .join(", ")}
          </Typography>
          <Button
            size="small"
            color="inherit"
            onClick={() => setConfirming(false)}
          >
            Back
          </Button>
        </>
      ) : (
        <>
          <Typography variant="subtitle2">Physical IP reassignment</Typography>
          <SelectField
            label="Sending connection"
            value={connectionId}
            options={connections.map((connection) => ({
              value: text(connection.id),
              label: `${newsletters.find((newsletter) => newsletter.value === connection.newsletterId)?.label ?? "Newsletter"} · ${connectionLabel(connection)}`,
            }))}
            onChange={setConnectionId}
          />
          <IpSelect ips={ips} selected={ipIds} onChange={setIpIds} />
          {!allowed && (
            <Chip
              size="small"
              label="IP reassignment paused"
              sx={{ alignSelf: "flex-start" }}
            />
          )}
        </>
      )}
    </SettingsDialog>
  );
}

export default function IpPoolSettings({
  workspaceId,
  apiBase,
  infrastructure,
  newsletters,
  onComplete,
}: PublisherSettingsProps) {
  const [editor, setEditor] = useState<Editor>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const ips = rows(infrastructure.ips);
  const pools = rows(infrastructure.pools);
  const memberships = rows(infrastructure.memberships);
  const connections = rows(infrastructure.connections);
  const bindings = rows(infrastructure.bindings);
  const routes = rows(infrastructure.routes);
  const account = record(infrastructure.account);
  const allowProviderWrites = account.allowProviderWrites === true;
  const allowReassignment =
    allowProviderWrites && account.allowIpReassignment === true;
  const unroutedNewsletters = newsletters.filter(
    (newsletter) =>
      !routes.some((route) => route.newsletterId === newsletter.value),
  );
  function memberIds(poolId: unknown) {
    return memberships
      .filter((membership) => membership.poolId === poolId)
      .map((membership) => text(membership.ipId));
  }
  const close = () => setEditor(null);
  const save: Save = async (path, payload, method = "put") => {
    await axios[method](`${apiBase}/api/publications${path}`, {
      workspaceId,
      ...payload,
    });
    close();
    let message = "Changes saved.";
    if (path.endsWith("/reconcile")) {
      message = "SendGrid pool sync completed.";
    } else if (path.endsWith("/ip-reassignment")) {
      message = "IP reassignment completed.";
    }
    setNotice(message);
    setRefreshError(false);
    try {
      await onComplete();
    } catch {
      setRefreshError(true);
    }
  };
  return (
    <Stack spacing={3}>
      {notice && (
        <Alert severity="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {refreshError && (
        <Alert severity="warning">
          Saved; reload to see the latest settings.
        </Alert>
      )}
      <Box>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 1 }}
        >
          <Typography variant="h6">IP pools</Typography>
          <Button
            size="small"
            variant="contained"
            disabled={!ips.length}
            onClick={() => setEditor({ kind: "pool" })}
          >
            Add pool
          </Button>
        </Stack>
        {!pools.length ? (
          <Typography color="text.secondary">No IP pools.</Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="IP pools">
              <TableHead>
                <TableRow>
                  <TableCell>Pool</TableCell>
                  <TableCell>IP addresses</TableCell>
                  <TableCell>Sending accounts</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pools.map((pool) => (
                  <TableRow key={text(pool.id)}>
                    <TableCell>{text(pool.name)}</TableCell>
                    <TableCell>
                      {memberIds(pool.id)
                        .map((id) =>
                          text(ips.find((ip) => ip.id === id)?.address),
                        )
                        .join(", ") || "No IP addresses"}
                    </TableCell>
                    <TableCell>
                      <Stack alignItems="flex-start" spacing={0.5}>
                        {bindings
                          .filter((binding) => binding.poolId === pool.id)
                          .map((binding) => (
                            <Button
                              key={text(binding.id)}
                              size="small"
                              color="inherit"
                              onClick={() =>
                                setEditor({
                                  kind: "binding",
                                  pool,
                                  item: binding,
                                })
                              }
                            >
                              {connectionLabel(
                                connections.find(
                                  (connection) =>
                                    connection.id === binding.connectionId,
                                ) ?? {},
                              )}{" "}
                              · {text(binding.providerPoolName)}
                            </Button>
                          ))}
                        <Button
                          size="small"
                          onClick={() => setEditor({ kind: "binding", pool })}
                        >
                          Link account
                        </Button>
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                      <Button
                        size="small"
                        onClick={() => setEditor({ kind: "pool", item: pool })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        color="inherit"
                        onClick={() => setEditor({ kind: "advanced", pool })}
                      >
                        Advanced…
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>
      <Box>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 1 }}
        >
          <Typography variant="h6">IP addresses</Typography>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setEditor({ kind: "ip" })}
          >
            Add IP address
          </Button>
        </Stack>
        {!ips.length ? (
          <Typography color="text.secondary">No IP addresses.</Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="IP addresses">
              <TableHead>
                <TableRow>
                  <TableCell>Address</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Hourly limit</TableCell>
                  <TableCell>Daily limit</TableCell>
                  <TableCell>Warm-up</TableCell>
                  <TableCell>Pools</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {ips.map((ip) => (
                  <TableRow key={text(ip.id)}>
                    <TableCell>{text(ip.address)}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={ip.status === "active" ? "Active" : "Paused"}
                        color={ip.status === "active" ? "success" : "default"}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{text(ip.hourlyLimit)}</TableCell>
                    <TableCell>{text(ip.dailyLimit)}</TableCell>
                    <TableCell>
                      {rows(ip.warmupSchedule).length
                        ? `${rows(ip.warmupSchedule).length} stages`
                        : "None"}
                      {typeof ip.warmupStartedAt === "string" && (
                        <Typography variant="caption" display="block">
                          {new Date(ip.warmupStartedAt).toLocaleString()}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {memberships
                        .filter((membership) => membership.ipId === ip.id)
                        .map((membership) =>
                          text(
                            pools.find((pool) => pool.id === membership.poolId)
                              ?.name,
                          ),
                        )
                        .join(", ") || "—"}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() => setEditor({ kind: "ip", item: ip })}
                      >
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>
      <Box>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 1 }}
        >
          <Typography variant="h6">Newsletter routes</Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={
              !unroutedNewsletters.length ||
              !connections.length ||
              !pools.length
            }
            onClick={() => setEditor({ kind: "route" })}
          >
            Add route
          </Button>
        </Stack>
        {!routes.length ? (
          <Typography color="text.secondary">No newsletter routes.</Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Newsletter routes">
              <TableHead>
                <TableRow>
                  <TableCell>Newsletter</TableCell>
                  <TableCell>Sending connection</TableCell>
                  <TableCell>Pool</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {routes.map((route) => (
                  <TableRow key={text(route.newsletterId)}>
                    <TableCell>
                      {newsletters.find(
                        (newsletter) => newsletter.value === route.newsletterId,
                      )?.label ?? "Newsletter unavailable"}
                    </TableCell>
                    <TableCell>
                      {connectionLabel(
                        connections.find(
                          (connection) => connection.id === route.connectionId,
                        ) ?? {},
                      )}
                    </TableCell>
                    <TableCell>
                      {text(
                        pools.find((pool) => pool.id === route.poolId)?.name,
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() =>
                          setEditor({ kind: "route", item: route })
                        }
                      >
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>
      {editor?.kind === "ip" && (
        <IpDialog item={editor.item} ips={ips} save={save} onClose={close} />
      )}
      {editor?.kind === "pool" && (
        <PoolDialog
          item={editor.item}
          ips={ips}
          memberships={memberships}
          save={save}
          onClose={close}
        />
      )}
      {editor?.kind === "route" && (
        <RouteDialog
          item={editor.item}
          newsletters={editor.item ? newsletters : unroutedNewsletters}
          connections={connections}
          pools={pools}
          memberships={memberships}
          bindings={bindings}
          save={save}
          onClose={close}
        />
      )}
      {editor?.kind === "binding" && (
        <BindingDialog
          pool={editor.pool}
          item={editor.item}
          newsletters={newsletters}
          connections={connections}
          allowProviderWrites={allowProviderWrites}
          singleIp={memberIds(editor.pool.id).length === 1}
          save={save}
          onClose={close}
        />
      )}
      {editor?.kind === "advanced" && (
        <ReassignmentDialog
          pool={editor.pool}
          newsletters={newsletters}
          connections={connections}
          ips={ips}
          memberIds={memberIds(editor.pool.id)}
          allowed={allowReassignment}
          save={save}
          onClose={close}
        />
      )}
    </Stack>
  );
}

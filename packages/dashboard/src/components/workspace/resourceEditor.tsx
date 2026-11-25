import {
  Alert,
  Button,
  Checkbox,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import axios from "axios";
import { useRef, useState } from "react";

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
  const [providerName, setProviderName] = useState(
    typeof item?.providerPoolName === "string" ? item.providerPoolName : "",
  );
  const [status, setStatus] = useState(
    typeof item?.status === "string" ? item.status : "paused",
  );
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
  const nextStage = useRef(stages.length);
  const [ipIds, setIpIds] = useState(() =>
    rows(infrastructure.memberships)
      .filter((member) => item && member.poolId === item.id)
      .map((member) => text(member.ipId)),
  );
  const ownedIps = ips.filter((ip) => ip.accountId === owner);
  const updateStage = (
    id: number,
    key: "afterDays" | "hourlyLimit" | "dailyLimit",
    value: string,
  ) =>
    setStages((current) =>
      current.map((stage) =>
        stage.id === id ? { ...stage, [key]: value } : stage,
      ),
    );
  const warmupDate = warmupStart ? new Date(warmupStart) : null;
  return (
    <EditorDialog
      title={`${item ? "Edit" : "Add"} ${kind === "ips" ? "IP address" : "IP pool"}`}
      disabled={
        !owner || (kind === "pools" && (!ipIds.length || ipIds.length > 100))
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
        const schedule = stages.map((stage) => ({
          afterDays: Number(stage.afterDays),
          hourlyLimit: Number(stage.hourlyLimit),
          dailyLimit: Number(stage.dailyLimit),
        }));
        if (
          schedule.some(
            (stage, index) =>
              index > 0 &&
              stage.afterDays <= (schedule[index - 1]?.afterDays ?? -1),
          )
        )
          throw new Error("Warm-up stages must use increasing day numbers.");
        await axios.put(`${apiBase}/api/publications/infrastructure/${kind}`, {
          workspaceId,
          accountId: owner,
          ...(item ? { id: item.id } : {}),
          ...(kind === "ips"
            ? {
                address: address.trim(),
                status,
                hourlyLimit: Number(hourly),
                dailyLimit: Number(daily),
                warmupStartedAt: warmupDate ? warmupDate.toISOString() : null,
                warmupSchedule: schedule,
              }
            : {
                name: name.trim(),
                ...(providerName.trim()
                  ? { providerPoolName: providerName.trim() }
                  : {}),
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
            label="Existing IP address"
            required
            disabled={Boolean(item)}
            value={address}
            inputProps={{ maxLength: 45 }}
            onChange={(event) => setAddress(event.target.value)}
          />
          <TextField
            select
            size="small"
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="paused">Paused</MenuItem>
          </TextField>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
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
              warmupDate && !Number.isNaN(warmupDate.getTime())
                ? warmupDate.toISOString().slice(0, -1)
                : ""
            }
            onChange={(event) =>
              setWarmupStart(event.target.value ? `${event.target.value}Z` : "")
            }
          />
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
          >
            <Typography variant="subtitle2">Warm-up stages</Typography>
            <Button
              disabled={stages.length >= 366}
              onClick={() => {
                const id = nextStage.current;
                nextStage.current += 1;
                setStages((current) => [
                  ...current,
                  {
                    id,
                    afterDays: String(
                      Number(current[current.length - 1]?.afterDays ?? -1) + 1,
                    ),
                    hourlyLimit: "",
                    dailyLimit: "",
                  },
                ]);
              }}
            >
              Add stage
            </Button>
          </Stack>
          {stages.map((stage, index) => (
            <Stack
              key={stage.id}
              spacing={1}
              direction={{ xs: "column", sm: "row" }}
            >
              {(["afterDays", "hourlyLimit", "dailyLimit"] as const).map(
                (key) => (
                  <TextField
                    key={key}
                    size="small"
                    required
                    type="number"
                    label={
                      {
                        afterDays: "After days",
                        hourlyLimit: "Hourly",
                        dailyLimit: "Daily",
                      }[key]
                    }
                    value={stage[key]}
                    inputProps={{ min: key === "afterDays" ? 0 : 1, step: 1 }}
                    onChange={(event) =>
                      updateStage(stage.id, key, event.target.value)
                    }
                  />
                ),
              )}
              <Button
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
        </>
      ) : (
        <>
          <TextField
            size="small"
            required
            label="Pool name"
            value={name}
            inputProps={{ maxLength: 64 }}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            size="small"
            label="SendGrid pool name (defaults to pool name)"
            value={providerName}
            inputProps={{ maxLength: 64 }}
            onChange={(event) => setProviderName(event.target.value)}
          />
          <TextField
            select
            size="small"
            label="Member IPs"
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
            <Alert severity="info">No IPs for this account</Alert>
          )}
        </>
      )}
    </EditorDialog>
  );
}

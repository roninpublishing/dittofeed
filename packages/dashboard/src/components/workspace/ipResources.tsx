import {
  Alert,
  Box,
  Button,
  Chip,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import dynamic from "next/dynamic";
import { useState } from "react";

import {
  errorText,
  record,
  RecordValue,
  rows,
  text,
} from "../publications/settingsShared";
import {
  DataTable,
  date,
  EditorDialog,
  InfrastructureProps,
  value,
} from "./infrastructureShared";
import Link from "./navigation";

const ResourceEditor = dynamic(() => import("./resourceEditor"));

function IpResourcesContent(props: InfrastructureProps) {
  const {
    workspaceId,
    apiBase,
    infrastructure,
    onComplete,
    accountId,
    resourceId,
    kind = "ips",
  } = props;
  const accounts = rows(infrastructure.accounts);
  const ips = rows(infrastructure.ips);
  const pools = rows(infrastructure.pools);
  const memberships = rows(infrastructure.memberships);
  const items = kind === "ips" ? ips : pools;
  const selected = resourceId
    ? items.find(
        (item) =>
          item.id === resourceId &&
          (!accountId || item.accountId === accountId),
      )
    : undefined;
  const [filter, setFilter] = useState(accountId ?? "");
  const [editor, setEditor] = useState<{ item?: RecordValue } | null>(null);
  const [operation, setOperation] = useState<"reconcile" | "reassign" | null>(
    null,
  );
  const healthAccount = selected?.accountId ?? filter;
  const health = useQuery({
    queryKey: [
      "publication-management",
      apiBase,
      workspaceId,
      "health",
      healthAccount || "",
    ],
    staleTime: 15_000,
    queryFn: async () =>
      record(
        record(
          (
            await axios.get(`${apiBase}/api/publications/delivery-health`, {
              params: {
                workspaceId,
                ...(healthAccount ? { accountId: healthAccount } : {}),
              },
            })
          ).data,
        ).data,
      ),
  });
  const currentHealth = (ip: RecordValue) =>
    rows(health.data?.ips).find((item) => item.id === ip.id);
  const owner = (item: RecordValue) =>
    accounts.find((account) => account.id === item.accountId);
  const memberIps = (pool: RecordValue) =>
    memberships
      .filter((membership) => membership.poolId === pool.id)
      .map((membership) => ips.find((ip) => ip.id === membership.ipId))
      .filter((ip): ip is RecordValue => ip !== undefined);
  const accountLink = (item: RecordValue) => {
    const account = owner(item);
    return account ? (
      <Link href={`/workspace/esp-accounts/${text(account.id)}`}>
        {text(account.name)}
      </Link>
    ) : (
      "Unknown"
    );
  };
  const path = kind === "ips" ? "ips" : "ip-pools";
  const label = kind === "ips" ? "Dedicated IPs" : "Shared IPs";
  const account = selected ? owner(selected) : undefined;
  const allowed =
    account?.allowProviderWrites === true &&
    account.hasManagementKey === true &&
    typeof account.connectionId === "string";
  const reassignmentAllowed = allowed && account.allowIpReassignment === true;
  const binding = selected
    ? rows(infrastructure.bindings).find(
        (item) =>
          item.poolId === selected.id &&
          item.connectionId === account?.connectionId,
      )
    : undefined;
  let selectedMembers: RecordValue[] = [];
  if (selected)
    selectedMembers = kind === "ips" ? [selected] : memberIps(selected);
  let providerPoolName = text(selected?.name);
  if (typeof binding?.providerPoolName === "string")
    providerPoolName = binding.providerPoolName;
  if (typeof selected?.providerPoolName === "string")
    providerPoolName = selected.providerPoolName;
  const resourceColumns =
    kind === "ips"
      ? [
          {
            label: "Dedicated IP",
            render: (item: RecordValue) => (
              <Link href={`/workspace/ips/${text(item.id)}`}>
                {text(item.address)}
              </Link>
            ),
          },
          { label: "ESP account", render: accountLink },
          {
            label: "Status",
            render: (item: RecordValue) => (
              <Chip size="small" label={text(item.status)} />
            ),
          },
          {
            label: "Hourly / daily cap",
            render: (item: RecordValue) =>
              `${text(item.hourlyLimit)} / ${text(item.dailyLimit)}`,
          },
          {
            label: "Warm-up",
            render: (item: RecordValue) =>
              item.warmupStartedAt ? date(item.warmupStartedAt) : "Not started",
          },
          {
            label: "Reserved this hour / day",
            render: (item: RecordValue) => {
              const windows = rows(currentHealth(item)?.windows);
              return currentHealth(item)
                ? `${windows.find((window) => window.windowSeconds === 3600)?.reserved ?? 0} / ${windows.find((window) => window.windowSeconds === 86400)?.reserved ?? 0}`
                : "Unknown";
            },
          },
          {
            label: "Actions",
            render: (item: RecordValue) => (
              <Button
                size="small"
                onClick={() => setEditor({ item })}
                aria-label={`Edit IP ${text(item.address)}`}
              >
                Edit
              </Button>
            ),
          },
        ]
      : [
          {
            label: "Pool",
            render: (item: RecordValue) => (
              <Link href={`/workspace/ip-pools/${text(item.id)}`}>
                {text(item.name)}
              </Link>
            ),
          },
          { label: "ESP account", render: accountLink },
          {
            label: "Provider pool",
            render: (item: RecordValue) => value(item.providerPoolName),
          },
          {
            label: "Members",
            render: (item: RecordValue) =>
              memberIps(item)
                .map((ip) => text(ip.address))
                .join(", ") || "None",
          },
          {
            label: "Member status",
            render: (item: RecordValue) =>
              memberIps(item)
                .map((ip) => `${text(ip.address)}: ${text(ip.status)}`)
                .join(", ") || "Unknown",
          },
          {
            label: "Member hourly / daily caps",
            render: (item: RecordValue) =>
              memberIps(item)
                .map(
                  (ip) =>
                    `${text(ip.address)}: ${text(ip.hourlyLimit)} / ${text(ip.dailyLimit)}`,
                )
                .join(", ") || "Unknown",
          },
          {
            label: "Verification",
            render: (item: RecordValue) => {
              const stored = rows(infrastructure.bindings).find(
                (entry) =>
                  entry.poolId === item.id &&
                  entry.connectionId === owner(item)?.connectionId,
              );
              return stored?.verifiedAt
                ? `Verified ${date(stored.verifiedAt)}`
                : "Not verified";
            },
          },
          {
            label: "Actions",
            render: (item: RecordValue) => (
              <Button
                size="small"
                onClick={() => setEditor({ item })}
                aria-label={`Edit pool ${text(item.name)}`}
              >
                Edit
              </Button>
            ),
          },
        ];
  if (resourceId && !selected)
    return (
      <Alert severity="warning">
        {kind === "ips" ? "Dedicated IP" : "Shared IP pool"} not found in this
        workspace
      </Alert>
    );
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      {selected ? (
        <>
          <Stack
            direction="row"
            spacing={1}
            flexWrap="wrap"
            alignItems="center"
            useFlexGap
          >
            <Button
              component={Link}
              href={`/workspace/${path}`}
              color="inherit"
            >
              {label}
            </Button>
            <Typography>/</Typography>
            {accountLink(selected)}
            <Typography>/</Typography>
            <Typography
              component={accountId ? "h2" : "h1"}
              variant={accountId ? "h4" : "h2"}
            >
              {text(selected.address ?? selected.name)}
            </Typography>
            <Button onClick={() => setEditor({ item: selected })}>Edit</Button>
          </Stack>
          <DataTable
            label={`${label} configuration`}
            data={[selected]}
            columns={resourceColumns.filter(
              (column) => column.label !== "Actions",
            )}
          />
          {kind === "ips" && (
            <>
              <Typography variant="subtitle2">Warm-up schedule</Typography>
              <DataTable
                label="IP warm-up schedule"
                data={rows(selected.warmupSchedule)}
                columns={[
                  {
                    label: "After days",
                    render: (stage) => text(stage.afterDays),
                  },
                  {
                    label: "Hourly cap",
                    render: (stage) => text(stage.hourlyLimit),
                  },
                  {
                    label: "Daily cap",
                    render: (stage) => text(stage.dailyLimit),
                  },
                ]}
              />
              <Typography variant="subtitle2">Current admission</Typography>
              <DataTable
                label="IP admission windows"
                data={rows(currentHealth(selected)?.windows)}
                columns={[
                  {
                    label: "Window start",
                    render: (window) => date(window.windowStart),
                  },
                  {
                    label: "Window seconds",
                    render: (window) => text(window.windowSeconds),
                  },
                  {
                    label: "Reserved",
                    render: (window) => text(window.reserved),
                  },
                ]}
              />
              <Typography variant="body2">
                Current hourly / daily cap:{" "}
                {value(record(currentHealth(selected)?.currentLimits).hourly)} /{" "}
                {value(record(currentHealth(selected)?.currentLimits).daily)}
              </Typography>
            </>
          )}
          {kind === "pools" && (
            <>
              <Typography variant="subtitle2">Dedicated IPs</Typography>
              <DataTable
                label="Shared pool dedicated IPs"
                data={selectedMembers}
                columns={[
                  {
                    label: "Dedicated IP",
                    render: (ip) => (
                      <Link href={`/workspace/ips/${text(ip.id)}`}>
                        {text(ip.address)}
                      </Link>
                    ),
                  },
                  { label: "Status", render: (ip) => text(ip.status) },
                  { label: "Hourly cap", render: (ip) => text(ip.hourlyLimit) },
                  { label: "Daily cap", render: (ip) => text(ip.dailyLimit) },
                  {
                    label: "Warm-up start",
                    render: (ip) =>
                      ip.warmupStartedAt
                        ? date(ip.warmupStartedAt)
                        : "Not started",
                  },
                ]}
              />
            </>
          )}
          {kind === "pools" && (
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <Button
                disabled={!allowed || !selectedMembers.length}
                onClick={() => setOperation("reconcile")}
              >
                Sync pool…
              </Button>
              {!allowed && (
                <Chip size="small" label="Provider changes not authorized" />
              )}
            </Stack>
          )}
          <Box component="details">
            <Box
              component="summary"
              sx={{ cursor: "pointer", typography: "subtitle2" }}
            >
              Advanced
            </Box>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              flexWrap="wrap"
              alignItems="center"
              sx={{ pt: 1 }}
            >
              <Button
                disabled={!reassignmentAllowed || !selectedMembers.length}
                onClick={() => setOperation("reassign")}
              >
                Reassign provider IPs…
              </Button>
              {!reassignmentAllowed && (
                <Chip size="small" label="IP reassignment not authorized" />
              )}
            </Stack>
          </Box>
          <Typography variant="subtitle2">Observed delivery events</Typography>
          <DataTable
            label="Resource delivery observations"
            data={rows(health.data?.observations).filter((observation) =>
              selectedMembers.some((ip) => ip.id === observation.ipId),
            )}
            columns={[
              { label: "Historical IP", render: (item) => value(item.ipId) },
              { label: "Observation", render: (item) => text(item.event) },
              {
                label: "Sends with observation",
                render: (item) => value(item.sendsWithEvent),
              },
            ]}
          />
        </>
      ) : (
        <>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            useFlexGap
            flexWrap="wrap"
            spacing={1}
          >
            <Typography
              component={accountId ? "h2" : "h1"}
              variant={accountId ? "h4" : "h2"}
            >
              {label}
            </Typography>
            <Button
              variant="contained"
              disabled={!accounts.length}
              onClick={() => setEditor({})}
            >
              Add {kind === "ips" ? "dedicated IP" : "shared IP pool"}
            </Button>
          </Stack>
          {!accountId && (
            <TextField
              select
              size="small"
              label="ESP account"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              sx={{ maxWidth: 320 }}
            >
              <MenuItem value="">All accounts</MenuItem>
              {accounts.map((item) => (
                <MenuItem key={text(item.id)} value={text(item.id)}>
                  {text(item.name)}
                </MenuItem>
              ))}
            </TextField>
          )}
          {!accounts.length && (
            <Button
              component={Link}
              href="/workspace/esp-accounts"
              sx={{ alignSelf: "flex-start" }}
            >
              Add account
            </Button>
          )}
          <DataTable
            label={`Workspace ${label}`}
            data={items.filter((item) => !filter || item.accountId === filter)}
            columns={resourceColumns}
          />
        </>
      )}
      {health.isError && (
        <Alert severity="warning">
          Observed health unavailable: {errorText(health.error)}
        </Alert>
      )}
      {editor && (
        <ResourceEditor
          {...props}
          accountId={
            editor.item ? text(editor.item.accountId) : filter || undefined
          }
          item={editor.item}
          onClose={() => setEditor(null)}
        />
      )}
      {operation && selected && account && (
        <EditorDialog
          title={
            operation === "reconcile" ? "Sync pool" : "Reassign provider IPs"
          }
          action={operation === "reconcile" ? "Sync pool" : "Reassign IPs"}
          confirmation={
            operation === "reconcile"
              ? `Create or change SendGrid pool ${providerPoolName} in ${text(account.name)}?`
              : `Replace the provider IP assignment for ${text(account.name)} with ${selectedMembers.map((ip) => text(ip.address)).join(", ")}? This may affect live traffic.`
          }
          disabled={operation === "reconcile" ? !allowed : !reassignmentAllowed}
          onClose={() => setOperation(null)}
          onSubmit={async () => {
            if (!allowed || (operation === "reassign" && !reassignmentAllowed))
              throw new Error("Provider changes are not authorized.");
            await axios.post(
              `${apiBase}/api/publications/infrastructure/${operation === "reconcile" ? "pool-bindings/reconcile" : "ip-reassignment"}`,
              {
                workspaceId,
                connectionId: account.connectionId,
                ...(operation === "reconcile"
                  ? { poolId: selected.id, providerPoolName }
                  : {
                      ipIds: selectedMembers.map((ip) => ip.id),
                      confirm: true,
                    }),
              },
            );
            await onComplete();
            await health.refetch();
            setOperation(null);
          }}
        >
          <Typography variant="body2">
            {text(account.name)} ·{" "}
            {selectedMembers.map((ip) => text(ip.address)).join(", ")}
          </Typography>
        </EditorDialog>
      )}
    </Stack>
  );
}

export default function IpResources(props: InfrastructureProps) {
  const { workspaceId, accountId, kind = "ips", resourceId } = props;
  return (
    <Box sx={{ minWidth: 0, maxWidth: "100%" }}>
      <IpResourcesContent
        key={`${workspaceId}:${accountId ?? "all"}:${kind}:${resourceId ?? "list"}`}
        {...props}
      />
    </Box>
  );
}

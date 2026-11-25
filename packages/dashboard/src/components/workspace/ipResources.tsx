import {
  Alert,
  Box,
  Button,
  Chip,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

import {
  compareInventoryValues,
  InventorySortValue,
} from "../../lib/tableSorting";
import { RecordValue, rows, text } from "../publications/settingsShared";
import { deliveryMetricValue, useDeliveryHealth } from "./deliveryMetrics";
import { DataTable, InfrastructureProps } from "./infrastructureShared";
import { ipDeliverySummary } from "./ipMetrics";
import Link from "./navigation";

const ResourceEditor = dynamic(() => import("./resourceEditor"));

function IpResourcesContent(props: InfrastructureProps) {
  const {
    infrastructure,
    accountId,
    resourceId,
    apiBase,
    workspaceId,
    kind = "ips",
  } = props;
  const accounts = useMemo(
    () => rows(infrastructure.accounts),
    [infrastructure.accounts],
  );
  const ips = useMemo(() => rows(infrastructure.ips), [infrastructure.ips]);
  const pools = useMemo(
    () => rows(infrastructure.pools),
    [infrastructure.pools],
  );
  const memberships = useMemo(
    () => rows(infrastructure.memberships),
    [infrastructure.memberships],
  );
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
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" }>({
    key: "resource",
    direction: "asc",
  });
  const health = useDeliveryHealth(apiBase, workspaceId);
  let metricState: "loading" | "unavailable" | "ready" = "ready";
  if (health.isPending) metricState = "loading";
  if (health.isError) metricState = "unavailable";
  const metrics = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.id,
          ipDeliverySummary(item, kind, health.data),
        ]),
      ),
    [items, kind, health.data],
  );
  const memberIps = (pool: RecordValue) =>
    memberships
      .filter((membership) => membership.poolId === pool.id)
      .map((membership) => ips.find((ip) => ip.id === membership.ipId))
      .filter((ip): ip is RecordValue => ip !== undefined);
  const accountLink = (item: RecordValue) => {
    const account = accounts.find((entry) => entry.id === item.accountId);
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
  const resourceColumns = [
    {
      label: kind === "ips" ? "Address" : "Name",
      render: (item: RecordValue) => (
        <Link href={`/workspace/${path}/${text(item.id)}`}>
          {text(kind === "ips" ? item.address : item.name)}
        </Link>
      ),
    },
    { label: "ESP account", render: accountLink },
    ...(kind === "ips"
      ? [
          {
            label: "Status",
            render: (item: RecordValue) => (
              <Chip size="small" label={text(item.status)} />
            ),
          },
        ]
      : [
          {
            label: "Members",
            render: (item: RecordValue) => memberIps(item).length,
          },
        ]),
    {
      label: "Actions",
      render: (item: RecordValue) => (
        <Button
          size="small"
          onClick={() => setEditor({ item })}
          aria-label={`Edit ${text(item.address ?? item.name)}`}
        >
          Edit
        </Button>
      ),
    },
  ];
  const metricColumns = [
    { key: "sends", label: "Attempts (30d)" },
    { key: "delivered", label: "Delivered" },
    { key: "deliverabilityRate", label: "Deliverability" },
    { key: "bounced", label: "Bounced" },
    { key: "complaints", label: "Complaints" },
  ];
  const inventoryColumns = [
    ...resourceColumns.slice(0, -1).map((column, index) => ({
      ...column,
      key: ["resource", "account", kind === "ips" ? "status" : "members"][
        index
      ]!,
    })),
    ...metricColumns.map((column) => ({
      ...column,
      render: (item: RecordValue) =>
        deliveryMetricValue(metrics.get(item.id), column.key, metricState),
    })),
    { ...resourceColumns[resourceColumns.length - 1]!, key: "actions" },
  ];
  const searchTerm = search.trim().toLowerCase();
  const sortValue = (item: RecordValue): InventorySortValue => {
    if (sort.key === "resource") return text(item.address ?? item.name);
    if (sort.key === "account") {
      const name = accounts.find(
        (account) => account.id === item.accountId,
      )?.name;
      return typeof name === "string" ? name : null;
    }
    if (sort.key === "status") return text(item.status);
    if (sort.key === "members") return memberIps(item).length;
    if (metricState !== "ready") return null;
    const summary = metrics.get(item.id);
    if (sort.key !== "sends" && summary?.observationsAvailable === false)
      return null;
    const value = summary?.[sort.key];
    return typeof value === "number" ? value : null;
  };
  const filteredItems = items
    .filter((item) => {
      if (filter && item.accountId !== filter) return false;
      if (status) {
        if (kind === "ips" && item.status !== status) return false;
        if (kind === "pools") {
          const members = memberIps(item);
          if (
            status === "empty"
              ? members.length > 0
              : !members.some((ip) => ip.status === status)
          )
            return false;
        }
      }
      const account = accounts.find((entry) => entry.id === item.accountId);
      return (
        !searchTerm ||
        [item.address, item.name, account?.name, item.status].some(
          (value) =>
            typeof value === "string" &&
            value.toLowerCase().includes(searchTerm),
        )
      );
    })
    .sort(
      (left, right) =>
        compareInventoryValues(
          sortValue(left),
          sortValue(right),
          sort.direction,
        ) ||
        compareInventoryValues(
          text(left.address ?? left.name),
          text(right.address ?? right.name),
          "asc",
        ) ||
        text(left.id).localeCompare(text(right.id)),
    );
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
            <Typography
              component={accountId ? "h2" : "h1"}
              variant={accountId ? "h4" : "h2"}
            >
              {text(selected.address ?? selected.name)}
            </Typography>
            <Button onClick={() => setEditor({ item: selected })}>Edit</Button>
          </Stack>
          <DataTable
            label={`${label} details`}
            data={[selected]}
            columns={resourceColumns.filter(
              (column) => column.label !== "Actions",
            )}
          />
          <Typography variant="subtitle2">
            {kind === "ips" ? "Shared IP pools" : "Dedicated IPs"}
          </Typography>
          <DataTable
            label={
              kind === "ips" ? "IP pool memberships" : "Shared pool members"
            }
            data={
              kind === "ips"
                ? pools.filter((pool) =>
                    memberships.some(
                      (member) =>
                        member.poolId === pool.id &&
                        member.ipId === selected.id,
                    ),
                  )
                : memberIps(selected)
            }
            columns={
              kind === "ips"
                ? [
                    {
                      label: "Name",
                      render: (pool) => (
                        <Link href={`/workspace/ip-pools/${text(pool.id)}`}>
                          {text(pool.name)}
                        </Link>
                      ),
                    },
                  ]
                : [
                    {
                      label: "Address",
                      render: (ip) => (
                        <Link href={`/workspace/ips/${text(ip.id)}`}>
                          {text(ip.address)}
                        </Link>
                      ),
                    },
                    { label: "Status", render: (ip) => text(ip.status) },
                  ]
            }
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
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <TextField
              size="small"
              label="Search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {!accountId && (
              <TextField
                select
                size="small"
                label="ESP account"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                sx={{ minWidth: 180 }}
              >
                <MenuItem value="">All accounts</MenuItem>
                {accounts.map((item) => (
                  <MenuItem key={text(item.id)} value={text(item.id)}>
                    {text(item.name)}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              select
              size="small"
              label={kind === "ips" ? "Status" : "Member status"}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="">All statuses</MenuItem>
              <MenuItem value="active">
                {kind === "ips" ? "Active" : "Active members"}
              </MenuItem>
              <MenuItem value="paused">
                {kind === "ips" ? "Paused" : "Paused members"}
              </MenuItem>
              {kind === "pools" && (
                <MenuItem value="empty">No members</MenuItem>
              )}
            </TextField>
            <Button
              color="inherit"
              disabled={!search && !status && filter === (accountId ?? "")}
              onClick={() => {
                setSearch("");
                setStatus("");
                setFilter(accountId ?? "");
              }}
            >
              Reset
            </Button>
          </Stack>
          {!accounts.length && (
            <Button
              component={Link}
              href="/workspace/esp-accounts"
              sx={{ alignSelf: "flex-start" }}
            >
              Add account
            </Button>
          )}
          <TableContainer sx={{ maxWidth: "100%", overflowX: "auto" }}>
            <Table size="small" aria-label={`Workspace ${label}`}>
              <TableHead>
                <TableRow>
                  {inventoryColumns.map((column) => (
                    <TableCell
                      key={column.key}
                      sortDirection={
                        sort.key === column.key ? sort.direction : false
                      }
                    >
                      {column.key === "actions" ? (
                        column.label
                      ) : (
                        <Tooltip
                          describeChild
                          title={
                            metricColumns.some(
                              (metric) => metric.key === column.key,
                            )
                              ? "Attributed history only"
                              : ""
                          }
                        >
                          <TableSortLabel
                            active={sort.key === column.key}
                            direction={
                              sort.key === column.key ? sort.direction : "asc"
                            }
                            onClick={() =>
                              setSort({
                                key: column.key,
                                direction:
                                  sort.key === column.key &&
                                  sort.direction === "asc"
                                    ? "desc"
                                    : "asc",
                              })
                            }
                          >
                            {column.label}
                          </TableSortLabel>
                        </Tooltip>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={text(item.id)}>
                    {inventoryColumns.map((column, index) => (
                      <TableCell
                        key={column.key}
                        component={index === 0 ? "th" : "td"}
                        scope={index === 0 ? "row" : undefined}
                      >
                        {column.render(item)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {!filteredItems.length && (
                  <TableRow>
                    <TableCell colSpan={inventoryColumns.length}>
                      {items.length ? "No matching records" : "No records"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
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

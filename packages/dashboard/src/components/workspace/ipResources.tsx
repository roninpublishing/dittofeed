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
import dynamic from "next/dynamic";
import { useState } from "react";

import { RecordValue, rows, text } from "../publications/settingsShared";
import { DataTable, InfrastructureProps } from "./infrastructureShared";
import Link from "./navigation";

const ResourceEditor = dynamic(() => import("./resourceEditor"));

function IpResourcesContent(props: InfrastructureProps) {
  const { infrastructure, accountId, resourceId, kind = "ips" } = props;
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

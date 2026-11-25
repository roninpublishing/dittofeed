import {
  Alert,
  Button,
  Chip,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
} from "@mui/material";
import axios from "axios";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

import { InventorySortDirection } from "../../lib/tableSorting";
import { WorkspaceDomain } from "../../lib/workspaceDomains";
import {
  errorText,
  record,
  RecordValue,
  rows,
  text,
} from "../publications/settingsShared";
import TrackingDomains, {
  NewsletterDomainSetup,
} from "../publications/trackingDomains";
import {
  DeliveryMetricCards,
  deliveryMetricValue,
  domainDeliverySummary,
  useDeliveryHealth,
} from "./deliveryMetrics";
import {
  buildDomainTableRows,
  DomainSortKey,
  emptyDomainFilters,
  selectDomainTableRows,
} from "./domainTable";
import {
  DnsRecords,
  EditorDialog,
  InfrastructureProps,
  list,
  strings,
} from "./infrastructureShared";
import Link from "./navigation";

const AccountOperations = dynamic(() => import("./accountOperations"));

function SendingRegistration({
  accounts,
  account: initialAccount,
  workspaceId,
  apiBase,
  onComplete,
  onClose,
}: Pick<InfrastructureProps, "workspaceId" | "apiBase" | "onComplete"> & {
  accounts: RecordValue[];
  account?: RecordValue;
  onClose: () => void;
}) {
  const [accountId, setAccountId] = useState(
    typeof initialAccount?.id === "string" ? initialAccount.id : "",
  );
  const [domains, setDomains] = useState(
    strings(initialAccount?.senderDomains).join("\n"),
  );
  const account = accounts.find((item) => item.id === accountId);
  return (
    <EditorDialog
      title="Sending domains"
      action="Save locally"
      onClose={onClose}
      disabled={!account}
      onSubmit={async () => {
        if (!account) return;
        await axios.put(`${apiBase}/api/publications/infrastructure/accounts`, {
          workspaceId,
          id: account.id,
          name: account.name,
          provider: "SendGrid",
          senderDomains: list(domains),
        });
        await onComplete();
        onClose();
      }}
    >
      <TextField
        size="small"
        select
        label="ESP account"
        value={accountId}
        disabled={!!initialAccount}
        onChange={(event) => {
          setAccountId(event.target.value);
          setDomains(
            strings(
              accounts.find((item) => item.id === event.target.value)
                ?.senderDomains,
            ).join("\n"),
          );
        }}
      >
        {accounts.map((item) => (
          <MenuItem key={text(item.id)} value={text(item.id)}>
            {text(item.name)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        label="Sending domains"
        multiline
        minRows={3}
        value={domains}
        onChange={(event) => setDomains(event.target.value)}
      />
    </EditorDialog>
  );
}

function SendingDomainDetails({
  domain,
  account,
  ...props
}: InfrastructureProps & { domain: WorkspaceDomain; account: RecordValue }) {
  const [registration, setRegistration] = useState(false);
  const [operation, setOperation] = useState<RecordValue | null>(null);
  const [result, setResult] = useState<RecordValue | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authentications = rows(domain.evidence.authentications);
  const observations = result
    ? [
        ...authentications.filter(
          (item) => item.subdomain !== result.subdomain,
        ),
        result,
      ]
    : authentications;
  const providerAllowed =
    account.provider === "SendGrid" &&
    account.allowProviderWrites === true &&
    account.hasManagementKey === true &&
    typeof account.connectionId === "string";
  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      await axios.post(
        `${props.apiBase}/api/publications/infrastructure/accounts/inspect`,
        { workspaceId: props.workspaceId, accountId: account.id },
      );
      setResult(null);
      await props.onComplete();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setChecking(false);
    }
  };
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Typography>
          Sending ·{" "}
          <Link href={`/workspace/esp-accounts/${text(account.id)}`}>
            {text(account.name)}
          </Link>
        </Typography>
        <Button
          disabled={account.provider !== "SendGrid"}
          onClick={() => setRegistration(true)}
        >
          Edit registration
        </Button>
        <Button
          disabled={
            checking ||
            account.provider !== "SendGrid" ||
            account.hasManagementKey !== true
          }
          onClick={() => void check()}
        >
          {checking ? "Checking…" : "Check account"}
        </Button>
        {!observations.length && (
          <Button
            disabled={!providerAllowed}
            onClick={() => setOperation({ domain: domain.hostname })}
          >
            Authenticate
          </Button>
        )}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {domain.evidence.inspectedAt !== undefined && (
        <Typography variant="body2" color="text.secondary">
          Last checked: {text(domain.evidence.inspectedAt)}
        </Typography>
      )}
      {observations.length ? (
        observations.map((item) => (
          <Stack key={text(item.subdomain)} spacing={1}>
            <DnsRecords domains={[item]} />
            <Button
              sx={{ alignSelf: "flex-start" }}
              disabled={!providerAllowed}
              onClick={() => setOperation(item)}
            >
              Authenticate / verify
            </Button>
          </Stack>
        ))
      ) : (
        <Typography color="text.secondary">
          No authentication observations
        </Typography>
      )}
      {registration && (
        <SendingRegistration
          {...props}
          accounts={[account]}
          account={account}
          onComplete={async () => {
            setResult(null);
            await props.onComplete();
          }}
          onClose={() => setRegistration(false)}
        />
      )}
      {operation && (
        <AccountOperations
          {...props}
          account={account}
          operation="domain"
          domain={operation}
          onDomain={setResult}
          onClose={() => setOperation(null)}
        />
      )}
    </Stack>
  );
}
const domainColumns: {
  key: DomainSortKey;
  label: string;
  numeric?: boolean;
}[] = [
  { key: "hostname", label: "Domain" },
  { key: "kind", label: "Type" },
  { key: "owner", label: "Owner" },
  { key: "status", label: "Status" },
  { key: "use", label: "Use" },
  { key: "sends", label: "Attempts (30d)", numeric: true },
  { key: "delivered", label: "Delivered", numeric: true },
  { key: "deliverabilityRate", label: "Deliverability", numeric: true },
];

export default function Domains({
  domains,
  newsletters,
  ...props
}: InfrastructureProps & { domains: WorkspaceDomain[]; newsletters: unknown }) {
  const [adding, setAdding] = useState<"sending" | "tracking" | null>(null);
  const [filters, setFilters] = useState(emptyDomainFilters);
  const [sort, setSort] = useState<DomainSortKey>("hostname");
  const [direction, setDirection] = useState<InventorySortDirection>("asc");
  const health = useDeliveryHealth(props.apiBase, props.workspaceId);
  let healthState: "loading" | "unavailable" | "ready" = "ready";
  if (health.isPending) healthState = "loading";
  if (health.isError) healthState = "unavailable";
  const accounts = useMemo(
    () => rows(props.infrastructure.accounts),
    [props.infrastructure.accounts],
  );
  const newsletterRows = useMemo(() => rows(newsletters), [newsletters]);
  const owners = useMemo(
    () =>
      new Map([
        ...accounts.map(
          (item) => [`sending:${text(item.id)}`, text(item.name)] as const,
        ),
        ...newsletterRows.map(
          (item) =>
            [`tracking:${text(item.workspaceId)}`, text(item.name)] as const,
        ),
      ]),
    [accounts, newsletterRows],
  );
  const tableRows = useMemo(
    () => buildDomainTableRows(domains, owners, health.data),
    [domains, owners, health.data],
  );
  const visibleRows = useMemo(
    () => selectDomainTableRows(tableRows, filters, sort, direction),
    [tableRows, filters, sort, direction],
  );
  const ownerOptions = useMemo(
    () =>
      [
        ...new Map(
          tableRows.map((item): [string, string] => [
            `${item.kind}:${item.ownerId}`,
            item.owner,
          ]),
        ).entries(),
      ].sort((left, right) => left[1].localeCompare(right[1])),
    [tableRows],
  );
  const statuses = useMemo(
    () => [...new Set(tableRows.map((item) => item.status))].sort(),
    [tableRows],
  );
  const reset = () => {
    setFilters(emptyDomainFilters);
    setSort("hostname");
    setDirection("asc");
  };
  const changeSort = (key: DomainSortKey) => {
    setDirection(sort === key && direction === "asc" ? "desc" : "asc");
    setSort(key);
  };
  const selected = domains.find((item) => item.viewId === props.resourceId);
  const selectedAccount =
    selected?.kind === "sending"
      ? accounts.find((item) => item.id === selected.ownerId)
      : undefined;
  return (
    <Stack spacing={2} minWidth={0}>
      {props.resourceId && <Link href="/workspace/domains">Domains</Link>}
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        spacing={1}
      >
        <Typography
          component="h1"
          variant="h2"
          sx={{ overflowWrap: "anywhere" }}
        >
          {selected?.hostname ?? "Domains"}
        </Typography>
        {!props.resourceId && (
          <Stack direction="row" spacing={1}>
            <Button
              disabled={!accounts.some((item) => item.provider === "SendGrid")}
              onClick={() => setAdding("sending")}
            >
              Sending domain
            </Button>
            <Button
              disabled={!newsletterRows.length}
              onClick={() =>
                setAdding(adding === "tracking" ? null : "tracking")
              }
            >
              Tracking domain
            </Button>
          </Stack>
        )}
      </Stack>
      <DeliveryMetricCards
        summary={
          selected
            ? domainDeliverySummary(selected, health.data)
            : record(health.data?.summary)
        }
        state={selected?.kind === "tracking" ? "ready" : healthState}
      />
      {props.resourceId && !selected && (
        <Alert severity="warning">Domain not found</Alert>
      )}
      {selected && (
        <>
          <Stack direction="row" spacing={1}>
            <Chip size="small" variant="outlined" label={selected.status} />
            {selected.kind === "tracking" && (
              <Chip
                size="small"
                variant="outlined"
                label={selected.isCurrent ? "Current" : "Historical"}
              />
            )}
          </Stack>
          {selectedAccount && (
            <SendingDomainDetails
              key={selected.viewId}
              {...props}
              domain={selected}
              account={selectedAccount}
            />
          )}
          {!selectedAccount && selected.kind === "tracking" && (
            <NewsletterDomainSetup
              key={selected.viewId}
              {...props}
              newsletterId={selected.ownerId}
              newsletterName={
                owners.get(`tracking:${selected.ownerId}`) ??
                "Unknown newsletter"
              }
              selectedHostname={selected.hostname}
            />
          )}
          {!selectedAccount && selected.kind !== "tracking" && (
            <Alert severity="warning">Domain owner unavailable</Alert>
          )}
        </>
      )}
      {!props.resourceId && (
        <>
          {adding === "tracking" && (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <TrackingDomains
                {...props}
                newsletters={newsletterRows.map((item) => ({
                  value: text(item.workspaceId),
                  label: text(item.name),
                }))}
              />
            </Paper>
          )}
          <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap">
            <TextField
              size="small"
              label="Search domains"
              value={filters.search}
              onChange={(event) =>
                setFilters({ ...filters, search: event.target.value })
              }
              sx={{ minWidth: 200, flex: 1 }}
            />
            <TextField
              select
              size="small"
              label="Type"
              value={filters.kind}
              onChange={(event) =>
                setFilters({ ...filters, kind: event.target.value })
              }
              sx={{ minWidth: 140 }}
            >
              <MenuItem value="">All types</MenuItem>
              <MenuItem value="sending">Sending</MenuItem>
              <MenuItem value="tracking">Tracking</MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              label="Owner"
              value={filters.owner}
              onChange={(event) =>
                setFilters({ ...filters, owner: event.target.value })
              }
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="">All owners</MenuItem>
              {ownerOptions.map(([key, name]) => (
                <MenuItem key={key} value={key}>
                  {name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="Status"
              value={filters.status}
              onChange={(event) =>
                setFilters({ ...filters, status: event.target.value })
              }
              sx={{ minWidth: 150 }}
            >
              <MenuItem value="">All statuses</MenuItem>
              {statuses.map((status) => (
                <MenuItem
                  key={status}
                  value={status}
                  sx={{ textTransform: "capitalize" }}
                >
                  {status}
                </MenuItem>
              ))}
            </TextField>
            <Button
              color="inherit"
              onClick={reset}
              disabled={
                !Object.values(filters).some(Boolean) &&
                sort === "hostname" &&
                direction === "asc"
              }
            >
              Reset
            </Button>
          </Stack>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label="Workspace domains">
              <TableHead>
                <TableRow>
                  {domainColumns.map((column) => (
                    <TableCell
                      key={column.key}
                      align={column.numeric ? "right" : "left"}
                      sortDirection={sort === column.key ? direction : false}
                    >
                      <TableSortLabel
                        active={sort === column.key}
                        direction={sort === column.key ? direction : "asc"}
                        onClick={() => changeSort(column.key)}
                      >
                        {column.label}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                  <TableCell>Reputation</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visibleRows.map((item) => (
                  <TableRow key={item.id} hover>
                    <TableCell>
                      {item.domain ? (
                        <Link href={`/workspace/domains/${item.domain.viewId}`}>
                          {item.hostname}
                        </Link>
                      ) : (
                        item.hostname
                      )}
                    </TableCell>
                    <TableCell>
                      {item.kind === "sending" ? "Sending" : "Tracking"}
                    </TableCell>
                    <TableCell>
                      {item.ownerId ? (
                        <Link
                          href={
                            item.kind === "sending"
                              ? `/workspace/esp-accounts/${item.ownerId}`
                              : `/workspace/newsletters/${item.ownerId}`
                          }
                        >
                          {item.owner}
                        </Link>
                      ) : (
                        item.owner
                      )}
                    </TableCell>
                    <TableCell sx={{ textTransform: "capitalize" }}>
                      {item.status}
                    </TableCell>
                    <TableCell>{item.use}</TableCell>
                    {["sends", "delivered", "deliverabilityRate"].map(
                      (metric) => (
                        <TableCell key={metric} align="right">
                          {deliveryMetricValue(
                            item.metrics,
                            metric,
                            item.kind === "tracking" ? "ready" : healthState,
                          )}
                        </TableCell>
                      ),
                    )}
                    <TableCell aria-label="Reputation not available" />
                  </TableRow>
                ))}
                {!visibleRows.length && (
                  <TableRow>
                    <TableCell colSpan={9}>
                      {tableRows.length ? "No matching domains" : "No domains"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
      {adding === "sending" && (
        <SendingRegistration
          {...props}
          accounts={accounts.filter((item) => item.provider === "SendGrid")}
          onClose={() => setAdding(null)}
        />
      )}
    </Stack>
  );
}

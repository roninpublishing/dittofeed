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
  TextField,
  Typography,
} from "@mui/material";
import axios from "axios";
import dynamic from "next/dynamic";
import { useState } from "react";

import { WorkspaceDomain } from "../../lib/workspaceDomains";
import {
  errorText,
  RecordValue,
  rows,
  text,
} from "../publications/settingsShared";
import TrackingDomains, {
  NewsletterDomainSetup,
} from "../publications/trackingDomains";
import {
  DnsRecords,
  EditorDialog,
  InfrastructureProps,
  list,
  strings,
} from "./infrastructureShared";
import Link from "./navigation";
import {
  DeliveryMetricCards,
  deliveryMetricValue,
  domainDeliverySummary,
  useDeliveryHealth,
} from "./deliveryMetrics";

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
export default function Domains({
  domains,
  newsletters,
  ...props
}: InfrastructureProps & { domains: WorkspaceDomain[]; newsletters: unknown }) {
  const [adding, setAdding] = useState<"sending" | "tracking" | null>(null);
  const health = useDeliveryHealth(props.apiBase, props.workspaceId);
  const healthState = health.isError
    ? "unavailable"
    : health.isPending
      ? "loading"
      : "ready";
  const unknownSenders = rows(health.data?.domains).filter(
    (cohort) =>
      !cohort.senderDomain &&
      [cohort.sends, cohort.resolvedOutcomes, cohort.complaints].some(
        (metric) => typeof metric === "number" && metric > 0,
      ),
  );
  const accounts = rows(props.infrastructure.accounts);
  const newsletterRows = rows(newsletters);
  const owners = new Map([
    ...accounts.map(
      (item) => [`sending:${text(item.id)}`, text(item.name)] as const,
    ),
    ...newsletterRows.map(
      (item) =>
        [`tracking:${text(item.workspaceId)}`, text(item.name)] as const,
    ),
  ]);
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
            : (health.data?.summary as RecordValue | undefined)
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
          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label="Workspace domains">
              <TableHead>
                <TableRow>
                  <TableCell>Domain</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Owner</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Use</TableCell>
                  <TableCell align="right">Attempts (30d)</TableCell>
                  <TableCell align="right">Delivered</TableCell>
                  <TableCell align="right">Deliverability</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {domains.map((item) => (
                  <TableRow key={item.viewId} hover>
                    <TableCell>
                      <Link href={`/workspace/domains/${item.viewId}`}>
                        {item.hostname}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {item.kind === "sending" ? "Sending" : "Tracking"}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={
                          item.kind === "sending"
                            ? `/workspace/esp-accounts/${item.ownerId}`
                            : `/workspace/newsletters/${item.ownerId}`
                        }
                      >
                        {owners.get(`${item.kind}:${item.ownerId}`) ??
                          "Unknown"}
                      </Link>
                    </TableCell>
                    <TableCell sx={{ textTransform: "capitalize" }}>
                      {item.status}
                    </TableCell>
                    <TableCell>
                      {item.kind === "tracking" &&
                        (item.isCurrent ? "Current" : "Historical")}
                      {item.kind !== "tracking" && "—"}
                    </TableCell>
                    {["sends", "delivered", "deliverabilityRate"].map(
                      (metric) => (
                        <TableCell key={metric} align="right">
                          {deliveryMetricValue(
                            domainDeliverySummary(item, health.data),
                            metric,
                            item.kind === "tracking" ? "ready" : healthState,
                          )}
                        </TableCell>
                      ),
                    )}
                  </TableRow>
                ))}
                {unknownSenders.map((cohort) => (
                  <TableRow key={`unknown:${text(cohort.accountId)}`}>
                    <TableCell>Unknown sender</TableCell>
                    <TableCell>Sending</TableCell>
                    <TableCell>
                      {owners.get(`sending:${text(cohort.accountId)}`) ??
                        "Unknown"}
                    </TableCell>
                    <TableCell>Unknown</TableCell>
                    <TableCell>—</TableCell>
                    {["sends", "delivered", "deliverabilityRate"].map(
                      (metric) => (
                        <TableCell key={metric} align="right">
                          {deliveryMetricValue(cohort, metric, healthState)}
                        </TableCell>
                      ),
                    )}
                  </TableRow>
                ))}
                {!domains.length && !unknownSenders.length && (
                  <TableRow>
                    <TableCell colSpan={8}>No domains</TableCell>
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

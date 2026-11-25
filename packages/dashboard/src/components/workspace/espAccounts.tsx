import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Tab,
  Tabs,
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
import type { AccountOperation } from "./accountOperations";
import {
  DataTable,
  date,
  DnsRecords,
  InfrastructureProps,
  Readiness,
  strings,
  value,
} from "./infrastructureShared";
import IpResources from "./ipResources";
import Link from "./navigation";

const AccountEditor = dynamic(() => import("./accountEditor"));
const AccountOperations = dynamic(() => import("./accountOperations"));
const AccountActivity = dynamic(() => import("./accountActivity"));

type Section =
  | "overview"
  | "configuration"
  | "domains"
  | "ips"
  | "pools"
  | "activity";

function AccountDetails({
  account,
  summary,
  ...props
}: InfrastructureProps & { account: RecordValue; summary?: RecordValue }) {
  const { workspaceId, apiBase, onComplete } = props;
  const [section, setSection] = useState<Section>("overview");
  const [editing, setEditing] = useState(false);
  const [operation, setOperation] = useState<{
    kind: AccountOperation;
    domain?: RecordValue;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{
    revision: unknown;
    report: RecordValue;
  } | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const [domainResults, setDomainResults] = useState<RecordValue[]>([]);
  const provisioning = record(account.provisioning);
  const report =
    checked && checked.revision === account.updatedAt
      ? checked.report
      : provisioning;
  const readiness = invalidated ? {} : provisioning;
  const capabilities = record(account.capabilities);
  const supported = account.provider === "SendGrid";
  const hasIps =
    capabilities.ip === true || (capabilities.ip === undefined && supported);
  const hasPools =
    capabilities.pool === true ||
    (capabilities.pool === undefined && supported);
  const domains = invalidated ? [] : [...rows(report.domains)];
  domainResults.forEach((domain) => {
    const index = domains.findIndex(
      (item) =>
        item.domain === domain.domain && item.subdomain === domain.subdomain,
    );
    if (index >= 0) domains[index] = domain;
    else domains.push(domain);
  });
  strings(account.senderDomains).forEach((domain) => {
    if (!domains.some((item) => item.domain === domain))
      domains.push({ domain });
  });
  const findings = invalidated
    ? ["Connection check required"]
    : strings(report.findings ?? provisioning.findings);
  const providerAllowed =
    account.allowProviderWrites === true &&
    account.hasManagementKey === true &&
    typeof account.connectionId === "string";
  const tabs: { id: Section; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "configuration", label: "Configuration" },
    ...(supported ? [{ id: "domains" as const, label: "Domains" }] : []),
    ...(hasIps ? [{ id: "ips" as const, label: "Dedicated IPs" }] : []),
    ...(hasPools ? [{ id: "pools" as const, label: "Shared IPs" }] : []),
    { id: "activity", label: "Activity" },
  ];
  const invalidate = () => {
    setChecked(null);
    setDomainResults([]);
    setInvalidated(true);
  };
  const inspect = async () => {
    setChecking(true);
    setError(null);
    try {
      const response = await axios.post(
        `${apiBase}/api/publications/infrastructure/accounts/inspect`,
        { workspaceId, accountId: account.id },
      );
      const result = record(record(response.data).data);
      setChecked({ revision: account.updatedAt, report: result });
      setInvalidated(false);
      setDomainResults([]);
      await onComplete();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setChecking(false);
    }
  };
  const webhook = invalidated ? {} : record(report.webhook);
  const currentInspection = Object.keys(report).length ? report : readiness;
  const inspection = invalidated ? {} : currentInspection;
  return (
    <Stack spacing={2}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        useFlexGap
        flexWrap="wrap"
        spacing={1}
      >
        <Stack spacing={1}>
          <Link href="/workspace/esp-accounts">ESP accounts</Link>
          <Typography component="h1" variant="h2">
            {text(account.name)}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={text(account.provider)} />
          <Readiness
            account={{
              provisioning: {
                ...readiness,
                ...(inspection.inspectedAt
                  ? {
                      inspectedAt: inspection.inspectedAt,
                      ready: inspection.ready,
                    }
                  : {}),
              },
            }}
          />
          <Button
            disabled={
              checking || !supported || account.hasManagementKey !== true
            }
            onClick={inspect}
          >
            {checking ? "Checking…" : "Check connection"}
          </Button>
        </Stack>
      </Stack>
      <Tabs
        value={section}
        onChange={(_, next: Section) => setSection(next)}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="ESP account sections"
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            value={tab.id}
            label={tab.label}
            id={`account-tab-${tab.id}`}
            aria-controls={`account-panel-${tab.id}`}
          />
        ))}
      </Tabs>
      {error && <Alert severity="error">{error}</Alert>}
      <Box
        role="tabpanel"
        id={`account-panel-${section}`}
        aria-labelledby={`account-tab-${section}`}
        sx={{ minWidth: 0 }}
      >
        {section === "overview" && (
          <Stack spacing={2}>
            <DataTable
              label="ESP account overview"
              data={[account]}
              columns={[
                { label: "Provider", render: (item) => text(item.provider) },
                { label: "Saved state", render: (item) => text(item.status) },
                { label: "Added", render: (item) => date(item.createdAt) },
                {
                  label: "Last checked",
                  render: () =>
                    invalidated
                      ? "Check required"
                      : date(inspection.inspectedAt),
                },
              ]}
            />
            <Typography variant="subtitle2">Readiness</Typography>
            {findings.length > 0 && (
              <Box component="ul" sx={{ m: 0, pl: 3 }}>
                {findings.map((finding) => (
                  <Typography component="li" variant="body2" key={finding}>
                    {finding.replace(/_/g, " ")}
                  </Typography>
                ))}
              </Box>
            )}
            <DataTable
              label="Account readiness checks"
              data={[
                {
                  id: "credential",
                  check: "Sending credential stored",
                  result: record(inspection.key).credentialStored,
                },
                {
                  id: "key",
                  check: "Provider key present",
                  result: record(inspection.key).present,
                },
                {
                  id: "restricted",
                  check: "Mail-send-only key",
                  result: record(inspection.key).restricted,
                },
                {
                  id: "webhook",
                  check: "Event webhook ready",
                  result: webhook.ready,
                },
                {
                  id: "signed",
                  check: "Webhook signature",
                  result: webhook.signed,
                },
              ]}
              columns={[
                { label: "Check", render: (item) => text(item.check) },
                {
                  label: "Verification",
                  render: (item) => {
                    if (item.result === true) return "Verified";
                    if (item.result === false) return "Not verified";
                    return "Unknown";
                  },
                },
              ]}
            />
            <DataTable
              label="Account activity summary"
              data={[summary ?? {}]}
              columns={[
                {
                  label: "Attempts (30d)",
                  render: (item) => value(item.sends),
                },
                {
                  label: "Delivered (30d)",
                  render: (item) => value(item.delivered),
                },
                {
                  label: "Bounced (30d)",
                  render: (item) => value(item.bounced),
                },
                {
                  label: "Complaints (30d)",
                  render: (item) => value(item.complaints),
                },
              ]}
            />
            <Button
              sx={{ alignSelf: "flex-start" }}
              onClick={() => setSection("activity")}
            >
              Open observed activity
            </Button>
          </Stack>
        )}
        {section === "configuration" && (
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6">Configuration</Typography>
              <Button disabled={!supported} onClick={() => setEditing(true)}>
                Edit account
              </Button>
            </Stack>
            <DataTable
              label="Saved account configuration"
              data={[account]}
              columns={[
                { label: "Region", render: (item) => text(item.region) },
                {
                  label: "Provider subuser",
                  render: (item) => value(item.username),
                },
                {
                  label: "Management credential",
                  render: (item) =>
                    item.hasManagementKey === true ? "Saved" : "Not saved",
                },
                {
                  label: "Sending credential",
                  render: (item) =>
                    item.hasApiKey === true ? "Saved" : "Not saved",
                },
              ]}
            />
            <Typography variant="body2">
              Callback URL: {text(account.callbackBaseUrl)}
            </Typography>
            <Typography variant="body2">
              Sender emails:{" "}
              {strings(account.senderEmails).join(", ") || "None"}
            </Typography>
            {supported && (
              <>
                <Typography variant="subtitle2">
                  Signed event webhook
                </Typography>
                <DataTable
                  label="Signed webhook readiness"
                  data={[webhook]}
                  columns={[
                    {
                      label: "Ready",
                      render: (item) => {
                        if (item.ready === undefined) return "Unknown";
                        return item.ready === true ? "Verified" : "Not ready";
                      },
                    },
                    {
                      label: "Signature",
                      render: (item) => {
                        if (item.signed === undefined) return "Unknown";
                        return item.signed === true
                          ? "Verified"
                          : "Not verified";
                      },
                    },
                    { label: "URL", render: (item) => value(item.url) },
                  ]}
                />
                <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1}>
                  <Button
                    disabled={!providerAllowed}
                    onClick={() => setOperation({ kind: "webhook" })}
                  >
                    Set up signed webhook…
                  </Button>
                  <Button
                    disabled={!providerAllowed}
                    onClick={() => setOperation({ kind: "sender" })}
                  >
                    Verify sender identity…
                  </Button>
                  {!providerAllowed && (
                    <Chip
                      size="small"
                      label="Provider changes not authorized"
                    />
                  )}
                </Stack>
              </>
            )}
          </Stack>
        )}
        {section === "domains" && (
          <Stack spacing={2}>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
            >
              <Typography variant="h6">Sender domains</Typography>
              <Button
                disabled={!providerAllowed}
                onClick={() => setOperation({ kind: "domain" })}
              >
                Authenticate domain…
              </Button>
            </Stack>
            <DnsRecords domains={domains} />
            {domains.length > 0 && (
              <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1}>
                {domains.map((domain) => (
                  <Button
                    key={`${text(domain.domain)}-${text(domain.subdomain)}`}
                    disabled={!providerAllowed}
                    onClick={() => setOperation({ kind: "domain", domain })}
                  >
                    Verify {text(domain.domain)}…
                  </Button>
                ))}
              </Stack>
            )}
          </Stack>
        )}
        {section === "ips" && (
          <IpResources {...props} accountId={text(account.id)} kind="ips" />
        )}
        {section === "pools" && (
          <IpResources {...props} accountId={text(account.id)} kind="pools" />
        )}
        {section === "activity" && (
          <AccountActivity
            workspaceId={workspaceId}
            apiBase={apiBase}
            accountId={text(account.id)}
          />
        )}
      </Box>
      {editing && (
        <AccountEditor
          workspaceId={workspaceId}
          apiBase={apiBase}
          account={account}
          onClose={() => setEditing(false)}
          onComplete={async () => {
            invalidate();
            await onComplete();
          }}
        />
      )}
      {operation && (
        <AccountOperations
          workspaceId={workspaceId}
          apiBase={apiBase}
          account={account}
          operation={operation.kind}
          domain={operation.domain}
          onClose={() => setOperation(null)}
          onDomain={(domain) =>
            setDomainResults((current) => [
              ...current.filter(
                (item) =>
                  item.domain !== domain.domain ||
                  item.subdomain !== domain.subdomain,
              ),
              domain,
            ])
          }
          onComplete={async () => {
            setChecked(null);
            setInvalidated(true);
            if (operation.kind !== "domain") setDomainResults([]);
            await onComplete();
          }}
        />
      )}
    </Stack>
  );
}

function EspAccountsContent(props: InfrastructureProps) {
  const { infrastructure, accountId, workspaceId, apiBase, onComplete } = props;
  const [creating, setCreating] = useState(false);
  const accounts = rows(infrastructure.accounts);
  const selected = accounts.find((account) => account.id === accountId);
  const health = useQuery({
    queryKey: ["publication-management", apiBase, workspaceId, "health", ""],
    staleTime: 15_000,
    queryFn: async () =>
      record(
        record(
          (
            await axios.get(`${apiBase}/api/publications/delivery-health`, {
              params: { workspaceId },
            })
          ).data,
        ).data,
      ),
  });
  const summaries = new Map(
    rows(health.data?.accounts).map((summary) => [
      text(summary.accountId),
      summary,
    ]),
  );
  if (accountId) {
    if (!selected)
      return <Alert severity="warning">ESP account not found</Alert>;
    return (
      <Stack spacing={2}>
        {health.isError && (
          <Alert severity="warning">
            Activity summary unavailable: {errorText(health.error)}
          </Alert>
        )}
        <AccountDetails
          key={accountId}
          {...props}
          account={selected}
          summary={summaries.get(accountId)}
        />
      </Stack>
    );
  }
  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography component="h1" variant="h2">
          ESP accounts
        </Typography>
        <Button variant="contained" onClick={() => setCreating(true)}>
          Add account
        </Button>
      </Stack>
      {health.isError && (
        <Alert severity="warning">
          Activity summary unavailable: {errorText(health.error)}
        </Alert>
      )}
      <DataTable
        label="Workspace ESP accounts"
        data={accounts}
        columns={[
          {
            label: "Account",
            render: (account) => (
              <Link href={`/workspace/esp-accounts/${text(account.id)}`}>
                {text(account.name)}
              </Link>
            ),
          },
          { label: "Provider", render: (account) => text(account.provider) },
          {
            label: "Connection",
            render: (account) => <Readiness account={account} />,
          },
          { label: "Added", render: (account) => date(account.createdAt) },
          {
            label: "Attempts (30d)",
            render: (account) => value(summaries.get(text(account.id))?.sends),
          },
          {
            label: "Delivered (30d)",
            render: (account) =>
              value(summaries.get(text(account.id))?.delivered),
          },
          {
            label: "Bounced (30d)",
            render: (account) =>
              value(summaries.get(text(account.id))?.bounced),
          },
          {
            label: "Complaints (30d)",
            render: (account) =>
              value(summaries.get(text(account.id))?.complaints),
          },
        ]}
      />
      {creating && (
        <AccountEditor
          workspaceId={workspaceId}
          apiBase={apiBase}
          onComplete={onComplete}
          onClose={() => setCreating(false)}
        />
      )}
    </Stack>
  );
}

export default function EspAccounts(props: InfrastructureProps) {
  const { workspaceId, accountId } = props;
  return (
    <Box sx={{ minWidth: 0, maxWidth: "100%" }}>
      <EspAccountsContent
        key={`${workspaceId}:${accountId ?? "list"}`}
        {...props}
      />
    </Box>
  );
}

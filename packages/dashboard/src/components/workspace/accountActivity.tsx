import { Alert, Button, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { useState } from "react";

import { errorText, record, rows, text } from "../publications/settingsShared";
import {
  DataTable,
  date,
  InfrastructureProps,
  value,
} from "./infrastructureShared";

export default function AccountActivity({
  workspaceId,
  apiBase,
  accountId,
}: Pick<InfrastructureProps, "workspaceId" | "apiBase" | "accountId">) {
  const [offset, setOffset] = useState(0);
  const sends = useQuery({
    queryKey: [
      "publications",
      workspaceId,
      apiBase,
      "account-sends",
      accountId,
      offset,
    ],
    queryFn: async () =>
      record(
        (
          await axios.get(`${apiBase}/api/publications/sends`, {
            params: { workspaceId, accountId, limit: 25, offset },
          })
        ).data,
      ).data,
    enabled: Boolean(accountId),
  });
  const health = useQuery({
    queryKey: [
      "publications",
      workspaceId,
      apiBase,
      "account-health",
      accountId,
    ],
    queryFn: async () =>
      record(
        record(
          (
            await axios.get(`${apiBase}/api/publications/delivery-health`, {
              params: { workspaceId, accountId },
            })
          ).data,
        ).data,
      ),
    enabled: Boolean(accountId),
  });
  const history = rows(record(sends.data).sends ?? sends.data);
  return (
    <Stack spacing={2}>
      {sends.isError && (
        <Alert severity="error">
          Send history unavailable: {errorText(sends.error)}
        </Alert>
      )}
      {health.isError && (
        <Alert severity="warning">
          Delivery observations unavailable: {errorText(health.error)}
        </Alert>
      )}
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">Observed activity</Typography>
        <Button
          disabled={sends.isFetching || health.isFetching}
          onClick={() => {
            void sends.refetch();
            void health.refetch();
          }}
        >
          Refresh
        </Button>
      </Stack>
      {(sends.isLoading || health.isLoading) && (
        <Typography role="status">Loading activity…</Typography>
      )}
      <DataTable
        label="Account send history"
        data={history}
        columns={[
          { label: "Created", render: (item) => date(item.createdAt) },
          {
            label: "Send",
            render: (item) => text(item.logicalMessageId ?? item.id),
          },
          { label: "State", render: (item) => text(item.state) },
          {
            label: "Selection",
            render: (item) => value(record(item.selection).mode),
          },
          {
            label: "Observed IP",
            render: (item) => value(item.actualIp ?? item.providerIp),
          },
          { label: "Review reason", render: (item) => text(item.error) },
        ]}
      />
      <Stack direction="row" spacing={1}>
        <Button
          disabled={!offset || sends.isFetching}
          onClick={() => setOffset((current) => Math.max(0, current - 25))}
        >
          Previous
        </Button>
        <Button
          disabled={history.length < 25 || sends.isFetching}
          onClick={() => setOffset((current) => current + 25)}
        >
          Next
        </Button>
      </Stack>
      <Typography variant="subtitle2">Delivery observations</Typography>
      <Typography variant="caption" color="text.secondary">
        {date(health.data?.periodStart)} — {date(health.data?.periodEnd)}
      </Typography>
      <DataTable
        label="Account delivery observations"
        data={rows(health.data?.observations)}
        columns={[
          { label: "Observation", render: (item) => text(item.event) },
          {
            label: "Historical physical IP",
            render: (item) => value(item.ipId),
          },
          {
            label: "Sends with observation",
            render: (item) => value(item.sendsWithEvent),
          },
          {
            label: "Distinct observed events",
            render: (item) => value(item.observedEventCount),
          },
        ]}
      />
      <DataTable
        label="Account queue states"
        data={rows(health.data?.states)}
        columns={[
          { label: "Queue state", render: (item) => text(item.state) },
          { label: "Sends", render: (item) => value(item.count) },
        ]}
      />
    </Stack>
  );
}

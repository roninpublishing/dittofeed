import { Box, Paper, Stack, Typography } from "@mui/material";
import { useMemo } from "react";

import { WorkspaceDomain } from "../../lib/workspaceDomains";
import { workspaceTopology } from "../../lib/workspaceTopology";
import { record, RecordValue, rows } from "../publications/settingsShared";
import { DeliveryMetricCards, useDeliveryHealth } from "./deliveryMetrics";
import Link from "./navigation";
import OverviewOrganization from "./overviewOrganization";

export default function Overview({
  workspaceId,
  apiBase,
  workspaceName,
  infrastructure,
  newsletters,
  domains,
}: {
  workspaceId: string;
  apiBase: string;
  workspaceName: string;
  infrastructure: RecordValue;
  newsletters: unknown;
  domains?: WorkspaceDomain[];
}) {
  const health = useDeliveryHealth(apiBase, workspaceId);
  let metricState: "loading" | "unavailable" | "ready" = "ready";
  if (health.isPending) metricState = "loading";
  if (health.isError) metricState = "unavailable";
  const topology = useMemo(
    () =>
      workspaceTopology(
        workspaceId,
        workspaceName,
        infrastructure,
        newsletters,
        domains,
      ),
    [domains, infrastructure, newsletters, workspaceId, workspaceName],
  );
  return (
    <Stack spacing={2} minWidth={0}>
      <Typography component="h1" variant="h2">
        Overview
      </Typography>
      <DeliveryMetricCards
        summary={record(health.data?.summary)}
        state={metricState}
      />
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 2,
        }}
      >
        {(
          [
            ["Newsletters", rows(newsletters).length, "/workspace/newsletters"],
            [
              "ESP accounts",
              rows(infrastructure.accounts).length,
              "/workspace/esp-accounts",
            ],
            [
              "Dedicated IPs",
              topology.objects.filter((object) => object.kind === "ip").length,
              "/workspace/ips",
            ],
            [
              "Shared IPs",
              rows(infrastructure.pools).length,
              "/workspace/ip-pools",
            ],
            ["Domains", domains?.length ?? 0, "/workspace/domains"],
          ] as const
        ).map(([label, value, href]) => (
          <Paper
            key={label}
            component={Link}
            href={href}
            variant="outlined"
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              px: 1,
              py: 0.5,
              border: 0,
              bgcolor: "transparent",
              textDecoration: "none",
              color: "inherit",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Typography component="span" color="text.secondary" fontSize={13}>
              {label}
            </Typography>
            <Typography component="span" fontSize={13} fontWeight={600}>
              {value}
            </Typography>
          </Paper>
        ))}
      </Box>
      <OverviewOrganization topology={topology} />
    </Stack>
  );
}

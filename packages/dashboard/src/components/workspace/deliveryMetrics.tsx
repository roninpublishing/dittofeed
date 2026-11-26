import { Box, Paper, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";

import { WorkspaceDomain } from "../../lib/workspaceDomains";
import { record, RecordValue, rows } from "../publications/settingsShared";

export function useDeliveryHealth(apiBase: string, workspaceId: string) {
  return useQuery({
    queryKey: ["publication-management", apiBase, workspaceId, "health", ""],
    enabled: Boolean(workspaceId),
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{ data: RecordValue }>(
        `${apiBase}/api/publications/delivery-health`,
        { params: { workspaceId }, signal },
      );
      return record(response.data.data);
    },
  });
}

export function useDeliverySummary(apiBase: string, workspaceId: string) {
  return useQuery({
    queryKey: ["publication-management", apiBase, workspaceId, "delivery-summary"],
    enabled: Boolean(workspaceId),
    staleTime: 15_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{ data: RecordValue }>(
        `${apiBase}/api/publications/delivery-summary`,
        { params: { workspaceId }, signal, timeout: 10_000 },
      );
      return record(response.data.data);
    },
  });
}

export function deliveryMetricValue(
  summary: RecordValue | undefined,
  key: string,
  state: "loading" | "unavailable" | "ready" = "ready",
): string {
  if (summary?.notApplicable) return "N/A";
  if (state === "loading") return "Loading";
  if (state === "unavailable") return "Unavailable";
  if (key !== "sends" && summary?.observationsAvailable === false)
    return "Unavailable";
  const value = summary?.[key];
  if (typeof value !== "number") return "Unknown";
  return key === "deliverabilityRate"
    ? `${value.toFixed(1)}%`
    : value.toLocaleString();
}

export function domainDeliverySummary(
  domain: WorkspaceDomain,
  health: RecordValue | undefined,
): RecordValue | undefined {
  if (domain.kind === "tracking") return { notApplicable: true };
  if (!health) return undefined;
  const normalizedHostname = domain.hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const cohorts = rows(health.domains);
  const matched = cohorts.find(
    (item) =>
      item.accountId === domain.ownerId &&
      typeof item.senderDomain === "string" &&
      item.senderDomain.trim().toLowerCase().replace(/\.$/, "") ===
        normalizedHostname,
  );
  if (matched) return matched;
  // Unknown historical senders cannot establish a zero for any configured domain.
  const unknown = cohorts.some(
    (item) =>
      item.accountId === domain.ownerId &&
      !item.senderDomain &&
      [item.sends, item.resolvedOutcomes, item.complaints].some(
        (value) => typeof value === "number" && value > 0,
      ),
  );
  return {
    sends: unknown ? null : 0,
    delivered: unknown ? null : 0,
    bounced: unknown ? null : 0,
    complaints: unknown ? null : 0,
    deliverabilityRate: null,
    observationsAvailable: health.observationsAvailable,
  };
}

export function DeliveryMetricCards({
  summary,
  state = "ready",
}: {
  summary?: RecordValue;
  state?: "loading" | "unavailable" | "ready";
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "repeat(2,minmax(0,1fr))",
          md: "repeat(5,minmax(0,1fr))",
        },
        gap: 1.5,
      }}
    >
      {[
        ["Attempts (30d)", "sends"],
        ["Delivered", "delivered"],
        ["Deliverability", "deliverabilityRate"],
        ["Bounced", "bounced"],
        ["Complaints", "complaints"],
      ].map(([label, key]) => (
        <Paper
          key={key}
          variant="outlined"
          sx={{ p: 1.75, borderRadius: 1, minWidth: 0 }}
        >
          <Typography color="text.secondary">{label}</Typography>
          <Typography variant="h2" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
            {deliveryMetricValue(summary, key!, state)}
          </Typography>
        </Paper>
      ))}
    </Box>
  );
}

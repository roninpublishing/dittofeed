import {
  Alert,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { CompletionStatus } from "isomorphic-lib/src/types";
import { useCallback, useMemo } from "react";

import { useAppStorePick } from "../../lib/appStore";
import { buildWorkspaceDomains } from "../../lib/workspaceDomains";
import { WorkspaceRoute } from "../../lib/workspaceRoutes";
import PublicationManagement from "../publications/management";
import {
  errorText,
  record,
  RecordValue,
  rows,
  text,
} from "../publications/settingsShared";
import WorkspaceAutomations from "./automations";
import Domains from "./domains";
import EspAccounts from "./espAccounts";
import IpResources from "./ipResources";
import NewsletterDefaults from "./newsletterDefaults";
import Overview from "./overview";

export default function WorkspaceDashboard({
  publisherId,
  route,
}: {
  publisherId: string | null;
  route: WorkspaceRoute;
}) {
  const { workspace, apiBase } = useAppStorePick(["workspace", "apiBase"]);
  const queryClient = useQueryClient();
  const workspaceId =
    workspace.type === CompletionStatus.Successful ? workspace.value.id : "";
  const isWorkspace = publisherId === workspaceId;
  const managedSection =
    route.section === "overview" ||
    route.section === "esp-accounts" ||
    route.section === "domains" ||
    route.section === "ips" ||
    route.section === "ip-pools" ||
    (route.section === "newsletters" && route.resourceId !== null);
  const infrastructure = useQuery({
    queryKey: ["workspace-infrastructure", apiBase, workspaceId],
    enabled: Boolean(publisherId) && isWorkspace && managedSection,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{ data: RecordValue }>(
        `${apiBase}/api/publications/infrastructure`,
        { params: { workspaceId }, signal },
      );
      return record(response.data.data);
    },
  });
  const newsletters = useQuery({
    queryKey: [
      "publication-management",
      apiBase,
      workspaceId,
      "newsletters",
      "",
    ],
    enabled:
      Boolean(publisherId) &&
      isWorkspace &&
      (route.section === "overview" ||
        route.section === "domains" ||
        route.section === "automations" ||
        (route.section === "newsletters" && route.resourceId !== null)),
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{ data: unknown }>(
        `${apiBase}/api/publications/`,
        { params: { workspaceId }, signal },
      );
      return response.data.data;
    },
  });
  const needsDomains =
    route.section === "overview" || route.section === "domains";
  const domainCatalog = useQuery({
    queryKey: ["workspace-domain-catalog", apiBase, workspaceId],
    enabled: Boolean(publisherId) && isWorkspace && needsDomains,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{ data: unknown }>(
        `${apiBase}/api/publications/tracking-domains`,
        { params: { workspaceId }, signal },
      );
      return response.data.data;
    },
  });
  const domains = useMemo(
    () =>
      buildWorkspaceDomains(
        workspaceId,
        infrastructure.data ?? {},
        domainCatalog.data,
      ),
    [workspaceId, infrastructure.data, domainCatalog.data],
  );
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["workspace-infrastructure", apiBase, workspaceId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["publication-management", apiBase, workspaceId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["publications", workspaceId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["workspace-domain-catalog", apiBase, workspaceId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["newsletter-sending-options"],
      }),
    ]);
  }, [apiBase, queryClient, workspaceId]);

  if (!publisherId || !isWorkspace)
    return (
      <PublicationManagement publisherId={publisherId} section="newsletters" />
    );
  if (
    route.section === "subscribers" ||
    route.section === "reports" ||
    route.section === "settings" ||
    (route.section === "newsletters" && !route.resourceId)
  ) {
    return (
      <PublicationManagement
        key={`${workspaceId}:${route.section}`}
        publisherId={publisherId}
        section={route.section}
      />
    );
  }
  if (route.section === "tracking")
    return (
      <Typography component="h1" variant="h2">
        Tracking
      </Typography>
    );
  if (route.section === "automations")
    return (
      <WorkspaceAutomations
        workspaceId={workspaceId}
        apiBase={apiBase}
        newsletters={rows(newsletters.data).map((item) => ({
          value: text(item.workspaceId),
          label: text(item.name),
        }))}
      />
    );
  const needsNewsletters =
    route.section === "overview" ||
    route.section === "newsletters" ||
    route.section === "domains";
  const failure =
    infrastructure.error ?? (needsNewsletters ? newsletters.error : null);
  if (failure)
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {errorText(failure)}
      </Alert>
    );
  if (
    !infrastructure.data ||
    (needsNewsletters && newsletters.isPending) ||
    (needsDomains && domainCatalog.isPending)
  )
    return (
      <Stack alignItems="center" py={4}>
        <CircularProgress size={28} aria-label="Loading workspace" />
      </Stack>
    );
  const common = {
    workspaceId,
    apiBase,
    infrastructure: infrastructure.data,
    onComplete: refresh,
  };
  if (route.section === "domains")
    return (
      <Stack spacing={2}>
        {domainCatalog.isError && (
          <Alert severity="warning">Tracking domains unavailable.</Alert>
        )}
        <Domains
          {...common}
          domains={domains}
          newsletters={newsletters.data}
          resourceId={route.resourceId ?? undefined}
        />
      </Stack>
    );
  if (route.section === "esp-accounts")
    return (
      <EspAccounts
        key={`${workspaceId}:${route.resourceId ?? "list"}`}
        {...common}
        accountId={route.resourceId ?? undefined}
      />
    );
  if (route.section === "ips" || route.section === "ip-pools")
    return (
      <IpResources
        key={`${workspaceId}:${route.section}:${route.resourceId ?? "list"}`}
        {...common}
        kind={route.section === "ips" ? "ips" : "pools"}
        resourceId={route.resourceId ?? undefined}
      />
    );
  if (route.section === "newsletters" && route.resourceId)
    return (
      <NewsletterDefaults
        key={`${workspaceId}:${route.resourceId}`}
        {...common}
        newsletterId={route.resourceId}
        newsletters={newsletters.data}
      />
    );
  return (
    <Stack spacing={2}>
      {domainCatalog.isError && (
        <Alert severity="warning">Tracking domains unavailable.</Alert>
      )}
      <Overview
        workspaceId={workspaceId}
        workspaceName={
          workspace.type === CompletionStatus.Successful
            ? workspace.value.name
            : "Workspace"
        }
        infrastructure={infrastructure.data}
        newsletters={newsletters.data}
        domains={domains}
      />
    </Stack>
  );
}

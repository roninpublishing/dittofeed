import {
  AccountTreeOutlined,
  DnsOutlined,
  FolderOutlined,
  HubOutlined,
  LanguageOutlined,
  MailOutline,
  SettingsEthernetOutlined,
} from "@mui/icons-material";
import { Box, Paper, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { ReactElement, useMemo } from "react";

import {
  WorkspaceObject,
  WorkspaceTopology,
} from "../../lib/workspaceTopology";
import Link from "./navigation";

const objectIcons = {
  workspace: AccountTreeOutlined,
  group: FolderOutlined,
  newsletter: MailOutline,
  account: HubOutlined,
  ip: SettingsEthernetOutlined,
  pool: DnsOutlined,
  domain: LanguageOutlined,
};
const kindLabels = {
  workspace: "Workspace",
  group: "Section",
  newsletter: "Newsletter",
  account: "ESP account",
  ip: "Dedicated IP",
  pool: "Shared IPs",
  domain: "Domain",
};
const connectorColor = "var(--workspace-org-connector)";
const linkStyle = {
  color: "inherit",
  textDecoration: "none",
  overflowWrap: "anywhere",
  "&:hover": { bgcolor: "action.hover" },
  "&:focus-visible": { outline: "2px solid currentColor", outlineOffset: 3 },
} as const;
const branchStyle = {
  listStyle: "none",
  m: 0,
  ml: { xs: 1, sm: 2 },
  pl: { xs: 2, sm: 3 },
  pt: 2,
  borderLeft: `1px solid ${connectorColor}`,
  minWidth: 0,
} as const;

function OrganizationHeader({ object }: { object: WorkspaceObject }) {
  const Icon = objectIcons[object.kind];
  return (
    <Box
      sx={{
        position: "relative",
        bgcolor: "text.primary",
        color: "background.paper",
        borderRadius: 1,
        p: 2,
        minWidth: 0,
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Icon sx={{ fontSize: 25, flexShrink: 0 }} />
        <Box minWidth={0}>
          {object.kind === "workspace" && (
            <Typography fontSize={13} color="inherit">
              Workspace
            </Typography>
          )}
          <Typography
            component={object.kind === "workspace" ? "h2" : "h3"}
            fontSize={18}
            fontWeight={600}
            sx={{ overflowWrap: "anywhere" }}
          >
            {object.name}
          </Typography>
        </Box>
      </Stack>
    </Box>
  );
}

export default function OverviewOrganization({
  topology,
}: {
  topology: WorkspaceTopology;
}) {
  const theme = useTheme();
  const { children, accountIds, memberships } = useMemo(() => {
    const objectById = new Map(
      topology.objects.map((object) => [object.id, object]),
    );
    const childrenById = new Map<string, WorkspaceObject[]>();
    const poolsByIp = new Map<string, WorkspaceObject[]>();
    for (const link of topology.links) {
      const source = objectById.get(link.source);
      const target = objectById.get(link.target);
      if (!source || !target) continue;
      const map = link.membership ? poolsByIp : childrenById;
      const id = link.membership ? target.id : source.id;
      const child = link.membership ? source : target;
      const siblings = map.get(id);
      if (siblings) siblings.push(child);
      else map.set(id, [child]);
    }
    return {
      children: childrenById,
      accountIds: new Set(
        topology.objects
          .filter((object) => object.kind === "account")
          .map((object) => object.resourceId),
      ),
      memberships: poolsByIp,
    };
  }, [topology]);
  const root = topology.objects.find((object) => object.kind === "workspace");
  if (!root) return null;
  const groups = children.get(root.id) ?? [];

  const resource = (
    object: WorkspaceObject,
    parent: WorkspaceObject,
  ): ReactElement => {
    const Icon = objectIcons[object.kind];
    const configurations = object.configurations?.filter((configuration) =>
      parent.kind === "account"
        ? configuration.accountId === parent.resourceId
        : !accountIds.has(configuration.accountId),
    );
    const primaryPath = configurations?.[0]?.path ?? object.path;
    const status =
      configurations?.length === 1 ? configurations[0]?.status : object.status;
    const sharedAccounts = new Set(
      object.configurations?.map((configuration) => configuration.accountId),
    ).size;
    const label = object.domainKind
      ? `${object.domainKind === "tracking" ? "Tracking" : "Sending"} domain`
      : kindLabels[object.kind];
    const owned = children.get(object.id) ?? [];
    const pools = memberships.get(object.id) ?? [];
    return (
      <Box component="li" key={object.id} sx={{ minWidth: 0 }}>
        <Paper
          variant="outlined"
          sx={{
            position: "relative",
            p: 2,
            minWidth: 0,
            bgcolor: "background.paper",
            color: "text.primary",
            borderColor: "divider",
            borderRadius: 1,
            "&::before": {
              content: '""',
              position: "absolute",
              right: "100%",
              top: 28,
              width: { xs: 16, sm: 24 },
              borderTop: `1px solid ${connectorColor}`,
            },
          }}
        >
          <Stack direction="row" spacing={1.25} alignItems="flex-start">
            <Icon sx={{ fontSize: 23, mt: 0.25, flexShrink: 0 }} />
            <Box minWidth={0} flex={1}>
              <Typography fontSize={13} sx={{ mb: 0.5 }}>
                {label}
              </Typography>
              <Typography
                component="h4"
                fontSize={16}
                lineHeight={1.4}
                fontWeight={600}
                sx={{ overflowWrap: "anywhere" }}
              >
                {configurations && configurations.length > 1 ? (
                  object.name
                ) : (
                  <Box component={Link} href={primaryPath} sx={linkStyle}>
                    {object.name}
                  </Box>
                )}
              </Typography>
              {(object.provider || status) && (
                <Typography
                  fontSize={13}
                  sx={{ mt: 0.5, overflowWrap: "anywhere" }}
                >
                  {[object.provider, status].filter(Boolean).join(" · ")}
                </Typography>
              )}
              {sharedAccounts > 1 && (
                <Typography fontSize={13} sx={{ mt: 0.5 }}>
                  Shared physical IP · {sharedAccounts} accounts
                </Typography>
              )}
              {configurations && configurations.length > 1 && (
                <Stack
                  component="ul"
                  spacing={0.75}
                  sx={{ listStyle: "none", p: 0, m: 0, mt: 1 }}
                >
                  {configurations.map((configuration, index) => (
                    <Box component="li" key={configuration.path}>
                      <Box
                        component={Link}
                        href={configuration.path}
                        sx={{ ...linkStyle, fontSize: 13 }}
                      >
                        {configuration.accountName} · Configuration {index + 1}
                        {configuration.status
                          ? ` · ${configuration.status}`
                          : ""}
                      </Box>
                    </Box>
                  ))}
                </Stack>
              )}
              {pools.length > 0 && (
                <Stack
                  direction="row"
                  flexWrap="wrap"
                  gap={0.75}
                  sx={{ mt: 1 }}
                >
                  <Typography fontSize={13}>Pools:</Typography>
                  {pools.map((pool) => (
                    <Box
                      component={Link}
                      key={pool.id}
                      href={pool.path}
                      sx={{ ...linkStyle, fontSize: 13 }}
                    >
                      {pool.name}
                    </Box>
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>
        </Paper>
        {owned.length > 0 && (
          <Stack component="ul" spacing={1.5} sx={branchStyle}>
            {owned.map((member) => resource(member, object))}
          </Stack>
        )}
      </Box>
    );
  };

  return (
    <Paper
      component="section"
      aria-label="Workspace organization"
      variant="outlined"
      sx={{
        "--workspace-org-connector": theme.palette.divider,
        p: { xs: 1.5, sm: 3 },
        minWidth: 0,
        maxWidth: "100%",
        overflowX: "auto",
      }}
    >
      <Box sx={{ width: "100%", minWidth: 0 }}>
        <Box sx={{ maxWidth: 400, mx: "auto" }}>
          <OrganizationHeader object={root} />
        </Box>
        <Box
          sx={{
            width: "50%",
            height: 28,
            borderRight: `1px solid ${connectorColor}`,
          }}
        />
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              md: `repeat(${groups.length}, minmax(0, 1fr))`,
            },
            gap: { xs: 3, md: 4 },
            minWidth: 0,
            position: "relative",
            borderLeft: { xs: `1px solid ${connectorColor}`, md: 0 },
            ml: { xs: 1, md: 0 },
            pl: { xs: 2, md: 0 },
            pt: { xs: 2, md: 0 },
            "&::before": {
              content: '""',
              display: { xs: "block", md: "none" },
              position: "absolute",
              top: 0,
              left: 0,
              width: "50%",
              borderTop: `1px solid ${connectorColor}`,
            },
          }}
        >
          {groups.map((group, index) => (
            <Box
              key={group.id}
              sx={{
                position: "relative",
                minWidth: 0,
                pt: { xs: 0, md: 3 },
                "&::before": {
                  content: '""',
                  display: "block",
                  position: "absolute",
                  top: { xs: 28, md: 0 },
                  left: { xs: -17, md: index === 0 ? "50%" : -16 },
                  right: {
                    xs: "100%",
                    md: index === groups.length - 1 ? "50%" : -16,
                  },
                  borderTop: `1px solid ${connectorColor}`,
                },
                "&::after": {
                  content: '""',
                  display: { xs: "none", md: "block" },
                  position: "absolute",
                  top: 0,
                  left: "50%",
                  height: 24,
                  borderLeft: `1px solid ${connectorColor}`,
                },
              }}
            >
              <OrganizationHeader object={group} />
              {(children.get(group.id)?.length ?? 0) > 0 ? (
                <Stack component="ul" spacing={1.5} sx={branchStyle}>
                  {children
                    .get(group.id)!
                    .map((member) => resource(member, group))}
                </Stack>
              ) : (
                <Typography fontSize={13} sx={{ p: 2 }}>
                  None
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      </Box>
    </Paper>
  );
}

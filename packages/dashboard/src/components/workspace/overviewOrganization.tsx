import {
  AccountTreeOutlined,
  DnsOutlined,
  FolderOutlined,
  HubOutlined,
  LanguageOutlined,
  MailOutline,
  SettingsEthernetOutlined,
} from "@mui/icons-material";
import { Box, Paper, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useId, useMemo } from "react";

import { organizationDiagram } from "../../lib/organizationDiagram";
import { WorkspaceTopology } from "../../lib/workspaceTopology";
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

export default function OverviewOrganization({
  topology,
}: {
  topology: WorkspaceTopology;
}) {
  const theme = useTheme();
  const markerId = useId().replace(/:/g, "");
  const diagram = useMemo(() => organizationDiagram(topology), [topology]);
  return (
    <Paper
      component="section"
      aria-label="Workspace organization"
      variant="outlined"
      sx={{ p: 1, minWidth: 0, maxWidth: "100%", overflowX: "auto" }}
    >
      <Box
        sx={{
          position: "relative",
          width: diagram.width,
          height: diagram.height,
          mx: "auto",
        }}
      >
        <svg
          width={diagram.width}
          height={diagram.height}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            color: theme.palette.text.secondary,
          }}
        >
          <defs>
            <marker
              id={markerId}
              markerWidth="5"
              markerHeight="5"
              refX="5"
              refY="2.5"
              orient="auto"
            >
              <path d="M0 0 L5 2.5 L0 5" fill="currentColor" />
            </marker>
          </defs>
          {diagram.edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              markerEnd={`url(#${markerId})`}
            />
          ))}
        </svg>
        {diagram.nodes.map((node) => {
          const Icon = objectIcons[node.object.kind];
          const organizational =
            node.object.kind === "workspace" || node.object.kind === "group";
          let kind = kindLabels[node.object.kind];
          if (node.object.domainKind === "sending") kind = "Sending domain";
          if (node.object.domainKind === "tracking") kind = "Tracking domain";
          const label = `${kind}: ${node.object.name}`;
          return (
            <Box
              key={node.id}
              component={organizational ? "div" : Link}
              {...(!organizational
                ? { href: node.href ?? node.object.path }
                : {})}
              aria-label={label}
              title={[label, node.object.accountName, node.object.status]
                .filter(Boolean)
                .join(" · ")}
              sx={{
                position: "absolute",
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                px: 1,
                py: 0.75,
                boxSizing: "border-box",
                border: 1,
                borderColor: organizational ? "text.primary" : "divider",
                borderRadius: 0.75,
                bgcolor: organizational ? "text.primary" : "background.paper",
                color: organizational ? "background.paper" : "text.primary",
                textDecoration: "none",
                ...(!organizational && {
                  "&:hover": {
                    bgcolor: "action.hover",
                    borderColor: "text.secondary",
                  },
                  "&:focus-visible": {
                    outline: "2px solid",
                    outlineColor: "primary.main",
                    outlineOffset: 2,
                  },
                }),
              }}
            >
              <Icon
                sx={{ fontSize: organizational ? 18 : 16, flexShrink: 0 }}
              />
              <Typography
                component="span"
                fontSize={13}
                fontWeight={organizational ? 700 : 500}
                lineHeight={1.25}
                sx={{
                  overflowWrap: "anywhere",
                  wordBreak:
                    node.object.kind === "domain" ? "break-all" : "normal",
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {node.object.name}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
}

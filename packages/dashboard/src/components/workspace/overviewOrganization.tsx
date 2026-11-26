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
import { alpha, lighten, useTheme } from "@mui/material/styles";
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
const kindAccents = {
  workspace: "#374151",
  group: "#374151",
  newsletter: "#4f795d",
  account: "#786294",
  ip: "#4e7398",
  pool: "#987744",
  domain: "#438184",
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
          const accent =
            theme.palette.mode === "dark"
              ? lighten(kindAccents[node.object.kind], 0.45)
              : kindAccents[node.object.kind];
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
                gap: 1.25,
                px: 1.5,
                py: organizational ? 0.5 : 1.25,
                boxSizing: "border-box",
                border: 1,
                borderColor: organizational
                  ? "text.primary"
                  : alpha(accent, 0.3),
                borderRadius: 1.5,
                bgcolor: organizational ? "text.primary" : alpha(accent, 0.06),
                color: organizational ? "background.paper" : "text.primary",
                textDecoration: "none",
                ...(!organizational && {
                  "&:hover": {
                    bgcolor: alpha(accent, 0.12),
                    borderColor: alpha(accent, 0.6),
                  },
                  "&:focus-visible": {
                    outline: "2px solid",
                    outlineColor: "primary.main",
                    outlineOffset: 2,
                  },
                }),
              }}
            >
              <Box
                component="span"
                aria-hidden="true"
                sx={{
                  width: organizational ? 24 : 30,
                  height: organizational ? 24 : 30,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 1,
                  bgcolor: organizational ? "transparent" : alpha(accent, 0.12),
                  color: organizational ? "inherit" : accent,
                }}
              >
                <Icon sx={{ fontSize: 18 }} />
              </Box>
              <Typography
                component="span"
                fontSize={14}
                fontWeight={organizational ? 700 : 500}
                lineHeight={1.35}
                sx={{
                  minWidth: 0,
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

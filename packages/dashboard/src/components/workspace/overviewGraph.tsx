import "@xyflow/react/dist/style.css";

import {
  AccountTreeOutlined,
  DnsOutlined,
  FolderOutlined,
  HubOutlined,
  MailOutline,
  SettingsEthernetOutlined,
} from "@mui/icons-material";
import { Box, Stack, Typography, useTheme } from "@mui/material";
import {
  Background,
  Controls,
  Edge,
  Node,
  Position,
  ReactFlow,
  ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  workspaceNodeSize,
  WorkspaceObject,
  WorkspaceTopology,
  workspaceTopologyPositions,
} from "../../lib/workspaceTopology";

const objectIcons = {
  workspace: AccountTreeOutlined,
  group: FolderOutlined,
  newsletter: MailOutline,
  account: HubOutlined,
  ip: SettingsEthernetOutlined,
  pool: DnsOutlined,
  domain: DnsOutlined,
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
const fitViewOptions = { padding: 0.12, minZoom: 0.01, maxZoom: 1 };

export default function OverviewGraph({
  topology,
  selectedId,
  onSelect,
}: {
  topology: WorkspaceTopology;
  selectedId: string | null;
  onSelect: (object: WorkspaceObject) => void;
}) {
  const theme = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  const positions = useMemo(
    () => workspaceTopologyPositions(topology),
    [topology],
  );
  const layout = useMemo(() => {
    return topology.objects.map((object): Node => {
      const Icon = objectIcons[object.kind];
      return {
        id: object.id,
        position: positions.get(object.id)!,
        sourcePosition: Position.Bottom,
        targetPosition: ["newsletter", "ip", "pool", "domain"].includes(
          object.kind,
        )
          ? Position.Left
          : Position.Top,
        ariaLabel: `${kindLabels[object.kind]} ${object.name}`,
        data: {
          label: (
            <Stack direction="row" spacing={1.25} alignItems="center">
              <Icon sx={{ color: "primary.main", fontSize: 21 }} />
              <Box minWidth={0} textAlign="left">
                <Typography
                  fontSize={14}
                  fontWeight={600}
                  noWrap
                  title={[object.name, object.provider, object.status]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {object.name}
                </Typography>
              </Box>
            </Stack>
          ),
        },
        style: {
          ...workspaceNodeSize,
          padding: 6,
          borderRadius: 8,
          background: theme.palette.background.paper,
          color: theme.palette.text.primary,
          border: `1px solid ${theme.palette.divider}`,
          fontFamily: "inherit",
        },
      };
    });
  }, [positions, theme, topology]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(layout);
  useEffect(() => {
    setNodes(layout);
  }, [layout, setNodes]);
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({ ...node, selected: node.id === selectedId })),
    );
  }, [layout, selectedId, setNodes]);
  useEffect(() => {
    if (!instance || !container.current) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void instance.fitView(fitViewOptions);
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container.current);
    fit();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [instance, layout]);
  const edges = useMemo(
    () =>
      topology.links
        .filter(
          (link) =>
            !link.membership ||
            link.source === selectedId ||
            link.target === selectedId,
        )
        .map(
          (link): Edge => ({
            ...link,
            type: "smoothstep",
            selectable: false,
            style: {
              stroke: link.membership
                ? theme.palette.text.secondary
                : theme.palette.divider,
              strokeWidth: 1.5,
              ...(link.membership ? { strokeDasharray: "4 4" } : {}),
            },
          }),
        ),
    [selectedId, theme, topology],
  );
  return (
    <Box
      ref={container}
      sx={{
        height: {
          xs: "clamp(360px, calc(100dvh - 370px), 640px)",
          md: "clamp(320px, calc(100dvh - 300px), 800px)",
        },
        width: "100%",
        minWidth: 0,
        "& .react-flow__node.selected": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
        "& .react-flow__handle": { visibility: "hidden" },
        "& .react-flow__controls-button": {
          bgcolor: "background.paper",
          color: "text.primary",
          borderColor: "divider",
          fill: "currentColor",
        },
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onInit={setInstance}
        onNodeClick={(_event, node) => {
          const object = topology.objects.find(
            (candidate) => candidate.id === node.id,
          );
          if (object) onSelect(object);
        }}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={fitViewOptions.minZoom}
        maxZoom={1.5}
        onlyRenderVisibleElements
        colorMode={theme.palette.mode}
      >
        <Background color={theme.palette.divider} gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Box>
  );
}

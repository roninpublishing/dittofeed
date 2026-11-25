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
  useNodesState,
} from "@xyflow/react";
import dagre from "dagre";
import { useEffect, useMemo } from "react";

import {
  WorkspaceObject,
  WorkspaceTopology,
} from "../../lib/workspaceTopology";

const objectIcons = {
  workspace: AccountTreeOutlined,
  group: FolderOutlined,
  newsletter: MailOutline,
  account: HubOutlined,
  ip: SettingsEthernetOutlined,
  pool: DnsOutlined,
};

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
  const layout = useMemo(() => {
    const graph = new dagre.graphlib.Graph();
    graph.setDefaultEdgeLabel(() => ({}));
    graph.setGraph({
      rankdir: "LR",
      nodesep: 24,
      ranksep: 72,
      marginx: 24,
      marginy: 24,
    });
    for (const object of topology.objects)
      graph.setNode(object.id, { width: 212, height: 72 });
    for (const link of topology.links)
      if (!link.membership) graph.setEdge(link.source, link.target);
    dagre.layout(graph);
    return topology.objects.map((object): Node => {
      const position = graph.node(object.id);
      const Icon = objectIcons[object.kind];
      return {
        id: object.id,
        position: { x: position.x - 106, y: position.y - 36 },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        ariaLabel: `${object.kind === "account" ? "ESP account" : object.kind} ${object.name}`,
        data: {
          label: (
            <Stack direction="row" spacing={1.25} alignItems="center">
              <Icon sx={{ color: "primary.main", fontSize: 21 }} />
              <Box minWidth={0} textAlign="left">
                <Typography fontWeight={600} noWrap title={object.name}>
                  {object.name}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ textTransform: "capitalize" }}
                >
                  {object.provider ||
                    object.status ||
                    (object.kind === "group" ? "" : object.kind)}
                </Typography>
              </Box>
            </Stack>
          ),
        },
        style: {
          width: 212,
          height: 72,
          padding: 12,
          borderRadius: 8,
          background: theme.palette.background.paper,
          color: theme.palette.text.primary,
          border: `1px solid ${theme.palette.divider}`,
          fontFamily: "inherit",
        },
      };
    });
  }, [theme, topology]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(layout);
  useEffect(() => {
    setNodes((current) => {
      const positions = new Map(
        current.map((node) => [node.id, node.position]),
      );
      return layout.map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
        selected: node.id === selectedId,
      }));
    });
  }, [layout, selectedId, setNodes]);
  const edges = useMemo(
    () =>
      topology.links.map(
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
    [theme, topology],
  );
  return (
    <Box
      sx={{
        height: { xs: 360, md: "clamp(320px, calc(100dvh - 310px), 540px)" },
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
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.12}
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

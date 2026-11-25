import "@xyflow/react/dist/style.css";

import { Box } from "@mui/material";
import {
  Background,
  Controls,
  Edge,
  MarkerType,
  Node,
  ProOptions,
  ReactFlow,
  ReactFlowProps,
} from "@xyflow/react";

export const proOptions: ProOptions = {
  account: "paid-pro",
  hideAttribution: true,
};

/** Shared canvas presentation; each editor retains its own graph and execution model. */
export default function FlowCanvas<N extends Node, E extends Edge>({
  children,
  ...props
}: ReactFlowProps<N, E>) {
  return (
    <Box sx={{ width: "100%", height: "100%", m: 0, p: 0, display: "flex" }}>
      <ReactFlow<N, E>
        proOptions={proOptions}
        noDragClassName="nodrag"
        defaultEdgeOptions={{
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { strokeWidth: 2 },
        }}
        nodeOrigin={[0.5, 0.5]}
        minZoom={0.2}
        panOnScroll
        deleteKeyCode={null}
        zoomOnPinch
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        {...props}
      >
        {children}
        <Controls position="top-right" />
        <Background
          color="#C7C7D4"
          style={{ backgroundColor: "#F7F8FA" }}
          size={2}
        />
      </ReactFlow>
    </Box>
  );
}

import {
  EdgeChange,
  NodeChange,
  OnEdgesChange,
  OnNodesChange,
  Panel,
  ReactFlowProvider,
} from "@xyflow/react";
import {
  JourneyUiBodyNodeTypeProps,
  SavedSubscriptionGroupResource,
} from "isomorphic-lib/src/types";
import { DragEvent, DragEventHandler } from "react";
import { v4 as uuid } from "uuid";

import { useAppStorePick } from "../../lib/appStore";
import {
  JourneyEditorContent,
  JourneyUiEdge,
  JourneyUiNode,
} from "../../lib/types";
import { useJourneyStats } from "../../lib/useJourneyStats";
import { useSubscriptionGroupsQuery } from "../../lib/useSubscriptionGroupsQuery";
import edgeTypes from "./edgeTypes";
import { useJourneyStorePick } from "./editorStore";
import FlowCanvas from "./flowCanvas";
import NodeEditor from "./nodeEditor";
import nodeTypes from "./nodeTypes";
import { defaultBodyNodeTypeProps } from "./nodeTypes/defaultNodeTypeProps";
import Sidebar from "./sidebar";
import { createConnections } from "./store";

export const handleDragOver: DragEventHandler<HTMLDivElement> = (e) => {
  e.preventDefault();
};

// this function adds a new node and connects it to the source node
export function createNewConnections({
  nodes,
  nodeType,
  source,
  target,
  addNodes,
  subscriptionGroups,
  setSelectedNodeId,
  newTargetId: newTargetIdOverride,
}: {
  nodeType: JourneyUiBodyNodeTypeProps["type"];
  nodes: JourneyEditorContent["journeyNodes"];
  addNodes: JourneyEditorContent["addNodes"];
  source: string;
  target: string;
  subscriptionGroups: SavedSubscriptionGroupResource[];
  setSelectedNodeId: JourneyEditorContent["setSelectedNodeId"];
  newTargetId?: string;
}) {
  // TODO create an incremental ID based on the number of elements already in the graph
  const newTargetId = newTargetIdOverride ?? uuid();

  const { newNodes, newEdges } = createConnections({
    id: newTargetId,
    source,
    target,
    ...defaultBodyNodeTypeProps({ type: nodeType, nodes, subscriptionGroups }),
  });

  addNodes({ nodes: newNodes, edges: newEdges, source, target });
  setSelectedNodeId(newTargetId);
}

function JourneysBuilderInner({ journeyId }: { journeyId: string }) {
  const { upsertJourneyStats, setJourneyStatsRequest, viewDraft } =
    useAppStorePick([
      "upsertJourneyStats",
      "setJourneyStatsRequest",
      "viewDraft",
    ]);
  const {
    setNodes,
    addNodes,
    setEdges,
    journeyNodes: nodes,
    journeyEdges: edges,
    journeyDraggedComponentType: draggedComponentType,
    setSelectedNodeId,
  } = useJourneyStorePick([
    "setNodes",
    "addNodes",
    "setEdges",
    "journeyNodes",
    "journeyEdges",
    "journeyDraggedComponentType",
    "setSelectedNodeId",
  ]);
  const { data: subscriptionGroups } = useSubscriptionGroupsQuery();

  useJourneyStats({
    journeyIds: [journeyId],
    setJourneyStatsRequest,
    upsertJourneyStats,
  });

  // this function is called once the node from the sidebar is dropped onto a node in the current graph
  const onDrop: DragEventHandler = (evt: DragEvent<HTMLDivElement>) => {
    // make sure that the event target is a DOM element
    if (evt.target instanceof SVGElement && draggedComponentType) {
      const { source, target } = evt.target.dataset;
      // from the target element search for the node wrapper element which has the node id as attribute

      if (source && target) {
        // now we can create a connection to the drop target node
        createNewConnections({
          nodeType: draggedComponentType,
          source,
          target,
          addNodes,
          nodes,
          subscriptionGroups: subscriptionGroups ?? [],
          setSelectedNodeId,
        });
      }
    }
  };

  const onNodesChange: OnNodesChange<JourneyUiNode> = (
    changes: NodeChange<JourneyUiNode>[],
  ) => {
    setNodes(changes);
  };

  const onEdgesChange: OnEdgesChange<JourneyUiEdge> = (
    changes: EdgeChange<JourneyUiEdge>[],
  ) => {
    setEdges(changes);
  };

  return (
    <FlowCanvas<JourneyUiNode, JourneyUiEdge>
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onDrop={onDrop}
      onDragOver={handleDragOver}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      // TODO get fitview playing nice with nodeOrigin
      defaultViewport={{ x: 500, y: 0, zoom: 1 }}
      nodesDraggable={false}
    >
      <NodeEditor disabled={!viewDraft} />
      <Panel position="top-left">
        <Sidebar />
      </Panel>
    </FlowCanvas>
  );
}

export default function JourneysBuilder({ journeyId }: { journeyId: string }) {
  return (
    <ReactFlowProvider>
      <JourneysBuilderInner journeyId={journeyId} />
    </ReactFlowProvider>
  );
}

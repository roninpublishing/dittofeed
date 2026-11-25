import type { Node } from "@xyflow/react";
import {
  PublicationAutomationConditionOperator,
  PublicationAutomationDefinition,
} from "isomorphic-lib/src/publications";
import { schemaValidate } from "isomorphic-lib/src/resultHandling/schemaValidation";

export function validateAutomationDefinition(definition: unknown) {
  return schemaValidate(definition, PublicationAutomationDefinition);
}

export interface AutomationFlowEdge {
  id: string;
  source: AutomationStage;
  target: AutomationStage;
}

export function reconcileAutomationNodes<N extends Node>(
  current: N[],
  canonical: N[],
): N[] {
  const previous = new Map(current.map((node) => [node.id, node]));
  return canonical.map((node) => {
    const existing = previous.get(node.id);
    if (!existing) return node;
    return {
      ...existing,
      ...node,
      position: existing.dragging ? existing.position : node.position,
    };
  });
}

export interface AutomationConditionDraft {
  source: "traits" | "event";
  path: string;
  operator: PublicationAutomationConditionOperator;
  value?: unknown;
}
export type AutomationDefinitionDraft = Omit<
  PublicationAutomationDefinition,
  "source"
> & {
  source: Omit<PublicationAutomationDefinition["source"], "conditions"> & {
    conditions?: AutomationConditionDraft[];
  };
};
export type AutomationStage =
  | "trigger"
  | "conditions"
  | "dedupe"
  | "consent"
  | "match"
  | "create"
  | "mappings"
  | "subscribe"
  | "welcome";
export const automationStages: readonly AutomationStage[] = [
  "trigger",
  "conditions",
  "dedupe",
  "consent",
  "match",
  "create",
  "mappings",
  "subscribe",
  "welcome",
];
export const automationStageLabels: Record<AutomationStage, string> = {
  trigger: "Event trigger",
  conditions: "Conditions",
  dedupe: "Deduplicate",
  consent: "Explicit consent",
  match: "Match contact",
  create: "Create contact",
  mappings: "Map fields",
  subscribe: "Subscribe",
  welcome: "Welcome journey",
};

export function activeAutomationStages(
  definition: AutomationDefinitionDraft,
): AutomationStage[] {
  return automationStages.filter((stage) => {
    switch (stage) {
      case "trigger":
      case "match":
        return true;
      case "conditions":
        return Boolean(definition.source.conditions?.length);
      case "dedupe":
        return definition.oncePerSubscriber !== false;
      case "consent":
        return Boolean(definition.consent);
      case "create":
        return definition.destination.createIfMissing;
      case "mappings":
        return Boolean(definition.destination.fieldMappings?.length);
      case "subscribe":
        return definition.destination.subscribe;
      case "welcome":
        return definition.destination.welcomeJourneyId !== undefined;
      default:
        return false;
    }
  });
}

export function setAutomationStage(
  definition: AutomationDefinitionDraft,
  stage: AutomationStage,
  enabled: boolean,
): AutomationDefinitionDraft {
  switch (stage) {
    case "trigger":
    case "match":
      return definition;
    case "conditions": {
      let { conditions } = definition.source;
      if (!enabled) conditions = undefined;
      else if (!conditions?.length)
        conditions = [
          { source: "traits", path: "", operator: "equals", value: "" },
        ];
      return { ...definition, source: { ...definition.source, conditions } };
    }
    case "dedupe":
      return { ...definition, oncePerSubscriber: enabled };
    case "consent":
      return {
        ...definition,
        consent: enabled
          ? definition.consent ?? {
              type: "explicit",
              source: "event",
              path: "properties.consent",
              equals: true,
              authorization: "",
              allowResubscribe: false,
            }
          : undefined,
      };
    case "create":
      return {
        ...definition,
        destination: { ...definition.destination, createIfMissing: enabled },
      };
    case "mappings": {
      let { fieldMappings } = definition.destination;
      if (!enabled) fieldMappings = undefined;
      else if (!fieldMappings?.length)
        fieldMappings = [
          { source: "traits", path: "", destination: "", overwrite: false },
        ];
      return {
        ...definition,
        destination: { ...definition.destination, fieldMappings },
      };
    }
    case "subscribe":
      return {
        ...definition,
        destination: { ...definition.destination, subscribe: enabled },
      };
    case "welcome":
      return {
        ...definition,
        destination: {
          ...definition.destination,
          welcomeJourneyId: enabled
            ? definition.destination.welcomeJourneyId ?? ""
            : undefined,
        },
      };
    default:
      return definition;
  }
}

export function automationGraph(definition: AutomationDefinitionDraft) {
  const stages = activeAutomationStages(definition);
  return {
    nodes: stages.map((id, index) => ({
      id,
      position: definition.editorLayout?.nodePositions[id] ?? {
        x: 0,
        y: index * 140,
      },
    })),
    edges: stages.flatMap((source, index) => {
      const target = stages[index + 1];
      return target ? [{ id: `${source}-${target}`, source, target }] : [];
    }),
  };
}

export function moveAutomationNode(
  definition: AutomationDefinitionDraft,
  id: AutomationStage,
  position: { x: number; y: number },
): AutomationDefinitionDraft {
  const existing = definition.editorLayout?.nodePositions ?? {};
  // Keep the bounded layout contract even for definitions containing legacy editor keys.
  const nodePositions = Object.fromEntries(
    Object.entries(existing).slice(0, existing[id] ? 100 : 99),
  );
  return {
    ...definition,
    editorLayout: {
      nodePositions: {
        ...nodePositions,
        [id]: { x: position.x, y: position.y },
      },
    },
  };
}

import type { Node } from "@xyflow/react";
import { PublicationAutomationDefinition } from "isomorphic-lib/src/publications";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

import {
  activeAutomationStages,
  AutomationDefinitionDraft,
  automationGraph,
  AutomationStage,
  moveAutomationNode,
  reconcileAutomationNodes,
  setAutomationStage,
  validateAutomationDefinition,
} from "./automationFlow";

const definition: PublicationAutomationDefinition = {
  source: {
    eventType: "track",
    event: "DFEmailClicked",
    link: { path: "properties.url", equals: "https://example.com/news" },
    conditionMatch: "any",
    conditions: [
      {
        source: "traits",
        path: "score",
        operator: "greaterThanOrEqual",
        value: 3,
      },
      {
        source: "event",
        path: "properties.category",
        operator: "in",
        value: ["news", null],
      },
    ],
  },
  destination: {
    match: { field: "email", source: "event", path: "properties.email" },
    createIfMissing: true,
    subscribe: true,
    fieldMappings: [
      {
        source: "traits",
        path: "name",
        destination: "firstName",
        overwrite: true,
      },
    ],
    welcomeJourneyId: "4bb5065a-cf83-4fbb-b6e9-ec9f8cf0a78a",
  },
  oncePerSubscriber: false,
  consent: {
    type: "explicit",
    source: "event",
    path: "properties.approval",
    equals: true,
    authorization: "Signup form consent",
    allowResubscribe: true,
  },
};

describe("workspace automation flow model", () => {
  it("projects the execution path without mutating stored semantics", () => {
    const saved = unwrap(
      validateAutomationDefinition(JSON.parse(JSON.stringify(definition))),
    );
    const graph = automationGraph(saved);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "trigger",
      "conditions",
      "consent",
      "match",
      "create",
      "mappings",
      "subscribe",
      "welcome",
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["trigger", "conditions"],
      ["conditions", "consent"],
      ["consent", "match"],
      ["match", "create"],
      ["create", "mappings"],
      ["mappings", "subscribe"],
      ["subscribe", "welcome"],
    ]);
    expect(saved).toEqual(definition);
  });

  it("round-trips positions without changing source, destination, consent or dedupe", () => {
    const moved = moveAutomationNode(definition, "match", { x: 380, y: -15 });
    const saved = unwrap(
      validateAutomationDefinition(JSON.parse(JSON.stringify(moved))),
    );
    expect(
      automationGraph(saved).nodes.find((node) => node.id === "match")
        ?.position,
    ).toEqual({ x: 380, y: -15 });
    expect(saved.source).toEqual(definition.source);
    expect(saved.destination).toEqual(definition.destination);
    expect(saved.consent).toEqual(definition.consent);
    expect(saved.oncePerSubscriber).toBe(false);
    expect(definition.editorLayout).toBeUndefined();
  });

  it("removes a supported action and reconnects only the actual execution path", () => {
    const edited = setAutomationStage(definition, "create", false);
    expect(edited.destination.createIfMissing).toBe(false);
    expect(edited.destination.fieldMappings).toEqual(
      definition.destination.fieldMappings,
    );
    expect(automationGraph(edited).edges).toContainEqual({
      id: "match-mappings",
      source: "match",
      target: "mappings",
    });
    expect(activeAutomationStages(edited)).not.toContain("create");
    expect(setAutomationStage(edited, "create", true)).toEqual(definition);
  });

  it("adds meaningful editable mappings, conditions, consent and welcome actions", () => {
    let edited: AutomationDefinitionDraft = {
      source: { eventType: "identify" },
      destination: {
        match: { field: "email", source: "traits", path: "email" },
        createIfMissing: false,
        subscribe: false,
      },
      oncePerSubscriber: false,
    };
    const stages: AutomationStage[] = [
      "conditions",
      "mappings",
      "consent",
      "welcome",
    ];
    for (const stage of stages) {
      edited = setAutomationStage(edited, stage, true);
      expect(activeAutomationStages(edited)).toContain(stage);
    }
    expect(edited.source.conditions).toEqual([
      { source: "traits", path: "", operator: "equals", value: "" },
    ]);
    expect(edited.destination.fieldMappings).toEqual([
      { source: "traits", path: "", destination: "", overwrite: false },
    ]);
    expect(edited.consent?.equals).toBe(true);
    expect(edited.destination.welcomeJourneyId).toBe("");
  });

  it("keeps required nodes and preserves legacy default deduplication", () => {
    const legacy = { ...definition, oncePerSubscriber: undefined };
    expect(activeAutomationStages(legacy)).toContain("dedupe");
    expect(setAutomationStage(legacy, "trigger", false)).toBe(legacy);
    expect(setAutomationStage(legacy, "match", false)).toBe(legacy);
    expect(setAutomationStage(legacy, "dedupe", false).oncePerSubscriber).toBe(
      false,
    );
  });

  it("keeps layout bounded and retains positions when optional nodes are removed", () => {
    const full: AutomationDefinitionDraft = {
      ...definition,
      editorLayout: {
        nodePositions: Object.fromEntries(
          Array.from({ length: 100 }, (_item, index) => [
            `legacy${index}`,
            { x: index, y: index },
          ]),
        ),
      },
    };
    const moved = moveAutomationNode(full, "create", { x: 40, y: 60 });
    expect(Object.keys(moved.editorLayout?.nodePositions ?? {})).toHaveLength(
      100,
    );
    const restored = setAutomationStage(
      setAutomationStage(moved, "create", false),
      "create",
      true,
    );
    expect(
      automationGraph(restored).nodes.find((node) => node.id === "create")
        ?.position,
    ).toEqual({ x: 40, y: 60 });
  });
  it("retains intermediate operator edits but rejects incomplete operands against the saved schema", () => {
    const draft: AutomationDefinitionDraft = {
      ...definition,
      source: {
        ...definition.source,
        conditions: [
          {
            source: "traits",
            path: "score",
            operator: "greaterThan",
            value: "3",
          },
        ],
      },
    };
    expect(automationGraph(draft).nodes.map((node) => node.id)).toContain(
      "conditions",
    );
    expect(validateAutomationDefinition(draft).isErr()).toBe(true);
    const complete: AutomationDefinitionDraft = {
      ...draft,
      source: {
        ...draft.source,
        conditions: [
          {
            source: "traits",
            path: "score",
            operator: "greaterThan",
            value: 3,
          },
        ],
      },
    };
    const validated = validateAutomationDefinition(complete);
    expect(validated.isOk()).toBe(true);
    if (validated.isOk()) {
      expect(validated.value.source.conditions).toEqual(
        complete.source.conditions,
      );
    }
  });
  it("retains measured dimensions when canonical node data and saved positions change", () => {
    const current: Node[] = [
      {
        id: "conditions",
        position: { x: 0, y: 140 },
        data: { summary: "All · 1 condition" },
        measured: { width: 250, height: 70 },
        width: 250,
        height: 70,
      },
    ];
    const canonical: Node[] = [
      {
        id: "conditions",
        position: { x: 320, y: 240 },
        data: { summary: "Any · 2 conditions" },
        selected: true,
      },
    ];
    const reconciled = reconcileAutomationNodes(current, canonical);
    expect(reconciled).toEqual([
      {
        ...canonical[0],
        measured: { width: 250, height: 70 },
        width: 250,
        height: 70,
      },
    ]);
    expect(current[0]?.position).toEqual({ x: 0, y: 140 });
  });

  it("preserves an in-progress drag while reconciling additions and removals", () => {
    const current: Node[] = [
      {
        id: "conditions",
        position: { x: 320, y: 240 },
        dragging: true,
        measured: { width: 250, height: 70 },
        data: {},
      },
      { id: "create", position: { x: 0, y: 280 }, data: {} },
    ];
    const canonical: Node[] = [
      {
        id: "conditions",
        position: { x: 0, y: 140 },
        data: { summary: "Updated" },
      },
      { id: "welcome", position: { x: 0, y: 420 }, data: {} },
    ];
    const reconciled = reconcileAutomationNodes(current, canonical);
    expect(reconciled.map((node) => node.id)).toEqual([
      "conditions",
      "welcome",
    ]);
    expect(reconciled[0]?.position).toEqual({ x: 320, y: 240 });
    expect(reconciled[0]?.measured).toEqual({ width: 250, height: 70 });
    expect(reconciled[0]?.data).toEqual({ summary: "Updated" });
    expect(reconciled[1]).toEqual(canonical[1]);
  });
});

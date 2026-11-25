import {
  AddOutlined,
  BoltOutlined,
  CallSplitOutlined,
  CheckCircleOutline,
  ContentCopyOutlined,
  DeleteOutline,
  FingerprintOutlined,
  MailOutlineOutlined,
  PersonAddOutlined,
  PersonSearchOutlined,
  PlaylistAddCheckOutlined,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  Handle,
  Node,
  NodeProps,
  Position,
  ReactFlowProvider,
  useNodesState,
} from "@xyflow/react";
import {
  PublicationAutomationCondition,
  PublicationAutomationConditionOperator,
  PublicationAutomationConditionOperatorLabels,
  PublicationAutomationDefinition,
} from "isomorphic-lib/src/publications";
import { schemaValidate } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { InternalEventType } from "isomorphic-lib/src/types";
import { useEffect, useRef, useState } from "react";

import FlowCanvas from "../journeys/flowCanvas";
import { Option } from "../publications/settingsShared";
import {
  activeAutomationStages,
  AutomationConditionDraft,
  AutomationDefinitionDraft,
  AutomationFlowEdge,
  automationGraph,
  AutomationStage,
  automationStageLabels,
  automationStages,
  moveAutomationNode,
  reconcileAutomationNodes,
  setAutomationStage,
  validateAutomationDefinition,
} from "./automationFlow";

export interface AutomationRule {
  id: string;
  name: string;
  sourceNewsletterId: string;
  destinationNewsletterId: string;
  enabled: boolean;
  definition: PublicationAutomationDefinition;
}

export interface WelcomeJourneyOption {
  id: string;
  name: string;
  newsletterId: string;
}

type Definition = AutomationDefinitionDraft;
type Condition = AutomationConditionDraft;
const eventTypes: readonly (
  | "identify"
  | "track"
  | "page"
  | "screen"
  | "group"
)[] = ["identify", "track", "page", "screen", "group"];
const stageIcons = {
  trigger: BoltOutlined,
  conditions: CallSplitOutlined,
  dedupe: FingerprintOutlined,
  consent: CheckCircleOutline,
  match: PersonSearchOutlined,
  create: PersonAddOutlined,
  mappings: ContentCopyOutlined,
  subscribe: PlaylistAddCheckOutlined,
  welcome: MailOutlineOutlined,
};
const nativeEventLabels: Partial<Record<InternalEventType, string>> = {
  [InternalEventType.EmailOpened]: "Observed email open",
  [InternalEventType.EmailClicked]: "Observed email click",
  [InternalEventType.EmailDelivered]: "Email delivered",
  [InternalEventType.EmailBounced]: "Email bounced",
  [InternalEventType.EmailDropped]: "Email dropped",
  [InternalEventType.EmailProcessed]: "Email processed",
  [InternalEventType.EmailMarkedSpam]: "Email marked as spam",
  [InternalEventType.SubscriptionChange]: "Subscription changed",
};
type FlowNode = Node<
  { stage: AutomationStage; summary: string; first: boolean; last: boolean },
  "automation"
>;

function AutomationNode({ data, selected }: NodeProps<FlowNode>) {
  const Icon = stageIcons[data.stage];
  return (
    <Paper
      variant="outlined"
      sx={{
        width: 250,
        borderRadius: 1,
        borderColor: selected ? "text.primary" : "divider",
        borderWidth: selected ? 2 : 1,
        boxShadow: "0 4px 12px rgba(0,0,0,.08)",
        overflow: "hidden",
      }}
    >
      {!data.first && (
        <Handle type="target" position={Position.Top} isConnectable={false} />
      )}
      <Stack direction="row" spacing={1.2} sx={{ p: 1.5 }} alignItems="center">
        <Icon sx={{ color: "text.secondary" }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">
            {automationStageLabels[data.stage]}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {data.summary}
          </Typography>
        </Box>
      </Stack>
      {!data.last && (
        <Handle
          type="source"
          position={Position.Bottom}
          isConnectable={false}
        />
      )}
    </Paper>
  );
}
const nodeTypes = { automation: AutomationNode };

function AutomationFlowCanvas({
  nodes: canonicalNodes,
  edges,
  busy,
  onSelect,
  onMove,
}: {
  nodes: FlowNode[];
  edges: AutomationFlowEdge[];
  busy: boolean;
  onSelect: (stage: AutomationStage) => void;
  onMove: (stage: AutomationStage, position: { x: number; y: number }) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(canonicalNodes);

  useEffect(() => {
    setNodes((current) => reconcileAutomationNodes(current, canonicalNodes));
  }, [canonicalNodes, setNodes]);

  return (
    <FlowCanvas<FlowNode, AutomationFlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      maxZoom={1.5}
      nodesDraggable={!busy}
      edgesFocusable={false}
      edgesReconnectable={false}
      onNodeClick={(_event, node) => onSelect(node.data.stage)}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_event, node) => onMove(node.data.stage, node.position)}
    />
  );
}

function SourceField({
  value,
  onChange,
  label = "Read from",
}: {
  value: "traits" | "event";
  onChange: (value: "traits" | "event") => void;
  label?: string;
}) {
  return (
    <TextField
      select
      size="small"
      label={label}
      value={value}
      fullWidth
      onChange={(event) => {
        const next = event.target.value;
        if (next === "traits" || next === "event") onChange(next);
      }}
    >
      <MenuItem value="traits">Subscriber fields</MenuItem>
      <MenuItem value="event">Event fields</MenuItem>
    </TextField>
  );
}

function ConditionValue({
  condition,
  draft,
  onChange,
  onDraftChange,
}: {
  condition: Condition;
  draft: string | undefined;
  onChange: (value: unknown) => void;
  onDraftChange: (value: string | undefined) => void;
}) {
  const typed = typeof condition.value !== "string";
  let value = draft;
  if (value === undefined) {
    value = String(condition.value);
    if (typed) value = JSON.stringify(condition.value) ?? "";
  }
  return (
    <Stack spacing={1}>
      <TextField
        select
        size="small"
        label="Value type"
        value={typed ? "json" : "text"}
        onChange={(event) => {
          onDraftChange(undefined);
          onChange(event.target.value === "json" ? true : "");
        }}
      >
        <MenuItem value="text">Text</MenuItem>
        <MenuItem value="json">Typed value (JSON)</MenuItem>
      </TextField>
      <TextField
        size="small"
        label={typed ? "Value (JSON)" : "Value"}
        value={value}
        required={typed}
        error={draft !== undefined}
        helperText={
          draft !== undefined ? "Enter a valid JSON value" : undefined
        }
        onChange={(event) => {
          if (!typed) {
            onChange(event.target.value);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(event.target.value);
            onChange(parsed);
            onDraftChange(undefined);
          } catch {
            onDraftChange(event.target.value);
          }
        }}
        fullWidth
      />
    </Stack>
  );
}

export default function AutomationBuilder({
  rule,
  newsletters,
  welcomeJourneys,
  optionsLoading,
  optionsError,
  busy,
  error,
  onSave,
  onCancel,
}: {
  rule: AutomationRule | null;
  newsletters: Option[];
  welcomeJourneys: WelcomeJourneyOption[];
  optionsLoading: boolean;
  optionsError: string | null;
  busy: boolean;
  error: string | null;
  onSave: (
    value: Omit<AutomationRule, "id"> & { id?: string },
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [sourceId, setSourceId] = useState(
    rule?.sourceNewsletterId ?? newsletters[0]?.value ?? "",
  );
  const [destinationId, setDestinationId] = useState(
    rule?.destinationNewsletterId ?? newsletters[1]?.value ?? "",
  );
  const [definition, setDefinition] = useState<Definition>(
    () =>
      rule?.definition ?? {
        source: { eventType: "track" },
        destination: {
          match: { field: "email", source: "traits", path: "email" },
          createIfMissing: true,
          subscribe: true,
        },
        oncePerSubscriber: true,
      },
  );
  const [selected, setSelected] = useState<AutomationStage>("trigger");
  const conditions = definition.source.conditions ?? [];
  const mappings = definition.destination.fieldMappings ?? [];
  const nextKey = useRef(conditions.length + mappings.length);
  const [conditionKeys, setConditionKeys] = useState(() =>
    conditions.map((_item, index) => index),
  );
  const [mappingKeys, setMappingKeys] = useState(() =>
    mappings.map((_item, index) => conditions.length + index),
  );
  const [conditionDrafts, setConditionDrafts] = useState<
    Record<number, string>
  >({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const source = (patch: Partial<Definition["source"]>) =>
    setDefinition((current) => ({
      ...current,
      source: { ...current.source, ...patch },
    }));
  const destination = (patch: Partial<Definition["destination"]>) =>
    setDefinition((current) => ({
      ...current,
      destination: { ...current.destination, ...patch },
    }));
  const updateConsent = (patch: Partial<NonNullable<Definition["consent"]>>) =>
    setDefinition((current) =>
      current.consent
        ? { ...current, consent: { ...current.consent, ...patch } }
        : current,
    );
  const updateCondition = (index: number, patch: Partial<Condition>) =>
    source({
      conditions: conditions.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  const updateMapping = (
    index: number,
    patch: Partial<(typeof mappings)[number]>,
  ) =>
    destination({
      fieldMappings: mappings.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  const eligibleJourneys = welcomeJourneys.filter(
    (journey) => journey.newsletterId === destinationId,
  );
  const hasAction =
    definition.destination.createIfMissing ||
    definition.destination.subscribe ||
    Boolean(definition.destination.welcomeJourneyId) ||
    mappings.length > 0;
  const stages = activeAutomationStages(definition);
  const graph = automationGraph(definition);
  const summary: Record<AutomationStage, string> = {
    trigger: definition.source.event ?? definition.source.eventType,
    conditions: `${definition.source.conditionMatch === "any" ? "Any" : "All"} · ${conditions.length} conditions`,
    dedupe: "Once per source subscriber",
    consent: definition.consent?.authorization || "Configure consent",
    match:
      newsletters.find((item) => item.value === destinationId)?.label ??
      "Unavailable newsletter",
    create: "Create if missing",
    mappings: `${mappings.length} field mappings`,
    subscribe:
      newsletters.find((item) => item.value === destinationId)?.label ??
      "Unavailable newsletter",
    welcome:
      welcomeJourneys.find(
        (item) => item.id === definition.destination.welcomeJourneyId,
      )?.name ?? "Select journey",
  };
  const nodes: FlowNode[] = graph.nodes.map((node, index) => ({
    ...node,
    type: "automation",
    selected: selected === node.id,
    data: {
      stage: node.id,
      summary: summary[node.id],
      first: index === 0,
      last: index === graph.nodes.length - 1,
    },
  }));
  const addStage = (stage: AutomationStage) => {
    if (
      (stage === "conditions" && !conditions.length) ||
      (stage === "mappings" && !mappings.length)
    ) {
      const key = nextKey.current;
      nextKey.current += 1;
      if (stage === "conditions") setConditionKeys([key]);
      else setMappingKeys([key]);
    }
    setDefinition((current) => setAutomationStage(current, stage, true));
    setSelected(stage);
  };
  const removeStage = () => {
    setDefinition((current) => setAutomationStage(current, selected, false));
    setSelected("trigger");
  };
  let saveLabel = rule ? "Save automation" : "Create paused automation";
  if (rule?.enabled) saveLabel = "Save enabled automation";
  if (busy) saveLabel = "Saving…";
  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !hasAction || sourceId === destinationId) return;
        const invalidCondition = conditions.some((condition, index) => {
          const key = conditionKeys[index];
          const pendingJson =
            key !== undefined &&
            conditionDrafts[key] !== undefined &&
            condition.operator !== "exists" &&
            condition.operator !== "notExists";
          return (
            pendingJson ||
            schemaValidate(condition, PublicationAutomationCondition).isErr()
          );
        });
        if (invalidCondition) {
          setSelected("conditions");
          setValidationError("Complete the selected condition.");
          return;
        }
        const validated = validateAutomationDefinition(definition);
        if (validated.isErr()) {
          let incomplete: AutomationStage = "trigger";
          for (const issue of validated.error) {
            if (issue.path.startsWith("/destination/match"))
              incomplete = "match";
            else if (issue.path.startsWith("/destination/fieldMappings"))
              incomplete = "mappings";
            else if (issue.path.startsWith("/destination/welcomeJourneyId"))
              incomplete = "welcome";
            else if (issue.path.startsWith("/consent")) incomplete = "consent";
          }
          setSelected(incomplete);
          setValidationError("Complete the selected node.");
          return;
        }
        setValidationError(null);
        void onSave({
          ...(rule ? { id: rule.id } : {}),
          name,
          sourceNewsletterId: sourceId,
          destinationNewsletterId: destinationId,
          enabled: rule?.enabled ?? false,
          definition: validated.value,
        });
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            label="Name"
            value={name}
            required
            inputProps={{ maxLength: 256 }}
            onChange={(event) => setName(event.target.value)}
            sx={{ flex: 1 }}
          />
          <Chip
            size="small"
            variant="outlined"
            label={rule?.enabled ? "Enabled" : "Paused"}
          />
          <Button color="inherit" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={
              busy ||
              !hasAction ||
              sourceId === destinationId ||
              !newsletters.length
            }
          >
            {saveLabel}
          </Button>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {validationError && <Alert severity="error">{validationError}</Alert>}
        {!hasAction && (
          <Alert severity="error">
            Choose at least one destination action.
          </Alert>
        )}
        {sourceId === destinationId && (
          <Alert severity="error">Choose two different newsletters.</Alert>
        )}
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              lg: "170px minmax(300px, 1fr) 330px",
            },
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            overflow: "hidden",
            minWidth: 0,
          }}
        >
          <Stack
            spacing={0.5}
            sx={{
              p: 1.5,
              borderRight: { lg: 1 },
              borderColor: "divider",
              bgcolor: "background.paper",
            }}
          >
            <Typography variant="h5" sx={{ mb: 1 }}>
              Nodes
            </Typography>
            {automationStages.map((stage) => {
              const Icon = stageIcons[stage];
              const active = stages.includes(stage);
              return (
                <Button
                  key={stage}
                  color="inherit"
                  size="small"
                  startIcon={<Icon />}
                  sx={{ justifyContent: "flex-start", textAlign: "left" }}
                  onClick={() =>
                    active ? setSelected(stage) : addStage(stage)
                  }
                >
                  {automationStageLabels[stage]}
                  {!active && <AddOutlined sx={{ ml: "auto", fontSize: 16 }} />}
                </Button>
              );
            })}
          </Stack>
          <Box
            sx={{
              height: { xs: 500, lg: "min(72vh, 850px)" },
              minHeight: 500,
              minWidth: 0,
            }}
          >
            <ReactFlowProvider>
              <AutomationFlowCanvas
                nodes={nodes}
                edges={graph.edges}
                busy={busy}
                onSelect={setSelected}
                onMove={(stage, position) =>
                  setDefinition((current) =>
                    moveAutomationNode(current, stage, position),
                  )
                }
              />
            </ReactFlowProvider>
          </Box>
          <Stack
            spacing={1.5}
            sx={{
              p: 2,
              borderLeft: { lg: 1 },
              borderColor: "divider",
              bgcolor: "background.paper",
              maxHeight: { lg: "min(72vh, 850px)" },
              overflowY: "auto",
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
            >
              <Typography variant="h4">
                {automationStageLabels[selected]}
              </Typography>
              {selected !== "trigger" && selected !== "match" && (
                <IconButton
                  aria-label={`Remove ${automationStageLabels[selected]}`}
                  onClick={removeStage}
                  disabled={busy}
                >
                  <DeleteOutline />
                </IconButton>
              )}
            </Stack>
            {selected === "trigger" && (
              <>
                <TextField
                  select
                  size="small"
                  label="Source newsletter"
                  value={sourceId}
                  required
                  onChange={(event) => setSourceId(event.target.value)}
                >
                  {newsletters.map((item) => (
                    <MenuItem key={item.value} value={item.value}>
                      {item.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  size="small"
                  label="Event type"
                  value={definition.source.eventType}
                  onChange={(event) => {
                    const next = eventTypes.find(
                      (type) => type === event.target.value,
                    );
                    if (next) source({ eventType: next, event: undefined });
                  }}
                >
                  {eventTypes.map((type) => (
                    <MenuItem key={type} value={type}>
                      {type}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  size="small"
                  label="Event preset"
                  value={
                    definition.source.eventType === "track" &&
                    Object.keys(nativeEventLabels).some(
                      (value) => value === definition.source.event,
                    )
                      ? definition.source.event
                      : ""
                  }
                  onChange={(event) =>
                    source({
                      eventType: "track",
                      event: event.target.value || undefined,
                    })
                  }
                >
                  <MenuItem value="">Custom event</MenuItem>
                  {Object.entries(nativeEventLabels).map(([value, label]) => (
                    <MenuItem key={value} value={value}>
                      {label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  size="small"
                  label="Event name (optional)"
                  value={definition.source.event ?? ""}
                  onChange={(event) =>
                    source({ event: event.target.value || undefined })
                  }
                  inputProps={{ maxLength: 256 }}
                />
                <FormControlLabel
                  label="Match a link"
                  control={
                    <Checkbox
                      checked={Boolean(definition.source.link)}
                      onChange={(_event, checked) =>
                        source({
                          link: checked
                            ? { path: "properties.url", equals: "" }
                            : undefined,
                        })
                      }
                    />
                  }
                />
                {definition.source.link && (
                  <>
                    <TextField
                      size="small"
                      label="Event link field"
                      value={definition.source.link.path}
                      required
                      onChange={(event) => {
                        const { link } = definition.source;
                        if (link)
                          source({
                            link: { ...link, path: event.target.value },
                          });
                      }}
                    />
                    <TextField
                      size="small"
                      label="Exact URL"
                      value={definition.source.link.equals}
                      required
                      onChange={(event) => {
                        const { link } = definition.source;
                        if (link)
                          source({
                            link: { ...link, equals: event.target.value },
                          });
                      }}
                    />
                  </>
                )}
              </>
            )}
            {selected === "conditions" && (
              <>
                <TextField
                  select
                  size="small"
                  label="Match"
                  value={definition.source.conditionMatch ?? "all"}
                  onChange={(event) =>
                    source({
                      conditionMatch:
                        event.target.value === "any" ? "any" : "all",
                    })
                  }
                >
                  <MenuItem value="all">All conditions</MenuItem>
                  <MenuItem value="any">Any condition</MenuItem>
                </TextField>
                {conditions.map((condition, index) => {
                  const key = conditionKeys[index];
                  const draft =
                    key === undefined ? undefined : conditionDrafts[key];
                  return (
                    <Stack
                      key={key}
                      spacing={1}
                      sx={{ borderTop: 1, borderColor: "divider", pt: 1.5 }}
                    >
                      <Stack
                        direction="row"
                        alignItems="center"
                        justifyContent="space-between"
                      >
                        <Typography variant="h5">
                          Condition {index + 1}
                        </Typography>
                        <IconButton
                          aria-label={`Remove condition ${index + 1}`}
                          onClick={() => {
                            setConditionKeys((keys) =>
                              keys.filter(
                                (_key, position) => position !== index,
                              ),
                            );
                            source({
                              conditions: conditions.filter(
                                (_item, position) => position !== index,
                              ),
                            });
                            if (conditions.length === 1) setSelected("trigger");
                          }}
                        >
                          <DeleteOutline />
                        </IconButton>
                      </Stack>
                      <SourceField
                        value={condition.source}
                        onChange={(value) =>
                          updateCondition(index, { source: value })
                        }
                      />
                      <TextField
                        size="small"
                        label="Field path"
                        value={condition.path}
                        required
                        onChange={(event) =>
                          updateCondition(index, { path: event.target.value })
                        }
                      />
                      <TextField
                        select
                        size="small"
                        label="Operator"
                        value={condition.operator}
                        onChange={(event) => {
                          const operator = schemaValidate(
                            event.target.value,
                            PublicationAutomationConditionOperator,
                          );
                          if (operator.isOk())
                            updateCondition(index, {
                              operator: operator.value,
                            });
                        }}
                      >
                        {Object.entries(
                          PublicationAutomationConditionOperatorLabels,
                        ).map(([value, label]) => (
                          <MenuItem key={value} value={value}>
                            {label}
                          </MenuItem>
                        ))}
                      </TextField>
                      {condition.operator !== "exists" &&
                        condition.operator !== "notExists" && (
                          <ConditionValue
                            condition={condition}
                            draft={draft}
                            onChange={(value) =>
                              updateCondition(index, { value })
                            }
                            onDraftChange={(value) => {
                              if (key === undefined) return;
                              setConditionDrafts((current) => {
                                const next = { ...current };
                                if (value === undefined) delete next[key];
                                else next[key] = value;
                                return next;
                              });
                            }}
                          />
                        )}
                    </Stack>
                  );
                })}
                <Button
                  color="inherit"
                  startIcon={<AddOutlined />}
                  disabled={conditions.length >= 32}
                  onClick={() => {
                    const key = nextKey.current;
                    nextKey.current += 1;
                    setConditionKeys((keys) => [...keys, key]);
                    source({
                      conditions: [
                        ...conditions,
                        {
                          source: "traits",
                          path: "",
                          operator: "equals",
                          value: "",
                        },
                      ],
                    });
                  }}
                >
                  Add condition
                </Button>
              </>
            )}
            {selected === "match" && (
              <>
                <TextField
                  select
                  size="small"
                  label="Destination newsletter"
                  value={destinationId}
                  required
                  onChange={(event) => {
                    setDestinationId(event.target.value);
                    destination({ welcomeJourneyId: undefined });
                  }}
                >
                  {newsletters
                    .filter((item) => item.value !== sourceId)
                    .map((item) => (
                      <MenuItem key={item.value} value={item.value}>
                        {item.label}
                      </MenuItem>
                    ))}
                </TextField>
                <SourceField
                  label="Match email from"
                  value={definition.destination.match.source}
                  onChange={(value) =>
                    destination({
                      match: { ...definition.destination.match, source: value },
                    })
                  }
                />
                <TextField
                  size="small"
                  label="Email field path"
                  value={definition.destination.match.path}
                  required
                  onChange={(event) =>
                    destination({
                      match: {
                        ...definition.destination.match,
                        path: event.target.value,
                      },
                    })
                  }
                />
              </>
            )}
            {(selected === "create" || selected === "subscribe") && (
              <TextField
                size="small"
                label="Newsletter"
                value={
                  newsletters.find((item) => item.value === destinationId)
                    ?.label ?? "Unavailable"
                }
                InputProps={{ readOnly: true }}
              />
            )}
            {selected === "dedupe" && (
              <TextField
                size="small"
                label="Scope"
                value="Source subscriber"
                InputProps={{ readOnly: true }}
              />
            )}
            {selected === "mappings" && (
              <>
                {mappings.map((mapping, index) => (
                  <Stack
                    key={mappingKeys[index]}
                    spacing={1}
                    sx={{ borderTop: 1, borderColor: "divider", pt: 1 }}
                  >
                    <Stack
                      direction="row"
                      alignItems="center"
                      justifyContent="space-between"
                    >
                      <Typography variant="h5">Mapping {index + 1}</Typography>
                      <IconButton
                        aria-label={`Remove mapping ${index + 1}`}
                        onClick={() => {
                          setMappingKeys((keys) =>
                            keys.filter((_key, position) => position !== index),
                          );
                          destination({
                            fieldMappings: mappings.filter(
                              (_item, position) => position !== index,
                            ),
                          });
                          if (mappings.length === 1) setSelected("trigger");
                        }}
                      >
                        <DeleteOutline />
                      </IconButton>
                    </Stack>
                    <SourceField
                      value={mapping.source}
                      onChange={(value) =>
                        updateMapping(index, { source: value })
                      }
                    />
                    <TextField
                      size="small"
                      label="Source field path"
                      value={mapping.path}
                      required
                      onChange={(event) =>
                        updateMapping(index, { path: event.target.value })
                      }
                    />
                    <TextField
                      size="small"
                      label="Destination field"
                      value={mapping.destination}
                      required
                      onChange={(event) =>
                        updateMapping(index, {
                          destination: event.target.value,
                        })
                      }
                    />
                    <FormControlLabel
                      label="Overwrite existing value"
                      control={
                        <Checkbox
                          checked={mapping.overwrite === true}
                          onChange={(_event, checked) =>
                            updateMapping(index, { overwrite: checked })
                          }
                        />
                      }
                    />
                  </Stack>
                ))}
                <Button
                  color="inherit"
                  startIcon={<AddOutlined />}
                  disabled={mappings.length >= 64}
                  onClick={() => {
                    const key = nextKey.current;
                    nextKey.current += 1;
                    setMappingKeys((keys) => [...keys, key]);
                    destination({
                      fieldMappings: [
                        ...mappings,
                        {
                          source: "traits",
                          path: "",
                          destination: "",
                          overwrite: false,
                        },
                      ],
                    });
                  }}
                >
                  Add field mapping
                </Button>
              </>
            )}
            {selected === "welcome" && (
              <>
                {optionsError && <Alert severity="error">{optionsError}</Alert>}
                <TextField
                  select
                  size="small"
                  label="Welcome journey"
                  value={definition.destination.welcomeJourneyId ?? ""}
                  required
                  disabled={optionsLoading}
                  onChange={(event) =>
                    destination({ welcomeJourneyId: event.target.value })
                  }
                >
                  <MenuItem value="" disabled>
                    Select journey
                  </MenuItem>
                  {definition.destination.welcomeJourneyId &&
                    !eligibleJourneys.some(
                      (journey) =>
                        journey.id === definition.destination.welcomeJourneyId,
                    ) && (
                      <MenuItem value={definition.destination.welcomeJourneyId}>
                        Unavailable welcome journey
                      </MenuItem>
                    )}
                  {eligibleJourneys.map((journey) => (
                    <MenuItem key={journey.id} value={journey.id}>
                      {journey.name}
                    </MenuItem>
                  ))}
                </TextField>
              </>
            )}
            {selected === "consent" && definition.consent && (
              <>
                <TextField
                  size="small"
                  label="Event consent field (equals true)"
                  value={definition.consent.path}
                  required
                  onChange={(event) =>
                    updateConsent({ path: event.target.value })
                  }
                />
                <TextField
                  size="small"
                  label="Consent provenance"
                  value={definition.consent.authorization}
                  required
                  inputProps={{ maxLength: 2048 }}
                  onChange={(event) =>
                    updateConsent({ authorization: event.target.value })
                  }
                />
                <FormControlLabel
                  label="Allow re-subscription with this explicit consent"
                  control={
                    <Checkbox
                      checked={definition.consent.allowResubscribe}
                      onChange={(_event, checked) =>
                        updateConsent({ allowResubscribe: checked })
                      }
                    />
                  }
                />
              </>
            )}
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}

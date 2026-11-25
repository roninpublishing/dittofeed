import {
  AddOutlined,
  ArrowDownwardOutlined,
  DeleteOutline,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { PublicationAutomationDefinition } from "isomorphic-lib/src/publications";
import { ReactNode, useRef, useState } from "react";

import { Option } from "../publications/settingsShared";

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

/**
 * Supported adapters mirror PublicationAutomationDefinition, not native journey nodes:
 * native identify/track/page/screen/group events -> cross-newsletter contact coordination.
 * Triggers support an exact event/link and AND-combined exists/typed-equals conditions.
 * Mapping sources are native event dot paths or source subscriber traits; existing
 * destination values are preserved unless overwrite is explicitly enabled.
 * The action adapter matches email, maps traits, creates/subscribes contacts and can enter
 * an existing native welcome journey. Temporal owns execution. Infrastructure adapters
 * (including daily caps and warm-up) are future work and are intentionally not selectable.
 */
const eventTypes = ["identify", "track", "page", "screen", "group"] as const;
type Definition = PublicationAutomationDefinition;
type Condition = NonNullable<Definition["source"]["conditions"]>[number];

function FlowCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Typography variant="h4" sx={{ mb: 2 }}>
        {title}
      </Typography>
      <Stack spacing={2}>{children}</Stack>
    </Paper>
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
      onChange={(event) => {
        const next = event.target.value;
        if (next === "traits" || next === "event") onChange(next);
      }}
      sx={{ minWidth: 150 }}
    >
      <MenuItem value="traits">Subscriber fields</MenuItem>
      <MenuItem value="event">Event fields</MenuItem>
    </TextField>
  );
}

function ConditionValue({
  condition,
  onChange,
}: {
  condition: Condition;
  onChange: (value: unknown) => void;
}) {
  const [typed, setTyped] = useState(typeof condition.value !== "string");
  const [value, setValue] = useState(() =>
    typeof condition.value === "string"
      ? condition.value
      : JSON.stringify(condition.value),
  );
  const [invalid, setInvalid] = useState(false);
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
      <TextField
        select
        size="small"
        label="Value type"
        value={typed ? "json" : "text"}
        onChange={(event) => {
          const nextTyped = event.target.value === "json";
          setTyped(nextTyped);
          setInvalid(false);
          setValue(nextTyped ? "true" : "");
          onChange(nextTyped ? true : "");
        }}
        sx={{ minWidth: 150 }}
      >
        <MenuItem value="text">Text</MenuItem>
        <MenuItem value="json">Typed value</MenuItem>
      </TextField>
      <TextField
        size="small"
        label={typed ? "Value (JSON)" : "Value"}
        value={value}
        required={typed}
        error={invalid}
        helperText={invalid ? "Enter a valid JSON value" : undefined}
        inputProps={{
          "aria-invalid": invalid,
          ...(invalid ? { pattern: "(?!)" } : {}),
        }}
        onChange={(event) => {
          setValue(event.target.value);
          if (!typed) {
            onChange(event.target.value);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(event.target.value);
            onChange(parsed);
            setInvalid(false);
          } catch {
            setInvalid(true);
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
  const conditions = definition.source.conditions ?? [];
  const mappings = definition.destination.fieldMappings ?? [];
  const { link } = definition.source;
  const nextKey = useRef(conditions.length + mappings.length);
  const [conditionKeys, setConditionKeys] = useState(() =>
    conditions.map((_condition, index) => index),
  );
  const [mappingKeys, setMappingKeys] = useState(() =>
    mappings.map((_mapping, index) => conditions.length + index),
  );
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
  const eligibleJourneys = welcomeJourneys.filter(
    (journey) => journey.newsletterId === destinationId,
  );
  const hasAction =
    definition.destination.createIfMissing ||
    definition.destination.subscribe ||
    Boolean(definition.destination.welcomeJourneyId) ||
    mappings.length > 0;
  let saveLabel = rule ? "Save automation" : "Create paused automation";
  if (rule?.enabled) saveLabel = "Save enabled automation";
  if (busy) saveLabel = "Saving…";
  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !hasAction || sourceId === destinationId) return;
        void onSave({
          ...(rule ? { id: rule.id } : {}),
          name,
          sourceNewsletterId: sourceId,
          destinationNewsletterId: destinationId,
          enabled: rule?.enabled ?? false,
          definition,
        });
      }}
    >
      <Stack spacing={1.5} sx={{ maxWidth: 900 }}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          spacing={2}
        >
          <Typography variant="h3">
            {rule ? "Edit automation" : "New automation"}
          </Typography>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          size="small"
          label="Name"
          value={name}
          required
          inputProps={{ maxLength: 256 }}
          onChange={(event) => setName(event.target.value)}
        />
        <FlowCard title="Trigger">
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
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField
              select
              size="small"
              label="Event type"
              value={definition.source.eventType}
              onChange={(event) => {
                const next = eventTypes.find(
                  (type) => type === event.target.value,
                );
                if (next) source({ eventType: next });
              }}
              sx={{ minWidth: 180 }}
            >
              {eventTypes.map((type) => (
                <MenuItem key={type} value={type}>
                  {type}
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
              fullWidth
              inputProps={{ maxLength: 256 }}
            />
          </Stack>
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
          {link && (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
              <TextField
                size="small"
                label="Event link field"
                value={link.path}
                required
                onChange={(event) =>
                  source({
                    link: {
                      ...link,
                      path: event.target.value,
                    },
                  })
                }
                fullWidth
              />
              <TextField
                size="small"
                label="Exact URL"
                value={link.equals}
                required
                onChange={(event) =>
                  source({
                    link: {
                      ...link,
                      equals: event.target.value,
                    },
                  })
                }
                fullWidth
              />
            </Stack>
          )}
        </FlowCard>
        <ArrowDownwardOutlined
          sx={{ alignSelf: "center", color: "text.secondary" }}
        />
        <FlowCard title="Conditions">
          {conditions.length === 0 && (
            <Typography color="text.secondary">All matching events</Typography>
          )}
          {conditions.map((condition, index) => (
            <Stack key={conditionKeys[index]} spacing={1}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
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
                  fullWidth
                />
                <TextField
                  select
                  size="small"
                  label="Match"
                  value={condition.operator}
                  onChange={(event) => {
                    const operator = event.target.value;
                    if (operator === "equals" || operator === "exists") {
                      updateCondition(index, { operator });
                    }
                  }}
                  sx={{ minWidth: 120 }}
                >
                  <MenuItem value="equals">Equals</MenuItem>
                  <MenuItem value="exists">Exists</MenuItem>
                </TextField>
                <IconButton
                  aria-label={`Remove condition ${index + 1}`}
                  onClick={() => {
                    setConditionKeys((keys) =>
                      keys.filter((_key, position) => position !== index),
                    );
                    source({
                      conditions: conditions.filter(
                        (_item, position) => position !== index,
                      ),
                    });
                  }}
                >
                  <DeleteOutline />
                </IconButton>
              </Stack>
              {condition.operator === "equals" && (
                <ConditionValue
                  condition={condition}
                  onChange={(value) => updateCondition(index, { value })}
                />
              )}
            </Stack>
          ))}
          <Button
            startIcon={<AddOutlined />}
            disabled={conditions.length >= 32}
            sx={{ alignSelf: "flex-start" }}
            onClick={() => {
              const key = nextKey.current;
              nextKey.current += 1;
              setConditionKeys((keys) => [...keys, key]);
              source({
                conditions: [
                  ...conditions,
                  { source: "traits", path: "", operator: "equals", value: "" },
                ],
              });
            }}
          >
            Add condition
          </Button>
        </FlowCard>
        <ArrowDownwardOutlined
          sx={{ alignSelf: "center", color: "text.secondary" }}
        />
        <FlowCard title="Action · Coordinate newsletter contacts">
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
          {sourceId === destinationId && (
            <Alert severity="error">Choose two different newsletters.</Alert>
          )}
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
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
              fullWidth
            />
          </Stack>
          <Stack>
            <FormControlLabel
              label="Create destination contact if missing"
              control={
                <Checkbox
                  checked={definition.destination.createIfMissing}
                  onChange={(_event, checked) =>
                    destination({ createIfMissing: checked })
                  }
                />
              }
            />
            <FormControlLabel
              label="Subscribe to destination newsletter"
              control={
                <Checkbox
                  checked={definition.destination.subscribe}
                  onChange={(_event, checked) =>
                    destination({ subscribe: checked })
                  }
                />
              }
            />
          </Stack>
          <Typography variant="h5">Field mappings</Typography>
          {mappings.map((mapping, index) => (
            <Stack key={mappingKeys[index]} spacing={0.5}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                <SourceField
                  value={mapping.source}
                  onChange={(value) =>
                    destination({
                      fieldMappings: mappings.map((item, position) =>
                        position === index ? { ...item, source: value } : item,
                      ),
                    })
                  }
                />
                <TextField
                  size="small"
                  label="Source field path"
                  value={mapping.path}
                  required
                  fullWidth
                  onChange={(event) =>
                    destination({
                      fieldMappings: mappings.map((item, position) =>
                        position === index
                          ? { ...item, path: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
                <TextField
                  size="small"
                  label="Destination field"
                  value={mapping.destination}
                  required
                  fullWidth
                  onChange={(event) =>
                    destination({
                      fieldMappings: mappings.map((item, position) =>
                        position === index
                          ? { ...item, destination: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
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
                  }}
                >
                  <DeleteOutline />
                </IconButton>
              </Stack>
              <FormControlLabel
                label="Overwrite existing value"
                control={
                  <Checkbox
                    checked={mapping.overwrite === true}
                    onChange={(_event, checked) =>
                      destination({
                        fieldMappings: mappings.map((item, position) =>
                          position === index
                            ? { ...item, overwrite: checked }
                            : item,
                        ),
                      })
                    }
                  />
                }
              />
            </Stack>
          ))}
          <Button
            startIcon={<AddOutlined />}
            disabled={mappings.length >= 64}
            sx={{ alignSelf: "flex-start" }}
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
          {optionsError && <Alert severity="error">{optionsError}</Alert>}
          <TextField
            select
            size="small"
            label="Welcome journey (optional)"
            value={definition.destination.welcomeJourneyId ?? ""}
            disabled={optionsLoading}
            onChange={(event) =>
              destination({ welcomeJourneyId: event.target.value || undefined })
            }
          >
            <MenuItem value="">None</MenuItem>
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
          <FormControlLabel
            label="Record explicit event consent"
            control={
              <Checkbox
                checked={Boolean(definition.consent)}
                onChange={(_event, checked) =>
                  setDefinition((current) => ({
                    ...current,
                    consent: checked
                      ? {
                          type: "explicit",
                          source: "event",
                          path: "properties.consent",
                          equals: true,
                          authorization: "",
                          allowResubscribe: false,
                        }
                      : undefined,
                  }))
                }
              />
            }
          />
          {definition.consent && (
            <>
              <TextField
                size="small"
                label="Event consent field (must equal true)"
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
          <FormControlLabel
            label="Run once per source subscriber"
            control={
              <Checkbox
                checked={definition.oncePerSubscriber !== false}
                onChange={(_event, checked) =>
                  setDefinition((current) => ({
                    ...current,
                    oncePerSubscriber: checked,
                  }))
                }
              />
            }
          />
          {!hasAction && (
            <Alert severity="error">
              Choose at least one destination action.
            </Alert>
          )}
        </FlowCard>
        <Button
          type="submit"
          variant="contained"
          disabled={
            busy ||
            !hasAction ||
            sourceId === destinationId ||
            !newsletters.length
          }
          sx={{ alignSelf: "flex-start" }}
        >
          {saveLabel}
        </Button>
      </Stack>
    </Box>
  );
}

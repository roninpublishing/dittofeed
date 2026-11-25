import { AddOutlined, ExpandMoreOutlined } from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { useEffect, useState } from "react";

import {
  errorText,
  Option,
  record,
  RecordValue,
  text,
} from "../publications/settingsShared";
import AutomationBuilder, {
  AutomationRule,
  WelcomeJourneyOption,
} from "./automationBuilder";

interface AutomationProps {
  workspaceId: string;
  apiBase: string;
  newsletters: Option[];
}

function timestamp(value: unknown) {
  const date = new Date(typeof value === "string" ? value : "");
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function ActionHistory({
  workspaceId,
  apiBase,
  rules,
  newsletters,
}: AutomationProps & { rules: AutomationRule[] }) {
  const [ruleId, setRuleId] = useState("");
  const [offset, setOffset] = useState(0);
  const actions = useQuery({
    queryKey: [
      "publication-management",
      apiBase,
      workspaceId,
      "actions",
      ruleId,
      offset,
    ],
    enabled: Boolean(workspaceId),
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{ data: RecordValue[] }>(
        `${apiBase}/api/publications/automations/actions`,
        {
          signal,
          params: {
            workspaceId,
            ...(ruleId ? { ruleId } : {}),
            offset,
            limit: 25,
          },
        },
      );
      return response.data.data;
    },
  });
  return (
    <Stack spacing={1.5}>
      <TextField
        select
        size="small"
        label="Automation"
        value={ruleId}
        sx={{ maxWidth: 360 }}
        onChange={(event) => {
          setRuleId(event.target.value);
          setOffset(0);
        }}
      >
        <MenuItem value="">All automations, including retired</MenuItem>
        {rules.map((rule) => (
          <MenuItem key={rule.id} value={rule.id}>
            {rule.name}
          </MenuItem>
        ))}
      </TextField>
      {actions.isPending && <CircularProgress size={20} />}
      {actions.isError && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" onClick={() => void actions.refetch()}>
              Retry
            </Button>
          }
        >
          {errorText(actions.error)}
        </Alert>
      )}
      {actions.data?.length === 0 && (
        <Typography color="text.secondary">No executions yet.</Typography>
      )}
      {actions.data?.map((action) => {
        const state = record(action.state);
        const authorization = record(state.authorization);
        const destination = record(record(state.ruleDefinition).destination);
        const ruleName =
          rules.find((rule) => rule.id === action.ruleId)?.name ??
          (typeof authorization.ruleName === "string"
            ? authorization.ruleName
            : "Retired automation");
        let dispositionColor: "success" | "error" | "default" = "default";
        if (action.disposition === "completed") dispositionColor = "success";
        if (action.disposition === "error") dispositionColor = "error";
        let contactLabel = "Contact pending";
        if (typeof action.destinationUserId === "string")
          contactLabel = "Matched contact";
        if (state.created === true) contactLabel = "Contact created";
        return (
          <Accordion
            key={text(action.id)}
            disableGutters
            variant="outlined"
            sx={{ "&:before": { display: "none" } }}
          >
            <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={1.5}
                justifyContent="space-between"
                sx={{ width: "100%", pr: 1, minWidth: 0 }}
              >
                <Typography fontWeight={600} sx={{ overflowWrap: "anywhere" }}>
                  {ruleName}
                </Typography>
                {state.syntheticDemo === true && (
                  <Chip size="small" variant="outlined" label="Synthetic" />
                )}
                <Typography variant="body2" color="text.secondary">
                  {timestamp(action.createdAt)}
                </Typography>
                <Chip
                  size="small"
                  label={text(action.disposition)}
                  color={dispositionColor}
                />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1.5}>
                {action.error ? (
                  <Alert
                    severity={
                      action.disposition === "error" ? "error" : "warning"
                    }
                  >
                    {text(action.error)}
                  </Alert>
                ) : null}
                <Stack direction={{ xs: "column", sm: "row" }} spacing={3}>
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Source
                    </Typography>
                    <Typography>
                      {newsletters.find(
                        (item) => item.value === state.sourceNewsletterId,
                      )?.label ?? "Unavailable newsletter"}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Destination
                    </Typography>
                    <Typography>
                      {newsletters.find(
                        (item) => item.value === state.destinationNewsletterId,
                      )?.label ?? "Unavailable newsletter"}
                    </Typography>
                  </Box>
                </Stack>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <Chip size="small" variant="outlined" label={contactLabel} />
                  <Chip
                    size="small"
                    variant="outlined"
                    label={
                      state.profileCompleted
                        ? "Fields applied"
                        : "Fields pending"
                    }
                  />
                  {destination.subscribe === true && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={
                        state.subscriptionCompleted
                          ? "Subscribed"
                          : "Subscription pending"
                      }
                    />
                  )}
                  {typeof destination.welcomeJourneyId === "string" && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={
                        state.journeyCompleted
                          ? "Welcome entered"
                          : "Welcome pending"
                      }
                    />
                  )}
                </Stack>
                <Box
                  component="dl"
                  sx={{
                    display: "grid",
                    gridTemplateColumns: {
                      xs: "1fr",
                      sm: "140px minmax(0, 1fr)",
                    },
                    gap: 0.75,
                    m: 0,
                    "& dd": { m: 0, overflowWrap: "anywhere" },
                    "& dt": { color: "text.secondary" },
                  }}
                >
                  <Typography component="dt" variant="body2">
                    Action ID
                  </Typography>
                  <Typography component="dd" variant="body2">
                    {text(action.id)}
                  </Typography>
                  <Typography component="dt" variant="body2">
                    Deduplication key
                  </Typography>
                  <Typography component="dd" variant="body2">
                    {text(action.dedupeKey)}
                  </Typography>
                  <Typography component="dt" variant="body2">
                    Rule version
                  </Typography>
                  <Typography component="dd" variant="body2">
                    {timestamp(authorization.ruleUpdatedAt)}
                  </Typography>
                  <Typography component="dt" variant="body2">
                    Source event
                  </Typography>
                  <Typography component="dd" variant="body2">
                    {text(action.sourceEventId)}
                  </Typography>
                  <Typography component="dt" variant="body2">
                    Source subscriber
                  </Typography>
                  <Typography component="dd" variant="body2">
                    {text(action.sourceUserId)}
                  </Typography>
                  <Typography component="dt" variant="body2">
                    Destination subscriber
                  </Typography>
                  <Typography component="dd" variant="body2">
                    {text(action.destinationUserId)}
                  </Typography>
                  <Typography component="dt" variant="body2">
                    Updated
                  </Typography>
                  <Typography component="dd" variant="body2">
                    {timestamp(action.updatedAt)}
                  </Typography>
                  {typeof state.workflowId === "string" && (
                    <>
                      <Typography component="dt" variant="body2">
                        Welcome workflow
                      </Typography>
                      <Typography component="dd" variant="body2">
                        {state.workflowId}
                      </Typography>
                    </>
                  )}
                </Box>
              </Stack>
            </AccordionDetails>
          </Accordion>
        );
      })}
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Button
          disabled={actions.isFetching || offset === 0}
          onClick={() => setOffset((current) => Math.max(0, current - 25))}
        >
          Previous
        </Button>
        <Typography variant="body2" color="text.secondary">
          Page {offset / 25 + 1}
        </Typography>
        <Button
          disabled={
            actions.isFetching ||
            !actions.data ||
            actions.data.length < 25 ||
            offset >= 10_000
          }
          onClick={() => setOffset((current) => current + 25)}
        >
          Next
        </Button>
      </Stack>
    </Stack>
  );
}

function AutomationEditor({
  workspaceId,
  apiBase,
  newsletters,
  rule,
  busy,
  error,
  onSave,
  onCancel,
}: AutomationProps & {
  rule: AutomationRule | null;
  busy: boolean;
  error: string | null;
  onSave: (
    value: Omit<AutomationRule, "id"> & { id?: string },
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const options = useQuery({
    queryKey: [
      "publication-management",
      apiBase,
      workspaceId,
      "automation-options",
    ],
    enabled: Boolean(workspaceId),
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{
        data: { welcomeJourneys: WelcomeJourneyOption[] };
      }>(`${apiBase}/api/publications/automations/options`, {
        signal,
        params: { workspaceId },
      });
      return response.data.data;
    },
  });
  return (
    <AutomationBuilder
      rule={rule}
      newsletters={newsletters}
      welcomeJourneys={options.data?.welcomeJourneys ?? []}
      optionsLoading={options.isPending}
      optionsError={
        options.isError ? "Welcome journeys could not be loaded." : null
      }
      busy={busy}
      error={error}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
}

export default function WorkspaceAutomations({
  workspaceId,
  apiBase,
  newsletters,
}: AutomationProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState(0);
  const [editor, setEditor] = useState<AutomationRule | null | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    rule: AutomationRule;
    operation: "enable" | "retire";
  } | null>(null);
  useEffect(() => {
    setEditor(undefined);
    setTab(0);
    setError(null);
    setConfirmation(null);
  }, [apiBase, workspaceId]);
  const rules = useQuery({
    queryKey: ["publication-management", apiBase, workspaceId, "automations"],
    enabled: Boolean(workspaceId),
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const response = await axios.get<{ data: AutomationRule[] }>(
        `${apiBase}/api/publications/automations`,
        { signal, params: { workspaceId } },
      );
      return response.data.data;
    },
  });
  const save = async (value: Omit<AutomationRule, "id"> & { id?: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await axios.put(`${apiBase}/api/publications/automations`, {
        workspaceId,
        ...value,
      });
      setEditor(undefined);
      setConfirmation(null);
      await queryClient.invalidateQueries({
        queryKey: ["publication-management", apiBase, workspaceId],
      });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const changeStatus = async (rule: AutomationRule, enabled: boolean) => {
    await save({
      id: rule.id,
      name: rule.name,
      sourceNewsletterId: rule.sourceNewsletterId,
      destinationNewsletterId: rule.destinationNewsletterId,
      definition: rule.definition,
      enabled,
    });
  };
  const retire = async (rule: AutomationRule) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await axios.delete(`${apiBase}/api/publications/automations`, {
        data: { workspaceId, id: rule.id },
      });
      setConfirmation(null);
      await queryClient.invalidateQueries({
        queryKey: ["publication-management", apiBase, workspaceId],
      });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  let confirmationMessage =
    "Matching events may update destination contacts and subscriptions.";
  if (confirmation?.rule.definition.destination.welcomeJourneyId) {
    confirmationMessage =
      "Matching events may update contacts, subscriptions and enter the selected welcome journey.";
  }
  if (confirmation?.operation === "retire") {
    confirmationMessage = "Stops new executions and retains action history.";
  }
  let confirmationLabel =
    confirmation?.operation === "enable" ? "Enable" : "Retire";
  if (busy) confirmationLabel = "Saving…";
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={2}
      >
        <Box>
          <Typography component="h1" variant="h2">
            Automations
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>
            Cross-newsletter contact coordination, separate from subscriber
            journeys.
          </Typography>
        </Box>
        {editor === undefined && tab === 0 && (
          <Button
            startIcon={<AddOutlined />}
            variant="contained"
            disabled={newsletters.length < 2 || busy}
            onClick={() => {
              setError(null);
              setEditor(null);
            }}
          >
            New automation
          </Button>
        )}
      </Stack>
      {editor !== undefined ? (
        <AutomationEditor
          key={`${workspaceId}:${editor?.id ?? "new"}`}
          workspaceId={workspaceId}
          apiBase={apiBase}
          newsletters={newsletters}
          rule={editor}
          busy={busy}
          error={error}
          onSave={save}
          onCancel={() => {
            setEditor(undefined);
            setError(null);
          }}
        />
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={(_event, value: number) => {
              setTab(value);
              setError(null);
            }}
          >
            <Tab label="Automations" />
            <Tab label="Execution history" />
          </Tabs>
          {error && !confirmation && <Alert severity="error">{error}</Alert>}
          {tab === 0 && (
            <>
              {rules.isPending && <CircularProgress size={20} />}
              {rules.isError && (
                <Alert
                  severity="error"
                  action={
                    <Button
                      color="inherit"
                      onClick={() => void rules.refetch()}
                    >
                      Retry
                    </Button>
                  }
                >
                  {errorText(rules.error)}
                </Alert>
              )}
              {rules.data?.length === 0 && (
                <Typography color="text.secondary">
                  No automations yet.
                </Typography>
              )}
              {Boolean(rules.data?.length) && (
                <TableContainer
                  component={Paper}
                  variant="outlined"
                  sx={{ borderRadius: 1 }}
                >
                  <Table size="small" aria-label="Workspace automations">
                    <TableHead>
                      <TableRow>
                        <TableCell>Name</TableCell>
                        <TableCell>Trigger</TableCell>
                        <TableCell>Destination</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rules.data?.map((rule) => (
                        <TableRow key={rule.id} hover>
                          <TableCell>
                            <Button
                              onClick={() => {
                                setError(null);
                                setEditor(rule);
                              }}
                              sx={{
                                p: 0,
                                minWidth: 0,
                                justifyContent: "flex-start",
                                textTransform: "none",
                              }}
                            >
                              {rule.name}
                            </Button>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2">
                              {newsletters.find(
                                (item) =>
                                  item.value === rule.sourceNewsletterId,
                              )?.label ?? "Unavailable newsletter"}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              {rule.definition.source.event ??
                                rule.definition.source.eventType}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            {newsletters.find(
                              (item) =>
                                item.value === rule.destinationNewsletterId,
                            )?.label ?? "Unavailable newsletter"}
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              variant="outlined"
                              color={rule.enabled ? "success" : "default"}
                              label={rule.enabled ? "Enabled" : "Paused"}
                            />
                          </TableCell>
                          <TableCell
                            align="right"
                            sx={{ whiteSpace: "nowrap" }}
                          >
                            <Button
                              disabled={busy}
                              onClick={() =>
                                rule.enabled
                                  ? void changeStatus(rule, false)
                                  : setConfirmation({
                                      rule,
                                      operation: "enable",
                                    })
                              }
                            >
                              {rule.enabled ? "Pause" : "Enable"}
                            </Button>
                            <Button
                              disabled={busy}
                              onClick={() => {
                                setError(null);
                                setConfirmation({ rule, operation: "retire" });
                              }}
                            >
                              Retire
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </>
          )}
          {tab === 1 && (
            <ActionHistory
              key={`${apiBase}:${workspaceId}`}
              workspaceId={workspaceId}
              apiBase={apiBase}
              newsletters={newsletters}
              rules={rules.data ?? []}
            />
          )}
        </>
      )}
      <Dialog
        open={Boolean(confirmation)}
        onClose={() => {
          if (!busy) {
            setConfirmation(null);
            setError(null);
          }
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          {confirmation?.operation === "enable"
            ? "Enable automation?"
            : "Retire automation?"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Typography fontWeight={600}>{confirmation?.rule.name}</Typography>
            <Typography>{confirmationMessage}</Typography>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirmation(null);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={busy}
            onClick={() => {
              if (!confirmation) return;
              if (confirmation.operation === "enable")
                void changeStatus(confirmation.rule, true);
              else void retire(confirmation.rule);
            }}
          >
            {confirmationLabel}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

import {
  AddOutlined,
  ArrowBackOutlined,
  ArrowForwardOutlined,
  ExpandMoreOutlined,
  MailOutline,
  SettingsOutlined,
} from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { CompletionStatus } from "isomorphic-lib/src/types";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppStorePick } from "../../lib/appStore";
import useWorkspaceSwitch from "../../lib/useWorkspaceSwitch";
import { useWorkspaceNavigation } from "../workspace/navigation";
import CreateNewsletterDialog from "./createNewsletterDialog";
import CreateWorkspaceForm from "./createWorkspaceForm";
import {
  errorText,
  Option,
  record,
  RecordValue,
  rows,
  text,
} from "./settingsShared";

interface Field {
  key: string;
  label: string;
  kind?:
    | "password"
    | "number"
    | "boolean"
    | "json"
    | "list"
    | "select"
    | "multiselect";
  required?: boolean;
  options?: Option[];
  initial?: string | boolean;
  hint?: string;
}

const suppressionReasons: Option[] = [
  { value: "manual", label: "Manual" },
  { value: "publisher_optout", label: "Workspace opt-out" },
  { value: "complaint", label: "Spam complaint" },
  { value: "invalid_mailbox", label: "Invalid address" },
];

function optionList(value: unknown, idKey: string, labelKey: string): Option[] {
  return rows(value).map((row) => ({
    value: text(row[idKey]),
    label: text(row[labelKey]),
  }));
}

function DataTable({
  data,
  columns,
}: {
  data: unknown;
  columns: [string, string][];
}) {
  const items = rows(data);
  if (!items.length)
    return <Typography color="text.secondary">No records.</Typography>;
  return (
    <Box sx={{ overflowX: "auto" }}>
      <Table
        size="small"
        sx={{ minWidth: Math.max(360, columns.length * 120) }}
      >
        <TableHead>
          <TableRow>
            {columns.map(([key, label]) => (
              <TableCell key={key}>{label}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {items.map((row, index) => (
            <TableRow
              key={text(row.id ?? row.workspaceId ?? row.compositeId ?? index)}
            >
              {columns.map(([key]) => (
                <TableCell
                  key={key}
                  sx={{ maxWidth: 420, overflowWrap: "anywhere" }}
                >
                  {text(row[key])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function ActionForm({
  title,
  description,
  path,
  method = "post",
  fields,
  workspaceId,
  apiBase,
  onComplete,
  buttonLabel,
  showDetails = false,
}: {
  title: string;
  description?: string;
  path: string;
  method?: "post" | "put" | "patch" | "delete";
  fields: Field[];
  workspaceId: string;
  apiBase: string;
  onComplete: () => Promise<void>;
  buttonLabel?: string;
  showDetails?: boolean;
}) {
  const [values, setValues] = useState<
    Record<string, string | boolean | string[]>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>();
  return (
    <Accordion
      disableGutters
      variant="outlined"
      sx={{ "&:before": { display: "none" } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
        <Typography fontWeight={600}>{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Box
          component="form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            setResult(undefined);
            try {
              const body: RecordValue = { workspaceId };
              for (const field of fields) {
                const value =
                  values[field.key] ??
                  field.initial ??
                  (field.kind === "boolean" ? false : "");
                if (
                  value === "" &&
                  !field.required &&
                  !(field.kind === "list" && field.key in values)
                )
                  continue;
                if (field.kind === "json") {
                  body[field.key] = JSON.parse(String(value));
                } else if (field.kind === "number") {
                  body[field.key] = Number(value);
                } else if (field.kind === "list") {
                  body[field.key] = String(value)
                    .split(/[,\n]/)
                    .map((item) => item.trim())
                    .filter(Boolean);
                } else {
                  body[field.key] = value;
                }
              }
              const response = await axios.request<{ data: unknown }>({
                url: `${apiBase}/api/publications${path}`,
                method,
                data: body,
              });
              setResult(response.data.data);
              setValues((current) =>
                Object.fromEntries(
                  Object.entries(current).filter(
                    ([key]) =>
                      !fields.some(
                        (field) =>
                          field.key === key && field.kind === "password",
                      ),
                  ),
                ),
              );
              await onComplete();
            } catch (failure) {
              setError(errorText(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Stack spacing={2}>
            {description && (
              <Typography color="text.secondary">{description}</Typography>
            )}
            {fields.map((field) => {
              if (field.kind === "boolean") {
                return (
                  <FormControlLabel
                    key={field.key}
                    label={field.label}
                    control={
                      <Switch
                        required={field.required}
                        checked={Boolean(
                          values[field.key] ?? field.initial ?? false,
                        )}
                        onChange={(event) =>
                          setValues({
                            ...values,
                            [field.key]: event.target.checked,
                          })
                        }
                      />
                    }
                  />
                );
              }
              let inputType = "text";
              if (field.kind === "password" || field.kind === "number") {
                inputType = field.kind;
              }
              return (
                <TextField
                  key={field.key}
                  label={field.label}
                  required={field.required}
                  helperText={
                    field.hint ??
                    (field.kind === "list"
                      ? "Separate entries with commas or new lines."
                      : undefined)
                  }
                  type={inputType}
                  autoComplete={
                    field.kind === "password" ? "new-password" : "off"
                  }
                  select={
                    field.kind === "select" || field.kind === "multiselect"
                  }
                  SelectProps={
                    field.kind === "multiselect"
                      ? { multiple: true }
                      : undefined
                  }
                  multiline={field.kind === "json" || field.kind === "list"}
                  minRows={field.kind === "json" ? 3 : undefined}
                  value={
                    values[field.key] ??
                    field.initial ??
                    (field.kind === "multiselect" ? [] : "")
                  }
                  onChange={(event) => {
                    let { value }: { value: string | string[] } = event.target;
                    if (
                      field.kind === "multiselect" &&
                      typeof value === "string"
                    ) {
                      value = value.split(",");
                    }
                    setValues({
                      ...values,
                      [field.key]: value,
                    });
                  }}
                >
                  {field.options?.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              );
            })}
            {error && <Alert severity="error">{error}</Alert>}
            {result !== undefined && <Alert severity="success">Done.</Alert>}
            <Button type="submit" variant="contained" disabled={busy}>
              {busy ? "Working…" : buttonLabel ?? title}
            </Button>
            {result !== undefined && showDetails && (
              <Box component="details">
                <Box component="summary">Details</Box>
                <Box
                  component="pre"
                  sx={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    maxHeight: 360,
                    overflow: "auto",
                  }}
                >
                  {JSON.stringify(result, null, 2)}
                </Box>
              </Box>
            )}
          </Stack>
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}

function HistoryPages({
  offset,
  count,
  busy,
  onPage,
}: {
  offset: number;
  count: number;
  busy: boolean;
  onPage: (offset: number) => void;
}) {
  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <Button
        disabled={busy || offset === 0}
        onClick={() => onPage(Math.max(0, offset - 25))}
      >
        Previous page
      </Button>
      <Typography color="text.secondary">
        Records {offset + (count ? 1 : 0)}–{offset + count}
      </Typography>
      <Button disabled={busy || count < 25} onClick={() => onPage(offset + 25)}>
        Next page
      </Button>
    </Stack>
  );
}

export default function PublicationManagement({
  publisherId,
  section = "newsletters",
}: {
  publisherId: string | null;
  section?: "newsletters" | "subscribers" | "reports" | "settings";
}) {
  const { workspace, apiBase } = useAppStorePick(["workspace", "apiBase"]);
  const { switchWorkspace, switchingWorkspace } = useWorkspaceSwitch();
  const router = useRouter();
  const workspaceNavigation = useWorkspaceNavigation();
  const queryClient = useQueryClient();
  const workspaceId =
    workspace.type === CompletionStatus.Successful ? workspace.value.id : "";
  const [tab, setTab] = useState(0);
  const [reportAccountId, setReportAccountId] = useState("");
  const [reportIpId, setReportIpId] = useState("");
  const [creating, setCreating] = useState(false);
  const [openingNewsletter, setOpeningNewsletter] = useState<string | null>(
    null,
  );
  const [historyData, setData] = useState<RecordValue>({});
  const [busy, setLoading] = useState(false);
  const [operationError, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<RecordValue>({});
  const [selectedContacts, setSelectedContacts] = useState<RecordValue[]>([]);
  const [operationConsent, setOperationConsent] = useState("");
  const [historyOffsets, setHistoryOffsets] = useState({
    suppressions: 0,
    sends: 0,
  });
  const [suppressionEmail, setSuppressionEmail] = useState("");
  const isPublisher = publisherId === workspaceId;
  const paths = useMemo(() => {
    const required: Record<string, string> = { newsletters: "/" };
    if (section === "newsletters" || section === "reports") {
      required.overview = "/overview";
    }
    if (section === "settings") {
      if (tab === 2) required.infrastructure = "/infrastructure";
      if (tab === 0) required.suppressions = "/suppressions";
      if (tab === 1) {
        required.health = "/delivery-health";
        required.sends = "/sends";
      }
    }
    if (section === "reports") {
      required.health = "/delivery-health";
      required.infrastructure = "/infrastructure";
    }
    return Object.entries(required);
  }, [section, tab]);
  const publicationQueries = useQueries({
    queries: paths.map(([key, path]) => ({
      queryKey:
        key === "infrastructure"
          ? ["workspace-infrastructure", apiBase, workspaceId]
          : [
              "publication-management",
              apiBase,
              workspaceId,
              key,
              key === "health" ? reportAccountId : "",
            ],
      enabled: Boolean(publisherId) && isPublisher,
      staleTime: 15_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const response = await axios.get<{ data: unknown }>(
          `${apiBase}/api/publications${path}`,
          {
            signal,
            params: {
              workspaceId,
              ...(key === "health" && reportAccountId
                ? { accountId: reportAccountId }
                : {}),
              ...(["suppressions", "sends"].includes(key) ? { limit: 25 } : {}),
            },
          },
        );
        return response.data.data;
      },
    })),
  });
  const data: RecordValue = {
    ...Object.fromEntries(
      paths.map(([key], index) => [key, publicationQueries[index]?.data]),
    ),
    ...historyData,
  };
  const queryFailure = publicationQueries.find((query) => query.isError)?.error;
  const error =
    operationError ?? (queryFailure ? errorText(queryFailure) : null);
  const loading = busy || publicationQueries.some((query) => query.isPending);
  const newslettersLoading = publicationQueries[0]?.isPending;
  const healthQuery = publicationQueries.find(
    (_query, index) => paths[index]?.[0] === "health",
  );
  let emailActivityMessage = "No email activity yet.";
  if (healthQuery?.isPending) {
    emailActivityMessage = "Loading email activity…";
  } else if (healthQuery?.isError) {
    emailActivityMessage = "Email activity is unavailable.";
  }
  const refresh = useCallback(async () => {
    setData({});
    setHistoryOffsets({ suppressions: 0, sends: 0 });
    setSuppressionEmail("");
    setError(null);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["publication-management", apiBase, workspaceId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["workspace-infrastructure", apiBase, workspaceId],
      }),
    ]);
  }, [apiBase, queryClient, workspaceId]);
  useEffect(() => {
    setData({});
    setHistoryOffsets({ suppressions: 0, sends: 0 });
    setSuppressionEmail("");
    setError(null);
  }, [section, tab, workspaceId]);
  const historyPage = async (key: "suppressions" | "sends", offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const path = `/${key}`;
      const parameters = { workspaceId, limit: 25, offset };
      const response =
        key === "suppressions" && suppressionEmail.trim()
          ? await axios.post<{ data: unknown }>(
              `${apiBase}/api/publications/suppressions/search`,
              { ...parameters, email: suppressionEmail.trim() },
            )
          : await axios.get<{ data: unknown }>(
              `${apiBase}/api/publications${path}`,
              { params: parameters },
            );
      setData((current) => ({ ...current, [key]: response.data.data }));
      setHistoryOffsets((current) => ({ ...current, [key]: offset }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  };
  const switchNewsletter = async (targetId: string) => {
    if (switchingWorkspace) return;
    setOpeningNewsletter(targetId);
    const switched = await switchWorkspace(
      targetId,
      targetId === publisherId ? "/workspace/newsletters" : "/home",
    );
    if (!switched) setOpeningNewsletter(null);
  };
  const common = { workspaceId, apiBase, onComplete: refresh };
  const newsletters = optionList(data.newsletters, "workspaceId", "name");
  const publicationStats = rows(record(data.overview).newsletters);
  const statsById = new Map(
    publicationStats.map((item) => [text(item.workspaceId), item]),
  );
  const newsletterField: Field = {
    key: "newsletterId",
    label: "Newsletter",
    kind: "select",
    options: newsletters,
    required: true,
  };
  const reportObservations = rows(record(data.health).observations).filter(
    (item) => !reportIpId || item.ipId === reportIpId,
  );

  if (!publisherId)
    return (
      <Stack spacing={2}>
        <Typography component="h1" variant="h2">
          Create workspace
        </Typography>
        <CreateWorkspaceForm workspaceId={workspaceId} apiBase={apiBase} />
      </Stack>
    );
  if (!isPublisher)
    return (
      <Stack spacing={3}>
        <Button
          startIcon={<ArrowBackOutlined />}
          sx={{ alignSelf: "flex-start" }}
          disabled={openingNewsletter !== null}
          onClick={() => void switchNewsletter(publisherId)}
        >
          All newsletters
        </Button>
        <Typography variant="h3">
          {workspace.type === CompletionStatus.Successful
            ? workspace.value.name
            : "Newsletter"}
        </Typography>
        <Typography color="text.secondary">
          Manage this newsletter’s subscribers, campaigns and journeys.
        </Typography>
        <Button
          variant="contained"
          sx={{ alignSelf: "flex-start" }}
          href={`${router.basePath}/home`}
        >
          Open newsletter
        </Button>
        {error && <Alert severity="error">{error}</Alert>}
      </Stack>
    );

  return (
    <Stack spacing={2} sx={{ width: "100%", minWidth: 0 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
      >
        <Box>
          <Typography component="h1" variant="h2">
            {
              {
                newsletters: "Newsletters",
                subscribers: "Subscribers",
                reports: "Reports",
                settings: "Workspace settings",
              }[section]
            }
          </Typography>
          {section === "newsletters" && (
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              Choose a newsletter to manage its audience and campaigns.
            </Typography>
          )}
        </Box>
        {section === "newsletters" ? (
          <Button
            variant="contained"
            startIcon={<AddOutlined />}
            onClick={() => setCreating(true)}
            sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}
          >
            New newsletter
          </Button>
        ) : (
          <Button
            startIcon={<ArrowBackOutlined />}
            onClick={() =>
              void workspaceNavigation.push("/workspace/newsletters")
            }
            sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}
          >
            Newsletters
          </Button>
        )}
      </Stack>
      {error && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" onClick={() => void refresh()}>
              Refresh
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {creating && (
        <CreateNewsletterDialog
          workspaceId={workspaceId}
          apiBase={apiBase}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {section === "newsletters" && (
        <>
          <Typography variant="body2" color="text.secondary">
            {newslettersLoading
              ? "Loading newsletters…"
              : `${newsletters.length} ${newsletters.length === 1 ? "newsletter" : "newsletters"}`}
          </Typography>
          <Paper
            variant="outlined"
            sx={{ borderRadius: 1, overflow: "hidden" }}
          >
            {newsletters.length > 0 ? (
              <Box sx={{ overflowX: "auto" }}>
                <Table>
                  <TableHead sx={{ bgcolor: "action.hover" }}>
                    <TableRow>
                      <TableCell>Newsletter</TableCell>
                      <TableCell
                        align="right"
                        sx={{ display: { xs: "none", sm: "table-cell" } }}
                      >
                        Subscribers
                      </TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows(data.newsletters).map((newsletter) => (
                      <TableRow
                        key={text(newsletter.workspaceId)}
                        hover
                        sx={{ "&:last-child td": { borderBottom: 0 } }}
                      >
                        <TableCell sx={{ py: 1.5 }}>
                          <Stack
                            direction="row"
                            spacing={1.5}
                            alignItems="center"
                          >
                            <Box
                              sx={{
                                display: "flex",
                                p: 1,
                                borderRadius: 1,
                                bgcolor: "action.hover",
                                color: "primary.main",
                              }}
                            >
                              <MailOutline />
                            </Box>
                            <Stack minWidth={0}>
                              <Typography
                                fontWeight={600}
                                noWrap
                                title={text(newsletter.name)}
                                sx={{ maxWidth: { xs: 108, sm: 480 } }}
                              >
                                {text(newsletter.name)}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ display: { sm: "none" } }}
                              >
                                {text(
                                  statsById.get(text(newsletter.workspaceId))
                                    ?.subscriptionCount,
                                )}{" "}
                                subscribers
                              </Typography>
                            </Stack>
                          </Stack>
                        </TableCell>
                        <TableCell
                          align="right"
                          sx={{ display: { xs: "none", sm: "table-cell" } }}
                        >
                          {text(
                            statsById.get(text(newsletter.workspaceId))
                              ?.subscriptionCount,
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            variant="outlined"
                            color={
                              newsletter.status === "active"
                                ? "success"
                                : "default"
                            }
                            label={text(newsletter.status)}
                            sx={{ textTransform: "capitalize" }}
                          />
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            aria-label={`Configure ${text(newsletter.name)}`}
                            onClick={() =>
                              void workspaceNavigation.push(
                                `/workspace/newsletters/${text(newsletter.workspaceId)}`,
                              )
                            }
                            sx={{ minWidth: 36 }}
                          >
                            <SettingsOutlined fontSize="small" />
                          </Button>
                          <Button
                            endIcon={<ArrowForwardOutlined />}
                            aria-label={`Open ${text(newsletter.name)}`}
                            disabled={openingNewsletter !== null}
                            onClick={() =>
                              void switchNewsletter(
                                text(newsletter.workspaceId),
                              )
                            }
                          >
                            {openingNewsletter === newsletter.workspaceId
                              ? "Opening…"
                              : "Open"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            ) : (
              <Stack spacing={1.5} alignItems="center" sx={{ py: 4, px: 2 }}>
                {newslettersLoading ? (
                  <CircularProgress size={28} />
                ) : (
                  <>
                    <MailOutline
                      sx={{ fontSize: 40, color: "text.secondary" }}
                    />
                    <Typography variant="h4">
                      {publicationQueries[0]?.isError
                        ? "Newsletters could not be loaded."
                        : "No newsletters yet"}
                    </Typography>
                    {!publicationQueries[0]?.isError && (
                      <Typography color="text.secondary">
                        Create your first newsletter to get started.
                      </Typography>
                    )}
                  </>
                )}
              </Stack>
            )}
          </Paper>
        </>
      )}
      {section === "reports" && (
        <Stack spacing={2}>
          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            {(
              [
                ["subscriptionCount", "Newsletter subscriptions"],
                ["contactCount", "Contact records"],
                ["matchedMailboxCount", "Matched mailboxes"],
              ] as const
            ).map(([key, label]) => (
              <Paper
                key={key}
                variant="outlined"
                sx={{ p: 2, flex: 1, borderRadius: 1, minWidth: 0 }}
              >
                <Stack spacing={1}>
                  <Typography color="text.secondary">{label}</Typography>
                  <Typography variant="h2">
                    {text(record(record(data.overview).totals)[key])}
                  </Typography>
                </Stack>
              </Paper>
            ))}
          </Stack>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
            <Typography variant="h4" sx={{ mb: 2 }}>
              By newsletter
            </Typography>
            <DataTable
              data={publicationStats}
              columns={[
                ["name", "Newsletter"],
                ["subscriptionCount", "Subscriptions"],
                ["contactCount", "Contact records"],
              ]}
            />
          </Paper>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
            <Typography variant="h4" sx={{ mb: 2 }}>
              Email activity · last 30 days
            </Typography>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={1.5}
              sx={{ mb: 2 }}
            >
              <TextField
                select
                size="small"
                label="ESP account"
                value={reportAccountId}
                onChange={(event) => {
                  setReportAccountId(event.target.value);
                  setReportIpId("");
                }}
                sx={{ minWidth: 220 }}
              >
                <MenuItem value="">All accounts</MenuItem>
                {rows(record(data.infrastructure).accounts).map((account) => (
                  <MenuItem key={text(account.id)} value={text(account.id)}>
                    {text(account.name)}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                label="Dedicated IP"
                value={reportIpId}
                onChange={(event) => setReportIpId(event.target.value)}
                sx={{ minWidth: 220 }}
              >
                <MenuItem value="">All dedicated IPs</MenuItem>
                {rows(record(data.infrastructure).ips)
                  .filter(
                    (ip) =>
                      !reportAccountId || ip.accountId === reportAccountId,
                  )
                  .map((ip) => (
                    <MenuItem key={text(ip.id)} value={text(ip.id)}>
                      {text(ip.address)}
                    </MenuItem>
                  ))}
              </TextField>
            </Stack>
            {reportObservations.length ? (
              <DataTable
                data={reportObservations.map((item) => ({
                  ...item,
                  newsletter:
                    newsletters.find(
                      (newsletter) => newsletter.value === item.newsletterId,
                    )?.label ?? text(item.newsletterId),
                }))}
                columns={[
                  ["newsletter", "Newsletter"],
                  ["event", "Observation"],
                  ["observedEventCount", "Events"],
                ]}
              />
            ) : (
              <Typography
                color="text.secondary"
                role={healthQuery?.isPending ? "status" : undefined}
              >
                {emailActivityMessage}
              </Typography>
            )}
          </Paper>
        </Stack>
      )}
      {section === "subscribers" && (
        <Stack spacing={2}>
          <Box
            component="form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (searching) return;
              setSearching(true);
              setError(null);
              try {
                const response = await axios.post<{ data: RecordValue }>(
                  `${apiBase}/api/publications/contacts/search`,
                  { workspaceId, searchTerm, limit: 100 },
                );
                setSearchResults(record(response.data.data));
                setSelectedContacts([]);
              } catch (failure) {
                setError(errorText(failure));
              } finally {
                setSearching(false);
              }
            }}
          >
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={1.5}
              alignItems={{ sm: "flex-start" }}
            >
              <TextField
                label="Search subscriber records"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                fullWidth
              />
              <Button
                type="submit"
                variant="contained"
                disabled={searching}
                sx={{ minWidth: 88, minHeight: 38 }}
              >
                {searching ? "Searching…" : "Search"}
              </Button>
            </Stack>
          </Box>
          {Array.isArray(searchResults.contacts) &&
            !searchResults.contacts.length && (
              <Typography color="text.secondary">
                No subscribers found.
              </Typography>
            )}
          {rows(searchResults.contacts).map((contact) => (
            <Paper
              key={text(contact.compositeId)}
              variant="outlined"
              sx={{ p: 1 }}
            >
              <FormControlLabel
                label={`${text(contact.email)} · ${newsletters.find((item) => item.value === contact.newsletterId)?.label ?? text(contact.newsletterId)}`}
                control={
                  <Checkbox
                    checked={selectedContacts.some(
                      (item) => item.compositeId === contact.compositeId,
                    )}
                    onChange={(event) =>
                      setSelectedContacts((current) =>
                        event.target.checked
                          ? [...current, contact]
                          : current.filter(
                              (item) =>
                                item.compositeId !== contact.compositeId,
                            ),
                      )
                    }
                  />
                }
              />
            </Paper>
          ))}
          {selectedContacts.length > 0 && (
            <Stack spacing={2}>
              <TextField
                label="Consent provenance for an explicit subscribe operation"
                value={operationConsent}
                onChange={(event) => setOperationConsent(event.target.value)}
              />
              <Stack direction="row" spacing={2}>
                {["subscribe", "unsubscribe"].map((operation) => (
                  <Button
                    key={operation}
                    variant="outlined"
                    onClick={async () => {
                      try {
                        await axios.post(
                          `${apiBase}/api/publications/contacts/operations`,
                          {
                            workspaceId,
                            newsletterIds: [
                              ...new Set(
                                selectedContacts.map(
                                  (item) => item.newsletterId,
                                ),
                              ),
                            ],
                            contacts: selectedContacts.map((item) => ({
                              newsletterId: item.newsletterId,
                              userId: item.userId,
                            })),
                            operation,
                            ...(operationConsent
                              ? { consent: operationConsent }
                              : {}),
                          },
                        );
                        setSelectedContacts([]);
                        await refresh();
                      } catch (failure) {
                        setError(errorText(failure));
                      }
                    }}
                  >
                    {operation} selected records
                  </Button>
                ))}
              </Stack>
            </Stack>
          )}
        </Stack>
      )}
      {section === "settings" && (
        <Stack spacing={2}>
          <Tabs
            value={tab}
            onChange={(_event, value: number) => setTab(value)}
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab label="Suppressions" />
            <Tab label="Activity" />
            <Tab label="Advanced" />
          </Tabs>
          {loading && <CircularProgress size={20} />}
          {tab === 2 && (
            <Stack spacing={2}>
              <ActionForm
                {...common}
                title="Edit a newsletter"
                path="/"
                method="patch"
                fields={[
                  newsletterField,
                  { key: "name", label: "Newsletter name (optional)" },
                  {
                    key: "status",
                    label: "Status",
                    kind: "select",
                    options: ["draft", "active", "paused"].map((value) => ({
                      value,
                      label: value,
                    })),
                  },
                ]}
              />
              <ActionForm
                {...common}
                title="Adopt an existing newsletter"
                path="/adopt"
                description="Link an existing child workspace without moving subscribers."
                fields={[
                  {
                    key: "newsletterId",
                    label: "Existing workspace UUID",
                    required: true,
                  },
                  { key: "slug", label: "Sending ID", required: true },
                  {
                    key: "subscriptionGroupId",
                    label:
                      "Existing subscription-group UUID (if multiple groups)",
                  },
                ]}
              />
              <ActionForm
                {...common}
                title="Account inspection"
                path="/infrastructure/accounts/inspect"
                buttonLabel="Check account"
                showDetails
                fields={[
                  {
                    key: "accountId",
                    label: "ESP account",
                    kind: "select",
                    options: optionList(
                      record(data.infrastructure).accounts,
                      "id",
                      "name",
                    ),
                    required: true,
                  },
                ]}
              />
            </Stack>
          )}
          {tab === 0 && (
            <Stack spacing={3}>
              <ActionForm
                {...common}
                title="Add suppression"
                path="/suppressions"
                method="put"
                fields={[
                  { key: "email", label: "Mailbox", required: true },
                  {
                    key: "reason",
                    label: "Reason",
                    kind: "select",
                    required: true,
                    options: suppressionReasons,
                  },
                  {
                    ...newsletterField,
                    key: "sourceNewsletterId",
                    label: "Source newsletter (optional)",
                    required: false,
                  },
                  {
                    key: "sourceEventId",
                    label: "Source evidence / event ID (optional)",
                  },
                ]}
              />
              <Box
                component="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void historyPage("suppressions", 0);
                }}
              >
                <Stack direction="row" spacing={2}>
                  <TextField
                    label="Find suppression by email"
                    value={suppressionEmail}
                    onChange={(event) =>
                      setSuppressionEmail(event.target.value)
                    }
                    fullWidth
                  />
                  <Button type="submit" disabled={loading}>
                    Find blocks
                  </Button>
                </Stack>
              </Box>
              <DataTable
                data={rows(data.suppressions).map((suppression) => ({
                  ...suppression,
                  reasonLabel:
                    suppressionReasons.find(
                      (reason) => reason.value === suppression.reason,
                    )?.label ?? text(suppression.reason),
                }))}
                columns={[
                  ["mailboxHash", "Mailbox fingerprint"],
                  ["reasonLabel", "Reason"],
                  ["sourceNewsletterId", "Source newsletter"],
                  ["active", "Active"],
                ]}
              />
              <HistoryPages
                offset={historyOffsets.suppressions}
                count={rows(data.suppressions).length}
                busy={loading}
                onPage={(offset) => void historyPage("suppressions", offset)}
              />
              <ActionForm
                {...common}
                title="Remove suppression"
                path="/suppressions/deactivate"
                fields={[
                  {
                    key: "suppressionId",
                    label: "Suppression",
                    kind: "select",
                    options: rows(data.suppressions)
                      .filter((suppression) => suppression.active === true)
                      .map((suppression) => ({
                        value: text(suppression.id),
                        label: `${suppressionReasons.find((reason) => reason.value === suppression.reason)?.label ?? text(suppression.reason)} · ${text(suppression.mailboxHash).slice(0, 12)}`,
                      })),
                    required: true,
                  },
                ]}
              />
            </Stack>
          )}
          {tab === 1 && (
            <Stack spacing={3}>
              <Typography color="text.secondary">
                {text(record(data.health).periodStart)} —{" "}
                {text(record(data.health).periodEnd)}
              </Typography>
              <DataTable
                data={record(data.health).observations}
                columns={[
                  ["newsletterId", "Newsletter"],
                  ["ipId", "Historical physical IP"],
                  ["event", "Observation"],
                  ["sendsWithEvent", "Sends with observation"],
                  ["observedEventCount", "Distinct observed events"],
                ]}
              />
              <DataTable
                data={rows(record(data.health).ips).map((ip) => ({
                  ...ip,
                  hourly: record(ip.currentLimits).hourly,
                  daily: record(ip.currentLimits).daily,
                }))}
                columns={[
                  ["address", "Physical IP"],
                  ["status", "Status"],
                  ["hourly", "Current hourly cap"],
                  ["daily", "Current daily cap"],
                  ["windows", "Current shared reservations"],
                ]}
              />
              <DataTable
                data={record(data.health).states}
                columns={[
                  ["state", "Queue state"],
                  ["count", "Sends"],
                ]}
              />
              <Typography color="text.secondary">
                Pending webhook receipts:{" "}
                {text(record(data.health).pendingReceipts)}
              </Typography>
              <DataTable
                data={record(data.sends).sends ?? data.sends}
                columns={[
                  ["workspaceId", "Newsletter"],
                  ["logicalMessageId", "Send identity"],
                  ["state", "State"],
                  ["ipId", "Pinned IP"],
                  ["connectionRevision", "Connection revision"],
                  ["nextAttemptAt", "Next eligibility"],
                  ["error", "Review reason"],
                ]}
              />
              <HistoryPages
                offset={historyOffsets.sends}
                count={rows(record(data.sends).sends ?? data.sends).length}
                busy={loading}
                onPage={(offset) => void historyPage("sends", offset)}
              />
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}

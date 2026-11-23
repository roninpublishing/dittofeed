import {
  AddOutlined,
  ArrowBackOutlined,
  ArrowForwardOutlined,
  ExpandMoreOutlined,
  MailOutline,
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
import axios from "axios";
import { isObject } from "isomorphic-lib/src/objects";
import { CompletionStatus } from "isomorphic-lib/src/types";
import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";

import { useAppStorePick } from "../../lib/appStore";
import CreateNewsletterDialog from "./createNewsletterDialog";
import TrackingDomains from "./trackingDomains";

type RecordValue = Record<string, unknown>;
type Option = { value: string; label: string };
type Field = {
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
};
function record(value: unknown): RecordValue {
  return isObject(value) ? value : {};
}
function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string {
  if (value === undefined || value === null) {
    return "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
function optionList(value: unknown, idKey: string, labelKey: string): Option[] {
  return rows(value).map((row) => ({
    value: text(row[idKey]),
    label: text(row[labelKey]),
  }));
}
function errorText(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = record(error.response?.data);
    return typeof data.message === "string"
      ? data.message
      : "Publication operation failed";
  }
  return error instanceof SyntaxError
    ? "Invalid JSON in an advanced field"
    : "Publication operation failed";
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
      <Table size="small">
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
                      <Checkbox
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
            {result !== undefined && (
              <Alert severity="success">
                Operation completed. Review the updated status below.
              </Alert>
            )}
            <Button type="submit" variant="contained" disabled={busy}>
              {busy ? "Working…" : buttonLabel ?? title}
            </Button>
            {result !== undefined && (
              <Box component="details">
                <Box component="summary">
                  Operation details / DNS requirements
                </Box>
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
}: {
  publisherId: string | null;
}) {
  const { workspace, apiBase, authMode } = useAppStorePick([
    "workspace",
    "apiBase",
    "authMode",
  ]);
  const router = useRouter();
  const workspaceId =
    workspace.type === CompletionStatus.Successful ? workspace.value.id : "";
  const [tab, setTab] = useState(0);
  let section = "newsletters";
  if (router.query.view === "subscribers") {
    section = "subscribers";
  } else if (router.query.view === "reports") {
    section = "reports";
  } else if (router.query.view === "settings") {
    section = "settings";
  }
  const [creating, setCreating] = useState(false);
  const [openingNewsletter, setOpeningNewsletter] = useState<string | null>(
    null,
  );
  const [data, setData] = useState<RecordValue>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<RecordValue>({});
  const [selectedContacts, setSelectedContacts] = useState<RecordValue[]>([]);
  const [operationConsent, setOperationConsent] = useState("");
  const [historyOffsets, setHistoryOffsets] = useState({
    actions: 0,
    suppressions: 0,
    sends: 0,
  });
  const [suppressionEmail, setSuppressionEmail] = useState("");
  const isPublisher = publisherId === workspaceId;
  const refresh = useCallback(async () => {
    if (!publisherId || !isPublisher) return;
    setLoading(true);
    setError(null);
    try {
      const paths: Record<string, string> = {
        newsletters: "/",
        overview: "/overview",
      };
      if (section === "settings") {
        paths.infrastructure = "/infrastructure";
        if (tab === 3) {
          paths.automations = "/automations";
          paths.actions = "/automations/actions";
        }
        if (tab === 4) paths.suppressions = "/suppressions";
        if (tab === 5) {
          paths.health = "/delivery-health";
          paths.sends = "/sends";
        }
      }
      if (section === "reports") paths.health = "/delivery-health";
      const entries = await Promise.all(
        Object.entries(paths).map(async ([key, path]) => {
          const response = await axios.get<{ data: unknown }>(
            `${apiBase}/api/publications${path}`,
            {
              params: {
                workspaceId,
                ...(["actions", "suppressions", "sends"].includes(key)
                  ? { limit: 25 }
                  : {}),
              },
            },
          );
          return [key, response.data.data];
        }),
      );
      setData((current) => ({ ...current, ...Object.fromEntries(entries) }));
      setHistoryOffsets({ actions: 0, suppressions: 0, sends: 0 });
      setSuppressionEmail("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  }, [apiBase, isPublisher, publisherId, workspaceId, section, tab]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const historyPage = async (
    key: "actions" | "suppressions" | "sends",
    offset: number,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const path = key === "actions" ? "/automations/actions" : `/${key}`;
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
    if (openingNewsletter) return;
    setOpeningNewsletter(targetId);
    try {
      if (authMode === "google")
        await axios.post(`${apiBase}/api/account/workspace`, {
          workspaceId: targetId,
        });
      else if (authMode === "single-tenant" || authMode === "anonymous")
        await axios.post(`${apiBase}/api/public/single-tenant/workspace`, {
          workspaceId: targetId,
        });
      else {
        await router.push(`/select-workspace?workspaceId=${targetId}`);
        return;
      }
      // Reload the document so no prior newsletter's client caches survive the switch.
      window.location.assign(
        `${router.basePath}${targetId === publisherId ? "/publications" : "/home"}`,
      );
    } catch (failure) {
      setOpeningNewsletter(null);
      setError(errorText(failure));
    }
  };
  const common = { workspaceId, apiBase, onComplete: refresh };
  const infrastructure = record(data.infrastructure);
  const account = record(infrastructure.account);
  const newsletters = optionList(data.newsletters, "workspaceId", "name");
  const connections = optionList(infrastructure.connections, "id", "username");
  const ips = optionList(infrastructure.ips, "id", "address");
  const pools = optionList(infrastructure.pools, "id", "name");
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
  const connectionField: Field = {
    key: "connectionId",
    label: "Sending connection",
    kind: "select",
    options: connections,
    required: true,
  };
  const poolField: Field = {
    key: "poolId",
    label: "IP pool",
    kind: "select",
    options: pools,
    required: true,
  };
  const bindingFields: Field[] = [
    connectionField,
    poolField,
    { key: "providerPoolName", label: "SendGrid pool name", required: true },
  ];

  if (!publisherId)
    return (
      <Stack spacing={3}>
        <Typography variant="h3">Ronin newsletter management</Typography>
        <Alert severity="info">
          This workspace is not yet a publisher. Initialization does not move
          contacts, provision SendGrid, or send email.
        </Alert>
        <ActionForm
          {...common}
          title="Initialize publisher workspace"
          path="/publisher"
          fields={[
            {
              key: "name",
              label: "Management workspace name",
              initial: "Ronin Publishing",
              required: true,
            },
          ]}
          onComplete={async () => router.reload()}
        />
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
    <Stack spacing={3} sx={{ width: "100%" }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
      >
        <Box>
          <Typography
            variant="h2"
            sx={{ fontWeight: 700, letterSpacing: -0.5 }}
          >
            {
              {
                newsletters: "Newsletters",
                subscribers: "Subscribers",
                reports: "Reports",
                settings: "Publisher settings",
              }[section]
            }
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {
              {
                newsletters:
                  "Choose a newsletter to manage its audience and campaigns.",
                subscribers: "Find subscribers across your newsletters.",
                reports: "A combined view of your newsletters.",
                settings:
                  "Shared sending, tracking and publisher-wide controls.",
              }[section]
            }
          </Typography>
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
            onClick={() => void router.push("/publications")}
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
            {loading
              ? "Loading newsletters…"
              : `${newsletters.length} ${newsletters.length === 1 ? "newsletter" : "newsletters"}`}
          </Typography>
          <Paper
            variant="outlined"
            sx={{ borderRadius: 2, overflow: "hidden" }}
          >
            {newsletters.length > 0 ? (
              <Box sx={{ overflowX: "auto" }}>
                <Table>
                  <TableHead sx={{ bgcolor: "action.hover" }}>
                    <TableRow>
                      <TableCell>Newsletter</TableCell>
                      <TableCell align="right">Subscribers</TableCell>
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
                        <TableCell sx={{ py: 3 }}>
                          <Stack
                            direction="row"
                            spacing={2}
                            alignItems="center"
                          >
                            <Box
                              sx={{
                                display: "flex",
                                p: 1.25,
                                borderRadius: 2,
                                bgcolor: "action.hover",
                                color: "primary.main",
                              }}
                            >
                              <MailOutline />
                            </Box>
                            <Typography fontWeight={600}>
                              {text(newsletter.name)}
                            </Typography>
                          </Stack>
                        </TableCell>
                        <TableCell align="right">
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
              <Stack spacing={2} alignItems="center" sx={{ py: 8, px: 3 }}>
                {loading ? (
                  <CircularProgress size={28} />
                ) : (
                  <>
                    <MailOutline
                      sx={{ fontSize: 40, color: "text.secondary" }}
                    />
                    <Typography variant="h4">No newsletters yet</Typography>
                    <Typography color="text.secondary">
                      Create your first newsletter to get started.
                    </Typography>
                  </>
                )}
              </Stack>
            )}
          </Paper>
        </>
      )}
      {section === "reports" && (
        <Stack spacing={3}>
          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            {(
              [
                [
                  "subscriptionCount",
                  "Publication subscriptions",
                  "A subscription is counted in each newsletter.",
                ],
                [
                  "contactCount",
                  "Contact records",
                  "Subscriber profiles remain independent.",
                ],
                [
                  "matchedMailboxCount",
                  "Matched mailboxes",
                  "Matched email addresses, not verified unique people.",
                ],
              ] as const
            ).map(([key, label, hint]) => (
              <Paper
                key={key}
                variant="outlined"
                sx={{ p: 3, flex: 1, borderRadius: 2 }}
              >
                <Stack spacing={1}>
                  <Typography color="text.secondary">{label}</Typography>
                  <Typography variant="h2">
                    {text(record(record(data.overview).totals)[key])}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {hint}
                  </Typography>
                </Stack>
              </Paper>
            ))}
          </Stack>
          <Paper variant="outlined" sx={{ p: 3, borderRadius: 2 }}>
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
          <Paper variant="outlined" sx={{ p: 3, borderRadius: 2 }}>
            <Typography variant="h4" sx={{ mb: 1 }}>
              Email activity
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Last 30 days. Opens and clicks are observations, not verified
              human engagement.
            </Typography>
            {rows(record(data.health).observations).length ? (
              <DataTable
                data={rows(record(data.health).observations).map((item) => ({
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
              <Typography color="text.secondary">
                No email activity yet.
              </Typography>
            )}
          </Paper>
        </Stack>
      )}
      {section === "subscribers" && (
        <Stack spacing={3}>
          <Box
            component="form"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                const response = await axios.post<{ data: RecordValue }>(
                  `${apiBase}/api/publications/contacts/search`,
                  { workspaceId, searchTerm, limit: 100 },
                );
                setSearchResults(record(response.data.data));
                setSelectedContacts([]);
              } catch (failure) {
                setError(errorText(failure));
              }
            }}
          >
            <Stack direction="row" spacing={2}>
              <TextField
                label="Search subscriber records"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                fullWidth
              />
              <Button type="submit">Search</Button>
            </Stack>
          </Box>
          <Typography color="text.secondary">
            The same email can have a separate subscriber record in each
            newsletter.
          </Typography>
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
        <Stack spacing={3}>
          <Alert severity="info">
            Provider changes and real sends require explicit release
            authorization. Shared-IP limits cover Ditto-managed traffic;
            external traffic can bypass them.
          </Alert>
          <Tabs
            value={tab}
            onChange={(_event, value: number) => setTab(value)}
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab label="Newsletters" />
            <Tab label="Sending" />
            <Tab label="IP pools" />
            <Tab label="Automations" />
            <Tab label="Suppression" />
            <Tab label="Diagnostics" />
            <Tab label="Tracking domains" />
          </Tabs>
          {loading && <CircularProgress size={20} />}
          {tab === 0 && (
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
                description="Only an existing child workspace of this publisher can be adopted. Subscribers are not copied or merged. Live-contact migration requires separate release authorization."
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
            </Stack>
          )}
          {tab === 1 && (
            <Stack spacing={3}>
              <ActionForm
                {...common}
                title="Configure SendGrid management"
                path="/infrastructure/account"
                method="put"
                description="Stored keys are encrypted and never returned. Entering a replacement key does not rotate any existing subuser key."
                fields={[
                  {
                    key: "managementApiKey",
                    label: "Parent management API key (leave blank to retain)",
                    kind: "password",
                  },
                  {
                    key: "region",
                    label: "SendGrid region",
                    kind: "select",
                    initial:
                      typeof account.region === "string"
                        ? account.region
                        : "global",
                    options: [
                      { value: "global", label: "Global" },
                      { value: "eu", label: "EU" },
                    ],
                  },
                  {
                    key: "callbackBaseUrl",
                    label: "Public HTTPS callback origin",
                    initial:
                      typeof account.callbackBaseUrl === "string"
                        ? account.callbackBaseUrl
                        : "",
                  },
                  {
                    key: "allowProviderWrites",
                    label: "Release gate: authorize provider resource changes",
                    kind: "boolean",
                    initial: account.allowProviderWrites === true,
                  },
                  {
                    key: "allowIpReassignment",
                    label: "Release gate: authorize explicit IP reassignment",
                    kind: "boolean",
                    initial: account.allowIpReassignment === true,
                  },
                  {
                    key: "allowRealSends",
                    label: "Release gate: authorize real email submission",
                    kind: "boolean",
                    initial: account.allowRealSends === true,
                  },
                  {
                    key: "allTrafficControlled",
                    label:
                      "All traffic on these dedicated IPs enters Ditto's shared admission gate",
                    kind: "boolean",
                    initial: account.allTrafficControlled === true,
                  },
                ]}
              />
              <ActionForm
                {...common}
                title="Inspect existing AI Stock News resources"
                path="/infrastructure/inspect"
                description="Read-only. Existing aistocknews-ditto, restricted key metadata, domains, IPs, and pools must be inspected and adopted—not recreated."
                fields={[
                  {
                    key: "username",
                    label: "Existing subuser",
                    initial: "aistocknews-ditto",
                    required: true,
                  },
                ]}
              />
              <ActionForm
                {...common}
                title="Register / adopt sending connection"
                path="/infrastructure/connections"
                method="put"
                fields={[
                  newsletterField,
                  {
                    key: "apiKey",
                    label: "Existing restricted sending key",
                    kind: "password",
                  },
                  { key: "apiKeyId", label: "Existing restricted key ID" },
                  {
                    key: "senderDomains",
                    label: "Sending domains",
                    kind: "list",
                    hint: "Separate domains with commas or new lines.",
                  },
                  {
                    key: "senderEmails",
                    label: "Verified sender addresses",
                    kind: "list",
                  },
                ]}
              />
              <DataTable
                data={infrastructure.connections}
                columns={[
                  ["username", "Subuser"],
                  ["administrativeEmail", "Administrative email"],
                  ["status", "Provisioning"],
                  ["revision", "Revision"],
                  ["senderDomains", "Authenticated domains"],
                  ["senderEmails", "Senders"],
                ]}
              />
              <ActionForm
                {...common}
                title="Inspect connection"
                path="/infrastructure/connections/inspect"
                fields={[connectionField]}
              />
              <ActionForm
                {...common}
                title="Resume connection provisioning"
                path="/infrastructure/connections/provision"
                description="Reconciles existing resources. Provider writes remain gated; AI Stock News is adopted rather than recreated."
                fields={[
                  connectionField,
                  { key: "domain", label: "Sending domain (optional)" },
                  {
                    key: "subdomain",
                    label: "Authentication subdomain (optional)",
                  },
                  {
                    key: "configureWebhook",
                    label: "Configure signed connection webhook",
                    kind: "boolean",
                  },
                ]}
              />
              <ActionForm
                {...common}
                title="Reconcile authenticated domain"
                path="/infrastructure/domains"
                fields={[
                  connectionField,
                  { key: "domain", label: "Domain", required: true },
                  { key: "subdomain", label: "Subdomain (optional)" },
                  {
                    key: "validate",
                    label: "Validate published DNS records",
                    kind: "boolean",
                  },
                ]}
              />
              <ActionForm
                {...common}
                title="Reconcile signed webhook"
                path="/infrastructure/webhooks"
                fields={[connectionField]}
              />
              <ActionForm
                {...common}
                title="Manage verified sender identity"
                path="/infrastructure/senders"
                description="This explicit action can send a verification email after the provider-write gate is authorized."
                fields={[
                  connectionField,
                  ...["nickname", "fromEmail", "replyTo"].map((key) => ({
                    key,
                    label: key,
                    required: true,
                  })),
                  ...[
                    "fromName",
                    "address",
                    "city",
                    "state",
                    "zip",
                    "country",
                  ].map((key) => ({ key, label: key })),
                  {
                    key: "sendVerificationEmail",
                    label: "Authorize sending the sender-verification email",
                    kind: "boolean",
                    required: true,
                  },
                ]}
              />
            </Stack>
          )}
          {tab === 2 && (
            <Stack spacing={3}>
              <Alert severity="info">
                Budgets belong to the physical IP, across all newsletters and
                subusers. Registering an IP is not a purchase or provider
                reassignment. Deterministic single-IP pool bindings are required
                for strict per-IP admission.
              </Alert>
              <DataTable
                data={infrastructure.ips}
                columns={[
                  ["address", "Physical IP"],
                  ["status", "Status"],
                  ["hourlyLimit", "Shared hourly budget"],
                  ["dailyLimit", "Shared daily budget"],
                  ["warmupStartedAt", "Warm-up started"],
                  ["id", "IP ID"],
                ]}
              />
              <ActionForm
                {...common}
                title="Register / update physical IP"
                path="/infrastructure/ips"
                method="put"
                fields={[
                  { key: "id", label: "Existing IP record ID (optional)" },
                  {
                    key: "address",
                    label: "Already-owned IP address",
                    required: true,
                  },
                  {
                    key: "status",
                    label: "Status",
                    kind: "select",
                    initial: "paused",
                    options: [
                      { value: "paused", label: "Paused" },
                      { value: "active", label: "Active" },
                    ],
                    required: true,
                  },
                  {
                    key: "hourlyLimit",
                    label: "Aggregate hourly recipient budget",
                    kind: "number",
                    required: true,
                  },
                  {
                    key: "dailyLimit",
                    label: "Aggregate daily recipient budget",
                    kind: "number",
                    required: true,
                  },
                  {
                    key: "warmupStartedAt",
                    label: "Warm-up start (ISO UTC, optional)",
                  },
                  {
                    key: "warmupSchedule",
                    label: "Warm-up stages (JSON array)",
                    kind: "json",
                    hint: '[{"afterDays":0,"hourlyLimit":20,"dailyLimit":100}] — example only, not a recommended schedule',
                  },
                ]}
              />
              <DataTable
                data={infrastructure.pools}
                columns={[
                  ["name", "Pool"],
                  ["id", "Pool ID"],
                ]}
              />
              <ActionForm
                {...common}
                title="Manage logical IP pool"
                path="/infrastructure/pools"
                method="put"
                fields={[
                  { key: "id", label: "Existing pool ID (optional)" },
                  { key: "name", label: "Pool name", required: true },
                  {
                    key: "ipIds",
                    label: "Physical IP members",
                    kind: "multiselect",
                    options: ips,
                    required: true,
                  },
                ]}
              />
              <ActionForm
                {...common}
                title="Register provider pool binding"
                path="/infrastructure/pool-bindings"
                method="put"
                fields={bindingFields}
              />
              <ActionForm
                {...common}
                title="Reconcile SendGrid pool"
                path="/infrastructure/pool-bindings/reconcile"
                fields={bindingFields}
              />
              <ActionForm
                {...common}
                title="Assign newsletter route"
                path="/infrastructure/routes"
                method="put"
                description="Changes future sends only. Existing send attempts retain their pinned route; campaigns and journeys are not rebuilt."
                fields={[newsletterField, connectionField, poolField]}
              />
              <DataTable
                data={infrastructure.routes}
                columns={[
                  ["newsletterId", "Newsletter"],
                  ["connectionId", "Connection"],
                  ["poolId", "Pool"],
                  ["version", "Route revision"],
                ]}
              />
              <ActionForm
                {...common}
                title="Explicit provider IP reassignment"
                path="/infrastructure/ip-reassignment"
                description="A live infrastructure change. Both provider-write and IP-reassignment release gates must be authorized first. No IP purchase occurs."
                fields={[
                  connectionField,
                  {
                    key: "ipIds",
                    label: "Assigned physical IPs",
                    kind: "multiselect",
                    options: ips,
                    required: true,
                  },
                  {
                    key: "confirm",
                    label: "Authorize this live IP reassignment",
                    kind: "boolean",
                    required: true,
                  },
                ]}
              />
            </Stack>
          )}
          {tab === 3 && (
            <Stack spacing={3}>
              <Alert severity="info">
                Rules coordinate independent subscribers deliberately. Repeated
                clicks default to once per source subscriber. Destination
                opt-outs and publisher suppression remain effective; an explicit
                consent rule is required where resubscription is authorized.
              </Alert>
              <DataTable
                data={data.automations}
                columns={[
                  ["name", "Rule"],
                  ["sourceNewsletterId", "Source"],
                  ["destinationNewsletterId", "Destination"],
                  ["enabled", "Enabled"],
                  ["id", "Rule ID"],
                ]}
              />
              <ActionForm
                {...common}
                title="Create / update automation"
                path="/automations"
                method="put"
                fields={[
                  { key: "id", label: "Existing rule ID (optional)" },
                  { key: "name", label: "Rule name", required: true },
                  {
                    ...newsletterField,
                    key: "sourceNewsletterId",
                    label: "Source newsletter",
                  },
                  {
                    ...newsletterField,
                    key: "destinationNewsletterId",
                    label: "Destination newsletter",
                  },
                  { key: "enabled", label: "Enable rule", kind: "boolean" },
                  {
                    key: "definition",
                    label:
                      "Source conditions, destination actions, and field mappings",
                    kind: "json",
                    required: true,
                    hint: "Source link path for clicks: properties.url. destination.welcomeJourneyId must select a Running, event-entry journey in the destination; source.conditions and destination.fieldMappings configure explicit actions.",
                  },
                ]}
              />
              <ActionForm
                {...common}
                title="Retire automation"
                path="/automations"
                method="delete"
                description="Retains action history."
                fields={[
                  {
                    key: "id",
                    label: "Rule",
                    kind: "select",
                    options: optionList(data.automations, "id", "name"),
                    required: true,
                  },
                ]}
              />
              <Typography variant="h4">Automation action history</Typography>
              <DataTable
                data={data.actions}
                columns={[
                  ["ruleId", "Rule"],
                  ["sourceEventId", "Source event"],
                  ["sourceUserId", "Source subscriber"],
                  ["destinationUserId", "Destination subscriber"],
                  ["disposition", "Result"],
                  ["error", "Reason"],
                ]}
              />
              <HistoryPages
                offset={historyOffsets.actions}
                count={rows(data.actions).length}
                busy={loading}
                onPage={(offset) => void historyPage("actions", offset)}
              />
            </Stack>
          )}
          {tab === 4 && (
            <Stack spacing={3}>
              <Alert severity="info">
                Ordinary unsubscribe stays within its newsletter. Spam
                complaints block marketing publisher-wide. Permanent invalid
                mailboxes are distinct from transient or policy failures.
              </Alert>
              <ActionForm
                {...common}
                title="Add publisher suppression"
                path="/suppressions"
                method="put"
                fields={[
                  { key: "email", label: "Mailbox", required: true },
                  {
                    key: "reason",
                    label: "Reason",
                    kind: "select",
                    required: true,
                    options: [
                      "manual",
                      "publisher_optout",
                      "complaint",
                      "invalid_mailbox",
                    ].map((value) => ({ value, label: value })),
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
                    label="Find publisher suppression by mailbox"
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
                data={data.suppressions}
                columns={[
                  ["mailboxHash", "Mailbox fingerprint"],
                  ["reason", "Reason"],
                  ["sourceNewsletterId", "Source newsletter"],
                  ["active", "Active"],
                  ["id", "Suppression ID"],
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
                title="Explicitly deactivate suppression"
                path="/suppressions/deactivate"
                description="Resubscribing to a newsletter never clears a publisher suppression automatically."
                fields={[
                  {
                    key: "suppressionId",
                    label: "Suppression ID",
                    required: true,
                  },
                ]}
              />
            </Stack>
          )}
          {tab === 5 && (
            <Stack spacing={3}>
              <Alert severity="info">
                Queued is not sent. SendGrid acceptance is not delivery. Opens
                and clicks remain observed, not verified human engagement.
                Unknown acceptance requires review—not resubmission.
              </Alert>
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
          {tab === 6 && (
            <TrackingDomains
              workspaceId={workspaceId}
              apiBase={apiBase}
              newsletters={newsletters}
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}

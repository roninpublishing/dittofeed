import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  CompletionStatus,
  GetDeliveryOpenEvidenceResponse,
  GetDeliveryOpensRequest,
  GetDeliveryOpensResponse,
} from "isomorphic-lib/src/types";
import { useState } from "react";

import { useAppStorePick } from "../../lib/appStore";
import { useAuthHeaders, useBaseApiUrl } from "../../lib/authModeProvider";

export function DeliveryOpensCell({
  userId,
  messageId,
  lastOpenedAt,
  openCount,
}: {
  userId: string;
  messageId: string;
  lastOpenedAt: string | null;
  openCount: number;
}) {
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const { workspace } = useAppStorePick(["workspace"]);
  const workspaceId = workspace.type === CompletionStatus.Successful
    ? workspace.value.id
    : null;
  const baseApiUrl = useBaseApiUrl();
  const headers = useAuthHeaders();
  const cursor = cursors[cursors.length - 1];
  const query = useQuery({
    queryKey: ["delivery-opens", workspaceId, userId, messageId, cursor],
    enabled: open && workspaceId !== null,
    queryFn: async () => {
      if (!workspaceId) throw new Error("Workspace unavailable");
      const request: GetDeliveryOpensRequest = {
        workspaceId, userId, messageId, limit: 20, cursor,
      };
      const response = await axios.post(`${baseApiUrl}/deliveries/opens`, request, { headers });
      return unwrap(schemaValidateWithErr(response.data, GetDeliveryOpensResponse));
    },
  });
  const evidence = useQuery({
    queryKey: ["delivery-open-evidence", workspaceId, userId, messageId, evidenceId],
    enabled: open && workspaceId !== null && evidenceId !== null,
    gcTime: 0,
    queryFn: async () => {
      const response = await axios.post(`${baseApiUrl}/deliveries/opens/evidence`, { workspaceId, userId, messageId, evidenceId }, { headers });
      return unwrap(schemaValidateWithErr(response.data, GetDeliveryOpenEvidenceResponse));
    },
  });
  const close = () => {
    setEvidenceId(null);
    setOpen(false);
    setCursors([undefined]);
  };
  return (
    <>
      <Tooltip title="View observed open history; observations are not verified human engagement">
        <Button size="small" onClick={() => setOpen(true)} sx={{ textTransform: "none", whiteSpace: "nowrap" }}>
          <Stack alignItems="flex-start">
            <span>{lastOpenedAt ? new Date(lastOpenedAt).toLocaleString() : "No opens observed"}</span>
            <Typography variant="caption">{openCount} observed · History</Typography>
          </Stack>
        </Button>
      </Tooltip>
      <Dialog open={open} onClose={close} maxWidth="lg" fullWidth>
        <DialogTitle>Observed open history</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Alert severity="info">Unqualified observations, not verified human engagement. Privacy proxies and automated scanners may generate opens.</Alert>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>Contact: {userId} · Send: {messageId}</Typography>
            {query.isPending && <CircularProgress size={24} />}
            {query.isError && <Alert severity="error">Unable to load open history. <Button onClick={() => query.refetch()}>Retry</Button></Alert>}
            {query.data && <>
              <Typography variant="body2">{query.data.openCount} observed opens · Last opened: {query.data.lastOpenedAt ? new Date(query.data.lastOpenedAt).toLocaleString() : "None"}</Typography>
              <Table size="small" aria-label="Observed opens for this send">
                <TableHead><TableRow><TableCell>Opened at (UTC)</TableCell><TableCell>Source / raw evidence</TableCell><TableCell>Provider evidence</TableCell><TableCell>Event ID</TableCell></TableRow></TableHead>
                <TableBody>
                  {query.data.items.map((item) => <TableRow key={JSON.stringify([item.eventId, item.openedAt])}>
                    <TableCell>{item.openedAt}<Typography variant="caption" display="block">Observed, unqualified</Typography></TableCell>
                    <TableCell sx={{ overflowWrap: "anywhere", maxWidth: 400 }}>{item.evidenceSource}{item.evidenceId && <Button onClick={() => setEvidenceId(item.evidenceId ?? null)}>Raw request evidence</Button>}</TableCell>
                    <TableCell sx={{ overflowWrap: "anywhere", maxWidth: 300 }}>{item.provider ?? "Provider unavailable"}<Typography variant="caption" display="block">Message: {item.providerMessageId ?? "Unavailable"}</Typography><Typography variant="caption" display="block">Event: {item.providerEventId ?? "Unavailable"}</Typography></TableCell>
                    <TableCell sx={{ overflowWrap: "anywhere", maxWidth: 260 }}>{item.eventId}</TableCell>
                  </TableRow>)}
                </TableBody>
              </Table>
              {query.data.items.length === 0 && <Typography>No opens observed for this send.</Typography>}
            </>}
            {evidenceId && <Stack spacing={1}>
              <Typography>Raw request evidence · {evidenceId}</Typography>
              {evidence.isPending && <CircularProgress size={24} />}
              {evidence.isError && <Alert severity="warning">Evidence unavailable, expired, or deleted.</Alert>}
              {evidence.data && <Typography component="pre" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(evidence.data.evidence, null, 2)}</Typography>}
              <Button onClick={() => setEvidenceId(null)}>Hide raw evidence</Button>
            </Stack>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={cursors.length <= 1 || query.isFetching} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</Button>
          <Button disabled={!query.data?.cursor || query.isFetching} onClick={() => { const next = query.data?.cursor; if (next) setCursors((current) => [...current, next]); }}>Next</Button>
          <Button onClick={close}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

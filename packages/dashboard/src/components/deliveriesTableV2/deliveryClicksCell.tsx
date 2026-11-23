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
  GetDeliveryClicksRequest,
  GetDeliveryClicksResponse,
} from "isomorphic-lib/src/types";
import { useState } from "react";

import { useAppStorePick } from "../../lib/appStore";
import { useAuthHeaders, useBaseApiUrl } from "../../lib/authModeProvider";

export function DeliveryClicksCell({
  userId,
  messageId,
  lastClickedAt,
  clickCount,
}: {
  userId: string;
  messageId: string;
  lastClickedAt: string | null;
  clickCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const { workspace } = useAppStorePick(["workspace"]);
  const workspaceId =
    workspace.type === CompletionStatus.Successful ? workspace.value.id : null;
  const baseApiUrl = useBaseApiUrl();
  const headers = useAuthHeaders();
  const cursor = cursors[cursors.length - 1];
  const query = useQuery({
    queryKey: ["delivery-clicks", workspaceId, userId, messageId, cursor],
    enabled: open && workspaceId !== null,
    queryFn: async () => {
      if (!workspaceId) throw new Error("Workspace unavailable");
      const request: GetDeliveryClicksRequest = {
        workspaceId,
        userId,
        messageId,
        limit: 20,
        cursor,
      };
      const response = await axios.post(
        `${baseApiUrl}/deliveries/clicks`,
        request,
        { headers },
      );
      return unwrap(
        schemaValidateWithErr(response.data, GetDeliveryClicksResponse),
      );
    },
  });
  const close = () => {
    setOpen(false);
    setCursors([undefined]);
  };
  return (
    <>
      <Tooltip title="View observed click history; observations are not verified human engagement">
        <Button
          size="small"
          onClick={() => setOpen(true)}
          sx={{ textTransform: "none", whiteSpace: "nowrap" }}
        >
          <Stack alignItems="flex-start">
            <span>
              {lastClickedAt
                ? new Date(lastClickedAt).toLocaleString()
                : "No clicks observed"}
            </span>
            <Typography variant="caption">
              {clickCount} observed · History
            </Typography>
          </Stack>
        </Button>
      </Tooltip>
      <Dialog open={open} onClose={close} maxWidth="lg" fullWidth>
        <DialogTitle>Observed click history</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Alert severity="info">
              Unqualified observations, not verified human engagement. Email
              scanners may generate clicks.
            </Alert>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
              Contact: {userId} · Send: {messageId}
            </Typography>
            {query.isPending && <CircularProgress size={24} />}
            {query.isError && (
              <Alert severity="error">
                Unable to load click history.{" "}
                <Button onClick={() => query.refetch()}>Retry</Button>
              </Alert>
            )}
            {query.data && (
              <>
                <Typography variant="body2">
                  {query.data.clickCount} observed clicks · Last clicked:{" "}
                  {query.data.lastClickedAt
                    ? new Date(query.data.lastClickedAt).toLocaleString()
                    : "None"}
                </Typography>
                <Table size="small" aria-label="Observed clicks for this send">
                  <TableHead>
                    <TableRow>
                      <TableCell>Clicked at (UTC)</TableCell>
                      <TableCell>Link</TableCell>
                      <TableCell>Provider evidence</TableCell>
                      <TableCell>Event ID</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {query.data.items.map((item) => (
                      <TableRow
                        key={JSON.stringify([
                          item.eventId,
                          item.clickedAt,
                          item.url,
                        ])}
                      >
                        <TableCell>
                          {item.clickedAt}
                          <Typography variant="caption" display="block">
                            Observed, unqualified
                          </Typography>
                        </TableCell>
                        <TableCell
                          sx={{ overflowWrap: "anywhere", maxWidth: 400 }}
                        >
                          {item.url ?? "Link unavailable"}
                        </TableCell>
                        <TableCell
                          sx={{ overflowWrap: "anywhere", maxWidth: 300 }}
                        >
                          {item.provider ?? "Provider unavailable"}
                          <Typography variant="caption" display="block">
                            Message: {item.providerMessageId ?? "Unavailable"}
                          </Typography>
                          <Typography variant="caption" display="block">
                            Event: {item.providerEventId ?? "Unavailable"}
                          </Typography>
                        </TableCell>
                        <TableCell
                          sx={{ overflowWrap: "anywhere", maxWidth: 260 }}
                        >
                          {item.eventId}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {query.data.items.length === 0 && (
                  <Typography>No clicks observed for this send.</Typography>
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            disabled={cursors.length <= 1 || query.isFetching}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            disabled={!query.data?.cursor || query.isFetching}
            onClick={() => {
              const next = query.data?.cursor;
              if (next) setCursors((current) => [...current, next]);
            }}
          >
            Next
          </Button>
          <Button onClick={close}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

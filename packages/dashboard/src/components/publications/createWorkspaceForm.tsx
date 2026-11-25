import { Alert, Button, Paper, Stack, TextField } from "@mui/material";
import axios from "axios";
import { useState } from "react";

import useWorkspaceSwitch from "../../lib/useWorkspaceSwitch";
import { errorText } from "./settingsShared";

export default function CreateWorkspaceForm({
  workspaceId,
  apiBase,
}: {
  workspaceId: string;
  apiBase: string;
}) {
  const { switchWorkspace } = useWorkspaceSwitch();
  const [name, setName] = useState("");
  const [createdId, setCreatedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Paper variant="outlined" sx={{ p: 2, maxWidth: 480 }}>
      <Stack
        component="form"
        spacing={2}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            let targetId = createdId;
            if (!targetId) {
              const response = await axios.post<{
                data: { workspaceId: string };
              }>(`${apiBase}/api/publications/publisher`, {
                workspaceId,
                name: name.trim(),
                createNewWorkspace: true,
              });
              targetId = response.data.data.workspaceId;
              setCreatedId(targetId);
            }
            if (!(await switchWorkspace(targetId, "/workspace"))) {
              setError("Workspace created. Open it to continue.");
            }
          } catch (failure) {
            setError(errorText(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label="Workspace name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          disabled={busy || Boolean(createdId)}
          inputProps={{ maxLength: 256 }}
          size="small"
        />
        {error && <Alert severity="error">{error}</Alert>}
        <Button
          type="submit"
          variant="contained"
          disabled={busy || !name.trim()}
          sx={{ alignSelf: "flex-start" }}
        >
          {createdId ? "Open workspace" : "Create workspace"}
        </Button>
      </Stack>
    </Paper>
  );
}

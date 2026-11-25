import { ArrowBackOutlined, ArrowForwardOutlined } from "@mui/icons-material";
import { Alert, Button, Paper, Stack, Typography } from "@mui/material";
import axios from "axios";
import { EspSelection } from "isomorphic-lib/src/publications";
import { useRouter } from "next/router";
import { useMemo, useState } from "react";

import { useAppStorePick } from "../../lib/appStore";
import {
  errorText,
  RecordValue,
  rows,
  text,
} from "../publications/settingsShared";
import Link from "./navigation";
import SendSelection, { isEspSelection } from "./sendSelection";

export default function NewsletterDefaults({
  workspaceId,
  apiBase,
  infrastructure,
  newsletters,
  newsletterId,
  onComplete,
}: {
  workspaceId: string;
  apiBase: string;
  infrastructure: RecordValue;
  newsletters: unknown;
  newsletterId: string;
  onComplete: () => Promise<void>;
}) {
  const newsletter = rows(newsletters).find(
    (item) => item.workspaceId === newsletterId,
  );
  const { authMode } = useAppStorePick(["authMode"]);
  const router = useRouter();
  const [selection, setSelection] = useState<EspSelection | null | undefined>();
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const options = useMemo(() => {
    const members = new Map<string, string[]>();
    for (const membership of rows(infrastructure.memberships)) {
      const poolId = text(membership.poolId);
      const ids = members.get(poolId) ?? [];
      ids.push(text(membership.ipId));
      members.set(poolId, ids);
    }
    const singletons = new Set<string>();
    for (const ids of members.values()) {
      if (ids.length === 1 && ids[0]) singletons.add(ids[0]);
    }
    return {
      ...infrastructure,
      ips: rows(infrastructure.ips).map((ip) => ({
        ...ip,
        eligibleSingletonPool: singletons.has(text(ip.id)),
      })),
    };
  }, [infrastructure]);
  const existing = rows(infrastructure.defaults).find(
    (item) => item.newsletterId === newsletterId,
  )?.selection;
  let current = selection;
  if (selection === undefined) {
    current = isEspSelection(existing) ? existing : null;
  }
  if (!newsletter) return <Alert severity="error">Newsletter not found.</Alert>;
  const openNewsletter = async () => {
    setOpening(true);
    setError(null);
    try {
      if (authMode === "google")
        await axios.post(`${apiBase}/api/account/workspace`, {
          workspaceId: newsletterId,
        });
      else if (authMode === "single-tenant" || authMode === "anonymous")
        await axios.post(`${apiBase}/api/public/single-tenant/workspace`, {
          workspaceId: newsletterId,
        });
      else {
        await router.push(`/select-workspace?workspaceId=${newsletterId}`);
        return;
      }
      window.location.assign(`${router.basePath}/home`);
    } catch (failure) {
      setError(errorText(failure));
      setOpening(false);
    }
  };
  return (
    <Stack spacing={2}>
      <Button
        component={Link}
        href="/workspace/newsletters"
        startIcon={<ArrowBackOutlined />}
        sx={{ alignSelf: "flex-start" }}
      >
        Newsletters
      </Button>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        gap={1.5}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
      >
        <Typography component="h1" variant="h2">
          {text(newsletter.name)}
        </Typography>
        <Button
          variant="contained"
          endIcon={<ArrowForwardOutlined />}
          disabled={opening}
          onClick={() => void openNewsletter()}
        >
          Open newsletter
        </Button>
      </Stack>
      <Paper
        component="form"
        variant="outlined"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setError(null);
          setSaved(false);
          try {
            await axios.put(
              `${apiBase}/api/publications/infrastructure/defaults`,
              { workspaceId, newsletterId, selection: current },
            );
            await onComplete();
            setSelection(undefined);
            setSaved(true);
          } catch (failure) {
            setError(errorText(failure));
          } finally {
            setSaving(false);
          }
        }}
        sx={{ p: 2, borderRadius: 1, maxWidth: 560 }}
      >
        <Stack spacing={2}>
          <Typography variant="h4">Sending defaults</Typography>
          <SendSelection
            options={options}
            selection={current}
            onChange={(value) => {
              setSelection(value ?? null);
              setSaved(false);
            }}
            disabled={saving}
          />
          {error && <Alert severity="error">{error}</Alert>}
          {saved && <Alert severity="success">Saved.</Alert>}
          <Button
            type="submit"
            variant="contained"
            disabled={saving}
            sx={{ alignSelf: "flex-start" }}
          >
            {saving ? "Saving…" : "Save defaults"}
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}

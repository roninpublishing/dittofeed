import { ArrowForwardOutlined, CloseOutlined } from "@mui/icons-material";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  WorkspaceObject,
  workspaceTopology,
} from "../../lib/workspaceTopology";
import { RecordValue, rows } from "../publications/settingsShared";

const OverviewGraph = dynamic(() => import("./overviewGraph"), {
  ssr: false,
  loading: () => (
    <Stack height={400} justifyContent="center" alignItems="center">
      <CircularProgress size={28} aria-label="Loading workspace map" />
    </Stack>
  ),
});
const kindLabels = {
  workspace: "Workspace",
  newsletter: "Newsletter",
  account: "ESP account",
  ip: "IP address",
  pool: "IP pool",
  group: "Section",
};

export default function Overview({
  workspaceId,
  workspaceName,
  infrastructure,
  newsletters,
}: {
  workspaceId: string;
  workspaceName: string;
  infrastructure: RecordValue;
  newsletters: unknown;
}) {
  const [view, setView] = useState<"map" | "list">("map");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const topology = useMemo(
    () =>
      workspaceTopology(
        workspaceId,
        workspaceName,
        infrastructure,
        newsletters,
      ),
    [infrastructure, newsletters, workspaceId, workspaceName],
  );
  const selected = topology.objects.find((object) => object.id === selectedId);
  const select = (object: WorkspaceObject) => setSelectedId(object.id);
  return (
    <Stack spacing={2} minWidth={0}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1.5}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
      >
        <Typography component="h1" variant="h2">
          Overview
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            component={Link}
            href="/workspace/newsletters"
            variant="outlined"
          >
            Newsletters
          </Button>
          <Button
            component={Link}
            href="/workspace/esp-accounts"
            variant="contained"
          >
            ESP accounts
          </Button>
        </Stack>
      </Stack>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "repeat(2,minmax(0,1fr))",
            md: "repeat(4,minmax(0,1fr))",
          },
          gap: 1.5,
        }}
      >
        {(
          [
            ["Newsletters", rows(newsletters).length, "/workspace/newsletters"],
            [
              "ESP accounts",
              rows(infrastructure.accounts).length,
              "/workspace/esp-accounts",
            ],
            [
              "IPs",
              topology.objects.filter((object) => object.kind === "ip").length,
              "/workspace/ips",
            ],
            [
              "IP pools",
              rows(infrastructure.pools).length,
              "/workspace/ip-pools",
            ],
          ] as const
        ).map(([label, value, href]) => (
          <Paper
            key={label}
            component={Link}
            href={href}
            variant="outlined"
            sx={{
              p: 1.75,
              borderRadius: 1,
              textDecoration: "none",
              color: "inherit",
              "&:hover": { borderColor: "primary.main" },
            }}
          >
            <Typography color="text.secondary">{label}</Typography>
            <Typography variant="h2" sx={{ mt: 0.5 }}>
              {value}
            </Typography>
          </Paper>
        ))}
      </Box>
      <Paper
        variant="outlined"
        sx={{ borderRadius: 1, overflow: "hidden", minWidth: 0 }}
      >
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          px={1.5}
          py={1}
          borderBottom={1}
          borderColor="divider"
        >
          <Typography fontWeight={600}>{workspaceName}</Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={view}
            onChange={(_event, value: "map" | "list" | null) => {
              if (value) setView(value);
            }}
            aria-label="Overview view"
          >
            <ToggleButton value="map">Map</ToggleButton>
            <ToggleButton value="list">List</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        <Stack direction={{ xs: "column", md: "row" }} minWidth={0}>
          <Box flex={1} minWidth={0}>
            {view === "map" ? (
              <OverviewGraph
                topology={topology}
                selectedId={selectedId}
                onSelect={select}
              />
            ) : (
              <TableContainer>
                <Table size="small" aria-label="Workspace resources">
                  <TableHead>
                    <TableRow>
                      <TableCell>Name</TableCell>
                      <TableCell>Type</TableCell>
                      <TableCell>ESP account</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {topology.objects
                      .filter(
                        (object) =>
                          object.kind !== "group" &&
                          object.kind !== "workspace",
                      )
                      .map((object) => (
                        <TableRow
                          key={object.id}
                          hover
                          selected={object.id === selectedId}
                        >
                          <TableCell>
                            <Button
                              color="inherit"
                              onClick={() => select(object)}
                              sx={{
                                justifyContent: "flex-start",
                                px: 0,
                                textAlign: "left",
                              }}
                            >
                              {object.name}
                            </Button>
                          </TableCell>
                          <TableCell>{kindLabels[object.kind]}</TableCell>
                          <TableCell>
                            {object.accountName ||
                              (object.kind === "account"
                                ? object.provider
                                : "—")}
                          </TableCell>
                          <TableCell sx={{ textTransform: "capitalize" }}>
                            {object.status || "—"}
                          </TableCell>
                          <TableCell align="right">
                            {object.configurations &&
                            object.configurations.length > 1 ? (
                              <Button
                                onClick={() => select(object)}
                                aria-label={`Configure ${object.name}`}
                              >
                                Configure
                              </Button>
                            ) : (
                              <Button
                                component={Link}
                                href={object.path}
                                aria-label={`Configure ${object.name}`}
                              >
                                Configure
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
          {selected && (
            <Stack
              component="aside"
              aria-label="Selected workspace resource"
              spacing={1.5}
              sx={{
                width: { md: 280 },
                flexShrink: 0,
                p: 2,
                borderLeft: { md: 1 },
                borderTop: { xs: 1, md: 0 },
                borderColor: "divider",
                minWidth: 0,
              }}
            >
              <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="center"
              >
                <Typography color="text.secondary">
                  {kindLabels[selected.kind]}
                </Typography>
                <IconButton
                  size="small"
                  aria-label="Close resource details"
                  onClick={() => setSelectedId(null)}
                >
                  <CloseOutlined fontSize="small" />
                </IconButton>
              </Stack>
              <Typography variant="h4" sx={{ overflowWrap: "anywhere" }}>
                {selected.name}
              </Typography>
              {selected.provider && (
                <Typography>{selected.provider}</Typography>
              )}
              {selected.accountName && (
                <Typography>{selected.accountName}</Typography>
              )}
              {selected.status && (
                <Chip
                  size="small"
                  label={selected.status}
                  variant="outlined"
                  sx={{ alignSelf: "flex-start", textTransform: "capitalize" }}
                />
              )}
              {selected.configurations && selected.configurations.length > 1 ? (
                selected.configurations.map((configuration) => (
                  <Button
                    key={configuration.path}
                    component={Link}
                    href={configuration.path}
                    variant="outlined"
                    endIcon={<ArrowForwardOutlined />}
                  >
                    Configure · {configuration.accountName}
                  </Button>
                ))
              ) : (
                <Button
                  component={Link}
                  href={selected.path}
                  variant="contained"
                  endIcon={<ArrowForwardOutlined />}
                >
                  {selected.kind === "group" ? "Open" : "Configure"}
                </Button>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}

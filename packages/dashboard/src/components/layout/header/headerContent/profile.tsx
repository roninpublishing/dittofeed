import { WorkspacesOutlined } from "@mui/icons-material";
import {
  Autocomplete,
  Avatar,
  Box,
  ButtonBase,
  CardContent,
  ClickAwayListener,
  Grid,
  Paper,
  Popper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
// material-ui
import { useTheme } from "@mui/material/styles";
import axios from "axios";
import { CompletionStatus } from "isomorphic-lib/src/types";
import { useRouter } from "next/router";
import { enqueueSnackbar } from "notistack";
import React, { useRef, useState } from "react";

import { useAppStorePick } from "../../../../lib/appStore";
import isNode from "../../../../lib/isNode";
// project import
import MainCard from "../../../mainCard";
import Transitions from "../../../transitions";
import ProfileTab from "./profile/profileTab";

// ==============================|| HEADER CONTENT - PROFILE ||============================== //

function Profile() {
  const theme = useTheme();
  const path = useRouter();

  const anchorRef = useRef<null | HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const handleToggle = () => {
    setOpen((prevOpen) => !prevOpen);
  };

  const handleClose = (event: MouseEvent | TouchEvent) => {
    if (isNode(event.target) && anchorRef.current?.contains(event.target)) {
      return;
    }
    setOpen(false);
  };

  const iconBackColorOpen = "grey.300";
  const {
    apiBase,
    authMode,
    member,
    memberRoles,
    workspace: workspaceResult,
  } = useAppStorePick([
    "apiBase",
    "authMode",
    "member",
    "memberRoles",
    "workspace",
  ]);
  const workspace =
    workspaceResult.type === CompletionStatus.Successful
      ? workspaceResult.value
      : null;

  const hasPersonalIdentity = member !== null && member.id !== "anonymous";
  const name = hasPersonalIdentity
    ? member.name ?? member.nickname ?? member.email
    : workspace?.name ?? "Workspace";
  const options = React.useMemo(
    () =>
      memberRoles.map((role) => ({
        id: role.workspaceId,
        label: role.workspaceName,
      })),
    [memberRoles],
  );
  const option = React.useMemo(
    () => options.find((o) => o.id === workspace?.id),
    [options, workspace?.id],
  );
  const changeWorkspace = async (workspaceId: string) => {
    if (switchingWorkspace) return;
    setSwitchingWorkspace(true);
    try {
      if (authMode === "google") {
        await axios.post(`${apiBase}/api/account/workspace`, { workspaceId });
        window.location.assign(`${path.basePath}/home`);
      } else if (authMode === "single-tenant" || authMode === "anonymous") {
        await axios.post(`${apiBase}/api/public/single-tenant/workspace`, {
          workspaceId,
        });
        window.location.assign(`${path.basePath}/home`);
      } else {
        await path.push(`/select-workspace?workspaceId=${workspaceId}`);
      }
      setOpen(false);
    } catch {
      enqueueSnackbar("Unable to switch workspace.", { variant: "error" });
    } finally {
      setSwitchingWorkspace(false);
    }
  };

  return (
    <Box sx={{ flexShrink: 0, ml: 0.75 }}>
      <ButtonBase
        sx={{
          p: 0.25,
          bgcolor: open ? iconBackColorOpen : "transparent",
          borderRadius: 1,
          "&:hover": { bgcolor: "secondary.lighter" },
        }}
        aria-label={
          hasPersonalIdentity ? "Open account menu" : "Open workspace menu"
        }
        ref={anchorRef}
        aria-controls={open ? "profile-grow" : undefined}
        aria-haspopup="true"
        onClick={handleToggle}
      >
        <Stack direction="row" spacing={2} alignItems="center" sx={{ p: 0.5 }}>
          <Avatar
            alt={hasPersonalIdentity ? name : "Workspace"}
            sx={{
              width: 32,
              height: 32,
              bgcolor: "primary.lighter",
              color: "primary.main",
            }}
            src={hasPersonalIdentity ? member.picture : undefined}
          >
            {!hasPersonalIdentity ? <WorkspacesOutlined /> : null}
          </Avatar>
          <Typography
            variant="subtitle1"
            noWrap
            title={name}
            sx={{ maxWidth: { xs: 100, md: 160 } }}
          >
            {name}
          </Typography>
        </Stack>
      </ButtonBase>
      <Popper
        placement="bottom-end"
        open={open}
        anchorEl={anchorRef.current}
        transition
        disablePortal
        popperOptions={{
          modifiers: [
            {
              name: "offset",
              options: {
                offset: [0, 9],
              },
            },
          ],
        }}
        onResize={undefined}
        onResizeCapture={undefined}
      >
        {({ TransitionProps }) => (
          <Transitions type="fade" in={open} {...TransitionProps}>
            {open ? (
              <Paper
                sx={{
                  boxShadow: theme.customShadows.z1,
                  width: 290,
                  minWidth: 240,
                  maxWidth: 290,
                  [theme.breakpoints.down("md")]: {
                    maxWidth: 250,
                  },
                }}
              >
                <ClickAwayListener onClickAway={handleClose}>
                  <MainCard elevation={0} border={false}>
                    <CardContent sx={{ px: 2.5, pt: 3 }}>
                      <Grid
                        container
                        justifyContent="space-between"
                        alignItems="center"
                      >
                        <Grid item>
                          <Stack
                            direction="row"
                            spacing={1.25}
                            alignItems="center"
                          >
                            <Avatar
                              alt={hasPersonalIdentity ? name : "Workspace"}
                              src={
                                hasPersonalIdentity ? member.picture : undefined
                              }
                              sx={{
                                width: 32,
                                height: 32,
                                bgcolor: "primary.lighter",
                                color: "primary.main",
                              }}
                            >
                              {!hasPersonalIdentity ? (
                                <WorkspacesOutlined />
                              ) : null}
                            </Avatar>
                            <Stack>
                              <Typography variant="h6">{name}</Typography>
                              {!hasPersonalIdentity ? (
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  {authMode === "single-tenant"
                                    ? "Shared administrator session"
                                    : "Workspace access"}
                                </Typography>
                              ) : null}
                            </Stack>
                          </Stack>
                        </Grid>
                      </Grid>
                    </CardContent>
                    <Box sx={{ p: 1, width: "100%" }}>
                      <Autocomplete
                        value={option}
                        options={options}
                        disableClearable
                        disabled={switchingWorkspace}
                        onChange={(_e, newValue) => {
                          void changeWorkspace(newValue.id);
                        }}
                        renderInput={(params) => (
                          <TextField {...params} label="Current Workspace" />
                        )}
                      />
                    </Box>
                    <ProfileTab />
                  </MainCard>
                </ClickAwayListener>
              </Paper>
            ) : null}
          </Transitions>
        )}
      </Popper>
    </Box>
  );
}

export default Profile;

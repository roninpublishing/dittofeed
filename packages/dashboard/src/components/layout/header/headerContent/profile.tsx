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
import React, { useEffect, useId, useRef, useState } from "react";

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
  const menuId = useId();
  useEffect(() => {
    const closeOnNavigation = () => setOpen(false);
    path.events.on("routeChangeStart", closeOnNavigation);
    return () => path.events.off("routeChangeStart", closeOnNavigation);
  }, [path.events]);
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
    <Box sx={{ flexShrink: 0, ml: "auto" }}>
      <ButtonBase
        sx={{
          p: 0.25,
          minWidth: 32,
          height: 36,
          bgcolor: open ? iconBackColorOpen : "transparent",
          borderRadius: 1,
          "&:hover": { bgcolor: "secondary.lighter" },
          "&.Mui-focusVisible": {
            outline: "2px solid",
            outlineColor: "primary.main",
          },
        }}
        aria-label={
          hasPersonalIdentity ? "Open account menu" : "Open workspace menu"
        }
        ref={anchorRef}
        aria-controls={open ? menuId : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleToggle}
      >
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ px: 0.25 }}
        >
          <Avatar
            alt={hasPersonalIdentity ? name : "Workspace"}
            sx={{
              width: 28,
              height: 28,
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
            sx={{ display: { xs: "none", md: "block" }, maxWidth: 160 }}
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
                offset: [0, 8],
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
                id={menuId}
                role="dialog"
                aria-label={
                  hasPersonalIdentity ? "Account menu" : "Workspace menu"
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setOpen(false);
                    anchorRef.current?.focus();
                  }
                }}
                sx={{
                  boxShadow: theme.customShadows.z1,
                  width: 290,
                  maxWidth: "calc(100vw - 32px)",
                }}
              >
                <ClickAwayListener onClickAway={handleClose}>
                  <MainCard elevation={0} border={false}>
                    <CardContent sx={{ p: 2 }}>
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
                            <Stack sx={{ minWidth: 0 }}>
                              <Typography
                                variant="h6"
                                sx={{ overflowWrap: "anywhere" }}
                              >
                                {name}
                              </Typography>
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
                        size="small"
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

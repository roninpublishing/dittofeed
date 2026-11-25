import { WorkspacesOutlined } from "@mui/icons-material";
import {
  Autocomplete,
  Avatar,
  Box,
  ButtonBase,
  CardContent,
  CircularProgress,
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
import { CompletionStatus } from "isomorphic-lib/src/types";
import { useRouter } from "next/router";
import React, { useEffect, useId, useRef, useState } from "react";

import { useAppStorePick } from "../../../../lib/appStore";
import isNode from "../../../../lib/isNode";
import useWorkspaceSwitch from "../../../../lib/useWorkspaceSwitch";
import { workspaceSelection } from "../../../../lib/workspaceSelection";
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
  const { switchWorkspace, switchingWorkspace } = useWorkspaceSwitch();
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
    authMode,
    member,
    memberRoles,
    workspace: workspaceResult,
  } = useAppStorePick(["authMode", "member", "memberRoles", "workspace"]);
  const workspace =
    workspaceResult.type === CompletionStatus.Successful
      ? workspaceResult.value
      : null;

  const hasPersonalIdentity = member !== null && member.id !== "anonymous";
  const name = hasPersonalIdentity
    ? member.name ?? member.nickname ?? member.email
    : workspace?.name ?? "Workspace";
  const selection = React.useMemo(
    () => workspaceSelection(memberRoles, workspace),
    [memberRoles, workspace],
  );
  const changeWorkspace = async (workspaceId: string, destination: string) => {
    if (await switchWorkspace(workspaceId, destination)) setOpen(false);
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
                      {selection.workspaces.length > 0 && (
                        <Autocomplete
                          value={selection.currentWorkspace ?? null}
                          options={selection.workspaces}
                          disableClearable={Boolean(selection.currentWorkspace)}
                          isOptionEqualToValue={(left, right) =>
                            left.id === right.id
                          }
                          disabled={switchingWorkspace}
                          loading={switchingWorkspace}
                          size="small"
                          onChange={(_event, value) => {
                            if (value && value.id !== workspace?.id)
                              void changeWorkspace(value.id, "/workspace");
                          }}
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              label="Workspace"
                              InputProps={{
                                ...params.InputProps,
                                endAdornment: (
                                  <>
                                    {switchingWorkspace && (
                                      <CircularProgress size={16} />
                                    )}
                                    {params.InputProps.endAdornment}
                                  </>
                                ),
                              }}
                            />
                          )}
                        />
                      )}
                      {selection.newsletters.length > 0 && (
                        <Autocomplete
                          value={selection.currentNewsletter ?? null}
                          options={selection.newsletters}
                          disableClearable={Boolean(
                            selection.currentNewsletter,
                          )}
                          isOptionEqualToValue={(left, right) =>
                            left.id === right.id
                          }
                          disabled={switchingWorkspace}
                          loading={switchingWorkspace}
                          size="small"
                          sx={{ mt: selection.workspaces.length ? 1.5 : 0 }}
                          onChange={(_event, value) => {
                            if (value && value.id !== workspace?.id)
                              void changeWorkspace(value.id, "/home");
                          }}
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              label="Newsletter"
                              InputProps={{
                                ...params.InputProps,
                                endAdornment: (
                                  <>
                                    {switchingWorkspace && (
                                      <CircularProgress size={16} />
                                    )}
                                    {params.InputProps.endAdornment}
                                  </>
                                ),
                              }}
                            />
                          )}
                        />
                      )}
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

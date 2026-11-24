// material-ui
import { Lock, Search as SearchIcon } from "@mui/icons-material";
import LoadingButton from "@mui/lab/LoadingButton";
import {
  Box,
  ButtonBase,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  ListSubheader,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import React, { lazy, Suspense } from "react";

import { useAppStorePick } from "../../../lib/appStore";
import { GitBranchIcon } from "../../gitBranchIcon";
import ReturnLink from "../../returnNavigation/ReturnLink";
import Profile from "./headerContent/profile";

const CommitAndPush = lazy(() => import("../../commitAndPush"));

function BranchMenuItemContents({
  item,
  icon,
}: {
  item: string;
  icon?: React.ReactNode;
}) {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      {icon ?? <GitBranchIcon color="action" />}
      <Box sx={{ fontSize: ".75rem" }}>{item}</Box>
    </Stack>
  );
}

const newBranch = "new-branch" as const;
const branchName = "maxgurewitz/my-feature-branch";

function BranchSelect() {
  const { enableSourceControl, sourceControlProvider } = useAppStorePick([
    "enableSourceControl",
    "sourceControlProvider",
  ]);

  const [branch, setBranch] = React.useState("main");
  const [newBranchIsOpen, setNewBranchIsOpen] = React.useState(false);
  const [newBranchIsLoading, setNewBranchIsLoading] = React.useState(false);
  const [availableBranches, setAvailableBranches] = React.useState<string[]>(
    [],
  );

  if (!enableSourceControl || !sourceControlProvider) {
    return null;
  }

  const handleChange = (event: SelectChangeEvent) => {
    if (event.target.value === newBranch) {
      setNewBranchIsOpen(true);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    setBranch(event.target.value as string);
  };

  const handleCreateNewBranch = () => {
    setNewBranchIsLoading(true);
    setTimeout(() => {
      setAvailableBranches([branchName]);
      setNewBranchIsOpen(false);
      setBranch(branchName);
      setNewBranchIsLoading(false);
    }, 200);
  };

  // maxgurewitz/my-feature-branch
  return (
    <>
      <Select
        value={branch}
        sx={{
          fontSize: ".75rem",
          ml: 1,
          mr: 1,
          height: "100%",
          "& .MuiSelect-select": {
            pt: 1,
            pb: 1,
            height: "100%",
          },
        }}
        onChange={handleChange}
        renderValue={(value) => (
          <Stack spacing={1} direction="row" alignItems="center">
            {value === "main" ? (
              <Lock color="action" />
            ) : (
              <GitBranchIcon color="action" />
            )}
            <Box>{value}</Box>
          </Stack>
        )}
      >
        <MenuItem value="main">
          <BranchMenuItemContents item="main" icon={<Lock color="action" />} />
        </MenuItem>
        <Divider />
        <ListSubheader sx={{ fontSize: ".75rem" }}>your branches</ListSubheader>
        <MenuItem value={newBranch}>
          <BranchMenuItemContents item="New Branch" />
        </MenuItem>
        {availableBranches.map((ab) => (
          <MenuItem value={ab} key={ab}>
            <BranchMenuItemContents item={ab} />
          </MenuItem>
        ))}
      </Select>

      <Dialog
        fullWidth
        maxWidth="sm"
        open={newBranchIsOpen}
        onClose={() => {
          setNewBranchIsOpen(false);
        }}
      >
        <DialogTitle>
          <Typography variant="h5">Create a new branch</Typography>
        </DialogTitle>

        <DialogContent>
          <Stack direction="column" spacing={1} alignItems="center">
            <Box sx={{ width: "100%" }}>
              Create a new branch based off of the main branch
            </Box>
            <TextField defaultValue="maxgurewitz/" sx={{ width: "100%" }} />
            <Typography variant="caption" sx={{ width: "100%" }}>
              Your branch will be created locally. You will need to commit and
              push it to see it in GitHub.
            </Typography>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="right"
              sx={{ width: "100%" }}
            >
              <LoadingButton
                loading={newBranchIsLoading}
                variant="contained"
                sx={{ textTransform: "none" }}
                onClick={handleCreateNewBranch}
              >
                Create new branch
              </LoadingButton>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}

const oldConfig = `definition:
  entryNode:
    segment: 'Users created within the last 30 minutes'
    child: 1
  nodes:
    - id: 1
      type: 'MessageNode'
      child: 2
      variant:
        type: 'Email'
        template: 'Welcome'
    - id: 2
      type: 'DelayNode'
      child: 3
      variant:
        type: 'Second'
        seconds: 604800
    - id: 3
      type: 'MessageNode'
      child: 4
      variant:
        type: 'Email'
        template: '10 Reasons to Upgrade'
    - id: 4
      type: 'ExitNode'
`;

const newConfig = `definition:
  entryNode:
    segment: 'Users created within the last 30 minutes'
    child: 1
  nodes:
    - id: 1
      type: 'MessageNode'
      child: 2
      variant:
        type: 'Email'
        template: 'Welcome'
    - id: 2
      type: 'ExitNode'
`;

function GitActionsSelect() {
  const theme = useTheme();
  const { enableSourceControl, sourceControlProvider } = useAppStorePick([
    "enableSourceControl",
    "sourceControlProvider",
  ]);
  const [isDiffOpen, setDiffOpen] = React.useState(false);
  const handleClose = () => setDiffOpen(false);

  if (!enableSourceControl || !sourceControlProvider) {
    return null;
  }
  const oldText = oldConfig;
  const newText = newConfig;

  return (
    <>
      <Select
        value=""
        displayEmpty
        sx={{
          minWidth: 150,
          fontSize: ".75rem",
          backgroundColor: theme.palette.primary.main,
          color: theme.palette.primary.contrastText,
          ml: 1,
          mr: 1,
          "& svg": {
            color: theme.palette.primary.contrastText,
          },
          height: "100%",
          "& .MuiSelect-select": {
            pt: 1,
            pb: 1,
            height: "100%",
          },
        }}
        onChange={() => setDiffOpen(true)}
        renderValue={() => (
          <Stack spacing={1} direction="row" alignItems="center">
            <GitBranchIcon />
            <Box>Actions</Box>
          </Stack>
        )}
      >
        <MenuItem value="commit-and-push">Commit and Push</MenuItem>
      </Select>
      <Dialog fullWidth maxWidth="md" open={isDiffOpen} onClose={handleClose}>
        <Suspense>
          <CommitAndPush
            branchName={branchName}
            diffs={[
              {
                oldFileName: "Onboarding Journey",
                newFileName: "Onboarding Journey",
                newText,
                oldText,
              },
            ]}
            onCommit={handleClose}
          />
        </Suspense>
      </Dialog>
    </>
  );
}

function HeaderContent() {
  const { setCommandPaletteOpen } = useAppStorePick(["setCommandPaletteOpen"]);

  return (
    <>
      <BranchSelect />
      <ButtonBase
        onClick={() => setCommandPaletteOpen(true)}
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        aria-haspopup="dialog"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          color: "text.secondary",
          bgcolor: "grey.100",
          borderRadius: 1,
          px: { xs: 1, sm: 1.5 },
          height: 32,
          flexShrink: 0,
          cursor: "pointer",
          "&:hover": {
            bgcolor: "grey.200",
          },
          "&.Mui-focusVisible": {
            outline: "2px solid",
            outlineColor: "primary.main",
          },
        }}
        title="Search (⌘K / Ctrl+K)"
      >
        <SearchIcon sx={{ fontSize: 18 }} />
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            display: { xs: "none", sm: "block" },
          }}
        >
          Search
        </Typography>
        <Box
          component="kbd"
          sx={{
            display: { xs: "none", md: "flex" },
            alignItems: "center",
            gap: 0.25,
            px: 0.75,
            py: 0.25,
            borderRadius: 0.5,
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            fontSize: "0.7rem",
            fontFamily: "inherit",
            color: "text.secondary",
          }}
        >
          <span>⌘</span>
          <span>K</span>
        </Box>
      </ButtonBase>
      <Box
        sx={{
          minWidth: 0,
          maxWidth: { xs: 120, sm: 200, md: 240 },
          "& .MuiButton-root": {
            ml: 0,
            minWidth: { xs: 32, sm: 64 },
            maxWidth: "100%",
            px: { xs: 0.75, sm: 1.5 },
          },
          "& .MuiTypography-root": {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          },
        }}
      >
        <ReturnLink />
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0 }} />
      <GitActionsSelect />

      <Profile />
    </>
  );
}

export default HeaderContent;

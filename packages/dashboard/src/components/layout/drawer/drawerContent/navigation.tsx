// material-ui
import { ArrowBackIos } from "@mui/icons-material";
import { Box, IconButton, Stack, Typography } from "@mui/material";
import { useContext } from "react";

import { useAppStorePick } from "../../../../lib/appStore";
import Link from "../../../workspace/navigation";
import { LayoutContext } from "../../context";
import MinimalNavGroup from "./navigation/minimalNavGroup";
import NavGroup from "./navigation/navGroup";

// ==============================|| DRAWER CONTENT - NAVIGATION ||============================== //

function Navigation() {
  const { features } = useAppStorePick(["features"]);
  const layout = useContext(LayoutContext);
  const items = layout?.items;
  const title = layout?.pageTitle;
  const backLink = layout?.backLink;
  const navigationRenderer = layout?.navigationRenderer;
  const isMinimal = navigationRenderer === "minimal";

  const navGroups = items
    ? items.flatMap((item) => {
        if (features.WhiteLabel && item.id === "support") {
          return [];
        }
        switch (item.type) {
          case "group":
            return isMinimal ? (
              <MinimalNavGroup key={item.id} item={item} />
            ) : (
              <NavGroup key={item.id} item={item} />
            );
          default:
            return (
              <Typography
                key={item.id}
                variant="h6"
                color="error"
                align="center"
              >
                Fix - Navigation Group
              </Typography>
            );
        }
      })
    : null;

  return (
    <Box sx={{ py: 1, px: 1 }}>
      {title ? (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ px: 1, pb: 1, alignItems: "center" }}
        >
          {backLink ? (
            <IconButton
              component={Link}
              href={backLink}
              aria-label="Back"
              size="small"
            >
              <ArrowBackIos fontSize="inherit" />
            </IconButton>
          ) : null}
          <Typography variant="subtitle1" sx={{ minWidth: 0 }}>
            {title}
          </Typography>
        </Stack>
      ) : null}
      {navGroups}
    </Box>
  );
}

export default Navigation;

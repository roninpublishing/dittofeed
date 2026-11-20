import { Box, Stack, Typography } from "@mui/material";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { WhiteLabelFeatureConfig } from "isomorphic-lib/src/types";
import { useMemo } from "react";

import { useAppStorePick } from "../../../../lib/appStore";

// ==============================|| DRAWER CONTENT - NAVIGATION CARD ||============================== //

function NavCard() {
  const { features } = useAppStorePick(["features"]);
  const whiteLabelConfig = useMemo(() => {
    if (!features.WhiteLabel) {
      return null;
    }
    const result = schemaValidateWithErr(
      features.WhiteLabel,
      WhiteLabelFeatureConfig,
    );
    if (result.isErr()) {
      return null;
    }
    return result.value;
  }, [features.WhiteLabel]);

  if (whiteLabelConfig && !whiteLabelConfig.navCardTitle) {
    return null;
  }
  const title = whiteLabelConfig?.navCardTitle ?? "Ronin Publishing";
  const description = whiteLabelConfig?.navCardDescription;

  return (
    <Stack
      alignItems="flex-start"
      spacing={1}
      sx={{
        mx: 3,
        mt: 3,
        mb: 1,
        pb: 3,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      {whiteLabelConfig ? (
        <>
          {whiteLabelConfig.navCardIcon ? (
            <Box
              component="img"
              src={whiteLabelConfig.navCardIcon}
              alt=""
              sx={{ height: 32, maxWidth: "100%", objectFit: "contain" }}
            />
          ) : null}
          <Typography
            variant="h5"
            sx={{
              overflowWrap: "break-word",
              hyphens: "auto",
              whiteSpace: "pre-wrap",
              width: "100%",
            }}
          >
            {title}
          </Typography>
        </>
      ) : (
        <Box
          component="img"
          src="/dashboard/branding/ronin/ronin-logo.png"
          alt={title}
          sx={{
            display: "block",
            width: 208,
            maxWidth: "100%",
            height: "auto",
          }}
        />
      )}
      {description ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            overflowWrap: "break-word",
            hyphens: "auto",
            width: "100%",
            whiteSpace: "pre-wrap",
          }}
        >
          {description}
        </Typography>
      ) : null}
    </Stack>
  );
}

export default NavCard;

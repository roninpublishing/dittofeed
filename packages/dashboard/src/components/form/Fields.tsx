import { Stack } from "@mui/material";
import React from "react";

import FieldSection from "./FieldSection";
import { FieldsProps } from "./types";

function Fields({ sections, children, disableChildStyling }: FieldsProps) {
  return (
    <Stack
      sx={{
        backgroundColor: "background.paper",
        borderRadius: 1,
        px: { xs: 2, sm: 3 },
        py: 1,
        marginTop: 2,
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "divider",
      }}
    >
      {sections.map((section) => (
        <FieldSection key={section.id} {...section} />
      ))}
      {children && !disableChildStyling ? (
        <Stack
          sx={{
            borderTopWidth: "1px",
            borderTopStyle: "solid",
            borderTopColor: "grey.200",
            pt: 2,
            mt: 2,
            display: "flex",
            justifyContent: "end",
          }}
        >
          {children}
        </Stack>
      ) : null}
      {children && disableChildStyling ? children : null}
    </Stack>
  );
}

export default Fields;

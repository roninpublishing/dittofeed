import { Stack, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import React from "react";

import Field from "./Field";
import { FieldGroupProps } from "./types";

const FieldGroupName = styled(Typography)(({ theme }) => ({
  [theme.breakpoints.up("sm")]: {
    flex: "0 0 28%",
    maxWidth: 240,
    minWidth: 160,
  },
}));

function FieldGroup({ name, fields, children }: FieldGroupProps) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
      <FieldGroupName mt={{ sm: 1 }} fontWeight={500}>
        {name}
      </FieldGroupName>
      <Stack spacing={2} flex={1} minWidth={0}>
        {fields.map((field) => (
          <Field key={field.id} {...field} />
        ))}
        {children}
      </Stack>
    </Stack>
  );
}

export default FieldGroup;

import { FormatRegistry } from "@sinclair/typebox";
import { parseISO } from "date-fns";
import { isFloat, isNaturalNumber } from "isomorphic-lib/src/strings";
import { validate as validateUuid } from "uuid";

export function registerFormats() {
  FormatRegistry.Set("naturalNumber", isNaturalNumber);
  FormatRegistry.Set("float", isFloat);
  FormatRegistry.Set("uuid", validateUuid);
  FormatRegistry.Set("date-time", (value) =>
    /^\d{4}-\d{2}-\d{2}[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
    Number.isFinite(parseISO(value.toUpperCase()).getTime()),
  );
}

import { FormatRegistry } from "@sinclair/typebox";
import { isFloat, isNaturalNumber } from "isomorphic-lib/src/strings";
import { validate as validateUuid } from "uuid";

export function registerFormats() {
  FormatRegistry.Set("naturalNumber", isNaturalNumber);
  FormatRegistry.Set("float", isFloat);
  FormatRegistry.Set("uuid", validateUuid);
}

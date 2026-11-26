import { TSchema } from "@sinclair/typebox";

import { PublicationAutomationConditionValue } from "./publications";
import { LowCodeEmailJsonBody } from "./types";

export const TYPE_REFS: TSchema[] = [
  LowCodeEmailJsonBody,
  PublicationAutomationConditionValue,
];

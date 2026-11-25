import {
  PublicationAutomationCondition,
  PublicationAutomationConditionValue,
  PublicationAutomationDefinition,
} from "isomorphic-lib/src/publications";
import { schemaValidate } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { createHash } from "crypto";
import deepEqual from "fast-deep-equal";
import { v5 as uuidv5 } from "uuid";

export { PublicationAutomationDefinition } from "isomorphic-lib/src/publications";

export class PublicationAutomationError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "PublicationAutomationError";
    Object.setPrototypeOf(this, PublicationAutomationError.prototype);
  }
}

/** Strict ISO calendar datetime with explicit timezone; retain fractional precision. */
function datetime(value: unknown): { seconds: number; fraction: string } {
  if (typeof value !== "string")
    throw new PublicationAutomationError("Datetime conditions require ISO datetime strings");
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts)
    throw new PublicationAutomationError("Datetime conditions require ISO datetimes with a timezone");
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (
    month < 1 || month > 12 || day < 1 || day > days ||
    Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59 ||
    (parts[8] !== "Z" && (Number(parts[10]) > 23 || Number(parts[11]) > 59))
  )
    throw new PublicationAutomationError("Datetime condition contains an invalid calendar datetime");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new PublicationAutomationError("Datetime condition contains an invalid datetime");
  return { seconds: Math.floor(timestamp / 1000), fraction: (parts[7] ?? "").replace(/0+$/, "") };
}

function compareDatetimes(left: unknown, right: unknown): number {
  const a = datetime(left);
  const b = datetime(right);
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  return a.fraction === b.fraction ? 0 : a.fraction < b.fraction ? -1 : 1;
}

function validateCondition(condition: PublicationAutomationCondition): void {
  if (schemaValidate(condition, PublicationAutomationCondition).isErr())
    throw new PublicationAutomationError("Invalid automation condition operator or operand");
  if (condition.operator === "before" || condition.operator === "after")
    datetime(condition.value);
}

/** Shared configuration boundary; stored snapshots are validated again before execution. */
export function validatePublicationAutomationDefinition(
  value: unknown,
): PublicationAutomationDefinition {
  const result = schemaValidate(value, PublicationAutomationDefinition);
  if (result.isErr())
    throw new PublicationAutomationError("Invalid publication automation definition");
  for (const condition of result.value.source.conditions ?? [])
    if (condition.operator === "before" || condition.operator === "after")
      datetime(condition.value);
  return result.value;
}

function conditionMatches(condition: PublicationAutomationCondition, value: unknown): boolean {
  // Legacy exists treats null as absent; explicit JSON null remains comparable by
  // equality/membership. No negative comparison can match an undefined field.
  if (condition.operator === "exists") return value !== undefined && value !== null;
  if (condition.operator === "notExists") return value === undefined || value === null;
  if (value === undefined) return false;
  if (
    (condition.operator === "equals" || condition.operator === "notEquals" ||
      condition.operator === "in" || condition.operator === "notIn") &&
    schemaValidate(value, PublicationAutomationConditionValue).isErr()
  )
    throw new PublicationAutomationError("Equality and membership conditions require JSON field values");
  switch (condition.operator) {
    case "equals": return deepEqual(value, condition.value);
    case "notEquals": return !deepEqual(value, condition.value);
    case "in": return condition.value.some((candidate) => deepEqual(value, candidate));
    case "notIn": return !condition.value.some((candidate) => deepEqual(value, candidate));
    case "contains":
    case "notContains": {
      let contained: boolean;
      if (Array.isArray(value)) {
        if (schemaValidate(value, PublicationAutomationConditionValue).isErr())
          throw new PublicationAutomationError("Array containment requires JSON field values");
        contained = value.some((candidate) => deepEqual(candidate, condition.value));
      } else if (typeof value === "string") {
        if (typeof condition.value !== "string")
          throw new PublicationAutomationError("String containment requires a string operand");
        contained = value.includes(condition.value);
      } else {
        throw new PublicationAutomationError("Containment requires a string or array field value");
      }
      return condition.operator === "contains" ? contained : !contained;
    }
    case "startsWith":
    case "endsWith": {
      if (typeof value !== "string")
        throw new PublicationAutomationError("String conditions require string field values");
      switch (condition.operator) {
        case "startsWith": return value.startsWith(condition.value);
        case "endsWith": return value.endsWith(condition.value);
      }
      break;
    }
    case "greaterThan":
    case "greaterThanOrEqual":
    case "lessThan":
    case "lessThanOrEqual": {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new PublicationAutomationError("Numeric conditions require finite numeric field values");
      switch (condition.operator) {
        case "greaterThan": return value > condition.value;
        case "greaterThanOrEqual": return value >= condition.value;
        case "lessThan": return value < condition.value;
        case "lessThanOrEqual": return value <= condition.value;
      }
      break;
    }
    case "before": return compareDatetimes(value, condition.value) < 0;
    case "after": return compareDatetimes(value, condition.value) > 0;
  }
  throw new PublicationAutomationError("Unknown automation condition operator");
}

/** Dot paths only; never evaluate expressions or traverse prototype members. */
export function automationValue(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (
      ["__proto__", "prototype", "constructor"].includes(part) ||
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, part)
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function automationMatches(
  definition: PublicationAutomationDefinition,
  event: Record<string, unknown>,
  traits: Record<string, unknown>,
): boolean {
  const source = definition.source;
  if (source.conditionMatch !== undefined && source.conditionMatch !== "all" && source.conditionMatch !== "any")
    throw new PublicationAutomationError("Invalid automation condition grouping");
  const conditions = source.conditions ?? [];
  // Validate every configured operand even when the trigger or an earlier condition
  // would short-circuit; malformed rules must never silently behave as non-matches.
  for (const condition of conditions) validateCondition(condition);
  if (
    event.type !== source.eventType ||
    (source.event !== undefined && event.event !== source.event) ||
    (source.link && automationValue(event, source.link.path) !== source.link.equals)
  ) return false;
  const any = source.conditionMatch === "any";
  let matched = !any || conditions.length === 0;
  for (const condition of conditions) {
    const result = conditionMatches(condition, automationValue(
      condition.source === "traits" ? traits : event,
      condition.path,
    ));
    matched = any ? matched || result : matched && result;
  }
  return matched;
}

export function automationMappedTraits(
  definition: PublicationAutomationDefinition,
  event: Record<string, unknown>,
  traits: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const mapping of definition.destination.fieldMappings ?? []) {
    if (
      !mapping.overwrite &&
      existing[mapping.destination] !== undefined &&
      existing[mapping.destination] !== null
    )
      continue;
    const value = automationValue(
      mapping.source === "traits" ? traits : event,
      mapping.path,
    );
    if (value !== undefined) mapped[mapping.destination] = value;
  }
  return mapped;
}

export function automationDedupeKey(
  definition: PublicationAutomationDefinition,
  userId: string,
  eventId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        definition.oncePerSubscriber !== false ? "subscriber" : "event",
        definition.oncePerSubscriber !== false ? userId : eventId,
      ]),
    )
    .digest("hex");
}

export function automationNativeId(actionId: string, step: string): string {
  return uuidv5(step, actionId);
}

export function automationLineage(event: Record<string, unknown>): string[] {
  const lineage = automationValue(
    event,
    "context.publicationAutomation.lineage",
  );
  return Array.isArray(lineage)
    ? lineage
        .filter((value): value is string => typeof value === "string")
        .slice(0, 33)
    : [];
}

import { PublicationAutomationDefinition } from "isomorphic-lib/src/publications";
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
  return (
    event.type === source.eventType &&
    (source.event === undefined || event.event === source.event) &&
    (!source.link ||
      automationValue(event, source.link.path) === source.link.equals) &&
    (source.conditions ?? []).every((condition) => {
      const value = automationValue(
        condition.source === "traits" ? traits : event,
        condition.path,
      );
      return condition.operator === "exists"
        ? value !== undefined && value !== null
        : value !== undefined && deepEqual(value, condition.value);
    })
  );
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

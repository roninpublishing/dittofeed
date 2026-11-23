import { InternalEventType } from "../types";

// Opens and clicks are observations, not proof of a human action. Actual event
// time, never an independently supplied property, wins.
export function normalizeEngagementProperties(
  event: string,
  timestamp: string,
  properties: Record<string, unknown> = {},
): Record<string, unknown> {
  if (
    event !== InternalEventType.EmailClicked &&
    event !== InternalEventType.EmailOpened
  ) return properties;
  return {
    ...properties,
    [event === InternalEventType.EmailClicked ? "clickedAt" : "openedAt"]:
      new Date(timestamp).toISOString(),
    evidenceSource: properties.evidenceSource ?? "native_ingestion",
    engagementClassification: "observed_unqualified",
  };
}

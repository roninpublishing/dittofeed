import { randomUUID } from "crypto";

import {
  automationDedupeKey,
  automationLineage,
  automationMappedTraits,
  automationMatches,
  automationNativeId,
  automationValue,
  PublicationAutomationDefinition,
} from "./publicationAutomationDefinition";

const definition: PublicationAutomationDefinition = {
  source: {
    eventType: "track",
    event: "DFEmailClicked",
    link: { path: "properties.url", equals: "https://b.example.com/join" },
    conditions: [
      {
        source: "event",
        path: "properties.eligible",
        operator: "equals",
        value: true,
      },
    ],
  },
  destination: {
    match: { field: "email", source: "traits", path: "email" },
    createIfMissing: true,
    subscribe: true,
    fieldMappings: [
      { source: "traits", path: "name", destination: "name" },
      {
        source: "event",
        path: "properties.offer",
        destination: "signup_offer",
      },
    ],
  },
};

describe("publication automation contracts", () => {
  it("matches only the configured native type, exact link and all conditions", () => {
    const event = {
      type: "track",
      event: "DFEmailClicked",
      properties: { url: "https://b.example.com/join", eligible: true },
    };
    expect(automationMatches(definition, event, {})).toBe(true);
    expect(
      automationMatches(definition, { ...event, type: "identify" }, {}),
    ).toBe(false);
    expect(
      automationMatches(
        definition,
        {
          ...event,
          properties: {
            ...event.properties,
            url: "https://b.example.com/join?extra=1",
          },
        },
        {},
      ),
    ).toBe(false);
    expect(
      automationMatches(
        definition,
        { ...event, properties: { ...event.properties, eligible: false } },
        {},
      ),
    ).toBe(false);
  });

  it("copies only mapped fields without implicit profile synchronization or overwrite", () => {
    const source = {
      email: "source@example.com",
      name: "Source name",
      private_data: "never copy",
    };
    const destination = { name: "Destination name", local_flag: true };
    expect(
      automationMappedTraits(
        definition,
        { properties: { offer: "blue" } },
        source,
        destination,
      ),
    ).toEqual({ signup_offer: "blue" });
    expect(source.name).toBe("Source name");
    expect(destination).toEqual({ name: "Destination name", local_flag: true });
    expect(
      automationMappedTraits(
        {
          ...definition,
          destination: {
            ...definition.destination,
            fieldMappings: [
              {
                source: "traits",
                path: "name",
                destination: "name",
                overwrite: true,
              },
            ],
          },
        },
        {},
        source,
        destination,
      ),
    ).toEqual({ name: "Source name" });
  });

  it("deduplicates repeated clicks per source subscriber by default and events when configured", () => {
    expect(automationDedupeKey(definition, "source-id", "click-1")).toBe(
      automationDedupeKey(definition, "source-id", "click-2"),
    );
    expect(automationDedupeKey(definition, "other-id", "click-1")).not.toBe(
      automationDedupeKey(definition, "source-id", "click-1"),
    );
    expect(
      automationDedupeKey(
        { ...definition, oncePerSubscriber: false },
        "source-id",
        "click-1",
      ),
    ).not.toBe(
      automationDedupeKey(
        { ...definition, oncePerSubscriber: false },
        "source-id",
        "click-2",
      ),
    );
    const action = randomUUID();
    expect(automationNativeId(action, "welcome")).toBe(
      automationNativeId(action, "welcome"),
    );
    expect(automationNativeId(action, "welcome")).not.toBe(
      automationNativeId(action, "subscribe"),
    );
  });

  it("bounds cycle lineage and never traverses prototypes", () => {
    expect(
      automationLineage({
        context: { publicationAutomation: { lineage: ["a", "b", "a"] } },
      }),
    ).toEqual(["a", "b", "a"]);
    expect(
      automationLineage({
        context: { publicationAutomation: { lineage: Array(100).fill("a") } },
      }),
    ).toHaveLength(33);
    expect(automationValue({}, "constructor.name")).toBeUndefined();
    expect(automationValue({ profile: { name: "name" } }, "profile.name")).toBe(
      "name",
    );
  });
});

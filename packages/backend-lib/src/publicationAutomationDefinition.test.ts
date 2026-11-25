import { FormatRegistry } from "@sinclair/typebox";
import { randomUUID } from "crypto";

import {
  automationDedupeKey,
  automationLineage,
  automationMappedTraits,
  automationMatches,
  automationNativeId,
  automationValue,
  PublicationAutomationDefinition,
  PublicationAutomationError,
  validatePublicationAutomationDefinition,
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

describe("publication automation condition operators", () => {
  function rule(operator: string, value?: unknown, includeValue = true): PublicationAutomationDefinition {
    return {
      ...structuredClone(definition),
      source: {
        eventType: "track",
        conditions: [{
          source: "event", path: "properties.value", operator,
          ...(includeValue ? { value } : {}),
        }],
      },
    } as PublicationAutomationDefinition;
  }

  function matches(operator: string, actual: unknown, value?: unknown, includeValue = true): boolean {
    return automationMatches(rule(operator, value, includeValue), {
      type: "track", properties: { value: actual },
    }, {});
  }

  it.each([
    ["equals", { a: 1, b: [true, null] }, { b: [true, null], a: 1 }, true],
    ["equals", [1, 2], [2, 1], false],
    ["equals", "1", 1, false],
    ["equals", null, null, true],
    ["notEquals", "News", "news", true],
    ["notEquals", { a: 1 }, { a: 1 }, false],
    ["contains", "News [A].*", "[A].*", true],
    ["contains", "News", "news", false],
    ["contains", " x ", " x ", true],
    ["notContains", "News", "news", true],
    ["notContains", "News", "New", false],
    ["contains", ["subscriber", "VIP"], "VIP", true],
    ["contains", ["subscriber", "VIP"], "vip", false],
    ["contains", ["newsletter"], "news", false],
    ["contains", [{ name: "VIP", flags: [true, null] }], { flags: [true, null], name: "VIP" }, true],
    ["contains", [[1, 2], [3]], [1, 2], true],
    ["contains", [[1, 2]], [2, 1], false],
    ["contains", [1, false, null], false, true],
    ["contains", [1, false, null], null, true],
    ["contains", [1], "1", false],
    ["contains", [], "VIP", false],
    ["notContains", ["subscriber", "VIP"], "VIP", false],
    ["notContains", ["subscriber", "VIP"], "vip", true],
    ["notContains", [{ name: "VIP", flags: [true, null] }], { flags: [true, null], name: "VIP" }, false],
    ["notContains", [[1, 2]], [2, 1], true],
    ["notContains", [], { tag: "VIP" }, true],
    ["startsWith", "Newsletter", "News", true],
    ["startsWith", " Newsletter", "News", false],
    ["endsWith", "Newsletter", "letter", true],
    ["endsWith", "Newsletter ", "letter", false],
    ["in", { a: 1, b: 2 }, [null, { b: 2, a: 1 }], true],
    ["in", [1, 2], [[1, 2], [3]], true],
    ["in", [1, 2], [1, 2], false],
    ["in", "1", [1], false],
    ["notIn", "News", ["news"], true],
    ["notIn", [1, 2], [[1, 2]], false],
    ["greaterThan", 2, 1, true],
    ["greaterThan", 1, 1, false],
    ["greaterThanOrEqual", 1, 1, true],
    ["lessThan", -2, -1, true],
    ["lessThan", 1, 1, false],
    ["lessThanOrEqual", 1, 1, true],
    ["before", "2024-02-29T00:00:00Z", "2024-03-01T00:00:00Z", true],
    ["after", "2024-03-01T01:00:01+01:00", "2024-03-01T00:00:00Z", true],
    ["before", "2024-03-01T01:00:00+01:00", "2024-03-01T00:00:00Z", false],
    ["after", "2024-03-01T00:00:00.000001Z", "2024-03-01T00:00:00.0000009Z", true],
    ["after", "2024-03-01T00:00:00.1000Z", "2024-03-01T00:00:00.1Z", false],
  ])("%s uses typed, literal operands (%#)", (operator, actual, value, expected) => {
    expect(matches(operator as string, actual, value)).toBe(expected);
  });

  it("validates structured containment operands and reads actual subscriber tag arrays", () => {
    const config = rule("contains", { tag: "VIP", active: true });
    const condition = config.source.conditions?.[0];
    if (!condition) throw new Error("Missing configured condition");
    condition.source = "traits";
    condition.path = "tags";
    expect(() => validatePublicationAutomationDefinition(config)).not.toThrow();
    expect(automationMatches(config, { type: "track" }, {
      tags: [{ active: true, tag: "VIP" }],
    })).toBe(true);
    condition.operator = "notContains";
    expect(() => validatePublicationAutomationDefinition(config)).not.toThrow();
    expect(automationMatches(config, { type: "track" }, {})).toBe(false);
    expect(automationMatches(config, { type: "track" }, { tags: [] })).toBe(true);
  });

  it("preserves exists semantics and permits valueless existence conditions", () => {
    for (const actual of [false, 0, "", [], {}])
      expect(matches("exists", actual, undefined, false)).toBe(true);
    for (const actual of [undefined, null]) {
      expect(matches("exists", actual, undefined, false)).toBe(false);
      expect(matches("notExists", actual, undefined, false)).toBe(true);
    }
    expect(matches("notExists", false, undefined, false)).toBe(false);
    expect(matches("exists", true, "legacy ignored value")).toBe(true);
    expect(validatePublicationAutomationDefinition(rule("exists", undefined, false))).toBeDefined();
    expect(validatePublicationAutomationDefinition(rule("notExists", undefined, false))).toBeDefined();
  });

  it.each([
    ["equals", "x"], ["notEquals", "x"], ["contains", "x"],
    ["notContains", "x"], ["startsWith", "x"], ["endsWith", "x"],
    ["in", ["x"]], ["notIn", ["x"]], ["greaterThan", 0],
    ["greaterThanOrEqual", 0], ["lessThan", 0], ["lessThanOrEqual", 0],
    ["before", "2024-01-01T00:00:00Z"], ["after", "2024-01-01T00:00:00Z"],
  ])("%s fails closed on missing fields", (operator, value) => {
    expect(automationMatches(rule(operator as string, value), { type: "track" }, {})).toBe(false);
  });

  it("retains legacy AND, supports any/all and treats empty groups as unrestricted", () => {
    const config = rule("equals", 1);
    const conditions = config.source.conditions!;
    conditions.push({ source: "traits", path: "eligible", operator: "equals", value: true });
    const event = { type: "track", properties: { value: 1 } };
    expect(automationMatches(config, event, {})).toBe(false);
    expect(automationMatches(config, event, { eligible: true })).toBe(true);
    config.source.conditionMatch = "all";
    expect(automationMatches(config, event, {})).toBe(false);
    config.source.conditionMatch = "any";
    expect(automationMatches(config, event, {})).toBe(true);
    expect(automationMatches(config, { type: "track" }, {})).toBe(false);
    expect(automationMatches(config, { ...event, type: "identify" }, { eligible: true })).toBe(false);
    config.source.conditions = [];
    for (const grouping of ["all", "any"] as const) {
      config.source.conditionMatch = grouping;
      expect(automationMatches(config, event, {})).toBe(true);
      delete config.source.conditions;
      expect(automationMatches(config, event, {})).toBe(true);
    }
  });

  it.each([
    ["unknown", true], ["equals", undefined], ["equals", NaN],
    ["equals", { invalid: undefined }], ["notEquals", Infinity],
    ["contains", Infinity], ["notContains", undefined], ["startsWith", ["x"]], ["endsWith", false],
    ["in", "x"], ["in", []], ["notIn", Array(101).fill("x")],
    ["in", [NaN]], ["in", [undefined]], ["greaterThan", "1"],
    ["greaterThanOrEqual", NaN], ["lessThan", Infinity], ["lessThanOrEqual", null],
    ["before", "2024-02-30T00:00:00Z"], ["after", "2023-02-29T00:00:00Z"],
    ["before", "2024-01-01"], ["before", "2024-01-01T00:00:00"],
    ["before", "2024-01-01T24:00:00Z"], ["before", "2024-01-01T00:00:60Z"],
    ["before", "2024-01-01T00:00:00+24:00"], ["after", 1704067200000],
  ])("%s rejects invalid configured operands at both boundaries (%#)", (operator, value) => {
    const config = rule(operator as string, value);
    expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
    expect(() => automationMatches(config, { type: "track" }, {})).toThrow(PublicationAutomationError);
    // A mismatching trigger must not hide an invalid configuration.
    expect(() => automationMatches(config, { type: "identify" }, {})).toThrow(PublicationAutomationError);
  });

  it.each([
    ["contains", 1, "1"], ["notContains", null, "x"], ["startsWith", [], "x"],
    ["contains", "1", 1], ["notContains", "null", null],
    ["contains", [undefined], "VIP"], ["notContains", [NaN], "VIP"],
    ["endsWith", false, "x"], ["greaterThan", "2", 1],
    ["greaterThanOrEqual", NaN, 1], ["lessThan", Infinity, 1],
    ["lessThanOrEqual", null, 1], ["before", "2023-02-29T00:00:00Z", "2024-01-01T00:00:00Z"],
    ["after", 1704067200000, "2024-01-01T00:00:00Z"],
    ["notEquals", NaN, 1], ["notIn", { invalid: undefined }, [1]],
  ])("%s rejects invalid actual field types (%#)", (operator, actual, value) => {
    expect(() => matches(operator as string, actual, value)).toThrow(PublicationAutomationError);
  });

  it("does not hide invalid actual operands behind any/all short circuits", () => {
    const config = rule("equals", 1);
    config.source.conditions!.push({
      source: "traits", path: "score", operator: "greaterThan", value: 0,
    });
    for (const grouping of ["all", "any"] as const) {
      config.source.conditionMatch = grouping;
      expect(() => automationMatches(config, {
        type: "track", properties: { value: grouping === "any" ? 1 : 0 },
      }, { score: "1" })).toThrow(PublicationAutomationError);
    }
  });

  it("requires values for comparisons and bounds conditions and membership arrays", () => {
    for (const operator of ["equals", "notEquals", "in", "before", "greaterThan"]) {
      const config = rule(operator, undefined, false);
      expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
      expect(() => automationMatches(config, { type: "track" }, {})).toThrow(PublicationAutomationError);
    }
    expect(() => validatePublicationAutomationDefinition(rule("in", Array(100).fill(1)))).not.toThrow();
    const config = rule("exists", undefined, false);
    config.source.conditions = Array(33).fill(config.source.conditions![0]);
    expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
    config.source.conditions.pop();
    expect(() => validatePublicationAutomationDefinition(config)).not.toThrow();
    Object.assign(config.source, { conditionMatch: "none" });
    expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
    expect(() => automationMatches(config, { type: "track" }, {})).toThrow(PublicationAutomationError);
  });


  it("validates welcome journey UUIDs without a registered UUID format", () => {
    const existingUuidFormat = FormatRegistry.Get("uuid");
    FormatRegistry.Delete("uuid");
    try {
      const config = rule("equals", 1);
      for (const id of [
        "b4c231ca-61e6-11ee-8c99-0242ac120002",
        "b4c231ca-61e6-41ee-8c99-0242ac120002",
        "B4C231CA-61E6-51EE-BC99-0242AC120002",
        "00000000-0000-0000-0000-000000000000",
      ]) {
        config.destination.welcomeJourneyId = id;
        expect(validatePublicationAutomationDefinition(config)).toBe(config);
      }
      for (const id of [
        "not-a-uuid",
        "b4c231ca-61e6-41ee-8c99-0242ac120002-extra",
        "b4c231ca-61e6-41ee-7c99-0242ac120002",
        "b4c231ca-61e6-01ee-8c99-0242ac120002",
        "g4c231ca-61e6-41ee-8c99-0242ac120002",
      ]) {
        config.destination.welcomeJourneyId = id;
        expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
      }
    } finally {
      if (existingUuidFormat) FormatRegistry.Set("uuid", existingUuidFormat);
    }
  });

  it("validates bounded safe finite editor coordinates without changing behavior", () => {
    const config = rule("equals", 1);
    config.editorLayout = { nodePositions: { trigger: { x: -1.5, y: 0 }, conditions: { x: 400, y: 200 } } };
    expect(validatePublicationAutomationDefinition(config)).toBe(config);
    expect(automationMatches(config, { type: "track", properties: { value: 1 } }, {})).toBe(true);
    config.editorLayout.nodePositions = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`node-${i}`, { x: i, y: -i }]),
    );
    expect(() => validatePublicationAutomationDefinition(config)).not.toThrow();
    config.editorLayout.nodePositions.extra = { x: 0, y: 0 };
    expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
    for (const key of ["__proto__", "constructor", "prototype", "unsafe.key", "a".repeat(65), ""]) {
      config.editorLayout.nodePositions = JSON.parse(`{${JSON.stringify(key)}:{"x":0,"y":0}}`);
      expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
    }
    for (const position of [{ x: Infinity, y: 0 }, { x: 0, y: NaN }, { x: "1", y: 0 }, { x: 1 }]) {
      config.editorLayout.nodePositions = { trigger: position } as typeof config.editorLayout.nodePositions;
      expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
    }
    config.editorLayout.nodePositions = { trigger: { x: 0, y: 0, extra: true } } as typeof config.editorLayout.nodePositions;
    expect(() => validatePublicationAutomationDefinition(config)).toThrow(PublicationAutomationError);
  });
});

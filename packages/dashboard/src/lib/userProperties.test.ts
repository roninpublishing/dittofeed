import {
  EventValueSource,
  InternalEventType,
  UserPropertyDefinition,
  UserPropertyDefinitionType,
} from "isomorphic-lib/src/types";

import { getDefaultUserPropertyExampleValue } from "./userProperties";

describe("performed user property examples", () => {
  it("provides a JSON timestamp for event time without requiring a JSON property path", () => {
    const example = getDefaultUserPropertyExampleValue({
      type: UserPropertyDefinitionType.Performed,
      event: InternalEventType.EmailClicked,
      valueSource: EventValueSource.EventTime,
    });
    const parsed: unknown = JSON.parse(example);
    expect(typeof parsed).toBe("string");
    expect(Number.isFinite(Date.parse(parsed as string))).toBe(true);
  });

  it("uses a grouped event-time leaf's timestamp example instead of an event object", () => {
    const definition: UserPropertyDefinition = {
      type: UserPropertyDefinitionType.Group,
      entry: "group",
      nodes: [
        { id: "group", type: UserPropertyDefinitionType.AnyOf, children: ["click"] },
        {
          id: "click",
          type: UserPropertyDefinitionType.Performed,
          event: InternalEventType.EmailClicked,
          valueSource: EventValueSource.EventTime,
        },
      ],
    };
    const parsed: unknown = JSON.parse(getDefaultUserPropertyExampleValue(definition));
    expect(typeof parsed).toBe("string");
    expect(Number.isFinite(Date.parse(parsed as string))).toBe(true);
  });
});

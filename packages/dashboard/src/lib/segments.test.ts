import { Value } from "@sinclair/typebox/value";
import {
  InternalEventType,
  LastPerformedSegmentNode,
  SegmentNodeType,
  SegmentOperator,
  SegmentOperatorType,
} from "isomorphic-lib/src/types";

import {
  createLastClickedSegmentNode,
  createLastOpenedSegmentNode,
  getDefaultLastPerformedOperator,
  isLastClickedSegmentNode,
  isLastOpenedSegmentNode,
} from "./segments";

describe("last clicked segment preset", () => {
  it("does not mistake a clickedAt JSON property or a different event for click event time", () => {
    expect(
      isLastClickedSegmentNode({
        id: "property-condition",
        type: SegmentNodeType.LastPerformed,
        event: InternalEventType.EmailClicked,
        hasProperties: [
          { path: "clickedAt", operator: { type: SegmentOperatorType.Exists } },
        ],
      }),
    ).toBe(false);
    expect(
      isLastClickedSegmentNode({
        ...createLastClickedSegmentNode("other-event"),
        event: InternalEventType.EmailDelivered,
      }),
    ).toBe(false);
  });

  it("keeps separate preset conditions independent when edited", () => {
    const first = createLastClickedSegmentNode("first");
    const second = createLastClickedSegmentNode("second");
    const originalOperator = { ...second.hasProperties?.[0]?.operator };
    if (!first.hasProperties?.[0]) {
      throw new Error("Preset is missing its timestamp condition");
    }
    first.hasProperties[0].operator = { type: SegmentOperatorType.NotExists };
    expect(second.hasProperties?.[0]?.operator).toEqual(originalOperator);
  });

  it.each([
    SegmentOperatorType.Within,
    SegmentOperatorType.AbsoluteTimestamp,
    SegmentOperatorType.Exists,
    SegmentOperatorType.NotExists,
    SegmentOperatorType.Equals,
    SegmentOperatorType.NotEquals,
    SegmentOperatorType.LessThan,
    SegmentOperatorType.GreaterThanOrEqual,
  ])("initializes complete operator fields when switching to %s", (type) => {
    const operator = getDefaultLastPerformedOperator(type);
    expect(operator.type).toBe(type);
    expect(Value.Check(SegmentOperator, operator)).toBe(true);
    const node = createLastClickedSegmentNode("changed-operator");
    if (!node.hasProperties?.[0]) {
      throw new Error("Preset is missing its timestamp condition");
    }
    node.hasProperties[0].operator = operator;
    expect(Value.Check(LastPerformedSegmentNode, node)).toBe(true);
  });

  it("initializes absolute comparisons in UTC rather than using a local wall-clock string", () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-11-20T02:08:09.123-05:00"));
      const operator = getDefaultLastPerformedOperator(
        SegmentOperatorType.AbsoluteTimestamp,
      );
      if (operator.type !== SegmentOperatorType.AbsoluteTimestamp) {
        throw new Error("Expected an absolute timestamp operator");
      }
      expect(operator.absoluteTimestamp.endsWith("Z")).toBe(true);
      expect(Number.isFinite(Date.parse(operator.absoluteTimestamp))).toBe(
        true,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("last opened segment preset", () => {
  it("uses open event time and does not infer opens from clicks or payload timestamps", () => {
    const node = createLastOpenedSegmentNode("open");
    expect(Value.Check(LastPerformedSegmentNode, node)).toBe(true);
    expect(isLastOpenedSegmentNode(node)).toBe(true);
    expect(isLastClickedSegmentNode(node)).toBe(false);
    expect(isLastOpenedSegmentNode(createLastClickedSegmentNode("click"))).toBe(
      false,
    );
    expect(
      isLastOpenedSegmentNode({
        ...node,
        hasProperties: [
          { path: "openedAt", operator: { type: SegmentOperatorType.Exists } },
        ],
      }),
    ).toBe(false);
    expect(
      isLastOpenedSegmentNode({
        ...node,
        event: InternalEventType.EmailDelivered,
      }),
    ).toBe(false);
  });

  it.each([
    SegmentOperatorType.Within,
    SegmentOperatorType.AbsoluteTimestamp,
    SegmentOperatorType.Exists,
    SegmentOperatorType.NotExists,
  ])("supports %s independently of other open and click conditions", (type) => {
    const first = createLastOpenedSegmentNode("first");
    const second = createLastOpenedSegmentNode("second");
    const click = createLastClickedSegmentNode("click");
    if (!first.hasProperties?.[0])
      throw new Error("Missing timestamp condition");
    first.hasProperties[0].operator = getDefaultLastPerformedOperator(type);
    expect(Value.Check(LastPerformedSegmentNode, first)).toBe(true);
    expect(second.hasProperties?.[0]?.operator.type).toBe(
      SegmentOperatorType.Within,
    );
    expect(click.hasProperties?.[0]?.operator.type).toBe(
      SegmentOperatorType.Within,
    );
    expect(isLastOpenedSegmentNode(first)).toBe(true);
  });
});

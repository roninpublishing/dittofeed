import {
  CompletionStatus,
  CursorDirectionEnum,
  EventValueSource,
  InternalEventType,
  LastPerformedSegmentNode,
  MessageTemplateResource,
  SavedSubscriptionGroupResource,
  SegmentNode,
  SegmentNodeType,
  SegmentOperator,
  SegmentOperatorType,
} from "isomorphic-lib/src/types";

import { AppState } from "./types";

export function getSegmentConfigState({
  messageTemplates,
  subscriptionGroups,
}: {
  messageTemplates: MessageTemplateResource[];
  subscriptionGroups: SavedSubscriptionGroupResource[];
}): Partial<AppState> {
  const serverInitialState: Partial<AppState> = {};

  serverInitialState.messages = {
    type: CompletionStatus.Successful,
    value: messageTemplates,
  };

  serverInitialState.subscriptionGroups = subscriptionGroups;

  return serverInitialState;
}

export function createLastClickedSegmentNode(id: string): LastPerformedSegmentNode {
  return {
    id,
    type: SegmentNodeType.LastPerformed,
    event: InternalEventType.EmailClicked,
    hasProperties: [
      {
        valueSource: EventValueSource.EventTime,
        operator: {
          type: SegmentOperatorType.Within,
          windowSeconds: 30 * 24 * 60 * 60,
        },
      },
    ],
  };
}

export function isLastClickedSegmentNode(node: SegmentNode): boolean {
  return (
    node.type === SegmentNodeType.LastPerformed &&
    node.event === InternalEventType.EmailClicked &&
    node.hasProperties?.some(
      (property) => property.valueSource === EventValueSource.EventTime,
    ) === true
  );
}

export function createLastOpenedSegmentNode(id: string): LastPerformedSegmentNode {
  return {
    ...createLastClickedSegmentNode(id),
    event: InternalEventType.EmailOpened,
  };
}

export function isLastOpenedSegmentNode(node: SegmentNode): boolean {
  return (
    node.type === SegmentNodeType.LastPerformed &&
    node.event === InternalEventType.EmailOpened &&
    node.hasProperties?.some(
      (property) => property.valueSource === EventValueSource.EventTime,
    ) === true
  );
}

export function getDefaultLastPerformedOperator(
  type: SegmentOperatorType,
): SegmentOperator {
  switch (type) {
    case SegmentOperatorType.Within:
      return { type, windowSeconds: 30 * 24 * 60 * 60 };
    case SegmentOperatorType.AbsoluteTimestamp: {
      const date = new Date();
      date.setMinutes(0, 0, 0);
      return {
        type,
        absoluteTimestamp: date.toISOString(),
        direction: CursorDirectionEnum.After,
      };
    }
    case SegmentOperatorType.Exists:
    case SegmentOperatorType.NotExists:
      return { type };
    case SegmentOperatorType.LessThan:
    case SegmentOperatorType.GreaterThanOrEqual:
      return { type, value: 0 };
    case SegmentOperatorType.Equals:
    case SegmentOperatorType.NotEquals:
      return { type, value: "" };
    case SegmentOperatorType.HasBeen:
      throw new Error("Has Been is not supported for Last Performed conditions");
  }
}

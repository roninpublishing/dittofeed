import { confirmJourneyEmailSelections } from "../journeys";
import { confirmEmailSelection } from "../messaging";
import { ChannelType, EspSelection, JourneyDefinition, JourneyNodeType } from "../types";

jest.mock("../messaging", () => ({ confirmEmailSelection: jest.fn() }));
jest.mock("../clickhouse", () => ({}));
jest.mock("../computedProperties/computePropertiesWorkflow/lifecycle", () => ({}));
jest.mock("../db", () => ({}));
jest.mock("./userWorkflow", () => ({}));
jest.mock("./userWorkflow/lifecycle", () => ({}));
jest.mock("../logger", () => ({}));
jest.mock("../openTelemetry", () => ({}));
jest.mock("../restartUserJourneyWorkflow/lifecycle", () => ({}));
jest.mock("../segments", () => ({}));
jest.mock("../temporal/activity", () => ({}));
jest.mock("../temporal/workflows", () => ({}));
jest.mock("../newsletters", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const first: EspSelection = {
  accountId: "22222222-2222-4222-8222-222222222222", mode: "automatic",
};
const second: EspSelection = {
  accountId: "33333333-3333-4333-8333-333333333333", mode: "pool",
  poolId: "44444444-4444-4444-8444-444444444444",
};

function definition(): JourneyDefinition {
  return {
    entryNode: { type: JourneyNodeType.EventEntryNode, event: "signup", child: "first" },
    nodes: ["first", "second"].map((id) => ({
      id, type: JourneyNodeType.MessageNode, child: JourneyNodeType.ExitNode,
      variant: { type: ChannelType.Email, templateId: id },
    })),
    exitNode: { type: JourneyNodeType.ExitNode },
  };
}

function selections(value: JourneyDefinition) {
  return value.nodes.map((node) => node.type === JourneyNodeType.MessageNode &&
    node.variant.type === ChannelType.Email ? node.variant.espSelection : undefined);
}

describe("journey confirmation selection snapshots", () => {
  beforeEach(() => jest.clearAllMocks());

  it("resolves one optional default for all email nodes at confirmation", async () => {
    jest.mocked(confirmEmailSelection)
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const original = definition();
    original.nodes.forEach((node, index) => {
      if (index === 1 && node.type === JourneyNodeType.MessageNode && node.variant.type === ChannelType.Email) {
        node.variant.providerOverride = "SendGrid";
      }
    });
    const confirmed = await confirmJourneyEmailSelections(workspaceId, original);
    expect(selections(confirmed)).toEqual([first, first]);
    expect(confirmEmailSelection).toHaveBeenCalledTimes(1);
    expect(selections(original)).toEqual([undefined, undefined]);
  });

  it("keeps the persisted choices when a journey resumes after default changes", async () => {
    jest.mocked(confirmEmailSelection).mockResolvedValue(first);
    const confirmed = await confirmJourneyEmailSelections(workspaceId, definition());
    jest.mocked(confirmEmailSelection).mockClear().mockImplementation(async ({ espSelection }) =>
      espSelection === undefined ? second : espSelection,
    );
    const resumed = await confirmJourneyEmailSelections(workspaceId, confirmed);
    expect(selections(resumed)).toEqual([first, first]);
    expect(jest.mocked(confirmEmailSelection).mock.calls.map(([input]) => input.espSelection))
      .toEqual([first, first]);
  });

  it("allows different explicit account choices on independent journey nodes", async () => {
    const original = definition();
    original.nodes.forEach((node, index) => {
      if (node.type === JourneyNodeType.MessageNode && node.variant.type === ChannelType.Email) {
        node.variant.espSelection = index === 0 ? first : second;
      }
    });
    jest.mocked(confirmEmailSelection).mockImplementation(async ({ espSelection }) => espSelection ?? null);
    const confirmed = await confirmJourneyEmailSelections(workspaceId, original);
    expect(selections(confirmed)).toEqual([first, second]);
  });
});

import { db } from "../db";
import { confirmEmailSelection } from "../messaging";
import connectWorkflowClient from "../temporal/connectWorkflowClient";
import { BroadcastV2Config, EspSelection } from "../types";
import { startBroadcastWorkflow } from "./lifecycle";

jest.mock("../db", () => ({ db: jest.fn() }));
jest.mock("../broadcasts", () => ({ markBroadcastStatus: jest.fn() }));
jest.mock("../messaging", () => ({ confirmEmailSelection: jest.fn() }));
jest.mock("../temporal/connectWorkflowClient", () => ({
  __esModule: true, default: jest.fn(),
}));
jest.mock("../config", () => ({
  __esModule: true, default: () => ({ computedPropertiesTaskQueue: "isolated-selection-test" }),
}));
jest.mock("../logger", () => ({
  __esModule: true, default: () => ({ info: jest.fn(), error: jest.fn() }),
}));
jest.mock("./broadcastWorkflowV2", () => ({
  broadcastWorkflowV2: jest.fn(),
  generateBroadcastWorkflowV2Id: () => "isolated-broadcast",
}));
jest.mock("./recomputeBroadcastSegmentWorkflow", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const broadcastId = "22222222-2222-4222-8222-222222222222";
const first: EspSelection = {
  accountId: "33333333-3333-4333-8333-333333333333", mode: "automatic",
};
const second: EspSelection = {
  accountId: "44444444-4444-4444-8444-444444444444", mode: "pool",
  poolId: "55555555-5555-4555-8555-555555555555",
};

interface StoredBroadcast {
  config: BroadcastV2Config;
  statusV2: string;
  triggeredAt: Date | null;
}

describe("broadcast confirmation selection snapshots", () => {
  let stored: StoredBroadcast;
  let currentDefault: EspSelection;
  let queuedMessages: BroadcastV2Config["message"][];
  const start = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    currentDefault = first;
    queuedMessages = [];
    stored = {
      config: { type: "V2", message: { type: "Email" } },
      statusV2: "Draft",
      triggeredAt: null,
    };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [stored] }) }) }),
      update: () => ({ set: (values: Partial<StoredBroadcast>) => ({ where: async () => {
        Object.assign(stored, values);
      } }) }),
    };
    (db as jest.Mock).mockReturnValue({ transaction: async (callback: (value: typeof tx) => unknown) => callback(tx) });
    jest.mocked(confirmEmailSelection).mockImplementation(async ({ espSelection }) =>
      espSelection ?? currentDefault,
    );
    start.mockImplementation(async (_workflow, options) => {
      // Temporal serializes the workflow arguments; retain that immutable input.
      queuedMessages.push(JSON.parse(JSON.stringify(options.args[0].confirmedMessage)));
    });
    (connectWorkflowClient as jest.Mock).mockResolvedValue({ start });
  });

  it("persists the chosen default before queueing and does not resolve it again on repeated confirmation", async () => {
    await startBroadcastWorkflow({ workspaceId, broadcastId });
    expect(stored.config.message).toMatchObject({ espSelection: first });
    expect(stored.triggeredAt).toBeInstanceOf(Date);
    currentDefault = second;
    await startBroadcastWorkflow({ workspaceId, broadcastId, espSelection: second });
    expect(confirmEmailSelection).toHaveBeenCalledTimes(1);
    expect(queuedMessages).toEqual([
      { type: "Email", espSelection: first },
      { type: "Email", espSelection: first },
    ]);
  });

  it("pins an explicit account and pool override instead of the optional default", async () => {
    await startBroadcastWorkflow({ workspaceId, broadcastId, espSelection: second });
    expect(confirmEmailSelection).toHaveBeenCalledWith(expect.objectContaining({ espSelection: second }));
    expect(queuedMessages).toEqual([{ type: "Email", espSelection: second }]);
    currentDefault = first;
    expect(stored.config.message).toMatchObject({ espSelection: second });
  });

  it("does not queue or confirm when selection validation fails", async () => {
    jest.mocked(confirmEmailSelection).mockRejectedValue(new Error("esp_selection_required"));
    await expect(startBroadcastWorkflow({ workspaceId, broadcastId }))
      .rejects.toThrow("esp_selection_required");
    expect(stored.triggeredAt).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("leaves a running campaign's confirmed choice untouched", async () => {
    stored.statusV2 = "Running";
    stored.config.message = { type: "Email", espSelection: first };
    await startBroadcastWorkflow({ workspaceId, broadcastId, espSelection: second });
    expect(stored.config.message).toEqual({ type: "Email", espSelection: first });
    expect(confirmEmailSelection).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

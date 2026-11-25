import { ok } from "neverthrow";
import { db } from "./db";
import {
  batchMessageUsers,
  confirmEmailSelection,
  sendEmail,
  testTemplate,
} from "./messaging";
import { getNewsletterEmailContext, sendNewsletterEmail } from "./newsletterDelivery";
import { resolveNewsletterSelection } from "./newsletterInfrastructure";
import { NewsletterInfrastructureError } from "./newsletterSendgrid";
import { getUsers } from "./users";
import {
  BatchMessageUsersResultTypeEnum,
  ChannelType,
  EmailContentsType,
  EmailProviderType,
  EspSelection,
  InternalEventType,
} from "./types";

jest.mock("./db", () => ({ db: jest.fn() }));
jest.mock("./newsletterDelivery", () => ({
  getNewsletterEmailContext: jest.fn(),
  sendNewsletterEmail: jest.fn(),
}));
jest.mock("./newsletterInfrastructure", () => ({
  resolveNewsletterSelection: jest.fn(),
  NewsletterInfrastructureError: jest.requireActual("./newsletterSendgrid").NewsletterInfrastructureError,
}));
jest.mock("./users", () => ({ getUsers: jest.fn() }));
jest.mock("./apps/batch", () => ({ submitBatch: jest.fn() }));
jest.mock("./blobStorage", () => ({}));
jest.mock("./destinations/amazonses", () => ({}));
jest.mock("./destinations/telnyx", () => ({}));
jest.mock("./destinations/sendgrid", () => ({}));
jest.mock("./destinations/smtp", () => ({}));
jest.mock("./gmail", () => ({}));
jest.mock("./viewInBrowser", () => ({}));
jest.mock("./messaging/openTracking", () => ({}));
jest.mock("./config", () => ({
  __esModule: true,
  default: () => ({ enableBlobStorage: false, enableOpenTracking: false }),
}));
jest.mock("./logger", () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));
jest.mock("./liquid", () => ({
  renderLiquid: ({ template }: { template?: string }) => template ?? "",
}));
jest.mock("./messaging/email", () => ({
  constructUnsubscribeHeaders: () => jest.requireActual("neverthrow").ok({}),
}));
jest.mock("./subscriptionGroups", () => ({
  getSubscriptionGroupsWithAssignments: jest.fn(async () => []),
}));
jest.mock("./openTelemetry", () => ({
  withSpan: async (_options: unknown, callback: (span: unknown) => unknown) =>
    callback({ setAttributes: jest.fn() }),
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const publisherId = "22222222-2222-4222-8222-222222222222";
const templateId = "33333333-3333-4333-8333-333333333333";
const selectionA: EspSelection = {
  accountId: "44444444-4444-4444-8444-444444444444",
  mode: "automatic",
};
const selectionB: EspSelection = {
  accountId: "55555555-5555-4555-8555-555555555555",
  mode: "pool",
  poolId: "66666666-6666-4666-8666-666666666666",
};
const queued = {
  type: InternalEventType.MessageQueued,
  sendId: "77777777-7777-4777-8777-777777777777",
  state: "queued",
} as const;

// No database, worker, provider client, or network is used by this consumer suite.
describe("newsletter send consumers", () => {
  let defaultSelection: EspSelection | null;
  const legacyProvider = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    defaultSelection = selectionA;
    jest.mocked(getNewsletterEmailContext).mockResolvedValue({ publisherId });
    (resolveNewsletterSelection as jest.Mock).mockImplementation(async ({ selection }) => {
      const chosen = selection === undefined ? defaultSelection : selection;
      if (!chosen) throw new NewsletterInfrastructureError(400, "esp_selection_required");
      return { selection: chosen };
    });
    legacyProvider.mockImplementation(() => {
      throw new Error("Legacy provider lookup must not handle ESP account selection");
    });
    const template = {
      id: templateId,
      workspaceId,
      name: "Consumer template",
      updatedAt: new Date(0),
      definition: {
        type: ChannelType.Email,
        emailContentsType: EmailContentsType.Code,
        from: "sender@example.invalid",
        subject: "Selection",
        body: "Confirmed account",
      },
    };
    (db as jest.Mock).mockReturnValue({ query: {
      messageTemplate: { findFirst: jest.fn(async () => template) },
      secret: { findFirst: jest.fn(async () => undefined) },
      subscriptionGroup: { findFirst: jest.fn(async () => undefined) },
      emailProvider: { findFirst: legacyProvider },
      defaultEmailProvider: { findFirst: legacyProvider },
    } });
    jest.mocked(sendNewsletterEmail).mockResolvedValue(ok(queued));
    (getUsers as jest.Mock).mockResolvedValue(ok({ users: [
      { id: "first", properties: { email: { value: "first@example.invalid" } } },
      { id: "second", properties: { email: { value: "second@example.invalid" } } },
    ] }));
  });

  it("carries the explicit account override from a test API request to durable delivery", async () => {
    const result = await testTemplate({
      workspaceId, templateId, channel: ChannelType.Email,
      userProperties: { id: "reader", email: "reader@example.invalid" },
      espSelection: selectionB,
    });
    expect(result._unsafeUnwrap()).toEqual(queued);
    expect(sendNewsletterEmail).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId, publisherId, espSelection: selectionB,
    }));
    expect(legacyProvider).not.toHaveBeenCalled();
  });

  it("resolves a batch default once and retains it when the default changes between recipients", async () => {
    jest.mocked(sendNewsletterEmail).mockImplementation(async () => {
      defaultSelection = selectionB;
      return ok(queued);
    });
    const response = await batchMessageUsers({
      workspaceId, templateId, channel: ChannelType.Email,
      users: [{ id: "first", properties: {} }, { id: "second", properties: {} }],
    });
    expect(response.results.map((result) => result.type)).toEqual([
      BatchMessageUsersResultTypeEnum.Queued, BatchMessageUsersResultTypeEnum.Queued,
    ]);
    expect(jest.mocked(sendNewsletterEmail).mock.calls.map(([input]) => input.espSelection))
      .toEqual([selectionA, selectionA]);
    expect(jest.mocked(resolveNewsletterSelection).mock.calls.filter(([input]) => input.selection === undefined))
      .toHaveLength(1);
  });

  it("rejects pinned absence instead of consulting a newly configured default", async () => {
    await expect(confirmEmailSelection({ workspaceId, espSelection: null }))
      .rejects.toMatchObject({ code: "esp_selection_required" });
    expect(sendNewsletterEmail).not.toHaveBeenCalled();
  });

  it("rejects managed-newsletter native-provider overrides without bypassing durable safety", async () => {
    await expect(confirmEmailSelection({ workspaceId, providerOverride: EmailProviderType.Test }))
      .rejects.toMatchObject({ code: "unsupported_newsletter_provider" });
    expect(resolveNewsletterSelection).not.toHaveBeenCalled();
    for (const espSelection of [undefined, null, selectionA]) {
      const result = await sendEmail({
        workspaceId, templateId, userId: "reader", useDraft: false,
        userPropertyAssignments: { email: "reader@example.invalid" },
        providerOverride: EmailProviderType.Test, espSelection,
        messageTags: { messageId: "stable-message" },
      });
      expect(result._unsafeUnwrapErr()).toMatchObject({
        type: InternalEventType.BadWorkspaceConfiguration,
        variant: { message: espSelection ? "esp_selection_provider_conflict" : "unsupported_newsletter_provider" },
      });
    }
    expect(sendNewsletterEmail).not.toHaveBeenCalled();
    expect(legacyProvider).not.toHaveBeenCalled();
  });

  it("preserves native provider overrides outside managed newsletters", async () => {
    jest.mocked(getNewsletterEmailContext).mockResolvedValue(null);
    legacyProvider.mockResolvedValue({
      type: EmailProviderType.Test,
      secret: { workspaceId, configValue: { type: EmailProviderType.Test } },
    });
    await expect(confirmEmailSelection({ workspaceId, providerOverride: EmailProviderType.Test })).resolves.toBeNull();
    expect(resolveNewsletterSelection).not.toHaveBeenCalled();
    const result = await sendEmail({
      workspaceId, templateId, userId: "native-reader", useDraft: false,
      userPropertyAssignments: { email: "native-reader@example.invalid" },
      providerOverride: EmailProviderType.Test,
      messageTags: { messageId: "native-message" },
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      type: InternalEventType.MessageSent,
      variant: { provider: { type: EmailProviderType.Test } },
    });
    expect(legacyProvider).toHaveBeenCalledTimes(1);
    expect(sendNewsletterEmail).not.toHaveBeenCalled();
  });

  it("reaches durable retry identity without re-resolving a changed or deleted default", async () => {
    const request = {
      workspaceId, templateId, userId: "reader", useDraft: false,
      userPropertyAssignments: { email: "reader@example.invalid" },
      messageTags: { messageId: "stable-message" },
    };
    expect((await sendEmail(request))._unsafeUnwrap()).toEqual(queued);
    defaultSelection = null;
    expect((await sendEmail(request))._unsafeUnwrap()).toEqual(queued);
    expect(resolveNewsletterSelection).not.toHaveBeenCalled();
    expect(legacyProvider).not.toHaveBeenCalled();
    expect(sendNewsletterEmail).toHaveBeenCalledTimes(2);
    expect(jest.mocked(sendNewsletterEmail).mock.calls.map(([input]) => ({
      logicalMessageId: input.logicalMessageId, espSelection: input.espSelection,
    }))).toEqual([
      { logicalMessageId: "stable-message", espSelection: undefined },
      { logicalMessageId: "stable-message", espSelection: undefined },
    ]);
  });

  it("rejects account selection outside a newsletter instead of using the native provider", async () => {
    jest.mocked(getNewsletterEmailContext).mockResolvedValue(null);
    await expect(confirmEmailSelection({ workspaceId, espSelection: selectionA }))
      .rejects.toMatchObject({ code: "esp_selection_requires_newsletter" });
    expect(resolveNewsletterSelection).not.toHaveBeenCalled();
  });
});

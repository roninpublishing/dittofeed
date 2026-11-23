/** @group temporal */
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { randomUUID } from "crypto";

import { createWorker } from "../test/temporal";
import { ChannelType, JourneyDefinition, JourneyNodeType } from "./types";

jest.setTimeout(60_000);
let environment: TestWorkflowEnvironment;
beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});
afterAll(async () => {
  await environment.teardown();
});

const definition: JourneyDefinition = {
  entryNode: {
    type: JourneyNodeType.EventEntryNode,
    event: "PublicationWelcome",
    child: "first",
  },
  nodes: [
    {
      id: "first",
      type: JourneyNodeType.MessageNode,
      name: "First email",
      variant: { type: ChannelType.Email, templateId: "first-template" },
      skipOnFailure: true,
      child: "second",
    },
    {
      id: "second",
      type: JourneyNodeType.MessageNode,
      name: "Second email",
      variant: { type: ChannelType.Email, templateId: "second-template" },
      child: JourneyNodeType.ExitNode,
    },
  ],
  exitNode: { type: JourneyNodeType.ExitNode },
};

it("does not advance a queued newsletter journey until the provider accepts its first email", async () => {
  const sentTemplates: string[] = [];
  let statusPolls = 0;
  let pollsAtSecondSend = 0;
  const worker = await createWorker({
    testEnv: environment,
    activityOverrides: {
      isRunnable: async () => true,
      shouldReEnter: async () => false,
      onNodeProcessedV2: async () => undefined,
      reportWorkflowInfo: async () => undefined,
      sendMessageV2: async ({ templateId }: { templateId: string }) => {
        sentTemplates.push(templateId);
        if (templateId === "first-template") return false;
        pollsAtSecondSend = statusPolls;
        return true;
      },
      getNewsletterSendStatusByMessageId: async () => {
        statusPolls += 1;
        return {
          sendId: randomUUID(),
          state: statusPolls === 1 ? "queued" : "accepted",
          accepted: statusPolls > 1,
          terminal: statusPolls > 1,
          nextAttemptAt: new Date().toISOString(),
          error: null,
        };
      },
    },
  });
  await worker.runUntil(
    environment.client.workflow.execute("userJourneyWorkflow", {
      workflowId: randomUUID(),
      taskQueue: "default",
      args: [
        {
          workspaceId: randomUUID(),
          journeyId: randomUUID(),
          userId: "newsletter-subscriber",
          eventKey: "source-event",
          definition,
          shouldContinueAsNew: false,
        },
      ],
    }),
  );
  expect(sentTemplates).toEqual(["first-template", "second-template"]);
  expect(pollsAtSecondSend).toBe(2);
});

it("does not advance uncertain provider acceptance even when the node normally skips failures", async () => {
  const sentTemplates: string[] = [];
  const worker = await createWorker({
    testEnv: environment,
    activityOverrides: {
      isRunnable: async () => true,
      shouldReEnter: async () => false,
      onNodeProcessedV2: async () => undefined,
      reportWorkflowInfo: async () => undefined,
      sendMessageV2: async ({ templateId }: { templateId: string }) => {
        sentTemplates.push(templateId);
        return false;
      },
      getNewsletterSendStatusByMessageId: async () => ({
        sendId: randomUUID(),
        state: "unknown",
        accepted: false,
        terminal: true,
        nextAttemptAt: new Date().toISOString(),
        error: "Acceptance uncertain",
      }),
    },
  });
  await worker.runUntil(
    environment.client.workflow.execute("userJourneyWorkflow", {
      workflowId: randomUUID(),
      taskQueue: "default",
      args: [
        {
          workspaceId: randomUUID(),
          journeyId: randomUUID(),
          userId: "newsletter-subscriber",
          eventKey: "source-event",
          definition,
          shouldContinueAsNew: false,
        },
      ],
    }),
  );
  expect(sentTemplates).toEqual(["first-template"]);
});

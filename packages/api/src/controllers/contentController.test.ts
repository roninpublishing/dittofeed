import * as messaging from "backend-lib/src/messaging";
import { NewsletterInfrastructureError } from "backend-lib/src/newsletterInfrastructure";
import { ok } from "neverthrow";
import { randomUUID } from "crypto";
import fastify from "fastify";
import { TYPE_REFS } from "isomorphic-lib/src/typeRefs";
import {
  ChannelType,
  JsonResultType,
  InternalEventType,
  RenderMessageTemplateType,
} from "isomorphic-lib/src/types";

import contentController from "./contentController";

// Validation must reject retired channels before any database lookup or send.
describe("retired message channels", () => {
  it.each([
    {
      method: "PUT" as const,
      url: "/templates",
      payload: {
        workspaceId: "workspace",
        name: "Retired template",
        definition: { type: "Sms", body: "Do not send" },
      },
    },
    {
      method: "PUT" as const,
      url: "/templates/reset",
      payload: {
        workspaceId: "workspace",
        name: "Retired template",
        type: "Sms",
      },
    },
    {
      method: "POST" as const,
      url: "/templates/test",
      payload: {
        workspaceId: "workspace",
        templateId: "template",
        channel: "Sms",
        userProperties: { phone: "+12025550100" },
      },
    },
  ])("returns a client error for $method $url", async (request) => {
    const app = fastify();
    TYPE_REFS.forEach((schema) => app.addSchema(schema));
    await app.register(contentController);
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("explicit email URL token previews", () => {
  it.each([undefined, "destination"])(
    "uses the resolved To field (%s) and leaves literal links alone",
    async (identifierKey) => {
      const app = fastify();
      TYPE_REFS.forEach((schema) => app.addSchema(schema));
      await app.register(contentController);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/templates/render",
          payload: {
            workspaceId: randomUUID(),
            channel: ChannelType.Email,
            identifierKey,
            userProperties: {
              email: identifierKey
                ? "wrong@example.invalid"
                : "actual+edition@example.invalid",
              destination: '"Actual Reader" <actual+edition@example.invalid>',
              name: "A+B & C",
            },
            contents: {
              body: {
                type: RenderMessageTemplateType.PlainText,
                value:
                  '<a href="https://example.invalid/?e={{subscriber_email}}&name={{user.name | url_encode}}&h={{subscriber_email_md5}}">Token</a><a href="https://plain.invalid/?subscriber_email=authored">Literal</a>',
              },
            },
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          contents: {
            body: {
              type: JsonResultType.Ok,
              value:
                '<a href="https://example.invalid/?e=actual%2Bedition%40example.invalid&name=A%2BB+%26+C&h=6be3745f0cf9db53ee53afa4d05cbad1">Token</a><a href="https://plain.invalid/?subscriber_email=authored">Literal</a>',
            },
          },
        });
      } finally {
        await app.close();
      }
    },
  );
});

describe("ESP selection send API consumers", () => {
  afterEach(() => jest.restoreAllMocks());

  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const templateId = "22222222-2222-4222-8222-222222222222";
  const accountId = "33333333-3333-4333-8333-333333333333";
  const poolId = "44444444-4444-4444-8444-444444444444";
  const ipId = "55555555-5555-4555-8555-555555555555";

  it.each([
    { accountId, mode: "automatic" },
    { accountId, mode: "pool", poolId },
    { accountId, mode: "ip", ipId },
  ])("passes the complete $mode selection to the batch consumer", async (espSelection) => {
    const send = jest.spyOn(messaging, "batchMessageUsers").mockResolvedValue({ results: [] });
    const app = fastify();
    TYPE_REFS.forEach((schema) => app.addSchema(schema));
    await app.register(contentController);
    try {
      const response = await app.inject({
        method: "POST", url: "/templates/batch-send",
        payload: { workspaceId, templateId, channel: ChannelType.Email, users: [], espSelection },
      });
      expect(response.statusCode).toBe(200);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ espSelection }));
    } finally {
      await app.close();
    }
  });

  it("keeps explicit selection on test-email requests", async () => {
    const espSelection = { accountId, mode: "pool" as const, poolId };
    const send = jest.spyOn(messaging, "testTemplate").mockResolvedValue(ok({
      type: InternalEventType.MessageQueued, sendId: ipId, state: "queued",
    }));
    const app = fastify();
    TYPE_REFS.forEach((schema) => app.addSchema(schema));
    await app.register(contentController);
    try {
      const response = await app.inject({
        method: "POST", url: "/templates/test",
        payload: {
          workspaceId, templateId, channel: ChannelType.Email,
          userProperties: { email: "reader@example.invalid" }, espSelection,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ espSelection }));
    } finally {
      await app.close();
    }
  });

  it("rejects incomplete resource selection before calling the send consumer", async () => {
    const send = jest.spyOn(messaging, "batchMessageUsers");
    const app = fastify();
    TYPE_REFS.forEach((schema) => app.addSchema(schema));
    await app.register(contentController);
    try {
      const response = await app.inject({
        method: "POST", url: "/templates/batch-send",
        payload: {
          workspaceId, templateId, channel: ChannelType.Email, users: [],
          espSelection: { accountId, mode: "pool" },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { accountId, mode: "automatic", poolId },
    { accountId, mode: "automatic", ipId },
    { accountId, mode: "pool", poolId, ipId },
    { accountId, mode: "ip", ipId, poolId },
    { accountId: "not-a-uuid", mode: "automatic" },
  ])("rejects malformed or mixed-mode selection without mutating it into a different valid choice", async (espSelection) => {
    const send = jest.spyOn(messaging, "batchMessageUsers");
    const app = fastify();
    TYPE_REFS.forEach((schema) => app.addSchema(schema));
    await app.register(contentController);
    try {
      const response = await app.inject({
        method: "POST", url: "/templates/batch-send",
        payload: { workspaceId, templateId, channel: ChannelType.Email, users: [], espSelection },
      });
      expect(response.statusCode).toBe(400);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns explicit selection failures as client errors, not generic send failures", async () => {
    jest.spyOn(messaging, "batchMessageUsers").mockRejectedValue(
      new NewsletterInfrastructureError(400, "esp_selection_required"),
    );
    const app = fastify();
    TYPE_REFS.forEach((schema) => app.addSchema(schema));
    await app.register(contentController);
    try {
      const response = await app.inject({
        method: "POST", url: "/templates/batch-send",
        payload: { workspaceId, templateId, channel: ChannelType.Email, users: [] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ message: "esp_selection_required" });
    } finally {
      await app.close();
    }
  });
});

import { randomUUID } from "crypto";
import fastify from "fastify";
import { TYPE_REFS } from "isomorphic-lib/src/typeRefs";
import { ChannelType, JsonResultType, RenderMessageTemplateType } from "isomorphic-lib/src/types";

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
  it.each([undefined, "destination"])("uses the resolved To field (%s) and leaves literal links alone", async (identifierKey) => {
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
            email: identifierKey ? "wrong@example.invalid" : "actual+edition@example.invalid",
            destination: '"Actual Reader" <actual+edition@example.invalid>',
            name: "A+B & C",
          },
          contents: {
            body: {
              type: RenderMessageTemplateType.PlainText,
              value: '<a href="https://example.invalid/?e={{subscriber_email}}&name={{user.name | url_encode}}&h={{subscriber_email_md5}}">Token</a><a href="https://plain.invalid/?subscriber_email=authored">Literal</a>',
            },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        contents: {
          body: {
            type: JsonResultType.Ok,
            value: '<a href="https://example.invalid/?e=actual%2Bedition%40example.invalid&name=A%2BB+%26+C&h=6be3745f0cf9db53ee53afa4d05cbad1">Token</a><a href="https://plain.invalid/?subscriber_email=authored">Literal</a>',
          },
        },
      });
    } finally {
      await app.close();
    }
  });
});

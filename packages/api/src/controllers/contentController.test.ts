import fastify from "fastify";
import { TYPE_REFS } from "isomorphic-lib/src/typeRefs";

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

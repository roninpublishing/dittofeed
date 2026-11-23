import { db } from "backend-lib/src/db";
import { emailProvider } from "backend-lib/src/db/schema";
import { upsertEmailProvider } from "backend-lib/src/messaging/email";
import { getSecretAvailability } from "backend-lib/src/secrets";
import { createWorkspace } from "backend-lib/src/workspaces";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import fastify, { FastifyInstance } from "fastify";
import { SecretNames } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { EmailProviderType } from "isomorphic-lib/src/types";

import secretsController from "./secretsController";
import settingsController from "./settingsController";

// Historical rows must not make a removed provider selectable again.
describe("email provider defaults", () => {
  let app: FastifyInstance;
  let workspaceId: string;
  let retainedProviderId: string;

  beforeEach(async () => {
    const workspace = await createWorkspace({ name: randomUUID() }).then(
      unwrap,
    );
    workspaceId = workspace.id;
    const provider = await upsertEmailProvider({
      workspaceId,
      setDefault: true,
      config: { type: EmailProviderType.Test },
    });
    retainedProviderId = provider.id;
    app = fastify();
    await app.register(settingsController);
    await app.register(secretsController, { prefix: "/secrets" });
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ["PostMark", "id"],
    ["PostMark", "type"],
    ["MailChimp", "id"],
    ["MailChimp", "type"],
    ["Resend", "id"],
    ["Resend", "type"],
  ])("rejects historical %s selected by %s", async (type, selection) => {
    const [retired] = await db()
      .insert(emailProvider)
      .values({ workspaceId, type })
      .returning({ id: emailProvider.id });
    if (!retired) throw new Error("Fixture provider was not inserted");
    const response = await app.inject({
      method: "PUT",
      url: "/email-providers/default",
      payload: {
        workspaceId,
        fromAddress: null,
        ...(selection === "id"
          ? { emailProviderId: retired.id }
          : { emailProvider: type }),
      },
    });
    expect(response.statusCode).toBe(400);
    const selected = await db().query.defaultEmailProvider.findFirst({
      where: (table) => eq(table.workspaceId, workspaceId),
    });
    expect(selected?.emailProviderId).toBe(retainedProviderId);
  });

  it("still selects a supported workspace provider", async () => {
    const supported = await upsertEmailProvider({
      workspaceId,
      config: { type: EmailProviderType.SendGrid },
    });
    const response = await app.inject({
      method: "PUT",
      url: "/email-providers/default",
      payload: {
        workspaceId,
        emailProviderId: supported.id,
        fromAddress: "sender@example.com",
      },
    });
    expect(response.statusCode).toBe(201);
    const selected = await db().query.defaultEmailProvider.findFirst({
      where: (table) => eq(table.workspaceId, workspaceId),
    });
    expect(selected?.emailProviderId).toBe(supported.id);
    expect(selected?.fromAddress).toBe("sender@example.com");
  });

  it.each([true, false])(
    "persists Telnyx sandbox mode %s through partial settings without replacing credentials",
    async (sandboxMode) => {
      await upsertEmailProvider({
        workspaceId,
        config: {
          type: EmailProviderType.Telnyx,
          apiKey: "private-api-key",
          publicKey: "webhook-public-key",
          sandboxMode: !sandboxMode,
        },
      });
      const response = await app.inject({
        method: "PUT",
        url: "/secrets/",
        payload: {
          workspaceId,
          name: SecretNames.Telnyx,
          configValue: { type: EmailProviderType.Telnyx, sandboxMode },
        },
      });
      expect(response.statusCode).toBe(204);
      const secret = await db().query.secret.findFirst({
        where: (table, { and }) =>
          and(
            eq(table.workspaceId, workspaceId),
            eq(table.name, SecretNames.Telnyx),
          ),
      });
      expect(secret?.configValue).toEqual({
        type: EmailProviderType.Telnyx,
        apiKey: "private-api-key",
        publicKey: "webhook-public-key",
        sandboxMode,
      });
      const availability = await getSecretAvailability({
        workspaceId,
        names: [SecretNames.Telnyx],
      });
      expect(availability[0]?.configValue).toEqual({
        type: true,
        apiKey: true,
        publicKey: true,
        sandboxMode,
      });
    },
  );
});

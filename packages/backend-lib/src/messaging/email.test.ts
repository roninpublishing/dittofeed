import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";

import { db } from "../db";
import {
  defaultEmailProvider as dbDefaultEmailProvider,
  emailProvider as dbEmailProvider,
} from "../db/schema";
import { EmailProviderType } from "../types";
import { createWorkspace } from "../workspaces";
import { getOrCreateEmailProviders, upsertEmailProvider } from "./email";

describe("email", () => {
  it("excludes retired providers without deleting history or changing the default", async () => {
    const workspace = await createWorkspace({ name: randomUUID() }).then(unwrap);
    const retained = await upsertEmailProvider({
      workspaceId: workspace.id,
      setDefault: true,
      config: { type: EmailProviderType.Test },
    });
    const retired = await db()
      .insert(dbEmailProvider)
      .values([
        { workspaceId: workspace.id, type: "PostMark" },
        { workspaceId: workspace.id, type: "MailChimp" },
        { workspaceId: workspace.id, type: "Resend" },
      ])
      .returning({ id: dbEmailProvider.id });

    const providers = await getOrCreateEmailProviders({
      workspaceId: workspace.id,
    });
    expect(providers).toContainEqual(retained);
    expect(providers.map((provider) => provider.type)).not.toContain("PostMark");
    expect(providers.map((provider) => provider.type)).not.toContain("MailChimp");
    expect(providers.map((provider) => provider.type)).not.toContain("Resend");
    const historical = await db().query.emailProvider.findMany({
      where: inArray(
        dbEmailProvider.id,
        retired.map((provider) => provider.id),
      ),
      columns: { id: true },
    });
    expect(historical.map((provider) => provider.id).sort()).toEqual(
      retired.map((provider) => provider.id).sort(),
    );
    const selected = await db().query.defaultEmailProvider.findFirst({
      where: eq(dbDefaultEmailProvider.workspaceId, workspace.id),
    });
    expect(selected?.emailProviderId).toBe(retained.id);
  });

  describe("upsertEmailProvider", () => {
    it("should be able to update an existing email provider", async () => {
      const workspace = await createWorkspace({
        name: randomUUID(),
      }).then(unwrap);

      await upsertEmailProvider({
        workspaceId: workspace.id,
        setDefault: true,
        config: {
          type: EmailProviderType.SendGrid,
          apiKey: "123",
        },
      });

      await upsertEmailProvider({
        workspaceId: workspace.id,
        setDefault: true,
        config: {
          type: EmailProviderType.SendGrid,
          apiKey: "456",
        },
      });

      const provider = await db().query.defaultEmailProvider.findFirst({
        where: (table, { eq }) => eq(table.workspaceId, workspace.id),
        with: {
          emailProvider: {
            with: {
              secret: true,
            },
          },
        },
      });

      expect(provider?.emailProvider.secret?.configValue).toEqual(
        expect.objectContaining({
          apiKey: "456",
        }),
      );
    });
  });
});

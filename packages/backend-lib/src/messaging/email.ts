import { and, eq, inArray } from "drizzle-orm";
import { EMAIL_PROVIDER_TYPE_TO_SECRET_NAME } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  BadWorkspaceConfigurationType,
  MessageTemplateRenderError,
  PersistedEmailProvider,
  SubscriptionChange,
  UpsertEmailProviderRequest,
  WorkspaceWideEmailProviderType,
} from "isomorphic-lib/src/types";
import { err, ok, Result } from "neverthrow";

import { db, upsert } from "../db";
import {
  defaultEmailProvider as dbDefaultEmailProvider,
  emailProvider as dbEmailProvider,
  secret as dbSecret,
} from "../db/schema";
import { generateSubscriptionChangeUrl } from "../subscriptionGroups";
import { EmailProvider } from "../types";

const LIST_UNSUBSCRIBE_POST = "List-Unsubscribe=One-Click" as const;
const WORKSPACE_PROVIDER_TYPES = Object.values(WorkspaceWideEmailProviderType);

export interface UnsubscribeHeaders {
  "List-Unsubscribe-Post": typeof LIST_UNSUBSCRIBE_POST;
  "List-Unsubscribe": string;
  "List-ID": string;
}

export function constructUnsubscribeHeaders({
  to,
  from,
  userId,
  identifierKey,
  subscriptionGroupSecret,
  subscriptionGroupName,
  workspaceId,
  subscriptionGroupId,
}: {
  to: string;
  from: string;
  userId: string;
  identifierKey: string;
  subscriptionGroupSecret: string;
  subscriptionGroupName: string;
  workspaceId: string;
  subscriptionGroupId: string;
}): Result<UnsubscribeHeaders, MessageTemplateRenderError> {
  const domain = from.split("@")[1];
  if (!domain) {
    return err({
      type: BadWorkspaceConfigurationType.MessageTemplateRenderError,
      field: "from",
      error: `Invalid from address ${from}`,
    });
  }
  const url = generateSubscriptionChangeUrl({
    workspaceId,
    identifier: to,
    identifierKey,
    subscriptionSecret: subscriptionGroupSecret,
    userId,
    changedSubscription: subscriptionGroupId,
    subscriptionChange: SubscriptionChange.Unsubscribe,
  });
  return ok({
    "List-Unsubscribe-Post": LIST_UNSUBSCRIBE_POST,
    "List-Unsubscribe": `<${url}>`,
    "List-ID": `${subscriptionGroupName} <${subscriptionGroupId}.${domain}>`,
  });
}

export async function upsertEmailProvider({
  workspaceId,
  config,
  setDefault,
}: UpsertEmailProviderRequest): Promise<PersistedEmailProvider> {
  const secretName = EMAIL_PROVIDER_TYPE_TO_SECRET_NAME[config.type];
  return db().transaction(async (tx) => {
    const secret = await upsert({
      table: dbSecret,
      tx,
      target: [dbSecret.workspaceId, dbSecret.name],
      values: {
        workspaceId,
        name: secretName,
        configValue: config,
      },
      set: {
        configValue: config,
      },
    }).then(unwrap);

    const existingEmailProvider = await tx.query.emailProvider.findFirst({
      where: and(
        eq(dbEmailProvider.workspaceId, workspaceId),
        eq(dbEmailProvider.type, config.type),
      ),
    });

    let emailProvider: EmailProvider;
    if (existingEmailProvider) {
      emailProvider = existingEmailProvider;
    } else {
      const [newEmailProvider] = await tx
        .insert(dbEmailProvider)
        .values({
          workspaceId,
          type: config.type,
          secretId: secret.id,
        })
        .returning();

      if (!newEmailProvider) {
        throw new Error("Failed to upsert email provider");
      }
      emailProvider = newEmailProvider;
    }

    if (setDefault) {
      await upsert({
        table: dbDefaultEmailProvider,
        tx,
        target: [dbDefaultEmailProvider.workspaceId],
        values: {
          workspaceId,
          emailProviderId: emailProvider.id,
        },
        set: {
          emailProviderId: emailProvider.id,
        },
      }).then(unwrap);
    }
    return {
      workspaceId: emailProvider.workspaceId,
      id: emailProvider.id,
      type: config.type,
    };
  });
}

export async function getOrCreateEmailProviders({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<PersistedEmailProvider[]> {
  const existingProviders = await db().query.emailProvider.findMany({
    where: and(
      eq(dbEmailProvider.workspaceId, workspaceId),
      inArray(dbEmailProvider.type, WORKSPACE_PROVIDER_TYPES),
    ),
    columns: { id: true, type: true },
  });
  const emailProviders: PersistedEmailProvider[] = [];
  const upsertPromises: Promise<void>[] = [];
  for (const type of WORKSPACE_PROVIDER_TYPES) {
    const existing = existingProviders.find((provider) => provider.type === type);
    if (existing) {
      emailProviders.push({ id: existing.id, workspaceId, type });
      continue;
    }
    upsertPromises.push(
      upsertEmailProvider({ workspaceId, config: { type } }).then((provider) => {
        emailProviders.push(provider);
      }),
    );
  }
  await Promise.all(upsertPromises);
  return emailProviders;
}

export {
  defaultEmailBody,
  defaultEmailDefinition,
} from "isomorphic-lib/src/email";

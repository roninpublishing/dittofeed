import axios, { AxiosError, AxiosHeaders } from "axios";
import { randomUUID } from "crypto";
import { and, eq, SQL } from "drizzle-orm";
import { toMjml } from "emailo/src/toMjml";
import { CHANNEL_IDENTIFIERS } from "isomorphic-lib/src/channels";
import { MESSAGE_ID_HEADER, SecretNames } from "isomorphic-lib/src/constants";
import { messageTemplateDraftToDefinition } from "isomorphic-lib/src/messageTemplates";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  jsonParseSafe,
  schemaValidateWithErr,
} from "isomorphic-lib/src/resultHandling/schemaValidation";
import { assertUnreachable } from "isomorphic-lib/src/typeAssertions";
import { err, ok, Result } from "neverthrow";
import { PostgresError } from "pg-error-enum";
import * as R from "remeda";
import { omit } from "remeda";
import { Overwrite } from "utility-types";
import { validate as validateUuid } from "uuid";

import { submitBatch } from "./apps/batch";
import { getObject, storage } from "./blobStorage";
import { db, TxQueryError, txQueryResult } from "./db";
import {
  messageTemplate as dbMessageTemplate,
  secret as dbSecret,
  subscriptionGroup as dbSubscriptionGroup,
  userProperty as dbUserProperty,
} from "./db/schema";
import config from "./config";
import { renderLiquid } from "./liquid";
import { storeEmailForViewInBrowser } from "./viewInBrowser";
import logger from "./logger";
import {
  constructUnsubscribeHeaders,
  UnsubscribeHeaders,
} from "./messaging/email";
import { getNewsletterEmailContext, NewsletterEmailContext, sendNewsletterEmail } from "./newsletterDelivery";
import { NewsletterInfrastructureError, resolveNewsletterSelection } from "./newsletterInfrastructure";
import { withSpan } from "./openTelemetry";
import {
  getSubscriptionGroupDetails,
  getSubscriptionGroupsWithAssignments,
  inSubscriptionGroup,
  SubscriptionGroupDetails,
} from "./subscriptionGroups";
import {
  AppDataFileInternal,
  AppFileType,
  BackendMessageSendResult,
  BadWorkspaceConfigurationType,
  BatchMessageUsersRequest,
  BatchMessageUsersResponse,
  BatchMessageUsersResult,
  BatchMessageUsersResultTypeEnum,
  ChannelType,
  EmailContentsType,
  EmailProviderType,
  EmailProviderTypeSchema,
  EspSelection,
  EventType,
  InternalEventType,
  KnownBatchTrackData,
  MessageSendFailure,
  MessageSkippedType,
  MessageTags,
  MessageTemplate,
  MessageTemplateRenderError,
  MessageTemplateResource,
  MessageTemplateResourceDefinition,
  MessageTemplateResourceDraft,
  MessageTemplateTestRequest,
  MessageWebhookServiceFailure,
  MessageWebhookSuccess,
  MobilePushProviderType,
  NonRetryableMessageSendFailure,
  ParsedWebhookBody,
  SubscriptionChange,
  SubscriptionGroupType,
  TrackData,
  UpsertMessageTemplateResource,
  UpsertMessageTemplateValidationError,
  UpsertMessageTemplateValidationErrorType,
  WebhookConfig,
  WebhookResponse,
  WebhookSecret,
} from "./types";
import { UserPropertyAssignments } from "./userProperties";
import { getUsers } from "./users";
import { hasRetiredSmsChannel } from "./smsCutover";

export function enrichMessageTemplate({
  id,
  name,
  workspaceId,
  definition,
  draft,
  updatedAt,
}: Overwrite<
  MessageTemplate,
  {
    draft?: unknown;
    definition?: unknown;
  }
>): Result<MessageTemplateResource, Error> {
  const enrichedDefinition = definition
    ? schemaValidateWithErr(definition, MessageTemplateResourceDefinition)
    : ok(undefined);
  const enrichedDraft = draft
    ? schemaValidateWithErr(draft, MessageTemplateResourceDraft)
    : ok(undefined);
  if (enrichedDefinition.isErr()) {
    return err(enrichedDefinition.error);
  }
  if (enrichedDraft.isErr()) {
    return err(enrichedDraft.error);
  }
  const type = enrichedDefinition.value?.type ?? enrichedDraft.value?.type;
  if (!type) {
    return err(
      new Error("message template has neither a draft nor a definition"),
    );
  }
  const enriched: MessageTemplateResource = {
    id,
    name,
    workspaceId,
    type,
    updatedAt: Number(updatedAt),
    ...(enrichedDefinition.value
      ? { definition: enrichedDefinition.value }
      : {}),
    ...(enrichedDraft.value ? { draft: enrichedDraft.value } : {}),
  };

  return ok(enriched);
}

export async function findMessageTemplate({
  id,
  workspaceId,
  channel,
}: {
  id: string;
  workspaceId: string;
  channel: ChannelType;
}): Promise<Result<MessageTemplateResource | null, Error>> {
  if (!validateUuid(id)) {
    logger().info({ id, channel }, "Invalid message template id");
    return ok(null);
  }
  const template = await db().query.messageTemplate.findFirst({
    where: and(
      eq(dbMessageTemplate.id, id),
      eq(dbMessageTemplate.workspaceId, workspaceId),
    ),
  });
  if (!template) {
    return ok(null);
  }

  return enrichMessageTemplate(template).map((t) => {
    const definition = t.draft ?? t.definition ?? null;
    return definition && definition.type === channel ? t : null;
  });
}

function doesRequireDraftReset({
  priorDefinition,
  newDefinition,
}: {
  priorDefinition: MessageTemplateResourceDefinition;
  newDefinition: MessageTemplateResourceDefinition;
}): boolean {
  if (priorDefinition.type !== newDefinition.type) {
    return true;
  }
  if (
    newDefinition.type === ChannelType.Email &&
    priorDefinition.type === ChannelType.Email &&
    newDefinition.emailContentsType !== priorDefinition.emailContentsType
  ) {
    return true;
  }
  return false;
}

export async function upsertMessageTemplate(
  data: UpsertMessageTemplateResource,
): Promise<
  Result<MessageTemplateResource, UpsertMessageTemplateValidationError>
> {
  if (data.id && !validateUuid(data.id)) {
    return err({
      type: UpsertMessageTemplateValidationErrorType.IdError,
      message: "Invalid message template id, must be a valid v4 UUID",
    });
  }

  // Validate identifierKey if specified for email templates.
  // Webhook templates already had identifierKey support and use built-in properties like "id"
  const definitionToValidate = data.definition ?? data.draft;
  if (
    definitionToValidate &&
    definitionToValidate.type === ChannelType.Email &&
    "identifierKey" in definitionToValidate &&
    definitionToValidate.identifierKey
  ) {
    const { identifierKey } = definitionToValidate;
    const userPropertyExists = await db().query.userProperty.findFirst({
      where: and(
        eq(dbUserProperty.workspaceId, data.workspaceId),
        eq(dbUserProperty.name, identifierKey),
      ),
    });
    if (!userPropertyExists) {
      return err({
        type: UpsertMessageTemplateValidationErrorType.InvalidIdentifierKey,
        message: `User property "${identifierKey}" does not exist in the workspace`,
        identifierKey,
      });
    }
  }

  const txResult: Result<MessageTemplate, TxQueryError> =
    await db().transaction(async (tx) => {
      const findFirstConditions: SQL[] = [
        eq(dbMessageTemplate.workspaceId, data.workspaceId),
      ];
      if (data.id) {
        findFirstConditions.push(eq(dbMessageTemplate.id, data.id));
      } else {
        findFirstConditions.push(eq(dbMessageTemplate.name, data.name));
      }
      const existingTemplate = await tx.query.messageTemplate.findFirst({
        where: and(...findFirstConditions),
      });
      if (!existingTemplate) {
        const createResult = await txQueryResult(
          tx
            .insert(dbMessageTemplate)
            .values({
              id: data.id,
              workspaceId: data.workspaceId,
              name: data.name,
              definition: data.definition,
              draft: data.draft,
              resourceType: data.resourceType,
            })
            .returning(),
        );
        if (createResult.isErr()) {
          return err(createResult.error);
        }
        const createdTemplate = createResult.value[0];
        if (!createdTemplate) {
          logger().error(
            {
              workspaceId: data.workspaceId,
              name: data.name,
            },
            "message template not found",
          );
          throw new Error("message template not found");
        }
        return ok(createdTemplate);
      }
      const existingDefinition = schemaValidateWithErr(
        existingTemplate.definition,
        MessageTemplateResourceDefinition,
      );
      if (existingDefinition.isErr()) {
        logger().error(
          {
            err: existingDefinition.error,
            id: existingTemplate.id,
            workspaceId: data.workspaceId,
          },
          "existing message template definition is invalid",
        );
        throw new Error("existing message template definition is invalid");
      }
      const requiresDraftReset =
        data.definition !== undefined &&
        doesRequireDraftReset({
          priorDefinition: existingDefinition.value,
          newDefinition: data.definition,
        });
      const updateResult = await txQueryResult(
        tx
          .update(dbMessageTemplate)
          .set({
            name: data.name,
            definition: data.definition,
            draft: requiresDraftReset ? null : data.draft,
            resourceType: data.resourceType,
          })
          .where(eq(dbMessageTemplate.id, existingTemplate.id))
          .returning(),
      );
      if (updateResult.isErr()) {
        return err(updateResult.error);
      }
      const updatedTemplate = updateResult.value[0];
      if (!updatedTemplate) {
        logger().error(
          {
            workspaceId: data.workspaceId,
            id: existingTemplate.id,
          },
          "message template not found",
        );
        throw new Error("message template not found");
      }
      return ok(updatedTemplate);
    });
  if (txResult.isErr()) {
    if (
      txResult.error.code === PostgresError.UNIQUE_VIOLATION ||
      txResult.error.code === PostgresError.FOREIGN_KEY_VIOLATION
    ) {
      return err({
        type: UpsertMessageTemplateValidationErrorType.UniqueConstraintViolation,
        message:
          "Names must be unique in workspace. Id's must be globally unique.",
      });
    }
    logger().error(
      {
        err: txResult.error,
        data,
      },
      "Failed to upsert message template",
    );
    throw new Error(
      `Failed to upsert message template: code=${txResult.error.code}`,
    );
  }

  const messageTemplate = txResult.value;
  return ok(unwrap(enrichMessageTemplate(messageTemplate)));
}

export async function findMessageTemplates({
  workspaceId,
  includeInternal,
}: {
  workspaceId: string;
  includeInternal?: boolean;
}): Promise<MessageTemplateResource[]> {
  const conditions: SQL[] = [eq(dbMessageTemplate.workspaceId, workspaceId)];
  if (!includeInternal) {
    conditions.push(eq(dbMessageTemplate.resourceType, "Declarative"));
  }
  const messageTemplates = await db().query.messageTemplate.findMany({
    where: and(...conditions),
  });
  return messageTemplates.flatMap((mt) => {
    if (hasRetiredSmsChannel(mt.definition) || hasRetiredSmsChannel(mt.draft)) {
      logger().warn(
        { templateId: mt.id, workspaceId },
        "Excluding retired SMS template; resolve it before cutover",
      );
      return [];
    }
    return [unwrap(enrichMessageTemplate(mt))];
  });
}

async function getSendMessageModels({
  templateId,
  workspaceId,
  channel,
  subscriptionGroupDetails,
  useDraft,
}: {
  workspaceId: string;
  templateId: string;
  channel: ChannelType;
  subscriptionGroupDetails?: Omit<SubscriptionGroupDetails, "name">;
  useDraft?: boolean;
}): Promise<
  Result<
    {
      messageTemplateDefinition: MessageTemplateResourceDefinition;
      subscriptionGroupSecret: string | null;
    },
    MessageSendFailure
  >
> {
  if (
    subscriptionGroupDetails &&
    !inSubscriptionGroup(subscriptionGroupDetails)
  ) {
    const { type: subscriptionGroupType, action: subscriptionGroupAction } =
      subscriptionGroupDetails;
    return err({
      type: InternalEventType.MessageSkipped,
      variant: {
        type: MessageSkippedType.SubscriptionState,
        action: subscriptionGroupAction,
        subscriptionGroupType,
      },
    });
  }

  const [messageTemplateResult, subscriptionGroupSecret] = await Promise.all([
    findMessageTemplate({
      id: templateId,
      workspaceId,
      channel,
    }),
    db().query.secret.findFirst({
      where: and(
        eq(dbSecret.workspaceId, workspaceId),
        eq(dbSecret.name, SecretNames.Subscription),
      ),
    }),
  ]);
  if (messageTemplateResult.isErr()) {
    const message = "failed to parse message template definition";
    logger().error(
      {
        templateId,
        workspaceId,
        err: messageTemplateResult.error,
      },
      message,
    );
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateMisconfigured,
        message,
      },
    });
  }
  const messageTemplate = messageTemplateResult.value;
  if (!messageTemplate) {
    logger().error(
      {
        templateId,
        workspaceId,
      },
      "message template not found",
    );
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateNotFound,
      },
    });
  }
  const definitionFromDraft =
    useDraft && messageTemplate.draft
      ? messageTemplateDraftToDefinition(messageTemplate.draft).unwrapOr(null)
      : null;
  const messageTemplateDefinition: MessageTemplateResourceDefinition | null =
    definitionFromDraft ?? messageTemplate.definition ?? null;

  if (!messageTemplateDefinition) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateNotFound,
      },
    });
  }
  return ok({
    messageTemplateDefinition,
    subscriptionGroupSecret: subscriptionGroupSecret?.value ?? null,
  });
}

export type SubscriptionGroupDetailsWithName = SubscriptionGroupDetails & {
  name: string;
};

export interface SendMessageParametersBase {
  workspaceId: string;
  userId: string;
  templateId: string;
  userPropertyAssignments: UserPropertyAssignments;
  subscriptionGroupDetails?: SubscriptionGroupDetailsWithName;
  messageTags?: MessageTags;
  useDraft: boolean;
  isPreview?: boolean;
}

export interface SendMessageParametersEmail extends SendMessageParametersBase {
  channel: (typeof ChannelType)["Email"];
  providerOverride?: EmailProviderTypeSchema;
  espSelection?: EspSelection | null;
}

export interface SendMessageParametersMobilePush
  extends SendMessageParametersBase {
  channel: (typeof ChannelType)["MobilePush"];
  provider?: MobilePushProviderType;
}

export interface SendMessageParametersWebhook
  extends SendMessageParametersBase {
  channel: (typeof ChannelType)["Webhook"];
}

export type SendMessageParameters =
  | SendMessageParametersEmail
  | SendMessageParametersWebhook
  | SendMessageParametersMobilePush;

type TemplateDictionary<T> = {
  [K in keyof T]: {
    contents?: string;
    mjml?: boolean;
  };
};

interface Attachment {
  mimeType: string;
  data: string;
  name: string;
}

function renderValues<T extends TemplateDictionary<T>>({
  templates,
  ...rest
}: Omit<Parameters<typeof renderLiquid>[0], "template"> & {
  templates: T;
}): Result<
  { [K in keyof T]: T[K]["contents"] },
  {
    field: string;
    error: string;
  }
> {
  const result: Record<string, string> = {};

  for (const key in templates) {
    if (Object.prototype.hasOwnProperty.call(templates, key)) {
      const { contents: template, mjml } = templates[key];
      try {
        result[key] = renderLiquid({
          ...rest,
          template,
          mjml,
        });
      } catch (e) {
        const error = e as Error;
        return err({
          field: key,
          error: error.message,
        });
      }
    }
  }

  const coercedResult = result as { [K in keyof T]: string };
  return ok(coercedResult);
}

/**
 * Resolve optional newsletter defaults at confirmation, not once per recipient.
 * null records the deliberate absence of an ESP selection for native providers.
 */
export async function confirmEmailSelection({
  workspaceId,
  providerOverride,
  espSelection,
}: {
  workspaceId: string;
  providerOverride?: EmailProviderTypeSchema;
  espSelection?: EspSelection | null;
}): Promise<EspSelection | null> {
  const context = await getNewsletterEmailContext(workspaceId);
  if (providerOverride !== undefined && providerOverride !== EmailProviderType.SendGrid) {
    if (espSelection) {
      throw new NewsletterInfrastructureError(400, "esp_selection_provider_conflict");
    }
    if (context) {
      throw new NewsletterInfrastructureError(400, "unsupported_newsletter_provider");
    }
    return null;
  }
  if (!context) {
    if (espSelection) {
      throw new NewsletterInfrastructureError(400, "esp_selection_requires_newsletter");
    }
    return null;
  }
  return (await resolveNewsletterSelection({
    publisherId: context.publisherId,
    newsletterId: workspaceId,
    selection: espSelection,
  })).selection;
}

export async function sendEmail({
  workspaceId,
  templateId,
  userPropertyAssignments,
  subscriptionGroupDetails,
  messageTags,
  userId,
  providerOverride,
  useDraft,
  isPreview,
  espSelection,
}: Omit<
  SendMessageParametersEmail,
  "channel"
>): Promise<BackendMessageSendResult> {
  let newsletterContext: NewsletterEmailContext | null;
  try {
    newsletterContext = await getNewsletterEmailContext(workspaceId);
    if (providerOverride !== undefined && providerOverride !== EmailProviderType.SendGrid) {
      if (espSelection) {
        throw new NewsletterInfrastructureError(400, "esp_selection_provider_conflict");
      }
      if (newsletterContext) {
        throw new NewsletterInfrastructureError(400, "unsupported_newsletter_provider");
      }
    } else if (espSelection && !newsletterContext) {
      throw new NewsletterInfrastructureError(400, "esp_selection_requires_newsletter");
    }
  } catch (error) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageServiceProviderMisconfigured,
        message: error instanceof Error ? error.message : "Invalid ESP selection",
      },
    });
  }
  if (!newsletterContext) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageServiceProviderMisconfigured,
        message: "Email sending requires a newsletter and tracked recipient send",
      },
    });
  }
  if (!messageTags?.messageId) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageServiceProviderMisconfigured,
        message: "Newsletter email requires a stable logical message ID",
      },
    });
  }
  const [getSendModelsResult, viewInBrowserSecretRecord] =
    await Promise.all([
      getSendMessageModels({
        workspaceId,
        templateId,
        channel: ChannelType.Email,
        useDraft,
        subscriptionGroupDetails,
      }),
      db().query.secret.findFirst({
        where: and(
          eq(dbSecret.workspaceId, workspaceId),
          eq(dbSecret.name, SecretNames.ViewInBrowser),
        ),
      }),
    ]);
  if (getSendModelsResult.isErr()) {
    return err(getSendModelsResult.error);
  }
  const { messageTemplateDefinition, subscriptionGroupSecret } =
    getSendModelsResult.value;
  const viewInBrowserSecret = viewInBrowserSecretRecord?.value;

  if (messageTemplateDefinition.type !== ChannelType.Email) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateMisconfigured,
        message: "message template is not an email template",
      },
    });
  }
  const identifierKey =
    messageTemplateDefinition.identifierKey ??
    CHANNEL_IDENTIFIERS[ChannelType.Email];
  let emailBody: string;
  if (
    messageTemplateDefinition.emailContentsType === EmailContentsType.LowCode
  ) {
    const mjml = toMjml({
      content: messageTemplateDefinition.body,
      mode: "render",
    });
    emailBody = mjml;
  } else {
    emailBody = messageTemplateDefinition.body;
  }
  const secrets: Record<string, string> = {};
  if (subscriptionGroupSecret) {
    secrets[SecretNames.Subscription] = subscriptionGroupSecret;
  }
  if (viewInBrowserSecret) {
    secrets[SecretNames.ViewInBrowser] = viewInBrowserSecret;
  }

  const renderedValuesResult = renderValues({
    userProperties: userPropertyAssignments,
    identifierKey,
    subscriptionGroupId: subscriptionGroupDetails?.id,
    workspaceId,
    tags: messageTags,
    isPreview,
    messageId: messageTags?.messageId,
    templates: {
      from: {
        contents: messageTemplateDefinition.from,
      },
      subject: {
        contents: messageTemplateDefinition.subject,
      },
      body: {
        contents: emailBody,
        mjml: true,
      },
      replyTo: {
        contents: messageTemplateDefinition.replyTo,
      },
      name: {
        contents: messageTemplateDefinition.name,
      },
      cc: {
        contents: messageTemplateDefinition.cc,
      },
      bcc: {
        contents: messageTemplateDefinition.bcc,
      },
    },
    secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
  });

  if (renderedValuesResult.isErr()) {
    const { error, field } = renderedValuesResult.error;
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateRenderError,
        field,
        error,
      },
    });
  }
  const identifier = userPropertyAssignments[identifierKey];
  if (!identifier || typeof identifier !== "string") {
    return err({
      type: InternalEventType.MessageSkipped,
      variant: {
        type: MessageSkippedType.MissingIdentifier,
        identifierKey,
      },
    });
  }
  const {
    from,
    subject,
    body,
    replyTo: baseReplyTo,
    name: baseName,
    cc: unsplitCc,
    bcc: unsplitBcc,
  } = renderedValuesResult.value;
  const replyTo = !baseReplyTo?.length ? undefined : baseReplyTo;
  const emailName = !baseName?.length ? undefined : baseName;
  const cc = unsplitCc?.split(",").flatMap((email) => {
    const trimmed = email.trim();
    return trimmed.length ? trimmed : [];
  });
  const bcc = unsplitBcc?.split(",").flatMap((email) => {
    const trimmed = email.trim();
    return trimmed.length ? trimmed : [];
  });
  const to = identifier;

  // Store email for view-in-browser feature if enabled and messageId is available
  if (config().enableBlobStorage && messageTags?.messageId) {
    const storeResult = await storeEmailForViewInBrowser({
      workspaceId,
      messageId: messageTags.messageId,
      body,
    });
    if (storeResult.isErr()) {
      logger().warn(
        {
          workspaceId,
          messageId: messageTags.messageId,
          err: storeResult.error,
        },
        "Failed to store email for view-in-browser",
      );
    }
  }

  let customHeaders: Record<string, string> | undefined;
  if (messageTemplateDefinition.headers) {
    const headersToRender: Record<
      string,
      {
        contents: string;
      }
    > = {};
    for (const header of messageTemplateDefinition.headers) {
      headersToRender[header.name] = {
        contents: header.value,
      };
    }
    const renderedCustomHeaders = renderValues({
      userProperties: userPropertyAssignments,
      identifierKey,
      subscriptionGroupId: subscriptionGroupDetails?.id,
      workspaceId,
      tags: messageTags,
      isPreview,
      templates: headersToRender,
    });
    if (renderedCustomHeaders.isErr()) {
      const { error, field } = renderedCustomHeaders.error;
      return err({
        type: InternalEventType.BadWorkspaceConfiguration,
        variant: {
          type: BadWorkspaceConfigurationType.MessageTemplateRenderError,
          field,
          error,
        },
      });
    }
    customHeaders = renderedCustomHeaders.value;
  }

  const unsubscribeHeadersResult: Result<
    UnsubscribeHeaders,
    MessageTemplateRenderError
  > | null =
    subscriptionGroupDetails && subscriptionGroupSecret
      ? constructUnsubscribeHeaders({
          to,
          from,
          userId,
          identifierKey,
          subscriptionGroupSecret,
          subscriptionGroupName: subscriptionGroupDetails.name,
          workspaceId,
          subscriptionGroupId: subscriptionGroupDetails.id,
        })
      : null;

  // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
  if (unsubscribeHeadersResult && unsubscribeHeadersResult.isErr()) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: unsubscribeHeadersResult.error,
    });
  }
  const unsubscribeHeaders = unsubscribeHeadersResult?.value as
    | Record<string, string>
    | undefined;

  const headers = {
    ...customHeaders,
    ...unsubscribeHeaders,
  };

  let attachments: Attachment[] | undefined;
  if (
    messageTemplateDefinition.attachmentUserProperties?.length &&
    messageTags
  ) {
    const s = storage();

    const attachmentPromises =
      messageTemplateDefinition.attachmentUserProperties.map(
        async (attachmentProperty) => {
          const assignment = userPropertyAssignments[attachmentProperty];
          const file = schemaValidateWithErr(assignment, AppDataFileInternal);
          if (file.isErr()) {
            logger().error(
              {
                err: file.error,
                assignment,
                attachmentProperty,
                templateId,
                workspaceId,
              },
              "error validating attachment user property",
            );
            return [];
          }

          const { name, mimeType } = file.value;
          let data: string;

          switch (file.value.type) {
            case AppFileType.Base64Encoded: {
              // For Base64EncodedFile, use the data directly
              data = file.value.data;
              break;
            }
            case AppFileType.BlobStorage: {
              // For BlobStorageFile, fetch from storage
              const object = await getObject(s, {
                key: file.value.key,
              });
              if (!object) {
                logger().error(
                  {
                    key: file.value.key,
                    workspaceId,
                    mimeType,
                    name,
                    templateId,
                  },
                  "error getting attachment object",
                );
                return [];
              }
              data = object.text;
              break;
            }
            default: {
              assertUnreachable(file.value);
            }
          }

          const attachment: Attachment = {
            mimeType,
            data,
            name,
          };
          return attachment;
        },
      );

    attachments = (await Promise.all(attachmentPromises)).flat();
  }
  // To set on the message sent event
  const attachmentsSent = attachments?.map(({ name, mimeType }) => ({
    name,
    mimeType,
  }));

  return sendNewsletterEmail({
    workspaceId,
    publisherId: newsletterContext.publisherId,
    // Retries reach durable identity before resolving current readiness/defaults.
    espSelection,
    userId,
    logicalMessageId: messageTags.messageId,
    tags: messageTags,
    subscriptionGroupId: subscriptionGroupDetails?.id,
    from,
    recipients: [to, ...(cc ?? []), ...(bcc ?? [])],
    mailData: {
      to, from: { email: from, name: emailName }, subject, html: body,
      replyTo, headers, cc, bcc,
      attachments: attachments?.map((attachment) => ({
        content: attachment.data, type: attachment.mimeType, filename: attachment.name,
      })),
      customArgs: { ...messageTags, workspaceId, userId, templateId },
    },
    success: {
      type: InternalEventType.MessageSent,
      variant: {
        type: ChannelType.Email, from, body, to, subject, headers, replyTo,
        cc: unsplitCc, bcc: unsplitBcc, name: emailName, attachments: attachmentsSent,
        provider: { type: EmailProviderType.SendGrid },
      },
    },
  });
}

export async function sendWebhook({
  workspaceId,
  templateId,
  userPropertyAssignments,
  subscriptionGroupDetails,
  useDraft,
  messageTags,
  isPreview,
}: Omit<
  SendMessageParametersWebhook,
  "channel"
>): Promise<BackendMessageSendResult> {
  try {
    await getNewsletterEmailContext(workspaceId);
  } catch {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageServiceProviderMisconfigured,
        message: "Publisher workspaces cannot send messages",
      },
    });
  }
  const [getSendModelsResult, secret] = await Promise.all([
    getSendMessageModels({
      workspaceId,
      templateId,
      channel: ChannelType.Webhook,
      useDraft,
      subscriptionGroupDetails,
    }),
    db().query.secret.findFirst({
      where: and(
        eq(dbSecret.workspaceId, workspaceId),
        eq(dbSecret.name, SecretNames.Webhook),
      ),
    }),
  ]);
  if (getSendModelsResult.isErr()) {
    return err(getSendModelsResult.error);
  }
  const { messageTemplateDefinition, subscriptionGroupSecret } =
    getSendModelsResult.value;

  const parsedConfigResult: Record<string, string> = secret?.configValue
    ? schemaValidateWithErr(secret.configValue, WebhookSecret)
        .map((c) => R.omit(c, ["type"]))
        .mapErr((e) => {
          logger().error(
            {
              ...messageTags,
              err: e,
            },
            "failed to parse webhook secret",
          );
          return e;
        })
        .unwrapOr({})
    : {};

  if (messageTemplateDefinition.type !== ChannelType.Webhook) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateMisconfigured,
        message: "message template is not webhook template",
      },
    });
  }
  const { identifierKey } = messageTemplateDefinition;
  const secrets: Record<string, string> = parsedConfigResult;

  if (subscriptionGroupSecret) {
    secrets[SecretNames.Subscription] = subscriptionGroupSecret;
  }

  const renderedBody = renderValues({
    userProperties: userPropertyAssignments,
    identifierKey,
    subscriptionGroupId: subscriptionGroupDetails?.id,
    workspaceId,
    secrets,
    tags: messageTags,
    isPreview,
    templates: {
      body: {
        contents: messageTemplateDefinition.body,
      },
    },
  });
  if (renderedBody.isErr()) {
    const { error, field } = renderedBody.error;
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateRenderError,
        field,
        error,
      },
    });
  }
  const parsedBody = jsonParseSafe(renderedBody.value.body);
  if (parsedBody.isErr()) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateRenderError,
        field: "body",
        error: "Failed to parse webhook json payload",
      },
    });
  }

  const validatedBody = schemaValidateWithErr(
    parsedBody.value,
    ParsedWebhookBody,
  );
  if (validatedBody.isErr()) {
    return err({
      type: InternalEventType.BadWorkspaceConfiguration,
      variant: {
        type: BadWorkspaceConfigurationType.MessageTemplateRenderError,
        field: "body",
        error: `Failed to validate webhook json payload`,
      },
    });
  }

  const { config: renderedConfig, secret: renderedSecret } =
    validatedBody.value;

  const renderedConfigHeaders: Record<string, string> =
    renderedConfig.headers ?? {};

  if (messageTags) {
    renderedConfigHeaders[MESSAGE_ID_HEADER] = messageTags.messageId;
  }

  const renderedHeaders = {
    ...renderedConfigHeaders,
    ...(renderedSecret?.headers ?? {}),
  };

  const rawIdentifier = userPropertyAssignments[identifierKey];
  let identifier: string | null;
  switch (typeof rawIdentifier) {
    case "string":
      identifier = rawIdentifier;
      break;
    case "number":
      identifier = String(rawIdentifier);
      break;
    default:
      identifier = null;
      break;
  }

  if (!identifier) {
    return err({
      type: InternalEventType.MessageSkipped,
      variant: {
        type: MessageSkippedType.MissingIdentifier,
        identifierKey,
      },
    });
  }

  try {
    const data: unknown = renderedSecret?.data ?? renderedConfig.data;
    const params: unknown = renderedSecret?.params ?? renderedConfig.params;
    const method = renderedSecret?.method ?? renderedConfig.method;
    const responseType =
      renderedSecret?.responseType ?? renderedConfig.responseType;
    const url = renderedSecret?.url ?? renderedConfig.url;

    const response = await axios.request({
      url,
      method,
      params,
      data,
      responseType,
      headers: renderedHeaders,
    });

    const axiosHeaders =
      response.headers instanceof AxiosHeaders
        ? response.headers.toJSON()
        : response.headers;

    return ok({
      type: InternalEventType.MessageSent,
      variant: {
        type: ChannelType.Webhook,
        to: identifier,
        request: {
          ...renderedConfig,
          headers: renderedConfigHeaders,
        } satisfies WebhookConfig,
        response: {
          status: response.status,
          headers: axiosHeaders as WebhookResponse["headers"] | undefined,
          body: response.data,
        } satisfies WebhookResponse,
      } satisfies MessageWebhookSuccess,
    });
  } catch (e) {
    const { response: axiosResponse, code } = e as AxiosError;
    let response: WebhookResponse | undefined;
    if (axiosResponse && Object.keys(axiosResponse).length > 0) {
      const responseHeaders = axiosResponse.headers as
        | Record<string, string>
        | undefined;

      response = {
        status: axiosResponse.status,
        body: axiosResponse.data,
        headers: responseHeaders,
      };
    }
    return err({
      type: InternalEventType.MessageFailure,
      variant: {
        type: ChannelType.Webhook,
        code,
        response,
      } satisfies MessageWebhookServiceFailure,
    });
  }
}

export type Sender = (
  params: SendMessageParameters,
) => Promise<BackendMessageSendResult>;

/**
 * Send a message to a channel
 * Re-tryable errors will be thrown. Non-retryable errors will be returned as
 * error objects.
 * @param params - The parameters for the message
 * @returns The result of the message send
 */
export async function sendMessage(
  params: SendMessageParameters,
): Promise<BackendMessageSendResult> {
  const channel: string = params.channel;
  return withSpan({ name: "sendMessage" }, async (span) => {
    span.setAttributes({
      channel: params.channel,
      workspaceId: params.workspaceId,
      templateId: params.templateId,
      journeyId: params.messageTags?.journeyId,
      messageId: params.messageTags?.messageId,
      nodeId: params.messageTags?.nodeId,
    });
    switch (params.channel) {
      case ChannelType.Email:
        return sendEmail(params);
      case ChannelType.MobilePush:
        throw new Error("not implemented");
      case ChannelType.Webhook:
        return sendWebhook(params);
      default:
        return err({
          type: InternalEventType.BadWorkspaceConfiguration,
          variant: {
            type: BadWorkspaceConfigurationType.MessageTemplateMisconfigured,
            message: `Unsupported message channel: ${channel}`,
          },
        });
    }
  });
}

export async function testTemplate(
  request: MessageTemplateTestRequest,
): Promise<BackendMessageSendResult> {
  // Look up the first subscription group for the template's channel
  const messageTemplate = await db().query.messageTemplate.findFirst({
    where: and(
      eq(dbMessageTemplate.id, request.templateId),
      eq(dbMessageTemplate.workspaceId, request.workspaceId),
    ),
  });

  let firstSubscriptionGroup:
    | { id: string; name: string; type: "OptIn" | "OptOut" }
    | undefined;
  if (messageTemplate) {
    firstSubscriptionGroup = await db().query.subscriptionGroup.findFirst({
      where: and(
        eq(dbSubscriptionGroup.workspaceId, request.workspaceId),
        eq(dbSubscriptionGroup.channel, request.channel),
      ),
      orderBy: dbSubscriptionGroup.createdAt,
      columns: { id: true, name: true, type: true },
    });
  }
  const messageTags: MessageTags = {
    ...(request.tags ?? {}),
    messageId: request.tags?.messageId ?? randomUUID(),
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const userId = request.userProperties.id;
  if (typeof userId === "string") {
    messageTags.userId = userId;
  }
  const baseSendMessageParams: Omit<
    SendMessageParameters,
    "provider" | "channel"
  > = {
    workspaceId: request.workspaceId,
    templateId: request.templateId,
    userId: messageTags.userId ?? "test-user",
    userPropertyAssignments: request.userProperties,
    useDraft: true,
    messageTags,
    isPreview: true,
    ...(firstSubscriptionGroup && {
      subscriptionGroupDetails: {
        id: firstSubscriptionGroup.id,
        name: firstSubscriptionGroup.name,
        action: SubscriptionChange.Subscribe,
        type:
          firstSubscriptionGroup.type === "OptIn"
            ? SubscriptionGroupType.OptIn
            : SubscriptionGroupType.OptOut,
      },
    }),
  };
  let sendMessageParams: SendMessageParameters;
  switch (request.channel) {
    case ChannelType.Email: {
      sendMessageParams = {
        ...baseSendMessageParams,
        channel: request.channel,
        providerOverride: request.provider,
        espSelection: request.espSelection,
      };
      break;
    }
    case ChannelType.MobilePush: {
      sendMessageParams = {
        ...baseSendMessageParams,
        provider: request.provider,
        channel: request.channel,
      };
      break;
    }
    case ChannelType.Webhook: {
      sendMessageParams = {
        ...baseSendMessageParams,
        channel: request.channel,
      };
      break;
    }
    default:
      assertUnreachable(request);
  }
  return sendMessage(sendMessageParams);
}

export function isNonRetryableError(
  error: MessageSendFailure,
): error is NonRetryableMessageSendFailure {
  switch (error.type) {
    case InternalEventType.MessageFailure:
      return true;
    case InternalEventType.BadWorkspaceConfiguration:
      return true;
    case InternalEventType.MessageSkipped:
      return false;
    default:
      assertUnreachable(error);
  }
}

type MessageSendResultWithResponseItem = [
  BatchMessageUsersResult,
  BackendMessageSendResult | null,
];

export async function batchMessageUsers(
  params: BatchMessageUsersRequest,
): Promise<BatchMessageUsersResponse> {
  const { workspaceId, templateId, subscriptionGroupId, users } = params;
  const espSelection = params.channel === ChannelType.Email
    ? await confirmEmailSelection({
        workspaceId,
        providerOverride: params.provider,
        espSelection: params.espSelection,
      })
    : null;

  // Collect all user IDs for bulk operations
  const userIds = users.map((user) => user.id);

  // Get subscription group details and user property assignments for all users in parallel
  const [subscriptionGroupData, usersResult] = await Promise.all([
    subscriptionGroupId
      ? getSubscriptionGroupsWithAssignments({
          workspaceId,
          subscriptionGroupIds: [subscriptionGroupId],
          userIds,
        })
      : Promise.resolve([]),

    // Use batched getUsers to get user property assignments for all users at once
    getUsers({
      workspaceId,
      userIds,
      limit: userIds.length, // Get all users in one batch
    }),
  ]);

  // Handle the result from getUsers
  if (usersResult.isErr()) {
    throw usersResult.error;
  }

  // Create lookup maps
  const subscriptionGroupMap = new Map(
    subscriptionGroupData.map((subscriptionGroupWithAssignment) => [
      subscriptionGroupWithAssignment.userId,
      subscriptionGroupWithAssignment,
    ]),
  );

  // Convert getUsers response to UserPropertyAssignments format
  const userPropertiesMap = new Map(
    usersResult.value.users.map((user) => {
      // Convert properties from getUsers format to UserPropertyAssignments format
      const assignments: UserPropertyAssignments = {};
      for (const [propertyId, property] of Object.entries(user.properties)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        assignments[propertyId] = property.value;
      }
      return [user.id, assignments];
    }),
  );

  // Process each user and send messages
  const messagePromises: Promise<MessageSendResultWithResponseItem>[] =
    users.map(async (user) => {
      const messageId = user.messageId ?? randomUUID();

      try {
        // Get subscription group details for this user
        let subscriptionGroupDetails:
          | (SubscriptionGroupDetails & { name: string })
          | undefined;

        if (subscriptionGroupId) {
          const subscriptionGroupWithAssignment = subscriptionGroupMap.get(
            user.id,
          );
          if (subscriptionGroupWithAssignment) {
            const details = getSubscriptionGroupDetails(
              subscriptionGroupWithAssignment,
            );
            subscriptionGroupDetails = {
              name: subscriptionGroupWithAssignment.name,
              ...details,
            };
          }
        }

        // Get base user property assignments and merge with request properties
        const baseUserPropertyAssignments =
          userPropertiesMap.get(user.id) ?? {};
        const combinedUserPropertyAssignments = {
          ...baseUserPropertyAssignments,
          ...user.properties,
          id: user.id, // Ensure the user ID is always available for liquid templates
        };

        // Create message tags
        const messageTags: MessageTags = {
          messageId,
          workspaceId,
          templateId,
          userId: user.id,
        };

        // Prepare send message parameters based on channel type
        let sendMessageParams: SendMessageParameters;

        switch (params.channel) {
          case ChannelType.Email: {
            sendMessageParams = {
              workspaceId,
              templateId,
              userId: user.id,
              userPropertyAssignments: combinedUserPropertyAssignments,
              subscriptionGroupDetails,
              messageTags,
              useDraft: false,
              channel: params.channel,
              providerOverride: params.provider,
              espSelection,
            };
            break;
          }
          case ChannelType.Webhook: {
            sendMessageParams = {
              workspaceId,
              templateId,
              userId: user.id,
              userPropertyAssignments: combinedUserPropertyAssignments,
              subscriptionGroupDetails,
              messageTags,
              useDraft: false,
              channel: params.channel,
            };
            break;
          }
          default:
            assertUnreachable(params);
        }

        // Send the message
        const messageResult = await sendMessage(sendMessageParams);

        // Process the result
        if (messageResult.isOk()) {
          switch (messageResult.value.type) {
            case InternalEventType.MessageSent:
              return [
                {
                  userId: user.id,
                  type: BatchMessageUsersResultTypeEnum.Success,
                  messageId,
                },
                messageResult,
              ] satisfies MessageSendResultWithResponseItem;
            case InternalEventType.MessageQueued:
              return [
                {
                  userId: user.id,
                  type: BatchMessageUsersResultTypeEnum.Queued,
                  messageId,
                  sendId: messageResult.value.sendId,
                  state: messageResult.value.state,
                  nextAttemptAt: messageResult.value.nextAttemptAt,
                },
                messageResult,
              ] satisfies MessageSendResultWithResponseItem;
            case InternalEventType.MessageSkipped:
              return [
                {
                  userId: user.id,
                  type: BatchMessageUsersResultTypeEnum.Skipped,
                  messageId,
                  reason: messageResult.value.message || "Message was skipped",
                },
                messageResult,
              ] satisfies MessageSendResultWithResponseItem;
            default:
              assertUnreachable(messageResult.value);
          }
        } else {
          const { error } = messageResult;
          if (isNonRetryableError(error)) {
            return [
              {
                userId: user.id,
                type: BatchMessageUsersResultTypeEnum.NonRetryableError,
                messageId,
                error,
              },
              messageResult,
            ] satisfies MessageSendResultWithResponseItem;
          }
          let errorMessage: string;
          switch (error.variant.type) {
            case MessageSkippedType.MissingIdentifier:
              errorMessage = `Missing identifier: ${error.variant.identifierKey}`;
              break;
            case MessageSkippedType.SubscriptionState:
              errorMessage =
                "User does not satisfy subscription group requirements";
              break;
            default:
              assertUnreachable(error.variant);
          }
          return [
            {
              userId: user.id,
              type: BatchMessageUsersResultTypeEnum.RetryableError,
              messageId,
              error: {
                message: errorMessage,
              },
            },
            messageResult,
          ] satisfies MessageSendResultWithResponseItem;
        }
      } catch (userError) {
        logger().info(
          {
            err: userError,
            userId: user.id,
            workspaceId,
            templateId,
          },
          "Failed to send message to user",
        );

        return [
          {
            userId: user.id,
            type: BatchMessageUsersResultTypeEnum.RetryableError,
            messageId,
            error: {
              message:
                userError instanceof Error
                  ? userError.message
                  : "Unknown error",
            },
          },
          null,
        ] satisfies MessageSendResultWithResponseItem;
      }
    });

  // Wait for all messages to be processed
  const messageResults = await Promise.all(messagePromises);

  const results: BatchMessageUsersResponse["results"] = messageResults.map(
    (r) => r[0],
  );

  // Create a mapping from userId to user context for event tracking
  const userContextMap = new Map(users.map((user) => [user.id, user.context]));

  const baseProperties: TrackData["properties"] = {
    templateId,
    workspaceId,
  };
  const trackEvents: KnownBatchTrackData[] = messageResults.flatMap(
    ([responseResult, backendMessageSendResult]) => {
      if (!backendMessageSendResult) {
        return [];
      }
      if (
        responseResult.type === BatchMessageUsersResultTypeEnum.RetryableError
      ) {
        return [];
      }
      let event: InternalEventType;
      let trackingProperties: TrackData["properties"];
      const { messageId, userId } = responseResult;
      if (backendMessageSendResult.isOk()) {
        event = backendMessageSendResult.value.type;
        trackingProperties = {
          ...baseProperties,
          ...omit(backendMessageSendResult.value, ["type"]),
        };
      } else {
        event = backendMessageSendResult.error.type;
        trackingProperties = {
          ...baseProperties,
          ...omit(backendMessageSendResult.error, ["type"]),
        };
      }

      // Get user-specific context
      const userContext = userContextMap.get(userId);

      return {
        type: EventType.Track,
        properties: trackingProperties,
        messageId,
        userId,
        event,
        context: userContext,
      };
    },
  );

  await submitBatch({
    workspaceId,
    data: {
      batch: trackEvents,
      context: params.context,
    },
  });

  return { results };
}

/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
import { html } from "@codemirror/lang-html";
import { EditorView } from "@codemirror/view";
import {
  Create,
  InfoOutlined,
  Key,
  Mail,
  Webhook,
} from "@mui/icons-material";
import { LoadingButton } from "@mui/lab";
import {
  Autocomplete,
  Box,
  Button,
  Dialog,
  FormControlLabel,
  FormGroup,
  Paper,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import axios from "axios";
import { getAdminApiKeys } from "backend-lib/src/adminApiKeys";
import { getOrCreateWriteKey, getWriteKeys } from "backend-lib/src/auth";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import { getSecretAvailability } from "backend-lib/src/secrets";
import { subscriptionGroupToResource } from "backend-lib/src/subscriptionGroups";
import { eq } from "drizzle-orm";
import { writeKeyToHeader } from "isomorphic-lib/src/auth";
import {
  EMAIL_PROVIDER_TYPE_TO_SECRET_NAME,
  SecretNames,
} from "isomorphic-lib/src/constants";
import { emailProviderLabel } from "isomorphic-lib/src/email";
import {
  CompletionStatus,
  DefaultEmailProviderResource,
  EmailProviderType,
  EmptyResponse,
  EphemeralRequestStatus,
  SmtpSecretKey,
} from "isomorphic-lib/src/types";
import {
  GetServerSideProps,
  InferGetServerSidePropsType,
  NextPage,
} from "next";
import { enqueueSnackbar } from "notistack";
import { useEffect, useMemo, useState } from "react";
import { useImmer } from "use-immer";

import AdminApiKeyTable from "../components/adminApiKeyTable";
import DashboardHead from "../components/dashboardHead";
import Fields from "../components/form/Fields";
import {
  SecretField,
  TextField as TextFieldComponent,
} from "../components/form/types";
import Layout from "../components/layout";
import { MenuItemGroup } from "../components/menuItems/types";
import { PermissionsTable } from "../components/permissionsTable";
import WebhookSecretTable from "../components/webhookSecretTable";
import { addInitialStateToProps } from "../lib/addInitialStateToProps";
import apiRequestHandlerFactory from "../lib/apiRequestHandlerFactory";
import { useAppStore, useAppStorePick } from "../lib/appStore";
import { copyInputProps } from "../lib/copyToClipboard";
import { getOrCreateEmailProviders } from "../lib/email";
import { noticeAnchorOrigin } from "../lib/notices";
import { requestContext } from "../lib/requestContext";
import { AppState, PreloadedState, PropsWithInitialState } from "../lib/types";

function useSecretAvailability(): AppState["secretAvailability"] | undefined {
  const { secretAvailability, inTransition } = useAppStorePick([
    "secretAvailability",
    "inTransition",
  ]);
  if (inTransition) {
    return undefined;
  }
  return secretAvailability;
}

function isSecretSaved(
  name: SecretNames,
  key: string,
  secretAvailability?: AppState["secretAvailability"],
): boolean | undefined {
  if (!secretAvailability) {
    return undefined;
  }
  return (
    secretAvailability.find((s) => s.name === name)?.configValue?.[key] ?? false
  );
}

function copyToClipboardField({
  value,
  helperText,
  successNotice,
  failureNotice,
  id,
}: {
  id: string;
  value: string;
  helperText?: string;
  successNotice: string;
  failureNotice: string;
}): TextFieldComponent {
  return {
    id,
    type: "text",
    fieldProps: {
      label: "",
      helperText,
      value,
      onChange: () => {},
      InputProps: copyInputProps({
        value,
        successNotice,
        failureNotice,
      }),
    },
  };
}

function SectionHeader({
  id,
  title,
  description,
}: {
  id?: string;
  title: string;
  description?: string;
}) {
  return (
    <Box id={id}>
      <Typography
        variant="h2"
        fontWeight={300}
        sx={{ fontSize: 20, marginBottom: 0.5 }}
      >
        {title}
      </Typography>
      <Typography variant="subtitle1" fontWeight="normal" sx={{ opacity: 0.6 }}>
        {description}
      </Typography>
    </Box>
  );
}

function SectionSubHeader({
  id,
  title,
  description,
}: {
  id?: string;
  title: string;
  description?: string;
}) {
  return (
    <Box id={id}>
      <Typography
        fontWeight={300}
        variant="h2"
        sx={{ fontSize: 16, marginBottom: 0.5 }}
      >
        {title}
      </Typography>
      <Typography variant="subtitle1" fontWeight="normal" sx={{ opacity: 0.6 }}>
        {description}
      </Typography>
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<PropsWithInitialState> =
  requestContext(async (_ctx, dfContext) => {
    const { workspace } = dfContext;
    const workspaceId = workspace.id;

    const [
      emailProviders,
      defaultEmailProviderRecord,
      subscriptionGroups,
      writeKey,
      secretAvailability,
      adminApiKeys,
    ] = await Promise.all([
      getOrCreateEmailProviders({ workspaceId }),
      db().query.defaultEmailProvider.findFirst({
        where: eq(schema.defaultEmailProvider.workspaceId, workspaceId),
      }),
      db().query.subscriptionGroup.findMany({
        where: eq(schema.subscriptionGroup.workspaceId, workspaceId),
      }),
      getWriteKeys({ workspaceId }).then((keys) => keys[0]),
      getSecretAvailability({
        workspaceId,
        names: [
          SecretNames.Webhook,
          ...Object.values(EMAIL_PROVIDER_TYPE_TO_SECRET_NAME),
        ],
      }),
      getAdminApiKeys({ workspaceId }),
    ]);

    const serverInitialState: PreloadedState = {
      emailProviders,
      secretAvailability,
      defaultEmailProvider: defaultEmailProviderRecord,
    };

    if (writeKey) {
      serverInitialState.writeKeys = [writeKey];
    } else {
      serverInitialState.writeKeys = [
        await getOrCreateWriteKey({
          workspaceId,
          writeKeyName: "default-write-key",
        }),
      ];
    }

    const subscriptionGroupResources = subscriptionGroups.map(
      subscriptionGroupToResource,
    );

    serverInitialState.subscriptionGroups = subscriptionGroupResources;
    serverInitialState.adminApiKeys = adminApiKeys;

    return {
      props: addInitialStateToProps({
        dfContext,
        serverInitialState,
        props: {},
      }),
    };
  });

const settingsSectionIds = {
  emailChannel: "email-channel",
  webhookChannel: "webhook-channel",
  subscription: "subscriptions",
  authentication: "authentication",
  writeKey: "write-key",
  adminApiKey: "admin-api-key",
  workspaceMetadata: "workspace-metadata",
  permissions: "permissions",
} as const;

function getMenuItems(authMode: string | undefined): MenuItemGroup[] {
  const baseMenuItems: MenuItemGroup[] = [
    {
      id: "message-channels",
      title: "Messaging Channels",
      type: "group",
      children: [
        {
          id: "email",
          title: "Email",
          type: "item",
          url: `/settings#${settingsSectionIds.emailChannel}`,
          icon: Mail,
          description:
            "Configure email settings, including the email provider credentials.",
        },
        {
          id: "webhook",
          title: "Webhook",
          type: "item",
          url: `/settings#${settingsSectionIds.webhookChannel}`,
          icon: Webhook,
          description: "Configure webhook settings, including custom secrets.",
        },
      ],
    },
    {
      id: "subscription-management",
      title: "Subscription Management",
      type: "group",
      children: [],
      url: `/settings#${settingsSectionIds.subscription}`,
    },
    {
      id: "authentication",
      title: "Authentication",
      type: "group",
      children: [
        {
          id: "write-key",
          title: "Public Write Key",
          type: "item",
          url: `/settings#${settingsSectionIds.writeKey}`,
          description: "Write key used to submit user data to Dittofeed.",
          icon: Create,
        },
        {
          id: "admin-api-key",
          title: "Admin API Key",
          type: "item",
          url: `/settings#${settingsSectionIds.adminApiKey}`,
          description: "API key used to authenticate against the Admin API.",
          icon: Key,
        },
      ],
    },
    {
      id: settingsSectionIds.workspaceMetadata,
      title: "Workspace Metadata",
      type: "group",
      children: [
        {
          id: "workspace-id",
          title: "Workspace Id",
          type: "item",
          url: `/settings#${settingsSectionIds.workspaceMetadata}`,
          icon: InfoOutlined,
          description: "Copy workspace id to clipboard.",
        },
      ],
      url: `/settings#${settingsSectionIds.workspaceMetadata}`,
    },
  ];

  // Only add permissions menu item in multi-tenant mode
  if (authMode === "multi-tenant") {
    baseMenuItems.push({
      id: settingsSectionIds.permissions,
      title: "Permissions",
      type: "group",
      children: [
        {
          id: "workspace-permissions",
          title: "Workspace Permissions",
          type: "item",
          url: `/settings#${settingsSectionIds.permissions}`,
          icon: Key,
          description: "Manage workspace member roles and permissions.",
        },
      ],
      url: `/settings#${settingsSectionIds.permissions}`,
    });
  }

  return baseMenuItems;
}

function SettingsLayout(
  props: Omit<React.ComponentProps<typeof Layout>, "items">,
) {
  const { authMode } = useAppStorePick(["authMode"]);
  const menuItems = getMenuItems(authMode);

  return (
    <>
      <DashboardHead />
      <Layout
        pageTitle="Settings"
        backLink="/"
        navigationRenderer="minimal"
        items={menuItems}
        {...props}
      />
    </>
  );
}

function SendGridConfig() {
  const secretAvailability = useSecretAvailability();

  return (
    <Fields
      sections={[
        {
          id: "sendgrid-section",
          fieldGroups: [
            {
              id: "sendgrid-fields",
              name: "SendGrid",
              fields: [
                {
                  id: "sendgrid-api-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.SendGrid,
                    secretKey: "apiKey",
                    label: "Sendgrid API Key",
                    helperText:
                      "API key, used internally to send emails via sendgrid.",
                    type: EmailProviderType.SendGrid,
                    saved: isSecretSaved(
                      SecretNames.SendGrid,
                      "apiKey",
                      secretAvailability,
                    ),
                  },
                },
                {
                  id: "sendgrid-webhook-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.SendGrid,
                    secretKey: "webhookKey",
                    label: "Webhook Key",
                    helperText:
                      "Sendgrid webhook verification key, used to authenticate sendgrid webhook requests.",
                    type: EmailProviderType.SendGrid,
                    saved: isSecretSaved(
                      SecretNames.SendGrid,
                      "webhookKey",
                      secretAvailability,
                    ),
                  },
                },
              ],
            },
          ],
        },
      ]}
    />
  );
}

function AmazonSesConfig() {
  const secretAvailability = useSecretAvailability();

  return (
    <Fields
      sections={[
        {
          id: "amazonses-section",
          fieldGroups: [
            {
              id: "amazonses-fields",
              name: "AmazonSES",
              fields: [
                {
                  id: "amazonses-access-key-id",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.AmazonSes,
                    secretKey: "accessKeyId",
                    label: "Access Key Id",
                    helperText: "IAM user access key",
                    type: EmailProviderType.AmazonSes,
                    saved: isSecretSaved(
                      SecretNames.AmazonSes,
                      "accessKeyId",
                      secretAvailability,
                    ),
                  },
                },
                {
                  id: "amazonses-secret-access-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.AmazonSes,
                    secretKey: "secretAccessKey",
                    label: "Secret Access Key",
                    helperText: "Secret access key for IAM user.",
                    type: EmailProviderType.AmazonSes,
                    saved: isSecretSaved(
                      SecretNames.AmazonSes,
                      "secretAccessKey",
                      secretAvailability,
                    ),
                  },
                },
                {
                  id: "amazonses-region",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.AmazonSes,
                    secretKey: "region",
                    label: "AWS Region",
                    helperText: "The AWS region to route requests to.",
                    type: EmailProviderType.AmazonSes,
                    saved: isSecretSaved(
                      SecretNames.AmazonSes,
                      "region",
                      secretAvailability,
                    ),
                  },
                },
                {
                  id: "amazonses-endpoint",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.AmazonSes,
                    secretKey: "endpoint",
                    label: "Custom Endpoint (Optional)",
                    helperText:
                      "Custom SES endpoint URL. Leave empty to use the default AWS endpoint.",
                    type: EmailProviderType.AmazonSes,
                    saved: isSecretSaved(
                      SecretNames.AmazonSes,
                      "endpoint",
                      secretAvailability,
                    ),
                  },
                },
              ],
            },
          ],
        },
      ]}
    />
  );
}

function MailChimpConfig() {
  const secretAvailability = useSecretAvailability();

  return (
    <Fields
      sections={[
        {
          id: "mailchimp-section",
          fieldGroups: [
            {
              id: "mailchimp-fields",
              name: "MailChimp",
              fields: [
                {
                  id: "mailchimp-api-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.MailChimp,
                    secretKey: "apiKey",
                    label: "MailChimp API Key",
                    helperText: "API key used to send emails via MailChimp.",
                    type: EmailProviderType.MailChimp,
                    saved: isSecretSaved(
                      SecretNames.MailChimp,
                      "apiKey",
                      secretAvailability,
                    ),
                  },
                },
                {
                  id: "mailchimp-webhook-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.MailChimp,
                    secretKey: "webhookKey",
                    label: "Webhook Key",
                    helperText:
                      "MailChimp webhook verification key, used to authenticate webhook requests.",
                    type: EmailProviderType.MailChimp,
                    saved: isSecretSaved(
                      SecretNames.MailChimp,
                      "webhookKey",
                      secretAvailability,
                    ),
                  },
                },
              ],
            },
          ],
        },
      ]}
    />
  );
}

function ResendConfig() {
  const secretAvailability = useSecretAvailability();

  return (
    <Fields
      sections={[
        {
          id: "resend-section",
          fieldGroups: [
            {
              id: "resend-fields",
              name: "Resend",
              fields: [
                {
                  id: "resend-api-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.Resend,
                    secretKey: "apiKey",
                    label: "Resend API Key",
                    helperText:
                      "API key, used internally to send emails via resend.",
                    type: EmailProviderType.Resend,
                    saved: isSecretSaved(
                      SecretNames.Resend,
                      "apiKey",
                      secretAvailability,
                    ),
                  },
                },
                {
                  id: "resend-webhook-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.Resend,
                    secretKey: "webhookKey",
                    label: "Webhook Key",
                    helperText:
                      "Resend webhook verification key, used to authenticate resend webhook requests.",
                    type: EmailProviderType.Resend,
                    saved: isSecretSaved(
                      SecretNames.Resend,
                      "webhookKey",
                      secretAvailability,
                    ),
                  },
                },
              ],
            },
          ],
        },
      ]}
    />
  );
}

function PostMarkConfig() {
  const secretAvailability = useSecretAvailability();

  return (
    <Fields
      sections={[
        {
          id: "postmark-section",
          fieldGroups: [
            {
              id: "postmark-fields",
              name: "PostMark",
              fields: [
                {
                  id: "postmark-api-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.Postmark,
                    secretKey: "apiKey",
                    label: "API Key",
                    helperText:
                      "API key, used internally to send emails via Postmark.",
                    type: EmailProviderType.PostMark,
                    saved: isSecretSaved(
                      SecretNames.Postmark,
                      "apiKey",
                      secretAvailability,
                    ),
                  },
                },
                {
                  id: "postmark-webhook-key",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.Postmark,
                    secretKey: "webhookKey",
                    label: "Webhook Key",
                    helperText:
                      "Auth header value (x-postmark-secret), used to authenticate PostMark webhook requests. Use a secure random string generator.",
                    type: EmailProviderType.PostMark,
                    saved: isSecretSaved(
                      SecretNames.Postmark,
                      "webhookKey",
                      secretAvailability,
                    ),
                  },
                },
                {
                  id: "postmark-message-stream",
                  type: "secret",
                  fieldProps: {
                    name: SecretNames.Postmark,
                    secretKey: "messageStream",
                    label: "Message Stream",
                    helperText:
                      "Message stream to use for sending emails. Usually 'broadcast'.",
                    type: EmailProviderType.PostMark,
                    saved: isSecretSaved(
                      SecretNames.Postmark,
                      "messageStream",
                      secretAvailability,
                    ),
                  },
                },
              ],
            },
          ],
        },
      ]}
    />
  );
}

const SMTP_SECRET_FIELDS: {
  helperText: string;
  label: string;
  key: SmtpSecretKey;
}[] = [
  {
    key: "host",
    label: "SMTP host",
    helperText: "Host of SMTP server.",
  },
  {
    key: "port",
    label: "SMTP port",
    helperText: "Port of SMTP server.",
  },
  {
    key: "username",
    label: "SMTP Username",
    helperText: "Username used to authenticate SMTP server.",
  },
  {
    key: "password",
    label: "SMTP Password",
    helperText: "Password used to authenticate SMTP server.",
  },
];

function SmtpConfig() {
  const secretAvailability = useSecretAvailability();
  const fields: SecretField[] = SMTP_SECRET_FIELDS.map((field) => ({
    id: `smtp-${field.key}`,
    type: "secret",
    fieldProps: {
      name: SecretNames.Smtp,
      secretKey: field.key,
      label: field.label,
      helperText: field.helperText,
      type: EmailProviderType.Smtp,
      saved: isSecretSaved(SecretNames.Smtp, field.key, secretAvailability),
    },
  }));

  return (
    <Fields
      sections={[
        {
          id: "smtp-section",
          fieldGroups: [
            {
              id: "smtp-fields",
              name: "SMTP",
              description: "Send emails with a custom SMTP server.",
              fields,
            },
          ],
        },
      ]}
    />
  );
}

function DefaultEmailConfig() {
  const {
    emailProviders,
    apiBase,
    workspace,
    defaultEmailProvider,
    setDefaultEmailProvider,
  } = useAppStorePick([
    "apiBase",
    "workspace",
    "emailProviders",
    "defaultEmailProvider",
    "setDefaultEmailProvider",
  ]);
  const [
    { defaultProvider, defaultFromAddress, defaultProviderRequest },
    setState,
  ] = useImmer<{
    defaultProvider: string | null;
    defaultFromAddress: string | null;
    defaultProviderRequest: EphemeralRequestStatus<Error>;
  }>({
    defaultProvider: defaultEmailProvider?.emailProviderId ?? null,
    defaultFromAddress: defaultEmailProvider?.fromAddress ?? null,
    defaultProviderRequest: {
      type: CompletionStatus.NotStarted,
    },
  });

  const apiHandler = (emailProviderId: string, fromAddress: string) => {
    if (workspace.type !== CompletionStatus.Successful) {
      return;
    }
    apiRequestHandlerFactory({
      request: defaultProviderRequest,
      setRequest: (request) => {
        setState((state) => {
          state.defaultProviderRequest = request;
        });
      },
      responseSchema: EmptyResponse,
      onSuccessNotice: "Set default email configuration.",
      onFailureNoticeHandler: () =>
        `API Error: Failed to set default email configuration.`,
      setResponse: () => {
        if (!defaultProvider) {
          return;
        }
        setDefaultEmailProvider({
          workspaceId: workspace.value.id,
          emailProviderId: defaultProvider,
          fromAddress,
        });
      },
      requestConfig: {
        method: "PUT",
        url: `${apiBase}/api/settings/email-providers/default`,
        data: {
          workspaceId: workspace.value.id,
          emailProviderId,
          fromAddress,
        } satisfies DefaultEmailProviderResource,
        headers: {
          "Content-Type": "application/json",
        },
      },
    })();
  };

  const options = emailProviders.map((ep) => {
    const { type } = ep;
    return {
      value: ep.id,
      label: emailProviderLabel(type),
    };
  });

  return (
    <Fields
      sections={[
        {
          id: "default-email-section",
          fieldGroups: [
            {
              id: "default-email-fields",
              name: "Default Email Configuration",
              fields: [
                {
                  id: "default-email-provider",
                  type: "select",
                  fieldProps: {
                    label: "Default Email Provider",
                    value: defaultProvider ?? "",
                    onChange: (value) => {
                      setState((state) => {
                        state.defaultProvider = value;
                      });
                    },
                    options,
                    helperText:
                      "In order to use email, at least 1 email provider must be configured.",
                  },
                },
                {
                  id: "default-from-address",
                  type: "text",
                  fieldProps: {
                    label: 'Default "From" Address',
                    value: defaultFromAddress ?? "",
                    onChange: ({ target: { value } }) => {
                      setState((state) => {
                        state.defaultFromAddress = value;
                      });
                    },
                    helperText:
                      'This will be used to populate "From" address in email templates.',
                  },
                },
              ],
            },
          ],
        },
      ]}
    >
      <Button
        variant="contained"
        disabled={!defaultProvider}
        sx={{
          alignSelf: {
            xs: "start",
            sm: "end",
          },
        }}
        onClick={() =>
          apiHandler(defaultProvider ?? "", defaultFromAddress ?? "")
        }
      >
        Save
      </Button>
    </Fields>
  );
}

function EmailChannelConfig() {
  return (
    <>
      <SectionSubHeader id={settingsSectionIds.emailChannel} title="Email" />
      <DefaultEmailConfig />
      <SendGridConfig />
      <AmazonSesConfig />
      <ResendConfig />
      <PostMarkConfig />
      <MailChimpConfig />
      <SmtpConfig />
    </>
  );
}

function WebhookChannelConfig() {
  return (
    <>
      <SectionSubHeader
        id={settingsSectionIds.webhookChannel}
        title="Webhook"
      />
      <Fields disableChildStyling sections={[]}>
        <WebhookSecretTable />
      </Fields>
    </>
  );
}

function MessageChannelsConfig() {
  return (
    <Stack spacing={3}>
      <SectionHeader title="Message Channels" />
      <EmailChannelConfig />
      <WebhookChannelConfig />
    </Stack>
  );
}

function WriteKeySettings() {
  const writeKey = useAppStore((store) => store.writeKeys)[0];
  const keyHeader = useMemo(
    () => (writeKey ? writeKeyToHeader(writeKey) : null),
    [writeKey],
  );

  if (!keyHeader) {
    return null;
  }

  return (
    <Fields
      sections={[
        {
          id: settingsSectionIds.writeKey,
          fieldGroups: [
            {
              id: "write-key-fields",
              name: "Write key",
              fields: [
                copyToClipboardField({
                  id: "sendgrid-api-key",
                  successNotice: "Copied write key to clipboard.",
                  failureNotice: "Failed to copy write key to clipboard.",
                  value: keyHeader,
                  helperText:
                    'Include this key as an HTTP "Authorization: Basic ..." header in your requests. This authorization key can be included in your client, and does not need to be kept secret.',
                }),
              ],
            },
          ],
        },
      ]}
    />
  );
}

function AdminApiKeySettings() {
  return (
    <Fields
      disableChildStyling
      sections={[
        {
          id: settingsSectionIds.adminApiKey,
          fieldGroups: [
            {
              id: "authorization-fields",
              name: "Admin API Key",
              fields: [],
            },
          ],
        },
      ]}
    >
      <AdminApiKeyTable />
    </Fields>
  );
}

function AuthenticationSettings() {
  return (
    <Stack spacing={3}>
      <SectionHeader
        id={settingsSectionIds.authentication}
        title="Authentication"
        description=""
      />
      <WriteKeySettings />
      <AdminApiKeySettings />
    </Stack>
  );
}

function SubscriptionManagementSettings() {
  const subscriptionGroups = useAppStore((store) => store.subscriptionGroups);
  const { apiBase } = useAppStorePick(["apiBase"]);
  const [fromSubscriptionChange, setFromSubscriptionChange] =
    useState<boolean>(true);
  const [fromSubscribe, setFromSubscribe] = useState<boolean>(false);
  const [selectedSubscriptionGroupId, setSelectedSubscriptionGroupId] =
    useState<string>("");
  const [showPreview, setShowPreview] = useState<boolean>(false);
  const [templateContent, setTemplateContent] = useState<string>("");
  const [defaultTemplate, setDefaultTemplate] = useState<string>("");
  const [hasCustomTemplate, setHasCustomTemplate] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isResetting, setIsResetting] = useState<boolean>(false);
  const queryClient = useQueryClient();

  const workspaceResult = useAppStore((store) => store.workspace);
  const workspace =
    workspaceResult.type === CompletionStatus.Successful
      ? workspaceResult.value
      : null;

  // Fetch template on mount
  const templateQuery = useQuery({
    queryKey: ["subscriptionManagementTemplate", workspace?.id],
    queryFn: async () => {
      if (!workspace) return null;
      const response = await axios.get(
        `${apiBase}/api/subscription-management-template?includeDefault=true`,
      );
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return response.data as {
        template: string | null;
        defaultTemplate: string;
      };
    },
    enabled: !!workspace,
  });

  // Update state when template data loads
  useEffect(() => {
    if (templateQuery.data) {
      const { template, defaultTemplate: defaultTpl } = templateQuery.data;
      setDefaultTemplate(defaultTpl);
      if (template) {
        setTemplateContent(template);
        setHasCustomTemplate(true);
      } else {
        setTemplateContent(defaultTpl);
        setHasCustomTemplate(false);
      }
    }
  }, [templateQuery.data]);

  // Save template mutation
  const saveTemplateMutation = useMutation({
    mutationFn: async (template: string) => {
      return axios.put(`${apiBase}/api/subscription-management-template`, {
        template,
      });
    },
    onSuccess: () => {
      setHasCustomTemplate(true);
      queryClient.invalidateQueries({
        queryKey: ["subscriptionManagementTemplate", workspace?.id],
      });
      enqueueSnackbar("Template saved successfully", {
        variant: "success",
        autoHideDuration: 3000,
        anchorOrigin: noticeAnchorOrigin,
      });
    },
    onError: (error) => {
      enqueueSnackbar(
        `Failed to save template: ${error instanceof Error ? error.message : "Unknown error"}`,
        {
          variant: "error",
          autoHideDuration: 10000,
          anchorOrigin: noticeAnchorOrigin,
        },
      );
    },
    onSettled: () => {
      setIsSaving(false);
    },
  });

  // Reset to default mutation
  const resetTemplateMutation = useMutation({
    mutationFn: async () => {
      return axios.delete(`${apiBase}/api/subscription-management-template`);
    },
    onSuccess: () => {
      setTemplateContent(defaultTemplate);
      setHasCustomTemplate(false);
      queryClient.invalidateQueries({
        queryKey: ["subscriptionManagementTemplate", workspace?.id],
      });
      enqueueSnackbar("Template reset to default", {
        variant: "success",
        autoHideDuration: 3000,
        anchorOrigin: noticeAnchorOrigin,
      });
    },
    onError: (error) => {
      // 404 means no custom template exists, which is fine for reset
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        setTemplateContent(defaultTemplate);
        setHasCustomTemplate(false);
        enqueueSnackbar("Template reset to default", {
          variant: "success",
          autoHideDuration: 3000,
          anchorOrigin: noticeAnchorOrigin,
        });
      } else {
        enqueueSnackbar(
          `Failed to reset template: ${error instanceof Error ? error.message : "Unknown error"}`,
          {
            variant: "error",
            autoHideDuration: 10000,
            anchorOrigin: noticeAnchorOrigin,
          },
        );
      }
    },
    onSettled: () => {
      setIsResetting(false);
    },
  });

  const handleSaveTemplate = () => {
    setIsSaving(true);
    saveTemplateMutation.mutate(templateContent);
  };

  const handleResetToDefault = () => {
    setIsResetting(true);
    resetTemplateMutation.mutate();
  };

  // Set default selected subscription group if not set
  const defaultSubscriptionGroupId = subscriptionGroups[0]?.id ?? "";
  const actualSelectedId =
    selectedSubscriptionGroupId || defaultSubscriptionGroupId;

  // Find the selected subscription group and its channel
  const selectedSubscriptionGroup = subscriptionGroups.find(
    (sg) => sg.id === actualSelectedId,
  );
  if (!workspace) {
    return null;
  }

  return (
    <Stack>
      <Dialog open={showPreview} onClose={() => setShowPreview(false)}>
        <Stack sx={{ p: 4 }}>
          <Box>
            <Box>
              Preview of the subscription management page, that will be shown to
              users.
            </Box>
            <FormGroup>
              <Box>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  Page Type:
                </Typography>
                <ToggleButtonGroup
                  value={fromSubscriptionChange ? "change" : "management"}
                  exclusive
                  onChange={(_, value) => {
                    if (value !== null) {
                      setFromSubscriptionChange(value === "change");
                    }
                  }}
                  aria-label="page type"
                >
                  <ToggleButton value="change" aria-label="subscription change">
                    Subscription Change
                  </ToggleButton>
                  <ToggleButton
                    value="management"
                    aria-label="subscription management"
                  >
                    Subscription Management
                  </ToggleButton>
                </ToggleButtonGroup>
              </Box>
              {fromSubscriptionChange && (
                <>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={fromSubscribe}
                        onChange={(e) => setFromSubscribe(e.target.checked)}
                      />
                    }
                    label={`${fromSubscribe ? "Subscribe" : "Unsubscribe"} link.`}
                  />
                  <Box sx={{ mt: 1, mb: 1 }}>
                    <Autocomplete
                      options={subscriptionGroups}
                      value={selectedSubscriptionGroup ?? null}
                      onChange={(_event, newValue) => {
                        setSelectedSubscriptionGroupId(newValue?.id ?? "");
                      }}
                      getOptionLabel={(option) =>
                        `${option.name} (${option.channel})`
                      }
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          variant="outlined"
                          label="Changed Subscription Group"
                          size="small"
                        />
                      )}
                    />
                  </Box>
                </>
              )}
            </FormGroup>
          </Box>
          <Paper
            elevation={1}
            sx={{
              p: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {(() => {
              // Build the iframe URL for the subscription management page
              const iframeParams = new URLSearchParams({
                w: workspace.id,
                h: "preview-hash",
                i: "preview@example.com",
                ik: "email",
                isPreview: "true",
              });

              if (fromSubscriptionChange && actualSelectedId) {
                iframeParams.set("s", actualSelectedId);
                iframeParams.set("sub", fromSubscribe ? "1" : "0");
              }

              return (
                <iframe
                  key={`${fromSubscribe}-${fromSubscriptionChange}-${actualSelectedId}`}
                  src={`${apiBase}/api/public/subscription-management/page?${iframeParams.toString()}`}
                  style={{
                    width: "100%",
                    minWidth: "400px",
                    height: "600px",
                    border: "none",
                  }}
                  title="Subscription Management Preview"
                />
              );
            })()}
          </Paper>
        </Stack>
      </Dialog>
      <Stack spacing={3}>
        <SectionHeader
          id={settingsSectionIds.subscription}
          title="Subscription Management"
          description=""
        />
        <Fields
          sections={[
            {
              id: "subscription-section-1",
              fieldGroups: [
                {
                  id: "subscription-preview",
                  name: "User subscription page",
                  fields: [
                    {
                      id: "subscription-preview-button",
                      type: "button",
                      fieldProps: {
                        children: "Preview",
                        onClick: () => {
                          setShowPreview(true);
                        },
                        variant: "outlined",
                      },
                    },
                  ],
                },
              ],
            },
          ]}
        />
        <Fields
          disableChildStyling
          sections={[
            {
              id: "subscription-template-section",
              fieldGroups: [
                {
                  id: "subscription-template-editor",
                  name: "Subscription Page Template",
                  description:
                    "Customize the subscription management page HTML template using Liquid syntax.",
                  fields: [],
                },
              ],
            },
          ]}
        >
          <Stack spacing={2}>
            {templateQuery.isLoading ? (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Loading template...
              </Typography>
            ) : (
              <>
                <Box
                  sx={{
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                    overflow: "hidden",
                  }}
                >
                  <CodeMirror
                    value={templateContent}
                    height="400px"
                    extensions={[html(), EditorView.lineWrapping]}
                    onChange={(value) => setTemplateContent(value)}
                  />
                </Box>
                <Stack direction="row" spacing={2}>
                  <LoadingButton
                    variant="contained"
                    onClick={handleSaveTemplate}
                    loading={isSaving}
                    disabled={isResetting}
                  >
                    Save Template
                  </LoadingButton>
                  <LoadingButton
                    variant="outlined"
                    onClick={handleResetToDefault}
                    loading={isResetting}
                    disabled={isSaving || !hasCustomTemplate}
                  >
                    Reset to Default
                  </LoadingButton>
                </Stack>
                {hasCustomTemplate && (
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    Using custom template. Click &quot;Reset to Default&quot; to
                    revert to the default template.
                  </Typography>
                )}
              </>
            )}
          </Stack>
        </Fields>
      </Stack>
    </Stack>
  );
}

function Metadata() {
  const { workspace: workspaceResult } = useAppStorePick(["workspace"]);
  const workspace =
    workspaceResult.type === CompletionStatus.Successful
      ? workspaceResult.value
      : null;
  if (!workspace) {
    return null;
  }
  return (
    <Stack spacing={3}>
      <SectionHeader
        title="Workspace Metadata"
        description=""
        id={settingsSectionIds.workspaceMetadata}
      />
      <Fields
        sections={[
          {
            id: "workspace-metadata-section",
            fieldGroups: [
              {
                id: "workspace-metadata-fields",
                name: "Workspace Id",
                fields: [
                  copyToClipboardField({
                    id: "workspace-id",
                    successNotice: "Copied workspace id to clipboard.",
                    failureNotice: "Failed to copy workspace id to clipboard.",
                    value: workspace.id,
                    helperText: `Id of the current "${workspace.name}" workspace.`,
                  }),
                ],
              },
            ],
          },
        ]}
      />
    </Stack>
  );
}

function PermissionsSettings() {
  const { authMode } = useAppStorePick(["authMode"]);

  // Only render in multi-tenant mode
  if (authMode !== "multi-tenant") {
    return null;
  }

  return (
    <Stack spacing={3}>
      <SectionHeader
        id={settingsSectionIds.permissions}
        title="Permissions"
        description="Manage workspace member roles and permissions."
      />
      <PermissionsTable />
    </Stack>
  );
}

function SettingsContents() {
  const { inTransition } = useAppStorePick(["inTransition"]);
  if (inTransition) {
    return null;
  }
  return (
    <>
      <MessageChannelsConfig />
      <AuthenticationSettings />
      <SubscriptionManagementSettings />
      <PermissionsSettings />
      <Metadata />
    </>
  );
}

const Settings: NextPage<
  InferGetServerSidePropsType<typeof getServerSideProps>
> = function Settings() {
  return (
    <SettingsLayout>
      <Stack
        spacing={8}
        sx={{
          padding: 2,
          paddingY: 8,
          maxWidth: "lg",
          marginX: "auto",
          width: "100%",
        }}
      >
        <SettingsContents />
      </Stack>
    </SettingsLayout>
  );
};
export default Settings;

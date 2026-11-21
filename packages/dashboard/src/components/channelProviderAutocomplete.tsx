import { Autocomplete, TextField } from "@mui/material";
import { emailProviderLabel } from "isomorphic-lib/src/email";
import {
  ChannelType,
  WorkspaceWideEmailProviders,
  WorkspaceWideEmailProviderType,
} from "isomorphic-lib/src/types";

function getProviderLabel(
  provider: WorkspaceWideEmailProviders,
) {
  return emailProviderLabel(provider);
}

export type ProviderOverrideChangeHandler = (
  provider: WorkspaceWideEmailProviders | null,
) => void;

export default function ChannelProviderAutocomplete({
  channel,
  providerOverride,
  disabled,
  handler,
}: {
  providerOverride?: WorkspaceWideEmailProviders | null;
  disabled?: boolean;
  channel: ChannelType;
  handler: ProviderOverrideChangeHandler;
}) {
  let providerOptions: WorkspaceWideEmailProviders[] = [];
  switch (channel) {
    case ChannelType.Email:
      providerOptions = Object.values(WorkspaceWideEmailProviderType);
      break;
    case ChannelType.MobilePush:
      // TODO: Implement mobile push providers when available
      return null;
    case ChannelType.Webhook:
      // Webhooks don't have provider overrides
      return null;
  }

  const provider =
    providerOverride && providerOptions.includes(providerOverride)
      ? providerOverride
      : null;

  return (
    <Autocomplete
      value={provider}
      options={providerOptions}
      disabled={disabled}
      getOptionLabel={getProviderLabel}
      onChange={(_event, p) =>
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        handler(p as WorkspaceWideEmailProviders | null)
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label="Provider Override"
          variant="outlined"
          helperText={
            providerOverride && !provider
              ? "The saved provider override is unavailable."
              : undefined
          }
        />
      )}
    />
  );
}

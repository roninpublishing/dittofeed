import { CompletionStatus, SecretResource } from "isomorphic-lib/src/types";
import { useRouter } from "next/router";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { pick } from "remeda";
import { create, UseBoundStore } from "zustand";
import createContext from "zustand/context";
import { immer } from "zustand/middleware/immer";
import { shallow } from "zustand/shallow";

import { AppContents, AppState, PreloadedState } from "./types";
import { getDefaultUserPropertyExampleValue } from "./userProperties";

// TODO migrate away from deprecreated createContext method
const zustandContext = createContext<UseStoreState>();
export const { Provider } = zustandContext;
export const useAppStore = zustandContext.useStore;
export function useAppStorePick<K extends keyof AppContents>(
  params: K[],
): Pick<AppContents, K> {
  return useAppStore((store) => pick(store, params), shallow);
}

export const initializeStore = (preloadedState: PreloadedState = {}) =>
  create(
    immer<AppContents>((set) => {
      const appContents: AppContents = {
        apiBase: "",
        dashboardUrl: "",
        trackDashboard: false,
        workspace: {
          type: CompletionStatus.NotStarted,
        },
        secretAvailability: [],
        member: null,
        memberRoles: [],
        defaultEmailProvider: null,
        drawerOpen: true,
        emailProviders: [],
        traits: [],
        properties: {},
        getTraitsRequest: {
          type: CompletionStatus.NotStarted,
        },
        getPropertiesRequest: {
          type: CompletionStatus.NotStarted,
        },
        features: {},
        viewDraft: true,
        commandPaletteOpen: false,
        enableAdditionalDashboardSettings: false,
        upsertTraits: (traits) =>
          set((state) => {
            state.traits = Array.from(new Set(traits.concat(state.traits)));
          }),
        setGetTraitsRequest: (request) =>
          set((state) => {
            state.getTraitsRequest = request;
          }),
        upsertProperties: (properties) =>
          set((state) => {
            for (const [event, eventProperties] of Object.entries(properties)) {
              state.properties[event] = Array.from(
                new Set(eventProperties.concat(state.properties[event] ?? [])),
              );
            }
          }),
        setGetPropertiesRequest: (request) =>
          set((state) => {
            state.getPropertiesRequest = request;
          }),
        messages: {
          type: CompletionStatus.NotStarted,
        },
        segments: {
          type: CompletionStatus.NotStarted,
        },
        journeys: {
          type: CompletionStatus.NotStarted,
        },
        journeyUpdateRequest: {
          type: CompletionStatus.NotStarted,
        },
        journeyStatsRequest: {
          type: CompletionStatus.NotStarted,
        },
        journeyStats: {},
        upsertJourneyStats: (stats) =>
          set((state) => {
            for (const journeyStats of stats) {
              state.journeyStats[journeyStats.journeyId] = journeyStats;
            }
          }),
        setJourneyUpdateRequest: (request) =>
          set((state) => {
            state.journeyUpdateRequest = request;
          }),
        setJourneyStatsRequest: (request) =>
          set((state) => {
            state.journeyStatsRequest = request;
          }),
        userProperties: {
          type: CompletionStatus.NotStarted,
        },
        writeKeys: [],
        secrets: [],
        enableSourceControl: preloadedState.enableSourceControl ?? false,
        enableMobilePush: preloadedState.enableMobilePush ?? false,
        integrations: [],

        messageTemplateDeleteRequest: {
          type: CompletionStatus.NotStarted,
        },
        userPropertyMessages: {},

        // settings page
        upsertIntegration: (integration) =>
          set((state) => {
            const { integrations } = state;
            for (const existing of integrations) {
              if (integration.id === existing.id) {
                Object.assign(existing, integration);
                return state;
              }
            }
            integrations.push(integration);
            return state;
          }),

        deleteMessage: (id) =>
          set((state) => {
            if (state.messages.type !== CompletionStatus.Successful) {
              return state;
            }
            state.messages.value = state.messages.value.filter(
              (m) => m.id !== id,
            );
            return state;
          }),

        setMessageTemplateDeleteRequest: (request) =>
          set((state) => {
            state.messageTemplateDeleteRequest = request;
          }),

        // segment index view
        upsertSegment: (segment) =>
          set((state) => {
            let { segments } = state;
            if (segments.type !== CompletionStatus.Successful) {
              segments = {
                type: CompletionStatus.Successful,
                value: [],
              };
              state.segments = segments;
            }
            for (const existing of segments.value) {
              if (segment.id === existing.id) {
                Object.assign(existing, segment);
                return state;
              }
            }
            segments.value.push(segment);
            return state;
          }),

        deleteSegment: (segmentId) =>
          set((state) => {
            if (state.segments.type !== CompletionStatus.Successful) {
              return state;
            }
            state.segments.value = state.segments.value.filter(
              (s) => s.id !== segmentId,
            );
            return state;
          }),

        // journey index view
        journeyDeleteRequest: {
          type: CompletionStatus.NotStarted,
        },

        setJourneyDeleteRequest: (request) =>
          set((state) => {
            state.journeyDeleteRequest = request;
          }),

        deleteJourney: (journeyId) =>
          set((state) => {
            if (state.journeys.type !== CompletionStatus.Successful) {
              return state;
            }
            state.journeys.value = state.journeys.value.filter(
              (s) => s.id !== journeyId,
            );
            return state;
          }),

        // user index view
        userDeleteRequest: {
          type: CompletionStatus.NotStarted,
        },

        setUserDeleteRequest: (request) =>
          set((state) => {
            state.userDeleteRequest = request;
          }),

        // userProperty index view
        userPropertyDeleteRequest: {
          type: CompletionStatus.NotStarted,
        },

        upsertUserProperty: (userProperty) =>
          set((state) => {
            let { userProperties } = state;
            if (userProperties.type !== CompletionStatus.Successful) {
              userProperties = {
                type: CompletionStatus.Successful,
                value: [],
              };
              state.userProperties = userProperties;
            }
            for (const existing of userProperties.value) {
              if (userProperty.id === existing.id) {
                Object.assign(existing, userProperty);
                return state;
              }
            }
            userProperties.value.push(userProperty);
            return state;
          }),

        deleteUserProperty: (userPropertyId) =>
          set((state) => {
            if (state.userProperties.type !== CompletionStatus.Successful) {
              return state;
            }
            state.userProperties.value = state.userProperties.value.filter(
              (s) => s.id !== userPropertyId,
            );
            return state;
          }),

        setUserPropertyDeleteRequest: (request) =>
          set((state) => {
            state.userPropertyDeleteRequest = request;
          }),

        // broadcast update view
        broadcasts: [],
        broadcastUpdateRequest: {
          type: CompletionStatus.NotStarted,
        },
        broadcastTriggerRequest: {
          type: CompletionStatus.NotStarted,
        },
        editedBroadcast: null,
        updateEditedBroadcast: (updatedBroadcast) =>
          set((state) => {
            if (!state.editedBroadcast) {
              return state;
            }

            state.editedBroadcast = {
              ...state.editedBroadcast,
              ...updatedBroadcast,
            };
            return state;
          }),
        setBroadcastUpdateRequest: (request) =>
          set((state) => {
            state.broadcastUpdateRequest = request;
          }),
        setBroadcastTriggerRequest(request) {
          set((state) => {
            state.broadcastTriggerRequest = request;
          });
        },
        upsertBroadcast: (broadcast) =>
          set((state) => {
            const { broadcasts } = state;
            for (const existing of broadcasts) {
              if (broadcast.id === existing.id) {
                Object.assign(existing, broadcast);
                return state;
              }
            }
            broadcasts.push(broadcast);
            return state;
          }),

        subscriptionGroups: [],
        subscriptionGroupUpdateRequest: {
          type: CompletionStatus.NotStarted,
        },
        subscriptionGroupDeleteRequest: {
          type: CompletionStatus.NotStarted,
        },
        editedSubscriptionGroup: null,
        updateEditedSubscriptionGroup: (updatedSubscriptionGroup) =>
          set((state) => {
            if (!state.editedSubscriptionGroup) {
              return state;
            }

            state.editedSubscriptionGroup = {
              ...state.editedSubscriptionGroup,
              ...updatedSubscriptionGroup,
            };
            return state;
          }),
        setSubscriptionGroupUpdateRequest: (request) =>
          set((state) => {
            state.subscriptionGroupUpdateRequest = request;
          }),
        setSubscriptionGroupDeleteRequest: (request) =>
          set((state) => {
            state.subscriptionGroupDeleteRequest = request;
          }),
        upsertSubscriptionGroup: (subscriptionGroup) =>
          set((state) => {
            const { subscriptionGroups } = state;
            for (const existing of subscriptionGroups) {
              if (subscriptionGroup.id === existing.id) {
                Object.assign(existing, subscriptionGroup);
                return state;
              }
            }
            subscriptionGroups.push(subscriptionGroup);
            return state;
          }),
        deleteSubscriptionGroup: (id) =>
          set((state) => {
            state.subscriptionGroups = state.subscriptionGroups.filter(
              (m) => m.id !== id,
            );
            return state;
          }),
        upsertSecrets(secrets) {
          set((state) => {
            const secretsToCreate = secrets.reduce<Map<string, SecretResource>>(
              (map, secret) => {
                map.set(secret.name, secret);
                return map;
              },
              new Map(),
            );
            for (const secret of state.secrets) {
              const newVal = secretsToCreate.get(secret.name);
              if (newVal) {
                secret.value = newVal.value;
                secretsToCreate.delete(secret.name);
              }
            }

            state.secrets = state.secrets.concat(
              Array.from(secretsToCreate.values()),
            );
          });
        },
        deleteSecret(secretName) {
          set((state) => {
            state.secrets = state.secrets.filter((s) => s.name !== secretName);
          });
        },

        // user property update view
        editedUserProperty: null,

        userPropertyUpdateRequest: {
          type: CompletionStatus.NotStarted,
        },

        updateUserPropertyDefinition: (updater) =>
          set((state) => {
            if (!state.editedUserProperty) {
              return state;
            }
            const definition = updater(state.editedUserProperty.definition);
            if (state.editedUserProperty.definition.type !== definition.type) {
              state.editedUserProperty.exampleValue =
                getDefaultUserPropertyExampleValue(definition);
            }
            state.editedUserProperty.definition = definition;
            return state;
          }),

        setUserPropertyUpdateRequest: (request) =>
          set((state) => {
            state.userPropertyUpdateRequest = request;
          }),
        updateEditedUserProperty: (updatedUserProperty) =>
          set((state) => {
            if (!state.editedUserProperty) {
              return state;
            }

            state.editedUserProperty = {
              ...state.editedUserProperty,
              ...updatedUserProperty,
            };
            return state;
          }),

        toggleDrawer: () =>
          set((state) => {
            state.drawerOpen = !state.drawerOpen;
          }),
        upsertTemplate: (template) =>
          set((state) => {
            let { messages } = state;
            if (messages.type !== CompletionStatus.Successful) {
              messages = {
                type: CompletionStatus.Successful,
                value: [],
              };
              state.messages = messages;
            }
            let updated = false;
            for (let i = 0; i < messages.value.length; i++) {
              const existing = messages.value[i];
              if (!existing) {
                throw new Error("template is undefined");
              }
              if (template.id === existing.id) {
                messages.value[i] = template;
                updated = true;
                break;
              }
            }
            if (!updated) {
              messages.value.push(template);
            }
            return state;
          }),

        patchSecretAvailability: (secretAvailability) =>
          set((state) => {
            if (
              state.workspace.type !== CompletionStatus.Successful ||
              state.workspace.value.id !== secretAvailability.workspaceId
            ) {
              return state;
            }
            let updated = false;
            for (const existing of state.secretAvailability) {
              if (existing.name !== secretAvailability.name) {
                continue;
              }
              const configValue = existing.configValue ?? {};
              configValue[secretAvailability.key] = secretAvailability.value;
              existing.configValue = configValue;
              updated = true;
              break;
            }
            if (!updated) {
              const newSecretAvailability = {
                workspaceId: secretAvailability.workspaceId,
                name: secretAvailability.name,
                value: true,
                configValue: {
                  [secretAvailability.key]: secretAvailability.value,
                },
              };
              state.secretAvailability.push(newSecretAvailability);
            }
            return state;
          }),
        upsertAdminApiKey: (apiKey) =>
          set((state) => {
            const { adminApiKeys: adminApiKeysWithoutDefault } = state;
            const adminApiKeys = adminApiKeysWithoutDefault ?? [];

            let updated = false;
            for (let i = 0; i < adminApiKeys.length; i++) {
              const existing = adminApiKeys[i];
              if (!existing) {
                throw new Error("apiKey is undefined");
              }
              if (apiKey.id === existing.id) {
                adminApiKeys[i] = apiKey;
                updated = true;
                break;
              }
            }
            if (!updated) {
              adminApiKeys.push(apiKey);
            }
            return state;
          }),
        deleteAdminApiKey: (id) =>
          set((state) => {
            if (!state.adminApiKeys) {
              return state;
            }
            state.adminApiKeys = state.adminApiKeys.filter((s) => s.id !== id);
            return state;
          }),
        upsertEmailProvider: (emailProvider) =>
          set((state) => {
            for (const existingProvider of state.emailProviders) {
              if (emailProvider.id === existingProvider.id) {
                Object.assign(existingProvider, emailProvider);
                return state;
              }
            }
            state.emailProviders.push(emailProvider);
            return state;
          }),
        upsertJourney: (journey) =>
          set((state) => {
            let { journeys } = state;
            if (journeys.type !== CompletionStatus.Successful) {
              journeys = {
                type: CompletionStatus.Successful,
                value: [journey],
              };
              state.journeys = journeys;
            }
            let updated = false;
            for (let i = 0; i < journeys.value.length; i++) {
              const existing = journeys.value[i];
              if (!existing) {
                throw new Error("journey is undefined");
              }
              if (journey.id === existing.id) {
                journeys.value[i] = journey;
                updated = true;
                break;
              }
            }
            if (!updated) {
              journeys.value.push(journey);
            }

            return state;
          }),
        setDefaultEmailProvider: (emailProvider) =>
          set((state) => {
            state.defaultEmailProvider = emailProvider;
          }),
        setViewDraft: (viewDraft) =>
          set((state) => {
            state.viewDraft = viewDraft;
          }),
        setCommandPaletteOpen: (open) =>
          set((state) => {
            state.commandPaletteOpen = open;
          }),

        ...preloadedState,
      };

      return appContents;
    }),
  );

type AppStore = ReturnType<typeof initializeStore>;

type UseStoreState = typeof initializeStore extends (
  ...args: never
) => UseBoundStore<infer T>
  ? T
  : never;

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export const useCreateStore = (
  serverInitialState?: Partial<AppState>,
): (() => AppStore) => {
  const router = useRouter();
  const storeRef = useRef<AppStore>();
  const previousInitialState = useRef(serverInitialState);

  if (!storeRef.current) {
    storeRef.current = initializeStore(serverInitialState);
  }
  const initializedStore = storeRef.current;

  useEffect(() => {
    const handleRouteChangeStart = () => {
      initializedStore.setState({ inTransition: true });
    };
    const handleRouteChangeEnd = () => {
      initializedStore.setState({ inTransition: false });
    };

    router.events.on("routeChangeStart", handleRouteChangeStart);
    router.events.on("routeChangeComplete", handleRouteChangeEnd);
    router.events.on("routeChangeError", handleRouteChangeEnd);
    return () => {
      router.events.off("routeChangeStart", handleRouteChangeStart);
      router.events.off("routeChangeComplete", handleRouteChangeEnd);
      router.events.off("routeChangeError", handleRouteChangeEnd);
    };
  }, [initializedStore, router.events]);

  useIsomorphicLayoutEffect(() => {
    if (previousInitialState.current === serverInitialState) {
      return;
    }
    previousInitialState.current = serverInitialState;
    if (serverInitialState) {
      initializedStore.setState({
        ...serverInitialState,
        inTransition: false,
      });
    }
  }, [initializedStore, serverInitialState]);

  return useCallback(() => initializedStore, [initializedStore]);
};

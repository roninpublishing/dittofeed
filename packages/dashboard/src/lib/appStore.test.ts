import { CompletionStatus } from "isomorphic-lib/src/types";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { initializeStore, useCreateStore } from "./appStore";

jest.mock("next/router", () => ({
  useRouter: () => ({ events: { on: jest.fn(), off: jest.fn() } }),
}));

function StoreSnapshot({ traits }: { traits: string[] }) {
  const createStore = useCreateStore({ traits });
  return createElement("div", null, createStore().getState().traits.join(","));
}

describe("dashboard store boundaries", () => {
  it("renders each server request with only that request's trait metadata", () => {
    const first = renderToString(
      createElement(StoreSnapshot, { traits: ["first-workspace-trait"] }),
    );
    const second = renderToString(
      createElement(StoreSnapshot, { traits: ["second-workspace-trait"] }),
    );

    expect(first).toContain("first-workspace-trait");
    expect(first).not.toContain("second-workspace-trait");
    expect(second).toContain("second-workspace-trait");
    expect(second).not.toContain("first-workspace-trait");
  });

  it("updates the property loader without overwriting the trait loader", () => {
    const store = initializeStore();
    store.getState().setGetTraitsRequest({
      type: CompletionStatus.Failed,
      error: new Error("Trait load failed"),
    });
    store
      .getState()
      .setGetPropertiesRequest({ type: CompletionStatus.InProgress });

    expect(store.getState().getPropertiesRequest.type).toBe(
      CompletionStatus.InProgress,
    );
    expect(store.getState().getTraitsRequest.type).toBe(
      CompletionStatus.Failed,
    );

    store
      .getState()
      .setGetPropertiesRequest({ type: CompletionStatus.NotStarted });
    expect(store.getState().getPropertiesRequest.type).toBe(
      CompletionStatus.NotStarted,
    );
  });
});

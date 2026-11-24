import { pick } from "remeda";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { shallow } from "zustand/shallow";

import { createStoreContext } from "../../lib/createStoreContext";
import { JourneyEditorContent } from "../../lib/types";
import { createJourneySlice } from "./store";

const createJourneyStore = () =>
  create(immer<JourneyEditorContent>(createJourneySlice));

const [JourneyStoreProvider, useJourneyStore, useJourneyStoreApi] =
  createStoreContext(createJourneyStore);

export { JourneyStoreProvider, useJourneyStore };

export function useJourneyStorePick<K extends keyof JourneyEditorContent>(
  params: K[],
): Pick<JourneyEditorContent, K> {
  const store = useJourneyStoreApi();
  return store((state) => pick(state, params), shallow);
}

import { ChannelType } from "isomorphic-lib/src/types";

// Dashboard-only policy. Push implementations and saved resources remain intact.
export function isChannelVisible(channel?: ChannelType): boolean {
  return channel !== ChannelType.MobilePush;
}

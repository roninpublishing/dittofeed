import {
  LAST_CLICKED_PROPERTY_NAME,
  LAST_OPENED_PROPERTY_NAME,
} from "./constants";

const protectedUserProperties = new Set<string>([
  "id",
  "anonymousId",
  LAST_CLICKED_PROPERTY_NAME,
  LAST_OPENED_PROPERTY_NAME,
]);
export default protectedUserProperties;

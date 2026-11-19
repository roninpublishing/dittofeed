import { NativeConnection } from "@temporalio/worker";

import config from "../config";

export default async function createConnection() {
  const { temporalAddress, temporalApiKey, temporalNamespace } = config();
  const connection = await NativeConnection.connect({
    address: temporalAddress,
    ...(temporalApiKey
      ? {
          tls: true,
          apiKey: temporalApiKey,
          metadata: { "temporal-namespace": temporalNamespace },
        }
      : {}),
  });
  return connection;
}

import { Connection } from "@temporalio/client";

import config from "../config";

let CONNECTION: Connection | null = null;

export default async function connect(): Promise<Connection> {
  if (!CONNECTION) {
    const {
      temporalAddress,
      temporalConnectionTimeout,
      temporalApiKey,
      temporalNamespace,
    } = config();
    const connection = await Connection.connect({
      address: temporalAddress,
      ...(temporalApiKey
        ? {
            tls: true,
            apiKey: temporalApiKey,
            metadata: { "temporal-namespace": temporalNamespace },
          }
        : {}),
      ...(temporalConnectionTimeout !== undefined
        ? { connectTimeout: temporalConnectionTimeout }
        : {}),
    });
    CONNECTION = connection;
  }
  return CONNECTION;
}

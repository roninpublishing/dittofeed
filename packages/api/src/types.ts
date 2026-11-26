import type { ApiKeyAccountPrincipal } from "backend-lib/src/accounts";

declare module "fastify" {
  interface FastifyRequest {
    apiKeyAccountPrincipal?: ApiKeyAccountPrincipal;
    adminApiKeyId?: string;
  }
}

import {
  DittofeedFastifyInstance,
  UserUploadRow,
  UserUploadRowErrors,
} from "backend-lib/src/types";
import { Result } from "neverthrow";

export interface BuildAppOpts {
  extendPlugins?: (fastify: DittofeedFastifyInstance) => Promise<void>;
  registerAuthentication?: (fastify: DittofeedFastifyInstance) => Promise<void>;
}

export type CsvParseResult = Result<
  UserUploadRow[],
  Error | UserUploadRowErrors[] | string
>;

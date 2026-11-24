import * as HyperDX from "@hyperdx/node-opentelemetry";
import pino, { DestinationStream } from "pino";
import pinoPretty from "pino-pretty";

import config, { SECRETS } from "./config";
import { getServiceName } from "./openTelemetry/constants";
import { Logger } from "./types";

let LOGGER: Logger | null = null;

const redactedSecretPaths = Array.from(SECRETS).flatMap((key) => [
  key,
  `*.${key}`,
]);

export { type LogFn } from "pino";

const PinoLevelToSeverityLookup = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

type PinoLevel = keyof typeof PinoLevelToSeverityLookup;

function isPinoLevel(value: string): value is PinoLevel {
  return value in PinoLevelToSeverityLookup;
}

type PinoConf = Parameters<typeof pino>[0];

const googleOpsConfig: PinoConf = {
  messageKey: "message",
  formatters: {
    level(label, number) {
      const severity: string = isPinoLevel(label)
        ? PinoLevelToSeverityLookup[label]
        : PinoLevelToSeverityLookup.info;

      return {
        severity,
        level: number,
      };
    },
  },
};

export default function logger(): Logger {
  if (!LOGGER) {
    let options: PinoConf;
    let destinationStream: DestinationStream | undefined;

    const { appVersion, logLevel } = config();
    // Add appVersion to the base options
    const baseOptions: PinoConf = {
      level: logLevel,
      redact: redactedSecretPaths,
      base: {
        "service.version": appVersion,
      },
    };

    if (config().prettyLogs) {
      options = baseOptions;
      destinationStream = pinoPretty({
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
        sync: true,
      });
    } else {
      const { exportLogsHyperDx, hyperDxApiKey } = config();

      options = baseOptions;
      if (config().googleOps) {
        Object.assign(options, googleOpsConfig);
      } else if (exportLogsHyperDx && hyperDxApiKey) {
        options.mixin = HyperDX.getPinoMixinFunction;

        options.transport = {
          targets: [
            {
              target: "@hyperdx/node-opentelemetry/build/src/otel-logger/pino",
              options: {
                apiKey: hyperDxApiKey,
                service: getServiceName(),
              },
              level: logLevel,
            },
          ],
        };
      }
    }

    const l = pino(options, destinationStream);
    LOGGER = l;
    return l;
  }
  return LOGGER;
}

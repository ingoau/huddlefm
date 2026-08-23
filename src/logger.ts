import pino from "pino";
import { redactSecrets, safeError } from "./error-message.ts";

const level = process.env.LOG_LEVEL ?? "info";
const file = process.env.LOG_FILE ?? "data/logs/huddlefm.jsonl";
const configuredFileCount = Number(process.env.LOG_FILE_COUNT ?? 7);
const fileCount =
  Number.isInteger(configuredFileCount) && configuredFileCount >= 0
    ? configuredFileCount
    : 7;
const testing =
  process.env.NODE_ENV === "test" || process.argv.includes("test");
const targets: pino.TransportTargetOptions[] = [
  {
    target: "pino/file",
    level,
    options: { destination: 1, sync: true },
  },
  ...(file
    ? [
        {
          target: "pino-roll",
          level,
          options: {
            file,
            frequency: "daily",
            dateFormat: "yyyy-MM-dd",
            size: process.env.LOG_FILE_SIZE ?? "10m",
            mkdir: true,
            sync: true,
            limit: {
              count: fileCount,
              removeOtherLogFiles: true,
            },
          },
        },
      ]
    : []),
];
const transport = testing ? undefined : pino.transport({ targets });

export const logger = pino(
  {
    enabled: !testing,
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: "huddlefm", pid: process.pid },
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "cookie",
        "*.cookie",
        "token",
        "*.token",
        "bridgeToken",
        "*.bridgeToken",
        "xapp",
        "xoxp",
        "xoxc",
        "xoxd",
        "lastFmApiKey",
        "lastFmSharedSecret",
        "lastFmSessionKey",
        "listenBrainzToken",
      ],
      censor: "[redacted]",
    },
    serializers: {
      err(error) {
        if (!(error instanceof Error)) return { message: safeError(error) };
        return {
          type: error.name,
          message: safeError(error),
          stack: error.stack ? redactSecrets(error.stack) : undefined,
        };
      },
    },
  },
  transport,
);

export function flushLogs() {
  transport?.flushSync();
}

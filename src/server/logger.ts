import pino from "pino";

// Any key that may carry a credential is redacted, at any depth up to the configured paths.
export const REDACT_PATHS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "authorization",
  "secret",
  "cookie",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.authorization",
  "*.secret",
  "*.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.headers.authorization",
  "*.headers.cookie",
];

export function createLogger(destination?: pino.DestinationStream) {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: process.env.SERVICE_NAME ?? "creator-farm" },
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

export const logger = createLogger();

import "server-only";

type LogLevel = "debug" | "info" | "warn" | "error";

const isDevelopment = process.env.NODE_ENV !== "production";
const redactedKeyPattern = /(token|password|passphrase|privatekey|publickey|secret|authorization)/iu;
const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLogLevel(): LogLevel {
  const configuredLevel = process.env.CLAW_FRIDGE_LOG_LEVEL?.trim().toLowerCase();

  if (configuredLevel === "debug" || configuredLevel === "info" || configuredLevel === "warn" || configuredLevel === "error") {
    return configuredLevel;
  }

  if (isDevelopment || process.env.CLAW_FRIDGE_VERBOSE_LOGS === "1") {
    return "info";
  }

  return "warn";
}

const activeLogLevel = resolveLogLevel();
const shouldEmitJsonLogs = process.env.CLAW_FRIDGE_LOG_JSON === "1";

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => {
        if (redactedKeyPattern.test(key)) {
          return [key, "[redacted]"];
        }

        return [key, sanitizeValue(nestedValue)];
      }),
    );
  }

  if (typeof value === "string" && value.length > 400) {
    return `${value.slice(0, 397)}...`;
  }

  return value;
}

function shouldLog(level: LogLevel) {
  return levelWeights[level] >= levelWeights[activeLogLevel];
}

function log(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (!shouldLog(level)) {
    return;
  }

  const logger =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "info"
          ? console.info
          : console.debug;

  const sanitizedMeta = meta && Object.keys(meta).length > 0 ? sanitizeValue(meta) : undefined;

  if (shouldEmitJsonLogs) {
    logger(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        scope,
        message,
        meta: sanitizedMeta,
      }),
    );
    return;
  }

  if (sanitizedMeta) {
    logger(`[claw-fridge:${scope}] ${message}`, sanitizedMeta);
    return;
  }

  logger(`[claw-fridge:${scope}] ${message}`);
}

/**
 * Log informational messages for development and debugging
 * Use for important business operations that should be visible in dev logs
 */
export function logDevInfo(scope: string, message: string, meta?: Record<string, unknown>) {
  log("info", scope, message, meta);
}

/**
 * Log warning messages for potential issues
 * Use for recoverable errors or deprecated usage patterns
 */
export function logDevWarn(scope: string, message: string, meta?: Record<string, unknown>) {
  log("warn", scope, message, meta);
}

/**
 * Log server errors with full context
 * Use for unexpected failures that should be investigated
 */
export function logServerError(scope: string, error: unknown, meta?: Record<string, unknown>) {
  const details: Record<string, unknown> = {
    ...meta,
  };

  if (error instanceof Error) {
    details.name = error.name;
    details.message = error.message;

    if (isDevelopment || activeLogLevel === "debug") {
      details.stack = error.stack;
    }
  } else {
    details.message = String(error);
  }

  log("error", scope, "unexpected failure", details);
}

/**
 * Log API operation success
 * Use for tracking successful API operations in development
 */
export function logApiOperation(scope: string, operation: string, meta?: Record<string, unknown>) {
  log("info", scope, `${operation} completed successfully`, meta);
}

/**
 * Log API operation failure
 * Use for tracking failed API operations
 */
export function logApiError(scope: string, operation: string, error: unknown, meta?: Record<string, unknown>) {
  const details: Record<string, unknown> = {
    operation,
    ...meta,
  };

  if (error instanceof Error) {
    details.errorName = error.name;
    details.errorMessage = error.message;
  } else {
    details.error = String(error);
  }

  log("error", scope, `${operation} failed`, details);
}

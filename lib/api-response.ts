import { NextResponse } from "next/server";
import type { OperationResultFields } from "@/types";

interface FailureResponseOptions {
  status: number;
  message: string;
  details?: string;
  errorCode?: string;
}

export interface OperationResultWithStatus extends Partial<OperationResultFields> {
  ok: boolean;
}

/**
 * Standard error codes for Claw-Fridge operations
 * Format: <domain>_<operation>_<error_type>
 */
export const ErrorCodes = {
  // Git configuration errors
  GIT_CONFIG_TEST_FAILED: "git_config_test_failed",
  GIT_CONFIG_INIT_FAILED: "git_config_init_failed",
  GIT_CONFIG_INVALID: "git_config_invalid",
  GIT_AUTH_FAILED: "git_auth_failed",
  GIT_CONNECTION_FAILED: "git_connection_failed",

  // Ice box errors
  ICEBOX_CREATE_FAILED: "icebox_create_failed",
  ICEBOX_NOT_FOUND: "icebox_not_found",
  ICEBOX_DELETE_FAILED: "icebox_delete_failed",

  // Upload token errors
  UPLOAD_TOKEN_CREATE_FAILED: "upload_token_create_failed",
  UPLOAD_TOKEN_REVOKE_FAILED: "upload_token_revoke_failed",
  UPLOAD_TOKEN_INVALID: "upload_token_invalid",
  UPLOAD_TOKEN_EXPIRED: "upload_token_expired",
  UPLOAD_TOKEN_REVOKED: "upload_token_revoked",

  // Upload errors
  UPLOAD_VALIDATION_ERROR: "upload_validation_error",
  UPLOAD_SIZE_EXCEEDED: "upload_size_exceeded",
  UPLOAD_DECRYPT_FAILED: "upload_decrypt_failed",
  UPLOAD_ARCHIVE_INVALID: "upload_archive_invalid",

  // Restore errors
  RESTORE_PREVIEW_FAILED: "restore_preview_failed",
  RESTORE_EXECUTE_FAILED: "restore_execute_failed",
  RESTORE_VALIDATION_ERROR: "restore_validation_error",
  RESTORE_OVERWRITE_REQUIRED: "restore_overwrite_required",

  // General errors
  INVALID_REQUEST: "invalid_request",
  INTERNAL_ERROR: "internal_error",
} as const;

function buildErrorShape(options: {
  status?: number;
  message?: string;
  details?: string;
  errorCode?: string;
}) {
  const { status, message, details, errorCode } = options;

  return {
    message: message ?? "请求失败。",
    details,
    code: errorCode,
    status,
  };
}

export function normalizeOperationResult<T extends OperationResultWithStatus>(
  result: T,
  fallbackStatus = 400,
): T {
  if (result.ok) {
    return result;
  }

  const status = result.statusCode ?? fallbackStatus;
  const message = result.message ?? result.error?.message ?? "请求失败。";
  const details = result.details ?? result.error?.details;
  const errorCode = result.errorCode ?? result.error?.code;

  return {
    ...result,
    message,
    details,
    errorCode,
    statusCode: status,
    error: buildErrorShape({
      status,
      message,
      details,
      errorCode,
    }),
  };
}

export function createFailureResponse<T extends Record<string, unknown>>(
  options: FailureResponseOptions & T,
) {
  const { status, message, details, errorCode, ...rest } = options;

  return NextResponse.json(
    normalizeOperationResult({
      ok: false,
      message,
      details,
      errorCode,
      statusCode: status,
      ...rest,
    }),
    { status },
  );
}

export function resolveResultStatus(result: OperationResultWithStatus, fallbackStatus = 400) {
  if (result.ok) {
    return 200;
  }

  return result.statusCode ?? result.error?.status ?? fallbackStatus;
}

export function getErrorDetails(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "未知错误";
}

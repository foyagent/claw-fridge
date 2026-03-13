import { tr } from "@/lib/client-translations";
import type { OperationResultFields } from "@/types";

function readLocaleFromCookie() {
  if (typeof document === "undefined") {
    return "zh";
  }

  const match = document.cookie.match(/(?:^|; )claw-fridge-locale=([^;]+)/);
  const locale = match ? decodeURIComponent(match[1]) : "zh";
  return locale.toLowerCase().includes("en") ? "en" : "zh";
}

function mergeHeaders(headers?: HeadersInit) {
  const merged = new Headers(headers ?? undefined);
  merged.set("Accept-Language", readLocaleFromCookie());
  return merged;
}

export function getApiRequestHeaders(headers?: HeadersInit) {
  return mergeHeaders(headers);
}

export interface ApiResultPayload extends Partial<OperationResultFields> {
  ok?: boolean;
}

export interface OperationNotice {
  message: string;
  details?: string;
  tone?: "success" | "info" | "warning" | "error";
}

function normalizePayload<T extends ApiResultPayload>(payload: T): T {
  const statusCode = payload.statusCode ?? payload.error?.status;
  const errorCode = payload.errorCode ?? payload.error?.code;
  const details = payload.details ?? payload.error?.details;
  const message = payload.message ?? payload.error?.message;

  return {
    ...payload,
    message,
    details,
    errorCode,
    statusCode,
    error:
      payload.error || message || details || errorCode || statusCode
        ? {
            message: message ?? tr("clientApi.requestFailed"),
            details,
            code: errorCode,
            status: statusCode,
          }
        : undefined,
  };
}

function buildDiagnosticLine(payload: ApiResultPayload | null | undefined) {
  const parts = [
    payload?.statusCode ? `HTTP ${payload.statusCode}` : null,
    payload?.errorCode ? tr("clientApi.errorCode", { code: payload.errorCode }) : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : null;
}

export async function readApiPayload<T extends ApiResultPayload>(response: Response): Promise<T> {
  try {
    return normalizePayload((await response.json()) as T);
  } catch {
    return normalizePayload({} as T);
  }
}

export function toOperationNotice(
  payload: ApiResultPayload | null | undefined,
  fallbackMessage: string,
  fallbackTone: OperationNotice["tone"] = "error",
): OperationNotice {
  const normalizedPayload = payload ? normalizePayload(payload) : payload;
  const message = normalizedPayload?.message?.trim() || fallbackMessage;
  const details = normalizedPayload?.details?.trim() || undefined;
  const diagnosticLine = buildDiagnosticLine(normalizedPayload);

  const tone = normalizedPayload?.ok === true ? "success" : fallbackTone;

  return {
    message,
    details: [details, diagnosticLine].filter(Boolean).join("\n") || undefined,
    tone,
  };
}

export function toRequestFailureNotice(actionLabel: string, error: unknown): OperationNotice {
  const details = error instanceof Error ? error.message : tr("clientApi.unknownError");

  return {
    message: tr("clientApi.localApiUnavailable", { action: actionLabel }),
    details: `${details}\n${tr("clientApi.checkDevServer")}`,
    tone: "error",
  };
}

export function toSuccessNotice(message: string, details?: string): OperationNotice {
  return {
    message,
    details,
    tone: "success",
  };
}

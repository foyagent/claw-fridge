import type { OperationResultFields } from "@/types";

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
            message: message ?? "请求失败。",
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
    payload?.errorCode ? `错误码：${payload.errorCode}` : null,
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
  const details = error instanceof Error ? error.message : "未知错误";

  return {
    message: `${actionLabel}暂时无法连接本地接口。`,
    details: `${details}\n请确认 dev server 仍在运行，并查看终端里的 claw-fridge 服务日志。`,
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

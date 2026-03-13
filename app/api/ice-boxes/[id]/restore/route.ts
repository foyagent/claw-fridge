import { NextResponse } from "next/server";
import { createFailureResponse, normalizeOperationResult, getErrorDetails, resolveResultStatus, ErrorCodes } from "@/lib/api-response";
import { previewIceBoxRestore, restoreIceBoxBackup } from "@/lib/ice-box-restore.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";
import type { RestoreExecuteRequest, RestorePreviewRequest, RestoreRequest } from "@/types";

export const runtime = "nodejs";

function isRestoreRequest(value: unknown): value is RestoreRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RestoreRequest>;

  return candidate.action === "preview" || candidate.action === "restore";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = (await request.json()) as unknown;

    if (!isRestoreRequest(body)) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("无效的恢复请求。", request))!,
        details: await translateApiText("请求体必须包含合法的 action，并补齐恢复所需字段。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        restoredAt: new Date().toISOString(),
      });
    }

    const gitConfig =
      body && typeof body === "object" && "gitConfig" in body && typeof body.gitConfig === "object" && body.gitConfig
        ? body.gitConfig
        : {
            repository: "",
            kind: "local" as const,
            auth: { method: "none" as const },
            updatedAt: null,
          };

    if (body.action === "preview") {
      const previewRequest = body as RestorePreviewRequest;
      const result = await previewIceBoxRestore({
        backupMode: previewRequest.backupMode ?? "git-branch",
        machineId: previewRequest.machineId ?? id,
        branch: previewRequest.branch ?? "",
        commit: previewRequest.commit,
        gitConfig,
        targetRootDir: previewRequest.targetRootDir,
      });

      return NextResponse.json(await localizeOperationResult(result, request), {
        status: resolveResultStatus(result),
      });
    }

    const restoreRequest = body as RestoreExecuteRequest;

    const result = await restoreIceBoxBackup({
      backupMode: restoreRequest.backupMode ?? "git-branch",
      machineId: restoreRequest.machineId ?? id,
      branch: restoreRequest.branch ?? "",
      commit: restoreRequest.commit,
      gitConfig,
      targetRootDir: restoreRequest.targetRootDir ?? "",
      confirmRestore: Boolean(restoreRequest.confirmRestore),
      replaceExisting: restoreRequest.replaceExisting,
    });

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result, result.requiresOverwriteConfirmation ? 409 : 400), request), {
      status: resolveResultStatus(result, result.requiresOverwriteConfirmation ? 409 : 400),
    });
  } catch (error) {
    logServerError("api.ice-box.restore", error, { iceBoxId: id });

    return createFailureResponse({
      status: 500,
      message: (await translateApiText(`冰盒 \`${id}\` 恢复接口执行失败。`, request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.RESTORE_EXECUTE_FAILED,
      restoredAt: new Date().toISOString(),
    });
  }
}

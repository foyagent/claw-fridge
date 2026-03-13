import { NextResponse } from "next/server";
import { createFailureResponse, normalizeOperationResult, getErrorDetails, resolveResultStatus } from "@/lib/api-response";
import { listIceBoxBackupHistory } from "@/lib/ice-box-restore.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";
import type { GitRepositoryConfig } from "@/types";

export const runtime = "nodejs";

interface HistoryRequest {
  machineId?: string;
  branch?: string;
  gitConfig?: GitRepositoryConfig;
  limit?: number;
}

function isHistoryRequest(value: unknown): value is HistoryRequest {
  return Boolean(value) && typeof value === "object";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = (await request.json()) as unknown;

    if (!isHistoryRequest(body)) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("无效的历史记录请求。", request))!,
        details: await translateApiText("请求体必须包含有效的 machine-id、branch 和 gitConfig 信息。", request),
        errorCode: "invalid_history_payload",
        fetchedAt: new Date().toISOString(),
      });
    }

    const gitConfig =
      body.gitConfig && typeof body.gitConfig === "object"
        ? body.gitConfig
        : {
            repository: "",
            kind: "local" as const,
            auth: { method: "none" as const },
            updatedAt: null,
          };

    const result = await listIceBoxBackupHistory({
      machineId: body.machineId ?? id,
      branch: body.branch ?? "",
      gitConfig,
      limit: body.limit,
    });

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result), request), {
      status: resolveResultStatus(result),
    });
  } catch (error) {
    logServerError("api.ice-box.history", error, { iceBoxId: id });

    return createFailureResponse({
      status: 500,
      message: (await translateApiText(`冰盒 \`${id}\` 备份历史接口执行失败。`, request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: "ice_box_history_route_failed",
      fetchedAt: new Date().toISOString(),
    });
  }
}

import { NextResponse } from "next/server";
import {
  createFailureResponse,
  normalizeOperationResult,
  getErrorDetails,
  resolveResultStatus,
  ErrorCodes,
} from "@/lib/api-response";
import { fetchIceBoxesFromGit } from "@/lib/ice-box-sync.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";
import type { GitRepositoryConfig } from "@/types";

export const runtime = "nodejs";

interface ListIceBoxesRequestBody {
  gitConfig: GitRepositoryConfig;
}

/**
 * POST /api/ice-boxes/list - Fetch ice boxes from fridge-config branch
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<ListIceBoxesRequestBody>;

    if (!body?.gitConfig?.repository) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("请提供 Git 配置。", request))!,
        details: await translateApiText("请求体必须包含有效的 Git 配置对象。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        syncedAt: new Date().toISOString(),
      });
    }

    const result = await fetchIceBoxesFromGit(body.gitConfig);

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result), request), {
      status: resolveResultStatus(result),
    });
  } catch (error) {
    logServerError("api.ice-boxes.list", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("拉取冰盒列表接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.ICEBOX_CREATE_FAILED,
      syncedAt: new Date().toISOString(),
    });
  }
}

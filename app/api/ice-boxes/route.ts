import { NextResponse } from "next/server";
import {
  createFailureResponse,
  normalizeOperationResult,
  getErrorDetails,
  resolveResultStatus,
  ErrorCodes,
} from "@/lib/api-response";
import { fetchIceBoxesFromGit, createIceBoxInGit } from "@/lib/ice-box-sync.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";
import type { GitRepositoryConfig, IceBoxListItem } from "@/types";

export const runtime = "nodejs";

interface GetIceBoxesRequestBody {
  gitConfig: GitRepositoryConfig;
}

interface CreateIceBoxRequestBody {
  gitConfig: GitRepositoryConfig;
  item: IceBoxListItem;
}

/**
 * GET /api/ice-boxes - Fetch ice boxes from GitHub
 */
export async function GET(request: Request) {
  try {
    const body = (await request.json()) as Partial<GetIceBoxesRequestBody>;

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
    logServerError("api.ice-boxes.fetch", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("拉取冰盒列表接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.ICEBOX_CREATE_FAILED,
      syncedAt: new Date().toISOString(),
    });
  }
}

/**
 * POST /api/ice-boxes - Create a new ice box and sync to GitHub
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<CreateIceBoxRequestBody>;

    if (!body?.gitConfig?.repository) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("请提供 Git 配置。", request))!,
        details: await translateApiText("请求体必须包含有效的 Git 配置对象。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        syncedAt: new Date().toISOString(),
      });
    }

    if (!body?.item?.id || !body?.item?.name) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("请提供冰盒信息。", request))!,
        details: await translateApiText("请求体必须包含有效的冰盒对象（包含 id 和 name）。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        syncedAt: new Date().toISOString(),
      });
    }

    const result = await createIceBoxInGit(body.gitConfig, body.item);

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result), request), {
      status: resolveResultStatus(result),
    });
  } catch (error) {
    logServerError("api.ice-boxes.create", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("创建冰盒接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.ICEBOX_CREATE_FAILED,
      syncedAt: new Date().toISOString(),
    });
  }
}

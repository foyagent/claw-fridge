import { NextResponse } from "next/server";
import {
  createFailureResponse,
  normalizeOperationResult,
  getErrorDetails,
  resolveResultStatus,
  ErrorCodes,
} from "@/lib/api-response";
import { updateIceBoxInGit, deleteIceBoxFromGit } from "@/lib/ice-box-sync.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";
import type { GitRepositoryConfig, IceBoxListItem } from "@/types";

export const runtime = "nodejs";

interface UpdateIceBoxRequestBody {
  gitConfig: GitRepositoryConfig;
  updates: Partial<IceBoxListItem>;
}

interface DeleteIceBoxRequestBody {
  gitConfig: GitRepositoryConfig;
}

/**
 * PUT /api/ice-boxes/[id] - Update an ice box and sync to GitHub
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as Partial<UpdateIceBoxRequestBody>;

    if (!body?.gitConfig?.repository) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("请提供 Git 配置。", request))!,
        details: await translateApiText("请求体必须包含有效的 Git 配置对象。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        syncedAt: new Date().toISOString(),
      });
    }

    if (!body?.updates || typeof body.updates !== "object") {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("请提供更新内容。", request))!,
        details: await translateApiText("请求体必须包含 updates 字段。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        syncedAt: new Date().toISOString(),
      });
    }

    const result = await updateIceBoxInGit(body.gitConfig, id, body.updates);

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result), request), {
      status: resolveResultStatus(result),
    });
  } catch (error) {
    logServerError("api.ice-boxes.update", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("更新冰盒接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.ICEBOX_CREATE_FAILED,
      syncedAt: new Date().toISOString(),
    });
  }
}

/**
 * DELETE /api/ice-boxes/[id] - Delete an ice box and sync to GitHub
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as Partial<DeleteIceBoxRequestBody>;

    if (!body?.gitConfig?.repository) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("请提供 Git 配置。", request))!,
        details: await translateApiText("请求体必须包含有效的 Git 配置对象。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        syncedAt: new Date().toISOString(),
      });
    }

    const result = await deleteIceBoxFromGit(body.gitConfig, id);

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result), request), {
      status: resolveResultStatus(result),
    });
  } catch (error) {
    logServerError("api.ice-boxes.delete", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("删除冰盒接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.ICEBOX_DELETE_FAILED,
      syncedAt: new Date().toISOString(),
    });
  }
}

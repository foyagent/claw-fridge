import { NextResponse } from "next/server";
import {
  createFailureResponse,
  normalizeOperationResult,
  getErrorDetails,
  resolveResultStatus,
  ErrorCodes,
} from "@/lib/api-response";
import { createIceBoxInGit, updateIceBoxInGit } from "@/lib/ice-box-sync.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";
import type { GitRepositoryConfig, IceBoxListItem } from "@/types";

export const runtime = "nodejs";

interface SyncIceBoxRequestBody {
  gitConfig: GitRepositoryConfig;
  item: IceBoxListItem;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as Partial<SyncIceBoxRequestBody>;

    if (!body?.gitConfig?.repository) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("请提供 Git 配置。", request))!,
        details: await translateApiText("请求体必须包含有效的 Git 配置对象。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        syncedAt: new Date().toISOString(),
      });
    }

    if (!body?.item?.id || body.item.id !== id) {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("请提供匹配的冰盒信息。", request))!,
        details: await translateApiText("请求体必须包含 item，且 item.id 需要与路由参数一致。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        syncedAt: new Date().toISOString(),
      });
    }

    const preparedItem: IceBoxListItem = {
      ...body.item,
      syncStatus: "synced",
      lastSyncAt: new Date().toISOString(),
      lastSyncError: null,
    };

    let result = await createIceBoxInGit(body.gitConfig, preparedItem);

    if (!result.ok && result.errorCode === "ice_box_exists") {
      result = await updateIceBoxInGit(body.gitConfig, id, {
        ...preparedItem,
      });
    }

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result), request), {
      status: resolveResultStatus(result),
    });
  } catch (error) {
    logServerError("api.ice-boxes.sync", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("补偿同步接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.ICEBOX_CREATE_FAILED,
      syncedAt: new Date().toISOString(),
    });
  }
}

import { NextResponse } from "next/server";
import { createFailureResponse, normalizeOperationResult, getErrorDetails, resolveResultStatus, ErrorCodes } from "@/lib/api-response";
import { normalizeGitConfig } from "@/lib/git-config";
import { initializeFridgeConfigBranch } from "@/lib/git-config.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";
import type { GitRepositoryConfig } from "@/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<GitRepositoryConfig>;

    if (!body || typeof body !== "object") {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("无效的 Git 配置请求。", request))!,
        details: await translateApiText("请求体必须是合法的 Git 配置对象。", request),
        errorCode: ErrorCodes.GIT_CONFIG_INVALID,
      });
    }

    const config = normalizeGitConfig({
      repository: body.repository ?? "",
      kind: body.kind ?? "local",
      auth: body.auth ?? { method: "none" },
      updatedAt: body.updatedAt ?? null,
    });
    const result = await initializeFridgeConfigBranch(config);

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result), request), {
      status: resolveResultStatus(result),
    });
  } catch (error) {
    logServerError("api.git-config.init", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("Git 配置初始化接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.GIT_CONFIG_INIT_FAILED,
      initializedAt: new Date().toISOString(),
    });
  }
}

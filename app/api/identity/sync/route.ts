import { NextResponse } from "next/server";
import { createFailureResponse, normalizeOperationResult, getErrorDetails } from "@/lib/api-response";
import { syncIdentityFile } from "@/lib/identity.server";
import { logServerError } from "@/lib/server-logger";
import type { SyncIdentityOptions } from "@/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<SyncIdentityOptions>;

    if (!body || typeof body !== "object" || typeof body.rootDir !== "string" || !body.rootDir.trim()) {
      return createFailureResponse({
        status: 400,
        message: "无效的身份同步请求，请提供 rootDir。",
        details: "rootDir 必须是非空字符串。",
        errorCode: "invalid_identity_sync_payload",
      });
    }

    const result = await syncIdentityFile({
      rootDir: body.rootDir,
      outputFileName: typeof body.outputFileName === "string" ? body.outputFileName : undefined,
      force: Boolean(body.force),
    });

    return NextResponse.json(normalizeOperationResult(result), {
      status: 200,
    });
  } catch (error) {
    logServerError("api.identity.sync", error);

    return createFailureResponse({
      status: 500,
      message: "身份同步接口执行失败。",
      details: getErrorDetails(error),
      errorCode: "identity_sync_route_failed",
    });
  }
}

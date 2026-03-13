import { NextResponse } from "next/server";
import { createFailureResponse, normalizeOperationResult, getErrorDetails, resolveResultStatus } from "@/lib/api-response";
import { revokeIceBoxUploadToken } from "@/lib/ice-box-upload.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; uploadId: string }> },
) {
  try {
    const { id, uploadId } = await params;
    const result = await revokeIceBoxUploadToken(id, uploadId);

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result, 404), request), {
      status: resolveResultStatus(result, 404),
    });
  } catch (error) {
    logServerError("api.upload-token.revoke", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("撤销上传 token 接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: "upload_token_revoke_route_failed",
      revokedAt: new Date().toISOString(),
    });
  }
}

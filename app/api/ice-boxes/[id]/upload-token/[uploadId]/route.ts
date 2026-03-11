import { NextResponse } from "next/server";
import { createFailureResponse, normalizeOperationResult, getErrorDetails, resolveResultStatus } from "@/lib/api-response";
import { revokeIceBoxUploadToken } from "@/lib/ice-box-upload.server";
import { logServerError } from "@/lib/server-logger";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; uploadId: string }> },
) {
  try {
    const { id, uploadId } = await params;
    const result = await revokeIceBoxUploadToken(id, uploadId);

    return NextResponse.json(normalizeOperationResult(result, 404), {
      status: resolveResultStatus(result, 404),
    });
  } catch (error) {
    logServerError("api.upload-token.revoke", error);

    return createFailureResponse({
      status: 500,
      message: "撤销上传 token 接口执行失败。",
      details: getErrorDetails(error),
      errorCode: "upload_token_revoke_route_failed",
      revokedAt: new Date().toISOString(),
    });
  }
}

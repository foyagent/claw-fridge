import { NextResponse } from "next/server";
import { createFailureResponse, normalizeOperationResult, getErrorDetails, resolveResultStatus, ErrorCodes } from "@/lib/api-response";
import { createIceBoxUploadToken } from "@/lib/ice-box-upload.server";
import { logServerError } from "@/lib/server-logger";
import { localizeOperationResult, translateApiText } from "@/lib/server-translations";
import type { CreateUploadTokenInput } from "@/types";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as Partial<CreateUploadTokenInput>;

    if (!body || typeof body !== "object") {
      return createFailureResponse({
        status: 400,
        message: (await translateApiText("无效的上传 token 请求。", request))!,
        details: await translateApiText("请求体必须包含合法的冰盒名称、machine-id 和 Git 配置。", request),
        errorCode: ErrorCodes.INVALID_REQUEST,
        createdAt: new Date().toISOString(),
      });
    }

    const result = await createIceBoxUploadToken(id, {
      iceBoxName: body.iceBoxName ?? "",
      machineId: body.machineId ?? "",
      gitConfig: body.gitConfig ?? {
        repository: "",
        kind: "local",
        auth: { method: "none" },
        updatedAt: null,
      },
      encryption: body.encryption ?? {
        version: 1,
        enabled: false,
        scope: "upload-payload",
        algorithm: "aes-256-gcm",
        kdf: "pbkdf2-sha256",
        kdfSalt: null,
        kdfIterations: 210000,
        keyStrategy: "manual-entry",
        keyHint: null,
        updatedAt: new Date().toISOString(),
      },
      expiresInHours: body.expiresInHours,
    });

    return NextResponse.json(await localizeOperationResult(normalizeOperationResult(result), request), {
      status: resolveResultStatus(result),
    });
  } catch (error) {
    logServerError("api.upload-token.create", error);

    return createFailureResponse({
      status: 500,
      message: (await translateApiText("上传 token 接口执行失败。", request))!,
      details: await translateApiText(getErrorDetails(error), request),
      errorCode: ErrorCodes.UPLOAD_TOKEN_CREATE_FAILED,
      createdAt: new Date().toISOString(),
    });
  }
}

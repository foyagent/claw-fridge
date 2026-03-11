import "server-only";

import Busboy from "busboy";
import { createDecipheriv, createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { normalizeGitConfig } from "@/lib/git-config";
import {
  formatErrorMessage,
  prepareInitializationEnvironment,
  runGitCommand,
  tryRunGitCommand,
} from "@/lib/git-config.server";
import {
  createDisabledEncryptionConfig,
  isEncryptionEnabled,
  uploadPayloadEncryptionAlgorithm,
  uploadPayloadEncryptionHeaders,
} from "@/lib/backup-encryption";
import { iceBoxBranchPrefix } from "@/lib/git";
import { logDevInfo, logServerError } from "@/lib/server-logger";
import type {
  CreateUploadTokenInput,
  CreateUploadTokenResult,
  RevokeUploadTokenResult,
  UploadBackupResult,
  UploadTokenRecord,
  UploadTokenStoreFile,
} from "@/types";

const execFileAsync = promisify(execFile);
const gitCommitAuthorName = "Claw Fridge";
const gitCommitAuthorEmail = "claw-fridge@local";
const maxUploadBytes = 512 * 1024 * 1024;
const defaultTokenLifetimeHours = 24 * 30;
const multipartMimeTypes = new Set([
  "application/gzip",
  "application/x-gzip",
  "application/octet-stream",
  "application/x-tar",
]);
const rawMimeTypes = new Set(["application/gzip", "application/x-gzip", "application/octet-stream"]);
const uploadDataDirectory = path.join(process.cwd(), ".claw-fridge");
const uploadTokenStorePath = path.join(uploadDataDirectory, "upload-tokens.json");

let uploadTokenStoreQueue: Promise<void> = Promise.resolve();
const branchQueues = new Map<string, Promise<void>>();

class UploadValidationError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly errorCode: string = "upload_validation_error",
  ) {
    super(message);
    this.name = "UploadValidationError";
  }
}

class SizeLimitTransform extends Transform {
  public bytesReceived = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ) {
    this.bytesReceived += chunk.length;

    if (this.bytesReceived > this.maxBytes) {
      callback(new UploadValidationError(`上传文件超过限制（最大 ${formatBytes(this.maxBytes)}）。`, 413));
      return;
    }

    callback(null, chunk);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function createStoreFile(): UploadTokenStoreFile {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: [],
  };
}

function createUploadId(): string {
  return randomBytes(8).toString("hex");
}

function createUploadToken(): string {
  return `cfu_${randomBytes(24).toString("base64url")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeCompareToken(token: string, tokenHash: string): boolean {
  const left = Buffer.from(hashToken(token), "utf8");
  const right = Buffer.from(tokenHash, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function isExpired(expiresAt: string): boolean {
  return Date.now() >= new Date(expiresAt).getTime();
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();

  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim() || null;
  }

  return request.headers.get("x-upload-token")?.trim() || null;
}

async function ensureUploadDataDirectory() {
  await mkdir(uploadDataDirectory, { recursive: true });
  await chmod(uploadDataDirectory, 0o700).catch(() => undefined);
}

async function readUploadTokenStoreUnsafe(): Promise<UploadTokenStoreFile> {
  try {
    const raw = await readFile(uploadTokenStorePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<UploadTokenStoreFile>;

    if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
      throw new Error("上传 token 存储文件格式无效。");
    }

    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      items: parsed.items as UploadTokenRecord[],
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError?.code === "ENOENT") {
      return createStoreFile();
    }

    throw error;
  }
}

async function writeUploadTokenStoreUnsafe(store: UploadTokenStoreFile) {
  await ensureUploadDataDirectory();

  const nextStore: UploadTokenStoreFile = {
    ...store,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${uploadTokenStorePath}.tmp`;

  await writeFile(tempPath, `${JSON.stringify(nextStore, null, 2)}\n`, "utf8");
  await chmod(tempPath, 0o600).catch(() => undefined);
  await rename(tempPath, uploadTokenStorePath);
  await chmod(uploadTokenStorePath, 0o600).catch(() => undefined);
}

async function withUploadTokenStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const nextOperation = uploadTokenStoreQueue.then(operation, operation);
  uploadTokenStoreQueue = nextOperation.then(
    () => undefined,
    () => undefined,
  );

  return nextOperation;
}

async function withBranchLock<T>(branch: string, operation: () => Promise<T>): Promise<T> {
  const previous = branchQueues.get(branch) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );

  branchQueues.set(branch, queued);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();

    if (branchQueues.get(branch) === queued) {
      branchQueues.delete(branch);
    }
  }
}

function resolveBranch(machineId: string): string {
  return `${iceBoxBranchPrefix}/${machineId}`;
}

function resolveUploadPath(iceBoxId: string, uploadId: string): string {
  return `/api/ice-boxes/${iceBoxId}/upload/${uploadId}`;
}

function validateTokenLifetimeHours(hours: number | undefined): number {
  if (hours === undefined) {
    return defaultTokenLifetimeHours;
  }

  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
    throw new UploadValidationError("Token 有效期必须在 0 到 8760 小时之间。", 400);
  }

  return Math.floor(hours);
}

function normalizeTokenRecord(record: UploadTokenRecord): UploadTokenRecord {
  return {
    ...record,
    gitConfig: normalizeGitConfig(record.gitConfig),
    machineId: slugifySegment(record.machineId),
    branch: record.branch.trim(),
    uploadPath: record.uploadPath.trim(),
    iceBoxId: slugifySegment(record.iceBoxId),
    encryption: record.encryption ?? createDisabledEncryptionConfig(record.updatedAt),
  };
}

export async function createIceBoxUploadToken(
  iceBoxId: string,
  input: CreateUploadTokenInput,
): Promise<CreateUploadTokenResult> {
  try {
    const normalizedIceBoxId = slugifySegment(iceBoxId);
    const machineId = slugifySegment(input.machineId);
    const iceBoxName = input.iceBoxName.trim();
    const gitConfig = normalizeGitConfig(input.gitConfig);
    const lifetimeHours = validateTokenLifetimeHours(input.expiresInHours);
    const createdAt = new Date().toISOString();

    if (!normalizedIceBoxId) {
      throw new UploadValidationError("ice-box-id 不合法。", 400);
    }

    if (!iceBoxName) {
      throw new UploadValidationError("冰盒名称不能为空。", 400);
    }

    if (!machineId) {
      throw new UploadValidationError("machine-id 不合法。", 400);
    }

    if (!gitConfig.repository) {
      throw new UploadValidationError("请先提供有效的 Git 仓库配置。", 400);
    }

    const branch = resolveBranch(machineId);
    const uploadId = createUploadId();
    const uploadToken = createUploadToken();
    const uploadPath = resolveUploadPath(normalizedIceBoxId, uploadId);
    const expiresAt = new Date(Date.now() + lifetimeHours * 60 * 60 * 1000).toISOString();

    await withUploadTokenStoreLock(async () => {
      const store = await readUploadTokenStoreUnsafe();
      const items = store.items.map((item) => {
        if (item.iceBoxId !== normalizedIceBoxId || item.revokedAt) {
          return item;
        }

        return {
          ...item,
          revokedAt: createdAt,
          updatedAt: createdAt,
        };
      });

      items.push(
        normalizeTokenRecord({
          id: uploadId,
          iceBoxId: normalizedIceBoxId,
          iceBoxName,
          machineId,
          branch,
          uploadPath,
          tokenHash: hashToken(uploadToken),
          gitConfig,
          encryption: input.encryption,
          createdAt,
          updatedAt: createdAt,
          expiresAt,
          revokedAt: null,
          lastUsedAt: null,
          lastBackupAt: null,
        }),
      );

      await writeUploadTokenStoreUnsafe({
        version: 1,
        updatedAt: createdAt,
        items,
      });
    });

    logDevInfo("upload-token.create", "upload token created", {
      iceBoxId: normalizedIceBoxId,
      machineId,
      branch,
      uploadId,
      expiresAt,
    });

    return {
      ok: true,
      message: "上传地址和 token 已生成。",
      createdAt,
      iceBoxId: normalizedIceBoxId,
      machineId,
      branch,
      uploadId,
      uploadPath,
      uploadToken,
      expiresAt,
    };
  } catch (error) {
    if (!(error instanceof UploadValidationError)) {
      logServerError("upload-token.create", error, { iceBoxId });
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "生成上传 token 失败。",
      details: error instanceof UploadValidationError ? undefined : formatErrorMessage(error),
      errorCode: error instanceof UploadValidationError ? error.errorCode : "upload_token_create_failed",
      statusCode: error instanceof UploadValidationError ? error.status : 500,
      createdAt: new Date().toISOString(),
    };
  }
}

export async function revokeIceBoxUploadToken(
  iceBoxId: string,
  uploadId: string,
): Promise<RevokeUploadTokenResult> {
  const revokedAt = new Date().toISOString();
  const normalizedIceBoxId = slugifySegment(iceBoxId);
  const normalizedUploadId = uploadId.trim();

  try {
    if (!normalizedIceBoxId || !normalizedUploadId) {
      throw new UploadValidationError("缺少有效的 ice-box-id 或 upload-id。", 400);
    }

    let found = false;
    let alreadyRevoked = false;

    await withUploadTokenStoreLock(async () => {
      const store = await readUploadTokenStoreUnsafe();
      const items = store.items.map((item) => {
        if (item.iceBoxId !== normalizedIceBoxId || item.id !== normalizedUploadId) {
          return item;
        }

        found = true;
        alreadyRevoked = Boolean(item.revokedAt);

        if (item.revokedAt) {
          return item;
        }

        return {
          ...item,
          revokedAt,
          updatedAt: revokedAt,
        };
      });

      if (!found) {
        throw new UploadValidationError("未找到对应的上传 token。", 404);
      }

      await writeUploadTokenStoreUnsafe({
        version: 1,
        updatedAt: revokedAt,
        items,
      });
    });

    logDevInfo("upload-token.revoke", "upload token revoked", {
      iceBoxId: normalizedIceBoxId,
      uploadId: normalizedUploadId,
      alreadyRevoked,
    });

    return {
      ok: true,
      message: alreadyRevoked ? "上传 token 已经是撤销状态。" : "上传 token 已撤销。",
      revokedAt,
      iceBoxId: normalizedIceBoxId,
      uploadId: normalizedUploadId,
    };
  } catch (error) {
    if (!(error instanceof UploadValidationError)) {
      logServerError("upload-token.revoke", error, {
        iceBoxId: normalizedIceBoxId || undefined,
        uploadId: normalizedUploadId || undefined,
      });
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "撤销上传 token 失败。",
      details: error instanceof UploadValidationError ? undefined : formatErrorMessage(error),
      errorCode: error instanceof UploadValidationError ? error.errorCode : "upload_token_revoke_failed",
      statusCode: error instanceof UploadValidationError ? error.status : 500,
      revokedAt,
      iceBoxId: normalizedIceBoxId || undefined,
      uploadId: normalizedUploadId || undefined,
    };
  }
}

async function findUploadTokenRecord(
  iceBoxId: string,
  uploadId: string,
): Promise<UploadTokenRecord | null> {
  return withUploadTokenStoreLock(async () => {
    const store = await readUploadTokenStoreUnsafe();

    return (
      store.items
        .map((item) => normalizeTokenRecord(item))
        .find((item) => item.iceBoxId === iceBoxId && item.id === uploadId) ?? null
    );
  });
}

async function touchUploadTokenRecord(
  iceBoxId: string,
  uploadId: string,
  updates: Partial<Pick<UploadTokenRecord, "updatedAt" | "lastUsedAt" | "lastBackupAt">>,
) {
  await withUploadTokenStoreLock(async () => {
    const store = await readUploadTokenStoreUnsafe();
    const items = store.items.map((item) => {
      if (item.iceBoxId !== iceBoxId || item.id !== uploadId) {
        return item;
      }

      return {
        ...item,
        ...updates,
      };
    });

    await writeUploadTokenStoreUnsafe({
      version: 1,
      updatedAt: updates.updatedAt ?? new Date().toISOString(),
      items,
    });
  });
}

async function authenticateUploadRequest(request: Request, iceBoxId: string, uploadId: string) {
  const normalizedIceBoxId = slugifySegment(iceBoxId);
  const normalizedUploadId = uploadId.trim();

  if (!normalizedIceBoxId || !normalizedUploadId) {
    throw new UploadValidationError("上传地址无效。", 404);
  }

  const token = readBearerToken(request);

  if (!token) {
    throw new UploadValidationError("缺少上传 token。", 401);
  }

  const record = await findUploadTokenRecord(normalizedIceBoxId, normalizedUploadId);

  if (!record) {
    throw new UploadValidationError("上传地址不存在。", 404);
  }

  if (record.revokedAt) {
    throw new UploadValidationError("上传 token 已撤销。", 410);
  }

  if (isExpired(record.expiresAt)) {
    throw new UploadValidationError("上传 token 已过期。", 410);
  }

  if (!safeCompareToken(token, record.tokenHash)) {
    throw new UploadValidationError("上传 token 无效。", 401);
  }

  return record;
}

function decodeBase64Header(value: string, label: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64");

    if (!decoded.length) {
      throw new Error("empty");
    }

    return decoded;
  } catch {
    throw new UploadValidationError(`${label} 格式无效。`, 400);
  }
}

function readUploadEncryptionRequest(request: Request, record: UploadTokenRecord) {
  const algorithm = request.headers.get(uploadPayloadEncryptionHeaders.algorithm)?.trim().toLowerCase() ?? null;

  if (!isEncryptionEnabled(record.encryption)) {
    if (algorithm) {
      throw new UploadValidationError("当前冰盒未启用上传加密，请移除加密请求头后重试。", 400);
    }

    return null;
  }

  if (!algorithm) {
    throw new UploadValidationError("当前冰盒要求加密上传，请带上加密请求头和主密钥后重试。", 400);
  }

  if (algorithm !== uploadPayloadEncryptionAlgorithm) {
    throw new UploadValidationError(`当前仅支持 ${uploadPayloadEncryptionAlgorithm} 上传加密。`, 400);
  }

  if (!record.encryption.kdfSalt) {
    throw new UploadValidationError("冰盒加密配置不完整，缺少 KDF Salt。", 400);
  }

  const ivHeader = request.headers.get(uploadPayloadEncryptionHeaders.iv)?.trim();
  const authTagHeader = request.headers.get(uploadPayloadEncryptionHeaders.authTag)?.trim();
  const passphrase = request.headers.get(uploadPayloadEncryptionHeaders.passphrase)?.trim() ?? "";

  if (!ivHeader || !authTagHeader) {
    throw new UploadValidationError("缺少加密上传所需的 IV 或 Auth Tag。", 400);
  }

  if (!passphrase) {
    throw new UploadValidationError("缺少加密上传主密钥。", 401);
  }

  const iv = decodeBase64Header(ivHeader, "加密 IV");
  const authTag = decodeBase64Header(authTagHeader, "加密 Auth Tag");

  if (iv.length !== 12) {
    throw new UploadValidationError("AES-GCM IV 长度必须为 12 字节。", 400);
  }

  if (authTag.length !== 16) {
    throw new UploadValidationError("AES-GCM Auth Tag 长度必须为 16 字节。", 400);
  }

  return {
    passphrase,
    iv,
    authTag,
  };
}

async function decryptUploadedArchive(
  sourcePath: string,
  targetPath: string,
  request: Request,
  record: UploadTokenRecord,
) {
  const encryptionRequest = readUploadEncryptionRequest(request, record);

  if (!encryptionRequest) {
    return sourcePath;
  }

  const key = pbkdf2Sync(
    encryptionRequest.passphrase,
    Buffer.from(record.encryption.kdfSalt ?? "", "base64"),
    record.encryption.kdfIterations,
    32,
    "sha256",
  );
  const decipher = createDecipheriv(uploadPayloadEncryptionAlgorithm, key, encryptionRequest.iv);
  decipher.setAuthTag(encryptionRequest.authTag);

  try {
    await pipeline(fs.createReadStream(sourcePath), decipher, fs.createWriteStream(targetPath));
    return targetPath;
  } catch {
    throw new UploadValidationError("上传密钥无效，或加密文件已经损坏，无法解密备份。", 400);
  }
}

async function assertGzipArchive(filePath: string) {
  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(2);
    await handle.read(buffer, 0, 2, 0);

    if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
      throw new UploadValidationError("上传文件不是合法的 gzip 压缩包。", 400);
    }
  } finally {
    await handle.close();
  }
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  try {
    const result = await execFileAsync("tar", ["-tzf", archivePath], {
      maxBuffer: 16 * 1024 * 1024,
    });

    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new UploadValidationError(
      `无法读取 tar.gz 内容：${error instanceof Error ? error.message : "未知错误"}`,
      400,
    );
  }
}

function validateArchiveEntries(entries: string[]) {
  if (!entries.length) {
    throw new UploadValidationError("压缩包内容为空。", 400);
  }

  let hasOpenClawDirectory = false;

  for (const entry of entries) {
    const normalizedEntry = entry.replace(/^\.\//u, "").replace(/\/+$/u, "");

    if (!normalizedEntry) {
      continue;
    }

    if (normalizedEntry.startsWith("/")) {
      throw new UploadValidationError("压缩包包含绝对路径，已拒绝处理。", 400);
    }

    if (normalizedEntry.split("/").some((segment) => segment === "..")) {
      throw new UploadValidationError("压缩包包含不安全路径，已拒绝处理。", 400);
    }

    if (normalizedEntry === ".openclaw" || normalizedEntry.startsWith(".openclaw/")) {
      hasOpenClawDirectory = true;
    }
  }

  if (!hasOpenClawDirectory) {
    throw new UploadValidationError("压缩包内缺少 `.openclaw` 目录。", 400);
  }
}

async function extractArchive(archivePath: string, extractDirectory: string) {
  await mkdir(extractDirectory, { recursive: true });

  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDirectory], {
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new UploadValidationError(
      `解压 tar.gz 失败：${error instanceof Error ? error.message : "未知错误"}`,
      400,
    );
  }

  const openClawDirectory = path.join(extractDirectory, ".openclaw");

  try {
    const openClawStat = await stat(openClawDirectory);

    if (!openClawStat.isDirectory()) {
      throw new UploadValidationError("解压后的 `.openclaw` 不是目录。", 400);
    }
  } catch (error) {
    if (error instanceof UploadValidationError) {
      throw error;
    }

    throw new UploadValidationError("解压后未找到 `.openclaw` 目录。", 400);
  }

  return openClawDirectory;
}

async function clearDirectoryExceptGit(targetDirectory: string) {
  const entries = await readdir(targetDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }

    await rm(path.join(targetDirectory, entry.name), { recursive: true, force: true });
  }
}

async function stageBackupContents(sourceOpenClawDirectory: string, workingDirectory: string) {
  await clearDirectoryExceptGit(workingDirectory);
  await cp(sourceOpenClawDirectory, path.join(workingDirectory, ".openclaw"), {
    recursive: true,
    force: true,
  });
}

async function saveRawArchive(
  request: Request,
  archivePath: string,
): Promise<{ bytesReceived: number; providedIceBoxId: string | null }> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";

  if (!rawMimeTypes.has(contentType)) {
    throw new UploadValidationError("当前上传仅支持 tar.gz 原始流或 multipart/form-data。", 415);
  }

  if (!request.body) {
    throw new UploadValidationError("请求体为空，无法读取上传文件。", 400);
  }

  const sizeLimiter = new SizeLimitTransform(maxUploadBytes);

  await pipeline(
    Readable.fromWeb(request.body as NodeReadableStream),
    sizeLimiter,
    fs.createWriteStream(archivePath),
  );

  return {
    bytesReceived: sizeLimiter.bytesReceived,
    providedIceBoxId: request.headers.get("x-ice-box-id")?.trim() ?? null,
  };
}

async function saveMultipartArchive(
  request: Request,
  archivePath: string,
  expectsEncrypted = false,
): Promise<{ bytesReceived: number; providedIceBoxId: string | null }> {
  const contentType = request.headers.get("content-type")?.trim();

  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw new UploadValidationError("当前上传仅支持 tar.gz 原始流或 multipart/form-data。", 415);
  }

  if (!request.body) {
    throw new UploadValidationError("请求体为空，无法读取上传文件。", 400);
  }

  const nodeStream = Readable.fromWeb(request.body as NodeReadableStream);

  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesReceived = 0;
    let fileFound = false;
    let fileWritePromise: Promise<void> | null = null;
    let providedIceBoxId: string | null = null;
    let fileValidationError: Error | null = null;

    const finish = (error?: Error | null, value?: { bytesReceived: number; providedIceBoxId: string | null }) => {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
        return;
      }

      resolve(value ?? { bytesReceived, providedIceBoxId });
    };

    const busboy = Busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 1,
        fields: 8,
        fileSize: maxUploadBytes,
      },
    });

    busboy.on("field", (name, value) => {
      if (name === "iceBoxId") {
        providedIceBoxId = value.trim() || null;
      }
    });

    busboy.on("file", (_fieldName, file, info) => {
      if (fileFound) {
        file.resume();
        fileValidationError = new UploadValidationError("一次只允许上传一个 tar.gz 文件。", 400);
        return;
      }

      fileFound = true;

      const fileName = info.filename?.trim() ?? "";
      const mimeType = info.mimeType?.trim().toLowerCase() ?? "";

      if (fileName) {
        const isPlainArchive = /\.(tar\.gz|tgz)$/iu.test(fileName);
        const isEncryptedArchive = /\.(tar\.gz|tgz)\.enc$/iu.test(fileName) || /\.(enc|bin)$/iu.test(fileName);

        if (!isPlainArchive && !(expectsEncrypted && isEncryptedArchive)) {
          fileValidationError = new UploadValidationError(
            expectsEncrypted ? "加密上传文件名建议使用 .tar.gz.enc / .enc / .bin。" : "上传文件名必须以 .tar.gz 或 .tgz 结尾。",
            400,
          );
          file.resume();
          return;
        }
      }

      if (mimeType && !multipartMimeTypes.has(mimeType)) {
        fileValidationError = new UploadValidationError(`不支持的文件类型：${mimeType}`, 415);
        file.resume();
        return;
      }

      file.on("data", (chunk: Buffer) => {
        bytesReceived += chunk.length;
      });

      file.on("limit", () => {
        fileValidationError = new UploadValidationError(`上传文件超过限制（最大 ${formatBytes(maxUploadBytes)}）。`, 413);
      });

      fileWritePromise = pipeline(file, fs.createWriteStream(archivePath));
    });

    busboy.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    busboy.once("finish", async () => {
      try {
        if (fileValidationError) {
          throw fileValidationError;
        }

        if (!fileFound) {
          throw new UploadValidationError("未在 multipart 请求中找到文件字段。", 400);
        }

        if (!fileWritePromise) {
          throw new UploadValidationError("上传文件写入失败。", 400);
        }

        await fileWritePromise;
        finish(null, { bytesReceived, providedIceBoxId });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    nodeStream.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    nodeStream.pipe(busboy);
  });
}

async function receiveArchive(
  request: Request,
  archivePath: string,
  expectsEncrypted = false,
): Promise<{ bytesReceived: number; providedIceBoxId: string | null }> {
  const contentType = request.headers.get("content-type")?.trim().toLowerCase() ?? "";

  if (contentType.startsWith("multipart/form-data")) {
    return saveMultipartArchive(request, archivePath, expectsEncrypted);
  }

  return saveRawArchive(request, archivePath);
}

async function prepareBranchCheckout(workingDirectory: string, branch: string, env: NodeJS.ProcessEnv) {
  const branchExists = await tryRunGitCommand(["ls-remote", "--exit-code", "--heads", "origin", branch], {
    cwd: workingDirectory,
    env,
  });

  if (branchExists) {
    await runGitCommand(["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`], {
      cwd: workingDirectory,
      env,
    });
    await runGitCommand(["checkout", "-B", branch, `origin/${branch}`], {
      cwd: workingDirectory,
      env,
    });
    return;
  }

  await runGitCommand(["checkout", "--orphan", branch], {
    cwd: workingDirectory,
    env,
  });
}

async function commitBackupToGit(record: UploadTokenRecord, sourceOpenClawDirectory: string) {
  const prepared = await prepareInitializationEnvironment(record.gitConfig);
  let tempDirectory: string | undefined;

  try {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-upload-git-"));
    const workingDirectory = path.join(tempDirectory, "repository");

    await runGitCommand(["clone", "--no-checkout", prepared.repository, workingDirectory], {
      env: prepared.env,
    });
    await runGitCommand(["config", "user.name", gitCommitAuthorName], {
      cwd: workingDirectory,
      env: prepared.env,
    });
    await runGitCommand(["config", "user.email", gitCommitAuthorEmail], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    await prepareBranchCheckout(workingDirectory, record.branch, prepared.env);
    await stageBackupContents(sourceOpenClawDirectory, workingDirectory);
    await runGitCommand(["add", "-A"], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    const noChanges = await tryRunGitCommand(["diff", "--cached", "--quiet"], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    if (noChanges) {
      return {
        pushed: false,
        commit: null as string | null,
        message: "备份内容无变化，已跳过提交。",
      };
    }

    await runGitCommand(["commit", "-m", `Backup ${record.machineId} at ${new Date().toISOString()}`], {
      cwd: workingDirectory,
      env: prepared.env,
    });
    await runGitCommand(["push", "-u", "origin", record.branch], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    const commit = (
      await runGitCommand(["rev-parse", "HEAD"], {
        cwd: workingDirectory,
        env: prepared.env,
      })
    ).stdout.trim();

    return {
      pushed: true,
      commit,
      message: "备份内容已提交并推送到远程仓库。",
    };
  } finally {
    await prepared.cleanup();

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export async function handleIceBoxArchiveUpload(
  request: Request,
  iceBoxId: string,
  uploadId: string,
): Promise<UploadBackupResult> {
  const receivedAt = new Date().toISOString();

  try {
    const record = await authenticateUploadRequest(request, iceBoxId, uploadId);

    return withBranchLock(record.branch, async () => {
      const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-upload-"));

      try {
        const uploadedPath = path.join(tempDirectory, "backup-upload.bin");
        const archivePath = path.join(tempDirectory, "backup.tar.gz");
        const received = await receiveArchive(request, uploadedPath, isEncryptionEnabled(record.encryption));

        if (received.providedIceBoxId && slugifySegment(received.providedIceBoxId) !== record.iceBoxId) {
          throw new UploadValidationError("请求体中的 iceBoxId 与上传地址不匹配。", 400);
        }

        const archiveToProcess = await decryptUploadedArchive(uploadedPath, archivePath, request, record);
        await assertGzipArchive(archiveToProcess);
        const archiveEntries = await listArchiveEntries(archiveToProcess);
        validateArchiveEntries(archiveEntries);
        const extractedOpenClawDirectory = await extractArchive(archiveToProcess, path.join(tempDirectory, "extract"));
        const gitResult = await commitBackupToGit(record, extractedOpenClawDirectory);
        const updatedAt = new Date().toISOString();

        await touchUploadTokenRecord(record.iceBoxId, record.id, {
          updatedAt,
          lastUsedAt: updatedAt,
          lastBackupAt: updatedAt,
        });

        logDevInfo("upload.receive", "backup upload handled", {
          iceBoxId: record.iceBoxId,
          machineId: record.machineId,
          branch: record.branch,
          bytesReceived: received.bytesReceived,
          commit: gitResult.commit,
          pushed: gitResult.pushed,
        });

        return {
          ok: true,
          message: gitResult.message,
          receivedAt,
          iceBoxId: record.iceBoxId,
          machineId: record.machineId,
          branch: record.branch,
          bytesReceived: received.bytesReceived,
          commit: gitResult.commit ?? undefined,
          lastBackupAt: updatedAt,
        };
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (!(error instanceof UploadValidationError)) {
      logServerError("upload.receive", error, {
        iceBoxId: slugifySegment(iceBoxId) || undefined,
        uploadId: uploadId.trim() || undefined,
      });
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "处理上传备份失败。",
      details: error instanceof UploadValidationError ? undefined : formatErrorMessage(error),
      errorCode: error instanceof UploadValidationError ? error.errorCode : "upload_backup_failed",
      statusCode: error instanceof UploadValidationError ? error.status : 500,
      receivedAt,
      iceBoxId: slugifySegment(iceBoxId) || undefined,
    };
  }
}

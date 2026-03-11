import "server-only";

import * as git from "isomorphic-git";
import fs from "node:fs";
import { cp, lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeGitConfig } from "@/lib/git-config";
import {
  formatErrorMessage,
  prepareInitializationEnvironment,
  runGitCommand,
} from "@/lib/git-config.server";
import { iceBoxBranchPrefix } from "@/lib/git";
import { logDevInfo, logServerError } from "@/lib/server-logger";
import type {
  GitRepositoryConfig,
  IceBoxBackupMode,
  IceBoxHistoryEntry,
  IceBoxHistoryResult,
  RestoreBackupResult,
  RestoreBranchPreview,
  RestorePreviewResult,
} from "@/types";

const forbiddenRestoreRoots = new Set(["/", "/System", "/Library", "/Applications", "/bin", "/sbin", "/usr"]);

class RestoreValidationError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly errorCode: string = "restore_validation_error",
  ) {
    super(message);
    this.name = "RestoreValidationError";
  }
}

function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function buildIceBoxBranch(machineId: string): string {
  return `${iceBoxBranchPrefix}/${machineId}`;
}

function ensureRequestedBranch(machineId: string, branch: string): string {
  const normalizedMachineId = slugifySegment(machineId);
  const normalizedBranch = branch.trim();

  if (!normalizedMachineId) {
    throw new RestoreValidationError("machine-id 不合法。", 400);
  }

  if (!normalizedBranch) {
    throw new RestoreValidationError("缺少可恢复的分支信息。", 400);
  }

  const expectedBranch = buildIceBoxBranch(normalizedMachineId);

  if (normalizedBranch !== expectedBranch) {
    throw new RestoreValidationError(
      `分支 \`${normalizedBranch}\` 与 machine-id \`${normalizedMachineId}\` 不匹配，期望为 \`${expectedBranch}\`。`,
      400,
    );
  }

  return normalizedBranch;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function buildBackupPath(restoredPath: string, timestamp: string): string {
  const sanitizedTimestamp = timestamp.replace(/[.:]/g, "-");

  return path.join(path.dirname(restoredPath), `.openclaw.claw-fridge-backup-${sanitizedTimestamp}`);
}

function validateTargetRootDirectory(targetRootDir: string): string {
  const trimmedTargetRootDir = targetRootDir.trim();

  if (!trimmedTargetRootDir) {
    throw new RestoreValidationError("请先填写恢复目标目录。", 400);
  }

  if (!path.isAbsolute(trimmedTargetRootDir)) {
    throw new RestoreValidationError("恢复目标目录必须是绝对路径。", 400);
  }

  const resolvedTargetRootDir = path.resolve(trimmedTargetRootDir);

  if (path.basename(resolvedTargetRootDir) === ".openclaw") {
    throw new RestoreValidationError("请填写 `.openclaw` 的父目录，而不是目录本身。", 400);
  }

  if (forbiddenRestoreRoots.has(resolvedTargetRootDir)) {
    throw new RestoreValidationError(`恢复目标目录过于危险：${resolvedTargetRootDir}`, 400);
  }

  return resolvedTargetRootDir;
}

async function inspectTargetDirectory(targetRootDir: string | undefined, previewedAt: string) {
  if (!targetRootDir) {
    return null;
  }

  const resolvedTargetRootDir = validateTargetRootDirectory(targetRootDir);
  const restoredPath = path.join(resolvedTargetRootDir, ".openclaw");
  const targetExists = await pathExists(restoredPath);

  return {
    targetRootDir: resolvedTargetRootDir,
    restoredPath,
    targetExists,
    requiresOverwriteConfirmation: targetExists,
    overwriteBackupPath: targetExists ? buildBackupPath(restoredPath, previewedAt) : null,
  };
}

function normalizeCommitHash(commit: string | undefined): string | undefined {
  const normalizedCommit = commit?.trim();

  if (!normalizedCommit) {
    return undefined;
  }

  if (!/^[0-9a-f]{7,40}$/iu.test(normalizedCommit)) {
    throw new RestoreValidationError("提交 hash 不合法。", 400);
  }

  return normalizedCommit.toLowerCase();
}

function buildHistoryEntry(branch: string, logEntry: Awaited<ReturnType<typeof git.log>>[number]): IceBoxHistoryEntry {
  const author = logEntry.commit.author?.name?.trim() ? logEntry.commit.author : logEntry.commit.committer;
  const timestamp = logEntry.commit.author?.timestamp ?? logEntry.commit.committer.timestamp;
  const message = logEntry.commit.message.trim();

  return {
    branch,
    commit: logEntry.oid,
    summary: message.split(/\r?\n/u)[0]?.trim() || "无提交说明",
    message: message || "无提交说明",
    committedAt: new Date(timestamp * 1000).toISOString(),
    authorName: author.name?.trim() || "未知提交人",
    authorEmail: author.email?.trim() || null,
  };
}

function buildRestoreBranchPreview(branch: string, entry: IceBoxHistoryEntry | null, exists: boolean): RestoreBranchPreview {
  return {
    branch,
    exists,
    lastCommit: entry?.commit ?? null,
    lastBackupAt: entry?.committedAt ?? null,
    summary: entry?.summary ?? null,
    authorName: entry?.authorName ?? null,
    authorEmail: entry?.authorEmail ?? null,
  };
}

async function readHistoryEntries(workingDirectory: string, branch: string, depth: number): Promise<IceBoxHistoryEntry[]> {
  const ref = `refs/remotes/origin/${branch}`;

  try {
    await git.resolveRef({ fs, dir: workingDirectory, ref });
    const commits = await git.log({ fs, dir: workingDirectory, ref, depth });

    return commits.map((commit) => buildHistoryEntry(branch, commit));
  } catch {
    return [];
  }
}

async function readBranchPreview(workingDirectory: string, branch: string): Promise<RestoreBranchPreview> {
  const [entry] = await readHistoryEntries(workingDirectory, branch, 1);

  return buildRestoreBranchPreview(branch, entry ?? null, Boolean(entry));
}

async function readCommitPreview(
  workingDirectory: string,
  branch: string,
  commit: string,
): Promise<RestoreBranchPreview> {
  try {
    const entries = await git.log({ fs, dir: workingDirectory, ref: commit, depth: 1 });
    const [entry] = entries;

    return buildRestoreBranchPreview(branch, entry ? buildHistoryEntry(branch, entry) : null, Boolean(entry));
  } catch {
    return buildRestoreBranchPreview(branch, null, false);
  }
}

async function withRepositoryClone<T>(
  gitConfig: GitRepositoryConfig,
  operation: (context: { workingDirectory: string; env: NodeJS.ProcessEnv }) => Promise<T>,
): Promise<T> {
  const normalizedGitConfig = normalizeGitConfig(gitConfig);

  if (!normalizedGitConfig.repository) {
    throw new RestoreValidationError("请先提供有效的 Git 仓库配置。", 400);
  }

  const prepared = await prepareInitializationEnvironment(normalizedGitConfig);
  let tempDirectory: string | undefined;

  try {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-restore-"));
    const workingDirectory = path.join(tempDirectory, "repository");

    await runGitCommand(["clone", "--no-checkout", prepared.repository, workingDirectory], {
      env: prepared.env,
    });
    await runGitCommand(["fetch", "--prune", "origin"], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    return await operation({
      workingDirectory,
      env: prepared.env,
    });
  } finally {
    await prepared.cleanup();

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

function sortBranchPreviews(branches: RestoreBranchPreview[]): RestoreBranchPreview[] {
  return [...branches].sort((left, right) => {
    const rightTimestamp = right.lastBackupAt ? new Date(right.lastBackupAt).getTime() : 0;
    const leftTimestamp = left.lastBackupAt ? new Date(left.lastBackupAt).getTime() : 0;

    return rightTimestamp - leftTimestamp;
  });
}

export async function listIceBoxBackupHistory(input: {
  machineId: string;
  branch: string;
  gitConfig: GitRepositoryConfig;
  limit?: number;
}): Promise<IceBoxHistoryResult> {
  const fetchedAt = new Date().toISOString();

  try {
    const normalizedMachineId = slugifySegment(input.machineId);
    const requestedBranch = ensureRequestedBranch(normalizedMachineId, input.branch);
    const requestedLimit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 20;
    const limit = Math.max(1, Math.min(50, Math.floor(requestedLimit)));

    return await withRepositoryClone(input.gitConfig, async ({ workingDirectory }) => {
      const entries = await readHistoryEntries(workingDirectory, requestedBranch, limit);

      logDevInfo("restore.history", "backup history loaded", {
        branch: requestedBranch,
        machineId: normalizedMachineId,
        entries: entries.length,
      });

      return {
        ok: true,
        message: entries.length
          ? `已读取分支 \`${requestedBranch}\` 的 ${entries.length} 条备份历史。`
          : `分支 \`${requestedBranch}\` 目前还没有备份历史。`,
        fetchedAt,
        branch: requestedBranch,
        machineId: normalizedMachineId,
        entries,
      } satisfies IceBoxHistoryResult;
    });
  } catch (error) {
    if (!(error instanceof RestoreValidationError)) {
      logServerError("restore.history", error, {
        branch: input.branch.trim() || undefined,
        machineId: slugifySegment(input.machineId) || undefined,
      });
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "读取备份历史失败。",
      details: error instanceof RestoreValidationError ? undefined : formatErrorMessage(error),
      errorCode: error instanceof RestoreValidationError ? error.errorCode : "restore_history_failed",
      statusCode: error instanceof RestoreValidationError ? error.status : 500,
      fetchedAt,
      branch: input.branch.trim() || undefined,
      machineId: slugifySegment(input.machineId) || undefined,
    };
  }
}

async function ensureCommitBelongsToBranch(
  workingDirectory: string,
  branch: string,
  commit: string,
  env: NodeJS.ProcessEnv,
) {
  await runGitCommand(["merge-base", "--is-ancestor", commit, `origin/${branch}`], {
    cwd: workingDirectory,
    env,
  }).catch(() => {
    throw new RestoreValidationError(`提交 \`${commit}\` 不属于分支 \`${branch}\`。`, 400);
  });
}

export async function previewIceBoxRestore(input: {
  backupMode: IceBoxBackupMode;
  machineId: string;
  branch: string;
  commit?: string;
  gitConfig: GitRepositoryConfig;
  targetRootDir?: string;
}): Promise<RestorePreviewResult> {
  const previewedAt = new Date().toISOString();

  try {
    const normalizedMachineId = slugifySegment(input.machineId);
    const requestedBranch = ensureRequestedBranch(normalizedMachineId, input.branch);
    const requestedCommit = normalizeCommitHash(input.commit);
    const targetPreview = await inspectTargetDirectory(input.targetRootDir, previewedAt);

    return await withRepositoryClone(input.gitConfig, async ({ workingDirectory, env }) => {
      const remoteBranches = await git.listBranches({
        fs,
        dir: workingDirectory,
        remote: "origin",
      });
      const availableBranchNames = remoteBranches.filter((branch) => branch.startsWith(`${iceBoxBranchPrefix}/`));
      const branchPreviews = await Promise.all(availableBranchNames.map((branch) => readBranchPreview(workingDirectory, branch)));
      const branchHeadPreview = await readBranchPreview(workingDirectory, requestedBranch);
      const availableBranches = sortBranchPreviews(branchPreviews);

      if (!branchHeadPreview.exists) {
        return {
          ok: true,
          message: availableBranches.length > 0
            ? `目标分支 \`${requestedBranch}\` 暂无备份，当前仓库还有 ${availableBranches.length} 个可恢复分支。`
            : `当前仓库里还没有找到任何 \`${iceBoxBranchPrefix}/...\` 备份分支。`,
          previewedAt,
          source: {
            backupMode: input.backupMode,
            machineId: normalizedMachineId,
            branch: requestedBranch,
            repository: normalizeGitConfig(input.gitConfig).repository,
            restoredPath: targetPreview?.restoredPath,
          },
          selectedBranch: branchHeadPreview,
          availableBranches,
          targetRootDir: targetPreview?.targetRootDir,
          restoredPath: targetPreview?.restoredPath,
          targetExists: targetPreview?.targetExists,
          requiresOverwriteConfirmation: targetPreview?.requiresOverwriteConfirmation,
          overwriteBackupPath: targetPreview?.overwriteBackupPath,
        } satisfies RestorePreviewResult;
      }

      let selectedBranch = branchHeadPreview;

      if (requestedCommit) {
        await ensureCommitBelongsToBranch(workingDirectory, requestedBranch, requestedCommit, env);
        selectedBranch = await readCommitPreview(workingDirectory, requestedBranch, requestedCommit);

        if (!selectedBranch.exists) {
          throw new RestoreValidationError(`未找到提交 \`${requestedCommit}\` 对应的可恢复快照。`, 404);
        }
      }

      logDevInfo("restore.preview", "restore preview ready", {
        branch: requestedBranch,
        machineId: normalizedMachineId,
        commit: requestedCommit,
        targetRootDir: targetPreview?.targetRootDir,
        targetExists: targetPreview?.targetExists,
      });

      return {
        ok: true,
        message: requestedCommit
          ? `已定位到分支 \`${requestedBranch}\` 上的历史快照 \`${requestedCommit.slice(0, 8)}\`。`
          : `已找到分支 \`${requestedBranch}\` 的最近备份信息。`,
        previewedAt,
        source: {
          backupMode: input.backupMode,
          machineId: normalizedMachineId,
          branch: requestedBranch,
          repository: normalizeGitConfig(input.gitConfig).repository,
          restoredPath: targetPreview?.restoredPath,
        },
        selectedBranch,
        availableBranches,
        targetRootDir: targetPreview?.targetRootDir,
        restoredPath: targetPreview?.restoredPath,
        targetExists: targetPreview?.targetExists,
        requiresOverwriteConfirmation: targetPreview?.requiresOverwriteConfirmation,
        overwriteBackupPath: targetPreview?.overwriteBackupPath,
      } satisfies RestorePreviewResult;
    });
  } catch (error) {
    if (!(error instanceof RestoreValidationError)) {
      logServerError("restore.preview", error, {
        branch: input.branch.trim() || undefined,
        machineId: slugifySegment(input.machineId) || undefined,
        commit: input.commit?.trim() || undefined,
      });
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "恢复预览失败。",
      details: error instanceof RestoreValidationError ? undefined : formatErrorMessage(error),
      errorCode: error instanceof RestoreValidationError ? error.errorCode : "restore_preview_failed",
      statusCode: error instanceof RestoreValidationError ? error.status : 500,
      previewedAt,
    };
  }
}

async function checkoutRestoreSource(
  workingDirectory: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  commit?: string,
): Promise<RestoreBranchPreview> {
  const branchPreview = await readBranchPreview(workingDirectory, branch);

  if (!branchPreview.exists) {
    throw new RestoreValidationError(`分支 \`${branch}\` 当前没有可恢复的备份。`, 404);
  }

  await runGitCommand(["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`], {
    cwd: workingDirectory,
    env,
  });

  const requestedCommit = normalizeCommitHash(commit);

  if (requestedCommit) {
    await ensureCommitBelongsToBranch(workingDirectory, branch, requestedCommit, env);
    await runGitCommand(["checkout", "--detach", requestedCommit], {
      cwd: workingDirectory,
      env,
    });

    const commitPreview = await readCommitPreview(workingDirectory, branch, requestedCommit);

    if (!commitPreview.exists) {
      throw new RestoreValidationError(`未找到提交 \`${requestedCommit}\` 对应的可恢复快照。`, 404);
    }

    const sourceOpenClawDirectory = path.join(workingDirectory, ".openclaw");
    const sourceStat = await stat(sourceOpenClawDirectory).catch(() => null);

    if (!sourceStat?.isDirectory()) {
      throw new RestoreValidationError(`提交 \`${requestedCommit}\` 中未找到可恢复的 \`.openclaw\` 目录。`, 400);
    }

    return commitPreview;
  }

  await runGitCommand(["checkout", "-B", "claw-fridge-restore", `origin/${branch}`], {
    cwd: workingDirectory,
    env,
  });

  const sourceOpenClawDirectory = path.join(workingDirectory, ".openclaw");
  const sourceStat = await stat(sourceOpenClawDirectory).catch(() => null);

  if (!sourceStat?.isDirectory()) {
    throw new RestoreValidationError(`分支 \`${branch}\` 中未找到可恢复的 \`.openclaw\` 目录。`, 400);
  }

  return branchPreview;
}

async function prepareRestoreTarget(targetRootDir: string, restoredAt: string) {
  const resolvedTargetRootDir = validateTargetRootDirectory(targetRootDir);
  const rootExists = await pathExists(resolvedTargetRootDir);

  if (rootExists) {
    const rootStat = await stat(resolvedTargetRootDir);

    if (!rootStat.isDirectory()) {
      throw new RestoreValidationError("恢复目标目录不是文件夹，无法写入 `.openclaw`。", 400);
    }
  } else {
    await mkdir(resolvedTargetRootDir, { recursive: true });
  }

  const restoredPath = path.join(resolvedTargetRootDir, ".openclaw");
  const targetExists = await pathExists(restoredPath);

  return {
    targetRootDir: resolvedTargetRootDir,
    restoredPath,
    targetExists,
    backupPath: targetExists ? buildBackupPath(restoredPath, restoredAt) : null,
  };
}

async function replaceRestoreTarget(
  sourceOpenClawDirectory: string,
  target: Awaited<ReturnType<typeof prepareRestoreTarget>>,
): Promise<string | null> {
  let previousPathBackup: string | null = null;

  try {
    if (target.targetExists && target.backupPath) {
      await rename(target.restoredPath, target.backupPath);
      previousPathBackup = target.backupPath;
    }

    await cp(sourceOpenClawDirectory, target.restoredPath, {
      recursive: true,
      force: true,
    });

    return previousPathBackup;
  } catch (error) {
    await rm(target.restoredPath, { recursive: true, force: true }).catch(() => undefined);

    if (previousPathBackup) {
      await rename(previousPathBackup, target.restoredPath).catch(() => undefined);
    }

    throw error;
  }
}

export async function restoreIceBoxBackup(input: {
  backupMode: IceBoxBackupMode;
  machineId: string;
  branch: string;
  commit?: string;
  gitConfig: GitRepositoryConfig;
  targetRootDir: string;
  confirmRestore: boolean;
  replaceExisting?: boolean;
}): Promise<RestoreBackupResult> {
  const restoredAt = new Date().toISOString();

  try {
    const normalizedMachineId = slugifySegment(input.machineId);
    const requestedBranch = ensureRequestedBranch(normalizedMachineId, input.branch);

    if (!input.confirmRestore) {
      throw new RestoreValidationError("请先确认恢复操作，再继续执行。", 400);
    }

    const target = await prepareRestoreTarget(input.targetRootDir, restoredAt);

    if (target.targetExists && !input.replaceExisting) {
      return {
        ok: false,
        message: "目标目录下已经存在 `.openclaw`，请确认覆盖后再重试。",
        errorCode: "restore_overwrite_confirmation_required",
        statusCode: 409,
        restoredAt,
        branch: requestedBranch,
        machineId: normalizedMachineId,
        repository: normalizeGitConfig(input.gitConfig).repository,
        targetRootDir: target.targetRootDir,
        restoredPath: target.restoredPath,
        previousPathBackup: target.backupPath,
        requiresOverwriteConfirmation: true,
      };
    }

    return await withRepositoryClone(input.gitConfig, async ({ workingDirectory, env }) => {
      const branchPreview = await checkoutRestoreSource(workingDirectory, requestedBranch, env, input.commit);
      const sourceOpenClawDirectory = path.join(workingDirectory, ".openclaw");
      const previousPathBackup = await replaceRestoreTarget(sourceOpenClawDirectory, target);
      const restoredCommitLabel = branchPreview.lastCommit ? `（快照 ${branchPreview.lastCommit.slice(0, 8)}）` : "";

      logDevInfo("restore.execute", "backup restored", {
        branch: requestedBranch,
        machineId: normalizedMachineId,
        commit: branchPreview.lastCommit,
        targetRootDir: target.targetRootDir,
        restoredPath: target.restoredPath,
        previousPathBackup,
      });

      return {
        ok: true,
        message: previousPathBackup
          ? `备份已恢复${restoredCommitLabel}，原有 \`.openclaw\` 已先挪到旁边的时间戳备份目录。`
          : `备份已恢复到目标目录${restoredCommitLabel}。`,
        restoredAt,
        branch: requestedBranch,
        machineId: normalizedMachineId,
        repository: normalizeGitConfig(input.gitConfig).repository,
        commit: branchPreview.lastCommit ?? undefined,
        lastBackupAt: branchPreview.lastBackupAt ?? undefined,
        targetRootDir: target.targetRootDir,
        restoredPath: target.restoredPath,
        previousPathBackup,
      } satisfies RestoreBackupResult;
    });
  } catch (error) {
    if (!(error instanceof RestoreValidationError)) {
      logServerError("restore.execute", error, {
        branch: input.branch.trim() || undefined,
        machineId: slugifySegment(input.machineId) || undefined,
        commit: input.commit?.trim() || undefined,
        targetRootDir: input.targetRootDir?.trim() || undefined,
      });
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "恢复备份失败。",
      details: error instanceof RestoreValidationError ? undefined : formatErrorMessage(error),
      errorCode: error instanceof RestoreValidationError ? error.errorCode : "restore_execute_failed",
      statusCode: error instanceof RestoreValidationError ? error.status : 500,
      restoredAt,
      branch: input.branch.trim() || undefined,
      machineId: slugifySegment(input.machineId) || undefined,
      repository: normalizeGitConfig(input.gitConfig).repository || undefined,
      commit: input.commit?.trim() || undefined,
      targetRootDir: input.targetRootDir?.trim() || undefined,
    };
  }
}

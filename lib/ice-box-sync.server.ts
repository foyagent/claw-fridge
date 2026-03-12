import "server-only";

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatErrorMessage,
  prepareInitializationEnvironment,
  runGitCommand,
  tryRunGitCommand,
} from "@/lib/git-config.server";
import { fridgeConfigBranch, iceBoxesFileName } from "@/lib/fridge-config.constants";
import { logDevInfo } from "@/lib/server-logger";
import type {
  GitRepositoryConfig,
  IceBoxListItem,
  IceBoxRecord,
  IceBoxesFile,
  OperationResultFields,
} from "@/types";

const gitCommitAuthorName = "Claw Fridge";
const gitCommitAuthorEmail = "claw-fridge@local";

interface IceBoxesSyncResult extends OperationResultFields {
  ok: boolean;
  syncedAt: string;
  items?: IceBoxRecord[];
  item?: IceBoxRecord;
  commit?: string;
}

function normalizeSyncStatus(syncStatus: IceBoxRecord["syncStatus"]): "synced" | "pending-sync" | "sync-failed" {
  if (syncStatus === "pending-sync" || syncStatus === "sync-failed" || syncStatus === "synced") {
    return syncStatus;
  }

  return "synced";
}

function listItemToRecord(item: IceBoxListItem): IceBoxRecord {
  return {
    id: item.id,
    name: item.name,
    machineId: item.machineId,
    branch: item.branch,
    backupMode: item.backupMode,
    uploadPath: item.uploadPath,
    uploadToken: item.uploadToken,
    reminder: item.reminder,
    skillConfig: item.skillConfig,
    syncStatus: normalizeSyncStatus(item.syncStatus),
    lastSyncAt: item.lastSyncAt ?? null,
    lastSyncError: item.lastSyncError ?? null,
    deletedAt: item.deletedAt ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function recordToListItem(record: IceBoxRecord): IceBoxListItem {
  return {
    ...record,
    syncStatus: normalizeSyncStatus(record.syncStatus),
    lastSyncAt: record.lastSyncAt ?? null,
    lastSyncError: record.lastSyncError ?? null,
    deletedAt: record.deletedAt ?? null,
    status: "attention",
    lastBackupAt: null,
  };
}

async function readIceBoxesFile(dir: string): Promise<IceBoxesFile | null> {
  const filePath = path.join(dir, iceBoxesFileName);

  try {
    const content = await readFile(filePath, "utf8");
    const data = JSON.parse(content) as IceBoxesFile;

    return data;
  } catch {
    return null;
  }
}

async function writeIceBoxesFile(dir: string, data: IceBoxesFile): Promise<void> {
  const filePath = path.join(dir, iceBoxesFileName);
  const content = JSON.stringify(data, null, 2) + "\n";

  await writeFile(filePath, content, "utf8");
}

async function verifyIceBoxExistsInRemote(
  gitConfig: GitRepositoryConfig,
  id: string,
): Promise<
  | { ok: true; item: IceBoxRecord; items: IceBoxRecord[] }
  | { ok: false; message: string; details?: string; items?: IceBoxRecord[] }
> {
  const fetchResult = await fetchIceBoxesFromGit(gitConfig);

  if (!fetchResult.ok) {
    return {
      ok: false,
      message: "推送完成，但远端回读校验失败。",
      details: fetchResult.details ?? fetchResult.message,
    };
  }

  const remoteItem = fetchResult.items?.find((candidate) => candidate.id === id);

  if (!remoteItem) {
    return {
      ok: false,
      message: "推送完成，但远端 fridge-config/ice-boxes.json 中未找到该冰盒记录。",
      details: `ice-box-id: ${id}`,
      items: fetchResult.items,
    };
  }

  return {
    ok: true,
    item: remoteItem,
    items: fetchResult.items ?? [],
  };
}

export async function fetchIceBoxesFromGit(
  gitConfig: GitRepositoryConfig,
): Promise<IceBoxesSyncResult> {
  const syncedAt = new Date().toISOString();
  let cleanupEnvironment: (() => Promise<void>) | undefined;
  let tempDirectory: string | undefined;

  try {
    const prepared = await prepareInitializationEnvironment(gitConfig);
    cleanupEnvironment = prepared.cleanup;
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-ice-boxes-fetch-"));
    const workingDirectory = path.join(tempDirectory, "repository");

    // Clone the repository with fridge-config branch
    await runGitCommand(
      ["clone", "--branch", fridgeConfigBranch, "--single-branch", prepared.repository, workingDirectory],
      { env: prepared.env },
    );

    // Configure git author
    await runGitCommand(["config", "user.name", gitCommitAuthorName], {
      cwd: workingDirectory,
      env: prepared.env,
    });
    await runGitCommand(["config", "user.email", gitCommitAuthorEmail], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    // Read ice-boxes.json
    const iceBoxesFile = await readIceBoxesFile(workingDirectory);

    if (!iceBoxesFile) {
      // File doesn't exist yet, return empty list
      return {
        ok: true,
        syncedAt,
        message: "冰盒列表文件尚不存在。",
        items: [],
      };
    }

    logDevInfo("ice-box-sync.fetch", "fetched ice-boxes from git", {
      branch: fridgeConfigBranch,
      itemCount: iceBoxesFile.items.length,
    });

    return {
      ok: true,
      syncedAt,
      message: "冰盒列表已从 GitHub 拉取。",
      items: iceBoxesFile.items,
    };
  } catch (error) {
    logDevInfo("ice-box-sync.fetch", "failed to fetch ice-boxes", {
      error: formatErrorMessage(error),
    });

    return {
      ok: false,
      syncedAt,
      message: "从 GitHub 拉取冰盒列表失败。",
      details: formatErrorMessage(error),
      errorCode: "ice_boxes_fetch_failed",
      statusCode: 400,
    };
  } finally {
    if (cleanupEnvironment) {
      await cleanupEnvironment();
    }

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export async function createIceBoxInGit(
  gitConfig: GitRepositoryConfig,
  item: IceBoxListItem,
): Promise<IceBoxesSyncResult> {
  const syncedAt = new Date().toISOString();
  let cleanupEnvironment: (() => Promise<void>) | undefined;
  let tempDirectory: string | undefined;

  try {
    const prepared = await prepareInitializationEnvironment(gitConfig);
    cleanupEnvironment = prepared.cleanup;
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-ice-boxes-create-"));
    const workingDirectory = path.join(tempDirectory, "repository");

    // Clone the repository
    const branchExists = await tryRunGitCommand(
      ["ls-remote", "--exit-code", "--heads", prepared.repository, fridgeConfigBranch],
      { env: prepared.env },
    );

    if (branchExists) {
      await runGitCommand(
        ["clone", "--branch", fridgeConfigBranch, "--single-branch", prepared.repository, workingDirectory],
        { env: prepared.env },
      );
    } else {
      await runGitCommand(["clone", "--no-checkout", prepared.repository, workingDirectory], {
        env: prepared.env,
      });
      await runGitCommand(["checkout", "--orphan", fridgeConfigBranch], {
        cwd: workingDirectory,
        env: prepared.env,
      });
    }

    // Configure git author
    await runGitCommand(["config", "user.name", gitCommitAuthorName], {
      cwd: workingDirectory,
      env: prepared.env,
    });
    await runGitCommand(["config", "user.email", gitCommitAuthorEmail], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    // Read existing ice-boxes.json
    let iceBoxesFile = await readIceBoxesFile(workingDirectory);
    const initializedAt = iceBoxesFile?.initializedAt ?? syncedAt;

    if (!iceBoxesFile) {
      iceBoxesFile = {
        version: 1,
        initializedAt,
        updatedAt: syncedAt,
        items: [],
      };
    }

    // Check if ice box already exists
    const existingIndex = iceBoxesFile.items.findIndex((i) => i.id === item.id);
    if (existingIndex >= 0) {
      return {
        ok: false,
        syncedAt,
        message: `冰盒 ${item.id} 已存在。`,
        errorCode: "ice_box_exists",
        statusCode: 400,
      };
    }

    // Add new ice box
    const newRecord = listItemToRecord(item);
    iceBoxesFile.items.push(newRecord);
    iceBoxesFile.updatedAt = syncedAt;

    // Write updated file
    await writeIceBoxesFile(workingDirectory, iceBoxesFile);

    // Commit and push
    await runGitCommand(["add", iceBoxesFileName], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    const hasNoChanges = await tryRunGitCommand(["diff", "--cached", "--quiet"], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    if (hasNoChanges) {
      return {
        ok: true,
        syncedAt,
        message: "冰盒列表无变化。",
        items: iceBoxesFile.items,
        item: newRecord,
      };
    }

    await runGitCommand(["commit", "-m", `Add ice box: ${item.name} (${item.id})`], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    await runGitCommand(["push", "-u", "origin", fridgeConfigBranch], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    const commit = (
      await runGitCommand(["rev-parse", "HEAD"], {
        cwd: workingDirectory,
        env: prepared.env,
      })
    ).stdout.trim();

    logDevInfo("ice-box-sync.create", "created ice box in git", {
      branch: fridgeConfigBranch,
      iceBoxId: item.id,
      commit,
    });

    const verification = await verifyIceBoxExistsInRemote(gitConfig, item.id);

    if (!verification.ok) {
      return {
        ok: false,
        syncedAt,
        message: "冰盒已推送到远端，但回读校验未通过。",
        details: [verification.message, verification.details, commit ? `commit: ${commit}` : null]
          .filter(Boolean)
          .join("\n"),
        errorCode: "ice_box_remote_verification_failed",
        statusCode: 502,
        commit,
        items: verification.items,
      };
    }

    return {
      ok: true,
      syncedAt,
      message: `冰盒 ${item.name} 已同步到远端，并通过回读校验。`,
      items: verification.items,
      item: verification.item,
      commit,
    };
  } catch (error) {
    logDevInfo("ice-box-sync.create", "failed to create ice box", {
      error: formatErrorMessage(error),
      iceBoxId: item.id,
    });

    return {
      ok: false,
      syncedAt,
      message: "同步冰盒到 GitHub 失败。",
      details: formatErrorMessage(error),
      errorCode: "ice_box_create_failed",
      statusCode: 400,
    };
  } finally {
    if (cleanupEnvironment) {
      await cleanupEnvironment();
    }

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export async function updateIceBoxInGit(
  gitConfig: GitRepositoryConfig,
  id: string,
  updates: Partial<IceBoxListItem>,
): Promise<IceBoxesSyncResult> {
  const syncedAt = new Date().toISOString();
  let cleanupEnvironment: (() => Promise<void>) | undefined;
  let tempDirectory: string | undefined;

  try {
    const prepared = await prepareInitializationEnvironment(gitConfig);
    cleanupEnvironment = prepared.cleanup;
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-ice-boxes-update-"));
    const workingDirectory = path.join(tempDirectory, "repository");

    // Clone the repository
    await runGitCommand(
      ["clone", "--branch", fridgeConfigBranch, "--single-branch", prepared.repository, workingDirectory],
      { env: prepared.env },
    );

    // Configure git author
    await runGitCommand(["config", "user.name", gitCommitAuthorName], {
      cwd: workingDirectory,
      env: prepared.env,
    });
    await runGitCommand(["config", "user.email", gitCommitAuthorEmail], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    // Read ice-boxes.json
    const iceBoxesFile = await readIceBoxesFile(workingDirectory);

    if (!iceBoxesFile) {
      return {
        ok: false,
        syncedAt,
        message: "冰盒列表文件不存在。",
        errorCode: "ice_boxes_not_found",
        statusCode: 404,
      };
    }

    // Find and update the ice box
    const index = iceBoxesFile.items.findIndex((i) => i.id === id);
    if (index < 0) {
      return {
        ok: false,
        syncedAt,
        message: `冰盒 ${id} 不存在。`,
        errorCode: "ice_box_not_found",
        statusCode: 404,
      };
    }

    // Apply updates
    iceBoxesFile.items[index] = {
      ...iceBoxesFile.items[index],
      ...updates,
      id, // Ensure id doesn't change
      updatedAt: syncedAt,
    };
    iceBoxesFile.updatedAt = syncedAt;

    // Write updated file
    await writeIceBoxesFile(workingDirectory, iceBoxesFile);

    // Commit and push
    await runGitCommand(["add", iceBoxesFileName], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    const hasNoChanges = await tryRunGitCommand(["diff", "--cached", "--quiet"], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    if (hasNoChanges) {
      return {
        ok: true,
        syncedAt,
        message: "冰盒信息无变化。",
        items: iceBoxesFile.items,
        item: iceBoxesFile.items[index],
      };
    }

    await runGitCommand(["commit", "-m", `Update ice box: ${id}`], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    await runGitCommand(["push", "origin", fridgeConfigBranch], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    const commit = (
      await runGitCommand(["rev-parse", "HEAD"], {
        cwd: workingDirectory,
        env: prepared.env,
      })
    ).stdout.trim();

    logDevInfo("ice-box-sync.update", "updated ice box in git", {
      branch: fridgeConfigBranch,
      iceBoxId: id,
      commit,
    });

    const verification = await verifyIceBoxExistsInRemote(gitConfig, id);

    if (!verification.ok) {
      return {
        ok: false,
        syncedAt,
        message: `冰盒 ${id} 已推送到远端，但回读校验未通过。`,
        details: [verification.message, verification.details, commit ? `commit: ${commit}` : null]
          .filter(Boolean)
          .join("\n"),
        errorCode: "ice_box_remote_verification_failed",
        statusCode: 502,
        commit,
        items: verification.items,
      };
    }

    return {
      ok: true,
      syncedAt,
      message: `冰盒 ${id} 已更新到远端，并通过回读校验。`,
      items: verification.items,
      item: verification.item,
      commit,
    };
  } catch (error) {
    logDevInfo("ice-box-sync.update", "failed to update ice box", {
      error: formatErrorMessage(error),
      iceBoxId: id,
    });

    return {
      ok: false,
      syncedAt,
      message: "更新冰盒到 GitHub 失败。",
      details: formatErrorMessage(error),
      errorCode: "ice_box_update_failed",
      statusCode: 400,
    };
  } finally {
    if (cleanupEnvironment) {
      await cleanupEnvironment();
    }

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export async function deleteIceBoxFromGit(
  gitConfig: GitRepositoryConfig,
  id: string,
): Promise<IceBoxesSyncResult> {
  const syncedAt = new Date().toISOString();
  let cleanupEnvironment: (() => Promise<void>) | undefined;
  let tempDirectory: string | undefined;

  try {
    const prepared = await prepareInitializationEnvironment(gitConfig);
    cleanupEnvironment = prepared.cleanup;
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-ice-boxes-delete-"));
    const workingDirectory = path.join(tempDirectory, "repository");

    // Clone the repository
    await runGitCommand(
      ["clone", "--branch", fridgeConfigBranch, "--single-branch", prepared.repository, workingDirectory],
      { env: prepared.env },
    );

    // Configure git author
    await runGitCommand(["config", "user.name", gitCommitAuthorName], {
      cwd: workingDirectory,
      env: prepared.env,
    });
    await runGitCommand(["config", "user.email", gitCommitAuthorEmail], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    // Read ice-boxes.json
    const iceBoxesFile = await readIceBoxesFile(workingDirectory);

    if (!iceBoxesFile) {
      return {
        ok: false,
        syncedAt,
        message: "冰盒列表文件不存在。",
        errorCode: "ice_boxes_not_found",
        statusCode: 404,
      };
    }

    // Find the ice box
    const index = iceBoxesFile.items.findIndex((i) => i.id === id);
    if (index < 0) {
      return {
        ok: false,
        syncedAt,
        message: `冰盒 ${id} 不存在。`,
        errorCode: "ice_box_not_found",
        statusCode: 404,
      };
    }

    const deletedItem = iceBoxesFile.items[index];

    // Mark as deleted instead of removing from list
    iceBoxesFile.items[index] = {
      ...deletedItem,
      deletedAt: syncedAt,
      updatedAt: syncedAt,
    };
    iceBoxesFile.updatedAt = syncedAt;

    // Write updated file
    await writeIceBoxesFile(workingDirectory, iceBoxesFile);

    // Commit and push
    await runGitCommand(["add", iceBoxesFileName], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    await runGitCommand(["commit", "-m", `Mark ice box as deleted: ${deletedItem.name} (${id})`], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    await runGitCommand(["push", "origin", fridgeConfigBranch], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    const commit = (
      await runGitCommand(["rev-parse", "HEAD"], {
        cwd: workingDirectory,
        env: prepared.env,
      })
    ).stdout.trim();

    logDevInfo("ice-box-sync.delete", "marked ice box as deleted in git", {
      branch: fridgeConfigBranch,
      iceBoxId: id,
      commit,
    });

    return {
      ok: true,
      syncedAt,
      message: `冰盒 ${deletedItem.name} 已标记为删除，分支保留。`,
      items: iceBoxesFile.items,
      commit,
    };
  } catch (error) {
    logDevInfo("ice-box-sync.delete", "failed to mark ice box as deleted", {
      error: formatErrorMessage(error),
      iceBoxId: id,
    });

    return {
      ok: false,
      syncedAt,
      message: "标记冰盒为删除失败。",
      details: formatErrorMessage(error),
      errorCode: "ice_box_delete_failed",
      statusCode: 400,
    };
  } finally {
    if (cleanupEnvironment) {
      await cleanupEnvironment();
    }

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export { recordToListItem, listItemToRecord };

import * as git from "isomorphic-git";
import fs from "node:fs";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fridgeConfigBranch,
  fridgeConfigFileName,
  fridgeConfigSchemaVersion,
  iceBoxesFileName,
} from "@/lib/fridge-config.constants";
import { iceBoxBranchPrefix } from "@/lib/git";
import type {
  CreateFridgeConfigFilesOptions,
  FridgeConfigFile,
  FridgeConfigSeedFile,
  IceBoxesFile,
  SeedFridgeConfigFilesOptions,
  SeedFridgeConfigFilesResult,
} from "@/types";

export {
  fridgeConfigBranch,
  fridgeConfigFileName,
  fridgeConfigSchemaVersion,
  iceBoxesFileName,
} from "@/lib/fridge-config.constants";

function normalizeInitializedAt(initializedAt?: string): string {
  return initializedAt ?? new Date().toISOString();
}

function ensureTrailingLineBreak(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function serializeJsonFile(value: FridgeConfigFile | IceBoxesFile): string {
  return ensureTrailingLineBreak(JSON.stringify(value, null, 2));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRepositoryRoot(dir: string): Promise<string> {
  try {
    return await git.findRoot({ fs, filepath: path.resolve(dir) });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `未找到可写入初始化配置的 Git 仓库：${error.message}`
        : "未找到可写入初始化配置的 Git 仓库。",
    );
  }
}

function buildConfigFile(initializedAt: string): FridgeConfigFile {
  return {
    version: fridgeConfigSchemaVersion,
    initializedAt,
    updatedAt: initializedAt,
    fridgeConfigBranch,
    iceBoxBranchPrefix,
    iceBoxesFile: iceBoxesFileName,
  };
}

function buildIceBoxesFile(initializedAt: string): IceBoxesFile {
  return {
    version: fridgeConfigSchemaVersion,
    initializedAt,
    updatedAt: initializedAt,
    items: [],
  };
}

export function createInitialFridgeConfigFiles(
  options: CreateFridgeConfigFilesOptions = {},
): FridgeConfigSeedFile[] {
  const initializedAt = normalizeInitializedAt(options.initializedAt);

  return [
    {
      path: fridgeConfigFileName,
      content: serializeJsonFile(buildConfigFile(initializedAt)),
    },
    {
      path: iceBoxesFileName,
      content: serializeJsonFile(buildIceBoxesFile(initializedAt)),
    },
  ];
}

export async function seedFridgeConfigFiles(
  options: SeedFridgeConfigFilesOptions,
): Promise<SeedFridgeConfigFilesResult> {
  const root = await resolveRepositoryRoot(options.dir);
  const initializedAt = normalizeInitializedAt(options.initializedAt);
  const files = createInitialFridgeConfigFiles({ initializedAt });
  const results: SeedFridgeConfigFilesResult["files"] = [];

  for (const file of files) {
    const filePath = path.join(root, file.path);
    const exists = await fileExists(filePath);

    if (exists && options.skipExisting) {
      results.push({
        path: file.path,
        status: "unchanged",
      });
      continue;
    }

    if (exists && !options.overwrite) {
      throw new Error(`初始化文件已存在：${file.path}`);
    }

    try {
      await writeFile(filePath, file.content, "utf8");
      await git.add({ fs, dir: root, filepath: file.path });
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `写入初始化文件失败（${file.path}）：${error.message}`
          : `写入初始化文件失败（${file.path}）。`,
      );
    }

    results.push({
      path: file.path,
      status: exists ? "overwritten" : "created",
    });
  }

  return {
    root,
    initializedAt,
    files: results,
  };
}

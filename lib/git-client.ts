import LightningFS from "@isomorphic-git/lightning-fs";
import * as git from "isomorphic-git";
import { fridgeConfigBranch, fridgeConfigFileName, fridgeConfigSchemaVersion, iceBoxesFileName } from "@/lib/fridge-config.constants";
import { buildGitConfigErrorResult, getDefaultGitUsername, getGitPlatformAuthHelp, isHttpsRepository, isSshRepository, normalizeGitConfig } from "@/lib/git-config";
import { iceBoxBranchPrefix } from "@/lib/git";
import type {
  GitConfigInitResult,
  GitConfigTestResult,
  GitRepositoryConfig,
  IceBoxBranchSyncResult,
  IceBoxesFile,
  IceBoxListItem,
  IceBoxRecord,
  IceBoxSyncResult,
  IceBoxHistoryEntry,
} from "@/types";

const gitCommitAuthorName = "Claw Fridge";
const gitCommitAuthorEmail = "claw-fridge@local";
const authStorageKey = "claw-fridge-git-auth:v1";
const fsName = "claw-fridge-git";
const repoRoot = "/repos";

type BrowserFs = InstanceType<typeof LightningFS>;
type BrowserFsPromises = BrowserFs["promises"];

interface StoredGitAuthRecord {
  repository: string;
  username: string;
  token: string;
  updatedAt: string;
}

function isBrowser() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function encodeRepositoryKey(repository: string) {
  return repository.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "default";
}

function getFs() {
  return new LightningFS(fsName, { wipe: false });
}

function serializeJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error || "未知错误");
}

/**
 * 创建代理 HTTP adapter
 * 所有 git 请求通过 /api/git/proxy 转发，解决 CORS 问题
 */
function createHttpAdapter(onAuth?: git.AuthCallback): {
  request: (req: git.GitHttpRequest) => Promise<git.GitHttpResponse>;
} {
  return {
    request: async (req: git.GitHttpRequest): Promise<git.GitHttpResponse> => {
      let authHeaders = req.headers;

      if (onAuth) {
        const auth = await onAuth(req.url, {
          username: undefined,
          password: undefined,
        });

        if (auth && typeof auth !== "boolean") {
          const username = auth.username ?? "";
          const password = auth.password ?? "";
          const basic = Buffer.from(`${username}:${password}`).toString("base64");
          authHeaders = {
            ...req.headers,
            Authorization: `Basic ${basic}`,
          };
        }
      }

      // 读取 body
      let bodyContent: string | undefined;
      if (req.body) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req.body) {
          chunks.push(chunk);
        }
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        bodyContent = Buffer.from(combined).toString("base64");
      }

      const response = await fetch("/api/git/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: req.url,
          method: req.method || "GET",
          headers: authHeaders,
          body: bodyContent,
        }),
      });

      if (!response.ok) {
        throw new Error(`Proxy request failed: ${response.status} ${response.statusText}`);
      }

      // 转换响应 body 为 AsyncIterableIterator
      async function* bodyIterator(): AsyncIterableIterator<Uint8Array> {
        const reader = response.body?.getReader();
        if (!reader) return;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      }

      return {
        url: req.url,
        method: req.method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(
          Array.from(response.headers.entries()).filter(([, v]) => typeof v === "string")
        ),
        body: bodyIterator(),
      };
    },
  };
}

export class FrontendGitFallbackError extends Error {
  details?: string;

  constructor(message: string, options?: { details?: string; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "FrontendGitFallbackError";
    this.details = options?.details;
  }
}

export class IceBoxHistoryBranchMissingError extends Error {
  branch: string;

  constructor(branch: string) {
    super(`冰盒分支 ${branch} 不存在。`);
    this.name = "IceBoxHistoryBranchMissingError";
    this.branch = branch;
  }
}

export function shouldFallbackToServer(error: unknown) {
  return error instanceof FrontendGitFallbackError;
}

export function isIceBoxHistoryBranchMissingError(error: unknown): error is IceBoxHistoryBranchMissingError {
  return error instanceof IceBoxHistoryBranchMissingError;
}

function buildFrontendFallbackError(repository: string, error: unknown) {
  const classified = classifyGitError(repository, error);
  return new FrontendGitFallbackError(classified.message, {
    details: classified.details,
    cause: error,
  });
}

function classifyGitError(repository: string, error: unknown) {
  const message = formatErrorMessage(error);
  const lower = message.toLowerCase();

  if (isSshRepository(repository)) {
    return {
      message: "浏览器模式暂不支持 SSH 仓库，请改用 HTTPS + Token。",
      details: [message, ...getGitPlatformAuthHelp(repository, "ssh-key")].join("\n"),
    };
  }

  if (lower.includes("cors") || lower.includes("failed to fetch") || lower.includes("network request failed")) {
    return {
      message: "浏览器无法直接访问这个 Git 远程地址，可能被 CORS 或网络策略拦住了。",
      details: [
        message,
        "如果这是 GitHub，通常可直接访问；若是自托管 Git/GitLab/Gitea，请检查是否允许跨域。",
        "若服务端没开 CORS，需要加一个 CORS proxy，或继续保留后端 API 作为兜底。",
      ].join("\n"),
    };
  }

  if (lower.includes("401") || lower.includes("403") || lower.includes("authentication") || lower.includes("auth")) {
    return {
      message: "Git 仓库认证失败，请检查用户名和 Token。",
      details: [message, ...getGitPlatformAuthHelp(repository, "https-token")].join("\n"),
    };
  }

  return {
    message,
    details: message,
  };
}

function getStoredRecords(): StoredGitAuthRecord[] {
  if (!isBrowser()) {
    return [];
  }

  try {
    return JSON.parse(localStorage.getItem(authStorageKey) || "[]") as StoredGitAuthRecord[];
  } catch {
    return [];
  }
}

function setStoredRecords(records: StoredGitAuthRecord[]) {
  if (!isBrowser()) {
    return;
  }

  localStorage.setItem(authStorageKey, JSON.stringify(records));
}

export function loadStoredGitCredentials(repository: string): StoredGitAuthRecord | null {
  const normalizedRepository = repository.trim();
  return getStoredRecords().find((item) => item.repository === normalizedRepository) ?? null;
}

export function persistGitCredentials(config: GitRepositoryConfig) {
  if (!isBrowser() || config.auth.method !== "https-token") {
    return;
  }

  const repository = config.repository.trim();
  if (!repository) {
    return;
  }

  const nextRecords = getStoredRecords().filter((item) => item.repository !== repository);
  nextRecords.push({
    repository,
    username: config.auth.username.trim() || getDefaultGitUsername(repository, "https-token"),
    token: config.auth.token.trim(),
    updatedAt: new Date().toISOString(),
  });
  setStoredRecords(nextRecords);
}

export function clearStoredGitCredentials(repository: string) {
  if (!isBrowser()) {
    return;
  }

  setStoredRecords(getStoredRecords().filter((item) => item.repository !== repository.trim()));
}

function withStoredCredentials(input: GitRepositoryConfig): GitRepositoryConfig {
  const config = normalizeGitConfig(input);

  if (config.auth.method !== "https-token") {
    return config;
  }

  if (config.auth.token.trim()) {
    return config;
  }

  const stored = loadStoredGitCredentials(config.repository);
  if (!stored?.token) {
    return config;
  }

  return {
    ...config,
    auth: {
      method: "https-token",
      username: config.auth.username.trim() || stored.username,
      token: stored.token,
    },
  };
}

async function ensureDir(fsPromises: BrowserFsPromises, dir: string) {
  await fsPromises.mkdir(dir).catch(() => undefined);
}

async function removeEntry(fsPromises: BrowserFsPromises, targetPath: string): Promise<void> {
  try {
    const stat = await fsPromises.stat(targetPath);

    if (stat.type === "dir") {
      const entries = await fsPromises.readdir(targetPath);
      await Promise.all(entries.map((entry) => removeEntry(fsPromises, `${targetPath}/${entry}`)));
      await fsPromises.rmdir(targetPath).catch(() => undefined);
      return;
    }

    await fsPromises.unlink(targetPath).catch(() => undefined);
  } catch {
    // ignore missing entries
  }
}

async function pathExists(fsPromises: BrowserFsPromises, targetPath: string) {
  try {
    await fsPromises.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function prepareRepoDir(repository: string, options?: { wipe?: boolean; key?: string }) {
  const fs = getFs();
  const fsPromises = fs.promises;
  await ensureDir(fsPromises, repoRoot);
  const dir = `${repoRoot}/${encodeRepositoryKey(options?.key ?? repository)}`;

  if (options?.wipe ?? true) {
    await removeEntry(fsPromises, dir);
  }

  await ensureDir(fsPromises, dir);
  return { fs, dir };
}

function requireRemoteHttps(config: GitRepositoryConfig): GitConfigTestResult | null {
  if (!config.repository) {
    return buildGitConfigErrorResult("请先填写 Git 仓库地址。");
  }

  if (config.kind === "local") {
    return buildGitConfigErrorResult("浏览器模式不支持本地路径仓库，请改用远程 HTTPS 仓库。", config.repository);
  }

  if (isSshRepository(config.repository)) {
    return buildGitConfigErrorResult(
      "浏览器模式不支持 SSH 仓库，请改用 HTTPS + Token。",
      getGitPlatformAuthHelp(config.repository, "ssh-key").join("\n"),
    );
  }

  if (!isHttpsRepository(config.repository)) {
    return buildGitConfigErrorResult("当前只支持 HTTPS 远程仓库。", config.repository);
  }

  if (config.auth.method === "https-token" && !config.auth.token.trim()) {
    return buildGitConfigErrorResult(
      "请填写 HTTPS Token。",
      getGitPlatformAuthHelp(config.repository, "https-token").join("\n"),
    );
  }

  return null;
}

function getAuthCallback(config: GitRepositoryConfig) {
  if (config.auth.method !== "https-token") {
    return undefined;
  }

  const auth = config.auth;

  return () => ({
    username: auth.username.trim() || getDefaultGitUsername(config.repository, "https-token"),
    password: auth.token.trim(),
  });
}

function buildInitialFiles(initializedAt: string) {
  return [
    {
      path: fridgeConfigFileName,
      content: serializeJson({
        version: fridgeConfigSchemaVersion,
        initializedAt,
        updatedAt: initializedAt,
        fridgeConfigBranch,
        iceBoxBranchPrefix,
        iceBoxesFile: iceBoxesFileName,
      }),
    },
    {
      path: iceBoxesFileName,
      content: serializeJson({
        version: fridgeConfigSchemaVersion,
        initializedAt,
        updatedAt: initializedAt,
        items: [],
      }),
    },
  ];
}

async function writeTextFile(fsPromises: BrowserFsPromises, filePath: string, content: string) {
  const segments = filePath.split("/").filter(Boolean);
  let current = "";

  for (let index = 0; index < segments.length - 1; index += 1) {
    current += `/${segments[index]}`;
    await ensureDir(fsPromises, current);
  }

  await fsPromises.writeFile(filePath, content, "utf8");
}

async function stageSeedFiles(
  fs: BrowserFs,
  dir: string,
  initializedAt: string,
  options?: { overwriteExisting?: boolean },
) {
  const files = buildInitialFiles(initializedAt);
  const results: NonNullable<GitConfigInitResult["files"]> = [];
  const overwriteExisting = options?.overwriteExisting ?? false;

  for (const file of files) {
    const fullPath = `${dir}/${file.path}`;
    let exists = true;

    try {
      await fs.promises.stat(fullPath);
    } catch {
      exists = false;
    }

    if (exists && !overwriteExisting) {
      results.push({ path: file.path, status: "unchanged" });
      continue;
    }

    await writeTextFile(fs.promises, fullPath, file.content);
    await git.add({ fs, dir, filepath: file.path });
    results.push({ path: file.path, status: exists ? "overwritten" : "created" });
  }

  return results;
}

async function clearTrackedFiles(fs: BrowserFs, dir: string) {
  const trackedFiles = await git.listFiles({ fs, dir });

  for (const filepath of trackedFiles) {
    await fs.promises.unlink(`${dir}/${filepath}`).catch(() => undefined);
    await git.remove({ fs, dir, filepath }).catch(() => undefined);
  }
}

function normalizeIceBoxSyncStatus(syncStatus: IceBoxRecord["syncStatus"]): "synced" | "pending-sync" | "sync-failed" {
  if (syncStatus === "pending-sync" || syncStatus === "sync-failed" || syncStatus === "synced") {
    return syncStatus;
  }

  return "synced";
}

function buildEmptyIceBoxesFile(now: string): IceBoxesFile {
  return {
    version: fridgeConfigSchemaVersion,
    initializedAt: now,
    updatedAt: now,
    items: [],
  };
}

async function readJsonFile<T>(fsPromises: BrowserFsPromises, filePath: string): Promise<T | null> {
  try {
    const content = await fsPromises.readFile(filePath, "utf8");
    return JSON.parse(content as string) as T;
  } catch {
    return null;
  }
}

async function loadFridgeConfigRepo(config: GitRepositoryConfig, allowMissingBranch = false) {
  const { fs, dir } = await prepareRepoDir(config.repository);
  const onAuth = getAuthCallback(config);
  const http = createHttpAdapter(onAuth);
  const branchExists = await git
    .listServerRefs({
      http,
      url: config.repository,
      onAuth,
      protocolVersion: 2,
      prefix: `refs/heads/${fridgeConfigBranch}`,
    })
    .then((refs) => refs.some((ref) => ref.ref === `refs/heads/${fridgeConfigBranch}`));

  if (!branchExists) {
    if (allowMissingBranch) {
      await git.init({ fs, dir, defaultBranch: fridgeConfigBranch });
      await git.addRemote({ fs, dir, remote: "origin", url: config.repository });
      await git.checkout({ fs, dir, ref: fridgeConfigBranch });
      return { fs, dir, onAuth, branchExists: false };
    }

    throw new Error(`远程分支 ${fridgeConfigBranch} 不存在，请先初始化仓库配置。`);
  }

  await git.clone({
    fs,
    http,
    dir,
    url: config.repository,
    ref: fridgeConfigBranch,
    singleBranch: true,
    depth: 1,
    onAuth,
  });

  await git.checkout({ fs, dir, ref: fridgeConfigBranch, force: true });

  return { fs, dir, onAuth, branchExists: true };
}

async function readIceBoxesFileFromRepo(fsPromises: BrowserFsPromises, dir: string): Promise<IceBoxesFile> {
  const file = await readJsonFile<IceBoxesFile>(fsPromises, `${dir}/${iceBoxesFileName}`);
  return file ?? buildEmptyIceBoxesFile(new Date().toISOString());
}

async function commitAndPushIceBoxesFile(
  fs: BrowserFs,
  dir: string,
  onAuth: ReturnType<typeof getAuthCallback>,
  branchExists: boolean,
  message: string,
) {
  const http = createHttpAdapter(onAuth);
  await git.add({ fs, dir, filepath: iceBoxesFileName });
  const statusMatrix = await git.statusMatrix({ fs, dir, filepaths: [iceBoxesFileName] });
  const hasNoChanges = statusMatrix.every(([, headStatus, workdirStatus, stageStatus]) => {
    const normalizedWorktree = workdirStatus === 0 ? headStatus : workdirStatus;
    return headStatus === normalizedWorktree && headStatus === stageStatus;
  });

  if (hasNoChanges) {
    return { commit: undefined, pushed: false };
  }

  const commit = await git.commit({
    fs,
    dir,
    author: { name: gitCommitAuthorName, email: gitCommitAuthorEmail },
    committer: { name: gitCommitAuthorName, email: gitCommitAuthorEmail },
    message,
  });

  await git.push({
    fs,
    http,
    dir,
    remote: "origin",
    ref: fridgeConfigBranch,
    onAuth,
    force: !branchExists,
  });

  return { commit, pushed: true };
}

async function resolveDefaultBranch(config: GitRepositoryConfig) {
  const onAuth = getAuthCallback(config);
  const refs = await git.listServerRefs({
    http: createHttpAdapter(onAuth),
    url: config.repository,
    onAuth,
    protocolVersion: 2,
    symrefs: true,
    prefix: "HEAD",
  });

  return refs.find((ref) => ref.ref === "HEAD")?.target?.replace("refs/heads/", "");
}

export async function testGitConnection(input: GitRepositoryConfig): Promise<GitConfigTestResult> {
  const config = withStoredCredentials(input);
  const unsupported = requireRemoteHttps(config);
  if (unsupported) {
    return unsupported;
  }

  try {
    const onAuth = getAuthCallback(config);
    const http = createHttpAdapter(onAuth);
    const refs = await git.listServerRefs({
      http,
      url: config.repository,
      onAuth,
      protocolVersion: 2,
      symrefs: true,
      prefix: "HEAD",
    });
    const defaultBranch = refs.find((ref) => ref.ref === "HEAD")?.target?.replace("refs/heads/", "");
    const branchRefs = await git.listServerRefs({
      http,
      url: config.repository,
      onAuth,
      protocolVersion: 2,
      prefix: `refs/heads/${fridgeConfigBranch}`,
    }).catch(() => []);

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      target: "remote-https",
      message: "浏览器已成功连上远程仓库。",
      details: `地址：${config.repository}`,
      defaultBranch,
      hasFridgeConfig: branchRefs.some((ref) => ref.ref === `refs/heads/${fridgeConfigBranch}`),
    };
  } catch (error) {
    const classified = classifyGitError(config.repository, error);
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      message: classified.message,
      details: classified.details,
    };
  }
}

export async function initFridgeConfig(input: GitRepositoryConfig): Promise<GitConfigInitResult> {
  const config = withStoredCredentials(input);
  const unsupported = requireRemoteHttps(config);
  if (unsupported) {
    return {
      ok: false,
      initializedAt: new Date().toISOString(),
      message: unsupported.message,
      details: unsupported.details,
      branch: fridgeConfigBranch,
    };
  }

  const initializedAt = new Date().toISOString();

  try {
    const { fs, dir } = await prepareRepoDir(config.repository);
    const onAuth = getAuthCallback(config);
    const http = createHttpAdapter(onAuth);
    const branchExists = await git
      .listServerRefs({
        http,
        url: config.repository,
        onAuth,
        protocolVersion: 2,
        prefix: `refs/heads/${fridgeConfigBranch}`,
      })
      .then((refs) => refs.some((ref) => ref.ref === `refs/heads/${fridgeConfigBranch}`));

    const defaultBranch = await resolveDefaultBranch(config);

    await git.clone({
      fs,
      http,
      dir,
      url: config.repository,
      ref: branchExists ? fridgeConfigBranch : defaultBranch,
      singleBranch: true,
      depth: 1,
      onAuth,
    });

    if (branchExists) {
      await git.checkout({ fs, dir, ref: fridgeConfigBranch, force: true });
    } else {
      await git.branch({ fs, dir, ref: fridgeConfigBranch, checkout: true });
      await clearTrackedFiles(fs, dir);
    }

    const files = await stageSeedFiles(fs, dir, initializedAt, {
      overwriteExisting: !branchExists,
    });
    const statusMatrix = await git.statusMatrix({ fs, dir });
    const hasNoChanges = statusMatrix.every(([, headStatus, workdirStatus, stageStatus]) => {
      const normalizedWorktree = workdirStatus === 0 ? headStatus : workdirStatus;
      return headStatus === normalizedWorktree && headStatus === stageStatus;
    });

    if (hasNoChanges) {
      return {
        ok: true,
        initializedAt,
        message: "`fridge-config` 分支已存在，已保留现有配置。",
        details: files.map((file) => `${file.path}：已保留`).join("\n"),
        branch: fridgeConfigBranch,
        root: config.repository,
        files: files.map((file) => ({ ...file, status: "unchanged" })),
        alreadyInitialized: true,
      };
    }

    const commit = await git.commit({
      fs,
      dir,
      author: { name: gitCommitAuthorName, email: gitCommitAuthorEmail },
      committer: { name: gitCommitAuthorName, email: gitCommitAuthorEmail },
      message: branchExists ? "Refresh fridge-config branch" : "Initialize fridge-config branch",
    });

    await git.push({
      fs,
      http,
      dir,
      remote: "origin",
      ref: fridgeConfigBranch,
      onAuth,
      force: !branchExists,
    });

    return {
      ok: true,
      initializedAt,
      message: branchExists ? "已载入 fridge-config 分支，并保留已有配置。" : "已在浏览器里初始化 fridge-config 分支并推送到远程仓库。",
      details: files
        .map((file) => `${file.path}：${file.status === "created" ? "已创建" : file.status === "overwritten" ? "已覆盖" : "已保留"}`)
        .join("\n"),
      branch: fridgeConfigBranch,
      root: config.repository,
      commit,
      files,
    };
  } catch (error) {
    const classified = classifyGitError(config.repository, error);
    return {
      ok: false,
      initializedAt,
      message: classified.message,
      details: classified.details,
      branch: fridgeConfigBranch,
    };
  }
}

export async function listIceBoxes(input: GitRepositoryConfig): Promise<IceBoxListItem[]> {
  const config = withStoredCredentials(input);
  const unsupported = requireRemoteHttps(config);
  if (unsupported) {
    throw new Error(unsupported.details || unsupported.message);
  }

  const { fs, dir } = await loadFridgeConfigRepo(config, true);
  const iceBoxesFile = await readIceBoxesFileFromRepo(fs.promises, dir);

  return iceBoxesFile.items
    .filter((item) => !item.deletedAt)
    .map((record) => ({
      ...record,
      syncStatus: normalizeIceBoxSyncStatus(record.syncStatus),
      lastSyncAt: record.lastSyncAt ?? null,
      lastSyncError: record.lastSyncError ?? null,
      deletedAt: record.deletedAt ?? null,
      status: "attention",
      lastBackupAt: null,
    }));
}

export async function addIceBox(input: GitRepositoryConfig, item: IceBoxRecord): Promise<IceBoxSyncResult> {
  const config = withStoredCredentials(input);
  const unsupported = requireRemoteHttps(config);
  const syncedAt = new Date().toISOString();
  if (unsupported) {
    return { ok: false, syncedAt, message: unsupported.message, details: unsupported.details };
  }

  try {
    const { fs, dir, onAuth, branchExists } = await loadFridgeConfigRepo(config, true);
    const iceBoxesFile = await readIceBoxesFileFromRepo(fs.promises, dir);

    if (iceBoxesFile.items.some((existingItem) => existingItem.id === item.id)) {
      return {
        ok: false,
        syncedAt,
        message: `冰盒 ${item.id} 已存在。`,
        items: iceBoxesFile.items,
      };
    }

    iceBoxesFile.items.push({ ...item, updatedAt: syncedAt });
    iceBoxesFile.updatedAt = syncedAt;
    await writeTextFile(fs.promises, `${dir}/${iceBoxesFileName}`, serializeJson(iceBoxesFile));
    const { commit } = await commitAndPushIceBoxesFile(fs, dir, onAuth, branchExists, `Add ice box: ${item.name} (${item.id})`);
    const createdItem = iceBoxesFile.items.find((candidate) => candidate.id === item.id);

    return {
      ok: true,
      syncedAt,
      message: `冰盒 ${item.name} 已同步到远端。`,
      items: iceBoxesFile.items,
      item: createdItem,
      commit,
    };
  } catch (error) {
    const classified = classifyGitError(config.repository, error);
    return { ok: false, syncedAt, message: classified.message, details: classified.details };
  }
}

export async function updateIceBox(
  input: GitRepositoryConfig,
  id: string,
  updates: Partial<IceBoxRecord>,
): Promise<IceBoxSyncResult> {
  const config = withStoredCredentials(input);
  const unsupported = requireRemoteHttps(config);
  const syncedAt = new Date().toISOString();
  if (unsupported) {
    return { ok: false, syncedAt, message: unsupported.message, details: unsupported.details };
  }

  try {
    const { fs, dir, onAuth, branchExists } = await loadFridgeConfigRepo(config);
    const iceBoxesFile = await readIceBoxesFileFromRepo(fs.promises, dir);
    const index = iceBoxesFile.items.findIndex((item) => item.id === id);

    if (index < 0) {
      return { ok: false, syncedAt, message: `冰盒 ${id} 不存在。`, items: iceBoxesFile.items };
    }

    iceBoxesFile.items[index] = {
      ...iceBoxesFile.items[index],
      ...updates,
      id,
      updatedAt: syncedAt,
    };
    iceBoxesFile.updatedAt = syncedAt;

    await writeTextFile(fs.promises, `${dir}/${iceBoxesFileName}`, serializeJson(iceBoxesFile));
    const { commit } = await commitAndPushIceBoxesFile(fs, dir, onAuth, branchExists, `Update ice box: ${id}`);

    return {
      ok: true,
      syncedAt,
      message: `冰盒 ${id} 已更新到远端。`,
      items: iceBoxesFile.items,
      item: iceBoxesFile.items[index],
      commit,
    };
  } catch (error) {
    const classified = classifyGitError(config.repository, error);
    return { ok: false, syncedAt, message: classified.message, details: classified.details };
  }
}

export async function deleteIceBox(input: GitRepositoryConfig, id: string): Promise<IceBoxSyncResult> {
  return updateIceBox(input, id, {
    deletedAt: new Date().toISOString(),
  });
}

export async function syncIceBoxBranch(
  input: GitRepositoryConfig,
  iceBoxId: string,
): Promise<IceBoxBranchSyncResult> {
  const syncedAt = new Date().toISOString();
  const result = await updateIceBox(input, iceBoxId, {
    syncStatus: "synced",
    lastSyncAt: syncedAt,
    lastSyncError: null,
  });

  return {
    ...result,
    syncedAt,
    iceBoxId,
  };
}

function buildIceBoxBranch(iceBoxId: string) {
  return `${iceBoxBranchPrefix}/${iceBoxId}`;
}

async function loadIceBoxBranchRepo(config: GitRepositoryConfig, iceBoxId: string) {
  const onAuth = getAuthCallback(config);
  const http = createHttpAdapter(onAuth);
  const branch = buildIceBoxBranch(iceBoxId);
  const repoKey = `${config.repository}#${branch}`;
  const { fs, dir } = await prepareRepoDir(config.repository, { wipe: false, key: repoKey });
  const branchExists = await git
    .listServerRefs({
      http,
      url: config.repository,
      onAuth,
      protocolVersion: 2,
      prefix: `refs/heads/${branch}`,
    })
    .then((refs) => refs.some((ref) => ref.ref === `refs/heads/${branch}`));

  if (!branchExists) {
    throw new IceBoxHistoryBranchMissingError(branch);
  }

  const hasGitRepo = await pathExists(fs.promises, `${dir}/.git`);

  if (!hasGitRepo) {
    await removeEntry(fs.promises, dir);
    await ensureDir(fs.promises, dir);
    await git.clone({
      fs,
      http,
      dir,
      url: config.repository,
      ref: branch,
      singleBranch: true,
      depth: 20,
      onAuth,
    });
  } else {
    await git.fetch({
      fs,
      http,
      dir,
      url: config.repository,
      ref: branch,
      singleBranch: true,
      depth: 20,
      onAuth,
      prune: true,
      tags: false,
    });
  }

  await git.checkout({ fs, dir, ref: branch, force: true });

  return { fs, dir, onAuth, branch, branchExists };
}

export async function getIceBoxHistory(
  input: GitRepositoryConfig,
  iceBoxId: string,
): Promise<IceBoxHistoryEntry[]> {
  const config = withStoredCredentials(input);
  const unsupported = requireRemoteHttps(config);
  if (unsupported) {
    throw new FrontendGitFallbackError(unsupported.message, {
      details: unsupported.details,
    });
  }

  try {
    const { fs, dir, branch } = await loadIceBoxBranchRepo(config, iceBoxId);
    const commits = await git.log({ fs, dir, ref: branch, depth: 20 });

    return commits.map((entry) => ({
      branch,
      commit: entry.oid,
      summary: entry.commit.message.split("\n")[0] ?? "",
      message: entry.commit.message,
      committedAt: entry.commit.committer.timestamp
        ? new Date(entry.commit.committer.timestamp * 1000).toISOString()
        : new Date().toISOString(),
      authorName: entry.commit.author.name ?? "Unknown",
      authorEmail: entry.commit.author.email ?? null,
    }));
  } catch (error) {
    if (isIceBoxHistoryBranchMissingError(error)) {
      throw error;
    }

    const classified = classifyGitError(config.repository, error);

    if (classified.message.includes("浏览器模式暂不支持") || classified.message.includes("浏览器无法直接访问")) {
      throw buildFrontendFallbackError(config.repository, error);
    }

    throw new Error(classified.details || classified.message);
  }
}

import "server-only";

import * as git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildGitConfigErrorResult,
  getDefaultGitUsername,
  getGitPlatformAuthHelp,
  isHttpsRepository,
  isSshRepository,
  normalizeGitConfig,
} from "@/lib/git-config";
import { fridgeConfigBranch, seedFridgeConfigFiles } from "@/lib/fridge-config";
import { logDevInfo } from "@/lib/server-logger";
import type {
  GitConfigInitResult,
  GitConfigTestResult,
  GitRepositoryConfig,
  GitSshKeyAuthConfig,
} from "@/types";

const execFileAsync = promisify(execFile);
const gitCommitAuthorName = "Claw Fridge";
const gitCommitAuthorEmail = "claw-fridge@local";

function expandHomeDirectory(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "未知错误";
}

function ensureTrailingLineBreak(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function detectDefaultBranch(output: string): string | undefined {
  const branchMatch = output.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m);

  if (branchMatch?.[1]) {
    return branchMatch[1].trim();
  }

  return undefined;
}

function buildGitAuthFailureDetails(
  repository: string,
  authMethod: "https-token" | "ssh-key",
  error: unknown,
): string {
  const message = formatErrorMessage(error);
  const helpLines = getGitPlatformAuthHelp(repository, authMethod);

  return [message, ...helpLines].join("\n");
}

function withSshUsername(repository: string, username: string): string {
  const trimmedRepository = repository.trim();
  const trimmedUsername = username.trim();

  if (!trimmedUsername) {
    return trimmedRepository;
  }

  if (trimmedRepository.startsWith("ssh://")) {
    const url = new URL(trimmedRepository);

    if (!url.username) {
      url.username = trimmedUsername;
    }

    return url.toString();
  }

  if (trimmedRepository.includes("@")) {
    return trimmedRepository;
  }

  const scpStyleMatch = trimmedRepository.match(/^([^\s:]+):(.*)$/);

  if (scpStyleMatch) {
    return `${trimmedUsername}@${trimmedRepository}`;
  }

  return trimmedRepository;
}

async function testLocalRepository(config: GitRepositoryConfig): Promise<GitConfigTestResult> {
  const resolvedPath = expandHomeDirectory(config.repository);

  try {
    await access(resolvedPath);
  } catch {
    return buildGitConfigErrorResult("本地仓库路径不存在。", resolvedPath);
  }

  try {
    const root = await git.findRoot({ fs, filepath: resolvedPath });
    const currentBranch = await git.currentBranch({ fs, dir: root, fullname: false });
    const head = await git.resolveRef({ fs, dir: root, ref: "HEAD" });

    // 检查 fridge-config 分支是否存在
    let hasFridgeConfig = false;
    try {
      const branches = await git.listBranches({ fs, dir: root });
      hasFridgeConfig = branches.includes(fridgeConfigBranch);
    } catch {
      // 忽略错误
    }

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      target: "local",
      message: "本地 Git 仓库可用。",
      details: `仓库根目录：${root}\n当前分支：${currentBranch ?? "detached HEAD"}\nHEAD：${head}`,
      defaultBranch: currentBranch ?? undefined,
      hasFridgeConfig,
    };
  } catch (error) {
    return buildGitConfigErrorResult("未识别到有效的本地 Git 仓库。", formatErrorMessage(error));
  }
}

async function testHttpsRepository(config: GitRepositoryConfig): Promise<GitConfigTestResult> {
  if (!isHttpsRepository(config.repository)) {
    return buildGitConfigErrorResult("HTTPS Token 认证只支持 HTTPS 仓库地址。", config.repository);
  }

  const httpsAuth = config.auth.method === "https-token" ? config.auth : null;
  const onAuth =
    httpsAuth !== null
      ? () => ({
          username: httpsAuth.username.trim() || getDefaultGitUsername(config.repository, "https-token"),
          password: httpsAuth.token.trim(),
        })
      : undefined;

  if (httpsAuth !== null && !httpsAuth.token.trim()) {
    return buildGitConfigErrorResult(
      "请填写 HTTPS Token。",
      getGitPlatformAuthHelp(config.repository, "https-token").join("\n"),
    );
  }

  try {
    const refs = await git.listServerRefs({
      http,
      url: config.repository,
      onAuth,
      protocolVersion: 2,
      symrefs: true,
      prefix: "HEAD",
    });
    const defaultBranch = refs.find((ref) => ref.ref === "HEAD")?.target?.replace("refs/heads/", "");

    // 检查 fridge-config 分支是否存在
    let hasFridgeConfig = false;
    try {
      const branchRefs = await git.listServerRefs({
        http,
        url: config.repository,
        onAuth,
        protocolVersion: 2,
        prefix: `refs/heads/${fridgeConfigBranch}`,
      });
      hasFridgeConfig = branchRefs.some((ref) => ref.ref === `refs/heads/${fridgeConfigBranch}`);
    } catch {
      // 忽略错误
    }

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      target: "remote-https",
      message: "HTTPS 远程仓库连接成功。",
      details: `地址：${config.repository}${defaultBranch ? `\n默认分支：${defaultBranch}` : ""}`,
      defaultBranch,
      hasFridgeConfig,
    };
  } catch (error) {
    return buildGitConfigErrorResult(
      "HTTPS 远程仓库连接失败。",
      buildGitAuthFailureDetails(config.repository, "https-token", error),
    );
  }
}

function parseSshAgentEnvironment(output: string): Record<string, string> {
  const authSock = output.match(/SSH_AUTH_SOCK=([^;\n]+)/)?.[1];
  const agentPid = output.match(/SSH_AGENT_PID=([^;\n]+)/)?.[1];

  if (!authSock || !agentPid) {
    throw new Error("无法初始化 SSH Agent 环境变量。");
  }

  return {
    SSH_AUTH_SOCK: authSock,
    SSH_AGENT_PID: agentPid,
  };
}

async function createSshAskPassScript(directory: string): Promise<string> {
  const askPassPath = path.join(directory, "askpass.sh");
  const scriptContent = `#!/bin/sh\nprintf '%s' "$CLAW_FRIDGE_SSH_PASSPHRASE"\n`;

  await writeFile(askPassPath, scriptContent, "utf8");
  await chmod(askPassPath, 0o700);

  return askPassPath;
}

async function createHttpsAskPassScript(directory: string): Promise<string> {
  const askPassPath = path.join(directory, "https-askpass.sh");
  const scriptContent = `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s' "$CLAW_FRIDGE_GIT_USERNAME" ;;\n  *Password*) printf '%s' "$CLAW_FRIDGE_GIT_PASSWORD" ;;\n  *) printf '%s' "$CLAW_FRIDGE_GIT_PASSWORD" ;;\nesac\n`;

  await writeFile(askPassPath, scriptContent, "utf8");
  await chmod(askPassPath, 0o700);

  return askPassPath;
}

async function prepareSshEnvironment(auth: GitSshKeyAuthConfig): Promise<{
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-git-"));
  const privateKeyPath = path.join(tempDirectory, "id_key");
  const publicKeyPath = path.join(tempDirectory, "id_key.pub");

  await writeFile(privateKeyPath, ensureTrailingLineBreak(auth.privateKey), "utf8");
  await chmod(privateKeyPath, 0o600);

  if (auth.publicKey.trim()) {
    await writeFile(publicKeyPath, ensureTrailingLineBreak(auth.publicKey), "utf8");
    await chmod(publicKeyPath, 0o644);
  }

  if (!auth.passphrase.trim()) {
    return {
      env: {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i ${privateKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
      },
      cleanup: async () => {
        await rm(tempDirectory, { recursive: true, force: true });
      },
    };
  }

  const askPassPath = await createSshAskPassScript(tempDirectory);
  const agentStart = await execFileAsync("ssh-agent", ["-s"]);
  const agentEnvironment = parseSshAgentEnvironment(agentStart.stdout);

  await execFileAsync("ssh-add", [privateKeyPath], {
    env: {
      ...process.env,
      ...agentEnvironment,
      SSH_ASKPASS: askPassPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "claw-fridge",
      CLAW_FRIDGE_SSH_PASSPHRASE: auth.passphrase,
    },
  });

  return {
    env: {
      ...process.env,
      ...agentEnvironment,
      GIT_SSH_COMMAND: "ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
    },
    cleanup: async () => {
      try {
        await execFileAsync("ssh-agent", ["-k"], {
          env: {
            ...process.env,
            ...agentEnvironment,
          },
        });
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    },
  };
}

async function testSshRepository(config: GitRepositoryConfig): Promise<GitConfigTestResult> {
  if (!isSshRepository(config.repository)) {
    return buildGitConfigErrorResult("SSH Key 认证只支持 SSH 仓库地址。", config.repository);
  }

  if (config.auth.method !== "ssh-key") {
    return buildGitConfigErrorResult(
      "当前仓库地址是 SSH，但未提供 SSH Key 配置。",
      getGitPlatformAuthHelp(config.repository, "ssh-key").join("\n"),
    );
  }

  if (!config.auth.privateKey.trim()) {
    return buildGitConfigErrorResult("请填写 SSH 私钥。", getGitPlatformAuthHelp(config.repository, "ssh-key").join("\n"));
  }

  const repository = withSshUsername(config.repository, config.auth.username);
  const sshEnvironment = await prepareSshEnvironment(config.auth);

  try {
    const result = await execFileAsync("git", ["ls-remote", "--symref", repository, "HEAD"], {
      env: sshEnvironment.env,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const defaultBranch = detectDefaultBranch(result.stdout);

    // 检查 fridge-config 分支是否存在
    let hasFridgeConfig = false;
    try {
      const branchResult = await execFileAsync(
        "git",
        ["ls-remote", "--exit-code", "--heads", repository, fridgeConfigBranch],
        {
          env: sshEnvironment.env,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        },
      );
      hasFridgeConfig = branchResult.stdout.trim().length > 0;
    } catch {
      // 分支不存在时会返回非零退出码，忽略
    }

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      target: "remote-ssh",
      message: "SSH 远程仓库连接成功。",
      details: `地址：${repository}${defaultBranch ? `\n默认分支：${defaultBranch}` : ""}`,
      defaultBranch,
      hasFridgeConfig,
    };
  } catch (error) {
    return buildGitConfigErrorResult(
      "SSH 远程仓库连接失败。",
      buildGitAuthFailureDetails(repository, "ssh-key", error),
    );
  } finally {
    await sshEnvironment.cleanup();
  }
}

export async function runGitCommand(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 30000,
      maxBuffer: 1024 * 1024,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (error instanceof Error) {
      const gitError = error as Error & {
        stderr?: unknown;
        stdout?: unknown;
      };
      const stderr = typeof gitError.stderr === "string" ? gitError.stderr.trim() : "";
      const stdout = typeof gitError.stdout === "string" ? gitError.stdout.trim() : "";
      const message = stderr || stdout || error.message;

      throw new Error(message);
    }

    throw new Error(formatErrorMessage(error));
  }
}

export async function tryRunGitCommand(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  try {
    await runGitCommand(args, options);
    return true;
  } catch {
    return false;
  }
}

export async function prepareInitializationEnvironment(config: GitRepositoryConfig): Promise<{
  repository: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}> {
  if (config.kind === "local") {
    return {
      repository: expandHomeDirectory(config.repository),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      cleanup: async () => {},
    };
  }

  if (isHttpsRepository(config.repository)) {
    if (config.auth.method === "https-token") {
      if (!config.auth.token.trim()) {
        throw new Error(
          [
            "请先填写 HTTPS Token，再初始化 fridge-config 分支。",
            ...getGitPlatformAuthHelp(config.repository, "https-token"),
          ].join("\n"),
        );
      }

      const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-git-auth-"));
      const askPassPath = await createHttpsAskPassScript(tempDirectory);

      return {
        repository: config.repository,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: askPassPath,
          CLAW_FRIDGE_GIT_USERNAME:
            config.auth.username.trim() || getDefaultGitUsername(config.repository, "https-token"),
          CLAW_FRIDGE_GIT_PASSWORD: config.auth.token.trim(),
        },
        cleanup: async () => {
          await rm(tempDirectory, { recursive: true, force: true });
        },
      };
    }

    return {
      repository: config.repository,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      cleanup: async () => {},
    };
  }

  if (isSshRepository(config.repository)) {
    if (config.auth.method !== "ssh-key") {
      throw new Error(
        [
          "当前仓库地址是 SSH，请切换到 SSH Key 认证后再初始化分支。",
          ...getGitPlatformAuthHelp(config.repository, "ssh-key"),
        ].join("\n"),
      );
    }

    if (!config.auth.privateKey.trim()) {
      throw new Error(["请先填写 SSH 私钥，再初始化 fridge-config 分支。", ...getGitPlatformAuthHelp(config.repository, "ssh-key")].join("\n"));
    }

    const sshEnvironment = await prepareSshEnvironment(config.auth);

    return {
      repository: withSshUsername(config.repository, config.auth.username),
      env: sshEnvironment.env,
      cleanup: sshEnvironment.cleanup,
    };
  }

  throw new Error("无法识别 Git 仓库类型，暂时无法初始化 fridge-config 分支。");
}

function formatSeededFilesDetails(files: NonNullable<GitConfigInitResult["files"]>): string {
  return files
    .map((file) => {
      const statusLabel =
        file.status === "created"
          ? "已创建"
          : file.status === "overwritten"
            ? "已覆盖"
            : "已保留";

      return `${file.path}：${statusLabel}`;
    })
    .join("\n");
}

export async function testGitConfiguration(input: GitRepositoryConfig): Promise<GitConfigTestResult> {
  const config = normalizeGitConfig(input);

  if (!config.repository) {
    return buildGitConfigErrorResult("请先填写 Git 仓库路径或远程地址。");
  }

  if (config.kind === "local") {
    return testLocalRepository(config);
  }

  if (isHttpsRepository(config.repository)) {
    return testHttpsRepository(config);
  }

  if (isSshRepository(config.repository)) {
    return testSshRepository(config);
  }

  return buildGitConfigErrorResult("无法识别 Git 仓库类型。", config.repository);
}

export async function initializeFridgeConfigBranch(input: GitRepositoryConfig): Promise<GitConfigInitResult> {
  const config = normalizeGitConfig(input);
  const initializedAt = new Date().toISOString();

  if (!config.repository) {
    return {
      ok: false,
      initializedAt,
      message: "请先填写 Git 仓库路径或远程地址。",
      branch: fridgeConfigBranch,
    };
  }

  const targetRoot = config.kind === "local" ? expandHomeDirectory(config.repository) : config.repository;

  let cleanupEnvironment: (() => Promise<void>) | undefined;
  let tempDirectory: string | undefined;

  try {
    const prepared = await prepareInitializationEnvironment(config);
    cleanupEnvironment = prepared.cleanup;
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "claw-fridge-init-"));
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

    const branchExists = await tryRunGitCommand(
      ["ls-remote", "--exit-code", "--heads", "origin", fridgeConfigBranch],
      {
        cwd: workingDirectory,
        env: prepared.env,
      },
    );

    if (branchExists) {
      await runGitCommand(["fetch", "origin", `${fridgeConfigBranch}:refs/remotes/origin/${fridgeConfigBranch}`], {
        cwd: workingDirectory,
        env: prepared.env,
      });
      await runGitCommand(["checkout", "-B", fridgeConfigBranch, `origin/${fridgeConfigBranch}`], {
        cwd: workingDirectory,
        env: prepared.env,
      });
    } else {
      await runGitCommand(["checkout", "--orphan", fridgeConfigBranch], {
        cwd: workingDirectory,
        env: prepared.env,
      });
    }

    const seededFiles = await seedFridgeConfigFiles({
      dir: workingDirectory,
      initializedAt,
      skipExisting: true,
    });

    const hasNoStagedChanges = await tryRunGitCommand(["diff", "--cached", "--quiet"], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    if (hasNoStagedChanges) {
      logDevInfo("git-config.init", "fridge-config already initialized", {
        branch: fridgeConfigBranch,
        repositoryKind: config.kind,
        root: targetRoot,
      });

      return {
        ok: true,
        initializedAt,
        message: "`fridge-config` 分支已存在，初始化文件也已经齐全。",
        details: formatSeededFilesDetails(seededFiles.files),
        branch: fridgeConfigBranch,
        root: targetRoot,
        files: seededFiles.files,
        alreadyInitialized: true,
      };
    }

    await runGitCommand(["commit", "-m", "Initialize fridge-config branch"], {
      cwd: workingDirectory,
      env: prepared.env,
    });
    await runGitCommand(["push", "-u", "origin", fridgeConfigBranch], {
      cwd: workingDirectory,
      env: prepared.env,
    });

    const commit = (await runGitCommand(["rev-parse", "HEAD"], {
      cwd: workingDirectory,
      env: prepared.env,
    })).stdout.trim();

    logDevInfo("git-config.init", "fridge-config initialized", {
      branch: fridgeConfigBranch,
      repositoryKind: config.kind,
      root: targetRoot,
      commit,
      branchExists,
    });

    return {
      ok: true,
      initializedAt,
      message: branchExists
        ? "`fridge-config` 分支已补齐并推送初始化文件。"
        : "`fridge-config` 分支初始化完成，配置文件已推送。",
      details: formatSeededFilesDetails(seededFiles.files),
      branch: fridgeConfigBranch,
      root: targetRoot,
      commit,
      files: seededFiles.files,
      alreadyInitialized: false,
    };
  } catch (error) {
    return {
      ok: false,
      initializedAt,
      message: "初始化 `fridge-config` 分支失败。",
      details: formatErrorMessage(error),
      errorCode: "git_init_failed",
      statusCode: 400,
      branch: fridgeConfigBranch,
      root: targetRoot,
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { useMounted } from "@/hooks/use-mounted";
import {
  detectRepositoryFlavor,
  detectRepositoryKind,
  detectRepositoryPlatform,
  getDefaultGitUsername,
  getGitPlatformAuthHelp,
  getGitPlatformLabel,
  getGitRepositoryExamples,
  getGitTokenPlaceholder,
  getGitUsernamePlaceholder,
} from "@/lib/git-config";
import { fridgeConfigBranch } from "@/lib/fridge-config.constants";
import { useAppStore } from "@/store/app-store";
import type { GitAuthMethod, GitConfigInitResult, GitRepositoryConfig } from "@/types";

function createAuthConfig(
  method: GitAuthMethod,
  currentConfig: GitRepositoryConfig["auth"],
  repository: string,
): GitRepositoryConfig["auth"] {
  if (method === "https-token") {
    return {
      method,
      username:
        currentConfig.method === "https-token"
          ? currentConfig.username
          : getDefaultGitUsername(repository, method),
      token: currentConfig.method === "https-token" ? currentConfig.token : "",
    };
  }

  if (method === "ssh-key") {
    return {
      method,
      username:
        currentConfig.method === "ssh-key"
          ? currentConfig.username
          : getDefaultGitUsername(repository, method),
      privateKey: currentConfig.method === "ssh-key" ? currentConfig.privateKey : "",
      publicKey: currentConfig.method === "ssh-key" ? currentConfig.publicKey : "",
      passphrase: currentConfig.method === "ssh-key" ? currentConfig.passphrase : "",
    };
  }

  return { method: "none" };
}

function syncAuthConfigWithRepository(
  repository: string,
  repositoryKind: GitRepositoryConfig["kind"],
  currentAuth: GitRepositoryConfig["auth"],
): GitRepositoryConfig["auth"] {
  if (repositoryKind === "local") {
    return { method: "none" };
  }

  const repositoryFlavor = detectRepositoryFlavor(repository, repositoryKind);

  if (repositoryFlavor === "https" && currentAuth.method === "ssh-key") {
    return createAuthConfig("https-token", currentAuth, repository);
  }

  if (repositoryFlavor === "ssh" && currentAuth.method === "https-token") {
    return createAuthConfig("ssh-key", currentAuth, repository);
  }

  if (currentAuth.method === "https-token" && !currentAuth.username.trim()) {
    return {
      ...currentAuth,
      username: getDefaultGitUsername(repository, "https-token"),
    };
  }

  if (currentAuth.method === "ssh-key" && !currentAuth.username.trim()) {
    return {
      ...currentAuth,
      username: getDefaultGitUsername(repository, "ssh-key"),
    };
  }

  return currentAuth;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "未保存";
  }

  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatAuthMethodLabel(method: GitAuthMethod) {
  switch (method) {
    case "https-token":
      return "HTTPS Token";
    case "ssh-key":
      return "SSH Key";
    default:
      return "无需认证";
  }
}

function formatFileStatus(result: GitConfigInitResult) {
  if (!result.files?.length) {
    return null;
  }

  return result.files
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

function ResultDetails({ details, label = "查看细节" }: { details: string; label?: string }) {
  return (
    <details className="mt-3 rounded-xl bg-black/5 p-3 text-xs leading-5 text-current dark:bg-black/20">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{details}</pre>
    </details>
  );
}

export function GitConfigPanel() {
  const mounted = useMounted();
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const persistedConfig = useAppStore((state) => state.gitConfig);
  const lastGitTestResult = useAppStore((state) => state.lastGitTestResult);
  const lastGitInitResult = useAppStore((state) => state.lastGitInitResult);
  const saveGitConfig = useAppStore((state) => state.saveGitConfig);
  const testGitConfig = useAppStore((state) => state.testGitConfig);
  const initializeFridgeConfig = useAppStore((state) => state.initializeFridgeConfig);
  const clearGitTestResult = useAppStore((state) => state.clearGitTestResult);
  const clearGitInitResult = useAppStore((state) => state.clearGitInitResult);

  const [draftConfig, setDraftConfig] = useState<GitRepositoryConfig>(persistedConfig);
  const [isTesting, setIsTesting] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    if (hasHydrated) {
      setDraftConfig(persistedConfig);
    }
  }, [hasHydrated, persistedConfig]);

  const repositoryKind = useMemo(() => {
    if (!draftConfig.repository.trim()) {
      return draftConfig.kind;
    }

    return detectRepositoryKind(draftConfig.repository);
  }, [draftConfig.kind, draftConfig.repository]);

  const repositoryFlavor = useMemo(() => {
    return detectRepositoryFlavor(draftConfig.repository, repositoryKind);
  }, [draftConfig.repository, repositoryKind]);

  const repositoryPlatform = useMemo(() => {
    return detectRepositoryPlatform(draftConfig.repository);
  }, [draftConfig.repository]);

  const platformLabel = useMemo(() => {
    return getGitPlatformLabel(repositoryPlatform);
  }, [repositoryPlatform]);

  const platformExamples = useMemo(() => {
    return getGitRepositoryExamples(repositoryPlatform === "local" ? "generic" : repositoryPlatform);
  }, [repositoryPlatform]);

  const platformAuthHelp = useMemo(() => {
    if (repositoryKind !== "remote" || draftConfig.auth.method === "none") {
      return [];
    }

    return getGitPlatformAuthHelp(draftConfig.repository, draftConfig.auth.method);
  }, [draftConfig.auth.method, draftConfig.repository, repositoryKind]);

  const effectiveConfig = useMemo<GitRepositoryConfig>(() => {
    if (repositoryKind === "local") {
      return {
        ...draftConfig,
        kind: "local",
        auth: { method: "none" },
      };
    }

    return {
      ...draftConfig,
      kind: "remote",
      auth: syncAuthConfigWithRepository(draftConfig.repository, "remote", draftConfig.auth),
    };
  }, [draftConfig, repositoryKind]);

  const isDirty = useMemo(() => {
    return JSON.stringify(effectiveConfig) !== JSON.stringify(persistedConfig);
  }, [effectiveConfig, persistedConfig]);

  const canTest = useMemo(() => {
    return Boolean(effectiveConfig.repository.trim()) && !isTesting && !isInitializing;
  }, [effectiveConfig.repository, isInitializing, isTesting]);

  const canInitialize = useMemo(() => {
    return Boolean(effectiveConfig.repository.trim()) && !isDirty && !isTesting && !isInitializing;
  }, [effectiveConfig.repository, isDirty, isInitializing, isTesting]);

  const actionHint = useMemo(() => {
    if (!effectiveConfig.repository.trim()) {
      return {
        tone: "warning",
        message: "先填写 Git 仓库路径或远程地址，再继续测试或初始化。",
      };
    }

    if (repositoryKind === "remote" && effectiveConfig.auth.method === "https-token" && !effectiveConfig.auth.token.trim()) {
      return {
        tone: "warning",
        message: "当前是 HTTPS 仓库，建议先补上访问 Token，再测试连接。",
      };
    }

    if (repositoryKind === "remote" && effectiveConfig.auth.method === "ssh-key" && !effectiveConfig.auth.privateKey.trim()) {
      return {
        tone: "warning",
        message: "当前是 SSH 仓库，请先填写私钥，再测试连接。",
      };
    }

    if (isDirty) {
      return {
        tone: "info",
        message: "草稿和已保存配置不一致；初始化会自动保存当前草稿，测试连接则直接使用当前草稿。",
      };
    }

    return null;
  }, [effectiveConfig, isDirty, repositoryKind]);

  const clearTransientResults = () => {
    clearGitTestResult();
    clearGitInitResult();
    setSaveNotice(null);
  };

  const handleRepositoryChange = (repository: string) => {
    clearTransientResults();
    setDraftConfig((currentConfig) => {
      const nextKind = repository.trim() ? detectRepositoryKind(repository) : currentConfig.kind;

      return {
        ...currentConfig,
        repository,
        kind: nextKind,
        auth: syncAuthConfigWithRepository(repository, nextKind, currentConfig.auth),
      };
    });
  };

  const handleAuthMethodChange = (method: GitAuthMethod) => {
    clearTransientResults();
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      auth: createAuthConfig(method, currentConfig.auth, currentConfig.repository),
    }));
  };

  const handleSave = () => {
    saveGitConfig(effectiveConfig);
    setSaveNotice("仓库配置已保存。建议先测试连接，再初始化 fridge-config。");
  };

  const handleTest = async () => {
    setIsTesting(true);

    try {
      await testGitConfig(effectiveConfig);
    } finally {
      setIsTesting(false);
    }
  };

  const handleInitialize = async () => {
    saveGitConfig(effectiveConfig);
    setIsInitializing(true);

    try {
      await initializeFridgeConfig(effectiveConfig);
    } finally {
      setIsInitializing(false);
    }
  };

  const handleReset = () => {
    clearTransientResults();
    setDraftConfig(persistedConfig);
  };

  if (!mounted || !hasHydrated) {
    return (
      <section className="fridge-panel">
        <div className="h-6 w-40 animate-pulse rounded-full bg-zinc-200/80 dark:bg-white/10" />
        <div className="mt-4 grid gap-3">
          <div className="h-10 animate-pulse rounded-2xl bg-zinc-100 dark:bg-white/5" />
          <div className="h-28 animate-pulse rounded-2xl bg-zinc-100 dark:bg-white/5" />
        </div>
      </section>
    );
  }

  return (
    <section className="fridge-panel grid gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <span className="fridge-kicker">Git Config</span>
          <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">配置存储仓库</h2>
          <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            先把 OpenClaw 配置仓库接上，再初始化 <code>{fridgeConfigBranch}</code> 分支，后面的 Ice Box
            创建、同步和备份流程才有地方落地。
          </p>
        </div>

        <div className="flex flex-wrap gap-2 text-xs font-medium">
          <span className="fridge-chip">
            {repositoryKind === "local" ? "本地仓库" : "远程仓库"}
          </span>
          <span className="fridge-chip fridge-chip--ocean">
            {repositoryFlavor === "local"
              ? "Path"
              : repositoryFlavor === "https"
                ? "HTTPS"
                : repositoryFlavor === "ssh"
                  ? "SSH"
                  : "Remote"}
          </span>
          <span className="fridge-chip fridge-chip--coral">{platformLabel}</span>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_0.9fr]">
        <div className="grid gap-4">
          <label className="grid gap-2">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">仓库路径或远程地址</span>
            <input
              value={draftConfig.repository}
              onChange={(event) => handleRepositoryChange(event.target.value)}
              placeholder={`~/projects/openclaw 或 ${platformExamples.ssh}`}
              className="fridge-input"
            />
          </label>

          <div className="fridge-panel-muted text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">首次配置提示</p>
            <p>支持 GitHub / GitLab / Gitea / 通用自托管 Git 仓库。</p>
            <p>HTTPS 示例：{platformExamples.https}</p>
            <p>SSH 示例：{platformExamples.ssh}</p>
          </div>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">认证方式</span>
            <select
              value={repositoryKind === "local" ? "none" : effectiveConfig.auth.method}
              onChange={(event) => handleAuthMethodChange(event.target.value as GitAuthMethod)}
              disabled={repositoryKind === "local"}
              className="fridge-select"
            >
              <option value="none">无需认证 / 公共仓库</option>
              <option value="https-token" disabled={repositoryFlavor === "ssh"}>
                HTTPS Token
              </option>
              <option value="ssh-key" disabled={repositoryFlavor === "https"}>
                SSH Key
              </option>
            </select>
          </label>

          {repositoryKind === "remote" && effectiveConfig.auth.method === "https-token" ? (
            <div className="grid gap-4 rounded-2xl border border-zinc-200/80 bg-zinc-50/80 p-4 dark:border-white/10 dark:bg-zinc-950/50">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">用户名</span>
                <input
                  value={effectiveConfig.auth.username}
                  onChange={(event) => {
                    clearTransientResults();
                    setDraftConfig((currentConfig) => ({
                      ...currentConfig,
                      auth:
                        currentConfig.auth.method === "https-token"
                          ? { ...currentConfig.auth, username: event.target.value }
                          : currentConfig.auth,
                    }));
                  }}
                  placeholder={getGitUsernamePlaceholder(draftConfig.repository, "https-token")}
                  className="fridge-input"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">访问 Token</span>
                <input
                  type="password"
                  value={effectiveConfig.auth.token}
                  onChange={(event) => {
                    clearTransientResults();
                    setDraftConfig((currentConfig) => ({
                      ...currentConfig,
                      auth:
                        currentConfig.auth.method === "https-token"
                          ? { ...currentConfig.auth, token: event.target.value }
                          : currentConfig.auth,
                    }));
                  }}
                  placeholder={getGitTokenPlaceholder(draftConfig.repository)}
                  className="fridge-input"
                />
              </label>

              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-900 dark:text-amber-100">
                <p>检测平台：{platformLabel}</p>
                <p>默认用户名：{getDefaultGitUsername(draftConfig.repository, "https-token")}</p>
                {platformAuthHelp.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>
          ) : null}

          {repositoryKind === "remote" && effectiveConfig.auth.method === "ssh-key" ? (
            <div className="grid gap-4 rounded-2xl border border-zinc-200/80 bg-zinc-50/80 p-4 dark:border-white/10 dark:bg-zinc-950/50">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">SSH 用户名</span>
                <input
                  value={effectiveConfig.auth.username}
                  onChange={(event) => {
                    clearTransientResults();
                    setDraftConfig((currentConfig) => ({
                      ...currentConfig,
                      auth:
                        currentConfig.auth.method === "ssh-key"
                          ? { ...currentConfig.auth, username: event.target.value }
                          : currentConfig.auth,
                    }));
                  }}
                  placeholder={getGitUsernamePlaceholder(draftConfig.repository, "ssh-key")}
                  className="fridge-input"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">私钥</span>
                <textarea
                  value={effectiveConfig.auth.privateKey}
                  onChange={(event) => {
                    clearTransientResults();
                    setDraftConfig((currentConfig) => ({
                      ...currentConfig,
                      auth:
                        currentConfig.auth.method === "ssh-key"
                          ? { ...currentConfig.auth, privateKey: event.target.value }
                          : currentConfig.auth,
                    }));
                  }}
                  rows={6}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  className="fridge-textarea"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">公钥（可选）</span>
                <textarea
                  value={effectiveConfig.auth.publicKey}
                  onChange={(event) => {
                    clearTransientResults();
                    setDraftConfig((currentConfig) => ({
                      ...currentConfig,
                      auth:
                        currentConfig.auth.method === "ssh-key"
                          ? { ...currentConfig.auth, publicKey: event.target.value }
                          : currentConfig.auth,
                    }));
                  }}
                  rows={3}
                  placeholder="ssh-ed25519 AAAA..."
                  className="fridge-textarea"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">私钥密码（可选）</span>
                <input
                  type="password"
                  value={effectiveConfig.auth.passphrase}
                  onChange={(event) => {
                    clearTransientResults();
                    setDraftConfig((currentConfig) => ({
                      ...currentConfig,
                      auth:
                        currentConfig.auth.method === "ssh-key"
                          ? { ...currentConfig.auth, passphrase: event.target.value }
                          : currentConfig.auth,
                    }));
                  }}
                  placeholder="有密码就填，没有就留空"
                  className="fridge-input"
                />
              </label>

              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-900 dark:text-amber-100">
                <p>检测平台：{platformLabel}</p>
                <p>默认用户名：{getDefaultGitUsername(draftConfig.repository, "ssh-key")}</p>
                {platformAuthHelp.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={handleSave} className="fridge-button-primary">
              保存配置
            </button>
            <button type="button" onClick={handleTest} disabled={!canTest} className="fridge-button-secondary">
              {isTesting ? "测试中..." : "测试连接"}
            </button>
            <button type="button" onClick={handleInitialize} disabled={!canInitialize} className="fridge-button-secondary">
              {isInitializing ? "初始化中..." : `初始化 ${fridgeConfigBranch}`}
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={!isDirty && !lastGitTestResult && !lastGitInitResult}
              className="fridge-button-ghost"
            >
              还原草稿
            </button>
          </div>

          {saveNotice ? <div className="fridge-state fridge-state--success">{saveNotice}</div> : null}
          {actionHint ? (
            <div className={`fridge-state ${actionHint.tone === "warning" ? "fridge-state--warning" : "fridge-state--info"}`}>
              {actionHint.message}
            </div>
          ) : null}

          <div className="fridge-panel-muted text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">推荐顺序</p>
            <p>1. 先保存当前仓库配置。</p>
            <p>2. 再测试连接，确认认证方式没填错。</p>
            <p>3. 最后初始化 {fridgeConfigBranch}，给冰盒创建和全局配置留出专属分支。</p>
          </div>
        </div>

        <aside className="fridge-panel-muted grid gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">当前状态</h3>
            <div className="space-y-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              <p>已保存：{formatDateTime(persistedConfig.updatedAt)}</p>
              <p>仓库类型：{persistedConfig.kind === "local" ? "本地" : "远程"}</p>
              <p>平台识别：{getGitPlatformLabel(detectRepositoryPlatform(persistedConfig.repository))}</p>
              <p>认证方式：{formatAuthMethodLabel(persistedConfig.auth.method)}</p>
              <p>配置分支：{fridgeConfigBranch}</p>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">平台支持</h3>
            <div className="space-y-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              <p>已覆盖 GitHub / GitLab / Gitea / 通用 HTTPS、SSH 仓库。</p>
              <p>GitLab PAT 默认推荐用户名是 `oauth2`；Deploy Token 则改用平台生成的专用用户名。</p>
              <p>GitHub、GitLab、Gitea 的 SSH 地址通常都可直接使用 `git@host:owner/repo.git`。</p>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">接入建议</h3>
            <div className="space-y-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              <p>本地仓库会通过临时克隆来初始化，不会直接改动你当前工作区。</p>
              <p>远程仓库建议先“测试连接”，再初始化专用配置分支。</p>
              <p>初始化完成后，后续 Ice Box 列表和全局配置就能写入这个分支。</p>
            </div>
          </div>

          {lastGitTestResult ? (
            <div
              className={[
                "fridge-state",
                lastGitTestResult.ok ? "fridge-state--success" : "fridge-state--error",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <strong>{lastGitTestResult.ok ? "连接成功" : "连接失败"}</strong>
                <span className="text-xs opacity-80">{formatDateTime(lastGitTestResult.checkedAt)}</span>
              </div>
              <p className="mt-2">{lastGitTestResult.message}</p>
              {lastGitTestResult.defaultBranch ? <p className="mt-2">默认分支：{lastGitTestResult.defaultBranch}</p> : null}
              {lastGitTestResult.details ? <ResultDetails details={lastGitTestResult.details} /> : null}
            </div>
          ) : null}

          {lastGitInitResult ? (
            <div
              className={[
                "fridge-state",
                lastGitInitResult.ok ? "fridge-state--success" : "fridge-state--error",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <strong>{lastGitInitResult.ok ? "初始化完成" : "初始化失败"}</strong>
                <span className="text-xs opacity-80">{formatDateTime(lastGitInitResult.initializedAt)}</span>
              </div>
              <p className="mt-2">{lastGitInitResult.message}</p>
              {lastGitInitResult.branch ? <p className="mt-2">目标分支：{lastGitInitResult.branch}</p> : null}
              {lastGitInitResult.commit ? <p className="mt-2">提交：{lastGitInitResult.commit}</p> : null}
              {formatFileStatus(lastGitInitResult) ? (
                <ResultDetails details={formatFileStatus(lastGitInitResult) ?? ""} label="查看初始化文件变更" />
              ) : null}
              {lastGitInitResult.details ? <ResultDetails details={lastGitInitResult.details} /> : null}
            </div>
          ) : (
            <div className="fridge-panel-muted text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              点击“初始化 {fridgeConfigBranch}”后，应用会在临时克隆里创建配置文件并推送到专用分支。
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

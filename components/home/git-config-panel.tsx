"use client";

import { useEffect, useMemo, useState } from "react";
import { useMounted } from "@/hooks/use-mounted";
import {
  detectRepositoryFlavor,
  detectRepositoryKind,
  getDefaultGitUsername,
  getGitRepositoryExamples,
  getGitTokenPlaceholder,
  getGitUsernamePlaceholder,
} from "@/lib/git-config";
import { fridgeConfigBranch } from "@/lib/fridge-config.constants";
import { clearStoredGitCredentials, persistGitCredentials } from "@/lib/git-client";
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
    if (mounted) {
      setDraftConfig(persistedConfig);
    }
  }, [mounted, persistedConfig]);

  const repositoryKind = useMemo(() => {
    if (!draftConfig.repository.trim()) {
      return draftConfig.kind;
    }

    return detectRepositoryKind(draftConfig.repository);
  }, [draftConfig.kind, draftConfig.repository]);

  const repositoryFlavor = useMemo(() => {
    return detectRepositoryFlavor(draftConfig.repository, repositoryKind);
  }, [draftConfig.repository, repositoryKind]);

  const platformExamples = useMemo(() => {
    return getGitRepositoryExamples("generic");
  }, []);

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
    if (effectiveConfig.auth.method === "https-token" && effectiveConfig.auth.token.trim()) {
      persistGitCredentials(effectiveConfig);
    }
    setSaveNotice("已保存");
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

  const handleClearCredentials = () => {
    clearTransientResults();
    clearStoredGitCredentials(effectiveConfig.repository);
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      auth:
        currentConfig.auth.method === "https-token"
          ? { ...currentConfig.auth, token: "" }
          : currentConfig.auth,
    }));
    saveGitConfig({
      ...effectiveConfig,
      auth:
        effectiveConfig.auth.method === "https-token"
          ? { ...effectiveConfig.auth, token: "" }
          : effectiveConfig.auth,
    });
    setSaveNotice("已清除本地凭证");
  };

  if (!mounted) {
    return (
      <section className="fridge-panel">
        <div className="h-6 w-32 animate-pulse rounded-full bg-zinc-200/80 dark:bg-white/10" />
        <div className="mt-4 grid gap-3">
          <div className="h-10 animate-pulse rounded-2xl bg-zinc-100 dark:bg-white/5" />
          <div className="h-28 animate-pulse rounded-2xl bg-zinc-100 dark:bg-white/5" />
        </div>
      </section>
    );
  }

  return (
    <section className="fridge-panel grid gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50 sm:text-3xl">Git 配置</h2>
      </div>

      <div className="grid gap-4">
        <label className="grid gap-2">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">仓库地址</span>
          <input
            value={draftConfig.repository}
            onChange={(event) => handleRepositoryChange(event.target.value)}
            placeholder={`~/projects/openclaw 或 ${platformExamples.https}`}
            className="fridge-input"
          />
        </label>

        <label className="grid gap-2">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">认证方式</span>
          <select
            value={repositoryKind === "local" ? "none" : effectiveConfig.auth.method}
            onChange={(event) => handleAuthMethodChange(event.target.value as GitAuthMethod)}
            disabled={repositoryKind === "local"}
            className="fridge-select"
          >
            <option value="none">无需认证</option>
            <option value="https-token" disabled={repositoryFlavor === "ssh"}>
              HTTPS Token
            </option>
            <option value="ssh-key" disabled>
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

            <button type="button" onClick={handleClearCredentials} className="fridge-button-ghost w-fit">
              清除本地凭证
            </button>
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
            {isInitializing
              ? lastGitTestResult?.hasFridgeConfig
                ? "载入中..."
                : "初始化中..."
              : lastGitTestResult?.hasFridgeConfig
                ? `载入 ${fridgeConfigBranch}`
                : `初始化 ${fridgeConfigBranch}`}
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
            {lastGitTestResult.hasFridgeConfig !== undefined ? (
              <p className="mt-2">
                {fridgeConfigBranch} 分支：{lastGitTestResult.hasFridgeConfig ? "已存在" : "不存在"}
              </p>
            ) : null}
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
        ) : null}
      </div>
    </section>
  );
}

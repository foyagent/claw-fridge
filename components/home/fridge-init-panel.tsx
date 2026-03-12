"use client";

import { useState } from "react";
import { fridgeConfigBranch } from "@/lib/fridge-config.constants";
import { useAppStore } from "@/store/app-store";

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "未保存";
  }

  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function ResultDetails({ details, label = "查看细节" }: { details: string; label?: string }) {
  return (
    <details className="mt-3 rounded-xl bg-black/5 p-3 text-xs leading-5 text-current dark:bg-black/20">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{details}</pre>
    </details>
  );
}

export function FridgeInitPanel() {
  const gitConfig = useAppStore((state) => state.gitConfig);
  const lastGitTestResult = useAppStore((state) => state.lastGitTestResult);
  const lastGitInitResult = useAppStore((state) => state.lastGitInitResult);
  const initializeFridgeConfig = useAppStore((state) => state.initializeFridgeConfig);
  const [isInitializing, setIsInitializing] = useState(false);

  const canInitialize = Boolean(gitConfig.repository.trim()) && !isInitializing;
  const actionLabel = lastGitTestResult?.hasFridgeConfig ? `载入 ${fridgeConfigBranch}` : `初始化 ${fridgeConfigBranch}`;

  async function handleInitialize() {
    if (!canInitialize) {
      return;
    }

    setIsInitializing(true);

    try {
      await initializeFridgeConfig(gitConfig);
    } finally {
      setIsInitializing(false);
    }
  }

  return (
    <section className="fridge-panel grid gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50 sm:text-3xl">初始化</h2>
        <button type="button" onClick={() => void handleInitialize()} disabled={!canInitialize} className="fridge-button-primary">
          {isInitializing ? `${actionLabel}中...` : actionLabel}
        </button>
      </div>

      {lastGitInitResult ? (
        <div className={["fridge-state", lastGitInitResult.ok ? "fridge-state--success" : "fridge-state--error"].join(" ")}>
          <div className="flex items-center justify-between gap-3">
            <strong>{lastGitInitResult.ok ? "初始化完成" : "初始化失败"}</strong>
            <span className="text-xs opacity-80">{formatDateTime(lastGitInitResult.initializedAt)}</span>
          </div>
          <p className="mt-2">{lastGitInitResult.message}</p>
          {lastGitInitResult.branch ? <p className="mt-2">目标分支：{lastGitInitResult.branch}</p> : null}
          {lastGitInitResult.commit ? <p className="mt-2">提交：{lastGitInitResult.commit}</p> : null}
          {lastGitInitResult.details ? <ResultDetails details={lastGitInitResult.details} /> : null}
        </div>
      ) : null}
    </section>
  );
}

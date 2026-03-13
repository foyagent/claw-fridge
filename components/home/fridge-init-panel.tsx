"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { fridgeConfigBranch } from "@/lib/fridge-config.constants";
import { useAppStore } from "@/store/app-store";

function formatDateTime(value: string | null | undefined, locale: string, fallback: string) {
  if (!value) {
    return fallback;
  }

  return new Date(value).toLocaleString(locale, { hour12: false });
}

function ResultDetails({ details, label }: { details: string; label: string }) {
  return (
    <details className="mt-3 rounded-xl bg-black/5 p-3 text-xs leading-5 text-current dark:bg-black/20">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{details}</pre>
    </details>
  );
}

export function FridgeInitPanel() {
  const t = useTranslations();
  const locale = useLocale();
  const gitConfig = useAppStore((state) => state.gitConfig);
  const lastGitTestResult = useAppStore((state) => state.lastGitTestResult);
  const lastGitInitResult = useAppStore((state) => state.lastGitInitResult);
  const initializeFridgeConfig = useAppStore((state) => state.initializeFridgeConfig);
  const [isInitializing, setIsInitializing] = useState(false);

  const canInitialize = Boolean(gitConfig.repository.trim()) && !isInitializing;
  const actionLabel = lastGitTestResult?.hasFridgeConfig
    ? t("fridgeInit.loadBranch", { branch: fridgeConfigBranch })
    : t("fridgeInit.initializeBranch", { branch: fridgeConfigBranch });

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
        <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50 sm:text-3xl">{t("fridgeInit.title")}</h2>
        <button type="button" onClick={() => void handleInitialize()} disabled={!canInitialize} className="fridge-button-primary">
          {isInitializing ? t("fridgeInit.initializing", { action: actionLabel }) : actionLabel}
        </button>
      </div>

      {lastGitInitResult ? (
        <div className={["fridge-state", lastGitInitResult.ok ? "fridge-state--success" : "fridge-state--error"].join(" ")}>
          <div className="flex items-center justify-between gap-3">
            <strong>{lastGitInitResult.ok ? t("fridgeInit.initSuccess") : t("fridgeInit.initFailed")}</strong>
            <span className="text-xs opacity-80">{formatDateTime(lastGitInitResult.initializedAt, locale, t("gitConfig.notSaved"))}</span>
          </div>
          <p className="mt-2">{lastGitInitResult.message}</p>
          {lastGitInitResult.branch ? <p className="mt-2">{t("gitConfig.targetBranch")}: {lastGitInitResult.branch}</p> : null}
          {lastGitInitResult.commit ? <p className="mt-2">{t("gitConfig.commit")}: {lastGitInitResult.commit}</p> : null}
          {lastGitInitResult.details ? <ResultDetails details={lastGitInitResult.details} label={t("common.viewDetails")} /> : null}
        </div>
      ) : null}
    </section>
  );
}

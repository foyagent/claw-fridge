"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { IceBoxDetail } from "@/components/ice-boxes/ice-box-detail";
import { IceBoxCreateForm } from "@/components/home/ice-box-create-form";
import { useMounted } from "@/hooks/use-mounted";
import { formatLastBackupTime, getIceBoxStatusMeta, getIceBoxSyncStatusMeta } from "@/lib/ice-boxes";
import { useAppStore } from "@/store/app-store";
import { useIceBoxStore } from "@/store/ice-box-store";
import type { IceBoxStatus } from "@/types";

function statusClassName(status: IceBoxStatus) {
  if (status === "healthy") {
    return "fridge-chip fridge-chip--success";
  }

  if (status === "syncing") {
    return "fridge-chip fridge-chip--ocean";
  }

  return "fridge-chip fridge-chip--warning";
}

function syncStatusClassName(syncStatus: ReturnType<typeof getIceBoxSyncStatusMeta>["tone"]) {
  if (syncStatus === "success") {
    return "fridge-chip fridge-chip--success";
  }

  if (syncStatus === "error") {
    return "fridge-chip fridge-chip--warning";
  }

  if (syncStatus === "info") {
    return "fridge-chip fridge-chip--ocean";
  }

  return "fridge-chip";
}

function IceBoxListSkeleton() {
  return (
    <section className="fridge-panel grid gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-3">
          <div className="h-8 w-24 animate-pulse rounded-full bg-zinc-200 dark:bg-white/10" />
        </div>
        <div className="h-11 w-36 animate-pulse rounded-full bg-zinc-200 dark:bg-white/10" />
      </div>

      <div className="grid gap-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-40 animate-pulse rounded-[24px] bg-zinc-100/80 dark:bg-white/5" />
        ))}
      </div>
    </section>
  );
}

export function IceBoxList() {
  const t = useTranslations();
  const locale = useLocale();
  const mounted = useMounted();
  const gitConfig = useAppStore((state) => state.gitConfig);
  const gitConfigRepository = gitConfig.repository;
  const gitConfigUpdatedAt = gitConfig.updatedAt;
  const iceBoxes = useIceBoxStore((state) => state.iceBoxes);
  const hasLoaded = useIceBoxStore((state) => state.hasLoaded);
  const isLoading = useIceBoxStore((state) => state.isLoading);
  const error = useIceBoxStore((state) => state.error);
  const loadIceBoxes = useIceBoxStore((state) => state.loadIceBoxes);
  const clearError = useIceBoxStore((state) => state.clearError);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const hasCachedIceBoxes = iceBoxes.length > 0;

  useEffect(() => {
    if (!mounted) {
      return;
    }

    void loadIceBoxes(useAppStore.getState().gitConfig);
  }, [gitConfigRepository, gitConfigUpdatedAt, loadIceBoxes, mounted]);

  const activeExpandedId = useMemo(() => {
    if (!expandedId) {
      return null;
    }

    return iceBoxes.some((item) => item.id === expandedId) ? expandedId : null;
  }, [expandedId, iceBoxes]);

  function toggleExpanded(id: string) {
    setExpandedId((currentId) => (currentId === id ? null : id));
  }

  function handleCreateSuccess() {
    setIsCreating(false);
  }

  function handleCreateCancel() {
    setIsCreating(false);
  }

  if (!mounted || (isLoading && !hasLoaded && !hasCachedIceBoxes)) {
    return <IceBoxListSkeleton />;
  }

  return (
    <section className="fridge-panel grid gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50 sm:text-3xl">{t("home.title")}</h2>
        <button
          type="button"
          onClick={() => setIsCreating((current) => !current)}
          className="fridge-button-primary"
        >
          {isCreating ? t("home.collapseCreateForm") : t("home.newIceBox")}
        </button>
      </div>

      <div
        className={[
          "grid overflow-hidden transition-all duration-300 ease-out",
          isCreating ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        ].join(" ")}
        aria-hidden={!isCreating}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={[
              "transition-all duration-300 ease-out",
              isCreating ? "translate-y-0" : "-translate-y-2",
            ].join(" ")}
          >
            <IceBoxCreateForm
              onSuccess={handleCreateSuccess}
              onCancel={handleCreateCancel}
            />
          </div>
        </div>
      </div>

      {error ? (
        <div className="fridge-state fridge-state--error flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">{t("home.loadFailed")}</p>
            <p className="mt-1 opacity-90">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              clearError();
              void loadIceBoxes(gitConfig);
            }}
            className="fridge-button-secondary"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {iceBoxes.length === 0 && !isCreating ? (
        <div className="grid gap-4 rounded-[24px] border border-dashed border-zinc-300 bg-white/55 p-8 dark:border-white/10 dark:bg-white/5">
          <div className="space-y-2">
            <p className="text-lg font-medium text-zinc-900 dark:text-zinc-100">{t("home.emptyTitle")}</p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{t("home.emptyDescription")}</p>
          </div>
          <button
            type="button"
            onClick={() => setIsCreating(true)}
            className="fridge-button-primary w-fit"
          >
            {t("home.newIceBox")}
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {iceBoxes.map((iceBox) => {
            const statusMeta = getIceBoxStatusMeta(iceBox.status, t);
            const syncMeta = getIceBoxSyncStatusMeta(iceBox.syncStatus, t);
            const isExpanded = activeExpandedId === iceBox.id;

            return (
              <div key={iceBox.id} className="grid gap-4">
                <button
                  type="button"
                  onClick={() => toggleExpanded(iceBox.id)}
                  className="group grid gap-5 rounded-[24px] border border-zinc-200/80 bg-white/72 p-5 text-left transition hover:border-sky-400/40 hover:bg-white hover:shadow-lg hover:shadow-sky-500/10 dark:border-white/10 dark:bg-white/5 dark:hover:border-sky-500/30"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{iceBox.name}</h3>
                        <span className={statusClassName(iceBox.status)}>{statusMeta.label}</span>
                        <span className={syncStatusClassName(syncMeta.tone)}>{syncMeta.shortLabel}</span>
                      </div>
                    </div>
                    <span className="text-sm font-medium text-zinc-500 transition group-hover:text-sky-700 dark:text-zinc-400 dark:group-hover:text-sky-300">
                      {isExpanded ? t("common.collapse") : t("common.expand")}
                    </span>
                  </div>

                  <dl className="grid gap-3 text-sm text-zinc-600 dark:text-zinc-300 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("home.lastBackup")}</dt>
                      <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{formatLastBackupTime(iceBox.lastBackupAt, t, locale)}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("home.remoteSync")}</dt>
                      <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{syncMeta.label}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("home.machineId")}</dt>
                      <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.machineId}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("home.backupBranch")}</dt>
                      <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.branch}</dd>
                    </div>
                  </dl>
                </button>

                {isExpanded ? <IceBoxDetail id={iceBox.id} embedded /> : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

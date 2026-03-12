"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { IceBoxDetail } from "@/components/ice-boxes/ice-box-detail";
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

  if (!mounted || (isLoading && !hasLoaded)) {
    return <IceBoxListSkeleton />;
  }

  return (
    <section className="fridge-panel grid gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50 sm:text-3xl">冰盒</h2>
        <Link href="/ice-boxes/new" className="fridge-button-primary">
          新建冰盒
        </Link>
      </div>

      {error ? (
        <div className="fridge-state fridge-state--error flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">冰盒列表加载失败</p>
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
            重试加载
          </button>
        </div>
      ) : null}

      {iceBoxes.length === 0 ? (
        <div className="grid gap-4 rounded-[24px] border border-dashed border-zinc-300 bg-white/55 p-8 dark:border-white/10 dark:bg-white/5">
          <Link href="/ice-boxes/new" className="fridge-button-primary w-fit">
            新建冰盒
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {iceBoxes.map((iceBox) => {
            const statusMeta = getIceBoxStatusMeta(iceBox.status);
            const syncMeta = getIceBoxSyncStatusMeta(iceBox.syncStatus);
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
                      {isExpanded ? "收起" : "展开"}
                    </span>
                  </div>

                  <dl className="grid gap-3 text-sm text-zinc-600 dark:text-zinc-300 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">最后备份</dt>
                      <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{formatLastBackupTime(iceBox.lastBackupAt)}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">远端同步</dt>
                      <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{syncMeta.label}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">机器 ID</dt>
                      <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.machineId}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">备份分支</dt>
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

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMounted } from "@/hooks/use-mounted";
import { formatLastBackupTime, getIceBoxStatusMeta, getIceBoxSyncStatusMeta } from "@/lib/ice-boxes";
import { useAppStore } from "@/store/app-store";
import { useIceBoxStore } from "@/store/ice-box-store";
import type { IceBoxStatus, SyncPendingIceBoxesResult } from "@/types";

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

function ResultDetails({ details }: { details: string }) {
  return (
    <details className="mt-3 rounded-xl bg-black/5 p-3 text-xs leading-5 text-current dark:bg-black/20">
      <summary className="cursor-pointer font-medium">查看细节</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{details}</pre>
    </details>
  );
}

function IceBoxListSkeleton() {
  return (
    <section className="fridge-panel grid gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-3">
          <div className="h-4 w-24 animate-pulse rounded-full bg-zinc-200 dark:bg-white/10" />
          <div className="h-8 w-52 animate-pulse rounded-full bg-zinc-200 dark:bg-white/10" />
          <div className="h-4 w-72 animate-pulse rounded-full bg-zinc-100 dark:bg-white/5" />
        </div>
        <div className="h-11 w-36 animate-pulse rounded-full bg-zinc-200 dark:bg-white/10" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-56 animate-pulse rounded-[24px] bg-zinc-100/80 dark:bg-white/5" />
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
  const syncPendingIceBoxes = useIceBoxStore((state) => state.syncPendingIceBoxes);
  const clearError = useIceBoxStore((state) => state.clearError);
  const [isSyncingPending, setIsSyncingPending] = useState(false);
  const [syncNotice, setSyncNotice] = useState<SyncPendingIceBoxesResult | null>(null);

  useEffect(() => {
    if (!mounted) {
      return;
    }

    void loadIceBoxes(useAppStore.getState().gitConfig);
  }, [gitConfigRepository, gitConfigUpdatedAt, loadIceBoxes, mounted]);

  const pendingIceBoxes = useMemo(() => iceBoxes.filter((item) => item.syncStatus !== "synced"), [iceBoxes]);

  async function handleSyncPending() {
    setIsSyncingPending(true);
    const result = await syncPendingIceBoxes(gitConfig);
    setSyncNotice(result);
    setIsSyncingPending(false);
  }

  if (!mounted || (isLoading && !hasLoaded)) {
    return <IceBoxListSkeleton />;
  }

  return (
    <section className="fridge-panel grid gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <span className="fridge-kicker">Ice Boxes</span>
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50 sm:text-3xl">冰盒列表</h2>
            <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300 sm:text-base">
              所有冰盒会在这里汇总展示：运行状态、远端同步状态、最近备份、分支信息，以及下一步要进入的详情页入口。
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="fridge-chip">共 {iceBoxes.length} 个冰盒</span>
          {pendingIceBoxes.length > 0 ? <span className="fridge-chip fridge-chip--warning">待同步 {pendingIceBoxes.length} 个</span> : null}
          {pendingIceBoxes.length > 0 ? (
            <button type="button" onClick={() => void handleSyncPending()} className="fridge-button-secondary" disabled={isSyncingPending}>
              {isSyncingPending ? "正在同步待同步冰盒..." : "同步全部待同步冰盒"}
            </button>
          ) : null}
          <Link href="/ice-boxes/new" className="fridge-button-primary">
            创建新冰盒
          </Link>
        </div>
      </div>

      {syncNotice ? (
        <div
          className={`fridge-state ${syncNotice.ok ? "fridge-state--success" : "fridge-state--warning"} grid gap-2`}
        >
          <div>
            <p className="font-medium">{syncNotice.message}</p>
            <p className="mt-1 text-sm opacity-90">已成功同步 {syncNotice.syncedCount} 个冰盒。</p>
          </div>
          {syncNotice.details ? <ResultDetails details={syncNotice.details} /> : null}
        </div>
      ) : null}

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
        <div className="grid gap-5 rounded-[24px] border border-dashed border-zinc-300 bg-white/55 p-8 text-center dark:border-white/10 dark:bg-white/5">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--ocean-soft)] text-3xl">🧊</div>
          <div className="space-y-2">
            <h3 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">冷冻室还是空的</h3>
            <p className="mx-auto max-w-xl text-sm leading-6 text-zinc-600 dark:text-zinc-300 sm:text-base">
              先创建第一个冰盒，把机器和备份分支接进来。创建完成后，这里会立即展示本地状态、远端同步状态、时间线和详情入口。
            </p>
          </div>
          <div className="fridge-step-grid text-left">
            <div className="fridge-step-card">
              <div className="mb-3 flex items-center gap-3">
                <span className="fridge-step-number">1</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">命名机器</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">生成 machine-id 与专属分支名。</p>
            </div>
            <div className="fridge-step-card">
              <div className="mb-3 flex items-center gap-3">
                <span className="fridge-step-number">2</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">选择备份模式</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">支持 Git 直推或压缩包上传。</p>
            </div>
            <div className="fridge-step-card">
              <div className="mb-3 flex items-center gap-3">
                <span className="fridge-step-number">3</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">交付 Skill</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">详情页会自动生成安装说明和后续恢复入口。</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/ice-boxes/new" className="fridge-button-primary">
              创建第一个冰盒
            </Link>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">支持后续接入 Git 直推或压缩包上传</span>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {iceBoxes.map((iceBox) => {
            const statusMeta = getIceBoxStatusMeta(iceBox.status);
            const syncMeta = getIceBoxSyncStatusMeta(iceBox.syncStatus);

            return (
              <Link
                key={iceBox.id}
                href={`/ice-boxes/${iceBox.id}`}
                className="group grid gap-5 rounded-[24px] border border-zinc-200/80 bg-white/72 p-5 transition hover:-translate-y-0.5 hover:border-sky-400/40 hover:bg-white hover:shadow-lg hover:shadow-sky-500/10 dark:border-white/10 dark:bg-white/5 dark:hover:border-sky-500/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{iceBox.name}</h3>
                    <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">{statusMeta.description}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <span className={statusClassName(iceBox.status)}>{statusMeta.label}</span>
                    <span className={syncStatusClassName(syncMeta.tone)}>{syncMeta.shortLabel}</span>
                  </div>
                </div>

                {iceBox.syncStatus !== "synced" ? (
                  <div className="rounded-2xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
                    <p className="font-medium">{syncMeta.label}</p>
                    <p className="mt-1">{syncMeta.description}</p>
                  </div>
                ) : null}

                <dl className="fridge-detail-list text-zinc-600 dark:text-zinc-300">
                  <div className="fridge-detail-item flex items-center justify-between gap-3">
                    <dt>最后备份</dt>
                    <dd className="text-right font-medium text-zinc-900 dark:text-zinc-100">
                      {formatLastBackupTime(iceBox.lastBackupAt)}
                    </dd>
                  </div>
                  <div className="fridge-detail-item flex items-center justify-between gap-3">
                    <dt>远端同步</dt>
                    <dd className="text-right font-medium text-zinc-900 dark:text-zinc-100">{syncMeta.label}</dd>
                  </div>
                  <div className="fridge-detail-item flex items-center justify-between gap-3">
                    <dt>机器 ID</dt>
                    <dd className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{iceBox.machineId}</dd>
                  </div>
                  <div className="fridge-detail-item flex items-center justify-between gap-3">
                    <dt>备份分支</dt>
                    <dd className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{iceBox.branch}</dd>
                  </div>
                </dl>

                <div className="flex items-center justify-between text-sm font-medium text-zinc-500 transition group-hover:text-sky-700 dark:text-zinc-400 dark:group-hover:text-sky-300">
                  <span>{iceBox.syncStatus === "synced" ? "查看详情" : "查看详情并重试同步"}</span>
                  <span aria-hidden="true">→</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

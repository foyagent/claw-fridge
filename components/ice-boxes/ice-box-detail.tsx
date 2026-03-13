"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { readApiPayload, toOperationNotice, toRequestFailureNotice, type OperationNotice } from "@/lib/api-client";
import { useMounted } from "@/hooks/use-mounted";
import { isEncryptionEnabled } from "@/lib/backup-encryption";
import {
  getIceBoxHistory,
  isIceBoxHistoryBranchMissingError,
  loadStoredGitCredentials,
  shouldFallbackToServer,
} from "@/lib/git-client";
import {
  calculateIceBoxReminderSnapshot,
  getIceBoxReminderPresetMeta,
  normalizeIceBoxReminderConfig,
} from "@/lib/ice-box-reminders";
import {
  buildScheduledBackupDescription,
  buildSkillLink,
  buildUploadUrl,
  createDefaultScheduledBackupConfig,
  formatDateTime,
  formatLastBackupTime,
  getIceBoxBackupModeMeta,
  getIceBoxStatusMeta,
  getIceBoxSyncStatusMeta,
  normalizeScheduledBackupConfig,
} from "@/lib/ice-boxes";
import { useAppStore } from "@/store/app-store";
import { useIceBoxStore } from "@/store/ice-box-store";
import type {
  IceBoxHistoryEntry,
  IceBoxHistoryResult,
  IceBoxReminderConfig,
  IceBoxReminderPreset,
  IceBoxScheduledBackupConfig,
  RestoreBackupResult,
  RestorePreviewResult,
} from "@/types";

function IceBoxDetailSkeleton() {
  return (
    <section className="fridge-panel grid gap-6">
      <div className="space-y-3">
        <div className="h-4 w-24 animate-pulse rounded-full bg-zinc-200 dark:bg-white/10" />
        <div className="h-10 w-56 animate-pulse rounded-full bg-zinc-200 dark:bg-white/10" />
        <div className="h-4 w-80 animate-pulse rounded-full bg-zinc-100 dark:bg-white/5" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="h-72 animate-pulse rounded-[24px] bg-zinc-100 dark:bg-white/5" />
        <div className="h-72 animate-pulse rounded-[24px] bg-zinc-100 dark:bg-white/5" />
      </div>
    </section>
  );
}

function statusClassName(status: "healthy" | "syncing" | "attention") {
  if (status === "healthy") {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }

  if (status === "syncing") {
    return "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }

  return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function reminderStatusClassName(status: "disabled" | "scheduled" | "due" | "overdue") {
  if (status === "disabled") {
    return "border-zinc-300/80 bg-zinc-100 text-zinc-700 dark:border-white/10 dark:bg-white/10 dark:text-zinc-200";
  }

  if (status === "scheduled") {
    return "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }

  if (status === "due") {
    return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }

  return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
}

function formatCommit(commit: string | null | undefined) {
  if (!commit) {
    return "--";
  }

  return commit.slice(0, 8);
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="fridge-state fridge-state--error flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium">冰盒详情加载失败</p>
        <p className="mt-1 opacity-90">{message}</p>
      </div>
      <button type="button" onClick={onRetry} className="fridge-button-secondary">
        重试加载
      </button>
    </div>
  );
}

function ResultDetails({ details }: { details: string }) {
  return (
    <details className="mt-3 rounded-xl bg-black/5 p-3 text-xs leading-5 text-current dark:bg-black/20">
      <summary className="cursor-pointer font-medium">查看细节</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{details}</pre>
    </details>
  );
}

type IceBoxHistoryViewState = "idle" | "ready" | "branch-missing" | "error";

interface IceBoxHistoryCacheRecord {
  entries: IceBoxHistoryEntry[];
  viewState: Exclude<IceBoxHistoryViewState, "idle" | "error">;
  cachedAt: string;
}

function getHistoryCacheKey(iceBoxId: string) {
  return `claw-fridge:ice-box-history:${iceBoxId}`;
}

function readHistoryCache(iceBoxId: string): IceBoxHistoryCacheRecord | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(getHistoryCacheKey(iceBoxId));

    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<IceBoxHistoryCacheRecord>;
    const entries = Array.isArray(parsedValue.entries) ? parsedValue.entries : [];
    const viewState = parsedValue.viewState === "branch-missing" ? "branch-missing" : "ready";

    return {
      entries,
      viewState,
      cachedAt: typeof parsedValue.cachedAt === "string" ? parsedValue.cachedAt : new Date().toISOString(),
    };
  } catch {
    window.localStorage.removeItem(getHistoryCacheKey(iceBoxId));
    return null;
  }
}

function writeHistoryCache(iceBoxId: string, record: IceBoxHistoryCacheRecord) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getHistoryCacheKey(iceBoxId), JSON.stringify(record));
}

export function IceBoxDetail({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const mounted = useMounted();
  const router = useRouter();
  const gitConfig = useAppStore((state) => state.gitConfig);
  const iceBoxes = useIceBoxStore((state) => state.iceBoxes);
  // const hasHydrated = useIceBoxStore((state) => state.hasHydrated);
  const hasLoaded = useIceBoxStore((state) => state.hasLoaded);
  const isLoading = useIceBoxStore((state) => state.isLoading);
  const error = useIceBoxStore((state) => state.error);
  const loadIceBoxes = useIceBoxStore((state) => state.loadIceBoxes);
  const updateIceBoxReminder = useIceBoxStore((state) => state.updateIceBoxReminder);
  const resetIceBoxReminder = useIceBoxStore((state) => state.resetIceBoxReminder);
  const syncIceBox = useIceBoxStore((state) => state.syncIceBox);
  const syncIceBoxBackupState = useIceBoxStore((state) => state.syncIceBoxBackupState);
  const deleteIceBox = useIceBoxStore((state) => state.deleteIceBox);
  const clearError = useIceBoxStore((state) => state.clearError);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [hasDeleted, setHasDeleted] = useState(false);
  const [includeGitCredentialsInSkill, setIncludeGitCredentialsInSkill] = useState(false);
  const [scheduledBackupInSkill, setScheduledBackupInSkill] = useState<IceBoxScheduledBackupConfig>(createDefaultScheduledBackupConfig());
  const [restoreTargetRootDir, setRestoreTargetRootDir] = useState("");
  const [restorePreview, setRestorePreview] = useState<RestorePreviewResult | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreBackupResult | null>(null);
  const [restoreError, setRestoreError] = useState<OperationNotice | null>(null);
  const [isPreviewingRestore, setIsPreviewingRestore] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [replaceExistingRestoreTarget, setReplaceExistingRestoreTarget] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<IceBoxHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<OperationNotice | null>(null);
  const [historyViewState, setHistoryViewState] = useState<IceBoxHistoryViewState>("idle");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasLoadedHistory, setHasLoadedHistory] = useState(false);
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState<IceBoxHistoryEntry | null>(null);
  const [reminderDraft, setReminderDraft] = useState<IceBoxReminderConfig | null>(null);
  const [reminderNotice, setReminderNotice] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<OperationNotice | null>(null);
  const [isSyncingToRemote, setIsSyncingToRemote] = useState(false);
  const hasCachedIceBox = iceBoxes.some((item) => item.id === id);

  useEffect(() => {
    if (!mounted || hasLoaded) {
      return;
    }

    void loadIceBoxes(gitConfig);
  }, [hasLoaded, loadIceBoxes, mounted, gitConfig]);

  const iceBox = useMemo(() => {
    return iceBoxes.find((item) => item.id === id) ?? null;
  }, [iceBoxes, id]);

  useEffect(() => {
    setReminderDraft(iceBox?.reminder ?? null);
    setReminderNotice(null);
  }, [iceBox]);

  useEffect(() => {
    if (!iceBox) {
      return;
    }

    const storageKey = `claw-fridge:scheduled-backup:${iceBox.id}`;
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    try {
      const storedValue = window.localStorage.getItem(storageKey);

      if (storedValue) {
        const parsedValue = JSON.parse(storedValue) as Partial<IceBoxScheduledBackupConfig>;

        setScheduledBackupInSkill(
          normalizeScheduledBackupConfig({
            ...parsedValue,
            timezone: parsedValue.timezone || browserTimezone,
          }),
        );
        return;
      }
    } catch {
      window.localStorage.removeItem(storageKey);
    }

    setScheduledBackupInSkill(
      normalizeScheduledBackupConfig({
        ...iceBox.skillConfig.scheduledBackup,
        timezone: iceBox.skillConfig.scheduledBackup?.timezone || browserTimezone,
      }),
    );
  }, [iceBox]);

  useEffect(() => {
    if (!iceBox) {
      return;
    }

    window.localStorage.setItem(`claw-fridge:scheduled-backup:${iceBox.id}`, JSON.stringify(scheduledBackupInSkill));
  }, [iceBox, scheduledBackupInSkill]);

  useEffect(() => {
    const cachedHistory = readHistoryCache(id);

    setRestoreTargetRootDir("");
    setRestorePreview(null);
    setRestoreResult(null);
    setRestoreError(null);
    setConfirmRestore(false);
    setReplaceExistingRestoreTarget(false);
    setHistoryEntries(cachedHistory?.entries ?? []);
    setHistoryError(null);
    setHistoryViewState(cachedHistory?.viewState ?? "idle");
    setIsLoadingHistory(false);
    setHasLoadedHistory(Boolean(cachedHistory));
    setHistoryRefreshNonce((currentValue) => currentValue + 1);
    setSelectedHistoryEntry(null);
    setSyncNotice(null);
    setIsSyncingToRemote(false);
  }, [id]);

  const hasConfiguredRepository = Boolean(gitConfig.repository.trim());
  const shouldConfirmOverwrite = Boolean(
    restorePreview?.targetExists || restoreResult?.requiresOverwriteConfirmation,
  );
  const canExecuteRestore =
    hasConfiguredRepository &&
    Boolean(restoreTargetRootDir.trim()) &&
    confirmRestore &&
    (!shouldConfirmOverwrite || replaceExistingRestoreTarget) &&
    !isPreviewingRestore &&
    !isRestoring;
  const restoreHint = useMemo(() => {
    if (!hasConfiguredRepository) {
      return "先回首页保存并测试 Git 仓库连接，恢复接口才能知道该去哪里拉取备份。";
    }

    if (!restoreTargetRootDir.trim()) {
      return "先填写恢复目标目录，实际写入会固定收口到该目录下的 `.openclaw`。";
    }

    if (!confirmRestore) {
      return "勾选恢复确认后，才能真正执行恢复。";
    }

    if (shouldConfirmOverwrite && !replaceExistingRestoreTarget) {
      return "检测到目标目录里已经有 `.openclaw`，请确认允许先备份旧目录再覆盖恢复。";
    }

    return null;
  }, [confirmRestore, hasConfiguredRepository, replaceExistingRestoreTarget, restoreTargetRootDir, shouldConfirmOverwrite]);

  async function handleRetry() {
    clearError();
    await loadIceBoxes(gitConfig);
  }

  async function handleSyncToRemote() {
    if (!iceBox) {
      return;
    }

    setIsSyncingToRemote(true);
    setSyncNotice(null);

    const result = await syncIceBox(iceBox.id, gitConfig);

    setSyncNotice({
      message: result.message,
      details: result.details,
      tone: result.ok ? "success" : "error",
    });
    setIsSyncingToRemote(false);
  }

  async function handleDelete() {
    setIsDeleting(true);
    setDeleteError(null);
    clearError();

    try {
      await deleteIceBox(id, gitConfig);
      setHasDeleted(true);
      router.replace(embedded ? "/" : "/");
    } catch (actionError) {
      setDeleteError(actionError instanceof Error ? actionError.message : "删除冰盒失败，请稍后重试。");
      setIsDeleting(false);
      return;
    }

    setIsDeleting(false);
  }

  const loadHistory = useCallback(async (targetIceBoxId: string, machineId: string, branch: string) => {
    setIsLoadingHistory(true);
    setHistoryError(null);

    try {
      let entries: IceBoxHistoryEntry[] = [];
      let nextViewState: Exclude<IceBoxHistoryViewState, "idle" | "error"> = "ready";

      try {
        entries = await getIceBoxHistory(gitConfig, machineId);
      } catch (frontendError) {
        if (isIceBoxHistoryBranchMissingError(frontendError)) {
          nextViewState = "branch-missing";
        } else {
          if (!shouldFallbackToServer(frontendError)) {
            throw frontendError;
          }

          const response = await fetch(`/api/ice-boxes/${targetIceBoxId}/history`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              machineId,
              branch,
              gitConfig,
              limit: 20,
            }),
          });
          const result = await readApiPayload<IceBoxHistoryResult>(response);

          if (!response.ok || !result.ok) {
            setHistoryError(toOperationNotice(result, "读取备份历史失败。"));
            setHistoryViewState("error");
            setHasLoadedHistory(true);
            return;
          }

          entries = result.entries ?? [];
          nextViewState = result.historyState === "branch-missing" ? "branch-missing" : "ready";
        }
      }

      const latestBackupAt = entries[0]?.committedAt ?? null;

      setHistoryEntries(entries);
      setHistoryViewState(nextViewState);
      setHistoryError(null);
      setHasLoadedHistory(true);
      writeHistoryCache(targetIceBoxId, {
        entries,
        viewState: nextViewState,
        cachedAt: new Date().toISOString(),
      });
      syncIceBoxBackupState(targetIceBoxId, latestBackupAt);
      setSelectedHistoryEntry((currentEntry) => {
        if (!currentEntry) {
          return null;
        }

        return entries.find((entry) => entry.commit === currentEntry.commit) ?? null;
      });
    } catch (actionError) {
      setHistoryViewState("error");
      setHistoryError(toRequestFailureNotice("读取备份历史时", actionError));
      setHasLoadedHistory(true);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [gitConfig, syncIceBoxBackupState]);

  useEffect(() => {
    if (!mounted || !iceBox || !hasConfiguredRepository || isLoadingHistory) {
      return;
    }

    void loadHistory(iceBox.id, iceBox.machineId, iceBox.branch);
  }, [hasConfiguredRepository, historyRefreshNonce, iceBox, isLoadingHistory, loadHistory, mounted]);

  function handleSelectHistoryEntry(entry: IceBoxHistoryEntry) {
    setSelectedHistoryEntry(entry);
    setRestorePreview(null);
    setRestoreResult(null);
    setRestoreError(null);
    document.getElementById("restore-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleRestorePreview() {
    if (!iceBox) {
      return;
    }

    setIsPreviewingRestore(true);
    setRestoreError(null);
    setRestoreResult(null);

    try {
      const response = await fetch(`/api/ice-boxes/${iceBox.id}/restore`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "preview",
          backupMode: iceBox.backupMode,
          machineId: iceBox.machineId,
          branch: iceBox.branch,
          commit: selectedHistoryEntry?.commit,
          gitConfig,
          targetRootDir: restoreTargetRootDir.trim() || undefined,
        }),
      });
      const result = await readApiPayload<RestorePreviewResult>(response);

      if (!response.ok || !result.ok) {
        setRestorePreview(null);
        setRestoreError(toOperationNotice(result, "恢复预览失败。"));
        return;
      }

      setRestorePreview(result);
      setReplaceExistingRestoreTarget(Boolean(result.targetExists));
    } catch (actionError) {
      setRestorePreview(null);
      setRestoreError(toRequestFailureNotice("加载恢复预览时", actionError));
    } finally {
      setIsPreviewingRestore(false);
    }
  }

  async function handleRestore() {
    if (!iceBox) {
      return;
    }

    setIsRestoring(true);
    setRestoreError(null);
    setRestoreResult(null);

    try {
      const response = await fetch(`/api/ice-boxes/${iceBox.id}/restore`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "restore",
          backupMode: iceBox.backupMode,
          machineId: iceBox.machineId,
          branch: iceBox.branch,
          commit: selectedHistoryEntry?.commit,
          gitConfig,
          targetRootDir: restoreTargetRootDir.trim(),
          confirmRestore,
          replaceExisting: replaceExistingRestoreTarget,
        }),
      });
      const result = await readApiPayload<RestoreBackupResult>(response);

      setRestoreResult(result);

      if (!response.ok || !result.ok) {
        setRestoreError(toOperationNotice(result, "恢复备份失败。"));
        return;
      }

      setRestorePreview(null);
      setConfirmRestore(false);
      syncIceBoxBackupState(iceBox.id, result.lastBackupAt ?? iceBox.lastBackupAt);
    } catch (actionError) {
      setRestoreResult(null);
      setRestoreError(toRequestFailureNotice("执行恢复时", actionError));
    } finally {
      setIsRestoring(false);
    }
  }

  function handleReminderPresetChange(nextPreset: IceBoxReminderPreset) {
    setReminderNotice(null);
    setReminderDraft((currentReminder) => {
      const baseReminder = currentReminder ?? iceBox?.reminder;

      if (!baseReminder) {
        return currentReminder;
      }

      const nextIntervalHours =
        nextPreset === "custom"
          ? baseReminder.preset === "custom"
            ? baseReminder.intervalHours
            : getIceBoxReminderPresetMeta(nextPreset).intervalHours
          : getIceBoxReminderPresetMeta(nextPreset).intervalHours;

      return {
        ...baseReminder,
        preset: nextPreset,
        intervalHours: nextIntervalHours,
      };
    });
  }

  function handleReminderSave() {
    if (!iceBox || !reminderDraft) {
      return;
    }

    const updatedAt = new Date().toISOString();
    const nextReminder = normalizeIceBoxReminderConfig(
      {
        ...reminderDraft,
        updatedAt,
      },
      updatedAt,
    );

    updateIceBoxReminder(iceBox.id, nextReminder, gitConfig);
    setReminderDraft(nextReminder);
    setReminderNotice("提醒配置已保存。下次提醒时间和状态已同步刷新。");
  }

  function handleReminderReset() {
    if (!iceBox) {
      return;
    }

    resetIceBoxReminder(iceBox.id, gitConfig);
    setReminderNotice("提醒配置已恢复为默认每周提醒。");
  }

  if (!mounted || (isLoading && !hasLoaded && !hasCachedIceBox)) {
    return <IceBoxDetailSkeleton />;
  }

  if (hasDeleted) {
    return (
      <section className="grid gap-5 rounded-[28px] border border-emerald-500/20 bg-emerald-500/10 p-8 text-center text-emerald-800 shadow-sm shadow-emerald-500/10 dark:text-emerald-200">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white/70 text-3xl dark:bg-black/10">
          ✅
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">冰盒已删除</h1>
          <p className="text-sm leading-6 opacity-90 sm:text-base">正在带你回到冰盒列表，冷冻室已经收拾干净了。</p>
        </div>
      </section>
    );
  }

  if (!iceBox && error) {
    return (
      <section className="grid gap-5 rounded-[28px] border border-black/10 bg-white/90 p-8 shadow-sm shadow-black/5 dark:border-white/10 dark:bg-white/5">
        <ErrorBanner message={error} onRetry={() => void handleRetry()} />
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
          >
            返回冰盒列表
          </Link>
        </div>
      </section>
    );
  }

  if (!iceBox) {
    return (
      <section className="grid gap-5 rounded-[28px] border border-black/10 bg-white/90 p-8 text-center shadow-sm shadow-black/5 dark:border-white/10 dark:bg-white/5">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100 text-3xl dark:bg-white/10">
          🧭
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">没有找到这个冰盒</h1>
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400 sm:text-base">
            可能是当前设备还没同步到本地存储，也可能这个冰盒尚未创建。
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
          >
            返回冰盒列表
          </Link>
        </div>
      </section>
    );
  }

  const statusMeta = getIceBoxStatusMeta(iceBox.status);
  const syncMeta = getIceBoxSyncStatusMeta(iceBox.syncStatus);
  const backupModeMeta = getIceBoxBackupModeMeta(iceBox.backupMode);
  const encryptionEnabled = isEncryptionEnabled(iceBox.skillConfig.encryption);
  const latestHistoryEntry = historyEntries[0] ?? null;
  const effectiveLastBackupAt = latestHistoryEntry?.committedAt ?? iceBox.lastBackupAt;
  const effectiveReminder = reminderDraft ?? iceBox.reminder;
  const reminderSnapshot = calculateIceBoxReminderSnapshot({
    reminder: effectiveReminder,
    createdAt: iceBox.createdAt,
    lastBackupAt: effectiveLastBackupAt,
  });
  const origin = window.location.origin;
  const storedGitCredentials =
    iceBox.skillConfig.gitAuthMethod === "https-token" ? loadStoredGitCredentials(iceBox.skillConfig.repository) : null;
  const resolvedGitUsername =
    iceBox.skillConfig.gitAuthMethod === "https-token"
      ? gitConfig.auth.method === "https-token" && gitConfig.repository.trim() === iceBox.skillConfig.repository
        ? gitConfig.auth.username.trim() || storedGitCredentials?.username || iceBox.skillConfig.gitUsername
        : storedGitCredentials?.username || iceBox.skillConfig.gitUsername
      : gitConfig.auth.method === "ssh-key" && gitConfig.repository.trim() === iceBox.skillConfig.repository
        ? gitConfig.auth.username.trim() || "git"
        : iceBox.skillConfig.gitUsername;
  const resolvedGitToken =
    iceBox.skillConfig.gitAuthMethod === "https-token"
      ? gitConfig.auth.method === "https-token" && gitConfig.repository.trim() === iceBox.skillConfig.repository
        ? gitConfig.auth.token.trim() || storedGitCredentials?.token || null
        : storedGitCredentials?.token || null
      : null;
  const resolvedGitPrivateKeyPath = null;
  const skillConfigForDocument = {
    ...iceBox.skillConfig,
    scheduledBackup: scheduledBackupInSkill,
  };
  const skillLink = buildSkillLink(origin, skillConfigForDocument, {
    includeGitCredentials: includeGitCredentialsInSkill,
    gitUsername: resolvedGitUsername,
    gitToken: resolvedGitToken,
    gitPrivateKeyPath: resolvedGitPrivateKeyPath,
  });
  const restoreSkillLink = buildSkillLink(origin, skillConfigForDocument, {
    mode: "restore",
    includeGitCredentials: includeGitCredentialsInSkill,
    gitUsername: resolvedGitUsername,
    gitToken: resolvedGitToken,
    gitPrivateKeyPath: resolvedGitPrivateKeyPath,
  });
  const uploadUrl = buildUploadUrl(origin, iceBox.uploadPath);
  const recoveryScriptUrl = `${origin}/recovery.sh`;
  const recoveryCommand = [
    `curl -fsSL ${recoveryScriptUrl} | bash -s --`,
    `--repository '${iceBox.skillConfig.repository}'`,
    `--machine-id '${iceBox.machineId}'`,
    `--branch '${iceBox.branch}'`,
    `--target-dir '/absolute/path/to/target-root'`,
    ...(iceBox.skillConfig.gitAuthMethod === "https-token"
      ? [
          `--username '${includeGitCredentialsInSkill ? resolvedGitUsername ?? "__CLAW_FRIDGE_GIT_USERNAME__" : "<your-git-username>"}'`,
          `--token '${includeGitCredentialsInSkill ? resolvedGitToken ?? "__CLAW_FRIDGE_GIT_TOKEN__" : "<your-git-token>"}'`,
        ]
      : []),
    ...(iceBox.skillConfig.gitAuthMethod === "ssh-key"
      ? [`--ssh-key '${includeGitCredentialsInSkill ? "__CLAW_FRIDGE_GIT_PRIVATE_KEY_PATH__" : "<your-private-key-path>"}'`]
      : []),
  ].join(" ");

  return (
    <section className="grid gap-6">
      <div className={embedded ? "grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/60 p-5 dark:border-white/10 dark:bg-zinc-950/30" : "fridge-hero"}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {!embedded ? (
              <Link href="/" className="fridge-button-ghost px-0 py-0">
                ← 返回冰盒列表
              </Link>
            ) : null}
            <span className="fridge-chip fridge-chip--ocean">{backupModeMeta.label}</span>
            <span className={`fridge-chip ${iceBox.backupMode === "upload-token" ? "fridge-chip--coral" : "fridge-chip--success"}`}>
              {iceBox.backupMode === "upload-token" ? "上传模式" : "Git 直推"}
            </span>
            <span className={`fridge-chip ${iceBox.syncStatus === "synced" ? "fridge-chip--success" : "fridge-chip--warning"}`}>
              {syncMeta.shortLabel}
            </span>
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className={embedded ? "text-2xl font-semibold text-zinc-950 dark:text-zinc-50" : "text-3xl font-semibold text-zinc-950 dark:text-zinc-50"}>{iceBox.name}</h1>
              <span className={`rounded-full border px-3 py-1 text-sm font-medium ${statusClassName(iceBox.status)}`}>
                {statusMeta.label}
              </span>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400 sm:text-base">
              {statusMeta.description}
            </p>
          </div>
        </div>

        <div className="fridge-panel-tint flex flex-wrap items-center gap-3 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
          {iceBox.syncStatus !== "synced" ? (
            <button type="button" onClick={() => void handleSyncToRemote()} className="fridge-button-secondary" disabled={isSyncingToRemote}>
              {isSyncingToRemote ? "正在同步到远端..." : "立即同步到远端"}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={() => void handleRetry()} /> : null}

      {iceBox.syncStatus !== "synced" ? (
        <div className="fridge-state fridge-state--warning grid gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">这台冰盒目前只保证本地存在，尚未确认写入远端。</p>
              <p className="mt-1 opacity-90">{syncMeta.description}</p>
            </div>
            <button type="button" onClick={() => void handleSyncToRemote()} className="fridge-button-secondary" disabled={isSyncingToRemote}>
              {isSyncingToRemote ? "正在同步到远端..." : "立即同步到远端"}
            </button>
          </div>
          {iceBox.lastSyncError ? <ResultDetails details={iceBox.lastSyncError} /> : null}
        </div>
      ) : null}

      {syncNotice ? (
        <div className={`fridge-state ${syncNotice.tone === "success" ? "fridge-state--success" : "fridge-state--warning"}`}>
          <p className="font-medium">{syncNotice.message}</p>
          {syncNotice.details ? <ResultDetails details={syncNotice.details} /> : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">基本信息</h2>
          <dl className="grid gap-3 text-sm text-zinc-600 dark:text-zinc-300">
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>冰盒名称</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">{iceBox.name}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>机器 ID</dt>
              <dd className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{iceBox.machineId}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>分支名称</dt>
              <dd className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{iceBox.branch}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>备份方案</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">{backupModeMeta.label}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>上传加密</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">
                {encryptionEnabled ? "已启用 AES-256-GCM" : "未启用"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>远端同步状态</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">{syncMeta.label}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>最近同步时间</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">{formatDateTime(iceBox.lastSyncAt)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>创建时间</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">{formatDateTime(iceBox.createdAt)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt>最后更新</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">{formatDateTime(iceBox.updatedAt)}</dd>
            </div>
          </dl>
        </div>

        <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">备份状态</h2>
          <div className="rounded-[24px] bg-white p-5 dark:bg-white/5">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">最后备份时间</p>
            <p className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
              {formatLastBackupTime(effectiveLastBackupAt)}
            </p>
          </div>
          <div className="grid gap-3 rounded-[24px] border border-zinc-200/80 bg-white p-4 dark:border-white/10 dark:bg-white/5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">定时备份提醒</p>
                <p className="mt-1 text-lg font-semibold text-zinc-950 dark:text-zinc-50">{reminderSnapshot.statusLabel}</p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-xs font-medium ${reminderStatusClassName(reminderSnapshot.status)}`}
              >
                {reminderSnapshot.statusLabel}
              </span>
            </div>
            <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">{reminderSnapshot.statusDescription}</p>
            <dl className="grid gap-3 text-sm text-zinc-600 dark:text-zinc-300">
              <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">提醒配置</dt>
                <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{reminderSnapshot.configLabel}</dd>
              </div>
              <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">下次提醒</dt>
                <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">
                  {formatDateTime(reminderSnapshot.nextReminderAt)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="grid gap-4 rounded-[24px] border border-dashed border-zinc-300 p-5 text-sm leading-6 text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">提醒配置</p>
              </div>
              <label className="inline-flex items-center gap-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={effectiveReminder.enabled}
                  onChange={(event) => {
                    setReminderNotice(null);
                    setReminderDraft((currentReminder) => {
                      const baseReminder = currentReminder ?? iceBox.reminder;

                      return {
                        ...baseReminder,
                        enabled: event.target.checked,
                      };
                    });
                  }}
                  className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
                />
                启用提醒
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">提醒节奏</span>
                <select
                  value={effectiveReminder.preset}
                  onChange={(event) => handleReminderPresetChange(event.target.value as IceBoxReminderPreset)}
                  className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                >
                  <option value="daily">每天一次</option>
                  <option value="every-3-days">每 3 天一次</option>
                  <option value="weekly">每周一次</option>
                  <option value="custom">自定义间隔</option>
                </select>
              </label>
              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">缓冲窗口（小时）</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={effectiveReminder.graceHours}
                  onChange={(event) => {
                    setReminderNotice(null);
                    setReminderDraft((currentReminder) => {
                      const baseReminder = currentReminder ?? iceBox.reminder;

                      return {
                        ...baseReminder,
                        graceHours: Math.max(1, Number(event.target.value) || 1),
                      };
                    });
                  }}
                  className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                />
              </label>
            </div>

            {effectiveReminder.preset === "custom" ? (
              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">自定义提醒间隔（小时）</span>
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={effectiveReminder.intervalHours}
                  onChange={(event) => {
                    setReminderNotice(null);
                    setReminderDraft((currentReminder) => {
                      const baseReminder = currentReminder ?? iceBox.reminder;

                      return {
                        ...baseReminder,
                        intervalHours: Math.max(1, Number(event.target.value) || 1),
                      };
                    });
                  }}
                  className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                />
              </label>
            ) : (
              <div className="rounded-2xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:bg-zinc-950/50 dark:text-zinc-300">
                当前选择：{getIceBoxReminderPresetMeta(effectiveReminder.preset).label}，默认间隔 {effectiveReminder.intervalHours} 小时。
              </div>
            )}

            {reminderNotice ? (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
                {reminderNotice}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleReminderSave}
                className="inline-flex items-center justify-center rounded-full bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                保存提醒配置
              </button>
              <button
                type="button"
                onClick={handleReminderReset}
                className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
              >
                重置为默认
              </button>
            </div>

          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">Skill 文档</h2>
          <div className="rounded-[24px] bg-white p-5 text-sm leading-6 text-zinc-600 dark:bg-white/5 dark:text-zinc-300">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">{backupModeMeta.label}</p>
            <p className="mt-2">{backupModeMeta.description}</p>
            <label className="mt-4 inline-flex items-center gap-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">
              <input
                type="checkbox"
                checked={includeGitCredentialsInSkill}
                onChange={(event) => setIncludeGitCredentialsInSkill(event.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
              />
              安装 Skill 时携带 Git 凭证占位符
            </label>
            <div className="mt-4 grid gap-4 rounded-[20px] border border-zinc-200/80 bg-zinc-50/70 p-4 dark:border-white/10 dark:bg-zinc-950/40">
              <label className="inline-flex items-center gap-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={scheduledBackupInSkill.enabled}
                  onChange={(event) =>
                    setScheduledBackupInSkill((currentConfig) => ({
                      ...currentConfig,
                      enabled: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
                />
                定时备份
              </label>
              {scheduledBackupInSkill.enabled ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">定时类型</span>
                      <select
                        value={scheduledBackupInSkill.preset}
                        onChange={(event) =>
                          setScheduledBackupInSkill((currentConfig) =>
                            normalizeScheduledBackupConfig({
                              ...currentConfig,
                              preset: event.target.value as IceBoxScheduledBackupConfig["preset"],
                            }),
                          )
                        }
                        className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                      >
                        <option value="daily">每天</option>
                        <option value="weekly">每周</option>
                        <option value="monthly">每月</option>
                        <option value="custom-cron">自定义 Cron</option>
                      </select>
                    </label>
                    <label className="grid gap-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">时区</span>
                      <input
                        type="text"
                        value={scheduledBackupInSkill.timezone}
                        onChange={(event) =>
                          setScheduledBackupInSkill((currentConfig) => ({
                            ...currentConfig,
                            timezone: event.target.value,
                          }))
                        }
                        placeholder="例如 Asia/Shanghai"
                        className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                      />
                    </label>
                  </div>
                  {scheduledBackupInSkill.preset === "custom-cron" ? (
                    <label className="grid gap-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Cron 表达式</span>
                      <input
                        type="text"
                        value={scheduledBackupInSkill.cronExpression}
                        onChange={(event) =>
                          setScheduledBackupInSkill((currentConfig) => ({
                            ...currentConfig,
                            cronExpression: event.target.value,
                          }))
                        }
                        placeholder="例如 0 3 * * *"
                        className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                      />
                    </label>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="grid gap-2">
                        <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">执行时间</span>
                        <input
                          type="time"
                          value={scheduledBackupInSkill.time}
                          onChange={(event) =>
                            setScheduledBackupInSkill((currentConfig) => ({
                              ...currentConfig,
                              time: event.target.value,
                            }))
                          }
                          className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                        />
                      </label>
                      {scheduledBackupInSkill.preset === "weekly" ? (
                        <label className="grid gap-2">
                          <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">每周几</span>
                          <select
                            value={scheduledBackupInSkill.dayOfWeek}
                            onChange={(event) =>
                              setScheduledBackupInSkill((currentConfig) => ({
                                ...currentConfig,
                                dayOfWeek: Number(event.target.value),
                              }))
                            }
                            className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                          >
                            <option value={1}>周一</option>
                            <option value={2}>周二</option>
                            <option value={3}>周三</option>
                            <option value={4}>周四</option>
                            <option value={5}>周五</option>
                            <option value={6}>周六</option>
                            <option value={7}>周日</option>
                          </select>
                        </label>
                      ) : null}
                      {scheduledBackupInSkill.preset === "monthly" ? (
                        <label className="grid gap-2">
                          <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">每月几号</span>
                          <input
                            type="number"
                            min={1}
                            max={28}
                            value={scheduledBackupInSkill.dayOfMonth}
                            onChange={(event) =>
                              setScheduledBackupInSkill((currentConfig) => ({
                                ...currentConfig,
                                dayOfMonth: Math.min(28, Math.max(1, Number(event.target.value) || 1)),
                              }))
                            }
                            className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                          />
                        </label>
                      ) : null}
                    </div>
                  )}
                  <div className="rounded-2xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:bg-zinc-950/50 dark:text-zinc-300">
                    当前定时策略：{buildScheduledBackupDescription(scheduledBackupInSkill)}
                  </div>
                </>
              ) : (
                <p className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">未预设定时备份。</p>
              )}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link
                href={skillLink}
                className="inline-flex items-center justify-center rounded-full bg-zinc-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                打开备份 Skill
              </Link>
              <Link
                href={restoreSkillLink}
                className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
              >
                打开恢复 Skill
              </Link>
            </div>
          </div>
          <div className="rounded-[24px] border border-dashed border-zinc-300 p-5 text-sm leading-6 text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <p>备份 Skill 链接</p>
            <p className="mt-2 break-all font-mono text-xs text-zinc-800 dark:text-zinc-200">{skillLink}</p>
            <p className="mt-4">恢复 Skill 链接</p>
            <p className="mt-2 break-all font-mono text-xs text-zinc-800 dark:text-zinc-200">{restoreSkillLink}</p>
            <p className="mt-4">新机器一键恢复命令</p>
            <p className="mt-2 break-all font-mono text-xs text-zinc-800 dark:text-zinc-200">{recoveryCommand}</p>
          </div>
        </div>

        <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">连接配置</h2>
          <dl className="grid gap-3 text-sm text-zinc-600 dark:text-zinc-300">
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Git 仓库</dt>
              <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.skillConfig.repository}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">备份分支</dt>
              <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.skillConfig.branch}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">ice-box-id</dt>
              <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.skillConfig.iceBoxId}</dd>
            </div>
            {iceBox.backupMode === "upload-token" ? (
              <>
                <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">上传地址</dt>
                  <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{uploadUrl ?? "未生成"}</dd>
                </div>
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">上传 Token</dt>
                  <dd className="mt-2 break-all font-mono text-xs text-amber-900 dark:text-amber-100">{iceBox.skillConfig.uploadToken}</dd>
                </div>
                <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">上传加密</dt>
                  <dd className="mt-2 text-sm text-zinc-900 dark:text-zinc-100">
                    {encryptionEnabled ? "已启用 AES-256-GCM / PBKDF2-SHA256" : "未启用"}
                  </dd>
                  {encryptionEnabled ? (
                    <>
                      <dd className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                        密钥策略：每次上传手动提供主密钥，默认不落盘保存。
                      </dd>
                      <dd className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                        KDF：{iceBox.skillConfig.encryption.kdf} / {iceBox.skillConfig.encryption.kdfIterations.toLocaleString("zh-CN")} 次
                      </dd>
                      <dd className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                        Salt：{iceBox.skillConfig.encryption.kdfSalt}
                      </dd>
                      {iceBox.skillConfig.encryption.keyHint ? (
                        <dd className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">密钥提示：{iceBox.skillConfig.encryption.keyHint}</dd>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </>
            ) : null}
          </dl>
        </div>
      </div>

      <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">备份历史</h2>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!iceBox) {
                return;
              }

              void loadHistory(iceBox.id, iceBox.machineId, iceBox.branch);
            }}
            disabled={!hasConfiguredRepository || isLoadingHistory}
            className="inline-flex items-center justify-center rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
          >
            {isLoadingHistory ? "正在刷新..." : "刷新历史"}
          </button>
        </div>

        {!hasConfiguredRepository ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            <p className="font-medium">还没配置 Git 仓库</p>
            <p className="mt-1 opacity-90">先回首页保存并测试仓库连接，备份历史才能从远端仓库读取。</p>
          </div>
        ) : null}

        {historyError && historyEntries.length === 0 && historyViewState === "error" ? (
          <div className="flex flex-col gap-3 rounded-3xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">备份历史加载失败</p>
              <p className="mt-1 opacity-90">{historyError.message}</p>
              {historyError.details ? <ResultDetails details={historyError.details} /> : null}
            </div>
            <button
              type="button"
              onClick={() => {
                if (!iceBox) {
                  return;
                }

                void loadHistory(iceBox.id, iceBox.machineId, iceBox.branch);
              }}
              className="rounded-full border border-rose-500/20 bg-white/70 px-4 py-2 font-medium transition hover:bg-white dark:bg-black/10 dark:hover:bg-black/20"
            >
              重试加载
            </button>
          </div>
        ) : null}

        {historyError && historyEntries.length > 0 ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            <p className="font-medium">已展示上次缓存的历史记录</p>
            <p className="mt-1 opacity-90">后台刷新这次没成功，你先用旧记录顶着，稍后再试。</p>
          </div>
        ) : null}

        {isLoadingHistory && historyEntries.length === 0 && historyViewState === "idle" ? (
          <div className="grid gap-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="rounded-[24px] border border-zinc-200/80 bg-white px-5 py-4 dark:border-white/10 dark:bg-white/5"
              >
                <div className="h-4 w-40 animate-pulse rounded-full bg-zinc-200 dark:bg-white/10" />
                <div className="mt-3 h-4 w-72 animate-pulse rounded-full bg-zinc-100 dark:bg-white/5" />
                <div className="mt-4 grid gap-2 sm:grid-cols-4">
                  <div className="h-4 animate-pulse rounded-full bg-zinc-100 dark:bg-white/5" />
                  <div className="h-4 animate-pulse rounded-full bg-zinc-100 dark:bg-white/5" />
                  <div className="h-4 animate-pulse rounded-full bg-zinc-100 dark:bg-white/5" />
                  <div className="h-4 animate-pulse rounded-full bg-zinc-100 dark:bg-white/5" />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!isLoadingHistory && hasConfiguredRepository && hasLoadedHistory && historyEntries.length === 0 && !historyError && historyViewState === "branch-missing" ? (
          <div className="grid gap-4 rounded-[24px] border border-dashed border-zinc-300 bg-white/60 p-8 text-center dark:border-white/10 dark:bg-white/5">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-2xl dark:bg-white/10">
              🧊
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">这个冰盒还没有备份历史</h3>
              <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                完成首次备份后会在这里显示，当前还没有创建出对应的远端备份分支。
              </p>
            </div>
          </div>
        ) : null}

        {!isLoadingHistory && hasConfiguredRepository && hasLoadedHistory && historyEntries.length === 0 && !historyError && historyViewState === "ready" ? (
          <div className="grid gap-4 rounded-[24px] border border-dashed border-zinc-300 bg-white/60 p-8 text-center dark:border-white/10 dark:bg-white/5">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-2xl dark:bg-white/10">
              📭
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">这个冰盒还没有备份历史</h3>
              <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                远端分支已经对上了，但还没扫到 commit。等第一次备份落到仓库后，这里就会显示历史列表。
              </p>
            </div>
          </div>
        ) : null}

        {isLoadingHistory && historyEntries.length > 0 ? (
          <div className="rounded-2xl border border-zinc-200/80 bg-white/70 px-4 py-3 text-sm text-zinc-600 dark:border-white/10 dark:bg-white/5 dark:text-zinc-300">
            正在后台刷新备份历史，列表会在拿到新结果后自动更新。
          </div>
        ) : null}

        {historyEntries.length > 0 ? (
          <div className="grid gap-3">
            {historyEntries.map((entry) => {
              const isSelected = selectedHistoryEntry?.commit === entry.commit;

              return (
                <div
                  key={entry.commit}
                  className={`rounded-[24px] border px-5 py-4 transition ${
                    isSelected
                      ? "border-sky-400/40 bg-sky-500/5 shadow-sm shadow-sky-500/10"
                      : "border-zinc-200/80 bg-white dark:border-white/10 dark:bg-white/5"
                  }`}
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">{entry.summary}</p>
                        <span className="rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 dark:border-white/10 dark:text-zinc-300">
                          {entry.branch}
                        </span>
                        {isSelected ? (
                          <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                            已选中恢复
                          </span>
                        ) : null}
                      </div>
                      <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">{entry.message}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleSelectHistoryEntry(entry)}
                        className="inline-flex items-center justify-center rounded-full border border-sky-500/30 bg-white px-4 py-2 text-sm font-medium text-sky-700 transition hover:border-sky-500 hover:bg-sky-500/5 dark:bg-black/10 dark:text-sky-300 dark:hover:bg-sky-500/10"
                      >
                        恢复这个版本
                      </button>
                    </div>
                  </div>

                  <dl className="mt-4 grid gap-3 text-sm text-zinc-600 dark:text-zinc-300 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">提交时间</dt>
                      <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{formatDateTime(entry.committedAt)}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">提交人</dt>
                      <dd className="mt-2 text-zinc-900 dark:text-zinc-100">{entry.authorName}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Commit Hash</dt>
                      <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{entry.commit}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">邮箱</dt>
                      <dd className="mt-2 break-all text-zinc-900 dark:text-zinc-100">{entry.authorEmail ?? "--"}</dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div id="restore-panel" className="grid gap-4 rounded-[24px] border border-sky-500/20 bg-sky-500/5 p-5 shadow-sm shadow-sky-500/5">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-sky-700 dark:text-sky-300">
              Restore
            </span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">两种备份方案都会统一回收到 Git 分支恢复</span>
          </div>
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">恢复冰盒备份</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="fridge-step-card">
              <div className="mb-2 flex items-center gap-3">
                <span className="fridge-step-number">1</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">先选快照</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">从“备份历史”里点选需要恢复的版本。</p>
            </div>
            <div className="fridge-step-card">
              <div className="mb-2 flex items-center gap-3">
                <span className="fridge-step-number">2</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">再看预览</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">确认目标目录、目标提交和覆盖前备份路径。</p>
            </div>
            <div className="fridge-step-card">
              <div className="mb-2 flex items-center gap-3">
                <span className="fridge-step-number">3</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">最后执行恢复</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">勾选确认后再执行，避免把错误快照恢复到错误目录。</p>
            </div>
          </div>
        </div>

        {selectedHistoryEntry ? (
          <div className="flex flex-col gap-3 rounded-3xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-sm text-sky-900 dark:text-sky-100 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">当前将恢复历史版本 {formatCommit(selectedHistoryEntry.commit)}</p>
              <p className="mt-1 opacity-90">
                {formatDateTime(selectedHistoryEntry.committedAt)} · {selectedHistoryEntry.authorName} · {selectedHistoryEntry.summary}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedHistoryEntry(null);
                setRestorePreview(null);
                setRestoreResult(null);
                setRestoreError(null);
              }}
              className="rounded-full border border-sky-500/20 bg-white/70 px-4 py-2 font-medium transition hover:bg-white dark:bg-black/10 dark:hover:bg-black/20"
            >
              改回最新快照
            </button>
          </div>
        ) : null}

        <div className="grid gap-4 rounded-[24px] bg-white/80 p-4 text-sm text-zinc-600 dark:bg-black/10 dark:text-zinc-300 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="grid gap-3">
            <label className="grid gap-2">
              <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">恢复目标目录</span>
              <input
                type="text"
                value={restoreTargetRootDir}
                onChange={(event) => {
                  setRestoreTargetRootDir(event.target.value);
                  setRestorePreview(null);
                  setRestoreResult(null);
                  setRestoreError(null);
                }}
                placeholder="例如 /Users/claw"
                className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">恢复来源</p>
                <p className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">
                  {selectedHistoryEntry
                    ? `${backupModeMeta.label} → 历史快照 ${formatCommit(selectedHistoryEntry.commit)}`
                    : `${backupModeMeta.label} → Git 分支最新快照`}
                </p>
              </div>
              <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">目标分支</p>
                <p className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.branch}</p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 rounded-[20px] border border-dashed border-sky-500/20 p-4">
            {!hasConfiguredRepository ? (
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                <p className="font-medium">还没配置 Git 仓库</p>
                <p className="mt-1 opacity-90">先回首页保存并测试仓库连接，恢复接口才能知道该去哪里拉取备份。</p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleRestorePreview()}
                disabled={!hasConfiguredRepository || isPreviewingRestore || isRestoring}
                className="inline-flex items-center justify-center rounded-full border border-sky-500/30 bg-white px-5 py-2.5 text-sm font-medium text-sky-700 transition hover:border-sky-500 hover:bg-sky-500/5 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-black/10 dark:text-sky-300 dark:hover:bg-sky-500/10"
              >
                {isPreviewingRestore ? "正在预览..." : "查看恢复预览"}
              </button>
              <button
                type="button"
                onClick={() => void handleRestore()}
                disabled={!canExecuteRestore}
                className="inline-flex items-center justify-center rounded-full bg-sky-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRestoring ? "正在恢复..." : "执行恢复"}
              </button>
            </div>
            <label className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 text-sm text-zinc-700 dark:bg-white/5 dark:text-zinc-200">
              <input
                type="checkbox"
                checked={confirmRestore}
                onChange={(event) => setConfirmRestore(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
              />
              <span>
                我确认把{selectedHistoryEntry ? `历史快照 ${formatCommit(selectedHistoryEntry.commit)}` : "该分支中的最新快照"}里的 `.openclaw` 恢复到上面的目标目录。
              </span>
            </label>
            {shouldConfirmOverwrite ? (
              <label className="flex items-start gap-3 rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                <input
                  type="checkbox"
                  checked={replaceExistingRestoreTarget}
                  onChange={(event) => setReplaceExistingRestoreTarget(event.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                />
                <span>目标目录里如果已经有 `.openclaw`，允许先备份旧目录再覆盖恢复。</span>
              </label>
            ) : null}
            {restoreHint ? (
              <div className="rounded-2xl border border-zinc-200/80 bg-white px-4 py-3 text-sm text-zinc-600 dark:border-white/10 dark:bg-white/5 dark:text-zinc-300">
                {restoreHint}
              </div>
            ) : null}
          </div>
        </div>

        {restoreError ? (
          <div className="rounded-3xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            <p className="font-medium">恢复失败</p>
            <p className="mt-1 opacity-90">{restoreError.message}</p>
            {restoreError.details ? <ResultDetails details={restoreError.details} /> : null}
          </div>
        ) : null}

        {restorePreview ? (
          <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
            <div className="rounded-[24px] bg-white/80 p-4 dark:bg-black/10">
              <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">当前恢复预览</h3>
              <dl className="mt-3 grid gap-3 text-sm text-zinc-600 dark:text-zinc-300">
                <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">分支</dt>
                  <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{restorePreview.selectedBranch?.branch ?? iceBox.branch}</dd>
                </div>
                <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">目标快照</dt>
                  <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">
                    {restorePreview.selectedBranch?.lastBackupAt
                      ? formatDateTime(restorePreview.selectedBranch.lastBackupAt)
                      : "当前还没有可恢复快照"}
                  </dd>
                </div>
                <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">目标提交</dt>
                  <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{formatCommit(restorePreview.selectedBranch?.lastCommit)}</dd>
                </div>
                <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">恢复路径</dt>
                  <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">
                    {restorePreview.restoredPath ?? "等待填写目标目录后生成"}
                  </dd>
                </div>
                {restorePreview.overwriteBackupPath ? (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                    <dt className="text-xs uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">覆盖前备份</dt>
                    <dd className="mt-2 break-all font-mono text-xs text-amber-900 dark:text-amber-100">{restorePreview.overwriteBackupPath}</dd>
                  </div>
                ) : null}
              </dl>
            </div>

            <div className="rounded-[24px] bg-white/80 p-4 dark:bg-black/10">
              <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">仓库里可恢复的分支</h3>
              <div className="mt-3 grid gap-3">
                {restorePreview.availableBranches?.length ? (
                  restorePreview.availableBranches.slice(0, 6).map((branchPreview) => (
                    <div key={branchPreview.branch} className="rounded-2xl bg-sky-500/5 px-4 py-3 text-sm text-zinc-600 dark:text-zinc-300">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{branchPreview.branch}</p>
                        <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                          {branchPreview.exists ? "可恢复" : "无快照"}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {branchPreview.lastBackupAt ? formatDateTime(branchPreview.lastBackupAt) : "暂无最近备份时间"}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{branchPreview.summary ?? "暂无提交说明"}</p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-zinc-300 px-4 py-5 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                    当前仓库里还没扫到任何 `ice-box/...` 可恢复分支。
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {restoreResult?.ok ? (
          <div className="rounded-3xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
            <p className="font-medium">恢复完成</p>
            <p className="mt-1 opacity-90">{restoreResult.message}</p>
            <div className="mt-3 grid gap-2 text-xs">
              <p>恢复分支：<span className="font-mono">{restoreResult.branch}</span></p>
              <p>恢复路径：<span className="font-mono">{restoreResult.restoredPath}</span></p>
              {restoreResult.previousPathBackup ? <p>旧目录备份：<span className="font-mono">{restoreResult.previousPathBackup}</span></p> : null}
              {restoreResult.commit ? <p>快照提交：<span className="font-mono">{formatCommit(restoreResult.commit)}</span></p> : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 rounded-[24px] border border-rose-500/20 bg-rose-500/5 p-5 shadow-sm shadow-rose-500/5">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-rose-700 dark:text-rose-300">
              Danger Zone
            </span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">删除后会从本地冰盒列表中移除</span>
          </div>
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">删除这个冰盒</h2>
        </div>

        <div className="grid gap-3 rounded-[24px] bg-white/80 p-4 text-sm text-zinc-600 dark:bg-black/10 dark:text-zinc-300 sm:grid-cols-2">
          <div className="rounded-2xl bg-rose-500/5 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">机器 ID</p>
            <p className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.machineId}</p>
          </div>
          <div className="rounded-2xl bg-rose-500/5 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">备份分支</p>
            <p className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.branch}</p>
          </div>
        </div>

        {deleteError ? (
          <div className="rounded-3xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            <p className="font-medium">删除失败</p>
            <p className="mt-1 opacity-90">{deleteError}</p>
          </div>
        ) : null}

        {confirmDelete ? (
          <div className="flex flex-col gap-4 rounded-[24px] border border-rose-500/20 bg-rose-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1 text-sm text-rose-700 dark:text-rose-300">
              <p className="font-medium">确定要删除「{iceBox.name}」吗？</p>
              <p>删除后会立刻从当前设备的冰盒列表消失。</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  setDeleteError(null);
                }}
                disabled={isDeleting}
                className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:border-zinc-300 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:text-zinc-200 dark:hover:border-white/20"
              >
                先等等
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={isDeleting}
                className="inline-flex items-center justify-center rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isDeleting ? "正在删除..." : "确认删除"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-dashed border-rose-500/20 p-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">从本地列表移除当前冰盒。</p>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center justify-center rounded-full border border-rose-500/30 bg-white px-5 py-2.5 text-sm font-medium text-rose-700 transition hover:border-rose-500 hover:bg-rose-500/5 dark:bg-black/10 dark:text-rose-300 dark:hover:bg-rose-500/10"
            >
              删除冰盒
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

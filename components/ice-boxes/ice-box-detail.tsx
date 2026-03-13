"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function ErrorBanner({ message, onRetry, t }: { message: string; onRetry: () => void; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="fridge-state fridge-state--error flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium">{t("detail.loadFailed")}</p>
        <p className="mt-1 opacity-90">{message}</p>
      </div>
      <button type="button" onClick={onRetry} className="fridge-button-secondary">
        {t("detail.retryLoad")}
      </button>
    </div>
  );
}

function ResultDetails({ details, t }: { details: string; t: ReturnType<typeof useTranslations> }) {
  return (
    <details className="mt-3 rounded-xl bg-black/5 p-3 text-xs leading-5 text-current dark:bg-black/20">
      <summary className="cursor-pointer font-medium">{t("common.viewDetails")}</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{details}</pre>
    </details>
  );
}

function CopyableCodeBlock({
  label,
  value,
  copied,
  onCopy,
  t,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-white/80 p-4 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium text-zinc-700 dark:text-zinc-200">{label}</p>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="mt-3 max-h-32 overflow-auto break-all rounded-2xl bg-zinc-50 p-3 font-mono text-xs whitespace-pre-wrap text-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200">
        {value}
      </pre>
    </div>
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
  const t = useTranslations();
  const mounted = useMounted();
  const router = useRouter();
  const gitConfig = useAppStore((state) => state.gitConfig);
  const startSilentRefresh = useAppStore((state) => state.startSilentRefresh);
  const finishSilentRefresh = useAppStore((state) => state.finishSilentRefresh);
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
  const [copiedField, setCopiedField] = useState<"skill" | "restore-skill" | "recovery-command" | null>(null);
  const historyEntriesRef = useRef<IceBoxHistoryEntry[]>([]);
  const historyViewStateRef = useRef<IceBoxHistoryViewState>("idle");
  const historyRequestKeyRef = useRef<string | null>(null);
  const hasCachedIceBox = iceBoxes.some((item) => item.id === id);

  useEffect(() => {
    historyEntriesRef.current = historyEntries;
  }, [historyEntries]);

  useEffect(() => {
    historyViewStateRef.current = historyViewState;
  }, [historyViewState]);

  useEffect(() => {
    if (!mounted || hasLoaded) {
      return;
    }

    void loadIceBoxes(gitConfig);
  }, [hasLoaded, loadIceBoxes, mounted, gitConfig]);

  useEffect(() => {
    if (!copiedField) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopiedField(null);
    }, 1800);

    return () => window.clearTimeout(timer);
  }, [copiedField]);

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
      return t("detail.restoreNeedGit");
    }

    if (!restoreTargetRootDir.trim()) {
      return t("detail.restoreNeedTarget");
    }

    if (!confirmRestore) {
      return t("detail.restoreNeedConfirm");
    }

    if (shouldConfirmOverwrite && !replaceExistingRestoreTarget) {
      return t("detail.restoreNeedOverwrite");
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
      setDeleteError(actionError instanceof Error ? actionError.message : t("detail.deleteFailed"));
      setIsDeleting(false);
      return;
    }

    setIsDeleting(false);
  }

  async function handleCopy(value: string, field: "skill" | "restore-skill" | "recovery-command") {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
    } catch {
      setCopiedField(null);
    }
  }

  const loadHistory = useCallback(async (targetIceBoxId: string, machineId: string, branch: string) => {
    const requestKey = `${targetIceBoxId}:${machineId}:${branch}`;

    if (historyRequestKeyRef.current === requestKey) {
      return;
    }

    historyRequestKeyRef.current = requestKey;
    const shouldShowSilentRefresh =
      historyEntriesRef.current.length > 0 || historyViewStateRef.current !== "idle";

    setIsLoadingHistory(true);
    setHistoryError(null);

    if (shouldShowSilentRefresh) {
      startSilentRefresh(t("detail.history"));
    }

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
            setHistoryError(toOperationNotice(result, t("detail.historyLoadFailed")));
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
      setHistoryError(toRequestFailureNotice(t("detail.historyLoadingWhile"), actionError));
      setHasLoadedHistory(true);
    } finally {
      historyRequestKeyRef.current = null;
      setIsLoadingHistory(false);
      if (shouldShowSilentRefresh) {
        finishSilentRefresh(t("detail.history"));
      }
    }
  }, [finishSilentRefresh, gitConfig, startSilentRefresh, syncIceBoxBackupState]);

  const iceBoxId = iceBox?.id;
  const iceBoxMachineId = iceBox?.machineId;
  const iceBoxBranch = iceBox?.branch;

  useEffect(() => {
    if (!mounted || !iceBoxId || !iceBoxMachineId || !iceBoxBranch || !hasConfiguredRepository) {
      return;
    }

    void loadHistory(iceBoxId, iceBoxMachineId, iceBoxBranch);
  }, [
    hasConfiguredRepository,
    historyRefreshNonce,
    iceBoxBranch,
    iceBoxId,
    iceBoxMachineId,
    loadHistory,
    mounted,
  ]);

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
        setRestoreError(toOperationNotice(result, t("detail.restorePreviewFailed")));
        return;
      }

      setRestorePreview(result);
      setReplaceExistingRestoreTarget(Boolean(result.targetExists));
    } catch (actionError) {
      setRestorePreview(null);
      setRestoreError(toRequestFailureNotice(t("detail.restorePreviewWhile"), actionError));
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
        setRestoreError(toOperationNotice(result, t("detail.restoreFailed")));
        return;
      }

      setRestorePreview(null);
      setConfirmRestore(false);
      syncIceBoxBackupState(iceBox.id, result.lastBackupAt ?? iceBox.lastBackupAt);
    } catch (actionError) {
      setRestoreResult(null);
      setRestoreError(toRequestFailureNotice(t("detail.restoreWhile"), actionError));
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
    setReminderNotice(t("detail.reminderSaved"));
  }

  function handleReminderReset() {
    if (!iceBox) {
      return;
    }

    resetIceBoxReminder(iceBox.id, gitConfig);
    setReminderNotice(t("detail.reminderReset"));
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
          <h1 className="text-2xl font-semibold">{t("detail.deletedTitle")}</h1>
          <p className="text-sm leading-6 opacity-90 sm:text-base">{t("detail.deletedDescription")}</p>
        </div>
      </section>
    );
  }

  if (!iceBox && error) {
    return (
      <section className="grid gap-5 rounded-[28px] border border-black/10 bg-white/90 p-8 shadow-sm shadow-black/5 dark:border-white/10 dark:bg-white/5">
        <ErrorBanner message={error} onRetry={() => void handleRetry()} t={t} />
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
          >
            {t("common.backToList")}
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
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.notFoundTitle")}</h1>
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400 sm:text-base">
            {t("detail.notFoundDescription")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
          >
            {t("common.backToList")}
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
  const headerChips = [
    {
      key: `backup-mode:${iceBox.backupMode}`,
      label: backupModeMeta.label,
      className: "fridge-chip fridge-chip--ocean",
    },
    {
      key: `sync-status:${iceBox.syncStatus}`,
      label: syncMeta.shortLabel,
      className: `fridge-chip ${iceBox.syncStatus === "synced" ? "fridge-chip--success" : "fridge-chip--warning"}`,
    },
  ];

  return (
    <section className="grid gap-6">
      <div className={embedded ? "grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/60 p-5 dark:border-white/10 dark:bg-zinc-950/30" : "fridge-hero"}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {!embedded ? (
              <Link href="/" className="fridge-button-ghost px-0 py-0">
                ← {t("common.backToList")}
              </Link>
            ) : null}
            {headerChips.map((chip) => (
              <span key={chip.key} className={chip.className}>
                {chip.label}
              </span>
            ))}
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
              {isSyncingToRemote ? t("detail.syncing") : t("detail.syncNow")}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={() => void handleRetry()} t={t} /> : null}

      {iceBox.syncStatus !== "synced" ? (
        <div className="fridge-state fridge-state--warning grid gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">{t("detail.localOnlyTitle")}</p>
              <p className="mt-1 opacity-90">{syncMeta.description}</p>
            </div>
            <button type="button" onClick={() => void handleSyncToRemote()} className="fridge-button-secondary" disabled={isSyncingToRemote}>
              {isSyncingToRemote ? t("detail.syncing") : t("detail.syncNow")}
            </button>
          </div>
          {iceBox.lastSyncError ? <ResultDetails details={iceBox.lastSyncError} t={t} /> : null}
        </div>
      ) : null}

      {syncNotice ? (
        <div className={`fridge-state ${syncNotice.tone === "success" ? "fridge-state--success" : "fridge-state--warning"}`}>
          <p className="font-medium">{syncNotice.message}</p>
          {syncNotice.details ? <ResultDetails details={syncNotice.details} t={t} /> : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.basicInfo")}</h2>
          <dl className="grid gap-3 text-sm text-zinc-600 dark:text-zinc-300 sm:grid-cols-2">
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.iceBoxName")}</dt>
              <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{iceBox.name}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.machineId")}</dt>
              <dd className="mt-2 font-mono text-xs text-zinc-800 dark:text-zinc-200">{iceBox.machineId}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.branchName")}</dt>
              <dd className="mt-2 font-mono text-xs text-zinc-800 dark:text-zinc-200">{iceBox.branch}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.backupMode")}</dt>
              <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{backupModeMeta.label}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5 sm:col-span-2">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.repository")}</dt>
              <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.skillConfig.repository}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.backupBranch")}</dt>
              <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.skillConfig.branch}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.iceBoxId")}</dt>
              <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.skillConfig.iceBoxId}</dd>
            </div>
            {iceBox.backupMode === "upload-token" ? (
              <>
                <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5 sm:col-span-2">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.uploadUrl")}</dt>
                  <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{uploadUrl ?? t("common.notGenerated")}</dd>
                </div>
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">{t("detail.uploadToken")}</dt>
                  <dd className="mt-2 break-all font-mono text-xs text-amber-900 dark:text-amber-100">{iceBox.skillConfig.uploadToken}</dd>
                </div>
                <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.encryptionInfo")}</dt>
                  <dd className="mt-2 text-sm text-zinc-900 dark:text-zinc-100">
                    {encryptionEnabled ? t("detail.encryptionEnabled") : t("common.disabled")}
                  </dd>
                  {encryptionEnabled ? (
                    <>
                      <dd className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                        {t("detail.kdfLabel")}{iceBox.skillConfig.encryption.kdf} / {iceBox.skillConfig.encryption.kdfIterations.toLocaleString("zh-CN")} {t("detail.iterationsUnit")}
                      </dd>
                      <dd className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{t("detail.saltLabel")}{iceBox.skillConfig.encryption.kdfSalt}</dd>
                      {iceBox.skillConfig.encryption.keyHint ? (
                        <dd className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{t("detail.keyHintLabel")}{iceBox.skillConfig.encryption.keyHint}</dd>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.uploadEncryption")}</dt>
                <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{t("common.disabled")}</dd>
              </div>
            )}
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.remoteSyncStatus")}</dt>
              <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{syncMeta.label}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.lastRemoteSync")}</dt>
              <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{formatDateTime(iceBox.lastSyncAt)}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.createdAt")}</dt>
              <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{formatDateTime(iceBox.createdAt)}</dd>
            </div>
            <div className="rounded-2xl bg-white px-4 py-3 dark:bg-white/5">
              <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.updatedAt")}</dt>
              <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{formatDateTime(iceBox.updatedAt)}</dd>
            </div>
          </dl>
        </div>

        <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.status")}</h2>
          <div className="rounded-[24px] bg-white p-5 dark:bg-white/5">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("detail.lastBackupTime")}</p>
            <p className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
              {formatLastBackupTime(effectiveLastBackupAt)}
            </p>
          </div>
          <div className="grid gap-3 rounded-[24px] border border-zinc-200/80 bg-white p-4 dark:border-white/10 dark:bg-white/5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("detail.scheduledReminder")}</p>
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
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.reminderConfig")}</dt>
                <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{reminderSnapshot.configLabel}</dd>
              </div>
              <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.nextReminder")}</dt>
                <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">
                  {formatDateTime(reminderSnapshot.nextReminderAt)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="grid gap-4 rounded-[24px] border border-dashed border-zinc-300 p-5 text-sm leading-6 text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">{t("detail.reminderConfig")}</p>
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
                {t("detail.enableReminder")}
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.reminderCadence")}</span>
                <select
                  value={effectiveReminder.preset}
                  onChange={(event) => handleReminderPresetChange(event.target.value as IceBoxReminderPreset)}
                  className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                >
                  <option value="daily">{t("detail.reminderPresetDaily")}</option>
                  <option value="every-3-days">{t("detail.reminderPresetEvery3Days")}</option>
                  <option value="weekly">{t("detail.reminderPresetWeekly")}</option>
                  <option value="custom">{t("detail.reminderPresetCustom")}</option>
                </select>
              </label>
              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.graceWindowHours")}</span>
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
                <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.customReminderIntervalHours")}</span>
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
                {t("detail.reminderCurrentSelection", { label: getIceBoxReminderPresetMeta(effectiveReminder.preset).label, hours: effectiveReminder.intervalHours })}
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
                {t("detail.saveReminderConfig")}
              </button>
              <button
                type="button"
                onClick={handleReminderReset}
                className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
              >
                {t("detail.resetToDefault")}
              </button>
            </div>

          </div>
        </div>
      </div>

      <div className="grid gap-4">
        <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.skillDocument")}</h2>
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
              {t("detail.includeGitCredentialPlaceholders")}
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
                {t("detail.scheduledBackup")}
              </label>
              {scheduledBackupInSkill.enabled ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.scheduleType")}</span>
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
                        <option value="daily">{t("detail.schedulePresetDaily")}</option>
                        <option value="weekly">{t("detail.schedulePresetWeekly")}</option>
                        <option value="monthly">{t("detail.schedulePresetMonthly")}</option>
                        <option value="custom-cron">{t("detail.schedulePresetCustomCron")}</option>
                      </select>
                    </label>
                    <label className="grid gap-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.timezone")}</span>
                      <input
                        type="text"
                        value={scheduledBackupInSkill.timezone}
                        onChange={(event) =>
                          setScheduledBackupInSkill((currentConfig) => ({
                            ...currentConfig,
                            timezone: event.target.value,
                          }))
                        }
                        placeholder={t("detail.timezonePlaceholder")}
                        className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                      />
                    </label>
                  </div>
                  {scheduledBackupInSkill.preset === "custom-cron" ? (
                    <label className="grid gap-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.cronExpression")}</span>
                      <input
                        type="text"
                        value={scheduledBackupInSkill.cronExpression}
                        onChange={(event) =>
                          setScheduledBackupInSkill((currentConfig) => ({
                            ...currentConfig,
                            cronExpression: event.target.value,
                          }))
                        }
                        placeholder={t("detail.cronPlaceholder")}
                        className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
                      />
                    </label>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="grid gap-2">
                        <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.executionTime")}</span>
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
                          <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.dayOfWeek")}</span>
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
                            <option value={1}>{t("detail.weekday1")}</option>
                            <option value={2}>{t("detail.weekday2")}</option>
                            <option value={3}>{t("detail.weekday3")}</option>
                            <option value={4}>{t("detail.weekday4")}</option>
                            <option value={5}>{t("detail.weekday5")}</option>
                            <option value={6}>{t("detail.weekday6")}</option>
                            <option value={7}>{t("detail.weekday7")}</option>
                          </select>
                        </label>
                      ) : null}
                      {scheduledBackupInSkill.preset === "monthly" ? (
                        <label className="grid gap-2">
                          <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.dayOfMonth")}</span>
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
                    {t("detail.currentSchedulePolicy", { description: buildScheduledBackupDescription(scheduledBackupInSkill) })}
                  </div>
                </>
              ) : (
                <p className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">{t("detail.noScheduledBackupPreset")}</p>
              )}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link
                href={skillLink}
                className="inline-flex items-center justify-center rounded-full bg-zinc-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                {t("detail.openBackupSkill")}
              </Link>
              <Link
                href={restoreSkillLink}
                className="inline-flex items-center justify-center rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-zinc-200 dark:hover:border-sky-500 dark:hover:text-sky-300"
              >
                {t("detail.openRestoreSkill")}
              </Link>
            </div>
          </div>
          <div className="grid gap-3 rounded-[24px] border border-dashed border-zinc-300 p-5 text-sm leading-6 text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <CopyableCodeBlock
              label={t("detail.backupSkillLink")}
              value={skillLink}
              copied={copiedField === "skill"}
              onCopy={() => void handleCopy(skillLink, "skill")}
              t={t}
            />
            <CopyableCodeBlock
              label={t("detail.restoreSkillLink")}
              value={restoreSkillLink}
              copied={copiedField === "restore-skill"}
              onCopy={() => void handleCopy(restoreSkillLink, "restore-skill")}
              t={t}
            />
            <CopyableCodeBlock
              label={t("detail.recoveryCommand")}
              value={recoveryCommand}
              copied={copiedField === "recovery-command"}
              onCopy={() => void handleCopy(recoveryCommand, "recovery-command")}
              t={t}
            />
            {copiedField ? (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
                {t("common.copied")}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 rounded-[24px] border border-zinc-200/80 bg-zinc-50/70 p-5 dark:border-white/10 dark:bg-zinc-950/40">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.history")}</h2>
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
            {isLoadingHistory ? t("detail.refreshing") : t("detail.refreshHistory")}
          </button>
        </div>

        {!hasConfiguredRepository ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            <p className="font-medium">{t("detail.gitRepoNotConfigured")}</p>
            <p className="mt-1 opacity-90">{t("detail.historyNeedGit")}</p>
          </div>
        ) : null}

        {historyError && historyEntries.length === 0 && historyViewState === "error" ? (
          <div className="flex flex-col gap-3 rounded-3xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">{t("detail.historyLoadFailed")}</p>
              <p className="mt-1 opacity-90">{historyError.message}</p>
              {historyError.details ? <ResultDetails details={historyError.details} t={t} /> : null}
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
              {t("detail.retryLoad")}
            </button>
          </div>
        ) : null}

        {historyError && historyEntries.length > 0 ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            <p className="font-medium">{t("detail.showingCachedHistory")}</p>
            <p className="mt-1 opacity-90">{t("detail.cachedHistoryDescription")}</p>
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
              <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.noHistoryTitle")}</h3>
              <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {t("detail.noHistoryBranchDescription")}
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
              <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.noHistoryTitle")}</h3>
              <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {t("detail.noHistoryReadyDescription")}
              </p>
            </div>
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
                            {t("detail.selectedForRestore")}
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
                        {t("detail.restoreThisVersion")}
                      </button>
                    </div>
                  </div>

                  <dl className="mt-4 grid gap-3 text-sm text-zinc-600 dark:text-zinc-300 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.commitTime")}</dt>
                      <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{formatDateTime(entry.committedAt)}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.commitAuthor")}</dt>
                      <dd className="mt-2 text-zinc-900 dark:text-zinc-100">{entry.authorName}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.commitHash")}</dt>
                      <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{entry.commit}</dd>
                    </div>
                    <div className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-zinc-950/50">
                      <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.email")}</dt>
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
              {t("detail.restoreBadge")}
            </span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">{t("detail.restorePanelBadgeDescription")}</span>
          </div>
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.restoreIceBoxBackup")}</h2>
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            {t("detail.restoreDescription")}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="fridge-step-card">
              <div className="mb-2 flex items-center gap-3">
                <span className="fridge-step-number">1</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.restoreStep1Title")}</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">{t("detail.restoreStep1Description")}</p>
            </div>
            <div className="fridge-step-card">
              <div className="mb-2 flex items-center gap-3">
                <span className="fridge-step-number">2</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.restoreStep2Title")}</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">{t("detail.restoreStep2Description")}</p>
            </div>
            <div className="fridge-step-card">
              <div className="mb-2 flex items-center gap-3">
                <span className="fridge-step-number">3</span>
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.restoreStep3Title")}</p>
              </div>
              <p className="text-zinc-600 dark:text-zinc-300">{t("detail.restoreStep3Description")}</p>
            </div>
          </div>
        </div>

        {selectedHistoryEntry ? (
          <div className="flex flex-col gap-3 rounded-3xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-sm text-sky-900 dark:text-sky-100 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">{t("detail.restoringHistoryVersion", { commit: formatCommit(selectedHistoryEntry.commit) })}</p>
              <p className="mt-1 opacity-90">
                {t("detail.restoreHistoryVersionMeta", { time: formatDateTime(selectedHistoryEntry.committedAt), author: selectedHistoryEntry.authorName, summary: selectedHistoryEntry.summary })}
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
              {t("detail.switchToLatestSnapshot")}
            </button>
          </div>
        ) : null}

        <div className="grid gap-4 rounded-[24px] bg-white/80 p-4 text-sm text-zinc-600 dark:bg-black/10 dark:text-zinc-300 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="grid gap-3">
            <label className="grid gap-2">
              <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.restoreTargetDirectory")}</span>
              <input
                type="text"
                value={restoreTargetRootDir}
                onChange={(event) => {
                  setRestoreTargetRootDir(event.target.value);
                  setRestorePreview(null);
                  setRestoreResult(null);
                  setRestoreError(null);
                }}
                placeholder={t("detail.restoreTargetPlaceholder")}
                className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-sky-400 dark:border-white/10 dark:bg-white/5 dark:text-zinc-100"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.restoreSource")}</p>
                <p className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">
                  {selectedHistoryEntry
                    ? t("detail.restoreSourceHistory", { mode: backupModeMeta.label, commit: formatCommit(selectedHistoryEntry.commit) })
                    : t("detail.restoreSourceLatest", { mode: backupModeMeta.label })}
                </p>
              </div>
              <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.targetBranch")}</p>
                <p className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.branch}</p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 rounded-[20px] border border-dashed border-sky-500/20 p-4">
            {!hasConfiguredRepository ? (
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                <p className="font-medium">{t("detail.gitRepoNotConfigured")}</p>
                <p className="mt-1 opacity-90">{t("detail.restoreNeedGit")}</p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleRestorePreview()}
                disabled={!hasConfiguredRepository || isPreviewingRestore || isRestoring}
                className="inline-flex items-center justify-center rounded-full border border-sky-500/30 bg-white px-5 py-2.5 text-sm font-medium text-sky-700 transition hover:border-sky-500 hover:bg-sky-500/5 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-black/10 dark:text-sky-300 dark:hover:bg-sky-500/10"
              >
                {isPreviewingRestore ? t("detail.previewing") : t("detail.viewRestorePreview")}
              </button>
              <button
                type="button"
                onClick={() => void handleRestore()}
                disabled={!canExecuteRestore}
                className="inline-flex items-center justify-center rounded-full bg-sky-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRestoring ? t("detail.restoring") : t("detail.executeRestore")}
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
                {t("detail.confirmRestoreText", {
                  source: selectedHistoryEntry
                    ? t("detail.historySnapshotWithCommit", { commit: formatCommit(selectedHistoryEntry.commit) })
                    : t("detail.latestSnapshotInBranch"),
                })}
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
                <span>{t("detail.overwriteConfirmation")}</span>
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
            <p className="font-medium">{t("detail.restoreFailedTitle")}</p>
            <p className="mt-1 opacity-90">{restoreError.message}</p>
            {restoreError.details ? <ResultDetails details={restoreError.details} t={t} /> : null}
          </div>
        ) : null}

        {restorePreview ? (
          <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
            <div className="rounded-[24px] bg-white/80 p-4 dark:bg-black/10">
              <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.currentRestorePreview")}</h3>
              <dl className="mt-3 grid gap-3 text-sm text-zinc-600 dark:text-zinc-300">
                <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.branch")}</dt>
                  <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{restorePreview.selectedBranch?.branch ?? iceBox.branch}</dd>
                </div>
                <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.targetSnapshot")}</dt>
                  <dd className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">
                    {restorePreview.selectedBranch?.lastBackupAt
                      ? formatDateTime(restorePreview.selectedBranch.lastBackupAt)
                      : t("detail.noRestorableSnapshot")}
                  </dd>
                </div>
                <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.targetCommit")}</dt>
                  <dd className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{formatCommit(restorePreview.selectedBranch?.lastCommit)}</dd>
                </div>
                <div className="rounded-2xl bg-sky-500/5 px-4 py-3">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.restorePath")}</dt>
                  <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">
                    {restorePreview.restoredPath ?? t("detail.awaitingRestorePath")}
                  </dd>
                </div>
                {restorePreview.overwriteBackupPath ? (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                    <dt className="text-xs uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">{t("detail.preOverwriteBackup")}</dt>
                    <dd className="mt-2 break-all font-mono text-xs text-amber-900 dark:text-amber-100">{restorePreview.overwriteBackupPath}</dd>
                  </div>
                ) : null}
              </dl>
            </div>

            <div className="rounded-[24px] bg-white/80 p-4 dark:bg-black/10">
              <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.restorableBranches")}</h3>
              <div className="mt-3 grid gap-3">
                {restorePreview.availableBranches?.length ? (
                  restorePreview.availableBranches.slice(0, 6).map((branchPreview) => (
                    <div key={branchPreview.branch} className="rounded-2xl bg-sky-500/5 px-4 py-3 text-sm text-zinc-600 dark:text-zinc-300">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{branchPreview.branch}</p>
                        <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                          {branchPreview.exists ? t("detail.restorable") : t("detail.noSnapshot")}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {branchPreview.lastBackupAt ? formatDateTime(branchPreview.lastBackupAt) : t("detail.noRecentBackupTime")}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{branchPreview.summary ?? t("detail.noCommitSummary")}</p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-zinc-300 px-4 py-5 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                    {t("detail.noRestorableBranches")}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {restoreResult?.ok ? (
          <div className="rounded-3xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
            <p className="font-medium">{t("detail.restoreCompleted")}</p>
            <p className="mt-1 opacity-90">{restoreResult.message}</p>
            <div className="mt-3 grid gap-2 text-xs">
              <p>{t("detail.restoredBranch")}<span className="font-mono">{restoreResult.branch}</span></p>
              <p>{t("detail.restoredPath")}<span className="font-mono">{restoreResult.restoredPath}</span></p>
              {restoreResult.previousPathBackup ? <p>{t("detail.previousBackupPath")}<span className="font-mono">{restoreResult.previousPathBackup}</span></p> : null}
              {restoreResult.commit ? <p>{t("detail.snapshotCommit")}<span className="font-mono">{formatCommit(restoreResult.commit)}</span></p> : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 rounded-[24px] border border-rose-500/20 bg-rose-500/5 p-5 shadow-sm shadow-rose-500/5">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-rose-700 dark:text-rose-300">
              {t("detail.dangerZone")}
            </span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">{t("detail.deleteDescription")}</span>
          </div>
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("detail.deleteThisIceBox")}</h2>
        </div>

        <div className="grid gap-3 rounded-[24px] bg-white/80 p-4 text-sm text-zinc-600 dark:bg-black/10 dark:text-zinc-300 sm:grid-cols-2">
          <div className="rounded-2xl bg-rose-500/5 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.machineId")}</p>
            <p className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.machineId}</p>
          </div>
          <div className="rounded-2xl bg-rose-500/5 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.backupBranch")}</p>
            <p className="mt-2 font-mono text-xs text-zinc-900 dark:text-zinc-100">{iceBox.branch}</p>
          </div>
        </div>

        {deleteError ? (
          <div className="rounded-3xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            <p className="font-medium">{t("detail.deleteFailedTitle")}</p>
            <p className="mt-1 opacity-90">{deleteError}</p>
          </div>
        ) : null}

        {confirmDelete ? (
          <div className="flex flex-col gap-4 rounded-[24px] border border-rose-500/20 bg-rose-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1 text-sm text-rose-700 dark:text-rose-300">
              <p className="font-medium">{t("detail.confirmDeleteTitle", { name: iceBox.name })}</p>
              <p>{t("detail.confirmDeleteDescription")}</p>
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
                {t("detail.waitAMoment")}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={isDeleting}
                className="inline-flex items-center justify-center rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isDeleting ? t("detail.deleting") : t("detail.confirmDelete")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-dashed border-rose-500/20 p-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{t("detail.removeFromLocalList")}</p>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center justify-center rounded-full border border-rose-500/30 bg-white px-5 py-2.5 text-sm font-medium text-rose-700 transition hover:border-rose-500 hover:bg-rose-500/5 dark:bg-black/10 dark:text-rose-300 dark:hover:bg-rose-500/10"
            >
              {t("detail.deleteIceBox")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

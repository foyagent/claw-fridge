"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useAppStore } from "@/store/app-store";
import { createDisabledEncryptionConfig } from "@/lib/backup-encryption";
import { getApiRequestHeaders, readApiPayload, toOperationNotice, toRequestFailureNotice } from "@/lib/api-client";
import {
  addIceBox,
  deleteIceBox as deleteIceBoxFromGitClient,
  listIceBoxes,
  syncIceBoxBranch,
  updateIceBox,
} from "@/lib/git-client";
import {
  createDefaultIceBoxReminderConfig,
  normalizeIceBoxReminderConfig,
} from "@/lib/ice-box-reminders";
import { iceBoxBranchPrefix } from "@/lib/git";
import { normalizeGitConfig } from "@/lib/git-config";
import { createDefaultScheduledBackupConfig, normalizeScheduledBackupConfig } from "@/lib/ice-boxes";
import type {
  CreateIceBoxResult,
  CreateUploadTokenResult,
  GitRepositoryConfig,
  IceBoxHistoryResult,
  IceBoxListItem,
  IceBoxRecord,
  IceBoxStoreState,
  IceBoxSyncStatus,
  SyncIceBoxResult,
  SyncPendingIceBoxesResult,
} from "@/types";
import { tr } from "@/lib/client-translations";

interface PersistedIceBoxStoreState {
  iceBoxes: IceBoxListItem[];
}

interface IceBoxesSyncResult {
  ok: boolean;
  message: string;
  details?: string;
  syncedAt: string;
  items?: IceBoxRecord[];
  item?: IceBoxRecord;
  commit?: string;
  errorCode?: string;
  statusCode?: number;
}

function isCorsError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("cors") || msg.includes("failed to fetch") || msg.includes("network request failed");
}

async function withCorsFallback<T>(frontendFn: () => Promise<T>, backendFn: () => Promise<T>): Promise<T> {
  try {
    return await frontendFn();
  } catch (error) {
    if (isCorsError(error)) {
      console.warn("CORS detected, falling back to backend API", error);
      return backendFn();
    }

    throw error;
  }
}

const defaultState = {
  iceBoxes: [],
  hasHydrated: false,
  hasLoaded: false,
  isLoading: false,
  isCreating: false,
  error: null,
};

function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function readGitUsername(authMethod: ReturnType<typeof normalizeGitConfig>["auth"]): string | null {
  if (authMethod.method === "https-token" || authMethod.method === "ssh-key") {
    return authMethod.username.trim() || null;
  }

  return null;
}

function createIceBoxResult(message: string, details?: string): CreateIceBoxResult {
  return {
    ok: false,
    message,
    details,
    createdAt: new Date().toISOString(),
  };
}

function createSyncIceBoxResult(message: string, details?: string): SyncIceBoxResult {
  return {
    ok: false,
    message,
    details,
    syncedAt: new Date().toISOString(),
  };
}

function createSyncPendingIceBoxesResult(
  message: string,
  syncedCount = 0,
  failedIds: string[] = [],
  details?: string,
): SyncPendingIceBoxesResult {
  return {
    ok: false,
    message,
    details,
    syncedAt: new Date().toISOString(),
    syncedCount,
    failedIds,
  };
}

function normalizeSyncStatus(syncStatus: IceBoxSyncStatus | undefined): IceBoxSyncStatus {
  if (syncStatus === "pending-sync" || syncStatus === "sync-failed" || syncStatus === "synced") {
    return syncStatus;
  }

  return "synced";
}

function normalizeIceBoxItem(item: IceBoxListItem): IceBoxListItem {
  return {
    ...item,
    syncStatus: normalizeSyncStatus(item.syncStatus),
    lastSyncAt: item.lastSyncAt ?? null,
    lastSyncError: item.lastSyncError ?? null,
    deletedAt: item.deletedAt ?? null,
    reminder: normalizeIceBoxReminderConfig(item.reminder, item.updatedAt || item.createdAt),
    skillConfig: {
      ...item.skillConfig,
      scheduledBackup: normalizeScheduledBackupConfig(item.skillConfig.scheduledBackup),
      encryption: item.skillConfig.encryption ?? createDisabledEncryptionConfig(item.updatedAt),
    },
  };
}

function recordToListItem(record: IceBoxRecord): IceBoxListItem {
  return normalizeIceBoxItem({
    ...record,
    syncStatus: normalizeSyncStatus(record.syncStatus),
    lastSyncAt: record.lastSyncAt ?? null,
    lastSyncError: record.lastSyncError ?? null,
    deletedAt: record.deletedAt ?? null,
    status: "attention",
    lastBackupAt: null,
  });
}

function listItemToRecord(item: IceBoxListItem): IceBoxRecord {
  return {
    id: item.id,
    name: item.name,
    machineId: item.machineId,
    branch: item.branch,
    backupMode: item.backupMode,
    uploadPath: item.uploadPath,
    uploadToken: item.uploadToken,
    reminder: item.reminder,
    skillConfig: item.skillConfig,
    syncStatus: item.syncStatus,
    lastSyncAt: item.lastSyncAt,
    lastSyncError: item.lastSyncError,
    deletedAt: item.deletedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function markIceBoxSyncState(
  item: IceBoxListItem,
  syncStatus: IceBoxSyncStatus,
  syncedAt: string | null,
  syncError: string | null,
): IceBoxListItem {
  return normalizeIceBoxItem({
    ...item,
    syncStatus,
    lastSyncAt: syncedAt,
    lastSyncError: syncError,
  });
}

function applyIceBoxBackupState(item: IceBoxListItem, lastBackupAt: string | null): IceBoxListItem {
  return normalizeIceBoxItem({
    ...item,
    lastBackupAt,
    status: lastBackupAt ? "healthy" : "attention",
  });
}

async function fetchLatestBackupAt(item: IceBoxListItem, gitConfig: GitRepositoryConfig): Promise<string | null> {
  try {
    const response = await fetch(`/api/ice-boxes/${item.id}/history`, {
      method: "POST",
      headers: getApiRequestHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        machineId: item.machineId,
        branch: item.branch,
        gitConfig,
        limit: 1,
      }),
    });
    const result = await readApiPayload<IceBoxHistoryResult>(response);

    if (!response.ok || !result.ok) {
      return item.lastBackupAt;
    }

    return result.entries?.[0]?.committedAt ?? null;
  } catch {
    return item.lastBackupAt;
  }
}

function mergeIceBoxWithCachedBackupState(item: IceBoxListItem, cachedItem?: IceBoxListItem): IceBoxListItem {
  if (!cachedItem) {
    return normalizeIceBoxItem(item);
  }

  return normalizeIceBoxItem({
    ...item,
    lastBackupAt: cachedItem.lastBackupAt,
    status: cachedItem.lastBackupAt ? "healthy" : item.status,
  });
}

async function syncIceBoxWithRemote(
  item: IceBoxListItem,
  gitConfig: GitRepositoryConfig,
): Promise<SyncIceBoxResult> {
  const normalizedGitConfig = normalizeGitConfig(gitConfig);

  if (!normalizedGitConfig.repository) {
    return createSyncIceBoxResult(tr("clientIceBox.needGitConfigBeforeSync"));
  }

  try {
    const payload = await withCorsFallback(
      async () => {
        const preparedItem: IceBoxRecord = {
          ...listItemToRecord(item),
          syncStatus: "synced",
          lastSyncAt: new Date().toISOString(),
          lastSyncError: null,
        };
        const createResult = await addIceBox(normalizedGitConfig, preparedItem);

        if (!createResult.ok && createResult.message.includes(tr("clientGit.iceBoxExists", { id: item.id }))) {
          const syncResult = await syncIceBoxBranch(normalizedGitConfig, item.id);
          return {
            ok: syncResult.ok,
            message: syncResult.message,
            details: syncResult.details,
            syncedAt: syncResult.syncedAt,
            commit: syncResult.commit,
            item: syncResult.item,
            items: syncResult.items,
          } satisfies IceBoxesSyncResult;
        }

        return createResult;
      },
      async () => {
        const response = await fetch(`/api/ice-boxes/${item.id}/sync`, {
          method: "POST",
          headers: getApiRequestHeaders({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            gitConfig: normalizedGitConfig,
            item,
          }),
        });

        return readApiPayload<IceBoxesSyncResult>(response);
      },
    );

    if (!payload.ok) {
      return {
        ok: false,
        message: payload.message || tr("clientIceBox.syncFailed"),
        details: payload.details,
        syncedAt: payload.syncedAt ?? new Date().toISOString(),
      };
    }

    return {
      ok: true,
      message: payload.message,
      details: payload.details,
      syncedAt: payload.syncedAt,
      commit: payload.commit,
      item: payload.item ? recordToListItem(payload.item) : undefined,
    };
  } catch (error) {
    const notice = toRequestFailureNotice(tr("clientIceBox.syncingToRemoteWhile"), error);

    return {
      ok: false,
      message: notice.message,
      details: notice.details,
      syncedAt: new Date().toISOString(),
    };
  }
}

export const useIceBoxStore = create<IceBoxStoreState>()(
  persist(
    (set, get) => ({
      ...defaultState,
      setHydrated: (hasHydrated) => set({ hasHydrated }),
      loadIceBoxes: async (gitConfig: GitRepositoryConfig) => {
        if (get().isLoading) {
          return;
        }

        const shouldShowSilentRefresh = get().iceBoxes.length > 0 || get().hasLoaded;

        set({ isLoading: true, error: null });

        if (shouldShowSilentRefresh) {
          useAppStore.getState().startSilentRefresh(tr("clientIceBox.iceBoxList"));
        }

        const normalizedGitConfig = normalizeGitConfig(gitConfig);

        if (!normalizedGitConfig.repository) {
          set({
            iceBoxes: [],
            hasLoaded: true,
            isLoading: false,
            error: null,
          });
          if (shouldShowSilentRefresh) {
            useAppStore.getState().finishSilentRefresh(tr("clientIceBox.iceBoxList"));
          }
          return;
        }

        try {
          const remoteIceBoxes = await withCorsFallback(
            () => listIceBoxes(normalizedGitConfig),
            async () => {
              const response = await fetch("/api/ice-boxes/list", {
                method: "POST",
                headers: getApiRequestHeaders({
                  "Content-Type": "application/json",
                }),
                body: JSON.stringify({
                  gitConfig: normalizedGitConfig,
                }),
              });

              const payload = await readApiPayload<IceBoxesSyncResult>(response);

              if (!response.ok || !payload.ok) {
                throw new Error(payload.details ?? payload.message ?? tr("clientIceBox.loadListFailed"));
              }

              return (payload.items ?? []).map(recordToListItem);
            },
          );

          const mergedIceBoxes = new Map(
            remoteIceBoxes.map((item) => {
              const cachedItem = get().iceBoxes.find((localItem) => localItem.id === item.id);
              return [item.id, mergeIceBoxWithCachedBackupState(item, cachedItem)] as const;
            }),
          );

          for (const localItem of get().iceBoxes) {
            if (localItem.syncStatus !== "synced" && !mergedIceBoxes.has(localItem.id)) {
              mergedIceBoxes.set(localItem.id, normalizeIceBoxItem(localItem));
            }
          }

          set({
            iceBoxes: Array.from(mergedIceBoxes.values()).sort((left, right) =>
              new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime(),
            ),
            hasLoaded: true,
            isLoading: false,
            error: null,
          });

          void get().refreshIceBoxBackupStates(normalizedGitConfig);
        } catch (error) {
          console.warn("Failed to load ice boxes from GitHub:", error);
          set({
            hasLoaded: true,
            isLoading: false,
            error: null,
          });
        } finally {
          if (shouldShowSilentRefresh) {
            useAppStore.getState().finishSilentRefresh(tr("clientIceBox.iceBoxList"));
          }
        }
      },
      refreshIceBoxBackupStates: async (gitConfig) => {
        const normalizedGitConfig = normalizeGitConfig(gitConfig);

        if (!normalizedGitConfig.repository) {
          return;
        }

        const currentIceBoxes = get().iceBoxes;

        if (currentIceBoxes.length === 0) {
          return;
        }

        const latestBackupTimes = await Promise.all(
          currentIceBoxes.map(async (item) => ({
            id: item.id,
            lastBackupAt: await fetchLatestBackupAt(item, normalizedGitConfig),
          })),
        );

        set((state) => {
          let hasChanges = false;

          const nextIceBoxes = state.iceBoxes.map((item) => {
            const latestState = latestBackupTimes.find((candidate) => candidate.id === item.id);

            if (!latestState) {
              return item;
            }

            const nextStatus = latestState.lastBackupAt ? "healthy" : "attention";
            if (item.lastBackupAt === latestState.lastBackupAt && item.status === nextStatus) {
              return item;
            }

            hasChanges = true;
            return applyIceBoxBackupState(item, latestState.lastBackupAt);
          });

          return hasChanges ? { iceBoxes: nextIceBoxes } : state;
        });
      },
      createIceBox: async (input) => {
        if (get().isCreating) {
          return createIceBoxResult(tr("clientIceBox.creatingInProgress"));
        }

        set({ isCreating: true, error: null });

        try {
          const normalizedGitConfig = normalizeGitConfig(input.gitConfig);
          const name = input.name.trim();
          const machineId = slugifySegment(input.machineId);
          const createdAt = new Date().toISOString();

          if (!name) {
            return createIceBoxResult(tr("clientIceBox.fillName"));
          }

          if (!machineId) {
            return createIceBoxResult(tr("clientIceBox.invalidMachineId"));
          }

          if (!normalizedGitConfig.repository) {
            return createIceBoxResult(tr("clientIceBox.needGitConfigBeforeCreate"));
          }

          const existingIceBoxes = get().iceBoxes;
          const iceBoxId = machineId;
          const branch = `${iceBoxBranchPrefix}/${machineId}`;

          if (existingIceBoxes.some((existingItem) => existingItem.id === iceBoxId || existingItem.machineId === machineId)) {
            return createIceBoxResult(tr("clientIceBox.machineIdExists", { machineId }));
          }

          if (existingIceBoxes.some((existingItem) => existingItem.branch === branch)) {
            return createIceBoxResult(tr("clientIceBox.branchExists", { branch }));
          }

          let uploadPath: string | null = null;
          let uploadToken: string | null = null;

          if (input.backupMode === "upload-token") {
            try {
              const response = await fetch(`/api/ice-boxes/${iceBoxId}/upload-token`, {
                method: "POST",
                headers: getApiRequestHeaders({
                  "Content-Type": "application/json",
                }),
                body: JSON.stringify({
                  iceBoxName: name,
                  machineId,
                  gitConfig: normalizedGitConfig,
                  encryption: input.encryption,
                }),
              });
              const payload = await readApiPayload<CreateUploadTokenResult>(response);

              if (!response.ok) {
                const notice = toOperationNotice(payload, tr("clientIceBox.generateUploadTokenFailed"));

                return createIceBoxResult(notice.message, notice.details);
              }

              if (!payload.ok || !payload.uploadPath || !payload.uploadToken) {
                return createIceBoxResult(payload.message, payload.details);
              }

              uploadPath = payload.uploadPath;
              uploadToken = payload.uploadToken;
            } catch (error) {
              const notice = toRequestFailureNotice(tr("clientIceBox.generatingUploadUrlWhile"), error);

              return createIceBoxResult(notice.message, notice.details);
            }
          }

          const localItem = normalizeIceBoxItem({
            id: iceBoxId,
            name,
            machineId,
            branch,
            backupMode: input.backupMode,
            uploadPath,
            uploadToken,
            reminder: createDefaultIceBoxReminderConfig(createdAt),
            syncStatus: "pending-sync",
            lastSyncAt: null,
            lastSyncError: null,
            deletedAt: null,
            status: "attention",
            lastBackupAt: null,
            createdAt,
            updatedAt: createdAt,
            skillConfig: {
              version: 1,
              iceBoxId,
              iceBoxName: name,
              machineId,
              backupMode: input.backupMode,
              repository: normalizedGitConfig.repository,
              branch,
              gitAuthMethod: normalizedGitConfig.auth.method,
              gitUsername: readGitUsername(normalizedGitConfig.auth),
              uploadPath,
              uploadToken,
              scheduledBackup: createDefaultScheduledBackupConfig(),
              encryption: input.encryption,
              filter: input.filter,
              createdAt,
            },
          });

          set({
            iceBoxes: [localItem, ...existingIceBoxes],
            hasLoaded: true,
            error: null,
          });

          const syncResult = await syncIceBoxWithRemote(localItem, normalizedGitConfig);

          if (syncResult.ok) {
            const syncedItem = normalizeIceBoxItem(
              syncResult.item ?? markIceBoxSyncState(localItem, "sync-failed", null, tr("clientIceBox.remoteMissingValidatedRecord")),
            );

            set((state) => ({
              iceBoxes: state.iceBoxes.map((existingItem) => (existingItem.id === syncedItem.id ? syncedItem : existingItem)),
              hasLoaded: true,
              error: null,
            }));

            return {
              ok: true,
              message: tr("clientIceBox.createdAndVerified"),
              details: syncResult.commit ? tr("clientIceBox.configCommit", { commit: syncResult.commit.slice(0, 8) }) : undefined,
              createdAt,
              item: syncedItem,
            };
          }

          const failedItem = markIceBoxSyncState(localItem, "sync-failed", null, syncResult.details ?? syncResult.message);

          set((state) => ({
            iceBoxes: state.iceBoxes.map((existingItem) => (existingItem.id === failedItem.id ? failedItem : existingItem)),
            hasLoaded: true,
            error: null,
          }));

          return {
            ok: true,
            message: tr("clientIceBox.createdLocallyPendingVerify"),
            details: syncResult.details ?? syncResult.message,
            createdAt,
            item: failedItem,
          };
        } finally {
          set({ isCreating: false });
        }
      },
      syncIceBox: async (id, gitConfig) => {
        const target = get().iceBoxes.find((item) => item.id === id);

        if (!target) {
          return createSyncIceBoxResult(tr("clientIceBox.missingFromCache"), `ice-box-id: ${id}`);
        }

        const syncingAt = new Date().toISOString();

        set((state) => ({
          iceBoxes: state.iceBoxes.map((item) =>
            item.id === id ? markIceBoxSyncState({ ...item, updatedAt: syncingAt }, "pending-sync", item.lastSyncAt, null) : item,
          ),
          error: null,
        }));

        const syncResult = await syncIceBoxWithRemote({ ...target, updatedAt: syncingAt }, gitConfig);

        if (syncResult.ok) {
          const syncedItem = normalizeIceBoxItem(
            syncResult.item
              ?? markIceBoxSyncState(
                { ...target, updatedAt: syncingAt },
                "sync-failed",
                target.lastSyncAt,
                tr("clientIceBox.remoteMissingValidatedRecord"),
              ),
          );

          set((state) => ({
            iceBoxes: state.iceBoxes.map((item) => (item.id === id ? syncedItem : item)),
            error: null,
          }));

          return {
            ...syncResult,
            item: syncedItem,
            message: syncResult.message || tr("clientIceBox.verifiedByRemote"),
          };
        }

        const failedItem = markIceBoxSyncState(
          { ...target, updatedAt: syncingAt },
          "sync-failed",
          target.lastSyncAt,
          syncResult.details ?? syncResult.message,
        );

        set((state) => ({
          iceBoxes: state.iceBoxes.map((item) => (item.id === id ? failedItem : item)),
          error: null,
        }));

        return {
          ...syncResult,
          item: failedItem,
        };
      },
      syncPendingIceBoxes: async (gitConfig) => {
        const pendingIceBoxes = get().iceBoxes.filter((item) => item.syncStatus !== "synced");

        if (pendingIceBoxes.length === 0) {
          return {
            ok: true,
            message: tr("clientIceBox.noPendingSync"),
            syncedAt: new Date().toISOString(),
            syncedCount: 0,
            failedIds: [],
          };
        }

        let syncedCount = 0;
        const failedIds: string[] = [];
        const failureMessages: string[] = [];

        for (const item of pendingIceBoxes) {
          const result = await get().syncIceBox(item.id, gitConfig);

          if (result.ok) {
            syncedCount += 1;
          } else {
            failedIds.push(item.id);
            failureMessages.push(`${item.name}: ${result.message}`);
          }
        }

        if (failedIds.length === 0) {
          return {
            ok: true,
            message: tr("clientIceBox.syncedAllPending", { count: syncedCount }),
            syncedAt: new Date().toISOString(),
            syncedCount,
            failedIds,
          };
        }

        return createSyncPendingIceBoxesResult(
          syncedCount > 0
            ? tr("clientIceBox.partialSync", { syncedCount, failedCount: failedIds.length })
            : tr("clientIceBox.pendingSyncNoneSucceeded"),
          syncedCount,
          failedIds,
          failureMessages.join("\n"),
        );
      },
      updateIceBoxReminder: async (id, reminder, gitConfig) => {
        const updatedAt = new Date().toISOString();
        const normalizedReminder = normalizeIceBoxReminderConfig(reminder, updatedAt);

        set((state) => ({
          iceBoxes: state.iceBoxes.map((item) => {
            if (item.id !== id) {
              return item;
            }

            return normalizeIceBoxItem({
              ...item,
              reminder: normalizedReminder,
              updatedAt,
            });
          }),
          error: null,
        }));

        if (gitConfig?.repository) {
          try {
            const normalizedGitConfig = normalizeGitConfig(gitConfig);
            const payload = await withCorsFallback(
              () => updateIceBox(normalizedGitConfig, id, { reminder: normalizedReminder, updatedAt }),
              async () => {
                const response = await fetch(`/api/ice-boxes/${id}`, {
                  method: "PUT",
                  headers: getApiRequestHeaders({
                    "Content-Type": "application/json",
                  }),
                  body: JSON.stringify({
                    gitConfig: normalizedGitConfig,
                    updates: {
                      reminder: normalizedReminder,
                      updatedAt,
                    },
                  }),
                });

                return readApiPayload<IceBoxesSyncResult>(response);
              },
            );

            set((state) => ({
              iceBoxes: state.iceBoxes.map((item) => {
                if (item.id !== id) {
                  return item;
                }

                if (!payload.ok) {
                  return markIceBoxSyncState(item, "sync-failed", item.lastSyncAt, payload.details ?? payload.message);
                }

                return markIceBoxSyncState(item, "synced", payload.syncedAt, null);
              }),
              error: null,
            }));
          } catch (error) {
            console.warn("Failed to sync reminder update to GitHub:", error);
            set((state) => ({
              iceBoxes: state.iceBoxes.map((item) =>
                item.id === id
                  ? markIceBoxSyncState(
                      item,
                      "sync-failed",
                      item.lastSyncAt,
                      error instanceof Error ? error.message : tr("clientIceBox.syncReminderFailed"),
                    )
                  : item,
              ),
              error: null,
            }));
          }
        }
      },
      resetIceBoxReminder: async (id, gitConfig) => {
        const updatedAt = new Date().toISOString();
        const nextReminder = createDefaultIceBoxReminderConfig(updatedAt);

        set((state) => ({
          iceBoxes: state.iceBoxes.map((item) => {
            if (item.id !== id) {
              return item;
            }

            return normalizeIceBoxItem({
              ...item,
              reminder: nextReminder,
              updatedAt,
            });
          }),
          error: null,
        }));

        if (gitConfig?.repository) {
          try {
            const normalizedGitConfig = normalizeGitConfig(gitConfig);
            const payload = await withCorsFallback(
              () => updateIceBox(normalizedGitConfig, id, { reminder: nextReminder, updatedAt }),
              async () => {
                const response = await fetch(`/api/ice-boxes/${id}`, {
                  method: "PUT",
                  headers: getApiRequestHeaders({
                    "Content-Type": "application/json",
                  }),
                  body: JSON.stringify({
                    gitConfig: normalizedGitConfig,
                    updates: {
                      reminder: nextReminder,
                      updatedAt,
                    },
                  }),
                });

                return readApiPayload<IceBoxesSyncResult>(response);
              },
            );

            set((state) => ({
              iceBoxes: state.iceBoxes.map((item) => {
                if (item.id !== id) {
                  return item;
                }

                if (!payload.ok) {
                  return markIceBoxSyncState(item, "sync-failed", item.lastSyncAt, payload.details ?? payload.message);
                }

                return markIceBoxSyncState(item, "synced", payload.syncedAt, null);
              }),
              error: null,
            }));
          } catch (error) {
            console.warn("Failed to sync reminder reset to GitHub:", error);
            set((state) => ({
              iceBoxes: state.iceBoxes.map((item) =>
                item.id === id
                  ? markIceBoxSyncState(
                      item,
                      "sync-failed",
                      item.lastSyncAt,
                      error instanceof Error ? error.message : tr("clientIceBox.syncReminderFailed"),
                    )
                  : item,
              ),
              error: null,
            }));
          }
        }
      },
      syncIceBoxBackupState: (id, lastBackupAt) => {
        const target = get().iceBoxes.find((item) => item.id === id);

        if (!target) {
          return;
        }

        const nextStatus = lastBackupAt ? "healthy" : "attention";
        if (target.lastBackupAt === lastBackupAt && target.status === nextStatus) {
          return;
        }

        set((state) => ({
          iceBoxes: state.iceBoxes.map((item) => {
            if (item.id !== id) {
              return item;
            }

            return applyIceBoxBackupState(item, lastBackupAt);
          }),
        }));
      },
      deleteIceBox: async (id, gitConfig) => {
        const target = get().iceBoxes.find((item) => item.id === id);

        if (!target) {
          throw new Error(tr("clientIceBox.deletedOrNotSynced"));
        }

        if (gitConfig?.repository) {
          try {
            const normalizedGitConfig = normalizeGitConfig(gitConfig);
            const payload = await withCorsFallback(
              () => deleteIceBoxFromGitClient(normalizedGitConfig, id),
              async () => {
                const response = await fetch(`/api/ice-boxes/${id}`, {
                  method: "DELETE",
                  headers: getApiRequestHeaders({
                    "Content-Type": "application/json",
                  }),
                  body: JSON.stringify({
                    gitConfig: normalizedGitConfig,
                  }),
                });

                return readApiPayload<IceBoxesSyncResult>(response);
              },
            );

            if (!payload.ok) {
              console.warn("Failed to delete ice box from GitHub:", payload.message);
            }
          } catch (error) {
            console.warn("Failed to delete ice box from GitHub:", error);
          }
        }

        set({
          iceBoxes: get().iceBoxes.filter((item) => item.id !== id),
          error: null,
        });
      },
      clearError: () => set({ error: null }),
    }),
    {
      name: "claw-fridge-ice-box-store",
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          const raw = localStorage.getItem(name);
          if (!raw) return null;
          try {
            return JSON.parse(raw);
          } catch {
            localStorage.removeItem(name);
            return null;
          }
        },
        setItem: (name, value) => {
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          localStorage.removeItem(name);
        },
      },
      partialize: (state) => ({
        iceBoxes: state.iceBoxes,
      }) as IceBoxStoreState,
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
      merge: (persistedState, currentState) => {
        const typedPersistedState = persistedState as Partial<PersistedIceBoxStoreState>;

        return {
          ...currentState,
          iceBoxes: (typedPersistedState.iceBoxes ?? currentState.iceBoxes).map(normalizeIceBoxItem),
        };
      },
    },
  ),
);

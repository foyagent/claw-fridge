"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createDisabledEncryptionConfig } from "@/lib/backup-encryption";
import { readApiPayload, toOperationNotice, toRequestFailureNotice } from "@/lib/api-client";
import {
  createDefaultIceBoxReminderConfig,
  normalizeIceBoxReminderConfig,
} from "@/lib/ice-box-reminders";
import { iceBoxBranchPrefix } from "@/lib/git";
import { fetchIceBoxesSnapshot } from "@/lib/ice-boxes";
import { normalizeGitConfig } from "@/lib/git-config";
import { createEncryptedPersistStorage } from "@/lib/secure-storage";
import type { CreateIceBoxResult, CreateUploadTokenResult, IceBoxListItem, IceBoxStoreState } from "@/types";

interface PersistedIceBoxStoreState {
  iceBoxes: IceBoxListItem[];
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

function normalizeIceBoxItem(item: IceBoxListItem): IceBoxListItem {
  return {
    ...item,
    reminder: normalizeIceBoxReminderConfig(item.reminder, item.updatedAt || item.createdAt),
    skillConfig: {
      ...item.skillConfig,
      encryption: item.skillConfig.encryption ?? createDisabledEncryptionConfig(item.updatedAt),
    },
  };
}

export const useIceBoxStore = create<IceBoxStoreState>()(
  persist(
    (set, get) => ({
      ...defaultState,
      setHydrated: (hasHydrated) => set({ hasHydrated }),
      loadIceBoxes: async () => {
        if (get().isLoading) {
          return;
        }

        set({ isLoading: true, error: null });

        try {
          const iceBoxes = await fetchIceBoxesSnapshot(get().iceBoxes.map(normalizeIceBoxItem));

          set({
            iceBoxes,
            hasLoaded: true,
            isLoading: false,
            error: null,
          });
        } catch (error) {
          set({
            hasLoaded: true,
            isLoading: false,
            error: error instanceof Error ? error.message : "加载冰盒列表失败，请稍后重试。",
          });
        }
      },
      createIceBox: async (input) => {
        if (get().isCreating) {
          return createIceBoxResult("创建流程正在进行中，请稍后再试。");
        }

        set({ isCreating: true, error: null });

        try {
          const normalizedGitConfig = normalizeGitConfig(input.gitConfig);
          const name = input.name.trim();
          const machineId = slugifySegment(input.machineId);
          const createdAt = new Date().toISOString();

          if (!name) {
            return createIceBoxResult("请先填写冰盒名称。");
          }

          if (!machineId) {
            return createIceBoxResult("请提供合法的 machine-id，仅支持字母、数字和短横线。");
          }

          if (!normalizedGitConfig.repository) {
            return createIceBoxResult("请先在首页保存 Git 仓库配置，再创建冰盒。");
          }

          const existingIceBoxes = get().iceBoxes;
          const iceBoxId = machineId;
          const branch = `${iceBoxBranchPrefix}/${machineId}`;

          if (existingIceBoxes.some((item) => item.id === iceBoxId || item.machineId === machineId)) {
            return createIceBoxResult(`machine-id \`${machineId}\` 已存在，请换一个。`);
          }

          if (existingIceBoxes.some((item) => item.branch === branch)) {
            return createIceBoxResult(`备份分支 \`${branch}\` 已被占用，请换一个 machine-id。`);
          }

          let uploadPath: string | null = null;
          let uploadToken: string | null = null;

          if (input.backupMode === "upload-token") {
            try {
              const response = await fetch(`/api/ice-boxes/${iceBoxId}/upload-token`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  iceBoxName: name,
                  machineId,
                  gitConfig: normalizedGitConfig,
                  encryption: input.encryption,
                }),
              });
              const payload = await readApiPayload<CreateUploadTokenResult>(response);

              if (!response.ok) {
                const notice = toOperationNotice(payload, "生成上传 token 失败。");

                return createIceBoxResult(notice.message, notice.details);
              }

              const result = payload;

              if (!result.ok || !result.uploadPath || !result.uploadToken) {
                return createIceBoxResult(result.message, result.details);
              }

              uploadPath = result.uploadPath;
              uploadToken = result.uploadToken;
            } catch (error) {
              const notice = toRequestFailureNotice("生成上传地址时", error);

              return createIceBoxResult(notice.message, notice.details);
            }
          }

          const item: IceBoxListItem = {
            id: iceBoxId,
            name,
            machineId,
            branch,
            backupMode: input.backupMode,
            uploadPath,
            uploadToken,
            reminder: createDefaultIceBoxReminderConfig(createdAt),
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
              encryption: input.encryption,
              createdAt,
            },
          };

          set({
            iceBoxes: [item, ...existingIceBoxes],
            hasLoaded: true,
            error: null,
          });

          return {
            ok: true,
            message: "冰盒已创建，可继续打开 Skill 文档或前往详情页。",
            createdAt,
            item,
          };
        } finally {
          set({ isCreating: false });
        }
      },
      updateIceBoxReminder: (id, reminder) => {
        const updatedAt = new Date().toISOString();

        set((state) => ({
          iceBoxes: state.iceBoxes.map((item) => {
            if (item.id !== id) {
              return item;
            }

            return {
              ...item,
              reminder: normalizeIceBoxReminderConfig(reminder, updatedAt),
              updatedAt,
            };
          }),
          error: null,
        }));
      },
      resetIceBoxReminder: (id) => {
        const updatedAt = new Date().toISOString();

        set((state) => ({
          iceBoxes: state.iceBoxes.map((item) => {
            if (item.id !== id) {
              return item;
            }

            return {
              ...item,
              reminder: createDefaultIceBoxReminderConfig(updatedAt),
              updatedAt,
            };
          }),
          error: null,
        }));
      },
      syncIceBoxBackupState: (id, lastBackupAt) => {
        set((state) => ({
          iceBoxes: state.iceBoxes.map((item) => {
            if (item.id !== id) {
              return item;
            }

            return {
              ...item,
              lastBackupAt,
              status: lastBackupAt ? "healthy" : "attention",
            };
          }),
        }));
      },
      deleteIceBox: async (id) => {
        const target = get().iceBoxes.find((item) => item.id === id);

        if (!target) {
          throw new Error("冰盒不存在，可能已经被删除或尚未同步到本地。");
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
      storage: createEncryptedPersistStorage<PersistedIceBoxStoreState>(),
      partialize: (state): PersistedIceBoxStoreState => ({
        iceBoxes: state.iceBoxes,
      }),
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

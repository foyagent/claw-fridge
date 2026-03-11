"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { readApiPayload, toOperationNotice, toRequestFailureNotice } from "@/lib/api-client";
import { DEFAULT_GIT_CONFIG, normalizeGitConfig, withUpdatedGitConfigTimestamp } from "@/lib/git-config";
import { createEncryptedPersistStorage } from "@/lib/secure-storage";
import type {
  AppState,
  GitConfigInitResult,
  GitConfigTestResult,
  GitRepositoryConfig,
  Integration,
} from "@/types";

interface PersistedAppState {
  projectName: string;
  gitConfig: GitRepositoryConfig;
}

const defaultIntegrations: Integration[] = [
  "Next.js",
  "Tailwind CSS",
  "ESLint",
  "Zustand",
  "isomorphic-git",
  "Git Config",
];

const defaultState = {
  projectName: "Claw-Fridge",
  initializedAt: new Date("2026-03-11T15:34:00+08:00").toISOString(),
  integrations: defaultIntegrations,
  gitConfig: DEFAULT_GIT_CONFIG,
  hasHydrated: false,
  lastGitTestResult: null as GitConfigTestResult | null,
  lastGitInitResult: null as GitConfigInitResult | null,
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...defaultState,
      setProjectName: (projectName) => set({ projectName }),
      setHydrated: (hasHydrated) => set({ hasHydrated }),
      saveGitConfig: (gitConfig) => {
        set({
          gitConfig: withUpdatedGitConfigTimestamp(gitConfig),
          lastGitTestResult: null,
          lastGitInitResult: null,
        });
      },
      testGitConfig: async (gitConfig) => {
        const normalizedConfig = normalizeGitConfig(gitConfig);

        try {
          const response = await fetch("/api/git/config/test", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(normalizedConfig),
          });

          const payload = await readApiPayload<GitConfigTestResult>(response);
          const result: GitConfigTestResult = response.ok
            ? payload
            : {
                ok: false,
                checkedAt: new Date().toISOString(),
                ...toOperationNotice(payload, "Git 配置测试失败。"),
                errorCode: payload.errorCode,
                statusCode: response.status,
              };

          set({ lastGitTestResult: result });

          return result;
        } catch (error) {
          const notice = toRequestFailureNotice("测试 Git 连接时", error);
          const result: GitConfigTestResult = {
            ok: false,
            checkedAt: new Date().toISOString(),
            message: notice.message,
            details: notice.details,
          };

          set({ lastGitTestResult: result });

          return result;
        }
      },
      initializeFridgeConfig: async (gitConfig) => {
        const normalizedConfig = normalizeGitConfig(gitConfig);

        try {
          const response = await fetch("/api/git/config/init", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(normalizedConfig),
          });

          const payload = await readApiPayload<GitConfigInitResult>(response);
          const result: GitConfigInitResult = response.ok
            ? payload
            : {
                ok: false,
                initializedAt: new Date().toISOString(),
                ...toOperationNotice(payload, "fridge-config 分支初始化失败。"),
                errorCode: payload.errorCode,
                statusCode: response.status,
              };

          set({ lastGitInitResult: result });

          return result;
        } catch (error) {
          const notice = toRequestFailureNotice("初始化 fridge-config 分支时", error);
          const result: GitConfigInitResult = {
            ok: false,
            initializedAt: new Date().toISOString(),
            message: notice.message,
            details: notice.details,
          };

          set({ lastGitInitResult: result });

          return result;
        }
      },
      clearGitTestResult: () => set({ lastGitTestResult: null }),
      clearGitInitResult: () => set({ lastGitInitResult: null }),
    }),
    {
      name: "claw-fridge-app-store",
      storage: createEncryptedPersistStorage<PersistedAppState>(),
      partialize: (state): PersistedAppState => ({
        projectName: state.projectName,
        gitConfig: state.gitConfig,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
      merge: (persistedState, currentState) => {
        const typedPersistedState = persistedState as Partial<PersistedAppState>;

        return {
          ...currentState,
          projectName: typedPersistedState.projectName ?? currentState.projectName,
          gitConfig: typedPersistedState.gitConfig
            ? normalizeGitConfig(typedPersistedState.gitConfig)
            : currentState.gitConfig,
        };
      },
    },
  ),
);

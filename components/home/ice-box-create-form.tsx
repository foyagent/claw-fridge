"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useMounted } from "@/hooks/use-mounted";
import {
  createDisabledEncryptionConfig,
  defaultUploadPayloadKdfIterations,
  normalizeEncryptionKeyHint,
  uploadPayloadEncryptionAlgorithm,
  uploadPayloadEncryptionKdf,
  uploadPayloadEncryptionKeyStrategy,
  uploadPayloadEncryptionScope,
} from "@/lib/backup-encryption";
import { iceBoxBranchPrefix } from "@/lib/git";
import { useAppStore } from "@/store/app-store";
import { useIceBoxStore } from "@/store/ice-box-store";
import type { IceBoxBackupMode } from "@/types";

interface OperationNotice {
  message: string;
  details?: string;
}

function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function createSuffix(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  }

  return Math.random().toString(36).slice(2, 8);
}

function buildSuggestedMachineId(name: string, suffix: string): string {
  const base = slugifySegment(name) || "machine";
  return `${base}-${suffix}`;
}

function createEncryptionSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return globalThis.btoa(binary);
}

function ResultDetails({ details, label }: { details: string; label: string }) {
  return (
    <details className="mt-3 rounded-xl bg-black/5 p-3 text-xs leading-5 text-current dark:bg-black/20">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{details}</pre>
    </details>
  );
}

interface IceBoxCreateFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function IceBoxCreateForm({ onSuccess, onCancel }: IceBoxCreateFormProps) {
  const t = useTranslations();
  const mounted = useMounted();
  const hasHydrated = mounted;
  const gitConfig = useAppStore((state) => state.gitConfig);
  const createIceBox = useIceBoxStore((state) => state.createIceBox);
  const isCreating = useIceBoxStore((state) => state.isCreating);

  const [machineSuffix] = useState(() => createSuffix());
  const [name, setName] = useState("");
  const [machineId, setMachineId] = useState(() => buildSuggestedMachineId("", machineSuffix));
  const [backupMode, setBackupMode] = useState<IceBoxBackupMode>("git-branch");
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [masterKey, setMasterKey] = useState("");
  const [masterKeyConfirm, setMasterKeyConfirm] = useState("");
  const [masterKeyHint, setMasterKeyHint] = useState("");
  const [machineIdTouched, setMachineIdTouched] = useState(false);
  const [error, setError] = useState<OperationNotice | null>(null);

  const normalizedMachineId = useMemo(() => slugifySegment(machineId), [machineId]);
  const previewBranch = useMemo(() => `${iceBoxBranchPrefix}/${normalizedMachineId || "machine-id"}`, [normalizedMachineId]);
  const hasGitConfig = Boolean(gitConfig.repository.trim());
  const supportsEncryptedUpload = backupMode === "upload-token";
  const encryptionError = useMemo(() => {
    if (!supportsEncryptedUpload || !encryptionEnabled) {
      return null;
    }
    if (masterKey.trim().length < 12) {
      return t("home.create.errors.minKeyLength");
    }
    if (masterKey !== masterKeyConfirm) {
      return t("home.create.errors.keyMismatch");
    }
    return null;
  }, [encryptionEnabled, masterKey, masterKeyConfirm, supportsEncryptedUpload, t]);

  const canSubmit = hasHydrated && hasGitConfig && Boolean(name.trim()) && Boolean(normalizedMachineId) && !isCreating && !encryptionError;

  const submitHint = useMemo(() => {
    if (!hasHydrated) {
      return { tone: "info", message: t("home.create.errors.loadingConfig") };
    }
    if (!hasGitConfig) {
      return { tone: "warning", message: t("home.create.errors.needGitConfig") };
    }
    if (!name.trim()) {
      return { tone: "info", message: t("home.create.errors.fillName") };
    }
    if (!normalizedMachineId) {
      return { tone: "warning", message: t("home.create.errors.invalidMachineId") };
    }
    if (encryptionError) {
      return { tone: "warning", message: encryptionError };
    }
    return null;
  }, [encryptionError, hasGitConfig, hasHydrated, name, normalizedMachineId, t]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (encryptionError) {
      setError({ message: encryptionError });
      return;
    }

    const createdAt = new Date().toISOString();
    const encryption = supportsEncryptedUpload && encryptionEnabled
      ? {
          version: 1 as const,
          enabled: true,
          scope: uploadPayloadEncryptionScope,
          algorithm: uploadPayloadEncryptionAlgorithm,
          kdf: uploadPayloadEncryptionKdf,
          kdfSalt: createEncryptionSalt(),
          kdfIterations: defaultUploadPayloadKdfIterations,
          keyStrategy: uploadPayloadEncryptionKeyStrategy,
          keyHint: normalizeEncryptionKeyHint(masterKeyHint),
          updatedAt: createdAt,
        }
      : createDisabledEncryptionConfig(createdAt);

    const result = await createIceBox({ name, machineId: normalizedMachineId, backupMode, gitConfig, encryption });

    if (!result.ok || !result.item) {
      setError({ message: result.message, details: result.details });
      return;
    }

    setName("");
    setMachineId(buildSuggestedMachineId("", createSuffix()));
    setBackupMode("git-branch");
    setEncryptionEnabled(false);
    setMasterKey("");
    setMasterKeyConfirm("");
    setMasterKeyHint("");
    setMachineIdTouched(false);
    setError(null);
    onSuccess?.();
  }

  return (
    <div className="grid gap-5 rounded-[24px] border border-sky-400/30 bg-sky-500/5 p-5 shadow-sm shadow-sky-500/10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{t("home.create.title")}</h3>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t("home.create.description")}</p>
        </div>
        {onCancel ? <button type="button" onClick={onCancel} className="fridge-button-ghost">{t("common.cancel")}</button> : null}
      </div>

      <form onSubmit={(event) => void handleSubmit(event)} className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("home.create.name")}</span>
            <input
              value={name}
              disabled={!hasHydrated || isCreating}
              onChange={(event) => {
                const nextName = event.target.value;
                setName(nextName);
                if (!machineIdTouched) setMachineId(buildSuggestedMachineId(nextName, machineSuffix));
              }}
              placeholder={t("home.create.namePlaceholder")}
              className="fridge-input"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("home.create.machineId")}</span>
            <input
              value={machineId}
              disabled={!hasHydrated || isCreating}
              onChange={(event) => {
                setMachineIdTouched(true);
                setMachineId(event.target.value);
              }}
              placeholder="machine-id"
              className="fridge-input"
            />
            <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">{t("home.create.machinePreview", { value: normalizedMachineId || "machine-id" })}</p>
          </label>
        </div>

        <div className="space-y-3">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("home.create.backupMode")}</span>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={!hasHydrated || isCreating}
              onClick={() => {
                setBackupMode("git-branch");
                setEncryptionEnabled(false);
              }}
              className={[
                "rounded-[20px] border p-4 text-left transition",
                backupMode === "git-branch"
                  ? "border-sky-400/40 bg-sky-500/10 shadow-sm shadow-sky-500/10"
                  : "border-zinc-200/80 bg-white/72 hover:border-sky-300/30 dark:border-white/10 dark:bg-white/5",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t("home.create.gitDirect")}</p>
                {backupMode === "git-branch" ? <span className="fridge-chip fridge-chip--ocean">{t("home.create.gitDirectTag")}</span> : null}
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{t("home.create.gitDirectDescription")}</p>
            </button>

            <button
              type="button"
              disabled={!hasHydrated || isCreating}
              onClick={() => setBackupMode("upload-token")}
              className={[
                "rounded-[20px] border p-4 text-left transition",
                backupMode === "upload-token"
                  ? "border-pink-300/40 bg-pink-500/5 shadow-sm shadow-pink-500/10"
                  : "border-zinc-200/80 bg-white/72 hover:border-pink-300/30 dark:border-white/10 dark:bg-white/5",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t("home.create.uploadToken")}</p>
                {backupMode === "upload-token" ? <span className="fridge-chip fridge-chip--coral">{t("home.create.uploadTokenTag")}</span> : null}
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{t("home.create.uploadTokenDescription")}</p>
            </button>
          </div>
        </div>

        {backupMode === "upload-token" ? (
          <div className="grid gap-4 rounded-[20px] border border-zinc-200/80 bg-zinc-50/70 p-4 dark:border-white/10 dark:bg-zinc-950/30">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">{t("home.create.uploadEncryption")}</h4>
                <p className="text-xs leading-5 text-zinc-600 dark:text-zinc-300">{t("home.create.uploadEncryptionDescription")}</p>
              </div>
              <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={encryptionEnabled}
                  disabled={!hasHydrated || isCreating}
                  onChange={(event) => setEncryptionEnabled(event.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
                />
                {t("home.create.enableEncryption")}
              </label>
            </div>

            {encryptionEnabled ? (
              <div className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{t("home.create.masterKey")}</span>
                    <input type="password" value={masterKey} disabled={!hasHydrated || isCreating} onChange={(event) => setMasterKey(event.target.value)} placeholder={t("home.create.masterKeyPlaceholder")} className="fridge-input text-sm" />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{t("home.create.confirmMasterKey")}</span>
                    <input type="password" value={masterKeyConfirm} disabled={!hasHydrated || isCreating} onChange={(event) => setMasterKeyConfirm(event.target.value)} placeholder={t("home.create.confirmMasterKey")} className="fridge-input text-sm" />
                  </label>
                </div>
                <label className="grid gap-2">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{t("home.create.hint")}</span>
                  <input value={masterKeyHint} disabled={!hasHydrated || isCreating} onChange={(event) => setMasterKeyHint(event.target.value)} placeholder={t("home.create.hintPlaceholder")} className="fridge-input text-sm" />
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        {encryptionError && supportsEncryptedUpload && encryptionEnabled ? (
          <div className="fridge-state fridge-state--warning">
            <p className="font-medium">{t("home.create.uploadEncryption")}</p>
            <p className="mt-1 opacity-90">{encryptionError}</p>
          </div>
        ) : null}

        {submitHint ? (
          <div className={`fridge-state ${submitHint.tone === "warning" ? "fridge-state--warning" : "fridge-state--info"}`}>
            <p className="font-medium">{t("home.create.saveNoteTitle")}</p>
            <p className="mt-1 opacity-90">{submitHint.message}</p>
          </div>
        ) : null}

        {error ? (
          <div className="fridge-state fridge-state--error">
            <p className="font-medium">{t("home.create.submit")}</p>
            <p className="mt-1 opacity-90">{error.message}</p>
            {error.details ? <ResultDetails details={error.details} label={t("common.viewDetails")} /> : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!canSubmit} className="fridge-button-primary">{isCreating ? t("home.create.submitting") : t("home.create.submit")}</button>
          {onCancel ? <button type="button" onClick={onCancel} className="fridge-button-secondary">{t("common.cancel")}</button> : null}
        </div>

        <div className="rounded-[20px] border border-zinc-200/80 bg-zinc-50/70 p-4 text-xs leading-5 text-zinc-600 dark:border-white/10 dark:bg-zinc-950/30 dark:text-zinc-300">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">{t("home.create.saveNoteTitle")}</p>
          <div className="mt-2 grid gap-1">
            <p>{t("home.create.saveNote", { branch: previewBranch })}</p>
            <p>{t("home.create.backupMode")}: <span>{backupMode === "git-branch" ? t("home.create.gitDirect") : t("home.create.uploadToken")}</span></p>
            <p>{t("detail.uploadEncryption")}: <span>{supportsEncryptedUpload && encryptionEnabled ? t("home.create.cryptoLabel") : t("common.disabled")}</span></p>
          </div>
        </div>
      </form>
    </div>
  );
}

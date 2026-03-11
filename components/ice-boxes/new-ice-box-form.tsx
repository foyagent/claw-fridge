"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
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

function ResultDetails({ details }: { details: string }) {
  return (
    <details className="mt-3 rounded-xl bg-black/5 p-3 text-xs leading-5 text-current dark:bg-black/20">
      <summary className="cursor-pointer font-medium">查看细节</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{details}</pre>
    </details>
  );
}

const flowSteps = [
  {
    title: "给机器起名",
    description: "名称会用于详情页展示，machine-id 会自动生成可落地的分支标识。",
  },
  {
    title: "选择备份模式",
    description: "Git 直推适合高频自动同步，上传模式适合低频、无 Git 环境。",
  },
  {
    title: "生成 Skill 与恢复入口",
    description: "创建完成后会跳转详情页，继续查看 Skill 文档、历史快照与恢复流程。",
  },
];

export function NewIceBoxForm() {
  const router = useRouter();
  const mounted = useMounted();
  const hasHydratedAppStore = useAppStore((state) => state.hasHydrated);
  const hasHydratedIceBoxStore = useIceBoxStore((state) => state.hasHydrated);
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

  const hasHydrated = mounted && hasHydratedAppStore && hasHydratedIceBoxStore;
  const normalizedMachineId = useMemo(() => slugifySegment(machineId), [machineId]);
  const previewBranch = useMemo(() => `${iceBoxBranchPrefix}/${normalizedMachineId || "machine-id"}`, [normalizedMachineId]);
  const hasGitConfig = Boolean(gitConfig.repository.trim());
  const supportsEncryptedUpload = backupMode === "upload-token";
  const encryptionError = useMemo(() => {
    if (!supportsEncryptedUpload || !encryptionEnabled) {
      return null;
    }

    if (masterKey.trim().length < 12) {
      return "主密钥至少 12 个字符，建议使用长口令。";
    }

    if (masterKey !== masterKeyConfirm) {
      return "两次输入的主密钥不一致。";
    }

    return null;
  }, [encryptionEnabled, masterKey, masterKeyConfirm, supportsEncryptedUpload]);
  const canSubmit =
    hasHydrated &&
    hasGitConfig &&
    Boolean(name.trim()) &&
    Boolean(normalizedMachineId) &&
    !isCreating &&
    !encryptionError;
  const submitHint = useMemo(() => {
    if (!hasHydrated) {
      return {
        tone: "info",
        message: "正在读取本地配置，请稍等片刻。",
      };
    }

    if (!hasGitConfig) {
      return {
        tone: "warning",
        message: "请先回首页保存 Git 仓库配置，再创建冰盒。",
      };
    }

    if (!name.trim()) {
      return {
        tone: "info",
        message: "先填写冰盒名称，系统会顺手帮你生成 machine-id。",
      };
    }

    if (!normalizedMachineId) {
      return {
        tone: "warning",
        message: "machine-id 需要至少保留一个字母、数字或短横线。",
      };
    }

    if (encryptionError) {
      return {
        tone: "warning",
        message: encryptionError,
      };
    }

    return null;
  }, [encryptionError, hasGitConfig, hasHydrated, name, normalizedMachineId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (encryptionError) {
      setError({ message: encryptionError });
      return;
    }

    const createdAt = new Date().toISOString();
    const encryption =
      supportsEncryptedUpload && encryptionEnabled
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

    const result = await createIceBox({
      name,
      machineId: normalizedMachineId,
      backupMode,
      gitConfig,
      encryption,
    });

    if (!result.ok || !result.item) {
      setError({
        message: result.message,
        details: result.details,
      });
      return;
    }

    router.push(`/ice-boxes/${result.item.id}`);
  }

  return (
    <main className="fridge-page">
      <div className="fridge-shell--narrow">
        <section className="fridge-hero">
          <div className="relative z-10 flex flex-wrap items-center gap-3">
            <span className="fridge-chip fridge-chip--ocean">New Ice Box</span>
            <span className="fridge-chip">{backupMode === "git-branch" ? "Git 直推" : "压缩包上传"}</span>
            {supportsEncryptedUpload ? (
              <span className={`fridge-chip ${encryptionEnabled ? "fridge-chip--coral" : "fridge-chip"}`}>
                {encryptionEnabled ? "上传加密已开启" : "上传加密可选"}
              </span>
            ) : null}
          </div>

          <div className="relative z-10 grid gap-5 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div className="space-y-3">
              <p className="fridge-kicker">Create Flow</p>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">创建一台真正可交付的冰盒。</h1>
              <p className="max-w-3xl text-sm leading-7 text-zinc-600 dark:text-zinc-300 sm:text-base">
                这一步会一起生成冰盒名称、machine-id、备份分支和 Skill 配置。创建成功后会直接进入详情页，继续查看 Skill 文档、历史版本和恢复入口。
              </p>
            </div>

            <div className="fridge-panel-tint relative z-10 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
              <p className="font-medium text-zinc-950 dark:text-zinc-50">先决条件</p>
              <p className="mt-2">必须先在首页保存 Git 仓库配置。冰盒本身只是“唯一备份身份”，不是独立存储空间。</p>
            </div>
          </div>

          <div className="relative z-10 grid gap-3 md:grid-cols-3">
            {flowSteps.map((step, index) => (
              <div key={step.title} className="fridge-step-card">
                <div className="mb-3 flex items-center gap-3">
                  <span className="fridge-step-number">{index + 1}</span>
                  <p className="font-semibold text-zinc-950 dark:text-zinc-50">{step.title}</p>
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">{step.description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <form onSubmit={(event) => void handleSubmit(event)} className="fridge-panel grid gap-5">
            <div className="grid gap-4">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">冰盒名称</span>
                <input
                  value={name}
                  disabled={!hasHydrated || isCreating}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setName(nextName);

                    if (!machineIdTouched) {
                      setMachineId(buildSuggestedMachineId(nextName, machineSuffix));
                    }
                  }}
                  placeholder="例如：Boen 的 MacBook Pro"
                  className="fridge-input"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">machine-id</span>
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
                <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                  会自动规范成小写字母、数字和短横线。当前预览：`{normalizedMachineId || "machine-id"}`
                </p>
              </label>
            </div>

            <div className="grid gap-4">
              <div className="space-y-2">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">备份方案</span>
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    disabled={!hasHydrated || isCreating}
                    onClick={() => {
                      setBackupMode("git-branch");
                      setEncryptionEnabled(false);
                    }}
                    className={[
                      "rounded-[24px] border p-4 text-left transition",
                      backupMode === "git-branch"
                        ? "border-sky-400/40 bg-sky-500/10 shadow-sm shadow-sky-500/10"
                        : "border-zinc-200/80 bg-white/72 hover:border-sky-300/30 dark:border-white/10 dark:bg-white/5",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-zinc-950 dark:text-zinc-50">Git 直推</p>
                      {backupMode === "git-branch" ? <span className="fridge-chip fridge-chip--ocean">推荐</span> : null}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                      OpenClaw 直接把 `.openclaw` 推到专属分支，适合高频自动同步。
                    </p>
                  </button>

                  <button
                    type="button"
                    disabled={!hasHydrated || isCreating}
                    onClick={() => setBackupMode("upload-token")}
                    className={[
                      "rounded-[24px] border p-4 text-left transition",
                      backupMode === "upload-token"
                        ? "border-pink-300/40 bg-pink-500/5 shadow-sm shadow-pink-500/10"
                        : "border-zinc-200/80 bg-white/72 hover:border-pink-300/30 dark:border-white/10 dark:bg-white/5",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-zinc-950 dark:text-zinc-50">压缩包上传</p>
                      {backupMode === "upload-token" ? <span className="fridge-chip fridge-chip--coral">低频友好</span> : null}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                      无需在源机器上配置 Git，按需打包上传，再由服务端接续后续备份流程。
                    </p>
                  </button>
                </div>
              </div>

              <div className="fridge-panel-muted text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">当前方案说明</p>
                <p>
                  {backupMode === "git-branch"
                    ? "Skill 会生成 Git 上游配置、同步脚本和定时任务模板，适合经常更新的主力机器。"
                    : encryptionEnabled
                      ? "Skill 会生成本地加密脚本、加密上传命令、解密握手请求头和风险提示。"
                      : "Skill 会生成 tar 打包命令、带进度条的 curl 上传命令、校验步骤和重试指导。"}
                </p>
              </div>
            </div>

            <div className="fridge-panel-muted grid gap-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">上传链路加密</h2>
                  <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    仅对“压缩包上传”方案生效。压缩包会在本地先做 AES-256-GCM 加密，服务端收到后临时解密并落入现有备份流程。
                  </p>
                </div>
                <label className="inline-flex items-center gap-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">
                  <input
                    type="checkbox"
                    checked={encryptionEnabled}
                    disabled={!hasHydrated || isCreating || !supportsEncryptedUpload}
                    onChange={(event) => setEncryptionEnabled(event.target.checked)}
                    className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
                  />
                  启用加密
                </label>
              </div>

              {!supportsEncryptedUpload ? (
                <div className="fridge-state text-zinc-600 dark:text-zinc-300">
                  当前选择的是 Git 直推；这一步无需额外上传加密。
                </div>
              ) : null}

              {supportsEncryptedUpload && encryptionEnabled ? (
                <div className="grid gap-4">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">主密钥</span>
                    <input
                      type="password"
                      value={masterKey}
                      disabled={!hasHydrated || isCreating}
                      onChange={(event) => setMasterKey(event.target.value)}
                      placeholder="至少 12 个字符，建议使用长口令"
                      className="fridge-input"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">确认主密钥</span>
                    <input
                      type="password"
                      value={masterKeyConfirm}
                      disabled={!hasHydrated || isCreating}
                      onChange={(event) => setMasterKeyConfirm(event.target.value)}
                      placeholder="再输入一次，避免手滑"
                      className="fridge-input"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">密钥提示（可选）</span>
                    <input
                      value={masterKeyHint}
                      disabled={!hasHydrated || isCreating}
                      onChange={(event) => setMasterKeyHint(event.target.value)}
                      placeholder="例如：旧 MacBook 那把长口令"
                      className="fridge-input"
                    />
                  </label>

                  <div className="fridge-state fridge-state--warning">
                    <p className="font-medium">密钥保存策略</p>
                    <p className="mt-1">默认不持久化主密钥。创建后只保存盐值、KDF 参数和可选提示；真正上传时，需要再次手动提供同一把主密钥。</p>
                    <p className="mt-1">如果你丢了这把密钥，后续加密上传将无法解密。</p>
                  </div>
                </div>
              ) : null}
            </div>

            {encryptionError && supportsEncryptedUpload && encryptionEnabled ? (
              <div className="fridge-state fridge-state--warning">
                <p className="font-medium">加密配置还没填好</p>
                <p className="mt-1 opacity-90">{encryptionError}</p>
              </div>
            ) : null}

            {submitHint ? (
              <div className={`fridge-state ${submitHint.tone === "warning" ? "fridge-state--warning" : "fridge-state--info"}`}>
                <p className="font-medium">当前提示</p>
                <p className="mt-1 opacity-90">{submitHint.message}</p>
              </div>
            ) : null}

            {error ? (
              <div className="fridge-state fridge-state--error">
                <p className="font-medium">创建失败</p>
                <p className="mt-1 opacity-90">{error.message}</p>
                {error.details ? <ResultDetails details={error.details} /> : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" disabled={!canSubmit} className="fridge-button-primary">
                {isCreating ? "正在生成冰盒与 Skill 配置..." : "创建冰盒"}
              </button>
              <Link href="/" className="fridge-button-secondary">
                返回首页
              </Link>
            </div>
          </form>

          <aside className="fridge-panel grid gap-4">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">创建预览</h2>
              <div className="fridge-panel-muted text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                <p>Git 仓库：`{gitConfig.repository || "尚未配置"}`</p>
                <p>认证方式：`{gitConfig.auth.method}`</p>
                <p>目标分支：`{previewBranch}`</p>
                <p>Skill 安装目录：`~/.openclaw/skills/claw-fridge-{normalizedMachineId || "machine-id"}/`</p>
                <p>上传加密：`{supportsEncryptedUpload && encryptionEnabled ? "已启用 AES-256-GCM" : "未启用"}`</p>
              </div>
            </div>

            {!hasHydrated ? (
              <div className="fridge-state fridge-state--info">
                <p className="font-medium">正在读取本地配置</p>
                <p className="mt-1">等本地加密存储完成 hydration 后，会自动带入已保存的 Git 配置。</p>
              </div>
            ) : hasGitConfig ? (
              <div className="fridge-state fridge-state--success">
                <p className="font-medium">Git 配置已就绪</p>
                <p className="mt-1">当前会直接复用首页保存的仓库配置来生成冰盒和 Skill 文档。</p>
              </div>
            ) : (
              <div className="fridge-state fridge-state--warning">
                <p className="font-medium">请先配置 Git 仓库</p>
                <p className="mt-1">首页的 Git Config 面板还没有保存仓库地址，当前不能创建冰盒。</p>
                <div className="mt-3">
                  <Link href="/" className="fridge-button-secondary">
                    去首页配置 Git
                  </Link>
                </div>
              </div>
            )}

            <div className="fridge-panel-muted text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              <p className="font-medium text-zinc-900 dark:text-zinc-100">创建后会立刻生成</p>
              <p>1. 冰盒记录和详情页</p>
              <p>2. 专属备份分支名</p>
              <p>3. Skill 文档所需配置</p>
              <p>4. Git / 上传模式的安装指导入口</p>
              <p>5. 可选的上传链路加密元数据</p>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

import Link from "next/link";
import { headers } from "next/headers";
import { isEncryptionEnabled } from "@/lib/backup-encryption";
import {
  SkillDocumentError,
  createSkillDocumentModel,
  parseSkillConfigSearchParam,
} from "@/lib/skill-document";

function resolveRequestOrigin(requestHeaders: Headers): string | null {
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";

  if (!host) {
    return null;
  }

  return `${protocol}://${host}`;
}

function ErrorState({ message }: { message: string }) {
  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        <section className="fridge-panel grid max-w-3xl gap-6 border-rose-500/20">
          <div className="flex h-16 w-16 items-center justify-center rounded-[24px] bg-[var(--danger-soft)] text-4xl">
            ⚠️
          </div>
          <div className="space-y-3">
            <p className="fridge-kicker">Skill Error</p>
            <h1 className="text-3xl font-semibold">Skill 文档生成失败</h1>
            <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300 sm:text-base">{message}</p>
          </div>
          <div className="fridge-state fridge-state--warning">
            先确认链接里的配置参数完整，再回到对应冰盒详情页重新打开 Skill 文档。
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/" className="fridge-button-secondary">
              返回首页
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}

export default async function SkillPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requestHeaders = await headers();
  const origin = resolveRequestOrigin(requestHeaders) ?? undefined;

  let errorMessage: string | null = null;
  let model: ReturnType<typeof createSkillDocumentModel> | null = null;

  try {
    const skillConfig = parseSkillConfigSearchParam(params.config);
    model = createSkillDocumentModel(skillConfig, origin);
  } catch (error) {
    if (error instanceof SkillDocumentError) {
      errorMessage = error.message;
    } else {
      errorMessage = "生成 Skill 文档时发生未知错误，请稍后重试。";
    }
  }

  if (errorMessage || !model) {
    return <ErrorState message={errorMessage ?? "生成 Skill 文档时发生未知错误，请稍后重试。"} />;
  }

  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        <section className="fridge-hero">
          <div className="relative z-10 flex flex-wrap items-center gap-3 text-sm font-medium">
            <span className="fridge-chip fridge-chip--ocean">Skill</span>
            <span className="fridge-chip">{model.backupModeLabel}</span>
            <span className="fridge-chip fridge-chip--coral">{model.config.iceBoxName}</span>
          </div>

          <div className="relative z-10 grid gap-4 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
            <div className="space-y-3">
              <p className="fridge-kicker">Deliverable</p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{model.config.iceBoxName} 的 Skill 文档</h1>
              <p className="max-w-3xl text-base leading-7 text-zinc-600 dark:text-zinc-300 sm:text-lg">
                这个页面会输出可直接保存为 <code>SKILL.md</code> 的 Markdown 文档，同时把安装路径、Skill 链接、对应备份方案说明和恢复前后需要知道的关键参数都放齐。
              </p>
            </div>

            <div className="fridge-panel-tint relative z-10 grid gap-3 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
              <p>ice-box-id：`{model.config.iceBoxId}`</p>
              <p>machine-id：`{model.config.machineId}`</p>
              <p>安装路径：`{model.installPath}`</p>
              <p>Git 认证：{model.gitAuthLabel}</p>
              <p>
                上传加密：
                {model.config.backupMode === "upload-token"
                  ? isEncryptionEnabled(model.config.encryption)
                    ? "已启用 AES-256-GCM"
                    : "未启用"
                  : "不适用"}
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="fridge-panel grid gap-4">
            <h2 className="text-2xl font-semibold">安装指导</h2>
            <div className="fridge-step-grid xl:grid-cols-1">
              <div className="fridge-step-card">
                <div className="mb-2 flex items-center gap-3">
                  <span className="fridge-step-number">1</span>
                  <p className="font-semibold text-zinc-950 dark:text-zinc-50">创建目录</p>
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">`~/.openclaw/skills/{model.skillName}/`</p>
              </div>
              <div className="fridge-step-card">
                <div className="mb-2 flex items-center gap-3">
                  <span className="fridge-step-number">2</span>
                  <p className="font-semibold text-zinc-950 dark:text-zinc-50">保存文件</p>
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">将下方 Markdown 原文保存到 `{model.installPath}`。</p>
              </div>
              <div className="fridge-step-card">
                <div className="mb-2 flex items-center gap-3">
                  <span className="fridge-step-number">3</span>
                  <p className="font-semibold text-zinc-950 dark:text-zinc-50">重新加载</p>
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">保持文件名为 `SKILL.md`，新开一个 OpenClaw 会话确认 Skill 被加载。</p>
              </div>
            </div>
          </div>

          <div className="fridge-panel grid gap-4">
            <h2 className="text-2xl font-semibold">连接信息</h2>
            <dl className="fridge-detail-list text-zinc-600 dark:text-zinc-300">
              <div className="fridge-detail-item">
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Git 仓库</dt>
                <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{model.config.repository}</dd>
              </div>
              <div className="fridge-detail-item">
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">目标分支</dt>
                <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{model.config.branch}</dd>
              </div>
              {model.skillLink ? (
                <div className="fridge-detail-item">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Skill 链接</dt>
                  <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{model.skillLink}</dd>
                </div>
              ) : null}
              {model.config.backupMode === "upload-token" ? (
                <>
                  <div className="fridge-detail-item">
                    <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">上传地址</dt>
                    <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{model.uploadUrl ?? "未生成"}</dd>
                  </div>
                  <div className="fridge-state fridge-state--warning">
                    <dt className="text-xs uppercase tracking-[0.18em]">上传 Token</dt>
                    <dd className="mt-2 break-all font-mono text-xs">{model.config.uploadToken}</dd>
                  </div>
                  <div className="fridge-detail-item">
                    <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">上传加密</dt>
                    <dd className="mt-2 text-sm text-zinc-900 dark:text-zinc-100">
                      {isEncryptionEnabled(model.config.encryption) ? "已启用 AES-256-GCM / PBKDF2-SHA256" : "未启用"}
                    </dd>
                    {isEncryptionEnabled(model.config.encryption) ? (
                      <>
                        <dd className="mt-2 break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">Salt：{model.config.encryption.kdfSalt}</dd>
                        <dd className="mt-2 text-xs text-zinc-700 dark:text-zinc-300">Iterations：{model.config.encryption.kdfIterations}</dd>
                        <dd className="mt-2 text-xs text-zinc-700 dark:text-zinc-300">Key Strategy：{model.config.encryption.keyStrategy}</dd>
                      </>
                    ) : null}
                  </div>
                </>
              ) : null}
            </dl>
          </div>
        </section>

        <section className="fridge-panel grid gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Markdown 原文</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                下面这段内容就是最终的 Skill 文档，可直接保存为 <code>SKILL.md</code>。分享前请注意里面是否包含专属上传地址、token 或加密参数。
              </p>
            </div>
            <div className="fridge-chip fridge-chip--ocean">可直接交付</div>
          </div>
          <pre className="overflow-x-auto rounded-[24px] border border-zinc-200 bg-zinc-950 p-5 text-sm leading-6 text-zinc-100 dark:border-white/10">
            {model.markdown}
          </pre>
        </section>
      </div>
    </main>
  );
}

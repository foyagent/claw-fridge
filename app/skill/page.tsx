import Link from "next/link";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { isEncryptionEnabled } from "@/lib/backup-encryption";
import {
  SkillDocumentError,
  createSkillDocumentModel,
  parseIncludeGitCredentialsSearchParam,
  parseOptionalSkillCredentialSearchParam,
  parseSkillConfigSearchParam,
  parseSkillDocumentModeSearchParam,
} from "@/lib/skill-document";
import { buildScheduledBackupDescription } from "@/lib/ice-boxes";

function resolveRequestOrigin(requestHeaders: Headers): string | null {
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";

  if (!host) {
    return null;
  }

  return `${protocol}://${host}`;
}

function ErrorState({ message, t }: { message: string; t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        <section className="fridge-panel grid max-w-3xl gap-6 border-rose-500/20">
          <div className="flex h-16 w-16 items-center justify-center rounded-[24px] bg-[var(--danger-soft)] text-4xl">⚠️</div>
          <div className="space-y-3">
            <p className="fridge-kicker">{t("skillPage.errorKicker")}</p>
            <h1 className="text-3xl font-semibold">{t("skillPage.errorTitle")}</h1>
            <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300 sm:text-base">{message}</p>
          </div>
          <div className="fridge-state fridge-state--warning">{t("skillPage.errorHint")}</div>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/" className="fridge-button-secondary">
              {t("common.backToHome")}
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
  const t = await getTranslations();
  const locale = await getLocale();

  let errorMessage: string | null = null;
  let model: ReturnType<typeof createSkillDocumentModel> | null = null;

  try {
    const skillConfig = parseSkillConfigSearchParam(params.config);
    const mode = parseSkillDocumentModeSearchParam(params.mode);
    const includeGitCredentials = parseIncludeGitCredentialsSearchParam(params.includeGitCredentials);
    const gitUsername = parseOptionalSkillCredentialSearchParam(params.gitUsername);
    const gitToken = parseOptionalSkillCredentialSearchParam(params.gitToken);
    const gitPrivateKeyPath = parseOptionalSkillCredentialSearchParam(params.gitPrivateKeyPath);
    model = createSkillDocumentModel(skillConfig, origin, {
      mode,
      includeGitCredentials,
      gitUsername,
      gitToken,
      gitPrivateKeyPath,
    });
  } catch (error) {
    if (error instanceof SkillDocumentError) {
      errorMessage = error.message;
    } else {
      errorMessage = t("skillPage.unknownError");
    }
  }

  if (errorMessage || !model) {
    return <ErrorState message={errorMessage ?? t("skillPage.unknownError")} t={t} />;
  }

  const modeLabel = model.mode === "restore" ? t("detail.restoreBadge") : t("skillPage.backupMode");

  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        <section className="fridge-hero">
          <div className="relative z-10 flex flex-wrap items-center gap-3 text-sm font-medium">
            <span className="fridge-chip fridge-chip--ocean">Skill</span>
            <span className="fridge-chip">{modeLabel}</span>
            <span className="fridge-chip">{model.backupModeLabel}</span>
            <span className="fridge-chip fridge-chip--coral">{model.config.iceBoxName}</span>
          </div>

          <div className="relative z-10 grid gap-4 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
            <div className="space-y-3">
              <p className="fridge-kicker">{t("skillPage.deliverable")}</p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                {t("skillPage.title", { name: model.config.iceBoxName, mode: modeLabel })}
              </h1>
              <p className="max-w-3xl text-base leading-7 text-zinc-600 dark:text-zinc-300 sm:text-lg">
                {t("skillPage.description")}
              </p>
            </div>

            <div className="fridge-panel-tint relative z-10 grid gap-3 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
              <p>{t("skillPage.iceBoxId")}: `{model.config.iceBoxId}`</p>
              <p>{t("skillPage.machineId")}: `{model.config.machineId}`</p>
              <p>{t("skillPage.documentMode")}: {modeLabel}</p>
              <p>{t("skillPage.installPath")}: `{model.installPath}`</p>
              <p>{t("skillPage.gitAuth")}: {model.gitAuthLabel}</p>
              <p>{t("skillPage.gitCredentialsIncluded")}: {model.includeGitCredentials ? t("skillPage.included") : t("skillPage.notIncluded")}</p>
              <p>{t("skillPage.scheduledBackup")}: {model.config.scheduledBackup.enabled ? buildScheduledBackupDescription(model.config.scheduledBackup, t) : t("detail.noScheduledBackupPreset")}</p>
              <p>
                {t("skillPage.uploadEncryption")}:
                {model.config.backupMode === "upload-token"
                  ? isEncryptionEnabled(model.config.encryption)
                    ? ` ${t("home.create.cryptoLabel")}`
                    : ` ${t("common.disabled")}`
                  : ` ${t("skillPage.notApplicable")}`}
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="fridge-panel grid gap-4">
            <h2 className="text-2xl font-semibold">{t("skillPage.installGuide")}</h2>
            <div className="fridge-step-grid xl:grid-cols-1">
              <div className="fridge-step-card">
                <div className="mb-2 flex items-center gap-3">
                  <span className="fridge-step-number">1</span>
                  <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t("skillPage.createDirectory")}</p>
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">`~/.openclaw/skills/{model.skillName}/`</p>
              </div>
              <div className="fridge-step-card">
                <div className="mb-2 flex items-center gap-3">
                  <span className="fridge-step-number">2</span>
                  <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t("skillPage.saveFile")}</p>
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">{t("skillPage.saveFileDescription", { path: model.installPath })}</p>
              </div>
              <div className="fridge-step-card">
                <div className="mb-2 flex items-center gap-3">
                  <span className="fridge-step-number">3</span>
                  <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t("skillPage.reload")}</p>
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">{t("skillPage.reloadDescription")}</p>
              </div>
            </div>
          </div>

          <div className="fridge-panel grid gap-4">
            <h2 className="text-2xl font-semibold">{t("skillPage.connectionInfo")}</h2>
            <dl className="fridge-detail-list text-zinc-600 dark:text-zinc-300">
              <div className="fridge-detail-item">
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("skillPage.gitRepository")}</dt>
                <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{model.config.repository}</dd>
              </div>
              <div className="fridge-detail-item">
                <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("skillPage.targetBranch")}</dt>
                <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{model.config.branch}</dd>
              </div>
              {model.skillLink ? (
                <div className="fridge-detail-item">
                  <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("skillPage.skillLink")}</dt>
                  <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{model.skillLink}</dd>
                </div>
              ) : null}
              {model.config.backupMode === "upload-token" ? (
                <>
                  <div className="fridge-detail-item">
                    <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.uploadUrl")}</dt>
                    <dd className="mt-2 break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{model.uploadUrl ?? t("common.notGenerated")}</dd>
                  </div>
                  <div className="fridge-state fridge-state--warning">
                    <dt className="text-xs uppercase tracking-[0.18em]">{t("detail.uploadToken")}</dt>
                    <dd className="mt-2 break-all font-mono text-xs">{model.config.uploadToken}</dd>
                  </div>
                  <div className="fridge-detail-item">
                    <dt className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">{t("detail.uploadEncryption")}</dt>
                    <dd className="mt-2 text-sm text-zinc-900 dark:text-zinc-100">
                      {isEncryptionEnabled(model.config.encryption) ? t("detail.encryptionEnabled") : t("common.disabled")}
                    </dd>
                    {isEncryptionEnabled(model.config.encryption) ? (
                      <>
                        <dd className="mt-2 break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">Salt: {model.config.encryption.kdfSalt}</dd>
                        <dd className="mt-2 text-xs text-zinc-700 dark:text-zinc-300">Iterations: {model.config.encryption.kdfIterations.toLocaleString(locale)}</dd>
                        <dd className="mt-2 text-xs text-zinc-700 dark:text-zinc-300">Key Strategy: {model.config.encryption.keyStrategy}</dd>
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
              <h2 className="text-2xl font-semibold">{t("skillPage.markdownTitle")}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{t("skillPage.markdownDescription")}</p>
            </div>
            <div className="fridge-chip fridge-chip--ocean">{t("skillPage.readyToDeliver")}</div>
          </div>
          <pre className="overflow-x-auto rounded-[24px] border border-zinc-200 bg-zinc-950 p-5 text-sm leading-6 text-zinc-100 dark:border-white/10">
            {model.markdown}
          </pre>
        </section>
      </div>
    </main>
  );
}

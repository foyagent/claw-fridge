import {
  createDisabledEncryptionConfig,
  isEncryptionEnabled,
  uploadPayloadEncryptionAlgorithm,
  uploadPayloadEncryptionHeaders,
} from "@/lib/backup-encryption";
import { getGitPlatformAuthHelp } from "@/lib/git-config";
import {
  buildScheduledBackupDescription,
  buildSkillLink,
  buildUploadUrl,
  createDefaultScheduledBackupConfig,
  normalizeScheduledBackupConfig,
} from "@/lib/ice-boxes";
import { getDefaultFilterConfig } from "@/lib/filter-presets";
import {
  formatFilterRulesForMarkdown,
  generateGitExcludeContent,
  generateWhitelistCheckScript,
  resolveFilterPatterns,
} from "@/lib/backup-filter";
import type {
  FilterPattern,
  GitAuthMethod,
  IceBoxBackupMode,
  IceBoxEncryptionConfig,
  IceBoxFilterConfig,
  IceBoxScheduledBackupConfig,
  IceBoxScheduledBackupPreset,
  IceBoxSkillConfig,
  PatternType,
} from "@/types";
import { Base64 } from "js-base64";

type SearchParamValue = string | string[] | undefined;

export type SkillDocumentErrorCode =
  | "missing-config"
  | "invalid-config"
  | "invalid-json"
  | "invalid-field"
  | "unsupported-mode";

export class SkillDocumentError extends Error {
  constructor(
    public readonly code: SkillDocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillDocumentError";
  }
}

export type SkillDocumentMode = "backup" | "restore";

export interface SkillDocumentOptions {
  mode?: SkillDocumentMode;
  includeGitCredentials?: boolean;
  gitUsername?: string | null;
  gitToken?: string | null;
  gitPrivateKeyPath?: string | null;
}

export interface SkillDocumentModel {
  skillName: string;
  installPath: string;
  skillLink: string | null;
  uploadUrl: string | null;
  recoveryScriptUrl: string | null;
  backupModeLabel: string;
  gitAuthLabel: string;
  markdown: string;
  mode: SkillDocumentMode;
  includeGitCredentials: boolean;
  config: IceBoxSkillConfig;
}

const backupModeLabels: Record<IceBoxBackupMode, string> = {
  "git-branch": "Git 直接推送",
  "upload-token": "压缩包上传",
};

const gitAuthLabels: Record<GitAuthMethod, string> = {
  none: "无需认证 / 本地仓库",
  "https-token": "HTTPS Token",
  "ssh-key": "SSH Key",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isBackupMode(value: unknown): value is IceBoxBackupMode {
  return value === "git-branch" || value === "upload-token";
}

function isGitAuthMethod(value: unknown): value is GitAuthMethod {
  return value === "none" || value === "https-token" || value === "ssh-key";
}

function isScheduledBackupPreset(value: unknown): value is IceBoxScheduledBackupPreset {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "custom-cron";
}

function readEncryptionConfig(value: unknown, createdAt: string): IceBoxEncryptionConfig {
  if (!isRecord(value)) {
    return createDisabledEncryptionConfig(createdAt);
  }

  const enabled = value.enabled === true;
  const kdfSalt = isNullableString(value.kdfSalt) ? value.kdfSalt?.trim() || null : null;
  const keyHint = isNullableString(value.keyHint) ? value.keyHint?.trim() || null : null;
  const updatedAt = isNonEmptyString(value.updatedAt) ? value.updatedAt.trim() : createdAt;
  const kdfIterations = typeof value.kdfIterations === "number" && Number.isFinite(value.kdfIterations)
    ? Math.max(100_000, Math.floor(value.kdfIterations))
    : 210_000;

  return {
    version: 1,
    enabled,
    scope: "upload-payload",
    algorithm: "aes-256-gcm",
    kdf: "pbkdf2-sha256",
    kdfSalt: enabled ? kdfSalt : null,
    kdfIterations,
    keyStrategy: "manual-entry",
    keyHint,
    updatedAt,
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (!isNonEmptyString(value)) {
    throw new SkillDocumentError("invalid-field", `字段 ${key} 缺失或格式不正确。`);
  }

  return value.trim();
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  if (!isNullableString(value)) {
    throw new SkillDocumentError("invalid-field", `字段 ${key} 必须是字符串或 null。`);
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim();

  return normalizedValue || null;
}

function readScheduledBackupConfig(value: unknown): IceBoxScheduledBackupConfig {
  if (!isRecord(value)) {
    return createDefaultScheduledBackupConfig();
  }

  return normalizeScheduledBackupConfig({
    enabled: value.enabled === true,
    preset: isScheduledBackupPreset(value.preset) ? value.preset : undefined,
    time: typeof value.time === "string" ? value.time : undefined,
    dayOfWeek: typeof value.dayOfWeek === "number" ? value.dayOfWeek : undefined,
    dayOfMonth: typeof value.dayOfMonth === "number" ? value.dayOfMonth : undefined,
    cronExpression: typeof value.cronExpression === "string" ? value.cronExpression : undefined,
    timezone: typeof value.timezone === "string" ? value.timezone : undefined,
  });
}

function normalizeFilterPattern(value: unknown): FilterPattern | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!isNonEmptyString(value.pattern)) {
    return null;
  }

  const type: PatternType = value.type === "regex" ? "regex" : "glob";

  return {
    pattern: value.pattern.trim(),
    type,
    description: isNonEmptyString(value.description) ? value.description.trim() : undefined,
  };
}

function normalizeFilterConfig(value: unknown): IceBoxFilterConfig {
  const defaults = getDefaultFilterConfig();

  if (!isRecord(value)) {
    return defaults;
  }

  const mode = value.mode === "disabled" || value.mode === "blacklist" || value.mode === "whitelist"
    ? value.mode
    : defaults.mode;

  const patterns = Array.isArray(value.patterns)
    ? value.patterns
        .map((pattern) => normalizeFilterPattern(pattern))
        .filter((pattern): pattern is FilterPattern => pattern !== null)
    : defaults.patterns;

  const presets = Array.isArray(value.presets)
    ? Array.from(
        new Set(
          value.presets
            .filter((preset): preset is string => isNonEmptyString(preset))
            .map((preset) => preset.trim()),
        ),
      )
    : defaults.presets;

  const inheritGitignore = typeof value.inheritGitignore === "boolean"
    ? value.inheritGitignore
    : defaults.inheritGitignore;

  return {
    mode,
    patterns,
    presets,
    inheritGitignore,
  };
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value);
}

function escapeShellValue(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function readFirstSearchParamValue(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseSkillDocumentModeSearchParam(value: SearchParamValue): SkillDocumentMode {
  const rawValue = readFirstSearchParamValue(value)?.trim();

  if (!rawValue || rawValue === "backup") {
    return "backup";
  }

  if (rawValue === "restore") {
    return "restore";
  }

  throw new SkillDocumentError("invalid-field", "`mode` 参数不合法，只支持 `backup` 或 `restore`。");
}

export function parseIncludeGitCredentialsSearchParam(value: SearchParamValue): boolean {
  const rawValue = readFirstSearchParamValue(value)?.trim().toLowerCase();

  return rawValue === "1" || rawValue === "true" || rawValue === "yes" || rawValue === "on";
}

export function parseOptionalSkillCredentialSearchParam(value: SearchParamValue): string | null {
  const rawValue = readFirstSearchParamValue(value);

  if (typeof rawValue !== "string") {
    return null;
  }

  const normalizedValue = rawValue.trim();
  return normalizedValue || null;
}

function toSkillNameSegment(value: string): string {
  const normalizedValue = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");

  return normalizedValue || "ice-box";
}

function buildSkillName(config: IceBoxSkillConfig): string {
  return `claw-fridge-${toSkillNameSegment(config.iceBoxId)}`;
}

function buildLaunchAgentLabel(config: IceBoxSkillConfig): string {
  return `com.claw.fridge.${toSkillNameSegment(config.iceBoxId)}`;
}

function buildScriptBaseName(config: IceBoxSkillConfig): string {
  return toSkillNameSegment(config.iceBoxId);
}

function buildScriptsDirectory(): string {
  return "~/.openclaw/claw-fridge";
}

function buildSetupScriptPath(config: IceBoxSkillConfig): string {
  return `${buildScriptsDirectory()}/setup-${buildScriptBaseName(config)}.sh`;
}

function buildSyncScriptPath(config: IceBoxSkillConfig): string {
  return `${buildScriptsDirectory()}/sync-${buildScriptBaseName(config)}.sh`;
}

function buildSyncLogPath(config: IceBoxSkillConfig): string {
  return `${buildScriptsDirectory()}/sync-${buildScriptBaseName(config)}.log`;
}

function buildSystemdUnitBaseName(config: IceBoxSkillConfig): string {
  return `claw-fridge-${buildScriptBaseName(config)}`;
}

function buildSystemdServiceName(config: IceBoxSkillConfig): string {
  return `${buildSystemdUnitBaseName(config)}.service`;
}

function buildSystemdTimerName(config: IceBoxSkillConfig): string {
  return `${buildSystemdUnitBaseName(config)}.timer`;
}

function buildGitAuthNotes(config: IceBoxSkillConfig): string[] {
  if (config.gitAuthMethod === "ssh-key") {
    return [
      "- 当前冰盒使用 `SSH Key` 认证：先确认 `ssh -T <git-host>` 或一次手动 `git ls-remote` 能通过。",
      `- 如果仓库地址没带用户名，默认使用 \`${config.gitUsername ?? "git"}\`。必要时把远程地址改成 \`${config.gitUsername ?? "git"}@host:owner/repo.git\` 这种格式。`,
      ...getGitPlatformAuthHelp(config.repository, "ssh-key").map((line) => `- ${line}`),
    ];
  }

  if (config.gitAuthMethod === "https-token") {
    return [
      "- 当前冰盒使用 `HTTPS Token`：先用系统 credential helper、Git Credential Manager 或平台 PAT 完成一次认证。",
      `- 建议先执行一次 \`git ls-remote ${config.repository}\`，确保系统已经记住凭证，再启用定时任务。`,
      ...getGitPlatformAuthHelp(config.repository, "https-token").map((line) => `- ${line}`),
    ];
  }

  return [
    "- 当前冰盒标记为 `无需认证 / 公共仓库`：若实际仓库需要权限，先补上 SSH Key 或 HTTPS Token，再继续。",
  ];
}

function buildGitSetupScript(config: IceBoxSkillConfig): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"',
    'REMOTE_NAME="${REMOTE_NAME:-claw-fridge}"',
    `REPOSITORY=${escapeShellValue(config.repository)}`,
    `BRANCH=${escapeShellValue(config.branch)}`,
    "",
    'if ! command -v git >/dev/null 2>&1; then',
    '  echo "git 未安装，先安装 Git 再继续。" >&2',
    "  exit 1",
    "fi",
    "",
    'if [ ! -d "$OPENCLAW_DIR" ]; then',
    '  echo "未找到 .openclaw 目录：$OPENCLAW_DIR" >&2',
    "  exit 1",
    "fi",
    "",
    'cd "$OPENCLAW_DIR"',
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init',
    "",
    'if git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then',
    '  git remote set-url "$REMOTE_NAME" "$REPOSITORY"',
    "else",
    '  git remote add "$REMOTE_NAME" "$REPOSITORY"',
    "fi",
    "",
    'git fetch "$REMOTE_NAME" "$BRANCH" >/dev/null 2>&1 || true',
    "",
    'if git show-ref --verify --quiet "refs/remotes/$REMOTE_NAME/$BRANCH"; then',
    '  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then',
    '    git checkout "$BRANCH"',
    "  else",
    '    git checkout -B "$BRANCH" "$REMOTE_NAME/$BRANCH"',
    "  fi",
    '  git branch --set-upstream-to="$REMOTE_NAME/$BRANCH" "$BRANCH" >/dev/null 2>&1 || true',
    "else",
    '  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then',
    '    git checkout "$BRANCH"',
    '  elif git rev-parse --verify HEAD >/dev/null 2>&1; then',
    '    git checkout -B "$BRANCH"',
    "  else",
    '    git checkout --orphan "$BRANCH"',
    "  fi",
    "fi",
    "",
    'git config push.default upstream',
    'git remote -v | grep "^$REMOTE_NAME" || true',
    'git branch --show-current',
    'git status --short',
  ].join("\n");
}

function buildGitSyncScript(config: IceBoxSkillConfig): string {
  const filterConfig = config.filter;
  const resolvedPatterns = filterConfig ? resolveFilterPatterns(filterConfig) : [];
  const gitExcludeContent = filterConfig?.mode === "blacklist" ? generateGitExcludeContent(filterConfig) : "";
  const whitelistCheckScript = filterConfig?.mode === "whitelist" ? generateWhitelistCheckScript(filterConfig) : "";
  const hasRegexPatterns = resolvedPatterns.some((pattern) => pattern.type === "regex");

  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"',
    'REMOTE_NAME="${REMOTE_NAME:-claw-fridge}"',
    `BRANCH=${escapeShellValue(config.branch)}`,
    'TIMESTAMP="$(date \'+%Y-%m-%d %H:%M:%S\')"',
    'COMMIT_MESSAGE="${CLAW_FRIDGE_COMMIT_MESSAGE:-chore: backup .openclaw ${TIMESTAMP}}"',
    "",
    'cd "$OPENCLAW_DIR"',
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1',
    "",
    'CURRENT_BRANCH="$(git branch --show-current)"',
    'if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then',
    '  git checkout "$BRANCH"',
    "fi",
    "",
  ];

  if (filterConfig?.mode === "blacklist") {
    lines.push(
      'TEMP_EXCLUDE_FILE="$(mktemp)"',
      'cleanup() {',
      '  rm -f "$TEMP_EXCLUDE_FILE"',
      '}',
      'trap cleanup EXIT',
      `cat <<'EOF' > "$TEMP_EXCLUDE_FILE"`,
      gitExcludeContent.trimEnd(),
      'EOF',
      '',
    );

    if (hasRegexPatterns) {
      const regexPatterns = resolvedPatterns.filter((pattern) => pattern.type === "regex");
      const hasGlobPatterns = resolvedPatterns.some((pattern) => pattern.type === "glob");
      lines.push('git add -A');
      lines.push(
        ...regexPatterns.flatMap((pattern) => [
          "git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' path; do",
          `  if printf '%s\\n' "$path" | grep -E --quiet ${escapeShellValue(pattern.pattern)}; then`,
          '    git reset -q HEAD -- "$path" 2>/dev/null || true',
          '  fi',
          'done',
        ]),
      );
      if (hasGlobPatterns) {
        lines.push('git add -A -- ":(exclude-from)$TEMP_EXCLUDE_FILE"');
      }
    } else {
      lines.push('git add -A -- ":(exclude-from)$TEMP_EXCLUDE_FILE"');
    }
  } else if (filterConfig?.mode === "whitelist") {
    lines.push(
      whitelistCheckScript.trimEnd(),
      '',
      'git add -A',
      'git reset',
      "git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' path; do",
      '  if matches_whitelist_path "$path"; then',
      '    git add -A -- "$path"',
      '  fi',
      'done',
    );
  } else {
    lines.push('git add -A');
  }

  lines.push(
    'if ! git diff --cached --quiet; then',
    '  git commit -m "$COMMIT_MESSAGE"',
    'fi',
    '',
    'git push -u "$REMOTE_NAME" "HEAD:$BRANCH"',
  );

  return lines.join("\n");
}

function buildLaunchAgentPlist(config: IceBoxSkillConfig): string {
  const launchAgentLabel = buildLaunchAgentLabel(config);
  const syncScriptPath = buildSyncScriptPath(config);
  const syncLogPath = buildSyncLogPath(config);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${launchAgentLabel}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/zsh</string>",
    "    <string>-lc</string>",
    `    <string>mkdir -p ~/.openclaw/claw-fridge &amp;&amp; ${syncScriptPath} &gt;&gt; ${syncLogPath} 2&gt;&amp;1</string>`,
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>StartInterval</key><integer>1800</integer>",
    "</dict>",
    "</plist>",
  ].join("\n");
}

function buildSystemdService(config: IceBoxSkillConfig): string {
  const syncScriptPath = buildSyncScriptPath(config);

  return [
    "[Unit]",
    `Description=Claw-Fridge backup for ${config.iceBoxName}`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${syncScriptPath.replace("~", "%h")}`,
    "WorkingDirectory=%h/.openclaw",
  ].join("\n");
}

function buildSystemdTimer(config: IceBoxSkillConfig): string {
  return [
    "[Unit]",
    `Description=Run Claw-Fridge backup timer for ${config.iceBoxName}`,
    "",
    "[Timer]",
    "OnBootSec=2m",
    "OnUnitActiveSec=30m",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
  ].join("\n");
}

function safelyBuildUploadUrl(origin: string | undefined, uploadPath: string | null): string | null {
  if (!origin) {
    return uploadPath;
  }

  try {
    return buildUploadUrl(origin, uploadPath);
  } catch {
    return null;
  }
}

function safelyBuildSkillLink(origin: string | undefined, config: IceBoxSkillConfig, options?: SkillDocumentOptions): string | null {
  if (!origin) {
    return null;
  }

  try {
    return buildSkillLink(origin, config, options);
  } catch {
    return null;
  }
}

function safelyBuildRecoveryScriptUrl(origin: string | undefined): string | null {
  if (!origin) {
    return null;
  }

  try {
    return new URL("/recovery.sh", origin).toString();
  } catch {
    return null;
  }
}

function buildScheduledBackupCronExpression(config: IceBoxScheduledBackupConfig): string {
  if (config.preset === "daily") {
    const [hour, minute] = config.time.split(":");
    return `${Number(minute)} ${Number(hour)} * * *`;
  }

  if (config.preset === "weekly") {
    const [hour, minute] = config.time.split(":");
    return `${Number(minute)} ${Number(hour)} * * ${config.dayOfWeek}`;
  }

  if (config.preset === "monthly") {
    const [hour, minute] = config.time.split(":");
    return `${Number(minute)} ${Number(hour)} ${config.dayOfMonth} * *`;
  }

  return config.cronExpression;
}

function buildScheduledBackupSection(config: IceBoxSkillConfig): string {
  const scheduledBackup = normalizeScheduledBackupConfig(config.scheduledBackup);

  if (!scheduledBackup.enabled) {
    return [
      "## 定时备份",
      "",
      "- 当前链接没有预设定时备份。安装 Skill 时，OpenClaw 必须主动询问用户是否需要定时逻辑，再决定是否继续配置 `cron`、`launchd` 或 `systemd --user`。",
      "- 如果用户明确不需要，就保持手动执行；不要静默创建任何后台定时任务。",
    ].join("\n");
  }

  return [
    "## 定时备份",
    "",
    `- 已启用定时备份：${buildScheduledBackupDescription(scheduledBackup)}。`,
    `- 预设类型：\`${scheduledBackup.preset}\``,
    `- 预设时区：\`${scheduledBackup.timezone}\``,
    `- 建议 Cron：\`${buildScheduledBackupCronExpression(scheduledBackup)}\``,
    scheduledBackup.preset === "weekly" ? `- 每周执行日：\`${scheduledBackup.dayOfWeek}\`` : null,
    scheduledBackup.preset === "monthly" ? `- 每月执行日：\`${scheduledBackup.dayOfMonth}\`` : null,
    scheduledBackup.preset === "custom-cron" ? `- 自定义 Cron：\`${scheduledBackup.cronExpression}\`` : null,
    "- OpenClaw 在完成定时逻辑配置后，必须明确告知用户：采用了哪种调度方式、何时首次触发、以及如何停用或修改。",
  ].filter(Boolean).join("\n");
}

function buildCredentialPlaceholderSection(config: IceBoxSkillConfig): string[] {
  if (config.gitAuthMethod === "https-token") {
    return [
      "## Git 凭证占位符",
      "",
      "这个 Skill 会优先带上当前页面传入的 Git 凭证；如果没有传入真实值，则保留占位符模板。安装到 OpenClaw 后，请立刻确认并替换成当前机器自己的值：",
      "- `__CLAW_FRIDGE_GIT_USERNAME__`：Git 用户名。",
      "- `__CLAW_FRIDGE_GIT_TOKEN__`：HTTPS Token / PAT / 密码。",
      "- 推荐替换命令：`perl -0pi -e 's/__CLAW_FRIDGE_GIT_USERNAME__/你的用户名/g; s/__CLAW_FRIDGE_GIT_TOKEN__/你的令牌/g' ~/.openclaw/skills/<skill-name>/SKILL.md`",
      "- 替换完成后，用 `grep '__CLAW_FRIDGE_' ~/.openclaw/skills/<skill-name>/SKILL.md` 确认没有残留占位符。",
      "",
      "```bash",
      "export CLAW_FRIDGE_GIT_USERNAME=__CLAW_FRIDGE_GIT_USERNAME__",
      "export CLAW_FRIDGE_GIT_TOKEN=__CLAW_FRIDGE_GIT_TOKEN__",
      "git config credential.helper store",
      "printf 'url=%s\nusername=%s\npassword=%s\n\n' \"${REPOSITORY}\" \"$CLAW_FRIDGE_GIT_USERNAME\" \"$CLAW_FRIDGE_GIT_TOKEN\" | git credential approve",
      "```",
      "",
    ];
  }

  if (config.gitAuthMethod === "ssh-key") {
    return [
      "## Git 凭证占位符",
      "",
      "这个 Skill 会优先带上当前页面传入的 Git 凭证；如果没有传入真实值，则保留占位符模板。安装到 OpenClaw 后，请立刻确认并替换成当前机器自己的值：",
      "- `__CLAW_FRIDGE_GIT_USERNAME__`：SSH 用户名，通常是 `git`。",
      "- `__CLAW_FRIDGE_GIT_PRIVATE_KEY_PATH__`：私钥文件绝对路径，例如 `~/.ssh/id_ed25519`。",
      "- 推荐替换命令：`perl -0pi -e 's/__CLAW_FRIDGE_GIT_USERNAME__/git/g; s#__CLAW_FRIDGE_GIT_PRIVATE_KEY_PATH__#/Users/you/.ssh/id_ed25519#g' ~/.openclaw/skills/<skill-name>/SKILL.md`",
      "- 替换完成后，用 `grep '__CLAW_FRIDGE_' ~/.openclaw/skills/<skill-name>/SKILL.md` 确认没有残留占位符。",
      "",
      "```bash",
      "export GIT_SSH_COMMAND=\"ssh -i __CLAW_FRIDGE_GIT_PRIVATE_KEY_PATH__ -o IdentitiesOnly=yes\"",
      "ssh -T __CLAW_FRIDGE_GIT_USERNAME__@$(printf '%s' \"${REPOSITORY}\" | sed -E 's#^[^@]+@([^:/]+).*#\\1#; t; s#^https?://([^/]+).*#\\1#') || true",
      "```",
      "",
    ];
  }

  return [];
}

function replaceAllPlaceholders(markdown: string, replacements: Array<[string, string | null | undefined]>): string {
  return replacements.reduce((nextMarkdown, [placeholder, value]) => {
    if (!value?.trim()) {
      return nextMarkdown;
    }

    return nextMarkdown.split(placeholder).join(value.trim());
  }, markdown);
}

function applyResolvedGitCredentials(markdown: string, config: IceBoxSkillConfig, options?: SkillDocumentOptions): string {
  if (config.gitAuthMethod === "https-token") {
    return replaceAllPlaceholders(markdown, [
      ["__CLAW_FRIDGE_GIT_USERNAME__", options?.gitUsername],
      ["__CLAW_FRIDGE_GIT_TOKEN__", options?.gitToken],
    ]);
  }

  if (config.gitAuthMethod === "ssh-key") {
    return replaceAllPlaceholders(markdown, [
      ["__CLAW_FRIDGE_GIT_USERNAME__", options?.gitUsername],
      ["__CLAW_FRIDGE_GIT_PRIVATE_KEY_PATH__", options?.gitPrivateKeyPath],
    ]);
  }

  return markdown;
}

function buildGitModeInstructions(config: IceBoxSkillConfig): string {
  const launchAgentLabel = buildLaunchAgentLabel(config);
  const launchAgentPath = `~/Library/LaunchAgents/${launchAgentLabel}.plist`;
  const setupScriptPath = buildSetupScriptPath(config);
  const syncScriptPath = buildSyncScriptPath(config);
  const syncLogPath = buildSyncLogPath(config);
  const systemdServiceName = buildSystemdServiceName(config);
  const systemdTimerName = buildSystemdTimerName(config);
  const systemdServicePath = `~/.config/systemd/user/${systemdServiceName}`;
  const systemdTimerPath = `~/.config/systemd/user/${systemdTimerName}`;
  const cronLine = `*/30 * * * * ${syncScriptPath} >> ${syncLogPath} 2>&1`;

  return [
    "## Git 直推工作流",
    "",
    "1. 先校验基础环境：当前机器要有 `git`，并且 `.openclaw` 目录已经存在。",
    ...buildGitAuthNotes(config),
    "",
    "2. 生成配置脚本：先把下面两个脚本写到本机。",
    "",
    `### 写入 ${setupScriptPath}`,
    "",
    "```bash",
    `mkdir -p ${buildScriptsDirectory()}`,
    `cat <<'EOF' > ${setupScriptPath}`,
    buildGitSetupScript(config),
    "EOF",
    `chmod +x ${setupScriptPath}`,
    "```",
    "",
    `### 写入 ${syncScriptPath}`,
    "",
    "```bash",
    `mkdir -p ${buildScriptsDirectory()}`,
    `cat <<'EOF' > ${syncScriptPath}`,
    buildGitSyncScript(config),
    "EOF",
    `chmod +x ${syncScriptPath}`,
    "```",
    "",
    "3. 执行初始化脚本，让 `.openclaw` 接上专属远程与备份分支：",
    "",
    "```bash",
    setupScriptPath,
    "```",
    "",
    "4. 手动跑一次同步脚本，确认首次备份能成功推上去：",
    "",
    "```bash",
    syncScriptPath,
    "```",
    "",
    "5. 选择一种定时同步方案；macOS 优先 `launchd`，Linux 优先 `systemd --user`，都没有再退回 `cron`。",
    "",
    "### macOS `launchd`",
    "",
    `将下面内容写入 ${launchAgentPath}：`,
    "",
    "```xml",
    buildLaunchAgentPlist(config),
    "```",
    "",
    "启用命令：",
    "",
    "```bash",
    `launchctl bootout gui/$(id -u) ${launchAgentPath} >/dev/null 2>&1 || true`,
    `launchctl bootstrap gui/$(id -u) ${launchAgentPath}`,
    `launchctl kickstart -k gui/$(id -u)/${launchAgentLabel}`,
    "```",
    "",
    "### Linux `systemd --user`",
    "",
    `将下面内容写入 ${systemdServicePath}：`,
    "",
    "```ini",
    buildSystemdService(config),
    "```",
    "",
    `将下面内容写入 ${systemdTimerPath}：`,
    "",
    "```ini",
    buildSystemdTimer(config),
    "```",
    "",
    "启用命令：",
    "",
    "```bash",
    "mkdir -p ~/.config/systemd/user",
    "systemctl --user daemon-reload",
    `systemctl --user enable --now ${systemdTimerName}`,
    `systemctl --user status ${systemdTimerName} --no-pager`,
    "```",
    "",
    "### Linux / 通用 `crontab`",
    "",
    "```bash",
    `(crontab -l 2>/dev/null | grep -F -v ${escapeShellValue(syncScriptPath)}; echo ${escapeShellValue(cronLine)}) | crontab -`,
    "```",
    "",
    "6. 测试和验证：",
    "",
    "```bash",
    "cd ~/.openclaw",
    "git remote -v",
    `git branch -vv | grep ${escapeShellValue(config.branch)}`,
    `${syncScriptPath}; tail -n 20 ${syncLogPath} 2>/dev/null || true`,
    `git ls-remote --heads ${escapeShellValue(config.repository)} ${escapeShellValue(config.branch)}`,
    "```",
    "",
    "7. 定时任务排查：",
    `- \`launchd\`：执行 \`launchctl print gui/$(id -u)/${launchAgentLabel}\` 查看最近一次运行状态。`,
    `- \`systemd --user\`：执行 \`systemctl --user list-timers ${systemdTimerName}\` 与 \`journalctl --user -u ${systemdServiceName} -n 50 --no-pager\`。`,
    `- \`cron\`：执行 \`crontab -l | grep ${config.branch}\`，并检查日志 \`${syncLogPath}\`。`,
    "",
    "8. 如果推送失败，优先检查：仓库地址、认证状态、当前分支是否正确、网络连通性，以及 `.openclaw` 的读写权限。",
  ].join("\n");
}

function buildUploadModeInstructions(config: IceBoxSkillConfig, uploadUrl: string | null): string {
  const resolvedUploadUrl = uploadUrl ?? config.uploadPath ?? "<missing-upload-url>";
  const uploadToken = config.uploadToken ?? "<missing-upload-token>";
  const archivePath = `/tmp/claw-fridge-${config.iceBoxId}.tar.gz`;
  const encryptedArchivePath = `${archivePath}.enc`;
  const responsePath = `/tmp/claw-fridge-${config.iceBoxId}.upload.json`;
  const encryptionMetaPath = `/tmp/claw-fridge-${config.iceBoxId}.encryption.json`;
  const encryptionEnabled = isEncryptionEnabled(config.encryption);

  if (encryptionEnabled) {
    return [
      "## 压缩包上传工作流（启用 AES-256-GCM）",
      "",
      "1. 先校验基础环境：确认当前机器存在 `.openclaw` 目录，并具备 `tar`、`curl`、`node`。主密钥默认不保存在磁盘里，上传时通过环境变量临时提供。",
      "",
      "```bash",
      'test -d "$HOME/.openclaw"',
      "command -v tar",
      "command -v curl",
      "command -v node",
      'test -n "${CLAW_FRIDGE_ENCRYPTION_KEY:-}" || echo "请先 export CLAW_FRIDGE_ENCRYPTION_KEY=..."',
      "```",
      "",
      "2. 打包 `.openclaw` 目录：",
      "",
      "```bash",
      `ARCHIVE_PATH=${escapeShellValue(archivePath)}`,
      'rm -f "$ARCHIVE_PATH"',
      'tar -czf "$ARCHIVE_PATH" -C "$HOME" .openclaw',
      'ls -lh "$ARCHIVE_PATH"',
      "```",
      "",
      "3. 本地执行 AES-256-GCM 加密。当前冰盒固定使用 `PBKDF2-SHA256`，参数如下：",
      `- KDF Salt：\`${config.encryption.kdfSalt ?? "<missing-kdf-salt>"}\``,
      `- KDF Iterations：\`${config.encryption.kdfIterations}\``,
      `- Key Strategy：\`${config.encryption.keyStrategy}\`（默认每次手动输入，不明文持久化）`,
      config.encryption.keyHint ? `- Key Hint：${config.encryption.keyHint}` : "- Key Hint：<none>",
      "",
      "```bash",
      `ARCHIVE_PATH=${escapeShellValue(archivePath)}`,
      `ENCRYPTED_ARCHIVE_PATH=${escapeShellValue(encryptedArchivePath)}`,
      `ENCRYPTION_META_PATH=${escapeShellValue(encryptionMetaPath)}`,
      `CLAW_FRIDGE_KDF_SALT=${escapeShellValue(config.encryption.kdfSalt ?? "")}`,
      `CLAW_FRIDGE_KDF_ITERATIONS=${escapeShellValue(String(config.encryption.kdfIterations))}`,
      'rm -f "$ENCRYPTED_ARCHIVE_PATH" "$ENCRYPTION_META_PATH"',
      "node <<'EOF'",
      "const crypto = require('node:crypto');",
      "const fs = require('node:fs');",
      "const { pipeline } = require('node:stream/promises');",
      "",
      "async function main() {",
      "  const archivePath = process.env.ARCHIVE_PATH;",
      "  const encryptedArchivePath = process.env.ENCRYPTED_ARCHIVE_PATH;",
      "  const encryptionMetaPath = process.env.ENCRYPTION_META_PATH;",
      "  const passphrase = process.env.CLAW_FRIDGE_ENCRYPTION_KEY ?? '';",
      "  const salt = Buffer.from(process.env.CLAW_FRIDGE_KDF_SALT ?? '', 'base64');",
      "  const iterations = Number(process.env.CLAW_FRIDGE_KDF_ITERATIONS ?? '0');",
      "",
      "  if (!archivePath || !encryptedArchivePath || !encryptionMetaPath) throw new Error('缺少归档路径变量。');",
      "  if (!passphrase) throw new Error('缺少 CLAW_FRIDGE_ENCRYPTION_KEY。');",
      "  if (!salt.length) throw new Error('缺少 KDF Salt。');",
      "  if (!Number.isFinite(iterations) || iterations < 100000) throw new Error('KDF Iterations 不合法。');",
      "",
      "  const iv = crypto.randomBytes(12);",
      "  const key = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');",
      "  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);",
      "",
      "  await pipeline(fs.createReadStream(archivePath), cipher, fs.createWriteStream(encryptedArchivePath));",
      "",
      "  const metadata = {",
      `    algorithm: '${uploadPayloadEncryptionAlgorithm}',`,
      "    iv: iv.toString('base64'),",
      "    authTag: cipher.getAuthTag().toString('base64'),",
      "  };",
      "",
      "  fs.writeFileSync(encryptionMetaPath, JSON.stringify(metadata, null, 2));",
      "  console.log(JSON.stringify(metadata));",
      "}",
      "",
      "main().catch((error) => {",
      "  console.error(error instanceof Error ? error.message : String(error));",
      "  process.exit(1);",
      "});",
      "EOF",
      'ls -lh "$ENCRYPTED_ARCHIVE_PATH"',
      'cat "$ENCRYPTION_META_PATH"',
      "```",
      "",
      "4. 上传加密后的压缩包。服务端会用同一把主密钥临时解密，再继续走现有备份流程：",
      "",
      "```bash",
      `ARCHIVE_PATH=${escapeShellValue(archivePath)}`,
      `ENCRYPTED_ARCHIVE_PATH=${escapeShellValue(encryptedArchivePath)}`,
      `ENCRYPTION_META_PATH=${escapeShellValue(encryptionMetaPath)}`,
      `RESPONSE_PATH=${escapeShellValue(responsePath)}`,
      'IV="$(node -p "JSON.parse(require(\'node:fs\').readFileSync(process.env.ENCRYPTION_META_PATH, \'utf8\')).iv")"',
      'AUTH_TAG="$(node -p "JSON.parse(require(\'node:fs\').readFileSync(process.env.ENCRYPTION_META_PATH, \'utf8\')).authTag")"',
      'rm -f "$RESPONSE_PATH"',
      `curl --progress-bar --show-error --fail -X POST ${escapeShellValue(resolvedUploadUrl)} \\
  -H ${escapeShellValue(`Authorization: Bearer ${uploadToken}`)} \\
  -H ${escapeShellValue(`${uploadPayloadEncryptionHeaders.algorithm}: ${uploadPayloadEncryptionAlgorithm}`)} \\
  -H ${escapeShellValue(`${uploadPayloadEncryptionHeaders.iv}: $IV`)} \\
  -H ${escapeShellValue(`${uploadPayloadEncryptionHeaders.authTag}: $AUTH_TAG`)} \\
  -H ${escapeShellValue(`${uploadPayloadEncryptionHeaders.passphrase}: $CLAW_FRIDGE_ENCRYPTION_KEY`)} \\
  -F ${escapeShellValue(`iceBoxId=${config.iceBoxId}`)} \\
  -F ${escapeShellValue(`file=@${encryptedArchivePath}`)} \\
  -o "$RESPONSE_PATH" \\
  -w '\nHTTP %{http_code}\nUploaded %{size_upload} bytes in %{time_total}s\n'`,
      'cat "$RESPONSE_PATH"',
      "```",
      "",
      "5. 成功后重点核对返回结果里的 `ok`、`branch`、`bytesReceived`、`commit`、`lastBackupAt`。如果服务端提示解密失败，优先检查主密钥、IV / Auth Tag 和 KDF 参数是否对应同一批密文。",
      "",
      "6. 风险提示：",
      "- 默认不保存主密钥；Claw-Fridge 只保存 Salt / Iterations / 可选 Hint，用于约束加密参数。",
      "- 上传命令会把主密钥放进请求头，因此请尽量在 `HTTPS` 或可信局域网中使用，不要把命令历史或终端日志公开出去。",
      "- 一旦主密钥遗失，这条加密上传链路将无法继续解密后续备份。",
      "",
      "7. 常见错误处理：",
      "- `400 当前冰盒要求加密上传`：漏传了加密请求头，或上传了未加密文件。",
      "- `400 上传密钥无效，或加密文件已经损坏`：主密钥不对，或者 `IV` / `Auth Tag` 与密文不匹配。",
      "- `401 缺少加密上传主密钥`：未设置 `CLAW_FRIDGE_ENCRYPTION_KEY`。",
      "- `410 Gone` / `上传 token 已过期` / `已撤销`：回到 Claw-Fridge 重新生成新的上传地址和 token。",
      "- `413 Payload Too Large`：密文大小超过限制；先清理归档或改用 Git 直推方案。",
      "",
      "8. 若只想重试网络上传，不需要重新打包；但如果 `.openclaw` 目录已经变化，请重新打包、重新加密，再上传最新归档。",
    ].join("\n");
  }

  return [
    "## 压缩包上传工作流",
    "",
    "1. 先校验基础环境：确认当前机器存在 `.openclaw` 目录，并具备 `tar` 与 `curl`。不要把 token 打到公开日志里。",
    "",
    "```bash",
    'test -d "$HOME/.openclaw"',
    "command -v tar",
    "command -v curl",
    "```",
    "",
    "2. 打包 `.openclaw` 目录：",
    "",
    "```bash",
    `ARCHIVE_PATH=${escapeShellValue(archivePath)}`,
    'rm -f "$ARCHIVE_PATH"',
    'tar -czf "$ARCHIVE_PATH" -C "$HOME" .openclaw',
    'ls -lh "$ARCHIVE_PATH"',
    "```",
    "",
    "3. 先做一次压缩包自检，确认归档里真的包含 `.openclaw`：",
    "",
    "```bash",
    `ARCHIVE_PATH=${escapeShellValue(archivePath)}`,
    'tar -tzf "$ARCHIVE_PATH" | head -n 20',
    'tar -tzf "$ARCHIVE_PATH" | grep -E "^\\.openclaw(/|$)" >/dev/null',
    "```",
    "",
    "4. 上传压缩包，并显示进度条与服务端返回结果：",
    "",
    "```bash",
    `ARCHIVE_PATH=${escapeShellValue(archivePath)}`,
    `RESPONSE_PATH=${escapeShellValue(responsePath)}`,
    'rm -f "$RESPONSE_PATH"',
    `curl --progress-bar --show-error --fail -X POST ${escapeShellValue(resolvedUploadUrl)} \\\n  -H ${escapeShellValue(`Authorization: Bearer ${uploadToken}`)} \\\n  -F ${escapeShellValue(`iceBoxId=${config.iceBoxId}`)} \\\n  -F ${escapeShellValue(`file=@${archivePath}`)} \\\n  -o "$RESPONSE_PATH" \\\n  -w '\nHTTP %{http_code}\nUploaded %{size_upload} bytes in %{time_total}s\n'`,
    'cat "$RESPONSE_PATH"',
    "```",
    "",
    "5. 成功后重点核对返回结果里的 `ok`、`branch`、`bytesReceived`、`commit`、`lastBackupAt`；这些字段能直接说明备份是否真正落到了目标冰盒。",
    "",
    "6. 常见错误处理：",
    "- `401 Unauthorized` / `上传 token 无效`：重新复制 token，确认请求头使用 `Authorization: Bearer <token>`。",
    "- `410 Gone` / `上传 token 已过期` / `已撤销`：回到 Claw-Fridge 重新生成新的上传地址和 token。",
    "- `400` / `422`：通常是归档格式不对，或压缩包里缺少 `.openclaw` 顶层目录；重新执行上面的自检命令。",
    "- `413 Payload Too Large`：压缩包超限；先清理不必要的大文件，或改用 Git 直推方案。",
    "- `5xx` / 网络错误：先检查 Claw-Fridge 服务是否可达，再原样重试上传命令。",
    "",
    "7. 重试建议：如果打包已经完成且本地 `.tar.gz` 没变，优先只重试上传步骤；只有在 `.openclaw` 内容更新后，才重新打包再上传。",
    "",
    "```bash",
    `curl --progress-bar --show-error --fail -X POST ${escapeShellValue(resolvedUploadUrl)} \\\n  -H ${escapeShellValue(`Authorization: Bearer ${uploadToken}`)} \\\n  -F ${escapeShellValue(`iceBoxId=${config.iceBoxId}`)} \\\n  -F ${escapeShellValue(`file=@${archivePath}`)}`,
    "```",
    "",
    "8. 如果用户希望低频自动备份，可按需补一个 `cron`、`launchd` 或 `systemd --user` 定时任务，但默认不要静默创建。",
  ].join("\n");
}

function buildRestoreModeInstructions(
  config: IceBoxSkillConfig,
  recoveryScriptUrl: string | null,
  includeGitCredentials: boolean,
): string {
  const resolvedRecoveryScriptUrl = recoveryScriptUrl ?? "<missing-recovery-script-url>";
  const targetRootPlaceholder = "/absolute/path/to/target-root";
  const recoveryCommandParts = [
    `curl -fsSL ${escapeShellValue(resolvedRecoveryScriptUrl)} | bash -s --`,
    `  --repository ${escapeShellValue(config.repository)}`,
    `  --machine-id ${escapeShellValue(config.machineId)}`,
    `  --branch ${escapeShellValue(config.branch)}`,
    `  --target-dir ${escapeShellValue(targetRootPlaceholder)}`,
  ];

  if (config.gitAuthMethod === "https-token") {
    recoveryCommandParts.push(`  --username ${escapeShellValue(includeGitCredentials ? "__CLAW_FRIDGE_GIT_USERNAME__" : "<your-git-username>")}`);
    recoveryCommandParts.push(`  --token ${escapeShellValue(includeGitCredentials ? "__CLAW_FRIDGE_GIT_TOKEN__" : "<your-git-token>")}`);
  }

  if (config.gitAuthMethod === "ssh-key") {
    recoveryCommandParts.push(`  --ssh-key ${escapeShellValue(includeGitCredentials ? "__CLAW_FRIDGE_GIT_PRIVATE_KEY_PATH__" : "<your-private-key-path>")}`);
  }

  return [
    "## 恢复工作流",
    "",
    "1. 这个 Skill 用于把远端冰盒快照恢复回本机 `.openclaw`。默认恢复到你指定目录下的 `.openclaw`，不会直接写系统根目录。",
    "2. 新机器 / 空环境建议直接执行下面的一键恢复命令：",
    "",
    "```bash",
    recoveryCommandParts.join(" \\\n"),
    "```",
    "",
    "3. `--target-dir` 必须传 `.openclaw` 的父目录；例如想恢复到 `/Users/claw/.openclaw`，这里就填 `/Users/claw`。",
    "4. 如果要回滚到某个历史版本，可额外加 `--commit <hash>`。脚本会先备份目标目录里已有的 `.openclaw`，再覆盖恢复。",
    "5. 恢复后建议立即验证：",
    "",
    "```bash",
    "test -d \"<target-dir>/.openclaw\"",
    "find \"<target-dir>/.openclaw\" -maxdepth 2 | head -n 20",
    "```",
    "",
    "6. 若当前机器已经在用 OpenClaw，也可以把 `--target-dir` 指向当前工作目录的父目录，执行后重启 OpenClaw 即可。",
  ].concat(includeGitCredentials ? ["", ...buildCredentialPlaceholderSection(config)] : []).join("\n");
}

export function parseSkillConfig(value: unknown): IceBoxSkillConfig {
  if (!isRecord(value)) {
    throw new SkillDocumentError("invalid-config", "Skill 配置不是合法对象。");
  }

  if (value.version !== 1) {
    throw new SkillDocumentError("invalid-field", "当前只支持 `version: 1` 的 Skill 配置。");
  }

  const backupMode = value.backupMode;

  if (!isBackupMode(backupMode)) {
    throw new SkillDocumentError("unsupported-mode", "不支持的备份方案。");
  }

  const gitAuthMethod = value.gitAuthMethod;

  if (!isGitAuthMethod(gitAuthMethod)) {
    throw new SkillDocumentError("invalid-field", "Git 认证方式不正确。");
  }

  const createdAt = readRequiredString(value, "createdAt");
  const skillConfig: IceBoxSkillConfig = {
    version: 1,
    iceBoxId: readRequiredString(value, "iceBoxId"),
    iceBoxName: readRequiredString(value, "iceBoxName"),
    machineId: readRequiredString(value, "machineId"),
    backupMode,
    repository: readRequiredString(value, "repository"),
    branch: readRequiredString(value, "branch"),
    gitAuthMethod,
    gitUsername: readNullableString(value, "gitUsername"),
    uploadPath: readNullableString(value, "uploadPath"),
    uploadToken: readNullableString(value, "uploadToken"),
    scheduledBackup: readScheduledBackupConfig(value.scheduledBackup),
    encryption: readEncryptionConfig(value.encryption, createdAt),
    filter: isRecord(value.filter) ? normalizeFilterConfig(value.filter) : undefined,
    createdAt,
  };

  if (skillConfig.backupMode === "upload-token") {
    if (!skillConfig.uploadPath || !skillConfig.uploadToken) {
      throw new SkillDocumentError("invalid-field", "压缩包上传模式必须包含上传地址和 token。");
    }
  }

  return skillConfig;
}

export function parseSkillConfigSearchParam(config: SearchParamValue): IceBoxSkillConfig {
  const rawValue = Array.isArray(config) ? config[0] : config;

  if (!rawValue?.trim()) {
    throw new SkillDocumentError("missing-config", "缺少 `config` 参数，暂时无法生成 Skill 文档。");
  }

  let decodedValue = rawValue;

  try {
    decodedValue = Base64.decode(rawValue);
  } catch {
    decodedValue = rawValue;
  }

  try {
    return parseSkillConfig(JSON.parse(decodedValue));
  } catch (error) {
    if (error instanceof SkillDocumentError) {
      throw error;
    }

    try {
      return parseSkillConfig(JSON.parse(rawValue));
    } catch (legacyError) {
      if (legacyError instanceof SkillDocumentError) {
        throw legacyError;
      }

      throw new SkillDocumentError("invalid-json", "`config` 不是合法 JSON，无法解析 Skill 配置。");
    }
  }
}

export function buildSkillMarkdown(config: IceBoxSkillConfig, origin?: string, options?: SkillDocumentOptions): string {
  const mode = options?.mode ?? "backup";
  const includeGitCredentials = options?.includeGitCredentials === true;
  const skillName = mode === "restore" ? `${buildSkillName(config)}-restore` : buildSkillName(config);
  const skillLink = safelyBuildSkillLink(origin, config, options);
  const uploadUrl = safelyBuildUploadUrl(origin, config.uploadPath);
  const recoveryScriptUrl = safelyBuildRecoveryScriptUrl(origin);

  const description =
    mode === "restore"
      ? `Restore Claw-Fridge Ice Box ${config.iceBoxName} (${config.iceBoxId}) from branch ${config.branch} in ${config.repository} back into a local .openclaw directory. Use when the user asks to recover this Ice Box onto a new machine, overwrite an existing local clone, or roll back to a previous backup snapshot.`
      : config.backupMode === "git-branch"
        ? `Back up the current machine's .openclaw directory for Claw-Fridge Ice Box ${config.iceBoxName} (${config.iceBoxId}) by pushing to branch ${config.branch} in ${config.repository}. Use when the user asks to configure upstream, switch to the dedicated branch, run a backup, or set scheduled Git sync for this Ice Box.`
        : `Back up the current machine's .openclaw directory for Claw-Fridge Ice Box ${config.iceBoxName} (${config.iceBoxId}) by creating a tar.gz archive and uploading it to the dedicated Claw-Fridge endpoint. Use when the user asks to package, upload, or validate archive backups for this Ice Box.`;

  const contextLines = [
    mode === "restore" ? "# Claw-Fridge Ice Box Restore" : "# Claw-Fridge Ice Box Backup",
    "",
    "## Context",
    `- Ice Box Name: \`${config.iceBoxName}\``,
    `- ice-box-id: \`${config.iceBoxId}\``,
    `- machine-id: \`${config.machineId}\``,
    `- backup-mode: \`${config.backupMode}\``,
    `- repository: \`${config.repository}\``,
    `- branch: \`${config.branch}\``,
    `- git-auth-method: \`${config.gitAuthMethod}\``,
    `- git-username: ${config.gitUsername ? `\`${config.gitUsername}\`` : "`<none>`"}`,
    `- created-at: \`${config.createdAt}\``,
    `- document-mode: \`${mode}\``,
    `- include-git-credentials-placeholders: \`${includeGitCredentials ? "true" : "false"}\``,
    `- scheduled-backup-enabled: \`${config.scheduledBackup.enabled ? "true" : "false"}\``,
    `- scheduled-backup-summary: ${config.scheduledBackup.enabled ? `\`${buildScheduledBackupDescription(config.scheduledBackup)}\`` : "`<ask-user-during-install>`"}`,
    `- filter-mode: \`${config.filter?.mode ?? "disabled"}\``,
    `- filter-presets: ${config.filter?.presets?.length ? config.filter.presets.join(", ") : "<none>"}`,
  ];

  if (skillLink) {
    contextLines.push(`- skill-link: ${skillLink}`);
  }

  if (recoveryScriptUrl) {
    contextLines.push(`- recovery-script-url: ${recoveryScriptUrl}`);
  }

  if (config.backupMode === "upload-token") {
    contextLines.push(`- upload-url: ${uploadUrl ?? "<missing-upload-url>"}`);
    contextLines.push(`- upload-token: \`${config.uploadToken ?? "<missing-upload-token>"}\``);
    contextLines.push(`- upload-encryption-enabled: \`${isEncryptionEnabled(config.encryption) ? "true" : "false"}\``);

    if (isEncryptionEnabled(config.encryption)) {
      contextLines.push(`- upload-encryption-algorithm: \`${config.encryption.algorithm}\``);
      contextLines.push(`- upload-encryption-kdf: \`${config.encryption.kdf}\``);
      contextLines.push(`- upload-encryption-kdf-salt: \`${config.encryption.kdfSalt ?? "<missing-kdf-salt>"}\``);
      contextLines.push(`- upload-encryption-kdf-iterations: \`${config.encryption.kdfIterations}\``);
      contextLines.push(`- upload-encryption-key-strategy: \`${config.encryption.keyStrategy}\``);
      contextLines.push(`- upload-encryption-key-hint: ${config.encryption.keyHint ? `\`${config.encryption.keyHint}\`` : "`<none>`"}`);
    }
  }

  const sections = [
    contextLines.join("\n"),
    "",
    "## Guardrails",
    "- Work only inside the user's `.openclaw` directory unless the user explicitly says otherwise.",
    "- Do not delete backups, branches, or remote files unless the user clearly asks.",
    "- Explain missing prerequisites before attempting write operations.",
    mode === "restore"
      ? "- Before overwrite restore, explain the target path and confirm whether the existing `.openclaw` should be backed up first."
      : "- After each backup attempt, report the branch, destination, and any actionable errors.",
    "",
    buildScheduledBackupSection(config),
  ];

  if (config.filter && config.filter.mode !== "disabled") {
    sections.push("", formatFilterRulesForMarkdown(config.filter));
  }

  sections.push(
    "",
    mode === "restore"
      ? buildRestoreModeInstructions(config, recoveryScriptUrl, includeGitCredentials)
      : config.backupMode === "git-branch"
        ? [buildGitModeInstructions(config), ...(includeGitCredentials ? ["", ...buildCredentialPlaceholderSection(config)] : [])].join("\n")
        : [buildUploadModeInstructions(config, uploadUrl), ...(includeGitCredentials ? ["", ...buildCredentialPlaceholderSection(config)] : [])].join("\n"),
  );

  const body = sections.join("\n");

  const resolvedBody = includeGitCredentials ? applyResolvedGitCredentials(body, config, options) : body;

  return [
    "---",
    `name: ${skillName}`,
    `description: ${escapeYamlString(description)}`,
    "---",
    "",
    resolvedBody,
    "",
  ].join("\n");
}

export function createSkillDocumentModel(
  config: IceBoxSkillConfig,
  origin?: string,
  options?: SkillDocumentOptions,
): SkillDocumentModel {
  const mode = options?.mode ?? "backup";
  const includeGitCredentials = options?.includeGitCredentials === true;
  const skillName = mode === "restore" ? `${buildSkillName(config)}-restore` : buildSkillName(config);
  const skillLink = safelyBuildSkillLink(origin, config, options);
  const uploadUrl = safelyBuildUploadUrl(origin, config.uploadPath);
  const recoveryScriptUrl = safelyBuildRecoveryScriptUrl(origin);

  return {
    skillName,
    installPath: `~/.openclaw/skills/${skillName}/SKILL.md`,
    skillLink,
    uploadUrl,
    recoveryScriptUrl,
    backupModeLabel: backupModeLabels[config.backupMode],
    gitAuthLabel: gitAuthLabels[config.gitAuthMethod],
    markdown: buildSkillMarkdown(config, origin, options),
    mode,
    includeGitCredentials,
    config,
  };
}

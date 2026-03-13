import type {
  IceBoxBackupMode,
  IceBoxListItem,
  IceBoxScheduledBackupConfig,
  IceBoxSkillConfig,
  IceBoxStatus,
  IceBoxSyncStatus,
} from "@/types";

export interface BuildSkillLinkOptions {
  mode?: "backup" | "restore";
  includeGitCredentials?: boolean;
  gitUsername?: string | null;
  gitToken?: string | null;
  gitPrivateKeyPath?: string | null;
}

type Translator = (key: string, values?: Record<string, string | number>) => string;

export function createDefaultScheduledBackupConfig(timezone?: string): IceBoxScheduledBackupConfig {
  return {
    enabled: false,
    preset: "daily",
    time: "03:00",
    dayOfWeek: 1,
    dayOfMonth: 1,
    cronExpression: "0 3 * * *",
    timezone: timezone?.trim() || "Asia/Shanghai",
  };
}

export function normalizeScheduledBackupConfig(config: Partial<IceBoxScheduledBackupConfig> | null | undefined): IceBoxScheduledBackupConfig {
  const fallback = createDefaultScheduledBackupConfig(config?.timezone);

  return {
    enabled: config?.enabled === true,
    preset:
      config?.preset === "daily" ||
      config?.preset === "weekly" ||
      config?.preset === "monthly" ||
      config?.preset === "custom-cron"
        ? config.preset
        : fallback.preset,
    time: typeof config?.time === "string" && /^\d{2}:\d{2}$/.test(config.time) ? config.time : fallback.time,
    dayOfWeek:
      typeof config?.dayOfWeek === "number" && Number.isFinite(config.dayOfWeek)
        ? Math.min(7, Math.max(1, Math.round(config.dayOfWeek)))
        : fallback.dayOfWeek,
    dayOfMonth:
      typeof config?.dayOfMonth === "number" && Number.isFinite(config.dayOfMonth)
        ? Math.min(28, Math.max(1, Math.round(config.dayOfMonth)))
        : fallback.dayOfMonth,
    cronExpression:
      typeof config?.cronExpression === "string" && config.cronExpression.trim()
        ? config.cronExpression.trim()
        : fallback.cronExpression,
    timezone: typeof config?.timezone === "string" && config.timezone.trim() ? config.timezone.trim() : fallback.timezone,
  };
}

export function buildScheduledBackupDescription(config: IceBoxScheduledBackupConfig, t?: Translator) {
  if (!t) {
    if (!config.enabled) return "Disabled";
    if (config.preset === "daily") return `Daily ${config.time} (${config.timezone})`;
    if (config.preset === "weekly") return `Weekly ${config.dayOfWeek} ${config.time} (${config.timezone})`;
    if (config.preset === "monthly") return `Monthly ${config.dayOfMonth} ${config.time} (${config.timezone})`;
    return `Custom cron: ${config.cronExpression} (${config.timezone})`;
  }

  if (!config.enabled) {
    return t("detail.noScheduledBackupPreset");
  }

  if (config.preset === "daily") {
    return t("detail.scheduleDescriptionDaily", { time: config.time, timezone: config.timezone });
  }

  if (config.preset === "weekly") {
    return t("detail.scheduleDescriptionWeekly", {
      weekday: t(`detail.weekday${config.dayOfWeek}`),
      time: config.time,
      timezone: config.timezone,
    });
  }

  if (config.preset === "monthly") {
    return t("detail.scheduleDescriptionMonthly", {
      day: config.dayOfMonth,
      time: config.time,
      timezone: config.timezone,
    });
  }

  return t("detail.scheduleDescriptionCustom", { cron: config.cronExpression, timezone: config.timezone });
}

const statusMeta: Record<IceBoxStatus, { labelKey: string; descriptionKey: string }> = {
  healthy: {
    labelKey: "iceBoxStatus.healthy.label",
    descriptionKey: "iceBoxStatus.healthy.description",
  },
  syncing: {
    labelKey: "iceBoxStatus.syncing.label",
    descriptionKey: "iceBoxStatus.syncing.description",
  },
  attention: {
    labelKey: "iceBoxStatus.attention.label",
    descriptionKey: "iceBoxStatus.attention.description",
  },
};

const syncStatusMeta: Record<
  IceBoxSyncStatus,
  {
    labelKey: string;
    shortLabelKey: string;
    descriptionKey: string;
    tone: "success" | "warning" | "error" | "info";
  }
> = {
  synced: {
    labelKey: "iceBoxSync.synced.label",
    shortLabelKey: "iceBoxSync.synced.shortLabel",
    descriptionKey: "iceBoxSync.synced.description",
    tone: "success",
  },
  "pending-sync": {
    labelKey: "iceBoxSync.pending.label",
    shortLabelKey: "iceBoxSync.pending.shortLabel",
    descriptionKey: "iceBoxSync.pending.description",
    tone: "warning",
  },
  "sync-failed": {
    labelKey: "iceBoxSync.failed.label",
    shortLabelKey: "iceBoxSync.failed.shortLabel",
    descriptionKey: "iceBoxSync.failed.description",
    tone: "error",
  },
};

function toTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  return new Date(value).getTime();
}

const backupModeMeta: Record<IceBoxBackupMode, { labelKey: string; descriptionKey: string }> = {
  "git-branch": {
    labelKey: "backupMode.gitBranch.label",
    descriptionKey: "backupMode.gitBranch.description",
  },
  "upload-token": {
    labelKey: "backupMode.uploadToken.label",
    descriptionKey: "backupMode.uploadToken.description",
  },
};

function delay(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export function getIceBoxStatusMeta(status: IceBoxStatus, t: Translator) {
  const meta = statusMeta[status];
  return {
    label: t(meta.labelKey),
    description: t(meta.descriptionKey),
  };
}

export function getIceBoxSyncStatusMeta(syncStatus: IceBoxSyncStatus, t: Translator) {
  const meta = syncStatusMeta[syncStatus];
  return {
    label: t(meta.labelKey),
    shortLabel: t(meta.shortLabelKey),
    description: t(meta.descriptionKey),
    tone: meta.tone,
  };
}

export function getIceBoxBackupModeMeta(backupMode: IceBoxBackupMode, t: Translator) {
  const meta = backupModeMeta[backupMode];
  return {
    label: t(meta.labelKey),
    description: t(meta.descriptionKey),
  };
}

export function buildUploadUrl(origin: string, uploadPath: string | null) {
  if (!uploadPath) {
    return null;
  }

  try {
    return new URL(uploadPath, origin).toString();
  } catch {
    return null;
  }
}

export function buildSkillLink(origin: string, skillConfig: IceBoxSkillConfig, options?: BuildSkillLinkOptions) {
  const params = new URLSearchParams();

  params.set("config", JSON.stringify(skillConfig));

  if (options?.mode === "restore") {
    params.set("mode", "restore");
  }

  if (options?.includeGitCredentials) {
    params.set("includeGitCredentials", "1");

    if (options.gitUsername?.trim()) {
      params.set("gitUsername", options.gitUsername.trim());
    }

    if (options.gitToken?.trim()) {
      params.set("gitToken", options.gitToken.trim());
    }

    if (options.gitPrivateKeyPath?.trim()) {
      params.set("gitPrivateKeyPath", options.gitPrivateKeyPath.trim());
    }
  }

  return `${origin}/skill?${params.toString()}`;
}

export function formatDateTime(value: string | null | undefined, locale = "en-US") {
  if (!value) {
    return "--";
  }

  return new Date(value).toLocaleString(locale, { hour12: false });
}

export function formatLastBackupTime(value: string | null, t: Translator, locale = "en-US") {
  if (!value) {
    return t("detail.noRecentBackupTime");
  }

  return formatDateTime(value, locale);
}

export async function fetchIceBoxesSnapshot(items: IceBoxListItem[]): Promise<IceBoxListItem[]> {
  await delay(450);

  return [...items].sort((left, right) => {
    const rightTimestamp = toTimestamp(right.lastBackupAt) || toTimestamp(right.createdAt);
    const leftTimestamp = toTimestamp(left.lastBackupAt) || toTimestamp(left.createdAt);

    return rightTimestamp - leftTimestamp;
  });
}

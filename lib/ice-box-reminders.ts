import type {
  IceBoxReminderConfig,
  IceBoxReminderPreset,
  IceBoxReminderSnapshot,
  IceBoxReminderStatus,
} from "@/types";

const hourInMilliseconds = 60 * 60 * 1000;
const defaultReminderPreset: Exclude<IceBoxReminderPreset, "custom"> = "weekly";
const defaultReminderGraceHours = 24;
const defaultCustomReminderHours = 48;

type Translator = (key: string, values?: Record<string, string | number>) => string;

const reminderPresetMeta: Record<
  Exclude<IceBoxReminderPreset, "custom">,
  { labelKey: string; descriptionKey: string; intervalHours: number }
> = {
  daily: {
    labelKey: "detail.reminderPresetDaily",
    descriptionKey: "reminderPreset.daily.description",
    intervalHours: 24,
  },
  "every-3-days": {
    labelKey: "detail.reminderPresetEvery3Days",
    descriptionKey: "reminderPreset.every3Days.description",
    intervalHours: 72,
  },
  weekly: {
    labelKey: "detail.reminderPresetWeekly",
    descriptionKey: "reminderPreset.weekly.description",
    intervalHours: 168,
  },
};

function isReminderPreset(value: unknown): value is IceBoxReminderPreset {
  return value === "daily" || value === "every-3-days" || value === "weekly" || value === "custom";
}

function clampInteger(value: number, fallbackValue: number, minimum = 1, maximum = 24 * 365) {
  if (!Number.isFinite(value)) {
    return fallbackValue;
  }

  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function resolveLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

function resolveReminderIntervalHours(preset: IceBoxReminderPreset, intervalHours: number) {
  if (preset === "custom") {
    return clampInteger(intervalHours, defaultCustomReminderHours);
  }

  return reminderPresetMeta[preset].intervalHours;
}

function formatRelativeDuration(milliseconds: number, t: Translator) {
  const absoluteMilliseconds = Math.abs(milliseconds);
  const totalHours = Math.round(absoluteMilliseconds / hourInMilliseconds);

  if (totalHours < 1) {
    const totalMinutes = Math.max(1, Math.round(absoluteMilliseconds / (60 * 1000)));
    return t("relative.minutes", { count: totalMinutes });
  }

  if (totalHours < 48) {
    return t("relative.hours", { count: totalHours });
  }

  const totalDays = Math.round(totalHours / 24);
  return t("relative.days", { count: Math.max(1, totalDays) });
}

export function getIceBoxReminderPresetMeta(preset: IceBoxReminderPreset, t: Translator) {
  if (preset === "custom") {
    return {
      label: t("detail.reminderPresetCustom"),
      description: t("reminderPreset.custom.description"),
      intervalHours: defaultCustomReminderHours,
    };
  }

  const meta = reminderPresetMeta[preset];
  return {
    label: t(meta.labelKey),
    description: t(meta.descriptionKey),
    intervalHours: meta.intervalHours,
  };
}

export function createDefaultIceBoxReminderConfig(updatedAt: string): IceBoxReminderConfig {
  return {
    version: 1,
    enabled: true,
    preset: defaultReminderPreset,
    intervalHours: reminderPresetMeta[defaultReminderPreset].intervalHours,
    graceHours: defaultReminderGraceHours,
    timezone: resolveLocalTimezone(),
    updatedAt,
  };
}

export function normalizeIceBoxReminderConfig(
  reminder: Partial<IceBoxReminderConfig> | null | undefined,
  fallbackUpdatedAt: string,
): IceBoxReminderConfig {
  const normalizedPreset = isReminderPreset(reminder?.preset) ? reminder.preset : defaultReminderPreset;
  const normalizedUpdatedAt = reminder?.updatedAt || fallbackUpdatedAt;

  return {
    version: 1,
    enabled: reminder?.enabled ?? true,
    preset: normalizedPreset,
    intervalHours: resolveReminderIntervalHours(normalizedPreset, reminder?.intervalHours ?? 0),
    graceHours: clampInteger(reminder?.graceHours ?? defaultReminderGraceHours, defaultReminderGraceHours),
    timezone: reminder?.timezone?.trim() || resolveLocalTimezone(),
    updatedAt: normalizedUpdatedAt,
  };
}

export function formatIceBoxReminderConfig(reminder: IceBoxReminderConfig, t: Translator) {
  if (!reminder.enabled) {
    return t("reminder.disabledConfig");
  }

  if (reminder.preset === "custom") {
    return t("reminder.customConfig", {
      intervalHours: reminder.intervalHours,
      graceHours: reminder.graceHours,
    });
  }

  return t("reminder.presetConfig", {
    label: getIceBoxReminderPresetMeta(reminder.preset, t).label,
    graceHours: reminder.graceHours,
  });
}

export function calculateIceBoxReminderSnapshot({
  reminder,
  createdAt,
  lastBackupAt,
  now = new Date(),
  t,
}: {
  reminder: IceBoxReminderConfig;
  createdAt: string;
  lastBackupAt: string | null;
  now?: Date;
  t: Translator;
}): IceBoxReminderSnapshot {
  const normalizedReminder = normalizeIceBoxReminderConfig(reminder, reminder.updatedAt || createdAt);
  const configLabel = formatIceBoxReminderConfig(normalizedReminder, t);
  const basisAt = lastBackupAt || createdAt || null;
  const isFirstBackupPending = !lastBackupAt;

  if (!normalizedReminder.enabled) {
    return {
      reminder: normalizedReminder,
      configLabel,
      status: "disabled",
      statusLabel: t("reminder.status.disabled"),
      statusDescription: t("reminder.status.disabledDescription"),
      basisAt,
      nextReminderAt: null,
      isFirstBackupPending,
    };
  }

  if (!basisAt) {
    return {
      reminder: normalizedReminder,
      configLabel,
      status: "scheduled",
      statusLabel: t("reminder.status.waitingBaseline"),
      statusDescription: t("reminder.status.waitingBaselineDescription"),
      basisAt: null,
      nextReminderAt: null,
      isFirstBackupPending,
    };
  }

  const basisTimestamp = new Date(basisAt).getTime();

  if (Number.isNaN(basisTimestamp)) {
    return {
      reminder: normalizedReminder,
      configLabel,
      status: "scheduled",
      statusLabel: t("reminder.status.invalidTime"),
      statusDescription: t("reminder.status.invalidTimeDescription"),
      basisAt,
      nextReminderAt: null,
      isFirstBackupPending,
    };
  }

  const nextReminderTimestamp = basisTimestamp + normalizedReminder.intervalHours * hourInMilliseconds;
  const nextReminderAt = new Date(nextReminderTimestamp).toISOString();
  const nowTimestamp = now.getTime();
  const remainingMilliseconds = nextReminderTimestamp - nowTimestamp;

  if (remainingMilliseconds > 0) {
    return {
      reminder: normalizedReminder,
      configLabel,
      status: "scheduled",
      statusLabel: isFirstBackupPending ? t("reminder.status.waitingFirstBackup") : t("reminder.status.scheduled"),
      statusDescription: isFirstBackupPending
        ? t("reminder.status.waitingFirstBackupDescription", { duration: formatRelativeDuration(remainingMilliseconds, t) })
        : t("reminder.status.scheduledDescription", { duration: formatRelativeDuration(remainingMilliseconds, t) }),
      basisAt,
      nextReminderAt,
      isFirstBackupPending,
    };
  }

  const overdueMilliseconds = Math.abs(remainingMilliseconds);
  const graceWindowMilliseconds = normalizedReminder.graceHours * hourInMilliseconds;
  const dueStatus: IceBoxReminderStatus = overdueMilliseconds <= graceWindowMilliseconds ? "due" : "overdue";

  return {
    reminder: normalizedReminder,
    configLabel,
    status: dueStatus,
    statusLabel:
      dueStatus === "due"
        ? isFirstBackupPending
          ? t("reminder.status.firstBackupDue")
          : t("reminder.status.due")
        : isFirstBackupPending
          ? t("reminder.status.firstBackupOverdue")
          : t("reminder.status.overdue"),
    statusDescription:
      dueStatus === "due"
        ? t("reminder.status.dueDescription", { duration: formatRelativeDuration(overdueMilliseconds, t) })
        : t("reminder.status.overdueDescription", { duration: formatRelativeDuration(overdueMilliseconds, t) }),
    basisAt,
    nextReminderAt,
    isFirstBackupPending,
  };
}

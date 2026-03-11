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

const reminderPresetMeta: Record<
  Exclude<IceBoxReminderPreset, "custom">,
  { label: string; description: string; intervalHours: number }
> = {
  daily: {
    label: "每天一次",
    description: "适合活跃机器，漏一次也能很快补上。",
    intervalHours: 24,
  },
  "every-3-days": {
    label: "每 3 天一次",
    description: "适合普通工作机，频率和打扰感比较平衡。",
    intervalHours: 72,
  },
  weekly: {
    label: "每周一次",
    description: "适合低频更新机器，默认节奏更克制。",
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

function formatRelativeDuration(milliseconds: number) {
  const absoluteMilliseconds = Math.abs(milliseconds);
  const totalHours = Math.round(absoluteMilliseconds / hourInMilliseconds);

  if (totalHours < 1) {
    const totalMinutes = Math.max(1, Math.round(absoluteMilliseconds / (60 * 1000)));
    return `${totalMinutes} 分钟`;
  }

  if (totalHours < 48) {
    return `${totalHours} 小时`;
  }

  const totalDays = Math.round(totalHours / 24);
  return `${Math.max(1, totalDays)} 天`;
}

export function getIceBoxReminderPresetMeta(preset: IceBoxReminderPreset) {
  if (preset === "custom") {
    return {
      label: "自定义",
      description: "自己决定提醒间隔，适合特殊节奏。",
      intervalHours: defaultCustomReminderHours,
    };
  }

  return reminderPresetMeta[preset];
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

export function formatIceBoxReminderConfig(reminder: IceBoxReminderConfig) {
  if (!reminder.enabled) {
    return "已关闭提醒";
  }

  if (reminder.preset === "custom") {
    return `每 ${reminder.intervalHours} 小时提醒一次 · 缓冲 ${reminder.graceHours} 小时`;
  }

  return `${getIceBoxReminderPresetMeta(reminder.preset).label} · 缓冲 ${reminder.graceHours} 小时`;
}

export function calculateIceBoxReminderSnapshot({
  reminder,
  createdAt,
  lastBackupAt,
  now = new Date(),
}: {
  reminder: IceBoxReminderConfig;
  createdAt: string;
  lastBackupAt: string | null;
  now?: Date;
}): IceBoxReminderSnapshot {
  const normalizedReminder = normalizeIceBoxReminderConfig(reminder, reminder.updatedAt || createdAt);
  const configLabel = formatIceBoxReminderConfig(normalizedReminder);
  const basisAt = lastBackupAt || createdAt || null;
  const isFirstBackupPending = !lastBackupAt;

  if (!normalizedReminder.enabled) {
    return {
      reminder: normalizedReminder,
      configLabel,
      status: "disabled",
      statusLabel: "已关闭",
      statusDescription: "当前冰盒不会自动提示补做备份。",
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
      statusLabel: "等待基线",
      statusDescription: "还没有可计算的创建时间或备份时间，暂时无法安排提醒。",
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
      statusLabel: "时间异常",
      statusDescription: "当前基线时间无效，暂时无法计算下一次提醒。",
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
      statusLabel: isFirstBackupPending ? "等待首备份" : "已安排",
      statusDescription: isFirstBackupPending
        ? `${formatRelativeDuration(remainingMilliseconds)} 后还没首个备份，就该提醒了。`
        : `${formatRelativeDuration(remainingMilliseconds)} 后进入下一次提醒窗口。`,
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
          ? "该做首备份了"
          : "该提醒了"
        : isFirstBackupPending
          ? "首备份已逾期"
          : "提醒已逾期",
    statusDescription:
      dueStatus === "due"
        ? `提醒窗口已经打开，当前已到点 ${formatRelativeDuration(overdueMilliseconds)}。`
        : `已经超过提醒窗口 ${formatRelativeDuration(overdueMilliseconds)}，建议尽快补做备份。`,
    basisAt,
    nextReminderAt,
    isFirstBackupPending,
  };
}

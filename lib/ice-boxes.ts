import type { IceBoxBackupMode, IceBoxListItem, IceBoxSkillConfig, IceBoxStatus } from "@/types";

const statusMeta: Record<IceBoxStatus, { label: string; description: string }> = {
  healthy: {
    label: "运行正常",
    description: "最近一次备份已完成，当前状态稳定。",
  },
  syncing: {
    label: "同步中",
    description: "正在执行备份或等待最新快照写入。",
  },
  attention: {
    label: "需要关注",
    description: "最近一次备份异常，建议尽快检查。",
  },
};

function toTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  return new Date(value).getTime();
}

const backupModeMeta: Record<IceBoxBackupMode, { label: string; description: string }> = {
  "git-branch": {
    label: "Git 直推",
    description: "OpenClaw 直接把 .openclaw 同步到专属分支。",
  },
  "upload-token": {
    label: "压缩包上传",
    description: "OpenClaw 打包后上传到冰盒专属地址，由 Claw-Fridge 接手落盘。",
  },
};

function delay(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export function getIceBoxStatusMeta(status: IceBoxStatus) {
  return statusMeta[status];
}

export function getIceBoxBackupModeMeta(backupMode: IceBoxBackupMode) {
  return backupModeMeta[backupMode];
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

export function buildSkillLink(origin: string, skillConfig: IceBoxSkillConfig) {
  const params = new URLSearchParams({
    config: JSON.stringify(skillConfig),
  });

  return `${origin}/skill?${params.toString()}`;
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "--";
  }

  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function formatLastBackupTime(value: string | null) {
  if (!value) {
    return "尚未执行备份";
  }

  return formatDateTime(value);
}

export async function fetchIceBoxesSnapshot(items: IceBoxListItem[]): Promise<IceBoxListItem[]> {
  await delay(450);

  return [...items].sort((left, right) => {
    const rightTimestamp = toTimestamp(right.lastBackupAt) || toTimestamp(right.createdAt);
    const leftTimestamp = toTimestamp(left.lastBackupAt) || toTimestamp(left.createdAt);

    return rightTimestamp - leftTimestamp;
  });
}

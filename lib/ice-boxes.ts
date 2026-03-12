import type {
  IceBoxBackupMode,
  IceBoxListItem,
  IceBoxSkillConfig,
  IceBoxStatus,
  IceBoxSyncStatus,
} from "@/types";

export interface BuildSkillLinkOptions {
  mode?: "backup" | "restore";
  includeGitCredentials?: boolean;
}

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

const syncStatusMeta: Record<
  IceBoxSyncStatus,
  {
    label: string;
    shortLabel: string;
    description: string;
    tone: "success" | "warning" | "error" | "info";
  }
> = {
  synced: {
    label: "已同步到远端",
    shortLabel: "远端已同步",
    description: "当前冰盒记录已通过远端 fridge-config 分支回读校验。",
    tone: "success",
  },
  "pending-sync": {
    label: "等待远端校验",
    shortLabel: "待校验",
    description: "本地记录已保留，但还没有通过远端 fridge-config 分支的存在性校验。",
    tone: "warning",
  },
  "sync-failed": {
    label: "远端校验失败",
    shortLabel: "校验失败",
    description: "冰盒已经创建到本地，但最近一次写入或回读远端 fridge-config 分支未通过校验。",
    tone: "error",
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

export function getIceBoxSyncStatusMeta(syncStatus: IceBoxSyncStatus) {
  return syncStatusMeta[syncStatus];
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

export function buildSkillLink(origin: string, skillConfig: IceBoxSkillConfig, options?: BuildSkillLinkOptions) {
  const params = new URLSearchParams();

  params.set("config", JSON.stringify(skillConfig));

  if (options?.mode === "restore") {
    params.set("mode", "restore");
  }

  if (options?.includeGitCredentials) {
    params.set("includeGitCredentials", "1");
  }

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

import { headers } from "next/headers";
import type { OperationResultFields } from "@/types";

type Locale = "zh" | "en";

type TranslationValues = Record<string, string | number | boolean | null | undefined>;

const dynamicTextPatterns: Array<{
  pattern: RegExp;
  key: string;
  values: (match: string[]) => TranslationValues;
}> = [
  { pattern: /^冰盒 `([^`]+)` 备份历史接口执行失败。$/u, key: "api.route.iceBoxHistoryFailed", values: ([id]) => ({ id }) },
  { pattern: /^冰盒 `([^`]+)` 恢复接口执行失败。$/u, key: "api.route.iceBoxRestoreFailed", values: ([id]) => ({ id }) },
  { pattern: /^冰盒 (.+) 已存在。$/u, key: "api.sync.iceBoxExists", values: ([id]) => ({ id }) },
  { pattern: /^冰盒 (.+) 已同步到远端，并通过回读校验。$/u, key: "api.sync.iceBoxSyncedVerified", values: ([name]) => ({ name }) },
  { pattern: /^冰盒 (.+) 已更新到远端，并通过回读校验。$/u, key: "api.sync.iceBoxUpdatedVerified", values: ([id]) => ({ id }) },
  { pattern: /^冰盒 (.+) 已推送到远端，但回读校验未通过。$/u, key: "api.sync.iceBoxPushedVerifyFailed", values: ([id]) => ({ id }) },
  { pattern: /^冰盒 (.+) 已标记为删除，分支保留。$/u, key: "api.sync.iceBoxMarkedDeleted", values: ([name]) => ({ name }) },
  { pattern: /^冰盒 (.+) 不存在。$/u, key: "api.sync.iceBoxNotFound", values: ([id]) => ({ id }) },
  { pattern: /^分支 `([^`]+)` 还不存在，说明这个冰盒还没有产生首个备份。$/u, key: "api.restore.branchNotCreated", values: ([branch]) => ({ branch }) },
  { pattern: /^已读取分支 `([^`]+)` 的 (\d+) 条备份历史。$/u, key: "api.restore.historyLoaded", values: ([branch, count]) => ({ branch, count }) },
  { pattern: /^分支 `([^`]+)` 目前还没有备份历史。$/u, key: "api.restore.noHistoryOnBranch", values: ([branch]) => ({ branch }) },
  { pattern: /^提交 `([^`]+)` 不属于分支 `([^`]+)`。$/u, key: "api.restore.commitNotInBranch", values: ([commit, branch]) => ({ commit, branch }) },
  { pattern: /^目标分支 `([^`]+)` 暂无备份，当前仓库还有 (\d+) 个可恢复分支。$/u, key: "api.restore.branchNoBackupButOthers", values: ([branch, count]) => ({ branch, count }) },
  { pattern: /^当前仓库里还没有找到任何 `([^`]+)` 备份分支。$/u, key: "api.restore.noBackupBranches", values: ([prefix]) => ({ prefix }) },
  { pattern: /^未找到提交 `([^`]+)` 对应的可恢复快照。$/u, key: "api.restore.snapshotNotFound", values: ([commit]) => ({ commit }) },
  { pattern: /^已定位到分支 `([^`]+)` 上的历史快照 `([^`]+)`。$/u, key: "api.restore.snapshotLocated", values: ([branch, commit]) => ({ branch, commit }) },
  { pattern: /^已找到分支 `([^`]+)` 的最近备份信息。$/u, key: "api.restore.latestSnapshotLocated", values: ([branch]) => ({ branch }) },
  { pattern: /^分支 `([^`]+)` 当前没有可恢复的备份。$/u, key: "api.restore.branchHasNoBackup", values: ([branch]) => ({ branch }) },
  { pattern: /^提交 `([^`]+)` 中未找到可恢复的 `\.openclaw` 目录。$/u, key: "api.restore.openclawNotFoundInCommit", values: ([commit]) => ({ commit }) },
  { pattern: /^分支 `([^`]+)` 中未找到可恢复的 `\.openclaw` 目录。$/u, key: "api.restore.openclawNotFoundInBranch", values: ([branch]) => ({ branch }) },
  { pattern: /^恢复目标目录过于危险：(.+)$/u, key: "api.restore.targetTooDangerous", values: ([path]) => ({ path }) },
  { pattern: /^分支 `([^`]+)` 与 machine-id `([^`]+)` 不匹配，期望为 `([^`]+)`。$/u, key: "api.restore.branchMachineMismatch", values: ([branch, machineId, expectedBranch]) => ({ branch, machineId, expectedBranch }) },
  { pattern: /^备份已恢复（快照 ([^)]+)），原有 `\.openclaw` 已先挪到旁边的时间戳备份目录。$/u, key: "api.restore.restoredWithBackup", values: ([commit]) => ({ commit }) },
  { pattern: /^备份已恢复到目标目录（快照 ([^)]+)）。$/u, key: "api.restore.restoredToTarget", values: ([commit]) => ({ commit }) },
  { pattern: /^上传文件超过限制（最大 (.+)）。$/u, key: "api.upload.fileTooLarge", values: ([max]) => ({ max }) },
  { pattern: /^(.+) 格式无效。$/u, key: "api.upload.invalidFormat", values: ([label]) => ({ label }) },
  { pattern: /^不支持的文件类型：(.+)$/u, key: "api.upload.unsupportedFileType", values: ([mimeType]) => ({ mimeType }) },
  { pattern: /^无法读取 tar\.gz 内容：(.+)$/u, key: "api.upload.readArchiveFailed", values: ([reason]) => ({ reason }) },
  { pattern: /^解压 tar\.gz 失败：(.+)$/u, key: "api.upload.extractArchiveFailed", values: ([reason]) => ({ reason }) },
  { pattern: /^当前仅支持 (.+) 上传加密。$/u, key: "api.upload.onlySupportEncryption", values: ([algorithm]) => ({ algorithm }) },
  { pattern: /^当前仓库地址是 SSH，但未提供 SSH Key 配置。$/u, key: "api.git.sshRepoMissingKey", values: () => ({}) },
  { pattern: /^当前仓库地址是 SSH，请切换到 SSH Key 认证后再初始化分支。$/u, key: "api.git.switchToSshKeyForInit", values: () => ({}) },
  { pattern: /^初始化文件已存在：(.+)$/u, key: "api.git.initFileExists", values: ([path]) => ({ path }) },
  { pattern: /^写入初始化文件失败（(.+)）：(.+)$/u, key: "api.git.writeInitFileFailed", values: ([path, reason]) => ({ path, reason }) },
  { pattern: /^未找到可写入初始化配置的 Git 仓库：(.+)$/u, key: "api.git.repoNotFoundForInit", values: ([reason]) => ({ reason }) },
  { pattern: /^读取身份文件失败（(.+)）：(.+)$/u, key: "api.identity.readFileFailed", values: ([fileName, reason]) => ({ fileName, reason }) },
  { pattern: /^读取身份文件失败（(.+)）。$/u, key: "api.identity.readFileFailedSimple", values: ([fileName]) => ({ fileName }) },
  { pattern: /^读取已生成身份信息失败：(.+)$/u, key: "api.identity.readGeneratedFailed", values: ([reason]) => ({ reason }) },
  { pattern: /^仓库根目录：(.+)$/u, key: "api.git.repoRoot", values: ([root]) => ({ root }) },
  { pattern: /^当前分支：(.+)$/u, key: "api.git.currentBranch", values: ([branch]) => ({ branch }) },
  { pattern: /^HEAD：(.+)$/u, key: "api.git.head", values: ([head]) => ({ head }) },
  { pattern: /^地址：(.+)$/u, key: "api.git.address", values: ([address]) => ({ address }) },
  { pattern: /^默认分支：(.+)$/u, key: "api.git.defaultBranch", values: ([branch]) => ({ branch }) },
  { pattern: /^(.+)：已创建$/u, key: "api.git.fileCreated", values: ([path]) => ({ path }) },
  { pattern: /^(.+)：已覆盖$/u, key: "api.git.fileOverwritten", values: ([path]) => ({ path }) },
  { pattern: /^(.+)：已保留$/u, key: "api.git.fileKept", values: ([path]) => ({ path }) },
];

const exactTextKeyMap: Record<string, string> = {
  "请求失败。": "api.common.requestFailed",
  "未知错误": "api.common.unknownError",
  "无效的身份同步请求，请提供 rootDir。": "api.route.invalidIdentitySyncRequest",
  "rootDir 必须是非空字符串。": "api.route.rootDirRequired",
  "身份同步接口执行失败。": "api.route.identitySyncFailed",
  "请提供 Git 配置。": "api.route.gitConfigRequired",
  "请求体必须包含有效的 Git 配置对象。": "api.route.gitConfigObjectRequired",
  "拉取冰盒列表接口执行失败。": "api.route.fetchIceBoxesFailed",
  "请提供冰盒信息。": "api.route.iceBoxInfoRequired",
  "请求体必须包含有效的冰盒对象（包含 id 和 name）。": "api.route.iceBoxObjectRequired",
  "创建冰盒接口执行失败。": "api.route.createIceBoxFailed",
  "请提供更新内容。": "api.route.updatesRequired",
  "请求体必须包含 updates 字段。": "api.route.updatesFieldRequired",
  "更新冰盒接口执行失败。": "api.route.updateIceBoxFailed",
  "删除冰盒接口执行失败。": "api.route.deleteIceBoxFailed",
  "无效的历史记录请求。": "api.route.invalidHistoryRequest",
  "请求体必须包含有效的 machine-id、branch 和 gitConfig 信息。": "api.route.historyPayloadRequired",
  "请提供匹配的冰盒信息。": "api.route.matchingIceBoxRequired",
  "请求体必须包含 item，且 item.id 需要与路由参数一致。": "api.route.syncItemMustMatchId",
  "补偿同步接口执行失败。": "api.route.compensatingSyncFailed",
  "无效的恢复请求。": "api.route.invalidRestoreRequest",
  "请求体必须包含合法的 action，并补齐恢复所需字段。": "api.route.restorePayloadRequired",
  "无效的上传 token 请求。": "api.route.invalidUploadTokenRequest",
  "请求体必须包含合法的冰盒名称、machine-id 和 Git 配置。": "api.route.uploadTokenPayloadRequired",
  "上传 token 接口执行失败。": "api.route.uploadTokenFailed",
  "撤销上传 token 接口执行失败。": "api.route.revokeUploadTokenFailed",
  "无效的 Git 配置请求。": "api.route.invalidGitConfigRequest",
  "请求体必须是合法的 Git 配置对象。": "api.route.gitConfigPayloadRequired",
  "Git 配置初始化接口执行失败。": "api.route.gitConfigInitFailed",
  "Git 配置测试接口执行失败。": "api.route.gitConfigTestFailed",
  "推送完成，但远端回读校验失败。": "api.sync.pushFinishedVerifyFailed",
  "推送完成，但远端 fridge-config/ice-boxes.json 中未找到该冰盒记录。": "api.sync.missingRecordAfterPush",
  "冰盒列表文件尚不存在。": "api.sync.iceBoxListFileMissingYet",
  "冰盒列表已从 GitHub 拉取。": "api.sync.iceBoxListPulled",
  "从 GitHub 拉取冰盒列表失败。": "api.sync.pullIceBoxListFailed",
  "冰盒列表无变化。": "api.sync.iceBoxListUnchanged",
  "同步冰盒到 GitHub 失败。": "api.sync.syncIceBoxToGitFailed",
  "冰盒列表文件不存在。": "api.sync.iceBoxListFileMissing",
  "冰盒信息无变化。": "api.sync.iceBoxInfoUnchanged",
  "更新冰盒到 GitHub 失败。": "api.sync.updateIceBoxToGitFailed",
  "标记冰盒为删除失败。": "api.sync.markIceBoxDeletedFailed",
  "本地仓库路径不存在。": "api.git.localRepoPathMissing",
  "本地 Git 仓库可用。": "api.git.localRepoAvailable",
  "未识别到有效的本地 Git 仓库。": "api.git.localRepoInvalid",
  "HTTPS Token 认证只支持 HTTPS 仓库地址。": "api.git.httpsOnlyForHttpsRepo",
  "请填写 HTTPS Token。": "api.git.fillHttpsToken",
  "HTTPS 远程仓库连接成功。": "api.git.httpsConnectionSuccess",
  "HTTPS 远程仓库连接失败。": "api.git.httpsConnectionFailed",
  "无法初始化 SSH Agent 环境变量。": "api.git.initSshAgentFailed",
  "SSH Key 认证只支持 SSH 仓库地址。": "api.git.sshOnlyForSshRepo",
  "请填写 SSH 私钥。": "api.git.fillSshPrivateKey",
  "SSH 远程仓库连接成功。": "api.git.sshConnectionSuccess",
  "SSH 远程仓库连接失败。": "api.git.sshConnectionFailed",
  "请先填写 HTTPS Token，再初始化 fridge-config 分支。": "api.git.fillHttpsTokenBeforeInit",
  "请先填写 SSH 私钥，再初始化 fridge-config 分支。": "api.git.fillSshKeyBeforeInit",
  "无法识别 Git 仓库类型，暂时无法初始化 fridge-config 分支。": "api.git.repoTypeUnknownForInit",
  "请先填写 Git 仓库路径或远程地址。": "api.git.fillRepoPathOrRemote",
  "无法识别 Git 仓库类型。": "api.git.repoTypeUnknown",
  "初始化 `fridge-config` 分支失败。": "api.git.initFridgeConfigBranchFailed",
  "当前仓库地址使用 SSH。初始化流程已改为 isomorphic-git，但该库在当前实现里不直接支持 SSH 推送。": "api.git.sshNotSupportedForInit",
  "请将仓库地址改为 HTTPS 并使用 Token 后重试。": "api.git.switchToHttpsAndToken",
  "`fridge-config` 分支已存在，初始化文件也已经齐全。": "api.git.fridgeConfigBranchAlreadyReady",
  "`fridge-config` 分支已补齐并推送初始化文件。": "api.git.fridgeConfigBranchPatchedAndPushed",
  "`fridge-config` 分支初始化完成，配置文件已推送。": "api.git.fridgeConfigBranchInitialized",
  "machine-id 不合法。": "api.restore.invalidMachineId",
  "缺少可恢复的分支信息。": "api.restore.branchRequired",
  "请先填写恢复目标目录。": "api.restore.targetRequired",
  "恢复目标目录必须是绝对路径。": "api.restore.targetMustBeAbsolute",
  "请填写 `.openclaw` 的父目录，而不是目录本身。": "api.restore.useParentOfOpenclaw",
  "提交 hash 不合法。": "api.restore.invalidCommitHash",
  "无提交说明": "api.restore.noCommitMessage",
  "未知提交人": "api.restore.unknownAuthor",
  "请先提供有效的 Git 仓库配置。": "api.restore.validGitConfigRequired",
  "读取备份历史失败。": "api.restore.readHistoryFailed",
  "恢复预览失败。": "api.restore.previewFailed",
  "恢复目标目录不是文件夹，无法写入 `.openclaw`。": "api.restore.targetNotDirectory",
  "请先确认恢复操作，再继续执行。": "api.restore.confirmRequired",
  "目标目录下已经存在 `.openclaw`，请确认覆盖后再重试。": "api.restore.targetAlreadyExists",
  "恢复备份失败。": "api.restore.executeFailed",
  "上传 token 存储文件格式无效。": "api.upload.invalidTokenStorageFormat",
  "Token 有效期必须在 0 到 8760 小时之间。": "api.upload.tokenHoursRange",
  "ice-box-id 不合法。": "api.upload.invalidIceBoxId",
  "冰盒名称不能为空。": "api.upload.iceBoxNameRequired",
  "上传地址和 token 已生成。": "api.upload.tokenGenerated",
  "生成上传 token 失败。": "api.upload.tokenGenerateFailed",
  "缺少有效的 ice-box-id 或 upload-id。": "api.upload.missingIceBoxIdOrUploadId",
  "未找到对应的上传 token。": "api.upload.tokenNotFound",
  "上传 token 已经是撤销状态。": "api.upload.tokenAlreadyRevoked",
  "上传 token 已撤销。": "api.upload.tokenRevoked",
  "撤销上传 token 失败。": "api.upload.revokeTokenFailed",
  "上传地址无效。": "api.upload.invalidUploadUrl",
  "缺少上传 token。": "api.upload.missingUploadToken",
  "上传地址不存在。": "api.upload.uploadUrlNotFound",
  "上传 token 已过期。": "api.upload.tokenExpired",
  "上传 token 无效。": "api.upload.tokenInvalid",
  "当前冰盒未启用上传加密，请移除加密请求头后重试。": "api.upload.encryptionNotEnabled",
  "当前冰盒要求加密上传，请带上加密请求头和主密钥后重试。": "api.upload.encryptionRequired",
  "冰盒加密配置不完整，缺少 KDF Salt。": "api.upload.missingKdfSalt",
  "缺少加密上传所需的 IV 或 Auth Tag。": "api.upload.missingIvOrAuthTag",
  "缺少加密上传主密钥。": "api.upload.missingMasterKey",
  "AES-GCM IV 长度必须为 12 字节。": "api.upload.invalidIvLength",
  "AES-GCM Auth Tag 长度必须为 16 字节。": "api.upload.invalidAuthTagLength",
  "上传密钥无效，或加密文件已经损坏，无法解密备份。": "api.upload.decryptFailed",
  "上传文件不是合法的 gzip 压缩包。": "api.upload.notGzipArchive",
  "压缩包内容为空。": "api.upload.archiveEmpty",
  "压缩包包含绝对路径，已拒绝处理。": "api.upload.archiveContainsAbsolutePath",
  "压缩包包含不安全路径，已拒绝处理。": "api.upload.archiveContainsUnsafePath",
  "压缩包内缺少 `.openclaw` 目录。": "api.upload.archiveMissingOpenclaw",
  "解压后的 `.openclaw` 不是目录。": "api.upload.openclawNotDirectoryAfterExtract",
  "解压后未找到 `.openclaw` 目录。": "api.upload.openclawMissingAfterExtract",
  "当前上传仅支持 tar.gz 原始流或 multipart/form-data。": "api.upload.onlyTarGzOrMultipart",
  "请求体为空，无法读取上传文件。": "api.upload.emptyRequestBody",
  "一次只允许上传一个 tar.gz 文件。": "api.upload.onlyOneFileAllowed",
  "加密上传文件名建议使用 .tar.gz.enc / .enc / .bin。": "api.upload.encryptedFilenameSuggested",
  "上传文件名必须以 .tar.gz 或 .tgz 结尾。": "api.upload.filenameMustBeTarGz",
  "未在 multipart 请求中找到文件字段。": "api.upload.fileFieldMissing",
  "上传文件写入失败。": "api.upload.writeUploadFileFailed",
  "备份内容无变化，已跳过提交。": "api.upload.backupUnchangedSkipped",
  "备份内容已提交并推送到远程仓库。": "api.upload.backupCommittedAndPushed",
  "请求体中的 iceBoxId 与上传地址不匹配。": "api.upload.iceBoxIdMismatch",
  "处理上传备份失败。": "api.upload.processUploadFailed",
  "未发现可解析的身份文件，请至少提供 IDENTITY.md、SOUL.md 或 USER.md。": "api.identity.noParsableIdentityFiles",
  "身份信息无变化，沿用现有 identity.json。": "api.identity.identityUnchanged",
  "身份信息已更新。": "api.identity.identityUpdated",
  "身份信息已生成。": "api.identity.identityGenerated",
  "身份信息同步失败。": "api.identity.identitySyncFailed"
};

function getByPath(messages: Record<string, unknown>, key: string): string | undefined {
  return key.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, messages) as string | undefined;
}

function formatMessage(template: string, values?: TranslationValues) {
  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, token: string) => String(values[token] ?? `{${token}}`));
}

function parseLocale(value: string | null | undefined): Locale {
  if (!value) {
    return "zh";
  }

  return value.toLowerCase().includes("en") ? "en" : "zh";
}

export async function getServerTranslations(request?: Request) {
  const acceptLanguage = request?.headers.get("accept-language") ?? (await headers()).get("accept-language");
  const locale = parseLocale(acceptLanguage);
  const messages = ((await import(`@/i18n/messages/${locale}.json`)).default ?? {}) as Record<string, unknown>;

  return {
    locale,
    messages,
    t(key: string, values?: TranslationValues) {
      const template = getByPath(messages, key);
      return typeof template === "string" ? formatMessage(template, values) : key;
    },
  };
}

export async function translateApiText(input: string | null | undefined, request?: Request): Promise<string | undefined> {
  if (!input) {
    return input ?? undefined;
  }

  const { locale, t } = await getServerTranslations(request);
  if (locale === "zh") {
    return input;
  }

  const translatedLines = input.split("\n").map((line) => {
    const exactKey = exactTextKeyMap[line];
    if (exactKey) {
      return t(exactKey);
    }

    for (const entry of dynamicTextPatterns) {
      const match = line.match(entry.pattern);
      if (match) {
        return t(entry.key, entry.values(match.slice(1)));
      }
    }

    return line;
  });

  return translatedLines.join("\n");
}

export async function localizeOperationResult<T extends Partial<OperationResultFields>>(
  payload: T,
  request?: Request,
): Promise<T> {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const localizedMessage = await translateApiText(typeof payload.message === "string" ? payload.message : undefined, request);
  const localizedDetails = await translateApiText(typeof payload.details === "string" ? payload.details : undefined, request);
  const localizedError = payload.error
    ? {
        ...payload.error,
        message: await translateApiText(payload.error.message, request),
        details: await translateApiText(payload.error.details, request),
      }
    : payload.error;

  return {
    ...payload,
    message: localizedMessage ?? payload.message,
    details: localizedDetails ?? payload.details,
    error: localizedError,
  };
}

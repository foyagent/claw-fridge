# Claw-Fridge

Claw-Fridge 是 OpenClaw 配置备份项目的本地 Web UI。当前首页已经串起 Git 仓库配置、`fridge-config` 分支初始化和冰盒列表；新建页支持生成 machine-id、备份分支与 Skill 配置；身份识别能力可扫描 OpenClaw 根目录里的身份文件并生成 `identity.json`；冰盒 Skill 文档也支持输出 Git 直推方案的上游/分支配置脚本、定时同步模板和验证命令。详情页现已支持本地持久化的“定时备份提醒”配置，可直接查看提醒节奏、下次提醒时间和当前状态文案。

## 开发

```bash
npm run dev
npm run lint
```

默认访问 `http://localhost:3000`。

### 本地开发日志

Claw-Fridge 的服务端日志默认直接打到终端，字段会自动做敏感信息脱敏。
需要调日志时可用这些环境变量：

- `CLAW_FRIDGE_LOG_LEVEL=debug|info|warn|error`：控制最小日志级别
- `CLAW_FRIDGE_VERBOSE_LOGS=1`：开发时强制放开 info 日志
- `CLAW_FRIDGE_LOG_JSON=1`：输出 JSON 行日志，方便重定向到文件或用 `jq` 过滤

示例：

```bash
CLAW_FRIDGE_LOG_LEVEL=debug npm run dev
CLAW_FRIDGE_LOG_JSON=1 npm run dev | jq
```

## Git 平台支持

首页的 Git Config 面板现在会自动识别并提示以下平台：

- GitHub
- GitLab
- Gitea
- 通用自托管 Git 服务（HTTPS / SSH）

### 仓库地址格式

- HTTPS：`https://github.com/owner/repo.git`、`https://gitlab.com/group/project.git`、`https://git.example.com/team/fridge.git`
- SSH（scp 风格）：`git@github.com:owner/repo.git`、`git@gitlab.com:group/project.git`
- SSH（带端口）：`ssh://git@git.example.com:2222/team/fridge.git`

### 认证差异

- GitHub：HTTPS 建议使用 PAT / Fine-grained PAT，token 放在密码位置；用户名优先填 GitHub 用户名
- GitLab：HTTPS 常用 `oauth2` + PAT；如果使用 Deploy Token，用户名要改成 GitLab 生成的专用用户名
- Gitea：HTTPS 一般使用 Access Token / PAT，用户名通常是 Gitea 账号名
- SSH：GitHub / GitLab / Gitea 默认通常都是 `git` 用户；自托管实例如果不是 `git`，请按服务端配置填写

### UI 行为

- 根据仓库 URL 自动识别平台与协议（本地 / HTTPS / SSH）
- 在切换到 HTTPS Token 或 SSH Key 认证时自动补默认用户名
- 在“测试连接”或“初始化 fridge-config”失败时返回对应平台的排查提示
- 在 Skill 文档中追加平台化的认证说明和 SSH 地址示例

## 压缩包上传 API

### 1. 生成上传地址和 token

`POST /api/ice-boxes/:id/upload-token`

请求体：

```json
{
  "iceBoxName": "Boen 的 MacBook Pro",
  "machineId": "boen-mbp",
  "gitConfig": {
    "repository": "git@github.com:example/fridge.git",
    "kind": "remote",
    "auth": {
      "method": "ssh-key",
      "username": "git",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----...",
      "publicKey": "ssh-ed25519 AAAA...",
      "passphrase": ""
    },
    "updatedAt": null
  },
  "encryption": {
    "version": 1,
    "enabled": true,
    "scope": "upload-payload",
    "algorithm": "aes-256-gcm",
    "kdf": "pbkdf2-sha256",
    "kdfSalt": "base64-salt",
    "kdfIterations": 210000,
    "keyStrategy": "manual-entry",
    "keyHint": "旧 MacBook 那把长口令",
    "updatedAt": "2026-03-11T11:11:11.000Z"
  },
  "expiresInHours": 720
}
```

成功后会返回唯一 `uploadPath`、一次有效的 `uploadToken`、目标分支和过期时间。当前实现会把 token 元数据保存在本地 `.claw-fridge/upload-tokens.json`，并自动撤销同一冰盒之前仍然有效的 token。

### 2. 上传 tar.gz 备份

`POST /api/ice-boxes/:id/upload/:uploadId`

请求头：

- `Authorization: Bearer <upload-token>`

支持两种上传方式：

- `multipart/form-data`：明文归档文件名需为 `.tar.gz` / `.tgz`；启用加密时建议使用 `.tar.gz.enc` / `.enc` / `.bin`
- 原始二进制流：`Content-Type: application/gzip` / `application/octet-stream`

示例：

```bash
tar -czf /tmp/claw-fridge.tar.gz -C "$HOME" .openclaw
curl -fS -X POST "http://localhost:3000/api/ice-boxes/boen-mbp/upload/UPLOAD_ID" \
  -H "Authorization: Bearer UPLOAD_TOKEN" \
  -F "iceBoxId=boen-mbp" \
  -F "file=@/tmp/claw-fridge.tar.gz"
```

如果该冰盒启用了上传链路加密，还需要额外提供这些请求头：

- `X-Claw-Fridge-Encryption: aes-256-gcm`
- `X-Claw-Fridge-IV: <base64-iv>`
- `X-Claw-Fridge-Auth-Tag: <base64-auth-tag>`
- `X-Claw-Fridge-Encryption-Key: <本次上传主密钥>`

此时上传的是本地先加密后的二进制文件，服务端只在接收阶段临时解密，不会保存主密钥。

接口会执行以下流程：

- 流式接收并限制最大文件大小（默认 512 MB）
- 校验 token / 过期 / 撤销状态
- 若冰盒启用了上传加密，则要求 `AES-256-GCM` 请求头和本次上传主密钥，并在服务端临时解密
- 验证 gzip 与 tar 结构安全性
- 解压并检查是否包含 `.openclaw` 目录
- 创建或更新 `ice-box/{machine-id}` 分支
- 提交并推送最新备份内容

### 3. 撤销 token

`DELETE /api/ice-boxes/:id/upload-token/:uploadId`

撤销后原上传地址仍存在，但会立刻拒绝该 `uploadId` 对应 token 的后续上传请求。

## 备份恢复 API

`POST /api/ice-boxes/:id/restore`

这个接口把“Git 直推”和“压缩包上传”两种冰盒来源统一收口到同一条恢复链路：服务端始终从仓库里的 `ice-box/<machine-id>` 分支读取 `.openclaw` 快照，再恢复到目标目录下的 `.openclaw`。

### 1. 恢复预览

请求体：

```json
{
  "action": "preview",
  "backupMode": "upload-token",
  "machineId": "boen-mbp",
  "branch": "ice-box/boen-mbp",
  "gitConfig": {
    "repository": "git@github.com:example/fridge.git",
    "kind": "remote",
    "auth": {
      "method": "ssh-key",
      "username": "git",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----...",
      "publicKey": "ssh-ed25519 AAAA...",
      "passphrase": ""
    },
    "updatedAt": null
  },
  "targetRootDir": "/Users/boen"
}
```

成功后会返回：

- 目标分支是否存在可恢复快照
- 最近一次备份时间 / 提交信息
- 仓库内其他可恢复的 `ice-box/...` 分支
- 如果目标目录下已经有 `.openclaw`，会预告覆盖前的备份路径

### 2. 执行恢复

请求体：

```json
{
  "action": "restore",
  "backupMode": "git-branch",
  "machineId": "boen-mbp",
  "branch": "ice-box/boen-mbp",
  "gitConfig": {
    "repository": "git@github.com:example/fridge.git",
    "kind": "remote",
    "auth": {
      "method": "ssh-key",
      "username": "git",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----...",
      "publicKey": "ssh-ed25519 AAAA...",
      "passphrase": ""
    },
    "updatedAt": null
  },
  "targetRootDir": "/Users/boen",
  "confirmRestore": true,
  "replaceExisting": true
}
```

行为说明：

- `targetRootDir` 必须是绝对路径，最终恢复位置固定为 `targetRootDir/.openclaw`
- 不允许把目标目录直接指向危险根路径，也不接受直接填写 `.openclaw` 本身
- 如果目标位置已有 `.openclaw`，必须显式确认 `replaceExisting`
- 覆盖前会先把旧目录重命名成带时间戳的 `.openclaw.claw-fridge-backup-*`
- 如果复制新快照失败，会尽量把旧目录回滚回原位

## 身份识别 API

`POST /api/identity/sync`

请求体：

```json
{
  "rootDir": "/absolute/path/to/.openclaw",
  "outputFileName": "identity.json",
  "force": false
}
```

行为说明：

- 读取 `IDENTITY.md`、`SOUL.md`、`USER.md`、`AGENTS.md`、`TOOLS.md`
- 解析 Markdown 标题、列表、段落
- 提取 `name`、`description`、`role`、`creature`、`vibe`、`emoji`、`skills`、`capabilities`
- 输出到 `rootDir/identity.json`
- 基于源文件哈希做变更检测；未变化时直接返回 `unchanged`

成功响应中的 `identity` 会包含最终提取结果、源文件元数据和整体指纹，可直接用于后续冰盒展示或同步逻辑。

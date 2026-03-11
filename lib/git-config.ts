import type {
  GitAuthConfig,
  GitAuthMethod,
  GitConfigTestResult,
  GitHttpsTokenAuthConfig,
  GitRepositoryConfig,
  GitRepositoryKind,
  GitSshKeyAuthConfig,
} from "@/types";

export const DEFAULT_GIT_CONFIG: GitRepositoryConfig = {
  repository: "",
  kind: "local",
  auth: { method: "none" },
  updatedAt: null,
};

export type GitRepositoryFlavor = "local" | "https" | "ssh" | "remote";
export type GitRepositoryPlatform = "local" | "github" | "gitlab" | "gitea" | "generic";

interface ParsedRemoteRepository {
  protocol: "https" | "ssh";
  host: string;
  path: string;
  username: string | null;
}

const REMOTE_REPOSITORY_PATTERN = /^(https?:\/\/|ssh:\/\/|git@|[^\s@]+@[^\s:]+:.+)/i;
const SSH_REPOSITORY_PATTERN = /^(ssh:\/\/|git@|[^\s@]+@[^\s:]+:.+)/i;
const HTTPS_REPOSITORY_PATTERN = /^https?:\/\//i;

function parseRemoteRepository(repository: string): ParsedRemoteRepository | null {
  const trimmedRepository = repository.trim();

  if (!trimmedRepository) {
    return null;
  }

  if (isHttpsRepository(trimmedRepository) || trimmedRepository.startsWith("ssh://")) {
    try {
      const url = new URL(trimmedRepository);

      return {
        protocol: url.protocol.startsWith("http") ? "https" : "ssh",
        host: url.hostname.toLowerCase(),
        path: url.pathname.replace(/^\/+/, ""),
        username: url.username || null,
      };
    } catch {
      return null;
    }
  }

  const scpStyleMatch = trimmedRepository.match(/^([^\s@]+)@([^\s:]+):(.+)$/);

  if (!scpStyleMatch) {
    return null;
  }

  const [, username, host, path] = scpStyleMatch;

  return {
    protocol: "ssh",
    host: host.toLowerCase(),
    path,
    username,
  };
}

function inferPlatformFromHost(host: string): GitRepositoryPlatform {
  if (host === "github.com" || host === "ssh.github.com" || host.endsWith(".github.com")) {
    return "github";
  }

  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
    return "gitlab";
  }

  if (host === "gitea.com" || host.includes("gitea")) {
    return "gitea";
  }

  return "generic";
}

export function isRemoteRepository(repository: string): boolean {
  return REMOTE_REPOSITORY_PATTERN.test(repository.trim());
}

export function isSshRepository(repository: string): boolean {
  return SSH_REPOSITORY_PATTERN.test(repository.trim());
}

export function isHttpsRepository(repository: string): boolean {
  return HTTPS_REPOSITORY_PATTERN.test(repository.trim());
}

export function detectRepositoryFlavor(
  repository: string,
  fallbackKind: GitRepositoryKind = "local",
): GitRepositoryFlavor {
  const trimmedRepository = repository.trim();

  if (!trimmedRepository) {
    return fallbackKind === "remote" ? "remote" : "local";
  }

  if (isHttpsRepository(trimmedRepository)) {
    return "https";
  }

  if (isSshRepository(trimmedRepository)) {
    return "ssh";
  }

  return isRemoteRepository(trimmedRepository) ? "remote" : "local";
}

export function detectRepositoryPlatform(repository: string): GitRepositoryPlatform {
  if (!isRemoteRepository(repository)) {
    return "local";
  }

  const parsedRepository = parseRemoteRepository(repository);

  if (!parsedRepository) {
    return "generic";
  }

  return inferPlatformFromHost(parsedRepository.host);
}

export function detectRepositoryKind(repository: string): GitRepositoryKind {
  return isRemoteRepository(repository) ? "remote" : "local";
}

export function getGitPlatformLabel(platform: GitRepositoryPlatform): string {
  switch (platform) {
    case "local":
      return "本地仓库";
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "gitea":
      return "Gitea";
    default:
      return "通用 Git 服务";
  }
}

export function getDefaultGitUsername(repository: string, authMethod: Exclude<GitAuthMethod, "none">): string {
  if (authMethod === "ssh-key") {
    return "git";
  }

  switch (detectRepositoryPlatform(repository)) {
    case "gitlab":
      return "oauth2";
    default:
      return "git";
  }
}

export function getGitUsernamePlaceholder(
  repository: string,
  authMethod: Exclude<GitAuthMethod, "none">,
): string {
  const platform = detectRepositoryPlatform(repository);

  if (authMethod === "ssh-key") {
    return platform === "generic" ? "git（若自托管另有要求，改成对应 SSH 用户）" : "git";
  }

  switch (platform) {
    case "github":
      return "GitHub 用户名（留空则尝试 git）";
    case "gitlab":
      return "oauth2 或 Deploy Token 用户名";
    case "gitea":
      return "Gitea 用户名（留空则尝试 git）";
    default:
      return "平台用户名 / token 用户名（留空则尝试 git）";
  }
}

export function getGitTokenPlaceholder(repository: string): string {
  switch (detectRepositoryPlatform(repository)) {
    case "github":
      return "ghp_xxx / github_pat_xxx";
    case "gitlab":
      return "glpat-xxx / Deploy Token";
    case "gitea":
      return "Gitea Access Token / PAT";
    default:
      return "Personal Access Token / Access Token";
  }
}

export function getGitRepositoryExamples(platform: GitRepositoryPlatform): {
  https: string;
  ssh: string;
} {
  switch (platform) {
    case "github":
      return {
        https: "https://github.com/owner/repo.git",
        ssh: "git@github.com:owner/repo.git",
      };
    case "gitlab":
      return {
        https: "https://gitlab.com/group/project.git",
        ssh: "git@gitlab.com:group/project.git",
      };
    case "gitea":
      return {
        https: "https://gitea.com/owner/repo.git",
        ssh: "git@gitea.com:owner/repo.git",
      };
    default:
      return {
        https: "https://git.example.com/team/fridge.git",
        ssh: "ssh://git@git.example.com:2222/team/fridge.git",
      };
  }
}

export function getGitPlatformAuthHelp(
  repository: string,
  authMethod: Exclude<GitAuthMethod, "none">,
): string[] {
  const platform = detectRepositoryPlatform(repository);
  const examples = getGitRepositoryExamples(platform === "local" ? "generic" : platform);

  if (authMethod === "https-token") {
    switch (platform) {
      case "github":
        return [
          "GitHub HTTPS 建议使用 PAT / Fine-grained PAT；token 填在密码位置。",
          "用户名优先填 GitHub 用户名；Fine-grained token 记得给目标仓库的内容读写权限。",
          `示例地址：${examples.https}`,
        ];
      case "gitlab":
        return [
          "GitLab HTTPS 常用 `oauth2` + PAT；如果用 Deploy Token，请改成 GitLab 生成的专用用户名。",
          "开启 2FA 的 GitLab 账户不能再用账号密码，必须改成 token。",
          `示例地址：${examples.https}`,
        ];
      case "gitea":
        return [
          "Gitea HTTPS 一般使用 Access Token / PAT 作为密码，用户名建议填你的 Gitea 账号名。",
          "自托管 Gitea 如果改过域名或端口，以实例实际地址为准。",
          `示例地址：${examples.https}`,
        ];
      default:
        return [
          "通用 HTTPS 仓库通常用 token 代替密码；用户名可能是账号名、`git` 或服务端指定的 token 用户名。",
          "如果是自托管服务，先确认它支持 PAT / Basic Auth 推送。",
          `示例地址：${examples.https}`,
        ];
    }
  }

  switch (platform) {
    case "github":
    case "gitlab":
    case "gitea":
      return [
        `${getGitPlatformLabel(platform)} SSH 通常使用 \`git\` 作为用户名；仓库地址既支持 scp 风格，也支持 \`ssh://\`。`,
        "如果你使用自定义 SSH 端口，请改成 `ssh://git@host:port/owner/repo.git` 这种完整格式。",
        `示例地址：${examples.ssh}`,
      ];
    default:
      return [
        "通用 SSH 仓库默认用户名通常是 `git`，但自托管实例也可能要求 `gitlab`、`forgejo` 或你的系统账号。",
        "标准 scp 格式是 `git@host:owner/repo.git`；有自定义端口时请使用 `ssh://user@host:port/path.git`。",
        `示例地址：${examples.ssh}`,
      ];
  }
}

function normalizeHttpsAuth(auth: GitHttpsTokenAuthConfig): GitHttpsTokenAuthConfig {
  return {
    method: "https-token",
    username: auth.username.trim(),
    token: auth.token.trim(),
  };
}

function normalizeSshAuth(auth: GitSshKeyAuthConfig): GitSshKeyAuthConfig {
  return {
    method: "ssh-key",
    username: auth.username.trim() || "git",
    privateKey: auth.privateKey.trim(),
    publicKey: auth.publicKey.trim(),
    passphrase: auth.passphrase,
  };
}

export function normalizeGitAuth(auth: GitAuthConfig): GitAuthConfig {
  if (auth.method === "https-token") {
    return normalizeHttpsAuth(auth);
  }

  if (auth.method === "ssh-key") {
    return normalizeSshAuth(auth);
  }

  return { method: "none" };
}

export function normalizeGitConfig(config: GitRepositoryConfig): GitRepositoryConfig {
  const repository = config.repository.trim();
  const auth = normalizeGitAuth(config.auth);
  const normalizedAuth =
    auth.method === "none"
      ? auth
      : {
          ...auth,
          username: auth.username || getDefaultGitUsername(repository, auth.method),
        };

  return {
    repository,
    kind: repository ? detectRepositoryKind(repository) : config.kind,
    auth: normalizedAuth,
    updatedAt: config.updatedAt,
  };
}

export function withUpdatedGitConfigTimestamp(config: GitRepositoryConfig): GitRepositoryConfig {
  return {
    ...normalizeGitConfig(config),
    updatedAt: new Date().toISOString(),
  };
}

export function buildGitConfigErrorResult(
  message: string,
  details?: string,
  options: {
    errorCode?: string;
    statusCode?: number;
  } = {},
): GitConfigTestResult {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    message,
    details,
    errorCode: options.errorCode,
    statusCode: options.statusCode ?? 400,
  };
}

export function redactGitConfig(config: GitRepositoryConfig): GitRepositoryConfig {
  const normalized = normalizeGitConfig(config);

  if (normalized.auth.method === "https-token") {
    return {
      ...normalized,
      auth: {
        ...normalized.auth,
        token: normalized.auth.token ? "••••••••" : "",
      },
    };
  }

  if (normalized.auth.method === "ssh-key") {
    return {
      ...normalized,
      auth: {
        ...normalized.auth,
        privateKey: normalized.auth.privateKey ? "••••••••" : "",
        publicKey: normalized.auth.publicKey ? "••••••••" : "",
        passphrase: normalized.auth.passphrase ? "••••••••" : "",
      },
    };
  }

  return normalized;
}

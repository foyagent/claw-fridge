import type {
  GitAuthConfig,
  GitAuthMethod,
  GitConfigTestResult,
  GitHttpsTokenAuthConfig,
  GitRepositoryConfig,
  GitRepositoryKind,
  GitSshKeyAuthConfig,
} from "@/types";
import { tr } from "@/lib/client-translations";

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
      return tr("clientGit.localRepository");
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "gitea":
      return "Gitea";
    default:
      return tr("clientGit.genericGitService");
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
    return platform === "generic" ? tr("clientGit.usernamePlaceholder.sshGeneric") : "git";
  }

  switch (platform) {
    case "github":
      return tr("clientGit.usernamePlaceholder.github");
    case "gitlab":
      return tr("clientGit.usernamePlaceholder.gitlab");
    case "gitea":
      return tr("clientGit.usernamePlaceholder.gitea");
    default:
      return tr("clientGit.usernamePlaceholder.generic");
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
          tr("clientGit.authHelp.githubHttps1"),
          tr("clientGit.authHelp.githubHttps2"),
          tr("clientGit.authHelp.example", { example: examples.https }),
        ];
      case "gitlab":
        return [
          tr("clientGit.authHelp.gitlabHttps1"),
          tr("clientGit.authHelp.gitlabHttps2"),
          tr("clientGit.authHelp.example", { example: examples.https }),
        ];
      case "gitea":
        return [
          tr("clientGit.authHelp.giteaHttps1"),
          tr("clientGit.authHelp.giteaHttps2"),
          tr("clientGit.authHelp.example", { example: examples.https }),
        ];
      default:
        return [
          tr("clientGit.authHelp.genericHttps1"),
          tr("clientGit.authHelp.genericHttps2"),
          tr("clientGit.authHelp.example", { example: examples.https }),
        ];
    }
  }

  switch (platform) {
    case "github":
    case "gitlab":
    case "gitea":
      return [
        tr("clientGit.authHelp.platformSsh1", { platform: getGitPlatformLabel(platform) }),
        tr("clientGit.authHelp.platformSsh2"),
        tr("clientGit.authHelp.example", { example: examples.ssh }),
      ];
    default:
      return [
        tr("clientGit.authHelp.genericSsh1"),
        tr("clientGit.authHelp.genericSsh2"),
        tr("clientGit.authHelp.example", { example: examples.ssh }),
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

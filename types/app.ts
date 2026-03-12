export type Integration =
  | "Next.js"
  | "Tailwind CSS"
  | "ESLint"
  | "Zustand"
  | "isomorphic-git"
  | "Git Config";

export interface ApiErrorShape {
  message: string;
  details?: string;
  code?: string;
  status?: number;
}

export interface OperationResultFields {
  message: string;
  details?: string;
  errorCode?: string;
  statusCode?: number;
  error?: ApiErrorShape;
}

export type GitRepositoryKind = "local" | "remote";

export type GitAuthMethod = "none" | "https-token" | "ssh-key";

export interface GitNoAuthConfig {
  method: "none";
}

export interface GitHttpsTokenAuthConfig {
  method: "https-token";
  username: string;
  token: string;
}

export interface GitSshKeyAuthConfig {
  method: "ssh-key";
  username: string;
  privateKey: string;
  publicKey: string;
  passphrase: string;
}

export type GitAuthConfig = GitNoAuthConfig | GitHttpsTokenAuthConfig | GitSshKeyAuthConfig;

export interface GitRepositoryConfig {
  repository: string;
  kind: GitRepositoryKind;
  auth: GitAuthConfig;
  updatedAt: string | null;
}

export type GitTestTarget = "local" | "remote-https" | "remote-ssh";

export interface GitConfigTestResult extends OperationResultFields {
  ok: boolean;
  checkedAt: string;
  target?: GitTestTarget;
  defaultBranch?: string;
}

export interface FridgeConfigFile {
  version: 1;
  initializedAt: string;
  updatedAt: string;
  fridgeConfigBranch: string;
  iceBoxBranchPrefix: string;
  iceBoxesFile: string;
}

export type IceBoxBackupMode = "git-branch" | "upload-token";

export type IceBoxEncryptionScope = "upload-payload";

export type IceBoxEncryptionAlgorithm = "aes-256-gcm";

export type IceBoxEncryptionKdf = "pbkdf2-sha256";

export type IceBoxEncryptionKeyStrategy = "manual-entry";

export interface IceBoxEncryptionConfig {
  version: 1;
  enabled: boolean;
  scope: IceBoxEncryptionScope;
  algorithm: IceBoxEncryptionAlgorithm;
  kdf: IceBoxEncryptionKdf;
  kdfSalt: string | null;
  kdfIterations: number;
  keyStrategy: IceBoxEncryptionKeyStrategy;
  keyHint: string | null;
  updatedAt: string;
}

export type IceBoxReminderPreset = "daily" | "every-3-days" | "weekly" | "custom";

export type IceBoxReminderStatus = "disabled" | "scheduled" | "due" | "overdue";

export interface IceBoxReminderConfig {
  version: 1;
  enabled: boolean;
  preset: IceBoxReminderPreset;
  intervalHours: number;
  graceHours: number;
  timezone: string;
  updatedAt: string;
}

export interface IceBoxReminderSnapshot {
  reminder: IceBoxReminderConfig;
  configLabel: string;
  status: IceBoxReminderStatus;
  statusLabel: string;
  statusDescription: string;
  basisAt: string | null;
  nextReminderAt: string | null;
  isFirstBackupPending: boolean;
}

export interface IceBoxSkillConfig {
  version: 1;
  iceBoxId: string;
  iceBoxName: string;
  machineId: string;
  backupMode: IceBoxBackupMode;
  repository: string;
  branch: string;
  gitAuthMethod: GitAuthMethod;
  gitUsername: string | null;
  uploadPath: string | null;
  uploadToken: string | null;
  encryption: IceBoxEncryptionConfig;
  createdAt: string;
}

export interface IceBoxRecord {
  id: string;
  name: string;
  machineId: string;
  branch: string;
  backupMode: IceBoxBackupMode;
  uploadPath: string | null;
  uploadToken: string | null;
  reminder: IceBoxReminderConfig;
  skillConfig: IceBoxSkillConfig;
  syncStatus?: IceBoxSyncStatus;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type IceBoxStatus = "healthy" | "syncing" | "attention";

export type IceBoxSyncStatus = "synced" | "pending-sync" | "sync-failed";

export interface IceBoxListItem {
  id: string;
  name: string;
  machineId: string;
  branch: string;
  backupMode: IceBoxBackupMode;
  uploadPath: string | null;
  uploadToken: string | null;
  reminder: IceBoxReminderConfig;
  skillConfig: IceBoxSkillConfig;
  syncStatus: IceBoxSyncStatus;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  deletedAt: string | null;
  status: IceBoxStatus;
  lastBackupAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IceBoxHistoryEntry {
  branch: string;
  commit: string;
  summary: string;
  message: string;
  committedAt: string;
  authorName: string;
  authorEmail: string | null;
}

export interface IceBoxHistoryResult extends OperationResultFields {
  ok: boolean;
  fetchedAt: string;
  branch?: string;
  machineId?: string;
  entries?: IceBoxHistoryEntry[];
}

export interface IceBoxesFile {
  version: 1;
  initializedAt: string;
  updatedAt: string;
  items: IceBoxRecord[];
}

export interface CreateIceBoxInput {
  name: string;
  machineId: string;
  backupMode: IceBoxBackupMode;
  gitConfig: GitRepositoryConfig;
  encryption: IceBoxEncryptionConfig;
}

export interface CreateIceBoxResult extends OperationResultFields {
  ok: boolean;
  createdAt: string;
  item?: IceBoxListItem;
}

export interface SyncIceBoxResult extends OperationResultFields {
  ok: boolean;
  syncedAt: string;
  item?: IceBoxListItem;
  commit?: string;
}

export interface SyncPendingIceBoxesResult extends OperationResultFields {
  ok: boolean;
  syncedAt: string;
  syncedCount: number;
  failedIds: string[];
}

export interface CreateUploadTokenInput {
  iceBoxName: string;
  machineId: string;
  gitConfig: GitRepositoryConfig;
  encryption: IceBoxEncryptionConfig;
  expiresInHours?: number;
}

export interface CreateUploadTokenResult extends OperationResultFields {
  ok: boolean;
  createdAt: string;
  iceBoxId?: string;
  machineId?: string;
  branch?: string;
  uploadId?: string;
  uploadPath?: string;
  uploadToken?: string;
  expiresAt?: string;
}

export interface RevokeUploadTokenResult extends OperationResultFields {
  ok: boolean;
  revokedAt: string;
  iceBoxId?: string;
  uploadId?: string;
}

export interface UploadBackupResult extends OperationResultFields {
  ok: boolean;
  receivedAt: string;
  iceBoxId?: string;
  machineId?: string;
  branch?: string;
  bytesReceived?: number;
  commit?: string;
  lastBackupAt?: string;
}

export interface RestoreBranchPreview {
  branch: string;
  exists: boolean;
  lastCommit: string | null;
  lastBackupAt: string | null;
  summary: string | null;
  authorName: string | null;
  authorEmail: string | null;
}

export interface RestorePreviewSource {
  backupMode: IceBoxBackupMode;
  machineId: string;
  branch: string;
  repository: string;
  restoredPath?: string;
}

export interface RestorePreviewResult extends OperationResultFields {
  ok: boolean;
  previewedAt: string;
  source?: RestorePreviewSource;
  selectedBranch?: RestoreBranchPreview;
  availableBranches?: RestoreBranchPreview[];
  targetRootDir?: string;
  restoredPath?: string;
  targetExists?: boolean;
  requiresOverwriteConfirmation?: boolean;
  overwriteBackupPath?: string | null;
}

export interface RestoreBackupResult extends OperationResultFields {
  ok: boolean;
  restoredAt: string;
  branch?: string;
  machineId?: string;
  repository?: string;
  commit?: string;
  lastBackupAt?: string;
  targetRootDir?: string;
  restoredPath?: string;
  previousPathBackup?: string | null;
  requiresOverwriteConfirmation?: boolean;
}

export interface RestorePreviewRequest {
  action: "preview";
  backupMode: IceBoxBackupMode;
  machineId: string;
  branch: string;
  commit?: string;
  gitConfig: GitRepositoryConfig;
  targetRootDir?: string;
}

export interface RestoreExecuteRequest {
  action: "restore";
  backupMode: IceBoxBackupMode;
  machineId: string;
  branch: string;
  commit?: string;
  gitConfig: GitRepositoryConfig;
  targetRootDir: string;
  confirmRestore: boolean;
  replaceExisting?: boolean;
}

export type RestoreRequest = RestorePreviewRequest | RestoreExecuteRequest;

export interface UploadTokenRecord {
  id: string;
  iceBoxId: string;
  iceBoxName: string;
  machineId: string;
  branch: string;
  uploadPath: string;
  tokenHash: string;
  gitConfig: GitRepositoryConfig;
  encryption: IceBoxEncryptionConfig;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastBackupAt: string | null;
}

export interface UploadTokenStoreFile {
  version: 1;
  updatedAt: string;
  items: UploadTokenRecord[];
}

export interface FridgeConfigSeedFile {
  path: string;
  content: string;
}

export interface CreateFridgeConfigFilesOptions {
  initializedAt?: string;
}

export interface SeedFridgeConfigFilesOptions extends CreateFridgeConfigFilesOptions {
  dir: string;
  overwrite?: boolean;
  skipExisting?: boolean;
}

export interface SeedFridgeConfigFilesResult {
  root: string;
  initializedAt: string;
  files: Array<{
    path: string;
    status: "created" | "overwritten" | "unchanged";
  }>;
}

export interface GitConfigInitResult extends OperationResultFields {
  ok: boolean;
  initializedAt: string;
  branch?: string;
  root?: string;
  commit?: string;
  files?: SeedFridgeConfigFilesResult["files"];
  alreadyInitialized?: boolean;
}

export interface AppState {
  projectName: string;
  initializedAt: string;
  integrations: Integration[];
  gitConfig: GitRepositoryConfig;
  hasHydrated: boolean;
  lastGitTestResult: GitConfigTestResult | null;
  lastGitInitResult: GitConfigInitResult | null;
  setProjectName: (projectName: string) => void;
  setHydrated: (hasHydrated: boolean) => void;
  saveGitConfig: (gitConfig: GitRepositoryConfig) => void;
  testGitConfig: (gitConfig: GitRepositoryConfig) => Promise<GitConfigTestResult>;
  initializeFridgeConfig: (gitConfig: GitRepositoryConfig) => Promise<GitConfigInitResult>;
  clearGitTestResult: () => void;
  clearGitInitResult: () => void;
}

export interface IceBoxStoreState {
  iceBoxes: IceBoxListItem[];
  hasHydrated: boolean;
  hasLoaded: boolean;
  isLoading: boolean;
  isCreating: boolean;
  error: string | null;
  setHydrated: (hasHydrated: boolean) => void;
  loadIceBoxes: (gitConfig: GitRepositoryConfig) => Promise<void>;
  createIceBox: (input: CreateIceBoxInput) => Promise<CreateIceBoxResult>;
  syncIceBox: (id: string, gitConfig: GitRepositoryConfig) => Promise<SyncIceBoxResult>;
  syncPendingIceBoxes: (gitConfig: GitRepositoryConfig) => Promise<SyncPendingIceBoxesResult>;
  updateIceBoxReminder: (id: string, reminder: IceBoxReminderConfig, gitConfig?: GitRepositoryConfig) => Promise<void>;
  resetIceBoxReminder: (id: string, gitConfig?: GitRepositoryConfig) => Promise<void>;
  syncIceBoxBackupState: (id: string, lastBackupAt: string | null) => void;
  deleteIceBox: (id: string, gitConfig: GitRepositoryConfig) => Promise<void>;
  clearError: () => void;
}

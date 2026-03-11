export type IdentitySourceKind = "identity" | "soul" | "user" | "agents" | "tools";

export interface IdentitySourceFile {
  kind: IdentitySourceKind;
  fileName: string;
  path: string;
  exists: boolean;
  size: number;
  sha256: string | null;
  updatedAt: string | null;
}

export interface AssistantIdentityProfile {
  name: string | null;
  description: string | null;
  role: string | null;
  creature: string | null;
  vibe: string | null;
  emoji: string | null;
  skills: string[];
  capabilities: string[];
  principles: string[];
  boundaries: string[];
  notes: string[];
}

export interface OwnerIdentityProfile {
  name: string | null;
  preferredName: string | null;
  timezone: string | null;
  notes: string[];
}

export interface GeneratedIdentityFile {
  version: 1;
  parserVersion: string;
  generatedAt: string;
  sourceRoot: string;
  outputPath: string;
  sourceFingerprint: string;
  assistant: AssistantIdentityProfile;
  owner: OwnerIdentityProfile;
  sources: IdentitySourceFile[];
}

export interface SyncIdentityOptions {
  rootDir: string;
  outputFileName?: string;
  force?: boolean;
}

export interface SyncIdentityResult {
  ok: boolean;
  status: "created" | "updated" | "unchanged";
  message: string;
  details?: string;
  identity: GeneratedIdentityFile;
}

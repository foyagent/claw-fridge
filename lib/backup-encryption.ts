import type { IceBoxEncryptionConfig } from "@/types";

export const uploadPayloadEncryptionScope = "upload-payload" as const;
export const uploadPayloadEncryptionAlgorithm = "aes-256-gcm" as const;
export const uploadPayloadEncryptionKdf = "pbkdf2-sha256" as const;
export const uploadPayloadEncryptionKeyStrategy = "manual-entry" as const;
export const defaultUploadPayloadKdfIterations = 210_000;

export const uploadPayloadEncryptionHeaders = {
  algorithm: "x-claw-fridge-encryption",
  iv: "x-claw-fridge-iv",
  authTag: "x-claw-fridge-auth-tag",
  passphrase: "x-claw-fridge-encryption-key",
} as const;

export function createDisabledEncryptionConfig(updatedAt = new Date().toISOString()): IceBoxEncryptionConfig {
  return {
    version: 1,
    enabled: false,
    scope: uploadPayloadEncryptionScope,
    algorithm: uploadPayloadEncryptionAlgorithm,
    kdf: uploadPayloadEncryptionKdf,
    kdfSalt: null,
    kdfIterations: defaultUploadPayloadKdfIterations,
    keyStrategy: uploadPayloadEncryptionKeyStrategy,
    keyHint: null,
    updatedAt,
  };
}

export function isEncryptionEnabled(encryption: IceBoxEncryptionConfig | null | undefined): boolean {
  return Boolean(encryption?.enabled && encryption.kdfSalt);
}

export function normalizeEncryptionKeyHint(value: string): string | null {
  const normalizedValue = value.trim();

  return normalizedValue ? normalizedValue : null;
}

export function isValidEncryptionSalt(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    if (typeof window === "undefined") {
      Buffer.from(value, "base64");
      return true;
    }

    window.atob(value);
    return true;
  } catch {
    return false;
  }
}

"use client";

import type { PersistStorage, StorageValue } from "zustand/middleware";

const DATABASE_NAME = "claw-fridge-secure-storage";
const STORE_NAME = "keys";
const KEY_NAME = "zustand-persist-key";

interface EncryptedPayload {
  iv: string;
  ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return window.btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开安全存储数据库。"));
  });
}

function readKey(database: IDBDatabase): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(KEY_NAME);

    request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
    request.onerror = () => reject(request.error ?? new Error("无法读取加密密钥。"));
  });
}

function writeKey(database: IDBDatabase, key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(key, KEY_NAME);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("无法写入加密密钥。"));
  });
}

async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
  if (typeof window === "undefined" || !window.crypto?.subtle || !window.indexedDB) {
    throw new Error("当前环境不支持加密存储。");
  }

  const database = await openDatabase();
  const existingKey = await readKey(database);

  if (existingKey) {
    return existingKey;
  }

  const key = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  await writeKey(database, key);

  return key;
}

async function encryptValue(value: string): Promise<string> {
  const key = await getOrCreateEncryptionKey();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const payload: EncryptedPayload = {
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };

  return JSON.stringify(payload);
}

async function decryptValue(value: string): Promise<string> {
  const payload = JSON.parse(value) as Partial<EncryptedPayload>;

  if (!payload.iv || !payload.ciphertext) {
    return value;
  }

  const key = await getOrCreateEncryptionKey();
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.ciphertext),
  );

  return new TextDecoder().decode(decrypted);
}

export function createEncryptedPersistStorage<T>(): PersistStorage<T, Promise<void>> {
  return {
    getItem: async (name: string): Promise<StorageValue<T> | null> => {
      if (typeof window === "undefined") {
        return null;
      }

      const rawValue = window.localStorage.getItem(name);

      if (!rawValue) {
        return null;
      }

      try {
        const decrypted = await decryptValue(rawValue);

        return JSON.parse(decrypted) as StorageValue<T>;
      } catch {
        window.localStorage.removeItem(name);
        return null;
      }
    },
    setItem: async (name: string, value: StorageValue<T>): Promise<void> => {
      if (typeof window === "undefined") {
        return;
      }

      const encrypted = await encryptValue(JSON.stringify(value));
      window.localStorage.setItem(name, encrypted);
    },
    removeItem: async (name: string): Promise<void> => {
      if (typeof window === "undefined") {
        return;
      }

      window.localStorage.removeItem(name);
    },
  };
}

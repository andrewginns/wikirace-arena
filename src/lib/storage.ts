type StorageKind = "local" | "session";

function getStorage(kind: StorageKind): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function safeStorageGetItem(kind: StorageKind, key: string): string | null {
  const storage = getStorage(kind);
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSetItem(kind: StorageKind, key: string, value: string): boolean {
  const storage = getStorage(kind);
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeStorageRemoveItem(kind: StorageKind, key: string): boolean {
  const storage = getStorage(kind);
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function safeStorageGetJson<T>(kind: StorageKind, key: string): T | null {
  return safeJsonParse<T>(safeStorageGetItem(kind, key));
}

export function safeLocalStorageGetJsonWithStatus<T>(key: string): {
  value: T | null;
  parseFailed: boolean;
} {
  const raw = safeLocalStorageGetItem(key);
  const value = safeJsonParse<T>(raw);
  return {
    value,
    parseFailed: raw !== null && value === null,
  };
}

export function safeStorageSetJson(kind: StorageKind, key: string, value: unknown): boolean {
  try {
    return safeStorageSetItem(kind, key, JSON.stringify(value));
  } catch {
    return false;
  }
}

export function safeLocalStorageGetItem(key: string) {
  return safeStorageGetItem("local", key);
}

export function safeLocalStorageSetItem(key: string, value: string): boolean {
  return safeStorageSetItem("local", key, value);
}

export function safeLocalStorageRemoveItem(key: string): boolean {
  return safeStorageRemoveItem("local", key);
}

export function safeLocalStorageGetJson<T>(key: string): T | null {
  return safeStorageGetJson<T>("local", key);
}

export function safeLocalStorageSetJson(key: string, value: unknown): boolean {
  return safeStorageSetJson("local", key, value);
}

export function safeSessionStorageGetItem(key: string) {
  return safeStorageGetItem("session", key);
}

export function safeSessionStorageSetItem(key: string, value: string): boolean {
  return safeStorageSetItem("session", key, value);
}

export function safeSessionStorageRemoveItem(key: string): boolean {
  return safeStorageRemoveItem("session", key);
}

export function safeSessionStorageGetJson<T>(key: string): T | null {
  return safeStorageGetJson<T>("session", key);
}

export function safeSessionStorageSetJson(key: string, value: unknown): boolean {
  return safeStorageSetJson("session", key, value);
}

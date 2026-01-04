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

export function safeStorageSetItem(kind: StorageKind, key: string, value: string) {
  const storage = getStorage(kind);
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function safeStorageRemoveItem(kind: StorageKind, key: string) {
  const storage = getStorage(kind);
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore
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

export function safeStorageSetJson(kind: StorageKind, key: string, value: unknown) {
  try {
    safeStorageSetItem(kind, key, JSON.stringify(value));
  } catch {
    // ignore (e.g. circular structures)
  }
}

export function safeLocalStorageGetItem(key: string) {
  return safeStorageGetItem("local", key);
}

export function safeLocalStorageSetItem(key: string, value: string) {
  safeStorageSetItem("local", key, value);
}

export function safeLocalStorageRemoveItem(key: string) {
  safeStorageRemoveItem("local", key);
}

export function safeLocalStorageGetJson<T>(key: string): T | null {
  return safeStorageGetJson<T>("local", key);
}

export function safeLocalStorageSetJson(key: string, value: unknown) {
  safeStorageSetJson("local", key, value);
}

export function safeSessionStorageGetItem(key: string) {
  return safeStorageGetItem("session", key);
}

export function safeSessionStorageSetItem(key: string, value: string) {
  safeStorageSetItem("session", key, value);
}

export function safeSessionStorageRemoveItem(key: string) {
  safeStorageRemoveItem("session", key);
}

export function safeSessionStorageGetJson<T>(key: string): T | null {
  return safeStorageGetJson<T>("session", key);
}

export function safeSessionStorageSetJson(key: string, value: unknown) {
  safeStorageSetJson("session", key, value);
}


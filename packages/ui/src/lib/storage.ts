// localStorage can be missing or throw (private mode, blocked storage, Capacitor quirks).

function ls(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadJson<T>(key: string): T | null {
  try {
    const raw = ls()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    ls()?.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function loadString(key: string): string | null {
  try {
    return ls()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function saveString(key: string, value: string): void {
  try {
    ls()?.setItem(key, value);
  } catch {
    // ignore
  }
}

export function remove(key: string): void {
  try {
    ls()?.removeItem(key);
  } catch {
    // ignore
  }
}

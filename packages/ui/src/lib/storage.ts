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

/** Every key in storage (empty when storage is unavailable). */
export function keys(): string[] {
  try {
    const s = ls();
    if (!s) return [];
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

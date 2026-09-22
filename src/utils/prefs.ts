import { config } from "../../package.json";

const P = config.prefsPrefix;

export function getPref<T = any>(key: string, fallback?: T): T {
  const value = Zotero.Prefs.get(`${P}.${key}`, true);
  return (value === undefined ? fallback : value) as T;
}

export function setPref(key: string, value: string | number | boolean) {
  return Zotero.Prefs.set(`${P}.${key}`, value, true);
}

export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${P}.${key}`, true);
}

/** Read a JSON-encoded preference, falling back to `def` on any parse error. */
export function getJSONPref<T>(key: string, def: T): T {
  const raw = getPref<string>(key, "");
  if (!raw) return def;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? def : (parsed as T);
  } catch {
    return def;
  }
}

export function setJSONPref(key: string, value: unknown) {
  setPref(key, JSON.stringify(value));
}

export function onPrefChange(key: string, handler: () => void): symbol {
  return Zotero.Prefs.registerObserver(`${P}.${key}`, handler, true) as symbol;
}

export function offPrefChange(id: symbol) {
  try {
    Zotero.Prefs.unregisterObserver(id);
  } catch {
    /* already gone */
  }
}

import { config } from "../../package.json";

export { initLocale, getString, getLocaleID };

function initLocale() {
  const L10n =
    typeof Localization === "undefined"
      ? ztoolkit.getGlobal("Localization")
      : Localization;
  addon.data.locale = { current: new L10n([`${config.addonRef}-addon.ftl`], true) };
}

interface Pattern {
  value: string | null;
  attributes: Array<{ name: string; value: string }> | null;
}

function getString(
  key: string,
  options: { branch?: string; args?: Record<string, unknown> } = {},
): string {
  const id = `${config.addonRef}-${key}`;
  try {
    const pattern = addon.data.locale?.current.formatMessagesSync([
      { id, args: options.args },
    ])[0] as Pattern;
    if (!pattern) return key;
    if (options.branch && pattern.attributes) {
      return (
        pattern.attributes.find((a) => a.name === options.branch)?.value || key
      );
    }
    return pattern.value || key;
  } catch {
    return key;
  }
}

function getLocaleID(key: string) {
  return `${config.addonRef}-${key}`;
}

/** True when the Zotero UI is running in a Chinese locale. */
export function isZH(): boolean {
  return /^zh/i.test(Zotero.locale || "");
}

/** Pick one of two strings according to the Zotero UI language. */
export function bi(en: string, zh: string): string {
  return isZH() ? zh : en;
}

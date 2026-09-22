/**
 * Translation engines.
 *
 * Every engine is a function from a batch of strings to a batch of strings, so
 * the full-text pipeline, the selection popup and the metadata translator all
 * share one implementation, one cache and one concurrency limiter.
 */

import { getJSONPref, getPref } from "../../utils/prefs";
import { bi } from "../../utils/locale";
import { request, errorText } from "../../utils/http";
import { chat } from "../lens/provider";
import { hash } from "../../utils/text";
import { JSONStore } from "../../utils/store";

export interface EngineContext {
  from: string;
  to: string;
  keys: Record<string, string>;
}

/** Display names for the credential fields in `needsKey`. */
export function fieldLabel(field: string): string {
  const labels: Record<string, [string, string]> = {
    endpoint: ["Endpoint", "服务地址"],
    authKey: ["Auth key", "认证密钥"],
    key: ["Key", "密钥"],
    region: ["Region", "区域"],
    appid: ["App ID", "APP ID"],
    appKey: ["App key", "应用 ID"],
    appSecret: ["App secret", "应用密钥"],
    apikey: ["API key", "API 密钥"],
  };
  const pair = labels[field];
  return pair ? bi(pair[0], pair[1]) : field;
}

export interface Engine {
  id: string;
  label: string;
  /** free engines need no credentials at all */
  needsKey?: string[];
  /** how many strings one call can take */
  batch: number;
  translate: (texts: string[], ctx: EngineContext) => Promise<string[]>;
}

const cacheStore = new JSONStore<Record<string, string>>("translation-cache", {});

export async function loadCache() {
  const data = await cacheStore.load();
  for (const [key, value] of Object.entries(data)) {
    addon.data.refract.cache.set(key, value);
  }
}

function cacheKey(engine: string, to: string, text: string) {
  return `${engine}:${to}:${hash(text)}`;
}

function readCache(engine: string, to: string, text: string): string | undefined {
  if (!getPref<boolean>("refract.cacheEnabled", true)) return undefined;
  return addon.data.refract.cache.get(cacheKey(engine, to, text));
}

function writeCache(engine: string, to: string, text: string, value: string) {
  if (!getPref<boolean>("refract.cacheEnabled", true)) return;
  const key = cacheKey(engine, to, text);
  addon.data.refract.cache.set(key, value);
  const data = cacheStore.get();
  data[key] = value;
  cacheStore.schedule(15000);
}

/* ------------------------------------------------------------------ helpers */

function langFor(engine: string, code: string): string {
  const lower = code.toLowerCase();
  const table: Record<string, Record<string, string>> = {
    deepl: { "zh-cn": "ZH", "zh-tw": "ZH", en: "EN", ja: "JA", ko: "KO", de: "DE", fr: "FR", es: "ES", ru: "RU", auto: "" },
    baidu: { "zh-cn": "zh", "zh-tw": "cht", en: "en", ja: "jp", ko: "kor", de: "de", fr: "fra", es: "spa", ru: "ru", auto: "auto" },
    youdao: { "zh-cn": "zh-CHS", "zh-tw": "zh-CHT", en: "en", ja: "ja", ko: "ko", auto: "auto" },
    niutrans: { "zh-cn": "zh", "zh-tw": "cht", en: "en", ja: "ja", ko: "ko", auto: "auto" },
  };
  return table[engine]?.[lower] ?? code;
}

async function md5(text: string): Promise<string> {
  // WebCrypto has no MD5, and signing with the wrong digest would fail server
  // side with a confusing error, so this reports the real problem instead.
  const digest = (Zotero.Utilities.Internal as any).md5?.(text, false);
  if (typeof digest !== "string" || digest.length !== 32) {
    throw new Error(
      "This engine needs Zotero's MD5 helper, which is unavailable in this build.",
    );
  }
  return digest;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------------ engines */

export const ENGINES: Engine[] = [
  {
    id: "google",
    get label() {
      return bi("Google (free)", "Google（免费）");
    },
    batch: 1,
    async translate(texts, ctx) {
      const out: string[] = [];
      for (const text of texts) {
        const url =
          `https://translate.googleapis.com/translate_a/single?client=gtx` +
          `&sl=${ctx.from === "auto" ? "auto" : ctx.from}&tl=${ctx.to}&dt=t&q=${encodeURIComponent(text)}`;
        const { text: body } = await request("GET", url, { timeout: 20000 });
        const data = JSON.parse(body);
        out.push((data?.[0] || []).map((part: any[]) => part[0]).join(""));
      }
      return out;
    },
  },
  {
    id: "deeplx",
    get label() {
      return bi("DeepLX (self-hosted)", "DeepLX（自行部署）");
    },
    needsKey: ["endpoint"],
    batch: 1,
    async translate(texts, ctx) {
      const endpoint = ctx.keys.endpoint || "http://127.0.0.1:1188/translate";
      const out: string[] = [];
      for (const text of texts) {
        const { text: body } = await request("POST", endpoint, {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            source_lang: langFor("deepl", ctx.from) || "auto",
            target_lang: langFor("deepl", ctx.to),
          }),
          timeout: 30000,
        });
        out.push(JSON.parse(body)?.data || "");
      }
      return out;
    },
  },
  {
    id: "deepl",
    label: "DeepL",
    needsKey: ["authKey"],
    batch: 25,
    async translate(texts, ctx) {
      const key = ctx.keys.authKey || "";
      const host = key.endsWith(":fx")
        ? "https://api-free.deepl.com"
        : "https://api.deepl.com";
      const params = new URLSearchParams();
      params.set("auth_key", key);
      params.set("target_lang", langFor("deepl", ctx.to));
      if (ctx.from !== "auto") params.set("source_lang", langFor("deepl", ctx.from));
      for (const text of texts) params.append("text", text);
      const { text: body } = await request("POST", `${host}/v2/translate`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        timeout: 40000,
      });
      return (JSON.parse(body).translations || []).map((t: any) => t.text);
    },
  },
  {
    id: "microsoft",
    get label() {
      return bi("Microsoft Translator", "微软翻译");
    },
    needsKey: ["key", "region"],
    batch: 25,
    async translate(texts, ctx) {
      const url =
        `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${ctx.to}` +
        (ctx.from !== "auto" ? `&from=${ctx.from}` : "");
      const { text: body } = await request("POST", url, {
        headers: {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": ctx.keys.key || "",
          "Ocp-Apim-Subscription-Region": ctx.keys.region || "global",
        },
        body: JSON.stringify(texts.map((text) => ({ Text: text }))),
        timeout: 40000,
      });
      return JSON.parse(body).map((entry: any) => entry.translations?.[0]?.text || "");
    },
  },
  {
    id: "baidu",
    get label() {
      return bi("Baidu", "百度翻译");
    },
    needsKey: ["appid", "key"],
    batch: 1,
    async translate(texts, ctx) {
      const out: string[] = [];
      for (const text of texts) {
        const salt = String(Date.now());
        const sign = await md5(
          `${ctx.keys.appid}${text}${salt}${ctx.keys.key}`,
        );
        const params = new URLSearchParams({
          q: text,
          from: langFor("baidu", ctx.from),
          to: langFor("baidu", ctx.to),
          appid: ctx.keys.appid || "",
          salt,
          sign,
        });
        const { text: body } = await request(
          "POST",
          "https://fanyi-api.baidu.com/api/trans/vip/translate",
          {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
            timeout: 25000,
          },
        );
        const data = JSON.parse(body);
        if (data.error_code) throw new Error(`Baidu ${data.error_code}: ${data.error_msg}`);
        out.push((data.trans_result || []).map((r: any) => r.dst).join("\n"));
      }
      return out;
    },
  },
  {
    id: "youdao",
    get label() {
      return bi("Youdao", "有道翻译");
    },
    needsKey: ["appKey", "appSecret"],
    batch: 1,
    async translate(texts, ctx) {
      const out: string[] = [];
      for (const text of texts) {
        const salt = String(Date.now());
        const curtime = String(Math.floor(Date.now() / 1000));
        const input =
          text.length > 20
            ? `${text.slice(0, 10)}${text.length}${text.slice(-10)}`
            : text;
        const sign = await sha256(
          `${ctx.keys.appKey}${input}${salt}${curtime}${ctx.keys.appSecret}`,
        );
        const params = new URLSearchParams({
          q: text,
          from: langFor("youdao", ctx.from),
          to: langFor("youdao", ctx.to),
          appKey: ctx.keys.appKey || "",
          salt,
          sign,
          signType: "v3",
          curtime,
        });
        const { text: body } = await request(
          "POST",
          "https://openapi.youdao.com/api",
          {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
            timeout: 25000,
          },
        );
        const data = JSON.parse(body);
        out.push((data.translation || []).join("\n"));
      }
      return out;
    },
  },
  {
    id: "niutrans",
    get label() {
      return bi("NiuTrans", "小牛翻译");
    },
    needsKey: ["apikey"],
    batch: 1,
    async translate(texts, ctx) {
      const out: string[] = [];
      for (const text of texts) {
        const { text: body } = await request(
          "POST",
          "https://api.niutrans.com/NiuTransServer/translation",
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              src_text: text,
              from: langFor("niutrans", ctx.from),
              to: langFor("niutrans", ctx.to),
              apikey: ctx.keys.apikey,
            }),
            timeout: 25000,
          },
        );
        out.push(JSON.parse(body).tgt_text || "");
      }
      return out;
    },
  },
  {
    id: "libretranslate",
    label: "LibreTranslate",
    needsKey: ["endpoint"],
    batch: 1,
    async translate(texts, ctx) {
      const endpoint = ctx.keys.endpoint || "http://127.0.0.1:5000/translate";
      const out: string[] = [];
      for (const text of texts) {
        const { text: body } = await request("POST", endpoint, {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            q: text,
            source: ctx.from === "auto" ? "auto" : ctx.from,
            target: ctx.to.split("-")[0],
            format: "text",
            api_key: ctx.keys.apiKey || "",
          }),
          timeout: 30000,
        });
        out.push(JSON.parse(body).translatedText || "");
      }
      return out;
    },
  },
  {
    id: "llm",
    get label() {
      return bi("AI model (uses your Prism model)", "AI 模型（使用棱镜的模型配置）");
    },
    batch: 12,
    async translate(texts, ctx) {
      const numbered = texts
        .map((text, index) => `<<${index + 1}>>\n${text}`)
        .join("\n\n");
      const answer = await chat(
        [
          {
            role: "system",
            content:
              "You are a scientific translator. Translate faithfully, keep terminology, symbols, numbers and citation markers untouched, and never add commentary.",
          },
          {
            role: "user",
            content: `Translate each numbered block into ${ctx.to}. Return the blocks in the same order and with the same <<n>> markers, nothing else.\n\n${numbered}`,
          },
        ],
        { temperature: 0.1, transport: "api" },
      );
      const out: string[] = new Array(texts.length).fill("");
      const pattern = /<<(\d+)>>\s*([\s\S]*?)(?=\n?<<\d+>>|$)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(answer))) {
        const index = Number(match[1]) - 1;
        if (index >= 0 && index < out.length) out[index] = match[2].trim();
      }
      return out.map((value, index) => value || texts[index]);
    },
  },
];

export function engineByID(id: string): Engine {
  return ENGINES.find((e) => e.id === id) || ENGINES[0];
}

export function engineKeys(id: string): Record<string, string> {
  const all = getJSONPref<Record<string, Record<string, string>>>(
    "refract.engineKeys",
    {},
  );
  return all[id] || {};
}

export function engineReady(id: string): boolean {
  const engine = engineByID(id);
  if (!engine.needsKey?.length) return true;
  const keys = engineKeys(id);
  return engine.needsKey.every((name) => !!keys[name]);
}

/* -------------------------------------------------------------- entry points */

export async function translateText(
  text: string,
  options: { engine?: string; to?: string; from?: string } = {},
): Promise<string> {
  const results = await translateBatch([text], options);
  return results[0] || "";
}

/**
 * Translate a batch, honouring the cache, the engine's own batch size and the
 * configured concurrency. Returns one result per input, in order.
 */
export async function translateBatch(
  texts: string[],
  options: {
    engine?: string;
    to?: string;
    from?: string;
    onProgress?: (done: number, total: number) => void;
    onEngineSwitch?: (from: string, to: string, reason: string) => void;
    shouldStop?: () => boolean;
  } = {},
): Promise<string[]> {
  const engineID = options.engine || getPref<string>("refract.engine", "google");
  const engine = engineByID(engineID);
  if (!engineReady(engineID)) {
    const keys = engineKeys(engineID);
    const missing = (engine.needsKey || []).filter((name) => !keys[name]);
    const fields = missing.map(fieldLabel).join(bi(", ", "、"));
    throw new Error(
      bi(
        `${engine.label}: missing ${fields}. Add it under Settings → Prism → Translation.`,
        `${engine.label}缺少${fields}，请在「设置 → Prism → 翻译」中填写。`,
      ),
    );
  }
  const to = options.to || getPref<string>("refract.targetLang", "zh-CN");
  const from = options.from || getPref<string>("refract.sourceLang", "auto");

  const results: string[] = new Array(texts.length).fill("");
  let pending: Entry[] = [];
  texts.forEach((text, index) => {
    if (!text.trim()) return;
    const cached = readCache(engineID, to, text);
    if (cached !== undefined) results[index] = cached;
    else pending.push({ index, text });
  });

  const total = texts.length;
  let done = total - pending.length;
  const report = (finished: number) => {
    done += finished;
    options.onProgress?.(done, total);
  };

  let failure: unknown;
  try {
    pending = await runEngine(engineID, { from, to }, pending, results, report, options);
  } catch (e) {
    failure = e;
  }

  /* Every remaining entry failed on the chosen engine. One dead engine used to
     take the whole document with it — a 429 from a public endpoint halfway
     through left the rest of the pages blank — so the leftovers are offered to
     the other engines that can run without asking the user for anything. */
  if ((pending.length || failure) && getPref<boolean>("refract.engineFallback", true)) {
    for (const nextID of fallbackOrder(engineID)) {
      if (!pending.length) break;
      if (options.shouldStop?.()) break;
      options.onEngineSwitch?.(engineID, nextID, errorText(failure));
      Zotero.debug(`[Prism] translation falling back to ${nextID}`);
      try {
        pending = await runEngine(nextID, { from, to }, pending, results, report, options);
        failure = undefined;
      } catch (e) {
        failure = e;
      }
    }
  }
  if (failure && !results.some(Boolean)) throw failure;

  await cacheStore.flush();
  return results;
}

interface Entry {
  index: number;
  text: string;
}

/**
 * Run one engine over the outstanding entries; return whatever it could not do.
 *
 * Throws only when the engine rejected us outright (bad or missing
 * credentials), which is the one case where retrying the rest of the document
 * against the same engine is pointless.
 */
async function runEngine(
  engineID: string,
  lang: { from: string; to: string },
  entries: Entry[],
  results: string[],
  report: (finished: number) => void,
  options: {
    onProgress?: (done: number, total: number) => void;
    shouldStop?: () => boolean;
  },
): Promise<Entry[]> {
  if (!entries.length) return entries;
  const engine = engineByID(engineID);
  const ctx: EngineContext = { ...lang, keys: engineKeys(engineID) };

  const groups: Entry[][] = [];
  for (let i = 0; i < entries.length; i += engine.batch) {
    groups.push(entries.slice(i, i + engine.batch));
  }

  const concurrency = Math.max(1, Number(getPref("refract.concurrency", 4)));
  const failed: Entry[] = [];
  let cursor = 0;
  let fatal: unknown;

  const worker = async () => {
    while (cursor < groups.length) {
      if (options.shouldStop?.() || fatal) return;
      const group = groups[cursor++];
      try {
        const translated = await engine.translate(
          group.map((entry) => entry.text),
          ctx,
        );
        group.forEach((entry, i) => {
          const value = translated[i] ?? "";
          if (value) {
            results[entry.index] = value;
            writeCache(engineID, lang.to, entry.text, value);
          } else {
            failed.push(entry);
          }
        });
      } catch (e) {
        Zotero.debug(`[Prism] ${engineID} translation failed: ${errorText(e)}`);
        failed.push(...group);
        if (/40[13]|unauthor|invalid/i.test(errorText(e))) fatal = e;
      }
      report(group.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.length || 1) }, worker),
  );
  // Groups never reached because a worker bailed out are still outstanding.
  for (let i = cursor; i < groups.length; i++) failed.push(...groups[i]);
  if (fatal) throw fatal;
  return failed;
}

/**
 * Engines worth trying after `engineID`: the ones that need no credentials, and
 * any the user has already given keys to. "llm" is left out — falling back onto
 * a paid model without being asked is not a favour.
 */
function fallbackOrder(engineID: string): string[] {
  return ENGINES.filter(
    (engine) =>
      engine.id !== engineID &&
      engine.id !== "llm" &&
      engineReady(engine.id) &&
      (!engine.needsKey?.length ||
        Object.keys(engineKeys(engine.id)).length > 0),
  ).map((engine) => engine.id);
}

export const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
  { code: "pt", label: "Português" },
];

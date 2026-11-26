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

/** English and Chinese, picked by `bi` at the point of display. */
type Text = [string, string];

/**
 * One credential an engine takes.
 *
 * The settings used to show a bare "Key" or "App ID" with an empty box beside
 * it, and nothing said which console it came from, whether it was secret or
 * what a valid one looked like — so each field now carries that with it, in the
 * console's own words.
 */
export interface KeyField {
  /** what it is stored under in `refract.engineKeys` — never rename */
  name: string;
  label: Text;
  placeholder?: string | Text;
  /** masked, like a password */
  secret?: boolean;
  /** the engine runs without it */
  optional?: boolean;
  hint?: Text;
}

export interface Engine {
  id: string;
  label: string;
  /** the credentials, in the order the settings show them; free engines have none */
  fields?: KeyField[];
  /** where the credentials come from */
  help?: { text: Text; url?: string };
  /** how many strings one call can take */
  batch: number;
  translate: (texts: string[], ctx: EngineContext) => Promise<string[]>;
}

export function textOf(value: string | Text | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : bi(value[0], value[1]);
}

/** The fields an engine cannot run without. */
export function requiredKeys(engine: Engine): KeyField[] {
  return (engine.fields || []).filter((field) => !field.optional);
}

/** Required fields left empty, for the settings and the error message alike. */
export function missingKeys(id: string): KeyField[] {
  const keys = engineKeys(id);
  return requiredKeys(engineByID(id)).filter((field) => !keys[field.name]);
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

/**
 * DeepL's target language. Plain "ZH" is Simplified, so a Traditional Chinese
 * target came back in Simplified; the script has to be named. (As a *source*
 * DeepL takes only "ZH", which is why this is separate from `langFor`.)
 */
export function deeplTarget(code: string): string {
  const lower = code.toLowerCase();
  if (lower === "zh-tw") return "ZH-HANT";
  if (lower === "zh-cn") return "ZH-HANS";
  return langFor("deepl", code);
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
    help: {
      text: [
        "Free, no key. Requests go to translate.googleapis.com, which some networks cannot reach.",
        "免费，无需密钥。请求发往 translate.googleapis.com，部分网络环境下无法访问。",
      ],
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
    fields: [
      {
        name: "endpoint",
        label: ["Endpoint", "服务地址"],
        placeholder: "http://127.0.0.1:1188/translate",
      },
    ],
    help: {
      text: [
        "A DeepLX server you run yourself. Enter its full address, including the /translate path.",
        "需自行部署 DeepLX 服务。填写完整地址，包含 /translate 路径。",
      ],
      url: "https://github.com/OwO-Network/DeepLX",
    },
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
    fields: [
      {
        name: "authKey",
        label: ["Authentication key", "API 密钥"],
        secret: true,
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx",
        hint: [
          "A key ending in :fx is a free-plan key and goes to the free API automatically.",
          "以 :fx 结尾的是免费版密钥，会自动使用免费版接口。",
        ],
      },
    ],
    help: {
      text: [
        "Needs a DeepL API plan (Free or Pro) — a DeepL Pro app subscription has no API key. Copy it from Account → API Keys.",
        "需要 DeepL API 套餐（免费版或专业版均可），DeepL Pro 应用订阅不含 API 密钥。在账户的「API Keys」页面复制。",
      ],
      url: "https://www.deepl.com/your-account/keys",
    },
    batch: 25,
    async translate(texts, ctx) {
      const key = ctx.keys.authKey || "";
      const host = key.endsWith(":fx")
        ? "https://api-free.deepl.com"
        : "https://api.deepl.com";
      const params = new URLSearchParams();
      params.set("target_lang", deeplTarget(ctx.to));
      if (ctx.from !== "auto") params.set("source_lang", langFor("deepl", ctx.from));
      for (const text of texts) params.append("text", text);
      const { text: body } = await request("POST", `${host}/v2/translate`, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // DeepL stopped accepting `auth_key` in the body on 15 January 2026:
          // every request sent that way gets a 403, however good the key, while
          // other plugins using this header went on working with the same key.
          Authorization: `DeepL-Auth-Key ${key}`,
        },
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
    fields: [
      {
        name: "key",
        label: ["Key", "密钥"],
        secret: true,
        placeholder: ["KEY 1 or KEY 2", "密钥 1 或密钥 2"],
      },
      {
        name: "region",
        label: ["Region", "区域"],
        optional: true,
        placeholder: [
          "e.g. eastasia — leave empty for a Global resource",
          "如 eastasia；资源区域为「全局」时留空",
        ],
      },
    ],
    help: {
      text: [
        "Azure portal → your Translator resource → Keys and Endpoint: copy KEY 1 and Location/Region.",
        "Azure 门户 → 你创建的「Translator」资源 → 「密钥和终结点」：复制「密钥 1」和「位置/区域」。",
      ],
      url: "https://learn.microsoft.com/azure/ai-services/translator/create-translator-resource",
    },
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
    fields: [
      { name: "appid", label: ["APP ID", "APP ID"], placeholder: "20xxxxxxxxxxxxxxx" },
      { name: "key", label: ["Secret key", "密钥"], secret: true },
    ],
    help: {
      text: [
        "Baidu Translate open platform → Console → Developer info: APP ID and secret key. General text translation must be enabled.",
        "百度翻译开放平台 → 管理控制台 → 开发者信息：复制 APP ID 和密钥。需先开通「通用文本翻译」。",
      ],
      url: "https://fanyi-api.baidu.com/manage/developer",
    },
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
    fields: [
      { name: "appKey", label: ["App ID", "应用 ID"] },
      { name: "appSecret", label: ["App secret", "应用密钥"], secret: true },
    ],
    help: {
      text: [
        "Youdao AI open platform → create an application with the Text Translation service bound to it, then copy its app ID and app secret.",
        "有道智云 AI 开放平台 → 创建应用并绑定「文本翻译」服务，然后复制应用 ID 和应用密钥。",
      ],
      url: "https://ai.youdao.com/console/",
    },
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
        // A rejected key still answers 200, with only an error code to say so.
        if (data.errorCode && data.errorCode !== "0") {
          throw new Error(`Youdao error ${data.errorCode}`);
        }
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
    fields: [{ name: "apikey", label: ["API key", "API-KEY"], secret: true }],
    help: {
      text: [
        "NiuTrans open platform → Console → API-KEY.",
        "小牛翻译开放平台 → 控制台 → API-KEY。",
      ],
      url: "https://niutrans.com/cloud/account_info/info",
    },
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
        const data = JSON.parse(body);
        if (data.error_code) throw new Error(`NiuTrans ${data.error_code}: ${data.error_msg || ""}`);
        out.push(data.tgt_text || "");
      }
      return out;
    },
  },
  {
    id: "libretranslate",
    label: "LibreTranslate",
    fields: [
      {
        name: "endpoint",
        label: ["Endpoint", "服务地址"],
        placeholder: "http://127.0.0.1:5000/translate",
      },
      // Read below as `apiKey` all along, but there was no field to enter it,
      // so a server that wants one could never be used.
      {
        name: "apiKey",
        label: ["API key", "API 密钥"],
        secret: true,
        optional: true,
        placeholder: ["only if the server asks for one", "服务器要求时才需填写"],
      },
    ],
    help: {
      text: [
        "A LibreTranslate server, your own or a public one. Enter its full address, including the /translate path.",
        "自行部署或公共的 LibreTranslate 服务。填写完整地址，包含 /translate 路径。",
      ],
      url: "https://github.com/LibreTranslate/LibreTranslate",
    },
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
    help: {
      text: [
        "Uses the chat model set in the AI tab — no separate key here.",
        "使用「AI」标签页中配置的对话模型，此处无需单独填写密钥。",
      ],
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
      let found = 0;
      while ((match = pattern.exec(answer))) {
        const index = Number(match[1]) - 1;
        if (index >= 0 && index < out.length) {
          out[index] = match[2].trim();
          found++;
        }
      }
      if (!found) {
        throw new Error(
          bi(
            `The AI model did not return the translation in numbered blocks. Response begins: ${answer.slice(0, 120)}`,
            `AI 模型未按编号分段返回译文。返回内容开头：${answer.slice(0, 120)}`,
          ),
        );
      }
      // A block the model skipped stays empty, so it is counted as failed and
      // handed to the next engine instead of passing the original off as done.
      return out;
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
  return !missingKeys(id).length;
}

/**
 * One short request straight to an engine — no cache, no fallback — for the
 * Test button in the settings. Going through `translateBatch` would answer from
 * the cache, or quietly from another engine, and prove nothing.
 */
export async function testEngine(id: string): Promise<string> {
  const engine = engineByID(id);
  const missing = missingKeys(id);
  if (missing.length) throw new Error(missingMessage(engine, missing));
  const [out] = await engine.translate(["The results are shown in Table 2."], {
    from: "en",
    to: getPref<string>("refract.targetLang", "zh-CN"),
    keys: engineKeys(id),
  });
  if (!out?.trim()) {
    throw new Error(bi("The engine answered with nothing.", "引擎返回了空结果。"));
  }
  benched.delete(id);
  return out.trim();
}

function missingMessage(engine: Engine, missing: KeyField[]): string {
  const fields = missing.map((field) => textOf(field.label)).join(bi(", ", "、"));
  return bi(
    `${engine.label}: missing ${fields}. Add it under Settings → Prism → Translation.`,
    `${engine.label}缺少${fields}，请在「设置 → Prism → 翻译」中填写。`,
  );
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
    /** Some, but not all, of the texts could not be translated by any engine. */
    onIncomplete?: (missing: number, reason: string) => void;
    shouldStop?: () => boolean;
  } = {},
): Promise<string[]> {
  const engineID = options.engine || getPref<string>("refract.engine", "google");
  const engine = engineByID(engineID);
  const missing = missingKeys(engineID);
  if (missing.length) throw new Error(missingMessage(engine, missing));
  const to = options.to || getPref<string>("refract.targetLang", "zh-CN");
  const from = options.from || getPref<string>("refract.sourceLang", "auto");

  const results: string[] = new Array(texts.length).fill("");
  let pending: Entry[] = [];
  texts.forEach((text, index) => {
    if (text.trim()) pending.push({ index, text });
  });

  const total = texts.length;
  let done = total - pending.length;
  const report = (finished: number) => {
    done += finished;
    options.onProgress?.(done, total);
  };

  const fallback = getPref<boolean>("refract.engineFallback", true);
  let failure: unknown;
  /** The last error any engine hit, fatal or not, for the message below. */
  const seen: { error?: unknown } = {};
  try {
    pending = await runEngine(engineID, { from, to }, pending, results, report, {
      ...options,
      // An engine that just proved unreachable is not asked again for a while:
      // each attempt cost up to a 20-second timeout per paragraph before the
      // fallback took over. Its cached translations are still used.
      cacheOnly: fallback && isBenched(engineID),
    }, seen);
    if (pending.length && fallback && isBenched(engineID)) {
      failure = seen.error ?? new Error(
        bi(`${engine.label} is unreachable at the moment.`, `${engine.label}暂时无法连接。`),
      );
    }
  } catch (e) {
    failure = e;
  }

  /* Every remaining entry failed on the chosen engine. One dead engine used to
     take the whole document with it — a 429 from a public endpoint halfway
     through left the rest of the pages blank — so the leftovers are offered to
     the other engines that can run without asking the user for anything. */
  if ((pending.length || failure) && fallback) {
    for (const nextID of fallbackOrder(engineID)) {
      if (!pending.length) break;
      if (options.shouldStop?.()) break;
      options.onEngineSwitch?.(engineID, nextID, errorText(failure));
      Zotero.debug(`[Prism] translation falling back to ${nextID}`);
      try {
        pending = await runEngine(nextID, { from, to }, pending, results, report, options, seen);
        failure = undefined;
      } catch (e) {
        failure = e;
      }
    }
  }
  /* Engines that fail softly (timeouts, 5xx, empty replies) give back their
     entries instead of throwing, so `failure` could be unset while nothing at
     all was translated — and callers went on to file a note of empty
     paragraphs. Nothing translated is an error, whatever the cause. */
  const stopped = options.shouldStop?.() ?? false;
  if (!stopped && (failure || pending.length) && !results.some(Boolean)) {
    throw failure || seen.error || new Error(
      bi("No translation engine returned a result.", "所有翻译引擎均未返回译文。"),
    );
  }
  if (!stopped && pending.length) {
    options.onIncomplete?.(pending.length, errorText(failure || seen.error));
  }

  await cacheStore.flush();
  return results;
}

interface Entry {
  index: number;
  text: string;
}

/** Engines that could not be reached, and until when they are left alone. */
const benched = new Map<string, number>();
const BENCH_MS = 10 * 60 * 1000;

function bench(engineID: string) {
  benched.set(engineID, Date.now() + BENCH_MS);
}

function isBenched(engineID: string): boolean {
  const until = benched.get(engineID);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  benched.delete(engineID);
  return false;
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
    /** Answer from this engine's cache only; leave the rest outstanding. */
    cacheOnly?: boolean;
  },
  seen: { error?: unknown } = {},
): Promise<Entry[]> {
  if (!entries.length) return entries;

  // The cache is keyed by the engine that produced each translation, so it is
  // read here, once per engine tried. Read only for the chosen engine, it
  // missed everything a fallback engine had translated: with Google out of
  // reach, every paragraph came from the fallback, was cached under it, and
  // was translated over the network again on every run.
  const outstanding: Entry[] = [];
  for (const entry of entries) {
    const cached = readCache(engineID, lang.to, entry.text);
    if (cached !== undefined) results[entry.index] = cached;
    else outstanding.push(entry);
  }
  if (outstanding.length < entries.length) report(entries.length - outstanding.length);
  entries = outstanding;
  if (!entries.length || options.cacheOnly) return entries;

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
  let timeouts = 0;

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
        seen.error = e;
        failed.push(...group);
        // A bad key, an empty account or a wrong address fails every batch the
        // same way, so the rest go straight to the next engine. So does a
        // second timeout: one can be a slow reply, two means the host is out
        // of reach, and every further paragraph would wait out its own.
        const kind = (e as any)?.kind;
        if (kind === "timeout") timeouts++;
        if (
          ["auth", "quota", "address", "model", "unreachable", "certificate"].includes(kind) ||
          (kind === "timeout" && timeouts >= 2) ||
          /40[13]|unauthor|invalid/i.test(errorText(e))
        ) {
          fatal = e;
          if (["unreachable", "certificate", "timeout"].includes(kind)) bench(engineID);
        }
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
      (!requiredKeys(engine).length ||
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

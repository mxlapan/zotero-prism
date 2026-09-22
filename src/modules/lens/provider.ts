/**
 * Model access.
 *
 * Three transports cover essentially every setup users have:
 *  - `openai`    — any OpenAI-compatible /chat/completions endpoint
 *                  (OpenAI, DeepSeek, SiliconFlow, Moonshot, Zhipu, vLLM,
 *                   Ollama, LM Studio, or a relay).
 *  - `anthropic` — the /v1/messages API.
 *  - `bridge`    — no API key at all: the answer is produced by a web chat the
 *                  user already has open, relayed by the Prism browser add-on.
 */

import { getPref, getJSONPref, setJSONPref, setPref } from "../../utils/prefs";
import {
  AbortLike,
  errorText,
  parseSSE,
  request,
  streamPost,
} from "../../utils/http";
import { bridgeChat, bridgeAvailable } from "./bridge";
import { bi } from "../../utils/locale";

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
  /** data: URLs or http(s) URLs for vision-capable models */
  images?: string[];
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortLike;
  onToken?: (delta: string, whole: string) => void;
  /** force a transport regardless of the configured default */
  transport?: "auto" | "api" | "bridge";
}

export interface ProviderProfile {
  name: string;
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  fullURL?: boolean;
  temperature?: number;
}

export function currentProfile(): ProviderProfile {
  return {
    name: "current",
    provider: getPref<string>("lens.provider", "openai"),
    baseURL: getPref<string>("lens.baseURL", "https://api.openai.com"),
    apiKey: getPref<string>("lens.apiKey", ""),
    model: getPref<string>("lens.model", "gpt-4o-mini"),
    fullURL: getPref<boolean>("lens.fullURL", false),
    temperature: Number(getPref("lens.temperature", 0.5)),
  };
}

export function listProfiles(): ProviderProfile[] {
  return getJSONPref<ProviderProfile[]>("lens.profiles", []);
}

export function saveProfile(name: string) {
  const profiles = listProfiles().filter((p) => p.name !== name);
  profiles.push({ ...currentProfile(), name });
  setJSONPref("lens.profiles", profiles);
}

export function applyProfile(name: string) {
  const profile = listProfiles().find((p) => p.name === name);
  if (!profile) return false;
  setPref("lens.provider", profile.provider);
  setPref("lens.baseURL", profile.baseURL);
  setPref("lens.apiKey", profile.apiKey);
  setPref("lens.model", profile.model);
  setPref("lens.fullURL", !!profile.fullURL);
  if (profile.temperature !== undefined) {
    setPref("lens.temperature", profile.temperature);
  }
  return true;
}

export function deleteProfile(name: string) {
  setJSONPref(
    "lens.profiles",
    listProfiles().filter((p) => p.name !== name),
  );
}

function joinURL(base: string, path: string): string {
  const trimmed = (base || "").replace(/\/+$/, "");
  if (getPref<boolean>("lens.fullURL", false)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}${path.replace(/^\/v\d+/, "")}`;
  return `${trimmed}${path}`;
}

export function chatEndpoint(): string {
  const profile = currentProfile();
  if (profile.provider === "anthropic") {
    return joinURL(profile.baseURL || "https://api.anthropic.com", "/v1/messages");
  }
  return joinURL(profile.baseURL, "/v1/chat/completions");
}

function headers(): Record<string, string> {
  const profile = currentProfile();
  if (profile.provider === "anthropic") {
    return {
      "Content-Type": "application/json",
      "x-api-key": profile.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${profile.apiKey}`,
  };
}

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (!message.images?.length) {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [
        { type: "text", text: message.content },
        ...message.images.map((url) => ({
          type: "image_url",
          image_url: { url },
        })),
      ],
    };
  });
}

function toAnthropicMessages(messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((message) => {
      if (!message.images?.length) {
        return { role: message.role, content: message.content };
      }
      return {
        role: message.role,
        content: [
          ...message.images.map((url) => {
            const match = /^data:(.+?);base64,(.*)$/.exec(url);
            return match
              ? {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: match[1],
                    data: match[2],
                  },
                }
              : { type: "image", source: { type: "url", url } };
          }),
          { type: "text", text: message.content },
        ],
      };
    });
  return { system, messages: rest };
}

export function isConfigured(): boolean {
  const profile = currentProfile();
  if (getPref<boolean>("lens.bridgeEnabled", false) && bridgeAvailable()) return true;
  return !!profile.apiKey || /localhost|127\.0\.0\.1/.test(profile.baseURL);
}

/**
 * Run a chat completion. Streams through `onToken` when the transport and the
 * user's preferences allow it, and always resolves with the full answer.
 */
/**
 * Every AI feature funnels through `chat`, so this is the one place that knows
 * a key is missing. It used to throw the bare string "PRISM_NO_KEY", which only
 * the chat panel recognised — everywhere else (AI outline, AI annotate, claim
 * matrix, annotation explain, AI translation) that opaque token was what the
 * user saw. The message is readable now; the `code` is what callers match on.
 */
export function noKeyError(): Error {
  const error = new Error(
    bi(
      "No AI model configured yet. Open Settings → Prism → AI and set a base URL, API key and model.",
      "尚未配置 AI 模型。请在「设置 → Prism → AI」中填写接口地址、API 密钥和模型名称。",
    ),
  );
  (error as any).code = "PRISM_NO_KEY";
  return error;
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const useBridge =
    options.transport === "bridge" ||
    (options.transport !== "api" &&
      getPref<boolean>("lens.bridgeEnabled", false) &&
      bridgeAvailable());
  if (useBridge) {
    return bridgeChat(messages, options);
  }

  const profile = currentProfile();
  if (!profile.apiKey && !/localhost|127\.0\.0\.1/.test(profile.baseURL)) {
    throw noKeyError();
  }

  const model = options.model || profile.model;
  const temperature = options.temperature ?? profile.temperature ?? 0.5;
  const maxTokens = options.maxTokens ?? Number(getPref("lens.maxTokens", 4096));
  const stream = getPref<boolean>("lens.stream", true) && !!options.onToken;
  const url = chatEndpoint();

  const body =
    profile.provider === "anthropic"
      ? (() => {
          const { system, messages: rest } = toAnthropicMessages(messages);
          return JSON.stringify({
            model,
            system: system || undefined,
            messages: rest,
            max_tokens: maxTokens,
            temperature,
            stream,
          });
        })()
      : JSON.stringify({
          model,
          messages: toOpenAIMessages(messages),
          temperature,
          max_tokens: maxTokens,
          stream,
        });

  if (!stream) {
    const { text } = await request("POST", url, {
      headers: headers(),
      body,
      signal: options.signal,
      timeout: 900_000,
    });
    let answer = extractWhole(text, profile.provider);
    if (answer && stopReason(text, profile.provider)) answer += truncationNote();
    options.onToken?.(answer, answer);
    return answer;
  }

  let answer = "";
  let carry = "";
  let truncated = false;
  await streamPost(url, {
    headers: headers(),
    body,
    signal: options.signal,
    timeout: 900_000,
    onChunk: (delta) => {
      carry += delta;
      // keep the trailing partial event in `carry` until it completes
      const boundary = carry.lastIndexOf("\n");
      if (boundary < 0) return;
      const ready = carry.slice(0, boundary);
      carry = carry.slice(boundary + 1);
      for (const payload of parseSSE(ready)) {
        if (payload === "[DONE]") continue;
        if (stopReason(payload, profile.provider)) truncated = true;
        const piece = extractDelta(payload, profile.provider);
        if (piece) {
          answer += piece;
          options.onToken?.(piece, answer);
        }
      }
    },
  });
  if (carry.trim()) {
    for (const payload of parseSSE(carry)) {
      if (payload === "[DONE]") continue;
      if (stopReason(payload, profile.provider)) truncated = true;
      const piece = extractDelta(payload, profile.provider);
      if (piece) {
        answer += piece;
        options.onToken?.(piece, answer);
      }
    }
  }
  if (!answer.trim()) {
    throw new Error(
      truncated
        ? "The model used up max_tokens before writing an answer (a reasoning model thinks first). Raise Max tokens in Settings → Prism → AI."
        : "The model returned an empty response. Check the model name and that the endpoint supports streaming.",
    );
  }
  if (truncated) {
    answer += truncationNote();
    options.onToken?.("", answer);
  }
  return answer;
}

/** "length" when the model stopped because it ran into max_tokens. */
export function stopReason(payload: string, provider: string): string {
  try {
    const data = JSON.parse(payload);
    if (provider === "anthropic") {
      const reason = data.delta?.stop_reason ?? data.stop_reason;
      return reason === "max_tokens" ? "length" : "";
    }
    return data.choices?.[0]?.finish_reason === "length" ? "length" : "";
  } catch {
    return "";
  }
}

/**
 * Said at the end of an answer that was cut off. Without it the reply simply
 * stopped mid-formula, and nothing told the user why — reasoning models spend
 * much of the budget thinking before they write a word.
 */
function truncationNote(): string {
  return `\n\n> ${bi(
    "The answer was cut off at the max-tokens limit (Settings → Prism → AI → Max tokens). Reasoning models spend part of that limit thinking.",
    "回答已达到 max_tokens 上限，内容不完整。可在「设置 → Prism → AI」中调高「最大 tokens」；推理模型的思考过程也计入该上限。",
  )}`;
}

export function extractDelta(payload: string, provider: string): string {
  try {
    const data = JSON.parse(payload);
    if (provider === "anthropic") {
      if (data.type === "content_block_delta") return data.delta?.text || "";
      if (data.type === "message_delta") return "";
      return "";
    }
    const choice = data.choices?.[0];
    // Reasoning models (DeepSeek, Qwen, relays of o-series…) stream their
    // thinking as `reasoning_content` with `content: null`. That is not the
    // answer — falling back to it pasted the whole chain of thought in front.
    if (choice?.delta && choice.delta.content == null) return "";
    return (
      choice?.delta?.content ??
      choice?.message?.content ??
      choice?.text ??
      ""
    );
  } catch {
    return "";
  }
}

function extractWhole(text: string, provider: string): string {
  try {
    const data = JSON.parse(text);
    if (provider === "anthropic") {
      return (data.content || [])
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("");
    }
    return (
      data.choices?.[0]?.message?.content ??
      data.choices?.[0]?.text ??
      ""
    );
  } catch {
    return text;
  }
}

/** Ask the endpoint which models it serves. */
export async function listModels(): Promise<string[]> {
  const profile = currentProfile();
  try {
    if (profile.provider === "anthropic") {
      const { text } = await request(
        "GET",
        joinURL(profile.baseURL || "https://api.anthropic.com", "/v1/models"),
        { headers: headers(), timeout: 20000 },
      );
      return (JSON.parse(text).data || []).map((m: any) => m.id);
    }
    const { text } = await request("GET", joinURL(profile.baseURL, "/v1/models"), {
      headers: headers(),
      timeout: 20000,
    });
    return (JSON.parse(text).data || [])
      .map((m: any) => m.id)
      .sort((a: string, b: string) => a.localeCompare(b));
  } catch (e) {
    Zotero.debug(`[Prism] listModels failed: ${errorText(e)}`);
    return [];
  }
}

export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
  ms: number;
}> {
  const started = Date.now();
  try {
    const reply = await chat(
      [{ role: "user", content: "Reply with the single word: ready" }],
      { maxTokens: 16, temperature: 0, transport: "api" },
    );
    return {
      ok: true,
      message: reply.trim().slice(0, 120) || "(empty reply)",
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, message: errorText(e), ms: Date.now() - started };
  }
}

/** Embeddings. Returns [] when no embedding endpoint is configured. */
export async function embed(
  texts: string[],
  signal?: AbortLike,
): Promise<number[][]> {
  const url = getPref<string>("lens.embedBaseURL", "");
  const key = getPref<string>("lens.embedApiKey", "") || currentProfile().apiKey;
  const model = getPref<string>("lens.embedModel", "text-embedding-3-small");
  if (!url || !texts.length) return [];
  const endpoint = /embeddings?$/.test(url)
    ? url
    : `${url.replace(/\/+$/, "")}/v1/embeddings`;

  const out: number[][] = [];
  const batchSize = 16;
  for (let i = 0; i < texts.length; i += batchSize) {
    if (signal?.aborted) break;
    const batch = texts.slice(i, i + batchSize);
    const { text } = await request("POST", endpoint, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: batch }),
      signal,
      timeout: 120000,
    });
    const data = JSON.parse(text);
    const vectors = (data.data || [])
      .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
      .map((d: any) => d.embedding as number[]);
    if (vectors.length !== batch.length) {
      throw new Error(
        bi("Embedding endpoint returned an unexpected number of vectors", "Embedding 接口返回的向量数量与请求不符"),
      );
    }
    out.push(...vectors);
  }
  return out;
}

export function embeddingsConfigured(): boolean {
  return !!getPref<string>("lens.embedBaseURL", "");
}

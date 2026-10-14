/**
 * Networking helpers.
 *
 * Everything goes through `Zotero.HTTP`, which runs with chrome privileges
 * (no CORS wall), honours the user's proxy settings and is the only transport
 * guaranteed to exist in every Zotero build we support.
 */

import { bi } from "./locale";

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  responseType?: "text" | "json" | "arraybuffer";
  signal?: AbortLike;
}

/** A minimal abort handle — `AbortController` is not available everywhere. */
export class AbortLike {
  private _aborted = false;
  private _handlers: Array<() => void> = [];
  get aborted() {
    return this._aborted;
  }
  abort() {
    if (this._aborted) return;
    this._aborted = true;
    for (const h of this._handlers.splice(0)) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
  }
  onAbort(handler: () => void) {
    if (this._aborted) handler();
    else this._handlers.push(handler);
  }
}

export type FailureKind =
  | "unreachable"
  | "timeout"
  | "certificate"
  | "auth"
  | "quota"
  | "rate"
  | "model"
  | "context"
  | "address"
  | "rejected"
  | "server"
  | "other";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

/** The message a JSON error body carries, or the body itself. */
export function bodyDetail(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const detail =
      parsed?.error?.message ||
      (typeof parsed?.error === "string" ? parsed.error : "") ||
      parsed?.message ||
      parsed?.msg ||
      parsed?.detail ||
      parsed?.error_msg;
    if (detail) return String(typeof detail === "string" ? detail : JSON.stringify(detail));
  } catch {
    /* not JSON */
  }
  // An HTML error page says nothing useful in its markup.
  if (/^\s*</.test(body)) return "";
  return body.trim();
}

/**
 * Sort an HTTP failure into something a user can act on.
 *
 * Status codes alone are not enough: providers answer a wrong model name with
 * 400, 404 or 422 depending on who wrote them, and quota with 402, 403 or 429.
 * The body is checked first for the cases that have a fix of their own.
 */
export function classifyHTTP(status: number, body: string): FailureKind {
  const text = `${bodyDetail(body)} ${body.slice(0, 600)}`;
  if (/insufficient.?(quota|balance|credit|fund)|余额|欠费|quota.?exceeded|billing|credit balance|payment required|arrear/i.test(text) || status === 402) {
    return "quota";
  }
  if (/context.?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|exceeds?.{0,20}(limit|length)|上下文|过长/i.test(text)) {
    return "context";
  }
  if (/model/i.test(text) && /not.?(exist|found|support|available)|does not exist|invalid|unknown|no such|不存在|无效|不支持|未开通/i.test(text)) {
    return "model";
  }
  if (status === 401 || /invalid.{0,12}(api.?key|token|auth)|incorrect api key|unauthori[sz]ed|authentication|鉴权|密钥|api key/i.test(text)) {
    return "auth";
  }
  if (status === 403) return "auth";
  if (status === 429) return "rate";
  if (status === 404 || status === 405) return "address";
  if (status >= 500) return "server";
  if (status >= 400) return "rejected";
  return "other";
}

/** One line per kind, saying what went wrong and where to look. */
export function failureText(kind: FailureKind, host: string): string {
  const where = host ? `${host}${bi(": ", "：")}` : "";
  const lines: Record<FailureKind, [string, string]> = {
    unreachable: [
      "Unable to connect to the server. Check the address, network and proxy settings; for a local model, make sure the service is running.",
      "无法连接服务器。请检查地址、网络与代理设置；使用本地模型时，请确认服务已启动。",
    ],
    timeout: [
      "The server did not respond in time. The network may be slow or the service busy. Please try again later.",
      "服务器响应超时，可能是网络较慢或服务繁忙。请稍后重试。",
    ],
    certificate: [
      "Unable to establish a secure connection. Check whether the address should use http or https.",
      "无法建立安全连接。请检查地址应使用 http 还是 https。",
    ],
    auth: [
      "API key verification failed. The key may be incorrect, expired, or lack access to this service.",
      "密钥验证失败。密钥可能有误、已过期，或无权使用该服务。",
    ],
    quota: [
      "Insufficient account balance or quota. Top up the account or use another key.",
      "账户余额或额度不足。请充值或更换密钥。",
    ],
    rate: [
      "Request rate limited by the service. Please try again later, or lower the concurrency in Settings.",
      "请求过于频繁，已被服务限流。请稍后重试，或在设置中调低并发数。",
    ],
    model: [
      "The model does not exist or is not available to this key. Check the model name in Settings.",
      "模型不存在，或当前密钥无权使用该模型。请在设置中检查模型名称。",
    ],
    context: [
      "The input exceeds the model's context length. Use a model with a longer context or reduce the input.",
      "输入超出模型的上下文长度。请换用上下文更长的模型，或减少输入内容。",
    ],
    address: [
      "No API found at this address. The path may be incorrect, for example a missing or extra /v1.",
      "该地址下未找到接口，路径可能有误，例如多写或漏写了 /v1。",
    ],
    rejected: ["The request was rejected by the service.", "请求被服务拒绝。"],
    server: ["The service encountered an internal error. Please try again later.", "服务端内部错误。请稍后重试。"],
    other: ["The request failed.", "请求失败。"],
  };
  const [en, zh] = lines[kind];
  return `${where}${bi(en, zh)}`;
}

export class HTTPError extends Error {
  status: number;
  body: string;
  kind: FailureKind;
  constructor(status: number, body: string, message?: string, url = "") {
    const kind = classifyHTTP(status, body);
    const detail = bodyDetail(body).replace(/\s+/g, " ").slice(0, 200);
    // The status stays in the message: the translation engines decide whether
    // to give up on an engine by matching it.
    super(
      message ||
        `${failureText(kind, hostOf(url))}${bi(
          ` (HTTP ${status}${detail ? `: ${detail}` : ""})`,
          `（HTTP ${status}${detail ? `，服务返回：${detail}` : ""}）`,
        )}`,
    );
    this.name = "HTTPError";
    this.status = status;
    this.body = body;
    this.kind = kind;
  }
}

/** A request that never got an HTTP answer at all. */
export class NetworkError extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, url: string, cause: unknown) {
    const raw = (cause as any)?.message ?? (typeof cause === "string" ? cause : "");
    const detail = String(raw).slice(0, 160);
    super(`${failureText(kind, hostOf(url))}${detail ? bi(` (${detail})`, `（${detail}）`) : ""}`);
    this.name = "NetworkError";
    this.kind = kind;
  }
}

/**
 * Turn whatever `Zotero.HTTP.request` threw into an HTTPError or NetworkError.
 *
 * Zotero reports a refused connection, a DNS failure and a dropped network all
 * as status 0, which used to surface as "HTTP 0 — " with nothing after it.
 */
export function explainRequestFailure(e: any, url: string): Error {
  if (e instanceof HTTPError || e instanceof NetworkError) return e;
  const name = `${e?.name || ""} ${e?.constructor?.name || ""} ${e?.message || ""}`;
  if (/timed?\s*out|timeout/i.test(name)) return new NetworkError("timeout", url, e);
  if (/security|certificate|ssl|tls|SEC_ERROR|SSL_ERROR/i.test(name)) {
    return new NetworkError("certificate", url, e);
  }
  const xhr = e?.xmlhttp;
  const status = Number(xhr?.status ?? e?.status ?? 0);
  if (status > 0) {
    let body = "";
    try {
      body = String(xhr?.responseText ?? xhr?.response ?? "");
    } catch {
      /* binary response */
    }
    return new HTTPError(status, body, undefined, url);
  }
  if (xhr || /offline|NS_ERROR|connect|network|refused|resolve|status 0/i.test(name)) {
    return new NetworkError("unreachable", url, e);
  }
  return e instanceof Error ? e : new Error(String(e));
}

export async function request(
  method: string,
  url: string,
  options: RequestOptions = {},
): Promise<{ status: number; text: string; response: any }> {
  let xhrRef: XMLHttpRequest | undefined;
  try {
    const xhr = await Zotero.HTTP.request(method, url, {
      headers: options.headers,
      body: options.body,
      responseType: options.responseType === "json" ? "text" : options.responseType,
      timeout: options.timeout ?? 60000,
      requestObserver: (x: XMLHttpRequest) => {
        xhrRef = x;
        options.signal?.onAbort(() => {
          try {
            x.abort();
          } catch {
            /* ignore */
          }
        });
      },
    } as any);
    const text = typeof xhr.response === "string" ? xhr.response : xhr.responseText;
    return { status: xhr.status, text: text ?? "", response: xhr.response };
  } catch (e: any) {
    if (options.signal?.aborted) throw new Error("aborted");
    void xhrRef;
    throw explainRequestFailure(e, url);
  }
}

export async function getJSON<T = any>(url: string, options: RequestOptions = {}) {
  const { text } = await request("GET", url, options);
  return JSON.parse(text) as T;
}

export async function postJSON<T = any>(
  url: string,
  payload: unknown,
  options: RequestOptions = {},
) {
  const { text } = await request("POST", url, {
    ...options,
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  return JSON.parse(text) as T;
}

/**
 * POST a request and surface the response as it arrives.
 *
 * `onChunk` receives only the text appended since the previous call, which is
 * what every server-sent-events based chat API needs.
 */
export async function streamPost(
  url: string,
  options: RequestOptions & { onChunk: (delta: string, whole: string) => void },
): Promise<string> {
  let consumed = 0;
  let whole = "";
  try {
    const xhr = await Zotero.HTTP.request("POST", url, {
      headers: options.headers,
      body: options.body,
      responseType: "text",
      timeout: options.timeout ?? 0,
      requestObserver: (x: XMLHttpRequest) => {
        options.signal?.onAbort(() => {
          try {
            x.abort();
          } catch {
            /* ignore */
          }
        });
        x.onprogress = (event: any) => {
          const current: string = event?.target?.response ?? "";
          if (current.length <= consumed) return;
          const delta = current.slice(consumed);
          consumed = current.length;
          whole = current;
          try {
            options.onChunk(delta, whole);
          } catch (err) {
            Zotero.debug(`[Prism] stream consumer failed: ${err}`);
          }
        };
      },
    } as any);
    const final: string = (xhr.response as string) ?? "";
    if (final.length > consumed) {
      options.onChunk(final.slice(consumed), final);
    }
    return final || whole;
  } catch (e: any) {
    if (options.signal?.aborted) return whole;
    throw explainRequestFailure(e, url);
  }
}

/** Split a raw SSE payload into its `data:` lines. */
export function parseSSE(chunk: string): string[] {
  const out: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload) out.push(payload);
  }
  return out;
}

/** Human readable one-liner for any thrown value. */
export function errorText(e: any): string {
  if (!e) return "unknown error";
  return String(e.message || e).slice(0, 500);
}

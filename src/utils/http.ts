/**
 * Networking helpers.
 *
 * Everything goes through `Zotero.HTTP`, which runs with chrome privileges
 * (no CORS wall), honours the user's proxy settings and is the only transport
 * guaranteed to exist in every Zotero build we support.
 */

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

export class HTTPError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message || `HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "HTTPError";
    this.status = status;
    this.body = body;
  }
}

function describe(e: any): never {
  const xhr = e?.xmlhttp;
  if (xhr) throw new HTTPError(xhr.status, String(xhr.responseText ?? ""));
  throw e;
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
    return describe(e);
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
    return describe(e);
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
  if (e instanceof HTTPError) {
    let detail = e.body;
    try {
      const parsed = JSON.parse(e.body);
      detail = parsed?.error?.message || parsed?.message || detail;
    } catch {
      /* not JSON */
    }
    return `HTTP ${e.status} — ${String(detail).slice(0, 500)}`;
  }
  return String(e.message || e).slice(0, 500);
}

/**
 * Web-chat linkage.
 *
 * Instead of an API key, answers can come from a chat site the user already
 * has open (ChatGPT, Claude, Gemini, Doubao, Kimi, DeepSeek, Qwen …). The
 * companion browser add-on in `browser-extension/` long-polls Zotero's own
 * HTTP server, types the prompt into the page and streams the reply back.
 *
 * Endpoints (all under Zotero's local server, default http://127.0.0.1:23119):
 *   POST /prism/bridge/hello  {target}          → handshake + keep-alive
 *   GET  /prism/bridge/next                     → long-poll for the next job
 *   POST /prism/bridge/chunk  {id, delta}       → streamed answer fragment
 *   POST /prism/bridge/done   {id, text?}       → job finished
 *   POST /prism/bridge/error  {id, message}     → job failed
 */

import { getPref, setPref } from "../../utils/prefs";
import type { ChatMessage, ChatOptions } from "./provider";

interface Job {
  id: string;
  prompt: string;
  createdAt: number;
  onToken?: (delta: string, whole: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  text: string;
  settled: boolean;
}

const queue: Job[] = [];
const active = new Map<string, Job>();
let waiter: ((response: any) => void) | null = null;
let waiterTimer: number | undefined;
let registered = false;

const HANDSHAKE_TTL = 45_000;

function state() {
  return addon.data.lens.bridge;
}

export function bridgeAvailable(): boolean {
  return (
    state().connected && Date.now() - state().lastSeen < HANDSHAKE_TTL
  );
}

export function bridgeTarget(): string {
  return state().target;
}

export function bridgeStatus(): { connected: boolean; target: string; age: number } {
  return {
    connected: bridgeAvailable(),
    target: state().target,
    age: Date.now() - state().lastSeen,
  };
}

function json(status: number, payload: unknown) {
  return [status, "application/json", JSON.stringify(payload)];
}

function deliverNext() {
  if (!waiter || !queue.length) return;
  const job = queue.shift()!;
  active.set(job.id, job);
  const respond = waiter;
  waiter = null;
  if (waiterTimer) {
    Zotero.getMainWindow()?.clearTimeout(waiterTimer);
    waiterTimer = undefined;
  }
  respond(json(200, { id: job.id, prompt: job.prompt }));
}

function endpoint(
  methods: string[],
  handler: (data: any, respond: (response: any) => void) => void,
) {
  const Endpoint = function () {} as any;
  Endpoint.prototype = {
    supportedMethods: methods,
    supportedDataTypes: ["application/json", "text/plain"],
    permitBookmarklet: false,
    init(options: any, sendResponse: (response: any) => void) {
      let data = options?.data ?? options;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          data = {};
        }
      }
      try {
        handler(data || {}, sendResponse);
      } catch (e) {
        sendResponse(json(500, { error: String(e) }));
      }
    },
  };
  return Endpoint;
}

export function registerBridge() {
  if (registered) return;
  const server = (Zotero as any).Server;
  if (!server?.Endpoints) {
    Zotero.debug("[Prism] Zotero HTTP server unavailable — bridge disabled");
    return;
  }
  if (!Zotero.Prefs.get("httpServer.enabled")) {
    Zotero.Prefs.set("httpServer.enabled", true);
  }

  server.Endpoints["/prism/bridge/hello"] = endpoint(["POST", "GET"], (data, respond) => {
    const bridge = state();
    bridge.connected = true;
    bridge.lastSeen = Date.now();
    bridge.target = data.target || bridge.target || "web";
    setPref("lens.bridgeTarget", bridge.target);
    respond(json(200, { ok: true, version: addon.data.config.addonName }));
  });

  server.Endpoints["/prism/bridge/next"] = endpoint(["GET", "POST"], (_data, respond) => {
    const bridge = state();
    bridge.connected = true;
    bridge.lastSeen = Date.now();
    if (queue.length) {
      const job = queue.shift()!;
      active.set(job.id, job);
      respond(json(200, { id: job.id, prompt: job.prompt }));
      return;
    }
    // Release any earlier long-poll first, otherwise its fetch hangs until
    // the browser's own timeout.
    if (waiter) {
      const stale = waiter;
      waiter = null;
      if (waiterTimer) {
        Zotero.getMainWindow()?.clearTimeout(waiterTimer);
        waiterTimer = undefined;
      }
      stale(json(200, {}));
    }
    // hold the connection open briefly so the extension does not hot-loop
    waiter = respond;
    const win = Zotero.getMainWindow();
    waiterTimer = win?.setTimeout(() => {
      if (waiter === respond) {
        waiter = null;
        respond(json(200, {}));
      }
    }, 20_000);
  });

  server.Endpoints["/prism/bridge/chunk"] = endpoint(["POST"], (data, respond) => {
    state().lastSeen = Date.now();
    const job = active.get(data.id);
    if (job && !job.settled) {
      const delta = String(data.delta ?? "");
      // Some sites re-send the whole answer each tick; detect and diff it.
      if (data.whole !== undefined) {
        const whole = String(data.whole);
        const added = whole.startsWith(job.text)
          ? whole.slice(job.text.length)
          : whole;
        job.text = whole;
        if (added) job.onToken?.(added, job.text);
      } else if (delta) {
        job.text += delta;
        job.onToken?.(delta, job.text);
      }
    }
    respond(json(200, { ok: true }));
  });

  server.Endpoints["/prism/bridge/done"] = endpoint(["POST"], (data, respond) => {
    state().lastSeen = Date.now();
    const job = active.get(data.id);
    if (job && !job.settled) {
      job.settled = true;
      if (typeof data.text === "string" && data.text.length > job.text.length) {
        const added = data.text.startsWith(job.text)
          ? data.text.slice(job.text.length)
          : "";
        job.text = data.text;
        if (added) job.onToken?.(added, job.text);
      }
      active.delete(job.id);
      job.resolve(job.text);
    }
    respond(json(200, { ok: true }));
  });

  server.Endpoints["/prism/bridge/error"] = endpoint(["POST"], (data, respond) => {
    const job = active.get(data.id);
    if (job && !job.settled) {
      job.settled = true;
      active.delete(job.id);
      job.reject(new Error(String(data.message || "web bridge failed")));
    }
    respond(json(200, { ok: true }));
  });

  registered = true;
  Zotero.debug("[Prism] web bridge endpoints registered");
}

export function unregisterBridge() {
  const server = (Zotero as any).Server;
  if (!server?.Endpoints) return;
  for (const path of [
    "/prism/bridge/hello",
    "/prism/bridge/next",
    "/prism/bridge/chunk",
    "/prism/bridge/done",
    "/prism/bridge/error",
  ]) {
    delete server.Endpoints[path];
  }
  registered = false;
  for (const job of [...queue, ...active.values()]) {
    if (!job.settled) {
      job.settled = true;
      job.reject(new Error("Prism is shutting down"));
    }
  }
  queue.length = 0;
  active.clear();
}

/** Flatten a chat history into the single prompt a web chat can accept. */
function flatten(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") parts.push(`[Instructions]\n${message.content}`);
    else if (message.role === "assistant") parts.push(`[Previous answer]\n${message.content}`);
    else parts.push(message.content);
  }
  return parts.join("\n\n");
}

export async function bridgeChat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  if (!bridgeAvailable()) {
    throw new Error(
      "No web chat is connected. Open the site, click the Prism add-on icon and press Connect.",
    );
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<string>((resolve, reject) => {
    const job: Job = {
      id,
      prompt: flatten(messages),
      createdAt: Date.now(),
      onToken: options.onToken,
      resolve,
      reject,
      text: "",
      settled: false,
    };
    options.signal?.onAbort(() => {
      if (job.settled) return;
      job.settled = true;
      active.delete(id);
      const queued = queue.indexOf(job);
      if (queued >= 0) queue.splice(queued, 1);
      resolve(job.text);
    });
    queue.push(job);
    deliverNext();

    const timeoutMS = Number(getPref("lens.bridgeTimeout", 180_000)) || 180_000;
    Zotero.getMainWindow()?.setTimeout(() => {
      if (job.settled) return;
      job.settled = true;
      active.delete(id);
      if (job.text) resolve(job.text);
      else reject(new Error("The connected web chat did not answer in time."));
    }, timeoutMS);
  });
}

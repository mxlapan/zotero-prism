/**
 * Zotero Prism Bridge — background worker.
 *
 * Long-polls Zotero's local HTTP server for questions, hands each one to the
 * connected chat tab, and streams the answer back.
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:23119";

/**
 * Zotero's own HTTP server turns away any request that looks like it came from
 * a browser — a `Mozilla/…` user agent or an `Origin` header — unless it also
 * carries the connector API header. A web page cannot set that header without
 * a preflight, which Zotero does not answer; an extension holding the
 * localhost host permission can set it freely.
 */
const ZOTERO_HEADERS = { "X-Zotero-Connector-API-Version": "3" };

let state = {
  connected: false,
  tabId: null,
  target: "",
  endpoint: DEFAULT_ENDPOINT,
  busy: false,
};

chrome.storage.local.get(["endpoint"]).then((stored) => {
  if (stored.endpoint) state.endpoint = stored.endpoint;
});

async function post(path, body) {
  const response = await fetch(`${state.endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ZOTERO_HEADERS },
    body: JSON.stringify(body || {}),
  });
  return response.json().catch(() => ({}));
}

async function get(path) {
  const response = await fetch(`${state.endpoint}${path}`, {
    method: "GET",
    headers: { ...ZOTERO_HEADERS },
  });
  return response.json().catch(() => ({}));
}

/** The site a job belongs to.
 *
 * Chrome withholds the address of pages an add-on is not allowed to read —
 * chrome:// pages, the new-tab page, another extension's pages — and `tab.url`
 * is then undefined, which `new URL` refuses outright. Pressing Connect there
 * used to throw before any of connect()'s own error handling could catch it. */
function targetOf(tab) {
  try {
    return new URL(tab?.url || "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function connect(tab) {
  const target = targetOf(tab);
  if (!target) {
    return {
      ok: false,
      error: "This tab has no address the add-on can use. Open the chat site and connect from there.",
    };
  }
  state.tabId = tab.id;
  state.target = target;
  try {
    const reply = await post("/prism/bridge/hello", { target: state.target });
    if (!reply?.ok) {
      throw new Error(reply?.error || "Zotero did not answer the handshake");
    }
    state.connected = true;
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#2ea8e5" });
    loop();
    return { ok: true, target: state.target };
  } catch (e) {
    state.connected = false;
    state.tabId = null;
    chrome.action.setBadgeText({ text: "" });
    return { ok: false, error: String(e) };
  }
}

function disconnect() {
  state.connected = false;
  state.tabId = null;
  chrome.action.setBadgeText({ text: "" });
}

async function loop() {
  while (state.connected) {
    try {
      const job = await get("/prism/bridge/next");
      if (!job || !job.id) continue;
      await run(job);
    } catch (e) {
      // Zotero closed or the server moved — back off and retry
      await new Promise((resolve) => setTimeout(resolve, 4000));
      try {
        await post("/prism/bridge/hello", { target: state.target });
      } catch {
        disconnect();
        return;
      }
    }
  }
}

async function run(job) {
  if (!state.tabId) {
    await post("/prism/bridge/error", { id: job.id, message: "No chat tab connected" });
    return;
  }
  state.busy = true;
  const listener = (message) => {
    if (message?.type === "prism-chunk" && message.jobId === job.id) {
      void post("/prism/bridge/chunk", { id: job.id, whole: message.whole });
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  try {
    const result = await chrome.tabs.sendMessage(state.tabId, {
      type: "prism-ask",
      jobId: job.id,
      prompt: job.prompt,
    });
    if (result?.ok) {
      await post("/prism/bridge/done", { id: job.id, text: result.text || "" });
    } else {
      await post("/prism/bridge/error", {
        id: job.id,
        message: result?.error || "the page did not answer",
      });
    }
  } catch (e) {
    await post("/prism/bridge/error", { id: job.id, message: String(e) });
  } finally {
    chrome.runtime.onMessage.removeListener(listener);
    state.busy = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "prism-connect") {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => connect(tab))
      .then(sendResponse)
      // A listener that never calls sendResponse leaves the popup waiting and
      // the failure lands in the browser's error list instead of on screen.
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === "prism-disconnect") {
    disconnect();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "prism-status") {
    sendResponse({
      connected: state.connected,
      target: state.target,
      endpoint: state.endpoint,
      busy: state.busy,
    });
    return false;
  }
  if (message?.type === "prism-endpoint") {
    state.endpoint = message.endpoint || DEFAULT_ENDPOINT;
    void chrome.storage.local.set({ endpoint: state.endpoint });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) disconnect();
});

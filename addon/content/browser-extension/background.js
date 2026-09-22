/**
 * Zotero Prism Bridge — background worker.
 *
 * Long-polls Zotero's local HTTP server for questions, hands each one to the
 * connected chat tab, and streams the answer back.
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:23119";

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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return response.json().catch(() => ({}));
}

async function get(path) {
  const response = await fetch(`${state.endpoint}${path}`, { method: "GET" });
  return response.json().catch(() => ({}));
}

async function connect(tab) {
  state.tabId = tab.id;
  state.target = new URL(tab.url).hostname.replace(/^www\./, "");
  try {
    await post("/prism/bridge/hello", { target: state.target });
    state.connected = true;
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#2ea8e5" });
    loop();
    return { ok: true, target: state.target };
  } catch (e) {
    state.connected = false;
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
      .then(sendResponse);
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

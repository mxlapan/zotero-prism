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
  /** The user pressed Connect and has not pressed Disconnect since. */
  wanted: false,
  /** Zotero answered the last request. */
  connected: false,
  tabId: null,
  target: "",
  endpoint: DEFAULT_ENDPOINT,
  busy: false,
};

/**
 * Chrome stops an idle background worker after about thirty seconds and starts
 * a fresh one on the next event, with every variable back at its default. The
 * connection used to live only in `state`, so it lasted as long as the popup
 * stayed open to keep the worker busy and was forgotten soon after. What the
 * user asked for is kept in session storage and picked up again on each start.
 */
const ready = Promise.all([
  chrome.storage.local.get(["endpoint"]),
  chrome.storage.session.get(["wanted", "tabId", "target"]),
]).then(([stored, session]) => {
  if (stored.endpoint) state.endpoint = stored.endpoint;
  if (session.wanted && session.tabId != null) {
    state.wanted = true;
    state.tabId = session.tabId;
    state.target = session.target || "";
    void loop();
  }
});

function remember() {
  return chrome.storage.session.set({
    wanted: state.wanted,
    tabId: state.tabId,
    target: state.target,
  });
}

/** Wakes the worker if Chrome stopped it anyway; the loop restarts in `ready`. */
const KEEPALIVE_ALARM = "prism-keepalive";
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void ready.then(() => {
    if (state.wanted && !looping) void loop();
  });
});

/** Any extension API call restarts the worker's idle clock; a fetch does not. */
function stayAwake() {
  return chrome.runtime.getPlatformInfo().catch(() => {});
}

function setOnline(online) {
  state.connected = online;
  chrome.action.setBadgeText({ text: online ? "ON" : state.wanted ? "…" : "" });
  chrome.action.setBadgeBackgroundColor({ color: online ? "#2ea8e5" : "#9aa0a6" });
}

/** The long-poll is held for 20 s; anything much longer means Zotero hung. */
const REQUEST_TIMEOUT = 35_000;

/** A 404 (Prism disabled, endpoints gone) must count as a failure, not as "no job". */
async function parse(response) {
  if (!response.ok) throw new Error(`Zotero answered ${response.status}`);
  return response.json().catch(() => ({}));
}

async function post(path, body) {
  const response = await fetch(`${state.endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ZOTERO_HEADERS },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  return parse(response);
}

async function get(path) {
  const response = await fetch(`${state.endpoint}${path}`, {
    method: "GET",
    headers: { ...ZOTERO_HEADERS },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  return parse(response);
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

async function hello() {
  const reply = await post("/prism/bridge/hello", { target: state.target });
  if (!reply?.ok) {
    throw new Error(reply?.error || "Zotero did not answer the handshake");
  }
}

/**
 * Addresses that belong to a chat's maker but are not the chat. Some carry a
 * prompt box of their own (deepseek.com, claude.com) that only forwards to the
 * real one — in a new page, which a script's click is not allowed to open, and
 * where the answer would appear out of this tab's reach anyway.
 */
const NOT_THE_CHAT = {
  "deepseek.com": "chat.deepseek.com",
  "claude.com": "claude.ai",
  "openai.com": "chatgpt.com",
  "qwen.ai": "chat.qwen.ai",
  "tongyi.aliyun.com": "www.qianwen.com",
  "moonshot.cn": "www.kimi.com",
};

async function connect(tab) {
  const target = targetOf(tab);
  if (!target) {
    return {
      ok: false,
      error: "This tab has no address the add-on can use. Open the chat site and connect from there.",
    };
  }
  if (NOT_THE_CHAT[target]) {
    return {
      ok: false,
      error: `${target} is not the chat itself. Open ${NOT_THE_CHAT[target]} and connect from there.`,
    };
  }
  state.tabId = tab.id;
  state.target = target;
  try {
    await hello();
  } catch (e) {
    disconnect();
    return { ok: false, error: String(e) };
  }
  state.wanted = true;
  setOnline(true);
  await remember();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  void loop();
  return { ok: true, target: state.target };
}

function disconnect() {
  state.wanted = false;
  state.tabId = null;
  generation++;
  setOnline(false);
  void remember();
  void chrome.alarms.clear(KEEPALIVE_ALARM);
}

/** Bumped whenever a loop should stop, so a reconnect never leaves two polling. */
let generation = 0;
let looping = false;

async function loop() {
  const mine = ++generation;
  const current = () => state.wanted && mine === generation;
  let failures = 0;
  looping = true;
  try {
    while (current()) {
      try {
        if (!state.connected) {
          await hello();
          if (!current()) break;
          setOnline(true);
        }
        const job = await get("/prism/bridge/next");
        failures = 0;
        await stayAwake();
        if (current() && job?.id) await run(job);
      } catch (e) {
        if (!current()) break;
        // Zotero closed, restarted or is still starting. Keep trying until the
        // user disconnects: giving up after one failed retry meant every
        // Zotero restart needed a trip back to the popup.
        setOnline(false);
        failures++;
        await stayAwake();
        await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 2000 * failures)));
      }
    }
  } finally {
    if (mine === generation) looping = false;
  }
}

/** Put the page adapter back into a tab that lost it (add-on reloaded, or the
 * tab was open before the add-on was installed). */
async function askTab(message) {
  try {
    return await chrome.tabs.sendMessage(state.tabId, message);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(e))) throw e;
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(state.tabId, message);
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
      void post("/prism/bridge/chunk", { id: job.id, whole: message.whole }).catch(() => {});
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  // A model that thinks for a minute sends no chunks meanwhile; without this
  // Zotero would see nothing from the add-on and report it as gone.
  const heartbeat = setInterval(() => {
    void stayAwake();
    void post("/prism/bridge/hello", { target: state.target }).catch(() => {});
  }, 15_000);
  try {
    const result = await askTab({
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
    clearInterval(heartbeat);
    chrome.runtime.onMessage.removeListener(listener);
    state.busy = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "prism-connect") {
    void ready
      .then(() => chrome.tabs.query({ active: true, currentWindow: true }))
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
    // A freshly woken worker has not read its saved connection back yet.
    void ready.then(() =>
      sendResponse({
        wanted: state.wanted,
        connected: state.connected,
        target: state.target,
        endpoint: state.endpoint,
        busy: state.busy,
      }),
    );
    return true;
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
  void ready.then(() => {
    if (tabId === state.tabId) disconnect();
  });
});

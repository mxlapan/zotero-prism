/**
 * Zotero Prism Bridge — page adapter.
 *
 * Types the prompt into whatever chat UI is on the page, then watches the last
 * answer node until it stops growing. Site-specific selectors are used where
 * they are known; everything else falls back to heuristics that work on most
 * chat layouts.
 */

const ADAPTERS = [
  {
    match: /chatgpt\.com|chat\.openai\.com/,
    input: "#prompt-textarea, div[contenteditable='true']",
    send: "button[data-testid='send-button'], #composer-submit-button",
    answer: "[data-message-author-role='assistant']",
  },
  {
    match: /claude\.ai/,
    input: "div[contenteditable='true'].ProseMirror",
    send: "button[aria-label*='Send'], button[aria-label*='send']",
    answer: "div.font-claude-response, div.font-claude-message, [data-testid='message-content']",
  },
  {
    match: /gemini\.google\.com/,
    input: "rich-textarea div[contenteditable='true']",
    send: "button.send-button",
    answer: "message-content",
  },
  {
    match: /doubao\.com/,
    input: "textarea, div[contenteditable='true']",
    send: "#flow-end-msg-send, button[data-testid='chat_input_send_button']",
    answer: "[data-testid='receive_message'], [class*='message-content']",
  },
  {
    match: /kimi\.(moonshot\.cn|com)/,
    input: "div[contenteditable='true'], textarea",
    send: "[data-testid='msh-chatinput-send-button'], .send-button",
    answer: "[class*='segment-assistant'], [class*='markdown']",
  },
  {
    match: /chat\.deepseek\.com/,
    input: "textarea#chat-input, textarea",
    send: "div[role='button'][aria-disabled='false']",
    answer: "div.ds-markdown",
  },
  {
    match: /chat\.qwen\.ai|qianwen\.com|tongyi\.com/,
    input: "textarea, div[contenteditable='true']",
    send: "button[class*='send'], .send-btn",
    answer: "[class*='answer'], [class*='markdown']",
  },
  {
    match: /yuanbao\.tencent\.com/,
    input: "div[contenteditable='true'], textarea",
    send: "[class*='send-btn'], button[class*='send']",
    answer: "[class*='hyc-content-text'], [class*='markdown']",
  },
  {
    match: /chatglm\.cn|chat\.z\.ai/,
    input: "textarea, div[contenteditable='true']",
    send: "[class*='enter'], button[class*='send']",
    answer: "[class*='answer-content'], [class*='markdown-body']",
  },
];

/** Kept in step with the list in background.js. */
const NOT_THE_CHAT = {
  "deepseek.com": "chat.deepseek.com",
  "claude.com": "claude.ai",
  "openai.com": "chatgpt.com",
  "qwen.ai": "chat.qwen.ai",
  "tongyi.aliyun.com": "www.qianwen.com",
  "moonshot.cn": "www.kimi.com",
};

function adapter() {
  const host = location.href;
  return (
    ADAPTERS.find((entry) => entry.match.test(host)) || {
      input:
        "textarea:not([readonly]):not([disabled]), div[contenteditable='true']",
      send: "button[type='submit'], button[aria-label*='end'], button[class*='send']",
      answer:
        "[class*='markdown'], [class*='message'], [class*='answer'], article",
    }
  );
}

function visible(node) {
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 20 && rect.height > 10;
}

function findInput(config) {
  const candidates = [...document.querySelectorAll(config.input)].filter(visible);
  return candidates[candidates.length - 1] || null;
}

async function fill(node, text) {
  node.focus();
  if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") {
    const setter = Object.getOwnPropertyDescriptor(
      node.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  // contenteditable: paste keeps rich editors (ProseMirror, Lexical) in sync
  node.focus();
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const pasted = node.dispatchEvent(
    new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }),
  );
  if (pasted) {
    document.execCommand("insertText", false, text);
  }
  node.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

const usable = (button) =>
  visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true";

/** Send buttons are labelled in the interface language, so match the common ones. */
const SEND_LABEL = /send|submit|发送|發送|提交|傳送|送信/i;
const NOT_SEND = /stop|停止|upload|上传|attach|附件|voice|语音|mic|麦克风|search|搜索|think|思考|tool|工具|model|模型/i;

function labelOf(button) {
  return [
    button.getAttribute("aria-label"),
    button.getAttribute("title"),
    button.getAttribute("data-testid"),
    button.id,
    typeof button.className === "string" ? button.className : "",
    (button.innerText || "").slice(0, 20),
  ].join(" ");
}

/**
 * The send button, by the site's selector or, failing that, by looking around
 * the input: a selector written against an English interface finds nothing on
 * the same site in Chinese, where the label reads 发送.
 */
function sendButton(config, input) {
  const known = [...document.querySelectorAll(config.send)].filter(usable);
  if (known.length) return known[known.length - 1];

  let scope = input;
  for (let depth = 0; depth < 7 && scope?.parentElement; depth++) {
    scope = scope.parentElement;
    const buttons = [...scope.querySelectorAll("button, [role='button']")].filter(usable);
    if (!buttons.length) continue;
    const labelled = buttons.filter((button) => SEND_LABEL.test(labelOf(button)));
    if (labelled.length) return labelled[labelled.length - 1];
    // No label at all: an icon button after the input, the last one in the row.
    const icons = buttons.filter(
      (button) =>
        !NOT_SEND.test(labelOf(button)) &&
        button.querySelector("svg, img, i") &&
        input.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (icons.length) return icons[icons.length - 1];
  }
  return null;
}

/** Some interfaces act on the press rather than on the click that follows it. */
function press(button) {
  const rect = button.getBoundingClientRect();
  const at = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };
  button.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerId: 1, isPrimary: true }));
  button.dispatchEvent(new MouseEvent("mousedown", at));
  button.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerId: 1, isPrimary: true }));
  button.dispatchEvent(new MouseEvent("mouseup", at));
  button.click();
}

function pressEnter(node) {
  node.focus();
  for (const type of ["keydown", "keypress", "keyup"]) {
    node.dispatchEvent(
      new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  }
}

function inputText(node) {
  return (node.isConnected ? node.value ?? node.innerText ?? "" : "").trim();
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What sites show while an answer is being written: a stop button. */
const GENERATING =
  "button[aria-label*='Stop'], button[aria-label*='stop'], button[aria-label*='停止'], " +
  "[data-testid='stop-button'], [data-testid*='stop'], button[class*='stop']";

function generating() {
  return [...document.querySelectorAll(GENERATING)].some(visible);
}

/**
 * Whether the prompt is still sitting in the composer, typed or attached.
 *
 * ChatGPT turns a long paste into a "Pasted text" attachment and leaves the box
 * itself empty. Looking only at the box, that read as "nothing was typed" before
 * sending and as "already sent" after it, so the composer around the box is
 * measured as well: it holds more text than before for as long as the prompt
 * is waiting in it, in either form.
 */
function composerWatch(input) {
  let composer = input.closest("form");
  if (!composer) {
    composer = input;
    for (let depth = 0; depth < 4 && composer.parentElement; depth++) composer = composer.parentElement;
  }
  const size = () => (composer.innerText || "").trim().length;
  const before = size();
  let held = 0;
  return {
    /** Call once the prompt has been put in. */
    filled() {
      held = Math.max(0, size() - before);
      return Boolean(inputText(input)) || held > 0;
    },
    attached: () => !inputText(input) && held > 0,
    waiting() {
      if (!composer.isConnected) return false;
      if (inputText(input)) return true;
      return held > 0 && (size() - before) * 2 > held;
    },
  };
}

/**
 * Send the prompt and make sure it left the box.
 *
 * Most sites keep the send button disabled for a moment after text arrives, so
 * a single click a quarter of a second later often hit nothing — the prompt sat
 * in the box, no answer ever started, and the job ended as "no answer
 * appeared". Each attempt is checked, and the next one tries the other way.
 */
async function submit(node, config, answered, waiting) {
  // Any one of these means it went; pressing again would ask the question twice.
  const sent = () => !waiting() || generating() || Boolean(answered());
  const settle = async (ms) => {
    for (let waited = 0; waited < ms; waited += 150) {
      await pause(150);
      if (sent()) return true;
    }
    return false;
  };
  const tried = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    // The button stays disabled until the page has taken the text in.
    await pause(attempt ? 600 : 300);
    if (sent()) return { ok: true };
    const button = sendButton(config, node);
    if (button && attempt % 2 === 0) {
      tried.push("button");
      press(button);
    } else {
      tried.push("Enter");
      pressEnter(node);
    }
    if (await settle(1800)) return { ok: true };
  }
  const form = node.closest("form");
  if (form) {
    tried.push("form");
    try {
      form.requestSubmit();
    } catch {
      /* not submittable */
    }
    if (await settle(1800)) return { ok: true };
  }
  return { ok: false, tried: [...new Set(tried)].join(", ") };
}

/** Where an answer usually lives when a site's own selector stops matching. */
const FALLBACK_ANSWER =
  "[data-message-author-role='assistant'], [class*='markdown'], [class*='prose']";

const squash = (text) => (text || "").replace(/\s+/g, "").slice(0, 60);

/**
 * Tells the answer to this prompt apart from everything already on the page.
 *
 * Comparing against the last answer node alone misses two layouts: sites that
 * write each answer into the same node, and sites whose selector also matches
 * the question just sent.
 */
function answerFinder(config, prompt) {
  const selectors = [config.answer, FALLBACK_ANSWER];
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
  const seen = new WeakSet();
  for (const selector of selectors) for (const node of all(selector)) seen.add(node);
  const previous = all(config.answer).pop() || null;
  const previousText = previous ? (previous.innerText || "").trim() : "";
  const question = squash(prompt);

  return () => {
    for (const selector of selectors) {
      const fresh = all(selector).filter(
        (node) => !seen.has(node) && squash(node.innerText) !== question,
      );
      // A streaming answer grows matching children of its own; keep the outer one.
      const outer = fresh.filter((node) => !fresh.some((other) => other !== node && other.contains(node)));
      if (outer.length) return outer[outer.length - 1];
    }
    if (previous?.isConnected && (previous.innerText || "").trim() !== previousText) {
      return previous;
    }
    return null;
  };
}

/** How long to wait for an answer to start when the page shows no sign of working. */
const START_TIMEOUT = 30_000;
/** …and when it does: reasoning models can think for minutes before the first word. */
const THINKING_TIMEOUT = 150_000;

async function ask(jobId, prompt) {
  // A tab connected before the add-on learned to refuse this page.
  const chat = NOT_THE_CHAT[location.hostname.replace(/^www\./, "")];
  if (chat) {
    return {
      ok: false,
      error: `${location.hostname} is not the chat itself — open ${chat} and connect from there`,
    };
  }
  const config = adapter();
  const input = findInput(config);
  if (!input) return { ok: false, error: "no chat input found on this page" };

  const find = answerFinder(config, prompt);
  const composer = composerWatch(input);
  await fill(input, prompt);
  // The attachment chip takes a moment to appear.
  let filled = false;
  for (let waited = 0; waited < 2500 && !filled; waited += 250) {
    await pause(250);
    filled = composer.filled();
  }
  if (!filled) {
    return { ok: false, error: "could not type into the chat box — click into it once and try again" };
  }
  if (composer.attached()) {
    // An attachment with no message beside it is sometimes only acknowledged.
    input.focus();
    document.execCommand("insertText", false, "Follow the instructions in the pasted text above.");
    await pause(150);
  }
  const sending = await submit(input, config, find, composer.waiting);
  if (!sending.ok) {
    return {
      ok: false,
      error: `the prompt was typed but ${location.hostname} did not send it (tried: ${sending.tried})`,
    };
  }

  return new Promise((resolve) => {
    const started = Date.now();
    let text = "";
    let stableSince = 0;
    const timer = setInterval(() => {
      const node = find();
      if (!node) {
        const waited = Date.now() - started;
        if (waited > THINKING_TIMEOUT || (waited > START_TIMEOUT && !generating())) {
          clearInterval(timer);
          resolve({ ok: false, error: "no answer appeared" });
        }
        return;
      }
      const current = (node.innerText || "").trim();
      const quiet = Date.now() - stableSince;
      if (current && current !== text) {
        text = current;
        stableSince = Date.now();
        chrome.runtime.sendMessage({ type: "prism-chunk", jobId, whole: text });
      } else if (text && (quiet > 20_000 || (quiet > 2200 && !generating()))) {
        // A pause mid-answer is not the end of it while the stop button is up.
        clearInterval(timer);
        resolve({ ok: true, text });
      }
      if (Date.now() - started > 240000) {
        clearInterval(timer);
        resolve(text ? { ok: true, text } : { ok: false, error: "timed out" });
      }
    }, 450);
  });
}

// The background worker re-injects this file into a tab that stopped answering;
// a second listener would type every prompt twice.
if (!globalThis.__prismBridgeListening) {
  globalThis.__prismBridgeListening = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "prism-ask") {
      ask(message.jobId, message.prompt).then(sendResponse);
      return true;
    }
    return false;
  });
}

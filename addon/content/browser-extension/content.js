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
    answer: "div.font-claude-message, [data-testid='message-content']",
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
    match: /chat\.qwen\.ai|tongyi\.aliyun\.com/,
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
    match: /chatglm\.cn/,
    input: "textarea, div[contenteditable='true']",
    send: "[class*='enter'], button[class*='send']",
    answer: "[class*='answer-content'], [class*='markdown-body']",
  },
];

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

async function submit(node, config) {
  await new Promise((resolve) => setTimeout(resolve, 260));
  const buttons = [...document.querySelectorAll(config.send)].filter(
    (button) => visible(button) && !button.disabled,
  );
  const button = buttons[buttons.length - 1];
  if (button) {
    button.click();
    return true;
  }
  node.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}

function lastAnswer(config) {
  const nodes = [...document.querySelectorAll(config.answer)].filter(visible);
  return nodes[nodes.length - 1] || null;
}

async function ask(jobId, prompt) {
  const config = adapter();
  const input = findInput(config);
  if (!input) return { ok: false, error: "no chat input found on this page" };

  const before = lastAnswer(config);
  await fill(input, prompt);
  await submit(input, config);

  return new Promise((resolve) => {
    const started = Date.now();
    let text = "";
    let stableSince = 0;
    const timer = setInterval(() => {
      const node = lastAnswer(config);
      if (!node || node === before) {
        if (Date.now() - started > 25000) {
          clearInterval(timer);
          resolve({ ok: false, error: "no answer appeared" });
        }
        return;
      }
      const current = (node.innerText || "").trim();
      if (current && current !== text) {
        text = current;
        stableSince = Date.now();
        chrome.runtime.sendMessage({ type: "prism-chunk", jobId, whole: text });
      } else if (text && Date.now() - stableSince > 2200) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "prism-ask") {
    ask(message.jobId, message.prompt).then(sendResponse);
    return true;
  }
  return false;
});

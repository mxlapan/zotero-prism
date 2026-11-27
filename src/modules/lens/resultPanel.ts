/**
 * A floating panel for one AI answer or translation.
 *
 * Results used to be shown inside the reader — in Zotero's text selection
 * popup — or written straight into an annotation's comment with nothing shown
 * meanwhile. Inside the reader, Delete and Backspace are taken by the reader's
 * own handler, which runs before anything a plugin can register and clears
 * the selection, closing the popup mid-edit; and the reader's popups can be
 * neither moved nor resized. This panel lives in the window that holds the
 * reader instead: progress shows at once, the result can be edited when it is
 * complete, nothing is written anywhere until an action is clicked, and the
 * panel is dragged by its header and resized from its corner.
 */

import { el, makeDraggable, makeResizable, setHTML } from "../../utils/dom";
import { bi } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
import { renderMarkdown } from "../../lib/markdown";
import { injectAssets } from "./ui";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ResultAction {
  label: string;
  /**
   * Gets the text of every section, as it stands after any edits. May return
   * a label to show on the button afterwards, such as "Saved".
   */
  run: (texts: string[]) => Promise<string | void> | string | void;
}

export interface ResultPanelOptions {
  win: Window;
  title: string;
  /** the passage the result is about, shown small above it */
  quote?: string;
  /** one editable section per entry; an entry is the section's heading, or "" */
  sections?: string[];
  actions: ResultAction[];
  /** open beside this rect, in `win`'s coordinates */
  near?: Rect | null;
}

export interface ResultPanel {
  status(text: string): void;
  /** Replace a section's content; called repeatedly while an answer streams. */
  show(index: number, text: string, format?: "markdown" | "text"): void;
  /** The result is complete: it becomes editable and the actions active. */
  finish(): void;
  fail(message: string): void;
  /** Each section's text as it stands, edits included. */
  texts(): string[];
  close(): void;
  readonly closed: boolean;
}

let current: ResultPanel | null = null;
/** Where the panel was last dragged to, for this session. */
let lastPosition: { left: number; top: number } | null = null;

export function openResultPanel(options: ResultPanelOptions): ResultPanel {
  current?.close();
  const { win } = options;
  const doc = win.document;
  injectAssets(doc);

  const statusLine = el(doc, "span", { class: "prism-sub" });
  const head = el(
    doc,
    "div",
    { class: "prism-head" },
    el(doc, "span", { class: "prism-logo" }),
    el(doc, "span", { class: "prism-title", text: options.title }),
    statusLine,
  );
  const headActions = el(doc, "div", { class: "prism-head-actions" });
  head.append(headActions);

  const body = el(doc, "div", { class: "prism-result-body" });
  const texts: HTMLElement[] = [];
  for (const heading of options.sections?.length ? options.sections : [""]) {
    const section = el(doc, "div", { class: "prism-result-section" });
    if (heading) section.append(el(doc, "div", { class: "prism-result-heading", text: heading }));
    const text = el(doc, "div", {
      class: "prism-result-text prism-md",
      attrs: { spellcheck: "false" },
    });
    texts.push(text);
    section.append(text);
    body.append(section);
  }

  const buttons = options.actions.map((action) => {
    const button = el(doc, "button", { class: "prism-btn", text: action.label }) as HTMLButtonElement;
    button.disabled = true;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const label = await action.run(panel.texts());
        if (label) button.textContent = label;
      } catch (e: any) {
        panel.status(`${bi("Failed: ", "失败：")}${e?.message || e}`);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  });
  const foot = el(
    doc,
    "div",
    { class: "prism-result-foot" },
    el(doc, "span", {
      class: "prism-result-hint",
      text: bi("Editable once complete", "生成完成后可直接修改"),
    }),
    ...buttons,
  );

  const grip = el(doc, "div", { class: "prism-grip", title: bi("Drag to resize", "拖动调整大小") });
  const root = el(doc, "div", { class: "prism-panel prism-result" }, head);
  if (options.quote) {
    root.append(el(doc, "div", { class: "prism-result-quote", text: options.quote }));
  }
  root.append(body, foot, grip);

  const width = Number(getPref("lens.popupWidth", 420)) || 420;
  const height = Number(getPref("lens.popupHeight", 0)) || 340;
  root.style.width = `${Math.min(width, win.innerWidth - 16)}px`;
  root.style.height = `${Math.min(height, win.innerHeight - 16)}px`;
  root.style.visibility = "hidden";
  (doc.body || doc.documentElement).append(root);
  place(root, win, options.near);
  root.style.visibility = "";

  makeDraggable(head, root, (left, top) => {
    lastPosition = { left, top };
  });
  makeResizable(root, grip, (w, h) => {
    setPref("lens.popupWidth", w);
    setPref("lens.popupHeight", h);
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.remove();
    if (current === panel) current = null;
  };
  headActions.append(
    el(doc, "button", { class: "prism-icon-btn", text: "✕", title: "Esc", on: { click: close } }),
  );
  root.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  const panel: ResultPanel = {
    status(text) {
      statusLine.textContent = text;
    },
    show(index, text, format = "markdown") {
      const target = texts[index];
      if (!target) return;
      target.classList.remove("prism-error");
      if (format === "text") target.textContent = text;
      else setHTML(target, renderMarkdown(text));
      // Follow a streaming answer down while the reader has not scrolled up.
      if (body.scrollHeight - body.scrollTop - body.clientHeight < 80) {
        body.scrollTop = body.scrollHeight;
      }
    },
    finish() {
      statusLine.textContent = "";
      for (const text of texts) text.setAttribute("contenteditable", "true");
      for (const button of buttons) button.disabled = false;
    },
    fail(message) {
      statusLine.textContent = bi("Failed", "失败");
      const target = texts[0];
      if (target) {
        target.textContent = message;
        target.classList.add("prism-error");
      }
    },
    texts: () => texts.map((text) => text.innerText.trim()),
    close,
    get closed() {
      return closed;
    },
  };
  current = panel;
  return panel;
}

/** Where the panel was last dragged to, or beside `near`, or the right of the window. */
function place(root: HTMLElement, win: Window, near?: Rect | null) {
  const box = root.getBoundingClientRect();
  const pad = 8;
  let left: number;
  let top: number;
  if (lastPosition) {
    ({ left, top } = lastPosition);
  } else if (near) {
    left = near.left + near.width + 12;
    if (left + box.width > win.innerWidth - pad) left = near.left - box.width - 12;
    top = near.top;
  } else {
    left = win.innerWidth - box.width - 40;
    top = win.innerHeight * 0.15;
  }
  left = Math.min(Math.max(pad, left), Math.max(pad, win.innerWidth - box.width - pad));
  top = Math.min(Math.max(pad, top), Math.max(pad, win.innerHeight - box.height - pad));
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
}

/** Where a node from any frame sits, in the coordinates of the window `host`. */
export function rectIn(host: Window, node: Element): Rect | null {
  try {
    const rect = node.getBoundingClientRect();
    const frame: any = node.ownerDocument.defaultView;
    const dx = Number(frame.mozInnerScreenX) - Number((host as any).mozInnerScreenX);
    const dy = Number(frame.mozInnerScreenY) - Number((host as any).mozInnerScreenY);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return { left: rect.left + dx, top: rect.top + dy, width: rect.width, height: rect.height };
  } catch {
    return null;
  }
}

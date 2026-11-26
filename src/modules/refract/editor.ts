/**
 * Editing one translated paragraph.
 *
 * The editor opens in the window that holds the reader, over the paragraph,
 * rather than inside the PDF page. The page belongs to the PDF view, which
 * takes the keyboard for its own shortcuts and lets typing through only to
 * its own text annotations; a text box there loses arrow keys and letters to
 * the viewer. Out here a textarea behaves like any other: selection, copy,
 * undo, input methods.
 */

import { el, makeDraggable } from "../../utils/dom";
import { bi } from "../../utils/locale";
import { injectAssets } from "../lens/ui";

export interface Anchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EditRequest {
  /** the window holding the reader */
  win: Window;
  /** the paragraph, in that window's coordinates */
  anchor?: Anchor | null;
  original: string;
  translated: string;
  /** the engine's translation, when `translated` has been edited before */
  machine?: string;
  /** called with the new text; the machine text itself means "no edit" */
  onSave: (text: string) => void;
}

let current: (() => void) | null = null;

export function editTranslation(request: EditRequest) {
  current?.();
  const { win } = request;
  const doc = win.document;
  injectAssets(doc);

  const input = el(doc, "textarea", {
    class: "prism-editor-input",
    attrs: { spellcheck: "false" },
  }) as HTMLTextAreaElement;
  input.value = request.translated;

  const save = el(doc, "button", {
    class: "prism-btn prism-btn-primary",
    text: bi("Save", "保存"),
  }) as HTMLButtonElement;
  const cancel = el(doc, "button", { class: "prism-btn", text: bi("Cancel", "取消") });
  const foot = el(doc, "div", { class: "prism-editor-foot" });
  if (request.machine !== undefined) {
    foot.append(
      el(doc, "button", {
        class: "prism-btn",
        text: bi("Restore machine translation", "恢复机器译文"),
        title: request.machine,
        on: { click: () => finish(request.machine!) },
      }),
    );
  }
  foot.append(
    el(doc, "span", {
      class: "prism-editor-hint",
      text: bi("Ctrl+Enter to save · Esc to cancel", "Ctrl+Enter 保存 · Esc 取消"),
    }),
    cancel,
    save,
  );

  const head = el(
    doc,
    "div",
    { class: "prism-head" },
    el(doc, "span", { class: "prism-logo" }),
    el(doc, "span", { class: "prism-title", text: bi("Edit translation", "编辑译文") }),
  );
  const actions = el(doc, "div", { class: "prism-head-actions" });
  actions.append(
    el(doc, "button", {
      class: "prism-icon-btn",
      text: "✕",
      title: "Esc",
      on: { click: () => close() },
    }),
  );
  head.append(actions);

  const root = el(
    doc,
    "div",
    { class: "prism-panel prism-editor" },
    head,
    el(
      doc,
      "div",
      { class: "prism-editor-body" },
      el(doc, "div", { class: "prism-editor-label", text: bi("Original", "原文") }),
      el(doc, "div", { class: "prism-editor-original", text: request.original }),
      el(doc, "div", { class: "prism-editor-label", text: bi("Translation", "译文") }),
      input,
    ),
    foot,
  );

  const width = Math.round(
    Math.min(640, Math.max(380, (request.anchor?.width || 0) + 32)),
  );
  root.style.width = `${width}px`;
  root.style.visibility = "hidden";
  (doc.body || doc.documentElement).append(root);
  place(root, win, request.anchor, width);
  root.style.visibility = "";
  makeDraggable(head, root);

  const refresh = () => {
    save.disabled = !input.value.trim();
  };
  const finish = (text: string) => {
    close();
    request.onSave(text);
  };
  const close = () => {
    root.remove();
    if (current === close) current = null;
  };
  current = close;

  input.addEventListener("input", refresh);
  save.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;
    if (text === request.translated.trim()) close();
    else finish(text);
  });
  cancel.addEventListener("click", close);
  root.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      save.click();
    }
  });
  refresh();
  win.setTimeout(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, 0);
}

/** Over the paragraph if there is room, otherwise as close as fits. */
function place(root: HTMLElement, win: Window, anchor: Anchor | null | undefined, width: number) {
  const height = root.getBoundingClientRect().height || 320;
  const maxLeft = Math.max(8, win.innerWidth - width - 8);
  const maxTop = Math.max(8, win.innerHeight - height - 8);
  let left = (win.innerWidth - width) / 2;
  let top = win.innerHeight * 0.2;
  if (anchor) {
    left = anchor.left - 16;
    // The header sits above the paragraph, so the text box lands on it.
    top = anchor.top - 72;
  }
  root.style.left = `${Math.round(Math.min(maxLeft, Math.max(8, left)))}px`;
  root.style.top = `${Math.round(Math.min(maxTop, Math.max(8, top)))}px`;
}

/** Shared chat rendering used by the floating panel and the reader sidebar. */

import { config } from "../../../package.json";
import { clear, el, injectStylesheet, setHTML } from "../../utils/dom";
import { renderMarkdown, markdownToNoteHTML } from "../../lib/markdown";
import { getString, bi } from "../../utils/locale";
import type { ChatSession, Turn } from "./chat";
import { appendToNote, contextItems, createChildNote, navigateTo, toRegularItem, zoteroPane } from "../../utils/item";
import { getPref } from "../../utils/prefs";

export function injectAssets(doc: Document) {
  const ref = config.addonRef;
  injectStylesheet(doc, "prism-style", `chrome://${ref}/content/styles/prism.css`);
  injectStylesheet(doc, "prism-katex", `chrome://${ref}/content/vendor/katex/katex.min.css`);
  const dark = doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  injectStylesheet(
    doc,
    "prism-hljs",
    `chrome://${ref}/content/vendor/hljs/${dark ? "dark" : "light"}.css`,
  );
}

export interface TurnHandlers {
  onRetry?: (turn: Turn) => void;
  onSaveNote?: (turn: Turn) => void;
  onAnnotate?: (turn: Turn) => void;
}

/** Re-render a conversation into `container`, preserving scroll position. */
/**
 * Links inside a rendered answer would otherwise navigate the Zotero window
 * itself, leaving the user stranded on a web page with no back button.
 */
function interceptLinks(container: HTMLElement) {
  if (container.dataset.prismLinks === "1") return;
  container.dataset.prismLinks = "1";
  container.addEventListener("click", (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement)?.closest?.(
      "a[href]",
    ) as HTMLAnchorElement | null;
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") || "";
    if (!href) return;
    if (href.startsWith("zotero://")) {
      Zotero.getMainWindow()?.ZoteroPane?.loadURI?.(href);
      return;
    }
    Zotero.launchURL(href);
  });
}

export function renderConversation(
  container: HTMLElement,
  session: ChatSession,
  handlers: TurnHandlers = {},
) {
  const doc = container.ownerDocument;
  interceptLinks(container);
  const atBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  clear(container);

  for (const turn of session.turns) {
    container.append(renderTurn(doc, turn, session, handlers));
  }
  if (atBottom) container.scrollTop = container.scrollHeight;
}

export function renderTurn(
  doc: Document,
  turn: Turn,
  session: ChatSession,
  handlers: TurnHandlers,
): HTMLElement {
  const streaming = session.busy && turn.role === "assistant" && !turn.error;
  const bubble = el(doc, "div", {
    class: `prism-bubble prism-md${streaming && !turn.content ? " prism-cursor" : ""}`,
    html: turn.content
      ? renderMarkdown(turn.content)
      : streaming
        ? `<p>${getString("panel-thinking")}</p>`
        : "",
  });

  const wrapper = el(doc, "div", {
    class: `prism-turn prism-turn-${turn.role}${turn.error ? " prism-error" : ""}`,
  });
  wrapper.append(bubble);

  if (turn.role === "assistant" && turn.sources?.length) {
    const sources = el(doc, "div", { class: "prism-sources" });
    turn.sources.forEach((source, index) => {
      sources.append(
        el(doc, "div", {
          class: "prism-source",
          text: `[${index + 1}] ${source.title}${source.page >= 0 ? ` · p.${source.page + 1}` : ""}`,
          title: source.text,
          on: {
            click: () => {
              const item = Zotero.Items.getByLibraryAndKey(
                Zotero.Libraries.userLibraryID,
                source.itemKey,
              ) as Zotero.Item | false;
              if (!item) return;
              void zoteroPane()?.selectItem(item.id);
            },
          },
        }),
      );
    });
    wrapper.append(sources);
  }

  if (turn.role === "assistant" && !streaming && turn.content) {
    wrapper.append(renderActions(doc, turn, handlers));
  }
  return wrapper;
}

function renderActions(
  doc: Document,
  turn: Turn,
  handlers: TurnHandlers,
): HTMLElement {
  const meta = el(doc, "div", { class: "prism-meta" });
  if (turn.model) meta.append(el(doc, "span", { text: turn.model }));
  if (turn.ms) meta.append(el(doc, "span", { text: `${(turn.ms / 1000).toFixed(1)}s` }));
  if (turn.edited) {
    meta.append(el(doc, "span", { class: "prism-edited-mark", text: bi("edited", "已编辑") }));
  }

  const copy = el(doc, "button", { text: getString("panel-copy") });
  copy.addEventListener("click", () => {
    new ztoolkit.Clipboard().addText(turn.content, "text/plain").copy();
    copy.textContent = getString("panel-copied");
    doc.defaultView?.setTimeout(() => {
      copy.textContent = getString("panel-copy");
    }, 1200);
  });
  meta.append(copy);

  // A failed turn holds the error message; saving it made a note of the error.
  if (turn.error) {
    if (handlers.onRetry) {
      const retry = el(doc, "button", { text: getString("panel-retry") });
      retry.addEventListener("click", () => handlers.onRetry!(turn));
      meta.append(retry);
    }
    return meta;
  }

  // What is saved, appended or asked about next is the edited answer.
  const edit = el(doc, "button", { text: bi("Edit", "编辑") });
  edit.addEventListener("click", () => editTurn(doc, turn, meta, handlers));
  meta.append(edit);

  const note = el(doc, "button", { text: getString("panel-to-note") });
  note.addEventListener("click", async () => {
    if (handlers.onSaveNote) {
      handlers.onSaveNote(turn);
      return;
    }
    await saveTurnAsNote(turn);
  });
  meta.append(note);

  // Awesome GPT's note sidebar puts the answer into the note you are writing.
  // Zotero's note editor is not scriptable from a plugin, but appending to the
  // selected note is the part that matters and survives every Zotero version.
  const into = el(doc, "button", { text: bi("Append to note", "追加到笔记") });
  into.addEventListener("click", () => void appendTurnToNote(turn));
  meta.append(into);

  if (handlers.onAnnotate) {
    const annotate = el(doc, "button", { text: getString("panel-to-annotation") });
    annotate.addEventListener("click", () => handlers.onAnnotate!(turn));
    meta.append(annotate);
  }
  if (handlers.onRetry) {
    const retry = el(doc, "button", { text: getString("panel-retry") });
    retry.addEventListener("click", () => handlers.onRetry!(turn));
    meta.append(retry);
  }
  return meta;
}

/**
 * Swap an answer's bubble for a text box holding its Markdown. Saving replaces
 * the answer in the conversation, so the note it is saved to, the text it is
 * copied as and the context of the next question all use the edited version.
 */
function editTurn(doc: Document, turn: Turn, meta: HTMLElement, handlers: TurnHandlers) {
  const wrapper = meta.parentElement;
  const bubble = wrapper?.querySelector(".prism-bubble") as HTMLElement | null;
  if (!wrapper || !bubble || wrapper.querySelector(".prism-turn-editor")) return;

  const input = el(doc, "textarea", { attrs: { spellcheck: "false" } }) as HTMLTextAreaElement;
  input.value = turn.content;
  const editor = el(doc, "div", { class: "prism-turn-editor" }, input);
  const done = (save: boolean) => {
    const text = input.value.trim();
    if (save && text && text !== turn.content) {
      turn.content = text;
      turn.edited = true;
      setHTML(bubble, renderMarkdown(text));
      meta.replaceWith(renderActions(doc, turn, handlers));
    } else {
      meta.style.display = "";
    }
    editor.remove();
    bubble.style.display = "";
  };
  editor.append(
    el(
      doc,
      "div",
      { class: "prism-turn-editor-actions" },
      el(doc, "button", { class: "prism-btn", text: bi("Cancel", "取消"), on: { click: () => done(false) } }),
      el(doc, "button", {
        class: "prism-btn prism-btn-primary",
        text: bi("Save", "保存"),
        on: { click: () => done(true) },
      }),
    ),
  );
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    // Esc would otherwise close the whole panel.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      done(false);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      done(true);
    }
  });
  input.style.height = `${Math.min(420, Math.max(140, bubble.scrollHeight + 24))}px`;
  // `.prism-meta` is display: flex, which beats the `hidden` attribute.
  bubble.style.display = "none";
  meta.style.display = "none";
  wrapper.insertBefore(editor, bubble);
  input.focus();
}

/** Write an answer into a child note, keeping the prompt for provenance. */
export async function saveTurnAsNote(turn: Turn, target?: Zotero.Item | null) {
  const item = toRegularItem(target ?? contextItems()[0] ?? null);
  const html = [
    `<h2>${bi("Prism answer", "棱镜回答")}</h2>`,
    markdownToNoteHTML(turn.content),
  ];
  if (getPref<boolean>("lens.provenance", true)) {
    const when = new Date(turn.ts).toLocaleString();
    html.push(
      `<hr/><p style="color:#888;font-size:0.85em">${bi(`Generated by ${turn.model || "?"}`, `由 ${turn.model || "?"} 生成`)} · ${when}${turn.promptID ? ` · ${turn.promptID}` : ""}</p>`,
    );
    if (turn.sources?.length) {
      html.push(
        `<p style="color:#888;font-size:0.85em">${bi("Sources: ", "来源：")}${turn.sources
          .map((s, i) => `[${i + 1}] ${s.title}${s.page >= 0 ? ` p.${s.page + 1}` : ""}`)
          .join("; ")}</p>`,
      );
    }
  }
  const body = html.join("\n");
  if (item) {
    await createChildNote(item, body, "prism");
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: bi("Saved to note", "已保存为笔记"), type: "success" })
      .show(2500);
  } else {
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote(body);
    await note.saveTx();
  }
}

/** The note the user has selected, if any. */
function selectedNote(): Zotero.Item | null {
  try {
    const items: Zotero.Item[] = zoteroPane()?.getSelectedItems?.() || [];
    return items.find((item) => item.isNote?.()) || null;
  } catch {
    return null;
  }
}

/** Append an answer to the selected note, rather than making a new one. */
export async function appendTurnToNote(turn: Turn) {
  const note = selectedNote();
  if (!note) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({
        text: bi("Select a note first.", "请先选中一条笔记。"),
        type: "fail",
      })
      .show(2500);
    return;
  }
  await appendToNote(note, markdownToNoteHTML(turn.content));
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text: bi("Appended", "已追加到笔记"), type: "success" })
    .show(2000);
}

export function jumpToAnnotation(attachmentID: number, annotationKey: string) {
  void navigateTo(attachmentID, { annotationKey });
}

/** A short, human line describing which model/route is active. */
export function routeLabel(): string {
  const bridge = addon.data.lens.bridge;
  if (getPref<boolean>("lens.bridgeEnabled", false) && bridge.connected) {
    return `${bi("web", "网页")} · ${bridge.target || "?"}`;
  }
  return getPref<string>("lens.model", "");
}

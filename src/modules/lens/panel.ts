/**
 * The floating ask-anything panel (Ctrl+/).
 *
 * Deliberately transient: it remembers position, size and font scale, but the
 * conversation is per window and one keystroke away from being cleared.
 */

import { el, clear, makeDraggable, makeResizable } from "../../utils/dom";
import { getString, bi } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
import { sessionFor, type Turn } from "./chat";
import { promptsFor, type PromptDef } from "./prompts";
import { injectAssets, renderConversation, routeLabel, saveTurnAsNote } from "./ui";
import { contextItems, currentReader, toRegularItem } from "../../utils/item";
import { isConfigured } from "./provider";
import { currentPageIndex } from "../../utils/reader";

const panels = new WeakMap<Window, PrismPanel>();

export class PrismPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private input: HTMLTextAreaElement;
  private tagsRow: HTMLElement;
  private subtitle: HTMLElement;
  private sendButton: HTMLButtonElement;
  private history: string[] = [];
  private historyIndex = -1;
  private activePrompt?: PromptDef;
  readonly sessionKey: string;

  constructor(private win: Window) {
    this.sessionKey = `panel-${Math.random().toString(36).slice(2, 7)}`;
    const doc = win.document;
    injectAssets(doc);

    this.subtitle = el(doc, "span", { class: "prism-sub" });
    this.body = el(doc, "div", { class: "prism-body" });
    this.tagsRow = el(doc, "div", { class: "prism-tags" });
    this.input = el(doc, "textarea", {
      class: "prism-input",
      attrs: { rows: "1", placeholder: getString("panel-ask-placeholder") },
    }) as HTMLTextAreaElement;
    this.sendButton = el(doc, "button", {
      class: "prism-send",
      text: "↵",
    }) as HTMLButtonElement;

    const head = el(
      doc,
      "div",
      { class: "prism-head" },
      el(doc, "span", { class: "prism-logo" }),
      el(doc, "span", { class: "prism-title", text: "Prism" }),
      this.subtitle,
    );
    const actions = el(doc, "div", { class: "prism-head-actions" });
    actions.append(
      this.iconButton(doc, "＋", getString("panel-clear"), () => this.newChat()),
      this.iconButton(doc, "⚙", bi("Settings", "设置"), () => openSettings()),
      this.iconButton(doc, "✕", "Esc", () => this.close()),
    );
    head.append(actions);

    const grip = el(doc, "div", { class: "prism-grip" });
    const gripLeft = el(doc, "div", { class: "prism-grip prism-grip-left" });
    this.root = el(
      doc,
      "div",
      { class: "prism-panel", id: "prism-floating-panel" },
      head,
      this.body,
      el(
        doc,
        "div",
        { class: "prism-foot" },
        this.tagsRow,
        el(doc, "div", { class: "prism-input-row" }, this.input, this.sendButton),
      ),
      grip,
      gripLeft,
    );
    this.root.hidden = true;

    const state = addon.data.lens.panelState;
    this.root.style.width = `${state.w}px`;
    this.root.style.height = `${state.h}px`;
    this.root.style.fontSize = `${getPref("lens.panelFontSize", 14)}px`;
    this.place();

    (doc.body || doc.documentElement).append(this.root);

    makeDraggable(head, this.root, (x, y) => {
      state.x = x;
      state.y = y;
    });
    const resized = (w: number, h: number, x: number, y: number) => {
      Object.assign(state, { w, h, x, y });
      setPref("lens.panelWidth", w);
    };
    makeResizable(this.root, grip, resized);
    makeResizable(this.root, gripLeft, resized, "left");

    this.sendButton.addEventListener("click", () => void this.submit());
    this.input.addEventListener("keydown", (e: KeyboardEvent) => this.onKey(e));
    this.input.addEventListener("input", () => this.autoGrow());
    this.root.addEventListener("wheel", (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const current = parseFloat(this.root.style.fontSize) || 14;
      const next = Math.min(22, Math.max(10, current + (e.deltaY < 0 ? 1 : -1)));
      this.root.style.fontSize = `${next}px`;
      setPref("lens.panelFontSize", next);
    });
    this.root.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    });
    this.renderTags();
    this.renderEmpty();
  }

  private iconButton(
    doc: Document,
    label: string,
    title: string,
    handler: () => void,
  ) {
    return el(doc, "button", {
      class: "prism-icon-btn",
      text: label,
      title,
      on: { click: handler },
    });
  }

  private place() {
    const state = addon.data.lens.panelState;
    if (state.x >= 0 && state.y >= 0) {
      this.root.style.left = `${state.x}px`;
      this.root.style.top = `${state.y}px`;
      return;
    }
    const width = state.w;
    this.root.style.left = `${Math.max(20, (this.win.innerWidth - width) / 2)}px`;
    this.root.style.top = `${Math.max(40, this.win.innerHeight * 0.18)}px`;
  }

  get session() {
    return sessionFor(this.sessionKey);
  }

  get visible() {
    return !this.root.hidden;
  }

  open() {
    this.root.hidden = false;
    addon.data.lens.panelState.open = true;
    this.updateSubtitle();
    this.renderTags();
    this.win.setTimeout(() => this.input.focus(), 30);
  }

  close() {
    this.root.hidden = true;
    addon.data.lens.panelState.open = false;
    this.session.stop();
  }

  toggle() {
    if (this.visible) this.close();
    else this.open();
  }

  destroy() {
    this.session.stop();
    this.root.remove();
  }

  newChat() {
    this.session.reset();
    this.activePrompt = undefined;
    this.renderTags();
    this.renderEmpty();
  }

  private updateSubtitle() {
    const items = contextItems();
    const reader = currentReader();
    const scope = reader
      ? bi("reading", "阅读中")
      : items.length === 1
        ? String(items[0].getField("title") || "").slice(0, 40)
        : items.length
          ? bi(`${items.length} items`, `${items.length} 个条目`)
          : bi("library", "文库");
    this.subtitle.textContent = `${scope} · ${routeLabel()}`;
  }

  private renderEmpty() {
    clear(this.body);
    const doc = this.win.document;
    const box = el(doc, "div", { class: "prism-empty" });
    box.append(
      el(doc, "div", {
        text: isConfigured()
          ? bi(
              "Ask about the paper you are reading, your selection, or your whole library.",
              "针对当前文献、选中条目或整个文库提问。",
            )
          : getString("panel-no-key"),
      }),
    );
    const actions = el(doc, "div", { class: "prism-empty-actions" });
    for (const prompt of promptsFor("panel").slice(0, 5)) {
      actions.append(
        el(doc, "button", {
          class: "prism-btn",
          text: prompt.name,
          on: { click: () => void this.run(prompt) },
        }),
      );
    }
    box.append(actions);
    this.body.append(box);
  }

  private renderTags() {
    clear(this.tagsRow);
    const doc = this.win.document;
    for (const prompt of promptsFor("panel")) {
      const chip = el(doc, "div", {
        class: "prism-tag",
        text: prompt.name,
        title: prompt.trigger ? `/${prompt.trigger}` : prompt.id,
        attrs: { "data-active": this.activePrompt?.id === prompt.id ? "1" : "0" },
        style: {
          color: this.activePrompt?.id === prompt.id ? "#fff" : prompt.color || "",
          background:
            this.activePrompt?.id === prompt.id ? prompt.color || "" : "",
        },
        on: {
          click: () => {
            this.activePrompt =
              this.activePrompt?.id === prompt.id ? undefined : prompt;
            this.renderTags();
            if (this.activePrompt && !this.needsQuestion(this.activePrompt)) {
              void this.submit();
            } else {
              this.input.focus();
            }
          },
        },
      });
      this.tagsRow.append(chip);
    }
  }

  private needsQuestion(prompt: PromptDef) {
    return prompt.body.includes("P.question");
  }

  private autoGrow() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`;
  }

  private onKey(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void this.submit();
      return;
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !this.input.value.includes("\n")
    ) {
      if (!this.history.length) return;
      event.preventDefault();
      if (event.key === "ArrowUp") {
        this.historyIndex = Math.min(
          this.history.length - 1,
          this.historyIndex + 1,
        );
      } else {
        this.historyIndex = Math.max(-1, this.historyIndex - 1);
      }
      this.input.value =
        this.historyIndex < 0
          ? ""
          : this.history[this.history.length - 1 - this.historyIndex];
      this.autoGrow();
    }
  }

  async run(prompt: PromptDef, question = "") {
    this.activePrompt = prompt;
    this.renderTags();
    await this.dispatch(question, prompt);
  }

  private async submit() {
    const text = this.input.value.trim();
    const prompt = this.activePrompt;
    if (!text && !prompt) return;
    if (text) {
      this.history.push(text);
      this.historyIndex = -1;
    }
    this.input.value = "";
    this.autoGrow();
    await this.dispatch(text, prompt);
  }

  private async dispatch(text: string, prompt?: PromptDef) {
    const session = this.session;
    if (session.busy) {
      session.stop();
      this.sendButton.textContent = "↵";
      this.paint();
      return;
    }
    this.updateSubtitle();
    this.sendButton.textContent = "■";
    const reader = currentReader();
    const env = {
      question: text,
      item: toRegularItem(contextItems()[0] ?? null),
      items: contextItems(),
      pageIndex: readerPage(reader),
      selection: readerSelection(reader),
    };
    await session.send(text, {
      prompt,
      env,
      onUpdate: () => this.paint(),
    });
    this.sendButton.textContent = "↵";
    this.paint();
  }

  private paint() {
    renderConversation(this.body, this.session, {
      onRetry: (turn: Turn) => {
        const index = this.session.turns.indexOf(turn);
        const question = this.session.turns[index - 1];
        this.session.turns.splice(index - 1, 2);
        void this.dispatch(question?.content || "", this.activePrompt);
      },
      onSaveNote: (turn) => void saveTurnAsNote(turn),
    });
  }
}

function readerPage(reader?: _ZoteroTypes.ReaderInstance): number {
  return reader ? currentPageIndex(reader) : 0;
}

function readerSelection(reader?: _ZoteroTypes.ReaderInstance): string {
  try {
    return reader ? ztoolkit.Reader.getSelectedText(reader) || "" : "";
  } catch {
    return "";
  }
}

export function openSettings() {
  try {
    (Zotero.Utilities.Internal as any).openPreferences(addon.data.prefsPaneID);
  } catch {
    try {
      (Zotero.Utilities.Internal as any).openPreferences();
    } catch {
      Zotero.getMainWindow()?.openDialog(
        "chrome://zotero/content/preferences/preferences.xhtml",
        "zotero-prefs",
        "chrome,titlebar,toolbar,centerscreen",
      );
    }
  }
}

export function getPanel(win: Window): PrismPanel {
  let panel = panels.get(win);
  if (!panel) {
    panel = new PrismPanel(win);
    panels.set(win, panel);
  }
  return panel;
}

export function togglePanel(win?: Window) {
  const target = win || (Zotero.getMainWindow() as unknown as Window);
  if (!target) return;
  getPanel(target).toggle();
}

export function destroyPanel(win: Window) {
  panels.get(win)?.destroy();
  panels.delete(win);
}

/**
 * The Prism AI section in the item pane.
 *
 * In a reader tab it behaves as the PDF sidebar: the conversation is bound to
 * the open document, with a selectable binding mode deciding how much of it
 * travels with every question. In the library it is bound to the selected item.
 */

import { config } from "../../../package.json";
import { clear, el } from "../../utils/dom";
import { bi, getLocaleID, getString } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
import { sessionFor, type Turn } from "./chat";
import { promptsFor, type PromptDef } from "./prompts";
import { injectAssets, renderConversation, routeLabel, saveTurnAsNote } from "./ui";
import {
  bestAttachment,
  currentReader,
  getPageTexts,
  metaBlock,
  readerAttachment,
  toRegularItem,
} from "../../utils/item";
import { writeAnswerAsAnnotation } from "./apps";
import { currentPageIndex } from "../../utils/reader";
import { icon16, icon20 } from "../../utils/icons";

type BindMode = "page" | "full" | "selection" | "meta" | "none";

const BIND_MODES: Array<{ id: BindMode; label: string }> = [
  { id: "page", label: bi("This page", "本页") },
  { id: "full", label: bi("Whole PDF", "全文") },
  { id: "selection", label: bi("Selection", "选中内容") },
  { id: "meta", label: bi("Metadata", "元数据") },
  { id: "none", label: bi("Chat only", "无上下文") },
];

export function registerLensSection() {
  const paneID = "prism-lens";
  const registered = Zotero.ItemPaneManager.registerSection({
    paneID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("section-lens"),
      icon: icon16("lens"),
    },
    sidenav: {
      l10nID: getLocaleID("section-lens-tooltip"),
      icon: icon20("lens"),
    },
    onRender: ({ body, item, setSectionSummary }) => {
      renderIfChanged(body, item);
      setSectionSummary(routeLabel());
    },
    onItemChange: ({ item, body, setEnabled }) => {
      setEnabled(!!item);
      if (item) renderIfChanged(body, item);
    },
  });
  // The key registerSection returns is namespaced; unregistering by our own
  // paneID found nothing, so the section outlived every disable and upgrade —
  // still running the old code — and the new version could not register its
  // own (panes.ts had the same bug).
  if (registered) addon.data.spectrum.sections.push(registered as string);
}

function sessionKeyFor(item: Zotero.Item | null): string {
  return `reader-${item?.key ?? "none"}`;
}

/**
 * Zotero re-renders item-pane sections often (scrolling, focus, saves).
 * Rebuilding then would throw away whatever the user was typing, so the pane is
 * only rebuilt when it is actually showing a different item.
 */
function renderIfChanged(body: HTMLElement, item: Zotero.Item | null) {
  const key = String(toRegularItem(item)?.key ?? item?.key ?? "");
  if (body.dataset.prismItem === key && body.firstChild) return;
  body.dataset.prismItem = key;
  render(body, item);
}

function render(body: HTMLElement, item: Zotero.Item | null) {
  const doc = body.ownerDocument;
  injectAssets(doc);
  clear(body);
  const target = toRegularItem(item) || item;
  if (!target) return;

  const session = sessionFor(sessionKeyFor(target));
  const pane = el(doc, "div", { class: "prism-pane prism-root" });

  /* binding mode + route */
  const modeRow = el(doc, "div", { class: "prism-row" });
  const current = getPref<BindMode>("lens.readerBindMode", "page");
  for (const mode of BIND_MODES) {
    modeRow.append(
      el(doc, "div", {
        class: "prism-tag",
        text: mode.label,
        attrs: { "data-active": mode.id === current ? "1" : "0" },
        style:
          mode.id === current
            ? { background: "var(--prism-accent)", color: "#fff" }
            : {},
        on: {
          click: () => {
            setPref("lens.readerBindMode", mode.id);
            render(body, item);
          },
        },
      }),
    );
  }
  pane.append(modeRow);

  /* quick commands */
  const commandRow = el(doc, "div", { class: "prism-tags" });
  const scope = currentReader() ? "sidebar" : "menu";
  for (const prompt of promptsFor(scope as any)) {
    commandRow.append(
      el(doc, "div", {
        class: "prism-tag",
        text: prompt.name,
        style: { color: prompt.color || "" },
        on: { click: () => void ask(body, target, "", prompt) },
      }),
    );
  }
  pane.append(commandRow);

  /* conversation */
  const conversation = el(doc, "div", {
    class: "prism-body",
    style: { maxHeight: "460px", padding: "4px 0" },
  });
  pane.append(conversation);

  /* input */
  const input = el(doc, "textarea", {
    class: "prism-input",
    attrs: { rows: "2", placeholder: getString("panel-ask-placeholder") },
  }) as HTMLTextAreaElement;
  const send = el(doc, "button", {
    class: "prism-send",
    text: "↵",
    on: {
      click: () => {
        const text = input.value.trim();
        input.value = "";
        void ask(body, target, text);
      },
    },
  });
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const text = input.value.trim();
      input.value = "";
      void ask(body, target, text);
    }
  });
  pane.append(el(doc, "div", { class: "prism-input-row" }, input, send));

  body.append(pane);
  paint(conversation, session, target);
}

function paint(container: HTMLElement, session: any, item: Zotero.Item) {
  renderConversation(container, session, {
    onSaveNote: (turn: Turn) => void saveTurnAsNote(turn, item),
    onAnnotate: (turn: Turn) => void writeAnswerAsAnnotation(turn.content),
  });
}

async function ask(
  body: HTMLElement,
  item: Zotero.Item,
  question: string,
  prompt?: PromptDef,
) {
  const session = sessionFor(sessionKeyFor(item));
  if (session.busy) {
    session.stop();
    return;
  }
  const container = body.querySelector(".prism-body") as HTMLElement;
  if (!question && !prompt) return;

  const reader = currentReader();
  const pageIndex = readerPageIndex(reader);
  const env = {
    question,
    item,
    items: [item],
    pageIndex,
    selection: readerSelection(reader),
  };

  const effective = prompt || (await bindingPrompt(item, pageIndex));
  await session.send(question, {
    prompt: effective,
    env,
    onUpdate: () => container && paint(container, session, item),
  });
  if (container) paint(container, session, item);
}

/** Turn the binding mode into an ad-hoc prompt carrying the right context. */
async function bindingPrompt(
  item: Zotero.Item,
  pageIndex: number,
): Promise<PromptDef | undefined> {
  const mode = getPref<BindMode>("lens.readerBindMode", "page");
  if (mode === "none") return undefined;
  const base: PromptDef = {
    id: `bind-${mode}`,
    name: mode,
    scope: ["sidebar"],
    context: "none",
    body: "",
  };
  if (mode === "meta") {
    return { ...base, body: `${metaBlock(item)}\n\nQuestion: \${P.question}` };
  }
  if (mode === "selection") {
    return {
      ...base,
      body: "Passage:\n${P.selection}\n\nQuestion: ${P.question}",
    };
  }
  if (mode === "full") {
    return {
      ...base,
      body:
        "Answer using the paper below, citing pages as (p. N).\n\nQuestion: ${P.question}\n\n--- PAPER ---\n${await P.fullText()}",
    };
  }
  const pages = await getPageTexts(item);
  const text = pages[pageIndex] || "";
  if (!text) return undefined;
  return {
    ...base,
    body: `Current page (p. ${pageIndex + 1}) of "${String(
      item.getField("title") || "",
    )}":\n\n${text}\n\nQuestion: \${P.question}`,
  };
}

export function readerPageIndex(reader?: _ZoteroTypes.ReaderInstance): number {
  return reader ? currentPageIndex(reader) : 0;
}

export function readerSelection(reader?: _ZoteroTypes.ReaderInstance): string {
  try {
    return reader ? ztoolkit.Reader.getSelectedText(reader) || "" : "";
  } catch {
    return "";
  }
}

/** The attachment a reader-bound action should act on. */
export async function activeAttachment(): Promise<Zotero.Item | null> {
  return readerAttachment() || (await bestAttachment(toRegularItem(null)));
}

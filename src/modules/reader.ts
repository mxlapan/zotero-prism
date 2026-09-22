/**
 * Everything Prism adds inside the PDF reader: the selection popup, a toolbar
 * menu, annotation context-menu entries, and the reading clock.
 */

import { config } from "../../package.json";
import { attachReaderShortcuts } from "./keys";
import { bi } from "../utils/locale";
import { el, injectStyle } from "../utils/dom";
import { getPref } from "../utils/prefs";
import { renderMarkdown } from "../lib/markdown";
import { promptsFor, renderPrompt, type PromptDef } from "./lens/prompts";
import { chat } from "./lens/provider";
import { translateText } from "./refract/engines";
import {
  adjust,
  clearReader,
  hasOverlay,
  isComparing,
  isShowingOriginal,
  toggleCompare,
  toggleOriginal,
  translateReader,
  translateToNote,
} from "./refract/fulltext";
import { createAnnotation } from "./lens/apps";

import { getItem, toRegularItem } from "../utils/item";
import { noteReadingEvent } from "./spectrum/reading";
import { currentPageIndex, pageCount, pdfDocument } from "../utils/reader";

const handlers: Array<[string, any]> = [];

// The xmlns matters: the reader shell is parsed as XML, where an <svg> with no
// namespace declaration is created as an XHTML element and paints nothing —
// which is exactly how a toolbar button turns into an empty square.
const SVG_NS = "http://www.w3.org/2000/svg";
const PRISM_MARK = `<svg xmlns="${SVG_NS}" viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"
     fill="none" stroke="currentColor" stroke-width="1.2"
     stroke-linecap="round" stroke-linejoin="round">
  <path d="M7.6 2.4 12.4 13.2H2.8Z"/>
  <path d="M0.4 8.2h4.3"/>
  <path d="M11 10.2h4.6"/>
</svg>`;

const READER_CSS = `
.prism-pop { display:flex; flex-wrap:wrap; gap:4px; padding:4px 0 2px; max-width:330px; }
.prism-pop button {
  border:1px solid rgba(127,127,127,.35); background:transparent; color:inherit;
  border-radius:6px; padding:2px 8px; font-size:12px; cursor:pointer;
}
.prism-pop button:hover { background:rgba(46,127,212,.16); }
.prism-pop-out {
  margin-top:5px; max-width:330px; max-height:250px; overflow:auto;
  font-size:12.5px; line-height:1.55; border-top:1px solid rgba(127,127,127,.25);
  padding-top:5px; white-space:pre-wrap;
}
.prism-pop-out p { margin:.3em 0; }
.prism-menu {
  position:absolute; z-index:2147483000; min-width:210px; padding:4px;
  background:var(--material-sidepane,#fff); color:var(--fill-primary,#111);
  border:1px solid rgba(127,127,127,.35); border-radius:9px;
  box-shadow:0 10px 30px rgba(0,0,0,.25);
}
.prism-menu div {
  padding:5px 9px; border-radius:6px; cursor:pointer; font-size:12.5px;
  display:flex; justify-content:space-between; gap:12px; white-space:nowrap;
}
.prism-menu div:hover { background:rgba(46,127,212,.16); }
.prism-menu hr { border:none; border-top:1px solid rgba(127,127,127,.25); margin:3px 0; }
/* The button carries Zotero's own .toolbar-button class as well, so size,
   colour and hover come from the reader's stylesheet and it cannot drift out
   of step with its neighbours. Only the icon box is ours. Painted at
   currentColor, which .toolbar-button sets to --fill-secondary — without that
   the mark came out near-black and twice the weight of Zotero's own icons. */
.prism-toolbar-btn { background:none; border:none; cursor:pointer; padding:0; }
.prism-toolbar-btn svg { width:20px; height:20px; flex:none; }
`;

export function registerReaderIntegration() {
  on("renderTextSelectionPopup", onSelectionPopup);
  on("renderToolbar", onToolbar);
  on("createAnnotationContextMenu", onAnnotationMenu);
  on("createViewContextMenu", onViewMenu);
  primeOpenReaders();
}

function on(type: string, handler: any) {
  try {
    Zotero.Reader.registerEventListener(type as any, handler, config.addonID);
    handlers.push([type, handler]);
  } catch (e) {
    Zotero.debug(`[Prism] could not hook reader event ${type}: ${e}`);
  }
}

export function unregisterReaderIntegration() {
  for (const [type, handler] of handlers.splice(0)) {
    try {
      Zotero.Reader.unregisterEventListener(type as any, handler);
    } catch {
      /* ignore */
    }
  }
  for (const reader of Zotero.Reader._readers || []) {
    try {
      clearReader(reader);
    } catch {
      /* ignore */
    }
    try {
      removeToolbarButton(reader);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The button (and its menu) belong to this instance of the plugin. Left behind
 * after a disable or an upgrade, the button kept running the old code, and the
 * new instance's sweep found a button already there and skipped that reader —
 * so its shortcuts were never bound either.
 */
function removeToolbarButton(reader: any) {
  const doc = reader?._iframeWindow?.document as Document | undefined;
  if (!doc) return;
  for (const button of Array.from(doc.querySelectorAll(".prism-toolbar-btn")) as Element[]) {
    const section = button.parentElement;
    button.remove();
    if (section?.classList.contains("section") && !section.childElementCount) section.remove();
  }
  for (const menu of Array.from(doc.querySelectorAll(".prism-menu")) as Element[]) menu.remove();
}

/* ------------------------------------------------------------ selection popup */

/** The Settings → Translation master switch. */
function refractOn() {
  return getPref<boolean>("enableRefract", true);
}

function onSelectionPopup(event: any) {
  if (!getPref<boolean>("refract.selectionPopup", true)) return;
  const { reader, doc, params, append } = event;
  const text: string = params?.annotation?.text || "";
  if (!text.trim()) return;
  injectStyle(doc, "prism-reader-css", READER_CSS);

  const container = el(doc, "div", { class: "prism-pop-wrap" });
  const row = el(doc, "div", { class: "prism-pop" });
  const output = el(doc, "div", { class: "prism-pop-out", style: { display: "none" } });

  const show = (html: string) => {
    output.style.display = "block";
    output.innerHTML = html;
  };

  if (refractOn()) row.append(
    el(doc, "button", {
      text: bi("Translate", "翻译"),
      on: {
        click: async () => {
          show(`<p>${bi("translating…", "正在翻译…")}</p>`);
          try {
            show(
              `<p>${escape(await translateText(text))}</p>`,
            );
          } catch (e: any) {
            show(`<p style="color:#d64d4d">${escape(String(e?.message || e))}</p>`);
          }
        },
      },
    }),
  );

  for (const prompt of promptsFor("selection")) {
    if (prompt.id === "translate") continue;
    row.append(
      el(doc, "button", {
        text: prompt.name,
        on: {
          click: () => void runPrompt(prompt, text, reader, show),
        },
      }),
    );
  }

  row.append(
    el(doc, "button", {
      text: bi("Ask", "追问"),
      on: {
        click: () => {
          const question = doc.defaultView?.prompt(
            bi("Ask about the selection:", "针对选中内容提问："),
          );
          if (!question) return;
          void runPrompt(
            {
              id: "ad-hoc",
              name: "ask",
              scope: ["selection"],
              context: "selection",
              body: `Passage:\n\${P.selection}\n\nQuestion: ${question}`,
            },
            text,
            reader,
            show,
          );
        },
      },
    }),
  );

  container.append(row, output);
  append(container);
}

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function runPrompt(
  prompt: PromptDef,
  selection: string,
  reader: any,
  show: (html: string) => void,
) {
  show(`<p>${bi("thinking…", "思考中…")}</p>`);
  try {
    const item = toRegularItem(getItem(reader.itemID));
    const rendered = await renderPrompt(prompt, { selection, item });
    let answer = "";
    await chat([{ role: "user", content: rendered.text }], {
      onToken: (_delta, whole) => {
        answer = whole;
        show(renderMarkdown(whole));
      },
    });
    show(renderMarkdown(answer));
    if (getPref<boolean>("lens.annotationWriteBack", false)) {
      const attachment = getItem(reader.itemID);
      if (attachment) {
        await createAnnotation(attachment, {
          pageIndex: currentPage(reader),
          quote: selection,
          comment: answer.slice(0, 3000),
          color: "#a28ae5",
          tags: ["prism/answer"],
        });
      }
    }
  } catch (e: any) {
    show(`<p style="color:#d64d4d">${escape(String(e?.message || e))}</p>`);
  }
}

function currentPage(reader: any): number {
  return currentPageIndex(reader);
}

/* ------------------------------------------------------------------- toolbar */

function onToolbar(event: any) {
  const { reader, doc, append } = event;
  append(toolbarButton(reader, doc));
  bindReaderKeys(reader, doc);
}

/**
 * The shortcuts, in every document this reader can put the focus in.
 *
 * The toolbar renders before the PDF frame exists, and that frame is the one a
 * key press actually lands in — events do not cross an iframe boundary. The
 * toolbar does not reliably render again once the frame is up, so this retries
 * until the page document appears, then stops. `attachReaderShortcuts` is
 * idempotent, so the repeats cost nothing.
 */
function bindReaderKeys(reader: any, doc: Document, attempt = 0) {
  for (const target of clickTargets(reader, doc)) {
    try {
      attachReaderShortcuts(target);
    } catch (e) {
      Zotero.debug(`[Prism] could not bind reader shortcuts: ${e}`);
    }
  }
  let pdf: Document | null = null;
  try {
    pdf = pdfDocument(reader);
  } catch {
    /* not a PDF, or not rendered yet */
  }
  if (pdf || attempt >= 20) return;
  doc.defaultView?.setTimeout(() => bindReaderKeys(reader, doc, attempt + 1), 500);
}


/** The toolbar button, wired up. Shared by the event and the startup sweep. */
function toolbarButton(reader: any, doc: Document): HTMLElement {
  injectStyle(doc, "prism-reader-css", READER_CSS);
  // An inline mark rather than a Unicode glyph: the reader's font does not
  // necessarily carry one, and a missing glyph reads as a broken empty button.
  // It also carries Zotero's own .toolbar-button class so size, colour and
  // hover come from the reader's stylesheet.
  const button = el(doc, "button", {
    class: "toolbar-button prism-toolbar-btn",
    title: "Zotero Prism",
    attrs: { "aria-label": "Zotero Prism", tabindex: "-1" },
    html: PRISM_MARK,
  });
  // If the mark did not survive parsing there is nothing to look at, so fall
  // back to a word. A labelled button is ugly; an empty one looks broken.
  if (!button.getElementsByTagNameNS(SVG_NS, "svg").length) {
    button.textContent = "Prism";
    Zotero.debug("[Prism] reader toolbar: inline SVG did not parse, using text");
  }
  // Three ways in, because the reader toolbar swallows pointer events to keep
  // its own tool state: `click` alone needed a double press (the first one is
  // spent moving focus out of the PDF frame) and `mousedown` alone never
  // arrived at all. Whichever fires first wins; the debounce keeps one press
  // from toggling twice.
  let lastToggle = 0;
  const toggle = (event: MouseEvent) => {
    if (event.button) return; // left button only
    const now = Date.now();
    if (now - lastToggle < 300) return;
    lastToggle = now;
    event.stopPropagation();
    Zotero.debug(`[Prism] toolbar button: ${event.type}`);
    if (menuIsOpen(doc)) closeToolbarMenu(doc);
    else openToolbarMenu(reader, doc, button);
  };
  for (const type of ["pointerdown", "mousedown", "click"]) {
    button.addEventListener(type, toggle as EventListener);
  }
  return button;
}

/**
 * Tabs restored at startup have already drawn their toolbar by the time the
 * plugin registers, and `renderToolbar` only fires when the toolbar renders —
 * so on every launch those tabs came up without the button. Put it in by hand
 * for readers that already exist. The reader clears this container on its next
 * render, but that same render re-fires the event, so the button comes back
 * through the normal path.
 */
function primeOpenReaders() {
  for (const reader of (Zotero.Reader as any)._readers || []) {
    try {
      const doc = reader?._iframeWindow?.document as Document | undefined;
      const slot = doc?.querySelector(".toolbar .end .custom-sections");
      if (!doc || !slot || slot.querySelector(".prism-toolbar-btn")) continue;
      const section = doc.createElement("div");
      section.className = "section";
      section.append(toolbarButton(reader, doc));
      slot.append(section);
      bindReaderKeys(reader, doc);
      Zotero.debug("[Prism] toolbar button added to an already-open reader");
    } catch (e) {
      Zotero.debug(`[Prism] could not prime an open reader: ${e}`);
    }
  }
}

/**
 * Every document a click could land in.
 *
 * The reader is a shell document with the rendered PDF in a child frame, so a
 * listener on the shell alone never sees a click on the page itself — which is
 * why the menu could not be dismissed by clicking the document.
 */
function clickTargets(reader: any, doc: Document): Document[] {
  // The same document reaches us through more than one wrapper — the frames
  // walk below and `pdfDocument()` return different objects for the PDF frame —
  // so a Set of them deduplicates nothing and every listener gets added twice.
  const canonical = (target: Document): Document =>
    ((target as any)?.wrappedJSObject ?? target) as Document;
  const docs = new Set<Document>([canonical(doc)]);
  try {
    const pdf = pdfDocument(reader);
    if (pdf) docs.add(canonical(pdf));
  } catch {
    /* not a PDF, or not rendered yet */
  }
  try {
    const frames = doc.defaultView?.frames;
    for (let i = 0; i < (frames?.length || 0); i++) {
      try {
        const child = frames?.[i]?.document;
        if (child) docs.add(canonical(child));
      } catch {
        /* cross-origin frame */
      }
    }
  } catch {
    /* no view */
  }
  return [...docs];
}

let dismissMenu: (() => void) | null = null;

function menuIsOpen(doc: Document): boolean {
  return !!doc.querySelector(".prism-menu");
}

function closeToolbarMenu(doc: Document) {
  dismissMenu?.();
  doc.querySelector(".prism-menu")?.remove();
}

/* The menu rows, as data, so the native popup and the fallback agree. */
type MenuRow = "sep" | { label: string; hint?: string; run: () => void };

function toolbarRows(reader: any): MenuRow[] {
  const translated = hasOverlay(reader);
  const rows: MenuRow[] = [];
  // Refract is one of the four modules a user can switch off in Settings, so
  // everything translation-related has to check it — the toggle used to be
  // read by nothing at all.
  if (refractOn()) rows.push(
    {
      label: translated
        ? isShowingOriginal(reader)
          ? bi("Show translation", "显示译文")
          : bi("Show original", "显示原文")
        : bi("Translate full text", "全文翻译"),
      hint: getPref<string>("refract.engine", "google"),
      run: () => {
        if (translated) toggleOriginal(reader);
        else void translateReader(reader);
      },
    },
  );
  if (refractOn() && translated) {
    rows.push(
      { label: bi("Font larger", "字号增大"), hint: "A+", run: () => adjust(reader, "font", 1) },
      { label: bi("Font smaller", "字号减小"), hint: "A-", run: () => adjust(reader, "font", -1) },
      { label: bi("Line spacing +", "行距增大"), run: () => adjust(reader, "line", 0.1) },
      { label: bi("Line spacing -", "行距减小"), run: () => adjust(reader, "line", -0.1) },
      {
        label: isComparing(reader)
          ? bi("Close side-by-side", "关闭并排对照")
          : bi("Side-by-side original", "并排对照原文"),
        run: () => {
          void toggleCompare(reader).catch((e: any) =>
            new ztoolkit.ProgressWindow(config.addonName)
              .createLine({ text: String(e?.message || e), type: "fail" })
              .show(4000),
          );
        },
      },
      { label: bi("Remove translation", "移除翻译"), run: () => clearReader(reader) },
    );
  }
  if (refractOn()) {
    rows.push("sep", {
      label: bi("Bilingual note", "生成双语对照笔记"),
      hint: "md",
      run: async () => {
        const attachment = getItem(reader.itemID);
        const item = toRegularItem(attachment);
        if (item && attachment) await translateToNote(item, attachment, reader);
      },
    });
  }
  rows.push(
    "sep",
    {
      label: bi("Ask Prism", "向棱镜提问"),
      hint: "Ctrl+/",
      run: () => {
        const win = Zotero.getMainWindow() as unknown as Window;
        void import("./lens/panel").then((mod) => mod.togglePanel(win));
      },
    },
    {
      label: bi("AI outline → note", "AI 大纲 → 笔记"),
      run: async () => {
        const item = toRegularItem(getItem(reader.itemID));
        if (item) (await import("./lens/apps")).aiOutline([item]);
      },
    },
    {
      label: bi("AI annotate this PDF", "AI 标注本文"),
      run: async () => {
        const item = toRegularItem(getItem(reader.itemID));
        if (item) (await import("./lens/apps")).aiAnnotate(item);
      },
    },
  );
  return rows;
}

function openToolbarMenu(reader: any, doc: Document, anchor: HTMLElement) {
  closeToolbarMenu(doc);
  try {
    openMenu(toolbarRows(reader), reader, doc, anchor);
  } catch (e) {
    Zotero.debug(`[Prism] toolbar menu failed: ${e}`);
  }
}

/**
 * The menu, built by hand in the reader's own document.
 *
 * A real XUL <menupopup> would be less work, but the reader toolbar lives in
 * an HTML document that cannot host one: Zotero 10 answers openPopupAtScreen
 * with NS_ERROR_NOT_AVAILABLE ("Component is not available"), so every open
 * paid for a thrown exception before falling back here anyway.
 */
function openMenu(
  rows: MenuRow[],
  reader: any,
  doc: Document,
  anchor: HTMLElement,
) {
  const menu = el(doc, "div", { class: "prism-menu" });
  const rect = anchor.getBoundingClientRect();
  for (const row of rows) {
    if (row === "sep") {
      menu.append(el(doc, "hr"));
      continue;
    }
    menu.append(
      el(
        doc,
        "div",
        { on: { click: () => { menu.remove(); row.run(); } } },
        el(doc, "span", { text: row.label }),
        el(doc, "span", { text: row.hint || "", style: { opacity: "0.55" } }),
      ),
    );
  }

  (doc.body || doc.documentElement).append(menu);
  const width = menu.getBoundingClientRect().width || 210;
  const limit = (doc.documentElement?.clientWidth || width + 14) - width - 8;
  menu.style.left = `${Math.max(6, Math.min(rect.left - 60, limit))}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  Zotero.debug(`[Prism] toolbar menu: ${rows.length} rows`);

  const docs = clickTargets(reader, doc);
  const onDown = (event: Event) => {
    if (menu.contains(event.target as Node)) return;
    if (anchor.contains(event.target as Node)) return; // the button toggles
    close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  const close = () => {
    dismissMenu = null;
    menu.remove();
    for (const target of docs) {
      target.removeEventListener("mousedown", onDown, true);
      target.removeEventListener("keydown", onKey, true);
    }
  };
  for (const target of docs) {
    target.addEventListener("mousedown", onDown, true);
    target.addEventListener("keydown", onKey, true);
  }
  dismissMenu = close;
}

/* ----------------------------------------------------------- context menus */

function onAnnotationMenu(event: any) {
  const { reader, params, append } = event;
  const ids: string[] = params?.ids || [];
  if (!ids.length) return;
  append({
    label: bi("Prism: explain", "棱镜：解释这条标注"),
    onCommand: () => void explainAnnotations(reader, ids),
  });
  append({
    label: bi("Prism: translate comment", "棱镜：翻译这条标注"),
    onCommand: () => void translateAnnotations(reader, ids),
  });
}

async function annotationsOf(reader: any, keys: string[]): Promise<Zotero.Item[]> {
  const attachment = getItem(reader.itemID);
  // getAnnotations() throws on anything that is not a file attachment, and the
  // reader opens more than PDFs.
  if (!attachment?.isFileAttachment?.()) return [];
  try {
    return (attachment.getAnnotations() as Zotero.Item[]).filter((a) =>
      keys.includes(a.key),
    );
  } catch (e) {
    Zotero.debug(`[Prism] could not read annotations of ${attachment.id}: ${e}`);
    return [];
  }
}

async function explainAnnotations(reader: any, keys: string[]) {
  const annotations = await annotationsOf(reader, keys);
  const text = annotations
    .map((a) => `${a.annotationText || ""} ${a.annotationComment || ""}`)
    .join("\n\n");
  if (!text.trim()) return;
  const answer = await chat([
    {
      role: "user",
      content: `Explain these highlighted passages in plain language and say why a researcher would mark them.\n\n${text}`,
    },
  ]);
  for (const annotation of annotations) {
    annotation.annotationComment = `${annotation.annotationComment || ""}\n\n[Prism] ${answer}`.trim();
    await annotation.saveTx();
  }
}

async function translateAnnotations(reader: any, keys: string[]) {
  const annotations = await annotationsOf(reader, keys);
  for (const annotation of annotations) {
    const source = annotation.annotationText || annotation.annotationComment || "";
    if (!source.trim()) continue;
    const translated = await translateText(source);
    annotation.annotationComment = `${annotation.annotationComment || ""}\n${translated}`.trim();
    await annotation.saveTx();
  }
}

function onViewMenu(event: any) {
  const { reader, append } = event;
  append({
    label: hasOverlay(reader)
      ? bi("Prism: toggle original", "棱镜：切换原文 / 译文")
      : bi("Prism: translate full text", "棱镜：全文翻译"),
    onCommand: () =>
      hasOverlay(reader) ? toggleOriginal(reader) : void translateReader(reader),
  });
}

/* --------------------------------------------------------------- reading clock */

const pollers = new Map<Window, number>();

/** Poll the active reader for its page so reading time lands on the right page. */
export function startReadingClock(win: Window) {
  if (pollers.has(win)) return;
  const id = win.setInterval(() => {
    for (const reader of Zotero.Reader._readers || []) {
      try {
        if (!reader?.itemID) continue;
        const page = currentPageIndex(reader);
        const focused = isReaderActive(reader);
        noteReadingEvent(
          reader._instanceID,
          reader.itemID,
          page,
          focused,
          pageCount(reader),
        );
      } catch {
        /* reader closing */
      }
    }
  }, 5000);
  pollers.set(win, id);
}

export function stopReadingClock(win: Window) {
  const id = pollers.get(win);
  if (id === undefined) return;
  try {
    win.clearInterval(id);
  } catch {
    /* window already gone */
  }
  pollers.delete(win);
}

function isReaderActive(reader: any): boolean {
  try {
    if (reader._window && reader._window !== Zotero.getMainWindow()) {
      return !!reader._window.document?.hasFocus?.();
    }
    const win = Zotero.getMainWindow();
    return (
      !!win?.document?.hasFocus?.() && win.Zotero_Tabs?.selectedID === reader.tabID
    );
  } catch {
    return false;
  }
}


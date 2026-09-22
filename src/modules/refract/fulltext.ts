/**
 * In-reader full-text translation.
 *
 * The translated paragraphs are laid back over the page at the position of the
 * original text, so the figures, equations and page numbering you already know
 * stay exactly where they were. Ctrl/Cmd-click any block to reveal the source.
 */

import { config } from "../../../package.json";
import { getPref, setPref } from "../../utils/prefs";
import { bi } from "../../utils/locale";
import { translateBatch } from "./engines";
import {
  continuesInto,
  flowIntoLines,
  joinContinuation,
  readingOrder,
  runsFromTextContent,
  splitAcross,
  textEm,
  toLines,
  toParagraphs,
  type Paragraph,
} from "./layout";
import { escapeHTML, splitSentences } from "../../utils/text";
import { pageText, pdfApp, pdfDocument, pdfReady, pageViews, unwrap } from "../../utils/reader";
import { openProgress } from "../../utils/progress";
import { revealNotes } from "../../utils/item";
import { sleep } from "../../utils/window";

/** How far below the baseline a descender reaches, as a fraction of the size. */
const DESCENDER = 0.26;

interface Block {
  box: [number, number, number, number];
  /** the original line boxes, in PDF space, top line first */
  lines: Array<[number, number, number, number]>;
  original: string;
  translated: string;
  fontSize: number;
  kind: Paragraph["kind"];
}

interface Overlay {
  readerID: string;
  itemID: number;
  pages: Map<number, Block[]>;
  showOriginal: boolean;
  listener?: (event: any) => void;
  cancelled: boolean;
}

const OVERLAY_CSS = `
.prism-tr-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
}
.prism-tr-block {
  position: absolute;
  pointer-events: auto;
  overflow: hidden;
  box-sizing: border-box;
  color: #101114;
  background: var(--prism-tr-bg, #ffffff);
  cursor: text;
  transition: opacity .12s ease;
  /* A paper is set in a serif face; matching it is most of the difference
     between "translated PDF" and "web page pasted over a PDF". */
  font-family: "Times New Roman", "Source Han Serif SC", "Noto Serif CJK SC",
               "Songti SC", SimSun, serif;
}
.prism-tr-flow {
  padding: 0 1px;
  white-space: pre-wrap;
  word-break: break-word;
}
.prism-tr-line {
  position: absolute;
  white-space: nowrap;
  overflow: hidden;
}
.prism-tr-block[data-kind="heading"] { font-weight: 650; }
.prism-tr-layer[data-original="1"] .prism-tr-block { opacity: 0; pointer-events: none; }
.prism-tr-block:hover { box-shadow: 0 0 0 1px rgba(46,127,212,.55); }
.prism-tr-block.prism-tr-peek { opacity: .12; }
.prism-tr-tip {
  position: fixed;
  z-index: 2147483000;
  max-width: 460px;
  padding: 7px 9px;
  border-radius: 8px;
  background: #1f2126;
  color: #f2f3f5;
  font-size: 12.5px;
  line-height: 1.55;
  box-shadow: 0 8px 26px rgba(0,0,0,.34);
  pointer-events: none;
  white-space: pre-wrap;
}
.prism-tr-tip[hidden] { display: none; }
`;

function app(reader: any): any {
  return pdfApp(reader);
}

/** The document the PDF pages live in — not the reader shell. */
function viewerDoc(reader: any): Document | null {
  return pdfDocument(reader);
}

function overlayFor(reader: any): Overlay | undefined {
  return addon.data.refract.overlays.get(reader?._instanceID);
}

export function hasOverlay(reader: any): boolean {
  return !!overlayFor(reader)?.pages.size;
}

export function isShowingOriginal(reader: any): boolean {
  return !!overlayFor(reader)?.showOriginal;
}

function injectCSS(doc: Document) {
  if (doc.getElementById("prism-tr-css")) return;
  const style = doc.createElement("style");
  style.id = "prism-tr-css";
  style.textContent = OVERLAY_CSS;
  (doc.head || doc.documentElement).append(style);
}

/** Extract every paragraph of the document, page by page. */
async function collect(
  reader: any,
  viewer: any,
  onProgress: (done: number, total: number) => void,
  shouldStop: () => boolean,
): Promise<{ pages: Map<number, Paragraph[]>; widths: Map<number, number> }> {
  const result = new Map<number, Paragraph[]>();
  const widths = new Map<number, number>();
  const total = viewer.pdfDocument.numPages;
  const skipReferences = getPref<boolean>("refract.skipReferences", true);
  const skipCaptions = getPref<boolean>("refract.skipCaptions", false);
  const keepFormulas = getPref<boolean>("refract.keepFormulas", true);
  const bodyOnly = getPref<boolean>("refract.bodyOnly", true);
  // The reference list runs from wherever it starts to the end of the paper.
  const state = { inReferences: false };
  let extracted = 0;
  for (let index = 0; index < total; index++) {
    if (shouldStop()) break;
    const page = await pageText(reader, viewer, index);
    onProgress(index + 1, total);
    if (!page) continue;
    extracted++;
    const runs = runsFromTextContent({ items: page.items });
    widths.set(index, page.width);
    result.set(
      index,
      toParagraphs(toLines(runs, page.width), page.width, {
        skipReferences,
        skipCaptions,
        keepFormulas,
        bodyOnly,
        pageHeight: page.height,
        firstPage: index === 0,
        state,
      }),
    );
  }
  if (!extracted && total) {
    throw new Error(
      bi(
        "Could not read text from this PDF — it may be a scan.",
        "无法读取该 PDF 的文字，可能为扫描件。",
      ),
    );
  }
  return { pages: result, widths };
}

/**
 * Pair a paragraph with its translation, sentence by sentence when asked.
 *
 * Magic's "sentence / paragraph" switch decides how fine the bilingual note's
 * citations are. Doing it by translating each sentence separately is what it
 * looks like it should be, and it is a trap: the free engines take one string
 * per request, so a 12-page paper went from ~150 requests to 946 and Google
 * throttled it to a crawl — measured, not guessed. The request stays one per
 * paragraph; the pairing is done afterwards, and falls back to the whole
 * paragraph whenever the two sides do not split into the same number of parts.
 */
function alignPairs(original: string, translated: string): Array<[string, string]> {
  if (getPref<string>("refract.alignment", "paragraph") !== "sentence") {
    return [[original, translated]];
  }
  const left = splitSentences(original);
  const right = splitSentences(translated);
  if (left.length < 2 || left.length !== right.length) return [[original, translated]];
  return left.map((text, index) => [text, right[index]] as [string, string]);
}

export async function translateReader(
  reader: any,
  options: { engine?: string; to?: string } = {},
) {
  const viewer = await pdfReady(reader);
  if (!viewer?.pdfDocument) {
    throw new Error(
      bi(
        "Full-text translation needs an open PDF.",
        "请先在阅读器中打开 PDF。",
      ),
    );
  }

  const existing = overlayFor(reader);
  if (existing) clearReader(reader);

  const overlay: Overlay = {
    readerID: reader._instanceID,
    itemID: reader.itemID,
    pages: new Map(),
    showOriginal: false,
    cancelled: false,
  };
  addon.data.refract.overlays.set(reader._instanceID, overlay);

  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: false,
  })
    .createLine({
      text: bi("Reading layout…", "正在解析排版…"),
      progress: 0,
      type: "default",
    })
    .show(-1);

  try {
    const { pages: paragraphs, widths: pageWidths } = await collect(
      reader,
      viewer,
      (done, total) =>
        progress.changeLine({
          text: `${bi("Reading layout", "正在解析排版")} ${done}/${total}`,
          progress: (done / total) * 35,
        }),
      () => overlay.cancelled,
    );
    if (overlay.cancelled) return;

    /* Reading order, so a paragraph cut by a column or a page break can be put
       back together before it is sent anywhere. */
    const flat: Array<{ page: number; paragraph: Paragraph }> = [];
    for (const [page, list] of [...paragraphs.entries()].sort((a, b) => a[0] - b[0])) {
      for (const paragraph of readingOrder(list, pageWidths.get(page) || 612)) {
        flat.push({ page, paragraph });
      }
    }
    if (!flat.length) {
      progress.changeLine({
        text: bi("No translatable text found.", "没有找到可翻译的文本。"),
        type: "fail",
      });
      progress.startCloseTimer(4000);
      return;
    }

    /* One request per sentence-complete unit, which may span two fragments. */
    const units: Array<{ text: string; parts: number[] }> = [];
    flat.forEach((entry, index) => {
      const open = units[units.length - 1];
      const previous = open ? flat[open.parts[open.parts.length - 1]] : null;
      if (
        open &&
        previous &&
        open.parts.length < 3 &&
        previous.paragraph.kind === "body" &&
        entry.paragraph.kind === "body" &&
        entry.page - previous.page <= 1 &&
        continuesInto(open.text, entry.paragraph.text)
      ) {
        open.text = joinContinuation(open.text, entry.paragraph.text);
        open.parts.push(index);
        return;
      }
      units.push({ text: entry.paragraph.text, parts: [index] });
    });

    const byUnit = await translateBatch(
      units.map((unit) => unit.text),
      {
        engine: options.engine,
        to: options.to,
        shouldStop: () => overlay.cancelled,
        onEngineSwitch: (from, next) =>
          progress.changeLine({ text: `${bi("Engine", "切换引擎：")} ${from} → ${next}` }),
        onProgress: (done, total) =>
          progress.changeLine({
            text: `${bi("Translating", "正在翻译")} ${done}/${total}`,
            progress: 35 + (done / total) * 65,
          }),
      },
    );
    if (overlay.cancelled) return;

    // Back onto the fragments the page actually has room for.
    const translated: string[] = new Array(flat.length).fill("");
    units.forEach((unit, index) => {
      const pieces = splitAcross(
        byUnit[index] || "",
        unit.parts.map((part) => flat[part].paragraph.text.length),
      );
      unit.parts.forEach((part, k) => {
        translated[part] = pieces[k] || "";
      });
    });

    flat.forEach((entry, index) => {
      const text = translated[index];
      if (!text || text === entry.paragraph.text) return;
      const blocks = overlay.pages.get(entry.page) || [];
      blocks.push({
        // PDF geometry is measured from the baseline, so a box that starts
        // there misses every descender: the tails of g, y and p stayed on the
        // page under the translation and read as dirt. A quarter of the font
        // size below the baseline covers them.
        box: [
          entry.paragraph.box[0],
          entry.paragraph.box[1] - entry.paragraph.fontSize * DESCENDER,
          entry.paragraph.box[2],
          entry.paragraph.box[3],
        ],
        lines: entry.paragraph.lines.map(
          (line) =>
            [
              line.x,
              (line.bottom ?? line.y) - line.height * DESCENDER,
              line.x + line.width,
              line.top ?? line.y + line.height,
            ] as [number, number, number, number],
        ),
        original: entry.paragraph.text,
        translated: text,
        fontSize: entry.paragraph.fontSize,
        kind: entry.paragraph.kind,
      });
      overlay.pages.set(entry.page, blocks);
    });

    for (const blocks of overlay.pages.values()) separate(blocks);
    attach(reader, overlay);
    progress.changeLine({
      text: bi("Translation applied", "翻译完成"),
      progress: 100,
      type: "success",
    });
    progress.startCloseTimer(2500);
  } catch (e: any) {
    progress.changeLine({ text: `${bi("Failed: ", "失败：")}${e?.message || e}`, type: "fail" });
    progress.startCloseTimer(6000);
    throw e;
  }
}

/**
 * Keep the blocks of a page off each other.
 *
 * Every block paints an opaque white box, so one whose top reaches into the
 * block above it does not merely sit close — it *erases* the bottom of that
 * one's translation, and what is left looks like a rendering fault. The page
 * geometry can genuinely say this (a dropped subscript, a hanging accent), so
 * the boxes are trimmed here rather than trusted.
 */
function separate(blocks: Block[]) {
  const sorted = [...blocks].sort((a, b) => b.box[3] - a.box[3]);
  for (let i = 0; i < sorted.length; i++) {
    const block = sorted[i];
    for (let j = 0; j < i; j++) {
      const above = sorted[j];
      const shared =
        Math.min(block.box[2], above.box[2]) - Math.max(block.box[0], above.box[0]);
      const narrower = Math.min(block.box[2] - block.box[0], above.box[2] - above.box[0]);
      if (shared <= narrower * 0.3) continue; // a different column
      const floor = above.box[1];
      if (block.box[3] <= floor) continue;
      block.box[3] = Math.max(block.box[1], floor);
      block.lines = block.lines.map(
        (line) =>
          [line[0], line[1], line[2], Math.min(line[3], floor)] as [
            number,
            number,
            number,
            number,
          ],
      );
    }
    block.lines = block.lines.filter((line) => line[3] - line[1] > 2);
  }
}

function attach(reader: any, overlay: Overlay) {
  const viewer = app(reader);
  const doc = viewerDoc(reader);
  if (!doc) return;
  injectCSS(doc);

  const paint = () => {
    for (const pageView of pageViews(reader)) {
      renderPage(pageView, overlay, doc);
    }
  };
  paint();

  overlay.listener = () => paint();
  try {
    viewer.eventBus?.on("pagerendered", overlay.listener);
    viewer.eventBus?.on("scalechanging", overlay.listener);
  } catch {
    /* older viewer */
  }

  // Zotero remembers a reader's split across restarts, so the panes can already
  // be side by side without anyone having touched our menu row. The listener
  // checks the split itself, so attaching it with the overlay is enough.
  syncSecondView(reader);
}

/**
 * A PDF-space box in viewport pixels.
 *
 * `viewport.convertToViewportRectangle()` is the documented call, but Zotero 10
 * runs the PDF viewer in an unprivileged iframe. An array built on this side of
 * the compartment boundary arrives there as an opaque wrapper, so the call threw
 * on `rect[0]` and every page was left unpainted. Reading the six transform
 * numbers out of the viewport is allowed in that direction, so the affine
 * transform is applied here instead.
 */
function viewportRect(
  viewport: any,
  box: number[],
): { left: number; top: number; width: number; height: number } {
  const t = viewport.transform;
  const at = (x: number, y: number): [number, number] => [
    t[0] * x + t[2] * y + t[4],
    t[1] * x + t[3] * y + t[5],
  ];
  const [ax, ay] = at(box[0], box[1]);
  const [bx, by] = at(box[2], box[3]);
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

function renderPage(pageView: any, overlay: Overlay, doc: Document) {
  const index = (pageView.id ?? 1) - 1;
  const blocks = overlay.pages.get(index);
  const host: HTMLElement = pageView.div;
  if (!host) return;
  // The block under the pointer is about to be destroyed; its mouseleave will
  // never fire.
  hideTip(doc);
  host.querySelector(".prism-tr-layer")?.remove();
  if (!blocks?.length || !pageView.viewport) return;

  const layer = doc.createElement("div");
  layer.className = "prism-tr-layer";
  layer.dataset.original = overlay.showOriginal ? "1" : "0";

  const scale = pageView.viewport.scale || 1;
  const fontScale = Number(getPref("refract.fontSize", 15)) / 15;
  const lineHeight = Number(getPref("refract.lineHeight", 1.5));
  const fontFamily = getPref<string>("refract.fontFamily", "");
  const hover = getPref<boolean>("refract.hoverOriginal", true);

  for (const block of blocks) {
    const rect = viewportRect(pageView.viewport, block.box);
    if (rect.width < 8 || rect.height < 5) continue;

    const node = doc.createElement("div");
    node.className = "prism-tr-block";
    node.dataset.kind = block.kind;
    // Cover a shade more than the text box: ascenders and descenders of the
    // original poke out of an exact fit and read as dirt on the page.
    node.style.left = `${rect.left - PAD_X}px`;
    node.style.top = `${rect.top - PAD_Y}px`;
    node.style.width = `${rect.width + PAD_X * 2}px`;
    node.style.height = `${rect.height + PAD_Y * 2}px`;
    if (fontFamily) node.style.fontFamily = fontFamily;
    if (!hover) node.title = block.original;

    const base = Math.max(6, block.fontSize * scale * 0.96 * fontScale);
    const lineRects = block.lines
      .map((line) => viewportRect(pageView.viewport, line))
      .filter((line) => line.width > 4)
      .sort((a, b) => a.top - b.top);

    if (lineRects.length) {
      paintLines(doc, node, block, lineRects, rect, base);
    } else {
      // No line geometry (shouldn't happen) — fall back to wrapped text.
      const flow = doc.createElement("div");
      flow.className = "prism-tr-flow";
      flow.textContent = block.translated;
      flow.style.fontSize = `${base}px`;
      flow.style.lineHeight = String(lineHeight);
      node.append(flow);
    }

    node.addEventListener("click", (event: MouseEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      node.classList.toggle("prism-tr-peek");
    });
    if (hover) attachTip(node, block.original, doc);
    layer.append(node);
  }
  host.append(layer);

  // Whatever the estimator got wrong shows up here as a line wider than its
  // box; one step smaller and a re-flow fixes it.
  for (const node of Array.from(layer.children) as HTMLElement[]) {
    refit(node);
  }
}

const PAD_X = 1.5;
const PAD_Y = 2;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Lay the translation out on the original's own lines.
 *
 * Each line box keeps its position, width and height, so an indented first
 * line stays indented, a centred heading stays centred, and a paragraph that
 * ends mid-line still ends mid-line. The font size starts at the original's and
 * only shrinks if the translation genuinely needs more room than the paragraph
 * has.
 */
function paintLines(
  doc: Document,
  node: HTMLElement,
  block: Block,
  lineRects: Rect[],
  box: Rect,
  base: number,
) {
  let size = base;
  let flowed = flowIntoLines(
    block.translated,
    lineRects.map((line) => line.width / size),
  );
  // Chinese is shorter than English far more often than not, so this rarely
  // runs; when it does, eight steps take the text to 60% of the original size.
  for (let step = 0; flowed.rest && step < 8; step++) {
    size *= 0.94;
    flowed = flowIntoLines(
      block.translated,
      lineRects.map((line) => line.width / size),
    );
  }
  if (flowed.rest && flowed.lines.length) {
    // Still too long: the tail joins the last line, which clips rather than
    // spilling over the paragraph below it.
    flowed.lines[flowed.lines.length - 1] += flowed.rest;
  }

  node.dataset.size = String(size);
  lineRects.forEach((line, i) => {
    const text = flowed.lines[i];
    if (!text) return;
    const el = doc.createElement("div");
    el.className = "prism-tr-line";
    el.textContent = text;
    el.style.left = `${line.left - box.left + PAD_X}px`;
    el.style.top = `${line.top - box.top + PAD_Y}px`;
    el.style.width = `${line.width}px`;
    el.style.height = `${line.height}px`;
    el.style.lineHeight = `${line.height}px`;
    el.style.fontSize = `${size}px`;
    // Justify the way the column is justified, but only by closing a small
    // gap — stretched-out Latin words look worse than a ragged edge.
    const used = textEm(text) * size;
    const slack = line.width - used;
    const gaps = Math.max(1, [...text].length - 1);
    if (i < flowed.lines.length - 1 && slack > 0 && slack / line.width < 0.18) {
      el.style.letterSpacing = `${Math.min(slack / gaps, size * 0.12).toFixed(2)}px`;
    }
    node.append(el);
  });
}

/** Shrink a block whose lines came out wider than the estimate expected. */
function refit(node: HTMLElement) {
  const lines = Array.from(node.querySelectorAll(".prism-tr-line")) as HTMLElement[];
  if (!lines.length) {
    // the wrapped fallback: shrink until it fits the box
    const flow = node.querySelector(".prism-tr-flow") as HTMLElement | null;
    if (!flow) return;
    let size = parseFloat(flow.style.fontSize);
    let guard = 0;
    while (node.scrollHeight > node.clientHeight + 2 && size > 6 && guard++ < 8) {
      size -= Math.max(0.4, size * 0.07);
      flow.style.fontSize = `${size}px`;
    }
    return;
  }
  let guard = 0;
  while (guard++ < 4) {
    const over = lines.filter((line) => line.scrollWidth > line.clientWidth + 1);
    if (!over.length) return;
    for (const line of lines) {
      const size = parseFloat(line.style.fontSize) * 0.95;
      line.style.fontSize = `${size}px`;
      line.style.letterSpacing = "";
    }
  }
}

/**
 * The hover-original tip — one per document, and never more than one.
 *
 * It used to be created on mouseenter and removed on mouseleave, which is fine
 * until the layer is repainted (every `pagerendered`, so: every scroll) while
 * the pointer is over a block. The node the listener belonged to was gone
 * before it could fire, and the tip stayed on the page for the rest of the
 * session; three of them were on screen at once in the report that found this.
 * A single reused node cannot leak, and every event that means "the pointer is
 * no longer where it was" puts it away.
 */
function tipNode(doc: Document): HTMLElement {
  let tip = doc.getElementById("prism-tr-tip") as HTMLElement | null;
  if (!tip) {
    tip = doc.createElement("div");
    tip.id = "prism-tr-tip";
    tip.className = "prism-tr-tip";
    tip.hidden = true;
    (doc.body || doc.documentElement).append(tip);
    for (const event of ["scroll", "wheel", "mousedown", "keydown"]) {
      doc.addEventListener(event, () => hideTip(doc), true);
    }
  }
  return tip;
}

function hideTip(doc: Document | null) {
  const tip = doc?.getElementById("prism-tr-tip");
  if (tip) (tip as HTMLElement).hidden = true;
}

function attachTip(node: HTMLElement, original: string, doc: Document) {
  node.addEventListener("mouseenter", (event: MouseEvent) => {
    const tip = tipNode(doc);
    tip.textContent = original;
    tip.style.left = `${Math.min(event.clientX + 12, (doc.defaultView?.innerWidth || 800) - 480)}px`;
    tip.style.top = `${event.clientY + 16}px`;
    tip.hidden = false;
  });
  node.addEventListener("mouseleave", () => hideTip(doc));
}

export function setShowOriginal(reader: any, show: boolean) {
  const overlay = overlayFor(reader);
  if (!overlay) return;
  overlay.showOriginal = show;
  const doc = viewerDoc(reader);
  if (!doc) return;
  for (const layer of Array.from(
    doc.querySelectorAll(".prism-tr-layer"),
  ) as HTMLElement[]) {
    layer.dataset.original = show ? "1" : "0";
  }
}

export function toggleOriginal(reader: any) {
  setShowOriginal(reader, !isShowingOriginal(reader));
}

export function clearReader(reader: any) {
  const overlay = overlayFor(reader);
  if (!overlay) return;
  overlay.cancelled = true;
  const viewer = app(reader);
  if (overlay.listener) {
    try {
      viewer?.eventBus?.off("pagerendered", overlay.listener);
      viewer?.eventBus?.off("scalechanging", overlay.listener);
    } catch {
      /* ignore */
    }
  }
  try {
    const doc = viewerDoc(reader);
    for (const layer of Array.from(
      doc?.querySelectorAll(".prism-tr-layer") || [],
    ) as HTMLElement[]) {
      layer.remove();
    }
    doc?.querySelector(".prism-tr-tip")?.remove();
  } catch {
    /* reader already closed */
  }
  addon.data.refract.overlays.delete(reader._instanceID);
}

export function restyleReader(reader: any) {
  const overlay = overlayFor(reader);
  const doc = viewerDoc(reader);
  if (!overlay || !doc) return;
  for (const pageView of pageViews(reader)) {
    renderPage(pageView, overlay, doc);
  }
}

/** Nudge font size or line height and repaint. */
export function adjust(reader: any, what: "font" | "line", delta: number) {
  if (what === "font") {
    const next = Math.min(28, Math.max(8, Number(getPref("refract.fontSize", 15)) + delta));
    setPref("refract.fontSize", next);
  } else {
    const next = Math.min(2.4, Math.max(1, Number(getPref("refract.lineHeight", 1.5)) + delta));
    setPref("refract.lineHeight", String(Math.round(next * 100) / 100));
  }
  restyleReader(reader);
}

/**
 * Bilingual markdown, written into a child note with links that jump back to
 * the page each paragraph came from.
 */
export async function translateToNote(
  item: Zotero.Item,
  attachment: Zotero.Item,
  reader: any,
): Promise<string> {
  const viewer = await pdfReady(reader);
  if (!viewer?.pdfDocument) {
    throw new Error(bi("Open the PDF first.", "请先打开 PDF。"));
  }
  const progress = openProgress(bi("Translating…", "正在翻译…"));

  const { pages: paragraphs, widths } = await collect(
    reader,
    viewer,
    (done, total) => progress.changeLine({ progress: (done / total) * 30 }),
    () => false,
  );
  const flat: Array<{ page: number; paragraph: Paragraph }> = [];
  for (const [page, list] of [...paragraphs.entries()].sort((a, b) => a[0] - b[0])) {
    for (const paragraph of readingOrder(list, widths.get(page) || 612)) {
      flat.push({ page, paragraph });
    }
  }

  const translated = await translateBatch(
    flat.map((entry) => entry.paragraph.text),
    {
      onProgress: (done, total) =>
        progress.changeLine({ progress: 30 + (done / total) * 70 }),
    },
  );

  const parts: string[] = [
    `<h2>${bi("Bilingual full text", "双语对照全文")} — ${escapeHTML(
      String(item.getField("title") || ""),
    )}</h2>`,
  ];
  let lastPage = -1;
  flat.forEach((entry, index) => {
    const page = entry.page + 1;
    const link = `zotero://open-pdf/library/items/${attachment.key}?page=${page}`;
    if (entry.page !== lastPage) {
      lastPage = entry.page;
      parts.push(`<h3><a href="${link}">p. ${page}</a></h3>`);
    }
    /* Each pair carries its own link back into the PDF, so a sentence quoted
       out of this note still knows which page it came from. */
    for (const [source, target] of alignPairs(
      entry.paragraph.text,
      translated[index] || entry.paragraph.text,
    )) {
      parts.push(
        `<p>${escapeHTML(target)} <sub><a href="${link}">p.${page}</a></sub></p>`,
        `<p style="color:#8a8f98;font-size:.9em">${escapeHTML(source)}</p>`,
      );
    }
  });

  const html = parts.join("\n");
  const note = new Zotero.Item("note");
  note.libraryID = item.libraryID;
  note.parentID = item.id;
  note.setNote(html);
  note.addTag("prism/translation", 1);
  await note.saveTx();

  progress.changeLine({
    text: bi("Bilingual note created", "双语对照笔记已创建"),
    progress: 100,
    type: "success",
  });
  progress.startCloseTimer(3000);
  await revealNotes([note]);
  return html;
}

/**
 * Original beside translation, in Zotero's own split view.
 *
 * The overlay is painted into the primary view's document only — `pdfWindow()`
 * resolves `_primaryView` first — so splitting the reader leaves the second
 * pane showing the untouched PDF. That is the whole trick: no second overlay,
 * no second render, and Zotero keeps both panes on the same document.
 *
 * The split itself is not where `zotero-types` says it is. `reader.menuCmd(…)`
 * and `isSplitVerticallyActive()` are Zotero 7's API and are simply absent on
 * 10.0.3 — `menuCmd` is `undefined`, so the documented call throws. The live
 * object keeps it all on `_internalReader`: `toggleVerticalSplit()`,
 * `disableSplitView()` and a `splitType` of "vertical" | "horizontal" | null.
 * Both are tried, newest first.
 */
export async function toggleCompare(reader: any): Promise<void> {
  const internal = reader?._internalReader;
  if (typeof internal?.toggleVerticalSplit === "function") {
    if (isComparing(reader)) internal.disableSplitView?.();
    else internal.toggleVerticalSplit();
  } else if (typeof reader?.menuCmd === "function") {
    await reader.menuCmd("splitVertically"); // Zotero 7/8
  } else {
    throw new Error(
      bi(
        "This Zotero build has no split view.",
        "当前 Zotero 版本不支持并排对照。",
      ),
    );
  }
  // The sandbox has no bare setTimeout — see utils/window.
  await sleep(400);
  if (isComparing(reader)) syncSecondView(reader);
}

export function isComparing(reader: any): boolean {
  try {
    const internal = reader?._internalReader;
    if (internal && "splitType" in internal) return !!internal.splitType;
    return (
      !!reader?.isSplitVerticallyActive?.() || !!reader?.isSplitHorizontallyActive?.()
    );
  } catch {
    return false;
  }
}

/**
 * Keep the original pane on the page the translated pane is showing.
 *
 * Zotero scrolls its two panes independently, so without this the comparison
 * stops being one after a page or two. The route matters: the reader's own
 * `_secondaryView.navigate({ pageIndex })` accepts the call and does nothing
 * (verified — the pane stayed on page 11 through three different location
 * shapes, and `navigateToPosition` threw), while the second pane's PDF.js
 * honours `currentPageNumber` immediately. Only the primary's events are
 * listened to, so moving the second pane cannot feed back.
 */
function syncSecondView(reader: any) {
  const viewer = app(reader);
  if (!viewer?.eventBus || (reader as any).__prismCompareSync) return;
  const listener = (event: any) => {
    if (!isComparing(reader)) return;
    const page = Number(event?.pageNumber);
    if (!Number.isFinite(page) || page < 1) return;
    try {
      const other = unwrap(reader._internalReader?._secondaryView?._iframeWindow)
        ?.PDFViewerApplication;
      if (other?.pdfViewer && other.pdfViewer.currentPageNumber !== page) {
        other.pdfViewer.currentPageNumber = page;
      }
    } catch {
      /* the panes simply scroll on their own */
    }
  };
  try {
    viewer.eventBus.on("pagechanging", listener);
    (reader as any).__prismCompareSync = listener;
  } catch {
    /* older viewer: no sync, but the split itself is fine */
  }
}

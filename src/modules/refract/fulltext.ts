/**
 * In-reader full-text translation.
 *
 * The translated paragraphs are laid back over the page at the position of the
 * original text, so the figures, equations and page numbering you already know
 * stay exactly where they were. Ctrl/Cmd-click any block to reveal the source,
 * double-click it to correct the translation. A translation is saved with the
 * attachment and comes back when the paper is opened again.
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
import { contrast, inkFrom, parseHex, type Ink, type RGB } from "./ink";
import { locateQuote, mapToTranslation, runsOf, type Mark } from "./marks";
import {
  carryEdits,
  forgetTranslation,
  loadSaved,
  saveTranslation,
  type Block,
} from "./saved";
import { editTranslation, type Anchor } from "./editor";
import { escapeHTML, splitSentences } from "../../utils/text";
import { pageText, pdfApp, pdfDocument, pdfReady, pageViews, unwrap } from "../../utils/reader";
import { openProgress } from "../../utils/progress";
import { revealNotes } from "../../utils/item";
import { sleep } from "../../utils/window";

/** How far below the baseline a descender reaches, as a fraction of the size. */
const DESCENDER = 0.26;

interface Overlay {
  readerID: string;
  itemID: number;
  pages: Map<number, Block[]>;
  showOriginal: boolean;
  listener?: (event: any) => void;
  cancelled: boolean;
  /** recorded with the saved copy */
  engine: string;
  to: string;
  fingerprint: string;
  /** highlights and underlines carried onto the translation, per block */
  marks?: Map<Block, Mark[]>;
  /** which annotations `marks` was worked out from */
  markSig?: string;
}

const OVERLAY_CSS = `
/* Above Zotero's overlay (1) and the text layer (2). That overlay draws the
   selection, highlights and search hits where the words are in the original;
   over a translation those spots hold other words, or blank paper where the
   translation ran short. The selection and the highlights are drawn again
   on the translation instead — see paintSelection() and marksFor(). */
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
  /* Set per layer from the reader's theme — see pageColors(). */
  color: var(--prism-tr-fg, #101114);
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
.prism-tr-block.prism-tr-hot { box-shadow: 0 0 0 1px rgba(46,127,212,.55); }
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
.prism-tr-tip-hint { margin-top: 6px; font-size: 11px; opacity: .6; }
.prism-tr-hl { background: color-mix(in srgb, var(--hl) 45%, transparent); border-radius: 2px; }
.prism-tr-ul {
  text-decoration: underline 2px var(--ul);
  text-underline-offset: 2px;
  text-decoration-skip-ink: none;
}
/* Zotero's own selection colours, blended the way it blends them. */
.prism-tr-sel {
  position: absolute;
  pointer-events: none;
  background: #71ADFD;
  opacity: .4;
  mix-blend-mode: multiply;
}
.prism-tr-layer[data-dark="1"] .prism-tr-sel { opacity: .7; mix-blend-mode: lighten; }
.prism-tr-layer[data-original="1"] .prism-tr-sel { display: none; }
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
    engine: options.engine || getPref<string>("refract.engine", "google"),
    to: options.to || getPref<string>("refract.targetLang", "zh-CN"),
    fingerprint: fingerprintOf(viewer),
  };
  addon.data.refract.overlays.set(reader._instanceID, overlay);
  const attachment = attachmentOf(reader);
  const previous = attachment ? await loadSaved(attachment) : null;

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

    let incomplete = 0;
    const byUnit = await translateBatch(
      units.map((unit) => unit.text),
      {
        engine: options.engine,
        to: options.to,
        shouldStop: () => overlay.cancelled,
        onIncomplete: (missing) => {
          incomplete = missing;
        },
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
    carryEdits(overlay.pages, previous);
    attach(reader, overlay);
    void persist(reader, overlay);
    progress.changeLine({
      text: incomplete
        ? bi(
            `Translation applied. ${incomplete} paragraphs failed and are shown in the original.`,
            `翻译完成，其中 ${incomplete} 段翻译失败，保留原文。`,
          )
        : bi("Translation applied", "翻译完成"),
      progress: 100,
      type: incomplete ? "fail" : "success",
    });
    progress.startCloseTimer(incomplete ? 8000 : 2500);
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
  wire(reader, doc);

  const paint = () => {
    for (const pageView of pageViews(reader)) {
      renderPage(pageView, overlay, doc);
    }
    paintSelection(reader);
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
  const colors = pageColors(doc);
  if (colors) {
    layer.style.setProperty("--prism-tr-bg", colors.background);
    layer.style.setProperty("--prism-tr-fg", colors.foreground);
  }
  const paper = parseHex(colors?.background);
  layer.dataset.dark = paper && contrast(paper, [255, 255, 255]) > contrast(paper, [0, 0, 0]) ? "1" : "0";
  const marks = marksFor(overlay);

  const scale = pageView.viewport.scale || 1;
  const fontScale = Number(getPref("refract.fontSize", 15)) / 15;
  const lineHeight = Number(getPref("refract.lineHeight", 1.5));
  const fontFamily = getPref<string>("refract.fontFamily", "");

  const rects = blocks.map((block) => viewportRect(pageView.viewport, block.box));
  const inks = blockInks(pageView, blocks, rects, colors);

  for (const [i, block] of blocks.entries()) {
    const rect = rects[i];
    if (rect.width < 8 || rect.height < 5) continue;

    const node = doc.createElement("div");
    node.className = "prism-tr-block";
    node.dataset.kind = block.kind;
    node.dataset.page = String(index);
    node.dataset.index = String(i);
    // Cover a shade more than the text box: ascenders and descenders of the
    // original poke out of an exact fit and read as dirt on the page.
    node.style.left = `${rect.left - PAD_X}px`;
    node.style.top = `${rect.top - PAD_Y}px`;
    node.style.width = `${rect.width + PAD_X * 2}px`;
    node.style.height = `${rect.height + PAD_Y * 2}px`;
    const ink = inks?.[i];
    if (ink) {
      node.style.setProperty("--prism-tr-bg", ink.background);
      node.style.setProperty("--prism-tr-fg", ink.foreground);
    }
    if (fontFamily) node.style.fontFamily = fontFamily;

    const base = Math.max(6, block.fontSize * scale * 0.96 * fontScale);
    const lineRects = block.lines
      .map((line) => viewportRect(pageView.viewport, line))
      .filter((line) => line.width > 4)
      .sort((a, b) => a.top - b.top);

    if (lineRects.length) {
      paintLines(doc, node, block, lineRects, rect, base, marks.get(block));
    } else {
      // No line geometry (shouldn't happen) — fall back to wrapped text.
      const flow = doc.createElement("div");
      flow.className = "prism-tr-flow";
      fillRuns(doc, flow, block.translated, 0, marks.get(block));
      flow.style.fontSize = `${base}px`;
      flow.style.lineHeight = String(lineHeight);
      node.append(flow);
    }

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

const COLOR = /^(#[0-9a-f]{3,8}|(rgba?|hsla?)\([\d\s.,%deg/]+\))$/i;

/**
 * The colours the reader is painting the page in.
 *
 * Zotero's reader themes (Dark, Black, Sepia, Snow, or the user's own) are not a
 * CSS filter over the page: PDF.js redraws the canvas with white mapped to the
 * theme's background and black to its foreground, and publishes the pair as
 * `window.theme` in the viewer frame. The blocks were always white with black
 * text, so under the Dark theme every translated paragraph was a white slab on
 * a slate page. Read on every repaint: a theme change resets the page views,
 * and the `pagerendered` that follows brings us back here.
 */
function pageColors(doc: Document): { background: string; foreground: string } | null {
  const win: any = unwrap(doc.defaultView);
  try {
    const background = String(win?.theme?.background || "").trim();
    const foreground = String(win?.theme?.foreground || "").trim();
    if (COLOR.test(background) && COLOR.test(foreground)) return { background, foreground };
  } catch {
    /* no theme on this build */
  }
  // Without a theme object the page colour is still on the root as a variable;
  // pick the text colour that reads on it.
  try {
    const background = win
      .getComputedStyle(doc.documentElement)
      .getPropertyValue("--background-color")
      .trim();
    if (!COLOR.test(background)) return null;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(background)?.[1];
    if (!hex) return { background, foreground: "#101114" };
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    const dark = 0.299 * r + 0.587 * g + 0.114 * b < 140;
    return { background, foreground: dark ? "#e8e9eb" : "#101114" };
  } catch {
    return null;
  }
}

/** PDF.js `RenderingStates.FINISHED`. */
const RENDERING_FINISHED = 3;
/** Longest side of the page copy the colours are read from, in pixels. */
const SAMPLE_SIDE = 1000;
/** Pixels read per block. */
const SAMPLES_PER_BLOCK = 900;

interface PageInks {
  canvas: unknown;
  theme: string;
  blocks: Block[];
  inks: Array<Ink | null>;
}

/** Keyed by page view: the primary and the compare pane each have their own. */
const inkCache = new WeakMap<object, PageInks>();

/**
 * Paper and ink under each block, read off the page as it is painted.
 *
 * Every `pagerendered` repaints the layers of all pages, so the reading is
 * kept per page view and only redone when that page has a new canvas, a new
 * set of blocks or a new theme. A canvas still being drawn is not read: it is
 * part blank, and its `pagerendered` brings us back once it is done. Until
 * then the page keeps the colours it had, so a zoom does not flash the blocks
 * back to the theme colour.
 */
function blockInks(
  pageView: any,
  blocks: Block[],
  rects: Rect[],
  theme: { background: string; foreground: string } | null,
): Array<Ink | null> | null {
  const themeKey = theme ? `${theme.background} ${theme.foreground}` : "";
  const cached = inkCache.get(pageView);
  const usable =
    cached && cached.blocks === blocks && cached.theme === themeKey ? cached : null;
  let canvas: any = null;
  let finished = false;
  try {
    canvas = pageView.canvas;
    finished = pageView.renderingState === RENDERING_FINISHED;
  } catch {
    /* torn down */
  }
  if (!canvas || !finished) return usable?.inks ?? null;
  if (usable && usable.canvas === canvas) return usable.inks;
  const inks = sampleInks(canvas, pageView.viewport, rects, parseHex(theme?.foreground));
  if (!inks) return usable?.inks ?? null;
  inkCache.set(pageView, { canvas, theme: themeKey, blocks, inks });
  return inks;
}

/**
 * Copy the page canvas down to about screen resolution and sample a grid of
 * pixels under each block.
 *
 * The copy is drawn into a canvas of the main window: that side may read any
 * page's pixels, and the numbers come back without crossing into the viewer's
 * unprivileged compartment one by one. Nearest-pixel scaling keeps every
 * sample a colour actually on the page rather than a blend of paper and ink.
 */
function sampleInks(
  source: any,
  viewport: any,
  rects: Rect[],
  preferred: RGB | null,
): Array<Ink | null> | null {
  try {
    const width = Number(viewport?.width);
    const height = Number(viewport?.height);
    if (!(source.width > 0 && source.height > 0 && width > 0 && height > 0)) {
      return null;
    }
    const factor = Math.min(1, SAMPLE_SIDE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * factor));
    const h = Math.max(1, Math.round(height * factor));
    const host = (Zotero.getMainWindow() as any)?.document;
    if (!host) return null;
    const copy = host.createElementNS("http://www.w3.org/1999/xhtml", "canvas") as HTMLCanvasElement;
    copy.width = w;
    copy.height = h;
    const context = copy.getContext("2d");
    if (!context) return null;
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, w, h);
    const data = context.getImageData(0, 0, w, h).data;

    return rects.map((rect) => {
      const x0 = Math.max(0, Math.floor((rect.left - PAD_X) * factor));
      const y0 = Math.max(0, Math.floor((rect.top - PAD_Y) * factor));
      const x1 = Math.min(w, Math.ceil((rect.left + rect.width + PAD_X) * factor));
      const y1 = Math.min(h, Math.ceil((rect.top + rect.height + PAD_Y) * factor));
      if (x1 <= x0 || y1 <= y0) return null;
      // The R2 low-discrepancy sequence spreads the samples evenly without a
      // grid's regular spacing, which can fall in step with the line pitch
      // and read only the gaps between lines, or only the text.
      const n = Math.min(SAMPLES_PER_BLOCK, (x1 - x0) * (y1 - y0));
      const samples: number[] = [];
      for (let k = 0; k < n; k++) {
        const x = x0 + Math.floor(((0.5 + k * 0.7548776662466927) % 1) * (x1 - x0));
        const y = y0 + Math.floor(((0.5 + k * 0.5698402909980532) % 1) * (y1 - y0));
        const i = (y * w + x) * 4;
        samples.push(data[i], data[i + 1], data[i + 2]);
      }
      return inkFrom(samples, preferred);
    });
  } catch (e) {
    Zotero.debug(`[Prism] could not read the page colours: ${e}`);
    return null;
  }
}

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
  marks?: Mark[],
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
  // Where each line starts in the translation, for the marks.
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of flowed.lines) {
    const at = block.translated.indexOf(line, cursor);
    const start = at >= 0 ? at : cursor;
    offsets.push(start);
    cursor = start + line.length;
  }
  lineRects.forEach((line, i) => {
    const text = flowed.lines[i];
    if (!text) return;
    const el = doc.createElement("div");
    el.className = "prism-tr-line";
    fillRuns(doc, el, text, offsets[i], marks);
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

/** A line's text, with the runs under a highlight or an underline wrapped. */
function fillRuns(doc: Document, el: HTMLElement, text: string, offset: number, marks?: Mark[]) {
  if (!marks?.length) {
    el.textContent = text;
    return;
  }
  for (const run of runsOf(text, offset, marks)) {
    if (!run.marks.length) {
      el.append(doc.createTextNode(run.text));
      continue;
    }
    const span = doc.createElement("span");
    span.textContent = run.text;
    const highlight = run.marks.find((mark) => mark.kind === "highlight");
    const underline = run.marks.find((mark) => mark.kind === "underline");
    if (highlight) {
      span.classList.add("prism-tr-hl");
      span.style.setProperty("--hl", highlight.color);
    }
    if (underline) {
      span.classList.add("prism-tr-ul");
      span.style.setProperty("--ul", underline.color);
    }
    el.append(span);
  }
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
    // `pointerdown`, not `mousedown`: with a highlight, underline or ink tool
    // active the page cancels pointerdown, and with it the mousedown.
    for (const event of ["scroll", "wheel", "pointerdown", "keydown"]) {
      doc.addEventListener(event, () => hideTip(doc), true);
    }
  }
  return tip;
}

function hideTip(doc: Document | null) {
  const tip = doc?.getElementById("prism-tr-tip");
  if (tip) (tip as HTMLElement).hidden = true;
}

function showTip(doc: Document, block: Block, x: number, y: number) {
  const tip = tipNode(doc);
  const text = doc.createElement("div");
  text.textContent = block.original;
  const hint = doc.createElement("div");
  hint.className = "prism-tr-tip-hint";
  hint.textContent =
    block.machine !== undefined
      ? bi("Edited by hand · double-click to edit again", "已手动修改 · 双击可再次编辑")
      : bi("Double-click to edit · Ctrl+click to see the original", "双击编辑译文 · Ctrl+点击透视原文");
  tip.replaceChildren(text, hint);
  tip.style.left = `${Math.min(x + 12, (doc.defaultView?.innerWidth || 800) - 480)}px`;
  tip.style.top = `${y + 16}px`;
  tip.hidden = false;
}

/* ------------------------------------------------ pointer, copy and editing */

/**
 * Marks a viewer document as wired by this instance of the plugin. After an
 * upgrade the old instance's listeners are dead, and a new token wires the
 * document again instead of finding it already done.
 */
const WIRED = Math.random().toString(36).slice(2);

interface BlockRef {
  page: number;
  index: number;
}

/** The last right-click on a block, per reader, for the context menu. */
const lastContext = new Map<string, BlockRef & { at: number }>();

/**
 * The translated block at a point.
 *
 * The layer sits under the PDF text layer so that Zotero's selection and
 * highlights show over it, which means a block is never the target of a
 * pointer event. `elementsFromPoint` sees through to it.
 */
function blockAt(doc: Document, x: number, y: number): (BlockRef & { node: HTMLElement }) | null {
  let stack: Element[] = [];
  try {
    stack = Array.from(doc.elementsFromPoint(x, y) as ArrayLike<Element>);
  } catch {
    return null;
  }
  for (const element of stack) {
    const node = (element as HTMLElement).closest?.(".prism-tr-block") as HTMLElement | null;
    if (!node) continue;
    const page = Number(node.dataset.page);
    const index = Number(node.dataset.index);
    if (Number.isInteger(page) && Number.isInteger(index)) return { page, index, node };
  }
  return null;
}

function blockOf(reader: any, ref: BlockRef): Block | undefined {
  return overlayFor(reader)?.pages.get(ref.page)?.[ref.index];
}

/** Hover tip, Ctrl-click peek, double-click edit, right-click and copy. */
function wire(reader: any, doc: Document) {
  const root = doc.documentElement as HTMLElement | null;
  const win = doc.defaultView;
  if (!root || !win || root.dataset.prismTr === WIRED) return;
  root.dataset.prismTr = WIRED;

  const shown = () => {
    const overlay = overlayFor(reader);
    return overlay && !overlay.showOriginal ? overlay : null;
  };

  let hot: HTMLElement | null = null;
  let frame = 0;
  let x = 0;
  let y = 0;
  const hover = () => {
    frame = 0;
    const hit = shown() ? blockAt(doc, x, y) : null;
    const node = hit?.node ?? null;
    if (node === hot) return;
    hot?.classList.remove("prism-tr-hot");
    hot = node;
    hot?.classList.add("prism-tr-hot");
    const block = hit && blockOf(reader, hit);
    if (block && getPref<boolean>("refract.hoverOriginal", true)) showTip(doc, block, x, y);
    else hideTip(doc);
  };
  // Zotero keeps the selection itself; it is read back after every gesture
  // that can change it, and on every move while the button is down.
  let selecting = 0;
  const refreshSelection = () => {
    if (!selecting) {
      selecting = win.requestAnimationFrame(() => {
        selecting = 0;
        paintSelection(reader);
      });
    }
  };
  doc.addEventListener(
    "mousemove",
    (event: MouseEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = win.requestAnimationFrame(hover);
      if (event.buttons & 1) refreshSelection();
    },
    true,
  );
  for (const type of ["pointerup", "mouseup", "click", "dblclick", "keyup"]) {
    doc.addEventListener(type, () => win.setTimeout(refreshSelection, 0), true);
  }

  doc.addEventListener(
    "click",
    (event: MouseEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !shown()) return;
      const hit = blockAt(doc, event.clientX, event.clientY);
      if (!hit) return;
      event.preventDefault();
      hit.node.classList.toggle("prism-tr-peek");
    },
    true,
  );

  doc.addEventListener(
    "dblclick",
    (event: MouseEvent) => {
      if (!shown()) return;
      const hit = blockAt(doc, event.clientX, event.clientY);
      if (!hit) return;
      event.preventDefault();
      hideTip(doc);
      editBlock(reader, hit);
    },
    true,
  );

  // Recorded before Zotero builds the menu, which then asks contextBlock().
  doc.addEventListener(
    "contextmenu",
    (event: MouseEvent) => {
      const hit = shown() ? blockAt(doc, event.clientX, event.clientY) : null;
      if (hit) lastContext.set(reader._instanceID, { page: hit.page, index: hit.index, at: Date.now() });
      else lastContext.delete(reader._instanceID);
    },
    true,
  );

  // On the window and after the viewer's own handler, which stops the event
  // there once it has put the original text on the clipboard.
  win.addEventListener("copy", (event: ClipboardEvent) => copyTranslation(reader, event), true);
}

/** Zotero's text selection: rects in PDF space, per page. */
function selectionRanges(reader: any): Array<{ page: number; rects: number[][] }> {
  const out: Array<{ page: number; rects: number[][] }> = [];
  try {
    for (const range of Array.from(reader._internalReader?._primaryView?._selectionRanges || []) as any[]) {
      const position = range?.position;
      if (!position || range.collapsed) continue;
      const rects = (Array.from(position.rects || []) as ArrayLike<number>[]).map((rect) =>
        Array.from(rect, Number),
      );
      if (rects.length) out.push({ page: Number(position.pageIndex), rects });
    }
  } catch {
    /* no selection to read on this build */
  }
  return out;
}

/** A block node's box on its page, from the style it was placed with. */
function boxOf(node: HTMLElement): Rect {
  return {
    left: parseFloat(node.style.left) || 0,
    top: parseFloat(node.style.top) || 0,
    width: parseFloat(node.style.width) || 0,
    height: parseFloat(node.style.height) || 0,
  };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return right - left > 0.5 && bottom - top > 0.5
    ? { left, top, width: right - left, height: bottom - top }
    : null;
}

/** Translated blocks touched by the selection, with the selection's boxes on that page. */
function selectedBlocks(reader: any): Array<{ node: HTMLElement; boxes: Rect[]; pageView: any }> {
  const views = pageViews(reader);
  const out: Array<{ node: HTMLElement; boxes: Rect[]; pageView: any }> = [];
  for (const { page, rects } of selectionRanges(reader)) {
    const pageView = views[page];
    const layer = pageView?.div?.querySelector(":scope > .prism-tr-layer") as HTMLElement | null;
    if (!layer || !pageView.viewport) continue;
    const boxes = rects.map((rect) => viewportRect(pageView.viewport, rect));
    for (const node of Array.from(layer.querySelectorAll(".prism-tr-block")) as HTMLElement[]) {
      const box = boxOf(node);
      if (boxes.some((selected) => intersect(selected, box))) out.push({ node, boxes, pageView });
    }
  }
  return out;
}

/**
 * Draw Zotero's selection on the translation. Its overlay stays under the
 * translated blocks with the rest of its marks, so where a block covers the
 * page the selection is drawn again here, clipped to the block.
 */
function paintSelection(reader: any) {
  const overlay = overlayFor(reader);
  const doc = viewerDoc(reader);
  if (!overlay || !doc) return;
  for (const old of Array.from(doc.querySelectorAll(".prism-tr-sel")) as Element[]) old.remove();
  if (overlay.showOriginal) return;
  for (const { node, boxes } of selectedBlocks(reader)) {
    const box = boxOf(node);
    for (const selected of boxes) {
      const hit = intersect(selected, box);
      if (!hit) continue;
      const mark = doc.createElement("div");
      mark.className = "prism-tr-sel";
      mark.style.left = `${hit.left}px`;
      mark.style.top = `${hit.top}px`;
      mark.style.width = `${hit.width}px`;
      mark.style.height = `${hit.height}px`;
      node.parentElement?.append(mark);
    }
  }
}

/**
 * Copying a selection over translated paragraphs gives the translation, as
 * it is on screen: the characters that lie inside the selection. Zotero
 * selects in the original, by position, and the translation sits on the same
 * lines, so the selection's boxes pick out the translated text under them.
 */
function copyTranslation(reader: any, event: ClipboardEvent) {
  const overlay = overlayFor(reader);
  if (!overlay || overlay.showOriginal || !event.clipboardData) return;
  const touched = selectedBlocks(reader);
  if (!touched.length) return;
  const parts: string[] = [];
  for (const { node, boxes, pageView } of touched) {
    const text = textInside(node, boxes, pageView);
    if (text) parts.push(text);
  }
  // Measuring came to nothing: whole paragraphs beat an empty clipboard.
  const text = parts.length
    ? parts.join("\n")
    : touched
        .map(({ node }) => blockOf(reader, { page: Number(node.dataset.page), index: Number(node.dataset.index) })?.translated || "")
        .filter(Boolean)
        .join("\n");
  if (!text) return;
  event.clipboardData.clearData();
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
}

/** The characters of a block whose centres fall inside one of `boxes`. */
function textInside(node: HTMLElement, boxes: Rect[], pageView: any): string {
  const doc = node.ownerDocument;
  const page = (pageView.div as HTMLElement).getBoundingClientRect();
  const scale = page.width / (Number(pageView.viewport?.width) || page.width) || 1;
  const range = doc.createRange();
  let out = "";
  for (const line of Array.from(node.querySelectorAll(".prism-tr-line, .prism-tr-flow")) as HTMLElement[]) {
    let piece = "";
    const walker = doc.createTreeWalker(line, 4 /* NodeFilter.SHOW_TEXT */);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const data = text.nodeValue || "";
      for (let i = 0; i < data.length; i++) {
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const r = range.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const cx = (r.left + r.width / 2 - page.left) / scale;
        const cy = (r.top + r.height / 2 - page.top) / scale;
        if (boxes.some((b) => cx >= b.left && cx <= b.left + b.width && cy >= b.top && cy <= b.top + b.height)) {
          piece += data[i];
        }
      }
    }
    if (!piece) continue;
    // Lines of a Latin translation were broken at spaces that are not there.
    out += /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(piece) ? ` ${piece}` : piece;
  }
  return out;
}

function overlaps(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const width =
    Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2])) -
    Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2]));
  const height =
    Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3])) -
    Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3]));
  return width > 0.5 && height > 0.5;
}

/** The block right-clicked a moment ago, for the view context menu. */
export function contextBlock(reader: any): BlockRef | null {
  const hit = lastContext.get(reader?._instanceID);
  if (!hit || Date.now() - hit.at > 3000 || !blockOf(reader, hit)) return null;
  return { page: hit.page, index: hit.index };
}

export function copyBlock(reader: any, ref: BlockRef) {
  const block = blockOf(reader, ref);
  if (block) new ztoolkit.Clipboard().addText(block.translated, "text/plain").copy();
}

/** How many paragraphs carry hand edits, to warn before throwing them away. */
export function editedCount(reader: any): number {
  let count = 0;
  for (const blocks of overlayFor(reader)?.pages.values() || []) {
    for (const block of blocks) if (block.machine !== undefined) count++;
  }
  return count;
}

export function editBlock(reader: any, ref: BlockRef) {
  const block = blockOf(reader, ref);
  if (!block) return;
  const host = hostWindow(reader);
  if (!host) return;
  const node = viewerDoc(reader)?.querySelector(
    `.prism-tr-block[data-page="${ref.page}"][data-index="${ref.index}"]`,
  ) as HTMLElement | null;
  editTranslation({
    win: host,
    anchor: node ? anchorIn(host, node) : null,
    original: block.original,
    translated: block.translated,
    machine: block.machine,
    onSave: (text) => applyEdit(reader, ref, text),
  });
}

function applyEdit(reader: any, ref: BlockRef, text: string) {
  const overlay = overlayFor(reader);
  const block = blockOf(reader, ref);
  if (!overlay || !block) return;
  const machine = block.machine ?? block.translated;
  if (text === machine) {
    block.translated = machine;
    delete block.machine;
  } else {
    block.machine = machine;
    block.translated = text;
  }
  overlay.marks = undefined;
  restyleReader(reader);
  void persist(reader, overlay);
}

/** The window holding the reader: the main window, or a reader window of its own. */
function hostWindow(reader: any): Window | null {
  return (reader?._window as Window | undefined) || (Zotero.getMainWindow() as unknown as Window) || null;
}

/** Where a node in the PDF frame sits, in the coordinates of `host`. */
function anchorIn(host: Window, node: HTMLElement): Anchor | null {
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

/* ------------------------------------------------ annotations on the translation */

function annotationsOf(itemID: number): Zotero.Item[] {
  try {
    const attachment = Zotero.Items.get(itemID) as Zotero.Item | false;
    if (!attachment || !attachment.isFileAttachment()) return [];
    return (attachment.getAnnotations() as Zotero.Item[]).filter((annotation) =>
      ["highlight", "underline"].includes(String(annotation.annotationType)),
    );
  } catch {
    return [];
  }
}

function signature(annotations: Zotero.Item[]): string {
  return annotations
    .map((a) => `${a.key}:${a.dateModified}`)
    .sort()
    .join(",");
}

/**
 * The reader's highlights and underlines, each moved onto the sentences of
 * the translation that render the words it marks — see marks.ts.
 */
function marksFor(overlay: Overlay): Map<Block, Mark[]> {
  if (overlay.marks) return overlay.marks;
  const marks = new Map<Block, Mark[]>();
  const annotations = annotationsOf(overlay.itemID);
  overlay.markSig = signature(annotations);
  for (const annotation of annotations) {
    let position: any;
    try {
      position = JSON.parse(annotation.annotationPosition);
    } catch {
      continue;
    }
    const spans: Array<[number, number[][]]> = [[Number(position?.pageIndex), position?.rects || []]];
    if (position?.nextPageRects) spans.push([Number(position.pageIndex) + 1, position.nextPageRects]);
    for (const [page, rects] of spans) {
      for (const block of overlay.pages.get(page) || []) {
        if (!block.lines.some((line) => rects.some((rect) => overlaps(line, rect)))) continue;
        const source = locateQuote(block.original, annotation.annotationText || "");
        const target = source && mapToTranslation(block.original, block.translated, source);
        if (!target) continue;
        const list = marks.get(block) || [];
        list.push({
          start: target[0],
          end: target[1],
          color: annotation.annotationColor || "#ffd400",
          kind: annotation.annotationType === "underline" ? "underline" : "highlight",
        });
        marks.set(block, list);
      }
    }
  }
  overlay.marks = marks;
  return marks;
}

/**
 * An annotation was added, changed or removed somewhere: repaint any open
 * translation whose paper's highlights are no longer the ones it drew.
 */
export function annotationsChanged() {
  for (const reader of ((Zotero.Reader as any)._readers || []) as any[]) {
    const overlay = overlayFor(reader);
    if (!overlay) continue;
    if (signature(annotationsOf(overlay.itemID)) === overlay.markSig) continue;
    overlay.marks = undefined;
    restyleReader(reader);
  }
}

/* ------------------------------------------------------------ saved copies */

function attachmentOf(reader: any): Zotero.Item | null {
  try {
    const item = Zotero.Items.get(reader?.itemID) as Zotero.Item | false;
    return item && item.isAttachment() ? item : null;
  } catch {
    return null;
  }
}

function fingerprintOf(viewer: any): string {
  try {
    const document = viewer?.pdfDocument;
    const value = document?.fingerprints?.[0] ?? document?.fingerprint;
    return value ? String(value) : "";
  } catch {
    return "";
  }
}

async function persist(reader: any, overlay: Overlay) {
  const attachment = attachmentOf(reader);
  if (!attachment || overlay.cancelled) return;
  await saveTranslation(attachment, {
    version: 1,
    fingerprint: overlay.fingerprint,
    engine: overlay.engine,
    to: overlay.to,
    savedAt: Date.now(),
    pages: [...overlay.pages.entries()],
  });
}

const restoring = new Set<string>();

/**
 * Put a saved translation back on a reader that has just opened: no layout
 * parsing, no engine, so it is there as soon as the pages are. Skipped when
 * the file has changed since it was translated, since the saved boxes would
 * no longer sit on the text.
 */
export async function restoreReader(reader: any) {
  if (!getPref<boolean>("refract.restoreTranslation", true)) return;
  const id: string | undefined = reader?._instanceID;
  if (!id || overlayFor(reader) || restoring.has(id)) return;
  const attachment = attachmentOf(reader);
  if (!attachment) return;
  restoring.add(id);
  try {
    const saved = await loadSaved(attachment);
    if (!saved?.pages.length) return;
    const viewer = await viewerFor(reader);
    if (!viewer?.pdfDocument || overlayFor(reader)) return;
    const fingerprint = fingerprintOf(viewer);
    if (saved.fingerprint && fingerprint && saved.fingerprint !== fingerprint) {
      Zotero.debug(`[Prism] ${attachment.key} changed since it was translated; not restoring`);
      return;
    }
    const overlay: Overlay = {
      readerID: id,
      itemID: reader.itemID,
      pages: new Map(saved.pages),
      showOriginal: false,
      cancelled: false,
      engine: saved.engine,
      to: saved.to,
      fingerprint: saved.fingerprint || fingerprint,
    };
    addon.data.refract.overlays.set(id, overlay);
    attach(reader, overlay);
    Zotero.debug(`[Prism] restored the saved translation of ${attachment.key}`);
  } catch (e) {
    Zotero.debug(`[Prism] could not restore the translation: ${e}`);
  } finally {
    restoring.delete(id);
  }
}

/**
 * The viewer once its document is loaded. The reader's toolbar, which is when
 * we hear about a new reader, renders before the PDF frame even exists.
 */
async function viewerFor(reader: any, timeoutMS = 30000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMS) {
    if (pdfApp(reader)?.pdfDocument) return pdfReady(reader);
    if (!((Zotero.Reader as any)._readers || []).includes(reader)) return null;
    await sleep(300);
  }
  return null;
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

/**
 * Take the translation off the page. `forget` also deletes the saved copy, so
 * it does not come back when the paper is opened again — that is the user
 * removing it; the plugin shutting down only clears the page.
 */
export function clearReader(reader: any, options: { forget?: boolean } = {}) {
  if (options.forget) {
    const attachment = attachmentOf(reader);
    if (attachment) void forgetTranslation(attachment);
  }
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
  paintSelection(reader);
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

  if (!flat.length) {
    progress.changeLine({ text: bi("This PDF has no text to extract.", "这份 PDF 中没有可提取的文字。"), type: "fail" });
    progress.startCloseTimer(6000);
    throw new Error(bi("No extractable text in this PDF.", "这份 PDF 中没有可提取的文字。"));
  }
  let incomplete = 0;
  let translated: string[];
  try {
    translated = await translateBatch(
      flat.map((entry) => entry.paragraph.text),
      {
        onIncomplete: (missing) => {
          incomplete = missing;
        },
        onProgress: (done, total) =>
          progress.changeLine({ progress: 30 + (done / total) * 70 }),
      },
    );
  } catch (e: any) {
    // Nothing to put in the note: say so instead of filing the original twice.
    progress.changeLine({ text: `${bi("Failed: ", "失败：")}${e?.message || e}`, type: "fail" });
    progress.startCloseTimer(8000);
    throw e;
  }

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
    text: incomplete
      ? bi(
          `Bilingual note created. ${incomplete} paragraphs failed and are shown in the original.`,
          `双语对照笔记已创建，其中 ${incomplete} 段翻译失败，显示原文。`,
        )
      : bi("Bilingual note created", "双语对照笔记已创建"),
    progress: 100,
    type: incomplete ? "fail" : "success",
  });
  progress.startCloseTimer(incomplete ? 8000 : 3000);
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

/** Everything Prism needs to read out of (and write back into) a Zotero item. */

import { dropReferences, stripHTML, withPageMarkers } from "./text";
import { pageCount, pageText, pageViews, pdfReady } from "./reader";

/** `Zotero.Items.get` narrowed to a single item. */
export function getItem(id: number | string): Zotero.Item | null {
  try {
    const item = Zotero.Items.get(id as number);
    return item && typeof item === "object" ? (item as Zotero.Item) : null;
  } catch {
    return null;
  }
}

/**
 * The chrome globals, which do not exist in a plugin's scope.
 *
 * Zotero loads a bootstrapped plugin into a Sandbox whose globals are `Zotero`,
 * `Services`, `IOUtils`, `PathUtils` and a short list more — `ZoteroPane` and
 * `Zotero_Tabs` are **not** among them. A bare reference throws
 * ReferenceError, and since the two readers below swallowed it, the selection
 * came back empty and the active reader came back undefined every single time:
 * every item-menu action quietly operated on nothing at all.
 */
export function zoteroPane(): any {
  return (Zotero.getMainWindow() as any)?.ZoteroPane ?? null;
}

export function zoteroTabs(): any {
  return (Zotero.getMainWindow() as any)?.Zotero_Tabs ?? null;
}

export function getSelectedItems(): Zotero.Item[] {
  try {
    return zoteroPane()?.getSelectedItems() || [];
  } catch {
    return [];
  }
}

/** The reader for the active tab, if the active tab is a reader. */
export function currentReader(): _ZoteroTypes.ReaderInstance | undefined {
  try {
    const tabID = zoteroTabs()?.selectedID;
    if (!tabID || tabID === "zotero-pane") return undefined;
    return Zotero.Reader.getByTabID(tabID);
  } catch {
    return undefined;
  }
}

export function readerAttachment(
  reader?: _ZoteroTypes.ReaderInstance,
): Zotero.Item | null {
  const r = reader || currentReader();
  if (!r?.itemID) return null;
  return getItem(r.itemID);
}

/** Regular (non-attachment, non-annotation) item behind whatever is selected. */
export function toRegularItem(item?: Zotero.Item | null): Zotero.Item | null {
  if (!item) return null;
  if (item.isAnnotation?.()) {
    const parent = item.parentItem;
    return parent ? toRegularItem(parent) : null;
  }
  if (item.isAttachment()) {
    return item.parentItem || null;
  }
  return item.isRegularItem() ? item : null;
}

/** Items the user is "working on" right now: reader item first, else selection. */
export function contextItems(): Zotero.Item[] {
  const attachment = readerAttachment();
  if (attachment) {
    const parent = toRegularItem(attachment);
    return parent ? [parent] : [];
  }
  const selected = getSelectedItems()
    .map((i) => toRegularItem(i))
    .filter(Boolean) as Zotero.Item[];
  return [...new Map(selected.map((i) => [i.id, i])).values()];
}

export async function bestAttachment(
  item: Zotero.Item | null,
): Promise<Zotero.Item | null> {
  if (!item) return null;
  if (item.isAttachment()) return item;
  try {
    const best = await item.getBestAttachment();
    if (best) return best as unknown as Zotero.Item;
  } catch {
    /* fall through */
  }
  const ids = item.getAttachments?.() || [];
  for (const id of ids) {
    const att = getItem(id);
    if (att?.isPDFAttachment?.()) return att;
  }
  return null;
}

const fullTextCache = new Map<number, { at: number; text: string }>();

/** Plain text of an item's best attachment. Cached for five minutes. */
export async function getFullText(
  item: Zotero.Item | null,
  options: { maxChars?: number; keepReferences?: boolean; pageMarkers?: boolean } = {},
): Promise<string> {
  const attachment = await bestAttachment(item);
  if (!attachment) return "";
  // Prompts ask for "(p. N)" citations, and the outline turns them into links;
  // without page headers the model can only guess the numbers.
  if (options.pageMarkers) {
    const { pages, exact } = await pagedText(attachment);
    if (exact && pages.length > 1) {
      return trimmed(withPageMarkers(pages), options);
    }
  }
  const cached = fullTextCache.get(attachment.id);
  let text = cached && Date.now() - cached.at < 300_000 ? cached.text : "";
  if (!text) {
    text = await extractText(attachment);
    fullTextCache.set(attachment.id, { at: Date.now(), text });
  }
  return trimmed(text, options);
}

function trimmed(
  text: string,
  options: { maxChars?: number; keepReferences?: boolean },
): string {
  if (!options.keepReferences) text = dropReferences(text);
  if (options.maxChars && text.length > options.maxChars) {
    text = `${text.slice(0, options.maxChars)}\n…[truncated]`;
  }
  return text;
}

async function extractText(attachment: Zotero.Item): Promise<string> {
  try {
    if (attachment.isPDFAttachment?.() && (Zotero as any).PDFWorker?.getFullText) {
      const result = await (Zotero as any).PDFWorker.getFullText(
        attachment.id,
        null,
        true,
      );
      const text = typeof result === "string" ? result : result?.text;
      if (text && text.trim()) return text;
    }
  } catch (e) {
    Zotero.debug(`[Prism] PDFWorker text extraction failed: ${e}`);
  }
  try {
    const indexed = await attachment.attachmentText;
    if (indexed && indexed.trim()) return indexed;
  } catch {
    /* not indexed */
  }
  return "";
}

/**
 * Per-page text.
 *
 * Reading from an open reader gives exact page boundaries; otherwise we fall
 * back to the extracted text, splitting on form feeds when the extractor left
 * them behind and approximating page breaks when it did not.
 */
export async function getPageTexts(
  item: Zotero.Item | null,
): Promise<string[]> {
  const attachment = await bestAttachment(item);
  if (!attachment) return [];
  return (await pagedText(attachment)).pages;
}

/** Per-page text, and whether the page breaks are real rather than estimated. */
async function pagedText(
  attachment: Zotero.Item,
): Promise<{ pages: string[]; exact: boolean }> {

  const reader = Zotero.Reader._readers?.find(
    (r: any) => r.itemID === attachment.id,
  );
  if (reader) {
    // Only trust the open viewer when it actually yielded text: a PDF.js that
    // hands back no usable page object must fall through to Zotero's own
    // extraction rather than return a list of empty pages.
    const fromReader = await pageTextsFromReader(reader);
    if (fromReader.some((page) => page.trim())) {
      return { pages: fromReader, exact: true };
    }
  }

  let pageTotal = 0;
  let text = "";
  try {
    const result = await (Zotero as any).PDFWorker?.getFullText(
      attachment.id,
      null,
      true,
    );
    text = typeof result === "string" ? result : (result?.text ?? "");
    pageTotal = typeof result === "object" ? Number(result?.pages) || 0 : 0;
  } catch {
    /* fall through */
  }
  if (!text) text = (await attachment.attachmentText) || "";
  if (!text) return { pages: [], exact: false };

  if (text.includes("\f")) {
    return { pages: text.split("\f").map((p) => p.trim()), exact: true };
  }
  if (!pageTotal || pageTotal < 2) return { pages: [text], exact: false };

  // No page markers: distribute paragraphs evenly so that page references stay
  // approximately right for citation purposes.
  const paragraphs = text.split(/\n\s*\n/);
  const per = Math.max(1, Math.ceil(paragraphs.length / pageTotal));
  const pages: string[] = [];
  for (let i = 0; i < paragraphs.length; i += per) {
    pages.push(paragraphs.slice(i, i + per).join("\n\n"));
  }
  return { pages, exact: false };
}

async function pageTextsFromReader(reader: any): Promise<string[]> {
  try {
    const app = await pdfReady(reader);
    if (!app) return [];
    const total = pageCount(reader) || pageViews(reader).length;
    const out: string[] = [];
    for (let index = 0; index < total; index++) {
      const page = await pageText(reader, app, index);
      if (!page) {
        out.push("");
        continue;
      }
      const lines: string[] = [];
      let y: number | null = null;
      let line = "";
      for (const chunk of page.items) {
        if (!chunk.str) continue;
        const cy = Math.round(chunk.transform[5]);
        if (y === null || Math.abs(cy - y) < 3) {
          line += chunk.str;
        } else {
          if (line.trim()) lines.push(line.trim());
          line = chunk.str;
        }
        y = cy;
      }
      if (line.trim()) lines.push(line.trim());
      out.push(lines.join("\n"));
    }
    return out;
  } catch (e) {
    Zotero.debug(`[Prism] reader page extraction failed: ${e}`);
    return [];
  }
}

export function creatorString(item: Zotero.Item, max = 6): string {
  try {
    const names = item
      .getCreators()
      .map((c: any) => c.lastName || c.name || "")
      .filter(Boolean);
    if (!names.length) return "";
    return names.length > max
      ? `${names.slice(0, max).join(", ")} et al.`
      : names.join(", ");
  } catch {
    return "";
  }
}

/** Compact metadata block used as prompt context. */
export function metaBlock(item: Zotero.Item): string {
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    if (value && value.trim()) lines.push(`${label}: ${value.trim()}`);
  };
  push("Title", item.getField("title") as string);
  push("Authors", creatorString(item));
  push("Year", String(item.getField("date") || "").slice(0, 4));
  push(
    "Venue",
    (item.getField("publicationTitle") ||
      item.getField("proceedingsTitle") ||
      item.getField("publisher")) as string,
  );
  push("DOI", item.getField("DOI") as string);
  push("Abstract", stripHTML(item.getField("abstractNote") as string));
  const tags = item
    .getTags()
    .map((t: any) => t.tag)
    .join(", ");
  push("Tags", tags);
  return lines.join("\n");
}

export interface AnnotationInfo {
  key: string;
  type: string;
  color: string;
  colorName: string;
  text: string;
  comment: string;
  tags: string[];
  page: number;
  pageLabel: string;
  itemID: number;
  parentKey: string;
  dateModified: string;
}

export function readAnnotations(attachment: Zotero.Item): AnnotationInfo[] {
  // `getAnnotations` exists on every item but throws on anything that is not a
  // file attachment ("can only be called on file attachments"). Testing for the
  // method therefore guards nothing: one linked-URL attachment anywhere in the
  // library rejected the whole scan and left the annotation manager — and the
  // literature matrix with it — sitting on "loading…" forever.
  if (!attachment?.isFileAttachment?.()) return [];
  let annotations: Zotero.Item[] = [];
  try {
    annotations = attachment.getAnnotations() as Zotero.Item[];
  } catch {
    return [];
  }
  const out: AnnotationInfo[] = [];
  for (const anno of annotations) {
    let page = -1;
    try {
      page = JSON.parse(anno.annotationPosition as string)?.pageIndex ?? -1;
    } catch {
      /* image annotations may differ */
    }
    out.push({
      key: anno.key,
      type: anno.annotationType as string,
      color: (anno.annotationColor as string) || "",
      colorName: "",
      text: (anno.annotationText as string) || "",
      comment: (anno.annotationComment as string) || "",
      tags: anno.getTags().map((t: any) => t.tag),
      page,
      pageLabel: (anno.annotationPageLabel as string) || String(page + 1),
      itemID: anno.id,
      parentKey: attachment.key,
      dateModified: anno.dateModified as string,
    });
  }
  return out.sort((a, b) => a.page - b.page);
}

/** All annotations under a regular item, across all of its attachments. */
export async function itemAnnotations(
  item: Zotero.Item,
): Promise<AnnotationInfo[]> {
  const out: AnnotationInfo[] = [];
  const attachmentIDs = item.isAttachment() ? [item.id] : item.getAttachments();
  for (const id of attachmentIDs) {
    const att = getItem(id);
    if (att) out.push(...readAnnotations(att));
  }
  return out;
}

export async function createChildNote(
  parent: Zotero.Item,
  html: string,
  tag?: string,
): Promise<Zotero.Item> {
  const note = new Zotero.Item("note");
  note.libraryID = parent.libraryID;
  note.parentID = parent.id;
  note.setNote(html);
  if (tag) note.addTag(tag, 1);
  await note.saveTx();
  return note;
}

/**
 * Show what a command just generated. Without this the progress popup closed
 * and the new note sat unseen under its parent, so people kept waiting for a
 * result that was already there. One note opens in its own window; several are
 * selected in the library instead of opening a window each.
 *
 * The progress popups are dismissed first. Zotero hands the focus back to the
 * main window when one of them closes, so a note window opened while a popup
 * was still counting down was pushed behind the main window a moment later and
 * stayed there — the note opened, and the user saw nothing.
 */
export async function revealNotes(notes: Zotero.Item[]) {
  const pane = zoteroPane();
  if (!pane || !notes.length) return;
  try {
    (Zotero as any).ProgressWindowSet?.closeAll();
    await Zotero.Promise.delay(300);
  } catch (e) {
    Zotero.debug(`[Prism] could not close the progress popups: ${e}`);
  }
  try {
    if (notes.length > 1) {
      await pane.selectItems(notes.map((note) => note.id));
    } else if (typeof pane.openNote === "function") {
      // Zotero 10 deprecates openNoteWindow in favour of this
      await pane.openNote(notes[0].id, { openInWindow: true });
    } else {
      await pane.openNoteWindow(notes[0].id);
    }
  } catch (e) {
    Zotero.debug(`[Prism] could not show the new note: ${e}`);
  }
}

export async function appendToNote(note: Zotero.Item, html: string) {
  note.setNote(`${note.getNote()}\n${html}`);
  await note.saveTx();
}

/** Open (or focus) the PDF and jump to a page / annotation. */
export async function navigateTo(
  attachmentKeyOrID: string | number,
  location: { pageIndex?: number; annotationKey?: string } = {},
) {
  try {
    const attachment =
      typeof attachmentKeyOrID === "number"
        ? getItem(attachmentKeyOrID)
        : (Zotero.Items.getByLibraryAndKey(
            Zotero.Libraries.userLibraryID,
            attachmentKeyOrID,
          ) as Zotero.Item | false);
    if (!attachment) return;
    const reader = await Zotero.Reader.open(
      attachment.id,
      location.annotationKey
        ? ({ annotationKey: location.annotationKey } as any)
        : ({ pageIndex: location.pageIndex ?? 0 } as any),
      { openInWindow: false } as any,
    );
    return reader;
  } catch (e) {
    Zotero.debug(`[Prism] navigate failed: ${e}`);
  }
}

export function itemCitation(item: Zotero.Item): string {
  const author = creatorString(item, 1).split(",")[0] || "Anon.";
  const year = String(item.getField("date") || "").slice(0, 4) || "n.d.";
  return `${author} ${year}`;
}

export function itemURL(item: Zotero.Item): string {
  return `zotero://select/library/items/${item.key}`;
}

/**
 * Item-pane sections: Explore (a reading digest), Backlinks (annotation ↔ note)
 * and Attachments (open, open in a window, first-page preview).
 */

import { config } from "../../../package.json";
import { bi, getLocaleID } from "../../utils/locale";
import { icon16, icon20 } from "../../utils/icons";
import { clear, el } from "../../utils/dom";
import { injectAssets } from "../lens/ui";
import { annotationHeat, readingSummary } from "./reading";
import { colorName } from "./colors";
import { bestAttachment, getItem, getPageTexts, itemAnnotations, navigateTo, toRegularItem, zoteroPane } from "../../utils/item";
import { stripHTML } from "../../utils/text";
import { citedSummary } from "./citations";
import { rankTagsFor } from "./ranks";

/**
 * Zotero renders a custom section once per (tab, item) and never again on its
 * own: adding a note or a highlight left Explore and Backlinks showing the old
 * state until some other item had been selected. It does hand each section a
 * `refresh()` in onInit, so keep those and call them when notes, annotations
 * or attachments change. `epoch` is part of fill()'s cache key, so a refresh
 * really redraws.
 */
const live = new Map<HTMLElement, () => Promise<void>>();
let epoch = 0;
let observerID: string | undefined;
let pending: number | undefined;

function watchChanges() {
  observerID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string, type: string, ids: Array<number | string>) => {
        if (type !== "item") return;
        if (event === "add" || event === "modify") {
          const items = Zotero.Items.get(ids.filter((id) => typeof id === "number") as number[]);
          const relevant = items.some(
            (item: Zotero.Item) =>
              item.isNote() || item.isAttachment() || (item as any).isAnnotation?.(),
          );
          if (!relevant) return;
        } else if (event !== "delete" && event !== "trash") {
          return;
        }
        // An annotation drag fires a burst of modifies; redraw once.
        const win = Zotero.getMainWindow();
        if (!win) return;
        if (pending) win.clearTimeout(pending);
        pending = win.setTimeout(refreshAll, 400);
      },
    },
    ["item"],
    "prism-panes",
  );
}

function refreshAll() {
  pending = undefined;
  epoch++;
  for (const [body, refresh] of live) {
    if (!body.isConnected) {
      live.delete(body);
      continue;
    }
    refresh().catch((e) => Zotero.debug(`[Prism] section refresh failed: ${e}`));
  }
}

function section(options: {
  paneID: string;
  l10n: string;
  iconName: string;
  render: (body: HTMLElement, item: Zotero.Item) => void | Promise<void>;
}) {
  const key = Zotero.ItemPaneManager.registerSection({
    paneID: options.paneID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID(options.l10n),
      icon: icon16(options.iconName),
    },
    sidenav: {
      l10nID: getLocaleID(`${options.l10n}-tooltip`),
      icon: icon20(options.iconName),
    },
    // Zotero's documented split: onRender must be synchronous and is what the
    // section is measured from, so it leaves a sized box; the real work — which
    // has to await annotations and page text — belongs in onAsyncRender.
    onInit: ({ body, refresh }) => {
      live.set(body, refresh);
    },
    onDestroy: ({ body }) => {
      live.delete(body);
    },
    onRender: ({ body }) => {
      if (body.childElementCount) return;
      body.append(
        el(body.ownerDocument, "div", {
          text: bi("Loading…", "正在加载…"),
          style: { padding: "6px 8px", opacity: "0.6", fontSize: "12px" },
        }),
      );
    },
    onAsyncRender: async ({ body, item }) => {
      await fill(body, item, options.render);
    },
    onItemChange: ({ item, setEnabled }) => {
      // Until something enables it, the section and its sidenav button stay
      // hidden.
      setEnabled(!!item);
    },
  });
  // registerSection namespaces the id it hands back; pushing our own paneID
  // meant unregisterSection later looked up a key that does not exist and the
  // sections outlived the plugin.
  if (key) addon.data.spectrum.sections.push(key as string);
}

/**
 * Put the section's content in place for `item`, at most once per item.
 *
 * The placeholder matters: Zotero sizes the section from whatever the body
 * holds when the hook returns, so an empty body collapses it to a bare title
 * row with no way to open it.
 */
async function fill(
  body: HTMLElement,
  item: Zotero.Item | null,
  render: (body: HTMLElement, item: Zotero.Item) => void | Promise<void>,
) {
  if (!item) return;
  const key = `${item.id}:${epoch}`;
  if (body.dataset.prismItem === key && body.childElementCount) return;
  body.dataset.prismItem = key;

  const doc = body.ownerDocument;
  const note = (text: string) =>
    el(doc, "div", {
      text,
      style: { padding: "6px 8px", opacity: "0.6", fontSize: "12px" },
    });
  clear(body);
  body.append(note(bi("Loading…", "正在加载…")));

  await Promise.resolve()
    .then(() => render(body, item))
    .then(() => {
      // A section with an empty body is a title row the user cannot open.
      // Counting child elements is not enough: the renderers always append a
      // wrapper, so an item with no reading time, annotations, notes or tags
      // left a section that was one empty div tall — a title row with nothing
      // under it and no hint that that was the whole story.
      if (!body.textContent?.trim()) {
        body.append(note(bi("Nothing to show for this item yet.", "该条目暂无可展示的内容。")));
      }
    })
    .catch((e) => {
      Zotero.debug(`[Prism] section render failed: ${e}`);
      clear(body);
      body.append(note(bi("Could not load this section.", "该分区加载失败。")));
    });
}

export function registerPanes() {
  watchChanges();
  section({
    paneID: "prism-explore",
    l10n: "section-explore",
    iconName: "explore",
    render: renderExplore,
  });
  section({
    paneID: "prism-backlinks",
    l10n: "section-backlinks",
    iconName: "backlinks",
    render: renderBacklinks,
  });
  section({
    paneID: "prism-attachments",
    l10n: "section-attachments",
    iconName: "attachments",
    render: renderAttachments,
  });
}

export function unregisterPanes() {
  if (observerID) Zotero.Notifier.unregisterObserver(observerID);
  observerID = undefined;
  if (pending) Zotero.getMainWindow()?.clearTimeout(pending);
  pending = undefined;
  live.clear();
  const keys = addon.data.spectrum.sections.splice(0);
  for (const paneID of keys) {
    try {
      Zotero.ItemPaneManager.unregisterSection(paneID);
    } catch {
      /* already gone */
    }
  }
  removeSectionElements(keys);
}

/**
 * Zotero drops a section's element only when it next re-renders the pane, and
 * keeps it if a section with the same key has been registered again by then —
 * which is what an upgrade or a quick disable/enable does. The element keeps
 * the old instance's hooks: after an upgrade the AI section went on running
 * the old code. Take our elements out now; the next render builds new ones.
 */
function removeSectionElements(keys: string[]) {
  for (const win of Zotero.getMainWindows?.() ?? []) {
    for (const details of Array.from(win.document.querySelectorAll("item-details")) as any[]) {
      try {
        for (const elem of Array.from(details.querySelectorAll("item-pane-custom-section")) as HTMLElement[]) {
          const key = elem.dataset.pane || "";
          if (!keys.includes(key)) continue;
          elem.remove();
          details.sidenav?.removePane?.(key);
        }
        // renderCustomSections() skips itself while this matches the manager's
        // update id; clear it so the next render really rebuilds.
        details._lastUpdateCustomSection = "";
      } catch (e) {
        Zotero.debug(`[Prism] could not remove a section element: ${e}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ explore */

async function renderExplore(body: HTMLElement, raw: Zotero.Item) {
  const item = toRegularItem(raw);
  const doc = body.ownerDocument;
  injectAssets(doc);
  clear(body);
  if (!item) return;
  const pane = el(doc, "div", { class: "prism-pane prism-root" });

  const chips = el(doc, "div", { class: "prism-row", style: { flexWrap: "wrap" } });
  const reading = readingSummary(item);
  const heat = annotationHeat(item);
  if (reading.seconds > 30) {
    chips.append(
      el(doc, "span", {
        class: "prism-chip",
        text: `${reading.minutes} ${bi("min read", "分钟")} · ${Math.round(
          reading.coverage * 100,
        )}%`,
      }),
    );
  }
  if (heat.count) {
    chips.append(
      el(doc, "span", { class: "prism-chip", text: `${heat.count} ${bi("annotations", "条标注")}` }),
    );
  }
  for (const tag of rankTagsFor(item)) {
    chips.append(el(doc, "span", { class: "prism-chip", text: tag }));
  }
  const cited = citedSummary(item);
  if (cited) chips.append(el(doc, "span", { class: "prism-chip", text: cited }));
  if (chips.childElementCount) pane.append(chips);

  const abstract = stripHTML(String(item.getField("abstractNote") || ""));
  if (abstract) {
    pane.append(
      el(doc, "div", {
        style: { lineHeight: "1.6", maxHeight: "170px", overflow: "auto" },
        text: abstract,
      }),
    );
  }

  /* annotation colour spread */
  if (Object.keys(heat.colors).length) {
    const legend = el(doc, "div", { class: "prism-row", style: { flexWrap: "wrap" } });
    for (const [color, count] of Object.entries(heat.colors).sort((a, b) => b[1] - a[1])) {
      legend.append(
        el(doc, "span", {
          class: "prism-pill",
          text: `${colorName(color)} ${count}`,
          style: { background: color },
        }),
      );
    }
    pane.append(legend);
  }

  /* latest annotations */
  const annotations = await itemAnnotations(item);
  if (annotations.length) {
    const list = el(doc, "div", { class: "prism-list", style: { maxHeight: "220px" } });
    for (const annotation of annotations.slice(0, 12)) {
      list.append(
        el(
          doc,
          "div",
          {
            class: "prism-anno",
            style: { borderInlineStartColor: annotation.color || "#999" },
            on: {
              click: () => {
                const attachment = attachmentByKey(item, annotation.parentKey);
                if (attachment) {
                  void navigateTo(attachment.id, { annotationKey: annotation.key });
                }
              },
            },
          },
          el(doc, "div", { class: "prism-anno-head", text: `p.${annotation.pageLabel}` }),
          el(doc, "div", { text: (annotation.text || annotation.comment).slice(0, 220) }),
        ),
      );
    }
    pane.append(list);
  }

  /* child notes */
  const noteIDs = item.getNotes?.() || [];
  if (noteIDs.length) {
    const notes = el(doc, "div", { class: "prism-list", style: { maxHeight: "160px" } });
    for (const id of noteIDs.slice(0, 8)) {
      const note = getItem(id);
      if (!note) continue;
      notes.append(
        el(doc, "div", {
          class: "prism-anno",
          text: stripHTML(note.getNote()).slice(0, 160),
          on: { click: () => void zoteroPane()?.selectItem(note.id) },
        }),
      );
    }
    pane.append(notes);
  }

  body.append(pane);
}

function attachmentByKey(item: Zotero.Item, key: string): Zotero.Item | null {
  for (const id of item.getAttachments?.() || []) {
    const attachment = getItem(id);
    if (attachment?.key === key) return attachment;
  }
  return null;
}

/* -------------------------------------------------------------- attachments */

/**
 * Every attachment of the item, with somewhere to go.
 *
 * Opening one beside the item you are reading — a supplement, a second paper,
 * the appendix PDF — takes three clicks through Zotero's own tree; this is the
 * one row it should be. The text preview reads the first page so a file can be
 * identified without opening it at all.
 */
async function renderAttachments(body: HTMLElement, raw: Zotero.Item) {
  const doc = body.ownerDocument;
  injectAssets(doc);
  clear(body);
  const item = toRegularItem(raw) ?? raw;

  const attachments = (item.getAttachments?.() || [])
    .map((id) => getItem(id))
    .filter(Boolean) as Zotero.Item[];
  if (!attachments.length) return;

  const pane = el(doc, "div", { class: "prism-pane" });
  for (const attachment of attachments) {
    pane.append(attachmentRow(doc, attachment));
  }
  body.append(pane);
}

function attachmentRow(doc: Document, attachment: Zotero.Item): HTMLElement {
  const box = el(doc, "div", { class: "prism-anno", style: { cursor: "default" } });
  const head = el(doc, "div", { class: "prism-row" });
  head.append(
    el(doc, "span", {
      text: String(attachment.getField("title") || attachment.key),
      style: { flex: "1", fontWeight: "560" },
    }),
  );

  const isFile = !!attachment.isFileAttachment?.();
  let count = 0;
  if (isFile) {
    // `getAnnotations()` throws on anything that is not a file attachment, so
    // the guard above is the check — testing for the method is not.
    try {
      count = (attachment.getAnnotations() as Zotero.Item[]).length;
    } catch {
      count = 0;
    }
  }
  if (count) {
    head.append(el(doc, "span", { class: "prism-chip", text: `${count} ${bi("ann.", "条标注")}` }));
  }
  box.append(head);

  const actions = el(doc, "div", { class: "prism-row", style: { marginTop: "5px" } });
  const open = (options: { openInWindow?: boolean } = {}) => {
    if (isFile) {
      void Zotero.Reader.open(attachment.id, undefined as any, options as any);
      return;
    }
    const url = String(attachment.getField("url") || "");
    if (url) Zotero.launchURL(url);
  };
  actions.append(
    el(doc, "button", {
      class: "prism-btn",
      text: bi("Open", "打开"),
      on: { click: () => open() },
    }),
  );
  if (isFile) {
    actions.append(
      el(doc, "button", {
        class: "prism-btn",
        text: bi("New window", "在新窗口中打开"),
        on: { click: () => open({ openInWindow: true }) },
      }),
    );
  }

  const preview = el(doc, "div", {
    class: "prism-stat-label",
    style: { marginTop: "5px", display: "none", whiteSpace: "pre-wrap" },
  });
  actions.append(
    el(doc, "button", {
      class: "prism-btn",
      text: bi("Preview", "预览"),
      on: {
        click: async (event: Event) => {
          const button = event.currentTarget as HTMLButtonElement;
          if (preview.style.display !== "none") {
            preview.style.display = "none";
            return;
          }
          preview.style.display = "";
          if (!preview.textContent) {
            preview.textContent = bi("reading…", "正在读取…");
            preview.textContent = await firstPageText(attachment);
          }
          void button;
        },
      },
    }),
  );
  box.append(actions, preview);
  return box;
}

async function firstPageText(attachment: Zotero.Item): Promise<string> {
  try {
    const pages = await getPageTexts(attachment);
    const text = (pages[0] || "").trim();
    if (text) return text.slice(0, 600);
  } catch (e) {
    Zotero.debug(`[Prism] attachment preview failed: ${e}`);
  }
  return bi("No text could be read from this file.", "无法从该文件读取文字。");
}

/* ---------------------------------------------------------------- backlinks */

/**
 * Notes that cite this item's annotations, and the annotations a note cites.
 * Zotero stores the annotation key inside the note HTML, so one LIKE query per
 * key is enough and stays correct across sync.
 */
async function renderBacklinks(body: HTMLElement, raw: Zotero.Item) {
  const doc = body.ownerDocument;
  injectAssets(doc);
  clear(body);
  const pane = el(doc, "div", { class: "prism-pane prism-root" });
  body.append(pane);

  if (raw?.isNote?.()) {
    await renderNoteBacklinks(pane, raw, doc);
    return;
  }
  const item = toRegularItem(raw);
  if (!item) return;

  const annotations = await itemAnnotations(item);
  if (!annotations.length) {
    pane.append(
      el(doc, "div", {
        class: "prism-chip",
        text: bi("No annotations yet.", "暂无标注。"),
      }),
    );
    return;
  }

  const attachmentKeys = [
    ...new Set(annotations.map((annotation) => annotation.parentKey)),
  ];
  const links = await findNotesCiting(
    annotations.map((a) => a.key),
    attachmentKeys,
  );
  if (!links.size) {
    pane.append(
      el(doc, "div", {
        class: "prism-chip",
        text: bi(
          "No note cites these annotations yet.",
          "暂无笔记引用这些标注。",
        ),
      }),
    );
    return;
  }

  for (const [noteID, keys] of links) {
    const note = getItem(noteID);
    if (!note) continue;
    const parent = note.parentItem;
    const block = el(doc, "div", {
      class: "prism-anno",
      style: { borderInlineStartColor: "#2ea8e5" },
      on: { click: () => void zoteroPane()?.selectItem(note.id) },
    });
    block.append(
      el(doc, "div", {
        class: "prism-anno-head",
        text: `${parent ? String(parent.getField("title") || "").slice(0, 40) : bi("Standalone note", "独立笔记")} · ${keys.length} ${bi("links", "处引用")}`,
      }),
      el(doc, "div", { text: stripHTML(note.getNote()).slice(0, 200) }),
    );
    pane.append(block);
  }
}

async function renderNoteBacklinks(pane: HTMLElement, note: Zotero.Item, doc: Document) {
  const html = note.getNote();
  const keys = [...html.matchAll(/annotationKey&quot;:&quot;(\w+)&quot;/g)].map(
    (m) => m[1],
  );
  const alt = [...html.matchAll(/annotation=([A-Z0-9]{8})/g)].map((m) => m[1]);
  const all = [...new Set([...keys, ...alt])];
  if (!all.length) {
    pane.append(
      el(doc, "div", {
        class: "prism-chip",
        text: bi("This note cites no annotations.", "该笔记未引用任何标注。"),
      }),
    );
    return;
  }
  for (const key of all) {
    const annotation = Zotero.Items.getByLibraryAndKey(
      note.libraryID,
      key,
    ) as Zotero.Item | false;
    if (!annotation) continue;
    pane.append(
      el(doc, "div", {
        class: "prism-anno",
        style: { borderInlineStartColor: (annotation.annotationColor as string) || "#999" },
        text: (annotation.annotationText as string) || (annotation.annotationComment as string) || key,
        on: {
          click: () =>
            void navigateTo(annotation.parentID as number, { annotationKey: key }),
        },
      }),
    );
  }
}

/**
 * Notes citing any of these annotations.
 *
 * Zotero embeds the annotation key inside the note HTML, so one query per key
 * would mean hundreds of scans on a heavily annotated paper. Instead this pulls
 * the candidate notes once — those mentioning the attachment at all — and does
 * the per-key matching in memory.
 */
async function findNotesCiting(
  keys: string[],
  attachmentKeys: string[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (!keys.length) return result;
  const wanted = new Set(keys);
  try {
    const clauses = attachmentKeys.map(() => "note LIKE ?").join(" OR ");
    const rows = (await Zotero.DB.queryAsync(
      `SELECT itemID, note FROM itemNotes${clauses ? ` WHERE ${clauses}` : ""}`,
      attachmentKeys.map((key) => `%${key}%`),
    )) as any[];
    for (const row of rows || []) {
      const found = new Set<string>();
      for (const match of String(row.note || "").matchAll(/([A-Z0-9]{8})/g)) {
        if (wanted.has(match[1])) found.add(match[1]);
      }
      if (found.size) result.set(row.itemID, [...found]);
    }
  } catch (e) {
    Zotero.debug(`[Prism] backlink query failed: ${e}`);
  }
  return result;
}

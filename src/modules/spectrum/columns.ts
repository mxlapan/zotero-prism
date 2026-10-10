/**
 * Custom item-tree columns.
 *
 * Every column's data provider must be synchronous, so anything that needs the
 * network (citation counts, journal ranks) reads from a cache that the
 * corresponding "update" command fills in the background.
 */

import { config } from "../../../package.json";
import { bi } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { annotationHeat, readingSummary } from "./reading";
import { getRating, isMarkedRead, setRating } from "./extra";
import { citedFor, citedSummary } from "./citations";
import { rankTagsFor } from "./ranks";

const NS = "http://www.w3.org/1999/xhtml";
/** Star size in the rating column, chosen so five of them fit its fixed width. */
const STAR_PX = 13;

function color(value: number, max: number, base: string): string {
  if (!max || !value) return "transparent";
  const ratio = Math.min(1, Math.max(0.08, value / max));
  return mix(base, ratio);
}

function mix(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.toFixed(3)})`;
}

function cell(doc: Document, className: string, key = ""): HTMLSpanElement {
  const node = doc.createElementNS(NS, "span") as HTMLSpanElement;
  node.className = className;
  // Registered columns get their dataKey prefixed with the plugin id, so the
  // decorator finds its cells by this attribute rather than by class name.
  if (key) node.dataset.prismKey = key;
  return node;
}

export function registerColumns() {
  const columns = addon.data.spectrum.columns;
  const manager = Zotero.ItemTreeManager as any;
  const add = (options: any) => {
    const definition = {
      pluginID: config.addonID,
      // enabledTreeIDs replaced defaultIn/disabledIn; passing the old pair as
      // well made Zotero 10 log a deprecation warning for every column.
      enabledTreeIDs: ["main"],
      zoteroPersist: ["width", "hidden", "sortDirection"],
      ...options,
    };
    try {
      if (typeof manager.registerColumn === "function") {
        const key = manager.registerColumn(definition);
        if (key) columns.push(key as string);
        return;
      }
      // Zotero 7.0 only had the async, plural form.
      void Promise.resolve(manager.registerColumns?.(definition)).then(
        (key: string | string[] | false) => {
          if (!key) return;
          for (const one of Array.isArray(key) ? key : [key]) columns.push(one);
        },
      );
    } catch (e) {
      Zotero.debug(`[Prism] column ${options.dataKey} failed to register: ${e}`);
    }
  };

  if (getPref<boolean>("spectrum.heatmap", true)) {
    add({
      dataKey: "prismHeat",
      label: bi("Reading", "阅读热力"),
      width: "90",
      minWidth: 40,
      dataProvider: (item: Zotero.Item) =>
        String(Math.round(readingSummary(item).seconds)),
      renderCell: (_index: number, _data: string, column: any, _first: boolean, doc: Document) =>
        cell(doc, `cell ${column.className} prism-progress`, "prismHeat"),
    });
  }

  if (getPref<boolean>("spectrum.progressColumn", true)) {
    add({
      dataKey: "prismAnnos",
      label: bi("Annotations", "标注"),
      width: "90",
      minWidth: 40,
      dataProvider: (item: Zotero.Item) => String(annotationHeat(item).count),
      renderCell: (_index: number, _data: string, column: any, _first: boolean, doc: Document) =>
        cell(doc, `cell ${column.className} prism-progress`, "prismAnnos"),
    });
  }

  if (getPref<boolean>("spectrum.ratingColumn", true)) {
    add({
      dataKey: "prismRating",
      label: bi("Rating", "评分"),
      width: "70",
      fixedWidth: true,
      dataProvider: (item: Zotero.Item) => String(getRating(item)),
      renderCell: (_index: number, data: string, column: any, _first: boolean, doc: Document) => {
        const node = cell(doc, `cell ${column.className}`, "prismRating");
        const value = Number(data) || 0;
        // The column is fixed at 70px, so the stars cannot follow Zotero's font
        // size: at "larger" the fifth one was cut off and the rating read
        // "★★★…". They are marks, not text, and keep their own size.
        const stars = doc.createElement("span");
        stars.dataset.prismStars = "1";
        stars.textContent = value ? "★".repeat(value) + "☆".repeat(5 - value) : "☆☆☆☆☆";
        stars.style.fontSize = `${STAR_PX}px`;
        stars.style.letterSpacing = "0";
        stars.style.color = value ? "#e5b95f" : "var(--fill-quinary, #bbb)";
        // The tree's 8px side padding leaves exactly the width five stars take,
        // and the last of them was being traded for an ellipsis.
        node.style.paddingInline = "4px";
        node.style.textOverflow = "clip";
        node.append(stars);
        node.dataset.prismRating = "1";
        return node;
      },
    });
  }

  if (getPref<boolean>("spectrum.tagsColumn", true)) {
    add({
      dataKey: "prismTags",
      label: bi("Tags", "标签"),
      width: "120",
      dataProvider: (item: Zotero.Item) => plainTags(item).join(" "),
      renderCell: (_index: number, _data: string, column: any, _first: boolean, doc: Document) =>
        cell(doc, `cell ${column.className} prism-cell-tags`, "prismTags"),
    });
  }

  if (getPref<boolean>("spectrum.hashTagColumn", true)) {
    add({
      dataKey: "prismHash",
      label: bi("#Tags", "#标签"),
      width: "110",
      dataProvider: (item: Zotero.Item) => hashTags(item).join(" / "),
      renderCell: (_index: number, _data: string, column: any, _first: boolean, doc: Document) =>
        cell(doc, `cell ${column.className} prism-cell-tags`, "prismHash"),
    });
  }

  if (getPref<boolean>("spectrum.rankColumn", true)) {
    add({
      dataKey: "prismRank",
      label: bi("Rank", "分区"),
      width: "110",
      dataProvider: (item: Zotero.Item) => rankTagsFor(item).join(" "),
      renderCell: (_index: number, _data: string, column: any, _first: boolean, doc: Document) =>
        cell(doc, `cell ${column.className} prism-cell-tags`, "prismRank"),
    });
  }

  if (getPref<boolean>("spectrum.citedColumn", true)) {
    add({
      dataKey: "prismCited",
      label: bi("Cited", "被引"),
      width: "90",
      dataProvider: (item: Zotero.Item) => citedSummary(item),
      renderCell: (_index: number, _data: string, column: any, _first: boolean, doc: Document) =>
        cell(doc, `cell ${column.className} prism-cell-tags`, "prismCited"),
    });
  }
}

export function unregisterColumns() {
  const manager = Zotero.ItemTreeManager as any;
  for (const key of addon.data.spectrum.columns.splice(0)) {
    try {
      if (typeof manager.unregisterColumn === "function") {
        manager.unregisterColumn(key);
      } else {
        void manager.unregisterColumns?.(key);
      }
    } catch {
      /* already gone */
    }
  }
}

export interface PickedTag {
  /** The tag as Zotero stores it. */
  tag: string;
  /** What the #Tags column shows for it. */
  label: string;
}

/** Tags matching the configured prefix or regular expression, with their display text. */
export function pickHashTags(
  tags: string[],
  rule: string,
  map: ReplaceMap = [],
): PickedTag[] {
  let picked: PickedTag[] = [];

  if (rule.startsWith("/") && rule.lastIndexOf("/") > 0) {
    const end = rule.lastIndexOf("/");
    try {
      // A g or y flag makes exec() remember where it stopped, and every other
      // tag would then be tested from the middle.
      const flags = (rule.slice(end + 1) || "").replace(/[gy]/g, "");
      const pattern = new RegExp(rule.slice(1, end), flags);
      for (const tag of tags) {
        const match = pattern.exec(tag);
        if (!match) continue;
        picked.push({
          tag,
          label: match.length > 1 ? match.slice(1).filter(Boolean).join(" ") : match[0],
        });
      }
    } catch {
      picked = [];
    }
  } else if (rule.startsWith("~")) {
    const prefix = rule.slice(1);
    picked = tags.filter((tag) => !tag.startsWith(prefix)).map((tag) => ({ tag, label: tag }));
  } else if (rule) {
    picked = tags
      .filter((tag) => tag.startsWith(rule))
      .map((tag) => ({ tag, label: tag.slice(rule.length) }));
  } else {
    picked = tags.map((tag) => ({ tag, label: tag }));
  }
  return picked
    .map(({ tag, label }) => ({ tag, label: applyMap(label, map) }))
    .filter((entry) => entry.label);
}

function tagNames(item: Zotero.Item): string[] {
  return item.getTags?.().map((t: any) => t.tag) || [];
}

function pickedTags(item: Zotero.Item): PickedTag[] {
  return pickHashTags(
    tagNames(item),
    getPref<string>("spectrum.hashTagPrefix", "#").trim(),
    parseMap(getPref<string>("spectrum.hashTagMap", "")),
  );
}

export function hashTags(item: Zotero.Item): string[] {
  return pickedTags(item).map((entry) => entry.label);
}

/**
 * What the Tags column shows: every tag, or — with "keep #Tags out of the Tags
 * column" on — every tag the #Tags column is not already showing.
 */
export function tagsOutside(tags: string[], rule: string, exclusive: boolean): string[] {
  // An empty rule picks everything, and would leave this column blank.
  if (!exclusive || !rule) return tags;
  const taken = new Set(pickHashTags(tags, rule).map((entry) => entry.tag));
  return tags.filter((tag) => !taken.has(tag));
}

function plainTags(item: Zotero.Item): string[] {
  return tagsOutside(
    tagNames(item),
    getPref<string>("spectrum.hashTagPrefix", "#").trim(),
    getPref<boolean>("spectrum.hashTagColumn", true) &&
      getPref<boolean>("spectrum.hashTagExclusive", true),
  );
}

export type ReplaceMap = Array<[RegExp | string, string]>;

/** Parse `A=B, /re/=C,` replacement rules. */
export function parseMap(source: string): ReplaceMap {
  const rules: ReplaceMap = [];
  for (const part of source.split(/,(?![^/]*\/[^/]*=)/)) {
    const raw = part.trim();
    if (!raw) continue;
    const at = raw.indexOf("=");
    if (at < 0) continue;
    const from = raw.slice(0, at).trim();
    const to = raw.slice(at + 1).trim();
    if (from.startsWith("/") && from.lastIndexOf("/") > 0) {
      const end = from.lastIndexOf("/");
      try {
        rules.push([new RegExp(from.slice(1, end), from.slice(end + 1) || ""), to]);
        continue;
      } catch {
        /* fall through to literal */
      }
    }
    rules.push([from, to]);
  }
  return rules;
}

export function applyMap(text: string, rules: ReplaceMap): string {
  let out = text;
  for (const [from, to] of rules) {
    out = typeof from === "string" ? out.split(from).join(to) : out.replace(from, to);
  }
  return out.trim();
}

/* --------------------------------------------------------- cell decoration */

/**
 * Paint the cells Zotero renders itself.
 *
 * Custom columns can render their own DOM, but the heat bars, tag pills and
 * the title background need to reach cells the item tree owns, so Prism
 * observes the tree and decorates rows as they scroll into view.
 */
function itemTreeElement(doc: Document): HTMLElement | null {
  return (doc.getElementById("item-tree-main-default") ||
    doc.querySelector("#zotero-items-tree [id^='item-tree-']") ||
    doc.querySelector("[id^='item-tree-main']")) as HTMLElement | null;
}

function rowIndex(row: HTMLElement): number {
  const match = /-row-(\d+)$/.exec(row.id);
  return match ? Number(match[1]) : -1;
}

export function startTreeDecorator(win: Window, attempt = 0) {
  const doc = win.document;
  const tree = itemTreeElement(doc);
  if (!tree) {
    // A freshly opened window fires load before ZoteroPane builds the tree.
    if (attempt < 20) {
      win.setTimeout(() => startTreeDecorator(win, attempt + 1), 500);
    }
    return;
  }
  let queued = false;

  const paint = () => {
    queued = false;
    const view: any = (win as any).ZoteroPane?.itemsView;
    if (!view) return;
    const rows = tree.querySelectorAll("[id*='-row-']");
    for (const row of Array.from(rows) as HTMLElement[]) {
      const index = rowIndex(row);
      if (index < 0) continue;
      const item: Zotero.Item | undefined = view.getRow?.(index)?.ref;
      if (!item || !item.isRegularItem?.()) continue;
      decorateRow(row, item, doc);
    }
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(paint);
  };

  const observer = new win.MutationObserver(schedule);
  observer.observe(tree, { childList: true, subtree: true, attributes: true });
  tree.addEventListener("scroll", schedule, true);
  tree.addEventListener("mousedown", (event: MouseEvent) => onRatingPress(event, win), true);
  schedule();
  (win as any)._prismTreeObserver = observer;
}

export function stopTreeDecorator(win: Window) {
  try {
    (win as any)._prismTreeObserver?.disconnect();
    delete (win as any)._prismTreeObserver;
  } catch {
    /* ignore */
  }
}

function decorateRow(row: HTMLElement, item: Zotero.Item, doc: Document) {
  // The item tree recycles row elements and clears their contents on every
  // render, so the guard has to live on each cell rather than on the row —
  // otherwise the freshly created (empty) cells would be skipped forever.
  const stamp = `${item.id}:${item.version}:${Date.now() >> 14}:${tagPrefsStamp()}`;

  /* title background = reading heat, bold = unread */
  const primary = row.querySelector(
    ".cell.primary, .cell.title",
  ) as HTMLElement | null;
  if (primary && primary.dataset.prismStamp !== stamp) {
    primary.dataset.prismStamp = stamp;
    decoratePrimary(primary, item);
  }

  fillCell(row, "prismHeat", stamp, (node) => {
    const summary = readingSummary(item);
    node.replaceChildren();
    if (!summary.heat.length) return;
    const pages = summary.numPages || summary.heat.length;
    node.title = `${summary.minutes} min · ${summary.pagesTouched}/${pages} ${bi("pages", "页")}`;
    node.append(
      sparkline(
        doc,
        summary.heat,
        pages,
        summary.maxHeat,
        getPref<string>("spectrum.heatmapColor", "#2ea8e5"),
      ),
    );
  });

  /* annotation density */
  fillCell(row, "prismAnnos", stamp, (node) => {
    const heat = annotationHeat(item);
    node.replaceChildren();
    if (!heat.count) return;
    const max = heat.perPage.reduce((m, v) => Math.max(m, v || 0), 0);
    const pages = Math.max(
      heat.perPage.length,
      readingSummary(item).numPages || 0,
    );
    node.title = `${heat.count} ${bi("annotations", "条标注")}`;
    node.append(sparkline(doc, heat.perPage, pages, max, "#5fb236"));
  });

  /* coloured tag pills */
  fillCell(row, "prismTags", stamp, (node) => {
    node.replaceChildren();
    for (const tag of plainTags(item).slice(0, 8)) {
      node.append(tagPill(doc, tag, tagColor(item, tag)));
    }
  });

  /* the picked tags, without their prefix */
  fillCell(row, "prismHash", stamp, (node) => {
    node.replaceChildren();
    const coloured = getPref<boolean>("spectrum.hashTagColor", true);
    for (const { tag, label } of pickedTags(item).slice(0, 8)) {
      const colour = coloured ? tagColor(item, tag) || autoTagColor(label) : "";
      const pill = tagPill(doc, label, colour);
      pill.title = tag;
      node.append(pill);
    }
  });

  fillCell(row, "prismRank", stamp, (node) => {
    node.replaceChildren();
    for (const tag of rankTagsFor(item)) {
      const pill = doc.createElementNS(NS, "span") as HTMLElement;
      pill.className = "prism-pill";
      pill.textContent = tag;
      pill.style.background = rankColor(tag);
      node.append(pill);
    }
  });

  fillCell(row, "prismCited", stamp, (node) => {
    node.replaceChildren();
    const entries = citedFor(item);
    if (!entries) return;
    for (const [label, value] of Object.entries(entries)) {
      if (label === "fetchedAt") continue;
      const pill = doc.createElementNS(NS, "span") as HTMLElement;
      pill.className = "prism-pill";
      pill.textContent = `${label}${value}`;
      pill.style.background = "#6b7280";
      node.append(pill);
    }
  });
}

/** One bar per page, resampled so a long book stays a handful of nodes. */
function sparkline(
  doc: Document,
  values: number[],
  pages: number,
  max: number,
  base: string,
): HTMLElement {
  const bar = doc.createElementNS(NS, "span") as HTMLElement;
  bar.className = "prism-progress-bar";
  const buckets = Math.max(1, Math.min(pages || values.length, 120));
  const per = (pages || values.length) / buckets;
  for (let i = 0; i < buckets; i++) {
    let value = 0;
    for (let page = Math.floor(i * per); page < Math.ceil((i + 1) * per); page++) {
      value = Math.max(value, values[page] || 0);
    }
    const seg = doc.createElementNS(NS, "span") as HTMLElement;
    seg.className = "prism-progress-seg";
    seg.style.flex = "1";
    seg.style.background = color(value, max, base);
    bar.append(seg);
  }
  return bar;
}

function fillCell(
  row: HTMLElement,
  dataKey: string,
  stamp: string,
  render: (node: HTMLElement) => void,
) {
  const node = row.querySelector(
    `[data-prism-key="${dataKey}"]`,
  ) as HTMLElement | null;
  if (!node || node.dataset.prismStamp === stamp) return;
  node.dataset.prismStamp = stamp;
  render(node);
}

/** Reading heat behind the title, and bold for anything still unread. */
function decoratePrimary(primary: HTMLElement, item: Zotero.Item) {
  if (getPref<boolean>("spectrum.heatmap", true)) {
    const summary = readingSummary(item);
    if (summary.seconds > 5 && summary.heat.length) {
      primary.style.backgroundImage = heatGradient(
        summary.heat,
        summary.maxHeat,
        getPref<string>("spectrum.heatmapColor", "#2ea8e5"),
      );
      primary.style.backgroundSize = "100% 100%";
      primary.style.backgroundRepeat = "no-repeat";
    } else {
      primary.style.backgroundImage = "";
    }
  }
  if (getPref<boolean>("spectrum.boldUnread", true)) {
    const marked = isMarkedRead(item);
    const read =
      marked === undefined ? readingSummary(item).seconds > 90 : marked;
    primary.style.fontWeight = read ? "" : "650";
  }
}

function heatGradient(heat: number[], max: number, base: string): string {
  if (!max || !heat.length) return "";
  // A 600-page book would otherwise produce 1200 gradient stops, so long
  // documents are resampled into a fixed number of buckets.
  const buckets = Math.min(heat.length, 160);
  const perBucket = heat.length / buckets;
  const stops: string[] = [];
  for (let i = 0; i < buckets; i++) {
    let value = 0;
    for (let page = Math.floor(i * perBucket); page < Math.ceil((i + 1) * perBucket); page++) {
      value = Math.max(value, heat[page] || 0);
    }
    const from = ((i / buckets) * 100).toFixed(2);
    const to = (((i + 1) / buckets) * 100).toFixed(2);
    const c = color(value, max, base);
    stops.push(`${c} ${from}%`, `${c} ${to}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function tagPill(doc: Document, text: string, colour: string): HTMLElement {
  const pill = doc.createElementNS(NS, "span") as HTMLElement;
  pill.className = "prism-pill";
  pill.textContent = text.slice(0, 12);
  pill.style.background = colour || "var(--fill-quinary, #ccc)";
  pill.style.color = colour ? "#fff" : "var(--fill-primary, #222)";
  return pill;
}

/** The tag settings a row was painted with, so changing one repaints it. */
function tagPrefsStamp(): string {
  return [
    getPref<string>("spectrum.hashTagPrefix", "#"),
    getPref<string>("spectrum.hashTagMap", ""),
    getPref<boolean>("spectrum.hashTagExclusive", true),
    getPref<boolean>("spectrum.hashTagColor", true),
  ].join("\u0001");
}

/** Dark enough for white text, far enough apart to tell neighbours from each other. */
const AUTO_TAG_COLORS = [
  "#c2553f", "#b9741d", "#8a8a1f", "#4f9a3a", "#2a9d8f",
  "#2b8fc7", "#4f6fd6", "#8a63d2", "#b455b8", "#c24d7c",
];

/**
 * A colour for a tag Zotero has none for. Zotero only lets a handful of tags be
 * given a colour, so the rest take a fixed one from their name: the same tag is
 * the same colour on every row, and a nested tag follows its top level.
 */
export function autoTagColor(label: string): string {
  const key = label.split("/")[0].trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AUTO_TAG_COLORS[hash % AUTO_TAG_COLORS.length];
}

function tagColor(item: Zotero.Item, tag: string): string {
  try {
    const colors = Zotero.Tags.getColors(item.libraryID) as any;
    const entry = colors?.get?.(tag);
    return entry?.color || "";
  } catch {
    return "";
  }
}

function rankColor(tag: string): string {
  if (/1区|Q1|A\+|CCF-?A|T1/i.test(tag)) return "#d64d4d";
  if (/2区|Q2|CCF-?B|T2|^A$/i.test(tag)) return "#e5893f";
  if (/3区|Q3|CCF-?C|T3/i.test(tag)) return "#5fb236";
  if (/4区|Q4/i.test(tag)) return "#7c8590";
  if (/警示|预警|WARN/i.test(tag)) return "#111827";
  return "#2ea8e5";
}

/**
 * Clicking the rating column sets the rating at the clicked star.
 *
 * On press, not on click: selecting a row redraws its cells, so on a row that
 * was not already selected the click landed on a node that no longer existed
 * and the first click only ever selected the row. The row still selects — this
 * handler lets the event through.
 */
async function onRatingPress(event: MouseEvent, win: Window) {
  const target = event.target as HTMLElement;
  const cellNode = target?.closest?.("[data-prism-rating]") as HTMLElement | null;
  if (!cellNode) return;
  const row = cellNode.closest("[id*='-row-']") as HTMLElement;
  const index = row ? rowIndex(row) : -1;
  if (index < 0) return;
  const item: Zotero.Item | undefined = (win as any).ZoteroPane?.itemsView?.getRow?.(
    index,
  )?.ref;
  if (!item?.isRegularItem?.()) return;
  // Measure the stars themselves: they no longer fill the cell, and taking the
  // ratio across the whole cell put the click a star out near the edges.
  const marks = cellNode.querySelector("[data-prism-stars]") as HTMLElement | null;
  const rect = (marks || cellNode).getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
  const value = Math.max(0, Math.min(5, Math.ceil(ratio * 5)));
  await setRating(item, getRating(item) === value ? 0 : value);
}

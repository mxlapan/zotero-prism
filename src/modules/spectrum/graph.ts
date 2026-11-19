/**
 * Graph view: related items, shared tags and — once the gap radar has fetched
 * references — real citation links between the papers in your library.
 */

import { bi } from "../../utils/locale";
import { el } from "../../utils/dom";
import { getPref, setPref } from "../../utils/prefs";
import { injectAssets } from "../lens/ui";
import {
  ForceGraph,
  LABEL_MODES,
  nodeLabel,
  tagLinks,
  type GraphEdge,
  type LabelFields,
  type LabelMode,
} from "../../lib/forcegraph";
import { itemCitation, toRegularItem } from "../../utils/item";
import { referencesOf } from "../beam/gapRadar";

let tabID = "";

export const LABEL_NAMES: Record<LabelMode, [string, string]> = {
  citation: ["Author & year", "作者+年份"],
  title: ["Title", "标题"],
  shortTitle: ["Short title", "短标题"],
  venue: ["Publication & year", "期刊+年份"],
  none: ["None", "不显示"],
};

function labelMode(): LabelMode {
  const mode = getPref<string>("spectrum.graphLabel", "citation") as LabelMode;
  return LABEL_MODES.includes(mode) ? mode : "citation";
}

const TYPE_COLORS: Record<string, string> = {
  journalArticle: "#2ea8e5",
  conferencePaper: "#5fb236",
  book: "#e5893f",
  bookSection: "#e5b95f",
  thesis: "#a28ae5",
  preprint: "#7c8590",
  report: "#d64d4d",
};

export async function openGraphView(win: Window) {
  if (tabID) {
    try {
      (win as any).Zotero_Tabs.select(tabID);
      return;
    } catch {
      tabID = "";
    }
  }
  let dispose = () => {};
  const { id, container } = (win as any).Zotero_Tabs.add({
    type: "prism-graph",
    title: bi("Graph", "关系图谱"),
    select: true,
    // Zotero 10's Zotero_Tabs._update() reads tab.data.icon for every
    // non-library tab, so a tab added without `data` throws before add()
    // even returns — and then keeps throwing on every later tab change.
    data: {},
    onClose: () => {
      tabID = "";
      dispose();
    },
  });
  tabID = id;

  const doc = win.document;
  injectAssets(doc);
  const root = el(doc, "div", {
    class: "prism-root",
    style: { position: "relative", height: "100%", overflow: "hidden" },
  });
  container.append(root);

  const toolbar = el(doc, "div", {
    class: "prism-row",
    style: {
      position: "absolute",
      zIndex: "2",
      top: "10px",
      left: "12px",
      right: "12px",
      flexWrap: "wrap",
    },
  });
  const search = el(doc, "input", {
    class: "prism-search",
    attrs: { type: "search", placeholder: bi("Highlight…", "搜索并高亮…") },
    style: { maxWidth: "220px" },
  }) as HTMLInputElement;
  const locate = el(doc, "button", {
    class: "prism-btn",
    text: bi("Locate selected", "定位选中条目"),
  });
  const status = el(doc, "span", { class: "prism-chip", text: bi("building…", "正在构建…") });

  /* Which field the nodes are labelled with (GitHub #1). */
  const picker = el(doc, "span", {
    class: "prism-row",
    style: { gap: "4px", marginInlineStart: "6px" },
  });
  picker.append(el(doc, "span", { class: "prism-stat-label", text: bi("Label:", "节点文字：") }));
  const chips = new Map<LabelMode, HTMLElement>();
  const markActive = (mode: LabelMode) => {
    for (const [id, chip] of chips) {
      const active = id === mode;
      chip.style.background = active ? "var(--prism-accent)" : "";
      chip.style.color = active ? "#fff" : "";
    }
  };
  for (const mode of LABEL_MODES) {
    const [en, zh] = LABEL_NAMES[mode];
    const chip = el(doc, "span", {
      class: "prism-tag",
      text: bi(en, zh),
      on: {
        click: () => {
          setPref("spectrum.graphLabel", mode);
          markActive(mode);
          graph.relabel((node) => nodeLabel(node.data as LabelFields, mode));
        },
      },
    });
    chips.set(mode, chip);
    picker.append(chip);
  }
  markActive(labelMode());
  toolbar.append(search, locate, status, picker);

  const canvas = el(doc, "canvas", {
    style: { width: "100%", height: "100%", display: "block" },
  }) as HTMLCanvasElement;
  const tip = el(doc, "div", {
    class: "prism-chip",
    style: {
      position: "fixed",
      zIndex: "3",
      pointerEvents: "none",
      display: "none",
      maxWidth: "320px",
      background: "var(--prism-bg)",
    },
  });
  root.append(canvas, toolbar, tip);

  const resize = () => {
    canvas.width = root.clientWidth || 900;
    canvas.height = root.clientHeight || 620;
  };
  resize();

  const graph = new ForceGraph(canvas, {
    colorOf: (node) => TYPE_COLORS[node.group || ""] || "#8a8f98",
    onSelect: (node) => {
      const id = Number(node.id);
      if (id) void (win as any).ZoteroPane.selectItem(id);
    },
    onHover: (node, x, y) => {
      if (!node) {
        tip.style.display = "none";
        return;
      }
      tip.style.display = "block";
      tip.style.left = `${x + 14}px`;
      tip.style.top = `${y + 14}px`;
      // Whatever the label shows, the tip names the paper in full.
      const fields = node.data as LabelFields | undefined;
      tip.textContent =
        [fields?.citation, fields?.title].filter(Boolean).join(" · ") || node.label;
    },
  });

  const observer = new (win as any).ResizeObserver(() => {
    resize();
    graph.draw();
  });
  observer.observe(root);
  dispose = () => {
    try {
      observer.disconnect();
    } catch {
      /* window already gone */
    }
    graph.stop();
  };

  const { nodes, edges } = await buildGraph(win);
  // Read now, not before the build: the picker may have been clicked meanwhile.
  const mode = labelMode();
  for (const node of nodes) node.label = nodeLabel(node.data, mode);
  graph.setData(nodes, edges);
  status.textContent = `${nodes.length} ${bi("items", "个条目")} · ${edges.length} ${bi("links", "条连线")}`;

  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    if (!query) {
      graph.setHighlight([]);
      return;
    }
    graph.setHighlight(
      nodes
        .filter((node) =>
          [node.data.citation, node.data.title, node.data.shortTitle, node.data.venue]
            .join(" ")
            .toLowerCase()
            .includes(query),
        )
        .map((node) => node.id),
    );
  });
  locate.addEventListener("click", () => {
    const item = (win as any).ZoteroPane.getSelectedItems()[0];
    const regular = toRegularItem(item);
    if (regular) graph.focus(String(regular.id));
  });
}

async function buildGraph(win: Window) {
  const pane = (win as any).ZoteroPane;
  let items: Zotero.Item[] = [];
  const row = pane?.getCollectionTreeRow?.();
  try {
    if (row?.isCollection?.()) {
      items = row.ref.getChildItems(false, false) as Zotero.Item[];
    } else {
      const all = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
      items = all as Zotero.Item[];
    }
  } catch {
    items = [];
  }
  items = items.filter((item) => item.isRegularItem?.()).slice(0, 400);

  const field = (item: Zotero.Item, name: string) => {
    try {
      return String(item.getField(name as any) || "");
    } catch {
      return ""; // not a field of this item type
    }
  };
  const nodes = items.map((item) => {
    const data: LabelFields = {
      citation: itemCitation(item),
      title: field(item, "title"),
      shortTitle: field(item, "shortTitle"),
      venue:
        field(item, "journalAbbreviation") ||
        field(item, "publicationTitle") ||
        field(item, "proceedingsTitle") ||
        field(item, "conferenceName") ||
        field(item, "university") ||
        field(item, "publisher"),
      year: String(item.getField("date") || "").match(/\d{4}/)?.[0] || "",
    };
    return {
      id: String(item.id),
      label: data.citation,
      group: item.itemType,
      weight: 1 + (item.getTags?.().length || 0) * 0.3,
      data,
    };
  });

  const present = new Set(items.map((item) => item.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (a: number, b: number, kind: string, weight = 1) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}-${kind}` : `${b}-${a}-${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: String(a), target: String(b), kind, weight });
  };

  /* Zotero's own "related" relations */
  for (const item of items) {
    for (const uri of item.relatedItems || []) {
      try {
        const related = (await Zotero.URI.getURIItem(uri)) as Zotero.Item | false;
        if (related && present.has(related.id)) addEdge(item.id, related.id, "related", 1.6);
      } catch {
        /* dangling relation */
      }
    }
  }

  /* shared tags, weighted by how specific they are */
  const tagsByItem = new Map<number, string[]>();
  for (const item of items) {
    tagsByItem.set(item.id, (item.getTags?.() || []).map((tag: { tag: string }) => tag.tag));
  }
  for (const link of tagLinks(tagsByItem, items.length)) {
    addEdge(link.a, link.b, "tag", link.weight);
  }

  /* citation edges, when references have already been fetched */
  const byDOI = new Map<string, number>();
  for (const item of items) {
    const doi = String(item.getField("DOI") || "").toLowerCase();
    if (doi) byDOI.set(doi, item.id);
  }
  for (const item of items) {
    for (const reference of referencesOf(item.key)) {
      const target = reference.doi ? byDOI.get(reference.doi.toLowerCase()) : undefined;
      if (target && present.has(target)) addEdge(item.id, target, "cite", 2);
    }
  }

  return { nodes, edges };
}

export function graphOpen() {
  return !!tabID;
}

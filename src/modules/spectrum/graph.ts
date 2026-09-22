/**
 * Graph view: related items, shared tags and — once the gap radar has fetched
 * references — real citation links between the papers in your library.
 */

import { bi } from "../../utils/locale";
import { el } from "../../utils/dom";
import { injectAssets } from "../lens/ui";
import { ForceGraph, tagLinks, type GraphEdge } from "../../lib/forcegraph";
import { itemCitation, toRegularItem } from "../../utils/item";
import { referencesOf } from "../beam/gapRadar";

let tabID = "";

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
  toolbar.append(search, locate, status);

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
      tip.textContent = node.data?.title || node.label;
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
        .filter((node) => `${node.label} ${node.data?.title || ""}`.toLowerCase().includes(query))
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

  const nodes = items.map((item) => ({
    id: String(item.id),
    label: itemCitation(item),
    group: item.itemType,
    weight: 1 + (item.getTags?.().length || 0) * 0.3,
    data: { title: String(item.getField("title") || "") },
  }));

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

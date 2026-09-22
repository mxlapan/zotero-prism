/**
 * Organising the library: nested tags, saved column views and quick filters.
 */

import { config } from "../../../package.json";
import { bi } from "../../utils/locale";
import { clear, el, makeDraggable } from "../../utils/dom";
import { getJSONPref, setJSONPref, getPref } from "../../utils/prefs";
import { injectAssets } from "../lens/ui";

/* ------------------------------------------------------------- nested tags */

export interface TagNode {
  name: string;
  full: string;
  count: number;
  children: Map<string, TagNode>;
}

/** Build a tree from `#Method/Longitudinal` style tags. */
export async function buildTagTree(libraryID?: number): Promise<TagNode> {
  const root: TagNode = { name: "", full: "", count: 0, children: new Map() };
  const prefix = getPref<string>("spectrum.hashTagPrefix", "#");
  let tags: any[] = [];
  try {
    tags = (await Zotero.Tags.getAll(
      libraryID ?? Zotero.Libraries.userLibraryID,
    )) as any[];
  } catch {
    return root;
  }
  for (const entry of tags) {
    const tag = String(entry.tag ?? entry.name ?? "");
    if (prefix && !tag.startsWith(prefix)) continue;
    const path = tag.slice(prefix.length).split("/").filter(Boolean);
    if (!path.length) continue;
    let node = root;
    let full = prefix;
    for (const part of path) {
      full = full === prefix ? `${prefix}${part}` : `${full}/${part}`;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, full, count: 0, children: new Map() };
        node.children.set(part, child);
      }
      child.count++;
      node = child;
    }
  }
  return root;
}

/**
 * Every tag in the branch, the branch's own tag included.
 *
 * `#Method/Survey` is a real tag as well as a node, and `#Method/Survey/Online`
 * is a different tag that has to move with it — renaming only the node the user
 * clicked would tear the tree in half.
 */
async function tagsUnder(full: string, libraryID: number): Promise<string[]> {
  let tags: any[] = [];
  try {
    tags = (await Zotero.Tags.getAll(libraryID)) as any[];
  } catch {
    return [];
  }
  return tags
    .map((entry) => String(entry.tag ?? entry.name ?? ""))
    .filter((tag) => tag === full || tag.startsWith(`${full}/`));
}

/** Rename a branch by its last segment; children follow. Returns tags changed. */
export async function renameTagBranch(
  full: string,
  leaf: string,
  libraryID = Zotero.Libraries.userLibraryID,
): Promise<number> {
  const clean = leaf.trim().replace(/\//g, "");
  if (!clean) return 0;
  // A depth-1 node carries the configured prefix ("#Method"); deeper nodes
  // carry their parent path ("#Method/Survey"). Dropping the prefix on the
  // first case would move the branch out of the tree entirely.
  const cut = full.lastIndexOf("/");
  const next =
    cut >= 0
      ? `${full.slice(0, cut + 1)}${clean}`
      : `${getPref<string>("spectrum.hashTagPrefix", "#")}${clean}`;
  if (next === full) return 0;
  const tags = await tagsUnder(full, libraryID);
  let changed = 0;
  for (const tag of tags) {
    try {
      await Zotero.Tags.rename(libraryID, tag, `${next}${tag.slice(full.length)}`);
      changed++;
    } catch (e) {
      Zotero.debug(`[Prism] renaming ${tag} failed: ${e}`);
    }
  }
  return changed;
}

/** Delete a branch and everything under it. Returns tags removed. */
export async function deleteTagBranch(
  full: string,
  libraryID = Zotero.Libraries.userLibraryID,
): Promise<number> {
  const tags = await tagsUnder(full, libraryID);
  const ids = tags
    .map((tag) => Zotero.Tags.getID(tag))
    .filter((id): id is number => typeof id === "number");
  if (!ids.length) return 0;
  try {
    await (Zotero.Tags.removeFromLibrary as any)(libraryID, ids);
  } catch (e) {
    Zotero.debug(`[Prism] deleting tags failed: ${e}`);
    return 0;
  }
  return ids.length;
}

/** Apply a tag filter to the item list, trying each API Zotero exposes. */
export function applyTagFilter(win: Window, tags: string[]): boolean {
  const pane: any = (win as any).ZoteroPane;
  const selection = new Set(tags);
  try {
    const row = pane?.getCollectionTreeRow?.();
    if (row?.setTags) {
      row.setTags(selection);
      pane.itemsView?.refreshAndMaintainSelection?.();
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    if (pane?.itemsView?.setFilter) {
      pane.itemsView.setFilter("tags", selection);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    if (pane?.tagSelector?.setTagSelection) {
      pane.tagSelector.setTagSelection(selection);
      return true;
    }
  } catch {
    /* give up quietly */
  }
  return false;
}

let tagPanel: HTMLElement | null = null;

export function toggleNestedTags(win: Window) {
  if (tagPanel?.isConnected) {
    tagPanel.remove();
    tagPanel = null;
    return;
  }
  const doc = win.document;
  injectAssets(doc);
  const root = el(doc, "div", {
    class: "prism-panel prism-root",
    style: { width: "300px", height: "460px", left: "24px", top: "84px" },
  });
  const head = el(
    doc,
    "div",
    { class: "prism-head" },
    el(doc, "span", { class: "prism-logo" }),
    el(doc, "span", { class: "prism-title", text: bi("Nested tags", "嵌套标签") }),
  );
  const actions = el(doc, "div", { class: "prism-head-actions" });
  actions.append(
    el(doc, "button", {
      class: "prism-icon-btn",
      text: "✕",
      on: {
        click: () => {
          root.remove();
          tagPanel = null;
        },
      },
    }),
  );
  head.append(actions);
  const body = el(doc, "div", { class: "prism-body" });
  root.append(head, body);
  (doc.body || doc.documentElement).append(root);
  makeDraggable(head, root);
  tagPanel = root;
  void renderTagTree(body, win);
}

async function renderTagTree(body: HTMLElement, win: Window) {
  const doc = win.document;
  clear(body);
  const tree = await buildTagTree();
  if (!tree.children.size) {
    body.append(
      el(doc, "div", {
        class: "prism-empty",
        text: bi(
          "No nested tags yet. Create a tag like #Method/Survey to start.",
          "暂无嵌套标签。可创建形如 #方法/问卷 的标签。",
        ),
      }),
    );
    return;
  }
  const active = new Set<string>();

  const draw = (node: TagNode, host: HTMLElement, depth: number) => {
    for (const child of [...node.children.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const row = el(doc, "div", {
        style: {
          paddingInlineStart: `${depth * 12}px`,
          display: "flex",
          alignItems: "center",
          gap: "5px",
          cursor: "pointer",
          borderRadius: "5px",
          padding: "2px 4px",
        },
      });
      const caret = el(doc, "span", {
        text: child.children.size ? "▾" : "·",
        style: { opacity: "0.5", width: "10px" },
      });
      const label = el(doc, "span", { text: `${child.name}` });
      const count = el(doc, "span", {
        text: String(child.count),
        style: { marginInlineStart: "auto", opacity: "0.5", fontSize: "11px" },
      });
      row.append(caret, label, count);
      row.title = bi(
        "Click to filter · right-click to rename or delete",
        "点击筛选 · 右键重命名或删除",
      );
      row.addEventListener("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        void editBranch(win, child, body);
      });
      row.addEventListener("click", (event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey) {
          if (active.has(child.full)) active.delete(child.full);
          else active.add(child.full);
        } else {
          active.clear();
          active.add(child.full);
        }
        row.style.background = active.has(child.full) ? "var(--prism-accent-soft)" : "";
        if (!applyTagFilter(win, [...active])) {
          new ztoolkit.ProgressWindow(config.addonName)
            .createLine({
              text: bi(
                "Could not apply the tag filter in this Zotero version.",
                "当前 Zotero 版本不支持标签筛选。",
              ),
              type: "fail",
            })
            .show(3000);
        }
      });
      host.append(row);
      if (child.children.size) {
        const sub = el(doc, "div");
        host.append(sub);
        draw(child, sub, depth + 1);
      }
    }
  };
  draw(tree, body, 0);
}

/**
 * Rename or delete a whole branch.
 *
 * The tag tree was read-only, which is the half of the feature that saves no
 * time: the reason to keep `#Method/Survey` tags is being able to rename the
 * scheme later without touching every item by hand.
 */
async function editBranch(win: Window, node: TagNode, body: HTMLElement) {
  const prompts = Services.prompt;
  const index = { value: 0 };
  const chosen = prompts.select(
    win as any,
    config.addonName,
    node.full,
    [bi("Rename…", "重命名…"), bi("Delete", "删除")],
    index,
  );
  if (!chosen) return;

  if (index.value === 0) {
    const result = { value: node.name };
    const ok = prompts.prompt(
      win as any,
      config.addonName,
      bi("New name for this branch:", "该分支的新名称："),
      result,
      "",
      { value: false },
    );
    if (!ok || !result.value.trim()) return;
    const changed = await renameTagBranch(node.full, result.value);
    report(changed, bi("tags renamed", "个标签已重命名"));
  } else {
    const ok = prompts.confirm(
      win as any,
      config.addonName,
      `${bi("Delete", "删除")} ${node.full} ${bi(
        "and every tag under it? Items keep their other tags.",
        "及其下所有标签？条目的其他标签不受影响。",
      )}`,
    );
    if (!ok) return;
    const removed = await deleteTagBranch(node.full);
    report(removed, bi("tags deleted", "个标签已删除"));
  }
  await renderTagTree(body, win);
}

function report(count: number, what: string) {
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text: `${count} ${what}`, type: count ? "success" : "fail" })
    .show(2500);
}

/* ------------------------------------------------------------- view groups */

export interface ViewGroup {
  name: string;
  persist: string;
}

export function saveViewGroup(name: string) {
  const persist = String(Zotero.Prefs.get("pane.persist") || "");
  const groups = getJSONPref<ViewGroup[]>("spectrum.viewGroups", []).filter(
    (group) => group.name !== name,
  );
  groups.push({ name, persist });
  setJSONPref("spectrum.viewGroups", groups);
}

export function applyViewGroup(name: string) {
  const group = getJSONPref<ViewGroup[]>("spectrum.viewGroups", []).find(
    (candidate) => candidate.name === name,
  );
  if (!group) return false;
  Zotero.Prefs.set("pane.persist", group.persist);
  try {
    Zotero.ItemTreeManager.refreshColumns?.();
    for (const win of Zotero.getMainWindows()) {
      (win as any).ZoteroPane?.itemsView?.refreshAndMaintainSelection?.();
    }
  } catch {
    /* the layout lands on the next restart */
  }
  return true;
}

export function listViewGroups(): ViewGroup[] {
  return getJSONPref<ViewGroup[]>("spectrum.viewGroups", []);
}

export function deleteViewGroup(name: string) {
  setJSONPref(
    "spectrum.viewGroups",
    listViewGroups().filter((group) => group.name !== name),
  );
}

/* ------------------------------------------------------------ quick filter */

const FILTER_NAME = "⧉ Prism filter";

/**
 * Filter the middle pane by item type using a single reusable saved search,
 * which is removed again as soon as the filter is cleared.
 */
export async function quickFilterByType(win: Window, itemType: string | null) {
  const libraryID = Zotero.Libraries.userLibraryID;
  const existing = (await findFilterSearch(libraryID)) as Zotero.Search | null;
  if (!itemType) {
    if (existing) await existing.eraseTx();
    (win as any).ZoteroPane?.collectionsView?.selectLibrary?.(libraryID);
    return;
  }
  const search = (existing || new Zotero.Search()) as any;
  if (!existing) search.libraryID = libraryID;
  search.name = FILTER_NAME;
  try {
    (search as any).removeCondition?.(0);
  } catch {
    /* new search */
  }
  const conditions = (search as any).getConditions?.() || {};
  for (const id of Object.keys(conditions)) {
    try {
      (search as any).removeCondition(Number(id));
    } catch {
      /* ignore */
    }
  }
  search.addCondition("libraryID", "is", String(libraryID));
  search.addCondition("itemType", "is", itemType);
  await search.saveTx();
  const tree = (win as any).ZoteroPane?.collectionsView;
  try {
    if (typeof tree?.selectSearch === "function") {
      await tree.selectSearch(search.id);
    } else if (typeof tree?.selectByID === "function") {
      await tree.selectByID(`S${search.id}`);
    }
  } catch (e) {
    Zotero.debug(`[Prism] quick filter select failed: ${e}`);
  }
}

/**
 * `Zotero.Searches` exposes ids, not objects, so the reusable filter search is
 * found by walking them. Without this the filter would leak a new saved search
 * on every click and never clean itself up.
 */
async function findFilterSearch(libraryID: number) {
  try {
    const ids = await Zotero.Searches.getAllIDs(libraryID);
    for (const id of ids) {
      const search = Zotero.Searches.get(id) as Zotero.Search | false;
      if (search && search.name === FILTER_NAME) return search;
    }
  } catch (e) {
    Zotero.debug(`[Prism] could not look up the filter search: ${e}`);
  }
  return null;
}

export async function clearQuickFilter() {
  const existing = await findFilterSearch(Zotero.Libraries.userLibraryID);
  if (existing) await (existing as Zotero.Search).eraseTx();
}

export const QUICK_TYPES = [
  "journalArticle",
  "conferencePaper",
  "book",
  "bookSection",
  "thesis",
  "preprint",
  "report",
  "webpage",
];

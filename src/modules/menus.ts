/** Every menu entry Prism contributes. */

import { config } from "../../package.json";
import { bi, getString } from "../utils/locale";
import { icon16 } from "../utils/icons";
import { contextItems } from "../utils/item";
import { aiAnnotate, aiFillNote, aiOutline, aiSummary, birdsEyeView, listNoteTemplates, suggestTags } from "./lens/apps";
import { indexItems } from "./lens/rag";
import { updateCitations } from "./spectrum/citations";
import { updateRanks } from "./spectrum/ranks";
import { translateMetadata } from "./refract/metadata";
import { translateViaService, serviceConfigured } from "./refract/service";
import { openAnnotationManager, buildMatrixForItems } from "./spectrum/annotations";
import { openGraphView } from "./spectrum/graph";
import { openDashboard } from "./beam/dashboard";
import { claimMatrixToNote } from "./beam/claims";
import { addItemWatch, addQueryWatch, runWatches } from "./beam/watchlist";
import { enrol } from "./beam/review";
import { saveCurrentGroup, restoreGroup, tabGroupsForMenu } from "./spectrum/tabs";
import {
  toggleNestedTags,
  saveViewGroup,
  listViewGroups,
  applyViewGroup,
  deleteViewGroup,
  quickFilterByType,
  QUICK_TYPES,
} from "./spectrum/organise";
import { openColorEditor } from "./spectrum/colors";
import { togglePanel, openSettings } from "./lens/panel";
import { getPref } from "../utils/prefs";

type MenuData = _ZoteroTypes.MenuManager.MenuData<any>;

function hasMenuManager(): boolean {
  return typeof (Zotero as any).MenuManager?.registerMenu === "function";
}

function register(menuID: string, target: any, menus: MenuData[]) {
  if (!hasMenuManager()) return;
  try {
    const id = Zotero.MenuManager.registerMenu({
      menuID,
      pluginID: config.addonID,
      target,
      menus,
    } as any);
    if (id) addon.data.menuIDs.push(id as string);
  } catch (e) {
    Zotero.debug(`[Prism] menu registration failed (${menuID}): ${e}`);
  }
}


/* ------------------------------------------------------------------ menus */

/**
 * Prism builds its menus as XUL by hand.
 *
 * `Zotero.MenuManager` is the documented route and it does register the row,
 * but the submenu it creates came up inert — the "Prism ›" entry is there and
 * opening it yields nothing. Building the popup ourselves is what long-lived
 * Zotero plugins do, it is the same mechanism the surrounding entries use, and
 * it lets the row carry an icon like its neighbours.
 */
type Entry =
  | { separator: true }
  | { label: string; children: () => Entry[]; enabled?: () => boolean }
  | { label: string; run: () => void; enabled?: () => boolean };

const SEP: Entry = { separator: true };

function item(label: string, run: () => void, enabled?: () => boolean): Entry {
  return { label, run, enabled };
}

/** A nested menu. Its rows are built when the parent popup opens. */
function submenu(label: string, children: () => Entry[], enabled?: () => boolean): Entry {
  return { label, children, enabled };
}

/** A Fluent-backed label, falling back to the id so a row is never blank. */
function label(key: string, fallbackEN: string, fallbackZH: string): string {
  const text = getString(key);
  return text === key ? bi(fallbackEN, fallbackZH) : text;
}

function itemEntries(): Entry[] {
  const items = () => contextItems();
  const first = () => contextItems()[0];
  return [
    item(label("menu-summarize", "AI summary → note", "AI 总结 → 笔记"), () =>
      void aiSummary(items()),
    ),
    item(label("menu-outline", "AI outline → note", "AI 大纲 → 笔记"), () =>
      void aiOutline(items()),
    ),
    item(label("menu-annotate", "AI annotate PDF", "AI 标注 PDF"), () => {
      const target = first();
      if (target) void aiAnnotate(target);
    }),
    item(label("menu-fill-note", "AI fill note from template", "AI 按模板填写笔记"), () =>
      void fillNoteFlow(items()),
    ),
    item(label("menu-birdseye", "Bird's-eye view (Markdown)", "文献鸟瞰（Markdown）"), () =>
      void birdsEyeView(items()),
    ),
    SEP,
    item(label("menu-matrix", "Literature matrix", "文献矩阵"), () =>
      void buildMatrixForItems(items()),
    ),
    item(label("menu-claim-matrix", "Claim × evidence matrix", "观点 × 证据矩阵"), () =>
      void claimMatrixToNote(items()),
    ),
    item(label("menu-index-library", "Index for semantic search", "建立语义索引"), () =>
      void indexItems(items(), { force: true }),
    ),
    SEP,
    item(
      label("menu-translate-meta", "Translate title and abstract", "翻译标题与摘要"),
      () => void translateMetadata(items()),
      () => refractOn(),
    ),
    item(
      label("menu-translate-fulltext", "Translate full text", "全文翻译"),
      () => {
        const target = first();
        if (target) void translateViaService(target);
      },
      () => refractOn() && serviceConfigured(),
    ),
    SEP,
    item(label("menu-update-cited", "Update citations", "更新被引数"), () =>
      void updateCitations(items()),
    ),
    item(label("menu-update-rank", "Update journal ranks", "更新期刊分区"), () =>
      void updateRanks(items()),
    ),
    SEP,
    item(label("menu-add-watch", "Watch for new citations", "追踪新引用"), () => {
      for (const target of items().slice(0, 10)) addItemWatch(target);
    }),
    item(label("menu-ask", "Ask Prism about this…", "向棱镜提问…"), () =>
      togglePanel(mainWindow()),
    ),
  ];
}

/** The Settings → Translation master switch. */
function refractOn() {
  return getPref<boolean>("enableRefract", true);
}

function toolsEntries(): Entry[] {
  return [
    item(label("rhythm-title", "Dashboard", "仪表盘"), () =>
      void openDashboard(mainWindow()),
    ),
    item(label("section-annotations", "Annotations", "标注管理"), () =>
      void openAnnotationManager(mainWindow()),
    ),
    item(label("matrix-title", "Literature matrix", "文献矩阵"), () =>
      void openAnnotationManager(mainWindow(), "matrix"),
    ),
    item(label("menu-tab-group-save", "Save tabs as a group", "将标签页保存为组"), () =>
      saveCurrentGroup(mainWindow()),
    ),
    item(
      label("menu-tab-group-open", "Reopen a tab group…", "恢复标签组…"),
      () => {
        const groups = tabGroupsForMenu();
        const index = { value: 0 };
        const ok = Services.prompt.select(
          Zotero.getMainWindow() as any,
          config.addonName,
          bi("Choose a tab group:", "选择标签组："),
          groups.map((group) => `${group.name} (${group.tabs.length})`),
          index,
        );
        if (ok) void restoreGroup(groups[index.value]);
      },
      () => tabGroupsForMenu().length > 0,
    ),
    SEP,
    ...extraToolsEntries(),
  ];
}

function mainWindow(): Window {
  return Zotero.getMainWindow() as unknown as Window;
}

/* ------------------------------------------------------------- XUL building */

const MENU_SLOTS: Array<{ popupID: string; menuID: string; entries: () => Entry[] }> = [
  { popupID: "zotero-itemmenu", menuID: "prism-itemmenu", entries: itemEntries },
  { popupID: "menu_ToolsPopup", menuID: "prism-toolsmenu", entries: toolsEntries },
];

function fillPopup(doc: Document, popup: Element, entries: Entry[]) {
  while (popup.firstChild) popup.firstChild.remove();
  for (const entry of entries) {
    if ("separator" in entry) {
      popup.append(doc.createXULElement("menuseparator"));
      continue;
    }
    if ("children" in entry) {
      const nested = doc.createXULElement("menu");
      nested.setAttribute("label", entry.label);
      if (entry.enabled && !entry.enabled()) nested.setAttribute("disabled", "true");
      const sub = doc.createXULElement("menupopup");
      // Same rule as the top level: an empty popup never opens, so it is filled
      // now and refreshed when it is shown.
      fillPopup(doc, sub, entry.children());
      sub.addEventListener("popupshowing", (event: Event) => {
        if (event.target !== sub) return;
        fillPopup(doc, sub, entry.children());
      });
      nested.append(sub);
      popup.append(nested);
      continue;
    }
    const node = doc.createXULElement("menuitem");
    node.setAttribute("label", entry.label);
    if (entry.enabled && !entry.enabled()) node.setAttribute("disabled", "true");
    node.addEventListener("command", () => {
      try {
        entry.run();
      } catch (e) {
        Zotero.debug(`[Prism] menu action failed (${entry.label}): ${e}`);
      }
    });
    popup.append(node);
  }
}

function buildMenu(doc: Document, menuID: string, entries: () => Entry[]) {
  const menu = doc.createXULElement("menu");
  menu.id = menuID;
  menu.classList.add("menu-iconic");
  menu.setAttribute("label", bi("Prism", "棱镜 Prism"));
  menu.setAttribute("image", icon16());

  const popup = doc.createXULElement("menupopup");
  // Filled now as well as on open: an empty <menupopup> never opens, so a
  // listener that fails to fire would look exactly like a dead menu.
  fillPopup(doc, popup, entries());
  popup.addEventListener("popupshowing", (event: Event) => {
    if (event.target !== popup) return;
    fillPopup(doc, popup, entries());
  });
  menu.append(popup);
  return menu;
}

const HOOKS: Array<{ popup: Element; handler: EventListener }> = [];

/** Idempotent: safe to call on every window load. */
export function installWindowMenus(win: Window) {
  const doc = win.document;
  for (const slot of MENU_SLOTS) {
    try {
      const popup = doc.getElementById(slot.popupID);
      if (!popup) continue;
      const attach = () => {
        let menu: Element | null = doc.getElementById(slot.menuID);
        if (!menu) {
          menu = buildMenu(doc, slot.menuID, slot.entries);
          popup.append(menu);
        }
        // Zotero hides and shows the item menu's rows as it rebuilds it; make
        // sure ours is never left behind hidden.
        menu.removeAttribute("hidden");
      };
      attach();
      // Re-attach on open: Zotero rebuilds the item context menu each time,
      // and a row that was dropped would be indistinguishable from a bug.
      const handler = (event: Event) => {
        if (event.target !== popup) return;
        attach();
      };
      popup.addEventListener("popupshowing", handler);
      HOOKS.push({ popup, handler });
    } catch (e) {
      Zotero.debug(`[Prism] could not install ${slot.menuID}: ${e}`);
    }
  }
}

function removeWindowMenus(win: Window) {
  for (const slot of MENU_SLOTS) {
    try {
      win.document.getElementById(slot.menuID)?.remove();
    } catch {
      /* window already gone */
    }
  }
}

/** Hooks span every window, so they are dropped once, not per window. */
function dropMenuHooks() {
  for (const hook of HOOKS.splice(0)) {
    try {
      hook.popup.removeEventListener("popupshowing", hook.handler);
    } catch {
      /* window already gone */
    }
  }
}

export function registerMenus() {
  for (const win of Zotero.getMainWindows()) {
    installWindowMenus(win as unknown as Window);
  }

  /* The tab context menu has no stable popup id to hang XUL off, so it stays
     on the plugin API — a single row, and a no-op if the API is missing. */
  register("prism-tab", "main/tab", [
    {
      menuType: "menuitem",
      l10nID: `${config.addonRef}-tab-save-group`,
      onCommand: () => saveCurrentGroup(Zotero.getMainWindow() as unknown as Window),
    },
  ]);
}

function toolsItem(key: string, fallbackEN: string, fallbackZH: string, handler: () => void): Entry {
  return item(label(key, fallbackEN, fallbackZH), handler);
}

/** The remaining Tools entries. */
function extraToolsEntries(): Entry[] {
  return [
    toolsItem("menu-graph", "Graph view", "关系图谱", () => void openGraphView(mainWindow())),
    toolsItem("menu-nested-tags", "Nested tags", "嵌套标签", () => toggleNestedTags(mainWindow())),
    toolsItem("menu-colors", "Name highlight colours…", "标注颜色命名…", () => void openColorEditor(mainWindow())),
    submenu(label("menu-quick-filter", "Quick filter", "快速筛选"), filterEntries),
    submenu(label("menu-views", "Column views", "视图组"), viewEntries),
    toolsItem("menu-enrol", "Enrol annotations for review", "将标注加入复习队列", () => {
      void enrol(contextItems()).then((added) =>
        new ztoolkit.ProgressWindow(config.addonName)
          .createLine({
            text: bi(`${added} cards added`, `已加入 ${added} 张卡片`),
            type: "success",
          })
          .show(3000),
      );
    }),
    toolsItem("menu-watch-topic", "Watch an arXiv query…", "追踪 arXiv 检索式…", () => {
      const win = Zotero.getMainWindow() as any;
      const result = { value: "" };
      if (
        Services.prompt.prompt(
          win,
          config.addonName,
          bi("arXiv query to watch:", "要追踪的 arXiv 检索式："),
          result,
          "",
          { value: false },
        ) &&
        result.value.trim()
      ) {
        addQueryWatch(result.value.trim());
        void runWatches({ quiet: true });
      }
    }),
    toolsItem("menu-watch-run", "Check watchlist now", "立即检查新文追踪", () => void runWatches({ reveal: true })),
    toolsItem("menu-suggest-tags", "Suggest tags", "推荐标签", () => void tagFlow()),
    toolsItem("menu-settings", "Settings…", "设置…", () => openSettings()),
  ];
}

/**
 * Filter the middle pane by item type.
 *
 * The filter itself had been written and tested and then never given a way in:
 * `quickFilterByType` was referenced by nothing at all, so the feature existed
 * only in the source.
 */
function filterEntries(): Entry[] {
  const win = mainWindow();
  const rows: Entry[] = QUICK_TYPES.map((type) =>
    item(itemTypeLabel(type), () => void quickFilterByType(win, type)),
  );
  rows.push(
    SEP,
    item(label("menu-filter-clear", "Clear filter", "清除筛选"), () =>
      void quickFilterByType(win, null),
    ),
  );
  return rows;
}

function itemTypeLabel(itemType: string): string {
  try {
    const text = Zotero.ItemTypes.getLocalizedString(itemType);
    if (text) return text;
  } catch {
    /* fall back to the raw type */
  }
  return itemType;
}

/** Save, apply and — new — delete a saved column layout. */
function viewEntries(): Entry[] {
  const groups = listViewGroups();
  const rows: Entry[] = [
    item(label("menu-view-save", "Save current column view…", "保存当前视图组…"), () => {
      const win = Zotero.getMainWindow() as any;
      const result = { value: bi("View", "视图") };
      if (
        Services.prompt.prompt(
          win,
          config.addonName,
          bi("Name this column view:", "视图组名称："),
          result,
          "",
          { value: false },
        )
      ) {
        saveViewGroup(result.value);
      }
    }),
  ];
  if (!groups.length) return rows;
  rows.push(SEP);
  for (const group of groups) {
    rows.push(item(group.name, () => void applyViewGroup(group.name)));
  }
  rows.push(
    SEP,
    item(label("menu-view-delete", "Delete a column view…", "删除视图组…"), () => {
      const index = { value: 0 };
      const ok = Services.prompt.select(
        Zotero.getMainWindow() as any,
        config.addonName,
        bi("Delete which view?", "选择要删除的视图组："),
        groups.map((group) => group.name),
        index,
      );
      if (ok) deleteViewGroup(groups[index.value].name);
    }),
  );
  return rows;
}

async function fillNoteFlow(items: Zotero.Item[]) {
  if (!items.length) return;
  const templates = await listNoteTemplates();
  const win = Zotero.getMainWindow() as any;
  const index = { value: 0 };
  const ok = Services.prompt.select(
    win,
    config.addonName,
    bi("Choose a note template:", "选择笔记模板："),
    templates.map((template) => template.name),
    index,
  );
  if (!ok) return;
  for (const item of items) {
    await aiFillNote(item, templates[index.value].html);
  }
}

async function tagFlow() {
  const items = contextItems();
  if (!items.length) return;
  const results = await suggestTags(items);
  const win = Zotero.getMainWindow() as any;
  for (const { item, tags } of results) {
    if (!tags.length) continue;
    const result = { value: tags.join(", ") };
    const ok = Services.prompt.prompt(
      win,
      config.addonName,
      `${String(item.getField("title") || "").slice(0, 60)}\n${bi(
        "Tags to add (edit or clear):",
        "将要添加的标签（可修改或清空）：",
      )}`,
      result,
      "",
      { value: false },
    );
    if (!ok) continue;
    for (const tag of result.value.split(",").map((t) => t.trim()).filter(Boolean)) {
      item.addTag(tag, 1);
    }
    await item.saveTx();
  }
}

export function unregisterMenus() {
  for (const menuID of addon.data.menuIDs.splice(0)) {
    try {
      Zotero.MenuManager.unregisterMenu(menuID);
    } catch {
      /* already gone */
    }
  }
  dropMenuHooks();
  for (const win of Zotero.getMainWindows()) {
    removeWindowMenus(win as unknown as Window);
  }
}

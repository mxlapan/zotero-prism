/**
 * Tab groups.
 *
 * Zotero already lists open tabs (the `⌄` button on the tab bar) and reopens
 * the last closed one with Ctrl+Shift+T, so Prism does not repeat either. What
 * it adds is the one thing Zotero has no notion of: parking a whole reading
 * session under a name and bringing it back days later.
 */

import { bi } from "../../utils/locale";
import { getJSONPref, setJSONPref } from "../../utils/prefs";
import { getItem, toRegularItem } from "../../utils/item";

interface TabRef {
  itemID: number;
  title: string;
  key?: string;
}

export interface TabGroup {
  name: string;
  at: number;
  tabs: TabRef[];
}

function readOpenTabs(win: Window): TabRef[] {
  const tabs: TabRef[] = [];
  const bar = (win as any).Zotero_Tabs;
  for (const tab of bar?._tabs || []) {
    if (tab.type !== "reader" || !tab.data?.itemID) continue;
    const item = getItem(tab.data.itemID);
    tabs.push({
      itemID: tab.data.itemID,
      title: tab.title || item?.getDisplayTitle?.() || "",
      key: item?.key,
    });
  }
  return tabs;
}

export function saveCurrentGroup(win: Window, name?: string) {
  const tabs = readOpenTabs(win);
  if (!tabs.length) return;
  const label =
    name ||
    `${bi("Session", "会话")} ${new Date().toLocaleDateString()} ${new Date()
      .toLocaleTimeString()
      .slice(0, 5)}`;
  const groups = getJSONPref<TabGroup[]>("spectrum.tabGroups", []);
  groups.unshift({ name: label, at: Date.now(), tabs });
  setJSONPref("spectrum.tabGroups", groups.slice(0, 40));
}

export async function restoreGroup(group: TabGroup) {
  for (const tab of group.tabs) {
    if (!getItem(tab.itemID)) continue;
    try {
      await Zotero.Reader.open(tab.itemID);
    } catch {
      /* attachment may be gone */
    }
  }
}

export function tabGroupsForMenu(): TabGroup[] {
  return getJSONPref<TabGroup[]>("spectrum.tabGroups", []);
}

export function currentTabItems(win: Window): Zotero.Item[] {
  return readOpenTabs(win)
    .map((tab) => toRegularItem(getItem(tab.itemID)))
    .filter(Boolean) as Zotero.Item[];
}

/* ------------------------------------------------------------ tab type ---
   Zotero derives a tab's content type from the text before the first dash, so
   every Prism tab is of type "prism". */
const TAB_TYPE = "prism";

/** Prism's own tabs, newest last. */
function prismTabs(win: Window): any[] {
  const tabs = (win as any).Zotero_Tabs?._tabs || [];
  return tabs.filter((tab: any) => String(tab?.type || "").startsWith(`${TAB_TYPE}-`));
}

/**
 * Teach Zotero how to restore a Prism tab — by not restoring it.
 *
 * Zotero writes every open tab into the session, and on the next launch calls
 * `restoreState` for each one and destructures the result. For an unknown type
 * it substitutes a hook that returns undefined, so the destructuring throws and
 * the restore loop aborts: every tab after ours, the user's readers included,
 * failed to come back. A dashboard or a graph carries no state worth keeping
 * across restarts, so an empty result is the honest answer.
 */
export function registerTabType(win: Window) {
  const hooks = (win as any).Zotero_Tabs?.tabHooks;
  if (!hooks?.restoreState) return;
  hooks.restoreState[TAB_TYPE] = async () => ({ itemID: null });
}

export function unregisterTabType(win: Window) {
  try {
    delete (win as any).Zotero_Tabs?.tabHooks?.restoreState?.[TAB_TYPE];
  } catch {
    /* window already gone */
  }
}

/**
 * Close Prism's tabs before the window goes.
 *
 * The hook above cannot help on the launch that follows, because Zotero
 * restores the session before any plugin has started. Leaving no Prism tab in
 * the session is what actually keeps that from happening.
 */
export function closePrismTabs(win: Window) {
  for (const tab of prismTabs(win)) {
    try {
      (win as any).Zotero_Tabs.close(tab.id);
    } catch {
      /* already gone */
    }
  }
}

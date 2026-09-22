/** Keyboard shortcuts. */

import { togglePanel } from "./lens/panel";
import { openDashboard } from "./beam/dashboard";
import { openAnnotationManager } from "./spectrum/annotations";
import { currentReader } from "../utils/item";
import { hasOverlay, toggleOriginal, translateReader } from "./refract/fulltext";
import { getPref } from "../utils/prefs";

type Callback = Parameters<ZToolkit["Keyboard"]["register"]>[0];

let callback: Callback | undefined;

export function registerShortcuts() {
  if (callback) return;
  callback = (_event, options) => {
    const keyboard = options.keyboard;
    if (!keyboard) return;
    for (const combo of COMBOS) {
      if (keyboard.equals(combo)) {
        run(combo);
        return;
      }
    }
  };
  ztoolkit.Keyboard.register(callback);
}

// Two of these had to move. Ctrl/Cmd+Shift+A is taken twice over in Zotero 10
// — Copy Citation in the library, Read Aloud in the reader — and ours won in
// one place and lost in the other; Ctrl/Cmd+Shift+P is now Zotero's command
// palette, which is registered outside the <key> set and so is invisible to a
// scan of it. H (highlights) and D (dashboard) were checked against the running
// app and do nothing of Zotero's own. Translation was Ctrl/Cmd+Shift+L until it
// turned out to be taken twice as well: Zotero's own "focus the library" in the
// main window, and Read Aloud in the reader, whose capture listener on the
// reader window stops the event before ours ever sees it. B, for bilingual, is
// bound nowhere in Zotero 10: not the pane, the reader or the note editor.
const COMBOS = ["accel,/", "accel,shift,d", "accel,shift,h", "accel,shift,b"] as const;
type Combo = (typeof COMBOS)[number];

function run(combo: Combo) {
  const win = Zotero.getMainWindow() as unknown as Window;
  if (!win) return;
  switch (combo) {
    case "accel,/":
      togglePanel(win);
      return;
    case "accel,shift,d":
      void openDashboard(win);
      return;
    case "accel,shift,h":
      void openAnnotationManager(win);
      return;
    case "accel,shift,b": {
      if (!getPref<boolean>("enableRefract", true)) return;
      const reader = currentReader();
      if (!reader) return;
      if (hasOverlay(reader)) toggleOriginal(reader);
      else void translateReader(reader);
    }
  }
}


const bound = new WeakSet<object>();
/**
 * Every reader listener, so shutdown can take it off again. A listener left
 * behind keeps the old plugin's code alive: after an in-place upgrade Ctrl+/
 * in an open reader still opened the *old* panel, with the old bugs.
 */
const attached: Array<{ doc: WeakRef<Document>; handler: (event: KeyboardEvent) => void }> = [];

/**
 * The same four shortcuts, for documents inside the reader.
 *
 * `ztoolkit.Keyboard` does not act on a key pressed while the focus sits in the
 * reader's iframe — verified: with this listener gone, Ctrl+Shift+H there does
 * nothing at all — so the shortcuts were dead in the one place Ctrl+/ and
 * Ctrl+Shift+B are most wanted.
 *
 * The same document reaches us through more than one wrapper, so the guard is
 * keyed off the underlying object in our own compartment: a flag stored on the
 * document itself is set on one wrapper and missing from the other, and two
 * handlers toggling the panel cancel out — which looks exactly like a dead
 * shortcut too.
 */
export function attachReaderShortcuts(doc: Document) {
  const target = ((doc as any).wrappedJSObject ?? doc) as Document;
  if (bound.has(target)) return;
  bound.add(target);
  const handler = (event: KeyboardEvent) => {
    const accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
    if (!accel || event.altKey) return;
    const key = String(event.key || "").toLowerCase();
    let combo: Combo | null = null;
    if (!event.shiftKey && key === "/") combo = "accel,/";
    else if (event.shiftKey && key === "d") combo = "accel,shift,d";
    else if (event.shiftKey && key === "h") combo = "accel,shift,h";
    else if (event.shiftKey && key === "b") combo = "accel,shift,b";
    if (!combo) return;
    event.preventDefault();
    event.stopPropagation();
    run(combo);
  };
  target.addEventListener("keydown", handler, true);
  attached.push({ doc: new WeakRef(target), handler });
}

export function unregisterShortcuts() {
  if (callback) {
    try {
      ztoolkit.Keyboard.unregister(callback);
    } catch {
      /* already gone */
    }
    callback = undefined;
  }
  for (const { doc, handler } of attached.splice(0)) {
    try {
      doc.deref()?.removeEventListener("keydown", handler, true);
    } catch {
      /* the reader closed; its document is already gone */
    }
  }
}

export const SHORTCUTS: Array<[string, string, string]> = [
  ["Ctrl/Cmd + /", "Ask Prism", "浮窗问答"],
  ["Ctrl/Cmd + Shift + D", "Prism dashboard", "仪表盘"],
  ["Ctrl/Cmd + Shift + H", "Annotation manager", "标注管理"],
  ["Ctrl/Cmd + Shift + B", "Translate / show original", "全文翻译 / 切换原文"],
];

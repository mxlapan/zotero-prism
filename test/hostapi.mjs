/**
 * Contract checks against the Zotero 10 host APIs.
 *
 * Every rule here corresponds to a bug that shipped: the type checker cannot
 * see any of them, because `zotero-types` describes Zotero 7 and the reader's
 * compartment boundary is invisible to TypeScript entirely.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const ok = (name, cond, extra = "") => {
  if (!cond) fails.push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`);
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}
/** Comments are prose about these rules; only code should be matched. */
const strip = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = walk(join(root, "src")).map((path) => [path, strip(readFileSync(path, "utf8"))]);
const hooksSource = readFileSync(join(root, "src/hooks.ts"), "utf8");
const rel = (path) => path.slice(root.length + 1);

/* ---------------------------------------------------------------- tabs ---
   Zotero 10's Zotero_Tabs._update() reads `tab.data.icon` for every non-library
   tab. A tab added without `data` throws inside add() — before it returns the
   container — and then throws again on every later tab change, which breaks
   Zotero's own tab bar, not just ours. */
const tabAdds = [];
for (const [path, source] of sources) {
  // annotations.ts holds the tab manager in a local, so match the call shape
  // rather than the receiver's name — a missed call site is the bug itself.
  for (const match of source.matchAll(/\.add\s*\(\s*\{(?=[^;]*\btype\s*:\s*["'`]prism-)/g)) {
    // the argument object, up to the matching brace
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    tabAdds.push([path, source.slice(match.index, i)]);
  }
}
// Three tabs exist today (dashboard, annotations, graph). The count guards the
// pattern itself: if it silently stops matching, the rule below passes vacuously.
ok(
  "the tab-opening call sites are still being found",
  tabAdds.length >= 3,
  `${tabAdds.length} add() call(s) found`,
);
const dataless = tabAdds.filter(([, text]) => !/\bdata\s*:/.test(text)).map(([path]) => rel(path));
ok("every Zotero_Tabs.add passes `data`", dataless.length === 0, dataless.join(", "));

/* Zotero saves every open tab into the session and, on the next launch,
   destructures the result of a `restoreState` hook it looks up by tab type. A
   plugin type with no hook gets a default that returns undefined: the restore
   throws and every tab after it — the user's readers included — is lost. The
   hook is registered too late to help that launch, so the tabs must also be
   closed before the window goes. */
const tabsModule = readFileSync(join(root, "src/modules/spectrum/tabs.ts"), "utf8");
ok(
  "a restoreState hook is assigned for the plugin's tab type",
  /restoreState\s*\[[^\]]+\]\s*=/.test(tabsModule),
);
const unload = hooksSource.slice(hooksSource.indexOf("async function onMainWindowUnload"));
ok(
  "onMainWindowUnload closes the plugin's tabs",
  /closePrismTabs\s*\(/.test(unload.slice(0, unload.indexOf("\n}"))),
);

/* ------------------------------------------------------- reader boundary ---
   Zotero 10 runs the PDF viewer in an unprivileged iframe. An object or array
   built on the plugin's side of that boundary reaches PDF.js as an opaque
   wrapper: calls either throw ("can't access property 0") or, worse, read every
   field as undefined and return NaN. Arguments must be built with
   `contentObject()`, and the geometry helper that took an array is gone. */
const banned = sources.filter(([, source]) => /convertToViewportRectangle/.test(source)).map(([p]) => rel(p));
ok(
  "no convertToViewportRectangle (passes an array across the boundary)",
  banned.length === 0,
  banned.join(", "),
);

// getViewport / render / getTextContent take an options object; a literal there
// is the bug. Allow `contentObject(...)` and no-argument calls.
const viewerCalls = [];
// Only files that actually reach into the viewer; `markdown.render(text)` and
// friends live on this side of the boundary and are fine.
const viewerFiles = sources.filter(([, source]) =>
  /pdfApp|pdfWindow|pdfDocument|pageViews|PDFViewerApplication/.test(source),
);
for (const [path, source] of viewerFiles) {
  for (const match of source.matchAll(/\.(getViewport|render)\s*\(\s*([^)]*)/g)) {
    const arg = match[2].trim();
    if (!arg || arg.startsWith("contentObject(")) continue;
    viewerCalls.push(`${rel(path)}: .${match[1]}(${arg.slice(0, 30)}…`);
  }
}
ok(
  "PDF.js option objects are built with contentObject()",
  viewerCalls.length === 0,
  viewerCalls.join(" | "),
);

// getPage() hands back a wrapped proxy whose methods are invisible.
const getPageUses = [];
for (const [path, source] of sources) {
  for (const match of source.matchAll(/(\w+)\s*=\s*(?:await\s+)?([^;\n]*getPage\s*\([^;\n]*)/g)) {
    if (!/unwrap\s*\(/.test(match[2])) getPageUses.push(`${rel(path)}: ${match[0].trim().slice(0, 60)}`);
  }
}
ok("getPage() results are unwrapped", getPageUses.length === 0, getPageUses.join(" | "));

/* ------------------------------------------------------------- styling ---
   The item tree's Prism cells are styled by prism.css. Without it the heat and
   annotation sparklines collapse to zero height and the tag pills run together,
   so the columns look empty rather than broken. It must be injected when the
   window loads, not as a side effect of some pane rendering. */
const windowLoad = hooksSource.slice(hooksSource.indexOf("async function onMainWindowLoad"));
ok(
  "onMainWindowLoad injects the stylesheet",
  /injectAssets\s*\(/.test(windowLoad.slice(0, windowLoad.indexOf("\n}"))),
);

/* ------------------------------------------------------------ shortcuts ---
   ztoolkit.Keyboard does not act on keys pressed while the focus is inside the
   reader's iframe — with the reader-side listener removed, Ctrl+Shift+A there
   does nothing — so the binding below is what keeps the shortcuts alive where
   they matter most. */
const keys = readFileSync(join(root, "src/modules/keys.ts"), "utf8");
ok("keys.ts exports a reader-side binding", /export function attachReaderShortcuts/.test(keys));
ok(
  "the guard is keyed off the unwrapped document",
  /wrappedJSObject[\s\S]{0,120}bound\.(has|add)/.test(keys),
);
const reader = strip(readFileSync(join(root, "src/modules/reader.ts"), "utf8"));
const onToolbar = reader.slice(reader.indexOf("function onToolbar"));
ok(
  "the reader toolbar handler binds the shortcuts",
  /bindReaderKeys|attachReaderShortcuts/.test(onToolbar.slice(0, onToolbar.indexOf("\n}"))),
);
ok(
  "and it keeps retrying until the PDF frame exists",
  /function bindReaderKeys[\s\S]{0,700}pdfDocument\([\s\S]{0,200}setTimeout/.test(reader),
);

/* Zotero 10's own main-window <key> bindings, enumerated from the running app.
   A plugin shortcut that lands on one of these either shadows Zotero's command
   or loses to it, depending on where the focus is — Ctrl/Cmd+Shift+A did both:
   it stole Copy Citation in the library and lost to Read Aloud in the reader. */
const ZOTERO_ACCEL = new Set([";", "a", "c", "f", "g", "q", "v", "w", "x", "y", "z"]);
// P (command palette) and A (Read Aloud, in the reader) are registered outside
// the <key> set, so scanning that set alone would miss them; both were found by
// pressing them in the running app.
//
// Two more sources the <key> scan cannot see, and Ctrl/Cmd+Shift+L was in both:
//  - the reader's own keydown handler (resource/reader/reader.js), a capture
//    listener on the reader's window that calls stopPropagation, so it always
//    beats ours: `${pm}-Shift-g`, `-l` and `-r` (both Read Aloud), `-z`;
//  - Zotero's configurable shortcuts, `extensions.zotero.keys.*` in
//    defaults/preferences/zotero.js, which are Ctrl/Cmd+Shift+<key>:
//    S N O L K A C Y R ` ;
// T reopens a closed tab.
const ZOTERO_ACCEL_SHIFT = new Set([
  "a", "c", "f", "i", "g", "x", "p",
  "l", "r", "z",
  "s", "n", "o", "k", "y", "`", ";",
  "t",
]);
const combosLine = /const COMBOS = \[([^\]]*)\]/.exec(keys);
ok("the shortcut list is still readable", !!combosLine);
const combos = combosLine ? [...combosLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
const clashes = combos.filter((combo) => {
  const parts = combo.split(",");
  const key = parts[parts.length - 1].toLowerCase();
  const shift = parts.includes("shift");
  return shift ? ZOTERO_ACCEL_SHIFT.has(key) : ZOTERO_ACCEL.has(key);
});
ok(
  "no shortcut collides with a Zotero binding",
  clashes.length === 0,
  clashes.join(", "),
);

/* `item.getAnnotations()` exists on every item but throws on anything that is
   not a file attachment, so testing for the method guards nothing. One
   linked-URL attachment in the library used to reject the whole annotation scan
   and leave the manager on "loading…" forever. Every call site needs a real
   guard: an isFileAttachment() test or a try. */
const unguarded = [];
for (const [path, source] of sources) {
  for (const match of source.matchAll(/\.getAnnotations\s*\(/g)) {
    const before = source.slice(Math.max(0, match.index - 400), match.index);
    if (!/isFileAttachment|try\s*\{/.test(before)) {
      unguarded.push(`${rel(path)} @${source.slice(0, match.index).split("\n").length}`);
    }
  }
}
ok("getAnnotations() is always guarded", unguarded.length === 0, unguarded.join(", "));

/* ------------------------------------------------------- chrome globals ---
   A bootstrapped plugin runs in a Sandbox whose globals are Zotero, Services,
   IOUtils, PathUtils and a few more. `ZoteroPane` and `Zotero_Tabs` are not
   among them, so a bare reference throws ReferenceError — and both readers in
   utils/item.ts swallowed it, so the selection was always empty and the active
   reader always undefined: every item-menu action operated on nothing.
   `zotero-types` declares these as globals, which is exactly why tsc is blind
   to it, so the check has to live here. */
const bareGlobals = [];
for (const [path, source] of sources) {
  for (const name of ["ZoteroPane", "Zotero_Tabs", "ZoteroContextPane"]) {
    for (const match of source.matchAll(new RegExp(`(.?.?)\\b${name}\\b`, "g"))) {
      const before = match[1];
      // property access (win.ZoteroPane), a string ("Zotero_Tabs"), or our own
      // accessor's declaration are all fine; a bare identifier is not.
      if (/[.'"`]$/.test(before)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      bareGlobals.push(`${rel(path)}:${line} ${name}`);
    }
  }
}
ok(
  "no bare chrome globals — they do not exist in the plugin sandbox",
  bareGlobals.length === 0,
  bareGlobals.join(", "),
);

/* --------------------------------------------------------- layout wiring ---
   The layout rules themselves are unit-tested; what cannot be unit-tested is
   that the reader actually uses them. Each of these was a real regression: the
   page width not reaching `toLines` turns the gutter search off (columns get
   welded together again, silently), and dropping the continuation merge sends
   half-sentences — "tomization have brought great challenges" — to the engine. */
const refract = sources.find(([path]) => rel(path).endsWith("refract/fulltext.ts"))?.[1] ?? "";
ok(
  "toLines is given the page width, so gutters can be found",
  /toLines\(runs,\s*page\.width\)/.test(refract),
);
ok(
  "the layout pass is told what not to translate",
  /keepFormulas/.test(refract) && /bodyOnly/.test(refract) && /pageHeight:\s*page\.height/.test(refract),
);
ok(
  "paragraphs cut by a column break are rejoined before translating",
  /continuesInto/.test(refract) && /joinContinuation/.test(refract) && /splitAcross/.test(refract),
);
ok(
  "and the page is walked in reading order",
  /readingOrder/.test(refract),
);
ok(
  "the translation is laid out on the original's own lines",
  /flowIntoLines/.test(refract) && /prism-tr-line/.test(refract),
);
/* Every block paints an opaque box. One whose top reaches into the block above
   erases the bottom of that block's translation, and the result reads as a
   rendering fault rather than as a geometry problem — a sentence clipped to the
   top 2pt of its glyphs, under a stray subscript's box. */
ok(
  "overlapping blocks are separated before anything is painted",
  /separate\(blocks\)[\s\S]{0,120}attach\(reader, overlay\)/.test(refract),
);
/* The reference list starts on one page and runs to the last one. The flag
   that tracks it used to live inside a single `toParagraphs` call, so it was
   reset at every page boundary and the whole bibliography was translated from
   the page after the heading onwards — with "skip references" ticked. */
ok(
  "the reference-list state is carried from page to page",
  /const state = \{ inReferences: false \}/.test(refract) && /\n\s*state,/.test(refract),
);
/* The hover-original tip is created on mouseenter and removed on mouseleave —
   except that a repaint (every `pagerendered`, so every scroll) destroys the
   block under the pointer before its mouseleave can fire. Three orphaned tips
   were on screen at once when this was reported. One reused node per document
   cannot leak, and the repaint puts it away itself. */
ok(
  "the hover tip is one reused node, not one per hover",
  /id = "prism-tr-tip"/.test(refract) &&
    !/mouseenter[\s\S]{0,200}createElement/.test(refract),
);
ok(
  "and a repaint hides it, since mouseleave will never come",
  /hideTip\(doc\);\s*\n\s*host\.querySelector\(["'`]\.prism-tr-layer/.test(refract),
);

/* ------------------------------------------------------------ split view ---
   `zotero-types` declares `menuCmd()`, `isSplitVerticallyActive()` and
   `_splitVertically()` on the reader. None of them exists on Zotero 10.0.3 —
   `reader.menuCmd` is `undefined`, so the documented call throws rather than
   splitting. The live API is `_internalReader.toggleVerticalSplit()` /
   `disableSplitView()` / `splitType`. Anything that reaches for the old names
   has to keep the new ones first. */
const splitSource = sources.find(([path]) => rel(path).endsWith("refract/fulltext.ts"))?.[1] ?? "";
ok(
  "the split view goes through _internalReader first",
  /_internalReader[\s\S]{0,200}toggleVerticalSplit/.test(splitSource) &&
    /disableSplitView/.test(splitSource) &&
    /splitType/.test(splitSource),
);
const legacyFirst = /menuCmd[\s\S]{0,400}toggleVerticalSplit/.test(splitSource);
ok("and only falls back to menuCmd()", !legacyFirst);

/* The second pane is moved through its own PDF.js. `_secondaryView.navigate()`
   is the API that looks right, accepts every location shape offered to it and
   moves nothing at all — a silent no-op, so the panes drift apart with no error
   anywhere. */
ok(
  "the second pane is driven by its PDF.js, not by view.navigate()",
  /_secondaryView[\s\S]{0,160}PDFViewerApplication/.test(splitSource) &&
    /currentPageNumber\s*=/.test(splitSource) &&
    !/_secondaryView[^\n]*\.navigate\(/.test(splitSource),
);

/* --------------------------------------------------------------- timers ---
   `setTimeout` is not a global in a plugin's Sandbox either. A bare call
   throws ReferenceError from inside whatever promise it was building, so the
   work after it silently never happens: one `setTimeout(resolve, 400)` in the
   side-by-side path split the reader and then never attached the page-sync
   listener, with nothing in the log. Timers must come from a window
   (`win.setTimeout`, `doc.defaultView?.setTimeout`) or from `sleep()`. */
const bareTimers = [];
for (const [path, source] of sources) {
  if (rel(path) === "src/utils/window.ts") continue; // the one that defines sleep()
  for (const match of source.matchAll(/(.{0,12})\b(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/g)) {
    if (/[.]\s*$/.test(match[1])) continue; // win.setTimeout(…)
    const line = source.slice(0, match.index).split("\n").length;
    bareTimers.push(`${rel(path)}:${line} ${match[2]}`);
  }
}
ok(
  "no bare timers — the sandbox has none",
  bareTimers.length === 0,
  bareTimers.join(", "),
);

/* --------------------------------------------------------- reachability ---
   Features that were written, compiled, type-checked — and then wired to
   nothing. `quickFilterByType` was referenced by no other file in the plugin,
   so item-type filtering existed only in the source; `deleteViewGroup` and
   `bury` were the same. tsc is happy with an unused export, and so is every
   unit test, which is why the rule is written down here instead.

   Each row names a feature and the files that count as a way in: a menu, a
   rendered panel, the reader UI or the settings pane. */
const REACHABLE = [
  ["quickFilterByType", ["src/modules/menus.ts"]],
  ["QUICK_TYPES", ["src/modules/menus.ts"]],
  ["deleteViewGroup", ["src/modules/menus.ts"]],
  ["applyViewGroup", ["src/modules/menus.ts"]],
  ["renameTagBranch", ["src/modules/spectrum/organise.ts"]],
  ["deleteTagBranch", ["src/modules/spectrum/organise.ts"]],
  ["bury", ["src/modules/beam/dashboard.ts"]],
  ["forget", ["src/modules/beam/dashboard.ts"]],
  ["toggleCompare", ["src/modules/reader.ts"]],
  ["appendTurnToNote", ["src/modules/lens/ui.ts"]],
  ["renderAttachments", ["src/modules/spectrum/panes.ts"]],
  ["removeWatch", ["src/modules/prefsPane.ts"]],
];
const unreachable = [];
for (const [name, files] of REACHABLE) {
  const wired = files.some((file) => {
    const entry = sources.find(([path]) => rel(path).split("\\").join("/") === file);
    if (!entry) return false;
    // The definition itself is not a way in: look for a call or a JSX-free
    // reference that is not the `export function <name>` line.
    const body = entry[1].replace(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`, "g"), "");
    return new RegExp(`\\b${name}\\b`).test(body);
  });
  if (!wired) unreachable.push(name);
}
ok(
  "every feature has a way in from the UI",
  unreachable.length === 0,
  unreachable.join(", "),
);

/* A menu row that builds a list nothing opens is the same bug one level up, so
   a module-level function that is neither exported nor called anywhere in its
   own file counts as dead too. */
const deadLocals = [];
for (const [path, source] of sources) {
  for (const match of source.matchAll(/^(?:async )?function (\w+)/gm)) {
    const name = match[1];
    const rest = source.slice(0, match.index) + source.slice(match.index + match[0].length);
    if (!new RegExp(`\\b${name}\\b`).test(rest)) {
      deadLocals.push(`${rel(path)} ${name}`);
    }
  }
}
ok("no local function is left uncalled", deadLocals.length === 0, deadLocals.join(", "));

/* ------------------------------------------------------------- settings ---
   A preference the code reads but no pane can set is a feature only its author
   can use: `refract.sourceLang` had a default, a reader and no control, and the
   citation source was a function parameter that nothing ever passed. The
   allowlist is state the plugin keeps for itself — lists, timestamps and
   window geometry — not settings. */
const INTERNAL = new Set([
  "beam.lastWatchRun",
  "beam.watchlist",
  "lens.bridgeTimeout",
  "lens.panelFontSize",
  "lens.profiles",
  "lens.prompts",
  "lens.readerBindMode",
  "spectrum.matrixFields",
  "spectrum.tabGroups",
  "spectrum.viewGroups",
]);
const readPrefs = new Set();
for (const [, source] of sources) {
  for (const match of source.matchAll(
    /\b(?:getPref|getJSONPref)\s*(?:<[^>]*>)?\s*\(\s*"([\w.]+)"/g,
  )) {
    readPrefs.add(match[1]);
  }
}
const prefsXHTML = readFileSync(join(root, "addon/content/preferences.xhtml"), "utf8");
const controls = new Set([...prefsXHTML.matchAll(/preference="([\w.]+)"/g)].map((m) => m[1]));
const uncontrolled = [...readPrefs].filter(
  (name) => !INTERNAL.has(name) && !controls.has(name),
);
ok(
  "every setting the code reads can be set in the pane",
  uncontrolled.length === 0,
  uncontrolled.join(", "),
);

const declared = new Set(
  [...readFileSync(join(root, "addon/prefs.js"), "utf8").matchAll(/pref\("([\w.]+)"/g)].map(
    (m) => m[1],
  ),
);
const undeclared = [...controls].filter((name) => !declared.has(name));
ok(
  "every control is backed by a default in prefs.js",
  undeclared.length === 0,
  undeclared.join(", "),
);

/* ------------------------------------------------------- item-pane sections ---
   registerSection hands back a namespaced key, and unregisterSection wants
   exactly that key. Two sections kept their own paneID instead, so they
   outlived every disable and upgrade — still running the old code — and the
   new version could not register over them. */
const sectionSites = [];
for (const [path, source] of sources) {
  for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*Zotero\.ItemPaneManager\.registerSection\(/g)) {
    const pushed = [...source.matchAll(/sections\.push\(\s*([\w.]+)/g)].map((m) => m[1]);
    sectionSites.push([rel(path), match[1], pushed]);
  }
}
ok("the section registrations are still being found", sectionSites.length >= 2, `${sectionSites.length} found`);
const wrongKeys = sectionSites.filter(([, key, pushed]) => !pushed.length || pushed.some((p) => p !== key));
ok(
  "sections are unregistered by the key registerSection returned",
  wrongKeys.length === 0,
  JSON.stringify(wrongKeys),
);

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall green");
process.exit(fails.length ? 1 : 0);

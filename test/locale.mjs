/**
 * Cross-checks the Fluent files against the ids the plugin actually references.
 *
 * Two bugs motivated this: sidenav tooltips written as plain messages ended up
 * rendered as button text, and XUL menu items localized without a `.label`
 * attribute came up blank. Both are invisible to the type checker.
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

/** A deliberately small Fluent reader: id -> { value, attributes }. */
function parseFTL(text) {
  const messages = new Map();
  let current = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const attr = /^\s+\.([a-zA-Z-]+)\s*=\s*(.*)$/.exec(raw);
    if (attr && current) {
      current.attributes[attr[1]] = attr[2];
      continue;
    }
    const message = /^([a-zA-Z][\w-]*)\s*=\s*(.*)$/.exec(raw);
    if (message) {
      current = { value: message[2] || null, attributes: {} };
      if (messages.has(message[1])) fails.push(`duplicate id ${message[1]}`);
      messages.set(message[1], current);
      continue;
    }
    if (/^\s+\S/.test(raw) && current && current.value !== null) {
      current.value += ` ${raw.trim()}`; // continuation line
    }
  }
  return messages;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

const en = parseFTL(readFileSync(join(root, "addon/locale/en-US/addon.ftl"), "utf8"));
const zh = parseFTL(readFileSync(join(root, "addon/locale/zh-CN/addon.ftl"), "utf8"));

ok("both locales define the same ids",
   en.size === zh.size && [...en.keys()].every((k) => zh.has(k)),
   `en=${en.size} zh=${zh.size}`);

/* ids the code asks for */
const referenced = new Set();
const sectionL10n = new Set();
for (const file of walk(join(root, "src"))) {
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/getString\(\s*"([\w-]+)"/g)) referenced.add(m[1]);
  for (const m of source.matchAll(/getLocaleID\(\s*"([\w-]+)"/g)) referenced.add(m[1]);
  for (const m of source.matchAll(/getLocaleID\(`\$\{options\.l10n\}-tooltip`\)/g)) void m;
  for (const m of source.matchAll(/\$\{config\.addonRef\}-([\w-]+)`/g)) referenced.add(m[1]);
  // menus.ts resolves its labels through label("<id>", en, zh)
  for (const m of source.matchAll(/\blabel\(\s*"([\w-]+)"\s*,/g)) referenced.add(m[1]);
  for (const m of source.matchAll(/\btoolsItem\(\s*"([\w-]+)"\s*,/g)) referenced.add(m[1]);
  // the section() helper: `l10n: "<id>"` becomes the header's data-l10n-id
  for (const m of source.matchAll(/\bl10n:\s*"([\w-]+)"/g)) sectionL10n.add(m[1]);
}
// the section helper builds "<l10n>" and "<l10n>-tooltip" from a literal
for (const base of ["section-explore", "section-backlinks", "section-attachments"]) {
  referenced.add(base);
  referenced.add(`${base}-tooltip`);
}

const missing = [...referenced].filter((id) => !en.has(id));
ok("every referenced id exists", missing.length === 0, missing.join(", "));

/* shape rules */
const badTooltip = [...referenced].filter(
  (id) => id.endsWith("-tooltip") && en.has(id) &&
    (en.get(id).value !== null || !en.get(id).attributes.tooltiptext),
);
ok("sidenav tooltips are attribute-only", badTooltip.length === 0, badTooltip.join(", "));

/* A Fluent message with a *value* is written to the element's textContent.
   For an item-pane section header that replaces the whole collapsible-section —
   icon, twisty, body and all — leaving a bare line of text. Section headers
   must therefore carry attributes only, exactly like the sidenav tooltips. */
// Only ids actually handed to registerSection: the `section({ l10n })` helper,
// plus the Lens pane which registers itself. A `section-*` id used merely as a
// menu label is unaffected, because nothing localises an element around it.
const sectionHeaders = [...new Set([...sectionL10n, "section-lens"])].filter((id) =>
  en.has(id),
);
const valued = sectionHeaders.filter((id) => en.get(id).value !== null);
ok("section headers are attribute-only", valued.length === 0, valued.join(", "));
const zhValued = sectionHeaders.filter((id) => zh.has(id) && zh.get(id).value !== null);
ok("zh-CN section headers are attribute-only too", zhValued.length === 0, zhValued.join(", "));

const badLabel = [...referenced].filter(
  (id) => !id.endsWith("-tooltip") && en.has(id) && !en.get(id).attributes.label,
);
ok("XUL-facing messages carry .label", badLabel.length === 0, badLabel.join(", "));

const zhBadLabel = [...referenced].filter(
  (id) => !id.endsWith("-tooltip") && zh.has(id) && !zh.get(id).attributes.label,
);
ok("zh-CN messages carry .label too", zhBadLabel.length === 0, zhBadLabel.join(", "));

/* icons referenced from code must exist on disk, in both sizes */
const ICON_NAMES = ["favicon", "lens", "explore", "backlinks", "annotations", "attachments"];
const iconDir = join(root, "addon/content/icons");
const missingIcons = [];
for (const size of [16, 20]) {
  const onDisk = new Set(readdirSync(join(iconDir, String(size))));
  for (const name of ICON_NAMES) {
    if (!onDisk.has(`${name}.svg`)) missingIcons.push(`${size}/${name}.svg`);
  }
}
ok("referenced icons exist in both sizes", missingIcons.length === 0, missingIcons.join(", "));

/* Zotero paints a section header at 16px and the sidenav at 20px. A file whose
   intrinsic size disagrees with its slot renders smaller than Zotero's own. */
const wrongSize = [];
const allIcons = [];
for (const size of [16, 20]) {
  for (const name of readdirSync(join(iconDir, String(size)))) {
    if (!name.endsWith(".svg")) continue;
    const svg = readFileSync(join(iconDir, String(size), name), "utf8");
    allIcons.push([`${size}/${name}`, svg]);
    if (!svg.includes(`width="${size}" height="${size}"`)) {
      wrongSize.push(`${size}/${name}`);
    }
  }
}
ok("each icon declares its slot size", wrongSize.length === 0, wrongSize.join(", "));

/* icons must not use paint values Firefox rejects */
const badPaint = [];
for (const [name, svg] of allIcons) {
  if (/(?:fill|stroke)\s*[:=]\s*"?[^";]*context-(?:fill|stroke)[^";]*[, ]\s*\w/.test(svg)) {
    badPaint.push(name);
  }
}
ok("no invalid context-fill/stroke fallbacks", badPaint.length === 0, badPaint.join(", "));

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall green");
process.exit(fails.length ? 1 : 0);

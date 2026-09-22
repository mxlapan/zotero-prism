/**
 * Naming annotation colours.
 *
 * A yellow highlight means something different to every reader. Once a colour
 * has a name — "method", "claim I doubt", "to cite" — the annotation manager,
 * the literature matrix and the AI prompts can all speak in those terms.
 */

import { config } from "../../../package.json";
import { bi } from "../../utils/locale";
import { getJSONPref, setJSONPref } from "../../utils/prefs";
import { synced } from "../../utils/store";
import { el, clear } from "../../utils/dom";

/** Zotero's own palette. */
export const ZOTERO_COLORS: Array<{ hex: string; fallback: string }> = [
  { hex: "#ffd400", fallback: bi("Yellow", "黄色") },
  { hex: "#ff6666", fallback: bi("Red", "红色") },
  { hex: "#5fb236", fallback: bi("Green", "绿色") },
  { hex: "#2ea8e5", fallback: bi("Blue", "蓝色") },
  { hex: "#a28ae5", fallback: bi("Purple", "紫色") },
  { hex: "#e56eee", fallback: bi("Magenta", "品红") },
  { hex: "#f19837", fallback: bi("Orange", "橙色") },
  { hex: "#aaaaaa", fallback: bi("Grey", "灰色") },
];

export function loadColorNames(): Record<string, string> {
  const local = getJSONPref<Record<string, string>>("spectrum.annotationColors", {});
  const remote = synced.get<Record<string, string>>("annotationColors", {});
  const merged = { ...remote, ...local };
  addon.data.spectrum.colorNames = merged;
  return merged;
}

export function colorName(hex: string): string {
  if (!hex) return "";
  const names = addon.data.spectrum.colorNames;
  const key = hex.toLowerCase();
  if (names[key]) return names[key];
  return (
    ZOTERO_COLORS.find((c) => c.hex === key)?.fallback || hex
  );
}

export async function setColorName(hex: string, name: string) {
  const names = { ...addon.data.spectrum.colorNames };
  const key = hex.toLowerCase();
  if (name.trim()) names[key] = name.trim();
  else delete names[key];
  addon.data.spectrum.colorNames = names;
  setJSONPref("spectrum.annotationColors", names);
  await synced.set("annotationColors", names);
}

/** Colours actually used in the library, so custom palettes show up too. */
export async function usedColors(): Promise<string[]> {
  const found = new Set(ZOTERO_COLORS.map((c) => c.hex));
  try {
    const rows = await Zotero.DB.queryAsync(
      "SELECT DISTINCT color FROM itemAnnotations WHERE color IS NOT NULL",
    );
    for (const row of rows as any[]) {
      if (row.color) found.add(String(row.color).toLowerCase());
    }
  } catch {
    /* schema differences across versions — the defaults still work */
  }
  return [...found];
}

/** A small dialog for naming each colour. */
export async function openColorEditor(win: Window) {
  const colors = await usedColors();
  const names = loadColorNames();
  const dialog = new ztoolkit.Dialog(colors.length + 2, 1);
  dialog.addCell(
    0,
    0,
    {
      tag: "h2",
      properties: { innerHTML: bi("Name your highlight colours", "标注颜色命名") },
    },
    false,
  );
  colors.forEach((hex, index) => {
    dialog.addCell(index + 1, 0, {
      tag: "div",
      styles: { display: "flex", alignItems: "center", gap: "8px", padding: "3px 0" },
      children: [
        {
          tag: "span",
          styles: {
            width: "18px",
            height: "18px",
            borderRadius: "4px",
            background: hex,
            display: "inline-block",
            border: "1px solid rgba(0,0,0,.2)",
          },
        },
        { tag: "span", properties: { innerText: hex }, styles: { width: "80px", opacity: "0.7" } },
        {
          tag: "input",
          id: `prism-color-${index}`,
          attributes: {
            type: "text",
            "data-bind": `color${index}`,
            "data-prop": "value",
          },
          styles: { flex: "1", minWidth: "180px" },
        },
      ],
    });
  });
  const data: Record<string, any> = {};
  colors.forEach((hex, index) => {
    data[`color${index}`] = names[hex] || "";
  });
  dialog
    .setDialogData(data)
    .addButton(bi("Save", "保存"), "save")
    .addButton(bi("Cancel", "取消"), "cancel")
    .open(config.addonName, { width: 420, height: 120 + colors.length * 34 });

  await dialog.dialogData.unloadLock?.promise;
  if (dialog.dialogData._lastButtonId !== "save") return;
  for (let index = 0; index < colors.length; index++) {
    await setColorName(colors[index], String(dialog.dialogData[`color${index}`] ?? ""));
  }
}

/** Colour legend used by panes; safe to call on every render. */
export function renderLegend(doc: Document, host: HTMLElement) {
  clear(host);
  for (const { hex } of ZOTERO_COLORS) {
    host.append(
      el(doc, "span", {
        class: "prism-pill",
        text: colorName(hex),
        style: { background: hex },
      }),
    );
  }
}

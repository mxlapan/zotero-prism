/**
 * Annotation manager and literature matrix.
 *
 * Opens as its own Zotero tab: every annotation under the current collection or
 * selection in one searchable list, and a matrix view that pivots those
 * annotations into a comparison table driven by colour or tag rules.
 */

import { config } from "../../../package.json";
import { bi } from "../../utils/locale";
import { clear, el } from "../../utils/dom";
import { getJSONPref, setJSONPref } from "../../utils/prefs";
import { injectAssets } from "../lens/ui";
import {
  itemAnnotations,
  navigateTo,
  getItem,
  toRegularItem,
  itemCitation,
  createChildNote,
  revealNotes,
  type AnnotationInfo,
} from "../../utils/item";
import { colorName } from "./colors";
import { chat } from "../lens/provider";
import { markdownToNoteHTML } from "../../lib/markdown";
import { escapeHTML } from "../../utils/text";
import { openProgress } from "../../utils/progress";

export interface MatrixField {
  name: string;
  condition: {
    attribute: "tag" | "color";
    operator: "is" | "contains" | "beginsWith";
    value: string;
  };
}

interface Row {
  item: Zotero.Item;
  annotations: AnnotationInfo[];
}

let tabID = "";

/** Set by the rendered tab, so a second command can switch its view. */
let showMode: ((mode: "list" | "matrix") => void) | null = null;

export async function openAnnotationManager(win: Window, mode: "list" | "matrix" = "list") {
  if (tabID) {
    try {
      (win as any).Zotero_Tabs.select(tabID);
      // Tools → Literature matrix has to land on the matrix even when the tab
      // is already open; without this it silently showed whichever view was
      // last used.
      showMode?.(mode);
      return;
    } catch {
      tabID = "";
    }
  }
  const tabs = (win as any).Zotero_Tabs;
  const { id, container } = tabs.add({
    type: "prism-annotations",
    title: bi("Annotations", "标注管理"),
    select: true,
    // Zotero 10's Zotero_Tabs._update() reads tab.data.icon for every
    // non-library tab, so a tab added without `data` throws before add()
    // even returns — and then keeps throwing on every later tab change.
    data: {},
    onClose: () => {
      tabID = "";
      showMode = null;
    },
  });
  tabID = id;
  const doc = win.document;
  injectAssets(doc);
  const root = el(doc, "div", {
    class: "prism-root",
    style: {
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      padding: "10px 12px",
      boxSizing: "border-box",
    },
  });
  container.append(root);
  await renderManager(root, win, mode);
}

async function gatherRows(win: Window): Promise<Row[]> {
  const pane = (win as any).ZoteroPane;
  let items: Zotero.Item[] = [];
  const selected: Zotero.Item[] = pane?.getSelectedItems?.() || [];
  if (selected.length > 1) {
    items = selected;
  } else {
    const row = pane?.getCollectionTreeRow?.();
    if (row?.isCollection?.()) {
      items = row.ref.getChildItems(false, false) as Zotero.Item[];
    } else if (selected.length) {
      items = selected;
    } else {
      const ids = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
      items = (ids as Zotero.Item[]).slice(0, 400);
    }
  }
  const rows: Row[] = [];
  const seen = new Set<number>();
  for (const raw of items) {
    const item = toRegularItem(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    try {
      const annotations = await itemAnnotations(item);
      if (annotations.length) rows.push({ item, annotations });
    } catch (e) {
      // One unreadable item must not cost the user the other 399.
      Zotero.debug(`[Prism] could not read annotations of ${item.id}: ${e}`);
    }
  }
  return rows;
}

/** `a && b`, `a || b`, or a plain substring. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.includes("&&")) {
    return q.split("&&").every((part) => haystack.includes(part.trim()));
  }
  if (q.includes("||")) {
    return q.split("||").some((part) => haystack.includes(part.trim()));
  }
  return haystack.includes(q);
}

async function renderManager(root: HTMLElement, win: Window, mode: "list" | "matrix") {
  const doc = win.document;
  clear(root);
  const state = { query: "", color: "", mode };

  const header = el(doc, "div", {
    class: "prism-row",
    style: { marginBottom: "8px", flexWrap: "wrap" },
  });
  const search = el(doc, "input", {
    class: "prism-search",
    attrs: {
      type: "search",
      placeholder: bi(
        "Search — use && for all, || for any",
        "搜索（&& 表示同时包含，|| 表示包含任一）",
      ),
    },
    style: { maxWidth: "340px" },
  }) as HTMLInputElement;
  header.append(search);

  const listBtn = el(doc, "button", { class: "prism-btn", text: bi("List", "列表") });
  const matrixBtn = el(doc, "button", { class: "prism-btn", text: bi("Matrix", "矩阵") });
  const configBtn = el(doc, "button", { class: "prism-btn", text: bi("Columns", "核心字段") });
  const autoBtn = el(doc, "button", { class: "prism-btn", text: bi("Auto columns", "按颜色自动配置") });
  const exportBtn = el(doc, "button", { class: "prism-btn", text: bi("Export", "导出") });
  const aiBtn = el(doc, "button", { class: "prism-btn prism-btn-primary", text: bi("Synthesise", "AI 综述") });
  header.append(listBtn, matrixBtn, configBtn, autoBtn, exportBtn, aiBtn);
  root.append(header);

  const body = el(doc, "div", { style: { flex: "1", overflow: "auto" } });
  root.append(body);

  const status = el(doc, "div", {
    class: "prism-chip",
    style: { marginTop: "6px", alignSelf: "flex-start" },
    text: bi("loading…", "正在加载…"),
  });
  root.append(status);

  let rows: Row[] = [];
  try {
    rows = await gatherRows(win);
  } catch (e) {
    // Whatever goes wrong, say so: the status line used to be left reading
    // "loading…" forever, which is indistinguishable from a hung scan.
    status.textContent = `${bi("Could not read annotations: ", "读取标注失败：")}${
      (e as any)?.message || e
    }`;
    Zotero.debug(`[Prism] annotation manager failed to load: ${e}`);
    return;
  }
  status.textContent = `${rows.length} ${bi("items", "个条目")} · ${rows.reduce(
    (sum, row) => sum + row.annotations.length,
    0,
  )} ${bi("annotations", "条标注")}`;

  const paint = () => {
    const filtered = rows
      .map((row) => ({
        item: row.item,
        annotations: row.annotations.filter((annotation) => {
          if (state.color && annotation.color !== state.color) return false;
          const text = `${annotation.text} ${annotation.comment} ${annotation.tags.join(" ")} ${
            row.item.getField("title") || ""
          }`;
          return matchesQuery(text, state.query);
        }),
      }))
      .filter((row) => row.annotations.length);
    if (state.mode === "matrix") renderMatrix(body, filtered, win);
    else renderList(body, filtered, win, state, rows, paint);
  };

  search.addEventListener("input", () => {
    state.query = search.value;
    paint();
  });
  const setMode = (next: "list" | "matrix") => {
    state.mode = next;
    paint();
  };
  showMode = setMode;
  listBtn.addEventListener("click", () => setMode("list"));
  matrixBtn.addEventListener("click", () => setMode("matrix"));
  configBtn.addEventListener("click", () => void editFields(win));
  autoBtn.addEventListener("click", async () => {
    autoConfigureFields(rows);
    state.mode = "matrix";
    paint();
  });
  exportBtn.addEventListener("click", () => void exportMatrix(rows, win));
  aiBtn.addEventListener("click", () => void synthesise(rows, win));

  paint();
}

function renderList(
  body: HTMLElement,
  rows: Row[],
  win: Window,
  state: { color: string },
  allRows: Row[],
  repaint: () => void,
) {
  const doc = win.document;
  clear(body);
  // Count colours over everything, not over the current filter, so the chips
  // do not vanish as soon as one of them is selected.
  const palette = new Map<string, number>();
  for (const row of allRows) {
    for (const annotation of row.annotations) {
      palette.set(annotation.color, (palette.get(annotation.color) || 0) + 1);
    }
  }
  const filters = el(doc, "div", { class: "prism-row", style: { marginBottom: "6px" } });
  filters.append(
    el(doc, "div", {
      class: "prism-tag",
      text: bi("all colours", "全部颜色"),
      style: state.color ? {} : { background: "var(--prism-accent)", color: "#fff" },
      on: {
        click: () => {
          state.color = "";
          repaint();
        },
      },
    }),
  );
  for (const [color, count] of [...palette].sort((a, b) => b[1] - a[1])) {
    if (!color) continue;
    filters.append(
      el(doc, "div", {
        class: "prism-tag",
        text: `${colorName(color)} ${count}`,
        style: {
          background: color,
          color: "#fff",
          outline: state.color === color ? "2px solid var(--prism-fg)" : "",
        },
        on: {
          click: () => {
            state.color = state.color === color ? "" : color;
            repaint();
          },
        },
      }),
    );
  }
  body.append(filters);

  for (const row of rows) {
    const group = el(doc, "details", { attrs: { open: "true" } });
    group.append(
      el(doc, "summary", {
        style: { cursor: "pointer", margin: "6px 0 3px", fontWeight: "600" },
        text: `${String(row.item.getField("title") || "")} · ${row.annotations.length}`,
      }),
    );
    const list = el(doc, "div", { class: "prism-list" });
    for (const annotation of row.annotations) {
      const node = el(doc, "div", {
        class: "prism-anno",
        style: { borderInlineStartColor: annotation.color || "#999" },
        on: {
          click: () => {
            const attachment = findAttachment(row.item, annotation.parentKey);
            if (attachment) {
              void navigateTo(attachment.id, { annotationKey: annotation.key });
            }
          },
        },
      });
      node.append(
        el(doc, "div", {
          class: "prism-anno-head",
          text: `p.${annotation.pageLabel} · ${colorName(annotation.color)}${
            annotation.tags.length ? ` · ${annotation.tags.join(", ")}` : ""
          }`,
        }),
      );
      if (annotation.text) node.append(el(doc, "div", { text: annotation.text }));
      if (annotation.comment) {
        node.append(
          el(doc, "div", { class: "prism-anno-comment", text: annotation.comment }),
        );
      }
      list.append(node);
    }
    group.append(list);
    body.append(group);
  }
  if (!rows.length) {
    body.append(
      el(doc, "div", {
        class: "prism-empty",
        text: bi("No annotations match.", "没有符合条件的标注。"),
      }),
    );
  }
}

function findAttachment(item: Zotero.Item, key: string): Zotero.Item | null {
  for (const id of item.getAttachments?.() || []) {
    const attachment = getItem(id);
    if (attachment?.key === key) return attachment;
  }
  return null;
}

/* ------------------------------------------------------------------- matrix */

export function loadFields(): MatrixField[] {
  return getJSONPref<MatrixField[]>("spectrum.matrixFields", []);
}

export function saveFields(fields: MatrixField[]) {
  setJSONPref("spectrum.matrixFields", fields);
}

/** Derive one column per annotation colour actually in use. */
export function autoConfigureFields(rows: Row[]) {
  const colors = new Map<string, number>();
  for (const row of rows) {
    for (const annotation of row.annotations) {
      if (annotation.color) {
        colors.set(annotation.color, (colors.get(annotation.color) || 0) + 1);
      }
    }
  }
  const fields: MatrixField[] = [...colors.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => ({
      name: colorName(color),
      condition: { attribute: "color", operator: "is", value: color },
    }));
  saveFields(fields);
  return fields;
}

function matches(annotation: AnnotationInfo, field: MatrixField): boolean {
  const { attribute, operator, value } = field.condition;
  const candidates =
    attribute === "color" ? [annotation.color] : annotation.tags;
  return candidates.some((candidate) => {
    const text = String(candidate || "");
    if (operator === "is") return text.toLowerCase() === value.toLowerCase();
    if (operator === "beginsWith") {
      return text.toLowerCase().startsWith(value.toLowerCase());
    }
    return text.toLowerCase().includes(value.toLowerCase());
  });
}

function renderMatrix(body: HTMLElement, rows: Row[], win: Window) {
  const doc = win.document;
  clear(body);
  let fields = loadFields();
  if (!fields.length) fields = autoConfigureFields(rows);
  if (!fields.length) {
    body.append(
      el(doc, "div", {
        class: "prism-empty",
        text: bi(
          "Configure columns first — or let Prism derive them from your annotation colours.",
          "请先配置核心字段，或按标注颜色自动配置。",
        ),
      }),
    );
    return;
  }

  const table = el(doc, "table", { class: "prism-matrix" });
  const head = el(doc, "tr");
  head.append(el(doc, "th", { text: bi("Paper", "文献"), style: { minWidth: "150px" } }));
  for (const field of fields) head.append(el(doc, "th", { text: field.name }));
  table.append(head);

  for (const row of rows) {
    const tr = el(doc, "tr");
    tr.append(
      el(
        doc,
        "td",
        {
          style: { cursor: "pointer" },
          on: { click: () => void (win as any).ZoteroPane.selectItem(row.item.id) },
        },
        el(doc, "div", { text: itemCitation(row.item), style: { fontWeight: "600" } }),
        el(doc, "div", {
          text: String(row.item.getField("title") || "").slice(0, 90),
          style: { opacity: "0.75" },
        }),
      ),
    );
    for (const field of fields) {
      const hits = row.annotations.filter((annotation) => matches(annotation, field));
      const cell = el(doc, "td");
      for (const hit of hits.slice(0, 8)) {
        cell.append(
          el(doc, "div", {
            style: { marginBottom: "3px", cursor: "pointer" },
            title: `p.${hit.pageLabel}`,
            text: `${hit.text || hit.comment}`.slice(0, 260),
            on: {
              click: () => {
                const attachment = findAttachment(row.item, hit.parentKey);
                if (attachment) {
                  void navigateTo(attachment.id, { annotationKey: hit.key });
                }
              },
            },
          }),
        );
      }
      tr.append(cell);
    }
    table.append(tr);
  }
  body.append(table);
}

async function editFields(win: Window) {
  const current = JSON.stringify(loadFields(), null, 2);
  const result = { value: current };
  const accepted = Services.prompt.prompt(
    win as any,
    bi("Matrix columns", "文献矩阵核心字段"),
    bi(
      'JSON: [{"name":"Method","condition":{"attribute":"color","operator":"is","value":"#2ea8e5"}}]',
      'JSON 格式：[{"name":"方法","condition":{"attribute":"color","operator":"is","value":"#2ea8e5"}}]',
    ),
    result,
    "",
    { value: false },
  );
  if (!accepted) return;
  try {
    const parsed = JSON.parse(result.value);
    if (Array.isArray(parsed)) saveFields(parsed);
  } catch (e) {
    Services.prompt.alert(win as any, config.addonName, `${bi("JSON error: ", "JSON 格式错误：")}${e}`);
  }
}

function matrixMarkdown(rows: Row[], fields: MatrixField[]): string {
  const header = `| ${bi("Paper", "文献")} | ${fields.map((f) => f.name).join(" | ")} |`;
  const divider = `| --- | ${fields.map(() => "---").join(" | ")} |`;
  const lines = [header, divider];
  for (const row of rows) {
    const cells = fields.map((field) =>
      row.annotations
        .filter((annotation) => matches(annotation, field))
        .map((annotation) => `${annotation.text || annotation.comment} (p.${annotation.pageLabel})`)
        .join("<br/>")
        .replace(/\|/g, "\\|"),
    );
    lines.push(
      `| ${itemCitation(row.item)} — ${String(row.item.getField("title") || "").replace(/\|/g, "")} | ${cells.join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

async function exportMatrix(rows: Row[], win: Window) {
  const fields = loadFields();
  const markdown = matrixMarkdown(rows, fields);
  const note = new Zotero.Item("note");
  note.libraryID = Zotero.Libraries.userLibraryID;
  note.setNote(
    `<h2>${bi("Literature matrix", "文献矩阵")}</h2>\n${markdownToNoteHTML(markdown)}`,
  );
  note.addTag("prism/matrix", 1);
  await note.saveTx();
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text: bi("Matrix saved as a note", "矩阵已保存为笔记"), type: "success" })
    .show(3000);
  await revealNotes([note]);
  void win;
}

async function synthesise(rows: Row[], win: Window) {
  const fields = loadFields();
  const markdown = matrixMarkdown(rows, fields.length ? fields : autoConfigureFields(rows));
  const progress = openProgress(bi("Synthesising…", "正在生成综述…"), { progress: 30 });
  try {
    const answer = await chat([
      {
        role: "user",
        content: `Below is a comparison matrix built from my own highlights across several papers. Write a synthesis: where the papers agree, where they conflict, what is missing, and which two or three papers matter most and why. Refer to papers by their citation key. Answer in markdown.\n\n${markdown}`,
      },
    ]);
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote(
      [
        `<h2>${bi("Matrix synthesis", "矩阵综述")}</h2>`,
        markdownToNoteHTML(answer),
        `<hr/><p style="color:#888;font-size:.85em">${escapeHTML(
          new Date().toLocaleString(),
        )}</p>`,
        markdownToNoteHTML(markdown),
      ].join("\n"),
    );
    note.addTag("prism/matrix", 1);
    await note.saveTx();
    progress.changeLine({
      text: bi("Synthesis saved as a note", "综述已保存为笔记"),
      progress: 100,
      type: "success",
    });
    void revealNotes([note]);
  } catch (e: any) {
    progress.changeLine({ text: String(e?.message || e), type: "fail" });
  }
  progress.startCloseTimer(4000);
  void win;
}

/** Build a matrix note for a selection without opening the manager. */
export async function buildMatrixForItems(items: Zotero.Item[]) {
  const rows: Row[] = [];
  for (const raw of items) {
    const item = toRegularItem(raw);
    if (!item) continue;
    const annotations = await itemAnnotations(item);
    if (annotations.length) rows.push({ item, annotations });
  }
  if (!rows.length) return;
  let fields = loadFields();
  if (!fields.length) fields = autoConfigureFields(rows);
  const markdown = matrixMarkdown(rows, fields);
  const parent = rows[0].item;
  const note = await createChildNote(
    parent,
    `<h2>${bi("Literature matrix", "文献矩阵")}</h2>\n${markdownToNoteHTML(markdown)}`,
    "prism/matrix",
  );
  await revealNotes([note]);
}

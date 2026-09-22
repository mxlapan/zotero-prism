/** Title/abstract translation for library items, one item or a whole selection. */

import { config } from "../../../package.json";
import { bi } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { translateBatch } from "./engines";
import { stripHTML, escapeHTML } from "../../utils/text";
import { revealNotes, toRegularItem } from "../../utils/item";
import { openProgress } from "../../utils/progress";

export type MetaTarget = "note" | "abstract" | "extra";

export async function translateMetadata(
  items: Zotero.Item[],
  options: { target?: MetaTarget; to?: string } = {},
) {
  const target = options.target || "note";
  const regulars = items
    .map((item) => toRegularItem(item))
    .filter(Boolean) as Zotero.Item[];
  if (!regulars.length) return;

  const progress = openProgress(bi("Translating titles and abstracts…", "正在翻译标题与摘要…"));

  const payload: string[] = [];
  const notes: Zotero.Item[] = [];
  for (const item of regulars) {
    payload.push(String(item.getField("title") || ""));
    payload.push(stripHTML(String(item.getField("abstractNote") || "")));
  }

  try {
    const translated = await translateBatch(payload, {
      to: options.to,
      onProgress: (done, total) =>
        progress.changeLine({ progress: (done / total) * 100 }),
    });

    for (let i = 0; i < regulars.length; i++) {
      const item = regulars[i];
      const title = translated[i * 2] || "";
      const abstract = translated[i * 2 + 1] || "";
      if (!title && !abstract) continue;

      if (target === "abstract") {
        const current = String(item.getField("abstractNote") || "");
        if (abstract && !current.includes(abstract)) {
          item.setField("abstractNote", `${current}\n\n【${bi("translated", "译文"
          )}】${abstract}`);
        }
        await item.saveTx();
      } else if (target === "extra") {
        const extra = String(item.getField("extra") || "");
        const line = `prism-title: ${title}`;
        if (!extra.includes("prism-title:")) {
          item.setField("extra", extra ? `${extra}\n${line}` : line);
          await item.saveTx();
        }
      } else {
        const note = new Zotero.Item("note");
        note.libraryID = item.libraryID;
        note.parentID = item.id;
        note.setNote(
          [
            `<h2>${escapeHTML(title)}</h2>`,
            abstract ? `<p>${escapeHTML(abstract)}</p>` : "",
            `<hr/><p style="color:#8a8f98;font-size:.9em">${escapeHTML(
              String(item.getField("title") || ""),
            )}</p>`,
          ].join("\n"),
        );
        note.addTag("prism/translation", 1);
        await note.saveTx();
        notes.push(note);
      }
    }
    progress.changeLine({
      text: bi("Titles and abstracts translated", "标题与摘要已翻译"),
      progress: 100,
      type: "success",
    });
    await revealNotes(notes);
  } catch (e: any) {
    progress.changeLine({ text: `${bi("Failed: ", "失败：")}${e?.message || e}`, type: "fail" });
  }
  progress.startCloseTimer(3000);
}

/** Auto-translate the abstract of newly added items when the user opts in. */
export async function maybeAutoTranslate(items: Zotero.Item[]) {
  if (!getPref<boolean>("enableRefract", true)) return;
  if (!getPref<boolean>("refract.autoTranslateTitle", false)) return;
  const candidates = items.filter(
    (item) => item.isRegularItem?.() && item.getField("abstractNote"),
  );
  if (candidates.length) await translateMetadata(candidates, { target: "note" });
}

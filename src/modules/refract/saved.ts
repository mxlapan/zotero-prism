/**
 * Full-text translations kept per attachment.
 *
 * A paper opened again shows its translation straight away, without parsing
 * the layout again or asking an engine, and keeps the corrections made to it.
 * One JSON file per attachment, under `<data dir>/prism/translations/`.
 */

import type { Paragraph } from "./layout";

export interface Block {
  box: [number, number, number, number];
  /** the original line boxes, in PDF space, top line first */
  lines: Array<[number, number, number, number]>;
  original: string;
  translated: string;
  fontSize: number;
  kind: Paragraph["kind"];
  /** The engine's translation, kept once `translated` has been edited by hand. */
  machine?: string;
}

export interface SavedTranslation {
  version: 1;
  /** PDF.js fingerprint of the file the boxes were measured on. */
  fingerprint: string;
  engine: string;
  to: string;
  savedAt: number;
  pages: Array<[number, Block[]]>;
}

async function pathFor(item: Zotero.Item): Promise<string> {
  const dir = PathUtils.join(Zotero.DataDirectory.dir, "prism", "translations");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
  return PathUtils.join(dir, `${item.libraryID}-${item.key}.json`);
}

export async function loadSaved(item: Zotero.Item): Promise<SavedTranslation | null> {
  try {
    const path = await pathFor(item);
    if (!(await IOUtils.exists(path))) return null;
    const data = (await IOUtils.readJSON(path)) as SavedTranslation;
    if (data?.version !== 1 || !Array.isArray(data.pages)) return null;
    return data;
  } catch (e) {
    Zotero.debug(`[Prism] could not read the saved translation of ${item.key}: ${e}`);
    return null;
  }
}

export async function saveTranslation(item: Zotero.Item, data: SavedTranslation) {
  try {
    const path = await pathFor(item);
    await IOUtils.writeJSON(path, data, { tmpPath: `${path}.tmp` });
  } catch (e) {
    Zotero.debug(`[Prism] could not save the translation of ${item.key}: ${e}`);
  }
}

export async function forgetTranslation(item: Zotero.Item) {
  try {
    await IOUtils.remove(await pathFor(item), { ignoreAbsent: true });
  } catch (e) {
    Zotero.debug(`[Prism] could not remove the saved translation of ${item.key}: ${e}`);
  }
}

/**
 * Carry hand edits over to a fresh translation of the same paper: a block
 * whose original text was edited before keeps the edited text, with the new
 * machine translation underneath for "restore".
 */
export function carryEdits(pages: Map<number, Block[]>, previous: SavedTranslation | null) {
  if (!previous) return 0;
  const edits = new Map<string, string>();
  for (const [, blocks] of previous.pages) {
    for (const block of blocks) {
      if (block.machine !== undefined) edits.set(block.original, block.translated);
    }
  }
  if (!edits.size) return 0;
  let carried = 0;
  for (const blocks of pages.values()) {
    for (const block of blocks) {
      const edited = edits.get(block.original);
      if (edited === undefined || edited === block.translated) continue;
      block.machine = block.translated;
      block.translated = edited;
      carried++;
    }
  }
  return carried;
}

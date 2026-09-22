/**
 * Retrieval over the user's own library.
 *
 * Indexing is explicit (a menu action or the settings pane) and incremental.
 * Retrieval degrades in two steps: hybrid vectors + BM25 when an embedding
 * endpoint is configured, BM25 alone when it is not, and Zotero's own search
 * when nothing has been indexed yet.
 */

import { LibraryIndex, quantize, type SearchHit } from "../../lib/vector";
import { chunkText } from "../../utils/text";
import { bestAttachment, getPageTexts, metaBlock } from "../../utils/item";
import { getPref } from "../../utils/prefs";
import { embed, embeddingsConfigured } from "./provider";
import { AbortLike } from "../../utils/http";

export async function getIndex(): Promise<LibraryIndex> {
  if (!addon.data.lens.index) {
    addon.data.lens.index = new LibraryIndex();
  }
  await addon.data.lens.index.load();
  return addon.data.lens.index;
}

export interface IndexProgress {
  item: string;
  done: number;
  total: number;
  chunks: number;
}

export async function indexItems(
  items: Zotero.Item[],
  options: {
    onProgress?: (progress: IndexProgress) => void;
    signal?: AbortLike;
    force?: boolean;
  } = {},
): Promise<{ indexed: number; chunks: number; skipped: number }> {
  const index = await getIndex();
  const size = Number(getPref("lens.chunkSize", 1200));
  const overlap = Number(getPref("lens.chunkOverlap", 160));
  const model = getPref<string>("lens.embedModel", "");
  const canEmbed = embeddingsConfigured();

  let indexed = 0;
  let skipped = 0;
  let chunkCount = 0;

  addon.data.lens.indexing = true;
  try {
    for (let i = 0; i < items.length; i++) {
      if (options.signal?.aborted) break;
      const item = items[i];
      if (!options.force && index.hasItem(item.id)) {
        skipped++;
        continue;
      }
      const title = String(item.getField("title") || item.getDisplayTitle?.() || "");
      options.onProgress?.({
        item: title,
        done: i,
        total: items.length,
        chunks: chunkCount,
      });

      const attachment = await bestAttachment(item);
      const pages = await getPageTexts(item);
      const body = pages.filter(Boolean);
      // Always index the metadata block so items without a PDF stay findable.
      const head = metaBlock(item);
      const chunks = chunkText(body.length ? body : [head], size, overlap);
      if (head && body.length) {
        chunks.unshift({ text: head, page: -1, index: -1 });
      }
      if (!chunks.length) {
        skipped++;
        continue;
      }

      let vectors: number[][] = [];
      if (canEmbed) {
        try {
          vectors = await embed(
            chunks.map((c) => c.text),
            options.signal,
          );
        } catch (e) {
          Zotero.debug(`[Prism] embedding failed for ${title}: ${e}`);
          vectors = [];
        }
      }

      index.upsert(
        chunks.map((chunk, n) => {
          const record: any = {
            id: `${item.key}:${n}`,
            itemID: item.id,
            itemKey: item.key,
            attachmentID: attachment?.id ?? 0,
            title,
            page: chunk.page,
            text: chunk.text,
          };
          if (vectors[n]) {
            const { v, s } = quantize(vectors[n]);
            record.v = v;
            record.s = s;
          }
          return record;
        }),
        model,
        vectors[0]?.length || 0,
      );
      chunkCount += chunks.length;
      indexed++;
    }
    await index.flush();
  } finally {
    addon.data.lens.indexing = false;
  }
  options.onProgress?.({
    item: "",
    done: items.length,
    total: items.length,
    chunks: chunkCount,
  });
  return { indexed, chunks: chunkCount, skipped };
}

export async function searchLibrary(
  query: string,
  options: { topK?: number; itemIDs?: number[] } = {},
): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const index = await getIndex();
  if (!index.chunks.length) {
    return fallbackSearch(query, options.topK ?? 8);
  }
  let vector: number[] | null = null;
  if (embeddingsConfigured()) {
    try {
      const vectors = await embed([query]);
      vector = vectors[0] || null;
    } catch (e) {
      Zotero.debug(`[Prism] query embedding failed: ${e}`);
    }
  }
  return index.search(query, vector, options);
}

/** Zotero's own search, shaped like index hits, for an unindexed library. */
async function fallbackSearch(query: string, topK: number): Promise<SearchHit[]> {
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(Zotero.Libraries.userLibraryID));
    search.addCondition("quicksearch-everything", "contains", query);
    const ids = await search.search();
    const items = Zotero.Items.get(ids.slice(0, topK * 3)) as Zotero.Item[];
    const hits: SearchHit[] = [];
    for (const item of items) {
      if (!item.isRegularItem?.()) continue;
      hits.push({
        id: `${item.key}:meta`,
        itemID: item.id,
        itemKey: item.key,
        attachmentID: 0,
        title: String(item.getField("title") || ""),
        page: -1,
        text: metaBlock(item),
        score: 0.5,
        lexical: 0.5,
        semantic: 0,
      });
      if (hits.length >= topK) break;
    }
    return hits;
  } catch (e) {
    Zotero.debug(`[Prism] fallback search failed: ${e}`);
    return [];
  }
}

/** Make sure the items in play are searchable before a retrieval prompt runs. */
export async function ensureIndexed(items: Zotero.Item[]) {
  const index = await getIndex();
  const missing = items.filter((item) => !index.hasItem(item.id));
  if (missing.length) await indexItems(missing);
}

export async function clearIndex() {
  const index = await getIndex();
  await index.clear();
}

export async function indexStats() {
  const index = await getIndex();
  return index.stats();
}

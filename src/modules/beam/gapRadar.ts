/**
 * Citation gap radar.
 *
 * Pull the reference list of every paper you own, then count how often each
 * cited work appears. Anything cited repeatedly by your own collection but
 * absent from it is, almost by definition, a paper you should have read.
 */

import { config } from "../../../package.json";
import { sleep } from "../../utils/window";
import { bi } from "../../utils/locale";
import { JSONStore } from "../../utils/store";
import { getJSON, errorText } from "../../utils/http";
import { getPref } from "../../utils/prefs";
import { toRegularItem } from "../../utils/item";
import { openProgress } from "../../utils/progress";

export interface Reference {
  title: string;
  doi?: string;
  year?: number;
  authors?: string;
  citations?: number;
  s2?: string;
}

type RefFile = Record<string, { at: number; refs: Reference[] }>;

const store = new JSONStore<RefFile>("references", {});
let loaded = false;

export async function initGapRadar() {
  if (loaded) return;
  await store.load();
  loaded = true;
}

export function referencesOf(itemKey: string): Reference[] {
  return store.get()[itemKey]?.refs || [];
}

function doiOf(item: Zotero.Item): string {
  const doi = String(item.getField("DOI") || "").trim();
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
}

async function fetchReferences(item: Zotero.Item): Promise<Reference[]> {
  const doi = doiOf(item);
  const title = String(item.getField("title") || "");
  let paperID = doi ? `DOI:${doi}` : "";
  if (!paperID) {
    if (!title) return [];
    const search = await getJSON<any>(
      `https://api.semanticscholar.org/graph/v1/paper/search?limit=1&query=${encodeURIComponent(title)}`,
      { timeout: 30000 },
    );
    paperID = search?.data?.[0]?.paperId || "";
    if (!paperID) return [];
  }
  const data = await getJSON<any>(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(
      paperID,
    )}/references?fields=title,externalIds,year,authors,citationCount&limit=500`,
    { timeout: 45000 },
  );
  return (data?.data || [])
    .map((entry: any) => entry.citedPaper)
    .filter(Boolean)
    .map((paper: any) => ({
      title: String(paper.title || "").trim(),
      doi: paper.externalIds?.DOI || undefined,
      year: paper.year || undefined,
      authors: (paper.authors || [])
        .slice(0, 3)
        .map((a: any) => a.name)
        .join(", "),
      citations: paper.citationCount ?? undefined,
      s2: paper.paperId,
    }))
    .filter((reference: Reference) => reference.title.length > 6);
}

export interface Gap {
  title: string;
  doi?: string;
  year?: number;
  authors?: string;
  citations?: number;
  hits: number;
  citedBy: string[];
}

/** Fetch references for the items, then rank what is missing. */
export async function scanGaps(
  items: Zotero.Item[],
  options: { refresh?: boolean } = {},
): Promise<Gap[]> {
  await initGapRadar();
  const targets = items
    .map((item) => toRegularItem(item))
    .filter(Boolean) as Zotero.Item[];
  if (!targets.length) return [];

  const progress = openProgress(bi("Reading reference lists…", "正在读取参考文献…"));

  const data = store.get();
  let done = 0;
  for (const item of targets) {
    const cached = data[item.key];
    const fresh = cached && Date.now() - cached.at < 30 * 86400_000;
    if (!fresh || options.refresh) {
      try {
        data[item.key] = { at: Date.now(), refs: await fetchReferences(item) };
        store.set(data);
        await sleep(1300);
      } catch (e) {
        Zotero.debug(`[Prism] reference fetch failed: ${errorText(e)}`);
      }
    }
    done++;
    progress.changeLine({
      text: `${done}/${targets.length}`,
      progress: (done / targets.length) * 100,
    });
  }
  await store.flush();

  /* what do we already own? */
  const ownedDOIs = new Set<string>();
  const ownedTitles = new Set<string>();
  try {
    const all = (await Zotero.Items.getAll(
      Zotero.Libraries.userLibraryID,
      true,
    )) as Zotero.Item[];
    for (const item of all) {
      if (!item.isRegularItem?.()) continue;
      const doi = doiOf(item).toLowerCase();
      if (doi) ownedDOIs.add(doi);
      ownedTitles.add(normalise(String(item.getField("title") || "")));
    }
  } catch {
    /* library unavailable */
  }

  const tally = new Map<string, Gap>();
  for (const item of targets) {
    const citation = String(item.getField("title") || "").slice(0, 60);
    for (const reference of data[item.key]?.refs || []) {
      const doi = reference.doi?.toLowerCase();
      const key = doi || normalise(reference.title);
      if (!key) continue;
      if (doi && ownedDOIs.has(doi)) continue;
      if (ownedTitles.has(normalise(reference.title))) continue;
      const gap = tally.get(key) || {
        ...reference,
        hits: 0,
        citedBy: [],
      };
      gap.hits++;
      if (gap.citedBy.length < 8) gap.citedBy.push(citation);
      tally.set(key, gap);
    }
  }

  const minHits = Math.max(1, Number(getPref("beam.gapMinHits", 3)));
  const gaps = [...tally.values()]
    .filter((gap) => gap.hits >= minHits)
    .sort((a, b) => b.hits - a.hits || (b.citations || 0) - (a.citations || 0));

  progress.changeLine({
    text: bi(`${gaps.length} gaps found`, `发现 ${gaps.length} 个缺口`),
    progress: 100,
    type: "success",
  });
  progress.startCloseTimer(4000);
  return gaps;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 90);
}

/** Import a gap into the library using Zotero's own identifier lookup. */
export async function importGap(gap: Gap): Promise<Zotero.Item | null> {
  if (!gap.doi) return null;
  try {
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: gap.doi });
    const translators = await translate.getTranslators();
    if (!translators.length) return null;
    translate.setTranslator(translators[0]);
    const items = await translate.translate({
      libraryID: Zotero.Libraries.userLibraryID,
    } as any);
    return (items?.[0] as Zotero.Item) || null;
  } catch (e) {
    Zotero.debug(`[Prism] gap import failed: ${errorText(e)}`);
    return null;
  }
}

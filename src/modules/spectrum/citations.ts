/**
 * Citation counts.
 *
 * Semantic Scholar is the default because it needs no key and, uniquely, can
 * break the count down by the section that cited the paper — background,
 * methods or results — which says far more than one number does. Which service
 * is asked first is a setting (Settings → Prism → Library); whichever it is,
 * the others answer when it fails.
 */

import { config } from "../../../package.json";
import { sleep } from "../../utils/window";
import { JSONStore } from "../../utils/store";
import { getJSON, errorText } from "../../utils/http";
import { getPref } from "../../utils/prefs";
import { applyMap, parseMap } from "./columns";
import { toRegularItem } from "../../utils/item";
import { bi } from "../../utils/locale";
import { openProgress } from "../../utils/progress";

export type CiteSource = "semanticscholar" | "openalex" | "crossref";

const SOURCES: CiteSource[] = ["semanticscholar", "openalex", "crossref"];

/** The service Settings → Library says to ask first. */
export function preferredSource(): CiteSource {
  const value = getPref<string>("spectrum.citedSource", "semanticscholar");
  return (SOURCES as string[]).includes(value)
    ? (value as CiteSource)
    : "semanticscholar";
}

export interface CitedRecord {
  [label: string]: number | string;
}

type CiteFile = Record<string, CitedRecord>;

const store = new JSONStore<CiteFile>("citations", {});

export async function initCitations() {
  const data = await store.load();
  for (const [key, record] of Object.entries(data)) {
    const item = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      key,
    ) as Zotero.Item | false;
    if (item) addon.data.spectrum.cited.set(item.id, record);
  }
}

export function citedFor(item: Zotero.Item): CitedRecord | undefined {
  return addon.data.spectrum.cited.get(item.id);
}

export function citedSummary(item: Zotero.Item): string {
  const record = citedFor(item);
  if (!record) return "";
  const rules = parseMap(getPref<string>("spectrum.citedMap", ""));
  return Object.entries(record)
    .filter(([label]) => label !== "fetchedAt")
    .map(([label, value]) => applyMap(`${label} ${value}`, rules))
    .join(" ");
}

function doiOf(item: Zotero.Item): string {
  const doi = String(item.getField("DOI") || "").trim();
  if (doi) return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const extra = String(item.getField("extra") || "");
  const match = /\bDOI:\s*(\S+)/i.exec(extra);
  return match ? match[1] : "";
}

async function fromSemanticScholar(item: Zotero.Item): Promise<CitedRecord | null> {
  const doi = doiOf(item);
  const title = String(item.getField("title") || "");
  let paperID = doi ? `DOI:${doi}` : "";
  if (!paperID) {
    if (!title) return null;
    const search = await getJSON<any>(
      `https://api.semanticscholar.org/graph/v1/paper/search?limit=1&query=${encodeURIComponent(
        title,
      )}`,
      { timeout: 30000 },
    );
    paperID = search?.data?.[0]?.paperId || "";
    if (!paperID) return null;
  }
  const paper = await getJSON<any>(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(
      paperID,
    )}?fields=citationCount,influentialCitationCount`,
    { timeout: 30000 },
  );
  const record: CitedRecord = {
    "Total(S2) ": paper?.citationCount ?? 0,
    "Highly Influential ": paper?.influentialCitationCount ?? 0,
  };
  try {
    const citations = await getJSON<any>(
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(
        paperID,
      )}/citations?fields=intents&limit=1000`,
      { timeout: 45000 },
    );
    const tally: Record<string, number> = {};
    for (const entry of citations?.data || []) {
      for (const intent of entry?.intents || []) {
        tally[intent] = (tally[intent] || 0) + 1;
      }
    }
    if (tally.background) record["Background "] = tally.background;
    if (tally.methodology) record["Methods "] = tally.methodology;
    if (tally.result) record["Results "] = tally.result;
  } catch {
    /* intents are optional */
  }
  record.fetchedAt = new Date().toISOString().slice(0, 10);
  return record;
}

async function fromOpenAlex(item: Zotero.Item): Promise<CitedRecord | null> {
  const doi = doiOf(item);
  const title = String(item.getField("title") || "");
  const url = doi
    ? `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`
    : `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(title)}&per-page=1`;
  const data = await getJSON<any>(url, { timeout: 30000 });
  const work = data?.results ? data.results[0] : data;
  if (!work) return null;
  return {
    "Total(OA) ": work.cited_by_count ?? 0,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

async function fromCrossref(item: Zotero.Item): Promise<CitedRecord | null> {
  const doi = doiOf(item);
  if (!doi) return null;
  const data = await getJSON<any>(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { timeout: 30000 },
  );
  return {
    "Total(CR) ": data?.message?.["is-referenced-by-count"] ?? 0,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

/**
 * One item's counts, falling back through the other sources.
 *
 * Semantic Scholar rate-limits unauthenticated callers hard — every request
 * comes back 429 — so on its own it made "Update citation counts" look like a
 * dead menu entry. OpenAlex and Crossref need no key, so a failure walks on to
 * them instead of giving up.
 */
async function fetchCited(
  item: Zotero.Item,
  source: CiteSource,
): Promise<CitedRecord | null> {
  const fetchers: Record<CiteSource, (i: Zotero.Item) => Promise<CitedRecord | null>> = {
    semanticscholar: fromSemanticScholar,
    openalex: fromOpenAlex,
    crossref: fromCrossref,
  };
  const order: CiteSource[] = [
    source,
    ...(["openalex", "crossref", "semanticscholar"] as CiteSource[]).filter(
      (other) => other !== source,
    ),
  ];
  let lastError: unknown;
  for (const which of order) {
    try {
      const record = await fetchers[which](item);
      if (record) return record;
    } catch (e) {
      lastError = e;
      Zotero.debug(`[Prism] ${which} citation lookup failed: ${errorText(e)}`);
    }
  }
  if (lastError) throw lastError;
  return null;
}

/** Fetch counts for a selection. Deliberately serial and paced. */
export async function updateCitations(
  items: Zotero.Item[],
  preferred?: CiteSource,
) {
  const source = preferred ?? preferredSource();
  const targets = items
    .map((item) => toRegularItem(item))
    .filter(Boolean) as Zotero.Item[];
  if (!targets.length) return;
  const progress = openProgress(bi("Fetching citations…", "正在获取被引数…"));

  let done = 0;
  let failed = 0;
  for (const item of targets) {
    try {
      const record = await fetchCited(item, source);
      if (record) {
        addon.data.spectrum.cited.set(item.id, record);
        const data = store.get();
        data[item.key] = record;
        store.set(data);
      }
    } catch (e) {
      failed++;
      Zotero.debug(`[Prism] citation fetch failed: ${errorText(e)}`);
    }
    done++;
    progress.changeLine({
      text: `${done}/${targets.length}`,
      progress: (done / targets.length) * 100,
    });
    // stay well inside Semantic Scholar's unauthenticated rate limit
    if (done < targets.length) await sleep(source === "semanticscholar" ? 1300 : 350);
  }
  await store.flush();
  progress.changeLine({
    text: failed
      ? `${bi("Done", "完成")} · ${failed} ${bi("failed", "条失败")}`
      : bi("Citations updated", "被引数已更新"),
    progress: 100,
    type: failed ? "default" : "success",
  });
  progress.startCloseTimer(4000);
  Zotero.ItemTreeManager.refreshColumns?.();
}

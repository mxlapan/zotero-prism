/**
 * Watchlist.
 *
 * Point Prism at a paper or a topic and it checks, on a schedule, for work
 * that has appeared since — new citations of a paper you care about, new
 * arXiv preprints matching a query — and files a digest note.
 */

import { config } from "../../../package.json";
import { sleep } from "../../utils/window";
import { bi } from "../../utils/locale";
import { getJSONPref, setJSONPref, getPref, setPref } from "../../utils/prefs";
import { getJSON, request, errorText } from "../../utils/http";
import { toRegularItem, itemCitation, revealNotes } from "../../utils/item";
import { markdownToNoteHTML } from "../../lib/markdown";

export interface WatchEntry {
  id: string;
  kind: "citations" | "arxiv" | "s2query";
  label: string;
  itemKey?: string;
  query?: string;
  seen: string[];
  lastRun: number;
}

export interface Finding {
  title: string;
  authors: string;
  year?: number;
  url: string;
  source: string;
  id: string;
}

export function listWatches(): WatchEntry[] {
  return getJSONPref<WatchEntry[]>("beam.watchlist", []);
}

function saveWatches(entries: WatchEntry[]) {
  setJSONPref("beam.watchlist", entries);
}

export function addItemWatch(item: Zotero.Item) {
  const target = toRegularItem(item);
  if (!target) return;
  const entries = listWatches();
  if (entries.some((entry) => entry.itemKey === target.key)) return;
  entries.push({
    id: `w${Date.now().toString(36)}`,
    kind: "citations",
    label: `${itemCitation(target)} — ${String(target.getField("title") || "").slice(0, 60)}`,
    itemKey: target.key,
    seen: [],
    lastRun: 0,
  });
  saveWatches(entries);
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text: bi("Added to watchlist", "已加入追踪列表"), type: "success" })
    .show(2500);
}

export function addQueryWatch(query: string, kind: "arxiv" | "s2query" = "arxiv") {
  if (!query.trim()) return;
  const entries = listWatches();
  entries.push({
    id: `w${Date.now().toString(36)}`,
    kind,
    label: query.trim(),
    query: query.trim(),
    seen: [],
    lastRun: 0,
  });
  saveWatches(entries);
}

export function removeWatch(id: string) {
  saveWatches(listWatches().filter((entry) => entry.id !== id));
}

async function citationsOf(item: Zotero.Item): Promise<Finding[]> {
  const doi = String(item.getField("DOI") || "").replace(
    /^https?:\/\/(dx\.)?doi\.org\//i,
    "",
  );
  let paperID = doi ? `DOI:${doi}` : "";
  if (!paperID) {
    const title = String(item.getField("title") || "");
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
    )}/citations?fields=title,year,authors,externalIds&limit=100`,
    { timeout: 45000 },
  );
  return (data?.data || [])
    .map((entry: any) => entry.citingPaper)
    .filter(Boolean)
    .map((paper: any) => ({
      id: paper.paperId,
      title: String(paper.title || ""),
      authors: (paper.authors || []).slice(0, 3).map((a: any) => a.name).join(", "),
      year: paper.year,
      url: paper.externalIds?.DOI
        ? `https://doi.org/${paper.externalIds.DOI}`
        : `https://www.semanticscholar.org/paper/${paper.paperId}`,
      source: "Semantic Scholar",
    }));
}

async function arxivSearch(query: string): Promise<Finding[]> {
  const url =
    `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(
      `all:${query}`,
    )}&sortBy=submittedDate&sortOrder=descending&max_results=25`;
  const { text } = await request("GET", url, { timeout: 30000 });
  const findings: Finding[] = [];
  for (const entry of text.split("<entry>").slice(1)) {
    const pick = (tag: string) =>
      new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1]?.trim() || "";
    const id = pick("id");
    if (!id) continue;
    findings.push({
      id,
      title: pick("title").replace(/\s+/g, " "),
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)]
        .slice(0, 3)
        .map((m) => m[1].trim())
        .join(", "),
      year: Number(pick("published").slice(0, 4)) || undefined,
      url: id,
      source: "arXiv",
    });
  }
  return findings;
}

async function s2Search(query: string): Promise<Finding[]> {
  const year = new Date().getFullYear();
  const data = await getJSON<any>(
    `https://api.semanticscholar.org/graph/v1/paper/search?limit=25&year=${year - 1}-&fields=title,year,authors,externalIds&query=${encodeURIComponent(query)}`,
    { timeout: 30000 },
  );
  return (data?.data || []).map((paper: any) => ({
    id: paper.paperId,
    title: String(paper.title || ""),
    authors: (paper.authors || []).slice(0, 3).map((a: any) => a.name).join(", "),
    year: paper.year,
    url: paper.externalIds?.DOI
      ? `https://doi.org/${paper.externalIds.DOI}`
      : `https://www.semanticscholar.org/paper/${paper.paperId}`,
    source: "Semantic Scholar",
  }));
}

/** Run every watch, returning only what is new since the last run. */
export async function runWatches(
  // `reveal` opens the digest; only a check someone started by hand asks for it,
  // not the scheduled one
  options: { quiet?: boolean; reveal?: boolean } = {},
): Promise<Record<string, Finding[]>> {
  const entries = listWatches();
  if (!entries.length) return {};
  const fresh: Record<string, Finding[]> = {};

  for (const entry of entries) {
    try {
      let findings: Finding[] = [];
      if (entry.kind === "citations" && entry.itemKey) {
        const item = Zotero.Items.getByLibraryAndKey(
          Zotero.Libraries.userLibraryID,
          entry.itemKey,
        ) as Zotero.Item | false;
        if (item) findings = await citationsOf(item);
      } else if (entry.kind === "arxiv" && entry.query) {
        findings = await arxivSearch(entry.query);
      } else if (entry.query) {
        findings = await s2Search(entry.query);
      }
      const seen = new Set(entry.seen);
      const added = findings.filter((finding) => !seen.has(finding.id));
      if (entry.lastRun === 0) {
        // first run only establishes the baseline
        entry.seen = findings.map((finding) => finding.id).slice(0, 400);
      } else if (added.length) {
        fresh[entry.id] = added;
        entry.seen = [...added.map((f) => f.id), ...entry.seen].slice(0, 400);
      }
      entry.lastRun = Date.now();
      await sleep(1500);
    } catch (e) {
      Zotero.debug(`[Prism] watch failed: ${errorText(e)}`);
    }
  }
  saveWatches(entries);
  setPref("beam.lastWatchRun", Date.now());

  const total = Object.values(fresh).reduce((sum, list) => sum + list.length, 0);
  if (total) {
    const digest = await writeDigest(entries, fresh);
    if (options.reveal) await revealNotes([digest]);
    if (!options.quiet) {
      new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
        .createLine({
          text: bi(`${total} new papers on your watchlist`, `新文追踪发现 ${total} 篇新文献`),
          type: "success",
        })
        .show(6000);
    }
  }
  return fresh;
}

async function writeDigest(entries: WatchEntry[], fresh: Record<string, Finding[]>) {
  const lines: string[] = [
    `# ${bi("Watchlist digest", "新文追踪摘要")} — ${new Date().toLocaleDateString()}`,
    "",
  ];
  for (const entry of entries) {
    const findings = fresh[entry.id];
    if (!findings?.length) continue;
    lines.push(`## ${entry.label}`, "");
    for (const finding of findings.slice(0, 25)) {
      lines.push(
        `- [${finding.title}](${finding.url}) — ${finding.authors}${
          finding.year ? ` (${finding.year})` : ""
        } · ${finding.source}`,
      );
    }
    lines.push("");
  }
  const note = new Zotero.Item("note");
  note.libraryID = Zotero.Libraries.userLibraryID;
  note.setNote(markdownToNoteHTML(lines.join("\n")));
  note.addTag("prism/watch", 1);
  await note.saveTx();
  return note;
}

/** Schedule periodic runs; called once per session. */
export function scheduleWatches(win: Window) {
  if (addon.data.beam.watchTimer) return;
  const hours = Math.max(1, Number(getPref("beam.watchIntervalHours", 24)));
  const check = () => {
    const last = Number(getPref("beam.lastWatchRun", 0));
    if (Date.now() - last > hours * 3600_000) void runWatches({ quiet: false });
  };
  // give Zotero a few minutes to settle after launch
  addon.data.beam.watchTimer = win.setTimeout(() => {
    check();
    addon.data.beam.watchTimer = win.setInterval(check, 3600_000) as unknown as number;
  }, 240_000) as unknown as number;
}

export function stopWatches(win: Window) {
  if (addon.data.beam.watchTimer) {
    win.clearTimeout(addon.data.beam.watchTimer);
    win.clearInterval(addon.data.beam.watchTimer);
    addon.data.beam.watchTimer = undefined;
  }
}

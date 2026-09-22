/**
 * Journal and conference ranking tags.
 *
 * With an easyScholar key Prism pulls the full set of Chinese and international
 * ranking datasets. Without one it still tags the venues in a small built-in
 * table, so the column is never empty out of the box.
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

type RankFile = Record<string, Record<string, string>>;

const store = new JSONStore<RankFile>("ranks", {});

/** A deliberately small, high-confidence fallback table. */
const BUILTIN: Record<string, Record<string, string>> = {
  nature: { sciUp: "1区", jcr: "Q1" },
  science: { sciUp: "1区", jcr: "Q1" },
  cell: { sciUp: "1区", jcr: "Q1" },
  "nature communications": { sciUp: "1区", jcr: "Q1" },
  "science advances": { sciUp: "1区", jcr: "Q1" },
  pnas: { sciUp: "1区", jcr: "Q1" },
  "proceedings of the national academy of sciences": { sciUp: "1区", jcr: "Q1" },
  "ieee transactions on pattern analysis and machine intelligence": { ccf: "CCF-A", sciUp: "1区" },
  "international journal of computer vision": { ccf: "CCF-A", sciUp: "2区" },
  "journal of machine learning research": { ccf: "CCF-A" },
  "ieee transactions on knowledge and data engineering": { ccf: "CCF-A" },
  "ieee transactions on image processing": { ccf: "CCF-A", sciUp: "1区" },
  "acm transactions on graphics": { ccf: "CCF-A" },
  "artificial intelligence": { ccf: "CCF-A" },
  "ieee transactions on information theory": { ccf: "CCF-A" },
  "acm computing surveys": { ccf: "CCF-A", sciUp: "1区" },
  "advances in neural information processing systems": { ccf: "CCF-A" },
  neurips: { ccf: "CCF-A" },
  icml: { ccf: "CCF-A" },
  iclr: { ccf: "CCF-A" },
  cvpr: { ccf: "CCF-A" },
  iccv: { ccf: "CCF-A" },
  eccv: { ccf: "CCF-B" },
  aaai: { ccf: "CCF-A" },
  ijcai: { ccf: "CCF-A" },
  acl: { ccf: "CCF-A" },
  emnlp: { ccf: "CCF-B" },
  naacl: { ccf: "CCF-B" },
  sigmod: { ccf: "CCF-A" },
  vldb: { ccf: "CCF-A" },
  kdd: { ccf: "CCF-A" },
  sigir: { ccf: "CCF-A" },
  www: { ccf: "CCF-A" },
  osdi: { ccf: "CCF-A" },
  sosp: { ccf: "CCF-A" },
  "the lancet": { sciUp: "1区", jcr: "Q1" },
  "new england journal of medicine": { sciUp: "1区", jcr: "Q1" },
  jama: { sciUp: "1区", jcr: "Q1" },
  bmj: { sciUp: "1区", jcr: "Q1" },
};

export async function initRanks() {
  const data = await store.load();
  for (const [name, record] of Object.entries(data)) {
    addon.data.spectrum.ranks.set(name, record);
  }
}

function venueOf(item: Zotero.Item): string {
  const value =
    item.getField("publicationTitle") ||
    item.getField("proceedingsTitle") ||
    item.getField("conferenceName") ||
    item.getField("bookTitle") ||
    "";
  return String(value).trim();
}

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(the|proceedings of the|proc\.? of)\s+/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lookup(venue: string): Record<string, string> | undefined {
  const key = normalise(venue);
  if (!key) return undefined;
  const cached = addon.data.spectrum.ranks.get(key);
  if (cached) return cached;
  if (BUILTIN[key]) return BUILTIN[key];
  for (const [name, record] of Object.entries(BUILTIN)) {
    if (key.includes(name) && name.length > 5) return record;
  }
  return undefined;
}

/** The rank labels shown in the column, after field filtering and mapping. */
export function rankTagsFor(item: Zotero.Item): string[] {
  const record = lookup(venueOf(item));
  if (!record) return [];
  const fields = getPref<string>("spectrum.rankFields", "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const rules = parseMap(getPref<string>("spectrum.rankMap", ""));
  const out: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (fields.length && !fields.includes(field)) continue;
    if (!value) continue;
    const label = applyMap(String(value), rules);
    if (label) out.push(label);
  }
  return [...new Set(out)].slice(0, 5);
}

/** Pull the full dataset for these venues from easyScholar. */
export async function updateRanks(items: Zotero.Item[]) {
  const key = getPref<string>("spectrum.easyScholarKey", "").trim();
  const venues = [
    ...new Set(
      items
        .map((item) => toRegularItem(item))
        .filter(Boolean)
        .map((item) => venueOf(item as Zotero.Item))
        .filter(Boolean),
    ),
  ];
  if (!venues.length) return;
  if (!key) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({
        text: bi(
          "Add an easyScholar key in settings for full ranking data.",
          "请在设置中填写 easyScholar 密钥以获取完整分区数据。",
        ),
        type: "default",
      })
      .show(5000);
    return;
  }

  const progress = openProgress(bi("Fetching ranks…", "正在获取分区…"));
  let done = 0;
  for (const venue of venues) {
    try {
      const data = await getJSON<any>(
        `https://www.easyscholar.cc/open/getPublicationRank?secretKey=${encodeURIComponent(
          key,
        )}&publicationName=${encodeURIComponent(venue)}`,
        { timeout: 30000 },
      );
      const official = data?.data?.officialRank?.all || {};
      const custom = data?.data?.customRank?.rankInfo || [];
      const record: Record<string, string> = { ...official };
      for (const entry of custom) {
        if (entry?.abbName && entry?.uuid) record[entry.abbName] = entry.rank ?? "";
      }
      if (Object.keys(record).length) {
        const normalised = normalise(venue);
        addon.data.spectrum.ranks.set(normalised, record);
        const file = store.get();
        file[normalised] = record;
        store.set(file);
      }
    } catch (e) {
      Zotero.debug(`[Prism] rank fetch failed for ${venue}: ${errorText(e)}`);
    }
    done++;
    progress.changeLine({
      text: `${done}/${venues.length}`,
      progress: (done / venues.length) * 100,
    });
    await sleep(250);
  }
  await store.flush();
  progress.changeLine({
    text: bi("Ranks updated", "分区已更新"),
    progress: 100,
    type: "success",
  });
  progress.startCloseTimer(3000);
  Zotero.ItemTreeManager.refreshColumns?.();
}

/** Every field name present in the cache, for the settings UI. */
export function knownRankFields(): string[] {
  const fields = new Set<string>();
  for (const record of addon.data.spectrum.ranks.values()) {
    for (const field of Object.keys(record)) fields.add(field);
  }
  for (const record of Object.values(BUILTIN)) {
    for (const field of Object.keys(record)) fields.add(field);
  }
  return [...fields].sort();
}

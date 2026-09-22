/**
 * The reading clock.
 *
 * Every few seconds Prism asks each open reader which page it is on and, if
 * that reader has focus, credits the elapsed time to that page. The result
 * drives the title heat-map, the progress column and the rhythm dashboard.
 */

import { JSONStore } from "../../utils/store";
import type { ReadingRecord } from "../../addon";
import { getItem, readAnnotations } from "../../utils/item";

type ReadingFile = Record<string, ReadingRecord>;

export interface DailyStat {
  seconds: number;
  pages: number;
  annotations: number;
  items: string[];
}

type RhythmFile = Record<string, DailyStat>;

const readingStore = new JSONStore<ReadingFile>("reading", {});
const rhythmStore = new JSONStore<RhythmFile>("rhythm", {});

const TICK_CAP_SECONDS = 20;

export async function initReading() {
  const data = await readingStore.load();
  for (const [key, record] of Object.entries(data)) {
    addon.data.spectrum.reading.set(key, record);
  }
  await rhythmStore.load();
}

export async function flushReading() {
  const data: ReadingFile = {};
  for (const [key, record] of addon.data.spectrum.reading) data[key] = record;
  readingStore.set(data);
  await readingStore.flush();
  await rhythmStore.flush();
}

/**
 * The day a session belongs to, in the user's own timezone.
 * `toISOString` would bucket by UTC, so anyone east of Greenwich would see
 * their evening reading land on the previous day.
 */
export function localDay(date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function today(): string {
  return localDay();
}

function blankRecord(): ReadingRecord {
  return { pages: {}, total: 0, first: Date.now(), last: Date.now(), numPages: 0 };
}

/** Called by the reader poller; `focused` decides whether time is credited. */
export function noteReadingEvent(
  readerID: string,
  attachmentID: number,
  page: number,
  focused: boolean,
  numPages = 0,
) {
  const attachment = getItem(attachmentID);
  if (!attachment) return;
  const key = attachment.key;
  const clocks = addon.data.spectrum.clocks;
  const now = Date.now();
  const clock = clocks.get(readerID);

  if (!focused) {
    clocks.delete(readerID);
    return;
  }
  if (!clock || clock.key !== key) {
    clocks.set(readerID, { key, page, since: now });
    return;
  }
  if (clock.page !== page) notePageTurn();

  const seconds = Math.min(TICK_CAP_SECONDS, (now - clock.since) / 1000);
  clocks.set(readerID, { key, page, since: now });
  if (seconds <= 0.5) return;

  const record = addon.data.spectrum.reading.get(key) || blankRecord();
  const slot = (record.pages[clock.page] ??= { t: 0, a: 0 });
  slot.t = Math.round((slot.t + seconds) * 10) / 10;
  record.total = Math.round((record.total + seconds) * 10) / 10;
  record.last = now;
  if (!record.first) record.first = now;
  if (numPages > 0) record.numPages = numPages;
  addon.data.spectrum.reading.set(key, record);

  const day = (rhythmStore.get()[today()] ??= {
    seconds: 0,
    pages: 0,
    annotations: 0,
    items: [],
  });
  day.seconds = Math.round(day.seconds + seconds);
  const parentKey = attachment.parentItem?.key;
  if (parentKey && !day.items.includes(parentKey)) day.items.push(parentKey);
  rhythmStore.schedule(20000);
  readingStore.set(exportRecords());
}

function exportRecords(): ReadingFile {
  const data: ReadingFile = {};
  for (const [key, record] of addon.data.spectrum.reading) data[key] = record;
  return data;
}

/** Note that a page was turned, so the dashboard can count pages read. */
export function notePageTurn() {
  const day = (rhythmStore.get()[today()] ??= {
    seconds: 0,
    pages: 0,
    annotations: 0,
    items: [],
  });
  day.pages += 1;
  rhythmStore.schedule();
}

export function noteAnnotationCreated() {
  const day = (rhythmStore.get()[today()] ??= {
    seconds: 0,
    pages: 0,
    annotations: 0,
    items: [],
  });
  day.annotations += 1;
  rhythmStore.schedule();
}

export function recordFor(attachmentKey: string): ReadingRecord | undefined {
  return addon.data.spectrum.reading.get(attachmentKey);
}

export interface ReadingSummary {
  seconds: number;
  minutes: number;
  pagesTouched: number;
  numPages: number;
  coverage: number;
  heat: number[];
  maxHeat: number;
  last: number;
}

const summaryCache = new Map<number, { at: number; value: ReadingSummary }>();

/** Aggregate reading across an item's attachments. Cheap enough for a column. */
export function readingSummary(item: Zotero.Item): ReadingSummary {
  const cached = summaryCache.get(item.id);
  if (cached && Date.now() - cached.at < 4000) return cached.value;

  const keys: string[] = [];
  let numPages = 0;
  if (item.isAttachment()) keys.push(item.key);
  else {
    for (const id of item.getAttachments?.() || []) {
      const attachment = getItem(id);
      if (attachment) keys.push(attachment.key);
    }
  }

  const heat: number[] = [];
  let seconds = 0;
  let last = 0;
  for (const key of keys) {
    const record = addon.data.spectrum.reading.get(key);
    if (!record) continue;
    seconds += record.total;
    last = Math.max(last, record.last);
    numPages = Math.max(numPages, record.numPages);
    for (const [page, value] of Object.entries(record.pages)) {
      const index = Number(page);
      heat[index] = (heat[index] || 0) + value.t;
    }
  }
  const filled = heat.filter(Boolean).length;
  const total = numPages || heat.length;
  const value: ReadingSummary = {
    seconds,
    minutes: Math.round(seconds / 60),
    pagesTouched: filled,
    numPages: total,
    coverage: total ? filled / total : 0,
    heat,
    maxHeat: heat.reduce((max, value) => Math.max(max, value || 0), 0),
    last,
  };
  summaryCache.set(item.id, { at: Date.now(), value });
  return value;
}

export interface AnnotationHeat {
  perPage: number[];
  total: number;
  count: number;
  colors: Record<string, number>;
}

const heatCache = new Map<number, { at: number; value: AnnotationHeat }>();

/** Characters of annotation text per page — the "annotation density" column. */
export function annotationHeat(item: Zotero.Item): AnnotationHeat {
  const cached = heatCache.get(item.id);
  if (cached && Date.now() - cached.at < 4000) return cached.value;
  const perPage: number[] = [];
  const colors: Record<string, number> = {};
  let total = 0;
  let count = 0;
  const attachments = item.isAttachment()
    ? [item]
    : (item.getAttachments?.() || [])
        .map((id) => getItem(id))
        .filter(Boolean as any as (v: Zotero.Item | null) => v is Zotero.Item);
  for (const attachment of attachments) {
    for (const annotation of readAnnotations(attachment)) {
      const length = (annotation.text || "").length + (annotation.comment || "").length;
      if (annotation.page >= 0) {
        perPage[annotation.page] = (perPage[annotation.page] || 0) + length;
      }
      total += length;
      count += 1;
      if (annotation.color) {
        colors[annotation.color] = (colors[annotation.color] || 0) + 1;
      }
    }
  }
  const value: AnnotationHeat = { perPage, total, count, colors };
  heatCache.set(item.id, { at: Date.now(), value });
  return value;
}

export function rhythm(): RhythmFile {
  return rhythmStore.get();
}

/** Consecutive days with any reading time, counting back from today. */
export function streak(): number {
  const data = rhythmStore.get();
  let count = 0;
  const cursor = new Date();
  for (;;) {
    const key = localDay(cursor);
    const day = data[key];
    if (!day || day.seconds < 60) {
      // today not yet started still counts as an unbroken streak
      if (count === 0 && key === today()) {
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
      break;
    }
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

export function readingClear(item: Zotero.Item) {
  const keys = item.isAttachment()
    ? [item.key]
    : (item.getAttachments?.() || [])
        .map((id) => getItem(id)?.key)
        .filter(Boolean as any as (v: string | undefined) => v is string);
  for (const key of keys) addon.data.spectrum.reading.delete(key);
  summaryCache.delete(item.id);
  readingStore.set(exportRecords());
  readingStore.schedule(1000);
}

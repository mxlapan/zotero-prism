/**
 * Spaced review of your own highlights.
 *
 * Highlighting is cheap; remembering what you highlighted is not. Every
 * annotation enters a light SM-2-style queue, and Prism resurfaces a handful
 * each day with a link straight back to the page it came from.
 */

import { JSONStore } from "../../utils/store";
import { getPref } from "../../utils/prefs";
import { getItem, readAnnotations, type AnnotationInfo } from "../../utils/item";

export interface Card {
  /** annotation key */
  key: string;
  attachmentID: number;
  itemID: number;
  /** epoch day the card is next due */
  due: number;
  /** index into the interval ladder */
  step: number;
  lapses: number;
  reviews: number;
  lastGrade?: string;
  added: number;
}

type DeckFile = Record<string, Card>;

const store = new JSONStore<DeckFile>("review", {});
let loaded = false;

function today(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function ladder(): number[] {
  return getPref<string>("beam.reviewIntervals", "1,3,7,16,35,90")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => n > 0);
}

export async function initReview() {
  if (loaded) return;
  await store.load();
  loaded = true;
}

/** Add any annotation Prism has not seen before to the deck. */
export async function enrol(items: Zotero.Item[]) {
  await initReview();
  const deck = store.get();
  let added = 0;
  for (const item of items) {
    if (!item?.isRegularItem?.()) continue;
    for (const id of item.getAttachments?.() || []) {
      const attachment = getItem(id);
      if (!attachment) continue;
      for (const annotation of readAnnotations(attachment)) {
        if (deck[annotation.key]) continue;
        if ((annotation.text || annotation.comment || "").length < 25) continue;
        deck[annotation.key] = {
          key: annotation.key,
          attachmentID: attachment.id,
          itemID: item.id,
          due: today() + 1,
          step: 0,
          lapses: 0,
          reviews: 0,
          added: Date.now(),
        };
        added++;
      }
    }
  }
  if (added) {
    store.set(deck);
    store.schedule(2000);
  }
  return added;
}

export interface DueCard extends Card {
  annotation: AnnotationInfo;
  title: string;
}

export async function dueCards(limit?: number): Promise<DueCard[]> {
  await initReview();
  const max = limit ?? Number(getPref("beam.reviewDaily", 12));
  const deck = store.get();
  const now = today();
  const out: DueCard[] = [];
  for (const card of Object.values(deck)) {
    if (card.due > now) continue;
    const attachment = getItem(card.attachmentID);
    const item = getItem(card.itemID);
    if (!attachment || !item) continue;
    const annotation = readAnnotations(attachment).find((a) => a.key === card.key);
    if (!annotation) continue;
    out.push({
      ...card,
      annotation,
      title: String(item.getField("title") || ""),
    });
    if (out.length >= max * 3) break;
  }
  // oldest due first, then least reviewed
  out.sort((a, b) => a.due - b.due || a.reviews - b.reviews);
  return out.slice(0, max);
}

export async function grade(key: string, result: "again" | "good" | "easy") {
  await initReview();
  const deck = store.get();
  const card = deck[key];
  if (!card) return;
  const steps = ladder();
  card.reviews++;
  card.lastGrade = result;
  if (result === "again") {
    card.lapses++;
    card.step = 0;
    card.due = today() + 1;
  } else {
    card.step = Math.min(steps.length - 1, card.step + (result === "easy" ? 2 : 1));
    card.due = today() + steps[card.step];
  }
  store.set(deck);
  store.schedule(1500);
}

export async function bury(key: string) {
  await initReview();
  const deck = store.get();
  if (deck[key]) {
    deck[key].due = today() + 30;
    store.set(deck);
    store.schedule(1500);
  }
}

export async function forget(key: string) {
  await initReview();
  const deck = store.get();
  delete deck[key];
  store.set(deck);
  store.schedule(1500);
}

export async function deckStats() {
  await initReview();
  const deck = Object.values(store.get());
  const now = today();
  return {
    total: deck.length,
    due: deck.filter((card) => card.due <= now).length,
    mature: deck.filter((card) => card.step >= 3).length,
    lapses: deck.reduce((sum, card) => sum + card.lapses, 0),
  };
}

export async function flushReview() {
  await store.flush();
}

/**
 * Highlights and underlines, carried from the original onto its translation.
 *
 * Zotero draws an annotation where its words sit in the original. Over a
 * translated paragraph those spots hold other words — the translation runs
 * shorter or longer and in another order — so the marks there pointed at the
 * wrong text, or at blank paper past the end of a short translation. Instead,
 * the quoted text is found in the paragraph's original, and the same sentences
 * are marked in the translation. Pure: no DOM, no Zotero.
 */

import { splitSentences } from "../../utils/text";

export interface Mark {
  /** character range in the translated text */
  start: number;
  end: number;
  color: string;
  kind: "highlight" | "underline";
}

/** Letters and digits only, lower-cased, with a map back to the source index. */
function normalise(text: string): { flat: string; index: number[] } {
  let flat = "";
  const index: number[] = [];
  const source = text.normalize("NFKC");
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (/[\s\-­‐-―]/.test(ch)) continue;
    flat += ch.toLowerCase();
    index.push(i);
  }
  return { flat, index };
}

/**
 * Where a quoted passage sits in a paragraph's original text.
 *
 * Whitespace, hyphenation and ligatures differ between Zotero's quote and our
 * paragraph, so the match is made on letters alone. A quote that runs on into
 * the next paragraph, or began in the one before, matches by its first or last
 * stretch, and covers the rest of this paragraph from there.
 */
export function locateQuote(original: string, quote: string): [number, number] | null {
  const o = normalise(original);
  const q = normalise(quote).flat;
  if (!q || !o.flat) return null;
  const at = (flatStart: number, flatEnd: number): [number, number] => [
    o.index[flatStart] ?? 0,
    (o.index[flatEnd - 1] ?? original.length - 1) + 1,
  ];
  const whole = o.flat.indexOf(q);
  if (whole >= 0) return at(whole, whole + q.length);

  const k = Math.min(24, q.length);
  if (k < 6) return null;
  const head = o.flat.indexOf(q.slice(0, k));
  const tail = o.flat.lastIndexOf(q.slice(-k));
  if (head >= 0 && (tail < 0 || tail < head)) return at(head, o.flat.length);
  if (tail >= 0 && head < 0) return at(0, tail + k);
  if (head >= 0 && tail > head) return at(head, tail + k);
  return null;
}

/** Sentences with their character ranges, in order. */
function sentenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const sentence of splitSentences(text)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const start = text.indexOf(trimmed, cursor);
    if (start < 0) return [];
    spans.push([start, start + trimmed.length]);
    cursor = start + trimmed.length;
  }
  return spans;
}

const BREAKS = /[。！？；，、,.;:!?：]/;

/**
 * The part of the translation that renders a range of the original.
 *
 * When both sides split into the same number of sentences, the sentences the
 * range touches are marked whole. Otherwise the range is scaled to the
 * translation's length and widened to the nearest clause boundaries.
 */
export function mapToTranslation(
  original: string,
  translated: string,
  range: [number, number],
): [number, number] | null {
  const [a, b] = range;
  if (!translated.length || !original.length || b <= a) return null;
  const from = sentenceSpans(original);
  const to = sentenceSpans(translated);
  if (from.length && from.length === to.length) {
    const hit = from
      .map((span, i) => (Math.min(span[1], b) - Math.max(span[0], a) > 0 ? i : -1))
      .filter((i) => i >= 0);
    if (hit.length) return [to[hit[0]][0], to[hit[hit.length - 1]][1]];
  }

  let start = Math.floor((a / original.length) * translated.length);
  let end = Math.ceil((b / original.length) * translated.length);
  if (a === 0) start = 0;
  if (b >= original.length) end = translated.length;
  for (let i = start, n = 0; i > 0 && n < 12; i--, n++) {
    if (BREAKS.test(translated[i - 1])) {
      start = i;
      break;
    }
  }
  for (let i = end, n = 0; i < translated.length && n < 12; i++, n++) {
    if (BREAKS.test(translated[i])) {
      end = i + 1;
      break;
    }
  }
  while (start < end && /\s/.test(translated[start])) start++;
  return end > start ? [start, Math.min(end, translated.length)] : null;
}

/**
 * Split one line of the translation into runs, each with the marks over it.
 * `offset` is where the line starts in the whole translated text.
 */
export function runsOf(
  line: string,
  offset: number,
  marks: Mark[],
): Array<{ text: string; marks: Mark[] }> {
  const cuts = new Set([0, line.length]);
  for (const mark of marks) {
    const s = mark.start - offset;
    const e = mark.end - offset;
    if (e <= 0 || s >= line.length) continue;
    cuts.add(Math.max(0, s));
    cuts.add(Math.min(line.length, e));
  }
  const points = [...cuts].sort((x, y) => x - y);
  const runs: Array<{ text: string; marks: Mark[] }> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const s = points[i];
    const e = points[i + 1];
    if (e <= s) continue;
    runs.push({
      text: line.slice(s, e),
      marks: marks.filter((mark) => mark.start - offset < e && mark.end - offset > s),
    });
  }
  return runs;
}

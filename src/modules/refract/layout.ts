/**
 * Turning a PDF page into translatable paragraphs.
 *
 * PDF.js hands us positioned text runs with no notion of lines, columns or
 * paragraphs. This module rebuilds that structure so a translation can be laid
 * back over the page in the right place — and, just as importantly, decides
 * what should not be translated at all.
 */

export interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
}

export interface Line {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  runs: TextRun[];
  /** how many pieces this baseline was split into (a table row has several) */
  cells?: number;
  /** which column of the page it sits in; -1 spans a gutter */
  column?: number;
  /** the true ink extent, which a drifting baseline puts away from `y` */
  bottom?: number;
  top?: number;
}

export interface Paragraph {
  text: string;
  /** PDF-space bounding box: left, bottom, right, top */
  box: [number, number, number, number];
  fontSize: number;
  lines: Line[];
  kind:
    | "body"
    | "heading"
    | "caption"
    | "reference"
    | "short"
    | "formula"
    | "furniture"
    | "tabular";
}

const LIGATURES: Array<[RegExp, string]> = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/­/g, ""],
  [/‐/g, "-"],
];

/** PDF text carries ligatures and soft hyphens that no engine handles well. */
export function normaliseText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of LIGATURES) out = out.replace(pattern, replacement);
  return out;
}

export function runsFromTextContent(content: any): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of content.items || []) {
    if (!item.str || !item.str.trim()) continue;
    // Rotated text — a margin stamp, a vertical axis label — is never body
    // text. PDF.js gives its origin and its length along the rotated axis, so
    // read as horizontal it lies across whatever line shares that baseline.
    // Only the rotation term counts: a faked italic shears the matrix (c) but
    // leaves the baseline horizontal (b = 0).
    const [scaleX, rotation] = item.transform;
    if (Math.abs(rotation) > Math.abs(scaleX) * 0.05) continue;
    const width = Math.abs(item.width || 0);
    const height = Math.abs(item.height || 0) || 10;
    let x = item.transform[4];
    if (item.width < 0) x += item.width;
    runs.push({
      str: normaliseText(item.str),
      x,
      y: item.transform[5],
      width,
      height,
      fontName: item.fontName,
    });
  }
  return runs;
}

/** A citation marker or footnote dagger set above the line. */
function isSuperscript(run: TextRun, lineHeight: number): boolean {
  if (run.height >= lineHeight * 0.74) return false;
  const text = run.str.trim();
  if (!text || text.length > 6) return false;
  // A citation marker or footnote dagger…
  if (/^[\d,\-–*†‡§]+$/.test(text)) return true;
  // …or a subscript PDF.js has flattened onto a baseline of its own. These sit
  // between two lines of text, and the paragraph that adopts one gets a box
  // reaching up into the line above, whose translation it then paints over —
  // "t t" alone on a line, clipping the sentence above it to its top 2pt.
  return /^[\p{L}][\p{L}\p{N}]?[+\-−]?\d*$/u.test(text);
}

/**
 * Group runs sharing a baseline into lines — and split each baseline wherever a
 * gap opens up that is too wide to be a word space.
 *
 * This is the single most damaging thing PDF.js leaves to the caller. In a
 * two-column paper the left column's line and the right column's line sit on
 * the *same baseline*, so grouping by baseline alone welds them into one:
 * "1. Introduction rolling production, but also plays an important role" was a
 * real string this used to send to the translator, and every paragraph built
 * from those lines was two half-sentences from two different places.
 */
/**
 * The vertical white channels between columns.
 *
 * Two attempts at this failed before the third worked, and both failures are
 * worth keeping in mind. Splitting on a gap wider than ~2 font sizes misses a
 * journal whose columns are 15pt apart — every baseline was welded across the
 * gutter and the request read "the research works on multi-crane scheduling
 * scheduling in steelmaking workshops, based on produc- mainly focuses on…".
 * Looking for a band of the page with no ink in it fails on any page carrying
 * one wide figure or caption, because a handful of crossing lines is enough to
 * fill the band.
 *
 * No single measure survives every page, so three vote and the answers are
 * clustered: gaps shared by most baselines, a channel the lines that reach past
 * it stay out of, and a left edge far too many lines share to be an accident.
 * Each covers where the others are blind — voting sees nothing when the columns
 * do not share baselines, and neither of the other two can find the gutter on a
 * title page, where the only lines crossing it are the title and the byline.
 */
export function findGutters(runs: TextRun[], pageWidth: number): number[] {
  if (runs.length < 40 || !(pageWidth > 0)) return [];
  const rows = baselineRows(runs);
  if (rows.length < 12) return [];
  const found = [
    ...quietBands(rows, pageWidth).map((at) => ({ at, band: true })),
    ...columnStarts(rows, pageWidth).map((at) => ({ at, band: true })),
    ...voteOnGaps(rows, pageWidth).map((at) => ({ at, band: false })),
  ].sort((a, b) => a.at - b.at);

  // The two signals usually land a point or two apart; cluster them and take
  // the whitespace centre where there is one, since a vote is only the middle
  // of whatever gaps happened to be measured.
  const clusters: Array<Array<{ at: number; band: boolean }>> = [];
  for (const entry of found) {
    const last = clusters[clusters.length - 1];
    // Measured from the cluster's first member, not its last: chaining let a
    // reference list's "[1]" channel 20pt away join the real gutter's cluster
    // and win the median.
    if (last && entry.at - last[0].at <= 12) last.push(entry);
    else clusters.push([entry]);
  }

  /* A gutter implies a column on either side of it, and a column 20pt wide is
     not a column — it is the hanging indent of a reference list, whose "[1]"
     sits in its own little channel on every line of the page. Splitting there
     tears the number off every entry. */
  const minColumn = pageWidth * 0.12;
  const gutters: number[] = [];
  let previous = 0;
  for (const cluster of clusters) {
    const preferred = cluster.filter((entry) => entry.band);
    const values = (preferred.length ? preferred : cluster)
      .map((entry) => entry.at)
      .sort((a, b) => a - b);
    const at = values[Math.floor(values.length / 2)];
    if (at - previous < minColumn || pageWidth - at < minColumn) continue;
    if (!isQuietAt(rows, at)) continue;
    gutters.push(at);
    previous = at;
  }
  return gutters;
}

/**
 * Last check on a candidate: do the lines that reach past both sides of it
 * actually stay out of it?
 *
 * The column-start signal is the one that needs this. On a page whose figure
 * has a y-axis of tick labels down the left, it reads the body's left margin as
 * the start of a second column and puts a gutter through the middle of the
 * running text — which then splits every line of the page in half. Lines that
 * do not reach the candidate say nothing either way, and where *none* of them
 * does the candidate is accepted: that is the title page, where the only lines
 * crossing the gutter are the title and the byline.
 */
function isQuietAt(rows: TextRun[][], at: number): boolean {
  let straddle = 0;
  let crossed = 0;
  for (const row of rows) {
    let left = Infinity;
    let right = -Infinity;
    let hit = false;
    for (const run of row) {
      left = Math.min(left, run.x);
      right = Math.max(right, run.x + run.width);
      if (run.x < at + 2 && run.x + run.width > at - 2) hit = true;
    }
    if (left >= at - 2 || right <= at + 2) continue;
    straddle++;
    if (hit) crossed++;
  }
  return straddle < 8 || crossed <= Math.max(1, straddle * 0.35);
}

/**
 * Which column a piece of a baseline belongs to — or -1 for one that spans a
 * gutter, which is a full-width caption, table row or running head rather than
 * a line of either column.
 */
export function columnOf(left: number, right: number, gutters: number[]): number {
  if (!gutters.length) return 0;
  for (const gutter of gutters) {
    if (left < gutter - 1 && right > gutter + 1) return -1;
  }
  let index = 0;
  for (const gutter of gutters) if (left >= gutter - 1) index++;
  return index;
}

/** Runs grouped by baseline, the same way `toLines` groups them. */
function baselineRows(runs: TextRun[]): TextRun[][] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextRun[][] = [];
  let lastY = Infinity;
  for (const run of sorted) {
    const tolerance = Math.max(2, run.height * 0.45);
    if (rows.length && Math.abs(lastY - run.y) <= tolerance) {
      rows[rows.length - 1].push(run);
    } else {
      rows.push([run]);
      lastY = run.y;
    }
  }
  return rows;
}

/**
 * Signal one: in a two-column page whose columns share baselines, nearly every
 * baseline has a gap at the same x, and in a one-column page almost none does.
 */
function voteOnGaps(rows: TextRun[][], pageWidth: number): number[] {
  const bin = 4;
  const votes = new Map<number, number>();
  for (const row of rows) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    const seen = new Set<number>();
    let end = sorted[0].x + sorted[0].width;
    for (let i = 1; i < sorted.length; i++) {
      const run = sorted[i];
      const gap = run.x - end;
      if (gap > 8 && run.x < pageWidth * 0.9 && end > pageWidth * 0.1) {
        const centre = Math.round((end + run.x) / 2 / bin);
        if (!seen.has(centre)) {
          seen.add(centre);
          votes.set(centre, (votes.get(centre) || 0) + 1);
        }
      }
      end = Math.max(end, run.x + run.width);
    }
  }

  const needed = Math.max(6, rows.length * 0.25);
  const gutters: number[] = [];
  for (const [centre, count] of votes) {
    if (count < needed) continue;
    // Neighbouring bins are the same gutter; keep the busiest.
    const rival = [...votes.entries()].find(
      ([other, otherCount]) =>
        other !== centre && Math.abs(other - centre) <= 1 && otherCount > count,
    );
    if (!rival) gutters.push(centre * bin);
  }
  return gutters;
}

/**
 * Signal three: a left edge that far too many lines share to be a coincidence.
 *
 * Neither of the other two can see the gutter on a title page, where the only
 * lines reaching across it — the title, the authors, the masthead — are exactly
 * the ones that fill it. But a second column announces itself anyway: twenty
 * lines all starting at the same x, with nothing of theirs to the left of it.
 */
function columnStarts(rows: TextRun[][], pageWidth: number): number[] {
  const bin = 2;
  const counts = new Map<number, number>();
  const pieces: Array<[number, number]> = [];
  for (const row of rows) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    let left = sorted[0].x;
    let end = sorted[0].x + sorted[0].width;
    const flush = () => {
      pieces.push([left, end]);
      const key = Math.round(left / bin);
      counts.set(key, (counts.get(key) || 0) + 1);
    };
    for (let i = 1; i < sorted.length; i++) {
      const run = sorted[i];
      if (run.x - end > 8) {
        flush();
        left = run.x;
      } else if (run.x + run.width <= end) {
        continue;
      }
      end = Math.max(end, run.x + run.width);
    }
    flush();
  }

  const needed = Math.max(8, rows.length * 0.2);
  const gutters: number[] = [];
  for (const [key, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    const before = counts.get(key - 1) || 0;
    const after = counts.get(key + 1) || 0;
    if (count < before || count < after) continue; // the neighbour is the edge
    if (count + before + after < needed) continue;
    const start = key * bin;
    // Only lines that stop short of it count: a title crossing the gutter says
    // nothing about where the gutter is.
    let right = -Infinity;
    for (const [pieceLeft, pieceRight] of pieces) {
      if (pieceLeft < start - 1 && pieceRight <= start + 1) right = Math.max(right, pieceRight);
    }
    if (!Number.isFinite(right) || start - right < 3) continue;
    gutters.push((right + start) / 2);
  }
  return gutters;
}

/**
 * Signal two: a vertical channel almost no line puts ink into.
 *
 * Voting on gaps only sees a gutter when the two columns share baselines, and
 * they often do not: this journal sets its right column 6.5pt below its left,
 * so every baseline held one column, no baseline had an internal gap, and not
 * one gutter was found — which left the occasional drifting baseline welded
 * ("…It can realize a sys- The deep reinforcement learning-based crane
 * scheduling"), and, far worse, poisoned the per-column right edge so that
 * *every* line looked like the short last line of a paragraph and no two lines
 * ever joined. A 12-page paper came out as 282 one-line "paragraphs".
 *
 * The measure has to be relative, not absolute: an earlier attempt looked for a
 * band with no ink at all and was defeated by a single wide caption crossing
 * it. Here only the lines that reach past both sides of the band get a vote, so
 * a handful of full-width lines cannot outvote thirty two-column ones.
 */
function quietBands(rows: TextRun[][], pageWidth: number): number[] {
  const step = 2;
  const cells = Math.ceil(pageWidth / step);
  if (cells < 20) return [];
  const ink: Uint8Array[] = [];
  const spans: Array<[number, number]> = [];
  for (const row of rows) {
    const hit = new Uint8Array(cells);
    let left = cells;
    let right = -1;
    for (const run of row) {
      const from = Math.max(0, Math.floor(run.x / step));
      const to = Math.min(cells - 1, Math.floor((run.x + run.width) / step));
      if (to < from) continue;
      for (let i = from; i <= to; i++) hit[i] = 1;
      left = Math.min(left, from);
      right = Math.max(right, to);
    }
    if (right < 0) continue;
    ink.push(hit);
    spans.push([left, right]);
  }

  const first = Math.floor((pageWidth * 0.15) / step);
  const last = Math.ceil((pageWidth * 0.85) / step);
  const quiet: boolean[] = [];
  for (let i = first; i <= last && i < cells; i++) {
    let straddle = 0;
    let crossed = 0;
    for (let r = 0; r < ink.length; r++) {
      if (spans[r][0] >= i || spans[r][1] <= i) continue;
      straddle++;
      if (ink[r][i]) crossed++;
    }
    quiet[i] = straddle >= 8 && crossed <= Math.max(1, straddle * 0.3);
  }

  const gutters: number[] = [];
  let start = -1;
  for (let i = first; i <= last + 1; i++) {
    if (quiet[i]) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      if ((i - start) * step >= 6) gutters.push(((start + i) / 2) * step);
      start = -1;
    }
  }
  return gutters;
}

export function toLines(runs: TextRun[], pageWidth = 0): Line[] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const baselines: Line[] = [];
  for (const run of sorted) {
    const last = baselines[baselines.length - 1];
    const tolerance = Math.max(2, run.height * 0.45);
    if (last && Math.abs(last.y - run.y) <= tolerance) {
      last.runs.push(run);
    } else {
      baselines.push({ text: "", x: 0, y: run.y, width: 0, height: run.height, runs: [run] });
    }
  }

  const gutters = findGutters(runs, pageWidth);
  // Measured over the page, not the baseline: a stray subscript on a line of
  // its own is the tallest thing there, so it can never be small compared with
  // itself.
  const bodyHeight = median(runs.map((run) => run.height));
  const lines: Line[] = [];
  for (const baseline of baselines) {
    baseline.runs.sort((a, b) => a.x - b.x);
    const height = median(baseline.runs.map((r) => r.height));
    const pieces = splitAtGaps(baseline.runs, height, gutters);
    for (const piece of pieces) {
      /* Measured against this piece, not the whole baseline: a two-column page
         welds a 15pt heading onto the same baseline as 9.5pt body text, and
         against 15pt every glyph of that body line looks like a superscript —
         which is how the hyphen of "reinforce-/ment" was thrown away, leaving
         it uncovered on the page and "reinforce ment" in the request. */
      const pieceHeight = median(piece.map((r) => r.height)) || height;
      const kept = piece.filter(
        (run) => !isSuperscript(run, Math.max(pieceHeight, bodyHeight)),
      );
      if (!kept.length) continue;
      // Geometry from every run, text from the ones that are not markers: a
      // citation marker left out of the translation still has to be covered by
      // it, or it stays on the page.
      const left = Math.min(...piece.map((r) => r.x));
      const right = Math.max(...piece.map((r) => r.x + r.width));
      /* The group's y is the *seed* run's, and runs join it within half a font
         size, so a heading whose neighbour set the seed can sit 6.5pt below the
         y this line reports. Painting a box from that y leaves a strip of the
         original showing underneath — a bold English line under the Chinese
         heading, which is what this looked like on the page. */
      lines.push({
        text: joinRuns(kept),
        x: left,
        y: median(kept.map((r) => r.y)),
        width: right - left,
        height: median(kept.map((r) => r.height)) || pieceHeight,
        bottom: Math.min(...piece.map((r) => r.y)),
        top: Math.max(...piece.map((r) => r.y + r.height)),
        runs: kept,
        cells: pieces.length,
        column: columnOf(left, right, gutters),
      });
    }
  }
  return lines;
}

/** Split a baseline at the page's gutters, and at gaps too wide to be spaces. */
function splitAtGaps(runs: TextRun[], height: number, gutters: number[] = []): TextRun[][] {
  const limit = Math.max(12, height * 2.2);
  const pieces: TextRun[][] = [[]];
  let previousEnd: number | null = null;
  for (const run of runs) {
    const centre = run.x + run.width / 2;
    // A gutter is at least 6pt of white by construction, so a boundary that is
    // only a word space wide is not the gutter however close to it it falls.
    const crossed =
      previousEnd !== null &&
      run.x - previousEnd >= 3 &&
      gutters.some((gutter) => previousEnd! <= gutter && centre > gutter);
    if (previousEnd !== null && (crossed || run.x - previousEnd > limit)) pieces.push([]);
    pieces[pieces.length - 1].push(run);
    previousEnd = Math.max(previousEnd ?? run.x, run.x + run.width);
  }
  return pieces.filter((piece) => piece.length);
}

function joinRuns(runs: TextRun[]): string {
  let text = "";
  let previousEnd: number | null = null;
  for (const run of runs) {
    if (previousEnd !== null) {
      const gap = run.x - previousEnd;
      // 0.22em was one twentieth of a point too wide: this journal sets its
      // word spaces 2.06pt apart at 9.5pt, so every space the PDF positioned
      // rather than encoded was dropped and the translator was sent
      // "wherekis the times of iteration". Kerning inside a word is an order
      // of magnitude smaller than this, so the looser test is still safe.
      if (gap > Math.max(0.6, run.height * 0.14) && !/\s$/.test(text)) text += " ";
    }
    text += run.str;
    previousEnd = run.x + run.width;
  }
  return text.replace(/\s+/g, " ").trim();
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/* ------------------------------------------------------------ classifiers */

const REFERENCE_MARKERS =
  /^(references?|bibliography|acknowledge?ments?|参考文献|致谢)\s*$/i;

/** "(2) ", "3. ", "[4] ", "- " — the head of a list item. */
const LIST_MARKER = /^\s*(?:\(\d+\)|\[\d+\]|\d+[.)]|[•▪‣·–—-])\s/;

/** "3.2. Slab yard layout" — a numbered section heading, whatever its size. */
const SECTION_HEADING = /^\d+(?:\.\d+)*\.?\s+\p{Lu}/u;

/**
 * Is this block mathematics rather than prose?
 *
 * A translated equation is worse than an untranslated one: the engine reflows
 * the symbols, drops the sub/superscripts PDF.js has already flattened into the
 * text, and what lands on the page is neither the formula nor a sentence. These
 * blocks are left alone, so the original equation shows through untouched.
 */
export function isFormula(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 2) return false;
  const words = text.match(/\p{L}{4,}/gu) || [];
  const mathChars =
    compact.match(
      /[=+×÷±∓<>≤≥≈≠∝∈∉⊂⊆∀∃∧∨¬∑∏∫∬∮√∂∇∞→←↔⇒⇔·⋅∥|^_{}[\]⎧⎨⎩⎪⎫⎬⎭]/gu,
    ) || [];
  const greek = compact.match(/[α-ωΑ-Ω]/gu) || [];
  const digits = compact.match(/\p{Nd}/gu) || [];
  const density = (mathChars.length + greek.length) / compact.length;

  // A brace or a big operator makes it a formula even with a few words in it:
  // "⎧0, When the action doesn't end," is one line of a piecewise definition.
  if (/[⎧⎨⎩⎪⎫⎬⎭∑∏∫∬∮√∇]/u.test(compact) && words.length <= 6) return true;
  if (density > 0.14 && words.length <= 2) return true;
  if (/\(\s*\d+\s*\)\s*$/.test(text.trim()) && words.length <= 4 && mathChars.length >= 2) {
    return true;
  }
  // A matrix row or a data line: mostly numbers, with at most a row label on it
  // ("0 1 2 3 … 29 Staring stations 0 0 1 0 0 …").
  const digitRatio = digits.length / compact.length;
  if (words.length <= 1 && digitRatio > 0.25) return true;
  if (words.length <= 3 && digitRatio > 0.35) return true;
  if (digitRatio > 0.5) return true;
  return false;
}

const FURNITURE_PATTERNS: RegExp[] = [
  /^https?:\/\//i,
  /^(doi|https?:\/\/doi\.org)\b/i,
  /^10\.\d{4,}\//,
  // also the IEEE brace list: "{uk089421, v.schmidtke, stursberg}@uni-kassel.de"
  /(?:\b[\w.+-]+|\})@[\w-]+\.[\w.]+\b/,
  /©|\(c\)\s*\d{4}|all rights reserved/i,
  /\bissn\b|\bisbn\b/i,
  /contents lists available|journal homepage|sciencedirect|springer|wiley|taylor\s*&\s*francis|elsevier/i,
  /^(received|revised|accepted|available online|published online|first published)\b/i,
  /^\s*\d{1,4}\s*$/,
  /^(?:\p{Lu}\s){4,}/u, // "A R T I C L E   I N F O"
  /^(downloaded from|preprint|arxiv:)/i,
  // a licence notice can sit at the end of a column, right under the text
  /licensed under|creative commons|this work is licensed|open access\b/i,
  /\b(de gruyter|sage publications|ieee|acm|mdpi|frontiers media|informs|emerald|springer nature)\b/i,
  // the journal's own section label above the title
  /^(review|research|original|regular|short|brief|rapid|full)?\s*(article|paper|communication|report|note|editorial|perspective|letter)s?\s*$/i,
  // the tail of an address: "Beijing 100083, China"
  /^[\p{Lu}][\p{L}\s.'-]{0,40}\s\d{4,6},?\s*[\p{Lu}][\p{L}\s]{2,20}$/u,
  // "Buxin Su: China Metallurgical Industry Planning and Research Institute".
  // Two capitalised words at least: with one, this swallowed the first line of
  // every abstract ("Abstract: Aiming at the crane scheduling problem for"),
  // which also closed the bucket and cost the paragraph its opening sentence.
  /^\p{Lu}[\p{L}.\-]+(?:[,\s]+\p{Lu}[\p{L}.\-]+)+\s*[:：]\s*\p{Lu}[^.!?]{10,}$/u,
];

const AFFILIATION =
  /\b(university|universit[aä]t|institute|laborator(y|ies)|department|school of|college|academy|ministry of|hospital|centre for|center for|co\.,?\s*ltd|group co|corporation|research cent(er|re))\b/i;

/**
 * Running heads, mastheads, DOIs, copyright lines, e-mail addresses,
 * affiliations — everything around the article that is not the article.
 *
 * Translating them is worse than leaving them: an address in Chinese is no
 * easier to read, the journal's own name becomes unrecognisable, and a DOI or
 * an e-mail address comes back subtly corrupted.
 */
export function isFurniture(
  text: string,
  position: { top?: boolean; bottom?: boolean } = {},
): boolean {
  if (matchesFurniturePattern(text)) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  // An affiliation line: an institution *and* something that makes it an
  // address — a marker letter, a postcode, a country. The institution alone is
  // not enough: "…Mellon University in the United States proposed the…" is a
  // sentence, and dropping it left a strip of untranslated English across the
  // page where the rest of its paragraph had been replaced.
  if (
    AFFILIATION.test(trimmed) &&
    trimmed.length < 220 &&
    !/\.\s+\p{Lu}/u.test(trimmed) &&
    (/^[a-z]\s/.test(trimmed) ||
      /^\d\s/.test(trimmed) ||
      // a footnote marker glued to the text: "1The authors are with the…"
      /^(?:\d{1,2}|[*†‡§¶])\s*\p{Lu}/u.test(trimmed) ||
      /\b(?:is|are)\s+(?:also\s+)?with\s+the\b/i.test(trimmed) ||
      /\b\d{4,6}\b/.test(trimmed) ||
      /,\s*\p{Lu}[\p{L}\s]{2,20}$/u.test(trimmed))
  ) {
    return true;
  }
  // The tail of an affiliation footnote, broken across lines: "Processing and
  // Bioengineering, Central South University,". A body paragraph never ends on
  // a comma — it would have joined the line below it — so this cannot take the
  // sentence-fragment cases the rule above was tightened for.
  if (AFFILIATION.test(trimmed) && trimmed.length < 140 && /,$/.test(trimmed)) return true;
  // The running head at the top or the imprint at the foot of the page: short,
  // and sitting outside the text block.
  if ((position.top || position.bottom) && trimmed.length < 140) {
    const sentences = trimmed.match(/[.!?]\s+\p{Lu}/gu) || [];
    if (!sentences.length) return true;
  }
  return false;
}

/**
 * The unambiguous half of the test — a DOI, an e-mail address, a copyright or
 * licence notice, a masthead. Safe to apply to a single line in the middle of a
 * column, which the softer heuristics are not.
 */
export function matchesFurniturePattern(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return FURNITURE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * A line of author names.
 *
 * Capitalised words, commas, no verb and no full stop — and it only counts near
 * the top of the first page, which is the only place this shape means authors
 * rather than prose.
 */
export function looksLikeAuthors(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 220 || trimmed.length < 6) return false;
  if (/[.!?]\s+\p{Lu}/u.test(trimmed)) return false;
  const words = trimmed.split(/[\s,]+/).filter(Boolean);
  if (words.length < 2 || words.length > 40) return false;
  const capitalised = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  const commas = (trimmed.match(/,/g) || []).length;
  const lower = words.filter((w) => /^\p{Ll}{4,}$/u.test(w)).length;
  return capitalised / words.length > 0.6 && commas >= 1 && lower <= 1;
}

/* -------------------------------------------------------------- paragraphs */

export interface ParagraphOptions {
  skipReferences?: boolean;
  skipCaptions?: boolean;
  /** leave mathematics untranslated (default true) */
  keepFormulas?: boolean;
  /** translate the article only — no running heads, imprints or addresses */
  bodyOnly?: boolean;
  /** page height in PDF units, for spotting headers and footers */
  pageHeight?: number;
  /** the first page, where the author line sits under the title */
  firstPage?: boolean;
  /**
   * Carried from page to page by the caller. The reference list starts on one
   * page and runs to the end of the document, so a flag reset at every page
   * boundary — which is what this was — switches "skip references" off again
   * on the next page and translates the whole bibliography.
   */
  state?: { inReferences: boolean };
}

interface Bucket {
  lines: Line[];
  left: number;
  right: number;
  lastY: number;
  height: number;
  column: number;
}

function overlap(a: Bucket | Line, b: Line): number {
  const left = Math.max("left" in a ? a.left : a.x, b.x);
  const right = Math.min("right" in a ? a.right : a.x + a.width, b.x + b.width);
  const width = Math.min(
    ("right" in a ? a.right - a.left : a.width) || 1,
    b.width || 1,
  );
  return Math.max(0, right - left) / width;
}

/**
 * Build paragraphs by following each column of text down the page.
 *
 * Rather than deciding up front how many columns the page has — which fails on
 * the first page of nearly every paper, where an abstract box, an author block
 * and a two-column body all want different answers — this keeps one open
 * bucket per stream of text and appends each line to the bucket it actually
 * overlaps. Lines from a different column never join, whatever their baseline.
 */
export function toParagraphs(
  lines: Line[],
  pageWidth: number,
  options: ParagraphOptions = {},
): Paragraph[] {
  if (!lines.length) return [];
  const ordered = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const bodySize = median(lines.map((line) => line.height));
  const columnRight = rightEdges(ordered);

  const open: Bucket[] = [];
  const done: Line[][] = [];

  const close = (bucket: Bucket) => {
    const at = open.indexOf(bucket);
    if (at >= 0) open.splice(at, 1);
    if (bucket.lines.length) done.push(bucket.lines);
  };

  const high = options.pageHeight ? options.pageHeight * 0.93 : Infinity;
  const low = options.pageHeight ? options.pageHeight * 0.075 : -Infinity;
  // The front matter of page 1. The top band alone missed an author line that
  // sat under a two-line title, and it came back as transliterated names.
  const front = options.firstPage && options.pageHeight ? options.pageHeight * 0.6 : Infinity;

  for (const line of ordered) {
    /* A licence notice or an imprint sitting directly under the last line of a
       column is close enough to join it, and then the whole paragraph carries
       "This work is licensed under the Creative Commons…" into the translator
       — which is how a body paragraph came back ending "…的许可。". Furniture is
       kept out of every bucket and left to stand alone. */
    const isolated = matchesFurniturePattern(line.text);
    if (isolated) {
      for (const bucket of [...open]) {
        if (overlap(bucket, line) >= 0.55) close(bucket);
      }
      done.push([line]);
      continue;
    }

    // Buckets the page has moved well past are finished.
    for (const bucket of [...open]) {
      if (bucket.lastY - line.y > Math.max(bucket.height, line.height) * 4) close(bucket);
    }

    let best: Bucket | null = null;
    let bestScore = 0;
    const column = line.column ?? 0;
    for (const bucket of open) {
      // Two columns can overlap horizontally when a line of one of them was
      // welded to a line of the other; the column index does not, so it is the
      // check that holds when the geometry has already gone wrong.
      if (bucket.column !== column) continue;
      const score = overlap(bucket, line);
      if (score > bestScore) {
        best = bucket;
        bestScore = score;
      }
    }

    const leading = best ? Math.max(best.height, line.height) : line.height;
    const gap = best ? best.lastY - line.y : Infinity;
    const previous = best?.lines[best.lines.length - 1];
    const hyphenated = previous ? /[-‐]$/.test(previous.text) : false;
    const shortLine =
      previous && !hyphenated
        ? previous.x + previous.width < columnRight(previous) - Math.max(6, leading * 1.2)
        : false;
    const sizeShift = previous
      ? Math.abs(line.height - previous.height) > leading * 0.35
      : false;
    /* An indent means a new paragraph only where the previous line ran to the
       right edge — otherwise `shortLine` has already ended the paragraph, and
       what is indented here is the *continuation* of a hanging indent: every
       numbered item on this page ("(2) Affected by action at, the environment
       status changes" / "to st+1, assessment on the selected action…") was cut
       in two by the older test. */
    /* An indent starts a new paragraph in a first-line-indent setting, and ends
       nothing at all in a hanging indent, where it is how every line after the
       first of a numbered item is set. The two are the same 16pt here, so the
       marker on the item's first line is what tells them apart; without this
       every list item on the page was cut in two ("(2) Affected by action at,
       the environment status changes" / "to st+1, assessment on the selected
       action…") and each half translated as if it were a sentence. */
    const hanging = best ? LIST_MARKER.test(best.lines[0].text) : false;
    // A heading set over two lines indents or centres the second one — "3.1
    // Basic principles of deep reinforcement" / "learning" — and splitting
    // there sends the engine a heading and a bare word.
    const display = line.height > bodySize * 1.18;
    const indented =
      previous && !hyphenated && !hanging && !display
        ? line.x - previous.x > line.height * 0.9
        : false;

    const continues =
      best !== null &&
      bestScore >= 0.55 &&
      gap > 0 &&
      gap <= leading * 2.1 &&
      !shortLine &&
      !sizeShift &&
      !indented &&
      !SECTION_HEADING.test(line.text);

    if (continues && best) {
      best.lines.push(line);
      best.left = Math.min(best.left, line.x);
      best.right = Math.max(best.right, line.x + line.width);
      best.lastY = line.y;
      best.height = Math.max(best.height, line.height);
      continue;
    }
    if (best && bestScore >= 0.55) close(best);
    open.push({
      lines: [line],
      left: line.x,
      right: line.x + line.width,
      lastY: line.y,
      height: line.height,
      column,
    });
  }
  for (const bucket of [...open]) close(bucket);

  const paragraphs = done
    .map((group) => {
      const sorted = [...group].sort((a, b) => b.y - a.y);
      const text = mergeLineText(sorted);
      if (text.trim().length < 2) return null;
      const position = {
        top: sorted[0].y >= high,
        bottom: sorted[sorted.length - 1].y <= low,
        front: sorted[0].y >= front,
      };
      return makeParagraph(sorted, text, bodySize, position);
    })
    .filter(Boolean) as Paragraph[];

  markFigureLabels(paragraphs);

  /* Where the reference list starts is a question about reading order, not
     about y: on a two-column page the whole right column follows a "References"
     heading that sits halfway down the left one. */
  const dropped = new Set<Paragraph>();
  if (options.skipReferences) {
    let inReferences = options.state?.inReferences ?? false;
    for (const paragraph of readingOrder(paragraphs, pageWidth)) {
      if (!inReferences && REFERENCE_MARKERS.test(paragraph.text.trim())) inReferences = true;
      if (inReferences) dropped.add(paragraph);
    }
    if (options.state) options.state.inReferences = inReferences;
  }

  return paragraphs.filter((paragraph) => {
    if (dropped.has(paragraph)) return false;
    if (options.keepFormulas !== false && paragraph.kind === "formula") return false;
    if (options.bodyOnly !== false && paragraph.kind === "furniture") return false;
    if (options.bodyOnly !== false && paragraph.kind === "tabular") return false;
    if (options.skipCaptions && paragraph.kind === "caption") return false;
    if (options.skipReferences && paragraph.kind === "reference") return false;
    return paragraph.text.replace(/[^\p{L}\p{N}]/gu, "").length >= 6;
  });
}

/**
 * Short pieces of text floating on their own inside a figure.
 *
 * A diagram's labels — "Environment", "Immediate reward", "The workshop where
 * crane is located" — are paragraphs as far as the layout is concerned, and
 * translating them paints white boxes across the drawing. Prose is never alone
 * on the page: it has a line of the same column within a couple of lines of it.
 */
function markFigureLabels(paragraphs: Paragraph[]) {
  for (const paragraph of paragraphs) {
    if (paragraph.kind !== "body" && paragraph.kind !== "short") continue;
    const words = paragraph.text.trim().split(/\s+/).filter(Boolean);
    // A label, not a sentence: a few words, no terminal punctuation.
    if (
      paragraph.text.length >= 40 ||
      paragraph.lines.length > 2 ||
      words.length > 6 ||
      /[.!?。！？]\s*$/.test(paragraph.text)
    ) {
      continue;
    }
    const neighbour = paragraphs.some((other) => {
      if (other === paragraph) return false;
      if (other.kind === "caption") return false;
      // Another label is not company: the labels of one diagram sit together,
      // and each would keep the others alive.
      const prose =
        other.text.length >= 40 || /[.!?。！？]\s*$/.test(other.text.trim());
      if (!prose) return false;
      const gap = Math.max(
        0,
        Math.max(other.box[1] - paragraph.box[3], paragraph.box[1] - other.box[3]),
      );
      if (gap > paragraph.fontSize * 2.6) return false;
      const left = Math.max(other.box[0], paragraph.box[0]);
      const right = Math.min(other.box[2], paragraph.box[2]);
      const width = Math.min(
        other.box[2] - other.box[0],
        paragraph.box[2] - paragraph.box[0],
      );
      return width > 0 && (right - left) / width > 0.3;
    });
    if (!neighbour) paragraph.kind = "furniture";
  }
}

/**
 * Where each column's text normally ends, for the "this line stopped early, so
 * the paragraph ended" test. Measured per column — against the page as a whole
 * every line in a narrow column looks short.
 */
function rightEdges(lines: Line[]): (line: Line) => number {
  const cache = new Map<Line, number>();
  return (line: Line) => {
    const hit = cache.get(line);
    if (hit !== undefined) return hit;
    const peers = lines.filter(
      (other) => (other.column ?? 0) === (line.column ?? 0) && overlap(other, line) >= 0.55,
    );
    const rights = peers.map((other) => other.x + other.width).sort((a, b) => a - b);
    const value =
      rights[Math.min(rights.length - 1, Math.floor(rights.length * 0.9))] ??
      line.x + line.width;
    cache.set(line, value);
    return value;
  };
}

function mergeLineText(lines: Line[]): string {
  let text = "";
  for (const line of lines) {
    const piece = line.text;
    if (!text) {
      text = piece;
      continue;
    }
    if (/-$/.test(text) && /^[a-z]/.test(piece)) {
      text = `${text.slice(0, -1)}${piece}`;
    } else {
      text += ` ${piece}`;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A row of a table rather than a line of prose.
 *
 * The cell count alone is not the signal — every baseline of a two-column
 * paper splits in two — so it takes three or more pieces, all of them short
 * enough to be cells.
 */
function isTabular(lines: Line[]): boolean {
  const first = lines[0];
  if (!first || (first.cells ?? 1) < 3) return false;
  return lines.every((line) => line.text.length <= 45);
}

function makeParagraph(
  lines: Line[],
  text: string,
  bodySize: number,
  position: { top?: boolean; bottom?: boolean; front?: boolean } = {},
): Paragraph {
  const left = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map((l) => l.x + l.width));
  const bottom = Math.min(...lines.map((l) => l.bottom ?? l.y));
  const top = Math.max(...lines.map((l) => l.top ?? l.y + l.height));
  const fontSize = median(lines.map((l) => l.height));

  let kind: Paragraph["kind"] = "body";
  if (isFormula(text)) kind = "formula";
  else if (isTabular(lines)) kind = "tabular";
  else if (isFurniture(text, position)) kind = "furniture";
  else if (position.top && looksLikeAuthors(text)) kind = "furniture";
  else if (position.front && lines.length <= 2 && looksLikeAuthors(text)) kind = "furniture";
  else if (/^(fig(ure)?|tab(le)?|图|表)\s*\.?\s*\d/i.test(text)) kind = "caption";
  else if (fontSize > bodySize * 1.22 && text.length < 160) kind = "heading";
  else if (SECTION_HEADING.test(text) && text.length < 90) kind = "heading";
  else if (/^\[\d+\]|^\d+\.\s+[A-Z][a-z]+,/.test(text) && text.length > 40) {
    kind = "reference";
  } else if (text.length < 24) kind = "short";

  return { text, box: [left, bottom, right, top], fontSize, lines, kind };
}

/* --------------------------------------------------------------- line flow */

const CLOSERS = /[，。、；：！？”’）》」』〕】%,.;:!?)\]}]/;

function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

/**
 * How wide one character is, in em.
 *
 * Deliberately an estimate rather than a canvas measurement: the viewer runs in
 * an unprivileged iframe, and a `measureText` round trip per character across
 * that boundary is both slow and fragile. The numbers are Times-ish, and the
 * renderer checks the result against the real `scrollWidth` afterwards, so an
 * estimate a few percent out costs at most one re-flow at a smaller size.
 */
export function charEm(ch: string): number {
  if (isCJK(ch)) return 1;
  if (ch === " ") return 0.25;
  if (/[.,;:'`!|ilj]/.test(ch)) return 0.28;
  if (/[fItr()\[\]-]/.test(ch)) return 0.35;
  if (/\d/.test(ch)) return 0.5;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[mw]/.test(ch)) return 0.78;
  return 0.5;
}

export function textEm(text: string): number {
  let total = 0;
  for (const ch of text) total += charEm(ch);
  return total;
}

/**
 * Pour a translation into the original paragraph's line boxes.
 *
 * This is what keeps the page looking like the page: every line of the
 * translation sits on the line it replaces, so the column edges, the leading,
 * the indent of the first line and the ragged last line all survive. Letting
 * the browser wrap the text inside one box instead — what this used to do —
 * produced a different number of lines at a different spacing, which is exactly
 * what made the result look nothing like the paper.
 *
 * `widths` are the line widths in em at the intended font size. Returns one
 * string per line plus whatever did not fit.
 */
export function flowIntoLines(
  text: string,
  widths: number[],
): { lines: string[]; rest: string } {
  const chars = [...text.trim()];
  const lines: string[] = [];
  let i = 0;

  for (const width of widths) {
    if (i >= chars.length) {
      lines.push("");
      continue;
    }
    let used = 0;
    let lastBreak = -1;
    let j = i;
    while (j < chars.length) {
      const ch = chars[j];
      const w = charEm(ch);
      // Narrow ASCII punctuation may hang a hair past the edge rather than
      // start the next line; a full-width mark is too wide to get away with it.
      const hanging = CLOSERS.test(ch) && w < 0.4 && used + w <= width + 0.35;
      if (used + w > width && !hanging) break;
      used += w;
      j++;
      const next = chars[j];
      if (next === undefined) break;
      if (ch === " " || ch === "-") lastBreak = j;
      else if (isCJK(ch) && !CLOSERS.test(next)) lastBreak = j;
    }
    // Never split a latin word across lines.
    if (j < chars.length && !isCJK(chars[j]) && chars[j] !== " " && lastBreak > i) {
      j = lastBreak;
    }
    // 避头尾: a line may not *start* with a closing mark, so the character
    // before it comes down too. Without this every second line in a Chinese
    // translation opens with a stray comma or full stop.
    while (j < chars.length && j > i + 1 && CLOSERS.test(chars[j])) j--;
    lines.push(chars.slice(i, j).join("").replace(/\s+$/, ""));
    i = j;
    while (chars[i] === " ") i++;
  }

  return { lines, rest: chars.slice(i).join("") };
}

/* ------------------------------------------------- continuation & splitting */

/** Reading order: column by column, top to bottom within each column. */
export function readingOrder(paragraphs: Paragraph[], pageWidth: number): Paragraph[] {
  const half = pageWidth / 2;
  return [...paragraphs].sort((a, b) => {
    const ca = (a.box[0] + a.box[2]) / 2 >= half ? 1 : 0;
    const cb = (b.box[0] + b.box[2]) / 2 >= half ? 1 : 0;
    // A block spanning both columns (a title, a wide figure) stays where its
    // top edge puts it.
    const wideA = a.box[2] - a.box[0] > pageWidth * 0.62 ? 1 : 0;
    const wideB = b.box[2] - b.box[0] > pageWidth * 0.62 ? 1 : 0;
    if (!wideA && !wideB && ca !== cb) return ca - cb;
    return b.box[3] - a.box[3];
  });
}

const ENDS_SENTENCE = /[.!?:;"'’”)\]}。！？；：」』]\s*$/;

/**
 * Does this paragraph run on into the next one?
 *
 * A paragraph broken by a column or a page break arrives as two fragments, and
 * the second one starts mid-sentence — sometimes mid-word: "tomization have
 * brought great challenges" was a real request this used to send, from a
 * paragraph whose first half ended "…mass cus-". Translated alone, neither half
 * survives. Joined, they are one sentence again.
 */
export function continuesInto(first: string, second: string): boolean {
  const a = first.trim();
  const b = second.trim();
  if (!a || !b) return false;
  if (ENDS_SENTENCE.test(a)) return false;
  if (a.length < 40) return false; // a heading or a label, not a cut paragraph
  return /^[a-z(\[]/.test(b) || /[-‐]$/.test(a);
}

/** Join a broken paragraph back together, healing the hyphen if there is one. */
export function joinContinuation(first: string, second: string): string {
  const a = first.trim();
  const b = second.trim();
  if (/[-‐]$/.test(a) && /^[a-z]/.test(b)) return `${a.slice(0, -1)}${b}`;
  return `${a} ${b}`;
}

/**
 * Cut a translation back into the pieces its original was broken into.
 *
 * The weights are the lengths of the original fragments, and the cut lands on
 * the nearest sentence or clause boundary so that neither half starts with a
 * dangling particle.
 */
export function splitAcross(text: string, weights: number[]): string[] {
  if (weights.length <= 1) return [text];
  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  const out: string[] = [];
  let rest = text;
  let consumed = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    consumed += weights[i];
    const target = Math.round((consumed / total) * text.length) - (text.length - rest.length);
    const cut = nearestBreak(rest, Math.max(1, Math.min(rest.length - 1, target)));
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  out.push(rest.trim());
  return out;
}

function nearestBreak(text: string, target: number): number {
  const window = Math.max(8, Math.round(text.length * 0.18));
  const marks = /[。！？；.!?;，,、]/;
  for (let offset = 0; offset <= window; offset++) {
    for (const index of [target + offset, target - offset]) {
      if (index <= 0 || index >= text.length) continue;
      if (marks.test(text[index - 1])) return index;
    }
  }
  return target;
}

/**
 * The paper and ink colours under a translated block, worked out from pixels
 * sampled off the rendered page.
 *
 * The reader theme tells us the page colour only for pages PDF.js paints
 * itself. A scan is an image of yellowed paper, and an abstract or a callout
 * can sit in its own tinted box, so a block coloured from the theme alone was
 * a white patch on cream or on grey. Pure: the caller does the canvas work.
 */

export type RGB = [number, number, number];

export interface Ink {
  background: string;
  foreground: string;
}

/** Largest per-channel difference still counted as the same colour. */
const NEAR = 28;
/** Share of the samples the paper colour must cover, or the area is a figure. */
const MIN_PAPER = 0.45;
/** WCAG AA contrast for body text. */
const READABLE = 4.5;
/** Ink is whatever stands out from the paper at least this much. */
const INK_CONTRAST = 2;

const DARK: RGB = [16, 17, 20];
const LIGHT: RGB = [232, 233, 235];

/**
 * `samples` holds r, g, b triples. The paper is the commonest colour; the ink
 * is the commonest colour that clearly is not paper, kept only when it reads
 * on the paper. Otherwise the text takes `preferred` (the theme's ink) if that
 * reads, and failing that whichever of near-black or near-white reads better.
 * Returns null when no colour dominates — a figure, a photo, a gradient — so
 * the caller can leave the block on the theme colours.
 */
export function inkFrom(samples: ArrayLike<number>, preferred?: RGB | null): Ink | null {
  const count = Math.floor(samples.length / 3);
  if (count < 12) return null;

  const paper = dominant(samples, () => true);
  if (!paper || paper.count / count < MIN_PAPER) return null;
  const background = paper.color;

  const text = dominant(
    samples,
    (r, g, b) => contrast([r, g, b], background) >= INK_CONTRAST,
  );
  let foreground: RGB;
  if (
    text &&
    text.count >= Math.max(3, count * 0.01) &&
    contrast(text.color, background) >= READABLE
  ) {
    foreground = text.color;
  } else if (preferred && contrast(preferred, background) >= READABLE) {
    foreground = preferred;
  } else {
    foreground =
      contrast(DARK, background) >= contrast(LIGHT, background) ? DARK : LIGHT;
  }
  return { background: toHex(background), foreground: toHex(foreground) };
}

/**
 * The commonest colour among the samples `keep` accepts.
 *
 * A coarse histogram (16 levels a channel) finds the colour family; the colour
 * itself is the mean of every kept sample within NEAR of that family's mean.
 * Scanner noise and JPEG speckle spread one paper over neighbouring buckets,
 * and the second pass counts them all back towards it.
 */
function dominant(
  samples: ArrayLike<number>,
  keep: (r: number, g: number, b: number) => boolean,
): { color: RGB; count: number } | null {
  const buckets = new Map<number, [number, number, number, number]>();
  for (let i = 0; i + 2 < samples.length; i += 3) {
    const r = samples[i];
    const g = samples[i + 1];
    const b = samples[i + 2];
    if (!keep(r, g, b)) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket[0]++;
      bucket[1] += r;
      bucket[2] += g;
      bucket[3] += b;
    } else {
      buckets.set(key, [1, r, g, b]);
    }
  }
  let top: [number, number, number, number] | null = null;
  for (const bucket of buckets.values()) {
    if (!top || bucket[0] > top[0]) top = bucket;
  }
  if (!top) return null;
  const centre: RGB = [top[1] / top[0], top[2] / top[0], top[3] / top[0]];

  let n = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i + 2 < samples.length; i += 3) {
    const r = samples[i];
    const g = samples[i + 1];
    const b = samples[i + 2];
    if (!keep(r, g, b)) continue;
    if (
      Math.abs(r - centre[0]) > NEAR ||
      Math.abs(g - centre[1]) > NEAR ||
      Math.abs(b - centre[2]) > NEAR
    ) {
      continue;
    }
    n++;
    sr += r;
    sg += g;
    sb += b;
  }
  if (!n) return null;
  return {
    color: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
    count: n,
  };
}

/** WCAG relative luminance. */
function luminance([r, g, b]: RGB): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: RGB, b: RGB): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `#rgb` or `#rrggbb` to a triple; null for anything else. */
export function parseHex(value: string | null | undefined): RGB | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || "").trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as RGB;
}

function toHex(rgb: RGB): string {
  return `#${rgb
    .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
    .join("")}`;
}

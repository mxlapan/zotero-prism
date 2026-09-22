/** Text handling shared by retrieval, translation and summarisation. */

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

export function hasCJK(text: string): boolean {
  return CJK.test(text);
}

/** Cheap token estimate — good enough for budgeting, no WASM tokenizer needed. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (CJK.test(ch)) cjk++;
  const latin = text.length - cjk;
  return Math.ceil(cjk / 1.5 + latin / 3.8);
}

export function clampTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  // binary search the cut point so we do not over-trim CJK text
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}\n…[truncated]`;
}

/** Split into sentences, handling both western and CJK punctuation. */
export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？；;])\s+|(?<=[。！？；])/u)
    .map((s) => s.trim())
    .filter(Boolean);
  // Glue back fragments the naive split produced: a trailing abbreviation
  // ("Fig.", "et al."), or a stub too short to be a sentence that does not
  // already end in terminal punctuation.
  const ABBREV = /\b(?:et al|Fig|Figs|Eq|Eqs|Ref|Refs|vs|cf|approx|Dr|Prof|No|Sec|Tab|i\.e|e\.g)\.$/i;
  const TERMINAL = /[.!?。！？；;]$/;
  const out: string[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    const stub = prev && prev.length < 12 && !TERMINAL.test(prev);
    if (prev && (stub || ABBREV.test(prev))) {
      out[out.length - 1] = `${prev} ${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0);
}

export interface Chunk {
  text: string;
  /** 0-based page the chunk starts on, -1 when unknown */
  page: number;
  index: number;
}

/**
 * Cut a document into overlapping chunks, preferring paragraph and then
 * sentence boundaries so that a chunk is always readable on its own.
 */
const MIN_CHUNK = 24;

export function chunkText(
  pages: string[],
  size = 1200,
  overlap = 160,
): Chunk[] {
  const chunks: Chunk[] = [];
  let buffer = "";
  let bufferPage = 0;

  const push = (page: number) => {
    const text = buffer.trim();
    if (text.length >= MIN_CHUNK) {
      chunks.push({ text, page: bufferPage, index: chunks.length });
    }
    buffer = overlap > 0 ? buffer.slice(-overlap) : "";
    bufferPage = page;
  };

  pages.forEach((pageText, pageIndex) => {
    for (const para of splitParagraphs(pageText)) {
      if (para.length > size) {
        for (const sentence of splitSentences(para)) {
          if (buffer.length + sentence.length > size) push(pageIndex);
          buffer += `${sentence} `;
        }
        continue;
      }
      if (buffer.length + para.length > size) push(pageIndex);
      buffer += `${para}\n\n`;
    }
  });
  if (buffer.trim().length >= MIN_CHUNK) {
    chunks.push({ text: buffer.trim(), page: bufferPage, index: chunks.length });
  }
  return chunks;
}

/** Strip the reference list and everything after it. */
export function dropReferences(text: string): string {
  const match = text.match(
    /\n\s*(references|bibliography|参考文献|引用文献|acknowledge?ments?)\s*\n/i,
  );
  if (match && match.index && match.index > text.length * 0.4) {
    return text.slice(0, match.index);
  }
  return text;
}

/**
 * Pages joined with "--- p. N ---" headers, so a model asked to cite (p. N) can
 * see where each page starts. `first` is the number of the first page given.
 */
export function withPageMarkers(pages: string[], first = 1): string {
  return pages
    .map((text, index) => `--- p. ${first + index} ---\n${text.trim()}`)
    .join("\n\n");
}

export function escapeHTML(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripHTML(html: string): string {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hash(text: string): string {
  // FNV-1a, 52 bits worth — plenty for cache keys.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  return (
    (h1 >>> 0).toString(36).padStart(7, "0") +
    (h2 >>> 0).toString(36).padStart(7, "0")
  );
}

export function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Tokens for the lexical half of hybrid retrieval. */
export function lexTokens(text: string): string[] {
  const latin = text.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  const cjk: string[] = [];
  const chars = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of chars) {
    for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2));
  }
  return [...latin, ...cjk];
}

/**
 * Split a prompt body into literal text and `${...}` expressions.
 *
 * A regular expression cannot do this: the first `}` of an object literal or a
 * nested template would end the expression early, so `${JSON.stringify({a:1})}`
 * used to be cut in half. This tracks brace depth and skips over string and
 * template literals.
 */
export function splitTemplate(body: string): {
  parts: string[];
  expressions: string[];
} {
  const parts: string[] = [];
  const expressions: string[] = [];
  let literal = "";
  let i = 0;

  while (i < body.length) {
    if (body[i] === "$" && body[i + 1] === "{" && body[i - 1] !== "\\") {
      const end = findClose(body, i + 2);
      if (end > 0) {
        parts.push(literal);
        literal = "";
        expressions.push(body.slice(i + 2, end));
        i = end + 1;
        continue;
      }
    }
    literal += body[i++];
  }
  parts.push(literal);
  return { parts, expressions };
}

/** Index of the `}` closing the expression that starts at `from`, or -1. */
function findClose(source: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipString(source: string, from: number): number {
  const quote = source[from];
  let i = from + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return source.length;
}

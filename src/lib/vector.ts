/**
 * A local, file-backed hybrid index.
 *
 * Embeddings are optional: without an embedding endpoint the index still works
 * as a lexical (BM25-style) search over every chunk, which keeps "ask my
 * library" useful for people who only configure a chat model.
 *
 * Vectors are stored int8-quantised and base64-encoded, roughly a tenth of the
 * size of the equivalent JSON float array.
 */

import { JSONStore } from "../utils/store";
import { lexTokens } from "../utils/text";

export interface IndexedChunk {
  id: string;
  itemID: number;
  itemKey: string;
  attachmentID: number;
  title: string;
  page: number;
  text: string;
  /** base64 int8 vector */
  v?: string;
  /** dequantisation scale */
  s?: number;
}

export interface SearchHit extends IndexedChunk {
  score: number;
  lexical: number;
  semantic: number;
}

interface IndexFile {
  version: number;
  dims: number;
  model: string;
  chunks: IndexedChunk[];
}

function b64encode(bytes: Int8Array): string {
  let binary = "";
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function b64decode(text: string): Int8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return new Int8Array(out.buffer);
}

export function quantize(vector: number[]): { v: string; s: number } {
  let max = 1e-8;
  for (const value of vector) max = Math.max(max, Math.abs(value));
  const scale = max / 127;
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    bytes[i] = Math.max(-127, Math.min(127, Math.round(vector[i] / scale)));
  }
  return { v: b64encode(bytes), s: scale };
}

export function dequantize(v: string, s: number): Float32Array {
  const bytes = b64decode(v);
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] * s;
  return out;
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class LibraryIndex {
  private store = new JSONStore<IndexFile>("index", {
    version: 1,
    dims: 0,
    model: "",
    chunks: [],
  });
  private df = new Map<string, number>();
  private tokenCache = new Map<string, string[]>();
  private avgLen = 1;
  private ready = false;

  async load() {
    if (this.ready) return;
    await this.store.load();
    this.reindexLexical();
    this.ready = true;
  }

  get chunks(): IndexedChunk[] {
    return this.store.get().chunks;
  }

  stats() {
    const data = this.store.get();
    const items = new Set(data.chunks.map((c) => c.itemID));
    return {
      chunks: data.chunks.length,
      items: items.size,
      vectors: data.chunks.filter((c) => c.v).length,
      model: data.model,
      dims: data.dims,
    };
  }

  private reindexLexical() {
    this.df.clear();
    this.tokenCache.clear();
    let total = 0;
    for (const chunk of this.chunks) {
      const tokens = lexTokens(chunk.text);
      this.tokenCache.set(chunk.id, tokens);
      total += tokens.length;
      for (const token of new Set(tokens)) {
        this.df.set(token, (this.df.get(token) || 0) + 1);
      }
    }
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
  }

  hasItem(itemID: number): boolean {
    return this.chunks.some((c) => c.itemID === itemID);
  }

  removeItem(itemID: number) {
    const data = this.store.get();
    data.chunks = data.chunks.filter((c) => c.itemID !== itemID);
    this.store.set(data);
  }

  upsert(chunks: IndexedChunk[], model = "", dims = 0) {
    if (!chunks.length) return;
    const data = this.store.get();
    const itemIDs = new Set(chunks.map((c) => c.itemID));
    data.chunks = data.chunks.filter((c) => !itemIDs.has(c.itemID));
    data.chunks.push(...chunks);
    if (model) data.model = model;
    if (dims) data.dims = dims;
    this.store.set(data);
    this.reindexLexical();
  }

  async flush() {
    await this.store.flush();
  }

  async clear() {
    this.store.set({ version: 1, dims: 0, model: "", chunks: [] });
    this.reindexLexical();
    await this.store.flush();
  }

  /** BM25 over the chunk corpus. */
  private lexicalScores(query: string, pool: IndexedChunk[]): Map<string, number> {
    const k1 = 1.4;
    const b = 0.72;
    const N = Math.max(1, this.chunks.length);
    const queryTokens = new Set(lexTokens(query));
    const scores = new Map<string, number>();
    for (const chunk of pool) {
      const tokens = this.tokenCache.get(chunk.id) || lexTokens(chunk.text);
      if (!tokens.length) continue;
      const freq = new Map<string, number>();
      for (const token of tokens) freq.set(token, (freq.get(token) || 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const tf = freq.get(token);
        if (!tf) continue;
        const df = this.df.get(token) || 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score +=
          (idf * (tf * (k1 + 1))) /
          (tf + k1 * (1 - b + (b * tokens.length) / this.avgLen));
      }
      if (score > 0) scores.set(chunk.id, score);
    }
    return scores;
  }

  search(
    query: string,
    queryVector: number[] | null,
    options: { topK?: number; itemIDs?: number[]; minScore?: number } = {},
  ): SearchHit[] {
    const topK = options.topK ?? 8;
    const pool = options.itemIDs?.length
      ? this.chunks.filter((c) => options.itemIDs!.includes(c.itemID))
      : this.chunks;
    if (!pool.length) return [];

    const lexical = this.lexicalScores(query, pool);
    let maxLex = 0;
    for (const value of lexical.values()) maxLex = Math.max(maxLex, value);

    const hits: SearchHit[] = [];
    for (const chunk of pool) {
      const lex = maxLex ? (lexical.get(chunk.id) || 0) / maxLex : 0;
      let sem = 0;
      if (queryVector && chunk.v && chunk.s) {
        sem = cosine(queryVector, dequantize(chunk.v, chunk.s));
        sem = (sem + 1) / 2;
      }
      const score = queryVector ? 0.62 * sem + 0.38 * lex : lex;
      if (score <= (options.minScore ?? 0.001)) continue;
      hits.push({ ...chunk, score, lexical: lex, semantic: sem });
    }
    hits.sort((a, b) => b.score - a.score);

    // Keep the result set diverse: at most three chunks from one document
    // unless that leaves us short.
    const perItem = new Map<number, number>();
    const picked: SearchHit[] = [];
    for (const hit of hits) {
      const used = perItem.get(hit.itemID) || 0;
      if (used >= 3 && picked.length < topK) continue;
      perItem.set(hit.itemID, used + 1);
      picked.push(hit);
      if (picked.length >= topK) break;
    }
    return picked.length ? picked : hits.slice(0, topK);
  }
}

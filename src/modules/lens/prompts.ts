/**
 * Prompt library and command tags.
 *
 * A prompt is a named piece of text plus a declaration of which context it
 * wants. `${ ... }` inside the body is evaluated as JavaScript with a `P`
 * helper in scope, so a tag can reach anywhere in Zotero — the same escape
 * hatch Zotero GPT's command tags provide, with a documented API surface.
 */

import { getJSONPref, setJSONPref, getPref } from "../../utils/prefs";
import { bi, isZH } from "../../utils/locale";
import { contextItems, currentReader, getFullText, getPageTexts, getSelectedItems, itemAnnotations, metaBlock, readerAttachment, toRegularItem, zoteroPane } from "../../utils/item";
import { clampTokens, splitTemplate, stripHTML, withPageMarkers } from "../../utils/text";
import { searchLibrary } from "./rag";
import {
  contentObject,
  currentPageIndex,
  pdfApp,
  pdfWindow,
  unwrap,
} from "../../utils/reader";

export type PromptContext =
  | "none"
  | "abstract"
  | "selection"
  | "page"
  | "pages"
  | "pageImage"
  | "fulltext"
  | "note"
  | "items"
  | "annotations"
  | "library";

export type PromptScope =
  | "panel"
  | "welcome"
  | "selection"
  | "sidebar"
  | "note"
  | "menu";

export interface PromptDef {
  id: string;
  name: string;
  scope: PromptScope[];
  context: PromptContext;
  body: string;
  trigger?: string;
  color?: string;
  order?: number;
  builtin?: boolean;
  /** ask the user for a page range before running (context "pages") */
  askRange?: boolean;
}

export interface PromptEnv {
  question?: string;
  item?: Zotero.Item | null;
  items?: Zotero.Item[];
  selection?: string;
  pageIndex?: number;
  pageRange?: [number, number];
  noteHTML?: string;
  images?: string[];
}

export const BUILTIN_PROMPTS: PromptDef[] = [
  {
    id: "ask-pdf",
    name: bi("Ask PDF", "问本文"),
    scope: ["panel", "sidebar"],
    context: "fulltext",
    trigger: "askpdf",
    color: "#2ea8e5",
    order: 10,
    builtin: true,
    body: `Answer the question using the paper below. Quote the page number in the form (p. N) whenever the paper supports a statement, and say explicitly if the paper does not answer it.

Question: \${P.question}

--- PAPER ---
\${await P.fullText()}`,
  },
  {
    id: "ask-library",
    name: bi("Ask library", "问文库"),
    scope: ["panel"],
    context: "library",
    trigger: "asklib",
    color: "#a28ae5",
    order: 20,
    builtin: true,
    body: `You are answering from a personal reference library. Use only the excerpts provided. Cite each claim as [n] matching the excerpt numbers, and list the papers you used at the end.

Question: \${P.question}

--- EXCERPTS ---
\${await P.search(P.question)}`,
  },
  {
    id: "summarize",
    name: bi("Summarize", "总结"),
    scope: ["panel", "welcome", "menu"],
    context: "fulltext",
    trigger: "sum",
    color: "#5fb236",
    order: 30,
    builtin: true,
    body: `Summarise this paper for a researcher who has not read it. Use exactly these headings and keep the whole summary under 300 words.

**Problem** — what gap it addresses
**Method** — what they actually did
**Data** — what they ran it on
**Findings** — the concrete results, with numbers
**Limitations** — what the authors admit or what is missing
**Why it matters** — one sentence

--- PAPER ---
\${await P.fullText()}`,
  },
  {
    id: "outline",
    name: bi("Outline", "大纲"),
    scope: ["sidebar", "menu"],
    context: "fulltext",
    color: "#e56eee",
    order: 40,
    builtin: true,
    body: `Produce a section-by-section outline of the paper. For each section give the heading, a one-line purpose, and two or three bullets of substance. Prefix every bullet with the page it comes from as (p. N). Answer in markdown.

--- PAPER ---
\${await P.fullText()}`,
  },
  {
    id: "explain",
    name: bi("Explain", "解释"),
    scope: ["selection", "panel"],
    context: "selection",
    trigger: "exp",
    color: "#ff6666",
    order: 50,
    builtin: true,
    body: `Explain the passage below in plain language. Define any term of art, unpack the notation, and say what it implies for the paper's argument. Be brief.

--- PASSAGE ---
\${P.selection}`,
  },
  {
    id: "translate",
    name: bi("Translate", "翻译"),
    scope: ["selection", "panel"],
    context: "selection",
    trigger: "tr",
    color: "#f19837",
    order: 60,
    builtin: true,
    body: `Translate the passage into \${P.targetLanguage}. Keep technical terms accurate, preserve the original paragraph breaks, and return only the translation.

\${P.selection}`,
  },
  {
    id: "page-summary",
    name: bi("This page", "总结本页"),
    scope: ["sidebar"],
    context: "page",
    color: "#aaaaaa",
    order: 70,
    builtin: true,
    body: `Summarise the current page in three or four bullets, then note anything that looks like a claim needing evidence.

--- PAGE \${P.pageNumber} ---
\${await P.pageText()}`,
  },
  {
    id: "page-figure",
    name: bi("Read figures", "解读图表"),
    scope: ["sidebar"],
    context: "pageImage",
    color: "#009980",
    order: 80,
    builtin: true,
    body: `Describe every figure, chart and table on this page: what is plotted, the axes and units, the trend, and what the authors conclude from it.`,
  },
  {
    id: "critique",
    name: bi("Critique", "审稿"),
    scope: ["panel", "welcome"],
    context: "fulltext",
    trigger: "review",
    color: "#e5b95f",
    order: 90,
    builtin: true,
    body: `Review this paper the way a careful referee would. Give: three genuine strengths; the three weakest points with the specific page each is on; any threat to validity the authors have not addressed; and two experiments that would settle the doubts. Be concrete and avoid generic reviewer language.

--- PAPER ---
\${await P.fullText()}`,
  },
  {
    id: "related",
    name: bi("Relate to library", "与文库对比"),
    scope: ["panel", "menu"],
    context: "library",
    color: "#7f5fe5",
    order: 100,
    builtin: true,
    body: `Here is the paper I am reading:

\${P.meta()}

And here are excerpts from other papers in my library:

\${await P.search(P.title())}

Explain how the paper I am reading agrees with, contradicts or extends each of them. If two of my papers disagree with each other, say so explicitly.`,
  },
  {
    id: "tag-suggest",
    name: bi("Suggest tags", "推荐标签"),
    scope: ["menu", "panel"],
    context: "abstract",
    color: "#5fb2a8",
    order: 110,
    builtin: true,
    body: `Propose 4-8 tags for this item, drawn from the controlled vocabulary already used in my library where possible.

Existing tags in my library: \${await P.libraryTags(120)}

Item:
\${P.meta()}

Return only a comma separated list of tags, nothing else.`,
  },
  {
    id: "annotations-digest",
    name: bi("Digest highlights", "整理标注"),
    scope: ["panel", "sidebar", "menu"],
    context: "annotations",
    color: "#d64d4d",
    order: 120,
    builtin: true,
    body: `Below are my highlights and notes on this paper. Group them into themes, resolve duplicates, and write a tight synthesis in markdown. Keep the (p. N) markers so I can find each point again.

\${await P.annotations()}`,
  },
];

export function loadPrompts(): PromptDef[] {
  const user = getJSONPref<PromptDef[]>("lens.prompts", []);
  const byID = new Map<string, PromptDef>();
  for (const prompt of BUILTIN_PROMPTS) byID.set(prompt.id, { ...prompt });
  for (const prompt of user) byID.set(prompt.id, { ...prompt, builtin: false });
  return [...byID.values()].sort(
    (a, b) => (a.order ?? 500) - (b.order ?? 500) || a.name.localeCompare(b.name),
  );
}

export function promptsFor(scope: PromptScope): PromptDef[] {
  return loadPrompts().filter((p) => p.scope.includes(scope));
}

export function savePrompt(prompt: PromptDef) {
  const user = getJSONPref<PromptDef[]>("lens.prompts", []).filter(
    (p) => p.id !== prompt.id,
  );
  user.push(prompt);
  setJSONPref("lens.prompts", user);
}

export function deletePrompt(id: string) {
  setJSONPref(
    "lens.prompts",
    getJSONPref<PromptDef[]>("lens.prompts", []).filter((p) => p.id !== id),
  );
}

export function resetPrompts() {
  setJSONPref("lens.prompts", []);
}

/** Match a typed command against prompt triggers. */
export function matchTrigger(input: string): PromptDef | undefined {
  const text = input.trim();
  if (!text.startsWith("/") && !text.startsWith("#")) return undefined;
  const word = text.slice(1).split(/\s+/)[0].toLowerCase();
  if (!word) return undefined;
  return loadPrompts().find((prompt) => {
    if (!prompt.trigger) return false;
    if (prompt.trigger.startsWith("/") && prompt.trigger.endsWith("/")) {
      try {
        return new RegExp(prompt.trigger.slice(1, -1), "i").test(word);
      } catch {
        return false;
      }
    }
    return prompt.trigger.toLowerCase() === word;
  });
}

/* ------------------------------------------------------------------ the `P` API */

export function buildAPI(env: PromptEnv) {
  const item = env.item ?? contextItems()[0] ?? null;
  const items = env.items?.length ? env.items : contextItems();

  const api = {
    /** The user's question as typed. */
    question: env.question || "",
    item,
    items,
    selection: env.selection || "",
    pageNumber: (env.pageIndex ?? 0) + 1,
    targetLanguage: getPref<string>("refract.targetLang", "zh-CN"),

    title: () => (item ? String(item.getField("title") || "") : ""),
    meta: () => (item ? metaBlock(item) : ""),
    abstract: () =>
      item ? stripHTML(String(item.getField("abstractNote") || "")) : "",

    async fullText(maxTokens = 60000) {
      const text = await getFullText(item, { pageMarkers: true });
      return clampTokens(text, maxTokens);
    },

    async pageText(pageIndex?: number) {
      const pages = await getPageTexts(item);
      const index = pageIndex ?? env.pageIndex ?? 0;
      return pages[index] || "";
    },

    async pages(from: number, to: number) {
      const pages = await getPageTexts(item);
      const first = Math.max(1, from);
      return withPageMarkers(pages.slice(first - 1, to), first);
    },

    async annotations() {
      if (!item) return "";
      const list = await itemAnnotations(item);
      return list
        .map((a) => {
          const parts = [a.text && `"${a.text}"`, a.comment && `- ${a.comment}`]
            .filter(Boolean)
            .join(" ");
          return `(p. ${a.pageLabel}) ${parts}${a.tags.length ? `  [${a.tags.join(", ")}]` : ""}`;
        })
        .filter((line) => line.length > 12)
        .join("\n");
    },

    async search(query: string, topK?: number) {
      const hits = await searchLibrary(query || env.question || "", {
        topK: topK ?? Number(getPref("lens.topK", 8)),
      });
      return hits
        .map(
          (hit, index) =>
            `[${index + 1}] ${hit.title}${hit.page >= 0 ? ` (p. ${hit.page + 1})` : ""}\n${hit.text}`,
        )
        .join("\n\n");
    },

    itemsMeta(maxChars = 12000) {
      return clampTokens(
        items.map((i) => metaBlock(i)).join("\n\n---\n\n"),
        maxChars / 4,
      );
    },

    async libraryTags(limit = 100) {
      try {
        const tags = (await Zotero.Tags.getAll(
          Zotero.Libraries.userLibraryID,
        )) as any[];
        return tags
          .slice(0, limit)
          .map((t: any) => t.tag || t.name)
          .join(", ");
      } catch {
        return "";
      }
    },

    note: () => stripHTML(env.noteHTML || ""),
    reader: currentReader(),
    attachment: readerAttachment(),
    selectedItems: getSelectedItems(),
    Zotero,
  };
  return api;
}

export type PrismAPI = ReturnType<typeof buildAPI>;

/**
 * Replace every `${ ... }` in `body` with the (awaited) value of the expression.
 * Anything that throws becomes an inline marker rather than aborting the prompt.
 */
export async function interpolate(body: string, env: PromptEnv): Promise<string> {
  const { parts, expressions } = splitTemplate(body);
  if (!expressions.length) return body;
  const P = buildAPI(env);
  const values: string[] = [];
  for (const code of expressions) values.push(await evaluate(code, P));
  let out = parts[0] ?? "";
  for (let i = 0; i < values.length; i++) out += values[i] + (parts[i + 1] ?? "");
  return out;
}

async function evaluate(code: string, P: PrismAPI): Promise<string> {
  try {
    // eslint-disable-next-line no-new-func
    const runner = new Function(
      "P",
      "Zotero",
      "ZoteroPane",
      `return (async () => (${code}))()`,
    );
    const value = await runner(P, Zotero, zoteroPane());
    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch (e: any) {
    Zotero.debug(`[Prism] prompt expression failed: ${code} -> ${e}`);
    return `[prism: ${String(e?.message || e)}]`;
  }
}

/**
 * The built-in prompts are in English, and a one-click command carries no
 * question for the model to take the user's language from: in the Chinese UI
 * "总结本页" came back in English. Ask for the UI's language then. A typed
 * question already says which language is wanted, and a translation names its
 * own target.
 */
/**
 * Answers are rendered with KaTeX, which only sees what sits between dollar
 * signs. Left to itself a model mixes Unicode maths with bare `A^{-1}`, and the
 * bare half shows up as source code in the panel and in notes.
 */
export const FORMULAS =
  "Write mathematical expressions in LaTeX: inline between $…$, displayed on their own line between $$…$$. " +
  "Never leave LaTeX commands, subscripts or superscripts outside those delimiters.";

export function replyLanguage(body: string, env: PromptEnv): string {
  if (!isZH() || env.question?.trim() || body.includes("P.targetLanguage")) return "";
  return "\n\nWrite the answer in Simplified Chinese. Keep technical terms, symbols, formulas and page markers such as (p. 3) as they are.";
}

/** Gather whatever `context` declares, then interpolate the body. */
export async function renderPrompt(
  prompt: PromptDef,
  env: PromptEnv,
): Promise<{ text: string; images: string[] }> {
  const images: string[] = [...(env.images || [])];
  if (prompt.context === "pageImage" && !images.length) {
    const shot = await capturePage(env.pageIndex);
    if (shot) images.push(shot);
  }
  const text = (await interpolate(prompt.body, env)) + replyLanguage(prompt.body, env);
  const question = env.question?.trim();
  const needsQuestion =
    question && !prompt.body.includes("P.question") && prompt.context !== "none";
  return {
    text: needsQuestion ? `${question}\n\n${text}` : text,
    images,
  };
}

/** Render the current reader page to a PNG data URL for vision models. */
export async function capturePage(pageIndex?: number): Promise<string | null> {
  try {
    const reader: any = currentReader();
    const app = pdfApp(reader);
    const win = pdfWindow(reader);
    if (!app || !win) return null;
    const index = pageIndex ?? currentPageIndex(reader);
    // Zotero 10 runs the PDF viewer in an unprivileged iframe. The page proxy
    // comes back wrapped, so its methods are invisible until it is unwrapped,
    // and an options object built on this side reaches pdf.js empty: getViewport
    // silently returned a NaN-sized viewport and render() threw.
    const page = unwrap(await app.pdfDocument.getPage(index + 1));
    if (typeof page?.getViewport !== "function") return null;
    const viewport = page.getViewport(contentObject(win, { scale: 1.6 }));
    const canvas = win.document.createElement("canvas");
    canvas.width = Math.min(2000, viewport.width);
    canvas.height = Math.min(2600, viewport.height);
    const context = canvas.getContext("2d");
    await page.render(contentObject(win, { canvasContext: context, viewport }))
      .promise;
    return canvas.toDataURL("image/png");
  } catch (e) {
    Zotero.debug(`[Prism] page capture failed: ${e}`);
    return null;
  }
}

/** The regular item a prompt should attach its provenance note to. */
export function provenanceTarget(env: PromptEnv): Zotero.Item | null {
  return toRegularItem(env.item ?? contextItems()[0] ?? null);
}

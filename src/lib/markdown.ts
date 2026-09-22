/** Markdown → HTML, with LaTeX and code highlighting, plus a Zotero-note flavour. */

import MarkdownIt from "markdown-it";
import katexModule from "@vscode/markdown-it-katex";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import r from "highlight.js/lib/languages/r";
import matlab from "highlight.js/lib/languages/matlab";
import latex from "highlight.js/lib/languages/latex";
import yaml from "highlight.js/lib/languages/yaml";
import { escapeHTML } from "../utils/text";

for (const [name, lang] of Object.entries({
  javascript,
  typescript,
  python,
  bash,
  json,
  xml,
  css,
  sql,
  r,
  matlab,
  latex,
  yaml,
})) {
  try {
    hljs.registerLanguage(name, lang as any);
  } catch {
    /* duplicate registration is harmless */
  }
}
hljs.registerAliases?.(["js"], { languageName: "javascript" });
hljs.registerAliases?.(["ts"], { languageName: "typescript" });
hljs.registerAliases?.(["py"], { languageName: "python" });
hljs.registerAliases?.(["sh", "shell"], { languageName: "bash" });
hljs.registerAliases?.(["html"], { languageName: "xml" });
hljs.registerAliases?.(["tex"], { languageName: "latex" });

// The package is CommonJS with `exports.default`. package.json says
// "type": "module", so esbuild imports it the Node way — the default import is
// the whole exports object, and handing that to md.use() threw, which quietly
// turned LaTeX off. Take `.default` when it is there.
const katexPlugin = ((katexModule as any).default ?? katexModule) as typeof katexModule;

type MarkdownItInstance = InstanceType<typeof MarkdownIt>;

let md: MarkdownItInstance | undefined;

function instance(): MarkdownItInstance {
  if (md) return md;
  md = new MarkdownIt({
    html: false,
    // The panel sits in Zotero's XHTML window, where innerHTML is parsed as
    // XML: a bare <br> throws. Self-close void tags.
    xhtmlOut: true,
    linkify: true,
    breaks: true,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre class="prism-code"><code class="hljs language-${escapeHTML(
            lang,
          )}">${hljs.highlight(code, { language: lang }).value}</code></pre>`;
        } catch {
          /* fall through to plain */
        }
      }
      return `<pre class="prism-code"><code class="hljs">${escapeHTML(code)}</code></pre>`;
    },
  });
  try {
    md.use(katexPlugin as any, {
      throwOnError: false,
      errorColor: "#d64d4d",
      enableBareBlocks: true,
    });
  } catch (e) {
    Zotero.debug(`[Prism] KaTeX plugin unavailable: ${e}`);
  }
  // Open links in the user's browser rather than inside Zotero's panel.
  const defaultLinkOpen =
    md.renderer.rules.link_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("data-prism-link", "1");
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  return md;
}

/**
 * Many models (DeepSeek, GPT, Qwen) write LaTeX as \( … \) and \[ … \]; the
 * KaTeX plugin only reads $ … $ and $$ … $$, and markdown-it turned "\(" into a
 * plain "(" — the formulas came out as raw TeX. Code spans and fences are left
 * alone.
 */
export function normaliseMath(source: string): string {
  return source
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `$$${body}$$`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`),
    )
    .join("");
}

export function renderMarkdown(source: string): string {
  if (!source) return "";
  try {
    return instance().render(normaliseMath(source));
  } catch (e) {
    Zotero.debug(`[Prism] markdown render failed: ${e}`);
    return `<p>${escapeHTML(source).replace(/\n/g, "<br/>")}</p>`;
  }
}

export function renderMarkdownInline(source: string): string {
  try {
    return instance().renderInline(source || "");
  } catch {
    return escapeHTML(source || "");
  }
}

/**
 * Markdown → the HTML subset Zotero's note editor accepts.
 *
 * KaTeX markup is replaced by Zotero's own `<span class="math">` convention so
 * formulas stay editable inside the note.
 */
export function markdownToNoteHTML(source: string): string {
  const mathBlocks: string[] = [];
  let text = normaliseMath(source)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, body) => {
      mathBlocks.push(`<span class="math">$$${String(body).trim()}$$</span>`);
      return `@@PRISMMATH${mathBlocks.length - 1}@@`;
    })
    .replace(/(?<!\\)\$([^$\n]+?)\$/g, (_m, body) => {
      mathBlocks.push(`<span class="math">$${String(body).trim()}$</span>`);
      return `@@PRISMMATH${mathBlocks.length - 1}@@`;
    });

  const plain = new MarkdownIt({ html: false, linkify: true, breaks: false });
  let html = plain.render(text);

  html = html
    .replace(/<pre><code[^>]*>/g, "<pre>")
    .replace(/<\/code><\/pre>/g, "</pre>")
    .replace(/ class="[^"]*"/g, "")
    .replace(/<hr\s*\/?>/g, "")
    .replace(/@@PRISMMATH(\d+)@@/g, (_m, i) => mathBlocks[Number(i)] || "");
  return html;
}

/** Note HTML → markdown, good enough to feed a note back to a model. */
export function noteHTMLToMarkdown(html: string): string {
  return String(html || "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, body) =>
      `\n${"#".repeat(Number(level))} ${body.replace(/<[^>]+>/g, "").trim()}\n`,
    )
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) =>
      `- ${body.replace(/<[^>]+>/g, "").trim()}\n`,
    )
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, body) =>
      `> ${body.replace(/<[^>]+>/g, "").trim()}\n`,
    )
    .replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
    .replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

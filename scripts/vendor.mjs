/**
 * Copies third-party runtime assets (KaTeX stylesheet + fonts, highlight.js theme)
 * out of node_modules into addon/content/vendor so they can be served from
 * chrome://prism/content/vendor/... inside Zotero.
 */
import { cp, mkdir, rm, access, readdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "addon/content/vendor");

// The stylesheet has to come from the KaTeX that renders the HTML, which is the
// copy @vscode/markdown-it-katex depends on, not whatever version sits at the
// top of node_modules. KaTeX 0.18 renamed `vbox`/`thinbox`/`inner`/`fix` to
// `katex-*`; pairing its CSS with the plugin's 0.16 output split every \neq
// into a slash and an equals sign on separate lines.
const require = createRequire(import.meta.url);
const katexDir = relative(
  root,
  dirname(
    require.resolve("katex/package.json", {
      paths: [dirname(require.resolve("@vscode/markdown-it-katex"))],
    }),
  ),
);

const jobs = [
  [`${katexDir}/dist/katex.min.css`, "katex/katex.min.css"],
  [`${katexDir}/dist/fonts`, "katex/fonts"],
  ["node_modules/highlight.js/styles/github.min.css", "hljs/light.css"],
  ["node_modules/highlight.js/styles/github-dark.min.css", "hljs/dark.css"],
];

await rm(out, { recursive: true, force: true });
for (const [from, to] of jobs) {
  const src = resolve(root, from);
  try {
    await access(src);
  } catch {
    console.warn(`[vendor] skipped missing ${from}`);
    continue;
  }
  const dest = resolve(out, to);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}
// Ship only woff2: every browser Zotero is built on supports it, and the ttf
// and woff copies triple the size of the packaged plugin.
try {
  const fontDir = resolve(out, "katex/fonts");
  for (const name of await readdir(fontDir)) {
    if (!name.endsWith(".woff2")) await unlink(resolve(fontDir, name));
  }
} catch {
  /* fonts not present */
}

console.log("[vendor] assets copied to addon/content/vendor");

/**
 * Runs the pure-logic tests outside Zotero.
 *
 * Only modules whose behaviour does not depend on a live Zotero are covered
 * here — text chunking, the vector index, PDF layout reconstruction, the tag
 * and rank rewrite rules, and the annotation query syntax. Everything else
 * needs the application and is exercised by hand.
 */
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "prism-test-"));
const files = ["pure.test.ts", "map.test.ts"];
let failed = 0;

// Minimal stand-ins for the globals the plugin expects.
globalThis.Zotero = {
  debug: () => {},
  locale: "en-US",
  Prefs: { get: () => undefined, set: () => {} },
};
globalThis.addon = { data: { spectrum: { colorNames: {} } } };
globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");

const require = createRequire(import.meta.url);
const exit = process.exit;
process.exit = (code) => {
  if (code) failed++;
};

// Locale, asset and preference checks run first: they need no bundling.
for (const check of ["./locale.mjs", "./prefs.mjs", "./hostapi.mjs"]) {
  console.log(`\n── ${check.slice(2)}`);
  await import(check).catch(() => {});
}

for (const file of files) {
  const out = join(dir, `${file}.cjs`);
  await build({
    entryPoints: [resolve(here, file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "error",
  });
  console.log(`\n── ${file}`);
  require(out);
}

await rm(dir, { recursive: true, force: true });
process.exit = exit;
console.log(failed ? `\n${failed} test file(s) failed` : "\nall test files passed");
process.exit(failed ? 1 : 0);

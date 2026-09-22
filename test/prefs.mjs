/**
 * Cross-checks the preference defaults, the settings UI and the code.
 *
 * Two bugs motivated this: the Settings → Translation master switch
 * (`enableRefract`) was read by nothing, so turning it off did nothing at all,
 * and a "Unit: Paragraph / Sentence" menu wrote a pref the translator never
 * looked at. Both are invisible to the type checker — a pref is just a string.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const ok = (name, cond, extra = "") => {
  if (!cond) fails.push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`);
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

const source = walk(join(root, "src")).map((f) => readFileSync(f, "utf8")).join("\n");
const xhtml = readdirSync(join(root, "addon/content"))
  .filter((n) => n.endsWith(".xhtml"))
  .map((n) => readFileSync(join(root, "addon/content", n), "utf8"))
  .join("\n");

const declared = [...readFileSync(join(root, "addon/prefs.js"), "utf8")
  .matchAll(/^pref\("([^"]+)"/gm)].map((m) => m[1]);
const bound = [...xhtml.matchAll(/preference="([^"]+)"/g)].map((m) => m[1]);

ok("prefs.js declares no duplicates",
   new Set(declared).size === declared.length);

/* A pref nothing reads and nothing binds is dead weight that still ships. */
const readInCode = (key) => source.includes(`"${key}"`);
const dead = declared.filter((key) => !readInCode(key) && !bound.includes(key));
ok("every declared pref is read or bound", dead.length === 0, dead.join(", "));

/* A control bound to a pref the code never reads is a setting that lies. */
const inert = [...new Set(bound)].filter((key) => !readInCode(key));
ok("every settings control is read by the code", inert.length === 0, inert.join(", "));

/* Each module's master switch must actually gate something. */
for (const key of ["enableSpectrum", "enableLens", "enableRefract", "enableBeam"]) {
  const uses = [...source.matchAll(new RegExp(`"${key}"`, "g"))].length;
  ok(`${key} gates something`, uses > 0, `${uses} use(s)`);
}

/* Anything bound in the UI should have a default, or it reads as empty. */
const undeclared = [...new Set(bound)].filter((key) => !declared.includes(key));
ok("every settings control has a default", undeclared.length === 0, undeclared.join(", "));

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall green");
process.exit(fails.length ? 1 : 0);

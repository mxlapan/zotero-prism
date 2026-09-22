import { parseMap, applyMap } from "../src/modules/spectrum/columns";
import { matchesQuery } from "../src/modules/spectrum/annotations";

const fails: string[] = [];
const ok = (n: string, c: boolean, extra = "") => { if (!c) fails.push(n); console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`); };

// the Map syntax from Ethereal Style's docs
const rules = parseMap("SCIWARN=🚫, /SCIIF/=IF, 北大中文核心=北核, /医学(\\d+)区/=医$1, Total(CNKI)=, ");
ok("parseMap count", rules.length === 5, `-> ${rules.length}`);
ok("literal replace", applyMap("SCIWARN", rules) === "🚫", applyMap("SCIWARN", rules));
ok("regex replace", applyMap("SCIIF 8.2", rules) === "IF 8.2", applyMap("SCIIF 8.2", rules));
ok("capture group", applyMap("医学2区", rules) === "医2", applyMap("医学2区", rules));
ok("chinese literal", applyMap("北大中文核心", rules) === "北核", applyMap("北大中文核心", rules));
ok("empty target strips", applyMap("Total(CNKI) 139", rules) === "139", `"${applyMap("Total(CNKI) 139", rules)}"`);
ok("untouched passes through", applyMap("CCF-A", rules) === "CCF-A");

// decimal trimming rule from the docs
const dec = parseMap("/^(\\d+)\\.(\\d{1})\\d*$/=$1.$2, ");
ok("decimal trim", applyMap("8.24719", dec) === "8.2", applyMap("8.24719", dec));

// annotation manager query syntax
ok("plain substring", matchesQuery("transformer attention", "attention"));
ok("AND both present", matchesQuery("transformer attention", "transformer && attention"));
ok("AND one missing", !matchesQuery("transformer attention", "transformer && lstm"));
ok("OR one present", matchesQuery("transformer attention", "lstm || attention"));
ok("OR none present", !matchesQuery("transformer attention", "lstm || gru"));
ok("empty query matches", matchesQuery("anything", "   "));
ok("case insensitive", matchesQuery("Transformer", "transformer"));

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall green");
process.exit(fails.length ? 1 : 0);

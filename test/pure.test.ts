import { chunkText, splitSentences, estimateTokens, clampTokens, dropReferences, hash, lexTokens } from "../src/utils/text";
import { quantize, dequantize, cosine } from "../src/lib/vector";
import { tagLinks } from "../src/lib/forcegraph";
import {
  toLines,
  toParagraphs,
  runsFromTextContent,
  isFurniture,
  findGutters,
  looksLikeAuthors,
  continuesInto,
  joinContinuation,
  splitAcross,
  readingOrder,
  isFormula,
  flowIntoLines,
  textEm,
} from "../src/modules/refract/layout";

const fails: string[] = [];
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails.push(`${name} ${extra}`);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`);
};

/* ---- text ---- */
const sentences = splitSentences("Fig. 2 shows the result. We ran 3 trials, e.g. A and B. 结果显著。第二句也在。");
ok("splitSentences merges abbreviations", sentences.length >= 3, `-> ${sentences.length}: ${JSON.stringify(sentences)}`);

ok("estimateTokens latin", Math.abs(estimateTokens("hello world this is a test") - 7) < 5, `-> ${estimateTokens("hello world this is a test")}`);
ok("estimateTokens cjk > 0", estimateTokens("这是一个中文句子") > 3);

const long = "word ".repeat(2000);
const clamped = clampTokens(long, 50);
ok("clampTokens respects budget", estimateTokens(clamped) <= 70, `-> ${estimateTokens(clamped)}`);

const withRefs = "Body text.\n".repeat(60) + "\nReferences\n\n[1] Someone. 2020.";
ok("dropReferences cuts the list", !dropReferences(withRefs).includes("[1] Someone"));

const pages = ["Intro para one.\n\nSecond para here with more text.", "Page two body text.\n\nAnother paragraph on page two."];
const chunks = chunkText(pages, 60, 10);
ok("chunkText produces chunks", chunks.length >= 2, `-> ${chunks.length}`);
ok("chunkText records pages", chunks.every((c) => c.page >= 0));
ok("chunkText keeps text", chunks.map((c) => c.text).join(" ").includes("Page two"));

ok("hash is stable", hash("abc") === hash("abc") && hash("abc") !== hash("abd"));
ok("lexTokens splits cjk bigrams", lexTokens("机器学习 model").includes("机器"), JSON.stringify(lexTokens("机器学习 model")));

/* ---- vector ---- */
const v = Array.from({ length: 64 }, (_, i) => Math.sin(i) * 0.7);
const q = quantize(v);
const back = dequantize(q.v, q.s);
let maxErr = 0;
for (let i = 0; i < v.length; i++) maxErr = Math.max(maxErr, Math.abs(v[i] - back[i]));
ok("quantize round-trips within 1%", maxErr < 0.01, `maxErr=${maxErr.toFixed(5)}`);
ok("cosine self = 1", Math.abs(cosine(v, v) - 1) < 1e-6);
ok("cosine opposite = -1", Math.abs(cosine(v, v.map((x) => -x)) + 1) < 1e-6);
ok("cosine survives quantisation", cosine(v, Array.from(back)) > 0.999);

/* ---- pdf layout ---- */
function run(str: string, x: number, y: number, w: number, h = 10) {
  return { str, transform: [1, 0, 0, 1, x, y], width: w, height: h };
}
// two lines of a paragraph, then a gap, then a new paragraph
const content = {
  items: [
    run("The quick brown", 50, 700, 80),
    run(" fox jumps", 131, 700, 50),
    run("over the lazy dog.", 50, 688, 90),
    run("A second paragraph starts here.", 50, 650, 140),
  ],
};
const lines = toLines(runsFromTextContent(content as any));
ok("toLines groups by baseline", lines.length === 3, `-> ${lines.length}`);
ok("toLines joins runs in order", lines[0].text.startsWith("The quick brown"), lines[0].text);

const paras = toParagraphs(lines, 612, {});
ok("toParagraphs merges wrapped lines", paras.length === 2, `-> ${paras.length}: ${JSON.stringify(paras.map((p) => p.text))}`);
ok("paragraph box covers both lines", paras[0].box[3] - paras[0].box[1] > 15, JSON.stringify(paras[0].box));

// arXiv stamps its id down the left margin as rotated text. PDF.js reports the
// stamp's origin and its length along the rotated axis, so read as horizontal it
// lands on one body line and runs across the gutter — and that line was then
// left untranslated on the page.
const stamped = runsFromTextContent({
  items: [
    { str: "arXiv:2609.20115v1 [eess.SY] 17 Sep 2026", transform: [0, 20, -20, 0, 38, 219], width: 360, height: 20 },
    run("material for establishing the interaction of communication).", 54, 219.2, 245),
  ],
} as any);
ok("rotated text is not read as a line", stamped.length === 1 && stamped[0].str.startsWith("material"), JSON.stringify(stamped.map((r) => r.str)));
const sheared = runsFromTextContent({
  items: [{ str: "small-talk", transform: [9.5, 0, 2, 9.5, 300, 502], width: 40, height: 9.5 }],
} as any);
ok("a faked italic (sheared, not rotated) is kept", sheared.length === 1, JSON.stringify(sheared));

// two columns on one baseline must not become one line
const twoColumnRuns = runsFromTextContent({
  items: [
    run("Cranes are the main handling equipment in", 40, 500, 200),
    run("of storage location assignment and crane", 310, 500, 200),
    run("the slab yard and their scheduling matters.", 40, 488, 200),
    run("scheduling are studied in this paper here.", 310, 488, 200),
  ],
} as any);
const twoColLines = toLines(twoColumnRuns);
ok(
  "a baseline is split at the column gutter",
  twoColLines.length === 4 && twoColLines.every((l) => l.cells === 2),
  JSON.stringify(twoColLines.map((l) => l.text)),
);

const twoColParas = toParagraphs(twoColLines, 612, {});
ok(
  "columns become separate paragraphs",
  twoColParas.length === 2 &&
    twoColParas.some((p) => p.text.startsWith("Cranes are the main")) &&
    twoColParas.some((p) => p.text.startsWith("of storage location")),
  JSON.stringify(twoColParas.map((p) => p.text)),
);
ok(
  "and no paragraph mixes the two columns",
  twoColParas.every((p) => !/equipment in of storage|matters. scheduling are/.test(p.text)) &&
    twoColParas.some((p) => p.text.endsWith("scheduling matters.")),
  JSON.stringify(twoColParas.map((p) => p.text)),
);

// a narrow gutter is still a gutter: 15pt between 9pt columns
const tight: any[] = [];
for (let i = 0; i < 30; i++) {
  tight.push(run(`left column line ${i} of text`, 51, 700 - i * 12, 235, 9));
  tight.push(run(`right column line ${i} of text`, 301, 700 - i * 12, 232, 9));
}
const tightRuns = runsFromTextContent({ items: tight } as any);
const gutters = findGutters(tightRuns, 595);
ok("the gutter is found by gap voting", gutters.length === 1 && gutters[0] > 286 && gutters[0] < 302,
   JSON.stringify(gutters));
const tightLines = toLines(tightRuns, 595);
ok("and the baselines are split there", tightLines.length === 60 && tightLines.every((l) => l.cells === 2),
   `${tightLines.length} lines`);
ok("no line spans both columns",
   tightLines.every((l) => l.x + l.width < 290 || l.x > 295),
   JSON.stringify(tightLines.slice(0, 2).map((l) => [l.x, l.width])));

// one column: no gutter to find
const single: any[] = [];
for (let i = 0; i < 30; i++) single.push(run(`a single column of running text ${i}`, 51, 700 - i * 12, 480, 9));
// one wide line across the gutter must not hide it
const mixed: any[] = [];
for (let i = 0; i < 24; i++) {
  mixed.push(run(`left column line ${i} of text`, 51, 700 - i * 12, 235, 9));
  mixed.push(run(`right column line ${i} of text`, 301, 700 - i * 12, 232, 9));
}
mixed.push(run("Figure 1: a caption that runs across both columns of the page", 51, 380, 420, 9));
mixed.push(run("Table 2: another wide line crossing the middle of the page", 51, 300, 400, 9));
const mixedGutters = findGutters(runsFromTextContent({ items: mixed } as any), 595);
ok("a wide caption does not hide the gutter", mixedGutters.length === 1, JSON.stringify(mixedGutters));

ok("a single column has no gutter", findGutters(runsFromTextContent({ items: single } as any), 595).length === 0);

// a word space is not a gutter
const spaced = toLines(
  runsFromTextContent({
    items: [run("justified text with", 40, 400, 90), run("wide word spaces", 140, 400, 80)],
  } as any),
);
ok("normal word spacing keeps one line", spaced.length === 1, JSON.stringify(spaced.map((l) => l.text)));

/* ---- columns whose baselines do not line up ---- */
/* The real failure this came from: this journal sets its right column 6.5pt
   below its left, so no baseline ever held both columns, gap voting had nothing
   to vote on, and no gutter was found. The damage was not the occasional welded
   line — it was that a welded line then made every line in the column look
   short of the right margin, so no two lines ever joined and a 12-page paper
   came out as 282 one-line "paragraphs". */
const offset: any[] = [];
for (let i = 0; i < 26; i++) {
  offset.push(run(`left column line number ${i} of running text`, 62, 700 - i * 13, 236, 9.5));
  offset.push(run(`right column line number ${i} of running text`, 309, 693.5 - i * 13, 235, 9.5));
}
const offsetRuns = runsFromTextContent({ items: offset } as any);
const offsetGutters = findGutters(offsetRuns, 595);
ok(
  "offset columns still have a gutter",
  offsetGutters.length === 1 && offsetGutters[0] > 298 && offsetGutters[0] < 309,
  JSON.stringify(offsetGutters),
);
const offsetLines = toLines(offsetRuns, 595);
ok(
  "every line knows its column",
  offsetLines.every((l) => (l.x < 300 ? l.column === 0 : l.column === 1)),
  JSON.stringify(offsetLines.slice(0, 3).map((l) => [l.x, l.column])),
);
const offsetParas = toParagraphs(offsetLines, 595, {});
ok(
  "and the lines of a column become one paragraph, not 26",
  offsetParas.length === 2 && offsetParas.every((par) => par.lines.length === 26),
  JSON.stringify(offsetParas.map((par) => par.lines.length)),
);

/* a full-width title must not stop the gutter being found underneath it */
const titlePage: any[] = [...offset];
titlePage.push(run("A study on deep reinforcement learning-based crane scheduling", 51, 740, 452, 22));
titlePage.push(run("Kai Feng, Lingzhi Yang, Dongfeng He, Shijing Lin, and Buxin Su", 51, 716, 340, 12));
ok(
  "a title across the top does not hide the gutter",
  findGutters(runsFromTextContent({ items: titlePage } as any), 595).length === 1,
  JSON.stringify(findGutters(runsFromTextContent({ items: titlePage } as any), 595)),
);

/* a chart's axis labels share a left edge; the body text is not a second column */
const chart: any[] = [];
for (let i = 0; i < 22; i++) chart.push(run(`a single column of running text line ${i}`, 135, 660 - i * 12, 346, 10));
for (let i = 0; i < 12; i++) chart.push(run(`${550 - i * 50}`, 116, 551 - i * 12, 6, 4));
ok(
  "a body column with labels to its left is not split down the middle",
  findGutters(runsFromTextContent({ items: chart } as any), 612).every((g) => g < 135),
  JSON.stringify(findGutters(runsFromTextContent({ items: chart } as any), 612)),
);

/* the same trap on the other side: a column of labels inside a figure shares a
   left edge with nothing above or below it, and a gutter there would cut every
   line of the page in half */
const inset: any[] = [];
for (let i = 0; i < 22; i++) inset.push(run(`a single column of running text line ${i}`, 135, 660 - i * 12, 346, 10));
for (let i = 0; i < 12; i++) {
  inset.push(run(`${i}`, 280, 400 - i * 12, 18, 8));
  inset.push(run(`label ${i}`, 322, 400 - i * 12, 40, 8));
}
const insetGutters = findGutters(runsFromTextContent({ items: inset } as any), 612);
ok(
  "a label column inside a figure is not a page gutter",
  insetGutters.every((g) => g < 135 || g > 481),
  JSON.stringify(insetGutters),
);

/* ---- a line's box has to cover its own ink ---- */
/* Runs join a baseline within half a font size of the seed run, so a 15pt
   heading beside a 9.5pt column can report a y 6.5pt above where its glyphs
   are. Painting from that y left a bold strip of the English heading showing
   under the Chinese one. */
const driftLines = toLines(
  runsFromTextContent({
    items: [
      run("ment learning is as below:", 309, 703.8, 130, 9.5),
      run("based crane scheduling method", 78, 697.3, 212, 15),
    ],
  } as any),
);
const drifted = driftLines.find((l) => l.text.startsWith("based crane"))!;
ok(
  "a line's box covers the runs in it, not the baseline it was filed under",
  (drifted.bottom ?? drifted.y) <= 697.3 && (drifted.top ?? 0) >= 697.3 + 15,
  JSON.stringify([drifted.y, drifted.bottom, drifted.top]),
);

/* a subscript PDF.js flattened onto a baseline of its own is not a line */
const orphan = toLines(
  runsFromTextContent({
    items: [
      run("to the action at that leads to maximum value of Q", 309, 420, 235, 9.5),
      run("t", 516, 413, 4, 6.3),
      run("t", 522, 413, 4, 6.3),
      run("under status st. The iteration and learning of Q", 309, 405, 235, 9.5),
    ],
  } as any),
);
ok(
  "an orphaned subscript does not become a line of its own",
  orphan.length === 2 && orphan.every((l) => l.text.length > 20),
  JSON.stringify(orphan.map((l) => l.text.slice(0, 20))),
);

/* a 15pt heading welded onto the same baseline as 9.5pt body text must not make
   every glyph of that body line look like a superscript */
const mixedBaseline = toLines(
  runsFromTextContent({
    items: [
      run("3 Deep reinforcement learning", 62, 716.8, 204.6, 15),
      run("-", 266.9, 716.8, 5.1, 15),
      run("achievement of the objective. General process of reinforce", 309, 716.8, 232, 9.5),
      run("-", 540.8, 716.8, 3.4, 9.5),
      ...Array.from({ length: 30 }, (_, i) =>
        run(`right column body line number ${i} of text`, 309, 700 - i * 13, 235, 9.5)),
      ...Array.from({ length: 30 }, (_, i) =>
        run(`left column body line number ${i} of text`, 62, 693.5 - i * 13, 236, 9.5)),
    ],
  } as any),
  595,
);
const tail = mixedBaseline.find((l) => l.text.startsWith("achievement"))!;
ok(
  "a hyphen beside a heading is kept, and covered",
  /reinforce-$/.test(tail.text) && tail.x + tail.width >= 544,
  JSON.stringify([tail.text.slice(-14), tail.x + tail.width]),
);

/* a two-line heading stays one heading */
const headingItems: any[] = [];
for (let i = 0; i < 8; i++) {
  headingItems.push(run(`body text set at the ordinary size of this page ${i}`, 62, 400 - i * 13, 235, 9.5));
}
headingItems.push(run("3.1 Basic principles of deep reinforcement", 62, 260, 226, 12));
headingItems.push(run("learning", 83, 246, 44, 12));
const headingLines = toLines(runsFromTextContent({ items: headingItems } as any));
const headingParas = toParagraphs(headingLines, 595, {});
ok(
  "a heading broken over two lines is one heading",
  headingParas.some((par) => par.text === "3.1 Basic principles of deep reinforcement learning"),
  JSON.stringify(headingParas.map((par) => par.text)),
);

/* ---- word spaces the PDF positioned rather than encoded ---- */
const positioned = toLines(
  runsFromTextContent({
    items: [
      run("where", 309, 400, 25.3, 9.5),
      run("k", 336.3, 400, 4.6, 9.5),
      run("is the times of iteration,", 342.9, 400, 96.3, 9.5),
    ],
  } as any),
);
ok(
  "a 2.06pt space at 9.5pt is a space",
  positioned[0].text === "where k is the times of iteration,",
  positioned[0].text,
);

/* ---- hanging indents are not paragraph breaks ---- */
const listRuns = runsFromTextContent({
  items: [
    run("(2) Affected by action at, the environment status changes", 309, 500, 235, 9.5),
    run("to st+1, assessment on the selected action of the intel-", 325, 487, 219, 9.5),
    run("ligent agent is carried out and reward rt is given based", 325, 474, 219, 9.5),
    run("on one type of reward function R;", 325, 461, 140, 9.5),
  ],
} as any);
const listParas = toParagraphs(toLines(listRuns, 595), 595, {});
ok(
  "a numbered item is one paragraph",
  listParas.length === 1 && listParas[0].lines.length === 4,
  JSON.stringify(listParas.map((par) => par.text)),
);

/* …but a first-line indent after a full line still is one */
const indentRuns = runsFromTextContent({
  items: [
    run("the previous paragraph runs the full width of the column", 309, 500, 235, 9.5),
    run("The intelligent agent finally obtains an optimal strategy", 326, 487, 218, 9.5),
    run("by constantly repeating these steps until the cycle ends.", 309, 474, 235, 9.5),
  ],
} as any);
const indentParas = toParagraphs(toLines(indentRuns, 595), 595, {});
ok(
  "a first-line indent still starts a paragraph",
  indentParas.length === 2,
  JSON.stringify(indentParas.map((par) => par.text)),
);

/* a line that spans the gutter belongs to neither column, however much of one
   it overlaps */
const spanItems: any[] = [...offset];
spanItems.push(run("Figure 3: the whole width of the page, directly under the left column", 62, 700 - 26 * 13, 482, 9.5));
const spanParas = toParagraphs(toLines(runsFromTextContent({ items: spanItems } as any), 595), 595, {});
ok(
  "a full-width line does not join the column above it",
  spanParas.some((par) => par.text.startsWith("Figure 3:")),
  JSON.stringify(spanParas.map((par) => par.text.slice(0, 30))),
);

/* ---- the reference list runs to the end of the document ---- */
/* Where it starts is a question about reading order, not about y: the heading
   sits halfway down the left column, and everything in the right column — all
   of it above the heading — follows it. */
const refState = { inReferences: false };
const refItems: any[] = [];
for (let i = 0; i < 20; i++) {
  refItems.push(run(`conclusion line number ${i} of the closing section`, 62, 700 - i * 13, 236, 9.5));
}
refItems.push(run("References", 62, 700 - 20 * 13, 72, 15));
for (let i = 0; i < 8; i++) {
  refItems.push(run(`Kim, K. H. and Y. M. Park. A crane scheduling method for terminals.`, 62, 680 - 20 * 13 - i * 11, 236, 8));
}
for (let i = 0; i < 12; i++) {
  // two lines an entry, the second one short: these close, in y order, well
  // above the heading that puts them in the bibliography
  refItems.push(run(`Yang, L. Z. Modeling and solution of crane scheduling in a slab`, 309, 700 - i * 22, 235, 8));
  refItems.push(run(`yard. Metals, Vol. ${i}.`, 309, 689 - i * 22, 90, 8));
}
const refPage = toParagraphs(toLines(runsFromTextContent({ items: refItems } as any), 595), 595, {
  skipReferences: true,
  state: refState,
});
ok(
  "everything after the References heading goes, in reading order",
  refPage.length === 1 && refPage[0].text.startsWith("conclusion line number 0"),
  JSON.stringify(refPage.map((par) => par.text.slice(0, 40))),
);
ok("and the state remembers it", refState.inReferences === true);

const nextItems: any[] = [];
for (let i = 0; i < 20; i++) {
  nextItems.push(run(`Feng, K. A study on crane scheduling for uncertainty tasks here.`, 62, 700 - i * 11, 236, 8));
  nextItems.push(run(`He, D. F. Deep reinforcement learning in the steelmaking shop.`, 309, 700 - i * 11, 235, 8));
}
const nextPage = toParagraphs(toLines(runsFromTextContent({ items: nextItems } as any), 595), 595, {
  skipReferences: true,
  state: refState,
});
ok(
  "a page of references with no heading on it is dropped too",
  nextPage.length === 0,
  JSON.stringify(nextPage.map((par) => par.text.slice(0, 40))),
);

/* ---- what is and is not the article ---- */
ok("an abstract is not an affiliation", !isFurniture("Abstract: Aiming at the crane scheduling problem for"));
ok(
  "a name and an institution is",
  isFurniture("Buxin Su: China Metallurgical Industry Planning and Research Institute"),
);
ok(
  "a broken address line is",
  isFurniture("Processing and Bioengineering, Central South University,"),
);
ok(
  "a sentence that mentions a university is not",
  !isFurniture("Mellon University in the United States proposed the routing method"),
);

/* ---- what should never be translated ---- */
ok("running head", isFurniture("Computers & Industrial Engineering 161 (2021) 107623", { top: true }));
ok("masthead", isFurniture("Contents lists available at ScienceDirect"));
ok("journal homepage", isFurniture("journal homepage: www.elsevier.com/locate/caie"));
ok("copyright", isFurniture("0360-8352/© 2021 Elsevier Ltd. All rights reserved.", { bottom: true }));
ok("e-mail line", isFurniture("E-mail addresses: gzpeng@ustb.edu.cn (G. Peng), daibeikeda@163.com (Y. Wu)."));
ok("doi", isFurniture("https://doi.org/10.1016/j.cie.2021.107623", { bottom: true }));
ok("dates", isFurniture("Available online 16 August 2021", { bottom: true }));
ok("letter-spaced header", isFurniture("A R T I C L E I N F O"));
ok("affiliation", isFurniture("a National Engineering Research Center for Advanced Rolling Technology, University of Science and Technology Beijing, Beijing 100083, China"));
ok("page number", isFurniture("7", { bottom: true }));
ok("journal section label", isFurniture("Review Article", { top: true }));
ok("publisher running head", isFurniture("DE GRUYTER", { top: true }));
ok("address tail", isFurniture("Beijing 100083, China"));
ok("author correspondence line", isFurniture("Buxin Su: China Metallurgical Industry Planning and Research Institute, Beijing 100013, China"));
ok("open access notice", isFurniture("Open Access. © 2022 Kai Feng et al., published by De Gruyter.", { top: true }));
ok(
  "a paper that is about reviews is not a label",
  !isFurniture("Review articles on crane scheduling have grown steadily since 2015, and this section surveys them."),
);
ok(
  "body text is not furniture",
  !isFurniture(
    "Cranes are the main handling equipment in the slab yard. In order to respond quickly to diverse needs of customers, the steel industry must improve efficiency.",
  ),
);
ok(
  "a mid-sentence fragment naming a university is body text",
  !isFurniture("Mellon University in the United States proposed the multi-agent reinforcement learning method that"),
);
ok(
  "a sentence that mentions a university is still body text",
  !isFurniture(
    "The data were collected at the University of Science and Technology Beijing. They cover one year of production and were validated against the plant's own records.",
  ),
);
ok("author line", looksLikeAuthors("Gongzhuang Peng, Youqi Wu, Chunjiang Zhang, Weiming Shen"));
ok(
  "a sentence is not an author line",
  !looksLikeAuthors("The crane scheduling problem is NP-hard, and heuristics are required."),
);

/* ---- hyphenation across lines ---- */
const hyphen = toParagraphs(
  toLines(runsFromTextContent({ items: [run("compu-", 50, 700, 40), run("tation is hard.", 50, 688, 90)] } as any)),
  612,
  {},
);
ok("hyphen join", hyphen[0].text.includes("computation"), hyphen[0].text);

/* ---- text floating inside a figure is left alone ---- */
const figure = toParagraphs(
  toLines(
    runsFromTextContent({
      items: [
        run("Environment", 270, 500, 42, 8),
        run("The workshop where", 256, 470, 60, 8),
        run("crane is loacted", 266, 462, 52, 8),
        run("Figure 1: Reinforcement learning mechanism of crane scheduling.", 51, 380, 250, 9),
        run("Status space is the set of potential status the environment can occupy at", 51, 300, 235, 9),
        run("any moment, and it is represented as a matrix in this article.", 51, 289, 235, 9),
      ],
    } as any),
  ),
  595,
  { pageHeight: 792 },
);
ok(
  "diagram labels are not translated",
  !figure.some((p) => /Environment|workshop where/.test(p.text)),
  JSON.stringify(figure.map((p) => [p.kind, p.text.slice(0, 30)])),
);
ok(
  "the caption and the body survive",
  figure.some((p) => p.kind === "caption") && figure.some((p) => /Status space/.test(p.text)),
  JSON.stringify(figure.map((p) => p.kind)),
);
ok("a matrix row is a formula", isFormula("Cranes 0 0 0 1 0 0 2 0 0 0 0 0"));
ok("a labelled matrix row too",
   isFormula("0 1 2 3 4 5 6 7 26 27 28 29 Staring stations 0 0 1 0 0 0 0 0 0 0 0 0"));
ok("a sentence with numbers in it is not a formula",
   !isFormula("In 2019, 45% of the 120 cranes in the workshop were replaced by newer models."));
ok("a piecewise brace is a formula", isFormula("⎧0, When the action doesn't end,"));

/* ---- a licence notice never joins the paragraph above it ---- */
const withLicence = toParagraphs(
  toLines(
    runsFromTextContent({
      items: [
        run("scheduling methods can only be generated based on", 51, 200, 230, 9),
        run("This work is licensed under the Creative Commons Attribution 4.0 International License.", 51, 188, 230, 9),
      ],
    } as any),
  ),
  595,
  { pageHeight: 792 },
);
ok(
  "the licence line is dropped, the sentence is not",
  withLicence.length === 1 && !/Creative Commons/.test(withLicence[0].text),
  JSON.stringify(withLicence.map((p) => p.text)),
);

/* ---- a paragraph cut by a column break is one request, not two ---- */
const cutA = "Mass customization and the shortening of delivery cycles have brought great challenges to manufacturing industries, and mass cus-";
const cutB = "tomization have brought great challenges to manufacturing industries.";
ok("a fragment that runs on is detected", continuesInto(cutA, cutB));
ok("the hyphen is healed on the join", joinContinuation(cutA, cutB).includes("mass customization have"),
   joinContinuation(cutA, cutB).slice(-60));
ok("a finished sentence does not run on",
   !continuesInto("The results are reported in Section 5.", "Cranes are the main equipment."));
ok("a heading does not swallow the next paragraph",
   !continuesInto("3. Problem description", "the slab yard is modelled as a grid."));
ok("an uppercase start is a new paragraph",
   !continuesInto("…which is discussed at length in the following section and", "The crane moves along one rail."));

const pieces = splitAcross("第一句在这里。第二句在那里。第三句也在。", [10, 10]);
ok("the translation is cut back into the fragments", pieces.length === 2 && pieces.every((p) => p.length > 0),
   JSON.stringify(pieces));
ok("and nothing is lost in the cut", pieces.join("") === "第一句在这里。第二句在那里。第三句也在。", JSON.stringify(pieces));
ok("the cut lands on a sentence boundary", /。$/.test(pieces[0]), JSON.stringify(pieces));

/* ---- reading order follows the columns ---- */
const ordered = readingOrder(
  [
    { text: "right top", box: [310, 600, 560, 610], fontSize: 10, lines: [], kind: "body" },
    { text: "left top", box: [40, 600, 290, 610], fontSize: 10, lines: [], kind: "body" },
    { text: "left bottom", box: [40, 100, 290, 110], fontSize: 10, lines: [], kind: "body" },
  ] as any,
  612,
);
ok("left column comes before right", ordered.map((p) => p.text).join(" | ") === "left top | left bottom | right top",
   ordered.map((p) => p.text).join(" | "));

/* ---- formulas are left alone ---- */
ok("display equation is a formula", isFormula("C(x, y) = Σ_i w_i · d(x_i, y_i) + λ ‖x‖^2   (3)"));
ok("numbered equation with a stray word", isFormula("s.t.  x_ij + y_ij ≤ 1,  ∀i ∈ N   (12)"));
ok("a table row of numbers is skipped", isFormula("12 3.4 56.7 8.90 11 2.3"));
ok("a sentence with a citation is not a formula",
   !isFormula("The crane scheduling problem (Chu et al., 2019) is NP-hard in the strong sense."));
ok("a sentence that mentions a variable is not a formula",
   !isFormula("Let x denote the number of slabs moved before time t, which grows with demand."));
ok("a numbered heading is not a formula", !isFormula("3.2. Slab yard layout and problem description"));

const paraKinds = toParagraphs(
  toLines(
    runsFromTextContent({
      items: [
        run("We now derive the bound.", 50, 700, 120),
        run("Σ_i x_i = 1,  ∀i ∈ N   (7)", 50, 660, 120),
      ],
    } as any),
  ),
  612,
  {},
);
ok("the equation is dropped from the translatable set",
   paraKinds.length === 1 && paraKinds[0].text.startsWith("We now"),
   JSON.stringify(paraKinds.map((p) => [p.kind, p.text])));
ok("and kept when the setting says so",
   toParagraphs(
     toLines(
       runsFromTextContent({
         items: [
           run("We now derive the bound.", 50, 700, 120),
           run("Σ_i x_i = 1,  ∀i ∈ N   (7)", 50, 660, 120),
         ],
       } as any),
     ),
     612,
     { keepFormulas: false },
   ).length === 2);

/* ---- pouring a translation back onto the original lines ---- */
const flow = flowIntoLines(
  "起重机调度问题在强意义下是NP难的，因此需要启发式算法来求解大规模实例。",
  [10, 10, 10],
);
ok("fills line by line", flow.lines.length === 3, JSON.stringify(flow.lines));
ok("nothing is lost", flow.lines.join("") + flow.rest === "起重机调度问题在强意义下是NP难的，因此需要启发式算法来求解大规模实例。",
   JSON.stringify(flow));
ok("each line fits its width", flow.lines.every((line, i) => textEm(line) <= [10, 10, 10][i] + 0.6),
   JSON.stringify(flow.lines.map((l) => textEm(l))));

const short = flowIntoLines("很短。", [10, 10, 10]);
ok("a short translation leaves later lines empty", short.lines[1] === "" && short.lines[2] === "",
   JSON.stringify(short.lines));

const overlong = flowIntoLines("这段译文比原文长得多，所以一定会有剩余的文字无处安放。", [6]);
ok("the overflow is reported, not dropped", overlong.rest.length > 0 && !overlong.lines[0].includes(overlong.rest),
   JSON.stringify(overlong));

const latin = flowIntoLines("The scheduling problem remains intractable", [12, 12]);
ok(
  "latin words are not split",
  latin.rest === "" &&
    latin.lines.join(" ").replace(/\s+/g, " ").trim() ===
      "The scheduling problem remains intractable" &&
    latin.lines.every((line) => !line || /^\S/.test(line)),
  JSON.stringify(latin),
);

const closer = flowIntoLines("这是一个句子，然后继续。", [6, 6]);
ok("a closing mark hangs instead of starting a line",
   !/^[，。、；：！？]/.test(closer.lines[1] || ""), JSON.stringify(closer.lines));


/* ---- prompt template scanning (added after the regex version mis-parsed braces) ---- */
import { splitTemplate, withPageMarkers } from "../src/utils/text";
import { renderMarkdown, markdownToNoteHTML } from "../src/lib/markdown";
import { readFileSync } from "node:fs";
import { extractDelta, stopReason } from "../src/modules/lens/provider";
import { replyLanguage } from "../src/modules/lens/prompts";
import { linkifyPages } from "../src/modules/lens/apps";

const t1 = splitTemplate("Question: ${P.question}\n\n${await P.fullText()}");
ok("splitTemplate finds both expressions", t1.expressions.length === 2, JSON.stringify(t1.expressions));
ok("splitTemplate keeps literals", t1.parts[0] === "Question: " && t1.parts[2] === "");

const t2 = splitTemplate("${JSON.stringify({ a: 1, b: { c: 2 } })}");
ok("nested object literal survives", t2.expressions[0] === "JSON.stringify({ a: 1, b: { c: 2 } })", t2.expressions[0]);

const t3 = splitTemplate("${P.items.map(i => `${i.id}`).join(',')}");
ok("nested template literal survives", t3.expressions.length === 1, JSON.stringify(t3.expressions));

const t4 = splitTemplate('${f("}")}');
ok("brace inside a string is not a terminator", t4.expressions[0] === 'f("}")', t4.expressions[0]);

const t5 = splitTemplate("no expressions here");
ok("plain text untouched", t5.expressions.length === 0 && t5.parts[0] === "no expressions here");

const t6 = splitTemplate("unterminated ${P.foo");
ok("unterminated expression stays literal", t6.expressions.length === 0, JSON.stringify(t6));

const t7 = splitTemplate("a ${x} b ${y} c");
const rebuilt = t7.parts[0] + "1" + t7.parts[1] + "2" + t7.parts[2];
ok("parts reassemble in order", rebuilt === "a 1 b 2 c", rebuilt);

/* ---- the front matter of an IEEE-style paper (arXiv:2609.20115, p. 1) ---- */
const affiliation =
  "1The authors are with the Institute of Control and System Theory, EECS, University of Kassel, Germany {uk089421, v.schmidtke, Z.Liu, stursberg}@uni-kassel.de";
ok("an affiliation footnote with its marker glued on is furniture", isFurniture(affiliation), affiliation.slice(0, 40));
ok("so is the brace list of e-mail addresses on its own line", isFurniture("Z.Liu, stursberg}@uni-kassel.de"));
ok("a sentence that happens to say 'are with the' is still prose",
   !isFurniture("The measured delays are with the exception of one outlier within the bound of Theorem 2."));

const frontMatter = toParagraphs(
  toLines(
    runsFromTextContent({
      items: [
        run("The Small-Talk Effect in Practical Synchronization", 127, 707, 358, 15.9),
        run("of Heterogeneous Oscillating Dynamics", 170, 687, 272, 15.9),
        run("Finn Voland1, Vincent Schmidtke1, Zonglin Liu1 and Olaf Stursberg1", 149, 655.7, 313, 10.96),
        run("Abstract— This paper investigates communication schemes in", 64, 622, 235, 8.97),
        run("synchronization of heterogeneous Liénard oscillator systems.", 54, 612, 245, 8.97),
      ],
    } as any),
    612,
  ),
  612,
  { pageHeight: 792, firstPage: true },
);
ok("an author line under a two-line title is not translated",
   !frontMatter.some((p) => /Voland/.test(p.text)) && frontMatter.some((p) => /^Abstract/.test(p.text)),
   JSON.stringify(frontMatter.map((p) => [p.kind, p.text.slice(0, 24)])));

/* what DeepSeek actually wrote: LaTeX in \( \) and \[ \], which the KaTeX plugin does not read */
const bracketed = renderMarkdown("偏差 \\(\\zeta(t)\\) 的界：\n\n\\[\n\\|\\zeta(t)\\| \\le \\zeta_{\\max}\n\\]\n\n代码 `\\(x\\)` 不动。");
// KaTeX keeps the TeX source in a MathML <annotation>; anything outside one is unrendered
const visible = bracketed.replace(/<annotation[\s\S]*?<\/annotation>/g, "");
ok("\\( … \\) and \\[ … \\] render as formulas", (bracketed.match(/class="katex"/g) || []).length === 2 && !visible.includes("\\zeta"),
   bracketed.replace(/<span class="katex[\s\S]*?<\/annotation>/g, "[math]").slice(0, 200));
ok("but not inside code", bracketed.includes("<code>\\(x\\)</code>"));
ok("and the result is still well-formed XML", xmlProblem(bracketed) === null, String(xmlProblem(bracketed)));

ok("an answer cut off at max_tokens is noticed",
   stopReason(JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }), "openai") === "length" &&
   stopReason(JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" } }), "anthropic") === "length");
ok("a finished one is not",
   stopReason(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }), "openai") === "");

/* a one-click command in the Chinese UI must not come back in English */
(globalThis as any).Zotero.locale = "zh-CN";
ok("a command with no question asks for Chinese in the Chinese UI", /Simplified Chinese/.test(replyLanguage("Summarise the current page.", {})));
ok("a typed question sets the language itself", replyLanguage("Question: ${P.question}", { question: "What is τ?" }) === "");
ok("a translation keeps its own target", replyLanguage("Translate into ${P.targetLanguage}.", {}) === "");
(globalThis as any).Zotero.locale = "en-US";
ok("the English UI adds nothing", replyLanguage("Summarise the current page.", {}) === "");

const linked = linkifyPages("<li>定理 1（p. 5）与引理 4 (p. 4)</li>", { key: "ABCD1234" } as any);
const ranged = linkifyPages("<li>(p. 2–3) 与 (pp. 4-5)</li>", { key: "ABCD1234" } as any);
ok("a page range links to its first page", /page=2">p\. 2–3</.test(ranged) && /page=4">p\. 4–5</.test(ranged), ranged);
// what aiOutline actually does: model Markdown → note HTML → links
const outlined = linkifyPages(
  markdownToNoteHTML("- (p. 1) 背景\n- (p. 2–3) 引入 $N_1$ 子集\n- (p. 4\u20115) 与 (p. 6\u22127)"),
  { key: "ABCD1234" } as any,
);
ok("an outline's page ranges link after the Markdown conversion",
   (outlined.match(/\?page=/g) || []).length === 4 && /page=2">p\. 2–3</.test(outlined), outlined.slice(0, 300));
ok("page markers link, full-width brackets included",
   (linked.match(/open-pdf\/library\/items\/ABCD1234\?page=/g) || []).length === 2, linked);

/* ---- graph: a tag on most of the library links nothing ---- */
const tagged = new Map<number, string[]>();
for (let id = 1; id <= 12; id++) tagged.set(id, ["#读完"]);
tagged.get(1)!.push("synchronization", "Liénard");
tagged.get(2)!.push("synchronization", "Liénard");
tagged.get(3)!.push("synchronization");
tagged.get(4)!.push("reinforcement learning");
tagged.get(5)!.push("reinforcement learning");
const links = tagLinks(tagged, 12);
const pair = (a: number, b: number) => links.find((l) => l.a === Math.min(a, b) && l.b === Math.max(a, b));
ok("a status tag on every paper adds no links", !pair(6, 7) && !pair(4, 9), JSON.stringify(links));
ok("papers sharing a specific tag are linked", !!pair(4, 5) && !!pair(1, 3));
ok("two shared tags pull harder than one", (pair(1, 2)?.weight ?? 0) > (pair(1, 3)?.weight ?? 0),
   JSON.stringify([pair(1, 2), pair(1, 3)]));

/* ---- AI answers ---- */

/**
 * The panel lives in Zotero's XHTML main window, where innerHTML is parsed as
 * XML: one `<br>` or a stray entity throws, and the answer stops rendering.
 */
function xmlProblem(html: string): string | null {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const text = (chunk: string) => {
    if (chunk.includes("<")) return `raw < in ${JSON.stringify(chunk.slice(0, 40))}`;
    const entity = chunk.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[^;\s]{0,10}/);
    return entity ? `bad entity ${entity[0]}` : null;
  };
  while ((match = tag.exec(html))) {
    const problem = text(html.slice(last, match.index));
    if (problem) return problem;
    last = tag.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return `mismatched </${name}>`;
  }
  return text(html.slice(last)) || (stack.length ? `unclosed <${stack.pop()}>` : null);
}

const answer = renderMarkdown("第一行\n第二行，公式 $x^2$。\n\n$$\\sum_i a_i$$\n\n---\n\n![图](https://example.org/f.png)");
ok("an answer renders its LaTeX", answer.includes('class="katex"'), answer.slice(0, 80));
ok("an answer is well-formed XML", xmlProblem(answer) === null, String(xmlProblem(answer)));

// The shipped stylesheet must come from the KaTeX that produced the HTML. A
// newer katex.min.css renamed `thinbox`/`vbox`/`base`/`strut`, and every \neq
// fell apart into a slash and an equals sign on separate lines.
{
  let css = "";
  try {
    css = readFileSync("addon/content/vendor/katex/katex.min.css", "utf8");
  } catch {
    /* reported below */
  }
  const formulas = renderMarkdown(
    "$a \\neq b$, $x \\notin A$, $\\sqrt{x}+\\frac{a}{b}$, $\\hat{x}\\tilde{A}_m$\n\n" +
      "$$\\underbrace{\\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}}_{=:\\Gamma_l}$$",
  );
  // KaTeX's atom types are hooks for spacing, not styled boxes; `katex-block` is
  // markdown-it-katex's wrapper around `katex-display`, which does the styling.
  const atoms = new Set(["mord", "mrel", "mbin", "mopen", "mclose", "minner", "mpunct", "mop", "mtight", "nobreak", "katex-block"]);
  const unstyled = new Set<string>();
  for (const match of formulas.matchAll(/class="([^"]*)"/g)) {
    for (const name of match[1].split(/\s+/)) {
      if (!name || atoms.has(name)) continue;
      if (!new RegExp(`\\.${name.replace(/[^\w-]/g, "\\$&")}(?![\\w-])`).test(css)) unstyled.add(name);
    }
  }
  ok(
    "every KaTeX class the renderer emits is styled by the shipped stylesheet",
    css.length > 0 && unstyled.size === 0,
    css ? [...unstyled].join(" ") : "addon/content/vendor/katex/katex.min.css missing — run npm run vendor",
  );
}

const thinking = JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: "We need to answer…" } }] });
const speaking = JSON.stringify({ choices: [{ delta: { content: "答案", reasoning_content: null } }] });
ok("a reasoning model's thinking stays out of the answer", extractDelta(thinking, "openai") === "", extractDelta(thinking, "openai"));
ok("its answer tokens still come through", extractDelta(speaking, "openai") === "答案");

const paged = withPageMarkers(["Intro.", "Body text.", "Results.\n\nReferences\n\n[1] Someone. 2020."]);
ok("full text carries page markers", paged.includes("--- p. 2 ---\nBody text."), JSON.stringify(paged));
ok("page markers survive dropping the references", dropReferences(paged).includes("--- p. 3 ---") && !dropReferences(paged).includes("[1] Someone"));
ok("a page range keeps its own numbering", withPageMarkers(["x", "y"], 4).startsWith("--- p. 4 ---\nx"));

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall green");
process.exit(fails.length ? 1 : 0);

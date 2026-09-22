/**
 * Claim-level cross-paper comparison.
 *
 * A literature matrix built from highlights tells you what you marked. This
 * builds the other matrix: the claims themselves, and whether each other paper
 * in the set supports them, contradicts them, or never addresses them.
 */

import { config } from "../../../package.json";
import { bi } from "../../utils/locale";
import { chat } from "../lens/provider";
import { ensureIndexed, searchLibrary } from "../lens/rag";
import { clampTokens, escapeHTML } from "../../utils/text";
import { getFullText, itemCitation, toRegularItem, createChildNote, revealNotes } from "../../utils/item";
import { markdownToNoteHTML } from "../../lib/markdown";
import { openProgress } from "../../utils/progress";

export interface Claim {
  text: string;
  page?: number;
  source: string;
}

export type Verdict = "supports" | "contradicts" | "unclear" | "absent";

export interface Cell {
  verdict: Verdict;
  evidence: string;
  page?: number;
}

export interface ClaimMatrix {
  claims: Claim[];
  papers: Zotero.Item[];
  cells: Record<string, Cell>;
}

const MARK: Record<Verdict, string> = {
  supports: "✔",
  contradicts: "✘",
  unclear: "~",
  absent: "·",
};

async function extractClaims(item: Zotero.Item, limit = 5): Promise<Claim[]> {
  // page-marked, so the "page" field below is read, not guessed
  const text = await getFullText(item, { maxChars: 120_000, pageMarkers: true });
  if (!text) return [];
  const answer = await chat(
    [
      {
        role: "user",
        content: `Extract the ${limit} central empirical or theoretical claims this paper makes — the statements another paper could agree or disagree with. Avoid method descriptions and background.

Reply as JSON only:
[{"claim":"<one sentence, self-contained>","page":<page number if visible, else 0>}]

--- PAPER ---
${clampTokens(text, 60_000)}`,
      },
    ],
    { temperature: 0.2 },
  );
  const match = answer.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return (Array.isArray(parsed) ? parsed : [])
      .filter((entry: any) => typeof entry?.claim === "string")
      .slice(0, limit)
      .map((entry: any) => ({
        text: String(entry.claim).trim(),
        page: Number(entry.page) || undefined,
        source: item.key,
      }));
  } catch {
    return [];
  }
}

async function judge(
  item: Zotero.Item,
  claims: Claim[],
): Promise<Record<number, Cell>> {
  const context: string[] = [];
  for (const claim of claims) {
    const hits = await searchLibrary(claim.text, { topK: 3, itemIDs: [item.id] });
    context.push(
      hits
        .map((hit) => `(p.${hit.page + 1}) ${hit.text}`)
        .join("\n")
        .slice(0, 2400),
    );
  }
  const body = claims
    .map(
      (claim, index) =>
        `### Claim ${index + 1}\n${claim.text}\n\nEvidence from "${String(
          item.getField("title") || "",
        )}":\n${context[index] || "(nothing retrieved)"}`,
    )
    .join("\n\n");

  const answer = await chat(
    [
      {
        role: "user",
        content: `For each claim below decide, using only the supplied evidence from this one paper, whether the paper supports it, contradicts it, is unclear, or does not address it at all. Never guess from background knowledge.

Reply as JSON only:
[{"claim":<number>,"verdict":"supports|contradicts|unclear|absent","evidence":"<a short quote or empty>","page":<page or 0>}]

${body}`,
      },
    ],
    { temperature: 0.1 },
  );
  const out: Record<number, Cell> = {};
  const match = answer.match(/\[[\s\S]*\]/);
  if (!match) return out;
  try {
    for (const entry of JSON.parse(match[0])) {
      const index = Number(entry.claim) - 1;
      if (index < 0 || index >= claims.length) continue;
      out[index] = {
        verdict: (["supports", "contradicts", "unclear", "absent"].includes(entry.verdict)
          ? entry.verdict
          : "unclear") as Verdict,
        evidence: String(entry.evidence || "").slice(0, 300),
        page: Number(entry.page) || undefined,
      };
    }
  } catch {
    /* model returned something unparseable */
  }
  return out;
}

export async function buildClaimMatrix(items: Zotero.Item[]): Promise<ClaimMatrix | null> {
  const papers = items
    .map((item) => toRegularItem(item))
    .filter(Boolean) as Zotero.Item[];
  if (papers.length < 2) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({
        text: bi("Select at least two papers.", "请至少选择两篇文献。"),
        type: "fail",
      })
      .show(3000);
    return null;
  }

  const progress = openProgress(bi("Indexing…", "正在建立索引…"), { progress: 5 });
  await ensureIndexed(papers);

  const claims: Claim[] = [];
  for (let i = 0; i < papers.length; i++) {
    progress.changeLine({
      text: `${bi("Extracting claims", "正在提取观点")} ${i + 1}/${papers.length}`,
      progress: 5 + (i / papers.length) * 40,
    });
    claims.push(...(await extractClaims(papers[i], papers.length > 4 ? 3 : 5)));
  }
  if (!claims.length) {
    progress.changeLine({ text: bi("No claims extracted.", "未能提取到观点。"), type: "fail" });
    progress.startCloseTimer(4000);
    return null;
  }

  const cells: Record<string, Cell> = {};
  for (let p = 0; p < papers.length; p++) {
    progress.changeLine({
      text: `${bi("Comparing", "正在比对")} ${p + 1}/${papers.length}`,
      progress: 45 + (p / papers.length) * 55,
    });
    const verdicts = await judge(papers[p], claims);
    for (const [index, cell] of Object.entries(verdicts)) {
      cells[`${index}:${papers[p].key}`] = cell;
    }
  }

  progress.changeLine({
    text: bi("Matrix ready", "矩阵已生成"),
    progress: 100,
    type: "success",
  });
  progress.startCloseTimer(2500);
  return { claims, papers, cells };
}

export function matrixToMarkdown(matrix: ClaimMatrix): string {
  const header = `| ${bi("Claim", "观点")} | ${matrix.papers
    .map((paper) => itemCitation(paper))
    .join(" | ")} |`;
  const divider = `| --- | ${matrix.papers.map(() => "---").join(" | ")} |`;
  const lines = [header, divider];
  matrix.claims.forEach((claim, index) => {
    const cells = matrix.papers.map((paper) => {
      const cell = matrix.cells[`${index}:${paper.key}`];
      if (!cell) return MARK.absent;
      const note = cell.evidence
        ? ` <sub>${cell.evidence.replace(/\|/g, "").slice(0, 90)}</sub>`
        : "";
      return `${MARK[cell.verdict]}${note}`;
    });
    lines.push(`| ${claim.text.replace(/\|/g, "")} | ${cells.join(" | ")} |`);
  });
  lines.push(
    "",
    `${MARK.supports} ${bi("supports", "支持")} · ${MARK.contradicts} ${bi(
      "contradicts",
      "反驳",
    )} · ${MARK.unclear} ${bi("unclear", "不明确")} · ${MARK.absent} ${bi(
      "not addressed",
      "未涉及",
    )}`,
  );
  return lines.join("\n");
}

/** Build the matrix and file it as a note under the first paper. */
export async function claimMatrixToNote(items: Zotero.Item[]) {
  const matrix = await buildClaimMatrix(items);
  if (!matrix) return;
  const markdown = matrixToMarkdown(matrix);
  const conflicts = matrix.claims
    .map((claim, index) => ({
      claim,
      against: matrix.papers.filter(
        (paper) => matrix.cells[`${index}:${paper.key}`]?.verdict === "contradicts",
      ),
    }))
    .filter((entry) => entry.against.length);

  const html = [
    `<h2>${bi("Claim × evidence matrix", "观点 × 证据矩阵")}</h2>`,
    markdownToNoteHTML(markdown),
  ];
  if (conflicts.length) {
    html.push(
      `<h3>${bi("Where your papers disagree", "文献之间的分歧")}</h3>`,
      "<ul>",
      ...conflicts.map(
        (entry) =>
          `<li>${escapeHTML(entry.claim.text)} — ${bi("contradicted by: ", "被以下文献反驳：")}${entry.against
            .map((paper) => escapeHTML(itemCitation(paper)))
            .join(", ")}</li>`,
      ),
      "</ul>",
    );
  }
  const note = await createChildNote(matrix.papers[0], html.join("\n"), "prism/claims");
  await revealNotes([note]);
}

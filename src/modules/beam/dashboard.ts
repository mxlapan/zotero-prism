/**
 * The Prism dashboard: reading rhythm, the review queue, the citation gap
 * radar and a "continue reading" shelf, in one tab.
 */

import { bi } from "../../utils/locale";
import { clear, el } from "../../utils/dom";
import { injectAssets } from "../lens/ui";
import { getPref } from "../../utils/prefs";
import { localDay, readingSummary, rhythm, streak } from "../spectrum/reading";
import { dueCards, deckStats, grade, forget, bury, type DueCard } from "./review";
import { scanGaps, importGap, type Gap } from "./gapRadar";
import { navigateTo, toRegularItem } from "../../utils/item";

let tabID = "";

export async function openDashboard(win: Window) {
  if (tabID) {
    try {
      (win as any).Zotero_Tabs.select(tabID);
      return;
    } catch {
      tabID = "";
    }
  }
  const { id, container } = (win as any).Zotero_Tabs.add({
    type: "prism-dashboard",
    title: bi("Prism", "棱镜"),
    select: true,
    // Zotero 10's Zotero_Tabs._update() reads tab.data.icon for every
    // non-library tab, so a tab added without `data` throws before add()
    // even returns — and then keeps throwing on every later tab change.
    data: {},
    onClose: () => {
      tabID = "";
    },
  });
  tabID = id;
  const doc = win.document;
  injectAssets(doc);
  const root = el(doc, "div", {
    class: "prism-root",
    style: {
      height: "100%",
      overflow: "auto",
      padding: "16px 20px",
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      gap: "18px",
      maxWidth: "980px",
      margin: "0 auto",
    },
  });
  container.append(root);
  await renderDashboard(root, win);
}

function card(doc: Document, title: string): { box: HTMLElement; body: HTMLElement } {
  const box = el(doc, "div", {
    style: {
      border: "1px solid var(--prism-border)",
      borderRadius: "12px",
      padding: "12px 14px",
      background: "var(--prism-bg)",
    },
  });
  box.append(
    el(doc, "div", {
      text: title,
      style: { fontWeight: "650", marginBottom: "9px", fontSize: "13px" },
    }),
  );
  const body = el(doc, "div");
  box.append(body);
  return { box, body };
}

async function renderDashboard(root: HTMLElement, win: Window) {
  const doc = win.document;
  clear(root);

  /* ---- rhythm ---- */
  const rhythmCard = card(doc, bi("Reading rhythm", "阅读节律"));
  const data = rhythm();
  const todayKey = localDay();
  const todayStat = data[todayKey] || { seconds: 0, pages: 0, annotations: 0, items: [] };
  const goal = Number(getPref("beam.rhythmGoalMinutes", 45));
  const minutes = Math.round(todayStat.seconds / 60);

  const stats = el(doc, "div", { class: "prism-stat" });
  const stat = (value: string, label: string) =>
    el(
      doc,
      "div",
      { class: "prism-stat-box" },
      el(doc, "div", { class: "prism-stat-num", text: value }),
      el(doc, "div", { class: "prism-stat-label", text: label }),
    );
  stats.append(
    stat(`${minutes}′`, `${bi("today", "今日")} / ${goal}′`),
    stat(String(streak()), bi("day streak", "连续天数")),
    stat(String(todayStat.items.length), bi("papers touched", "涉及文献")),
    stat(String(todayStat.annotations), bi("annotations", "新增标注")),
  );
  rhythmCard.body.append(stats);

  /* 12 weeks of activity */
  const cal = el(doc, "div", { class: "prism-cal", style: { marginTop: "12px" } });
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - 83);
  let max = 1;
  for (const day of Object.values(data)) max = Math.max(max, day.seconds);
  for (let i = 0; i < 84; i++) {
    const key = localDay(cursor);
    const seconds = data[key]?.seconds || 0;
    const ratio = seconds / max;
    cal.append(
      el(doc, "div", {
        class: "prism-cal-day",
        title: `${key} · ${Math.round(seconds / 60)} min`,
        style: {
          background: seconds
            ? `rgba(46,168,229,${(0.18 + ratio * 0.82).toFixed(2)})`
            : "var(--prism-bg-soft)",
        },
      }),
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  rhythmCard.body.append(cal);
  root.append(rhythmCard.box);

  /* ---- review ---- */
  const reviewCard = card(doc, bi("Annotation review", "标注复习"));
  root.append(reviewCard.box);
  void renderReview(reviewCard.body, win);

  /* ---- continue reading ---- */
  const shelf = card(doc, bi("Continue reading", "继续阅读"));
  root.append(shelf.box);
  void renderShelf(shelf.body, win);

  /* ---- gaps ---- */
  const gapCard = card(doc, bi("Citation gap radar", "引文缺口雷达"));
  root.append(gapCard.box);
  renderGapControls(gapCard.body, win);
}

async function renderReview(body: HTMLElement, win: Window) {
  const doc = win.document;
  clear(body);
  const stats = await deckStats();
  const cards = await dueCards();
  body.append(
    el(doc, "div", {
      class: "prism-stat-label",
      text: `${stats.due} ${bi("due", "张待复习")} · ${stats.total} ${bi(
        "in deck",
        "张卡片",
      )} · ${stats.mature} ${bi("mature", "张已掌握")}`,
      style: { marginBottom: "8px" },
    }),
  );
  if (!cards.length) {
    body.append(
      el(doc, "div", {
        class: "prism-chip",
        text: bi("Nothing due.", "暂无待复习的标注。"),
      }),
    );
    return;
  }
  const card = cards[0];
  const node = el(doc, "div", {
    class: "prism-anno",
    style: {
      borderInlineStartColor: card.annotation.color || "#999",
      padding: "8px 10px",
      fontSize: "13px",
    },
  });
  node.append(
    el(doc, "div", {
      class: "prism-anno-head",
      text: `${card.title.slice(0, 70)} · p.${card.annotation.pageLabel}`,
    }),
    el(doc, "div", { text: card.annotation.text || card.annotation.comment }),
  );
  if (card.annotation.text && card.annotation.comment) {
    node.append(el(doc, "div", { class: "prism-anno-comment", text: card.annotation.comment }));
  }
  node.addEventListener("click", () =>
    navigateTo(card.attachmentID, { annotationKey: card.key }),
  );
  body.append(node);

  const buttons = el(doc, "div", { class: "prism-row", style: { marginTop: "8px" } });
  const act = async (result: "again" | "good" | "easy") => {
    await grade(card.key, result);
    await renderReview(body, win);
  };
  buttons.append(
    el(doc, "button", { class: "prism-btn", text: bi("Again", "重来"), on: { click: () => void act("again") } }),
    el(doc, "button", {
      class: "prism-btn prism-btn-primary",
      text: bi("Good", "良好"),
      on: { click: () => void act("good") },
    }),
    el(doc, "button", { class: "prism-btn", text: bi("Easy", "简单"), on: { click: () => void act("easy") } }),
    el(doc, "button", {
      class: "prism-btn",
      text: bi("Later", "稍后"),
      // `bury` was written and then never given a button: a card you cannot
      // answer today could only be graded wrong or dropped for good.
      attrs: { title: bi("Hide this card for 30 days", "将此卡片推迟 30 天") },
      on: {
        click: async () => {
          await bury(card.key);
          await renderReview(body, win);
        },
      },
    }),
    el(doc, "button", {
      class: "prism-btn",
      text: bi("Drop", "移除"),
      on: {
        click: async () => {
          await forget(card.key);
          await renderReview(body, win);
        },
      },
    }),
    el(doc, "span", {
      class: "prism-stat-label",
      text: `${cards.length - 1} ${bi("left", "张待复习")}`,
      style: { alignSelf: "center" },
    }),
  );
  body.append(buttons);
  void (card as DueCard);
}

async function renderShelf(body: HTMLElement, win: Window) {
  const doc = win.document;
  clear(body);
  const entries: Array<{ item: Zotero.Item; coverage: number; last: number; minutes: number }> = [];
  for (const [key, record] of addon.data.spectrum.reading) {
    if (record.total < 120) continue;
    const attachment = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      key,
    ) as Zotero.Item | false;
    const item = toRegularItem(attachment || null);
    if (!item) continue;
    const summary = readingSummary(item);
    if (summary.coverage > 0.92) continue;
    entries.push({
      item,
      coverage: summary.coverage,
      last: record.last,
      minutes: summary.minutes,
    });
  }
  entries.sort((a, b) => b.last - a.last);
  if (!entries.length) {
    body.append(
      el(doc, "div", {
        class: "prism-chip",
        text: bi("Nothing in progress yet.", "暂无正在阅读的文献。"),
      }),
    );
    return;
  }
  for (const entry of entries.slice(0, 8)) {
    const row = el(doc, "div", {
      class: "prism-anno",
      style: { borderInlineStartColor: "#2ea8e5", cursor: "pointer", display: "flex", gap: "8px" },
      on: { click: () => void (win as any).ZoteroPane.selectItem(entry.item.id) },
    });
    row.append(
      el(doc, "div", {
        style: { flex: "1" },
        text: String(entry.item.getField("title") || "").slice(0, 90),
      }),
      el(doc, "span", {
        class: "prism-chip",
        text: `${Math.round(entry.coverage * 100)}% · ${entry.minutes}′`,
      }),
    );
    body.append(row);
  }
}

function renderGapControls(body: HTMLElement, win: Window) {
  const doc = win.document;
  clear(body);
  body.append(
    el(doc, "div", {
      class: "prism-stat-label",
      text: bi(
        "Papers your library cites again and again but does not contain.",
        "被文库中的文献反复引用、但尚未收录的论文。",
      ),
      style: { marginBottom: "8px" },
    }),
  );
  const results = el(doc, "div", { class: "prism-list", style: { maxHeight: "320px" } });
  const bar = el(doc, "div", { class: "prism-row" });
  bar.append(
    el(doc, "button", {
      class: "prism-btn prism-btn-primary",
      text: bi("Scan this collection", "扫描当前分类"),
      on: {
        click: async () => {
          const pane = (win as any).ZoteroPane;
          const row = pane?.getCollectionTreeRow?.();
          const selected: Zotero.Item[] = pane?.getSelectedItems?.() || [];
          const items: Zotero.Item[] =
            selected.length > 1
              ? selected
              : row?.isCollection?.()
                ? (row.ref.getChildItems(false, false) as Zotero.Item[])
                : selected;
          const gaps = await scanGaps(items.slice(0, 120));
          renderGaps(results, gaps, win);
        },
      },
    }),
  );
  body.append(bar, results);
}

function renderGaps(host: HTMLElement, gaps: Gap[], win: Window) {
  const doc = win.document;
  clear(host);
  if (!gaps.length) {
    host.append(
      el(doc, "div", {
        class: "prism-chip",
        text: bi("No gaps at the current threshold.", "在当前阈值下未发现缺口。"),
      }),
    );
    return;
  }
  for (const gap of gaps.slice(0, 40)) {
    const row = el(doc, "div", {
      class: "prism-anno",
      style: { borderInlineStartColor: "#d64d4d", display: "flex", gap: "8px" },
    });
    row.append(
      el(
        doc,
        "div",
        { style: { flex: "1" } },
        el(doc, "div", { text: gap.title, style: { fontWeight: "600" } }),
        el(doc, "div", {
          class: "prism-stat-label",
          text: `${gap.authors || ""} ${gap.year || ""} · ${bi(`cited by ${gap.hits} of your papers`, `被文库中 ${gap.hits} 篇文献引用`)}${
            gap.citations ? ` · ${bi(`${gap.citations} global citations`, `总被引 ${gap.citations}`)}` : ""
          }`,
        }),
      ),
    );
    if (gap.doi) {
      row.append(
        el(doc, "button", {
          class: "prism-btn",
          text: bi("Add", "加入文库"),
          on: {
            click: async (event: MouseEvent) => {
              const button = event.target as HTMLButtonElement;
              button.disabled = true;
              button.textContent = "…";
              const item = await importGap(gap);
              button.textContent = item ? bi("Added", "已加入") : bi("Failed", "失败");
              if (item) void (win as any).ZoteroPane.selectItem(item.id);
            },
          },
        }),
      );
    }
    host.append(row);
  }
}

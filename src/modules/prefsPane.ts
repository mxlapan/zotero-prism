/** Wiring for the settings pane. */

import { config, version, author, homepage } from "../../package.json";
import { bi, isZH } from "../utils/locale";
import { clear, el } from "../utils/dom";
import { getPref, setPref, getJSONPref, setJSONPref } from "../utils/prefs";
import {
  listModels,
  listProfiles,
  saveProfile,
  applyProfile,
  deleteProfile,
  testConnection,
} from "./lens/provider";
import { bridgeStatus } from "./lens/bridge";
import { clearIndex, indexItems, indexStats } from "./lens/rag";
import { loadPrompts, savePrompt, deletePrompt, resetPrompts, type PromptDef } from "./lens/prompts";
import { ENGINES, LANGUAGES, engineByID, fieldLabel } from "./refract/engines";
import { knownRankFields } from "./spectrum/ranks";
import { openColorEditor } from "./spectrum/colors";
import { deckStats } from "./beam/review";
import { listWatches, removeWatch, runWatches } from "./beam/watchlist";
import { SHORTCUTS } from "./keys";
import { contextItems } from "../utils/item";

/** `register` resolves with the pane id, which `openPreferences` needs. */
export async function registerPrefsPane() {
  try {
    addon.data.prefsPaneID = await Zotero.PreferencePanes.register({
      pluginID: config.addonID,
      // Without an id Zotero generates a random one on every launch, so the
      // settings window's "reopen the pane you were on" never finds ours again.
      id: "prism-prefpane",
      src: `${rootURI}content/preferences.xhtml`,
      label: "Prism",
      image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    });
  } catch (e) {
    Zotero.debug(`[Prism] preference pane registration failed: ${e}`);
  }
}

/**
 * Unpack the companion browser add-on next to the Zotero data directory so the
 * user can load it unpacked in Chrome or Edge.
 */
export async function materialiseBridgeExtension(): Promise<string> {
  const files = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
  ];
  const dir = PathUtils.join(Zotero.DataDirectory.dir, "prism", "browser-extension");
  try {
    await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    for (const name of files) {
      const source = await Zotero.File.getContentsFromURLAsync(
        `chrome://${config.addonRef}/content/browser-extension/${name}`,
      );
      await IOUtils.writeUTF8(PathUtils.join(dir, name), source);
    }
    return dir;
  } catch (e) {
    Zotero.debug(`[Prism] could not unpack the browser add-on: ${e}`);
    return "";
  }
}

const TABS: Array<[string, string]> = [
  ["general", bi("General", "通用")],
  ["ai", bi("AI", "AI")],
  ["translate", bi("Translation", "翻译")],
  ["library", bi("Library", "文库")],
  ["lab", bi("Lab", "实验室")],
];

export function onPrefsLoad(win: Window) {
  addon.data.prefs = { window: win };
  const doc = win.document;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    doc.getElementById(id) as T | null;

  localise($("prism-prefs-root"));

  /* ---- tab strip ---- */
  const strip = $("prism-tabs");
  const sections = Array.from(
    doc.querySelectorAll("[data-prism-tab]"),
  ) as HTMLElement[];
  if (strip) {
    clear(strip);
    for (const [id, label] of TABS) {
      strip.append(
        el(doc, "div", {
          class: "prism-tag",
          text: label,
          attrs: { "data-tab": id },
          on: {
            click: () => {
              for (const section of sections) {
                section.hidden = section.dataset.prismTab !== id;
              }
              for (const chip of Array.from(strip.children) as HTMLElement[]) {
                const active = chip.getAttribute("data-tab") === id;
                chip.style.background = active ? "var(--prism-accent)" : "";
                chip.style.color = active ? "#fff" : "";
              }
            },
          },
        }),
      );
    }
    (strip.firstElementChild as HTMLElement)?.click();
  }

  const about = $("prism-about");
  if (about) {
    clear(about);
    about.append(
      el(doc, "div", {
        text: bi(
          "Library visuals, an AI copilot and full-text translation.",
          "为 Zotero 提供文库可视化、AI 问答、全文翻译与阅读管理。",
        ),
      }),
      el(
        doc,
        "div",
        { style: "margin-top:4px" },
        bi("Version ", "版本 ") + version + bi(" · by ", " · 作者 ") + author + " · ",
        el(doc, "a", {
          text: homepage.replace(/^https:\/\//, ""),
          attrs: { href: homepage },
          style: "cursor:pointer;text-decoration:underline",
          on: {
            click: (event: Event) => {
              event.preventDefault();
              Zotero.launchURL(homepage);
            },
          },
        }),
      ),
      el(doc, "div", {
        style: "margin-top:4px;font-weight:600",
        text: bi(
          "Free and open source, published and used free of charge. Not for sale.",
          "本插件免费开源，发布和使用均不收取任何费用，严禁出售。",
        ),
      }),
    );
  }

  const shortcuts = $("prism-shortcuts");
  if (shortcuts) {
    clear(shortcuts);
    for (const [keys, en, zh] of SHORTCUTS) {
      shortcuts.append(
        el(doc, "dt", { text: keys }),
        el(doc, "dd", { text: bi(en, zh) }),
      );
    }
  }

  wireAI(win, doc, $);
  wireTranslate(win, doc, $);
  wireLibrary(win, doc, $);
  wireLab(win, doc, $);
}

/**
 * preferences.xhtml is written in English and carries its Chinese beside each
 * string: `data-zh` for text, `data-zh-label` / `data-zh-placeholder` for those
 * attributes, and `data-lang` on paragraphs that contain markup.
 */
function localise(root: HTMLElement | null) {
  if (!root) return;
  const zh = isZH();
  const all = (selector: string) => Array.from(root.querySelectorAll(selector)) as HTMLElement[];
  for (const node of all("[data-lang]")) {
    node.hidden = node.getAttribute("data-lang") !== (zh ? "zh" : "en");
  }
  if (!zh) return;
  for (const node of all("[data-zh]")) {
    node.textContent = node.getAttribute("data-zh");
  }
  for (const attr of ["label", "placeholder"]) {
    for (const node of all(`[data-zh-${attr}]`)) {
      node.setAttribute(attr, node.getAttribute(`data-zh-${attr}`)!);
    }
  }
}

type Getter = <T extends HTMLElement = HTMLElement>(id: string) => T | null;

function wireAI(win: Window, doc: Document, $: Getter) {
  const result = $("prism-test-result");

  $("prism-test")?.addEventListener("click", async () => {
    if (result) result.textContent = bi("testing…", "正在测试…");
    const outcome = await testConnection();
    if (result) {
      result.textContent = outcome.ok
        ? `✓ ${outcome.message} (${outcome.ms} ms)`
        : `✗ ${outcome.message}`;
      result.style.color = outcome.ok ? "#5fb236" : "#d64d4d";
    }
  });

  $("prism-model-list")?.addEventListener("click", async () => {
    if (result) result.textContent = bi("fetching models…", "正在获取模型列表…");
    const models = await listModels();
    if (!models.length) {
      if (result) result.textContent = bi("No models returned.", "接口未返回任何模型。");
      return;
    }
    const index = { value: 0 };
    const ok = Services.prompt.select(
      win as any,
      config.addonName,
      bi("Choose a model:", "选择模型："),
      models,
      index,
    );
    if (ok) {
      setPref("lens.model", models[index.value]);
      const input = $<HTMLInputElement>("prism-model-input");
      if (input) input.value = models[index.value];
      if (result) result.textContent = models[index.value];
    }
  });

  const profiles = $<any>("prism-profiles");
  const refreshProfiles = () => {
    if (!profiles) return;
    const popup = profiles.querySelector("menupopup");
    if (!popup) return;
    clear(popup as any);
    for (const profile of listProfiles()) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", `${profile.name} · ${profile.model}`);
      item.setAttribute("value", profile.name);
      popup.append(item);
    }
  };
  refreshProfiles();
  profiles?.addEventListener("command", () => {
    const name = profiles.value;
    if (name && applyProfile(name)) {
      if (result) result.textContent = `${bi("applied", "已应用")} ${name}`;
    }
  });
  $("prism-profile-save")?.addEventListener("click", () => {
    const value = { value: getPref<string>("lens.model", "profile") };
    if (
      Services.prompt.prompt(
        win as any,
        config.addonName,
        bi("Profile name:", "配置名称："),
        value,
        "",
        { value: false },
      )
    ) {
      saveProfile(value.value);
      refreshProfiles();
    }
  });
  $("prism-profile-delete")?.addEventListener("click", () => {
    if (profiles?.value) {
      deleteProfile(profiles.value);
      refreshProfiles();
    }
  });

  /* index */
  const stats = $("prism-index-stats");
  const showStats = async () => {
    const info = await indexStats();
    if (stats) {
      stats.textContent = `${info.items} ${bi("items", "个条目")} · ${info.chunks} ${bi(
        "chunks",
        "个片段",
      )} · ${info.vectors} ${bi("with vectors", "个已向量化")}${
        info.model ? ` · ${info.model}` : ""
      }`;
    }
  };
  void showStats();
  $("prism-index-build")?.addEventListener("click", async () => {
    const items = contextItems();
    if (!items.length) {
      if (stats) stats.textContent = bi("Select items first.", "请先选中条目。");
      return;
    }
    await indexItems(items, {
      force: true,
      onProgress: (progress) => {
        if (stats) {
          stats.textContent = `${progress.done}/${progress.total} — ${progress.item}`;
        }
      },
    });
    await showStats();
  });
  $("prism-index-all")?.addEventListener("click", async () => {
    const all = (await Zotero.Items.getAll(
      Zotero.Libraries.userLibraryID,
      true,
    )) as Zotero.Item[];
    const items = all.filter((item) => item.isRegularItem?.());
    await indexItems(items, {
      onProgress: (progress) => {
        if (stats) {
          stats.textContent = `${progress.done}/${progress.total} — ${progress.item}`;
        }
      },
    });
    await showStats();
  });
  $("prism-index-clear")?.addEventListener("click", async () => {
    await clearIndex();
    await showStats();
  });

  /* bridge */
  const badge = $("prism-bridge-status");
  const refreshBridge = () => {
    if (!badge) return;
    const status = bridgeStatus();
    badge.textContent = status.connected
      ? `${bi("connected", "已连接")} · ${status.target}`
      : bi("not connected", "未连接");
    badge.style.color = status.connected ? "#5fb236" : "";
  };
  refreshBridge();
  const bridgeTimer = win.setInterval(refreshBridge, 4000);
  win.addEventListener(
    "unload",
    () => {
      try {
        win.clearInterval(bridgeTimer);
      } catch {
        /* already torn down */
      }
    },
    { once: true },
  );
  $("prism-bridge-reveal")?.addEventListener("click", async () => {
    const path = await materialiseBridgeExtension();
    if (path) {
      try {
        Zotero.File.reveal(path);
      } catch {
        if (badge) badge.textContent = path;
      }
    }
  });

  /* prompts */
  const list = $("prism-prompt-list");
  const renderPrompts = () => {
    if (!list) return;
    clear(list);
    for (const prompt of loadPrompts()) {
      const row = el(doc, "div", {
        class: "prism-anno",
        style: { borderInlineStartColor: prompt.color || "#999", display: "flex", gap: "8px" },
      });
      row.append(
        el(doc, "div", {
          style: { flex: "1", cursor: "pointer" },
          text: `${prompt.name}${prompt.trigger ? `  /${prompt.trigger}` : ""}  · ${prompt.context}`,
          on: { click: () => editPrompt(win, prompt, renderPrompts) },
        }),
      );
      if (!prompt.builtin) {
        row.append(
          el(doc, "span", {
            text: "✕",
            style: { cursor: "pointer", opacity: "0.6" },
            on: {
              click: () => {
                deletePrompt(prompt.id);
                renderPrompts();
              },
            },
          }),
        );
      }
      list.append(row);
    }
  };
  renderPrompts();
  $("prism-prompt-add")?.addEventListener("click", () =>
    editPrompt(
      win,
      {
        id: `user-${Date.now().toString(36)}`,
        name: bi("New prompt", "新提示词"),
        scope: ["panel"],
        context: "fulltext",
        body: "",
        color: "#2ea8e5",
        order: 500,
      },
      renderPrompts,
    ),
  );
  $("prism-prompt-reset")?.addEventListener("click", () => {
    resetPrompts();
    renderPrompts();
  });
}

function editPrompt(win: Window, prompt: PromptDef, done: () => void) {
  const dialog = new ztoolkit.Dialog(7, 2);
  dialog
    .addCell(0, 0, { tag: "label", properties: { innerHTML: bi("Name", "名称") } })
    .addCell(0, 1, {
      tag: "input",
      attributes: { "data-bind": "name", "data-prop": "value", type: "text" },
      styles: { width: "360px" },
    })
    .addCell(1, 0, { tag: "label", properties: { innerHTML: bi("Trigger", "触发词") } })
    .addCell(1, 1, {
      tag: "input",
      attributes: { "data-bind": "trigger", "data-prop": "value", type: "text" },
    })
    .addCell(2, 0, { tag: "label", properties: { innerHTML: bi("Context", "上下文") } })
    .addCell(2, 1, {
      tag: "input",
      attributes: { "data-bind": "context", "data-prop": "value", type: "text" },
    })
    .addCell(3, 0, { tag: "label", properties: { innerHTML: bi("Shown in", "出现位置") } })
    .addCell(3, 1, {
      tag: "input",
      attributes: { "data-bind": "scope", "data-prop": "value", type: "text" },
    })
    // The chip in the panel is painted with `prompt.color`, and every prompt the
    // user made came out the same blue because the editor had no field for it.
    .addCell(4, 0, { tag: "label", properties: { innerHTML: bi("Colour", "颜色") } })
    .addCell(4, 1, {
      tag: "input",
      attributes: { "data-bind": "color", "data-prop": "value", type: "color" },
      styles: { width: "60px", height: "24px", padding: "0" },
    })
    .addCell(5, 0, { tag: "label", properties: { innerHTML: bi("Prompt", "提示词") } })
    .addCell(5, 1, {
      tag: "textarea",
      attributes: { "data-bind": "body", "data-prop": "value", rows: "14" },
      styles: { width: "520px", fontFamily: "monospace" },
    })
    .addCell(6, 1, {
      tag: "div",
      properties: {
        innerHTML: bi(
          "Use ${P.question}, ${await P.fullText()}, ${P.selection}, ${await P.search(...)} …",
          "可使用 ${P.question}、${await P.fullText()}、${P.selection}、${await P.search(...)} 等变量",
        ),
      },
      styles: { opacity: "0.65", fontSize: "11px" },
    })
    .setDialogData({
      name: prompt.name,
      trigger: prompt.trigger || "",
      context: prompt.context,
      scope: prompt.scope.join(","),
      color: prompt.color || "#2ea8e5",
      body: prompt.body,
    })
    .addButton(bi("Save", "保存"), "save")
    .addButton(bi("Cancel", "取消"), "cancel")
    .open(config.addonName, { width: 720, height: 560, resizable: true });

  void dialog.dialogData.unloadLock?.promise.then(() => {
    if (dialog.dialogData._lastButtonId !== "save") return;
    savePrompt({
      ...prompt,
      name: String(dialog.dialogData.name || prompt.name),
      trigger: String(dialog.dialogData.trigger || "") || undefined,
      context: String(dialog.dialogData.context || "none") as PromptDef["context"],
      scope: String(dialog.dialogData.scope || "panel")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as PromptDef["scope"],
      color: String(dialog.dialogData.color || prompt.color || "#2ea8e5"),
      body: String(dialog.dialogData.body || ""),
      builtin: false,
    });
    done();
  });
  void win;
}

/**
 * Fill a `menulist` and restore its bound preference.
 *
 * Zotero binds `preference="…"` when the pane loads, which is before these
 * popups have any items — so the selection is dropped and the control comes up
 * blank unless the value is applied again afterwards.
 */
function fillMenulist(
  doc: Document,
  list: any,
  entries: Array<{ label: string; value: string }>,
  current: string,
) {
  const popup = list?.querySelector("menupopup");
  if (!popup) return;
  clear(popup as any);
  for (const entry of entries) {
    const item = doc.createXULElement("menuitem");
    item.setAttribute("label", entry.label);
    item.setAttribute("value", entry.value);
    popup.append(item);
  }
  const known = entries.some((entry) => entry.value === current);
  list.value = known ? current : entries[0]?.value || "";
}

function wireTranslate(win: Window, doc: Document, $: Getter) {
  const engineList = $<any>("prism-engine");
  fillMenulist(
    doc,
    engineList,
    ENGINES.map((engine) => ({ label: engine.label, value: engine.id })),
    getPref<string>("refract.engine", "google"),
  );
  fillMenulist(
    doc,
    $<any>("prism-lang"),
    LANGUAGES.map((language) => ({ label: language.label, value: language.code })),
    getPref<string>("refract.targetLang", "zh-CN"),
  );
  // The source language had a default and a reader, but nowhere to set it: an
  // engine that guesses wrong on a mixed-language paper could not be corrected.
  fillMenulist(
    doc,
    $<any>("prism-source-lang"),
    [
      { label: bi("Detect", "自动检测"), value: "auto" },
      ...LANGUAGES.map((language) => ({ label: language.label, value: language.code })),
    ],
    getPref<string>("refract.sourceLang", "auto"),
  );
  // How finely the bilingual note pairs the two languages. The request itself
  // is one per paragraph either way — see alignPairs in refract/fulltext.ts.
  fillMenulist(
    doc,
    $<any>("prism-alignment"),
    [
      { label: bi("Paragraph", "逐段"), value: "paragraph" },
      { label: bi("Sentence", "逐句"), value: "sentence" },
    ],
    getPref<string>("refract.alignment", "paragraph"),
  );

  const keysBox = $("prism-engine-keys");
  const renderKeys = () => {
    if (!keysBox) return;
    clear(keysBox);
    const id = getPref<string>("refract.engine", "google");
    const engine = engineByID(id);
    if (!engine.needsKey?.length) {
      keysBox.append(
        el(doc, "div", {
          class: "prism-stat-label",
          text: bi("No credentials needed.", "无需密钥。"),
        }),
      );
      return;
    }
    const all = getJSONPref<Record<string, Record<string, string>>>(
      "refract.engineKeys",
      {},
    );
    for (const field of engine.needsKey) {
      const row = el(doc, "div", { class: "prism-row" });
      row.append(
        el(doc, "label", { text: fieldLabel(field), style: { width: "120px" } }),
        el(doc, "input", {
          class: "prism-search",
          attrs: { type: "text", value: all[id]?.[field] || "" },
          style: { flex: "1" },
          on: {
            change: (event: Event) => {
              const value = (event.target as HTMLInputElement).value;
              const next = { ...all, [id]: { ...(all[id] || {}), [field]: value } };
              setJSONPref("refract.engineKeys", next);
            },
          },
        }),
      );
      keysBox.append(row);
    }
  };
  renderKeys();
  engineList?.addEventListener("command", () => win.setTimeout(renderKeys, 60));
}

function wireLibrary(win: Window, doc: Document, $: Getter) {
  // Which service is asked first. The others still answer if it fails — see
  // fetchCited — but a user who has an S2 key, or who wants Crossref's numbers
  // rather than OpenAlex's, had no way to say so.
  fillMenulist(
    doc,
    $<any>("prism-cited-source"),
    [
      { label: "Semantic Scholar", value: "semanticscholar" },
      { label: "OpenAlex", value: "openalex" },
      { label: "Crossref", value: "crossref" },
    ],
    getPref<string>("spectrum.citedSource", "semanticscholar"),
  );
  $("prism-colors")?.addEventListener("click", () => void openColorEditor(win));
  $("prism-known-fields")?.addEventListener("click", () => {
    const out = $("prism-fields-out");
    if (out) out.textContent = knownRankFields().join(", ");
  });
  void doc;
}

function wireLab(win: Window, doc: Document, $: Getter) {
  void deckStats().then((stats) => {
    const node = $("prism-deck-stats");
    if (node) {
      node.textContent = `${stats.total} ${bi("cards", "张卡片")} · ${stats.due} ${bi(
        "due",
        "张待复习",
      )} · ${stats.mature} ${bi("mature", "张已掌握")}`;
    }
  });

  const list = $("prism-watch-list");
  const render = () => {
    if (!list) return;
    clear(list);
    const watches = listWatches();
    if (!watches.length) {
      list.append(
        el(doc, "div", {
          class: "prism-chip",
          text: bi("Nothing watched yet.", "暂无追踪项。"),
        }),
      );
      return;
    }
    for (const watch of watches) {
      list.append(
        el(
          doc,
          "div",
          { class: "prism-anno", style: { display: "flex", gap: "8px" } },
          el(doc, "div", {
            style: { flex: "1" },
            text: `${watch.kind} · ${watch.label}`,
          }),
          el(doc, "span", {
            text: "✕",
            style: { cursor: "pointer", opacity: "0.6" },
            on: {
              click: () => {
                removeWatch(watch.id);
                render();
              },
            },
          }),
        ),
      );
    }
  };
  render();
  $("prism-watch-run")?.addEventListener("click", () => void runWatches({ reveal: true }));
  void win;
}

/** Plugin lifecycle. */

import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { getPref } from "./utils/prefs";
import { injectAssets } from "./modules/lens/ui";
import { closePrismTabs, registerTabType, unregisterTabType } from "./modules/spectrum/tabs";

import { registerColumns, unregisterColumns, startTreeDecorator, stopTreeDecorator } from "./modules/spectrum/columns";
import { registerPanes, unregisterPanes } from "./modules/spectrum/panes";
import { registerLensSection } from "./modules/lens/readerPane";
import { installWindowMenus, registerMenus, unregisterMenus } from "./modules/menus";
import { registerShortcuts, unregisterShortcuts } from "./modules/keys";
import {
  registerReaderIntegration,
  unregisterReaderIntegration,
  startReadingClock,
  stopReadingClock,
} from "./modules/reader";
import { flushReading, initReading, noteAnnotationCreated } from "./modules/spectrum/reading";
import { initCitations } from "./modules/spectrum/citations";
import { initRanks } from "./modules/spectrum/ranks";
import { loadColorNames } from "./modules/spectrum/colors";
import { loadCache } from "./modules/refract/engines";
import { registerBridge, unregisterBridge } from "./modules/lens/bridge";
import { initReview, enrol, flushReview } from "./modules/beam/review";
import { initGapRadar } from "./modules/beam/gapRadar";
import { scheduleWatches, stopWatches } from "./modules/beam/watchlist";
import { clearQuickFilter } from "./modules/spectrum/organise";
import { maybeAutoTranslate } from "./modules/refract/metadata";
import { destroyPanel } from "./modules/lens/panel";
import { registerPrefsPane, onPrefsLoad } from "./modules/prefsPane";
import { getItem, toRegularItem } from "./utils/item";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  /* load persisted state before anything renders */
  await Promise.all([
    initReading(),
    initCitations(),
    initRanks(),
    loadCache(),
    initReview(),
    initGapRadar(),
  ]);
  loadColorNames();

  await registerPrefsPane();
  dropStalePrefs();

  if (getPref<boolean>("enableSpectrum", true)) {
    registerColumns();
    registerPanes();
  }
  if (getPref<boolean>("enableLens", true)) {
    registerLensSection();
    // Always listen: the endpoints are inert until a browser add-on connects,
    // and registering lazily meant enabling the pref did nothing until restart.
    registerBridge();
  }
  registerMenus();
  registerReaderIntegration();
  registerNotifier();

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win as any)));
  addon.data.initialized = true;
  Zotero.debug(`[Prism] ${config.addonName} ready`);
}

/**
 * Settings left behind by sections that no longer exist.
 *
 * Zotero remembers whether each item-pane section is open under
 * `panes.<pluginID>-<paneID>.open`, and keeps the entry after the section is
 * gone — a preview pane that was removed still had its state in the profile.
 */
function dropStalePrefs() {
  for (const paneID of ["prism-preview"]) {
    try {
      Zotero.Prefs.clear(`panes.${config.addonID}-${paneID}.open`);
    } catch {
      /* never set, or already gone */
    }
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  (win as any).MozXULElement?.insertFTLIfNeeded?.(`${config.addonRef}-addon.ftl`);

  registerShortcuts();
  // The item tree's own cells are styled by prism.css: without it the heat and
  // annotation sparklines collapse to zero height and the tag pills run
  // together. It used to arrive only as a side effect of an item-pane section
  // rendering, so the columns looked broken until a section happened to open.
  injectAssets(win.document as unknown as Document);
  registerTabType(win as unknown as Window);
  // Menus are per-window XUL, so a second library window needs its own copy.
  installWindowMenus(win as unknown as Window);
  if (getPref<boolean>("enableSpectrum", true)) {
    startTreeDecorator(win as unknown as Window);
  }
  startReadingClock(win as unknown as Window);
  if (getPref<boolean>("enableBeam", true)) {
    scheduleWatches(win as unknown as Window);
  }

  new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
    .createLine({ text: getString("startup-finish"), type: "success" })
    .show(1800);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // Before anything else: a Prism tab left in the saved session makes Zotero's
  // own restore throw on the next launch, taking the rest of the tabs with it.
  closePrismTabs(win);
  unregisterTabType(win);
  stopReadingClock(win);
  stopWatches(win);
  stopTreeDecorator(win);
  destroyPanel(win);
  await flushReading();
  ztoolkit.unregisterAll();
}

async function onShutdown(): Promise<void> {
  addon.data.alive = false;
  try {
    await flushReading();
    await flushReview();
    await clearQuickFilter();
  } catch {
    /* best effort */
  }
  unregisterShortcuts();
  unregisterMenus();
  unregisterColumns();
  unregisterPanes();
  unregisterReaderIntegration();
  unregisterBridge();
  unregisterNotifier();
  for (const win of Zotero.getMainWindows()) {
    stopReadingClock(win as unknown as Window);
    stopTreeDecorator(win as unknown as Window);
      destroyPanel(win as unknown as Window);
  }
  ztoolkit.unregisterAll();
  delete (Zotero as any)[config.addonInstance];
}

/* ------------------------------------------------------------------ notifier */

const observer = {
  notify: async (
    event: string,
    type: string,
    ids: Array<string | number>,
    _extraData: Record<string, any>,
  ) => {
    if (!addon.data.alive) return;
    try {
      if (type === "item" && event === "add") {
        const items = ids
          .map((id) => getItem(id as number))
          .filter(Boolean) as Zotero.Item[];
        const annotations = items.filter((item) => item.isAnnotation?.());
        if (annotations.length) {
          for (const _ of annotations) noteAnnotationCreated();
          if (getPref<boolean>("beam.review", true)) {
            const parents = annotations
              .map((annotation) => toRegularItem(annotation))
              .filter(Boolean) as Zotero.Item[];
            await enrol(parents);
          }
        }
        const regulars = items.filter((item) => item.isRegularItem?.());
        if (regulars.length) await maybeAutoTranslate(regulars);
      }
    } catch (e) {
      Zotero.debug(`[Prism] notifier error: ${e}`);
    }
  },
};

function registerNotifier() {
  const id = Zotero.Notifier.registerObserver(
    observer,
    ["item", "tab"],
    config.addonRef,
  );
  addon.data.notifierIDs.push(id);
  Zotero.Plugins.addObserver({
    shutdown: ({ id: pluginID }: { id: string }) => {
      if (pluginID === config.addonID) unregisterNotifier();
    },
  } as any);
}

function unregisterNotifier() {
  for (const id of addon.data.notifierIDs.splice(0)) {
    try {
      Zotero.Notifier.unregisterObserver(id);
    } catch {
      /* already gone */
    }
  }
}

/* ---------------------------------------------------------------- tab poller */

/* ------------------------------------------------------------------- prefs */

function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") onPrefsLoad(data.window);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};

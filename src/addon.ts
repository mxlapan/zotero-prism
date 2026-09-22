import { config } from "../package.json";
import { DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import type { ChatSession } from "./modules/lens/chat";
import type { LibraryIndex } from "./lib/vector";

/** One continuous stretch of attention on a single PDF page. */
export interface PageHeat {
  /** seconds spent on the page */
  t: number;
  /** annotation characters written while on the page */
  a: number;
}

/** Reading statistics attached to an attachment, keyed by page index. */
export interface ReadingRecord {
  pages: Record<number, PageHeat>;
  /** total seconds */
  total: number;
  /** epoch ms of first and last read */
  first: number;
  last: number;
  /** number of pages in the document, 0 when unknown */
  numPages: number;
}

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: { current: any };
    prefs?: { window: Window };
    prefsPaneID?: string;
    dialog?: DialogHelper;

    /** library visuals & organisation */
    spectrum: {
      columns: string[];
      sections: string[];
      /** attachment key -> reading record */
      reading: Map<string, ReadingRecord>;
      /** live reading clocks, keyed by reader instance id */
      clocks: Map<string, { key: string; page: number; since: number }>;
      /** itemID -> citation payload */
      cited: Map<number, Record<string, number | string>>;
      /** publication name -> rank payload */
      ranks: Map<string, Record<string, string>>;
      /** annotation colour -> human readable name */
      colorNames: Record<string, string>;
      dirty: Set<number>;
      flushTimer?: number;
    };

    /** AI copilot */
    lens: {
      sessions: Map<string, ChatSession>;
      index?: LibraryIndex;
      indexing: boolean;
      bridge: {
        connected: boolean;
        target: string;
        pending: Map<string, (chunk: { text?: string; done?: boolean; error?: string }) => void>;
        lastSeen: number;
      };
      panelState: { x: number; y: number; w: number; h: number; open: boolean };
    };

    /** translation */
    refract: {
      cache: Map<string, string>;
      running: Map<number, { cancel: boolean; done: number; total: number }>;
      overlays: Map<string, any>;
    };

    /** the Prism-only features */
    beam: {
      rhythmTimer?: number;
      watchTimer?: number;
    };

    notifierIDs: string[];
    menuIDs: string[];
  };

  public hooks: typeof hooks;
  public api: Record<string, any>;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      spectrum: {
        columns: [],
        sections: [],
        reading: new Map(),
        clocks: new Map(),
        cited: new Map(),
        ranks: new Map(),
        colorNames: {},
        dirty: new Set(),
      },
      lens: {
        sessions: new Map(),
        indexing: false,
        bridge: { connected: false, target: "", pending: new Map(), lastSeen: 0 },
        panelState: { x: -1, y: -1, w: 460, h: 520, open: false },
      },
      refract: { cache: new Map(), running: new Map(), overlays: new Map() },
      beam: {},
      notifierIDs: [],
      menuIDs: [],
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;

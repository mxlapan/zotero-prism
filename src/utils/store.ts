/**
 * Persistence.
 *
 * Two tiers:
 *  - `JSONStore` writes to `<data dir>/prism/<name>.json`. Local, unlimited in
 *    practice, used for anything bulky (reading clocks, vectors, caches).
 *  - `synced` uses `Zotero.SyncedSettings`, which rides along with Zotero's own
 *    sync, and is used for the handful of small settings a user expects to
 *    follow them between machines.
 */

const DIR = "prism";

async function storeDir(): Promise<string> {
  const dir = PathUtils.join(Zotero.DataDirectory.dir, DIR);
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  return dir;
}

export async function storePath(name: string): Promise<string> {
  return PathUtils.join(await storeDir(), `${name}.json`);
}

export class JSONStore<T extends object> {
  private data: T;
  private loaded = false;
  private timer?: number;
  private saving?: Promise<void>;

  constructor(
    private name: string,
    private fallback: T,
  ) {
    this.data = fallback;
  }

  async load(): Promise<T> {
    if (this.loaded) return this.data;
    try {
      const path = await storePath(this.name);
      if (await IOUtils.exists(path)) {
        const parsed = await IOUtils.readJSON(path);
        if (parsed && typeof parsed === "object") {
          this.data = parsed as T;
        }
      }
    } catch (e) {
      Zotero.debug(`[Prism] store ${this.name} failed to load: ${e}`);
    }
    this.loaded = true;
    return this.data;
  }

  get(): T {
    return this.data;
  }

  set(value: T) {
    this.data = value;
    this.schedule();
  }

  /** Coalesce bursts of writes into one disk hit. */
  schedule(delayMS = 4000) {
    if (this.timer) {
      try {
        Zotero.getMainWindow()?.clearTimeout(this.timer);
      } catch {
        /* window gone */
      }
    }
    const win = Zotero.getMainWindow();
    if (!win) {
      void this.flush();
      return;
    }
    this.timer = win.setTimeout(() => void this.flush(), delayMS);
  }

  async flush(): Promise<void> {
    if (this.saving) await this.saving;
    this.saving = (async () => {
      try {
        const path = await storePath(this.name);
        await IOUtils.writeJSON(path, this.data, { tmpPath: `${path}.tmp` });
      } catch (e) {
        Zotero.debug(`[Prism] store ${this.name} failed to save: ${e}`);
      }
    })();
    await this.saving;
    this.saving = undefined;
  }
}

/** Small, syncing key/value settings stored per library. */
export const synced = {
  get<T>(key: string, def: T, libraryID = Zotero.Libraries.userLibraryID): T {
    try {
      const value = (Zotero as any).SyncedSettings.get(libraryID, `prism_${key}`);
      return value === undefined || value === null ? def : (value as T);
    } catch {
      return def;
    }
  },
  async set(
    key: string,
    value: unknown,
    libraryID = Zotero.Libraries.userLibraryID,
  ) {
    try {
      await (Zotero as any).SyncedSettings.set(libraryID, `prism_${key}`, value);
    } catch (e) {
      Zotero.debug(`[Prism] synced setting ${key} failed: ${e}`);
    }
  },
};

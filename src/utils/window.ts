export { isWindowAlive };

const pendingTimers = new Set<any>();

/**
 * Pause.
 *
 * The plugin sandbox has no `setTimeout` of its own, so this borrows the main
 * window's, and falls back to a retained nsITimer for the window-less case
 * (shutdown, a background job outliving the last window).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const win = Zotero.getMainWindow();
    if (win && !win.closed) {
      win.setTimeout(resolve, ms);
      return;
    }
    try {
      const timer = Components.classes["@mozilla.org/timer;1"].createInstance(
        Components.interfaces.nsITimer,
      );
      pendingTimers.add(timer);
      timer.initWithCallback(
        {
          notify: () => {
            pendingTimers.delete(timer);
            resolve();
          },
        },
        ms,
        Components.interfaces.nsITimer.TYPE_ONE_SHOT,
      );
    } catch {
      resolve();
    }
  });
}

function isWindowAlive(win?: Window | null): boolean {
  try {
    return !!win && !Components.utils.isDeadWrapper(win) && !win.closed;
  } catch {
    return false;
  }
}

/** Every main Zotero window plus every standalone reader window. */
export function allWindows(): Window[] {
  const wins: Window[] = [];
  for (const win of Zotero.getMainWindows()) {
    if (isWindowAlive(win)) wins.push(win as unknown as Window);
  }
  return wins;
}

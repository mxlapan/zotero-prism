/**
 * Progress windows that always go away.
 *
 * `show(-1)` keeps a window up until something calls `startCloseTimer`, and a
 * failure path that returns early never does — which leaves an error toast
 * pinned over the library with no way to dismiss it. Every long-running window
 * Prism opens now arms a fallback close from the start and can be clicked
 * away; callers shorten the timer when the work actually finishes.
 */

import { config } from "../../package.json";

/** Long enough for slow work to finish, short enough not to feel stuck. */
const FALLBACK_MS = 120_000;

export function openProgress(
  text: string,
  options: { progress?: number; type?: string } = {},
): any {
  const window = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
  })
    .createLine({
      text,
      type: options.type ?? "default",
      progress: options.progress ?? 0,
    })
    .show(-1);
  try {
    window.startCloseTimer(FALLBACK_MS);
  } catch {
    /* older ProgressWindow; closeOnClick still dismisses it */
  }
  return window;
}

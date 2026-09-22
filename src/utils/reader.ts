/**
 * Getting at the PDF viewer.
 *
 * Zotero 7 rebuilt the reader: `reader._iframeWindow` is now the reader shell
 * (reader.html), and PDF.js lives one level further down, in the view's own
 * iframe. Reaching for `PDFViewerApplication` on the shell — the Zotero 6
 * recipe still found in older plugins — silently returns undefined, which is
 * why every path that needs page geometry goes through here instead.
 */

export interface PDFApp {
  pdfViewer?: any;
  pdfDocument?: any;
  pdfLoadingTask?: any;
  eventBus?: any;
  [key: string]: any;
}

/**
 * Step across the compartment boundary into the reader's own scope.
 *
 * Zotero 10 loads the PDF viewer unprivileged, so anything handed back from it
 * arrives wrapped: properties read fine, but methods are invisible and calls
 * fail with "… is not a function".
 */
export function unwrap(win: any): any {
  if (!win) return null;
  try {
    return win.wrappedJSObject || win;
  } catch {
    return win;
  }
}

/**
 * An options object PDF.js can actually read.
 *
 * The boundary only blocks this direction: an object literal built here reaches
 * the viewer as an opaque wrapper, so `getViewport({ scale })` came back sized
 * NaN and `render({ canvasContext })` threw. Building it from the viewer's own
 * `Object` makes it native there; assigning properties onto it from this side
 * is allowed.
 */
export function contentObject(
  win: any,
  props: Record<string, unknown>,
): any {
  try {
    const target = new win.Object();
    for (const [key, value] of Object.entries(props)) target[key] = value;
    return target;
  } catch {
    return props;
  }
}

/** The window PDF.js actually runs in, or null for non-PDF attachments. */
export function pdfWindow(reader: any): any {
  if (!reader) return null;
  const internal = reader._internalReader;
  for (const view of [internal?._primaryView, internal?._lastView]) {
    const win = unwrap(view?._iframeWindow);
    if (win?.PDFViewerApplication) return win;
  }
  // Zotero 6 and early 7 betas exposed it on the shell window.
  const shell = unwrap(reader._iframeWindow);
  if (shell?.PDFViewerApplication) return shell;
  // Last resort: walk the shell's child frames.
  try {
    const frames = reader._iframeWindow?.frames;
    for (let i = 0; i < (frames?.length || 0); i++) {
      const child = unwrap(frames[i]);
      if (child?.PDFViewerApplication) return child;
    }
  } catch {
    /* cross-origin or torn down */
  }
  return null;
}

export function pdfApp(reader: any): PDFApp | null {
  return pdfWindow(reader)?.PDFViewerApplication ?? null;
}

/** The document holding the rendered `.page` elements. */
export function pdfDocument(reader: any): Document | null {
  const win = pdfWindow(reader);
  return win?.document ?? null;
}

/** Wait until pages exist, so callers never race the viewer's first render. */
export async function pdfReady(reader: any): Promise<PDFApp | null> {
  const app = pdfApp(reader);
  if (!app) return null;
  try {
    await app.pdfLoadingTask?.promise;
    await app.pdfViewer?.pagesPromise;
  } catch {
    /* already loaded, or loading failed */
  }
  return app;
}

/** 0-based index of the page the user is looking at. */
export function currentPageIndex(reader: any): number {
  try {
    const app = pdfApp(reader);
    const number = app?.pdfViewer?.currentPageNumber;
    if (typeof number === "number" && number > 0) return number - 1;
  } catch {
    /* fall through */
  }
  // The reader keeps its own state even when PDF.js is not reachable
  // (EPUB, snapshot, or a view that has not rendered yet).
  try {
    const state = reader?._internalReader?._state?.primaryViewState;
    if (typeof state?.pageIndex === "number") return state.pageIndex;
    const page = reader?.state?.pageIndex;
    if (typeof page === "number") return page;
  } catch {
    /* ignore */
  }
  return 0;
}

export function pageCount(reader: any): number {
  try {
    return Number(pdfApp(reader)?.pdfDocument?.numPages) || 0;
  } catch {
    return 0;
  }
}

/** The rendered page views currently in the DOM. */
export function pageViews(reader: any): any[] {
  try {
    return pdfApp(reader)?.pdfViewer?._pages || [];
  } catch {
    return [];
  }
}

/**
 * The text of one page, from whichever object happens to carry it.
 *
 * `pdfDocument.getPage()` is the documented route, but on at least one Zotero
 * build the object it hands back has no `getTextContent` — the page proxy is
 * reached through the rendered page view instead, and the documented route
 * fails with "getTextContent is not a function". Trying both costs nothing and
 * survives whichever PDF.js Zotero ships.
 */
export async function pageText(
  reader: any,
  viewer: PDFApp | null,
  index: number,
): Promise<{ items: any[]; width: number; height: number } | null> {
  const candidates: any[] = [];
  try {
    const page = await viewer?.pdfDocument?.getPage?.(index + 1);
    if (page) candidates.push(page);
  } catch (e) {
    Zotero.debug(`[Prism] getPage(${index + 1}) failed: ${e}`);
  }
  const view = pageViews(reader)[index];
  if (view) candidates.push(view.pdfPage, view);

  for (const candidate of candidates) {
    const source =
      typeof candidate?.getTextContent === "function"
        ? candidate
        : typeof candidate?.pdfPage?.getTextContent === "function"
          ? candidate.pdfPage
          : null;
    if (!source) continue;
    try {
      const content = await source.getTextContent();
      return {
        items: content?.items || [],
        width: pageWidth(source, view),
        height: pageHeight(source, view),
      };
    } catch (e) {
      Zotero.debug(`[Prism] getTextContent(${index + 1}) failed: ${e}`);
    }
  }
  Zotero.debug(
    `[Prism] no text source for page ${index + 1}; tried ${candidates.length} candidate(s)`,
  );
  return null;
}

/** Page height in PDF units, for spotting running heads and imprints. */
function pageHeight(source: any, view: any): number {
  const box = source?.view;
  if (Array.isArray(box) && box.length >= 4) return box[3] - box[1];
  const viewport = view?.viewport || source?.viewport;
  if (viewport?.height) return viewport.height / (viewport.scale || 1);
  return 792; // US Letter
}

/** Page width in PDF units, for the column maths in the layout pass. */
function pageWidth(source: any, view: any): number {
  const box = source?.view;
  if (Array.isArray(box) && box.length >= 4) return box[2] - box[0];
  const viewport = view?.viewport || source?.viewport;
  if (viewport?.width) return viewport.width / (viewport.scale || 1);
  try {
    // Built in the viewer's own scope: an object literal from this side reaches
    // PDF.js empty, and getViewport then reports a NaN-wide page.
    const win = view?.div?.ownerDocument?.defaultView;
    const width = source.getViewport(contentObject(win, { scale: 1 }))?.width;
    if (Number.isFinite(width)) return width;
  } catch {
    /* fall through to the default */
  }
  return 612; // US Letter, the least surprising default
}

/**
 * A resizable, movable annotation popup.
 *
 * Zotero's annotation popup — the box beside a highlight that shows and edits
 * its comment — is 240px wide, caps the comment at about ten lines and stays
 * where the reader put it, so a long comment such as an AI explanation ends
 * up in a narrow scroll box. The reader gives plugins no hook into this popup,
 * so it is picked up from the reader's document as it appears and given a
 * resize grip in its bottom-right corner and a drag bar along its top edge.
 * The size is kept for next time; a move lasts until the popup is opened for
 * another annotation. Everything here keys off Zotero's own class names and
 * does nothing if they change.
 */

import { getPref, setPref } from "../utils/prefs";
import { bi } from "../utils/locale";

export const ANNOTATION_POPUP_CSS = `
.annotation-popup[data-prism-ap] .comment .content { max-height:var(--prism-ap-h, 168px); }
.annotation-popup[data-prism-moved]::before, .annotation-popup[data-prism-moved]::after { display:none; }
.prism-ap-move {
  position:absolute; top:3px; left:50%; width:36px; height:5px; margin-left:-18px;
  border-radius:3px; background:currentColor; opacity:.25; cursor:move; z-index:2;
}
.prism-ap-move:hover { opacity:.55; }
.prism-ap-grip {
  position:absolute; right:2px; bottom:2px; width:14px; height:14px; cursor:nwse-resize; opacity:.45; z-index:2;
  background:linear-gradient(135deg, transparent 0 52%, currentColor 52% 58%, transparent 58% 72%,
    currentColor 72% 78%, transparent 78%);
}
.prism-ap-grip:hover { opacity:.9; }
`;

/** Marks a reader document as watched by this instance of the plugin. */
const WATCHED = Math.random().toString(36).slice(2);

/** Watch one reader's document for its annotation popup. Safe to call repeatedly. */
export function watchAnnotationPopups(reader: any, doc: Document) {
  const root = doc.documentElement as HTMLElement | null;
  const win = doc.defaultView as any;
  if (!root || !win || root.dataset.prismAp === WATCHED) return;
  root.dataset.prismAp = WATCHED;
  const observer = new win.MutationObserver(() => {
    const popup = doc.querySelector(".annotation-popup:not([data-prism-ap])") as HTMLElement | null;
    if (popup) enhance(reader, popup);
  });
  observer.observe(doc.body || root, { childList: true, subtree: true });
}

function enhance(reader: any, popup: HTMLElement) {
  const doc = popup.ownerDocument;
  const win = doc.defaultView!;
  popup.dataset.prismAp = "1";

  const width = Number(getPref("lens.annotationPopupWidth", 0)) || 0;
  const height = Number(getPref("lens.annotationPopupHeight", 0)) || 0;
  if (width) popup.style.width = `${width}px`;
  if (height) popup.style.setProperty("--prism-ap-h", `${height}px`);

  const mover = doc.createElement("div");
  mover.className = "prism-ap-move";
  mover.title = bi("Drag to move", "拖动移动");
  const grip = doc.createElement("div");
  grip.className = "prism-ap-grip";
  grip.title = bi("Drag to resize", "拖动调整大小");
  popup.append(mover, grip);

  const frame = frameOf(reader, popup);

  mover.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) return;
    const from = { ...frame.offset };
    dragPointer(event, "move", (dx, dy) => frame.moveTo(from.x + dx, from.y + dy), () => frame.settle());
  });

  grip.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) return;
    const content = popup.querySelector(".comment .content") as HTMLElement | null;
    // The computed width, not offsetWidth: written back as style.width it then
    // means the same box whatever the popup's box-sizing and padding.
    const w0 = parseFloat(win.getComputedStyle(popup)?.width || "") || popup.offsetWidth;
    const h0 = parseFloat(win.getComputedStyle(content || popup)?.maxHeight || "") || 168;
    dragPointer(
      event,
      "nwse-resize",
      (dx, dy) => {
        popup.style.width = `${Math.round(Math.min(win.innerWidth * 0.9, Math.max(240, w0 + dx)))}px`;
        popup.style.setProperty(
          "--prism-ap-h",
          `${Math.round(Math.min(win.innerHeight * 0.8, Math.max(80, h0 + dy)))}px`,
        );
        frame.settle();
      },
      () => {
        setPref("lens.annotationPopupWidth", Math.round(parseFloat(popup.style.width) || 0));
        setPref("lens.annotationPopupHeight", parseInt(popup.style.getPropertyValue("--prism-ap-h")) || 0);
      },
    );
  });
}

/**
 * Follow one pointer drag. A transparent sheet covers the reader while the
 * button is down, so the pointer is not lost to the PDF frame beneath. Pointer
 * events, not mouse events: the reader cancels the press, and with it every
 * mouse event until the button is released.
 */
function dragPointer(
  start: PointerEvent,
  cursor: string,
  onMove: (dx: number, dy: number) => void,
  onEnd: () => void,
) {
  const doc = (start.target as Node).ownerDocument!;
  const sheet = doc.createElement("div");
  sheet.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${cursor};background:transparent`;
  (doc.body || doc.documentElement).append(sheet);
  const move = (event: PointerEvent) => onMove(event.clientX - start.clientX, event.clientY - start.clientY);
  const end = () => {
    sheet.remove();
    doc.removeEventListener("pointermove", move, true);
    doc.removeEventListener("pointerup", end, true);
    doc.removeEventListener("pointercancel", end, true);
    onEnd();
  };
  doc.addEventListener("pointermove", move, true);
  doc.addEventListener("pointerup", end, true);
  doc.addEventListener("pointercancel", end, true);
  start.preventDefault();
  start.stopPropagation();
}

interface Frame {
  offset: { x: number; y: number };
  moveTo(x: number, y: number): void;
  settle(): void;
}

/**
 * The user's offset, laid over Zotero's placement. Zotero positions the popup
 * with a transform when it opens and again as the page scrolls; the offset is
 * re-added whenever it does, so a moved popup stays moved while it follows the
 * page. It is dropped when the popup is shown for a different annotation.
 */
function frameOf(reader: any, popup: HTMLElement): Frame {
  const parse = (value: string) => {
    const at = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(value || "");
    return at ? { x: Number(at[1]), y: Number(at[2]) } : null;
  };
  const annotationID = () => {
    try {
      const state = reader?._internalReader?._state;
      return String(
        state?.primaryViewAnnotationPopup?.annotation?.id ??
          state?.secondaryViewAnnotationPopup?.annotation?.id ??
          "",
      );
    } catch {
      return "";
    }
  };

  const offset = { x: 0, y: 0 };
  let base = parse(popup.style.transform);
  let applied = "";
  let shownFor = annotationID();

  const apply = () => {
    if (!base) base = parse(popup.style.transform);
    if (!base) return;
    applied = `translate(${base.x + offset.x}px, ${base.y + offset.y}px)`;
    popup.style.transform = applied;
    if (offset.x || offset.y) popup.dataset.prismMoved = "1";
    else delete popup.dataset.prismMoved;
  };
  const settle = () => {
    apply();
    const area = popup.parentElement?.getBoundingClientRect();
    if (!area || !base) return;
    const box = popup.getBoundingClientRect();
    const pad = 8;
    let dx = 0;
    let dy = 0;
    if (box.right > area.right - pad) dx = area.right - pad - box.right;
    if (box.left + dx < area.left + pad) dx = area.left + pad - box.left;
    if (box.bottom > area.bottom - pad) dy = area.bottom - pad - box.bottom;
    if (box.top + dy < area.top + pad) dy = area.top + pad - box.top;
    if (!dx && !dy) return;
    offset.x += dx;
    offset.y += dy;
    apply();
  };

  const win = popup.ownerDocument.defaultView as any;
  const observer = new win.MutationObserver(() => {
    if (!popup.isConnected) {
      observer.disconnect();
      return;
    }
    if (popup.style.transform === applied) return;
    const next = parse(popup.style.transform);
    if (!next) return;
    base = next;
    const now = annotationID();
    if (now !== shownFor) {
      shownFor = now;
      offset.x = 0;
      offset.y = 0;
    }
    apply();
  });
  observer.observe(popup, { attributes: true, attributeFilter: ["style"] });

  return {
    offset,
    moveTo(x, y) {
      offset.x = x;
      offset.y = y;
      apply();
    },
    settle,
  };
}

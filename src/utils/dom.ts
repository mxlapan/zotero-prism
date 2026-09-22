/**
 * A tiny hyperscript helper.
 *
 * Prism builds most of its UI by hand (floating panel, reader sidebar,
 * annotation manager) and needs something that works identically in a XUL
 * document, an item-pane section body and a reader iframe.
 */

type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  id?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  text?: string;
  html?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  props?: Record<string, any>;
  on?: Record<string, (event: any) => void>;
  children?: Child[];
}

/**
 * `innerHTML` that also works in Zotero's XHTML windows. There the string is
 * parsed as XML and anything not well-formed — a model's stray `<br>` or
 * `&nbsp;` — throws, so fall back to parsing it as HTML and moving the nodes.
 */
export function setHTML(node: Element, html: string) {
  try {
    node.innerHTML = html;
  } catch {
    const doc = node.ownerDocument;
    const parsed = new doc.defaultView!.DOMParser().parseFromString(
      `<!DOCTYPE html><body>${html}</body>`,
      "text/html",
    );
    const nodes: Node[] = [];
    for (const child of Array.from(parsed.body.childNodes) as Node[]) {
      nodes.push(doc.importNode(child, true));
    }
    node.replaceChildren(...nodes);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props?: ElProps,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function el(
  doc: Document,
  tag: string,
  props?: ElProps,
  ...children: Child[]
): HTMLElement;
export function el(
  doc: Document,
  tag: string,
  props: ElProps = {},
  ...children: Child[]
): HTMLElement {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (props.class) node.setAttribute("class", props.class);
  if (props.id) node.id = props.id;
  if (props.title) node.setAttribute("title", props.title);
  if (typeof props.style === "string") node.setAttribute("style", props.style);
  else if (props.style) Object.assign(node.style, props.style);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) setHTML(node, props.html);
  for (const [k, v] of Object.entries(props.attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const [k, v] of Object.entries(props.props || {})) {
    (node as any)[k] = v;
  }
  for (const [type, handler] of Object.entries(props.on || {})) {
    node.addEventListener(type, handler as EventListener);
  }
  for (const child of [...(props.children || []), ...children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? doc.createTextNode(child) : child);
  }
  return node;
}

export function xul(
  doc: Document,
  tag: string,
  props: ElProps = {},
  ...children: Child[]
): Element {
  const node = doc.createXULElement
    ? doc.createXULElement(tag)
    : doc.createElementNS(
        "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
        tag,
      );
  if (props.class) node.setAttribute("class", props.class);
  if (props.id) node.id = props.id;
  for (const [k, v] of Object.entries(props.attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const [type, handler] of Object.entries(props.on || {})) {
    node.addEventListener(type, handler as EventListener);
  }
  for (const child of [...(props.children || []), ...children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? doc.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element) {
  while (node.firstChild) node.firstChild.remove();
}

/** Inject a `<style>` block once per document. */
export function injectStyle(doc: Document, id: string, css: string) {
  if (doc.getElementById(id)) return;
  const style = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "style",
  ) as HTMLStyleElement;
  style.id = id;
  style.textContent = css;
  (doc.head || doc.documentElement).append(style);
}

/** Inject a stylesheet link once per document. */
export function injectStylesheet(doc: Document, id: string, href: string) {
  if (doc.getElementById(id)) return;
  const link = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  ) as HTMLLinkElement;
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  (doc.head || doc.documentElement).append(link);
}

/**
 * Track one mouse drag that started on `from`.
 *
 * While the button is down a transparent sheet covers the whole window. Without
 * it, moving over the reader (a separate document in an iframe) stops the
 * mousemove events reaching this one, so a panel could be shrunk but never
 * enlarged, and a drag stuck until the pointer came back.
 */
function trackDrag(
  from: MouseEvent,
  cursor: string,
  onMove: (dx: number, dy: number) => void,
  onEnd: () => void,
) {
  const doc = (from.target as Node).ownerDocument!;
  const win = doc.defaultView!;
  const sheet = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  sheet.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${cursor};background:transparent`;
  (doc.body || doc.documentElement).append(sheet);
  const move = (e: MouseEvent) => onMove(e.clientX - from.clientX, e.clientY - from.clientY);
  const end = () => {
    sheet.remove();
    doc.removeEventListener("mousemove", move, true);
    doc.removeEventListener("mouseup", end, true);
    win.removeEventListener("blur", end);
    onEnd();
  };
  doc.addEventListener("mousemove", move, true);
  doc.addEventListener("mouseup", end, true);
  win.addEventListener("blur", end);
  from.preventDefault();
  from.stopPropagation();
}

/** Make `handle` drag `target` around its window. */
export function makeDraggable(
  handle: HTMLElement,
  target: HTMLElement,
  onEnd?: (x: number, y: number) => void,
) {
  handle.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) return;
    // Buttons living in the drag handle should stay clickable.
    if ((e.target as HTMLElement)?.closest?.("button, input, select, textarea")) {
      return;
    }
    const rect = target.getBoundingClientRect();
    trackDrag(
      e,
      "grabbing",
      (dx, dy) => {
        target.style.left = `${Math.max(0, rect.left + dx)}px`;
        target.style.top = `${Math.max(0, rect.top + dy)}px`;
      },
      () => onEnd?.(parseInt(target.style.left) || 0, parseInt(target.style.top) || 0),
    );
  });
}

/**
 * Resize `target` from a grip in one of its bottom corners. A left grip moves
 * the left edge, which is the only way to widen a panel parked at the right
 * edge of the window.
 */
export function makeResizable(
  target: HTMLElement,
  grip: HTMLElement,
  onEnd?: (w: number, h: number, x: number, y: number) => void,
  corner: "left" | "right" = "right",
) {
  const minW = 300;
  const minH = 220;
  grip.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) return;
    const rect = target.getBoundingClientRect();
    trackDrag(
      e,
      corner === "right" ? "nwse-resize" : "nesw-resize",
      (dx, dy) => {
        target.style.height = `${Math.max(minH, rect.height + dy)}px`;
        if (corner === "right") {
          target.style.width = `${Math.max(minW, rect.width + dx)}px`;
        } else {
          const width = Math.max(minW, rect.width - dx);
          target.style.width = `${width}px`;
          target.style.left = `${Math.max(0, rect.right - width)}px`;
        }
      },
      () => {
        const now = target.getBoundingClientRect();
        onEnd?.(Math.round(now.width), Math.round(now.height), Math.round(now.left), Math.round(now.top));
      },
    );
  });
}

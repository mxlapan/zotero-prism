/**
 * A small force-directed graph on a canvas.
 *
 * Written by hand rather than pulled from d3 so the plugin ships one file
 * instead of a layout library, and so the simulation can be paused the moment
 * the tab loses focus.
 */

export interface GraphNode {
  id: string;
  label: string;
  group?: string;
  weight?: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
  data?: any;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight?: number;
  kind?: string;
}

export interface GraphOptions {
  charge?: number;
  linkDistance?: number;
  linkStrength?: number;
  gravity?: number;
  damping?: number;
  onSelect?: (node: GraphNode) => void;
  onHover?: (node: GraphNode | null, x: number, y: number) => void;
  colorOf?: (node: GraphNode) => string;
}

/**
 * Links between items that share tags, weighted by how telling the tags are.
 *
 * A tag on a large share of the library — a reading-status tag like "#读完",
 * an imported "Humans" — says nothing about two papers belonging together.
 * Linking every pair of its items made one clique of the whole graph: 15
 * papers, 38 links, everything pulled into one knot in the middle.
 */
export function tagLinks(
  tagsByItem: Map<number, string[]>,
  total: number,
): Array<{ a: number; b: number; weight: number }> {
  const byTag = new Map<string, number[]>();
  for (const [id, tags] of tagsByItem) {
    for (const tag of new Set(tags)) {
      const list = byTag.get(tag) || [];
      list.push(id);
      byTag.set(tag, list);
    }
  }
  const common = Math.min(25, Math.max(3, Math.ceil(total * 0.3)));
  const strength = new Map<string, number>();
  for (const list of byTag.values()) {
    if (list.length < 2 || list.length > common) continue;
    // the rarer the tag, the more it says
    const share = 1 / Math.log2(list.length + 1);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = Math.min(list[i], list[j]);
        const b = Math.max(list[i], list[j]);
        strength.set(`${a}-${b}`, (strength.get(`${a}-${b}`) || 0) + share);
      }
    }
  }
  return [...strength].map(([key, value]) => {
    const [a, b] = key.split("-").map(Number);
    return { a, b, weight: Math.min(1.6, 0.4 + value) };
  });
}

export class ForceGraph {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  private index = new Map<string, GraphNode>();
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private alpha = 1;
  private fitted = false;
  private readonly userTuned: boolean;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dragging: GraphNode | null = null;
  private panning = false;
  private lastPointer = { x: 0, y: 0 };
  private highlight = new Set<string>();
  private options: Required<Pick<GraphOptions, "charge" | "linkDistance" | "linkStrength" | "gravity" | "damping">> &
    GraphOptions;

  constructor(
    private canvas: HTMLCanvasElement,
    options: GraphOptions = {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    // An explicit charge or distance from the caller wins over the automatic
    // scaling below.
    this.userTuned =
      options.charge !== undefined ||
      options.linkDistance !== undefined ||
      options.gravity !== undefined;
    this.options = {
      charge: -260,
      linkDistance: 70,
      linkStrength: 0.08,
      gravity: 0.015,
      damping: 0.86,
      ...options,
    };
    this.bind();
  }

  setData(nodes: Omit<GraphNode, "x" | "y" | "vx" | "vy">[], edges: GraphEdge[]) {
    const width = this.canvas.width || 800;
    const height = this.canvas.height || 600;
    this.nodes = nodes.map((node, index) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
      const radius = Math.min(width, height) * 0.32;
      return {
        ...node,
        x: width / 2 + Math.cos(angle) * radius * (0.6 + Math.random() * 0.5),
        y: height / 2 + Math.sin(angle) * radius * (0.6 + Math.random() * 0.5),
        vx: 0,
        vy: 0,
      };
    });
    this.index = new Map(this.nodes.map((node) => [node.id, node]));
    this.edges = edges.filter(
      (edge) => this.index.has(edge.source) && this.index.has(edge.target),
    );
    this.scaleForces(this.nodes.length);
    this.alpha = 1;
    this.fitted = false;
    this.start();
  }

  /**
   * Spread the layout according to how much of it there is.
   *
   * The constants were tuned on a few dozen nodes. Repulsion falls off as 1/d²
   * while the centring pull grows with distance, so at library scale — 161
   * nodes and up — every node collapsed into one unreadable blob in the middle
   * of an otherwise empty canvas. Both terms are rescaled instead.
   */
  private scaleForces(count: number) {
    if (this.userTuned) return;
    const size = Math.max(1, count / 40);
    this.options.charge = -260 * size;
    this.options.linkDistance = 70 * Math.min(2.2, Math.sqrt(size));
    this.options.gravity = 0.015 / Math.sqrt(size);
  }

  /**
   * Once the simulation has cooled, frame what it produced.
   *
   * Without this the view stays at 1:1 around the origin, so a graph that
   * settles wider or narrower than the canvas is either clipped or lost in
   * whitespace.
   */
  private fit() {
    if (!this.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of this.nodes) {
      minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
    }
    const pad = 60;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = Math.min(
      (this.canvas.width - pad * 2) / width,
      (this.canvas.height - pad * 2) / height,
    );
    // Nodes and labels keep their size on screen (see draw), so zooming in on
    // a small library spreads it out rather than blowing it up; the old 2.5
    // cap left 15 papers huddled in the middle of an empty tab.
    this.scale = Math.max(0.2, Math.min(6, scale));
    this.offsetX = this.canvas.width / 2 - ((minX + maxX) / 2) * this.scale;
    this.offsetY = this.canvas.height / 2 - ((minY + maxY) / 2) * this.scale;
  }

  setHighlight(ids: string[]) {
    this.highlight = new Set(ids);
    this.draw();
  }

  focus(id: string) {
    const node = this.index.get(id);
    if (!node) return;
    this.offsetX = this.canvas.width / 2 - node.x * this.scale;
    this.offsetY = this.canvas.height / 2 - node.y * this.scale;
    this.highlight = new Set([id]);
    this.draw();
  }

  start() {
    this.stop();
    const step = () => {
      this.tick();
      if (this.alpha <= 0.005 && !this.fitted) {
        this.fitted = true;
        this.fit();
      }
      this.draw();
      if (this.alpha > 0.005) this.raf = this.canvas.ownerDocument.defaultView!.requestAnimationFrame(step);
    };
    this.raf = this.canvas.ownerDocument.defaultView!.requestAnimationFrame(step);
  }

  stop() {
    if (this.raf) {
      this.canvas.ownerDocument.defaultView?.cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private tick() {
    const { charge, linkDistance, linkStrength, gravity, damping } = this.options;
    const centreX = this.canvas.width / 2;
    const centreY = this.canvas.height / 2;
    const nodes = this.nodes;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          distanceSquared = 0.01;
        }
        if (distanceSquared > 640_000) continue;
        const force = (charge * this.alpha) / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const edge of this.edges) {
      const a = this.index.get(edge.source)!;
      const b = this.index.get(edge.target)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = linkDistance / Math.max(0.6, edge.weight || 1);
      const force = (distance - target) * linkStrength * this.alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const node of nodes) {
      if (node.fixed) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx += (centreX - node.x) * gravity * this.alpha;
      node.vy += (centreY - node.y) * gravity * this.alpha;
      node.vx *= damping;
      node.vy *= damping;
      node.x += Math.max(-20, Math.min(20, node.vx));
      node.y += Math.max(-20, Math.min(20, node.vy));
    }
    this.alpha *= 0.985;
  }

  draw() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    ctx.lineWidth = 1 / this.scale;
    for (const edge of this.edges) {
      const a = this.index.get(edge.source)!;
      const b = this.index.get(edge.target)!;
      const lit =
        !this.highlight.size ||
        this.highlight.has(edge.source) ||
        this.highlight.has(edge.target);
      ctx.strokeStyle = lit
        ? edge.kind === "cite"
          ? "rgba(214,77,77,.42)"
          : "rgba(128,140,160,.30)"
        : "rgba(128,140,160,.07)";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const labelled: GraphNode[] = [];
    for (const node of this.nodes) {
      const radius = this.radiusOf(node) / Math.max(1, this.scale);
      const lit = !this.highlight.size || this.highlight.has(node.id);
      ctx.globalAlpha = lit ? 1 : 0.22;
      ctx.fillStyle = this.options.colorOf?.(node) || "#2ea8e5";
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (this.scale > 0.7 && (lit || this.scale > 1.4)) labelled.push(node);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    this.drawLabels(labelled);
  }

  private radiusOf(node: GraphNode) {
    return 4 + Math.sqrt(node.weight || 1) * 2.2;
  }

  /**
   * Labels in screen space at a fixed 11px, placed greedily: highlighted and
   * heavier nodes first, and a label that would overlap one already drawn is
   * left out rather than printed on top of it.
   */
  private drawLabels(nodes: GraphNode[]) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(120,126,136,.95)";
    const placed: Array<[number, number, number, number]> = [];
    const order = [...nodes].sort(
      (a, b) =>
        Number(this.highlight.has(b.id)) - Number(this.highlight.has(a.id)) ||
        (b.weight || 1) - (a.weight || 1),
    );
    for (const node of order) {
      const text = node.label.slice(0, 26);
      const width = ctx.measureText(text).width;
      const x = node.x * this.scale + this.offsetX;
      const y =
        node.y * this.scale +
        this.offsetY +
        this.radiusOf(node) * Math.min(1, this.scale) +
        12;
      const box: [number, number, number, number] = [x - width / 2 - 2, y - 10, x + width / 2 + 2, y + 3];
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) {
        continue;
      }
      placed.push(box);
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  private toWorld(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.offsetX) / this.scale,
      y: (clientY - rect.top - this.offsetY) / this.scale,
    };
  }

  private nodeAt(clientX: number, clientY: number): GraphNode | null {
    const { x, y } = this.toWorld(clientX, clientY);
    let best: GraphNode | null = null;
    let bestDistance = 18 / this.scale;
    for (const node of this.nodes) {
      const distance = Math.hypot(node.x - x, node.y - y);
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  private bind() {
    const canvas = this.canvas;
    canvas.addEventListener("mousedown", (event: MouseEvent) => {
      const node = this.nodeAt(event.clientX, event.clientY);
      if (node) {
        this.dragging = node;
        node.fixed = true;
      } else {
        this.panning = true;
      }
      this.lastPointer = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener("mousemove", (event: MouseEvent) => {
      if (this.dragging) {
        const { x, y } = this.toWorld(event.clientX, event.clientY);
        this.dragging.x = x;
        this.dragging.y = y;
        this.alpha = Math.max(this.alpha, 0.25);
        this.start();
        return;
      }
      if (this.panning) {
        this.offsetX += event.clientX - this.lastPointer.x;
        this.offsetY += event.clientY - this.lastPointer.y;
        this.lastPointer = { x: event.clientX, y: event.clientY };
        this.draw();
        return;
      }
      const hovered = this.nodeAt(event.clientX, event.clientY);
      canvas.style.cursor = hovered ? "pointer" : "grab";
      this.options.onHover?.(hovered, event.clientX, event.clientY);
    });
    const release = () => {
      if (this.dragging) this.dragging.fixed = false;
      this.dragging = null;
      this.panning = false;
    };
    canvas.addEventListener("mouseup", release);
    canvas.addEventListener("mouseleave", () => {
      release();
      this.options.onHover?.(null, 0, 0);
    });
    canvas.addEventListener("click", (event: MouseEvent) => {
      const node = this.nodeAt(event.clientX, event.clientY);
      if (node) this.options.onSelect?.(node);
    });
    canvas.addEventListener("wheel", (event: WheelEvent) => {
      event.preventDefault();
      const wanted = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.max(0.15, Math.min(8, this.scale * wanted));
      // the factor actually applied, so the view stays put at either limit
      const factor = next / this.scale;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      this.offsetX = px - (px - this.offsetX) * factor;
      this.offsetY = py - (py - this.offsetY) * factor;
      this.scale = next;
      this.draw();
    });
  }

  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.draw();
  }
}

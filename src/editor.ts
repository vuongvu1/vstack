import { displayScale, toDisplay } from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

type Drag = {
  index: number;
  corner: Corner | null; // null = move the whole box
  originX: number;
  originY: number;
  startRect: Rect;
};

/** A mounted overlay: `stop` tears it down, `place` re-reads `boxes()` and
 *  moves the nodes to match.
 *
 *  `place` is exposed because the two overlays are not independent. The
 *  output overlay's drag rewrites a piece's `crop` as well as its `out`, and
 *  the source overlay's nodes are DOM — they only move when its own `place`
 *  runs, which nothing in the other overlay's drag would otherwise reach.
 *  The rAF canvas needs no such call: it re-reads state every frame. */
export type EditorHandle = { place: () => void; stop: () => void };

/** Mounts a draggable/resizable box overlay into `opts.host` and returns its
 *  handle. Two of these are mounted during framing: one over the
 *  source <video> for crop rects, one over the composite <canvas> for the
 *  floating pieces' output rects.
 *
 *  The editor knows no geometry — `move` and `resize` are injected, so the
 *  aspect-locked source rules and the free-aspect output rules each stay in
 *  the module that tests them. It only ever appends its own `.boxes` layer
 *  and never touches the host's existing children, because removing or
 *  rebuilding a sibling here is exactly the persistent-shell hazard this app
 *  is built to avoid. */
export function mountEditor(opts: {
  host: HTMLElement;
  /** The element the overlay is laid out against — a <video> or a <canvas>.
   *  Only its box and its `loadedmetadata` event are used. */
  media: HTMLElement;
  /** The coordinate space `boxes()` are expressed in, for the display
   *  scale: source pixels for the crop overlay, OUTPUT for the output one. */
  bounds: () => Size;
  /** Node count, fixed for this mount — main.ts remounts when it changes,
   *  the same rule the cell list has always had. */
  count: number;
  /** The index the first node carries, for its label and its colour. The
   *  output overlay passes the cell count so its pieces keep the same
   *  numbers and tints they have on the source overlay. */
  labelFrom?: number;
  boxes: () => Rect[];
  move: (rect: Rect, dx: number, dy: number, index: number) => Rect;
  resize: (rect: Rect, corner: Corner, dx: number, dy: number, index: number) => Rect;
  onChange(index: number, rect: Rect): void;
  onCommit(): void;
  /** When given, each node carries a × that removes it. */
  onRemove?: (index: number) => void;
}): EditorHandle {
  const layer = document.createElement("div");
  layer.className = "boxes";
  opts.host.append(layer);

  const labelFrom = opts.labelFrom ?? 0;
  const nodes = Array.from({ length: opts.count }, (_, i) => makeBox(i));
  layer.append(...nodes);

  function makeBox(index: number): HTMLDivElement {
    const box = document.createElement("div");
    // box-c0..c5 carry the per-index colour. Which scale a floating piece
    // lands on depends on the layout: `labelFrom` is the cell count, so on
    // the two-cell default a piece is box-c2/box-c3 and the cyan and orange
    // scales are only ever seen on a four-cell layout. Six is enough either
    // way — four cells at most, plus two pieces — so a collision is
    // impossible whichever end of the scale gets used.
    box.className = `box box-c${labelFrom + index}`;
    box.dataset.index = String(index);
    const label = document.createElement("span");
    label.className = "box-label";
    label.textContent = String(labelFrom + index + 1);
    box.append(label);
    if (opts.onRemove) {
      const remove = document.createElement("button");
      remove.className = "box-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remove this box";
      remove.ariaLabel = `Remove box ${labelFrom + index + 1}`;
      // pointerdown, not click: the layer's own pointerdown starts a drag,
      // and stopping propagation here is what keeps a removal from also
      // grabbing the box.
      remove.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        opts.onRemove?.(index);
      });
      box.append(remove);
    }
    for (const c of CORNERS) {
      const h = document.createElement("div");
      h.className = `handle handle-${c}`;
      h.dataset.corner = c;
      box.append(h);
    }
    return box;
  }

  let drag: Drag | null = null;

  /** The overlay is positioned over the rendered media element, so display
   *  px per bounds-unit is derived from the element's actual box each time —
   *  it resizes with the window. */
  function scale(): number {
    return displayScale(opts.bounds(), opts.media.clientWidth);
  }

  function place(): void {
    const s = scale();
    const bs = opts.boxes();
    const rect = opts.media.getBoundingClientRect();
    const hostRect = opts.host.getBoundingClientRect();
    layer.style.left = `${rect.left - hostRect.left}px`;
    layer.style.top = `${rect.top - hostRect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    nodes.forEach((node, i) => {
      const box = bs[i];
      if (!box) {
        node.hidden = true;
        return;
      }
      node.hidden = false;
      const d = toDisplay(box, s);
      node.style.left = `${d.x}px`;
      node.style.top = `${d.y}px`;
      node.style.width = `${d.w}px`;
      node.style.height = `${d.h}px`;
    });
    // Native hit-testing follows paint order, so the later sibling wins where
    // the boxes overlap. defaultBoxes overlaps by construction, which would
    // leave the covered box's handles — the ones used to shrink it for the
    // facecam case — unreachable. Append largest first so the smallest ends
    // up on top, and break an exact tie toward the lower index: a 2x2 grid
    // starts as four equal-area boxes, and without the tie-break cell 1's
    // handles sit under cell 4's.
    const area = (i: number) => {
      const b = bs[i];
      return b ? b.w * b.h : 0;
    };
    const order = nodes.map((_, i) => i).sort((a, b) => area(b) - area(a) || b - a);
    for (const i of order) {
      const node = nodes[i];
      if (node) layer.append(node);
    }
  }

  layer.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    const boxNode = target.closest<HTMLElement>(".box");
    if (!boxNode) return;
    const index = Number(boxNode.dataset.index);
    const startRect = opts.boxes()[index];
    if (!Number.isInteger(index) || !startRect) return;
    const corner = (target.dataset.corner as Corner | undefined) ?? null;
    drag = { index, corner, originX: e.clientX, originY: e.clientY, startRect };
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  layer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const s = scale();
    // Pointer deltas are display px; the geometry works in the bounds' own
    // units — source px for crops, output px for the floating pieces.
    const dx = (e.clientX - drag.originX) / s;
    const dy = (e.clientY - drag.originY) / s;
    const next =
      drag.corner === null
        ? opts.move(drag.startRect, dx, dy, drag.index)
        : opts.resize(drag.startRect, drag.corner, dx, dy, drag.index);
    opts.onChange(drag.index, next);
    place();
  });

  function endDrag(e: PointerEvent): void {
    if (!drag) return;
    drag = null;
    layer.releasePointerCapture(e.pointerId);
    opts.onCommit();
  }
  layer.addEventListener("pointerup", endDrag);
  layer.addEventListener("pointercancel", endDrag);

  const onResize = () => place();
  window.addEventListener("resize", onResize);
  opts.media.addEventListener("loadedmetadata", onResize);
  // window's resize event only fires on a top-level viewport change. The
  // media element's own rendered box can change for reasons that never touch
  // the window — a sibling in the bar reflowing `.stage`'s height, e.g. — so
  // the overlay also has to watch the element it is actually laid out against.
  const resizeObserver = new ResizeObserver(() => place());
  resizeObserver.observe(opts.media);
  place();

  return {
    place,
    stop: () => {
      window.removeEventListener("resize", onResize);
      opts.media.removeEventListener("loadedmetadata", onResize);
      resizeObserver.disconnect();
      layer.remove();
    },
  };
}

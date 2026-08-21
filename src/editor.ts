import { displayScale, moveBy, resizeFromCorner, toDisplay } from "./geometry.ts";
import { ratioOf } from "./layout.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

type Drag = {
  index: number;
  corner: Corner | null; // null = move the whole box
  originX: number;
  originY: number;
  startRect: Rect;
};

/** Mounts the draggable/resizable crop-box overlay into `opts.host` (the
 *  persistent `sourceSlot`, already `position: relative`) and returns a
 *  teardown function. Only ever appends its own `.boxes` layer — never
 *  touches the host's existing children (the <video>/<iframe>), because
 *  removing or rebuilding a sibling here is exactly the persistent-shell
 *  hazard this app is built to avoid. */
export function mountEditor(opts: {
  host: HTMLElement;
  media: HTMLVideoElement;
  source: () => Size;
  /** Output-space cells in cellsOf order. Fixed for this mount — main.ts
   *  remounts the editor when the layout changes, because the node count
   *  is derived from it. A plain array, not a getter: unlike `boxes` (read
   *  every drag frame, because a box moves within a mount) this is read
   *  exactly once, at mount, and a getter here would advertise a liveness
   *  the mount never honours — the node count is fixed at construction, so
   *  a live cell list would drift out of sync with it. */
  cells: Rect[];
  boxes: () => Rect[];
  onChange(index: number, rect: Rect): void;
  onCommit(): void;
}): () => void {
  const layer = document.createElement("div");
  layer.className = "boxes";
  opts.host.append(layer);

  const cells = opts.cells;
  const nodes = cells.map((_, i) => makeBox(i));
  layer.append(...nodes);

  function makeBox(index: number): HTMLDivElement {
    const box = document.createElement("div");
    // box-c0..c3 carry the per-index colour; four is the maximum cell count
    // any layout declares.
    box.className = `box box-c${index}`;
    box.dataset.index = String(index);
    const label = document.createElement("span");
    label.className = "box-label";
    label.textContent = String(index + 1);
    box.append(label);
    for (const c of CORNERS) {
      const h = document.createElement("div");
      h.className = `handle handle-${c}`;
      h.dataset.corner = c;
      box.append(h);
    }
    return box;
  }

  let drag: Drag | null = null;

  /** The overlay is positioned over the rendered video, so display px per
   *  source px is derived from the element's actual box each time — the
   *  video resizes with the window. */
  function scale(): number {
    return displayScale(opts.source(), opts.media.clientWidth);
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
    // Pointer deltas are display px; geometry works in source px.
    const dx = (e.clientX - drag.originX) / s;
    const dy = (e.clientY - drag.originY) / s;
    const source = opts.source();
    const cell = cells[drag.index];
    // pointerdown only sets `drag` for an index that has both a node and a
    // box, and nodes are built from `cells`, so this is always present.
    if (!cell) return;
    const next =
      drag.corner === null
        ? moveBy(drag.startRect, dx, dy, source)
        : resizeFromCorner(drag.startRect, drag.corner, dx, dy, source, ratioOf(cell));
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

  return () => {
    window.removeEventListener("resize", onResize);
    opts.media.removeEventListener("loadedmetadata", onResize);
    resizeObserver.disconnect();
    layer.remove();
  };
}

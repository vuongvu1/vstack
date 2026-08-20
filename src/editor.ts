import { displayScale, moveBy, resizeFromCorner, toDisplay } from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

type Which = "top" | "bottom";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

type Drag = {
  which: Which;
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
  boxes: () => { top: Rect; bottom: Rect };
  onChange(which: Which, rect: Rect): void;
  onCommit(): void;
}): () => void {
  const layer = document.createElement("div");
  layer.className = "boxes";
  opts.host.append(layer);

  const nodes: Record<Which, HTMLDivElement> = {
    top: makeBox("top"),
    bottom: makeBox("bottom"),
  };
  layer.append(nodes.top, nodes.bottom);

  function makeBox(which: Which): HTMLDivElement {
    const box = document.createElement("div");
    box.className = `box box-${which}`;
    box.dataset.which = which;
    const label = document.createElement("span");
    label.className = "box-label";
    label.textContent = which.toUpperCase();
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
    const b = opts.boxes();
    const rect = opts.media.getBoundingClientRect();
    const hostRect = opts.host.getBoundingClientRect();
    layer.style.left = `${rect.left - hostRect.left}px`;
    layer.style.top = `${rect.top - hostRect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    for (const which of ["top", "bottom"] as const) {
      const d = toDisplay(b[which], s);
      const node = nodes[which];
      node.style.left = `${d.x}px`;
      node.style.top = `${d.y}px`;
      node.style.width = `${d.w}px`;
      node.style.height = `${d.h}px`;
    }
  }

  layer.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    const boxNode = target.closest<HTMLElement>(".box");
    if (!boxNode) return;
    const which = boxNode.dataset.which as Which;
    const corner = (target.dataset.corner as Corner | undefined) ?? null;
    drag = {
      which,
      corner,
      originX: e.clientX,
      originY: e.clientY,
      startRect: opts.boxes()[which],
    };
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
    const next =
      drag.corner === null
        ? moveBy(drag.startRect, dx, dy, source)
        : resizeFromCorner(drag.startRect, drag.corner, dx, dy, source);
    opts.onChange(drag.which, next);
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
  place();

  return () => {
    window.removeEventListener("resize", onResize);
    opts.media.removeEventListener("loadedmetadata", onResize);
    layer.remove();
  };
}

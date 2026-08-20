import * as api from "./api.ts";
import { SKIP_TRIM_UNDER } from "./geometry.ts";
import { clock } from "./format.ts";
import { getState, restore, setState, subscribe } from "./state.ts";

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("#app missing");
// Rebound so `app`'s declared type is HTMLDivElement outright: control-flow
// narrowing from the check above doesn't reach into functions declared
// later in this module (render() reads app across a closure boundary).
const app: HTMLDivElement = appEl;

type ElProps<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "style">
> & { style?: string };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps<K> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const { style, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (style !== undefined) node.style.cssText = style;
  node.append(...children);
  return node;
}

async function guard(label: string, fn: () => Promise<void>): Promise<void> {
  setState({ busy: label, error: "" });
  try {
    await fn();
  } catch (err) {
    setState({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    setState({ busy: "" });
  }
}

async function load(url: string): Promise<void> {
  await guard("Reading video info…", async () => {
    const info = await api.probe(url);
    const saved = restore(info.videoId, null);
    setState({
      videoId: info.videoId,
      title: info.title,
      duration: info.duration,
      source: { w: info.width, h: info.height },
      start: saved.start ?? 0,
      end: saved.end ?? info.duration,
      // A short video needs no browsing step — same code path, different
      // starting point.
      phase: info.duration < SKIP_TRIM_UNDER ? "framing" : "trimming",
    });
  });
}

function renderIdle(): HTMLElement {
  const input = el("input", {
    type: "url",
    placeholder: "https://www.youtube.com/watch?v=…",
    size: 60,
  });
  const go = el("button", { textContent: "Load" });
  go.onclick = () => void load(input.value);
  input.onkeydown = (e) => {
    if (e.key === "Enter") void load(input.value);
  };
  return el("div", { className: "bar" }, input, go);
}

function render(): void {
  const s = getState();
  app.replaceChildren();

  if (s.phase === "idle") app.append(renderIdle());
  else {
    // Replaced in Tasks 8 and 9.
    app.append(
      el(
        "div",
        {},
        el("p", { textContent: `${s.title} — ${clock(s.duration)} — ${s.source.w}x${s.source.h}` }),
        el("p", { textContent: `phase: ${s.phase}` }),
      ),
    );
  }

  if (s.busy) app.append(el("p", { textContent: s.busy }));
  if (s.error) app.append(el("pre", { textContent: s.error, style: "color:var(--amber-11)" }));
}

subscribe(render);
render();

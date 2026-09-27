export type WidthStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function clampWidth(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function storedWidth(store: WidthStore, key: string, fallback: number): number {
  try {
    const value = Number(store.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveWidth(store: WidthStore, key: string, width: number): void {
  try { store.setItem(key, String(Math.round(width))); } catch { /* Storage may be unavailable. */ }
}

export function clearWidth(store: WidthStore, key: string): void {
  try { store.removeItem(key); } catch { /* Storage may be unavailable. */ }
}

type ResizeOptions = {
  label: string;
  direction: 1 | -1;
  bounds(): { min: number; max: number };
  current(): number;
  set(width: number): void;
  reset(): void;
};

/** A focusable separator supports pointer drag, arrow keys and double-click reset. */
export function resizeHandle(options: ResizeOptions): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "resize-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", options.label);
  handle.tabIndex = 0;
  handle.title = "Arraste para ajustar · duplo clique para restaurar";

  const update = () => {
    const { min, max } = options.bounds();
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(Math.round(options.current())));
  };
  let drag: { pointerId: number; x: number; width: number } | null = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, x: event.clientX, width: options.current() };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-panels");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { min, max } = options.bounds();
    options.set(clampWidth(drag.width + options.direction * (event.clientX - drag.x), min, max));
    update();
  });
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    document.body.classList.remove("resizing-panels");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("lostpointercapture", finish);
  handle.addEventListener("dblclick", () => { options.reset(); update(); });
  handle.addEventListener("keydown", (event) => {
    const { min, max } = options.bounds();
    const step = event.shiftKey ? 25 : 10;
    const next = event.key === "Home" ? min : event.key === "End" ? max
      : event.key === "ArrowRight" ? options.current() + options.direction * step
      : event.key === "ArrowLeft" ? options.current() - options.direction * step : null;
    if (next === null) return;
    event.preventDefault();
    options.set(clampWidth(next, min, max));
    update();
  });
  update();
  return handle;
}

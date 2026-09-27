import { clampWidth, clearWidth, resizeHandle, saveWidth, storedWidth } from "./panel-resize.ts";

const JOURNEY = { key: "ownr.width.journey", default: 232, min: 180, max: 420 };
const TUTOR = { key: "ownr.width.tutor", default: 360, min: 280, max: 520 };
const CENTER_MIN = 420;
const HANDLE_WIDTH = 8;

export function mountLayoutResize(layout: HTMLElement): void {
  const store = window.localStorage;
  let journeyWanted = storedWidth(store, JOURNEY.key, JOURNEY.default);
  let tutorWanted = storedWidth(store, TUTOR.key, TUTOR.default);
  let journeyWidth = JOURNEY.default;
  let tutorWidth = TUTOR.default;
  let journeyHandle: HTMLElement;
  let tutorHandle: HTMLElement;

  const available = () => layout.clientWidth - CENTER_MIN - HANDLE_WIDTH * 2;
  const journeyBounds = () => ({ min: JOURNEY.min, max: Math.min(JOURNEY.max, available() - TUTOR.min) });
  const tutorBounds = () => ({ min: TUTOR.min, max: Math.min(TUTOR.max, available() - journeyWidth) });
  const refresh = () => {
    if (window.innerWidth <= 1100) return; // Existing stacked layout has no horizontal separators.
    journeyWidth = clampWidth(journeyWanted, JOURNEY.min, journeyBounds().max);
    tutorWidth = clampWidth(tutorWanted, TUTOR.min, tutorBounds().max);
    layout.style.setProperty("--journey-width", `${journeyWidth}px`);
    layout.style.setProperty("--tutor-width", `${tutorWidth}px`);
    if (journeyHandle) syncAria(journeyHandle, journeyWidth, journeyBounds());
    if (tutorHandle) syncAria(tutorHandle, tutorWidth, tutorBounds());
  };
  const setJourney = (width: number) => { journeyWanted = width; saveWidth(store, JOURNEY.key, width); refresh(); };
  const setTutor = (width: number) => { tutorWanted = width; saveWidth(store, TUTOR.key, width); refresh(); };
  journeyHandle = resizeHandle({
    label: "Largura da navegação da jornada",
    direction: 1,
    bounds: journeyBounds,
    current: () => journeyWidth,
    set: setJourney,
    reset: () => { clearWidth(store, JOURNEY.key); journeyWanted = JOURNEY.default; refresh(); },
  });
  journeyHandle.classList.add("journey-resize");
  tutorHandle = resizeHandle({
    label: "Largura do Tutor e Toolbox",
    direction: -1,
    bounds: tutorBounds,
    current: () => tutorWidth,
    set: setTutor,
    reset: () => { clearWidth(store, TUTOR.key); tutorWanted = TUTOR.default; refresh(); },
  });
  tutorHandle.classList.add("tutor-resize");
  layout.querySelector("#journey")?.after(journeyHandle);
  layout.querySelector("#main")?.after(tutorHandle);
  window.addEventListener("resize", refresh);
  refresh();
}

function syncAria(handle: HTMLElement, value: number, bounds: { min: number; max: number }): void {
  handle.setAttribute("aria-valuemin", String(bounds.min));
  handle.setAttribute("aria-valuemax", String(Math.max(bounds.min, bounds.max)));
  handle.setAttribute("aria-valuenow", String(Math.round(value)));
}

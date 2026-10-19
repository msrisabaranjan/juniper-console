/**
 * Glitch -> type-in reveal, mirroring the Roadster UI's menu entrance:
 * an item briefly distorts (RGB split + slice jitter, CSS keyframes),
 * then its label types out character by character with a block caret.
 *
 * All timers are generation-tagged: cancelFx() invalidates every pending
 * step, so leaving the page mid-animation can't resurrect half-typed
 * labels later.
 */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let generation = 0;

/** Invalidate every pending fx timeout (page left / intro restarted). */
export function cancelFx(): void {
  generation++;
}

/** setTimeout that silently drops once cancelFx() has been called. */
export function schedule(ms: number, fn: () => void): void {
  const gen = generation;
  setTimeout(() => {
    if (gen === generation) fn();
  }, ms);
}

/** Brief glitch burst on an element; the CSS class drives the keyframes. */
export function glitchIn(el: HTMLElement, ms = 260): void {
  if (reducedMotion) return;
  el.classList.remove("glitching");
  void el.offsetWidth; // force reflow so the animation restarts if re-applied
  el.classList.add("glitching");
  schedule(ms, () => el.classList.remove("glitching"));
}

/**
 * Hide an element's text so it isn't visible before its typeIn turn.
 * The full string is cached in data-fx-text (first full sighting wins, so
 * a run cancelled mid-typing can't shrink the cache for the next one).
 */
export function hideForType(el: HTMLElement): void {
  const full = el.textContent ?? "";
  if (full && el.dataset.fxText === undefined) el.dataset.fxText = full;
  if (!reducedMotion) el.textContent = "";
}

/**
 * Typewriter write of an element's text. The full string is cached in
 * data-fx-text on first use so a cancelled run can't truncate the source
 * for the next one. Pass `text` when the label changes between runs
 * (e.g. SELECT -> ACTIVE).
 */
export function typeIn(el: HTMLElement, text?: string, cps = 32): void {
  const full = text ?? el.dataset.fxText ?? (el.dataset.fxText = el.textContent ?? "");
  if (text !== undefined) el.dataset.fxText = text;
  if (reducedMotion) {
    el.textContent = full;
    return;
  }
  el.classList.add("typing");
  el.textContent = "";
  let i = 0;
  const step = () => {
    el.textContent = full.slice(0, ++i);
    if (i < full.length) schedule(1000 / cps, step);
    else el.classList.remove("typing");
  };
  step();
}

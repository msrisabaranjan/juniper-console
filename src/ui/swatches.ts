import type { AccentPreset } from "../state";

/**
 * Round color dots for the accent picker. Same {el, set()} contract as
 * createSegmented so callers treat them alike.
 */
export interface Swatches {
  el: HTMLElement;
  set(value: string): void;
}

export function createSwatches(
  presets: readonly AccentPreset[],
  value: string,
  onChange: (v: string) => void,
  ariaLabel: string
): Swatches {
  const el = document.createElement("div");
  el.className = "swatches";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", ariaLabel);

  const buttons = new Map<string, HTMLButtonElement>();
  presets.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.value = p.id;
    b.style.setProperty("--sw", p.rgb); // dot color comes from the preset list
    b.title = p.label;
    b.setAttribute("aria-label", `${p.label} accent`);
    b.setAttribute("aria-pressed", String(p.id === value));
    b.addEventListener("click", () => {
      if (p.id === value) return;
      value = p.id;
      buttons.forEach((btn, key) => btn.setAttribute("aria-pressed", String(key === value)));
      onChange(p.id);
    });
    buttons.set(p.id, b);
    el.appendChild(b);
  });

  return {
    el,
    set(v: string) {
      if (!buttons.has(v) || v === value) return;
      value = v;
      buttons.forEach((btn, key) => btn.setAttribute("aria-pressed", String(key === value)));
    },
  };
}

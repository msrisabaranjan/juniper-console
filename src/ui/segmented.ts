/**
 * Sliding-indicator segmented control, matching the Roadster UI's
 * boxed option rows. Returns the root element; exposes update().
 */
export interface Segmented {
  el: HTMLElement;
  set(value: string): void;
}

export function createSegmented(
  options: readonly string[],
  value: string,
  onChange: (v: string) => void,
  ariaLabel: string
): Segmented {
  const el = document.createElement("div");
  el.className = "seg";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", ariaLabel);

  const ind = document.createElement("span");
  ind.className = "seg-ind";
  el.appendChild(ind);

  const buttons = new Map<string, HTMLButtonElement>();
  options.forEach((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt.toUpperCase();
    b.dataset.value = opt;
    b.setAttribute("aria-pressed", String(opt === value));
    b.addEventListener("click", () => {
      if (b.dataset.value === value) return;
      value = opt;
      buttons.forEach((btn, key) => btn.setAttribute("aria-pressed", String(key === value)));
      moveIndicator();
      onChange(opt);
    });
    buttons.set(opt, b);
    el.appendChild(b);
  });

  function moveIndicator(): void {
    const active = buttons.get(value);
    if (!active) {
      ind.style.width = "0"; // accent not in this control (e.g. a color preset)
      return;
    }
    ind.style.width = `${active.offsetWidth}px`;
    ind.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  // wait for layout, then place indicator
  requestAnimationFrame(moveIndicator);
  new ResizeObserver(moveIndicator).observe(el);

  return {
    el,
    set(v: string) {
      if (v === value) return;
      value = v;
      buttons.forEach((btn, key) => btn.setAttribute("aria-pressed", String(key === value)));
      moveIndicator();
    },
  };
}

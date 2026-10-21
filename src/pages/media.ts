import { getState, setState, subscribe, TRACKS } from "../state";
import { cancelFx, glitchIn, hideForType, schedule, typeIn } from "../ui/fx";

/**
 * MEDIA page — the Roadster UI's "Listen" tab (video 1:21):
 * a Last Listened hero (art + big title + Play Album), a "Recently
 * Played" row of square album tiles, and a "Made For You" row of wide
 * banners. Covers are procedural CSS art — swap in images later by
 * pointing --art at a url().
 *
 * Entrance copies the video's page transition: every cover glitch-pops in
 * first (hero art, then both rails cascading left-to-right); only when the
 * last cover lands does the text arrive — hero types/slides de-blurring,
 * section labels glitch->type. Hovering a tile lifts it and wakes the mini
 * equalizer on its art; scrolling a rail past its end card-stacks the deck
 * (end card pushed under its neighbor); clicking a cover makes it the live
 * track in the media strip.
 */

interface Album {
  track: number; // index into TRACKS (clicking plays it in the media strip)
  art: string; // CSS background layered onto the tile
  badge?: { glyph: string; count: string }; // ♥ / ▶ stat chip on the art
}

// covers, roughly following the color moods seen in the video's covers
const ART: Record<string, string> = {
  stars:
    "radial-gradient(42% 34% at 38% 26%, rgb(235 242 255 / 0.95), transparent 62%)," +
    "radial-gradient(120% 80% at 62% 96%, rgb(196 214 232 / 0.5), transparent 55%)," +
    "linear-gradient(198deg, #1a2432 0%, #0c1119 55%, #05070b 100%)",
  meridian:
    "linear-gradient(184deg, #ffb36b 0%, #ff6f7c 38%, #7c3b63 62%, #221126 100%)," +
    "radial-gradient(70% 40% at 30% 66%, rgb(255 210 130 / 0.6), transparent 60%)",
  visage:
    "radial-gradient(52% 44% at 50% 40%, rgb(255 250 246 / 0.9), transparent 68%)," +
    "linear-gradient(178deg, #d9c4bd 0%, #b78c86 62%, #6f4c50 100%)",
  linen:
    "repeating-linear-gradient(102deg, rgb(255 255 255 / 0.05) 0 2px, transparent 2px 9px)," +
    "linear-gradient(168deg, #7a7763 0%, #3c3b30 52%, #14140f 100%)",
  mercury:
    "linear-gradient(118deg, transparent 38%, rgb(150 205 255 / 0.85) 46% 49%, rgb(220 238 255 / 0.9) 50% 52%, transparent 60%)," +
    "linear-gradient(200deg, #141922 0%, #070a0f 100%)",
  petal:
    "repeating-radial-gradient(circle at 34% 42%, rgb(255 122 184 / 0.9) 0 2.5px, transparent 2.5px 11px)," +
    "repeating-radial-gradient(circle at 64% 62%, rgb(87 209 255 / 0.85) 0 2.5px, transparent 2.5px 14px)," +
    "radial-gradient(90% 90% at 50% 50%, rgb(42 34 58 / 0.85), transparent 75%), #101318",
  window:
    "repeating-linear-gradient(-98deg, rgb(255 110 199 / 0.5) 0 3px, transparent 3px 26px)," +
    "repeating-linear-gradient(-98deg, rgb(255 179 71 / 0.4) 0 2px, transparent 2px 40px)," +
    "linear-gradient(188deg, #241436 0%, #11102a 70%, #0a0a16 100%)",
  coral:
    "radial-gradient(22% 26% at 26% 32%, rgb(255 122 89 / 0.85), transparent 70%)," +
    "radial-gradient(18% 20% at 62% 22%, rgb(255 168 122 / 0.7), transparent 70%)," +
    "radial-gradient(26% 30% at 74% 64%, rgb(255 99 99 / 0.8), transparent 70%)," +
    "radial-gradient(16% 18% at 44% 74%, rgb(255 210 168 / 0.6), transparent 70%), #17100f",
};

const RECENT: Album[] = [
  { track: 2, art: ART.meridian, badge: { glyph: "♥", count: "1.7K" } },
  { track: 3, art: ART.visage, badge: { glyph: "♥", count: "9.8K" } },
  { track: 4, art: ART.linen, badge: { glyph: "◆", count: "1.8K" } },
  { track: 0, art: ART.mercury, badge: { glyph: "▶", count: "8.9K" } },
  { track: 5, art: ART.petal },
  { track: 6, art: ART.window },
  { track: 7, art: ART.coral },
];

// Made For You: same catalogue, remixed order, wide banner crop of each cover
const FOR_YOU: Album[] = [
  { track: 4, art: ART.linen },
  { track: 1, art: ART.stars },
  { track: 5, art: ART.petal },
  { track: 2, art: ART.meridian },
  { track: 7, art: ART.window },
  { track: 0, art: ART.mercury },
  { track: 3, art: ART.visage },
  { track: 6, art: ART.coral },
];

const HERO_TRACK = 1; // "To The Stars" — the video's Last Listened card

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const TILE_STAGGER = 50; // cover cascade cadence
const GLITCH_LEAD = 150;

export function initMediaPage(): { playIntro(): void } {
  const wrap = document.getElementById("media-wrap")!;

  // ---------- hero: Last Listened ----------
  const hero = document.createElement("div");
  hero.className = "media-hero m-in";

  const heroArt = document.createElement("span");
  heroArt.className = "media-hero-art m-in";
  heroArt.style.setProperty("--art", ART.stars);

  const heroText = document.createElement("div");
  heroText.className = "media-hero-text";

  const eyebrow = document.createElement("div");
  eyebrow.className = "media-eyebrow";
  eyebrow.textContent = "LAST LISTENED";

  const hTitle = document.createElement("div");
  hTitle.className = "media-hero-title";
  hTitle.textContent = TRACKS[HERO_TRACK].title;

  const hArtist = document.createElement("div");
  hArtist.className = "media-hero-artist";
  hArtist.textContent = TRACKS[HERO_TRACK].artist;

  const playAlbum = document.createElement("button");
  playAlbum.type = "button";
  playAlbum.className = "media-play-album m-in";
  const paLabel = document.createElement("span");
  paLabel.textContent = "PLAY ALBUM";
  const paDot = document.createElement("i");
  paDot.setAttribute("aria-hidden", "true");
  playAlbum.append(paLabel, paDot);
  playAlbum.addEventListener("click", () =>
    setState({ trackIndex: HERO_TRACK, playing: true })
  );

  heroText.append(eyebrow, hTitle, hArtist, playAlbum);
  hero.append(heroArt, heroText);

  // ---------- rows ----------
  const tiles: { el: HTMLElement; track: number }[] = [];
  const railRefreshers: (() => void)[] = []; // edge-stack re-arming per rail

  function row(label: string, albums: Album[], wide: boolean): HTMLElement {
    const sec = document.createElement("div");
    sec.className = "media-sec";

    const lab = document.createElement("div");
    lab.className = "media-sec-label";
    lab.textContent = label;

    const rail = document.createElement("div");
    rail.className = "media-row" + (wide ? " wide" : "");
    rail.tabIndex = 0; // keyboard users can focus + arrow through the strip

    for (const a of albums) {
      const t = TRACKS[a.track];
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "m-tile m-in";
      tile.dataset.track = String(a.track);
      tile.setAttribute("aria-label", `${t.title} — ${t.artist}`);

      const art = document.createElement("span");
      art.className = "m-art";
      art.style.setProperty("--art", a.art);

      const eq = document.createElement("span");
      eq.className = "m-eq";
      eq.setAttribute("aria-hidden", "true");
      eq.append(
        ...[0, 1, 2, 3].map((i) => {
          const bar = document.createElement("i");
          bar.style.setProperty("--i", String(i));
          return bar;
        })
      );

      if (a.badge) {
        const bg = document.createElement("span");
        bg.className = "m-badge";
        bg.append(a.badge.glyph + " " + a.badge.count);
        art.append(bg);
      }
      art.append(eq);

      const name = document.createElement("b");
      name.className = "m-name";
      name.textContent = t.title;
      const artist = document.createElement("span");
      artist.className = "m-artist";
      artist.textContent = t.artist;

      tile.append(art, name, artist);
      tile.addEventListener("click", () =>
        setState({ trackIndex: a.track, playing: true })
      );
      tiles.push({ el: tile, track: a.track });
      rail.appendChild(tile);
    }

    sec.append(lab, rail);
    attachRailFX(rail);
    return sec;
  }

  const recentSec = row("RECENTLY PLAYED", RECENT, false);
  const forYouSec = row("MADE FOR YOU", FOR_YOU, true);
  wrap.append(hero, recentSec, forYouSec);

  // ---------- rail dynamics: edge stack + card-stack bounce (video ~1:26) ----------
  // 1) a cover leaving/entering a rail EDGE slides under its neighbor (z drops,
  //    cast shadow) instead of fading — middle cards stay flat, evenly spaced.
  // 2) scroll past the last cover and the deck rubber-bands: the end card keeps
  //    sliding back under its neighbor, which rides up on top like a pushed-over
  //    stack of cards, then springs back on release.
  function attachRailFX(rail: HTMLElement): void {
    if (reducedMotion) return;
    const EDGE = 56; // px zone near a rail edge where the stack engages
    const SINK = 40; // px a card slides under its neighbor at the edge
    const MAX = 70; // rubber-band cap, px
    const cards = () => [...rail.querySelectorAll<HTMLElement>(".m-tile")];
    let o = 0;
    let bouncing = false;
    let releaseTimer = 0;

    const rubber = (over: number): number => (over * MAX) / (over + MAX); // damped

    function edgeStack(): void {
      if (bouncing) return;
      const railW = rail.clientWidth;
      for (const el of cards()) {
        const x = el.offsetLeft - rail.scrollLeft;
        let k = 0;
        if (x < EDGE) {
          k = Math.min(EDGE - x, SINK); // leaving: drift right, under the next card
        } else {
          const peek = x + el.offsetWidth - railW; // px poking past the right border
          if (peek > 0) k = -Math.max(0, Math.min(EDGE - peek, SINK)); // entering: start under the previous card
        }
        if (k) {
          el.style.transition = "none";
          el.style.transform = `translateX(${k}px)`;
          el.style.zIndex = "-1";
          el.classList.add("edge");
        } else if (el.style.transform !== "") {
          el.style.transform = "";
          el.style.zIndex = "";
          el.classList.remove("edge");
        }
      }
    }

    function paint(): void {
      const els = cards();
      const n = els.length;
      const base = -o * 0.32;
      els.forEach((el, i) => {
        el.style.transition = "none";
        let x = base;
        if (i === n - 1) {
          x = base - o * 0.28; // end card travels further...
          el.style.zIndex = "1"; // ...but sinks under the stack
        }
        if (i === n - 2) el.style.zIndex = "2"; // neighbor rides over it
        el.style.transform = `translateX(${x}px)`;
        el.classList.add("edge");
      });
    }

    function release(): void {
      if (o <= 0) return;
      o = 0;
      bouncing = false;
      for (const el of cards()) {
        el.style.transition = "transform 0.5s cubic-bezier(0.28, 1.5, 0.5, 1)";
        el.style.transform = "";
        el.style.zIndex = "";
      }
      // re-arm edge states once the spring has landed
      window.setTimeout(edgeStack, 560);
    }

    function push(px: number): void {
      bouncing = true;
      o = Math.min(MAX, o + px * (1 - o / (MAX * 1.7)));
      paint();
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(release, 150);
    }

    const atEnd = ():
      boolean =>
      rail.scrollWidth - rail.clientWidth > 1 &&
      rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 1;

    // wheel / trackpad: after native scroll maxes out, overscroll feeds the bounce
    rail.addEventListener(
      "wheel",
      (e) => {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (d <= 0 || !atEnd()) return;
        e.preventDefault();
        push(d * 0.5);
      },
      { passive: false }
    );

    // mouse drag: emulate rail scrolling; past the end, the slack feeds the bounce
    let dragging = false;
    let startX = 0;
    let startScroll = 0;
    let moved = false;
    rail.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") return; // touch uses native scroll
      dragging = true;
      moved = false;
      startX = e.clientX;
      startScroll = rail.scrollLeft;
    });
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 6) moved = true;
      const maxS = rail.scrollWidth - rail.clientWidth;
      const want = startScroll - dx;
      if (want > maxS) {
        rail.scrollLeft = maxS;
        o = rubber(want - maxS);
        paint();
      } else {
        release();
        rail.scrollLeft = Math.max(0, want);
      }
    };
    const onUp = (): void => {
      if (!dragging) return;
      dragging = false;
      release();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // a drag that moved is a scroll gesture, not a click on a cover
    rail.addEventListener("click", (e) => {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    }, true);

    rail.addEventListener("scroll", edgeStack);
    railRefreshers.push(edgeStack);
    window.setTimeout(edgeStack, 0); // seed once the rail has real layout
  }

  // ---------- track sync: the strip + tiles agree on what's live ----------
  function markPlaying(idx: number): void {
    for (const { el, track } of tiles) el.classList.toggle("playing", track === idx);
  }
  subscribe((s, prev) => {
    if (s.trackIndex !== prev.trackIndex) markPlaying(s.trackIndex);
  });
  markPlaying(getState().trackIndex);

  // ---------- entrance (video 1:21: ALL covers glitch-pop first, text follows) ----------
  let heroAnims: Animation[] = [];

  function slide(el: HTMLElement, delay = 0): void {
    if (reducedMotion) return;
    heroAnims.push(
      el.animate(
        [
          { opacity: 0, transform: "translateY(14px)", filter: "blur(9px)" },
          { opacity: 1, transform: "none", filter: "blur(0px)" },
        ],
        { duration: 420, delay, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" }
      )
    );
  }

  function cascade(row: HTMLElement, t0: number): number {
    let t = t0;
    for (const tile of row.querySelectorAll<HTMLElement>(".m-tile")) {
      schedule(t, () => {
        tile.classList.add("in"); // CSS runs the glitch flicker on the art
        // caption follows the vehicle-menu cadence: glitch burst -> type-in
        const name = tile.querySelector<HTMLElement>(".m-name")!;
        const artist = tile.querySelector<HTMLElement>(".m-artist")!;
        schedule(120, () => glitchIn(name));
        schedule(120 + GLITCH_LEAD, () => typeIn(name));
        schedule(140 + GLITCH_LEAD, () => typeIn(artist));
      });
      t += TILE_STAGGER;
    }
    return t; // when the last tile started
  }

  function playIntro(): void {
    cancelFx();
    heroAnims.forEach((a) => a.cancel());
    heroAnims = [];

    // arm everything hidden, then let the cascade bring it back
    for (const el of wrap.querySelectorAll<HTMLElement>(".m-in")) el.classList.remove("in");
    hideForType(eyebrow);
    hideForType(paLabel);
    for (const lab of wrap.querySelectorAll<HTMLElement>(".media-sec-label")) hideForType(lab);
    for (const cap of wrap.querySelectorAll<HTMLElement>(".m-name, .m-artist")) hideForType(cap);
    railRefreshers.forEach((f) => f()); // re-seat edge-stack transforms for this entry

    if (reducedMotion) {
      for (const el of wrap.querySelectorAll<HTMLElement>(".m-in")) el.classList.add("in");
      return;
    }

    // 1) covers first: hero art, then both rails cascading left-to-right
    schedule(0, () => hero.classList.add("in"));
    schedule(60, () => heroArt.classList.add("in"));
    let t = cascade(recentSec, 140) + 30;
    t = cascade(forYouSec, t) + 240; // + glitch flicker length of the last tile

    // 2) only now does the text arrive
    schedule(t, () => {
      glitchIn(eyebrow);
      schedule(GLITCH_LEAD, () => typeIn(eyebrow));
    });
    schedule(t + 160, () => slide(hTitle));
    schedule(t + 300, () => slide(hArtist));
    schedule(t + 440, () => {
      glitchIn(playAlbum);
      playAlbum.classList.add("in");
      schedule(GLITCH_LEAD, () => typeIn(paLabel));
    });

    // section labels type last, after their covers already sit in the row
    const labs = [recentSec, forYouSec].map((s) => s.querySelector<HTMLElement>(".media-sec-label")!);
    schedule(t + 640, () => {
      glitchIn(labs[0]);
      schedule(GLITCH_LEAD, () => typeIn(labs[0]));
    });
    schedule(t + 780, () => {
      glitchIn(labs[1]);
      schedule(GLITCH_LEAD, () => typeIn(labs[1]));
    });
  }

  return { playIntro };
}

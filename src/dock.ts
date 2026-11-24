/**
 * The main menu as a dropdown. Choosing an option fades the others out, slides the title
 * and the chosen option to the top left, turns the option's caret downward, and shows the
 * option's screen beneath it. Closing runs the same steps backward.
 *
 * The classes set here take effect at once, so the menus behave the same with or without
 * motion; the animations only carry the eye from the old layout to the new one. Each starts
 * from wherever things are on screen, so an animation that's interrupted turns around
 * smoothly.
 */

/** How long the other options take to fade, the header to move, and a screen to drop in (ms). */
const FADE = 140;
const MOVE = 300;
const DROP = 180;
const EASE = "cubic-bezier(0.3, 0, 0.2, 1)";
/** Space between the chosen option and its screen (px). */
const GAP = 10;

interface Spot {
  x: number;
  y: number;
  w: number;
  opacity: number;
}

function spot(el: HTMLElement): Spot {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, opacity: Number(getComputedStyle(el).opacity) };
}

/** The part of a screen that fades and slides: its card. */
const body = (screen: HTMLElement): HTMLElement => screen.querySelector<HTMLElement>(".plate") ?? screen;

function stop(el: HTMLElement): void {
  for (const a of el.getAnimations()) a.cancel();
}

export class Dock {
  /** The chosen option and the screen open beneath it, if any. */
  option: HTMLElement | undefined;
  private screen: HTMLElement | undefined;
  /** A screen still fading out after being closed. */
  private closing: HTMLElement | undefined;
  private readonly calm = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(
    private readonly menu: HTMLElement,
    private readonly title: HTMLElement,
    private readonly options: HTMLElement[],
  ) {}

  /** Open `screen` beneath `option`, or with neither, close whatever is open. */
  set(option: HTMLElement | undefined, screen: HTMLElement | undefined, animated: boolean): void {
    if (option === this.option && screen === this.screen) return;
    if (this.calm.matches) animated = false;
    const was = this.screen;
    const chosen = option ?? this.option;
    const parts = [this.title, ...this.options];
    const before = animated ? parts.map(spot) : [];
    if (this.closing) this.endClose(this.closing);
    for (const el of parts) stop(el);
    if (was) stop(body(was));
    if (screen) stop(body(screen));

    this.menu.classList.toggle("open", !!option);
    for (const o of this.options) o.classList.toggle("open", o === option);
    this.option = option;
    this.screen = screen;
    if (screen && option) {
      screen.classList.add("docked");
      const top = option.getBoundingClientRect().bottom - this.menu.getBoundingClientRect().top + GAP;
      screen.style.setProperty("--dock-top", `${Math.round(top)}px`);
    }
    if (was && was !== screen) {
      if (animated) this.fadeOut(was);
      else was.classList.remove("docked");
    }
    if (!animated) return;

    // Move each part from where it was to where it now belongs. When opening, the other
    // options fade first; when closing, the screen fades first and they come back last.
    const after = parts.map(spot);
    const lead = option || was ? FADE : 0;
    parts.forEach((el, i) => {
      const a = before[i];
      const b = after[i];
      const shift = `translate(${a.x - b.x}px, ${a.y - b.y}px)`;
      if (el === this.title || el === chosen) {
        const scale = el === this.title && b.w ? ` scale(${a.w / b.w})` : "";
        el.animate(
          [
            { transform: shift + scale, transformOrigin: "0 0" },
            { transform: "none", transformOrigin: "0 0" },
          ],
          { delay: lead, duration: MOVE, easing: EASE, fill: "backwards" },
        );
      } else if (option) {
        el.animate(
          [
            { opacity: a.opacity, transform: shift },
            { opacity: 0, transform: shift },
          ],
          { duration: FADE, easing: "ease-out" },
        );
      } else {
        el.animate([{ opacity: a.opacity }, { opacity: 1 }], { delay: lead + MOVE, duration: FADE, easing: "ease-in", fill: "backwards" });
      }
    });
    if (screen) {
      body(screen).animate(
        [
          { opacity: 0, transform: "translateY(-8px)" },
          { opacity: 1, transform: "none" },
        ],
        { delay: lead + MOVE - 60, duration: DROP, easing: "ease-out", fill: "backwards" },
      );
    }
  }

  /** Keep a closed screen in view while it fades out. */
  private fadeOut(screen: HTMLElement): void {
    this.closing = screen;
    screen.classList.add("closing");
    const fade = body(screen).animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-8px)" },
      ],
      { duration: FADE, easing: "ease-in", fill: "forwards" },
    );
    fade.onfinish = () => this.endClose(screen);
  }

  private endClose(screen: HTMLElement): void {
    if (this.closing === screen) this.closing = undefined;
    screen.classList.remove("closing");
    if (screen !== this.screen) screen.classList.remove("docked");
    stop(body(screen));
  }
}

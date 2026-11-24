const GAME_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "KeyJ", "KeyK", "KeyU", "KeyI", "KeyQ", "KeyE", "KeyF", "ShiftLeft", "ShiftRight", "Minus",
  "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
]);

/**
 * Keyboard state by physical key (KeyboardEvent.code), so the layout doesn't matter.
 * Browser auto-repeat is ignored; the game does its own repeating for held keys.
 */
export class Input {
  readonly held = new Set<string>();
  /** While false (in menus), keys are left alone for the page to use. */
  enabled = true;
  private pressed: string[] = [];
  private released: string[] = [];

  constructor(target: Window) {
    target.addEventListener("keydown", (e) => {
      if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey || !GAME_KEYS.has(e.code)) return;
      e.preventDefault();
      if (e.repeat || this.held.has(e.code)) return;
      this.held.add(e.code);
      this.pressed.push(e.code);
    });
    target.addEventListener("keyup", (e) => {
      if (!this.held.delete(e.code)) return;
      this.released.push(e.code);
    });
    target.addEventListener("blur", () => {
      for (const code of this.held) this.released.push(code);
      this.held.clear();
    });
  }

  /** Forget all held keys and queued presses, e.g. when coming back from a menu. */
  reset(): void {
    this.held.clear();
    this.pressed = [];
    this.released = [];
  }

  /** Key presses and releases since the last call, in order. */
  drain(): { pressed: string[]; released: string[] } {
    const out = { pressed: this.pressed, released: this.released };
    this.pressed = [];
    this.released = [];
    return out;
  }
}

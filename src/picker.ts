/**
 * A row of options on a menu screen, one of them chosen. The row takes focus as a whole:
 * moving left and right changes the choice, and clicking an option chooses it.
 */
export class Picker<T> {
  private index: number;
  private readonly options: HTMLElement[];

  constructor(
    readonly element: HTMLElement,
    private readonly choices: readonly T[],
    chosen: T,
    /** Draw one option's element; called again whenever anything changes. */
    private readonly draw: (choice: T, option: HTMLElement) => void,
    private readonly onChange: (choice: T) => void,
  ) {
    this.index = Math.max(0, choices.indexOf(chosen));
    const row = element.querySelector(".picker-options")!;
    this.options = choices.map((_, i) => {
      const option = document.createElement("span");
      option.setAttribute("role", "radio");
      option.addEventListener("click", () => {
        element.focus();
        this.choose(i);
      });
      row.append(option);
      return option;
    });
    // As with the menu buttons, pointing focuses the row only when the mouse really moves.
    element.addEventListener("mousemove", () => document.activeElement !== element && element.focus());
  }

  get value(): T {
    return this.choices[this.index];
  }

  /** Move the choice by `step`, wrapping around. */
  move(step: number): void {
    this.choose((this.index + step + this.choices.length) % this.choices.length);
  }

  /** Redraw every option, as after a change elsewhere that affects how they look. */
  redraw(): void {
    this.choices.forEach((c, i) => {
      this.draw(c, this.options[i]);
      this.options[i].setAttribute("aria-checked", String(i === this.index));
    });
  }

  private choose(i: number): void {
    if (i === this.index) return;
    this.index = i;
    this.onChange(this.value);
  }
}

import { Block } from "./blocks";

export interface CellChange {
  x: number;
  y: number;
  before: Block;
  after: Block;
  /** A sign's text, when `before` or `after` is a sign. */
  beforeText?: string;
  afterText?: string;
}

/**
 * One undoable action: every cell it changed, plus the inventory delta it caused.
 * Undo applies the reverse diff; redo applies the diff again.
 */
export interface Action {
  kind: "break" | "place";
  cells: CellChange[];
  inventory: Map<Block, number>;
}

/** Undo and redo are both stacks: only the most recent action can be undone. */
export class History {
  readonly undoStack: Action[] = [];
  readonly redoStack: Action[] = [];

  /** A fresh action invalidates everything that could have been redone. */
  record(a: Action): void {
    this.undoStack.push(a);
    this.redoStack.length = 0;
  }
}

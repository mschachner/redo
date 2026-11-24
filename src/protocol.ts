/**
 * Messages between the game and the multiplayer server, sent as JSON over a WebSocket.
 * Blocks travel as Block enum numbers, so the page and the server must be the same build.
 */
import type { Block } from "./blocks";

/** One cell's change: what it holds now and what it becomes. */
export interface Change {
  x: number;
  y: number;
  from: Block;
  to: Block;
  /** A sign's text, when `to` is a sign. */
  text?: string;
}

export type Facing = "up" | "down" | "left" | "right";

export interface PlayerInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  facing: Facing;
}

/** An undoable action, for keeping on the server: cells as x, y, before, after, sign texts. */
export interface WireAction {
  kind: "break" | "place";
  cells: [number, number, number, number, string | null, string | null][];
  inventory: [number, number][];
}

/** What the server keeps of a player between visits, by name. */
export interface PlayerState {
  x: number;
  y: number;
  hp: number;
  facing: Facing;
  /** The world's day when this was saved: a morning since then commits the stacks. */
  day: number;
  inventory: [number, number][];
  selected: number | null;
  keptSlots: number;
  daySlots: number;
  undo: WireAction[];
  redo: WireAction[];
}

/** A monster as the server reports it: id, kind (index into MONSTER_KINDS), x, y, hurt, winding up. */
export type MonsterInfo = [number, number, number, number, number, number];

/** From the page to the server. */
export type ClientMessage =
  | { t: "hello"; name: string; password?: string }
  | { t: "move"; x: number; y: number; facing: Facing }
  | { t: "request"; id: number; changes: Change[] }
  | { t: "say"; text: string }
  | { t: "broadcast"; text: string }
  | { t: "attack"; facing: Facing }
  | { t: "rest" }
  | { t: "state"; state: PlayerState };

/** From the server to the page. */
export type ServerMessage =
  | {
      t: "welcome";
      id: number;
      seed: string;
      /** Every changed cell's block, flattened as x, y, block. */
      cells: number[];
      signs: [number, number, string][];
      players: PlayerInfo[];
      /** This player's state from their last visit, if any. */
      you: PlayerState | null;
      hour: number;
      day: number;
    }
  | { t: "refused"; reason: string }
  | { t: "reply"; id: number; ok: boolean }
  | { t: "changes"; by: number; changes: Change[] }
  | { t: "positions"; players: [number, number, number, Facing][] }
  | { t: "joined"; player: PlayerInfo }
  | { t: "left"; id: number }
  | { t: "said"; id: number; text: string }
  | { t: "broadcast"; name: string; text: string }
  | { t: "monsters"; list: MonsterInfo[] }
  | { t: "hurt"; damage: number; fromX: number; cause: string }
  | { t: "hits"; events: string[] }
  | { t: "clock"; hour: number; day: number; asleep: number; online: number }
  | { t: "morning"; hour: number; day: number };

/** Longest name and chat line, in characters. */
export const MAX_NAME = 16;
export const MAX_TEXT = 120;

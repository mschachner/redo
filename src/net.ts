import type { Game, Peer, Shared } from "./game";
import type { Change, ClientMessage, Facing, PlayerState, ServerMessage } from "./protocol";
import { World } from "./world";

/** How often this player's position is sent, at most (ms). */
const MOVE_EVERY = 66;

/** What the server sends on joining: the shared world, ready to play in. */
export interface Joined {
  net: Net;
  world: World;
  /** The players already there. */
  peers: Peer[];
  /** This player's state from their last visit, if any. */
  you: PlayerState | null;
  hour: number;
  day: number;
}

/**
 * The connection to a multiplayer server. It sends this player's position, changes, chat
 * and broadcasts, and feeds what other players do into the game.
 */
export class Net implements Shared {
  /** The game being played over this connection; set once it exists. */
  game: Game | undefined;
  /** Called when the connection drops (not when it's closed on purpose). */
  onLost: (() => void) | undefined;
  private replies = new Map<number, (ok: boolean) => void>();
  private nextRequest = 1;
  private lastMove = 0;
  private sentMove = "";
  private closing = false;

  private constructor(
    private socket: WebSocket,
    readonly id: number,
    readonly peers: Peer[],
  ) {
    socket.addEventListener("message", (e) => this.receive(JSON.parse(String(e.data)) as ServerMessage));
    socket.addEventListener("close", () => {
      for (const resolve of this.replies.values()) resolve(false);
      this.replies.clear();
      if (!this.closing) this.onLost?.();
    });
  }

  /** Connect and join as `name`. Rejects with a short reason if that doesn't work. */
  static join(url: string, name: string, password: string): Promise<Joined> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        reject(new Error("can't reach server"));
        return;
      }
      let settled = false;
      socket.addEventListener("open", () => socket.send(JSON.stringify({ t: "hello", name, password } satisfies ClientMessage)));
      socket.addEventListener("error", () => {
        if (!settled) reject(new Error("can't reach server"));
        settled = true;
      });
      socket.addEventListener("close", () => {
        if (!settled) reject(new Error("can't reach server"));
        settled = true;
      });
      const first = (e: MessageEvent): void => {
        socket.removeEventListener("message", first);
        const m = JSON.parse(String(e.data)) as ServerMessage;
        settled = true;
        if (m.t === "refused") {
          reject(new Error(m.reason));
          socket.close();
          return;
        }
        if (m.t !== "welcome") {
          reject(new Error("unexpected reply"));
          socket.close();
          return;
        }
        const world = new World(m.seed);
        for (let i = 0; i + 2 < m.cells.length; i += 3) world.set(m.cells[i], m.cells[i + 1], m.cells[i + 2]);
        for (const [x, y, text] of m.signs) world.setSignText(x, y, text);
        const peers = m.players.map(peerFrom);
        resolve({ net: new Net(socket, m.id, peers), world, peers, you: m.you, hour: m.hour, day: m.day });
      };
      socket.addEventListener("message", first);
    });
  }

  close(): void {
    this.closing = true;
    this.socket.close();
  }

  request(changes: Change[]): Promise<boolean> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const id = this.nextRequest++;
    this.send({ t: "request", id, changes });
    return new Promise((resolve) => this.replies.set(id, resolve));
  }

  say(text: string): void {
    this.send({ t: "say", text });
  }

  broadcast(text: string): void {
    this.send({ t: "broadcast", text });
  }

  attack(facing: Facing): void {
    this.send({ t: "attack", facing });
  }

  rest(): void {
    this.send({ t: "rest" });
  }

  private sentState = "";

  /** Send this player's state for the server to keep, if it has changed. */
  sendState(state: PlayerState): void {
    const json = JSON.stringify(state);
    if (json === this.sentState) return;
    this.sentState = json;
    this.send({ t: "state", state });
  }

  /** Send this player's position, if it has changed and enough time has passed. */
  sendMove(x: number, y: number, facing: Facing): void {
    const now = performance.now();
    if (now - this.lastMove < MOVE_EVERY) return;
    const move = `${x.toFixed(2)},${y.toFixed(2)},${facing}`;
    if (move === this.sentMove) return;
    this.lastMove = now;
    this.sentMove = move;
    this.send({ t: "move", x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, facing });
  }

  private send(m: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(m));
  }

  private receive(m: ServerMessage): void {
    const game = this.game;
    switch (m.t) {
      case "reply": {
        const resolve = this.replies.get(m.id);
        this.replies.delete(m.id);
        resolve?.(m.ok);
        break;
      }
      case "changes":
        game?.remoteChanges(m.changes);
        break;
      case "positions":
        for (const [id, x, y, facing] of m.players) {
          const peer = this.peers.find((p) => p.id === id);
          if (!peer) continue;
          peer.x = x;
          peer.y = y;
          peer.facing = facing;
        }
        break;
      case "joined":
        if (m.player.id !== this.id && !this.peers.some((p) => p.id === m.player.id)) {
          this.peers.push(peerFrom(m.player));
          game?.note(`${m.player.name} joined`);
        }
        break;
      case "left": {
        const i = this.peers.findIndex((p) => p.id === m.id);
        if (i >= 0) {
          game?.note(`${this.peers[i].name} left`);
          this.peers.splice(i, 1);
        }
        break;
      }
      case "said":
        game?.peerSaid(m.id, m.text);
        break;
      case "broadcast":
        game?.showBroadcast(`${m.name}: ${m.text}`);
        break;
      case "monsters":
        game?.syncMonsters(m.list);
        break;
      case "hurt":
        game?.remoteHurt(m.damage, m.fromX, m.cause);
        break;
      case "hits":
        if (m.events.length) game?.note(m.events.join("; "));
        break;
      case "clock":
        game?.syncClock(m.hour, m.day, m.asleep, m.online);
        break;
      case "morning":
        game?.morning(m.hour, m.day);
        break;
    }
  }
}

function peerFrom(p: { id: number; name: string; x: number; y: number; facing: Facing }): Peer {
  return { id: p.id, name: p.name, x: p.x, y: p.y, facing: p.facing, drawX: p.x, drawY: p.y, speech: undefined };
}

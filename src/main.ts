import { Game } from "./game";

/** The console's modes, in the order Tab cycles through them. */
const COMMS = ["say", "sign", "broadcast"] as const;
type Comms = (typeof COMMS)[number];
import { Input } from "./input";
import { Net } from "./net";
import { exportState, importState } from "./playerstate";
import { Renderer } from "./render";
import { normalizeSeed, randomSeedName } from "./seeds";
import {
  deleteWorld,
  listWorlds,
  loadWorld,
  newWorldId,
  restoreSnapshot,
  saveWorld,
  Snapshot,
  snapshot,
  WorldMeta,
  worldName,
} from "./save";
import { World } from "./world";

/** A seed given in the page URL (?seed=…), if any. */
function seedFromUrl(): string | undefined {
  const given = new URL(window.location.href).searchParams.get("seed");
  return given ? normalizeSeed(given) : undefined;
}

/** Record the current world's seed in the URL, so it can be revisited. */
function showSeedInUrl(seed: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("seed", seed);
  window.history.replaceState(null, "", url);
}

/** Wire a settings checkbox to the game, remembering its value in this browser. */
function bindSetting(id: string, key: string, fallback: boolean, apply: (on: boolean) => void): void {
  const box = document.getElementById(id) as HTMLInputElement;
  let on = fallback;
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) on = stored === "1";
  } catch {
    // Storage unavailable: use the default.
  }
  box.checked = on;
  apply(on);
  box.addEventListener("change", () => {
    apply(box.checked);
    try {
      localStorage.setItem(key, box.checked ? "1" : "0");
    } catch {
      // Storage unavailable: the setting lasts for this visit only.
    }
  });
}

type Screen = "menu" | "worlds" | "join" | "settings" | "save-prompt" | "playing";

/** How far holding minus zooms out (cell size relative to normal). */
const MIN_ZOOM = 0.5;
/** Seconds of play between automatic saves. */
const AUTOSAVE_INTERVAL = 30;
/** Seconds between sending this player's state to a shared world's server. */
const SHARED_SAVE_INTERVAL = 2;
/** A world nobody has changed is only kept once it has been played this long (seconds). */
const KEEP_AFTER = 30;

/** When a world was last played, briefly. */
function playedAgo(t: number): string {
  const minutes = Math.floor((Date.now() - t) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function main(): Promise<void> {
  await document.fonts.load('16px "Atkinson Hyperlegible Mono"').catch(() => undefined);

  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  const input = new Input(window);
  const renderer = new Renderer(canvas);
  let autoStep = true;

  /** The world being played; undefined until one is started or loaded. */
  let game: Game | undefined;
  /** Its save slot, once it has one, and its name. */
  let gameId: string | undefined;
  let gameName = "";
  /** The world as it was saved when it was opened, for "Don't save" to put back. */
  let openedAs: Snapshot | undefined;
  let pendingSeed = seedFromUrl();
  let sinceSave = 0;

  const newGame = (seed: string): Game => {
    const g = new Game(new World(seed), input);
    g.autoStep = autoStep;
    return g;
  };

  // Behind the menus before any game has started: a still view of a world of its own.
  const demo = newGame(randomSeedName());
  demo.hour = 8 + Math.random() * 8;

  bindSetting("hints", "redo.hints", true, (on) => {
    renderer.hints = on;
    document.body.classList.toggle("hints", on);
  });
  bindSetting("auto-step", "redo.autoStep", true, (on) => {
    autoStep = on;
    if (game) game.autoStep = on;
  });

  let backgroundDrawn = false;
  const menu = document.getElementById("menu")!;
  const worlds = document.getElementById("worlds")!;
  const worldList = document.getElementById("world-list")!;
  const worldsHint = worlds.querySelector(".worlds-hint")!;
  const settings = document.getElementById("settings")!;
  const savePrompt = document.getElementById("save-prompt")!;
  const join = document.getElementById("join")!;
  const joinForm = document.getElementById("join-form") as HTMLFormElement;
  const joinName = document.getElementById("join-name") as HTMLInputElement;
  const joinStatus = document.getElementById("join-status")!;
  const joinPasswordField = document.getElementById("join-password-field")!;
  const joinPassword = document.getElementById("join-password") as HTMLInputElement;
  const savePromptName = document.getElementById("save-prompt-name")!;
  const seedLine = document.getElementById("seed")!;
  const seedText = document.getElementById("seed-text")!;
  const seedLabel = document.getElementById("seed-label")!;
  /** Copy the current world's seed, and say so on the seed line for a moment. */
  let copiedTimer = 0;
  const copySeed = (): void => {
    if (!game) return;
    void navigator.clipboard
      ?.writeText(game.world.seedName)
      .then(() => {
        seedLabel.textContent = "copied";
        window.clearTimeout(copiedTimer);
        copiedTimer = window.setTimeout(() => (seedLabel.textContent = "seed"), 1200);
      })
      .catch(() => undefined);
  };
  seedText.addEventListener("click", copySeed);
  const resume = menu.querySelector<HTMLButtonElement>('[data-action="resume"]')!;
  let screen: Screen = "menu";

  /** Show a screen. The menus show the paused game behind them, or the demo world. */
  const show = (next: Screen): void => {
    screen = next;
    menu.classList.toggle("hidden", next !== "menu");
    worlds.classList.toggle("hidden", next !== "worlds");
    settings.classList.toggle("hidden", next !== "settings");
    savePrompt.classList.toggle("hidden", next !== "save-prompt");
    join.classList.toggle("hidden", next !== "join");
    resume.hidden = !game;
    seedLine.hidden = !game;
    renderer.hud = next === "playing";
    renderer.zoom = 1;
    input.enabled = next === "playing";
    input.reset();
    if (game) game.light = renderer.light;
    const overlay = overlayFor(next);
    if (next === "worlds") listSavedWorlds();
    // On the world list, start on the most recently played world, if there is one; on
    // the join screen, in the name field.
    if (next === "join") {
      // Ask for a password only if the server wants one.
      fetch("/info")
        .then((r) => r.json() as Promise<{ password: boolean }>)
        .then((info) => (joinPasswordField.hidden = !info.password))
        .catch(() => undefined);
      joinName.focus();
      joinName.select();
    } else if (overlay) (overlay === worlds ? worldRows()[0] ?? buttons(worlds)[0] : buttons(overlay)[0])?.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  };

  const overlayFor = (s: Screen): HTMLElement | undefined =>
    s === "menu"
      ? menu
      : s === "worlds"
        ? worlds
        : s === "join"
          ? join
          : s === "settings"
          ? settings
          : s === "save-prompt"
            ? savePrompt
            : undefined;

  /**
   * Save the world being played. A new world gets a save slot once it has been changed or
   * played for a while, so passing through worlds with R doesn't fill the list.
   */
  const saveGame = (): void => {
    sinceSave = 0;
    if (!game) return;
    if (game.shared) {
      // A shared world is saved by its server, this player's part included.
      (game.shared as Net).sendState(exportState(game));
      return;
    }
    if (!gameId) {
      if (game.world.editCount === 0 && game.playTime < KEEP_AFTER) return;
      gameId = newWorldId();
    }
    if (!saveWorld({ id: gameId, name: gameName, seed: game.world.seedName }, game)) game.note("Couldn't save: storage full");
  };

  /** Make a game the one being played. */
  const play = (g: Game, id: string | undefined, name: string): void => {
    if (game && game !== g && game.shared) (game.shared as Net).close();
    game = g;
    gameId = id;
    gameName = name;
    openedAs = id ? snapshot(id) : undefined;
    game.autoStep = autoStep;
    if (!g.shared) showSeedInUrl(g.world.seedName);
    seedText.textContent = g.world.seedName;
    renderer.reset();
    game.light = renderer.light;
    (window as unknown as { game: Game }).game = game; // for poking at from the console
    show("playing");
  };

  /** Start a fresh world and play it. */
  const startWorld = (seed: string): void => {
    saveGame();
    const g = newGame(seed);
    play(g, undefined, worldName(g));
  };

  /** Whether leaving the current world would lose anything: it's saved, or worth saving. */
  const worthSaving = (): boolean =>
    !!game && (!!gameId || game.world.editCount > 0 || game.playTime >= KEEP_AFTER);

  /**
   * Leave the current world for a new one without saving it: the world list goes back to
   * how it was when this world was opened (a new world drops out of it).
   */
  const discardAndStart = (): void => {
    if (gameId) {
      if (openedAs) restoreSnapshot(openedAs);
      else deleteWorld(gameId);
    }
    game = undefined;
    gameId = undefined;
    startWorld(randomSeedName());
  };

  /** Join the multiplayer server this page came from, under the name in the join form. */
  let joining = false;
  const joinServer = (): void => {
    const name = joinName.value.trim();
    if (!name || joining) {
      if (!name) joinStatus.textContent = "name needed";
      return;
    }
    try {
      localStorage.setItem("redo.name", name);
    } catch {
      // Storage unavailable: the name isn't remembered.
    }
    joining = true;
    joinStatus.textContent = "";
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    Net.join(url, name, joinPassword.value)
      .then(({ net, world, peers, you, hour, day }) => {
        saveGame(); // the singleplayer world being left, if any
        const g = new Game(world, input);
        g.shared = net;
        g.peers = peers;
        g.hour = hour;
        g.day = day;
        if (you) importState(g, you);
        net.game = g;
        net.onLost = () => {
          if (game !== g) return;
          game = undefined;
          backgroundDrawn = false;
          joinStatus.textContent = "connection lost";
          show("join");
        };
        play(g, undefined, "");
      })
      .catch((e: Error) => {
        joinStatus.textContent = e.message;
      })
      .finally(() => (joining = false));
  };
  try {
    joinName.value = localStorage.getItem("redo.name") ?? "";
  } catch {
    // Storage unavailable: start empty.
  }
  joinForm.addEventListener("submit", (e) => e.preventDefault()); // Enter is handled with the other keys

  /** Load a saved world and play it. */
  const openWorld = (meta: WorldMeta): void => {
    if (meta.id === gameId && game) return show("playing");
    saveGame();
    const g = loadWorld(meta.id, input);
    if (g) play(g, meta.id, meta.name);
    else listSavedWorlds(); // unreadable: leave the list as it is
  };

  const worldRows = (): HTMLButtonElement[] => [...worldList.querySelectorAll<HTMLButtonElement>("button")];

  /** Fill the world list: one row per saved world, most recently played first. */
  const listSavedWorlds = (): void => {
    const saved = listWorlds();
    worldList.replaceChildren(
      ...saved.map((meta) => {
        const row = document.createElement("button");
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = meta.name;
        const when = document.createElement("span");
        when.className = "meta";
        when.textContent = `day ${meta.day} · ${playedAgo(meta.played)}`;
        const cross = document.createElement("span");
        cross.className = "delete";
        cross.textContent = "×";
        row.append(name, when, cross);
        const disarm = (): void => {
          row.classList.remove("armed");
          when.textContent = `day ${meta.day} · ${playedAgo(meta.played)}`;
        };
        // Deleting takes two presses (X, or a click on the cross): the first arms the row.
        const askDelete = (): void => {
          if (!row.classList.contains("armed")) {
            row.classList.add("armed");
            when.textContent = "delete?";
            return;
          }
          const i = worldRows().indexOf(row);
          deleteWorld(meta.id);
          if (meta.id === gameId) {
            game = undefined;
            gameId = undefined;
            backgroundDrawn = false;
          }
          listSavedWorlds();
          const rows = worldRows();
          (rows[Math.min(i, rows.length - 1)] ?? buttons(worlds)[0])?.focus();
        };
        row.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).classList.contains("delete")) askDelete();
          else openWorld(meta);
        });
        row.addEventListener("keydown", (e) => {
          if (e.code === "KeyX" && !e.repeat) askDelete();
        });
        row.addEventListener("blur", disarm);
        row.addEventListener("mouseenter", () => row.focus());
        return row;
      }),
    );
    worldsHint.classList.toggle("shown", saved.length > 0);
  };

  /** The items of a menu screen that keyboard navigation moves between. */
  const buttons = (overlay: HTMLElement): (HTMLButtonElement | HTMLInputElement)[] =>
    [...overlay.querySelectorAll<HTMLButtonElement | HTMLInputElement>(".field input, .toggles input, .choices button")].filter(
      (b) => !b.disabled && !b.hidden,
    );

  const act = (action: string | undefined): void => {
    if (action === "singleplayer") {
      saveGame(); // so the world being played is listed as it is now
      show("worlds");
    } else if (action === "multiplayer") {
      if (game?.shared) show("playing");
      else {
        joinStatus.textContent = "";
        show("join");
      }
    } else if (action === "join") {
      joinServer();
    } else if (action === "new-world") {
      startWorld(pendingSeed ?? randomSeedName());
      pendingSeed = undefined;
    } else if (action === "save-new") startWorld(randomSeedName());
    else if (action === "discard-new") discardAndStart();
    else if (action === "cancel-new") show("playing");
    else if (action === "resume" && game) show("playing");
    else if (action === "settings") show("settings");
    else if (action === "back") show("menu");
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>(".choices button[data-action]")) {
    b.addEventListener("click", () => act(b.dataset.action));
    b.addEventListener("mouseenter", () => !b.disabled && b.focus());
  }

  // The console: one line of text to say, put on a sign, or broadcast. Tab switches.
  const consoleForm = document.getElementById("console") as HTMLFormElement;
  const consoleLabel = document.getElementById("console-label")!;
  const consoleInput = document.getElementById("console-input") as HTMLInputElement;
  let consoleMode: Comms | undefined;
  /** Show the mode, and for broadcast, the seconds left until it is allowed again. */
  const labelConsole = (): void => {
    if (!consoleMode) return;
    const wait = consoleMode === "broadcast" && game ? Math.ceil(game.broadcastCooldown) : 0;
    const text = wait > 0 ? `${consoleMode} ${wait}s` : consoleMode;
    if (consoleLabel.textContent !== text) {
      consoleLabel.textContent = text;
      consoleLabel.style.width = `${text.length + 2}ch`;
    }
    consoleLabel.classList.toggle("waiting", wait > 0);
  };
  const openConsole = (mode: Comms): void => {
    consoleMode = mode;
    labelConsole();
    consoleInput.value = "";
    consoleForm.classList.remove("hidden");
    input.enabled = false;
    input.reset();
    consoleInput.focus();
  };
  const closeConsole = (): void => {
    consoleMode = undefined;
    consoleForm.classList.add("hidden");
    consoleInput.blur();
    input.enabled = screen === "playing";
    input.reset();
  };
  consoleForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = consoleInput.value.trim();
    if (text && game) {
      if (consoleMode === "say") game.say(text);
      else if (consoleMode === "sign") game.placeSign(text);
      else if (!game.broadcast(text)) return; // still cooling down: keep the text
    }
    closeConsole();
  });
  consoleInput.addEventListener("keydown", (e) => {
    if (e.code !== "Tab" || !consoleMode) return;
    e.preventDefault();
    const i = COMMS.indexOf(consoleMode);
    consoleMode = COMMS[(i + (e.shiftKey ? COMMS.length - 1 : 1)) % COMMS.length];
    labelConsole();
  });

  window.addEventListener("keydown", (e) => {
    if (consoleMode) {
      // Typing goes to the console; Esc closes it without sending.
      if (e.code === "Escape") {
        e.preventDefault();
        closeConsole();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (screen === "playing") {
      if (e.code === "Escape") {
        saveGame();
        show("menu");
      } else if (e.code === "KeyR" && !e.repeat && !game?.shared) {
        // Ask whether to keep this world first, unless there's nothing in it to keep.
        if (worthSaving()) {
          savePromptName.textContent = gameName;
          show("save-prompt");
        } else startWorld(randomSeedName());
      }
      else if (e.code === "KeyT" && !e.repeat) {
        e.preventDefault(); // so the T isn't typed into the console
        openConsole("say");
      }
      return;
    }
    // In a text field, keys type; only Enter (join), Esc (back) and the arrow keys (move
    // on) do more.
    if (document.activeElement instanceof HTMLInputElement && ["text", "password"].includes(document.activeElement.type)) {
      if (e.code === "Enter" || e.code === "NumpadEnter") joinServer();
      else if (e.code === "Escape") show("menu");
      else if (e.code === "ArrowDown") buttons(overlayFor(screen)!)[0]?.focus();
      else return;
      e.preventDefault();
      return;
    }
    // Menus: J and K (or W/S, or the arrow keys) move down and up; Enter picks.
    const overlay = overlayFor(screen)!;
    const list = buttons(overlay);
    const at = list.indexOf(document.activeElement as HTMLButtonElement | HTMLInputElement);
    if (e.code === "ArrowDown" || e.code === "KeyS" || e.code === "KeyJ") {
      list[(at + 1) % list.length]?.focus();
      e.preventDefault();
    } else if (e.code === "ArrowUp" || e.code === "KeyW" || e.code === "KeyK") {
      list[(at - 1 + list.length) % list.length]?.focus();
      e.preventDefault();
    } else if (e.code === "Enter" || e.code === "NumpadEnter") {
      // Enter picks a button and toggles a checkbox; with nothing selected, it selects the first item.
      if (at >= 0) list[at].click();
      else list[0]?.focus();
      e.preventDefault();
    } else if (e.code === "Space") {
      e.preventDefault(); // Enter is the one key that picks
    } else if (e.code === "KeyC" && screen === "menu" && game) {
      copySeed();
    } else if (e.code === "Escape" && screen === "save-prompt") {
      show("playing");
    } else if (e.code === "Escape" && screen !== "menu") {
      show("menu");
    }
  });

  window.addEventListener("resize", () => (backgroundDrawn = false));
  // Save when the page is hidden or closed, since it may not come back.
  document.addEventListener("visibilitychange", () => document.hidden && saveGame());
  window.addEventListener("pagehide", saveGame);

  show("menu");
  let last = performance.now();
  const frame = (now: number) => {
    // Scheduled first, so an error in one frame can't stop the game.
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const playing = screen === "playing" && game !== undefined;
    if (playing) {
      game!.update(dt);
      if (game!.shared) {
        const p = game!.player;
        (game!.shared as Net).sendMove(p.x, p.y, p.facing);
      }
      sinceSave += dt;
      // Resting commits the world, so it's a natural point to save it too.
      if (game!.rested) {
        game!.rested = false;
        saveGame();
      } else if (sinceSave >= (game!.shared ? SHARED_SAVE_INTERVAL : AUTOSAVE_INTERVAL)) saveGame();
      // Holding minus eases the view out; letting go brings it back in quickly.
      const out = input.held.has("Minus");
      const target = out ? MIN_ZOOM : 1;
      renderer.zoom += (target - renderer.zoom) * (1 - Math.exp(-dt * (out ? 2.2 : 9)));
      if (Math.abs(renderer.zoom - target) < 0.002) renderer.zoom = target;
      labelConsole();
      renderer.background = false;
      renderer.draw(game!, dt);
      backgroundDrawn = false;
    } else if (!backgroundDrawn) {
      // Behind the menus nothing moves, so the (CSS-blurred) scene is drawn just once.
      renderer.background = true;
      renderer.draw(game ?? demo, dt);
      backgroundDrawn = true;
    }
  };
  requestAnimationFrame(frame);
}

void main();

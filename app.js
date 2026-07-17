// app.js
// Main controller: screen navigation + wiring between UI, local AI game,
// and multiplayer.

import { auth, ensureSignedIn } from "./firebase-init.js";
import {
  BOARD_SIZE, renderBoard, cellLabel, createEmptyGrid, buildShipCellMap,
} from "./board.js";
import { SHAPES, getShipCells, getShapeBounds, isPlacementValid, cellsToSet, SHIPS_PER_PLAYER } from "./ship-shapes.js";
import { LocalGame } from "./game-local.js";
import * as MP from "./multiplayer.js";

const screens = {
  login: document.getElementById("screen-login"),
  menu: document.getElementById("screen-menu"),
  placement: document.getElementById("screen-placement"),
  game: document.getElementById("screen-game"),
  privateRoom: document.getElementById("screen-private-room"),
  tournament: document.getElementById("screen-tournament"),
};

const state = {
  name: "",
  uid: null,
  mode: null,       // "ai" | "pvp"
  difficulty: "medium",
  gameId: null,
  localGame: null,
  myShips: [],      // placed ships this session: { cells, headCell }
  rotation: 0,
  unsubGame: null,
};

function showScreen(key) {
  Object.values(screens).forEach((el) => el.classList.remove("active"));
  screens[key].classList.add("active");
}

// ---------- LOGIN ----------
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("username-input");
  const name = input.value.trim();
  if (!name) return;
  state.name = name;

  const user = await ensureSignedIn();
  state.uid = user.uid;

  // Presence heartbeat: lets everyone see a live "players online" count,
  // broken down by what people are currently doing.
  state.presenceStatus = "idle";
  MP.heartbeatPresence(state.uid, state.name, state.presenceStatus).catch(() => {});
  state.presenceInterval = setInterval(() => {
    MP.heartbeatPresence(state.uid, state.name, state.presenceStatus).catch(() => {});
  }, 20000);
  MP.listenOnlineCount(({ online, searching, inGame }) => {
    const el = document.getElementById("online-count");
    if (el) {
      el.innerHTML =
        `${online} ${online === 1 ? "jucator" : "jucatori"} online` +
        `<br><span class="stat-dim">${searching} in lobby (cauta adversar) · ${inGame} in joc</span>`;
    }
    const tournamentBtn = document.getElementById("btn-tournament-menu");
    if (tournamentBtn) {
      tournamentBtn.disabled = online < 4;
      tournamentBtn.textContent = online < 4
        ? "Turneu (necesita minim 4 jucatori online)"
        : "Turneu";
    }
  });

  // Global chat.
  MP.listenChat((messages) => {
    state.chatMessages = messages;
    renderChat(messages);
  });
  state.chatExpireInterval = setInterval(() => {
    if (state.chatMessages) renderChat(state.chatMessages);
  }, 15000);

  showScreen("menu");
});

function setPresenceStatus(status) {
  if (state.presenceStatus === status) return;
  state.presenceStatus = status;
  if (state.uid) MP.heartbeatPresence(state.uid, state.name, status).catch(() => {});
}

// ---------- MENU ----------
document.getElementById("btn-vs-ai").addEventListener("click", () => {
  showMenuNotice("");
  state.mode = "ai";
  state.opponentFound = true; // no matchmaking needed
  startPlacement();
});

document.getElementById("btn-vs-player").addEventListener("click", async () => {
  showMenuNotice("");
  state.mode = "pvp";
  state.matchMethod = "quickMatch";
  state.opponentFound = false;
  startPlacement(true);
  await searchForOpponent();
});

/** Starts (or restarts) a quick-match search. Stays on the placement screen. */
async function searchForOpponent() {
  setPresenceStatus("searching");
  setStatus("placement", "Se cauta un adversar...");
  updatePlacementInfo();
  const cancel = await MP.quickMatch(state.uid, state.name, (gameId) => {
    state.gameId = gameId;
    state.opponentFound = true;
    setStatus("placement", "Adversar gasit! Plaseaza-ti avioanele.");
    refreshConfirmButtonAvailability();
    updatePlacementInfo();
    subscribeMultiplayerGame(); // listen from now on, so we catch it if the opponent leaves before we've both confirmed
  });
  state.cancelQuickMatch = cancel;
}

document.getElementById("btn-private-room").addEventListener("click", () => {
  showMenuNotice("");
  showScreen("privateRoom");
});

document.getElementById("btn-back-to-login").addEventListener("click", () => {
  showScreen("login");
});

document.getElementById("btn-back-to-menu-from-room").addEventListener("click", () => {
  showScreen("menu");
});

document.getElementById("btn-back-to-menu-from-placement").addEventListener("click", async () => {
  // If we'd already been matched with someone, tell them we're leaving so
  // they don't get stuck waiting forever for a placement that never comes.
  if (state.mode === "pvp" && state.gameId) {
    await MP.abandonDuringPlacement(state.gameId, state.uid).catch(() => {});
  }
  cleanupGameState();
  showScreen("menu");
});

document.getElementById("btn-create-room").addEventListener("click", async () => {
  const password = document.getElementById("room-password-input").value.trim();
  const gameId = await MP.createPrivateRoom(state.uid, state.name, password);
  state.mode = "pvp";
  state.matchMethod = "privateRoom";
  state.gameId = gameId;
  state.opponentFound = false; // still waiting for a second player to join
  document.getElementById("room-code-display").textContent =
    `Cod camera: ${gameId} — trimite-l adversarului.`;
  subscribeMultiplayerGame();
  waitForOpponentThenPlace(gameId);
});

document.getElementById("btn-join-room").addEventListener("click", async () => {
  const code = document.getElementById("room-code-input").value.trim().toUpperCase();
  const password = document.getElementById("join-password-input").value.trim();
  try {
    await MP.joinPrivateRoom(code, state.uid, state.name, password);
    state.mode = "pvp";
    state.matchMethod = "privateRoom";
    state.gameId = code;
    state.opponentFound = true; // joining an existing room means the opponent is already there
    subscribeMultiplayerGame();
    startPlacement(true);
  } catch (err) {
    document.getElementById("private-room-error").textContent = err.message;
  }
});

function waitForOpponentThenPlace(gameId) {
  const unsub = MP.listenToGame(gameId, (data) => {
    if (data.status === "placing" || data.order.length === 2) {
      unsub();
      state.opponentFound = true;
      startPlacement(true);
    }
  });
}

// ---------- PLACEMENT ----------
const SHIP_LABELS = ["primul", "al doilea", "al treilea"];

function startPlacement(isMultiplayer = false) {
  state.myShips = [];
  state.rotation = 0;
  if (state.mode === "pvp") setPresenceStatus("placing");
  showScreen("placement");
  updatePlacementInfo();
  refreshConfirmButtonAvailability();

  const container = document.getElementById("placement-board-container");
  if (!container.dataset.hoverBound) {
    container.addEventListener("mousemove", (e) => {
      const cell = e.target.closest(".board-slot");
      if (!cell) return;
      const r = Number(cell.dataset.row);
      const c = Number(cell.dataset.col);
      if (hoverAnchor && hoverAnchor[0] === r && hoverAnchor[1] === c) return;
      hoverAnchor = [r, c];
      drawPlacementBoard();
    });
    container.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      rotateShip();
    });
    container.dataset.hoverBound = "true";
  }

  drawShipPreview();
  drawPlacementBoard();
}

function updatePlacementInfo() {
  const count = state.myShips.length;
  const infoEl = document.getElementById("placement-info");
  const searching = state.mode === "pvp" && !state.opponentFound;
  if (count >= SHIPS_PER_PLAYER) {
    if (searching) {
      infoEl.textContent = `Ai plasat toate cele ${SHIPS_PER_PLAYER} avioane. Asteptam sa se gaseasca un adversar inainte sa poti confirma.`;
    } else {
      infoEl.textContent = `Ai plasat toate cele ${SHIPS_PER_PLAYER} avioane. Apasa "Confirma plasarea" cand esti gata.`;
    }
  } else {
    infoEl.textContent =
      `Plaseaza ${SHIP_LABELS[count]} avion (${count}/${SHIPS_PER_PLAYER}). ` +
      `Muta mouse-ul pe harta pentru previzualizare, click pentru a plasa. ` +
      `Foloseste butonul "Roteste" (sau tasta R) ca sa schimbi orientarea inainte de a plasa.` +
      (searching ? " (Cautam un adversar in fundal...)" : "");
  }
}

let hoverAnchor = null;

function drawPlacementBoard() {
  const container = document.getElementById("placement-board-container");
  const shipCellSet = cellsToSet(state.myShips.flatMap((s) => s.cells)); // for validity checks
  const shipCellMap = buildShipCellMap(state.myShips); // for rendering + distinct outlines
  let hoverCells = new Set();
  let hoverInvalid = false;

  if (hoverAnchor && state.myShips.length < SHIPS_PER_PLAYER) {
    const [r, c] = hoverAnchor;
    if (isPlacementValid(r, c, state.rotation, shipCellSet, BOARD_SIZE)) {
      hoverCells = cellsToSet(getShipCells(r, c, state.rotation));
    } else {
      hoverInvalid = true;
    }
  }

  renderBoard(container, {
    mode: "placement",
    shipCellMap,
    hoverCells,
    onCellClick: (r, c) => {
      if (state.myShips.length >= SHIPS_PER_PLAYER) return;

      // First tap on a cell (or a different cell than the current preview)
      // just moves the preview there — this is what makes placement usable
      // on touch screens, which have no hover. Tapping the SAME cell again
      // confirms the placement. On desktop this still feels like one click,
      // since mousemove already moved the preview here before you clicked.
      const isSameAsPreview = hoverAnchor && hoverAnchor[0] === r && hoverAnchor[1] === c;
      if (!isSameAsPreview) {
        hoverAnchor = [r, c];
        drawPlacementBoard();
        return;
      }

      if (!isPlacementValid(r, c, state.rotation, shipCellSet, BOARD_SIZE)) return;
      const cells = getShipCells(r, c, state.rotation);
      state.myShips.push({ cells, headCell: cells[0] });
      hoverAnchor = null;
      drawPlacementBoard();
      updatePlacementInfo();
      refreshConfirmButtonAvailability();
    },
  });

  if (hoverInvalid) container.classList.add("invalid-preview");
  else container.classList.remove("invalid-preview");
}

// The confirm button needs BOTH: all ships placed AND (for PvP) an opponent
// already matched — otherwise gameId is still null and submitting would crash.
function refreshConfirmButtonAvailability() {
  const shipsReady = state.myShips.length === SHIPS_PER_PLAYER;
  const opponentReady = state.mode !== "pvp" || state.opponentFound;
  document.getElementById("btn-confirm-placement").disabled = !(shipsReady && opponentReady);
}

function rotateShip() {
  state.rotation = (state.rotation + 1) % 4;
  drawShipPreview();
  drawPlacementBoard();
}

document.getElementById("btn-rotate-ship").addEventListener("click", rotateShip);

// Mini preview of the plane's shape + which cell you'll click (the anchor,
// marked in amber) — helps a lot on mobile where there's no hover preview.
function drawShipPreview() {
  const el = document.getElementById("ship-preview");
  if (!el) return;
  const { rows, cols } = getShapeBounds(state.rotation);
  const shipCells = cellsToSet(SHAPES[state.rotation].map(([r, c]) => [r, c]));

  el.style.gridTemplateColumns = `repeat(${cols}, 18px)`;
  el.style.gridTemplateRows = `repeat(${rows}, 18px)`;
  el.innerHTML = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement("div");
      cell.className = "ship-preview-cell";
      if (shipCells.has(`${r},${c}`)) cell.classList.add("filled");
      if (r === 0 && c === 0) cell.classList.add("anchor");
      el.appendChild(cell);
    }
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r" && screens.placement.classList.contains("active")) {
    rotateShip();
  }
});

document.getElementById("btn-undo-ship").addEventListener("click", () => {
  if (state.myShips.length === 0) return;
  state.myShips.pop();
  refreshConfirmButtonAvailability();
  drawPlacementBoard();
  updatePlacementInfo();
});

document.getElementById("btn-confirm-placement").addEventListener("click", async () => {
  if (state.mode === "ai") {
    state.localGame = new LocalGame(state.myShips, state.difficulty);
    state.localResultShown = false;
    enterGameScreen();
  } else {
    await MP.submitShipPlacement(state.gameId, state.uid, state.myShips);
    document.getElementById("placement-info").textContent = "Asteptam ca adversarul sa termine plasarea...";
  }
});

document.querySelectorAll("input[name=difficulty]").forEach((el) => {
  el.addEventListener("change", (e) => { state.difficulty = e.target.value; });
});

// ---------- GAME CONTROLS: new game / quit ----------
function isGameUnfinished() {
  if (state.mode === "ai") return !!state.localGame && !state.localGame.winner;
  if (state.mode === "pvp") return state.lastGameStatus && state.lastGameStatus !== "finished";
  return false;
}

function cleanupGameState() {
  setPresenceStatus("idle");
  if (state.unsubGame) { state.unsubGame(); state.unsubGame = null; }
  if (state.cancelQuickMatch) { state.cancelQuickMatch(); state.cancelQuickMatch = null; }
  stopPvpPolling();
  state.localGame = null;
  state.gameId = null;
  state.lastGameStatus = null;
  state.aiMoveScheduled = false;
  state.opponentFound = false;
  state.opponentUid = null;
  state.matchMethod = null;
  state.resultAnimationPlayedForGameId = null;
  state.lastGameData = null;
}

// If leaving an unfinished PvP game, tell the opponent so they win by
// forfeit instead of being left waiting forever.
async function forfeitActivePvpGameIfNeeded() {
  if (state.mode === "pvp" && state.gameId && state.opponentUid && isGameUnfinished()) {
    try { await MP.forfeitGame(state.gameId, state.uid, state.opponentUid); } catch (e) { /* best effort */ }
  }
}

document.getElementById("btn-new-game").addEventListener("click", async () => {
  if (isGameUnfinished() && !confirm("Jocul curent nu s-a terminat inca. Daca incepi un joc nou, vei pierde partida in desfasurare. Continui?")) {
    return;
  }
  await forfeitActivePvpGameIfNeeded();
  const mode = state.mode;
  const difficulty = state.difficulty;
  cleanupGameState();
  if (mode === "ai") {
    state.mode = "ai";
    state.difficulty = difficulty;
    startPlacement();
  } else {
    showScreen("menu"); // PvP: o partida noua necesita cautare/creare camera noua
  }
});

document.getElementById("btn-quit-game").addEventListener("click", async () => {
  if (isGameUnfinished() && !confirm("Jocul curent nu s-a terminat inca. Daca inchizi, abandonezi partida. Continui?")) {
    return;
  }
  await forfeitActivePvpGameIfNeeded();
  cleanupGameState();
  showScreen("menu");
});

// ---------- LOCAL (vs AI) GAME ----------
function enterGameScreen() {
  showScreen("game");
  renderLocalGameState();
}

function renderLocalGameState() {
  const g = state.localGame;
  const enemyContainer = document.getElementById("enemy-board-container");
  const ownContainer = document.getElementById("own-board-container");

  renderBoard(enemyContainer, {
    mode: "attack",
    grid: g.gridPlayerSeesOfAI,
    onCellClick: (r, c) => {
      if (g.turn !== "player" || g.winner) return;
      g.playerFire(r, c);
      renderLocalGameState();
      if (g.winner) finishLocalGame();
    },
  });

  renderBoard(ownContainer, {
    mode: "own",
    shipCellMap: buildShipCellMap(state.myShips),
    grid: g.gridAISeesOfPlayer, // exactly the marks the AI has landed on your board
  });

  document.getElementById("game-status").textContent =
    g.winner ? "" : g.turn === "player" ? "Randul tau — ataca!" : "Calculatorul se gandeste...";

  driveAIIfNeeded();
}

// Fires whenever it becomes the AI's turn — covers both "AI moves after the
// human" AND "AI happens to go first" (the random starting player).
function driveAIIfNeeded() {
  const g = state.localGame;
  if (!g || g.winner || g.turn !== "ai" || state.aiMoveScheduled) return;
  state.aiMoveScheduled = true;
  setTimeout(() => {
    state.aiMoveScheduled = false;
    g.aiTurn();
    renderLocalGameState();
    if (g.winner) finishLocalGame();
  }, 700);
}

function finishLocalGame() {
  if (state.localResultShown) return;
  state.localResultShown = true;
  const won = state.localGame.winner === "player";
  showGameResult(
    won,
    won ? "Ai distrus toate cele 3 avioane ale calculatorului."
        : "Calculatorul ti-a distrus toate cele 3 avioane.",
  );
}

// ---------- MULTIPLAYER GAME ----------
function subscribeMultiplayerGame() {
  if (state.unsubGame) { state.unsubGame(); state.unsubGame = null; }
  state.unsubGame = MP.listenToGame(state.gameId, (data) => processGameSnapshot(data));
  startPvpPolling();
}

// Safety net alongside the live listener, and also what drives the turn
// countdown timer: ticks every 1.5s while a PvP game is active.
function startPvpPolling() {
  stopPvpPolling();
  state.pvpPollInterval = setInterval(async () => {
    if (state.mode !== "pvp" || !state.gameId) return;
    tickTurnTimer();
    try {
      const data = await MP.fetchGameOnce(state.gameId);
      if (data) await processGameSnapshot(data);
    } catch (e) { /* transient network error — will retry on the next tick */ }
  }, 1500);
}

function stopPvpPolling() {
  if (state.pvpPollInterval) {
    clearInterval(state.pvpPollInterval);
    state.pvpPollInterval = null;
  }
}

async function processGameSnapshot(data) {
  // The opponent backed out before the game actually started (during ship
  // placement). For quick-match games we auto-restart the search (keeping
  // whatever ships are already placed); for private rooms there's no one
  // else to auto-pair with, so we just explain and send the player back.
  if (data.status === "abandoned") {
    if (state.matchMethod === "quickMatch") {
      await restartSearchAfterOpponentLeft();
    } else {
      cleanupGameState();
      showMenuNotice("Adversarul a parasit inainte de inceperea jocului.");
      showScreen("menu");
    }
    return;
  }

  // Nothing else to do until the game has actually started.
  if (data.status !== "playing" && data.status !== "finished") return;

  state.lastGameData = data;

  if (!screens.game.classList.contains("active")) {
    showScreen("game");
    setPresenceStatus("playing");
  }

  let effectiveData = data;
  if (data.order.includes(state.uid)) {
    const resolved = await MP.resolvePendingShotIfMine(state.gameId, state.uid, data);
    if (resolved) {
      effectiveData = resolved;
      state.lastGameData = resolved;
    }
  }
  if (effectiveData.status === "playing") {
    await MP.expireTurnIfNeeded(state.gameId, effectiveData);
  }
  if (effectiveData.status === "finished" && effectiveData.tournamentId) {
    MP.advanceTournamentIfNeeded(
      effectiveData.tournamentId, effectiveData.round, effectiveData.matchIndex, effectiveData.winner,
    ).catch(() => {});
  }
  renderMultiplayerGameState(effectiveData);
}

/** Updates the on-screen countdown every tick, without waiting for a fresh snapshot. */
function tickTurnTimer() {
  const data = state.lastGameData;
  const timerEl = document.getElementById("turn-timer");
  if (!timerEl || !data || data.status !== "playing" || !data.turnStartedAt?.toMillis) {
    if (timerEl) timerEl.textContent = "";
    return;
  }
  const remainingMs = MP.TURN_TIME_LIMIT_MS - (Date.now() - data.turnStartedAt.toMillis());
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const whoseTurn = data.turn === state.uid ? "Timpul tau" : "Timpul adversarului";
  timerEl.textContent = `${whoseTurn}: ${remainingSec}s`;
  timerEl.classList.toggle("turn-timer-low", remainingSec <= 10);
}

/** Opponent left during placement — stay put, keep our ships, and look for someone else. */
async function restartSearchAfterOpponentLeft() {
  if (state.unsubGame) { state.unsubGame(); state.unsubGame = null; }
  stopPvpPolling();
  state.gameId = null;
  state.opponentFound = false;
  refreshConfirmButtonAvailability();
  setStatus("placement", "Adversarul a parasit jocul. Cautam un alt adversar...");
  updatePlacementInfo();
  await searchForOpponent();
}

function renderMultiplayerGameState(data) {
  state.lastGameStatus = data.status;

  if (!data.order.includes(state.uid)) {
    document.getElementById("game-status").textContent =
      "Sesiunea curenta nu mai corespunde acestui joc (posibil ai reincarcat pagina si ai primit o alta identitate anonima). Apasa \"Inchide jocul\" si reintra.";
    return;
  }

  const opponentUid = data.order.find((u) => u !== state.uid);
  state.opponentUid = opponentUid;
  const myHitsReceived = data.hits?.[state.uid] || {};
  const opponentHitsReceived = data.hits?.[opponentUid] || {};

  const attackGrid = createEmptyGrid();
  Object.entries(opponentHitsReceived).forEach(([key, result]) => {
    const [r, c] = key.split(",").map(Number);
    attackGrid[r][c] = result === "miss" ? "miss" : result === "hit" ? "hit" : "head";
  });

  renderBoard(document.getElementById("enemy-board-container"), {
    mode: "attack",
    grid: attackGrid,
    onCellClick: (r, c) => {
      if (data.turn !== state.uid || data.status === "finished") return;
      MP.fireShot(state.gameId, state.uid, r, c).catch((err) => {
        console.warn("Shot rejected:", err.message);
      });
    },
  });

  const myHitGrid = createEmptyGrid();
  Object.entries(myHitsReceived).forEach(([key, result]) => {
    const [r, c] = key.split(",").map(Number);
    myHitGrid[r][c] = result === "miss" ? "miss" : result === "hit" ? "hit" : "head";
  });

  renderBoard(document.getElementById("own-board-container"), {
    mode: "own",
    shipCellMap: buildShipCellMap(state.myShips),
    grid: myHitGrid,
  });

  let statusText = "";
  if (data.status === "finished") {
    const timerEl = document.getElementById("turn-timer");
    if (timerEl) { timerEl.textContent = ""; timerEl.classList.remove("turn-timer-low"); }
    if (state.resultAnimationPlayedForGameId !== state.gameId) {
      state.resultAnimationPlayedForGameId = state.gameId;
      const won = data.winner === state.uid;
      const reason = data.endReason === "left"
        ? "Adversarul a parasit jocul."
        : won
          ? "Ai distrus toate cele 3 avioane ale adversarului."
          : "Toate cele 3 avioane ale tale au fost distruse.";
      showGameResult(won, reason);
    }
    return;
  } else if (data.turn === state.uid) {
    statusText = "Randul tau — ataca!";
  } else {
    statusText = "Asteapta mutarea adversarului...";
  }
  document.getElementById("game-status").textContent = statusText;
}

function setStatus(screenKey, text) {
  const el = document.getElementById(`${screenKey}-status-text`);
  if (el) el.textContent = text;
}

function showMenuNotice(text) {
  const el = document.getElementById("menu-notice");
  if (el) el.textContent = text;
}

// ---------- GLOBAL CHAT (mIRC-style) ----------
function nameColor(uid) {
  // Deterministic color per uid, so the same person always gets the same
  // "nickname color" — a small mIRC-style touch.
  let hash = 0;
  for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) % 360;
  return `hsl(${hash}, 70%, 65%)`;
}

const CHAT_MESSAGE_LIFETIME_MS = 5 * 60 * 1000;

function renderChat(messages) {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const wasScrolledToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;

  const now = Date.now();
  const visible = messages.filter((m) => {
    // Messages that haven't been timestamped by the server yet (just sent,
    // still "pending") are always shown — they can't be expired yet.
    if (!m.createdAt?.toMillis) return true;
    return now - m.createdAt.toMillis() < CHAT_MESSAGE_LIFETIME_MS;
  });

  container.innerHTML = visible.map((m) => {
    const time = m.createdAt?.toDate
      ? m.createdAt.toDate().toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" })
      : "--:--";
    const safeName = escapeHtml(m.name || "?");
    const safeText = escapeHtml(m.text || "");
    return `<div class="chat-line"><span class="chat-time">[${time}]</span> <span class="chat-name" style="color:${nameColor(m.uid || "")}">&lt;${safeName}&gt;</span> ${safeText}</div>`;
  }).join("");

  if (wasScrolledToBottom) container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById("chat-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text || !state.uid) return;
  MP.sendChatMessage(state.uid, state.name, text).catch(() => {});
  input.value = "";
});

// ---------- WIN/LOSS VISUALS ----------
function showGameResult(won, reasonText) {
  const statusEl = document.getElementById("game-status");
  statusEl.innerHTML = "";
  const banner = document.createElement("div");
  banner.className = `result-banner ${won ? "win" : "lose"}`;
  banner.innerHTML = `
    <div class="result-title">${won ? "\u{1F3C6} Ai castigat!" : "\u{1F4A5} Ai pierdut."}</div>
    <div class="result-reason">${reasonText}</div>
  `;
  statusEl.appendChild(banner);

  if (won) launchConfetti(); else launchDebris();
}

function launchConfetti() {
  const overlay = document.createElement("div");
  overlay.className = "fx-overlay";
  document.body.appendChild(overlay);
  const colors = ["#39ff14", "#4cc9f0", "#f72585", "#ffb703", "#ffffff"];
  for (let i = 0; i < 70; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = `${(Math.random() * 0.5).toFixed(2)}s`;
    piece.style.animationDuration = `${(1.8 + Math.random() * 1.4).toFixed(2)}s`;
    overlay.appendChild(piece);
  }
  setTimeout(() => overlay.remove(), 3600);
}

function launchDebris() {
  const overlay = document.createElement("div");
  overlay.className = "fx-overlay";
  document.body.appendChild(overlay);
  for (let i = 0; i < 40; i++) {
    const piece = document.createElement("div");
    piece.className = "debris-piece";
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.animationDelay = `${(Math.random() * 0.5).toFixed(2)}s`;
    piece.style.animationDuration = `${(1.6 + Math.random() * 1.2).toFixed(2)}s`;
    overlay.appendChild(piece);
  }
  setTimeout(() => overlay.remove(), 3200);
}

// ---------- TOURNAMENTS ----------
document.getElementById("btn-tournament-menu").addEventListener("click", () => {
  showMenuNotice("");
  showScreen("tournament");
  document.getElementById("tournament-queue-view").style.display = "block";
  document.getElementById("tournament-bracket-view").style.display = "none";
  document.getElementById("tournament-queue-status").textContent = "";

  if (state.tournamentQueueCountsUnsub) state.tournamentQueueCountsUnsub();
  state.tournamentQueueCountsUnsub = MP.listenTournamentQueueCounts((counts) => {
    MP.TOURNAMENT_SIZES.forEach((size) => {
      const el = document.getElementById(`tq-count-${size}`);
      if (el) el.textContent = counts[size];
    });
  });
});

document.getElementById("btn-back-to-menu-from-tournament").addEventListener("click", async () => {
  if (state.tournamentQueueCountsUnsub) { state.tournamentQueueCountsUnsub(); state.tournamentQueueCountsUnsub = null; }
  if (state.tournamentAssignmentUnsub) { state.tournamentAssignmentUnsub(); state.tournamentAssignmentUnsub = null; }
  if (state.tournamentQueueSize && !state.tournamentId) {
    await MP.leaveTournamentQueue(state.uid, state.tournamentQueueSize).catch(() => {});
  }
  state.tournamentQueueSize = null;
  showScreen("menu");
});

[4, 8, 16].forEach((size) => {
  document.getElementById(`btn-tournament-${size}`).addEventListener("click", () => joinTournamentSize(size));
});

async function joinTournamentSize(size) {
  state.tournamentQueueSize = size;
  document.getElementById("tournament-queue-status").textContent =
    `Cautam jucatori pentru turneul de ${size}... ramai pe aceasta pagina.`;

  if (state.tournamentAssignmentUnsub) state.tournamentAssignmentUnsub();
  state.tournamentAssignmentUnsub = MP.listenTournamentAssignment(state.uid, (assignment) => {
    if (!assignment?.tournamentId) return;
    state.tournamentAssignmentUnsub();
    state.tournamentAssignmentUnsub = null;
    if (state.tournamentQueueCountsUnsub) { state.tournamentQueueCountsUnsub(); state.tournamentQueueCountsUnsub = null; }
    document.getElementById("tournament-queue-view").style.display = "none";
    document.getElementById("tournament-bracket-view").style.display = "block";
    subscribeTournament(assignment.tournamentId);
  });

  await MP.joinTournamentQueue(state.uid, state.name, size);
}

function subscribeTournament(tournamentId) {
  if (state.tournamentUnsub) { state.tournamentUnsub(); state.tournamentUnsub = null; }
  state.tournamentId = tournamentId;
  state.tournamentResultShown = false;
  state.tournamentUnsub = MP.listenTournament(tournamentId, (data) => handleTournamentUpdate(data));
}

function handleTournamentUpdate(data) {
  state.tournamentData = data;
  renderTournamentBracket(data);

  if (data.status === "finished") {
    showTournamentFinalScreen(data);
    return;
  }

  // Find the latest match (across all rounds so far) that involves me.
  let myMatch = null;
  data.rounds.forEach((roundObj) => {
    roundObj.matches.forEach((m) => {
      if (m.player1 === state.uid || m.player2 === state.uid) myMatch = m;
    });
  });
  if (!myMatch) return;

  if (myMatch.winner && myMatch.winner !== state.uid) {
    showTournamentEliminated();
    return;
  }
  if (myMatch.winner === state.uid) {
    showScreen("tournament");
    document.getElementById("tournament-queue-view").style.display = "none";
    document.getElementById("tournament-bracket-view").style.display = "block";
    setTournamentStatusText("Ai castigat acest meci! Asteptam sa se termine si celelalte meciuri din runda...");
    return;
  }

  // Active, unresolved match for me — join it if it's new (covers both the
  // very first match and every subsequent round's match automatically).
  if (myMatch.gameId && myMatch.gameId !== state.currentMatchGameId) {
    state.currentMatchGameId = myMatch.gameId;
    state.mode = "pvp";
    state.matchMethod = "tournament";
    state.gameId = myMatch.gameId;
    state.opponentFound = true;
    subscribeMultiplayerGame();
    startPlacement(true);
  }
}

function setTournamentStatusText(text) {
  const el = document.getElementById("tournament-status-text");
  if (el) el.textContent = text;
}

function roundName(totalRounds, round) {
  const fromEnd = totalRounds - 1 - round;
  if (fromEnd === 0) return "Finala";
  if (fromEnd === 1) return "Semifinale";
  if (fromEnd === 2) return "Sferturi de finala";
  if (fromEnd === 3) return "Optimi de finala";
  return `Runda ${round + 1}`;
}

function renderTournamentBracket(data) {
  const container = document.getElementById("tournament-bracket");
  if (!container) return;
  const totalRounds = Math.log2(data.size);

  container.innerHTML = data.rounds.map((roundObj, rIdx) => `
    <div>
      <div class="tournament-round-title">${roundName(totalRounds, rIdx)}</div>
      <div class="tournament-round-matches">
        ${roundObj.matches.map((m) => {
          const p1Classes = ["tournament-match-player"];
          const p2Classes = ["tournament-match-player"];
          if (m.winner === m.player1) p1Classes.push("winner");
          else if (m.winner) p1Classes.push("loser");
          if (m.winner === m.player2) p2Classes.push("winner");
          else if (m.winner) p2Classes.push("loser");
          if (m.player1 === state.uid) p1Classes.push("me");
          if (m.player2 === state.uid) p2Classes.push("me");
          return `
            <div class="tournament-match">
              <div class="${p1Classes.join(" ")}"><span>${escapeHtml(m.player1Name)}</span></div>
              <div class="${p2Classes.join(" ")}"><span>${escapeHtml(m.player2Name)}</span></div>
            </div>`;
        }).join("")}
      </div>
    </div>
  `).join("");
}

function showTournamentEliminated() {
  showScreen("tournament");
  document.getElementById("tournament-queue-view").style.display = "none";
  document.getElementById("tournament-bracket-view").style.display = "block";
  setTournamentStatusText("Ai fost eliminat din turneu. Poti urmari restul meciurilor mai jos.");
  if (!state.tournamentResultShown) {
    state.tournamentResultShown = true;
    launchDebris();
  }
}

function showTournamentFinalScreen(data) {
  showScreen("tournament");
  document.getElementById("tournament-queue-view").style.display = "none";
  document.getElementById("tournament-bracket-view").style.display = "block";

  const won = data.champion === state.uid;
  const championName = data.players.find((p) => p.uid === data.champion)?.name || "?";
  setTournamentStatusText(
    won ? "Ai castigat turneul!" : `Turneul s-a incheiat. Campion: ${championName}.`,
  );

  if (!state.tournamentResultShown) {
    state.tournamentResultShown = true;
    if (won) launchConfetti(); else launchDebris();
  }
}

// ---------- TEMPORARY DEBUG HELPER — safe to remove once the turn-sync issue is
// confirmed fixed. Lets you check, from the browser console, exactly what
// this tab's session thinks its own uid/mode/gameId are, to compare against
// what's stored in Firestore.
window.__avionaseDebug = state;

// app.js
// Main controller: screen navigation + wiring between UI, local AI game,
// and multiplayer.

import { auth, ensureSignedIn } from "./firebase-init.js";
import {
  BOARD_SIZE, renderBoard, cellLabel, createEmptyGrid, buildShipCellMap,
} from "./board.js";
import { SHAPES, getShipCells, isPlacementValid, cellsToSet, SHIPS_PER_PLAYER } from "./ship-shapes.js";
import { LocalGame } from "./game-local.js";
import * as MP from "./multiplayer.js";

const screens = {
  login: document.getElementById("screen-login"),
  menu: document.getElementById("screen-menu"),
  placement: document.getElementById("screen-placement"),
  game: document.getElementById("screen-game"),
  privateRoom: document.getElementById("screen-private-room"),
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

  showScreen("menu");
});

// ---------- MENU ----------
document.getElementById("btn-vs-ai").addEventListener("click", () => {
  state.mode = "ai";
  state.opponentFound = true; // no matchmaking needed
  startPlacement();
});

document.getElementById("btn-vs-player").addEventListener("click", async () => {
  state.mode = "pvp";
  state.opponentFound = false;
  setStatus("placement", "Se cauta un adversar...");
  showScreen("placement");
  document.getElementById("placement-board-container").innerHTML =
    '<p class="hint">Cautam un jucator... poti pregati avioanele intre timp, jocul incepe cand se gaseste un adversar.</p>';
  startPlacement(true);

  const cancel = await MP.quickMatch(state.uid, state.name, (gameId) => {
    state.gameId = gameId;
    state.opponentFound = true;
    setStatus("placement", "Adversar gasit! Plaseaza-ti avioanele.");
    refreshConfirmButtonAvailability();
    updatePlacementInfo();
  });
  state.cancelQuickMatch = cancel;
});

document.getElementById("btn-private-room").addEventListener("click", () => {
  showScreen("privateRoom");
});

document.getElementById("btn-back-to-login").addEventListener("click", () => {
  showScreen("login");
});

document.getElementById("btn-back-to-menu-from-room").addEventListener("click", () => {
  showScreen("menu");
});

document.getElementById("btn-back-to-menu-from-placement").addEventListener("click", () => {
  // Cancels any pending "quick match" search or abandons an unfinished
  // placement — nothing has actually started yet, so no confirmation needed.
  cleanupGameState();
  showScreen("menu");
});

document.getElementById("btn-create-room").addEventListener("click", async () => {
  const password = document.getElementById("room-password-input").value.trim();
  const gameId = await MP.createPrivateRoom(state.uid, state.name, password);
  state.mode = "pvp";
  state.gameId = gameId;
  state.opponentFound = false; // still waiting for a second player to join
  document.getElementById("room-code-display").textContent =
    `Cod camera: ${gameId} — trimite-l adversarului.`;
  waitForOpponentThenPlace(gameId);
});

document.getElementById("btn-join-room").addEventListener("click", async () => {
  const code = document.getElementById("room-code-input").value.trim().toUpperCase();
  const password = document.getElementById("join-password-input").value.trim();
  try {
    await MP.joinPrivateRoom(code, state.uid, state.name, password);
    state.mode = "pvp";
    state.gameId = code;
    state.opponentFound = true; // joining an existing room means the opponent is already there
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
    container.dataset.hoverBound = "true";
  }

  drawPlacementBoard();
}

function updatePlacementInfo() {
  const count = state.myShips.length;
  const infoEl = document.getElementById("placement-info");
  if (count >= SHIPS_PER_PLAYER) {
    if (state.mode === "pvp" && !state.opponentFound) {
      infoEl.textContent = `Ai plasat toate cele ${SHIPS_PER_PLAYER} avioane. Asteptam sa se gaseasca un adversar inainte sa poti confirma.`;
    } else {
      infoEl.textContent = `Ai plasat toate cele ${SHIPS_PER_PLAYER} avioane. Apasa "Confirma plasarea" cand esti gata.`;
    }
  } else {
    infoEl.textContent =
      `Plaseaza ${SHIP_LABELS[count]} avion (${count}/${SHIPS_PER_PLAYER}). ` +
      `Muta mouse-ul pe harta pentru previzualizare, click pentru a plasa. ` +
      `Foloseste butonul "Roteste" (sau tasta R) ca sa schimbi orientarea inainte de a plasa.`;
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
  drawPlacementBoard();
}

document.getElementById("btn-rotate-ship").addEventListener("click", rotateShip);

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
    enterGameScreen();
  } else {
    await MP.submitShipPlacement(state.gameId, state.uid, state.myShips);
    document.getElementById("placement-info").textContent = "Asteptam ca adversarul sa termine plasarea...";
    subscribeMultiplayerGame();
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
  if (state.unsubGame) { state.unsubGame(); state.unsubGame = null; }
  if (state.cancelQuickMatch) { state.cancelQuickMatch(); state.cancelQuickMatch = null; }
  state.localGame = null;
  state.gameId = null;
  state.lastGameStatus = null;
  state.aiMoveScheduled = false;
  state.opponentFound = false;
}

document.getElementById("btn-new-game").addEventListener("click", () => {
  if (isGameUnfinished() && !confirm("Jocul curent nu s-a terminat inca. Daca incepi un joc nou, vei pierde partida in desfasurare. Continui?")) {
    return;
  }
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

document.getElementById("btn-quit-game").addEventListener("click", () => {
  if (isGameUnfinished() && !confirm("Jocul curent nu s-a terminat inca. Daca inchizi, abandonezi partida. Continui?")) {
    return;
  }
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
  document.getElementById("game-status").textContent =
    state.localGame.winner === "player" ? "Ai castigat!" : "Calculatorul a castigat.";
}

// ---------- MULTIPLAYER GAME ----------
function subscribeMultiplayerGame() {
  state.unsubGame = MP.listenToGame(state.gameId, async (data) => {
    if (data.status === "playing" && !screens.game.classList.contains("active")) {
      showScreen("game");
    }
    await MP.resolvePendingShotIfMine(state.gameId, state.uid, data);
    renderMultiplayerGameState(data);
  });
}

function renderMultiplayerGameState(data) {
  state.lastGameStatus = data.status;
  const opponentUid = data.order.find((u) => u !== state.uid);
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
      MP.fireShot(state.gameId, state.uid, r, c);
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
    statusText = data.winner === state.uid ? "Ai castigat!" : "Ai pierdut.";
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

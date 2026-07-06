// app.js
// Main controller: screen navigation + wiring between UI, local AI game,
// and multiplayer.

import { auth, ensureSignedIn } from "./firebase-init.js";
import {
  BOARD_SIZE, renderBoard, cellLabel, createEmptyGrid,
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
  startPlacement();
});

document.getElementById("btn-vs-player").addEventListener("click", async () => {
  state.mode = "pvp";
  setStatus("placement", "Se cauta un adversar...");
  showScreen("placement");
  document.getElementById("placement-board-container").innerHTML =
    '<p class="hint">Cautam un jucator... poti pregati avioanele intre timp, jocul incepe cand se gaseste un adversar.</p>';
  startPlacement(true);

  const cancel = await MP.quickMatch(state.uid, state.name, (gameId) => {
    state.gameId = gameId;
    setStatus("placement", "Adversar gasit! Plaseaza-ti avioanele.");
  });
  state.cancelQuickMatch = cancel;
});

document.getElementById("btn-private-room").addEventListener("click", () => {
  showScreen("privateRoom");
});

document.getElementById("btn-create-room").addEventListener("click", async () => {
  const password = document.getElementById("room-password-input").value.trim();
  const gameId = await MP.createPrivateRoom(state.uid, state.name, password);
  state.mode = "pvp";
  state.gameId = gameId;
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
    startPlacement(true);
  } catch (err) {
    document.getElementById("private-room-error").textContent = err.message;
  }
});

function waitForOpponentThenPlace(gameId) {
  const unsub = MP.listenToGame(gameId, (data) => {
    if (data.status === "placing" || data.order.length === 2) {
      unsub();
      startPlacement(true);
    }
  });
}

// ---------- PLACEMENT ----------
function startPlacement(isMultiplayer = false) {
  state.myShips = [];
  state.rotation = 0;
  showScreen("placement");
  document.getElementById("placement-info").textContent =
    `Plaseaza cele ${SHIPS_PER_PLAYER} avioane (0/${SHIPS_PER_PLAYER}). Click pentru a plasa, R pentru a roti.`;
  drawPlacementBoard();
}

let hoverAnchor = null;

function drawPlacementBoard() {
  const container = document.getElementById("placement-board-container");
  const shipCellSet = cellsToSet(state.myShips.flatMap((s) => s.cells));
  let hoverCells = new Set();

  if (hoverAnchor) {
    const [r, c] = hoverAnchor;
    if (isPlacementValid(r, c, state.rotation, shipCellSet, BOARD_SIZE)) {
      hoverCells = cellsToSet(getShipCells(r, c, state.rotation));
    }
  }

  renderBoard(container, {
    mode: "placement",
    shipCellSet,
    hoverCells,
    onCellClick: (r, c) => {
      if (state.myShips.length >= SHIPS_PER_PLAYER) return;
      if (!isPlacementValid(r, c, state.rotation, shipCellSet, BOARD_SIZE)) return;
      const cells = getShipCells(r, c, state.rotation);
      state.myShips.push({ cells, headCell: cells[0] });
      drawPlacementBoard();
      document.getElementById("placement-info").textContent =
        `Plaseaza cele ${SHIPS_PER_PLAYER} avioane (${state.myShips.length}/${SHIPS_PER_PLAYER}). Click pentru a plasa, R pentru a roti.`;
      if (state.myShips.length === SHIPS_PER_PLAYER) {
        document.getElementById("btn-confirm-placement").disabled = false;
      }
    },
  });

  container.addEventListener("mousemove", (e) => {
    const cell = e.target.closest(".board-slot");
    if (!cell) return;
    hoverAnchor = [Number(cell.dataset.row), Number(cell.dataset.col)];
    drawPlacementBoard();
  }, { once: true });
}

document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r" && screens.placement.classList.contains("active")) {
    state.rotation = (state.rotation + 1) % 4;
    drawPlacementBoard();
  }
});

document.getElementById("btn-undo-ship").addEventListener("click", () => {
  state.myShips.pop();
  document.getElementById("btn-confirm-placement").disabled = true;
  drawPlacementBoard();
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
      if (g.winner) return finishLocalGame();
      setTimeout(() => {
        g.aiTurn();
        renderLocalGameState();
        if (g.winner) finishLocalGame();
      }, 600);
    },
  });

  renderBoard(ownContainer, {
    mode: "own",
    shipCellSet: cellsToSet(state.myShips.flatMap((s) => s.cells)),
  });

  document.getElementById("game-status").textContent =
    g.winner ? "" : g.turn === "player" ? "Randul tau — ataca!" : "Calculatorul se gandeste...";
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

  renderBoard(document.getElementById("own-board-container"), {
    mode: "own",
    shipCellSet: cellsToSet(state.myShips.flatMap((s) => s.cells)),
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

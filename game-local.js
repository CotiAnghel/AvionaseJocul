// game-local.js
// Fully self-contained "vs computer" game — no Firebase involved.

import { BOARD_SIZE, CELL_MISS, CELL_HIT, CELL_HEAD, createEmptyGrid } from "./board.js";
import { SHIPS_PER_PLAYER, isPlacementValid, getShipCells } from "./ship-shapes.js";
import { AIPlayer } from "./ai.js";

export class LocalGame {
  /**
   * @param {Array} playerShips - array of { cells: [[r,c]x10], headCell:[r,c] }
   * @param {string} difficulty
   */
  constructor(playerShips, difficulty) {
    this.playerShips = playerShips.map((s) => ({ ...s, destroyed: false }));
    this.aiShips = this._randomAIShips();
    this.ai = new AIPlayer(difficulty);

    this.gridPlayerSeesOfAI = createEmptyGrid(); // what the human knows about the AI's board
    this.gridAISeesOfPlayer = createEmptyGrid(); // what the AI knows about the human's board

    this.turn = Math.random() < 0.5 ? "player" : "ai";
    this.winner = null;
  }

  _randomAIShips() {
    // Randomly place 3 valid, non-overlapping planes for the AI.
    const ships = [];
    let occupied = new Set();
    let attempts = 0;

    while (ships.length < SHIPS_PER_PLAYER && attempts < 5000) {
      attempts++;
      const rotation = Math.floor(Math.random() * 4);
      const anchorR = Math.floor(Math.random() * BOARD_SIZE);
      const anchorC = Math.floor(Math.random() * BOARD_SIZE);
      if (!isPlacementValid(anchorR, anchorC, rotation, occupied, BOARD_SIZE)) continue;

      const cells = getShipCells(anchorR, anchorC, rotation);
      cells.forEach(([r, c]) => occupied.add(`${r},${c}`));
      ships.push({ cells, headCell: cells[0], destroyed: false });
    }
    return ships;
  }

  /** Human fires at (row, col) on the AI's board. Returns "miss"|"hit"|"head". */
  playerFire(row, col) {
    if (this.turn !== "player" || this.winner) return null;
    const result = this._resolveShot(this.aiShips, row, col);
    this.gridPlayerSeesOfAI[row][col] = toCellState(result);

    if (this._allDestroyed(this.aiShips)) {
      this.winner = "player";
    } else {
      this.turn = "ai";
    }
    return result;
  }

  /** Runs one AI turn. Returns { row, col, result }. */
  aiTurn() {
    if (this.turn !== "ai" || this.winner) return null;
    const [row, col] = this.ai.chooseMove(this.gridAISeesOfPlayer);
    const result = this._resolveShot(this.playerShips, row, col);
    this.gridAISeesOfPlayer[row][col] = toCellState(result);
    this.ai.reportResult(row, col, result);

    if (this._allDestroyed(this.playerShips)) {
      this.winner = "ai";
    } else {
      this.turn = "player";
    }
    return { row, col, result };
  }

  _resolveShot(ships, row, col) {
    // Include already-destroyed planes too: any of their cells still count as
    // a "hit" (not a miss) if fired at again — only the head cell result is
    // "head", and destroying it again is a harmless no-op.
    const ship = ships.find((s) => s.cells.some(([r, c]) => r === row && c === col));
    if (!ship) return "miss";
    const isHead = ship.headCell[0] === row && ship.headCell[1] === col;
    if (isHead) ship.destroyed = true;
    return isHead ? "head" : "hit";
  }

  _allDestroyed(ships) {
    return ships.filter((s) => s.destroyed).length >= SHIPS_PER_PLAYER;
  }
}

function toCellState(result) {
  if (result === "miss") return CELL_MISS;
  if (result === "hit") return CELL_HIT;
  return CELL_HEAD;
}


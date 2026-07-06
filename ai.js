// ai.js
// Computer opponent. Three difficulty levels.
//
// The AI only ever sees the same information a human attacker would see:
// per-cell results (unknown / miss / hit / head) on the board it's attacking.

import { BOARD_SIZE } from "./board.js";
import { SHAPES, getShipCells } from "./ship-shapes.js";

export class AIPlayer {
  constructor(difficulty = "medium") {
    this.difficulty = difficulty; // "easy" | "medium" | "hard"
    this.huntQueue = []; // queue of [r,c] candidates to try next, for "medium"
  }

  /**
   * Picks the next cell to fire at.
   * @param {string[][]} grid - AI's current knowledge of opponent's board (CELL_* states)
   * @returns {[number, number]}
   */
  chooseMove(grid) {
    const unknownCells = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (grid[r][c] === "unknown") unknownCells.push([r, c]);
      }
    }
    if (unknownCells.length === 0) return null;

    if (this.difficulty === "easy") {
      return pickRandom(unknownCells);
    }

    if (this.difficulty === "medium") {
      return this._huntAndTarget(grid, unknownCells);
    }

    // hard
    return this._probabilityDensity(grid, unknownCells);
  }

  /** Call this after a shot resolves so "medium" can plan follow-up shots. */
  reportResult(row, col, result) {
    if (this.difficulty !== "medium") return;
    if (result === "hit") {
      // a non-head hit: queue up the 4 neighbors to keep probing this plane
      const candidates = [
        [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1],
      ].filter(([r, c]) => r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE);
      this.huntQueue.push(...candidates);
    }
  }

  _huntAndTarget(grid, unknownCells) {
    // drain queued candidates first (still-unknown ones)
    while (this.huntQueue.length > 0) {
      const [r, c] = this.huntQueue.shift();
      if (grid[r][c] === "unknown") return [r, c];
    }
    return pickRandom(unknownCells);
  }

  _probabilityDensity(grid, unknownCells) {
    // Build a heatmap: for every possible plane placement (all anchors x all
    // rotations) that doesn't overlap a known "miss" or "head" cell, add 1 to
    // every one of its cells. Cells overlapping known "hit" cells are boosted,
    // since a real plane is very likely to still be there (head not found yet).
    const heat = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));

    for (let rotation = 0; rotation < 4; rotation++) {
      const shape = SHAPES[rotation];
      const maxR = Math.max(...shape.map((p) => p[0]));
      const maxC = Math.max(...shape.map((p) => p[1]));

      for (let anchorR = 0; anchorR + maxR < BOARD_SIZE; anchorR++) {
        for (let anchorC = 0; anchorC + maxC < BOARD_SIZE; anchorC++) {
          const cells = getShipCells(anchorR, anchorC, rotation);
          let valid = true;
          let touchesHit = false;

          for (const [r, c] of cells) {
            const state = grid[r][c];
            if (state === "miss" || state === "head") { valid = false; break; }
            if (state === "hit") touchesHit = true;
          }
          if (!valid) continue;

          const weight = touchesHit ? 5 : 1; // prioritize placements near known hits
          for (const [r, c] of cells) {
            if (grid[r][c] === "unknown") heat[r][c] += weight;
          }
        }
      }
    }

    let best = unknownCells[0];
    let bestScore = -1;
    for (const [r, c] of unknownCells) {
      if (heat[r][c] > bestScore) {
        bestScore = heat[r][c];
        best = [r, c];
      }
    }
    return best;
  }
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

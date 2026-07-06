// board.js
// Board state management + DOM rendering for a 10x10 grid.
// Rows are numbered 1-10, columns are lettered A-J (e.g. "3F" = row 3, col F).

export const BOARD_SIZE = 10;
export const COL_LETTERS = "ABCDEFGHIJ".split("");

export function cellLabel(row, col) {
  return `${row + 1}${COL_LETTERS[col]}`;
}

export const CELL_UNKNOWN = "unknown";
export const CELL_MISS = "miss";     // "afara"
export const CELL_HIT = "hit";       // "lovit" (wing/body/tail hit)
export const CELL_HEAD = "head";     // "cap" - plane destroyed

// Distinct outline colors so adjacent/touching planes stay visually separable.
// Cycles if there are ever more ships than colors (only 3 per player normally).
export const SHIP_OUTLINE_COLORS = ["#39ff14", "#4cc9f0", "#f72585", "#ffb703"];

/**
 * Creates a fresh empty attack-view grid (what you know about the opponent's board).
 */
export function createEmptyGrid() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(CELL_UNKNOWN));
}

/**
 * Builds a lookup of "r,c" -> shipIndex from an array of ships ({ cells: [[r,c],...] }).
 * Used both to fill ship cells in and to draw a distinct outline per plane.
 */
export function buildShipCellMap(ships) {
  const map = new Map();
  ships.forEach((ship, index) => {
    ship.cells.forEach(([r, c]) => map.set(`${r},${c}`, index));
  });
  return map;
}

/**
 * Renders a 10x10 grid into a container element.
 * @param {HTMLElement} container
 * @param {string} mode - "placement" | "attack" | "own"
 * @param {Function} onCellClick - callback(row, col) when a cell is clicked
 * @param {Map<string,number>} shipCellMap - "r,c" -> shipIndex, for placement/own modes
 * @param {string[][]} grid - cell states (attack mode: what you know of opponent; own mode: hits YOU received)
 * @param {Set<string>} hoverCells - preview cells while placing a ship
 */
export function renderBoard(container, { mode, onCellClick, shipCellMap, grid, hoverCells }) {
  container.innerHTML = "";
  container.classList.add("board-grid");

  // corner cell
  const corner = document.createElement("div");
  corner.className = "board-cell board-corner";
  container.appendChild(corner);

  // column headers
  for (let c = 0; c < BOARD_SIZE; c++) {
    const head = document.createElement("div");
    head.className = "board-cell board-header";
    head.textContent = COL_LETTERS[c];
    container.appendChild(head);
  }

  for (let r = 0; r < BOARD_SIZE; r++) {
    // row header
    const rowHead = document.createElement("div");
    rowHead.className = "board-cell board-header";
    rowHead.textContent = String(r + 1);
    container.appendChild(rowHead);

    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = document.createElement("div");
      cell.className = "board-cell board-slot";
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);

      const key = `${r},${c}`;

      if ((mode === "placement" || mode === "own") && shipCellMap) {
        const shipIndex = shipCellMap.get(key);
        if (shipIndex !== undefined) {
          cell.classList.add("has-ship");
          applyShipOutline(cell, r, c, shipIndex, shipCellMap);
        }
        if (hoverCells && hoverCells.has(key)) {
          cell.classList.add("preview");
        }
      }

      if (mode === "attack" && grid) {
        const state = grid[r][c];
        if (state !== CELL_UNKNOWN) cell.classList.add(`cell-${state}`);
      }

      // "own" mode can ALSO show where the opponent has hit you, layered on
      // top of your ship cells (or on empty water, for their misses).
      if (mode === "own" && grid) {
        const state = grid[r][c];
        if (state && state !== CELL_UNKNOWN) cell.classList.add(`cell-${state}`);
      }

      if (onCellClick) {
        cell.addEventListener("click", () => onCellClick(r, c));
      }

      container.appendChild(cell);
    }
  }
}

// Draws a colored outline only on the edges where the neighboring cell
// belongs to a DIFFERENT plane (or to no plane at all) — this is what makes
// two touching/adjacent planes read as visually separate shapes.
function applyShipOutline(cell, r, c, shipIndex, shipCellMap) {
  const color = SHIP_OUTLINE_COLORS[shipIndex % SHIP_OUTLINE_COLORS.length];
  const sameShip = (rr, cc) => shipCellMap.get(`${rr},${cc}`) === shipIndex;

  if (!sameShip(r - 1, c)) cell.style.borderTop = `2px solid ${color}`;
  if (!sameShip(r + 1, c)) cell.style.borderBottom = `2px solid ${color}`;
  if (!sameShip(r, c - 1)) cell.style.borderLeft = `2px solid ${color}`;
  if (!sameShip(r, c + 1)) cell.style.borderRight = `2px solid ${color}`;
}

// board.js
// Board state management + DOM rendering for a 10x10 grid.
// Rows are numbered 1-10, columns are lettered A-J (e.g. "3F" = row 3, col F).

export const BOARD_SIZE = 10;
export const COL_LETTERS = "ABCDEFGHIJ".split("");

export function cellLabel(row, col) {
  return `${row + 1}${COL_LETTERS[col]}`;
}

// Cell states for the board YOU are attacking (opponent's board, from your view)
export const CELL_UNKNOWN = "unknown";
export const CELL_MISS = "miss";     // "afara"
export const CELL_HIT = "hit";       // "lovit" (wing/body/tail hit)
export const CELL_HEAD = "head";     // "cap" - plane destroyed

/**
 * Creates a fresh empty attack-view grid (what you know about the opponent's board).
 */
export function createEmptyGrid() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(CELL_UNKNOWN));
}

/**
 * Renders a 10x10 grid into a container element.
 * @param {HTMLElement} container
 * @param {string} mode - "placement" | "attack" | "own" (read-only board showing own ships)
 * @param {Function} onCellClick - callback(row, col) when a cell is clicked (placement/attack modes)
 * @param {Object} state - { shipCellSet: Set<string>, grid: string[][] } depending on mode
 */
export function renderBoard(container, { mode, onCellClick, shipCellSet, grid, hoverCells }) {
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

      if (mode === "placement" || mode === "own") {
        if (shipCellSet && shipCellSet.has(key)) {
          cell.classList.add("has-ship");
        }
        if (hoverCells && hoverCells.has(key)) {
          cell.classList.add("preview");
        }
      }

      if (mode === "attack" && grid) {
        const state = grid[r][c];
        if (state !== CELL_UNKNOWN) cell.classList.add(`cell-${state}`);
      }

      if (onCellClick) {
        cell.addEventListener("click", () => onCellClick(r, c));
      }

      container.appendChild(cell);
    }
  }
}

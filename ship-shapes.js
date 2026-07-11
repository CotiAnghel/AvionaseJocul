// ship-shapes.js
// Defines the plane shape and rotation logic.
//
// Shape (pointing "up", head at the top), relative coordinates [row, col]:
//
//         X          <- head
//     X X X X X      <- wings (5 cells)
//         X          <- body
//       X X X        <- tail (3 cells)
//
// index 0 is ALWAYS the head, in every rotation (rotation preserves array order).

const BASE_SHAPE = [
  [0, 0],                                  // head
  [1, -2], [1, -1], [1, 0], [1, 1], [1, 2], // wings
  [2, 0],                                  // body
  [3, -1], [3, 0], [3, 1],                 // tail
];

function rotateCells(cells, times) {
  let shape = cells;
  for (let t = 0; t < times; t++) {
    shape = shape.map(([r, c]) => [c, -r]);
  }
  const minR = Math.min(...shape.map((p) => p[0]));
  const minC = Math.min(...shape.map((p) => p[1]));
  return shape.map(([r, c]) => [r - minR, c - minC]);
}

// Precomputed: SHAPES[rotation] -> array of [row, col] offsets from the
// plane's anchor (top-left of its bounding box). SHAPES[r][0] is the head.
export const SHAPES = [0, 1, 2, 3].map((t) => rotateCells(BASE_SHAPE, t));

export const SHIP_CELL_COUNT = BASE_SHAPE.length; // 10 cells per plane
export const SHIPS_PER_PLAYER = 3;

/**
 * Returns the absolute board cells [row, col] for a plane placed with its
 * anchor at (anchorRow, anchorCol) and the given rotation (0-3).
 * cells[0] is always the head cell.
 */
export function getShipCells(anchorRow, anchorCol, rotation) {
  return SHAPES[rotation].map(([r, c]) => [anchorRow + r, anchorCol + c]);
}

/** Bounding-box size (rows x cols) of a rotation — used to draw the mini preview. */
export function getShapeBounds(rotation) {
  const shape = SHAPES[rotation];
  const maxR = Math.max(...shape.map((p) => p[0]));
  const maxC = Math.max(...shape.map((p) => p[1]));
  return { rows: maxR + 1, cols: maxC + 1 };
}

/**
 * Checks whether a plane placement is valid on a 10x10 board:
 * - all cells in bounds
 * - no overlap with existing ships (existingCells is a Set of "r,c" strings)
 */
export function isPlacementValid(anchorRow, anchorCol, rotation, existingCells, boardSize = 10) {
  const cells = getShipCells(anchorRow, anchorCol, rotation);
  for (const [r, c] of cells) {
    if (r < 0 || r >= boardSize || c < 0 || c >= boardSize) return false;
    if (existingCells.has(`${r},${c}`)) return false;
  }
  return true;
}

export function cellsToSet(cells) {
  return new Set(cells.map(([r, c]) => `${r},${c}`));
}

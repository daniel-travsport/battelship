'use strict';

// Pure board geometry: islands, ship cells, placement legality and fleet feasibility.

const { SIZE, CELLS, DIRS, FLEET, LIMITS, rcOf, idxOf, inBounds, neighbors4 } = require('./constants');

/** Cells covered by a ship of `len` starting at `start` heading `dir`, or null if it leaves the board. */
function shipCells(start, dir, len) {
  const d = DIRS[dir];
  if (!d) return null;
  const [r, c] = rcOf(start);
  const cells = [];
  for (let k = 0; k < len; k++) {
    const nr = r + d[0] * k;
    const nc = c + d[1] * k;
    if (!inBounds(nr, nc)) return null;
    cells.push(idxOf(nr, nc));
  }
  return cells;
}

/**
 * A ship may not sit on an island, overlap a ship, or share an edge with another ship.
 * Diagonal contact is allowed.
 */
function canPlace(cells, islands, occupied) {
  for (const c of cells) {
    if (islands.has(c) || occupied.has(c)) return false;
    for (const n of neighbors4(c)) if (occupied.has(n)) return false;
  }
  return true;
}

/**
 * Can every remaining ship length still be placed? Depth-first search with a node budget.
 * When the budget runs out the answer is `budget.optimistic`.
 */
function fleetFits(islands, occupied, lens, budget) {
  if (lens.length === 0) return true;
  const [len, ...rest] = lens;
  for (let i = 0; i < CELLS; i++) {
    for (const dir of ['RIGHT', 'DOWN']) {
      if (--budget.n < 0) return budget.optimistic;
      const cells = shipCells(i, dir, len);
      if (!cells || !canPlace(cells, islands, occupied)) continue;
      for (const c of cells) occupied.add(c);
      const ok = fleetFits(islands, occupied, rest, budget);
      for (const c of cells) occupied.delete(c);
      if (ok) return true;
      if (budget.n < 0) return budget.optimistic;
    }
  }
  return false;
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

/** Four separate, irregular island clusters (3–6 squares each) that leave room for the whole fleet. */
function generateIslands(rand = Math.random) {
  const lens = FLEET.map((s) => s.len);
  for (let attempt = 0; attempt < 500; attempt++) {
    const islands = new Set();
    let ok = true;
    for (let k = 0; k < LIMITS.ISLAND_CLUSTERS && ok; k++) {
      const target = 3 + Math.floor(rand() * 4);
      const free = (cell) => !islands.has(cell) && !neighbors4(cell).some((n) => islands.has(n));
      let seed = -1;
      for (let t = 0; t < 100; t++) {
        const s = Math.floor(rand() * CELLS);
        if (free(s)) { seed = s; break; }
      }
      if (seed < 0) { ok = false; break; }
      const cluster = new Set([seed]);
      for (let guard = 0; cluster.size < target && guard < 200; guard++) {
        const from = pick([...cluster], rand);
        const options = neighbors4(from).filter((n) => !cluster.has(n) && free(n));
        if (options.length) cluster.add(pick(options, rand));
      }
      if (cluster.size < 3) { ok = false; break; }
      for (const c of cluster) islands.add(c);
    }
    if (!ok) continue;
    if (fleetFits(islands, new Set(), lens, { n: 300000, optimistic: false })) return islands;
  }
  throw new Error('Could not generate a playable island layout');
}

/** Connected components (4-neighbourhood) of a cell set. */
function clusters(cellSet) {
  const seen = new Set();
  const out = [];
  for (const start of cellSet) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      for (const n of neighbors4(c)) {
        if (cellSet.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    out.push(comp);
  }
  return out;
}

module.exports = { SIZE, shipCells, canPlace, fleetFits, generateIslands, clusters };

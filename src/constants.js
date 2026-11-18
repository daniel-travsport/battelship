'use strict';

const SIZE = 12;
const CELLS = SIZE * SIZE;
const ROWS = 'ABCDEFGHIJKL';

const FLEET = Object.freeze([
  { name: 'Carrier', len: 5 },
  { name: 'Battleship', len: 4 },
  { name: 'Cruiser', len: 3 },
  { name: 'Submarine', len: 3 },
  { name: 'Destroyer', len: 2 },
]);

const TEAMS = Object.freeze(['blue', 'red']);

const PHASES = Object.freeze({
  LOBBY: 'LOBBY',
  PLACEMENT: 'PLACEMENT',
  BATTLE: 'BATTLE',
  PAUSED: 'PAUSED',
  FINISHED: 'FINISHED',
});

const DIRS = Object.freeze({
  UP: [-1, 0],
  DOWN: [1, 0],
  LEFT: [0, -1],
  RIGHT: [0, 1],
});

const LIMITS = Object.freeze({
  NAME_MAX: 24,
  CHAT_MAX: 300,
  CHAT_HISTORY: 50,
  INTEL_HISTORY: 20,
  LOG_HISTORY: 200,
  MAX_PLAYERS: 60,
  ISLAND_CLUSTERS: 4,
  INTEL_EVERY_ATTACKS: 3,
  INTEL_AT_START: 2,
});

const rcOf = (i) => [Math.floor(i / SIZE), i % SIZE];
const idxOf = (r, c) => r * SIZE + c;
const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const coordOf = (i) => ROWS[Math.floor(i / SIZE)] + String((i % SIZE) + 1);
const otherTeam = (t) => (t === 'blue' ? 'red' : 'blue');
const requiredVotes = (eligible) => Math.floor(eligible / 2) + 1;

function neighbors4(i) {
  const [r, c] = rcOf(i);
  const out = [];
  for (const [dr, dc] of Object.values(DIRS)) {
    const nr = r + dr;
    const nc = c + dc;
    if (inBounds(nr, nc)) out.push(idxOf(nr, nc));
  }
  return out;
}

module.exports = {
  SIZE, CELLS, ROWS, FLEET, TEAMS, PHASES, DIRS, LIMITS,
  rcOf, idxOf, inBounds, coordOf, otherTeam, requiredVotes, neighbors4,
};

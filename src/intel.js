'use strict';

// Rule-based Intelligence: every report states one fact that is true of the enemy's
// still-afloat ships, phrased vaguely enough not to give away exact squares.
// The `fact` object stays on the server; clients receive only source + text.

const { SIZE, ROWS, rcOf } = require('./constants');

const SOURCES = [
  'SONAR INTERCEPT',
  'ENCRYPTED TRANSMISSION',
  'NAVAL RECONNAISSANCE',
  'SIGNALS INTELLIGENCE',
  'AERIAL PATROL',
];

const HALF = SIZE / 2;
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];

const sizeWord = (len) => (len >= 5 ? 'massive' : len === 4 ? 'sizeable' : len === 3 ? 'mid-sized' : 'small');
const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Region predicates on a cell, keyed by the name used in reports.
const REGIONS = {
  northern: (r) => r < HALF,
  southern: (r) => r >= HALF,
  western: (_r, c) => c < HALF,
  eastern: (_r, c) => c >= HALF,
  'north-western': (r, c) => r < HALF && c < HALF,
  'north-eastern': (r, c) => r < HALF && c >= HALF,
  'south-western': (r, c) => r >= HALF && c < HALF,
  'south-eastern': (r, c) => r >= HALF && c >= HALF,
};
const HALVES = ['northern', 'southern', 'western', 'eastern'];

const EDGES = {
  northern: (r) => r === 0,
  southern: (r) => r === SIZE - 1,
  western: (_r, c) => c === 0,
  eastern: (_r, c) => c === SIZE - 1,
};

const inRegion = (cell, region) => { const [r, c] = rcOf(cell); return REGIONS[region](r, c); };
const shipInRegion = (ship, region) => ship.cells.some((c) => inRegion(c, region));
const orientation = (ship) => (rcOf(ship.cells[0])[0] === rcOf(ship.cells[1])[0] ? 'east–west' : 'north–south');

const generators = {
  region(afloat, rand) {
    const ship = pick(afloat, rand);
    const [r, c] = rcOf(pick(ship.cells, rand));
    const names = Object.keys(REGIONS).filter((n) => REGIONS[n](r, c));
    const region = pick(names, rand);
    const size = sizeWord(ship.len);
    const text = pick([
      `Our instruments detect ${article(size)} ${size} metallic shadow in the ${region} waters. Classification remains uncertain.`,
      `Faint propeller noise places ${article(size)} ${size} vessel somewhere in the ${region} sector.`,
      `Intercepted chatter mentions ${article(size)} ${size} hull operating in the ${region} waters.`,
    ], rand);
    return { text, fact: { type: 'region', len: ship.len, region } };
  },

  axis(afloat, rand) {
    const ship = pick(afloat, rand);
    const axis = orientation(ship);
    const size = sizeWord(ship.len);
    const text = pick([
      `A suspicious wake indicates ${article(size)} ${size} vessel travelling along an ${axis} axis.`,
      `Reconnaissance photographs show ${article(size)} ${size} hull aligned ${axis}.`,
      `Enemy communications suggest ${article(size)} ${size} ship is holding an ${axis} heading.`,
    ], rand);
    return { text, fact: { type: 'axis', len: ship.len, axis } };
  },

  band(afloat, rand) {
    const ship = pick(afloat, rand);
    const [r, c] = rcOf(pick(ship.cells, rand));
    const byRow = rand() < 0.5;
    const pos = byRow ? r : c;
    const from = Math.min(Math.max(pos - Math.floor(rand() * 4), 0), SIZE - 4);
    const to = from + 3;
    const label = byRow ? `rows ${ROWS[from]} and ${ROWS[to]}` : `columns ${from + 1} and ${to + 1}`;
    const text = pick([
      `Triangulated radio bearings place an enemy vessel between ${label}.`,
      `Sonar returns cluster between ${label}. At least one hull is present.`,
      `Decrypted fragments reference a ship stationed between ${label}.`,
    ], rand);
    return { text, fact: { type: 'band', axis: byRow ? 'row' : 'col', from, to } };
  },

  count(afloat, rand) {
    const half = pick(HALVES, rand);
    const n = afloat.filter((s) => shipInRegion(s, half)).length;
    let text;
    if (n === 0) text = `No enemy signatures detected in the ${half} waters. The area appears clear.`;
    else if (n === 1) text = `Analysts count a single vessel operating in the ${half} waters.`;
    else text = `${NUMBER_WORDS[n] || n} distinct hull signatures are operating in the ${half} waters.`;
    return { text, fact: { type: 'count', region: half, count: n } };
  },

  edge(afloat, rand) {
    const touching = [];
    for (const ship of afloat) {
      for (const [edge, test] of Object.entries(EDGES)) {
        if (ship.cells.some((cell) => { const [r, c] = rcOf(cell); return test(r, c); })) touching.push({ ship, edge });
      }
    }
    if (touching.length === 0) {
      return {
        text: 'Coastal watchers report every remaining vessel is keeping clear of the map boundaries.',
        fact: { type: 'edge', edge: null },
      };
    }
    const { ship, edge } = pick(touching, rand);
    const size = sizeWord(ship.len);
    return {
      text: `${cap(article(size))} ${size} vessel appears to be hugging the ${edge} boundary.`,
      fact: { type: 'edge', edge, len: ship.len },
    };
  },

  damaged(afloat, rand) {
    const wounded = afloat.filter((s) => s.hits.size > 0);
    if (wounded.length === 0) return null;
    const ship = pick(wounded, rand);
    const intact = ship.cells.filter((c) => !ship.hits.has(c));
    const [r, c] = rcOf(pick(intact, rand));
    const half = pick(HALVES.filter((h) => REGIONS[h](r, c)), rand);
    const size = sizeWord(ship.len);
    return {
      text: `Damage-control chatter: ${article(size)} wounded ${size} vessel is still afloat, its intact section in the ${half} waters.`,
      fact: { type: 'damaged', len: ship.len, region: half },
    };
  },
};

/**
 * One report about `fleet` (the enemy's ships: { len, cells, hits:Set, sunk }).
 * Avoids repeating `lastType` when another generator applies.
 */
function generateIntel(fleet, rand = Math.random, lastType = null) {
  const afloat = fleet.filter((s) => !s.sunk);
  if (afloat.length === 0) return null;
  const order = Object.keys(generators).sort(() => rand() - 0.5);
  order.sort((a, b) => (a === lastType) - (b === lastType));
  for (const type of order) {
    const result = generators[type](afloat, rand);
    if (result) return { source: pick(SOURCES, rand), text: result.text, fact: result.fact };
  }
  return null;
}

/** True when `fact` holds for the afloat ships in `fleet`. Used by tests. */
function factHolds(fact, fleet) {
  const afloat = fleet.filter((s) => !s.sunk);
  switch (fact.type) {
    case 'region':
      return afloat.some((s) => s.len === fact.len && shipInRegion(s, fact.region));
    case 'axis':
      return afloat.some((s) => s.len === fact.len && orientation(s) === fact.axis);
    case 'band':
      return afloat.some((s) => s.cells.some((cell) => {
        const [r, c] = rcOf(cell);
        const v = fact.axis === 'row' ? r : c;
        return v >= fact.from && v <= fact.to;
      }));
    case 'count':
      return afloat.filter((s) => shipInRegion(s, fact.region)).length === fact.count;
    case 'edge':
      if (fact.edge === null) {
        return afloat.every((s) => s.cells.every((cell) => { const [r, c] = rcOf(cell); return !Object.values(EDGES).some((t) => t(r, c)); }));
      }
      return afloat.some((s) => s.len === fact.len && s.cells.some((cell) => { const [r, c] = rcOf(cell); return EDGES[fact.edge](r, c); }));
    case 'damaged':
      return afloat.some((s) => s.len === fact.len && s.hits.size > 0 && s.cells.some((c) => !s.hits.has(c) && inRegion(c, fact.region)));
    default:
      return false;
  }
}

module.exports = { generateIntel, factHolds, SOURCES };

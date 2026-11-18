'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, cleanName, cleanChat } = require('../src/game');
const { generateIslands, clusters, shipCells, canPlace } = require('../src/board');
const { generateIntel, factHolds } = require('../src/intel');
const { requiredVotes, neighbors4, FLEET } = require('../src/constants');

function setup(names = ['Ann', 'Bo', 'Cy', 'Di']) {
  const g = new Game();
  const players = names.map((n) => g.addPlayer(n).player);
  players.forEach((p) => g.attachSocket(p.id, `s-${p.id}`));
  const team = (t) => players.filter((p) => p.team === t && p.connected);
  return { g, players, team };
}

/** Every connected member of `team` votes for the first legal value until the team's fleet is placed. */
function placeAll(g, team) {
  for (const t of ['blue', 'red']) {
    while (g.teams[t].ships.length < FLEET.length && (g.phase === 'PLACEMENT')) {
      const opts = g.legalOptions(t);
      const v = opts.values[Math.floor(opts.values.length / 2)];
      for (const p of team(t)) g.vote(p.id, v);
    }
  }
}

function attackWith(g, team, t, cell) {
  let res;
  for (const p of team(t)) res = g.vote(p.id, cell);
  return res;
}

test('majority threshold is floor(n/2)+1', () => {
  const expected = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 3, 6: 4, 7: 4 };
  for (const [n, req] of Object.entries(expected)) assert.equal(requiredVotes(Number(n)), req);
});

test('names and chat are sanitized', () => {
  assert.equal(cleanName('  Captain   Nemo '), 'Captain Nemo');
  assert.equal(cleanName('a'.repeat(25)), null);
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(42), null);
  assert.equal(cleanName('x​y‮z'), 'xyz');
  assert.equal(cleanChat('<b>hi</b>'), '<b>hi</b>'); // kept verbatim; the client renders text only
  assert.equal(cleanChat('x'.repeat(301)), null);
});

test('players are balanced across teams, names are unique, joining closes at start', () => {
  const { g, players } = setup();
  assert.deepEqual(players.map((p) => p.team), ['blue', 'red', 'blue', 'red']);
  assert.equal(g.addPlayer('ann').ok, false, 'duplicate names are case-insensitive');
  assert.ok(g.start().ok);
  assert.equal(g.addPlayer('Late').ok, false);
});

test('islands: four separate clusters that leave room for the fleet', () => {
  for (let k = 0; k < 50; k++) {
    const islands = generateIslands();
    const comps = clusters(islands);
    assert.equal(comps.length, 4);
    for (const c of comps) assert.ok(c.length >= 3 && c.length <= 6);
  }
});

test('placement rules: no overlap, no islands, no edge contact, diagonal allowed', () => {
  const islands = new Set([0]);
  const occupied = new Set(shipCells(26, 'RIGHT', 3)); // C3–C5
  assert.equal(canPlace([0, 1], islands, new Set()), false, 'island');
  assert.equal(canPlace(shipCells(14, 'RIGHT', 2), new Set(), occupied), false, 'touches above');
  assert.equal(canPlace(shipCells(29, 'RIGHT', 2), new Set(), occupied), false, 'touches the end');
  assert.equal(canPlace(shipCells(13, 'LEFT', 2), new Set(), occupied), true, 'diagonal corner only');
  assert.equal(shipCells(11, 'RIGHT', 2), null, 'off the board');
});

test('placed fleets obey every rule and the battle starts with Blue', () => {
  const { g, team } = setup();
  g.start();
  placeAll(g, team);
  assert.equal(g.phase, 'BATTLE');
  assert.equal(g.turn, 'blue');
  for (const t of ['blue', 'red']) {
    const T = g.teams[t];
    assert.deepEqual(T.ships.map((s) => s.len), [5, 4, 3, 3, 2]);
    const all = T.ships.flatMap((s) => s.cells);
    assert.equal(new Set(all).size, 17);
    for (const c of all) assert.ok(!T.islands.has(c));
    T.ships.forEach((s, i) => {
      for (const c of s.cells) {
        for (const n of neighbors4(c)) {
          const owner = T.occupied.get(n);
          assert.ok(owner === undefined || owner === i, 'ships must not share an edge');
        }
      }
    });
  }
});

test('placement voting needs a majority and illegal options are rejected', () => {
  const { g, team } = setup(['A', 'B', 'C', 'D', 'E', 'F']); // 3 per team -> 2 votes needed
  g.start();
  const [b1, b2, b3] = team('blue');
  const island = [...g.teams.blue.islands][0];
  assert.equal(g.vote(b1.id, island).ok, false);
  const legal = g.legalOptions('blue').values;
  assert.equal(g.vote(b1.id, legal[0]).resolved, false);
  assert.equal(g.vote(b2.id, legal[1]).resolved, false);
  assert.equal(g.vote(b2.id, legal[0]).resolved, true, 'changing a vote can complete a majority');
  assert.equal(g.teams.blue.placement.stage, 'direction');
  assert.equal(g.vote(b3.id, 'SIDEWAYS').ok, false);
  assert.equal(g.vote(b3.id, 5).ok, false, 'a cell is not a direction');
});

test('a vote can be withdrawn by voting the same option again', () => {
  const { g, team } = setup(['A', 'B', 'C', 'D', 'E', 'F']);
  g.start();
  const [b1] = team('blue');
  const v = g.legalOptions('blue').values[0];
  g.vote(b1.id, v);
  assert.equal(g.tally('blue').counts.get(v), 1);
  g.vote(b1.id, v);
  assert.equal(g.tally('blue').counts.size, 0);
});

test('attacks: turn order, hit, miss, repeat and island rejection, sinking, intel, victory', () => {
  const { g, team } = setup();
  g.start();
  placeAll(g, team);
  const red = g.teams.red;
  const blue = g.teams.blue;
  assert.equal(blue.intel.length, 2, 'initial intelligence');

  const [r1] = team('red');
  assert.equal(g.vote(r1.id, 0).ok, false, "not red's turn");
  assert.equal(attackWith(g, team, 'blue', [...red.islands][0]).ok, false, 'islands cannot be attacked');

  const target = red.ships[4].cells[0];
  attackWith(g, team, 'blue', target);
  assert.equal(red.shots.get(target), 'hit');
  assert.equal(g.turn, 'red');

  const miss = g.legalOptions('red').values.find((c) => !blue.occupied.has(c));
  attackWith(g, team, 'red', miss);
  assert.equal(blue.shots.get(miss), 'miss');

  assert.equal(attackWith(g, team, 'blue', target).ok, false, 'no repeat attacks');
  attackWith(g, team, 'blue', red.ships[4].cells[1]);
  assert.equal(red.ships[4].sunk, true, 'destroyer sunk');
  assert.equal(blue.intel.length, 3, 'intel every third attack');

  // Blue sinks everything; Red keeps missing.
  while (g.phase === 'BATTLE') {
    if (g.turn === 'blue') {
      const next = red.ships.flatMap((s) => s.cells).find((c) => !red.shots.has(c));
      attackWith(g, team, 'blue', next);
    } else {
      attackWith(g, team, 'red', g.legalOptions('red').values.find((c) => !blue.occupied.has(c)));
    }
  }
  assert.equal(g.phase, 'FINISHED');
  assert.equal(g.winner, 'blue');
  assert.equal(attackWith(g, team, 'red', g.legalOptions('blue').values[0] ?? 0).ok, false, 'no votes after victory');
});

test('disconnects shrink the electorate and resolve a pending majority', () => {
  const { g, team } = setup(['A', 'B', 'C', 'D', 'E', 'F']); // 3 per team
  g.start();
  placeAll(g, team);
  const [b1, b2, b3] = team('blue');
  const target = g.legalOptions('blue').values[0];
  g.vote(b1.id, target);
  g.vote(b2.id, g.legalOptions('blue').values[1]);
  assert.equal(g.tally('blue').required, 2);
  g.detachSocket(b2.id, `s-${b2.id}`); // b2's vote disappears; 2 eligible -> 2 needed
  assert.equal(g.tally('blue').required, 2);
  assert.equal(g.turn, 'blue');
  g.detachSocket(b3.id, `s-${b3.id}`); // 1 eligible -> b1's vote is a majority
  assert.equal(g.turn, 'red', 'pending vote resolved automatically');
  assert.ok(g.teams.red.shots.has(target));
  g.attachSocket(b3.id, `s-${b3.id}`);
  assert.equal(g.tally('blue').eligible, 2, 'reconnected players count again');
});

test('pause rejects votes and resume restores the battle', () => {
  const { g, team } = setup();
  g.start();
  placeAll(g, team);
  assert.ok(g.pause().ok);
  assert.equal(g.phase, 'PAUSED');
  assert.equal(attackWith(g, team, 'blue', g.legalOptions('blue').values[0]).ok, false);
  assert.ok(g.resume().ok);
  assert.equal(g.phase, 'BATTLE');
  assert.equal(g.turn, 'blue');
  assert.equal(g.resume().ok, false);
});

test('illegal phase transitions are rejected', () => {
  const { g } = setup();
  assert.equal(g.pause().ok, false);
  assert.equal(g.resume().ok, false);
  g.start();
  assert.equal(g.start().ok, false);
});

test('reset keeps connected players, drops offline ones, or removes everyone', () => {
  const { g, players, team } = setup();
  g.start();
  placeAll(g, team);
  g.detachSocket(players[3].id, `s-${players[3].id}`);
  g.reset();
  assert.equal(g.phase, 'LOBBY');
  assert.equal(g.players.size, 3);
  assert.equal(g.teams.blue.islands.size, 0);
  assert.equal(g.teams.blue.intel.length, 0);
  assert.equal(g.attackCount, 0);
  assert.equal(players[0].team, 'blue');
  g.reset({ removePlayers: true });
  assert.equal(g.players.size, 0);
});

test('player views never contain enemy ship positions or session tokens', () => {
  const { g, players, team } = setup();
  g.start();
  placeAll(g, team);
  const view = g.playerView(players[0].id);
  const json = JSON.stringify(view);
  for (const p of players) assert.ok(!json.includes(p.token));
  assert.deepEqual(Object.keys(view.enemy).sort(), ['islands', 'shipsPlaced', 'shipsRemaining', 'shots', 'sunkShips']);
  assert.equal(view.enemy.sunkShips.length, 0);
  for (const r of view.intel) assert.deepEqual(Object.keys(r).sort(), ['id', 'source', 'text', 'ts']);
  assert.ok(view.roster.every((m) => g.players.get(m.id).team === 'blue'));
  assert.ok(!JSON.stringify(g.hostView()).includes(players[0].token));
});

test('intelligence facts are always true of the enemy fleet', () => {
  for (let k = 0; k < 30; k++) {
    const { g, team } = setup();
    g.start();
    placeAll(g, team);
    const fleet = g.teams.red.ships;
    fleet[0].hits.add(fleet[0].cells[0]);
    for (let n = 0; n < 40; n++) {
      const r = generateIntel(fleet);
      assert.ok(factHolds(r.fact, fleet), `${r.text} ${JSON.stringify(r.fact)}`);
      assert.ok(!/\b[A-L](1[0-2]|[1-9])\b/.test(r.text), `no exact coordinates: ${r.text}`);
    }
  }
});

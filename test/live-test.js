#!/usr/bin/env node
'use strict';

/*
 * Multiplayer integration test: one Game Master and four players drive a complete game
 * over Socket.IO.
 *
 *   Local (default): starts an isolated in-process server with a random host key.
 *   Live:            TARGET_URL=https://… BATTLESHIPS_HOST_KEY=… CONFIRM_LIVE_RESET=RESET
 *
 * Writes a JSON report to REPORT_PATH (default test-report.json). Exit code 1 on failure.
 * The host key is never printed.
 */

const fs = require('fs');
const crypto = require('crypto');
const { io } = require('socket.io-client');

const TARGET_URL = (process.env.TARGET_URL || '').trim().replace(/\/+$/, '');
const LIVE = TARGET_URL !== '';
const REPORT_PATH = process.env.REPORT_PATH || 'test-report.json';
const ALLOW_ACTIVE = process.env.ALLOW_ACTIVE_RESET === 'true';
const TIMEOUT = Number(process.env.STEP_TIMEOUT_MS) || (LIVE ? 20000 : 6000);

const report = {
  timestamp: new Date().toISOString(),
  environment: LIVE ? `live (${TARGET_URL})` : 'local (temporary isolated server)',
  passed: 0,
  failed: 0,
  skipped: 0,
  phase: null,
  attacks: 0,
  tests: [],
};

// ---------------------------------------------------------------- client wrapper

class Client {
  constructor(url, label) {
    this.label = label;
    this.state = null;
    this.hostState = null;
    this.chat = [];
    this.lobby = null;
    this.removed = null;
    this.listeners = new Set();
    this.socket = io(url, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: LIVE ? 90000 : 5000 });
    const bump = () => { for (const fn of [...this.listeners]) fn(); };
    this.socket.on('state', (s) => { this.state = s; bump(); });
    this.socket.on('host:state', (s) => { this.hostState = s; bump(); });
    this.socket.on('chat:history', (m) => { this.chat = m.slice(); bump(); });
    this.socket.on('chat:message', (m) => { this.chat.push(m); bump(); });
    this.socket.on('lobby', (l) => { this.lobby = l; bump(); });
    this.socket.on('player:removed', (r) => { this.removed = r; bump(); });
  }

  connected() {
    if (this.socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('connect_error', (e) => reject(new Error(`${this.label}: cannot connect (${e.message})`)));
    });
  }

  emit(event, payload = {}) {
    return new Promise((resolve, reject) => {
      this.socket.timeout(TIMEOUT).emit(event, payload, (err, res) => {
        if (err) reject(new Error(`${this.label}: no reply to ${event}`));
        else resolve(res);
      });
    });
  }

  async ok(event, payload) {
    let res = await this.emit(event, payload);
    // Bots act far faster than people; back off when the server's rate limiter pushes back.
    for (let k = 0; k < 15 && res && !res.ok && /too many requests/i.test(res.error || ''); k++) {
      await sleep(400);
      res = await this.emit(event, payload);
    }
    if (!res || !res.ok) throw new Error(`${this.label}: ${event} rejected: ${res && res.error}`);
    return res;
  }

  /** Resolves once `pred(this)` is truthy; re-checked on every incoming event. */
  waitFor(pred, what, timeout = TIMEOUT) {
    return new Promise((resolve, reject) => {
      const check = () => {
        let v;
        try { v = pred(this); } catch { v = false; }
        if (v) { cleanup(); resolve(v); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${this.label}: timed out waiting for ${what}`)); }, timeout);
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(check); };
      this.listeners.add(check);
      check();
    });
  }

  close() { this.socket.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------- test bookkeeping

let currentTest = 0;
async function step(name, fn) {
  currentTest += 1;
  const id = currentTest;
  const t0 = Date.now();
  const entry = { id, name, status: 'passed', durationMs: 0, error: null };
  try {
    await fn();
    report.passed += 1;
    console.log(`  ✔ ${String(id).padStart(2)} ${name}`);
  } catch (err) {
    entry.status = 'failed';
    entry.error = err && err.message ? err.message : String(err);
    report.failed += 1;
    console.log(`  ✖ ${String(id).padStart(2)} ${name}\n       ${entry.error}`);
  }
  entry.durationMs = Date.now() - t0;
  report.tests.push(entry);
  return entry.status === 'passed';
}

function writeReport() {
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport written to ${REPORT_PATH}: ${report.passed} passed, ${report.failed} failed.`);
}

// ---------------------------------------------------------------- game helpers

const clients = [];
let url;
let host;
let players = []; // [{ client, name, token, id, team }]

function team(t) { return players.filter((p) => p.team === t && p.client.socket.connected); }
function hs() { return host.hostState; }

async function connectClient(label) {
  const c = new Client(url, label);
  clients.push(c);
  await c.connected();
  return c;
}

/** Wait until every listed player has a state satisfying `pred`. */
function allSee(list, pred, what) {
  return Promise.all(list.map((p) => p.client.waitFor((c) => c.state && pred(c.state), `${what} (${p.name})`)));
}

/** Every connected member of `t` votes for `value`; resolves after the host sees `done`. */
async function teamVote(t, value, done, what) {
  for (const p of team(t)) await p.client.ok('vote', { value });
  await host.waitFor((h) => h.hostState && done(h.hostState), what);
}

/** Members wait until they see the same open vote before voting, then all vote the same value. */
async function placeOneStep(t) {
  const before = hs().teams[t].placement;
  const members = team(t);
  await allSee(members, (s) => s.placement.placed === before.placed && s.placement.stage === before.stage && s.voting.kind, 'placement vote open');
  const legal = members[0].client.state.voting.legal;
  const value = legal[Math.floor(Math.random() * legal.length)];
  await teamVote(t, value, (h) => {
    const p = h.teams[t].placement;
    return p.placed !== before.placed || p.stage !== before.stage;
  }, `${t} placement step`);
}

async function waitTurn(t) {
  await host.waitFor((h) => h.hostState && h.hostState.phase === 'BATTLE' && h.hostState.turn === t, `${t}'s turn`);
  await allSee(team(t), (s) => s.voting.kind === 'attack', 'attack vote open');
}

/** One attack by team `t` on `cell`; resolves when the attack count has moved on. */
async function attack(t, cell) {
  await waitTurn(t);
  const n = hs().attackCount;
  await teamVote(t, cell, (h) => h.attackCount === n + 1, `${t} attack`);
}

function enemyOf(t) { return t === 'blue' ? 'red' : 'blue'; }
function shipCellsOf(t) { return hs().teams[t].ships.flatMap((s) => s.cells); }
function legalAttack(t) { return hs().teams[t].voting.legal; }
function missCell(t) {
  const occupied = new Set(shipCellsOf(enemyOf(t)));
  return legalAttack(t).find((c) => !occupied.has(c));
}
function unhitShipCell(t, shipName) {
  const E = hs().teams[enemyOf(t)];
  const shot = new Set(E.shots.map((s) => s.i));
  const ships = shipName ? E.ships.filter((s) => s.name === shipName) : E.ships;
  return ships.flatMap((s) => s.cells).find((c) => !shot.has(c));
}

// ---------------------------------------------------------------- main

async function main() {
  let hostKey;
  let local = null;

  if (LIVE) {
    hostKey = process.env.BATTLESHIPS_HOST_KEY;
    if (process.env.CONFIRM_LIVE_RESET !== 'RESET') {
      console.error('Refusing to test the live game: set confirm_live_reset to RESET. The test resets the live game.');
      report.failed = 1;
      report.tests.push({ id: 0, name: 'Live reset confirmation', status: 'failed', durationMs: 0, error: 'confirm_live_reset was not RESET' });
      writeReport();
      process.exit(1);
    }
    if (!hostKey) {
      console.error('BATTLESHIPS_HOST_KEY is not set.');
      report.failed = 1;
      report.tests.push({ id: 0, name: 'Host key available', status: 'failed', durationMs: 0, error: 'BATTLESHIPS_HOST_KEY secret is missing' });
      writeReport();
      process.exit(1);
    }
    url = TARGET_URL;
  } else {
    hostKey = crypto.randomBytes(18).toString('hex');
    const { createServer } = require('../server');
    local = createServer({ hostKey, logger: { warn() {}, error: console.error, log() {} } });
    const port = await local.listen(0);
    url = `http://127.0.0.1:${port}`;
  }

  console.log(`Battleships integration test — ${report.environment}\n`);
  const runId = crypto.randomBytes(2).toString('hex');

  try {
    // 1 ---------------------------------------------------------------
    await step('GM authentication', async () => {
      host = await connectClient('GM');
      const bad = await host.emit('host:auth', { key: `${hostKey}x` });
      assert(bad && !bad.ok, 'a wrong host key was accepted');
      await host.ok('host:auth', { key: hostKey });
      await host.waitFor((h) => h.hostState, 'host state');
    });
    if (!host || !host.hostState) throw new Error('Cannot continue without GM access.');

    // Live safety: never wipe a game that people are actually playing.
    const active = ['PLACEMENT', 'BATTLE', 'PAUSED'].includes(hs().phase)
      && Object.values(hs().teams).some((t) => t.online > 0);
    if (LIVE && active && !ALLOW_ACTIVE) {
      throw new Error(`The live game is in ${hs().phase} with players online. Not resetting it. Set ALLOW_ACTIVE_RESET=true to override.`);
    }
    await host.ok('host:reset', { confirm: true, removePlayers: true });
    await host.waitFor((h) => h.hostState.phase === 'LOBBY' && h.hostState.teams.blue.roster.length === 0, 'clean lobby');

    // 2 ---------------------------------------------------------------
    await step('Unauthorized GM commands are rejected', async () => {
      const intruder = await connectClient('intruder');
      for (const ev of ['host:start', 'host:pause', 'host:resume', 'host:reset']) {
        const res = await intruder.emit(ev, { confirm: true, removePlayers: true });
        assert(res && !res.ok, `${ev} was accepted without authentication`);
      }
      assert(!intruder.hostState, 'an unauthenticated socket received GM state');
      intruder.close();
    });

    // 3 ---------------------------------------------------------------
    await step('Four players join and are balanced across teams', async () => {
      players = [];
      for (let k = 1; k <= 4; k++) {
        const name = `Bot-${runId}-${k}`;
        const client = await connectClient(name);
        const res = await client.ok('player:join', { name });
        players.push({ client, name, token: res.token, id: res.id, team: res.team });
      }
      const counts = { blue: team('blue').length, red: team('red').length };
      assert(counts.blue === 2 && counts.red === 2, `unbalanced teams ${JSON.stringify(counts)}`);
      const dup = await connectClient('dup');
      const res = await dup.emit('player:join', { name: players[0].name.toUpperCase() });
      assert(res && !res.ok, 'a duplicate name was accepted');
      const long = await dup.emit('player:join', { name: 'x'.repeat(25) });
      assert(long && !long.ok, 'a 25-character name was accepted');
      dup.close();
      await host.waitFor((h) => h.hostState.teams.blue.online === 2 && h.hostState.teams.red.online === 2, 'GM sees all four players');
    });

    // 4 ---------------------------------------------------------------
    await step('Player identity and reconnection', async () => {
      const p = players[0];
      p.client.close();
      await host.waitFor((h) => h.hostState.teams[p.team].roster.find((m) => m.id === p.id && !m.connected), 'GM sees player offline');
      const again = await connectClient(`${p.name}-again`);
      const res = await again.ok('player:resume', { token: p.token });
      assert(res.id === p.id && res.team === p.team, 'reconnected as a different player or team');
      p.client = again;
      const bogus = await connectClient('bogus');
      const r2 = await bogus.emit('player:resume', { token: 'not-a-real-token' });
      assert(r2 && !r2.ok, 'an invalid session token was accepted');
      const r3 = await bogus.emit('vote', { value: 0, team: 'red', playerId: players[1].id });
      assert(r3 && !r3.ok, 'an unjoined socket could vote on behalf of another player');
      bogus.close();
      await host.waitFor((h) => h.hostState.teams[p.team].roster.find((m) => m.id === p.id && m.connected), 'GM sees player online again');
      await allSee(players, (s) => s.roster.length === 2, 'state after reconnect');
      for (const q of players) {
        const json = JSON.stringify(q.client.state);
        for (const other of players) assert(!json.includes(other.token), 'a session token leaked into player state');
      }
    });

    // 5 ---------------------------------------------------------------
    await step('Team roster shows only teammates with presence', async () => {
      await allSee(players, (s) => s.online === 2 && s.roster.length === 2, 'two online teammates');
      for (const p of players) {
        const s = p.client.state;
        const names = s.roster.map((m) => m.name).sort();
        const expected = players.filter((q) => q.team === p.team).map((q) => q.name).sort();
        assert(JSON.stringify(names) === JSON.stringify(expected), `${p.name} sees the wrong roster`);
        assert(s.roster.filter((m) => m.you).length === 1 && s.roster.find((m) => m.you).id === p.id, 'missing (you) marker');
      }
    });

    // 6 ---------------------------------------------------------------
    await step('Team chat is isolated per team', async () => {
      const [b1, b2] = team('blue');
      const reds = team('red');
      const text = `<img src=x onerror=alert(1)> secret-${runId}`;
      await b1.client.ok('chat:send', { text });
      await b2.client.waitFor((c) => c.chat.some((m) => m.text === text && m.from === b1.name), 'blue teammate receives message');
      await sleep(400);
      for (const r of reds) assert(!r.client.chat.some((m) => m.text.includes(`secret-${runId}`)), 'red received a blue chat message');
      const tooLong = await b1.client.emit('chat:send', { text: 'y'.repeat(301) });
      assert(tooLong && !tooLong.ok, 'a 301-character message was accepted');
    });

    // start ----------------------------------------------------------
    await host.ok('host:start');
    await allSee(players, (s) => s.phase === 'PLACEMENT' && s.voting.kind === 'start', 'placement phase');

    // 7 ---------------------------------------------------------------
    await step('Island generation', async () => {
      for (const t of ['blue', 'red']) {
        const islands = new Set(hs().teams[t].islands);
        // count 4-connected clusters
        const seen = new Set();
        let clusters = 0;
        for (const c of islands) {
          if (seen.has(c)) continue;
          clusters += 1;
          const stack = [c];
          seen.add(c);
          while (stack.length) {
            const x = stack.pop();
            const r = Math.floor(x / 12);
            const col = x % 12;
            for (const [nr, nc] of [[r - 1, col], [r + 1, col], [r, col - 1], [r, col + 1]]) {
              const n = nr * 12 + nc;
              if (nr >= 0 && nr < 12 && nc >= 0 && nc < 12 && islands.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
            }
          }
        }
        assert(clusters === 4, `${t} has ${clusters} island clusters`);
        for (const p of players.filter((q) => q.team === t)) {
          const s = p.client.state;
          assert(JSON.stringify([...s.own.islands].sort()) === JSON.stringify([...islands].sort()), 'player sees different own islands');
          assert(s.voting.legal.every((c) => !islands.has(c)), 'an island square is a legal placement option');
        }
      }
      assert(JSON.stringify(hs().teams.blue.islands) !== JSON.stringify(hs().teams.red.islands), 'both teams got identical islands');
    });

    // 8 + 9 -----------------------------------------------------------
    await step('Ship-placement majority voting', async () => {
      const [b1, b2] = team('blue');
      await allSee([b1, b2], (s) => s.voting.kind === 'start' && s.voting.required === 2, 'required 2 of 2');
      const legal = b1.client.state.voting.legal;
      await b1.client.ok('vote', { value: legal[0] });
      await b2.client.waitFor((c) => c.state.voting.tallies[legal[0]] === 1, 'tally 1');
      assert(hs().teams.blue.placement.stage === 'start', 'one vote of two resolved the decision');
      await b2.client.ok('vote', { value: legal[1] });
      await sleep(150);
      assert(hs().teams.blue.placement.stage === 'start', 'split votes resolved the decision');
      await b2.client.ok('vote', { value: legal[0] });
      await host.waitFor((h) => h.hostState.teams.blue.placement.stage === 'direction', 'start square locked');
      assert(hs().teams.blue.placement.start === legal[0], 'wrong start square locked');
      await allSee([b1, b2], (s) => s.voting.kind === 'direction', 'direction vote open');
      const dirs = b1.client.state.voting.legal;
      // Switch through the other legal directions first (votes may change), then settle on dirs[0].
      // Voting the current choice again would withdraw it, so dirs[0] is voted exactly once.
      for (const d of dirs.slice(1)) await b1.client.ok('vote', { value: d });
      await b1.client.ok('vote', { value: dirs[0] });
      await b2.client.ok('vote', { value: dirs[0] });
      await host.waitFor((h) => h.hostState.teams.blue.ships.length === 1, 'carrier placed');
    });

    await step('Ship placement legality', async () => {
      const [b1] = team('blue');
      await allSee(team('blue'), (s) => s.placement.placed === 1 && s.voting.kind === 'start', 'next ship');
      const island = hs().teams.blue.islands[0];
      const r1 = await b1.client.emit('vote', { value: island });
      assert(r1 && !r1.ok, 'voting for an island square was accepted');
      const carrier = hs().teams.blue.ships[0].cells;
      const r2 = await b1.client.emit('vote', { value: carrier[0] });
      assert(r2 && !r2.ok, 'voting for an occupied square was accepted');
      const touching = carrier.flatMap((c) => {
        const r = Math.floor(c / 12);
        const col = c % 12;
        return [[r - 1, col], [r + 1, col], [r, col - 1], [r, col + 1]]
          .filter(([nr, nc]) => nr >= 0 && nr < 12 && nc >= 0 && nc < 12)
          .map(([nr, nc]) => nr * 12 + nc);
      })
        .filter((c) => !carrier.includes(c))
        .find((c) => !hs().teams.blue.islands.includes(c));
      if (touching !== undefined) {
        const r3 = await b1.client.emit('vote', { value: touching });
        assert(r3 && !r3.ok, 'a square touching the carrier was accepted');
      }
      for (const bad of [-1, 144, 3.5, '7', null]) {
        const r = await b1.client.emit('vote', { value: bad });
        assert(r && !r.ok, `malformed vote ${JSON.stringify(bad)} was accepted`);
      }
      // Finish both fleets, then check every rule on the server's own record.
      while (hs().phase === 'PLACEMENT') {
        for (const t of ['blue', 'red']) if (!hs().teams[t].placement.done && hs().phase === 'PLACEMENT') await placeOneStep(t);
      }
      for (const t of ['blue', 'red']) {
        const T = hs().teams[t];
        assert(JSON.stringify(T.ships.map((s) => s.len)) === '[5,4,3,3,2]', `${t} fleet is wrong`);
        const owner = new Map();
        T.ships.forEach((s, i) => s.cells.forEach((c) => { assert(!owner.has(c), 'overlap'); owner.set(c, i); }));
        for (const [c, i] of owner) {
          assert(!T.islands.includes(c), 'ship on an island');
          const r = Math.floor(c / 12);
          const col = c % 12;
          for (const [nr, nc] of [[r - 1, col], [r + 1, col], [r, col - 1], [r, col + 1]]) {
            if (nr < 0 || nr > 11 || nc < 0 || nc > 11) continue;
            const o = owner.get(nr * 12 + nc);
            assert(o === undefined || o === i, 'ships share an edge');
          }
        }
      }
    });

    await host.waitFor((h) => h.hostState.phase === 'BATTLE' && h.hostState.turn === 'blue', 'battle with blue first');
    await allSee(players, (s) => s.phase === 'BATTLE', 'battle phase');

    // 18 + 19 (initial) -----------------------------------------------
    await step('Intelligence generation', async () => {
      await allSee(players, (s) => s.intel.length >= 1, 'initial intelligence');
      for (const t of ['blue', 'red']) assert(hs().teams[t].intel.length >= 1, `GM sees no intel for ${t}`);
    });

    await step('Intelligence privacy', async () => {
      const blueIds = new Set(hs().teams.blue.intel.map((r) => r.id));
      for (const p of players) {
        const s = p.client.state;
        for (const r of s.intel) {
          assert(JSON.stringify(Object.keys(r).sort()) === '["id","source","text","ts"]', 'intel payload carries extra fields');
          assert(blueIds.has(r.id) === (p.team === 'blue'), `${p.team} received the other team's intelligence`);
          assert(!/\b[A-L](1[0-2]|[1-9])\b/.test(r.text), `intel reveals an exact square: ${r.text}`);
        }
        assert(JSON.stringify(Object.keys(s.enemy).sort()) === '["islands","shipsPlaced","shipsRemaining","shots","sunkShips"]', 'enemy view has extra fields');
        assert(s.enemy.sunkShips.length === 0, 'unsunk enemy ships revealed');
      }
    });

    // 10 -----------------------------------------------------------
    await step('Attack majority voting', async () => {
      await waitTurn('blue');
      const [b1, b2] = team('blue');
      const target = missCell('blue');
      await b1.client.ok('vote', { value: target });
      await b2.client.waitFor((c) => c.state.voting.tallies[target] === 1, 'attack tally 1');
      assert(hs().attackCount === 0, 'a single vote out of two fired');
      await b2.client.ok('vote', { value: target });
      await host.waitFor((h) => h.hostState.attackCount === 1 && h.hostState.turn === 'red', 'attack executed, turn passes');
    });

    // 11 -----------------------------------------------------------
    await step('Invalid attacks are rejected', async () => {
      await waitTurn('red');
      const [b1] = team('blue');
      const [r1] = team('red');
      const wrongTurn = await b1.client.emit('vote', { value: legalAttack('red')[0] });
      assert(wrongTurn && !wrongTurn.ok, "blue voted during red's turn");
      const island = hs().teams.blue.islands[0];
      const r = await r1.client.emit('vote', { value: island });
      assert(r && !r.ok, 'an island square was accepted as a target');
      for (const bad of [144, -3, 2.5, 'A1', { x: 1 }]) {
        const res = await r1.client.emit('vote', { value: bad });
        assert(res && !res.ok, `malformed target ${JSON.stringify(bad)} was accepted`);
      }
    });

    // 13 -----------------------------------------------------------
    await step('Miss recognition', async () => {
      const cell = missCell('red');
      await attack('red', cell);
      assert(hs().teams.blue.shots.find((s) => s.i === cell).result === 'miss', 'server did not record a miss');
      await allSee(players.filter((p) => p.team === 'red'), (s) => s.enemy.shots.some((x) => x.i === cell && x.result === 'miss'), 'attackers see the miss');
      await allSee(players.filter((p) => p.team === 'blue'), (s) => s.own.shots.some((x) => x.i === cell && x.result === 'miss'), 'defenders see the miss');
    });

    // 12 -----------------------------------------------------------
    await step('Hit recognition', async () => {
      const cell = unhitShipCell('blue', 'Carrier');
      await attack('blue', cell);
      assert(hs().teams.red.shots.find((s) => s.i === cell).result === 'hit', 'server did not record a hit');
      await allSee(players.filter((p) => p.team === 'blue'), (s) => s.enemy.shots.some((x) => x.i === cell && x.result === 'hit'), 'attackers see the hit');
      await allSee(players.filter((p) => p.team === 'red'), (s) => s.own.shots.some((x) => x.i === cell && x.result === 'hit'), 'defenders see the hit');
      // repeat attack on the same square
      await attack('red', missCell('red'));
      await waitTurn('blue');
      const res = await team('blue')[0].client.emit('vote', { value: cell });
      assert(res && !res.ok, 'a previously attacked square was accepted again');
    });

    // 17 -----------------------------------------------------------
    await step('Pause and resume', async () => {
      const before = { turn: hs().turn, attacks: hs().attackCount };
      await host.ok('host:pause');
      await allSee(players, (s) => s.phase === 'PAUSED', 'paused');
      const res = await team('blue')[0].client.emit('vote', { value: legalAttackFromPlayer(team('blue')[0]) });
      assert(res && !res.ok, 'a vote was accepted while paused');
      await host.ok('host:resume');
      await allSee(players, (s) => s.phase === 'BATTLE', 'resumed');
      assert(hs().turn === before.turn && hs().attackCount === before.attacks, 'resume did not restore the battle');
    });

    // 15 + 16 ------------------------------------------------------
    await step('Player disconnect during voting', async () => {
      await attack('blue', missCell('blue'));
      await waitTurn('red');
      const [r1, r2] = team('red');
      const target = missCell('red');
      const n = hs().attackCount;
      await r1.client.ok('vote', { value: target });
      await r2.client.waitFor((c) => c.state.voting.tallies[target] === 1, 'red tally 1');
      assert(hs().attackCount === n, 'one vote of two fired');
      r2.client.close();
      await host.waitFor((h) => h.hostState.attackCount === n + 1, 'pending vote resolves after disconnect');
      assert(hs().teams.blue.shots.some((s) => s.i === target), 'the pending target was not attacked');
    });

    await step('Majority recalculation', async () => {
      const r2 = players.find((p) => p.team === 'red' && !p.client.socket.connected);
      await host.waitFor((h) => h.hostState.teams.red.voting.eligible === 1 && h.hostState.teams.red.online === 1, 'red electorate of 1');
      const c = await connectClient(`${r2.name}-back`);
      await c.ok('player:resume', { token: r2.token });
      r2.client = c;
      await host.waitFor((h) => h.hostState.teams.red.online === 2, 'red back to 2 online');
      await attack('blue', missCell('blue'));
      await allSee(team('red'), (s) => s.voting.kind === 'attack' && s.voting.eligible === 2 && s.voting.required === 2, 'red needs 2 of 2 again');
    });

    // 14 -----------------------------------------------------------
    await step('Ship sinking', async () => {
      await attack('red', missCell('red'));
      while (!hs().teams.red.ships.find((s) => s.name === 'Destroyer').sunk) {
        await attack('blue', unhitShipCell('blue', 'Destroyer'));
        if (hs().phase === 'BATTLE') await attack('red', missCell('red'));
      }
      await allSee(players.filter((p) => p.team === 'blue'), (s) => s.enemy.sunkShips.some((x) => x.name === 'Destroyer') && s.enemy.shipsRemaining === 4, 'attackers see the sunk destroyer');
      await allSee(players.filter((p) => p.team === 'red'), (s) => s.own.ships.find((x) => x.name === 'Destroyer').sunk, 'defenders see their sunk destroyer');
      for (const p of players.filter((q) => q.team === 'blue')) {
        assert(p.client.state.enemy.sunkShips.length === 1, 'other enemy ships were revealed');
      }
    });

    // 20 -----------------------------------------------------------
    await step('Complete game through victory', async () => {
      const introAttacks = hs().attackCount;
      while (hs().phase === 'BATTLE') {
        if (hs().turn === 'blue') await attack('blue', unhitShipCell('blue'));
        else await attack('red', missCell('red'));
      }
      assert(hs().phase === 'FINISHED' && hs().winner === 'blue', `expected blue to win, got ${hs().phase}/${hs().winner}`);
      await allSee(players, (s) => s.phase === 'FINISHED' && s.winner === 'blue', 'everyone sees the winner');
      const res = await team('red')[0].client.emit('vote', { value: 0 });
      assert(res && !res.ok, 'a vote was accepted after victory');
      assert(hs().attackCount > introAttacks, 'no attacks were made');
      const intel = hs().teams.blue.intel.length;
      assert(intel >= 2, `intelligence was not issued periodically (${intel} reports)`);
      report.attacks = hs().attackCount;
    });

    // 21 -----------------------------------------------------------
    await step('Game reset', async () => {
      await host.ok('host:reset', { confirm: true, removePlayers: false });
      await host.waitFor((h) => h.hostState.phase === 'LOBBY', 'lobby after reset');
      const h = hs();
      assert(h.attackCount === 0 && h.log.length <= 1, 'battle progress survived the reset');
      for (const t of ['blue', 'red']) {
        assert(h.teams[t].islands.length === 0 && h.teams[t].ships.length === 0 && h.teams[t].intel.length === 0, `${t} board not cleared`);
        assert(h.teams[t].roster.length === 2, `${t} players were not retained`);
      }
      await allSee(players, (s) => s.phase === 'LOBBY' && s.own.ships.length === 0, 'players see a clean lobby');
      for (const p of players) assert(p.client.state.me.team === p.team, 'a team changed across the reset');
      await players[0].client.waitFor((c) => c.chat.length === 0, 'chat cleared');
      const noConfirm = await host.emit('host:reset', { removePlayers: true });
      assert(noConfirm && !noConfirm.ok, 'reset without confirmation was accepted');
      await host.ok('host:reset', { confirm: true, removePlayers: true });
      await Promise.all(players.map((p) => p.client.waitFor((c) => c.removed, 'removed notice')));
      await host.waitFor((x) => x.hostState.teams.blue.roster.length === 0, 'all players removed');
    });
  } catch (err) {
    console.log(`\nAborted: ${err.message}`);
    report.failed += 1;
    report.tests.push({ id: currentTest + 1, name: 'Run aborted', status: 'failed', durationMs: 0, error: err.message });
  } finally {
    if (host && host.hostState) {
      report.phase = host.hostState.phase;
      if (!report.attacks) report.attacks = host.hostState.attackCount;
    }
    for (const c of clients) c.close();
    if (local) await local.close();
    writeReport();
  }
  process.exit(report.failed > 0 ? 1 : 0);
}

function legalAttackFromPlayer(p) {
  const s = p.client.state;
  const shot = new Set(s.enemy.shots.map((x) => x.i));
  const islands = new Set(s.enemy.islands);
  for (let i = 0; i < 144; i++) if (!shot.has(i) && !islands.has(i)) return i;
  return 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

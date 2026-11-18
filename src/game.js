'use strict';

// Server-authoritative game engine. Knows nothing about sockets: the server calls these
// methods with an already-authenticated player id and broadcasts views on 'change'.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  CELLS, FLEET, TEAMS, PHASES, DIRS, LIMITS, coordOf, otherTeam, requiredVotes,
} = require('./constants');
const { shipCells, canPlace, fleetFits, generateIslands } = require('./board');
const { generateIntel } = require('./intel');

const { LOBBY, PLACEMENT, BATTLE, PAUSED, FINISHED } = PHASES;

const fail = (error) => ({ ok: false, error });
const randomId = (bytes) => crypto.randomBytes(bytes).toString('hex');

// Strip control, zero-width and bidi-override characters; collapse whitespace.
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  const len = [...name].length;
  if (len < 1 || len > LIMITS.NAME_MAX) return null;
  return name;
}

function cleanChat(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFC').replace(/[\r\n\t]+/g, ' ').replace(UNSAFE_CHARS, '').trim();
  const len = [...text].length;
  if (len < 1 || len > LIMITS.CHAT_MAX) return null;
  return text;
}

function newTeam() {
  return {
    islands: new Set(),
    ships: [], // { name, len, cells, hits:Set, sunk }
    occupied: new Map(), // cell -> ship index
    shots: new Map(), // enemy shots at THIS team's board: cell -> 'hit' | 'miss'
    placement: { stage: 'start', start: null },
    votes: new Map(), // playerId -> value
    intel: [],
    chat: [],
    legalCache: null, // placement: Map(start -> [dirs])
  };
}

class Game extends EventEmitter {
  constructor({ rand = Math.random } = {}) {
    super();
    this.rand = rand;
    this.players = new Map(); // id -> player
    this.tokens = new Map(); // session token -> player id
    this.resetState();
  }

  resetState() {
    this.gameId = randomId(6);
    this.phase = LOBBY;
    this.pausedFrom = null;
    this.turn = null;
    this.winner = null;
    this.attackCount = 0;
    this.log = [];
    this.seq = 0;
    this.teams = { blue: newTeam(), red: newTeam() };
  }

  changed() {
    this.emit('change');
  }

  nextId() {
    this.seq += 1;
    return this.seq;
  }

  addLog(text, team = null) {
    this.log.push({ id: this.nextId(), ts: Date.now(), text, team });
    if (this.log.length > LIMITS.LOG_HISTORY) this.log.shift();
  }

  // ---------- players ----------

  teamPlayers(team) {
    return [...this.players.values()].filter((p) => p.team === team);
  }

  connectedPlayers(team) {
    return this.teamPlayers(team).filter((p) => p.connected);
  }

  addPlayer(rawName) {
    if (this.phase !== LOBBY) return fail('The game has already started. New players cannot join now.');
    const name = cleanName(rawName);
    if (!name) return fail(`Enter a display name of 1–${LIMITS.NAME_MAX} characters.`);
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return fail('That name is already taken in this game.');
    }
    if (this.players.size >= LIMITS.MAX_PLAYERS) return fail('The game is full.');
    const blue = this.teamPlayers('blue').length;
    const red = this.teamPlayers('red').length;
    const team = blue <= red ? 'blue' : 'red';
    const player = {
      id: randomId(6),
      token: randomId(24),
      name,
      team,
      sockets: new Set(),
      connected: false,
    };
    this.players.set(player.id, player);
    this.tokens.set(player.token, player.id);
    this.changed();
    return { ok: true, player };
  }

  playerByToken(token) {
    if (typeof token !== 'string' || token.length > 100) return null;
    const id = this.tokens.get(token);
    return id ? this.players.get(id) : null;
  }

  attachSocket(playerId, socketId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.sockets.add(socketId);
    p.connected = true;
    this.changed();
  }

  detachSocket(playerId, socketId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.sockets.delete(socketId);
    if (p.sockets.size > 0) return;
    p.connected = false;
    // Disconnected players drop out of the electorate; their vote goes with them.
    this.teams[p.team].votes.delete(p.id);
    this.tryResolve(p.team);
    this.changed();
  }

  removePlayer(p) {
    this.players.delete(p.id);
    this.tokens.delete(p.token);
  }

  // ---------- GM controls ----------

  start() {
    if (this.phase !== LOBBY) return fail(`Cannot start from ${this.phase}.`);
    for (const t of TEAMS) {
      if (this.connectedPlayers(t).length === 0) return fail('Both teams need at least one connected player.');
    }
    for (const t of TEAMS) this.teams[t].islands = generateIslands(this.rand);
    this.phase = PLACEMENT;
    this.addLog('The Game Master started the game. Both teams are placing their fleets.');
    this.changed();
    return { ok: true };
  }

  pause() {
    if (this.phase !== BATTLE && this.phase !== PLACEMENT) return fail(`Cannot pause during ${this.phase}.`);
    this.pausedFrom = this.phase;
    this.phase = PAUSED;
    this.addLog('The Game Master paused the game.');
    this.changed();
    return { ok: true };
  }

  resume() {
    if (this.phase !== PAUSED) return fail('The game is not paused.');
    this.phase = this.pausedFrom;
    this.pausedFrom = null;
    this.addLog('The Game Master resumed the game.');
    // Disconnects during the pause may already satisfy a majority.
    for (const t of TEAMS) this.tryResolve(t);
    this.changed();
    return { ok: true };
  }

  /**
   * Back to a clean lobby. Connected players keep their teams; disconnected players are dropped.
   * With removePlayers every player is removed and must join again.
   */
  reset({ removePlayers = false } = {}) {
    const removed = [];
    for (const p of [...this.players.values()]) {
      if (removePlayers || !p.connected) {
        removed.push(p);
        this.removePlayer(p);
      }
    }
    this.resetState();
    this.addLog(removePlayers
      ? 'The Game Master reset the game and removed all players.'
      : 'The Game Master reset the game. Teams were kept.');
    this.changed();
    return { ok: true, removed };
  }

  // ---------- legal options ----------

  placementLegal(team) {
    const T = this.teams[team];
    if (T.legalCache) return T.legalCache;
    const index = T.ships.length;
    const len = FLEET[index].len;
    const remaining = FLEET.slice(index + 1).map((s) => s.len);
    const occupied = new Set(T.occupied.keys());
    const legal = new Map();
    for (let start = 0; start < CELLS; start++) {
      const dirs = [];
      for (const dir of Object.keys(DIRS)) {
        const cells = shipCells(start, dir, len);
        if (!cells || !canPlace(cells, T.islands, occupied)) continue;
        // Never let a team paint itself into a corner where the rest of the fleet cannot fit.
        for (const c of cells) occupied.add(c);
        const fits = fleetFits(T.islands, occupied, remaining, { n: 20000, optimistic: true });
        for (const c of cells) occupied.delete(c);
        if (fits) dirs.push(dir);
      }
      if (dirs.length) legal.set(start, dirs);
    }
    T.legalCache = legal;
    return legal;
  }

  /** What the given team is voting on right now, and which values are allowed. */
  legalOptions(team) {
    const T = this.teams[team];
    if (this.phase === PLACEMENT && T.ships.length < FLEET.length) {
      const legal = this.placementLegal(team);
      if (T.placement.stage === 'start') return { kind: 'start', values: [...legal.keys()] };
      return { kind: 'direction', values: legal.get(T.placement.start) || [] };
    }
    if (this.phase === BATTLE && this.turn === team) {
      const E = this.teams[otherTeam(team)];
      const values = [];
      for (let i = 0; i < CELLS; i++) if (!E.islands.has(i) && !E.shots.has(i)) values.push(i);
      return { kind: 'attack', values };
    }
    return { kind: null, values: [] };
  }

  // ---------- voting ----------

  vote(playerId, value) {
    const p = this.players.get(playerId);
    if (!p) return fail('Unknown player.');
    if (!p.connected) return fail('You are not connected.');
    if (this.phase === PAUSED) return fail('The game is paused.');
    if (this.phase === FINISHED) return fail('The game is over.');
    if (this.phase === LOBBY) return fail('The game has not started.');
    const opts = this.legalOptions(p.team);
    if (!opts.kind) {
      if (this.phase === BATTLE) return fail("It is the other team's turn.");
      return fail('Your fleet is already placed.');
    }
    if (opts.kind === 'direction' ? typeof value !== 'string' : !Number.isInteger(value)) {
      return fail('Invalid vote.');
    }
    if (!opts.values.includes(value)) {
      return fail(opts.kind === 'attack' ? 'That square cannot be attacked.' : 'That placement is not legal.');
    }
    const T = this.teams[p.team];
    if (T.votes.get(p.id) === value) T.votes.delete(p.id); // clicking your own vote again withdraws it
    else T.votes.set(p.id, value);
    const resolved = this.tryResolve(p.team);
    this.changed();
    return { ok: true, resolved };
  }

  tally(team) {
    const T = this.teams[team];
    const eligible = this.connectedPlayers(team);
    const counts = new Map();
    for (const p of eligible) {
      const v = T.votes.get(p.id);
      if (v !== undefined) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return { eligible: eligible.length, required: requiredVotes(eligible.length), counts };
  }

  /** Executes the team's decision if one option holds a strict majority of connected players. */
  tryResolve(team) {
    const opts = this.legalOptions(team);
    if (!opts.kind) return false;
    const T = this.teams[team];
    for (const [pid, v] of T.votes) {
      const p = this.players.get(pid);
      if (!p || !p.connected || !opts.values.includes(v)) T.votes.delete(pid);
    }
    const { eligible, required, counts } = this.tally(team);
    if (eligible === 0) return false;
    for (const [value, n] of counts) {
      if (n >= required) {
        T.votes.clear();
        if (opts.kind === 'start') this.lockStart(team, value);
        else if (opts.kind === 'direction') this.placeShip(team, value);
        else this.attack(team, value);
        return true;
      }
    }
    return false;
  }

  // ---------- placement ----------

  lockStart(team, cell) {
    const T = this.teams[team];
    T.placement = { stage: 'direction', start: cell };
    this.addLog(`${FLEET[T.ships.length].name}: starting square ${coordOf(cell)} chosen.`, team);
  }

  placeShip(team, dir) {
    const T = this.teams[team];
    const spec = FLEET[T.ships.length];
    const cells = shipCells(T.placement.start, dir, spec.len);
    const index = T.ships.length;
    T.ships.push({ name: spec.name, len: spec.len, cells, hits: new Set(), sunk: false });
    for (const c of cells) T.occupied.set(c, index);
    T.placement = { stage: 'start', start: null };
    T.legalCache = null;
    this.addLog(`${spec.name} placed at ${coordOf(cells[0])}–${coordOf(cells[cells.length - 1])}.`, team);
    if (TEAMS.every((t) => this.teams[t].ships.length === FLEET.length)) this.beginBattle();
    else if (T.ships.length === FLEET.length) this.addLog('Your fleet is in position. Waiting for the enemy.', team);
  }

  beginBattle() {
    this.phase = BATTLE;
    this.turn = 'blue';
    for (const t of TEAMS) this.teams[t].votes.clear();
    this.addLog('All fleets are in position. Battle begins — Blue attacks first.');
    for (let k = 0; k < LIMITS.INTEL_AT_START; k++) this.issueIntel();
  }

  // ---------- battle ----------

  attack(team, cell) {
    const enemy = otherTeam(team);
    const E = this.teams[enemy];
    const shipIndex = E.occupied.get(cell);
    const hit = shipIndex !== undefined;
    E.shots.set(cell, hit ? 'hit' : 'miss');
    this.attackCount += 1;
    const label = team === 'blue' ? 'Blue' : 'Red';
    let text = `${label} fires at ${coordOf(cell)} — ${hit ? 'HIT' : 'miss'}.`;
    if (hit) {
      const ship = E.ships[shipIndex];
      ship.hits.add(cell);
      if (ship.hits.size === ship.len) {
        ship.sunk = true;
        const left = E.ships.filter((s) => !s.sunk).length;
        text = `${label} fires at ${coordOf(cell)} — HIT and sinks the enemy ${ship.name}! ${left} ${left === 1 ? 'ship' : 'ships'} left.`;
      }
    }
    this.addLog(text);
    for (const t of TEAMS) this.teams[t].votes.clear();

    if (E.ships.every((s) => s.sunk)) {
      this.phase = FINISHED;
      this.winner = team;
      this.turn = null;
      this.addLog(`${label.toUpperCase()} TEAM WINS! All five enemy ships have been sunk.`);
      return;
    }
    this.turn = enemy;
    if (this.attackCount % LIMITS.INTEL_EVERY_ATTACKS === 0) this.issueIntel();
  }

  issueIntel() {
    for (const t of TEAMS) {
      const T = this.teams[t];
      const last = T.intel[T.intel.length - 1];
      const report = generateIntel(this.teams[otherTeam(t)].ships, this.rand, last && last.fact.type);
      if (!report) continue;
      T.intel.push({ id: this.nextId(), ts: Date.now(), ...report });
      if (T.intel.length > LIMITS.INTEL_HISTORY) T.intel.shift();
    }
  }

  // ---------- chat ----------

  chat(playerId, raw) {
    const p = this.players.get(playerId);
    if (!p) return fail('Unknown player.');
    const text = cleanChat(raw);
    if (!text) return fail(`Messages must be 1–${LIMITS.CHAT_MAX} characters.`);
    const msg = { id: this.nextId(), ts: Date.now(), from: p.name, fromId: p.id, text };
    const T = this.teams[p.team];
    T.chat.push(msg);
    if (T.chat.length > LIMITS.CHAT_HISTORY) T.chat.shift();
    return { ok: true, msg, team: p.team };
  }

  // ---------- views ----------

  voteView(team, playerId) {
    const opts = this.legalOptions(team);
    const { eligible, required, counts } = this.tally(team);
    const view = {
      kind: opts.kind,
      legal: opts.values,
      eligible,
      required,
      tallies: Object.fromEntries(counts),
    };
    if (playerId !== undefined) {
      const mine = this.teams[team].votes.get(playerId);
      view.myVote = mine === undefined ? null : mine;
    }
    return view;
  }

  placementView(team) {
    const T = this.teams[team];
    const index = T.ships.length;
    const done = index >= FLEET.length;
    return {
      done,
      placed: index,
      total: FLEET.length,
      ship: done ? null : { ...FLEET[index] },
      stage: done ? null : T.placement.stage,
      start: done ? null : T.placement.start,
    };
  }

  static shipView(s) {
    return { name: s.name, len: s.len, cells: s.cells, hits: [...s.hits], sunk: s.sunk };
  }

  static intelView(r) {
    return { id: r.id, ts: r.ts, source: r.source, text: r.text };
  }

  common() {
    return {
      gameId: this.gameId,
      phase: this.phase,
      pausedFrom: this.pausedFrom,
      turn: this.turn,
      winner: this.winner,
      attackCount: this.attackCount,
      fleet: FLEET,
    };
  }

  /** Everything one player may see: own fleet in full, enemy only through shots and sunk ships. */
  playerView(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const team = p.team;
    const enemy = otherTeam(team);
    const T = this.teams[team];
    const E = this.teams[enemy];
    const roster = this.teamPlayers(team).map((m) => ({
      id: m.id, name: m.name, connected: m.connected, you: m.id === p.id,
    }));
    const sunkEnemy = E.ships.filter((s) => s.sunk);
    return {
      ...this.common(),
      me: { id: p.id, name: p.name, team },
      roster,
      online: roster.filter((m) => m.connected).length,
      teamSizes: { blue: this.teamPlayers('blue').length, red: this.teamPlayers('red').length },
      own: {
        islands: [...T.islands],
        ships: T.ships.map(Game.shipView),
        shots: [...T.shots].map(([i, result]) => ({ i, result })),
      },
      enemy: {
        islands: [...E.islands],
        shots: [...E.shots].map(([i, result]) => ({ i, result })),
        sunkShips: sunkEnemy.map((s) => ({ name: s.name, len: s.len, cells: s.cells })),
        shipsPlaced: E.ships.length,
        shipsRemaining: E.ships.length - sunkEnemy.length,
      },
      placement: this.placementView(team),
      voting: this.voteView(team, p.id),
      intel: T.intel.map(Game.intelView),
      log: this.log.filter((e) => e.team === null || e.team === team),
    };
  }

  /** The Game Master sees everything except session tokens. */
  hostView() {
    const teams = {};
    for (const t of TEAMS) {
      const T = this.teams[t];
      const roster = this.teamPlayers(t).map((m) => ({ id: m.id, name: m.name, connected: m.connected }));
      teams[t] = {
        roster,
        online: roster.filter((m) => m.connected).length,
        islands: [...T.islands],
        ships: T.ships.map(Game.shipView),
        shots: [...T.shots].map(([i, result]) => ({ i, result })),
        placement: this.placementView(t),
        voting: this.voteView(t),
        intel: T.intel.map(Game.intelView),
        shipsRemaining: T.ships.filter((s) => !s.sunk).length,
      };
    }
    return { ...this.common(), teams, log: this.log };
  }

  chatHistory(team) {
    return this.teams[team].chat.slice();
  }
}

module.exports = { Game, cleanName, cleanChat };

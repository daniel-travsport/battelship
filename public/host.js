'use strict';

(function () {
  const { el, buildGrid, paintCell, coord, timeOf, renderList, TEAM_LABEL, PHASE_LABEL } = window.BS;
  const KEY_STORE = 'bs_host_key';
  const $ = (id) => document.getElementById(id);

  // The key is typed by the GM and kept only for this tab so a reconnect can re-authenticate.
  const keyStore = {
    get() { try { return sessionStorage.getItem(KEY_STORE); } catch { return null; } },
    set(v) { try { sessionStorage.setItem(KEY_STORE, v); } catch { /* ignore */ } },
    clear() { try { sessionStorage.removeItem(KEY_STORE); } catch { /* ignore */ } },
  };

  const socket = io({ transports: ['websocket', 'polling'] });
  let state = null;

  const panels = {};
  for (const team of ['blue', 'red']) {
    const root = document.querySelector(`.host-team[data-team="${team}"]`);
    const f = (name) => root.querySelector(`[data-f="${name}"]`);
    panels[team] = {
      cells: buildGrid(f('grid')),
      online: f('online'), roster: f('roster'), progress: f('progress'), fleet: f('fleet'), intel: f('intel'),
    };
  }

  function auth(key, fromForm) {
    socket.emit('host:auth', { key }, (res) => {
      if (res && res.ok) {
        keyStore.set(key);
        $('authView').hidden = true;
        $('hostView').hidden = false;
        $('authError').textContent = '';
      } else {
        keyStore.clear();
        $('authView').hidden = false;
        $('hostView').hidden = true;
        if (fromForm || res) $('authError').textContent = (res && res.error) || 'Sign-in failed.';
      }
    });
  }

  socket.on('connect', () => {
    $('conn').textContent = '● online';
    $('conn').className = 'conn';
    const key = keyStore.get();
    if (key) auth(key, false);
  });
  socket.on('disconnect', () => {
    $('conn').textContent = '● reconnecting…';
    $('conn').className = 'conn bad';
  });

  $('authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('keyInput').value;
    $('keyInput').value = '';
    if (key) auth(key, true);
  });

  function command(event, payload) {
    $('ctlMsg').textContent = '';
    socket.emit(event, payload || {}, (res) => {
      if (!res || !res.ok) $('ctlMsg').textContent = (res && res.error) || 'Command failed.';
    });
  }
  $('btnStart').addEventListener('click', () => command('host:start'));
  $('btnPause').addEventListener('click', () => command('host:pause'));
  $('btnResume').addEventListener('click', () => command('host:resume'));
  $('btnReset').addEventListener('click', () => {
    const removePlayers = $('removeAll').checked;
    const msg = removePlayers
      ? 'Reset the game and REMOVE ALL PLAYERS? Everyone must join again.'
      : 'Reset the game? Connected players keep their teams; ships, votes, attacks, islands, Intelligence, chat and the battle log are cleared.';
    if (window.confirm(msg)) command('host:reset', { confirm: true, removePlayers });
  });

  socket.on('host:state', (s) => {
    state = s;
    render();
  });

  function render() {
    const s = state;
    $('phasePill').textContent = PHASE_LABEL[s.phase] || s.phase;
    $('phasePill').className = `pill${s.phase === 'PAUSED' ? ' warn' : ''}`;
    const turn = $('turnPill');
    if (s.turn) {
      turn.hidden = false;
      turn.className = `pill ${s.turn}`;
      turn.textContent = `${TEAM_LABEL[s.turn]} attacking`;
    } else turn.hidden = true;
    $('attackInfo').textContent = s.phase === 'LOBBY' ? '' : `Attacks: ${s.attackCount}`;

    $('btnStart').disabled = s.phase !== 'LOBBY';
    $('btnPause').disabled = s.phase !== 'BATTLE' && s.phase !== 'PLACEMENT';
    $('btnResume').disabled = s.phase !== 'PAUSED';

    $('winner').hidden = s.phase !== 'FINISHED';
    if (s.winner) {
      $('winnerText').textContent = `${TEAM_LABEL[s.winner].toUpperCase()} TEAM WINS! — ${s.teams[s.winner === 'blue' ? 'red' : 'blue'].ships.length} enemy ships sunk in ${s.attackCount} attacks`;
      $('winnerText').className = s.winner;
    }

    for (const team of ['blue', 'red']) renderTeam(s, team);

    renderList($('log'), s.log.slice().reverse(), (e) => e.id, (e) => {
      const li = el('li', e.team ? 'private' : '');
      li.appendChild(document.createTextNode(e.team ? `[${TEAM_LABEL[e.team]}] ${e.text}` : e.text));
      li.appendChild(el('span', 'ts', timeOf(e.ts)));
      return li;
    });
  }

  function voteSummary(v) {
    const n = Object.values(v.tallies).reduce((a, b) => a + b, 0);
    return `${n}/${v.eligible} voted, ${v.required} needed`;
  }

  function renderTeam(s, team) {
    const P = panels[team];
    const T = s.teams[team];
    const attacker = s.teams[team === 'blue' ? 'red' : 'blue'];
    const islands = new Set(T.islands);
    const shots = new Map(T.shots.map((x) => [x.i, x.result]));
    const shipAt = new Map();
    T.ships.forEach((sh) => sh.cells.forEach((c) => shipAt.set(c, sh)));
    // Placement votes land on the team's own board; attack votes from the other team land here too.
    const ownVote = T.voting.kind === 'start' ? T.voting : null;
    const enemyVote = attacker.voting.kind === 'attack' ? attacker.voting : null;
    for (let i = 0; i < P.cells.length; i++) {
      const ship = shipAt.get(i);
      let st = 'water';
      if (islands.has(i)) st = 'island';
      else if (ship && ship.sunk) st = 'sunk';
      else if (shots.get(i) === 'hit') st = 'hit-enemy';
      else if (shots.get(i) === 'miss') st = 'miss';
      else if (ship) st = 'ship';
      else if (i === T.placement.start) st = 'pending';
      const tally = (ownVote && ownVote.tallies[i]) || (enemyVote && enemyVote.tallies[i]) || 0;
      paintCell(P.cells[i], { state: st, tally });
    }

    P.online.textContent = `Online: ${T.online} / ${T.roster.length}`;
    const rosterRebuilt = renderList(P.roster, T.roster, (m) => `${m.id}:${m.connected}`, (m) => {
      const b = el('span', 'mate');
      b.appendChild(el('span', `dot${m.connected ? ' on' : ''}`));
      b.appendChild(el('span', 'name', m.name));
      return b;
    });
    if (rosterRebuilt && T.roster.length === 0) P.roster.appendChild(el('span', 'muted', 'No players yet.'));

    const pr = P.progress;
    pr.textContent = '';
    const p = T.placement;
    if (s.phase === 'LOBBY') pr.textContent = `${T.roster.length} player(s) registered.`;
    else if (!p.done && (s.phase === 'PLACEMENT' || s.pausedFrom === 'PLACEMENT')) {
      pr.append(`Placing ${p.placed + 1}/${p.total}: ${p.ship.name} (${p.ship.len}) — `);
      pr.append(p.stage === 'start' ? 'choosing start square. ' : `start ${coord(p.start)}, choosing direction. `);
      const dirTallies = T.voting.kind === 'direction'
        ? Object.entries(T.voting.tallies).map(([d, n]) => `${d} ${n}`).join(', ') : '';
      pr.append(el('span', 'muted', voteSummary(T.voting) + (dirTallies ? ` · ${dirTallies}` : '')));
    } else if (s.phase === 'PLACEMENT') pr.textContent = 'Fleet placed. Waiting for the other team.';
    else {
      pr.append(`${T.shipsRemaining}/5 ships afloat. `);
      if (T.voting.kind === 'attack') pr.append(el('strong', null, `Attacking now — ${voteSummary(T.voting)}`));
    }

    renderList(P.fleet, s.fleet.map((spec, idx) => ({ spec, ship: T.ships[idx] })), (x) => `${x.spec.name}:${x.ship ? x.ship.hits.length + (x.ship.sunk ? 's' : '') : 'u'}`, ({ spec, ship }) => {
      const chip = el('span', `ship-chip${!ship ? ' unplaced' : ship.sunk ? ' sunk' : ''}`);
      chip.appendChild(el('span', null, spec.name));
      const pips = el('span', 'pips');
      for (let k = 0; k < spec.len; k++) pips.appendChild(el('span', `pip${ship && ship.hits.includes(ship.cells[k]) ? ' hit' : ''}`));
      chip.appendChild(pips);
      return chip;
    });

    const intelRebuilt = renderList(P.intel, T.intel.slice().reverse(), (r) => r.id, (r) => {
      const li = el('li');
      li.appendChild(el('span', 'src', r.source));
      li.appendChild(el('span', 'ts', timeOf(r.ts)));
      li.appendChild(el('div', 'txt', `“${r.text}”`));
      return li;
    });
    if (intelRebuilt && T.intel.length === 0) P.intel.appendChild(el('li', 'muted', 'No reports yet.'));
  }
})();

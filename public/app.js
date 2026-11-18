'use strict';

(function () {
  const { el, buildGrid, paintCell, shipCells, coord, timeOf, renderList, TEAM_LABEL, PHASE_LABEL } = window.BS;
  const TOKEN_KEY = 'bs_session_token';
  const $ = (id) => document.getElementById(id);

  const storage = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* private mode */ } },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
  };

  const socket = io({ transports: ['websocket', 'polling'] });
  let state = null;
  let joined = false;
  let lastGameId = null;
  let dismissedWin = null;
  let previewDir = null;
  const chat = [];

  const ownCells = buildGrid($('ownGrid'), (i) => sendVote(i));
  const enemyCells = buildGrid($('enemyGrid'), (i) => sendVote(i));
  const dirButtons = [...document.querySelectorAll('.dir')];
  for (const b of dirButtons) {
    b.addEventListener('click', () => { if (!b.disabled) sendVote(b.dataset.dir); });
    b.addEventListener('mouseenter', () => { previewDir = b.dataset.dir; render(); });
    b.addEventListener('mouseleave', () => { previewDir = null; render(); });
  }

  function flash(msg) {
    const target = state && state.voting.kind === 'attack' ? $('attackStatus') : $('placeStatus');
    target.textContent = msg;
    target.classList.add('flash');
    setTimeout(render, 1800);
  }

  function sendVote(value) {
    socket.emit('vote', { value }, (res) => { if (res && !res.ok) flash(res.error); });
  }

  // ---------- connection & identity ----------

  function showJoin(message) {
    joined = false;
    $('joinView').hidden = false;
    $('gameView').hidden = true;
    $('teamPill').hidden = true;
    $('turnPill').hidden = true;
    $('meName').textContent = '';
    if (message) $('joinError').textContent = message;
  }

  function showGame() {
    joined = true;
    $('joinView').hidden = true;
    $('gameView').hidden = false;
  }

  socket.on('connect', () => {
    $('conn').textContent = '● online';
    $('conn').className = 'conn';
    const token = storage.get();
    if (!token) return;
    socket.emit('player:resume', { token }, (res) => {
      if (res && res.ok) showGame();
      else { storage.clear(); showJoin(res && res.error); }
    });
  });

  socket.on('disconnect', () => {
    $('conn').textContent = '● reconnecting…';
    $('conn').className = 'conn bad';
  });

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nameInput').value.trim();
    if (!name) return;
    $('joinError').textContent = '';
    socket.emit('player:join', { name }, (res) => {
      if (!res || !res.ok) { $('joinError').textContent = (res && res.error) || 'Could not join.'; return; }
      storage.set(res.token);
      showGame();
    });
  });

  socket.on('lobby', (info) => {
    if (joined) return;
    $('phasePill').textContent = PHASE_LABEL[info.phase] || info.phase;
    $('joinInfo').textContent = info.joinable
      ? `${info.players} player${info.players === 1 ? '' : 's'} waiting in the lobby.`
      : 'A game is in progress. New players can join when the Game Master resets the game.';
  });

  socket.on('player:removed', ({ message }) => {
    storage.clear();
    state = null;
    showJoin(message);
  });

  // ---------- chat ----------

  socket.on('chat:history', (msgs) => {
    chat.length = 0;
    chat.push(...msgs);
    renderChat(true);
  });
  socket.on('chat:message', (msg) => {
    chat.push(msg);
    if (chat.length > 50) chat.shift();
    renderChat(false);
  });

  function renderChat(force) {
    const box = $('chat');
    const atBottom = force || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const rebuilt = renderList(box, chat, (m) => m.id, (m) => {
      const li = el('li', state && m.fromId === state.me.id ? 'mine' : '');
      li.appendChild(el('span', 'from', m.from));
      li.appendChild(document.createTextNode(': '));
      li.appendChild(el('span', 'txt', m.text));
      li.appendChild(el('span', 'ts', timeOf(m.ts)));
      return li;
    });
    if (rebuilt && chat.length === 0) box.appendChild(el('li', 'muted', 'No messages yet. Only your team can read this chat.'));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat:send', { text }, (res) => {
      const err = $('chatError');
      if (res && res.ok) { input.value = ''; err.hidden = true; return; }
      err.textContent = (res && res.error) || 'Message not sent.';
      err.hidden = false;
    });
  });

  // ---------- state ----------

  socket.on('state', (s) => {
    if (lastGameId && s.gameId !== lastGameId) dismissedWin = null;
    lastGameId = s.gameId;
    state = s;
    if (!joined) showGame();
    render();
  });

  $('winClose').addEventListener('click', () => {
    dismissedWin = state && state.gameId;
    $('gameOver').hidden = true;
  });

  function render() {
    if (!state) return;
    const s = state;
    const team = s.me.team;
    const enemy = team === 'blue' ? 'red' : 'blue';

    // top bar
    const tp = $('teamPill');
    tp.hidden = false;
    tp.className = `pill ${team}`;
    tp.textContent = `${TEAM_LABEL[team]} team`;
    $('phasePill').textContent = PHASE_LABEL[s.phase] || s.phase;
    $('phasePill').className = `pill${s.phase === 'PAUSED' ? ' warn' : ''}`;
    const turn = $('turnPill');
    if (s.turn && (s.phase === 'BATTLE' || s.phase === 'PAUSED')) {
      turn.hidden = false;
      turn.className = `pill ${s.turn}`;
      turn.textContent = s.turn === team ? 'Your turn' : `${TEAM_LABEL[s.turn]} attacking`;
    } else turn.hidden = true;
    $('meName').textContent = s.me.name;

    renderOwn(s);
    renderEnemy(s, enemy);
    renderSide(s, team, enemy);
    renderGameOver(s, team);
  }

  function voteFor(s, kind) {
    return s.voting.kind === kind ? s.voting : null;
  }

  function votingLine(v) {
    const n = Object.values(v.tallies).reduce((a, b) => a + b, 0);
    return `${n}/${v.eligible} voted · ${v.required} needed for majority`;
  }

  function renderOwn(s) {
    const islands = new Set(s.own.islands);
    const shots = new Map(s.own.shots.map((x) => [x.i, x.result]));
    const ships = new Set(s.own.ships.flatMap((sh) => sh.cells));
    const start = s.placement.start;
    const startVote = voteFor(s, 'start');
    const dirVote = voteFor(s, 'direction');
    const legal = new Set(startVote ? startVote.legal : []);
    let preview = new Set();
    if (dirVote && start !== null) {
      const dir = previewDir && dirVote.legal.includes(previewDir) ? previewDir : (typeof dirVote.myVote === 'string' ? dirVote.myVote : null);
      if (dir) preview = new Set(shipCells(start, dir, s.placement.ship.len));
    }
    for (let i = 0; i < ownCells.length; i++) {
      let state = 'water';
      if (islands.has(i)) state = 'island';
      else if (shots.has(i)) state = shots.get(i) === 'hit' ? 'hit-own' : 'miss';
      else if (ships.has(i)) state = 'ship';
      else if (i === start) state = 'pending';
      paintCell(ownCells[i], {
        state,
        legal: legal.has(i),
        mine: startVote ? startVote.myVote === i : false,
        preview: preview.has(i) && i !== start,
        tally: startVote ? startVote.tallies[i] || 0 : 0,
      });
    }

    // direction buttons
    $('dirs').hidden = !(s.phase === 'PLACEMENT' || (s.phase === 'PAUSED' && s.pausedFrom === 'PLACEMENT')) || s.placement.done;
    for (const b of dirButtons) {
      const d = b.dataset.dir;
      const isLegal = !!dirVote && dirVote.legal.includes(d);
      b.classList.toggle('legal', isLegal);
      b.classList.toggle('mine', !!dirVote && dirVote.myVote === d);
      b.disabled = !isLegal;
      b.querySelector('.tally').textContent = dirVote && dirVote.tallies[d] ? String(dirVote.tallies[d]) : '';
    }

    // placement status
    const st = $('placeStatus');
    st.textContent = '';
    const p = s.placement;
    if (s.phase === 'LOBBY') st.textContent = 'Waiting for the Game Master to start the game.';
    else if (s.phase === 'PAUSED') st.textContent = 'The game is paused by the Game Master.';
    else if (s.phase === 'PLACEMENT' && !p.done) {
      const strong = el('strong', null, `${p.ship.name} (${p.ship.len})`);
      st.append(`Ship ${p.placed + 1}/${p.total}: `, strong, ' — ');
      if (p.stage === 'start') st.append('vote for a starting square on your fleet grid. ');
      else st.append(`starting at ${coord(p.start)}. Vote for a direction. `);
      st.append(el('span', 'muted', votingLine(s.voting)));
    } else if (s.phase === 'PLACEMENT') st.textContent = 'Your fleet is in position. Waiting for the enemy to finish placing.';
    else {
      const afloat = s.own.ships.filter((x) => !x.sunk).length;
      st.textContent = `${afloat} of ${s.own.ships.length} ships afloat.`;
    }

    // fleet chips
    const fleet = $('ownFleet');
    renderList(fleet, s.fleet.map((spec, idx) => ({ spec, ship: s.own.ships[idx] })), (x) => `${x.spec.name}:${x.ship ? x.ship.hits.length + (x.ship.sunk ? 's' : '') : 'u'}`, ({ spec, ship }) => {
      const chip = el('span', `ship-chip${!ship ? ' unplaced' : ship.sunk ? ' sunk' : ''}`);
      chip.appendChild(el('span', null, spec.name));
      const pips = el('span', 'pips');
      for (let k = 0; k < spec.len; k++) {
        const hit = ship && ship.hits.includes(ship.cells[k]);
        pips.appendChild(el('span', `pip${hit ? ' hit' : ''}`));
      }
      chip.appendChild(pips);
      return chip;
    });
    $('ownCount').textContent = s.own.ships.length ? `${s.own.ships.filter((x) => !x.sunk).length} afloat` : '';
  }

  function renderEnemy(s, enemy) {
    const islands = new Set(s.enemy.islands);
    const shots = new Map(s.enemy.shots.map((x) => [x.i, x.result]));
    const sunkCells = new Set(s.enemy.sunkShips.flatMap((sh) => sh.cells));
    const v = voteFor(s, 'attack');
    const legal = new Set(v ? v.legal : []);
    for (let i = 0; i < enemyCells.length; i++) {
      let state = 'water';
      if (islands.has(i)) state = 'island';
      else if (sunkCells.has(i)) state = 'sunk';
      else if (shots.has(i)) state = shots.get(i) === 'hit' ? 'hit-enemy' : 'miss';
      paintCell(enemyCells[i], {
        state,
        legal: legal.has(i),
        mine: v ? v.myVote === i : false,
        tally: v ? v.tallies[i] || 0 : 0,
      });
    }

    const st = $('attackStatus');
    st.textContent = '';
    if (s.phase === 'BATTLE' && v) {
      st.append(el('strong', null, 'Your turn: '), 'vote for a target in enemy waters. ', el('span', 'muted', votingLine(v)));
    } else if (s.phase === 'BATTLE') {
      st.textContent = `${TEAM_LABEL[enemy]} team is choosing a target…`;
    } else if (s.phase === 'PAUSED') {
      st.textContent = 'Paused — votes are disabled until the Game Master resumes.';
    } else if (s.phase === 'FINISHED') {
      st.textContent = s.winner === s.me.team ? 'Victory! The enemy fleet is destroyed.' : 'Defeat. Your fleet has been destroyed.';
    } else {
      st.textContent = 'Attacks open once both fleets are placed. Blue attacks first.';
    }

    const sunkNames = new Set(s.enemy.sunkShips.map((x) => x.name));
    renderList($('enemyFleet'), s.fleet, (spec) => `${spec.name}:${sunkNames.has(spec.name)}`, (spec) => {
      const chip = el('span', `ship-chip enemy${sunkNames.has(spec.name) ? ' sunk' : ''}`);
      chip.appendChild(el('span', null, spec.name));
      const pips = el('span', 'pips');
      for (let k = 0; k < spec.len; k++) pips.appendChild(el('span', 'pip'));
      chip.appendChild(pips);
      return chip;
    });
    $('enemyCount').textContent = s.phase === 'BATTLE' || s.phase === 'FINISHED' || (s.phase === 'PAUSED' && s.pausedFrom === 'BATTLE')
      ? `${s.enemy.shipsRemaining} ships remaining` : '';
  }

  function renderSide(s, team, enemy) {
    // team status
    const ts = $('teamStatus');
    ts.textContent = '';
    ts.append(el('span', `pill ${team}`, `${TEAM_LABEL[team]} team`));
    ts.append(el('span', null, `vs ${TEAM_LABEL[enemy]} (${s.teamSizes[enemy]} players)`));
    if (s.phase === 'PLACEMENT') ts.append(el('span', 'muted', `Placed ${s.placement.placed}/${s.placement.total} · enemy ${s.enemy.shipsPlaced}/5`));
    if (s.phase === 'BATTLE' || s.phase === 'FINISHED' || s.phase === 'PAUSED') ts.append(el('span', 'muted', `Attacks: ${s.attackCount}`));

    // roster
    $('onlineCount').textContent = `Online: ${s.online} / ${s.roster.length}`;
    renderList($('roster'), s.roster, (m) => `${m.id}:${m.connected}`, (m) => {
      const b = el('span', `mate${m.you ? ' me' : ''}`);
      b.appendChild(el('span', `dot${m.connected ? ' on' : ''}`));
      b.appendChild(el('span', 'name', m.name + (m.you ? ' (you)' : '')));
      b.title = m.connected ? 'Online' : 'Offline';
      return b;
    });

    // intelligence (newest first)
    const intel = s.intel.slice().reverse();
    const intelRebuilt = renderList($('intel'), intel, (r) => r.id, (r) => {
      const li = el('li');
      li.appendChild(el('span', 'src', r.source));
      li.appendChild(el('span', 'ts', timeOf(r.ts)));
      li.appendChild(el('div', 'txt', `“${r.text}”`));
      return li;
    });
    if (intelRebuilt && intel.length === 0) $('intel').appendChild(el('li', 'muted', 'Reports arrive when the battle begins.'));

    // battle log (newest first)
    const log = s.log.slice().reverse();
    renderList($('log'), log, (e) => e.id, (e) => {
      const li = el('li', e.team ? 'private' : '');
      li.appendChild(document.createTextNode(e.text));
      li.appendChild(el('span', 'ts', timeOf(e.ts)));
      return li;
    });
  }

  function renderGameOver(s, team) {
    const box = $('gameOver');
    if (s.phase !== 'FINISHED' || dismissedWin === s.gameId) { box.hidden = true; return; }
    box.hidden = false;
    const title = $('winTitle');
    title.className = s.winner;
    title.textContent = `${TEAM_LABEL[s.winner].toUpperCase()} TEAM WINS!`;
    $('winLine').textContent = s.winner === team ? 'Your team destroyed the entire enemy fleet.' : 'Your fleet has been destroyed.';
    const sunkByYou = s.enemy.sunkShips.length;
    const lost = s.own.ships.filter((x) => x.sunk).length;
    $('winDetail').textContent = `Ships sunk by your team: ${sunkByYou}/5 · ships lost: ${lost}/5 · attacks: ${s.attackCount}`;
  }
})();

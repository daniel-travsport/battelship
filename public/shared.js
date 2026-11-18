'use strict';

// Helpers shared by the player and Game Master pages. Everything user-supplied is
// rendered with textContent, never innerHTML.

(function () {
  const SIZE = 12;
  const ROWS = 'ABCDEFGHIJKL';
  const DIRS = { UP: [-1, 0], DOWN: [1, 0], LEFT: [0, -1], RIGHT: [0, 1] };

  const coord = (i) => ROWS[Math.floor(i / SIZE)] + String((i % SIZE) + 1);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /** Builds a 12×12 grid with row/column labels; returns the 144 cell buttons. */
  function buildGrid(container, onClick) {
    container.textContent = '';
    container.classList.add('grid');
    container.appendChild(el('div', 'gh corner'));
    for (let c = 1; c <= SIZE; c++) container.appendChild(el('div', 'gh', String(c)));
    const cells = [];
    for (let r = 0; r < SIZE; r++) {
      container.appendChild(el('div', 'gh', ROWS[r]));
      for (let c = 0; c < SIZE; c++) {
        const i = r * SIZE + c;
        const b = el('button', 'cell s-water');
        b.type = 'button';
        b.dataset.i = String(i);
        b.appendChild(el('span', 'lbl', coord(i)));
        b.appendChild(el('span', 'tally'));
        if (onClick) b.addEventListener('click', () => { if (!b.disabled) onClick(i); });
        container.appendChild(b);
        cells.push(b);
      }
    }
    return cells;
  }

  const SYMBOL = { island: '▲', 'hit-own': '✕', 'hit-enemy': '✕', sunk: '✕', miss: '•' };
  const STATE_NAME = {
    water: 'water', ship: 'your ship', pending: 'starting square', island: 'island',
    'hit-own': 'hit on your ship', 'hit-enemy': 'hit', sunk: 'sunk ship', miss: 'miss',
  };

  /**
   * Exactly one background state class per cell (`s-…`), so no generic rule can
   * override a hit or miss colour. Outlines (legal / mine / preview) are separate classes.
   */
  function paintCell(b, { state = 'water', legal = false, mine = false, preview = false, tally = 0 }) {
    const i = Number(b.dataset.i);
    let cls = `cell s-${state}`;
    if (legal) cls += ' legal';
    if (mine) cls += ' mine';
    if (preview) cls += ' preview';
    if (tally) cls += ' has-tally';
    if (b.className !== cls) b.className = cls;
    const label = SYMBOL[state] || coord(i);
    if (b.firstChild.textContent !== label) b.firstChild.textContent = label;
    const t = tally ? String(tally) : '';
    if (b.lastChild.textContent !== t) b.lastChild.textContent = t;
    b.disabled = !legal;
    const aria = `${coord(i)}, ${STATE_NAME[state] || state}${tally ? `, ${tally} vote${tally > 1 ? 's' : ''}` : ''}${mine ? ', your vote' : ''}`;
    if (b.getAttribute('aria-label') !== aria) b.setAttribute('aria-label', aria);
  }

  function shipCells(start, dir, len) {
    const d = DIRS[dir];
    const r0 = Math.floor(start / SIZE);
    const c0 = start % SIZE;
    const out = [];
    for (let k = 0; k < len; k++) {
      const r = r0 + d[0] * k;
      const c = c0 + d[1] * k;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return [];
      out.push(r * SIZE + c);
    }
    return out;
  }

  function timeOf(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Replace a list's children only when the content key changed. */
  function renderList(container, items, key, build) {
    const k = items.map(key).join('|');
    if (container.dataset.key === k) return false;
    container.dataset.key = k;
    container.textContent = '';
    for (const item of items) container.appendChild(build(item));
    return true;
  }

  const TEAM_LABEL = { blue: 'Blue', red: 'Red' };
  const PHASE_LABEL = {
    LOBBY: 'Lobby', PLACEMENT: 'Ship placement', BATTLE: 'Battle', PAUSED: 'Paused', FINISHED: 'Game over',
  };

  window.BS = { SIZE, ROWS, DIRS, coord, el, buildGrid, paintCell, shipCells, timeOf, renderList, TEAM_LABEL, PHASE_LABEL };
})();

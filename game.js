/* The Mini — game logic */
(function () {
  'use strict';

  const SIZE = 5;
  const STORE_KEY = 'mini-clone-state-v1';
  const DIFF_KEY = 'mini-difficulty';
  const AUTOCHECK_KEY = 'mini-autocheck';
  const UNDO_LIMIT = 120;
  const DIFF_LABEL = { veryeasy: 'Very Easy', easy: 'Easy', medium: 'Medium', hard: 'Hard', extreme: 'Extreme', impossible: 'Impossible' };

  function currentDifficulty() {
    try {
      const saved = localStorage.getItem(DIFF_KEY);
      if (saved && DIFF_LABEL[saved]) return saved;
    } catch (e) {}
    return 'medium';
  }

  const el = {
    grid: document.getElementById('grid'),
    across: document.getElementById('acrossList'),
    down: document.getElementById('downList'),
    cbNum: document.getElementById('cbNum'),
    cbText: document.getElementById('cbText'),
    prevClue: document.getElementById('prevClue'),
    nextClue: document.getElementById('nextClue'),
    timerText: document.getElementById('timerText'),
    timerBtn: document.getElementById('timerBtn'),
    timerIcon: document.getElementById('timerIcon'),
    pauseCover: document.getElementById('pauseCover'),
    resumeBtn: document.getElementById('resumeBtn'),
    newBtn: document.getElementById('newBtn'),
    date: document.getElementById('puzzleDate'),
    keyboard: document.getElementById('keyboard'),
    modal: document.getElementById('modal'),
    modalTitle: document.getElementById('modalTitle'),
    modalBody: document.getElementById('modalBody'),
    modalMark: document.getElementById('modalMark'),
    modalNew: document.getElementById('modalNew'),
    modalClose: document.getElementById('modalClose'),

    versusBtn: document.getElementById('versusBtn'),
    versusModal: document.getElementById('versusModal'),
    versusTitle: document.getElementById('versusTitle'),
    versusSetup: document.getElementById('versusSetup'),
    versusLobby: document.getElementById('versusLobby'),
    vsName: document.getElementById('vsName'),
    vsDifficulty: document.getElementById('vsDifficulty'),
    vsCode: document.getElementById('vsCode'),
    vsCodeOut: document.getElementById('vsCodeOut'),
    vsCreate: document.getElementById('vsCreate'),
    vsJoin: document.getElementById('vsJoin'),
    vsStart: document.getElementById('vsStart'),
    vsCancel: document.getElementById('vsCancel'),
    vsWaitHint: document.getElementById('vsWaitHint'),
    vsShareHint: document.getElementById('vsShareHint'),
    vsRoster: document.getElementById('vsRoster'),
    vsError: document.getElementById('vsError'),
    raceStrip: document.getElementById('raceStrip'),
    raceCode: document.getElementById('raceCode'),
    raceStatus: document.getElementById('raceStatus'),
    racePlayers: document.getElementById('racePlayers'),
    raceLeave: document.getElementById('raceLeave'),
    countdown: document.getElementById('countdown'),
    countdownNum: document.getElementById('countdownNum')
  };

  let state = null;
  let cells = [];        // DOM nodes, cells[r][c]
  let clueNodes = {};    // entry id -> <li>
  let tick = null;

  /* ---------------- puzzle setup ---------------- */

  /* Seed for any given day. The archive replays past dailies by feeding this
     an older date — the generator is deterministic, so a date is all that is
     needed to reproduce a puzzle exactly (given the built-in bank; see
     makePuzzle's forceBuiltin). */
  function seedForDate(d) {
    const str = d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0);
  }

  function dailySeed() {
    return seedForDate(new Date());
  }

  /* 'YYYY-MM-DD' -> Date at UTC midnight, so a seed does not shift by timezone. */
  function dateFromISO(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function isoOf(d) {
    return d.toISOString().split('T')[0];
  }

  function todayISO() {
    return isoOf(new Date());
  }

  function blankState(puzzle, label, kind) {
    const entries = [];
    const marks = [];
    for (let r = 0; r < SIZE; r++) {
      entries[r] = [];
      marks[r] = [];
      for (let c = 0; c < SIZE; c++) {
        entries[r][c] = puzzle.black[r][c] ? null : '';
        marks[r][c] = { revealed: false, wrong: false, correct: false, pencil: false };
      }
    }
    return {
      puzzle: puzzle,
      label: label,
      kind: kind || 'daily',
      entries: entries,
      marks: marks,
      cursor: firstCell(puzzle),
      dir: 'across',
      seconds: 0,
      running: true,
      solved: false,
      usedHelp: false,
      pencilMode: false,
      autocheck: savedAutocheck(),
      challenge: null,      // { name, seconds } when playing a shared link
      archiveDate: null     // ISO date when playing from the archive
    };
  }

  function savedAutocheck() {
    try { return localStorage.getItem(AUTOCHECK_KEY) === '1'; } catch (e) { return false; }
  }

  function firstCell(puzzle) {
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (!puzzle.black[r][c]) return { r: r, c: c };
    return { r: 0, c: 0 };
  }

  function makePuzzle(seed, difficulty, forceBuiltin) {
    if (forceBuiltin && MiniGenerator.builtin) {
      MiniGenerator.useBank(MiniGenerator.builtin);
    }
    const puzzle = MiniGenerator.generate(seed, { difficulty: difficulty || currentDifficulty() });
    if (!puzzle) throw new Error('Could not generate a puzzle');
    return puzzle;
  }

  /* UTC, to match the daily seed, the history keys and the archive calendar —
     otherwise a player behind UTC sees the calendar mark one day as today
     while the header names the day before. */
  function todayLabel() {
    return new Date().toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
    });
  }

  /* ---------------- persistence ---------------- */

  function save() {
    if (!state || state.kind === 'versus') return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        puzzle: state.puzzle,
        label: state.label,
        kind: state.kind,
        entries: state.entries,
        marks: state.marks,
        seconds: state.seconds,
        solved: state.solved,
        usedHelp: state.usedHelp,
        pencilMode: state.pencilMode,
        autocheck: state.autocheck,
        challenge: state.challenge,
        archiveDate: state.archiveDate
      }));
    } catch (e) { /* storage unavailable — play on */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.puzzle) return null;
      // A daily puzzle expires when the date rolls over; a generated one is kept
      // until the player asks for another.
      const kind = data.kind || 'daily';
      if (kind === 'versus') return null;   // a race doesn't survive a reload
      if (kind === 'daily' && data.puzzle.seed !== dailySeed()) return null;
      const s = blankState(data.puzzle, data.label, kind);
      s.entries = data.entries;
      s.marks = data.marks;
      // Marks saved before pencil existed lack that flag.
      s.marks.forEach(function (row) {
        row.forEach(function (m) {
          if (m && m.pencil === undefined) m.pencil = false;
        });
      });
      s.seconds = data.seconds || 0;
      s.solved = !!data.solved;
      s.usedHelp = !!data.usedHelp;
      s.pencilMode = !!data.pencilMode;
      s.autocheck = data.autocheck === undefined ? savedAutocheck() : !!data.autocheck;
      s.challenge = data.challenge || null;
      s.archiveDate = data.archiveDate || null;
      s.running = !s.solved;
      return s;
    } catch (e) { return null; }
  }

  /* ---------------- entry lookup ---------------- */

  function entriesOf(dir) {
    return state.puzzle.entries.filter(function (e) { return e.dir === dir; });
  }

  function entryAt(r, c, dir) {
    return state.puzzle.entries.find(function (e) {
      return e.dir === dir && e.cells.some(function (cell) { return cell.r === r && cell.c === c; });
    });
  }

  function currentEntry() {
    return entryAt(state.cursor.r, state.cursor.c, state.dir);
  }

  function orderedEntries() {
    return entriesOf('across').concat(entriesOf('down'));
  }

  function isFilled(entry) {
    return entry.cells.every(function (cell) { return state.entries[cell.r][cell.c]; });
  }

  /* ---------------- rendering ---------------- */

  function buildGrid() {
    el.grid.innerHTML = '';
    el.grid.setAttribute('role', 'grid');
    el.grid.setAttribute('aria-label', 'Crossword grid, 5 by 5');
    cells = [];
    for (let r = 0; r < SIZE; r++) {
      cells[r] = [];
      for (let c = 0; c < SIZE; c++) {
        const div = document.createElement('div');
        div.className = 'cell' + (state.puzzle.black[r][c] ? ' black' : '');
        div.dataset.r = r;
        div.dataset.c = c;
        div.setAttribute('role', 'gridcell');
        if (state.puzzle.black[r][c]) {
          div.setAttribute('aria-label', 'Row ' + (r + 1) + ', column ' + (c + 1) + ', blocked');
          div.setAttribute('aria-disabled', 'true');
        }
        if (!state.puzzle.black[r][c]) {
          const num = state.puzzle.numbers[r][c];
          if (num) {
            const span = document.createElement('span');
            span.className = 'num';
            span.textContent = num;
            div.appendChild(span);
          }
          const letter = document.createElement('span');
          letter.className = 'letter';
          div.appendChild(letter);
        }
        el.grid.appendChild(div);
        cells[r][c] = div;
      }
    }
  }

  function buildClues() {
    el.across.innerHTML = '';
    el.down.innerHTML = '';
    clueNodes = {};
    state.puzzle.entries.forEach(function (entry) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="num"></span><span class="text"></span>';
      li.querySelector('.num').textContent = entry.num;
      li.querySelector('.text').textContent = entry.clue;
      li.addEventListener('click', function () { selectEntry(entry, true); });
      (entry.dir === 'across' ? el.across : el.down).appendChild(li);
      clueNodes[entry.id] = li;
    });
  }

  /* Screen readers get the active clue spoken when the cursor moves between
     entries. Re-announcing on every keystroke within one entry would be
     unbearable, so only a change of entry speaks. */
  let lastAnnounced = null;

  function announceClue(entry) {
    const live = document.getElementById('clueLive');
    if (!live) return;
    const key = entry.id + '|' + entry.clue;
    if (key === lastAnnounced) return;
    lastAnnounced = key;
    live.textContent = entry.num + ' ' + entry.dir + ', ' +
      entry.cells.length + ' letters: ' + entry.clue;
  }

  function render() {
    const entry = currentEntry();
    const highlighted = {};
    if (entry) entry.cells.forEach(function (cell) { highlighted[cell.r + ',' + cell.c] = true; });

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const node = cells[r][c];
        if (state.puzzle.black[r][c]) continue;
        const mark = state.marks[r][c];
        node.classList.toggle('highlight', !!highlighted[r + ',' + c]);
        node.classList.toggle('selected', r === state.cursor.r && c === state.cursor.c);
        node.classList.toggle('revealed', mark.revealed);
        node.classList.toggle('wrong', mark.wrong);
        node.classList.toggle('correct', !!mark.correct && !mark.revealed);
        node.classList.toggle('pencil', !!mark.pencil);
        const value = state.entries[r][c] || '';
        node.querySelector('.letter').textContent = value;

        const num = state.puzzle.numbers[r][c];
        node.setAttribute('aria-label',
          'Row ' + (r + 1) + ', column ' + (c + 1) +
          (num ? ', clue number ' + num : '') +
          ', ' + (value ? value + (mark.pencil ? ', pencilled' : '') : 'empty') +
          (mark.revealed ? ', revealed' : mark.wrong ? ', incorrect' : mark.correct ? ', correct' : ''));
        node.setAttribute('aria-selected', r === state.cursor.r && c === state.cursor.c ? 'true' : 'false');
      }
    }

    const crossEntry = entryAt(state.cursor.r, state.cursor.c, state.dir === 'across' ? 'down' : 'across');
    state.puzzle.entries.forEach(function (e) {
      const li = clueNodes[e.id];
      if (!li) return;
      li.classList.toggle('active', entry && e.id === entry.id);
      li.classList.toggle('cross', crossEntry && e.id === crossEntry.id);
      li.classList.toggle('done', isFilled(e));
    });

    if (entry) {
      el.cbNum.textContent = entry.num + (entry.dir === 'across' ? 'A' : 'D');
      el.cbText.textContent = entry.clue;
      announceClue(entry);
      const li = clueNodes[entry.id];
      if (li && li.parentElement) {
        const list = li.parentElement;
        if (li.offsetTop < list.scrollTop || li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = li.offsetTop - list.clientHeight / 2 + li.offsetHeight / 2;
        }
      }
    }
    save();
    reportProgress(false);
  }

  /* ---------------- cursor movement ---------------- */

  function moveTo(cell) {
    state.cursor = { r: cell.r, c: cell.c };
    render();
  }

  function selectEntry(entry, preferEmpty) {
    state.dir = entry.dir;
    let target = entry.cells[0];
    if (preferEmpty) {
      const empty = entry.cells.find(function (cell) { return !state.entries[cell.r][cell.c]; });
      if (empty) target = empty;
    }
    moveTo(target);
  }

  function step(dr, dc) {
    let r = state.cursor.r + dr;
    let c = state.cursor.c + dc;
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
      if (!state.puzzle.black[r][c]) { moveTo({ r: r, c: c }); return true; }
      r += dr; c += dc;
    }
    return false;
  }

  function toggleDir() {
    state.dir = state.dir === 'across' ? 'down' : 'across';
    render();
  }

  function jumpClue(delta) {
    const all = orderedEntries();
    const current = currentEntry();
    let i = all.findIndex(function (e) { return current && e.id === current.id; });
    if (i === -1) i = 0;
    const next = all[(i + delta + all.length) % all.length];
    selectEntry(next, true);
  }

  function nextUnfinished(from) {
    const all = orderedEntries();
    let i = all.findIndex(function (e) { return e.id === from.id; });
    for (let k = 1; k <= all.length; k++) {
      const candidate = all[(i + k) % all.length];
      if (!isFilled(candidate)) return candidate;
    }
    return null;
  }

  /* ---------------- input ---------------- */

  /* ---------------- undo / redo ----------------
     Snapshots of the answer grid rather than a command log: a 5x5 is small
     enough that copying it is free, and it keeps every mutation path (typing,
     reveal, clear, hints) undoable without each one describing its inverse. */

  const history = { undo: [], redo: [] };

  function snapshot() {
    return {
      entries: state.entries.map(function (row) { return row.slice(); }),
      marks: state.marks.map(function (row) {
        return row.map(function (m) { return Object.assign({}, m); });
      }),
      cursor: { r: state.cursor.r, c: state.cursor.c },
      dir: state.dir,
      usedHelp: state.usedHelp,
      seconds: state.seconds
    };
  }

  function pushHistory() {
    if (!state || state.solved) return;
    history.undo.push(snapshot());
    if (history.undo.length > UNDO_LIMIT) history.undo.shift();
    history.redo.length = 0;                 // a new move invalidates the redo branch
  }

  function resetHistory() {
    history.undo.length = 0;
    history.redo.length = 0;
  }

  function restore(snap) {
    state.entries = snap.entries;
    state.marks = snap.marks;
    state.cursor = snap.cursor;
    state.dir = snap.dir;
    state.usedHelp = snap.usedHelp;
    state.seconds = snap.seconds;
    paintTimer();
    render();
    updateToolStates();
  }

  function undo() {
    if (!state || state.solved || !history.undo.length) return;
    history.redo.push(snapshot());
    restore(history.undo.pop());
  }

  function redo() {
    if (!state || state.solved || !history.redo.length) return;
    history.undo.push(snapshot());
    restore(history.redo.pop());
  }

  /* ---------------- input ---------------- */

  function setLetter(r, c, ch, pencil) {
    state.entries[r][c] = ch;
    state.marks[r][c].wrong = false;
    state.marks[r][c].correct = false;
    state.marks[r][c].pencil = ch ? !!pencil : false;
    if (!ch) state.marks[r][c].revealed = false;
  }

  /* Autocheck marks a square the moment it is filled. It counts as help for
     the same reason the manual Check does — the puzzle stops being unaided. */
  function autoCheckCell(r, c) {
    if (!state.autocheck) return;
    const value = state.entries[r][c];
    const mark = state.marks[r][c];
    if (!value || mark.revealed) return;
    state.usedHelp = true;
    const right = value === state.puzzle.solution[r][c];
    mark.wrong = !right;
    mark.correct = right;
  }

  /* Revealed squares, and squares confirmed correct by Check, are locked. */
  function isLocked(r, c) {
    const mark = state.marks[r][c];
    return !!mark && (mark.revealed || mark.correct);
  }

  function typeLetter(ch) {
    if (!state || state.solved || !state.running) return;
    const entry = currentEntry();
    if (!entry) return;
    const { r, c } = state.cursor;
    if (isLocked(r, c)) { advance(entry); return; }

    pushHistory();
    setLetter(r, c, ch, state.pencilMode);
    autoCheckCell(r, c);

    if (checkSolved()) return;
    advance(entry);
  }

  function advance(entry) {
    const idx = entry.cells.findIndex(function (cell) {
      return cell.r === state.cursor.r && cell.c === state.cursor.c;
    });
    for (let i = idx + 1; i < entry.cells.length; i++) {
      if (!state.entries[entry.cells[i].r][entry.cells[i].c]) return moveTo(entry.cells[i]);
    }
    for (let i = 0; i < idx; i++) {
      if (!state.entries[entry.cells[i].r][entry.cells[i].c]) return moveTo(entry.cells[i]);
    }
    const next = nextUnfinished(entry);
    if (next) return selectEntry(next, true);
    if (idx + 1 < entry.cells.length) return moveTo(entry.cells[idx + 1]);
    render();
  }

  function backspace() {
    if (!state || state.solved || !state.running) return;
    const entry = currentEntry();
    if (!entry) return;
    const { r, c } = state.cursor;
    const idx = entry.cells.findIndex(function (cell) { return cell.r === r && cell.c === c; });

    if (isLocked(r, c)) {
      // Step past a locked square without disturbing it.
      if (idx > 0) return moveTo(entry.cells[idx - 1]);
      return render();
    }

    if (state.entries[r][c]) {
      pushHistory();
      setLetter(r, c, '');
      if (idx > 0) return moveTo(entry.cells[idx - 1]);
      return render();
    }

    if (idx > 0) {
      const prev = entry.cells[idx - 1];
      if (isLocked(prev.r, prev.c)) return moveTo(prev);
      pushHistory();
      setLetter(prev.r, prev.c, '');
      return moveTo(prev);
    }
    render();
  }

  document.addEventListener('keydown', function (e) {
    if (!state) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    if (el.modal.classList.contains('on')) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    // Undo/redo are the one place modifier chords are ours to claim.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const key = e.key;
    if (/^[a-zA-Z]$/.test(key)) { e.preventDefault(); typeLetter(key.toUpperCase()); return; }

    switch (key) {
      case 'Backspace':
      case 'Delete':
        e.preventDefault(); backspace(); break;
      case 'ArrowLeft':
        e.preventDefault();
        if (state.dir !== 'across') { state.dir = 'across'; render(); } else step(0, -1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (state.dir !== 'across') { state.dir = 'across'; render(); } else step(0, 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (state.dir !== 'down') { state.dir = 'down'; render(); } else step(-1, 0);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (state.dir !== 'down') { state.dir = 'down'; render(); } else step(1, 0);
        break;
      case ' ':
      case 'Enter':
        e.preventDefault(); toggleDir(); break;
      case 'Tab':
        e.preventDefault(); jumpClue(e.shiftKey ? -1 : 1); break;
      case '.':
        e.preventDefault(); togglePencil(); break;
    }
  });

  el.grid.addEventListener('click', function (e) {
    const node = e.target.closest('.cell');
    if (!node || node.classList.contains('black') || !state.running) return;
    const r = +node.dataset.r, c = +node.dataset.c;
    if (r === state.cursor.r && c === state.cursor.c) toggleDir();
    else moveTo({ r: r, c: c });
  });

  /* ---------------- on-screen keyboard ---------------- */

  function addKeyHandler(btn, handler) {
    btn.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      handler();
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
    });
  }

  function buildKeyboard() {
    const rows = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
    el.keyboard.innerHTML = '';
    rows.forEach(function (row, i) {
      const div = document.createElement('div');
      div.className = 'kb-row';
      if (i === 2) {
        const space = document.createElement('button');
        space.className = 'kb-key wide';
        space.textContent = 'space';
        addKeyHandler(space, toggleDir);
        div.appendChild(space);
      }
      row.split('').forEach(function (ch) {
        const b = document.createElement('button');
        b.className = 'kb-key';
        b.textContent = ch;
        addKeyHandler(b, function () { typeLetter(ch); });
        div.appendChild(b);
      });
      if (i === 2) {
        const del = document.createElement('button');
        del.className = 'kb-key wide';
        del.textContent = 'delete';
        addKeyHandler(del, backspace);
        div.appendChild(del);
      }
      el.keyboard.appendChild(div);
    });
  }

  /* ---------------- pencil / autocheck / tool state ---------------- */

  function togglePencil() {
    if (!state) return;
    state.pencilMode = !state.pencilMode;
    updateToolStates();
    showNotice(state.pencilMode ? 'Pencil mode on — letters go in light' : 'Pencil mode off');
    save();
  }

  function toggleAutocheck() {
    if (!state) return;
    state.autocheck = !state.autocheck;
    try { localStorage.setItem(AUTOCHECK_KEY, state.autocheck ? '1' : '0'); } catch (e) {}
    if (state.autocheck) {
      // Apply immediately to what is already filled, or the setting looks inert.
      pushHistory();
      for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++)
          if (!state.puzzle.black[r][c]) autoCheckCell(r, c);
    } else {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (state.puzzle.black[r][c]) continue;
          const mark = state.marks[r][c];
          if (!mark.revealed) { mark.wrong = false; mark.correct = false; }
        }
      }
    }
    updateToolStates();
    render();
    showNotice(state.autocheck ? 'Autocheck on' : 'Autocheck off');
  }

  /* Both toggles live in the Check menu and show the same ✓ the difficulty
     menu uses, so no new chrome is needed in the toolbar. */
  function updateToolStates() {
    const pencilBtn = document.getElementById('pencilBtn');
    if (pencilBtn) {
      pencilBtn.classList.toggle('checked', !!(state && state.pencilMode));
      pencilBtn.setAttribute('aria-pressed', state && state.pencilMode ? 'true' : 'false');
    }
    const autoBtn = document.getElementById('autocheckBtn');
    if (autoBtn) {
      autoBtn.classList.toggle('checked', !!(state && state.autocheck));
      autoBtn.setAttribute('aria-pressed', state && state.autocheck ? 'true' : 'false');
    }
  }

  /* ---------------- check / reveal / clear ---------------- */

  function targetCells(scope) {
    if (scope === 'square') return [{ r: state.cursor.r, c: state.cursor.c }];
    if (scope === 'word') { const e = currentEntry(); return e ? e.cells.slice() : []; }
    const all = [];
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (!state.puzzle.black[r][c]) all.push({ r: r, c: c });
    return all;
  }

  function check(scope) {
    pushHistory();
    state.usedHelp = true;
    targetCells(scope).forEach(function (cell) {
      const mark = state.marks[cell.r][cell.c];
      const value = state.entries[cell.r][cell.c];
      if (!value || mark.revealed) return;
      const right = value === state.puzzle.solution[cell.r][cell.c];
      mark.wrong = !right;
      mark.correct = right;
    });
    render();
  }

  function recordForfeit() {
    let p = loadProfile() || defaultProfile();
    const today = new Date().toISOString().split('T')[0];
    const diff = currentDifficulty();

    p.streak = 0;

    p.history = p.history || [];
    const existingIdx = p.history.findIndex(function (h) {
      return h.date === today && (h.difficulty || 'medium') === diff;
    });

    const forfeitEntry = {
      date: today,
      seconds: null,
      difficulty: diff,
      usedHelp: true,
      forfeited: true,
      label: state.label || 'The Mini'
    };

    if (existingIdx !== -1) {
      if (!p.history[existingIdx].seconds) p.history[existingIdx] = forfeitEntry;
    } else {
      p.history.unshift(forfeitEntry);
    }

    saveProfile(p);
  }

  function reveal(scope) {
    if (scope === 'puzzle') {
      if (!race.on) {
        state.solved = true;
        state.running = false;
        stopTimer();
        recordForfeit();
      }
      targetCells('puzzle').forEach(function (cell) {
        const answer = state.puzzle.solution[cell.r][cell.c];
        state.entries[cell.r][cell.c] = answer;
        state.marks[cell.r][cell.c].revealed = true;
        state.marks[cell.r][cell.c].wrong = false;
        state.marks[cell.r][cell.c].correct = false;
      });
      render();
      if (!race.on) {
        showNotice('Puzzle revealed. Daily streak reset to 0 (no time recorded).');
      }
      return;
    }

    pushHistory();
    state.usedHelp = true;
    const penalty = scope === 'word' ? 60 : 15;
    state.seconds += penalty;
    paintTimer();
    targetCells(scope).forEach(function (cell) {
      const answer = state.puzzle.solution[cell.r][cell.c];
      if (state.entries[cell.r][cell.c] !== answer) {
        state.entries[cell.r][cell.c] = answer;
        state.marks[cell.r][cell.c].revealed = true;
      }
      state.marks[cell.r][cell.c].wrong = false;
      state.marks[cell.r][cell.c].correct = false;
    });
    showNotice((scope === 'word' ? 'Word' : 'Square') + ' revealed (+' + (penalty === 60 ? '1m' : '15s') + ' penalty)');
    if (!checkSolved()) render();
  }

  function clear(scope) {
    pushHistory();
    targetCells(scope).forEach(function (cell) {
      state.entries[cell.r][cell.c] = '';
      state.marks[cell.r][cell.c] = { revealed: false, wrong: false, correct: false, pencil: false };
    });
    render();
  }

  /* ---------------- completion ---------------- */

  function checkSolved() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (state.puzzle.black[r][c]) continue;
        if (state.entries[r][c] !== state.puzzle.solution[r][c]) return false;
      }
    }
    state.solved = true;
    state.running = false;
    stopTimer();
    recordSolve();
    if (race.on) {
      clearTimeout(race.sendTimer);
      Versus.sendProgress(1, true, state.seconds);
    }
    render();
    el.grid.classList.remove('solved');
    void el.grid.offsetWidth;
    el.grid.classList.add('solved');
    setTimeout(showCongrats, 620);
    return true;
  }

  function showCongrats() {
    const rematchBtn = document.getElementById('modalRematch');
    if (rematchBtn) rematchBtn.style.display = race.on ? 'inline-block' : 'none';
    if (el.modalNew) el.modalNew.style.display = race.on ? 'none' : 'inline-block';
    const shareModalBtn = document.getElementById('modalShare');
    if (shareModalBtn) shareModalBtn.style.display = 'inline-block';

    if (race.on) {
      const me = Versus.me();
      let place = me ? me.place : null;
      if (!place && Versus.state.players) {
        const finishedList = Versus.state.players.filter(function (p) { return p.solved; });
        if (me && me.solved) {
          const myIdx = finishedList.findIndex(function (p) { return p.id === me.id; });
          place = myIdx !== -1 ? myIdx + 1 : finishedList.length;
        } else {
          place = finishedList.length + 1;
        }
      }
      place = place || 2;
      const won = place === 1;

      el.modalMark.textContent = won ? '🏆' : place === 2 ? '🥈' : place === 3 ? '🥉' : '🏁';
      el.modalMark.style.color = won ? '#f5c518' : place === 2 ? '#c0c0c0' : place === 3 ? '#cd7f32' : '#888';
      el.modalTitle.textContent = won ? 'You won! 🏆' : 'Finished ' + formatPlace(place);
      const winner = Versus.state.players.find(function (p) { return p.place === 1; });
      el.modalBody.textContent = won
        ? 'First to finish, in ' + formatTime(state.seconds) + '.'
        : 'You finished ' + formatPlace(place) + ' in ' + formatTime(state.seconds) +
          (winner ? '. ' + winner.name + ' won 1st place.' : '.');
      el.modal.classList.add('on');
      return;
    }
    if (state.challenge) {
      // Racing a link, or your own previous time on an archive day.
      const delta = state.challenge.seconds - state.seconds;
      const won = delta > 0;
      const self = !!state.challenge.self;
      el.modalMark.textContent = won ? '🏆' : '⏱';
      el.modalMark.style.color = won ? '#f5c518' : '#888';
      el.modalTitle.textContent = won
        ? (self ? 'New personal best!' : 'You beat ' + state.challenge.name + '!')
        : (self ? 'Your record stands' : 'So close');
      if (self) {
        el.modalBody.textContent = won
          ? formatTime(state.seconds) + ' — ' + formatTime(delta) + ' faster than your old ' +
            formatTime(state.challenge.seconds) + '.'
          : 'You took ' + formatTime(state.seconds) + '; your best on this day is still ' +
            formatTime(state.challenge.seconds) + '.';
      } else {
        el.modalBody.textContent = won
          ? 'You solved it in ' + formatTime(state.seconds) + ' — ' +
            formatTime(delta) + ' faster than ' + state.challenge.name + '.'
          : state.challenge.name + ' finished in ' + formatTime(state.challenge.seconds) +
            '; you took ' + formatTime(state.seconds) + '.';
      }
    } else if (state.usedHelp) {
      el.modalMark.textContent = '✓';
      el.modalMark.style.color = '#2ca02c';
      el.modalTitle.textContent = 'Puzzle complete';
      el.modalBody.textContent = 'You finished in ' + formatTime(state.seconds) + ', with a little help.';
    } else {
      el.modalMark.textContent = '★';
      el.modalMark.style.color = '#f5c518';
      el.modalTitle.textContent = 'Congratulations!';
      el.modalBody.textContent = 'You solved The Mini in ' + formatTime(state.seconds) + '.';
    }
    el.modal.classList.add('on');
  }

  function closeModal() { el.modal.classList.remove('on'); }

  function showNotice(msg, duration) {
    let notice = document.getElementById('toastNotice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'toastNotice';
      notice.className = 'toast-notice';
      document.body.appendChild(notice);
    }
    notice.textContent = msg;
    notice.classList.add('on');
    clearTimeout(notice._timer);
    const isHintMsg = msg.includes('Hint') || msg.includes('contains');
    const ms = duration || (isHintMsg ? 11000 : 3000);
    notice._timer = setTimeout(function () {
      notice.classList.remove('on');
    }, ms);
  }

  /* ---------------- timer ---------------- */

  function formatTime(total) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function paintTimer() {
    el.timerText.textContent = formatTime(state.seconds);
    // A finished time reads as a result, not a running clock.
    el.timerBtn.classList.toggle('done', !!state.solved);
    el.timerIcon.style.display = state.solved ? 'none' : '';
    el.timerIcon.innerHTML = state.running
      ? '<rect x="1" y="1" width="3.4" height="12" fill="currentColor"></rect><rect x="7.6" y="1" width="3.4" height="12" fill="currentColor"></rect>'
      : '<path d="M1 1 L11 7 L1 13 Z" fill="currentColor"></path>';
  }

  function updateVersusToolBadges() {
    const btnCheck = document.getElementById('checkMenuBtn');
    const btnHint = document.getElementById('hintMenuBtn');
    const btnReveal = document.getElementById('revealMenuBtn');
    const hintList = document.getElementById('hintMenuList');
    const revealList = document.getElementById('revealMenuList');
    if (race.on) {
      if (btnCheck) btnCheck.innerHTML = 'Check (' + (race.checks || 0) + ')<span class="caret"></span>';
      if (btnHint) btnHint.innerHTML = 'Hint (' + (race.hints || 0) + ')<span class="caret"></span>';
      if (btnReveal) btnReveal.innerHTML = 'Reveal (' + (race.reveals || 0) + ')<span class="caret"></span>';
      if (hintList) {
        hintList.innerHTML =
          '<button data-action="hint-clue">Different clue (+5s)</button>' +
          '<button data-action="hint-pattern">Vowel pattern (+10s)</button>' +
          '<button data-action="hint-letter">Next letter (+15s)</button>';
      }
      if (revealList) {
        revealList.innerHTML =
          '<button data-action="reveal-square">Square (+15s, 1★)</button>' +
          '<button data-action="reveal-word">Word (+1m, 2★)</button>';
      }
    } else {
      if (btnCheck) btnCheck.innerHTML = 'Check<span class="caret"></span>';
      if (btnHint) btnHint.innerHTML = 'Hint<span class="caret"></span>';
      if (btnReveal) btnReveal.innerHTML = 'Reveal<span class="caret"></span>';
      if (hintList) {
        hintList.innerHTML =
          '<button data-action="hint-clue">Different clue (+5s)</button>' +
          '<button data-action="hint-pattern">Vowel pattern (+10s)</button>' +
          '<button data-action="hint-letter">Next letter (+15s)</button>';
      }
      if (revealList) {
        revealList.innerHTML =
          '<button data-action="reveal-square">Square (+15s)</button>' +
          '<button data-action="reveal-word">Word (+1m)</button>' +
          '<button data-action="reveal-puzzle">Puzzle (Reset Streak)</button>';
      }
    }
  }

  function startTimer() {
    stopTimer();
    if (state.solved) return;
    state.running = true;
    el.pauseCover.classList.remove('on');
    tick = setInterval(function () {
      state.seconds++;
      paintTimer();
      if (race.on) {
        const earnedChecks = Math.floor(state.seconds / 15);
        if (earnedChecks > race.lastCheckSec) {
          const diff = earnedChecks - race.lastCheckSec;
          race.checks = (race.checks || 0) + diff;
          race.lastCheckSec = earnedChecks;
          if (!race.notifiedCheck) {
            showNotice('+1 Check Credit earned! (' + race.checks + ' available)');
            race.notifiedCheck = true;
          }
          updateVersusToolBadges();
        }
        const earnedHints = Math.floor(state.seconds / 10);
        if (earnedHints > race.lastHintSec) {
          const diff = earnedHints - race.lastHintSec;
          race.hints = (race.hints || 0) + diff;
          race.lastHintSec = earnedHints;
          if (!race.notifiedHint) {
            showNotice('+1 Hint Credit earned! (' + race.hints + ' available)');
            race.notifiedHint = true;
          }
          updateVersusToolBadges();
        }
        const earnedReveals = Math.floor(state.seconds / 60);
        if (earnedReveals > race.lastRevealSec) {
          const diff = earnedReveals - race.lastRevealSec;
          race.reveals = (race.reveals || 0) + diff;
          race.lastRevealSec = earnedReveals;
          if (!race.notifiedReveal) {
            showNotice('+1 Reveal Credit earned! (' + race.reveals + ' available)');
            race.notifiedReveal = true;
          }
          updateVersusToolBadges();
        }
      }
      if (state.seconds % 5 === 0) save();
    }, 1000);
    paintTimer();
  }

  function stopTimer() {
    if (tick) clearInterval(tick);
    tick = null;
    paintTimer();
  }

  function pause() {
    if (state.solved) return;
    state.running = false;
    stopTimer();
    el.pauseCover.classList.add('on');
    save();
  }

  el.timerBtn.addEventListener('click', function () {
    if (state.solved) return;
    if (state.running) pause(); else startTimer();
  });
  el.resumeBtn.addEventListener('click', startTimer);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state && state.running) pause();
  });

  // Entry ids with a "Different clue" network lookup in flight, so a double
  // click can't fire two fetches (and two charges) for the same clue.
  const hintFlight = new Set();

  function giveHint(scope) {
    const entry = currentEntry();
    if (!entry) {
      showNotice('Select a clue on the board first!');
      return;
    }
    const answer = entry.answer;
    const num = entry.num + (entry.dir === 'across' ? 'A' : 'D');

    /* Each hint says something you cannot read off the board, priced by how
       much ground it gives away, and none is charged unless it fires. */
    function charge(seconds) {
      pushHistory();
      state.usedHelp = true;
      state.seconds += seconds;
      paintTimer();
    }

    // The alternate clue is shown only in the toast — the clue box and clue
    // list keep showing the original. Mutating entry.clue here used to also
    // rebuild and re-render the clue list, which raced against whatever the
    // player was doing next (typing, tabbing to another clue, a fetch from a
    // second hint click) and produced exactly the "sometimes old, sometimes
    // new, sometimes neither" inconsistency this was rewritten to fix. This
    // also makes "Different clue" behave the same as "Vowel pattern": an
    // informational toast, not a lasting change to the puzzle.
    function applyAltClue(alt) {
      charge(5);
      showNotice(num + ': ' + alt + ' [+5s]', 11000);
    }

    function bookendFallback() {
      // Genuinely nothing else on file anywhere (curated, bank, or Datamuse) —
      // this is the one case where the hint can't be a different clue, so say
      // so plainly rather than pretend the shape hint is a clue.
      charge(5);
      showNotice(num + ' has no other clue on record — starts with "' + answer.charAt(0) +
        '", ends with "' + answer.charAt(answer.length - 1) + '" [+5s]', 11000);
    }

    // "A safe place" vs "Safe place" is not a different clue — just the same
    // dictionary sense with an article Datamuse happened to include. Compare
    // with articles stripped so a near-duplicate doesn't count as an alternate.
    function normalizeClue(c) {
      return String(c || '').toLowerCase().replace(/^(a|an|the)\s+/, '').trim();
    }

    if (scope === 'clue') {
      // Guards the instant path too, not just the network one below — a
      // rapid double click (or a double-tap on mobile) used to charge twice
      // for one hint whenever a local alternate was found, since nothing
      // stopped a second synchronous click from running before the first
      // had returned.
      if (hintFlight.has(entry.id)) return;
      hintFlight.add(entry.id);
      const priorClue = normalizeClue(entry.clue);

      // Curated overrides and the word bank's own multi-definition entries
      // resolve instantly — most 3-letter crosswordese has these.
      const localAlts = (MiniGenerator.cluesFor(answer) || []).filter(function (c) {
        return c && normalizeClue(c) !== priorClue;
      });
      if (localAlts.length) {
        applyAltClue(localAlts[Math.floor(Math.random() * localAlts.length)]);
        hintFlight.delete(entry.id);
        return;
      }

      // No second sense on hand — most answers are in this boat (clues.js
      // only hand-curates a few hundred words). Ask Datamuse for the word's
      // other dictionary senses live, same as the boot-time harvest does in
      // bulk, filtered through the same cleanDefinition rules.
      const puzzleAtRequest = state.puzzle;
      showNotice(num + ': checking for another clue…', 4000);
      WordSource.fetchAltClues(answer).then(function (defs) {
        hintFlight.delete(entry.id);
        // The puzzle changed while we were waiting (New Puzzle, a challenge
        // link, a race rematch) — applying this now would charge and edit a
        // clue list nobody is looking at.
        if (!state || state.puzzle !== puzzleAtRequest) return;

        const fresh = defs.filter(function (d) { return normalizeClue(d) !== priorClue; });
        if (fresh.length) applyAltClue(fresh[Math.floor(Math.random() * fresh.length)]);
        else bookendFallback();
      });
      return;
    }

    if (scope === 'pattern') {
      charge(10);
      const pattern = answer.split('').map(function (ch) {
        return 'AEIOU'.indexOf(ch) === -1 ? 'C' : 'V';
      }).join(' ');
      showNotice(num + ' pattern: ' + pattern + '   (V = vowel, C = consonant) [+10s]', 11000);
      return;
    }

    if (scope === 'letter') {
      const target = entry.cells.find(function (cell) {
        return !state.entries[cell.r][cell.c];
      });
      if (!target) { showNotice(num + ' is already filled — check it instead.'); return; }
      charge(15);
      const position = entry.cells.indexOf(target) + 1;
      setLetter(target.r, target.c, state.puzzle.solution[target.r][target.c]);
      state.marks[target.r][target.c].revealed = true;
      showNotice(num + ': letter ' + position + ' filled in [+15s]');
      if (!checkSolved()) { moveTo(target); }
    }
  }

  /* ---------------- menus & buttons ---------------- */

  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-menu-btn]');
    document.querySelectorAll('.menu').forEach(function (m) {
      if (!btn || m !== btn.parentElement) m.classList.remove('open');
    });
    if (btn) btn.parentElement.classList.toggle('open');

    const action = e.target.closest('[data-action]');
    if (!action) return;
    const [verb, scope] = action.dataset.action.split('-');

    if (verb === 'share') {
      shareResult();
      document.querySelectorAll('.menu').forEach(function (m) { m.classList.remove('open'); });
      return;
    }

    // Solving-mode toggles; available in a race too.
    if (verb === 'pencil' || verb === 'autocheck') {
      if (verb === 'pencil') togglePencil(); else toggleAutocheck();
      document.querySelectorAll('.menu').forEach(function (m) { m.classList.remove('open'); });
      return;
    }

    if (race.on) {
      if (verb === 'check') {
        if ((race.checks || 0) <= 0) {
          showNotice('No Check credits available yet! (+1 earned every 15s)');
          document.querySelectorAll('.menu').forEach(function (m) { m.classList.remove('open'); });
          return;
        }
        race.checks--;
        updateVersusToolBadges();
        check(scope);
        reportProgress(true);
      } else if (verb === 'reveal') {
        if (scope === 'puzzle') {
          showNotice('Reveal Puzzle is only available after the race ends!');
          document.querySelectorAll('.menu').forEach(function (m) { m.classList.remove('open'); });
          return;
        }
        const cost = scope === 'word' ? 2 : 1;
        if ((race.reveals || 0) < cost) {
          showNotice('Reveal ' + scope + ' requires ' + cost + ' Reveal credit' + (cost > 1 ? 's' : '') + '! (+1 earned every 60s)');
          document.querySelectorAll('.menu').forEach(function (m) { m.classList.remove('open'); });
          return;
        }
        race.reveals -= cost;
        updateVersusToolBadges();
        reveal(scope);
        reportProgress(true);
      } else if (verb === 'hint') {
        if ((race.hints || 0) <= 0) {
          showNotice('No Hint credits available yet! (+1 earned every 10s)');
          document.querySelectorAll('.menu').forEach(function (m) { m.classList.remove('open'); });
          return;
        }
        race.hints--;
        updateVersusToolBadges();
        giveHint(scope);
      } else if (verb === 'clear') {
        clear(scope);
      }
      document.querySelectorAll('.menu').forEach(function (m) { m.classList.remove('open'); });
      return;
    }
    if (verb === 'check') check(scope);
    if (verb === 'reveal') reveal(scope);
    if (verb === 'hint') giveHint(scope);
    if (verb === 'clear') clear(scope);
    document.querySelectorAll('.menu').forEach(function (m) { m.classList.remove('open'); });
  });

  el.prevClue.addEventListener('click', function () { jumpClue(-1); });
  el.nextClue.addEventListener('click', function () { jumpClue(1); });

  /* ---------------- archive & share wiring ---------------- */

  // The date line doubles as the archive entry point (no extra toolbar button).
  if (el.date) el.date.addEventListener('click', openArchive);

  const calGrid = document.getElementById('calGrid');
  if (calGrid) {
    calGrid.addEventListener('click', function (e) {
      const day = e.target.closest('.cal-day[data-date]');
      if (!day || day.disabled) return;
      playArchive(day.dataset.date);
    });
  }
  const calPrev = document.getElementById('calPrev');
  if (calPrev) calPrev.addEventListener('click', function () { pageCalendar(-1); });
  const calNext = document.getElementById('calNext');
  if (calNext) calNext.addEventListener('click', function () { pageCalendar(1); });

  const archiveToday = document.getElementById('archiveToday');
  if (archiveToday) {
    archiveToday.addEventListener('click', function () { playArchive(todayISO()); });
  }
  const archiveRandom = document.getElementById('archiveRandom');
  if (archiveRandom) {
    archiveRandom.addEventListener('click', function () {
      const start = dateFromISO(ARCHIVE_START).getTime();
      const end = Date.now();
      playArchive(isoOf(new Date(start + Math.random() * (end - start))));
    });
  }
  const archiveClose = document.getElementById('archiveClose');
  if (archiveClose) archiveClose.addEventListener('click', closeArchive);

  const modalShareBtn = document.getElementById('modalShare');
  if (modalShareBtn) modalShareBtn.addEventListener('click', shareResult);

  const shareCopyBtn = document.getElementById('shareCopy');
  if (shareCopyBtn) shareCopyBtn.addEventListener('click', copyShareLink);

  const shareNativeBtn = document.getElementById('shareNative');
  if (shareNativeBtn) {
    shareNativeBtn.addEventListener('click', function () {
      const field = document.getElementById('shareText');
      if (!field || !navigator.share) return;
      navigator.share({ title: 'The Mini', url: field.value }).catch(function () {});
    });
  }

  const shareCloseBtn = document.getElementById('shareClose');
  if (shareCloseBtn) {
    shareCloseBtn.addEventListener('click', function () {
      const box = document.getElementById('shareModal');
      if (box) box.classList.remove('on');
    });
  }
  el.newBtn.addEventListener('click', function () { newPuzzle(); });
  el.modalNew.addEventListener('click', function () { closeModal(); newPuzzle(); });
  el.modalClose.addEventListener('click', closeModal);

  const modalRematchBtn = document.getElementById('modalRematch');
  if (modalRematchBtn) {
    modalRematchBtn.addEventListener('click', function () {
      closeModal();
      const diff = currentDifficulty();
      let nextPuzzle;
      try { nextPuzzle = makePuzzle(null, diff); } catch (e) { nextPuzzle = makePuzzle(null, 'medium'); }
      Versus.rematch(nextPuzzle, diff).then(function () {
        startRacePuzzle(nextPuzzle, diff);
        showVersusModal();
      }).catch(function (err) { showNotice(err.message || 'Rematch failed'); });
    });
  }

  /* ---------------- difficulty ---------------- */

  function markDifficultyMenu() {
    const active = currentDifficulty();
    document.querySelectorAll('#difficultyMenu [data-difficulty]').forEach(function (btn) {
      btn.classList.toggle('checked', btn.dataset.difficulty === active);
    });
  }

  function setDifficulty(value) {
    if (!DIFF_LABEL[value]) return;
    try { localStorage.setItem(DIFF_KEY, value); } catch (e) {}
    markDifficultyMenu();
    newPuzzle();
  }

  /* ---------------- versus ---------------- */

  const race = { on: false, sendTimer: null, lastSent: -1, checks: 0, hints: 0, reveals: 0, lastCheckSec: 0, lastHintSec: 0, lastRevealSec: 0, notifiedCheck: false, notifiedHint: false, notifiedReveal: false };

  function whiteCellCount() {
    let n = 0;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (!state.puzzle.black[r][c]) n++;
    return n;
  }

  function correctCount() {
    let n = 0;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (!state.puzzle.black[r][c] && state.entries[r][c] === state.puzzle.solution[r][c]) n++;
    return n;
  }

  function reportProgress(force) {
    if (!race.on || !state) return;
    const value = correctCount() / whiteCellCount();
    if (!force && Math.abs(value - race.lastSent) < 0.001) return;
    race.lastSent = value;
    clearTimeout(race.sendTimer);
    race.sendTimer = setTimeout(function () {
      Versus.sendProgress(value, false, state.seconds);
    }, force ? 0 : 350);
  }

  function raceLocked() {
    return race.on && !Versus.state.started;
  }

  function startRacePuzzle(puzzle, difficulty) {
    race.on = true;
    race.lastSent = -1;
    race.checks = 1;
    race.hints = 1;
    race.reveals = 0;
    race.lastCheckSec = 0;
    race.lastHintSec = 0;
    race.lastRevealSec = 0;
    race.notifiedCheck = false;
    race.notifiedHint = false;
    race.notifiedReveal = false;
    updateVersusToolBadges();
    document.body.classList.add('racing');
    const label = 'Versus · ' + (DIFF_LABEL[difficulty] || 'Medium');
    const next = blankState(puzzle, label, 'versus');
    mount(next, label);
    state.running = false;
    stopTimer();
    el.pauseCover.classList.add('on');
    el.pauseCover.querySelector('p').textContent = 'Get ready…';
    renderRaceStrip();
  }

  function beginRace() {
    if (!race.on || !state) return;
    el.pauseCover.classList.remove('on');
    el.pauseCover.querySelector('p').textContent = 'Your puzzle is paused';
    startTimer();
    reportProgress(true);
  }

  function endRace() {
    race.on = false;
    race.checks = 0;
    race.hints = 0;
    race.reveals = 0;
    updateVersusToolBadges();
    clearTimeout(race.sendTimer);
    document.body.classList.remove('racing');
    el.raceStrip.classList.remove('on');
    el.pauseCover.querySelector('p').textContent = 'Your puzzle is paused';
  }

  function formatPlace(place) {
    return place === 1 ? '1st' : place === 2 ? '2nd' : place === 3 ? '3rd' : place + 'th';
  }

  function renderRaceStrip() {
    const vs = Versus.state;
    if (!vs.active) { el.raceStrip.classList.remove('on'); return; }
    el.raceStrip.classList.add('on');
    el.raceCode.textContent = vs.code;

    const ms = Versus.countdownMs();
    if (!vs.startAt) el.raceStatus.textContent = 'Waiting for the host to start';
    else if (ms > 0) el.raceStatus.textContent = 'Starting…';
    else if (vs.finished) {
      const winner = vs.players.find(function (p) { return p.place === 1; });
      el.raceStatus.textContent = winner
        ? (winner.id === vs.playerId ? 'You won!' : winner.name + ' won')
        : 'Race over';
    } else el.raceStatus.textContent = 'Race in progress';

    el.raceRematch = document.getElementById('raceRematch');
    if (el.raceRematch) {
      const isRaceEnded = vs.finished || (state && state.solved) || vs.players.some(function (p) { return p.solved; });
      el.raceRematch.style.display = isRaceEnded ? 'inline-block' : 'none';
    }

    el.racePlayers.innerHTML = '';
    vs.players.forEach(function (p) {
      const li = document.createElement('li');
      li.className = 'race-player' + (p.id === vs.playerId ? ' me' : '') + (p.solved ? ' done' : '');
      const pct = Math.round(p.progress * 100);
      li.innerHTML =
        '<span class="rp-name"></span>' +
        '<span class="rp-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="rp-meta"></span>';
      li.querySelector('.rp-name').textContent = p.name + (p.id === vs.hostId ? ' ★' : '');
      li.querySelector('.rp-meta').textContent = p.solved
        ? formatPlace(p.place) + ' · ' + formatTime(p.finishSeconds || 0)
        : pct + '%';
      el.racePlayers.appendChild(li);
    });
  }

  function renderCountdown() {
    const ms = Versus.countdownMs();
    if (!race.on || ms === null || ms <= 0) { el.countdown.classList.remove('on'); return; }
    el.countdown.classList.add('on');
    el.countdownNum.textContent = String(Math.max(1, Math.ceil(ms / 1000)));
  }

  /* ---------------- cookie & profile management ---------------- */

  const PROFILE_KEY = 'mini-player-profile';

  function setCookie(name, value, days) {
    try {
      const date = new Date();
      date.setTime(date.getTime() + ((days || 365) * 24 * 60 * 60 * 1000));
      document.cookie = name + "=" + encodeURIComponent(JSON.stringify(value)) + "; expires=" + date.toUTCString() + "; path=/; SameSite=Lax";
    } catch (e) {}
  }

  function getCookie(name) {
    try {
      const matches = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + "=([^;]*)"));
      return matches ? JSON.parse(decodeURIComponent(matches[1])) : null;
    } catch (e) { return null; }
  }

  function defaultProfile() {
    return {
      name: '',
      streak: 0,
      bestStreak: 0,
      played: 0,
      solved: 0,
      history: [],
      lastSolvedDate: null
    };
  }

  function loadProfile() {
    let p = null;
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) p = JSON.parse(raw);
    } catch (e) {}
    if (!p) p = getCookie(PROFILE_KEY);
    p = Object.assign(defaultProfile(), p || {});
    if (!p.name) {
      const vName = Versus.savedName();
      if (vName) p.name = vName;
    }
    return p;
  }

  function saveProfile(p) {
    if (!p) return;
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
    setCookie(PROFILE_KEY, p, 365);
    updateHeaderStreak(p);
  }

  function updateHeaderStreak(p) {
    const elStreak = document.getElementById('streakHeaderCount');
    if (elStreak) elStreak.textContent = String(p && p.streak || 0);
  }

  /* A solve is filed against the day it belongs to, not the day it happened.
     Replaying 14 March from the archive must not count as today's daily, or
     the streak could be farmed from easy old puzzles — and the calendar needs
     each day's own best time to offer "beat it". */
  function recordSolve() {
    let p = loadProfile() || defaultProfile();
    const today = new Date().toISOString().split('T')[0];
    const dYesterday = new Date();
    dYesterday.setDate(dYesterday.getDate() - 1);
    const yesterday = dYesterday.toISOString().split('T')[0];
    const diff = currentDifficulty();

    const kind = state.kind;
    const puzzleDate = state.archiveDate || today;
    // Only the real daily moves the streak and the global board. Archive
    // replays, shared challenges and practice puzzles are personal records.
    const countsAsDaily = kind === 'daily';
    const recordable = kind === 'daily' || kind === 'archive';

    p.played = (p.played || 0) + 1;
    p.solved = (p.solved || 0) + 1;

    // Daily streak logic (increments once per day)
    if (countsAsDaily && p.lastSolvedDate !== today) {
      if (p.lastSolvedDate === yesterday) {
        p.streak = (p.streak || 0) + 1;
      } else {
        p.streak = 1;
      }
      if (p.streak > (p.bestStreak || 0)) {
        p.bestStreak = p.streak;
      }
      p.lastSolvedDate = today;
    }

    // Per-date, per-difficulty personal record — this is what the calendar reads.
    if (recordable) {
      p.history = p.history || [];
      const existingIdx = p.history.findIndex(function (h) {
        return h.date === puzzleDate && (h.difficulty || 'medium') === diff;
      });

      const newEntry = {
        date: puzzleDate,
        seconds: state.seconds,
        difficulty: diff,
        usedHelp: !!state.usedHelp,
        label: state.label || 'The Mini',
        archive: kind === 'archive'
      };

      if (existingIdx !== -1) {
        const prev = p.history[existingIdx];
        // Keep the best time for that day, but never let a forfeit stand in
        // for a real solve.
        if (prev.forfeited || !prev.seconds || state.seconds < prev.seconds) {
          p.history[existingIdx] = newEntry;
        }
      } else {
        p.history.unshift(newEntry);
      }

      // Roomy enough to hold a long archive run; still trivial in localStorage.
      if (p.history.length > 400) p.history.pop();
    }
    saveProfile(p);

    if (!countsAsDaily) return;

    // Sync score to global cross-device server
    try {
      fetch('/api/submit-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: p.name || 'Player',
          streak: p.streak || 0,
          bestStreak: p.bestStreak || 0,
          seconds: state.seconds,
          difficulty: diff,
          date: today,
          token: scoreToken
        })
      }).catch(function () {});
    } catch (e) {}
  }

  function renderStatsModal() {
    const p = loadProfile() || defaultProfile();
    document.getElementById('statStreak').textContent = p.streak || 0;
    document.getElementById('statBestStreak').textContent = p.bestStreak || 0;
    document.getElementById('statPlayed').textContent = p.solved || 0;
    document.getElementById('profileNameInput').value = p.name || '';

    const list = document.getElementById('historyList');
    list.innerHTML = '';

    if (!p.history || p.history.length === 0) {
      list.innerHTML = '<p class="empty-history">No solved puzzles yet. Complete your first mini!</p>';
      return;
    }

    p.history.forEach(function (h) {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML =
        '<span class="history-date' + (h.archive ? ' archive' : '') + '"' +
          (h.archive ? ' title="Played from the archive, not the day\'s live daily"' : '') +
          '>' + h.date + '</span>' +
        '<div class="history-meta">' +
          '<span class="history-badge">' + (h.difficulty || 'medium') + (h.usedHelp ? ' *' : '') + '</span>' +
          '<span class="history-time">' + formatTime(h.seconds || 0) + '</span>' +
        '</div>';
      list.appendChild(div);
    });
  }

  let activeLbPeriod = 'daily';
  let activeLbDiff = 'medium';

  function renderLeaderboardData(serverEntries) {
    const p = loadProfile() || defaultProfile();
    const myName = p.name || 'You';
    const list = document.getElementById('lbList');
    if (!list) return;
    list.innerHTML = '';

    const isDaily = activeLbPeriod === 'daily';
    const entries = [];
    const seenNames = new Set();

    if (Array.isArray(serverEntries)) {
      serverEntries.forEach(function (item) {
        seenNames.add(item.name);
        const streakVal = isDaily ? (item.streak || 0) : (item.bestStreak || 0);
        entries.push({
          name: item.name,
          streak: streakVal,
          bestTime: item.seconds ? formatTime(item.seconds) : '--:--',
          seconds: item.seconds || 9999,
          isMe: item.name === myName
        });
      });
    }

    // Always include current local player if not in server list yet
    if (!seenNames.has(myName)) {
      const today = new Date().toISOString().split('T')[0];
      const matching = (p.history || []).filter(function (h) {
        const matchDiff = !h.difficulty || h.difficulty === activeLbDiff;
        if (!matchDiff) return false;
        if (isDaily) return h.date === today;
        return true;
      });
      let bestSec = null;
      if (matching.length > 0) {
        bestSec = matching.reduce(function (min, h) {
          return (min === null || (h.seconds && h.seconds < min)) ? h.seconds : min;
        }, null);
      }
      const myStreakVal = isDaily ? (p.streak || 0) : (p.bestStreak || 0);
      entries.push({
        name: myName,
        streak: myStreakVal,
        bestTime: bestSec ? formatTime(bestSec) : '--:--',
        seconds: bestSec || 9999,
        isMe: true
      });
    }

    entries.sort(function (a, b) {
      const scoreA = (a.seconds < 9999 ? (10000 - a.seconds) : 0) + (a.streak * 250);
      const scoreB = (b.seconds < 9999 ? (10000 - b.seconds) : 0) + (b.streak * 250);
      if (scoreA !== scoreB) return scoreB - scoreA;
      if (a.seconds !== b.seconds) return a.seconds - b.seconds;
      return b.streak - a.streak;
    });

    if (entries.length === 0) {
      list.innerHTML = '<p class="empty-history">No records yet for this category.</p>';
      return;
    }

    entries.forEach(function (item, idx) {
      const div = document.createElement('div');
      div.className = 'lb-item' + (item.isMe ? ' me' : '');
      const rankBadge = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : String(idx + 1);
      div.innerHTML =
        '<span class="lb-rank">' + rankBadge + '</span>' +
        '<span class="lb-name">' + item.name + (item.isMe ? ' (You)' : '') + '</span>' +
        '<span class="lb-streak">🔥 ' + item.streak + '</span>' +
        '<span class="lb-time">' + item.bestTime + '</span>';
      list.appendChild(div);
    });
  }

  function renderLeaderboard(period, diff) {
    if (period) activeLbPeriod = period;
    if (diff) activeLbDiff = diff;

    document.querySelectorAll('.lb-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.lbperiod === activeLbPeriod);
    });
    document.querySelectorAll('.lb-diff-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.lbdiff === activeLbDiff);
    });

    // Fetch live cross-device synced leaderboard from server
    fetch('/api/leaderboard?period=' + activeLbPeriod + '&difficulty=' + activeLbDiff)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && Array.isArray(data.leaderboard)) {
          renderLeaderboardData(data.leaderboard);
        } else {
          renderLeaderboardData([]);
        }
      })
      .catch(function () {
        renderLeaderboardData([]);
      });
  }

  function initProfileUI() {
    let p = loadProfile();
    const welcomeInput = document.getElementById('welcomeNameInput');
    if (welcomeInput) welcomeInput.value = p.name || Versus.savedName() || '';

    if (!p || !p.name) {
      document.getElementById('welcomeModal').classList.add('on');
    } else {
      updateHeaderStreak(p);
      if (p.name) Versus.rememberName(p.name);
    }

    const saveWelcomeName = function (e) {
      if (e) e.preventDefault();
      const input = document.getElementById('welcomeNameInput');
      const name = (input.value || 'Player').trim();
      p = loadProfile() || defaultProfile();
      p.name = name;
      saveProfile(p);
      Versus.rememberName(name);
      document.getElementById('welcomeModal').classList.remove('on');
    };

    const form = document.getElementById('welcomeForm');
    if (form) form.addEventListener('submit', saveWelcomeName);
    document.getElementById('welcomeStartBtn').addEventListener('click', saveWelcomeName);

    document.getElementById('statsBtn').addEventListener('click', function () {
      renderStatsModal();
      document.getElementById('statsModal').classList.add('on');
    });

    const openLeaderboard = function () {
      renderLeaderboard(activeLbPeriod, currentDifficulty());
      document.getElementById('leaderboardModal').classList.add('on');
    };

    document.querySelectorAll('.lb-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        renderLeaderboard(tab.dataset.lbperiod, activeLbDiff);
      });
    });

    document.querySelectorAll('.lb-diff-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        renderLeaderboard(activeLbPeriod, tab.dataset.lbdiff);
      });
    });

    const lbBtn = document.getElementById('leaderboardBtn');
    if (lbBtn) lbBtn.addEventListener('click', openLeaderboard);

    const closeLb = function () { document.getElementById('leaderboardModal').classList.remove('on'); };
    const lbClose = document.getElementById('lbCloseBtn');
    if (lbClose) lbClose.addEventListener('click', closeLb);
    const lbCloseBtm = document.getElementById('lbCloseBottomBtn');
    if (lbCloseBtm) lbCloseBtm.addEventListener('click', closeLb);

    const vsClose = document.getElementById('vsCloseBtn');
    if (vsClose) vsClose.addEventListener('click', function () {
      const modal = document.getElementById('versusModal');
      if (modal) modal.classList.remove('on');
    });

    const vsRoster = document.getElementById('vsRoster');
    if (vsRoster) {
      vsRoster.addEventListener('click', function (e) {
        if (e.target && e.target.closest('li')) {
          openLeaderboard();
        }
      });
    }

    const closeStats = function () { document.getElementById('statsModal').classList.remove('on'); };
    document.getElementById('statsCloseBtn').addEventListener('click', closeStats);
    document.getElementById('statsCloseBottomBtn').addEventListener('click', closeStats);

    document.getElementById('saveNameBtn').addEventListener('click', function () {
      const input = document.getElementById('profileNameInput');
      const name = (input.value || 'Player').trim();
      p = loadProfile() || defaultProfile();
      p.name = name;
      saveProfile(p);
      Versus.rememberName(name);
      closeStats();
    });
  }

  /* ---------------- theme management ---------------- */

  const THEME_KEY = 'mini-theme';

  function applyTheme(dark) {
    if (dark) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function initTheme() {
    let dark = false;
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved !== null) dark = saved === 'dark';
      else dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {}

    applyTheme(dark);

    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) themeBtn.addEventListener('click', function () {
      dark = !dark;
      applyTheme(dark);
      try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    });
  }

  // Just long enough that a warm start doesn't flash the loader for a single
  // frame. Anything beyond this is latency we'd be inventing.
  const LOADER_MIN_MS = 150;
  const LOADER_MAX_MS = 2000;
  let loaderShownAt = 0;
  let loaderDismissed = false;

  function dismissLoader() {
    if (loaderDismissed) return;              // rAF and the backstop can race
    const loader = document.getElementById('appLoader');
    if (!loader) return;
    loaderDismissed = true;
    const held = Date.now() - loaderShownAt;
    setTimeout(function () {
      loader.classList.add('fade-out');
      setTimeout(function () {
        if (loader.parentNode) loader.parentNode.removeChild(loader);
      }, 250);                                 // outlasts the 0.2s CSS fade
    }, Math.max(0, LOADER_MIN_MS - held));
  }

  /* ---------------- boot ---------------- */

  function mount(next, label) {
    state = next;
    el.date.textContent = label || state.label || todayLabel();
    el.grid.classList.remove('solved');
    resetHistory();
    buildGrid();
    buildClues();
    render();
    updateToolStates();
    renderChallengeBanner();
    requestScoreToken();
    if (state.solved) { stopTimer(); paintTimer(); }
    else startTimer();
  }

  /* ---------------- score token ----------------
     Proves to the server that real time elapsed between starting a puzzle and
     claiming a solve. Best-effort: if it fails the score simply will not be
     accepted onto the global board, and local stats are unaffected. */

  let scoreToken = null;

  function requestScoreToken() {
    scoreToken = null;
    if (!state || state.kind === 'versus') return;
    const diff = currentDifficulty();
    fetch('/api/score-token?difficulty=' + encodeURIComponent(diff))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data && data.token) scoreToken = data.token; })
      .catch(function () { /* offline — local play is unaffected */ });
  }

  /* ---------------- archive ---------------- */

  const ARCHIVE_START = '2024-01-01';   // nothing meaningful predates the app

  /* date -> best seconds, for the current difficulty only. Forfeits and
     unfinished entries are not times, so they are skipped. */
  function solvedTimes() {
    const p = loadProfile() || defaultProfile();
    const diff = currentDifficulty();
    const map = Object.create(null);
    (p.history || []).forEach(function (h) {
      if ((h.difficulty || 'medium') !== diff) return;
      if (h.forfeited || !h.seconds) return;
      if (map[h.date] === undefined || h.seconds < map[h.date]) map[h.date] = h.seconds;
    });
    return map;
  }

  const DAY_MS = 86400000;
  const WINDOW_DAYS = 14;
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ISO date of the first day shown; null until the archive is first opened.
  let calStart = null;

  /* Windows are aligned to Sunday so the day-of-week columns stay honest. */
  function startOfWeekUTC(d) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    x.setUTCDate(x.getUTCDate() - x.getUTCDay());
    return x;
  }

  function shiftDays(d, n) {
    return new Date(d.getTime() + n * DAY_MS);
  }

  /* The window ending with the current week — last week plus this one. */
  function latestWindowStart() {
    return shiftDays(startOfWeekUTC(new Date()), -7);
  }

  function earliestWindowStart() {
    return startOfWeekUTC(dateFromISO(ARCHIVE_START));
  }

  function clampWindow(d) {
    const min = earliestWindowStart(), max = latestWindowStart();
    if (d.getTime() < min.getTime()) return min;
    if (d.getTime() > max.getTime()) return max;
    return d;
  }

  function dayLabel(d, iso, today) {
    const day = d.getUTCDate();
    // Name the month on its first day so a window spanning two months reads
    // correctly without a separate heading.
    return day === 1 ? MONTH_SHORT[d.getUTCMonth()] + ' 1' : String(day);
  }

  function buildCalendar() {
    const grid = document.getElementById('calGrid');
    if (!grid) return;
    if (!calStart) calStart = isoOf(latestWindowStart());

    const done = solvedTimes();
    const today = todayISO();
    const start = clampWindow(dateFromISO(calStart));
    calStart = isoOf(start);

    let html = '';
    for (let i = 0; i < WINDOW_DAYS; i++) {
      const d = shiftDays(start, i);
      const iso = isoOf(d);
      // Windows are Sunday-aligned, so the earliest one can reach back past the
      // archive's start; those days are shown but not playable.
      const outOfRange = iso > today || iso < ARCHIVE_START;
      const time = done[iso];

      const classes = ['cal-day'];
      if (time !== undefined) classes.push('done');
      if (iso === today) classes.push('today');

      const name = iso === today ? 'Today' : iso;
      html += '<button class="' + classes.join(' ') + '" data-date="' + iso + '"' +
        (outOfRange ? ' disabled' : '') +
        ' aria-label="' + name + (time !== undefined ? ', solved in ' + formatTime(time) : '') + '">' +
        '<span class="cal-num">' + dayLabel(d, iso, today) + '</span>' +
        (time !== undefined ? '<span class="cal-time">' + formatTime(time) + '</span>' : '') +
        '</button>';
    }
    grid.innerHTML = html;

    const range = document.getElementById('calRange');
    if (range) {
      const end = shiftDays(start, WINDOW_DAYS - 1);
      const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
      range.textContent =
        MONTH_SHORT[start.getUTCMonth()] + ' ' + start.getUTCDate() +
        (sameYear ? '' : ', ' + start.getUTCFullYear()) + ' – ' +
        MONTH_SHORT[end.getUTCMonth()] + ' ' + end.getUTCDate() + ', ' + end.getUTCFullYear();
    }

    const prev = document.getElementById('calPrev');
    if (prev) prev.disabled = start.getTime() <= earliestWindowStart().getTime();
    const next = document.getElementById('calNext');
    if (next) next.disabled = start.getTime() >= latestWindowStart().getTime();
  }

  function pageCalendar(deltaWindows) {
    if (!calStart) return;
    calStart = isoOf(clampWindow(shiftDays(dateFromISO(calStart), deltaWindows * WINDOW_DAYS)));
    buildCalendar();
  }

  function playArchive(iso) {
    const d = dateFromISO(iso);
    if (!d) { showNotice('Pick a valid date'); return; }
    if (iso > todayISO()) { showNotice('That day has not happened yet'); return; }
    if (iso < ARCHIVE_START) { showNotice('The archive starts in 2024'); return; }

    // Today is the live daily, not an archive replay — it still has to count
    // toward the streak and the global board.
    if (iso === todayISO()) { closeArchive(); newPuzzle(); return; }

    if (race.on) { Versus.leave(); endRace(); }
    const difficulty = currentDifficulty();
    let puzzle;
    try {
      // forceBuiltin: the archive must reproduce the same grid on every device
      // and every day, which only the bundled bank guarantees.
      puzzle = makePuzzle(seedForDate(d), difficulty, true);
    } catch (e) {
      showNotice('Could not build that puzzle: ' + e.message);
      return;
    }
    const pretty = d.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
    });
    const label = pretty + ' · ' + (DIFF_LABEL[difficulty] || 'Medium') + ' · archive';
    const next = blankState(puzzle, label, 'archive');
    next.archiveDate = iso;

    // Already solved this day? Then the point of replaying it is the time.
    const best = solvedTimes()[iso];
    if (best !== undefined) next.challenge = { name: 'your best', seconds: best, self: true };

    mount(next, label);
    save();
    closeArchive();
  }

  function openArchive() {
    const modal = document.getElementById('archiveModal');
    if (!modal) return;
    // Open on the window holding whatever is being played, so leaving and
    // reopening the archive does not lose your place.
    const anchor = (state && state.archiveDate) ? dateFromISO(state.archiveDate) : new Date();
    calStart = isoOf(clampWindow(shiftDays(startOfWeekUTC(anchor), -7)));
    buildCalendar();
    modal.classList.add('on');
  }

  function closeArchive() {
    const modal = document.getElementById('archiveModal');
    if (modal) modal.classList.remove('on');
  }

  /* ---------------- sharing ---------------- */

  /* Just the link. It already carries the puzzle, the sender's name, and their
     time, so the receiving app renders the challenge itself — no result blurb
     needed in the message. */
  function buildShareUrl() {
    if (!state) return null;
    const p = loadProfile() || defaultProfile();
    return MiniShare.buildUrl(state.puzzle, {
      seconds: state.solved ? state.seconds : null,
      name: p.name || '',
      difficulty: state.puzzle.difficulty || currentDifficulty()
    });
  }

  /* Always show the link rather than copying it invisibly — a silent clipboard
     write gives no proof anything happened, and no way to see what you are
     about to send. */
  function shareResult() {
    const url = buildShareUrl();
    if (!url) return;

    const modal = document.getElementById('shareModal');
    const field = document.getElementById('shareText');
    if (!modal || !field) return;

    field.value = url;

    const blurb = document.getElementById('shareBlurb');
    if (blurb) {
      blurb.textContent = state.solved
        ? 'Your time of ' + formatTime(state.seconds) +
          ' is baked into this link — whoever opens it plays this exact puzzle and races you.'
        : 'This link opens this exact puzzle. Finish it first and the link will carry your time too.';
    }

    // Native sheet stays available on mobile, but as a choice, not the default.
    const native = document.getElementById('shareNative');
    if (native) native.style.display = navigator.share ? 'inline-block' : 'none';

    resetCopyButton();
    modal.classList.add('on');
    field.focus();
    field.select();
  }

  function resetCopyButton() {
    const btn = document.getElementById('shareCopy');
    if (!btn) return;
    btn.textContent = 'Copy';
    btn.classList.remove('copied');
  }

  function copyShareLink() {
    const field = document.getElementById('shareText');
    const btn = document.getElementById('shareCopy');
    if (!field) return;

    function done() {
      if (!btn) return;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      clearTimeout(btn._timer);
      btn._timer = setTimeout(resetCopyButton, 2200);
    }
    function failed() {
      field.focus();
      field.select();
      if (btn) btn.textContent = 'Press Ctrl+C';
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(field.value).then(done).catch(function () {
        // Clipboard API is blocked on insecure origins; execCommand still works.
        field.select();
        try { document.execCommand('copy') ? done() : failed(); } catch (e) { failed(); }
      });
      return;
    }
    field.select();
    try { document.execCommand('copy') ? done() : failed(); } catch (e) { failed(); }
  }

  /* A link puts the sender's puzzle and time into the recipient's app. */
  function loadSharedFromUrl() {
    const code = MiniShare.readUrl();
    if (!code) return false;

    const parsed = MiniShare.decode(code);
    // Strip the fragment either way, so a reload does not resurrect a
    // challenge the player has already moved on from.
    MiniShare.clearUrl();
    if (!parsed) { showNotice('That challenge link could not be read'); return false; }

    const who = parsed.challenge ? parsed.challenge.name : 'A friend';
    const label = 'Challenge from ' + who + ' · ' + (DIFF_LABEL[parsed.difficulty] || 'Medium');
    const next = blankState(parsed.puzzle, label, 'shared');
    next.challenge = parsed.challenge;
    mount(next, label);
    save();
    return true;
  }

  /* Clicking a challenge link while the app is already open is a same-document
     fragment navigation — no reload, so boot() never runs again. Without this
     the link would appear to do nothing. */
  window.addEventListener('hashchange', function () {
    if (!MiniShare.readUrl()) return;
    if (race.on) { Versus.leave(); endRace(); }
    loadSharedFromUrl();
  });

  function renderChallengeBanner() {
    const banner = document.getElementById('challengeBanner');
    if (!banner) return;
    if (!state || !state.challenge) { banner.classList.remove('on'); return; }
    banner.classList.add('on');
    banner.textContent = state.challenge.self
      ? 'Your best on this puzzle: ' + MiniShare.formatTime(state.challenge.seconds) + ' — beat it.'
      : state.challenge.name + ' solved this in ' +
        MiniShare.formatTime(state.challenge.seconds) + ' — beat it.';
  }

  function isDailyCompleted(difficulty) {
    const p = loadProfile() || defaultProfile();
    const today = new Date().toISOString().split('T')[0];
    const diff = difficulty || currentDifficulty();
    return (p.history || []).some(function (h) {
      return h.date === today && (h.difficulty || 'medium') === diff;
    });
  }

  function newPuzzle() {
    // Starting a solo puzzle means stepping out of any lobby.
    if (race.on) { Versus.leave(); endRace(); }
    const difficulty = currentDifficulty();

    if (!isDailyCompleted(difficulty)) {
      const puzzle = makePuzzle(dailySeed(), difficulty, true);
      const label = todayLabel() + ' · ' + (DIFF_LABEL[difficulty] || 'Medium');
      mount(blankState(puzzle, label, 'daily'), label);
      save();
      return;
    }

    const seed = Math.floor(Math.random() * 2147483647);
    const puzzle = makePuzzle(seed, difficulty);
    const label = (DIFF_LABEL[difficulty] || 'Medium') + ' · freshly generated';
    mount(blankState(puzzle, label, 'random'), label);
    save();
    showNotice('Completed today\'s ' + (DIFF_LABEL[difficulty] || 'Medium') + ' Daily! Playing a fresh practice puzzle.');
  }

  function startPuzzle() {
    // A challenge link wins over saved progress: the player clicked it just now.
    if (loadSharedFromUrl()) return;
    const saved = load();
    if (saved) { mount(saved, saved.label); return; }
    newPuzzle();
  }

  function noteSource(source, error) {
    const total = MiniGenerator.stats().total;
    const origin = source === 'datamuse' ? 'Datamuse dictionary'
      : source === 'cache' ? 'Datamuse dictionary (cached)'
      : source === 'fetching' ? 'built-in list · fetching more…'
      : 'built-in word list (offline)';
    const text = total.toLocaleString() + ' words · ' + origin;

    const note = document.getElementById('bankNote');
    if (note) {
      note.textContent = text;
      note.title = error ? 'Dictionary fetch failed: ' + error : '';
    }

    // Mirror into the loader while it's still up, so it reports the real
    // dictionary state instead of a hardcoded "Loading puzzle…".
    const status = document.getElementById('loaderStatus');
    if (status) status.textContent = text;
  }

  function boot() {
    // Never block play on the network: start from the cache (or the bundled
    // bank) and swap in the larger vocabulary whenever it lands.
    loaderShownAt = Date.now();

    // Curated clues outrank whatever definitions the active bank carries, so
    // install them before the first puzzle is built.
    if (window.CURATED_CLUES) MiniGenerator.setClueOverrides(window.CURATED_CLUES);

    let source = 'builtin';
    const cached = WordSource.cached();
    if (cached && MiniGenerator.useBank(cached.bank)) source = 'cache';

    initProfileUI();
    initTheme();
    startPuzzle();
    noteSource(source === 'cache' ? 'cache' : 'fetching');

    // startPuzzle() is synchronous, so the board is built by now — dismiss as
    // soon as it has actually painted rather than after an arbitrary delay.
    // Two frames: the first schedules the paint, the second runs after it.
    if (document.hidden) {
      // Background tabs never paint, so rAF would not fire at all and the
      // loader would sit there until the tab gained focus. Nothing is visible
      // to flash, so drop it now.
      dismissLoader();
    } else {
      requestAnimationFrame(function () {
        requestAnimationFrame(dismissLoader);
      });
    }
    setTimeout(dismissLoader, LOADER_MAX_MS);  // backstop if rAF never runs

    WordSource.refresh().then(function (result) {
      if (!result) return;                       // cache already fresh
      if (result.bank && MiniGenerator.useBank(result.bank)) noteSource('datamuse');
      else noteSource('builtin', result.error);
    }).catch(function (err) {
      noteSource('builtin', String(err && err.message || err));
    });
  }

  /* ---------------- versus UI ---------------- */

  function vsError(message) {
    el.vsError.textContent = message || '';
  }

  function showVersusModal() {
    el.vsName.value = Versus.savedName();
    el.vsDifficulty.value = currentDifficulty();
    vsError('');
    const inLobby = Versus.state.active;
    el.versusSetup.hidden = inLobby;
    el.versusLobby.hidden = !inLobby;
    el.versusTitle.textContent = inLobby ? 'Lobby' : 'Versus';
    el.versusModal.classList.add('on');
    renderLobby();
  }

  function hideVersusModal() { el.versusModal.classList.remove('on'); }

  function renderLobby() {
    const vs = Versus.state;
    window.vsState = vs;
    if (!vs.active) return;
    el.vsCodeOut.textContent = vs.code;
    el.vsRoster.innerHTML = '';
    vs.players.forEach(function (p) {
      const li = document.createElement('li');
      li.textContent = p.name + (p.id === vs.hostId ? ' (host)' : '') + (p.id === vs.playerId ? ' — you' : '');
      el.vsRoster.appendChild(li);
    });
    const host = Versus.isHost();
    el.vsStart.hidden = !host;
    el.vsWaitHint.hidden = host;
    el.vsStart.disabled = vs.players.length < 2;
    el.vsStart.textContent = vs.players.length < 2 ? 'Waiting for players…' : 'Start race';
  }

  el.versusBtn.addEventListener('click', showVersusModal);

  document.querySelectorAll('.vs-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.vs-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
      document.querySelectorAll('.vs-pane').forEach(function (pane) {
        pane.hidden = pane.dataset.vspane !== tab.dataset.vstab;
      });
      vsError('');
    });
  });

  el.vsCreate.addEventListener('click', function () {
    const name = (el.vsName.value || 'Host').trim();
    const difficulty = el.vsDifficulty.value;
    Versus.rememberName(name);
    vsError('Building the puzzle…');
    let puzzle;
    try { puzzle = makePuzzle(null, difficulty); }
    catch (e) { return vsError('Could not build a puzzle: ' + e.message); }

    Versus.create(name, difficulty, puzzle).then(function () {
      vsError('');
      startRacePuzzle(puzzle, difficulty);
      el.versusSetup.hidden = true;
      el.versusLobby.hidden = false;
      el.versusTitle.textContent = 'Lobby';
      renderLobby();
    }).catch(function (err) { vsError(err.message); });
  });

  el.vsJoin.addEventListener('click', function () {
    const name = (el.vsName.value || 'Player').trim();
    const code = (el.vsCode.value || '').toUpperCase().trim();
    if (code.length !== 4) return vsError('Enter the 4-character lobby code.');
    Versus.rememberName(name);
    vsError('Joining…');
    Versus.join(code, name).then(function (res) {
      vsError('');
      startRacePuzzle(res.puzzle, res.difficulty);
      el.versusSetup.hidden = true;
      el.versusLobby.hidden = false;
      el.versusTitle.textContent = 'Lobby';
      renderLobby();
    }).catch(function (err) { vsError(err.message); });
  });

  el.vsStart.addEventListener('click', function () {
    el.vsStart.disabled = true;
    Versus.start().catch(function (err) { vsError(err.message); });
  });

  el.vsCancel.addEventListener('click', function () {
    Versus.leave();
    endRace();
    hideVersusModal();
    newPuzzle();
  });

  el.raceLeave.addEventListener('click', function () {
    Versus.leave();
    endRace();
    newPuzzle();
  });

  const raceRematchBtn = document.getElementById('raceRematch');
  if (raceRematchBtn) {
    raceRematchBtn.addEventListener('click', function () {
      closeModal();
      const diff = currentDifficulty();
      let nextPuzzle;
      try { nextPuzzle = makePuzzle(null, diff); } catch (e) { nextPuzzle = makePuzzle(null, 'medium'); }
      Versus.rematch(nextPuzzle, diff).then(function () {
        startRacePuzzle(nextPuzzle, diff);
        showVersusModal();
      }).catch(function (err) { showNotice(err.message || 'Rematch failed'); });
    });
  }

  el.versusModal.addEventListener('click', function (e) {
    if (e.target === el.versusModal) hideVersusModal();
  });

  el.vsCode.addEventListener('input', function () {
    el.vsCode.value = el.vsCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  let lastRematchVersion = -1;

  Versus.onChange(function (vs) {
    renderRaceStrip();
    renderCountdown();
    if (!el.versusModal.hidden) renderLobby();

    // When a rematch is triggered on server (startAt cleared), fetch new puzzle and re-open Lobby for all players!
    if (vs.active && !vs.started && !vs.startAt && race.on && vs.version !== lastRematchVersion) {
      lastRematchVersion = vs.version;
      closeModal();
      fetch('/api/puzzle?code=' + vs.code)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.puzzle) {
            startRacePuzzle(data.puzzle, data.difficulty || currentDifficulty());
            showVersusModal();
          }
        })
        .catch(function () {
          showVersusModal();
        });
    }

    if (vs.started && race.on && state && !state.running && !state.solved) {
      hideVersusModal();
      beginRace();
    }
    if (vs.started && race.on && state && !state.solved) {
      const players = vs.players || [];
      const totalPlayers = players.length;
      const winner = players.find(function (p) { return p.place === 1; });
      const finishedOtherPlayers = players.filter(function (p) { return p.id !== vs.playerId && p.solved; }).length;
      const otherPlayersCount = Math.max(1, totalPlayers - 1);

      const is1v1Loss = (totalPlayers === 2 && winner && winner.id !== vs.playerId);
      const isMultiplayerLastLeft = (totalPlayers > 2 && finishedOtherPlayers >= otherPlayersCount);
      const isGlobalFinished = vs.finished;

      if (is1v1Loss || isMultiplayerLastLeft || isGlobalFinished) {
        state.running = false;
        stopTimer();
        reveal('puzzle');
        let reason = 'Race finished! Full puzzle solution revealed.';
        if (is1v1Loss) {
          reason = (winner ? winner.name : 'Opponent') + ' won the 1v1 match! Solution revealed.';
        } else if (isMultiplayerLastLeft) {
          reason = 'All other players finished! You were last — solution revealed.';
        }
        showNotice(reason);
        showCongrats();
      }
    }
    if (vs.started) el.countdown.classList.remove('on');
  });

  document.querySelectorAll('#difficultyMenu [data-difficulty]').forEach(function (btn) {
    btn.addEventListener('click', function () { setDifficulty(btn.dataset.difficulty); });
  });

  buildKeyboard();
  markDifficultyMenu();
  boot();

  window.MiniGame = {
    state: function () { return state; },
    newPuzzle: newPuzzle,
    setDifficulty: setDifficulty,
    race: race
  };
})();

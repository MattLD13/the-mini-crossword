/* The Mini — game logic */
(function () {
  'use strict';

  const SIZE = 5;
  const STORE_KEY = 'mini-clone-state-v1';
  const DIFF_KEY = 'mini-difficulty';
  const DIFF_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', extreme: 'Extreme' };

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

  function dailySeed() {
    const d = new Date();
    const str = d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0);
  }

  function blankState(puzzle, label, kind) {
    const entries = [];
    const marks = [];
    for (let r = 0; r < SIZE; r++) {
      entries[r] = [];
      marks[r] = [];
      for (let c = 0; c < SIZE; c++) {
        entries[r][c] = puzzle.black[r][c] ? null : '';
        marks[r][c] = { revealed: false, wrong: false, correct: false };
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
      usedHelp: false
    };
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

  function todayLabel() {
    return new Date().toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
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
        usedHelp: state.usedHelp
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
      s.seconds = data.seconds || 0;
      s.solved = !!data.solved;
      s.usedHelp = !!data.usedHelp;
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
    cells = [];
    for (let r = 0; r < SIZE; r++) {
      cells[r] = [];
      for (let c = 0; c < SIZE; c++) {
        const div = document.createElement('div');
        div.className = 'cell' + (state.puzzle.black[r][c] ? ' black' : '');
        div.dataset.r = r;
        div.dataset.c = c;
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
        node.querySelector('.letter').textContent = state.entries[r][c] || '';
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

  function setLetter(r, c, ch) {
    state.entries[r][c] = ch;
    state.marks[r][c].wrong = false;
    state.marks[r][c].correct = false;
    if (!ch) state.marks[r][c].revealed = false;
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

    setLetter(r, c, ch);

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
      setLetter(r, c, '');
      if (idx > 0) return moveTo(entry.cells[idx - 1]);
      return render();
    }

    if (idx > 0) {
      const prev = entry.cells[idx - 1];
      if (isLocked(prev.r, prev.c)) return moveTo(prev);
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

  function reveal(scope) {
    state.usedHelp = true;
    targetCells(scope).forEach(function (cell) {
      const answer = state.puzzle.solution[cell.r][cell.c];
      if (state.entries[cell.r][cell.c] !== answer) {
        state.entries[cell.r][cell.c] = answer;
        state.marks[cell.r][cell.c].revealed = true;
      }
      state.marks[cell.r][cell.c].wrong = false;
      state.marks[cell.r][cell.c].correct = false;
    });
    if (!checkSolved()) render();
  }

  function clear(scope) {
    targetCells(scope).forEach(function (cell) {
      state.entries[cell.r][cell.c] = '';
      state.marks[cell.r][cell.c] = { revealed: false, wrong: false, correct: false };
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
    if (race.on) {
      const me = Versus.me();
      const place = me && me.place;
      const won = place === 1;
      el.modalMark.textContent = won ? '🏆' : '🏁';
      el.modalMark.style.color = won ? '#f5c518' : '#555';
      el.modalTitle.textContent = won ? 'You won!' : 'Finished ' + formatPlace(place || 1);
      const winner = Versus.state.players.find(function (p) { return p.place === 1; });
      el.modalBody.textContent = won
        ? 'First to finish, in ' + formatTime(state.seconds) + '.'
        : 'You solved it in ' + formatTime(state.seconds) +
          (winner ? '. ' + winner.name + ' got there first.' : '.');
      el.modal.classList.add('on');
      return;
    }
    if (state.usedHelp) {
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

  function showNotice(msg) {
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
    notice._timer = setTimeout(function () {
      notice.classList.remove('on');
    }, 2200);
  }

  /* ---------------- timer ---------------- */

  function formatTime(total) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function paintTimer() {
    el.timerText.textContent = formatTime(state.seconds);
    el.timerIcon.style.display = state.solved ? 'none' : '';
    el.timerIcon.innerHTML = state.running
      ? '<rect x="1" y="1" width="3.4" height="12" fill="currentColor"></rect><rect x="7.6" y="1" width="3.4" height="12" fill="currentColor"></rect>'
      : '<path d="M1 1 L11 7 L1 13 Z" fill="currentColor"></path>';
  }

  function updateVersusToolBadges() {
    const btnCheck = document.getElementById('checkMenuBtn');
    const btnReveal = document.getElementById('revealMenuBtn');
    const revealList = document.getElementById('revealMenuList');
    if (race.on) {
      if (btnCheck) btnCheck.innerHTML = 'Check (' + (race.checks || 0) + ')<span class="caret"></span>';
      if (btnReveal) btnReveal.innerHTML = 'Reveal (' + (race.reveals || 0) + ')<span class="caret"></span>';
      if (revealList) {
        revealList.innerHTML =
          '<button data-action="reveal-square">Square (1★)</button>' +
          '<button data-action="reveal-word">Word (2★)</button>';
      }
    } else {
      if (btnCheck) btnCheck.innerHTML = 'Check<span class="caret"></span>';
      if (btnReveal) btnReveal.innerHTML = 'Reveal<span class="caret"></span>';
      if (revealList) {
        revealList.innerHTML =
          '<button data-action="reveal-square">Square</button>' +
          '<button data-action="reveal-word">Word</button>' +
          '<button data-action="reveal-puzzle">Puzzle</button>';
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
          showNotice('+1 Check Credit earned! (' + race.checks + ' available)');
          updateVersusToolBadges();
        }
        const earnedReveals = Math.floor(state.seconds / 60);
        if (earnedReveals > race.lastRevealSec) {
          const diff = earnedReveals - race.lastRevealSec;
          race.reveals = (race.reveals || 0) + diff;
          race.lastRevealSec = earnedReveals;
          showNotice('+1 Reveal Credit earned! (' + race.reveals + ' available)');
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

  function giveHint(scope) {
    const entry = currentEntry();
    if (!entry) {
      showNotice('Select a clue on the board first!');
      return;
    }
    const answer = entry.answer;
    const num = entry.num + (entry.dir === 'across' ? 'A' : 'D');

    if (scope === 'clue') {
      const vowels = (answer.match(/[AEIOU]/gi) || []).length;
      const firstLetter = answer[0];
      showNotice('💡 ' + num + ' Hint: ' + answer.length + ' letters, starts with "' + firstLetter + '" (' + vowels + ' vowel' + (vowels === 1 ? '' : 's') + ')');
    } else if (scope === 'vowels') {
      const vowels = (answer.match(/[AEIOU]/gi) || []).length;
      showNotice('🔍 ' + num + ' contains ' + vowels + ' vowel' + (vowels === 1 ? '' : 's') + '.');
    } else if (scope === 'letter') {
      let emptyCell = entry.cells.find(function (c) {
        return !state.entries[c.r][c.c] || state.marks[c.r][c.c].wrong;
      });
      if (!emptyCell) emptyCell = entry.cells[0];
      const ansChar = state.puzzle.solution[emptyCell.r][emptyCell.c];
      state.entries[emptyCell.r][emptyCell.c] = ansChar;
      state.marks[emptyCell.r][emptyCell.c].revealed = true;
      state.usedHelp = true;
      render();
      showNotice('🔤 Filled letter "' + ansChar + '" in ' + num + '!');
      if (checkSolved()) return;
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
  el.newBtn.addEventListener('click', function () { newPuzzle(); });
  el.modalNew.addEventListener('click', function () { closeModal(); newPuzzle(); });
  el.modalClose.addEventListener('click', closeModal);

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

  const race = { on: false, sendTimer: null, lastSent: -1, checks: 0, reveals: 0, lastCheckSec: 0, lastRevealSec: 0 };

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
    race.reveals = 0;
    race.lastCheckSec = 0;
    race.lastRevealSec = 0;
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

  function recordSolve() {
    let p = loadProfile() || defaultProfile();
    const today = new Date().toISOString().split('T')[0];
    const dYesterday = new Date();
    dYesterday.setDate(dYesterday.getDate() - 1);
    const yesterday = dYesterday.toISOString().split('T')[0];

    if (p.lastSolvedDate !== today) {
      p.played = (p.played || 0) + 1;
      p.solved = (p.solved || 0) + 1;

      if (p.lastSolvedDate === yesterday) {
        p.streak = (p.streak || 0) + 1;
      } else {
        p.streak = 1;
      }

      if (p.streak > (p.bestStreak || 0)) {
        p.bestStreak = p.streak;
      }
      p.lastSolvedDate = today;

      const entry = {
        date: today,
        seconds: state.seconds,
        difficulty: currentDifficulty(),
        usedHelp: !!state.usedHelp,
        label: state.label || 'The Mini'
      };

      p.history = p.history || [];
      p.history.unshift(entry);
      if (p.history.length > 30) p.history.pop();
      saveProfile(p);
    }
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
        '<span class="history-date">' + h.date + '</span>' +
        '<div class="history-meta">' +
          '<span class="history-badge">' + (h.difficulty || 'medium') + (h.usedHelp ? ' *' : '') + '</span>' +
          '<span class="history-time">' + formatTime(h.seconds || 0) + '</span>' +
        '</div>';
      list.appendChild(div);
    });
  }

  let activeLbPeriod = 'daily';
  let activeLbDiff = 'medium';

  function renderLeaderboard(period, diff) {
    if (period) activeLbPeriod = period;
    if (diff) activeLbDiff = diff;

    document.querySelectorAll('.lb-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.lbperiod === activeLbPeriod);
    });
    document.querySelectorAll('.lb-diff-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.lbdiff === activeLbDiff);
    });

    const p = loadProfile() || defaultProfile();
    const myName = p.name || 'You';
    const today = new Date().toISOString().split('T')[0];

    const targetDiff = activeLbDiff;
    const isDailyMode = activeLbPeriod === 'daily';

    let myMatchingHistory = (p.history || []).filter(function (h) {
      const matchDiff = !h.difficulty || h.difficulty === targetDiff;
      if (!matchDiff) return false;
      if (isDailyMode) return h.date === today;
      return true;
    });

    let bestTime = null;
    if (myMatchingHistory.length > 0) {
      bestTime = myMatchingHistory.reduce(function (min, h) {
        return (min === null || (h.seconds && h.seconds < min)) ? h.seconds : min;
      }, null);
    }

    const myStreakVal = isDailyMode ? (p.streak || 0) : (p.bestStreak || 0);

    const meEntry = {
      name: myName,
      streak: myStreakVal,
      bestTime: bestTime ? formatTime(bestTime) : '--:--',
      seconds: bestTime || 9999,
      isMe: true
    };

    const entries = [meEntry];

    if (window.vsState && window.vsState.players) {
      window.vsState.players.forEach(function (pl) {
        if (pl.name !== myName) {
          entries.push({
            name: pl.name,
            streak: isDailyMode ? (Math.floor(Math.random() * 5) + 1) : (Math.floor(Math.random() * 12) + 2),
            bestTime: pl.finished ? formatTime(pl.time || 0) : 'Active',
            seconds: pl.finished ? (pl.time || 999) : 9999,
            isMe: false
          });
        }
      });
    }

    entries.sort(function (a, b) {
      const scoreA = (a.seconds < 9999 ? (10000 - a.seconds) : 0) + (a.streak * 250);
      const scoreB = (b.seconds < 9999 ? (10000 - b.seconds) : 0) + (b.streak * 250);
      if (scoreA !== scoreB) return scoreB - scoreA;
      if (a.seconds !== b.seconds) return a.seconds - b.seconds;
      return b.streak - a.streak;
    });

    const list = document.getElementById('lbList');
    if (!list) return;
    list.innerHTML = '';

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

  function dismissLoader() {
    const loader = document.getElementById('appLoader');
    if (!loader) return;
    loader.classList.add('fade-out');
    setTimeout(function () {
      if (loader.parentNode) loader.parentNode.removeChild(loader);
    }, 450);
  }

  /* ---------------- boot ---------------- */

  function mount(next, label) {
    state = next;
    el.date.textContent = label || state.label || todayLabel();
    el.grid.classList.remove('solved');
    buildGrid();
    buildClues();
    render();
    if (state.solved) { stopTimer(); paintTimer(); }
    else startTimer();
  }

  function newPuzzle() {
    // Starting a solo puzzle means stepping out of any lobby.
    if (race.on) { Versus.leave(); endRace(); }
    const seed = Math.floor(Math.random() * 2147483647);
    const difficulty = currentDifficulty();
    const puzzle = makePuzzle(seed, difficulty);
    const label = DIFF_LABEL[difficulty] + ' · freshly generated';
    mount(blankState(puzzle, label, 'random'), label);
    save();
  }

  function startPuzzle() {
    const saved = load();
    if (saved) { mount(saved, saved.label); return; }
    const difficulty = currentDifficulty();
    const puzzle = makePuzzle(dailySeed(), difficulty, true);
    const label = todayLabel() + ' · ' + DIFF_LABEL[difficulty];
    mount(blankState(puzzle, label, 'daily'), label);
    save();
  }

  function noteSource(source, error) {
    const note = document.getElementById('bankNote');
    if (!note) return;
    const total = MiniGenerator.stats().total;
    const origin = source === 'datamuse' ? 'Datamuse dictionary'
      : source === 'cache' ? 'Datamuse dictionary (cached)'
      : source === 'fetching' ? 'built-in list · fetching more…'
      : 'built-in word list (offline)';
    note.textContent = total.toLocaleString() + ' words · ' + origin;
    note.title = error ? 'Dictionary fetch failed: ' + error : '';
  }

  function boot() {
    // Never block play on the network: start from the cache (or the bundled
    // bank) and swap in the larger vocabulary whenever it lands.
    let source = 'builtin';
    const cached = WordSource.cached();
    if (cached && MiniGenerator.useBank(cached.bank)) source = 'cache';

    initProfileUI();
    initTheme();
    startPuzzle();
    noteSource(source === 'cache' ? 'cache' : 'fetching');
    setTimeout(dismissLoader, 300);

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

  el.versusModal.addEventListener('click', function (e) {
    if (e.target === el.versusModal) hideVersusModal();
  });

  el.vsCode.addEventListener('input', function () {
    el.vsCode.value = el.vsCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  Versus.onChange(function (vs) {
    renderRaceStrip();
    renderCountdown();
    if (!el.versusModal.hidden) renderLobby();
    if (vs.started && race.on && state && !state.running && !state.solved) {
      hideVersusModal();
      beginRace();
    }
    if (vs.finished && race.on && state && !state.solved) {
      reveal('puzzle');
      showNotice('Race finished! Full puzzle solution revealed.');
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

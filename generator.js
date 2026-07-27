/* Mini crossword generator: pattern selection + CSP fill with forward checking. */
(function (global) {
  'use strict';

  const SIZE = 5;
  const MIN_LEN = 3;

  /* ---------- word bank ----------
     A bank is { clues: {WORD: [clue, ...]}, byLen: {3: [], 4: [], 5: []} }.
     The bundled text banks are the offline fallback; WordSource can swap in a
     larger bank fetched from a dictionary API. */

  // Curated words are all everyday vocabulary, so they sit in the top tier.
  const CURATED_FREQ = 60;

  function makeBank() {
    return {
      clues: Object.create(null),
      freq: Object.create(null),
      byLen: { 3: [], 4: [], 5: [] },
      tiers: null
    };
  }

  function addWord(bank, word, clues, freq) {
    const w = String(word).toUpperCase();
    if (!/^[A-Z]{3,5}$/.test(w)) return false;
    const list = (Array.isArray(clues) ? clues : [clues])
      .map(function (c) { return String(c).trim(); })
      .filter(Boolean);
    if (!list.length) return false;
    if (bank.clues[w]) {
      list.forEach(function (c) { if (bank.clues[w].indexOf(c) === -1) bank.clues[w].push(c); });
      bank.freq[w] = Math.max(bank.freq[w] || 0, freq || 0);
    } else {
      bank.clues[w] = list;
      bank.freq[w] = freq === undefined ? CURATED_FREQ : freq;
      bank.byLen[w.length].push(w);
    }
    bank.tiers = null;
    return true;
  }

  function ingest(bank, text, freq) {
    text.split('\n').forEach(function (raw) {
      const line = raw.trim();
      if (!line) return;
      const parts = line.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
      if (parts.length < 2) return;
      addWord(bank, parts[0], parts.slice(1), freq);
    });
    return bank;
  }

  /* ---------- difficulty ----------
     minFreq sets how obscure an answer may be; bias steers the solver toward
     common or rare fill; patterns control how open the grid is (fewer black
     squares means longer, more constrained entries). */
  const DIFFICULTY = {
    easy:    { minFreq: 12,  bias: 'common', patterns: [0, 1, 2, 3, 4] },
    medium:  { minFreq: 4,   bias: 'common', patterns: [0, 1, 2, 3, 4, 5, 6] },
    hard:    { minFreq: 1.2, bias: 'rare',   patterns: [5, 6, 7, 8] },
    extreme: { minFreq: 0,   bias: 'rare',   patterns: [7, 8, 5, 6] }
  };

  const MIN_CANDIDATES = 60;

  function tierFor(bank, difficulty) {
    if (!bank.tiers) bank.tiers = Object.create(null);
    if (bank.tiers[difficulty]) return bank.tiers[difficulty];

    const conf = DIFFICULTY[difficulty] || DIFFICULTY.medium;
    const byLen = { 3: [], 4: [], 5: [] };
    [3, 4, 5].forEach(function (len) {
      const all = bank.byLen[len];
      let floor = conf.minFreq;
      let picked = all.filter(function (w) { return (bank.freq[w] || 0) >= floor; });
      // Relax the floor rather than hand the solver an unfillable domain.
      while (picked.length < MIN_CANDIDATES && floor > 0) {
        floor = floor > 1 ? floor / 2 : 0;
        picked = all.filter(function (w) { return (bank.freq[w] || 0) >= floor; });
      }
      byLen[len] = picked;
    });

    bank.tiers[difficulty] = { byLen: byLen, bias: conf.bias, patterns: conf.patterns };
    return bank.tiers[difficulty];
  }

  const BUILTIN = makeBank();
  ingest(BUILTIN, WORD_BANK_3);
  ingest(BUILTIN, WORD_BANK_4);
  ingest(BUILTIN, WORD_BANK_5A);
  ingest(BUILTIN, WORD_BANK_5B);

  let active = BUILTIN;
  const CLUES = function () { return active.clues; };
  const BY_LEN = function () { return active.byLen; };

  /* ---------- seeded RNG ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ---------- grid patterns (# = black square) ---------- */
  const PATTERNS = [
    ['...##', '.....', '.....', '.....', '##...'],
    ['##...', '.....', '.....', '.....', '...##'],
    ['#...#', '.....', '.....', '.....', '#...#'],
    ['#....', '#....', '.....', '....#', '....#'],
    ['....#', '....#', '.....', '#....', '#....'],
    ['#....', '.....', '.....', '.....', '....#'],
    ['....#', '.....', '.....', '.....', '#....'],
    ['#....', '.....', '.....', '.....', '#....'],
    ['....#', '.....', '.....', '.....', '....#']
  ];

  /* ---------- slot extraction ---------- */
  function buildSlots(pattern) {
    const black = [];
    for (let r = 0; r < SIZE; r++) {
      black[r] = [];
      for (let c = 0; c < SIZE; c++) black[r][c] = pattern[r][c] === '#';
    }

    // Number the grid the standard way.
    const numbers = [];
    for (let r = 0; r < SIZE; r++) { numbers[r] = []; for (let c = 0; c < SIZE; c++) numbers[r][c] = 0; }
    let n = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (black[r][c]) continue;
        const startsAcross = (c === 0 || black[r][c - 1]) && c + 1 < SIZE && !black[r][c + 1];
        const startsDown = (r === 0 || black[r - 1][c]) && r + 1 < SIZE && !black[r + 1][c];
        if (startsAcross || startsDown) numbers[r][c] = ++n;
      }
    }

    const slots = [];
    function addRun(cells, dir) {
      if (cells.length === 0) return true;
      if (cells.length < MIN_LEN) return false; // reject stubby patterns outright
      slots.push({
        id: dir[0].toUpperCase() + numbers[cells[0].r][cells[0].c],
        dir: dir,
        num: numbers[cells[0].r][cells[0].c],
        cells: cells,
        len: cells.length
      });
      return true;
    }

    for (let r = 0; r < SIZE; r++) {
      let run = [];
      for (let c = 0; c < SIZE; c++) {
        if (black[r][c]) { if (!addRun(run, 'across')) return null; run = []; }
        else run.push({ r: r, c: c });
      }
      if (!addRun(run, 'across')) return null;
    }
    for (let c = 0; c < SIZE; c++) {
      let run = [];
      for (let r = 0; r < SIZE; r++) {
        if (black[r][c]) { if (!addRun(run, 'down')) return null; run = []; }
        else run.push({ r: r, c: c });
      }
      if (!addRun(run, 'down')) return null;
    }

    // Cross references: for each slot, which slots share which cell index.
    const owner = {}; // "r,c" -> {across:idx, down:idx, acrossPos, downPos}
    slots.forEach(function (slot, si) {
      slot.cells.forEach(function (cell, pos) {
        const k = cell.r + ',' + cell.c;
        if (!owner[k]) owner[k] = {};
        owner[k][slot.dir] = { slot: si, pos: pos };
      });
    });
    slots.forEach(function (slot, si) {
      slot.cross = [];
      slot.cells.forEach(function (cell, pos) {
        const other = owner[cell.r + ',' + cell.c][slot.dir === 'across' ? 'down' : 'across'];
        if (other && other.slot !== si) {
          slot.cross.push({ slot: other.slot, myPos: pos, theirPos: other.pos });
        }
      });
    });

    return { slots: slots, black: black, numbers: numbers };
  }

  /* ---------- CSP solver ---------- */
  /* Order a slot's candidates so the solver reaches for common words on easy
     settings and rarer ones on hard, while keeping puzzles varied. */
  function orderCandidates(words, rnd, bias, freq) {
    if (bias === 'none') return shuffle(words.slice(), rnd);
    const dir = bias === 'rare' ? 1 : -1;
    return words.map(function (w) {
      const weight = Math.log(1 + (freq[w] || 0)) * dir;
      return { w: w, key: weight + rnd() * 2.2 };
    }).sort(function (a, b) { return a.key - b.key; })
      .map(function (x) { return x.w; });
  }

  function fill(slots, rnd, budget, tier, freq) {
    const domains = slots.map(function (slot) {
      return orderCandidates(tier.byLen[slot.len], rnd, tier.bias, freq);
    });
    const assigned = new Array(slots.length).fill(null);
    const used = Object.create(null);
    let nodes = 0;

    function pickSlot(doms) {
      let best = -1, bestSize = Infinity;
      for (let i = 0; i < slots.length; i++) {
        if (assigned[i]) continue;
        const size = doms[i].length;
        if (size < bestSize) { bestSize = size; best = i; }
      }
      return best;
    }

    function recurse(doms) {
      if (++nodes > budget) throw new Error('budget');
      const si = pickSlot(doms);
      if (si === -1) return true;
      const candidates = doms[si];
      if (candidates.length === 0) return false;

      for (let ci = 0; ci < candidates.length; ci++) {
        const word = candidates[ci];
        if (used[word]) continue;

        const next = doms.slice();
        let ok = true;
        for (let k = 0; k < slots[si].cross.length; k++) {
          const x = slots[si].cross[k];
          if (assigned[x.slot]) continue;
          const letter = word[x.myPos];
          const filtered = next[x.slot].filter(function (w) { return w[x.theirPos] === letter; });
          if (filtered.length === 0) { ok = false; break; }
          next[x.slot] = filtered;
        }
        if (!ok) continue;

        assigned[si] = word;
        used[word] = true;
        next[si] = [word];
        if (recurse(next)) return true;
        assigned[si] = null;
        delete used[word];
      }
      return false;
    }

    try {
      if (recurse(domains)) return assigned;
    } catch (e) {
      if (e.message !== 'budget') throw e;
    }
    return null;
  }

  /* ---------- puzzle assembly ---------- */
  function generate(seed, options) {
    const opts = options || {};
    const difficulty = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'medium';
    const actualSeed = (seed === undefined || seed === null)
      ? Math.floor(Math.random() * 2147483647)
      : (seed >>> 0);
    const rnd = mulberry32(actualSeed);
    const bank = active;
    const tier = tierFor(bank, difficulty);

    const order = shuffle(tier.patterns.slice(), rnd);
    for (let attempt = 0; attempt < order.length * 3; attempt++) {
      const pattern = PATTERNS[order[attempt % order.length]];
      const built = buildSlots(pattern);
      if (!built) continue;
      const solution = fill(built.slots, rnd, 40000, tier, bank.freq);
      if (!solution) continue;

      const grid = [];
      for (let r = 0; r < SIZE; r++) {
        grid[r] = [];
        for (let c = 0; c < SIZE; c++) grid[r][c] = built.black[r][c] ? null : '';
      }
      built.slots.forEach(function (slot, si) {
        const word = solution[si];
        slot.cells.forEach(function (cell, pos) { grid[cell.r][cell.c] = word[pos]; });
      });

      const entries = built.slots.map(function (slot, si) {
        const word = solution[si];
        const options = CLUES()[word];
        return {
          id: slot.id,
          num: slot.num,
          dir: slot.dir,
          answer: word,
          clue: options[Math.floor(rnd() * options.length)],
          cells: slot.cells
        };
      });
      entries.sort(function (a, b) {
        if (a.dir !== b.dir) return a.dir === 'across' ? -1 : 1;
        return a.num - b.num;
      });

      return {
        seed: actualSeed,
        difficulty: difficulty,
        size: SIZE,
        solution: grid,
        black: built.black,
        numbers: built.numbers,
        entries: entries
      };
    }
    return null;
  }

  global.MiniGenerator = {
    generate: generate,
    makeBank: makeBank,
    addWord: addWord,
    ingest: ingest,
    builtin: BUILTIN,
    useBank: function (bank) {
      // Only accept a bank that can actually fill a grid at every length.
      if (!bank || [3, 4, 5].some(function (n) { return (bank.byLen[n] || []).length < 40; })) return false;
      active = bank;
      return true;
    },
    difficulties: Object.keys(DIFFICULTY),
    freqOf: function (word) {
      const f = active.freq[String(word).toUpperCase()];
      return f === undefined ? null : f;
    },
    stats: function (difficulty) {
      const b = difficulty ? tierFor(active, difficulty).byLen : BY_LEN();
      return { three: b[3].length, four: b[4].length, five: b[5].length,
               total: b[3].length + b[4].length + b[5].length };
    }
  };
})(window);

/* The Mini — share links and result cards.

   A share payload carries the whole puzzle (grid + clues), not just its seed,
   so the recipient plays exactly what the sender solved. See the note on
   MiniGenerator.fromGrid for why a seed alone is not reproducible.

   Payload rides in the URL *fragment*: it never reaches the server, so puzzle
   answers stay out of access logs and referrer headers. */
(function (global) {
  'use strict';

  const VERSION = 1;
  const PARAM = 'c';

  /* ---------------- base64url ---------------- */

  function toB64Url(str) {
    // btoa is latin1-only; clue text may contain non-ASCII.
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64Url(str) {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------------- encode / decode ---------------- */

  /* meta: { seconds, name, difficulty, label } */
  function encode(puzzle, meta) {
    if (!puzzle || !puzzle.solution) return null;
    const m = meta || {};
    const payload = {
      v: VERSION,
      s: puzzle.solution.map(function (row) {
        return row.map(function (ch) { return ch || '.'; }).join('');
      }),
      e: puzzle.entries.map(function (e) {
        return [e.num, e.dir.charAt(0), e.clue];
      }),
      d: puzzle.difficulty || m.difficulty || 'medium'
    };
    if (m.seconds != null) payload.t = Math.max(0, Math.round(m.seconds));
    if (m.name) payload.n = String(m.name).slice(0, 24);
    return toB64Url(JSON.stringify(payload));
  }

  function decode(code) {
    let data;
    try { data = JSON.parse(fromB64Url(code)); } catch (e) { return null; }
    if (!data || data.v !== VERSION || !Array.isArray(data.s)) return null;

    const puzzle = MiniGenerator.fromGrid(data.s, data.e, { difficulty: data.d });
    if (!puzzle) return null;

    return {
      puzzle: puzzle,
      difficulty: data.d || 'medium',
      challenge: (data.t != null)
        ? { name: data.n || 'A friend', seconds: Number(data.t) || 0 }
        : null
    };
  }

  /* ---------------- links ---------------- */

  function buildUrl(puzzle, meta) {
    const code = encode(puzzle, meta);
    if (!code) return null;
    const base = global.location.origin + global.location.pathname;
    return base + '#' + PARAM + '=' + code;
  }

  /* Returns the share code in the current URL, or null. */
  function readUrl() {
    const hash = String(global.location.hash || '').replace(/^#/, '');
    if (!hash) return null;
    const parts = hash.split('&');
    for (let i = 0; i < parts.length; i++) {
      const eq = parts[i].indexOf('=');
      if (eq === -1) continue;
      if (parts[i].slice(0, eq) === PARAM) return parts[i].slice(eq + 1);
    }
    return null;
  }

  function clearUrl() {
    try {
      global.history.replaceState(null, '', global.location.pathname + global.location.search);
    } catch (e) { /* non-fatal — the link just stays in the bar */ }
  }

  /* ---------------- result card ---------------- */

  function formatTime(total) {
    const m = Math.floor(total / 60);
    const s = Math.round(total) % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* A compact grid picture of how the solve went: filled-clean vs. helped.
     `marks` is the game's per-cell mark array; black squares render blank. */
  function emojiGrid(puzzle, marks) {
    return puzzle.solution.map(function (row, r) {
      return row.map(function (ch, c) {
        if (!ch) return '⬛';
        const mark = marks && marks[r] && marks[r][c];
        if (mark && mark.revealed) return '🟥';
        if (mark && mark.hinted) return '🟦';
        return '🟨';
      }).join('');
    }).join('\n');
  }

  /* The text a player pastes into a chat. Keeps the link on its own line so
     clients that auto-link do the right thing. */
  function resultText(opts) {
    const lines = [];
    lines.push('The Mini · ' + (opts.difficultyLabel || 'Medium') + ' · ' + formatTime(opts.seconds) +
      (opts.usedHelp ? ' *' : ''));
    if (opts.grid) { lines.push(''); lines.push(opts.grid); }
    if (opts.beat) { lines.push(''); lines.push(opts.beat); }
    if (opts.url) { lines.push(''); lines.push('Beat my time:'); lines.push(opts.url); }
    return lines.join('\n');
  }

  global.MiniShare = {
    encode: encode,
    decode: decode,
    buildUrl: buildUrl,
    readUrl: readUrl,
    clearUrl: clearUrl,
    emojiGrid: emojiGrid,
    resultText: resultText,
    formatTime: formatTime
  };
})(window);

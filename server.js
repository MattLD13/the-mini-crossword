/* The Mini — static file server + versus lobby API.
   No dependencies: node server.js  (default port 8123) */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./store.js');

const PORT = Number(process.env.PORT) || 8123;
const ROOT = __dirname;

const ROOM_TTL_MS = 3 * 60 * 60 * 1000;   // rooms live 3h
const PLAYER_TTL_MS = 45 * 1000;          // "connected" dot goes dark after this
// A player is only removed after a much longer silence, so a phone that loses
// signal in a tunnel can rejoin the race it was already in.
const PLAYER_DROP_MS = 5 * 60 * 1000;
// Must stay under the platform's function timeout (Vercel hobby is 10s), or
// the poll is killed mid-flight and the client sees an error instead of state.
const POLL_TIMEOUT_MS = 8 * 1000;
const COUNTDOWN_MS = 3000;

const LEADERBOARD_KEY = 'mini:leaderboard';
const MAX_SCORES = 1000;
// Nobody solves a 5x5 faster than this; anything under it is a forged payload.
const MIN_PLAUSIBLE_SECONDS = 8;
const SCORE_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png'
};

/* ------------------------------------------------------------------ rooms */

/* Local room cache. When a KV backend is configured the store is the source of
   truth and this map only carries `waiters` (open long-poll responses, which
   cannot be serialised and are meaningful only inside this instance). */
const rooms = new Map();
const ROOM_PREFIX = 'mini:room:';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

async function makeCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!(await loadRoom(code))) return code;
  }
  throw new Error('Could not allocate a lobby code');
}

/* ---------- room persistence ---------- */

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    difficulty: room.difficulty,
    puzzle: room.puzzle,
    version: room.version,
    startAt: room.startAt,
    finished: room.finished,
    finishers: room.finishers,
    touched: room.touched,
    players: Array.from(room.players.values())
  };
}

function deserializeRoom(data) {
  const room = Object.assign({}, data);
  room.players = new Map();
  (data.players || []).forEach(function (p) { room.players.set(p.id, p); });
  room.waiters = [];
  return room;
}

async function loadRoom(code) {
  const key = String(code || '').toUpperCase();
  if (!key) return null;
  if (store.backend === 'memory') return rooms.get(key) || null;

  const data = await store.get(ROOM_PREFIX + key);
  if (!data) { rooms.delete(key); return null; }

  const room = deserializeRoom(data);
  const local = rooms.get(key);
  room.waiters = local ? local.waiters : [];   // keep this instance's pollers
  rooms.set(key, room);
  return room;
}

async function saveRoom(room) {
  rooms.set(room.code, room);
  if (store.backend === 'memory') return;
  await store.set(ROOM_PREFIX + room.code, serializeRoom(room), ROOM_TTL_MS / 1000);
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function publicState(room) {
  const players = [];
  room.players.forEach(function (p) {
    players.push({
      id: p.id,
      name: p.name,
      progress: p.progress,
      solved: p.solved,
      finishSeconds: p.finishSeconds,
      place: p.place,
      isHost: p.id === room.hostId,
      connected: Date.now() - p.lastSeen < PLAYER_TTL_MS
    });
  });
  players.sort(function (a, b) {
    if (a.place && b.place) return a.place - b.place;
    if (a.place) return -1;
    if (b.place) return 1;
    return b.progress - a.progress;
  });
  return {
    code: room.code,
    version: room.version,
    difficulty: room.difficulty,
    hostId: room.hostId,
    startAt: room.startAt,
    serverNow: Date.now(),
    finished: room.finished,
    players: players
  };
}

/* Releases this instance's long-pollers immediately, then persists. Callers in
   request handlers should await it so the write lands before they reply. */
function bump(room) {
  room.version++;
  room.touched = Date.now();
  const waiting = room.waiters.splice(0, room.waiters.length);
  waiting.forEach(function (w) {
    clearTimeout(w.timer);
    sendJSON(w.res, 200, publicState(room));
  });
  return saveRoom(room);
}

function reap() {
  const now = Date.now();
  rooms.forEach(function (room, code) {
    if (now - room.touched > ROOM_TTL_MS) {
      room.waiters.forEach(function (w) { clearTimeout(w.timer); try { w.res.end(); } catch (e) {} });
      rooms.delete(code);
      return;
    }
    let changed = false;
    room.players.forEach(function (p, id) {
      // Drop a silent player unless they already finished. The window is
      // generous on purpose: a dropped phone should be able to rejoin the race
      // it was already running, not find itself evicted.
      if (!p.solved && now - p.lastSeen > PLAYER_DROP_MS) {
        room.players.delete(id);
        changed = true;
      }
    });
    if (changed && room.players.size > 0) {
      if (!room.players.has(room.hostId)) room.hostId = room.players.keys().next().value;
      Promise.resolve(bump(room)).catch(function () {});
    }
    if (room.players.size === 0 && now - room.touched > 60 * 1000) rooms.delete(code);
  });
}
setInterval(reap, 15 * 1000).unref();

/* ------------------------------------------------------------------ http */

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (chunk) {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', function () {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function cleanName(raw, fallback) {
  const name = String(raw || '').replace(/[<>]/g, '').trim().slice(0, 16);
  return name || fallback;
}

/* -------------------------------------------------------- score integrity

   /api/submit-score used to accept whatever the client sent, so a one-line
   curl could claim a 1-second solve and take the top of the board. There is
   no server-side ground truth for a client-generated puzzle, so we cannot
   verify the *answers*. What we can verify is that time actually passed:

     1. The client asks for a token when a puzzle starts.
     2. The token is HMAC-signed and carries its issue time.
     3. On submit, the claimed solve time must fit inside the wall-clock
        window since the token was issued.

   Forging a fast time therefore means waiting out the real duration first,
   which removes the trivial attack. It is a bar, not a proof — a determined
   client can still idle and then submit. Genuine anti-cheat needs the server
   to own puzzle generation and validate the filled grid. */

let scoreSecret = process.env.MINI_SCORE_SECRET || null;

async function getScoreSecret() {
  if (scoreSecret) return scoreSecret;
  // Persist a generated secret, otherwise every serverless instance would
  // sign with a different key and reject each other's tokens.
  const stored = await store.get('mini:score-secret');
  if (stored && stored.secret) { scoreSecret = stored.secret; return scoreSecret; }
  scoreSecret = crypto.randomBytes(32).toString('hex');
  await store.set('mini:score-secret', { secret: scoreSecret });
  return scoreSecret;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

async function issueScoreToken(difficulty) {
  const secret = await getScoreSecret();
  const body = [Date.now(), String(difficulty || 'medium'), crypto.randomBytes(6).toString('hex')].join('.');
  return body + '.' + sign(body, secret);
}

async function verifyScoreToken(token, difficulty, claimedSeconds) {
  if (!token || typeof token !== 'string') return 'A score token is required';
  const parts = token.split('.');
  if (parts.length !== 4) return 'Malformed score token';

  const body = parts.slice(0, 3).join('.');
  const secret = await getScoreSecret();
  const expected = sign(body, secret);
  const got = parts[3];
  // Constant-time compare; timingSafeEqual throws on a length mismatch.
  if (got.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return 'Invalid score token';
  }

  const issuedAt = Number(parts[0]);
  if (!issuedAt) return 'Malformed score token';
  const elapsedMs = Date.now() - issuedAt;
  if (elapsedMs < 0 || elapsedMs > SCORE_TOKEN_TTL_MS) return 'Score token expired';
  if (parts[1] !== String(difficulty)) return 'Score token is for a different difficulty';

  if (claimedSeconds < MIN_PLAUSIBLE_SECONDS) return 'Implausible solve time';
  // 2s of slack absorbs clock skew and the request's own latency.
  if (claimedSeconds * 1000 > elapsedMs + 2000) {
    return 'Claimed time exceeds elapsed time';
  }
  return null;                                   // valid
}

async function getRoom(res, code) {
  const room = await loadRoom(code);
  if (!room) { sendJSON(res, 404, { error: 'Lobby not found' }); return null; }
  return room;
}

const api = {
  'POST /api/create': async function (req, res) {
    const body = await readBody(req);
    if (!body.puzzle || !Array.isArray(body.puzzle.solution)) {
      return sendJSON(res, 400, { error: 'A puzzle is required' });
    }
    const code = await makeCode();
    const id = makeId();
    const room = {
      code: code,
      hostId: id,
      difficulty: String(body.difficulty || 'medium'),
      puzzle: body.puzzle,
      players: new Map(),
      version: 1,
      startAt: null,
      finished: false,
      finishers: 0,
      waiters: [],
      touched: Date.now()
    };
    room.players.set(id, {
      id: id, name: cleanName(body.name, 'Host'), progress: 0,
      solved: false, finishSeconds: null, place: null, lastSeen: Date.now()
    });
    await saveRoom(room);
    sendJSON(res, 200, { code: code, playerId: id, state: publicState(room) });
  },

  'POST /api/join': async function (req, res) {
    const body = await readBody(req);
    const room = await getRoom(res, body.code);
    if (!room) return;
    if (room.players.size >= 12) return sendJSON(res, 403, { error: 'Lobby is full' });
    if (room.startAt) return sendJSON(res, 403, { error: 'That race has already started' });
    const id = makeId();
    room.players.set(id, {
      id: id, name: cleanName(body.name, 'Player ' + (room.players.size + 1)), progress: 0,
      solved: false, finishSeconds: null, place: null, lastSeen: Date.now()
    });
    await bump(room);
    sendJSON(res, 200, {
      code: room.code, playerId: id, puzzle: room.puzzle,
      difficulty: room.difficulty, state: publicState(room)
    });
  },

  'POST /api/start': async function (req, res) {
    const body = await readBody(req);
    const room = await getRoom(res, body.code);
    if (!room) return;
    if (body.playerId !== room.hostId) return sendJSON(res, 403, { error: 'Only the host can start' });
    if (room.startAt) return sendJSON(res, 200, { ok: true, state: publicState(room) });
    room.startAt = Date.now() + COUNTDOWN_MS;
    await bump(room);
    sendJSON(res, 200, { ok: true, state: publicState(room) });
  },

  'POST /api/progress': async function (req, res) {
    const body = await readBody(req);
    const room = await getRoom(res, body.code);
    if (!room) return;
    const player = room.players.get(body.playerId);
    if (!player) return sendJSON(res, 404, { error: 'You are not in this lobby' });

    player.lastSeen = Date.now();
    const progress = Math.max(0, Math.min(1, Number(body.progress) || 0));
    let changed = Math.abs(progress - player.progress) > 0.001;
    player.progress = progress;

    if (body.solved && !player.solved) {
      player.solved = true;
      player.finishSeconds = Math.max(0, Math.round(Number(body.seconds) || 0));
      player.place = ++room.finishers;
      player.progress = 1;
      if (player.place === 1) room.finished = true;
      changed = true;
    }
    if (changed) await bump(room);
    else await saveRoom(room);                 // still records lastSeen
    sendJSON(res, 200, { ok: true, version: room.version });
  },

  'GET /api/state': async function (req, res, query) {
    const room = await getRoom(res, query.get('code'));
    if (!room) return;
    const playerId = query.get('playerId');
    const player = room.players.get(playerId);
    if (player) player.lastSeen = Date.now();
    room.touched = Date.now();

    const since = Number(query.get('since')) || 0;
    if (room.version > since) {
      if (player) await saveRoom(room);
      return sendJSON(res, 200, publicState(room));
    }
    if (player) await saveRoom(room);

    // Across serverless instances a held connection cannot see another
    // instance's write, so the timeout below doubles as a short-poll tick:
    // the client re-requests and picks up whatever landed in the store.

    // Long-poll: hold the request until something changes.
    const waiter = {
      res: res,
      timer: setTimeout(function () {
        const i = room.waiters.indexOf(waiter);
        if (i !== -1) room.waiters.splice(i, 1);
        sendJSON(res, 200, publicState(room));
      }, POLL_TIMEOUT_MS)
    };
    room.waiters.push(waiter);
    res.on('close', function () {
      const i = room.waiters.indexOf(waiter);
      if (i !== -1) { clearTimeout(waiter.timer); room.waiters.splice(i, 1); }
    });
  },

  'GET /api/puzzle': async function (req, res, query) {
    const room = await getRoom(res, query.get('code'));
    if (!room) return;
    sendJSON(res, 200, { puzzle: room.puzzle, difficulty: room.difficulty });
  },

  'POST /api/leave': async function (req, res) {
    const body = await readBody(req);
    const room = await getRoom(res, body.code);
    if (!room) return;
    if (room.players.delete(body.playerId)) {
      if (!room.players.has(room.hostId) && room.players.size) {
        room.hostId = room.players.keys().next().value;
      }
      await bump(room);
    }
    sendJSON(res, 200, { ok: true });
  },

  'POST /api/rematch': async function (req, res) {
    const body = await readBody(req);
    const room = await getRoom(res, body.code);
    if (!room) return;
    if (!body.puzzle || !Array.isArray(body.puzzle.solution)) {
      return sendJSON(res, 400, { error: 'A new puzzle is required for rematch' });
    }
    room.puzzle = body.puzzle;
    if (body.difficulty) room.difficulty = String(body.difficulty);
    room.startAt = null;
    room.finished = false;
    room.finishers = 0;
    room.players.forEach(function (p) {
      p.progress = 0;
      p.solved = false;
      p.finishSeconds = null;
      p.place = null;
      p.lastSeen = Date.now();
    });
    await bump(room);
    sendJSON(res, 200, { ok: true, state: publicState(room) });
  },

  /* Handed out when a puzzle starts; spent by /api/submit-score. */
  'GET /api/score-token': async function (req, res, query) {
    const difficulty = String(query.get('difficulty') || 'medium');
    sendJSON(res, 200, { token: await issueScoreToken(difficulty), difficulty: difficulty });
  },

  'POST /api/submit-score': async function (req, res) {
    const body = await readBody(req);
    if (!body.name || !body.difficulty) {
      return sendJSON(res, 400, { error: 'Invalid score payload' });
    }

    const seconds = Math.max(0, Math.round(Number(body.seconds) || 0));
    const difficulty = String(body.difficulty || 'medium');

    const problem = await verifyScoreToken(body.token, difficulty, seconds);
    if (problem) return sendJSON(res, 403, { error: problem });

    const entry = {
      name: cleanName(body.name, 'Player'),
      streak: Math.max(0, Number(body.streak) || 0),
      bestStreak: Math.max(0, Number(body.bestStreak) || 0),
      seconds: seconds,
      difficulty: difficulty,
      date: String(body.date || new Date().toISOString().split('T')[0]),
      timestamp: Date.now()
    };

    await store.update(LEADERBOARD_KEY, function (current) {
      const list = Array.isArray(current) ? current : [];
      list.push(entry);
      return list.length > MAX_SCORES ? list.slice(list.length - MAX_SCORES) : list;
    });
    sendJSON(res, 200, { ok: true });
  },

  'GET /api/leaderboard': async function (req, res, query) {
    const period = query.get('period') || 'daily';
    const difficulty = query.get('difficulty') || 'medium';
    const stored = await store.get(LEADERBOARD_KEY);
    const list = getSyncedLeaderboard(Array.isArray(stored) ? stored : [], period, difficulty);
    sendJSON(res, 200, { leaderboard: list, persistence: store.backend });
  }
};

function getSyncedLeaderboard(scores, period, difficulty) {
  const today = new Date().toISOString().split('T')[0];
  const isDaily = period === 'daily';

  let filtered = scores.filter(function (item) {
    const matchDiff = !item.difficulty || item.difficulty === difficulty;
    if (!matchDiff) return false;
    if (isDaily) return item.date === today;
    return true;
  });

  const playerMap = new Map();
  filtered.forEach(function (item) {
    const existing = playerMap.get(item.name);
    if (!existing) {
      playerMap.set(item.name, item);
    } else {
      const streakCurrent = isDaily ? item.streak : item.bestStreak;
      const streakExisting = isDaily ? existing.streak : existing.bestStreak;
      const scoreCurrent = (item.seconds < 9999 ? (10000 - item.seconds) : 0) + (streakCurrent * 250);
      const scoreExisting = (existing.seconds < 9999 ? (10000 - existing.seconds) : 0) + (streakExisting * 250);
      if (scoreCurrent > scoreExisting) {
        playerMap.set(item.name, item);
      }
    }
  });

  const list = Array.from(playerMap.values());
  list.sort(function (a, b) {
    const streakA = isDaily ? a.streak : a.bestStreak;
    const streakB = isDaily ? b.streak : b.bestStreak;
    const scoreA = (a.seconds < 9999 ? (10000 - a.seconds) : 0) + (streakA * 250);
    const scoreB = (b.seconds < 9999 ? (10000 - b.seconds) : 0) + (streakB * 250);
    if (scoreA !== scoreB) return scoreB - scoreA;
    if (a.seconds !== b.seconds) return a.seconds - b.seconds;
    return streakB - streakA;
  });

  return list;
}

/* ------------------------------------------------------------- static */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, rel);
  // Refuse anything that escapes the app directory.
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const route = req.method + ' ' + parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const handler = api[route];
  if (handler) {
    Promise.resolve()
      .then(function () { return handler(req, res, parsed.searchParams); })
      .catch(function (err) {
        if (!res.headersSent) sendJSON(res, 400, { error: String(err.message || err) });
      });
    return;
  }

  if (parsed.pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Unknown endpoint' });
  serveStatic(req, res, parsed.pathname);
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', function () {
    const nets = os.networkInterfaces();
    const lan = [];
    Object.keys(nets).forEach(function (name) {
      (nets[name] || []).forEach(function (net) {
        if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
      });
    });
    console.log('The Mini is running:');
    console.log('  storage   ' + store.describe());
    console.log('  local     http://localhost:' + PORT);
    lan.forEach(function (ip) { console.log('  this LAN  http://' + ip + ':' + PORT); });
    console.log('Share a LAN address so others can join your versus lobby.');
  });
}

module.exports = server;

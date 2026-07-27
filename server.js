/* The Mini — static file server + versus lobby API.
   No dependencies: node server.js  (default port 8123) */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8123;
const ROOT = __dirname;

const ROOM_TTL_MS = 3 * 60 * 60 * 1000;   // rooms live 3h
const PLAYER_TTL_MS = 45 * 1000;          // drop players that stop polling
const POLL_TIMEOUT_MS = 25 * 1000;
const COUNTDOWN_MS = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* ------------------------------------------------------------------ rooms */

const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
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

function bump(room) {
  room.version++;
  room.touched = Date.now();
  const waiting = room.waiters.splice(0, room.waiters.length);
  waiting.forEach(function (w) {
    clearTimeout(w.timer);
    sendJSON(w.res, 200, publicState(room));
  });
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
      // Drop a silent player unless they already finished.
      if (!p.solved && now - p.lastSeen > PLAYER_TTL_MS * 3) {
        room.players.delete(id);
        changed = true;
      }
    });
    if (changed && room.players.size > 0) {
      if (!room.players.has(room.hostId)) room.hostId = room.players.keys().next().value;
      bump(room);
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

function getRoom(res, code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) { sendJSON(res, 404, { error: 'Lobby not found' }); return null; }
  return room;
}

const api = {
  'POST /api/create': async function (req, res) {
    const body = await readBody(req);
    if (!body.puzzle || !Array.isArray(body.puzzle.solution)) {
      return sendJSON(res, 400, { error: 'A puzzle is required' });
    }
    const code = makeCode();
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
    rooms.set(code, room);
    sendJSON(res, 200, { code: code, playerId: id, state: publicState(room) });
  },

  'POST /api/join': async function (req, res) {
    const body = await readBody(req);
    const room = getRoom(res, body.code);
    if (!room) return;
    if (room.players.size >= 12) return sendJSON(res, 403, { error: 'Lobby is full' });
    if (room.startAt) return sendJSON(res, 403, { error: 'That race has already started' });
    const id = makeId();
    room.players.set(id, {
      id: id, name: cleanName(body.name, 'Player ' + (room.players.size + 1)), progress: 0,
      solved: false, finishSeconds: null, place: null, lastSeen: Date.now()
    });
    bump(room);
    sendJSON(res, 200, {
      code: room.code, playerId: id, puzzle: room.puzzle,
      difficulty: room.difficulty, state: publicState(room)
    });
  },

  'POST /api/start': async function (req, res) {
    const body = await readBody(req);
    const room = getRoom(res, body.code);
    if (!room) return;
    if (body.playerId !== room.hostId) return sendJSON(res, 403, { error: 'Only the host can start' });
    if (room.startAt) return sendJSON(res, 200, { ok: true, state: publicState(room) });
    room.startAt = Date.now() + COUNTDOWN_MS;
    bump(room);
    sendJSON(res, 200, { ok: true, state: publicState(room) });
  },

  'POST /api/progress': async function (req, res) {
    const body = await readBody(req);
    const room = getRoom(res, body.code);
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
    if (changed) bump(room);
    sendJSON(res, 200, { ok: true, version: room.version });
  },

  'GET /api/state': function (req, res, query) {
    const room = getRoom(res, query.get('code'));
    if (!room) return;
    const playerId = query.get('playerId');
    const player = room.players.get(playerId);
    if (player) player.lastSeen = Date.now();
    room.touched = Date.now();

    const since = Number(query.get('since')) || 0;
    if (room.version > since) return sendJSON(res, 200, publicState(room));

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

  'GET /api/puzzle': function (req, res, query) {
    const room = getRoom(res, query.get('code'));
    if (!room) return;
    sendJSON(res, 200, { puzzle: room.puzzle, difficulty: room.difficulty });
  },

  'POST /api/leave': async function (req, res) {
    const body = await readBody(req);
    const room = getRoom(res, body.code);
    if (!room) return;
    if (room.players.delete(body.playerId)) {
      if (!room.players.has(room.hostId) && room.players.size) {
        room.hostId = room.players.keys().next().value;
      }
      bump(room);
    }
    sendJSON(res, 200, { ok: true });
  }
};

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
    console.log('  local     http://localhost:' + PORT);
    lan.forEach(function (ip) { console.log('  this LAN  http://' + ip + ':' + PORT); });
    console.log('Share a LAN address so others can join your versus lobby.');
  });
}

module.exports = server;

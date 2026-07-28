/* The Mini — persistence.

   The server previously kept rooms and scores in plain module-level variables.
   That loses everything on restart when self-hosted, and on Vercel it is worse:
   api/[...slug].js mounts this server as a serverless function, so each
   invocation may hit a fresh instance with its own empty memory. Scores were
   effectively never stored at all in production.

   Three backends, chosen automatically:
     redis   — Upstash / Vercel KV over REST (no client library needed)
     file    — a JSON file on disk, for self-hosting
     memory  — last resort; logs a warning so the limitation is visible

   The interface is deliberately tiny: a JSON value per key, read-modify-write.
   Volumes here are small (a capped score list, a handful of live rooms), so
   nothing needs a smarter data model yet. */
'use strict';

const fs = require('fs');
const path = require('path');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

// Vercel's filesystem is read-only apart from /tmp, and /tmp does not survive
// between invocations — so a file backend there would be a silent memory
// backend. Only use it when we are clearly not serverless.
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = process.env.MINI_DATA_DIR || path.join(__dirname, '.data');

let backend = 'memory';
if (REDIS_URL && REDIS_TOKEN) backend = 'redis';
else if (!IS_SERVERLESS) backend = 'file';

/* ---------------------------------------------------------------- memory */

const mem = new Map();

/* ------------------------------------------------------------------ file */

function filePath(key) {
  return path.join(DATA_DIR, String(key).replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');
}

function fileGet(key) {
  try {
    return JSON.parse(fs.readFileSync(filePath(key), 'utf8'));
  } catch (e) {
    return null;                                  // missing or corrupt — treat as empty
  }
}

function fileSet(key, value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the live file.
    const tmp = filePath(key) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, filePath(key));
    return true;
  } catch (e) {
    console.error('[store] file write failed for ' + key + ':', e.message);
    return false;
  }
}

/* ----------------------------------------------------------------- redis */

async function redisCmd(args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error('redis ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const body = await res.json();
  return body.result;
}

async function redisGet(key) {
  const raw = await redisCmd(['GET', key]);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function redisSet(key, value, ttlSeconds) {
  const args = ['SET', key, JSON.stringify(value)];
  if (ttlSeconds) { args.push('EX', String(Math.ceil(ttlSeconds))); }
  await redisCmd(args);
  return true;
}

/* -------------------------------------------------------------- public */

async function get(key) {
  if (backend === 'redis') {
    try { return await redisGet(key); }
    catch (e) {
      console.error('[store] redis GET failed, serving empty:', e.message);
      return null;
    }
  }
  if (backend === 'file') return fileGet(key);
  return mem.has(key) ? mem.get(key) : null;
}

async function set(key, value, ttlSeconds) {
  if (backend === 'redis') {
    try { return await redisSet(key, value, ttlSeconds); }
    catch (e) {
      console.error('[store] redis SET failed, value dropped:', e.message);
      return false;
    }
  }
  if (backend === 'file') return fileSet(key, value);
  mem.set(key, value);
  return true;
}

/* Read-modify-write. Not atomic across concurrent writers; acceptable for the
   volumes here, and the alternative (Lua scripts / WATCH) is not worth the
   complexity until this sees real contention. */
async function update(key, fn, ttlSeconds) {
  const current = await get(key);
  const next = fn(current);
  await set(key, next, ttlSeconds);
  return next;
}

function describe() {
  if (backend === 'redis') return 'redis (Upstash/Vercel KV)';
  if (backend === 'file') return 'file (' + DATA_DIR + ')';
  return 'memory (NOT PERSISTED)';
}

if (backend === 'memory') {
  console.warn(
    '[store] No KV credentials and running serverless — scores and rooms will\n' +
    '        NOT persist between requests. Set KV_REST_API_URL and\n' +
    '        KV_REST_API_TOKEN (Vercel KV) or UPSTASH_REDIS_REST_URL and\n' +
    '        UPSTASH_REDIS_REST_TOKEN to enable persistence.'
  );
}

module.exports = { get, set, update, backend, describe };

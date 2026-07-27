/* Versus mode — lobby creation/joining and the live race loop. */
(function (global) {
  'use strict';

  const NAME_KEY = 'mini-player-name';

  const state = {
    active: false,
    code: null,
    playerId: null,
    hostId: null,
    difficulty: 'medium',
    players: [],
    startAt: null,       // server clock
    clockSkew: 0,        // serverNow - clientNow
    version: 0,
    finished: false,
    polling: false,
    started: false
  };

  let listeners = [];
  // A failing view must never break the lobby state machine.
  function emit() {
    listeners.forEach(function (fn) {
      try { fn(state); } catch (err) { console.error('Versus listener failed:', err); }
    });
  }

  function api(path, options) {
    return fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, options)).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : 'Request failed');
        return body;
      });
    });
  }

  function applyState(next) {
    if (!next) return;
    state.version = next.version;
    state.players = next.players || [];
    state.hostId = next.hostId;
    state.difficulty = next.difficulty || state.difficulty;
    state.finished = !!next.finished;
    state.startAt = next.startAt;
    if (typeof next.serverNow === 'number') state.clockSkew = next.serverNow - Date.now();
    if (next.startAt && !state.started && localNow() >= next.startAt) state.started = true;
    emit();
  }

  function localNow() { return Date.now() + state.clockSkew; }

  /* Milliseconds until the race begins; <= 0 means it is under way. */
  function countdownMs() {
    if (!state.startAt) return null;
    return state.startAt - localNow();
  }

  function poll() {
    if (!state.active || state.polling) return;
    state.polling = true;
    api('/api/state?code=' + state.code + '&playerId=' + state.playerId + '&since=' + state.version)
      .then(function (next) {
        state.polling = false;
        if (!state.active) return;
        applyState(next);
        poll();
      })
      .catch(function () {
        state.polling = false;
        if (state.active) setTimeout(poll, 2000);
      });
  }

  function watchStart() {
    // The countdown ends on a clock, not on a server message.
    setInterval(function () {
      if (!state.active || state.started || !state.startAt) return;
      if (countdownMs() <= 0) { state.started = true; emit(); }
      else emit();
    }, 200);
  }

  const Versus = {
    state: state,
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    countdownMs: countdownMs,

    savedName: function () {
      try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
    },
    rememberName: function (name) {
      try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
    },

    isHost: function () { return state.playerId && state.playerId === state.hostId; },
    me: function () {
      return state.players.find(function (p) { return p.id === state.playerId; }) || null;
    },

    create: function (name, difficulty, puzzle) {
      return api('/api/create', {
        method: 'POST',
        body: JSON.stringify({ name: name, difficulty: difficulty, puzzle: puzzle })
      }).then(function (res) {
        state.active = true;
        state.code = res.code;
        state.playerId = res.playerId;
        state.difficulty = difficulty;
        state.started = false;
        state.version = 0;
        applyState(res.state);
        poll();
        return res;
      });
    },

    join: function (code, name) {
      return api('/api/join', {
        method: 'POST',
        body: JSON.stringify({ code: String(code || '').toUpperCase().trim(), name: name })
      }).then(function (res) {
        state.active = true;
        state.code = res.code;
        state.playerId = res.playerId;
        state.difficulty = res.difficulty;
        state.started = false;
        state.version = 0;
        applyState(res.state);
        poll();
        return res;   // includes the puzzle
      });
    },

    start: function () {
      return api('/api/start', {
        method: 'POST',
        body: JSON.stringify({ code: state.code, playerId: state.playerId })
      }).then(function (res) { applyState(res.state); });
    },

    sendProgress: function (progress, solved, seconds) {
      if (!state.active) return Promise.resolve();
      return api('/api/progress', {
        method: 'POST',
        body: JSON.stringify({
          code: state.code, playerId: state.playerId,
          progress: progress, solved: !!solved, seconds: seconds
        })
      }).catch(function () { /* a dropped update is corrected by the next one */ });
    },

    leave: function () {
      const code = state.code, playerId = state.playerId;
      state.active = false;
      state.code = null;
      state.playerId = null;
      state.players = [];
      state.startAt = null;
      state.started = false;
      state.finished = false;
      emit();
      if (code) {
        api('/api/leave', { method: 'POST', body: JSON.stringify({ code: code, playerId: playerId }) })
          .catch(function () {});
      }
    },

    rematch: function (puzzle, difficulty) {
      if (!state.active) return Promise.resolve();
      return api('/api/rematch', {
        method: 'POST',
        body: JSON.stringify({ code: state.code, playerId: state.playerId, puzzle: puzzle, difficulty: difficulty || state.difficulty })
      }).then(function (res) {
        state.started = false;
        applyState(res.state);
        return res;
      });
    }
  };

  watchStart();
  global.Versus = Versus;
})(window);

/* Rooftop Rumble rollback netcode.
   Transport-agnostic: give it send(msg) and call receive(msg) for incoming messages.
   Both peers run the same deterministic sim (sim.js) and exchange only inputs.
   Remote inputs are predicted (last known input, buttons released); when the real input differs,
   the engine restores a snapshot and replays the ticks. A state hash is exchanged every 60 ticks;
   if it differs, the host (player 0) sends its snapshot and the guest adopts it. */
(function (root) {
'use strict';

var EDGE = 2 | 4 | 8 | 16;       // light, heavy, grab, dodge are one-tick presses and are never predicted
function enc(i) {
  var mx = Math.round(i.mx * 64) + 64, mz = Math.round(i.mz * 64) + 64;
  return (mx << 13) | (mz << 5) | (i.block ? 1 : 0) | (i.light ? 2 : 0) | (i.heavy ? 4 : 0) | (i.grab ? 8 : 0) | (i.dodge ? 16 : 0);
}
function dec(n) {
  return { mx: (((n >> 13) & 255) - 64) / 64, mz: (((n >> 5) & 255) - 64) / 64, block: !!(n & 1), light: !!(n & 2), heavy: !!(n & 4), grab: !!(n & 8), dodge: !!(n & 16) };
}

function create(o) {
  var Sim = o.Sim, me = o.local, isHost = me === 0;
  var delay = o.delay == null ? 2 : o.delay, maxAhead = o.maxAhead || 8, send = o.send, onEvents = o.onEvents || function () {};
  var S = Sim.newMatch(), cur = 0;
  var localIn = {}, remoteIn = {}, used = {}, usedPred = {}, snaps = {}, ownHash = {}, peerHash = {}, played = {}, playedQ = [];
  var BL = enc(Sim.BLANK), i;
  for (i = 0; i < delay; i++) { localIn[i] = BL; remoteIn[i] = BL; }
  var hist0 = BL;
  var remoteContig = delay - 1, remoteMax = delay - 1, peerAck = delay - 1, pendingRB = null, lastHashT = -60;
  var hist = [], stats = { rollbacks: 0, stalls: 0, maxDepth: 0, resyncs: 0, mispredicts: 0 };

  function flush() {
    if (!S.ev.length) return;
    var fresh = [];
    for (var j = 0; j < S.ev.length; j++) {
      var e = S.ev[j], key = e.tick + ':' + e.k + ':' + (e.d == null ? '' : e.d);
      if (!played[key]) { played[key] = 1; playedQ.push([e.tick, key]); fresh.push(e); }
    }
    S.ev = [];
    if (fresh.length) onEvents(fresh);
  }
  function predicted() { return remoteIn[remoteMax] & ~EDGE; }
  function stepTick(t) {
    var a = localIn[t], b = remoteIn[t], pred = false;
    if (b === undefined) { b = predicted(); pred = true; }
    used[t] = b; usedPred[t] = pred;
    snaps[t] = Sim.clone(S);
    var A = dec(me === 0 ? a : b), B = dec(me === 0 ? b : a);
    Sim.step(S, A, B);
    flush();
  }
  function doRollback() {
    var t0 = pendingRB; pendingRB = null;
    if (t0 === null || t0 >= cur || !snaps[t0]) return;
    stats.rollbacks++; stats.maxDepth = Math.max(stats.maxDepth, cur - t0);
    S = Sim.clone(snaps[t0]);
    for (var t = t0; t < cur; t++) stepTick(t);
  }
  function sendPacket() {
    var to = cur + delay - 1; if (localIn[cur + delay] !== undefined) to = cur + delay;
    var from = Math.max(peerAck + 1, to - 19), ins = [];
    for (var t = from; t <= to; t++) ins.push(localIn[t]);
    send({ t: 'in', from: from, ins: ins, ack: remoteContig });
  }
  function checkHashes() {
    var c = remoteContig + 1;
    for (var T = lastHashT + 60; T <= c && T < cur; T += 60) {
      if (!snaps[T]) { lastHashT = T; continue; }
      var h = Sim.hash(snaps[T]); ownHash[T] = h; lastHashT = T;
      send({ t: 'hash', tick: T, h: h });
      if (peerHash[T] !== undefined && peerHash[T] !== h) onMismatch(T);
    }
  }
  function onMismatch(T) {
    if (isHost && snaps[T]) send({ t: 'sync', tick: T, state: Sim.clone(snaps[T]) });
  }
  function prune() {
    var lim = cur - 160;
    [localIn, remoteIn, used, usedPred, snaps].forEach(function (m) { for (var k in m) if (+k < lim) delete m[k]; });
    for (var k2 in peerHash) if (+k2 < lim) delete peerHash[k2];
    while (playedQ.length && playedQ[0][0] < lim) delete played[playedQ.shift()[1]];
  }

  return {
    receive: function (m) {
      if (m.t === 'in') {
        for (var j = 0; j < m.ins.length; j++) {
          var k = m.from + j, v = m.ins[j];
          if (remoteIn[k] !== undefined || k < cur - 160) continue;
          remoteIn[k] = v; if (k > remoteMax) remoteMax = k;
          if (k < cur && usedPred[k]) {
            usedPred[k] = false;
            if (used[k] !== v) { stats.mispredicts++; pendingRB = pendingRB === null ? k : Math.min(pendingRB, k); }
          }
        }
        while (remoteIn[remoteContig + 1] !== undefined) remoteContig++;
        if (m.ack > peerAck) peerAck = m.ack;
      } else if (m.t === 'hash') {
        peerHash[m.tick] = m.h;
        if (ownHash[m.tick] !== undefined && ownHash[m.tick] !== m.h) onMismatch(m.tick);
      } else if (m.t === 'sync' && !isHost) {
        if (m.tick < cur) {
          stats.resyncs++; snaps[m.tick] = m.state; ownHash[m.tick] = Sim.hash(m.state);
          pendingRB = pendingRB === null ? m.tick : Math.min(pendingRB, m.tick);
        }
      }
    },
    /* call once per 60 Hz tick with the local player's input; returns false if it had to wait for the peer */
    advance: function (L) {
      doRollback();
      checkHashes();
      if (cur - (remoteContig + 1) > maxAhead) { stats.stalls++; sendPacket(); return false; }
      localIn[cur + delay] = enc(Sim.quantInput(L)); hist[cur + delay] = localIn[cur + delay];
      stepTick(cur); cur++;
      if (cur % 60 === 0) prune();
      sendPacket();
      return true;
    },
    state: function () { return S; },
    tick: function () { return cur; },
    stats: stats,
    lag: function () { return cur - remoteMax; },
    _debug: { hist: hist, blank: BL, ownHash: ownHash, corrupt: function (fn) { fn(S); for (var k in snaps) fn(snaps[k]); } }
  };
}

var API = { create: create, enc: enc, dec: dec };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.RRNet = API;
})(typeof window !== 'undefined' ? window : this);

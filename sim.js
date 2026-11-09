/* Rooftop Rumble deterministic simulation.
   Fixed 60 Hz tick, plain JSON-safe state, no randomness, no rendering. Runs in Node and the browser.
   step(S, in0, in1) advances one tick. Rollback netcode relies on clone() + step() being repeatable. */
(function (root) {
'use strict';

var TICK = 1 / 60;
var R_ARENA = 9.4, ROUND_TIME = 60, THROW_T = 0.85;
var MOVES = {
  light: { start: 0.09, active: 0.07, rec: 0.17, dmg: 6,  range: 1.75, stun: 0.45, kb: 3.2, cost: 5,  lunge: 3.2, guard: 8 },
  heavy: { start: 0.36, active: 0.09, rec: 0.45, dmg: 15, range: 2.0,  stun: 0.6,  kb: 8.5, cost: 16, lunge: 5.0, guard: 26 },
  grab:  { start: 0.16, active: 0.08, rec: 0.50, dmg: 0,  range: 1.45, stun: 0,    kb: 0,   cost: 0,  lunge: 3.0, guard: 0 }
};
var ACTS = ['light', 'heavy', 'grab', 'dodge'];
var BLANK = Object.freeze({ mx: 0, mz: 0, block: false, light: false, heavy: false, grab: false, dodge: false });

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }
function angDiff(a, b) { var d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function len(x, z) { return Math.sqrt(x * x + z * z); }
function q(v) { return Math.round(v * 1e6) / 1e6; }   // trims cross-engine float noise (sin/cos/atan2 differ in the last bits)

function quantInput(i) {
  return {
    mx: Math.round(clamp(i.mx || 0, -1, 1) * 64) / 64, mz: Math.round(clamp(i.mz || 0, -1, 1) * 64) / 64,
    block: !!i.block, light: !!i.light, heavy: !!i.heavy, grab: !!i.grab, dodge: !!i.dodge
  };
}

function newFighter(idx) {
  var x = idx === 0 ? -4 : 4;
  return {
    idx: idx, x: x, y: 0, z: 0, vx: 0, vz: 0, yaw: x < 0 ? Math.PI / 2 : -Math.PI / 2,
    hp: 100, stamina: 100, stDelay: 0, state: 'idle', t: 0, dur: 0, mv: '', hitDone: false, lunged: false,
    invuln: 0, blocking: false, combo: 0, comboN: 0, comboT: 0, buf: '', bufT: 0, dodgeCD: 0, punchSide: 1,
    flash: 0, flashCol: 0, ropeUsed: false, slammed: false, throwU: 0, win: false, ghostT: 0
  };
}

function ev(S, o) { o.tick = S.tick; S.ev.push(o); }

function startRound(S) {
  S.f[0] = newFighter(0); S.f[1] = newFighter(1);
  S.timer = ROUND_TIME; S.phase = 'intro'; S.pt = 0; S.fightShown = false; S.winner = -1; S.hitstop = 0;
  ev(S, { k: 'round', text: (S.wins[0] === 1 && S.wins[1] === 1) ? 'FINAL ROUND' : 'ROUND ' + S.round });
}
function newMatch() {
  var S = { tick: 0, f: [null, null], phase: 'intro', pt: 0, timer: ROUND_TIME, wins: [0, 0], round: 1, winner: -1, hitstop: 0, fightShown: false, ev: [] };
  startRound(S);
  return S;
}

/* ---------- fighter helpers ---------- */
function takeDamage(f, n) { f.hp = Math.max(0, f.hp - n); f.ghostT = 0.55; f.flash = 0.12; f.flashCol = 0xffffff; }
function toState(f, s, dur) { f.state = s; f.t = 0; f.dur = dur || 0; f.blocking = false; f.buf = ''; f.bufT = 0; f.ropeUsed = false; f.hitDone = false; }
function toIdle(f) { f.state = 'idle'; f.t = 0; f.combo = 0; f.mv = ''; }
function faceFoe(f, foe, rate) {
  var target = Math.atan2(foe.x - f.x, foe.z - f.z);
  f.yaw = q(f.yaw + clamp(angDiff(f.yaw, target), -rate * TICK, rate * TICK));
}
function pushBuf(f, inp) {
  for (var i = 0; i < ACTS.length; i++) if (inp[ACTS[i]]) { f.buf = ACTS[i]; f.bufT = 0.2; }
}
function startAttack(f, name) {
  var mv = MOVES[name];
  f.state = name; f.t = 0; f.mv = name; f.hitDone = false; f.lunged = false; f.buf = ''; f.bufT = 0; f.blocking = false;
  f.stamina -= mv.cost; f.stDelay = 0.7;
  if (name === 'light') f.punchSide *= -1;
}
function startDodge(S, f, inp, foe) {
  var dx = inp.mx, dz = inp.mz;
  if (len(dx, dz) < 0.2) { dx = f.x - foe.x; dz = f.z - foe.z; }
  var l = len(dx, dz) || 1; dx /= l; dz /= l;
  f.state = 'dodge'; f.t = 0; f.buf = ''; f.bufT = 0; f.blocking = false;
  f.stamina -= 22; f.stDelay = 0.6; f.invuln = 0.24; f.dodgeCD = 0.8;
  f.vx = dx * 12; f.vz = dz * 12;
  ev(S, { k: 'whoosh', heavy: false });
}

function update(S, f, inp, foe) {
  var dt = TICK, s = f.state, k;
  f.t += dt;
  if (f.invuln > 0) f.invuln -= dt;
  if (f.dodgeCD > 0) f.dodgeCD -= dt;
  if (f.flash > 0) f.flash -= dt;
  if (f.ghostT > 0) f.ghostT -= dt;
  if (f.comboT > 0) f.comboT -= dt;
  if (f.buf) { f.bufT -= dt; if (f.bufT <= 0) { f.buf = ''; f.bufT = 0; } }
  if (f.stDelay > 0) f.stDelay -= dt;
  else if (s !== 'guardbreak' && !f.blocking && f.stamina < 100) f.stamina = Math.min(100, f.stamina + 30 * dt);

  if (s === 'idle') {
    f.blocking = !!inp.block && f.stamina > 0;
    var sp = f.blocking ? 2.4 : 5.6;
    k = 1 - Math.exp(-18 * dt);
    f.vx += (inp.mx * sp - f.vx) * k; f.vz += (inp.mz * sp - f.vz) * k;
    faceFoe(f, foe, 18);
    if (f.buf) {
      var a = f.buf;
      if (a === 'dodge') { if (f.dodgeCD <= 0 && f.stamina >= 22) startDodge(S, f, inp, foe); else { f.buf = ''; f.bufT = 0; } }
      else if (f.stamina >= MOVES[a].cost) startAttack(f, a);
      else { f.buf = ''; f.bufT = 0; }
    }
  } else if (s === 'light' || s === 'heavy' || s === 'grab') {
    var m = MOVES[f.mv];
    if (f.t < m.start) faceFoe(f, foe, 10);
    if (f.t >= m.start && !f.lunged) {
      f.lunged = true;
      f.vx = Math.sin(f.yaw) * m.lunge; f.vz = Math.cos(f.yaw) * m.lunge;
      ev(S, { k: 'whoosh', heavy: s === 'heavy' });
    }
    k = Math.exp(-7 * dt); f.vx *= k; f.vz *= k;
    if (f.t >= m.start + m.active + m.rec) toIdle(f);
  } else if (s === 'dodge') {
    k = Math.exp(-5 * dt); f.vx *= k; f.vz *= k;
    faceFoe(f, foe, 6);
    if (f.t >= 0.34) toIdle(f);
  } else if (s === 'hit' || s === 'guardbreak') {
    k = Math.exp(-6 * dt); f.vx *= k; f.vz *= k;
    if (f.t >= f.dur) { if (s === 'guardbreak') f.stamina = 45; toIdle(f); }
  } else if (s === 'down') {
    k = Math.exp(-8 * dt); f.vx *= k; f.vz *= k;
    if (f.t > f.dur - 0.35) f.invuln = 0.05;
    if (f.t >= f.dur) toIdle(f);
  } else if (s === 'ko') {
    k = Math.exp(-8 * dt); f.vx *= k; f.vz *= k;
  } else if (s === 'throwing') {
    var D = foe;
    k = Math.exp(-10 * dt); f.vx *= k; f.vz *= k;
    if (f.t < THROW_T) {
      var u = f.t / THROW_T, along = lerp(1.0, -1.6, smooth(u));
      D.x = q(f.x + Math.sin(f.yaw) * along); D.z = q(f.z + Math.cos(f.yaw) * along);
      D.y = Math.max(0, 2.7 * Math.sin(Math.PI * u)); D.yaw = q(f.yaw + Math.PI); D.throwU = u;
    } else if (!f.slammed) {
      f.slammed = true;
      var r = len(D.x, D.z); if (r > R_ARENA) { D.x *= R_ARENA / r; D.z *= R_ARENA / r; }
      D.y = 0; takeDamage(D, 14); toState(D, 'down', 1.3); D.vx = 0; D.vz = 0;
      S.hitstop = Math.max(S.hitstop, 0.14);
      f.comboN = 1; f.comboT = 0;
      ev(S, { k: 'slam', x: D.x, z: D.z, dmg: 14, d: D.idx, sh: 0.55 });
    }
    if (f.t >= THROW_T + 0.3) toIdle(f);
  }
}

/* ---------- combat ---------- */
function reach(A, D, range) {
  var dx = D.x - A.x, dz = D.z - A.z, d = len(dx, dz);
  if (d > range) return false;
  return (dx * Math.sin(A.yaw) + dz * Math.cos(A.yaw)) / Math.max(d, 1e-4) > 0.35;
}
function activeWindow(A) { var m = MOVES[A.mv]; return !!m && !A.hitDone && A.t >= m.start && A.t < m.start + m.active; }

function resolveCombat(S) {
  var F = S.f, snaps = [], acts = [], i, A, D;
  for (i = 0; i < 2; i++) snaps[i] = { state: F[i].state, blocking: F[i].blocking, invuln: F[i].invuln };
  for (i = 0; i < 2; i++) {
    A = F[i]; D = F[1 - i];
    if ((A.state === 'light' || A.state === 'heavy') && activeWindow(A) && reach(A, D, MOVES[A.mv].range)) acts.push([A, D, snaps[1 - i]]);
  }
  for (i = 0; i < acts.length; i++) strike(S, acts[i][0], acts[i][1], acts[i][2]);
  for (i = 0; i < 2; i++) {
    A = F[i]; D = F[1 - i];
    if (A.state === 'grab' && activeWindow(A) && reach(A, D, MOVES[A.mv].range)) grab(S, A, D);
  }
}
function strike(S, A, D, snap) {
  var mv = MOVES[A.mv], heavy = A.state === 'heavy';
  var mx = (A.x + D.x) / 2, mz = (A.z + D.z) / 2;
  if (snap.invuln > 0) { A.hitDone = true; ev(S, { k: 'dodge', x: D.x, z: D.z }); return; }
  if (snap.state === 'down' || snap.state === 'thrown' || snap.state === 'ko' || snap.state === 'throwing') return;
  A.hitDone = true;
  var dx = D.x - A.x, dz = D.z - A.z, l = len(dx, dz) || 1; dx /= l; dz /= l;
  if (snap.blocking && snap.state === 'idle') {
    D.stamina -= mv.guard; D.stDelay = 1.0; D.flash = 0.1; D.flashCol = 0x2fd8ea;
    if (heavy) takeDamage(D, 3);
    D.vx += dx * mv.kb * 0.45; D.vz += dz * mv.kb * 0.45; A.vx -= dx * 1.5; A.vz -= dz * 1.5;
    S.hitstop = Math.max(S.hitstop, 0.05);
    ev(S, { k: 'block', x: D.x, z: D.z, mx: mx, mz: mz, heavy: heavy, sh: 0.12 });
    if (D.stamina <= 0) { D.stamina = 0; toState(D, 'guardbreak', 1.1); ev(S, { k: 'gbreak', x: D.x, z: D.z, sh: 0.3 }); }
    return;
  }
  D.combo++;
  var dmg = Math.max(1, Math.round(mv.dmg * Math.max(0.4, 1 - 0.18 * (D.combo - 1))));
  takeDamage(D, dmg);
  A.comboN = D.combo; A.comboT = 1.3;
  var down = heavy || D.combo >= 4, combo = D.combo;
  if (down) { toState(D, 'down', 1.2); } else { toState(D, 'hit', mv.stun * (1 - 0.1 * (combo - 1))); }
  D.combo = combo; D.vx = dx * mv.kb; D.vz = dz * mv.kb;
  S.hitstop = Math.max(S.hitstop, heavy ? 0.11 : 0.05);
  ev(S, { k: 'hit', x: D.x, z: D.z, mx: mx, mz: mz, dmg: dmg, heavy: heavy, down: down, d: D.idx, sh: heavy ? 0.4 : 0.15 });
}
function grab(S, A, D) {
  var s = D.state;
  if (D.invuln > 0) { A.hitDone = true; ev(S, { k: 'dodge', x: D.x, z: D.z }); return; }
  if (s === 'grab') {
    A.hitDone = true; D.hitDone = true;
    var dx = D.x - A.x, dz = D.z - A.z, l = len(dx, dz) || 1;
    A.vx = -dx / l * 5; A.vz = -dz / l * 5; D.vx = dx / l * 5; D.vz = dz / l * 5;
    ev(S, { k: 'tech', x: (A.x + D.x) / 2, z: (A.z + D.z) / 2 });
    return;
  }
  if (!(s === 'idle' || s === 'light' || s === 'heavy' || s === 'guardbreak')) return;
  A.hitDone = true;
  toState(A, 'throwing', THROW_T + 0.3); A.slammed = false; A.vx = 0; A.vz = 0; A.mv = '';
  toState(D, 'thrown', 0); D.vx = 0; D.vz = 0; D.throwU = 0;
  ev(S, { k: 'grab', x: D.x, z: D.z, sh: 0.15 });
}

function integrate(S, f) {
  if (f.state === 'thrown') return;
  f.x = q(f.x + f.vx * TICK); f.z = q(f.z + f.vz * TICK); f.vx = q(f.vx); f.vz = q(f.vz);
  var r = len(f.x, f.z);
  if (r > R_ARENA) {
    var nx = f.x / r, nz = f.z / r;
    f.x = q(nx * R_ARENA); f.z = q(nz * R_ARENA);
    var vr = f.vx * nx + f.vz * nz;
    if (vr > 0) {
      var flying = f.state === 'hit' || f.state === 'down' || f.state === 'guardbreak';
      if (flying && vr > 4.5 && !f.ropeUsed) {
        f.ropeUsed = true; f.vx -= nx * vr * 1.6; f.vz -= nz * vr * 1.6; takeDamage(f, 3);
        S.hitstop = Math.max(S.hitstop, 0.06);
        ev(S, { k: 'rope', x: f.x, z: f.z, dmg: 3, sh: 0.3 });
      } else { f.vx -= nx * vr; f.vz -= nz * vr; }
    }
  }
}
function separate(S) {
  var a = S.f[0], b = S.f[1];
  var skip = { thrown: 1, throwing: 1, down: 1, ko: 1 };
  if (skip[a.state] || skip[b.state] || a.state === 'dodge' || b.state === 'dodge') return;
  var dx = b.x - a.x, dz = b.z - a.z, d = len(dx, dz), min = 1.1;
  if (d < min) {
    if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
    var push = (min - d) / 2;
    a.x = q(a.x - dx / d * push); a.z = q(a.z - dz / d * push); b.x = q(b.x + dx / d * push); b.z = q(b.z + dz / d * push);
  }
}

/* ---------- round flow ---------- */
function endRound(S, kind) {
  var F = S.f, a = F[0].hp, b = F[1].hp, w;
  if (kind === 'time') w = a > b ? 0 : (b > a ? 1 : -1); else w = a > 0 ? 0 : (b > 0 ? 1 : -1);
  S.phase = 'ko'; S.pt = 0; S.winner = w;
  for (var i = 0; i < 2; i++) if (F[i].hp <= 0) toState(F[i], 'ko', 0);
  if (w >= 0) F[w].win = true;
  S.hitstop = Math.max(S.hitstop, 0.25);
  ev(S, { k: 'end', kind: kind, w: w });
}
function afterRound(S) {
  if (S.winner >= 0) {
    S.wins[S.winner]++; S.round++;
    if (S.wins[S.winner] >= 2) { S.phase = 'end'; ev(S, { k: 'matchend', w: S.winner }); return; }
  }
  startRound(S);
}

function step(S, in0, in1) {
  S.tick++;
  var F = S.f;
  if (S.phase !== 'fight') { in0 = BLANK; in1 = BLANK; }
  pushBuf(F[0], in0); pushBuf(F[1], in1);
  if (S.hitstop > 0) { S.hitstop -= TICK; return; }
  update(S, F[0], in0, F[1]); update(S, F[1], in1, F[0]);
  resolveCombat(S);
  integrate(S, F[0]); integrate(S, F[1]); separate(S);
  if (S.phase === 'intro') {
    S.pt += TICK;
    if (!S.fightShown && S.pt > 1.0) { S.fightShown = true; ev(S, { k: 'fight' }); }
    if (S.pt > 1.5) { S.phase = 'fight'; S.pt = 0; }
  } else if (S.phase === 'fight') {
    S.timer -= TICK;
    if (F[0].hp <= 0 || F[1].hp <= 0) endRound(S, 'ko');
    else if (S.timer <= 0) { S.timer = 0; endRound(S, 'time'); }
  } else if (S.phase === 'ko') {
    S.pt += TICK;
    if (S.pt > 2.4) afterRound(S);
  }
}

/* ---------- snapshots and desync detection ---------- */
function clone(S) {
  var c = JSON.parse(JSON.stringify(S, function (k, v) { return k === 'ev' ? undefined : v; }));
  c.ev = []; return c;
}
function hash(S) {
  var h = 2166136261 >>> 0;
  function mix(n) { h ^= (Math.round(n * 1000) | 0); h = Math.imul(h, 16777619) >>> 0; }
  function str(s) { for (var i = 0; i < s.length; i++) mix(s.charCodeAt(i)); }
  mix(S.tick); mix(S.timer); mix(S.round); mix(S.wins[0]); mix(S.wins[1]); str(S.phase);
  for (var i = 0; i < 2; i++) {
    var f = S.f[i];
    mix(f.x); mix(f.z); mix(f.vx); mix(f.vz); mix(f.yaw); mix(f.hp); mix(f.stamina); mix(f.t); mix(f.combo); str(f.state);
  }
  return h >>> 0;
}

var API = { TICK: TICK, MOVES: MOVES, THROW_T: THROW_T, R_ARENA: R_ARENA, ROUND_TIME: ROUND_TIME, BLANK: BLANK, newMatch: newMatch, step: step, clone: clone, hash: hash, quantInput: quantInput };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.RRSim = API;
})(typeof window !== 'undefined' ? window : this);

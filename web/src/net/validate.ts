// Everything that arrives from another player is hostile until proven otherwise. A signature only proves WHO sent a command, not that it is sane:
// a player can sign any garbage with their own key. So every incoming command is rebuilt here field by field, with fixed types and ranges, before the game sees it.
// This file has no imports so it can be tested under plain node (tests/validate.test.mjs).

/** Commands a peer may send. `cheat`, `flatten` and `demo` are testing tools: they exist in your own game on localhost but are never accepted from the network. */
export const PEER_OPS = ['place', 'upgrade', 'demolish', 'train', 'untrain', 'attack', 'raid', 'refuse', 'return', 'form', 'march', 'recall', 'split', 'merge', 'halt', 'sendatk', 'repair', 'rebuild', 'garrison', 'bridge', 'option', 'treaty', 'caravan', 'choose', 'visit', 'batch', 'road', 'goods', 'accept', 'settle', 'turnback', 'carhome', 'hero', 'style', 'gate', 'field', 'envoy', 'marriage', 'war', 'clear', 'link', 'journey', 'arrive', 'defend', 'retreat', 'reinforce', 'buy', 'level', 'restart', 'workers', 'bribe', 'research', 'armybridge', 'battleorder', 'reserve', 'plant', 'zone', 'rally', 'sendaid', 'host', 'unhost', 'recallaid', 'ask', 'wild'] as const;
export type PeerOp = typeof PEER_OPS[number];

export interface WireCmd {
  op: PeerOp; tick: number; n: number;
  /** The epoch of the village's history this command belongs to (see restart.ts): absent (0) until the owner first restarts. */
  e?: number;
  kind?: number; x?: number; y?: number; rot?: number; idx?: number; tag?: number; angle?: number; ax?: number; ay?: number; tech?: number;
  /** Target height for level, or for a raise/lower placement or pen stroke. Absent or negative uses the tool's automatic height. */
  h?: number;
  to?: string; from?: string; units?: number[]; loot?: number[];
}

/** The radii a patch of ground may be levelled to (the game core refuses any other). */
/** The most workers one building can ever be given a target for (far above any building's jobs). */
export const WORKERS_MAX = 1000;
export const RESERVE_MAX = 30_000;
export const LEVEL_RADIUS = { min: 3, max: 14 } as const;
/** The heights a patch may be levelled to by hand (the core refuses any other; an absent `h` or a negative one is Auto: the land round it). */
export const LEVEL_HEIGHT = { min: 1, max: 24 } as const;

export const LIMITS = {
  /** A single signed message: a batch of 400 pieces is about 20 kB of JSON. */
  maxCmdChars: 65536,
  maxSigChars: 200,
  /** Most commands in a log a peer sends us (a long game is a few thousand). */
  maxLogEntries: 40000,
  /** Most commands in one piece of history sent to fill a gap. */
  maxMoreEntries: 600,
  /** The farthest tick a command may carry (about 7 days of play at 0.5 ticks a second). */
  maxTick: 300_000,
  /** How far ahead of what we have already seen from that player a live command may be. Stops "run the simulation 2 billion ticks" messages. */
  maxLiveJump: 6000,
  maxNumbers: 1600,
};

const OPS = new Set<string>(PEER_OPS);
const TESTING = new Set<string>(['cheat', 'flatten', 'demo']);
const KEY = /^[A-Za-z0-9+/_=-]{20,100}$/;
// x and y are whole numbers for buildings but real positions for armies and distances for caravans, so they only have to be finite and sane
const INT_FIELDS = ['kind', 'rot', 'idx', 'tag'] as const;
const FLOAT_FIELDS = ['x', 'y', 'angle', 'ax', 'ay', 'h'] as const;
const BIG = 1e7;
/** Most restarts a village can have had. */
export const MAX_EPOCH = 100_000;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 2 ** 31 - 1;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= BIG;

/** The public key of a player as it appears on the wire. */
export const isKey = (v: unknown): v is string => typeof v === 'string' && KEY.test(v);

function numbers(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length > LIMITS.maxNumbers) return null;
  for (const e of v) if (!isInt(e)) return null;
  return v as number[];
}

/** Check one decoded command. Returns a clean copy with only the known fields, or null if anything is off. */
export function sanitizeCmd(raw: unknown, allowTesting = false): WireCmd | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.op !== 'string' || !(OPS.has(r.op) || (allowTesting && TESTING.has(r.op)))) return null;
  if (!isInt(r.tick) || r.tick < 0 || r.tick > LIMITS.maxTick) return null;
  if (!isInt(r.n) || r.n < 0) return null;
  const out: WireCmd = { op: r.op as PeerOp, tick: r.tick, n: r.n };   // (a testing op is only let through for your own saved history)
  for (const f of INT_FIELDS) if (r[f] !== undefined) { if (!isInt(r[f])) return null; out[f] = r[f] as number; }
  for (const f of FLOAT_FIELDS) if (r[f] !== undefined) { if (!isNum(r[f])) return null; out[f] = r[f] as number; }
  if (r.e !== undefined) { if (!isInt(r.e) || r.e < 0 || r.e > MAX_EPOCH) return null; out.e = r.e; }
  if (r.op === 'restart') {   // the first command of a new epoch: always at the very start of the new life
    if (!(isInt(out.e) && out.e >= 1) || out.n !== 0 || out.tick !== 0) return null;
    if (out.kind !== undefined && out.kind !== 1) return null;
  }
  if (r.op === 'reserve' && !(isInt(out.x) && out.x >= 0 && out.x <= RESERVE_MAX && isInt(out.y) && out.y >= 0 && out.y <= RESERVE_MAX)) return null;
  if (r.op === 'level') {   // level the ground: x, y the middle (relative to the village origin), kind the radius
    if (!(isInt(out.kind) && out.kind >= LEVEL_RADIUS.min && out.kind <= LEVEL_RADIUS.max) || !(isInt(out.x) && isInt(out.y)) || Math.abs(out.x) > 2000 || Math.abs(out.y) > 2000) return null;
    if (out.h !== undefined && !(out.h < 0 || (out.h >= LEVEL_HEIGHT.min && out.h <= LEVEL_HEIGHT.max))) return null;
  }
  if (r.op === 'plant') {   // the planting brush: x, y the middle (relative to the village origin), kind the radius
    if (!(isInt(out.kind) && out.kind >= 1 && out.kind <= 8) || !(isInt(out.x) && isInt(out.y)) || Math.abs(out.x) > 2000 || Math.abs(out.y) > 2000) return null;
  }
  if (r.op === 'zone') {   // a forester's planting zone: idx the building, x and y how far from it (each within 60)
    if (!(isInt(out.idx) && out.idx >= 0 && out.idx <= 100_000) || !(isInt(out.x) && isInt(out.y)) || Math.abs(out.x) > 60 || Math.abs(out.y) > 60) return null;
  }
  if (r.op === 'rally') {   // where new armies stand: kind 0 the barracks, 1 the castle (x, y the spot); 2 and 3 put it back where it was
    if (!(isInt(out.kind) && out.kind >= 0 && out.kind <= 3)) return null;
    if (out.kind < 2 && !(isNum(out.x) && isNum(out.y) && Math.abs(out.x) <= 1200 && Math.abs(out.y) <= 1200)) return null;
  }
  if (r.op === 'workers') {   // idx the building, kind how many workers it should have: -1 auto, 0 paused, up to what its jobs allow (the core bounds-checks it too)
    if (!(isInt(out.idx) && out.idx >= 0 && out.idx <= 100_000) || !(isInt(out.kind) && out.kind >= -1 && out.kind <= WORKERS_MAX)) return null;
  }
  for (const f of ['to', 'from'] as const) if (r[f] !== undefined) { if (!isKey(r[f])) return null; out[f] = r[f] as string; }
  if ((r.op === 'turnback' || r.op === 'carhome') && !(isInt(out.kind) && out.kind >= 0 && out.kind < 128 && isInt(out.x) && out.x >= 1 && out.x <= 500 && (r.op === 'turnback' ? typeof out.to === 'string' : isInt(out.idx)))) return null;   // a caravan turned back: kind the goods (gift flag included), x the amount
  if (r.op === 'research' && !(isInt(out.kind) && out.kind >= 0 && out.kind < 8)) return null;
  if (r.op === 'armybridge' && out.kind !== 0 && out.kind !== 1) return null;
  if (r.op === 'battleorder') {
    if (!(isInt(out.idx) && out.idx >= 0 && out.idx <= 4) || !(isInt(out.kind) && out.kind >= 0 && out.kind <= 4)) return null;
    if (out.kind !== 0 && !(isNum(out.x) && isNum(out.y) && Math.abs(out.x) <= 1200 && Math.abs(out.y) <= 1200)) return null;
    if (out.to && out.tag !== undefined) return null;
  }
  if ((out.op === 'raid' || out.op === 'reinforce') && r.tech !== undefined) {
    if (!isInt(r.tech) || r.tech < 0 || r.tech > 255) return null;
    out.tech = r.tech;
  }
  for (const f of ['units', 'loot'] as const) if (r[f] !== undefined) { const a = numbers(r[f]); if (!a) return null; out[f] = a; }
  if (r.op === 'sendaid' || r.op === 'host' || r.op === 'unhost') {   // soldiers sent to help an ally, taken in as guests, sent home again (docs/ALLIES.md)
    if (!out.units || out.units.length < 5 || out.units.length > 6 || out.units.some(n => n < 0 || n > 100_000) || !out.units.some(n => n > 0)) return null;
    if (r.op === 'sendaid' && !(out.to && isInt(out.idx) && out.idx >= 0)) return null;
    if (r.op === 'host' && !(out.from && isInt(out.tag))) return null;
    if (r.op === 'unhost' && !(out.to && isInt(out.tag))) return null;
  }
  if (r.op === 'recallaid' && !out.to) return null;   // ask an ally to send our soldiers home
  if (r.op === 'ask' && !(out.to && isInt(out.kind) && out.kind >= 1 && out.kind <= 3)) return null;   // a request for help: 1 defence, 2 a raid, 3 work
  if (out.op === 'return' && out.kind === 1 && (out.loot !== undefined || !out.units || out.units.length > 6 || out.units.some(n => n < 0))) return null;
  if (out.h !== undefined && (out.op === 'place' || out.op === 'batch')) {
    const direction = (kind: number | undefined) => kind === 33 || kind === 34;
    if (!(out.h < 0 || (out.h >= LEVEL_HEIGHT.min && out.h <= LEVEL_HEIGHT.max))) return null;
    if (out.op === 'place') {
      if (!direction(out.kind) || !isInt(out.x) || !isInt(out.y)) return null;
    } else if (!out.units?.length || out.units.length % 4 !== 0 || out.units.some((v, i) => i % 4 === 0 && !direction(v))) return null;
  }
  return out;
}

/** True for a (correctly signed) command that is one of the testing tools. Those are skipped, not punished: a developer testing on localhost signs them legitimately. */
export function isTestingOp(text: string): boolean {
  if (text.length > LIMITS.maxCmdChars) return false;
  try { const o = JSON.parse(text) as { op?: unknown }; return o?.op === 'cheat' || o?.op === 'flatten' || o?.op === 'demo'; } catch { return false; }
}

/** Decode and check a signed message body (the JSON string that was signed). */
export function parseCmd(text: unknown, allowTesting = false): WireCmd | null {
  if (typeof text !== 'string' || text.length > LIMITS.maxCmdChars) return null;
  try { return sanitizeCmd(JSON.parse(text), allowTesting); } catch { return null; }
}

/** A signed message as it travels: the command text and its signature. */
export function isSigned(v: unknown): v is { cmd: string; sig: string } {
  return typeof v === 'object' && v !== null && typeof (v as { cmd?: unknown }).cmd === 'string' && typeof (v as { sig?: unknown }).sig === 'string'
    && (v as { cmd: string }).cmd.length <= LIMITS.maxCmdChars && (v as { sig: string }).sig.length <= LIMITS.maxSigChars;
}

/** The state hash a player broadcasts every tick: the epoch of their history (how many times they have restarted), the clock, the hash of the whole state, how many commands their history holds so far, the hashes of its sections, and whether
 *  they have used testing tools (which change their village without leaving a command that others could replay). */
export interface WireHash { tick: number; hash: string; c: number; p: string[]; tools: boolean; e: number }
const DIGITS = /^[0-9]{1,20}$/;
/** Check a hash message. An older build sends only `tick` and `hash`: those come back with `c` of -1, which means "cannot be compared". */
export function sanitizeHash(raw: unknown): WireHash | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.tick) || r.tick < 0 || r.tick > LIMITS.maxTick || typeof r.hash !== 'string' || !DIGITS.test(r.hash)) return null;
  let c = -1;
  if (r.c !== undefined) { if (!isInt(r.c) || r.c < 0 || r.c > 1_000_000) return null; c = r.c; }
  let p: string[] = [];
  if (r.p !== undefined) { if (!Array.isArray(r.p) || r.p.length > 16 || !r.p.every(x => typeof x === 'string' && DIGITS.test(x))) return null; p = r.p as string[]; }
  let e = 0;
  if (r.e !== undefined) { if (!isInt(r.e) || r.e < 0 || r.e > MAX_EPOCH) return null; e = r.e; }
  return { tick: r.tick, hash: r.hash, c, p, tools: r.tools === true, e };
}

/** The build a peer says it runs: the message protocol and the fingerprint of its simulation rules. Missing (an older build) gives protocol 0 and no fingerprint. */
export function sanitizeBuild(raw: unknown): { v: number; rules: string; b: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const v = r.v === undefined ? 0 : r.v, rules = r.rules === undefined ? '' : r.rules, b = r.b === undefined ? 0 : r.b;
  if (!isInt(v) || v < 0 || v > 1_000_000 || typeof rules !== 'string' || !/^[0-9a-f]{0,32}$/.test(rules) || !isInt(b) || b < 0) return null;
  return { v, rules, b };
}

/** The heartbeat: `ts` is the sender's own clock (echoed back so they can time the round trip), `e` and `n` how far we have got with THEIR history (see link.ts). */
export interface WireHb { ts: number; e: number; n: number }
export function sanitizeHb(raw: unknown): WireHb | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || !isInt(r.e) || r.e < 0 || r.e > MAX_EPOCH || !isInt(r.n) || r.n < -1) return null;
  return { ts: r.ts, e: r.e, n: r.n };
}
export function sanitizeEcho(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const ts = (raw as Record<string, unknown>).ts;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
}

/** A request for history: `t` 1 is the whole of it, `t` 2 the commands from number `from` of epoch `e` on. */
export type WireWant = { t: 1 } | { t: 2; e: number; from: number };
export function sanitizeWant(raw: unknown): WireWant | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.t === 1) return { t: 1 };
  if (r.t === 2 && isInt(r.e) && r.e >= 0 && r.e <= MAX_EPOCH && isInt(r.from) && r.from >= 0) return { t: 2, e: r.e, from: r.from };
  return null;
}

/** A piece of history sent because it was missing: `after` is the number of the sender's command before the first of these (-1: none). */
export function sanitizeMore(raw: unknown): { after: number; cmds: unknown[] } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.after) || r.after < -1 || !Array.isArray(r.cmds) || r.cmds.length > LIMITS.maxMoreEntries) return null;
  return { after: r.after, cmds: r.cmds };
}

/** What we remember about each player's stream of commands, to refuse replays and absurd jumps.
 *  A village's history is cut into epochs by `restart` commands (see restart.ts): each epoch starts a new life with its own clock and numbering, so inside an epoch the
 *  numbers and ticks only grow, and the epoch itself only grows. A command of an older epoch is a replay of something already superseded and is dropped; one of a newer
 *  epoch than the restart we have seen means we missed the restart (`gap`: ask for the history, nothing to punish). */
export class Sequence {
  lastN = -1; lastTick = 0; epoch = 0;
  /** A live command must be newer than the last one and not jump absurdly far ahead. */
  acceptLive(c: { n: number; tick: number }): boolean {
    if (c.n <= this.lastN || c.tick < this.lastTick || c.tick > this.lastTick + LIMITS.maxLiveJump) return false;
    this.lastN = c.n; this.lastTick = c.tick; return true;
  }
  /** `dup` is a command we already have (a history and the live copy of its last command can both arrive) or one of an epoch that is over: it is dropped quietly, not punished.
   *  `gap`: it belongs to a newer epoch than we know. */
  classify(c: { n: number; tick: number; e?: number; op?: string }): 'ok' | 'dup' | 'bad' | 'gap' {
    const e = c.e ?? 0;
    if (c.op === 'restart') {
      if (e <= this.epoch) return 'dup';   // a restart we have already seen (or an older one): replaying it does nothing
      this.epoch = e; this.lastN = c.n; this.lastTick = c.tick; return 'ok';
    }
    if (e < this.epoch) return 'dup';
    if (e > this.epoch) return 'gap';
    if (c.n <= this.lastN) return 'dup';
    return this.acceptLive(c) ? 'ok' : 'bad';
  }
  /** A whole log replaces what we knew: it must itself be in order. Returns the entries to keep (up to the first one out of order). A log is one epoch: epoch 0 has no restart,
   *  a later one begins with its `restart` command and every other entry carries the same epoch. */
  static checkLog<T extends { n: number; tick: number; e?: number; op?: string }>(cmds: T[]): T[] {
    const out: T[] = []; let n = -1, t = 0; const e = cmds.length ? (cmds[0].e ?? 0) : 0;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      if ((c.e ?? 0) !== e || (c.op === 'restart') !== (i === 0 && e > 0)) break;
      if (i > 0 && (c.n <= n || c.tick < t)) break;
      n = c.n; t = c.tick; out.push(c);
    }
    return out;
  }
  /** The epoch a (checked) log belongs to. */
  static epochOf(cmds: { e?: number }[]): number { return cmds.length ? cmds[0].e ?? 0 : 0; }
  resetTo(cmds: { n: number; tick: number; e?: number }[]) { const l = cmds[cmds.length - 1]; this.lastN = l ? l.n : -1; this.lastTick = l ? l.tick : 0; this.epoch = Sequence.epochOf(cmds); }
}

/** A token bucket: `rate` messages a second on average, bursts up to `burst`. */
export class Bucket {
  private tokens: number; private at: number; private rate: number; private burst: number;
  constructor(rate: number, burst: number, now = Date.now()) { this.rate = rate; this.burst = burst; this.tokens = burst; this.at = now; }
  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) / 1000 * this.rate); this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
}

/** A name another player chose, made safe to show: no markup characters, no control characters, at most 20 characters. */
export function cleanName(n: unknown): string {
  return String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Traveller';
}

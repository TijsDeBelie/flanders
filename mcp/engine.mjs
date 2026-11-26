// The game for an AI agent, with no browser: the same Rust core the game uses, run in-process (see web/src/agent.ts for the browser version this replaces).
//
// Two goals shape everything here:
//  - it must play exactly by the game's own rules (every action is a call into the core, which decides cost, terrain, workforce, ...; there are no cheat tools), and
//  - it must cost very few tokens: results are short arrays and numbers, actions are batched, static data is fetched on demand, and nothing is repeated.
// The world is deterministic, so a save is just the list of actions with the tick each happened at; loading replays it and arrives at exactly the same village.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let core;
try { core = require('./wasm/game_core.js'); } catch (e) {
  throw new Error('The game core is not built for Node yet. Run: cd mcp && npm run wasm   (needs Rust and wasm-pack)\n' + e.message);
}
const { World, catalog, units: unitsJson, village_sites } = core;

/** Resource order used by every array in the results. */
export const RES = ['wood', 'planks', 'stone', 'clay', 'bricks', 'ironore', 'iron', 'goldore', 'gold', 'charcoal', 'grain', 'tools', 'fish', 'smokedfish', 'bread', 'meat', 'smokedmeat'];
export const RES_SHORT = ['w', 'pl', 'st', 'cl', 'br', 'io', 'ir', 'go', 'gd', 'ch', 'gr', 'tl', 'fi', 'sf', 'bd', 'me', 'sm'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const DAY = 240;
const SEED_SALT = 3;

/** The same normalisation the game's links use, so a world name here is the same map as in the browser. */
export const cleanWorld = raw => String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40).trim() || 'flanders';
const hashSeed = s => { if (/^\d{1,15}$/.test(s)) return BigInt(s) + BigInt(SEED_SALT) * 1000003n; let h = 1469598103934665603n; for (const c of (s.toLowerCase() + '|map' + SEED_SALT)) h = ((h ^ BigInt(c.charCodeAt(0))) * 1099511628211n) & 0xffffffffffffn; return h; };

/** Why an action was refused, in a word or two. */
const WHY = { [-1]: 'unknown', [-2]: 'outside border', [-3]: 'blocked', [-4]: 'water', [-5]: 'too steep', [-6]: 'not enough resources', [-7]: 'needs deposit', [-8]: 'needs forest', [-9]: 'not buildable', [-10]: 'maxed or needs tier', [-11]: 'needs barracks', [-12]: 'barracks too basic', [-13]: 'not enough villagers', [-14]: 'burning', [-15]: 'nothing to repair', [-16]: 'needs water', [-17]: 'deposit in the way', [-18]: 'no water to bridge', [-19]: 'too wide', [-20]: 'gate needs a wall', [-27]: 'outside border' };
const why = c => WHY[c] ?? `code ${c}`;

/** Decisions the village puts to you (answer with ["decide", n]). */
const CHOICES = [
  ['plague', ['quarantine', 'carry on']],
  ['preacher', ['welcome (20 gold)', 'turn away']],
  ['noble', ['feast (100 grain, 30 gold)', 'decline']],
  ['hard winter', ['buy wood (60 gold)', 'share firewood', 'nothing']],
];

/** Events, in as few words as possible. `stop` marks the ones an advance should pause at so the agent can react. */
const EVENTS = {
  0: (a) => ['harvest +' + a, false], 1: (a) => ['plague ' + a, true], 2: (a, b) => [`raided: -${a} gold, ${b} defenders died`, true], 3: () => ['raid repelled', false], 4: (a) => ['caravan +' + a + ' gold', false],
  5: () => ['famine', true], 6: () => ['plague over', false], 7: (a) => ['ATTACK ' + (a || ''), true], 8: () => ['fire', true], 9: () => ['building lost', true], 10: () => ['soldier trained', false], 11: () => ['fire out', false],
  13: () => ['repaired', false], 14: () => ['rebuilt', false], 15: (a) => [a >= 0 ? 'trade +' + a : 'bought grain ' + (-a), false], 16: () => ['froze', true], 17: () => ['caravan robbed', false], 18: () => ['CHOICE', true],
  27: (a) => ['raiders bought off for ' + a + ' gold', false], 19: () => ['decided', false], 21: () => ['lord event', false], 22: (a) => ['unburied ' + a, true], 23: (a) => ['tithe +' + a, false], 24: () => ['envoy', false],
};

/** Goals that guide a first game; the next few that are not yet done are part of `status`. */
const GOALS = [
  ['3 houses', c => c.n(0) >= 3], ['farm', c => c.n(1) >= 1], ['woodcutter by a forest', c => c.n(4) >= 1], ['sawmill', c => c.n(5) >= 1], ['quarry at stone', c => c.n(6) >= 1],
  ['hunter lodge', c => c.n(18) >= 1], ['20 villagers', c => c.pop >= 20], ['clay pit + charcoal + brickworks', c => c.n(7) >= 1 && c.n(8) >= 1], ['iron mine', c => c.n(9) >= 1],
  ['tower + well', c => c.n(3) >= 1 && c.n(16) >= 1], ['hall to tier 1', c => c.hall >= 1], ['barracks + 5 soldiers', c => c.n(19) >= 1 && c.army >= 5], ['mint', c => c.n(14) >= 1],
  ['hall to tier 2', c => c.hall >= 2], ['hall to tier 3 (castle)', c => c.hall >= 3],
];

const isInt = v => Number.isInteger(v);
const fail = e => ({ ok: false, e });

export class Game {
  /**
   * @param {{ world?: string, save?: string|null }} opts  the world name (the map), and a file to keep the game in so it can be continued
   */
  constructor(opts = {}) {
    this.name = cleanWorld(opts.world);
    this.savePath = opts.save ?? null;
    this.defs = JSON.parse(catalog());
    this.unitDefs = JSON.parse(unitsJson());
    this.seed = hashSeed(this.name);
    const flat = village_sites(this.seed), sites = [];
    for (let i = 0; i < flat.length; i += 2) sites.push({ x: flat[i], z: flat[i + 1] });
    sites.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    this.origin = { x: Math.round(sites[0].x), z: Math.round(sites[0].z) };   // the village nearest the middle of the map, as in the browser
    this.world = new World(this.seed, this.origin.x, this.origin.z);
    this.legacyStart = false;
    this.log = [];
    this.replaying = false;
    this.lastStop = new Map();   // event kind -> tick an advance last paused for it
    if (this.savePath && existsSync(this.savePath)) this.load();
  }

  get tick() { return Number(this.world.tick()); }
  get day() { return Math.floor(this.tick / DAY) + 1; }
  /** Position of a point relative to the town hall, in the coordinates every tool uses. */
  rel(x, z) { return [Math.round(x - this.origin.x), Math.round(z - this.origin.z)]; }

  // ---------------------------------------------------------------- time
  /** Run the world forward; returns the events that happened (short strings) and whether it stopped early at an important one. */
  advance(ticks, stopOnEvent = true) {
    const counts = new Map(); let n = 0, stopped = false;
    while (n < ticks) {
      this.world.step(); n++;
      const ev = this.world.take_events();
      for (let i = 0; i + 3 < ev.length; i += 4) {
        const f = EVENTS[ev[i]]; if (!f) continue;
        const [text, stop] = f(ev[i + 1], ev[i + 2]);
        counts.set(text, (counts.get(text) ?? 0) + 1);
        // an event that keeps happening (famine every tick of a starving village) pauses an advance at most once in 120 ticks: otherwise every call would end after one tick
        if (stop && stopOnEvent && this.tick - (this.lastStop.get(ev[i]) ?? -1e9) >= 120) { this.lastStop.set(ev[i], this.tick); stopped = true; }
      }
      if (stopped) break;
    }
    return { ticks: n, events: [...counts].map(([t, c]) => (c > 1 ? `${t} x${c}` : t)), stopped };
  }

  // ---------------------------------------------------------------- reading the village
  counts() {
    const f = this.world.buildings_flat(), cnt = new Map();
    for (let i = 0; i < f.length; i += 10) cnt.set(f[i], (cnt.get(f[i]) ?? 0) + 1);
    return { n: k => cnt.get(k) ?? 0, pop: this.world.population(), hall: f[1], army: Array.from(this.world.army()).reduce((a, b) => a + b, 0) };
  }

  /** The whole picture in one small object: time, people, stores, rates, army, danger, what to do next. */
  status() {
    const w = this.world, c = this.counts(), t = this.tick, ch = Array.from(w.choice_flat());
    const s = {
      t, day: this.day, season: SEASONS[w.season()], hour: Math.round(((t / DAY + 0.3) % 1) * 24),
      pop: w.population(), cap: w.capacity(), happy: w.happiness(), sick: w.sick(), eff: w.efficiency(), radius: w.build_radius(), bld: w.building_count(),
      stock: Array.from(w.stocks()), per60: Array.from(w.flows()).map(v => Math.round(v * 60)), max: w.storage(),
      reserves: Array.from(w.reserves()),
      army: Array.from(w.army()), queued: Array.from(w.queued()), hall: c.hall,
    };
    if (w.battle_active()) { s.attack = 1; { const p = w.bribe_price(); if (p >= 0) s.attack_price = p; } const b = w.battle_boss(); if (b.length) s.boss = { kind: b[0] === 1 ? 'warlord' : 'ogre', hp: Math.round(b[2]), max: Math.round(b[3]), enraged: b[4] > 0, alive: b[5] > 0, lair: w.battle_lair().length > 0 }; }   // (a boss leads the attack, or guards the lair your army is in)
    const fires = Array.from(w.fires_flat()).filter((_, i) => i % 4 === 0).length; if (fires) s.fires = fires;
    if (ch.length) s.choice = { q: CHOICES[ch[0]]?.[0], opts: CHOICES[ch[0]]?.[1], days: ch[2] };
    const goals = GOALS.filter(([, ok]) => !ok(c)).slice(0, 3).map(([text]) => text); if (goals.length) s.next = goals;
    return s;
  }

  /** What a kind of building is: a one-line table of all of them, or the details of one. */
  info(kind, withOptions = false) {
    const cost = a => a.map(([r, n]) => RES_SHORT[r] + n).join(',');
    if (kind === undefined) return this.defs.map(d => `${d.id} ${d.name} r${d.r} ${cost(d.cost)}`);
    const d = this.defs[kind]; if (!d) return fail('no such kind');
    const r = { id: d.id, name: d.name, r: d.r, cost: cost(d.cost), housing: d.housing || undefined, jobs: d.jobs || undefined, needs: d.req === 1 ? 'deposit ' + ['stone', 'clay', 'iron', 'gold'][d.reqArg] : d.req === 2 ? 'forest' : d.req === 3 ? 'water' : undefined, in: d.inputs.length ? cost(d.inputs) : undefined, out: d.outputs.length ? cost(d.outputs) : undefined, cycle: d.cycle || undefined, maxTier: d.maxTier };
    if (withOptions && d.opts?.length) r.opts = d.opts.map((o, i) => `${i} ${o.n} (tier ${o.t}): ${o.d}`);
    if (d.winterRecipe) r.winterIn = cost(d.winterRecipe.inputs);
    return r;
  }

  /** Units the barracks can train: id, name, cost, minimum barracks tier. */
  unitTable() { return this.unitDefs.slice(0, 5).map(u => `${u.id} ${u.name} ${u.cost.map(([r, n]) => RES_SHORT[r] + n).join(',')} tier${u.tier}`); }

  /** Buildings: counts by kind, and a page of them as [idx, kind, tier, dx, dy, status, workers, hp%]. */
  buildings({ kind, near, limit = 25, offset = 0 } = {}) {
    const w = this.world, f = w.buildings_flat(), hp = w.building_health(), by = {}, rows = [];
    for (let i = 0; i < f.length / 10; i++) {
      const o = i * 10, k = f[o]; by[k] = (by[k] ?? 0) + 1;
      if (kind !== undefined && k !== kind) continue;
      const [dx, dy] = this.rel(f[o + 2], f[o + 3]);
      if (near && Math.hypot(dx - near[0], dy - near[1]) > (near[2] ?? 20)) continue;
      rows.push([i, k, f[o + 1], dx, dy, f[o + 6], f[o + 8], Math.round((hp[i * 3] / Math.max(1, hp[i * 3 + 1])) * 100)]);
    }
    return { total: f.length / 10, by, rows: rows.slice(offset, offset + limit), more: Math.max(0, rows.length - offset - limit) };
  }

  /** A small map of the land round a point (relative to the hall): ~ water, , shore, 0-9 height; plus nearby deposits as [kind, dx, dy, left]. */
  land({ dx = 0, dy = 0, half = 20, step = 4 } = {}) {
    const w = this.world, rows = [];
    for (let y = dy - half; y <= dy + half; y += step) { let row = ''; for (let x = dx - half; x <= dx + half; x += step) { const h = w.height_at(this.origin.x + x, this.origin.z + y); row += h < 0.2 ? '~' : h < 0.5 ? ',' : String(Math.min(9, Math.floor(h / 3))); } rows.push(row); }
    return { at: [dx - half, dy - half], step, rows, dep: this.deposits({ near: [dx, dy, half + 12] }) };
  }

  /** Deposits as [kind (0 stone 1 clay 2 iron 3 gold), dx, dy, remaining]. */
  deposits({ near, limit = 12 } = {}) {
    const d = this.world.deposits_flat(), out = [];
    for (let i = 0; i < d.length; i += 5) {
      if (d[i + 3] <= 0 || this.world.height_at(d[i + 1], d[i + 2]) < 0.3) continue;
      const [x, y] = this.rel(d[i + 1], d[i + 2]); if (near && Math.hypot(x - near[0], y - near[1]) > near[2]) continue;
      out.push([d[i], x, y, Math.round(d[i + 3])]);
    }
    return out.sort((a, b) => Math.hypot(a[1], a[2]) - Math.hypot(b[1], b[2])).slice(0, limit);
  }

  /** Field armies [id, spear, archer, sword, knight, catapult, dx, dy, state, ram]; and the neutral places you have found [kind, dx, dy, done] (kind 0 abbey, 1 ruined castle, 2 bandit camp, 3 lair: a boss and his escort, a real fight). */
  armies() {
    const d = this.world.det_flat(), out = [];
    for (let i = 0; i < d.length; i += 17) { const [x, y] = this.rel(d[i + 1], d[i + 2]); out.push([d[i], d[i + 3], d[i + 4], d[i + 5], d[i + 6], d[i + 7], x, y, d[i + 8], d[i + 16]]); }
    const p = this.world.neutrals_flat(), places = [];
    for (let i = 0; i < p.length; i += 4) { const [x, y] = this.rel(p[i + 1], p[i + 2]); places.push([p[i], x, y, p[i + 3]]); }
    return { armies: out, places };
  }

  /** What each resource is worth in coins now. */
  prices() { return Array.from(this.world.prices()).map(p => p / 100); }

  // ---------------------------------------------------------------- acting
  /** Where a mine, quarry or clay pit should stand to work the deposit nearest the given spot: against the deposit, door towards the hall. Null when there is none. */
  snap(kind, dx, dy) {
    if (kind === 29 || kind === 35 || kind === 41) {
      const s = kind === 35 ? this.world.port_snap(dx, dy)
        : kind === 29 ? this.world.waterwheel_snap(dx, dy) : this.world.fishing_hut_snap(dx, dy);
      return s.length ? { dx: s[0], dy: s[1], rot: s[2] } : null;
    }
    const d = this.defs[kind]; if (!d || d.req !== 1) return null;
    const f = this.world.deposits_flat(), px = this.origin.x + dx, pz = this.origin.z + dy;
    let best = -1, bd = 18 * 18;
    for (let i = 0; i + 4 < f.length; i += 5) {
      if (f[i] !== d.reqArg || f[i + 3] <= 0 || this.world.height_at(f[i + 1], f[i + 2]) < 0.3) continue;
      const q = (f[i + 1] - px) ** 2 + (f[i + 2] - pz) ** 2; if (q < bd) { bd = q; best = i; }
    }
    if (best < 0) return null;
    let ux = this.origin.x - f[best + 1], uz = this.origin.z - f[best + 2]; const len = Math.hypot(ux, uz) || 1; ux /= len; uz /= len;
    const off = kind === 6 ? 4.6 : 3.8, a = Math.atan2(ux, uz);
    return { dx: Math.round(f[best + 1] + ux * off - this.origin.x), dy: Math.round(f[best + 2] + uz * off - this.origin.z), rot: ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8 };
  }

  /**
   * Do one action. Forms (all coordinates relative to the hall, x east and y south):
   *   place kind dx dy [rot] [search]   build; mines and quarries snap to the nearest matching deposit, waterwheels and fishing huts to the bank; `search` tries nearby spots (0-12 units) when the first is refused
   *   up idx | opt idx bit [on] | demo idx true | fix idx | gar idx archers | draw idx up | gate idx closed | field idx mode(0 sow,1 fallow,2 rotate)
   *   train kind n | hero | form s a w k c r? | march id dx dy | recall id | defend id (a field army marches out to join a fight at home) | visit id | decide option | bribe (pay the raiders to leave: only a bandit raid that has not struck yet; see status.attack_price)
   * Returns { ok: true, ... } or { ok: false, e: why }.
   */
  act(a) {
    const w = this.world, op = a[0];
    const logged = (res, entry) => { if (res.ok && !this.replaying) this.log.push([this.tick, entry]); return res; };
    const idx = a[1];
    switch (op) {
      case 'place': {
        let [, kind, dx, dy, rot = 0, search = 0] = a;
        if (![kind, dx, dy, rot, search].every(isInt) || !this.defs[kind]) return fail('bad arguments');
        if (kind === 15) return fail('the town hall is fixed');
        const sn = this.replaying ? null : this.snap(kind, dx, dy); if (sn) ({ dx, dy, rot } = sn);   // (a replay uses the exact spot that was logged)
        if (!this.replaying && kind === 35) {
          if (!sn) return fail(why(-16));
          search = 0;
        }
        let code = 0;
        for (let r = 0; r <= Math.min(12, Math.max(0, search)); r += 2) for (let k = 0; k < (r ? 8 : 1); k++) {
          const ang = k * Math.PI / 4 + r, px = Math.round(dx + Math.cos(ang) * r), py = Math.round(dy + Math.sin(ang) * r);
          const res = w.place(kind, px, py, rot & 7);
          if (res >= 0) return logged({ ok: true, i: res, at: [px, py] }, ['place', kind, px, py, rot & 7]);
          code = res;
        }
        return fail(why(code));
      }
      case 'up': { if (!isInt(idx)) return fail('bad arguments'); const c = w.upgrade(idx); return c === 0 ? logged({ ok: true }, ['up', idx]) : fail(why(c)); }
      case 'opt': { const [, i, bit, on = true] = a; if (!isInt(i) || !isInt(bit)) return fail('bad arguments'); const c = w.set_option(i, bit, on !== false); return c === 0 ? logged({ ok: true }, ['opt', i, bit, on !== false]) : fail(why(c)); }
      case 'demo': { if (a[2] !== true) return fail('demolish needs true as the last item'); if (!isInt(idx) || idx < 1) return fail('bad arguments'); return w.demolish(idx) ? logged({ ok: true }, ['demo', idx, true]) : fail('no such building'); }
      case 'fix': { if (!isInt(idx)) return fail('bad arguments'); const c = w.repair(idx); return c === 0 ? logged({ ok: true }, ['fix', idx]) : fail(why(c)); }
      case 'train': { const [, kind, n] = a; if (!isInt(kind) || !isInt(n) || n < 1 || n > 50) return fail('bad arguments'); const c = w.train(kind, n); return c === 0 ? logged({ ok: true }, ['train', kind, n]) : fail(why(c)); }
      case 'gar': { const [, i, n] = a; if (!isInt(i) || !isInt(n) || n < 0 || n > 20) return fail('bad arguments'); const c = w.garrison_set(i, n); return c === 0 ? logged({ ok: true }, ['gar', i, n]) : fail(why(c)); }
      case 'draw': { const [, i, up] = a; if (!isInt(i)) return fail('bad arguments'); const c = w.drawbridge_set(i, up === true); return c === 0 ? logged({ ok: true }, ['draw', i, up === true]) : fail('not a drawbridge'); }
      case 'gate': { const [, i, closed] = a; if (!isInt(i)) return fail('bad arguments'); const c = w.gate_set(i, closed === true); return c === 0 ? logged({ ok: true }, ['gate', i, closed === true]) : fail('needs a stone gatehouse'); }
      case 'field': { const [, i, mode] = a; if (!isInt(i) || !isInt(mode)) return fail('bad arguments'); const c = w.set_field_mode(i, mode); return c === 0 ? logged({ ok: true }, ['field', i, mode]) : fail(c === -1 ? 'not a farm' : 'mode is 0, 1 or 2'); }
      case 'reserve': {
        const [, grain, wood] = a;
        const max = World.reserve_max();
        if (![grain, wood].every(n => isInt(n) && n >= 0 && n <= max) || !w.set_reserves(grain, wood)) return fail(`grain and firewood reserves must be whole numbers from 0 to ${max}`);
        return logged({ ok: true }, ['reserve', grain, wood]);
      }
      case 'hero': { const c = w.hero_hire(); return c === 0 ? logged({ ok: true }, ['hero']) : fail('cannot hire now (150 gold, needs barracks)'); }
      case 'form': { const u = a.slice(1); if (u.length === 5) u.push(0); if (u.length !== 6 || !u.every(v => isInt(v) && v >= 0 && v <= 300)) return fail('six counts: spear archer sword knight catapult ram (the ram may be left out)'); const id = w.det_form(Uint32Array.from(u)); return id ? logged({ ok: true, id }, ['form', ...u]) : fail('not enough soldiers in the barracks'); }
      case 'march': { const [, id, dx, dy] = a; if (![id, dx, dy].every(isInt) || Math.abs(dx) > 1100 || Math.abs(dy) > 1100) return fail('bad arguments'); const c = w.det_march(id, this.origin.x + dx, this.origin.z + dy, false, 0, 0); return c === 0 ? logged({ ok: true }, ['march', id, dx, dy]) : fail(c === -1 ? 'no such army' : c === -2 ? 'unreachable' : c === -3 ? 'catapults need soldiers to clear forest' : 'water too wide'); }
      case 'recall': { if (!isInt(idx)) return fail('bad arguments'); const c = w.det_recall(idx); return c === 0 ? logged({ ok: true }, ['recall', idx]) : fail('no such army'); }
      case 'defend': { if (!isInt(idx)) return fail('bad arguments'); const c = w.det_defend(idx); return c === 0 ? logged({ ok: true }, ['defend', idx]) : fail(c === -10 ? 'there is no fight to join' : c === -1 ? 'no such army' : 'it cannot get there (code ' + c + ')'); }
      case 'visit': { if (!isInt(idx)) return fail('bad arguments'); const c = w.visit_neutral(idx); return c >= 0 ? logged({ ok: true, kind: c }, ['visit', idx]) : fail(c === -1 ? 'no such army' : c === -2 ? 'not close enough to a place' : c === -4 ? 'a fight is already on' : 'already visited'); }
      case 'bribe': { const c = w.bribe(); return c === 0 ? logged({ ok: true }, ['bribe']) : fail(c === -6 ? 'not enough gold: ' + w.bribe_price() + ' wanted' : 'they cannot be bought off now (no bandit raid, it has begun, or the boss refuses)'); }
      case 'decide': { if (!isInt(idx) || idx < 0 || idx > 2) return fail('bad arguments'); const c = w.choose(idx); return c === 0 ? logged({ ok: true }, ['decide', idx]) : fail('no decision waiting'); }
      default: return fail('unknown action ' + String(op));
    }
  }

  // ---------------------------------------------------------------- saving
  save() {
    if (!this.savePath) return;
    const tmp = this.savePath + '.tmp';
    writeFileSync(tmp, JSON.stringify({ v: 2, world: this.name, tick: this.tick, log: this.log, legacyStart: this.legacyStart }));
    renameSync(tmp, this.savePath);   // never leave half a file
  }

  load() {
    const s = JSON.parse(readFileSync(this.savePath, 'utf8'));
    if ((s.v !== 1 && s.v !== 2) || s.world !== this.name || !Array.isArray(s.log)) throw new Error(`The save ${this.savePath} is for another world (${s.world}), not ${this.name}`);
    this.legacyStart = s.v === 1 || s.legacyStart === true;
    this.world.free();
    this.world = this.legacyStart ? World.new_legacy(this.seed, this.origin.x, this.origin.z) : new World(this.seed, this.origin.x, this.origin.z);
    this.log = [];
    this.replaying = true;
    try {
      for (const [tick, entry] of s.log) { while (this.tick < tick) this.world.step(); this.act(entry); this.log.push([tick, entry]); }
      while (this.tick < s.tick) this.world.step();
      this.world.take_events();
    } finally { this.replaying = false; }
    if (!this.world.estate_active()) this.act(['reserve', 0, 0]);
  }
}

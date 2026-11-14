import type { World } from './wasm/game_core.js';
import { RES, defs, PLACE_ERRORS, STATUS, tierName, units } from './data';

/**
 * The agent bridge: lets an AI agent (through the MCP server in /mcp) play this village with the same rules as a human.
 *
 * It is opt-in: it only starts when the page is opened with ?agent=PORT&token=TOKEN (the MCP server prints the link). Everything the agent does goes through
 * the same World calls and the same signed commands as a click in the interface, so the game's own rules decide what is allowed: build radius, cost, terrain,
 * workforce, and so on. On top of that this file adds guardrails the human can see and stop:
 *   - only a fixed list of tools; no testing tools (cheats, levelling, model village, resets), no network or save controls
 *   - a speed handicap: a minimum pause between actions and a per-minute budget, so the agent plays at about the pace of a person, whatever its own speed
 *   - the destructive and the aggressive are fenced: demolishing needs `confirm`, and attacking another player's village is off unless the human allows it
 *   - a visible badge with Pause / Disconnect; while paused every call is refused
 *   - the agent never changes the game speed; it only acts in real time
 */

export interface AgentHost {
  world(): World;
  /** Sign, save and send a command that was already applied to the local world. */
  commit(cmd: Record<string, unknown>): void;
  /** Refresh everything that draws the village after a change. */
  afterChange(): void;
  toast(msg: string, kind?: 'good' | 'bad' | 'info'): void;
  /** Other players' villages that are online: key, name, origin. */
  rivals(): { key: string; name: string; x: number; z: number; online: boolean }[];
  /** Start an attack on a rival with these soldiers [spear, archer, sword, knight, catapult] (the same as the Army tab's attack button). */
  attack(key: string, units: number[]): boolean;
}

/** Tools the agent may call. Anything else is refused. */
export const AGENT_TOOLS = ['observe', 'catalog', 'buildings', 'probe', 'can_place', 'place', 'upgrade', 'option', 'demolish', 'repair', 'train', 'garrison', 'drawbridge', 'form_army', 'march_army', 'recall_army', 'rivals', 'attack', 'prices'] as const;

const MUTATING = new Set(['place', 'upgrade', 'option', 'demolish', 'repair', 'train', 'garrison', 'drawbridge', 'form_army', 'march_army', 'recall_army', 'attack']);
const NEVER_BUILD = new Set([15]);   // the town hall cannot be built (the game refuses it too)

/** A token-bucket-ish limiter: a minimum gap between calls plus a budget per minute. */
class Limiter {
  private stamps: number[] = []; private last = 0;
  constructor(public gapMs: number, public perMinute: number) {}
  /** 0 when allowed (and records the call), otherwise the milliseconds to wait. */
  take(now: number): number {
    const wait = Math.max(0, this.last + this.gapMs - now);
    if (wait > 0) return wait;
    this.stamps = this.stamps.filter(t => now - t < 60000);
    if (this.stamps.length >= this.perMinute) return Math.max(1000, 60000 - (now - this.stamps[0]));
    this.stamps.push(now); this.last = now; return 0;
  }
}

const int = (v: unknown, lo: number, hi: number, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.floor(v) !== v) throw new Error(`${name} must be a whole number`);
  if (v < lo || v > hi) throw new Error(`${name} must be between ${lo} and ${hi}`);
  return v;
};

export function startAgentBridge(host: AgentHost, port: number, token: string) {
  const pace = new URLSearchParams(location.search).get('pace') ?? 'normal';
  const acts = new Limiter(pace === 'slow' ? 5000 : 2500, pace === 'slow' ? 8 : 15);
  const looks = new Limiter(300, 100);
  const demolitions = new Limiter(0, 4);
  let paused = false, connected = false, ws: WebSocket | null = null, stopped = false, count = 0;
  const allowAttack = new URLSearchParams(location.search).get('allow_attack') === '1';
  const log: string[] = [];

  // ---- the badge ----
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:60;background:#1d150dd9;color:#f1e4c3;border:1px solid #c9a24a;border-radius:6px;padding:6px 10px;font:13px system-ui,sans-serif;display:flex;gap:8px;align-items:center;max-width:380px';
  badge.innerHTML = '<span id="ag-t">🤖 Agent: waiting for the MCP server…</span><button id="ag-p" style="cursor:pointer">Pause</button><button id="ag-x" style="cursor:pointer">Disconnect</button>';
  document.body.appendChild(badge);
  const label = badge.querySelector<HTMLElement>('#ag-t')!;
  const show = () => { label.textContent = !connected ? '🤖 Agent: waiting for the MCP server…' : paused ? '🤖 Agent: PAUSED by you' : `🤖 Agent playing · ${count} actions · ${log[log.length - 1] ?? ''}`.slice(0, 90); (badge.querySelector('#ag-p') as HTMLElement).textContent = paused ? 'Resume' : 'Pause'; };
  (badge.querySelector('#ag-p') as HTMLElement).onclick = () => { paused = !paused; show(); host.toast(paused ? 'The agent is paused.' : 'The agent may play again.', 'info'); };
  (badge.querySelector('#ag-x') as HTMLElement).onclick = () => { stopped = true; ws?.close(); badge.remove(); host.toast('The agent was disconnected.', 'info'); };

  const w = () => host.world();
  const hall = () => { const f = w().buildings_flat(); return { x: f[2], z: f[3] }; };
  const catalogOf = (id: number) => { const d = defs[id]; if (!d) throw new Error(`no such building kind ${id}`); return d; };

  // ---- tools ----
  const tools: Record<string, (a: Record<string, unknown>) => unknown> = {
    observe() {
      const world = w(), st = Array.from(world.stocks()), fl = Array.from(world.flows()), cap = world.storage();
      const stock: Record<string, { amount: number; per_second: number }> = {}; RES.forEach((r, i) => { stock[r.key] = { amount: st[i], per_second: fl[i] }; });
      const a = Array.from(world.army()), q = Array.from(world.queued()), away = Array.from(world.away());
      const names = units.slice(0, 5).map(u => u.name);
      const unitMap = (v: number[]) => Object.fromEntries(names.map((n, i) => [n, v[i]]));
      return {
        tick: Number(world.tick()), day: Math.floor(Number(world.tick()) / 240) + 1, storage_cap_per_resource: cap, stock,
        population: world.population(), sick: world.sick(), happiness: world.happiness(), workforce_efficiency_percent: world.efficiency(), housing_capacity: world.capacity(),
        buildings: world.building_count(), build_radius: world.build_radius(), under_attack: world.battle_active(), burning_buildings: Array.from(world.fires_flat()).filter((_, i) => i % 4 === 0).length,
        army_in_barracks: unitMap(a), army_queued: unitMap(q), army_away: unitMap(away), guards: world.guards(), field_armies: Array.from(world.det_flat()).length / 16,
      };
    },
    catalog() {
      return {
        resources: RES.map((r, i) => ({ id: i, key: r.key, name: r.name })),
        buildings: defs.map(d => ({ id: d.id, name: d.name, category: d.cat, radius: d.r, cost: d.cost.map(([r, n]) => ({ resource: RES[r].key, amount: n })), inputs: d.inputs.map(([r, n]) => ({ resource: RES[r].key, amount: n })), outputs: d.outputs.map(([r, n]) => ({ resource: RES[r].key, amount: n })), cycle_seconds: d.cycle, jobs: d.jobs, housing: d.housing, max_tier: d.maxTier, options: (d.opts ?? []).map((o, i) => ({ bit: i, name: o.n, adds: o.d, needs_tier: o.t })), description: d.desc })),
        units: units.slice(0, 5).map((u, i) => ({ id: i, name: u.name })),
        notes: ['Coordinates are relative to your town hall: x east, y south.', 'Tier 0..3 is the upgrade level.', 'Optional design options are set per building with the `option` tool.'],
      };
    },
    buildings(a) {
      const world = w(), f = world.buildings_flat(), hp = world.building_health(), ox = world.origin_x(), oy = world.origin_y(), opts = world.options_flat(), gar = world.garrison_flat();
      const only = a.kind === undefined ? null : int(a.kind, 0, defs.length - 1, 'kind'), out: unknown[] = [];
      for (let i = 0; i < f.length / 10 && out.length < 400; i++) {
        const o = i * 10, kind = f[o]; if (only !== null && kind !== only) continue;
        out.push({ idx: i, kind, name: defs[kind].name, tier: f[o + 1], tier_name: tierName(kind, f[o + 1]), dx: Math.round(f[o + 2] - ox), dy: Math.round(f[o + 3] - oy), status: STATUS[f[o + 6]] ?? '', health_percent: Math.round((hp[i * 3] / Math.max(1, hp[i * 3 + 1])) * 100), burning: hp[i * 3 + 2] > 0, workers: f[o + 8], residents: f[o + 9], option_bits: opts[i] ?? 0, archers_inside: gar[i] ?? 0 });
      }
      return { count: f.length / 10, buildings: out };
    },
    probe(a) {
      const world = w(), ox = world.origin_x(), oy = world.origin_y();
      const cx = int(a.dx ?? 0, -200, 200, 'dx'), cy = int(a.dy ?? 0, -200, 200, 'dy'), half = int(a.half ?? 20, 4, 40, 'half'), step = int(a.step ?? 4, 2, 10, 'step');
      const rows: string[] = []; let lo = 1e9, hi = -1e9;
      for (let y = cy - half; y <= cy + half; y += step) { let row = ''; for (let x = cx - half; x <= cx + half; x += step) { const h = world.height_at(ox + x, oy + y); lo = Math.min(lo, h); hi = Math.max(hi, h); row += h < 0.2 ? '~' : h < 0.5 ? ',' : String(Math.min(9, Math.floor(h / 3))); } rows.push(row); }
      const dep = Array.from(world.deposits_flat()), near: unknown[] = [];
      for (let i = 0; i < dep.length; i += 5) { const x = dep[i + 1] - ox, y = dep[i + 2] - oy; if (Math.abs(x - cx) <= half + 12 && Math.abs(y - cy) <= half + 12 && dep[i + 3] > 0) near.push({ kind: ['stone', 'clay', 'iron ore', 'gold ore'][dep[i]], dx: Math.round(x), dy: Math.round(y), remaining: dep[i + 3] }); }
      return { legend: '~ water, "," shore, digits = height/3 (0 low .. 9 high)', origin: { dx: cx - half, dy: cy - half }, step, rows, height_range: [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10], deposits: near };
    },
    can_place(a) {
      const kind = int(a.kind, 0, defs.length - 1, 'kind'), dx = int(a.dx, -200, 200, 'dx'), dy = int(a.dy, -200, 200, 'dy');
      const code = w().can_place(kind, dx, dy); return { ok: code === 0, code, reason: code === 0 ? 'ok' : (PLACE_ERRORS[code] ?? `code ${code}`) };
    },
    place(a) {
      const kind = int(a.kind, 0, defs.length - 1, 'kind'), dx = int(a.dx, -200, 200, 'dx'), dy = int(a.dy, -200, 200, 'dy'), rot = int(a.rot ?? 0, 0, 7, 'rot');
      if (NEVER_BUILD.has(kind)) throw new Error('the town hall cannot be built');
      const world = w(), res = world.place(kind, dx, dy, rot);
      if (res < 0) return { ok: false, code: res, reason: PLACE_ERRORS[res] ?? `code ${res}` };
      host.commit({ op: 'place', kind, x: dx, y: dy, rot }); host.afterChange(); return { ok: true, idx: res };
    },
    upgrade(a) {
      const idx = int(a.idx, 0, 100000, 'idx'), world = w(), code = world.upgrade(idx);
      if (code === 0) { host.commit({ op: 'upgrade', idx }); host.afterChange(); } return { ok: code === 0, code, reason: code === 0 ? 'ok' : code === -6 ? 'not enough resources' : code === -10 ? 'already fully upgraded' : 'no such building' };
    },
    option(a) {
      const idx = int(a.idx, 0, 100000, 'idx'), bit = int(a.bit, 0, 3, 'bit'), on = a.on !== false, world = w(), code = world.set_option(idx, bit, on);
      if (code === 0) { host.commit({ op: 'option', idx, kind: bit, x: on ? 1 : 0 }); host.afterChange(); } return { ok: code === 0, code, reason: code === 0 ? 'ok' : code === -6 ? 'not enough resources' : code === -10 ? 'needs a better tier first' : 'no such building or option' };
    },
    demolish(a) {
      if (a.confirm !== true) throw new Error('demolish needs confirm: true (it cannot be undone; only half the cost comes back)');
      const idx = int(a.idx, 1, 100000, 'idx'), wait = demolitions.take(Date.now()); if (wait) throw new Error(`too many demolitions; try again in ${Math.ceil(wait / 1000)}s`);
      const world = w(), ok = world.demolish(idx); if (ok) { host.commit({ op: 'demolish', idx }); host.afterChange(); } return { ok };
    },
    repair(a) { const idx = int(a.idx, 0, 100000, 'idx'), code = w().repair(idx); if (code === 0) { host.commit({ op: 'repair', idx }); host.afterChange(); } return { ok: code === 0, code }; },
    train(a) {
      const kind = int(a.kind, 0, 4, 'kind'), n = int(a.count, 1, 50, 'count'), code = w().train(kind, n);
      if (code === 0) host.commit({ op: 'train', kind, x: n }); return { ok: code === 0, code, reason: code === 0 ? 'queued' : (PLACE_ERRORS[code] ?? `code ${code}`) };
    },
    garrison(a) { const idx = int(a.idx, 0, 100000, 'idx'), n = int(a.archers, 0, 20, 'archers'), code = w().garrison_set(idx, n); if (code === 0) { host.commit({ op: 'garrison', idx, kind: n }); host.afterChange(); } return { ok: code === 0, code }; },
    drawbridge(a) { const idx = int(a.idx, 0, 100000, 'idx'), up = a.up === true, code = w().drawbridge_set(idx, up); if (code === 0) { host.commit({ op: 'bridge', idx, kind: up ? 1 : 0 }); host.afterChange(); } return { ok: code === 0 }; },
    form_army(a) {
      const u = (Array.isArray(a.units) ? a.units : []).map((v, i) => int(v, 0, 300, `units[${i}]`)); if (u.length !== 5) throw new Error('units must be 5 numbers: spearmen, archers, swordsmen, knights, catapults');
      const id = w().det_form(Uint32Array.from(u)); if (!id) return { ok: false, reason: 'not enough soldiers in the barracks' }; host.commit({ op: 'form', units: u }); host.afterChange(); return { ok: true, army_id: id };
    },
    march_army(a) {
      const id = int(a.army_id, 1, 100000, 'army_id'), world = w(), ox = world.origin_x(), oy = world.origin_y(), dx = int(a.dx, -1100, 1100, 'dx'), dy = int(a.dy, -1100, 1100, 'dy');
      const code = world.det_march(id, ox + dx, oy + dy, false, 0, 0); if (code === 0) host.commit({ op: 'march', idx: id, x: ox + dx, y: oy + dy }); return { ok: code === 0, code };
    },
    recall_army(a) { const id = int(a.army_id, 1, 100000, 'army_id'), code = w().det_recall(id); if (code === 0) host.commit({ op: 'recall', idx: id }); return { ok: code === 0, code }; },
    prices() { return Object.fromEntries(RES.map((r, i) => [r.key, w().prices()[i] / 100])); },
    rivals() { const h = hall(); return host.rivals().map(r => ({ key: r.key, name: r.name, online: r.online, dx: Math.round(r.x - h.x), dy: Math.round(r.z - h.z) })); },
    attack(a) {
      if (!allowAttack) throw new Error('attacking other players is switched off. The human must open the game with allow_attack=1 to allow it.');
      if (a.confirm_attack !== true) throw new Error('attack needs confirm_attack: true. This starts a real battle against another person\'s village.');
      const u = (Array.isArray(a.units) ? a.units : []).map((v, i) => int(v, 0, 300, `units[${i}]`)); if (u.length !== 5) throw new Error('units must be 5 numbers');
      return { ok: host.attack(String(a.key), u) };
    },
  };

  /** Run one call from the MCP server: whitelist, pause, handicap, then the tool. */
  function handle(tool: string, args: Record<string, unknown>): { ok: boolean; result?: unknown; error?: string; retry_after_ms?: number } {
    if (!(AGENT_TOOLS as readonly string[]).includes(tool) || !tools[tool]) return { ok: false, error: `unknown tool ${tool}` };
    if (paused) return { ok: false, error: 'the human has paused the agent' };
    const wait = (MUTATING.has(tool) ? acts : looks).take(Date.now());
    if (wait) return { ok: false, error: `slow down: the agent plays at human pace. Try again in ${Math.ceil(wait / 100) / 10}s.`, retry_after_ms: wait };
    try {
      const result = tools[tool](args);
      if (MUTATING.has(tool)) { count++; log.push(`${tool}${(result as { ok?: boolean })?.ok === false ? ' ✗' : ''}`); if (log.length > 30) log.shift(); show(); }
      return { ok: true, result };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  // ---- the connection ----
  function connect() {
    if (stopped) return;
    ws = new WebSocket(`ws://localhost:${port}`);
    ws.onopen = () => { ws!.send(JSON.stringify({ hello: 'flanders-game', token })); };
    ws.onmessage = ev => {
      let m: { id?: number; tool?: string; args?: Record<string, unknown>; hello?: string };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.hello === 'ok') { connected = true; show(); host.toast('An AI agent is connected. Use the badge at the bottom left to pause it.', 'info'); return; }
      if (typeof m.id !== 'number' || typeof m.tool !== 'string') return;
      const r = handle(m.tool, m.args ?? {}); ws!.send(JSON.stringify({ id: m.id, ...r }));
    };
    ws.onclose = () => { connected = false; show(); if (!stopped) setTimeout(connect, 3000); };
    ws.onerror = () => { try { ws?.close(); } catch { /* already closed */ } };
  }
  connect(); show();
  return { handle, get paused() { return paused; } };
}

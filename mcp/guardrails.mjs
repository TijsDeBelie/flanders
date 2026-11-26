// Guardrails for the Flanders MCP server. The game page enforces the same rules again (web/src/agent.ts): this side stops bad calls before they leave the machine.

/** Calls the agent may make, with whether they change the game. Anything not listed is refused. */
export const TOOLS = {
  observe: { mutating: false }, catalog: { mutating: false }, buildings: { mutating: false }, probe: { mutating: false }, can_place: { mutating: false }, rivals: { mutating: false }, prices: { mutating: false }, choice: { mutating: false }, decide: { mutating: true }, bribe: { mutating: true },
  place: { mutating: true }, upgrade: { mutating: true }, option: { mutating: true }, demolish: { mutating: true, destructive: true }, repair: { mutating: true }, train: { mutating: true },
  garrison: { mutating: true }, drawbridge: { mutating: true }, form_army: { mutating: true }, march_army: { mutating: true }, recall_army: { mutating: true }, defend_army: { mutating: true },
  attack: { mutating: true, aggressive: true },
  // diplomacy (browser game only: the headless server has no neighbours). Reading is free; an envoy and a gift cost goods; a marriage costs 150 gold and binds for good, so it needs
  // `confirm`; a declaration of war is as aggressive as an attack: off unless the human allows it, and `confirm_attack` on top.
  relations: { mutating: false }, envoy: { mutating: true }, gift: { mutating: true }, alliance: { mutating: true }, marriage: { mutating: true, costly: true },
  declare_war: { mutating: true, aggressive: true },
};

/** The most goods one gift may carry (the game itself allows 500): an agent cannot empty the stores in one call. */
export const MAX_GIFT = 100;

/** Things a human player does with the testing tools or outside the game: never reachable from here. */
export const FORBIDDEN = ['cheat', 'flatten', 'model_village', 'reset', 'give_resources', 'set_speed', 'delete_save', 'identity'];

/** A minimum gap between calls plus a per-minute budget. take() returns 0 when allowed (and counts the call) or the milliseconds to wait. */
export class Limiter {
  constructor(gapMs, perMinute, now = () => Date.now()) { this.gapMs = gapMs; this.perMinute = perMinute; this.now = now; this.stamps = []; this.last = -Infinity; }
  take() {
    const t = this.now(), wait = Math.max(0, this.last + this.gapMs - t);
    if (wait > 0) return wait;
    this.stamps = this.stamps.filter(s => t - s < 60000);
    if (this.stamps.length >= this.perMinute) return Math.max(1000, 60000 - (t - this.stamps[0]));
    this.stamps.push(t); this.last = t; return 0;
  }
}

export class Guard {
  /** options: { gapMs, perMinute, lookGapMs, lookPerMinute, maxActions, allowAttack } */
  constructor(options = {}, now = () => Date.now()) {
    const o = { gapMs: 2500, perMinute: 15, lookGapMs: 300, lookPerMinute: 100, maxActions: 3000, allowAttack: false, ...options };
    this.o = o; this.acts = new Limiter(o.gapMs, o.perMinute, now); this.looks = new Limiter(o.lookGapMs, o.lookPerMinute, now); this.demolish = new Limiter(0, 4, now); this.total = 0; this.paused = false;
  }
  /** Returns null when the call may go ahead, otherwise { error, retry_after_ms? }. */
  check(tool, args = {}) {
    if (FORBIDDEN.includes(tool)) return { error: `${tool} is a testing tool and is not available to an agent` };
    const spec = TOOLS[tool]; if (!spec) return { error: `unknown tool ${tool}` };
    if (this.paused) return { error: 'paused by the human' };
    if (spec.aggressive && !this.o.allowAttack) return { error: 'attacking other players is switched off; the human must start the server with --allow-attack and open the game with allow_attack=1' };
    if (spec.aggressive && args.confirm_attack !== true) return { error: 'attack needs confirm_attack: true' };
    if (spec.costly && args.confirm !== true) return { error: `${tool} needs confirm: true (it costs gold and cannot be undone)` };
    if (tool === 'gift' && !(Number.isInteger(args.amount) && args.amount >= 1 && args.amount <= MAX_GIFT)) return { error: `a gift carries 1 to ${MAX_GIFT} goods` };
    if (['envoy', 'gift', 'alliance', 'marriage', 'declare_war'].includes(tool) && (typeof args.key !== 'string' || !args.key || args.key.length > 200)) return { error: `${tool} needs the village's key (see rivals)` };
    if (spec.destructive && args.confirm !== true) return { error: `${tool} needs confirm: true` };
    if (spec.mutating && this.total >= this.o.maxActions) return { error: `this session's budget of ${this.o.maxActions} actions is used up` };
    const wait = (spec.mutating ? this.acts : this.looks).take();
    if (wait) return { error: `slow down: the agent plays at human pace; try again in ${Math.ceil(wait / 100) / 10}s`, retry_after_ms: wait };
    if (spec.destructive) { const w = this.demolish.take(); if (w) return { error: 'too many demolitions this minute', retry_after_ms: w }; }
    if (spec.mutating) this.total++;
    return null;
  }
}

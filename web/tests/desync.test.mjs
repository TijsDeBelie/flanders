// A copy of another player's village, kept with the real core, the real command replay and the real judging rules (net/sync.ts), fed messages in the orders the network can produce.
// Each test is one way a copy used to go wrong (or could): it says what happened and what the game does about it now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { applyCmd, stepTo } from '../src/commands.ts';
import { ReplicaTrack, ResyncPolicy } from '../src/net/sync.ts';
const { World, state_hash_part_names, rules_fingerprint, warm_navigation } = createRequire(import.meta.url)('./.wasm/game_core.js');
const NAMES = state_hash_part_names().split(',');
const SEED = 1337n;
const TOOLS = ['cheat', 'flatten', 'demo'];
/** Every village in these tests starts with a full store (a fixture applied to the world directly, so it is not a command of anybody's history). */
const fresh = () => { const w = new World(SEED, 0, 0); w.cheat(3, 0, 0); return w; };

/** The owner: their village is live; commands are applied, then logged with the tick they happened at; a hash goes out after every tick. */
class Owner {
  constructor() { warm_navigation(SEED); this.w = fresh(); this.log = []; this.n = 0; this.shared = 0; this.tools = false; }
  do(c) { const full = { ...c, tick: Number(this.w.tick()), n: this.n++ }; applyCmd(this.w, full); this.log.push(full); if (TOOLS.includes(c.op)) this.tools = true; else this.shared++; return full; }
  step() { this.w.step(); return this.hash(); }
  hash() { return { tick: Number(this.w.tick()), hash: this.w.state_hash().toString(), c: this.shared, p: Array.from(this.w.state_hash_parts(), x => x.toString()), tools: this.tools }; }
  /** What the others get in a history: everything except the testing tools. */
  get shareable() { return this.log.filter(c => !TOOLS.includes(c.op)); }
}

/** A copy, driven the way main.ts drives it: commands advance it to their tick and apply; hashes are judged and never applied. */
class Copy {
  constructor() { this.w = fresh(); this.track = new ReplicaTrack(); this.verdicts = []; this.now = 0; }
  advance = t => { let n = 0; while (this.w.tick() < BigInt(t) && n++ < 8000) this.w.step(); return this.w.tick() >= BigInt(t); };
  command(c) { assert.ok(this.advance(c.tick), 'a command is never applied at an earlier tick'); applyCmd(this.w, c); this.track.applied(c.op); const v = this.track.recheck(this.w, NAMES, this.advance, this.now); if (v) this.verdicts.push(v); }
  hash(msg) { const v = this.track.judge(msg, this.w, NAMES, this.advance, this.now); this.verdicts.push(v); return v; }
  /** Rebuild from the owner's history, as the `log` message does. */
  load(cmds) { const w = fresh(); for (const c of cmds) { stepTo(w, c.tick); applyCmd(w, c); } this.w = w; this.track.reset(cmds.map(c => c.op)); }
  get kinds() { return [...new Set(this.verdicts.map(v => v.kind))]; }
}

test('the cause: a copy run on by a hash before the command it belongs to arrives applies that command at the wrong tick', () => {
  const o = new Owner();
  for (let i = 0; i < 20; i++) o.step();
  const cmd = o.do({ op: 'place', kind: 0, x: 12, y: 4, rot: 0 });   // issued at tick 20, signed and sent a moment later...
  const next = o.step();                                              // ...and the owner has already hashed tick 21
  // the old copy: the hash overtook the command (it was handled at once, while the command was still being checked), so the copy ran on to 21 and applied the command there
  const old = new Copy(); old.advance(next.tick); applyCmd(old.w, cmd);
  const ref = new Copy(); ref.advance(20); applyCmd(ref.w, cmd); ref.advance(next.tick);
  assert.equal(ref.w.state_hash().toString(), next.hash, 'applied at its own tick, the copy matches the owner');
  assert.notEqual(old.w.state_hash(), ref.w.state_hash(), 'applied a tick late it is a different village');
  // the new copy knows a command is missing (the hash counts one more than it has), so it waits instead of running on
  const c = new Copy(); c.advance(20);
  assert.deepEqual(c.hash(next), { kind: 'wait', missing: 1 });
  assert.equal(Number(c.w.tick()), 20, 'it stayed at the tick the command belongs to');
  c.command(cmd);
  assert.equal(c.verdicts.at(-1).kind, 'match', 'the waiting hash is judged as soon as the command has been applied');
});

test('a hash that follows a command sent in the same tick is no desync', () => {
  // inside one tick the owner commits (checkArrivals, caravans) before it broadcasts: the hash already holds the command's effect, and the command itself is signed and sent a moment later
  const o = new Owner(), c = new Copy();
  for (let i = 0; i < 12; i++) c.hash(o.step());
  const cmd = o.do({ op: 'place', kind: 0, x: 12, y: 4, rot: 0 });
  const h = o.hash();                      // hash first on the wire, then the command
  assert.equal(c.hash(h).kind, 'wait');
  c.command(cmd);
  assert.deepEqual(c.kinds.filter(k => k !== 'match'), ['wait'], 'only ever "wait": never "mismatch"');
});

test('a command lost on the way is noticed as a missing command, not mistaken for a disagreement, and the history repairs it', () => {
  const o = new Owner(), c = new Copy();
  o.do({ op: 'place', kind: 0, x: 12, y: 4, rot: 0 }); const lost = o.do({ op: 'place', kind: 0, x: 18, y: 8, rot: 0 }); o.do({ op: 'place', kind: 1, x: -14, y: 6, rot: 0 });
  for (const x of o.log) if (x !== lost) c.command(x);      // a history older than the command, the live copy dropped before the sender was introduced
  for (let i = 0; i < 30; i++) { const h = o.step(); c.now += 500; c.hash(h); }
  assert.ok(c.kinds.includes('lost'), `reported: ${c.kinds}`);
  assert.ok(!c.kinds.includes('mismatch'), 'and not called a mismatch');
  c.load(o.shareable); c.advance(Number(o.w.tick()) - 1);   // ask for the history again, rebuild, compare again
  assert.equal(c.hash(o.step()).kind, 'match');
});

test('a copy that really differs names the section, and a rebuild from the owner\'s history repairs it', () => {
  const o = new Owner(), c = new Copy();
  for (const x of [{ op: 'place', kind: 0, x: 12, y: 4, rot: 0 }, { op: 'place', kind: 1, x: -14, y: 6, rot: 0 }]) c.command(o.do(x));
  for (let i = 0; i < 10; i++) c.hash(o.step());
  assert.equal(c.verdicts.at(-1).kind, 'match');
  c.w.cheat(0, 3, -40);                          // something changes the copy that the owner never did (a stray local action)
  const bad = c.hash(o.step());
  assert.equal(bad.kind, 'mismatch'); assert.deepEqual(bad.diag.parts, ['stock']);
  assert.equal(bad.diag.goodTick, 10, 'the last matching tick is recorded');
  c.load(o.shareable); c.advance(Number(o.w.tick()) - 1);
  assert.equal(c.hash(o.step()).kind, 'match', 'rebuilt from their history, the copy agrees again');
});

test('testing tools are announced, so a village the others cannot replay is not called broken', () => {
  const o = new Owner(), c = new Copy();
  o.do({ op: 'cheat', kind: 0, x: 3, y: -30 });
  assert.equal(c.hash(o.step()).kind, 'tools');
});

test('building, marching through woods and linking replay to the same state', () => {
  const o = new Owner(), c = new Copy();
  const go = (cmd, ticks) => { c.command(o.do(cmd)); for (let i = 0; i < ticks; i++) c.hash(o.step()); };
  go({ op: 'place', kind: 19, x: -20, y: 16, rot: 0 }, 20); go({ op: 'place', kind: 0, x: 12, y: 4, rot: 0 }, 10);
  o.w.cheat(2, 0, 10); c.w.cheat(2, 0, 10);   // soldiers for the barracks (a fixture on both sides)
  go({ op: 'form', units: [8, 0, 0, 0, 0] }, 2); go({ op: 'march', idx: 1, x: 110, y: 40 }, 300); go({ op: 'link', x: 400, y: 120 }, 100);
  assert.ok(!c.kinds.includes('mismatch') && !c.kinds.includes('lost'), `the copy never disagreed: ${c.kinds}`);
  assert.equal(c.w.state_hash(), o.w.state_hash());
});

test('a copy far behind catches up in one go, and a forged hash from the far future does not run it away', () => {
  const o = new Owner(), c = new Copy();
  for (let i = 0; i < 500; i++) o.step();
  const h = o.hash();
  assert.equal(c.hash(h).kind, 'match', 'five hundred ticks of silence, then one hash: the copy plays them');
  const forged = { ...h, tick: 250_000 };
  assert.equal(c.hash(forged).kind, 'behind', 'advancing is capped, so the stranger\'s tick 250000 is not followed');
  assert.ok(Number(c.w.tick()) <= 500 + 8000, 'the copy was not run all the way');
});

test('the rules fingerprint is stable and the parts are named', () => {
  warm_navigation(SEED);
  assert.equal(rules_fingerprint(SEED), rules_fingerprint(SEED));
  assert.match(rules_fingerprint(SEED), /^[0-9a-f]{16}$/);
  assert.equal(new World(SEED, 0, 0).state_hash_parts().length, NAMES.length);
});

test('the re-sync policy backs off for a copy that keeps going wrong', () => {
  // (the policy no longer gives up after a fixed number of requests: it waits twice as long after each one, up to MAX_GAP, so a copy that keeps
  // going wrong is asked about rarely but never abandoned)
  const p = new ResyncPolicy(); const asked = []; let now = 0;
  for (let i = 0; i < 400; i++) { now += 2000; if (p.ask(now) === 'go') asked.push(now); }   // a mismatch every two seconds for about thirteen minutes
  assert.equal(asked[0], 2000, 'the first mismatch is asked about at once');
  const gaps = asked.slice(1).map((t, i) => t - asked[i]);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `the waits never shrink: ${gaps}`);
  assert.ok(gaps.every(g => g >= ResyncPolicy.GAP && g <= ResyncPolicy.MAX_GAP + 2000), 'each wait is between GAP and MAX_GAP');
  assert.ok(asked.length <= 12, `few requests however long it goes on: ${asked.length}`);
  assert.ok(asked.at(-1) > 600_000, 'but it keeps asking');
});

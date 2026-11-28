// The scripted tutorial village against the real core: replay its build order and check that the guide gets through every step. Needs the node build of the core (npm run test:demo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hashSeed } from '../src/worldname.ts';
import { countsOf } from '../src/goals.ts';
import { STEPS, stepAfter } from '../src/tutorial.ts';
import { TUTORIAL_WORLD, TUTORIAL_SCRIPT } from '../src/tutorialvillage.ts';
const { World, village_sites } = createRequire(import.meta.url)('./.wasm/game_core.js');

const found = () => { const f = village_sites(hashSeed(TUTORIAL_WORLD)); const s = []; for (let i = 0; i < f.length; i += 2) s.push([f[i], f[i + 1]]); s.sort((a, b) => Math.hypot(...a) - Math.hypot(...b)); return s[0].map(Math.round); };

/** Play the script; `guide` follows the village the way the Tutorial class does (pressing Next on information steps). Returns the order in which the guide's steps were reached. */
function play(untilTick) {
  const [ox, oz] = found(), w = World.new_legacy(hashSeed(TUTORIAL_WORLD), ox, oz), seen = [0]; let step = 0, i = 0;
  const follow = () => { const c = countsOf(w, 0); for (;;) { let n = stepAfter(step, c); if (n === step && step < STEPS.length && !STEPS[step].done) n = step + 1; if (n === step) break; step = n; seen.push(step); } };
  follow();
  for (let t = 0; t <= untilTick; t++) {
    while (i < TUTORIAL_SCRIPT.length && TUTORIAL_SCRIPT[i].at <= Number(w.tick())) {
      const a = TUTORIAL_SCRIPT[i++];
      if (a.op === 'rebuild') {   // the barracks, the tower and the workshops first, then the rest (each rebuild shifts the list, so look again after one)
        const order = [19, 3, 5, 6, 4, 16];
        for (let tries = 0; tries < 20; tries++) {
          const ru = Array.from(w.ruins_flat()), idx = [...Array(ru.length / 6).keys()].sort((p, q) => { const rp = order.indexOf(ru[p * 6 + 3]), rq = order.indexOf(ru[q * 6 + 3]); return (rp < 0 ? 99 : rp) - (rq < 0 ? 99 : rq); });
          if (!idx.some(k => w.rebuild(k) === 0)) break;
        }
        continue;
      }
      const r = a.op === 'place' ? w.place(a.kind, a.dx, a.dy, 0) : a.op === 'train' ? w.train(a.kind, a.n) : w.upgrade(0);
      if (r === -6) { i--; break; }   // not affordable yet: a player waits for the stores and tries again (raids and fires make the exact tick vary)
      assert.ok(a.op === 'place' ? r >= 0 : r === 0, `${a.op} ${JSON.stringify(a)} at tick ${w.tick()} was refused (${r})`);
    }
    w.step(); if (t % 20 === 0) follow();
  }
  follow(); return { w, step, seen };
}

test('the tutorial world starts the same every time', () => {
  assert.deepEqual(found(), [0, 0]);
  const a = World.new_legacy(hashSeed(TUTORIAL_WORLD), 0, 0), b = World.new_legacy(hashSeed(TUTORIAL_WORLD), 0, 0);
  assert.equal(a.state_hash().toString(), b.state_hash().toString());
});
test('the build order reaches every step of the guide, in order', () => {
  const { step, seen, w } = play(4200);   // (17.5 days: since newcomers arrive a few a day and only to full stores, the village grows more slowly than it did)
  assert.equal(step, STEPS.length, `stopped at step ${step}: ${STEPS[step]?.title}; pop ${w.population()}, tick ${w.tick()}`);
  assert.deepEqual(seen, [...seen].sort((x, y) => x - y)); assert.equal(new Set(seen).size, seen.length);
});
test('the same script gives the same village twice', () => {
  assert.equal(play(1500).w.state_hash().toString(), play(1500).w.state_hash().toString());
});

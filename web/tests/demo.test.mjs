// The model village must have complete walls and room between the walls and the buildings (built in Node with the real core, no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildDemo, wallReport } from './demo.mjs';
const defs = JSON.parse(createRequire(import.meta.url)('./.wasm/game_core.js').catalog());
const SEEDS = [1337n, 7n, 1n, 99999n, 424242n, 31337n];
const BARRIERS = [2, 22], NOT_BUILDINGS = [24, 23, 21, 32, 33, 34];

for (const seed of SEEDS) test(`seed ${seed}: the curtain walls are closed rings and the moat is unbroken`, () => {
  const w = buildDemo(seed), r = wallReport(w);
  for (const ring of ['inner', 'outer']) { assert.equal(r[ring].holes, 0, `${ring} wall has holes: ${JSON.stringify(r[ring])}`); assert.ok(r[ring].pieces >= 24, `${ring} wall has ${r[ring].pieces} pieces`); }
  const f = w.buildings_flat(), moat = [];
  for (let i = 0; i < f.length / 10; i++) if (f[i * 10] === 24) moat.push({ x: f[i * 10 + 2], y: f[i * 10 + 3] });
  moat.sort((p, q) => Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x));
  assert.ok(moat.length >= 60 && moat.every((p, i) => Math.hypot(p.x - moat[(i + 1) % moat.length].x, p.y - moat[(i + 1) % moat.length].y) <= 8), 'the moat has no gap');
});

for (const seed of SEEDS.slice(0, 3)) test(`seed ${seed}: buildings keep clear of the walls`, () => {
  const w = buildDemo(seed), f = w.buildings_flat(), walls = [], others = [];
  for (let i = 0; i < f.length / 10; i++) { const k = f[i * 10], b = { k, x: f[i * 10 + 2], y: f[i * 10 + 3], r: defs[k].r }; if (BARRIERS.includes(k)) walls.push(b); else if (!NOT_BUILDINGS.includes(k)) others.push(b); }
  const gap = o => Math.min(...walls.map(wl => Math.hypot(o.x - wl.x, o.y - wl.y) - o.r - wl.r));
  for (const o of others) assert.ok(gap(o) >= (o.k === 3 ? 1.0 : 2.5), `${defs[o.k].name} at ${o.x.toFixed(0)},${o.y.toFixed(0)} is only ${gap(o).toFixed(1)} from a wall`);
  assert.ok(others.filter(o => o.k === 0).length >= 12, 'the bailey has its houses');
});

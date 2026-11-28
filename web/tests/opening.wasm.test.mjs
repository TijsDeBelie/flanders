// The opening: a hall, a house and a farm must not run out of food before the first harvests, on any of the audit's sites.
// Runs the real core under node (built by `npm run test:demo`). The full picture is tools/balance-audit.mjs; this is its first row, kept as a guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { World, catalog, village_sites } = createRequire(import.meta.url)('./.wasm/game_core.js');
const defs = JSON.parse(catalog());
const kind = name => defs.findIndex(def => def.name === name);
const HOUSE = kind('House'), FARM = kind('Farm');
const SEEDS = [1n, 7n, 42n, 73n, 101n, 337n, 1337n, 2026n, 31337n, 99999n, 424242n, 8675309n];
const DAY = 240;
const food = World.food_table();
const meals = s => { let t = 0; for (let i = 0; i < food.length; i += 2) t += s[food[i]] * food[i + 1] / 4; return t; };

function nearestSite(seed) {
  const flat = village_sites(seed), sites = [];
  for (let i = 0; i < flat.length; i += 2) sites.push([flat[i], flat[i + 1]]);
  const [x, y] = sites.sort((a, b) => Math.hypot(...a) - Math.hypot(...b))[0];
  return [Math.round(x), Math.round(y)];
}
function place(w, b) {
  for (let r = 8; r <= Math.ceil(w.build_radius()); r += 2) for (let i = 0; i < Math.ceil(Math.PI * r); i++) {
    const a = i * 2 * Math.PI / Math.ceil(Math.PI * r), x = Math.round(r * Math.cos(a)), y = Math.round(r * Math.sin(a));
    if (w.can_place(b, x, y) === 0 && w.place(b, x, y, 0) >= 0) return true;
  }
  return false;
}

test('a hall, a house and a farm never run out of food in the first two days', () => {
  const dry = [];
  for (const seed of SEEDS) {
    const w = new World(seed, ...nearestSite(seed));
    assert.ok(place(w, HOUSE) && place(w, FARM), `seed ${seed}: the opening could be built`);
    let low = Infinity;
    for (let t = 0; t < 2 * DAY; t++) { w.step(); low = Math.min(low, meals(Array.from(w.stocks()))); }
    if (low < 1) dry.push(`${seed} (pop ${w.population()})`);
    w.free();
  }
  assert.deepEqual(dry, [], 'sites whose larder ran empty');
});

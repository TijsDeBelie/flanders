// Builds the model village in Node (no browser) and reports how complete its walls are. Usage: node --experimental-strip-types tests/demo.mjs
import { createRequire } from 'node:module';
import { buildModelVillage } from '../src/modelvillage.ts';
const require = createRequire(import.meta.url);
const { World, catalog } = require('./.wasm/game_core.js');
const defs = JSON.parse(catalog());
export function buildDemo(seed = 1337n) {
  const w = new World(seed, 0, 0);
  w.cheat(8, 0, 0); w.flatten(Number(process.env.FLAT ?? 80));
  const fill = () => w.cheat(3, 0, 0);
  const api = {
    place(kind, x, y, rot = 0, search = 8, ok = () => true) {
      for (let r = 0; r <= search; r += 1.5) for (let k = 0; k < (r ? 8 : 1); k++) {
        const a = k * Math.PI / 4 + r, px = Math.round(x + Math.cos(a) * r), py = Math.round(y + Math.sin(a) * r);
        const st = Array.from(w.stocks()); if (defs[kind].cost.some(([res, n]) => st[res] < n)) fill();
        if (!ok(px, py)) continue;
        const i = w.place(kind, px, py, rot); if (i >= 0) return i;
      }
      return -1;
    },
    upgrade(i) { let c = w.upgrade(i); if (c === -6) { fill(); c = w.upgrade(i); } return c === 0; },
    option(i, bit) { let c = w.set_option(i, bit, true); if (c === -6) { fill(); c = w.set_option(i, bit, true); } return c === 0; },
    garrison(i, n) { w.garrison_set(i, n); },
    wet(x, y) { return w.height_at(w.origin_x() + x, w.origin_y() + y) < 0; },
    at(i) { const f = w.buildings_flat(); return [f[i * 10 + 2] - w.origin_x(), f[i * 10 + 3] - w.origin_y()]; },
    fill, soldiers(kind, n) { w.cheat(2, kind, n); },
  };
  buildModelVillage(api);
  return w;
}
/** Walls (and gates) by ring: gaps between neighbours bigger than the 8.6 the renderer joins across. */
export function wallReport(w) {
  const f = w.buildings_flat(), pts = [];
  for (let i = 0; i < f.length / 10; i++) if (f[i * 10] === 2 || f[i * 10] === 22) pts.push({ x: f[i * 10 + 2], y: f[i * 10 + 3], r: Math.hypot(f[i * 10 + 2], f[i * 10 + 3]) });
  const rings = { inner: pts.filter(p => p.r < 36), outer: pts.filter(p => p.r >= 36) }, out = {};
  for (const [name, ring] of Object.entries(rings)) {
    // go once round the ring by angle: any step bigger than the 8.6 that wall pieces join across is a hole in the wall
    const sorted = [...ring].sort((p, q) => Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x));
    let holes = 0, worst = 0;
    sorted.forEach((p, i) => { const q = sorted[(i + 1) % sorted.length], d = Math.hypot(p.x - q.x, p.y - q.y); if (d > 8.6) holes++; worst = Math.max(worst, d); });
    out[name] = { pieces: ring.length, holes, worst: Math.round(worst * 10) / 10 };
  }
  return out;
}
if (process.argv[1]?.endsWith('demo.mjs')) { const w = buildDemo(); console.log(JSON.stringify({ buildings: w.building_count(), ...wallReport(w) })); }

// Every building model builds, and every material in it can be tinted the way the placement ghost does it (it clones the material and gives it an emissive colour,
// which only a standard material draws: a basic material in the iron mine's door made the game throw while you hovered the mine over the ground).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadBuildings, closeModels } from './models.mjs';
const defs = JSON.parse(createRequire(import.meta.url)('./.wasm/game_core.js').catalog());
const B = await loadBuildings();
test.after(() => closeModels());

test('every kind, tier and option set builds with materials that take a tint', () => {
  for (let kind = 0; kind < defs.length; kind++) for (const tier of [0, 1, 2, 3]) for (const opts of [0, 15]) {
    const g = B.buildModel(kind, tier, 0x2f5fa8, 1, opts, undefined, false);
    g.traverse(o => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) assert.ok(m.isMeshStandardMaterial, `${defs[kind].name} tier ${tier} options ${opts}: a ${m.type} cannot be tinted by the ghost`);
    });
  }
});

test('the placement ghost can be made from the iron mine and the gold mine', () => {
  for (const kind of [9, 10]) {
    const g = B.buildModel(kind, 0, 0x2f5fa8, 0);
    g.traverse(o => { if (!o.isMesh) return; const c = o.material.clone(); c.transparent = true; c.emissive.setHex(0x22cc55); c.emissiveIntensity = 0.32; assert.ok(c.isMeshStandardMaterial); });
  }
});

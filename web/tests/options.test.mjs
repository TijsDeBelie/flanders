// Optional design upgrades are separate parts of a building's model: switching one on or off builds or removes only that part, the bare building is left alone, and the result is
// the same as building the whole thing afresh with those options. A tower's spire takes the place of its roof and stands on it. (Real models in Node, no browser.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { loadBuildings, closeModels } from './models.mjs';
const defs = JSON.parse(createRequire(import.meta.url)('./.wasm/game_core.js').catalog());
const B = await loadBuildings();
test.after(() => closeModels());
const PLAIN = new Set([2, 21, 22, 24, 32, 33, 34, 37, 38]);
const kinds = defs.map((_, k) => k).filter(k => !PLAIN.has(k));

const tris = g => { let n = 0; g.traverse(o => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return n; };
const box = g => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g); };
const near = (a, b, what) => { for (const k of ['x', 'y', 'z']) { assert.ok(Math.abs(a.min[k] - b.min[k]) < 1e-4 && Math.abs(a.max[k] - b.max[k]) < 1e-4, `${what}: bounding boxes differ (${a.min.toArray().map(v => v.toFixed(2))}..${a.max.toArray().map(v => v.toFixed(2))} against ${b.min.toArray().map(v => v.toFixed(2))}..${b.max.toArray().map(v => v.toFixed(2))})`); } };

test('every kind and tier: any move between option sets leaves the bare building untouched and equals a fresh build', () => {
  let checked = 0;
  for (const kind of kinds) for (const tier of [0, 1, 2, 3]) {
    const m = new B.BuildingModel(kind, tier, 0x2f5fa8, 1, undefined, true);
    const keep = m.base.children.filter(c => !c.userData.slot), disposed = new Set();
    for (const c of keep) c.traverse(o => { if (o.isMesh) o.geometry.addEventListener('dispose', () => disposed.add(o)); });
    const order = [0, 5, 10, 15, 12, 3, 8, 1, 14, 2, 4, 15, 0, 9, 6, 15, 7, 0];   // adds, removes and mixed moves, ending on the full set and the bare building
    for (const mask of order) {
      m.setOptions(mask);
      const fresh = B.buildModel(kind, tier, 0x2f5fa8, 1, mask, undefined, true), what = `${defs[kind].name} tier ${tier} options ${mask}`;
      assert.equal(tris(m.group), tris(fresh), `${what}: triangle count`);
      near(box(m.group), box(fresh), what);
      assert.deepEqual(m.base.children.filter(c => !c.userData.slot), keep, `${what}: the base's own parts are the same objects`);
      assert.equal(disposed.size, 0, `${what}: no base mesh was disposed`);
      assert.equal(m.parts.size, [0, 1, 2, 3].filter(b => (mask >> b) & 1).length, `${what}: one group per option that is on`);
      checked++;
    }
  }
  assert.ok(checked > 2000);
});

test('the village view adds only the new item: same base meshes, scaffold only on the new part, batching still works', () => {
  const view = new B.VillageView(0x2f5fa8), radii = defs.map(d => d.r);
  const flat = kind => new Float32Array([kind, 1, 10, 20, 0, 0, 0, 100, 0, 0]);
  for (const kind of [0, 3, 15, 17, 19, 39]) {
    view.animateNew = false;
    view.sync(flat(kind), radii, undefined, [0]);
    const g = view.groupOf(0), base = g.userData.model.base, before = [...base.children], kids = [...g.children];
    for (let i = 0; i < 400 && !view.isBatched; i++) view.update(0.1);
    assert.ok(view.isBatched, `${defs[kind].name}: the village batches`);
    view.animateNew = true;
    view.sync(flat(kind), radii, undefined, [1]);
    assert.equal(view.groupOf(0), g, 'the same group');
    assert.equal(g.userData.model.base, base);
    assert.deepEqual(base.children.filter(c => !c.userData.slot), before.filter(c => !c.userData.slot), `${defs[kind].name}: base children are the same objects`);
    assert.ok(!view.isBatched, 'the square is unbatched while the item goes up');
    for (const c of before) c.traverse(o => { if (o.isMesh) assert.ok(o.visible, 'the base stays visible while the new item is built'); });
    assert.ok(g.children.length > kids.length, 'a group was added for the new item');
    assert.ok(view.batchRoot.children.length >= 1, 'a scaffold stands round the new item');
    for (let i = 0; i < 800; i++) view.update(0.1);
    assert.ok(view.isBatched, `${defs[kind].name}: batched again after the build`);
    view.sync(flat(kind), radii, undefined, [0]);   // and taking it away again
    assert.deepEqual(base.children.filter(c => !c.userData.slot), before.filter(c => !c.userData.slot));
    assert.equal(g.userData.model.parts.size, 0);
  }
});

test('a tower with a spire: the roof is swapped for a steep spire that stands on the same footing, and nothing floats', () => {
  for (const tier of [0, 1, 2, 3]) {
    const bare = B.buildModel(3, tier, 0x2f5fa8, 1, 0, undefined, false), spire = B.buildModel(3, tier, 0x2f5fa8, 1, 4, undefined, false);
    const slot = bare.children[0].children.find(c => c.userData.slot === 'roof'), roof = box(slot), part = spire.children.find(c => c.userData.option === 2);
    assert.ok(slot && part, 'the roof is a slot, the spire a part');
    assert.ok(!spire.children[0].children.some(c => c.userData.slot === 'roof'), 'the old roof is gone');
    const roofs = []; part.traverse(o => { if (o.isMesh && ['Cone', 'Extrude'].includes(o.geometry.type.replace('Geometry', '')) && box(o).getSize(new THREE.Vector3()).y > 2) roofs.push(o); });
    assert.ok(roofs.length >= 1, 'a tall roof is built');
    const sp = box(roofs[0]);
    assert.ok(Math.abs(sp.min.y - roof.min.y) < 0.02, `tier ${tier}: the spire stands where the roof stood (${sp.min.y.toFixed(2)} against ${roof.min.y.toFixed(2)})`);
    assert.ok(Math.abs((sp.max.x - sp.min.x) - (roof.max.x - roof.min.x)) < 0.3 || tier >= 2, 'on the same footprint');
    assert.ok(box(part).max.y > roof.max.y + 1.5, 'and rises well above the old roof');
    // its foot rests on the top of something that is still there (the posts or the stair turret), over the roof's own footprint
    const foot = box(roofs[0]).min.y, supports = []; spire.children[0].traverse(o => { if (o.isMesh) { const bb = box(o); if (Math.abs(bb.max.y - foot) < 0.06 && bb.max.x > sp.min.x && bb.min.x < sp.max.x && bb.max.z > sp.min.z && bb.min.z < sp.max.z) supports.push(o); } });
    assert.ok(supports.length >= 1, `tier ${tier}: the spire has something under its foot`);
    // the finial is on the tip
    let tip = null; part.traverse(o => { if (o.isMesh && o.geometry.type === 'IcosahedronGeometry') tip = box(o); });
    assert.ok(tip && Math.abs(tip.getCenter(new THREE.Vector3()).y - sp.max.y) < 0.4, 'the gilded tip sits on the apex');
  }
});

test('auditModel reports nothing for any kind, tier and option combination', () => {
  const bad = [];
  for (const kind of kinds) for (const tier of [0, 1, 2, 3]) for (let o = 0; o < 16; o++) { const r = B.auditModel(kind, tier, o); if (r.length) bad.push(`${defs[kind].name} tier ${tier} options ${o}: ${r[0]}`); }
  assert.deepEqual(bad.slice(0, 5), []);
});

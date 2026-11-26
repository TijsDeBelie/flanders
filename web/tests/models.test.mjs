// Every building model builds, and every material in it can be tinted the way the placement ghost does it (it clones the material and gives it an emissive colour,
// which only a standard material draws: a basic material in the iron mine's door made the game throw while you hovered the mine over the ground).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadBuildings, closeModels } from './models.mjs';
const defs = JSON.parse(createRequire(import.meta.url)('./.wasm/game_core.js').catalog());
const B = await loadBuildings();
test.after(() => closeModels());

test('batched buildings remain pickable and skip distant detail triangles', async () => {
  const THREE = await import('three');
  const view = new B.VillageView(0x2f5fa8);
  const flat = Float32Array.of(0, 2, 20, 20, 0, 0, 4, 0, 0, 0);
  view.sync(flat, defs.map(d => d.r), Float32Array.of(100, 100, 0), [0]);
  view.root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(20, 30, 20), new THREE.Vector3(0, -1, 0));
  assert.equal(view.pick(ray), 0);
  view.update(0.2, new THREE.Vector3(20, 20, 20), 40);
  assert.ok(view.isBatched);
  assert.equal(view.pick(ray), 0, 'the original geometry is still selectable');
  const total = () => view.batchRoot.children.reduce((n, mesh) => n + Math.min(mesh.geometry.attributes.position.count, mesh.geometry.drawRange.count), 0);
  const near = total();
  view.update(0.01, new THREE.Vector3(200, 60, 200), 40);
  assert.ok(total() < near, 'distant rendering omits fine detail');
  assert.equal(view.pick(ray), 0);
  view.update(0.01, new THREE.Vector3(20, 20, 20), 40);
  assert.equal(total(), near);
  view.syncState(flat, defs.map(d => d.r), Float32Array.of(30, 100, 0), [0]);
  view.root.updateMatrixWorld(true);
  assert.equal(view.pick(ray), 0, 'damage restores and recolors the individual model');
});

test('every kind, tier and option set builds with materials that take a tint', () => {
  for (let kind = 0; kind < defs.length; kind++) for (const tier of [0, 1, 2, 3]) for (const opts of [0, 15, 255]) {
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

test('the mine\'s spoil shelf does not share a top face with the stone footing option (it z-fought the door pad)', () => {
  for (const kind of [9, 10]) for (const tier of [0, 1, 2, 3]) {
    const g = B.buildModel(kind, tier, 0x2f5fa8, 0, 8);
    g.updateMatrixWorld(true);
    const boxes = [];
    g.traverse(o => { if (o.isMesh && o.visible) { o.geometry.computeBoundingBox(); const w = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); boxes.push(w); } });
    const flat = boxes.filter(x => Math.abs(x.max.y - x.min.y - 0.3) < 1e-3 && Math.abs(x.min.y) < 1e-3);
    assert.ok(flat.length >= 1, `kind ${kind} tier ${tier}: the footing is there`);
    const foot = flat.reduce((a, c) => (c.max.x - c.min.x > a.max.x - a.min.x ? c : a));
    for (const x of boxes) {
      if (x === foot) continue;
      const overlapXZ = x.min.x < foot.max.x && x.max.x > foot.min.x && x.min.z < foot.max.z && x.max.z > foot.min.z;
      if (!overlapXZ) continue;
      for (const y of [x.min.y, x.max.y]) assert.ok(Math.abs(y - foot.max.y) > 1e-3, `kind ${kind} tier ${tier}: a face at the footing's top height ${foot.max.y}`);
    }
  }
});

// The watermill: its stone footing stops at the bank (the core's WHEEL_FOOT, 3.2 from the house's middle) and the wheel hangs out over the water on an axle WHEEL_REACH (5.2) out, clear of the footing.
test('the watermill footing ends before the wheel starts, at every tier', async () => {
  const THREE = await import('three');
  for (const tier of [0, 1, 2, 3]) {
    const g = B.buildModel(29, tier, 0x2f5fa8, 1, 0, undefined, false); g.updateMatrixWorld(true);
    const foot = g.getObjectByName('footing'), wheel = g.getObjectByName('wheel');
    assert.ok(foot && wheel, `tier ${tier}: footing and wheel are named`);
    const fb = new THREE.Box3().setFromObject(foot), wb = new THREE.Box3().setFromObject(wheel);
    assert.ok(Math.abs(fb.max.x - 3.2) < 1e-3, `tier ${tier}: the footing ends at the bank, ${fb.max.x}`);
    assert.ok(wb.min.x - fb.max.x >= 1.0, `tier ${tier}: the wheel (from ${wb.min.x}) hangs clear of the footing (to ${fb.max.x})`);
    assert.ok(Math.abs((wb.min.x + wb.max.x) / 2 - 5.2) < 0.05, `tier ${tier}: the axle is 5.2 out, ${(wb.min.x + wb.max.x) / 2}`);
    assert.ok(fb.max.y < 0.5 && wb.min.y < 0, `tier ${tier}: the wheel dips below the footing's level`);
  }
});

// The fishing hut: its stone footing ends at 1.5 from the middle at most, the core stands the hut HUT_FOOT (3.8) from the bank, and the jetty carries on over the water.
test('the fishing hut footing stays well short of the bank, at every tier', async () => {
  const THREE = await import('three');
  for (const tier of [0, 1, 2, 3]) {
    const g = B.buildModel(41, tier, 0x2f5fa8, 1, 0, undefined, false); g.updateMatrixWorld(true);
    const foot = g.getObjectByName('footing');
    assert.ok(foot, `tier ${tier}: footing is named`);
    const fb = new THREE.Box3().setFromObject(foot);
    assert.ok(fb.max.x <= 1.5 + 1e-3, `tier ${tier}: the footing ends at ${fb.max.x}, short of the bank (3.8 out)`);
    assert.ok(Math.abs(fb.max.z) <= 1.45 + 1e-3 && Math.abs(fb.min.z) <= 1.45 + 1e-3, `tier ${tier}: the footing's sides stay within 1.45`);
  }
});

test('the fishing hut jetty starts where the footing ends and the drying rack stays behind the footing front', async () => {
  const THREE = await import('three');
  for (const tier of [0, 1, 2, 3]) {
    const g = B.buildModel(41, tier, 0x2f5fa8, 1, 0, undefined, false); g.updateMatrixWorld(true);
    const fb = new THREE.Box3().setFromObject(g.getObjectByName('footing'));
    let planks = 0;
    g.traverse(o => { if (!o.isMesh) return; const bb = new THREE.Box3().setFromObject(o), s = bb.getSize(new THREE.Vector3());
      if (Math.abs(s.x - 0.44) < 1e-3 && Math.abs(s.y - 0.1) < 1e-3) { planks++; assert.ok(bb.min.x >= fb.max.x - 1e-3, `tier ${tier}: a jetty plank (from ${bb.min.x}) lies over the footing (to ${fb.max.x})`); } });
    assert.ok(planks >= 6, `tier ${tier}: the jetty planks are found`);
  }
});

test('the fishing hut design options stay on the land side, off the jetty', async () => {
  const THREE = await import('three');
  for (const tier of [0, 1, 2, 3]) for (const seed of [0, 1, 2, 3, 4, 5]) for (let bit = 0; bit < 4; bit++) {
    const base = B.buildModel(41, tier, 0x2f5fa8, seed, 0, undefined, false), on = B.buildModel(41, tier, 0x2f5fa8, seed, 1 << bit, undefined, false);
    base.updateMatrixWorld(true); on.updateMatrixWorld(true);
    const landX = (3.0 + tier * 0.3) / 2 - 0.45;
    on.traverse(o => { if (!o.isMesh || o.parent === null) return; let p = o, opt = false; while (p) { if (p.userData && p.userData.part === 'option') opt = true; p = p.parent; }
      if (!opt) return; const bb = new THREE.Box3().setFromObject(o); assert.ok(bb.max.x <= landX + 0.13, `tier ${tier} seed ${seed} option ${bit}: a part reaches x ${bb.max.x}, past the land (${landX})`); });
  }
});

test('the watermill\'s stone-footing option lies under the house only, clear of the wheel', async () => {
  const THREE = await import('three');
  for (const tier of [0, 1, 2, 3]) for (const opts of [8, 15]) {
    const g = B.buildModel(29, tier, 0x2f5fa8, 1, opts, undefined, false); g.updateMatrixWorld(true);
    const foot = g.getObjectByName('optfooting'), wheel = g.getObjectByName('wheel');
    assert.ok(foot && wheel, `tier ${tier} options ${opts}: footing option and wheel exist`);
    const fb = new THREE.Box3().setFromObject(foot), wb = new THREE.Box3().setFromObject(wheel);
    assert.ok(fb.max.x <= 3.2 + 1e-3 && wb.min.x - fb.max.x >= 1.0, `tier ${tier} options ${opts}: footing ends at ${fb.max.x}, the wheel starts at ${wb.min.x}`);
    g.traverse(o => { if (o.isMesh && o !== foot && !(() => { let q = o; while (q && q !== wheel) q = q.parent; return !!q; })() && o.material?.color?.getHex?.() === foot.material.color.getHex() && o.geometry.type === 'BoxGeometry') { const bb = new THREE.Box3().setFromObject(o); if (bb.max.y - bb.min.y < 0.5 && bb.max.y <= 0.45) assert.ok(bb.max.x <= 3.2 + 1e-3 || bb.min.x > wb.max.x, `tier ${tier}: a stone slab runs to ${bb.max.x}`); } });
  }
});

test('the embassy is taken down for new foreign flags and is drawn again by the next sync (it must not stay missing)', async () => {
  const view = new B.VillageView(0xaa3333);
  const flat = Float32Array.of(15, 0, 0, 0, 0, 1, 4, 0, 0, 0,   49, 0, 60, 0, 0, 1, 4, 0, 0, 0);
  const embassies = () => view.root.children.filter(g => g.userData.kind === 49).length;
  view.sync(flat, defs.map(d => d.r));
  assert.equal(embassies(), 1);
  const flag = { pattern: 1, c1: 2, c2: 3, c3: 4, emblem: 1 };
  assert.equal(view.setForeignFlags([flag]), true, 'a new set of flags takes the embassy down, so the caller has to draw it again');
  assert.equal(embassies(), 0);
  view.sync(flat, defs.map(d => d.r));
  assert.equal(embassies(), 1, 'drawn again with the new flags');
  assert.equal(view.setForeignFlags([flag]), false, 'the same flags change nothing');
});

test('far away, the houses of a square are drawn as small proxies, and come back in full when the camera does', async () => {
  const THREE = await import('three');
  const view = new B.VillageView(0x2f5fa8), radii = defs.map(d => d.r);
  // a hall and one house of each tier, all in the same 36-unit square
  const flat = []; flat.push(15, 0, 0, 0, 0, 1, 4, 0, 0, 0); [0, 1, 2, 3].forEach((t, i) => flat.push(0, t, 8 + i * 6, 6, i, 1, 4, 0, 0, 0));
  view.sync(Float32Array.from(flat), radii);
  const near = new THREE.Vector3(0, 30, 20), far = new THREE.Vector3(0, 900, 700), range = 100;
  view.update(1, near, range);   // (the square is merged once it has been quiet for a moment)
  const meshes = () => view.batchRoot.children.filter(m => m.isMesh);
  const proxy = () => meshes().find(m => m.userData.far), houses = () => meshes().filter(m => m.userData.house);
  assert.ok(proxy(), 'the square has a proxy for its houses'); assert.ok(houses().length > 0, 'and its houses are merged apart from the rest');
  const tris = m => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  assert.equal(tris(proxy()), 4 * 18, 'eighteen triangles a house: a box and a gable roof');
  assert.equal(proxy().visible, false); assert.ok(houses().every(m => m.visible), 'close by, the houses are drawn as ever');
  view.update(0.1, far, range);
  assert.equal(proxy().visible, true, 'from far away the proxies stand in for the houses'); assert.ok(houses().every(m => !m.visible));
  view.update(0.1, near, range);
  assert.equal(proxy().visible, false); assert.ok(houses().every(m => m.visible), 'and the houses are back when the camera is');
});

// Smoke test of the renderers' update methods on a small fixture village, built as the production bundle is (minified too): a `let`/`const` used before its line
// (a temporal dead zone) only shows when the code runs, and once crashed Village.syncFull in the live build. Bundles the class with vite (rolldown), then runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { build } from 'vite';
import { Matrix4, Vector3 } from 'three';

const dir = new URL('./.tmp/', import.meta.url);
async function load(entry, minify) {
  const out = await build({
    configFile: false, logLevel: 'silent', root: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    build: { write: false, minify, lib: { entry, formats: ['es'], fileName: 'x' }, rollupOptions: { external: ['three'] } },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output[0];
  mkdirSync(dir, { recursive: true });
  const file = new URL(`bundle-${minify ? 'min' : 'dev'}-${Math.random().toString(36).slice(2)}.mjs`, dir);
  writeFileSync(file, chunk.code);
  return import(file.href);
}

const terrain = { heightAt: (x, z) => Math.sin(x * 0.1) + Math.cos(z * 0.1), heightsHash: () => 0 };
const radii = new Array(60).fill(3);
/** Buildings (stride 10: kind, tier, x, z, rot, pad height, status, ...): the town hall, a house, a farm, a plaza, a moat piece and a wall. */
const village = tier => Float32Array.from([
  15, tier, 0, 0, 0, 1, 4, 0, 0, 0,   1, 0, 14, 6, 0, 1, 4, 0, 0, 0,   4, 0, -14, 6, 0, 1, 4, 0, 0, 0,
  44, 0, 8, -16, 0, 1, 4, 0, 0, 0,   24, 0, 30, 30, 0, 1, 4, 0, 0, 0,   2, 0, 34, 30, 0, 1, 4, 0, 0, 0,
]);
// lines of the core: kind 0 a stub (door to node), kind 1 a stretch of a road laid by hand
// [kind, born, surface, design, n, x, z, ...]: a stub, a stub that is born later, and a road
const linesOf = tier => Float32Array.from([0, 0, 0, 0, 2, 0, 4, 0, 7,   0, 5000, 0, 0, 2, 14, 7, 14, 9,   1, 900, tier, 0, 5, 0, 7, 4, 9, 8, 9, 11, 8, 14, 9,   1, 900, tier, 0, 2, 14, 9, 17, 9]);

for (const minify of [false, true]) {
  test(`Paths.update runs on a village at every castle tier and every road surface (${minify ? 'minified' : 'unminified'} bundle)`, async () => {
    const { Paths } = await load('src/render/paths.ts', minify);
    for (let tier = 0; tier <= 3; tier++) {
      const p = new Paths(terrain);
      p.update(village(tier), linesOf(tier), radii, []);
      const g = p.tracks?.geometry ?? p.group.children[0].geometry;
      assert.ok(g.getAttribute('position').count > 0, `tier ${tier}`);
      for (const v of g.getAttribute('position').array) assert.ok(Number.isFinite(v));
      p.update(village(tier), new Float32Array(0), radii, []);   // no roads at all
    }
  });
}

test('villagers and wildlife build and draw their coloured, instanced parts', async () => {
  const { Crowd, TOOL } = await load('src/render/crowd.ts', true);
  const { Wildlife } = await load('src/render/wildlife.ts', true);
  const crowd = new Crowd();
  const villager = { x: 0, y: 5, z: 0, yaw: 1, pose: 1, phase: 1, body: 0x815453, skin: 0xc68e63, dress: true };
  crowd.begin();
  crowd.addVillager(villager, true);
  crowd.addVillager({ ...villager, x: 1 }, false);
  crowd.add({ ...villager, x: 2, mounted: true, dress: false });
  crowd.add({ ...villager, yaw: 0, pose: 2, tool: TOOL.HOE });
  crowd.end();
  const grip = new Matrix4(); crowd.tools[TOOL.HOE - 1].getMatrixAt(0, grip);
  const bladeDirection = new Vector3(0, 1, 0).transformDirection(grip);
  assert.ok(bladeDirection.y < -0.2 && bladeDirection.z > 0.2, 'a working farmer hoes the ground in front of them');
  const wildlife = new Wildlife(31n, { heightAt: () => 5 }, [{ x: 20, z: 0 }], [0, 0]);
  wildlife.syncDomestic('village', Float32Array.from([
    45, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 10, 0, 0, 5, 0, 0, 0, 0, 46, 0, -12, 0, 0, 5, 0, 0, 0, 0,
  ]));
  wildlife.update(0.1, [], 0, 0, 80);
  assert.equal(wildlife.group.children.filter(mesh => mesh.count > 0).length, 23);
  assert.equal(wildlife.animals.filter(animal => animal.domestic && animal.hx === -12).length, 4);
  assert.equal(crowd.torso.material.map.name, 'linen');
  assert.equal(crowd.dress.material.map, crowd.torso.material.map);
  assert.deepEqual(wildlife.bodies.map(mesh => mesh.material.map.name), ['fur', 'fur', 'fur', 'fur', 'fleece', 'fur', 'feathers', 'hide']);
  for (const group of [crowd.group, wildlife.group]) {
    assert.ok(group.children.some(mesh => mesh.count > 0));
    for (const mesh of group.children) {
      if (!mesh.geometry) continue;   // (the remains' group of stains and ribcages holds its own meshes: see the next test)
      const { position, normal, color } = mesh.geometry.attributes;
      assert.equal(color.count, position.count);
      assert.equal(normal.count, position.count);
      for (const attribute of [position, normal, color]) assert.ok(attribute.array.every(Number.isFinite));
      if (mesh.material.map) {
        const uv = mesh.geometry.attributes.uv;
        assert.equal(uv.count, position.count);
        assert.ok(uv.array.every(Number.isFinite));
        assert.ok(mesh.material.map.generateMipmaps);
      }
      assert.ok(mesh.instanceMatrix.array.subarray(0, mesh.count * 16).every(Number.isFinite));
    }
  }
  for (let i = 0; i < 80; i++) wildlife.update(0.1, [{ x: 0, z: 0 }], 0, 0, 80);
  const penned = wildlife.animals.filter(animal => animal.pen !== undefined);
  assert.ok(penned.length > 0);
  assert.ok(penned.every(animal => Math.hypot(animal.x - animal.hx, animal.z - animal.hz) <= animal.pen + 1e-6));
  const paused = JSON.stringify(wildlife.animals);
  const poses = wildlife.heads.map(head => Array.from(head.instanceMatrix.array.slice(0, head.count * 16)));
  const normal = wildlife.heads.map(head => head.geometry);
  wildlife.setGooglyEyes(true); crowd.setGooglyEyes(true);
  wildlife.update(0, [{ x: 0, z: 0 }, { x: 18, z: 0 }], 0, 0, 80);
  assert.equal(JSON.stringify(wildlife.animals), paused);
  assert.deepEqual(wildlife.heads.map(head => Array.from(head.instanceMatrix.array.slice(0, head.count * 16))), poses);
  assert.ok(wildlife.heads.every((head, i) => head.geometry.attributes.position.count > normal[i].attributes.position.count));
  assert.equal(crowd.horseEyes.visible, true);
  assert.equal(crowd.horseEyes.instanceMatrix, crowd.horse.instanceMatrix);
  wildlife.setGooglyEyes(false); crowd.setGooglyEyes(false);
  assert.ok(wildlife.heads.every((head, i) => head.geometry === normal[i]));
  assert.equal(crowd.horseEyes.visible, false);
  wildlife.update(0.1, [], 200, 200, 10);
  assert.ok(wildlife.group.children.filter(mesh => mesh.geometry).every(mesh => mesh.count === 0));
});

test('villager names are reproducible and unique across the visible roster', async () => {
  const { villagerName } = await load('src/villagernames.ts', true);
  const roster = Array.from({ length: 2400 }, (_, i) => villagerName(i, -100, 43));
  assert.deepEqual(roster.slice(0, 6), ['REALICUS CREATIUS MAXIMUS', 'Logg VanDerTree', 'Dtree', 'RealCreate', 'RealCBro', 'RealCBroTwo']);
  assert.ok(roster.some(name => name.endsWith(' the 2nd')));
  assert.ok(roster.some(name => name.endsWith(' the 3rd')));
  assert.equal(new Set(roster.map(name => name.toLowerCase())).size, roster.length);
  assert.equal(roster[25], villagerName(25, -100, 43));
});

test('rowboat passengers sit on the benches with horizontal thighs and lowered heads', async () => {
  const { Crowd } = await load('src/render/crowd.ts', true);
  const { Boats } = await load('src/render/boats.ts', true);
  const boats = new Boats({ heightAt: () => -2, renderedWaterAt: () => 1 }, () => 1);
  const flat = [];
  for (let i = 0; i < 12; i++) flat.push(32, 0, i * 4, 0, 0, 0, 0, 0, 0, 0);
  boats.sync(Float32Array.from(flat), 1); boats.update(0.1);
  const passengers = [];
  boats.draw({ add: d => passengers.push(d) }, 0, 0, 100);
  assert.ok(passengers.length > 0);
  assert.ok(passengers.every(d => d.pose === 5 && d.tool === undefined));
  const crowd = new Crowd();
  crowd.begin(); crowd.add({ ...passengers[0], yaw: 0 }); crowd.end();
  const thigh = new Matrix4(), head = new Matrix4();
  crowd.thighL.getMatrixAt(0, thigh); crowd.head.getMatrixAt(0, head);
  const legDirection = new Vector3(0, -1, 0).transformDirection(thigh);
  assert.ok(Math.abs(legDirection.y) < 0.01 && legDirection.z > 0.99);
  assert.ok(head.elements[13] - passengers[0].y < 1, 'head is below standing height');
});

test('the named woodcutters and builders take matching staffed jobs, with a market fallback for RealCBroTwo', async () => {
  const { villagerJob, villagerWorkplaces } = await load('src/villagernames.ts', true);
  const kinds = [15, 1, 28, 4, 20];
  assert.deepEqual(villagerWorkplaces([1, 1], kinds, 8), [0, 0, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual(villagerWorkplaces([1, 2, 3, 3, 4, 4, 4, 4], kinds, 8), [4, 3, 3, 4, 4, 4, 1, 2]);
  const market = villagerWorkplaces([1, 2, 3, 4, 4, 4], kinds, 8);
  assert.deepEqual(market, [4, 3, 0, 4, 4, 2, 1, 0]);
  assert.deepEqual(market.slice(0, 6).map((building, i) => villagerJob(i, kinds[building])),
    ['Builder', 'Woodcutter', 'Woodcutter', 'Builder', 'Builder', 'Market attendant']);
});

test('a port’s cog berths in shallow or rotated channels and rides the rendered water while docked', async () => {
  const { Boats, portBerth } = await load('src/render/boats.ts', true);
  const open = portBerth(0, 0, 0, (_x, z) => z > 3 ? 2 : -1);
  assert.ok(open && open.x > 3.6 && open.scale === 0.83);
  const narrow = portBerth(0, 0, Math.PI / 2, (x, z) => z > 5 && z < 8 && x > -15 && x < 15 ? 1 : -1);
  assert.ok(narrow && narrow.z > 5 && narrow.z < 8);
  assert.equal(portBerth(0, 0, 0, () => -1), null);
  let tide = -0.25;
  const boats = new Boats({
    renderedWaterAt: (_x, _z, forced) => forced ?? tide,
    heightAt: (_x, z) => z > 4 ? -2 : 2,
  }, () => -Infinity);
  boats.sync(Float32Array.of(35, 0, 0, 0, 0, 0, 0, 0, 0, 0), 1);
  assert.equal(boats.group.children.length, 1);
  const ship = boats.group.children[0], paused = ship.position.clone();
  boats.update(0); assert.deepEqual(ship.position, paused);
  tide += 0.2; boats.update(0);
  assert.ok(Math.abs(ship.position.y - paused.y - 0.2) < 1e-9);
});

test('touch pans and pinches without delivering a tap, and preserves deliberate pen strokes', async () => {
  Object.assign(globalThis, { addEventListener() {}, innerWidth: 800, innerHeight: 600 });
  const { CameraRig } = await load('src/render/camera.ts', true);
  class Surface extends EventTarget {
    style = {};
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    send(type, id, x, y) { this.dispatchEvent(Object.assign(new Event(type), { pointerType: 'touch', pointerId: id, clientX: x, clientY: y })); }
  }
  const dom = new Surface();
  let pen = false;
  const rig = new CameraRig(dom, { heightAt: () => 0, pick: () => null }, () => pen);
  rig.update(0);
  dom.send('pointerdown', 1, 380, 300); dom.send('pointermove', 1, 385, 301); dom.send('pointerup', 1, 385, 301);
  assert.equal(rig.touchConsumed, false);
  dom.send('pointerdown', 2, 380, 300); dom.send('pointermove', 2, 426, 315);
  assert.equal(rig.touchConsumed, true);
  assert.ok(Math.hypot(rig.target.x, rig.target.z) > 1);
  const { dist, yaw } = rig;
  dom.send('pointerdown', 3, 530, 315); dom.send('pointermove', 3, 581, 343);
  assert.ok(rig.dist < dist);
  assert.ok(rig.yaw > yaw, 'clockwise finger motion rotates in the matching direction');
  dom.send('pointermove', 3, 530, 295);
  assert.ok(rig.yaw < yaw, 'counterclockwise motion reverses the turn');
  dom.send('pointerup', 2, 426, 315); dom.send('pointerup', 3, 581, 343);
  assert.equal(rig.touchConsumed, true);
  pen = true;
  dom.send('pointerdown', 4, 400, 340); dom.send('pointermove', 4, 470, 350); dom.send('pointerup', 4, 470, 350);
  assert.equal(rig.touchConsumed, false);
});

test('touch building taps preview and relocate, confirmation builds, and a pan spends nothing', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const input = source.slice(source.indexOf('function bindInput()'), source.indexOf('function depositHtml('));
  class Canvas extends EventTarget {
    setPointerCapture() {}
    send(type, x, y) { this.dispatchEvent(Object.assign(new Event(type), { pointerType: 'touch', button: 0, pointerId: 1, clientX: x, clientY: y })); }
  }
  const canvas = new Canvas(), controls = new Map();
  const previews = [], builds = [];
  const context = {
    ui: { canvas, selBox() {} },
    document: { getElementById(id) { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); } },
    addEventListener() {}, performance: { now: () => 0 },
    selectedKind: 0, selectedDet: null, LEVEL_TOOL: 255, PLANT_TOOL: 254, zoneIdx: null, rallyPick: null, plantClick() {}, zoneClick() {}, rallyClick() {}, toggleMulti() {}, TOUCH_DRAG_PIXELS: 10,
    PEN_SPACING: {}, penShape: 'line', penStart: null, pendingBattleOrder: null,
    penPreview: { clear() {} },
    rig: { touchConsumed: false },
    touchPreviewHit: () => false, showTouchTools() {}, cancelMarchPreview() {},
    rotateTool() {}, finishStroke() {}, undoStroke() {}, selectKind() {},
    previewTouchPlacement(e) { previews.push([e.clientX, e.clientY]); },
    touchPlacementEvent: () => ({ clientX: previews.at(-1)[0], clientY: previews.at(-1)[1] }),
    updateGhost() {}, buildAtPointer(e) { builds.push([e.clientX, e.clientY]); },
  };
  runInNewContext(stripTypeScriptTypes(input) + '\nbindInput();', context);
  const tap = (x, y) => { canvas.send('pointerdown', x, y); canvas.send('pointerup', x, y); };
  tap(100, 120); tap(180, 140);
  assert.deepEqual(previews, [[100, 120], [180, 140]]);
  assert.deepEqual(builds, []);
  controls.get('touch-build').onclick();
  assert.deepEqual(builds, [[180, 140]]);
  canvas.send('pointerdown', 200, 200);
  context.rig.touchConsumed = true;
  canvas.send('pointerup', 260, 200);
  assert.equal(builds.length, 1);
  assert.equal(previews.length, 2);
  context.rig.touchConsumed = false;
  context.touchPreviewHit = () => true;
  canvas.send('pointerdown', 180, 140);
  canvas.send('pointermove', 240, 160);
  canvas.send('pointerup', 240, 160);
  assert.deepEqual(previews.at(-1), [240, 160]);
  assert.equal(builds.length, 1);
});
test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

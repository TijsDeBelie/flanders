import test from 'node:test';
import assert from 'node:assert/strict';
import { samplePath, figureOutline, snap45, rotOf, closesPath, isFigure, SHAPES } from '../src/penshapes.ts';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('a straight path is sampled at the spacing, with the end included', () => {
  const p = samplePath([{ x: 0, z: 0 }, { x: 20, z: 0 }], false, 6);
  assert.deepEqual(p.map(q => Math.round(q.x)), [0, 6, 12, 18, 20].map(Math.round), 'pieces every 6 and one at the end');
  assert.ok(p.every(q => Math.abs(q.z) < 1e-9 && Math.abs(q.heading) < 1e-9));
});

test('every corner of a path gets a piece, so walls close up at the bends', () => {
  const corners = [{ x: 0, z: 0 }, { x: 14, z: 0 }, { x: 14, z: 9 }, { x: 3, z: 9 }];
  const p = samplePath(corners, false, 6);
  for (const c of corners) assert.ok(p.some(q => dist(q, c) < 1e-6), `a piece on the corner ${c.x},${c.z}`);
  for (let i = 1; i < p.length; i++) assert.ok(dist(p[i - 1], p[i]) <= 6 + 1e-6 && dist(p[i - 1], p[i]) > 1, 'neighbours are close enough to join and not stacked');
});

test('a closed path ends where it began, without doubling the first piece', () => {
  const sq = [{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 12 }, { x: 0, z: 12 }];
  const p = samplePath(sq, true, 6);
  assert.equal(p.length, 8, 'a 12 x 12 square at spacing 6 has 8 pieces');
  assert.equal(new Set(p.map(q => `${Math.round(q.x)},${Math.round(q.z)}`)).size, 8);
  assert.ok(dist(p[p.length - 1], p[0]) <= 6 + 1e-6, 'the loop closes');
});

test('figures: rectangle corners, regular polygons and round shapes', () => {
  const r = figureOutline('rect', { x: 0, z: 0 }, { x: 10, z: 4 }); assert.equal(r.length, 4);
  assert.deepEqual(r.map(q => [q.x, q.z]), [[0, 0], [10, 0], [10, 4], [0, 4]]);
  for (const [s, n] of [['square', 4], ['triangle', 3], ['hexagon', 6], ['octagon', 8]]) {
    const f = figureOutline(s, { x: 5, z: 5 }, { x: 15, z: 5 }); assert.equal(f.length, n, s);
    assert.ok(f.every(q => Math.abs(dist(q, { x: 5, z: 5 }) - 10) < 1e-9), `${s} corners lie on the radius`);
    assert.ok(dist(f[0], { x: 15, z: 5 }) < 1e-9, `${s} has a corner under the pointer`);
  }
  const c = figureOutline('circle', { x: 0, z: 0 }, { x: 20, z: 0 }); assert.ok(c.length >= 32 && c.every(q => Math.abs(Math.hypot(q.x, q.z) - 20) < 1e-9));
  const e = figureOutline('ellipse', { x: 0, z: 0 }, { x: 20, z: 10 }); assert.ok(e.every(q => Math.abs(((q.x - 10) / 10) ** 2 + ((q.z - 5) / 5) ** 2 - 1) < 1e-9), 'on the ellipse');
});

test('a circle of walls comes out round and closed, with the pieces a spacing apart', () => {
  const ring = figureOutline('circle', { x: 0, z: 0 }, { x: 30, z: 0 }), p = samplePath(ring, true, 6);
  assert.ok(p.length >= 30 && p.length <= 36, `about 2*pi*30/6 = 31 pieces, got ${p.length}`);
  assert.ok(p.every(q => Math.abs(Math.hypot(q.x, q.z) - 30) < 0.6), 'all on the circle');
  for (let i = 0; i < p.length; i++) assert.ok(dist(p[i], p[(i + 1) % p.length]) <= 6.3, 'neighbours join, including the last to the first');
});

test('snapping to 45 degrees, turns of the pieces and closing a path', () => {
  const s = snap45({ x: 0, z: 0 }, { x: 10, z: 1 }); assert.ok(Math.abs(s.z) < 1e-9 && Math.abs(s.x - Math.hypot(10, 1)) < 1e-9);
  const d = snap45({ x: 0, z: 0 }, { x: 10, z: 9 }); assert.ok(Math.abs(d.x - d.z) < 1e-9);
  assert.equal(rotOf(0), 0); assert.equal(rotOf(Math.PI / 2), 6); assert.equal(rotOf(-Math.PI / 2), 2);
  const pts = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
  assert.equal(closesPath(pts, { x: 1, z: 1 }, 3), true); assert.equal(closesPath(pts, { x: 5, z: 5 }, 3), false); assert.equal(closesPath(pts.slice(0, 2), { x: 0, z: 0 }, 3), false, 'needs three corners');
});

test('the shape list is complete and every figure has a hint', () => {
  assert.deepEqual(SHAPES.map(s => s.id), ['line', 'path', 'rect', 'square', 'circle', 'ellipse', 'triangle', 'hexagon', 'octagon']);
  assert.ok(SHAPES.every(s => s.hint.length > 10 && s.icon && s.label));
  assert.equal(isFigure('line'), false); assert.equal(isFigure('path'), false); assert.equal(isFigure('circle'), true);
});

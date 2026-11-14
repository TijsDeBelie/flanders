import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomAbout, rayOnPlane, grabShift, DragCounter, nearestWithin } from '../src/render/camerafx.ts';

test('zooming in towards a point moves the target towards it, zooming out moves it away, and the point itself is a fixed point', () => {
  const t = { x: 0, z: 0 }, p = { x: 40, z: -20 };
  const closer = zoomAbout(t, p, 0.5); assert.deepEqual(closer, { x: 20, z: -10 }, 'halfway');
  const out = zoomAbout(t, p, 2); assert.deepEqual(out, { x: -40, z: 20 }, 'away from the point');
  assert.deepEqual(zoomAbout(p, p, 0.3), p, 'zooming on the target itself does not move it');
  assert.deepEqual(zoomAbout(t, p, 1), t, 'no zoom, no move');
});

test('a ray meets the ground, but not when it looks up', () => {
  const g = rayOnPlane({ x: 0, y: 10, z: 0 }, { x: 0.5, y: -1, z: 0.25 }, 0); assert.deepEqual(g, { x: 5, z: 2.5 });
  assert.equal(rayOnPlane({ x: 0, y: 10, z: 0 }, { x: 1, y: 0.2, z: 0 }, 0), null, 'looking up');
  assert.equal(rayOnPlane({ x: 0, y: 10, z: 0 }, { x: 1, y: -0.0000001, z: 0 }, 0), null, 'looking along the horizon');
  assert.ok(rayOnPlane({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 4).x === 0, 'a raised plane');
});

test('dragging the ground keeps the grabbed point under the pointer', () => {
  const grabbed = { x: 12, z: 7 }, now = { x: 15, z: 4 }, d = grabShift(grabbed, now);
  assert.deepEqual({ x: now.x + d.x, z: now.z + d.z }, grabbed, 'after moving the target by d the pointer is over the grabbed point again');
});

test('a few pixels of jitter is a click, a real movement is a drag, summed over many small moves', () => {
  const c = new DragCounter(); for (let i = 0; i < 4; i++) c.add(1, 1); assert.equal(c.dragged, true, 'four diagonal pixels add up to over five');
  c.reset(); c.add(2, 1); c.add(1, 1); assert.equal(c.dragged, false, 'a shaky click is still a click');
  c.reset(); for (let i = 0; i < 10; i++) c.add(1, 0); assert.equal(c.dragged, true);
});

test('picking the nearest small target within reach of the pointer', () => {
  const items = [{ id: 1, sx: 100, sy: 100 }, { id: 2, sx: 130, sy: 100 }, { id: 3, sx: 400, sy: 400 }];
  assert.equal(nearestWithin(items, 118, 102, 30)?.id, 2, 'the closer of two'); assert.equal(nearestWithin(items, 105, 100, 30)?.id, 1);
  assert.equal(nearestWithin(items, 250, 250, 30), null, 'nothing near'); assert.equal(nearestWithin([], 0, 0, 30), null);
});

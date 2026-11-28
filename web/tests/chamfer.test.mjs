// The soft-edged box (src/render/chamfer.ts): closed, wound outwards, the right size, and textured like a plain box.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { chamferBox, bevelFor } from '../src/render/chamfer.ts';

test('a chamfered box has 24 vertices and 44 triangles, and fills exactly the box it stands for', () => {
  const g = chamferBox(4, 2.4, 3, 0.1, 2);
  assert.equal(g.attributes.position.count, 24);
  assert.equal(g.index.count / 3, 44);
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3());
  assert.deepEqual(size.toArray().map(v => +v.toFixed(5)), [4, 2.4, 3]);
});

test('every triangle faces outwards and the surface is closed (each edge shared by exactly two triangles)', () => {
  const g = chamferBox(1.2, 0.8, 0.5, 0.08, 2), p = g.attributes.position, ix = g.index.array;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  const key = (i, j) => { const pi = [p.getX(i), p.getY(i), p.getZ(i)].map(v => v.toFixed(4)).join(), pj = [p.getX(j), p.getY(j), p.getZ(j)].map(v => v.toFixed(4)).join(); return pi < pj ? pi + '|' + pj : pj + '|' + pi; };
  const edges = new Map();
  for (let t = 0; t < ix.length; t += 3) {
    a.fromBufferAttribute(p, ix[t]); b.fromBufferAttribute(p, ix[t + 1]); c.fromBufferAttribute(p, ix[t + 2]);
    n.subVectors(b, a).cross(m.subVectors(c, a));
    assert.ok(n.dot(a.clone().add(b).add(c)) > 0, `triangle ${t / 3} faces in`);
    for (const [i, j] of [[ix[t], ix[t + 1]], [ix[t + 1], ix[t + 2]], [ix[t + 2], ix[t]]]) { const k = key(i, j); edges.set(k, (edges.get(k) ?? 0) + 1); }
  }
  for (const [k, count] of edges) assert.equal(count, 2, `edge ${k}`);
});

test('the texture starts at a face corner, one repeat per tile, as on a plain box', () => {
  const g = chamferBox(4, 2, 2, 0.1, 2), p = g.attributes.position, uv = g.attributes.uv, nrm = g.attributes.normal;
  // the front face (+z): u runs with x from the left edge, v with y from the bottom
  for (let i = 0; i < p.count; i++) if (nrm.getZ(i) > 0.5) {
    assert.ok(Math.abs(uv.getX(i) - (p.getX(i) + 2) / 2) < 1e-6);
    assert.ok(Math.abs(uv.getY(i) - (p.getY(i) + 1) / 2) < 1e-6);
  }
});

test('walls get a soft edge, beams a slight one, small trim none', () => {
  assert.ok(bevelFor(4, 2.4, 3) > 0.15);
  assert.ok(bevelFor(4, 0.25, 0.25) > 0 && bevelFor(4, 0.25, 0.25) <= 0.06);
  assert.equal(bevelFor(0.42, 0.56, 0.78), 0, 'a quoin');
  assert.equal(bevelFor(0.17, 0.2, 0.6), 0, 'a joist');
  assert.equal(bevelFor(0.22, 0.7, 0.06), 0, 'a shutter');
  const flat = chamferBox(1, 1, 1, 0, 2);
  assert.equal(flat.index.count / 3, 12, 'no bevel: a plain box');
});

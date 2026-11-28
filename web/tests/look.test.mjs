// The colour grade (src/render/look.ts): what the shader does, checked in plain code.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { grade, neutral, installGrade, gradeInstalled, GRADE } from '../src/render/look.ts';

const chroma = c => Math.max(...c) - Math.min(...c);
const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('the grade goes into three\'s shader library once, as the custom tone mapping', () => {
  installGrade(); installGrade();
  assert.ok(gradeInstalled());
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  assert.equal(chunk.split('vec3 CustomToneMapping').length, 2, 'one definition');
  assert.match(chunk, /NeutralToneMapping\( color \)/);
});

test('mid-tone colours come out more saturated than the neutral curve alone, and stay in range', () => {
  for (const c of [[0.3, 0.15, 0.08], [0.1, 0.25, 0.08], [0.2, 0.25, 0.4], [0.4, 0.25, 0.15]]) {
    const g = grade(c), n = neutral(c);
    assert.ok(chroma(g) > chroma(n), `more colour for ${c}`);
    for (const v of g) assert.ok(v >= 0 && v <= 1);
  }
});

test('the grade keeps brightness: no darker or brighter than a few percent', () => {
  for (const v of [0.02, 0.1, 0.3, 0.6, 1, 3]) {
    const c = [v, v, v], g = grade(c), n = neutral(c);
    assert.ok(Math.abs(luma(g) - luma(n)) < 0.03, `grey ${v}`);
  }
});

test('pale surfaces ease towards white: cream plaster in sunlight loses colour rather than gaining it', () => {
  const cream = [1.1, 0.98, 0.72];
  assert.ok(chroma(grade(cream)) < chroma(neutral(cream)));
});

test('highlights lean warm, shadows a touch cool, and the curve never goes backwards', () => {
  const lit = grade([0.7, 0.7, 0.7]), dim = grade([0.03, 0.03, 0.03]);
  assert.ok(lit[0] > lit[2], 'warm highlight');
  assert.ok(dim[2] > dim[0], 'cool shadow');
  let last = -1;
  for (let v = 0; v < 4; v += 0.05) { const l = luma(grade([v, v, v])); assert.ok(l >= last - 1e-9); last = l; }
  assert.ok(GRADE.saturation > 1 && GRADE.saturation < 1.4, 'a gentle push, not a cartoon');
});

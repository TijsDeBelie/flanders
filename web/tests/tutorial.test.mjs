import test from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, stepAfter, loadProgress } from '../src/tutorial.ts';

const counts = (n = {}, o = {}) => ({ n: k => n[k] ?? 0, pop: 10, hall: 0, army: 0, rivals: 0, ...o });

test('every step has a title and text, and the conditions are functions', () => {
  assert.ok(STEPS.length >= 10);
  for (const s of STEPS) { assert.ok(s.title && s.text); assert.ok(s.done === undefined || typeof s.done === 'function'); }
});
test('a new village stays on the first (waiting) step', () => { assert.equal(stepAfter(0, counts()), 0); });
test('a step completes when the village has what it asks for, and the guide moves on', () => {
  const farm = STEPS.findIndex(s => s.title === 'Grain for the table');   // (food first: the farm comes before the house)
  assert.equal(stepAfter(farm, counts()), farm);
  assert.equal(STEPS[stepAfter(farm, counts({ 1: 1 }))].title, 'A home for new villagers');
});
test('it skips ahead past several finished steps but stops at one that waits for Next', () => {
  const farm = STEPS.findIndex(s => s.title === 'Grain for the table');
  const after = stepAfter(farm, counts({ 0: 5, 1: 1, 4: 1, 5: 1 }));
  assert.ok(!STEPS[after].done, 'it stops at an information step: ' + STEPS[after].title);
  assert.ok(after > farm + 2);
});
test('finishing every step ends the guide', () => {
  const all = counts({ 0: 9, 1: 9, 3: 1, 4: 1, 5: 1, 6: 1, 16: 1, 19: 1 }, { pop: 40, hall: 3, army: 20 });
  let s = 0; for (let i = 0; i < STEPS.length * 2; i++) { s = stepAfter(s, all); if (s < STEPS.length && !STEPS[s].done) s++; }
  assert.equal(s, STEPS.length);
});
test('saved progress is read back safely', () => {
  const st = v => ({ getItem: () => v });
  assert.equal(loadProgress(st(null)), null); assert.equal(loadProgress(st('done')), 'done'); assert.equal(loadProgress(st('skipped')), 'skipped');
  assert.deepEqual(loadProgress(st('3')), { step: 3 });
  for (const bad of ['-1', '99', 'abc', '2.5', '']) assert.equal(loadProgress(st(bad)), null, bad);
  assert.equal(loadProgress({ getItem: () => { throw new Error('blocked'); } }), null);
});

import { fillKeys } from '../src/tutorial.ts';
test('key names in the guide come from the player\'s own bindings', () => {
  assert.equal(fillKeys('Press {deposits} then {photo}'), 'Press V then F9');
  assert.equal(fillKeys('Press {deposits}', a => (a === 'deposits' ? 'K' : '?')), 'Press K');
  for (const s of STEPS) assert.ok(!/\{\w+\}/.test(fillKeys(s.text)), 'unfilled placeholder in: ' + s.title);
  assert.ok(STEPS.some(s => s.text.includes('{panUp}')), 'the camera step names the movement keys');
});

test('each step asks for one thing, in short sentences', () => {
  for (const s of STEPS) {
    for (const sentence of fillKeys(s.text).split(/(?<=[.!?])\s+/)) assert.ok(sentence.split(/\s+/).length <= 20, `long sentence in "${s.title}": ${sentence}`);
    assert.ok(s.text.length <= 240, `"${s.title}" is too long (${s.text.length} characters)`);
  }
});
test('defences come before the village is asked to grow', () => {
  const at = t => STEPS.findIndex(s => s.title === t);
  assert.ok(at('Water against fire') < at('A growing village') && at('Train archers') < at('A growing village'));
});

import { TUTORIAL_WORLD, TUTORIAL_SCRIPT } from '../src/tutorialvillage.ts';
import { cleanWorld } from '../src/worldname.ts';
test('the tutorial village script is ordered and its world name survives cleaning', () => {
  assert.equal(cleanWorld(TUTORIAL_WORLD), TUTORIAL_WORLD);
  for (let i = 1; i < TUTORIAL_SCRIPT.length; i++) assert.ok(TUTORIAL_SCRIPT[i].at > TUTORIAL_SCRIPT[i - 1].at);
  for (const a of TUTORIAL_SCRIPT) if (a.op === 'place') assert.ok(Math.hypot(a.dx, a.dy) >= 20 || a.kind === 6, 'keep the hall\'s surroundings clear');
});

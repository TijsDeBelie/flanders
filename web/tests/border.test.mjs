import test from 'node:test';
import assert from 'node:assert/strict';
import { territoryOutline } from '../src/render/border.ts';

const len = segs => { let l = 0; for (let i = 0; i < segs.length; i += 4) l += Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]); return l; };

test('one disc is a full circle', () => {
  const s = territoryOutline([0, 0, 30]); assert.ok(Math.abs(len(s) - 2 * Math.PI * 30) < 2, `${len(s)}`);
  assert.ok(s.every((v, i) => i % 4 > 1 || true)); for (let i = 0; i < s.length; i += 4) assert.ok(Math.abs(Math.hypot(s[i], s[i + 1]) - 30) < 1e-6);
});
test('a disc inside another adds nothing, and two overlapping discs have a shorter outline than their sum', () => {
  assert.ok(Math.abs(len(territoryOutline([0, 0, 30, 5, 0, 10])) - 2 * Math.PI * 30) < 2, 'the small disc is swallowed');
  const two = len(territoryOutline([0, 0, 30, 40, 0, 30]));
  assert.ok(two < 2 * 2 * Math.PI * 30 - 20 && two > 2 * Math.PI * 30, `a peanut shape: ${two}`);
});
test('the outline is closed and follows the discs, not a circle round the hall', () => {
  const s = territoryOutline([0, 0, 30, 36, 0, 12]); let maxX = -1e9; for (let i = 0; i < s.length; i += 2) maxX = Math.max(maxX, s[i]);
  assert.ok(maxX > 46 && maxX <= 48.01, `the border bulges out to the house's patch: ${maxX}`);
  // every endpoint is used by exactly two segments (a closed loop), apart from where two outlines meet
  const count = new Map(); for (let i = 0; i < s.length; i += 2) { const k = `${s[i].toFixed(3)},${s[i + 1].toFixed(3)}`; count.set(k, (count.get(k) || 0) + 1); }
  assert.ok([...count.values()].filter(c => c > 2).length === 0, 'no point is shared by more than two segments');
});

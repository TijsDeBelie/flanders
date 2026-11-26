import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportGap } from '../src/viewport.ts';

test('a standalone iPhone app that measures itself short by the status bar gets the gap back', () => {
  assert.equal(viewportGap(879, 926, true), 47);   // iPhone 13 Pro Max: 47 pt status bar
});
test('no gap in a browser tab, when the sizes agree, or when the difference is too large to be the status bar', () => {
  assert.equal(viewportGap(879, 926, false), 0);   // Safari's toolbars are not ours to draw under
  assert.equal(viewportGap(926, 926, true), 0);
  assert.equal(viewportGap(926, 900, true), 0);
  assert.equal(viewportGap(600, 926, true), 0);
});

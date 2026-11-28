// Snow in winter (src/render/snow.ts): when it lies and how it comes and goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { snowCover } from '../src/render/snow.ts';
import { DAY_TICKS } from '../src/daycycle.ts';

const SEASON = 10 * DAY_TICKS, at = (season, day) => Math.round((season * 10 + day) * DAY_TICKS);

test('a day here is the game\'s day', () => { assert.equal(DAY_TICKS, 240); });

test('no snow in spring, summer or autumn', () => {
  for (const s of [0, 1, 2]) for (const d of [2, 5, 9.9]) assert.equal(snowCover(at(s, d)), 0, `season ${s} day ${d}`);
});

test('snow settles over the first day and a half of winter and lies deep in the middle of it', () => {
  assert.equal(snowCover(at(3, 0)), 0);
  assert.ok(snowCover(at(3, 0.75)) > 0 && snowCover(at(3, 0.75)) < 1);
  for (const d of [2, 5, 7.5]) assert.equal(snowCover(at(3, d)), 1);
});

test('it melts over the last two days of winter and the first day of spring, then it is gone', () => {
  assert.ok(snowCover(at(3, 9)) < 1 && snowCover(at(3, 9)) > snowCover(at(0, 0.5)));
  assert.ok(snowCover(at(0, 0.5)) > 0);
  assert.equal(snowCover(at(0, 1)), 0);
  assert.ok(Math.abs(snowCover(4 * SEASON - 1) - snowCover(4 * SEASON)) < 0.01, 'no jump at the new year');
});

test('every year is the same, and the cover never leaves 0..1', () => {
  for (let t = 0; t < 4 * SEASON; t += 37) {
    const v = snowCover(t);
    assert.ok(v >= 0 && v <= 1);
    assert.equal(snowCover(t + 4 * SEASON * 3), v);
  }
});

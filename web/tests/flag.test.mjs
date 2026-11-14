import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, PATTERNS, EMBLEMS, packFlag, unpackFlag, flagColor, randomFlag, drawFlag, DEFAULT_FLAG } from '../src/flag.ts';

test('a flag packs into one number and back, and the number is never 0', () => {
  for (let p = 0; p < PATTERNS.length; p++) for (const e of [0, EMBLEMS.length - 1]) {
    const f = { pattern: p, c1: 3, c2: 15, c3: 7, emblem: e }, n = packFlag(f);
    assert.ok(n > 0 && n < 2 ** 25); assert.deepEqual(unpackFlag(n), f);
  }
  assert.ok(packFlag({ pattern: 0, c1: 0, c2: 0, c3: 0, emblem: 0 }) > 0, 'even the plainest flag is not 0 (0 means no choice)');
});

test('bad numbers are not flags', () => {
  for (const n of [0, -1, 5, 1.5, 2 ** 25, NaN, Infinity, (1 << 24) | 15]) assert.equal(unpackFlag(n), null, String(n));
  assert.equal(unpackFlag((1 << 24) | (EMBLEMS.length << 16)), null, 'no such emblem');
});

test('random flags are valid and use three different colours', () => {
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 300; i++) { const f = randomFlag(rnd); assert.ok(unpackFlag(packFlag(f)), JSON.stringify(f)); assert.ok(f.c1 !== f.c2, 'two colours differ'); assert.ok(f.c3 !== f.c1 || f.c3 !== f.c2, 'the emblem stands out from at least one'); }
});

test('the main colour is the first palette colour', () => {
  assert.equal(flagColor({ ...DEFAULT_FLAG, c1: 6 }), 0x2f5fa8); assert.equal(PALETTE.length, 16);
});

test('every pattern and emblem draws something and stays inside the flag', () => {
  for (let p = 0; p < PATTERNS.length; p++) for (let e = 0; e < EMBLEMS.length; e++) {
    const calls = [], rec = new Proxy({ fillStyle: '', strokeStyle: '', lineWidth: 1 }, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])), set: (t, k, v) => { t[k] = v; return true; } });
    drawFlag(rec, 120, 80, { pattern: p, c1: 0, c2: 6, c3: 9, emblem: e });
    assert.ok(calls.length >= 1 && calls[0][0] === 'fillRect' && calls[0][3] === 120 && calls[0][4] === 80, `pattern ${p}: the background fills the flag`);
    for (const c of calls) if (c[0] === 'fillRect') assert.ok(c[1] >= -0.01 && c[2] >= -0.01 && c[1] + c[3] <= 120.01 && c[2] + c[4] <= 80.01, `pattern ${p} emblem ${e}: ${c.join(',')} is outside`);
    if (e > 0) assert.ok(calls.length > 1 || p > 0, `emblem ${e} adds something`);
  }
});

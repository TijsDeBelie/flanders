import test from 'node:test';
import assert from 'node:assert/strict';
import { arrivalTime, crossingSummary, marchDestination, objectiveName, orderPins, parseRaidObjective } from '../src/battlefield.ts';

test('orders at one position share a label and distinguish different troop groups', () => {
  const pins = orderPins([0, 1, 12, 8, 1, 1, 12, 8, 2, 4, 12, 8, 3, 3, 17, 9]);
  assert.deepEqual(pins, [
    { x: 12, z: 8, text: 'Hold line · Infantry, Archers\nFlank · Knights' },
    { x: 17, z: 9, text: 'Fall back · Siege' },
  ]);
  assert.equal(orderPins([0, 1, 0, 0, 1, 1, 0, 0, 2, 1, 0, 0, 3, 1, 0, 0])[0].text, 'Hold line · All troops');
});

test('the preview converts simulation ticks to 1× time and counts each material separately', () => {
  assert.equal(arrivalTime(32.1, 0.5), '1m 5s');
  assert.deepEqual(crossingSummary(12, 20, 8, 18), { costs: '12 planks for bridges + 20 wood for boats', shortage: 'Short 4 planks and 2 wood' });
  assert.deepEqual(crossingSummary(0, 0, 1, 1), { costs: 'No crossing costs', shortage: '' });
});

test('the raid panel distinguishes the defended gate from a captured supply wagon', () => {
  assert.equal(parseRaidObjective([]), null);
  const wagon = parseRaidObjective([2, 21, 19, 30, 1, 1]);
  assert.deepEqual(wagon, { kind: 'caravan', x: 21, z: 19, left: 30, capture: 1, lost: true });
  const gate = parseRaidObjective([1, 3, 7, 55, 0, 0]);
  assert.equal(objectiveName(gate), 'Hold the gate');
});

test('formation marches preserve relative positions and ordinary marches keep their spread', () => {
  const click = { x: 80, z: 25 }, lead = { x: 12, z: -4 }, wing = { x: 7, z: 8 };
  assert.deepEqual(marchDestination(click, 0, lead, lead), click);
  assert.deepEqual(marchDestination(click, 1, lead, wing), { x: 75, z: 37 });
  assert.deepEqual(marchDestination(click, 0), click);
  const spread = marchDestination(click, 1);
  assert.ok(Math.abs(Math.hypot(spread.x - click.x, spread.z - click.z) - 5) < 1e-9);
  assert.deepEqual(marchDestination(click, 1, lead, null), spread);
});

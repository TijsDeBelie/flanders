// Gentle guidance for new players: a checklist that ticks itself off from what the village has.
import type { World } from './wasm/game_core.js';

export const GOALS: { text: string; detail?: string; ok: (c: Counts) => boolean }[] = [
  { text: 'Build a farm', detail: 'Your people need grain: food first, then homes', ok: c => c.n(1) >= 1 },
  { text: 'Build 2 houses', detail: 'Press 1 and click the ground', ok: c => c.n(0) >= 2 },
  { text: 'Build a second farm', detail: 'More people eat more: a farm feeds about one house', ok: c => c.n(1) >= 2 },
  { text: 'Build a woodcutter near a forest', ok: c => c.n(4) >= 1 },
  { text: 'Build a sawmill for planks', ok: c => c.n(5) >= 1 },
  { text: 'Open a quarry at a stone outcrop', detail: 'Press V to find deposits', ok: c => c.n(6) >= 1 },
  { text: 'Build a hunter\'s lodge', detail: 'Venison feeds more people', ok: c => c.n(18) >= 1 },
  { text: 'Reach 20 villagers', ok: c => c.pop >= 20 },
  { text: 'Dig clay and fire bricks', detail: 'Clay pit + charcoal burner + brickworks', ok: c => c.n(7) >= 1 && c.n(8) >= 1 },
  { text: 'Dig an iron mine', detail: 'You need tools to build it', ok: c => c.n(9) >= 1 },
  { text: 'Raise a watchtower and a well', ok: c => c.n(3) >= 1 && c.n(16) >= 1 },
  { text: 'Upgrade the town hall to a manor', ok: c => c.hall >= 1 },
  { text: 'Build a barracks and train soldiers', ok: c => c.n(19) >= 1 && c.army >= 5 },
  { text: 'Build a mint and make gold', ok: c => c.n(14) >= 1 },
  { text: 'Upgrade the town hall to a keep', ok: c => c.hall >= 2 },
  { text: 'Join other players: see the globe button', ok: c => c.rivals >= 1 },
  { text: 'Raise your castle', ok: c => c.hall >= 3 },
];
export interface Counts { n(kind: number): number; pop: number; hall: number; army: number; rivals: number }

/** What the village has, for the goals (and the tutorial). */
export function countsOf(world: World, rivals: number): Counts {
  const f = world.buildings_flat(), cnt = new Map<number, number>();
  for (let i = 0; i < f.length; i += 10) cnt.set(f[i], (cnt.get(f[i]) ?? 0) + 1);
  return { n: k => cnt.get(k) ?? 0, pop: world.population(), hall: f[1], army: Array.from(world.army()).reduce((a, b) => a + b, 0), rivals };
}

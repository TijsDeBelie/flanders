export const ORDER_NAMES = ['Automatic', 'Hold line', 'Attack here', 'Fall back', 'Flank', 'Aggressive', 'Defensive'] as const;
/** Stances (from this mode on) need no point on the field: they are issued at once. */
export const FIRST_STANCE = 5;
export const TROOP_GROUPS = ['Infantry', 'Archers', 'Knights', 'Siege'] as const;

export interface BattlePin { x: number; z: number; text: string; objective?: boolean }
export interface RaidObjective {
  kind: 'gate' | 'caravan';
  x: number;
  z: number;
  left: number;
  capture: number;
  lost: boolean;
}

export function orderPins(flat: ArrayLike<number>): BattlePin[] {
  const points = new Map<string, { x: number; z: number; modes: Map<number, string[]> }>();
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const group = TROOP_GROUPS[flat[i]], mode = flat[i + 1], x = flat[i + 2], z = flat[i + 3];
    if (!group || mode < 1 || !ORDER_NAMES[mode]) continue;
    const key = `${x},${z}`;
    let point = points.get(key);
    if (!point) { point = { x, z, modes: new Map() }; points.set(key, point); }
    const troops = point.modes.get(mode) ?? [];
    troops.push(group);
    point.modes.set(mode, troops);
  }
  return [...points.values()].map(({ x, z, modes }) => ({
    x, z, text: [...modes].map(([mode, troops]) => `${ORDER_NAMES[mode]} · ${troops.length === TROOP_GROUPS.length ? 'All troops' : troops.join(', ')}`).join('\n'),
  }));
}

export function parseRaidObjective(flat: ArrayLike<number>): RaidObjective | null {
  if (flat.length < 6 || (flat[0] !== 1 && flat[0] !== 2)) return null;
  return { kind: flat[0] === 1 ? 'gate' : 'caravan', x: flat[1], z: flat[2], left: flat[3], capture: flat[4], lost: flat[5] > 0 };
}

export const objectiveName = (o: RaidObjective) => o.kind === 'gate' ? 'Hold the gate' : 'Protect the caravan';

export function arrivalTime(ticks: number, tickRate: number) {
  const seconds = Math.max(1, Math.ceil(ticks / tickRate));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function crossingSummary(planks: number, wood: number, availablePlanks: number, availableWood: number) {
  const costs = [
    { count: planks, available: availablePlanks, resource: 'planks', use: 'bridges' },
    { count: wood, available: availableWood, resource: 'wood', use: 'boats' },
  ].filter(c => c.count > 0);
  const needed = costs.filter(c => c.count > c.available).map(c => `${c.count - c.available} ${c.resource}`);
  return {
    costs: costs.length ? costs.map(c => `${c.count} ${c.resource} for ${c.use}`).join(' + ') : 'No crossing costs',
    shortage: needed.length ? `Short ${needed.join(' and ')}` : '',
  };
}

type MarchPoint = { x: number; z: number };

/** The lead army takes the click. A formation march translates the other destinations by their current offsets. */
export function marchDestination(target: MarchPoint, index: number, leader?: MarchPoint | null, army?: MarchPoint | null): MarchPoint {
  if (leader && army) return { x: target.x + (army.x - leader.x), z: target.z + (army.z - leader.z) };
  const angle = index * 2.4;
  const radius = index ? 3 + 2 * Math.sqrt(index) : 0;
  return { x: target.x + Math.cos(angle) * radius, z: target.z + Math.sin(angle) * radius };
}

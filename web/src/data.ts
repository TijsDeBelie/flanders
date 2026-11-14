import init, { catalog, units as unitsJson } from './wasm/game_core.js';

await init(); // the building catalog comes from the Rust core, so wasm must be ready before this module evaluates

export interface BuildingDef {
  id: number; name: string; cat: number; r: number; weight: number;
  cost: [number, number][]; jobs: number; inputs: [number, number][]; outputs: [number, number][];
  cycle: number; req: number; reqArg: number; housing: number; maxTier: number; opts?: { n: string; d: string; t: number }[]; desc: string;
}

export const RES = [
  { key: 'wood', name: 'Wood', icon: '🪵', hint: 'Felled by woodcutters. Burned for charcoal, sawn into planks.' },
  { key: 'planks', name: 'Planks', icon: '📏', hint: 'Sawn timber for better buildings.' },
  { key: 'stone', name: 'Stone', icon: '🪨', hint: 'Quarried from stone outcrops.' },
  { key: 'clay', name: 'Clay', icon: '🟤', hint: 'Dirt dug from clay banks. Fired into bricks.' },
  { key: 'bricks', name: 'Bricks', icon: '🧱', hint: 'Fired clay. Needed for grand upgrades.' },
  { key: 'ironore', name: 'Iron ore', icon: '🟠', hint: 'Mined from iron veins. Smelt it with charcoal.' },
  { key: 'iron', name: 'Iron', icon: '⛓️', hint: 'Smelted ingots, forged into tools.' },
  { key: 'goldore', name: 'Gold ore', icon: '🟡', hint: 'Mined from rare gold veins.' },
  { key: 'gold', name: 'Gold', icon: '🪙', hint: 'Coin. Taxes, caravans and the mint bring it in.' },
  { key: 'charcoal', name: 'Charcoal', icon: '⚫', hint: 'Fuel for every furnace and kiln.' },
  { key: 'grain', name: 'Grain', icon: '🌾', hint: 'Feeds your villagers.' },
  { key: 'tools', name: 'Tools', icon: '🔨', hint: 'Forged by the blacksmith. Needed for mines.' },
] as const;

export const CATS = [
  { name: 'Housing', icon: '🏠' }, { name: 'Food', icon: '🌾' }, { name: 'Gathering', icon: '⛏️' },
  { name: 'Industry', icon: '⚒️' }, { name: 'Defence', icon: '🛡️' }, { name: 'Civic', icon: '⛪' }, { name: 'Land', icon: '⛰️' },
];

export const KIND_ICON = ['🏠', '🌾', '🧱', '🗼', '🪓', '🪚', '🪨', '🟤', '🏺', '⛏️', '💰', '♨️', '🔥', '⚒️', '🪙', '🏰', '🕳️', '⛪', '🏹', '⚔️', '🛠️', '🪵', '🚪', '🌉', '🌊', '📦', '🏯', '⚖️', '🏪', '☸️', '🥕', '🌳', '🏞️', '⛰️', '🕳️', '⚓', '🚧', '🛤️', '🪵'];

/** Kinds without a levelled pad under them (walls, fences, gates, drawbridges, moats). */
export const NOPAD = new Set([2, 21, 22, 23, 24, 32, 33, 34, 37, 38]);
/** Kinds the wall pen can draw in one stroke, and the distance between the pieces it lays. */
export const PEN_SPACING: Record<number, number> = { 0: 7, 1: 14, 30: 7.2, 37: 4, 2: 6, 21: 4, 24: 4, 32: 4, 33: 4, 34: 4 };

const GENERIC_TIERS = ['Rustic', 'Timber', 'Stone', 'Fortified'];
export const TIER_NAMES: Record<number, string[]> = {
  0: ['Hut', 'Cottage', 'Stone House', 'Manor House'],
  3: ['Wooden Lookout', 'Timber Fort', 'Stone Tower', 'Bastion'],
  2: ['Plank Wall', 'Timber Wall', 'Stone Wall', 'Battlement'],
  15: ['Longhall', 'Manor', 'Keep', 'Castle'],
  17: ['Chapel', 'Church', 'Abbey', 'Cathedral'],
  18: ['Hunting Cabin', "Hunter's Lodge", "Forester's Hall", 'Hunting Manor'],
  19: ['Drill Yard', 'Garrison', 'Barracks', 'Fortress'],
  20: ["Carpenter's Shed", "Builders' Yard", "Masons' Lodge", 'Guild Hall'],
  25: ['Storehouse', 'Warehouse', 'Stone Warehouse', 'Great Warehouse'], 26: ['Motte Tower', 'Stone Keep', 'Great Keep', 'Citadel'], 27: ['Moot Hall', 'Courthouse', 'Assize Hall', 'Royal Court'], 28: ['Market Stalls', 'Market Square', 'Market Hall', 'Grand Market'], 29: ['Mill Wheel', 'Watermill', 'Stone Mill', 'Great Mill'], 30: ['Kitchen Garden', 'Herb Garden', 'Walled Garden', 'Pleasure Garden'], 31: ['Green', 'Park', 'Gardens', 'Royal Park'], 32: ['River'], 33: ['Raised Ground'], 34: ['Lowered Ground'],
  35: ['Landing Stage', 'Harbour', 'Port', 'Great Port'], 36: ['Toll Post', 'Toll House', 'Toll Gate', 'Customs House'], 37: ['Dirt Road'], 38: ['Footbridge', 'Timber Bridge', 'Stone Bridge', 'Great Bridge'],
  21: ['Spiked Logs'], 22: ['Wooden Gate', 'Timber Gate', 'Stone Gatehouse', 'Fortified Gatehouse'], 23: ['Drawbridge'], 24: ['Moat'],
};
export const tierName = (kind: number, tier: number) => (TIER_NAMES[kind] ?? GENERIC_TIERS)[tier];

export const STATUS = ['Working', 'Waiting for materials', 'Resource exhausted', 'Storage full', 'Idle', 'Drawn up'];

export const PLACE_ERRORS: Record<number, string> = {
  [-1]: 'Unknown building', [-2]: 'Outside your village border — build more to grow it', [-3]: 'Something is in the way',
  [-4]: 'Too close to water', [-5]: 'Ground is too steep', [-6]: 'Not enough resources', [-7]: 'Needs a nearby ore or stone deposit',
  [-8]: 'Needs a forest nearby', [-9]: 'Cannot build that', [-18]: 'No water to bridge here — click closer to a moat, river or lake', [-19]: 'Too wide for a footbridge: bridges of better tiers span more',
  [-16]: 'Needs water beside it: a river, lake or moat', [-17]: 'An ore or stone deposit is in the way', [-14]: 'It is burning — put the fire out first', [-102]: 'Not enough archers in the barracks', [-103]: 'The tower is full', [-104]: 'Not during a battle', [-15]: 'Nothing to repair',
  [-11]: 'Build a barracks first', [-12]: 'Your barracks is too basic for that unit — upgrade it', [-13]: 'Not enough villagers to recruit',
};

export const DEPOSIT = [
  { name: 'Stone outcrop', icon: '🪨', color: '#9aa0a6' },
  { name: 'Clay bank', icon: '🟤', color: '#b5693a' },
  { name: 'Iron vein', icon: '🟠', color: '#b5482a' },
  { name: 'Gold vein', icon: '🟡', color: '#e6b800' },
];

/** The decisions put to the player (see World.choose): a title, a line of story and the options. */
export const CHOICES: { title: string; story: string; options: string[] }[] = [
  { title: 'Plague in the village', story: 'The sick lie in every street. Your reeve asks what to do.', options: ['Quarantine the sick (they stop working for 5 days; fewer die)', 'Carry on as usual'] },
  { title: 'A travelling preacher', story: 'A preacher with a worn cloak asks leave to speak in the square.', options: ['Welcome him (20 coins; spirits rise for 10 days)', 'Turn him away'] },
  { title: 'A noble visits', story: 'A knight with a small train asks for hospitality.', options: ['Hold a feast (100 grain, 30 coins; he leaves 90 coins)', 'Decline politely'] },
  { title: 'A hard winter', story: 'The first snow has fallen and the woodpiles are low.', options: ['Buy firewood (60 coins for 80 wood)', 'Share what there is (firewood lasts twice as long, people grumble)', 'Do nothing'] },
];

const HERO_NAME = (i: number) => ['Sir Aldric', 'Dame Isolde', 'Lord Godfrey', 'Lady Maud', 'Sir Baldwin', 'Dame Hawise', 'Lord Roland', 'Lady Eleanor', 'Sir Hugh', 'Dame Alys', 'Lord Edmund', 'Lady Cecily'][i % 12];

export const EVENT_TEXT = (k: number, a: number, b: number): { text: string; tone: 'good' | 'bad' | 'info' } => {
  switch (k) {
    case 0: return { text: `A bountiful harvest! +${a} grain.`, tone: 'good' };
    case 1: return { text: `Plague breaks out! ${a} villagers fall ill.`, tone: 'bad' };
    case 2: return { text: `The raiders pillaged the village: ${a} gold stolen, ${b} defenders fell.`, tone: 'bad' };
    case 3: return { text: 'The attackers were beaten back!', tone: 'good' };
    case 4: return { text: `A merchant caravan pays ${a} gold for passage.`, tone: 'good' };
    case 5: return { text: 'Famine! A villager starves.', tone: 'bad' };
    case 6: return { text: 'The plague has passed.', tone: 'good' };
    case 7: return { text: a ? (b ? 'An army marches on your village!' : `Bandits attack! ${a} raiders approach.`) : 'A battle begins.', tone: 'bad' };
    case 8: return { text: 'Fire! A building has caught alight.', tone: 'bad' };
    case 9: return { text: 'A building has been destroyed.', tone: 'bad' };
    case 11: return { text: 'Villagers put out the fire with water from the well.', tone: 'good' };
    case 13: return { text: 'The builders finished repairing a building.', tone: 'good' };
    case 14: return { text: 'The builders raised a ruined building again.', tone: 'good' };
    case 16: return { text: 'A bitter winter without firewood: someone froze to death.', tone: 'bad' };
    case 18: return { text: `${CHOICES[a]?.title ?? 'A decision'}: the village waits for your word.`, tone: 'info' };
    case 19: return { text: `You decided: ${CHOICES[a]?.options[b] ?? ''}`, tone: 'info' };
    case 21: return b === -1 ? { text: `${HERO_NAME(a)} has fallen. You may take another lord into your service.`, tone: 'bad' } : b > 0 ? { text: `${HERO_NAME(a)} has grown into a level ${b} commander.`, tone: 'good' } : { text: `${HERO_NAME(a)} takes command of your defence.`, tone: 'good' };
    case 17: return { text: `Robbers waylaid a caravan: ${a} ${RES[b]?.name.toLowerCase() ?? 'goods'} lost.`, tone: 'bad' };
    case 15: return a >= 0 ? { text: `Merchants at your port bought ${RES[b]?.name.toLowerCase() ?? 'goods'} for ${a} gold.`, tone: 'good' } : { text: `Merchants sold you grain for ${-a} gold.`, tone: 'info' };
    case 10: return { text: `A new ${UNIT_NAMES[a] ?? 'soldier'} finished training.`, tone: 'good' };
    default: return { text: 'Something happened.', tone: 'info' };
  }
};

export const defs: BuildingDef[] = JSON.parse(catalog());

export const fmtCost = (c: [number, number][]) => c.map(([r, n]) => `${RES[r].icon}${n}`).join(' ');


export interface UnitDef { id: number; name: string; hp: number; dmg: number; range: number; speed: number; armor: number; cost: [number, number][]; tier: number; time: number; desc: string }
export const units: UnitDef[] = JSON.parse(unitsJson());
export const UNIT_ICON = ['🔱', '🏹', '⚔️', '🐴', '☄️', '🪓'];
export const UNIT_NAMES = units.map(u => u.name);

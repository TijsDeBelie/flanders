import { icon, KIND_ICON_NAMES, UNIT_ICON_NAMES, CAT_ICON_NAMES } from './ui/icons';
import init, { catalog, units as unitsJson, bosses as bossesJson } from './wasm/game_core.js';
import { bossTitle, type BossDef } from './bosses';
import { bribedText } from './bribe';

await init(); // the building catalog comes from the Rust core, so wasm must be ready before this module evaluates

export interface BuildingDef {
  id: number; name: string; cat: number; r: number; weight: number;
  cost: [number, number][]; jobs: number; inputs: [number, number][]; outputs: [number, number][];
  alternateRecipe?: { inputs: [number, number][]; outputs: [number, number][] };
  winterRecipe?: { inputs: [number, number][]; outputs: [number, number][] };
  cycle: number; req: number; reqArg: number; housing: number; maxTier: number; opts?: { n: string; d: string; t: number }[]; desc: string;
}

export const RES = [
  { key: 'wood', name: 'Wood', icon: 'wood', hint: 'Felled by woodcutters. Burned for charcoal, sawn into planks.' },
  { key: 'planks', name: 'Planks', icon: 'planks', hint: 'Sawn timber for better buildings.' },
  { key: 'stone', name: 'Stone', icon: 'stone', hint: 'Quarried from stone outcrops.' },
  { key: 'clay', name: 'Clay', icon: 'clay', hint: 'Dirt dug from clay banks. Fired into bricks.' },
  { key: 'bricks', name: 'Bricks', icon: 'bricks', hint: 'Fired clay. Needed for grand upgrades.' },
  { key: 'ironore', name: 'Iron ore', icon: 'ironore', hint: 'Mined from iron veins. Smelt it with charcoal.' },
  { key: 'iron', name: 'Iron', icon: 'iron', hint: 'Smelted ingots, forged into tools.' },
  { key: 'goldore', name: 'Gold ore', icon: 'goldore', hint: 'Mined from rare gold veins.' },
  { key: 'gold', name: 'Gold', icon: 'gold', hint: 'Coin. Taxes, caravans and the mint bring it in.' },
  { key: 'charcoal', name: 'Charcoal', icon: 'charcoal', hint: 'Fuel for every furnace and kiln.' },
  { key: 'grain', name: 'Grain', icon: 'grain', hint: 'Feeds your villagers.' },
  { key: 'tools', name: 'Tools', icon: 'tools', hint: 'Forged by the blacksmith. Needed for mines.' },
  { key: 'fish', name: 'Fish', icon: 'fish', hint: 'Landed by fishing huts. Raw fish provides a meal per fish. Smoking makes it more filling.' },
  { key: 'smokedfish', name: 'Smoked fish', icon: 'smokedfish', hint: 'Smoked in a smokehouse. Cooked food fills half as much again as raw.' },
  { key: 'bread', name: 'Bread', icon: 'bread', hint: 'Baked from grain in a bakery. Fills twice as much as raw grain.' },
  { key: 'meat', name: 'Meat', icon: 'meat', hint: 'Raised in pastures or brought in by hunters. Feeds the village, or smoke it for more.' },
  { key: 'smokedmeat', name: 'Smoked meat', icon: 'smokedmeat', hint: 'Meat smoked in a smokehouse set to meat. Cooked food fills half as much again as raw.' },
] as const;

export const CATS = [{ name: 'Housing', icon: CAT_ICON_NAMES[0] }, { name: 'Food', icon: CAT_ICON_NAMES[1] }, { name: 'Gathering', icon: CAT_ICON_NAMES[2] }, { name: 'Industry', icon: CAT_ICON_NAMES[3] }, { name: 'Defence', icon: CAT_ICON_NAMES[4] }, { name: 'Civic', icon: CAT_ICON_NAMES[5] }, { name: 'Land', icon: CAT_ICON_NAMES[6] }, { name: 'Roads', icon: 'road' }];

/** Icon names (see ui/icons.ts) by building kind. */
export const KIND_ICON = KIND_ICON_NAMES;

/** The id of the level-ground tool in the build palette: not a building (it has no row in the game's table), a tool that levels a patch of ground (op `level`). */
export const LEVEL_TOOL = 99;
/** The planting brush: a tool like Level Ground, with no building behind it. */
export const PLANT_TOOL = 98;

/** Kinds without a levelled pad under them (walls, fences, gates, drawbridges, moats). */
export const NOPAD = new Set([2, 21, 22, 23, 24, 32, 33, 34, 37, 38]);
/** Kinds the wall pen can draw in one stroke, and the distance between the pieces it lays. */
export const PEN_SPACING: Record<number, number> = { 0: 7, 1: 14, 30: 7.2, 2: 6, 21: 4, 24: 4, 32: 4, 33: 4, 34: 4 };

const GENERIC_TIERS = ['Rustic', 'Timber', 'Stone', 'Fortified'];
export const TIER_NAMES: Record<number, string[]> = {
  0: ['Hut', 'Cottage', 'Stone House', 'Manor House'],
  1: ['Small Farm', 'Farmstead', 'Grange', 'Great Farm'],
  4: ["Woodcutter's Hut", 'Logging Camp', 'Lumber Yard', 'Great Lumber Camp'],
  5: ['Pit Saw', 'Sawmill', 'Water Sawmill', 'Great Sawmill'],
  6: ['Stone Pit', 'Quarry', 'Deep Quarry', 'Great Quarry'],
  7: ['Clay Hole', 'Clay Pit', 'Deep Clay Pit', 'Great Clay Works'],
  8: ['Clamp Kiln', 'Brick Kiln', 'Brickworks', 'Great Brickworks'],
  9: ['Shallow Mine', 'Iron Mine', 'Deep Mine', 'Great Mine'],
  10: ['Panning Camp', 'Gold Mine', 'Deep Gold Mine', 'Great Gold Mine'],
  11: ['Charcoal Clamp', 'Charcoal Burner', 'Charcoal Works', 'Great Charcoal Works'],
  12: ['Bloomery', 'Smelter', 'Blast Furnace', 'Great Foundry'],
  13: ['Forge', 'Smithy', 'Blacksmith', 'Master Smithy'],
  14: ['Coin Press', 'Mint', 'Royal Mint', 'Great Mint'],
  16: ['Well', 'Stone Well', 'Fountain', 'Great Fountain'],
  3: ['Wooden Lookout', 'Timber Fort', 'Stone Tower', 'Bastion'],
  2: ['Plank Wall', 'Timber Wall', 'Stone Wall', 'Battlement'],
  15: ['Longhall', 'Manor', 'Keep', 'Castle'],
  17: ['Chapel', 'Church', 'Abbey', 'Cathedral'],
  18: ['Hunting Cabin', "Hunter's Lodge", "Forester's Hall", 'Hunting Manor'],
  19: ['Drill Yard', 'Garrison', 'Barracks', 'Fortress'],
  20: ["Carpenter's Shed", "Builders' Yard", "Masons' Lodge", 'Guild Hall'],
  25: ['Storehouse', 'Warehouse', 'Stone Warehouse', 'Great Warehouse'], 26: ['Motte Tower', 'Stone Keep', 'Great Keep', 'Citadel'], 27: ['Moot Hall', 'Courthouse', 'Assize Hall', 'Royal Court'], 28: ['Market Stalls', 'Market Square', 'Market Hall', 'Grand Market'], 29: ['Mill Wheel', 'Watermill', 'Stone Mill', 'Great Mill'], 30: ['Kitchen Garden', 'Herb Garden', 'Walled Garden', 'Pleasure Garden'], 31: ['Green', 'Park', 'Gardens', 'Royal Park'], 32: ['River'], 33: ['Raised Ground'], 34: ['Lowered Ground'],
  35: ['Landing Stage', 'Harbour', 'Port', 'Great Port'], 36: ['Toll Post', 'Toll House', 'Toll Gate', 'Customs House'], 37: ['Dirt Track', 'Gravel Road', 'Cobbled Road', 'Flagstone Road'], 44: ['Plaza'], 38: ['Footbridge', 'Timber Bridge', 'Stone Bridge', 'Great Bridge'],
  39: ['Infirmary', 'Hospice', 'Hospital', 'Great Hospital'], 40: ['Burial Ground', 'Graveyard', 'Cemetery', 'Great Necropolis'],
  41: ['Fishing Hut', "Fisher's Cottage", 'Fishing Wharf', 'Fishery'], 42: ['Smokehouse', 'Smokery', 'Great Smokery', 'Fish Hall'], 43: ['Bakery', 'Bakehouse', 'Great Bakehouse', 'Royal Bakery'],
  45: ['Sheepfold', 'Grazing Yard', 'Cattle Pasture'],
  46: ['Pigsty', 'Pig Farm', 'Piggery'], 47: ['Stable'], 48: ['Forester', "Forester's Lodge", "Woodwarden's Hall", 'Royal Forestry'], 49: ['Embassy', 'Great Embassy', 'Royal Embassy', 'Imperial Embassy'], 50: ['Fire Station', 'Fire Brigade', 'Fire Hall', 'Royal Fire Guard'],
  21: ['Spiked Logs'], 22: ['Wooden Gate', 'Timber Gate', 'Stone Gatehouse', 'Fortified Gatehouse'], 23: ['Drawbridge'], 24: ['Moat'],
};
export const tierName = (kind: number, tier: number) => (TIER_NAMES[kind] ?? GENERIC_TIERS)[tier];

export const STATUS = ['Working', 'Waiting for materials', 'Resource exhausted', 'Storage full', 'Idle', 'Drawn up', 'Lowered for an army', 'Deposit dormant', 'Waiting for stock above reserve'];

export const PLACE_ERRORS: Record<number, string> = {
  [-1]: 'Unknown building', [-2]: 'Outside your village border — build more to grow it', [-3]: 'Something is in the way', [-27]: 'Too far out — lay a road to here and build beside it',
  [-4]: 'Too close to water', [-5]: 'Ground is too steep', [-6]: 'Not enough resources', [-7]: 'Needs a nearby ore or stone deposit',
  [-8]: 'Needs a forest nearby', [-9]: 'Cannot build that', [-18]: 'No water to bridge here — click closer to a moat, river or lake', [-19]: 'Too wide for a footbridge: bridges of better tiers span more',
  [-16]: 'Needs water beside it: a river, lake or moat', [-20]: 'A gate must stand in a wall: click a wall piece', [-24]: 'A patch to level is 3 to 14 wide', [-25]: 'No dry ground round it to level to: the patch is in water', [-26]: 'A building stands in it: its footing would be left in the air', [-28]: 'Choose a ground height from 1 to 24', [-29]: 'Choose a target height in the direction of the tool', [-21]: 'That stretch of road is too long: put a point in between',
  [-17]: 'An ore or stone deposit is in the way', [-14]: 'It is burning — put the fire out first', [-102]: 'Not enough archers in the barracks', [-103]: 'The tower is full', [-104]: 'Not during a battle', [-15]: 'Nothing to repair',
  [-11]: 'Build a barracks first', [-12]: 'Your barracks is too basic for that unit — upgrade it', [-13]: 'Not enough villagers to recruit',
};

export const DEPOSIT = [
  { name: 'Stone outcrop', icon: 'stone', color: '#9aa0a6' },
  { name: 'Clay bank', icon: 'clay', color: '#b5693a' },
  { name: 'Iron vein', icon: 'ironore', color: '#b5482a' },
  { name: 'Gold vein', icon: 'goldore', color: '#e6b800' },
];

/** The decisions put to the player (see World.choose): a title, a line of story and the options. */
export const CHOICES: { title: string; story: string; options: string[] }[] = [
  { title: 'Plague in the village', story: 'The sick lie in every street, and it will be days before the worst is over. Your reeve asks what to do.', options: ['Quarantine the sick (they stop working for 7 days; a lower peak, fewer die)', 'Carry on as usual'] },
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
    case 27: return { text: bribedText(a, b), tone: 'info' };
    case 28: return {
      text: a === 1 ? (b ? 'The gate held against the raid.' : 'The raiders breached the gate.')
        : b ? `The supply caravan escaped.${b > 1 ? ` +${b - 1} grain.` : ''}` : 'The raiders seized the supply caravan.',
      tone: b ? 'good' : 'bad',
    };
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
    case 22: return { text: `Bodies lie unburied and sickness spreads: ${a} dead have no grave.`, tone: 'bad' };
    case 23: return { text: `The church held a service. The tithe brought ${a} gold.`, tone: 'good' };
    case 24: return { text: 'A foreign envoy was received with gifts.', tone: 'info' };
    case 21: return b === -1 ? { text: `${HERO_NAME(a)} has fallen. You may take another lord into your service.`, tone: 'bad' } : b > 0 ? { text: `${HERO_NAME(a)} has grown into a level ${b} commander.`, tone: 'good' } : { text: `${HERO_NAME(a)} takes command of your defence.`, tone: 'good' };
    case 17: return { text: `Robbers waylaid a caravan: ${a} ${RES[b]?.name.toLowerCase() ?? 'goods'} lost.`, tone: 'bad' };
    case 15: return a >= 0 ? { text: `Merchants at your port bought ${RES[b]?.name.toLowerCase() ?? 'goods'} for ${a} gold.`, tone: 'good' } : { text: `Merchants sold you grain for ${-a} gold.`, tone: 'info' };
    case 10: return { text: `A new ${UNIT_NAMES[a] ?? 'soldier'} finished training.`, tone: 'good' };
    case 25: return b === 2 ? { text: `${bossTitle(bosses, a >> 4, a & 15)}, has pitched a plague camp outside the village and the sickness will not die down. Send a fast raid to kill him.`, tone: 'bad' } : { text: `${bossTitle(bosses, a >> 4, a & 15)}, has fallen!`, tone: 'good' };
    case 26: return { text: 'Your army goes into a lair.', tone: 'info' };
    default: return { text: 'Something happened.', tone: 'info' };
  }
};

export const defs: BuildingDef[] = JSON.parse(catalog());

/** The picture of a resource, `size` px, as SVG markup. */
export const resIcon = (r: number, size = 16) => icon(RES[r].key, size);
export const fmtCost = (c: [number, number][]) => c.map(([r, n]) => `${resIcon(r)}${n}`).join(' ');


export interface UnitDef { id: number; name: string; hp: number; dmg: number; range: number; speed: number; armor: number; cost: [number, number][]; tier: number; time: number; desc: string }
export const units: UnitDef[] = JSON.parse(unitsJson());
/** The bosses (Warlord, Ogre of the Marches): ids start at 1, as in the battle data. */
export const bosses: BossDef[] = JSON.parse(bossesJson());
export const UNIT_ICON = UNIT_ICON_NAMES;
export const UNIT_NAMES = units.map(u => u.name);

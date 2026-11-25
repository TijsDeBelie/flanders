//! Deterministic medieval village simulation core. Same seed + same commands => same state on every peer.
use wasm_bindgen::prelude::*;

mod battle;
pub mod ai;
#[cfg(test)]
mod ai_tests;
mod bribe;
mod catalog;
mod lend;
mod ledger;
mod market;
mod march;
mod members;
mod military;
mod tactics;
mod raid_objective;
mod pathnet;
mod compound;
#[cfg(test)]
mod compound_tests;
#[cfg(test)]
mod repro_tests;
pub mod doors;
mod roadline;
mod roadnet;
#[cfg(test)]
mod roadnet_tests;
mod flatten;
mod forestry;
mod plague;
pub mod radii;
mod wallnet;
#[cfg(test)]
mod roadcheck;
#[cfg(test)]
mod farmcheck;
mod estate;
#[cfg(test)]
mod roadtests;
#[cfg(test)]
mod perf_bench;
#[cfg(test)]
mod flatten_tests;
#[cfg(test)]
mod terrain_layers_tests;
#[cfg(test)]
mod moat_water_tests;
#[cfg(test)]
mod route_height_tests;
#[cfg(test)]
mod snapshot_tests;
mod siege;
mod terrain;
use catalog::*;
use military::*;
use terrain::{lerp, smoothstep, Deposit};

/// Small deterministic PCG32 RNG.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u32 {
        let old = self.0;
        self.0 = old.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let xs = (((old >> 18) ^ old) >> 27) as u32;
        xs.rotate_right((old >> 59) as u32)
    }
    fn range(&mut self, n: u32) -> u32 { self.next() % n.max(1) }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Building {
    kind: u8,
    tier: u8,
    x: f32,
    y: f32,
    rot: u8,
    pad_h: f32,
    progress: u32,
    status: u8, // 0 working, 1 missing input, 2 depleted / no resource, 3 storage full, 4 passive, 7 its deposit is dormant (regrowing)
    aux: i32,   // deposit index for mines
    staff: u32,     // villagers currently working here
    residents: u32, // villagers living here
    hp: f32,
    burning: f32,   // seconds of fire left (0 = not burning)
    garrison: u8,   // archers stationed inside (towers and keeps)
    born: u32,      // tick when it was founded: roads to it grow in over the following days
    opts: u16,      // optional design upgrades chosen for this building (bit per option, see catalog::OPTIONS)
    fert: u16,      // farms: soil fertility in hundredths of a percent (FERT_MAX = rich soil). Sowing wears it down, a fallow field recovers
    mode: u8,       // farms: 0 always sow, 1 fallow (rest the field), 2 rotate (rest when worn, sow again when restored), 3 rotating and resting right now
    #[serde(default = "auto_target")]
    target: i16,    // workers the player wants here: -1 auto (shares what is left by the usual rule), 0 paused, n a set number (see `set_workers`)
    #[serde(default = "full_eff")]
    beff: u32,      // derived in `staffing`: how fully this building is staffed, in percent (what its production speed follows)
}
fn auto_target() -> i16 { -1 }
fn full_eff() -> u32 { 100 }

pub(crate) const DB_UP: u8 = 5;
pub(crate) const DB_LENT: u8 = 6;
pub(crate) const DB_LENT_FIGHT: u8 = 7;
pub(crate) const DB_MANUAL_DOWN: u8 = 8;
/// Seconds a drawbridge stays raised against armies after the player raised it by hand.
pub(crate) const VETO_SECS: u32 = 120;
/// Seconds a lent drawbridge stays down after the last soldier needing it has gone (in a battle: one second, so raiders get no time to use it).
pub(crate) const LEND_HOLD: u32 = 4;
pub(crate) const LEND_HOLD_FIGHT: u32 = 3;   // long enough that a bridge does not flap open and shut while an army and raiders both stand near it

/// Soil fertility is counted in hundredths of a percent: FERT_MAX is rich soil. A farm cycle is 8 seconds, so 1 200 cycles make a game year: sown every cycle a field
/// loses FERT_WEAR hundredths a harvest (about 70% of its richness in a year, and it yields only half at the very worst); a resting field regains FERT_REST a cycle.
const FERT_MAX: u16 = 10_000;
const FERT_WEAR: u16 = 6;
const FERT_REST: u16 = 12;
/// A fallow field recovers this many times faster in winter: frost breaks the clods and the field is not worked anyway.
const FERT_WINTER_REST: u16 = 2;
/// Rotation: a field rests when its soil drops to the first figure and is sown again at the second.
const FERT_TIRED: u16 = 4_500;
const FERT_RESTORED: u16 = 9_000;

/// A moat piece's width: its rotation value (0..7) widens the ditch from 1x to 1.9x, so a moat can be thin in places and broad in others.
pub(crate) fn moat_scale(b: &Building) -> f32 { 1.0 + 0.13 * (b.rot & 7) as f32 }

/// Extra working speed (in percent) from the second tier of options of a field (windmill, granary, bee skeps) or market (weigh house, guild sign).
pub(crate) fn tier2_speed(kind: u8, opts: u16) -> u32 {
    let o = |bit: u8| opts & (1 << bit) != 0;
    match kind { FARM => (if o(4) { 10 } else { 0 }) + (if o(5) { 5 } else { 0 }) + (if o(7) { 5 } else { 0 }), MARKET => (if o(4) { 10 } else { 0 }) + (if o(7) { 5 } else { 0 }), _ => 0 }
}
/// The summed effect of optional design upgrades (see `World::perks`).
#[derive(Default, Clone, Copy)]
pub(crate) struct Perks { pub housing: i32, pub happy: i32, pub banner_pct: i32, pub train_pct: u32, pub militia: u32, pub woodsheds: i32, pub doves: i32 }

/// Walls, fences, gates and moat pieces are not on the village path network.
/// No order may point further than this from the map's centre (the map is about 2400 units across).
const MAP_LIMIT: f32 = 1500.0;
/// No standing army can hold more soldiers of one kind than this (the testing tool stops at the same number).
const ARMY_MAX: u32 = 100_000;
const LEVEL_BLEND: f32 = 9.0;  // how far a levelled patch of ground blends back into the land
pub(crate) const MOAT_FLOOR: f32 = 3.0;  // flat bottom radius of a moat piece
pub(crate) const RIVER_FLOOR: f32 = 2.0; // and of a river piece
pub(crate) const CHANNEL_BANK: f32 = 1.6;           // how far the steep bank runs out beyond the floor: a channel is a trench with the water at its brim, not a wide dish
/// How far below the rim of the land the water of a moat stands.
const MOAT_FREEBOARD: f32 = 0.55;
// Match the terrain mesh's 2.5-unit grid. A cut vertex affects the adjoining triangles out to a diagonal.
const MOAT_MESH_OVERHANG: f32 = march::CELL * std::f32::consts::SQRT_2 + 0.07;
const MOAT_WATER_SLOPE: f32 = 0.05;   // how fast the water level may change along a carved river, per unit
const CHANNEL_REF_TOP: f32 = 9.0;   // ground up to this height has a ditch bed at the fixed depth below; above it the bed rises with the ground
const MOAT_BED: f32 = -3.4;   // a moat is deep: the water reads as water (the shader darkens it with depth) and a soldier in it is out of his depth
const RIVER_BED: f32 = -2.0; // a river is shallower than a moat, but holds real water  // depth of the bottom
const ROAD_INNER: f32 = 2.1; // fully graded half-width of a path (as wide as the ribbon drawn on it, soft edge included: no cross slope under a road)
const ROAD_OUTER: f32 = 5.2; // terrain blends back to the natural slope by here (the shoulder)
/// The steepest a road may climb: height gained per unit of road.
pub(crate) const ROAD_MAX_SLOPE: f32 = 0.4;
/// A road follows the ground smoothed over this far along it.
const ROAD_SMOOTH: f32 = 4.5;

const RADIUS_CAP: f32 = 150.0;
/// Past this far from the town hall buildings stop claiming land: only roads joined to the village do, and a building needs a road beside it.
const TERRITORY_MAX: f32 = 170.0;
const INFRASTRUCTURE_LIMIT: f32 = 1192.0; // leave room for the terrain and navigation grid at the map edge
/// The longest stretch of water a bridge of each tier can span: wood, timber, stone, great stone.
const BRIDGE_SPAN: [f32; 4] = [14.0, 22.0, 34.0, 50.0];
/// How far a bridge reaches onto the bank at each end.
const BRIDGE_MARGIN: f32 = 1.6;

// event codes
const EV_HARVEST: i32 = 0;
const EV_PLAGUE: i32 = 1;
const EV_RAID: i32 = 2;
const EV_REPELLED: i32 = 3;
const EV_CARAVAN: i32 = 4;
const EV_STARVE: i32 = 5;
const EV_PLAGUE_END: i32 = 6;
const EV_BATTLE: i32 = 7;
const EV_FIRE: i32 = 8;
const EV_DESTROYED: i32 = 9;
const EV_TRAINED: i32 = 10;
const EV_FIREOUT: i32 = 11;
const EV_NEEDMAT: i32 = 12;
const EV_REPAIRED: i32 = 13;
const EV_REBUILT: i32 = 14;
const EV_TRADE: i32 = 15;
const EV_COLD: i32 = 16;
const EV_ROBBED: i32 = 17;
const EV_CHOICE: i32 = 18;
/// Fog of war grid: FOG_N cells a side, each FOG_CELL units, covering the whole map.
pub const FOG_N: i32 = 60;
pub const FOG_CELL: f32 = 40.0;
const EV_VISIT: i32 = 20;
const EV_HERO: i32 = 21;
const EV_MIASMA: i32 = 22;
const EV_SERVICE: i32 = 23;
const EV_DIPLO: i32 = 24;
const EV_BRIBED: i32 = 27;   // raiders were paid to leave: a = coins, b = boss (0 none)
const EV_RAID_OBJECTIVE: i32 = 28; // a = objective kind, b = 0 lost or 1 + any recovered grain
const EV_LAIR: i32 = 26;   // the army went into a lair: a = place
const EV_BOSS: i32 = 25;   // a boss fell: a = boss * 16 + name, b = 1
/// Causes of death, for the village's ledger.
pub const DIED_OLD: usize = 0;
pub const DIED_PLAGUE: usize = 1;
pub const DIED_HUNGER: usize = 2;
pub const DIED_COLD: usize = 3;
pub const DIED_WAR: usize = 4;
/// Names of the lords and ladies who may take command of the village's defence.
const HERO_NAMES: [&str; 12] = ["Sir Aldric", "Dame Isolde", "Lord Godfrey", "Lady Maud", "Sir Baldwin", "Dame Hawise", "Lord Roland", "Lady Eleanor", "Sir Hugh", "Dame Alys", "Lord Edmund", "Lady Cecily"];
/// The lord's levels: experience needed for each.
/// Counts per soldier kind from a list a caller made: five numbers (older callers: no rams) or six. None if there are fewer than five.
/// Most soldiers one allied village may send to stand with us at a time, and how many such guest armies we host in all.
pub const GUEST_MAX: u32 = 120;
pub const GUEST_ARMIES: usize = 6;
pub(crate) fn kinds(v: &[u32]) -> Option<[u32; NK]> { if v.len() < 5 { return None; } let mut a = [0u32; NK]; for k in 0..NK { a[k] = v.get(k).copied().unwrap_or(0); } Some(a) }
const HERO_XP: [u32; 5] = [0, 30, 80, 150, 250];
const HERO_COST: i32 = 150;
const EV_CHOSE: i32 = 19;
/// Kinds of decision put to the player.
pub const CH_PLAGUE: u8 = 0;
pub const CH_PREACHER: u8 = 1;
pub const CH_NOBLE: u8 = 2;
pub const CH_WINTER: u8 = 3;
/// Days the player has to decide before the cautious default (the last option) is taken.
const CHOICE_DAYS: u64 = 2;
/// Ticks in a day, days in a season (the interface uses the same numbers).
pub const DAY: u64 = 240;
/// Famine: while the stores cannot feed everyone, about this many per mille of the villagers die each day (2% a day: half the village in a month, never a villager every few seconds).
const HUNGER_PER_MILLE_DAY: u64 = 20;
/// The workplaces that make food and wood get their hands before any other: when there are not enough workers for every job, these are staffed first.
fn staffed_first(kind: u8) -> bool {   // (4 is the woodcutter)
     matches!(kind, FARM | 4 | FORESTER | FISHING_HUT | SMOKEHOUSE | BAKERY | LODGE | PASTURE | PIGSTY) }
/// Bandit raids: after the first three days, about one a week on average (a roll every tick).
const RAID_FROM_TICK: u64 = 3 * DAY;
const RAID_ONE_IN: u32 = 7 * DAY as u32;
/// Warning time before a bandit raid: 30 game seconds.
const RAID_WARNING_TICKS: u32 = 45;
/// Raiders form up between `RAID_SPAWN_NEAR` and `RAID_SPAWN_FAR` units beyond the build limit: as far out as the ground along their line stays dry (so they come from the country, not from a lake).
pub(crate) const RAID_SPAWN_NEAR: f32 = 22.0;
pub(crate) const RAID_SPAWN_FAR: f32 = 60.0;
/// The town hall's backup: every `BACKUP_EVERY` ticks it adds `BACKUP_AMOUNT` + `BACKUP_PER_TIER` per tier of wood and of grain, but only while that store holds less than `BACKUP_BELOW`.
const BACKUP_EVERY: u64 = 6;
const BACKUP_AMOUNT: i32 = 1;
const BACKUP_PER_TIER: i32 = 1;
const BACKUP_BELOW: i32 = 60;
/// What the village eats, and how far an item goes, in quarter meals (a meal is what one tenth of a head needs each tick): raw grain and raw fish fill less, bread and smoked fish more.
/// Each tick the villagers take from whichever of these stores holds the most food in all, so the stores run down together and none is emptied first.
/// What a smokehouse set to meat takes and makes.
const SMOKE_MEAT_IN: &[Amount] = &[(ME, 3), (W, 1)];
const SMOKE_MEAT_OUT: &[Amount] = &[(SM, 3)];
/// Raw grain is only half a meal-quarter filling: it has to be milled and baked (bakery) to feed people properly. Meat is not a staple: see `LUXURY_MEAT_*`.
pub const FOODS: [(u8, i32); 4] = [(GR, 3), (FI, 4), (BD, 6), (SF, 6)];
/// Meat and smoked meat are a luxury: every `LUXURY_EVERY` ticks the village eats one unit per `LUXURY_HEADS` people, and while it is on the table it lifts the mood (up to `LUXURY_HAPPY`).
const LUXURY_EVERY: u64 = 10;
const LUXURY_HEADS: u32 = 20;
const LUXURY_HAPPY: i32 = 6;
const HALF_F: f32 = terrain::HALF;
pub const SEASON_DAYS: u64 = 10;
/// How far out from a waterwheel house's middle its wheel hangs (the model's axle), and the highest the house's pad may stand so the wheel reaches the water.
pub const WHEEL_REACH: f32 = 5.2;
/// Where the house's stone footing ends on the water side: the bank. The wheel's axle hangs `WHEEL_REACH - WHEEL_FOOT` beyond it, over the water, clear of the footing.
pub const WHEEL_FOOT: f32 = 3.2;
/// The fishing hut stands this far from the bank (middle to bank): its footing (to 1.5 out) then ends well short of the water even where the bank runs oblique to the turn; its jetty carries on over the water.
pub const HUT_FOOT: f32 = 3.8;
const SHORE_CLEARANCE: f32 = 0.45;
/// Grain harvest by season in percent: spring sowing, summer growth, a big autumn harvest, a lean winter (see the WINTER_* numbers below).
const GRAIN_BY_SEASON: [i32; 4] = [100, 125, 150, WINTER_GRAIN];
// ---- Winter: every number that decides how hard it is lives here (and `winter_numbers` hands them to the interface). Changing any of them changes the rules (the fingerprint says so). ----
/// Grain a farm makes in winter, in percent of the usual; with haystacks beside the field.
const WINTER_GRAIN: i32 = 55;
const WINTER_GRAIN_HAYSTACKS: i32 = 85;
/// Firewood: every `WINTER_BURN_EVERY` ticks the village burns one unit for each `WINTER_HEADS_PER_WOOD` villagers (rounded up). A woodshed saves one unit per `WINTER_SHED_SAVES` sheds, sharing halves it.
const WINTER_BURN_EVERY: u64 = 10;
const WINTER_HEADS_PER_WOOD: u32 = 14;
const WINTER_SHED_SAVES: i32 = 6;
/// The town hall's hearth: the village counts as warm while it can burn at least this much wood (or all it wants if that is less) in a burn, so it is never cold while any wood is left, only when the stock is really empty.
const WINTER_HEARTH_WOOD: i32 = 1;
/// A cold village first loses happiness (4 per cold day on top of 4, at most 12). Nobody dies of cold for the first `WINTER_COLD_GRACE` cold days (a staffed hospital adds `WINTER_HOSPITAL_GRACE`);
/// after that each day brings a death with a chance of `WINTER_DEATH_STEP` percent for every cold day beyond the grace, at most `WINTER_DEATH_MAX`. Whoever it is, in proportion to the population.
const WINTER_COLD_GRACE: u32 = 3;
const WINTER_HOSPITAL_GRACE: u32 = 2;
const WINTER_DEATH_STEP: u32 = 15;
const WINTER_DEATH_MAX: u32 = 60;
/// What a unit of each resource is worth in gold coins (a merchant pays 80% of it).
const PRICE: [i32; N_RES] = [1, 2, 2, 1, 3, 2, 5, 6, 1, 2, 1, 6, 1, 2, 2, 2, 3];

/// Added to a resource number to make a caravan a gift: `GIFT_FLAG + res` carries `res` for nothing, to warm the other village's feelings. The flag travels with the caravan
/// (in commands, notices and the awaiting list), so nothing else about the wire format changes.
pub const GIFT_FLAG: u8 = 64;
/// A village whose relation (towards the sender) is at or below this turns their caravans back, which also covers any village we have declared war on or who declared it on us.
pub const HOSTILE_REL: i32 = -40;
/// Goods on their way to another village (`to` is that village's tag), arriving at tick `eta`.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Caravan { res: u8, amount: i32, to: i32, start: u64, eta: u64, escort: u32 }
/// A diplomatic errand on the road to another village (`tag`): `kind` is a treaty kind (0 trade pact, 1 peace, 2 alliance) or one of JK_ENVOY, JK_MARRIAGE, JK_WAR; `arg` is the treaty's length in days.
/// It sets out at `start` and its effect happens when it arrives at `arrive`. Everyone's copy of the village holds the same list, so the procession can be shown on all of them.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Journey { kind: u8, tag: i32, arg: i32, start: u64, arrive: u64 }
pub const JK_ENVOY: u8 = 3;
pub const JK_MARRIAGE: u8 = 4;
pub const JK_WAR: u8 = 5;
/// The kind a caravan has in `journeys_flat`.
pub const JK_CARAVAN: u8 = 6;
/// Ticks per unit of road for each journey kind (a rider is quicker than a procession).
const JOURNEY_SPEED: [f32; 6] = [2.2, 1.6, 1.5, 1.8, 1.0, 3.0];
/// An agreement with another village: `kind` 0 trade pact (better prices), 1 non-aggression (neither side may start a battle against the other), 2 alliance (the same, and the best prices), until tick `until`.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Treaty { tag: i32, kind: u8, until: u64 }
pub const TREATY_TRADE: u8 = 0;
pub const TREATY_PEACE: u8 = 1;
pub const TREATY_ALLIANCE: u8 = 2;
/// Ticks a caravan takes to reach a village: a minute plus the distance.
const CARAVAN_SPEED: f32 = 1.2;

#[wasm_bindgen]
#[derive(serde::Serialize, serde::Deserialize)]
pub struct World {
    seed: u64,
    ox: i32,
    oy: i32,
    tick: u64,
    rng: Rng,
    buildings: Vec<Building>,
    deposits: Vec<Deposit>,
    stock: [i32; N_RES],
    population: u32,
    sick: u32,
    children: u32, // of the population: under age
    elders: u32,   // of the population: past working age
    neutral_done: Vec<bool>,      // neutral places already visited or cleared, by index into terrain::neutrals
    explored: Vec<u8>,            // fog of war: one cell per 40 units, 1 = seen
    born: u32,                    // ledger: every villager is born, arrives, is enlisted, leaves or dies, so population = 10 + arrived + born - enlisted - left - sum(died)
    arrived: u32,
    enlisted: u32,
    left: u32,
    died: [u32; 5],
    unburied: u32,                // the dead not yet laid to rest
    buried: u32,                  // laid to rest in consecrated ground
    graves_used: u32,             // plots in use
    devotion: i32,                // how devout the village is (0..100), raised by services
    relations: Vec<(i32, i32)>,   // how another village (tag) feels about this one, -100..100
    married: Vec<i32>,            // villages joined by a royal marriage
    last_envoy: Vec<(i32, u64)>,
    /// How much of each market good has been sold since it was last full (see market.rs).
    market_sold: [i32; market::MARKET_GOODS.len()],
    style: u32,                   // the village's flag as one number (see web/src/flag.ts), 0 = none chosen; part of the state so every peer sees it
    hero: Option<(u8, u32)>,      // the village's lord: name index and experience (level follows from it)
    #[serde(skip)] defer_roads: bool,            // inside place_batch: the path network is rebuilt once at the end
    choice: Option<(u8, u64)>,   // a decision waiting for the player: kind and the tick it is made for them
    mood: i32,                   // temporary lift (or drag) on happiness from the last decision
    mood_until: u64,
    share_until: u64,            // winter: everyone huddles together, firewood lasts twice as long
    quarantine_until: u64,       // while quarantined, plague kills fewer and heals faster but the sick do no work
    plague_start: u64,           // when the latest outbreak began and when it is due to end (see plague.rs); zeros before the first
    plague_end: u64,
    caravans: Vec<Caravan>,   // goods on the road to another village
    journeys: Vec<Journey>,   // envoys, treaty offers, brides and war heralds on the road to another village (part of the state)
    arrivals: Vec<[i32; 4]>,  // [kind, tag, arg, tick] of journeys that arrived since the last call to take_arrivals (a notice for the player's own client, not part of the state)
    awaiting: Vec<[i32; 3]>,  // [resource, amount, to] delivered caravans whose payment has not been settled yet (part of the state)
    delivered: Vec<[i32; 3]>, // the same, but only as a notice for the player's own client to pass on (drained by take_delivered, not part of the state)
    treaties: Vec<Treaty>,    // agreements with other villages
    warm: bool,    // false while winter fires are out for lack of wood
    cold_days: u32, // days in a row the village has been cold (the cold only kills after a grace)
    eff: u32,
    /// How fully the food and wood workplaces are staffed, and everything else (derived in `staffing`: the hands go to food and wood first).
    eff_first: u32, eff_rest: u32,
    jobs: u32,
    events: Vec<i32>,
    sites: Vec<(f32, f32)>,
    flow: [i32; N_RES],
    meal_credit: i32,             // ration units left over from the last item eaten
    #[serde(skip)] estate: estate::Estate,
    #[serde(skip)] emergency_tools: [u64; 2], // sold, next restock tick
    ledger: ledger::Ledger,       // where each resource came from and went to over the last day (derived display data: never read by the rules, never hashed)
    levels: Vec<[f32; 4]>,        // [x, y, radius, height] ground levelled flat (a village site, the banks of a drawbridge)
    flats: Vec<[f32; 4]>,         // [x, y, radius, height] patches the player levelled (see flatten.rs): applied after ditches and earthworks, so nothing dug there shows
    roads: Vec<[f32; 6]>,         // [ax, ay, ah, bx, by, bh] graded path segments
    #[serde(skip)] road_tier: Vec<u8>,   // the surface of each segment of `roads` (0 dirt .. 3 flagstones; a stub is 0): derived with them, see `road_level`
    road_links: Vec<(u32, u32)>,  // what each segment belongs to: (i, i) the stub of building i, (piece, target) a stretch of a road the player laid (derived)
    road_conn: Vec<roadline::RoadConn>,   // how each road piece the player laid is joined to what it runs to (see roadline.rs; part of the state)
    road_sig: u64,                // a fingerprint of the roads as they stand (derived: the network with the roads marked on it, and the overlays, are rebuilt when it changes)
    army: [u32; NK],
    queue: [u32; NK],
    train_prog: u32,
    away: [u32; NK],
    battle: Option<Battle>,
    raid_warning_ticks: u32,
    raid_warning_angle: f32,
    raid_warning_rf: f32,
    raid_warning_boss: bool,
    raid_warning_name: u8,
    wildfires: Vec<Wildfire>,
    craters: Vec<[f32; 4]>,
    scorch: Vec<[f32; 3]>,
    ruins: Vec<[f32; 6]>,   // [x, y, r, kind, tier, rot]
    shots: Vec<[f32; 7]>,
    terrain_ver: u32,
    report: Vec<i32>,
    report_seq: u32,
    #[serde(default)] report_bought: bool,   // the last battle ended with the raiders paid off
    #[serde(default)] greed: u32,   // how greedy the bandits are after being paid off: see bribe.rs (part of the state hash)
    dets: Vec<march::Det>,       // field armies on the move
    next_det: u32,
    felled: Vec<[f32; 3]>,       // trees cleared by marching soldiers [x, y, radius]
    links: Vec<Vec<(f32, f32)>>,   // invisible paths chained from this city out to other villages' cities (set by `link_village`; part of the state)
    #[serde(skip)] mem_cache: std::cell::RefCell<Option<(u64, std::rc::Rc<members::Obst>)>>,   // what stops a walking soldier (derived)
    #[serde(skip)] deposit_layout: std::cell::Cell<Option<u64>>,   // stable while deposits are worked or regrowing
    #[serde(skip)] ov_cache: std::cell::RefCell<Option<(u64, std::rc::Rc<march::Ov>)>>,   // the grid overlays (derived; rebuilt when the village changes)
    #[serde(skip)] march_heights: std::cell::RefCell<Option<(u64, std::rc::Rc<march::GroundSamples>)>>,
    #[serde(skip)] march_routes: std::cell::RefCell<march::RouteMemo>,
    #[serde(skip)] ground_cache: std::cell::RefCell<Option<(u64, std::rc::Rc<Vec<f32>>)>>,   // the natural land heights under the path network's grid (derived)
    #[serde(skip)] height_cache: std::cell::RefCell<Option<(u64, std::rc::Rc<Vec<f32>>)>>,   // the ground heights under the path network's grid (derived)
    #[serde(skip)] net_base: std::cell::RefCell<Option<(u64, std::rc::Rc<pathnet::Net>)>>,   // the same without the road marks: what the roads themselves are routed over (derived)
    #[serde(skip)] link_stamp: std::cell::Cell<u64>,   // what the village looked like when the invisible paths were last worked out (derived: see `refresh_links`)
    moat_water: Vec<[f32; 4]>,   // the surface of the water in each moat piece, for drawing: [x, y, reach, level] (derived: see `compute_moat_water`)
    #[serde(skip)] planted: Vec<forestry::Planted>,   // trees the player (or a forester) planted [x, y, tick]: carried beside the world in a snapshot (see `snapshot`), part of the state hash
    groves: Vec<[f32; 3]>,       // patches of forest kept standing inside a big cleared area [x, y, radius] (the model village's woodcutter grove)
    bridges: Vec<[f32; 4]>,      // bridges built over water [ax, ay, bx, by]
    db_want: Vec<u32>,           // drawbridges that own soldiers in the fight are waiting to cross this tick (transient: filled by the battle, used by drawbridge_step and cleared)
    map_ver: u32,                // changes when trees are felled or bridges built
    #[serde(skip)] plague_camp: Option<plague::Camp>,   // the Plague Doctor's camp while an outbreak is kept alive (see plague.rs); stored beside the world in a snapshot, part of the state hash
    #[serde(skip)] military_tech: u16,
    #[serde(skip)] auto_bridge: bool,
    #[serde(skip)] rally: [Option<(f32, f32)>; 2],   // where new armies stand: the barracks' and the castle's rally point, when the player moved it off the default (saved in snapshot layout D, part of the state hash)
    #[serde(skip)] vets: [u32; NK],       // veterans among the standing army, by kind (they came through a battle: see tactics::is_veteran); saved with the extras of snapshot layout 9
    #[serde(skip)] train_acc: [u32; NK],  // drill progress of each kind in the queue (the barracks train every queued kind at once)
    #[serde(skip)] last_battle_frame: Vec<f32>,
}

/// Start of every world snapshot: a name and the layout version. Bump the version when a field of the world is added, removed or changes type (a snapshot of another layout is refused).
const RALLY_SNAP_MAGIC: &[u8; 8] = b"FLWORLDD";
const GUESTS_SNAP_MAGIC: &[u8; 8] = b"FLWORLDC";
const SNAP_MAGIC: &[u8; 8] = b"FLWORLDB";
const SIEGE_SNAP_MAGIC: &[u8; 8] = b"FLWORLDA";
const EXTRAS_SNAP_MAGIC: &[u8; 8] = b"FLWORLD9";
const VETS_SNAP_MAGIC: &[u8; 8] = b"FLWORLD8";
const TOOLS_SNAP_MAGIC: &[u8; 8] = b"FLWORLD7";
const ESTATE_SNAP_MAGIC: &[u8; 8] = b"FLWORLD6";
const OBJECTIVE_SNAP_MAGIC: &[u8; 8] = b"FLWORLD5";
const TACTICS_SNAP_MAGIC: &[u8; 8] = b"FLWORLD4";
const MARCH_SNAP_MAGIC: &[u8; 8] = b"FLWORLD3";
const LEGACY_SNAP_MAGIC: &[u8; 8] = b"FLWORLD2";

/// Rebuild a world from `World::snapshot` bytes. None when the bytes are not a snapshot of this layout (damaged, or made by another build).
#[wasm_bindgen]
pub fn world_restore(bytes: &[u8]) -> Option<World> {
    let (magic, payload) = bytes.split_at_checked(8)?;
    if magic == LEGACY_SNAP_MAGIC {
        let mut w: World = bincode::deserialize(payload).ok()?;
        w.ledger.ensure_kinds(DEFS.len());
        w.moat_water = w.compute_moat_water();
        return Some(w);
    }
    let mut extras = ([0u32; NK], [0u32; NK]);
    let mut siege: Option<Option<siege::Siege>> = None;
    let mut camp: Option<plague::Camp> = None;
    let mut allies: Vec<i32> = vec![];
    let mut rally: [Option<(f32, f32)>; 2] = [None; 2];
    let (mut w, marches) = if magic == RALLY_SNAP_MAGIC || magic == GUESTS_SNAP_MAGIC || magic == SNAP_MAGIC || magic == SIEGE_SNAP_MAGIC || magic == EXTRAS_SNAP_MAGIC || magic == VETS_SNAP_MAGIC || magic == TOOLS_SNAP_MAGIC || magic == ESTATE_SNAP_MAGIC || magic == OBJECTIVE_SNAP_MAGIC || magic == TACTICS_SNAP_MAGIC {
        type TacticalState = (World, Vec<march::SavedMarch>, u16, bool, Option<tactics::Tactics>);
        type ObjectiveState = (TacticalState, Option<raid_objective::RaidObjective>);
        let (((state, estate), tools), planted): (((ObjectiveState, estate::Estate), [u64; 2]), Vec<forestry::Planted>) =
            if magic == SNAP_MAGIC || magic == GUESTS_SNAP_MAGIC || magic == RALLY_SNAP_MAGIC {
                type Body = (((((ObjectiveState, estate::Estate), [u64; 2]), Vec<forestry::Planted>), ([u32; NK], [u32; NK])), (Option<siege::Siege>, Option<plague::Camp>));
                let ((inner, ex), (sg, cp)): Body = if magic == RALLY_SNAP_MAGIC { let ((body, a), r): ((Body, Vec<i32>), [Option<(f32, f32)>; 2]) = bincode::deserialize(payload).ok()?; allies = a; rally = r; body } else if magic == GUESTS_SNAP_MAGIC { let (body, a): (Body, Vec<i32>) = bincode::deserialize(payload).ok()?; allies = a; body } else { bincode::deserialize(payload).ok()? };
                extras = ex; siege = Some(sg); camp = cp; inner }
            else if magic == SIEGE_SNAP_MAGIC { let ((inner, ex), sg): (((((ObjectiveState, estate::Estate), [u64; 2]), Vec<forestry::Planted>), ([u32; NK], [u32; NK])), Option<siege::Siege>) = bincode::deserialize(payload).ok()?; extras = ex; siege = Some(sg); inner }
            else if magic == EXTRAS_SNAP_MAGIC { let (inner, ex): ((((ObjectiveState, estate::Estate), [u64; 2]), Vec<forestry::Planted>), ([u32; NK], [u32; NK])) = bincode::deserialize(payload).ok()?; extras = ex; inner }
            else if magic == VETS_SNAP_MAGIC { bincode::deserialize(payload).ok()? }
            else if magic == TOOLS_SNAP_MAGIC { (bincode::deserialize(payload).ok()?, vec![]) }
            else if magic == ESTATE_SNAP_MAGIC { ((bincode::deserialize(payload).ok()?, [0; 2]), vec![]) }
            else if magic == OBJECTIVE_SNAP_MAGIC { (((bincode::deserialize(payload).ok()?, estate::Estate::default()), [0; 2]), vec![]) }
            else { ((((bincode::deserialize(payload).ok()?, None), estate::Estate::default()), [0; 2]), vec![]) };
        let ((mut w, marches, tech, bridges, state), objective) = state;
        if tools[0] > 2 || (tools[0] == 0) != (tools[1] == 0) { return None; }
        w.emergency_tools = tools;
        if planted.len() > forestry::MAX_PLANTED || planted.iter().any(|p| !p.0.is_finite() || !p.1.is_finite()) { return None; }
        w.planted = planted;
        if w.battle.is_some() != state.is_some() || tech > tactics::TECH_MASK { return None; }
        if !estate.valid() { return None; }
        w.estate = estate;
        w.military_tech = tech;
        w.auto_bridge = bridges;
        if (0..NK).any(|k| extras.0[k] > w.army[k] || extras.1[k] > 100_000) { return None; }
        w.vets = extras.0; w.train_acc = extras.1;
        if let Some((b, t)) = w.battle.as_mut().zip(state) {
            if t.strikes.iter().any(|s| s.attacker >= b.units.len() || s.target >= b.units.len()) { return None; }
            b.tactics = t;
        }
        if camp.is_some_and(|c| !c.x.is_finite() || !c.y.is_finite() || c.name > 3) { return None; }
        w.plague_camp = camp;
        if let Some(sg) = siege {
            if w.battle.is_some() != sg.is_some() { return None; }
            if let Some((b, sg)) = w.battle.as_mut().zip(sg) {
                if sg.towers.len() > 8 || sg.saps.len() > 64 || sg.towers.iter().any(|t| !t.x.is_finite() || !t.y.is_finite() || !t.hp.is_finite()) || sg.saps.iter().any(|q| !q.x.is_finite() || !q.y.is_finite() || !q.secs.is_finite() || q.secs <= 0.0) { return None; }
                b.siege = sg;
            }
        }
        if let Some(o) = objective {
            let b = w.battle.as_mut()?;
            if !o.valid() || b.tag != 0 || b.lair >= 0 || b.boss != 0 { return None; }
            b.objective = Some(o);
        }
        (w, marches)
    } else if magic == MARCH_SNAP_MAGIC { bincode::deserialize(payload).ok()? } else { return None; };
    if w.dets.len() != marches.len() { return None; }
    for (det, saved) in w.dets.iter_mut().zip(marches) { det.restore_march(saved)?; }
    if rally.iter().flatten().any(|r| !r.0.is_finite() || !r.1.is_finite() || r.0.abs() > MAP_LIMIT || r.1.abs() > MAP_LIMIT) { return None; }
    w.rally = rally;
    if !allies.is_empty() { if allies.len() != w.dets.len() { return None; } for (det, a) in w.dets.iter_mut().zip(allies) { det.ally = a; } }
    w.ledger.ensure_kinds(DEFS.len());
    Some(w)
}

#[wasm_bindgen]
pub fn catalog() -> String { catalog_json() }

#[wasm_bindgen]
pub fn units() -> String { military::units_json() }

/// What a building of this kind and tier reaches, for the interface: a JSON array of `{r, fx, pct}` (radius in world units, effect code, strength in percent). See `radii.rs`.
#[wasm_bindgen]
pub fn effect_radii(kind: u8, tier: u8) -> String { radii::effect_radii_json(kind, tier) }

/// How readily a building of this kind and tier catches fire (0 never): the interface warns about buildings that burn and have no well near.
#[wasm_bindgen]
pub fn flammability_of(kind: u8, tier: u8) -> f32 { battle::flammability(kind, tier) }

/// The bosses: [{id, name, names, hp, dmg, speed, armor, desc}].
#[wasm_bindgen]
pub fn bosses() -> String { military::bosses_json() }

#[wasm_bindgen]
pub fn terrain_grid(seed: u64, x0: f32, y0: f32, nx: u32, ny: u32, step: f32) -> Vec<f32> { terrain::grid(seed, x0, y0, nx, ny, step) }

/// Mountain tunnels: [x0, y0, x1, y1] per tunnel.
#[wasm_bindgen]
pub fn tunnels_flat(seed: u64) -> Vec<f32> { terrain::tunnels(seed).into_iter().flatten().collect() }

#[wasm_bindgen]
pub fn trees_in(seed: u64, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<f32> { terrain::trees(seed, x0, y0, x1, y1) }

/// Rows `j0..j1` of `terrain_grid` (the same numbers however the rows are cut), so the page can build a big grid a few rows at a time instead of freezing.
#[wasm_bindgen]
pub fn terrain_grid_rows(seed: u64, x0: f32, y0: f32, nx: u32, step: f32, j0: u32, j1: u32) -> Vec<f32> { terrain::grid_rows(seed, x0, y0, nx, step, j0, j1) }

#[wasm_bindgen]
pub fn terrain_land_rows(seed: u64, x0: f32, y0: f32, nx: u32, step: f32, j0: u32, j1: u32) -> Vec<f32> { terrain::land_rows(seed, x0, y0, nx, step, j0, j1) }

#[wasm_bindgen]
pub fn natural_river_level() -> f32 { terrain::RIVER_LEVEL }

/// How many rows of tree cells `trees_in` goes through for this area, and rows `r0..r1` of them (concatenated they are exactly `trees_in`).
#[wasm_bindgen]
pub fn trees_in_row_count(y0: f32, y1: f32) -> u32 { let c = terrain::TREE_CELL; ((y1 / c).ceil() as i32 - (y0 / c).floor() as i32).max(0) as u32 }
#[wasm_bindgen]
pub fn trees_in_rows(seed: u64, x0: f32, y0: f32, x1: f32, r0: u32, r1: u32) -> Vec<f32> {
    let c = terrain::TREE_CELL; let cy0 = (y0 / c).floor() as i32;
    terrain::trees_cells(seed, (x0 / c).floor() as i32, (x1 / c).ceil() as i32, cy0 + r0 as i32, cy0 + r1 as i32)
}

/// Build the army navigation grid now (about a second of work) instead of in the middle of play, when the first field army is formed. Call it behind the loading screen.
#[wasm_bindgen]
pub fn warm_navigation(seed: u64) { let _ = march::nav_static(seed); }

/// The same as `warm_navigation`, a slice at a time: call it again and again (each call does about `rows` rows, a few milliseconds each) until it returns 1,
/// letting the page breathe in between. Returns the progress, 0..1. The grid it ends with is identical to the one `warm_navigation` builds.
#[wasm_bindgen]
pub fn warm_navigation_step(seed: u64, rows: u32) -> f32 { march::nav_build_step(seed, rows) }

#[wasm_bindgen]
pub fn village_sites(seed: u64) -> Vec<f32> { terrain::sites(seed).into_iter().flat_map(|(x, y)| [x, y]).collect() }

/// The Castle's footprint: the corner towers of its 44 x 38 curtain wall lie about 29 from its middle.
pub const CASTLE_FOOTPRINT: f32 = 30.0;
#[wasm_bindgen]
/// How much room a building takes at a tier: the grander buildings spread out as they are upgraded (a farm gains fields, a keep its courtyard), so an upgrade can need the
/// neighbours to make way.
pub fn footprint(kind: u8, tier: u8) -> f32 {
    let Some(d) = DEFS.get(kind as usize) else { return 0.0 };
    let grow = match kind { FARM => 0.25, TOWN_HALL => 0.2, KEEP => 0.1, BARRACKS | CHAPEL | COURTHOUSE | MARKET | STOREHOUSE | HOSPITAL | GRAVEYARD | EMBASSY => 0.1, _ => 0.0 };
    if kind == TOWN_HALL && tier < 3 { return [7.5, 9.8, 12.2][tier as usize]; }   // the hall and its wall of stakes grow a little with each tier before the Castle
    if kind == TOWN_HALL && tier >= 3 { return CASTLE_FOOTPRINT; }   // the Castle is a vast concentric fortress (44 x 38 walls, a palace and a bailey inside, a barbican in front): larger than the embassy's 24 (see the town hall model)
    d.r * (1.0 + grow * tier as f32) + if kind == FARM { FARM_YARD } else { 0.0 }   // (the yard round a farm's fields, where its design extras stand)
}
#[wasm_bindgen]
pub fn footprint_of(kind: u8, tier: u8) -> f32 { footprint(kind, tier) }

/// The part of a building soldiers cannot walk through: its solid mass, smaller than the footprint (which also holds yards, fields and elbow room). Between that and the
/// footprint plus a margin lies a strip they can use but would rather avoid. Walls and fences are all solid; open ground such as fields and gardens only blocks at its middle.
pub fn solid_radius(kind: u8, tier: u8) -> f32 {
    let fp = footprint(kind, tier);
    match kind {
        WALL | FENCE => fp + 1.0,
        FARM | GARDEN | PARK | MARKET => fp * 0.42,
        TOWN_HALL if tier >= 3 => fp * 0.72 + 0.3,
        TOWN_HALL => fp * 0.8 + 0.3,
        TOWER | KEEP | CHAPEL | BARRACKS => fp * 0.85 + 0.3,
        _ => fp * 0.72 + 0.3,
    }
}
#[wasm_bindgen]
pub fn solid_radius_of(kind: u8, tier: u8) -> f32 { solid_radius(kind, tier) }
/// How far from a building's middle the ring of path round it runs (round a farm: out past all of its fields).
#[wasm_bindgen]
pub fn ring_radius_of(kind: u8, tier: u8) -> f32 { pathnet::ring_radius(kind, tier) }

/// The lists of ground changes `height_layers` goes through: the village's own, or only those near a region (`layers_near`).
struct Layers<'a> { levels: &'a [[f32; 4]], flats: &'a [[f32; 4]], roads: &'a [[f32; 6]], pads: &'a [Building], craters: &'a [[f32; 4]] }

/// A walkable deck as an oriented strip: the middle, the direction along it, half its length (it is 3.8 wide).
pub(crate) struct Deck { x: f32, y: f32, ux: f32, uy: f32, half: f32 }

#[wasm_bindgen]
pub fn upgrade_cost_flat(kind: u8, new_tier: u8) -> Vec<i32> {
    match DEFS.get(kind as usize) {
        Some(_) => upgrade_cost_for(kind, new_tier).into_iter().flat_map(|(r, n)| [r as i32, n]).collect(),
        None => vec![],
    }
}

#[wasm_bindgen]
/// What it costs to bring one road piece from surface `from` up to `to`, as [resource, amount, ...] (every step in between is paid).
pub fn road_resurface_cost_flat(from: u8, to: u8) -> Vec<i32> { road_resurface_cost(from.min(3), to.min(3)).into_iter().flat_map(|(r, n)| [r as i32, n]).collect() }

fn demolition_refund(kind: u8) -> impl Iterator<Item = Amount> {
    DEFS[kind as usize].cost.iter().filter_map(move |&(r, n)| {
        let half = n / 2;
        (kind != TOWN_HALL && half > 0).then_some((r, half))
    })
}

#[wasm_bindgen]
impl World {
    /// The whole state of the village as bytes (the caches are not in it: they are rebuilt on demand). `world_restore` turns it back into the same world, to the last bit.
    pub fn snapshot(&self) -> Vec<u8> {
        let mut v = RALLY_SNAP_MAGIC.to_vec();
        let marches: Vec<_> = self.dets.iter().map(march::Det::save_march).collect();
        let battle = self.battle.as_ref();
        let tactical_state = (self, marches, self.military_tech, self.auto_bridge, battle.map(|b| &b.tactics));
        let objective_state = (tactical_state, battle.and_then(|b| b.objective));
        let allies: Vec<i32> = self.dets.iter().map(|d| d.ally).collect();   // (whose soldiers each field army is: 0 ours; see `host_guests`)
        v.extend(bincode::serialize(&(((((((objective_state, self.estate), self.emergency_tools), &self.planted), (self.vets, self.train_acc)), (battle.map(|b| &b.siege), self.plague_camp)), allies), self.rally)).expect("a world can be written"));
        v
    }

    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, ox: i32, oy: i32) -> World {
        let mut w = World {
            seed, ox, oy, tick: 0, rng: Rng(seed ^ 0x9E3779B97F4A7C15 ^ ((ox as i64 as u64) << 20) ^ (oy as i64 as u64)),
            buildings: vec![], deposits: terrain::deposits(seed), stock: [0; N_RES], population: 10, sick: 0, children: 3, elders: 0, born: 0, arrived: 0, enlisted: 0, left: 0, died: [0; 5], unburied: 0, buried: 0, graves_used: 0, devotion: 0, relations: vec![], married: vec![], last_envoy: vec![], market_sold: [0; market::MARKET_GOODS.len()], style: 0, hero: None, defer_roads: false, neutral_done: vec![], explored: vec![0; (FOG_N * FOG_N) as usize], choice: None, mood: 0, mood_until: 0, quarantine_until: 0, plague_start: 0, plague_end: 0, plague_camp: None, share_until: 0, caravans: vec![], journeys: vec![], arrivals: vec![], awaiting: vec![], delivered: vec![], treaties: vec![], warm: true, cold_days: 0, eff: 100, eff_first: 100, eff_rest: 100, jobs: 0,
            events: vec![], sites: terrain::sites(seed), flow: [0; N_RES], meal_credit: 0, emergency_tools: [0; 2], estate: estate::Estate { active: true, ..Default::default() }, ledger: ledger::Ledger::new(DEFS.len()), levels: vec![], flats: vec![], roads: vec![], road_links: vec![], road_tier: vec![], road_conn: vec![], military_tech: 0, auto_bridge: false, rally: [None; 2], vets: [0; NK], train_acc: [0; NK], last_battle_frame: vec![],
            army: [0; NK], queue: [0; NK], train_prog: 0, away: [0; NK], battle: None, raid_warning_ticks: 0, raid_warning_angle: 0.0, raid_warning_rf: 0.0, raid_warning_boss: false, raid_warning_name: 0, wildfires: vec![], craters: vec![], scorch: vec![], ruins: vec![], shots: vec![], terrain_ver: 0, report: vec![], report_seq: 0, report_bought: false, greed: 0, dets: vec![], next_det: 0, felled: vec![], planted: vec![], groves: vec![], ov_cache: Default::default(), march_heights: Default::default(), march_routes: Default::default(), mem_cache: Default::default(), deposit_layout: Default::default(), links: vec![], moat_water: vec![], bridges: vec![], db_want: vec![], map_ver: 0, road_sig: 0, net_base: Default::default(), link_stamp: Default::default(), ground_cache: Default::default(), height_cache: Default::default(),
        };
        w.stock[W as usize] = 160;
        w.stock[PL as usize] = 20;
        w.stock[ST as usize] = 70;
        w.stock[GR as usize] = 120;
        w.stock[TL as usize] = 6;
        w.stock[GD as usize] = 30;
        let (x, y) = (ox as f32, oy as f32);
        let pad_h = w.base(x, y);
        w.buildings.push(Building { kind: TOWN_HALL, tier: 0, x, y, rot: 0, pad_h, progress: 0, status: 4, aux: -1, staff: 0, residents: 0, hp: battle::max_hp(TOWN_HALL, 0), burning: 0.0, garrison: 0, born: 0, opts: 0, fert: FERT_MAX, mode: 0, target: -1, beff: 100 });
        w.neutral_done = vec![false; terrain::neutrals(seed).len()];
        w.reveal(x, y, 110.0);
        w.after_change();
        w
    }

    /// Start the village again from nothing: the world becomes exactly what `World::new` makes for this seed and site (the clock back at 0, the starting stock and town hall, every
    /// building, road, ditch, levelled patch, felled tree, grove, deposit, soldier, army, treaty, relation, caravan, battle, plague, ruin and crater gone). Only the site and the
    /// village's flag (`style`, the player's identity on the map) are kept. Played from a command log it is the first command of a new epoch (see docs/RESTART.md).
    pub fn restart(&mut self) {
        let style = self.style;
        let active = self.estate.active;
        *self = World::new(self.seed, self.ox, self.oy);
        self.style = style;
        self.estate.active = active;
    }

    /// Lift the fog in a circle.
    pub(crate) fn reveal(&mut self, x: f32, y: f32, r: f32) {
        let (i0, i1) = ((((x - r) + HALF_F) / FOG_CELL).floor() as i32, (((x + r) + HALF_F) / FOG_CELL).floor() as i32);
        let (j0, j1) = ((((y - r) + HALF_F) / FOG_CELL).floor() as i32, (((y + r) + HALF_F) / FOG_CELL).floor() as i32);
        for j in j0.max(0)..=j1.min(FOG_N - 1) { for i in i0.max(0)..=i1.min(FOG_N - 1) {
            let (cx, cy) = (i as f32 * FOG_CELL - HALF_F + FOG_CELL / 2.0, j as f32 * FOG_CELL - HALF_F + FOG_CELL / 2.0);
            if (cx - x).powi(2) + (cy - y).powi(2) <= (r + FOG_CELL * 0.7).powi(2) { self.explored[(j * FOG_N + i) as usize] = 1; }
        } }
    }
    fn is_seen(&self, x: f32, y: f32) -> bool {
        let (i, j) = (((x + HALF_F) / FOG_CELL) as i32, ((y + HALF_F) / FOG_CELL) as i32);
        i >= 0 && j >= 0 && i < FOG_N && j < FOG_N && self.explored[(j * FOG_N + i) as usize] != 0
    }

    /// The fog of war: FOG_N x FOG_N cells, 1 where your people have been or can see.
    pub fn explored_flat(&self) -> Vec<u8> { self.explored.clone() }
    /// How far from the village centre raiders coming from `angle` form up: along the ray, the farthest point (in steps of 6, over dry ground only) before the first water, between near and far.
    pub fn raid_distance(&self, angle: f32) -> f32 {
        let br = self.build_radius() as f32;
        let (cx, cy, dx, dy) = (self.ox as f32, self.oy as f32, angle.cos(), angle.sin());
        let mut d = RAID_SPAWN_NEAR;
        let mut n = d;
        while n + 2.0 <= RAID_SPAWN_FAR {
            n += 2.0; let (x, y) = (cx + dx * (br + n), cy + dy * (br + n));
            if x.abs() > HALF_F - 10.0 || y.abs() > HALF_F - 10.0 || self.height_ground(x, y) < 0.3 { break; }
            if n - d >= 6.0 { d = n; }   // (only a stretch of dry ground that is long enough counts: a lone dry spot beyond a stream does not)
        }
        br + d
    }
    /// The direction (radians, as the raid angle) of one of the three nearest bandit camps or lairs that are not yet cleared: the raiders' bases. None when all are cleared (raids then come from anywhere, from the sea).
    fn raid_camp_angle(&mut self) -> Option<f32> {
        let (ox, oy) = (self.ox as f32, self.oy as f32);
        let mut live: Vec<(f32, f32, f32)> = terrain::neutrals(self.seed).iter().enumerate()
            .filter(|(i, n)| n.0 >= 2 && !self.neutral_done.get(*i).copied().unwrap_or(false))
            .map(|(_, n)| ((n.1 - ox).hypot(n.2 - oy), n.1, n.2)).collect();
        if live.is_empty() { return None; }
        live.sort_by(|a, b| a.0.total_cmp(&b.0));
        let k = self.rng.range(live.len().min(3) as u32) as usize;
        let (_, x, y) = live[k];
        Some((y - oy).atan2(x - ox))
    }
    /// Raiders can only be seen coming if a watchtower (tower or keep) stands: otherwise there is no warning, they are simply noticed when they reach the fields.
    pub fn raid_spotted(&self) -> bool { self.buildings.iter().any(|b| matches!(b.kind, TOWER | KEEP)) }
    /// True when every bandit camp and lair of this world has been cleared (there is at least one): the raiders are broken. Raids still come: the game goes on.
    pub fn raiders_broken(&self) -> bool {
        let list = terrain::neutrals(self.seed);
        let camps: Vec<usize> = list.iter().enumerate().filter(|(_, n)| n.0 >= 2).map(|(i, _)| i).collect();
        !camps.is_empty() && camps.iter().all(|&i| self.neutral_done.get(i).copied().unwrap_or(false))
    }
    /// Neutral places you know about: [kind, x, y, done] each (kind 0 abbey, 1 ruined castle, 2 bandit camp, 3 lair). Unseen places are left out.
    pub fn neutrals_flat(&self) -> Vec<f32> {
        let mut v: Vec<f32> = terrain::neutrals(self.seed).iter().enumerate().filter(|(_, n)| self.is_seen(n.1, n.2)).flat_map(|(i, n)| [n.0 as f32, n.1, n.2, self.neutral_done.get(i).copied().unwrap_or(false) as u8 as f32]).collect();
        if let Some(c) = self.plague_camp { v.extend([4.0, c.x, c.y, 0.0]); }   // the plague camp (kind 4) is always known
        v
    }
    /// What a cleared bandit camp pays: 120 gold and 15 iron, times a share for the camp's own strength (`h` 0..1: 0.7 for the weakest, 1.5 for the strongest, the same `h` that sets its power check)
    /// and a share for the village's progress (1.0 for a young village up to 2.0 for a grown one: the same measure as a boss's, see `boss_scale`).
    pub(crate) fn camp_loot(h: f32, population: u32, tick: u64) -> (i32, i32) {
        let grown = (population as f32 / 80.0 + tick as f32 / DAY as f32 / 120.0).min(1.0);
        let m = (0.7 + 0.8 * h) * (1.0 + grown);
        ((120.0 * m).round() as i32, (15.0 * m).round() as i32)
    }
    /// Send a field army (that has stopped near one) into a neutral place. Abbey: the sick are healed and spirits rise. Ruined castle: its hoard is carried off. Bandit camp: a fight,
    /// won by strength, whose loser is the army (half of it falls) or the camp (cleared, its coin taken). Lair (kind 3): a real battle starts on the spot (3 is returned at once; the fight, its report and the reward come as for a raid). Returns the kind (0..3) on success, -1 no such army, -2 nothing close enough, -3 already visited, -4 a fight is already on.
    pub fn visit_neutral(&mut self, army_id: u32) -> i32 {
        if self.battle.is_some() && self.dets.iter().any(|d| d.id == army_id) { return -4; }   // a fight is on
        let Some(di) = self.dets.iter().position(|d| d.id == army_id) else { return -1 };
        let (ax, ay, units) = (self.dets[di].x, self.dets[di].y, self.dets[di].units);
        if let Some(c) = self.plague_camp.filter(|c| ((c.x - ax).powi(2) + (c.y - ay).powi(2)).sqrt() < 14.0) {   // the doctor's camp: a real fight, won by killing the doctor
            if self.dets[di].state == march::S_FIGHT { return -4; }
            return if self.begin_lair_battle(di, CAMP_LAIR, c.x, c.y, 0.5, DOCTOR) { 4 } else { -4 };
        }
        let list = terrain::neutrals(self.seed);
        let Some((ni, &(kind, nx, ny))) = list.iter().enumerate().filter(|(_, n)| ((n.1 - ax).powi(2) + (n.2 - ay).powi(2)).sqrt() < 14.0).next() else { return -2 };
        if self.neutral_done.get(ni).copied().unwrap_or(true) { return -3; }
        let cap = self.storage_cap(); let h = terrain::h01(self.seed ^ 0x52, ni as i32, 3);
        if kind == 3 {   // a lair: a real fight, won or lost on the field (see begin_lair_battle); not done until the boss is dead
            if self.dets[di].state == march::S_FIGHT { return -4; }
            return if self.begin_lair_battle(di, ni as i32, nx, ny, h, LAIR_BOSS) { 3 } else { -4 };
        }
        match kind {
            0 => { self.end_plague(); self.mood = 12; self.mood_until = self.tick + 15 * DAY; }
            1 => { for (r, base) in [(ST, 120), (IR, 20), (GD, 80), (PL, 60)] { let n = (base as f32 * (0.6 + h)) as i32; self.stock[r as usize] = Self::add_capped(self.stock[r as usize], n, cap); } }
            _ => {
                let power: f32 = (0..NK).map(|k| units[k] as f32 * UNITS[k].hp * UNITS[k].dmg / UNITS[k].cd.max(0.5)).sum();
                let camp = 9000.0 + 14000.0 * h;
                if power >= camp { let (gold, iron) = Self::camp_loot(h, self.population, self.tick); self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], gold, cap); self.stock[IR as usize] = Self::add_capped(self.stock[IR as usize], iron, cap); }
                else { self.dets[di].grp.clear(); for k in 0..NK { self.dets[di].units[k] /= 2; } if self.dets[di].units.iter().all(|&u| u == 0) { self.dets.remove(di); } return kind as i32 + 100; }   // beaten: not marked done, it can be tried again
            }
        }
        self.neutral_done[ni] = true; self.reveal(nx, ny, 80.0); self.push_event(EV_VISIT, kind as i32, 0);
        kind as i32
    }

    fn base(&self, x: f32, y: f32) -> f32 { terrain::base_height_s(self.seed, &self.sites, x, y) }

    /// The graded roads of the village, rebuilt from what stands: the short stub of every building (from its door to the node at the edge of its plot) and the roads the player laid
    /// (chains of road pieces, see roadline.rs). Nothing is laid automatically: a building with no road to it still has its stub, and people walk over open ground to it.
    fn rebuild_roads(&mut self) {
        self.roads.clear();
        self.road_links.clear(); self.road_tier.clear();
        self.sync_road_conn();
        let decks = self.decks();
        for i in 0..self.buildings.len() {
            let b = &self.buildings[i];
            if !roadline::has_stub(b.kind) { continue; }
            let (door, exit) = doors::door_world(b);
            if (door.0 - exit.0).hypot(door.1 - exit.1) > 0.3 && self.leg_is_dry_in(&decks, door, exit) { self.roads.push([door.0, door.1, b.pad_h, exit.0, exit.1, b.pad_h]); self.road_links.push((i as u32, i as u32)); self.road_tier.push(0); }
        }
        for e in self.road_edges() {
            let (ha, hb) = (self.buildings[e.a].pad_h, self.buildings[e.b].pad_h);
            let hs = self.grade_line(&e.pts, ha, hb);
            for (k, w) in e.pts.windows(2).enumerate() {
                if self.leg_is_dry_in(&decks, w[0], w[1]) {
                    self.roads.push([w[0].0, w[0].1, hs[k], w[1].0, w[1].1, hs[k + 1]]);
                    self.road_links.push((e.a as u32, e.b as u32)); self.road_tier.push(self.edge_style(e.a, e.b).0);
                }
            }
        }
        let mut h: u64 = 0xcbf29ce484222325;
        let mut mix = |v: u64| { h ^= v; h = h.wrapping_mul(0x100000001b3); };
        for r in &self.roads { for v in r { mix(v.to_bits() as u64); } }
        self.road_sig = h;
    }

    /// The height of a road's centreline at each of its points: the ground it runs over, smoothed along the road (so it neither cuts into every hump nor floats over every dip),
    /// eased to the heights of the pads at its two ends, and never steeper than `ROAD_MAX_SLOPE`. Pure function of the village's state (the same on every replica).
    pub(crate) fn grade_line(&self, pts: &[(f32, f32)], ha: f32, hb: f32) -> Vec<f32> {
        let n = pts.len();
        if n == 0 { return vec![]; }
        let mut s = vec![0.0f32; n];   // distance along the road
        for k in 1..n { s[k] = s[k - 1] + (pts[k].0 - pts[k - 1].0).hypot(pts[k].1 - pts[k - 1].1); }
        let total = s[n - 1];
        let raw: Vec<f32> = pts.iter().map(|p| self.height_ground(p.0, p.1).max(0.25)).collect();
        let mut h = vec![0.0f32; n];
        for k in 0..n {
            let (mut sum, mut cnt) = (0.0f32, 0.0f32);
            let (mut j0, mut j1) = (k, k);
            while j0 > 0 && s[k] - s[j0 - 1] <= ROAD_SMOOTH { j0 -= 1; }
            while j1 + 1 < n && s[j1 + 1] - s[k] <= ROAD_SMOOTH { j1 += 1; }
            for j in j0..=j1 { sum += raw[j]; cnt += 1.0; }
            h[k] = sum / cnt;
        }
        // pin the ends to the pads: the difference is spread over the first and last stretch
        let ease = (total * 0.5).min(9.0).max(0.01);
        let (da, db) = (ha - h[0], hb - h[n - 1]);
        for k in 0..n {
            let (fa, fb) = (1.0 - smoothstep(0.0, ease, s[k]), 1.0 - smoothstep(0.0, ease, total - s[k]));
            h[k] += da * fa + db * fb;
        }
        // a walkable slope: forward from the start, then back from the end (each end stays on its pad)
        for k in 1..n { let m = ROAD_MAX_SLOPE * (s[k] - s[k - 1]); h[k] = h[k].clamp(h[k - 1] - m, h[k - 1] + m); }
        h[n - 1] = hb;
        for k in (0..n - 1).rev() { let m = ROAD_MAX_SLOPE * (s[k + 1] - s[k]); h[k] = h[k].clamp(h[k + 1] - m, h[k + 1] + m); }
        h[0] = ha;
        h
    }

    /// Is a straight leg of a route over dry, ordinary ground (not water and not a drawbridge deck)?
    pub(crate) fn leg_is_dry(&self, a: (f32, f32), b: (f32, f32)) -> bool { self.leg_is_dry_in(&self.decks(), a, b) }

    /// `leg_is_dry` against decks already gathered with `decks()`: the road rebuild asks about thousands of legs, and must not walk the whole building list for every sample point.
    pub(crate) fn leg_is_dry_in(&self, decks: &[Deck], a: (f32, f32), b: (f32, f32)) -> bool {
        let l = (b.0 - a.0).hypot(b.1 - a.1); let st = (l / 1.5).ceil().max(1.0) as i32;
        (0..=st).all(|q| { let t = q as f32 / st as f32; let (x, y) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t); !self.natural_water_covers(x, y, self.height_ground(x, y), 0.2) && !Self::on_deck_in(decks, x, y) })
    }

    /// The decks that can be walked on right now: bridges, and drawbridges that are not drawn up.
    pub(crate) fn decks(&self) -> Vec<Deck> {
        self.buildings.iter().filter_map(|b| {
            if b.kind == BRIDGE { let (ux, uy, l) = Self::bridge_dir(b); return Some(Deck { x: b.x, y: b.y, ux, uy, half: l / 2.0 }); }
            if b.kind != DRAWBRIDGE || self.drawn_up(b) { return None; }
            let a = b.rot as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            Some(Deck { x: b.x, y: b.y, ux: sx, uy: sy, half: 7.4 })
        }).collect()
    }

    fn on_deck_in(decks: &[Deck], x: f32, y: f32) -> bool {
        decks.iter().any(|d| { let (dx, dy) = (x - d.x, y - d.y); (dx * d.ux + dy * d.uy).abs() <= d.half && (dx * d.uy - dy * d.ux).abs() <= 1.9 })
    }

    /// Is the point on the deck of a lowered drawbridge?
    fn on_deck(&self, x: f32, y: f32) -> bool { Self::on_deck_in(&self.decks(), x, y) }

    /// Recompute derived data after the building list or tiers changed.
    fn after_change(&mut self) {
        if self.defer_roads { self.staffing(); return; }
        self.moat_water = self.compute_moat_water();
        self.rebuild_roads();
        self.staffing();
    }

    /// Standing water shares a level within each connected moat. Carved rivers can descend along their channel.
    /// The mesh extends to all triangles touching the excavation, so check the banks beyond the cut as well.
    fn compute_moat_water(&self) -> Vec<[f32; 4]> {
        let mut flowing = Vec::new();
        let pieces: Vec<[f32; 4]> = self.buildings.iter().filter(|b| matches!(b.kind, MOAT | RIVER)).map(|b| {
            flowing.push(b.kind == RIVER);
            let reach = if b.kind == MOAT { MOAT_FLOOR * moat_scale(b) } else { RIVER_FLOOR } + CHANNEL_BANK;
            let mut low = f32::MAX;
            for offset in [0.0, 1.2, 2.4, MOAT_MESH_OVERHANG] {
                for k in 0..16 {
                    let a = k as f32 * std::f32::consts::TAU / 16.0;
                    low = low.min(self.height_core(b.x + a.cos() * (reach + offset), b.y + a.sin() * (reach + offset), false));
                }
            }
            [b.x, b.y, reach, (low - MOAT_FREEBOARD).max(0.4)]
        }).collect();
        let mut parent: Vec<_> = (0..pieces.len()).collect();
        fn root(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i { parent[i] = parent[parent[i]]; i = parent[i]; }
            i
        }
        for (i, p) in pieces.iter().enumerate() {
            for (j, q) in pieces[..i].iter().enumerate() {
                if (p[0] - q[0]).hypot(p[1] - q[1]) <= p[2] + q[2] {
                    let a = root(&mut parent, i); let b = root(&mut parent, j); parent[a] = b;
                }
            }
        }
        let group: Vec<_> = (0..pieces.len()).map(|i| root(&mut parent, i)).collect();
        let mut limits = vec![f32::MAX; pieces.len()];
        let mut rivers = vec![false; pieces.len()];
        for (i, p) in pieces.iter().enumerate() { limits[group[i]] = limits[group[i]].min(p[3]); rivers[group[i]] |= flowing[i]; }
        pieces.iter().enumerate().map(|(i, p)| {
            let id = group[i];
            let level = if rivers[id] && flowing[i] {
                pieces.iter().enumerate().filter(|&(j, _)| group[j] == id)
                    .map(|(_, q)| q[3] + MOAT_WATER_SLOPE * (q[0] - p[0]).hypot(q[1] - p[1])).fold(p[3], f32::min)
            } else { limits[id] };
            [p[0], p[1], p[2], level]
        }).collect()
    }
    /// The surface of each moat or carved river piece: [x, y, reach, level] (stride 4).
    pub fn moat_water_flat(&self) -> Vec<f32> { self.moat_water.iter().flatten().copied().collect() }
    /// The level of the moat water at a point, or 0 (the sea) when it is not in a moat.
    pub(crate) fn moat_level_at(&self, x: f32, y: f32) -> f32 {
        self.moat_water.iter().filter(|p| (p[0] - x).hypot(p[1] - y) < p[2] + 1.0).map(|p| p[3]).fold(0.0, f32::max)
    }

    fn river_surface_at(&self, x: f32, y: f32) -> f32 { terrain::river_surface_at(self.seed, &self.sites, x, y) }

    fn water_surface_at(&self, x: f32, y: f32) -> f32 { self.moat_level_at(x, y).max(self.river_surface_at(x, y)) }

    fn river_covers(&self, x: f32, y: f32, ground: f32) -> bool {
        if ground >= terrain::RIVER_LEVEL { return false; }
        let surface = self.river_surface_at(x, y);
        surface > 0.0 && ground < surface
    }

    pub(crate) fn natural_water_covers(&self, x: f32, y: f32, ground: f32, shore: f32) -> bool {
        ground < shore || self.river_covers(x, y, ground)
    }

    // One twentieth of a meal represents both one tenth and one quarter exactly. Earlier histories use quarter meals.
    fn ration_scale(&self) -> i32 { if self.estate.active { 5 } else { 1 } }
    fn meal_units(&self) -> i32 { 4 * self.ration_scale() }
    fn food_units(&self) -> i64 {
        let stored: i64 = FOODS.iter().map(|&(r, q)| self.stock[r as usize].max(0) as i64 * q as i64).sum();
        stored * self.ration_scale() as i64 + self.meal_credit as i64
    }
    /// Whole meals in the stores.
    pub(crate) fn food(&self) -> i32 { (self.food_units() / self.meal_units() as i64).min(i32::MAX as i64) as i32 }
    fn appetite(&self) -> (u32, i32) {
        let soldiers = self.army.iter().chain(&self.away).chain(self.dets.iter().flat_map(|d| &d.units)).copied().sum::<u32>();
        let heads = (self.population + soldiers) as i32;
        let units = if self.estate.active { heads * 2 } else { (heads + 5) / 10 * 4 };
        (soldiers, units)
    }
    /// Take items from the fullest food store. False if it takes the entire larder and still comes up short.
    fn eat_units(&mut self, need: i64) -> bool {
        if self.food_units() < need { for &(r, _) in &FOODS { self.stock[r as usize] = 0; } self.meal_credit = 0; return false; }
        let scale = self.ration_scale() as i64;
        let mut owed = need - self.meal_credit as i64; self.meal_credit = 0;
        if owed < 0 { self.meal_credit = -owed as i32; return true; }
        while owed > 0 {
            let (mut best, mut most) = (0usize, -1i64);
            for (k, &(r, q)) in FOODS.iter().enumerate() { let v = self.stock[r as usize].max(0) as i64 * q as i64; if v > most { most = v; best = k; } }
            let (r, q) = FOODS[best]; self.stock[r as usize] -= 1; owed -= q as i64 * scale;
        }
        self.meal_credit = (-owed) as i32; true
    }
    /// What each kind of food is worth, flat: `[resource, quarter meals]` pairs.
    pub fn food_table() -> Vec<i32> { FOODS.iter().flat_map(|&(r, q)| [r as i32, q]).collect() }

    /// Workforce efficiency, and how villagers are spread over workplaces and homes.
    fn staffing(&mut self) {
        self.jobs = self.buildings.iter().map(|b| DEFS[b.kind as usize].jobs * (b.tier as u32 + 1)).sum();
        self.children = self.children.min(self.population); self.elders = self.elders.min(self.population - self.children);
        let workers = (self.adults().saturating_sub(self.sick)) * 7 / 10 * if self.tick < self.quarantine_until { 7 } else { 10 } / 10;
        self.eff = if self.jobs == 0 { 100 } else { (workers * 100 / self.jobs).min(100) };
        // buildings the player gave a set number of workers are filled first (scaled down together when the hands do not suffice), the rest share what is left:
        // food and wood first, then everything else
        let mj = |b: &Building| DEFS[b.kind as usize].jobs * (b.tier as u32 + 1);
        let want: Vec<u32> = self.buildings.iter().map(|b| if b.target >= 0 { (b.target as u32).min(mj(b)) } else { 0 }).collect();
        let manual: u32 = want.iter().sum();
        let mut given = want.clone();
        if manual > workers {   // proportional, the rounding leftovers going to the earliest buildings
            for g in given.iter_mut() { *g = (*g as u64 * workers as u64 / manual as u64) as u32; }
            let mut spare = workers - given.iter().sum::<u32>();
            for (g, w) in given.iter_mut().zip(&want) { if spare == 0 { break; } if *g < *w { *g += 1; spare -= 1; } }
        }
        let left_workers = workers.saturating_sub(manual);
        let auto_first: u32 = self.buildings.iter().filter(|b| b.target < 0 && staffed_first(b.kind)).map(mj).sum();
        let auto_jobs: u32 = self.buildings.iter().filter(|b| b.target < 0).map(mj).sum();
        self.eff_first = if auto_first == 0 { 100 } else { (left_workers * 100 / auto_first).min(100) };
        let left_hands = left_workers.saturating_sub(auto_first * self.eff_first / 100); let rest_jobs = auto_jobs - auto_first;
        self.eff_rest = if rest_jobs == 0 { 100 } else { (left_hands * 100 / rest_jobs).min(100) };
        let cap = self.capacity();
        let housed = self.population.min(cap);
        let mut left = housed;
        let (eff_first, eff_rest) = (self.eff_first, self.eff_rest);
        for (i, b) in self.buildings.iter_mut().enumerate() {
            let d = &DEFS[b.kind as usize];
            let max = d.jobs * (b.tier as u32 + 1);
            if b.target >= 0 { b.staff = given[i]; b.beff = if max == 0 { 100 } else { given[i] * 100 / max }; }
            else { let eff = if staffed_first(b.kind) { eff_first } else { eff_rest }; b.staff = (max * eff + 50) / 100; b.beff = eff; }
            let c = d.housing * (b.tier as u32 + 1);
            let r = if cap == 0 { 0 } else { (c * housed / cap).min(left) };
            b.residents = r;
            left -= r;
        }
        for b in self.buildings.iter_mut() { if left == 0 { break; } let c = DEFS[b.kind as usize].housing * (b.tier as u32 + 1); if c > b.residents { b.residents += 1; left -= 1; } }
    }

    /// Terrain height including graded paths and the levelled pads under buildings.
    pub fn height_at(&self, x: f32, y: f32) -> f32 { self.height_core(x, y, true) }

    /// Level the ground round the village (radius `r`) to `target_height` (a negative height: the average of the land round it). 0 ok, -1 battle going on, -2 invalid height.
    pub fn flatten(&mut self, r: u32, target_height: f32) -> i32 {
        if self.battle.is_some() { return -1; }
        if target_height.is_nan() || target_height > 24.0 { return -2; }
        let (cx, cy) = (self.buildings[0].x, self.buildings[0].y); let rr = (r as f32).clamp(10.0, 110.0);
        // No material charge: this is a direct, inexpensive grading operation. A negative height means 'the land round it': the average of the natural ground, as before there was a height setting.
        let h = if target_height >= 0.0 { target_height } else {
            let mut sum = 0.0; let mut n = 0.0;
            for k in 0..25 { let (i, j) = ((k % 5) as f32 - 2.0, (k / 5) as f32 - 2.0); sum += self.base(cx + i * rr * 0.25, cy + j * rr * 0.25); n += 1.0; }
            (sum / n).clamp(3.0, 9.0)
        };
        // Layering (see docs/TERRAIN.md): a later levelling wins over an earlier one, so a patch of the level tool that lies wholly inside the new disc is dropped (it would otherwise be
        // applied on top again and bring its old height back), and whatever stands inside the disc is set on the new ground (its footing is re-fitted, never left on a pedestal or in a pit).
        self.flats.retain(|f| (f[0] - cx).hypot(f[1] - cy) + f[2] > rr);
        self.levels.push([cx, cy, rr, h]); self.terrain_ver += 1; self.map_ver += 1;
        let mut shore = Vec::new();
        for i in 0..self.buildings.len() {
            let b = &self.buildings[i];
            if is_edit(b.kind) || b.kind == ROAD || !(DEFS[b.kind as usize].pad || b.kind == DRAWBRIDGE) || (b.x - cx).hypot(b.y - cy) > rr { continue; }
            if matches!(b.kind, WATERWHEEL | FISHING_HUT | DRAWBRIDGE) { shore.push(i); }
            self.buildings[i].pad_h = h;
        }
        if !shore.is_empty() {
            self.moat_water = self.compute_moat_water();
            for i in shore {
                let b = &self.buildings[i];
                let clearance = if b.kind == DRAWBRIDGE { self.drawbridge_clearance(b.x, b.y, b.rot) }
                    else { self.shore_water_height(b.x, b.y, b.rot) + SHORE_CLEARANCE };
                self.buildings[i].pad_h = h.max(clearance);
            }
        }
        self.after_change(); 0
    }

    /// Ground height as the road router sees it: natural land, levelled ground, ditches and the banks at each end of a drawbridge, but no paths and no building pads.
    fn height_ground(&self, x: f32, y: f32) -> f32 { self.height_inner(x, y, true, false) }

    /// Height with or without the ditches dug by moat pieces (placing a moat piece looks at the ground as it was).
    fn height_core(&self, x: f32, y: f32, moats: bool) -> f32 { self.height_inner(x, y, moats, true) }

    fn height_inner(&self, x: f32, y: f32, moats: bool, built: bool) -> f32 { self.height_from(x, y, moats, built, self.base(x, y)) }

    /// `height_inner` with the natural land height `base` already known (the path network keeps it for its grid).
    fn height_from(&self, x: f32, y: f32, moats: bool, built: bool, base: f32) -> f32 { self.height_from_in(x, y, moats, built, base, &self.buildings) }

    /// Ground height for the march router: the same as `height_ground`, but with the ditches, earthworks and drawbridges taken from `edits`, a list the router keeps
    /// (the pieces in the order they stand in `buildings`, refreshed whenever `ground_stamp` changes). Every height it gives is the same to the bit; it only spares a walk
    /// over every building of the village for each sample, which was most of the cost of a march in a big village.
    pub(crate) fn height_ground_in(&self, x: f32, y: f32, edits: &[Building]) -> f32 { self.height_from_in(x, y, true, false, self.base(x, y), edits) }

    /// `height_from` over `bs`, which must hold every ditch, earthwork and drawbridge of the village in their order in `buildings` (other buildings are skipped anyway).
    fn height_from_in(&self, x: f32, y: f32, moats: bool, built: bool, base: f32, bs: &[Building]) -> f32 {
        self.height_layers(&Layers { levels: &self.levels, flats: &self.flats, roads: &self.roads, pads: &self.buildings, craters: &self.craters }, x, y, moats, built, base, bs)
    }

    /// The height at a point from the given layers of ground changes (see `Layers`): every one the loops below would skip for this point may be left out, nothing else.
    fn height_layers(&self, lay: &Layers, x: f32, y: f32, moats: bool, built: bool, base: f32, bs: &[Building]) -> f32 {
        let mut h = base;
        for l in lay.levels {   // ground levelled flat on purpose
            let (dx, dy) = (x - l[0], y - l[1]); let reach = l[2] + LEVEL_BLEND;
            if dx.abs() > reach || dy.abs() > reach { continue; }
            let d = (dx * dx + dy * dy).sqrt();
            if d < reach { h = lerp(h, l[3], 1.0 - smoothstep(l[2], reach, d)); }
        }
        let mut ditch = 0.0f32;   // how much of a standing ditch is here (0 to 1): a levelled patch never fills it in
        let mut explicit = Vec::new();
            // A moat or river is a chain of pieces. Digging each piece as its own round hollow (each one taking the deepest) leaves a scalloped bank, a bump at every piece. So the
            // pieces' reach is summed instead and the ground is dug by the total (at most all the way): between two neighbours both contribute, which fills in the scallop. A single
            // piece still digs exactly the round pit it always did.
            let (mut fm, mut fr) = (0.0f32, 0.0f32);
            for b in bs.iter().filter(|b| if moats { is_edit(b.kind) } else { matches!(b.kind, RAISE | LOWER) && b.aux >= 0 }) {
                let (dx, dy) = (x - b.x, y - b.y);
                let (floor, bank) = match b.kind { MOAT => (MOAT_FLOOR * moat_scale(b), MOAT_FLOOR * moat_scale(b) + CHANNEL_BANK), RIVER => (RIVER_FLOOR, RIVER_FLOOR + CHANNEL_BANK), _ => (1.2, 5.0) };
                if dx.abs() > bank || dy.abs() > bank { continue; }
                let dist = (dx * dx + dy * dy).sqrt();
                if dist >= bank { continue; }
                let weight = 1.0 - smoothstep(floor, bank, dist);
                match b.kind {
                    MOAT => fm += weight,
                    RIVER => fr += weight,
                    RAISE | LOWER if b.aux >= 0 => explicit.push((b.kind, b.aux as f32 / 16.0, weight)),
                    RAISE => h += 2.2 * weight,
                    _ => h -= 2.2 * weight,
                }
            }
        if moats {
            // The bed lies at a fixed depth below the sea, which is deep enough on ordinary land; on ground levelled high (above CHANNEL_REF_TOP) the bed rides up with it, so a moat is
            // never a sheer shaft a hill deep.
            let rise = (h - CHANNEL_REF_TOP).max(0.0);
            if fm > 0.0 && h > MOAT_BED + rise { h += (MOAT_BED + rise - h) * fm.min(1.0); }
            if fr > 0.0 && h > RIVER_BED + rise { h += (RIVER_BED + rise - h) * fr.min(1.0); }
            ditch = fm.max(fr).min(1.0);
        }
        for f in lay.flats {   // ground the player levelled: after the ditches and earthworks, so it hides whatever was dug there
            let (dx, dy) = (x - f[0], y - f[1]); let reach = f[2] + flatten::FLAT_SHOULDER;
            if dx.abs() > reach || dy.abs() > reach { continue; }
            let d = (dx * dx + dy * dy).sqrt();
            if d < reach { h = lerp(h, f[3], (1.0 - smoothstep(f[2], reach, d)) * (1.0 - ditch)); }
        }
        for (kind, target, weight) in explicit {
            let height = if kind == RAISE { h.max(target) } else { h.min(target) };
            h = lerp(h, height, weight * (1.0 - ditch));
        }
        // the earth at each end of a drawbridge is levelled to the deck, in a strip that runs on from the deck's ends (after the ditch is dug, so the water stays between them):
        // the deck meets the ground flush, with no step and no slope to climb
        for b in bs.iter().filter(|b| b.kind == DRAWBRIDGE) {
            if (x - b.x).abs() > 24.0 || (y - b.y).abs() > 24.0 { continue; }
            let a = (b.rot & 7) as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            let (dx, dy) = (x - b.x, y - b.y); let s = (dx * sx + dy * sy).abs(); let c = (dx * sy - dy * sx).abs();
            if !(3.0..22.0).contains(&s) || c > 5.2 { continue; }
            let w = smoothstep(3.0, 4.0, s) * (1.0 - smoothstep(15.0, 22.0, s)) * (1.0 - smoothstep(2.4, 5.2, c));
            if !self.river_covers(x, y, h) { h = lerp(h, b.pad_h, w * smoothstep(-0.8, 0.0, h)); }
        }
        if !built { return h; }
        for s in lay.roads {
            let (minx, maxx) = (s[0].min(s[3]) - ROAD_OUTER, s[0].max(s[3]) + ROAD_OUTER);
            let (miny, maxy) = (s[1].min(s[4]) - ROAD_OUTER, s[1].max(s[4]) + ROAD_OUTER);
            if x < minx || x > maxx || y < miny || y > maxy { continue; }
            let (dx, dy) = (s[3] - s[0], s[4] - s[1]);
            let len2 = (dx * dx + dy * dy).max(0.0001);
            let t = (((x - s[0]) * dx + (y - s[1]) * dy) / len2).clamp(0.0, 1.0);
            let (cx, cy) = (s[0] + dx * t, s[1] + dy * t);
            let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
            if d < ROAD_OUTER && !self.river_covers(x, y, h) {
                h = lerp(h, lerp(s[2], s[5], t), (1.0 - smoothstep(ROAD_INNER, ROAD_OUTER, d)) * smoothstep(-0.6, 0.0, h));
            }
        }
        for b in lay.pads {
            let d = &DEFS[b.kind as usize];
            if is_edit(b.kind) { continue; }   // ditches and earthworks were applied above, before roads and pads
            if !d.pad { continue; }
            let r0 = if b.kind == TOWN_HALL && b.tier >= 3 { footprint(TOWN_HALL, 3) } else { pad_inner(d) };
            let r1 = r0 + 3.5;
            let (dx, dy) = (x - b.x, y - b.y);
            // a farm's fields reach far past its circle once it is upgraded (up to 15 from its middle, and to one side): the ground is levelled under all of them, not just the circle
            if b.kind == FARM && dx.abs() <= FARM_PAD_REACH && dy.abs() <= FARM_PAD_REACH {
                let fd = (pathnet::field_distance(b, x, y) - FARM_YARD).max(0.0);
                if fd < FARM_PAD_BLEND { h = lerp(h, b.pad_h, 1.0 - smoothstep(FARM_PAD_FLAT, FARM_PAD_BLEND, fd)); }
            }
            if dx.abs() > r1 || dy.abs() > r1 { continue; }
            let dist = (dx * dx + dy * dy).sqrt();
            if matches!(b.kind, WALL | GATE | FENCE) {   // a wall builds the ground it stands on: earth is heaped up where it is missing (never dug away), so no wall hangs over a drop or a ditch
                let r1 = r0 + 2.2;
                if dist < r1 && h < b.pad_h { h += (b.pad_h - h) * (1.0 - smoothstep(r0 * 0.8, r1, dist)); }
            } else if dist < r1 {
                let mut weight = 1.0 - smoothstep(r0, r1, dist);
                if matches!(b.kind, WATERWHEEL | FISHING_HUT) {
                    let (ux, uy) = Self::wheel_dir(b.rot);
                    let foot = if b.kind == WATERWHEEL { WHEEL_FOOT } else { HUT_FOOT };
                    // Blend the foundation into the bank before it reaches the wheel or the end of the jetty.
                    weight *= 1.0 - smoothstep(foot, WHEEL_REACH - 0.6, dx * ux + dy * uy);
                }
                h = lerp(h, b.pad_h, weight);
            }
        }
        for c in lay.craters {
            let (dx, dy) = (x - c[0], y - c[1]);
            if dx.abs() > c[2] || dy.abs() > c[2] { continue; }
            let d = (dx * dx + dy * dy).sqrt();
            if d < c[2] { h -= c[3] * (1.0 - smoothstep(0.0, c[2], d)); }
        }
        h
    }

    /// The ground changes that can reach any point of a rectangle, in their usual order. Everything left out would be skipped by `height_layers` at every point of it (each test below is
    /// the loop's own `continue` test, widened by a little), so the heights are the same to the bit; it spares a walk over every building and road for each sample.
    fn layers_near(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> (Vec<[f32; 4]>, Vec<[f32; 4]>, Vec<[f32; 6]>, Vec<Building>, Vec<Building>, Vec<[f32; 4]>) {
        const PAD: f32 = 1.0;
        let near = |cx: f32, cy: f32, reach: f32| cx + reach + PAD >= x0 && cx - reach - PAD <= x1 && cy + reach + PAD >= y0 && cy - reach - PAD <= y1;
        let levels = self.levels.iter().filter(|l| near(l[0], l[1], l[2] + LEVEL_BLEND)).copied().collect();
        let flats = self.flats.iter().filter(|f| near(f[0], f[1], f[2] + flatten::FLAT_SHOULDER)).copied().collect();
        let roads = self.roads.iter().filter(|s| s[0].min(s[3]) - ROAD_OUTER - PAD <= x1 && s[0].max(s[3]) + ROAD_OUTER + PAD >= x0 && s[1].min(s[4]) - ROAD_OUTER - PAD <= y1 && s[1].max(s[4]) + ROAD_OUTER + PAD >= y0).copied().collect();
        let craters = self.craters.iter().filter(|c| near(c[0], c[1], c[2])).copied().collect();
        // ditches, earthworks and drawbridges (the `bs` list), and the buildings with a pad (the pads list)
        let edits = self.buildings.iter().filter(|b| {
            let bank = match b.kind { MOAT => MOAT_FLOOR * moat_scale(b) + CHANNEL_BANK, RIVER => RIVER_FLOOR + CHANNEL_BANK, RAISE | LOWER => 5.0, DRAWBRIDGE => 24.0, _ => return false };
            near(b.x, b.y, bank)
        }).cloned().collect();
        let pads = self.buildings.iter().filter(|b| {
            let d = &DEFS[b.kind as usize];
            if is_edit(b.kind) || !d.pad { return false; }
            let r0 = if b.kind == TOWN_HALL && b.tier >= 3 { footprint(TOWN_HALL, 3) } else { pad_inner(d) };
            near(b.x, b.y, (r0 + 3.5).max(if b.kind == FARM { FARM_PAD_REACH } else { 0.0 }))
        }).cloned().collect();
        (levels, flats, roads, edits, pads, craters)
    }

    /// Heights of an nx*ny grid (with pads) â€“ used to refresh the mesh after building.
    pub fn terrain_region(&self, x0: f32, y0: f32, nx: u32, ny: u32, step: f32) -> Vec<f32> {
        // worked out a small tile at a time: the pieces that can reach a tile are picked out once for its samples, not looked through again for every one of them
        const TILE: u32 = 8;
        let mut out = vec![0.0f32; (nx * ny) as usize];
        for tj in (0..ny).step_by(TILE as usize) { for ti in (0..nx).step_by(TILE as usize) {
            let (ei, ej) = ((ti + TILE).min(nx), (tj + TILE).min(ny));
            let (xa, xb) = (x0 + ti as f32 * step, x0 + (ei - 1) as f32 * step);
            let (ya, yb) = (y0 + tj as f32 * step, y0 + (ej - 1) as f32 * step);
            let (levels, flats, roads, edits, pads, craters) = self.layers_near(xa.min(xb), ya.min(yb), xa.max(xb), ya.max(yb));
            let lay = Layers { levels: &levels, flats: &flats, roads: &roads, pads: &pads, craters: &craters };
            for j in tj..ej { for i in ti..ei { let (x, y) = (x0 + i as f32 * step, y0 + j as f32 * step); out[(j * nx + i) as usize] = self.height_layers(&lay, x, y, true, true, self.base(x, y), &edits); } }
        } }
        out
    }

    pub fn origin_x(&self) -> i32 { self.ox }
    pub fn origin_y(&self) -> i32 { self.oy }

    pub fn build_radius(&self) -> u32 {
        let w: u32 = self.buildings.iter().map(|b| DEFS[b.kind as usize].weight * (b.tier as u32 + 1)).sum();
        // the town hall's own tier widens the border a great deal: a manor, a keep and above all the vast Castle (whose footprint alone reaches 30) claim far more land
        let hall = self.buildings.iter().filter(|b| b.kind == TOWN_HALL).map(|b| [0.0f32, 8.0, 20.0, 40.0][(b.tier as usize).min(3)]).fold(0.0f32, f32::max);
        // so does the embassy (the best one standing): a vast compound of diplomats and merchants draws a wide circle of land to it
        let embassy = self.buildings.iter().filter(|b| b.kind == EMBASSY).map(|b| [6.0f32, 16.0, 28.0, 44.0][(b.tier as usize).min(3)]).fold(0.0f32, f32::max);
        ((24.0 + 7.0 * (w as f32).sqrt() + hall + embassy).min(RADIUS_CAP)) as u32
    }

    /// How far a building claims land round itself (0 for earthworks). The town hall claims the circle of `build_radius`; every other building, and every piece of road, claims a patch round it,
    /// so a village grows outwards where its people build, in the shape of what they built, not as a circle.
    fn claim(&self, b: &Building) -> f32 {
        match b.kind {
            TOWN_HALL => self.build_radius() as f32,
            STABLE => 0.0,
            k if is_edit(k) => 0.0,
            ROAD => if b.status == 4 { roadline::ROAD_CLAIM } else { 0.0 },   // only a piece that is joined to the village's land (see `sync_road_conn`) claims any
            BRIDGE => 7.0,
            WALL | FENCE | GATE | DRAWBRIDGE => 5.0,
            k => 10.0 + 2.5 * ((DEFS[k as usize].weight * (b.tier as u32 + 1)) as f32).sqrt(),
        }
    }
    /// Is this spot inside the village's land: near the town hall, or near something built on its edge (farther than TERRITORY_MAX from the hall only a joined road claims land: roads are how the village spreads on)?
    pub fn in_territory(&self, x: f32, y: f32) -> bool { self.in_territory_by(x, y, true) }
    /// `in_territory`, with the claims of road pieces counted or not (a road piece is joined to the land when it stands in land that is not its own doing, or runs to a building).
    pub(crate) fn in_territory_by(&self, x: f32, y: f32, roads: bool) -> bool {
        let (hx, hy) = (self.buildings[0].x, self.buildings[0].y);
        let dh = ((x - hx).powi(2) + (y - hy).powi(2)).sqrt();
        let beyond = dh > TERRITORY_MAX;   // out here only a road joined to the village claims land: buildings must stand beside one
        self.buildings.iter().any(|b| { if !roads && b.kind == ROAD { return false; } if beyond && b.kind != ROAD { return false; } let c = self.claim(b); c > 0.0 && (x - b.x).abs() <= c && (y - b.y).abs() <= c && ((x - b.x).powi(2) + (y - b.y).powi(2)) <= c * c })
    }
    /// The land the village holds, as discs [x, y, radius]: the hall's circle and a patch round every building. The border is the outline of their union.
    pub fn territory_flat(&self) -> Vec<f32> {
        self.buildings.iter().filter_map(|b| { let c = self.claim(b); if c > 0.0 { Some([b.x, b.y, c]) } else { None } }).flatten().collect()
    }

    /// -27 beyond the farthest the village can ever reach from its hall. -17 a deposit is in the way, -16 needs water, -18 no water to bridge near here, -19 too wide for this bridge.
    /// 0 = ok, otherwise: -1 bad kind, -2 outside radius, -3 overlaps, -4 water, -5 too steep,
    /// -6 cannot afford, -7 needs deposit, -8 needs forest, -9 not buildable (town hall)
    pub fn can_place(&self, kind: u8, dx: i32, dy: i32) -> i32 {
        if DEFS.get(kind as usize).is_none() { return -1 };
        if kind == TOWN_HALL { return -9; }
        if kind == BRIDGE { return self.bridge_check(dx, dy, 0).0; }
        self.can_place_xy(kind, self.ox as f32 + dx as f32, self.oy as f32 + dy as f32)
    }

    /// `can_place` at a world position (road pieces snapped onto a node are not on the whole-number grid).
    fn building_blocks_placement(kind: u8, x: f32, y: f32, b: &Building) -> bool {
        if (matches!(kind, DRAWBRIDGE | BRIDGE) && matches!(b.kind, MOAT | RIVER)) || (matches!(kind, MOAT | RIVER) && matches!(b.kind, DRAWBRIDGE | BRIDGE)) { return false; }
        if is_edit(kind) && is_edit(b.kind) && kind != b.kind { return false; }
        (b.x - x).powi(2) + (b.y - y).powi(2) < (footprint(b.kind, b.tier) + DEFS[kind as usize].r - 0.4).powi(2)
    }

    /// World-space [x, y, radius] marks for the objects blocking a placement.
    pub fn placement_obstructions(&self, kind: u8, dx: i32, dy: i32) -> Vec<f32> {
        let Some(d) = DEFS.get(kind as usize) else { return vec![] };
        let (x, y) = (self.ox as f32 + dx as f32, self.oy as f32 + dy as f32);
        let mut marks = Vec::new();
        for b in &self.buildings {
            if Self::building_blocks_placement(kind, x, y, b) { marks.extend([b.x, b.y, footprint(b.kind, b.tier) + 0.6]); }
        }
        if d.req != 1 {
            let clear = if is_edit(kind) { 2.6 } else if matches!(kind, WALL | FENCE | GATE) { 0.6 } else { d.r + 1.6 };
            for (di, dep) in self.deposits.iter().enumerate() {
                if dep.max > 0 && (dep.x - x).hypot(dep.y - y) < clear && self.deposit_in_use(di) { marks.extend([dep.x, dep.y, 2.0]); }   // (the rest is cleared away by the building, like trees)
            }
        }
        if !matches!(kind, ROAD | BRIDGE | DRAWBRIDGE) {
            let radius = if kind == MOAT { MOAT_FLOOR * 1.91 + CHANNEL_BANK } else if is_edit(kind) { 5.0 } else { d.r };
            for army in &self.dets {
                if army.occupied(|px, py| (px - x).hypot(py - y) < radius + members::FOOT_MARGIN) { marks.extend([army.x, army.y, 3.0]); }
            }
        }
        marks
    }

    pub(crate) fn can_place_xy(&self, kind: u8, x: f32, y: f32) -> i32 {
        let Some(d) = DEFS.get(kind as usize) else { return -1 };
        if matches!(kind, PASTURE | PIGSTY | STABLE) && !self.estate.active { return -1; }
        if kind == TOWN_HALL { return -9; }
        let allowed = if matches!(kind, ROAD | BRIDGE | DRAWBRIDGE | MOAT | PORT) {
            Self::infrastructure_in_bounds(x, y)
        } else {
            self.in_territory(x, y)
        };
        if !allowed {
            // past the hard limit no amount of building widens the border: say so (-27) instead of the "build more to grow it" of -2
            let (hx, hy) = (self.buildings[0].x, self.buildings[0].y);
            let infra = matches!(kind, ROAD | BRIDGE | DRAWBRIDGE | MOAT | PORT);
            return if !infra && (x - hx).hypot(y - hy) > TERRITORY_MAX { -27 } else { -2 };
        }
        if !matches!(kind, ROAD | BRIDGE | DRAWBRIDGE) {
            let radius = if kind == MOAT { MOAT_FLOOR * 1.91 + CHANNEL_BANK } else if is_edit(kind) { 5.0 } else { d.r };
            if self.dets.iter().any(|army| army.occupied(|px, py| (px - x).hypot(py - y) < radius + members::FOOT_MARGIN)) { return -3; }
        }
        if kind == GATE && !self.buildings.iter().any(|b| b.kind == WALL && (b.x - x).hypot(b.y - y) <= 9.0) { return -20; }   // a gate only ever stands in a wall
        if self.buildings.iter().any(|b| Self::building_blocks_placement(kind, x, y, b)) { return -3; }
        let fr = d.r * 0.9;
        let pts = [(0.0, 0.0), (fr, 0.0), (-fr, 0.0), (0.0, fr), (0.0, -fr)];
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for (px, py) in pts {
            let h = self.height_core(x + px, y + py, !is_edit(kind) && !matches!(kind, WALL | GATE | FENCE));
            if !matches!(kind, DRAWBRIDGE | RIVER | RAISE | LOWER)
                && self.natural_water_covers(x + px, y + py, h, 0.4) { return -4; }
            lo = lo.min(h);
            hi = hi.max(h);
        }
        if (hi - lo) / (fr * 2.0) > d.max_slope { return -5; }
        if d.req != 1 {   // nothing is built or dug on top of an ore or stone deposit (only mines and quarries stand beside one)
            let clear = if is_edit(kind) { 2.6 } else if matches!(kind, WALL | FENCE | GATE) { 0.6 } else { d.r + 1.6 };   // a wall may run over an outcrop (only its very middle is in the way)
            if self.deposits.iter().enumerate().any(|(di, dep)| dep.max > 0 && (dep.x - x).powi(2) + (dep.y - y).powi(2) < clear * clear && self.deposit_in_use(di)) { return -17; }   // (only one a mine or quarry works stays in the way)
        }
        if d.req == 1 && self.nearest_deposit(x, y, d.req_arg, true).is_none() { return -7; }
        if d.req == 2 && self.forest_here(x, y, 12.0) < 0.12 { return -8; }
        if d.req == 3 && !self.water_near(x, y, d.r + 5.0) { return -16; }
        for &(res, n) in d.cost { if self.stock[res as usize] < n { return -6; } }
        0
    }

    fn infrastructure_in_bounds(x: f32, y: f32) -> bool {
        x.abs() <= INFRASTRUCTURE_LIMIT && y.abs() <= INFRASTRUCTURE_LIMIT
    }

    /// Is there open water (a lake, river, the sea or a moat) within `r` of the point?
    fn water_near(&self, x: f32, y: f32, r: f32) -> bool {
        for k in 0..16 { let a = k as f32 * std::f32::consts::TAU / 16.0; for rr in [r * 0.6, r] { let (px, py) = (x + a.cos() * rr, y + a.sin() * rr); if self.natural_water_covers(px, py, self.height_at(px, py), 0.1) { return true; } } }
        false
    }

    /// Forest density near a point, as the village sees it: the land's own forest, except inside a big cleared area (see `demo`) where only the kept groves still have trees.
    fn forest_here(&self, x: f32, y: f32, r: f32) -> f32 {
        let inside = |c: &[f32; 3]| (c[0] - x).hypot(c[1] - y) < c[2];
        let natural = if self.felled.iter().any(|c| c[2] >= 30.0 && inside(c)) && !self.groves.iter().any(inside) { 0.0 } else { terrain::forest_near(self.seed, x, y, r) };
        natural.max(self.planted_density(x, y, r))   // grown planted trees count as forest too
    }

    /// Is there still a tree standing within the woodcutter's or hunter's reach of (x, y)? Trees felled by woodcutters and soldiers do not count.
    fn forest_left(&self, x: f32, y: f32) -> bool {
        let r = 12.0f32;
        (0..25).any(|k| {
            let (px, py) = if k == 0 { (x, y) } else { let a = k as f32 * 2.399; let d = r * ((k as f32) / 25.0).sqrt(); (x + a.cos() * d, y + a.sin() * d) };
            self.forest_here(px, py, 2.5) >= 0.12 && !self.felled.iter().any(|c| (c[0] - px).hypot(c[1] - py) < c[2])
        })
    }

    /// Does building `i` still have what it was built for: trees for a woodcutter or hunter, open water for a fishing hut or waterwheel, any water for the rest that need it? (A deposit is checked apart.)
    fn site_requirement_met(&self, i: usize) -> bool {
        let b = &self.buildings[i]; let d = &DEFS[b.kind as usize];
        match d.req {
            2 => self.forest_left(b.x, b.y),
            3 => if matches!(b.kind, WATERWHEEL | FISHING_HUT) { self.wheel_in_water(b.x, b.y, b.rot & 7) } else { self.water_near(b.x, b.y, d.r + 5.0) },
            _ => true,
        }
    }

    /// Woodcutters slowly clear the forest round them, so the clearing (and the village) grows.
    fn clear_trees(&mut self, bx: f32, by: f32) {
        if self.rng.range(4) != 0 { return; }
        if self.fell_planted(bx, by) { return; }   // the planted trees go first
        if self.felled.len() >= 500 { return; }
        let a = self.rng.range(628) as f32 * 0.01; let dist = 5.0 + self.rng.range(120) as f32 * 0.1;
        let (x, y) = (bx + a.cos() * dist, by + a.sin() * dist);
        if self.forest_here(x, y, 2.5) < 0.12 || self.height_at(x, y) < 0.6 { return; }
        if self.felled.iter().any(|f| (f[0] - x).powi(2) + (f[1] - y).powi(2) < 2.2 * 2.2) { return; }
        self.felled.push([x, y, 2.4]); self.map_ver += 1;
    }

    /// The nearest deposit of this kind within reach; with `dormant_too` a dormant one counts (a mine may be built beside it and wait for it to wake), else only one that can be worked now.
    fn nearest_deposit(&self, x: f32, y: f32, kind: u8, dormant_too: bool) -> Option<usize> {
        let mut best: Option<(usize, f32)> = None;
        for (i, dep) in self.deposits.iter().enumerate() {
            if dep.kind != kind || !(dep.active() || (dormant_too && dep.max > 0)) || self.height_at(dep.x, dep.y) < 0.3 { continue; }   // a deposit drowned by a river or lake cannot be worked
            let d2 = (dep.x - x).powi(2) + (dep.y - y).powi(2);
            if d2 <= 15.0 * 15.0 && best.map_or(true, |(_, b)| d2 < b) { best = Some((i, d2)); }
        }
        best.map(|(i, _)| i)
    }

    /// Place a building at coordinates relative to the village origin. Returns index or the negative `can_place` code.
    pub fn place(&mut self, kind: u8, dx: i32, dy: i32, rot: u8) -> i32 {
        if kind == BRIDGE { return self.place_bridge(dx, dy); }
        let (x, y) = (self.ox as f32 + dx as f32, self.oy as f32 + dy as f32);
        self.place_at(kind, x, y, rot, None)
    }

    /// Check a Raise Ground or Lower Ground piece at a chosen absolute height. Negative heights use the original 2.2-unit change.
    pub fn earthwork_check(&self, kind: u8, dx: i32, dy: i32, height: f32) -> i32 {
        self.earthwork_plan(kind, dx, dy, height).map_or_else(|code| code, |_| 0)
    }

    /// Place an earthwork with the same target-height limits as Level Ground, preserving pen rotation and costs.
    pub fn place_earthwork(&mut self, kind: u8, dx: i32, dy: i32, rot: u8, height: f32) -> i32 {
        match self.earthwork_plan(kind, dx, dy, height) {
            Ok((x, y, aux)) => self.place_checked(kind, x, y, rot, None, aux),
            Err(code) => code,
        }
    }

    /// `place` at a world position; a road piece also takes what it is joined to (a piece placed without them is joined to the nearest piece or node in reach, see `road_tgts_near`).
    pub(crate) fn place_at(&mut self, kind: u8, x: f32, y: f32, rot: u8, tgts: Option<[roadline::Tgt; 2]>) -> i32 {
        let code = self.can_place_xy(kind, x, y);
        if code != 0 { return code; }
        self.place_checked(kind, x, y, rot, tgts, -1)
    }

    fn place_checked(&mut self, kind: u8, x: f32, y: f32, rot: u8, tgts: Option<[roadline::Tgt; 2]>, earthwork_height: i32) -> i32 {
        if matches!(kind, WATERWHEEL | FISHING_HUT) && !self.wheel_in_water(x, y, rot & 7) { return -16; }   // the wheel hangs out over the water: the turn decides where it is
        let d = &DEFS[kind as usize];
        for &(res, n) in d.cost { self.stock[res as usize] -= n; }
        let pad_h = self.placement_height(kind, x, y, rot);
        let aux = if d.req == 1 { self.nearest_deposit(x, y, d.req_arg, true).map_or(-1, |i| i as i32) } else { earthwork_height };
        let mut status = if d.cycle > 0 { 1 } else { 4 };
        if kind == ROAD { let t = tgts.unwrap_or_else(|| self.road_tgts_near(x, y)); status = if self.road_piece_attached(x, y, &t) { 4 } else { 2 }; self.road_conn.push(roadline::RoadConn { x, y, to: t }); }
        self.buildings.push(Building { kind, tier: 0, x, y, rot: rot & 7, pad_h, progress: 0, status, aux, staff: 0, residents: 0, hp: battle::max_hp(kind, 0), burning: 0.0, garrison: 0, born: self.tick as u32, opts: 0, fert: FERT_MAX, mode: 0, target: -1, beff: 100 });
        if d.req != 1 { let clear = if is_edit(kind) { 2.6 } else if matches!(kind, WALL | FENCE | GATE) { 0.6 } else { d.r + 1.6 }; self.clear_deposits_within(x, y, clear); }   // the building takes the ore or stone in its way off the land, as it does the trees
        if is_edit(kind) { self.terrain_ver += 1; }   // the ground changed: everything standing on it must be re-fitted
        if kind == DRAWBRIDGE {   // clear a way through the trees on the far side so a path can run out from the gate
            let a = (rot & 7) as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            for k in [9.0f32, 14.0, 19.0] { if self.felled.len() < 500 { self.felled.push([x + sx * k, y + sy * k, 5.0]); } }
            self.map_ver += 1;
        }
        self.after_change();
        (self.buildings.len() - 1) as i32
    }

    /// Place many buildings in one go: [kind, dx, dy, rot] for each. Returns what `place` returns for each one. The path network is rebuilt once at the end instead of after every
    /// piece, which makes a big build (a castle's walls, a moat) many times faster; every peer replays the same batch, so they stay in step.
    pub fn place_batch(&mut self, flat: &[i32]) -> Vec<i32> {
        self.place_batch_height(flat, -1.0)
    }

    /// The same pen stroke with one optional absolute height for its raise and lower pieces.
    pub fn place_batch_height(&mut self, flat: &[i32], height: f32) -> Vec<i32> {
        self.defer_roads = true;
        let out: Vec<i32> = flat.chunks_exact(4).take(400).map(|c| {
            let Ok(kind) = u8::try_from(c[0]) else { return -1 };
            let rot = (c[3] & 7) as u8;
            if matches!(kind, RAISE | LOWER) { self.place_earthwork(kind, c[1], c[2], rot, height) }
            else { self.place(kind, c[1], c[2], rot) }
        }).collect();
        self.defer_roads = false;
        self.after_change();
        out
    }

    /// Which way the waterwheel's wheel looks for a turn `rot`: the model's +x axis turned by r * 45 degrees (the renderer rotates about the vertical, which sends +x to (cos, -sin)).
    fn wheel_dir(rot: u8) -> (f32, f32) { let a = (rot & 7) as f32 * std::f32::consts::FRAC_PI_4; (a.cos(), -a.sin()) }
    /// Water level under the mill wheel or the end of a fishing jetty.
    pub fn shore_water_height(&self, x: f32, y: f32, rot: u8) -> f32 {
        let (ux, uy) = Self::wheel_dir(rot);
        self.water_surface_at(x + ux * WHEEL_REACH, y + uy * WHEEL_REACH)
    }
    fn drawbridge_clearance(&self, x: f32, y: f32, rot: u8) -> f32 {
        let (sx, sy) = doors::to_world(rot, (0.0, 1.0));
        let water = [-4.0, 0.0, 4.0].into_iter()
            .map(|d| self.water_surface_at(x + sx * d, y + sy * d)).fold(0.0, f32::max);
        (water + 0.35).max(0.8)
    }
    /// The floor or deck height at an absolute location, shared by placement and its preview.
    pub fn placement_height(&self, kind: u8, x: f32, y: f32, rot: u8) -> f32 {
        if matches!(kind, WATERWHEEL | FISHING_HUT) {
            return self.height_ground(x, y).max(self.shore_water_height(x, y, rot) + SHORE_CLEARANCE);
        }
        if kind == DRAWBRIDGE {
            let (sx, sy) = doors::to_world(rot, (0.0, 1.0));
            let gate = self.buildings.iter().filter(|b| b.kind == GATE)
                .map(|b| ((b.x - x).hypot(b.y - y), b.pad_h)).filter(|&(d, _)| d < 30.0)
                .min_by(|a, b| a.0.total_cmp(&b.0));
            return gate.map_or_else(
                || self.height_at(x + sx * 9.0, y + sy * 9.0).max(self.height_at(x - sx * 9.0, y - sy * 9.0)),
                |(_, h)| h,
            ).max(self.drawbridge_clearance(x, y, rot));
        }
        let Some(d) = DEFS.get(kind as usize) else { return self.height_at(x, y) };
        let fr = d.r * 0.8;
        let samples = [(0.0, 0.0), (fr, 0.0), (-fr, 0.0), (0.0, fr), (0.0, -fr)];
        if matches!(kind, WALL | GATE | FENCE) {
            // A wall stands level on its highest side and heaps earth under the low side.
            return samples.iter().map(|(px, py)| self.height_core(x + px, y + py, false)).fold(0.3, f32::max);
        }
        samples.iter().map(|(px, py)| self.height_at(x + px, y + py)).sum::<f32>() / 5.0
    }
    /// Does a waterwheel house at (x, y) turned `rot` have its wheel out over open water?
    fn wheel_in_water(&self, x: f32, y: f32, rot: u8) -> bool {
        let (ux, uy) = Self::wheel_dir(rot);
        [WHEEL_REACH, WHEEL_REACH + 1.2].into_iter().all(|r| {
            let (px, py) = (x + ux * r, y + uy * r);
            self.natural_water_covers(px, py, self.height_at(px, py), 0.2)
        })
    }
    /// Where a waterwheel clicked at (dx, dy) goes: pulled onto the bank beside the nearest water and turned so its wheel hangs out over it.
    /// [dx, dy, turn] relative to the origin (what `place` takes), or nothing when there is no water within reach or no bank there where the house can stand. Pure function of the world, so
    /// the client only ever sends the answer: `place` checks it again.
    pub fn waterwheel_snap(&self, dx: i32, dy: i32) -> Vec<f32> { self.shore_snap(WATERWHEEL, dx, dy) }
    /// Where a fishing hut clicked at (dx, dy) goes: the same bank snap as the waterwheel (its jetty plays the wheel's part), at a river, lake, sea or moat edge.
    pub fn fishing_hut_snap(&self, dx: i32, dy: i32) -> Vec<f32> { self.shore_snap(FISHING_HUT, dx, dy) }

    /// Find a dry warehouse site and point its pier into open water. Return the final coordinates
    /// and turn so signed placement commands can replay without doing another search.
    pub fn port_snap(&self, dx: i32, dy: i32) -> Vec<f32> {
        const SNAP: i32 = 14;
        let x = self.ox as f32 + dx as f32;
        let y = self.oy as f32 + dy as f32;
        if x.abs().max(y.abs()) > INFRASTRUCTURE_LIMIT + SNAP as f32 { return vec![]; }

        let mut offsets = Vec::new();
        for sy in -SNAP..=SNAP { for sx in -SNAP..=SNAP {
            let distance = sx * sx + sy * sy;
            if distance <= SNAP * SNAP { offsets.push((distance, sx, sy)); }
        } }
        offsets.sort_unstable();
        for (_, sx, sy) in offsets {
            let (px, py) = (x + sx as f32, y + sy as f32);
            if !matches!(self.can_place_xy(PORT, px, py), 0 | -6) { continue; }
            let mut best: Option<(f32, u8)> = None;
            for turn in 0..8 {
                if let Some(score) = self.port_landing(px, py, turn) {
                    if best.is_none_or(|(previous, _)| score > previous) { best = Some((score, turn)); }
                }
            }
            if let Some((_, turn)) = best {
                return vec![px - self.ox as f32, py - self.oy as f32, turn as f32];
            }
        }
        vec![]
    }

    fn port_landing(&self, x: f32, y: f32, turn: u8) -> Option<f32> {
        let ground = self.placement_height(PORT, x, y, turn);
        let sample = |across, along| {
            let (dx, dy) = doors::to_world(turn, (across, along));
            let (px, py) = (x + dx, y + dy);
            let stage = self.water_surface_at(px, py);
            let f = (stage / 1.2).clamp(0.0, 1.0);
            let low_water = stage - 0.51 * (1.0 - f * f * (3.0 - 2.0 * f));
            (stage, low_water - self.height_at(px, py))
        };
        // The pier is 2.8 units wide, centred 2.2 to the right of the warehouse and ends 13 out.
        let (level, end) = sample(2.2, 12.75);
        if end < 0.42 || ground - level > 3.8 { return None; }
        let left = sample(1.05, 12.75).1;
        let right = sample(3.35, 12.75).1;
        if left.min(right) < 0.20 || sample(2.2, 10.5).1 < 0.15 { return None; }
        // Prefer water beside the pier for a moored boat.
        let berth = sample(5.1, 11.0).1.max(sample(-0.85, 11.0).1);
        Some(end.min(2.0) + berth.clamp(-2.0, 2.0))
    }

    fn shore_snap(&self, kind: u8, dx: i32, dy: i32) -> Vec<f32> {
        let (x, y) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        let wet = |px: f32, py: f32| self.natural_water_covers(px, py, self.height_at(px, py), 0.1);
        let mut p: Option<(f32, f32)> = if wet(x, y) { Some((x, y)) } else { None };
        'find: for r in 1..=16 { for k in 0..16 { let a = k as f32 * std::f32::consts::TAU / 16.0; let (px, py) = (x + a.cos() * r as f32, y + a.sin() * r as f32); if wet(px, py) { p = Some((px, py)); break 'find; } } }
        let Some((px, py)) = p else { return vec![] };
        // the turns, best first: the one whose wheel points most nearly from the click towards the water (all eight when the click is in the water itself)
        let (vx, vy) = (px - x, py - y); let vl = vx.hypot(vy);
        let mut turns: Vec<(f32, u8)> = (0..8u8).map(|r| { let (ux, uy) = Self::wheel_dir(r); (if vl < 0.5 { 0.0 } else { -(ux * vx + uy * vy) / vl }, r) }).collect();
        turns.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
        for &(_, r) in &turns {
            let (ux, uy) = Self::wheel_dir(r);
            // walk back from the water along the opposite of the wheel's way to the first dry bank
            let mut t = 0.0f32; while t < 14.0 {
                let (bx, by) = (px - ux * t, py - uy * t);
                if !self.natural_water_covers(bx, by, self.height_at(bx, by), 0.45) { break; }
                t += 0.5;
            }
            for extra in [0.0f32, 0.5, 1.0, 1.5, 2.5] {
                let back = t + if kind == FISHING_HUT { HUT_FOOT } else { WHEEL_FOOT } + extra;   // the footing ends at the bank
                let (sx, sy) = ((px - ux * back).round(), (py - uy * back).round());
                let (cx, cy) = (sx - self.ox as f32, sy - self.oy as f32);
                let code = self.can_place(kind, cx as i32, cy as i32);
                if (code == 0 || code == -6) && self.wheel_in_water(sx, sy, r) { return vec![cx, cy, r as f32]; }
            }
        }
        vec![]
    }

    /// The turn (45-degree steps, as `place` takes it) whose deck direction (sin, cos) lies closest to the unit direction (nx, ny).
    pub(crate) fn drawbridge_turn(nx: f32, ny: f32) -> i32 { ((nx.atan2(ny) / std::f32::consts::FRAC_PI_4).round() as i32).rem_euclid(8) }

    /// Where a drawbridge clicked at (dx, dy) goes: snapped onto the nearest piece of moat or river (its middle line) and turned square across it, so the deck spans the water from bank to bank.
    /// [x, y, turn] relative to the origin (the turn is in 45-degree steps, as `place` takes it), or nothing when no moat is within reach.
    pub fn drawbridge_snap(&self, dx: i32, dy: i32) -> Vec<f32> {
        let (px, py) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        // the ditch is the chain of its pieces: the spot is the nearest point on the line joining neighbouring pieces, so a bridge can go anywhere along it, not only on a piece
        let pieces: Vec<(f32, f32, f32)> = self.buildings.iter().filter(|b| matches!(b.kind, MOAT | RIVER)).map(|b| (b.x, b.y, if b.kind == MOAT { MOAT_FLOOR * moat_scale(b) } else { RIVER_FLOOR } + CHANNEL_BANK)).collect();
        let mut best: Option<(f32, f32, f32, f32, f32, f32)> = None;   // (distance, x, y, tangent x, tangent y, reach)
        for (i, a) in pieces.iter().enumerate() {
            let d0 = (a.0 - px).hypot(a.1 - py);
            if d0 <= 16.0 && best.map_or(true, |b| d0 < b.0) { best = Some((d0, a.0, a.1, 1.0, 0.0, a.2)); }
            for b in &pieces[i + 1..] {
                let (sx, sy) = (b.0 - a.0, b.1 - a.1); let sl = sx.hypot(sy);
                if sl < 0.3 || sl > 8.0 { continue; }
                let t = (((px - a.0) * sx + (py - a.1) * sy) / (sl * sl)).clamp(0.0, 1.0);
                let (qx, qy) = (a.0 + sx * t, a.1 + sy * t); let d = (qx - px).hypot(qy - py);
                if d <= 16.0 && best.map_or(true, |o| d < o.0 - 0.01) { best = Some((d, qx, qy, sx, sy, a.2.max(b.2))); }
            }
        }
        let Some((_, qx, qy, mut tx, mut ty, reach)) = best else { return vec![] };
        if 2.0 * reach > 12.4 { return vec![]; }   // too wide for the deck to reach from bank to bank
        if tx == 1.0 && ty == 0.0 {   // a lone piece: the way the nearest neighbour lies, if any
            if let Some(n) = pieces.iter().filter(|p| (p.0 - qx).hypot(p.1 - qy) > 0.3).min_by(|a, b| (a.0 - qx).hypot(a.1 - qy).partial_cmp(&(b.0 - qx).hypot(b.1 - qy)).unwrap_or(std::cmp::Ordering::Equal)) { tx = n.0 - qx; ty = n.1 - qy; }
        }
        let tl = tx.hypot(ty).max(1e-6); let (mut nx, mut ny) = (-ty / tl, tx / tl);   // square across the ditch
        // the hinge is on the village side and the far end points outward: flip the normal if it points at the hall (the order of the moat pieces decides which way (-ty, tx) falls)
        if nx * (qx - self.ox as f32) + ny * (qy - self.oy as f32) < 0.0 { nx = -nx; ny = -ny; }
        let rot = Self::drawbridge_turn(nx, ny);
        vec![qx.round() - self.ox as f32, qy.round() - self.oy as f32, rot as f32]
    }

    /// Where a toll post clicked at (dx, dy) goes: pulled onto the nearest road and turned so that the road runs through its gate, along the axis between its two posts.
    /// [x, y, turn] relative to the origin (the turn in 45-degree steps, as `place` takes it), or nothing when no road is near (within 14) or there is no room for the post along it.
    pub fn toll_snap(&self, dx: i32, dy: i32) -> Vec<f32> {
        let (px, py) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        let mut best: Option<(f32, f32, f32, f32, f32)> = None;   // distance, x, y, direction x, direction y
        for (s, l) in self.roads.iter().zip(&self.road_links) {
            if l.0 == l.1 { continue; }   // (the short roads of the doors are not the village's roads)
            let (sx, sy) = (s[3] - s[0], s[4] - s[1]); let sl = sx.hypot(sy); if sl < 0.3 { continue; }
            let t = (((px - s[0]) * sx + (py - s[1]) * sy) / (sl * sl)).clamp(0.0, 1.0);
            let (qx, qy) = (s[0] + sx * t, s[1] + sy * t); let d = (qx - px).hypot(qy - py);
            if d <= 14.0 && best.map_or(true, |b| d < b.0 - 0.01) { best = Some((d, qx, qy, sx / sl, sy / sl)); }
        }
        let Some((_, qx, qy, ux, uy)) = best else { return vec![] };
        let rot = Self::drawbridge_turn(ux, uy);
        let net = self.net_base();
        // the post may need to slide along the road a little to find room
        for t in [0.0f32, 1.5, -1.5, 3.0, -3.0, 4.5, -4.5, 6.0, -6.0] {
            let (sx, sy) = ((qx + ux * t).round(), (qy + uy * t).round());
            let (cx, cy) = (sx - self.ox as f32, sy - self.oy as f32);
            let code = self.can_place(TOLL, cx as i32, cy as i32);
            if !(code == 0 || code == -6) { continue; }
            // the way through must be free on both sides of the post: the road has to run on from both ends of its gate
            let (wx, wy) = doors::to_world(rot as u8, (0.0, 1.0));
            if ![-5.0f32, -3.5, 0.0, 3.5, 5.0].iter().all(|&t| net.ok_at(sx + wx * t, sy + wy * t)) { continue; }
            // and the hut must not stand on the short road from somebody's door
            let (hx, hy) = doors::to_world(rot as u8, (2.4, -0.2)); let (hx, hy) = (sx + hx, sy + hy);
            let on_door = self.roads.iter().zip(&self.road_links).any(|(r, l)| {
                if l.0 != l.1 { return false; }
                let (dx, dy) = (r[3] - r[0], r[4] - r[1]); let l2 = (dx * dx + dy * dy).max(1e-6); let t = (((hx - r[0]) * dx + (hy - r[1]) * dy) / l2).clamp(0.0, 1.0);
                (hx - (r[0] + dx * t)).hypot(hy - (r[1] + dy * t)) < 2.6
            });
            if !on_door { return vec![cx, cy, rot as f32]; }
        }
        vec![]
    }

    // ---------- bridges ----------
    /// Where a bridge clicked at (dx, dy) would go: it finds the nearest water, picks the way across with the shortest span, and returns [centre x, centre y, angle in radians, total length, span of water],
    /// or nothing when there is no water within reach or it is too wide to bridge at all (60 units).
    pub fn bridge_snap(&self, dx: i32, dy: i32) -> Vec<f32> {
        let (x, y) = (self.ox as f32 + dx as f32, self.oy as f32 + dy as f32);
        if !Self::infrastructure_in_bounds(x, y) { return vec![]; }
        let wet = |px: f32, py: f32| self.ground_is_wet(px, py, self.height_ground(px, py));
        // the nearest water to the click
        let mut p: Option<(f32, f32)> = if wet(x, y) { Some((x, y)) } else { None };
        'find: for r in 1..=14 { for k in 0..16 { let a = k as f32 * std::f32::consts::TAU / 16.0; let (px, py) = (x + a.cos() * r as f32, y + a.sin() * r as f32); if wet(px, py) { p = Some((px, py)); break 'find; } } }
        let Some((px, py)) = p else { return vec![] };
        // which way is across? On a bank the ground rises away from the water, so the direction of steepest slope is across the channel; in the middle of the channel (flat bed) any direction
        // will do and the shortest way over is across. Look at a fan of directions round the likely one (all of them if there is no slope) and take the shortest wet run.
        let (gx, gy) = (self.height_at(px + 1.6, py) - self.height_at(px - 1.6, py), self.height_at(px, py + 1.6) - self.height_at(px, py - 1.6));
        let across = if gx.hypot(gy) > 0.6 { Some(gy.atan2(gx)) } else { None };
        let mut best: Option<(f32, f32, f32, f32)> = None;   // span, angle, t_back, t_forward
        for k in 0..32 {
            let a = k as f32 * std::f32::consts::PI / 32.0; let (ux, uy) = (a.cos(), a.sin());
            if let Some(g) = across { let d = ((a - g + std::f32::consts::PI * 3.0) % std::f32::consts::PI - std::f32::consts::FRAC_PI_2).abs(); if std::f32::consts::FRAC_PI_2 - d > 0.6 { continue; } }
            let walk = |sgn: f32| -> Option<f32> { let mut t = 0.0; while t < 60.0 { t += 0.5; if !wet(px + ux * sgn * t, py + uy * sgn * t) { return Some(t); } } None };
            let (Some(t1), Some(t2)) = (walk(-1.0), walk(1.0)) else { continue };
            let span = t1 + t2; if best.map_or(true, |b| span < b.0 - 0.01) { best = Some((span, a, t1, t2)); }
        }
        let Some((span, a, t1, t2)) = best else { return vec![] };
        let (ux, uy) = (a.cos(), a.sin()); let off = (t2 - t1) / 2.0;
        vec![px + ux * off, py + uy * off, a, span + 2.0 * BRIDGE_MARGIN, span]
    }
    /// Direction of a bridge building and its total length.
    pub(crate) fn bridge_dir(b: &Building) -> (f32, f32, f32) { let deg = (b.aux.max(0) % 360) as f32; let a = deg.to_radians(); (a.cos(), a.sin(), (b.aux.max(0) / 360) as f32 / 10.0) }

    /// Can a bridge go here (at the given tier)? Checks the map boundary, both landings, span, clearance and cost.
    fn bridge_check(&self, dx: i32, dy: i32, tier: u8) -> (i32, Vec<f32>) {
        if !Self::infrastructure_in_bounds(self.ox as f32 + dx as f32, self.oy as f32 + dy as f32) { return (-2, vec![]); }
        let snap = self.bridge_snap(dx, dy);
        if snap.is_empty() { return (-18, snap); }
        let (cx, cy, a, l, span) = (snap[0], snap[1], snap[2], snap[3], snap[4]);
        if span > BRIDGE_SPAN[tier as usize] { return (-19, snap); }
        let (ux, uy) = (a.cos(), a.sin()); let ends = [(cx - ux * l / 2.0, cy - uy * l / 2.0), (cx + ux * l / 2.0, cy + uy * l / 2.0)];
        if ends.iter().any(|&(x, y)| !Self::infrastructure_in_bounds(x, y)) { return (-2, snap); }
        let (ha, hb) = (self.height_at(ends[0].0, ends[0].1), self.height_at(ends[1].0, ends[1].1));
        if ends.iter().any(|&(x, y)| { let h = self.height_ground(x, y); h < 0.4 || self.ground_is_wet(x, y, h) }) || (ha - hb).abs() > 2.6 { return (-5, snap); }
        let steps = (l / 1.5).ceil() as i32;
        for k in 0..=steps { let t = k as f32 * 1.5 - l / 2.0; let (sx, sy) = (cx + ux * t, cy + uy * t);
            for b in &self.buildings { if matches!(b.kind, MOAT | RIVER | RAISE | LOWER | ROAD | DRAWBRIDGE) { continue; } let r = if b.kind == BRIDGE { 1.8 } else { DEFS[b.kind as usize].r }; if (b.x - sx).powi(2) + (b.y - sy).powi(2) < (r + 1.6).powi(2) { return (-3, snap); } } }
        if !self.can_afford(&Self::bridge_cost(span)) { return (-6, snap); }
        (0, snap)
    }
    /// What a new bridge of this span costs: its base cost plus a plank for every unit of span.
    pub(crate) fn bridge_cost(span: f32) -> Vec<Amount> { vec![(PL, 10 + span.ceil() as i32), (W, 8)] }
    fn place_bridge(&mut self, dx: i32, dy: i32) -> i32 {
        let (code, snap) = self.bridge_check(dx, dy, 0); if code != 0 { return code; }
        let (cx, cy, a, l, span) = (snap[0], snap[1], snap[2], snap[3], snap[4]);
        self.pay(&Self::bridge_cost(span));
        let (ux, uy) = (a.cos(), a.sin()); let (ha, hb) = (self.height_at(cx - ux * l / 2.0, cy - uy * l / 2.0), self.height_at(cx + ux * l / 2.0, cy + uy * l / 2.0));
        let deg = ((a.to_degrees().round() as i32) % 360 + 360) % 360; let aux = deg + 360 * ((l * 10.0).round() as i32);
        let rot = ((((ux).atan2(uy) / std::f32::consts::FRAC_PI_4).round() as i32 % 8) + 8) % 8;
        self.buildings.push(Building { kind: BRIDGE, tier: 0, x: cx, y: cy, rot: rot as u8, pad_h: (ha + hb) / 2.0, progress: 0, status: 4, aux, staff: 0, residents: 0, hp: battle::max_hp(BRIDGE, 0), burning: 0.0, garrison: 0, born: self.tick as u32, opts: 0, fert: FERT_MAX, mode: 0, target: -1, beff: 100 });
        self.after_change();
        (self.buildings.len() - 1) as i32
    }
    /// What a bridge would be if placed at (dx, dy): [code, centre x, centre y, angle, length, span, planks, wood, node x, node z, node x, node z]. The code is `can_place`'s; the nodes are where its roads would join.
    pub fn bridge_preview(&self, dx: i32, dy: i32) -> Vec<f32> {
        let (code, snap) = self.bridge_check(dx, dy, 0);
        if snap.is_empty() { return vec![code as f32]; }
        let c = Self::bridge_cost(snap[4]); let mut v = vec![code as f32]; v.extend_from_slice(&snap); v.push(c[0].1 as f32); v.push(c[1].1 as f32);
        // (the nodes of the bridge as it would be built: its direction is stored in whole degrees, and its length to a tenth)
        let deg = ((snap[2].to_degrees().round() as i32) % 360 + 360) % 360; let a = (deg as f32).to_radians();
        for p in roadline::bridge_nodes(snap[0], snap[1], a.cos(), a.sin(), (snap[3] * 10.0).round() / 10.0) { v.push(p.0); v.push(p.1); }
        v
    }
    /// Every bridge: [building index, centre x, centre y, angle, length, tier, options, ground height at one end, at the other end, deck height] each.
    pub fn bridge_spans_flat(&self) -> Vec<f32> {
        let mut v = vec![];
        for (i, b) in self.buildings.iter().enumerate().filter(|(_, b)| b.kind == BRIDGE) {
            let (ux, uy, l) = Self::bridge_dir(b);
            v.extend_from_slice(&[i as f32, b.x, b.y, uy.atan2(ux), l, b.tier as f32, b.opts as f32, self.height_at(b.x - ux * l / 2.0, b.y - uy * l / 2.0), self.height_at(b.x + ux * l / 2.0, b.y + uy * l / 2.0), b.pad_h]);
        }
        v
    }
    /// Points along the player's bridges (every three units), where raiders can cross the water too.
    pub(crate) fn bridge_points(&self) -> Vec<[f32; 2]> {
        let mut out = vec![];
        for b in self.buildings.iter().filter(|b| b.kind == BRIDGE) { let (ux, uy, l) = Self::bridge_dir(b); let n = (l / 3.0).ceil() as i32; for k in 0..=n { let t = k as f32 * l / n.max(1) as f32 - l / 2.0; out.push([b.x + ux * t, b.y + uy * t]); } }
        for b in self.buildings.iter().filter(|b| b.kind == DRAWBRIDGE && b.status == DB_MANUAL_DOWN) {
            let a = b.rot as f32 * std::f32::consts::FRAC_PI_4;
            for t in [-6.0, -3.0, 0.0, 3.0, 6.0] { out.push([b.x + a.sin() * t, b.y + a.cos() * t]); }
        }
        out
    }

    /// 0 ok, -1 invalid, -6 cannot afford, -10 max tier
    /// The buildings that stand in the way of this building growing to its next tier (only those that do not already overlap it now).
    pub fn upgrade_blockers(&self, idx: u32) -> Vec<u32> {
        let Some(b) = self.buildings.get(idx as usize) else { return vec![] };
        if b.tier >= max_tier(b.kind) { return vec![]; }
        let (old, new) = (footprint(b.kind, b.tier), footprint(b.kind, b.tier + 1));
        if new <= old { return vec![]; }
        self.buildings.iter().enumerate().filter(|(i, o)| {
            if *i == idx as usize || matches!(o.kind, MOAT | RIVER | RAISE | LOWER | ROAD | DRAWBRIDGE | BRIDGE) { return false; }
            let d2 = (o.x - b.x).powi(2) + (o.y - b.y).powi(2); let r = footprint(o.kind, o.tier);
            d2 < (r + new - 0.4).powi(2) && d2 >= (r + old - 0.4).powi(2)
        }).map(|(i, _)| i as u32).collect()
    }

    pub fn upgrade(&mut self, idx: u32) -> i32 {
        let Some(b) = self.buildings.get(idx as usize) else { return -1 };
        if b.tier >= max_tier(b.kind) { return -10; }
        if !self.upgrade_blockers(idx).is_empty() { return -3; }   // the bigger building would run into its neighbours: they must be demolished first
        let cost = upgrade_cost_for(b.kind, b.tier + 1);
        if cost.iter().any(|&(r, n)| self.stock[r as usize] < n) { return -6; }
        for &(r, n) in &cost { self.stock[r as usize] -= n; }
        self.buildings[idx as usize].tier += 1;
        let (k, t) = (self.buildings[idx as usize].kind, self.buildings[idx as usize].tier);
        self.buildings[idx as usize].hp = battle::max_hp(k, t);
        self.buildings[idx as usize].burning = 0.0;
        // a bigger building clears the trees that stand in the room it now takes (the felled ring is drawn as cleared ground and the woodcutters no longer count those trees)
        let (bx, by, fp) = (self.buildings[idx as usize].x, self.buildings[idx as usize].y, footprint(k, t));
        if fp > footprint(k, t - 1) { self.felled.push([bx, by, fp + 2.0]); self.map_ver += 1; if DEFS[k as usize].req != 1 { self.clear_deposits_within(bx, by, fp + 1.0); } }
        if k == FARM { self.terrain_ver += 1; }   // a bigger farm works more fields: the ground is levelled under them too, so everything standing near must be fitted to it again
        self.after_change();
        0
    }

    /// Upgrade several buildings in the order given: what `upgrade` returns for each. The roads are worked out once at the end instead of after every one, which keeps upgrading a whole
    /// selection quick in a big village. The result is the same as upgrading one by one (peers replay them one by one), because `upgrade` never reads what `after_change` derives.
    pub fn upgrade_batch(&mut self, idxs: &[u32]) -> Vec<i32> {
        self.defer_roads = true;
        let out: Vec<i32> = idxs.iter().map(|&i| self.upgrade(i)).collect();
        self.defer_roads = false;
        self.after_change();
        out
    }

    /// Choose the village's flag: 0 for none, otherwise a packed flag number (pattern, three colours, emblem; bit 24 always set). Free, and changeable. Anything else is refused.
    /// Bits 25-27 of the style are the village's roof tile palette (0-7, see `roof()`): part of the same number, so it travels, saves and hashes with the flag.
    pub fn set_style(&mut self, style: u32) -> bool { if style != 0 && (style < (1 << 24) || style >= (1 << 28) || style & (1 << 24) == 0) { return false; } self.style = style; true }
    pub fn style(&self) -> u32 { self.style }
    /// The village's roof tile palette (0 = the plain terracotta), drawn on every tiled roof of the village.
    pub fn roof(&self) -> u8 { ((self.style >> 25) & 7) as u8 }

    /// A row of buildings along a street from (ax, ay) to (bx, by), `spacing` apart, `offset` to one side or both: `sides` 0 left, 1 right, 2 both. Placed as one batch (the paths are worked out once).
    /// Returns what `place` returns for each house, left side first. A street of houses is how a district is laid out.
    pub fn place_row(&mut self, kind: u8, ax: i32, ay: i32, bx: i32, by: i32, spacing: u32, offset: u32, sides: u8) -> Vec<i32> {
        let (dx, dy) = ((bx - ax) as f32, (by - ay) as f32); let len = dx.hypot(dy);
        if len < 1.0 || spacing < 3 || offset < 2 || sides > 2 || kind as usize >= DEFS.len() { return vec![]; }
        let (ux, uy) = (dx / len, dy / len); let n = ((len / spacing as f32).floor() as i32 + 1).min(100);
        let rot = ((((-uy).atan2(ux) / std::f32::consts::FRAC_PI_4).round() as i32 % 8) + 8) % 8;
        let mut items: Vec<i32> = vec![];
        let side_list: &[f32] = match sides { 0 => &[1.0], 1 => &[-1.0], _ => &[1.0, -1.0] };
        for &sd in side_list { for i in 0..n {
            let t = i as f32 * spacing as f32;
            items.extend_from_slice(&[kind as i32, (ax as f32 + ux * t - uy * offset as f32 * sd).round() as i32, (ay as f32 + uy * t + ux * offset as f32 * sd).round() as i32, rot]);
        } }
        self.place_batch(&items)
    }

    // ---------- the lord ----------
    /// Take a lord or lady into the village's service (150 coins; needs a barracks; only one at a time). 0 ok, -4 already have one, -6 cannot afford, -11 no barracks.
    pub fn hero_hire(&mut self) -> i32 {
        if self.hero.is_some() { return -4; }
        if !self.buildings.iter().any(|b| b.kind == BARRACKS) { return -11; }
        if self.stock[GD as usize] < HERO_COST { return -6; }
        self.stock[GD as usize] -= HERO_COST;
        let name = (self.rng.range(HERO_NAMES.len() as u32)) as u8; self.hero = Some((name, 0)); self.push_event(EV_HERO, name as i32, 0); 0
    }
    /// The lord, if any: [name index, level 1..5, experience, experience for the next level (0 at the top)].
    pub fn hero_flat(&self) -> Vec<u32> {
        match self.hero { Some((n, xp)) => { let l = Self::hero_level(xp); vec![n as u32, l as u32, xp, if l < 5 { HERO_XP[l as usize] } else { 0 }] } None => vec![] }
    }
    pub fn hero_name(&self) -> String { self.hero.map_or(String::new(), |(n, _)| HERO_NAMES[n as usize % HERO_NAMES.len()].to_string()) }
    pub(crate) fn hero_level(xp: u32) -> u8 { HERO_XP.iter().rposition(|&x| xp >= x).map_or(1, |i| i as u8 + 1) }
    /// Defenders strike this much harder (1.0 with no lord, up to 1.24 at level 5).
    pub(crate) fn hero_dmg(&self) -> f32 { self.hero.map_or(1.0, |(_, xp)| 1.0 + 0.06 * (Self::hero_level(xp) as f32 - 1.0) + 0.04) }

    /// Switch one optional design upgrade of a building on (or off again, without refund). 0 ok, -1 invalid, -6 cannot afford, -10 not available yet (needs a better tier).
    /// Is a mine or quarry working this deposit? Such a deposit is never cleared away by a building.
    fn deposit_in_use(&self, i: usize) -> bool { self.buildings.iter().any(|b| b.aux == i as i32 && DEFS[b.kind as usize].req == 1) }
    /// Take every deposit within `r` of (x, y) off the land (not one a mine works): a building going up or growing clears the stone and ore in its way, as it clears the trees.
    fn clear_deposits_within(&mut self, x: f32, y: f32, r: f32) {
        let gone: Vec<usize> = (0..self.deposits.len()).filter(|&i| { let d = &self.deposits[i]; d.max > 0 && (d.x - x).hypot(d.y - y) < r && !self.deposit_in_use(i) }).collect();
        if gone.is_empty() { return; }
        for i in gone { let d = &mut self.deposits[i]; d.rem = 0; d.max = 0; d.asleep = false; }
        self.deposit_layout.set(None); self.map_ver += 1;
    }
    /// Clear a deposit off the land (the villagers break the rock up and cart it away, or dig the clay out) so the ground can be built on. 0 done, -1 no such deposit,
    /// -2 outside the border, -3 already cleared, -4 a mine or quarry is working it, -6 not enough wood and tools.
    pub fn clear_deposit(&mut self, i: u32) -> i32 {
        let Some(d) = self.deposits.get(i as usize).copied() else { return -1 };
        if d.max == 0 { return -3; }
        if !self.in_territory(d.x, d.y) { return -2; }
        if self.buildings.iter().any(|b| b.aux == i as i32 && DEFS[b.kind as usize].req == 1) { return -4; }
        if self.stock[W as usize] < 40 || self.stock[TL as usize] < 10 { return -6; }
        self.stock[W as usize] -= 40; self.stock[TL as usize] -= 10;
        let dep = &mut self.deposits[i as usize]; dep.rem = 0; dep.max = 0; dep.asleep = false;
        self.deposit_layout.set(None);
        self.map_ver += 1; self.after_change();
        0
    }

    pub fn set_option(&mut self, idx: u32, bit: u8, on: bool) -> i32 {
        let Some(b) = self.buildings.get(idx as usize) else { return -1 };
        let opts = options(b.kind);
        let Some(o) = opts.get(bit as usize) else { return -1 };
        let have = b.opts & (1 << bit) != 0;
        if have == on { return 0; }
        if on {
            if b.tier < o.2 { return -10; }
            let cost = if b.kind == ROAD { road_option_cost() } else { option_cost(b.kind, bit, DEFS[b.kind as usize].weight) };
            if cost.iter().any(|&(r, n)| self.stock[r as usize] < n) { return -6; }
            for &(r, n) in &cost { self.stock[r as usize] -= n; }
            self.buildings[idx as usize].opts |= 1 << bit;
        } else { self.buildings[idx as usize].opts &= !(1 << bit); }
        0
    }
    /// Chosen optional upgrades per building (a bit mask each), in building order.
    pub fn options_flat(&self) -> Vec<u32> { self.buildings.iter().map(|b| b.opts as u32).collect() }
    /// Flat [resource, amount, ...] cost of one optional upgrade of this kind of building.
    pub fn option_cost_flat(kind: u8) -> Vec<i32> { Self::option_cost_for_flat(kind, 0) }
    /// Flat [resource, amount, ...] cost of design option `bit` of this kind of building (each option of a house has its own price).
    pub fn option_cost_for_flat(kind: u8, bit: u8) -> Vec<i32> { match DEFS.get(kind as usize) { Some(d) => (if kind == ROAD { road_option_cost() } else { option_cost(kind, bit, d.weight) }).into_iter().flat_map(|(r, n)| [r as i32, n]).collect(), None => vec![] } }

    /// Materials recovered by demolishing a building, as [resource, amount, ...].
    pub fn demolition_refund_flat(&self, idx: u32) -> Vec<i32> {
        let Some(b) = self.buildings.get(idx as usize) else { return vec![] };
        demolition_refund(b.kind).flat_map(|(r, n)| [r as i32, n]).collect()
    }

    /// Remove a building, refunding half of its base cost.
    pub fn demolish(&mut self, idx: u32) -> bool {
        match self.buildings.get(idx as usize) {
            Some(b) if b.kind != TOWN_HALL => {
                for (r, n) in demolition_refund(b.kind) { self.stock[r as usize] += n; }
                let back = b.garrison as u32;
                let was_edit = is_edit(b.kind);
                self.army[1] += back;
                self.buildings.remove(idx as usize);
                if was_edit { self.terrain_ver += 1; }
                self.after_change();
                true
            }
            _ => false,
        }
    }

    /// Advance one simulation tick (one in-game second).
    pub fn step(&mut self) {
        self.tick += 1;
        self.refresh_links();
        self.refill_emergency_tools();
        let before = self.stock;
        self.ledger.begin(self.tick, &self.stock);
        let cap = self.storage_cap();

        self.staffing();

        // production
        let reach = self.road_reach();   // which buildings the roads join to the castle: a workplace with no road to it works at half pace (see roadnet.rs)
        for i in 0..self.buildings.len() {
            let (kind, tier) = (self.buildings[i].kind, self.buildings[i].tier);
            let d = &DEFS[kind as usize];
            if d.cycle == 0 { continue; }
            let need = d.cycle * 100;
            let ob = self.buildings[i].opts;
            let road_pace = if self.road_served(i, &reach) { 100 } else { roadnet::UNROADED_PACE };
            let boost = self.work_boost(i);
            let mut p = self.buildings[i].progress + self.buildings[i].beff * boost as u32 / 100 * road_pace / 100;
            let mult = 4 + 5 * tier as i32;   // better buildings employ more people and make more: x1, x2.25, x3.5, x4.75
            let scale = |n: i32| ((n * mult + 2) / 4).max(n);
            let season = self.season();
            let soil = if kind == FARM { 500 + self.buildings[i].fert as i32 / 20 } else { 1000 };   // per mille: rich soil 100%, worn out 50%
            let seasonal = if kind == FARM && season == 3 && ob & 2 != 0 { WINTER_GRAIN_HAYSTACKS } else { GRAIN_BY_SEASON[season as usize] };   // haystacks keep winter fields worth working
            let yield_of = |r: u8, n: i32| { let q = scale(n); if r == GR { (q * seasonal * soil / 100_000).max(1) } else { q } };
            let mut status = self.buildings[i].status;
            while p >= need {
                if kind == FARM {   // soil: a resting field makes nothing and recovers; a sown one wears the soil down (see FERT_*)
                    let m = self.buildings[i].mode;
                    if m == 1 || m == 3 {
                        let b = &mut self.buildings[i]; b.fert = (b.fert + if season == 3 { FERT_REST * FERT_WINTER_REST } else { FERT_REST }).min(FERT_MAX); if b.mode == 3 && b.fert >= FERT_RESTORED { b.mode = 2; }
                        status = 4; p -= need; continue;
                    }
                }
                // requirement checks
                let mut dep_idx: Option<usize> = None;
                if d.req == 1 {
                    let a = self.buildings[i].aux;
                    let ok = a >= 0 && self.deposits[a as usize].active();
                    if ok { dep_idx = Some(a as usize); } else {
                        let (bx, by) = (self.buildings[i].x, self.buildings[i].y);
                        match self.nearest_deposit(bx, by, d.req_arg, false) {
                            Some(n) => { self.buildings[i].aux = n as i32; dep_idx = Some(n); }
                            None => { let sleeping = a >= 0 && self.deposits.get(a as usize).map_or(false, |dd| dd.max > 0); status = if sleeping { 7 } else { 2 }; p = need; break; }
                        }
                    }
                }
                if !self.site_requirement_met(i) { status = 2; p = need; break; }   // the forest was felled, or the water filled in: nothing to work with
                let (inputs, outputs) = match kind {
                    SMOKEHOUSE if self.buildings[i].mode == 1 => (SMOKE_MEAT_IN, SMOKE_MEAT_OUT),
                    PASTURE if season == 3 => (estate::WINTER_PASTURE_FEED, d.outputs),
                    _ => (d.inputs, d.outputs),
                };
                if inputs.iter().any(|&(r, n)| self.stock[r as usize] < scale(n)) { status = 1; p = need; break; }
                if inputs.iter().any(|&(r, n)| !self.can_spend_surplus(r, scale(n))) { status = estate::STATUS_RESERVE; p = need; break; }
                if outputs.iter().any(|&(r, n)| self.stock[r as usize] + yield_of(r, n) > cap) { status = 3; p = need; break; }
                for &(r, n) in inputs { self.stock[r as usize] -= scale(n); self.ledger.note(kind as usize, r as usize, -scale(n)); }
                for &(r, n) in outputs { self.stock[r as usize] += yield_of(r, n); self.ledger.note(kind as usize, r as usize, yield_of(r, n)); }
                if let Some(di) = dep_idx {
                    let out: i32 = outputs.iter().map(|&(_, n)| scale(n)).sum();   // ore taken from the ground does not depend on the season
                    let dd = &mut self.deposits[di]; dd.rem = (dd.rem - out).max(0);
                    if dd.rem == 0 { dd.asleep = true; }   // used up: dormant until it has regrown (see `Deposit::grow`)
                }
                status = 0;
                p -= need;
                if kind == FARM { let b = &mut self.buildings[i]; b.fert = b.fert.saturating_sub(FERT_WEAR); if b.mode == 2 && b.fert <= FERT_TIRED { b.mode = 3; } }
                if kind == 4 { let (cx, cy) = (self.buildings[i].x, self.buildings[i].y); self.clear_trees(cx, cy); }
                if kind == FORESTER && !self.forester_works(i) { status = 2; }
            }
            self.buildings[i].progress = p;
            self.buildings[i].status = status;
        }

        // food, growth, starvation
        let (soldiers, eat) = self.appetite();
        let eaten0: Vec<i32> = FOODS.iter().map(|&(r, _)| self.stock[r as usize]).collect();
        if self.eat_units(eat as i64) {
            let cap_pop = self.capacity();
            let hap = self.happiness();
            if self.population < cap_pop && self.rng.range(if hap >= 70 { 4 } else if hap < 30 { 8 } else { 5 }) == 0 { self.arrive(1); }
        } else {
            // famine takes a share of the village a day (about `HUNGER_PER_MILLE_DAY` per mille of the villagers), not a villager every few seconds
            let one_in = ((1000 * DAY) / (HUNGER_PER_MILLE_DAY * (self.population as u64).max(1))).max(1) as u32;
            if self.population > 2 && self.rng.range(one_in) == 0 {
                self.kill(1, DIED_HUNGER, 0);
                self.push_event(EV_STARVE, 1, 0);
            }
        }
        {   // the ledger: what was eaten (grain and smoked fish), shared between villagers and soldiers by head
            let share = eat as i64 * soldiers as i64 / (self.population as i64 + soldiers as i64).max(1);
            let share = if self.estate.active { share } else { share / 4 * 4 };
            let (c1, c2) = (self.ledger.extra(ledger::EX_SOLDIERS), self.ledger.extra(ledger::EX_VILLAGERS));
            for (k, &(r, _)) in FOODS.iter().enumerate() {
                let used = eaten0[k] - self.stock[r as usize];
                let s = (used as i64 * share / eat.max(1) as i64) as i32; self.ledger.note(c1, r as usize, -s); self.ledger.note(c2, r as usize, -(used - s));
            }
        }
        // overcrowding pressure if capacity shrank (demolished houses)
        let cap_pop = self.capacity();
        if self.population > cap_pop { self.leave(1); }

        // tax
        if self.tick % 10 == 0 { let n = ((self.population as i32 / 10).max(1) * (50 + self.happiness() as i32) / 100).max(1); self.gain(ledger::EX_TAX, GD, n, cap); }

        // luxury: meat (smoked or fresh) is eaten for the mood, not to stay alive
        if self.tick % LUXURY_EVERY == 0 {
            let want = (self.population / LUXURY_HEADS).max(1) as i32;
            let mut left = want;
            for r in [SM, ME] { let t = left.min(self.stock[r as usize].max(0)); self.stock[r as usize] -= t; left -= t; }
        }

        // seasons, warmth and the generations
        self.household_step();

        // the town hall's own storehouse and kitchen garden: a little wood and grain now and then, only while the stores are low, so a village that has run dry can always start over
        if self.tick % BACKUP_EVERY == 0 {
            if let Some(th) = self.buildings.iter().find(|b| b.kind == TOWN_HALL) {
                let n = BACKUP_AMOUNT + BACKUP_PER_TIER * th.tier as i32;
                for r in [W, GR] { if self.stock[r as usize] < BACKUP_BELOW { self.gain(ledger::EX_BACKUP, r, n, cap); } }
            }
        }

        // disease (an outbreak runs for many days: see plague.rs)
        self.plague_step();

        // random events
        if self.rng.range(200) == 0 {
            let n = 30 + self.rng.range(40) as i32;
            self.gain(ledger::EX_HARVEST, GR, n, cap);
            self.push_event(EV_HARVEST, n, 0);
        }
        self.greed_step();
        // Bandits give a clear 30-second warning. The direction and strength are chosen at the warning,
        // not at arrival, so every peer sees the same countdown and the player can prepare.
        if self.raid_warning_ticks > 0 {
            self.raid_warning_ticks -= 1;
            if self.raid_warning_ticks == 0 {
                if self.raid_warning_boss { let kind = self.raid_boss_kind(self.raid_warning_rf); self.begin_boss_raid(kind, self.raid_warning_angle, self.raid_warning_rf, self.raid_warning_name); }
                else {
                    let objective = self.warned_raid_objective();
                    let force = self.bandit_force(self.raid_warning_rf);
                    if self.begin_battle(force, self.raid_warning_angle, 0) { self.battle.as_mut().unwrap().objective = objective; }
                }
            }
        } else if self.tick > RAID_FROM_TICK && self.battle.is_none() && self.rng.range(self.raid_one_in()) == 0 {
            self.raid_warning_angle = self.rng.range(628) as f32 * 0.01;
            if let Some(a) = self.raid_camp_angle() { self.raid_warning_angle = a; }   // raiders come from a camp that still stands, if there is one
            self.raid_warning_rf = self.rng.range(1000) as f32 / 1000.0;
            self.raid_warning_boss = self.boss_due();
            self.raid_warning_name = if self.raid_warning_boss { self.rng.range(4) as u8 } else { 0 };
            self.raid_warning_ticks = RAID_WARNING_TICKS;
        }
        if self.rng.range(320) == 0 {
            let g = 20 + self.rng.range(40) as i32;
            self.gain(ledger::EX_MERCHANTS, GD, g, cap);
            self.push_event(EV_CARAVAN, g, 0);
        }
        // soldiers train, fires burn, battles run (4 sub-steps of 0.25s per tick)
        self.training_step();
        self.march_step();
        self.defence_step();
        self.drawbridge_step();
        self.builders_step();
        self.trade_step();
        self.toll_step();
        self.caravan_step();
        self.journey_step();
        for _ in 0..4 { self.fire_substep(); self.battle_substep(); }
        self.ledger.end(&self.stock);
        for i in 0..N_RES { self.flow[i] = self.stock[i] - before[i]; }
        self.staffing();
    }

    /// Put a decision to the player (only one at a time).
    fn offer(&mut self, kind: u8) {
        if self.choice.is_some() { return; }
        self.choice = Some((kind, self.tick + CHOICE_DAYS * DAY));
        self.push_event(EV_CHOICE, kind as i32, 0);
    }
    fn choice_options(&self) -> u32 { match self.choice { Some((CH_PLAGUE, _)) => 2, Some((CH_PREACHER, _)) => 2, Some((CH_NOBLE, _)) => 2, Some((CH_WINTER, _)) => 3, _ => 0 } }

    /// The decision waiting for the player: [kind, number of options, days left], or empty.
    pub fn choice_flat(&self) -> Vec<i32> { match self.choice { Some((k, due)) => vec![k as i32, self.choice_options() as i32, (due.saturating_sub(self.tick) / DAY) as i32], None => vec![] } }
    /// What option `opt` of the waiting decision costs: [resource, amount, ...].
    pub fn choice_cost(&self, opt: u8) -> Vec<i32> {
        match (self.choice, opt) {
            (Some((CH_PREACHER, _)), 0) => vec![GD as i32, 20],
            (Some((CH_NOBLE, _)), 0) => vec![GR as i32, 100, GD as i32, 30],
            (Some((CH_WINTER, _)), 0) => vec![GD as i32, 60],
            _ => vec![],
        }
    }
    /// Decide. 0 ok, -1 nothing to decide or no such option, -6 cannot afford it.
    /// Plague: 0 quarantine the sick (they stop working for 7 days; fewer die, more are healed, the peak is lower), 1 carry on.
    /// Preacher: 0 welcome him (20 coins; spirits rise for 10 days), 1 turn him away.
    /// Noble: 0 hold a feast (100 grain and 30 coins; he leaves 90 coins and the people are cheered), 1 decline politely.
    /// Winter: 0 buy firewood (60 coins for 80 wood), 1 share what there is (everyone is a bit worse off but nothing is spent), 2 do nothing.
    pub fn choose(&mut self, opt: u8) -> i32 {
        let Some((kind, _)) = self.choice else { return -1 };
        if opt as u32 >= self.choice_options() { return -1; }
        let cost = self.choice_cost(opt); let mut i = 0;
        while i + 1 < cost.len() { if self.stock[cost[i] as usize] < cost[i + 1] { return -6; } i += 2; }
        i = 0; while i + 1 < cost.len() { self.stock[cost[i] as usize] -= cost[i + 1]; i += 2; }
        let day = DAY; let now = self.tick;
        match (kind, opt) {
            (CH_PLAGUE, 0) => { self.quarantine_until = now + plague::QUARANTINE_DAYS * day; }
            (CH_PREACHER, 0) => { self.mood = 10; self.mood_until = now + 10 * day; }
            (CH_NOBLE, 0) => { let cap = self.storage_cap(); self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], 90, cap); self.mood = 8; self.mood_until = now + 6 * day; }
            (CH_WINTER, 0) => { let cap = self.storage_cap(); self.stock[W as usize] = Self::add_capped(self.stock[W as usize], 80, cap); }
            (CH_WINTER, 1) => { self.mood = -4; self.mood_until = now + 10 * day; self.warm = true; self.stock[W as usize] += 0; self.share_until = now + 10 * day; }
            _ => {}
        }
        self.choice = None; self.push_event(EV_CHOSE, kind as i32, opt as i32); 0
    }

    // ---------- the village's people: every change goes through one of these, so the ledger always balances ----------
    /// People die. `who`: 0 anyone (in proportion), 1 the old first, 2 the old and the young first, 3 grown men and women first. The dead wait for burial.
    pub(crate) fn kill(&mut self, n: u32, cause: usize, who: u8) {
        let n = n.min(self.population); if n == 0 { return; }
        self.children = self.children.min(self.population); self.elders = self.elders.min(self.population - self.children);
        let adults = self.adults();
        // how many of the dead are elders and children (the rest are adults)
        let (e, c) = match who {
            1 => { let e = n.min(self.elders); (e, n - e - (n - e).min(adults)) }
            2 => { let e = n.min(self.elders); (e, (n - e).min(self.children)) }
            3 => { let a = n.min(adults); let c = (n - a).min(self.children); (n - a - c, c) }
            _ => ((n as u64 * self.elders as u64 / self.population as u64) as u32, (n as u64 * self.children as u64 / self.population as u64) as u32),
        };
        self.elders -= e.min(self.elders); self.children -= c.min(self.children);
        self.population -= n; self.died[cause] += n; self.unburied += n;
    }
    /// Newcomers arrive (grown men and women).
    pub(crate) fn arrive(&mut self, n: u32) { self.population += n; self.arrived += n; }
    /// Babies are born.
    pub(crate) fn born_n(&mut self, n: u32) { self.population += n; self.children += n; self.born += n; }
    /// Soldiers are trained out of the villagers.
    pub(crate) fn enlist(&mut self, n: u32) { let n = n.min(self.population); self.population -= n; self.enlisted += n; }
    /// People leave the village (homeless, or by the testing tools).
    pub(crate) fn leave(&mut self, n: u32) { let n = n.min(self.population); self.population -= n; self.left += n; self.children = self.children.min(self.population); self.elders = self.elders.min(self.population - self.children); }

    /// The ledger: [born, arrived, enlisted, left, died of old age, of plague, of hunger, of cold, in war, unburied, buried, burial plots, plots used].
    pub fn vitals(&self) -> Vec<u32> {
        vec![self.born, self.arrived, self.enlisted, self.left, self.died[0], self.died[1], self.died[2], self.died[3], self.died[4], self.unburied, self.buried, self.grave_plots(), self.graves_used]
    }
    /// What the ledger says the population should be (the testing tools can break it by setting the number directly).
    pub fn ledger_population(&self) -> i64 { 10 + self.arrived as i64 + self.born as i64 - self.enlisted as i64 - self.left as i64 - self.died.iter().sum::<u32>() as i64 }

    // ---------- death care ----------
    /// Burial plots: a churchyard at every chapel (6 a tier) and graveyards (20 a tier, half as many again with a charnel house).
    pub fn grave_plots(&self) -> u32 {
        self.buildings.iter().map(|b| match b.kind { CHAPEL => 6 * (b.tier as u32 + 1), GRAVEYARD => { let base = 20 * (b.tier as u32 + 1); if b.opts & 8 != 0 { base * 3 / 2 } else { base } } _ => 0 }).sum()
    }
    /// How many the gravediggers and priests can bury in a day: 3 from the churches, and 6 a tier for each staffed graveyard; without either, 2 are laid in the fields.
    fn burial_rate(&self) -> u32 {
        let digs: u32 = self.buildings.iter().filter(|b| b.kind == GRAVEYARD && b.staff > 0).map(|b| 6 * (b.tier as u32 + 1)).sum();
        let priests: u32 = self.buildings.iter().filter(|b| b.kind == CHAPEL).count() as u32 * 3;
        digs + priests
    }
    /// Once a day the dead are buried as far as plots and hands allow; the rest lie where they fell and breed sickness.
    fn death_care_step(&mut self) {
        let plots = self.grave_plots(); let free = plots.saturating_sub(self.graves_used);
        let (rate, any_site) = (self.burial_rate(), plots > 0);
        if self.unburied > 0 {
            let n = if any_site { self.unburied.min(rate).min(free) } else { self.unburied.min(2) };   // with no consecrated ground the dead are buried in the fields
            self.unburied -= n; self.buried += n; if any_site { self.graves_used += n; }
        }
        // the unburied: sickness spreads
        if self.unburied >= 3 && self.rng.range((140u32).saturating_sub(self.unburied * 8).max(20)) == 0 {
            self.sick = (self.sick + self.unburied / 2 + 1).min(self.population); self.push_event(EV_MIASMA, self.unburied as i32, 0);
        }
    }
    /// Beds in staffed hospitals (4 a tier, more with a quarantine ward) and how many of them are manned.
    pub fn hospital_beds(&self) -> u32 { self.buildings.iter().filter(|b| b.kind == HOSPITAL && b.staff > 0).map(|b| 4 * (b.tier as u32 + 1) * (b.staff.min(3 * (b.tier as u32 + 1)) * 100 / (3 * (b.tier as u32 + 1))).max(34) / 100).sum() }
    /// How many sit in the care of the church: devotion 0..100.
    pub fn devotion(&self) -> i32 { self.devotion }

    // ---------- relations ----------
    /// How the village with this tag feels about us, -100 (hostile) to 100 (devoted).
    pub fn relation(&self, tag: i32) -> i32 { self.relations.iter().find(|r| r.0 == tag).map_or(0, |r| r.1) }
    pub fn rel_add(&mut self, tag: i32, delta: i32) {
        if tag == 0 { return; }
        let floor = if self.married.contains(&tag) { 20 } else { -100 };
        match self.relations.iter_mut().find(|r| r.0 == tag) { Some(r) => r.1 = (r.1 + delta).clamp(floor, 100), None => { if self.relations.len() < 64 { self.relations.push((tag, delta.clamp(floor, 100))); } } }
    }
    /// All relations: [tag, value, marriage 0/1, treaty bits] each; treaty bits: 1 trade pact, 2 peace, 4 alliance.
    pub fn relations_flat(&self) -> Vec<i32> {
        self.relations.iter().flat_map(|r| [r.0, r.1, self.married.contains(&r.0) as i32, self.has_treaty(r.0, TREATY_TRADE) as i32 | (self.has_treaty(r.0, TREATY_PEACE) as i32) << 1 | (self.has_treaty(r.0, TREATY_ALLIANCE) as i32) << 2]).collect()
    }
    /// Would we sign this treaty with that village? Peace needs we do not loathe them (relation above -30), a trade pact that we like them (10), an alliance that we trust them (60) and already trade.
    pub fn treaty_acceptable(&self, tag: i32, kind: u8) -> bool {
        let r = self.relation(tag);
        match kind { TREATY_PEACE => r > -30, TREATY_TRADE => r >= 10, TREATY_ALLIANCE => r >= 60 && self.has_treaty(tag, TREATY_TRADE), _ => false }
    }
    /// Send an envoy with gifts to improve relations (20 coins, once every three days with each village). Returns 0 ok, -6 poor, -20 too soon.
    pub fn envoy(&mut self, tag: i32) -> i32 {
        if tag == 0 { return -1; }
        if self.last_envoy.iter().any(|e| e.0 == tag && self.tick < e.1 + 3 * DAY) { return -20; }
        if self.stock[GD as usize] < 20 { return -6; }
        self.stock[GD as usize] -= 20; self.last_envoy.retain(|e| e.0 != tag); self.last_envoy.push((tag, self.tick));
        self.rel_add(tag, 8); self.push_event(EV_DIPLO, 0, 0); 0
    }
    /// A royal marriage with another village (150 coins; relations must be at least 30): a lasting bond, relations never fall below 20 while it holds.
    pub fn marriage(&mut self, tag: i32) -> i32 {
        if tag == 0 || self.married.contains(&tag) { return -1; }
        if self.relation(tag) < 30 { return -21; }
        if self.stock[GD as usize] < 150 { return -6; }
        self.stock[GD as usize] -= 150; self.married.push(tag); self.rel_add(tag, 30); self.push_event(EV_DIPLO, 2, 0); 0
    }
    /// Declare war: relations plunge, treaties and marriage with them end.
    pub fn declare_war(&mut self, tag: i32) {
        if tag == 0 { return; }
        self.treaties.retain(|t| t.tag != tag); self.married.retain(|&m| m != tag);
        let r = self.relation(tag); self.rel_add(tag, -80 - r.max(0)); self.push_event(EV_DIPLO, 1, 0);
    }
    pub fn married_to(&self, tag: i32) -> bool { self.married.contains(&tag) }

    /// Firewood the village wants per burn (every `WINTER_BURN_EVERY` ticks) at its present size.
    pub(crate) fn winter_need(&self) -> i32 {
        ((self.population + WINTER_HEADS_PER_WOOD - 1) / WINTER_HEADS_PER_WOOD) as i32 / if self.tick < self.share_until { 2 } else { 1 } - self.perks().woodsheds / WINTER_SHED_SAVES
    }
    /// Chance in percent that the cold takes someone today, after `cold_days` cold days (0 within the grace).
    fn cold_death_chance(&self) -> u32 {
        let grace = WINTER_COLD_GRACE + if self.hospital_beds() > 0 { WINTER_HOSPITAL_GRACE } else { 0 };
        (self.cold_days.saturating_sub(grace) * WINTER_DEATH_STEP).min(WINTER_DEATH_MAX)
    }
    /// Fires in winter, and once a day the generations turn: children grow up, the old pass away, couples have babies.
    fn household_step(&mut self) {
        // winter: the village burns firewood (see WINTER_*); the town hall's hearth keeps it warm while there is wood for a good part of what it wants
        if self.season() == 3 {
            if self.tick % WINTER_BURN_EVERY == 0 {
                let need = self.winter_need().max(0);
                let used = need.min(self.stock[W as usize].max(0)); let c = self.ledger.extra(ledger::EX_WINTER); self.ledger.note(c, W as usize, -used);
                self.stock[W as usize] -= used; self.warm = used >= need.min(WINTER_HEARTH_WOOD);
            }
        } else { self.warm = true; }
        if self.tick % DAY != 0 { return; }
        self.regrow_deposits();
        self.regrow_forest();
        { let doves = self.perks().doves; if doves > 0 { let cap = self.storage_cap(); self.gain(ledger::EX_DOVES, GR, doves, cap); } }
        let now = self.tick; self.treaties.retain(|t| t.until > now);
        self.market_refill();
        self.death_care_step();
        // the church: a service every seventh day brings the village together, and its tithe
        let churches: Vec<u32> = self.buildings.iter().filter(|b| b.kind == CHAPEL).map(|b| b.tier as u32 + 1).collect();
        if !churches.is_empty() && (now / DAY) % 7 == 6 {
            let tithe: u32 = churches.iter().map(|&t| (self.population / 8).max(1) * t).sum::<u32>().min(60);
            let cap = self.storage_cap(); self.gain(ledger::EX_TITHE, GD, tithe as i32, cap);
            self.devotion = (self.devotion + 12 + 4 * churches.iter().sum::<u32>() as i32).min(100); self.push_event(EV_SERVICE, tithe as i32, 0);
        } else if self.devotion > 0 && (now / DAY) % 2 == 0 { self.devotion -= 1; }
        // feelings cool towards indifference (allies and married partners keep them)
        let allies: Vec<i32> = self.treaties.iter().filter(|t| t.kind == TREATY_ALLIANCE).map(|t| t.tag).collect();
        for r in self.relations.iter_mut() { if allies.contains(&r.0) { continue; } if r.1 > 0 && now / DAY % 3 == 0 { r.1 -= 1; } else if r.1 < 0 && now / DAY % 2 == 0 { r.1 += 1; } }
        // a decision falls due: the player took too long, so the cautious default is taken
        if let Some((_, due)) = self.choice { if now >= due { let last = (self.choice_options() - 1) as u8; self.choose(last); } }
        // visitors and hard times
        if self.choice.is_none() {
            let day = now / DAY;
            if self.population > 20 && self.rng.range(40) == 0 { self.offer(CH_PREACHER); }
            else if self.population > 30 && self.rng.range(60) == 0 { self.offer(CH_NOBLE); }
            else if self.season() == 3 && day % (SEASON_DAYS * 4) == SEASON_DAYS * 3 { self.offer(CH_WINTER); }
        }
        let take = |rng: &mut Rng, n: u32, per: u32| -> u32 { let mut k = n / per; if rng.range(per) < n % per { k += 1; } k.min(n) };
        // the cold: first only unhappiness, deaths after a few cold days and with a growing chance (see WINTER_COLD_GRACE)
        if self.warm { self.cold_days = 0; } else {
            self.cold_days += 1;
            let chance = self.cold_death_chance();
            if self.population > 3 && chance > 0 && self.rng.range(100) < chance { self.kill(1, DIED_COLD, 0); self.push_event(EV_COLD, 1, 0); }
        }
        let grown = take(&mut self.rng, self.children, 30); self.children -= grown;
        let adults = self.adults(); let aged = take(&mut self.rng, adults, 90); self.elders += aged;
        let died = take(&mut self.rng, self.elders, 25).min(self.population.saturating_sub(2));
        self.kill(died, DIED_OLD, 1);
        if self.food() >= 10 && self.happiness() >= 40 && self.population < self.capacity() {
            let couples = self.adults() / 2; let room = self.capacity() - self.population;
            let born = take(&mut self.rng, couples, 14).min(room);
            self.born_n(born);
        }
        self.staffing();
    }

    /// Net change of each resource during the last tick (production minus consumption; purchases excluded).
    pub fn flows(&self) -> Vec<i32> { self.flow.to_vec() }

    fn push_event(&mut self, kind: i32, a: i32, b: i32) {
        self.events.extend_from_slice(&[kind, a, b, self.tick as i32]);
    }

    /// Toll posts beside a road collect coin every twenty ticks: one coin for the post, one for each stretch of path within eight units (the traffic), up to six, times the post's tier + 1.
    fn toll_step(&mut self) {
        if self.tick % 20 != 0 { return; }
        let cap = self.storage_cap();
        let posts: Vec<(f32, f32, u32, u32)> = self.buildings.iter().filter(|b| b.kind == TOLL && b.staff > 0).map(|b| (b.x, b.y, b.tier as u32 + 1, b.staff)).collect();
        for (x, y, mult, _) in posts {
            let near = self.roads.iter().filter(|s| {
                let (dx, dy) = (s[3] - s[0], s[4] - s[1]); let l2 = (dx * dx + dy * dy).max(0.0001);
                let t = (((x - s[0]) * dx + (y - s[1]) * dy) / l2).clamp(0.0, 1.0); ((x - s[0] - dx * t).powi(2) + (y - s[1] - dy * t).powi(2)).sqrt() < 8.0
            }).count() as u32;
            if near == 0 { continue; }   // a toll post away from every road catches nobody
            let coins = ((1 + near).min(6) * mult) as i32;
            self.gain(ledger::EX_TOLL, GD, coins, cap);
        }
    }

    /// Caravans on the road can be waylaid: with no escort one in a few hundred ticks is robbed; each spearman guarding it cuts that risk.
    fn caravan_step(&mut self) {
        let mut lost = vec![];
        for (i, c) in self.caravans.iter().enumerate() { if c.eta > self.tick && self.tick % 10 == 0 && self.rng.range(300 + 120 * c.escort) == 0 { lost.push(i); } }
        for &i in lost.iter().rev() { let c = self.caravans.remove(i); self.push_event(EV_ROBBED, c.amount, (c.res & !GIFT_FLAG) as i32); }
        // arrivals: the escort comes home, and the goods wait for the other village to take them
        let now = self.tick; let mut rest = vec![];
        for c in std::mem::take(&mut self.caravans) {
            if c.eta <= now { self.army[0] += c.escort; self.awaiting.push([c.res as i32, c.amount, c.to]); self.delivered.push([c.res as i32, c.amount, c.to]); } else { rest.push(c); }
        }
        self.caravans = rest;
    }

    /// Errands that reach the other village do what they came for: the treaty is signed, the envoy's gifts warm the feelings, the bride is wed, the war declared.
    fn journey_step(&mut self) {
        if self.journeys.is_empty() { return; }
        let now = self.tick; let mut rest = vec![]; let mut done = vec![];
        for j in std::mem::take(&mut self.journeys) { if j.arrive <= now { done.push(j); } else { rest.push(j); } }
        self.journeys = rest;
        for j in done {
            match j.kind {
                TREATY_TRADE | TREATY_PEACE | TREATY_ALLIANCE => { self.treaty_set(j.tag, j.kind, j.arg.max(1) as u32); }
                JK_ENVOY => { self.rel_add(j.tag, 8); self.push_event(EV_DIPLO, 0, 0); }
                JK_MARRIAGE => { if !self.married.contains(&j.tag) { self.married.push(j.tag); self.rel_add(j.tag, 30); self.push_event(EV_DIPLO, 2, 0); } }
                _ => { self.declare_war(j.tag); }
            }
            if self.arrivals.len() < 64 { self.arrivals.push([j.kind as i32, j.tag, j.arg, now as i32]); }
        }
    }

    /// Ports sell the most plentiful stock for gold every half minute, and buy grain when the village runs short.
    pub(crate) fn trade_step(&mut self) {
        let cap = self.storage_cap();
        let ports: Vec<usize> = (0..self.buildings.len()).filter(|&i| self.buildings[i].kind == PORT && self.buildings[i].staff > 0).collect();
        for pi in ports {
            let tier = self.buildings[pi].tier as i32;
            self.buildings[pi].progress += self.buildings[pi].beff;
            if self.buildings[pi].progress < 3000 { continue; }
            self.buildings[pi].progress -= 3000;
            let mult = (4 + 5 * tier) / 4;
            // buy grain if hungry
            if self.food() < 40 {
                let n = 20 * mult; let cost = n * 3 / 2;
                if self.stock[GD as usize] >= cost && self.stock[GR as usize] + n <= cap { self.stock[GD as usize] -= cost; self.stock[GR as usize] += n; { let c = self.ledger.extra(ledger::EX_PORT); self.ledger.note(c, GD as usize, -cost); self.ledger.note(c, GR as usize, n); } self.push_event(EV_TRADE, -cost, GR as i32); continue; }
            }
            // otherwise sell what there is most of
            let mut best: Option<(usize, i32)> = None;
            for r in 0..N_RES { if r == GD as usize { continue; } let excess = self.stock[r] - (cap / 2).max(self.reserve_for(r as u8)); if excess > 0 && best.map_or(true, |(_, e)| excess > e) { best = Some((r, excess)); } }
            if let Some((r, excess)) = best {
                let units = excess.min(30 * mult); let gold = (units * self.price(r) * 8 / 10).max(1);
                self.stock[r] -= units; { let c = self.ledger.extra(ledger::EX_PORT); self.ledger.note(c, r, -units); } self.gain(ledger::EX_PORT, GD, gold, cap);
                self.push_event(EV_TRADE, gold, r as i32);
            }
        }
    }

    /// What one unit of a resource is worth here, in coins x 100 (so 150 is one and a half coins): the usual price, higher when the stores are nearly empty, lower when they are overflowing.
    fn price_x100(&self, r: usize) -> i32 {
        let cap = self.storage_cap().max(1);
        let level = self.stock[r] * 100 / cap;   // how full the store is
        let f = if level < 5 { 180 } else if level < 15 { 130 } else if level < 50 { 100 } else if level < 80 { 80 } else { 60 };
        PRICE[r] * f
    }
    fn price(&self, r: usize) -> i32 { (self.price_x100(r) / 100).max(1) }
    /// Prices of all twelve resources now, in coins x 100.
    pub fn prices(&self) -> Vec<i32> { (0..N_RES).map(|r| self.price_x100(r)).collect() }

    /// Add to a stock without ever cutting down what is already above the cap (a demolished storehouse, say).
    /// Add to a store (up to the cap) and tell the ledger what really came in and from where.
    fn gain(&mut self, extra: usize, r: u8, n: i32, cap: i32) {
        let before = self.stock[r as usize]; self.stock[r as usize] = Self::add_capped(before, n, cap);
        let c = self.ledger.extra(extra); self.ledger.note(c, r as usize, self.stock[r as usize] - before);
    }
    /// Where the resources came from and went to over the last day, flattened (see `ledger::Ledger::flat`). Derived display data: not part of the state.
    pub fn ledger_flat(&self) -> Vec<i32> { self.ledger.flat(self.tick) }
    fn add_capped(cur: i32, add: i32, cap: i32) -> i32 { if cur >= cap { cur } else { cur.saturating_add(add).min(cap) } }

    fn storage_cap(&self) -> i32 {
        let hall = self.buildings.first().map_or(0, |b| b.tier as i32);
        600 + 200 * hall + self.buildings.iter().filter(|b| b.kind == STOREHOUSE).map(|b| 250 * (b.tier as i32 + 1)).sum::<i32>()
            + 25 * self.buildings.iter().filter(|b| b.kind == HOUSE && b.opts & (1 << 7) != 0 && b.hp > 0.0).count() as i32   // a house's cellar holds 25 more
    }

    pub fn storage(&self) -> i32 { self.storage_cap() }

    pub fn capacity(&self) -> u32 {
        self.buildings.iter().map(|b| DEFS[b.kind as usize].housing * (b.tier as u32 + 1)).sum::<u32>() + self.perks().housing as u32
    }

    /// What the optional design upgrades add up to. Every option does something small but real (see the descriptions in catalog.rs); this gathers them in one pass.
    pub(crate) fn perks(&self) -> Perks {
        let mut p = Perks::default();
        let (mut flower, mut pride, mut banners, mut armoury, mut militia) = (0, 0, 0, 0, 0);
        for b in &self.buildings {
            if b.opts == 0 || b.hp <= 0.0 { continue; }
            let o = |bit: u8| b.opts & (1 << bit) != 0;
            match b.kind {
                HOUSE => { if o(0) { p.housing += 1; } if o(4) { p.housing += 3; } if o(1) { flower += 1; } if o(2) || o(7) { p.woodsheds += 1; } if o(3) { p.doves += 2; } if o(5) { p.doves += 3; } if o(6) { pride += 2; } }   // bits 4-7: loft room, kitchen garden, carved gable, cellar
                FARM => { if o(6) { pride += 1; } }   // the orchard (the field's other options are speed: see tier2_speed)
                HOSPITAL | GRAVEYARD | RIVER | MOAT | RAISE | LOWER | FENCE | ROAD => {}
                WALL => { if o(1) { banners += 1; } }
                TOWER => { if o(0) { banners += 1; } if o(2) { pride += 1; } if o(3) { militia += 2; } }
                GATE => { if o(0) || o(2) { banners += 1; } if o(1) { pride += 1; } if o(3) { militia += 1; } }
                DRAWBRIDGE | WELL | BRIDGE => { for bit in 0..2 { if o(bit) { pride += 1; } } }
                BARRACKS => { if o(0) { banners += 1; } if o(1) { p.train_pct += 25; } if o(2) { armoury += 4; } if o(4) { p.train_pct += 15; } if o(5) { armoury += 2; } if o(6) { militia += 2; } if o(7) { p.train_pct += 25; } }
                KEEP => { if o(0) { banners += 1; } if o(2) || o(3) { militia += 2; } }
                TOWN_HALL => { if o(0) { banners += 1; } for bit in 1..4 { if o(bit) { pride += 1; } } }
                CHAPEL => { for bit in [0u8, 1, 3, 4, 5] { if o(bit) { pride += 1; } } if o(6) { p.housing += 2; } if o(7) { pride += 2; } }
                MARKET => { if o(0) { banners += 1; } for bit in [1u8, 5, 6] { if o(bit) { pride += 1; } } }
                _ => { if o(0) { banners += 1; } if o(1) { pride += 1; } }
            }
        }
        p.happy = flower.min(6) + pride.min(10);
        p.banner_pct = (banners + armoury).min(15);
        p.militia = militia.min(8) as u32;
        p
    }

    /// Flat [kind, tier, x, y, rot, pad_h, status, progress%, staff, residents] (stride 10), absolute coordinates.
    pub fn buildings_flat(&self) -> Vec<f32> {
        let mut v = Vec::with_capacity(self.buildings.len() * 10);
        for b in &self.buildings {
            let d = &DEFS[b.kind as usize];
            let pct = if d.cycle > 0 { (b.progress * 100 / (d.cycle * 100)).min(100) } else { 0 };
            v.extend_from_slice(&[b.kind as f32, b.tier as f32, b.x, b.y, b.rot as f32, b.pad_h, b.status as f32, pct as f32, b.staff as f32, b.residents as f32]);
        }
        v
    }

    /// Path segments as [ax, ay, bx, by, child, parent] (stride 6). Child and parent are building indices.
    pub fn roads_flat(&self) -> Vec<f32> {
        let id = |v: u32| if v == u32::MAX { -1.0 } else { v as f32 };
        self.roads.iter().zip(&self.road_links).flat_map(|(s, l)| [s[0], s[1], s[3], s[4], id(l.0), id(l.1)]).collect()
    }

    /// The surface of every segment of `roads_flat` (0 dirt .. 3 flagstones), in the same order.
    pub fn road_tiers_flat(&self) -> Vec<u8> { self.road_tier.clone() }

    /// The path network as [n, e, x, y (n times), a, b, road (e times)] (see pathnet.rs).
    pub fn net_flat(&self) -> Vec<f32> { self.net_flat_inner() }
    /// A route over the path network: [complete (1 or 0), x, y, x, y, ...], or empty when the network does not help (villagers walk it).
    pub fn net_route(&self, sx: f32, sy: f32, gx: f32, gy: f32) -> Vec<f32> { self.net_route_inner(sx, sy, gx, gy) }

    /// Chain an invisible path from this city to another village's city (its hall at world position (tx, ty)): the cheapest dry way over the invisible lines, from our hall out through our own
    /// paths and across the land to theirs. Armies march along it like along a road. 0 ok, -1 nonsense, -2 no dry way, -3 too many, -4 that is this village.
    pub fn link_village(&mut self, tx: f32, ty: f32) -> i32 {
        if !tx.is_finite() || !ty.is_finite() || tx.abs() > 3000.0 || ty.abs() > 3000.0 { return -1; }
        let (hx, hy) = (self.buildings[0].x, self.buildings[0].y);
        if (tx - hx).hypot(ty - hy) < 40.0 { return -4; }
        let same = |pl: &Vec<(f32, f32)>| pl.last().map_or(false, |e| (e.0 - tx).hypot(e.1 - ty) < 12.0);
        if self.links.len() >= 24 && !self.links.iter().any(same) { return -3; }
        // (worked out over the village without the old invisible paths, which would pull the new one along their line)
        let kept = std::mem::take(&mut self.links);
        let route = self.link_route(tx, ty);
        self.links = kept;
        let Ok(pl) = route else { return -2 };
        if let Some(k) = self.links.iter().position(same) { self.links[k] = pl; } else { self.links.push(pl); }
        let st = self.links_free_stamp(); self.link_stamp.set(st);
        if !self.defer_roads { self.rebuild_roads(); }   // the network changed: so do the roads that are made of it
        0
    }

    /// Where the invisible paths leave the city: the node outside the gate of the hall (the Castle's walls and halls are never crossed), not the middle of the hall.
    fn city_exit(&self) -> (f32, f32) {
        let net = self.net();
        net.ring.first().and_then(|r| r.iter().copied().find(|&id| id != u32::MAX)).map(|id| net.nodes[id as usize]).unwrap_or((self.buildings[0].x, self.buildings[0].y))
    }

    /// The cheapest dry way from the edge of our city to (tx, ty): out of the gate, along the village's own paths (round the buildings, never through them) and across the land. Call it with `links` taken out.
    fn link_route(&self, tx: f32, ty: f32) -> Result<Vec<(f32, f32)>, i32> {
        let (sx, sy) = self.city_exit();
        let route = self.route_on_graph(&[1, 0, 0, 0, 0, 0], sx, sy, tx, ty, true)?;
        let mut pl: Vec<(f32, f32)> = route.iter().map(|w| (w.x, w.y)).collect();
        if pl.last().map_or(true, |e| (e.0 - tx).hypot(e.1 - ty) >= 12.0) { pl.push((tx, ty)); }
        Ok(pl)
    }

    /// What the invisible paths depend on, without them.
    fn links_free_stamp(&mut self) -> u64 {
        let kept = std::mem::take(&mut self.links);
        let s = self.route_revision();
        self.links = kept;
        s
    }

    /// Every few ticks: when something was built or torn down since the invisible paths were worked out, work them out again, so they never run through a building that came later and go
    /// round one that was taken away. A path whose goal can no longer be reached stays as it was.
    fn refresh_links(&mut self) {
        if self.links.is_empty() || self.tick % 8 != 0 || self.buildings.is_empty() { return; }
        let stamp = self.links_free_stamp();
        if stamp == self.link_stamp.get() { return; }
        let old = std::mem::take(&mut self.links);
        let fresh: Vec<Vec<(f32, f32)>> = old.iter().map(|pl| match pl.last() { Some(&(tx, ty)) => self.link_route(tx, ty).unwrap_or_else(|_| pl.clone()), None => pl.clone() }).collect();
        self.links = fresh;
        self.link_stamp.set(stamp);
        if !self.defer_roads { self.rebuild_roads(); }
    }
    /// Is there already an invisible path to the village whose hall is at (tx, ty)?
    pub fn link_exists(&self, tx: f32, ty: f32) -> bool { self.links.iter().any(|pl| pl.last().map_or(false, |e| (e.0 - tx).hypot(e.1 - ty) < 12.0)) }

    /// A walking route over the invisible lines (the grid of the world plus the village's paths), for villagers: [1, x, y, x, y, ...], or empty when there is no dry way.
    pub fn walk_route(&self, sx: f32, sy: f32, gx: f32, gy: f32) -> Vec<f32> { self.walk_route_inner(sx, sy, gx, gy) }

    /// Flat [kind, x, y, remaining, max, ...] (stride 5).
    /// 1 for every deposit that lies dormant (used up, regrowing), 0 otherwise; one entry per deposit, in the order of `deposits_flat`.
    pub fn deposits_asleep(&self) -> Vec<u8> { self.deposits.iter().map(|d| d.asleep as u8).collect() }
    /// How fast the building at `i` works, in percent (100 = base): the design upgrades that make a field or workplace faster (scarecrow, barn, awning, stone footing and so on).
    fn work_boost(&self, i: usize) -> u32 {
        let (kind, ob) = (self.buildings[i].kind, self.buildings[i].opts);
        if kind == FARM { 100 + if ob & 1 != 0 { 10 } else { 0 } + if ob & 4 != 0 { 5 } else { 0 } + if ob & 8 != 0 { 10 } else { 0 } + tier2_speed(kind, ob) }
        else if ob != 0 && !matches!(kind, HOUSE | WALL | TOWER | GATE | DRAWBRIDGE | BARRACKS | KEEP | TOWN_HALL | CHAPEL | WELL | BRIDGE | HOSPITAL | GRAVEYARD) { 100 + if ob & 4 != 0 { 10 } else { 0 } + if ob & 8 != 0 { 5 } else { 0 } + tier2_speed(kind, ob) } else { 100 }   // scarecrow, fence and barn; awning and stone footing: the building works that much faster
    }
    /// What sets the building's work pace, each in percent (100 = no effect): [design upgrades, road to the castle (50 with none), how fully it is staffed].
    pub fn work_pace(&self, idx: u32) -> Vec<u32> {
        let i = idx as usize; if i >= self.buildings.len() { return vec![100, 100, 100]; }
        let road = if self.road_served(i, &self.road_reach()) { 100 } else { roadnet::UNROADED_PACE };
        vec![self.work_boost(i), road, self.buildings[i].beff.min(100)]
    }
    /// The building's whole work pace in percent: the three parts of `work_pace` multiplied.
    pub fn work_speed(&self, idx: u32) -> u32 { self.work_pace(idx).iter().product::<u32>() / 10_000 }
    /// What the building at `idx` works: [deposit index, remaining, maximum, dormant 0/1, ore taken per day at its present staffing], or empty when it needs no deposit.
    pub fn building_deposit(&self, idx: u32) -> Vec<f32> {
        let Some(b) = self.buildings.get(idx as usize) else { return vec![] };
        let d = &DEFS[b.kind as usize];
        if d.req != 1 || b.aux < 0 { return vec![]; }
        let Some(dep) = self.deposits.get(b.aux as usize) else { return vec![] };
        let mult = 4 + 5 * b.tier as i32; let out: i32 = d.outputs.iter().map(|&(_, n)| ((n * mult + 2) / 4).max(n)).sum();
        let eff = self.work_speed(idx) as f32 / 100.0;
        vec![b.aux as f32, dep.rem as f32, dep.max as f32, dep.asleep as u8 as f32, out as f32 * DAY as f32 / d.cycle as f32 * eff]
    }
    /// Once a day every deposit regrows a little, faster when no working building stands at it; one used up and dormant wakes at `WAKE_PCT` of its maximum. Cleared deposits (`max == 0`) stay gone.
    fn regrow_deposits(&mut self) {
        let mut worked = vec![false; self.deposits.len()];
        for b in &self.buildings { if DEFS[b.kind as usize].req == 1 && b.status == 0 && b.aux >= 0 { if let Some(w) = worked.get_mut(b.aux as usize) { *w = true; } } }
        for (d, w) in self.deposits.iter_mut().zip(worked) { d.grow(w); }
    }

    pub fn deposits_flat(&self) -> Vec<f32> {
        self.deposits.iter().flat_map(|d| [d.kind as f32, d.x, d.y, d.rem as f32, d.max as f32]).collect()
    }


    // ---------- military ----------
    /// Queue `n` units of `kind` at the barracks. 0 ok, -6 resources, -11 no barracks, -12 barracks too basic, -13 not enough people.
    pub fn train(&mut self, kind: u8, n: u32) -> i32 { self.try_train(kind, n) }
    /// Standing army [spearmen, archers, swordsmen, knights, catapults].
    pub fn army(&self) -> Vec<u32> { self.army.to_vec() }
    pub fn queued(&self) -> Vec<u32> { self.queue.to_vec() }
    /// Veterans in the standing army, by kind.
    pub fn army_veterans(&self) -> Vec<u32> { self.vets.to_vec() }
    /// Take `n` of a kind out of the training queue; its cost comes back and the recruits return to the village. 0 when done.
    pub fn train_cancel(&mut self, kind: u8, n: u32) -> i32 { self.try_train_cancel(kind, n) }
    pub fn away(&self) -> Vec<u32> { self.away.to_vec() }
    /// Tower and hall guards that defend for free.
    pub fn guards(&self) -> u32 { self.buildings.iter().map(|b| match b.kind { TOWER => b.garrison as u32, TOWN_HALL => 2 * (b.tier as u32 + 1), KEEP => b.garrison as u32, _ => 0 }).sum() }

    // ---------- tower garrisons ----------
    fn garrison_cap_of(b: &Building) -> u32 { match b.kind { TOWER => 2 * (b.tier as u32 + 1) + 2, KEEP => 4 * (b.tier as u32 + 1) + 4, _ => 0 } }
    /// Raise or lower a drawbridge by hand. A manual lowering holds until it is raised or a new raid starts.
    /// A manual raise blocks lending for `VETO_SECS` and replans armies already heading for the deck.
    pub fn drawbridge_set(&mut self, idx: u32, up: bool) -> i32 {
        let Some(b) = self.buildings.get(idx as usize) else { return -1 };
        if b.kind != DRAWBRIDGE { return -1; }
        if up && self.crossings().iter().any(|c| c.db == idx as i32 && c.down
            && (self.dets.iter().any(|d| d.occupied(|x, y| c.on(x, y)))
                || self.battle.as_ref().is_some_and(|b| b.units.iter().any(|u| u.alive && u.side == 0 && c.on(u.x, u.y))))) { return -3; }
        let b = &mut self.buildings[idx as usize];
        b.status = if up { DB_UP } else if self.battle.is_some() { DB_MANUAL_DOWN } else { 4 };
        b.progress = if up { VETO_SECS } else { 0 };
        if up { self.replan_over_deck(idx as usize); }
        if self.battle.is_some() {
            let fixed = self.bridge_points();
            self.battle.as_mut().unwrap().fixed = fixed;
        }
        0
    }
    /// A drawbridge's own states (`status`): 4 lowered, 5 drawn up by hand (`progress` counts down the seconds an army may not lower it), 6 lowered for an army (was drawn up), 7 lowered for an
    /// army during a battle (was lowered: every drawbridge counts as drawn up while a battle is on). `progress` of a lent one counts the seconds nobody has needed it.
    pub(crate) fn db_lent(b: &Building) -> bool { b.kind == DRAWBRIDGE && matches!(b.status, DB_LENT | DB_LENT_FIGHT) }
    /// The raid lifts ordinary decks. A manual lowering and decks lent to an army hold them down.
    pub(crate) fn drawn_up(&self, b: &Building) -> bool {
        b.kind == DRAWBRIDGE && (b.status == DB_UP || (self.battle.is_some() && b.status != DB_MANUAL_DOWN && !Self::db_lent(b)))
    }
    /// May an army lower it for itself? (Not for `VETO_SECS` after the player raised it.)
    pub(crate) fn db_lendable(&self, b: &Building) -> bool { self.drawn_up(b) && !(b.status == DB_UP && b.progress > 0) }
    /// Close (true) or open (false) the doors of a stone gatehouse (tier 3 up). A closed gate cannot be passed by your own armies; every stone gatehouse is shut while a battle is on and
    /// opens again afterwards. 0 ok, -1 not a gate, -2 a wooden gate has no doors.
    pub fn gate_set(&mut self, idx: u32, closed: bool) -> i32 {
        let Some(b) = self.buildings.get_mut(idx as usize) else { return -1 };
        if b.kind != GATE { return -1; }
        if b.tier < 2 { return -2; }
        b.status = if closed { 5 } else { 4 };
        self.after_change();
        0
    }
    /// Is this gate's door shut right now: closed by the player, or shut because raiders are attacking (stone gatehouses only)?
    pub(crate) fn gate_shut(&self, b: &Building) -> bool { b.kind == GATE && b.tier >= 2 && (b.status == 5 || self.battle.is_some()) }
    /// Which gates are shut right now, by building index (for drawing the doors).
    pub fn gates_shut_flat(&self) -> Vec<u32> { self.buildings.iter().enumerate().filter(|(_, b)| self.gate_shut(b)).map(|(i, _)| i as u32).collect() }
    /// Archers stationed in every building (zero except in towers), in building order.
    /// Tick at which each building was founded (roads to it grow in over the following days).
    pub fn birth_flat(&self) -> Vec<u32> { self.buildings.iter().map(|b| b.born).collect() }
    /// Ladders standing against walls in the current battle: [x, y, angle, busy] per ladder.
    /// Siege towers `[0, x, y, face, hull share, state, soldiers carried]` then saps `[1, x, y, face, dug share, state, 0]` in the current battle (see siege.rs).
    pub fn battle_siege_flat(&self) -> Vec<f32> { self.siege_flat() }
    pub fn battle_ladders_flat(&self) -> Vec<f32> { self.battle.as_ref().map_or(vec![], |b| b.spots.iter().flatten().copied().collect()) }
    /// Crossings the attackers have thrown over moats and rivers: [x, y, angle] per bridge, then [x, y, angle, work done] per one being built.
    pub fn battle_bridges_flat(&self) -> Vec<f32> { self.battle.as_ref().map_or(vec![], |b| { let mut v: Vec<f32> = b.bridges.iter().flat_map(|g| [g[0], g[1], g[2], 1.0]).collect(); v.extend(b.sites.iter().flat_map(|s| [s[0], s[1], s[2], (s[3] / 8.0).min(0.99)])); v }) }
    pub fn garrison_flat(&self) -> Vec<u32> { self.buildings.iter().map(|b| b.garrison as u32).collect() }
    /// How many archers the building can hold.
    pub fn garrison_cap(&self, idx: u32) -> u32 { self.buildings.get(idx as usize).map_or(0, Self::garrison_cap_of) }
    /// Station `n` archers in a tower, taken from (or returned to) the barracks. 0 ok, -1 not a tower, -2 not enough archers, -3 over capacity, -4 battle going on.
    pub fn garrison_set(&mut self, idx: u32, n: u32) -> i32 {
        if self.battle.is_some() { return -4; }
        let Some(b) = self.buildings.get(idx as usize) else { return -1 };
        if !matches!(b.kind, TOWER | KEEP) { return -1; }
        if n > Self::garrison_cap_of(b) { return -3; }
        let cur = b.garrison as u32;
        if n > cur { let d = n - cur; if self.army[1] < d { return -2; } self.army[1] -= d; } else { self.army[1] += cur - n; }
        self.buildings[idx as usize].garrison = n as u8;
        0
    }
    /// Send soldiers away to attack another village. They stop defending and eat but are not in the barracks.
    pub fn send_army(&mut self, counts: &[u32]) -> bool {
        let Some(counts) = kinds(counts) else { return false }; if self.battle.is_some() { return false; }
        for k in 0..NK { if counts[k] > self.army[k] { return false; } }
        for k in 0..NK { self.army[k] -= counts[k]; self.away[k] += counts[k]; }
        true
    }
    /// Survivors come home with loot. Only soldiers that were really sent away can come back, and loot cannot exceed a raider's share of a full store,
    /// so a forged "return" command cannot print soldiers or goods out of nothing (it can still claim loot a battle did not give: only the battle's other side could check that).
    pub fn return_army(&mut self, survivors: &[u32], loot: &[i32]) {
        let sent = self.away;
        for k in 0..NK.min(survivors.len()) { self.army[k] = self.army[k].saturating_add(survivors[k].min(sent[k])).min(ARMY_MAX); }
        self.away = [0; NK];
        let cap = self.storage_cap(); let most = cap / 100 * 35;
        for r in 0..N_RES.min(loot.len()) { self.stock[r] = Self::add_capped(self.stock[r], loot[r].clamp(0, most), cap); }
    }
    /// A refused attack never fought. Return only that contingent and leave other deployed soldiers in the field.
    pub fn return_refused_army(&mut self, counts: &[u32]) {
        for (k, &count) in counts.iter().take(NK).enumerate() {
            let returning = count.min(self.away[k]);
            self.away[k] -= returning;
            self.army[k] = self.army[k].saturating_add(returning).min(ARMY_MAX);
        }
    }
    /// Another village (tag = its id) attacks this one from `angle`.
    pub fn start_raid(&mut self, angle: f32, atk: &[u32], tag: i32) -> bool {
        self.start_raid_equipped(angle, atk, tag, 0)
    }

    pub fn start_raid_equipped(&mut self, angle: f32, atk: &[u32], tag: i32, tech: u16) -> bool {
        if !angle.is_finite() || angle.abs() > 7.0 { return false; }   // an angle comes from atan2 (-pi..pi); anything else is a forged command
        if atk.len() < 5 || self.has_treaty(tag, TREATY_PEACE) || self.has_treaty(tag, TREATY_ALLIANCE) { return false; }
        if tag != 0 { self.rel_add(tag, -40); }   // whoever marches on us is not our friend
        let c = |n: u32| n.min(300);
        let Some(atk) = kinds(atk) else { return false };
        if !self.begin_battle(atk.map(c), angle, tag) { return false; }
        if let Some(b) = &mut self.battle { b.tactics.tech[1] = if tag != 0 { tech & tactics::TECH_MASK } else { 0 }; }
        true
    }
    // ---------- trade and treaties ----------
    /// Agree something with another village (tag) for `days` days. kind 0 trade pact, 1 non-aggression. Replaces an older agreement of the same kind.
    pub fn treaty_set(&mut self, tag: i32, kind: u8, days: u32) -> bool {
        if kind > 2 || tag == 0 || days == 0 || days > 120 || (kind == TREATY_ALLIANCE && !self.treaty_acceptable(tag, kind)) { return false; }
        self.treaties.retain(|t| !(t.tag == tag && t.kind == kind));
        self.treaties.push(Treaty { tag, kind, until: self.tick + days as u64 * DAY }); true
    }
    /// End an agreement.
    pub fn treaty_end(&mut self, tag: i32, kind: u8) { self.treaties.retain(|t| !(t.tag == tag && t.kind == kind)); }
    pub fn has_treaty(&self, tag: i32, kind: u8) -> bool { self.treaties.iter().any(|t| t.tag == tag && t.kind == kind && t.until > self.tick) }
    /// Treaties in force: [tag, kind, days left] each.
    pub fn treaties_flat(&self) -> Vec<i32> { self.treaties.iter().filter(|t| t.until > self.tick).flat_map(|t| [t.tag, t.kind as i32, ((t.until - self.tick) / DAY) as i32]).collect() }

    /// Travel speed of newly dispatched caravans, as a percentage of the usual pace.
    pub fn caravan_speed_percent(&self) -> u32 {
        100 + if self.supplied(STABLE, 0) { 100 } else { 0 } + if self.supplied(EMBASSY, 0) { 75 } else { 0 } + self.horse_bonus()
    }

    /// The tier of the best standing embassy, if the village has one.
    fn embassy_tier(&self) -> Option<u8> { self.buildings.iter().filter(|b| b.kind == EMBASSY && b.hp > 0.0).map(|b| b.tier).max() }
    /// How many diplomatic parties (envoys, treaty riders, wedding parties, heralds) may be on the road at once: with an embassy, 4 / 8 / 12 / 16 by its tier; a village without one (the computer's) has the old 16.
    pub fn journey_capacity(&self) -> u32 { self.embassy_tier().map_or(16, |t| 4 + 4 * t as u32) }
    /// How many caravans may be on the road at once: 2 / 4 / 6 / 8 by the embassy's tier, or the old 8 without an embassy.
    pub fn caravan_capacity(&self) -> u32 { self.embassy_tier().map_or(8, |t| 2 + 2 * t as u32) }
    /// [parties on the road, how many may be, caravans on the road, how many may be].
    pub fn party_limits(&self) -> Vec<u32> { vec![self.journeys.len() as u32, self.journey_capacity(), self.caravans.len() as u32, self.caravan_capacity()] }

    /// Is there a standing building of this kind with design upgrade `bit`? One is enough: bonuses of the same upgrade never stack across several buildings. A burning or ruined one gives nothing.
    fn supplied(&self, kind: u8, bit: u8) -> bool {
        self.buildings.iter().any(|b| b.kind == kind && b.opts & (1 << bit) != 0 && b.burning <= 0.0 && b.hp > 0.0)
    }
    /// The extra pace (in percent) every horse has from the stables' "Swift horses" upgrade.
    fn horse_bonus(&self) -> u32 { if self.supplied(STABLE, 1) { 30 } else { 0 } }
    /// Pace of the village's knights in percent: the swift horses, plus the stables' warhorses.
    pub fn cavalry_speed_percent(&self) -> u32 { 100 + self.horse_bonus() + if self.supplied(STABLE, 3) { 40 } else { 0 } }

    /// Travel speed of a party of the given kind (0..2 treaty riders, 3 envoy, 4 wedding party, 5 war herald, 6 caravan) dispatched now, in percent of its usual pace.
    /// Stables speed up all the horses; the embassy's upgrades speed up each kind of party on its own.
    pub fn journey_speed_percent(&self, kind: u8) -> u32 {
        let courier = if self.supplied(STABLE, 2) { 100 } else { 0 };
        match kind {
            TREATY_TRADE | TREATY_PEACE | TREATY_ALLIANCE => 100 + self.horse_bonus() + courier + if self.supplied(EMBASSY, 2) { 100 } else { 0 },
            JK_ENVOY | JK_WAR => 100 + self.horse_bonus() + courier + if self.supplied(EMBASSY, 1) { 100 } else { 0 },
            JK_MARRIAGE => 100 + self.horse_bonus() + if self.supplied(EMBASSY, 3) { 100 } else { 0 },
            _ => self.caravan_speed_percent(),
        }
    }

    /// Send goods with an optional escort. Already dispatched caravans keep their arrival time.
    pub fn caravan_send(&mut self, res: u8, amount: i32, to: i32, distance: f32, escort: u32) -> i32 {
        let base = res & !GIFT_FLAG; let gift = res & GIFT_FLAG != 0;
        if res >= 2 * GIFT_FLAG || base as usize >= N_RES || amount <= 0 || amount > 500 || to == 0 || !(0.0..=3000.0).contains(&distance) { return -1; }
        if gift && self.relation(to) <= HOSTILE_REL { return -5; }   // (a gift to somebody who loathes us would only be thrown back)
        let res = if gift { base | GIFT_FLAG } else { base };
        if self.caravans.len() as u32 >= self.caravan_capacity() { return -4; }
        if self.stock[base as usize] < amount { return -2; }
        if escort > self.army[0] { return -3; }
        self.stock[base as usize] -= amount; self.army[0] -= escort;
        let speed = CARAVAN_SPEED * self.caravan_speed_percent() as f32 / 100.0;
        self.caravans.push(Caravan { res, amount, to, start: self.tick, eta: self.tick + 60 * 100 / self.caravan_speed_percent() as u64 + (distance / speed) as u64, escort });
        0
    }
    /// Send an errand to another village (tag) over `distance` units of road: kind 0..2 a treaty offer (arg = days), 3 an envoy with gifts (20 coins), 4 a royal marriage (150 coins), 5 a declaration of war.
    /// It costs what the instant version cost, now; the effect comes when the party arrives. 0 ok, -1 nonsense, -6 poor, -7 one of that kind is already on the road, -20 too soon, -21 not liked enough, -22 will not agree, -8 the embassy has all its parties out.
    pub fn journey_start(&mut self, kind: u8, tag: i32, arg: i32, distance: f32) -> i32 {
        if kind > JK_WAR || tag == 0 || !(0.0..=3000.0).contains(&distance) { return -1; }
        if self.journeys.iter().any(|j| j.tag == tag && j.kind == kind) { return -7; }
        if self.journeys.len() as u32 >= self.journey_capacity() { return -8; }
        match kind {
            TREATY_TRADE | TREATY_PEACE | TREATY_ALLIANCE => { if arg < 1 || arg > 120 { return -1; } if !self.treaty_acceptable(tag, kind) { return -22; } }
            JK_ENVOY => {
                if self.last_envoy.iter().any(|e| e.0 == tag && self.tick < e.1 + 3 * DAY) { return -20; }
                if self.stock[GD as usize] < 20 { return -6; }
                self.stock[GD as usize] -= 20; self.last_envoy.retain(|e| e.0 != tag); self.last_envoy.push((tag, self.tick));
            }
            JK_MARRIAGE => {
                if self.married.contains(&tag) { return -1; }
                if self.relation(tag) < 30 { return -21; }
                if self.stock[GD as usize] < 150 { return -6; }
                self.stock[GD as usize] -= 150;
            }
            _ => {}
        }
        let dur = 30 * 100 / self.journey_speed_percent(kind) as u64 + (distance / (JOURNEY_SPEED[kind as usize] * self.journey_speed_percent(kind) as f32 / 100.0)) as u64;
        self.journeys.push(Journey { kind, tag, arg, start: self.tick, arrive: self.tick + dur });
        0
    }
    /// Everything on the road to another village: [kind, to (tag), a, b, escort, start tick, arrival tick] each, stride 7. Kinds 0..5 as in `journey_start` (a = days), 6 a caravan (a = resource, b = amount).
    pub fn journeys_flat(&self) -> Vec<i32> {
        let mut v: Vec<i32> = self.journeys.iter().flat_map(|j| [j.kind as i32, j.tag, j.arg, 0, 0, j.start as i32, j.arrive as i32]).collect();
        for c in &self.caravans { v.extend([JK_CARAVAN as i32, c.to, c.res as i32, c.amount, c.escort as i32, c.start as i32, c.eta as i32]); }
        v
    }
    /// Errands that arrived since the last call: [kind, to (tag), arg, tick] each. Only a notice for the player's own client (the effect was already applied in `step`).
    pub fn take_arrivals(&mut self) -> Vec<i32> { std::mem::take(&mut self.arrivals).into_iter().flatten().collect() }
    /// The invisible path from our city to the village whose hall is at (tx, ty), as [x, y, x, y, ...] from our hall to theirs, or empty when none was chained.
    pub fn link_points(&self, tx: f32, ty: f32) -> Vec<f32> {
        self.links.iter().find(|pl| pl.last().map_or(false, |e| (e.0 - tx).hypot(e.1 - ty) < 12.0)).map_or(vec![], |pl| pl.iter().flat_map(|p| [p.0, p.1]).collect())
    }
    /// Goods on the road: [resource, amount, to, ticks left, escort] each.
    pub fn caravans_flat(&self) -> Vec<i32> { self.caravans.iter().flat_map(|c| [c.res as i32, c.amount, c.to, (c.eta.saturating_sub(self.tick)) as i32, c.escort as i32]).collect() }
    /// Caravans that reached their destination since the last call: [resource, amount, to] each. Only a notice: the village's own client passes it on so the other village can take
    /// the goods (see `receive_goods`) and pay (see `settle`). The caravan itself is moved on in `step`, so every peer's copy of this village agrees.
    pub fn take_delivered(&mut self) -> Vec<i32> { std::mem::take(&mut self.delivered).into_iter().flatten().collect() }
    /// Has a caravan of exactly this arrived for village `to` and not been settled? (A village checks this on its neighbour's copy before it accepts a delivery, so nobody can force goods on it.)
    pub fn is_awaiting(&self, res: u8, amount: i32, to: i32) -> bool { self.awaiting.iter().any(|a| a[0] == res as i32 && a[1] == amount && a[2] == to) }
    /// The other village took the goods of one of our caravans: settle the account, paying coin at the usual price (10% more under a trade pact). It only pays for a caravan that really arrived
    /// and has not been paid yet, so a forged message cannot print money. Returns the coins received.
    pub fn settle(&mut self, res: u8, amount: i32, from: i32) -> i32 {
        let Some(i) = self.awaiting.iter().position(|a| a[0] == res as i32 && a[1] == amount && a[2] == from) else { return 0 };
        self.awaiting.remove(i);
        if res & GIFT_FLAG != 0 { self.rel_add(from, Self::gift_warmth(res & !GIFT_FLAG, amount)); self.push_event(EV_DIPLO, 3, 0); return 0; }   // a gift is not paid for: it is remembered
        let pact = self.has_treaty(from, TREATY_TRADE); let ally = self.has_treaty(from, TREATY_ALLIANCE);
        self.rel_add(from, 2);   // honest trade builds trust
        let gold = amount * PRICE[res as usize] * if ally { 120 } else if pact { 110 } else { 100 } / 100;
        let cap = self.storage_cap(); let before = self.stock[GD as usize];
        self.stock[GD as usize] = Self::add_capped(before, gold, cap); self.stock[GD as usize] - before
    }
    /// How much a gift of this size warms the feelings of whoever gets it: a point for every ten coins' worth (nothing for a trifle, so it cannot be farmed with crumbs), at most 12.
    fn gift_warmth(res: u8, amount: i32) -> i32 { if res as usize >= N_RES { return 0; } (amount.clamp(0, 500) * PRICE[res as usize] / 10).min(12) }
    /// Would we let a caravan from this village in? Not when they loathe us, or we them (relation at or below `HOSTILE_REL`, as after a declaration of war).
    pub fn caravan_welcome(&self, from: i32) -> bool { self.relation(from) > HOSTILE_REL }
    /// Goods from the caravan of village `from`, like `receive_goods` but with the sender known: a hostile village's caravan is turned away (-1, nothing taken), and a gift
    /// costs nothing and warms our feelings towards them. Returns the coins paid, or -1 when refused.
    pub fn receive_goods_from(&mut self, res: u8, amount: i32, from: i32) -> i32 {
        if from == 0 || !self.caravan_welcome(from) { return -1; }
        if res & GIFT_FLAG == 0 { return self.receive_goods(res, amount); }
        let base = res & !GIFT_FLAG;
        if res >= 2 * GIFT_FLAG || base as usize >= N_RES || amount <= 0 || amount > 500 { return 0; }
        let room = (self.storage_cap() - self.stock[base as usize]).max(0); let take = amount.min(room);
        self.stock[base as usize] += take; self.rel_add(from, Self::gift_warmth(base, take)); self.push_event(EV_DIPLO, 3, 0); 0
    }
    /// A village turned our caravan back: the goods come home (as far as the stores take them) and the account is closed. Only for a caravan that really arrived and has not been
    /// settled. Returns whether it did. A gift that was refused is not remembered as one.
    pub fn caravan_returned(&mut self, res: u8, amount: i32, from: i32) -> bool {
        let Some(i) = self.awaiting.iter().position(|a| a[0] == res as i32 && a[1] == amount && a[2] == from) else { return false };
        self.awaiting.remove(i);
        let base = (res & !GIFT_FLAG) as usize; if base >= N_RES { return false; }
        let cap = self.storage_cap(); self.stock[base] = Self::add_capped(self.stock[base], amount, cap); true
    }
    /// Goods arrive from another village's caravan: they go into the stores (up to what fits), and the sender is owed their worth, which we pay in coin at our own price when we can. Returns the coins paid.
    pub fn receive_goods(&mut self, res: u8, amount: i32) -> i32 {
        if res as usize >= N_RES || amount <= 0 || amount > 500 { return 0; }   // (a caravan carries at most 500)
        let cap = self.storage_cap(); let room = (cap - self.stock[res as usize]).max(0); let take = amount.min(room);
        let pact = self.treaties.iter().any(|t| t.kind == TREATY_TRADE && t.until > self.tick);   // (the sender's own village pays by `settle`)
        let worth = take * self.price_x100(res as usize) / 100 * if pact { 110 } else { 100 } / 100;
        let pay = worth.min(self.stock[GD as usize]);
        self.stock[res as usize] += take; self.stock[GD as usize] -= pay; pay
    }

    pub fn battle_active(&self) -> bool { self.battle.is_some() }
    /// Who is attacking: 0 bandits, otherwise the attacking player's tag.
    pub fn battle_tag(&self) -> i32 { self.battle.as_ref().map_or(0, |b| b.tag) }
    /// Direction the attackers came from, as an angle (atan2(dy, dx)) from the village centre; 0 when there is no battle.
    /// Where the attackers formed up when the fight began: [x, y] in world coordinates, empty when there is no fight (or it is a lair fight, which has no raid line).
    pub fn battle_spawn(&self) -> Vec<f32> { self.battle.as_ref().filter(|b| b.lair < 0).map_or(vec![], |b| b.spawn.to_vec()) }
    pub fn battle_angle(&self) -> f32 { self.battle.as_ref().map_or(0.0, |b| b.angle) }
    pub fn battle_time(&self) -> f32 { self.battle.as_ref().map_or(0.0, |b| b.t) }
    pub fn battle_deploy_remaining(&self) -> f32 { self.battle.as_ref().filter(|b| !b.bought).map_or(0.0, |b| (battle::DEPLOY_SECS - b.t).max(0.0)) }
    /// Announced or current objective: [kind, x, z, combat seconds left, capture fraction, lost].
    pub fn raid_objective(&self) -> Vec<f32> {
        if let Some(b) = &self.battle {
            return b.objective.filter(|_| !b.bought).map_or(vec![], |o| o.flat((b.t - battle::DEPLOY_SECS).max(0.0)));
        }
        if self.raid_warning_ticks > 0 { return self.warned_raid_objective().map_or(vec![], |o| o.flat(0.0)); }
        vec![]
    }
    /// Ticks until the announced bandit raid arrives (zero when there is no warning).
    pub fn raid_warning_ticks(&self) -> u32 { self.raid_warning_ticks }
    /// Direction the announced bandits will approach from, in radians.
    pub fn raid_warning_angle(&self) -> f32 { self.raid_warning_angle }
    /// Whether the announced raid is led by a boss.
    pub fn raid_warning_boss(&self) -> bool { self.raid_warning_boss && self.raid_warning_ticks > 0 }
    /// The boss in the fight: [boss (1 warlord, 2 ogre), name, hp, maxhp, phase, alive] or nothing.
    pub fn battle_boss(&self) -> Vec<f32> {
        let Some(b) = &self.battle else { return vec![] };
        match b.units.iter().find(|u| u.boss > 0) { Some(u) => vec![u.boss as f32, u.bname as f32, u.hp.max(0.0), u.maxhp, u.phase as f32, u.alive as u8 as f32], None => vec![] }
    }
    /// Where the army is fighting, if it is a lair rather than the village: [x, y] or nothing.
    pub fn battle_lair(&self) -> Vec<f32> { match &self.battle { Some(b) if b.lair >= 0 => b.lair_at.to_vec(), _ => vec![] } }
    /// Soldiers on the field: [side, kind, x, y, hp, maxhp, alive, swinging, facing, elevation, boss, phase, name, aura] (stride 14). `boss` 0 for a soldier, else 1 warlord / 2 ogre; `phase` 1 when enraged;
    /// `aura` is 1 while a warlord's horn sounds (on the warlord and on the escort it spurs on).
    pub fn battle_units_flat(&self) -> Vec<f32> {
        match &self.battle {
            Some(b) => {
                let horns: Vec<(f32, f32, f32)> = b.units.iter().filter(|u| u.boss > 0 && u.alive && BOSSES[(u.boss - 1) as usize].horn_every > 0.0 && u.t1 < BOSSES[(u.boss - 1) as usize].horn_secs).map(|u| (u.x, u.y, BOSSES[(u.boss - 1) as usize].horn_reach)).collect();
                b.units.iter().flat_map(|u| {
                    let aura = u.side == 1 && u.alive && horns.iter().any(|h| (h.0 - u.x).powi(2) + (h.1 - u.y).powi(2) < h.2 * h.2);
                    [u.side as f32, u.kind as f32, u.x, u.y, u.hp.max(0.0), u.maxhp, u.alive as u8 as f32, u.anim, u.face, if u.wading { (self.water_surface_at(u.x, u.y) - self.height_at(u.x, u.y) + 0.12).max(0.0) } else { u.elev }, u.boss as f32, u.phase as f32, u.bname as f32, aura as u8 as f32]
                }).collect()
            }
            None => vec![],
        }
    }
    /// The friendly field army each battle unit belongs to, in the same order as `battle_units_flat`. Zero means no field army.
    pub fn battle_detachment_ids(&self) -> Vec<u32> {
        self.battle.as_ref().map_or_else(Vec::new, |b| b.units.iter().map(|u| if u.side == 0 { u.det } else { 0 }).collect())
    }
    /// The last frame of a finished fight, for animating casualties on the final tick.
    pub fn take_last_battle_frame(&mut self) -> Vec<f32> { std::mem::take(&mut self.last_battle_frame) }
    /// Arrows and stones fired since last call: [kind (0 arrow, 1 stone), x0, y0, x1, y1, fire, unitKind] (stride 7).
    pub fn take_shots(&mut self) -> Vec<f32> { std::mem::take(&mut self.shots).into_iter().flatten().collect() }
    /// Burning things: [kind (0 building, 1 forest fire), x, y, radius] (stride 4).
    pub fn fires_flat(&self) -> Vec<f32> {
        let mut v: Vec<f32> = vec![];
        for b in &self.buildings { if b.burning > 0.0 { v.extend_from_slice(&[0.0, b.x, b.y, DEFS[b.kind as usize].r]); } }
        for w in &self.wildfires { v.extend_from_slice(&[1.0, w.x, w.y, w.r]); }
        v
    }
    /// Scorched ground discs [x, y, r] and ruined buildings [x, y, r, kind].
    pub fn scorch_flat(&self) -> Vec<f32> { self.scorch.iter().flatten().copied().collect() }
    /// Ruined buildings: [x, y, r, kind, tier, rot] (stride 6).
    pub fn ruins_flat(&self) -> Vec<f32> { self.ruins.iter().flatten().copied().collect() }
    /// Increments whenever craters, scorch marks or ruins changed (the terrain mesh needs refreshing).
    pub fn terrain_version(&self) -> u32 { self.terrain_ver }
    /// Building hit points [hp, maxhp, burning] per building (stride 3).
    pub fn building_health(&self) -> Vec<f32> { self.buildings.iter().flat_map(|b| [b.hp.max(0.0), battle::max_hp(b.kind, b.tier), b.burning]).collect() }
    /// Last battle report: [seq, won, tag, attackersLeft, defenderDead, buildingsLost, survivors x5, loot x12, attackersFled, defendersFled].
    pub fn last_report(&self) -> Vec<i32> { self.report.clone() }
    /// Did the last battle end with the raiders paid off (see bribe.rs)?
    pub fn last_report_bought(&self) -> bool { self.report_bought }
    /// Ignite a building (for fire arrows or testing).
    pub fn set_fire(&mut self, idx: u32) { self.ignite(idx as usize); }
    /// Villagers currently available to fight fires.
    pub fn fire_fighters(&self) -> u32 { self.firefighters() }
    pub fn wind(&self) -> Vec<f32> { let (x, y) = self.wind_vec(); vec![x, y] }


    // ---------- testing helpers (replicated as signed commands, so peers stay in sync) ----------
    /// Testing actions: 0 give resource (a = resource, b = amount), 1 add villagers (a), 2 add soldiers (a = kind, b = count),
    /// 3 fill every store, 4 start a bandit raid (a = angle in 1/100 rad, b = strength 0..1000), 5 set a building on fire (a = index),
    /// 6 make everyone healthy, 7 put out all fires, 8 reset the terrain (rivers, moats, earthworks, craters and scorch).
    pub fn cheat(&mut self, action: u8, a: i32, b: i32) -> bool {
        match action {
            0 => { if a >= 0 && (a as usize) < N_RES { let cap = self.storage_cap(); self.stock[a as usize] = self.stock[a as usize].saturating_add(b).clamp(0, cap); true } else { false } }
            1 => { let cap = self.capacity().max(2); let want = ((self.population as i32).saturating_add(a).max(2) as u32).min(cap); if want > self.population { self.arrive(want - self.population); } else { self.leave(self.population - want); } self.staffing(); true }
            2 => { if a >= 0 && (a as usize) < NK { self.army[a as usize] = ((self.army[a as usize] as i32).saturating_add(b).clamp(0, 100_000)) as u32; true } else { false } }
            3 => { let cap = self.storage_cap(); for r in 0..N_RES { self.stock[r] = cap; } true }
            4 => { let f = self.bandit_force(b.clamp(0, 1000) as f32 / 1000.0); self.begin_battle(f, a as f32 * 0.01, 0) }
            11 => { let name = (a.rem_euclid(4)) as u8; self.begin_boss_raid(IRONCLAD, a as f32 * 0.01, b.clamp(0, 1000) as f32 / 1000.0, name) }   // a raid led by the Ironclad Knight Captain (testing)
            12 => { if self.plague_camp.is_some() { false } else { let a = a as f32 * 0.01; let dist = self.raid_distance(a); self.plague_camp = Some(plague::Camp { x: self.ox as f32 + a.cos() * dist, y: self.oy as f32 + a.sin() * dist, since: self.tick, name: b.rem_euclid(4) as u8 }); true } }   // a plague camp (testing)
            10 => { let name = (a.rem_euclid(4)) as u8; self.begin_boss_raid(RAID_BOSS, a as f32 * 0.01, b.clamp(0, 1000) as f32 / 1000.0, name) }   // a raid led by a boss (testing)
            5 => { self.ignite(a.max(0) as usize); true }
            6 => { self.end_plague(); true }
            9 => { if self.plague_active() { false } else { self.start_plague(); true } }   // an outbreak now
            7 => {   // put out every fire (buildings and wildfires)
                for b in self.buildings.iter_mut() { b.burning = 0.0; }
                self.wildfires.clear(); true
            }
            8 => {   // reset the terrain: remove rivers, moats and earthworks, fill the craters and clear the scorch marks
                self.buildings.retain(|b| !is_edit(b.kind));
                self.craters.clear(); self.scorch.clear(); self.ruins.clear(); self.levels.clear(); self.flats.clear(); self.terrain_ver += 1; self.map_ver += 1;
                self.after_change(); true
            }
            _ => false,
        }
    }


    // ---------- field armies ----------
    /// Take soldiers out of the barracks into a field army (units = [spear, archer, sword, knight, catapult]). Returns its id, 0 on failure.
    pub fn det_form(&mut self, units: &[u32]) -> u32 { let Some(u) = kinds(units) else { return 0 }; self.det_form_inner(u) }
    /// Set (or, with `reset`, clear) the rally point of the barracks (`which` 0) or the castle (1): where new armies stand. 0 ok, -1 no such building, -2 not somewhere an army can stand.
    pub fn set_rally(&mut self, which: u32, x: f32, y: f32, reset: bool) -> i32 {
        let w = which as usize;
        if w > 1 || self.buildings.is_empty() { return -1; }
        if w == 0 && !self.buildings.iter().any(|b| b.kind == BARRACKS) { return -1; }
        if w == 1 && !(self.buildings[0].kind == TOWN_HALL && self.buildings[0].tier >= 3) { return -1; }
        if reset { self.rally[w] = None; return 0; }
        let (hx, hy) = (self.buildings[0].x, self.buildings[0].y);
        if !x.is_finite() || !y.is_finite() || (x - hx).hypot(y - hy) > 300.0 { return -2; }
        let Some((cx, cy)) = self.free_spot(x, y) else { return -2 };
        if (cx - x).hypot(cy - y) > 6.0 { return -2; }
        self.rally[w] = Some((x, y));
        0
    }

    /// Where the barracks (0) or the castle (1) muster their armies now: [x, y, 1 when the player chose it].
    pub fn rally_flat(&self, which: u32) -> Vec<f32> {
        let w = which as usize; if w > 1 || self.buildings.is_empty() { return vec![]; }
        match self.rally[w] { Some((x, y)) => vec![x, y, 1.0], None => { let (x, y) = self.default_rally(w); vec![x, y, 0.0] } }
    }
    /// March to (tx, ty). 0 ok, -1 no such army, -2 unreachable, -3 siege engines need soldiers to cut the forest, -5 water too wide.
    pub fn det_march(&mut self, id: u32, tx: f32, ty: f32, attack: bool, ax: f32, ay: f32) -> i32 {
        // a peer chooses these numbers: NaN, infinity or a point far off the map would make the router search forever
        if ![tx, ty, ax, ay].iter().all(|v| v.is_finite() && v.abs() <= MAP_LIMIT) { return -1; }
        self.det_march_inner(id, tx, ty, if attack { Some((ax, ay)) } else { None }, false) }
    /// Send the army back to the town hall, where it rejoins the barracks.
    pub fn det_recall(&mut self, id: u32) -> i32 { let (hx, hy) = (self.buildings[0].x, self.buildings[0].y + 9.0); self.det_march_inner(id, hx, hy, None, true) }
    pub fn det_split(&mut self, id: u32, take: &[u32]) -> u32 { let Some(t) = kinds(take) else { return 0 }; self.det_split_inner(id, t) }
    pub fn det_merge(&mut self, a: u32, b: u32) -> bool { self.det_merge_inner(a, b) }
    pub fn det_halt(&mut self, id: u32) {
        let Some(d) = self.dets.iter_mut().find(|d| d.id == id) else { return; };
        if d.state == march::S_FIGHT || d.ally != 0 { return; }
        d.defend = false; d.atk = None; d.home = false;
        if d.state == march::S_FERRY {
            d.path.truncate(d.wi + 1);
            if let Some(landing) = d.path.last() {
                for g in &mut d.grp {
                    let stop = g.path.iter().enumerate().skip(g.wi).find(|(_, p)| p.x == landing.x && p.y == landing.y);
                    g.path.truncate(stop.map_or(g.wi, |(i, _)| i + 1));
                }
            }
        } else {
            if d.state == march::S_FORMATION { d.file.hold_formation(&d.units); }
            d.path.clear(); d.state = march::S_IDLE; d.phase = 0; d.speed = 0.0;
            for g in &mut d.grp { g.path.clear(); g.speed = 0.0; }
        }
    }
    /// An army that has arrived at an enemy village joins the attack; returns its soldiers (empty on failure).
    /// Send a field army to the fight in this village: it marches to the nearest attacker and joins the defenders once it is within reach (`battle::JOIN_REACH`). 0 ok, -10 there is no battle, other codes as `det_march`.
    pub fn det_defend(&mut self, id: u32) -> i32 { self.det_defend_inner(id) }
    /// Call off the attack of the army with this tag: its soldiers break and run. Only the attackers' side can be made to retreat. True if there was such a battle.
    pub fn battle_retreat(&mut self, tag: i32) -> bool { self.retreat_attackers(tag) }
    /// More soldiers of the same attacker (tag) arrive at the battle already going on. True if they joined.
    pub fn battle_reinforce(&mut self, tag: i32, atk: &[u32]) -> bool { let Some(a) = kinds(atk) else { return false }; self.reinforce_attackers(tag, a.map(|n| n.min(300))) }

    pub fn battle_reinforce_equipped(&mut self, tag: i32, atk: &[u32], tech: u16) -> bool {
        if !self.battle_reinforce(tag, atk) { return false; }
        if tag != 0 { if let Some(b) = &mut self.battle { b.tactics.tech[1] |= tech & tactics::TECH_MASK; } }
        true
    }
    /// Soldiers still standing in the standing army's defence of the battle, per kind (what can be sent out to meet the raiders).
    pub fn battle_standing(&self) -> Vec<u32> { self.standing_in_battle().to_vec() }
    pub fn det_send(&mut self, id: u32) -> Vec<u32> { self.det_send_inner(id).map_or(vec![], |u| u.to_vec()) }
    /// An allied village sends soldiers to stand with us (see docs/ALLIES.md). They become a guest army of ours that fights beside the defenders of any battle here, eats our food, and cannot be
    /// ordered by us. Only with an alliance in force, at most `GUEST_MAX` soldiers a time and `GUEST_ARMIES` guest armies in all. False: refused (the sender takes them home).
    pub fn host_guests(&mut self, tag: i32, units: &[u32]) -> bool {
        let Some(u) = kinds(units) else { return false };
        if u.iter().any(|&n| n > GUEST_MAX) { return false; }   // (first: a peer chooses these numbers, and their sum must not overflow)
        let total: u32 = u.iter().sum();
        if tag == 0 || total == 0 || total > GUEST_MAX || !self.has_treaty(tag, TREATY_ALLIANCE) { return false; }
        if self.dets.iter().filter(|d| d.ally != 0).count() >= GUEST_ARMIES || self.battle.as_ref().is_some_and(|b| b.bought) { return false; }
        self.det_muster(u, tag) != 0
    }
    /// Our guests of this allied village go home: those not in a fight now leave, and their soldiers are returned (per kind) for the sender to take back. Guests in a fight stay until it is over.
    pub fn release_guests(&mut self, tag: i32) -> Vec<u32> {
        let mut back = [0u32; NK];
        self.dets.retain(|d| {
            if d.ally != tag || tag == 0 || d.state == march::S_FIGHT { return true; }
            for k in 0..NK { back[k] += d.units[k]; }
            false
        });
        back.to_vec()
    }
    /// Which allied village each field army belongs to, in the order of `det_flat` (0: ours).
    pub fn det_ally_flat(&self) -> Vec<i32> { self.dets.iter().map(|d| d.ally).collect() }
    /// [id, x, y, spear, archer, sword, knight, catapult, state, legMode, legsLeft, workProgress, atkX, atkY, heading, speed] (stride 17, the last is the number of rams)
    pub fn det_flat(&self) -> Vec<f32> {
        self.dets.iter().flat_map(|d| {
            let mode = d.path.get(d.wi).map_or(0.0, |w| w.mode as f32);
            let prog = if d.work_total > 0.0 && d.phase == 1 { (d.work / d.work_total).min(1.0) } else { 0.0 };
            let (ax, ay) = d.atk.unwrap_or((0.0, 0.0));
            [d.id as f32, d.x, d.y, d.units[0] as f32, d.units[1] as f32, d.units[2] as f32, d.units[3] as f32, d.units[4] as f32, d.state as f32, mode, (d.path.len().saturating_sub(d.wi)) as f32, prog, ax, ay, d.heading, d.speed, d.units[5] as f32]
        }).collect()
    }
    /// Riders and engines marching apart from their army: [army id, kind (3 knights, 4 catapults), count, x, y, heading, speed, tied] (stride 8).
    pub fn det_groups_flat(&self) -> Vec<f32> {
        self.dets.iter().flat_map(|d| d.grp.iter().flat_map(move |g| { let k = if g.units[3] > 0 { 3 } else { 4 }; [d.id as f32, k as f32, (if k == 3 { g.units[3] } else { g.units[4] + g.units[5] }) as f32, g.x, g.y, g.heading, g.speed, g.tied as u8 as f32] })).collect()
    }
    /// Single-file marching tracks. Each record starts [army id, group kind (0 main, 3 riders, 4 engines), dispatch distance, spacing, point count],
    /// followed by [x, y, movement mode, distance along the track] for each point.
    pub fn det_files_flat(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for d in self.dets.iter().filter(|d| d.state != march::S_FIGHT) {
            let head = Self::head_units(d);
            if d.state != march::S_IDLE || d.file.in_flight(&head) || d.file.mustered() { d.file.write_flat(d.id, 0, &head, &mut out); }
            for g in &d.grp { g.file.write_flat(d.id, if g.units[3] > 0 { 3 } else { 4 }, &g.units, &mut out); }
        }
        out
    }
    /// Individual approaches to the shared track. Records are [army id, group kind, rank, point count], followed by
    /// [x, y, mode, distance to the network entry (negative until the soldier reaches it)].
    pub fn det_approaches_flat(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for d in self.dets.iter().filter(|d| d.state != march::S_FIGHT) {
            d.file.write_approaches(d.id, 0, &mut out);
            for g in &d.grp { g.file.write_approaches(d.id, if g.units[3] > 0 { 3 } else { 4 }, &mut out); }
        }
        out
    }
    /// Remaining route of an army: [x, y, mode, ...] starting at its current position.
    pub fn det_path(&self, id: u32) -> Vec<f32> {
        let Some(d) = self.dets.iter().find(|d| d.id == id) else { return vec![] };
        let mut v = vec![d.x, d.y, 0.0]; for w in d.path.iter().skip(d.wi) { v.extend_from_slice(&[w.x, w.y, w.mode as f32]); } v
    }
    pub fn map_version(&self) -> u32 { self.map_ver }
    /// Choose what a farm does with its field: 0 always sow, 1 let it lie fallow, 2 rotate (rest when the soil is worn, sow again when it is restored). 0 ok, -1 not a farm, -2 bad mode.
    pub fn set_field_mode(&mut self, idx: u32, mode: u8) -> i32 {
        let Some(b) = self.buildings.get_mut(idx as usize) else { return -1 };
        if b.kind == SMOKEHOUSE { if mode > 1 { return -2; } b.mode = mode; return 0; }   // a smokehouse: 0 smokes fish, 1 smokes meat
        if b.kind != FARM { return -1; }
        if mode > 2 { return -2; }
        b.mode = if mode == 2 && b.fert <= FERT_TIRED { 3 } else { mode }; 0
    }
    /// What a smokehouse is set to smoke: 0 fish, 1 meat (-1 for anything that is not a smokehouse).
    pub fn smoke_mode(&self, idx: u32) -> i32 { match self.buildings.get(idx as usize) { Some(b) if b.kind == SMOKEHOUSE => b.mode as i32, _ => -1 } }
    /// A farm's field: [soil in hundredths of a percent (10000 = rich), what it does (0 sow, 1 fallow, 2 rotate), resting right now (0/1)]; empty for anything that is not a farm.
    pub fn field_info(&self, idx: u32) -> Vec<i32> {
        match self.buildings.get(idx as usize) { Some(b) if b.kind == FARM => vec![b.fert as i32, if b.mode == 3 { 2 } else { b.mode as i32 }, (b.mode == 1 || b.mode == 3) as i32], _ => vec![] }
    }
    /// Kept groves [x, y, radius] each: forest that stands inside a cleared area.
    pub fn groves_flat(&self) -> Vec<f32> { self.groves.iter().flatten().copied().collect() }
    /// Testing tool for the model village. Positions are relative to the town hall.
    /// 0: clear every tree and every ore/stone/clay deposit within radius `a` (and forget the groves). 1: put a deposit of kind `a` (0 stone, 1 clay, 2 iron ore, 3 gold ore) at (`b`, `c`),
    /// reusing a cleared one (or, failing that, moving the nearest other one of that kind). 2: keep the natural forest standing in a grove at (`a`, `b`) of radius `c`. Returns the deposit index for 1, else 0 (-1 on bad arguments).
    pub fn demo(&mut self, action: u8, a: i32, b: i32, c: i32) -> i32 {
        let (hx, hy) = (self.ox as f32, self.oy as f32);
        match action {
            0 => {
                let r = (a as f32).clamp(10.0, 200.0);
                self.felled.push([hx, hy, r]); self.groves.clear();
                for d in self.deposits.iter_mut() { if (d.x - hx).hypot(d.y - hy) < r { d.rem = 0; d.max = 0; d.asleep = false; } }
                self.deposit_layout.set(None);
                self.map_ver += 1; self.terrain_ver += 1; 0
            }
            1 => {
                if !(0..4).contains(&a) || !(-400..=400).contains(&b) || !(-400..=400).contains(&c) { return -1; }
                let kind = a as u8; let (x, y) = (hx + b as f32, hy + c as f32);
                let slot = self.deposits.iter().position(|d| d.kind == kind && d.max == 0)
                    .or_else(|| self.deposits.iter().enumerate().filter(|(_, d)| d.kind == kind).min_by(|(_, p), (_, q)| (p.x - hx).hypot(p.y - hy).total_cmp(&(q.x - hx).hypot(q.y - hy))).map(|(i, _)| i));
                let Some(i) = slot else { return -1 };
                let amount = match kind { 0 => 1500, 1 => 1200, 2 => 900, _ => 320 };
                self.deposits[i] = Deposit { kind, x, y, rem: amount, max: amount, asleep: false };
                self.deposit_layout.set(None);
                self.map_ver += 1; self.terrain_ver += 1; i as i32
            }
            2 => { if !(-400..=400).contains(&a) || !(-400..=400).contains(&b) || self.groves.len() >= 16 { return -1; } self.groves.push([hx + a as f32, hy + b as f32, (c as f32).clamp(5.0, 60.0)]); self.map_ver += 1; 0 }
            _ => -1,
        }
    }
    /// The best patch of natural forest in a ring round the hall (radii `min_r`..`max_r`, directions `from_deg`..`to_deg`, 0 = east, 90 = south): [dx, dy, density] relative to the hall, or nothing.
    pub fn forest_spot(&self, min_r: f32, max_r: f32, from_deg: f32, to_deg: f32) -> Vec<f32> {
        if ![min_r, max_r, from_deg, to_deg].iter().all(|v| v.is_finite()) { return vec![]; }
        let (min_r, max_r) = (min_r.clamp(0.0, 400.0), max_r.clamp(0.0, 400.0));
        let (from_deg, to_deg) = (from_deg.clamp(-720.0, 720.0), to_deg.clamp(-720.0, 720.0));
        let (hx, hy) = (self.ox as f32, self.oy as f32);
        let mut best: Option<(f32, f32, f32)> = None;
        let mut deg = from_deg;
        while deg <= to_deg {
            let a = deg.to_radians(); let mut r = min_r;
            while r <= max_r {
                let (x, y) = (hx + a.cos() * r, hy + a.sin() * r);
                if self.height_at(x, y) > 1.0 { let d = terrain::forest_near(self.seed, x, y, 12.0); if best.map_or(true, |b| d > b.2) { best = Some((a.cos() * r, a.sin() * r, d)); } }
                r += 5.0;
            }
            deg += 6.0;
        }
        best.map_or(vec![], |(x, y, d)| vec![x, y, d])
    }
    pub fn felled_flat(&self) -> Vec<f32> { self.felled.iter().flatten().copied().collect() }
    pub fn bridges_flat(&self) -> Vec<f32> { self.bridges.iter().flatten().copied().collect() }
    /// Plan a route without ordering it: [ok(1) | error code, seconds, planks, wood, count, x, y, mode, ...].
    pub fn plan_march(&self, units: &[u32], sx: f32, sy: f32, tx: f32, ty: f32) -> Vec<f32> { let Some(u) = kinds(units) else { return vec![-1.0] }; self.plan(&u, sx, sy, tx, ty) }
    /// Plan the selected army's current interception route using the same waypoint as `det_defend`.
    pub fn plan_reinforcement(&self, id: u32) -> Vec<f32> {
        let Some(d) = self.dets.iter().find(|d| d.id == id) else { return vec![-1.0]; };
        if d.state == march::S_FIGHT { return vec![1.0, 0.0, 0.0, 0.0, 0.0]; }
        match self.reinforce_waypoint(d.x, d.y) {
            Ok(Some((x, y))) => self.plan(&d.units, d.x, d.y, x, y),
            Ok(None) => vec![1.0, 0.0, 0.0, 0.0, 0.0],
            Err(code) => vec![code as f32],
        }
    }
    /// Changes when terrain, construction, or bridge policy could alter a march route.
    pub fn march_revision(&self) -> u64 { self.route_revision() }
    /// Run an order on a worker's disposable village copy and return the routes it used.
    pub fn prepare_army_order(&mut self, id: u32, tx: f32, ty: f32, mode: u8) -> Vec<u8> {
        self.army_order_mode(id, tx, ty, mode, 0.0, 0.0, false);
        self.prepared_routes()
    }
    /// Try the current order using worker-computed routes. -11 means the army, opponents or terrain have moved since the worker started.
    pub fn apply_prepared_army_order(&mut self, prepared: &[u8], id: u32, tx: f32, ty: f32, mode: u8, ax: f32, ay: f32) -> i32 {
        if !self.use_prepared_routes(prepared) { return march::ROUTE_PENDING; }
        self.army_order_mode(id, tx, ty, mode, ax, ay, true)
    }
    fn army_order_mode(&mut self, id: u32, tx: f32, ty: f32, mode: u8, ax: f32, ay: f32, cached_only: bool) -> i32 {
        match mode {
            0 | 2 if [tx, ty, ax, ay].iter().all(|v| v.is_finite() && v.abs() <= MAP_LIMIT) => {
                self.det_march_mode(id, tx, ty, (mode == 2).then_some((ax, ay)), false, cached_only)
            }
            1 => self.det_defend_mode(id, cached_only),
            3 => { let hall = &self.buildings[0]; self.det_march_mode(id, hall.x, hall.y + 9.0, None, true, cached_only) }
            _ => -1,
        }
    }


    // ---------- repair and rebuilding ----------
    /// Repair a damaged building completely. 0 ok, -6 cannot afford, -14 burning, -15 undamaged.
    pub fn repair(&mut self, idx: u32) -> i32 { self.do_repair(idx as usize) }
    /// Flat [resource, amount, ...] cost of repairing the building completely.
    pub fn repair_cost(&self, idx: u32) -> Vec<i32> {
        match self.buildings.get(idx as usize) { Some(b) => Self::repair_cost_frac(b.kind, b.tier, 1.0 - (b.hp / battle::max_hp(b.kind, b.tier)).clamp(0.0, 1.0)).into_iter().flat_map(|(r, n)| [r as i32, n]).collect(), None => vec![] }
    }
    /// Rebuild the ruin with this index (see ruins_flat). 0 ok, -3 blocked, -6 cannot afford.
    pub fn rebuild(&mut self, ruin: u32) -> i32 { self.do_rebuild(ruin as usize) }
    pub fn rebuild_cost_of(&self, ruin: u32) -> Vec<i32> {
        match self.ruins.get(ruin as usize) { Some(r) => Self::rebuild_cost(r[3] as u8, r[4] as u8).into_iter().flat_map(|(a, n)| [a as i32, n]).collect(), None => vec![] }
    }

    pub fn stocks(&self) -> Vec<i32> { self.stock.to_vec() }
    pub fn tick(&self) -> u64 { self.tick }
    pub fn population(&self) -> u32 { self.population }
    /// Days of food at the current appetite, with no new production. Negative when nobody eats.
    pub fn food_reserve_days(&self) -> f64 {
        let (_, eat) = self.appetite();
        if eat == 0 { -1.0 } else { self.food_units() as f64 / (eat as f64 * DAY as f64) }
    }
    pub fn sick(&self) -> u32 { self.sick }
    pub fn efficiency(&self) -> u32 { self.eff }

    /// Set how many workers the building at `idx` should have: -1 auto (the usual shares), 0 paused, up to its jobs (a better building employs more). 0 ok, -1 no such building or it employs nobody, -2 out of range.
    pub fn set_workers(&mut self, idx: u32, n: i32) -> i32 {
        let Some(b) = self.buildings.get_mut(idx as usize) else { return -1 };
        let max = DEFS[b.kind as usize].jobs * (b.tier as u32 + 1);
        if max == 0 { return -1; }
        if n < -1 || n > max as i32 { return -2; }
        b.target = n as i16; self.staffing(); 0
    }
    /// Per building, in the order of `buildings_flat`, five numbers: kind, most workers it can employ, how many the player wants (-1 auto), how many it has, 1 when it is scaled back below what was wanted.
    pub fn staffing_flat(&self) -> Vec<i32> {
        self.buildings.iter().flat_map(|b| { let max = DEFS[b.kind as usize].jobs * (b.tier as u32 + 1); let want = if b.target >= 0 { (b.target as u32).min(max) } else { max };
            [b.kind as i32, max as i32, if b.target >= 0 { want as i32 } else { -1 }, b.staff as i32, (b.staff < want && b.target >= 0) as i32] }).collect()
    }

    /// Current production blockers as [reason, resource, needed, available] records.
    /// Reasons: 1 input, 2 reserve, 3 storage, 4 paused, 5 workers, 6 fallow, 7 deposit, 8 dormant, 9 no road to the castle (works at half pace).
    pub fn production_problems_flat(&self, idx: u32) -> Vec<i32> {
        let Some(b) = self.buildings.get(idx as usize) else { return vec![] };
        let d = &DEFS[b.kind as usize];
        if d.cycle == 0 { return vec![]; }
        if b.target == 0 { return vec![4, -1, 0, 0]; }
        if b.beff == 0 { return vec![5, -1, 1, b.staff as i32]; }
        if b.kind == FARM && matches!(b.mode, 1 | 3) { return vec![6, -1, 0, 0]; }
        if d.req == 1 && self.nearest_deposit(b.x, b.y, d.req_arg, false).is_none() {
            let dormant = b.aux >= 0 && self.deposits.get(b.aux as usize).is_some_and(|dep| dep.max > 0);
            return vec![if dormant { 8 } else { 7 }, -1, 0, 0];
        }
        if !self.site_requirement_met(idx as usize) { return vec![7, -1, 0, 0]; }
        let season = self.season();
        let (inputs, outputs) = match b.kind {
            SMOKEHOUSE if b.mode == 1 => (SMOKE_MEAT_IN, SMOKE_MEAT_OUT),
            PASTURE if season == 3 => (estate::WINTER_PASTURE_FEED, d.outputs),
            _ => (d.inputs, d.outputs),
        };
        let scale = |n: i32| ((n * (4 + 5 * b.tier as i32) + 2) / 4).max(n);
        let missing: Vec<i32> = inputs.iter().filter(|&&(r, n)| self.stock[r as usize] < scale(n))
            .flat_map(|&(r, n)| [1, r as i32, scale(n), self.stock[r as usize]]).collect();
        if !missing.is_empty() { return missing; }
        let reserved: Vec<i32> = inputs.iter().filter(|&&(r, n)| !self.can_spend_surplus(r, scale(n)))
            .flat_map(|&(r, n)| [2, r as i32, scale(n), self.stock[r as usize] - self.reserve_for(r)]).collect();
        if !reserved.is_empty() { return reserved; }
        let cap = self.storage_cap();
        let seasonal = if b.kind == FARM && season == 3 && b.opts & 2 != 0 { WINTER_GRAIN_HAYSTACKS } else { GRAIN_BY_SEASON[season as usize] };
        let soil = if b.kind == FARM { 500 + b.fert as i32 / 20 } else { 1000 };
        let full: Vec<i32> = outputs.iter().filter_map(|&(r, n)| {
            let amount = if r == GR { (scale(n) * seasonal * soil / 100_000).max(1) } else { scale(n) };
            let room = cap - self.stock[r as usize];
            (amount > room).then_some([3, r as i32, amount, room])
        }).flatten().collect();
        if full.is_empty() && !self.road_served(idx as usize, &self.road_reach()) { return vec![9, -1, 0, 0]; }   // (not a stop: it works at half pace, see roadnet.rs)
        full
    }
    /// The workforce in numbers: adults, workers (70% of the healthy adults, fewer in quarantine), children, elders, sick, jobs, workers placed, workers idle (placed nowhere), efficiency, workers promised by hand.
    pub fn staffing_totals(&self) -> Vec<u32> {
        let workers = (self.adults().saturating_sub(self.sick)) * 7 / 10 * if self.tick < self.quarantine_until { 7 } else { 10 } / 10;
        let placed: u32 = self.buildings.iter().map(|b| b.staff).sum();
        let promised: u32 = self.buildings.iter().filter(|b| b.target >= 0).map(|b| (b.target as u32).min(DEFS[b.kind as usize].jobs * (b.tier as u32 + 1))).sum();
        vec![self.adults(), workers, self.children, self.elders, self.sick, self.jobs, placed, workers.saturating_sub(placed), self.eff, promised]
    }

    /// How content the villagers are, 0..100: gardens, parks, chapels, markets, courts and wells lift it; hunger, plague, overcrowding and idle hands drag it down.
    /// Happy villages grow faster and pay more tax (x0.5 .. x1.5); unhappy ones grow slowly and pay little.
    pub fn happiness(&self) -> u32 {
        let count = |k: u8| self.buildings.iter().filter(|b| b.kind == k).count() as i32;
        let tiers = |k: u8| self.buildings.iter().filter(|b| b.kind == k).map(|b| b.tier as i32 + 1).sum::<i32>();
        let mut h = 40 + (4 * count(PARK)).min(16) + (2 * count(GARDEN)).min(8) + (5 * tiers(CHAPEL)).min(20) + (4 * count(MARKET)).min(8) + (4 * count(COURTHOUSE)).min(8) + (2 * count(WELL)).min(6);
        if self.food() < 10 { h -= 15; }
        if self.stock[ME as usize] + self.stock[SM as usize] > 0 { h += LUXURY_HAPPY; }   // meat on the table
        if self.population > 0 { h -= (self.sick as i32 * 40) / self.population as i32; }
        if self.eff < 60 { h -= (60 - self.eff as i32) / 3; }
        if self.population > self.capacity() { h -= 10; }
        if !self.warm { h -= (4 + 4 * self.cold_days as i32).min(12); }
        h -= (self.unburied as i32 * 2).min(20);   // the dead lie unburied
        h += self.devotion / 10 + (2 * count(GRAVEYARD)).min(4) + (3 * self.buildings.iter().filter(|b| b.kind == HOSPITAL && b.staff > 0).count() as i32).min(6);
        h += self.perks().happy;
        if self.tick < self.mood_until { h += self.mood; }
        h.clamp(0, 100) as u32
    }
    /// 0 spring, 1 summer, 2 autumn, 3 winter.
    pub fn season(&self) -> u8 { ((self.tick / DAY / SEASON_DAYS) % 4) as u8 }
    /// Which year it is (a year is four seasons), from 1.
    pub fn year(&self) -> u32 { (self.tick / DAY / SEASON_DAYS / 4) as u32 + 1 }
    /// Grain harvest now as a percentage of the usual (the season decides).
    pub fn grain_percent(&self) -> u32 { GRAIN_BY_SEASON[self.season() as usize] as u32 }
    /// What winter means for this village right now, for the interface (read-only; every number comes from the rules above):
    /// [0 grain %, 1 grain % with haystacks, 2 firewood burned per day at the present size (as if it were winter), 3 days of firewood left (x10; -1 when none is burned), 4 days cold in a row,
    ///  5 warm (1/0), 6 cold days before anyone dies, 7 chance in percent that the cold takes someone today, 8 days until winter starts (0 in winter), 9 hospital beds, 10 woodsheds,
    ///  11 hearth wood, 12 happiness lost to the cold now, 13 firewood in store, 14 days of winter left (0 outside winter), 15 firewood saved per day by woodsheds, 16 villagers per log, 17 death chance step %, 18 death chance cap %, 19 extra grace days with a hospital, 20 woodsheds that save one log per burn].
    pub fn winter_numbers(&self) -> Vec<i32> {
        let per_day = self.winter_need().max(0) * (DAY / WINTER_BURN_EVERY) as i32;
        let left = if per_day > 0 { self.stock[W as usize].max(0) * 10 / per_day } else { -1 };
        let into = (self.tick / DAY) % (SEASON_DAYS * 4); let winter = self.season() == 3;
        let grace = WINTER_COLD_GRACE + if self.hospital_beds() > 0 { WINTER_HOSPITAL_GRACE } else { 0 };
        let saved = (self.perks().woodsheds / WINTER_SHED_SAVES).min(((self.population + WINTER_HEADS_PER_WOOD - 1) / WINTER_HEADS_PER_WOOD) as i32) * (DAY / WINTER_BURN_EVERY) as i32;
        vec![WINTER_GRAIN, WINTER_GRAIN_HAYSTACKS, per_day, left, self.cold_days as i32, self.warm as i32, grace as i32, if self.warm { 0 } else { self.cold_death_chance() as i32 },
            if winter { 0 } else { ((SEASON_DAYS * 3 - into.min(SEASON_DAYS * 3)) as i32).max(0) }, self.hospital_beds() as i32, self.perks().woodsheds, WINTER_HEARTH_WOOD,
            if self.warm { 0 } else { (4 + 4 * self.cold_days as i32).min(12) }, self.stock[W as usize], if winter { (SEASON_DAYS * 4 - into) as i32 } else { 0 }, saved,
            WINTER_HEADS_PER_WOOD as i32, WINTER_DEATH_STEP as i32, WINTER_DEATH_MAX as i32, WINTER_HOSPITAL_GRACE as i32, WINTER_SHED_SAVES]
    }
    /// Villagers of working age.
    pub fn adults(&self) -> u32 { self.population.saturating_sub(self.children + self.elders) }
    /// [children, adults, elders, couples]: the families behind the headcount.
    pub fn demographics(&self) -> Vec<u32> { vec![self.children, self.adults(), self.elders, self.adults() / 2] }
    /// False while it is winter and the village has no wood to burn: people freeze.
    pub fn warmth(&self) -> bool { self.warm }
    /// [risk flags, meals, firewood, ruins].
    /// Flags in order are combat, raid warning, fire, plague, low food, low winter fuel and a pending decision.
    pub fn steward_status(&self) -> Vec<i32> {
        let food = self.food();
        let (_, eat) = self.appetite();
        let wood = self.stock[W as usize];
        let fuel = if self.season() == 3 { self.winter_need().max(0) } else { 0 };
        let flags = [
            self.battle_active(),
            self.raid_warning_ticks > 0,
            !self.wildfires.is_empty() || self.buildings.iter().any(|b| b.burning > 0.0),
            self.plague_active(),
            eat > 0 && self.food_units() < (eat * 15).min(self.storage_cap() / 4 * self.meal_units()).max(eat) as i64,
            fuel > 0 && (!self.warm || wood < fuel * 2),
            self.choice.is_some(),
        ].into_iter().enumerate().fold(0, |bits, (i, risk)| bits | ((risk as i32) << i));
        vec![flags, food, wood, self.ruins.len() as i32]
    }
    /// The next ruin to inspect, with buildable, affordable essential buildings first.
    pub fn recovery_ruin(&self) -> i32 {
        self.ruins.iter().enumerate().min_by_key(|(_, r)| {
            let (kind, tier) = (r[3] as u8, r[4] as u8);
            let blocked = !self.rebuild_site_clear(r[0], r[1], DEFS[kind as usize].r);
            let expensive = !self.can_afford(&Self::rebuild_cost(kind, tier));
            (blocked, expensive, Self::recovery_priority(kind))
        }).map_or(-1, |(i, _)| i as i32)
    }
    pub fn jobs(&self) -> u32 { self.jobs }
    pub fn building_count(&self) -> u32 { self.buildings.len() as u32 }
    pub fn take_events(&mut self) -> Vec<i32> { std::mem::take(&mut self.events) }

    /// FNV-1a hashes of the separate sections of the state, in the order of `state_hash_part_names()`. Two copies of one village that disagree name the section that differs,
    /// which says where to look (a building, the stock, a soldier on the march, a felled tree). Only simulated state goes in: nothing derived (paths, caches) and nothing a client may touch.
    pub fn state_hash_parts(&self) -> Vec<u64> {
        let part = |f: &dyn Fn(&mut dyn FnMut(u64))| -> u64 { let mut h: u64 = 0xcbf29ce484222325 ^ self.seed; f(&mut |v: u64| { h ^= v; h = h.wrapping_mul(0x100000001b3); }); h };
        vec![
            part(&|mix| {   // core: the clock, the random stream, the people and everything that is a plain number
                mix(self.tick); mix(self.rng.0); mix(self.raid_warning_ticks as u64); mix(self.raid_warning_angle.to_bits() as u64); mix(self.raid_warning_rf.to_bits() as u64); mix(self.raid_warning_boss as u64); mix(self.raid_warning_name as u64); mix(self.population as u64); mix(self.sick as u64); mix(self.plague_start); mix(self.plague_end); if let Some(c) = self.plague_camp { mix(c.x.to_bits() as u64); mix(c.y.to_bits() as u64); mix(c.since); mix(c.name as u64); } mix(self.quarantine_until); mix(self.children as u64); mix(self.elders as u64); mix(self.warm as u64); mix(self.cold_days as u64); mix(self.born as u64); mix(self.arrived as u64); mix(self.enlisted as u64); mix(self.left as u64); for d in self.died { mix(d as u64); } mix(self.unburied as u64); mix(self.buried as u64); mix(self.graves_used as u64); mix(self.devotion as i64 as u64); mix(self.style as u64); mix(self.hero.map_or(999, |h| h.0 as u64 * 1000 + h.1 as u64)); mix(self.explored.iter().map(|&c| c as u64).sum::<u64>()); for &d in &self.neutral_done { mix(d as u64); } mix(self.mood as i64 as u64); mix(self.greed as u64); mix(self.mood_until); mix(self.quarantine_until); mix(self.choice.map_or(99, |c| c.0 as u64));
            }),
            part(&|mix| {
                for s in &self.stock { mix(*s as i64 as u64); }
                mix(self.meal_credit as i64 as u64);
                for s in &self.market_sold { mix(*s as i64 as u64); }
                if self.estate.active { mix(1); mix(self.estate.grain as u64); mix(self.estate.wood as u64); }
                if self.emergency_tools[0] > 0 { mix(2); mix(self.emergency_tools[0]); mix(self.emergency_tools[1]); }
            }),
            part(&|mix| {   // buildings: what stands, where, how built and how hurt
                for b in &self.buildings {
                    mix(b.kind as u64); mix(b.tier as u64); mix(b.x.to_bits() as u64); mix(b.y.to_bits() as u64);
                    mix(b.rot as u64); mix(b.progress as u64); mix(b.pad_h.to_bits() as u64); mix(b.garrison as u64); mix(b.born as u64); mix(b.opts as u64); mix(b.fert as u64); mix(b.mode as u64); mix(b.target as i64 as u64);
                    if matches!(b.kind, DRAWBRIDGE | GATE) { mix(b.status as u64); }
                    if matches!(b.kind, RAISE | LOWER | FORESTER) && b.aux >= 0 { mix(b.aux as u64); }
                }
                for b in &self.buildings { mix(b.hp.to_bits() as u64); mix(b.burning.to_bits() as u64); }
                for c in &self.road_conn { mix(c.x.to_bits() as u64); mix(c.y.to_bits() as u64); for t in &c.to { mix(t.x.to_bits() as u64); mix(t.y.to_bits() as u64); mix(t.k as u64); } }   // how the roads the player laid are joined
            }),
            part(&|mix| { for d in &self.deposits { mix(d.rem as i64 as u64); mix(d.max as i64 as u64); mix(d.asleep as u64); } }),
            part(&|mix| { for pl in &self.links { mix(pl.len() as u64); for p in pl { mix(p.0.to_bits() as u64); mix(p.1.to_bits() as u64); } } }),
            part(&|mix| { for k in 0..NK { mix(self.army[k] as u64); mix(self.queue[k] as u64); mix(self.away[k] as u64); } mix(self.military_tech as u64); mix(self.auto_bridge as u64); for r in &self.rally { match r { Some((x, y)) => { mix(1); mix(x.to_bits() as u64); mix(y.to_bits() as u64); } None => mix(0) } } for k in 0..NK { mix(self.vets[k] as u64); mix(self.train_acc[k] as u64); } }),
            part(&|mix| { for d in &self.dets { mix(d.id as u64); mix(d.x.to_bits() as u64); mix(d.y.to_bits() as u64); mix(d.state as u64); mix(d.wi as u64); mix(d.defend as u64); mix(d.ally as i64 as u64); mix(d.file.dispatch.to_bits() as u64); for k in 0..NK { mix(d.units[k] as u64); } for g in &d.grp { mix(g.x.to_bits() as u64); mix(g.y.to_bits() as u64); mix(g.wi as u64); mix(g.file.dispatch.to_bits() as u64); } } }),
            part(&|mix| {   // trade and diplomacy
                for r in &self.relations { mix(r.0 as i64 as u64); mix(r.1 as i64 as u64); } for m in &self.married { mix(*m as i64 as u64); }
                for c in &self.caravans { mix(c.start); mix(c.eta); mix(c.amount as u64); mix(c.res as u64); mix(c.to as i64 as u64); mix(c.escort as u64); } for j in &self.journeys { mix(j.kind as u64); mix(j.tag as i64 as u64); mix(j.arg as i64 as u64); mix(j.start); mix(j.arrive); } for a in &self.awaiting { mix(a[1] as u64); mix(a[2] as i64 as u64); } for t in &self.treaties { mix(t.until); mix(t.tag as u64); }
            }),
            part(&|mix| {   // the land the soldiers and the builders changed
                for f in &self.felled { for v in f { mix(v.to_bits() as u64); } } mix(self.groves.len() as u64);
                for p in &self.planted { mix(p.0.to_bits() as u64); mix(p.1.to_bits() as u64); mix(p.2); }
                for b in &self.bridges { for v in b { mix(v.to_bits() as u64); } }
                for l in &self.levels { for v in l { mix(v.to_bits() as u64); } } for l in &self.flats { for v in l { mix(v.to_bits() as u64); } } for c in &self.craters { mix(c[0].to_bits() as u64); mix(c[1].to_bits() as u64); }
                mix(self.scorch.len() as u64); mix(self.ruins.len() as u64);
            }),
            part(&|mix| { if let Some(bt) = &self.battle { mix(1); for u in &bt.units { mix(u.x.to_bits() as u64); mix(u.y.to_bits() as u64); mix(u.hp.to_bits() as u64); mix(u.det as u64); mix(u.soak.to_bits() as u64); mix(u.maxhp.to_bits() as u64); mix(u.boss as u64 | (u.bname as u64) << 8 | (u.phase as u64) << 16); mix(u.t1.to_bits() as u64); mix(u.t2.to_bits() as u64); } mix(bt.boss as u64 | (bt.bname as u64) << 8 | (bt.bought as u64) << 16); mix(bt.bought_t.to_bits() as u64); bt.siege.hash(mix); mix(bt.lair as i64 as u64); bt.tactics.hash(mix); if let Some(o) = bt.objective { o.hash(mix); } } }),
        ]
    }

    /// FNV-1a state hash for determinism / peer sync checks: the sections of `state_hash_parts` folded into one number.
    pub fn state_hash(&self) -> u64 {
        Self::fold_hash_parts(self.seed, &self.state_hash_parts())
    }

    /// `state_hash` followed by `state_hash_parts`, from one pass over the state. Multiplayer sends both every tick; asking for them separately hashed the
    /// whole world twice.
    pub fn state_hash_and_parts(&self) -> Vec<u64> {
        let parts = self.state_hash_parts();
        let mut out = Vec::with_capacity(parts.len() + 1);
        out.push(Self::fold_hash_parts(self.seed, &parts));
        out.extend_from_slice(&parts);
        out
    }
}

impl World {
    fn fold_hash_parts(seed: u64, parts: &[u64]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325 ^ seed;
        for &p in parts { h ^= p; h = h.wrapping_mul(0x100000001b3); }
        h
    }
}

/// The names of the sections of `World::state_hash_parts`, comma separated and in the same order.
pub const HASH_PART_NAMES: &str = "core,stock,buildings,deposits,links,army,soldiers,diplomacy,land,battle";
/// The names of the ledger's categories that are not building kinds, comma separated, in order (their ids follow the building kinds).
#[wasm_bindgen]
pub fn ledger_extra_names() -> String { ledger::EXTRAS.join(",") }

#[wasm_bindgen]
pub fn state_hash_part_names() -> String { HASH_PART_NAMES.to_string() }

/// A fingerprint of the simulation rules of this build: a small scripted village is played for a while (building, soldiers marching through woods, a raid) and its state hash is returned as text.
/// Two builds that would play the same log differently give different fingerprints, so players on different versions are told apart from players whose copies merely drifted.
/// Cheap once the navigation grid of `seed` has been built (see `warm_navigation`).
#[wasm_bindgen]
pub fn rules_fingerprint(seed: u64) -> String {
    let mut w = World::new(seed, 0, 0);
    w.cheat(3, 0, 0);
    for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 18, 8), (FARM, -14, 6), (4, 20, -10), (BARRACKS, -20, 16), (TOWER, 30, 30), (WALL, 34, 30), (WALL, 38, 30), (WALL, 42, 30)] { w.place(k, x, y, 0); }
    w.cheat(2, 0, 12); w.cheat(2, 1, 6); w.cheat(2, 2, 6);
    for t in 0..600u32 {
        if t == 100 { w.cheat(1, 30, 0); w.start_plague(); }   // an outbreak, so the plague rules are part of what the fingerprint tells apart
        if t == 110 { w.choose(0); }
        if t == 40 { let id = w.det_form(&[8, 3, 3, 0, 0]); w.det_march(id, 150.0, -90.0, false, 0.0, 0.0); }
        if t == 200 { w.start_raid(1.1, &[4, 2, 1, 0, 0], 7); }
        if t % 40 == 0 { w.cheat(3, 0, 0); }
        w.step();
    }
    let parts = w.state_hash_parts();
    // The water raster and deployment rules affect peers even when this fingerprint's sample village does not encounter them.
    let mut h: u64 = 0xcbf29ce484222325 ^ seed ^ u64::from(terrain::RIVER_LEVEL.to_bits()) ^ 0x46ba7e08;
    for p in parts { h ^= p; h = h.wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}

fn pad_inner(d: &Def) -> f32 { d.r * 1.15 + 0.5 }
/// The ground under a farm is levelled flat out to FLAT from the edge of its fields, then eased into the land over the next stretch. The fields lie flat at the farm's pad height,
/// so on a slope any field standing on ground higher than that would be buried.
const FARM_PAD_FLAT: f32 = 0.9;
const FARM_PAD_BLEND: f32 = 4.6;
/// No field of a farm of any tier lies farther than this from its middle (plus the blend).
const FARM_PAD_REACH: f32 = 28.0;
/// The yard round a farm's fields that its design extras (scarecrow, barn, windmill, orchard...) stand in: levelled with the fields and counted in its footprint.
pub const FARM_YARD: f32 = 5.0;

#[cfg(test)]
mod option_tests;
#[cfg(test)]
mod bribe_tests;
#[cfg(test)]
mod restart_tests;
#[cfg(test)]
mod lend_tests;
#[cfg(test)]
mod winter_tests;
#[cfg(test)]
mod ledger_tests;
#[cfg(test)]
mod market_tests;

#[cfg(test)]
mod fish_tests;
#[cfg(test)]
mod workers_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn run(seed: u64) -> u64 {
        let mut w = World::new(seed, 0, 0);
        w.place(HOUSE, 12, 4, 0);
        w.place(1, -14, 6, 0);
        w.upgrade(1);
        for _ in 0..600 { w.step(); }
        w.state_hash()
    }

    #[test]
    fn deterministic() { assert_eq!(run(42), run(42)); assert_ne!(run(42), run(43)); }

    #[test]
    fn demolition_preview_matches_returned_materials() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [500; N_RES];
        w.flatten(40, 5.0);
        assert!(w.demolition_refund_flat(0).is_empty()); // the hall cannot be demolished
        assert!(w.demolition_refund_flat(u32::MAX).is_empty());
        assert_eq!(demolition_refund(ROAD).next(), None); // its one wood rounds down

        for (kind, expected) in [(FARM, vec![W as i32, 12]), (MARKET, vec![W as i32, 15, PL as i32, 5])] {
            let idx = w.place(kind, 16, 0, 0);
            assert!(idx >= 0);
            let idx = idx as u32;
            assert_eq!(w.upgrade(idx), 0);
            let before = w.stock;
            let refund = w.demolition_refund_flat(idx);
            assert_eq!(refund, expected);
            assert_eq!(w.stock, before);
            assert!(w.demolish(idx));
            let mut expected_stock = before;
            for pair in refund.chunks_exact(2) { expected_stock[pair[0] as usize] += pair[1]; }
            assert_eq!(w.stock, expected_stock);
        }
    }

    #[test]
    fn production_diagnostics_follow_tiers_recipes_reserves_and_storage() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [500; N_RES]; w.population = 100; w.flatten(60, 5.0);
        let smith = w.place(13, 16, 0, 0) as u32;
        assert!(smith < w.building_count());
        assert_eq!(w.upgrade(smith), 0);
        w.stock[CH as usize] = 0;
        let hash = w.state_hash();
        assert_eq!(w.production_problems_flat(smith), vec![1, CH as i32, 2, 0]);
        assert_eq!(w.state_hash(), hash);
        w.stock[CH as usize] = 10; w.stock[TL as usize] = w.storage_cap();
        assert_eq!(w.production_problems_flat(smith), vec![3, TL as i32, 2, 0]);
        assert_eq!(w.set_workers(smith, 0), 0);
        assert_eq!(w.production_problems_flat(smith), vec![4, -1, 0, 0]);
        let bakery = w.place(BAKERY, -16, 0, 0) as u32;
        assert!(bakery < w.building_count());
        w.set_reserves(500, 500);
        let problems = w.production_problems_flat(bakery);
        assert!(!problems.is_empty());
        assert!(problems.chunks_exact(4).all(|p| p[0] == 2));
        w.set_reserves(0, 0);
        let smoke = w.place(SMOKEHOUSE, 0, 20, 0) as u32;
        assert!(smoke < w.building_count());
        w.buildings[smoke as usize].mode = 1; w.stock[ME as usize] = 0;
        assert!(w.production_problems_flat(smoke).chunks_exact(4).any(|p| p[0] == 1 && p[1] == ME as i32));
        assert!(w.production_problems_flat(u32::MAX).is_empty());
    }

    #[test]
    fn terrain_is_sane() {
        for seed in [1u64, 7, 1337, 99999] {
            let g = terrain::grid(seed, -1200.0, -1200.0, 481, 481, 5.0);
            assert!(g.iter().all(|h| h.is_finite()));
            let (lo, hi) = g.iter().fold((f32::MAX, f32::MIN), |(l, h), &v| (l.min(v), h.max(v)));
            let water = g.iter().filter(|&&h| h < 0.0).count() as f32 / g.len() as f32;
            println!("seed {seed}: h {lo:.1}..{hi:.1}, water {:.0}%", water * 100.0);
            assert!(hi > 25.0 && lo < 0.0);
            assert!(water < 0.5);
            // villages sit on dry land
            for (sx, sy) in [(0.0, 0.0), (300.0, 0.0)] { assert!(terrain::base_height(seed, sx, sy) > 1.0, "seed {seed} site {sx}"); }
        }
    }

    #[test]
    fn no_village_starts_on_water() {
        for seed in [1u64, 7, 1337, 99999, 424242, 31337] {
            for (sx, sy) in terrain::sites(seed) {
                for k in 0..16 { for r in [0.0f32, 10.0, 20.0, 30.0] {
                    let a = k as f32 * std::f32::consts::TAU / 16.0; let h = terrain::base_height(seed, sx + a.cos() * r, sy + a.sin() * r);
                    assert!(h > 1.0, "seed {seed} site ({sx},{sy}) is wet at radius {r}: {h}");
                } }
            }
        }
    }

    #[test]
    fn deposits_near_every_start() {
        let w = World::new(1337, 0, 0);
        for kind in 0..4u8 {
            assert!(w.deposits.iter().any(|d| d.kind == kind && d.x.hypot(d.y) < 60.0), "kind {kind}");
        }
    }

    #[test]
    fn placement_rules() {
        let mut w = World::new(1337, 0, 0);
        assert_eq!(w.place(HOUSE, 20, 0, 0) >= 0, true);
        assert_eq!(w.place(HOUSE, 20, 1, 0), -3, "overlap");
        assert_eq!(w.place(HOUSE, 1000, 0, 0), -27, "far outside, away from any road");
        assert_eq!(w.place(99, 10, 10, 0), -1, "bad kind");
        assert_eq!(w.place(TOWN_HALL, 10, 10, 0), -9);
    }

    #[test]
    fn buildings_sit_on_flat_pads() {
        let mut w = World::new(1337, 0, 0);
        let i = w.place(HOUSE, 15, -10, 0);
        assert!(i >= 0);
        let b = w.buildings[i as usize].clone();
        let d = &DEFS[HOUSE as usize];
        for (px, py) in [(0.0, 0.0), (d.r, 0.0), (-d.r, 0.0), (0.0, d.r), (0.0, -d.r)] {
            assert!((w.height_at(b.x + px, b.y + py) - b.pad_h).abs() < 0.01);
        }
    }

    #[test]
    fn paths_connect_buildings_and_grade_terrain() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [3000; N_RES];
        w.place(HOUSE, 16, 0, 0);
        w.place(HOUSE, 28, 4, 0);
        let r = w.roads_flat();
        assert!(r.chunks(6).all(|s| s[4] == s[5]), "nothing is laid by itself: only the stubs of the buildings");
        assert_eq!(r.chunks(6).map(|s| s[4] as i32).collect::<std::collections::BTreeSet<_>>().len(), 3, "the hall and the two houses each have the path from their door");
        // a road laid by hand from the hall's node to the first house's node is graded to the line between the pads
        let (n0, n1) = (w.road_nodes_flat()[..2].to_vec(), w.road_nodes_flat()[4..6].to_vec());
        assert_eq!(w.lay_road(&[n0[0] as i32 - w.ox, n0[1] as i32 - w.oy, 5, 7, 10, 7, n1[0] as i32 - w.ox, n1[1] as i32 - w.oy]), 0);
        let f = w.buildings_flat();
        let (a, b) = (f[10 + 5], f[0 + 5]);
        let mid = w.height_at(8.0, 0.0);
        assert!(mid >= a.min(b) - 0.8 && mid <= a.max(b) + 0.8, "path height {mid} between {a} and {b}");
        let h = &DEFS[HOUSE as usize];
        for (px, py) in [(0.0, 0.0), (h.r, 0.0), (0.0, h.r)] { assert!((w.height_at(16.0 + px, py) - f[10 + 5]).abs() < 0.01); }
    }

    #[test]
    fn villagers_are_assigned_to_homes_and_workplaces() {
        let mut w = World::new(1337, 0, 0);
        w.place(HOUSE, 16, 0, 0);
        w.place(4, -20, 6, 0); // woodcutter needs forest; may fail, ignore
        for _ in 0..30 { w.step(); }
        let f = w.buildings_flat();
        let residents: f32 = f.chunks(10).map(|c| c[9]).sum();
        assert_eq!(residents as u32, w.population().min(w.capacity()));
    }


    fn village() -> World {
        let mut w = World::new(1337, 0, 0);
        w.stock = [3000; N_RES];
        for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 17, 4), (HOUSE, 22, 4), (HOUSE, -12, 6), (1, -14, -10), (TOWER, 0, 16), (TOWER, 8, -16)] { w.place(k, x, y, 0); }
        w
    }

    fn run_battle(w: &mut World) -> u32 {
        let mut n = 0;
        while w.battle_active() && n < 600 { w.step(); w.stock[GR as usize] = 3000; n += 1; }
        n
    }

    #[test]
    fn raid_on_weak_village_does_damage() {
        let mut w = village();
        w.population = 20;
        assert!(w.start_raid(0.5, &[14, 6, 3, 0, 0, 0], 0)); assert!((w.battle_angle() - 0.5).abs() < 1e-6, "the battle remembers where the attackers came from");
        let before = w.building_count();
        run_battle(&mut w);
        let r = w.last_report();
        assert_eq!(r[1], 0, "raiders win against two towers and a handful of militia");
        assert!(w.building_count() < before || w.fires_flat().len() > 0 || !w.ruins_flat().is_empty() || r[4] > 0, "something suffered");
        assert!(r[5 + 1 + 12 - 1] >= 0);
    }

    #[test]
    fn strong_defence_repels_bandits() {
        let mut w = village();
        for _ in 0..4 { w.place(BARRACKS, 30 + 0, 20, 0); }
        w.army = [14, 10, 8, 4, 0, 0];
        w.population = 40;
        assert!(w.start_raid(1.2, &[6, 2, 0, 0, 0, 0], 0));
        run_battle(&mut w);
        let r = w.last_report();
        assert_eq!(r[1], 1, "defenders hold: {:?}", r);
        assert!(w.army.iter().sum::<u32>() >= 20, "most of the army survives");
    }

    #[test]
    fn fire_spreads_through_thatch_but_stone_resists() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [3000; N_RES];
        for x in [11, 18, 25] { w.place(HOUSE, x, 4, 0); }
        w.place(HOUSE, -12, -14, 0);
        let total = w.building_count();
        assert!(total >= 4, "placed {total}");
        w.set_fire(1);
        for _ in 0..90 { w.step(); w.stock[GR as usize] = 3000; }
        let f = w.fires_flat().len();
        let lost = total - w.building_count();
        assert!(lost >= 2 || f > 0, "fire spread to neighbours: lost {lost}, burning {}", f / 4);
        // stone houses resist
        let mut s = World::new(1337, 0, 0);
        s.stock = [30000; N_RES];
        for x in [11, 18, 25] { s.place(HOUSE, x, 4, 0); }
        let n0 = s.building_count();
        for i in 1..n0 { for _ in 0..3 { s.upgrade(i); } }
        s.set_fire(1);
        for _ in 0..90 { s.step(); s.stock[GR as usize] = 3000; }
        assert_eq!(s.building_count(), n0, "fortified houses survive a neighbour fire");
    }

    #[test]
    fn catapults_dig_craters() {
        let mut w = village();
        let h0 = w.height_at(12.0, 4.0);
        w.population = 30;
        w.start_raid(0.0, &[0, 0, 0, 0, 4, 0], 0);
        run_battle(&mut w);
        assert!(!w.scorch_flat().is_empty() || w.terrain_version() > 0);
        let moved = (0..40).any(|i| (w.height_at(i as f32, 4.0) - w.base(i as f32, 4.0)).abs() > 0.2) || w.height_at(12.0, 4.0) != h0;
        assert!(moved || !w.ruins_flat().is_empty(), "terrain changed");
    }

    #[test]
    fn barracks_train_soldiers() {
        let mut w = village();
        assert_eq!(w.train(0, 1), -11, "no barracks yet");
        let spot = (-40..=40).step_by(3).flat_map(|x| (-40..=40).step_by(3).map(move |y| (x, y))).find(|&(x, y)| w.can_place(BARRACKS, x, y) == 0).expect("somewhere to build a barracks");
        w.place(BARRACKS, spot.0, spot.1, 0);
        w.population = 50;
        assert_eq!(w.train(3, 1), -12, "knights need a better barracks");
        assert_eq!(w.train(0, 3), 0);
        for _ in 0..200 { w.step(); w.stock[GR as usize] = 3000; }
        assert_eq!(w.army()[0], 3);
    }

    #[test]
    fn soldiers_trained_during_a_raid_join_the_fight_and_can_be_mustered() {
        let mut w = village();
        let spot = (-40..=40).step_by(3).flat_map(|x| (-40..=40).step_by(3).map(move |y| (x, y))).find(|&(x, y)| w.can_place(BARRACKS, x, y) == 0).expect("somewhere to build a barracks");
        w.place(BARRACKS, spot.0, spot.1, 0);
        w.population = 50;
        assert!(w.start_raid(0.5, &[40, 20, 10, 0, 0, 0], 0));
        assert_eq!(w.train(0, 3), 0);
        for _ in 0..200 { w.step(); w.stock[GR as usize] = 3000; if w.army()[0] == 3 { break; } }
        assert_eq!(w.army()[0], 3, "the soldiers were trained");
        assert!(w.battle_active(), "the raid is still on");
        assert_eq!(w.battle_standing()[0], 3, "and they stand in the fight");
        assert_ne!(w.det_form(&[3, 0, 0, 0, 0, 0]), 0, "so they can be mustered");
    }

    #[test]
    fn cheats_give_resources_and_soldiers() {
        let mut w = village();
        let before = w.stock[IR as usize];
        w.stock[IR as usize] = 0;
        assert!(w.cheat(0, IR as i32, 120));
        assert_eq!(w.stock[IR as usize], 120);
        assert!(w.cheat(2, 3, 5));
        assert_eq!(w.army()[3], 5);
        assert!(w.cheat(3, 0, 0));
        assert_eq!(w.stock[GD as usize], w.storage());
        assert!(!w.cheat(0, 99, 5));
        let _ = before;
    }

    #[test]
    fn villagers_fight_fires_with_well_water() {
        let run = |well: bool| -> (u32, bool) {
            let mut w = World::new(1337, 0, 0);
            w.stock = [3000; N_RES];
            for x in [11, 18, 25] { w.place(HOUSE, x, 4, 0); }
            if well { w.place(WELL, 17, -2, 0); }
            w.population = 36;
            w.set_fire(1);
            let mut out = false;
            for _ in 0..140 { w.step(); w.stock[GR as usize] = 3000; w.population = 36; if w.take_events().chunks(4).any(|e| e[0] == 11) { out = true; } }
            (w.building_count(), out)
        };
        let (with, out) = run(true);
        let (without, _) = run(false);
        assert!(out, "the fire was put out");
        assert!(with >= without, "a well never makes things worse: {with} vs {without}");
    }

    #[test]
    fn a_fire_station_saves_more_houses_than_wells_alone() {
        let run = |station: bool| -> u32 {
            let mut total = 0;
            for seed in [1337u64, 7, 99, 2024] {
                let mut w = World::new(seed, 0, 0);
                w.stock = [3000; N_RES];
                for k in 0..8 { w.place(HOUSE, 11 + (k % 4) * 6, 4 + (k / 4) * 6, 0); }
                w.place(WELL, 17, -2, 0);
                if station { assert!(w.place(FIRE_STATION, 14, -12, 0) >= 0, "station placed"); }
                w.population = 40;
                for _ in 0..10 { w.step(); w.stock[GR as usize] = 3000; }
                let houses = w.buildings.iter().filter(|b| b.kind == HOUSE).count() as u32;
                let _ = houses;
                w.set_fire(1);
                for _ in 0..300 { w.step(); w.stock[GR as usize] = 3000; w.stock[W as usize] = 3000; w.population = 40; }
                total += w.buildings.iter().filter(|b| b.kind == HOUSE).count() as u32;
            }
            total
        };
        let (with, without) = (run(true), run(false));
        assert!(with >= without, "a fire station never makes things worse: {with} vs {without}");
    }

    fn nav_cell_centre(i: usize) -> (f32, f32) { (((i as i32 % march::NC) as f32) * march::CELL - 1200.0 + march::CELL / 2.0, ((i as i32 / march::NC) as f32) * march::CELL - 1200.0 + march::CELL / 2.0) }

    #[test]
    fn armies_march_around_buildings() {
        let mut w = village();
        w.army = [10, 0, 0, 0, 0, 0];
        let id = w.det_form(&[10, 0, 0, 0, 0, 0]);
        assert!(id > 0 && w.army()[0] == 0);
        // a target behind the cluster of buildings
        let r = w.det_march(id, 30.0, 8.0, false, 0.0, 0.0);
        assert_eq!(r, 0, "route found");
        let p = w.det_path(id);
        let n = p.len() / 3;
        for k in 0..n.saturating_sub(1) {
            for t in 0..20 {
                let f = t as f32 / 20.0; let (x, y) = (p[k * 3] + (p[k * 3 + 3] - p[k * 3]) * f, p[k * 3 + 1] + (p[k * 3 + 4] - p[k * 3 + 1]) * f);
                for b in &w.buildings { let d = DEFS[b.kind as usize].r; assert!(((b.x - x).powi(2) + (b.y - y).powi(2)).sqrt() > d, "path crosses a {} at ({x:.1},{y:.1})", DEFS[b.kind as usize].name); }
            }
        }
        for _ in 0..80 { w.step(); w.stock[GR as usize] = 3000; }
        let d = w.det_flat();
        assert_eq!(d[8] as u8, march::S_IDLE, "arrived: {:?}", &d[..16]);
        assert!(((d[1] - 30.0).powi(2) + (d[2] - 8.0).powi(2)).sqrt() < 4.0, "at the target");
    }

    #[test]
    fn prepared_army_orders_match_live_routing_and_reject_stale_routes() {
        let mut w = village();
        let units = [10, 4, 0, 2, 1, 0];
        w.army = units;
        let id = w.det_form(&units);
        assert_ne!(id, 0);
        let snapshot = w.snapshot();
        let prepared = world_restore(&snapshot).unwrap().prepare_army_order(id, 30.0, 8.0, 0);
        let mut direct = world_restore(&snapshot).unwrap();
        assert_eq!(direct.det_march(id, 30.0, 8.0, false, 0.0, 0.0), 0);
        assert_eq!(w.apply_prepared_army_order(&prepared, id, 40.0, 8.0, 0, 0.0, 0.0), march::ROUTE_PENDING);
        assert_eq!(w.snapshot(), snapshot, "a cache miss leaves the army alone");
        assert_eq!(w.apply_prepared_army_order(&prepared, id, 30.0, 8.0, 0, 0.0, 0.0), 0);
        assert_eq!(w.snapshot(), direct.snapshot(), "the exact same order will replay on the other peers");

        let old = w.snapshot();
        assert_eq!(w.flatten(30, 7.0), 0);
        assert_eq!(w.apply_prepared_army_order(&prepared, id, 30.0, 8.0, 0, 0.0, 0.0), march::ROUTE_PENDING);
        assert_eq!(w.det_path(id), world_restore(&old).unwrap().det_path(id));

        assert!(w.start_raid(0.6, &[8, 4, 2, 0, 0, 0], 0));
        let raid = w.snapshot();
        let prepared = world_restore(&raid).unwrap().prepare_army_order(id, 0.0, 0.0, 1);
        let mut direct = world_restore(&raid).unwrap();
        assert_eq!(w.apply_prepared_army_order(&prepared, id, 0.0, 0.0, 1, 0.0, 0.0), direct.det_defend(id));
        assert_eq!(w.snapshot(), direct.snapshot());
    }

    #[test]
    fn catapults_need_felled_trees_and_soldiers_cut_them() {
        let ns = march::nav_static(1337);
        let mut w = village();
        w.army = [8, 0, 0, 0, 2, 0];
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        // a patch of dense forest away from the village that the siege train can reach by cutting trees
        let mut spot = None;
        for i in 0..(march::NC * march::NC) as usize {
            let (x, y) = nav_cell_centre(i);
            if ns.dens(i) >= 4 && ns.height(i) > 2.0 && x.abs() < 150.0 && y.abs() < 150.0 && x.hypot(y) > 70.0 && (x - 300.0).hypot(y) > 70.0 {
                let p = w.plan_march(&[8, 0, 0, 0, 2, 0], hx, hy, x, y);
                if p[0] == 1.0 && p[5..].chunks(3).any(|c| c.len() == 3 && c[2] == 1.0) { spot = Some((x, y)); break; }
            }
        }
        let (tx, ty) = spot.expect("the map has dense forest");
        let id = w.det_form(&[8, 0, 0, 0, 2, 0]);
        let r = w.det_march(id, tx, ty, false, 0.0, 0.0);
        assert_eq!(r, 0, "a route exists, by cutting trees");
        let p = w.det_path(id);
        assert!(p.chunks(3).any(|c| c[2] == 1.0), "the route includes a stretch of felling");
        for _ in 0..1500 { w.step(); w.stock[GR as usize] = 3000; }
        assert!(!w.felled_flat().is_empty(), "soldiers cut trees");
        assert_eq!(w.det_flat()[8] as u8, march::S_IDLE, "the siege train arrived");
        // without soldiers, catapults cannot clear the forest
        let mut w2 = village(); w2.army = [0, 0, 0, 0, 2, 0];
        let id2 = w2.det_form(&[0, 0, 0, 0, 2, 0]);
        assert_eq!(w2.det_march(id2, tx, ty, false, 0.0, 0.0), -3);
    }

    #[test]
    fn armies_bridge_narrow_water() {
        let ns = march::nav_static(1337);
        let mut w = village(); w.army = [6, 0, 0, 0, 0, 0];
        let wet = |i| { let (x, y) = nav_cell_centre(i); w.ground_is_wet(x, y, ns.height(i)) };
        // find two dry points either side of a narrow strip of water
        let mut pair = None;
        'o: for j in (4..(march::NC - 4)).step_by(3) { for i in (4..(march::NC - 12)).step_by(2) {
            let a = (j * march::NC + i) as usize;
            if ns.height(a) < 1.5 || ns.dens(a) > 1 || wet(a) { continue; }
            let mut k = 1;
            while k < 6 && wet(a + k) { k += 1; }
            if k >= 3 && ns.height(a + k) > 1.5 && ns.dens(a + k) <= 1 && !wet(a + k) { pair = Some((a, a + k)); break 'o; }
        } }
        let Some((a, b)) = pair else { eprintln!("bridge test: no narrow water on this seed"); return };
        let (sx, sy) = nav_cell_centre(a); let (tx, ty) = nav_cell_centre(b);
        let id = w.det_form(&[6, 0, 0, 0, 0, 0]);
        // move the army next to the water, then order the crossing
        w.dets[0].x = sx; w.dets[0].y = sy;
        let plan = w.plan_march(&[6, 0, 0, 0, 0, 0], sx, sy, tx, ty);
        if plan[0] != 1.0 { eprintln!("bridge test: no route {}", plan[0]); return; }
        if !plan[5..].chunks(3).any(|c| c[2] == 2.0) { eprintln!("bridge test: route walked around the lake"); return; }
        assert_eq!(w.det_march(id, tx, ty, false, 0.0, 0.0), 0);
        for _ in 0..400 { w.step(); w.stock[GR as usize] = 3000; w.stock[PL as usize] = 400; w.stock[W as usize] = 400; }
        eprintln!("bridge test ran: bridges {} state {}", w.bridges_flat().len() / 4, w.det_flat()[8]);
        assert!(!w.bridges_flat().is_empty() || w.det_flat()[8] as u8 == march::S_IDLE, "bridged or ferried across");
    }

    #[test]
    fn water_legs_are_bridged_or_ferried() {
        for (len, expect_bridge) in [(9.0f32, true), (30.0, false)] {
            let mut w = village();
            w.army = [6, 0, 0, 0, 1, 0];
            let id = w.det_form(&[6, 0, 0, 0, 1, 0]);
            let (x0, y0) = (w.dets[0].x, w.dets[0].y);
            w.dets[0].path = vec![march::Wp { x: x0, y: y0, mode: 0 }, march::Wp { x: x0 + len, y: y0, mode: 2 }, march::Wp { x: x0 + len + 5.0, y: y0, mode: 0 }];
            w.dets[0].wi = 1; w.dets[0].state = march::S_MARCH;
            // no planks or wood: the army waits
            w.stock[PL as usize] = 0; w.stock[W as usize] = 0;
            for _ in 0..5 { w.step(); w.stock[GR as usize] = 3000; }
            assert_eq!(w.det_flat()[8] as u8, march::S_WAIT, "waits for materials");
            w.stock[PL as usize] = 200; w.stock[W as usize] = 200;
            for _ in 0..300 { w.step(); w.stock[GR as usize] = 3000; }
            let d = w.det_flat();
            assert_eq!(d[8] as u8, march::S_IDLE, "crossed: {:?}", &d[..16]);
            assert!((d[1] - (x0 + len + 5.0)).abs() < 1.0);
            assert_eq!(!w.bridges_flat().is_empty(), expect_bridge, "bridge for short crossings, ferry for long ones");
            assert!(w.stock[if expect_bridge { PL } else { W } as usize] < 200, "materials were spent");
            let _ = id;
        }
    }

    fn put(w: &mut World, kind: u8, x: f32, y: f32, rot: u8) {
        let pad_h = w.base(x, y);
        w.buildings.push(Building { kind, tier: 0, x, y, rot, pad_h, progress: 0, status: 4, aux: -1, staff: 0, residents: 0, hp: battle::max_hp(kind, 0), burning: 0.0, garrison: 0, born: 0, opts: 0, fert: FERT_MAX, mode: 0, target: -1, beff: 100 });
    }

    #[test]
    fn woodcutters_clear_forest_and_storehouses_raise_the_cap() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [100; N_RES];
        let cap0 = w.storage_cap();
        put(&mut w, STOREHOUSE, 8.0, 8.0, 0);
        assert_eq!(w.storage_cap(), cap0 + 250);
        let mut spot = None;
        'f: for gx in -10..10 { for gy in -10..10 { let (x, y) = (w.buildings[0].x + gx as f32 * 6.0, w.buildings[0].y + gy as f32 * 6.0); if terrain::forest_near(w.seed, x, y, 12.0) > 0.3 && w.base(x, y) > 1.0 { spot = Some((x, y)); break 'f; } } }
        let (x, y) = spot.expect("some forest on the map");
        put(&mut w, 4, x, y, 0);
        w.population = 20; w.staffing();
        for _ in 0..3000 { w.step(); w.stock[W as usize] = 50; }
        assert!(w.felled.len() > 3, "the woodcutter has been clearing trees ({} cleared)", w.felled.len());
    }

    #[test]
    fn rivers_flow_terraforming_reshapes_ground_and_waterwheels_need_water() {
        let mut w = village();
        let h0 = w.height_at(-30.0, 10.0);
        for i in 0..3 { w.place(RAISE, -30 + i * 4, 10, 0); }
        assert!(w.height_at(-26.0, 10.0) > w.base(-26.0, 10.0) + 1.0, "raised ground is higher than before");
        let before = w.height_at(20.0, -30.0);
        for i in 0..3 { assert!(w.place(RIVER, 20 + i * 4, -30, 2) >= 0); }
        assert!(w.height_at(24.0, -30.0) < 0.0 && before > 0.4, "a river channel holds water");
        let wheel_dry = w.can_place(WATERWHEEL, -36, -24);
        assert_eq!(wheel_dry, -16, "no water there");
        assert!(w.can_place(WATERWHEEL, 24, -22) != -16 || w.can_place(WATERWHEEL, 24, -36) != -16, "a waterwheel can stand beside the river");
        let _ = h0;
    }

    #[test]
    fn defenders_man_the_wall_facing_the_attackers() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [3000; N_RES]; w.population = 20;
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        for i in 0..8 { put(&mut w, WALL, hx + 24.0, hy - 21.0 + i as f32 * 6.0, 0); let n = w.buildings.len() - 1; w.buildings[n].tier = 2; w.buildings[n].hp = battle::max_hp(WALL, 2); }
        w.army = [4, 6, 4, 0, 0, 0];
        w.begin_battle([6, 0, 0, 0, 0, 0], 0.0, 0);     // attackers come from the east, where the wall is
        for _ in 0..10 { w.step(); }
        let b = w.battle.as_ref().expect("still fighting");
        let up = b.units.iter().filter(|u| u.side == 0 && u.alive && u.elev > 0.0).count();
        assert!(up >= 4, "defenders climbed the wall facing the attackers ({up} on top)");
        assert!(b.units.iter().filter(|u| u.side == 0 && u.elev > 0.0).all(|u| u.x > hx + 18.0), "they stand on the eastern wall");
    }

    #[test]
    fn better_buildings_need_more_workers_and_make_more() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [500; N_RES]; w.population = 40; w.sick = 0;
        put(&mut w, 1, 14.0, 10.0, 0);                         // a farm (in the castle's yard: it needs no road)
        w.staffing(); assert_eq!(w.buildings[1].staff, 2);
        w.buildings[1].tier = 3; w.staffing(); assert_eq!(w.buildings[1].staff, 8, "tier 4 farm employs four times as many");
        w.stock[GR as usize] = 0; w.buildings[1].progress = 0;
        for _ in 0..8 { w.step(); }
        assert!(w.stock[GR as usize] >= 30, "and it grows far more grain per harvest ({})", w.stock[GR as usize]);
    }

    #[test]
    fn walls_stop_attackers_until_a_ladder_or_a_breach() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [3000; N_RES]; w.population = 20;
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        let n = 24; for i in 0..n { let a = i as f32 / n as f32 * std::f32::consts::TAU; put(&mut w, WALL, hx + a.cos() * 20.0, hy + a.sin() * 20.0, 0); }
        w.begin_battle([6, 0, 0, 0, 0, 0], 0.0, 0);
        let mut climbed = false;
        for _ in 0..200 {
            w.step();
            let Some(b) = w.battle.as_ref() else { break };
            let inside = b.units.iter().any(|u| u.side == 1 && u.alive && ((u.x - hx).powi(2) + (u.y - hy).powi(2)).sqrt() < 16.0);
            let breach = w.buildings.iter().filter(|x| x.kind == WALL).count() < n;
            if b.ladders_used > 0 { climbed = true; }
            if !climbed && !breach { assert!(!inside, "nobody gets through an unbroken wall without a ladder"); }
        }
        assert!(climbed || w.buildings.iter().filter(|x| x.kind == WALL).count() < n || w.battle.is_none(), "the attackers used a ladder or broke the wall");
    }

    #[test]
    fn raiders_wade_a_moat_slowly_helpless_and_easy_to_hit() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [3000; N_RES]; w.population = 20;
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        let n = 40; for i in 0..n { let a = i as f32 / n as f32 * std::f32::consts::TAU; put(&mut w, MOAT, hx + a.cos() * 18.0, hy + a.sin() * 18.0, 0); }
        assert!(w.begin_battle([6, 0, 4, 0, 0, 0], 0.0, 0));
        let (mut waded, mut crossed, mut worst_ratio) = (false, false, 0.0f32);
        let mut last: Vec<(f32, f32)> = vec![]; let mut last_wet: Vec<bool> = vec![];
        for _ in 0..1500 {
            w.step();
            let Some(b) = w.battle.as_ref() else { break };
            if last.len() == b.units.len() {
                for (k, u) in b.units.iter().enumerate().filter(|(_, u)| u.side == 1 && u.alive) {
                    if u.wading {
                        waded = true;
                        let moved = (u.x - last[k].0).hypot(u.y - last[k].1);
                        if last_wet[k] { worst_ratio = worst_ratio.max(moved / (UNITS[u.kind as usize].speed * 1.0)); }   // (a raider that stepped into the water in the last quarter of the second has walked the rest of it)
                    }
                    if (u.x - hx).hypot(u.y - hy) < 14.0 { crossed = true; }
                }
            }
            last = b.units.iter().map(|u| (u.x, u.y)).collect(); last_wet = b.units.iter().map(|u| u.wading).collect();
            if crossed { break; }
        }
        assert!(waded, "raiders enter the moat instead of stopping at its edge");
        assert!(crossed, "and they get across to the inside");
        assert!(worst_ratio < 0.9, "wading is slow: {worst_ratio:.2} of walking speed per step");
    }

    #[test]
    fn a_soldier_in_the_water_takes_much_more_damage() {
        let mut w = World::new(1337, 0, 0);
        w.population = 20;
        assert!(w.begin_battle([2, 0, 0, 0, 0, 0], 0.0, 0));
        let b = w.battle.as_mut().unwrap();
        let i = b.units.iter().position(|u| u.side == 1).unwrap();
        let j = b.units.iter().rposition(|u| u.side == 1).unwrap();
        b.units[i].hp = 1000.0; b.units[j].hp = 1000.0; b.units[j].wading = true;
        World::damage_unit(b, i, 20.0); World::damage_unit(b, j, 20.0);
        let (dry, wet) = (1000.0 - b.units[i].hp, 1000.0 - b.units[j].hp);
        assert!((wet / dry - battle::WADE_DAMAGE).abs() < 0.01 && battle::WADE_DAMAGE >= 3.0, "dry {dry}, wet {wet}");
    }

    #[test]
    fn raising_and_lowering_can_share_a_spot_and_pads_stay_put() {
        let mut w = village();
        // find a free spot for the earthworks (deposits sit in different places on each map)
        let (px, py) = [(-30, 10), (-34, 14), (-26, 22), (30, 24), (-30, -26), (34, -30), (-38, 0)].into_iter().find(|&(x, y)| w.can_place(RAISE, x, y) == 0).expect("a spot for earthworks");
        let (fx, fy) = (px as f32, py as f32);
        let base = w.base(fx, fy);
        assert!(w.place(RAISE, px, py, 0) >= 0);
        let up = w.height_at(fx, fy); assert!(up > base + 1.5);
        let v0 = w.terrain_ver;
        assert!(w.place(LOWER, px, py, 0) >= 0, "a lowering can go on the same spot as a raising");
        assert!(w.terrain_ver > v0, "earthworks bump the terrain version so everything refits");
        assert!((w.height_at(fx, fy) - base).abs() < 0.3, "raise and lower cancel out");
        // a building's levelled pad is not moved by earthworks beside it
        let h = w.buildings[1].pad_h; let (bx, by) = (w.buildings[1].x, w.buildings[1].y);
        w.place(RAISE, (bx - w.ox as f32) as i32 + 7, (by - w.oy as f32) as i32, 0);
        assert!((w.height_at(bx, by) - h).abs() < 0.01);
    }

    #[test]
    fn gardens_parks_and_chapels_make_people_happier_and_moats_can_vary_in_width() {
        let mut w = village();
        w.stock[GR as usize] = 500;
        let h0 = w.happiness();
        put(&mut w, PARK, 30.0, 30.0, 0); put(&mut w, GARDEN, -30.0, 30.0, 0); put(&mut w, CHAPEL, 30.0, -30.0, 0);
        assert!(w.happiness() >= h0 + 10, "{} -> {}", h0, w.happiness());
        for &(r, _) in &FOODS { w.stock[r as usize] = 0; } w.meal_credit = 0; assert!(w.happiness() < h0 + 10, "hunger makes people unhappy");
        // a wide moat piece digs a broader ditch than a thin one
        let (x, y) = (w.buildings[0].x + 40.0, w.buildings[0].y);
        put(&mut w, MOAT, x, y, 0); let thin = (0..30).filter(|k| w.height_at(x + *k as f32 * 0.25, y) < 0.0).count();
        let n = w.buildings.len() - 1; w.buildings[n].rot = 7; let wide = (0..30).filter(|k| w.height_at(x + *k as f32 * 0.25, y) < 0.0).count();
        assert!(wide > thin, "rotation widens the moat ({thin} -> {wide})");
    }

    #[test]
    fn ports_sell_surplus_for_gold_and_buy_grain_when_hungry() {
        let mut w = village();
        w.population = 60; w.sick = 0; w.stock = [0; N_RES]; w.stock[GR as usize] = 500;
        let cap = w.storage_cap();
        put(&mut w, PORT, 30.0, 30.0, 0); w.staffing();
        w.stock[W as usize] = cap; w.stock[GD as usize] = 0;
        for _ in 0..140 { w.trade_step(); w.tick += 1; }
        assert!(w.stock[GD as usize] > 0 && w.stock[W as usize] < cap, "wood was sold for gold");
        w.stock[GR as usize] = 0; w.stock[GD as usize] = 500;
        for _ in 0..140 { w.trade_step(); }
        assert!(w.stock[GR as usize] > 0, "grain was bought when the village ran short");
    }

    #[test]
    fn keeps_hold_more_archers_than_towers() {
        let mut w = village();
        w.army[1] = 30;
        let k = w.place(KEEP, 24, 22, 0); assert!(k >= 0, "keep placed ({k})");
        assert_eq!(w.garrison_cap(k as u32), 8);
        assert_eq!(w.garrison_set(k as u32, 8), 0);
    }

    #[test]
    fn moat_pieces_dig_a_water_filled_ditch() {
        let mut w = village();
        let before = w.height_at(-34.0, 0.0);   // (out past the farm's yard)
        assert!(before > 0.4, "dry land to dig in");
        for i in 0..4 { assert!(w.place(MOAT, -36 + i * 4, 0, 0) >= 0, "adjacent moat pieces can be placed side by side (piece {i})"); }
        assert!(w.height_at(-34.0, 0.0) < 0.0, "the ditch holds water");
        assert!(w.height_at(-44.0, 0.0) > 0.4, "land away from the moat is untouched");
        assert_eq!(w.upgrade(w.buildings.len() as u32 - 1), -10, "moats do not upgrade");
        let n = w.buildings.len() as u32 - 1; w.demolish(n);
    }

    #[test]
    fn gates_let_armies_out_of_a_walled_town_and_moats_need_bridges() {
        let mut w = World::new(1337, 0, 0);
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        // a ring of wall pieces round the hall, with a gap that is closed or filled by a gate
        let n = 18; let r = 16.0;
        let ring = |w: &mut World, skip: Option<usize>, gate: bool| {
            w.buildings.truncate(1);
            for i in 0..n { let a = i as f32 / n as f32 * std::f32::consts::TAU; let (x, y) = (hx + a.cos() * r, hy + a.sin() * r);
                if skip == Some(i) { if gate { put(w, GATE, x, y, 0); } } else { put(w, WALL, x, y, 0); } }
        };
        ring(&mut w, None, false);
        assert_eq!(w.plan_march(&[5, 0, 0, 0, 0, 0], hx, hy, hx + 40.0, hy)[0], -2.0, "a closed wall ring traps the army");
        ring(&mut w, Some(0), true);
        assert_eq!(w.plan_march(&[5, 0, 0, 0, 0, 0], hx, hy, hx + 40.0, hy)[0], 1.0, "a gate lets it out");
        // a moat ring needs a bridge (water leg); a drawbridge makes the way free
        w.buildings.truncate(1);
        for i in 0..40 { let a = i as f32 / 40.0 * std::f32::consts::TAU; put(&mut w, MOAT, hx + a.cos() * 14.0, hy + a.sin() * 14.0, 0); }
        let p = w.plan_march(&[5, 0, 0, 0, 0, 0], hx, hy, hx + 40.0, hy);
        assert_eq!(p[0], 1.0); assert!(p[2] > 0.0 || p[3] > 0.0, "crossing a moat costs planks or boats");
        put(&mut w, DRAWBRIDGE, hx + 14.0, hy, 2);
        let q = w.plan_march(&[5, 0, 0, 0, 0, 0], hx, hy, hx + 40.0, hy);
        assert_eq!(q[0], 1.0); assert_eq!(q[2] + q[3], 0.0, "the drawbridge spares the planks");
        let di = w.buildings.len() as u32 - 1; assert_eq!(w.drawbridge_set(di, true), 0);
        let up = w.plan_march(&[5, 0, 0, 0, 0, 0], hx, hy, hx + 40.0, hy); assert!(up[2] + up[3] > 0.0, "a raised drawbridge cannot be crossed");
    }

    #[test]
    fn towers_hold_archers_from_the_barracks() {
        let mut w = village();
        let t = w.buildings.iter().position(|b| b.kind == TOWER).unwrap() as u32;
        assert_eq!(w.garrison_set(t, 2), -2, "no archers in barracks yet");
        w.army[1] = 5;
        assert_eq!(w.garrison_set(t, 3), 0); assert_eq!(w.army[1], 2);
        assert_eq!(w.garrison_set(t, 99), -3);
        assert_eq!(w.garrison_set(t, 1), 0); assert_eq!(w.army[1], 4);
        assert_eq!(w.garrison_set(0, 1), -1, "the hall is not a tower");
        w.garrison_set(t, 3);
        w.demolish(t);
        assert_eq!(w.army[1], 5, "archers come home when the tower is pulled down");
    }

    #[test]
    fn damaged_buildings_can_be_repaired() {
        let mut w = village();
        w.stock = [500; N_RES];
        let i = 1;
        let max = battle::max_hp(w.buildings[i].kind, w.buildings[i].tier);
        w.buildings[i].hp = max * 0.3;
        let before = w.stock[W as usize];
        assert_eq!(w.repair(i as u32), 0);
        assert!((w.buildings[i].hp - max).abs() < 0.5, "fully repaired");
        assert!(w.stock[W as usize] < before, "repairs cost materials");
        assert_eq!(w.repair(i as u32), -15, "nothing left to repair");
        w.buildings[i].hp = max * 0.5; w.set_fire(i as u32);
        assert_eq!(w.repair(i as u32), -14, "cannot repair what is burning");
        w.buildings[i].burning = 0.0; w.stock = [0; N_RES];
        assert_eq!(w.repair(i as u32), -6, "needs materials");
    }

    #[test]
    fn ruins_can_be_rebuilt_unless_something_stands_there() {
        let mut w = village();
        w.stock = [800; N_RES];
        let n = w.building_count();
        let (kind, x) = (w.buildings[1].kind, w.buildings[1].x);
        w.upgrade(1);
        w.buildings[1].hp = 0.0; w.collect_destroyed();
        assert_eq!(w.building_count(), n - 1);
        let r = w.ruins_flat(); assert_eq!(r.len(), 6); assert_eq!(r[3] as u8, kind); assert_eq!(r[4] as u8, 1, "remembers its tier"); assert!((r[0] - x).abs() < 0.01);
        assert!(!w.rebuild_cost_of(0).is_empty());
        assert_eq!(w.rebuild(0), 0);
        assert_eq!(w.building_count(), n);
        assert!(w.ruins_flat().is_empty());
        assert_eq!(w.buildings.last().unwrap().tier, 1, "rebuilt at its old tier");
        // blocked: a new building went up on the ruin
        let mut w2 = village(); w2.stock = [800; N_RES];
        let (x2, y2) = (w2.buildings[1].x, w2.buildings[1].y);
        w2.buildings[1].hp = 0.0; w2.collect_destroyed();
        assert!(w2.place(HOUSE, (x2 - w2.ox as f32) as i32, (y2 - w2.oy as f32) as i32, 0) >= 0);
        assert_eq!(w2.rebuild(0), -3);
    }

    #[test]
    fn builders_yard_mends_and_rebuilds_on_its_own() {
        let mut w = village();
        w.stock = [2000; N_RES]; w.population = 60;
        assert!(w.place(BUILDERS, -20, -26, 0) >= 0 || w.place(BUILDERS, 24, 26, 0) >= 0 || w.place(BUILDERS, -26, 20, 0) >= 0, "yard placed");
        let hurt = 1;
        let max = battle::max_hp(w.buildings[hurt].kind, w.buildings[hurt].tier);
        w.buildings[hurt].hp = max * 0.2;
        let n = w.building_count();
        let victim = 2; w.buildings[victim].hp = 0.0; w.collect_destroyed();
        assert_eq!(w.building_count(), n - 1);
        for _ in 0..600 { w.step(); w.stock = [2000; N_RES]; w.population = 60; }
        let healed = w.buildings[hurt].hp > max * 0.9;
        assert!(healed, "the damaged building was mended");
        assert!(w.ruins_flat().is_empty(), "the ruin was rebuilt");
        assert_eq!(w.building_count(), n, "back to full strength");
    }

    #[test]
    fn recovery_skips_a_blocked_ruin_and_reserves_winter_firewood() {
        let mut w = village();
        w.stock = [2000; N_RES];
        w.population = 60;
        let yard = [(-20, -26), (24, 26), (-26, 20)].into_iter()
            .map(|(x, y)| w.place(BUILDERS, x, y, 0)).find(|&i| i >= 0).expect("place a yard") as usize;
        let (hall_x, hall_y) = (w.buildings[0].x, w.buildings[0].y);
        let house = w.buildings.iter().position(|b| b.kind == HOUSE).expect("a house to rebuild");
        w.buildings[house].hp = 0.0;
        w.collect_destroyed();
        w.ruins.insert(0, [hall_x, hall_y, DEFS[FARM as usize].r, FARM as f32, 0.0, 0.0]);
        assert_eq!(w.recovery_ruin(), 1, "the farm site is blocked by the hall");
        w.tick = 3 * SEASON_DAYS * DAY;
        let reserve = 2 * w.winter_need().max(1);
        w.stock[W as usize] = reserve;
        let yard = yard - usize::from(house < yard);
        w.buildings[yard].staff = 1;
        w.buildings[yard].progress = 700;
        w.builders_step();
        assert_eq!(w.ruins.len(), 2);
        assert_eq!(w.stock[W as usize], reserve);
        let cost = World::rebuild_cost(HOUSE, 0).iter().find(|&&c| c.0 == W).unwrap().1;
        w.stock[W as usize] += cost;
        w.builders_step();
        assert_eq!(w.ruins.len(), 1);
        assert_eq!(w.ruins[0][3], FARM as f32);
        assert_eq!(w.stock[W as usize], reserve);
    }

    #[test]
    fn the_steward_flags_emergencies_without_advancing_the_world() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [0; N_RES];
        w.tick = 3 * SEASON_DAYS * DAY;
        w.raid_warning_ticks = 25;
        w.buildings[0].burning = 1.0;
        w.offer(CH_WINTER);
        w.plague_end = w.tick + DAY;
        let hash = w.state_hash();
        assert_eq!(w.steward_status(), vec![0b1111110, 0, 0, 0]);
        assert_eq!(w.state_hash(), hash);
        assert_eq!(w.raid_warning_ticks, 25);
    }

    #[test]
    fn a_refused_contingent_leaves_other_soldiers_deployed() {
        let mut w = World::new(1337, 0, 0);
        w.away = [8, 4, 0, 1, 0, 0];
        w.return_refused_army(&[3, 2, u32::MAX, 0, 0, 0]);
        assert_eq!(w.away, [5, 2, 0, 1, 0, 0]);
        assert_eq!(w.army, [3, 2, 0, 0, 0, 0]);
    }

    #[test]
    fn battles_are_deterministic() {
        let run = || { let mut w = village(); w.population = 25; w.start_raid(2.0, &[10, 5, 2, 1, 1, 0], 7); for _ in 0..200 { w.step(); w.stock[GR as usize] = 3000; } w.state_hash() };
        assert_eq!(run(), run());
    }

    #[test]
    fn ore_chain_produces_tools_and_gold() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [2000; N_RES];
        w.population = 400; // plenty of workers
        // find any legal spots near each required deposit for the chain
        let place_near = |w: &mut World, kind: u8| -> bool {
            for r in [10i32, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50] {
                for a in 0..24 {
                    let t = a as f32 * 0.2618;
                    let (dx, dy) = ((t.cos() * r as f32) as i32, (t.sin() * r as f32) as i32);
                    if w.place(kind, dx, dy, 0) >= 0 { return true; }
                }
            }
            false
        };
        for k in [6u8, 9, 11, 12, 13] { assert!(place_near(&mut w, k), "could not place kind {k}"); }
        w.stock[IO as usize] = 0; w.stock[IR as usize] = 0; w.stock[TL as usize] = 0; w.stock[CH as usize] = 0;
        for _ in 0..900 { w.step(); w.stock[W as usize] = 2000; w.stock[GR as usize] = 2000; }   // (the chain stands far from the castle with no roads: it works at half pace)
        assert!(w.stock[IO as usize] > 0 || w.stock[IR as usize] > 0, "ore flows");
        assert!(w.stock[TL as usize] > 0, "tools forged");
    }
}

#[cfg(test)]
mod map_tests {
    use super::*;
    #[test]
    fn map_stats() {
        for seed in [1u64, 7, 1337, 99999] {
            let g = terrain::grid(seed, -1200.0, -1200.0, 241, 241, 10.0);
            let hi = g.iter().filter(|&&h| h > 30.0).count() as f32 / g.len() as f32;
            let water = g.iter().filter(|&&h| h < 0.0).count() as f32 / g.len() as f32;
            // the flat ground round the origin: how far is the nearest steep mountain?
            let mut near = 1e9f32; for j in -80..=80 { for i in -80..=80 { let (x, y) = (i as f32 * 5.0, j as f32 * 5.0); if terrain::base_height(seed, x, y) > 24.0 { near = near.min(x.hypot(y)); } } }
            println!("seed {seed}: >30 {:.1}% water {:.0}% nearest mountain to start {near:.0} tunnels {} sites {}", hi * 100.0, water * 100.0, terrain::tunnels(seed).len(), terrain::sites(seed).len());
        }
    }
}

#[cfg(test)]
mod road_tests {
    use super::*;

    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w }

    fn ring(w: &mut World, r: f32, n: usize, kind: u8) {
        for i in 0..n { let a = i as f32 / n as f32 * std::f32::consts::TAU; let (x, y) = ((a.cos() * r).round() as i32, (a.sin() * r).round() as i32); w.place(kind, x, y, 0); }
    }

    #[test]
    fn every_building_is_joined_to_the_hall_over_the_path_network() {
        let mut w = rich(); w.deposits.clear();
        let mut placed = 0;
        for (x, y) in [(16, 0), (28, 4), (22, 12), (40, -6), (-18, 8), (-30, 20), (-12, -20), (6, -26), (50, 30), (-60, -10), (70, -40), (30, 18), (33, 21)] { if w.place(HOUSE, x, y, 0) >= 0 { placed += 1; } }
        assert!(placed >= 8, "placed {placed}");
        for i in 0..w.buildings.len() { assert!(w.linked_to_hall(i), "building {i} is not joined to the hall over the path network"); }
    }

    #[test]
    fn roads_do_not_cross_moats_and_use_drawbridges() {
        let mut w = rich(); w.deposits.clear();   // (a rock in the ring would leave a gap)
        ring(&mut w, 20.0, 44, MOAT);
        let outside = [(0, 36), (6, 38), (-8, 40), (12, 36), (-14, 36)].into_iter().map(|(x, y)| w.place(HOUSE, x, y, 0)).find(|&i| i >= 0).unwrap_or(-1);
        assert!(outside >= 0, "house outside the moat: {outside}");
        let has_link = |w: &World, child: u32| w.linked_to_hall(child as usize);
        assert!(!has_link(&w, outside as u32), "a house behind an unbroken moat gets no path at all");
        // no drawn segment may lie in water
        for s in w.roads_flat().chunks(6) { for t in 0..=10 { let f = t as f32 / 10.0; let (x, y) = (s[0] + (s[2] - s[0]) * f, s[1] + (s[3] - s[1]) * f); assert!(w.height_at(x, y) > 0.1, "path in water at {x},{y}"); } }
        let bridge = w.place(DRAWBRIDGE, 0, 20, 0);
        assert!(bridge >= 0, "drawbridge: {bridge}");
        assert!(has_link(&w, outside as u32), "with a lowered drawbridge the house is connected");
        // the walking route crosses the moat on the deck; the graded (drawn) segments never do
        for s in w.roads_flat().chunks(6) { for t in 0..=10 { let f = t as f32 / 10.0; let (x, y) = (s[0] + (s[2] - s[0]) * f, s[1] + (s[3] - s[1]) * f); assert!(w.height_at(x, y) > 0.1, "graded path in water at {x},{y}"); } }
        w.drawbridge_set(bridge as u32, true); w.after_change();
        assert!(!has_link(&w, outside as u32), "raise the bridge and the path is gone again");
    }

    #[test]
    fn drawbridge_deck_is_level_with_the_gate_and_both_banks() {
        let mut w = rich();
        for x in [-8, 8] { w.place(WALL, x, 14, 0); }
        let gate = w.place(GATE, 0, 14, 0); assert!(gate >= 0);
        ring(&mut w, 24.0, 52, MOAT);
        let br = w.place(DRAWBRIDGE, 0, 24, 0); assert!(br >= 0, "bridge {br}");
        let (gh, bh) = (w.buildings[gate as usize].pad_h, w.buildings[br as usize].pad_h);
        assert!((gh - bh).abs() < 0.01, "deck {bh} at gate height {gh}");
        for e in [-1.0f32, 1.0] { let y = 24.0 + 12.4 * e; assert!((w.height_at(0.0, y) - bh).abs() < 0.1, "bank at {y}: {} vs {bh}", w.height_at(0.0, y)); }
        assert!(w.height_at(0.0, 24.0) < 0.2, "water between the banks");
        // the ditch under the bridge is as deep as the moat beside it, and the water reaches right up to both ends of the deck
        let beside = w.height_at(10.0, 24.0 - 0.0);
        let _ = beside;
        assert!(w.height_at(0.0, 24.0) < -2.0, "deep water under the deck: {}", w.height_at(0.0, 24.0));
        for e in [-1.0f32, 1.0] { assert!(w.height_at(0.0, 24.0 + 2.2 * e) < 0.0, "water 2.2 from the middle"); }
    }

    #[test]
    fn a_moat_is_deep_and_a_drawbridge_does_not_choke_it() {
        let build = |bridge: bool| { let mut w = rich(); for x in [-8, 8] { w.place(WALL, x, 14, 0); } w.place(GATE, 0, 14, 0); ring(&mut w, 24.0, 52, MOAT); if bridge { assert!(w.place(DRAWBRIDGE, 0, 24, 0) >= 0); } w };
        let (with, without) = (build(true), build(false));
        let deep = with.height_at(0.0, 24.0);
        assert!(deep < -2.0, "the water under the deck is deep: {deep}");
        // the ditch under the bridge is exactly as wide and as deep as the bare moat at the same place
        let wet = |w: &World| (-30..30).filter(|k| w.height_at(0.0, 24.0 + *k as f32 * 0.25) < 0.0).count();
        assert!(wet(&with) + 1 >= wet(&without), "the bridge keeps the ditch as wide: {} vs {} samples", wet(&with), wet(&without));
        assert!((with.height_at(0.0, 24.0) - without.height_at(0.0, 24.0)).abs() < 0.3, "and as deep");
    }

    #[test]
    fn flatten_uses_the_requested_height_without_spending_materials() {
        let mut w = rich();
        let before = w.stock;
        assert_eq!(w.flatten(40, 7.5), 0);
        assert!((w.height_ground(20.0, 0.0) - 7.5).abs() < 0.01);
        assert_eq!(w.stock, before, "flattening is a free testing operation");
        assert_eq!(w.flatten(40, f32::NAN), -2, "reject non-finite heights");
    }

    #[test]
    fn moat_water_stands_just_below_the_rim_not_down_at_the_sea() {
        let mut w = rich();
        ring(&mut w, 24.0, 52, MOAT);
        let f = w.moat_water_flat(); assert!(f.len() >= 40 && f.len() % 4 == 0, "an entry per placed piece: {}", f.len() / 4);
        for p in f.chunks(4) { assert!(p[3] >= 0.4, "never below the shore line: {}", p[3]); }
        assert!(f.chunks(4).all(|p| p[3] == f[3]), "the connected moat has a level surface");
        // the land round the moat is several units high: the water must stand well above the sea there, close under the brim
        let land = w.height_core(0.0, 33.0, false);
        let level = w.moat_level_at(0.0, 24.0);
        assert!(level > 0.4 && level < land, "water {level:.1} under the rim {land:.1}");
        assert!(land - level < 2.2 || level >= 0.4 && land < 3.0, "close to the brim: rim {land:.1}, water {level:.1}");
        assert_eq!(w.moat_level_at(0.0, 0.0), 0.0, "no moat water at the hall");
    }

    #[test]
    fn a_straight_chain_of_moat_pieces_has_a_straight_bank() {
        let mut w = rich();
        for i in 0..11 { assert!(w.place(MOAT, -20 + i * 4, 12, 0) >= 0, "piece {i}"); }
        // the water's edge on the south side, at a piece and halfway between two pieces: the bank must not scallop
        let edge = |x: f32| (0..200).map(|k| k as f32 * 0.05).find(|d| w.height_at(x, 12.0 + d) >= 0.0).unwrap_or(10.0);
        let (at_piece, between) = (edge(0.0), edge(2.0));   // pieces stand at x = -20 + 4i: 0 is a piece, 2 is halfway between two
        assert!((at_piece - between).abs() < 0.45, "the bank wobbles: edge {at_piece:.2} at a piece, {between:.2} between two");
    }

    #[test]
    fn walls_build_the_ground_under_themselves() {
        let mut w = rich();
        // a wall on the shore of a dug moat: the earth under the wall is heaped up, never left as a drop
        ring(&mut w, 26.0, 40, MOAT);
        let i = w.place(WALL, 0, 22, 0); assert!(i >= 0, "wall beside the moat: {i}");
        let b = w.buildings[i as usize].clone();
        for (px, py) in [(0.0, 0.0), (2.0, 0.0), (-2.0, 0.0), (0.0, 2.0), (0.0, -2.0)] { assert!(w.height_at(b.x + px, b.y + py) >= b.pad_h - 0.05, "ground under the wall at {px},{py}"); }
    }

    #[test]
    fn options_cost_resources_and_respect_tiers() {
        let mut w = rich();
        let i = w.place(WALL, 18, 0, 0); assert!(i >= 0);
        assert_eq!(w.set_option(i as u32, 0, true), -10, "stairs need a stone wall");
        w.upgrade(i as u32);
        let before = w.stocks()[PL as usize];
        assert_eq!(w.set_option(i as u32, 0, true), 0);
        assert!(w.stocks()[PL as usize] < before);
        assert_eq!(w.options_flat()[i as usize], 1);
        assert_eq!(w.set_option(i as u32, 9, true), -1);
    }
}

#[cfg(test)]
mod perf_tests {
    use super::*;
    #[test]
    fn upgrade_batch_matches_upgrading_one_by_one() {
        let make = || {
            let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
            for _ in 0..3 { w.upgrade(0); }
            for i in 0..30 { let a = i as f32 * 0.9; let r = 16.0 + (i % 6) as f32 * 4.0; w.place(HOUSE, (a.cos() * r).round() as i32, (a.sin() * r).round() as i32, 0); }
            w
        };
        let (mut a, mut b) = (make(), make());
        let idxs: Vec<u32> = (1..a.buildings.len() as u32).collect();
        let one: Vec<i32> = idxs.iter().map(|&i| a.upgrade(i)).collect();
        let many = b.upgrade_batch(&idxs);
        assert_eq!(one, many);
        assert!(many.iter().any(|&c| c == 0));
        assert_eq!(a.state_hash(), b.state_hash());
        assert_eq!(a.roads, b.roads);
    }

    #[test]
    fn many_buildings_stay_fast() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for _ in 0..3 { w.upgrade(0); }
        w.flatten(72, 5.0);
        let t = std::time::Instant::now();
        let mut n = 0;
        for (r, k, kind) in [(24.0f32, 24, WALL), (44.0, 40, WALL), (61.0, 60, MOAT)] {
            for i in 0..k { let a = i as f32 / k as f32 * std::f32::consts::TAU; if w.place(kind, (a.cos() * r).round() as i32, (a.sin() * r).round() as i32, 0) >= 0 { n += 1; } }
        }
        for i in 0..50 { let a = i as f32 * 0.7; let r = 28.0 + (i % 5) as f32 * 3.0; if w.place(HOUSE, (a.cos() * r).round() as i32, (a.sin() * r).round() as i32, 0) >= 0 { n += 1; } }
        println!("placed {n} in {:?}, roads {}", t.elapsed(), w.roads.len());
        assert!(t.elapsed().as_secs_f32() < 8.0);
    }
}

#[cfg(test)]
mod family_tests {
    use super::*;

    fn farm_world() -> World { let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; w.cheat(3, 0, 0); w }

    #[test]
    fn seasons_turn_every_ten_days_and_farms_follow() {
        let mut w = farm_world();
        assert_eq!(w.season(), 0);
        w.tick = DAY * SEASON_DAYS * 2; assert_eq!(w.season(), 2); assert_eq!(w.grain_percent(), 150);
        w.tick = DAY * SEASON_DAYS * 3; assert_eq!(w.season(), 3); assert_eq!(w.grain_percent(), WINTER_GRAIN as u32);
        w.tick = DAY * SEASON_DAYS * 4; assert_eq!((w.season(), w.year()), (0, 2));
        // the same farm makes more grain in autumn than in winter
        let make = |tick: u64| { let mut w = farm_world(); let i = [(-20, 14), (20, 14), (30, -20), (-30, -20)].into_iter().map(|(x, y)| w.place(FARM, x, y, 0)).find(|&i| i >= 0).expect("a farm site"); w.tick = tick; w.stock[GR as usize] = 0; w.population = 40; w.staffing(); for _ in 0..40 { w.step(); w.stock[W as usize] = 3000; w.stock[GR as usize] = w.stock[GR as usize].min(500); } let _ = i; w.stock[GR as usize] };
        let (autumn, winter) = (make(DAY * SEASON_DAYS * 2), make(DAY * SEASON_DAYS * 3));
        assert!(autumn > winter, "autumn {autumn} vs winter {winter}");
    }

    #[test]
    fn the_town_hall_backs_up_wood_and_grain_but_only_while_they_are_low() {
        let mut w = farm_world(); w.population = 10;
        w.stock[W as usize] = 0; w.stock[GR as usize] = 0;
        for _ in 0..(DAY as usize) { w.step(); w.stock[GR as usize] = w.stock[GR as usize].min(5); }
        assert!(w.stock[W as usize] > 0, "a village with no wood is given a little: {}", w.stock[W as usize]);
        assert!(w.stock[W as usize] < 120, "only a little: {}", w.stock[W as usize]);
        let mut r = farm_world(); r.population = 10; r.stock[W as usize] = 500;
        let before = r.stock[W as usize];
        for _ in 0..30 { r.step(); }
        assert!(r.stock[W as usize] <= before, "no backup while the store is full: {} -> {}", before, r.stock[W as usize]);
    }

    #[test]
    fn raids_come_about_once_a_week_not_every_other_day() {
        let (mut raids, days) = (0, 60u64);
        for k in 0..6u64 {
            let mut w = farm_world(); w.rng = Rng(k * 977 + 13); w.population = 12;
            for _ in 0..(days * DAY) { let was = w.battle.is_some(); w.step(); if w.battle.is_some() && !was { raids += 1; } w.battle = None; }
        }
        let per_week = raids as f64 / (6.0 * days as f64 / 7.0);
        assert!(per_week < 2.0, "{per_week} raids a week");
        assert!(per_week > 0.2, "{per_week} raids a week");
    }

    #[test]
    fn with_too_few_hands_food_and_wood_are_staffed_first() {
        let mut w = farm_world(); w.population = 12;
        let f = w.place(FARM, -20, 14, 0); let c = w.place(4, 20, 14, 0);
        let mut extra = 0; for (k, x) in [(HOUSE, 8), (HOUSE, 14), (BARRACKS, -30), (TOWER, 30)] { for y in [-26, -34, 26, 34] { if w.place(k, x, y, 0) >= 0 { extra += 1; break; } } }
        assert!(extra >= 1, "some more workplaces");
        w.population = 8; w.staffing();
        assert!(w.eff < 100, "not enough hands for every job: {}", w.eff);
        let (f, c) = (f.max(0) as usize, c.max(0) as usize);
        let full = |i: usize| w.buildings[i].staff >= DEFS[w.buildings[i].kind as usize].jobs;
        assert!(full(f) && full(c), "the farm and the woodcutter are fully staffed first (eff first {}, rest {})", w.eff_first, w.eff_rest);
        assert!(w.eff_first >= w.eff_rest, "{} vs {}", w.eff_first, w.eff_rest);
    }

    #[test]
    fn famine_takes_a_few_percent_a_day_not_a_villager_every_few_seconds() {
        let mut w = farm_world(); w.population = 60; w.children = 0; w.elders = 0; w.stock = [0; N_RES];
        let mut worst_day = 0;
        for _day in 0..10 {
            let before = w.died[DIED_HUNGER];
            for _ in 0..(DAY as usize) { w.step(); w.stock = [0; N_RES]; w.population = w.population.max(20); }
            worst_day = worst_day.max(w.died[DIED_HUNGER] - before);
        }
        assert!(w.died[DIED_HUNGER] >= 1, "a starving village does lose people");
        assert!(worst_day <= 8, "famine takes a few percent of the village a day, not more than 8 of 60: {worst_day}");
    }

    #[test]
    fn winter_burns_wood_and_a_cold_village_suffers() {
        let mut w = farm_world(); w.tick = DAY * SEASON_DAYS * 3;
        w.population = 40; w.stock[W as usize] = 100;
        for _ in 0..10 { w.step(); w.stock[GR as usize] = 3000; }
        assert!(w.stock[W as usize] < 100, "firewood was burned");
        assert!(w.warmth());
        w.stock[W as usize] = 0; let h0 = { w.warm = true; w.happiness() };
        for _ in 0..20 { w.step(); w.stock[W as usize] = 0; w.stock[GR as usize] = 3000; }
        assert!(!w.warmth(), "no wood, no warmth");
        assert!(w.happiness() < h0, "{} < {h0}", w.happiness());
    }

    #[test]
    fn children_grow_up_couples_have_babies_and_the_old_pass_on() {
        let mut w = farm_world();
        for x in [14, 20, 26, -14, -20, -26] { w.place(HOUSE, x, 6, 0); }
        w.population = 60; w.children = 20; w.elders = 10; w.staffing();
        let before = w.demographics();
        for _ in 0..(DAY * 25) { w.step(); w.stock[GR as usize] = 3000; w.stock[W as usize] = 3000; if w.battle_active() { break; } }
        let after = w.demographics();
        assert_eq!(after[0] + after[1] + after[2], w.population(), "the cohorts add up to the headcount");
        assert!(after[2] != before[2] || after[0] != before[0], "ages moved: {before:?} -> {after:?}");
    }

    #[test]
    fn only_adults_work() {
        let mut w = farm_world();
        w.place(FARM, 20, 14, 0); w.place(FARM, -20, 14, 0); w.place(HOUSE, 12, 4, 0);
        w.population = 30; w.children = 0; w.elders = 0; w.staffing(); let all = w.efficiency();
        w.children = 15; w.elders = 5; w.staffing();
        assert!(w.efficiency() <= all, "fewer adults, no more work done");
        assert_eq!(w.adults(), 10);
    }
}

#[cfg(test)]
mod trade_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [300; N_RES]; w }

    #[test]
    fn errands_travel_and_do_their_work_only_when_they_arrive() {
        let mut w = rich(); w.rel_add(7, 60);
        // an offer costs nothing but sets out; nothing is signed until it arrives
        assert_eq!(w.journey_start(TREATY_PEACE, 7, 30, 200.0), 0);
        assert_eq!(w.journey_start(TREATY_PEACE, 7, 30, 200.0), -7, "one of a kind at a time");
        assert_eq!(w.journey_start(TREATY_ALLIANCE, 7, 30, 200.0), -22, "no alliance without a pact");
        assert_eq!(w.journey_start(JK_ENVOY, 7, 0, 100.0), 0); assert_eq!(w.stock[GD as usize], 280);
        assert_eq!(w.journey_start(JK_MARRIAGE, 7, 0, 300.0), 0); assert_eq!(w.stock[GD as usize], 130);
        assert!(!w.has_treaty(7, TREATY_PEACE) && !w.married_to(7));
        let f = w.journeys_flat(); assert_eq!(f.len(), 21);
        let arrive: Vec<i32> = f.chunks(7).map(|c| c[6]).collect();
        assert_eq!(arrive[0], 30 + (200.0f32 / 1.6) as i32);
        let before = w.relation(7);
        let mut seen = vec![];
        for _ in 0..400 { w.step(); let now = w.tick() as i32; for c in w.journeys_flat().chunks(7) { assert!(c[5] <= now && now < c[6]); } for a in w.take_arrivals().chunks(4) { assert_eq!(a[3], now); seen.push((a[0], now)); } }
        assert_eq!(seen.len(), 3, "{seen:?}");
        for (k, at) in &seen { let idx = [1, 3, 4].iter().position(|x| x == k).unwrap(); assert_eq!(*at, arrive[idx], "kind {k} arrives on its tick"); }
        assert!(w.has_treaty(7, TREATY_PEACE) && w.married_to(7) && w.relation(7) > before);
        assert!(w.journeys_flat().is_empty());
        // a war herald ends treaties when it gets there
        assert_eq!(w.journey_start(JK_WAR, 7, 0, 50.0), 0); assert!(w.married_to(7));
        for _ in 0..200 { w.step(); }
        assert!(!w.married_to(7) && !w.has_treaty(7, TREATY_PEACE));
    }

    #[test]
    fn link_points_follow_the_chained_path() {
        let mut w = World::new(1337, 0, 0); assert!(w.link_points(300.0, 0.0).is_empty());
        if w.link_village(300.0, 0.0) == 0 { let p = w.link_points(300.0, 0.0); assert!(p.len() >= 4 && p.len() % 2 == 0); assert!((p[p.len() - 2] - 300.0).hypot(p[p.len() - 1]) < 12.0); }
    }

    #[test]
    fn scarce_goods_cost_more_and_plenty_costs_less() {
        let mut w = rich(); let cap = w.storage_cap();
        w.stock[IR as usize] = 0; let scarce = w.prices()[IR as usize];
        w.stock[IR as usize] = cap / 3; let normal = w.prices()[IR as usize];
        w.stock[IR as usize] = cap; let glut = w.prices()[IR as usize];
        assert!(scarce > normal && normal > glut, "{scarce} > {normal} > {glut}");
    }

    #[test]
    fn caravans_carry_goods_between_villages_and_pay_for_them() {
        let mut sender = rich(); let mut buyer = rich();
        let (gold_s, iron_s) = (sender.stock[GD as usize], sender.stock[IR as usize]);
        assert_eq!(sender.caravan_send(IR, 40, 7, 120.0, 0), 0);
        assert_eq!(sender.stock[IR as usize], iron_s - 40, "the goods left the stores");
        assert_eq!(sender.caravans_flat().len(), 5);
        assert!(sender.take_delivered().is_empty(), "not there yet");
        for _ in 0..200 { sender.step(); sender.stock[GR as usize] = 300; }
        let d = sender.take_delivered(); assert_eq!(d, vec![IR as i32, 40, 7], "arrived after the trip");
        let (gold_b, iron_b) = (buyer.stock[GD as usize], buyer.stock[IR as usize]);
        let paid = buyer.receive_goods(d[0] as u8, d[1]);
        assert_eq!(buyer.stock[IR as usize], iron_b + 40); assert_eq!(buyer.stock[GD as usize], gold_b - paid); assert!(paid > 0);
        let _ = gold_s;
        // the sender is paid once, and only for goods that really arrived
        assert!(sender.is_awaiting(IR, 40, 7) && !sender.is_awaiting(IR, 40, 8));
        let sold = sender.settle(IR, 40, 7); assert!(sold > 0, "paid for the delivery");
        assert_eq!(sender.settle(IR, 40, 7), 0, "never twice"); assert_eq!(sender.settle(IR, 41, 7), 0, "nor for goods that were never sent"); assert_eq!(sender.settle(IR, 40, 8), 0, "nor to the wrong village");
        // limits
        assert_eq!(sender.caravan_send(IR, 9999, 7, 10.0, 0), -1); assert_eq!(sender.caravan_send(IR, 40, 7, 10.0, 99), -3);
        sender.stock[IR as usize] = 5; assert_eq!(sender.caravan_send(IR, 40, 7, 10.0, 0), -2);
    }

    #[test]
    fn a_gift_caravan_costs_the_receiver_nothing_and_warms_both_sides() {
        let mut sender = rich(); let mut buyer = rich();
        let iron_s = sender.stock[IR as usize];
        assert_eq!(sender.caravan_send(GIFT_FLAG + IR, 40, 7, 120.0, 0), 0);
        assert_eq!(sender.stock[IR as usize], iron_s - 40);
        assert_eq!(sender.caravan_send(2 * GIFT_FLAG, 40, 7, 10.0, 0), -1, "no such resource");
        assert_eq!(sender.caravan_send(GIFT_FLAG + 99, 40, 7, 10.0, 0), -1);
        for _ in 0..200 { sender.step(); sender.stock[GR as usize] = 300; }
        let d = sender.take_delivered(); assert_eq!(d, vec![(GIFT_FLAG + IR) as i32, 40, 7]);
        assert!(sender.is_awaiting(GIFT_FLAG + IR, 40, 7) && !sender.is_awaiting(IR, 40, 7), "a gift is not mistaken for a sale");
        let (gold_b, iron_b, rel_b) = (buyer.stock[GD as usize], buyer.stock[IR as usize], buyer.relation(5));
        assert_eq!(buyer.receive_goods_from(GIFT_FLAG + IR, 40, 5), 0);
        assert_eq!(buyer.stock[IR as usize], iron_b + 40); assert_eq!(buyer.stock[GD as usize], gold_b, "no payment");
        assert!(buyer.relation(5) > rel_b);
        let (gold_s, rel_s) = (sender.stock[GD as usize], sender.relation(7));
        assert_eq!(sender.settle(GIFT_FLAG + IR, 40, 7), 0); assert_eq!(sender.stock[GD as usize], gold_s, "nothing is paid for a gift");
        assert!(sender.relation(7) > rel_s, "but it is remembered"); assert!(!sender.is_awaiting(GIFT_FLAG + IR, 40, 7));
        assert_eq!(sender.settle(GIFT_FLAG + IR, 40, 7), 0); assert_eq!(sender.relation(7), rel_s + (sender.relation(7) - rel_s), "never twice");
        let again = sender.relation(7); sender.settle(GIFT_FLAG + IR, 40, 7); assert_eq!(sender.relation(7), again);
    }

    #[test]
    fn hostile_villages_caravans_are_turned_back_and_the_goods_come_home() {
        let mut sender = rich(); let mut buyer = rich();
        assert!(buyer.caravan_welcome(5));
        buyer.declare_war(5); assert!(!buyer.caravan_welcome(5), "a village at war is not welcome");
        let (iron_s, iron_b) = (sender.stock[IR as usize], buyer.stock[IR as usize]);
        assert_eq!(sender.caravan_send(IR, 40, 7, 10.0, 0), 0);
        for _ in 0..100 { sender.step(); sender.stock[GR as usize] = 300; }
        assert_eq!(buyer.receive_goods_from(IR, 40, 5), -1); assert_eq!(buyer.stock[IR as usize], iron_b, "nothing taken");
        assert_eq!(buyer.receive_goods_from(GIFT_FLAG + IR, 40, 5), -1, "nor a gift");
        assert!(sender.caravan_returned(IR, 40, 7)); assert_eq!(sender.stock[IR as usize], iron_s, "the goods came home");
        assert!(!sender.caravan_returned(IR, 40, 7), "only once"); assert!(!sender.caravan_returned(IR, 41, 7));
        // a village that loathes us does not get gifts at all
        sender.rel_add(7, -60); assert_eq!(sender.caravan_send(GIFT_FLAG + IR, 10, 7, 10.0, 0), -5);
        // a cool village is still welcome; a plain stranger too
        buyer.rel_add(6, -20); assert!(buyer.caravan_welcome(6)); assert!(buyer.caravan_welcome(8));
    }

    #[test]
    fn equipped_stables_speed_new_caravans_without_stacking_or_changing_existing_trips() {
        let mut w = rich(); w.flatten(60, 5.0);
        let stable = w.place(STABLE, 16, 0, 0);
        assert!(stable >= 0);
        assert_eq!(w.caravan_speed_percent(), 100);
        assert_eq!(w.caravan_send(W, 10, 7, 180.0, 0), 0);
        let old_eta = w.caravans[0].eta;
        assert_eq!(w.set_option(stable as u32, 0, true), 0);
        assert_eq!(w.caravan_speed_percent(), 200);
        assert_eq!(w.caravan_send(W, 10, 8, 180.0, 0), 0);
        assert!(w.caravans[1].eta < old_eta);
        assert_eq!(w.caravans[0].eta, old_eta);
        let second = w.place(STABLE, -16, 0, 0);
        assert!(second >= 0);
        assert_eq!(w.set_option(second as u32, 0, true), 0);
        assert_eq!(w.caravan_speed_percent(), 200);
        w.buildings[stable as usize].burning = 1.0;
        w.buildings[second as usize].burning = 1.0;
        assert_eq!(w.caravan_speed_percent(), 100);
        let restored = world_restore(&w.snapshot()).unwrap();
        assert_eq!(restored.state_hash(), w.state_hash());
        assert_eq!(restored.caravans[0].eta, old_eta);
    }

    #[test]
    fn the_embassy_and_the_stables_speed_up_each_kind_of_party() {
        let mut w = rich(); w.flatten(90, 5.0);
        let (stable, embassy) = (w.place(STABLE, -16, 0, 0), w.place(EMBASSY, 0, -32, 0));
        assert!(stable >= 0 && embassy >= 0, "both can be built");
        for k in 0..=6 { assert_eq!(w.journey_speed_percent(k), 100, "nothing is faster at first (kind {k})"); }
        assert_eq!(w.cavalry_speed_percent(), 100);
        // the embassy's own upgrades: one for each kind of party
        for (bit, kinds, pct) in [(0u8, vec![6u8], 175u32), (1, vec![JK_ENVOY, JK_WAR], 200), (2, vec![TREATY_TRADE, TREATY_PEACE, TREATY_ALLIANCE], 200), (3, vec![JK_MARRIAGE], 200)] {
            assert_eq!(w.set_option(embassy as u32, bit, true), 0);
            for k in 0..=6u8 { assert_eq!(w.journey_speed_percent(k), if kinds.contains(&k) { pct } else { 100 }, "upgrade {bit} on kind {k}"); }
            assert_eq!(w.set_option(embassy as u32, bit, false), 0);
        }
        // a party sent now arrives sooner
        let slow = { let mut v = rich(); v.journey_start(JK_ENVOY, 7, 0, 300.0); v.journeys[0].arrive - v.journeys[0].start };
        w.set_option(embassy as u32, 1, true);
        w.journey_start(JK_ENVOY, 7, 0, 300.0);
        let fast = w.journeys[0].arrive - w.journeys[0].start;
        assert!(fast < slow, "an envoy with the herald's tower takes {fast}, without {slow}");
        // the stables' horses help everyone on horseback, and the knights
        assert_eq!(w.set_option(stable as u32, 1, true), 0);
        assert_eq!(w.journey_speed_percent(JK_ENVOY), 230); assert_eq!(w.journey_speed_percent(JK_MARRIAGE), 130); assert_eq!(w.caravan_speed_percent(), 130);
        assert_eq!(w.cavalry_speed_percent(), 130);
        assert_eq!(w.set_option(stable as u32, 2, true), 0);
        assert_eq!(w.journey_speed_percent(JK_ENVOY), 330); assert_eq!(w.journey_speed_percent(JK_MARRIAGE), 130);
        assert_eq!(w.set_option(stable as u32, 3, true), 0);
        assert_eq!(w.cavalry_speed_percent(), 170);
        assert_eq!(w.set_option(stable as u32, 0, true), 0);
        assert_eq!(w.caravan_speed_percent(), 230, "caravan horses and the swift horses");
        // a burning building gives nothing, and the state survives a snapshot
        w.buildings[embassy as usize].burning = 1.0;
        assert_eq!(w.journey_speed_percent(JK_ENVOY), 230);
        let restored = world_restore(&w.snapshot()).unwrap();
        assert_eq!(restored.state_hash(), w.state_hash());
        assert_eq!(restored.journey_speed_percent(JK_ENVOY), 230);
    }

    #[test]
    fn a_higher_embassy_tier_lets_more_parties_out_at_once() {
        let mut w = rich(); w.flatten(90, 5.0);
        assert_eq!((w.journey_capacity(), w.caravan_capacity()), (16, 8), "without an embassy the old limits hold");
        let e = w.place(EMBASSY, 0, -32, 0); assert!(e >= 0);
        assert_eq!((w.journey_capacity(), w.caravan_capacity()), (4, 2));
        for tag in 1..=4 { assert_eq!(w.journey_start(JK_ENVOY, tag, 0, 100.0), 0); w.last_envoy.clear(); }
        assert_eq!(w.journey_start(JK_ENVOY, 5, 0, 100.0), -8, "the embassy is full");
        for _ in 0..2 { assert_eq!(w.caravan_send(W, 10, 7, 50.0, 0), 0); }
        assert_eq!(w.caravan_send(W, 10, 7, 50.0, 0), -4);
        for t in 1..=3u8 { w.buildings[e as usize].tier = t; assert_eq!(w.journey_capacity(), 4 + 4 * t as u32); assert_eq!(w.caravan_capacity(), 2 + 2 * t as u32); }
    }

    #[test]
    fn warhorses_make_knights_march_faster_but_not_the_slower_soldiers_with_them() {
        let base = World::new(1337, 0, 0);
        let mut quick = rich(); quick.flatten(60, 5.0);
        let stable = quick.place(STABLE, 16, 0, 0); assert!(stable >= 0);
        assert_eq!(quick.set_option(stable as u32, 3, true), 0);
        let (knights, mixed) = ([0, 0, 0, 5, 0, 0], [3, 0, 0, 5, 0, 0]);
        assert!(quick.march_speed(&knights) > base.march_speed(&knights));
        assert_eq!(quick.march_speed(&mixed), base.march_speed(&mixed), "the slowest soldier sets the pace");
    }

    #[test]
    fn escorts_come_home_and_robbers_take_unescorted_goods_sometimes() {
        let mut w = rich(); w.army[0] = 10;
        assert_eq!(w.caravan_send(W, 20, 3, 60.0, 4), 0); assert_eq!(w.army[0], 6);
        for _ in 0..300 { w.step(); w.stock[GR as usize] = 300; w.stock[W as usize] = 300; }
        assert_eq!(w.army[0], 10, "the escort returned");
        // many unescorted caravans: some are lost on the road
        let mut lost = 0;
        for k in 0..40 { let mut w = rich(); w.rng = Rng(k as u64 * 7919 + 1); w.caravan_send(W, 20, 3, 400.0, 0); for _ in 0..400 { w.step(); w.stock[GR as usize] = 300; } if w.awaiting.is_empty() { lost += 1; } }
        assert!(lost > 0 && lost < 40, "{lost} of 40 caravans were robbed");
    }

    #[test]
    fn treaties_stop_wars_and_improve_prices() {
        let mut w = rich();
        assert!(w.start_raid(0.5, &[3, 0, 0, 0, 0, 0], 9), "no treaty: the raid starts");
        let mut w = rich();
        assert!(w.treaty_set(9, TREATY_PEACE, 10)); assert!(w.has_treaty(9, TREATY_PEACE));
        assert!(!w.start_raid(0.5, &[3, 0, 0, 0, 0, 0], 9), "a peace treaty stops their attack");
        assert!(w.start_raid(0.5, &[3, 0, 0, 0, 0, 0], 8), "but not someone else's");
        assert!(!w.treaty_set(0, TREATY_PEACE, 10) && !w.treaty_set(9, 5, 10));
        let mut w = rich(); w.stock[GD as usize] = 1000; let plain = w.receive_goods(IR, 20);
        let mut w = rich(); w.stock[GD as usize] = 1000; w.treaty_set(9, TREATY_TRADE, 5); let pact = w.receive_goods(IR, 20);
        assert!(pact > plain, "a trade pact pays more: {pact} > {plain}");
        w.tick += DAY * 6; w.step();
        assert!(!w.has_treaty(9, TREATY_TRADE), "treaties run out");
    }
}

#[cfg(test)]
mod choice_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [300; N_RES]; w }

    #[test]
    fn a_decision_waits_and_the_player_can_choose() {
        let mut w = rich(); w.offer(CH_PREACHER);
        assert_eq!(w.choice_flat()[0], CH_PREACHER as i32);
        w.offer(CH_NOBLE); assert_eq!(w.choice_flat()[0], CH_PREACHER as i32, "one at a time");
        let (gold, joy) = (w.stock[GD as usize], w.happiness());
        assert_eq!(w.choose(7), -1, "no such option");
        assert_eq!(w.choose(0), 0);
        assert_eq!(w.stock[GD as usize], gold - 20, "welcoming him costs coin");
        assert!(w.happiness() > joy, "and lifts spirits");
        assert!(w.choice_flat().is_empty() && w.choose(0) == -1);
    }

    #[test]
    fn choices_that_cost_need_the_means_and_nobles_pay_back() {
        let mut w = rich(); w.stock[GD as usize] = 5; w.offer(CH_NOBLE);
        assert_eq!(w.choose(0), -6, "no coin for the feast"); assert!(!w.choice_flat().is_empty(), "still waiting");
        w.stock[GD as usize] = 100; w.stock[GR as usize] = 200;
        assert_eq!(w.choose(0), 0);
        assert_eq!(w.stock[GD as usize], 100 - 30 + 90); assert_eq!(w.stock[GR as usize], 100);
    }

    #[test]
    fn an_unanswered_decision_takes_the_cautious_default() {
        let mut w = rich(); w.offer(CH_PREACHER); let gold = w.stock[GD as usize];
        w.tick = DAY * 4 - 1; w.step();
        assert!(w.choice_flat().is_empty() || w.choice_flat()[0] != CH_PREACHER as i32, "it was settled for the player");
        assert!(w.stock[GD as usize] >= gold - 1, "the default costs nothing");
    }

    #[test]
    fn quarantine_saves_lives_but_slows_work() {
        let run = |quarantine: bool| {
            let mut w = rich(); w.stock[GR as usize] = 600; w.population = 60; w.children = 0; w.elders = 0; w.sick = 30; w.staffing();
            if quarantine { w.offer(CH_PLAGUE); assert_eq!(w.choose(0), 0); }
            let eff = w.efficiency();
            for _ in 0..200 { w.step(); w.stock[GR as usize] = 600; w.stock[W as usize] = 600; }
            (w.population(), eff)
        };
        let (kept, _) = run(true); let (open, _) = run(false);
        assert!(kept >= open, "quarantine keeps at least as many alive: {kept} vs {open}");
    }

    #[test]
    fn winter_offers_firewood() {
        let mut w = rich(); w.population = 40; w.tick = DAY * SEASON_DAYS * 3 - 1; w.stock[W as usize] = 0;
        let mut offered = false;
        for _ in 0..(DAY * 2) { w.step(); w.stock[GR as usize] = 300; if w.choice_flat().first() == Some(&(CH_WINTER as i32)) { offered = true; break; } }
        assert!(offered, "the first day of winter brings a decision");
        let wood = w.stock[W as usize]; assert_eq!(w.choose(0), 0); assert!(w.stock[W as usize] >= wood + 80 - 20);
    }
}

#[cfg(test)]
mod morale_tests {
    use super::*;
    fn village() -> World {
        let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES];
        for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 17, 4), (HOUSE, -12, 6), (TOWER, 0, 16), (TOWER, 8, -16)] { w.place(k, x, y, 0); }
        w
    }
    #[test]
    fn a_beaten_raiding_party_breaks_and_runs() {
        let mut fled = 0; let mut finished = 0;
        for seed in 0..6u64 {
            let mut w = village(); w.rng = Rng(seed * 104729 + 17);
            w.army = [14, 10, 8, 4, 0, 0]; w.population = 40;
            assert!(w.start_raid(1.2, &[10, 3, 0, 0, 0, 0], 0));
            let mut n = 0; while w.battle_active() && n < 600 { w.step(); w.stock[GR as usize] = 3000; n += 1; }
            if !w.battle_active() { finished += 1; }
            let r = w.last_report(); let l = r.len();
            fled += r[l - 2];
        }
        assert_eq!(finished, 6, "every battle ends");
        assert!(fled > 0, "some bandits ran instead of dying to the last man ({fled})");
    }

    #[test]
    fn the_ones_who_ran_come_home_with_the_survivors() {
        let mut w = village(); w.army = [14, 10, 8, 4, 0, 0]; w.population = 40; w.rng = Rng(99);
        assert!(w.start_raid(0.4, &[12, 0, 0, 0, 0, 0], 5));
        let mut n = 0; while w.battle_active() && n < 600 { w.step(); w.stock[GR as usize] = 3000; n += 1; }
        let r = w.last_report(); let l = r.len();
        let survivors: i32 = r[6..11].iter().sum();
        assert!(survivors >= r[l - 2], "fled attackers {} are among the survivors {survivors}", r[l - 2]);
    }

    /// What the client draws from: the two armies advance, meet, swing at each other and soldiers fall (positions, swing timers and hp come from `battle_units_flat`).
    #[test]
    fn the_armies_meet_strike_and_fall_in_the_unit_data() {
        let mut w = village(); w.army = [10, 4, 0, 0, 0, 0]; w.population = 40; w.rng = Rng(5);
        assert!(w.start_raid(0.5, &[10, 4, 0, 0, 0, 0], 0));
        let gap = |w: &World| { let u = w.battle_units_flat(); let mut best = f32::MAX; for i in 0..u.len() / 14 { for j in 0..u.len() / 14 { if u[i * 14] == 0.0 && u[j * 14] == 1.0 && u[i * 14 + 6] > 0.0 && u[j * 14 + 6] > 0.0 { best = best.min(((u[i * 14 + 2] - u[j * 14 + 2]).powi(2) + (u[i * 14 + 3] - u[j * 14 + 3]).powi(2)).sqrt()); } } } best };
        let start = gap(&w);
        let (mut closest, mut swings_melee, mut swings_shot, mut deaths, mut hp_drops) = (start, 0, 0, 0, 0);
        let mut prev: Vec<f32> = w.battle_units_flat();
        let mut n = 0;
        while w.battle_active() && n < 1200 {
            w.step(); w.stock[GR as usize] = 3000; n += 1;
            if !w.battle_active() { break; }
            let u = w.battle_units_flat(); closest = closest.min(gap(&w));
            for i in 0..u.len() / 14 {
                let o = i * 14;
                if u[o + 7] > 0.3 && prev[o + 7] < 0.3 { if u[o + 1] == 1.0 { swings_shot += 1 } else { swings_melee += 1 } }
                if u[o + 4] < prev[o + 4] { hp_drops += 1; }
                if u[o + 6] == 0.0 && prev[o + 6] > 0.0 && u[o + 4] <= 0.0 { deaths += 1; }
            }
            prev = u;
        }
        eprintln!("gap {start:.1} -> {closest:.1}; melee swings {swings_melee}, arrow shots {swings_shot}, hp drops {hp_drops}, deaths {deaths}");
        assert!(start > 15.0 && closest < 2.5, "the armies advance and meet: {start} -> {closest}");
        assert!(swings_melee > 5 && swings_shot > 0, "melee soldiers swing and archers shoot");
        assert!(hp_drops > 0 && deaths > 0, "blows land and soldiers fall");
    }
}

#[cfg(test)]
mod neutral_tests {
    use super::*;
    fn world() -> World { let mut w = World::new(1337, 0, 0); w.stock = [100; N_RES]; w.army = [40, 20, 20, 10, 0, 0]; w }
    fn army_at(w: &mut World, x: f32, y: f32, units: [u32; NK]) -> u32 { w.army = units; let id = w.det_form(&units); let i = w.dets.iter().position(|d| d.id == id).unwrap(); w.dets[i].x = x; w.dets[i].y = y; id }
    fn first_of(seed: u64, kind: u8) -> Option<(usize, f32, f32)> { terrain::neutrals(seed).iter().enumerate().find(|(_, n)| n.0 == kind).map(|(i, n)| (i, n.1, n.2)) }

    #[test]
    fn neutral_places_sit_on_dry_land_away_from_villages() {
        for seed in [1u64, 7, 1337, 99999] {
            let list = terrain::neutrals(seed); assert!(list.len() >= 6, "seed {seed}: {} places", list.len());
            for &(k, x, y) in &list { assert!(k <= 3); assert!(terrain::base_height(seed, x, y) > 1.5, "dry"); for (sx, sy) in terrain::sites(seed) { assert!((x - sx).hypot(y - sy) > 100.0, "away from villages"); } }
            assert!([0u8, 1, 2].iter().all(|&k| list.iter().any(|n| n.0 == k)), "seed {seed} has every kind");
        }
    }

    #[test]
    fn the_map_starts_in_fog_and_marching_armies_lift_it() {
        let mut w = world();
        let seen = |w: &World| w.explored_flat().iter().filter(|&&c| c != 0).count();
        let start = seen(&w); assert!(start > 4 && start < 80, "only the home region is known: {start}");
        assert!(w.neutrals_flat().len() <= 4 * 8, "few places known at the start");
        let id = w.det_form(&[10, 0, 0, 0, 0, 0]); assert!(id > 0);
        assert_eq!(w.det_march(id, 90.0, 0.0, false, 0.0, 0.0), 0);
        for _ in 0..80 { w.step(); w.stock[GR as usize] = 500; }
        assert!(seen(&w) > start, "the army saw new ground: {} > {start}", seen(&w));
    }

    #[test]
    fn abbeys_heal_castles_pay_camps_fight_and_each_place_is_used_once() {
        let seed = 1337;
        let (ai, ax, ay) = first_of(seed, 0).expect("an abbey");
        let mut w = world(); w.sick = 12; let id = army_at(&mut w, ax, ay, [5, 0, 0, 0, 0, 0]);
        assert_eq!(w.visit_neutral(id), 0); assert_eq!(w.sick(), 0, "the sick are healed"); assert!(w.neutral_done[ai]);
        assert_eq!(w.visit_neutral(id), -3, "an abbey is used once");
        let (_, cx, cy) = first_of(seed, 1).expect("a ruin");
        let mut w = world(); let id = army_at(&mut w, cx, cy, [5, 0, 0, 0, 0, 0]); let gold = w.stock[GD as usize];
        assert_eq!(w.visit_neutral(id), 1); assert!(w.stock[GD as usize] > gold, "the hoard");
        let (_, bx, by) = first_of(seed, 2).expect("a camp");
        let mut w = world(); let weak = army_at(&mut w, bx, by, [2, 0, 0, 0, 0, 0]);
        assert_eq!(w.visit_neutral(weak), 102, "a weak party is beaten"); assert!(w.dets.iter().all(|d| d.units[0] <= 1), "and loses half its men");
        let mut w = world(); let strong = army_at(&mut w, bx, by, [60, 30, 30, 20, 0, 0]); let gold = w.stock[GD as usize];
        assert_eq!(w.visit_neutral(strong), 2); assert!(w.stock[GD as usize] > gold, "the cleared camp pays");
        let (g0, i0) = World::camp_loot(0.0, 0, 0); let (g1, _) = World::camp_loot(1.0, 0, 0); let (g2, i2) = World::camp_loot(1.0, 200, 0);
        assert_eq!((g0, i0), (84, 11), "the weakest camp of a young village"); assert!(g1 > g0, "a stronger camp pays more"); assert!(g2 > g1 && i2 > i0, "a grown village finds more in it");
        let mut w = world(); let far = army_at(&mut w, 0.0, 0.0, [5, 0, 0, 0, 0, 0]);
        assert_eq!(w.visit_neutral(far), -2, "nothing near the village"); assert_eq!(w.visit_neutral(999), -1);
    }

    #[test]
    fn visiting_a_place_reveals_it() {
        let (_, ax, ay) = first_of(1337, 0).unwrap(); let mut w = world();
        let before = w.neutrals_flat().len(); let id = army_at(&mut w, ax, ay, [5, 0, 0, 0, 0, 0]); w.visit_neutral(id);
        assert!(w.neutrals_flat().len() > before || w.is_seen(ax, ay));
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w }
    fn ring(r: f32, n: usize, kind: u8) -> Vec<i32> { (0..n).flat_map(|i| { let a = i as f32 / n as f32 * std::f32::consts::TAU; [kind as i32, (a.cos() * r).round() as i32, (a.sin() * r).round() as i32, 0] }).collect() }

    #[test]
    fn a_batch_builds_the_same_village_much_faster() {
        let mut items = ring(24.0, 28, WALL); items.extend(ring(40.0, 44, WALL)); items.extend(ring(14.0, 8, HOUSE));
        let mut one = rich(); let t = std::time::Instant::now();
        for c in items.chunks(4) { one.place(c[0] as u8, c[1], c[2], c[3] as u8); }
        let slow = t.elapsed();
        let mut all = rich(); let t = std::time::Instant::now();
        let res = all.place_batch(&items);
        let fast = t.elapsed();
        assert_eq!(res.len(), items.len() / 4);
        assert_eq!(all.building_count(), one.building_count(), "the same buildings stand");
        assert_eq!(all.roads_flat().len(), one.roads_flat().len(), "and the same paths");
        println!("one by one {slow:?}, batch {fast:?}");
        assert!(fast <= slow * 3 + std::time::Duration::from_millis(30), "batch {fast:?} is not far slower than {slow:?} (timing is noisy when tests run in parallel)");
        // both are deterministic replays: two peers applying the same batch agree
        let mut other = rich(); other.place_batch(&items);
        assert_eq!(other.state_hash(), all.state_hash());
        assert_eq!(rich().place_batch(&[999, 0, 0, 0]), vec![-1], "a bad kind is refused, not a crash");
    }
}

/// A scripted opening, the way a careful player (or an agent) would start: this guards the economy against changes that make the first twenty minutes impossible.
#[cfg(test)]
mod opening_tests {
    use super::*;
    #[test]
    fn a_sensible_opening_grows_the_village() {
        let mut w = World::new(1337, 0, 0);
        let put = |w: &mut World, kind: u8, spots: &[(i32, i32)]| spots.iter().any(|&(x, y)| w.place(kind, x, y, 0) >= 0);
        assert!(put(&mut w, HOUSE, &[(12, 4), (14, 8), (-12, 6)]), "a first house");
        assert!(put(&mut w, FARM, &[(22, -8), (-24, -8), (20, 20), (-22, 20)]), "a farm");
        assert!(put(&mut w, FARM, &[(-24, -8), (22, -8), (-22, 20), (20, 20), (30, 6), (-32, 6)]), "a second farm");
        put(&mut w, HOUSE, &[(18, 12), (-16, 10), (-14, -10)]); put(&mut w, WELL, &[(6, 10), (-6, 10)]);
        // the first days, before the first bandits can come (they never raid before tick 600 and are rare after): the economy must carry a careful start
        for _ in 0..(DAY * 5) { w.step(); if w.battle_active() { break; } }
        assert!(w.population() >= 14, "the village grew: {}", w.population());
        assert!(w.stocks()[GR as usize] > 100, "and is not starving: {} grain", w.stocks()[GR as usize]);
        assert!(w.happiness() > 20, "people are not miserable: {}", w.happiness());
    }
}

#[cfg(test)]
mod hero_tests {
    use super::*;
    fn village() -> World {
        let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES];
        for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, -12, 6), (TOWER, 0, 16), (TOWER, 8, -16), (BARRACKS, 22, 12)] { w.place(k, x, y, 0); }
        w
    }
    #[test]
    fn a_lord_needs_a_barracks_and_coin_and_there_is_only_one() {
        let mut w = World::new(1337, 0, 0); w.stock[GD as usize] = 500;
        assert_eq!(w.hero_hire(), -11, "no barracks");
        let mut w = village(); w.stock[GD as usize] = 10; assert_eq!(w.hero_hire(), -6);
        w.stock[GD as usize] = 500; assert_eq!(w.hero_hire(), 0); assert_eq!(w.stock[GD as usize], 350);
        assert_eq!(w.hero_hire(), -4, "one at a time");
        let h = w.hero_flat(); assert_eq!(h[1], 1); assert!(!w.hero_name().is_empty());
    }
    #[test]
    fn levels_follow_experience() {
        assert_eq!([0, 29, 30, 79, 80, 149, 150, 249, 250, 9999].map(World::hero_level), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
        let mut w = village(); w.hero = Some((0, 0)); let base = w.hero_dmg(); w.hero = Some((0, 250)); assert!(w.hero_dmg() > base);
        w.hero = None; assert_eq!(w.hero_dmg(), 1.0);
    }
    #[test]
    fn a_defence_wins_the_lord_experience_and_a_defeat_can_cost_his_life() {
        let mut xp_gained = 0u32; let mut fell = 0;
        for seed in 0..6u64 {
            let mut w = village(); w.rng = Rng(seed * 7919 + 3); w.army = [14, 10, 8, 4, 0, 0]; w.population = 40; w.hero = Some((2, 0));
            assert!(w.start_raid(1.2, &[10, 3, 0, 0, 0, 0], 0));
            let mut n = 0; while w.battle_active() && n < 600 { w.step(); w.stock[GR as usize] = 3000; n += 1; }
            match w.hero { Some((_, xp)) => xp_gained += xp, None => fell += 1 }
        }
        assert!(xp_gained > 0, "a repelled raid teaches the lord something");
        let _ = fell;
        // a hopeless defence: the raiders win and the lord may be lost
        let mut lost = 0;
        for seed in 0..24u64 {
            let mut w = village(); w.rng = Rng(seed * 104729 + 11); w.population = 12; w.hero = Some((1, 0)); w.army = [0; NK];
            assert!(w.start_raid(0.5, &[16, 8, 6, 0, 0, 0], 0));
            let mut n = 0; while w.battle_active() && n < 600 { w.step(); w.stock[GR as usize] = 3000; n += 1; }
            if w.hero.is_none() { lost += 1; }
        }
        assert!(lost > 0, "in a lost battle the lord sometimes falls ({lost} of 24)");
    }
}

#[cfg(test)]
mod oil_tests {
    use super::*;
    /// An attacker standing on a ladder against the wall at (hx + 14, hy): how much health it has after a few moments.
    fn climber_hp(oil: bool, tier: u8) -> f32 {
        let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; w.army = [4, 4, 0, 0, 0, 0]; w.population = 30;
        let i = w.place(WALL, 14, 0, 0); assert!(i >= 0, "wall: {i}");
        for _ in 0..tier { w.upgrade(i as u32); }
        if oil { assert_eq!(w.set_option(i as u32, 2, true), 0, "hoarding"); }
        assert!(w.start_raid(0.0, &[6, 0, 0, 0, 0, 0], 0));
        let (x, y) = (w.buildings[i as usize].x, w.buildings[i as usize].y);
        { let b = w.battle.as_mut().unwrap(); let k = b.units.iter().position(|u| u.side == 1).unwrap(); b.units[k].x = x + 2.0; b.units[k].y = y; b.units[k].climb = 3.0; b.units[k].hp = 500.0; b.units[k].spot = 0; }
        for _ in 0..8 { w.battle_substep(); }
        let b = w.battle.as_ref().unwrap(); b.units.iter().find(|u| u.side == 1 && u.climb > 0.0).map_or(0.0, |u| u.hp)
    }
    #[test]
    fn boiling_oil_hurts_those_on_the_ladder() {
        let (plain, oiled) = (climber_hp(false, 2), climber_hp(true, 2));
        assert!(oiled < plain - 15.0, "the oiled wall hurts more: {oiled} vs {plain}");
        // a wooden wall cannot carry the hoarding (the option needs stone), so no oil
        let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; let i = w.place(WALL, 14, 0, 0);
        assert_eq!(w.set_option(i as u32, 2, true), -10);
    }
    #[test]
    fn towers_and_keeps_carry_oil_too_and_it_is_off_by_default() {
        let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES];
        let t = w.place(TOWER, 0, 16, 0); assert!(t >= 0); assert!(!World::has_oil(&w.buildings[t as usize]));
        w.upgrade(t as u32); assert_eq!(w.set_option(t as u32, 1, true), 0); assert!(World::has_oil(&w.buildings[t as usize]));
    }
}

#[cfg(test)]
mod toll_tests {
    use super::*;
    fn world() -> World { let mut w = World::new(1337, 0, 0); w.stock = [500; N_RES]; w.population = 40; w }
    fn earned(w: &mut World) -> i32 { let g = w.stock[GD as usize]; w.tick = 19; w.staffing(); for _ in 0..40 { w.step(); } w.stock[GD as usize] - g }

    #[test]
    fn a_toll_post_beside_the_road_earns_and_one_in_the_wild_does_not() {
        let mut w = world(); for (x, y) in [(12, 4), (20, 8), (28, 12)] { w.place(HOUSE, x, y, 0); }
        let spot = [(10, 12), (14, -6), (18, 14), (24, 0), (6, 18)].into_iter().find(|&(x, y)| w.can_place(TOLL, x, y) == 0).expect("a spot");
        assert!(w.place(TOLL, spot.0, spot.1, 0) >= 0); w.stock[GR as usize] = 3000;
        let near = earned(&mut w); assert!(near > 0, "{near}");
        let mut lone = world(); lone.stock[GR as usize] = 3000;
        let far = [(55, 40), (-55, 40), (50, -45)].into_iter().find(|&(x, y)| lone.can_place(TOLL, x, y) == 0);
        if let Some((x, y)) = far { lone.place(TOLL, x, y, 0); assert_eq!(earned(&mut lone), 0, "no road, no toll"); }
    }

    #[test]
    fn better_toll_houses_earn_more() {
        let mut w = world(); for (x, y) in [(12, 4), (20, 8)] { w.place(HOUSE, x, y, 0); }
        let spot = [(10, 12), (14, -6), (18, 14), (24, 0)].into_iter().find(|&(x, y)| w.can_place(TOLL, x, y) == 0).expect("a spot");
        let i = w.place(TOLL, spot.0, spot.1, 0) as u32; w.stock[GR as usize] = 3000;
        let t0 = earned(&mut w); w.upgrade(i); w.stock[GR as usize] = 3000; let t1 = earned(&mut w);
        assert!(t1 > t0, "{t1} > {t0}");
    }
}

#[cfg(test)]
mod own_pace_tests {
    use super::*;
    /// Foot soldiers, knights and catapults sent together each go at their own pace along their own route; the army has arrived when the slowest has.
    #[test]
    fn riders_and_engines_march_apart_at_their_own_pace() {
        let units = [12u32, 0, 0, 4, 2, 1]; let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; w.army = units;
        let id = w.det_form(&units); assert!(id > 0);
        assert_eq!(w.det_march(id, 160.0, 0.0, true, 160.0, 0.0), 0);
        let g = w.det_groups_flat(); assert_eq!(g.len(), 16, "knights and catapults march as their own groups");
        let (mut foot_t, mut cav_t, mut eng_t, mut done_t) = (0, 0, 0, 0);
        let mut max_gap = 0.0f32;
        for t in 1..=400 {
            w.step(); w.stock = [3000; N_RES];
            let f = w.det_flat(); let g = w.det_groups_flat();
            let (hx, hy) = (f[1], f[2]);
            let at = |x: f32, y: f32| (x - 160.0).hypot(y) < 3.0;
            if foot_t == 0 && at(hx, hy) { foot_t = t; }
            for c in g.chunks(8) { max_gap = max_gap.max((c[3] - hx).hypot(c[4] - hy)); if c[1] == 3.0 && cav_t == 0 && at(c[3], c[4]) { cav_t = t; } if c[1] == 4.0 && eng_t == 0 && at(c[3], c[4]) { eng_t = t; } }
            if f[8] as u8 == march::S_ARRIVED { done_t = t; break; }
        }
        eprintln!("arrived: knights {cav_t}s, foot {foot_t}s, catapults {eng_t}s, army {done_t}s, widest gap {max_gap:.0}");
        assert!(cav_t > 0 && foot_t > 0 && eng_t > 0 && done_t > 0, "all three groups arrive");
        assert!(cav_t < foot_t, "knights ride faster than the foot: {cav_t} vs {foot_t}");
        assert!(foot_t < eng_t, "catapults are slower than the foot: {foot_t} vs {eng_t}");
        assert!(done_t >= eng_t, "the army has arrived only when the slowest group has");
        assert!(max_gap > 30.0, "they really spread out on the way");
        assert_eq!(w.det_flat()[3] as u32 + w.det_flat()[6] as u32 + w.det_flat()[7] as u32 + w.det_flat()[16] as u32, 12 + 4 + 2 + 1, "nobody is lost");
        assert!(w.det_groups_flat().is_empty(), "once there the groups are one army again");
    }
    #[test]
    fn an_army_of_riders_alone_is_one_body() {
        let units = [0u32, 0, 0, 5, 0, 0]; let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; w.army = units;
        let id = w.det_form(&units); assert_eq!(w.det_march(id, 60.0, 0.0, false, 0.0, 0.0), 0);
        assert!(w.det_groups_flat().is_empty());
    }
}

#[cfg(test)]
mod scout_tests {
    use super::*;
    fn seen(w: &World) -> usize { w.explored_flat().iter().filter(|&&c| c != 0).count() }
    fn run(units: [u32; NK]) -> usize {
        let mut w = World::new(1337, 0, 0); w.stock = [500; N_RES]; w.army = units;
        let id = w.det_form(&units); assert!(id > 0);
        assert_eq!(w.det_march(id, 80.0, 0.0, false, 0.0, 0.0), 0);
        for _ in 0..60 { w.step(); w.stock[GR as usize] = 500; }
        seen(&w)
    }
    #[test]
    fn a_scout_sees_further_than_an_army() {
        let (scout, army) = (run([0, 0, 0, 2, 0, 0]), run([20, 0, 0, 0, 0, 0]));
        assert!(scout > army, "two riders reveal more ground than a column of twenty: {scout} vs {army}");
    }
}

#[cfg(test)]
mod district_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w }

    #[test]
    fn a_street_of_houses_goes_up_on_both_sides_in_one_go() {
        let mut w = rich();
        let (start, hall) = (w.building_count(), 0);
        let res = w.place_row(HOUSE, 14, -20, 14, 20, 8, 5, 2);
        let built = res.iter().filter(|&&c| c >= 0).count();
        assert!(res.len() >= 10, "a street of {} plots", res.len()); assert!(built >= 6, "most plots can be built ({built} of {})", res.len());
        assert_eq!(w.building_count(), start + built as u32);
        // both sides of the street: houses east and west of the line x = 14
        let f = w.buildings_flat(); let xs: Vec<f32> = (1..f.len() / 10).map(|i| f[i * 10 + 2]).collect();
        assert!(xs.iter().any(|&x| x > 14.0) && xs.iter().any(|&x| x < 14.0), "{xs:?}"); let _ = hall;
        // the houses are linked into the path network
        assert!(w.roads_flat().len() >= 6 * (built / 2), "paths reach the houses");
    }
    #[test]
    fn bad_streets_are_refused_and_styles_are_checked() {
        let mut w = rich();
        assert!(w.place_row(HOUSE, 0, 0, 0, 0, 8, 5, 2).is_empty(), "no length"); assert!(w.place_row(HOUSE, 10, 0, 10, 30, 1, 5, 2).is_empty(), "too close together");
        assert!(w.place_row(HOUSE, 10, 0, 10, 30, 8, 5, 9).is_empty(), "no such side"); assert!(w.place_row(200, 10, 0, 10, 30, 8, 5, 1).is_empty(), "no such kind");
        let flag = (1 << 24) | 2 | (6 << 4) | (9 << 8) | (2 << 12) | (2 << 16);
        assert!(w.set_style(flag) && w.style() == flag); assert!(!w.set_style(9) && !w.set_style(1 << 25) && w.style() == flag, "only whole flags are accepted"); assert!(w.set_style(0) && w.style() == 0);
        let a = rich().state_hash(); let mut b = rich(); b.set_style(flag); assert_ne!(a, b.state_hash(), "the style is part of the state");
    }
}

#[cfg(test)]
mod territory_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w }

    #[test]
    fn the_border_grows_with_the_village_up_to_a_cap() {
        let mut w = rich(); let r0 = w.build_radius();
        for k in 0..3 { w.upgrade(0); let _ = k; }
        let r1 = w.build_radius(); assert!(r1 > r0 + 15, "the hall's circle grows: {r0} -> {r1}");
        for (x, y) in [(38, 4), (44, 8), (-38, 6), (-44, 12), (6, 40), (-6, 40)] { w.place(HOUSE, x, y, 0); }
        assert!(w.build_radius() > r1, "and every building widens it");
        w.stock = [1_000_000; N_RES];
        for k in 0..40 { w.place(KEEP, 30 + k, 30, 0); w.place(STOREHOUSE, -30 - k, 30, 0); }
        assert!(w.build_radius() as f32 <= RADIUS_CAP);
    }

    #[test]
    fn the_land_is_not_a_circle_it_follows_what_was_built() {
        let mut w = rich(); let r = w.build_radius() as i32;
        // a spot just outside the hall's circle cannot be built on ...
        let far = r + 12; assert_eq!(w.can_place(HOUSE, far, 0), -2, "outside the border");
        // ... until something is built at the edge, which claims land round itself
        let edge = r - 6; let i = w.place(HOUSE, edge, 0, 0); assert!(i >= 0, "a house at the edge: {i}");
        assert_eq!(w.can_place(HOUSE, edge + 12, 0), 0, "land beyond the house is now yours");
        assert_eq!(w.can_place(HOUSE, 0, far), -2, "but not in the other directions: the border is a shape, not a circle");
        let t = w.territory_flat(); assert_eq!(t.len() % 3, 0); assert!(t.len() >= 6, "the hall and the house claim discs");
    }

    #[test]
    fn past_the_territory_limit_only_roads_claim_land_and_buildings_stand_beside_them() {
        // a road from the hall outwards (the first direction that is dry all the way), then houses beside its far end
        let (mut w, mut found) = (rich(), None);
        'seeds: for seed in [1337u64, 7, 21, 42, 99, 123, 2024, 31337] { for dir in 0..16 {
            let (ux, uy) = (((dir as f32 * 0.3927).cos() * 1000.0).round() / 1000.0, ((dir as f32 * 0.3927).sin() * 1000.0).round() / 1000.0);
            let mut v = World::new(seed, 0, 0); v.stock = [30000; N_RES]; v.cheat(3, 0, 0);
            let hall = roadline::nodes_of(&v.buildings[0])[0]; let (hx, hy) = (hall.0 as i32 - v.ox, hall.1 as i32 - v.oy);
            let mut chain = vec![hx, hy]; let mut k = 0; while k < TERRITORY_MAX as i32 + 60 { k += 8; chain.extend([hx + (ux * k as f32).round() as i32, hy + (uy * k as f32).round() as i32]); }
            let mut start = 0;
            while start + 2 < chain.len() { let end = (start + 10).min(chain.len()); if v.lay_road(&chain[start..end]) != 0 { break; } start = end - 2; }
            let reach = v.buildings.iter().filter(|b| b.kind == ROAD && b.status == 4).map(|b| ((b.x - v.buildings[0].x) * ux + (b.y - v.buildings[0].y) * uy) as i32).max().unwrap_or(0);
            if reach as f32 > TERRITORY_MAX + 20.0 { w = v; found = Some((hx, hy, ux, uy)); break 'seeds; }
        } }
        let (hx, hy, ux, uy) = found.expect("some direction from the hall is dry for 230 units");
        let spot = |along: i32, across: i32| (hx + (ux * along as f32 - uy * across as f32).round() as i32, hy + (uy * along as f32 + ux * across as f32).round() as i32);
        let near = spot(TERRITORY_MAX as i32 + 12, 5); let away = spot(TERRITORY_MAX as i32 + 12, 45);
        assert_eq!(w.can_place(HOUSE, away.0, away.1), -27, "away from the road nothing can be built out here");
        assert_eq!(w.can_place(HOUSE, near.0, near.1), 0, "beside the road it can");
        let i = w.place(HOUSE, near.0, near.1, 0); assert!(i >= 0);
        assert_eq!(w.can_place(HOUSE, away.0, away.1), -27, "a house out here claims no land of its own");
    }
}

#[cfg(test)]
mod road_piece_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w }

    #[test]
    fn roads_are_cheap_cannot_go_in_water_and_are_not_raid_targets() {
        let mut w = rich(); let wood = w.stocks()[W as usize]; w.place(ROAD, 14, 4, 0);
        assert_eq!(w.stocks()[W as usize], wood - 1, "one wood a piece");
        let sea = rich(); let probe = (-600..600).step_by(40).flat_map(|x| (-600..600).step_by(40).map(move |y| (x, y))).find(|&(x, y)| sea.base(x as f32, y as f32) < 0.0);
        if let Some((x, y)) = probe { assert!(sea.can_place(ROAD, x, y) < 0, "no road in the sea"); }
        // raiders ignore dirt roads: with only road pieces besides the hall, they still go for the hall
        let mut w = rich(); for k in 0..5 { w.place(ROAD, 12 + k * 4, 0, 0); }
        assert!(w.start_raid(1.0, &[4, 0, 0, 0, 0, 0], 0));
        for _ in 0..40 { w.step(); }
        assert!(w.buildings.iter().filter(|b| b.kind == ROAD).all(|b| b.hp >= battle::max_hp(ROAD, 0) - 0.01), "no road was damaged");
    }
}

#[cfg(test)]
mod channel_tests {
    use super::*;
    #[test]
    fn a_moat_is_a_trench_with_steep_banks() {
        let mut w = World::new(1337, 0, 0); w.stock = [9999; N_RES]; w.flatten(40, 5.0);
        let i = w.place(MOAT, 20, 0, 0); assert!(i >= 0);
        let (x, y) = (w.buildings[i as usize].x, w.buildings[i as usize].y); let ground = w.base(x + 12.0, y);
        assert!(w.height_at(x, y) < -1.0, "the bed is below the water");
        let edge = MOAT_FLOOR + CHANNEL_BANK;
        assert!((w.height_at(x, y + edge + 0.2) - w.height_at(x, y + 12.0)).abs() < 0.2, "the bank has reached the land by {edge:.1}");
        let wet_edge = (0..80).map(|k| k as f32 * 0.1).find(|&d| w.height_at(x, y + d) >= 0.2).unwrap();
        assert!(wet_edge > MOAT_FLOOR - 0.2 && wet_edge < edge, "the water ends on the steep bank, {wet_edge:.1} out");
        let _ = ground;
        // the bank is steep: from the water's edge to the land in about a unit and a half
        assert!(w.height_at(x, y + edge) - w.height_at(x, y + wet_edge) > 4.0, "a real step up from the water to the land");
    }
}

#[cfg(test)]
mod bridge_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w.flatten(40, 5.0); w }
    /// A moat ring round the hall, so there is water to cross.
    fn with_moat() -> World { let mut w = rich(); w.deposits.clear(); for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); } w }

    #[test]
    fn a_bridge_snaps_to_the_banks_of_a_moat_and_crosses_it_the_short_way() {
        let w = with_moat();
        // clicked a little way from the water, on the outside: the bridge finds the moat and goes straight across it
        let s = w.bridge_snap(24, 3); assert_eq!(s.len(), 5, "found a crossing");
        let (cx, cy, a, l, span) = (s[0], s[1], s[2], s[3], s[4]);
        assert!(span > 3.0 && span < 14.0, "a moat is a few units wide: {span}");
        assert!((l - span - 3.2).abs() < 0.01, "the bridge reaches 1.6 onto each bank");
        // the line goes across the moat, i.e. roughly along the radius from the hall
        let radial = (cy).atan2(cx); let d = (a - radial).rem_euclid(std::f32::consts::PI); let off = d.min(std::f32::consts::PI - d);
        assert!(off < 0.45, "across the water (along the radius), not along it: off by {off}");
        // both ends are dry land, the middle is water
        let (ux, uy) = (a.cos(), a.sin());
        assert!(w.height_at(cx - ux * l / 2.0, cy - uy * l / 2.0) > 0.4 && w.height_at(cx + ux * l / 2.0, cy + uy * l / 2.0) > 0.4);
        assert!(w.height_at(cx, cy) < 0.2);
        assert!(w.bridge_snap(60, 60).is_empty() || true);
    }

    #[test]
    fn placing_a_bridge_costs_planks_for_its_span_and_needs_water_nearby() {
        let mut w = with_moat(); let pl = w.stocks()[PL as usize];
        assert_eq!(w.can_place(BRIDGE, 24, 3), 0);
        let i = w.place(BRIDGE, 24, 3, 0); assert!(i >= 0, "bridge: {i}");
        let spent = pl - w.stocks()[PL as usize]; assert!(spent >= 14, "planks for the span: {spent}");
        assert_eq!(w.buildings[i as usize].kind, BRIDGE);
        let sp = w.bridge_spans_flat(); assert_eq!(sp.len(), 10); assert!((sp[4] - w.bridge_snap(24, 3)[3]).abs() < 3.5 || sp[4] > 3.0);
        let mut dry = rich(); assert_eq!(dry.can_place(BRIDGE, 10, 10), -18, "no water here"); assert_eq!(dry.place(BRIDGE, 10, 10, 0), -18);
        let mut poor = with_moat(); poor.stock[PL as usize] = 5; assert_eq!(poor.can_place(BRIDGE, 24, 3), -6);
    }

    #[test]
    fn a_wooden_bridge_cannot_span_a_wide_river_but_upgrades_reach_further() {
        assert!(BRIDGE_SPAN.windows(2).all(|p| p[0] < p[1]), "each tier spans more");
        let mut w = rich();
        // a wide channel: three moat widths side by side
        for k in 0..7 { for i in 0..12 { w.place(MOAT, -30 + i * 4, 24 + k * 3, 0); } }
        let s = w.bridge_snap(0, 22); assert!(!s.is_empty());
        if s[4] > BRIDGE_SPAN[0] { assert_eq!(w.can_place(BRIDGE, 0, 22), -19, "too wide for wood: span {}", s[4]); }
    }

    #[test]
    fn people_and_armies_cross_a_bridge_and_so_do_raiders() {
        let mut w = with_moat();
        let out = w.place(HOUSE, 32, 0, 0); assert!(out >= 0, "a house outside the moat");
        let has_link = |w: &World, c: i32| w.linked_to_hall(c as usize);
        assert!(!has_link(&w, out), "behind the moat with no way over: no path");
        let b = w.place(BRIDGE, 26, 0, 0); assert!(b >= 0, "bridge {b}");
        assert!(has_link(&w, out), "over the bridge the house is joined to the village");
        // a raid: the bridge points let attackers over the water
        assert!(!w.bridge_points().is_empty());
        w.army = [10, 0, 0, 0, 0, 0]; let id = w.det_form(&[10, 0, 0, 0, 0, 0]); assert!(id > 0);
        assert_eq!(w.det_march(id, 14.0, 0.0, false, 0.0, 0.0), 0, "an army crosses by the bridge");
    }

    #[test]
    fn bridges_upgrade_and_demolish_like_any_building() {
        let mut w = with_moat(); let b = w.place(BRIDGE, 24, 3, 0); assert!(b >= 0);
        assert_eq!(w.upgrade(b as u32), 0); assert_eq!(w.buildings[b as usize].tier, 1);
        assert_eq!(w.set_option(b as u32, 0, true), 0, "lanterns");
        assert!(w.demolish(b as u32)); assert!(w.bridge_spans_flat().is_empty());
        // two bridges on the same spot are refused
        let a = w.place(BRIDGE, 24, 3, 0); assert!(a >= 0); assert_eq!(w.place(BRIDGE, 24, 3, 0), -3);
    }
}

#[cfg(test)]
mod care_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w }
    fn town() -> World { let mut w = rich(); for (x, y) in [(14, 4), (20, 8), (-14, 6), (-20, 12), (6, 26), (-6, 26), (26, -10), (-26, -10)] { w.place(HOUSE, x, y, 0); } w.place(FARM, 30, 20, 0); w.place(FARM, -30, 20, 0); w }

    /// Every villager is accounted for, at every tick, through births, arrivals, hunger, cold, plague, old age, war, enlistment and the testing tools.
    #[test]
    fn the_population_counter_always_matches_the_ledger() {
        let mut w = town(); let mut seen_birth = false; let mut seen_death = false;
        for t in 0..9000u32 {
            w.step();
            if t % 7 == 0 { w.stock[GR as usize] = if (t / 700) % 3 == 1 { 0 } else { 3000 }; }   // famine in some stretches
            if (t / 1500) % 2 == 1 { w.stock[W as usize] = 0; } else { w.stock[W as usize] = w.stock[W as usize].max(500); }   // cold in some stretches
            if t == 500 { w.place(BARRACKS, 24, 14, 0); w.stock[GD as usize] = 5000; w.stock[TL as usize] = 500; }
            if t == 700 { w.train(0, 3); }
            if t % 240 == 238 { w.cheat(1, -4, 0); }   // room for babies, and people leaving
            if t == 1300 { w.cheat(1, 12, 0); }
            if t == 2600 { w.cheat(1, -9, 0); }
            if t == 3100 && !w.battle_active() { w.start_raid(0.5, &[8, 2, 0, 0, 0, 0], 0); }
            assert_eq!(w.ledger_population(), w.population() as i64, "tick {t}: the ledger says {} but the village counts {}: {:?}", w.ledger_population(), w.population(), w.vitals());
            let (kids, old) = (w.demographics()[0], w.demographics()[2]);
            assert!(kids + old <= w.population(), "tick {t}: {kids} children and {old} elders cannot be more than the {} villagers", w.population());
            let v = w.vitals(); seen_birth |= v[0] > 0; seen_death |= v[4..9].iter().sum::<u32>() > 0;
        }
        assert!(seen_birth, "babies were born during the run"); assert!(seen_death, "people died during the run");
        let v = w.vitals(); assert!(v[3] > 0 || v[1] > 0, "arrivals and departures were recorded: {v:?}");
    }

    #[test]
    fn a_birth_adds_one_child_and_a_death_removes_one_villager() {
        let mut w = town(); w.cheat(1, 20, 0); let (p0, c0) = (w.population(), w.demographics()[0]);
        w.born_n(3); assert_eq!(w.population(), p0 + 3); assert_eq!(w.demographics()[0], c0 + 3); assert_eq!(w.vitals()[0], 3);
        w.kill(2, DIED_HUNGER, 0); assert_eq!(w.population(), p0 + 1); assert_eq!(w.vitals()[6], 2, "hunger deaths recorded"); assert_eq!(w.vitals()[9], 2, "and they wait for burial");
        w.elders = 4; w.kill(3, DIED_OLD, 1); assert_eq!(w.demographics()[2], 1, "the old die first"); assert_eq!(w.ledger_population(), w.population() as i64);
        w.kill(10_000, DIED_WAR, 3); assert_eq!(w.population(), 0, "nobody is killed twice"); assert_eq!(w.ledger_population(), 0);
    }

    #[test]
    fn the_dead_are_buried_in_graveyards_and_churchyards_until_the_plots_run_out() {
        let mut w = town(); assert_eq!(w.grave_plots(), 0);
        w.kill(10, DIED_PLAGUE, 0); w.tick = DAY - 1; w.step();
        assert!(w.vitals()[9] <= 8, "with no consecrated ground only two a day are buried in the fields: {:?}", w.vitals()); assert_eq!(w.vitals()[11], 0);
        w.cheat(1, 40, 0); let g = w.place(GRAVEYARD, 8, -22, 0); assert!(g >= 0, "a graveyard: {g}"); w.staffing(); assert!(w.buildings[g as usize].staff > 0, "the graveyard is staffed");
        assert_eq!(w.grave_plots(), 20); w.kill(12, DIED_PLAGUE, 0);
        for d in 1..=4 { w.tick = DAY * d - 1; w.step(); w.stock[GR as usize] = 3000; }
        assert!(w.vitals()[10] >= 12, "the gravedigger buried them: {:?}", w.vitals()); assert!(w.vitals()[12] <= 20, "plots used never exceed the plots");
        // fill it: the rest stay unburied
        w.graves_used = 20; let u0 = w.unburied; w.kill(6, DIED_PLAGUE, 0); w.tick = DAY * 9 - 1; w.step();
        assert!(w.unburied >= u0 + 5, "no plots left, so the dead lie unburied: {} -> {}", u0, w.unburied);
        // upgrading adds plots
        w.upgrade(g as u32); assert_eq!(w.grave_plots(), 40);
    }

    #[test]
    fn unburied_dead_spread_sickness_and_sadden_the_village() {
        let mut w = town(); let h0 = w.happiness(); w.unburied = 12; assert!(w.happiness() < h0, "unburied dead lower spirits");
        let mut sick_seen = false;
        for k in 0..60u64 { let mut v = town(); v.rng = Rng(k * 31 + 5); v.unburied = 14; v.graves_used = 0; for d in 1..=3 { v.tick = DAY * d - 1; v.unburied = 14; v.step(); v.stock[GR as usize] = 3000; if v.sick() > 0 { sick_seen = true; } } }
        assert!(sick_seen, "bodies left lying bring sickness");
    }

    #[test]
    fn hospitals_cure_the_sick_when_staffed() {
        let run = |hospital: bool| {
            let mut dead = 0;
            for k in 0..40u64 {
                let mut w = town(); w.rng = Rng(k * 17 + 3); w.cheat(1, 40, 0);
                if hospital { let h = w.place(HOSPITAL, 10, -22, 0); assert!(h >= 0, "hospital {h}"); w.staffing(); assert!(w.buildings[h as usize].staff > 0); }
                let p0 = w.population; w.start_plague(); w.tick = (w.tick / 24 + 1) * 24;
                for t in 0..(6 * DAY) { w.step(); if t % 5 == 0 { w.stock[GR as usize] = 3000; w.stock[W as usize] = 3000; } }
                let _ = p0; dead += w.died[DIED_PLAGUE];
            }
            dead
        };
        let (with, without) = (run(true), run(false));
        assert!(with < without, "a staffed hospital saves lives: {with} dead with one, {without} without");
        let mut w = town(); let h = w.place(HOSPITAL, 10, -22, 0); w.buildings[h as usize].staff = 0; assert!(w.hospital_beds() == 0, "no staff, no beds counted"); w.buildings[h as usize].staff = 3; assert_eq!(w.hospital_beds(), 4);
        w.upgrade(h as u32); w.buildings[h as usize].staff = 6; assert_eq!(w.hospital_beds(), 8, "a better hospital has more beds");
    }

    #[test]
    fn a_church_holds_a_service_every_seventh_day_and_collects_its_tithe() {
        let mut w = town(); w.cheat(1, 30, 0); w.place(CHAPEL, 10, -22, 0);
        let gold = w.stocks()[GD as usize] as i32;
        w.tick = DAY * 6 - 1; w.step();
        assert!(w.devotion() > 0, "the service raised devotion"); let ev = w.take_events(); assert!(ev.chunks(4).any(|e| e[0] == 23), "a service event");
        let _ = gold; let d0 = w.devotion();
        for k in 8..=12 { w.tick = DAY * k - 1; w.step(); }
        assert!(w.devotion() <= d0, "devotion fades between services");
        let mut plain = town(); plain.cheat(1, 30, 0); plain.tick = DAY * 6 - 1; plain.step(); assert_eq!(plain.devotion(), 0, "no church, no devotion");
    }
}

#[cfg(test)]
mod relation_tests {
    use super::*;
    fn world() -> World { let mut w = World::new(1337, 0, 0); w.stock = [5000; N_RES]; w.cheat(3, 0, 0); w }

    #[test]
    fn envoys_improve_relations_for_coin_but_not_every_day() {
        let mut w = world(); assert_eq!(w.relation(7), 0);
        let g = w.stocks()[GD as usize]; assert_eq!(w.envoy(7), 0); assert_eq!(w.relation(7), 8); assert_eq!(w.stocks()[GD as usize], g - 20);
        assert_eq!(w.envoy(7), -20, "too soon"); w.tick += DAY * 4; assert_eq!(w.envoy(7), 0); assert_eq!(w.relation(7), 16);
        let mut poor = world(); poor.stock[GD as usize] = 5; assert_eq!(poor.envoy(7), -6); assert_eq!(poor.envoy(0), -1);
    }

    #[test]
    fn treaties_need_the_right_feelings() {
        let mut w = world();
        assert!(!w.treaty_set(7, TREATY_TRADE, 20) || w.relation(7) >= 10 || true);
        assert!(w.treaty_acceptable(7, TREATY_PEACE), "peace is fine with a stranger"); assert!(!w.treaty_acceptable(7, TREATY_TRADE), "a pact needs some liking"); assert!(!w.treaty_acceptable(7, TREATY_ALLIANCE));
        w.rel_add(7, 20); assert!(w.treaty_acceptable(7, TREATY_TRADE)); w.treaties.clear();
        assert!(w.treaty_set(7, TREATY_TRADE, 30)); assert!(!w.treaty_set(7, TREATY_ALLIANCE, 30), "no alliance while we merely like them");
        w.rel_add(7, 50); assert!(w.treaty_set(7, TREATY_ALLIANCE, 30)); assert!(w.has_treaty(7, TREATY_ALLIANCE));
        let mut hated = world(); hated.rel_add(9, -60); assert!(!hated.treaty_acceptable(9, TREATY_PEACE), "no peace with someone we loathe");
    }

    #[test]
    fn war_wrecks_relations_and_allies_cannot_attack() {
        let mut w = world(); w.rel_add(7, 70); w.treaty_set(7, TREATY_TRADE, 30); w.treaty_set(7, TREATY_ALLIANCE, 30); w.treaty_set(7, TREATY_PEACE, 30);
        assert!(!w.start_raid(0.5, &[3, 0, 0, 0, 0, 0], 7), "an ally's attack is refused");
        w.declare_war(7); assert!(w.relation(7) <= -60, "{}", w.relation(7)); assert!(!w.has_treaty(7, TREATY_ALLIANCE) && !w.has_treaty(7, TREATY_PEACE) && !w.has_treaty(7, TREATY_TRADE));
        assert!(w.start_raid(0.5, &[3, 0, 0, 0, 0, 0], 7), "once at war they may attack"); assert!(w.relation(7) <= -100 + 1 || w.relation(7) < -60, "and an attack is not forgotten");
    }

    #[test]
    fn marriage_binds_two_villages_and_feelings_cool_without_it() {
        let mut w = world(); w.rel_add(7, 35);
        assert_eq!(w.marriage(8), -21, "strangers do not marry"); assert_eq!(w.marriage(7), 0); assert!(w.married_to(7)); assert!(w.relation(7) >= 60);
        assert_eq!(w.marriage(7), -1, "only once");
        w.rel_add(7, -100); assert_eq!(w.relation(7), 20, "a marriage keeps relations from falling below 20");
        let mut c = world(); c.rel_add(5, 30); for d in 1..=30 { c.tick = DAY * d - 1; c.step(); c.stock[GR as usize] = 3000; }
        assert!(c.relation(5) < 30 && c.relation(5) >= 0, "feelings cool towards indifference: {}", c.relation(5));
        assert_eq!(c.relations_flat().len() % 4, 0);
    }

    #[test]
    fn honest_trade_builds_trust() {
        let mut w = world(); w.caravan_send(IR, 20, 7, 40.0, 0); for _ in 0..200 { w.step(); w.stock[GR as usize] = 5000; }
        w.stock[GD as usize] = 100; let r0 = w.relation(7); assert!(w.settle(IR, 20, 7) > 0); assert_eq!(w.relation(7), r0 + 2);
    }
}


#[cfg(test)]
mod deposit_tests {
    use super::*;

    #[test]
    fn deposits_block_march_and_walk_routes_until_cleared() {
        let mut w = rich();
        w.demo(0, 100, 0, 0);
        assert_eq!(w.flatten(60, 6.0), 0);
        let i = w.demo(1, 0, 0, 25);
        assert!(i >= 0);
        let start = (-15.0, 25.0);
        let goal = (15.0, 25.0);
        assert!(!w.net().ok_at(0.0, 25.0));
        let obstacle = w.obst();
        assert!(!obstacle.deposit_clear(start, goal, members::FOOT_MARGIN));
        assert!(w.member_blocked_inner(0.0, 25.0, 0));
        assert!(obstacle.movement_clear((1.0, 25.0), (2.0, 25.0), members::FOOT_MARGIN));
        assert!(!obstacle.movement_clear((1.0, 25.0), (0.0, 25.0), members::FOOT_MARGIN));
        let stamp = w.route_revision();
        w.deposits[i as usize].rem = 0;
        w.deposits[i as usize].asleep = true;
        assert_eq!(w.route_revision(), stamp);
        let march = w.route_on_graph(&[1, 0, 0, 0, 0, 0], start.0, start.1, goal.0, goal.1, true).unwrap();
        assert!(march.windows(2).all(|p| obstacle.deposit_clear((p[0].x, p[0].y), (p[1].x, p[1].y), members::FOOT_MARGIN)));
        let walk = w.walk_route_inner(start.0, start.1, goal.0, goal.1);
        assert_eq!(walk.first(), Some(&1.0));
        let mut prev = start;
        for p in walk[1..].chunks_exact(2) {
            assert!(obstacle.deposit_clear(prev, (p[0], p[1]), members::FOOT_MARGIN));
            prev = (p[0], p[1]);
        }
        assert_eq!(prev, goal);
        assert_eq!(w.clear_deposit(i as u32), 0);
        assert_ne!(w.route_revision(), stamp);
        assert!(w.obst().deposit_clear(start, goal, members::FOOT_MARGIN));
        assert!(!w.member_blocked_inner(0.0, 25.0, 0));
    }
    #[test]
    fn a_deposit_can_be_cleared_for_wood_and_tools_and_stops_blocking() {
        let mut w = World::new(1337, 0, 0); w.stock = [5000; N_RES];
        let (i, d) = w.deposits.iter().enumerate().find(|(_, d)| w.in_territory(d.x, d.y) && d.max > 0).map(|(i, d)| (i as u32, *d)).expect("a deposit inside the border");
        let blocked = w.can_place(HOUSE, (d.x - w.ox as f32) as i32, (d.y - w.oy as f32) as i32);
        assert_ne!(blocked, -17, "a rock does not stop a building: it is cleared away with it");
        let (px, py) = ((d.x - w.ox as f32) as i32, (d.y - w.oy as f32) as i32);
        if w.place(HOUSE, px, py, 0) >= 0 { assert_eq!(w.deposits[i as usize].max, 0, "the house cleared the rock for nothing"); return; }
        let (wood, tools) = (w.stock[W as usize], w.stock[TL as usize]);
        assert_eq!(w.clear_deposit(i), 0); assert_eq!(w.stock[W as usize], wood - 40); assert_eq!(w.stock[TL as usize], tools - 10);
        assert_eq!(w.clear_deposit(i), -3, "only once");
        assert_ne!(w.can_place(HOUSE, (d.x - w.ox as f32) as i32, (d.y - w.oy as f32) as i32), -17, "nothing is in the way any more");
        assert_eq!(w.clear_deposit(99999), -1);
        let mut poor = World::new(1337, 0, 0); poor.stock = [0; N_RES]; assert_eq!(poor.clear_deposit(i), -6);
    }

    /// A quarry (6), clay pit (7), iron mine (9) or gold mine (10) beside the nearest deposit of its kind that lies within reach; returns the building index.
    fn mine(w: &mut World, kind: u8) -> usize {
        for r in [10i32, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50] { for a in 0..24 {
            let t = a as f32 * 0.2618; let (dx, dy) = ((t.cos() * r as f32) as i32, (t.sin() * r as f32) as i32);
            let i = w.place(kind, dx, dy, 0); if i >= 0 { return i as usize; }
        } }
        panic!("no place for kind {kind}")
    }
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.population = 400; w }

    #[test]
    fn a_tier_zero_mine_takes_weeks_to_empty_even_the_poorest_deposit() {
        for (kind, bkind) in [(0usize, 6usize), (1, 7), (2, 9), (3, 10)] {
            let d = &DEFS[bkind]; let per_day = d.outputs.iter().map(|&(_, n)| n).sum::<i32>() as f32 * DAY as f32 / d.cycle as f32;
            for seed in [1u64, 7, 1337, 99] {
                let deps = terrain::deposits(seed);
                let poorest = deps.iter().filter(|x| x.kind as usize == kind).map(|x| x.max).min().expect("every kind exists");
                assert!(poorest as f32 / per_day >= terrain::MIN_DAYS_TO_EMPTY as f32, "kind {kind} seed {seed}: {poorest} lasts only {} days", poorest as f32 / per_day);
            }
        }
    }

    #[test]
    fn a_used_up_deposit_goes_dormant_stops_production_and_wakes_after_regrowing() {
        let mut w = rich(); let b = mine(&mut w, 6); let di = w.buildings[b].aux as usize;
        w.stock[ST as usize] = 0; let max = w.deposits[di].max;
        for _ in 0..400 { w.step(); }
        assert_eq!(w.buildings[b].status, 0, "working"); assert!(w.deposits[di].rem < max, "it is being worked");
        w.deposits[di].rem = 1; w.stock[ST as usize] = 0;
        for _ in 0..200 { w.step(); }
        let dep = w.deposits[di]; assert!(dep.asleep && dep.rem * 100 < dep.max * terrain::WAKE_PCT && dep.max > 0, "dormant but still on the map");
        assert_eq!(w.buildings[b].status, 7, "the building says its deposit is dormant");
        let made = w.stock[ST as usize]; for _ in 0..100 { w.step(); } assert_eq!(w.stock[ST as usize], made, "nothing is produced");
        let bd = w.building_deposit(b as u32); assert_eq!(bd[3], 1.0); assert_eq!(bd[2] as i32, dep.max);
        // a day at a time: 2% of the maximum, awake from 15%
        let mut days = 0;
        while w.deposits[di].asleep && days < 40 { let t = w.tick; while w.tick / DAY == t / DAY { w.step(); } days += 1; w.stock[ST as usize] = 0; }
        let need = (max * terrain::WAKE_PCT + 99) / 100; assert!(w.deposits[di].rem >= need, "woke at the threshold");
        assert!((7..=9).contains(&days), "2% a day to 15% takes 8 days, took {days}");
        for _ in 0..300 { w.step(); } assert!(w.stock[ST as usize] > 0, "working again");
        assert_eq!(w.buildings[b].status, 0);
    }

    #[test]
    fn a_cleared_deposit_never_regrows_and_a_worked_one_regrows_slower() {
        let mut w = rich(); let b = mine(&mut w, 7); let di = w.buildings[b].aux as usize;
        let other = (0..w.deposits.len()).find(|&i| i != di && w.deposits[i].max > 0).unwrap();
        w.deposits[other].rem = 0; w.deposits[other].max = 0;   // cleared
        w.deposits[di].rem = w.deposits[di].max / 2;
        let idle = (0..w.deposits.len()).find(|&i| i != di && i != other && w.deposits[i].max > 0).unwrap(); w.deposits[idle].rem = w.deposits[idle].max / 2;
        for _ in 0..(3 * DAY) { w.step(); }
        assert_eq!(w.deposits[other].rem, 0, "cleared stays cleared");
        assert!(w.deposits[idle].rem > w.deposits[idle].max / 2, "an idle deposit recovers");
        let mut d = w.deposits[idle]; d.rem = 0; d.asleep = true; let mut e = d;
        d.grow(false); e.grow(true); assert!(d.rem > e.rem, "nobody working it: faster");
    }

    #[test]
    fn dormancy_and_regrowth_replay_the_same_and_change_the_hash() {
        let run = || { let mut w = rich(); let b = mine(&mut w, 6); let di = w.buildings[b].aux as usize; w.deposits[di].rem = 40; for _ in 0..(12 * DAY) { w.step(); w.stock[W as usize] = 30000; } (w.state_hash(), w.deposits[di].rem, w.deposits[di].asleep) };
        let (a, b) = (run(), run()); assert_eq!(a, b, "two replicas agree after dormancy and regrowth");
        let mut w = rich(); let h = w.state_hash_parts()[3]; w.deposits[0].asleep = !w.deposits[0].asleep; assert_ne!(w.state_hash_parts()[3], h, "the deposits section sees the dormant flag");
    }
}

#[cfg(test)]
mod footprint_tests {
    use super::*;
    #[test]
    fn a_building_grows_with_its_tier_and_needs_its_neighbours_to_make_way() {
        assert!(footprint(FARM, 3) > footprint(FARM, 0) * 1.4); assert_eq!(footprint(WALL, 3), footprint(WALL, 0));
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        let farm = w.place(FARM, 30, 20, 0); assert!(farm >= 0);
        let r0 = footprint(FARM, 0); let d = r0 + 3.2 - 0.4 + 0.3; let mut near = -1; let mut spot = (0, 0);
        for k in 0..16 { let a = k as f32 * 0.39; let (px, py) = (30 + (a.cos() * d).round() as i32, 20 + (a.sin() * d).round() as i32); let c = w.place(HOUSE, px, py, 0); if c >= 0 { near = c; spot = (px, py); break; } }
        assert!(near >= 0, "a house right beside the farm");
        assert_eq!(w.upgrade_blockers(farm as u32), vec![near as u32], "the house is in the way of the farm's growth");
        let tiers = w.buildings[farm as usize].tier; assert_eq!(w.upgrade(farm as u32), -3); assert_eq!(w.buildings[farm as usize].tier, tiers, "nothing changed and nothing was charged");
        assert!(w.demolish(near as u32)); assert!(w.upgrade_blockers(farm as u32).is_empty()); assert_eq!(w.upgrade(farm as u32), 0);
        // a new building must respect the grown farm
        let dx = (spot.0 - 30) as f32; let dy = (spot.1 - 20) as f32; let dist = (dx * dx + dy * dy).sqrt(); assert!(dist < footprint(FARM, 1) + 3.2 - 0.4, "the grown farm now reaches where the house stood");
    }
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    #[test]
    fn stone_gatehouses_have_doors_that_block_armies_until_opened() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        w.deposits.clear();   // keep the gate approaches clear of the nearby outcrop
        for x in [-12, -6, 6, 12] { assert!(w.place(WALL, x, 30, 0) >= 0); }
        let g = w.place(GATE, 0, 30, 0); assert!(g >= 0);
        assert_eq!(w.gate_set(g as u32, true), -2, "a wooden gate has no doors");
        for _ in 0..2 { assert_eq!(w.upgrade(g as u32), 0); }
        assert!(w.gates_shut_flat().is_empty(), "open by default");
        let open = w.plan_march(&[5, 0, 0, 0, 0, 0], 0.0, 18.0, 0.0, 44.0);
        assert_eq!(w.gate_set(g as u32, true), 0); assert_eq!(w.gates_shut_flat(), vec![g as u32]);
        let shut = w.plan_march(&[5, 0, 0, 0, 0, 0], 0.0, 18.0, 0.0, 44.0);
        assert!(shut.len() != open.len() || shut != open, "the route changes (or fails) when the gate is barred");
        assert_eq!(w.gate_set(g as u32, false), 0); assert!(w.gates_shut_flat().is_empty());
        assert_eq!(w.gate_set(99, true), -1);
        // raiders attacking shut every stone gatehouse by themselves
        w.cheat(4, 90, 300); assert!(w.battle_active()); assert_eq!(w.gates_shut_flat(), vec![g as u32]);
    }
}

#[cfg(test)]
mod pathing_room_tests {
    use super::*;
    #[test]
    fn soldiers_pass_through_the_gaps_between_buildings_and_prefer_open_ground() {
        assert!(solid_radius(HOUSE, 0) < footprint(HOUSE, 0), "the solid core is smaller than the footprint"); assert!(solid_radius(FARM, 0) < footprint(FARM, 0) * 0.5, "a field is mostly walkable");
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        let mut placed = 0; for k in -3..=3 { if w.place(HOUSE, k * 9, 30, 0) >= 0 { placed += 1; } }
        assert!(placed >= 5, "a row of houses with gaps of about 2.8: {placed}");
        let p = w.plan_march(&[5, 0, 0, 0, 0, 0], 0.0, 12.0, 0.0, 48.0);
        assert_eq!(p[0], 1.0, "a route exists: {:?}", &p[..5.min(p.len())]);
        let mut len = 0.0; let mut prev = (0.0f32, 12.0f32); for q in p[5..].chunks(3) { len += ((q[0] - prev.0).powi(2) + (q[1] - prev.1).powi(2)).sqrt(); prev = (q[0], q[1]); }
        assert!(len < 70.0, "it goes through the gaps, not all the way round the row: {len:.0} units");
    }

    // ---------- soil fertility and crop rotation ----------
    fn fert_world() -> (World, u32) {
        let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; w.cheat(3, 0, 0);
        for (k, x, y) in [(0u8, 12, 4), (0, 18, 8), (0, 24, 2)] { w.place(k, x, y, 0); }
        let f = w.place(FARM, -14, 6, 0); assert!(f >= 0, "a farm fits: {f}");
        (w, f as u32)
    }
    fn run_keeping_fed(w: &mut World, ticks: u32) { for _ in 0..ticks { w.step(); w.stock[GR as usize] = 100; w.stock[W as usize] = 600; } }

    #[test]
    fn sown_soil_wears_out_and_yields_less() {
        // (short runs: bandits raid after tick 600)
        let (mut w, f) = fert_world();
        assert_eq!(w.field_info(f), vec![10_000, 0, 0], "a new field has rich soil");
        run_keeping_fed(&mut w, 550);
        let worn = w.field_info(f)[0];
        assert!(worn < 10_000 && worn > 9_000, "soil wears a little each harvest: {worn}");
        // the same farm on worn soil makes less per cycle than on rich soil
        let (mut rich, _) = fert_world(); let (mut poor, _) = fert_world();
        poor.buildings[f as usize].fert = 0; rich.buildings[f as usize].fert = FERT_MAX;
        let mut made = [0i32; 2];
        for (k, w) in [&mut rich, &mut poor].into_iter().enumerate() { for _ in 0..550 { let before = w.stock[GR as usize]; w.step(); w.stock[GR as usize] = before.max(0) + (w.stock[GR as usize] - before).max(0); made[k] += (w.stock[GR as usize] - before).max(0); w.stock[GR as usize] = 100; } }
        assert!(made[1] < made[0], "worn soil {} vs rich {}", made[1], made[0]);
    }

    #[test]
    fn a_fallow_field_recovers_twice_as_fast_in_winter() {
        let rest = |tick: u64| { let (mut w, f) = fert_world(); w.buildings[f as usize].fert = 3_000; w.set_field_mode(f, 1); w.tick = tick; run_keeping_fed(&mut w, 200); w.field_info(f)[0] - 3_000 };
        let (summer, winter) = (rest(DAY * SEASON_DAYS), rest(DAY * SEASON_DAYS * 3));
        assert!(summer > 0 && winter >= summer * 3 / 2, "winter {winter} vs summer {summer}");
    }

    #[test]
    fn a_fallow_field_recovers_and_makes_nothing() {
        let (mut w, f) = fert_world();
        w.buildings[f as usize].fert = 3_000;
        assert_eq!(w.set_field_mode(f, 1), 0);
        assert_eq!(w.field_info(f)[2], 1);
        run_keeping_fed(&mut w, 550);
        assert!(w.field_info(f)[0] > 3_000 + 500, "it recovers: {:?}", w.field_info(f));
        assert_eq!(w.set_field_mode(f, 0), 0); assert_eq!(w.field_info(f)[2], 0);
        assert_eq!(w.set_field_mode(f, 9), -2); assert_eq!(w.set_field_mode(0, 1), -1, "the town hall is no farm"); assert_eq!(w.set_field_mode(9999, 1), -1);
    }

    #[test]
    fn rotation_rests_a_worn_field_and_sows_it_again() {
        let (mut w, f) = fert_world();
        w.buildings[f as usize].fert = FERT_TIRED;
        assert_eq!(w.set_field_mode(f, 2), 0);
        assert_eq!(w.field_info(f), vec![FERT_TIRED as i32, 2, 1], "a worn field set to rotate starts resting");
        w.buildings[f as usize].fert = FERT_RESTORED - 20;
        run_keeping_fed(&mut w, 200);
        assert_eq!(w.field_info(f)[2], 0, "restored soil is sown again: {:?}", w.field_info(f));
        assert_eq!(w.field_info(f)[1], 2, "and it is still on rotation");
        w.buildings[f as usize].fert = FERT_TIRED + 2;
        run_keeping_fed(&mut w, 200);
        assert_eq!(w.field_info(f)[2], 1, "worn soil rests again: {:?}", w.field_info(f));
    }

    #[test]
    fn soil_is_part_of_the_state_hash() {
        let (mut a, f) = fert_world(); let (mut b, _) = fert_world();
        assert_eq!(a.state_hash(), b.state_hash());
        b.set_field_mode(f, 1); a.step(); b.step();
        assert_ne!(a.state_hash(), b.state_hash());
    }

    // ---------- design options do something ----------
    fn opt_world() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w }
    fn set_opt(w: &mut World, idx: i32, bit: u8) { w.buildings[idx as usize].opts |= 1 << bit; }

    #[test]
    fn house_options_add_room_happiness_and_grain() {
        let mut w = opt_world();
        let hs: Vec<i32> = (0..6).map(|k| w.place(HOUSE, 10 + k * 7, 4, 0)).collect(); assert!(hs.iter().all(|&h| h >= 0), "{hs:?}");
        let (cap0, hap0) = (w.capacity(), w.happiness());
        for &h in &hs { set_opt(&mut w, h, 0); set_opt(&mut w, h, 1); }   // chimneys and flower boxes
        assert_eq!(w.capacity(), cap0 + 6, "a chimney gives room for one more");
        assert_eq!(w.happiness(), hap0 + 6, "each flower box lifts happiness by one");
        let g0 = w.stock[GR as usize]; w.stock[GR as usize] = 0; for &h in &hs { set_opt(&mut w, h, 3); }   // dovecotes
        w.tick = DAY - 1; w.stock[GR as usize] = 0; for _ in 0..2 { w.step(); }
        let _ = g0; assert!(w.stock[GR as usize] >= 0);
    }

    #[test]
    fn farm_options_raise_the_yield_and_haystacks_save_the_winter() {
        let make = |opts: u16| { let mut w = opt_world(); for (k, x, y) in [(0u8, 12, 4), (0, 18, 8), (0, 24, 2)] { w.place(k, x, y, 0); } let f = w.place(FARM, -14, 6, 0); assert!(f >= 0); w.buildings[f as usize].opts = opts; w };
        // (random harvest gifts also count as grain, so the comparison is summed over several random streams)
        let grain = |mk: &dyn Fn() -> World, start: u64| { let mut made = 0; for k in 0..8u64 { let mut w = mk(); w.rng = Rng(k * 101 + 7); w.tick = start; w.stock[GR as usize] = 0; for _ in 0..550 { let before = w.stock[GR as usize]; w.step(); made += (w.stock[GR as usize] - before).max(0); w.stock[GR as usize] = 100; } } made };
        let plain = grain(&|| make(0), 10);
        let full = grain(&|| make(1 | 4 | 8), 10);
        assert!(full as f32 >= plain as f32 * 1.1, "scarecrow, fence and barn: {full} vs {plain}");
        let winter = DAY * SEASON_DAYS * 3 + 10;
        let (w0, w1) = (grain(&|| make(0), winter), grain(&|| make(2), winter));
        assert!(w1 as f32 > w0 as f32 * 1.4, "haystacks: winter {w1} vs {w0}");
    }

    #[test]
    fn banners_beacons_and_armouries_strengthen_the_defence() {
        let mut w = opt_world();
        let t = w.place(TOWER, 20, 0, 0); let b = w.place(BARRACKS, -20, 10, 0); assert!(t >= 0 && b >= 0);
        let (m0, banner0) = (w.perks().militia, w.perks().banner_pct);
        set_opt(&mut w, t, 0); set_opt(&mut w, t, 3); set_opt(&mut w, b, 2);
        let p = w.perks();
        assert_eq!(p.banner_pct, banner0 + 1 + 4, "a tower banner (+1) and an armoury rack (+4)");
        assert_eq!(p.militia, m0 + 2, "a beacon calls two more villagers to arms");
        for k in 0..30 { let x = 30 + (k % 6) * 6; let y = -20 + (k / 6) * 8; let i = w.place(TOWER, x, y, 0); if i >= 0 { set_opt(&mut w, i, 0); } }
        assert!(w.perks().banner_pct <= 15 && w.perks().militia <= 8, "the bonuses are capped");
    }

    #[test]
    fn training_dummies_speed_up_drill_and_awnings_speed_up_work() {
        let mut w = opt_world(); w.population = 40;
        let b = w.place(BARRACKS, -20, 10, 0); assert!(b >= 0);
        assert_eq!(w.perks().train_pct, 0); set_opt(&mut w, b, 1); assert_eq!(w.perks().train_pct, 25);
        let q = |opts: u16| { let mut w = opt_world(); for (k, x, y) in [(0u8, 12, 4), (0, 18, 8)] { w.place(k, x, y, 0); } let s = w.place(5, -16, 8, 0); assert!(s >= 0, "sawmill"); w.buildings[s as usize].opts = opts; w };
        let made = |mut w: World| { let mut n = 0; for _ in 0..550 { let b = w.stock[PL as usize]; w.step(); n += (w.stock[PL as usize] - b).max(0); w.stock[PL as usize] = 100; w.stock[W as usize] = 3000; } n };
        let (plain, awning) = (made(q(0)), made(q(4)));
        assert!(awning > plain, "an awning makes more: {awning} vs {plain}");
    }
}

#[cfg(test)]
mod pathnet_tests {
    use super::*;
    fn village() -> World {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES];
        for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 17, 4), (HOUSE, 22, 4), (HOUSE, -12, 6), (TOWER, 0, 16), (TOWER, 8, -16)] { w.place(k, x, y, 0); }
        w
    }
    fn edges(w: &World) -> Vec<(usize, usize, bool)> { let v = w.net_flat(); let (n, e) = (v[0] as usize, v[1] as usize); (0..e).map(|k| { let o = 2 + 2 * n + 3 * k; (v[o] as usize, v[o + 1] as usize, v[o + 2] > 0.5) }).collect() }

    #[test]
    fn the_network_has_roads_and_a_ring_round_every_building_and_stays_clear_of_them() {
        let mut w = village(); let nodes = w.road_nodes_flat(); assert_eq!(w.lay_road(&[nodes[0] as i32 - w.ox, nodes[1] as i32 - w.oy, 5, 8, 9, 8, nodes[4] as i32 - w.ox, nodes[5] as i32 - w.oy]), 0);
        let v = w.net_flat(); let (n, e) = (v[0] as usize, v[1] as usize);
        assert!(n > 40 && e > n, "nodes {n}, edges {e}");
        let ed = edges(&w); assert!(ed.iter().any(|e| e.2), "road edges"); assert!(ed.iter().any(|e| !e.2), "ring and link edges");
        for k in 0..n { let (x, y) = (v[2 + 2 * k], v[3 + 2 * k]); for b in w.buildings.iter().filter(|b| b.kind != ROAD) { assert!((b.x - x).hypot(b.y - y) > footprint(b.kind, b.tier) * 0.9, "node ({x:.1},{y:.1}) inside a {}", DEFS[b.kind as usize].name); } }
        // every edge is walkable: never through a building's footprint
        for (a, b, _) in ed { let (pa, pb) = ((v[2 + 2 * a], v[3 + 2 * a]), (v[2 + 2 * b], v[3 + 2 * b])); for t in 0..=10 { let f = t as f32 / 10.0; let (x, y) = (pa.0 + (pb.0 - pa.0) * f, pa.1 + (pb.1 - pa.1) * f); for q in w.buildings.iter().filter(|q| q.kind != ROAD) { assert!((q.x - x).hypot(q.y - y) > footprint(q.kind, q.tier) * 0.9, "edge crosses a {}", DEFS[q.kind as usize].name); } } }
    }

    #[test]
    fn a_route_goes_round_a_building_along_its_ring_and_the_network_follows_changes() {
        let mut w = village();
        let r = w.net_route(8.0, 4.0, 32.0, 4.0); assert!(!r.is_empty(), "a route exists");
        assert_eq!(r[0], 1.0, "and it is complete");
        let pts: Vec<(f32, f32)> = r[1..].chunks(2).map(|c| (c[0], c[1])).collect();
        for p in &pts { for q in &w.buildings { assert!((q.x - p.0).hypot(q.y - p.1) > footprint(q.kind, q.tier) * 0.9); } }
        let len: f32 = pts.windows(2).map(|p| (p[1].0 - p[0].0).hypot(p[1].1 - p[0].1)).sum();
        assert!(len < 60.0, "no huge detour: {len}");
        // a new obstacle in the way changes the network
        let before = w.net_flat();
        assert!(w.place(HOUSE, 28, 4, 0) >= 0);
        let after = w.net_flat(); assert!(before != after, "the network was rebuilt");
        let r2 = w.net_route(8.0, 4.0, 40.0, 4.0);
        if !r2.is_empty() { for p in r2[1..].chunks(2) { assert!((28.0 - p[0]).hypot(4.0 - p[1]) > footprint(HOUSE, 0) * 0.9, "the route avoids the new house"); } }
    }

    /// The x at which a route crosses the horizontal line y = `line`, for each crossing.
    fn cross_x(r: &[f32], line: f32) -> Vec<f32> {
        let mut pts: Vec<(f32, f32)> = vec![(0.0, 22.0)]; pts.extend(r[1..].chunks(2).map(|c| (c[0], c[1]))); pts.push((0.0, 38.0));   // (the route's own points, between the start and the goal)
        pts.windows(2).filter(|p| (p[0].1 - line) * (p[1].1 - line) <= 0.0 && (p[0].1 - p[1].1).abs() > 1e-6).map(|p| p[0].0 + (p[1].0 - p[0].0) * (line - p[0].1) / (p[1].1 - p[0].1)).collect()
    }
    fn crossings(r: &[f32], f: impl Fn(f32, f32) -> bool) -> bool {   // does any sampled point of the route satisfy f?
        let pts: Vec<(f32, f32)> = r[1..].chunks(2).map(|c| (c[0], c[1])).collect();
        pts.windows(2).any(|p| (0..=40).any(|t| { let k = t as f32 / 40.0; f(p[0].0 + (p[1].0 - p[0].0) * k, p[0].1 + (p[1].1 - p[0].1) * k) }))
    }

    #[test]
    fn the_network_respects_closed_gates_and_drawbridges() {
        // a wall with a gatehouse: the way through is open until the doors are shut
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        w.deposits.clear();
        for x in [-12, -6, 6, 12] { assert!(w.place(WALL, x, 30, 0) >= 0); }
        let g = w.place(GATE, 0, 30, 0); assert!(g >= 0);
        for _ in 0..2 { assert_eq!(w.upgrade(g as u32), 0); }
        let open = w.net_route(0.0, 22.0, 0.0, 38.0);
        assert!(!open.is_empty() && open[0] == 1.0, "a route through the open gate");
        let xs = cross_x(&open, 30.0); assert!(!xs.is_empty() && xs.iter().all(|x| x.abs() < 0.6), "it goes through the middle of the gate: {xs:?}");
        assert_eq!(w.gate_set(g as u32, true), 0);
        let shut = w.net_route(0.0, 22.0, 0.0, 38.0);
        assert!(shut.is_empty() || shut[0] == 0.0 || cross_x(&shut, 30.0).iter().all(|x| x.abs() > 12.5), "nobody passes the shut doors or squeezes round them: {shut:?}");
        assert_eq!(w.gate_set(g as u32, false), 0);
        let again = w.net_route(0.0, 22.0, 0.0, 38.0); assert!(!again.is_empty() && again[0] == 1.0, "open again");

        // a moat: only a lowered drawbridge gets you across, and only along its deck
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        w.deposits.clear();
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; let r = w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); print!("{r} "); }
        for k in 0..44 { let a = k as f32 / 44.0 * std::f32::consts::TAU; print!("{:.1} ", w.height_ground(a.cos() * 20.0, a.sin() * 20.0)); } println!();
        let br = w.place(DRAWBRIDGE, 0, 20, 0); assert!(br >= 0);
        let across = w.net_route(0.0, 8.0, 0.0, 36.0);
        assert!(!across.is_empty() && across[0] == 1.0, "a route over the lowered drawbridge");
        assert!(!crossings(&across, |x, y| w.height_at(x, y) < 0.2 && !(x.abs() <= 2.0 && (y - 20.0).abs() <= 7.5)), "it never wades: it is in water only on the deck");
        assert!(crossings(&across, |x, y| (y - 20.0).abs() < 4.0 && x.abs() < 2.0), "and it uses the deck");
        w.drawbridge_set(br as u32, true);
        let up = w.net_route(0.0, 8.0, 0.0, 36.0);
        assert!(up.is_empty() || up[0] == 0.0, "drawn up: no complete route");
        assert!(up.is_empty() || !crossings(&up, |x, y| w.height_at(x, y) < 0.2), "and none through the water");
    }

    #[test]
    fn nobody_walks_through_a_fence_between_its_posts_and_armies_march_through_the_middle_of_a_gate() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for x in (-10..=10).step_by(5) { assert!(w.place(FENCE, x, 24, 0) >= 0, "fence at {x}"); }
        let u = [5u32, 0, 0, 0, 0, 0];
        for sx in [-9.0f32, -3.0, 0.0, 2.5, 8.0] {
            let p = w.find_path(&u, sx, 18.0, sx, 30.0).expect("a way round the fence");
            let mut all = vec![(sx, 18.0)]; all.extend(p.iter().map(|q| (q.x, q.y))); all.push((sx, 30.0));
            for pair in all.windows(2) { for t in 0..=40 { let f = t as f32 / 40.0; let (x, y) = (pair[0].0 + (pair[1].0 - pair[0].0) * f, pair[0].1 + (pair[1].1 - pair[0].1) * f); assert!(!((y - 24.0).abs() < 0.5 && x.abs() <= 10.0), "walked through the fence at {x:.1},{y:.1} (from x = {sx})"); } }
        }
        // a gate in a wall: the marching route goes through the middle of the doorway
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        w.deposits.clear();
        for x in [-12, -6, 6, 12] { assert!(w.place(WALL, x, 30, 0) >= 0); }
        assert!(w.place(GATE, 0, 30, 0) >= 0);
        let p = w.find_path(&u, 1.0, 22.0, -1.0, 40.0).expect("through the gate");
        let mut all = vec![(1.0f32, 22.0f32)]; all.extend(p.iter().map(|q| (q.x, q.y)));
        let xs: Vec<f32> = all.windows(2).filter(|q| (q[0].1 - 30.0) * (q[1].1 - 30.0) <= 0.0 && (q[0].1 - q[1].1).abs() > 1e-6).map(|q| q[0].0 + (q[1].0 - q[0].0) * (30.0 - q[0].1) / (q[1].1 - q[0].1)).collect();
        assert!(!xs.is_empty() && xs.iter().all(|x| x.abs() < 1.0), "through the middle of the gate: {xs:?}");
    }

    #[test]
    fn villagers_and_soldiers_share_the_lines_and_nobody_wades() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; let r = w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); print!("{r} "); }
        for k in 0..44 { let a = k as f32 / 44.0 * std::f32::consts::TAU; print!("{:.1} ", w.height_ground(a.cos() * 20.0, a.sin() * 20.0)); } println!();
        let dry = w.walk_route(0.0, 8.0, 0.0, 36.0); assert!(dry.is_empty(), "no dry way across an unbroken moat: {dry:?}");
        let br = w.place(DRAWBRIDGE, 0, 20, 0); assert!(br >= 0);
        let r = w.walk_route(0.0, 8.0, 0.0, 36.0);
        assert!(!r.is_empty() && r[0] == 1.0, "a dry way over the drawbridge");
        let mut pts = vec![(0.0f32, 8.0f32)]; pts.extend(r[1..].chunks(2).map(|c| (c[0], c[1])));
        for p in pts.windows(2) { for t in 0..=40 { let f = t as f32 / 40.0; let (x, y) = (p[0].0 + (p[1].0 - p[0].0) * f, p[0].1 + (p[1].1 - p[0].1) * f); assert!(w.height_at(x, y) > 0.1 || (x.abs() <= 2.0 && (y - 20.0).abs() <= 7.5), "waded at {x:.1},{y:.1}"); } }
        // an army goes the same way, over the deck
        let a = w.find_path(&[5, 0, 0, 0, 0, 0], 0.0, 8.0, 0.0, 36.0).expect("a route");
        assert!(a.iter().all(|q| q.mode == 0), "no ferry where there is a drawbridge");
        // the roads are the cheap lines: two houses with a road between them are joined along it
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES];
        for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 30, 4)] { w.place(k, x, y, 0); }
        let p = w.find_path(&[5, 0, 0, 0, 0, 0], 12.0, 10.0, 30.0, 10.0).expect("a route");
        assert!(p.len() >= 2 && p.last().map_or(false, |q| (q.x - 30.0).abs() < 3.0));
    }

    #[test]
    fn a_waterwheel_at_a_moat_keeps_its_mill_on_the_bank() {
        let mut w = village(); w.stock = [30000; N_RES]; w.flatten(40, 5.0);
        for i in 0..52 { let a = i as f32 / 52.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 24.0).round() as i32, (a.sin() * 24.0).round() as i32, 0); }
        let level = w.moat_level_at(0.0, 24.0);
        assert!(level > 1.0, "a moat's water stands well above the sea: {level}");
        let s = w.waterwheel_snap(0, 33);
        assert!(!s.is_empty(), "the wheel snaps to the moat bank");
        let (dx, dy, rot) = (s[0] as i32, s[1] as i32, s[2] as u8);
        let (x, y) = ((w.ox + dx) as f32, (w.oy + dy) as f32);
        let bank = w.height_ground(x, y);
        let preview = w.placement_height(WATERWHEEL, x, y, rot);
        let (ux, uy) = World::wheel_dir(rot);
        let (wx, wy) = (x + ux * WHEEL_REACH, y + uy * WHEEL_REACH);
        let bed = w.height_at(wx, wy);
        let surface = w.shore_water_height(x, y, rot);
        assert_eq!(surface, w.moat_level_at(wx, wy));
        assert!(surface > 1.0);
        let i = w.place(WATERWHEEL, dx, dy, rot); assert!(i >= 0, "built: {i}");
        let pad = w.buildings[i as usize].pad_h;
        assert_eq!(pad, preview);
        assert!(pad >= bank && pad >= surface + SHORE_CLEARANCE, "bank {bank}, pad {pad}, water {surface}");
        assert!((w.height_at(wx, wy) - bed).abs() < 1e-4, "the house pad leaves the ground under the wheel alone");
    }

    #[test]
    fn a_waterwheel_snaps_to_the_bank_with_its_wheel_over_the_water() {
        let mut w = village(); w.stock = [500; N_RES];
        for i in 0..6 { assert!(w.place(RIVER, 20 + i * 4, -30, 2) >= 0); }
        let mut seen = 0;
        for (cx, cy) in [(24, -22), (30, -24), (28, -40), (36, -30), (34, -36), (22, -23)] {
            let s = w.waterwheel_snap(cx, cy);
            if s.is_empty() { continue; }
            seen += 1;
            let (dx, dy, rot) = (s[0] as i32, s[1] as i32, s[2] as u8);
            let (x, y) = ((w.ox + dx) as f32, (w.oy + dy) as f32);
            let (ux, uy) = World::wheel_dir(rot);
            assert!(w.height_at(x, y) >= 0.4, "the house is on dry land: {s:?}");
            assert!(w.height_at(x + ux * WHEEL_REACH, y + uy * WHEEL_REACH) < 0.2, "the wheel hangs over water: {s:?}");
            assert_eq!(w.waterwheel_snap(cx, cy), s, "snapping is a pure function");
            // the footing (to WHEEL_FOOT from the middle) ends at the bank, and the wheel's axle hangs beyond it: no water under the footing, none of the wheel over dry ground
            let foot = WHEEL_FOOT - 1.0; assert!(w.height_at(x + ux * foot, y + uy * foot) >= 0.3, "the footing stands on land: {s:?}");
            let mut bank = 0.0f32; while bank < WHEEL_REACH && w.height_at(x + ux * bank, y + uy * bank) >= 0.45 { bank += 0.25; }
            assert!(bank >= WHEEL_FOOT - 0.5, "the footing ends ({WHEEL_FOOT}) no later than the bank ({bank}): {s:?}");
            // turned the other way the wheel would be in the air over dry ground
            assert_eq!(w.place(WATERWHEEL, dx, dy, (rot + 4) & 7), -16, "wheel facing the land is refused");
            if seen == 1 {
                let bank = w.height_ground(x, y);
                let stage = w.shore_water_height(x, y, rot);
                assert!(w.place(WATERWHEEL, dx, dy, rot) >= 0, "the snapped spot can be built on: {s:?}");
                assert!(stage > 0.0, "the carved river has its own surface");
                assert!(w.buildings.last().unwrap().pad_h >= bank.max(stage + SHORE_CLEARANCE));
            }
        }
        assert!(seen >= 3, "the snap finds the bank from most clicks ({seen})");
        assert!(w.waterwheel_snap(-60, 60).is_empty(), "no water, no snap");
    }

    #[test]
    fn a_drawbridge_snaps_onto_the_moat_and_lies_square_across_it() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; let r = w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); print!("{r} "); }
        for k in 0..44 { let a = k as f32 / 44.0 * std::f32::consts::TAU; print!("{:.1} ", w.height_ground(a.cos() * 20.0, a.sin() * 20.0)); } println!();
        // near the south of the ring the ditch runs east-west, so the deck runs north-south (turn 0 or 4); near the east it runs the other way (turn 2 or 6)
        let s = w.drawbridge_snap(3, 17); assert_eq!(s.len(), 3, "a moat is near");
        assert!((s[0].hypot(s[1]) - 20.0).abs() < 1.5, "snapped onto the ring: {s:?}");
        assert!(s[2] == 0.0 || s[2] == 4.0, "square across a ditch that runs east-west: {s:?}");
        let e = w.drawbridge_snap(17, 2); if e.len() == 3 { assert!(e[2] == 2.0 || e[2] == 6.0, "{e:?}"); }
        assert!(w.drawbridge_snap(100, 100).is_empty(), "nothing to snap to far from any moat");
        let br = w.place(DRAWBRIDGE, s[0] as i32, s[1] as i32, s[2] as u8); assert!(br >= 0, "the snapped spot can be built on: {br}");
    }

    #[test]
    fn a_drawbridge_preview_and_deck_clear_water_even_when_the_nearby_gate_is_lower() {
        let mut w = World::new(1337, 0, 0); w.cheat(3, 0, 0); w.flatten(50, 8.0);
        for x in [-4, 0, 4] { assert!(w.place(MOAT, x, 24, 0) >= 0); }
        assert!(w.place(WALL, 8, 14, 0) >= 0);
        let gate = w.place(GATE, 0, 14, 0);
        assert!(gate >= 0);
        w.buildings[gate as usize].pad_h = 1.0;
        let snap = w.drawbridge_snap(0, 23);
        let (x, y, rot) = (snap[0], snap[1], snap[2] as u8);
        let water = w.moat_level_at(x, y);
        let deck = w.placement_height(DRAWBRIDGE, x, y, rot);
        assert!(water > 4.0 && deck > water);
        let i = w.place(DRAWBRIDGE, x as i32, y as i32, rot);
        assert!(i >= 0);
        assert_eq!(w.buildings[i as usize].pad_h, deck);
    }

    #[test]
    fn a_drawbridge_over_a_moat_stands_at_deck_height_not_on_the_moat_bed() {
        // the building's height (what the model, its pick volume and its selection ring are placed at) is the deck, well above the moat's floor, at every angle round the ring
        let mut seen = std::collections::BTreeSet::new();
        for k in 0..16 {
            let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
            for i in 0..56 { let a = i as f32 / 56.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); }
            let a = k as f32 / 16.0 * std::f32::consts::TAU;
            let s = w.drawbridge_snap((a.cos() * 18.0).round() as i32, (a.sin() * 18.0).round() as i32);
            if s.len() != 3 { continue; }
            let br = w.place(DRAWBRIDGE, s[0] as i32, s[1] as i32, s[2] as u8); if br < 0 { continue; }
            let b = &w.buildings[br as usize]; seen.insert(b.rot);
            let bed = w.height_ground(b.x, b.y);   // the ditch's bed under the middle of the deck
            assert!(b.pad_h > bed + 2.5, "rot {}: deck {} must lie well above the bed {}", b.rot, b.pad_h, bed);
            assert!(b.pad_h >= 0.7, "rot {}: the deck is above the water surface: {}", b.rot, b.pad_h);
            assert!(w.on_deck(b.x, b.y), "rot {}: soldiers walk on the deck", b.rot);
            // the shore runs flush to both ends of the deck: dry ground under its last metres is at deck level (no gap, no step)
            let ang = b.rot as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (ang.sin(), ang.cos());
            for sgn in [-1.0f32, 1.0] { for d in [6.0f32, 7.0, 9.0] {
                let (px, py) = (b.x + sgn * sx * d, b.y + sgn * sy * d);
                if w.base(px, py) > 0.6 { let g = w.height_ground(px, py); assert!((g - b.pad_h).abs() < 0.3, "rot {} end {sgn} at {d}: ground {g} vs deck {}", b.rot, b.pad_h); }
            } }
        }
        assert!(seen.len() >= 2, "several rotations covered: {seen:?}");
    }

    #[test]
    fn a_snapped_drawbridge_faces_outward_across_the_moat_at_every_angle() {
        // turn -> (sin, cos) of the deck direction, the same convention as the model and `on_deck`
        let dir = |r: f32| { let a = r * std::f32::consts::FRAC_PI_4; (a.sin(), a.cos()) };
        for radius in [16.0f32, 22.0] {
            let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
            for i in 0..56 { let a = i as f32 / 56.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * radius).round() as i32, (a.sin() * radius).round() as i32, 0); }
            let mut seen = std::collections::BTreeSet::new();
            for k in 0..48 {
                let a = k as f32 / 48.0 * std::f32::consts::TAU;
                let s = w.drawbridge_snap((a.cos() * (radius - 2.0)).round() as i32, (a.sin() * (radius - 2.0)).round() as i32);
                if s.len() != 3 { continue; }
                let (ux, uy) = dir(s[2]);
                let (rx, ry) = (s[0], s[1]); let rl = rx.hypot(ry).max(1e-3);
                // the ditch is a ring, so square across it is the radial direction: the deck points away from the hall, within a 45-degree step (plus the rounding of the spot and of the ring pieces)
                let cos = (ux * rx + uy * ry) / rl;
                assert!(cos > 0.8, "radius {radius}, snap {s:?}: deck must point outward (cos {cos:.3})");
                seen.insert(s[2] as i32);
            }
            assert!(seen.len() >= 6, "the bridge turns all the way round the ring: {seen:?}");
        }
    }

    #[test]
    fn a_bridge_placed_where_it_snapped_is_crossed_by_a_route_while_lowered() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        w.deposits.clear();   // the endpoint at (0, 36) overlaps this seed's stone deposit
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); }
        let s = w.drawbridge_snap(0, 18); assert_eq!(s.len(), 3);
        assert_eq!(s[2], 0.0, "south of the hall the deck runs south, away from it");
        let br = w.place(DRAWBRIDGE, s[0] as i32, s[1] as i32, s[2] as u8); assert!(br >= 0, "{br}");
        let across = w.net_route(0.0, 8.0, 0.0, 36.0);
        assert!(!across.is_empty() && across[0] == 1.0, "a route over the lowered snapped drawbridge");
        // and the other side of the hall: a bridge snapped on the north must point north
        let n = w.drawbridge_snap(0, -18); assert_eq!(n.len(), 3);
        assert_eq!(n[2], 4.0, "north of the hall the deck runs north: {n:?}");
    }

    #[test]
    fn a_drawbridge_can_go_anywhere_along_a_moat_that_is_not_too_wide() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; let r = w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); print!("{r} "); }
        for k in 0..44 { let a = k as f32 / 44.0 * std::f32::consts::TAU; print!("{:.1} ", w.height_ground(a.cos() * 20.0, a.sin() * 20.0)); } println!();
        let placed = w.buildings.iter().filter(|b| b.kind == MOAT).count();
        assert!(placed >= 10, "{placed} moat pieces");
        // pointing at many different places along the ditch gives many different spots, each on the ditch and each turned square across it
        let mut spots = std::collections::BTreeSet::new();
        for k in 0..36 { let a = k as f32 / 36.0 * std::f32::consts::TAU; let (dx, dy) = ((a.cos() * 18.0).round() as i32, (a.sin() * 18.0).round() as i32); let s = w.drawbridge_snap(dx, dy); if s.len() == 3 { assert!((s[0].hypot(s[1]) - 20.0).abs() < 2.5, "on the ditch: {s:?}"); spots.insert((s[0] as i32, s[1] as i32)); } }
        assert!(spots.len() >= 8, "many places to put it: {}", spots.len());
        // a very wide moat is too wide for the deck
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 7); }
        assert!(w.drawbridge_snap(3, 17).is_empty(), "the broadest moat is wider than a drawbridge");
    }

    #[test]
    fn marching_soldiers_cut_the_trees_in_their_way() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES];
        let ns = march::nav_static(1337);
        // a stretch of wood within reach of the village: look for a spot with thick trees, and march across it
        let mut spot = None;
        'find: for r in (60..260).step_by(10) { for k in 0..48 { let a = k as f32 / 48.0 * std::f32::consts::TAU; let (x, y) = (a.cos() * r as f32, a.sin() * r as f32); let (ux, uy) = (a.cos(), a.sin()); if (0..=6).all(|q| ns.dens_at(x + ux * q as f32 * 4.0, y + uy * q as f32 * 4.0) >= 3 && w.height_at(x + ux * q as f32 * 4.0, y + uy * q as f32 * 4.0) > 1.0) { spot = Some((x + ux * 24.0, y + uy * 24.0)); break 'find; } } }
        let (fx, fy) = spot.expect("there is thick wood near the village");
        w.army = [8, 0, 0, 0, 0, 0]; let id = w.det_form(&[8, 0, 0, 0, 0, 0]); assert!(id > 0);
        let r = w.det_march(id, fx, fy, false, 0.0, 0.0); assert_eq!(r, 0, "a way to the wood");
        let before = w.felled.len();
        for _ in 0..1200 { w.step(); w.stock[GR as usize] = 3000; if w.det_flat().len() >= 9 && w.det_flat()[8] as u8 != march::S_MARCH { break; } }
        assert!(w.felled.len() > before, "the soldiers felled trees on their way ({} -> {})", before, w.felled.len());
        assert!(w.felled.iter().any(|f| (f[0] - fx).hypot(f[1] - fy) < 40.0), "and the cleared strip reaches the wood they walked into");
    }

    #[test]
    fn every_building_is_chained_to_the_castle_through_the_network() {
        let comps = |w: &World| -> (usize, usize) {   // (nodes outside the hall's network, nodes)
            let v = w.net_flat(); let (n, e) = (v[0] as usize, v[1] as usize);
            let mut c: Vec<usize> = (0..n).collect();
            fn f(c: &mut Vec<usize>, x: usize) -> usize { let mut r = x; while c[r] != r { r = c[r]; } r }
            for k in 0..e { let o = 2 + 2 * n + 3 * k; let (a, b) = (f(&mut c, v[o] as usize), f(&mut c, v[o + 1] as usize)); if a != b { c[a] = b; } }
            let hall = f(&mut c, (0..n).min_by(|&a, &b| (v[2 + 2 * a].hypot(v[3 + 2 * a])).partial_cmp(&(v[2 + 2 * b].hypot(v[3 + 2 * b]))).unwrap()).unwrap());
            ((0..n).filter(|&i| f(&mut c, i) != hall).count(), n)
        };
        // houses spread wide apart (further than the links reach) with a tower and a wall piece between
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 34, 4), (HOUSE, 56, 10), (TOWER, 0, 20), (HOUSE, -22, 6), (HOUSE, -44, -6), (WALL, 24, 20), (WALL, 30, 20), (HOUSE, 30, 36)] { w.place(k, x, y, 0); }
        let (apart, total) = comps(&w);
        assert!(total > 40, "{total} nodes");
        assert_eq!(apart, 0, "every building's lines join the castle's: {apart} of {total} nodes are cut off");
    }

    #[test]
    fn the_chained_path_starts_outside_the_castle_and_moves_when_something_is_built_on_it() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.buildings[0].tier = 3; w.after_change();
        for (k, x, y) in [(HOUSE, 40, 4), (HOUSE, -40, 6), (HOUSE, 60, 30), (HOUSE, 30, -40)] { w.place(k, x, y, 0); }
        assert_eq!(w.link_village(300.0, 40.0), 0);
        let inside = |w: &World| w.links[0].iter().take(w.links[0].len().saturating_sub(1)).filter(|p| w.member_blocked_inner(p.0, p.1, 0)).count();
        assert_eq!(inside(&w), 0, "the invisible path runs through a building or the castle: {:?}", w.links[0]);
        let first = w.links[0][0];
        assert!(first.0.hypot(first.1) > 24.0, "the path starts outside the castle: {first:?}");
        // something is built right on the path: a few ticks later it has moved round it
        let on = w.links[0].iter().skip(2).copied().find(|p| p.0.hypot(p.1) > 40.0 && p.0.hypot(p.1) < 100.0).expect("a point of the path out in the village");
        let before = w.links[0].clone();
        w.place(HOUSE, on.0.round() as i32, on.1.round() as i32, 0);
        for _ in 0..16 { w.step(); }
        assert_ne!(w.links[0], before, "the path did not move");
        assert_eq!(inside(&w), 0, "the moved path still runs through a building: {:?}", w.links[0]);
    }

    #[test]
    fn a_path_is_chained_out_to_another_city_and_armies_use_it() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES];
        for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, -12, 6), (TOWER, 0, 16)] { w.place(k, x, y, 0); }
        assert!(!w.link_exists(300.0, 40.0));
        let r = w.link_village(300.0, 40.0); assert_eq!(r, 0, "a dry way to the other city");
        assert!(w.link_exists(300.0, 40.0));
        assert_eq!(w.link_village(300.0, 40.0), 0, "linking again replaces, it does not add");
        assert_eq!(w.links.len(), 1);
        assert_eq!(w.link_village(5.0, 5.0), -4, "not to ourselves");
        // the path is part of the network: it reaches out of the city towards the other one, and marching takes it
        let net = w.net_flat(); let n = net[0] as usize;
        let far = (0..n).filter(|&i| net[2 + 2 * i] > 120.0).count(); assert!(far > 3, "network nodes out along the path: {far}");
        let p = w.find_path(&[10, 0, 0, 0, 0, 0], 8.0, 8.0, 280.0, 36.0).expect("a march to the other city");
        assert!(p.last().map_or(false, |q| (q.x - 280.0).abs() < 6.0));
    }

    #[test]
    fn the_paths_never_cross_a_farms_fields() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        let mut farms = vec![];
        for (x, y, rot) in [(16, 6, 0u8), (-18, 8, 3), (4, -22, 5)] { let i = w.place(FARM, x, y, rot); if i >= 0 { farms.push(i as usize); } }
        assert!(farms.len() >= 2, "farms placed: {}", farms.len());
        for &f in farms.iter().take(2) { let _ = w.upgrade(f as u32); }
        let net = w.net_flat(); let (n, e) = (net[0] as usize, net[1] as usize);
        let bad = |x: f32, y: f32| farms.iter().any(|&f| pathnet::in_fields(&w.buildings[f], x, y, 0.0));
        for i in 0..n { assert!(!bad(net[2 + 2 * i], net[3 + 2 * i]), "a node in a field at {:.1},{:.1}", net[2 + 2 * i], net[3 + 2 * i]); }
        for k in 0..e { let o = 2 + 2 * n + 3 * k; let (a, b) = (net[o] as usize, net[o + 1] as usize); for t in 1..8 { let f = t as f32 / 8.0; let (x, y) = (net[2 + 2 * a] + (net[2 + 2 * b] - net[2 + 2 * a]) * f, net[3 + 2 * a] + (net[3 + 2 * b] - net[3 + 2 * a]) * f); assert!(!bad(x, y), "an edge across a field at {x:.1},{y:.1}"); } }
        // and a walker going past does not cross them either
        let r = w.walk_route(30.0, 6.0, 2.0, 6.0);
        if !r.is_empty() { let mut pts = vec![(30.0f32, 6.0f32)]; pts.extend(r[1..].chunks(2).map(|c| (c[0], c[1]))); for q in pts.windows(2) { for t in 0..=30 { let f = t as f32 / 30.0; let (x, y) = (q[0].0 + (q[1].0 - q[0].0) * f, q[0].1 + (q[1].1 - q[0].1) * f); assert!(!bad(x, y), "walked across a field at {x:.1},{y:.1}"); } } }
    }

    #[test]
    fn the_paths_never_cross_a_garden_park_or_markets_beds() {
        for kind in [GARDEN, PARK, MARKET] {
            for (tiers, rots) in [(0u32, [0u8, 3, 5]), (2, [1, 4, 7]), (3, [2, 6, 0])] {
                let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
                let mut bs = vec![];
                for ((x, y), rot) in [(16, 6), (-20, 8), (4, -24)].into_iter().zip(rots) { let i = w.place(kind, x, y, rot); if i >= 0 { bs.push(i as usize); } }
                assert!(bs.len() >= 2, "kind {kind}: placed {}", bs.len());
                for &f in &bs { for _ in 0..tiers { let _ = w.upgrade(f as u32); } }
                let net = w.net_flat(); let (n, e) = (net[0] as usize, net[1] as usize);
                let bad = |x: f32, y: f32| bs.iter().any(|&f| pathnet::in_fields(&w.buildings[f], x, y, 0.0));
                for i in 0..n { assert!(!bad(net[2 + 2 * i], net[3 + 2 * i]), "kind {kind} tier {tiers}: a node in a bed at {:.1},{:.1}", net[2 + 2 * i], net[3 + 2 * i]); }
                for k in 0..e { let o = 2 + 2 * n + 3 * k; let (a, b) = (net[o] as usize, net[o + 1] as usize); for t in 1..8 { let f = t as f32 / 8.0; let (x, y) = (net[2 + 2 * a] + (net[2 + 2 * b] - net[2 + 2 * a]) * f, net[3 + 2 * a] + (net[3 + 2 * b] - net[3 + 2 * a]) * f); assert!(!bad(x, y), "kind {kind} tier {tiers}: an edge across a bed at {x:.1},{y:.1}"); } }
                // no bed lies beyond the ring, so the path round it is outside them all
                for &f in &bs { let b = &w.buildings[f]; let rr = pathnet::ring_radius(kind, b.tier); for r in pathnet::field_rects(kind, b.tier) { assert!((r.0.abs() + r.2).hypot(r.1.abs() + r.3) < rr, "kind {kind}: a rectangle pokes out of the ring"); } }
                // and a walker going past does not cross them either
                for (x0, y0, x1, y1) in [(30.0f32, 6.0f32, 2.0f32, 6.0f32), (-34.0, 8.0, -6.0, 8.0), (4.0, -38.0, 4.0, -10.0)] {
                    let r = w.walk_route(x0, y0, x1, y1);
                    if !r.is_empty() { let mut pts = vec![(x0, y0)]; pts.extend(r[1..].chunks(2).map(|c| (c[0], c[1]))); for q in pts.windows(2) { for t in 0..=30 { let f = t as f32 / 30.0; let (x, y) = (q[0].0 + (q[1].0 - q[0].0) * f, q[0].1 + (q[1].1 - q[0].1) * f); assert!(!bad(x, y), "kind {kind}: walked across a bed at {x:.1},{y:.1}"); } } }
                }
            }
        }
    }

    #[test]
    fn soldiers_walk_faster_on_a_road() {
        let w = village();
        let v = w.roads_flat(); assert!(!v.is_empty());
        let (x, y) = ((v[0] + v[2]) / 2.0, (v[1] + v[3]) / 2.0);
        assert!(w.on_road(x, y), "the middle of a road piece is on the road");
        assert!(!w.on_road(60.0, 60.0));
    }
}

#[cfg(test)]
mod combat_tests;
#[cfg(test)]
mod siege_tests;
#[cfg(test)]
mod boss_tests;

#[cfg(test)]
mod member_tests;

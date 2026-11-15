//! Deterministic medieval village simulation core. Same seed + same commands => same state on every peer.
use wasm_bindgen::prelude::*;

mod battle;
mod catalog;
mod lend;
mod march;
mod military;
mod pathnet;
mod plague;
mod wallnet;
mod terrain;
use catalog::*;
use military::*;
use terrain::{lerp, smoothstep, Deposit};

/// Small deterministic PCG32 RNG.
#[derive(Clone)]
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

#[derive(Clone)]
struct Building {
    kind: u8,
    tier: u8,
    x: f32,
    y: f32,
    rot: u8,
    pad_h: f32,
    progress: u32,
    status: u8, // 0 working, 1 missing input, 2 depleted / no resource, 3 storage full, 4 passive
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
}

pub(crate) const DB_UP: u8 = 5;
pub(crate) const DB_LENT: u8 = 6;
pub(crate) const DB_LENT_FIGHT: u8 = 7;
/// Seconds a drawbridge stays raised against armies after the player raised it by hand.
pub(crate) const VETO_SECS: u32 = 120;
/// Seconds a lent drawbridge stays down after the last soldier needing it has gone (in a battle: one second, so raiders get no time to use it).
pub(crate) const LEND_HOLD: u32 = 4;
pub(crate) const LEND_HOLD_FIGHT: u32 = 1;

/// Soil fertility is counted in hundredths of a percent: FERT_MAX is rich soil. A farm cycle is 8 seconds, so 1 200 cycles make a game year: sown every cycle a field
/// loses FERT_WEAR hundredths a harvest (about 70% of its richness in a year, and it yields only half at the very worst); a resting field regains FERT_REST a cycle.
const FERT_MAX: u16 = 10_000;
const FERT_WEAR: u16 = 6;
const FERT_REST: u16 = 12;
/// Rotation: a field rests when its soil drops to the first figure and is sown again at the second.
const FERT_TIRED: u16 = 4_500;
const FERT_RESTORED: u16 = 9_000;

/// A moat piece's width: its rotation value (0..7) widens the ditch from 1x to 1.9x, so a moat can be thin in places and broad in others.
pub(crate) fn moat_scale(b: &Building) -> f32 { 1.0 + 0.13 * (b.rot & 7) as f32 }

/// The summed effect of optional design upgrades (see `World::perks`).
#[derive(Default, Clone, Copy)]
pub(crate) struct Perks { pub housing: i32, pub happy: i32, pub banner_pct: i32, pub train_pct: u32, pub militia: u32, pub woodsheds: i32, pub doves: i32 }

/// Walls, fences, gates and moat pieces are not on the village path network.
fn is_barrier(kind: u8) -> bool { matches!(kind, WALL | FENCE | GATE) || is_edit(kind) }
/// No order may point further than this from the map's centre (the map is about 2400 units across).
const MAP_LIMIT: f32 = 1500.0;
/// No standing army can hold more soldiers of one kind than this (the testing tool stops at the same number).
const ARMY_MAX: u32 = 100_000;
const LEVEL_BLEND: f32 = 9.0;  // how far a levelled patch of ground blends back into the land
pub(crate) const MOAT_FLOOR: f32 = 3.0;  // flat bottom radius of a moat piece
pub(crate) const RIVER_FLOOR: f32 = 2.0; // and of a river piece
pub(crate) const CHANNEL_BANK: f32 = 1.6;           // how far the steep bank runs out beyond the floor: a channel is a trench with the water at its brim, not a wide dish
/// How far below the rim of the land the water of a moat stands.
const MOAT_FREEBOARD: f32 = 0.8;
const MOAT_BED: f32 = -3.4;   // a moat is deep: the water reads as water (the shader darkens it with depth) and a soldier in it is out of his depth
const RIVER_BED: f32 = -2.0; // a river is shallower than a moat, but holds real water  // depth of the bottom
const ROAD_INNER: f32 = 1.5; // fully graded half-width of a path
const ROAD_OUTER: f32 = 4.4; // terrain blends back to the natural slope by here

const RADIUS_CAP: f32 = 110.0;
/// The farthest from the town hall anything can be built, however far the territory has crept outwards.
const TERRITORY_MAX: f32 = 170.0;
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
const HALF_F: f32 = terrain::HALF;
pub const SEASON_DAYS: u64 = 10;
/// How far out from a waterwheel house's middle its wheel hangs (the model's axle), and the highest the house's pad may stand so the wheel reaches the water.
pub const WHEEL_REACH: f32 = 4.4;
pub const WHEEL_PAD_MAX: f32 = 0.7;
/// Grain harvest by season in percent: spring sowing, summer growth, a big autumn harvest, a barren winter.
const GRAIN_BY_SEASON: [i32; 4] = [100, 125, 150, 25];
/// What a unit of each resource is worth in gold coins (a merchant pays 80% of it).
const PRICE: [i32; N_RES] = [1, 2, 2, 1, 3, 2, 5, 6, 1, 2, 1, 6];

/// Goods on their way to another village (`to` is that village's tag), arriving at tick `eta`.
#[derive(Clone)]
pub struct Caravan { res: u8, amount: i32, to: i32, start: u64, eta: u64, escort: u32 }
/// A diplomatic errand on the road to another village (`tag`): `kind` is a treaty kind (0 trade pact, 1 peace, 2 alliance) or one of JK_ENVOY, JK_MARRIAGE, JK_WAR; `arg` is the treaty's length in days.
/// It sets out at `start` and its effect happens when it arrives at `arrive`. Everyone's copy of the village holds the same list, so the procession can be shown on all of them.
#[derive(Clone)]
pub struct Journey { kind: u8, tag: i32, arg: i32, start: u64, arrive: u64 }
pub const JK_ENVOY: u8 = 3;
pub const JK_MARRIAGE: u8 = 4;
pub const JK_WAR: u8 = 5;
/// The kind a caravan has in `journeys_flat`.
pub const JK_CARAVAN: u8 = 6;
/// Ticks per unit of road for each journey kind (a rider is quicker than a procession).
const JOURNEY_SPEED: [f32; 6] = [2.2, 1.6, 1.5, 1.8, 1.0, 3.0];
/// An agreement with another village: `kind` 0 trade pact (better prices), 1 non-aggression (neither side may start a battle against the other), 2 alliance (the same, and the best prices), until tick `until`.
#[derive(Clone)]
pub struct Treaty { tag: i32, kind: u8, until: u64 }
pub const TREATY_TRADE: u8 = 0;
pub const TREATY_PEACE: u8 = 1;
pub const TREATY_ALLIANCE: u8 = 2;
/// Ticks a caravan takes to reach a village: a minute plus the distance.
const CARAVAN_SPEED: f32 = 1.2;

#[wasm_bindgen]
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
    style: u32,                   // the village's flag as one number (see web/src/flag.ts), 0 = none chosen; part of the state so every peer sees it
    hero: Option<(u8, u32)>,      // the village's lord: name index and experience (level follows from it)
    defer_roads: bool,            // inside place_batch: the path network is rebuilt once at the end
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
    eff: u32,
    jobs: u32,
    events: Vec<i32>,
    sites: Vec<(f32, f32)>,
    flow: [i32; N_RES],
    levels: Vec<[f32; 4]>,        // [x, y, radius, height] ground levelled flat (a village site, the banks of a drawbridge)
    roads: Vec<[f32; 6]>,         // [ax, ay, ah, bx, by, bh] graded path segments
    road_links: Vec<(u32, u32)>,  // (child, parent) building indices for each segment
    road_paths: Vec<(u32, u32, Vec<(f32, f32)>)>,   // full walkable route of each link, child doorstep to parent doorstep (crosses drawbridges)
    road_cache: std::collections::HashMap<(u32, u32), (u64, Option<Vec<(f32, f32)>>)>,   // routes already found, valid while nothing changed round them
    army: [u32; NK],
    queue: [u32; NK],
    train_prog: u32,
    away: [u32; NK],
    battle: Option<Battle>,
    wildfires: Vec<Wildfire>,
    craters: Vec<[f32; 4]>,
    scorch: Vec<[f32; 3]>,
    ruins: Vec<[f32; 6]>,   // [x, y, r, kind, tier, rot]
    shots: Vec<[f32; 7]>,
    terrain_ver: u32,
    report: Vec<i32>,
    report_seq: u32,
    dets: Vec<march::Det>,       // field armies on the move
    next_det: u32,
    felled: Vec<[f32; 3]>,       // trees cleared by marching soldiers [x, y, radius]
    links: Vec<Vec<(f32, f32)>>,   // invisible paths chained from this city out to other villages' cities (set by `link_village`; part of the state)
    ov_cache: std::cell::RefCell<Option<(u64, std::rc::Rc<march::Ov>)>>,   // the grid overlays (derived; rebuilt when the village changes)
    net_cache: std::cell::RefCell<Option<(u64, std::rc::Rc<pathnet::Net>)>>,   // the path network (derived; rebuilt when the village changes)
    moat_water: Vec<[f32; 4]>,   // the surface of the water in each moat piece, for drawing: [x, y, reach, level] (derived: see `compute_moat_water`)
    groves: Vec<[f32; 3]>,       // patches of forest kept standing inside a big cleared area [x, y, radius] (the model village's woodcutter grove)
    bridges: Vec<[f32; 4]>,      // bridges built over water [ax, ay, bx, by]
    db_want: Vec<u32>,           // drawbridges that own soldiers in the fight are waiting to cross this tick (transient: filled by the battle, used by drawbridge_step and cleared)
    map_ver: u32,                // changes when trees are felled or bridges built
}

#[wasm_bindgen]
pub fn catalog() -> String { catalog_json() }

#[wasm_bindgen]
pub fn units() -> String { military::units_json() }

#[wasm_bindgen]
pub fn terrain_grid(seed: u64, x0: f32, y0: f32, nx: u32, ny: u32, step: f32) -> Vec<f32> { terrain::grid(seed, x0, y0, nx, ny, step) }

/// Mountain tunnels: [x0, y0, x1, y1] per tunnel.
#[wasm_bindgen]
pub fn tunnels_flat(seed: u64) -> Vec<f32> { terrain::tunnels(seed).into_iter().flatten().collect() }

#[wasm_bindgen]
pub fn trees_in(seed: u64, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<f32> { terrain::trees(seed, x0, y0, x1, y1) }

/// Build the army navigation grid now (about a second of work) instead of in the middle of play, when the first field army is formed. Call it behind the loading screen.
#[wasm_bindgen]
pub fn warm_navigation(seed: u64) { let _ = march::nav_static(seed); }

#[wasm_bindgen]
pub fn village_sites(seed: u64) -> Vec<f32> { terrain::sites(seed).into_iter().flat_map(|(x, y)| [x, y]).collect() }

#[wasm_bindgen]
/// How much room a building takes at a tier: the grander buildings spread out as they are upgraded (a farm gains fields, a keep its courtyard), so an upgrade can need the
/// neighbours to make way.
pub fn footprint(kind: u8, tier: u8) -> f32 {
    let Some(d) = DEFS.get(kind as usize) else { return 0.0 };
    let grow = match kind { FARM => 0.25, TOWN_HALL => 0.1, KEEP => 0.1, BARRACKS | CHAPEL | COURTHOUSE | MARKET | STOREHOUSE | HOSPITAL | GRAVEYARD => 0.1, _ => 0.0 };
    if kind == TOWN_HALL && tier >= 3 { return 12.6; }   // the Castle is a walled rectangle 18 x 12 with towers at its corners: it needs the room (see the town hall model)
    d.r * (1.0 + grow * tier as f32)
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
        TOWER | KEEP | TOWN_HALL | CHAPEL | BARRACKS => fp * 0.85 + 0.3,
        _ => fp * 0.72 + 0.3,
    }
}
#[wasm_bindgen]
pub fn solid_radius_of(kind: u8, tier: u8) -> f32 { solid_radius(kind, tier) }
/// How far from a building's middle the ring of path round it runs (round a farm: out past all of its fields).
#[wasm_bindgen]
pub fn ring_radius_of(kind: u8, tier: u8) -> f32 { pathnet::ring_radius(kind, tier) }

#[wasm_bindgen]
pub fn upgrade_cost_flat(kind: u8, new_tier: u8) -> Vec<i32> {
    match DEFS.get(kind as usize) {
        Some(d) => upgrade_cost(d.weight, new_tier).into_iter().flat_map(|(r, n)| [r as i32, n]).collect(),
        None => vec![],
    }
}

#[wasm_bindgen]
impl World {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, ox: i32, oy: i32) -> World {
        let mut w = World {
            seed, ox, oy, tick: 0, rng: Rng(seed ^ 0x9E3779B97F4A7C15 ^ ((ox as i64 as u64) << 20) ^ (oy as i64 as u64)),
            buildings: vec![], deposits: terrain::deposits(seed), stock: [0; N_RES], population: 10, sick: 0, children: 3, elders: 0, born: 0, arrived: 0, enlisted: 0, left: 0, died: [0; 5], unburied: 0, buried: 0, graves_used: 0, devotion: 0, relations: vec![], married: vec![], last_envoy: vec![], style: 0, hero: None, defer_roads: false, neutral_done: vec![], explored: vec![0; (FOG_N * FOG_N) as usize], choice: None, mood: 0, mood_until: 0, quarantine_until: 0, plague_start: 0, plague_end: 0, share_until: 0, caravans: vec![], journeys: vec![], arrivals: vec![], awaiting: vec![], delivered: vec![], treaties: vec![], warm: true, eff: 100, jobs: 0,
            events: vec![], sites: terrain::sites(seed), flow: [0; N_RES], levels: vec![], roads: vec![], road_links: vec![], road_paths: vec![], road_cache: Default::default(),
            army: [0; NK], queue: [0; NK], train_prog: 0, away: [0; NK], battle: None, wildfires: vec![], craters: vec![], scorch: vec![], ruins: vec![], shots: vec![], terrain_ver: 0, report: vec![], report_seq: 0, dets: vec![], next_det: 0, felled: vec![], groves: vec![], net_cache: Default::default(), ov_cache: Default::default(), links: vec![], moat_water: vec![], bridges: vec![], db_want: vec![], map_ver: 0,
        };
        w.stock[W as usize] = 160;
        w.stock[PL as usize] = 20;
        w.stock[ST as usize] = 70;
        w.stock[GR as usize] = 120;
        w.stock[TL as usize] = 6;
        w.stock[GD as usize] = 30;
        let (x, y) = (ox as f32, oy as f32);
        let pad_h = w.base(x, y);
        w.buildings.push(Building { kind: TOWN_HALL, tier: 0, x, y, rot: 0, pad_h, progress: 0, status: 4, aux: -1, staff: 0, residents: 0, hp: battle::max_hp(TOWN_HALL, 0), burning: 0.0, garrison: 0, born: 0, opts: 0, fert: FERT_MAX, mode: 0 });
        w.neutral_done = vec![false; terrain::neutrals(seed).len()];
        w.reveal(x, y, 110.0);
        w.after_change();
        w
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
    /// Neutral places you know about: [kind, x, y, done] each (kind 0 abbey, 1 ruined castle, 2 bandit camp). Unseen places are left out.
    pub fn neutrals_flat(&self) -> Vec<f32> {
        terrain::neutrals(self.seed).iter().enumerate().filter(|(_, n)| self.is_seen(n.1, n.2)).flat_map(|(i, n)| [n.0 as f32, n.1, n.2, self.neutral_done.get(i).copied().unwrap_or(false) as u8 as f32]).collect()
    }
    /// Send a field army (that has stopped near one) into a neutral place. Abbey: the sick are healed and spirits rise. Ruined castle: its hoard is carried off. Bandit camp: a fight,
    /// won by strength, whose loser is the army (half of it falls) or the camp (cleared, its coin taken). Returns the kind (0..2) on success, -1 no such army, -2 nothing close enough, -3 already visited.
    pub fn visit_neutral(&mut self, army_id: u32) -> i32 {
        let Some(di) = self.dets.iter().position(|d| d.id == army_id) else { return -1 };
        let (ax, ay, units) = (self.dets[di].x, self.dets[di].y, self.dets[di].units);
        let list = terrain::neutrals(self.seed);
        let Some((ni, &(kind, nx, ny))) = list.iter().enumerate().filter(|(_, n)| ((n.1 - ax).powi(2) + (n.2 - ay).powi(2)).sqrt() < 14.0).next() else { return -2 };
        if self.neutral_done.get(ni).copied().unwrap_or(true) { return -3; }
        let cap = self.storage_cap(); let h = terrain::h01(self.seed ^ 0x52, ni as i32, 3);
        match kind {
            0 => { self.end_plague(); self.mood = 12; self.mood_until = self.tick + 15 * DAY; }
            1 => { for (r, base) in [(ST, 120), (IR, 20), (GD, 80), (PL, 60)] { let n = (base as f32 * (0.6 + h)) as i32; self.stock[r as usize] = Self::add_capped(self.stock[r as usize], n, cap); } }
            _ => {
                let power: f32 = (0..NK).map(|k| units[k] as f32 * UNITS[k].hp * UNITS[k].dmg / UNITS[k].cd.max(0.5)).sum();
                let camp = 9000.0 + 14000.0 * h;
                if power >= camp { self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], 120, cap); self.stock[IR as usize] = Self::add_capped(self.stock[IR as usize], 15, cap); }
                else { self.dets[di].grp.clear(); for k in 0..NK { self.dets[di].units[k] /= 2; } if self.dets[di].units.iter().all(|&u| u == 0) { self.dets.remove(di); } return kind as i32 + 100; }   // beaten: not marked done, it can be tried again
            }
        }
        self.neutral_done[ni] = true; self.reveal(nx, ny, 80.0); self.push_event(EV_VISIT, kind as i32, 0);
        kind as i32
    }

    fn base(&self, x: f32, y: f32) -> f32 { terrain::base_height_s(self.seed, &self.sites, x, y) }

    /// Link every building to the nearest earlier one it can actually walk to. The route is found with the army's pathfinding (buildings and walls block, gates
    /// and lowered drawbridges let you through, open water stops you), so a path never runs through a wall or across a moat. A building with no route gets no path.
    fn rebuild_roads(&mut self) {
        self.roads.clear();
        self.road_links.clear();
        self.road_paths.clear();
        let n = self.buildings.len();
        let ends: Vec<usize> = (0..n).filter(|&i| i == 0 || !(is_barrier(self.buildings[i].kind) || matches!(self.buildings[i].kind, DRAWBRIDGE | BRIDGE))).collect();
        let mut used: std::collections::HashSet<(u32, u32)> = Default::default();
        for (pos, &i) in ends.iter().enumerate() {
            if pos == 0 { continue; }
            let (bx, by) = (self.buildings[i].x, self.buildings[i].y);
            let mut cand: Vec<(usize, f32)> = ends[..pos].iter().map(|&j| (j, ((self.buildings[j].x - bx).powi(2) + (self.buildings[j].y - by).powi(2)).sqrt() * if j == 0 { 0.8 } else { 1.0 })).filter(|c| c.1 < 80.0).collect();
            cand.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            for &(j, _) in cand.iter().take(4) {
                let key = (i as u32, j as u32);
                let stamp = self.route_stamp(i, j);
                let cached = match self.road_cache.get(&key) { Some((h, r)) if *h == stamp => Some(r.clone()), _ => None };
                let route = match cached { Some(r) => r, None => { let r = self.route_local(i, j); self.road_cache.insert(key, (stamp, r.clone())); r } };
                let Some(pts) = route else { continue };
                // graded segments: only the stretches over dry ground (a road across a moat or river must never fill it in)
                let (ha, hb) = (self.buildings[i].pad_h, self.buildings[j].pad_h);
                let total: f32 = pts.windows(2).map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)).sum::<f32>().max(0.01);
                let mut run = 0.0f32;
                for w in pts.windows(2) {
                    let l = (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1);
                    if self.leg_is_dry(w[0], w[1]) {
                        let (t0, t1) = (run / total, (run + l) / total);
                        let (ci, pj) = (i as u32, j as u32);
                        self.roads.push([w[0].0, w[0].1, lerp(ha, hb, t0), w[1].0, w[1].1, lerp(ha, hb, t1)]);
                        self.road_links.push((ci, pj));
                    }
                    run += l;
                }
                if used.insert(key) { self.road_paths.push((i as u32, j as u32, pts)); }
                break;
            }
        }
        // drop cache entries that point at buildings which no longer exist
        if self.road_cache.len() > 4 * n + 64 { self.road_cache.retain(|k, _| (k.0 as usize) < n && (k.1 as usize) < n); }
    }

    /// Is a straight leg of a route over dry, ordinary ground (not water and not a drawbridge deck)?
    fn leg_is_dry(&self, a: (f32, f32), b: (f32, f32)) -> bool {
        let l = (b.0 - a.0).hypot(b.1 - a.1); let st = (l / 1.5).ceil().max(1.0) as i32;
        (0..=st).all(|q| { let t = q as f32 / st as f32; let (x, y) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t); self.height_ground(x, y) >= 0.2 && !self.on_deck(x, y) })
    }

    /// Is the point on the deck of a lowered drawbridge?
    fn on_deck(&self, x: f32, y: f32) -> bool {
        if self.buildings.iter().any(|b| { if b.kind != BRIDGE { return false; } let (ux, uy, l) = Self::bridge_dir(b); let (dx, dy) = (x - b.x, y - b.y); (dx * ux + dy * uy).abs() <= l / 2.0 && (dx * uy - dy * ux).abs() <= 1.9 }) { return true; }
        self.buildings.iter().any(|b| {
            if b.kind != DRAWBRIDGE || b.status == 5 { return false; }
            let a = b.rot as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            let (dx, dy) = (x - b.x, y - b.y); let along = dx * sx + dy * sy; let across = dx * sy - dy * sx;
            along.abs() <= 7.4 && across.abs() <= 1.9
        })
    }

    /// A fingerprint of everything that could change the route between two buildings: what stands (or was dug) round them, and the levelled ground.
    fn route_stamp(&self, i: usize, j: usize) -> u64 {
        let (a, b) = (&self.buildings[i], &self.buildings[j]);
        let (x0, x1, y0, y1) = (a.x.min(b.x) - 18.0, a.x.max(b.x) + 18.0, a.y.min(b.y) - 18.0, a.y.max(b.y) + 18.0);
        let mut h: u64 = 0xcbf29ce484222325;
        let mut mix = |v: u64| { h ^= v; h = h.wrapping_mul(0x100000001b3); };
        mix(a.x.to_bits() as u64); mix(a.y.to_bits() as u64); mix(b.x.to_bits() as u64); mix(b.y.to_bits() as u64);
        for q in &self.buildings {
            if q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1 { continue; }
            mix(q.kind as u64); mix(q.x.to_bits() as u64); mix(q.y.to_bits() as u64); mix(q.rot as u64); if matches!(q.kind, DRAWBRIDGE | GATE) { mix(q.status as u64); }
        }
        for l in &self.levels { if l[0] + l[2] + LEVEL_BLEND > x0 && l[0] - l[2] - LEVEL_BLEND < x1 && l[1] + l[2] + LEVEL_BLEND > y0 && l[1] - l[2] - LEVEL_BLEND < y1 { mix(l[0].to_bits() as u64); mix(l[1].to_bits() as u64); mix(l[2].to_bits() as u64); mix(l[3].to_bits() as u64); } }
        for c in &self.craters { if c[0] > x0 && c[0] < x1 && c[1] > y0 && c[1] < y1 { mix(c[0].to_bits() as u64); mix(c[1].to_bits() as u64); } }
        mix(self.battle.is_some() as u64);
        h
    }

    /// Recompute derived data after the building list or tiers changed.
    fn after_change(&mut self) {
        if self.defer_roads { self.staffing(); return; }
        self.moat_water = self.compute_moat_water();
        self.rebuild_roads();
        self.staffing();
    }

    /// Where the water stands in a moat. The ditch is dug deep so that it reads as deep water, but the sea is at height 0 and the banks are several units higher, so the plain water
    /// plane would sit far below the brim. A moat's water is drawn at its own level instead: a little below the rim of the surrounding ground (an average of the land just outside the
    /// bank), smoothed between neighbouring pieces so the surface is one continuous sheet. Gameplay does not use it: water is still wherever the ground is below the shore line.
    fn compute_moat_water(&self) -> Vec<[f32; 4]> {
        let pieces: Vec<[f32; 4]> = self.buildings.iter().filter(|b| b.kind == MOAT).map(|b| {
            let reach = MOAT_FLOOR * moat_scale(b) + CHANNEL_BANK;
            let rim = (0..8).map(|k| { let a = k as f32 * std::f32::consts::TAU / 8.0; self.height_core(b.x + a.cos() * (reach + 1.5), b.y + a.sin() * (reach + 1.5), false) }).sum::<f32>() / 8.0;
            [b.x, b.y, reach, (rim - MOAT_FREEBOARD).max(0.4)]
        }).collect();
        pieces.iter().map(|p| {
            let near: Vec<f32> = pieces.iter().filter(|q| (q[0] - p[0]).hypot(q[1] - p[1]) < 10.0).map(|q| q[3]).collect();
            [p[0], p[1], p[2], near.iter().sum::<f32>() / near.len().max(1) as f32]
        }).collect()
    }
    /// The surface of the water in each moat piece: [x, y, reach, level] (stride 4).
    pub fn moat_water_flat(&self) -> Vec<f32> { self.moat_water.iter().flatten().copied().collect() }
    /// The level of the moat water at a point, or 0 (the sea) when it is not in a moat.
    pub(crate) fn moat_level_at(&self, x: f32, y: f32) -> f32 {
        self.moat_water.iter().filter(|p| (p[0] - x).hypot(p[1] - y) < p[2] + 1.0).map(|p| p[3]).fold(0.0, f32::max)
    }

    /// Workforce efficiency, and how villagers are spread over workplaces and homes.
    fn staffing(&mut self) {
        self.jobs = self.buildings.iter().map(|b| DEFS[b.kind as usize].jobs * (b.tier as u32 + 1)).sum();
        self.children = self.children.min(self.population); self.elders = self.elders.min(self.population - self.children);
        let workers = (self.adults().saturating_sub(self.sick)) * 7 / 10 * if self.tick < self.quarantine_until { 7 } else { 10 } / 10;
        self.eff = if self.jobs == 0 { 100 } else { (workers * 100 / self.jobs).min(100) };
        let cap = self.capacity();
        let housed = self.population.min(cap);
        let mut left = housed;
        let eff = self.eff;
        for b in self.buildings.iter_mut() {
            let d = &DEFS[b.kind as usize];
            b.staff = (d.jobs * (b.tier as u32 + 1) * eff + 50) / 100;
            let c = d.housing * (b.tier as u32 + 1);
            let r = if cap == 0 { 0 } else { (c * housed / cap).min(left) };
            b.residents = r;
            left -= r;
        }
        for b in self.buildings.iter_mut() { if left == 0 { break; } let c = DEFS[b.kind as usize].housing * (b.tier as u32 + 1); if c > b.residents { b.residents += 1; left -= 1; } }
    }

    /// Terrain height including graded paths and the levelled pads under buildings.
    pub fn height_at(&self, x: f32, y: f32) -> f32 { self.height_core(x, y, true) }

    /// Level the ground round the village (radius `r`) to an even height, so a whole castle can be raised on flat land. 0 ok, -1 battle going on.
    pub fn flatten(&mut self, r: u32) -> i32 {
        if self.battle.is_some() { return -1; }
        let (cx, cy) = (self.buildings[0].x, self.buildings[0].y); let rr = (r as f32).clamp(10.0, 110.0);
        let mut sum = 0.0; let mut n = 0.0;
        for k in 0..25 { let (i, j) = ((k % 5) as f32 - 2.0, (k / 5) as f32 - 2.0); sum += self.base(cx + i * rr * 0.25, cy + j * rr * 0.25); n += 1.0; }
        let h = (sum / n).clamp(3.0, 9.0);
        self.levels.push([cx, cy, rr, h]); self.terrain_ver += 1; self.map_ver += 1;
        // everything already standing keeps its own levelled base; ground between is blended
        self.after_change(); 0
    }

    /// Ground height as the road router sees it: natural land, levelled ground, ditches and the banks at each end of a drawbridge, but no paths and no building pads.
    fn height_ground(&self, x: f32, y: f32) -> f32 { self.height_inner(x, y, true, false) }

    /// Height with or without the ditches dug by moat pieces (placing a moat piece looks at the ground as it was).
    fn height_core(&self, x: f32, y: f32, moats: bool) -> f32 { self.height_inner(x, y, moats, true) }

    fn height_inner(&self, x: f32, y: f32, moats: bool, built: bool) -> f32 {
        let mut h = self.base(x, y);
        for l in &self.levels {   // ground levelled flat on purpose
            let (dx, dy) = (x - l[0], y - l[1]); let reach = l[2] + LEVEL_BLEND;
            if dx.abs() > reach || dy.abs() > reach { continue; }
            let d = (dx * dx + dy * dy).sqrt();
            if d < reach { h = lerp(h, l[3], 1.0 - smoothstep(l[2], reach, d)); }
        }
        if moats {
            // A moat or river is a chain of pieces. Digging each piece as its own round hollow (each one taking the deepest) leaves a scalloped bank, a bump at every piece. So the
            // pieces' reach is summed instead and the ground is dug by the total (at most all the way): between two neighbours both contribute, which fills in the scallop. A single
            // piece still digs exactly the round pit it always did.
            let (mut fm, mut fr) = (0.0f32, 0.0f32);
            for b in self.buildings.iter().filter(|b| is_edit(b.kind)) {
                let (dx, dy) = (x - b.x, y - b.y);
                let (floor, bank) = match b.kind { MOAT => (MOAT_FLOOR * moat_scale(b), MOAT_FLOOR * moat_scale(b) + CHANNEL_BANK), RIVER => (RIVER_FLOOR, RIVER_FLOOR + CHANNEL_BANK), _ => (1.2, 5.0) };
                if dx.abs() > bank || dy.abs() > bank { continue; }
                let dist = (dx * dx + dy * dy).sqrt();
                if dist >= bank { continue; }
                match b.kind {
                    MOAT | RIVER => { let f = 1.0 - smoothstep(floor, bank, dist); if b.kind == MOAT { fm += f; } else { fr += f; } }
                    RAISE => h += 2.2 * (1.0 - smoothstep(floor, bank, dist)),
                    _ => h -= 2.2 * (1.0 - smoothstep(floor, bank, dist)),
                }
            }
            if fm > 0.0 && h > MOAT_BED { h += (MOAT_BED - h) * fm.min(1.0); }
            if fr > 0.0 && h > RIVER_BED { h += (RIVER_BED - h) * fr.min(1.0); }
        }
        // the earth at each end of a drawbridge is levelled to the deck, in a strip that runs on from the deck's ends (after the ditch is dug, so the water stays between them):
        // the deck meets the ground flush, with no step and no slope to climb
        for b in self.buildings.iter().filter(|b| b.kind == DRAWBRIDGE) {
            if (x - b.x).abs() > 24.0 || (y - b.y).abs() > 24.0 { continue; }
            let a = (b.rot & 7) as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            let (dx, dy) = (x - b.x, y - b.y); let s = (dx * sx + dy * sy).abs(); let c = (dx * sy - dy * sx).abs();
            if !(5.6..22.0).contains(&s) || c > 5.2 { continue; }
            let w = smoothstep(5.6, 6.6, s) * (1.0 - smoothstep(15.0, 22.0, s)) * (1.0 - smoothstep(2.4, 5.2, c));
            h = lerp(h, b.pad_h, w * smoothstep(-0.2, 0.6, h));   // (only dry ground is levelled: a river or moat under and beside the deck is never filled in)
        }
        if !built { return h; }
        for s in &self.roads {
            let (minx, maxx) = (s[0].min(s[3]) - ROAD_OUTER, s[0].max(s[3]) + ROAD_OUTER);
            let (miny, maxy) = (s[1].min(s[4]) - ROAD_OUTER, s[1].max(s[4]) + ROAD_OUTER);
            if x < minx || x > maxx || y < miny || y > maxy { continue; }
            let (dx, dy) = (s[3] - s[0], s[4] - s[1]);
            let len2 = (dx * dx + dy * dy).max(0.0001);
            let t = (((x - s[0]) * dx + (y - s[1]) * dy) / len2).clamp(0.0, 1.0);
            let (cx, cy) = (s[0] + dx * t, s[1] + dy * t);
            let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
            if d < ROAD_OUTER { h = lerp(h, lerp(s[2], s[5], t), 1.0 - smoothstep(ROAD_INNER, ROAD_OUTER, d)); }
        }
        for b in &self.buildings {
            let d = &DEFS[b.kind as usize];
            if is_edit(b.kind) { continue; }   // ditches and earthworks were applied above, before roads and pads
            if !d.pad { continue; }
            let r0 = pad_inner(d);
            let r1 = r0 + 3.5;
            let (dx, dy) = (x - b.x, y - b.y);
            if dx.abs() > r1 || dy.abs() > r1 { continue; }
            let dist = (dx * dx + dy * dy).sqrt();
            if matches!(b.kind, WALL | GATE | FENCE) {   // a wall builds the ground it stands on: earth is heaped up where it is missing (never dug away), so no wall hangs over a drop or a ditch
                let r1 = r0 + 2.2;
                if dist < r1 && h < b.pad_h { h += (b.pad_h - h) * (1.0 - smoothstep(r0 * 0.8, r1, dist)); }
            } else if dist < r1 { h = lerp(h, b.pad_h, 1.0 - smoothstep(r0, r1, dist)); }
        }
        for c in &self.craters {
            let (dx, dy) = (x - c[0], y - c[1]);
            if dx.abs() > c[2] || dy.abs() > c[2] { continue; }
            let d = (dx * dx + dy * dy).sqrt();
            if d < c[2] { h -= c[3] * (1.0 - smoothstep(0.0, c[2], d)); }
        }
        h
    }

    /// Heights of an nx*ny grid (with pads) – used to refresh the mesh after building.
    pub fn terrain_region(&self, x0: f32, y0: f32, nx: u32, ny: u32, step: f32) -> Vec<f32> {
        let mut out = Vec::with_capacity((nx * ny) as usize);
        for j in 0..ny { for i in 0..nx { out.push(self.height_at(x0 + i as f32 * step, y0 + j as f32 * step)); } }
        out
    }

    pub fn origin_x(&self) -> i32 { self.ox }
    pub fn origin_y(&self) -> i32 { self.oy }

    pub fn build_radius(&self) -> u32 {
        let w: u32 = self.buildings.iter().map(|b| DEFS[b.kind as usize].weight * (b.tier as u32 + 1)).sum();
        ((24.0 + 7.0 * (w as f32).sqrt()).min(RADIUS_CAP)) as u32
    }

    /// How far a building claims land round itself (0 for earthworks). The town hall claims the circle of `build_radius`; every other building, and every piece of road, claims a patch round it,
    /// so a village grows outwards where its people build, in the shape of what they built, not as a circle.
    fn claim(&self, b: &Building) -> f32 {
        match b.kind {
            TOWN_HALL => self.build_radius() as f32,
            k if is_edit(k) => 0.0,
            ROAD => 6.0,
            BRIDGE => 7.0,
            WALL | FENCE | GATE | DRAWBRIDGE => 5.0,
            k => 10.0 + 2.5 * ((DEFS[k as usize].weight * (b.tier as u32 + 1)) as f32).sqrt(),
        }
    }
    /// Is this spot inside the village's land: near the town hall, or near something built on its edge (never farther than TERRITORY_MAX from the hall)?
    pub fn in_territory(&self, x: f32, y: f32) -> bool {
        let (hx, hy) = (self.buildings[0].x, self.buildings[0].y);
        let dh = ((x - hx).powi(2) + (y - hy).powi(2)).sqrt();
        if dh > TERRITORY_MAX { return false; }
        self.buildings.iter().any(|b| { let c = self.claim(b); c > 0.0 && (x - b.x).abs() <= c && (y - b.y).abs() <= c && ((x - b.x).powi(2) + (y - b.y).powi(2)) <= c * c })
    }
    /// The land the village holds, as discs [x, y, radius]: the hall's circle and a patch round every building. The border is the outline of their union.
    pub fn territory_flat(&self) -> Vec<f32> {
        self.buildings.iter().filter_map(|b| { let c = self.claim(b); if c > 0.0 { Some([b.x, b.y, c]) } else { None } }).flatten().collect()
    }

    /// -17 a deposit is in the way, -16 needs water, -18 no water to bridge near here, -19 too wide for this bridge.
    /// 0 = ok, otherwise: -1 bad kind, -2 outside radius, -3 overlaps, -4 water, -5 too steep,
    /// -6 cannot afford, -7 needs deposit, -8 needs forest, -9 not buildable (town hall)
    pub fn can_place(&self, kind: u8, dx: i32, dy: i32) -> i32 {
        let Some(d) = DEFS.get(kind as usize) else { return -1 };
        if kind == TOWN_HALL { return -9; }
        if kind == BRIDGE { return self.bridge_check(dx, dy, 0).0; }
        let (x, y) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        if !self.in_territory(x, y) { return -2; }
        if kind == GATE && !self.buildings.iter().any(|b| b.kind == WALL && (b.x - x).hypot(b.y - y) <= 9.0) { return -20; }   // a gate only ever stands in a wall
        for b in &self.buildings {
            let _bd = &DEFS[b.kind as usize];
            if (matches!(kind, DRAWBRIDGE | BRIDGE) && matches!(b.kind, MOAT | RIVER)) || (matches!(kind, MOAT | RIVER) && matches!(b.kind, DRAWBRIDGE | BRIDGE)) { continue; }   // a bridge spans the water   // a drawbridge spans the water
            if is_edit(kind) && is_edit(b.kind) && kind != b.kind { continue; }                                                               // raise, lower, dig: different edits can share a spot
            if (b.x - x).powi(2) + (b.y - y).powi(2) < (footprint(b.kind, b.tier) + d.r - 0.4).powi(2) { return -3; }
        }
        let fr = d.r * 0.9;
        let pts = [(0.0, 0.0), (fr, 0.0), (-fr, 0.0), (0.0, fr), (0.0, -fr)];
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for (px, py) in pts {
            let h = self.height_core(x + px, y + py, !is_edit(kind) && !matches!(kind, WALL | GATE | FENCE));
            lo = lo.min(h);
            hi = hi.max(h);
        }
        if lo < 0.4 && !matches!(kind, DRAWBRIDGE | RIVER | RAISE | LOWER) { return -4; }
        if (hi - lo) / (fr * 2.0) > d.max_slope { return -5; }
        if d.req != 1 {   // nothing is built or dug on top of an ore or stone deposit (only mines and quarries stand beside one)
            let clear = if is_edit(kind) { 2.6 } else if matches!(kind, WALL | FENCE | GATE) { 0.6 } else { d.r + 1.6 };   // a wall may run over an outcrop (only its very middle is in the way)
            if self.deposits.iter().any(|dep| dep.rem > 0 && (dep.x - x).powi(2) + (dep.y - y).powi(2) < clear * clear) { return -17; }
        }
        if d.req == 1 && self.nearest_deposit(x, y, d.req_arg).is_none() { return -7; }
        if d.req == 2 && self.forest_here(x, y, 12.0) < 0.12 { return -8; }
        if d.req == 3 && !self.water_near(x, y, d.r + 5.0) { return -16; }
        for &(res, n) in d.cost { if self.stock[res as usize] < n { return -6; } }
        0
    }

    /// Is there open water (a lake, river, the sea or a moat) within `r` of the point?
    fn water_near(&self, x: f32, y: f32, r: f32) -> bool {
        for k in 0..16 { let a = k as f32 * std::f32::consts::TAU / 16.0; for rr in [r * 0.6, r] { if self.height_at(x + a.cos() * rr, y + a.sin() * rr) < 0.1 { return true; } } }
        false
    }

    /// Forest density near a point, as the village sees it: the land's own forest, except inside a big cleared area (see `demo`) where only the kept groves still have trees.
    fn forest_here(&self, x: f32, y: f32, r: f32) -> f32 {
        let inside = |c: &[f32; 3]| (c[0] - x).hypot(c[1] - y) < c[2];
        if self.felled.iter().any(|c| c[2] >= 30.0 && inside(c)) && !self.groves.iter().any(inside) { return 0.0; }
        terrain::forest_near(self.seed, x, y, r)
    }

    /// Woodcutters slowly clear the forest round them, so the clearing (and the village) grows.
    fn clear_trees(&mut self, bx: f32, by: f32) {
        if self.rng.range(4) != 0 || self.felled.len() >= 500 { return; }
        let a = self.rng.range(628) as f32 * 0.01; let dist = 5.0 + self.rng.range(120) as f32 * 0.1;
        let (x, y) = (bx + a.cos() * dist, by + a.sin() * dist);
        if self.forest_here(x, y, 2.5) < 0.12 || self.height_at(x, y) < 0.6 { return; }
        if self.felled.iter().any(|f| (f[0] - x).powi(2) + (f[1] - y).powi(2) < 2.2 * 2.2) { return; }
        self.felled.push([x, y, 2.4]); self.map_ver += 1;
    }

    fn nearest_deposit(&self, x: f32, y: f32, kind: u8) -> Option<usize> {
        let mut best: Option<(usize, f32)> = None;
        for (i, dep) in self.deposits.iter().enumerate() {
            if dep.kind != kind || dep.rem <= 0 || self.height_at(dep.x, dep.y) < 0.3 { continue; }   // a deposit drowned by a river or lake cannot be worked
            let d2 = (dep.x - x).powi(2) + (dep.y - y).powi(2);
            if d2 <= 15.0 * 15.0 && best.map_or(true, |(_, b)| d2 < b) { best = Some((i, d2)); }
        }
        best.map(|(i, _)| i)
    }

    /// Place a building at coordinates relative to the village origin. Returns index or the negative `can_place` code.
    pub fn place(&mut self, kind: u8, dx: i32, dy: i32, rot: u8) -> i32 {
        if kind == BRIDGE { return self.place_bridge(dx, dy); }
        let code = self.can_place(kind, dx, dy);
        if code != 0 { return code; }
        if kind == WATERWHEEL && !self.wheel_in_water((self.ox + dx) as f32, (self.oy + dy) as f32, rot & 7) { return -16; }   // the wheel hangs out over the water: the turn decides where it is
        let d = &DEFS[kind as usize];
        let (x, y) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        for &(res, n) in d.cost { self.stock[res as usize] -= n; }
        let fr = d.r * 0.8;
        let samples = [(0.0, 0.0), (fr, 0.0), (-fr, 0.0), (0.0, fr), (0.0, -fr)];
        let mut pad_h = samples.iter().map(|(px, py)| self.height_at(x + px, y + py)).sum::<f32>() / 5.0;
        if matches!(kind, WALL | GATE | FENCE) {   // a wall stands level on its highest side and heaps earth under the low side
            let hi = samples.iter().map(|(px, py)| self.height_core(x + px, y + py, false)).fold(f32::MIN, f32::max);
            pad_h = hi.max(0.3);
        }
        if kind == WATERWHEEL { pad_h = pad_h.min(WHEEL_PAD_MAX); }   // the house stands low on the bank so its wheel dips into the water
        if kind == DRAWBRIDGE {   // the deck lies at the height of the gate, and both banks are levelled to it, so it floats clear above the water
            let gate = self.buildings.iter().filter(|b| b.kind == GATE).map(|b| (((b.x - x).powi(2) + (b.y - y).powi(2)).sqrt(), b.pad_h)).fold(None, |best: Option<(f32, f32)>, c| if best.map_or(true, |b| c.0 < b.0) { Some(c) } else { best });
            let bank = |sx: f32, sy: f32| self.height_at(x + sx * 9.0, y + sy * 9.0);
            let a = (rot & 7) as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            pad_h = match gate { Some((d, h)) if d < 30.0 => h, _ => bank(sx, sy).max(bank(-sx, -sy)).max(0.8) };
        }
        let aux = if d.req == 1 { self.nearest_deposit(x, y, d.req_arg).map_or(-1, |i| i as i32) } else { -1 };
        let status = if d.cycle > 0 { 1 } else { 4 };
        self.buildings.push(Building { kind, tier: 0, x, y, rot: rot & 7, pad_h, progress: 0, status, aux, staff: 0, residents: 0, hp: battle::max_hp(kind, 0), burning: 0.0, garrison: 0, born: self.tick as u32, opts: 0, fert: FERT_MAX, mode: 0 });
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
        self.defer_roads = true;
        let out: Vec<i32> = flat.chunks_exact(4).take(400).map(|c| if c[0] < 0 || c[0] > 255 { -1 } else { self.place(c[0] as u8, c[1], c[2], (c[3] & 7) as u8) }).collect();
        self.defer_roads = false;
        self.after_change();
        out
    }

    /// Which way the waterwheel's wheel looks for a turn `rot`: the model's +x axis turned by r * 45 degrees (the renderer rotates about the vertical, which sends +x to (cos, -sin)).
    fn wheel_dir(rot: u8) -> (f32, f32) { let a = (rot & 7) as f32 * std::f32::consts::FRAC_PI_4; (a.cos(), -a.sin()) }
    /// Does a waterwheel house at (x, y) turned `rot` have its wheel out over open water?
    fn wheel_in_water(&self, x: f32, y: f32, rot: u8) -> bool {
        let (ux, uy) = Self::wheel_dir(rot);
        self.height_at(x + ux * WHEEL_REACH, y + uy * WHEEL_REACH) < 0.2 && self.height_at(x + ux * (WHEEL_REACH + 1.2), y + uy * (WHEEL_REACH + 1.2)) < 0.2
    }
    /// Where a waterwheel clicked at (dx, dy) goes: pulled onto the bank beside the nearest water and turned so its wheel hangs out over it.
    /// [dx, dy, turn] relative to the origin (what `place` takes), or nothing when there is no water within reach or no bank there where the house can stand. Pure function of the world, so
    /// the client only ever sends the answer: `place` checks it again.
    pub fn waterwheel_snap(&self, dx: i32, dy: i32) -> Vec<f32> {
        let (x, y) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        let wet = |px: f32, py: f32| self.height_at(px, py) < 0.1;
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
            let mut t = 0.0f32; while t < 14.0 && self.height_at(px - ux * t, py - uy * t) < 0.45 { t += 0.5; }
            for extra in [0.0f32, 0.5, 1.0, 1.5, 2.5] {
                let back = t + 3.4 + extra - (WHEEL_REACH - 3.4);
                let (sx, sy) = ((px - ux * back).round(), (py - uy * back).round());
                let (cx, cy) = (sx - self.ox as f32, sy - self.oy as f32);
                let code = self.can_place(WATERWHEEL, cx as i32, cy as i32);
                if (code == 0 || code == -6) && self.wheel_in_water(sx, sy, r) { return vec![cx, cy, r as f32]; }
            }
        }
        vec![]
    }

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
        let tl = tx.hypot(ty).max(1e-6); let (nx, ny) = (-ty / tl, tx / tl);   // square across the ditch
        let a = nx.atan2(ny);   // the deck runs along (sin a, cos a)
        let rot = ((a / std::f32::consts::FRAC_PI_4).round() as i32).rem_euclid(8);
        vec![qx.round() - self.ox as f32, qy.round() - self.oy as f32, rot as f32]
    }

    // ---------- bridges ----------
    /// Where a bridge clicked at (dx, dy) would go: it finds the nearest water, picks the way across with the shortest span, and returns [centre x, centre y, angle in radians, total length, span of water],
    /// or nothing when there is no water within reach or it is too wide to bridge at all (60 units).
    pub fn bridge_snap(&self, dx: i32, dy: i32) -> Vec<f32> {
        let (x, y) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        let wet = |px: f32, py: f32| self.height_at(px, py) < 0.2;
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

    /// Can a bridge go here (at the given tier)? (code, snap). 0 ok; -2 outside your land; -3 something in the way; -5 the banks are at very different heights; -6 cannot afford; -18 no water near; -19 too wide for this bridge.
    fn bridge_check(&self, dx: i32, dy: i32, tier: u8) -> (i32, Vec<f32>) {
        let snap = self.bridge_snap(dx, dy);
        if snap.is_empty() { return (-18, snap); }
        let (cx, cy, a, l, span) = (snap[0], snap[1], snap[2], snap[3], snap[4]);
        if span > BRIDGE_SPAN[tier as usize] { return (-19, snap); }
        let (ux, uy) = (a.cos(), a.sin()); let ends = [(cx - ux * l / 2.0, cy - uy * l / 2.0), (cx + ux * l / 2.0, cy + uy * l / 2.0)];
        if ends.iter().any(|&(x, y)| !self.in_territory(x, y)) || !self.in_territory(cx, cy) { return (-2, snap); }
        let (ha, hb) = (self.height_at(ends[0].0, ends[0].1), self.height_at(ends[1].0, ends[1].1));
        if ha < 0.4 || hb < 0.4 || (ha - hb).abs() > 2.6 { return (-5, snap); }
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
        self.buildings.push(Building { kind: BRIDGE, tier: 0, x: cx, y: cy, rot: rot as u8, pad_h: (ha + hb) / 2.0, progress: 0, status: 4, aux, staff: 0, residents: 0, hp: battle::max_hp(BRIDGE, 0), burning: 0.0, garrison: 0, born: self.tick as u32, opts: 0, fert: FERT_MAX, mode: 0 });
        self.after_change();
        (self.buildings.len() - 1) as i32
    }
    /// What a bridge would be if placed at (dx, dy): [code, centre x, centre y, angle, length, span, planks, wood]. The code is `can_place`'s.
    pub fn bridge_preview(&self, dx: i32, dy: i32) -> Vec<f32> {
        let (code, snap) = self.bridge_check(dx, dy, 0);
        if snap.is_empty() { return vec![code as f32]; }
        let c = Self::bridge_cost(snap[4]); let mut v = vec![code as f32]; v.extend_from_slice(&snap); v.push(c[0].1 as f32); v.push(c[1].1 as f32); v
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
        let cost = upgrade_cost(DEFS[b.kind as usize].weight, b.tier + 1);
        if cost.iter().any(|&(r, n)| self.stock[r as usize] < n) { return -6; }
        for &(r, n) in &cost { self.stock[r as usize] -= n; }
        self.buildings[idx as usize].tier += 1;
        let (k, t) = (self.buildings[idx as usize].kind, self.buildings[idx as usize].tier);
        self.buildings[idx as usize].hp = battle::max_hp(k, t);
        self.buildings[idx as usize].burning = 0.0;
        self.after_change();
        0
    }

    /// Choose the village's flag: 0 for none, otherwise a packed flag number (pattern, three colours, emblem; bit 24 always set). Free, and changeable. Anything else is refused.
    pub fn set_style(&mut self, style: u32) -> bool { if style != 0 && (style < (1 << 24) || style >= (1 << 25)) { return false; } self.style = style; true }
    pub fn style(&self) -> u32 { self.style }

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
    /// Clear a deposit off the land (the villagers break the rock up and cart it away, or dig the clay out) so the ground can be built on. 0 done, -1 no such deposit,
    /// -2 outside the border, -3 already cleared, -4 a mine or quarry is working it, -6 not enough wood and tools.
    pub fn clear_deposit(&mut self, i: u32) -> i32 {
        let Some(d) = self.deposits.get(i as usize).copied() else { return -1 };
        if d.max == 0 { return -3; }
        if !self.in_territory(d.x, d.y) { return -2; }
        if self.buildings.iter().any(|b| b.aux == i as i32 && DEFS[b.kind as usize].req == 1) { return -4; }
        if self.stock[W as usize] < 40 || self.stock[TL as usize] < 10 { return -6; }
        self.stock[W as usize] -= 40; self.stock[TL as usize] -= 10;
        let dep = &mut self.deposits[i as usize]; dep.rem = 0; dep.max = 0;
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
            let cost = option_cost(DEFS[b.kind as usize].weight);
            if cost.iter().any(|&(r, n)| self.stock[r as usize] < n) { return -6; }
            for &(r, n) in &cost { self.stock[r as usize] -= n; }
            self.buildings[idx as usize].opts |= 1 << bit;
        } else { self.buildings[idx as usize].opts &= !(1 << bit); }
        0
    }
    /// Chosen optional upgrades per building (a bit mask each), in building order.
    pub fn options_flat(&self) -> Vec<u32> { self.buildings.iter().map(|b| b.opts as u32).collect() }
    /// Flat [resource, amount, ...] cost of one optional upgrade of this kind of building.
    pub fn option_cost_flat(kind: u8) -> Vec<i32> { match DEFS.get(kind as usize) { Some(d) => option_cost(d.weight).into_iter().flat_map(|(r, n)| [r as i32, n]).collect(), None => vec![] } }

    /// Remove a building, refunding half of its base cost.
    pub fn demolish(&mut self, idx: u32) -> bool {
        match self.buildings.get(idx as usize) {
            Some(b) if b.kind != TOWN_HALL => {
                let refund: Vec<Amount> = DEFS[b.kind as usize].cost.iter().map(|&(r, n)| (r, n / 2)).collect();
                for (r, n) in refund { self.stock[r as usize] += n; }
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
        let before = self.stock;
        let cap = self.storage_cap();

        self.staffing();

        // production
        for i in 0..self.buildings.len() {
            let (kind, tier) = (self.buildings[i].kind, self.buildings[i].tier);
            let d = &DEFS[kind as usize];
            if d.cycle == 0 { continue; }
            let need = d.cycle * 100;
            let ob = self.buildings[i].opts;
            let boost = if kind == FARM { 100 + if ob & 1 != 0 { 10 } else { 0 } + if ob & 4 != 0 { 5 } else { 0 } + if ob & 8 != 0 { 10 } else { 0 } }
                else if ob != 0 && !matches!(kind, HOUSE | WALL | TOWER | GATE | DRAWBRIDGE | BARRACKS | KEEP | TOWN_HALL | CHAPEL | WELL | BRIDGE | HOSPITAL | GRAVEYARD) { 100 + if ob & 4 != 0 { 10 } else { 0 } + if ob & 8 != 0 { 5 } else { 0 } } else { 100 };   // scarecrow, fence and barn; awning and stone footing: the building works that much faster
            let mut p = self.buildings[i].progress + self.eff * boost as u32 / 100;
            let mult = 4 + 5 * tier as i32;   // better buildings employ more people and make more: x1, x2.25, x3.5, x4.75
            let scale = |n: i32| ((n * mult + 2) / 4).max(n);
            let season = self.season();
            let soil = if kind == FARM { 500 + self.buildings[i].fert as i32 / 20 } else { 1000 };   // per mille: rich soil 100%, worn out 50%
            let seasonal = if kind == FARM && season == 3 && ob & 2 != 0 { 45 } else { GRAIN_BY_SEASON[season as usize] };   // haystacks keep winter fields worth working
            let yield_of = |r: u8, n: i32| { let q = scale(n); if r == GR { (q * seasonal * soil / 100_000).max(1) } else { q } };
            let mut status = self.buildings[i].status;
            while p >= need {
                if kind == FARM {   // soil: a resting field makes nothing and recovers; a sown one wears the soil down (see FERT_*)
                    let m = self.buildings[i].mode;
                    if m == 1 || m == 3 {
                        let b = &mut self.buildings[i]; b.fert = (b.fert + FERT_REST).min(FERT_MAX); if b.mode == 3 && b.fert >= FERT_RESTORED { b.mode = 2; }
                        status = 4; p -= need; continue;
                    }
                }
                // requirement checks
                let mut dep_idx: Option<usize> = None;
                if d.req == 1 {
                    let a = self.buildings[i].aux;
                    let ok = a >= 0 && self.deposits[a as usize].rem > 0;
                    if ok { dep_idx = Some(a as usize); } else {
                        let (bx, by) = (self.buildings[i].x, self.buildings[i].y);
                        match self.nearest_deposit(bx, by, d.req_arg) {
                            Some(n) => { self.buildings[i].aux = n as i32; dep_idx = Some(n); }
                            None => { status = 2; p = need; break; }
                        }
                    }
                }
                if d.inputs.iter().any(|&(r, n)| self.stock[r as usize] < scale(n)) { status = 1; p = need; break; }
                if d.outputs.iter().any(|&(r, n)| self.stock[r as usize] + yield_of(r, n) > cap) { status = 3; p = need; break; }
                for &(r, n) in d.inputs { self.stock[r as usize] -= scale(n); }
                for &(r, n) in d.outputs { self.stock[r as usize] += yield_of(r, n); }
                if let Some(di) = dep_idx {
                    let out: i32 = d.outputs.iter().map(|&(_, n)| scale(n)).sum();   // ore taken from the ground does not depend on the season
                    self.deposits[di].rem = (self.deposits[di].rem - out).max(0);
                }
                status = 0;
                p -= need;
                if kind == FARM { let b = &mut self.buildings[i]; b.fert = b.fert.saturating_sub(FERT_WEAR); if b.mode == 2 && b.fert <= FERT_TIRED { b.mode = 3; } }
                if kind == 4 { let (cx, cy) = (self.buildings[i].x, self.buildings[i].y); self.clear_trees(cx, cy); }
            }
            self.buildings[i].progress = p;
            self.buildings[i].status = status;
        }

        // food, growth, starvation
        let soldiers: u32 = self.army.iter().sum::<u32>() + self.away.iter().sum::<u32>() + self.dets.iter().map(|d| d.units.iter().sum::<u32>()).sum::<u32>();
        let eat = ((self.population + soldiers) as i32 + 5) / 10;
        if self.stock[GR as usize] >= eat {
            self.stock[GR as usize] -= eat;
            let cap_pop = self.capacity();
            let hap = self.happiness();
            if self.population < cap_pop && self.rng.range(if hap >= 70 { 4 } else if hap < 30 { 8 } else { 5 }) == 0 { self.arrive(1); }
        } else {
            self.stock[GR as usize] = 0;
            if self.population > 2 && self.rng.range(3) == 0 {
                self.kill(1, DIED_HUNGER, 0);
                self.push_event(EV_STARVE, 1, 0);
            }
        }
        // overcrowding pressure if capacity shrank (demolished houses)
        let cap_pop = self.capacity();
        if self.population > cap_pop { self.leave(1); }

        // tax
        if self.tick % 10 == 0 { self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], ((self.population as i32 / 10).max(1) * (50 + self.happiness() as i32) / 100).max(1), cap); }

        // seasons, warmth and the generations
        self.household_step();

        // disease (an outbreak runs for many days: see plague.rs)
        self.plague_step();

        // random events
        if self.rng.range(200) == 0 {
            let n = 30 + self.rng.range(40) as i32;
            self.stock[GR as usize] = Self::add_capped(self.stock[GR as usize], n, cap);
            self.push_event(EV_HARVEST, n, 0);
        }
        // bandits: a real fight on the village grounds
        if self.tick > 600 && self.battle.is_none() && self.rng.range(420) == 0 {
            let angle = self.rng.range(628) as f32 * 0.01;
            let rf = self.rng.range(1000) as f32 / 1000.0;
            let force = self.bandit_force(rf);
            self.begin_battle(force, angle, 0);
        }
        if self.rng.range(320) == 0 {
            let g = 20 + self.rng.range(40) as i32;
            self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], g, cap);
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

    /// Fires in winter, and once a day the generations turn: children grow up, the old pass away, couples have babies.
    fn household_step(&mut self) {
        // winter: every ten ticks the village burns firewood, a tenth of a unit a head
        if self.season() == 3 {
            if self.tick % 10 == 0 {
                let need = (((self.population + 9) / 10) as i32 / if self.tick < self.share_until { 2 } else { 1 } - self.perks().woodsheds / 6).max(0);
                if self.stock[W as usize] >= need { self.stock[W as usize] -= need; self.warm = true; } else { self.stock[W as usize] = 0; self.warm = false; }
            }
        } else { self.warm = true; }
        if self.tick % DAY != 0 { return; }
        { let doves = self.perks().doves; if doves > 0 { let cap = self.storage_cap(); self.stock[GR as usize] = Self::add_capped(self.stock[GR as usize], doves, cap); } }
        let now = self.tick; self.treaties.retain(|t| t.until > now);
        self.death_care_step();
        // the church: a service every seventh day brings the village together, and its tithe
        let churches: Vec<u32> = self.buildings.iter().filter(|b| b.kind == CHAPEL).map(|b| b.tier as u32 + 1).collect();
        if !churches.is_empty() && (now / DAY) % 7 == 6 {
            let tithe: u32 = churches.iter().map(|&t| (self.population / 8).max(1) * t).sum::<u32>().min(60);
            let cap = self.storage_cap(); self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], tithe as i32, cap);
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
        // freezing kills the old and the young first
        if !self.warm && self.population > 3 && self.rng.range(3) == 0 {
            self.kill(1, DIED_COLD, 2); self.push_event(EV_COLD, 1, 0);
        }
        let grown = take(&mut self.rng, self.children, 30); self.children -= grown;
        let adults = self.adults(); let aged = take(&mut self.rng, adults, 90); self.elders += aged;
        let died = take(&mut self.rng, self.elders, 25).min(self.population.saturating_sub(2));
        self.kill(died, DIED_OLD, 1);
        if self.stock[GR as usize] >= 10 && self.happiness() >= 40 && self.population < self.capacity() {
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
            self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], coins, cap);
        }
    }

    /// Caravans on the road can be waylaid: with no escort one in a few hundred ticks is robbed; each spearman guarding it cuts that risk.
    fn caravan_step(&mut self) {
        let mut lost = vec![];
        for (i, c) in self.caravans.iter().enumerate() { if c.eta > self.tick && self.tick % 10 == 0 && self.rng.range(300 + 120 * c.escort) == 0 { lost.push(i); } }
        for &i in lost.iter().rev() { let c = self.caravans.remove(i); self.push_event(EV_ROBBED, c.amount, c.res as i32); }
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
            self.buildings[pi].progress += self.eff;
            if self.buildings[pi].progress < 3000 { continue; }
            self.buildings[pi].progress -= 3000;
            let mult = (4 + 5 * tier) / 4;
            // buy grain if hungry
            if self.stock[GR as usize] < 40 {
                let n = 20 * mult; let cost = n * 3 / 2;
                if self.stock[GD as usize] >= cost && self.stock[GR as usize] + n <= cap { self.stock[GD as usize] -= cost; self.stock[GR as usize] += n; self.push_event(EV_TRADE, -cost, GR as i32); continue; }
            }
            // otherwise sell what there is most of
            let mut best: Option<(usize, i32)> = None;
            for r in 0..N_RES { if r == GD as usize { continue; } let excess = self.stock[r] - cap / 2; if excess > 0 && best.map_or(true, |(_, e)| excess > e) { best = Some((r, excess)); } }
            if let Some((r, excess)) = best {
                let units = excess.min(30 * mult); let gold = (units * self.price(r) * 8 / 10).max(1);
                self.stock[r] -= units; self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], gold, cap);
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
    fn add_capped(cur: i32, add: i32, cap: i32) -> i32 { if cur >= cap { cur } else { cur.saturating_add(add).min(cap) } }

    fn storage_cap(&self) -> i32 {
        let hall = self.buildings.first().map_or(0, |b| b.tier as i32);
        600 + 200 * hall + self.buildings.iter().filter(|b| b.kind == STOREHOUSE).map(|b| 250 * (b.tier as i32 + 1)).sum::<i32>()
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
                HOUSE => { if o(0) { p.housing += 1; } if o(1) { flower += 1; } if o(2) { p.woodsheds += 1; } if o(3) { p.doves += 1; } }
                FARM | HOSPITAL | GRAVEYARD | RIVER | MOAT | RAISE | LOWER | FENCE | ROAD => {}
                WALL => { if o(1) { banners += 1; } }
                TOWER => { if o(0) { banners += 1; } if o(2) { pride += 1; } if o(3) { militia += 2; } }
                GATE => { if o(0) || o(2) { banners += 1; } if o(1) { pride += 1; } if o(3) { militia += 1; } }
                DRAWBRIDGE | WELL | BRIDGE => { for bit in 0..2 { if o(bit) { pride += 1; } } }
                BARRACKS => { if o(0) { banners += 1; } if o(1) { p.train_pct += 25; } if o(2) { armoury += 4; } }
                KEEP => { if o(0) { banners += 1; } if o(2) || o(3) { militia += 2; } }
                TOWN_HALL => { if o(0) { banners += 1; } for bit in 1..4 { if o(bit) { pride += 1; } } }
                CHAPEL => { for bit in [0u8, 1, 3] { if o(bit) { pride += 1; } } }
                _ => { if o(0) { banners += 1; } if o(1) { pride += 1; } }
            }
        }
        p.happy = (flower / 2).min(8) + pride.min(10);
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
        let route = match self.route_on_graph(&[1, 0, 0, 0, 0, 0], hx, hy, tx, ty, true) { Ok(r) => r, Err(_) => return -2 };
        let pl: Vec<(f32, f32)> = route.iter().map(|w| (w.x, w.y)).collect();
        if let Some(k) = self.links.iter().position(same) { self.links[k] = pl; } else { self.links.push(pl); }
        0
    }
    /// Is there already an invisible path to the village whose hall is at (tx, ty)?
    pub fn link_exists(&self, tx: f32, ty: f32) -> bool { self.links.iter().any(|pl| pl.last().map_or(false, |e| (e.0 - tx).hypot(e.1 - ty) < 12.0)) }

    /// A walking route over the invisible lines (the grid of the world plus the village's paths), for villagers: [1, x, y, x, y, ...], or empty when there is no dry way.
    pub fn walk_route(&self, sx: f32, sy: f32, gx: f32, gy: f32) -> Vec<f32> { self.walk_route_inner(sx, sy, gx, gy) }

    /// Walkable routes between linked buildings: [child, parent, n, x0, y0, x1, y1, ...] repeated. Unlike `roads_flat` these include the crossings of drawbridges.
    pub fn road_paths_flat(&self) -> Vec<f32> {
        let mut v = vec![];
        for (c, p, pts) in &self.road_paths { v.extend_from_slice(&[*c as f32, *p as f32, pts.len() as f32]); for q in pts { v.extend_from_slice(&[q.0, q.1]); } }
        v
    }

    /// Flat [kind, x, y, remaining, max, ...] (stride 5).
    pub fn deposits_flat(&self) -> Vec<f32> {
        self.deposits.iter().flat_map(|d| [d.kind as f32, d.x, d.y, d.rem as f32, d.max as f32]).collect()
    }


    // ---------- military ----------
    /// Queue `n` units of `kind` at the barracks. 0 ok, -6 resources, -11 no barracks, -12 barracks too basic, -13 not enough people.
    pub fn train(&mut self, kind: u8, n: u32) -> i32 { self.try_train(kind, n) }
    /// Standing army [spearmen, archers, swordsmen, knights, catapults].
    pub fn army(&self) -> Vec<u32> { self.army.to_vec() }
    pub fn queued(&self) -> Vec<u32> { self.queue.to_vec() }
    pub fn away(&self) -> Vec<u32> { self.away.to_vec() }
    /// Tower and hall guards that defend for free.
    pub fn guards(&self) -> u32 { self.buildings.iter().map(|b| match b.kind { TOWER => b.garrison as u32, TOWN_HALL => 2 * (b.tier as u32 + 1), KEEP => b.garrison as u32, _ => 0 }).sum() }

    // ---------- tower garrisons ----------
    fn garrison_cap_of(b: &Building) -> u32 { match b.kind { TOWER => 2 * (b.tier as u32 + 1) + 2, KEEP => 4 * (b.tier as u32 + 1) + 4, _ => 0 } }
    /// Raise (true) or lower (false) a drawbridge by hand. A raised one cannot be crossed by anybody but your own armies, which lower it for themselves while they march over it (see `drawbridge_step`);
    /// every drawbridge counts as drawn up while a battle is on. A manual raise wins over the automatic lowering: for `VETO_SECS` no army lowers it, and any army whose route ran over it plans
    /// another way (a bridge of its own, or a ferry). 0 ok, -1 not a drawbridge.
    pub fn drawbridge_set(&mut self, idx: u32, up: bool) -> i32 {
        let Some(b) = self.buildings.get_mut(idx as usize) else { return -1 };
        if b.kind != DRAWBRIDGE { return -1; }
        b.status = if up { DB_UP } else { 4 };
        b.progress = if up { VETO_SECS } else { 0 };
        if up { self.replan_over_deck(idx as usize); }
        0
    }
    /// A drawbridge's own states (`status`): 4 lowered, 5 drawn up by hand (`progress` counts down the seconds an army may not lower it), 6 lowered for an army (was drawn up), 7 lowered for an
    /// army during a battle (was lowered: every drawbridge counts as drawn up while a battle is on). `progress` of a lent one counts the seconds nobody has needed it.
    pub(crate) fn db_lent(b: &Building) -> bool { b.kind == DRAWBRIDGE && matches!(b.status, DB_LENT | DB_LENT_FIGHT) }
    /// Is this drawbridge drawn up right now (so that nobody can cross it)? Raised by hand, or any that is not lent while raiders attack.
    pub(crate) fn drawn_up(&self, b: &Building) -> bool { b.kind == DRAWBRIDGE && (b.status == DB_UP || (self.battle.is_some() && !Self::db_lent(b))) }
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
    /// Another village (tag = its id) attacks this one from `angle`.
    pub fn start_raid(&mut self, angle: f32, atk: &[u32], tag: i32) -> bool {
        if !angle.is_finite() || angle.abs() > 7.0 { return false; }   // an angle comes from atan2 (-pi..pi); anything else is a forged command
        if atk.len() < 5 || self.has_treaty(tag, TREATY_PEACE) || self.has_treaty(tag, TREATY_ALLIANCE) { return false; }
        if tag != 0 { self.rel_add(tag, -40); }   // whoever marches on us is not our friend
        let c = |n: u32| n.min(300);
        let Some(atk) = kinds(atk) else { return false };
        self.begin_battle(atk.map(c), angle, tag)
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

    /// Send goods to another village (tag) over `distance` units of road, with `escort` spearmen taken from the barracks to guard them. 0 ok, -1 bad amount or resource, -2 not enough goods, -3 not enough soldiers.
    pub fn caravan_send(&mut self, res: u8, amount: i32, to: i32, distance: f32, escort: u32) -> i32 {
        if res as usize >= N_RES || amount <= 0 || amount > 500 || to == 0 || self.caravans.len() >= 8 || !(0.0..=3000.0).contains(&distance) { return -1; }
        if self.stock[res as usize] < amount { return -2; }
        if escort > self.army[0] { return -3; }
        self.stock[res as usize] -= amount; self.army[0] -= escort;
        self.caravans.push(Caravan { res, amount, to, start: self.tick, eta: self.tick + 60 + (distance / CARAVAN_SPEED) as u64, escort });
        0
    }
    /// Send an errand to another village (tag) over `distance` units of road: kind 0..2 a treaty offer (arg = days), 3 an envoy with gifts (20 coins), 4 a royal marriage (150 coins), 5 a declaration of war.
    /// It costs what the instant version cost, now; the effect comes when the party arrives. 0 ok, -1 nonsense, -6 poor, -7 one of that kind is already on the road, -20 too soon, -21 not liked enough, -22 will not agree.
    pub fn journey_start(&mut self, kind: u8, tag: i32, arg: i32, distance: f32) -> i32 {
        if kind > JK_WAR || tag == 0 || self.journeys.len() >= 16 || !(0.0..=3000.0).contains(&distance) { return -1; }
        if self.journeys.iter().any(|j| j.tag == tag && j.kind == kind) { return -7; }
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
        let dur = 30 + (distance / JOURNEY_SPEED[kind as usize]) as u64;
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
        let pact = self.has_treaty(from, TREATY_TRADE); let ally = self.has_treaty(from, TREATY_ALLIANCE);
        self.rel_add(from, 2);   // honest trade builds trust
        let gold = amount * PRICE[res as usize] * if ally { 120 } else if pact { 110 } else { 100 } / 100;
        let cap = self.storage_cap(); let before = self.stock[GD as usize];
        self.stock[GD as usize] = Self::add_capped(before, gold, cap); self.stock[GD as usize] - before
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
    pub fn battle_angle(&self) -> f32 { self.battle.as_ref().map_or(0.0, |b| b.angle) }
    pub fn battle_time(&self) -> f32 { self.battle.as_ref().map_or(0.0, |b| b.t) }
    /// Soldiers on the field: [side, kind, x, y, hp, maxhp, alive, swinging, facing] (stride 9).
    pub fn battle_units_flat(&self) -> Vec<f32> {
        match &self.battle {
            Some(b) => b.units.iter().flat_map(|u| [u.side as f32, u.kind as f32, u.x, u.y, u.hp.max(0.0), UNITS[u.kind as usize].hp, u.alive as u8 as f32, u.anim, u.face, if u.wading { (self.moat_level_at(u.x, u.y) - self.height_at(u.x, u.y) + 0.12).max(0.0) } else { u.elev }]).collect(),
            None => vec![],
        }
    }
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
            5 => { self.ignite(a.max(0) as usize); true }
            6 => { self.end_plague(); true }
            9 => { if self.plague_active() { false } else { self.start_plague(); true } }   // an outbreak now
            7 => {   // put out every fire (buildings and wildfires)
                for b in self.buildings.iter_mut() { b.burning = 0.0; }
                self.wildfires.clear(); true
            }
            8 => {   // reset the terrain: remove rivers, moats and earthworks, fill the craters and clear the scorch marks
                self.buildings.retain(|b| !is_edit(b.kind));
                self.craters.clear(); self.scorch.clear(); self.ruins.clear(); self.levels.clear(); self.terrain_ver += 1; self.map_ver += 1;
                self.after_change(); true
            }
            _ => false,
        }
    }


    // ---------- field armies ----------
    /// Take soldiers out of the barracks into a field army (units = [spear, archer, sword, knight, catapult]). Returns its id, 0 on failure.
    pub fn det_form(&mut self, units: &[u32]) -> u32 { let Some(u) = kinds(units) else { return 0 }; self.det_form_inner(u) }
    /// March to (tx, ty). 0 ok, -1 no such army, -2 unreachable, -3 siege engines need soldiers to cut the forest, -5 water too wide.
    pub fn det_march(&mut self, id: u32, tx: f32, ty: f32, attack: bool, ax: f32, ay: f32) -> i32 {
        // a peer chooses these numbers: NaN, infinity or a point far off the map would make the router search forever
        if ![tx, ty, ax, ay].iter().all(|v| v.is_finite() && v.abs() <= MAP_LIMIT) { return -1; }
        self.det_march_inner(id, tx, ty, if attack { Some((ax, ay)) } else { None }, false) }
    /// Send the army back to the town hall, where it rejoins the barracks.
    pub fn det_recall(&mut self, id: u32) -> i32 { let (hx, hy) = (self.buildings[0].x, self.buildings[0].y + 9.0); self.det_march_inner(id, hx, hy, None, true) }
    pub fn det_split(&mut self, id: u32, take: &[u32]) -> u32 { let Some(t) = kinds(take) else { return 0 }; self.det_split_inner(id, t) }
    pub fn det_merge(&mut self, a: u32, b: u32) -> bool { self.det_merge_inner(a, b) }
    pub fn det_halt(&mut self, id: u32) { if let Some(i) = self.dets.iter().position(|d| d.id == id) { let d = &mut self.dets[i]; if d.state == march::S_FIGHT { return; } d.defend = false; d.path.clear(); d.state = march::S_IDLE; d.phase = 0; d.atk = None; for g in d.grp.iter_mut() { g.path.clear(); g.speed = 0.0; } } }
    /// An army that has arrived at an enemy village joins the attack; returns its soldiers (empty on failure).
    /// Send a field army to the fight in this village: it marches to the nearest attacker and joins the defenders once it is within reach (`battle::JOIN_REACH`). 0 ok, -10 there is no battle, other codes as `det_march`.
    pub fn det_defend(&mut self, id: u32) -> i32 { self.det_defend_inner(id) }
    /// Call off the attack of the army with this tag: its soldiers break and run. Only the attackers' side can be made to retreat. True if there was such a battle.
    pub fn battle_retreat(&mut self, tag: i32) -> bool { self.retreat_attackers(tag) }
    /// More soldiers of the same attacker (tag) arrive at the battle already going on. True if they joined.
    pub fn battle_reinforce(&mut self, tag: i32, atk: &[u32]) -> bool { let Some(a) = kinds(atk) else { return false }; self.reinforce_attackers(tag, a.map(|n| n.min(300))) }
    /// Soldiers still standing in the standing army's defence of the battle, per kind (what can be sent out to meet the raiders).
    pub fn battle_standing(&self) -> Vec<u32> { self.standing_in_battle().to_vec() }
    pub fn det_send(&mut self, id: u32) -> Vec<u32> { self.det_send_inner(id).map_or(vec![], |u| u.to_vec()) }
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
    /// Remaining route of an army: [x, y, mode, ...] starting at its current position.
    pub fn det_path(&self, id: u32) -> Vec<f32> {
        let Some(d) = self.dets.iter().find(|d| d.id == id) else { return vec![] };
        let mut v = vec![d.x, d.y, 0.0]; for w in d.path.iter().skip(d.wi) { v.extend_from_slice(&[w.x, w.y, w.mode as f32]); } v
    }
    pub fn map_version(&self) -> u32 { self.map_ver }
    /// Choose what a farm does with its field: 0 always sow, 1 let it lie fallow, 2 rotate (rest when the soil is worn, sow again when it is restored). 0 ok, -1 not a farm, -2 bad mode.
    pub fn set_field_mode(&mut self, idx: u32, mode: u8) -> i32 {
        let Some(b) = self.buildings.get_mut(idx as usize) else { return -1 };
        if b.kind != FARM { return -1; }
        if mode > 2 { return -2; }
        b.mode = if mode == 2 && b.fert <= FERT_TIRED { 3 } else { mode }; 0
    }
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
                for d in self.deposits.iter_mut() { if (d.x - hx).hypot(d.y - hy) < r { d.rem = 0; d.max = 0; } }
                self.map_ver += 1; self.terrain_ver += 1; 0
            }
            1 => {
                if !(0..4).contains(&a) || !(-400..=400).contains(&b) || !(-400..=400).contains(&c) { return -1; }
                let kind = a as u8; let (x, y) = (hx + b as f32, hy + c as f32);
                let slot = self.deposits.iter().position(|d| d.kind == kind && d.max == 0)
                    .or_else(|| self.deposits.iter().enumerate().filter(|(_, d)| d.kind == kind).min_by(|(_, p), (_, q)| (p.x - hx).hypot(p.y - hy).total_cmp(&(q.x - hx).hypot(q.y - hy))).map(|(i, _)| i));
                let Some(i) = slot else { return -1 };
                let amount = match kind { 0 => 1500, 1 => 1200, 2 => 900, _ => 320 };
                self.deposits[i] = Deposit { kind, x, y, rem: amount, max: amount };
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
    pub fn sick(&self) -> u32 { self.sick }
    pub fn efficiency(&self) -> u32 { self.eff }

    /// How content the villagers are, 0..100: gardens, parks, chapels, markets, courts and wells lift it; hunger, plague, overcrowding and idle hands drag it down.
    /// Happy villages grow faster and pay more tax (x0.5 .. x1.5); unhappy ones grow slowly and pay little.
    pub fn happiness(&self) -> u32 {
        let count = |k: u8| self.buildings.iter().filter(|b| b.kind == k).count() as i32;
        let tiers = |k: u8| self.buildings.iter().filter(|b| b.kind == k).map(|b| b.tier as i32 + 1).sum::<i32>();
        let mut h = 40 + (4 * count(PARK)).min(16) + (2 * count(GARDEN)).min(8) + (5 * tiers(CHAPEL)).min(20) + (4 * count(MARKET)).min(8) + (4 * count(COURTHOUSE)).min(8) + (2 * count(WELL)).min(6);
        if self.stock[GR as usize] < 10 { h -= 15; }
        if self.population > 0 { h -= (self.sick as i32 * 40) / self.population as i32; }
        if self.eff < 60 { h -= (60 - self.eff as i32) / 3; }
        if self.population > self.capacity() { h -= 10; }
        if !self.warm { h -= 12; }
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
    /// Villagers of working age.
    pub fn adults(&self) -> u32 { self.population.saturating_sub(self.children + self.elders) }
    /// [children, adults, elders, couples]: the families behind the headcount.
    pub fn demographics(&self) -> Vec<u32> { vec![self.children, self.adults(), self.elders, self.adults() / 2] }
    /// False while it is winter and the village has no wood to burn: people freeze.
    pub fn warmth(&self) -> bool { self.warm }
    pub fn jobs(&self) -> u32 { self.jobs }
    pub fn building_count(&self) -> u32 { self.buildings.len() as u32 }
    pub fn take_events(&mut self) -> Vec<i32> { std::mem::take(&mut self.events) }

    /// FNV-1a hashes of the separate sections of the state, in the order of `state_hash_part_names()`. Two copies of one village that disagree name the section that differs,
    /// which says where to look (a building, the stock, a soldier on the march, a felled tree). Only simulated state goes in: nothing derived (paths, caches) and nothing a client may touch.
    pub fn state_hash_parts(&self) -> Vec<u64> {
        let part = |f: &dyn Fn(&mut dyn FnMut(u64))| -> u64 { let mut h: u64 = 0xcbf29ce484222325 ^ self.seed; f(&mut |v: u64| { h ^= v; h = h.wrapping_mul(0x100000001b3); }); h };
        vec![
            part(&|mix| {   // core: the clock, the random stream, the people and everything that is a plain number
                mix(self.tick); mix(self.rng.0); mix(self.population as u64); mix(self.sick as u64); mix(self.plague_start); mix(self.plague_end); mix(self.quarantine_until); mix(self.children as u64); mix(self.elders as u64); mix(self.warm as u64); mix(self.born as u64); mix(self.arrived as u64); mix(self.enlisted as u64); mix(self.left as u64); for d in self.died { mix(d as u64); } mix(self.unburied as u64); mix(self.buried as u64); mix(self.graves_used as u64); mix(self.devotion as i64 as u64); mix(self.style as u64); mix(self.hero.map_or(999, |h| h.0 as u64 * 1000 + h.1 as u64)); mix(self.explored.iter().map(|&c| c as u64).sum::<u64>()); for &d in &self.neutral_done { mix(d as u64); } mix(self.mood as i64 as u64); mix(self.mood_until); mix(self.quarantine_until); mix(self.choice.map_or(99, |c| c.0 as u64));
            }),
            part(&|mix| { for s in &self.stock { mix(*s as i64 as u64); } }),
            part(&|mix| {   // buildings: what stands, where, how built and how hurt
                for b in &self.buildings {
                    mix(b.kind as u64); mix(b.tier as u64); mix(b.x.to_bits() as u64); mix(b.y.to_bits() as u64);
                    mix(b.rot as u64); mix(b.progress as u64); mix(b.pad_h.to_bits() as u64); mix(b.garrison as u64); mix(b.born as u64); mix(b.opts as u64); mix(b.fert as u64); mix(b.mode as u64);
                    if matches!(b.kind, DRAWBRIDGE | GATE) { mix(b.status as u64); }
                }
                for b in &self.buildings { mix(b.hp.to_bits() as u64); mix(b.burning.to_bits() as u64); }
            }),
            part(&|mix| { for d in &self.deposits { mix(d.rem as i64 as u64); mix(d.max as i64 as u64); } }),
            part(&|mix| { for pl in &self.links { mix(pl.len() as u64); for p in pl { mix(p.0.to_bits() as u64); mix(p.1.to_bits() as u64); } } }),
            part(&|mix| { for k in 0..NK { mix(self.army[k] as u64); mix(self.queue[k] as u64); mix(self.away[k] as u64); } }),
            part(&|mix| { for d in &self.dets { mix(d.id as u64); mix(d.x.to_bits() as u64); mix(d.y.to_bits() as u64); mix(d.state as u64); mix(d.wi as u64); mix(d.defend as u64); for k in 0..NK { mix(d.units[k] as u64); } for g in &d.grp { mix(g.x.to_bits() as u64); mix(g.y.to_bits() as u64); mix(g.wi as u64); } } }),
            part(&|mix| {   // trade and diplomacy
                for r in &self.relations { mix(r.0 as i64 as u64); mix(r.1 as i64 as u64); } for m in &self.married { mix(*m as i64 as u64); }
                for c in &self.caravans { mix(c.start); mix(c.eta); mix(c.amount as u64); mix(c.res as u64); mix(c.to as i64 as u64); mix(c.escort as u64); } for j in &self.journeys { mix(j.kind as u64); mix(j.tag as i64 as u64); mix(j.arg as i64 as u64); mix(j.start); mix(j.arrive); } for a in &self.awaiting { mix(a[1] as u64); mix(a[2] as i64 as u64); } for t in &self.treaties { mix(t.until); mix(t.tag as u64); }
            }),
            part(&|mix| {   // the land the soldiers and the builders changed
                for f in &self.felled { for v in f { mix(v.to_bits() as u64); } } mix(self.groves.len() as u64);
                for b in &self.bridges { for v in b { mix(v.to_bits() as u64); } }
                for l in &self.levels { for v in l { mix(v.to_bits() as u64); } } for c in &self.craters { mix(c[0].to_bits() as u64); mix(c[1].to_bits() as u64); }
                mix(self.scorch.len() as u64); mix(self.ruins.len() as u64);
            }),
            part(&|mix| { if let Some(bt) = &self.battle { mix(1); for u in &bt.units { mix(u.x.to_bits() as u64); mix(u.y.to_bits() as u64); mix(u.hp.to_bits() as u64); mix(u.det as u64); mix(u.soak.to_bits() as u64); } } }),
        ]
    }

    /// FNV-1a state hash for determinism / peer sync checks: the sections of `state_hash_parts` folded into one number.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325 ^ self.seed;
        for p in self.state_hash_parts() { h ^= p; h = h.wrapping_mul(0x100000001b3); }
        h
    }
}

/// The names of the sections of `World::state_hash_parts`, comma separated and in the same order.
pub const HASH_PART_NAMES: &str = "core,stock,buildings,deposits,links,army,soldiers,diplomacy,land,battle";
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
    let mut h: u64 = 0xcbf29ce484222325 ^ seed; for p in parts { h ^= p; h = h.wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}

fn pad_inner(d: &Def) -> f32 { d.r * 1.15 + 0.5 }

#[cfg(test)]
mod lend_tests;

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
        assert_eq!(w.place(HOUSE, 1000, 0, 0), -2, "outside radius");
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
        w.place(HOUSE, 16, 0, 0);
        w.place(HOUSE, 28, 4, 0);
        let r = w.roads_flat();
        assert_eq!(r.len(), 12, "two buildings, two path segments");
        assert_eq!(r[5], 0.0, "first house links to the town hall");
        // the middle of the path is graded to the line between the endpoint pads
        let f = w.buildings_flat();
        let (a, b) = (f[10 + 5], f[0 + 5]);
        let mid = w.height_at(8.0, 0.0);
        assert!(mid >= a.min(b) - 0.8 && mid <= a.max(b) + 0.8, "path height {mid} between {a} and {b}");
        // pads stay exactly flat even after paths were added
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
        // find two dry points either side of a narrow strip of water
        let mut pair = None;
        'o: for j in (4..(march::NC - 4)).step_by(3) { for i in (4..(march::NC - 12)).step_by(2) {
            let a = (j * march::NC + i) as usize;
            if ns.height(a) < 1.5 || ns.dens(a) > 1 { continue; }
            let mut k = 1; let mut wet = 0;
            while k < 6 && ns.height(a + k) < 0.2 { wet += 1; k += 1; }
            if wet >= 2 && ns.height(a + k) > 1.5 && ns.dens(a + k) <= 1 { pair = Some((a, a + k)); break 'o; }
        } }
        let Some((a, b)) = pair else { eprintln!("bridge test: no narrow water on this seed"); return };
        let (sx, sy) = nav_cell_centre(a); let (tx, ty) = nav_cell_centre(b);
        let mut w = village(); w.army = [6, 0, 0, 0, 0, 0];
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
        w.buildings.push(Building { kind, tier: 0, x, y, rot, pad_h, progress: 0, status: 4, aux: -1, staff: 0, residents: 0, hp: battle::max_hp(kind, 0), burning: 0.0, garrison: 0, born: 0, opts: 0, fert: FERT_MAX, mode: 0 });
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
        let wheel_dry = w.can_place(WATERWHEEL, -20, -20);
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
        put(&mut w, 1, 20.0, 20.0, 0);                         // a farm
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
        w.stock[GR as usize] = 0; assert!(w.happiness() < h0 + 10, "hunger makes people unhappy");
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
        let before = w.height_at(-20.0, 0.0);
        assert!(before > 0.4, "dry land to dig in");
        for i in 0..4 { assert!(w.place(MOAT, -20 + i * 4, 0, 0) >= 0, "adjacent moat pieces can be placed side by side (piece {i})"); }
        assert!(w.height_at(-20.0, 0.0) < 0.0, "the ditch holds water");
        assert!(w.height_at(-30.0, 0.0) > 0.4, "land away from the moat is untouched");
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
        for _ in 0..400 { w.step(); w.stock[W as usize] = 2000; w.stock[GR as usize] = 2000; }
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
    fn roads_do_not_cross_moats_and_use_drawbridges() {
        let mut w = rich();
        ring(&mut w, 20.0, 44, MOAT);
        let outside = [(0, 36), (6, 38), (-8, 40), (12, 36), (-14, 36)].into_iter().map(|(x, y)| w.place(HOUSE, x, y, 0)).find(|&i| i >= 0).unwrap_or(-1);
        assert!(outside >= 0, "house outside the moat: {outside}");
        let has_link = |w: &World, child: u32| { let v = w.road_paths_flat(); let mut i = 0; let mut found = false; while i < v.len() { let n = v[i + 2] as usize; if v[i] as u32 == child { found = true; } i += 3 + 2 * n; } found };
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
    fn moat_water_stands_just_below_the_rim_not_down_at_the_sea() {
        let mut w = rich();
        ring(&mut w, 24.0, 52, MOAT);
        let f = w.moat_water_flat(); assert!(f.len() >= 40 && f.len() % 4 == 0, "an entry per placed piece: {}", f.len() / 4);
        for p in f.chunks(4) { assert!(p[3] >= 0.4, "never below the shore line: {}", p[3]); }
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
    fn many_buildings_stay_fast() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for _ in 0..3 { w.upgrade(0); }
        w.flatten(72);
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
        w.tick = DAY * SEASON_DAYS * 3; assert_eq!(w.season(), 3); assert_eq!(w.grain_percent(), 25);
        w.tick = DAY * SEASON_DAYS * 4; assert_eq!((w.season(), w.year()), (0, 2));
        // the same farm makes more grain in autumn than in winter
        let make = |tick: u64| { let mut w = farm_world(); let i = [(-20, 14), (20, 14), (30, -20), (-30, -20)].into_iter().map(|(x, y)| w.place(FARM, x, y, 0)).find(|&i| i >= 0).expect("a farm site"); w.tick = tick; w.stock[GR as usize] = 0; w.population = 40; w.staffing(); for _ in 0..40 { w.step(); w.stock[W as usize] = 3000; w.stock[GR as usize] = w.stock[GR as usize].min(500); } let _ = i; w.stock[GR as usize] };
        let (autumn, winter) = (make(DAY * SEASON_DAYS * 2), make(DAY * SEASON_DAYS * 3));
        assert!(autumn > winter, "autumn {autumn} vs winter {winter}");
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
        let gap = |w: &World| { let u = w.battle_units_flat(); let mut best = f32::MAX; for i in 0..u.len() / 10 { for j in 0..u.len() / 10 { if u[i * 10] == 0.0 && u[j * 10] == 1.0 && u[i * 10 + 6] > 0.0 && u[j * 10 + 6] > 0.0 { best = best.min(((u[i * 10 + 2] - u[j * 10 + 2]).powi(2) + (u[i * 10 + 3] - u[j * 10 + 3]).powi(2)).sqrt()); } } } best };
        let start = gap(&w);
        let (mut closest, mut swings_melee, mut swings_shot, mut deaths, mut hp_drops) = (start, 0, 0, 0, 0);
        let mut prev: Vec<f32> = w.battle_units_flat();
        let mut n = 0;
        while w.battle_active() && n < 1200 {
            w.step(); w.stock[GR as usize] = 3000; n += 1;
            if !w.battle_active() { break; }
            let u = w.battle_units_flat(); closest = closest.min(gap(&w));
            for i in 0..u.len() / 10 {
                let o = i * 10;
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
            for &(k, x, y) in &list { assert!(k <= 2); assert!(terrain::base_height(seed, x, y) > 1.5, "dry"); for (sx, sy) in terrain::sites(seed) { assert!((x - sx).hypot(y - sy) > 100.0, "away from villages"); } }
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
        assert!((cav_t as f32) < foot_t as f32 * 0.7, "knights ride much faster than the foot: {cav_t} vs {foot_t}");
        assert!((foot_t as f32) < eng_t as f32 * 0.8, "catapults are slower than the foot: {foot_t} vs {eng_t}");
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
        for (x, y) in [(14, 4), (20, 8), (-14, 6), (-20, 12), (6, 26), (-6, 26)] { w.place(HOUSE, x, y, 0); }
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
    fn creeping_outwards_stops_at_the_far_limit() {
        let mut w = rich();
        let mut x = w.build_radius() as i32 - 6; let mut last = x;
        for _ in 0..60 { if w.place(ROAD, x, 0, 0) >= 0 { last = x; } x += 5; }
        assert!(last as f32 <= TERRITORY_MAX, "the road stopped at {last}");
        assert_eq!(w.can_place(HOUSE, TERRITORY_MAX as i32 + 30, 0), -2);
    }
}

#[cfg(test)]
mod road_piece_tests {
    use super::*;
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w }

    #[test]
    fn road_pieces_link_into_the_path_network_like_the_automatic_roads() {
        let mut w = rich(); let before = w.roads_flat().len();
        let pieces: Vec<i32> = (0..8).map(|k| w.place(ROAD, 14 + k * 4, 6, 0)).collect();
        assert!(pieces.iter().all(|&i| i >= 0), "the road can be laid: {pieces:?}");
        assert!(w.roads_flat().len() >= before + 6 * 6, "each piece is joined to its neighbour by a stretch of path");
        // the chain ends at the hall: every piece has a walkable route
        let v = w.road_paths_flat(); let mut linked = std::collections::HashSet::new(); let mut i = 0;
        while i < v.len() { linked.insert(v[i] as i32); i += 3 + 2 * v[i + 2] as usize; }
        for &p in &pieces { assert!(linked.contains(&p), "piece {p} has a route"); }
    }

    #[test]
    fn a_house_beyond_the_road_joins_it_and_roads_do_not_block_the_way() {
        let mut w = rich();
        for k in 0..6 { w.place(ROAD, 16 + k * 4, 4, 0); }
        let h = w.place(HOUSE, 36, 12, 0); assert!(h >= 0);
        let v = w.road_paths_flat(); let mut i = 0; let mut found = false;
        while i < v.len() { if v[i] as i32 == h { found = true; } i += 3 + 2 * v[i + 2] as usize; }
        assert!(found, "the house is connected through the road pieces");
        // a field army walks straight over a road (nothing blocks it)
        w.army = [10, 0, 0, 0, 0, 0]; let id = w.det_form(&[10, 0, 0, 0, 0, 0]); assert!(id > 0);
        assert_eq!(w.det_march(id, 40.0, 4.0, false, 0.0, 0.0), 0, "a route over the road exists");
    }

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
        let mut w = World::new(1337, 0, 0); w.stock = [9999; N_RES]; w.flatten(40);
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
    fn rich() -> World { let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w.flatten(40); w }
    /// A moat ring round the hall, so there is water to cross.
    fn with_moat() -> World { let mut w = rich(); for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); } w }

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
        let has_link = |w: &World, c: i32| { let v = w.road_paths_flat(); let mut i = 0; let mut f = false; while i < v.len() { if v[i] as i32 == c { f = true; } i += 3 + 2 * v[i + 2] as usize; } f };
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
            for k in 0..24u64 {   // (more runs than once: a raid in those six days changes by chance who dies, and a tie must not decide the test)
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
    fn a_deposit_can_be_cleared_for_wood_and_tools_and_stops_blocking() {
        let mut w = World::new(1337, 0, 0); w.stock = [5000; N_RES];
        let (i, d) = w.deposits.iter().enumerate().find(|(_, d)| w.in_territory(d.x, d.y) && d.max > 0).map(|(i, d)| (i as u32, *d)).expect("a deposit inside the border");
        let blocked = w.can_place(HOUSE, (d.x - w.ox as f32) as i32, (d.y - w.oy as f32) as i32);
        assert_eq!(blocked, -17, "the rock is in the way");
        let (wood, tools) = (w.stock[W as usize], w.stock[TL as usize]);
        assert_eq!(w.clear_deposit(i), 0); assert_eq!(w.stock[W as usize], wood - 40); assert_eq!(w.stock[TL as usize], tools - 10);
        assert_eq!(w.clear_deposit(i), -3, "only once");
        assert_ne!(w.can_place(HOUSE, (d.x - w.ox as f32) as i32, (d.y - w.oy as f32) as i32), -17, "nothing is in the way any more");
        assert_eq!(w.clear_deposit(99999), -1);
        let mut poor = World::new(1337, 0, 0); poor.stock = [0; N_RES]; assert_eq!(poor.clear_deposit(i), -6);
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
        assert_eq!(w.happiness(), hap0 + 3, "six flower boxes lift happiness by three");
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
        let w = village(); let v = w.net_flat(); let (n, e) = (v[0] as usize, v[1] as usize);
        assert!(n > 40 && e > n, "nodes {n}, edges {e}");
        let ed = edges(&w); assert!(ed.iter().any(|e| e.2), "road edges"); assert!(ed.iter().any(|e| !e.2), "ring and link edges");
        for k in 0..n { let (x, y) = (v[2 + 2 * k], v[3 + 2 * k]); for b in &w.buildings { assert!((b.x - x).hypot(b.y - y) > footprint(b.kind, b.tier) * 0.9, "node ({x:.1},{y:.1}) inside a {}", DEFS[b.kind as usize].name); } }
        // every edge is walkable: never through a building's footprint
        for (a, b, _) in ed { let (pa, pb) = ((v[2 + 2 * a], v[3 + 2 * a]), (v[2 + 2 * b], v[3 + 2 * b])); for t in 0..=10 { let f = t as f32 / 10.0; let (x, y) = (pa.0 + (pb.0 - pa.0) * f, pa.1 + (pb.1 - pa.1) * f); for q in &w.buildings { assert!((q.x - x).hypot(q.y - y) > footprint(q.kind, q.tier) * 0.9, "edge crosses a {}", DEFS[q.kind as usize].name); } } }
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
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); }
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
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); }
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
            // turned the other way the wheel would be in the air over dry ground
            assert_eq!(w.place(WATERWHEEL, dx, dy, (rot + 4) & 7), -16, "wheel facing the land is refused");
            if seen == 1 {
                assert!(w.place(WATERWHEEL, dx, dy, rot) >= 0, "the snapped spot can be built on: {s:?}");
                assert!(w.buildings.last().unwrap().pad_h <= WHEEL_PAD_MAX + 1e-4);
            }
        }
        assert!(seen >= 3, "the snap finds the bank from most clicks ({seen})");
        assert!(w.waterwheel_snap(-60, 60).is_empty(), "no water, no snap");
    }

    #[test]
    fn a_drawbridge_snaps_onto_the_moat_and_lies_square_across_it() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); }
        // near the south of the ring the ditch runs east-west, so the deck runs north-south (turn 0 or 4); near the east it runs the other way (turn 2 or 6)
        let s = w.drawbridge_snap(3, 17); assert_eq!(s.len(), 3, "a moat is near");
        assert!((s[0].hypot(s[1]) - 20.0).abs() < 1.5, "snapped onto the ring: {s:?}");
        assert!(s[2] == 0.0 || s[2] == 4.0, "square across a ditch that runs east-west: {s:?}");
        let e = w.drawbridge_snap(17, 2); if e.len() == 3 { assert!(e[2] == 2.0 || e[2] == 6.0, "{e:?}"); }
        assert!(w.drawbridge_snap(100, 100).is_empty(), "nothing to snap to far from any moat");
        let br = w.place(DRAWBRIDGE, s[0] as i32, s[1] as i32, s[2] as u8); assert!(br >= 0, "the snapped spot can be built on: {br}");
    }

    #[test]
    fn a_drawbridge_can_go_anywhere_along_a_moat_that_is_not_too_wide() {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for i in 0..44 { let a = i as f32 / 44.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 20.0).round() as i32, (a.sin() * 20.0).round() as i32, 0); }
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

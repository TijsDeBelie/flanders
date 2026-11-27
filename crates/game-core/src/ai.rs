//! The computer's villages for PVE games (see docs/PVE.md).
//!
//! An `Ai` is a controller that lives *outside* the `World` it plays (so snapshots, the state hash and the rules fingerprint do not change). It has no economy of its own:
//! every action is a call of the same public `World` method a signed player command would make (`place`, `upgrade`, `train`, `garrison_set`, `journey_start`,
//! `caravan_send`, `det_form`, `det_march`, ...), and when the world refuses (cannot afford, no room, no barracks, too soon) the AI waits. Its choices are a pure function of
//! its own seeded stream, the village's real numbers and the few numbers the page tells it about its target.
use crate::catalog::*;
use crate::march::{S_ARRIVED, S_BLOCKED, S_IDLE};
use crate::{terrain, wilds};
use crate::military::*;
use crate::{Rng, World, DAY, JK_ENVOY, TREATY_TRADE, TREATY_PEACE, TREATY_ALLIANCE};
use wasm_bindgen::prelude::*;

/// How often (ticks) the AI looks at its village.
const PLAN_EVERY: u64 = 10;
/// Number of demo layouts.
pub const LAYOUTS: u32 = 10;
/// Request kinds handed back to the page by `Ai::step`: [REQ_RAID, spearmen, archers, swordsmen, knights, catapults, rams].
pub const REQ_RAID: i32 = 1;

#[derive(Clone, Copy)]
struct Plot { kind: u8, dx: i32, dy: i32 }

fn polar(r: f32, deg: f32) -> (i32, i32) { let a = deg.to_radians(); ((a.cos() * r).round() as i32, (a.sin() * r).round() as i32) }

/// The names of the demo layouts.
pub const LAYOUT_NAMES: [&str; LAYOUTS as usize] = ["Ring town", "Grid town", "Crossroads", "Crescent", "Riverside street", "Citadel", "Farmstead", "Walled square", "Spiral", "Twin hamlets"];

/// The wish list of a layout: where it would like each building, nearest the hall first within a kind. Buildings that need a deposit or forest are not listed (they are found by scanning).
fn plots(layout: u32) -> Vec<Plot> {
    let mut v: Vec<Plot> = Vec::new();
    let mut add = |kind: u8, (dx, dy): (i32, i32)| v.push(Plot { kind, dx, dy });
    let ring = |r: f32, n: u32, phase: f32| -> Vec<(i32, i32)> { (0..n).map(|k| polar(r, phase + 360.0 * k as f32 / n as f32)).collect() };
    match layout % LAYOUTS {
        0 => { // ring town
            for p in ring(17.0, 7, 10.0) { add(HOUSE, p); } for p in ring(27.0, 11, 25.0) { add(HOUSE, p); } for p in ring(37.0, 13, 5.0) { add(HOUSE, p); }
            for p in ring(52.0, 7, 20.0) { add(FARM, p); } for p in ring(66.0, 9, 5.0) { add(FARM, p); }
            for p in ring(44.0, 5, 40.0) { add(TOWER, p); }
            add(WELL, (0, 11)); add(MARKET, (-12, 0)); add(CHAPEL, (12, 0)); add(BARRACKS, (0, -15)); add(STOREHOUSE, (0, 14)); add(SAWMILL_KIND, (-12, -13)); add(BLACKSMITH_KIND, (12, -13));
        }
        1 => { // grid town
            for r in 0..5 { for c in 0..5 { if (r, c) != (0, 0) { add(HOUSE, (-24 + c * 11, 12 + r * 10)); } } }
            for c in 0..4 { add(FARM, (-36 + c * 24, 66)); add(FARM, (-36 + c * 24, -34)); }
            for c in 0..3 { add(FARM, (56, -20 + c * 24)); }
            for p in [(-34, 8), (34, 8), (-34, 70), (34, 70)] { add(TOWER, p); }
            add(WELL, (0, 10)); add(MARKET, (-18, -12)); add(CHAPEL, (18, -12)); add(BARRACKS, (36, -8)); add(STOREHOUSE, (0, -14)); add(SAWMILL_KIND, (-36, -8)); add(BLACKSMITH_KIND, (-36, -22));
        }
        2 => { // crossroads
            for k in 1..=5 { let d = 10 + k * 8; for p in [(d, 9), (d, -9), (-d, 9), (-d, -9), (9, d), (-9, d), (9, -d), (-9, -d)] { add(HOUSE, p); } }
            for p in [(62, 30), (62, -30), (-62, 30), (-62, -30), (30, 62), (-30, 62), (30, -62), (-30, -62), (74, 0), (-74, 0)] { add(FARM, p); }
            for p in [(48, 48), (-48, 48), (48, -48), (-48, -48)] { add(TOWER, p); }
            add(WELL, (0, 0)); add(MARKET, (14, 14)); add(CHAPEL, (-14, 14)); add(BARRACKS, (14, -14)); add(STOREHOUSE, (-14, -14)); add(SAWMILL_KIND, (24, 24)); add(BLACKSMITH_KIND, (-24, 24));
        }
        3 => { // crescent
            for p in (0..9).map(|k| polar(18.0, 200.0 + k as f32 * 17.0)) { add(HOUSE, p); } for p in (0..12).map(|k| polar(28.0, 195.0 + k as f32 * 13.0)) { add(HOUSE, p); }
            for p in (0..14).map(|k| polar(38.0, 190.0 + k as f32 * 11.5)) { add(HOUSE, p); }
            for p in (0..8).map(|k| polar(54.0, 10.0 + k as f32 * 20.0)) { add(FARM, p); } for p in (0..6).map(|k| polar(70.0, 20.0 + k as f32 * 25.0)) { add(FARM, p); }
            for p in (0..5).map(|k| polar(48.0, 200.0 + k as f32 * 35.0)) { add(TOWER, p); }
            add(WELL, (0, -10)); add(MARKET, (6, 12)); add(CHAPEL, (-6, 14)); add(BARRACKS, (18, 0)); add(STOREHOUSE, (14, 10)); add(SAWMILL_KIND, (22, -12)); add(BLACKSMITH_KIND, (24, 8));
        }
        4 => { // riverside street: a long east-west street
            for k in 0..9 { let x = -44 + k * 11; add(HOUSE, (x, 11)); add(HOUSE, (x, -11)); }
            for k in 0..6 { let x = -40 + k * 16; add(HOUSE, (x, 24)); }
            for k in 0..7 { let x = -48 + k * 16; add(FARM, (x, 40)); } for k in 0..6 { let x = -40 + k * 16; add(FARM, (x, -36)); }
            for p in [(-56, 0), (56, 0), (-30, 30), (30, 30)] { add(TOWER, p); }
            add(WELL, (0, 0)); add(MARKET, (-12, 0)); add(CHAPEL, (12, 0)); add(BARRACKS, (0, -22)); add(STOREHOUSE, (0, 22)); add(SAWMILL_KIND, (-22, -22)); add(BLACKSMITH_KIND, (22, -22));
        }
        5 => { // citadel: dense inside a wall ring
            for p in ring(15.0, 6, 0.0) { add(HOUSE, p); } for p in ring(23.0, 9, 15.0) { add(HOUSE, p); } for p in ring(31.0, 12, 0.0) { add(HOUSE, p); }
            for p in ring(40.0, 8, 22.0) { add(TOWER, p); }
            for p in ring(45.0, 32, 0.0) { add(WALL, p); }
            for p in ring(62.0, 8, 10.0) { add(FARM, p); } for p in ring(78.0, 8, 28.0) { add(FARM, p); }
            add(WELL, (0, 10)); add(MARKET, (-9, -8)); add(CHAPEL, (9, -8)); add(BARRACKS, (0, -18)); add(STOREHOUSE, (-18, 0)); add(SAWMILL_KIND, (18, 0)); add(BLACKSMITH_KIND, (0, 18));
        }
        6 => { // farmstead: farm-heavy
            for p in ring(17.0, 6, 30.0) { add(HOUSE, p); } for p in ring(26.0, 9, 0.0) { add(HOUSE, p); }
            for p in ring(40.0, 6, 0.0) { add(FARM, p); } for p in ring(56.0, 9, 20.0) { add(FARM, p); } for p in ring(72.0, 11, 0.0) { add(FARM, p); } for p in ring(86.0, 12, 15.0) { add(FARM, p); }
            for p in ring(33.0, 4, 45.0) { add(TOWER, p); }
            add(WELL, (0, 10)); add(MARKET, (-12, 0)); add(CHAPEL, (12, 0)); add(BARRACKS, (0, -15)); add(STOREHOUSE, (0, 14)); add(SAWMILL_KIND, (-12, -13)); add(BLACKSMITH_KIND, (12, -13));
        }
        7 => { // walled square
            for r in 0..4 { for c in 0..5 { add(HOUSE, (-24 + c * 12, 12 + r * 10)); } } for c in 0..5 { add(HOUSE, (-24 + c * 12, -14)); }
            for k in 0..15 { let t = -40 + k * 5; add(WALL, (t, -40)); add(WALL, (t, 50)); } for k in 1..14 { let t = -40 + k * 7; add(WALL, (-40, t)); add(WALL, (40, t)); }
            for p in [(-38, -38), (38, -38), (-38, 48), (38, 48)] { add(TOWER, p); }
            for c in 0..5 { add(FARM, (-48 + c * 24, 72)); add(FARM, (-48 + c * 24, -64)); }
            add(WELL, (0, 4)); add(MARKET, (-26, -2)); add(CHAPEL, (26, -2)); add(BARRACKS, (0, -26)); add(STOREHOUSE, (-26, -26)); add(SAWMILL_KIND, (26, -26)); add(BLACKSMITH_KIND, (30, 12));
        }
        8 => { // spiral
            for k in 0..34 { let a = 25.0 + k as f32 * 31.0; let r = 14.0 + k as f32 * 1.35; add(HOUSE, polar(r, a)); }
            for k in 0..12 { let a = 300.0 + k as f32 * 29.0; add(FARM, polar(60.0 + (k % 3) as f32 * 14.0, a)); }
            for p in ring(45.0, 4, 70.0) { add(TOWER, p); }
            add(WELL, (0, 9)); add(MARKET, (-11, 0)); add(CHAPEL, (11, 0)); add(BARRACKS, (0, -14)); add(STOREHOUSE, (-11, -11)); add(SAWMILL_KIND, (11, -11)); add(BLACKSMITH_KIND, (-11, 12));
        }
        _ => { // twin hamlets
            for h in [-32, 32] { for r in 0..3 { for c in 0..3 { add(HOUSE, (h - 10 + c * 10, -10 + r * 10)); } } }
            for k in 0..6 { add(FARM, (-60 + k * 24, 36)); add(FARM, (-60 + k * 24, -40)); }
            for p in [(-32, -26), (32, -26), (-32, 28), (32, 28)] { add(TOWER, p); }
            add(WELL, (0, 0)); add(MARKET, (0, 14)); add(CHAPEL, (0, -14)); add(BARRACKS, (-32, 20)); add(STOREHOUSE, (32, 20)); add(SAWMILL_KIND, (-48, 0)); add(BLACKSMITH_KIND, (48, 0));
        }
    }
    // nearest first within a kind (walls keep their ring order so a wall grows round the village, not outwards)
    let mut idx: Vec<usize> = (0..v.len()).collect();
    idx.sort_by(|&a, &b| {
        let (pa, pb) = (&v[a], &v[b]);
        pa.kind.cmp(&pb.kind).then_with(|| if pa.kind == WALL { a.cmp(&b) } else { ((pa.dx * pa.dx + pa.dy * pa.dy)).cmp(&(pb.dx * pb.dx + pb.dy * pb.dy)).then(a.cmp(&b)) })
    });
    idx.into_iter().map(|i| v[i]).collect()
}

const WOODCUTTER_K: u8 = 4;
const SAWMILL_KIND: u8 = 5;
const QUARRY: u8 = 6;
const IRON_MINE_K: u8 = 9;
const CHARCOAL_KIND: u8 = 11;
const SMELTER_KIND: u8 = 12;
const BLACKSMITH_KIND: u8 = 13;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
enum Army { Idle, Marching(u32), Waiting(u64, [u32; NK]) }

#[wasm_bindgen]
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Ai {
    rng: Rng,
    layout: u32,
    tag: i32,
    /// 0 a peaceful trader, 1 balanced, 2 warlike.
    aggr: u32,
    /// Per layout plot: 0 free, 1 placed, 2 given up.
    used: Vec<u8>,
    next_build: u64,
    next_train: u64,
    next_up: u64,
    next_research: u64,
    next_envoy: u64,
    next_offer: u64,
    next_caravan: u64,
    next_raid: u64,
    scan_cool: Vec<(u8, u64)>,
    no_up: Vec<(u32, u64)>,
    army: Army,
    /// The target village: position, how far its land reaches, its tag and the length of the way there; and what we know of its strength.
    target: Option<(f32, f32, f32, i32, f32)>,
    their_force: u32,
    raids: u32,
    /// The wild places (see wilds.rs): the expedition out now (army id, the place's centre, when it set out), when to look for the next, when to look at the roads, and the shafts a road was tried to.
    wild: Option<(u32, f32, f32, u64)>,
    next_wild: u64,
    next_road: u64,
    roads_tried: Vec<u32>,
}

impl Army { fn idle(&self) -> bool { matches!(self, Army::Idle) } }

fn count(w: &World, kind: u8) -> u32 { w.buildings.iter().filter(|b| b.kind == kind && b.hp > 0.0).count() as u32 }
/// Food in the stores (everything the villagers eat, counted in grain-equivalents of the cheapest: one meal each) against the heads to feed.
fn food_stock(w: &World) -> i64 { FOODS_LIST.iter().map(|&r| w.stock[r as usize].max(0) as i64).sum() }
const FOODS_LIST: [u8; 4] = [GR, FI, BD, SF];
fn affordable(w: &World, kind: u8) -> bool { DEFS[kind as usize].cost.iter().all(|&(r, n)| w.stock[r as usize] >= n) }

#[wasm_bindgen]
impl Ai {
    /// A controller for the village with this tag: `layout` is one of the `LAYOUTS` demo layouts.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, index: u32, layout: u32, tag: i32) -> Ai {
        let mut rng = Rng(seed ^ 0xA1_5EED_0F_C0DE ^ ((index as u64 + 1) << 40) ^ ((layout as u64) << 20));
        for _ in 0..4 { rng.next(); }
        let aggr = rng.range(3);
        let used = vec![0; plots(layout).len()];
        Ai { rng, layout: layout % LAYOUTS, tag, aggr, used, next_build: 40, next_train: 0, next_up: 0, next_research: 0, next_envoy: 2 * DAY, next_offer: 6 * DAY, next_caravan: 6 * DAY, next_raid: 0, scan_cool: vec![], no_up: vec![], army: Army::Idle, target: None, their_force: 0, raids: 0, wild: None, next_wild: 4 * DAY, next_road: 0, roads_tried: vec![] }
    }

    pub fn layout_count() -> u32 { LAYOUTS }
    pub fn layout_name(i: u32) -> String { LAYOUT_NAMES[(i % LAYOUTS) as usize].to_string() }
    pub fn layout(&self) -> u32 { self.layout }
    pub fn personality(&self) -> u32 { self.aggr }
    pub fn raids(&self) -> u32 { self.raids }

    /// The page tells the AI where its enemy lives: position, how far its land reaches, its tag and the length of the road there.
    pub fn set_target(&mut self, x: f32, y: f32, radius: f32, tag: i32, distance: f32) { self.target = Some((x, y, radius, tag, distance)); }
    /// What the AI can see of the enemy's strength (soldiers at home and in towers).
    pub fn observe(&mut self, force: u32) { self.their_force = force; }

    pub fn snapshot(&self) -> Vec<u8> { bincode::serialize(self).unwrap_or_default() }
    pub fn restore(bytes: &[u8]) -> Option<Ai> { bincode::deserialize(bytes).ok() }

    /// How many soldiers the village has in all: home, in the queue, in towers and out marching.
    pub fn soldiers(&self, w: &World) -> u32 { Self::force(w) }

    /// The army's raiders came back (survivors and loot, as the battle's report gave them): they rejoin the village.
    pub fn returned(&mut self, w: &mut World, survivors: &[u32], loot: &[i32]) { w.return_army(survivors, loot); self.army = Army::Idle; self.next_raid = w.tick + self.cool(w.tick); }
    /// The attack was refused (the enemy could not be attacked now): the soldiers go home.
    pub fn refused(&mut self, w: &mut World, units: &[u32]) { w.return_refused_army(units); self.army = Army::Idle; self.next_raid = w.tick + DAY; }

    /// One tick of thought. Call after `World::step`. Returns requests for the page: [REQ_RAID, six soldier counts] when an army stands at the enemy's border and wants to attack.
    pub fn step(&mut self, w: &mut World) -> Vec<i32> {
        let mut out = vec![];
        self.army_step(w, &mut out);
        if w.tick % PLAN_EVERY != self.tag as u64 % PLAN_EVERY || w.battle.is_some() { return out; }
        self.shop(w);
        self.build(w);
        self.military(w);
        self.diplomacy(w);
        self.consider_raid(w);
        self.wild_places(w);
        out
    }
}

impl Ai {
    fn force(w: &World) -> u32 {
        let home: u32 = w.army.iter().sum::<u32>() + w.queue.iter().sum::<u32>();
        let away: u32 = w.away.iter().sum::<u32>();
        let field: u32 = w.dets.iter().map(|d| d.units.iter().sum::<u32>()).sum();
        let towers: u32 = w.buildings.iter().map(|b| b.garrison as u32).sum();
        home + away + field + towers
    }
    fn cool(&self, _tick: u64) -> u64 { match self.aggr { 2 => 4 * DAY, 1 => 7 * DAY, _ => 11 * DAY } }

    // ------------------------------------------------------------------------------------------------ building
    /// The kinds the village needs, most needed first (the layout then says where).
    fn wants(&self, w: &World) -> Vec<u8> {
        let day = w.tick / DAY; let pop = w.population; let cap = w.capacity();
        let (houses, farms) = (count(w, HOUSE), count(w, FARM));
        let heads = (pop + Self::force(w)) as i64; let stock = food_stock(w);
        let (hungry, fed) = (stock < heads * 2, stock >= heads * 4);
        let n = |k: u8| count(w, k);
        let barracks_ok = n(BARRACKS) > 0;
        let mut v: Vec<u8> = vec![];
        let mut want = |c: bool, k: u8| { if c && !v.contains(&k) { v.push(k); } };
        // growth is paced by the calendar: the village does not out-build its food or its age (a player could do the same; the computer is simply not in a hurry)
        let max_pop = 20 + day as u32 * 5 + (day as u32) * (day as u32) / 10;
        want(houses < 2, HOUSE);
        want(farms < 1, FARM);
        want(n(WOODCUTTER_K) < 1, WOODCUTTER_K);
        want(pop >= 12 && n(SAWMILL_KIND) < 1, SAWMILL_KIND);
        want(pop >= 14 && day >= 2 && !barracks_ok, BARRACKS);
        want(hungry && farms < pop / 6 + 2, FARM);
        want(cap < pop + 6 + pop / 5 && cap < max_pop + 10 && fed, HOUSE);
        want(barracks_ok && day >= 3 && n(TOWER) < 2 + (day as u32) / 3, TOWER);   // bandits come about once a week: the walls and towers matter more than comfort
        want(farms < pop / 12 + 2, FARM);
        want(pop >= 14 && n(SAWMILL_KIND) < 1 + pop / 40 + (w.stock[PL as usize] < 30) as u32, SAWMILL_KIND);
        want((n(WOODCUTTER_K) < 1 + pop / 50 || w.stock[W as usize] < 80) && n(WOODCUTTER_K) < 4, WOODCUTTER_K);
        want(pop >= 12 && n(QUARRY) < 1, QUARRY);
        want(pop >= 15 && n(WELL) < 1, WELL);
        want(pop >= 20 && n(STOREHOUSE) < 1 + pop / 60, STOREHOUSE);
        want(pop >= 16 && n(MARKET) < 1 && w.stock[PL as usize] >= 20, MARKET);
        want(pop >= 28 && n(CHAPEL) < 1, CHAPEL);
        want(pop >= 40 && day >= 12 && n(BLACKSMITH_KIND) < 1, BLACKSMITH_KIND);
        want(pop >= 45 && day >= 15 && n(IRON_MINE_K) < 1, IRON_MINE_K);
        want(pop >= 45 && day >= 15 && n(CHARCOAL_KIND) < 1, CHARCOAL_KIND);
        want(pop >= 45 && day >= 15 && n(IRON_MINE_K) > 0 && n(SMELTER_KIND) < 1, SMELTER_KIND);
        want(day >= 18 && n(TOWER) >= 3 && w.stock[ST as usize] > 90, WALL);
        want(pop + 12 > cap && cap < max_pop + 10 && fed && w.stock[W as usize] > 100, HOUSE);
        v
    }

    fn cooling(&self, kind: u8, tick: u64) -> bool { self.scan_cool.iter().any(|&(k, t)| k == kind && t > tick) }

    fn build(&mut self, w: &mut World) {
        if w.tick >= self.next_up && self.upgrades(w) { self.next_build = w.tick + 40; return; }
        if w.tick < self.next_build { return; }
        // a plot whose building was lost (burnt, razed) is free again
        if w.tick % (DAY / 4) < PLAN_EVERY {
            let list = plots(self.layout);
            for (i, p) in list.iter().enumerate() {
                if self.used[i] == 1 && !w.buildings.iter().any(|b| b.kind == p.kind && b.hp > 0.0 && (b.x - (w.ox + p.dx) as f32).abs() < 10.0 && (b.y - (w.oy + p.dy) as f32).abs() < 10.0) { self.used[i] = 0; }
            }
        }
        let mut looked = 0;
        for kind in self.wants(w) {
            if !affordable(w, kind) { if matches!(kind, HOUSE | FARM) { return; } continue; }
            // the barracks come first: until they stand, the stone and planks they need are not spent on anything else
            if count(w, BARRACKS) == 0 && kind != BARRACKS && DEFS[kind as usize].cost.iter().any(|&(r, n)| (r == ST && w.stock[ST as usize] - n < 30) || (r == PL && w.stock[PL as usize] - n < 25)) { continue; }   // saving up for houses and farms comes first
            // a layout position first (the nearest unbuilt plot of that kind), then a scan for a spot
            let list = plots(self.layout);
            let mut tried = 0;
            for (i, p) in list.iter().enumerate() {
                if p.kind != kind || self.used[i] != 0 { continue; }
                tried += 1; if tried > 3 { break; } looked += 1; if looked > 8 { return; }   // a few plots per look: the rest wait for the land to grow
                match self.try_plot(w, kind, p.dx, p.dy) {
                    Some(true) => { self.used[i] = 1; self.after_build(w); return; }
                    Some(false) => { self.used[i] = 2; }
                    None => {}
                }
            }
            if !self.cooling(kind, w.tick) {
                looked += 1; if looked > 8 { return; }
                if self.scan(w, kind) { self.after_build(w); return; }
                self.scan_cool.retain(|&(_, t)| t > w.tick); self.scan_cool.push((kind, w.tick + DAY / 4));
            }
        }
    }

    fn after_build(&mut self, w: &World) { self.next_build = w.tick + 45 + self.rng.range(60) as u64; }

    /// Try a plot and a few spots round it. Some(true) built, Some(false) given up (nothing works here), None wait (too poor, or outside the land for now).
    fn try_plot(&self, w: &mut World, kind: u8, dx: i32, dy: i32) -> Option<bool> {
        let mut outside = false;
        for (ox, oy) in [(0, 0), (3, 0), (-3, 0), (0, 3), (0, -3), (4, 4), (-4, -4), (4, -4), (-4, 4), (6, 0), (-6, 0), (0, 6), (0, -6)] {
            match w.can_place(kind, dx + ox, dy + oy) {
                0 => { let rot = if kind == WALL || kind == TOWER { 0 } else { 0 }; if w.place(kind, dx + ox, dy + oy, rot) >= 0 { return Some(true); } }
                -6 => return None,
                -2 => outside = true,
                _ => {}
            }
        }
        if outside { None } else { Some(false) }
    }

    /// Look for a spot that works round the hall, in widening rings (for buildings that need a deposit or a forest, and when the layout is used up).
    fn scan(&mut self, w: &mut World, kind: u8) -> bool {
        let start = self.rng.range(16) as f32 * 22.5;
        let mut r = 12.0f32;
        while r <= 100.0 {
            let n = ((r * 0.6).max(8.0)) as u32;
            for k in 0..n {
                let (dx, dy) = polar(r, start + 360.0 * k as f32 / n as f32);
                match w.can_place(kind, dx, dy) { 0 => { if w.place(kind, dx, dy, 0) >= 0 { return true; } } -6 => return false, _ => {} }
            }
            r += 6.0;
        }
        false
    }

    /// Upgrade something when there is plenty to spare. Returns whether one was done.
    fn upgrades(&mut self, w: &mut World) -> bool {
        self.next_up = w.tick + 15;
        let day = w.tick / DAY; let pop = w.population;
        if count(w, BARRACKS) == 0 && day < 12 { return false; }   // the barracks' stone and planks come first
        let (rich_w, rich_pl, rich_st) = (w.stock[W as usize] > 140, w.stock[PL as usize] > 50, w.stock[ST as usize] > 60);
        if !(rich_w && rich_pl || rich_st) { return false; }
        // what is worth a bigger version, and how far (a village first grows outwards, then up)
        let step = |c: bool| -> u8 { c as u8 };
        let target = |b: &crate::Building| -> u8 {
            match b.kind {
                TOWN_HALL => step(pop >= 22) + step(pop >= 45 && day >= 10) + step(pop >= 80 && day >= 25),
                HOUSE => step(day >= 6 && pop >= 20) + step(day >= 18 && pop >= 50),
                FARM => step(day >= 8) + step(day >= 24),
                BARRACKS => step(day >= 7) + step(day >= 16) + step(day >= 30),
                TOWER => step(day >= 12) + step(day >= 26),
                WALL => step(day >= 30),
                KEEP | CHAPEL | MARKET | STOREHOUSE | SAWMILL_KIND | QUARRY => step(day >= 14),
                _ => 0,
            }
        };
        let order = |k: u8| match k { TOWN_HALL => 0, FARM => 1, HOUSE => 2, BARRACKS => 3, TOWER => 4, _ => 5 };
        let mut best: Option<(u32, usize)> = None;
        for (i, b) in w.buildings.iter().enumerate() {
            if b.tier >= target(b).min(max_tier(b.kind)) || b.hp <= 0.0 || self.no_up.iter().any(|&(j, t)| j == i as u32 && t > w.tick) { continue; }
            let key = order(b.kind) * 1000 + b.tier as u32 * 100 + (i as u32).min(99);
            if best.map_or(true, |(k, _)| key < k) { best = Some((key, i)); }
        }
        let Some((_, i)) = best else { return false };
        match w.upgrade(i as u32) {
            0 => true,
            -6 => false,
            _ => { self.no_up.retain(|&(_, t)| t > w.tick); self.no_up.push((i as u32, w.tick + 3 * DAY)); false }
        }
    }

    /// Buy what the land does not give (stone where there is no quarry, tools, planks) at the market with the coin it earns, as a player may.
    fn shop(&mut self, w: &mut World) {
        if count(w, MARKET) == 0 || w.tick % (DAY / 8) >= PLAN_EVERY { return; }
        let gold = w.stock[GD as usize];
        if w.stock[ST as usize] < 70 && gold >= 120 { w.buy(ST, 20); }
        else if w.stock[PL as usize] < 40 && gold >= 120 { w.buy(PL, 20); }
        else if w.stock[TL as usize] < 4 && gold >= 90 && count(w, BARRACKS) > 0 { w.buy(TL, 1); }
    }

    // ------------------------------------------------------------------------------------------------ soldiers
    fn military(&mut self, w: &mut World) {
        let day = w.tick / DAY; let pop = w.population;
        if count(w, BARRACKS) == 0 { return; }
        // the drill-masters are always found their hands first (an unstaffed barracks never finishes a recruit)
        for i in 0..w.buildings.len() { let b = &w.buildings[i]; if b.kind == BARRACKS && b.target < 0 { let n = (DEFS[BARRACKS as usize].jobs * (b.tier as u32 + 1)) as i32; w.set_workers(i as u32, n); } }
        if w.tick >= self.next_research { self.next_research = w.tick + DAY; for id in 0..8u8 { if w.military_research(id) == 0 { break; } } }
        // man the towers with archers (one a look)
        if let Some(i) = w.buildings.iter().position(|b| matches!(b.kind, TOWER | KEEP) && b.hp > 0.0 && (b.garrison as u32) < World::garrison_cap_of(b)) {
            let cap = World::garrison_cap_of(&w.buildings[i]);
            let garrisoned: u32 = w.buildings.iter().map(|b| b.garrison as u32).sum();
            if w.army[1] >= 1 && garrisoned * 5 < Self::force(w) * 2 { let n = (w.buildings[i].garrison as u32 + 1).min(cap); w.garrison_set(i as u32, n); }
        }
        if w.tick < self.next_train { return; }
        self.next_train = w.tick + 12;
        let have = Self::force(w);
        let want = (6 + 2 * day as u32 + pop / 6 + self.aggr * 2).min(pop / 2).min(200);
        let heads = (pop + have) as i64;
        if w.queue.iter().sum::<u32>() >= 4 { return; }
        if have >= want || food_stock(w) < heads * 2 { return; }
        // a mix of what the barracks can make: archers and spearmen first, heavier troops when the stores and barracks allow
        let best = w.buildings.iter().filter(|b| b.kind == BARRACKS).map(|b| b.tier).max().unwrap_or(0);
        // siege engines: once the barracks can build them, one engine for every eight soldiers (rams first for gates, then catapults for stone), so raids can break more than timber
        let engines = w.army[4] + w.army[5] + w.queue[4] + w.queue[5];
        if day >= 12 && engines < have / 8 {
            let k = if best >= UNITS[4].tier && (w.army[5] + w.queue[5] > w.army[4] + w.queue[4]) { 4 } else if best >= UNITS[5].tier { 5 } else { 0 };
            if k >= 4 && w.stock[PL as usize] >= 60 && w.stock[W as usize] >= 60 && w.try_train(k, 1) != 0 { return; }
        }
        // a balanced army, tilted against what the last raiders brought (arrows glance off plate; spears answer riders): only what the world itself remembers is used, so a restored game plays on the same
        if let Some(k) = Self::wanted_kind(w, best) { if w.try_train(k, 1) == 0 { let _ = self.rng.range(10); return; } }
        let pick = self.rng.range(10);
        let kinds: [u8; 4] = if best >= 2 && pick < 2 { [3, 2, 0, 1] } else if best >= 1 && pick < 5 { [2, 0, 1, 3] } else if pick < 6 { [1, 0, 2, 3] } else { [0, 1, 2, 3] };
        // keep some wood and planks for building
        for k in kinds { if k == 4 || k == 5 { continue; } if UNITS[k as usize].tier > best { continue; } if w.stock[W as usize] < 40 && k != 2 && k != 3 { continue; } if k == 1 && w.stock[PL as usize] < 40 { continue; } if w.try_train(k, 1) == 0 { break; } }
    }

    /// The soldier kind this army is furthest short of, given the barracks tier and the survivors of the last raid on this village (the report keeps their kinds).
    #[cfg(test)] pub(crate) fn wanted_kind_for_tests(w: &World, best: u8) -> Option<u8> { Self::wanted_kind(w, best) }
    fn wanted_kind(w: &World, best: u8) -> Option<u8> {
        let raiders: [u32; NK] = if w.report.len() >= 6 + NK { std::array::from_fn(|k| w.report[6 + k].max(0) as u32) } else { [0; NK] };
        let (light, heavy) = (raiders[0] + raiders[1], raiders[2] + raiders[3]);
        let mut weight: [u32; 4] = match best { 0 => [5, 4, 0, 0], 1 => [4, 3, 3, 0], _ => [3, 3, 3, 2] };
        if heavy > light { weight[1] /= 2; weight[2] += 2; }
        if light > heavy { weight[1] += 2; }
        if raiders[3] >= 2 { weight[0] += 2; }
        let towers: u32 = w.buildings.iter().map(|b| b.garrison as u32).sum();
        let have: [u32; 4] = std::array::from_fn(|k| w.army[k] + w.queue[k] + if k == 1 { towers } else { 0 });
        let (total, wsum): (u32, u32) = (have.iter().sum(), weight.iter().sum());
        (0..4u8).filter(|&k| weight[k as usize] > 0 && UNITS[k as usize].tier <= best && UNITS[k as usize].cost.iter().all(|&(r, n)| w.stock[r as usize] >= n)
                && !(w.stock[W as usize] < 40 && k != 2 && k != 3) && !(k == 1 && w.stock[PL as usize] < 40))
            .max_by_key(|&k| (weight[k as usize] as i64 * (total as i64 + 1) - have[k as usize] as i64 * wsum as i64, std::cmp::Reverse(k)))
    }

    // ------------------------------------------------------------------------------------------------ diplomacy and trade
    fn diplomacy(&mut self, w: &mut World) {
        let Some((_, _, _, tag, dist)) = self.target else { return };
        let day = w.tick / DAY;
        let rel = w.relation(tag);
        if w.tick >= self.next_envoy && day >= 3 {
            self.next_envoy = w.tick + (3 + self.rng.range(4) as u64) * DAY;
            let hostile = rel < -20 || (self.aggr == 2 && rel < 10);
            if !hostile && w.stock[GD as usize] >= 40 { w.journey_start(JK_ENVOY, tag, 0, dist); }
        }
        // an offer of a trade pact once its friendship allows it, and not again for ten days whatever the answer
        if rel >= 20 && !w.has_treaty(tag, TREATY_TRADE) && w.tick >= self.next_offer { self.next_offer = w.tick + 10 * DAY; w.journey_start(TREATY_TRADE, tag, 30, dist); }
        // surplus goods to a trading partner
        if w.tick >= self.next_caravan && w.has_treaty(tag, TREATY_TRADE) && rel >= 10 {
            self.next_caravan = w.tick + (5 + self.rng.range(5) as u64) * DAY;
            let reserve = w.estate.grain.max(120) + 100;
            if w.stock[GR as usize] > reserve + 120 { let amount = ((w.stock[GR as usize] - reserve) / 3).clamp(20, 200); w.caravan_send(GR, amount, tag, dist, 0); }
            else if w.stock[ST as usize] > 220 { w.caravan_send(ST, 60, tag, dist, 0); }
        }
    }

    // ------------------------------------------------------------------------------------------------ raids
    fn consider_raid(&mut self, w: &mut World) {
        let Some((tx, ty, tr, tag, _)) = self.target else { return };
        if !self.army.idle() || w.battle.is_some() || w.tick < self.next_raid { return; }
        let day = w.tick / DAY;
        let first = [26u64, 16, 10][self.aggr as usize];
        if day < first || w.has_treaty(tag, TREATY_PEACE) || w.has_treaty(tag, TREATY_ALLIANCE) { return; }
        let revenge = w.relation(tag) < -30;
        let stay = (Self::force(w) / 4).max(3);                     // a quarter stays home
        let ready: u32 = w.army[..4].iter().sum();   // the engines do not count as men: they go along with whatever marches
        if ready <= stay { return; }
        let send = ready - stay;
        let need = (self.their_force * [14, 10, 7][self.aggr as usize] / 10).max(6 + self.aggr * 2) / if revenge { 2 } else { 1 };
        if send < need { return; }
        // the raiders: three quarters of the men in the barracks, with every siege engine it has
        let mut units = [0u32; NK];
        for k in 0..NK { units[k] = if k >= 4 { w.army[k] } else { w.army[k] * send / ready.max(1) }; }
        if units[..4].iter().sum::<u32>() == 0 { return; }
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        let (dx, dy) = (hx - tx, hy - ty); let dl = (dx * dx + dy * dy).sqrt().max(1.0);
        let stand = tr + 12.0;
        let (px, py) = (tx + dx / dl * stand, ty + dy / dl * stand);
        let id = w.det_form_inner(units);
        if id == 0 { self.next_raid = w.tick + DAY / 2; return; }
        if w.det_march_inner(id, px, py, Some((tx, ty)), false) != 0 {
            self.disband(w, id);
            self.next_raid = w.tick + DAY; return;   // no way through: the men go back to the barracks and it tries again another day
        }
        self.army = Army::Marching(id); self.raids += 1; let _ = &mut self.rng;
    }

    // ------------------------------------------------------------------------------------------------ wild places
    /// The computer uses the wild places as a player would (only through the same `World` calls): tithes to the abbeys it has met, small parties to meet the monks
    /// and loot the ruins, a garrison for a mineshaft, a band to clear a camp it is clearly strong enough for, and a road out to every shaft it holds.
    fn wild_places(&mut self, w: &mut World) {
        let day = w.tick / DAY;
        w.wilds.fit(w.seed);
        // the monks: a tithe when their healing is due and someone is sick, or to keep their herbs coming
        let places = terrain::neutrals(w.seed);
        for (i, n) in places.iter().enumerate() {
            if n.0 != 0 || !w.neutral_done.get(i).copied().unwrap_or(false) { continue; }
            let p = w.wilds.places[i];
            if w.tick < p.sacked_until { continue; }
            let want = (w.sick > 0 && w.tick >= p.next_heal) || p.goodwill < wilds::HERBAL_GOODWILL + 5;
            if want && w.stock[GD as usize] >= w.tithe_cost() + 80 { w.wild_act(1, i as u32); break; }
        }
        if w.tick >= self.next_road { self.next_road = w.tick + 2 * DAY; self.roads_to_shafts(w); }
        // an expedition out: it goes in when it stands at the place, and then marches home
        if let Some((id, tx, ty, since)) = self.wild {
            let Some(d) = w.dets.iter().find(|d| d.id == id) else { self.wild = None; return };
            let (st, near) = (d.state, (d.x - tx).hypot(d.y - ty) < 14.0);
            if (st == S_IDLE || st == S_ARRIVED) && near {
                let _ = w.visit_neutral(id);
                if w.dets.iter().any(|d| d.id == id) { let _ = w.det_recall(id); }
                self.wild = None; self.next_wild = w.tick + 2 * DAY;
            } else if st == S_BLOCKED || st == S_IDLE || w.tick > since + 12 * DAY {
                if w.det_recall(id) != 0 { self.disband(w, id); }
                self.wild = None; self.next_wild = w.tick + DAY;
            }
            return;
        }
        if day < 4 || w.tick < self.next_wild || w.battle.is_some() || !self.army.idle() { return; }
        self.next_wild = w.tick + DAY;
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        let stay = (Self::force(w) / 4).max(3);
        let foot: u32 = w.army[..4].iter().sum();
        if foot <= stay { return; }
        let spare = foot - stay;
        const REACH_AI: f32 = 420.0;
        let near = |x: f32, y: f32| (x - hx).hypot(y - hy);
        // what to go for, cheapest first: monks to meet and ruins to loot (three spearmen), a shaft to hold (a garrison and two to walk home), a camp to clear (a strong band)
        let mut goal: Option<(f32, f32, [u32; NK])> = None;
        let small = |w: &World| -> Option<[u32; NK]> { let mut u = [0u32; NK]; let mut left = 3u32; for k in 0..4 { let n = w.army[k].min(left); u[k] = n; left -= n; } (left == 0).then_some(u) };
        let mut first: Vec<(f32, usize)> = places.iter().enumerate().filter(|(i, n)| (n.0 == 0 || n.0 == 1) && !w.neutral_done[*i] && near(n.1, n.2) < REACH_AI && !(n.0 == 0 && w.tick < w.wilds.places[*i].sacked_until)).map(|(i, n)| (near(n.1, n.2), i)).collect();
        first.sort_by(|a, b| a.0.total_cmp(&b.0));
        if let Some(&(_, i)) = first.first() { if let Some(u) = small(w) { goal = Some((places[i].1, places[i].2, u)); } }
        if goal.is_none() && day >= 8 && spare >= wilds::GARRISON_MAX + 2 && (w.wilds.shafts.iter().filter(|s| s.garrison.iter().sum::<u32>() > 0).count() as u32) < 1 + day as u32 / 20 {
            let shafts = terrain::mineshafts(w.seed);
            let mut free: Vec<(f32, usize)> = shafts.iter().enumerate().filter(|(j, m)| w.wilds.shafts[*j].garrison.iter().sum::<u32>() == 0 && near(m.1, m.2) < REACH_AI && w.nearest_outlaws(m.1, m.2) > wilds::OUTLAW_REACH * 0.5).map(|(j, m)| (near(m.1, m.2), j)).collect();
            free.sort_by(|a, b| a.0.total_cmp(&b.0));
            if let Some(&(_, j)) = free.first() {
                let mut u = [0u32; NK]; let mut left = wilds::GARRISON_MAX + 2;
                for k in 0..4 { let n = w.army[k].min(left); u[k] = n; left -= n; }
                if left == 0 { goal = Some((shafts[j].1, shafts[j].2, u)); }
            }
        }
        if goal.is_none() && day >= [16u64, 13, 10][self.aggr as usize] {
            // the strongest band it can spare, against the weakest camp in reach that it beats by a margin
            let mut u = [0u32; NK]; for k in 0..4 { u[k] = w.army[k] * spare / foot.max(1); }
            let power: f32 = (0..NK).map(|k| u[k] as f32 * UNITS[k].hp * UNITS[k].dmg / UNITS[k].cd.max(0.5)).sum();
            let mut camps: Vec<(f32, usize)> = places.iter().enumerate().filter(|(i, n)| n.0 == 2 && !w.neutral_done[*i] && near(n.1, n.2) < REACH_AI && w.camp_terms(*i).0 * 1.25 <= power).map(|(i, n)| (near(n.1, n.2), i)).collect();
            camps.sort_by(|a, b| a.0.total_cmp(&b.0));
            if let Some(&(_, i)) = camps.first() { goal = Some((places[i].1, places[i].2, u)); }
        }
        let Some((tx, ty, units)) = goal else { return };
        let (dx, dy) = (hx - tx, hy - ty); let dl = dx.hypot(dy).max(1.0);
        let (px, py) = (tx + dx / dl * 11.0, ty + dy / dl * 11.0);
        let id = w.det_form_inner(units); if id == 0 { return; }
        if w.det_march_inner(id, px, py, None, false) != 0 { self.disband(w, id); self.next_wild = w.tick + 2 * DAY; return; }
        self.wild = Some((id, tx, ty, w.tick));
    }

    /// A road from the castle's gate out to every shaft it holds that has none yet (once per shaft: a road that cannot be laid all the way is not tried again).
    fn roads_to_shafts(&mut self, w: &mut World) {
        let shafts = terrain::mineshafts(w.seed);
        for (j, m) in shafts.iter().enumerate() {
            if w.wilds.shafts[j].garrison.iter().sum::<u32>() == 0 || self.roads_tried.contains(&(j as u32)) || w.shaft_road(m.1, m.2) { continue; }
            let plan = w.shaft_road_plan(j as u32);
            if plan.is_empty() { self.roads_tried.push(j as u32); continue; }
            if w.stock[W as usize] < World::road_plan_cost(&plan) + 40 { continue; }   // (not yet: it waits for the wood)
            self.roads_tried.push(j as u32);
            let _ = w.lay_road_plan(&plan);
            break;   // one road at a time
        }
    }

    /// A field army that cannot get anywhere is dissolved: its men go back to the barracks.
    fn disband(&mut self, w: &mut World, id: u32) { if let Some(u) = w.det_send_inner(id) { w.return_refused_army(&u); } }

    fn army_step(&mut self, w: &mut World, out: &mut Vec<i32>) {
        match self.army {
            Army::Marching(id) => {
                let Some(d) = w.dets.iter().find(|d| d.id == id) else { self.army = Army::Idle; return };
                if d.state == S_ARRIVED {
                    if let Some(u) = w.det_send_inner(id) {
                        out.push(REQ_RAID); out.extend(u.iter().map(|&n| n as i32));
                        self.army = Army::Waiting(w.tick, u);
                    }
                } else if d.state == S_BLOCKED && w.tick % (DAY / 2) == 0 {
                    self.disband(w, id); self.army = Army::Idle; self.next_raid = w.tick + DAY;
                }
            }
            Army::Waiting(since, units) => {
                // the page answers within a tick or two; if it never does, the soldiers go home
                if w.tick > since + DAY { w.return_refused_army(&units); self.army = Army::Idle; self.next_raid = w.tick + DAY; }
            }
            Army::Idle => {}
        }
    }
}

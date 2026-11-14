//! Deterministic medieval village simulation core. Same seed + same commands => same state on every peer.
use wasm_bindgen::prelude::*;

mod battle;
mod catalog;
mod march;
mod military;
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
}

/// A moat piece's width: its rotation value (0..7) widens the ditch from 1x to 1.9x, so a moat can be thin in places and broad in others.
pub fn moat_scale(b: &Building) -> f32 { 1.0 + 0.13 * (b.rot & 7) as f32 }

/// Walls, fences, gates and moat pieces are not on the village path network.
fn is_barrier(kind: u8) -> bool { matches!(kind, WALL | FENCE | GATE) || is_edit(kind) }
const LEVEL_BLEND: f32 = 9.0;  // how far a levelled patch of ground blends back into the land
const MOAT_FLOOR: f32 = 2.4; // flat bottom radius of a moat piece
const MOAT_BANK: f32 = 6.0;  // where its banks meet the land
const MOAT_BED: f32 = -1.4;
const RIVER_BED: f32 = -0.7; // a river is shallower than a moat  // depth of the bottom
const ROAD_INNER: f32 = 1.5; // fully graded half-width of a path
const ROAD_OUTER: f32 = 4.4; // terrain blends back to the natural slope by here

const RADIUS_CAP: f32 = 72.0;

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
/// Grain harvest by season in percent: spring sowing, summer growth, a big autumn harvest, a barren winter.
const GRAIN_BY_SEASON: [i32; 4] = [100, 125, 150, 25];
/// What a unit of each resource is worth in gold coins (a merchant pays 80% of it).
const PRICE: [i32; N_RES] = [1, 2, 2, 1, 3, 2, 5, 6, 1, 2, 1, 6];

/// Goods on their way to another village (`to` is that village's tag), arriving at tick `eta`.
#[derive(Clone)]
pub struct Caravan { res: u8, amount: i32, to: i32, eta: u64, escort: u32 }
/// An agreement with another village: `kind` 0 trade pact (better prices), 1 non-aggression (neither side may start a battle against the other), until tick `until`.
#[derive(Clone)]
pub struct Treaty { tag: i32, kind: u8, until: u64 }
pub const TREATY_TRADE: u8 = 0;
pub const TREATY_PEACE: u8 = 1;
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
    choice: Option<(u8, u64)>,   // a decision waiting for the player: kind and the tick it is made for them
    mood: i32,                   // temporary lift (or drag) on happiness from the last decision
    mood_until: u64,
    share_until: u64,            // winter: everyone huddles together, firewood lasts twice as long
    quarantine_until: u64,       // while quarantined, plague kills fewer and heals faster but the sick do no work
    caravans: Vec<Caravan>,   // goods on the road to another village
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
    army: [u32; 5],
    queue: [u32; 5],
    train_prog: u32,
    away: [u32; 5],
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
    bridges: Vec<[f32; 4]>,      // bridges built over water [ax, ay, bx, by]
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

#[wasm_bindgen]
pub fn village_sites(seed: u64) -> Vec<f32> { terrain::sites(seed).into_iter().flat_map(|(x, y)| [x, y]).collect() }

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
            buildings: vec![], deposits: terrain::deposits(seed), stock: [0; N_RES], population: 10, sick: 0, children: 3, elders: 0, neutral_done: vec![], explored: vec![0; (FOG_N * FOG_N) as usize], choice: None, mood: 0, mood_until: 0, quarantine_until: 0, share_until: 0, caravans: vec![], treaties: vec![], warm: true, eff: 100, jobs: 0,
            events: vec![], sites: terrain::sites(seed), flow: [0; N_RES], levels: vec![], roads: vec![], road_links: vec![], road_paths: vec![], road_cache: Default::default(),
            army: [0; 5], queue: [0; 5], train_prog: 0, away: [0; 5], battle: None, wildfires: vec![], craters: vec![], scorch: vec![], ruins: vec![], shots: vec![], terrain_ver: 0, report: vec![], report_seq: 0, dets: vec![], next_det: 0, felled: vec![], bridges: vec![], map_ver: 0,
        };
        w.stock[W as usize] = 160;
        w.stock[PL as usize] = 20;
        w.stock[ST as usize] = 70;
        w.stock[GR as usize] = 120;
        w.stock[TL as usize] = 6;
        w.stock[GD as usize] = 30;
        let (x, y) = (ox as f32, oy as f32);
        let pad_h = w.base(x, y);
        w.buildings.push(Building { kind: TOWN_HALL, tier: 0, x, y, rot: 0, pad_h, progress: 0, status: 4, aux: -1, staff: 0, residents: 0, hp: battle::max_hp(TOWN_HALL, 0), burning: 0.0, garrison: 0, born: 0, opts: 0 });
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
            0 => { self.sick = 0; self.mood = 12; self.mood_until = self.tick + 15 * DAY; }
            1 => { for (r, base) in [(ST, 120), (IR, 20), (GD, 80), (PL, 60)] { let n = (base as f32 * (0.6 + h)) as i32; self.stock[r as usize] = Self::add_capped(self.stock[r as usize], n, cap); } }
            _ => {
                let power: f32 = (0..5).map(|k| units[k] as f32 * UNITS[k].hp * UNITS[k].dmg / UNITS[k].cd.max(0.5)).sum();
                let camp = 9000.0 + 14000.0 * h;
                if power >= camp { self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], 120, cap); self.stock[IR as usize] = Self::add_capped(self.stock[IR as usize], 15, cap); }
                else { for k in 0..5 { self.dets[di].units[k] /= 2; } if self.dets[di].units.iter().all(|&u| u == 0) { self.dets.remove(di); } return kind as i32 + 100; }   // beaten: not marked done, it can be tried again
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
        let ends: Vec<usize> = (0..n).filter(|&i| i == 0 || !(is_barrier(self.buildings[i].kind) || self.buildings[i].kind == DRAWBRIDGE)).collect();
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
            mix(q.kind as u64); mix(q.x.to_bits() as u64); mix(q.y.to_bits() as u64); mix(q.rot as u64); if q.kind == DRAWBRIDGE { mix(q.status as u64); }
        }
        for l in &self.levels { if l[0] + l[2] + LEVEL_BLEND > x0 && l[0] - l[2] - LEVEL_BLEND < x1 && l[1] + l[2] + LEVEL_BLEND > y0 && l[1] - l[2] - LEVEL_BLEND < y1 { mix(l[0].to_bits() as u64); mix(l[1].to_bits() as u64); mix(l[2].to_bits() as u64); mix(l[3].to_bits() as u64); } }
        for c in &self.craters { if c[0] > x0 && c[0] < x1 && c[1] > y0 && c[1] < y1 { mix(c[0].to_bits() as u64); mix(c[1].to_bits() as u64); } }
        mix(self.battle.is_some() as u64);
        h
    }

    /// Recompute derived data after the building list or tiers changed.
    fn after_change(&mut self) {
        self.rebuild_roads();
        self.staffing();
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
        let (cx, cy) = (self.buildings[0].x, self.buildings[0].y); let rr = (r as f32).clamp(10.0, 90.0);
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
            for b in self.buildings.iter().filter(|b| is_edit(b.kind)) {
                let (dx, dy) = (x - b.x, y - b.y);
                let (floor, bank) = if b.kind == MOAT { (MOAT_FLOOR * moat_scale(b), MOAT_BANK * moat_scale(b)) } else { (1.2, 5.0) };
                if dx.abs() > bank || dy.abs() > bank { continue; }
                let dist = (dx * dx + dy * dy).sqrt();
                if dist >= bank { continue; }
                let w = 1.0 - smoothstep(floor, bank, dist);
                match b.kind {
                    MOAT => { if h > MOAT_BED { h += (MOAT_BED - h) * w; } }
                    RIVER => { if h > RIVER_BED { h += (RIVER_BED - h) * w; } }
                    RAISE => h += 2.2 * w,
                    _ => h -= 2.2 * w,
                }
            }
        }
        // the earth at each end of a drawbridge is levelled to the deck (after the ditch is dug, so the water stays between them)
        for b in self.buildings.iter().filter(|b| b.kind == DRAWBRIDGE) {
            if (x - b.x).abs() > 14.0 || (y - b.y).abs() > 14.0 { continue; }
            let a = (b.rot & 7) as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            for e in [-1.0f32, 1.0] {
                let (cx, cy) = (b.x + sx * 8.4 * e, b.y + sy * 8.4 * e);
                let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                if d < 6.6 { h = lerp(h, b.pad_h, 1.0 - smoothstep(3.0, 6.6, d)); }
            }
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
        ((22.0 + 5.0 * (w as f32).sqrt()).min(RADIUS_CAP)) as u32
    }

    /// -17 a deposit is in the way, -16 needs water.
    /// 0 = ok, otherwise: -1 bad kind, -2 outside radius, -3 overlaps, -4 water, -5 too steep,
    /// -6 cannot afford, -7 needs deposit, -8 needs forest, -9 not buildable (town hall)
    pub fn can_place(&self, kind: u8, dx: i32, dy: i32) -> i32 {
        let Some(d) = DEFS.get(kind as usize) else { return -1 };
        if kind == TOWN_HALL { return -9; }
        let (x, y) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        let r = self.build_radius() as f32;
        if (dx as f32).powi(2) + (dy as f32).powi(2) > r * r { return -2; }
        for b in &self.buildings {
            let bd = &DEFS[b.kind as usize];
            if (kind == DRAWBRIDGE && matches!(b.kind, MOAT | RIVER)) || (matches!(kind, MOAT | RIVER) && b.kind == DRAWBRIDGE) { continue; }   // a drawbridge spans the water
            if is_edit(kind) && is_edit(b.kind) && kind != b.kind { continue; }                                                               // raise, lower, dig: different edits can share a spot
            if (b.x - x).powi(2) + (b.y - y).powi(2) < (bd.r + d.r - 0.4).powi(2) { return -3; }
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
            let clear = if is_edit(kind) { 2.6 } else { d.r + 1.6 };
            if self.deposits.iter().any(|dep| dep.rem > 0 && (dep.x - x).powi(2) + (dep.y - y).powi(2) < clear * clear) { return -17; }
        }
        if d.req == 1 && self.nearest_deposit(x, y, d.req_arg).is_none() { return -7; }
        if d.req == 2 && terrain::forest_near(self.seed, x, y, 12.0) < 0.12 { return -8; }
        if d.req == 3 && !self.water_near(x, y, d.r + 5.0) { return -16; }
        for &(res, n) in d.cost { if self.stock[res as usize] < n { return -6; } }
        0
    }

    /// Is there open water (a lake, river, the sea or a moat) within `r` of the point?
    fn water_near(&self, x: f32, y: f32, r: f32) -> bool {
        for k in 0..16 { let a = k as f32 * std::f32::consts::TAU / 16.0; for rr in [r * 0.6, r] { if self.height_at(x + a.cos() * rr, y + a.sin() * rr) < 0.1 { return true; } } }
        false
    }

    /// Woodcutters slowly clear the forest round them, so the clearing (and the village) grows.
    fn clear_trees(&mut self, bx: f32, by: f32) {
        if self.rng.range(4) != 0 || self.felled.len() >= 500 { return; }
        let a = self.rng.range(628) as f32 * 0.01; let dist = 5.0 + self.rng.range(120) as f32 * 0.1;
        let (x, y) = (bx + a.cos() * dist, by + a.sin() * dist);
        if terrain::forest_near(self.seed, x, y, 2.5) < 0.12 || self.height_at(x, y) < 0.6 { return; }
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
        let code = self.can_place(kind, dx, dy);
        if code != 0 { return code; }
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
        if kind == DRAWBRIDGE {   // the deck lies at the height of the gate, and both banks are levelled to it, so it floats clear above the water
            let gate = self.buildings.iter().filter(|b| b.kind == GATE).map(|b| (((b.x - x).powi(2) + (b.y - y).powi(2)).sqrt(), b.pad_h)).fold(None, |best: Option<(f32, f32)>, c| if best.map_or(true, |b| c.0 < b.0) { Some(c) } else { best });
            let bank = |sx: f32, sy: f32| self.height_at(x + sx * 9.0, y + sy * 9.0);
            let a = (rot & 7) as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            pad_h = match gate { Some((d, h)) if d < 30.0 => h, _ => bank(sx, sy).max(bank(-sx, -sy)).max(0.8) };
        }
        let aux = if d.req == 1 { self.nearest_deposit(x, y, d.req_arg).map_or(-1, |i| i as i32) } else { -1 };
        let status = if d.cycle > 0 { 1 } else { 4 };
        self.buildings.push(Building { kind, tier: 0, x, y, rot: rot & 7, pad_h, progress: 0, status, aux, staff: 0, residents: 0, hp: battle::max_hp(kind, 0), burning: 0.0, garrison: 0, born: self.tick as u32, opts: 0 });
        if is_edit(kind) { self.terrain_ver += 1; }   // the ground changed: everything standing on it must be re-fitted
        if kind == DRAWBRIDGE {   // clear a way through the trees on the far side so a path can run out from the gate
            let a = (rot & 7) as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
            for k in [9.0f32, 14.0, 19.0] { if self.felled.len() < 500 { self.felled.push([x + sx * k, y + sy * k, 5.0]); } }
            self.map_ver += 1;
        }
        self.after_change();
        (self.buildings.len() - 1) as i32
    }

    /// 0 ok, -1 invalid, -6 cannot afford, -10 max tier
    pub fn upgrade(&mut self, idx: u32) -> i32 {
        let Some(b) = self.buildings.get(idx as usize) else { return -1 };
        if b.tier >= max_tier(b.kind) { return -10; }
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

    /// Switch one optional design upgrade of a building on (or off again, without refund). 0 ok, -1 invalid, -6 cannot afford, -10 not available yet (needs a better tier).
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
            let mut p = self.buildings[i].progress + self.eff;
            let mult = 4 + 5 * tier as i32;   // better buildings employ more people and make more: x1, x2.25, x3.5, x4.75
            let scale = |n: i32| ((n * mult + 2) / 4).max(n);
            let season = self.season();
            let yield_of = |r: u8, n: i32| { let q = scale(n); if r == GR { (q * GRAIN_BY_SEASON[season as usize] / 100).max(1) } else { q } };
            let mut status = self.buildings[i].status;
            while p >= need {
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
            if self.population < cap_pop && self.rng.range(if hap >= 70 { 4 } else if hap < 30 { 8 } else { 5 }) == 0 { self.population += 1; }
        } else {
            self.stock[GR as usize] = 0;
            if self.population > 2 && self.rng.range(3) == 0 {
                self.population -= 1;
                self.push_event(EV_STARVE, 1, 0);
            }
        }
        // overcrowding pressure if capacity shrank (demolished houses)
        let cap_pop = self.capacity();
        if self.population > cap_pop { self.population -= 1; }

        // tax
        if self.tick % 10 == 0 { self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], ((self.population as i32 / 10).max(1) * (50 + self.happiness() as i32) / 100).max(1), cap); }

        // seasons, warmth and the generations
        self.household_step();

        // disease
        let wells = self.buildings.iter().filter(|b| b.kind == WELL).count() as u32;
        let parks = self.buildings.iter().filter(|b| b.kind == PARK).count() as u32;
        let chapels: u32 = self.buildings.iter().filter(|b| b.kind == CHAPEL).map(|b| b.tier as u32 + 1).sum();
        if self.sick > 0 {
            let q = self.tick < self.quarantine_until;
            let heal = (1 + chapels) * if q { 2 } else { 1 };
            let dead = (self.sick / if q { 10 } else { 5 }).min(self.population).saturating_sub(chapels.min(self.sick / 5));
            self.population = self.population.saturating_sub(dead);
            self.sick = (self.sick - dead.min(self.sick)).saturating_sub(heal);
            if self.sick == 0 { self.push_event(EV_PLAGUE_END, 0, 0); }
        } else if self.population > 15 && self.rng.range((450 + 200 * wells + 400 * chapels + 150 * parks) / if self.warm { 1 } else { 2 }) == 0 {
            self.sick = self.population / 8 + 1;
            self.push_event(EV_PLAGUE, self.sick as i32, 0);
            self.offer(CH_PLAGUE);
        }
        self.sick = self.sick.min(self.population);

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
        self.builders_step();
        self.trade_step();
        self.caravan_step();
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
    /// Plague: 0 quarantine the sick (they stop working for 5 days; fewer die, more are healed), 1 carry on.
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
            (CH_PLAGUE, 0) => { self.quarantine_until = now + 5 * day; }
            (CH_PREACHER, 0) => { self.mood = 10; self.mood_until = now + 10 * day; }
            (CH_NOBLE, 0) => { let cap = self.storage_cap(); self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], 90, cap); self.mood = 8; self.mood_until = now + 6 * day; }
            (CH_WINTER, 0) => { let cap = self.storage_cap(); self.stock[W as usize] = Self::add_capped(self.stock[W as usize], 80, cap); }
            (CH_WINTER, 1) => { self.mood = -4; self.mood_until = now + 10 * day; self.warm = true; self.stock[W as usize] += 0; self.share_until = now + 10 * day; }
            _ => {}
        }
        self.choice = None; self.push_event(EV_CHOSE, kind as i32, opt as i32); 0
    }

    /// Fires in winter, and once a day the generations turn: children grow up, the old pass away, couples have babies.
    fn household_step(&mut self) {
        // winter: every ten ticks the village burns firewood, a tenth of a unit a head
        if self.season() == 3 {
            if self.tick % 10 == 0 {
                let need = ((self.population + 9) / 10) as i32 / if self.tick < self.share_until { 2 } else { 1 };
                if self.stock[W as usize] >= need { self.stock[W as usize] -= need; self.warm = true; } else { self.stock[W as usize] = 0; self.warm = false; }
            }
        } else { self.warm = true; }
        if self.tick % DAY != 0 { return; }
        let now = self.tick; self.treaties.retain(|t| t.until > now);
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
            if self.elders > 0 { self.elders -= 1; } else if self.children > 0 { self.children -= 1; }
            self.population -= 1; self.push_event(EV_COLD, 1, 0);
        }
        let grown = take(&mut self.rng, self.children, 30); self.children -= grown;
        let adults = self.adults(); let aged = take(&mut self.rng, adults, 90); self.elders += aged;
        let died = take(&mut self.rng, self.elders, 25).min(self.population.saturating_sub(2));
        self.elders -= died.min(self.elders); self.population -= died;
        if self.stock[GR as usize] >= 10 && self.happiness() >= 40 && self.population < self.capacity() {
            let couples = self.adults() / 2; let room = self.capacity() - self.population;
            let born = take(&mut self.rng, couples, 14).min(room);
            self.population += born; self.children += born;
        }
        self.staffing();
    }

    /// Net change of each resource during the last tick (production minus consumption; purchases excluded).
    pub fn flows(&self) -> Vec<i32> { self.flow.to_vec() }

    fn push_event(&mut self, kind: i32, a: i32, b: i32) {
        self.events.extend_from_slice(&[kind, a, b, self.tick as i32]);
    }

    /// Caravans on the road can be waylaid: with no escort one in a few hundred ticks is robbed; each spearman guarding it cuts that risk.
    fn caravan_step(&mut self) {
        let mut lost = vec![];
        for (i, c) in self.caravans.iter().enumerate() { if c.eta > self.tick && self.tick % 10 == 0 && self.rng.range(300 + 120 * c.escort) == 0 { lost.push(i); } }
        for &i in lost.iter().rev() { let c = self.caravans.remove(i); self.push_event(EV_ROBBED, c.amount, c.res as i32); }
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
        self.buildings.iter().map(|b| DEFS[b.kind as usize].housing * (b.tier as u32 + 1)).sum()
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
    /// Raise (true) or lower (false) a drawbridge. A raised one cannot be crossed; every drawbridge is drawn up while a battle is on. 0 ok, -1 not a drawbridge.
    pub fn drawbridge_set(&mut self, idx: u32, up: bool) -> i32 {
        let Some(b) = self.buildings.get_mut(idx as usize) else { return -1 };
        if b.kind != DRAWBRIDGE { return -1; }
        b.status = if up { 5 } else { 4 };
        0
    }
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
        if counts.len() < 5 || self.battle.is_some() { return false; }
        for k in 0..5 { if counts[k] > self.army[k] { return false; } }
        for k in 0..5 { self.army[k] -= counts[k]; self.away[k] += counts[k]; }
        true
    }
    /// Survivors come home with loot.
    pub fn return_army(&mut self, survivors: &[u32], loot: &[i32]) {
        for k in 0..5.min(survivors.len()) { self.army[k] += survivors[k]; }
        self.away = [0; 5];
        let cap = self.storage_cap();
        for r in 0..N_RES.min(loot.len()) { self.stock[r] = Self::add_capped(self.stock[r], loot[r], cap); }
    }
    /// Another village (tag = its id) attacks this one from `angle`.
    pub fn start_raid(&mut self, angle: f32, atk: &[u32], tag: i32) -> bool {
        if atk.len() < 5 || self.has_treaty(tag, TREATY_PEACE) { return false; }
        let c = |n: u32| n.min(300);
        self.begin_battle([c(atk[0]), c(atk[1]), c(atk[2]), c(atk[3]), c(atk[4])], angle, tag)
    }
    // ---------- trade and treaties ----------
    /// Agree something with another village (tag) for `days` days. kind 0 trade pact, 1 non-aggression. Replaces an older agreement of the same kind.
    pub fn treaty_set(&mut self, tag: i32, kind: u8, days: u32) -> bool {
        if kind > 1 || tag == 0 || days == 0 || days > 120 { return false; }
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
        self.caravans.push(Caravan { res, amount, to, eta: self.tick + 60 + (distance / CARAVAN_SPEED) as u64, escort });
        0
    }
    /// Goods on the road: [resource, amount, to, ticks left, escort] each.
    pub fn caravans_flat(&self) -> Vec<i32> { self.caravans.iter().flat_map(|c| [c.res as i32, c.amount, c.to, (c.eta.saturating_sub(self.tick)) as i32, c.escort as i32]).collect() }
    /// Caravans that reached their destination since the last call, removed from the road: [resource, amount, to] each. The sender tells the receiving village (see `receive_goods`).
    pub fn take_delivered(&mut self) -> Vec<i32> {
        let mut out = vec![]; let now = self.tick;
        let mut rest = vec![];
        for c in std::mem::take(&mut self.caravans) { if c.eta <= now { out.extend_from_slice(&[c.res as i32, c.amount, c.to]); self.army[0] += c.escort; } else { rest.push(c); } }
        self.caravans = rest; out
    }
    /// Goods arrive from another village's caravan: they go into the stores (up to what fits), and the sender is owed their worth, which we pay in coin at our own price when we can. Returns the coins paid.
    pub fn receive_goods(&mut self, res: u8, amount: i32) -> i32 {
        if res as usize >= N_RES || amount <= 0 { return 0; }
        let cap = self.storage_cap(); let room = (cap - self.stock[res as usize]).max(0); let take = amount.min(room);
        let pact = self.treaties.iter().any(|t| t.kind == TREATY_TRADE && t.until > self.tick);
        let worth = take * self.price_x100(res as usize) / 100 * if pact { 110 } else { 100 } / 100;
        let pay = worth.min(self.stock[GD as usize]);
        self.stock[res as usize] += take; self.stock[GD as usize] -= pay; pay
    }

    pub fn battle_active(&self) -> bool { self.battle.is_some() }
    /// Who is attacking: 0 bandits, otherwise the attacking player's tag.
    pub fn battle_tag(&self) -> i32 { self.battle.as_ref().map_or(0, |b| b.tag) }
    pub fn battle_time(&self) -> f32 { self.battle.as_ref().map_or(0.0, |b| b.t) }
    /// Soldiers on the field: [side, kind, x, y, hp, maxhp, alive, swinging, facing] (stride 9).
    pub fn battle_units_flat(&self) -> Vec<f32> {
        match &self.battle {
            Some(b) => b.units.iter().flat_map(|u| [u.side as f32, u.kind as f32, u.x, u.y, u.hp.max(0.0), UNITS[u.kind as usize].hp, u.alive as u8 as f32, u.anim, u.face, u.elev]).collect(),
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
            1 => { let cap = self.capacity().max(2); self.population = ((self.population as i32).saturating_add(a).max(2) as u32).min(cap); self.staffing(); true }
            2 => { if a >= 0 && a < 5 { self.army[a as usize] = ((self.army[a as usize] as i32).saturating_add(b).clamp(0, 100_000)) as u32; true } else { false } }
            3 => { let cap = self.storage_cap(); for r in 0..N_RES { self.stock[r] = cap; } true }
            4 => { let f = self.bandit_force(b.clamp(0, 1000) as f32 / 1000.0); self.begin_battle(f, a as f32 * 0.01, 0) }
            5 => { self.ignite(a.max(0) as usize); true }
            6 => { self.sick = 0; true }
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
    pub fn det_form(&mut self, units: &[u32]) -> u32 { if units.len() < 5 { return 0; } self.det_form_arr([units[0], units[1], units[2], units[3], units[4]]) }
    fn det_form_arr(&mut self, u: [u32; 5]) -> u32 { self.det_form_inner(u) }
    /// March to (tx, ty). 0 ok, -1 no such army, -2 unreachable, -3 siege engines need soldiers to cut the forest, -5 water too wide.
    pub fn det_march(&mut self, id: u32, tx: f32, ty: f32, attack: bool, ax: f32, ay: f32) -> i32 { self.det_march_inner(id, tx, ty, if attack { Some((ax, ay)) } else { None }, false) }
    /// Send the army back to the town hall, where it rejoins the barracks.
    pub fn det_recall(&mut self, id: u32) -> i32 { let (hx, hy) = (self.buildings[0].x, self.buildings[0].y + 9.0); self.det_march_inner(id, hx, hy, None, true) }
    pub fn det_split(&mut self, id: u32, take: &[u32]) -> u32 { if take.len() < 5 { return 0; } self.det_split_inner(id, [take[0], take[1], take[2], take[3], take[4]]) }
    pub fn det_merge(&mut self, a: u32, b: u32) -> bool { self.det_merge_inner(a, b) }
    pub fn det_halt(&mut self, id: u32) { if let Some(i) = self.dets.iter().position(|d| d.id == id) { let d = &mut self.dets[i]; d.path.clear(); d.state = march::S_IDLE; d.phase = 0; d.atk = None; } }
    /// An army that has arrived at an enemy village joins the attack; returns its soldiers (empty on failure).
    pub fn det_send(&mut self, id: u32) -> Vec<u32> { self.det_send_inner(id).map_or(vec![], |u| u.to_vec()) }
    /// [id, x, y, spear, archer, sword, knight, catapult, state, legMode, legsLeft, workProgress, atkX, atkY, heading, speed] (stride 16)
    pub fn det_flat(&self) -> Vec<f32> {
        self.dets.iter().flat_map(|d| {
            let mode = d.path.get(d.wi).map_or(0.0, |w| w.mode as f32);
            let prog = if d.work_total > 0.0 && d.phase == 1 { (d.work / d.work_total).min(1.0) } else { 0.0 };
            let (ax, ay) = d.atk.unwrap_or((0.0, 0.0));
            [d.id as f32, d.x, d.y, d.units[0] as f32, d.units[1] as f32, d.units[2] as f32, d.units[3] as f32, d.units[4] as f32, d.state as f32, mode, (d.path.len().saturating_sub(d.wi)) as f32, prog, ax, ay, d.heading, d.speed]
        }).collect()
    }
    /// Remaining route of an army: [x, y, mode, ...] starting at its current position.
    pub fn det_path(&self, id: u32) -> Vec<f32> {
        let Some(d) = self.dets.iter().find(|d| d.id == id) else { return vec![] };
        let mut v = vec![d.x, d.y, 0.0]; for w in d.path.iter().skip(d.wi) { v.extend_from_slice(&[w.x, w.y, w.mode as f32]); } v
    }
    pub fn map_version(&self) -> u32 { self.map_ver }
    pub fn felled_flat(&self) -> Vec<f32> { self.felled.iter().flatten().copied().collect() }
    pub fn bridges_flat(&self) -> Vec<f32> { self.bridges.iter().flatten().copied().collect() }
    /// Plan a route without ordering it: [ok(1) | error code, seconds, planks, wood, count, x, y, mode, ...].
    pub fn plan_march(&self, units: &[u32], sx: f32, sy: f32, tx: f32, ty: f32) -> Vec<f32> { if units.len() < 5 { return vec![-1.0]; } self.plan(&[units[0], units[1], units[2], units[3], units[4]], sx, sy, tx, ty) }


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

    /// FNV-1a state hash for determinism / peer sync checks.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325 ^ self.seed;
        let mut mix = |v: u64| { h ^= v; h = h.wrapping_mul(0x100000001b3); };
        mix(self.tick); mix(self.population as u64); mix(self.sick as u64); mix(self.children as u64); mix(self.elders as u64); mix(self.warm as u64); mix(self.explored.iter().map(|&c| c as u64).sum::<u64>()); for &d in &self.neutral_done { mix(d as u64); } mix(self.mood as i64 as u64); mix(self.mood_until); mix(self.quarantine_until); mix(self.choice.map_or(99, |c| c.0 as u64)); for c in &self.caravans { mix(c.eta); mix(c.amount as u64); } for t in &self.treaties { mix(t.until); mix(t.tag as u64); }
        for s in &self.stock { mix(*s as i64 as u64); }
        for b in &self.buildings {
            mix(b.kind as u64); mix(b.tier as u64); mix(b.x.to_bits() as u64); mix(b.y.to_bits() as u64);
            mix(b.rot as u64); mix(b.progress as u64); mix(b.pad_h.to_bits() as u64); mix(b.garrison as u64); mix(b.born as u64); mix(b.opts as u64);
        }
        for d in &self.deposits { mix(d.rem as i64 as u64); }
        for k in 0..5 { mix(self.army[k] as u64); mix(self.queue[k] as u64); mix(self.away[k] as u64); }
        for b in &self.buildings { mix(b.hp.to_bits() as u64); mix(b.burning.to_bits() as u64); }
        for d in &self.dets { mix(d.id as u64); mix(d.x.to_bits() as u64); mix(d.y.to_bits() as u64); mix(d.state as u64); mix(d.wi as u64); for k in 0..5 { mix(d.units[k] as u64); } }
        mix(self.felled.len() as u64); mix(self.bridges.len() as u64);
        mix(self.levels.len() as u64); mix(self.craters.len() as u64); mix(self.scorch.len() as u64); mix(self.ruins.len() as u64);
        if let Some(bt) = &self.battle { for u in &bt.units { mix(u.x.to_bits() as u64); mix(u.y.to_bits() as u64); mix(u.hp.to_bits() as u64); } }
        h
    }
}

fn pad_inner(d: &Def) -> f32 { d.r * 1.15 + 0.5 }

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
        assert!(w.start_raid(0.5, &[14, 6, 3, 0, 0], 0));
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
        w.army = [14, 10, 8, 4, 0];
        w.population = 40;
        assert!(w.start_raid(1.2, &[6, 2, 0, 0, 0], 0));
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
        w.start_raid(0.0, &[0, 0, 0, 0, 4], 0);
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
        w.army = [10, 0, 0, 0, 0];
        let id = w.det_form(&[10, 0, 0, 0, 0]);
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
        w.army = [8, 0, 0, 0, 2];
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        // a patch of dense forest away from the village that the siege train can reach by cutting trees
        let mut spot = None;
        for i in 0..(march::NC * march::NC) as usize {
            let (x, y) = nav_cell_centre(i);
            if ns.dens(i) >= 4 && ns.height(i) > 2.0 && x.abs() < 150.0 && y.abs() < 150.0 && x.hypot(y) > 70.0 && (x - 300.0).hypot(y) > 70.0 {
                let p = w.plan_march(&[8, 0, 0, 0, 2], hx, hy, x, y);
                if p[0] == 1.0 && p[5..].chunks(3).any(|c| c.len() == 3 && c[2] == 1.0) { spot = Some((x, y)); break; }
            }
        }
        let (tx, ty) = spot.expect("the map has dense forest");
        let id = w.det_form(&[8, 0, 0, 0, 2]);
        let r = w.det_march(id, tx, ty, false, 0.0, 0.0);
        assert_eq!(r, 0, "a route exists, by cutting trees");
        let p = w.det_path(id);
        assert!(p.chunks(3).any(|c| c[2] == 1.0), "the route includes a stretch of felling");
        for _ in 0..1500 { w.step(); w.stock[GR as usize] = 3000; }
        assert!(!w.felled_flat().is_empty(), "soldiers cut trees");
        assert_eq!(w.det_flat()[8] as u8, march::S_IDLE, "the siege train arrived");
        // without soldiers, catapults cannot clear the forest
        let mut w2 = village(); w2.army = [0, 0, 0, 0, 2];
        let id2 = w2.det_form(&[0, 0, 0, 0, 2]);
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
        let mut w = village(); w.army = [6, 0, 0, 0, 0];
        let id = w.det_form(&[6, 0, 0, 0, 0]);
        // move the army next to the water, then order the crossing
        w.dets[0].x = sx; w.dets[0].y = sy;
        let plan = w.plan_march(&[6, 0, 0, 0, 0], sx, sy, tx, ty);
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
            w.army = [6, 0, 0, 0, 1];
            let id = w.det_form(&[6, 0, 0, 0, 1]);
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
        w.buildings.push(Building { kind, tier: 0, x, y, rot, pad_h, progress: 0, status: 4, aux: -1, staff: 0, residents: 0, hp: battle::max_hp(kind, 0), burning: 0.0, garrison: 0, born: 0, opts: 0 });
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
        w.army = [4, 6, 4, 0, 0];
        w.begin_battle([6, 0, 0, 0, 0], 0.0, 0);     // attackers come from the east, where the wall is
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
        w.begin_battle([6, 0, 0, 0, 0], 0.0, 0);
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
    fn attackers_bridge_a_moat_after_working_at_it() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [3000; N_RES]; w.population = 20;
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        let n = 40; for i in 0..n { let a = i as f32 / n as f32 * std::f32::consts::TAU; put(&mut w, MOAT, hx + a.cos() * 18.0, hy + a.sin() * 18.0, 0); }
        w.begin_battle([6, 0, 0, 0, 0], 0.0, 0);
        let mut bridged = false;
        for _ in 0..200 { w.step(); if let Some(b) = w.battle.as_ref() { if !b.bridges.is_empty() { bridged = true; break; } } else { break; } }
        assert!(bridged, "with time, attackers bridge the moat");
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
        assert_eq!(w.plan_march(&[5, 0, 0, 0, 0], hx, hy, hx + 40.0, hy)[0], -2.0, "a closed wall ring traps the army");
        ring(&mut w, Some(0), true);
        assert_eq!(w.plan_march(&[5, 0, 0, 0, 0], hx, hy, hx + 40.0, hy)[0], 1.0, "a gate lets it out");
        // a moat ring needs a bridge (water leg); a drawbridge makes the way free
        w.buildings.truncate(1);
        for i in 0..40 { let a = i as f32 / 40.0 * std::f32::consts::TAU; put(&mut w, MOAT, hx + a.cos() * 14.0, hy + a.sin() * 14.0, 0); }
        let p = w.plan_march(&[5, 0, 0, 0, 0], hx, hy, hx + 40.0, hy);
        assert_eq!(p[0], 1.0); assert!(p[2] > 0.0 || p[3] > 0.0, "crossing a moat costs planks or boats");
        put(&mut w, DRAWBRIDGE, hx + 14.0, hy, 2);
        let q = w.plan_march(&[5, 0, 0, 0, 0], hx, hy, hx + 40.0, hy);
        assert_eq!(q[0], 1.0); assert_eq!(q[2] + q[3], 0.0, "the drawbridge spares the planks");
        let di = w.buildings.len() as u32 - 1; assert_eq!(w.drawbridge_set(di, true), 0);
        let up = w.plan_march(&[5, 0, 0, 0, 0], hx, hy, hx + 40.0, hy); assert!(up[2] + up[3] > 0.0, "a raised drawbridge cannot be crossed");
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
        let run = || { let mut w = village(); w.population = 25; w.start_raid(2.0, &[10, 5, 2, 1, 1], 7); for _ in 0..200 { w.step(); w.stock[GR as usize] = 3000; } w.state_hash() };
        assert_eq!(run(), run());
    }

    #[test]
    fn ore_chain_produces_tools_and_gold() {
        let mut w = World::new(1337, 0, 0);
        w.stock = [2000; N_RES];
        w.population = 400; // plenty of workers
        // find any legal spots near each required deposit for the chain
        let mut place_near = |w: &mut World, kind: u8| -> bool {
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
        for e in [-1.0f32, 1.0] { let y = 24.0 + 8.4 * e; assert!((w.height_at(0.0, y) - bh).abs() < 0.1, "bank at {y}: {} vs {bh}", w.height_at(0.0, y)); }
        assert!(w.height_at(0.0, 24.0) < 0.2, "water between the banks");
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
        // limits
        assert_eq!(sender.caravan_send(IR, 9999, 7, 10.0, 0), -1); assert_eq!(sender.caravan_send(IR, 40, 7, 10.0, 99), -3);
        sender.stock[IR as usize] = 5; assert_eq!(sender.caravan_send(IR, 40, 7, 10.0, 0), -2);
    }

    #[test]
    fn escorts_come_home_and_robbers_take_unescorted_goods_sometimes() {
        let mut w = rich(); w.army[0] = 10;
        assert_eq!(w.caravan_send(W, 20, 3, 60.0, 4), 0); assert_eq!(w.army[0], 6);
        for _ in 0..300 { w.step(); w.stock[GR as usize] = 300; w.stock[W as usize] = 300; }
        let _ = w.take_delivered(); assert_eq!(w.army[0], 10, "the escort returned");
        // many unescorted caravans: some are lost on the road
        let mut lost = 0;
        for k in 0..40 { let mut w = rich(); w.rng = Rng(k as u64 * 7919 + 1); w.caravan_send(W, 20, 3, 400.0, 0); for _ in 0..400 { w.step(); w.stock[GR as usize] = 300; } if w.take_delivered().is_empty() { lost += 1; } }
        assert!(lost > 0 && lost < 40, "{lost} of 40 caravans were robbed");
    }

    #[test]
    fn treaties_stop_wars_and_improve_prices() {
        let mut w = rich();
        assert!(w.start_raid(0.5, &[3, 0, 0, 0, 0], 9), "no treaty: the raid starts");
        let mut w = rich();
        assert!(w.treaty_set(9, TREATY_PEACE, 10)); assert!(w.has_treaty(9, TREATY_PEACE));
        assert!(!w.start_raid(0.5, &[3, 0, 0, 0, 0], 9), "a peace treaty stops their attack");
        assert!(w.start_raid(0.5, &[3, 0, 0, 0, 0], 8), "but not someone else's");
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
            w.army = [14, 10, 8, 4, 0]; w.population = 40;
            assert!(w.start_raid(1.2, &[10, 3, 0, 0, 0], 0));
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
        let mut w = village(); w.army = [14, 10, 8, 4, 0]; w.population = 40; w.rng = Rng(99);
        assert!(w.start_raid(0.4, &[12, 0, 0, 0, 0], 5));
        let mut n = 0; while w.battle_active() && n < 600 { w.step(); w.stock[GR as usize] = 3000; n += 1; }
        let r = w.last_report(); let l = r.len();
        let survivors: i32 = r[6..11].iter().sum();
        assert!(survivors >= r[l - 2], "fled attackers {} are among the survivors {survivors}", r[l - 2]);
    }
}

#[cfg(test)]
mod neutral_tests {
    use super::*;
    fn world() -> World { let mut w = World::new(1337, 0, 0); w.stock = [100; N_RES]; w.army = [40, 20, 20, 10, 0]; w }
    fn army_at(w: &mut World, x: f32, y: f32, units: [u32; 5]) -> u32 { w.army = units; let id = w.det_form(&units); let i = w.dets.iter().position(|d| d.id == id).unwrap(); w.dets[i].x = x; w.dets[i].y = y; id }
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
        let id = w.det_form(&[10, 0, 0, 0, 0]); assert!(id > 0);
        assert_eq!(w.det_march(id, 90.0, 0.0, false, 0.0, 0.0), 0);
        for _ in 0..80 { w.step(); w.stock[GR as usize] = 500; }
        assert!(seen(&w) > start, "the army saw new ground: {} > {start}", seen(&w));
    }

    #[test]
    fn abbeys_heal_castles_pay_camps_fight_and_each_place_is_used_once() {
        let seed = 1337;
        let (ai, ax, ay) = first_of(seed, 0).expect("an abbey");
        let mut w = world(); w.sick = 12; let id = army_at(&mut w, ax, ay, [5, 0, 0, 0, 0]);
        assert_eq!(w.visit_neutral(id), 0); assert_eq!(w.sick(), 0, "the sick are healed"); assert!(w.neutral_done[ai]);
        assert_eq!(w.visit_neutral(id), -3, "an abbey is used once");
        let (_, cx, cy) = first_of(seed, 1).expect("a ruin");
        let mut w = world(); let id = army_at(&mut w, cx, cy, [5, 0, 0, 0, 0]); let gold = w.stock[GD as usize];
        assert_eq!(w.visit_neutral(id), 1); assert!(w.stock[GD as usize] > gold, "the hoard");
        let (_, bx, by) = first_of(seed, 2).expect("a camp");
        let mut w = world(); let weak = army_at(&mut w, bx, by, [2, 0, 0, 0, 0]);
        assert_eq!(w.visit_neutral(weak), 102, "a weak party is beaten"); assert!(w.dets.iter().all(|d| d.units[0] <= 1), "and loses half its men");
        let mut w = world(); let strong = army_at(&mut w, bx, by, [60, 30, 30, 20, 0]); let gold = w.stock[GD as usize];
        assert_eq!(w.visit_neutral(strong), 2); assert!(w.stock[GD as usize] > gold, "the cleared camp pays");
        let mut w = world(); let far = army_at(&mut w, 0.0, 0.0, [5, 0, 0, 0, 0]);
        assert_eq!(w.visit_neutral(far), -2, "nothing near the village"); assert_eq!(w.visit_neutral(999), -1);
    }

    #[test]
    fn visiting_a_place_reveals_it() {
        let (_, ax, ay) = first_of(1337, 0).unwrap(); let mut w = world();
        let before = w.neutrals_flat().len(); let id = army_at(&mut w, ax, ay, [5, 0, 0, 0, 0]); w.visit_neutral(id);
        assert!(w.neutrals_flat().len() > before || w.is_seen(ax, ay));
    }
}

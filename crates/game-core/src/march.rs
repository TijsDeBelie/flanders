//! Field armies: detachments that march across the map. Pathfinding goes around buildings, cliffs, water and (for siege
//! engines) dense forest. Soldiers fell trees to open a way for catapults, build bridges over narrow water and ferry
//! themselves across wide water. All of it is deterministic, so every peer sees the same march.
use super::*;
use crate::military::*;
use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};
use std::rc::Rc;

#[path = "march_formation.rs"]
mod formation;

pub const CELL: f32 = 2.5;
pub const NC: i32 = 960; // cells per side, covering [-1200, 1200)
const ORG: f32 = -1200.0;
const MAX_FERRY: f32 = 64.0;
const BRIDGE_MAX: f32 = 16.0;
const FIELD_BRIDGE_LIMIT: usize = 60;
/// How much longer than the shortest way a siege engine's wider road may be (see `route_with_water`).
const SIEGE_DETOUR: f32 = 1.35;
/// How much longer the way over existing bridges may be than one that bridges or ferries water, before the army bridges (see `find_path_uncached`).
const DRY_DETOUR: f32 = 1.5;

fn crossing_cost(len: f32, bridges: usize, soldiers: u32) -> (bool, usize, i32) {
    if len <= BRIDGE_MAX && bridges < FIELD_BRIDGE_LIMIT { (true, PL as usize, (len * 1.5).ceil() as i32) }
    else { (false, W as usize, 10 + soldiers as i32 / 3) }
}

pub const S_IDLE: u8 = 0;
pub const S_MARCH: u8 = 1;
pub const S_FELL: u8 = 2;
pub const S_BRIDGE: u8 = 3;
pub const S_FERRY: u8 = 4;
pub const S_ARRIVED: u8 = 5;
pub const S_WAIT: u8 = 6;
pub const S_HOME: u8 = 7;
pub const S_FIGHT: u8 = 8;   // its soldiers are in the battle (see battle::det_join)
pub const S_BLOCKED: u8 = 9;
pub const S_FORMATION: u8 = 10;
pub(crate) const ROUTE_PENDING: i32 = -11;

#[derive(PartialEq, Eq)]
enum Leg { Clear, WaitingForDeck, Blocked }

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaterTravel { Dry, ExistingDecks, Build, BridgeShortcut }

const HOME_MARCH_SPEED: f32 = 1.35;
const ARMY_ROAD_SPEED: f32 = pathnet::ROAD_SPEED + 0.4;

/// A waypoint; `mode` describes the leg that ends here: 0 walk, 1 fell trees, 2 cross water.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct Wp { pub x: f32, pub y: f32, pub mode: u8 }

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
struct FilePoint { wp: Wp, dist: f32 }

fn file_position(path: &[FilePoint], distance: f32) -> Option<(f32, f32)> {
    let first = path.first()?;
    let i = path.partition_point(|p| p.dist < distance);
    if i == 0 { return Some((first.wp.x, first.wp.y)); }
    let a = path[i - 1];
    let b = path.get(i).copied().unwrap_or(a);
    let t = if b.dist > a.dist { (distance - a.dist) / (b.dist - a.dist) } else { 0.0 };
    Some((lerp(a.wp.x, b.wp.x, t), lerp(a.wp.y, b.wp.y, t)))
}

/// A verified track shared by the soldiers in a file. Each soldier has a dispatch distance based on its place in line.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct MarchFile {
    points: Vec<FilePoint>,
    approaches: Vec<Vec<FilePoint>>,
    pub(crate) dispatch: f32,
    #[serde(skip)] checked_stamp: Option<u64>,
}

impl MarchFile {
    fn approach(path: Vec<(f32, f32)>) -> Vec<FilePoint> {
        let length = path.windows(2).map(|p| (p[0].0 - p[1].0).hypot(p[0].1 - p[1].1)).sum::<f32>();
        let mut distance = -length;
        let mut previous = path[0];
        let last = path.len() - 1;
        path.into_iter().enumerate().map(|(i, (x, y))| {
            distance += (x - previous.0).hypot(y - previous.1);
            previous = (x, y);
            FilePoint { wp: Wp { x, y, mode: 0 }, dist: if i == last { 0.0 } else { distance } }
        }).collect()
    }

    fn record(&mut self, x: f32, y: f32, mode: u8) {
        let wp = Wp { x, y, mode };
        let dist = match self.points.last() {
            None => 0.0,
            Some(p) => {
                let step = (x - p.wp.x).hypot(y - p.wp.y);
                if step < 1e-4 { return; }
                p.dist + step
            }
        };
        self.points.push(FilePoint { wp, dist });
        self.dispatch = self.dispatch.max(dist);
    }

    fn gap(units: &[u32; NK]) -> f32 {
        if units[4] + units[5] > 0 { SIEGE_SPACING + 0.4 } else if units[3] > 0 { 1.9 } else { 1.05 }
    }

    fn formation_spacing(units: &[u32; NK]) -> f32 {
        match units[4] + units[5] {
            0 if units[3] > 0 => 1.8,
            0 => 1.25,
            engines if engines == units.iter().sum::<u32>() => SIEGE_SPACING,
            _ => 2.6,
        }
    }

    fn lag(units: &[u32; NK]) -> f32 { units.iter().sum::<u32>().saturating_sub(1) as f32 * Self::gap(units) }

    fn assign_approaches(&mut self, approaches: Vec<Vec<FilePoint>>, units: &[u32; NK]) {
        let gap = Self::gap(units);
        self.dispatch = approaches.iter().enumerate().filter_map(|(rank, p)| p.first().map(|p| p.dist + rank as f32 * gap))
            .fold(0.0, f32::min);
        self.approaches = approaches;
        self.checked_stamp = None;
    }

    fn release(&mut self, speed: f32) -> bool {
        if self.dispatch >= 0.0 { return true; }
        self.dispatch = (self.dispatch + speed).min(0.0);
        false
    }

    fn finish(&mut self, units: &[u32; NK], speed: f32) -> bool {
        let end = self.points.last().map_or(0.0, |p| p.dist);
        self.dispatch = (self.dispatch + speed).min(end + Self::lag(units));
        self.dispatch >= end + Self::lag(units)
    }

    pub(crate) fn in_flight(&self, units: &[u32; NK]) -> bool {
        self.dispatch < 0.0 || self.points.last().is_some_and(|p| p.dist > 0.0 && self.dispatch < p.dist + Self::lag(units))
    }

    fn trim(&mut self, units: &[u32; NK]) {
        if self.dispatch >= Self::lag(units) + 16.0 { self.approaches.clear(); }
        let behind = self.dispatch - Self::lag(units) - 32.0; // retain several steps for rendering between ticks
        let cut = self.points.partition_point(|p| p.dist < behind).saturating_sub(1);
        if cut > 0 { self.points.drain(..cut); }
    }

    pub(crate) fn near_deck(&self, units: &[u32; NK], on: impl Fn(f32, f32) -> bool) -> bool {
        let behind = self.dispatch - Self::lag(units);
        self.points.iter().rev().take_while(|p| p.dist >= behind - 9.0).any(|p| p.wp.mode != 2 && on(p.wp.x, p.wp.y))
    }

    pub(crate) fn write_flat(&self, id: u32, kind: u8, units: &[u32; NK], out: &mut Vec<f32>) {
        if self.points.is_empty() { return; }
        out.extend([id as f32, kind as f32, self.dispatch, Self::gap(units), self.points.len() as f32]);
        for p in &self.points { out.extend([p.wp.x, p.wp.y, p.wp.mode as f32, p.dist]); }
    }

    pub(crate) fn mustered(&self) -> bool { self.points.len() == 1 && !self.approaches.is_empty() }
    /// Where each soldier of an army that has spread out stands: the first point of their approach, by rank.
    pub(crate) fn slots(&self) -> Vec<(f32, f32)> { self.approaches.iter().filter_map(|p| p.first()).map(|p| (p.wp.x, p.wp.y)).collect() }

    pub(crate) fn write_approaches(&self, id: u32, kind: u8, out: &mut Vec<f32>) {
        let mut anchor_drawn = self.approaches.first().is_some_and(|path| path.len() == 1);
        for (rank, path) in self.approaches.iter().enumerate() {
            if path.is_empty() || (path.len() == 1 && anchor_drawn) { continue; }
            anchor_drawn |= path.len() == 1;
            out.extend([id as f32, kind as f32, rank as f32, path.len() as f32]);
            for p in path { out.extend([p.wp.x, p.wp.y, 0.0, p.dist]); }
        }
    }

    fn check(&mut self, stamp: u64, units: &[u32; NK], walk: impl Fn(Wp, Wp) -> bool) -> bool {
        if self.checked_stamp == Some(stamp) { return true; }
        let behind = self.dispatch - Self::lag(units);
        let start = self.points.partition_point(|p| p.dist < behind).saturating_sub(1);
        let clear = self.points[start..].windows(2).all(|p| p[1].dist <= behind || walk(p[0].wp, p[1].wp))
            && self.approaches.iter().enumerate().all(|(rank, path)| {
                let at = self.dispatch - rank as f32 * Self::gap(units);
                path.windows(2).all(|p| p[1].dist <= at || walk(p[0].wp, p[1].wp))
            });
        if clear { self.checked_stamp = Some(stamp); }
        clear
    }

    fn occupied(&self, units: &[u32; NK], on: impl Fn(f32, f32) -> bool) -> bool {
        let Some(last) = self.points.last() else { return false; };
        let gap = Self::gap(units);
        for rank in 0..units.iter().sum::<u32>() {
            let d = self.dispatch - gap * rank as f32;
            if d > last.dist { continue; }
            let path = if d < 0.0 { self.approaches.get(rank as usize).map_or(&[][..], Vec::as_slice) } else { &self.points };
            if file_position(path, d).is_some_and(|(x, y)| on(x, y)) { return true; }
        }
        false
    }
}

/// Knights, catapults and other riders and engines that travel apart from the foot soldiers of an army, each at their own pace and heading straight for the place the army was sent to.
/// They look for their own way (roads and bridges first, as everybody does); where theirs would need felling or a crossing that only the soldiers can make, they keep to the army's route
/// (`tied`) and wait at such a place until the soldiers have made it passable.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Grp {
    pub units: [u32; NK],
    pub x: f32, pub y: f32,
    pub path: Vec<Wp>,
    pub wi: usize,
    pub heading: f32,
    pub speed: f32,
    pub tied: bool,
    #[serde(skip)] pub(crate) file: MarchFile,
    #[serde(skip)] delay: u8,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Det {
    pub id: u32,
    pub units: [u32; NK],
    pub x: f32,
    pub y: f32,
    pub path: Vec<Wp>,
    pub wi: usize,
    pub state: u8,
    pub phase: u8,          // inside a water leg: 0 not started, 1 working (bridge/boat), 2 crossing
    pub work: f32,
    pub work_total: f32,
    pub sx: f32, pub sy: f32, // start of the current leg
    pub atk: Option<(f32, f32)>,
    pub home: bool,
    pub heading: f32,
    pub speed: f32,
    pub since_fell: f32,
    pub grp: Vec<Grp>,      // riders and engines marching apart (see Grp); their soldiers are still counted in `units`
    pub defend: bool,       // sent to fight in the battle at home: joins it as soon as it is close to an attacker
    /// 0 for our own army. Otherwise the tag of the allied village whose soldiers these are: guests (see `host_guests`) who fight beside our defenders and cannot be ordered about by us.
    #[serde(skip)] pub ally: i32,   // (kept out of the world's bytes so that saved villages from before guests still load: it travels in its own part of the snapshot, see `World::snapshot`)
    #[serde(skip)] pub(crate) file: MarchFile,
    #[serde(skip)] destination: Option<(f32, f32)>,
    #[serde(skip)] blocked_stamp: u64,
    /// A blocked army that found no way tries again only from this tick (backing off: 60, 120, 240, then every 480 ticks), not on every change to the roads.
    #[serde(skip)] retry_at: u64,
    #[serde(skip)] retry_n: u8,
}

/// The march fields appended to a world snapshot, separate from the original detachment layout.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct SavedMarch {
    file: MarchFile,
    destination: Option<(f32, f32)>,
    blocked_stamp: u64,
    groups: Vec<(MarchFile, u8)>,
    #[serde(default)] retry_at: u64,
    #[serde(default)] retry_n: u8,
}

impl Det {
    pub(crate) fn occupied(&self, on: impl Fn(f32, f32) -> bool) -> bool {
        if self.state == S_FIGHT { return false; }
        if self.file.mustered() && matches!(self.state, S_IDLE | S_ARRIVED | S_FORMATION) {
            return on(self.x, self.y) || self.file.formation_occupied(&self.units, self.state == S_FORMATION, on);
        }
        on(self.x, self.y) || self.file.occupied(&World::head_units(self), &on)
            || self.grp.iter().any(|g| on(g.x, g.y) || g.file.occupied(&g.units, &on))
    }

    pub(crate) fn save_march(&self) -> SavedMarch {
        SavedMarch { file: self.file.clone(), destination: self.destination, blocked_stamp: self.blocked_stamp, groups: self.grp.iter().map(|g| (g.file.clone(), g.delay)).collect(), retry_at: self.retry_at, retry_n: self.retry_n }
    }

    pub(crate) fn restore_march(&mut self, saved: SavedMarch) -> Option<()> {
        if saved.groups.len() != self.grp.len() { return None; }
        self.file = saved.file;
        self.destination = saved.destination;
        self.blocked_stamp = saved.blocked_stamp;
        self.retry_at = saved.retry_at; self.retry_n = saved.retry_n;
        for (g, (file, delay)) in self.grp.iter_mut().zip(saved.groups) { g.file = file; g.delay = delay; }
        Some(())
    }
}

pub struct NavStatic { h: Vec<f32>, slope: Vec<f32>, dens: Vec<u8>, tun: Vec<bool>, river: Vec<bool> }

thread_local! { static NAV: RefCell<Option<(u64, Rc<NavStatic>)>> = const { RefCell::new(None) }; }

pub fn nav_static(seed: u64) -> Rc<NavStatic> {
    if let Some(n) = nav_cached(seed) { return n; }
    let n = NC as usize;
    let h = terrain::grid(seed, ORG + CELL / 2.0, ORG + CELL / 2.0, NC as u32, NC as u32, CELL);
    let mut cnt = vec![0u8; n * n];
    count_trees(&mut cnt, &terrain::trees(seed, ORG, ORG, -ORG, -ORG));
    nav_install(seed, h, cnt)
}

fn nav_cached(seed: u64) -> Option<Rc<NavStatic>> {
    NAV.with(|c| match &*c.borrow() { Some((s, n)) if *s == seed => Some(n.clone()), _ => None })
}

fn count_trees(cnt: &mut [u8], t: &[f32]) {
    let n = NC as usize;
    for k in (0..t.len()).step_by(5) {
        let (ci, cj) = (((t[k] - ORG) / CELL) as i32, ((t[k + 1] - ORG) / CELL) as i32);
        if ci >= 0 && cj >= 0 && ci < NC && cj < NC { let q = &mut cnt[cj as usize * n + ci as usize]; *q = q.saturating_add(1); }
    }
}

/// The cheap last part of the grid (slopes, forest density, tunnels) from the two expensive parts (heights and tree counts), cached for `seed`.
fn nav_install(seed: u64, h: Vec<f32>, cnt: Vec<u8>) -> Rc<NavStatic> {
    let n = NC as usize;
    let mut slope = vec![0.0f32; n * n];
    for j in 0..n { for i in 0..n {
        let c = h[j * n + i];
        let mut m = 0.0f32;
        for (di, dj) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
            let (a, b) = (i as i32 + di, j as i32 + dj);
            if a >= 0 && b >= 0 && (a as usize) < n && (b as usize) < n { m = m.max((h[b as usize * n + a as usize] - c).abs() / CELL); }
        }
        slope[j * n + i] = m;
    } }
    let mut dens = vec![0u8; n * n];
    for j in 0..n { for i in 0..n {
        let mut s = 0u32;
        for dj in -1i32..=1 { for di in -1i32..=1 { let (a, b) = (i as i32 + di, j as i32 + dj); if a >= 0 && b >= 0 && a < NC && b < NC { s += cnt[b as usize * n + a as usize] as u32; } } }
        dens[j * n + i] = s.min(9) as u8;
    } }
    // tunnels bored through mountains: a corridor that is always passable, whatever the ground above it does
    let mut tun = vec![false; n * n];
    for t in terrain::tunnels(seed) {
        let l = ((t[2] - t[0]).powi(2) + (t[3] - t[1]).powi(2)).sqrt(); let st = (l / 1.0).ceil() as i32;
        for k in 0..=st { let f = k as f32 / st as f32; stamp(&mut tun, t[0] + (t[2] - t[0]) * f, t[1] + (t[3] - t[1]) * f, 3.6); }
    }
    let sites = terrain::sites(seed);
    let river = h.iter().enumerate().map(|(i, &ground)| {
        if !(0.2..terrain::RIVER_LEVEL).contains(&ground) { return false; }
        let (x, y) = cell_xy(i);
        ground < terrain::river_surface_at(seed, &sites, x, y)
    }).collect();
    let ns = Rc::new(NavStatic { h, slope, dens, tun, river });
    NAV.with(|c| *c.borrow_mut() = Some((seed, ns.clone())));
    ns
}

/// A navigation grid being built a slice at a time (so the page stays responsive): heights row by row, then tree counts strip by strip.
struct NavBuild { seed: u64, h: Vec<f32>, cnt: Vec<u8>, rows: u32, strip: i32 }
thread_local! { static NAV_BUILD: RefCell<Option<NavBuild>> = const { RefCell::new(None) }; }

/// Do about `units` rows of the navigation grid of `seed`; returns how far it is (0..1, exactly 1 once the grid is ready). The result is the very grid
/// `nav_static` builds in one go: the slices only decide when the work happens, never what comes out.
pub fn nav_build_step(seed: u64, units: u32) -> f32 {
    if nav_cached(seed).is_some() { NAV_BUILD.with(|b| *b.borrow_mut() = None); return 1.0; }
    let n = NC as usize;
    let (c0, c1) = ((ORG / terrain::TREE_CELL).floor() as i32, (-ORG / terrain::TREE_CELL).ceil() as i32);
    let total = NC as u32 + (c1 - c0) as u32;
    let mut b = NAV_BUILD.with(|b| b.borrow_mut().take()).filter(|b| b.seed == seed)
        .unwrap_or(NavBuild { seed, h: Vec::with_capacity(n * n), cnt: vec![0u8; n * n], rows: 0, strip: c0 });
    let mut left = units.max(1);
    while left > 0 && b.rows < NC as u32 {
        let k = left.min(NC as u32 - b.rows);
        b.h.extend(terrain::grid_rows(seed, ORG + CELL / 2.0, ORG + CELL / 2.0, NC as u32, CELL, b.rows, b.rows + k));
        b.rows += k; left -= k;
    }
    while left > 0 && b.strip < c1 {
        let k = (left as i32).min(c1 - b.strip);
        count_trees(&mut b.cnt, &terrain::trees_cells(seed, c0, c1, b.strip, b.strip + k));
        b.strip += k; left -= k as u32;
    }
    if b.rows >= NC as u32 && b.strip >= c1 { nav_install(seed, b.h, b.cnt); return 1.0; }
    let done = b.rows + (b.strip - c0) as u32;
    NAV_BUILD.with(|x| *x.borrow_mut() = Some(b));
    (done as f32 / total as f32).min(0.999)
}

impl NavStatic {
    pub fn dens_at(&self, x: f32, y: f32) -> u8 { self.idx(x, y).map_or(0, |i| self.dens[i]) }
    pub fn idx(&self, x: f32, y: f32) -> Option<usize> {
        let (i, j) = (((x - ORG) / CELL).floor() as i32, ((y - ORG) / CELL).floor() as i32);
        if i < 0 || j < 0 || i >= NC || j >= NC { None } else { Some((j * NC + i) as usize) }
    }
    #[allow(dead_code)] pub fn height(&self, i: usize) -> f32 { self.h[i] }
    #[allow(dead_code)] pub fn dens(&self, i: usize) -> u8 { self.dens[i] }
}

fn cell_xy(i: usize) -> (f32, f32) { ((i as i32 % NC) as f32 * CELL + ORG + CELL / 2.0, (i as i32 / NC) as f32 * CELL + ORG + CELL / 2.0) }

/// Per-request overlays: buildings, felled trees and bridges rasterised onto the grid.
pub(crate) struct Ov { blocked: Vec<bool>, soft: Vec<bool>, cleared: Vec<bool>, bridge: Vec<bool>, moat: Vec<bool>, road: Vec<bool>, deck_up: Vec<bool>, edited: Vec<bool>, ground: Vec<f32> }

const GROUND_SAMPLE_COUNT: usize = 1 << 15;

/// Recent exact samples, shared by overlapping paths and cleared when the terrain changes.
pub(crate) struct GroundSamples(Vec<Cell<(u64, f32)>>, Vec<Building>);

impl GroundSamples {
    fn height(&self, world: &World, x: f32, y: f32) -> f32 {
        let (xb, yb) = (x.to_bits(), y.to_bits());
        let key = ((xb as u64) << 32) | yb as u64;
        let hash = xb.wrapping_mul(0x9e3779b1) ^ yb.rotate_left(15).wrapping_mul(0x85ebca6b);
        let hash = (hash ^ (hash >> 16)).wrapping_mul(0x7feb352d);
        let entry = &self.0[(hash ^ (hash >> 16)) as usize & (GROUND_SAMPLE_COUNT - 1)];
        let (cached, h) = entry.get();
        if cached == key { return h; }
        let h = world.height_ground_in(x, y, &self.1);
        entry.set((key, h));
        h
    }
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct RouteMemo {
    revision: Option<u64>,
    entries: VecDeque<(RouteKey, Result<Vec<Wp>, i32>)>,
}

#[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
struct RouteKey { coords: [u32; 4], siege: bool, can_fell: bool, dry: bool }

#[derive(Clone, Copy, PartialEq)]
enum Cl { Block, Free(f32), Water }

#[derive(Copy, Clone, PartialEq)]
struct Node { f: f32, i: u32 }
impl Eq for Node {}
impl Ord for Node { fn cmp(&self, o: &Self) -> Ordering { o.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal).then_with(|| o.i.cmp(&self.i)) } }
impl PartialOrd for Node { fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) } }

fn stamp(grid: &mut [bool], x: f32, y: f32, r: f32) {
    let (i0, i1) = ((((x - r - ORG) / CELL).floor() as i32).max(0), (((x + r - ORG) / CELL).ceil() as i32).min(NC - 1));
    let (j0, j1) = ((((y - r - ORG) / CELL).floor() as i32).max(0), (((y + r - ORG) / CELL).ceil() as i32).min(NC - 1));
    for j in j0..=j1 { for i in i0..=i1 { let (cx, cy) = cell_xy((j * NC + i) as usize); if (cx - x).powi(2) + (cy - y).powi(2) <= r * r { grid[(j * NC + i) as usize] = true; } } }
}

impl World {
    fn ground_samples(&self) -> Rc<GroundSamples> {
        let stamp = self.ground_stamp();
        if let Some((last, samples)) = &*self.march_heights.borrow() { if *last == stamp { return samples.clone(); } }
        // the ditches, earthworks and drawbridges (all `ground_stamp` looks at), kept with the samples so a missed sample need not walk every building
        let edits = self.buildings.iter().filter(|b| is_edit(b.kind) || b.kind == DRAWBRIDGE).cloned().collect();
        let samples = Rc::new(GroundSamples(vec![Cell::new((u64::MAX, 0.0)); GROUND_SAMPLE_COUNT], edits));
        *self.march_heights.borrow_mut() = Some((stamp, samples.clone()));
        samples
    }

    /// The overlays of the world as it stands (rebuilt only when something that matters changed: they are the adjustments to the base grid that buildings, roads, walls, bridges and felled trees make).
    pub(crate) fn route_revision(&self) -> u64 {
        self.overlay_stamp() ^ self.ground_stamp().rotate_left(17) ^ u64::from(self.auto_bridge)
    }

    pub(crate) fn prepared_routes(&self) -> Vec<u8> {
        bincode::serialize(&*self.march_routes.borrow()).unwrap_or_default()
    }

    pub(crate) fn use_prepared_routes(&self, bytes: &[u8]) -> bool {
        let Ok(prepared) = bincode::deserialize::<RouteMemo>(bytes) else { return false; };
        if prepared.revision.is_some_and(|stamp| stamp != self.route_revision()) { return false; }
        if prepared.revision.is_some() { *self.march_routes.borrow_mut() = prepared; }
        true
    }

    fn overlay_stamp(&self) -> u64 {
        let mut h = self.net_stamp();
        let mut mix = |v: u64| { h ^= v; h = h.wrapping_mul(0x100000001b3); };
        for f in &self.felled { for v in f { mix(v.to_bits() as u64); } }
        for b in &self.bridges { for v in b { mix(v.to_bits() as u64); } }
        mix(self.road_sig);
        mix(self.roads.len() as u64); mix(self.battle.is_some() as u64);
        for b in self.buildings.iter().filter(|b| b.kind == DRAWBRIDGE) { mix((b.status as u64) << 1 | (b.progress > 0) as u64); }
        h
    }

    fn ov(&self) -> std::rc::Rc<Ov> {
        let h = self.overlay_stamp();
        if let Some((st, o)) = &*self.ov_cache.borrow() { if *st == h { return o.clone(); } }
        let o = std::rc::Rc::new(self.overlays());
        *self.ov_cache.borrow_mut() = Some((h, o.clone()));
        o
    }

    fn overlays(&self) -> Ov {
        let n = (NC * NC) as usize;
        let mut ov = Ov { blocked: vec![false; n], soft: vec![false; n], cleared: vec![false; n], bridge: vec![false; n], moat: vec![false; n], road: vec![false; n], deck_up: vec![false; n], edited: vec![false; n], ground: vec![] };
        for b in &self.buildings {
            if matches!(b.kind, MOAT | RIVER | RAISE | LOWER | DRAWBRIDGE) {
                let r = if b.kind == DRAWBRIDGE { 27.0 } else { 13.0 };
                stamp(&mut ov.edited, b.x, b.y, r);
            }
            match b.kind {
                GATE | ROAD => {}                                             // an opening in the wall, or a road: nothing blocks it
                BRIDGE => { let (ux, uy, l) = Self::bridge_dir(b); let st = l.ceil().max(1.0) as i32; for k in 0..=st { let t = (k as f32 / st as f32 - 0.5) * l; stamp(&mut ov.bridge, b.x + ux * t, b.y + uy * t, 1.8); } }
                MOAT | RIVER | RAISE | LOWER => {}
                DRAWBRIDGE if self.drawn_up(b) => {                           // drawn up: no way across, unless an army lowers it for itself
                    if self.db_lendable(b) { let a = b.rot as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos()); for k in -9..=9 { let t = k as f32 * 0.8; stamp(&mut ov.deck_up, b.x + sx * t, b.y + sy * t, 1.6); } }
                }
                DRAWBRIDGE => {                                               // a way across for your own armies
                    let a = b.rot as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
                    for k in -9..=9 { let t = k as f32 * 0.8; stamp(&mut ov.bridge, b.x + sx * t, b.y + sy * t, 1.6); }
                }
                _ => {
                    if matches!(b.kind, FARM | GARDEN | PARK | MARKET) {   // its fields, beds and stalls are blocked as the rectangles they are (nobody walks across a crop)
                        let (i0, i1) = ((((b.x - 18.0 - ORG) / CELL).floor() as i32).max(0), (((b.x + 18.0 - ORG) / CELL).ceil() as i32).min(NC - 1));
                        let (j0, j1) = ((((b.y - 18.0 - ORG) / CELL).floor() as i32).max(0), (((b.y + 18.0 - ORG) / CELL).ceil() as i32).min(NC - 1));
                        for j in j0..=j1 { for i in i0..=i1 { let (cx, cy) = cell_xy((j * NC + i) as usize); if crate::pathnet::in_fields(b, cx, cy, 0.9) { ov.blocked[(j * NC + i) as usize] = true; } } }
                    }
                    if !matches!(b.kind, PLAZA | TOLL) { stamp(&mut ov.blocked, b.x, b.y, crate::solid_radius(b.kind, b.tier)); }
                    if let Some(c) = crate::compound::compound(b.kind, b.tier) {   // a walled compound: its curtain wall and towers reach out past that circle (the gate in front is left open for the way to the door)
                        for p in c.pieces.iter().filter(|p| !p.front) {
                            let (a, e) = (crate::compound::at(b, (p.ax, p.az)), crate::compound::at(b, (p.bx, p.bz)));
                            let st = ((e.0 - a.0).hypot(e.1 - a.1) / 1.0).ceil().max(1.0) as i32;
                            for k in 0..=st { let t = k as f32 / st as f32; stamp(&mut ov.blocked, a.0 + (e.0 - a.0) * t, a.1 + (e.1 - a.1) * t, p.r + 1.0); }
                        }
                    }
                    if !matches!(b.kind, WALL | FENCE) { stamp(&mut ov.soft, b.x, b.y, crate::footprint(b.kind, b.tier) + 0.7); }   // the margin round it: allowed, but avoided
                }
            }
        }
        let (segs, _) = self.friendly_wall_lines();
        for sg in &segs {   // the runs of wall and fence between the pieces (the pieces alone leave gaps)
            let l = (sg.bx - sg.ax).hypot(sg.by - sg.ay); let st = (l / 1.0).ceil().max(1.0) as i32;
            for k in 0..=st { let t = k as f32 / st as f32; stamp(&mut ov.blocked, sg.ax + (sg.bx - sg.ax) * t, sg.ay + (sg.by - sg.ay) * t, sg.r + 0.4); }
        }
        for r in &self.roads {   // the village's roads: soldiers keep to them
            let (dx, dy) = (r[3] - r[0], r[4] - r[1]); let l = dx.hypot(dy).max(0.1); let st = (l / 1.0).ceil() as i32;
            for k in 0..=st { let t = k as f32 / st as f32; stamp(&mut ov.road, r[0] + dx * t, r[1] + dy * t, 1.3); }
        }
        for f in &self.felled { stamp(&mut ov.cleared, f[0], f[1], f[2]); }
        for br in &self.bridges {
            let (dx, dy) = (br[2] - br[0], br[3] - br[1]); let l = (dx * dx + dy * dy).sqrt().max(0.1); let steps = (l / 1.0).ceil() as i32;
            for k in 0..=steps { let t = k as f32 / steps as f32; stamp(&mut ov.bridge, br[0] + dx * t, br[1] + dy * t, 1.6); }
        }
        for d in self.deposits.iter().filter(|d| d.max > 0) {
            stamp(&mut ov.blocked, d.x, d.y, d.walk_radius());
        }
        for l in &self.levels { stamp(&mut ov.edited, l[0], l[1], l[2] + LEVEL_BLEND + 5.0); }
        for l in &self.flats { stamp(&mut ov.edited, l[0], l[1], l[2] + flatten::FLAT_SHOULDER + 5.0); }
        let ns = nav_static(self.seed);
        ov.ground = ns.h.clone();
        for (i, h) in ov.ground.iter_mut().enumerate().filter(|(i, _)| ov.edited[*i]) {
            let (x, y) = cell_xy(i);
            *h = self.height_from(x, y, true, false, *h);
            ov.moat[i] = self.ground_is_wet(x, y, *h);
        }
        ov
    }

    // Trees slow soldiers only a little (densest forest: 1.5x slower, was 3.7x), and the margin round a building (gardens, yards) is barely avoided, so soldiers cut through town.
    /// How a cell can be crossed. `lvl` is how much room the traveller needs: 0 a foot soldier; 1 a siege engine (gentler slopes, dense forest must be felled); 2 an engine that also keeps a cell
    /// clear of cliffs and open water; 3 one that also keeps clear of buildings, walls and fields. An engine is about three paces wide: it needs a road, not a path.
    fn classify(&self, ns: &NavStatic, ov: &Ov, i: usize, lvl: u8) -> Cl {
        let c = self.classify_cell(ns, ov, i, lvl > 0);
        if lvl < 2 || !matches!(c, Cl::Free(_)) || ov.bridge[i] || (ns.tun[i] && !ov.moat[i]) { return c; }
        let (ci, cj) = (i as i32 % NC, i as i32 / NC);
        for (di, dj) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
            let (a, b) = (ci + di, cj + dj); if a < 0 || b < 0 || a >= NC || b >= NC { return Cl::Block; }
            let k = (b * NC + a) as usize;
            if ov.bridge[k] { continue; }
            if Self::wet_cell(ns, ov, k) || (!ov.edited[k] && ns.slope[k] > 0.85) { return Cl::Block; }
            if lvl >= 3 && ov.blocked[k] { return Cl::Block; }
        }
        c
    }

    fn classify_cell(&self, ns: &NavStatic, ov: &Ov, i: usize, siege: bool) -> Cl {
        let (x, y) = cell_xy(i);
        if x.abs() > 1192.0 || y.abs() > 1192.0 || ov.blocked[i] { return Cl::Block; }
        if ns.tun[i] && !ov.moat[i] && !ns.river[i] { return Cl::Free(1.3); }
        if Self::wet_cell(ns, ov, i) && !ov.bridge[i] { return Cl::Water; }
        if !ov.bridge[i] && !ov.edited[i] && ns.slope[i] > if siege { 0.85 } else { 1.6 } { return Cl::Block; }
        let d = if ov.cleared[i] { 0.0 } else { ns.dens[i] as f32 };
        if siege && d >= 2.0 { return Cl::Free(8.0 + d); }               // dense forest: needs felling
        let c = 1.0 + 0.2 * d + ns.slope[i] * 1.2 + if ov.soft[i] { 0.3 } else { 0.0 };
        Cl::Free(if ov.road[i] { c * crate::pathnet::ROAD_COST } else { c })
    }

    fn wet_cell(ns: &NavStatic, ov: &Ov, i: usize) -> bool {
        if ov.edited[i] { ov.moat[i] } else { ns.h[i] < 0.2 || ns.river[i] }
    }

    fn near_free(&self, ns: &NavStatic, ov: &Ov, x: f32, y: f32, siege: u8) -> Option<usize> {
        let c = ns.idx(x, y)?;
        let (ci, cj) = (c as i32 % NC, c as i32 / NC);
        for r in 0..8i32 { for dj in -r..=r { for di in -r..=r {
            if di.abs().max(dj.abs()) != r { continue; }
            let (a, b) = (ci + di, cj + dj); if a < 0 || b < 0 || a >= NC || b >= NC { continue; }
            let k = (b * NC + a) as usize;
            if matches!(self.classify(ns, ov, k, siege), Cl::Free(_)) {
                let (x, y) = cell_xy(k);
                if !self.member_blocked_inner(x, y, if siege > 0 { 3 } else { 0 }) { return Some(k); }
            }
        } } }
        None
    }

    pub(crate) fn ground_is_wet(&self, x: f32, y: f32, ground: f32) -> bool {
        self.natural_water_covers(x, y, ground, 0.2) || self.moat_water.iter().any(|p| {
            ground < p[3] && (p[0] - x).abs() < p[2] && (p[1] - y).abs() < p[2] && (p[0] - x).hypot(p[1] - y) < p[2]
        })
    }

    fn walk_segment(&self, ns: &NavStatic, obst: &members::Obst, a: (f32, f32), b: (f32, f32), room: f32, slope: f32, lend: bool) -> bool {
        self.walk_segment_with(ns, obst, a, b, room, slope, lend, |x, y| self.height_ground(x, y))
    }

    fn walk_segment_with(&self, ns: &NavStatic, obst: &members::Obst, a: (f32, f32), b: (f32, f32), room: f32, slope: f32, lend: bool, height: impl Fn(f32, f32) -> f32) -> bool {
        obst.solid_clear(a, b, room) && self.walk_surface_with(ns, obst, a, b, slope, lend, height)
    }

    fn walk_surface_with(&self, ns: &NavStatic, obst: &members::Obst, a: (f32, f32), b: (f32, f32), slope: f32, lend: bool, height: impl Fn(f32, f32) -> f32) -> bool {
        let distance = (b.0 - a.0).hypot(b.1 - a.1);
        let steps = (distance / 0.5).ceil().max(1.0) as u32;
        let mut previous = None;
        for i in 0..=steps {
            let t = i as f32 / steps as f32;
            let (x, y) = (lerp(a.0, b.0, t), lerp(a.1, b.1, t));
            if obst.on_deck(x, y, lend) {
                previous = None;
                continue;
            }
            let h = height(x, y);
            if self.ground_is_wet(x, y, h) { return false; }
            if ns.idx(x, y).is_some_and(|k| ns.tun[k]) { previous = None; continue; }
            if slope < 1.0 && [(CELL, 0.0), (-CELL, 0.0), (0.0, CELL), (0.0, -CELL)].iter().any(|&(dx, dy)| {
                (height(x + dx, y + dy) - h).abs() > 1.05 * CELL
            }) { return false; }
            if previous.is_some_and(|p: f32| (p - h).abs() > slope * (distance / steps as f32) + 0.025) { return false; }
            previous = Some(h);
        }
        true
    }

    /// Find a route. Err codes: -2 unreachable, -3 siege engines need soldiers to clear the forest, -5 water too wide.
    /// One graph serves everybody: the base grid of the whole world (terrain, slopes, forest), adjusted by what is built (buildings, walls and fences block it; roads, bridges and open
    /// gates open lines through it), plus the village's path network (roads, rings round buildings, doorways, decks), which joins the grid wherever it touches it. The route is the
    /// cheapest way along those lines; roads cost little, so they are preferred.
    pub(crate) fn find_path(&self, units: &[u32; NK], sx: f32, sy: f32, tx: f32, ty: f32) -> Result<Vec<Wp>, i32> {
        self.order_path(units, sx, sy, tx, ty, false, false)
    }

    fn order_path(&self, units: &[u32; NK], sx: f32, sy: f32, tx: f32, ty: f32, dry: bool, cached_only: bool) -> Result<Vec<Wp>, i32> {
        let revision = self.route_revision();
        let coords = [sx, sy, tx, ty].map(f32::to_bits);
        let siege = units[4] + units[5] > 0;
        let can_fell = siege && units[0] + units[2] > 0;
        let key = RouteKey { coords, siege, can_fell, dry };
        {
            let mut memo = self.march_routes.borrow_mut();
            if memo.revision != Some(revision) { memo.entries.clear(); memo.revision = Some(revision); }
            if let Some((_, route)) = memo.entries.iter().find(|entry| entry.0 == key) { return route.clone(); }
        }
        if cached_only { return Err(ROUTE_PENDING); }
        let route = if dry { self.route_on_graph(units, sx, sy, tx, ty, true) } else { self.find_path_uncached(units, sx, sy, tx, ty) };
        let mut memo = self.march_routes.borrow_mut();
        if memo.entries.len() == 12 { memo.entries.pop_front(); }
        memo.entries.push_back((key, route.clone()));
        route
    }

    fn find_path_uncached(&self, units: &[u32; NK], sx: f32, sy: f32, tx: f32, ty: f32) -> Result<Vec<Wp>, i32> {
        if self.auto_bridge {
            if let Ok(route) = self.route_with_water(units, sx, sy, tx, ty, WaterTravel::BridgeShortcut) {
                if route.windows(2).all(|p| p[1].mode != 2 || (p[1].x - p[0].x).hypot(p[1].y - p[0].y) <= BRIDGE_MAX) { return Ok(route); }
            }
        }
        // The way over existing bridges and decks only, unless bridging or ferrying is much shorter and the village can pay for it. (The dry way used to win whenever
        // there was one: on a map of rivers and lakes that sent armies seven to fifteen times the distance round, and they seemed lost or stuck.)
        let dry = self.route_with_water(units, sx, sy, tx, ty, WaterTravel::ExistingDecks);
        let wet = self.route_with_water(units, sx, sy, tx, ty, WaterTravel::Build);
        match (dry, wet) {
            (Ok(d), Ok(b)) => {
                let (dl, bl) = (Self::route_length(sx, sy, &d), Self::route_length(sx, sy, &b));
                if dl <= bl * DRY_DETOUR + 150.0 || !self.can_pay_crossings(units, sx, sy, &b) { Ok(d) } else { Ok(b) }
            }
            (Ok(d), Err(_)) => Ok(d),
            (Err(_), b) => b,
        }
    }
    /// Can the village pay for the bridges and ferries along this route (each priced as `crossing_cost` prices it)?
    fn can_pay_crossings(&self, units: &[u32; NK], sx: f32, sy: f32, p: &[Wp]) -> bool {
        let total: u32 = units.iter().sum(); let mut need = [0i32; N_RES]; let mut prev = (sx, sy); let mut bridges = self.field_bridge_count();
        for w in p {
            if w.mode == 2 { let len = (w.x - prev.0).hypot(w.y - prev.1); let (bridge, res, cost) = crossing_cost(len, bridges, total); if bridge { bridges += 1; } need[res] += cost; }
            prev = (w.x, w.y);
        }
        (0..N_RES).all(|r| self.stock[r] >= need[r])
    }

    /// The same for somebody on foot who will not wade (villagers): [1, x, y, x, y, ...] or empty when there is no dry way.
    pub(crate) fn walk_route_inner(&self, sx: f32, sy: f32, tx: f32, ty: f32) -> Vec<f32> {
        let start = (sx, sy); let goal = (tx, ty);
        if let Some((mut route, true)) = self.net().route(start, goal) {
            route.push(goal);
            let ns = nav_static(self.seed); let obst = self.obst(); let terrain = self.ground_samples();
            let mut prev = start;
            if route.iter().all(|&p| {
                let clear = self.walk_segment_with(&ns, &obst, prev, p, members::FOOT_MARGIN, 1.6, false, |x, y| terrain.height(self, x, y));
                prev = p;
                clear
            }) {
                let mut out = vec![1.0]; out.extend(route.into_iter().flat_map(|(x, y)| [x, y]));
                return out;
            }
        }
        match self.route_on_graph(&[1, 0, 0, 0, 0, 0], sx, sy, tx, ty, true) {
            Ok(p) => { let mut v = vec![1.0]; for w in p.iter().skip(1) { v.extend_from_slice(&[w.x, w.y]); } v }
            Err(_) => vec![],
        }
    }

    pub(crate) fn route_on_graph(&self, units: &[u32; NK], sx: f32, sy: f32, tx: f32, ty: f32, no_water: bool) -> Result<Vec<Wp>, i32> {
        self.route_with_water(units, sx, sy, tx, ty, if no_water { WaterTravel::Dry } else { WaterTravel::Build })
    }

    pub(crate) fn route_with_water(&self, units: &[u32; NK], sx: f32, sy: f32, tx: f32, ty: f32, water: WaterTravel) -> Result<Vec<Wp>, i32> {
        if !Self::infrastructure_in_bounds(sx, sy) || !Self::infrastructure_in_bounds(tx, ty) { return Err(-2); }
        let margins = if water == WaterTravel::Dry { [30.0, 90.0, 500.0] } else { [45.0, 180.0, 2500.0] };
        let mut last = Err(-2);
        if units[4] + units[5] == 0 {
            for m in margins { last = self.route_in_window(units, sx, sy, tx, ty, m, water, 0); if !matches!(last, Err(-2)) { break; } }
            return last;
        }
        // A siege engine wants a road wide enough for it (level 3, then 2), but not at any price: the widest road whose way is at most `SIEGE_DETOUR` times the
        // shortest the engines can take is used. (Taking the widest road there was, however far round, sent whole armies on detours several times the distance:
        // the soldiers walk the engines' route, and then stood at the goal for minutes waiting for them.)
        let mut found: Vec<(Vec<Wp>, f32)> = vec![];
        'levels: for &lvl in &[3u8, 2, 1] {
            for m in margins {
                match self.route_in_window(units, sx, sy, tx, ty, m, water, lvl) {
                    Ok(p) => { let len = Self::route_length(sx, sy, &p); found.push((p, len)); break; }
                    Err(-2) => { last = Err(-2); }
                    Err(e) => { last = Err(e); if found.is_empty() { return last; } break 'levels; }   // (as before: a hard refusal ends the search)
                }
            }
        }
        let Some(shortest) = found.iter().map(|f| f.1).reduce(f32::min) else { return last };
        Ok(found.into_iter().find(|f| f.1 <= shortest * SIEGE_DETOUR + 60.0).map(|f| f.0).expect("the shortest is within its own bound"))
    }
    pub(crate) fn route_length(sx: f32, sy: f32, p: &[Wp]) -> f32 { let mut prev = (sx, sy); p.iter().map(|w| { let l = (w.x - prev.0).hypot(w.y - prev.1); prev = (w.x, w.y); l }).sum() }

    fn route_in_window(&self, units: &[u32; NK], sx: f32, sy: f32, tx: f32, ty: f32, margin: f32, water: WaterTravel, siege: u8) -> Result<Vec<Wp>, i32> {
        let ns = nav_static(self.seed); let ov = self.ov(); let net = self.net(); let obst = self.obst();
        let room = if siege >= 3 { members::ENGINE_MARGIN } else { members::FOOT_MARGIN };
        let slope = if siege > 0 { 0.85 } else { 1.6 };
        let lend = water != WaterTravel::Dry;
        let no_water = matches!(water, WaterTravel::Dry | WaterTravel::ExistingDecks);
        let terrain = self.ground_samples();
        let walk = |a, b| self.walk_segment_with(&ns, &obst, a, b, room, slope, lend, |x, y| terrain.height(self, x, y));
        // how a cell can be crossed; for an army (which does not wade) the deck of a drawbridge that is drawn up counts as dry ground, because the army lowers it for itself (see `drawbridge_step`)
        let cl = |k: usize| -> Cl { match self.classify(&ns, &ov, k, siege) { Cl::Water if lend && ov.deck_up[k] => Cl::Free(1.5), c => c } };
        let workers = units[0] + units[2];
        let start = (sx, sy); let goal = (tx, ty);
        let walkable_start = walk(start, start); let walkable_goal = walk(goal, goal);
        let nearest = |p: (f32, f32), exact: bool, departure: bool| {
            let k = ns.idx(p.0, p.1)?;
            let (i, j) = (k as i32 % NC, k as i32 / NC);
            let mut best = None;
            for r in 0..8i32 {
                for dy in -r..=r { for dx in -r..=r {
                    if dx.abs().max(dy.abs()) != r { continue; }
                    let (x, y) = (i + dx, j + dy);
                    if !(0..NC).contains(&x) || !(0..NC).contains(&y) { continue; }
                    let k = (y * NC + x) as usize;
                    if !matches!(cl(k), Cl::Free(_)) { continue; }
                    let q = cell_xy(k);
                    let d = (p.0 - q.0).hypot(p.1 - q.1);
                    if best.is_none_or(|(distance, _)| d < distance)
                        && walk(q, if exact { p } else { q })
                        && (!departure || obst.deposit_exit_clear(p, q, room)) { best = Some((d, k)); }
                } }
                if best.is_some_and(|(d, _)| d <= (r as f32 + 0.5) * CELL) { break; }
            }
            best.map(|(_, k)| k)
        };
        let (Some(s), Some(g)) = (nearest(start, walkable_start, !walkable_start), nearest(goal, walkable_goal, false)) else { return Err(-2) };
        let ((scx, scy), (gcx, gcy)) = (cell_xy(s), cell_xy(g));
        let i0 = (((scx.min(gcx) - margin - ORG) / CELL).floor() as i32).max(0); let i1 = (((scx.max(gcx) + margin - ORG) / CELL).ceil() as i32).min(NC - 1);
        let j0 = (((scy.min(gcy) - margin - ORG) / CELL).floor() as i32).max(0); let j1 = (((scy.max(gcy) + margin - ORG) / CELL).ceil() as i32).min(NC - 1);
        let (w, h) = (i1 - i0 + 1, j1 - j0 + 1); let ncell = (w * h) as usize;
        let local = |i: usize| -> Option<usize> { let (ci, cj) = (i as i32 % NC, i as i32 / NC); if ci < i0 || ci > i1 || cj < j0 || cj > j1 { None } else { Some(((cj - j0) * w + (ci - i0)) as usize) } };
        let global = |l: usize| -> usize { let (a, b) = (l as i32 % w + i0, l as i32 / w + j0); (b * NC + a) as usize };
        // Explicit deck edges join dry banks even when a coarse grid centre misses a slender deck.
        let mut deck_nodes = Vec::new();
        for c in self.crossings().into_iter().filter(|c| c.down || (lend && c.lendable)) {
            let (a, b) = ((c.ax, c.ay), (c.bx, c.by));
            if [a, b].iter().all(|&(x, y)| !self.ground_is_wet(x, y, self.height_ground(x, y))) && walk(a, b) { deck_nodes.extend([a, b]); }
        }
        let net_count = net.nodes.len(); let nn = net_count + deck_nodes.len();
        let node = |n: usize| if n < net_count { net.nodes[n] } else { deck_nodes[n - net_count] };
        let mut at_cell: std::collections::HashMap<usize, Vec<usize>> = Default::default();
        let mut node_cells = vec![Vec::new(); nn];
        let mut connections = Vec::new();
        for n in 0..nn {
            if siege > 0 && n < net_count { continue; }
            let p = node(n);
            let Some(k) = ns.idx(p.0, p.1) else { continue };
            let (i, j) = (k as i32 % NC, k as i32 / NC);
            for dy in -1..=1 { for dx in -1..=1 {
                let (x, y) = (i + dx, j + dy);
                if !(0..NC).contains(&x) || !(0..NC).contains(&y) { continue; }
                let k = (y * NC + x) as usize;
                let Some(l) = local(k) else { continue };
                let q = cell_xy(k); let d = (q.0 - p.0).hypot(q.1 - p.1);
                if d <= CELL && matches!(cl(k), Cl::Free(_)) {
                    let id = connections.len();
                    at_cell.entry(l).or_default().push(id);
                    node_cells[n].push(id);
                    connections.push((n, l, d / CELL + 0.15, Cell::new(None)));
                }
            } }
        }
        let (Some(sl), Some(gl)) = (local(s), local(g)) else { return Err(-2) };
        let total = ncell + nn;
        let mut gc = vec![f32::MAX; total]; let mut from = vec![u32::MAX; total];
        let mut heap = BinaryHeap::new();
        let pos = |i: usize| if i < ncell { cell_xy(global(i)) } else { node(i - ncell) };
        // Most nearby network connections are never visited. Verify them only if the search reaches either end.
        let connected = |id: usize, to_node: bool| {
            let (n, l, cost, clear) = &connections[id];
            let valid = clear.get().unwrap_or_else(|| {
                let valid = walk(node(*n), pos(*l));
                clear.set(Some(valid));
                valid
            });
            valid.then_some((if to_node { ncell + n } else { *l }, *cost))
        };
        let hfn = |i: usize| { let p = pos(i); (p.0 - gcx).hypot(p.1 - gcy) / CELL * 0.7 };
        let source = if siege == 0 {
            net.nodes.iter().position(|&p| p == start && walkable_start).map_or(sl, |n| ncell + n)
        } else { sl };
        gc[source] = 0.0; heap.push(Node { f: hfn(source), i: source as u32 });
        let edges = |i: usize, reverse: bool, next: &mut Vec<(usize, f32)>| {
            next.clear();
            if i < ncell {
                let gi = global(i); let (ci, cj) = (gi as i32 % NC, gi as i32 / NC); let p = cell_xy(gi);
                for (di, dj) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                    let (a, b) = (ci + di, cj + dj); if a < 0 || b < 0 || a >= NC || b >= NC { continue; }
                    let k = (b * NC + a) as usize; let Some(kl) = local(k) else { continue };
                    let step = match cl(k) {
                        Cl::Block => continue, Cl::Free(c) => c,
                        Cl::Water if no_water => continue,
                        Cl::Water if water == WaterTravel::BridgeShortcut => 2.5,
                        Cl::Water => 16.0,
                    };
                    if di != 0 && dj != 0 {   // no cutting corners through blocked cells
                        if [(cj * NC + a) as usize, (b * NC + ci) as usize].iter().any(|&k| cl(k) == Cl::Block || (no_water && cl(k) == Cl::Water)) { continue; }
                    }
                    let q = cell_xy(k);
                    let simple = [gi, k].iter().all(|&k| !ov.edited[k] && ov.ground[k] >= 2.0 && ns.slope[k] <= 0.38);
                    let (a, b) = if reverse { (q, p) } else { (p, q) };
                    let clear = if simple || cl(gi) == Cl::Water || cl(k) == Cl::Water { obst.solid_clear(a, b, room) } else { walk(a, b) };
                    if !clear { continue; }
                    next.push((kl, step * if di != 0 && dj != 0 { 1.414 } else { 1.0 }));
                }
                if let Some(v) = at_cell.get(&i) { next.extend(v.iter().filter_map(|&id| connected(id, true))); }
            } else {
                let n = i - ncell;
                if n < net_count {
                    for &(to, l, road) in &net.adj[n] {
                        let (a, b) = if reverse { (to as usize, n) } else { (n, to as usize) };
                        if walk(node(a), node(b)) { next.push((ncell + to as usize, l / CELL * if road { pathnet::ROAD_COST } else { 0.8 })); }
                    }
                } else {
                    let to = net_count + ((n - net_count) ^ 1);
                    let (p, q) = (node(n), node(to));
                    next.push((ncell + to, (p.0 - q.0).hypot(p.1 - q.1) / CELL * pathnet::ROAD_COST));
                }
                next.extend(node_cells[n].iter().filter_map(|&id| connected(id, false)));
            }
        };
        let mut found = false;
        let mut next = Vec::new();
        let mut expanded = 0;
        while let Some(Node { f, i }) = heap.pop() {
            let i = i as usize;
            if i == gl { found = true; break; }
            if f > gc[i] + hfn(i) + 1e-4 { continue; }
            expanded += 1;
            if expanded == 384 {
                // A walled or isolated destination may have only a few incoming paths while the start can reach most of the map.
                // Probe backward for disconnection. When the probe is inconclusive, keep the original weighted search and its tie-breaking.
                let mut seen = std::collections::HashSet::from([gl]);
                let mut open = std::collections::VecDeque::from([gl]);
                for _ in 0..384 {
                    let Some(at) = open.pop_front() else { return Err(-2); };
                    if gc[at] < f32::MAX { break; }
                    edges(at, true, &mut next);
                    open.extend(next.iter().filter_map(|&(k, _)| seen.insert(k).then_some(k)));
                }
            }
            edges(i, false, &mut next);
            for &(k, c) in &next { let ng = gc[i] + c; if ng < gc[k] { gc[k] = ng; from[k] = i as u32; heap.push(Node { f: ng + hfn(k), i: k as u32 }); } }
        }
        if !found { return Err(-2); }
        let mut chain = vec![gl]; let mut c = gl; while from[c] != u32::MAX { c = from[c] as usize; chain.push(c); } chain.reverse();
        let mode_of = |k: usize| -> u8 {
            if k >= ncell { return 0; }
            match cl(global(k)) { Cl::Water => 2, Cl::Free(c) if c >= 8.0 => 1, _ => 0 }
        };
        let mut path = vec![Wp { x: sx, y: sy, mode: 0 }];
        let mut i = 0;
        while i < chain.len() {
            let k = chain[i];
            let mode = mode_of(k);
            if mode == 2 {
                while i < chain.len() && mode_of(chain[i]) == 2 { i += 1; }
                let Some(&bank) = chain.get(i) else { return Err(-2) };
                let a = path.last().unwrap();
                let q = pos(bank);
                if (q.0 - a.x).hypot(q.1 - a.y) > MAX_FERRY { return Err(-5); }
                if !obst.solid_clear((a.x, a.y), q, room) || !walk(q, q) { return Err(-2); }
                path.push(Wp { x: q.0, y: q.1, mode: 2 });
            } else {
                if mode == 1 && workers == 0 { return Err(-3); }
                let a = path.last().unwrap();
                // The grid contributes straight off-network legs. Keep real network nodes and changes of travel mode exactly.
                if i > 0 && k < ncell && chain[i - 1] < ncell && mode_of(chain[i - 1]) == mode {
                    let p = (a.x, a.y);
                    let mut end = i;
                    for j in i + 1..chain.len().min(i + 13) {
                        if chain[j] >= ncell || mode_of(chain[j]) != mode { break; }
                        let q = pos(chain[j]);
                        let (dx, dy) = (q.0 - p.0, q.1 - p.1);
                        let l = dx.hypot(dy).max(1e-4);
                        if chain[i..j].iter().any(|&v| { let v = pos(v); ((v.0 - p.0) * dy - (v.1 - p.1) * dx).abs() / l > 0.9 }) { break; }
                        if !walk(p, q) { break; }
                        end = j;
                    }
                    i = end;
                }
                let q = pos(chain[i]);
                if (q.0 - a.x).hypot(q.1 - a.y) > 0.001 {
                    if (i > 0 || walkable_start) && !walk((a.x, a.y), q) { return Err(-2); }
                    path.push(Wp { x: q.0, y: q.1, mode });
                }
            }
            i += 1;
        }
        if walkable_goal {
            let a = path.last().unwrap();
            if (tx - a.x).hypot(ty - a.y) > 0.001 { path.push(Wp { x: tx, y: ty, mode: 0 }); }
        }
        // Gate and deck centring may only replace legs when the result is still clear.
        let centred = self.through_doors(path.clone(), !no_water);
        if centred.windows(2).all(|p| p[1].mode == 2 || (!walkable_start && (p[0].x, p[0].y) == start)
            || walk((p[0].x, p[0].y), (p[1].x, p[1].y))) {
            Ok(centred)
        } else {
            Ok(path)
        }
    }

    /// Wherever a route passes through an open gate or over a lowered drawbridge it is made to run along the middle of the doorway, straight in and straight out (the open-ground
    /// search only knows grid cells, which would have it hug one side).
    fn through_doors(&self, wps: Vec<Wp>, own: bool) -> Vec<Wp> {
        let (_, doors) = self.friendly_wall_lines();
        // (centre, direction one walks through it, half-width across, nodes along it)
        let mut lanes: Vec<(f32, f32, f32, f32, f32, &'static [f32])> = vec![];
        const GATE_T: &[f32] = &[-7.5, -3.8, 0.0, 3.8, 7.5];
        const DECK_T: &[f32] = &[-9.0, -6.0, -3.0, 0.0, 3.0, 6.0, 9.0];
        for d in &doors { lanes.push((d.x, d.y, -d.uy, d.ux, crate::wallnet::GATE_HALF + 1.5, GATE_T)); }   // (a shut gate opens for your own armies)
        for b in &self.buildings { if b.kind == DRAWBRIDGE && (!self.drawn_up(b) || (own && self.db_lendable(b))) { let a = b.rot as f32 * std::f32::consts::FRAC_PI_4; lanes.push((b.x, b.y, a.sin(), a.cos(), 3.0, DECK_T)); } }
        if lanes.is_empty() { return wps; }
        let mut out = wps;
        for &(cx, cy, nx, ny, half, ts) in &lanes {
            let mut i = 1;
            while i < out.len() {
                let (a, b) = (out[i - 1], out[i]);
                if b.mode != 0 { i += 1; continue; }
                let (ta, tb) = ((a.x - cx) * nx + (a.y - cy) * ny, (b.x - cx) * nx + (b.y - cy) * ny);
                if ta * tb > 0.0 || (ta - tb).abs() < 1e-3 { i += 1; continue; }
                let f = ta / (ta - tb); let (px, py) = (a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
                if ((px - cx) * -ny + (py - cy) * nx).abs() > half { i += 1; continue; }   // not through this doorway
                let dir = if tb > ta { 1.0f32 } else { -1.0 }; let far = if half > 3.5 { 3.8f32 } else { 6.0 };   // (a route that would step off the side halfway along is carried on to the far end of the doorway first)
                let mut mids: Vec<f32> = ts.iter().copied().filter(|&t| dir * t > dir * ta + 1.5 && dir * t <= (dir * tb - 1.5).max(far)).collect();
                if dir < 0.0 { mids.reverse(); }
                let ub = -(b.x - cx) * ny + (b.y - cy) * nx;
                if dir * tb < far && i + 1 < out.len() && ub.abs() <= half + 1.0 { out.remove(i); }   // (the waypoint where it stepped off the side is no longer wanted)
                let ins: Vec<Wp> = mids.iter().map(|&t| Wp { x: cx + nx * t, y: cy + ny * t, mode: 0 }).collect();
                let n = ins.len();
                for (k, w) in ins.into_iter().enumerate() { out.insert(i + k, w); }
                i += n + 1;
            }
        }
        out
    }

    pub(crate) fn march_speed(&self, units: &[u32; NK]) -> f32 {
        let horse = self.cavalry_speed_percent() as f32 / 100.0;
        let mut m = f32::MAX; for k in 0..NK { if units[k] > 0 { m = m.min(if k == 3 { UNITS[k].speed * horse } else { UNITS[k].speed }); } }
        if m == f32::MAX { 3.0 } else { m * 1.65 }
    }

    fn army_walk_speed(&self, base: f32, x: f32, y: f32, forest: f32, road: Option<u8>) -> f32 {
        let familiarity = if self.in_territory_by(x, y, false) { HOME_MARCH_SPEED } else { 1.0 };
        base * familiarity * match road { Some(level) => ARMY_ROAD_SPEED * pathnet::tier_speed(level), None => 1.0 / (1.0 + 0.06 * forest) }
    }

    /// Who marches as the army proper and who apart from it. With foot soldiers along, knights and siege engines each make a group of their own; an army of riders or engines alone is one body.
    pub(crate) fn split_groups(units: &[u32; NK]) -> ([u32; NK], Vec<[u32; NK]>) {
        if units[0] + units[1] + units[2] == 0 || units[3] + units[4] + units[5] == 0 { return (*units, vec![]); }
        let mut head = *units; head[3] = 0; head[4] = 0; head[5] = 0;
        let mut g = vec![];
        if units[3] > 0 { g.push([0, 0, 0, units[3], 0, 0]); }
        if units[4] + units[5] > 0 { g.push([0, 0, 0, 0, units[4], units[5]]); }
        (head, g)
    }

    fn det_index(&self, id: u32) -> Option<usize> { self.dets.iter().position(|d| d.id == id) }

    /// A single reverse search from the path entry gives each muster position its own shortest local approach.
    fn muster_approaches(&self, ns: &NavStatic, anchor: (f32, f32), units: &[u32; NK], heading: f32, occupied: &[(f32, f32)]) -> Vec<Vec<FilePoint>> {
        let count = units.iter().sum::<u32>() as usize;
        let engine_start = count - (units[4] + units[5]) as usize;
        let step = MarchFile::formation_spacing(units);
        let room = if units[4] + units[5] > 0 { 0.95 } else { members::FOOT_MARGIN };
        let radius = ((count as f32).sqrt().ceil() as i32 + 2).clamp(3, 24);
        let side = 2 * radius + 1;
        let center = (radius * side + radius) as usize;
        let (sin, cos) = heading.sin_cos();
        let p = |i: usize| {
            let (x, y) = ((i as i32 % side - radius) as f32 * step, (i as i32 / side - radius) as f32 * step);
            (anchor.0 + x * cos - y * sin, anchor.1 + x * sin + y * cos)
        };
        let obst = self.obst();
        let terrain = self.ground_samples();
        let walk = |a, b| self.walk_segment_with(ns, &obst, a, b, room, if room > 0.6 { 0.85 } else { 1.6 }, false, |x, y| terrain.height(self, x, y));
        let net = self.net();
        let entrances: Vec<_> = net.nodes.iter().position(|&p| p == anchor).into_iter()
            .flat_map(|i| &net.adj[i]).map(|&(i, _, _)| net.nodes[i as usize])
            .filter(|&p| (p.0 - anchor.0).hypot(p.1 - anchor.1) < 9.0 && walk(p, anchor)).collect();
        let mut dist = vec![f32::MAX; (side * side) as usize];
        let mut from = vec![usize::MAX; dist.len()];
        let mut open = BinaryHeap::new();
        let wanted = count.saturating_sub(occupied.len());
        if wanted == 0 { return vec![]; }
        let mut approaches: Vec<Vec<FilePoint>> = Vec::with_capacity(wanted);
        dist[center] = 0.0;
        open.push(Node { f: 0.0, i: center as u32 });
        while let Some(Node { f, i }) = open.pop() {
            let i = i as usize;
            if f > dist[i] { continue; }
            let start = p(i);
            let rank = occupied.len() + approaches.len();
            let room_between_engines = rank < engine_start || occupied.iter().copied()
                .chain(approaches.iter().map(|p| (p[0].wp.x, p[0].wp.y))).skip(engine_start)
                .all(|(x, y)| (start.0 - x).hypot(start.1 - y) >= SIEGE_SPACING * 0.94);
            if room_between_engines && occupied.iter().all(|&(x, y)| (start.0 - x).hypot(start.1 - y) >= step * 0.94) {
                let direct = (start.0 - anchor.0).hypot(start.1 - anchor.1);
                let base_length = if walk(start, anchor) { direct } else { f };
                let entry = if i == center { None } else {
                    entrances.iter().copied().map(|q| ((start.0 - q.0).hypot(start.1 - q.1), q))
                        .filter(|&(d, q)| d < base_length && walk(start, q)).min_by(|a, b| a.0.total_cmp(&b.0)).map(|(_, q)| q)
                };
                let path = if let Some(q) = entry { vec![start, q, anchor] }
                    else if base_length == direct && i != center { vec![start, anchor] }
                    else {
                        let mut path = vec![start];
                        let mut at = i;
                        while at != center { at = from[at]; path.push(p(at)); }
                        path
                    };
                approaches.push(MarchFile::approach(path));
                if approaches.len() == wanted { break; }
            }
            let (x, y) = (i as i32 % side, i as i32 / side);
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let (x, y) = (x + dx, y + dy);
                if !(0..side).contains(&x) || !(0..side).contains(&y) { continue; }
                let j = (y * side + x) as usize;
                let next = f + step * if dx != 0 && dy != 0 { std::f32::consts::SQRT_2 } else { 1.0 };
                if next < dist[j] && walk(p(i), p(j)) {
                    dist[j] = next; from[j] = i; open.push(Node { f: next, i: j as u32 });
                }
            }
        }
        approaches
    }

    // ---------------------------------------------------------------- commands
    /// Take soldiers out of the barracks into a new field army. Returns its id, or 0 if impossible.
    pub(crate) fn det_form_inner(&mut self, units: [u32; NK]) -> u32 {
        if units.iter().all(|&u| u == 0) || (0..NK).any(|k| units[k] > self.army[k]) { return 0; }
        self.det_muster(units, 0)
    }

    /// Where a new field army is mustered: (0 the barracks, 1 the castle, the point the player set for it or else the default outside it). A castle takes over from a barracks that stands within
    /// its walls (or in the shadow of them), so an army never forms beside a wall it cannot get through.
    pub(crate) fn muster_target(&self) -> (usize, (f32, f32)) {
        let hall = &self.buildings[0];
        let castle = hall.kind == TOWN_HALL && hall.tier >= 3;
        let (hx, hy) = (hall.x, hall.y);
        let slot = self.buildings.iter().find(|b| b.kind == BARRACKS).map_or((hx + 10.0, hy + 10.0), |b| (b.x, b.y + 8.0));
        let inside = |p: (f32, f32)| (p.0 - hx).hypot(p.1 - hy) < crate::compound::extent(TOWN_HALL, hall.tier);
        if castle && inside(slot) { return (1, self.rally[1].unwrap_or_else(|| self.default_rally(1))); }
        (0, self.rally[0].unwrap_or(slot))
    }

    /// The nearest place to (x, y) where foot soldiers can stand.
    pub(crate) fn free_spot(&self, x: f32, y: f32) -> Option<(f32, f32)> { let (ns, ov) = (nav_static(self.seed), self.ov()); self.near_free(&ns, &ov, x, y, 0).map(cell_xy) }

    /// The rally point a building has when the player has not chosen one: the barracks' own doorstep, the castle's front gate.
    pub(crate) fn default_rally(&self, which: usize) -> (f32, f32) {
        let hall = &self.buildings[0];
        if which == 1 { return crate::compound::at(hall, (0.0, 31.0)); }
        self.buildings.iter().find(|b| b.kind == BARRACKS).map_or((hall.x + 10.0, hall.y + 10.0), |b| (b.x, b.y + 8.0))
    }

    /// Put a field army on the ground at the barracks (or the castle gate). `ally` 0: our own soldiers, taken from the standing army. Otherwise guests of that allied village, who come from elsewhere.
    pub(crate) fn det_muster(&mut self, units: [u32; NK], ally: i32) -> u32 {
        let ns = nav_static(self.seed); let ov = self.ov();
        let siege = if units[4] + units[5] > 0 { 1 } else { 0 };
        let (which, target) = self.muster_target();
        let Some(cell) = self.near_free(&ns, &ov, target.0, target.1, siege) else { return 0; };
        let custom = self.rally[which].is_some();
        let spawn = cell_xy(cell);
        let net = self.net(); let obst = self.obst();
        let distance = |p: (f32, f32)| (p.0 - spawn.0).hypot(p.1 - spawn.1);
        let roomy = units[4] + units[5] > 0;
        let walk = |a, b| self.walk_segment(&ns, &obst, a, b, if roomy { 0.95 } else { members::FOOT_MARGIN }, if roomy { 0.85 } else { 1.6 }, false);
        let mut nodes: Vec<_> = net.nodes.iter().copied().enumerate().filter_map(|(i, p)| {
            let d = distance(p);
            (!net.adj[i].is_empty() && d <= 22.0).then_some((d, p))
        }).collect();
        nodes.sort_by(|a, b| a.0.total_cmp(&b.0));
        let entry = nodes.iter().find(|&&(_, p)| walk(spawn, p)).or_else(|| {
            nodes.iter().take(5).find(|&&(_, p)| walk(p, p) && self.route_in_window(&[1, 0, 0, 0, 0, 0], spawn.0, spawn.1, p.0, p.1, 12.0, WaterTravel::Dry, 0).is_ok())
        });
        let (x, y) = if custom { spawn } else { entry.map_or(spawn, |&(_, p)| p) };   // (a rally point the player chose is where the army stands; the default is the road node outside)
        let (x, y) = if self.member_blocked_inner(x, y, siege) { spawn } else { (x, y) };
        let mut file = MarchFile::default();
        file.record(x, y, 0);
        file.assign_approaches(self.muster_approaches(&ns, (x, y), &units, 0.0, &[]), &units);
        if ally == 0 {
            if !self.battle_release_army(units) { return 0; }
            for k in 0..NK { self.army[k] -= units[k]; }
        }
        self.next_det += 1;
        self.dets.push(Det { id: self.next_det, ally, units, x, y, path: vec![], wi: 0, state: S_IDLE, phase: 0, work: 0.0, work_total: 0.0, sx: x, sy: y, atk: None, home: false, heading: 0.0, speed: 0.0, since_fell: 0.0, defend: false, grp: vec![], file, destination: None, blocked_stamp: 0, retry_at: 0, retry_n: 0 });
        self.next_det
    }

    /// Order a field army to march. `attack` = the position of the village it is going to attack.
    pub(crate) fn det_march_inner(&mut self, id: u32, tx: f32, ty: f32, attack: Option<(f32, f32)>, home: bool) -> i32 {
        self.det_march_mode(id, tx, ty, attack, home, false)
    }

    pub(crate) fn det_march_mode(&mut self, id: u32, tx: f32, ty: f32, attack: Option<(f32, f32)>, home: bool, cached_only: bool) -> i32 {
        let Some(ix) = self.det_index(id) else { return -1; };
        if self.dets[ix].ally != 0 { return -1; }   // guests are not ours to order about
        if cached_only && self.dets[ix].state == S_FIGHT { return ROUTE_PENDING; }
        self.det_disengage(id);   // an army in the fight breaks off to go where it is told
        let Some(i) = self.det_index(id) else { return -1 };
        let mut d = self.dets[i].clone();
        if let Err(e) = self.set_march_route(&mut d, tx, ty, cached_only) { return e; }
        d.state = if home { S_HOME } else { S_MARCH };
        d.atk = attack; d.home = home; d.defend = false;
        d.retry_at = 0; d.retry_n = 0;   // a new order: no waiting left over from being stuck
        self.dets[i] = d;
        0
    }

    fn set_march_route(&self, d: &mut Det, tx: f32, ty: f32, cached_only: bool) -> Result<(), i32> {
        let (u, x, y) = (d.units, d.x, d.y);
        if d.state == S_FERRY && self.member_blocked_inner(x, y, 0) { return Err(-2); }
        let (hu, gus) = Self::split_groups(&u);
        let route_units = if u[4] + u[5] > 0 { u } else { hu };
        let path = self.order_path(&route_units, x, y, tx, ty, false, cached_only)?;
        if d.state == S_FORMATION { d.file.hold_formation(&u); }
        let mut groups = Vec::new();
        let unstarted = d.grp.is_empty() && d.file.mustered() && d.file.points[0].wp.x == x && d.file.points[0].wp.y == y;
        let head_count = hu.iter().sum::<u32>() as usize;
        let mut next_rank = head_count;
        for (i, gu) in gus.into_iter().enumerate() {
            let old = d.grp.iter().find(|g| (g.units[3] > 0) == (gu[3] > 0));
            let (gx, gy) = old.map_or((x, y), |g| (g.x, g.y));
            let (route, tied) = match self.order_path(&gu, gx, gy, tx, ty, false, cached_only) {
                Ok(q) if q.iter().all(|w| w.mode == 0) => (q, false),
                Err(ROUTE_PENDING) => return Err(ROUTE_PENDING),
                _ if (gx, gy) == (x, y) => (path.clone(), true),
                _ => {
                    let mut join = self.order_path(&gu, gx, gy, x, y, true, cached_only)?;
                    if !join.last().is_some_and(|p| (p.x - x).hypot(p.y - y) < 0.001) { return Err(-2); }
                    join.extend_from_slice(&path[1..]);
                    (join, true)
                }
            };
            let mut file = old.filter(|g| g.file.in_flight(&g.units)).map_or_else(MarchFile::default, |g| g.file.clone());
            file.record(gx, gy, 0);
            if unstarted {
                let count = gu.iter().sum::<u32>() as usize;
                file.assign_approaches(d.file.approaches.iter().skip(next_rank).take(count).cloned().collect(), &gu);
                next_rank += count;
            }
            groups.push(Grp { units: gu, x: gx, y: gy, path: route, wi: 1, heading: 0.0, speed: 0.0, tied, file, delay: if old.is_none() { i as u8 + 1 } else { 0 } });
        }
        if unstarted {
            let mut approaches = std::mem::take(&mut d.file.approaches);
            approaches.truncate(head_count);
            d.file.assign_approaches(approaches, &hu);
        } else if d.file.points.last().is_some_and(|p| (p.wp.x, p.wp.y) != (x, y))
            || (matches!(d.state, S_IDLE | S_ARRIVED | S_FIGHT) && !d.file.in_flight(&Self::head_units(d))) {
            d.file = Default::default();
        }
        d.file.record(x, y, 0);
        d.grp = groups; d.path = path; d.wi = 1; d.phase = 0; d.sx = x; d.sy = y;
        d.destination = Some((tx, ty));
        Ok(())
    }

    pub(crate) fn det_split_inner(&mut self, id: u32, take: [u32; NK]) -> u32 {
        let Some(i) = self.det_index(id) else { return 0 };
        let d = self.dets[i].clone();
        if d.state == S_FIGHT || d.ally != 0 { return 0; }
        if take.iter().all(|&u| u == 0) || (0..NK).any(|k| take[k] > d.units[k]) || (0..NK).all(|k| take[k] == d.units[k]) { return 0; }
        for k in 0..NK { self.dets[i].units[k] -= take[k]; }
        self.next_det += 1;
        self.dets[i].grp.clear();
        let mut n = d;
        n.id = self.next_det;
        if n.file.mustered() && matches!(n.state, S_IDLE | S_ARRIVED | S_FORMATION) {
            if n.state == S_FORMATION {
                n.file.hold_formation(&n.units);
                n.state = if n.atk.is_some() { S_ARRIVED } else { S_IDLE };
            }
            let kept = &mut self.dets[i];
            let mut approaches = std::mem::take(&mut n.file.approaches);
            let kept_count = kept.units.iter().sum::<u32>() as usize;
            let split = approaches.split_off(kept_count.min(approaches.len()));
            kept.state = n.state;
            kept.file.assign_approaches(approaches, &kept.units);
            n.file.assign_approaches(split, &take);
        }
        n.units = take;
        n.grp.clear();
        self.dets.push(n);
        self.next_det
    }

    pub(crate) fn det_merge_inner(&mut self, a: u32, b: u32) -> bool {
        let (Some(i), Some(j)) = (self.det_index(a), self.det_index(b)) else { return false };
        if i == j || self.dets[i].state == S_FIGHT || self.dets[j].state == S_FIGHT || self.dets[i].ally != 0 || self.dets[j].ally != 0 || ((self.dets[i].x - self.dets[j].x).powi(2) + (self.dets[i].y - self.dets[j].y).powi(2)).sqrt() > 10.0 { return false; }
        let u = self.dets[j].units; for k in 0..NK { self.dets[i].units[k] += u[k]; }
        self.dets.remove(j); let i = self.det_index(a).unwrap(); self.dets[i].state = S_IDLE; self.dets[i].path.clear(); self.dets[i].grp.clear(); self.dets[i].file = Default::default(); true
    }

    /// Hand an arrived army over to the attack on another village. Returns its soldiers.
    pub(crate) fn det_send_inner(&mut self, id: u32) -> Option<[u32; NK]> {
        let i = self.det_index(id)?; if self.dets[i].state == S_FIGHT || self.dets[i].ally != 0 { return None; } let u = self.dets[i].units; self.dets.remove(i);
        for k in 0..NK { self.away[k] += u[k]; } Some(u)
    }

    // ---------------------------------------------------------------- simulation (one tick = one game second)
    pub(crate) fn march_step(&mut self) {
        if self.dets.is_empty() { return; }   // no field armies: no need to build the navigation grid
        let ns = nav_static(self.seed);
        let obst = self.obst();
        let stamp = self.navigation_stamp();
        let terrain = self.ground_samples();
        let walk = |w: &World, a, b, lend| obst.movement_clear(a, b, members::FOOT_MARGIN)
            && w.walk_surface_with(&ns, &obst, a, b, 1.6, lend, |x, y| terrain.height(w, x, y));
        let leg = |w: &World, a, b| if walk(w, a, b, false) { Leg::Clear } else if walk(w, a, b, true) { Leg::WaitingForDeck } else { Leg::Blocked };
        let mut dets = std::mem::take(&mut self.dets);
        dets.retain_mut(|mut d| {
            let mut remove = false;
            // An army (or some of its riders and engines) standing where nobody can stand, because a castle, a wall or a house was raised over it, can never walk out: every step it tries is blocked.
            // It is set down on the nearest free ground and finds its way again from there.
            if d.state != S_FIGHT && (d.state == S_BLOCKED || self.tick % 4 == 0)
                && (self.member_blocked_inner(d.x, d.y, 0) || d.grp.iter().any(|g| self.member_blocked_inner(g.x, g.y, 0))) {
                self.unstick(&ns, &mut d);
            }
            if matches!(d.state, S_IDLE | S_ARRIVED | S_FORMATION) && d.file.mustered()
                && !d.file.check_formation(stamp, |a, b| walk(self, (a.x, a.y), (b.x, b.y), false))
            {
                d.file = self.arrival_formation(&ns, (d.x, d.y), d.heading, &d.units);
                if d.state != S_FORMATION {
                    let approaches = std::mem::take(&mut d.file.approaches);
                    d.file.assign_approaches(approaches, &d.units);
                }
            }
            if d.state == S_FORMATION {
                if d.file.formation_step(&d.units) { d.state = if d.atk.is_some() { S_ARRIVED } else { S_IDLE }; }
                return true;
            }
            if d.state == S_BLOCKED && self.tick >= d.retry_at {   // (it tries again when its wait is over, whether or not the village changed: a stuck army must never stay stuck for good)
                d.blocked_stamp = 0;   // ...and plans its way afresh when it does (`recover_march` only re-plans when the village is not the one it last failed in)
                d.state = if d.home { S_HOME } else { S_MARCH };
            }
            let travelling = matches!(d.state, S_MARCH | S_FELL | S_BRIDGE | S_FERRY | S_WAIT | S_HOME);
            let hu = Self::head_units(&d);
            let base = self.march_speed(&hu);
            let check = |a: Wp, b: Wp| if b.mode == 2 {
                obst.solid_clear((a.x, a.y), (b.x, b.y), members::FOOT_MARGIN)
            } else { walk(self, (a.x, a.y), (b.x, b.y), false) };
            if travelling && (!d.file.check(stamp, &hu, check) || d.grp.iter_mut().any(|g| !g.file.check(stamp, &g.units, check))) {
                // The trail the soldiers follow crosses something that was not there when they passed (a castle raised over the muster ground, a wall built behind them), so it can never be walked
                // again: it is forgotten and the soldiers gather on the head of the army. If the way ahead is blocked the legs below find that and the army re-plans, as it always did.
                d.file = Default::default();
                for g in d.grp.iter_mut() { g.file = Default::default(); }
            }
            let mut blocked = false;
            if d.wi < d.path.len() && d.file.points.last().is_some_and(|p| (p.wp.x, p.wp.y) != (d.x, d.y)) { d.file = Default::default(); }
            if travelling && d.wi < d.path.len() && d.file.release(base) {
                let wp = d.path[d.wi];
                d.file.record(d.x, d.y, if d.state == S_FERRY { 2 } else { 0 });
                let workers = (hu[0] + hu[2]) as f32;
                let dens = ns.dens_at(d.x, d.y) as f32;
                match wp.mode {
                    0 => {
                        d.state = if d.home { S_HOME } else { S_MARCH };
                        // soldiers push through woods by cutting the trees that stand in their way: every tree within reach of the ground they are about to cover (and not already cut) is felled,
                        // which slows them a little, and the cleared strip stays open for the next army
                        let on_road = self.on_road(d.x, d.y);
                        let mut cut = false;
                        if !on_road && dens >= 1.0 && self.felled.len() < 4000 && leg(self, (d.x, d.y), (wp.x, wp.y)) == Leg::Clear {
                            let base_speed = base / (1.0 + 0.06 * dens);
                            let (dx, dy) = (wp.x - d.x, wp.y - d.y); let dl = dx.hypot(dy).max(1e-3); let reach = base_speed.min(dl);
                            for f in [0.0f32, 0.5, 1.0] {
                                let (px, py) = (d.x + dx / dl * reach * f, d.y + dy / dl * reach * f);
                                let ts = terrain::trees(self.seed, px - 6.5, py - 6.5, px + 6.5, py + 6.5);
                                for k in (0..ts.len()).step_by(5) {
                                    let (tx, ty) = (ts[k], ts[k + 1]);
                                    if (tx - px).hypot(ty - py) <= 6.0 && !self.felled.iter().any(|q| (q[0] - tx).hypot(q[1] - ty) < q[2]) { self.felled.push([tx, ty, 3.0]); cut = true; }
                                }
                            }
                            if cut { self.map_ver += 1; }
                        }
                        d.speed = self.army_walk_speed(base, d.x, d.y, dens, self.road_level(d.x, d.y)) * if cut { 0.8 } else { 1.0 };
                        blocked = Self::advance_path(&mut d, |a, b| leg(self, a, b)) == Leg::Blocked;
                    }
                    1 => {
                        d.state = S_FELL; d.speed = (0.35 * workers.max(1.0).powf(0.7)).clamp(0.45, base);
                        let (ox, oy) = (d.x, d.y);
                        match leg(self, (d.x, d.y), (wp.x, wp.y)) {
                            Leg::Clear => { Self::advance(&mut d, wp); d.file.record(d.x, d.y, 1); }
                            Leg::WaitingForDeck => d.speed = 0.0,
                            Leg::Blocked => blocked = true,
                        }
                        d.since_fell += ((d.x - ox).powi(2) + (d.y - oy).powi(2)).sqrt();
                        if d.since_fell >= 2.5 { d.since_fell = 0.0; if self.felled.len() < 600 { self.felled.push([d.x, d.y, 3.4]); self.map_ver += 1; } }
                    }
                    _ => {
                        if !obst.solid_clear((d.x, d.y), (wp.x, wp.y), members::FOOT_MARGIN) || !walk(self, (wp.x, wp.y), (wp.x, wp.y), false) {
                            let dst = d.destination.or_else(|| d.path.last().map(|p| (p.x, p.y)));
                            self.recover_march(&mut d, dst, stamp);
                            return true;
                        }
                        if d.phase == 0 {
                            d.sx = d.x; d.sy = d.y;
                            let len = ((wp.x - d.x).powi(2) + (wp.y - d.y).powi(2)).sqrt();
                            let total: u32 = d.units.iter().sum();
                            let (bridge, res, cost) = crossing_cost(len, self.field_bridge_count(), total);
                            if self.stock[res] < cost { if d.state != S_WAIT { d.state = S_WAIT; self.push_event(EV_NEEDMAT, res as i32, cost); } }
                            else {
                                self.stock[res] -= cost; d.phase = 1;
                                d.work = 0.0; d.work_total = if bridge { len * 2.5 / workers.max(1.0).powf(0.8) } else { 6.0 + len / 2.4 };
                                d.state = if bridge { S_BRIDGE } else { S_FERRY };
                            }
                        }
                        if d.phase == 1 {
                            d.work += 1.0;
                            if d.state == S_FERRY { let t = (d.work / d.work_total).min(1.0); d.x = d.sx + (wp.x - d.sx) * t; d.y = d.sy + (wp.y - d.sy) * t; d.heading = (wp.y - d.sy).atan2(wp.x - d.sx); d.file.record(d.x, d.y, 2); }
                            if d.work >= d.work_total {
                                if d.state == S_BRIDGE { self.army_bridge(d.sx, d.sy, wp.x, wp.y); self.map_ver += 1; d.phase = 2; }   // a real bridge of the village, like one the player builds (see `army_bridge`)
                                else {
                                    d.x = wp.x; d.y = wp.y; d.phase = 0;
                                    d.path[d.wi].mode = 3; // remember that tied files have a ferry available at this completed leg
                                    d.wi += 1; d.state = if d.home { S_HOME } else { S_MARCH };
                                }
                            }
                        } else if d.phase == 2 {
                            d.speed = base * 0.8;
                            if leg(self, (d.x, d.y), (wp.x, wp.y)) == Leg::Clear { Self::advance(&mut d, wp); d.file.record(d.x, d.y, 0); } else { blocked = true; }
                            if d.wi > 0 && d.path.get(d.wi).map_or(true, |w| (w.x - wp.x).abs() > 0.01 || (w.y - wp.y).abs() > 0.01) { d.phase = 0; d.state = if d.home { S_HOME } else { S_MARCH }; }
                        }
                    }
                }
                if d.wi >= d.path.len() { d.phase = 0; d.speed = 0.0; d.state = if d.home { S_HOME } else { S_MARCH }; }
            }
            let mut groups_done = true;
            if travelling && !d.grp.is_empty() {   // riders and engines go their own way, each at its own pace
                let passed = &d.path[..d.wi.min(d.path.len())];
                for g in d.grp.iter_mut() {
                    blocked |= self.step_group(&ns, g, passed, |a, b| leg(self, a, b), &obst) == Leg::Blocked;
                    groups_done &= g.wi >= g.path.len() && g.file.finish(&g.units, self.march_speed(&g.units));
                    g.file.trim(&g.units);
                }
            }
            d.file.trim(&hu);
            if blocked {
                let dst = d.destination.or_else(|| d.path.last().map(|p| (p.x, p.y)));
                self.recover_march(&mut d, dst, stamp);
            } else if travelling && d.wi >= d.path.len() && d.file.finish(&hu, base) && groups_done {   // everybody is there
                d.path.clear(); d.phase = 0; d.grp.clear(); d.file = Default::default(); d.destination = None;
                if d.home { for k in 0..NK { self.army[k] += d.units[k]; } remove = true; }
                else {
                    d.file = self.arrival_formation(&ns, (d.x, d.y), d.heading, &d.units);
                    d.state = if d.file.mustered() { S_FORMATION } else if d.atk.is_some() { S_ARRIVED } else { S_IDLE };
                }
            }
            if !remove { let (rx, ry) = (d.x, d.y); let scouts = d.units.iter().sum::<u32>() <= 4; self.reveal(rx, ry, if scouts { 120.0 } else { 70.0 }); }   // a small party travels light and sees further   // an army on the march lifts the fog round it
            !remove
        });
        self.dets = dets;
    }

    /// What is left of the army once its riders and engines are counted out: the foot soldiers, whose pace is the army's.
    pub(crate) fn head_units(d: &Det) -> [u32; NK] { let mut u = d.units; for g in &d.grp { for k in 0..NK { u[k] = u[k].saturating_sub(g.units[k]); } } u }

    fn navigation_stamp(&self) -> u64 {
        let mut stamp = self.net_stamp();
        for b in &self.bridges { for v in b { stamp = stamp.rotate_left(9) ^ v.to_bits() as u64; } }
        for b in self.buildings.iter().filter(|b| b.kind == DRAWBRIDGE) { stamp = stamp.rotate_left(9) ^ (b.progress > 0) as u64; }
        stamp
    }

    /// Set an army (and the groups of it that are stuck) down on the nearest free ground and give it a way again from there.
    fn unstick(&self, ns: &NavStatic, d: &mut Det) {
        let Some((x, y)) = self.free_spot(d.x, d.y) else { return };
        let head_blocked = self.member_blocked_inner(d.x, d.y, 0);
        if head_blocked { d.x = x; d.y = y; d.sx = x; d.sy = y; d.speed = 0.0; d.file = Default::default(); d.file.record(x, y, 0); }
        let (hx, hy) = (d.x, d.y);
        for g in d.grp.iter_mut() { if self.member_blocked_inner(g.x, g.y, 0) { g.x = hx; g.y = hy; g.speed = 0.0; g.file = Default::default(); g.file.record(hx, hy, 0); } }
        d.retry_at = 0; d.retry_n = 0; d.blocked_stamp = 0;
        if matches!(d.state, S_IDLE | S_ARRIVED | S_FORMATION) {
            d.file = self.arrival_formation(ns, (hx, hy), d.heading, &d.units);
            if d.state != S_FORMATION { let approaches = std::mem::take(&mut d.file.approaches); d.file.assign_approaches(approaches, &d.units); }
        } else if let Some((tx, ty)) = d.destination {
            if self.set_march_route(d, tx, ty, false).is_ok() { d.state = if d.home { S_HOME } else { S_MARCH }; }
        }
    }

    fn recover_march(&self, d: &mut Det, destination: Option<(f32, f32)>, stamp: u64) {
        let rerouted = d.blocked_stamp != stamp && destination.is_some_and(|(x, y)| self.set_march_route(d, x, y, false).is_ok());
        // A full route search can take a large share of a tick in a big village, and the roads change every few ticks while it grows: an army that
        // still finds no way waits longer each time before it searches again. A new order (march, recall) clears the wait.
        if rerouted { d.retry_n = 0; d.retry_at = 0; } else { d.retry_n = d.retry_n.saturating_add(1).min(8); d.retry_at = self.tick + (30u64 << d.retry_n.min(4)); }
        d.blocked_stamp = stamp;
        d.speed = 0.0;
        d.state = if !rerouted { S_BLOCKED } else if d.home { S_HOME } else { S_MARCH };
    }

    /// One tick of a group's march: at its own speed (slowed by woods, quickened on a road), along its own route. A tied group does not pass a place that needs felling or a crossing until the
    /// army has passed the matching waypoint.
    fn step_group(&self, ns: &NavStatic, g: &mut Grp, passed: &[Wp], leg: impl Fn((f32, f32), (f32, f32)) -> Leg, obst: &members::Obst) -> Leg {
        if g.wi >= g.path.len() || g.delay > 0 { g.speed = 0.0; g.delay = g.delay.saturating_sub(1); return Leg::Clear; }
        if !g.file.release(self.march_speed(&g.units)) { return Leg::Clear; }
        g.file.record(g.x, g.y, 0);
        let dens = ns.dens_at(g.x, g.y) as f32;
        g.speed = self.army_walk_speed(self.march_speed(&g.units), g.x, g.y, dens, self.road_level(g.x, g.y));
        let mut left = g.speed; let mut moved = false;
        while left > 1e-4 && g.wi < g.path.len() {
            let wp = g.path[g.wi];
            let crossed = |mode| passed.iter().any(|p| p.x == wp.x && p.y == wp.y && p.mode == mode);
            let ferry = g.tied && wp.mode == 2 && crossed(3);
            if g.tied && wp.mode != 0 && !ferry && !crossed(wp.mode) { break; }
            let mut mode = 0;
            match leg((g.x, g.y), (wp.x, wp.y)) {
                Leg::Clear => {},
                Leg::WaitingForDeck => break,
                Leg::Blocked if ferry && obst.solid_clear((g.x, g.y), (wp.x, wp.y), members::FOOT_MARGIN) => mode = 2,
                Leg::Blocked => return Leg::Blocked,
            }
            let (dx, dy) = (wp.x - g.x, wp.y - g.y); let dist = (dx * dx + dy * dy).sqrt();
            if dist > 0.01 { g.heading = dy.atan2(dx); }
            moved = true;
            if dist <= left { g.x = wp.x; g.y = wp.y; g.wi += 1; left -= dist; } else { g.x += dx / dist * left; g.y += dy / dist * left; left = 0.0; }
            g.file.record(g.x, g.y, mode);
        }
        if !moved { g.speed = 0.0; }
        Leg::Clear
    }

    /// Walk along the route for one tick's worth of distance, carrying on round the corners (what is left of the step after reaching a waypoint is walked towards the next), so the pace is the
    /// same whatever the route does. Only over ordinary ground: felling, bridging and ferrying have their own pace.
    fn advance_path(d: &mut Det, leg: impl Fn((f32, f32), (f32, f32)) -> Leg) -> Leg {
        let mut left = d.speed;
        while left > 1e-4 && d.wi < d.path.len() && d.path[d.wi].mode == 0 {
            let wp = d.path[d.wi]; let (dx, dy) = (wp.x - d.x, wp.y - d.y); let dist = (dx * dx + dy * dy).sqrt();
            let ready = leg((d.x, d.y), (wp.x, wp.y));
            if ready != Leg::Clear { d.speed = 0.0; return ready; }
            if dist > 0.01 { d.heading = dy.atan2(dx); }
            if dist <= left { d.x = wp.x; d.y = wp.y; d.wi += 1; left -= dist; } else { d.x += dx / dist * left; d.y += dy / dist * left; left = 0.0; }
            d.file.record(d.x, d.y, 0);
        }
        Leg::Clear
    }

    /// Move up to `speed` units towards the waypoint; step on to the next when reached.
    fn advance(d: &mut Det, wp: Wp) {
        let (dx, dy) = (wp.x - d.x, wp.y - d.y); let dist = (dx * dx + dy * dy).sqrt();
        if dist <= d.speed { d.x = wp.x; d.y = wp.y; d.wi += 1; } else { d.x += dx / dist * d.speed; d.y += dy / dist * d.speed; }
        if dist > 0.01 { d.heading = dy.atan2(dx); }
    }

    /// A planned route without giving any order: [ok, seconds, planks, wood, count, x, y, mode, ...].
    pub(crate) fn plan(&self, units: &[u32; NK], sx: f32, sy: f32, tx: f32, ty: f32) -> Vec<f32> {
        let (head, gus) = Self::split_groups(units);
        let route_units = if units[4] + units[5] > 0 { units } else { &head };
        match self.find_path(route_units, sx, sy, tx, ty) {
            Err(e) => vec![e as f32, 0.0, 0.0, 0.0, 0.0],
            Ok(p) => {
                let base = self.march_speed(&head); let workers = (head[0] + head[2]) as f32; let total: u32 = units.iter().sum();
                let (mut t, mut planks, mut wood, mut prev) = (0.0f32, 0i32, 0i32, (sx, sy));
                let mut bridges = self.field_bridge_count();
                let ns = nav_static(self.seed);
                for w in &p {
                    let len = ((w.x - prev.0).powi(2) + (w.y - prev.1).powi(2)).sqrt();
                    match w.mode {
                        0 if len > 0.0 => {
                            let (x, y) = ((prev.0 + w.x) * 0.5, (prev.1 + w.y) * 0.5);
                            t += len / self.army_walk_speed(base, x, y, ns.dens_at(x, y) as f32, self.road_level(x, y));
                        }
                        0 => {}
                        1 => t += len / (0.35 * workers.max(1.0).powf(0.7)).clamp(0.45, base),
                        _ => {
                            let (bridge, _, cost) = crossing_cost(len, bridges, total);
                            if bridge { planks += cost; bridges += 1; t += len * 2.5 / workers.max(1.0).powf(0.8) + len / (base * 0.8); }
                            else { wood += cost; t += 6.0 + len / 2.4; }
                        }
                    }
                    prev = (w.x, w.y);
                }
                t += MarchFile::lag(&head) / base;
                for gu in &gus { let gt = ((tx - sx).hypot(ty - sy) * 1.3 + MarchFile::lag(gu)) / self.march_speed(gu); if gt > t { t = gt; } }
                let mut v = vec![1.0, t, planks as f32, wood as f32, p.len() as f32];
                for w in &p { v.extend_from_slice(&[w.x, w.y, w.mode as f32]); }
                v
            }
        }
    }
}

#[cfg(test)]
mod nav_slices {
    use super::*;

    /// Building the grid a few rows at a time (so the page can breathe) must give exactly the grid built in one go, however it is cut.
    #[test]
    fn a_sliced_build_equals_the_blocking_build() {
        let seed = 4242u64;
        let mut calls = 0;
        while nav_build_step(seed, 211) < 1.0 { calls += 1; assert!(calls < 100); }
        assert!(calls >= 8, "it really was done in pieces ({calls})");
        let a = nav_static(seed);
        NAV.with(|c| *c.borrow_mut() = None);
        let b = nav_static(seed);
        assert!(!Rc::ptr_eq(&a, &b));
        assert!(a.h == b.h && a.slope == b.slope && a.dens == b.dens && a.tun == b.tun);
        // a different cut gives the same again
        NAV.with(|c| *c.borrow_mut() = None);
        while nav_build_step(seed, 977) < 1.0 {}
        let c = nav_static(seed);
        assert!(c.h == b.h && c.dens == b.dens);
    }

    /// The ground and the forest the page fetches a few rows at a time are exactly what the whole-map calls give.
    #[test]
    fn rows_of_the_ground_and_the_forest_join_up_exactly() {
        let seed = 99u64;
        let whole = terrain::grid(seed, -200.0, -200.0, 161, 161, 2.5);
        let mut parts = vec![]; let mut j = 0;
        while j < 161 { let k = (j + 7).min(161); parts.extend(terrain::grid_rows(seed, -200.0, -200.0, 161, 2.5, j, k)); j = k; }
        assert!(whole == parts);
        let all = terrain::trees(seed, -150.0, -150.0, 150.0, 150.0);
        let c = terrain::TREE_CELL; let (cy0, cy1) = ((-150.0 / c).floor() as i32, (150.0 / c).ceil() as i32);
        let (cx0, cx1) = ((-150.0 / c).floor() as i32, (150.0 / c).ceil() as i32);
        let mut cut = vec![]; let mut y = cy0;
        while y < cy1 { let k = (y + 5).min(cy1); cut.extend(terrain::trees_cells(seed, cx0, cx1, y, k)); y = k; }
        assert!(!all.is_empty() && all == cut);
    }
}

#[cfg(test)]
impl World {
    /// (test aid) Why is the first army not moving: each hop of its path against the checks the march step makes.
    pub(crate) fn diagnose_march(&self) {

        let ns = nav_static(self.seed); let obst = self.obst(); let terrain = self.ground_samples();
        let d = &self.dets[0];
        eprintln!("path from wi={}:", d.wi);
        for (i, p) in d.path.iter().enumerate() { eprintln!("  wp{} ({:.1},{:.1}) mode {}", i, p.x, p.y, p.mode); }
        let mut prev = (d.x, d.y);
        for (i, p) in d.path.iter().enumerate().skip(d.wi.saturating_sub(1)) {
            let b = (p.x, p.y);
            let mc = obst.movement_clear(prev, b, members::FOOT_MARGIN);
            let ws = self.walk_surface_with(&ns, &obst, prev, b, 1.6, false, |x, y| terrain.height(self, x, y));
            eprintln!("  hop to wp{} from ({:.1},{:.1}): movement_clear {} walk_surface {}", i, prev.0, prev.1, mc, ws);
            prev = b;
        }
        for (gi, g) in d.grp.iter().enumerate() { eprintln!("group {} units {:?} wi {}/{} at ({:.1},{:.1})", gi, g.units, g.wi, g.path.len(), g.x, g.y); for (i, p) in g.path.iter().enumerate() { eprintln!("   gwp{} ({:.1},{:.1}) mode {}", i, p.x, p.y, p.mode); } }
        for g in &d.grp {
            let mut prev = (g.x, g.y);
            eprintln!("  group at ({:.2},{:.2}) itself: movement_clear {} blocked_at_point {}", g.x, g.y, obst.movement_clear(prev, prev, members::FOOT_MARGIN), self.member_blocked(g.x, g.y, 0));
            for (i, p) in g.path.iter().enumerate().skip(g.wi) {
                let b = (p.x, p.y);
                let mc = obst.movement_clear(prev, b, members::FOOT_MARGIN);
                let ws = self.walk_surface_with(&ns, &obst, prev, b, 1.6, false, |x, y| terrain.height(self, x, y));
                let ws_lend = self.walk_surface_with(&ns, &obst, prev, b, 1.6, true, |x, y| terrain.height(self, x, y));
                eprintln!("  group hop to gwp{} from ({:.1},{:.1}): movement_clear {} walk_surface {} (lend {})", i, prev.0, prev.1, mc, ws, ws_lend);
                prev = b;
            }
        }
        {
            let walk = |a: Wp, b: Wp| obst.movement_clear((a.x, a.y), (b.x, b.y), members::FOOT_MARGIN) && self.walk_surface_with(&ns, &obst, (a.x, a.y), (b.x, b.y), 1.6, false, |x, y| terrain.height(self, x, y));
            let mut files: Vec<(String, &MarchFile, [u32; NK])> = vec![("army".to_string(), &d.file, Self::head_units(d))];
            for (gi, g) in d.grp.iter().enumerate() { files.push((format!("group {gi}"), &g.file, g.units)); }
            for (name, f, units) in files {
                let behind = f.dispatch - MarchFile::lag(&units);
                eprintln!("  file {name}: dispatch {:.1} behind {:.1} points {} approaches {}", f.dispatch, behind, f.points.len(), f.approaches.len());
                let start = f.points.partition_point(|p| p.dist < behind).saturating_sub(1);
                for w in f.points[start..].windows(2) { if !(w[1].dist <= behind || walk(w[0].wp, w[1].wp)) { eprintln!("    FAILS point segment ({:.1},{:.1}) -> ({:.1},{:.1}) dist {:.1}..{:.1}", w[0].wp.x, w[0].wp.y, w[1].wp.x, w[1].wp.y, w[0].dist, w[1].dist); } }
                for (rank, path) in f.approaches.iter().enumerate() {
                    let at = f.dispatch - rank as f32 * MarchFile::gap(&units);
                    for w in path.windows(2) { if !(w[1].dist <= at || walk(w[0].wp, w[1].wp)) { eprintln!("    FAILS approach {rank} segment ({:.1},{:.1}) -> ({:.1},{:.1}) dist {:.1}..{:.1} (at {:.1})", w[0].wp.x, w[0].wp.y, w[1].wp.x, w[1].wp.y, w[0].dist, w[1].dist, at); } }
                }
            }
        }
        for b in &self.buildings { eprintln!("building kind {} tier {} at ({:.0},{:.0}) rot {}", b.kind, b.tier, b.x, b.y, b.rot); }
    
    }
}

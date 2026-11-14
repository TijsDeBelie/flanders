//! Field armies: detachments that march across the map. Pathfinding goes around buildings, cliffs, water and (for siege
//! engines) dense forest. Soldiers fell trees to open a way for catapults, build bridges over narrow water and ferry
//! themselves across wide water. All of it is deterministic, so every peer sees the same march.
use super::*;
use crate::military::*;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::rc::Rc;

pub const CELL: f32 = 2.5;
pub const NC: i32 = 960; // cells per side, covering [-1200, 1200)
const ORG: f32 = -1200.0;
const MAX_FERRY: f32 = 64.0;
const BRIDGE_MAX: f32 = 12.0;

pub const S_IDLE: u8 = 0;
pub const S_MARCH: u8 = 1;
pub const S_FELL: u8 = 2;
pub const S_BRIDGE: u8 = 3;
pub const S_FERRY: u8 = 4;
pub const S_ARRIVED: u8 = 5;
pub const S_WAIT: u8 = 6;
pub const S_HOME: u8 = 7;

/// A waypoint; `mode` describes the leg that ends here: 0 walk, 1 fell trees, 2 cross water.
#[derive(Clone, Copy, Debug)]
pub struct Wp { pub x: f32, pub y: f32, pub mode: u8 }

#[derive(Clone)]
pub struct Det {
    pub id: u32,
    pub units: [u32; 5],
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
}

pub struct NavStatic { h: Vec<f32>, slope: Vec<f32>, dens: Vec<u8>, tun: Vec<bool> }

thread_local! { static NAV: RefCell<Option<(u64, Rc<NavStatic>)>> = const { RefCell::new(None) }; }

pub fn nav_static(seed: u64) -> Rc<NavStatic> {
    NAV.with(|c| {
        if let Some((s, n)) = &*c.borrow() { if *s == seed { return n.clone(); } }
        let n = NC as usize;
        let h = terrain::grid(seed, ORG + CELL / 2.0, ORG + CELL / 2.0, NC as u32, NC as u32, CELL);
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
        let mut cnt = vec![0u8; n * n];
        let t = terrain::trees(seed, ORG, ORG, -ORG, -ORG);
        for k in (0..t.len()).step_by(5) {
            let (ci, cj) = (((t[k] - ORG) / CELL) as i32, ((t[k + 1] - ORG) / CELL) as i32);
            if ci >= 0 && cj >= 0 && ci < NC && cj < NC { let q = &mut cnt[cj as usize * n + ci as usize]; *q = q.saturating_add(1); }
        }
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
        let ns = Rc::new(NavStatic { h, slope, dens, tun });
        *c.borrow_mut() = Some((seed, ns.clone()));
        ns
    })
}

impl NavStatic {
    pub fn dens_at(&self, x: f32, y: f32) -> u8 { self.idx(x, y).map_or(0, |i| self.dens[i]) }
    pub fn idx(&self, x: f32, y: f32) -> Option<usize> {
        let (i, j) = (((x - ORG) / CELL).floor() as i32, ((y - ORG) / CELL).floor() as i32);
        if i < 0 || j < 0 || i >= NC || j >= NC { None } else { Some((j * NC + i) as usize) }
    }
    pub fn height(&self, i: usize) -> f32 { self.h[i] }
    pub fn dens(&self, i: usize) -> u8 { self.dens[i] }
}

fn cell_xy(i: usize) -> (f32, f32) { ((i as i32 % NC) as f32 * CELL + ORG + CELL / 2.0, (i as i32 / NC) as f32 * CELL + ORG + CELL / 2.0) }

/// Per-request overlays: buildings, felled trees and bridges rasterised onto the grid.
struct Ov { blocked: Vec<bool>, cleared: Vec<bool>, bridge: Vec<bool>, moat: Vec<bool> }

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
    fn overlays(&self) -> Ov {
        let n = (NC * NC) as usize;
        let mut ov = Ov { blocked: vec![false; n], cleared: vec![false; n], bridge: vec![false; n], moat: vec![false; n] };
        for b in &self.buildings {
            match b.kind {
                GATE | ROAD => {}                                             // an opening in the wall, or a road: nothing blocks it
                MOAT | RIVER => stamp(&mut ov.moat, b.x, b.y, if b.kind == MOAT { MOAT_FLOOR * moat_scale(b) } else { RIVER_FLOOR } + 0.5),           // water to cross
                RAISE | LOWER => {}
                DRAWBRIDGE if b.status == 5 || self.battle.is_some() => {}   // drawn up: no way across
                DRAWBRIDGE => {                                               // a way across for your own armies
                    let a = b.rot as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (a.sin(), a.cos());
                    for k in -9..=9 { let t = k as f32 * 0.8; stamp(&mut ov.bridge, b.x + sx * t, b.y + sy * t, 1.6); }
                }
                _ => { let r = DEFS[b.kind as usize].r + if b.kind == WALL || b.kind == FENCE { 1.0 } else { 0.7 }; stamp(&mut ov.blocked, b.x, b.y, r); }
            }
        }
        for f in &self.felled { stamp(&mut ov.cleared, f[0], f[1], f[2]); }
        for br in &self.bridges {
            let (dx, dy) = (br[2] - br[0], br[3] - br[1]); let l = (dx * dx + dy * dy).sqrt().max(0.1); let steps = (l / 1.0).ceil() as i32;
            for k in 0..=steps { let t = k as f32 / steps as f32; stamp(&mut ov.bridge, br[0] + dx * t, br[1] + dy * t, 1.6); }
        }
        ov
    }

    fn classify(&self, ns: &NavStatic, ov: &Ov, i: usize, siege: bool) -> Cl {
        let (x, y) = cell_xy(i);
        if x.abs() > 1192.0 || y.abs() > 1192.0 || ov.blocked[i] { return Cl::Block; }
        if ns.tun[i] && !ov.moat[i] { return Cl::Free(1.3); }
        if (ns.h[i] < 0.2 || ov.moat[i]) && !ov.bridge[i] { return Cl::Water; }
        if ns.slope[i] > if siege { 0.85 } else { 1.6 } { return Cl::Block; }
        let d = if ov.cleared[i] { 0.0 } else { ns.dens[i] as f32 };
        if siege && d >= 2.0 { return Cl::Free(8.0 + d); }               // dense forest: needs felling
        Cl::Free(1.0 + 0.3 * d + ns.slope[i] * 1.2)
    }

    fn near_free(&self, ns: &NavStatic, ov: &Ov, x: f32, y: f32, siege: bool) -> Option<usize> {
        let c = ns.idx(x, y)?;
        let (ci, cj) = (c as i32 % NC, c as i32 / NC);
        for r in 0..8i32 { for dj in -r..=r { for di in -r..=r {
            if di.abs().max(dj.abs()) != r { continue; }
            let (a, b) = (ci + di, cj + dj); if a < 0 || b < 0 || a >= NC || b >= NC { continue; }
            let k = (b * NC + a) as usize; if let Cl::Free(_) = self.classify(ns, ov, k, siege) { return Some(k); }
        } } }
        None
    }

    /// Find a route. Err codes: -2 unreachable, -3 siege engines need soldiers to clear the forest, -5 water too wide.
    pub(crate) fn find_path(&self, units: &[u32; 5], sx: f32, sy: f32, tx: f32, ty: f32) -> Result<Vec<Wp>, i32> {
        let ns = nav_static(self.seed); let ov = self.overlays();
        let siege = units[4] > 0; let workers = units[0] + units[2];
        let (Some(s), Some(g)) = (self.near_free(&ns, &ov, sx, sy, siege), self.near_free(&ns, &ov, tx, ty, siege)) else { return Err(-2) };
        let n = (NC * NC) as usize;
        let mut gc = vec![f32::MAX; n]; let mut from = vec![u32::MAX; n];
        let mut heap = BinaryHeap::new();
        let (gx, gy) = cell_xy(g);
        let hfn = |i: usize| { let (x, y) = cell_xy(i); let (dx, dy) = ((x - gx).abs(), (y - gy).abs()); (dx.max(dy) + 0.414 * dx.min(dy)) / CELL };
        gc[s] = 0.0; heap.push(Node { f: hfn(s), i: s as u32 });
        let mut found = false;
        while let Some(Node { i, .. }) = heap.pop() {
            let i = i as usize;
            if i == g { found = true; break; }
            let (ci, cj) = (i as i32 % NC, i as i32 / NC);
            for (di, dj) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let (a, b) = (ci + di, cj + dj); if a < 0 || b < 0 || a >= NC || b >= NC { continue; }
                let k = (b * NC + a) as usize;
                let step = match self.classify(&ns, &ov, k, siege) { Cl::Block => continue, Cl::Free(c) => c, Cl::Water => 4.5 };
                if di != 0 && dj != 0 {   // no cutting corners through blocked cells
                    if self.classify(&ns, &ov, (cj * NC + a) as usize, siege) == Cl::Block || self.classify(&ns, &ov, (b * NC + ci) as usize, siege) == Cl::Block { continue; }
                }
                let ng = gc[i] + step * if di != 0 && dj != 0 { 1.414 } else { 1.0 };
                if ng < gc[k] { gc[k] = ng; from[k] = i as u32; heap.push(Node { f: ng + hfn(k), i: k as u32 }); }
            }
        }
        if !found { return Err(-2); }
        let mut cells = vec![g]; let mut c = g; while from[c] != u32::MAX { c = from[c] as usize; cells.push(c); } cells.reverse();
        let mode_of = |i: usize| -> u8 {
            match self.classify(&ns, &ov, i, siege) { Cl::Water => 2, Cl::Free(c) if c >= 8.0 => 1, _ => 0 }
        };
        // runs of equal terrain, each simplified by line of sight
        let mut wps: Vec<Wp> = vec![Wp { x: sx, y: sy, mode: 0 }];
        let mut start = 0usize;
        while start < cells.len() {
            let m = mode_of(cells[start]); let mut end = start; while end + 1 < cells.len() && mode_of(cells[end + 1]) == m { end += 1; }
            let run: Vec<(f32, f32)> = cells[start..=end].iter().map(|&i| cell_xy(i)).collect();
            let los = |a: (f32, f32), b: (f32, f32)| -> bool {
                let l = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt(); let st = (l / (CELL * 0.5)).ceil().max(1.0) as i32;
                (0..=st).all(|q| { let t = q as f32 / st as f32; ns.idx(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t).map_or(false, |k| mode_of(k) == m && self.classify(&ns, &ov, k, siege) != Cl::Block) })
            };
            let mut a = 0usize; let mut pts: Vec<(f32, f32)> = vec![];
            while a < run.len() - 1 { let mut b = run.len() - 1; while b > a + 1 && !los(run[a], run[b]) { b -= 1; } pts.push(run[b]); a = b; }
            if run.len() == 1 { pts.push(run[0]); }
            for p in pts { wps.push(Wp { x: p.0, y: p.1, mode: m }); }
            start = end + 1;
        }
        // the very last point is the exact target when it is reachable on foot
        if let Some(l) = wps.last_mut() { if l.mode == 0 && ns.idx(tx, ty).map_or(false, |k| k == g) { l.x = tx; l.y = ty; } }
        // checks: water too wide, felling without workers
        let mut prev = (sx, sy);
        for w in &wps {
            let len = ((w.x - prev.0).powi(2) + (w.y - prev.1).powi(2)).sqrt();
            if w.mode == 2 && len > MAX_FERRY { return Err(-5); }
            if w.mode == 1 && workers == 0 { return Err(-3); }
            prev = (w.x, w.y);
        }
        Ok(wps)
    }

    fn march_speed(units: &[u32; 5]) -> f32 {
        let mut m = f32::MAX; for k in 0..5 { if units[k] > 0 { m = m.min(UNITS[k].speed); } }
        if m == f32::MAX { 3.0 } else { m * 1.1 }
    }

    fn det_index(&self, id: u32) -> Option<usize> { self.dets.iter().position(|d| d.id == id) }

    // ---------------------------------------------------------------- commands
    /// Take soldiers out of the barracks into a new field army. Returns its id, or 0 if impossible.
    pub(crate) fn det_form_inner(&mut self, units: [u32; 5]) -> u32 {
        if units.iter().all(|&u| u == 0) || (0..5).any(|k| units[k] > self.army[k]) { return 0; }
        for k in 0..5 { self.army[k] -= units[k]; }
        self.next_det += 1;
        let (hx, hy) = (self.buildings[0].x, self.buildings[0].y);
        let (bx, by) = self.buildings.iter().find(|b| b.kind == BARRACKS).map_or((hx + 10.0, hy + 10.0), |b| (b.x, b.y + 8.0));
        let ns = nav_static(self.seed); let ov = self.overlays();
        let (x, y) = self.near_free(&ns, &ov, bx, by, units[4] > 0).map_or((bx, by), cell_xy);
        self.dets.push(Det { id: self.next_det, units, x, y, path: vec![], wi: 0, state: S_IDLE, phase: 0, work: 0.0, work_total: 0.0, sx: x, sy: y, atk: None, home: false, heading: 0.0, speed: 0.0, since_fell: 0.0 });
        self.next_det
    }

    /// Order a field army to march. `attack` = the position of the village it is going to attack.
    pub(crate) fn det_march_inner(&mut self, id: u32, tx: f32, ty: f32, attack: Option<(f32, f32)>, home: bool) -> i32 {
        let Some(i) = self.det_index(id) else { return -1 };
        let (u, x, y) = (self.dets[i].units, self.dets[i].x, self.dets[i].y);
        match self.find_path(&u, x, y, tx, ty) {
            Ok(p) => { let d = &mut self.dets[i]; d.path = p; d.wi = 1; d.state = if home { S_HOME } else { S_MARCH }; d.phase = 0; d.atk = attack; d.home = home; d.sx = x; d.sy = y; 0 }
            Err(e) => e,
        }
    }

    pub(crate) fn det_split_inner(&mut self, id: u32, take: [u32; 5]) -> u32 {
        let Some(i) = self.det_index(id) else { return 0 };
        let d = self.dets[i].clone();
        if take.iter().all(|&u| u == 0) || (0..5).any(|k| take[k] > d.units[k]) || (0..5).all(|k| take[k] == d.units[k]) { return 0; }
        for k in 0..5 { self.dets[i].units[k] -= take[k]; }
        self.next_det += 1;
        let mut n = d; n.id = self.next_det; n.units = take; self.dets.push(n);
        self.next_det
    }

    pub(crate) fn det_merge_inner(&mut self, a: u32, b: u32) -> bool {
        let (Some(i), Some(j)) = (self.det_index(a), self.det_index(b)) else { return false };
        if i == j || ((self.dets[i].x - self.dets[j].x).powi(2) + (self.dets[i].y - self.dets[j].y).powi(2)).sqrt() > 10.0 { return false; }
        let u = self.dets[j].units; for k in 0..5 { self.dets[i].units[k] += u[k]; }
        self.dets.remove(j); let i = self.det_index(a).unwrap(); self.dets[i].state = S_IDLE; self.dets[i].path.clear(); true
    }

    /// Hand an arrived army over to the attack on another village. Returns its soldiers.
    pub(crate) fn det_send_inner(&mut self, id: u32) -> Option<[u32; 5]> {
        let i = self.det_index(id)?; let u = self.dets[i].units; self.dets.remove(i);
        for k in 0..5 { self.away[k] += u[k]; } Some(u)
    }

    // ---------------------------------------------------------------- simulation (one tick = one game second)
    pub(crate) fn march_step(&mut self) {
        if self.dets.is_empty() { return; }   // no field armies: no need to build the navigation grid
        let ns = nav_static(self.seed);
        let mut i = 0;
        while i < self.dets.len() {
            let mut d = self.dets[i].clone();
            let mut remove = false;
            if matches!(d.state, S_MARCH | S_FELL | S_BRIDGE | S_FERRY | S_WAIT | S_HOME) && d.wi < d.path.len() {
                let wp = d.path[d.wi];
                let base = Self::march_speed(&d.units);
                let workers = (d.units[0] + d.units[2]) as f32;
                let dens = ns.dens_at(d.x, d.y) as f32;
                match wp.mode {
                    0 => { d.state = if d.home { S_HOME } else { S_MARCH }; d.speed = base / (1.0 + 0.3 * dens); Self::advance(&mut d, wp); }
                    1 => {
                        d.state = S_FELL; d.speed = (0.35 * workers.max(1.0).powf(0.7)).clamp(0.45, base);
                        let (ox, oy) = (d.x, d.y);
                        Self::advance(&mut d, wp);
                        d.since_fell += ((d.x - ox).powi(2) + (d.y - oy).powi(2)).sqrt();
                        if d.since_fell >= 2.5 { d.since_fell = 0.0; if self.felled.len() < 600 { self.felled.push([d.x, d.y, 3.4]); self.map_ver += 1; } }
                    }
                    _ => {
                        if d.phase == 0 {
                            d.sx = d.x; d.sy = d.y;
                            let len = ((wp.x - d.x).powi(2) + (wp.y - d.y).powi(2)).sqrt();
                            let total: u32 = d.units.iter().sum();
                            let (res, cost) = if len <= BRIDGE_MAX { (PL as usize, (len * 1.5).ceil() as i32) } else { (W as usize, 10 + total as i32 / 3) };
                            if self.stock[res] < cost { if d.state != S_WAIT { d.state = S_WAIT; self.push_event(EV_NEEDMAT, res as i32, cost); } }
                            else {
                                self.stock[res] -= cost; d.phase = 1;
                                d.work = 0.0; d.work_total = if len <= BRIDGE_MAX { len * 2.5 / workers.max(1.0).powf(0.8) } else { 6.0 + len / 2.4 };
                                d.state = if len <= BRIDGE_MAX { S_BRIDGE } else { S_FERRY };
                            }
                        }
                        if d.phase == 1 {
                            d.work += 1.0;
                            if d.state == S_FERRY { let t = (d.work / d.work_total).min(1.0); d.x = d.sx + (wp.x - d.sx) * t; d.y = d.sy + (wp.y - d.sy) * t; d.heading = (wp.y - d.sy).atan2(wp.x - d.sx); }
                            if d.work >= d.work_total {
                                if d.state == S_BRIDGE && self.bridges.len() < 60 { self.bridges.push([d.sx, d.sy, wp.x, wp.y]); self.map_ver += 1; d.phase = 2; }
                                else { d.x = wp.x; d.y = wp.y; d.phase = 0; d.wi += 1; d.state = if d.home { S_HOME } else { S_MARCH }; }
                            }
                        } else if d.phase == 2 {
                            d.speed = base * 0.8; Self::advance(&mut d, wp);
                            if d.wi > 0 && d.path.get(d.wi).map_or(true, |w| (w.x - wp.x).abs() > 0.01 || (w.y - wp.y).abs() > 0.01) { d.phase = 0; d.state = if d.home { S_HOME } else { S_MARCH }; }
                        }
                    }
                }
                if d.wi >= d.path.len() {
                    d.path.clear(); d.phase = 0;
                    if d.home { for k in 0..5 { self.army[k] += d.units[k]; } remove = true; }
                    else if d.atk.is_some() { d.state = S_ARRIVED; } else { d.state = S_IDLE; }
                }
            }
            if !remove { let (rx, ry) = (d.x, d.y); let scouts = d.units.iter().sum::<u32>() <= 4; self.reveal(rx, ry, if scouts { 120.0 } else { 70.0 }); }   // a small party travels light and sees further   // an army on the march lifts the fog round it
            if remove { self.dets.remove(i); } else { self.dets[i] = d; i += 1; }
        }
    }

    /// Move up to `speed` units towards the waypoint; step on to the next when reached.
    fn advance(d: &mut Det, wp: Wp) {
        let (dx, dy) = (wp.x - d.x, wp.y - d.y); let dist = (dx * dx + dy * dy).sqrt();
        if dist <= d.speed { d.x = wp.x; d.y = wp.y; d.wi += 1; } else { d.x += dx / dist * d.speed; d.y += dy / dist * d.speed; }
        if dist > 0.01 { d.heading = dy.atan2(dx); }
    }

    /// A planned route without giving any order: [ok, seconds, planks, wood, count, x, y, mode, ...].
    pub(crate) fn plan(&self, units: &[u32; 5], sx: f32, sy: f32, tx: f32, ty: f32) -> Vec<f32> {
        match self.find_path(units, sx, sy, tx, ty) {
            Err(e) => vec![e as f32, 0.0, 0.0, 0.0, 0.0],
            Ok(p) => {
                let base = Self::march_speed(units); let workers = (units[0] + units[2]) as f32; let total: u32 = units.iter().sum();
                let (mut t, mut planks, mut wood, mut prev) = (0.0f32, 0i32, 0i32, (sx, sy));
                for w in &p {
                    let len = ((w.x - prev.0).powi(2) + (w.y - prev.1).powi(2)).sqrt();
                    match w.mode {
                        0 => t += len / base, 1 => t += len / (0.35 * workers.max(1.0).powf(0.7)).clamp(0.45, base),
                        _ => if len <= BRIDGE_MAX { planks += (len * 1.5).ceil() as i32; t += len * 2.5 / workers.max(1.0).powf(0.8) + len / (base * 0.8); } else { wood += 10 + total as i32 / 3; t += 6.0 + len / 2.4; },
                    }
                    prev = (w.x, w.y);
                }
                let mut v = vec![1.0, t, planks as f32, wood as f32, p.len() as f32];
                for w in &p { v.extend_from_slice(&[w.x, w.y, w.mode as f32]); }
                v
            }
        }
    }

    /// A walkable route between two buildings for the village's paths, found like an army route (same blocking rules) but only over a small window round them.
    /// Buildings and walls block, gates are open, lowered drawbridges carry you over water, open water stops you. None if there is no way.
    pub(crate) fn route_local(&self, ia: usize, ib: usize) -> Option<Vec<(f32, f32)>> {
        const RC: f32 = 2.0;
        let (a, b) = (&self.buildings[ia], &self.buildings[ib]);
        let m = 16.0;
        let (x0, y0) = (a.x.min(b.x) - m, a.y.min(b.y) - m);
        let (nx, ny) = ((((a.x.max(b.x) + m) - x0) / RC).ceil() as i32 + 1, (((a.y.max(b.y) + m) - y0) / RC).ceil() as i32 + 1);
        if nx * ny > 12000 { return None; }
        let cxy = |i: i32, j: i32| (x0 + (i as f32 + 0.5) * RC, y0 + (j as f32 + 0.5) * RC);
        let n = (nx * ny) as usize;
        let mut h = vec![0.0f32; n];
        for j in 0..ny { for i in 0..nx { let (x, y) = cxy(i, j); h[(j * nx + i) as usize] = self.height_ground(x, y); } }
        let mut blocked = vec![false; n]; let mut deck = vec![false; n];
        let mark = |g: &mut [bool], x: f32, y: f32, r: f32| {
            let (i0, i1) = ((((x - r - x0) / RC).floor() as i32).max(0), (((x + r - x0) / RC).ceil() as i32).min(nx - 1));
            let (j0, j1) = ((((y - r - y0) / RC).floor() as i32).max(0), (((y + r - y0) / RC).ceil() as i32).min(ny - 1));
            for j in j0..=j1 { for i in i0..=i1 { let (cx, cy) = cxy(i, j); if (cx - x).powi(2) + (cy - y).powi(2) <= r * r { g[(j * nx + i) as usize] = true; } } }
        };
        for (k, q) in self.buildings.iter().enumerate() {
            if k == ia || k == ib { continue; }
            match q.kind {
                GATE | MOAT | RIVER | RAISE | LOWER | ROAD => {}
                DRAWBRIDGE => {
                    if q.status == 5 || self.battle.is_some() { continue; }
                    let an = q.rot as f32 * std::f32::consts::FRAC_PI_4; let (sx, sy) = (an.sin(), an.cos());
                    for t in -9..=9 { let t = t as f32 * 0.8; mark(&mut deck, q.x + sx * t, q.y + sy * t, 1.7); }
                }
                _ => { let r = DEFS[q.kind as usize].r + if q.kind == WALL || q.kind == FENCE { 1.0 } else { 0.7 }; mark(&mut blocked, q.x, q.y, r); }
            }
        }
        let free = |i: i32, j: i32| -> Option<f32> {
            if i < 0 || j < 0 || i >= nx || j >= ny { return None; }
            let k = (j * nx + i) as usize;
            if blocked[k] && !deck[k] { return None; }
            if h[k] < 0.2 && !deck[k] { return None; }
            let mut sl = 0.0f32;
            if !deck[k] { for (di, dj) in [(1, 0), (-1, 0), (0, 1), (0, -1)] { let (p, q) = (i + di, j + dj); if p >= 0 && q >= 0 && p < nx && q < ny { sl = sl.max((h[(q * nx + p) as usize] - h[k]).abs() / RC); } } }
            if sl > 1.6 { return None; }
            Some(if deck[k] { 0.8 } else { 1.0 + sl * 1.2 })
        };
        let near = |x: f32, y: f32| -> Option<(i32, i32)> {
            let (ci, cj) = (((x - x0) / RC).floor() as i32, ((y - y0) / RC).floor() as i32);
            for r in 0..7i32 { for dj in -r..=r { for di in -r..=r { if di.abs().max(dj.abs()) != r { continue; } if free(ci + di, cj + dj).is_some() { return Some((ci + di, cj + dj)); } } } }
            None
        };
        let (s, g) = (near(a.x, a.y)?, near(b.x, b.y)?);
        let (si, gi) = ((s.1 * nx + s.0) as usize, (g.1 * nx + g.0) as usize);
        let mut gc = vec![f32::MAX; n]; let mut from = vec![u32::MAX; n];
        let mut heap = BinaryHeap::new();
        let hf = |i: usize| { let (ci, cj) = (i as i32 % nx, i as i32 / nx); let (dx, dy) = ((ci - g.0).abs() as f32, (cj - g.1).abs() as f32); dx.max(dy) + 0.414 * dx.min(dy) };
        gc[si] = 0.0; heap.push(Node { f: hf(si), i: si as u32 });
        let mut found = false;
        while let Some(Node { i, .. }) = heap.pop() {
            let i = i as usize; if i == gi { found = true; break; }
            let (ci, cj) = (i as i32 % nx, i as i32 / nx);
            for (di, dj) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let (p, q) = (ci + di, cj + dj);
                let Some(step) = free(p, q) else { continue };
                if di != 0 && dj != 0 && (free(ci + di, cj).is_none() || free(ci, cj + dj).is_none()) { continue; }
                let k = (q * nx + p) as usize; let ng = gc[i] + step * if di != 0 && dj != 0 { 1.414 } else { 1.0 };
                if ng < gc[k] { gc[k] = ng; from[k] = i as u32; heap.push(Node { f: ng + hf(k), i: k as u32 }); }
            }
        }
        if !found { return None; }
        let mut cells = vec![gi]; let mut c = gi; while from[c] != u32::MAX { c = from[c] as usize; cells.push(c); } cells.reverse();
        let pts: Vec<(f32, f32)> = cells.iter().map(|&i| cxy(i as i32 % nx, i as i32 / nx)).collect();
        // simplify by line of sight, but never cut across a different kind of ground (deck vs land)
        let kind_at = |x: f32, y: f32| -> Option<bool> { let (i, j) = (((x - x0) / RC).floor() as i32, ((y - y0) / RC).floor() as i32); if free(i, j).is_none() { None } else { Some(deck[(j * nx + i) as usize]) } };
        let los = |p: (f32, f32), q: (f32, f32), dk: bool| -> bool {
            let l = (q.0 - p.0).hypot(q.1 - p.1); let st = (l / (RC * 0.5)).ceil().max(1.0) as i32;
            (0..=st).all(|t| { let f = t as f32 / st as f32; kind_at(p.0 + (q.0 - p.0) * f, p.1 + (q.1 - p.1) * f) == Some(dk) })
        };
        let dk = |p: (f32, f32)| kind_at(p.0, p.1).unwrap_or(false);
        let mut out = vec![(a.x, a.y)]; let mut i = 0usize;
        while i < pts.len() - 1 {
            let d0 = dk(pts[i]); let mut j = pts.len() - 1;
            while j > i + 1 && !(dk(pts[j]) == d0 && los(pts[i], pts[j], d0)) { j -= 1; }
            out.push(pts[j]); i = j;
        }
        if let Some(l) = out.last_mut() { *l = (b.x, b.y); }
        Some(out)
    }
}

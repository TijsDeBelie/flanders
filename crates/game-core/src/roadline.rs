//! Roads the player lays, and the stub and nodes of every building they join.
//!
//! Nothing here is drawn or joined automatically. A road is a chain of road pieces (kind `ROAD`), each placed at a point of the road and joined by `RoadConn` to what it runs to: the
//! previous piece, another road's piece (a junction) or a **node** of a building. Every building has its own stub, a short built-in path from its front door out of its plot (the circle of
//! its footprint and fields) that ends in a node at the edge of the plot (`doors::exit_local`); a square has four nodes, one on each side. A road end near a node snaps onto it.
//!
//! The curve is a cubic Hermite spline through the pieces (a Catmull-Rom spline where a piece has two neighbours), sampled at a fixed step with plain `f32` arithmetic: the same pieces give
//! the same points on every replica, and the points feed the path network (roads are cheap to walk), so nothing here may depend on the machine.
//!
//! Roads can be laid across the map. A road connected to a building or the village's land claims `ROAD_CLAIM` around it, within the territory limit.
use super::*;
use std::collections::BTreeMap;

/// A road end this close to a node (or to a piece of another road) snaps onto it.
pub const SNAP: f32 = 4.0;
/// The longest stretch between a piece and what it is joined to.
pub const REACH: f32 = 10.0;
/// What a joined road piece claims round itself for building.
pub const ROAD_CLAIM: f32 = 9.0;
/// Distance between the points a curve is sampled at.
const STEP: f32 = 1.5;
/// How far outside the paved edge of a square its nodes stand.
const PLAZA_NODE_GAP: f32 = 0.7;

/// What a road piece is joined to: `k` 0 nothing, 1 another piece (at x, y), 2 + n the node n of the building standing at (x, y).
#[derive(Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize, Debug)]
pub struct Tgt { pub x: f32, pub y: f32, pub k: u8 }

/// A road piece's joins: the piece stands at (x, y) (pieces are found by their position, so the joins survive other buildings being taken away).
#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct RoadConn { pub x: f32, pub y: f32, pub to: [Tgt; 2] }

/// One stretch of road between a piece and what it is joined to, sampled along its curve.
pub struct Edge { pub a: usize, pub b: usize, pub pts: Vec<(f32, f32)> }

/// How far from the middle of a gate its two nodes stand, along the way through it (square to the wall): clear of the wall's thickness (the same place as the ends of its path through the doorway).
pub const GATE_NODE: f32 = 3.8;
/// The same for a toll house: on the axis of the road that runs through it, clear of its posts.
pub const TOLL_NODE: f32 = 5.0;
/// The same for a drawbridge: on the banks just beyond the ends of its deck.
pub const DRAWBRIDGE_NODE: f32 = 9.0;
/// A bridge's nodes stand this far beyond the ends of its deck, on the banks.
pub const BRIDGE_NODE_GAP: f32 = 1.0;

/// Buildings that are passed through: they have two nodes, one at each end of the way through them. The gate and the toll house also show a road under them (`road_lines_flat`); a bridge and a drawbridge carry their own deck.
#[allow(dead_code)]
pub fn is_passage(kind: u8) -> bool { matches!(kind, GATE | TOLL | BRIDGE | DRAWBRIDGE) }

/// Does a building of this kind have a stub of its own (a door and a node)? Walls, earthworks, bridges, roads and the toll gate (which stands on a road) do not; a square has nodes but no door.
pub fn has_stub(kind: u8) -> bool { !matches!(kind, WALL | FENCE | GATE | MOAT | RIVER | RAISE | LOWER | ROAD | BRIDGE | DRAWBRIDGE | TOLL | PLAZA) }

/// The nodes of a building in its own frame: where its stub ends (one node, at the edge of its plot, on the side of the door), or the four sides of a square.
pub fn nodes_local(kind: u8, tier: u8) -> Vec<(f32, f32)> {
    if kind == PLAZA { let r = footprint(kind, tier) + PLAZA_NODE_GAP; return vec![(r, 0.0), (0.0, r), (-r, 0.0), (0.0, -r)]; }
    // (the way through a passage runs along the model's z axis: node 0 at the front end, node 1 at the back. A bridge's nodes depend on its length: see `nodes_of`.)
    match kind { GATE => return vec![(0.0, GATE_NODE), (0.0, -GATE_NODE)], TOLL => return vec![(0.0, TOLL_NODE), (0.0, -TOLL_NODE)], DRAWBRIDGE => return vec![(0.0, DRAWBRIDGE_NODE), (0.0, -DRAWBRIDGE_NODE)], _ => {} }
    if has_stub(kind) { return vec![doors::exit_local(kind, tier)]; }
    vec![]
}

/// The two nodes of a bridge of this length standing at (x, y) along (ux, uy): on the banks, one beyond each end of the deck.
pub fn bridge_nodes(x: f32, y: f32, ux: f32, uy: f32, len: f32) -> [(f32, f32); 2] {
    let r = len / 2.0 + BRIDGE_NODE_GAP; [(x + ux * r, y + uy * r), (x - ux * r, y - uy * r)]
}

/// The nodes of a building in the world.
pub(crate) fn nodes_of(b: &Building) -> Vec<(f32, f32)> {
    if b.kind == BRIDGE { let (ux, uy, l) = World::bridge_dir(b); return bridge_nodes(b.x, b.y, ux, uy, l).to_vec(); }
    nodes_local(b.kind, b.tier).into_iter().map(|p| { let w = doors::to_world(b.rot, p); (b.x + w.0, b.y + w.1) }).collect()
}

fn same(a: f32, b: f32) -> bool { a.to_bits() == b.to_bits() }

#[wasm_bindgen]
impl World {
    /// The nodes of every building (by index). A gate's way through is square to the wall it stands in, which depends on the pieces round it, so the gates are placed by the doorways of `wall_lines`.
    pub(crate) fn nodes_all(&self) -> Vec<Vec<(f32, f32)>> {
        let doors = if self.buildings.iter().any(|b| b.kind == GATE) { self.wall_lines().1 } else { vec![] };
        self.buildings.iter().enumerate().map(|(i, b)| Self::nodes_in(b, i, &doors)).collect()
    }
    /// The nodes of building `i` given the doorways of the gates (see `nodes_all`).
    pub(crate) fn nodes_in(b: &Building, i: usize, doors: &[wallnet::Door]) -> Vec<(f32, f32)> {
        if b.kind == GATE { if let Some(d) = doors.iter().find(|d| d.b == i) { let (nx, ny) = (-d.uy, d.ux); return vec![(b.x + nx * GATE_NODE, b.y + ny * GATE_NODE), (b.x - nx * GATE_NODE, b.y - ny * GATE_NODE)]; } }
        nodes_of(b)
    }

    fn building_at(&self, x: f32, y: f32) -> Option<usize> { self.buildings.iter().position(|b| same(b.x, x) && same(b.y, y)) }

    /// The nearest thing a road end at (x, y) can be joined to within `range`: a node of a building, or a road piece (not `skip`). Returns the join and the place it is at.
    pub(crate) fn road_snap_target(&self, x: f32, y: f32, range: f32, skip: Option<(f32, f32)>) -> Option<(Tgt, (f32, f32))> {
        let mut best: Option<(f32, Tgt, (f32, f32))> = None;
        let all = self.nodes_all();
        for (bi, b) in self.buildings.iter().enumerate() {
            if b.kind == ROAD {
                if skip.map_or(false, |s| same(s.0, b.x) && same(s.1, b.y)) { continue; }
                let d = (b.x - x).hypot(b.y - y);
                if d <= range && best.map_or(true, |o| d < o.0 - 1e-4) { best = Some((d, Tgt { x: b.x, y: b.y, k: 1 }, (b.x, b.y))); }
            } else {
                for (k, &p) in all[bi].iter().enumerate() {
                    let d = (p.0 - x).hypot(p.1 - y);
                    if d <= range && best.map_or(true, |o| d < o.0 - 1e-4) { best = Some((d, Tgt { x: b.x, y: b.y, k: 2 + k as u8 }, p)); }
                }
            }
        }
        best.map(|b| (b.1, b.2))
    }

    /// What a piece placed on its own at (x, y) is joined to: the nearest piece or node in reach.
    pub(crate) fn road_tgts_near(&self, x: f32, y: f32) -> [Tgt; 2] {
        [self.road_snap_target(x, y, REACH, None).map_or(Tgt::default(), |t| t.0), Tgt::default()]
    }

    /// Is the land under building `i`'s road piece the village's own, or is it joined (through other road pieces, or directly) to a building or to the land?
    pub(crate) fn road_piece_attached(&self, x: f32, y: f32, to: &[Tgt; 2]) -> bool {
        if self.in_territory_by(x, y, false) { return true; }
        to.iter().any(|t| match t.k {
            0 => false,
            _ => match self.building_at(t.x, t.y) { Some(j) => self.buildings[j].kind != ROAD || self.buildings[j].status == 4, None => false },
        })
    }

    /// Drop the joins of pieces that were taken away, and work out which pieces are joined to the village's land (their `status`: 4 joined, 2 not). A piece is only ever joined to things put up
    /// before it, so one pass in building order settles it.
    pub(crate) fn sync_road_conn(&mut self) {
        let alive: std::collections::BTreeSet<(u32, u32)> = self.buildings.iter().filter(|b| b.kind == ROAD).map(|b| (b.x.to_bits(), b.y.to_bits())).collect();
        self.road_conn.retain(|c| alive.contains(&(c.x.to_bits(), c.y.to_bits())));
        for i in 0..self.buildings.len() {
            if self.buildings[i].kind != ROAD { continue; }
            let (x, y) = (self.buildings[i].x, self.buildings[i].y);
            let to = match self.road_conn.iter().find(|c| same(c.x, x) && same(c.y, y)) { Some(c) => c.to, None => { self.road_conn.push(RoadConn { x, y, to: Default::default() }); [Tgt::default(); 2] } };
            let att = self.road_piece_attached(x, y, &to);
            self.buildings[i].status = if att { 4 } else { 2 };
        }
    }

    /// The stretches of the roads the player laid, each sampled along its curve.
    pub(crate) fn road_edges(&self) -> Vec<Edge> {
        let by_pos: BTreeMap<(u32, u32), usize> = self.buildings.iter().enumerate().map(|(i, b)| ((b.x.to_bits(), b.y.to_bits()), i)).collect();
        struct R { a: usize, p: (f32, f32), b: usize, q: (f32, f32), out: Option<(f32, f32)> }
        let mut res: Vec<R> = vec![];
        let all = self.nodes_all();
        for c in &self.road_conn {
            let Some(&i) = by_pos.get(&(c.x.to_bits(), c.y.to_bits())) else { continue };
            if self.buildings[i].kind != ROAD { continue; }
            for t in c.to.iter().filter(|t| t.k != 0) {
                let Some(&j) = by_pos.get(&(t.x.to_bits(), t.y.to_bits())) else { continue };
                let tb = &self.buildings[j];
                if j == i { continue; }
                if t.k == 1 { if tb.kind == ROAD { res.push(R { a: i, p: (c.x, c.y), b: j, q: (tb.x, tb.y), out: None }); } }
                else if tb.kind != ROAD {
                    let Some(&q) = all[j].get(t.k as usize - 2) else { continue };
                    let (ox, oy) = (q.0 - tb.x, q.1 - tb.y); let ol = ox.hypot(oy).max(1e-3);
                    res.push(R { a: i, p: (c.x, c.y), b: j, q, out: Some((ox / ol, oy / ol)) });
                }
            }
        }
        // the neighbours of every piece: what it runs to and what runs to it
        let mut nb: BTreeMap<usize, Vec<(f32, f32)>> = BTreeMap::new();
        for r in &res { nb.entry(r.a).or_default().push(r.q); if self.buildings[r.b].kind == ROAD { nb.entry(r.b).or_default().push(r.p); } }
        let mut out = vec![];
        for r in &res {
            let chord = (r.q.0 - r.p.0, r.q.1 - r.p.1); let len = chord.0.hypot(chord.1);
            if len < 0.05 { continue; }
            // the way the curve leaves the piece: a piece with two neighbours has a smooth curve through it (Catmull-Rom), an end or a junction starts straight
            let m0 = match nb.get(&r.a) { Some(v) if v.len() == 2 => { let o = if v[0] == r.q { v[1] } else { v[0] }; ((r.q.0 - o.0) * 0.5, (r.q.1 - o.1) * 0.5) } _ => chord };
            let m1 = match r.out {
                Some(o) => (-o.0 * len, -o.1 * len),   // into a node the road runs square to the plot
                None => match nb.get(&r.b) { Some(v) if v.len() == 2 => { let o = if v[0] == r.p { v[1] } else { v[0] }; ((o.0 - r.p.0) * 0.5, (o.1 - r.p.1) * 0.5) } _ => chord },
            };
            let n = ((len / STEP).ceil() as i32).clamp(2, 48);
            let mut pts = Vec::with_capacity(n as usize + 1);
            for k in 0..=n {
                if k == 0 { pts.push(r.p); continue; }
                if k == n { pts.push(r.q); continue; }
                let t = k as f32 / n as f32; let (t2, t3) = (t * t, t * t * t);
                let (h00, h10, h01, h11) = (2.0 * t3 - 3.0 * t2 + 1.0, t3 - 2.0 * t2 + t, -2.0 * t3 + 3.0 * t2, t3 - t2);
                pts.push((h00 * r.p.0 + h10 * m0.0 + h01 * r.q.0 + h11 * m1.0, h00 * r.p.1 + h10 * m0.1 + h01 * r.q.1 + h11 * m1.1));
            }
            out.push(Edge { a: r.a, b: r.b, pts });
        }
        out
    }

    /// The road a player drew, as points relative to the village's origin ([dx, dy] each, at least two): a piece is put at every point, each joined to the one before. The first and the last
    /// snap onto a node or a road piece within `SNAP`, and are joined to it. Returns the code of `can_place` for the first piece that could not be put (0: all of them were), or -21 for a gap longer than `REACH`.
    pub fn lay_road(&mut self, flat: &[i32]) -> i32 {
        let pts: Vec<(f32, f32)> = flat.chunks_exact(2).take(64).map(|c| (self.ox as f32 + c[0] as f32, self.oy as f32 + c[1] as f32)).collect();
        if pts.len() < 2 { return -1; }
        if pts.iter().any(|&(x, y)| !Self::infrastructure_in_bounds(x, y)) { return -2; }
        let n = pts.len();
        // the two ends snap onto a node or a piece of another road: they are not pieces themselves, the road is joined to what they snapped to
        let start = self.road_snap_target(pts[0].0, pts[0].1, SNAP, None);
        let end = self.road_snap_target(pts[n - 1].0, pts[n - 1].1, SNAP, start.map(|s| (s.1 .0, s.1 .1))).filter(|e| start.map_or(true, |s| s.0 != e.0));
        let mut free: Vec<(f32, f32)> = pts[(start.is_some() as usize)..(n - end.is_some() as usize)].to_vec();
        if free.is_empty() { if let (Some(s), Some(e)) = (start, end) { free.push(((s.1 .0 + e.1 .0) / 2.0, (s.1 .1 + e.1 .1) / 2.0)); } }
        if free.is_empty() { return -1; }
        let wood = DEFS[ROAD as usize].cost.iter().map(|c| c.1).sum::<i32>() * free.len() as i32;
        if self.stock[W as usize] < wood { return -6; }
        self.defer_roads = true;
        let mut code = 0;
        let mut prev = start.map_or(Tgt::default(), |s| s.0); let mut prev_pos = start.map(|s| s.1);
        let m = free.len();
        for (k, &pos) in free.iter().enumerate() {
            let mut to = [prev, Tgt::default()];
            if k == m - 1 { if let Some(e) = end { to[1] = e.0; if (pos.0 - e.1 .0).hypot(pos.1 - e.1 .1) > REACH { code = -21; break; } } }
            if let Some(pp) = prev_pos { let d = (pos.0 - pp.0).hypot(pos.1 - pp.1); if d > REACH { code = -21; break; } if d < 0.5 { continue; } }
            let c = self.place_at(ROAD, pos.0, pos.1, 0, Some(to));
            if c < 0 { code = c; break; }
            prev = Tgt { x: pos.0, y: pos.1, k: 1 }; prev_pos = Some(pos);
        }
        self.defer_roads = false;
        self.after_change();
        code
    }

    /// Where a road end clicked at (dx, dy) would snap to, for the preview: [x, y, kind, building] relative to the origin (kind 0 a node of a building, 1 a piece of road), or nothing.
    pub fn road_snap(&self, dx: i32, dy: i32) -> Vec<f32> {
        let (px, py) = ((self.ox + dx) as f32, (self.oy + dy) as f32);
        match self.road_snap_target(px, py, SNAP, None) {
            Some((t, at)) => vec![at.0 - self.ox as f32, at.1 - self.oy as f32, if t.k == 1 { 1.0 } else { 0.0 }, self.building_at(t.x, t.y).map_or(-1.0, |i| i as f32)],
            None => vec![],
        }
    }

    /// Can a road piece stand at (dx, dy)? Returns the `can_place` code.
    pub fn road_can(&self, dx: i32, dy: i32) -> i32 { self.can_place(ROAD, dx, dy) }

    fn push_run(v: &mut Vec<f32>, born: u32, style: (u8, u8), run: &[(f32, f32)]) {
        v.extend_from_slice(&[1.0, born as f32, style.0 as f32, style.1 as f32, run.len() as f32]);
        for p in run { v.extend_from_slice(&[p.0, p.1]); }
    }

    /// The drawn lines of the roads for the client: for each, [kind, born tick, surface (tier), design (option bits), n, x, y, x, y, ...]; kind 0 a building's stub (door to node), 1 a stretch of a road the player laid, 2 the road under a gate or a toll house (node to node).
    pub fn road_lines_flat(&self) -> Vec<f32> {
        let mut v = vec![]; let decks = self.decks();
        for (i, b) in self.buildings.iter().enumerate() {
            if !has_stub(b.kind) { continue; }
            let _ = i;
            let (door, exit) = doors::door_world(b);
            if (door.0 - exit.0).hypot(door.1 - exit.1) > 0.3 && self.leg_is_dry_in(&decks, door, exit) { v.extend_from_slice(&[0.0, b.born as f32, 0.0, 0.0, 2.0, door.0, door.1, exit.0, exit.1]); }
        }
        // the road under a gate and a toll house: a ribbon between their two nodes (kind 2). A bridge and a drawbridge show no road: their deck is their own.
        for (b, ns) in self.buildings.iter().zip(self.nodes_all()) {
            if matches!(b.kind, GATE | TOLL) && ns.len() == 2 && self.leg_is_dry_in(&decks, ns[0], ns[1]) { v.extend_from_slice(&[2.0, b.born as f32, 0.0, 0.0, 2.0, ns[0].0, ns[0].1, ns[1].0, ns[1].1]); }
        }
        for e in self.road_edges() {
            let born = self.buildings[e.a].born.max(self.buildings[e.b].born); let style = self.edge_style(e.a, e.b);
            // only the dry stretches are drawn: a road stops at the bank and starts again on the far bank (a bridge or a drawbridge carries it over, with its own deck)
            let mut run: Vec<(f32, f32)> = vec![];
            for k in 0..e.pts.len() {
                if k > 0 && !self.leg_is_dry_in(&decks, e.pts[k - 1], e.pts[k]) { if run.len() >= 2 { Self::push_run(&mut v, born, style, &run); } run.clear(); }
                run.push(e.pts[k]);
            }
            if run.len() >= 2 { Self::push_run(&mut v, born, style, &run); }
        }
        v
    }

    /// The nodes of every building (the connection points a road snaps to), as [x, y, building, k] each.
    pub fn road_nodes_flat(&self) -> Vec<f32> {
        let mut v = vec![];
        for (i, ns) in self.nodes_all().into_iter().enumerate() { for (k, p) in ns.into_iter().enumerate() { v.extend_from_slice(&[p.0, p.1, i as f32, k as f32]); } }
        v
    }

    /// Where a building of this kind, tier and turn would have its nodes if it stood at (x, y) (absolute): [x, z, x, z, ...], for the placement ghost. It is the same code as the real nodes. A gate is shown by
    /// its own turn (the client turns it to the wall it stands in); a bridge's nodes depend on its span, so `bridge_preview` gives them.
    pub fn node_preview(&self, kind: u8, tier: u8, x: f32, y: f32, rot: u8) -> Vec<f32> {
        let b = Building { kind, tier, x, y, rot, pad_h: 0.0, progress: 0, status: 4, aux: -1, staff: 0, residents: 0, hp: 1.0, burning: 0.0, garrison: 0, born: 0, opts: 0, fert: 0, mode: 0, target: -1, beff: 100 };
        nodes_of(&b).into_iter().flat_map(|p| [p.0, p.1]).collect()
    }

}

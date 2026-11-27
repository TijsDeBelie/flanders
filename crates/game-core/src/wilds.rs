//! The wild places between the villages, as a living part of the world rather than one-off rewards.
//!
//! The rules, in one place (every peer runs them identically: they depend only on the state of the world and the tick; the daily rolls are hashes of
//! the seed, the place and the day, so they never draw from the village's random stream):
//! * **Raids come from the camps.** The three nearest bandit camps and lairs that still stand set the raids' pace and strength (`camp_pressure`): a village
//!   with live camps close by is raided as before; one that has cleared its surroundings is raided up to two and a half times less often, by weaker bands.
//!   Each raid remembers the camp it set out from (`raid_from`), so the warning can show it.
//! * **Camps come back.** A cleared bandit camp stands empty for `REOCCUPY_DAYS`; after that, each day, outlaws may move back in (`REOCCUPY_CHANCE`) unless the
//!   place is watched: one of your armies stands at it, a watchtower, keep or toll post of yours stands within `WATCH_REACH`, or a garrisoned mineshaft of yours
//!   is near. Each return makes the camp stronger and richer (`rounds`). Lairs do not come back: their boss is dead.
//! * **Abbeys are neighbours.** An army's first visit heals the sick (as before) and makes the monks friends (goodwill 50). Afterwards a tithe (`TITHE_BASE` plus a
//!   little per villager) raises goodwill and, once a season, heals every sick villager at once. While goodwill is at least `HERBAL_GOODWILL` the infirmarian's
//!   herbs heal one sick villager a day. Goodwill fades by one every two days. Outlaws from a live camp nearby may sack an unwatched abbey: it takes no tithe
//!   and gives nothing for `SACK_DAYS`, and the monks' goodwill is gone.
//! * **Mineshafts.** An army that enters an abandoned mineshaft claims it and leaves a garrison of up to `GARRISON_MAX` soldiers there (it needs at least
//!   `GARRISON_MIN`). While garrisoned, the shaft digs `SHAFT_IRON` iron ore (or `SHAFT_GOLD` gold ore) a day into a pile at its mouth (at most `PILE_DAYS` days' worth).
//!   A road of yours that is joined to the castle and ends within `SHAFT_ROAD` of the shaft carries the whole pile home every day. Without one, a mule train takes
//!   a small load (`CART_DAYS` days' digging) at a time and walks `CART_SPEED` a day (at least `CART_MIN_DAYS` days, at most `CART_MAX_DAYS`), so most of what is dug waits.
//!   The garrison eats from the village's stores like every soldier (see `appetite`); while the stores are empty one of them deserts a day.
//!   Outlaws from a live camp nearby attack it now and then: the bigger the garrison, the less often; each attack costs half the garrison and half the pile, and a shaft
//!   with none left is lost (with its pile; a mule train already on the road still arrives). Abandoning a shaft brings its garrison home.
use super::*;

pub const REOCCUPY_DAYS: u64 = 18;
/// Chance per day, once a cleared camp has stood empty long enough, that outlaws move back in.
pub const REOCCUPY_CHANCE: f32 = 0.2;
/// How far a watchtower, keep or toll post keeps outlaws from a camp or an abbey; a garrisoned shaft watches a camp this near.
pub const WATCH_REACH: f32 = 160.0;
pub const SHAFT_WATCH: f32 = 150.0;
/// How near one of your field armies must stand to watch a place.
pub const ARMY_WATCH: f32 = 30.0;
/// The most a camp can come back stronger (each return adds 20% to the strength it takes and 15% to what it pays).
pub const MAX_ROUNDS: u8 = 5;
/// Camps within this reach of the village press on it; the three nearest count.
pub const PRESSURE_REACH: f32 = 600.0;
/// Days between the healings a tithe buys; gold a tithe costs (plus one per two villagers); goodwill it adds.
pub const TITHE_SEASON_DAYS: u64 = 30;
pub const TITHE_BASE: i32 = 30;
pub const TITHE_GOODWILL: u8 = 25;
pub const HERBAL_GOODWILL: u8 = 40;
/// A live camp this near an abbey or a shaft can raid it.
pub const OUTLAW_REACH: f32 = 240.0;
pub const SACK_CHANCE: f32 = 0.03;
pub const SACK_DAYS: u64 = 20;
pub const GARRISON_MIN: u32 = 3;
pub const GARRISON_MAX: u32 = 8;
pub const SHAFT_IRON: i32 = 6;
pub const SHAFT_GOLD: i32 = 2;
/// The chance a day that outlaws attack a shaft at the edge of their reach with a garrison of nobody (it falls with the garrison: see `shaft_attack_chance`).
pub const SHAFT_ATTACK: f32 = 0.3;
/// A road piece of yours this near the shaft, joined to the castle, is the shaft's road.
pub const SHAFT_ROAD: f32 = 12.0;
/// Without a road: a mule train carries this many days of digging, walks this far a day, and is never on the road fewer days than this.
pub const CART_DAYS: i32 = 2;
pub const CART_SPEED: f32 = 30.0;
pub const CART_MIN_DAYS: u64 = 3;
pub const CART_MAX_DAYS: u64 = 15;
/// The pile at the mouth holds at most this many days of digging (beyond it the miners have nowhere to put more).
pub const PILE_DAYS: i32 = 12;

/// What became of a wild place (EV_WILD's `a`; `b` is the place: a neutral index, or the shaft index for 3 and 4).
pub const WILD_REOCCUPIED: i32 = 1;
pub const WILD_SACKED: i32 = 2;
pub const WILD_SHAFT_ATTACKED: i32 = 3;
pub const WILD_SHAFT_LOST: i32 = 4;
pub const WILD_HEALED: i32 = 5;
pub const WILD_DESERTED: i32 = 6;

#[derive(Clone, Copy, Default, serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct PlaceState {
    pub cleared_at: u64,   // the tick a bandit camp was cleared (0: never, or held again)
    pub rounds: u8,        // how often outlaws have come back to it
    pub goodwill: u8,      // an abbey's monks: 0..100
    pub next_heal: u64,    // the first tick a tithe heals again
    pub sacked_until: u64,
}

#[derive(Clone, Copy, Default, serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct Shaft {
    pub garrison: [u32; NK], pub claimed_at: u64,
    pub pile: i32,        // ore dug and waiting at the mouth
    pub cart: i32,        // ore on its way home by mule train
    pub cart_due: u64,    // the tick the mule train arrives (0: none on the road)
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct Wilds {
    pub places: Vec<PlaceState>,   // by index into terrain::neutrals
    pub shafts: Vec<Shaft>,        // by index into terrain::mineshafts
    pub raid_from: i32,            // the camp (neutral index) the raid now warned of or on the field set out from; -1 none
}

impl Wilds {
    pub fn new(seed: u64) -> Wilds { let mut w = Wilds { raid_from: -1, ..Default::default() }; w.fit(seed); w }
    /// Size the lists to this world's places (a snapshot made before they existed restores with empty lists).
    pub fn fit(&mut self, seed: u64) {
        self.places.resize(terrain::neutrals(seed).len(), PlaceState::default());
        self.shafts.resize(terrain::mineshafts(seed).len(), Shaft::default());
    }
    pub fn valid(&self, seed: u64) -> bool {
        self.places.len() == terrain::neutrals(seed).len() && self.shafts.len() == terrain::mineshafts(seed).len()
            && self.places.iter().all(|p| p.goodwill <= 100 && p.rounds <= MAX_ROUNDS)
            && self.shafts.iter().all(|s| s.garrison.iter().sum::<u32>() <= GARRISON_MAX && s.pile >= 0 && s.cart >= 0 && s.pile <= SHAFT_IRON * PILE_DAYS && s.cart <= SHAFT_IRON * PILE_DAYS)
            && self.raid_from >= -1 && self.raid_from < self.places.len() as i32
    }
    pub fn mix(&self, mix: &mut dyn FnMut(u64)) {
        for p in &self.places { mix(p.cleared_at); mix(p.rounds as u64); mix(p.goodwill as u64); mix(p.next_heal); mix(p.sacked_until); }
        for s in &self.shafts { for g in s.garrison { mix(g as u64); } mix(s.claimed_at); mix(s.pile as u64); mix(s.cart as u64); mix(s.cart_due); }
        mix(self.raid_from as i64 as u64);
    }
}

/// A roll of 0..1 for this place, this day and this kind of happening: the same on every peer, and no draw from the village's random stream.
fn roll(seed: u64, what: u64, place: usize, day: u64) -> f32 { terrain::h01(seed ^ (0x5711_0000 + what), place as i32, day as i32) }

impl World {
    fn live_camps(&self) -> Vec<(usize, f32, f32)> {
        terrain::neutrals(self.seed).iter().enumerate()
            .filter(|(i, n)| n.0 >= 2 && !self.neutral_done.get(*i).copied().unwrap_or(false))
            .map(|(i, n)| (i, n.1, n.2)).collect()
    }
    /// How far the nearest live bandit camp or lair is from (x, y).
    pub(crate) fn nearest_outlaws(&self, x: f32, y: f32) -> f32 { self.nearest_live_camp(x, y) }
    /// A place is watched (outlaws keep away): an army, a tower, keep or toll post, or a garrisoned shaft near it.
    pub(crate) fn watched_place(&self, x: f32, y: f32) -> bool {
        self.watched(x, y) || terrain::mineshafts(self.seed).iter().zip(&self.wilds.shafts).any(|(m, s)| s.garrison.iter().sum::<u32>() > 0 && (m.1 - x).hypot(m.2 - y) < SHAFT_WATCH)
    }
    fn nearest_live_camp(&self, x: f32, y: f32) -> f32 {
        self.live_camps().iter().map(|c| (c.1 - x).hypot(c.2 - y)).fold(f32::INFINITY, f32::min)
    }
    /// One of your armies, or a watchtower, keep or toll post, keeps an eye on (x, y).
    fn watched(&self, x: f32, y: f32) -> bool {
        self.dets.iter().any(|d| d.ally == 0 && (d.x - x).hypot(d.y - y) < ARMY_WATCH)
            || self.buildings.iter().any(|b| matches!(b.kind, TOWER | KEEP | TOLL) && (b.x - x).hypot(b.y - y) < WATCH_REACH)
    }
    /// How hard the camps press on the village: the three nearest live camps and lairs within `PRESSURE_REACH`, each weighing 1 at the village and 0 at the reach. 0..3.
    pub(crate) fn camp_pressure(&self) -> f32 {
        let (ox, oy) = (self.ox as f32, self.oy as f32);
        let mut d: Vec<f32> = self.live_camps().iter().map(|c| (c.1 - ox).hypot(c.2 - oy)).collect();
        d.sort_by(f32::total_cmp);
        d.iter().take(3).map(|&d| (1.0 - d / PRESSURE_REACH).max(0.0)).sum()
    }
    /// How much the camps quicken the raids: 1 (as always) when they press at 1.5 or more, down to 0.4 when none is near.
    pub(crate) fn raid_pace(&self) -> f32 { 0.4 + 0.4 * self.camp_pressure().min(1.5) }
    /// A raid's chance a tick is one in this many: the bandits' greed (`raid_one_in`) slowed by how few camps are near.
    pub(crate) fn raid_one_in_wild(&self) -> u32 { ((self.raid_one_in() as f32 / self.raid_pace()) as u32).max(2) }
    /// The strength roll of a raid from camp `from`: weaker when few camps are near, stronger from a camp that has come back.
    pub(crate) fn raid_roll(&self, rf: f32, from: i32) -> f32 {
        let rounds = self.wilds.places.get(from.max(0) as usize).filter(|_| from >= 0).map_or(0, |p| p.rounds) as f32;
        (rf * (0.5 + 0.5 * (self.camp_pressure().min(1.5) / 1.5)) + 0.1 * rounds).min(1.0)
    }

    /// What a bandit camp takes to clear and pays: its strength, gold and iron, grown with every return.
    pub(crate) fn camp_terms(&self, i: usize) -> (f32, i32, i32) {
        let h = terrain::h01(self.seed ^ 0x52, i as i32, 3);
        let rounds = self.wilds.places.get(i).map_or(0, |p| p.rounds) as f32;
        let (g, ir) = Self::camp_loot(h, self.population, self.tick);
        ((9000.0 + 14000.0 * h) * (1.0 + 0.2 * rounds), (g as f32 * (1.0 + 0.15 * rounds)).round() as i32, (ir as f32 * (1.0 + 0.15 * rounds)).round() as i32)
    }

    /// Once a day: camps come back, abbeys heal and may be sacked, shafts send ore home and may be attacked.
    pub(crate) fn wilds_step(&mut self) {
        if self.tick % DAY != 0 || self.tick == 0 { return; }
        let day = self.tick / DAY;
        let list = terrain::neutrals(self.seed);
        self.wilds.fit(self.seed);
        for (i, &(kind, x, y)) in list.iter().enumerate() {
            let done = self.neutral_done.get(i).copied().unwrap_or(false);
            if kind == 2 && done {
                let p = self.wilds.places[i];
                if p.cleared_at > 0 && self.tick >= p.cleared_at + REOCCUPY_DAYS * DAY && p.rounds < MAX_ROUNDS
                    && !self.watched_place(x, y)
                    && roll(self.seed, 1, i, day) < REOCCUPY_CHANCE {
                    self.neutral_done[i] = false;
                    let p = &mut self.wilds.places[i]; p.cleared_at = 0; p.rounds += 1;
                    if self.is_seen(x, y) { self.push_event(EV_WILD, WILD_REOCCUPIED, i as i32); }
                }
            }
            if kind == 0 {
                let p = self.wilds.places[i];
                if p.goodwill > 0 && day % 2 == 0 { self.wilds.places[i].goodwill -= 1; }
                if self.tick >= p.sacked_until && self.nearest_live_camp(x, y) < OUTLAW_REACH && !self.watched(x, y) && roll(self.seed, 2, i, day) < SACK_CHANCE {
                    let p = &mut self.wilds.places[i]; p.sacked_until = self.tick + SACK_DAYS * DAY; p.goodwill = 0;
                    if self.is_seen(x, y) { self.push_event(EV_WILD, WILD_SACKED, i as i32); }
                }
            }
        }
        // the infirmarian's herbs: one sick villager a day, while some abbey's monks think well of you
        if self.sick > 0 && list.iter().enumerate().any(|(i, n)| n.0 == 0 && self.tick >= self.wilds.places[i].sacked_until && self.wilds.places[i].goodwill >= HERBAL_GOODWILL) {
            self.sick -= 1;
        }
        // the shafts: digging, the road or the mule train home, hunger, outlaws
        let cap = self.storage_cap();
        let hungry = self.food() == 0;
        for (j, &(ore, x, y)) in terrain::mineshafts(self.seed).iter().enumerate() {
            let (r, n) = if ore == 0 { (IO, SHAFT_IRON) } else { (GO, SHAFT_GOLD) };
            let sh = self.wilds.shafts[j];
            if sh.cart_due > 0 && self.tick >= sh.cart_due {   // the mule train is home (even from a shaft lost since)
                self.gain(ledger::EX_OTHER, r, sh.cart, cap);
                let s = &mut self.wilds.shafts[j]; s.cart = 0; s.cart_due = 0;
            }
            let held: u32 = self.wilds.shafts[j].garrison.iter().sum(); if held == 0 { continue; }
            { let s = &mut self.wilds.shafts[j]; s.pile = (s.pile + n).min(n * PILE_DAYS); }
            if self.shaft_road(x, y) {
                let pile = self.wilds.shafts[j].pile; self.gain(ledger::EX_OTHER, r, pile, cap); self.wilds.shafts[j].pile = 0;
            } else if self.wilds.shafts[j].cart_due == 0 && self.wilds.shafts[j].pile > 0 {
                let load = self.wilds.shafts[j].pile.min(n * CART_DAYS);
                let days = Self::cart_days(self.home_distance(x, y));
                let s = &mut self.wilds.shafts[j]; s.pile -= load; s.cart = load; s.cart_due = self.tick + days * DAY;
            }
            if hungry {   // nothing to eat: one of the garrison walks off
                let g = &mut self.wilds.shafts[j].garrison;
                if let Some(k) = (0..NK).rev().find(|&k| g[k] > 0) { g[k] -= 1; }
                if g.iter().sum::<u32>() == 0 { self.lose_shaft(j); } else { self.push_event(EV_WILD, WILD_DESERTED, j as i32); }
                continue;
            }
            let near = self.nearest_live_camp(x, y);
            if near < OUTLAW_REACH && roll(self.seed, 3, j, day) < Self::shaft_attack_chance(near, held) {
                let s = &mut self.wilds.shafts[j];
                for k in 0..NK { s.garrison[k] -= (s.garrison[k] + 1) / 2; }
                s.pile /= 2;
                if s.garrison.iter().sum::<u32>() == 0 { self.lose_shaft(j); }
                else { self.push_event(EV_WILD, WILD_SHAFT_ATTACKED, j as i32); }
            }
        }
    }
    /// A shaft with no garrison left is lost, with the ore at its mouth (a mule train on the road still arrives).
    fn lose_shaft(&mut self, j: usize) {
        let s = &mut self.wilds.shafts[j]; s.garrison = [0; NK]; s.claimed_at = 0; s.pile = 0;
        self.push_event(EV_WILD, WILD_SHAFT_LOST, j as i32);
    }
    /// How far (x, y) is from the castle.
    pub(crate) fn home_distance(&self, x: f32, y: f32) -> f32 { self.buildings.first().map_or(0.0, |h| (h.x - x).hypot(h.y - y)) }
    /// Days a mule train takes from a shaft this far away.
    pub(crate) fn cart_days(dist: f32) -> u64 { ((dist / CART_SPEED).ceil() as u64).clamp(CART_MIN_DAYS, CART_MAX_DAYS) }
    /// A road of yours, joined to the castle, ends within `SHAFT_ROAD` of (x, y).
    pub(crate) fn shaft_road(&self, x: f32, y: f32) -> bool {
        if !self.buildings.iter().any(|b| b.kind == ROAD && (b.x - x).hypot(b.y - y) < SHAFT_ROAD) { return false; }
        let reach = self.road_reach();
        self.buildings.iter().zip(&reach).any(|(b, &r)| r && b.kind == ROAD && (b.x - x).hypot(b.y - y) < SHAFT_ROAD)
    }
    /// Lay a long road plan (see `shaft_road_plan`) as one `lay_road` call per 60 points, each starting on the last point of the one before. The code of the first call
    /// that failed, or 0. (A player's client sends each piece as a `road` command of its own: `road_plan_pieces`.)
    pub(crate) fn lay_road_plan(&mut self, flat: &[i32]) -> i32 {
        for piece in Self::road_plan_pieces(flat) { let c = self.lay_road(&piece); if c != 0 { return c; } }
        0
    }
    pub(crate) fn road_plan_pieces(flat: &[i32]) -> Vec<Vec<i32>> {
        let n = flat.len() / 2; let mut out = vec![]; let mut i = 0;
        while i + 1 < n { let end = (i + 59).min(n - 1); out.push(flat[i * 2..(end + 1) * 2].to_vec()); i = end; }
        out
    }
    /// The soldiers holding the shafts: they eat like any soldier (see `appetite`).
    pub(crate) fn garrisoned(&self) -> u32 { self.wilds.shafts.iter().map(|s| s.garrison.iter().sum::<u32>()).sum() }
    pub(crate) fn shaft_attack_chance(near: f32, held: u32) -> f32 { SHAFT_ATTACK * (1.0 - near / OUTLAW_REACH).max(0.0) / (1.0 + held as f32 / 2.0) }

    /// An army at mineshaft `j` claims it: up to `GARRISON_MAX` of its soldiers stay (spearmen, then archers, then the rest; never engines). 5 on success, -5 too few soldiers, -3 already held.
    pub(crate) fn claim_shaft(&mut self, di: usize, j: usize) -> i32 {
        self.wilds.fit(self.seed);
        if self.wilds.shafts[j].garrison.iter().sum::<u32>() > 0 { return -3; }
        let units = self.dets[di].units;
        let foot: u32 = (0..4).map(|k| units[k]).sum();
        if foot < GARRISON_MIN { return -5; }
        let mut left = GARRISON_MAX; let mut g = [0u32; NK];
        for k in [0usize, 1, 2, 3] { let n = units[k].min(left); g[k] = n; left -= n; }
        let d = &mut self.dets[di];
        for k in 0..NK { d.units[k] -= g[k]; }
        d.grp.clear();
        if d.units.iter().all(|&u| u == 0) { self.dets.remove(di); }
        let s = &mut self.wilds.shafts[j]; s.garrison = g; s.claimed_at = self.tick;   // (a mule train still on the road from an earlier holding keeps going)
        5
    }
}

#[wasm_bindgen]
impl World {
    /// The wild places' standing actions (`wild` command): 1 pay a tithe to abbey `place` (a neutral index), 2 abandon mineshaft `place` (a shaft index: its garrison comes home).
    /// Tithe: 0 paid and the sick healed, 1 paid (the next healing is not due yet), -3 you have not met these monks, -6 not enough gold, -7 the abbey has been sacked.
    /// Abandon: 0 done, -3 not yours. Both: -1 no such place or action.
    pub fn wild_act(&mut self, action: u8, place: u32) -> i32 {
        self.wilds.fit(self.seed);
        let i = place as usize;
        match action {
            1 => {
                let list = terrain::neutrals(self.seed);
                if list.get(i).is_none_or(|n| n.0 != 0) { return -1; }
                if !self.neutral_done.get(i).copied().unwrap_or(false) { return -3; }
                if self.tick < self.wilds.places[i].sacked_until { return -7; }
                let cost = self.tithe_cost();
                if self.stock[GD as usize] < cost { return -6; }
                self.stock[GD as usize] -= cost;
                let heal = self.tick >= self.wilds.places[i].next_heal;
                let p = &mut self.wilds.places[i]; p.goodwill = (p.goodwill + TITHE_GOODWILL).min(100);
                if heal { p.next_heal = self.tick + TITHE_SEASON_DAYS * DAY; let n = self.sick; self.end_plague(); self.push_event(EV_WILD, WILD_HEALED, n as i32); 0 } else { 1 }
            }
            2 => {
                let Some(s) = self.wilds.shafts.get(i).copied() else { return -1 };
                if s.garrison.iter().sum::<u32>() == 0 { return -3; }
                for k in 0..NK { self.army[k] = self.army[k].saturating_add(s.garrison[k]); }
                let sh = &mut self.wilds.shafts[i]; sh.garrison = [0; NK]; sh.claimed_at = 0; sh.pile = 0;   // (the ore at the mouth is left; a mule train on the road still arrives)
                0
            }
            _ => -1,
        }
    }
    /// A road for shaft `j`: points ([dx, dy] relative to the origin, a few units apart) from the castle's gate along the dry way to just short of the shaft's mouth,
    /// for `lay_road` (at most 64 points a call: lay it in pieces that each start where the last ended; see `lay_road_plan`). Empty when there is no dry way.
    pub fn shaft_road_plan(&self, j: u32) -> Vec<i32> {
        let Some(&(_, mx, my)) = terrain::mineshafts(self.seed).get(j as usize) else { return vec![] };
        let Some(hall) = self.buildings.first() else { return vec![] };
        let (_, (sx, sy)) = doors::door_world(hall);
        let (dx, dy) = (sx - mx, sy - my); let dl = dx.hypot(dy).max(1.0);
        let (gx, gy) = (mx + dx / dl * 6.0, my + dy / dl * 6.0);
        let route = self.walk_route_inner(sx, sy, gx, gy); if route.len() < 3 { return vec![]; }
        let mut line = vec![(sx, sy)]; line.extend(route[1..].chunks_exact(2).map(|c| (c[0], c[1])));
        // a point every `ROAD_STEP` along the way (and the last)
        const ROAD_STEP: f32 = 6.0;
        let mut out = vec![line[0]]; let mut carry = 0.0;
        for w in line.windows(2) {
            let (a, b) = (w[0], w[1]); let len = (b.0 - a.0).hypot(b.1 - a.1); if len < 1e-3 { continue; }
            let mut t = ROAD_STEP - carry;
            while t <= len { out.push((a.0 + (b.0 - a.0) * t / len, a.1 + (b.1 - a.1) * t / len)); t += ROAD_STEP; }
            carry = len - (t - ROAD_STEP);
        }
        let last = *line.last().unwrap(); if out.last().is_none_or(|p| (p.0 - last.0).hypot(p.1 - last.1) > 1.0) { out.push(last); }
        // on whole units, as a road command carries them; a point that would be refused (the walk hugs a shore, a house stands on it) moves to the nearest free spot
        // within two units (the points are close enough that the road still joins: `REACH` is 10)
        let (ox, oy) = (self.ox as i32, self.oy as i32);
        let mut flat = Vec::with_capacity(out.len() * 2);
        for (k, p) in out.iter().enumerate() {
            let (mut dx, mut dy) = ((p.0 - ox as f32).round() as i32, (p.1 - oy as f32).round() as i32);
            if k > 0 && self.can_place_xy(ROAD, (ox + dx) as f32, (oy + dy) as f32) != 0 {
                let mut best: Option<(i32, i32, i32)> = None;
                for ny in -2..=2 { for nx in -2..=2 {
                    let d2 = nx * nx + ny * ny; if d2 == 0 || best.is_some_and(|b| b.2 <= d2) { continue; }
                    if self.can_place_xy(ROAD, (ox + dx + nx) as f32, (oy + dy + ny) as f32) == 0 { best = Some((nx, ny, d2)); }
                } }
                if let Some((nx, ny, _)) = best { dx += nx; dy += ny; }
            }
            flat.extend([dx, dy]);
        }
        flat
    }
    /// Wood a road plan costs (a piece a point).
    pub fn road_plan_cost(flat: &[i32]) -> i32 { (flat.len() / 2) as i32 * DEFS[ROAD as usize].cost.iter().map(|c| c.1).sum::<i32>() }

    /// Gold one tithe costs now.
    pub fn tithe_cost(&self) -> i32 { TITHE_BASE + self.population as i32 / 2 }
    /// The camp the raid now warned of (or fighting) set out from: [x, y], or empty.
    pub fn raid_source(&self) -> Vec<f32> {
        if self.wilds.raid_from < 0 || (self.raid_warning_ticks == 0 && !self.battle.as_ref().is_some_and(|b| b.tag == 0 && b.lair < 0)) { return vec![]; }
        terrain::neutrals(self.seed).get(self.wilds.raid_from as usize).map_or(vec![], |n| vec![n.1, n.2])
    }
    /// How hard the camps press on the village (0..3) and the raids' pace (0.4..1): see `camp_pressure`.
    pub fn wild_pressure(&self) -> Vec<f32> { vec![self.camp_pressure(), self.raid_pace()] }
}

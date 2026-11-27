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
//!   `GARRISON_MIN`). While garrisoned, the shaft sends home `SHAFT_IRON` iron ore (or `SHAFT_GOLD` gold ore) a day. Outlaws from a live camp nearby attack it now and then:
//!   the bigger the garrison, the less often; each attack costs half the garrison, and a shaft with none left is lost. Abandoning a shaft brings its garrison home.
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

/// What became of a wild place (EV_WILD's `a`; `b` is the place: a neutral index, or the shaft index for 3 and 4).
pub const WILD_REOCCUPIED: i32 = 1;
pub const WILD_SACKED: i32 = 2;
pub const WILD_SHAFT_ATTACKED: i32 = 3;
pub const WILD_SHAFT_LOST: i32 = 4;
pub const WILD_HEALED: i32 = 5;

#[derive(Clone, Copy, Default, serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct PlaceState {
    pub cleared_at: u64,   // the tick a bandit camp was cleared (0: never, or held again)
    pub rounds: u8,        // how often outlaws have come back to it
    pub goodwill: u8,      // an abbey's monks: 0..100
    pub next_heal: u64,    // the first tick a tithe heals again
    pub sacked_until: u64,
}

#[derive(Clone, Copy, Default, serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct Shaft { pub garrison: [u32; NK], pub claimed_at: u64 }

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
            && self.shafts.iter().all(|s| s.garrison.iter().sum::<u32>() <= GARRISON_MAX)
            && self.raid_from >= -1 && self.raid_from < self.places.len() as i32
    }
    pub fn mix(&self, mix: &mut dyn FnMut(u64)) {
        for p in &self.places { mix(p.cleared_at); mix(p.rounds as u64); mix(p.goodwill as u64); mix(p.next_heal); mix(p.sacked_until); }
        for s in &self.shafts { for g in s.garrison { mix(g as u64); } mix(s.claimed_at); }
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
        // the shafts
        let cap = self.storage_cap();
        for (j, &(ore, x, y)) in terrain::mineshafts(self.seed).iter().enumerate() {
            let held: u32 = self.wilds.shafts[j].garrison.iter().sum(); if held == 0 { continue; }
            let (r, n) = if ore == 0 { (IO, SHAFT_IRON) } else { (GO, SHAFT_GOLD) };
            self.gain(ledger::EX_OTHER, r, n, cap);
            let near = self.nearest_live_camp(x, y);
            if near < OUTLAW_REACH && roll(self.seed, 3, j, day) < Self::shaft_attack_chance(near, held) {
                let g = &mut self.wilds.shafts[j].garrison;
                for k in 0..NK { g[k] -= (g[k] + 1) / 2; }
                if g.iter().sum::<u32>() == 0 { self.wilds.shafts[j] = Shaft::default(); self.push_event(EV_WILD, WILD_SHAFT_LOST, j as i32); }
                else { self.push_event(EV_WILD, WILD_SHAFT_ATTACKED, j as i32); }
            }
        }
    }
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
        self.wilds.shafts[j] = Shaft { garrison: g, claimed_at: self.tick };
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
                self.wilds.shafts[i] = Shaft::default();
                0
            }
            _ => -1,
        }
    }
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

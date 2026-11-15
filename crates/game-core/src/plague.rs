//! The plague. An outbreak is an event that runs for many days (10 to 20, a day is 240 ticks), in waves: it spreads at first, peaks about a third of the way through and then fades
//! out. Wells, parks, chapels, hospital beds, a quarantine and burying the dead keep the peak low and the dying down, but none of them ends an outbreak on the spot.
//!
//! Every number is here, in one place. The simulation works in steps of `STEP` ticks (ten a day) and uses only integers and the world's own random stream, so every peer that replays
//! the same commands gets the same plague. Changing any number here changes the rules: old command logs replay differently (the rules fingerprint reports it).
use super::*;

/// Ticks between two plague steps (a tenth of a day).
pub(crate) const STEP: u64 = 24;
/// An outbreak lasts `MIN_DAYS` plus up to `EXTRA_DAYS - 1` more days: 10 to 20.
pub(crate) const MIN_DAYS: u64 = 10;
pub(crate) const EXTRA_DAYS: u32 = 11;
/// After an outbreak the village is left alone for this many days.
pub(crate) const COOLDOWN_DAYS: u64 = 8;
/// How far through its length (per mille) an outbreak peaks.
pub(crate) const PEAK_AT: u64 = 350;
/// Share of the village that falls ill on the first day, and at the peak, in percent (before anything holds it back).
pub(crate) const SEED_PCT: u32 = 10;
pub(crate) const PEAK_PCT: u32 = 32;
/// How much of the gap between the sick and the wave's height closes in a step, while the plague is spreading and while it is fading (percent).
pub(crate) const SPREAD_PCT: u32 = 25;
pub(crate) const FADE_PCT: u32 = 18;
/// What the sick who are left when the outbreak is over do: this much of them recover each step (percent).
pub(crate) const LINGER_PCT: u32 = 40;
/// Chance, in millionths, that one sick villager dies in one step (3% a day, with nothing to help them).
pub(crate) const DEATH_PPM: u64 = 3_000;
/// Prevention: each of these (percent) is added to the 100 that the wave's peak is divided by.
pub(crate) const WELL_PREVENTS: u32 = 15;
pub(crate) const PARK_PREVENTS: u32 = 10;
pub(crate) const CHAPEL_PREVENTS: u32 = 20;
pub(crate) const BED_PREVENTS: u32 = 3;
/// Care: each of these (percent) is added to the 100 that the chance of dying is divided by. A chapel tier, a staffed bed, a ward for the worst cases, a quarantine.
pub(crate) const CHAPEL_CARES: u32 = 25;
pub(crate) const BED_CARES: u32 = 5;
pub(crate) const WARD_CARES: u32 = 60;
pub(crate) const QUARANTINE_CARES: u32 = 50;
/// A quarantine keeps the sick apart: the peak is this much lower (percent) and they last this many days.
pub(crate) const QUARANTINE_CUT_PCT: u32 = 35;
pub(crate) const QUARANTINE_DAYS: u64 = 7;
/// Healing: percent added to the fade speed for each chapel tier, each staffed bed (up to ten), each herb garden, and while quarantined.
pub(crate) const CHAPEL_HEALS: u32 = 2;
pub(crate) const BED_HEALS: u32 = 2;
pub(crate) const HERB_HEALS: u32 = 3;
pub(crate) const QUARANTINE_HEALS: u32 = 8;
pub(crate) const MAX_FADE_PCT: u32 = 60;
/// Unburied dead feed the plague: each one adds a point to the peak, up to this many.
pub(crate) const UNBURIED_MAX: u32 = 12;
/// How often an outbreak starts: one in `START_ODDS` per step, to which these are added for wells, chapel tiers, parks and hospital beds (halved in a cold house).
pub(crate) const START_ODDS: u32 = 250;
pub(crate) const WELL_ODDS: u32 = 110;
pub(crate) const CHAPEL_ODDS: u32 = 220;
pub(crate) const PARK_ODDS: u32 = 83;
pub(crate) const BED_ODDS: u32 = 66;
/// A village smaller than this is never struck.
pub(crate) const MIN_POPULATION: u32 = 15;

/// How many percent of the village are ill at `phase` (per mille of the way through the outbreak) when the peak is `peak` percent: a climb from `SEED_PCT` to the peak, then a slow fall to nothing.
pub(crate) fn wave_pct(phase: u64, peak: u32) -> u32 {
    let phase = phase.min(1000);
    if phase < PEAK_AT { SEED_PCT.min(peak) + ((peak.saturating_sub(SEED_PCT)) as u64 * phase / PEAK_AT) as u32 } else { (peak as u64 * (1000 - phase) / (1000 - PEAK_AT)) as u32 }
}

impl World {
    /// Is an outbreak running?
    pub fn plague_active(&self) -> bool { self.tick < self.plague_end }
    /// [started at tick, ends at tick] of the latest outbreak (zeros before the first).
    pub fn plague_span(&self) -> Vec<u32> { vec![self.plague_start as u32, self.plague_end as u32] }

    /// `n` chances of `ppm` millionths each, counted without rounding them away: the remainder is a chance for one more.
    fn chances(&mut self, n: u32, ppm: u64) -> u32 {
        let x = n as u64 * ppm;
        (x / 1_000_000) as u32 + (((self.rng.range(1_000_000)) as u64) < x % 1_000_000) as u32
    }

    /// Begin an outbreak now: how long it runs is drawn from the world's random stream.
    pub(crate) fn start_plague(&mut self) {
        let days = MIN_DAYS + self.rng.range(EXTRA_DAYS) as u64;
        self.plague_start = self.tick; self.plague_end = self.tick + days * DAY;
        self.sick = (self.population * SEED_PCT / 100).max(2).min(self.population);
        self.push_event(EV_PLAGUE, self.sick as i32, 0);
        self.offer(CH_PLAGUE);
    }

    /// End the outbreak at once and heal everybody (an abbey, the testing tools).
    pub(crate) fn end_plague(&mut self) {
        if self.sick > 0 { self.push_event(EV_PLAGUE_END, 0, 0); }
        self.sick = 0; self.plague_end = self.plague_end.min(self.tick);
    }

    /// Called every tick; the plague moves once a step.
    pub(crate) fn plague_step(&mut self) {
        if self.tick % STEP != 0 { return; }
        let wells = self.buildings.iter().filter(|b| b.kind == WELL).count() as u32;
        let parks = self.buildings.iter().filter(|b| b.kind == PARK).count() as u32;
        let chapels: u32 = self.buildings.iter().filter(|b| b.kind == CHAPEL).map(|b| b.tier as u32 + 1).sum();
        let beds = self.hospital_beds();
        if self.sick == 0 && self.plague_idle() {
            if self.population > MIN_POPULATION && self.rng.range((START_ODDS + WELL_ODDS * wells + CHAPEL_ODDS * chapels + PARK_ODDS * parks + BED_ODDS * beds) / if self.warm { 1 } else { 2 }) == 0 { self.start_plague(); }
            return;
        }
        if self.sick == 0 { return; }
        let q = self.tick < self.quarantine_until;
        let wards = self.buildings.iter().filter(|b| b.kind == HOSPITAL && b.staff > 0 && b.opts & 2 != 0).count() as u32;
        let herbs = self.buildings.iter().filter(|b| b.kind == HOSPITAL && b.staff > 0 && b.opts & 1 != 0).count() as u32;
        if self.plague_active() {
            // the wave: how many of the village should be ill by now, given everything that holds the plague back
            let phase = (self.tick - self.plague_start) * 1000 / (self.plague_end - self.plague_start).max(1);
            let mut peak = PEAK_PCT * 100 / (100 + WELL_PREVENTS * wells + PARK_PREVENTS * parks + CHAPEL_PREVENTS * chapels + BED_PREVENTS * beds);
            if q { peak = peak * (100 - QUARANTINE_CUT_PCT) / 100; }
            peak = (peak + self.unburied.min(UNBURIED_MAX)).max(4);
            let want = (self.population * wave_pct(phase, peak) + 99) / 100;
            if self.sick < want {
                let n = ((want - self.sick) * SPREAD_PCT / 100).max(1).min(self.population - self.sick);
                self.sick += n;
            } else {
                let fade = (FADE_PCT + CHAPEL_HEALS * chapels + BED_HEALS * beds.min(10) + HERB_HEALS * herbs + if q { QUARANTINE_HEALS } else { 0 }).min(MAX_FADE_PCT);
                self.sick -= ((self.sick - want) * fade / 100).max(if self.sick > want { 1 } else { 0 }).min(self.sick);
            }
        } else {
            self.sick -= (self.sick * LINGER_PCT / 100).max(1).min(self.sick);   // it is over: the last of the sick recover
        }
        // the dying
        let care = 100 + CHAPEL_CARES * chapels + BED_CARES * beds + WARD_CARES * wards.min(1) + if q { QUARANTINE_CARES } else { 0 };
        let dead = self.chances(self.sick, DEATH_PPM * 100 / care as u64).min(self.sick).min(self.population);
        self.kill(dead, DIED_PLAGUE, 2);
        self.sick -= dead.min(self.sick);
        self.sick = self.sick.min(self.population);
        if self.sick == 0 { self.push_event(EV_PLAGUE_END, 0, 0); }
    }

    /// Nothing is running and the cooldown after the last outbreak is over.
    fn plague_idle(&self) -> bool { self.tick >= self.plague_end + COOLDOWN_DAYS * DAY }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A village of `pop` people with plenty of food and fuel (so only the plague kills), optionally with a hospital, chapel and wells.
    fn village(seed: u64, pop: u32, help: bool) -> World {
        let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
        for (x, y) in [(14, 4), (20, 8), (-14, 6), (-20, 12), (6, 26), (-6, 26), (26, -10), (-26, -10), (30, 6), (-30, 6)] { w.place(HOUSE, x, y, 0); }
        w.place(FARM, 30, 20, 0);
        if help { assert!(w.place(HOSPITAL, 10, -22, 0) >= 0); w.place(CHAPEL, -22, -22, 0); w.place(WELL, 4, 14, 0); w.place(GRAVEYARD, 40, -20, 0); }
        w.cheat(1, pop as i32, 0); w.population = pop; w.children = 0; w.elders = 0; w.staffing();
        w.army = [40, 20, 20, 10, 0, 0];   // a garrison, so that the bandits who come now and then are beaten off and only the plague kills
        w.rng = Rng(seed * 7919 + 11); for _ in 0..40 { w.rng.next(); }   // (a small seed gives poor first numbers)
        w
    }
    /// Start an outbreak at the next step and run it to the end, keeping the stores full; returns the sick at the end of every day.
    fn outbreak(w: &mut World, quarantine: bool) -> Vec<u32> {
        w.tick = (w.tick / STEP + 1) * STEP; w.start_plague();
        if quarantine { assert_eq!(w.choose(0), 0); }
        let end = w.plague_end + 3 * DAY; let mut days = vec![];
        while w.tick < end {
            w.step();
            if w.tick % 20 == 0 { w.stock[GR as usize] = 3000; w.stock[W as usize] = 3000; }
            if w.tick % DAY == 0 { days.push(w.sick()); }
        }
        days
    }

    #[test]
    fn an_outbreak_runs_for_ten_to_twenty_days_in_waves() {
        let mut lengths = std::collections::BTreeSet::new();
        for seed in 0..40 {
            let mut w = village(seed, 60, false); let t0 = (w.tick / STEP + 1) * STEP;
            let days = outbreak(&mut w, false);
            let len = (w.plague_end - w.plague_start) / DAY; lengths.insert(len);
            assert!((10..=20).contains(&len), "seed {seed}: it lasts {len} days");
            assert_eq!(w.plague_start, t0);
            let (start, end) = (0usize, len as usize);
            assert!(days[start + 8] > 0, "seed {seed}: still going on the ninth day ({days:?})");
            assert!(days[end..].contains(&0), "seed {seed}: over some days after the end ({days:?})");
            let peak = *days[..end].iter().max().unwrap(); let peak_day = days[..end].iter().position(|&v| v == peak).unwrap();
            assert!(peak > days[0] || peak >= 2, "seed {seed}: it spreads before it peaks ({days:?})");
            assert!(peak_day * 100 / end <= 70 && peak_day * 100 / end >= 5, "seed {seed}: it peaks in the first half or so, day {peak_day} of {end} ({days:?})");
            let tail = days[end * 85 / 100..end].iter().max().copied().unwrap_or(0);
            assert!(tail * 2 <= peak.max(2), "seed {seed}: it fades before the end: {tail} at the end against a peak of {peak} ({days:?})");
        }
        assert!(lengths.len() >= 6, "the lengths vary: {lengths:?}");
    }

    #[test]
    fn a_village_survives_a_plague_with_or_without_a_hospital() {
        let (mut lost_bare, mut lost_helped, mut lost_quarantined, mut worst) = (0, 0, 0, 100);
        for seed in 0..30 {
            let mut a = village(seed, 60, false); let p = a.population; outbreak(&mut a, false);
            let (da, dead_a) = (a.died[DIED_PLAGUE], a.died[DIED_PLAGUE] * 100 / p);
            lost_bare += da; worst = worst.min(100 - dead_a);
            let mut b = village(seed, 60, true); let p2 = b.population + b.died[DIED_PLAGUE]; outbreak(&mut b, false);
            lost_helped += b.died[DIED_PLAGUE]; worst = worst.min(100 - b.died[DIED_PLAGUE] * 100 / p2);
            let mut c = village(seed, 60, false); outbreak(&mut c, true);
            lost_quarantined += c.died[DIED_PLAGUE];
            assert!(da <= p / 2, "seed {seed}: {da} of {p} died");
        }
        assert!(worst >= 55, "even the worst outbreak leaves {worst}% of the village alive");
        assert!(lost_bare > 30, "a plague does kill: {lost_bare} dead in 30 outbreaks");
        assert!(lost_helped < lost_bare, "a hospital, a chapel, a well and a graveyard save lives: {lost_helped} dead against {lost_bare}");
        assert!(lost_quarantined < lost_bare, "a quarantine saves lives: {lost_quarantined} dead against {lost_bare}");
    }

    #[test]
    fn nothing_ends_an_outbreak_at_once() {
        // even with every help, the sick are still there three days in, and an abbey's cure (or the testing tool) is the only quick end
        let mut w = village(3, 60, true); w.tick = (w.tick / STEP + 1) * STEP; w.start_plague(); w.choose(0);
        for _ in 0..(3 * DAY) { w.step(); if w.tick % 20 == 0 { w.stock[GR as usize] = 3000; } }
        assert!(w.sick() > 0 && w.plague_active(), "still ill after three days: {}", w.sick());
        assert!(w.cheat(6, 0, 0)); assert_eq!(w.sick(), 0); assert!(!w.plague_active());
    }

    #[test]
    fn quarantine_lasts_a_week_and_the_wave_has_the_shape_it_says() {
        assert!(wave_pct(0, PEAK_PCT) == SEED_PCT && wave_pct(PEAK_AT, PEAK_PCT) == PEAK_PCT && wave_pct(1000, PEAK_PCT) == 0);
        let mut last = 0; for p in (0..=PEAK_AT).step_by(10) { let v = wave_pct(p, 30); assert!(v >= last); last = v; }
        for p in (PEAK_AT..=1000).step_by(10) { let v = wave_pct(p, 30); assert!(v <= last); last = v; }
        assert_eq!(QUARANTINE_DAYS, 7);
        let mut w = village(1, 60, false); w.offer(CH_PLAGUE); let t = w.tick; w.choose(0); assert_eq!(w.quarantine_until, t + 7 * DAY);
    }

    #[test]
    fn the_plague_is_the_same_on_every_peer() {
        let hashes = |seed: u64| {
            let mut w = village(seed, 60, true); let mut out = vec![];
            w.tick = (w.tick / STEP + 1) * STEP; w.start_plague(); w.choose(0);
            for t in 0..(12 * DAY) { w.step(); if w.tick % 20 == 0 { w.stock[GR as usize] = 3000; w.stock[W as usize] = 3000; } if t % 240 == 0 { out.push((w.state_hash_parts(), w.sick(), w.population)); } }
            out
        };
        assert_eq!(hashes(5), hashes(5), "two peers running the same commands agree on every day of the plague");
        assert_ne!(hashes(5), hashes(6), "and another stream is another plague");
        // a chance start (nobody asked for it) also follows the random stream alone
        let first = |seed: u64| { let mut w = village(seed, 60, false); for _ in 0..(120 * DAY) { w.step(); if w.tick % 20 == 0 { w.stock[GR as usize] = 3000; w.stock[W as usize] = 3000; } if w.tick % DAY == 0 { w.cheat(1, 60, 0); } if w.plague_active() { return Some(w.plague_start); } } None };
        let seeds: Vec<u64> = (9..15).collect(); assert!(seeds.iter().all(|&k| first(k) == first(k))); assert!(seeds.iter().any(|&k| first(k).is_some()), "left alone for 120 days, a village of 60 is struck in some world");
    }
}

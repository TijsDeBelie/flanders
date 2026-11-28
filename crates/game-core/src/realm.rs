//! How the village is ruled: standing decrees, the needs of its houses, how people come and go, soldiers' wages, renown and titles with their charters,
//! and the focus the lord gives the village for a while. One state block (`Realm`), part of the state hash and carried in snapshot layout F.
//!
//! The rules, in one place (every peer runs them identically; nothing here draws from the village's random stream except the arrival of newcomers,
//! which always took one draw a tick):
//! * **Decrees** (`realm_act` 1-4): taxes low / normal / high (gold x0.5 / x1 / x1.5, happiness +6 / 0 / -8); rations normal / lean / generous (food eaten
//!   x1 / x0.8 / x1.2, happiness 0 / -6 / +4, no births on lean rations); long hours (workplaces +15%, happiness -6); muster (twice the militia in a raid,
//!   workplaces -10% while it stands).
//! * **Happiness has teeth.** Newcomers arrive `2 + happiness / 10` a day while there is room and food (they used to fill a house in seconds); below
//!   `UNREST` one villager leaves a day (not in the first `SETTLING_DAYS`); newcomers only come while the stores hold a meal for every villager; it sets the pace of every workplace: 90% below 20, 105% above 70.
//! * **Needs by house tier.** A house of tier 1 or more wants a second food besides grain in the stores (bread, fish or meat); tier 2 or more also a market
//!   and a chapel; tier 3 also tools in store and a well. A house is upgraded only when the needs of its next tier are met (`upgrade` returns -31), and
//!   every house whose needs are not met costs happiness (up to `NEEDS_HAPPY` when none are).
//! * **Wages.** Once a day every soldier is paid: one coin per `WAGE_HOME` soldiers at home (barracks, towers), one per `WAGE_FIELD` out in the field or holding
//!   a mineshaft. What cannot be paid is owed by a deserter: one soldier walks off a day while the chest is empty.
//! * **Renown and titles.** Renown is counted from what the village is and has done (people, the hall, camps cleared, lairs taken, shafts held, years);
//!   titles at `TITLES` renown: Lord, Baron, Count, Duke (a title once reached is kept). Each title above Lord lets the lord grant one charter (`realm_act` 5).
//!   Bandits raid a titled village harder: +10% strength a title.
//! * **Focus.** Every `FOCUS_EVERY_DAYS` days the reeve proposes three or four focus areas (a decision, `CH_FOCUS`); each costs goods or gold and gives its
//!   bonus for `FOCUS_DAYS` days. Turning them all down costs nothing.
//! * **The first bandit raid is a small one** (half strength): a new village that has a watchtower and a few houses can hold it off on its own.
use super::*;

pub const TAX_LOW: u8 = 1; pub const TAX_HIGH: u8 = 2;
pub const RATIONS_LEAN: u8 = 1; pub const RATIONS_GENEROUS: u8 = 2;
pub const UNREST: u32 = 30;
/// Nobody leaves for unhappiness in the first days, while the village settles in.
pub const SETTLING_DAYS: u64 = 4;
pub const NEEDS_HAPPY: i32 = 12;
pub const WAGE_HOME: u32 = 3;
pub const WAGE_FIELD: u32 = 2;
/// Renown for each title: Baron, Count, Duke (below the first: Lord).
pub const TITLES: [u32; 3] = [150, 350, 700];
pub const FOCUS_EVERY_DAYS: u64 = 12;
pub const FOCUS_FIRST_DAY: u64 = 6;
pub const FOCUS_DAYS: u64 = 8;

/// The charters a titled lord may grant (one per title above Lord): 0 market, 1 mining, 2 military, 3 farming, 4 piety.
pub const CHARTERS: u8 = 5;
pub const CH_MARKET: u8 = 0; pub const CH_MINING: u8 = 1; pub const CH_MILITARY: u8 = 2; pub const CH_FARMING: u8 = 3; pub const CH_PIETY: u8 = 4;

/// The focus areas (ids from 1): war, farming, diplomacy, trade, faith, industry, mining.
pub const FOCI: u8 = 7;
pub const F_WAR: u8 = 1; pub const F_FARMING: u8 = 2; pub const F_DIPLOMACY: u8 = 3; pub const F_TRADE: u8 = 4; pub const F_FAITH: u8 = 5; pub const F_INDUSTRY: u8 = 6; pub const F_MINING: u8 = 7;
/// What each focus costs to take up.
pub fn focus_cost(id: u8) -> &'static [(u8, i32)] {
    match id {
        F_WAR => &[(GD, 40), (IR, 10)],
        F_FARMING => &[(TL, 10), (GD, 20)],
        F_DIPLOMACY => &[(GD, 60)],
        F_TRADE => &[(GR, 80), (GD, 20)],
        F_FAITH => &[(GD, 50)],
        F_INDUSTRY => &[(W, 40), (ST, 20), (TL, 6)],
        F_MINING => &[(TL, 12), (GR, 40)],
        _ => &[],
    }
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct Realm {
    pub tax: u8,          // 0 normal, 1 low, 2 high
    pub rations: u8,      // 0 normal, 1 lean, 2 generous
    pub long_hours: bool,
    pub muster: bool,
    pub charters: Vec<u8>,
    pub title: u8,        // the highest title reached: 0 Lord .. 3 Duke
    pub offer: Vec<u8>,   // the focus areas on offer while the CH_FOCUS decision waits
    pub focus: u8,        // the focus now (0 none)
    pub focus_until: u64,
    pub bandit_raids: u32,
}

impl Realm {
    pub fn valid(&self) -> bool {
        self.tax <= 2 && self.rations <= 2 && self.title <= 3 && self.charters.len() <= self.title as usize && self.charters.iter().all(|&c| c < CHARTERS)
            && self.offer.len() <= 4 && self.offer.iter().all(|&f| (1..=FOCI).contains(&f)) && self.focus <= FOCI
    }
    pub fn mix(&self, mix: &mut dyn FnMut(u64)) {
        mix(self.tax as u64); mix(self.rations as u64); mix(self.long_hours as u64); mix(self.muster as u64); mix(self.title as u64);
        mix(self.charters.len() as u64); for &c in &self.charters { mix(c as u64); }
        mix(self.offer.len() as u64); for &f in &self.offer { mix(f as u64); }
        mix(self.focus as u64); mix(self.focus_until); mix(self.bandit_raids as u64);
    }
    pub fn has(&self, charter: u8) -> bool { self.charters.contains(&charter) }
}

impl World {
    pub(crate) fn focus_on(&self, f: u8) -> bool { self.realm.focus == f && self.tick < self.realm.focus_until }

    /// The village-wide part of a workplace's pace, in percent: happiness, decrees, the focus and charters.
    pub(crate) fn realm_pace(&self, kind: u8, happiness: u32) -> u32 {
        let d = &DEFS[kind as usize];
        let mut p: u32 = if happiness < 20 { 90 } else if happiness > 70 { 105 } else { 100 };
        if self.realm.long_hours { p = p * 115 / 100; }
        if self.realm.muster { p = p * 90 / 100; }
        if kind == FARM { if self.focus_on(F_FARMING) { p = p * 125 / 100; } if self.realm.has(CH_FARMING) { p = p * 110 / 100; } }
        if d.req == 1 { if self.focus_on(F_MINING) { p = p * 130 / 100; } if self.realm.has(CH_MINING) { p = p * 115 / 100; } }
        if d.cat == 3 && self.focus_on(F_INDUSTRY) { p = p * 120 / 100; }
        p
    }
    /// What decrees, focus, charters and unmet needs add to happiness.
    pub(crate) fn realm_happy(&self) -> i32 {
        let mut h = match self.realm.tax { TAX_LOW => 6, TAX_HIGH => -8, _ => 0 } + match self.realm.rations { RATIONS_LEAN => -6, RATIONS_GENEROUS => 4, _ => 0 };
        if self.realm.long_hours { h -= 6; }
        if self.focus_on(F_FAITH) { h += 8; }
        if self.realm.has(CH_PIETY) { h += 4; }
        let houses: Vec<u8> = self.buildings.iter().filter(|b| b.kind == HOUSE).map(|b| b.tier).collect();
        if !houses.is_empty() {
            let unmet = houses.iter().filter(|&&t| !self.needs_met(t)).count() as i32;
            h -= NEEDS_HAPPY * unmet / houses.len() as i32;
        }
        h
    }
    /// The needs of a house of this tier: [second food, market, chapel, tools, well], each 1 if the house needs it.
    fn needs_of(tier: u8) -> [bool; 5] { [tier >= 1, tier >= 2, tier >= 2, tier >= 3, tier >= 3] }
    /// What the village has of the things houses need: [second food, market, chapel, tools, well].
    fn needs_have(&self) -> [bool; 5] {
        let has = |k: u8| self.buildings.iter().any(|b| b.kind == k);
        [[BD, FI, SF, ME, SM].iter().any(|&r| self.stock[r as usize] > 0), has(MARKET), has(CHAPEL), self.stock[TL as usize] > 0, has(WELL)]
    }
    pub(crate) fn needs_met(&self, tier: u8) -> bool { let (n, h) = (Self::needs_of(tier), self.needs_have()); (0..5).all(|i| !n[i] || h[i]) }

    /// Food eaten, in percent of the usual (the rations decree).
    pub(crate) fn ration_pct(&self) -> i32 { match self.realm.rations { RATIONS_LEAN => 80, RATIONS_GENEROUS => 120, _ => 100 } }
    /// Taxes, in percent of the usual.
    pub(crate) fn tax_pct(&self) -> i32 {
        (match self.realm.tax { TAX_LOW => 50, TAX_HIGH => 150, _ => 100 }) + if self.focus_on(F_TRADE) { 25 } else { 0 } + if self.realm.has(CH_MARKET) { 10 } else { 0 }
    }
    /// One newcomer in this many ticks while there is room and food: `2 + happiness / 10` a day.
    pub(crate) fn arrival_one_in(&self, happiness: u32) -> u32 { ((DAY as u32) / (2 + happiness / 10)).max(1) }
    /// Training speed in percent (the war focus and the military charter).
    pub(crate) fn train_pct(&self) -> u32 { 100 + if self.focus_on(F_WAR) { 50 } else { 0 } + if self.realm.has(CH_MILITARY) { 25 } else { 0 } }
    /// The militia called up in a raid, in percent.
    pub(crate) fn militia_pct(&self) -> u32 { 100 + if self.realm.muster { 100 } else { 0 } + if self.focus_on(F_WAR) { 50 } else { 0 } }
    /// The market's markup, percent (the trade focus brings it down).
    pub(crate) fn markup_pct(&self) -> i64 { if self.focus_on(F_TRADE) { 105 } else { market::MARKUP_PCT } }

    /// Soldiers at home (barracks, towers) and out (field armies, mineshaft garrisons), and what they cost a day.
    pub(crate) fn wages(&self) -> (u32, u32, i32) {
        let home: u32 = self.army.iter().sum::<u32>();
        let field: u32 = self.dets.iter().filter(|d| d.ally == 0).map(|d| d.units.iter().sum::<u32>()).sum::<u32>() + self.garrisoned();
        let mut pay = home.div_ceil(WAGE_HOME) + field.div_ceil(WAGE_FIELD);
        if self.realm.has(CH_MILITARY) { pay = pay * 3 / 4; }
        (home, field, pay as i32)
    }

    /// Renown: what the village is and has done.
    pub fn renown(&self) -> u32 {
        let list = terrain::neutrals(self.seed);
        let camps = list.iter().enumerate().filter(|(i, n)| n.0 == 2 && self.neutral_done.get(*i).copied().unwrap_or(false)).count() as u32;
        let lairs = list.iter().enumerate().filter(|(i, n)| n.0 == 3 && self.neutral_done.get(*i).copied().unwrap_or(false)).count() as u32;
        let shafts = self.wilds.shafts.iter().filter(|s| s.garrison.iter().sum::<u32>() > 0).count() as u32;
        let hall = self.buildings.first().map_or(0, |b| b.tier as u32);
        self.population + 30 * hall + 25 * camps + 60 * lairs + 40 * shafts + 20 * (self.year() - 1)
    }
    pub(crate) fn title_of(renown: u32) -> u8 { TITLES.iter().filter(|&&t| renown >= t).count() as u8 }

    /// A bandit raid's strength, after the village's title and the mercy shown to a village's first raid.
    pub(crate) fn bandit_raid_force(&mut self, rf: f32) -> [u32; NK] {
        let mut f = self.bandit_force(rf);
        let scale = if self.realm.bandit_raids == 0 { 0.5 } else { 1.0 + 0.1 * self.realm.title as f32 };
        for n in f.iter_mut() { *n = ((*n as f32) * scale).round() as u32; }
        if f.iter().sum::<u32>() == 0 { f[0] = 2; }
        self.realm.bandit_raids += 1;
        f
    }

    /// Once a day: people leave when unhappy, wages are paid, the title rises, diplomacy and faith work, a focus is proposed.
    pub(crate) fn realm_step(&mut self) {
        if self.tick % DAY != 0 || self.tick == 0 { return; }
        let day = self.tick / DAY;
        let hap = self.happiness();
        if hap < UNREST && self.population > 5 && day > SETTLING_DAYS { self.leave(1); self.push_event(EV_REALM, R_LEFT, hap as i32); }
        // wages
        let (_, _, pay) = self.wages();
        if pay > 0 {
            if self.stock[GD as usize] >= pay { self.stock[GD as usize] -= pay; }
            else {
                self.stock[GD as usize] = 0;
                // one deserter: from the barracks first, then a field army, then a mineshaft
                if let Some(k) = (0..NK).rev().find(|&k| self.army[k] > 0) { self.army[k] -= 1; self.vets[k] = self.vets[k].min(self.army[k]); }
                else if let Some(d) = self.dets.iter_mut().filter(|d| d.ally == 0 && d.state != march::S_FIGHT).find(|d| d.units.iter().sum::<u32>() > 1) { if let Some(k) = (0..NK).rev().find(|&k| d.units[k] > 0) { d.units[k] -= 1; d.grp.clear(); } }
                else if let Some(s) = self.wilds.shafts.iter_mut().find(|s| s.garrison.iter().sum::<u32>() > 1) { if let Some(k) = (0..NK).rev().find(|&k| s.garrison[k] > 0) { s.garrison[k] -= 1; } }
                self.push_event(EV_REALM, R_DESERTED, pay);
            }
        }
        // titles
        let t = Self::title_of(self.renown());
        if t > self.realm.title { self.realm.title = t; self.push_event(EV_REALM, R_TITLE, t as i32); }
        // a focus at work
        if self.focus_on(F_DIPLOMACY) { for r in self.relations.iter_mut() { r.1 = (r.1 + 1).min(100); } }
        if self.focus_on(F_FAITH) && self.sick > 0 { self.sick -= 1; }
        if self.realm.focus != 0 && self.tick >= self.realm.focus_until { self.realm.focus = 0; self.push_event(EV_REALM, R_FOCUS_END, 0); }
        // a focus proposed
        if day >= FOCUS_FIRST_DAY && (day - FOCUS_FIRST_DAY) % FOCUS_EVERY_DAYS == 0 && self.choice.is_none() && self.realm.focus == 0 {
            let n = 3 + (terrain::h01(self.seed ^ 0xF0C5, day as i32, 0) < 0.5) as usize;
            let mut pool: Vec<u8> = (1..=FOCI).collect();
            let mut offer = vec![];
            for k in 0..n { let i = (terrain::h01(self.seed ^ 0xF0C5, day as i32, k as i32 + 1) * pool.len() as f32) as usize % pool.len(); offer.push(pool.remove(i)); }
            self.realm.offer = offer;
            self.offer(CH_FOCUS);
        }
    }
}

/// What a realm event says (EV_REALM's `a`).
pub const R_LEFT: i32 = 1;
pub const R_DESERTED: i32 = 2;
pub const R_TITLE: i32 = 3;
pub const R_FOCUS_END: i32 = 4;

#[wasm_bindgen]
impl World {
    /// The lord's standing orders (`realm` command): 1 taxes (0 normal, 1 low, 2 high), 2 rations (0 normal, 1 lean, 2 generous), 3 long hours (0/1), 4 muster (0/1),
    /// 5 grant charter `value` (0 market, 1 mining, 2 military, 3 farming, 4 piety; one per title above Lord, each once). 0 done, -1 no such order or value, -2 no charter left to grant.
    pub fn realm_act(&mut self, action: u8, value: i32) -> i32 {
        match (action, value) {
            (1, 0..=2) => { self.realm.tax = value as u8; 0 }
            (2, 0..=2) => { self.realm.rations = value as u8; 0 }
            (3, 0..=1) => { self.realm.long_hours = value == 1; 0 }
            (4, 0..=1) => { self.realm.muster = value == 1; 0 }
            (5, v) if (0..CHARTERS as i32).contains(&v) => {
                if self.realm.has(v as u8) { return -1; }
                if self.realm.charters.len() >= self.realm.title as usize { return -2; }
                self.realm.charters.push(v as u8); 0
            }
            _ => -1,
        }
    }
    /// The realm for the interface: [taxes, rations, long hours, muster, title, renown, renown of the next title (0 at the top), charters left to grant, focus, days of it left,
    /// soldiers at home, out, wages a day, then the charters granted].
    pub fn realm_flat(&self) -> Vec<i32> {
        let r = &self.realm; let (home, field, pay) = self.wages();
        let next = TITLES.get(r.title as usize).copied().unwrap_or(0);
        let mut v = vec![r.tax as i32, r.rations as i32, r.long_hours as i32, r.muster as i32, r.title as i32, self.renown() as i32, next as i32,
            r.title as i32 - r.charters.len() as i32, if self.focus_on(r.focus) { r.focus as i32 } else { 0 },
            if self.focus_on(r.focus) { (r.focus_until - self.tick).div_ceil(DAY) as i32 } else { 0 }, home as i32, field as i32, pay];
        v.extend(r.charters.iter().map(|&c| c as i32));
        v
    }
    /// The focus areas on offer (ids) while a focus decision waits.
    pub fn focus_offer(&self) -> Vec<u8> { if matches!(self.choice, Some((CH_FOCUS, _))) { self.realm.offer.clone() } else { vec![] } }
    /// What the houses need and what the village has: for each need [second food, market, chapel, tools, well] the lowest house tier that needs it, then 1 if the village has it.
    pub fn house_needs(&self) -> Vec<i32> { let h = self.needs_have(); vec![1, 2, 2, 3, 3, h[0] as i32, h[1] as i32, h[2] as i32, h[3] as i32, h[4] as i32] }
}

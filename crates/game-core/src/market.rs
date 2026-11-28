//! The market: stalls sell a few basic goods for gold, in limited amounts that come back day by day.
//!
//! Everything that can be tuned is in the table and constants below. The rules (every peer runs them identically, they depend only on the state of the world):
//! * The *village* has one stock per good, not one per stall. What is stored is how much has been **sold** of each good (`market_sold`); what is left is `cap - sold`, so a new stall
//!   starts full and nothing needs to be initialised.
//! * `cap` and `refill` of a good are the table's numbers scaled by the stalls: the best stall counts in full at its tier (`TIER_PCT`: Stalls 100%, Square 150%, Hall 200%,
//!   Grand Market 300%), every further stall adds half (`EXTRA_PCT`) of its own tier's scale. (So with the table's 200 and 50, one Market Stalls sells up to 200 wood and is back to 200 after four days.)
//! * On every day boundary `sold` falls by `refill` (not below 0). With no market standing the sold counts are forgotten.
//! * A unit costs the usual price (`World::price_x100`, coins x 100: dearer when the village runs short of it) with a markup of `MARKUP_PCT`, rounded up per purchase.
//! * `buy(res, n)`: 0 ok, -1 no such good here (or n < 1), -2 not that much left, -6 not enough gold, -7 no room in the stores.
use super::*;

/// The goods on sale and, for one "Market Stalls" (tier 1): the most of it in stock, and how much comes back each day.
pub const MARKET_GOODS: [(u8, i32, i32); 5] = [(W, 200, 50), (ST, 200, 50), (CL, 200, 50), (GR, 200, 50), (PL, 100, 25)];
/// Percent of the table's numbers a stall gives by tier (index = tier 0..3).
pub const TIER_PCT: [i32; 4] = [100, 150, 200, 300];
/// Percent of its tier's scale that each stall after the best one adds.
pub const EXTRA_PCT: i32 = 50;
/// The stall's price over the village's usual price, percent.
pub const MARKUP_PCT: i64 = 130;
const TOOL_PRICE: i32 = 15;
const TOOL_RESTOCK: u64 = 3 * DAY;

impl World {
    /// Percent of the table's numbers the village's markets give together (0 with no market).
    fn market_scale(&self) -> i32 {
        let mut pcts: Vec<i32> = self.buildings.iter().filter(|b| b.kind == MARKET).map(|b| TIER_PCT[(b.tier as usize).min(3)]).collect();
        pcts.sort_unstable_by(|a, b| b.cmp(a));
        pcts.iter().enumerate().map(|(i, p)| if i == 0 { *p } else { p * EXTRA_PCT / 100 }).sum()
    }
    fn market_slot(res: u8) -> Option<usize> { MARKET_GOODS.iter().position(|g| g.0 == res) }
    /// The most of a good the markets hold, and the amount that comes back each day.
    fn market_cap_refill(&self, slot: usize) -> (i32, i32) { let s = self.market_scale(); (MARKET_GOODS[slot].1 * s / 100, MARKET_GOODS[slot].2 * s / 100) }
    fn market_left(&self, slot: usize) -> i32 { (self.market_cap_refill(slot).0 - self.market_sold[slot]).max(0) }
    /// What `n` units of a good cost at the market now, in coins.
    pub(crate) fn market_cost(&self, res: u8, n: i32) -> i32 {
        if res == TL { return n.saturating_mul(TOOL_PRICE); }
        ((self.price_x100(res as usize) as i64 * n as i64 * self.markup_pct() + 9_999) / 10_000).min(i32::MAX as i64) as i32
    }

    pub(crate) fn refill_emergency_tools(&mut self) {
        while self.emergency_tools[0] > 0 && self.tick >= self.emergency_tools[1] {
            self.emergency_tools[0] -= 1;
            self.emergency_tools[1] = if self.emergency_tools[0] == 0 { 0 } else { self.emergency_tools[1] + TOOL_RESTOCK };
        }
    }

    /// Once a day: the stalls are restocked.
    pub(crate) fn market_refill(&mut self) {
        self.refill_emergency_tools();
        if self.market_scale() == 0 { self.market_sold = [0; MARKET_GOODS.len()]; return; }
        for s in 0..MARKET_GOODS.len() { let r = self.market_cap_refill(s).1; self.market_sold[s] = (self.market_sold[s] - r).max(0); }
    }
}

#[wasm_bindgen]
impl World {
    /// What the markets offer: [resource, left, most in stock, refill a day, price of one unit in coins x 100 (markup included), days until the stock is full again] for each good; empty with no market.
    pub fn market_goods(&self) -> Vec<i32> {
        if self.market_scale() == 0 { return vec![]; }
        let mut v = Vec::with_capacity(MARKET_GOODS.len() * 6);
        for (s, g) in MARKET_GOODS.iter().enumerate() {
            let (cap, refill) = self.market_cap_refill(s); let sold = self.market_sold[s].max(0);
            let days = if sold == 0 || refill <= 0 { 0 } else { (sold + refill - 1) / refill };
            v.extend([g.0 as i32, (cap - sold).max(0), cap, refill, (self.price_x100(g.0 as usize) as i64 * self.markup_pct() / 100) as i32, days]);
        }
        if self.estate.active {
            let [sold, next] = self.emergency_tools;
            let until_full = if sold == 0 { 0 } else { (next.saturating_sub(self.tick) + (sold - 1) * TOOL_RESTOCK).div_ceil(DAY) };
            v.extend([TL as i32, 2 - sold as i32, 2, 0, TOOL_PRICE * 100, until_full as i32]);
        }
        v
    }
    /// How much of one good the stores hold at most.
    pub fn storage_limit(&self) -> i32 { self.storage_cap() }
    /// Buy `n` units of a good from the markets with gold. Returns 0 ok, -1 not on sale (or nothing asked), -2 not that much left, -6 not enough gold, -7 the stores have no room.
    pub fn buy(&mut self, res: u8, n: i32) -> i32 {
        if res == TL && self.estate.active {
            if n < 1 || self.market_scale() == 0 { return -1; }
            if n > 2 - self.emergency_tools[0] as i32 { return -2; }
            let cost = self.market_cost(res, n);
            if self.stock[GD as usize] < cost { return -6; }
            if self.stock[TL as usize].saturating_add(n) > self.storage_cap() { return -7; }
            if self.emergency_tools[0] == 0 { self.emergency_tools[1] = self.tick + TOOL_RESTOCK; }
            self.emergency_tools[0] += n as u64;
            self.stock[GD as usize] -= cost;
            self.stock[TL as usize] += n;
            self.push_event(EV_TRADE, -cost, TL as i32);
            return 0;
        }
        let Some(slot) = Self::market_slot(res) else { return -1 };
        if n < 1 || self.market_scale() == 0 { return -1; }
        if n > self.market_left(slot) { return -2; }
        let cost = self.market_cost(res, n);
        if self.stock[GD as usize] < cost { return -6; }
        if self.stock[res as usize].saturating_add(n) > self.storage_cap() { return -7; }
        self.stock[GD as usize] -= cost; self.stock[res as usize] += n; self.market_sold[slot] += n;
        self.push_event(EV_TRADE, -cost, res as i32); 0
    }
}

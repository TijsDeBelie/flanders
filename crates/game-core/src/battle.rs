//! Battles, fire and terrain damage. Everything here is deterministic: a battle is a pure function of the
//! village state, the attacking army and the RNG stream, so every peer replaying the same commands sees the same fight.
use super::*;
use crate::tactics::{self, Strike, Tactics};
use crate::military::*;

const SUBSTEP: f32 = 0.25;
pub(crate) const DEPLOY_SECS: f32 = 6.0;

/// What stopped an attacker: a wall, fence or gate (index into the substep's list) or water.
pub(crate) enum Block { Bar(usize) }

// ---------------------------------------------------------------------------------------------------------------------
// Tunables: the numbers that decide how hard combat bites. Change them here (and only here). Changing any of them changes the
// outcome of battles in old command logs, so peers must run the same version.
// ---------------------------------------------------------------------------------------------------------------------
/// Raiders in the water of a moat or river crawl across (heavy knights hardly move), cannot fight while they struggle, are hit three times as hard and almost never missed.
pub const WADE_SPEED: f32 = 0.15;
pub const WADE_KNIGHT: f32 = 0.08;
pub const WADE_DAMAGE: f32 = 3.0;
/// Chance an arrow finds a raider who is in the water (on dry land it is `HIT_CHANCE`).
pub const WADE_HIT: f32 = 0.97;
pub const HIT_CHANCE: f32 = 0.72;
/// Just out of the water they are still sodden: for `SOAK_SECS` they walk at `SOAK_SPEED` and hit at `SOAK_DAMAGE` of their strength.
pub const SOAK_SECS: f32 = 5.0;
pub const SOAK_SPEED: f32 = 0.6;
pub const SOAK_DAMAGE: f32 = 0.6;
/// A field army that marches to a fight joins it once it is this close to an attacker.
pub const JOIN_REACH: f32 = 26.0;
/// A soldier of an army that made camp starts the battle at their own place in it only if that is this close to the army's centre; anyone further out (strung along a road) starts beside the army instead.
const CAMP_REACH: f32 = 10.0;
/// A burning building loses `FIRE_DAMAGE` x (4 + 14 x flammability) hit points a second; fire jumps to a neighbour with `FIRE_SPREAD` x flammability x ... a second, up to `FIRE_RANGE` away.
pub const FIRE_DAMAGE: f32 = 0.4;
pub const FIRE_SPREAD: f32 = 0.1;
pub const FIRE_RANGE: f32 = 9.0;
/// Fighting a fire: a well within 18 (36 at half strength) supplies the bucket line (`WELL_CREW` per well, at most two count) and the villagers who man it; every staffed builders' yard within
/// 45 sends `BUILDER_CREW` carpenters to pull down the burning thatch (at most two yards). Each point of help takes 6% off the damage (at most 75%) and makes the fire burn out faster.
pub const WELL_CREW: f32 = 2.0;
pub const BUILDER_CREW: f32 = 3.0;
pub const HELP_CUT: f32 = 0.06;
/// A staffed fire station within `STATION_RANGE` (at most two count): `STATION_CREW` firefighters each, villagers who need no well, `STATION_EXTRA_CUT` more off the damage beyond the usual cap, and fires burn out `STATION_QUENCH` faster per station.
pub const STATION_CREW: f32 = 4.0;
pub const STATION_EXTRA_CUT: f32 = 0.12;
pub const STATION_QUENCH: f32 = 1.5;

/// A ram does this many times its blow to a gate (doors), a wall, and anything else it is set against; it hits soldiers for a fraction (see its stats in military.rs).
pub const RAM_VS_GATE: f32 = 4.0;
pub const RAM_VS_WALL: f32 = 0.9;
pub const RAM_VS_OTHER: f32 = 0.5;

/// Stone walls and gatehouse doors: infantry cannot hurt them (catapults can). Timber walls (tier 1 or less) and fences give way to anyone with a weapon.
pub fn is_stone(kind: u8, tier: u8) -> bool { matches!(kind, WALL | GATE) && tier >= 2 }

/// Damage a second to a soldier on a ladder under a hoarding that pours boiling oil.
pub const OIL_DPS: f32 = 22.0;
/// How far an ogre throws a boulder at a wall or building.
pub const BOULDER_REACH: f32 = 12.0;
/// A fight at a lair is called off (the army is not winning) after this many seconds.
pub const LAIR_SECS: f32 = 200.0;

/// How hard a ram hits what it is set against.
/// A routed soldier whose side is still above `RALLY_SIDE` of its strength runs for `RALLY_FLAG`+... seconds (the flag marks it) and comes back if no enemy is within `RALLY_CLEAR`.
const RALLY_FLAG: f32 = 100.0;
const RALLY_SIDE: f32 = 0.4;
const RALLY_CLEAR: f32 = 14.0;
const RALLY_STEADY: f32 = 15.0;

fn ram_mult(kind: u8) -> f32 { match kind { GATE => RAM_VS_GATE, WALL | FENCE => RAM_VS_WALL, _ => RAM_VS_OTHER } }

pub fn max_hp(kind: u8, tier: u8) -> f32 {
    let base = match kind { TOWN_HALL => 1400.0, WALL => 280.0, TOWER => 520.0, FENCE => 90.0, GATE => 300.0, DRAWBRIDGE => 220.0, MOAT | RIVER | RAISE | LOWER => 100000.0, _ => DEFS[kind as usize].weight as f32 * 90.0 + 130.0 };
    base * (1.0 + tier as f32 * 0.8)
}

/// How readily a building catches fire: thatch and timber burn, stone resists.
pub fn flammability(kind: u8, tier: u8) -> f32 {
    if is_edit(kind) { return 0.0; }
    let mat = [1.0, 0.7, 0.12, 0.06][tier.min(3) as usize];
    if kind == WALL && tier >= 2 { return 0.0; }       // stone does not burn
    if kind == GATE && tier >= 2 { return 0.04; }      // only its oak doors scorch
    if matches!(kind, WALL) && tier >= 1 { return mat * 0.6; }
    mat
}

impl World {
    fn rf(&mut self) -> f32 { (self.rng.next() >> 8) as f32 / 16777216.0 }

    pub(crate) fn wind_vec(&self) -> (f32, f32) {
        let a = (self.seed % 628) as f32 * 0.01 + self.tick as f32 * 0.0007;
        (a.cos(), a.sin())
    }

    #[allow(dead_code)]
    pub(crate) fn defence_points(&self) -> u32 {
        self.buildings.iter().map(|b| match b.kind { TOWER => 2 + 2 * b.garrison as u32, KEEP => 8 + 2 * b.garrison as u32, WALL => 1, GATE => 2, MOAT => 1, RIVER => 1, _ => 0 }).sum::<u32>() + self.army.iter().take(5).sum::<u32>() * 3
    }

    /// Raiders scale with how long the village has existed and how rich it is.
    pub(crate) fn bandit_force(&self, rf: f32) -> [u32; NK] {
        let s = (3.0 + self.population as f32 / 7.0 + self.tick as f32 / 500.0) * (0.75 + rf * 0.5) * (1.0 + self.greed as f32 / 400.0);
        let s = s as u32;
        [2 + s / 2, s / 3, s / 6, if s > 14 { (s - 14) / 6 } else { 0 }, if s > 20 { (s - 20) / 12 } else { 0 }, if s > 26 { (s - 26) / 14 } else { 0 }]
    }

    /// How strong a boss is this time (a share of its table hit points, between its `scale_min` and `scale_max`): grows with the village's size and age and with its lord's level; `rf` (0..1) is the roll.
    pub(crate) fn boss_scale(&self, boss: u8, rf: f32) -> f32 {
        let d = &BOSSES[(boss - 1) as usize];
        let grown = (self.population as f32 / 80.0 + self.tick as f32 / DAY as f32 / 120.0).min(1.0);
        let lord = self.hero.map_or(0.0, |(_, xp)| (Self::hero_level(xp) as f32 - 1.0) * 0.04);
        ((d.scale_min + (d.scale_max - d.scale_min) * grown) * (0.95 + 0.1 * rf) + lord).min(d.scale_max * 1.1)
    }

    /// Is a boss due on the next bandit raid? Only on a village that has stood for a while, and more often the richer it is. Draws from the random stream only when it could happen.
    pub(crate) fn boss_due(&mut self) -> bool {
        if self.tick < BOSS_FROM_DAYS * DAY || self.population < BOSS_FROM_POP { return false; }
        let one_in = BOSS_ONE_IN.saturating_sub((self.stock[GD as usize].max(0) as u32 / BOSS_WEALTH_STEP).min(BOSS_WEALTH_MAX)).max(2);
        self.rng.range(one_in) == 0
    }

    /// Which boss leads a boss raid with this roll (0..1): the Ironclad Knight Captain on a late village, otherwise the Warlord.
    pub(crate) fn raid_boss_kind(&self, rf: f32) -> u8 { if self.tick >= IRONCLAD_FROM_DAYS * DAY && rf >= IRONCLAD_ROLL { IRONCLAD } else { RAID_BOSS } }

    /// A raid led by a boss: its escort and engines scale with the same strength as the boss.
    pub(crate) fn begin_boss_raid(&mut self, boss: u8, angle: f32, rf: f32, bname: u8) -> bool {
        let d = &BOSSES[(boss - 1) as usize];
        let sc = self.boss_scale(boss, rf);
        let n = |x: u32| (x as f32 * sc).round() as u32;
        let atk = [n(d.escort[0]), n(d.escort[1]), n(d.escort[2]), n(d.escort[3]), 0, n(d.rams).max(d.rams.min(1))];
        self.begin_battle_boss(atk, angle, 0, boss, bname, sc)
    }

    pub(crate) fn begin_battle(&mut self, atk: [u32; NK], angle: f32, tag: i32) -> bool { self.begin_battle_boss(atk, angle, tag, 0, 0, 1.0) }

    /// Start a fight at the village. `boss` (0 none) leads the attackers at strength `scale`: only ever on a raid of bandits (tag 0).
    pub(crate) fn begin_battle_boss(&mut self, atk: [u32; NK], angle: f32, tag: i32, boss: u8, bname: u8, scale: f32) -> bool {
        if self.battle.is_some() { return false; }
        self.raid_warning_ticks = 0;
        let boss = if tag == 0 && (boss as usize) <= N_BOSSES { boss } else { 0 };
        let (cx, cy) = (self.ox as f32, self.oy as f32);
        let dist = self.raid_distance(angle);   // they form up out in the country (as far as dry ground goes) and march in: time for a fight in the fields
        let (dx, dy) = (angle.cos(), angle.sin());
        let mut units: Vec<Unit> = vec![];
        // attackers form up in a line facing the village
        let total: u32 = atk.iter().sum();
        let mut k = 0u32;
        for (kind, &n) in atk.iter().enumerate() {
            for _ in 0..n {
                let row = (k / 12) as f32; let col = (k % 12) as f32 - 5.5;
                let (px, py) = (cx + dx * (dist + row * 2.2) - dy * col * 2.0, cy + dy * (dist + row * 2.2) + dx * col * 2.0);
                units.push(Unit::new(1, kind as u8, px, py, angle + std::f32::consts::PI));
                k += 1;
            }
        }
        let _ = total;
        if boss > 0 {   // the boss rides at the head of the line
            let bd = &BOSSES[(boss - 1) as usize];
            let mut u = Unit::new(1, bd.base, cx + dx * (dist - 3.5), cy + dy * (dist - 3.5), angle + std::f32::consts::PI);
            u.boss = boss; u.bname = bname % 4; u.hp = boss_hp(boss, scale); u.maxhp = u.hp; u.t1 = (bd.horn_every - bd.horn_first).max(0.0); u.t2 = if bd.slam_every > 0.0 { 3.0 } else { 0.0 };
            units.push(u);
        }
        // defenders: standing army, tower guards, hall bodyguard, militia
        let hall = (self.buildings[0].x, self.buildings[0].y);
        let mut j = 0u32;
        for kind in 0..NK {
            for _ in 0..self.army[kind] {
                let a = j as f32 * 0.7; let r = 4.0 + (j / 9) as f32 * 1.5;
                let mut u = Unit::new(0, kind as u8, hall.0 + a.cos() * r, hall.1 + a.sin() * r, 0.0); u.hx = hall.0 + a.cos() * (r + 3.0); u.hy = hall.1 + a.sin() * (r + 3.0); u.from_army = true; units.push(u);
                j += 1;
            }
        }
        // veterans of earlier fights stand in the ranks: more hit points, a harder blow
        for kind in 0..NK {
            let mut n = self.vets[kind].min(self.army[kind]);
            for u in units.iter_mut().filter(|u| u.side == 0 && u.from_army && u.kind as usize == kind) {
                if n == 0 { break; }
                u.maxhp = UNITS[kind].hp * tactics::VET_HP; u.hp = u.maxhp; n -= 1;
            }
        }
        let mut guards: Vec<(f32, f32, u8, u32)> = vec![];
        for b in &self.buildings {
            if matches!(b.kind, TOWER | KEEP) && b.garrison > 0 { guards.push((b.x, b.y, 1, b.garrison as u32)); }
            if b.kind == TOWN_HALL { guards.push((b.x + 3.0, b.y + 3.0, 0, 2 * (b.tier as u32 + 1))); }
        }
        for (gx, gy, kind, n) in guards {
            for i in 0..n { let a = i as f32 * 1.4; let mut u = Unit::new(0, kind, gx + a.cos(), gy + a.sin(), 0.0); u.hx = gx; u.hy = gy; u.charge = false; units.push(u); }
        }
        let militia = (self.population / 5).min(14) * self.militia_pct() / 100 + self.perks().militia;   // (a muster or the war focus calls up more: see realm.rs)   // beacons, turrets and guard huts call more villagers to arms
        for i in 0..militia { let a = i as f32 * 0.9; let mut u = Unit::new(0, MILITIA, hall.0 + a.cos() * 8.0, hall.1 + a.sin() * 8.0, 0.0); u.hx = hall.0 + a.cos() * 9.0; u.hy = hall.1 + a.sin() * 9.0; u.cd = 1.0; units.push(u); }
        // defenders run to the walls and defences on the side the attackers come from, and stand on top of them where there is a walkway
        {
            let (ax, ay) = (cx + dx * dist, cy + dy * dist);
            let mut posts: Vec<(f32, f32, f32, f32)> = self.buildings.iter().filter(|x| matches!(x.kind, WALL | GATE | FENCE | TOWER | KEEP) && x.hp > 0.0).map(|x| {
                let d = ((x.x - ax).powi(2) + (x.y - ay).powi(2)).sqrt();
                let elev = if matches!(x.kind, WALL | GATE) && x.tier >= 1 { [0.0, 3.0, 3.8, 5.05][x.tier.min(3) as usize] } else { 0.0 };
                (d, x.x, x.y, elev)
            }).collect();
            posts.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
            posts.truncate(14);
            if !posts.is_empty() {
                let high: Vec<(f32, f32, f32, f32)> = posts.iter().copied().filter(|p| p.3 > 0.0).collect();
                let (mut ka, mut ko) = (0usize, 0usize);
                for u in units.iter_mut().filter(|u| u.side == 0 && (u.from_army || u.kind == MILITIA) && u.kind != 4) {
                    let archer = u.kind == 1;
                    let (p, k) = if archer && !high.is_empty() { let k = ka; ka += 1; (high[k % high.len()], k) } else { let k = ko; ko += 1; (posts[k % posts.len()], k) };
                    let a = k as f32 * 2.4 + 0.5; let ring = 1.0 + (k / posts.len().max(1)) as f32 * 0.5;
                    if p.3 > 0.0 { u.hx = p.1 + a.cos() * 1.2 * ring; u.hy = p.2 + a.sin() * 1.2 * ring; }
                    else { let (hx, hy) = (hall.0 - p.1, hall.1 - p.2); let l = (hx * hx + hy * hy).sqrt().max(0.1); u.hx = p.1 + hx / l * (2.6 + ring) + a.cos() * 0.8; u.hy = p.2 + hy / l * (2.6 + ring) + a.sin() * 0.8; }
                    u.pelev = p.3; u.held = true;
                }
            }
        }
        let ladders = if atk[0] + atk[2] > 0 { ((atk[0] + atk[2]) / 4).max(1) } else { 0 };
        for bridge in self.buildings.iter_mut().filter(|b| b.kind == DRAWBRIDGE && b.status == DB_MANUAL_DOWN) {
            bridge.status = 4;
        }
        self.battle = Some(Battle { ladders, ladders_used: 0, spots: vec![], sites: vec![], bridges: vec![], units, t: 0.0, pillage: 0.0, tag, angle, spawn: [cx + dx * dist, cy + dy * dist], atk_start: atk, atk_dead: 0, def_dead: 0, militia_dead: 0, bld_lost: 0, rout: vec![], start_side: [0, 0], fled: [0, 0], fled_kinds: [0; NK], fixed: vec![], lair: -1, lair_at: [0.0, 0.0], boss, bname: bname % 4, bought: false, bought_t: 0.0, objective: None, siege: Default::default(), tactics: Tactics { tech: [self.military_tech, 0], ..Tactics::default() } });
        let siege = self.siege_train(&atk, cx, cy, dx, dy, dist);
        let fixed = self.bridge_points();
        if let Some(b) = self.battle.as_mut() { for u in &b.units { b.start_side[u.side as usize] += 1; } b.fixed = fixed; b.siege = siege; }
        self.push_event(EV_BATTLE, atk.iter().sum::<u32>() as i32, tag);
        true
    }

    /// Does this building have a hoarding (a timber gallery with murder holes) to pour boiling oil from? Stone walls (option 2), towers and keeps (option 1).
    pub(crate) fn has_oil(w: &Building) -> bool { match w.kind { WALL => w.tier >= 2 && w.opts & 4 != 0, TOWER | KEEP => w.opts & 2 != 0, _ => false } }

    pub(crate) fn damage_unit(b: &mut Battle, j: usize, dmg: f32) { Self::damage_from(b, j, dmg, false) }

    /// A blow to unit `j`. A boss in plate shrugs off light blows (below its `heavy` damage) unless they come from a siege engine.
    pub(crate) fn damage_from(b: &mut Battle, j: usize, dmg: f32, siege: bool) {
        let st = unit_stat(&b.units[j]);
        let boss = b.units[j].boss;
        let plate = if boss > 0 && !siege { let bd = &BOSSES[(boss - 1) as usize]; if bd.heavy > 0.0 && dmg < bd.heavy { bd.soft } else { 1.0 } } else { 1.0 };
        let tech = b.tactics.tech_for(&b.units[j]);
        let stance = tactics::stance_taken(b.tactics.order_for(&b.units[j], false).mode);
        let armor = st.armor + if tech & tactics::PADDED_ARMOR != 0 { 1.0 } else { 0.0 } + if tech & tactics::MAIL_ARMOR != 0 { 1.4 } else { 0.0 };
        let d = (dmg * (1.0 - armor * 0.1)).max(1.0) * plate * if b.units[j].elev > 0.0 { 0.8 } else { 1.0 } * if b.units[j].wading { WADE_DAMAGE } else { 1.0 } * stance;
        b.units[j].hp -= d;
        if boss > 0 && b.units[j].phase == 0 && b.units[j].hp > 0.0 && b.units[j].hp < b.units[j].maxhp * BOSSES[(boss - 1) as usize].rage_at { b.units[j].phase = 1; }
        if boss > 0 && b.units[j].hp > 0.0 {   // a boss that steps back when hurt: t2 counts the damage since the last time, t1 the seconds it still walks away
            let bd = &BOSSES[(boss - 1) as usize];
            if bd.step_secs > 0.0 { b.units[j].t2 += d; if b.units[j].t2 >= b.units[j].maxhp * bd.step_pct { b.units[j].t2 = 0.0; b.units[j].t1 = bd.step_secs; } }
        }
        if b.units[j].hp <= 0.0 && b.units[j].alive {
            b.units[j].alive = false;
            if b.units[j].side == 1 { b.atk_dead += 1; } else { b.def_dead += 1; if b.units[j].kind == MILITIA { b.militia_dead += 1; } }
        }
    }

    fn crater(&mut self, x: f32, y: f32, r: f32, depth: f32) {
        if self.craters.len() >= 240 { self.craters.remove(0); }
        self.craters.push([x, y, r, depth]);
        if self.scorch.len() < 80 { self.scorch.push([x, y, r * 1.5]); }
        self.terrain_ver += 1;
    }

    pub(crate) fn ignite(&mut self, i: usize) {
        if i >= self.buildings.len() || self.buildings[i].burning > 0.0 || self.buildings[i].hp <= 0.0 || is_edit(self.buildings[i].kind) { return; }
        let fl = flammability(self.buildings[i].kind, self.buildings[i].tier);
        if fl <= 0.0 { return; }
        self.buildings[i].burning = 20.0 + 45.0 * fl;
        self.push_event(EV_FIRE, self.buildings[i].kind as i32, 0);
    }

    fn start_wildfire(&mut self, x: f32, y: f32) {
        if self.wildfires.len() >= 10 || self.scorch.len() >= 80 { return; }
        self.scorch.push([x, y, 1.5]);
        self.wildfires.push(Wildfire { x, y, r: 1.5, life: 50.0, scorch: self.scorch.len() - 1 });
        self.terrain_ver += 1;
    }

    /// One 0.25s step of burning buildings, spreading fire and forest fires.
    pub(crate) fn fire_substep(&mut self) {
        let dt = SUBSTEP;
        let (wx, wy) = self.wind_vec();
        let nb = self.buildings.len();
        let wells: Vec<(f32, f32)> = self.buildings.iter().filter(|b| b.kind == WELL).map(|b| (b.x, b.y)).collect();
        let yards: Vec<(f32, f32)> = self.buildings.iter().filter(|b| b.kind == BUILDERS && b.staff > 0 && b.hp > 0.0).map(|b| (b.x, b.y)).collect();
        let stations: Vec<(f32, f32)> = self.buildings.iter().filter(|b| b.kind == FIRE_STATION && b.staff > 0 && b.hp > 0.0).map(|b| (b.x, b.y)).collect();
        let mut ignite: Vec<usize> = vec![];
        let mut forest_spawn: Vec<(f32, f32)> = vec![];
        let fighters = self.firefighters() as f32;
        let mut put_out = 0;
        for i in 0..nb {
            if self.buildings[i].burning <= 0.0 { continue; }
            let (bx, by, kind, tier) = (self.buildings[i].x, self.buildings[i].y, self.buildings[i].kind, self.buildings[i].tier);
            let fl = flammability(kind, tier);
            // villagers form a bucket brigade from the nearest well: close wells help most, distant ones half as much
            let near = |l: &[(f32, f32)], r: f32| l.iter().filter(|w| ((w.0 - bx).powi(2) + (w.1 - by).powi(2)).sqrt() <= r).count();
            let (w18, w36) = (near(&wells, radii::WELL_FULL_RANGE), near(&wells, radii::WELL_HALF_RANGE));
            let mut help = 0.0f32;
            if w18 > 0 { help = fighters + WELL_CREW * w18.min(2) as f32 } else if w36 > 0 { help = fighters * 0.5 + WELL_CREW * 0.5 }
            help += BUILDER_CREW * near(&yards, radii::YARD_FIRE_RANGE).min(2) as f32;
            let ns = near(&stations, radii::STATION_RANGE).min(2) as f32;
            if ns > 0.0 { if w18 == 0 { help += fighters * 0.5; } help += STATION_CREW * ns; }
            let cut = ((help * HELP_CUT).min(0.75) + STATION_EXTRA_CUT * ns).min(0.93);
            self.buildings[i].hp -= FIRE_DAMAGE * (4.0 + 14.0 * fl) * dt * (1.0 - cut);
            self.buildings[i].burning -= dt * (1.0 + help * 0.55 + STATION_QUENCH * ns);
            if self.buildings[i].burning <= 0.0 && self.buildings[i].hp > 0.0 { put_out += 1; continue; }
            for j in 0..nb {
                if j == i || self.buildings[j].burning > 0.0 || self.buildings[j].hp <= 0.0 { continue; }
                let (dx, dy) = (self.buildings[j].x - bx, self.buildings[j].y - by);
                let d = (dx * dx + dy * dy).sqrt();
                if d > FIRE_RANGE || d < 0.01 { continue; }
                let align = (dx * wx + dy * wy) / d; // downwind spreads faster
                let flj = flammability(self.buildings[j].kind, self.buildings[j].tier);
                let mut p = FIRE_SPREAD * flj * (1.0 - d / FIRE_RANGE) * (0.7 + 0.55 * align) * dt;
                let wn = wells.iter().filter(|w| (w.0 - self.buildings[j].x).powi(2) + (w.1 - self.buildings[j].y).powi(2) < radii::WELL_SPARK_RANGE * radii::WELL_SPARK_RANGE).count().min(2);
                let sn = stations.iter().filter(|s| (s.0 - self.buildings[j].x).powi(2) + (s.1 - self.buildings[j].y).powi(2) < radii::STATION_RANGE * radii::STATION_RANGE).count().min(2);
                p *= 0.5f32.powi((wn + sn) as i32);                       // each well beside it (two count) halves the chance a spark takes
                if self.rf() < p { ignite.push(j); }
            }
            if self.rf() < 0.006 { forest_spawn.push((bx, by)); }
        }
        for _ in 0..put_out { self.push_event(EV_FIREOUT, 0, 0); }
        for j in ignite { self.ignite(j); }
        for (x, y) in forest_spawn { if terrain::forest_near(self.seed, x, y, 7.0) > 0.12 { self.start_wildfire(x + 3.0, y); } }

        // forest fires grow, scorch the ground and ignite what they touch
        let mut ig2: Vec<usize> = vec![];
        let n = self.wildfires.len();
        for k in 0..n {
            let mut wf = self.wildfires[k];
            let dens = terrain::forest_near(self.seed, wf.x, wf.y, wf.r.max(3.0)).max(0.05);
            wf.r = (wf.r + (0.18 + dens * 0.6) * dt).min(14.0);
            wf.life -= dt;
            if wf.scorch < self.scorch.len() { self.scorch[wf.scorch][2] = wf.r; }
            for (i, b) in self.buildings.iter().enumerate() {
                let d = ((b.x - wf.x).powi(2) + (b.y - wf.y).powi(2)).sqrt();
                if d < wf.r + DEFS[b.kind as usize].r * 0.6 && b.burning <= 0.0 { ig2.push(i); }
            }
            self.wildfires[k] = wf;
        }
        // flames never ignite instantly: thin the list by flammability
        for i in ig2 { let fl = flammability(self.buildings[i].kind, self.buildings[i].tier); if self.rf() < 0.25 * fl * dt * 4.0 { self.ignite(i); } }
        self.wildfires.retain(|w| w.life > 0.0);
        if n != self.wildfires.len() { self.terrain_ver += 1; }
        // buildings that burned down
        self.collect_destroyed();
    }

    /// How many villagers rush to fight a fire (one in six, at most eight). They only help if a well is near the blaze.
    pub(crate) fn firefighters(&self) -> u32 { (self.population.saturating_sub(self.sick) / 6).min(8) }

    /// Remove buildings with no hit points left and leave ruins behind.
    pub(crate) fn collect_destroyed(&mut self) {
        let mut any = false;
        let mut i = self.buildings.len();
        while i > 1 {
            i -= 1;
            if self.buildings[i].hp <= 0.0 {
                let b = self.buildings.remove(i);
                self.ruins.push([b.x, b.y, DEFS[b.kind as usize].r, b.kind as f32, b.tier as f32, b.rot as f32]);
                if self.scorch.len() < 80 { self.scorch.push([b.x, b.y, DEFS[b.kind as usize].r * 1.2]); }
                if let Some(bt) = self.battle.as_mut() { bt.bld_lost += 1; }
                self.push_event(EV_DESTROYED, b.kind as i32, 0);
                any = true;
            }
        }
        if self.buildings[0].hp <= 0.0 { self.buildings[0].hp = 1.0; } // the town hall can burn but never vanishes
        if any { self.terrain_ver += 1; self.after_change(); }
    }

    /// Advance the battle by one 0.25s step.
    pub(crate) fn battle_substep(&mut self) {
        if self.battle.is_none() { return; }
        let cr = self.crossings();   // resolve raised decks while the battle is still in the world
        let siege_obstacles = self.battle.as_ref().filter(|b| b.units.iter().filter(|u| u.alive && matches!(u.kind, 4 | RAM)).take(2).count() == 2)
            .map(|_| self.obst());
        let Some(mut b) = self.battle.take() else { return };
        let dt = SUBSTEP;
        b.t += dt;
        if b.bought { Self::bribed_substep(&mut b, dt); self.battle = Some(b); self.check_battle_end(); return; }
        let deploying = b.t <= DEPLOY_SECS;
        let objective = b.objective.filter(|o| !o.lost);
        let raid_gate = objective.filter(|o| o.kind == raid_objective::Kind::Gate).and_then(|o| self.gate_objective_index(o));
        Self::battle_strikes(&mut b);
        let n = b.units.len();
        let mut impacts: Vec<(f32, f32)> = vec![];
        let mut ignites: Vec<usize> = vec![];
        let mut dmg_b: Vec<(usize, f32)> = vec![];
        let mut shots: Vec<[f32; 7]> = vec![];
        let hero_mult = self.hero_dmg() * (1.0 + self.perks().banner_pct as f32 / 100.0);   // standards and armoury racks steady the defenders' hand   // the lord leads the defenders: they hit harder, and do not break so soon
        if b.rout.len() < n { b.rout.resize(n, 0.0); }
        let horns = if deploying { Vec::new() } else { Self::boss_step(&mut b, dt, &mut shots) };
        // how many are left on each side: soldiers who see their side break lose heart
        let mut left = [0u32; 2]; for u in b.units.iter().filter(|u| u.alive) { left[u.side as usize] += 1; }
        let ratio = [left[0] as f32 / b.start_side[0].max(1) as f32, left[1] as f32 / b.start_side[1].max(1) as f32];
        // walls, fences and gates stop attackers; moats and rivers too unless bridged
        let bars: Vec<(usize, f32, f32, f32, u8)> = self.buildings.iter().enumerate().filter(|(_, x)| x.hp > 0.0 && matches!(x.kind, WALL | FENCE | GATE)).map(|(k, x)| (k, x.x, x.y, if x.kind == FENCE { 1.9 } else { 2.6 }, x.kind)).collect();
        let wet: Vec<(f32, f32, f32)> = self.buildings.iter().filter(|x| matches!(x.kind, MOAT | RIVER)).map(|x| (x.x, x.y, if x.kind == MOAT { MOAT_FLOOR * moat_scale(x) + 0.5 } else { RIVER_FLOOR + 0.5 })).collect();
        let mut want: Vec<u32> = vec![];   // the drawbridges our soldiers are waiting for
        let tower_guards: Vec<bool> = b.units.iter().map(|u| u.side == 0 && u.kind == 1 && !u.from_army && u.det == 0 && self.buildings.iter().any(|t| {
            matches!(t.kind, TOWER | KEEP) && t.hp > 0.0 && (t.x, t.y) == (u.hx, u.hy)
        })).collect();
        for u in b.units.iter().filter(|u| u.side == 0 && u.alive) { for c in cr.iter().filter(|c| c.db >= 0 && c.on(u.x, u.y)) { want.push(c.db as u32); } }   // (a drawbridge with one of ours on it stays down, however busy he is)
        for si in 0..b.spots.len() { let busy = b.units.iter().any(|q| q.alive && q.climb > 0.0 && q.spot == si as i32); b.spots[si][3] = if busy { 1.0 } else { 0.0 }; }
        for i in 0..n {
            if !b.units[i].alive { continue; }
            let u = b.units[i].clone();
            let tech = b.tactics.tech_for(&u);
            let mut stats = unit_stat(&u);
            if u.kind == 1 && !u.held { stats.range += 2.5; }
            if u.kind == 3 && tech & tactics::CAVALRY_TACK != 0 { stats.speed *= 1.15; }
            if u.kind == 4 && tech & tactics::SIEGE_SLINGS != 0 { stats.range *= 1.2; stats.cd *= 0.85; }
            let ud = &stats;
            // morale: a unit running away does not fight; once clear of the field it is gone (alive, but out of the battle)
            // one of ours caught in the water (a deck drawn up under him): he scrambles back towards the hall until he is on dry ground
            if u.side == 0 && !wet.is_empty() && u.elev <= 0.0 && !tower_guards[i] && self.own_wet(&b, &wet, &cr, u.x, u.y) {
                let (hx, hy) = (self.buildings[0].x, self.buildings[0].y);
                let (dx, dy) = (hx - u.x, hy - u.y); let d = dx.hypot(dy).max(0.1);
                b.units[i].x = u.x + dx / d * ud.speed * dt; b.units[i].y = u.y + dy / d * ud.speed * dt;
                continue;
            }
            if b.rout[i] < 0.0 { b.rout[i] = (b.rout[i] + dt).min(0.0); }   // a rallied soldier is steady for a while
            if b.rout[i] > 0.0 {
                let was = b.rout[i];
                b.rout[i] -= dt;
                let (mut best, mut bd) = (usize::MAX, f32::MAX);
                for j in 0..n { if b.units[j].alive && b.units[j].side != u.side { let d = (b.units[j].x - u.x).powi(2) + (b.units[j].y - u.y).powi(2); if d < bd { bd = d; best = j; } } }
                if best != usize::MAX {
                    let d = bd.sqrt().max(0.1);
                    let (dx, dy) = ((u.x - b.units[best].x) / d, (u.y - b.units[best].y) / d);
                    let step = ud.speed * 1.3 * dt;
                    if u.side == 1 && u.wading { self.move_attacker(&mut b, i, (dx, dy), step, &bars, &wet); }
                    else {
                        let (x, y) = (u.x + dx * step, u.y + dy * step);
                        if u.side == 1 || (!self.own_wet(&b, &wet, &cr, x, y) && self.own_line_dry(&b, &wet, &cr, (u.x, u.y), (x, y), 0.0)) { (b.units[i].x, b.units[i].y) = (x, y); }
                        b.units[i].face = dy.atan2(dx);
                    }
                }
                // a soldier whose side still holds together (flagged above RALLY_FLAG) may come back to the line once clear of the enemy
                if was > RALLY_FLAG && b.rout[i] <= RALLY_FLAG {
                    if bd > RALLY_CLEAR * RALLY_CLEAR { b.rout[i] = -RALLY_STEADY; } else { b.rout[i] = 3.0; }
                    continue;
                }
                if b.rout[i] <= 0.0 { b.units[i].alive = false; b.units[i].escaped = true; b.fled[u.side as usize] += 1; if u.side == 1 && (u.kind as usize) < NK { b.fled_kinds[u.kind as usize] += 1; } }
                continue;
            }
            if b.rout[i] == 0.0 && !tower_guards[i] && u.kind != 4 && u.kind != RAM && u.boss == 0 && !(u.held && u.pelev > 0.0) {
                let hpf = u.hp / ud.hp;
                let knight = u.kind == 3;   // riders break late, and only when they are hurt
                if ratio[u.side as usize] < 0.7 && (hpf < if knight { 0.35 } else { 0.5 } || (u.side == 1 && ratio[1] < 0.35)) {
                    let steadied = if u.side == 0 { (if self.hero.is_some() { 0.25 } else { 0.0 }) + self.perks().banner_pct as f32 / 100.0 } else if b.units.iter().any(|l| l.boss > 0 && l.alive && (l.x - u.x).powi(2) + (l.y - u.y).powi(2) < 24.0 * 24.0) { 0.3 } else { 0.0 };
                    let nerve = tactics::stress(&b, i, hpf, ratio[u.side as usize], steadied + if knight { 0.2 } else { 0.0 } + tactics::stance_nerve(b.tactics.order_for(&u, false).mode));
                    let chance = tactics::break_chance(nerve) * if u.side == 0 && b.tag == 0 { 0.7 } else { 1.0 };
                    if chance > 0.0 && self.rf() < chance { b.rout[i] = if ratio[u.side as usize] >= RALLY_SIDE { RALLY_FLAG + 7.0 } else { 7.0 }; continue; }
                }
            }
            let haste = if u.side == 1 && u.boss == 0 { horns.iter().filter(|h| (h[0] - u.x).powi(2) + (h[1] - u.y).powi(2) < h[2] * h[2]).map(|h| h[3]).fold(0.0f32, f32::max) } else { 0.0 };   // the war horn: the escort recovers faster from each swing
            b.units[i].cd = (u.cd - dt * (1.0 + haste)).max(0.0);
            b.units[i].anim = (b.units[i].anim - dt).max(0.0);
            b.units[i].soak = (b.units[i].soak - dt).max(0.0);
            if u.climb > 0.0 {   // up the ladder and over the wall
                b.units[i].climb -= dt;
                // boiling oil: a wall or tower with a hoarding pours it on whoever is on a ladder against it
                if self.buildings.iter().any(|w| w.hp > 0.0 && Self::has_oil(w) && (w.x - u.x).powi(2) + (w.y - u.y).powi(2) < (DEFS[w.kind as usize].r + 3.2).powi(2)) { Self::damage_unit(&mut b, i, OIL_DPS * dt); if !b.units[i].alive { continue; } }
                if b.units[i].climb <= 0.0 {
                    b.units[i].spot = -1;
                    let mut near: Option<(f32, f32, f32, f32)> = None;
                    for &(_, bx, by, r, _) in &bars { let d = ((u.x - bx).powi(2) + (u.y - by).powi(2)).sqrt(); if d < r + 2.5 && near.map_or(true, |q| d < q.3) { near = Some((bx, by, r, d)); } }
                    if let Some((bx, by, r, d)) = near { let (dx, dy) = ((bx - u.x) / d.max(0.1), (by - u.y) / d.max(0.1)); b.units[i].x = bx + dx * (r + 1.2); b.units[i].y = by + dy * (r + 1.2); }
                }
                continue;
            }
            // Finish the crossing along the heading used to enter it. Range, skirmishing and hold orders take effect again on land.
            if u.side == 1 && u.wading {
                for offset in [0.0, 0.52, -0.52, 1.05, -1.05, 1.57, -1.57, std::f32::consts::PI] {
                    let (dy, dx) = (u.face + offset).sin_cos();
                    if self.move_attacker(&mut b, i, (dx, dy), ud.speed * dt, &bars, &wet).is_none() { break; }
                    b.units[i].face = u.face;
                }
                continue;
            }
            if u.boss > 0 {
                let bd = &BOSSES[(u.boss - 1) as usize];
                if bd.pacifist && !deploying { continue; }   // the doctor does not fight: his guards do
                if bd.step_secs > 0.0 && u.t1 > 0.0 && !deploying {   // hurt: it walks away from the nearest foe to recover
                    let (mut best, mut bd2) = (usize::MAX, f32::MAX);
                    for j in 0..n { if b.units[j].alive && b.units[j].side != u.side { let d = (b.units[j].x - u.x).powi(2) + (b.units[j].y - u.y).powi(2); if d < bd2 { bd2 = d; best = j; } } }
                    if best != usize::MAX { let d = bd2.sqrt().max(0.1); let (dx, dy) = ((u.x - b.units[best].x) / d, (u.y - b.units[best].y) / d); self.move_attacker(&mut b, i, (dx, dy), ud.speed * 1.2 * dt, &bars, &wet); b.units[i].face = (-dy).atan2(-dx); }
                    continue;
                }
            }
            // nearest enemy
            let tower_guard = tower_guards[i];
            let (from_x, from_y) = if tower_guard { (u.hx, u.hy) } else { (u.x, u.y) };
            let order = b.tactics.order_for(&u, tower_guard);
            let ordered = (order.x, order.y);
            let distance_to_order = (ordered.0 - u.x).hypot(ordered.1 - u.y);
            if deploying {
                if (1..=tactics::FLANK).contains(&order.mode) && distance_to_order > 3.0 {
                    let step = (ud.speed * dt).min(distance_to_order);
                    if u.side == 0 { self.own_walk(&mut b, i, ordered.0, ordered.1, step, &wet, &cr, &mut want); }
                    else { self.move_attacker(&mut b, i, ((ordered.0 - u.x) / distance_to_order, (ordered.1 - u.y) / distance_to_order), step, &bars, &wet); }
                } else if u.side == 0 && u.held && !tower_guard {
                    let d = (u.hx - u.x).hypot(u.hy - u.y);
                    if d > 1.5 { self.own_walk(&mut b, i, u.hx, u.hy, ud.speed * dt * if d > 5.0 { 1.5 } else { 1.0 }, &wet, &cr, &mut want); }
                    let at_post = (u.hx - b.units[i].x).hypot(u.hy - b.units[i].y) < 1.8;
                    b.units[i].elev = if at_post { u.pelev } else { 0.0 };
                }
                continue;
            }
            let (mut best, mut bd, mut score) = (usize::MAX, f32::MAX, f32::MAX);
            for j in 0..n {
                if !b.units[j].alive || b.units[j].side == u.side { continue; }
                let foe = &b.units[j];
                let d = (foe.x - from_x).powi(2) + (foe.y - from_y).powi(2);
                let near_order = if order.mode == 0 { 0.0 } else { (foe.x - ordered.0).powi(2) + (foe.y - ordered.1).powi(2) };
                let priority = if matches!(order.mode, tactics::FOCUS | tactics::FLANK) { d + 1.8 * near_order } else { d };
                if matches!(order.mode, tactics::FOCUS | tactics::FLANK) && near_order > (ud.range.max(8.0) + 8.0).powi(2) && d > 4.0f32.powi(2) { continue; }
                if matches!(order.mode, tactics::HOLD | tactics::FALL_BACK) && near_order > (ud.range + 5.0).powi(2) { continue; }
                if priority < score { bd = d; score = priority; best = j; }
            }
            let d_enemy = bd.sqrt();
            let siege = u.kind == 4;
            if u.held && u.pelev > 0.0 && !bars.iter().any(|q| (q.1 - u.hx).powi(2) + (q.2 - u.hy).powi(2) < 3.2 * 3.2) { b.units[i].pelev = 0.0; b.units[i].elev = 0.0; }   // the wall they stood on is gone
            let u = b.units[i].clone();
            if u.held && u.pelev > 0.0 { let (dx, dy) = (u.hx - u.x, u.hy - u.y); b.units[i].elev = if (dx * dx + dy * dy).sqrt() < 1.8 { u.pelev } else { 0.0 }; }
            let rng = if tower_guard { radii::TOWER_RANGE } else if b.units[i].elev > 0.0 { ud.range * radii::WALL_HEIGHT_RANGE } else { ud.range };
            let aggro = if tower_guard { rng } else { (if u.side == 1 { 26.0 } else if u.held { rng.max(ud.range + 5.0) } else { 34.0 }) * tactics::stance_reach(order.mode) };
            let pinned = (tower_guard || b.units[i].elev > 0.0) && d_enemy > rng;
            let move_to_order = match order.mode {
                tactics::FALL_BACK => distance_to_order > 5.0,
                tactics::HOLD => distance_to_order > 6.0 && d_enemy > rng,
                tactics::FOCUS => distance_to_order > 5.0 && d_enemy > rng,
                tactics::FLANK => distance_to_order > 6.0 && d_enemy > 3.2,
                _ => false,
            };
            if move_to_order {
                let step = (ud.speed * dt * if order.mode == tactics::FALL_BACK { 1.15 } else { 1.0 }).min(distance_to_order);
                self.battle_move(&mut b, i, ordered, step, &bars, &wet, &cr, &mut want, &mut dmg_b);
                continue;
            }
            // catapults on the defending side lob stones at whoever comes into range
            if siege && u.side == 0 {
                if best != usize::MAX && d_enemy <= ud.range && b.units[i].cd <= 0.0 {
                    let (tx, ty) = (b.units[best].x, b.units[best].y);
                    b.units[i].face = (ty - u.y).atan2(tx - u.x); b.units[i].cd = ud.cd; b.units[i].anim = 0.4;
                    shots.push([1.0, u.x, u.y, tx, ty, 0.0, u.kind as f32]);
                    if self.rf() < 0.7 { b.tactics.strikes.push(Strike { attacker: i, target: best, at: b.t + (d_enemy / 15.0).max(0.35), dmg: ud.dmg, x: tx, y: ty, reach: 3.0, kind: 2, splash: 30.0 }); }
                }
                continue;
            }
            // attacking catapults keep their distance: they back away from anyone who gets close
            if siege && u.side == 1 && best != usize::MAX && d_enemy < 15.0 {
                let (mx, my) = ((u.x - b.units[best].x) / d_enemy.max(0.1), (u.y - b.units[best].y) / d_enemy.max(0.1));
                self.skirmish_step(&mut b, i, (u.x + mx * ud.speed * dt, u.y + my * ud.speed * dt), &bars, &wet, &cr);
                b.units[i].face = (-my).atan2(-mx);
                continue;
            }
            let mut acted = false;
            let ram_atk = u.kind == RAM && u.side == 1;   // an attacking ram ignores soldiers and goes for the doors
            if best != usize::MAX && !siege && !ram_atk && d_enemy <= aggro && !pinned {
                let (tx, ty) = (b.units[best].x, b.units[best].y);
                let ranged = u.kind == 1;
                let free = !tower_guard && u.elev <= 0.0 && !u.wading;
                if order.mode == tactics::HOLD { b.units[i].face = (ty - u.y).atan2(tx - u.x); }
                if ranged && free && d_enemy < rng * 0.60 && b.units[i].cd > 0.0 && order.mode != tactics::HOLD {
                    let (dx, dy) = ((u.x - tx) / d_enemy.max(0.1), (u.y - ty) / d_enemy.max(0.1));
                    let step = ud.speed * 0.7 * dt;
                    self.skirmish_step(&mut b, i, (u.x + dx * step, u.y + dy * step), &bars, &wet, &cr);
                    b.units[i].face = (ty - u.y).atan2(tx - u.x);
                    continue;
                }
                if d_enemy <= rng && !(u.side == 1 && b.units[i].wading) {
                    b.units[i].face = (ty - u.y).atan2(tx - u.x);
                    if b.units[i].cd <= 0.0 {
                        let charge = if u.charge && !tactics::braced_against(&b, &b.units[best], &u) { if tech & tactics::CAVALRY_TACK != 0 { 2.0 } else { 1.7 } } else { 1.0 };
                        let weapon = match u.kind {
                            0 if b.units[best].kind == 3 => if tech & tactics::SPEAR_DRILL != 0 { 1.75 } else { 1.25 },
                            1 if tech & tactics::FIRE_ARROWS != 0 => 1.20,
                            2 if tech & tactics::TEMPERED_BLADES != 0 => 1.25,
                            _ => 1.0,
                        };
                        let rear = tactics::rear_attack(&u, &b.units[best]);
                        b.units[i].charge = false;
                        let hit = !ranged || self.rf() < if b.units[best].wading { WADE_HIT } else { HIT_CHANCE };
                        if hit {
                            let pace = if !tower_guard && u.boss == 0 && b.units[best].boss == 0 { 0.8 } else { 1.0 };
                            let dmg = ud.dmg * charge * weapon * rear * pace * tactics::counter(&u, &b.units[best]) * tactics::rank(&u) * tactics::stance_dealt(order.mode) * if u.side == 0 { hero_mult } else if u.soak > 0.0 { SOAK_DAMAGE } else { 1.0 };
                            let (at, reach) = if ranged { ((d_enemy / 30.0).max(0.35), 1.7) } else { (0.5, rng + 0.65) };
                            b.tactics.strikes.push(Strike { attacker: i, target: best, at: b.t + at, dmg, x: tx, y: ty, reach, kind: ranged as u8, splash: 0.0 });
                        }
                        b.units[i].cd = ud.cd; b.units[i].anim = 0.55;
                        if ranged { shots.push([0.0, u.x, u.y, tx, ty, (tech & tactics::FIRE_ARROWS != 0) as u8 as f32, u.kind as f32]); }
                    } else if free && u.kind == 3 && u.boss == 0 && d_enemy > 0.25 && order.mode != tactics::HOLD {
                        self.circle_foe(&mut b, i, (tx, ty), d_enemy, ud.speed * dt, &bars, &wet, &cr);
                    }
                } else if !matches!(order.mode, tactics::HOLD | tactics::FALL_BACK) || distance_to_order > 6.0 {
                    let stride = if ranged { (d_enemy - rng + 0.25).clamp(0.0, ud.speed * dt) } else { ud.speed * dt };
                    self.battle_move(&mut b, i, (tx, ty), stride, &bars, &wet, &cr, &mut want, &mut dmg_b);
                }
                acted = true;
            }
            if acted || tower_guard { continue; }
            if matches!(order.mode, tactics::HOLD | tactics::FALL_BACK) && distance_to_order <= 6.0 { continue; }
            if u.side == 1 && b.lair < 0 {
                if let Some(wagon) = objective.filter(|o| o.kind == raid_objective::Kind::Caravan) {
                    if (u.x - wagon.x).hypot(u.y - wagon.y) > 4.0 {
                        self.battle_move(&mut b, i, (wagon.x, wagon.y), ud.speed * dt, &bars, &wet, &cr, &mut want, &mut dmg_b);
                    }
                    continue;
                }
                // attackers go for the nearest building
                let mut tb = usize::MAX; let mut td = f32::MAX;
                let hurls = u.boss > 0 && BOSSES[(u.boss - 1) as usize].boulder > 0.0;   // an ogre throws boulders at walls
                let gates = u.kind == RAM && self.buildings.iter().any(|g| g.kind == GATE && g.hp > 0.0);   // a ram looks for a door
                for (k, bd2) in self.buildings.iter().enumerate() {
                    if bd2.hp <= 0.0 || bd2.kind == ROAD || is_edit(bd2.kind) { continue; }
                    if raid_gate.is_some_and(|gate| gate != k) || (gates && bd2.kind != GATE) { continue; }
                    if raid_gate != Some(k) && !siege && u.kind != RAM && !hurls && is_stone(bd2.kind, bd2.tier) { continue; }
                    let d = (bd2.x - u.x).powi(2) + (bd2.y - u.y).powi(2);
                    if d < td { td = d; tb = k; }
                }
                if tb == usize::MAX { continue; }
                let (bx, by) = (self.buildings[tb].x, self.buildings[tb].y);
                let br = DEFS[self.buildings[tb].kind as usize].r;
                let d = td.sqrt();
                let reach = if siege { ud.range * 0.9 } else if hurls { BOULDER_REACH } else { ud.range.max(1.0) + br * 0.8 };   // catapults fire from a distance
                if d <= reach && !b.units[i].wading {
                    b.units[i].face = (by - u.y).atan2(bx - u.x);
                    if b.units[i].cd <= 0.0 {
                        let flaming = u.kind == 1 && tech & tactics::FIRE_ARROWS != 0;
                        let (mult, fire) = if siege { (3.2, 0.3) } else if hurls { (BOSSES[(u.boss - 1) as usize].boulder, 0.1) } else if u.kind == RAM { (ram_mult(self.buildings[tb].kind) * if tech & tactics::RAM_SHOES != 0 { 1.3 } else { 1.0 }, 0.0) } else if u.kind == 1 { (0.25, if flaming { 0.32 } else { 0.0 }) } else { (0.7, 0.05) };
                        dmg_b.push((tb, ud.dmg * mult));
                        let fl = flammability(self.buildings[tb].kind, self.buildings[tb].tier);
                        if self.rf() < fire * (0.4 + fl) { ignites.push(tb); }
                        b.units[i].cd = ud.cd; b.units[i].anim = 0.4;
                        if ud.range > 5.0 || hurls { shots.push([if siege || hurls { 1.0 } else { 0.0 }, u.x, u.y, bx, by, flaming as u8 as f32, u.kind as f32]); }
                        if siege { impacts.push((bx + (self.rf() - 0.5) * 3.0, by + (self.rf() - 0.5) * 3.0)); }
                    }
                } else {
                    self.battle_move(&mut b, i, (bx, by), ud.speed * dt, &bars, &wet, &cr, &mut want, &mut dmg_b);
                }
            } else {
                // defenders drift back to their post
                let (dx, dy) = (u.hx - u.x, u.hy - u.y); let d = (dx * dx + dy * dy).sqrt();
                if d > 1.5 { let sp = ud.speed * dt * if u.held && d > 5.0 { 1.5 } else { 1.0 }; self.own_walk(&mut b, i, u.hx, u.hy, sp, &wet, &cr, &mut want); }
            }
        }
        // soft separation so units do not stack
        let can_space_engine = |u: &Unit, p: (f32, f32), b: &Battle| {
            let Some(obstacles) = &siege_obstacles else { return false; };
            if u.wading || self.own_wet(b, &wet, &cr, p.0, p.1) { return false; }
            let h = self.height_ground(p.0, p.1);
            (!self.ground_is_wet(p.0, p.1, h) || cr.iter().any(|c| c.down && c.on(p.0, p.1)))
                && (self.height_ground(u.x, u.y) - h).abs() < 0.8
                && obstacles.movement_clear((u.x, u.y), p, 0.95)
        };
        for i in 0..n {
            if !b.units[i].alive { continue; }
            for j in (i + 1)..n {
                if !b.units[j].alive { continue; }
                let (a, z) = (&b.units[i], &b.units[j]);
                let (dx, dy) = (z.x - a.x, z.y - a.y);
                let d2 = dx * dx + dy * dy;
                let engines = a.side == z.side && matches!(a.kind, 4 | RAM) && matches!(z.kind, 4 | RAM);
                if engines && d2 < SIEGE_SPACING * SIEGE_SPACING {
                    let d = d2.sqrt();
                    let (ux, uy) = if d > 0.01 { (dx / d, dy / d) } else { (-a.face.sin(), a.face.cos()) };
                    let push = ((SIEGE_SPACING - d) * 0.5).min(0.65);
                    let (ni, nj) = ((a.x - ux * push, a.y - uy * push), (z.x + ux * push, z.y + uy * push));
                    let (move_i, move_j) = (can_space_engine(a, ni, &b), can_space_engine(z, nj, &b));
                    if move_i { (b.units[i].x, b.units[i].y) = ni; }
                    if move_j { (b.units[j].x, b.units[j].y) = nj; }
                } else if d2 < 0.8 && d2 > 0.0001 {
                    let d = d2.sqrt(); let push = (0.9 - d) * 0.5;
                    let (ni, nj) = ((b.units[i].x - dx / d * push, b.units[i].y - dy / d * push), (b.units[j].x + dx / d * push, b.units[j].y + dy / d * push));
                    if !tower_guards[i] && (b.units[i].side == 1 || !self.own_wet(&b, &wet, &cr, ni.0, ni.1)) { b.units[i].x = ni.0; b.units[i].y = ni.1; }
                    if !tower_guards[j] && (b.units[j].side == 1 || !self.own_wet(&b, &wet, &cr, nj.0, nj.1)) { b.units[j].x = nj.0; b.units[j].y = nj.1; }
                }
            }
        }
        for (k, d) in dmg_b { if k < self.buildings.len() { self.buildings[k].hp -= d; } }
        for k in ignites { self.ignite(k); }
        for (x, y) in impacts {
            self.crater(x, y, 2.4, 1.0);
            // splash
            for i in 0..b.units.len() { if b.units[i].alive && b.units[i].side == 0 && (b.units[i].x - x).powi(2) + (b.units[i].y - y).powi(2) < 9.0 { Self::damage_from(&mut b, i, 35.0, true); } }
            if terrain::forest_near(self.seed, x, y, 4.0) > 0.2 { self.start_wildfire(x, y); }
        }
        self.siege_step(&mut b, dt, deploying, &wet, &mut shots);
        self.shots.extend(shots);
        self.db_want.extend(want);
        self.raid_objective_step(&mut b, dt);
        self.battle = Some(b);
        self.collect_destroyed();
        self.check_battle_end();
    }

    fn battle_move(&mut self, b: &mut Battle, i: usize, to: (f32, f32), step: f32, bars: &[(usize, f32, f32, f32, u8)], wet: &[(f32, f32, f32)], cr: &[crate::lend::Cross], want: &mut Vec<u32>, damage: &mut Vec<(usize, f32)>) {
        let u = &b.units[i];
        if u.side == 0 {
            self.own_walk(b, i, to.0, to.1, step, wet, cr, want);
            return;
        }
        let (dx, dy) = (to.0 - u.x, to.1 - u.y);
        let len = dx.hypot(dy);
        if len < 1e-3 { return; }
        let blocked = self.move_attacker(b, i, (dx / len, dy / len), step.min(len), bars, wet);
        if let Some(blk) = blocked { self.on_block(b, i, blk, bars, damage, SUBSTEP); }
    }

    fn skirmish_step(&self, b: &mut Battle, i: usize, to: (f32, f32), bars: &[(usize, f32, f32, f32, u8)], wet: &[(f32, f32, f32)], cr: &[crate::lend::Cross]) -> bool {
        let u = &b.units[i];
        let (x, y) = to;
        if bars.iter().any(|&(_, bx, by, r, _)| (bx - x).hypot(by - y) < r + 0.6)
            || self.own_wet(b, wet, cr, x, y)
            || (self.ground_is_wet(x, y, self.height_ground(x, y)) && !cr.iter().any(|c| c.down && c.on(x, y)))
            || (self.height_ground(u.x, u.y) - self.height_ground(x, y)).abs() > 1.1
            || !self.obst().solid_clear((u.x, u.y), to, crate::members::FOOT_MARGIN) { return false; }
        (b.units[i].x, b.units[i].y) = to;
        true
    }

    fn circle_foe(&self, b: &mut Battle, i: usize, target: (f32, f32), distance: f32, stride: f32, bars: &[(usize, f32, f32, f32, u8)], wet: &[(f32, f32, f32)], cr: &[crate::lend::Cross]) {
        let u = &b.units[i];
        let (dx, dy) = (u.x - target.0, u.y - target.1);
        let angle = (stride / distance).min(0.44) * if i % 2 == 0 { 1.0 } else { -1.0 };
        let (sin, cos) = angle.sin_cos();
        let radius = (distance + (2.6 - distance) * 0.45) / distance;
        let orbit = |sin| (target.0 + radius * (dx * cos - dy * sin), target.1 + radius * (dx * sin + dy * cos));
        let (a, z, x, y) = (orbit(sin), orbit(-sin), u.x, u.y);
        if self.skirmish_step(b, i, a, bars, wet, cr) || self.skirmish_step(b, i, z, bars, wet, cr) {
            b.units[i].face = (b.units[i].y - y).atan2(b.units[i].x - x);
        }
    }

    /// Bosses' own clocks and powers, once a step before anyone moves: the war horn (returns the horns now sounding: x, y, reach, haste) and the slam.
    fn boss_step(b: &mut Battle, dt: f32, shots: &mut Vec<[f32; 7]>) -> Vec<[f32; 4]> {
        let mut horns = vec![];
        for i in 0..b.units.len() {
            let u = b.units[i].clone();
            if u.boss == 0 || !u.alive { continue; }
            if b.rout.get(i).copied().unwrap_or(0.0) > 0.0 { continue; }
            let bd = &BOSSES[(u.boss - 1) as usize];
            if bd.step_secs > 0.0 { b.units[i].t1 = (u.t1 - dt).max(0.0); }
            if bd.horn_every > 0.0 {
                let mut t = u.t1 + dt;
                if t >= bd.horn_every { t = 0.0; shots.push([3.0, u.x, u.y, u.x, u.y, 0.0, u.boss as f32]); b.units[i].anim = 0.6; }
                b.units[i].t1 = t;
                if t < bd.horn_secs { horns.push([u.x, u.y, bd.horn_reach, bd.horn_haste]); }
            }
            if bd.slam_every > 0.0 {
                let t = (u.t2 - dt).max(0.0);
                b.units[i].t2 = t;
                if t <= 0.0 && !u.wading && b.units[i].climb <= 0.0 {
                    let r2 = bd.slam_reach * bd.slam_reach;
                    let near: Vec<usize> = (0..b.units.len()).filter(|&j| b.units[j].alive && b.units[j].side != u.side && (b.units[j].x - u.x).powi(2) + (b.units[j].y - u.y).powi(2) <= r2).collect();
                    if !near.is_empty() {
                        for j in near { let d = ((b.units[j].x - u.x).powi(2) + (b.units[j].y - u.y).powi(2)).sqrt(); Self::damage_from(b, j, bd.slam_dmg * (1.0 - 0.5 * d / bd.slam_reach) * if u.phase > 0 { bd.rage_dmg } else { 1.0 }, true); }
                        b.units[i].t2 = bd.slam_every; b.units[i].anim = 0.6;
                        shots.push([2.0, u.x, u.y, u.x, u.y, 0.0, u.boss as f32]);
                    }
                }
            }
        }
        horns
    }

    /// Is this spot in the water of a moat or river, with no bridge or drawbridge over it?
    fn in_water(b: &Battle, wet: &[(f32, f32, f32)], x: f32, y: f32, grow: f32) -> bool {
        wet.iter().any(|&(wx, wy, wr)| (x - wx).powi(2) + (y - wy).powi(2) < (wr + grow) * (wr + grow)) && !Self::battle_bridge(b, x, y)
    }

    pub(crate) fn battle_bridge(b: &Battle, x: f32, y: f32) -> bool {
        b.bridges.iter().any(|g| (g[0] - x).powi(2) + (g[1] - y).powi(2) < 3.4 * 3.4)
            || b.fixed.iter().any(|g| (g[0] - x).powi(2) + (g[1] - y).powi(2) < 3.4 * 3.4)
    }

    fn river_wading(&self, x: f32, y: f32) -> bool {
        let surface = self.river_surface_at(x, y);
        surface > 0.0 && self.height_ground(x, y) < surface
    }

    fn move_attacker(&mut self, b: &mut Battle, i: usize, (dx, dy): (f32, f32), step: f32, bars: &[(usize, f32, f32, f32, u8)], wet: &[(f32, f32, f32)]) -> Option<Block> {
        let before = self.felled.len();
        let soak = b.units[i].soak;
        let blocked = Self::attacker_step(b, i, dx, dy, step, bars, wet, self.seed, &mut self.felled);
        if self.felled.len() > before { self.map_ver += 1; }
        if blocked.is_none() {
            let (x, y) = (b.units[i].x, b.units[i].y);
            if !b.units[i].wading && self.river_wading(x, y) && !Self::battle_bridge(b, x, y) {
                b.units[i].wading = true;
                b.units[i].soak = soak;
            }
        }
        blocked
    }

    /// Is this spot water for one of our own soldiers: a moat or river with no dry way over it (a bridge, or a deck that is down)?
    fn own_wet(&self, b: &Battle, wet: &[(f32, f32, f32)], cr: &[crate::lend::Cross], x: f32, y: f32) -> bool {
        (Self::in_water(b, wet, x, y, CHANNEL_BANK - 0.5) || (self.river_wading(x, y) && !Self::battle_bridge(b, x, y)))
            && !cr.iter().any(|c| c.down && c.on(x, y))
    }

    /// Is the straight line from (ax, ay) to (bx, by) dry for our own soldiers (the last `tail` units before the end are not looked at: a foe may stand in the water)?
    fn own_line_dry(&self, b: &Battle, wet: &[(f32, f32, f32)], cr: &[crate::lend::Cross], a: (f32, f32), t: (f32, f32), tail: f32) -> bool {
        let l = (t.0 - a.0).hypot(t.1 - a.1); let n = ((l - tail).max(0.0) / 1.0).ceil() as i32;
        (1..=n).all(|q| { let f = (q as f32 / (l / 1.0).ceil().max(1.0)).min(1.0); !self.own_wet(b, wet, cr, a.0 + (t.0 - a.0) * f, a.1 + (t.1 - a.1) * f) })
    }

    /// One step of one of our own soldiers towards (tx, ty). They do not wade: a straight way is taken only if it is dry; otherwise they walk to the nearest way over the water (a bridge, a bridge
    /// the soldiers built, or a drawbridge, which they ask to have lowered through `want`), cross it and go on; with no way over they stop at the water's edge.
    fn own_walk(&self, b: &mut Battle, i: usize, tx: f32, ty: f32, step: f32, wet: &[(f32, f32, f32)], cr: &[crate::lend::Cross], want: &mut Vec<u32>) {
        let (x, y) = (b.units[i].x, b.units[i].y);
        let go = |b: &mut Battle, gx: f32, gy: f32| {
            let (dx, dy) = (gx - x, gy - y); let d = dx.hypot(dy);
            if d < 1e-4 { return; }
            let s = step.min(d); let (nx, ny) = (x + dx / d * s, y + dy / d * s);
            b.units[i].face = dy.atan2(dx);
            if !self.own_wet(b, wet, cr, nx, ny) || self.own_wet(b, wet, cr, x, y) { b.units[i].x = nx; b.units[i].y = ny; }   // (never a step into the water)
        };
        if let Some(c) = cr.iter().find(|c| c.db >= 0 && c.on(x, y)) { want.push(c.db as u32); }   // (somebody is on the deck: it stays down)
        let d_t = (tx - x).hypot(ty - y);
        if d_t < 1e-3 { return; }
        if self.own_line_dry(b, wet, cr, (x, y), (tx, ty), 3.0) { go(b, tx, ty); return; }
        // on a deck: carry on to the end that is nearer the goal
        if let Some(c) = cr.iter().find(|c| c.down && c.on(x, y)) {
            let (da, db) = ((c.ax - tx).hypot(c.ay - ty), (c.bx - tx).hypot(c.by - ty));
            let e = if da < db { (c.ax, c.ay) } else { (c.bx, c.by) };
            go(b, e.0, e.1); return;
        }
        // the best way over: shortest walk there, over and on, with a dry way to the near end and from the far end
        let mut best: Option<(f32, (f32, f32), usize)> = None;
        for (k, c) in cr.iter().enumerate() {
            if !c.down && !c.lendable { continue; }
            for (n, f) in [((c.ax, c.ay), (c.bx, c.by)), ((c.bx, c.by), (c.ax, c.ay))] {
                let cost = (n.0 - x).hypot(n.1 - y) + (f.0 - n.0).hypot(f.1 - n.1) + (tx - f.0).hypot(ty - f.1);
                if best.map_or(true, |q| cost < q.0) && self.own_line_dry(b, wet, cr, (x, y), n, 0.0) && self.own_line_dry(b, wet, cr, f, (tx, ty), 3.0) { best = Some((cost, n, k)); }
            }
        }
        let Some((_, near, k)) = best else { b.units[i].face = (ty - y).atan2(tx - x); return };   // no way over: it waits at the water's edge
        let c = cr[k]; let dn = (near.0 - x).hypot(near.1 - y);
        if c.db >= 0 && dn < 18.0 { want.push(c.db as u32); }
        if dn > 0.8 { go(b, near.0, near.1); }
        else if c.down { let far = if (c.ax - near.0).abs() + (c.ay - near.1).abs() < 0.01 { (c.bx, c.by) } else { (c.ax, c.ay) }; go(b, far.0, far.1); }
        else { b.units[i].face = (ty - y).atan2(tx - x); }   // the deck is still being lowered: wait for it
    }

    /// Move an attacker one step. Walls, fences and gates stop it (it may only move away from them). A moat or river does not: raiders wade or float across on rafts and ladders laid
    /// over the water, but only at a crawl (see WADE_SPEED), unable to fight, and hit twice as hard. A bridge or lowered drawbridge is a dry way over. Returns what stopped it.
    pub(crate) fn attacker_step(b: &mut Battle, i: usize, mx: f32, my: f32, step: f32, bars: &[(usize, f32, f32, f32, u8)], wet: &[(f32, f32, f32)], seed: u64, felled: &mut Vec<[f32; 3]>) -> Option<Block> {
        let (ox, oy) = (b.units[i].x, b.units[i].y);
        let slow = if b.units[i].wading { if b.units[i].kind == 3 || b.units[i].kind == RAM { WADE_KNIGHT } else { WADE_SPEED } } else if b.units[i].soak > 0.0 { SOAK_SPEED } else { 1.0 };
        let (nx, ny) = (ox + mx * step * slow, oy + my * step * slow);
        for (bi, &(_, bx, by, r, _)) in bars.iter().enumerate() {
            let (dn, d0) = (((nx - bx).powi(2) + (ny - by).powi(2)).sqrt(), ((ox - bx).powi(2) + (oy - by).powi(2)).sqrt());
            if dn < r + 0.6 && dn < d0 { b.units[i].face = (by - oy).atan2(bx - ox); return Some(Block::Bar(bi)); }
        }
        b.units[i].x = nx; b.units[i].y = ny; b.units[i].face = my.atan2(mx);
        // Raiders clear a broad corridor as they advance, rather than ghosting through an intact forest.
        if !b.units[i].wading && felled.len() < 4000 {
            let ts = terrain::trees(seed, ox.min(nx) - 6.5, oy.min(ny) - 6.5, ox.max(nx) + 6.5, oy.max(ny) + 6.5);
            let vx = nx - ox; let vy = ny - oy; let vv = (vx * vx + vy * vy).max(1e-4);
            for k in (0..ts.len()).step_by(5) {
                let (tx, ty) = (ts[k], ts[k + 1]);
                let t = (((tx - ox) * vx + (ty - oy) * vy) / vv).clamp(0.0, 1.0);
                let d = (tx - (ox + vx * t)).hypot(ty - (oy + vy * t));
                if d <= 6.0 && !felled.iter().any(|q| (q[0] - tx).hypot(q[1] - ty) < q[2]) { felled.push([tx, ty, 3.0]); }
            }
        }
        let was = b.units[i].wading;
        b.units[i].wading = Self::in_water(b, wet, nx, ny, if b.units[i].wading { 0.8 } else { 0.0 });   // (once in, a raider stays "in the water" a little past the rim, so it does not flicker in and out)
        if was && !b.units[i].wading { b.units[i].soak = SOAK_SECS; }
        None
    }

    /// What an attacker does when something stops it: climb with a ladder or hack at the wall.
    fn on_block(&self, b: &mut Battle, i: usize, blk: Block, bars: &[(usize, f32, f32, f32, u8)], dmg_b: &mut Vec<(usize, f32)>, _dt: f32) {
        let kind = b.units[i].kind; let ud = &unit_stat(&b.units[i]); let big = b.units[i].boss > 0;
        match blk {
            Block::Bar(bi) => {
                let (k, bx, by, r, bk) = bars[bi];
                let ang = (b.units[i].y - by).atan2(b.units[i].x - bx);
                if kind == RAM {   // a ram batters whatever bars its way, doors best of all
                    if b.units[i].cd <= 0.0 { dmg_b.push((k, ud.dmg * ram_mult(bk))); b.units[i].cd = ud.cd; b.units[i].anim = 0.5; }
                    return;
                }
                if matches!(kind, 0 | 2) && !big {   // spearmen and swordsmen climb (a boss is too big for a ladder)
                    if bk == FENCE { b.units[i].climb = 1.2; return; }
                    let secs = 3.0 + 1.5 * self.buildings[k].tier as f32;
                    if let Some(si) = b.spots.iter().position(|s| (s[0] - bx).powi(2) + (s[1] - by).powi(2) < 3.3 * 3.3 && s[3] == 0.0) { b.spots[si][3] = 1.0; b.units[i].spot = si as i32; b.units[i].climb = secs; return; }
                    if b.ladders_used < b.ladders { b.ladders_used += 1; b.spots.push([bx + ang.cos() * (r + 0.4), by + ang.sin() * (r + 0.4), ang, 0.0]); return; }
                }
                if is_stone(bk, self.buildings[k].tier) {   // nothing a man with a spear can do to stone: wait for a ladder, dig under it (see siege.rs), or look for another way round
                    if matches!(kind, 0 | 2) && !big && bk == WALL { self.try_sap(b, k, ang); }
                    if !matches!(kind, 0 | 2) || big { let t = ang + std::f32::consts::FRAC_PI_2 * if i % 2 == 0 { 1.0 } else { -1.0 }; b.units[i].x += t.cos() * ud.speed * _dt * 0.6; b.units[i].y += t.sin() * ud.speed * _dt * 0.6; b.units[i].face = t; }
                    return;
                }
                if b.units[i].cd <= 0.0 {   // timber wall or fence, and no ladder to use: break it down
                    let mult = if ud.range > 5.0 { 0.25 } else { 0.7 };
                    dmg_b.push((k, ud.dmg * mult)); b.units[i].cd = ud.cd; b.units[i].anim = 0.4;
                }
            }
        }
    }

    // ------------------------------------------------------------ field armies in the fight, retreat and reinforcement
    /// Defenders on the field from the standing army, per kind.
    pub(crate) fn standing_in_battle(&self) -> [u32; NK] {
        let mut n = [0u32; NK];
        if let Some(b) = &self.battle { for u in b.units.iter().filter(|u| u.side == 0 && u.from_army && u.alive && (u.kind as usize) < NK) { n[u.kind as usize] += 1; } }
        n
    }

    /// Soldiers leave the standing army to form a field army while a fight is on: they are taken out of it (living ones, last first). False if that many are not standing in the fight.
    pub(crate) fn battle_release_army(&mut self, units: [u32; NK]) -> bool {
        let Some(b) = self.battle.as_mut() else { return true };
        let stand = { let mut n = [0u32; NK]; for u in b.units.iter().filter(|u| u.side == 0 && u.from_army && u.alive && (u.kind as usize) < NK) { n[u.kind as usize] += 1; } n };
        if (0..NK).any(|k| units[k] > stand[k]) { return false; }
        let mut left = units;
        let mut i = b.units.len();
        while i > 0 {
            i -= 1;
            let u = &b.units[i];
            if u.side == 0 && u.from_army && u.alive && (u.kind as usize) < NK && left[u.kind as usize] > 0 {
                left[u.kind as usize] -= 1; b.remove_unit(i);
                b.start_side[0] = b.start_side[0].saturating_sub(1);
            }
        }
        true
    }

    /// Soldiers of this field army fighting in the battle, by kind (the living, and those who ran off alive).
    fn det_soldiers(b: &Battle, id: u32) -> [u32; NK] {
        let mut n = [0u32; NK];
        for u in b.units.iter().filter(|u| u.det == id && (u.alive || u.escaped) && (u.kind as usize) < NK) { n[u.kind as usize] += 1; }
        n
    }

    /// The army's soldiers enter the battle where the army stands, on the defenders' side, free to charge (they have no post).
    pub(crate) fn det_join(&mut self, di: usize) {
        let wet: Vec<(f32, f32, f32)> = self.buildings.iter().filter(|x| matches!(x.kind, MOAT | RIVER)).map(|x| (x.x, x.y, if x.kind == MOAT { MOAT_FLOOR * moat_scale(x) + 0.5 } else { RIVER_FLOOR + 0.5 })).collect();
        let cr = self.crossings();
        let Some(mut b) = self.battle.take() else { return };
        let d = &self.dets[di];
        let foe = b.units.iter().filter(|u| u.side == 1 && u.alive).min_by(|p, q| ((p.x - d.x).powi(2) + (p.y - d.y).powi(2)).total_cmp(&((q.x - d.x).powi(2) + (q.y - d.y).powi(2))));
        let face = foe.map_or(0.0, |f| (f.y - d.y).atan2(f.x - d.x));
        // an army that has pitched camp (its soldiers are spread over their slots, see march_formation) fights out of it: each soldier starts at their own slot, not piled up at the army's centre
        let camp: Vec<(f32, f32)> = d.file.slots();
        let camped = camp.len() >= d.units.iter().sum::<u32>() as usize;
        let mut j = 0u32;
        for kind in 0..NK {
            for _ in 0..d.units[kind] {
                let a = j as f32 * 2.4; let r = 1.0 + (j / 8) as f32 * 1.4;
                let (mut px, mut py) = if camped && (camp[j as usize].0 - d.x).hypot(camp[j as usize].1 - d.y) <= CAMP_REACH { camp[j as usize] } else { (d.x + a.cos() * r, d.y + a.sin() * r) };
                if self.own_wet(&b, &wet, &cr, px, py) { px = d.x; py = d.y; }   // (never into the water)
                let mut u = Unit::new(0, kind as u8, px, py, face); u.det = d.id; u.cd = 0.3;
                b.units.push(u); b.start_side[0] += 1; j += 1;
            }
        }
        self.battle = Some(b);
        let d = &mut self.dets[di];
        d.state = march::S_FIGHT; d.path.clear(); d.grp.clear(); d.file = Default::default(); d.wi = 0; d.phase = 0; d.defend = false; d.atk = None;
    }

    /// One tick: armies sent to defend join the fight when they get close to an attacker; the armies in it follow their soldiers; with no battle, none is left in one.
    pub(crate) fn defence_step(&mut self) {
        if self.dets.is_empty() { return; }
        if self.battle.is_none() {
            for d in self.dets.iter_mut() { d.defend = false; if d.state == march::S_FIGHT { d.state = march::S_IDLE; } }
            return;
        }
        // guests of allied villages set out for the fight by themselves
        let guests: Vec<u32> = self.dets.iter().filter(|d| d.ally != 0 && !d.defend && d.state == march::S_IDLE).map(|d| d.id).collect();
        for id in guests { self.det_defend_mode(id, false); }
        let Some(b) = self.battle.as_ref() else { return };
        let foes: Vec<(f32, f32)> = b.units.iter().filter(|u| u.side == 1 && u.alive).map(|u| (u.x, u.y)).collect();
        let joins: Vec<usize> = (0..self.dets.len()).filter(|&i| { let d = &self.dets[i]; d.defend && d.state != march::S_FIGHT && foes.iter().any(|f| (f.0 - d.x).powi(2) + (f.1 - d.y).powi(2) <= JOIN_REACH * JOIN_REACH) }).collect();
        for i in joins { self.det_join(i); }
        let Some(b) = self.battle.as_ref() else { return };
        for d in self.dets.iter_mut().filter(|d| d.state == march::S_FIGHT) {
            let (mut sx, mut sy, mut n) = (0.0f32, 0.0f32, 0.0f32);
            for u in b.units.iter().filter(|u| u.det == d.id && u.alive) { sx += u.x; sy += u.y; n += 1.0; }
            if n > 0.0 { d.x = sx / n; d.y = sy / n; }
            d.units = Self::det_soldiers(b, d.id);
        }
    }

    /// Order a field army to the fight. 0 ok, -10 there is no fight, else the march's own codes.
    pub(crate) fn det_defend_inner(&mut self, id: u32) -> i32 {
        if self.dets.iter().any(|d| d.id == id && d.ally != 0) { return -1; }   // guests go to the fight by themselves
        self.det_defend_mode(id, false)
    }

    pub(crate) fn det_defend_mode(&mut self, id: u32, cached_only: bool) -> i32 {
        if self.battle.is_none() { return -10; }
        let Some(i) = self.dets.iter().position(|d| d.id == id) else { return -1 };
        if self.dets[i].state == march::S_FIGHT { return 0; }
        let (dx, dy) = (self.dets[i].x, self.dets[i].y);
        let (tx, ty) = match self.reinforce_waypoint(dx, dy) {
            Ok(Some(target)) => target,
            Ok(None) => { self.dets[i].defend = true; self.defence_step(); return 0; }
            Err(code) => return code,
        };
        let r = self.det_march_mode(id, tx, ty, None, false, cached_only);
        if r == 0 { if let Some(i) = self.dets.iter().position(|d| d.id == id) { self.dets[i].defend = true; } }
        r
    }

    pub(crate) fn reinforce_waypoint(&self, dx: f32, dy: f32) -> Result<Option<(f32, f32)>, i32> {
        let b = self.battle.as_ref().ok_or(-10)?;
        let f = b.units.iter().filter(|u| u.side == 1 && u.alive).min_by(|p, q| ((p.x - dx).powi(2) + (p.y - dy).powi(2)).total_cmp(&((q.x - dx).powi(2) + (q.y - dy).powi(2)))).ok_or(-10)?;
        let (fx, fy) = (f.x, f.y);
        let d = ((fx - dx).powi(2) + (fy - dy).powi(2)).sqrt();
        if d <= JOIN_REACH { return Ok(None); }
        // walk to a spot short of the attacker, on our side of him (he comes on towards us anyway)
        let k = ((d - JOIN_REACH * 0.6) / d).clamp(0.0, 1.0);
        Ok(Some((dx + (fx - dx) * k, dy + (fy - dy) * k)))
    }

    /// An army that is in the fight leaves it (the soldiers who are still standing become an idle army where they stand).
    pub(crate) fn det_disengage(&mut self, id: u32) {
        let Some(i) = self.dets.iter().position(|d| d.id == id) else { return };
        if self.dets[i].state != march::S_FIGHT { return; }
        if let Some(b) = self.battle.as_mut() {
            let n = Self::det_soldiers(b, id);
            let mut k = b.units.len();
            while k > 0 { k -= 1; if b.units[k].det == id { if b.units[k].side == 0 && b.units[k].alive { b.start_side[0] = b.start_side[0].saturating_sub(1); } b.remove_unit(k); } }
            self.dets[i].units = n;
        }
        let d = &mut self.dets[i]; d.state = march::S_IDLE; d.defend = false; d.path.clear(); d.grp.clear(); d.file = Default::default();
        if d.units.iter().sum::<u32>() == 0 { self.dets.remove(i); }
    }

    /// The attackers' side gives up: everybody on it runs for the edge of the field.
    pub(crate) fn retreat_attackers(&mut self, tag: i32) -> bool {
        let Some(b) = self.battle.as_mut() else { return false };
        if b.tag != tag { return false; }
        let n = b.units.len(); if b.rout.len() < n { b.rout.resize(n, 0.0); }
        for i in 0..n { if b.units[i].side == 1 && b.units[i].alive && b.rout[i] <= 0.0 { b.rout[i] = 7.0; } }
        true
    }

    /// More attackers (same tag) arrive from the same direction and form up behind the first.
    pub(crate) fn reinforce_attackers(&mut self, tag: i32, atk: [u32; NK]) -> bool {
        let ang = self.battle.as_ref().map_or(0.0, |b| b.angle); let (cx, cy, dist) = (self.ox as f32, self.oy as f32, self.raid_distance(ang));
        let Some(b) = self.battle.as_mut() else { return false };
        if b.tag != tag || atk.iter().sum::<u32>() == 0 { return false; }
        let (dx, dy) = (b.angle.cos(), b.angle.sin());
        let mut k = 0u32;
        for (kind, &n) in atk.iter().enumerate() { for _ in 0..n {
            let row = 3.0 + (k / 12) as f32; let col = (k % 12) as f32 - 5.5;
            b.units.push(Unit::new(1, kind as u8, cx + dx * (dist + row * 2.2) - dy * col * 2.0, cy + dy * (dist + row * 2.2) + dx * col * 2.0, b.angle + std::f32::consts::PI));
            b.start_side[1] += 1; k += 1;
        } }
        for q in 0..NK { b.atk_start[q] += atk[q]; }
        b.ladders += (atk[0] + atk[2]) / 4;
        true
    }

    fn check_battle_end(&mut self) {
        let Some(b) = self.battle.as_mut() else { return };
        let atk = b.units.iter().filter(|u| u.side == 1 && u.alive).count();
        let def = b.units.iter().filter(|u| u.side == 0 && u.alive).count();
        if b.t > DEPLOY_SECS && def == 0 && atk > 0 { b.pillage += SUBSTEP; }
        if b.boss == DOCTOR && b.lair >= 0 && b.units.iter().any(|u| u.boss > 0 && !u.alive && !u.escaped) {   // the doctor is dead: his guards lose heart and run
            let n = b.units.len(); if b.rout.len() < n { b.rout.resize(n, 0.0); }
            for i in 0..n { if b.units[i].side == 1 && b.units[i].alive && b.rout[i] <= 0.0 { b.rout[i] = 7.0; } }
        }
        let done = atk == 0 || b.pillage > 14.0 || (!b.bought && b.objective.is_some_and(|o| o.held(b.t)))
            || b.t > if b.lair >= 0 { LAIR_SECS } else { 170.0 };
        if done { self.finish_battle(); }
    }

    fn finish_battle(&mut self) {
        self.last_battle_frame = self.battle_units_flat();
        let Some(b) = self.battle.take() else { return };
        // field armies that fought come out of it with the soldiers who survived
        for d in self.dets.iter_mut().filter(|d| d.state == march::S_FIGHT) {
            d.units = Self::det_soldiers(&b, d.id); d.state = march::S_IDLE; d.defend = false;
            let (mut sx, mut sy, mut n) = (0.0f32, 0.0f32, 0.0f32);
            let survivors = || b.units.iter().filter(|u| u.det == d.id && (u.alive || u.escaped));
            for u in survivors() { sx += u.x; sy += u.y; n += 1.0; }
            if n > 0.0 {
                // Rally at a real survivor's position. The mean can sit in water or far from the lair when archers spread out.
                let [x, y] = if b.lair >= 0 && !b.units.iter().any(|u| u.side == 1 && u.alive) { b.lair_at } else { [sx / n, sy / n] };
                if let Some(u) = survivors().min_by(|a, q| ((a.x - x).powi(2) + (a.y - y).powi(2)).total_cmp(&((q.x - x).powi(2) + (q.y - y).powi(2)))) { d.x = u.x; d.y = u.y; }
            }
        }
        self.dets.retain(|d| d.units.iter().sum::<u32>() > 0);
        let atk_alive = b.units.iter().filter(|u| u.side == 1 && u.alive).count() as u32;
        let lair = b.lair >= 0;
        let held = !b.bought && b.objective.is_some_and(|o| o.held(b.t));
        let won = if lair { atk_alive == 0 } else { atk_alive == 0 || held || b.pillage <= 0.0 };
        if won && !b.bought && (held || atk_alive == 0) {
            if let Some(o) = b.objective.filter(|o| !o.lost) { self.reward_raid_objective(o); }
        }
        // the standing army loses the soldiers that fell (anything added during the fight, such as new recruits, stays)
        let mut fell = [0u32; NK];
        for u in b.units.iter().filter(|u| u.side == 0 && u.from_army && !u.alive && (u.kind as usize) < NK) { fell[u.kind as usize] += 1; }
        for k in 0..NK { self.army[k] = self.army[k].saturating_sub(fell[k]); }
        self.promote_veterans(&b, won);
        // archers who fell in a tower are gone from its garrison
        for t in self.buildings.iter_mut().filter(|t| !lair && matches!(t.kind, TOWER | KEEP)) {
            let alive = b.units.iter().filter(|u| u.side == 0 && u.kind == 1 && !u.from_army && u.alive && (u.hx - t.x).abs() < 0.01 && (u.hy - t.y).abs() < 0.01).count() as u8;
            t.garrison = t.garrison.min(alive);
        }
        self.kill(b.militia_dead, DIED_WAR, 3);
        let mut surv = [0u32; NK];
        for u in b.units.iter().filter(|u| u.side == 1 && u.alive) { surv[u.kind as usize] += 1; }
        for k in 0..NK { surv[k] += b.fled_kinds[k]; }   // the ones who ran off come home too
        // loot: raiders that pillaged take a share of the stores
        let mut loot = [0i32; N_RES];
        if !won && b.pillage > 0.0 && !lair {
            for r in 0..N_RES { let pct = if r == GD as usize { 35 } else { 15 }; let take = self.stock[r] * pct / 100; self.stock[r] -= take; loot[r] = take; }
        }
        let boss_down = !b.bought && b.boss > 0 && b.units.iter().any(|u| u.boss > 0 && !u.alive && !u.escaped);
        if boss_down { self.boss_rewards(b.boss, b.bname); if b.boss == DOCTOR { self.end_plague(); self.plague_camp = None; } }
        if lair && won { if let Some(d) = self.neutral_done.get_mut(b.lair as usize) { *d = true; } self.reveal(b.lair_at[0], b.lair_at[1], 80.0); self.push_event(EV_VISIT, 3, 0); }
        self.report_seq += 1;
        self.report = vec![self.report_seq as i32, won as i32, b.tag, atk_alive as i32, b.def_dead as i32, b.bld_lost as i32];
        self.report.extend(surv.iter().map(|&x| x as i32));
        self.report.extend(loot.iter());
        self.report.extend([b.boss as i32, b.bname as i32, boss_down as i32, lair as i32]);   // the boss that led the raid, its name, whether it fell, and whether this was a lair (see docs/BOSSES.md)
        self.report.extend([b.fled[1] as i32, b.fled[0] as i32]);   // attackers and defenders who ran away
        self.report_bought = b.bought;   // the raiders were paid to leave (see bribe.rs): not a victory, not a defeat (kept apart from `report`, whose fields are read from its end)
        if !lair && !b.bought { let ev = if won { EV_REPELLED } else { EV_RAID }; self.push_event(ev, loot[GD as usize], b.def_dead as i32); }
        // the lord learns from a defence, and may fall in a defeat
        if let Some((name, xp)) = self.hero.filter(|_| !lair) {
            if b.bought { /* no glory in a purchase */ } else if won { let gain = 10 + b.atk_dead.min(40); let before = Self::hero_level(xp); let now = xp + gain; self.hero = Some((name, now)); if Self::hero_level(now) > before { self.push_event(EV_HERO, name as i32, Self::hero_level(now) as i32); } }
            else if self.rf() < 0.3 { self.hero = None; self.push_event(EV_HERO, name as i32, -1); }
        }
    }

    /// The army that stands at a lair goes in: the lair's boss and his escort (stronger for a stronger place, `h` 0..1) against the army's soldiers, in the field round the lair. Needs no village buildings:
    /// the lair's side holds its ground and fights whoever comes near. The army wins by killing every one of them (the boss included).
    pub(crate) fn begin_lair_battle(&mut self, di: usize, ni: i32, nx: f32, ny: f32, h: f32, kind: u8) -> bool {
        if self.battle.is_some() || di >= self.dets.len() { return false; }
        let d = &BOSSES[(kind - 1) as usize];
        let sc = d.scale_min + (d.scale_max - d.scale_min) * h;
        let esc = |x: u32| (x as f32 * (0.8 + 0.5 * h)).round() as u32;
        let counts = [esc(d.escort[0]), esc(d.escort[1]), esc(d.escort[2]), esc(d.escort[3])];
        let face = (self.dets[di].y - ny).atan2(self.dets[di].x - nx);
        let mut boss = Unit::new(1, d.base, nx, ny, face);
        boss.boss = kind; boss.bname = (h * 3.99) as u8; boss.hp = boss_hp(kind, sc); boss.maxhp = boss.hp; boss.t2 = if d.slam_every > 0.0 { 3.0 } else { 0.0 };
        let mut units = vec![boss];
        let mut j = 0u32;
        for (kind, &n) in counts.iter().enumerate() { for _ in 0..n {
            let a = face + (j as f32 - 4.0) * 0.55; let r = 3.5 + (j / 7) as f32 * 1.8;
            units.push(Unit::new(1, kind as u8, nx + a.cos() * r, ny + a.sin() * r, face + std::f32::consts::PI)); j += 1;
        } }
        let n1 = units.len() as u32;
        self.battle = Some(Battle { ladders: 0, ladders_used: 0, spots: vec![], sites: vec![], bridges: vec![], units, t: 0.0, pillage: 0.0, tag: 0, angle: face, spawn: [0.0, 0.0], atk_start: [counts[0], counts[1], counts[2], counts[3], 0, 0], atk_dead: 0, def_dead: 0, militia_dead: 0, bld_lost: 0, rout: vec![], start_side: [0, n1], fled: [0, 0], fled_kinds: [0; NK], fixed: vec![], lair: ni, lair_at: [nx, ny], boss: kind, bname: (h * 3.99) as u8, bought: false, bought_t: 0.0, objective: None, siege: Default::default(), tactics: Tactics { tech: [self.military_tech, 0], ..Tactics::default() } });
        self.det_join(di);
        self.push_event(EV_LAIR, ni, 0);
        true
    }

    /// A boss has fallen: its table's gold and iron, a lift in spirits, experience for the lord and, for some, a captured ram.
    pub(crate) fn boss_rewards(&mut self, boss: u8, bname: u8) {
        let d = &BOSSES[(boss - 1) as usize];
        let cap = self.storage_cap();
        self.stock[GD as usize] = Self::add_capped(self.stock[GD as usize], d.gold, cap);
        self.stock[IR as usize] = Self::add_capped(self.stock[IR as usize], d.iron, cap);
        self.mood = self.mood.max(d.mood); self.mood_until = self.mood_until.max(self.tick + d.mood_days as u64 * DAY);
        self.army[RAM as usize] += d.prize_rams;
        if let Some((name, xp)) = self.hero { let before = Self::hero_level(xp); let now = xp + d.xp; self.hero = Some((name, now)); if Self::hero_level(now) > before { self.push_event(EV_HERO, name as i32, Self::hero_level(now) as i32); } }
        self.push_event(EV_BOSS, boss as i32 * 16 + (bname % 4) as i32, 1);
    }

    /// What it costs to build the building from scratch, or a stand-in for buildings that cannot be built (the hall).
    fn base_cost(kind: u8) -> Vec<Amount> {
        let d = &DEFS[kind as usize];
        if d.cost.is_empty() { let w = d.weight as i32; vec![(W, 20 * w), (ST, 10 * w)] } else { d.cost.to_vec() }
    }

    /// Cost to repair `frac` (0..1) of a building's hit points: a share of its build cost, more for grander tiers.
    pub(crate) fn repair_cost_frac(kind: u8, tier: u8, frac: f32) -> Vec<Amount> {
        Self::base_cost(kind).into_iter().map(|(r, n)| (r, ((n as f32) * frac * 0.5 * (1.0 + 0.35 * tier as f32)).ceil().max(1.0) as i32)).collect()
    }

    /// Cost to rebuild a ruin: 60% of the base cost plus 40% of each upgrade it had.
    pub(crate) fn rebuild_cost(kind: u8, tier: u8) -> Vec<Amount> {
        let mut v: Vec<Amount> = Self::base_cost(kind).into_iter().map(|(r, n)| (r, ((n as f32) * 0.6).ceil() as i32)).collect();
        for t in 1..=tier { for (r, n) in upgrade_cost(DEFS[kind as usize].weight, t) { let add = ((n as f32) * 0.4).ceil() as i32; if let Some(e) = v.iter_mut().find(|e| e.0 == r) { e.1 += add } else { v.push((r, add)) } } }
        v
    }

    pub(crate) fn can_afford(&self, c: &[Amount]) -> bool { c.iter().all(|&(r, n)| self.stock[r as usize] >= n) }
    pub(crate) fn pay(&mut self, c: &[Amount]) { for &(r, n) in c { self.stock[r as usize] -= n; } }

    pub(crate) fn recovery_priority(kind: u8) -> u8 {
        let supplies = DEFS[kind as usize].outputs.iter().any(|&(r, _)| r == W || FOODS.iter().any(|&(food, _)| r == food));
        if supplies || matches!(kind, HOUSE | TOWN_HALL | WELL | HOSPITAL) { 0 } else { 1 }
    }

    /// Repair the whole building. 0 ok, -1 invalid, -6 cannot afford, -14 it is burning, -15 nothing to repair.
    pub(crate) fn do_repair(&mut self, idx: usize) -> i32 {
        let Some(b) = self.buildings.get(idx) else { return -1 };
        let max = max_hp(b.kind, b.tier);
        if b.burning > 0.0 { return -14; }
        if b.hp >= max - 0.5 { return -15; }
        let cost = Self::repair_cost_frac(b.kind, b.tier, 1.0 - b.hp / max);
        if !self.can_afford(&cost) { return -6; }
        self.pay(&cost);
        self.buildings[idx].hp = max;
        0
    }

    pub(crate) fn rebuild_site_clear(&self, x: f32, y: f32, radius: f32) -> bool {
        self.buildings.iter().all(|b| (b.x - x).powi(2) + (b.y - y).powi(2) >= (crate::footprint(b.kind, b.tier) + radius - 0.4).powi(2))
    }

    /// Rebuild a ruin where it stood. 0 ok, -1 invalid, -3 something else was built there, -6 cannot afford.
    pub(crate) fn do_rebuild(&mut self, ri: usize) -> i32 {
        let Some(r) = self.ruins.get(ri).copied() else { return -1 };
        let (x, y, kind, tier, rot) = (r[0], r[1], r[3] as u8, r[4] as u8, r[5] as u8);
        let d = &DEFS[kind as usize];
        if !self.rebuild_site_clear(x, y, d.r) { return -3; }
        let cost = Self::rebuild_cost(kind, tier);
        if !self.can_afford(&cost) { return -6; }
        self.pay(&cost);
        self.ruins.remove(ri);
        let fr = d.r * 0.8;
        let pad_h = if matches!(kind, WATERWHEEL | FISHING_HUT | DRAWBRIDGE) { self.placement_height(kind, x, y, rot) }
            else { [(0.0, 0.0), (fr, 0.0), (-fr, 0.0), (0.0, fr), (0.0, -fr)].iter().map(|(px, py)| self.height_at(x + px, y + py)).sum::<f32>() / 5.0 };
        let aux = if d.req == 1 { self.nearest_deposit(x, y, d.req_arg, true).map_or(-1, |i| i as i32) } else { -1 };
        self.buildings.push(Building { kind, tier, x, y, rot, pad_h, progress: 0, status: if d.cycle > 0 { 1 } else { 4 }, aux, staff: 0, residents: 0, hp: max_hp(kind, tier), burning: 0.0, garrison: 0, born: self.tick as u32, opts: 0, fert: FERT_MAX, mode: 0, target: -1, beff: 100 });
        self.terrain_ver += 1;
        self.after_change();
        self.push_event(EV_REBUILT, kind as i32, 0);
        0
    }

    /// Builders' yards send carpenters and masons to mend damaged buildings and raise ruins again, as materials allow.
    pub(crate) fn builders_step(&mut self) {
        let lodges: Vec<usize> = (0..self.buildings.len()).filter(|&i| self.buildings[i].kind == BUILDERS && self.buildings[i].staff > 0).collect();
        if lodges.is_empty() { return; }
        let winter_wood = if self.season() == 3 { 2 * self.winter_need().max(0) } else { 0 };
        let firewood = winter_wood.max(self.reserve_for(W));
        for li in lodges {
            let (lx, ly, tier) = (self.buildings[li].x, self.buildings[li].y, self.buildings[li].tier);
            let need = 700u32;
            self.buildings[li].progress += self.eff * (100 + 60 * tier as u32) / 100;
            if self.buildings[li].progress < need { continue; }
            let in_reach = |x: f32, y: f32| (x - lx).powi(2) + (y - ly).powi(2) <= 70.0f32.powi(2);
            let can_spend = |cost: &[Amount]| self.can_afford(cost) && cost.iter().all(|&(r, n)| r != W || self.stock[W as usize] - n >= firewood);
            let mut pending = false;
            let mut repair: Option<((u8, f32), usize, f32, Vec<Amount>)> = None;
            for (i, b) in self.buildings.iter().enumerate() {
                if i == li || b.burning > 0.0 || b.hp <= 0.0 || !in_reach(b.x, b.y) { continue; }
                let frac = b.hp / max_hp(b.kind, b.tier);
                if frac >= 0.95 { continue; }
                pending = true;
                let rank = (Self::recovery_priority(b.kind), frac);
                if repair.as_ref().is_some_and(|(best, ..)| *best <= rank) { continue; }
                let heal = 0.4f32.min(1.0 - frac);
                let cost = Self::repair_cost_frac(b.kind, b.tier, heal);
                if can_spend(&cost) { repair = Some((rank, i, heal, cost)); }
            }
            let mut rebuild = None;
            for (i, r) in self.ruins.iter().enumerate() {
                if !in_reach(r[0], r[1]) { continue; }
                pending = true;
                let kind = r[3] as u8;
                let rank = (Self::recovery_priority(kind), (r[0] - lx).powi(2) + (r[1] - ly).powi(2));
                if repair.as_ref().is_some_and(|(best, ..)| best.0 <= rank.0) || rebuild.is_some_and(|(best, _)| best <= rank) { continue; }
                if can_spend(&Self::rebuild_cost(kind, r[4] as u8)) && self.rebuild_site_clear(r[0], r[1], DEFS[kind as usize].r) {
                    rebuild = Some((rank, i));
                }
            }
            let worked = if let Some((_, i)) = rebuild {
                self.do_rebuild(i) == 0
            } else if let Some((_, i, heal, cost)) = repair {
                self.pay(&cost);
                let b = &mut self.buildings[i];
                let (kind, max) = (b.kind, max_hp(b.kind, b.tier));
                b.hp = (b.hp + heal * max).min(max);
                if b.hp >= max - 0.5 { self.push_event(EV_REPAIRED, kind as i32, 0); }
                true
            } else { false };
            self.buildings[li].progress = if worked { self.buildings[li].progress - need } else { need };
            self.buildings[li].status = if worked { 0 } else if pending { 1 } else { 4 };
        }
    }

    /// Spend resources to queue units at the barracks.
    pub(crate) fn try_train(&mut self, kind: u8, n: u32) -> i32 {
        if kind as usize >= NK || n == 0 || n > 1000 { return -1; }
        let u = &UNITS[kind as usize];
        let best_tier = self.buildings.iter().filter(|b| b.kind == BARRACKS).map(|b| b.tier as i32).max();
        let Some(bt) = best_tier else { return -11 }; // no barracks
        if (bt as u8) < u.tier { return -12; }          // barracks too basic
        if self.population < n.saturating_add(3) { return -13; }
        for &(r, c) in u.cost { if (self.stock[r as usize] as i64) < c as i64 * n as i64 { return -6; } }
        for &(r, c) in u.cost { self.stock[r as usize] -= c * n as i32; }
        self.enlist(n);
        self.queue[kind as usize] += n;
        0
    }

    /// Take recruits out of the queue: the cost comes back whole and the men return to the village.
    pub(crate) fn try_train_cancel(&mut self, kind: u8, n: u32) -> i32 {
        if kind as usize >= NK || n == 0 || n > self.queue[kind as usize] { return -1; }
        for &(r, c) in UNITS[kind as usize].cost { self.stock[r as usize] += c * n as i32; }
        self.queue[kind as usize] -= n;
        if self.queue[kind as usize] == 0 { self.train_acc[kind as usize] = 0; }
        let back = n.min(self.enlisted); self.enlisted -= back; self.population += back;
        0
    }

    /// Soldiers who came through a won fight may earn their spurs: a few of the standing army's survivors (one, and one more for every four raiders killed) become veterans.
    pub(crate) fn promote_veterans(&mut self, b: &Battle, won: bool) {
        for k in 0..NK {
            let lost = b.units.iter().filter(|u| u.side == 0 && u.from_army && !u.alive && !u.escaped && u.kind as usize == k && tactics::is_veteran(u)).count() as u32;
            self.vets[k] = self.vets[k].saturating_sub(lost);
        }
        if won && !b.bought {
            let mut left = (1 + b.atk_dead / 4).min(6);
            let mut fought = [0u32; NK];
            for u in b.units.iter().filter(|u| u.side == 0 && u.from_army && u.alive && (u.kind as usize) < NK) { fought[u.kind as usize] += 1; }
            let start = (self.tick % NK as u64) as usize;
            for step in 0..NK * 6 {
                if left == 0 { break; }
                let k = (start + step) % NK;
                if self.vets[k] < fought[k].min(self.army[k]) { self.vets[k] += 1; left -= 1; }
            }
        }
        for k in 0..NK { self.vets[k] = self.vets[k].min(self.army[k]); }
    }

    /// A soldier who finishes training while a fight is on takes the field at the barracks (or the hall), so he can be mustered, ordered and counted like those who stood when it began.
    fn recruit_joins_fight(&mut self, kind: usize) {
        let spot = self.buildings.iter().find(|b| b.kind == BARRACKS).map_or((self.buildings[0].x, self.buildings[0].y), |b| (b.x, b.y + 8.0));
        let Some(b) = self.battle.as_mut() else { return };
        if b.bought { return; }
        let n = b.units.iter().filter(|u| u.side == 0 && u.from_army).count() as f32;
        let a = n * 0.7;
        let mut u = Unit::new(0, kind as u8, spot.0 + a.cos() * 2.0, spot.1 + a.sin() * 2.0, 0.0);
        u.from_army = true;
        b.units.push(u); b.start_side[0] += 1;
    }

    /// Barracks turn queued recruits into soldiers, every queued kind at once: the drill is shared between them.
    pub(crate) fn training_step(&mut self) {
        for k in 0..NK { self.vets[k] = self.vets[k].min(self.army[k]); }
        let effort: u32 = self.buildings.iter().filter(|b| b.kind == BARRACKS && b.staff > 0).map(|b| b.tier as u32 + 1).sum();
        if effort == 0 { return; }
        let effort = effort * self.train_pct() / 100;   // (the war focus and the military charter: see realm.rs)
        let effort = effort + effort * self.perks().train_pct / 100 + if self.tick % 4 < (effort * self.perks().train_pct % 100 / 25) as u64 { 1 } else { 0 };   // training dummies: faster drill (the remainder is spread over the ticks)
        let kinds: Vec<usize> = (0..NK).filter(|&k| self.queue[k] > 0).collect();
        if kinds.is_empty() { self.train_prog = 0; return; }
        if self.train_prog > 0 { self.train_acc[kinds[0]] += self.train_prog; self.train_prog = 0; }   // drill begun before the queues ran side by side
        let m = kinds.len() as u32;
        for (n, &k) in kinds.iter().enumerate() {
            let share = effort / m + if ((n as u64 + self.tick) % u64::from(m)) < u64::from(effort % m) { 1 } else { 0 };
            self.train_acc[k] += share;
            while self.queue[k] > 0 && self.train_acc[k] >= UNITS[k].time {
                self.train_acc[k] -= UNITS[k].time;
                self.queue[k] -= 1; self.army[k] += 1;
                self.recruit_joins_fight(k);
                self.push_event(EV_TRAINED, k as i32, 0);
            }
            if self.queue[k] == 0 { self.train_acc[k] = 0; }
        }
    }
}

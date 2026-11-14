//! Battles, fire and terrain damage. Everything here is deterministic: a battle is a pure function of the
//! village state, the attacking army and the RNG stream, so every peer replaying the same commands sees the same fight.
use super::*;
use crate::military::*;

const SUBSTEP: f32 = 0.25;

/// What stopped an attacker: a wall, fence or gate (index into the substep's list) or water.
enum Block { Bar(usize), Wet }

pub fn max_hp(kind: u8, tier: u8) -> f32 {
    let base = match kind { TOWN_HALL => 1400.0, WALL => 280.0, TOWER => 520.0, FENCE => 90.0, GATE => 300.0, DRAWBRIDGE => 220.0, MOAT | RIVER | RAISE | LOWER => 100000.0, _ => DEFS[kind as usize].weight as f32 * 90.0 + 130.0 };
    base * (1.0 + tier as f32 * 0.8)
}

/// How readily a building catches fire: thatch and timber burn, stone resists.
pub fn flammability(kind: u8, tier: u8) -> f32 {
    if is_edit(kind) { return 0.0; }
    let mat = [1.0, 0.7, 0.22, 0.12][tier.min(3) as usize];
    if matches!(kind, WALL) && tier >= 1 { return mat * 0.6; }
    mat
}

impl World {
    fn rf(&mut self) -> f32 { (self.rng.next() >> 8) as f32 / 16777216.0 }

    pub(crate) fn wind_vec(&self) -> (f32, f32) {
        let a = (self.seed % 628) as f32 * 0.01 + self.tick as f32 * 0.0007;
        (a.cos(), a.sin())
    }

    pub(crate) fn defence_points(&self) -> u32 {
        self.buildings.iter().map(|b| match b.kind { TOWER => 2 + 2 * b.garrison as u32, KEEP => 8 + 2 * b.garrison as u32, WALL => 1, GATE => 2, MOAT => 1, RIVER => 1, _ => 0 }).sum::<u32>() + self.army.iter().take(5).sum::<u32>() * 3
    }

    /// Raiders scale with how long the village has existed and how rich it is.
    pub(crate) fn bandit_force(&self, rf: f32) -> [u32; 5] {
        let s = (3.0 + self.population as f32 / 7.0 + self.tick as f32 / 500.0) * (0.75 + rf * 0.5);
        let s = s as u32;
        [2 + s / 2, s / 3, s / 6, if s > 14 { (s - 14) / 6 } else { 0 }, if s > 20 { (s - 20) / 12 } else { 0 }]
    }

    pub(crate) fn begin_battle(&mut self, atk: [u32; 5], angle: f32, tag: i32) -> bool {
        if self.battle.is_some() { return false; }
        let (cx, cy) = (self.ox as f32, self.oy as f32);
        let dist = self.build_radius() as f32 + 22.0;
        let (dx, dy) = (angle.cos(), angle.sin());
        let mut units: Vec<Unit> = vec![];
        // attackers form up in a line facing the village
        let total: u32 = atk.iter().sum();
        let mut k = 0u32;
        for (kind, &n) in atk.iter().enumerate() {
            for _ in 0..n {
                let row = (k / 12) as f32; let col = (k % 12) as f32 - 5.5;
                let (px, py) = (cx + dx * (dist + row * 2.2) - dy * col * 2.0, cy + dy * (dist + row * 2.2) + dx * col * 2.0);
                units.push(Unit { side: 1, kind: kind as u8, x: px, y: py, hx: px, hy: py, hp: UNITS[kind].hp, cd: if kind == 4 { 6.0 } else { 0.5 }, alive: true, from_army: false, charge: kind == 3, anim: 0.0, climb: 0.0, spot: -1, pelev: 0.0, elev: 0.0, held: false, face: angle + std::f32::consts::PI });
                k += 1;
            }
        }
        let _ = total;
        // defenders: standing army, tower guards, hall bodyguard, militia
        let hall = (self.buildings[0].x, self.buildings[0].y);
        let mut j = 0u32;
        for kind in 0..5usize {
            for _ in 0..self.army[kind] {
                let a = j as f32 * 0.7; let r = 4.0 + (j / 9) as f32 * 1.5;
                units.push(Unit { side: 0, kind: kind as u8, x: hall.0 + a.cos() * r, y: hall.1 + a.sin() * r, hx: hall.0 + a.cos() * (r + 3.0), hy: hall.1 + a.sin() * (r + 3.0), hp: UNITS[kind].hp, cd: if kind == 4 { 6.0 } else { 0.5 }, alive: true, from_army: true, charge: kind == 3, anim: 0.0, climb: 0.0, spot: -1, pelev: 0.0, elev: 0.0, held: false, face: 0.0 });
                j += 1;
            }
        }
        let mut guards: Vec<(f32, f32, u8, u32)> = vec![];
        for b in &self.buildings {
            if matches!(b.kind, TOWER | KEEP) && b.garrison > 0 { guards.push((b.x, b.y, 1, b.garrison as u32)); }
            if b.kind == TOWN_HALL { guards.push((b.x + 3.0, b.y + 3.0, 0, 2 * (b.tier as u32 + 1))); }
        }
        for (gx, gy, kind, n) in guards {
            for i in 0..n { let a = i as f32 * 1.4; units.push(Unit { side: 0, kind, x: gx + a.cos(), y: gy + a.sin(), hx: gx, hy: gy, hp: UNITS[kind as usize].hp, cd: 0.5, alive: true, from_army: false, charge: false, anim: 0.0, climb: 0.0, spot: -1, pelev: 0.0, elev: 0.0, held: false, face: 0.0 }); }
        }
        let militia = (self.population / 5).min(14);
        for i in 0..militia { let a = i as f32 * 0.9; units.push(Unit { side: 0, kind: MILITIA, x: hall.0 + a.cos() * 8.0, y: hall.1 + a.sin() * 8.0, hx: hall.0 + a.cos() * 9.0, hy: hall.1 + a.sin() * 9.0, hp: UNITS[5].hp, cd: 1.0, alive: true, from_army: false, charge: false, anim: 0.0, climb: 0.0, spot: -1, pelev: 0.0, elev: 0.0, held: false, face: 0.0 }); }
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
        self.battle = Some(Battle { ladders, ladders_used: 0, spots: vec![], sites: vec![], bridges: vec![], units, t: 0.0, pillage: 0.0, tag, atk_start: atk, atk_dead: 0, def_dead: 0, militia_dead: 0, bld_lost: 0, rout: vec![], start_side: [0, 0], fled: [0, 0], fled_kinds: [0; 5] });
        if let Some(b) = self.battle.as_mut() { for u in &b.units { b.start_side[u.side as usize] += 1; } }
        self.push_event(EV_BATTLE, atk.iter().sum::<u32>() as i32, tag);
        true
    }

    fn damage_unit(b: &mut Battle, j: usize, dmg: f32) {
        let armor = UNITS[b.units[j].kind as usize].armor;
        let d = (dmg * (1.0 - armor * 0.1)).max(1.0) * if b.units[j].elev > 0.0 { 0.8 } else { 1.0 };
        b.units[j].hp -= d;
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
        let mut ignite: Vec<usize> = vec![];
        let mut forest_spawn: Vec<(f32, f32)> = vec![];
        let fighters = self.firefighters() as f32;
        let mut put_out = 0;
        for i in 0..nb {
            if self.buildings[i].burning <= 0.0 { continue; }
            let (bx, by, kind, tier) = (self.buildings[i].x, self.buildings[i].y, self.buildings[i].kind, self.buildings[i].tier);
            let fl = flammability(kind, tier);
            // villagers form a bucket brigade from the nearest well: close wells help most, distant ones half as much
            let mut help = 0.0f32;
            if fighters > 0.0 {
                let wd = wells.iter().map(|w| ((w.0 - bx).powi(2) + (w.1 - by).powi(2)).sqrt()).fold(f32::MAX, f32::min);
                if wd <= 18.0 { help = fighters } else if wd <= 36.0 { help = fighters * 0.5 }
            }
            self.buildings[i].hp -= (4.0 + 14.0 * fl) * dt * (1.0 - (help * 0.07).min(0.6));
            self.buildings[i].burning -= dt * (1.0 + help * 0.55);
            if self.buildings[i].burning <= 0.0 && self.buildings[i].hp > 0.0 { put_out += 1; continue; }
            for j in 0..nb {
                if j == i || self.buildings[j].burning > 0.0 || self.buildings[j].hp <= 0.0 { continue; }
                let (dx, dy) = (self.buildings[j].x - bx, self.buildings[j].y - by);
                let d = (dx * dx + dy * dy).sqrt();
                if d > 11.0 || d < 0.01 { continue; }
                let align = (dx * wx + dy * wy) / d; // downwind spreads faster
                let flj = flammability(self.buildings[j].kind, self.buildings[j].tier);
                let mut p = 0.28 * flj * (1.0 - d / 11.0) * (0.7 + 0.55 * align) * dt;
                if wells.iter().any(|w| (w.0 - self.buildings[j].x).powi(2) + (w.1 - self.buildings[j].y).powi(2) < 16.0 * 16.0) { p *= 0.5; }
                if self.rf() < p { ignite.push(j); }
            }
            if self.rf() < 0.012 { forest_spawn.push((bx, by)); }
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
            wf.r = (wf.r + (0.25 + dens * 0.9) * dt).min(16.0);
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
        let Some(mut b) = self.battle.take() else { return };
        let dt = SUBSTEP;
        b.t += dt;
        let n = b.units.len();
        let mut impacts: Vec<(f32, f32)> = vec![];
        let mut ignites: Vec<usize> = vec![];
        let mut dmg_b: Vec<(usize, f32)> = vec![];
        let mut shots: Vec<[f32; 7]> = vec![];
        let hero_mult = self.hero_dmg();   // the lord leads the defenders: they hit harder, and do not break so soon
        if b.rout.len() < n { b.rout.resize(n, 0.0); }
        // how many are left on each side: soldiers who see their side break lose heart
        let mut left = [0u32; 2]; for u in b.units.iter().filter(|u| u.alive) { left[u.side as usize] += 1; }
        let ratio = [left[0] as f32 / b.start_side[0].max(1) as f32, left[1] as f32 / b.start_side[1].max(1) as f32];
        // walls, fences and gates stop attackers; moats and rivers too unless bridged
        let bars: Vec<(usize, f32, f32, f32, u8)> = self.buildings.iter().enumerate().filter(|(_, x)| x.hp > 0.0 && matches!(x.kind, WALL | FENCE | GATE)).map(|(k, x)| (k, x.x, x.y, if x.kind == FENCE { 1.9 } else { 2.6 }, x.kind)).collect();
        let wet: Vec<(f32, f32, f32)> = self.buildings.iter().filter(|x| matches!(x.kind, MOAT | RIVER)).map(|x| (x.x, x.y, if x.kind == MOAT { 2.7 * moat_scale(x) } else { 2.7 })).collect();
        for si in 0..b.spots.len() { let busy = b.units.iter().any(|q| q.alive && q.climb > 0.0 && q.spot == si as i32); b.spots[si][3] = if busy { 1.0 } else { 0.0 }; }
        for i in 0..n {
            if !b.units[i].alive { continue; }
            let u = b.units[i].clone();
            let ud = &UNITS[u.kind as usize];
            // morale: a unit running away does not fight; once clear of the field it is gone (alive, but out of the battle)
            if b.rout[i] > 0.0 {
                b.rout[i] -= dt;
                let (mut best, mut bd) = (usize::MAX, f32::MAX);
                for j in 0..n { if b.units[j].alive && b.units[j].side != u.side { let d = (b.units[j].x - u.x).powi(2) + (b.units[j].y - u.y).powi(2); if d < bd { bd = d; best = j; } } }
                if best != usize::MAX { let d = bd.sqrt().max(0.1); b.units[i].x += (u.x - b.units[best].x) / d * ud.speed * 1.3 * dt; b.units[i].y += (u.y - b.units[best].y) / d * ud.speed * 1.3 * dt; b.units[i].face = (u.y - b.units[best].y).atan2(u.x - b.units[best].x); }
                if b.rout[i] <= 0.0 { b.units[i].alive = false; b.fled[u.side as usize] += 1; if u.side == 1 && (u.kind as usize) < 5 { b.fled_kinds[u.kind as usize] += 1; } }
                continue;
            }
            if u.kind != 4 && u.kind != 3 && !(u.held && u.pelev > 0.0) {
                let hpf = u.hp / ud.hp;
                let broken = if u.side == 1 { let limit = if b.tag == 0 { 0.6 } else { 0.45 }; (ratio[1] < limit && hpf < 0.5 && self.rf() < 0.03) || (ratio[1] < 0.3 && self.rf() < 0.02) } else { ratio[0] < if self.hero.is_some() { 0.15 } else { 0.3 } && hpf < 0.4 && self.rf() < 0.02 };
                if broken { b.rout[i] = 7.0; continue; }
            }
            b.units[i].cd = (u.cd - dt).max(0.0);
            b.units[i].anim = (b.units[i].anim - dt).max(0.0);
            if u.climb > 0.0 {   // up the ladder and over the wall
                b.units[i].climb -= dt;
                if b.units[i].climb <= 0.0 {
                    b.units[i].spot = -1;
                    let mut near: Option<(f32, f32, f32, f32)> = None;
                    for &(_, bx, by, r, _) in &bars { let d = ((u.x - bx).powi(2) + (u.y - by).powi(2)).sqrt(); if d < r + 2.5 && near.map_or(true, |q| d < q.3) { near = Some((bx, by, r, d)); } }
                    if let Some((bx, by, r, d)) = near { let (dx, dy) = ((bx - u.x) / d.max(0.1), (by - u.y) / d.max(0.1)); b.units[i].x = bx + dx * (r + 1.2); b.units[i].y = by + dy * (r + 1.2); }
                }
                continue;
            }
            // nearest enemy
            let (mut best, mut bd) = (usize::MAX, f32::MAX);
            for j in 0..n {
                if !b.units[j].alive || b.units[j].side == u.side { continue; }
                let d = (b.units[j].x - u.x).powi(2) + (b.units[j].y - u.y).powi(2);
                if d < bd { bd = d; best = j; }
            }
            let d_enemy = bd.sqrt();
            let siege = u.kind == 4;
            if u.held && u.pelev > 0.0 && !bars.iter().any(|q| (q.1 - u.hx).powi(2) + (q.2 - u.hy).powi(2) < 3.2 * 3.2) { b.units[i].pelev = 0.0; b.units[i].elev = 0.0; }   // the wall they stood on is gone
            let u = b.units[i].clone();
            if u.held && u.pelev > 0.0 { let (dx, dy) = (u.hx - u.x, u.hy - u.y); b.units[i].elev = if (dx * dx + dy * dy).sqrt() < 1.8 { u.pelev } else { 0.0 }; }
            let rng = ud.range * if b.units[i].elev > 0.0 { 1.25 } else { 1.0 };      // a wall gives height: archers on it shoot further
            let aggro = if u.side == 1 { 26.0 } else if u.held { rng.max(ud.range + 5.0) } else { 34.0 };
            let pinned = b.units[i].elev > 0.0 && d_enemy > rng;                       // on the wall: they do not leave it to chase
            // catapults on the defending side lob stones at whoever comes into range
            if siege && u.side == 0 {
                if best != usize::MAX && d_enemy <= ud.range && b.units[i].cd <= 0.0 {
                    let (tx, ty) = (b.units[best].x, b.units[best].y);
                    b.units[i].face = (ty - u.y).atan2(tx - u.x); b.units[i].cd = ud.cd; b.units[i].anim = 0.4;
                    shots.push([1.0, u.x, u.y, tx, ty, 0.0, u.kind as f32]);
                    if self.rf() < 0.7 { Self::damage_unit(&mut b, best, ud.dmg); for j in 0..n { if j != best && b.units[j].alive && b.units[j].side == 1 && (b.units[j].x - tx).powi(2) + (b.units[j].y - ty).powi(2) < 9.0 { Self::damage_unit(&mut b, j, 30.0); } } }
                }
                continue;
            }
            // attacking catapults keep their distance: they back away from anyone who gets close
            if siege && u.side == 1 && best != usize::MAX && d_enemy < 15.0 {
                let (mx, my) = ((u.x - b.units[best].x) / d_enemy.max(0.1), (u.y - b.units[best].y) / d_enemy.max(0.1));
                b.units[i].x += mx * ud.speed * dt; b.units[i].y += my * ud.speed * dt; b.units[i].face = (-my).atan2(-mx);
                continue;
            }
            let mut acted = false;
            if best != usize::MAX && !siege && d_enemy <= aggro && !pinned {
                let (tx, ty) = (b.units[best].x, b.units[best].y);
                if d_enemy <= rng {
                    b.units[i].face = (ty - u.y).atan2(tx - u.x);
                    if b.units[i].cd <= 0.0 {
                        let mult = if b.units[i].charge { 1.7 } else { 1.0 };
                        b.units[i].charge = false;
                        let hit = ud.range < 5.0 || self.rf() < 0.72;
                        if hit { Self::damage_unit(&mut b, best, ud.dmg * mult * if u.side == 0 { hero_mult } else { 1.0 }); }
                        b.units[i].cd = ud.cd; b.units[i].anim = 0.35;
                        if ud.range > 5.0 { shots.push([0.0, u.x, u.y, tx, ty, 0.0, u.kind as f32]); }
                    }
                } else {
                    let (mx, my) = ((tx - u.x) / d_enemy, (ty - u.y) / d_enemy);
                    if u.side == 1 {
                        if let Some(blk) = Self::attacker_step(&mut b, i, mx, my, ud.speed * dt, &bars, &wet) { self.on_block(&mut b, i, blk, &bars, &mut dmg_b, dt); }
                    } else { b.units[i].x += mx * ud.speed * dt; b.units[i].y += my * ud.speed * dt; b.units[i].face = my.atan2(mx); }
                }
                acted = true;
            }
            if acted { continue; }
            if u.side == 1 {
                // attackers go for the nearest building
                let mut tb = usize::MAX; let mut td = f32::MAX;
                for (k, bd2) in self.buildings.iter().enumerate() {
                    if bd2.hp <= 0.0 { continue; }
                    let d = (bd2.x - u.x).powi(2) + (bd2.y - u.y).powi(2);
                    if d < td { td = d; tb = k; }
                }
                if tb == usize::MAX { continue; }
                let (bx, by) = (self.buildings[tb].x, self.buildings[tb].y);
                let br = DEFS[self.buildings[tb].kind as usize].r;
                let d = td.sqrt();
                let reach = if siege { ud.range * 0.9 } else { ud.range.max(1.0) + br * 0.8 };   // catapults fire from a distance
                if d <= reach {
                    b.units[i].face = (by - u.y).atan2(bx - u.x);
                    if b.units[i].cd <= 0.0 {
                        let (mult, fire) = if siege { (3.2, 0.3) } else if ud.range > 5.0 { (0.25, 0.08) } else { (0.7, 0.05) };
                        dmg_b.push((tb, ud.dmg * mult));
                        let fl = flammability(self.buildings[tb].kind, self.buildings[tb].tier);
                        if self.rf() < fire * (0.4 + fl) { ignites.push(tb); }
                        b.units[i].cd = ud.cd; b.units[i].anim = 0.4;
                        if ud.range > 5.0 { shots.push([if siege { 1.0 } else { 0.0 }, u.x, u.y, bx, by, if self.rf() < 0.5 { 1.0 } else { 0.0 }, u.kind as f32]); }
                        if siege { impacts.push((bx + (self.rf() - 0.5) * 3.0, by + (self.rf() - 0.5) * 3.0)); }
                    }
                } else {
                    let (mx, my) = ((bx - u.x) / d, (by - u.y) / d);
                    if siege { b.units[i].x += mx * ud.speed * dt; b.units[i].y += my * ud.speed * dt; b.units[i].face = my.atan2(mx); }
                    else if let Some(blk) = Self::attacker_step(&mut b, i, mx, my, ud.speed * dt, &bars, &wet) { self.on_block(&mut b, i, blk, &bars, &mut dmg_b, dt); }
                }
            } else {
                // defenders drift back to their post
                let (dx, dy) = (u.hx - u.x, u.hy - u.y); let d = (dx * dx + dy * dy).sqrt();
                if d > 1.5 { let sp = ud.speed * dt * if u.held && d > 5.0 { 1.5 } else { 1.0 }; b.units[i].x += dx / d * sp; b.units[i].y += dy / d * sp; b.units[i].face = dy.atan2(dx); }
            }
        }
        // soft separation so units do not stack
        for i in 0..n {
            if !b.units[i].alive { continue; }
            for j in (i + 1)..n {
                if !b.units[j].alive { continue; }
                let (dx, dy) = (b.units[j].x - b.units[i].x, b.units[j].y - b.units[i].y);
                let d2 = dx * dx + dy * dy;
                if d2 < 0.8 && d2 > 0.0001 { let d = d2.sqrt(); let push = (0.9 - d) * 0.5; b.units[i].x -= dx / d * push; b.units[i].y -= dy / d * push; b.units[j].x += dx / d * push; b.units[j].y += dy / d * push; }
            }
        }
        for (k, d) in dmg_b { if k < self.buildings.len() { self.buildings[k].hp -= d; } }
        for k in ignites { self.ignite(k); }
        for (x, y) in impacts {
            self.crater(x, y, 2.4, 1.0);
            // splash
            for i in 0..b.units.len() { if b.units[i].alive && b.units[i].side == 0 && (b.units[i].x - x).powi(2) + (b.units[i].y - y).powi(2) < 9.0 { Self::damage_unit(&mut b, i, 35.0); } }
            if terrain::forest_near(self.seed, x, y, 4.0) > 0.2 { self.start_wildfire(x, y); }
        }
        self.shots.extend(shots);
        self.battle = Some(b);
        self.collect_destroyed();
        self.check_battle_end();
    }

    /// Move an attacker one step. Walls, fences and gates stop it (it may only move away from them); a moat or river stops it
    /// unless the attackers have bridged that spot. Returns what stopped it.
    fn attacker_step(b: &mut Battle, i: usize, mx: f32, my: f32, step: f32, bars: &[(usize, f32, f32, f32, u8)], wet: &[(f32, f32, f32)]) -> Option<Block> {
        let (ox, oy) = (b.units[i].x, b.units[i].y); let (nx, ny) = (ox + mx * step, oy + my * step);
        for (bi, &(_, bx, by, r, _)) in bars.iter().enumerate() {
            let (dn, d0) = (((nx - bx).powi(2) + (ny - by).powi(2)).sqrt(), ((ox - bx).powi(2) + (oy - by).powi(2)).sqrt());
            if dn < r + 0.6 && dn < d0 { b.units[i].face = (by - oy).atan2(bx - ox); return Some(Block::Bar(bi)); }
        }
        for &(wx, wy, wr) in wet {
            let (dn, d0) = (((nx - wx).powi(2) + (ny - wy).powi(2)).sqrt(), ((ox - wx).powi(2) + (oy - wy).powi(2)).sqrt());
            if dn < wr && dn < d0 && !b.bridges.iter().any(|g| (g[0] - nx).powi(2) + (g[1] - ny).powi(2) < 3.4 * 3.4) { b.units[i].face = my.atan2(mx); return Some(Block::Wet); }
        }
        b.units[i].x = nx; b.units[i].y = ny; b.units[i].face = my.atan2(mx);
        None
    }

    /// What an attacker does when something stops it: climb with a ladder, hack at the wall, or work on a bridge over the water.
    fn on_block(&self, b: &mut Battle, i: usize, blk: Block, bars: &[(usize, f32, f32, f32, u8)], dmg_b: &mut Vec<(usize, f32)>, dt: f32) {
        let kind = b.units[i].kind; let ud = &UNITS[kind as usize];
        match blk {
            Block::Bar(bi) => {
                let (k, bx, by, r, bk) = bars[bi];
                let ang = (b.units[i].y - by).atan2(b.units[i].x - bx);
                if matches!(kind, 0 | 2) {   // spearmen and swordsmen climb
                    if bk == FENCE { b.units[i].climb = 1.2; return; }
                    let secs = 3.0 + 1.5 * self.buildings[k].tier as f32;
                    if let Some(si) = b.spots.iter().position(|s| (s[0] - bx).powi(2) + (s[1] - by).powi(2) < 3.3 * 3.3 && s[3] == 0.0) { b.spots[si][3] = 1.0; b.units[i].spot = si as i32; b.units[i].climb = secs; return; }
                    if b.ladders_used < b.ladders { b.ladders_used += 1; b.spots.push([bx + ang.cos() * (r + 0.4), by + ang.sin() * (r + 0.4), ang, 0.0]); return; }
                }
                if b.units[i].cd <= 0.0 {   // no ladder to use: break the wall down
                    let mult = if ud.range > 5.0 { 0.25 } else { 0.7 };
                    dmg_b.push((k, ud.dmg * mult)); b.units[i].cd = ud.cd; b.units[i].anim = 0.4;
                }
            }
            Block::Wet => {
                if !matches!(kind, 0 | 1 | 2 | 3) { return; }   // the men with spades and planks; archers help at half speed
                let (x, y, face) = (b.units[i].x, b.units[i].y, b.units[i].face);
                let si = match b.sites.iter().position(|s| (s[0] - x).powi(2) + (s[1] - y).powi(2) < 4.5 * 4.5) { Some(si) => si, None => { b.sites.push([x, y, face, 0.0]); b.sites.len() - 1 } };
                b.sites[si][3] += if kind == 1 { dt * 0.5 } else { dt }; b.units[i].anim = 0.3;
                if b.sites[si][3] >= 8.0 { let s = b.sites.remove(si); b.bridges.push([s[0] + face.cos() * 1.5, s[1] + face.sin() * 1.5, s[2]]); }
            }
        }
    }

    fn check_battle_end(&mut self) {
        let Some(b) = self.battle.as_mut() else { return };
        let atk = b.units.iter().filter(|u| u.side == 1 && u.alive).count();
        let def = b.units.iter().filter(|u| u.side == 0 && u.alive).count();
        if def == 0 && atk > 0 { b.pillage += SUBSTEP; }
        let done = atk == 0 || b.pillage > 14.0 || b.t > 170.0;
        if done { self.finish_battle(); }
    }

    fn finish_battle(&mut self) {
        let Some(b) = self.battle.take() else { return };
        let atk_alive = b.units.iter().filter(|u| u.side == 1 && u.alive).count() as u32;
        let won = atk_alive == 0 || b.pillage <= 0.0;   // holding out until the time limit is a defence, not a defeat
        // the standing army loses the soldiers that fell (anything added during the fight, such as new recruits, stays)
        let mut fell = [0u32; 5];
        for u in b.units.iter().filter(|u| u.side == 0 && u.from_army && !u.alive && (u.kind as usize) < 5) { fell[u.kind as usize] += 1; }
        for k in 0..5 { self.army[k] = self.army[k].saturating_sub(fell[k]); }
        // archers who fell in a tower are gone from its garrison
        for t in self.buildings.iter_mut().filter(|t| matches!(t.kind, TOWER | KEEP)) {
            let alive = b.units.iter().filter(|u| u.side == 0 && u.kind == 1 && !u.from_army && u.alive && (u.hx - t.x).abs() < 0.01 && (u.hy - t.y).abs() < 0.01).count() as u8;
            t.garrison = t.garrison.min(alive);
        }
        self.population = self.population.saturating_sub(b.militia_dead);
        let mut surv = [0u32; 5];
        for u in b.units.iter().filter(|u| u.side == 1 && u.alive) { surv[u.kind as usize] += 1; }
        for k in 0..5 { surv[k] += b.fled_kinds[k]; }   // the ones who ran off come home too
        // loot: raiders that pillaged take a share of the stores
        let mut loot = [0i32; N_RES];
        if !won && b.pillage > 0.0 {
            for r in 0..N_RES { let pct = if r == GD as usize { 35 } else { 15 }; let take = self.stock[r] * pct / 100; self.stock[r] -= take; loot[r] = take; }
        }
        self.report_seq += 1;
        self.report = vec![self.report_seq as i32, won as i32, b.tag, atk_alive as i32, b.def_dead as i32, b.bld_lost as i32];
        self.report.extend(surv.iter().map(|&x| x as i32));
        self.report.extend(loot.iter());
        self.report.extend([b.fled[1] as i32, b.fled[0] as i32]);   // attackers and defenders who ran away
        let ev = if won { EV_REPELLED } else { EV_RAID };
        self.push_event(ev, loot[GD as usize], b.def_dead as i32);
        // the lord learns from a defence, and may fall in a defeat
        if let Some((name, xp)) = self.hero {
            if won { let gain = 10 + b.atk_dead.min(40); let before = Self::hero_level(xp); let now = xp + gain; self.hero = Some((name, now)); if Self::hero_level(now) > before { self.push_event(EV_HERO, name as i32, Self::hero_level(now) as i32); } }
            else if self.rf() < 0.3 { self.hero = None; self.push_event(EV_HERO, name as i32, -1); }
        }
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

    fn can_afford(&self, c: &[Amount]) -> bool { c.iter().all(|&(r, n)| self.stock[r as usize] >= n) }
    fn pay(&mut self, c: &[Amount]) { for &(r, n) in c { self.stock[r as usize] -= n; } }

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

    /// Rebuild a ruin where it stood. 0 ok, -1 invalid, -3 something else was built there, -6 cannot afford.
    pub(crate) fn do_rebuild(&mut self, ri: usize) -> i32 {
        let Some(r) = self.ruins.get(ri).copied() else { return -1 };
        let (x, y, kind, tier, rot) = (r[0], r[1], r[3] as u8, r[4] as u8, r[5] as u8);
        let d = &DEFS[kind as usize];
        for b in &self.buildings { let bd = &DEFS[b.kind as usize]; if (b.x - x).powi(2) + (b.y - y).powi(2) < (bd.r + d.r - 0.4).powi(2) { return -3; } }
        let cost = Self::rebuild_cost(kind, tier);
        if !self.can_afford(&cost) { return -6; }
        self.pay(&cost);
        self.ruins.remove(ri);
        let fr = d.r * 0.8;
        let pad_h = [(0.0, 0.0), (fr, 0.0), (-fr, 0.0), (0.0, fr), (0.0, -fr)].iter().map(|(px, py)| self.height_at(x + px, y + py)).sum::<f32>() / 5.0;
        let aux = if d.req == 1 { self.nearest_deposit(x, y, d.req_arg).map_or(-1, |i| i as i32) } else { -1 };
        self.buildings.push(Building { kind, tier, x, y, rot, pad_h, progress: 0, status: if d.cycle > 0 { 1 } else { 4 }, aux, staff: 0, residents: 0, hp: max_hp(kind, tier), burning: 0.0, garrison: 0, born: self.tick as u32, opts: 0 });
        self.terrain_ver += 1;
        self.after_change();
        self.push_event(EV_REBUILT, kind as i32, 0);
        0
    }

    /// Builders' yards send carpenters and masons to mend damaged buildings and raise ruins again, as materials allow.
    pub(crate) fn builders_step(&mut self) {
        let lodges: Vec<usize> = (0..self.buildings.len()).filter(|&i| self.buildings[i].kind == BUILDERS && self.buildings[i].staff > 0).collect();
        for li in lodges {
            if li >= self.buildings.len() { continue; }
            let (lx, ly, tier) = (self.buildings[li].x, self.buildings[li].y, self.buildings[li].tier);
            let need = 700u32;
            self.buildings[li].progress += self.eff * (100 + 60 * tier as u32) / 100;
            if self.buildings[li].progress < need { continue; }
            // 1. the most damaged building that is not on fire
            let mut best: Option<(usize, f32)> = None;
            for (i, b) in self.buildings.iter().enumerate() {
                if i == li || b.burning > 0.0 || b.hp <= 0.0 { continue; }
                let frac = b.hp / max_hp(b.kind, b.tier);
                if frac >= 0.95 || ((b.x - lx).powi(2) + (b.y - ly).powi(2)).sqrt() > 70.0 { continue; }
                if best.map_or(true, |(_, f)| frac < f) { best = Some((i, frac)); }
            }
            if let Some((i, _)) = best {
                let (kind, t, max) = (self.buildings[i].kind, self.buildings[i].tier, max_hp(self.buildings[i].kind, self.buildings[i].tier));
                let heal = (0.4f32).min(1.0 - self.buildings[i].hp / max);
                let cost = Self::repair_cost_frac(kind, t, heal);
                if self.can_afford(&cost) {
                    self.pay(&cost); self.buildings[i].hp = (self.buildings[i].hp + heal * max).min(max);
                    if self.buildings[i].hp >= max - 0.5 { self.push_event(EV_REPAIRED, kind as i32, 0); }
                    self.buildings[li].progress -= need; self.buildings[li].status = 0;
                } else { self.buildings[li].progress = need; self.buildings[li].status = 1; }
                continue;
            }
            // 2. the nearest ruin
            let mut near: Option<(usize, f32)> = None;
            for (ri, r) in self.ruins.iter().enumerate() { let d = ((r[0] - lx).powi(2) + (r[1] - ly).powi(2)).sqrt(); if d <= 70.0 && near.map_or(true, |(_, bd)| d < bd) { near = Some((ri, d)); } }
            if let Some((ri, _)) = near {
                let r = self.ruins[ri];
                let cost = Self::rebuild_cost(r[3] as u8, r[4] as u8);
                if self.can_afford(&cost) {
                    let code = self.do_rebuild(ri);
                    if code == 0 { self.buildings[li].progress = self.buildings[li].progress.saturating_sub(need); self.buildings[li].status = 0; } else { self.buildings[li].progress = need; self.buildings[li].status = 1; }
                } else { self.buildings[li].progress = need; self.buildings[li].status = 1; }
                continue;
            }
            self.buildings[li].progress = need; self.buildings[li].status = 4;      // nothing to mend
        }
    }

    /// Spend resources to queue units at the barracks.
    pub(crate) fn try_train(&mut self, kind: u8, n: u32) -> i32 {
        if kind as usize >= 5 || n == 0 || n > 1000 { return -1; }
        let u = &UNITS[kind as usize];
        let best_tier = self.buildings.iter().filter(|b| b.kind == BARRACKS).map(|b| b.tier as i32).max();
        let Some(bt) = best_tier else { return -11 }; // no barracks
        if (bt as u8) < u.tier { return -12; }          // barracks too basic
        if self.population < n.saturating_add(3) { return -13; }
        for &(r, c) in u.cost { if (self.stock[r as usize] as i64) < c as i64 * n as i64 { return -6; } }
        for &(r, c) in u.cost { self.stock[r as usize] -= c * n as i32; }
        self.population -= n;
        self.queue[kind as usize] += n;
        0
    }

    /// Barracks turn queued recruits into soldiers.
    pub(crate) fn training_step(&mut self) {
        let effort: u32 = self.buildings.iter().filter(|b| b.kind == BARRACKS && b.staff > 0).map(|b| b.tier as u32 + 1).sum();
        if effort == 0 { return; }
        let Some(k) = (0..5).find(|&k| self.queue[k] > 0) else { self.train_prog = 0; return };
        self.train_prog += effort;
        if self.train_prog >= UNITS[k].time {
            self.train_prog -= UNITS[k].time;
            self.queue[k] -= 1; self.army[k] += 1;
            self.push_event(EV_TRAINED, k as i32, 0);
        }
    }
}

//! Rules of combat: walls, ladders, wading, fire, field armies joining a defence, retreat, and the roads of siege engines.
use super::*;

pub(crate) fn put_t(w: &mut World, kind: u8, tier: u8, x: f32, y: f32) {
    let pad_h = w.base(x, y);
    w.buildings.push(Building { kind, tier, x, y, rot: 0, pad_h, progress: 0, status: 4, aux: -1, staff: 0, residents: 0, hp: battle::max_hp(kind, tier), burning: 0.0, garrison: 0, born: 0, opts: 0, fert: FERT_MAX, mode: 0, target: -1, beff: 100 });
}
/// A wall across the east side of the village (x = 24), `tier` 0 timber / 2 stone, pieces overlapping so nobody slips through.
pub(crate) fn east_wall(tier: u8) -> World {
    let mut w = World::new(1337, 0, 0);
    w.stock = [3000; N_RES]; w.population = 12;
    let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
    for k in -9..=9 { put_t(&mut w, WALL, tier, hx + 24.0, hy + k as f32 * 3.0); }
    w
}
pub(crate) fn wall_hp(w: &World) -> f32 { w.buildings.iter().filter(|b| b.kind == WALL).map(|b| b.hp).sum() }
pub(crate) fn run(w: &mut World, secs: u32) { for _ in 0..secs { w.step(); w.stock[GR as usize] = 3000; if !w.battle_active() { break; } } }

#[test]
fn stone_walls_are_immune_to_infantry_but_timber_walls_are_not() {
    for (tier, stone) in [(2u8, true), (0u8, false)] {
        let mut w = east_wall(tier);
        let full = wall_hp(&w);
        // knights and archers cannot climb, so a ladder is no help to them: all they can do to the wall is hit it
        assert!(w.begin_battle([0, 6, 0, 8, 0, 0], 0.0, 0));
        run(&mut w, 90);
        let lost = full - wall_hp(&w);
        eprintln!("tier {tier}: wall lost {lost:.0} of {full:.0}");
        if stone { assert_eq!(lost, 0.0, "infantry cannot hurt a stone wall"); } else { assert!(lost > 100.0, "knights hack through a timber wall: lost {lost}"); }
    }
}

#[test]
fn stone_walls_fall_to_catapults() {
    let mut w = east_wall(2);
    let full = wall_hp(&w);
    assert!(w.begin_battle([0, 0, 0, 0, 3, 0], 0.0, 0));
    run(&mut w, 120);
    assert!(full - wall_hp(&w) > 150.0 || w.buildings.iter().filter(|b| b.kind == WALL).count() < 19, "catapults batter stone: lost {}", full - wall_hp(&w));
}

#[test]
fn foot_soldiers_need_ladders_to_cross_a_stone_wall() {
    let inside = |w: &World| { let (hx, hy) = (w.buildings[0].x, w.buildings[0].y); w.battle.as_ref().map_or(0, |b| b.units.iter().filter(|u| u.side == 1 && u.alive && u.x < hx + 21.0 && (u.y - hy).abs() < 30.0).count()) };
    // no ladders: nobody gets over in two minutes
    let mut w = east_wall(2);
    assert!(w.begin_battle([10, 0, 6, 0, 0, 0], 0.0, 0));
    { let b = w.battle.as_mut().unwrap(); b.ladders = 0; b.siege = Default::default(); }   // (no towers and no saps either)
    let full = wall_hp(&w);
    let mut got_in = 0; for _ in 0..120 { w.step(); w.stock[GR as usize] = 3000; got_in = got_in.max(inside(&w)); if !w.battle_active() { break; } }
    assert_eq!(got_in, 0, "without ladders nobody crosses a stone wall");
    assert_eq!(wall_hp(&w), full, "and the wall is untouched");
    // with their ladders (the usual one for every four) some do
    let mut w = east_wall(2);
    assert!(w.begin_battle([10, 0, 6, 0, 0, 0], 0.0, 0));
    assert!(w.battle.as_ref().unwrap().ladders >= 3);
    let mut got_in = 0; let mut used = 0; for _ in 0..120 { w.step(); w.stock[GR as usize] = 3000; got_in = got_in.max(inside(&w)); if let Some(b) = &w.battle { used = used.max(b.ladders_used); } if !w.battle_active() { break; } }
    eprintln!("with ladders: {got_in} got in, {used} ladders used");
    assert!(used > 0 && got_in > 0, "with ladders they climb over");
}

#[test]
fn raiders_in_water_are_slower_weaker_and_easier_to_hit_than_before() {
    assert!(battle::WADE_SPEED <= 0.15 && battle::WADE_KNIGHT < battle::WADE_SPEED && battle::WADE_DAMAGE >= 3.0 && battle::WADE_HIT > battle::HIT_CHANCE, "the handicap is raised");
    let mut w = World::new(1337, 0, 0); w.population = 20;
    assert!(w.begin_battle([2, 0, 0, 3, 0, 0], 0.0, 0));
    let b = w.battle.as_mut().unwrap();
    let sp = b.units.iter().position(|u| u.side == 1 && u.kind == 0).unwrap();
    let kn = b.units.iter().position(|u| u.side == 1 && u.kind == 3).unwrap();
    let step = |b: &mut Battle, i: usize| { let (x0, y0) = (b.units[i].x, b.units[i].y); World::attacker_step(b, i, -1.0, 0.0, 1.0, &[], &[], 1337, &mut Vec::new()); ((b.units[i].x - x0).powi(2) + (b.units[i].y - y0).powi(2)).sqrt() };
    let dry = step(b, sp);
    b.units[sp].wading = true; let wade = step(b, sp);
    b.units[kn].wading = true; let wade_knight = step(b, kn);
    b.units[sp].wading = false; b.units[sp].soak = battle::SOAK_SECS; let soaked = step(b, sp);
    eprintln!("per unit of step: dry {dry:.2}, wading {wade:.2}, wading knight {wade_knight:.2}, just out of the water {soaked:.2}");
    assert!((dry - 1.0).abs() < 1e-3);
    assert!(wade < 0.2 && wade_knight < wade && soaked < dry && soaked > wade, "wading crawl, knights worse, sodden men slower than dry ones");
}

#[test]
fn a_raider_coming_out_of_the_water_is_sodden_for_a_while() {
    let mut w = World::new(1337, 0, 0); w.population = 20;
    assert!(w.begin_battle([1, 0, 0, 0, 0, 0], 0.0, 0));
    let b = w.battle.as_mut().unwrap();
    let i = b.units.iter().position(|u| u.side == 1).unwrap();
    b.units[i].wading = true;   // (no water in the way: the next step finds dry land)
    World::attacker_step(b, i, -1.0, 0.0, 1.0, &[], &[], 1337, &mut Vec::new());
    assert!(!b.units[i].wading && b.units[i].soak > 4.0, "out of the water and dripping");
}

#[test]
fn raider_archers_and_catapults_finish_a_moat_crossing_with_defenders_in_range() {
    for kind in [1, 4] {
        let mut w = World::new(1337, 0, 0);
        assert_eq!(w.flatten(45, 5.0), 0);
        for y in [-4.0, 0.0, 4.0] { put_t(&mut w, MOAT, 0, 24.0, y); }
        w.after_change();
        assert!(w.begin_battle([1, 0, 0, 0, 0, 0], 0.0, 41));
        let b = w.battle.as_mut().unwrap();
        let mut raider = Unit::new(1, kind, 26.0, 0.0, std::f32::consts::PI);
        raider.wading = true;
        let mut target = Unit::new(0, 4, 13.0, 0.0, 0.0);
        target.cd = 1000.0;
        b.units = vec![raider, target];
        b.start_side = [1, 1];
        assert!(w.battle_order(41, 4, tactics::HOLD, 26.0, 0.0));
        for _ in 0..140 {
            w.battle_substep();
            if !w.battle.as_ref().unwrap().units[0].wading { break; }
        }
        let raider = &w.battle.as_ref().unwrap().units[0];
        assert!(raider.x < 20.0 && !raider.wading && raider.soak > 0.0, "kind {kind} stuck on raft at {}", raider.x);
        assert!(!w.shots.iter().any(|s| s[6] == kind as f32));
    }
}

#[test]
fn fire_does_little_to_stone_and_wells_and_builders_help() {
    // hit points lost by a burning timber house over `secs` seconds
    let burn = |setup: &dyn Fn(&mut World), secs: u32| -> f32 {
        let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; w.population = 36;
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        for k in 0..4 { put_t(&mut w, HOUSE, 0, hx + 14.0 + k as f32 * 6.0, hy + 20.0); }
        setup(&mut w);
        let hp0 = w.buildings[1].hp;
        w.set_fire(1);
        for _ in 0..secs { w.step(); w.stock[GR as usize] = 3000; w.population = 36; if w.buildings.len() < 2 || w.buildings[1].kind != HOUSE { return hp0; } }
        hp0 - w.buildings[1].hp
    };
    let lost10 = burn(&|_| {}, 10);
    assert!(lost10 < 100.0, "a burning thatched house is not gone in ten seconds: lost {lost10}");
    let bare = burn(&|_| {}, 30);
    let with_well = burn(&|w| { let (hx, hy) = (w.buildings[0].x, w.buildings[0].y); put_t(w, WELL, 0, hx + 18.0, hy + 14.0); }, 30);
    let with_builders = burn(&|w| { let (hx, hy) = (w.buildings[0].x, w.buildings[0].y); put_t(w, BUILDERS, 0, hx + 30.0, hy + 8.0); let n = w.buildings.len() - 1; w.buildings[n].staff = 3; }, 30);
    eprintln!("hp lost in 30 s: bare {bare:.0}, with a well {with_well:.0}, with builders {with_builders:.0}");
    assert!(with_well < bare * 0.85, "a well makes a real difference even without anyone told to man it");
    assert!(with_builders < bare, "builders help against fire");
    // stone does not burn: walls never catch, stone houses barely suffer
    let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES];
    put_t(&mut w, WALL, 2, 20.0, 0.0); put_t(&mut w, HOUSE, 2, 30.0, 0.0);
    w.set_fire(1); assert_eq!(w.buildings[1].burning, 0.0, "a stone wall cannot be set alight");
    w.set_fire(2); let hp0 = w.buildings[2].hp;
    for _ in 0..30 { w.step(); }
    assert!(w.buildings[2].hp > hp0 * 0.85, "a stone house loses little: {} of {hp0}", w.buildings[2].hp);
}

#[test]
fn fire_takes_longer_to_jump_between_houses() {
    // over many tries the fire reaches the neighbour 7 units off in only a fraction of ten seconds
    let mut jumped = 0;
    for seed in 0..40u64 {
        let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; w.rng = Rng(seed + 5);
        let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
        put_t(&mut w, HOUSE, 0, hx + 20.0, hy + 20.0); put_t(&mut w, HOUSE, 0, hx + 27.0, hy + 20.0);
        w.set_fire(1);
        for _ in 0..10 { w.step(); }
        if w.buildings.len() > 2 && w.buildings[2].burning > 0.0 { jumped += 1; }
    }
    eprintln!("jumped in {jumped}/40 runs");
    assert!(jumped < 20, "a spark does not usually leap at once: {jumped}/40");
}

fn weak_village() -> World { let mut w = World::new(1337, 0, 0); w.stock = [3000; N_RES]; w.population = 20; for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 17, 4), (HOUSE, 22, 4), (HOUSE, -12, 6), (TOWER, 0, 16)] { w.place(k, x, y, 0); } w }

#[test]
fn own_troops_can_march_out_and_join_a_defence() {
    let run_it = |send: bool| -> (u64, Vec<i32>, usize, bool) {
        let mut w = weak_village();
        let id = if send { w.army = [14, 8, 6, 0, 0, 0]; w.det_form(&[14, 8, 6, 0, 0, 0]) } else { 0 };
        assert_eq!(send, id > 0);
        assert!(w.start_raid(0.0, &[14, 6, 3, 0, 0, 0], 0));
        let mut joined = false; let mut fought = 0usize;
        if send { assert_eq!(w.det_defend(id), 0, "ordered to the fight"); }
        for _ in 0..400 {
            w.step(); w.stock[GR as usize] = 3000;
            if let Some(b) = &w.battle { let n = b.units.iter().filter(|u| id > 0 && u.det == id).count(); fought = fought.max(n); if send && w.det_flat()[8] as u8 == march::S_FIGHT { joined = true; } } else { break; }
        }
        (w.state_hash(), w.last_report(), fought, joined)
    };
    let (h1, alone, _, _) = run_it(false);
    assert_eq!(alone[1], 0, "the village alone loses: {alone:?}");
    let (h2, helped, fought, joined) = run_it(true);
    eprintln!("with an army: {helped:?}, {fought} of its men fought");
    assert!(joined && fought == 28, "the army marched to the fight and its soldiers joined the defenders");
    assert_eq!(helped[1], 1, "with its own troops the village holds: {helped:?}");
    assert_ne!(h1, h2);
    // deterministic: every peer replaying the same commands reaches the same state
    let (h3, helped3, _, _) = run_it(true);
    assert_eq!((h2, &helped), (h3, &helped3));
}

#[test]
fn the_army_comes_out_of_the_fight_with_its_survivors_and_can_leave_early() {
    let mut w = weak_village(); w.army = [10, 4, 4, 0, 0, 0];
    let id = w.det_form(&[10, 4, 4, 0, 0, 0]);
    assert!(w.start_raid(0.0, &[10, 4, 2, 0, 0, 0], 0));
    assert_eq!(w.det_defend(id), 0);
    let mut seen_fight = false;
    for _ in 0..300 { w.step(); w.stock[GR as usize] = 3000; if w.det_flat().len() >= 16 && w.det_flat()[8] as u8 == march::S_FIGHT { seen_fight = true; } if !w.battle_active() { break; } }
    assert!(seen_fight && !w.battle_active());
    let f = w.det_flat();
    assert!(f.len() == 17, "the army is still in the field afterwards (one record of 17 numbers): {}", f.len());
    let left: u32 = f[3..8].iter().map(|&v| v as u32).sum();
    assert!(left > 0 && left <= 18 && f[8] as u8 == march::S_IDLE, "survivors idle in the field: {left}");
    // an army that is told to go home in the middle of a fight leaves it
    let mut w = weak_village(); w.army = [10, 4, 4, 0, 0, 0];
    let id = w.det_form(&[10, 4, 4, 0, 0, 0]);
    assert!(w.start_raid(0.0, &[10, 4, 2, 0, 0, 0], 0));
    w.det_defend(id);
    for _ in 0..60 { w.step(); w.stock[GR as usize] = 3000; if w.det_flat()[8] as u8 == march::S_FIGHT { break; } }
    assert_eq!(w.det_flat()[8] as u8, march::S_FIGHT);
    let n0 = w.battle.as_ref().unwrap().units.iter().filter(|u| u.det == id).count();
    assert!(n0 > 0);
    assert_eq!(w.det_recall(id), 0);
    assert_eq!(w.battle.as_ref().map_or(0, |b| b.units.iter().filter(|u| u.det == id).count()), 0, "its soldiers left the battle");
    assert_eq!(w.det_flat()[8] as u8, march::S_HOME);
}

#[test]
fn a_field_army_can_be_sent_home_to_a_castle() {
    let mut w = weak_village(); w.army = [10, 4, 4, 0, 0, 0];
    w.buildings[0].tier = 3; w.after_change();
    let id = w.det_form(&[10, 4, 4, 0, 0, 0]);
    assert!(id > 0);
    assert_eq!(w.det_recall(id), 0, "the way home ends at the castle gate, not inside the fortress");
    assert_eq!(w.det_flat()[8] as u8, march::S_HOME);
}

#[test]
fn the_standing_army_can_be_sent_out_to_meet_the_raiders() {
    let mut w = weak_village(); w.army = [10, 4, 0, 0, 0, 0];
    assert!(w.start_raid(0.0, &[6, 2, 0, 0, 0, 0], 0));
    assert_eq!(w.battle_standing(), vec![10, 4, 0, 0, 0, 0]);
    assert_eq!(w.det_form(&[11, 0, 0, 0, 0, 0]), 0, "more than stand in the fight cannot be sent");
    let id = w.det_form(&[10, 0, 0, 0, 0, 0]); assert!(id > 0);
    assert_eq!(w.battle_standing(), vec![0, 4, 0, 0, 0, 0], "they left their posts");
    assert_eq!(w.army, [0, 4, 0, 0, 0, 0]);
    assert_eq!(w.det_defend(id), 0);
    run(&mut w, 300);
    assert!(!w.battle_active());
    let alive: u32 = w.det_flat()[3..8].iter().map(|&v| v as u32).sum::<u32>() + w.army.iter().sum::<u32>();
    assert!(alive > 0 && alive <= 14);
}

#[test]
fn the_attacker_can_retreat_and_reinforce() {
    let mut w = weak_village();
    assert!(w.start_raid(0.0, &[10, 4, 0, 0, 0, 0], 7));
    assert!(!w.battle_retreat(8), "only the attacker's own call counts");
    assert!(!w.battle_reinforce(8, &[1, 0, 0, 0, 0, 0]));
    let n0 = w.battle.as_ref().unwrap().units.len();
    assert!(w.battle_reinforce(7, &[4, 0, 0, 0, 0, 0]));
    assert_eq!(w.battle.as_ref().unwrap().units.len(), n0 + 4);
    for _ in 0..4 { w.step(); }
    assert!(w.battle_retreat(7));
    for _ in 0..40 { w.step(); w.stock[GR as usize] = 3000; if !w.battle_active() { break; } }
    assert!(!w.battle_active(), "the battle ends once the attackers have run");
    let r = w.last_report();
    eprintln!("{r:?}");
    let survivors: i32 = r[6..11].iter().sum();
    assert!(survivors >= 10, "most of them got away: {survivors}");
    assert_eq!(r[1], 1, "the village counts it a win");
}

#[test]
fn a_catapult_never_crosses_cliffs_water_or_buildings_on_a_long_march() {
    let seed = 1337u64;
    let mut checked = 0;
    for (tx, ty) in [(120.0f32, 10.0f32), (-110.0, 40.0), (20.0, 130.0), (30.0, -120.0), (260.0, -60.0), (-250.0, 120.0), (150.0, 220.0), (-180.0, -230.0)] {
        let mut w = World::new(seed, 0, 0); w.stock = [3000; N_RES]; w.population = 30;
        for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 17, 4), (BARRACKS, 30, 20), (HOUSE, -12, 6)] { w.place(k, x, y, 0); }
        w.army = [6, 0, 4, 0, 3, 0];
        let id = w.det_form(&[6, 0, 4, 0, 3, 0]); assert!(id > 0);
        let r = w.det_march(id, tx, ty, false, 0.0, 0.0);
        if r != 0 { eprintln!("march to ({tx},{ty}): code {r}, skipped"); continue; }
        let mut arrived = false;
        for _ in 0..4000 {
            w.step(); w.stock[GR as usize] = 3000; w.stock[W as usize] = 3000; w.stock[PL as usize] = 3000;
            let f = w.det_flat(); let (x, y) = (f[1], f[2]);
            // not water (unless a bridge carries it), not a cliff, not inside a building
            let h = w.height_at(x, y);
            let on_bridge = w.on_deck(x, y) || w.bridges_flat().chunks(4).any(|b| { let (dx, dy) = (b[2] - b[0], b[3] - b[1]); let l2 = (dx * dx + dy * dy).max(1e-6); let t = (((x - b[0]) * dx + (y - b[1]) * dy) / l2).clamp(0.0, 1.0); (x - (b[0] + dx * t)).hypot(y - (b[1] + dy * t)) < 2.5 });
            let ferrying = f[8] as u8 == march::S_FERRY || f[8] as u8 == march::S_BRIDGE;
            if !on_bridge && !ferrying { assert!(h > 0.1, "catapult in water at ({x:.1},{y:.1}) h {h}"); }
            let slope = [(2.5f32, 0.0f32), (-2.5, 0.0), (0.0, 2.5), (0.0, -2.5)].iter().map(|(dx, dy)| (w.height_at(x + dx, y + dy) - h).abs() / 2.5).fold(0.0, f32::max);
            if !ferrying { assert!(slope < 1.1, "catapult on a cliff at ({x:.1},{y:.1}) slope {slope}"); }
            for b in &w.buildings { if matches!(b.kind, ROAD | BRIDGE | MOAT | RIVER | RAISE | LOWER | GATE | DRAWBRIDGE) { continue; } assert!((b.x - x).hypot(b.y - y) > solid_radius(b.kind, b.tier) * 0.8, "catapult inside a building {} at ({x:.1},{y:.1})", b.kind); }
            checked += 1;
            if f[8] as u8 == march::S_IDLE { arrived = true; break; }
        }
        eprintln!("march to ({tx},{ty}) done, arrived {arrived}");
    }
    assert!(checked > 100, "enough of a march was checked: {checked}");
}

#[test]
fn a_replica_replaying_the_commands_sees_the_same_battle_hash_for_hash() {
    // the defender's live village, and a peer's copy that only replays the signed commands at their ticks (raid, muster, defend, retreat)
    let setup = || { let mut w = weak_village(); w.army = [14, 8, 6, 0, 0, 0]; w };
    let cmds: Vec<(u64, u8)> = vec![(30, 0), (31, 1), (33, 2), (120, 3)];   // raid, form, defend, attacker calls the retreat
    let drive = |w: &mut World, upto: u64, log: &mut Vec<u64>| {
        let mut det = 0u32;
        while w.tick() < upto {
            for &(t, c) in &cmds { if t == w.tick() {
                match c { 0 => { assert!(w.start_raid(0.0, &[14, 6, 3, 0, 0, 0], 9)); } 1 => { det = w.det_form(&[14, 8, 6, 0, 0, 0]); assert!(det > 0); } 2 => { assert_eq!(w.det_defend(1), 0); } _ => { w.battle_retreat(9); } }
            } }
            let _ = det;
            w.step(); w.stock[GR as usize] = 3000;
            if w.tick() % 10 == 0 { log.push(w.state_hash()); }
        }
    };
    let (mut a, mut b) = (setup(), setup()); let (mut la, mut lb) = (vec![], vec![]);
    drive(&mut a, 260, &mut la); drive(&mut b, 260, &mut lb);
    assert_eq!(la, lb, "every peer's copy of the village stays in step");
    assert!(la.len() >= 20 && !a.battle_active());
}

#[test]
fn a_ram_splinters_a_gatehouse_door_that_infantry_cannot_touch() {
    let gate_hp = |w: &World| w.buildings.iter().find(|b| b.kind == GATE).map_or(0.0, |b| b.hp);
    let build = || { let mut w = east_wall(2); let (hx, hy) = (w.buildings[0].x, w.buildings[0].y); put_t(&mut w, GATE, 2, hx + 24.0, hy + 40.0); w };
    // knights and archers cannot hurt a stone door
    let mut w = build(); let full = gate_hp(&w);
    // (the gate stands past the end of the wall: put it where the attackers come from)
    assert!(w.begin_battle([0, 4, 0, 6, 0, 0], std::f32::consts::FRAC_PI_2 * 0.0, 0));
    run(&mut w, 90);
    assert_eq!(gate_hp(&w), full, "infantry leave a stone gate alone");
    // rams go for the door
    let mut w = build(); let full = gate_hp(&w);
    assert!(w.begin_battle([0, 0, 0, 0, 0, 3], 0.0, 0));
    run(&mut w, 150);
    let left = gate_hp(&w);
    eprintln!("gate hp {full:.0} -> {left:.0}");
    assert!(left < full * 0.5, "three rams smash a stone gate: {left} of {full}");
}

#[test]
fn rams_are_trained_in_a_good_barracks_and_listed_with_the_other_soldiers() {
    let mut w = weak_village(); w.population = 50;
    assert_eq!(w.train(5, 1), -11, "no barracks yet");
    let spot = (-40..=40).step_by(3).flat_map(|x| (-40..=40).step_by(3).map(move |y| (x, y))).find(|&(x, y)| w.can_place(BARRACKS, x, y) == 0).unwrap();
    w.place(BARRACKS, spot.0, spot.1, 0);
    assert_eq!(w.train(5, 1), -12, "a ram needs a barracks of tier 2");
    let u = units(); assert!(u.contains("\"name\":\"Ram\"") && u.contains("Militia"));
    assert_eq!(w.army().len(), 6);
    assert!(w.cheat(2, 5, 3) && w.army()[5] == 3);
    let id = w.det_form(&[0, 0, 0, 0, 0, 2]); assert!(id > 0);
    assert_eq!(w.det_flat()[3..8].iter().sum::<f32>(), 0.0);
    assert_eq!(w.det_flat()[16], 2.0, "the ram count is the last field of an army");
}

#[test]
fn every_queued_kind_is_drilled_at_once_and_a_cancelled_order_is_refunded() {
    let mut w = World::new(1337, 0, 0);
    w.stock = [3000; N_RES]; w.population = 60;
    let (hx, hy) = (w.buildings[0].x, w.buildings[0].y);
    put_t(&mut w, BARRACKS, 3, hx - 14.0, hy + 14.0);
    w.buildings.last_mut().unwrap().staff = 1;
    assert_eq!(w.train(0, 6), 0); assert_eq!(w.train(1, 6), 0);
    let before = w.stock;
    for _ in 0..12 { w.step(); w.stock = before; }
    assert!(w.army()[0] > 0 && w.army()[1] > 0, "both queues make progress together: {:?}", w.army());
    assert!(w.queued()[0] > 0 && w.queued()[1] > 0);
    let (queued, pop) = (w.queued()[0], w.population);
    w.stock = [0; N_RES];
    assert_eq!(w.train_cancel(0, queued + 1), -1, "cannot cancel more than is queued");
    assert_eq!(w.train_cancel(0, queued), 0);
    assert_eq!(w.queued()[0], 0);
    assert_eq!(w.population, pop + queued, "the recruits go back to the village");
    for &(r, c) in UNITS[0].cost { assert_eq!(w.stock[r as usize], c * queued as i32, "the cost comes back"); }
}

#[test]
fn soldiers_who_win_a_fight_may_become_veterans_who_are_saved_and_fight_better() {
    let mut w = World::new(1337, 0, 0);
    w.stock = [3000; N_RES]; w.population = 40;
    w.army = [10, 0, 0, 0, 0, 0];
    assert!(w.begin_battle([2, 0, 0, 0, 0, 0], 0.0, 0));
    run(&mut w, 170);
    assert!(!w.battle_active());
    let vets = w.army_veterans();
    assert!(vets[0] >= 1 && vets[0] <= w.army()[0], "a won fight makes veterans among the survivors: {vets:?} of {:?}", w.army());
    let back = world_restore(&w.snapshot()).expect("a snapshot restores");
    assert_eq!(back.army_veterans(), vets);
    assert_eq!(back.state_hash_parts(), w.state_hash_parts());
    assert!(w.begin_battle([1, 0, 0, 0, 0, 0], 0.0, 0));
    let b = w.battle.as_ref().unwrap();
    let vet_units = b.units.iter().filter(|u| u.side == 0 && u.from_army && tactics::is_veteran(u)).count() as u32;
    assert_eq!(vet_units, vets[0].min(w.army()[0]));
}

#[test]
fn an_army_that_made_camp_fights_out_of_it_not_from_one_heap() {
    let mut w = World::new(1337, 0, 0); w.stock = [10_000; N_RES];
    assert_eq!(w.flatten(88, 7.0), 0);
    w.army = [16, 0, 0, 0, 0, 0];
    let id = w.det_form(&[16, 0, 0, 0, 0, 0]); assert!(id > 0);
    assert_eq!(w.det_march(id, 23.0, 24.0, false, 0.0, 0.0), 0);
    for _ in 0..200 { w.step(); if w.dets[0].state == march::S_IDLE && w.dets[0].file.mustered() { break; } }
    assert_eq!(w.dets[0].state, march::S_IDLE, "the army arrived and spread out");
    let slots: Vec<(f32, f32)> = w.dets[0].file.slots();
    assert_eq!(slots.len(), 16);
    assert!(w.start_raid(0.0, &[6, 2, 0, 0, 0, 0], 0));
    w.det_join(0);
    let b = w.battle.as_ref().unwrap();
    let mine: Vec<(f32, f32)> = b.units.iter().filter(|u| u.det == id).map(|u| (u.x, u.y)).collect();
    assert_eq!(mine.len(), 16);
    for (i, p) in mine.iter().enumerate() {
        assert!(mine[..i].iter().all(|q| (q.0 - p.0).hypot(q.1 - p.1) > 1.0), "soldier {i} does not stand on another");
        assert_eq!(*p, slots[i], "and each starts at their own place in the camp");
    }
}

// ---- allied guests (docs/ALLIES.md) ----

fn allied(w: &mut World, tag: i32) { w.rel_add(tag, 70); assert!(w.treaty_set(tag, TREATY_TRADE, 30)); assert!(w.treaty_set(tag, TREATY_ALLIANCE, 30)); }

#[test]
fn guests_need_an_alliance_and_cannot_be_ordered_about() {
    let mut w = weak_village();
    assert!(!w.host_guests(7, &[10, 5, 5, 0, 0, 0]), "no alliance, no guests");
    allied(&mut w, 7);
    assert!(!w.host_guests(0, &[10, 5, 5, 0, 0, 0]) && !w.host_guests(7, &[0; 6]) && !w.host_guests(7, &[GUEST_MAX + 1, 0, 0, 0, 0, 0]), "nobody, nothing, too many");
    assert!(!w.host_guests(8, &[10, 5, 5, 0, 0, 0]), "an ally of somebody else is not our ally");
    assert!(w.host_guests(7, &[10, 5, 5, 0, 0, 0]));
    let id = w.dets[0].id; assert_eq!(w.dets[0].ally, 7); assert_eq!(w.det_ally_flat(), vec![7]);
    assert!(w.det_march(id, 40.0, 40.0, false, 0.0, 0.0) < 0, "they do not take our orders");
    assert!(w.det_defend(id) < 0 && w.det_send(id).is_empty() && w.det_split(id, &[1, 0, 0, 0, 0, 0]) == 0);
    w.det_halt(id); assert_eq!(w.dets.len(), 1);
    for _ in 0..GUEST_ARMIES { w.host_guests(7, &[1, 0, 0, 0, 0, 0]); }
    assert_eq!(w.dets.len(), GUEST_ARMIES, "only so many guest armies");
    assert_eq!(w.army, [0; 6], "guests are not part of our own army");
}

#[test]
fn allied_guests_join_a_defence_by_themselves_and_go_home() {
    let run_it = |guests: bool| -> (u64, Vec<i32>, usize, [u32; 6]) {
        let mut w = weak_village();
        if guests { allied(&mut w, 7); assert!(w.host_guests(7, &[14, 8, 6, 0, 0, 0])); }
        assert!(w.start_raid(0.0, &[14, 6, 3, 0, 0, 0], 0));
        let mut fought = 0usize;
        for _ in 0..500 {
            w.step(); w.stock[GR as usize] = 3000;
            if let Some(b) = &w.battle { fought = fought.max(b.units.iter().filter(|u| u.side == 0 && u.det > 0).count()); } else { break; }
        }
        let home = if guests { let mut b = [0u32; 6]; for d in &w.dets { for k in 0..6 { b[k] += d.units[k]; } } b } else { [0; 6] };
        (w.state_hash(), w.last_report(), fought, home)
    };
    let (_, alone, _, _) = run_it(false);
    assert_eq!(alone[1], 0, "the village alone loses: {alone:?}");
    let (h1, helped, fought, left) = run_it(true);
    assert_eq!(fought, 28, "all the guests went to the fight");
    assert_eq!(helped[1], 1, "with its allies' troops the village holds: {helped:?}");
    assert!(left.iter().sum::<u32>() > 0 && left.iter().sum::<u32>() <= 28, "some of them are left: {left:?}");
    let (h2, again, _, _) = run_it(true);
    assert_eq!((h1, &helped), (h2, &again), "every peer replaying the same commands reaches the same state");
    // they go home with whoever survived, and not before a fight is over
    let mut w = weak_village(); allied(&mut w, 7); assert!(w.host_guests(7, &[14, 8, 6, 0, 0, 0]));
    assert!(w.start_raid(0.0, &[14, 6, 3, 0, 0, 0], 0));
    for _ in 0..200 { w.step(); w.stock[GR as usize] = 3000; if w.dets.iter().all(|d| d.state == march::S_FIGHT) { break; } }
    assert!(w.dets.iter().all(|d| d.state == march::S_FIGHT), "they reached the fight");
    assert_eq!(w.release_guests(7).iter().sum::<u32>(), 0, "guests in a fight stay in it"); assert!(!w.dets.is_empty());
    for _ in 0..500 { if w.battle.is_none() { break; } w.step(); w.stock[GR as usize] = 3000; }
    let back = w.release_guests(7);
    assert!(back.iter().sum::<u32>() > 0 && back.iter().sum::<u32>() <= 28 && w.dets.is_empty(), "{back:?}");
    assert!(w.release_guests(7).iter().sum::<u32>() == 0 && w.release_guests(0).iter().sum::<u32>() == 0);
}

#[test]
fn guests_survive_a_snapshot() {
    let mut w = weak_village(); allied(&mut w, 7); assert!(w.host_guests(7, &[10, 5, 5, 0, 0, 0]));
    for _ in 0..20 { w.step(); }
    let back = world_restore(&w.snapshot()).expect("a snapshot restores");
    assert_eq!(back.det_ally_flat(), vec![7]); assert_eq!(back.state_hash_parts(), w.state_hash_parts());
}

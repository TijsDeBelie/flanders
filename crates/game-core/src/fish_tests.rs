//! Fishing huts, smokehouses and the smoked fish the village eats.
use super::*;

fn put(w: &mut World, kind: u8, x: f32, y: f32) -> usize {
    let pad_h = w.base(x, y);
    w.buildings.push(Building { kind, tier: 0, x, y, rot: 0, pad_h, progress: 0, status: 1, aux: -1, staff: 0, residents: 0, hp: battle::max_hp(kind, 0), burning: 0.0, garrison: 0, born: 0, opts: 0, fert: FERT_MAX, mode: 0, target: -1, beff: 100 });
    w.buildings.len() - 1
}
fn moat_world() -> World {
    let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w.flatten(40, 5.0);
    for i in 0..52 { let a = i as f32 / 52.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 24.0).round() as i32, (a.sin() * 24.0).round() as i32, 0); }
    w
}

#[test]
fn a_fishing_hut_snaps_to_a_river_bank_with_its_jetty_over_the_water() {
    let mut w = World::new(1337, 0, 0); w.stock = [500; N_RES];
    for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 17, 4), (HOUSE, 22, 4), (HOUSE, -12, 6), (TOWER, 0, 16), (TOWER, 8, -16)] { w.place(k, x, y, 0); }
    for i in 0..6 { assert!(w.place(RIVER, 20 + i * 4, -30, 2) >= 0); }
    let mut seen = 0;
    for (cx, cy) in [(24, -22), (30, -24), (28, -40), (36, -30), (34, -36), (22, -23)] {
        let s = w.fishing_hut_snap(cx, cy);
        if s.is_empty() { continue; }
        seen += 1;
        let (dx, dy, rot) = (s[0] as i32, s[1] as i32, s[2] as u8);
        let (x, y) = ((w.ox + dx) as f32, (w.oy + dy) as f32);
        let (ux, uy) = World::wheel_dir(rot);
        assert!(w.height_at(x, y) >= 0.4, "on dry land: {s:?}");
        assert!(w.height_at(x + ux * WHEEL_REACH, y + uy * WHEEL_REACH) < 0.2, "the jetty ends over water: {s:?}");
        assert_eq!(w.fishing_hut_snap(cx, cy), s, "a pure function");
        assert_eq!(w.place(FISHING_HUT, dx, dy, (rot + 4) & 7), -16, "a hut turned to the land is refused");
        if seen == 1 { assert!(w.place(FISHING_HUT, dx, dy, rot) >= 0, "the snapped spot can be built on: {s:?}"); }
    }
    assert!(seen >= 3, "the snap finds the bank from most clicks ({seen})");
    assert!(w.fishing_hut_snap(-60, 60).is_empty(), "no water, no snap");
    assert_ne!(w.place(FISHING_HUT, -60, 60, 0), 0, "no hut away from water");
    assert_eq!(w.place(FISHING_HUT, -12, -2, 0), -16, "no hut on dry land inland");
}

#[test]
fn a_fishing_hut_at_a_moat_keeps_its_floor_on_dry_ground() {
    let mut w = moat_world();
    let level = w.moat_level_at(0.0, 24.0);
    assert!(level > 1.0, "a moat's water stands above the sea: {level}");
    let s = w.fishing_hut_snap(0, 33);
    assert!(!s.is_empty(), "the hut snaps to the moat bank");
    let (dx, dy, rot) = (s[0] as i32, s[1] as i32, s[2] as u8);
    let (x, y) = ((w.ox + dx) as f32, (w.oy + dy) as f32);
    let bank = w.height_ground(x, y);
    let water = w.shore_water_height(x, y, rot);
    let preview = w.placement_height(FISHING_HUT, x, y, rot);
    let i = w.place(FISHING_HUT, dx, dy, rot); assert!(i >= 0, "built: {i}");
    let pad = w.buildings[i as usize].pad_h;
    assert_eq!(pad, preview);
    assert!(water > 1.0 && pad >= bank.max(water + SHORE_CLEARANCE), "bank {bank}, pad {pad}, water {water}");
    assert_eq!(w.flatten(40, 0.5), 0);
    assert!(w.buildings[i as usize].pad_h > w.shore_water_height(x, y, rot), "the hut stays clear when the bank is lowered");
}

#[test]
fn fishing_huts_land_raw_fish_and_smokehouses_smoke_it() {
    let mut w = moat_world();
    w.stock = [0; N_RES]; w.stock[GR as usize] = 10_000; w.population = 20; w.children = 0; w.elders = 0;
    // the hut must stand on a bank with its jetty over water: it stops working when there is none
    let sn = [(0, 33), (0, 30), (33, 0), (-33, 0), (0, -33)].iter().map(|&(cx, cy)| w.fishing_hut_snap(cx, cy)).find(|v| !v.is_empty()).expect("a bank to build on");
    let (hx, hy) = ((w.ox + sn[0] as i32) as f32, (w.oy + sn[1] as i32) as f32); let h = put(&mut w, FISHING_HUT, hx, hy); w.buildings[h].rot = sn[2] as u8;
    let s = put(&mut w, SMOKEHOUSE, -20.0, 20.0);
    w.stock[W as usize] = 10;
    let (mut raw, mut smoked) = (0, 0);
    for _ in 0..120 { w.step(); w.stock[GR as usize] = 10_000; w.stock[W as usize] = w.stock[W as usize].max(10); w.population = 20; raw = raw.max(w.stock[FI as usize]); smoked = smoked.max(w.stock[SF as usize]); }
    eprintln!("hut {:?} smokehouse {:?} eff {}", w.buildings[h].status, w.buildings[s].status, w.eff);
    assert!(raw > 0 && smoked > 0, "fish was landed and smoked ({raw} raw at most, {smoked} smoked at most; eff {})", w.eff);
    let _ = s;
    // the numbers: a smokehouse turns 3 fish and 1 wood into 3 smoked fish
    let d = &DEFS[SMOKEHOUSE as usize];
    assert_eq!(d.inputs, &[(FI, 3), (W, 1)]); assert_eq!(d.outputs, &[(SF, 3)]);
    assert_eq!(DEFS[FISHING_HUT as usize].outputs, &[(FI, 4)]);
}

#[test]
fn a_smokehouse_without_fish_waits() {
    let mut w = World::new(1337, 0, 0); w.stock = [0; N_RES]; w.stock[GR as usize] = 10_000; w.stock[W as usize] = 50; w.population = 40; w.eff = 100;
    let s = put(&mut w, SMOKEHOUSE, -20.0, 20.0);
    for _ in 0..30 { w.step(); w.stock[GR as usize] = 10_000; w.stock[W as usize] = 50; w.population = 40; }
    assert_eq!(w.stock[SF as usize], 0, "no fish, nothing smoked");
    assert_eq!(w.buildings[s].status, 1, "it says it lacks something");
}

#[test]
fn every_kind_of_food_is_eaten_together_and_cooked_food_goes_further() {
    let quarters = |w: &World| w.food_units() / 5;
    // 100 heads need 10 meals = 40 quarter meals a tick; smoked fish (6) and grain (4) run down side by side, the fuller store first
    let mut w = World::new(1337, 0, 0); w.stock = [0; N_RES]; w.population = 100; w.children = 0; w.elders = 0;
    w.stock[SF as usize] = 100; w.stock[GR as usize] = 100;
    let q0 = quarters(&w); w.step();
    assert_eq!(q0 - quarters(&w), 40, "a tick's meals, no more");
    assert!(w.stock[SF as usize] < 100 && w.stock[GR as usize] <= 100, "the fish store, holding more food, goes first");
    for _ in 0..20 { w.step(); }
    let (f, g) = (w.stock[SF as usize] * 6, w.stock[GR as usize] * 3); assert!((f - g).abs() <= 6, "the stores level out: fish {f}, grain {g}");
    // raw fish and raw grain fill less: the same head count eats more items of them than of bread
    let eaten = |res: u8| { let mut v = World::new(1337, 0, 0); v.stock = [0; N_RES]; v.population = 100; v.children = 0; v.elders = 0; v.stock[res as usize] = 1000; for _ in 0..40 { v.step(); } 1000 - v.stock[res as usize] };
    let (raw, bread) = (eaten(GR), eaten(BD));
    assert!(eaten(FI) < raw, "raw grain fills less than raw fish"); assert!(bread * 2 <= raw + 3, "bread {bread} against grain {raw}");
    // when there is not enough food everything is eaten and people starve
    let mut h = World::new(1337, 0, 0); h.stock = [0; N_RES]; h.population = 100; h.stock[FI as usize] = 5; h.step();
    assert_eq!(h.stock[FI as usize], 0); assert_eq!(h.food(), 0);
    // cooked food alone keeps people fed: no one dies of hunger
    let mut u = World::new(1337, 0, 0); u.stock = [0; N_RES]; u.population = 40; u.stock[SF as usize] = 200;
    for _ in 0..30 { u.step(); u.stock[SF as usize] = 200; }
    assert_eq!(u.died[DIED_HUNGER as usize], 0, "nobody starved"); assert!(u.food() >= 10);
}

#[test]
fn the_food_reserve_uses_current_rations_and_meal_credit() {
    let mut w = World::new(1337, 0, 0);
    assert_eq!(w.food_reserve_days(), 0.375 * START_GRAIN as f64 / 120.0, "the starting grain (0.375 days at the old 120)");
    w.stock = [0; N_RES];
    w.stock[BD as usize] = 320;
    w.away[0] = 5;
    assert_eq!(w.food_reserve_days(), 4.0 / 3.0);
    assert!(w.eat_units(29));
    assert_eq!(w.meal_credit, 1);
    assert_eq!(w.food_reserve_days(), (9_600.0 - 29.0) / 7_200.0);
    w.away[0] = 0;
    w.population = 4;
    assert!(w.food_reserve_days() > 4.0);
}

#[test]
fn a_bakery_turns_grain_into_bread() {
    let d = &DEFS[BAKERY as usize]; assert_eq!(d.inputs, &[(GR, 3), (W, 1)]); assert_eq!(d.outputs, &[(BD, 4)]);
    let mut w = World::new(1337, 0, 0); w.stock = [200; N_RES]; w.stock[BD as usize] = 0; w.population = 10; w.cheat(3, 0, 0);
    assert!(w.place(BAKERY, 14, 4, 0) >= 0); for _ in 0..300 { w.step(); w.stock[GR as usize] = 200; }
    assert!(w.stock[BD as usize] > 0, "bread was baked");
}

#[test]
fn fish_hash_and_wide_stock_are_deterministic() {
    let run = || { let mut w = moat_world(); let s = w.fishing_hut_snap(0, 33); w.place(FISHING_HUT, s[0] as i32, s[1] as i32, s[2] as u8); w.place(SMOKEHOUSE, 6, 8, 0); w.stock[FI as usize] = 0; w.stock[SF as usize] = 0; for _ in 0..60 { w.step(); } w.state_hash() };
    assert_eq!(run(), run());
    let mut a = moat_world(); let b = moat_world();
    a.stock[SF as usize] += 1;
    assert_ne!(a.state_hash_parts()[1], b.state_hash_parts()[1], "smoked fish is in the stock section of the hash");
}

/// The hut's stone footing in the model's frame (+x towards the water): x from `FISH_FOOT_MIN` to `FISH_FOOT_MAX`, z within `FISH_FOOT_HALF_D`. Mirrors `fishingHut` in buildings.ts (tier 3, the widest).
#[allow(dead_code)] const FISH_FOOT_MIN: f32 = -2.7; const FISH_FOOT_MAX: f32 = 1.5; const FISH_FOOT_HALF_D: f32 = 1.45;

#[test]
fn a_fishing_huts_footing_stays_on_the_land_side_of_the_bank_at_every_turn() {
    let mut rivers = World::new(1337, 0, 0); rivers.stock = [500; N_RES];
    for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, 17, 4), (HOUSE, 22, 4), (HOUSE, -12, 6), (TOWER, 0, 16), (TOWER, 8, -16)] { rivers.place(k, x, y, 0); }
    for i in 0..6 { assert!(rivers.place(RIVER, 20 + i * 4, -30, 2) >= 0); }
    let moat = moat_world();
    let mut seen = 0;
    for (w, clicks) in [(&rivers, vec![(24, -22), (30, -24), (28, -40), (36, -30), (34, -36), (22, -23)]), (&moat, vec![(0, 33), (33, 0), (-33, 0), (0, -33), (24, 24), (-24, 24), (24, -24), (-24, -24)])] {
        for (cx, cy) in clicks {
            let s = w.fishing_hut_snap(cx, cy);
            if s.is_empty() { continue; }
            seen += 1;
            let (x, y, rot) = ((w.ox + s[0] as i32) as f32, (w.oy + s[1] as i32) as f32, s[2] as u8);
            let (ux, uy) = World::wheel_dir(rot); let (vx, vy) = (-uy, ux);
            // the visible bank along the turn, and along the two sides of the footing too (the bank may run oblique)
            for &l in &[-FISH_FOOT_HALF_D, 0.0, FISH_FOOT_HALF_D] {
                let (ox, oy) = (x + vx * l, y + vy * l);
                let mut e = 0.0f32; while e < 8.0 && w.height_at(ox + ux * e, oy + uy * e) >= 0.3f32.max(w.moat_level_at(ox + ux * e, oy + uy * e)) { e += 0.1; }
                assert!(e >= FISH_FOOT_MAX + 0.5, "the footing (to {FISH_FOOT_MAX}) must end 0.5 before the water, which starts at {e:.1} (side {l}): {s:?} from {cx},{cy}");
            }
        }
    }
    assert!(seen >= 10, "enough snaps checked ({seen})");
}

#[test]
fn hunters_bring_meat_and_a_smokehouse_smokes_fish_or_meat() {
    let mut w = World::new(1337, 0, 0); w.stock = [0; N_RES]; w.stock[GR as usize] = 10_000; w.stock[W as usize] = 200; w.population = 40; w.eff = 100;
    assert_eq!(DEFS[LODGE as usize].outputs, &[(ME, 5)][..], "the lodge makes meat, not grain");
    let s = put(&mut w, SMOKEHOUSE, -20.0, 20.0);
    assert_eq!(w.smoke_mode(s as u32), 0); w.stock[FI as usize] = 60; w.stock[ME as usize] = 60;
    let keep = |w: &mut World| { w.stock[GR as usize] = 10_000; w.stock[W as usize] = 200; w.population = 40; };
    for _ in 0..(DAY as usize) { w.step(); keep(&mut w); }
    assert!(w.stock[SF as usize] > 0 && w.stock[SM as usize] == 0, "set to fish: smoked fish {} smoked meat {}", w.stock[SF as usize], w.stock[SM as usize]);
    assert_eq!(w.set_field_mode(s as u32, 1), 0); assert_eq!(w.smoke_mode(s as u32), 1);
    for _ in 0..(DAY as usize) { w.step(); keep(&mut w); }
    assert!(w.stock[SM as usize] > 0, "set to meat: smoked meat {}", w.stock[SM as usize]);
    assert!(w.stock[ME as usize] < 60, "it used the meat");
    assert_eq!(w.set_field_mode(s as u32, 2), -2);
    assert!(!FOODS.iter().any(|&(r, _)| r == ME || r == SM), "meat is a luxury, not a staple");
    let mut m = World::new(1337, 0, 0); m.stock = [0; N_RES]; m.stock[GR as usize] = 5000; let h0 = m.happiness(); m.stock[ME as usize] = 50; assert!(m.happiness() > h0, "meat on the table lifts the mood");
}

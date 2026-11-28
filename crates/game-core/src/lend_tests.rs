//! Armies and water: bridges, lent drawbridges and own soldiers who do not wade (see lend.rs).
use super::*;

fn ring(w: &mut World, r: f32, n: usize, kind: u8) {
    for i in 0..n { let a = i as f32 / n as f32 * std::f32::consts::TAU; let (x, y) = ((a.cos() * r).round() as i32, (a.sin() * r).round() as i32); w.place(kind, x, y, 0); }
}
/// A village inside a moat (radius 24) with a drawbridge on the south side (towards +y), drawn up unless `up` is false.
fn moat_village(up: bool) -> (World, u32) {
    let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0); w.population = 20;
    ring(&mut w, 24.0, 52, MOAT);
    assert!(w.place(DRAWBRIDGE, 0, 24, 0) >= 0);
    let di = w.buildings.iter().position(|b| b.kind == DRAWBRIDGE).unwrap() as u32;
    for (k, x, y) in [(HOUSE, 12, 4), (HOUSE, -12, 6)] { w.place(k, x, y, 0); }
    if up { assert_eq!(w.drawbridge_set(di, true), 0); w.buildings[di as usize].progress = 0; }   // (drawn up, and not by hand just now: an army may lower it)
    w.after_change();
    (w, di)
}
/// Is a spot water that nobody can walk on: below the shore, and neither a bridge nor a lowered deck?
fn wet(w: &World, x: f32, y: f32) -> bool {
    w.height_ground(x, y) < 0.2 && !w.on_deck(x, y) && !w.bridges.iter().any(|g| { let (dx, dy) = (g[2] - g[0], g[3] - g[1]); let l = dx.hypot(dy).max(0.1); let (px, py) = (x - g[0], y - g[1]); let al = (px * dx + py * dy) / l; (px * dy - py * dx).abs() / l < 2.0 && al > -1.0 && al < l + 1.0 })
}
fn own_wet(w: &World) -> usize { w.battle.as_ref().map_or(0, |b| b.units.iter().filter(|u| u.side == 0 && u.alive && wet(w, u.x, u.y)).count()) }
fn st(w: &World, di: u32) -> u8 { w.buildings[di as usize].status }
fn tick(w: &mut World) { w.step(); w.stock = [30000; N_RES]; }

#[test]
fn manually_lowering_a_drawbridge_holds_until_the_next_raid_or_raise() {
    let (mut w, di) = moat_village(false);
    let i = di as usize;
    assert!(w.start_raid(0.0, &[8, 0, 0, 0, 0, 0], 0));
    assert!(w.drawn_up(&w.buildings[i]));
    assert_eq!(w.drawbridge_set(di, false), 0);
    for _ in 0..LEND_HOLD + 1 { w.drawbridge_step(); }
    assert!(!w.drawn_up(&w.buildings[i]));
    assert!(w.battle.as_ref().unwrap().fixed.contains(&[w.buildings[i].x, w.buildings[i].y]));
    let restored = world_restore(&w.snapshot()).unwrap();
    assert!(!restored.drawn_up(&restored.buildings[i]));
    assert_eq!(w.drawbridge_set(di, true), 0);
    assert!(w.drawn_up(&w.buildings[i]));
    assert!(!w.battle.as_ref().unwrap().fixed.contains(&[w.buildings[i].x, w.buildings[i].y]));
    assert_eq!(w.drawbridge_set(di, false), 0);
    w.battle = None;
    assert!(!w.drawn_up(&w.buildings[i]));
    assert!(w.start_raid(0.0, &[8, 0, 0, 0, 0, 0], 0));
    assert!(w.drawn_up(&w.buildings[i]));
}

#[test]
fn an_army_sent_to_a_raid_across_a_moat_gets_the_drawbridge_lowered_crosses_on_the_deck_and_it_is_raised_again() {
    let (mut w, di) = moat_village(true);
    assert_eq!(st(&w, di), DB_UP);
    w.army = [10, 4, 0, 0, 0, 0];
    let id = w.det_form(&[10, 4, 0, 0, 0, 0]); assert!(id > 0);
    assert!(w.start_raid(std::f32::consts::FRAC_PI_2, &[10, 4, 0, 0, 0, 0], 0));
    assert_eq!(w.det_defend(id), 0);
    let (mut down_at, mut up_again, mut crossed, mut joined) = (None, None, false, false);
    let mut series = vec![];
    for t in 0..150 {
        tick(&mut w);
        let f = w.det_flat(); let (x, y) = (f[1], f[2]);
        series.push((t, st(&w, di), x, y));
        if st(&w, di) == DB_LENT && down_at.is_none() { down_at = Some(t); }
        if y > 34.0 { crossed = true; }
        if down_at.is_some() && up_again.is_none() && st(&w, di) == DB_UP { up_again = Some(t); }
        if f[8] as u8 == march::S_FIGHT { joined = true; }
        assert_eq!(own_wet(&w), 0, "no soldier of ours in the water at tick {t}");
        if !joined && !matches!(f[8] as u8, march::S_BRIDGE | march::S_FERRY) { assert!(!wet(&w, x, y), "the army is in the water at tick {t}: {x},{y}"); }
        if !w.battle_active() { break; }
    }
    eprintln!("lowered at {down_at:?}, raised again at {up_again:?}; samples {:?}", series.iter().step_by(6).collect::<Vec<_>>());
    assert!(down_at.is_some(), "the drawbridge was lowered for the army");
    assert!(crossed && joined, "the army got across and joined the fight");
    assert!(up_again.unwrap() > down_at.unwrap() + 2, "and was drawn up again afterwards");
    assert!(w.field_bridge_count() == 0, "no bridge of planks was built: the drawbridge made it unnecessary");
    for _ in 0..30 { tick(&mut w); } assert_eq!(st(&w, di), DB_UP, "it stays up when no army needs it");
}

#[test]
fn a_lent_drawbridge_is_down_only_while_the_army_needs_it_and_idle_armies_do_not_lower_it() {
    let (mut w, di) = moat_village(true);
    w.army = [6, 0, 0, 0, 0, 0];
    let id = w.det_form(&[6, 0, 0, 0, 0, 0]); assert!(id > 0);
    for _ in 0..20 { tick(&mut w); } assert_eq!(st(&w, di), DB_UP, "an idle army inside does not lower it");
    assert_eq!(w.det_march(id, 0.0, 50.0, false, 0.0, 0.0), 0);
    let (mut lowered, mut over, mut back) = (0u32, false, false);
    for t in 0..80 {
        tick(&mut w);
        let f = w.det_flat(); let y = f[2];
        if st(&w, di) == DB_LENT { lowered += 1; }
        if y > 33.0 { over = true; }
        if over && st(&w, di) == DB_UP { back = true; }
        assert!(!wet(&w, f[1], f[2]), "t{t}: wet at {},{}", f[1], f[2]);
    }
    eprintln!("lowered {lowered} ticks");
    assert!(over && back && (5..=30).contains(&lowered), "lowered {lowered} ticks, crossed {over}, raised again {back}");
    assert_eq!(st(&w, di), DB_UP);
}

#[test]
fn a_manual_raise_wins_over_the_automatic_lowering() {
    let (mut w, di) = moat_village(true);
    w.army = [6, 0, 0, 0, 0, 0];
    let id = w.det_form(&[6, 0, 0, 0, 0, 0]); assert!(id > 0);
    assert_eq!(w.det_march(id, 0.0, 50.0, false, 0.0, 0.0), 0);
    let mut lent = false;
    for _ in 0..40 { tick(&mut w); if st(&w, di) == DB_LENT { lent = true; break; } }
    assert!(lent, "first it is lowered for the army");
    assert_eq!(w.drawbridge_set(di, true), 0);
    assert_eq!(st(&w, di), DB_UP);
    for t in 0..100 { tick(&mut w); assert_eq!(st(&w, di), DB_UP, "the player's raise holds against the army (t{t})"); }
    assert!(w.field_bridge_count() > 0 || w.det_flat()[2] > 30.0, "it went another way (a bridge of its own): {:?}", w.det_flat());
    // and by hand it can be lowered again
    assert_eq!(w.drawbridge_set(di, false), 0); assert_eq!(st(&w, di), 4);
    for _ in 0..30 { tick(&mut w); } assert_eq!(st(&w, di), 4, "a bridge lowered by hand stays down");
}

#[test]
fn a_raised_drawbridge_may_be_lowered_by_an_army_once_the_hold_after_a_manual_raise_has_run_out() {
    let (mut w, di) = moat_village(false);
    assert_eq!(w.drawbridge_set(di, true), 0);
    let hold = w.buildings[di as usize].progress; assert!(hold > 0);
    for _ in 0..hold + 1 { tick(&mut w); }
    w.army = [6, 0, 0, 0, 0, 0];
    let id = w.det_form(&[6, 0, 0, 0, 0, 0]);
    assert_eq!(w.det_march(id, 0.0, 50.0, false, 0.0, 0.0), 0);
    let mut lent = false; for _ in 0..40 { tick(&mut w); if st(&w, di) == DB_LENT { lent = true; } } assert!(lent);
}

#[test]
fn with_no_drawbridge_a_narrow_moat_is_bridged_with_planks() {
    let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
    ring(&mut w, 24.0, 52, MOAT); w.after_change();
    w.army = [8, 0, 4, 0, 0, 0];
    let id = w.det_form(&[8, 0, 4, 0, 0, 0]); assert!(id > 0);
    let planks0 = w.stock[PL as usize];
    assert_eq!(w.det_march(id, 0.0, 50.0, false, 0.0, 0.0), 0);
    let (mut bridging, mut over) = (false, false);
    for t in 0..200 {
        w.step();
        let f = w.det_flat(); let s = f[8] as u8; let (x, y) = (f[1], f[2]);
        if s == march::S_BRIDGE { bridging = true; }
        if !matches!(s, march::S_BRIDGE | march::S_FERRY) { assert!(!wet(&w, x, y), "t{t}: the army is wading at {x},{y} (state {s})"); }
        if y > 33.0 { over = true; break; }
    }
    assert!(bridging && over, "it built a bridge ({bridging}) and crossed ({over})");
    assert!(w.stock[PL as usize] < planks0, "planks were spent: {} of {planks0}", w.stock[PL as usize]);
    assert!(w.field_bridge_count() > 0);
}

#[test]
fn field_orders_go_round_a_canal_unless_bridge_shortcuts_are_enabled() {
    let mut w = World::new(1337, 0, 0);
    w.stock = [30_000; N_RES];
    w.cheat(3, 0, 0);
    assert_eq!(w.flatten(85, 5.0), 0);
    let items: Vec<_> = (-28..=68).step_by(4).flat_map(|x| [MOAT as i32, x, 23, 1]).collect();
    let placed = w.place_batch(&items);
    assert!(placed.iter().filter(|&&v| v >= 0).count() >= 22, "canal pieces: {placed:?}");
    let plan = |w: &World| w.plan_march(&[8, 0, 0, 0, 0, 0], 34.0, 12.0, 34.0, 34.0);
    let dry = plan(&w);
    assert_eq!((dry[0], dry[2], dry[3]), (1.0, 0.0, 0.0));
    w.army_set_bridge_shortcuts(true);
    let wet = plan(&w);
    assert!(wet[0] == 1.0 && wet[2] > 0.0 && wet[3] == 0.0, "bridge shortcut: {wet:?}");
}

#[test]
fn a_moat_too_wide_to_bridge_is_ferried_not_waded() {
    let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
    for (r, n) in [(24.0f32, 52usize), (29.0, 62), (34.0, 72), (39.0, 84)] { ring(&mut w, r, n, MOAT); }   // four moats one inside the other: water too wide for planks
    w.after_change();
    let plan = w.plan_march(&[8, 0, 4, 0, 0, 0], 0.0, 0.0, 0.0, 60.0);
    eprintln!("plan across a wide moat: {plan:?}");
    assert!(plan[0] == 1.0 && plan[3] > 0.0 && plan[2] == 0.0, "boats (wood), no planks: {plan:?}");
    w.army = [8, 0, 4, 0, 0, 0];
    let id = w.det_form(&[8, 0, 4, 0, 0, 0]);
    assert_eq!(w.det_march(id, 0.0, 60.0, false, 0.0, 0.0), 0);
    let mut ferried = false;
    for t in 0..300 { w.step(); let f = w.det_flat(); let s = f[8] as u8; if s == march::S_FERRY { ferried = true; } else { assert!(!wet(&w, f[1], f[2]), "t{t}: wading at {},{} (state {s})", f[1], f[2]); } }
    assert!(ferried && w.field_bridge_count() == 0);
}

#[test]
fn soldiers_in_a_fight_walk_to_the_drawbridge_instead_of_wading_and_it_is_drawn_up_after() {
    let (mut w, di) = moat_village(true);
    assert!(w.start_raid(std::f32::consts::FRAC_PI_2, &[4, 0, 0, 0, 0, 0], 0));
    // park the raiders far away so nothing draws the defenders; then send one of them to a post outside the moat
    let me;
    { let b = w.battle.as_mut().unwrap();
      for u in b.units.iter_mut().filter(|u| u.side == 1) { u.x = 600.0; u.y = 600.0; }
      me = b.units.iter().position(|u| u.side == 0 && u.kind == MILITIA).expect("a militia man");
      b.units[me].x = 2.0; b.units[me].y = 16.0; b.units[me].hx = 0.0; b.units[me].hy = 36.0; b.units[me].held = false;
    }
    let (mut lent, mut arrived) = (false, None);
    for t in 0..80 {
        tick(&mut w);
        let u = w.battle.as_ref().unwrap().units[me].clone();
        assert!(!wet(&w, u.x, u.y), "t{t}: our soldier is in the water at {},{}", u.x, u.y);
        if st(&w, di) == DB_LENT || st(&w, di) == DB_LENT_FIGHT { lent = true; }
        if arrived.is_none() && (u.y - 36.0).abs() < 2.5 { arrived = Some(t); }
        if let Some(a) = arrived { if t > a + 6 { assert_eq!(st(&w, di), DB_UP, "t{t}: the deck is drawn up again after he crossed"); break; } }
    }
    eprintln!("lent {lent}, arrived {arrived:?}");
    assert!(lent && arrived.is_some(), "he asked for the deck and walked over it");
}

#[test]
fn soldiers_in_a_fight_with_no_way_over_stop_at_the_edge() {
    let (mut w, di) = moat_village(true);
    assert_eq!(w.drawbridge_set(di, true), 0);   // by hand: nobody lowers it
    assert!(w.start_raid(std::f32::consts::FRAC_PI_2, &[4, 0, 0, 0, 0, 0], 0));
    let me;
    { let b = w.battle.as_mut().unwrap();
      for u in b.units.iter_mut().filter(|u| u.side == 1) { u.x = 600.0; u.y = 600.0; }
      me = b.units.iter().position(|u| u.side == 0 && u.kind == MILITIA).unwrap();
      b.units[me].x = 2.0; b.units[me].y = 14.0; b.units[me].hx = 0.0; b.units[me].hy = 40.0; b.units[me].held = false;
    }
    for t in 0..60 { tick(&mut w); let u = &w.battle.as_ref().unwrap().units[me]; assert!(!wet(&w, u.x, u.y), "t{t}: waded at {},{}", u.x, u.y); assert_eq!(st(&w, di), DB_UP); }
    let u = &w.battle.as_ref().unwrap().units[me]; assert!(u.y < 24.0, "he stayed on our side: {}", u.y);
}

#[test]
fn raiders_get_no_dry_footing_from_a_lent_drawbridge() {
    let (mut w, di) = moat_village(true);
    assert!(w.start_raid(std::f32::consts::FRAC_PI_2, &[4, 0, 0, 0, 0, 0], 0));
    w.buildings[di as usize].status = DB_LENT_FIGHT;   // lent right now
    let wetd: Vec<(f32, f32, f32)> = w.buildings.iter().filter(|x| matches!(x.kind, MOAT | RIVER)).map(|x| (x.x, x.y, if x.kind == MOAT { MOAT_FLOOR * moat_scale(x) + 0.5 } else { RIVER_FLOOR + 0.5 })).collect();
    let b = w.battle.as_mut().unwrap();
    let r = b.units.iter().position(|u| u.side == 1).unwrap();
    b.units[r].x = 0.0; b.units[r].y = 23.0;
    World::attacker_step(b, r, 0.0, 1.0, 0.1, &[], &wetd, 1337, &mut Vec::new());
    assert!(b.units[r].wading, "a raider on the lent deck still wades: the deck is for our own soldiers");
}

#[test]
fn a_big_fight_across_a_moat_never_puts_our_soldiers_in_the_water() {
    for raid_angle in [std::f32::consts::FRAC_PI_2, 0.5, 2.5] {
        let (mut w, di) = moat_village(true);
        w.army = [12, 6, 0, 0, 0, 0];
        let id = w.det_form(&[12, 6, 0, 0, 0, 0]);
        assert!(w.start_raid(raid_angle, &[14, 6, 3, 0, 0, 0], 0));
        assert_eq!(w.det_defend(id), 0);
        let mut worst = 0usize; let mut ticks = 0;
        for _ in 0..300 { tick(&mut w); worst = worst.max(own_wet(&w)); ticks += 1; if !w.battle_active() { break; } }
        eprintln!("angle {raid_angle}: {ticks} ticks, worst own-in-water {worst}, bridge {}", st(&w, di));
        assert_eq!(worst, 0, "angle {raid_angle}");
    }
}


#[test]
fn an_armys_bridge_is_a_real_bridge_that_villagers_and_later_armies_use() {
    let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
    ring(&mut w, 24.0, 52, MOAT); w.after_change();
    w.army = [8, 0, 4, 0, 0, 0];
    let id = w.det_form(&[8, 0, 4, 0, 0, 0]); assert!(id > 0);
    assert_eq!(w.det_march(id, 0.0, 50.0, false, 0.0, 0.0), 0);
    for _ in 0..200 { w.step(); if w.det_flat()[2] > 33.0 { break; } }
    // the same building the player builds: in the buildings, in the list the client draws bridges from, marked as an army's
    let b = w.buildings.iter().position(|b| b.kind == BRIDGE).expect("the army left a bridge building");
    assert_eq!(w.buildings[b].mode, 1); assert!(w.bridges.is_empty(), "no bare crossing any more");
    let spans = w.bridge_spans_flat(); assert_eq!(spans.len(), 10); assert_eq!(spans[0] as usize, b);
    let (ux, uy, l) = World::bridge_dir(&w.buildings[b]); let (bx, by) = (w.buildings[b].x, w.buildings[b].y);
    assert!(l >= 4.0, "it spans the moat and reaches the banks: {l}");
    // villagers walk over it (the path network knows it as it knows the player's bridges)
    let (ax, ay, cx, cy) = (bx - ux * (l / 2.0 + 3.0), by - uy * (l / 2.0 + 3.0), bx + ux * (l / 2.0 + 3.0), by + uy * (l / 2.0 + 3.0));
    let route = w.walk_route(ax, ay, cx, cy); assert!(!route.is_empty(), "villagers can cross the moat on it");
    // a second army crosses on it without bridging again
    let n = w.field_bridge_count();
    w.army = [6, 0, 0, 0, 0, 0]; let id2 = w.det_form(&[6, 0, 0, 0, 0, 0]); assert!(id2 > 0);
    assert_eq!(w.det_march(id2, 0.0, 50.0, false, 0.0, 0.0), 0);
    for _ in 0..200 { w.step(); }
    assert_eq!(w.field_bridge_count(), n, "the second army used the bridge that was there");
    // and it can be demolished like any building
    assert!(w.demolish(b as u32)); assert_eq!(w.field_bridge_count(), n - 1);
}

#[test]
#[ignore]
fn survey_army_marches() {
    for seed in [1337u64, 7, 42] {
        let (mut ok, mut blocked, mut stalled, mut refused) = (0, 0, 0, 0);
        let mut notes = vec![];
        for k in 0..14 {
            let mut w = World::new(seed, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
            let a = k as f32 * 0.449 + 0.3; let r = 150.0 + (k % 5) as f32 * 120.0;
            let (tx, ty) = (a.cos() * r, a.sin() * r);
            w.army = [10, 4, 4, 2, 2, 2]; let id = w.det_form(&[10, 4, 4, 2, 2, 2]);
            let c = w.det_march(id, tx, ty, false, 0.0, 0.0); if c != 0 { refused += 1; notes.push(format!("refused {c} to {tx:.0},{ty:.0}")); continue; }
            let (mut last, mut still, mut done) = ((0.0f32, 0.0f32), 0, false);
            for t in 0..9000 {
                w.step();
                let f = w.det_flat(); if f.is_empty() { break; }
                let (x, y, s) = (f[1], f[2], f[8] as u8);
                if s == march::S_BLOCKED { blocked += 1; notes.push(format!("blocked at {x:.0},{y:.0} going to {tx:.0},{ty:.0} t{t}")); done = true; break; }
                if s == march::S_IDLE || s == march::S_ARRIVED { if (x - tx).hypot(y - ty) < 12.0 { ok += 1; } else { notes.push(format!("stopped short at {x:.0},{y:.0} of {tx:.0},{ty:.0}")); stalled += 1; } done = true; break; }
                let moving = matches!(s, march::S_MARCH | march::S_HOME);
                if moving && (x - last.0).hypot(y - last.1) < 0.05 { still += 1; } else { still = 0; }
                if still > 120 {
                    let d = &w.dets[0];
                    let gs: Vec<String> = d.grp.iter().map(|g| format!("units {:?} at {:.0},{:.0} wi {}/{} tied {} speed {:.2}", g.units, g.x, g.y, g.wi, g.path.len(), g.tied, g.speed)).collect();
                    // does it ever finish?
                    let mut later = -1i32; for t2 in 0..3000 { w.step(); let f = w.det_flat(); if f.is_empty() || f[8] as u8 != march::S_MARCH { later = t2; break; } }
                    stalled += 1; notes.push(format!("stuck (state {s}) at {x:.0},{y:.0} going to {tx:.0},{ty:.0} t{t}; groups {gs:?}; finished {later} ticks later")); done = true; break;
                }
                last = (x, y);
            }
            if !done { stalled += 1; notes.push(format!("never arrived at {tx:.0},{ty:.0}: at {:.0},{:.0} state {}", w.det_flat()[1], w.det_flat()[2], w.det_flat()[8])); }
        }
        eprintln!("seed {seed}: arrived {ok}, blocked {blocked}, stuck/short {stalled}, refused {refused}");
        for n in notes { eprintln!("   {n}"); }
    }
}

#[test]
#[ignore]
fn survey_route_lengths() {
    let seed = 7u64;
    for k in 0..14 {
        let a = k as f32 * 0.449 + 0.3; let r = 150.0 + (k % 5) as f32 * 120.0; let (tx, ty) = (a.cos() * r, a.sin() * r);
        let mut row = format!("to {tx:.0},{ty:.0} (straight {:.0}):", tx.hypot(ty));
        for (name, u) in [("foot", [10u32, 4, 4, 0, 0, 0]), ("engines", [10, 4, 4, 2, 2, 2])] {
            let w = World::new(seed, 0, 0);
            let (hx, hy) = (w.buildings[0].x, w.buildings[0].y + 9.0);
            for (wt, label) in [(march::WaterTravel::BridgeShortcut, "shortcut"), (march::WaterTravel::ExistingDecks, "decks"), (march::WaterTravel::Build, "build")] {
                let len = w.route_with_water(&u, hx, hy, tx, ty, wt).map(|p| World::route_length(hx, hy, &p)).unwrap_or(-1.0);
                row += &format!(" {name}/{label} {len:.0}");
            }
        }
        eprintln!("{row}");
    }
}

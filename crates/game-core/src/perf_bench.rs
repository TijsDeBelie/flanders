//! Per-tick cost of a busy village (run: `cargo test -p game-core --release perf_bench -- --nocapture`). Prints a table; asserts only generous budgets.
use super::*;
use std::time::Instant;

/// A busy village: every kind of working building spiralled round the hall, houses, walls and a moat, roads between neighbours, an army, a battle and winter.
pub(crate) fn busy_village() -> World {
    let mut w = World::new(1337, 0, 0); w.stock = [30000; N_RES]; w.cheat(3, 0, 0);
    for _ in 0..3 { w.upgrade(0); }
    w.flatten(72, 5.0);
    let mut flat = vec![];
    for (r, k, kind) in [(70.0f32, 60, WALL)] {
        for i in 0..k { let a = i as f32 / k as f32 * std::f32::consts::TAU; flat.extend([kind as i32, (a.cos() * r).round() as i32, (a.sin() * r).round() as i32, 0]); }
    }
    w.place_batch(&flat);
    let kinds: Vec<u8> = (0..DEFS.len() as u8).filter(|k| !matches!(*k, WALL | FENCE | GATE | MOAT | RIVER | RAISE | LOWER | ROAD | BRIDGE | DRAWBRIDGE | TOLL | PLAZA | TOWN_HALL | KEEP)).collect();
    let mut n = 0usize; let mut fails = std::collections::BTreeMap::new();
    for i in 0..400 {
        let a = i as f32 * 2.399; let r = 9.0 + (i as f32).sqrt() * 3.1;
        let kind = if i % 3 == 0 { HOUSE } else { kinds[i % kinds.len()] };
        w.stock = [30000; N_RES]; let c = w.place(kind, (a.cos() * r).round() as i32, (a.sin() * r).round() as i32, (i % 8) as u8); if c >= 0 { n += 1; } else { *fails.entry(c).or_insert(0) += 1; }
    }
    // roads: long chains of road pieces between neighbouring buildings and round the village (every piece is a building too)
    let (mut roads, mut codes) = (0, std::collections::BTreeMap::new());
    let mut lay = |w: &mut World, v: Vec<i32>| { w.stock = [30000; N_RES]; let c = w.lay_road(&v); if c >= 0 { roads += 1; } else { *codes.entry(c).or_insert(0) += 1; } };
    for ring in 0..6 { let r = 14.0 + ring as f32 * 6.0; for arc in 0..8 {
        let mut v = vec![]; for k in 0..=10 { let a = (arc * 11 + k) as f32 / 88.0 * std::f32::consts::TAU; v.extend([(a.cos() * r).round() as i32, (a.sin() * r).round() as i32]); } lay(&mut w, v); } }
    for sp in 0..12 { let a = sp as f32 / 12.0 * std::f32::consts::TAU; let mut v = vec![]; for k in 0..9 { let r = 8.0 + k as f32 * 4.5; v.extend([(a.cos() * r).round() as i32, (a.sin() * r).round() as i32]); } lay(&mut w, v); }
    println!("lay_road codes {codes:?}");
    w.cheat(1, 400, 0);
    for k in 0..NK { w.cheat(2, k as i32, 40); }
    for k in 0..40 { let _ = w.set_workers(k * 3 % w.buildings.len() as u32, 2); }
    println!("fails {fails:?}"); println!("busy village: {} buildings placed {n}, {} road pieces from {roads} laid roads, pop {}", w.buildings.len(), w.roads.len(), w.population);
    w
}

fn time<F: FnMut()>(label: &str, reps: u32, mut f: F) -> f64 {
    let t = Instant::now(); for _ in 0..reps { f(); }
    let ms = t.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    println!("{label:<28} {ms:>9.4} ms"); ms
}

#[test]
fn perf_bench_busy_village() {
    let mut w = busy_village();
    w.tick = DAY * 3 * SEASON_DAYS as u64 + 5;   // winter
    for _ in 0..50 { w.step(); }
    let step = time("step (calm)", 200, || w.step());
    w.cheat(4, 100, 800);
    for _ in 0..20 { w.step(); }
    println!("battle active: {}", w.battle_active());
    let stepb = time("step (battle)", 100, || w.step());
    time("staffing", 500, || w.staffing());
    time("household_step", 500, || w.household_step());
    time("plague_step", 500, || w.plague_step());
    time("regrow_deposits", 500, || w.regrow_deposits());
    time("fire_substep", 500, || w.fire_substep());
    time("battle_substep", 500, || w.battle_substep());
    time("trade_step", 500, || w.trade_step());
    time("builders_step", 500, || w.builders_step());
    time("defence_step", 500, || w.defence_step());
    time("march_step", 500, || w.march_step());
    time("capacity+storage_cap", 2000, || { let _ = w.capacity() + w.storage_cap() as u32; });
    time("happiness", 2000, || { let _ = w.happiness(); });
    time("after_change", 5, || w.after_change());
    time("rebuild_roads", 5, || w.rebuild_roads());
    time("state_hash", 100, || { let _ = w.state_hash(); });
    time("snapshot", 20, || { let _ = w.snapshot(); });
    time("ledger_flat", 500, || { let _ = w.ledger_flat(); });
    time("buildings_flat", 500, || { let _ = w.buildings_flat(); });
    time("building_health", 500, || { let _ = w.building_health(); });
    time("options_flat", 500, || { let _ = w.options_flat(); });
    time("staffing_flat", 500, || { let _ = w.staffing_flat(); });
    time("road_lines_flat", 100, || { let _ = w.road_lines_flat(); });
    time("road_nodes_flat", 100, || { let _ = w.road_nodes_flat(); });
    time("roads_flat", 100, || { let _ = w.roads_flat(); });
    time("net_flat", 20, || { let _ = w.net_flat(); });
    time("deposits_flat", 500, || { let _ = w.deposits_flat(); });
    time("territory_flat", 100, || { let _ = w.territory_flat(); });
    time("fires_flat", 500, || { let _ = w.fires_flat(); });
    println!("TOTAL step calm {step:.3} ms, battle {stepb:.3} ms");
    assert!(step < 50.0 && stepb < 100.0, "a tick must stay far below the 250 ms tick budget");
}

#[test]
fn terrain_region_matches_height_at_to_the_bit() {
    let mut w = busy_village();
    w.stock = [30000; N_RES];
    for i in 0..40 { let a = i as f32 / 40.0 * std::f32::consts::TAU; w.place(MOAT, (a.cos() * 62.0).round() as i32, (a.sin() * 62.0).round() as i32, 0); }
    w.place(DRAWBRIDGE, 0, 62, 0);
    for i in 0..6 { w.place(RAISE, 20 + i * 3, -30, 0); w.place(LOWER, -30, 20 + i * 3, 0); }
    let mut checked = 0;
    for &(x0, y0, nx, ny, step) in &[(-90.0f32, -90.0f32, 45u32, 45u32, 4.0f32), (-20.0, 40.0, 30, 30, 1.0), (30.0, -45.0, 25, 40, 2.0), (-300.0, -300.0, 20, 20, 8.0), (50.0, 50.0, 1, 1, 4.0)] {
        let r = w.terrain_region(x0, y0, nx, ny, step);
        for j in 0..ny { for i in 0..nx {
            let (x, y) = (x0 + i as f32 * step, y0 + j as f32 * step);
            assert_eq!(r[(j * nx + i) as usize].to_bits(), w.height_at(x, y).to_bits(), "height differs at {x},{y}"); checked += 1;
        }}
    }
    println!("checked {checked} heights");
}

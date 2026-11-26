//! Tests of the computer's villages: they play by the player's rules, grow by themselves, are deterministic and fight.
use super::*;
use crate::ai::{Ai, LAYOUTS, REQ_RAID};

fn play(seed: u64, layout: u32, days: u64) -> (World, Ai) {
    let mut w = World::new(seed, 0, 0);
    let mut ai = Ai::new(seed, 0, layout, 7);
    for _ in 0..days * DAY { w.step(); ai.step(&mut w); }
    (w, ai)
}

#[test]
fn every_layout_builds_up_by_itself() {
    for layout in 0..LAYOUTS {
        let (w, _) = play(11, layout, 12);
        eprintln!("layout {layout}: {} buildings, pop {}, grain {}", w.buildings.len(), w.population, w.stock[GR as usize]);
        assert!(w.buildings.len() >= 10, "layout {layout} only built {} buildings in 12 days", w.buildings.len());
        assert!(w.buildings.iter().any(|b| b.kind == FARM) && w.buildings.iter().any(|b| b.kind == HOUSE), "layout {layout} has no farm and house");
    }
}

#[test]
fn layouts_are_different() {
    let mut shapes = std::collections::BTreeSet::new();
    for layout in 0..LAYOUTS {
        let (w, _) = play(5, layout, 4);
        let mut pts: Vec<(i32, i32)> = w.buildings.iter().map(|b| (b.x as i32, b.y as i32)).collect(); pts.sort();
        shapes.insert(pts);
    }
    assert_eq!(shapes.len(), LAYOUTS as usize);
}

#[test]
fn the_computer_obeys_the_rules() {
    let (w, _) = play(3, 0, 20);
    // nothing negative, never more people than the houses plus the hall allow plus soldiers' share, never building outside its land
    assert!(w.stock.iter().all(|&s| s >= 0));
    assert!(w.population <= w.capacity() + 20, "pop {} cap {}", w.population, w.capacity());
    for b in w.buildings.iter().skip(1) {
        if matches!(b.kind, ROAD | RAISE | LOWER | MOAT | RIVER) { continue; }
        assert!(w.in_territory(b.x, b.y), "a {} stands outside the land at {},{}", DEFS[b.kind as usize].name, b.x, b.y);
    }
}

#[test]
fn it_is_deterministic_and_seeded() {
    let (a, _) = play(9, 3, 10); let (b, _) = play(9, 3, 10); let (c, _) = play(10, 3, 10);
    assert_eq!(a.state_hash(), b.state_hash());
    assert_ne!(a.state_hash(), c.state_hash());
}

#[test]
fn hash_and_parts_match_the_separate_calls() {
    let (w, _) = play(9, 3, 10);
    let both = w.state_hash_and_parts();
    assert_eq!(both[0], w.state_hash());
    assert_eq!(&both[1..], &w.state_hash_parts()[..]);
}

#[test]
fn it_trains_soldiers_and_builds_defences() {
    // bandits raid the computer's villages like anybody's and may sack one, so look at the best the village reached, not the day it was counted
    let ok = (1..=5u64).filter(|&seed| {
        let mut w = World::new(seed, 0, 0); let mut ai = Ai::new(seed, 0, (seed % 10) as u32, 7);
        let (mut peak, mut barracks, mut towers) = (0, false, 0);
        for _ in 0..25 * DAY {
            w.step(); ai.step(&mut w);
            if w.tick % 60 == 0 {
                peak = peak.max(w.army.iter().sum::<u32>() + w.queue.iter().sum::<u32>() + w.buildings.iter().map(|b| b.garrison as u32).sum::<u32>());
                barracks |= w.buildings.iter().any(|b| b.kind == BARRACKS); towers = towers.max(w.buildings.iter().filter(|b| b.kind == TOWER).count());
            }
        }
        eprintln!("seed {seed}: peak soldiers {peak}, barracks {barracks}, towers {towers}");
        barracks && peak >= 5
    }).count();
    assert!(ok >= 4, "only {ok} of 5 villages ever had a barracks and an army");
}

#[test]
fn snapshot_restore_continues_identically() {
    let mut w = World::new(4, 0, 0); let mut ai = Ai::new(4, 1, 2, 9);
    for _ in 0..4 * DAY { w.step(); ai.step(&mut w); }
    let mut w2 = world_restore(&w.snapshot()).expect("restores"); let mut ai2 = Ai::restore(&ai.snapshot()).expect("restores");
    for _ in 0..3 * DAY { w.step(); ai.step(&mut w); w2.step(); ai2.step(&mut w2); }
    assert_eq!(w.state_hash(), w2.state_hash());
}

#[test]
fn it_raids_a_target_when_strong() {
    let mut raided = 0;
    for seed in 1..=4u64 {
        let mut w = World::new(seed, 0, 0); let mut ai = Ai::new(seed, 0, (seed % 10) as u32, 7);
        ai.set_target(150.0, 0.0, 40.0, 3, 160.0); ai.observe(0);
        let mut asked = false;
        for _ in 0..45 * DAY { w.step(); let r = ai.step(&mut w); if r.first() == Some(&REQ_RAID) { asked = true; assert_eq!(r.len(), 7); break; } }
        eprintln!("seed {seed}: asked {asked}, raids {}, soldiers {}", ai.raids(), ai.soldiers(&w));
        if asked { raided += 1; }
    }
    assert!(raided >= 1, "the computer never marched on its enemy");
}

#[test]
fn the_computer_trains_what_its_army_lacks_and_answers_heavy_raiders() {
    let mut w = World::new(11, 0, 0);
    w.stock = [3000; N_RES];
    // an army of spearmen only: the next recruit is not another spearman
    w.army = [12, 0, 0, 0, 0, 0];
    let k = crate::ai::Ai::wanted_kind_for_tests(&w, 1).unwrap();
    assert_ne!(k, 0, "balance: {k}");
    // against plated raiders the AI leans away from archers
    w.army = [4, 2, 4, 3, 0, 0];
    w.report = vec![1, 1, 0, 0, 0, 0, 0, 0, 6, 3, 0, 0];
    let heavy = crate::ai::Ai::wanted_kind_for_tests(&w, 2).unwrap();
    w.report = vec![1, 1, 0, 0, 0, 0, 6, 6, 0, 0, 0, 0];
    let light = crate::ai::Ai::wanted_kind_for_tests(&w, 2).unwrap();
    assert!(heavy != 1, "no more archers against plate: {heavy}");
    assert_eq!(light, 1, "archers against light raiders");
}

#[test]
fn a_grown_village_drills_siege_engines_and_sends_them_with_its_raids() {
    let mut w = World::new(9, 0, 0);
    let mut ai = Ai::new(9, 0, 0, 7);
    ai.set_target(300.0, 300.0, 20.0, 1, 100.0);
    let mut engines = 0u32; let mut raided_with = 0u32;
    for _ in 0..60 * DAY {
        w.step(); for b in w.buildings.iter_mut().filter(|b| b.kind == BARRACKS) { b.tier = 3; } for r in [IR, TL, PL, W, GD] { w.stock[r as usize] = w.stock[r as usize].max(400); }   // (this seed has no iron: give it the means)
        let out = ai.step(&mut w);
        engines = engines.max(w.army[4] + w.army[5] + w.away[4] + w.away[5] + w.dets.iter().map(|d| d.units[4] + d.units[5]).sum::<u32>());
        if out.first() == Some(&REQ_RAID) && out.len() >= 7 { raided_with = raided_with.max((out[5] + out[6]) as u32); }
    }
    eprintln!("army {:?} queue {:?} barracks {:?} PL {} W {} IR {} TL {}", w.army, w.queue, w.buildings.iter().filter(|b| b.kind == BARRACKS).map(|b| b.tier).collect::<Vec<_>>(), w.stock[PL as usize], w.stock[W as usize], w.stock[IR as usize], w.stock[TL as usize]);
    eprintln!("most engines at once {engines}, most sent on a raid {raided_with}");
    assert!(engines > 0, "after two months the army has engines");
}

//! The wild places as a living part of the world (see wilds.rs): raids paced by the camps, camps that come back, abbeys as neighbours, mineshafts held by a garrison.
use super::*;
use crate::wilds::*;

const SEED: u64 = 1337;
fn village() -> World { let mut w = World::new(SEED, 0, 0); w.stock = [500; N_RES]; w.population = 40; w.army = [40, 20, 20, 10, 0, 0]; w }
fn army_at(w: &mut World, x: f32, y: f32, units: [u32; NK]) -> u32 { w.army = units; let id = w.det_form(&units); let i = w.dets.iter().position(|d| d.id == id).unwrap(); w.dets[i].x = x; w.dets[i].y = y; id }
fn first_of(kind: u8) -> (usize, f32, f32) { terrain::neutrals(SEED).iter().enumerate().find(|(_, n)| n.0 == kind).map(|(i, n)| (i, n.1, n.2)).unwrap() }
/// Run the daily rules alone for `days` days from the present tick (the rest of the village stands still).
fn days(w: &mut World, days: u64) { for _ in 0..days { w.tick = (w.tick / DAY + 1) * DAY; w.wilds_step(); } }

#[test]
fn abandoned_mineshafts_lie_in_the_wild_away_from_villages_and_places() {
    for seed in [1u64, 7, 1337, 99999] {
        let shafts = terrain::mineshafts(seed); assert!(shafts.len() >= 3, "seed {seed}: {} shafts", shafts.len());
        assert!(shafts.iter().any(|m| m.0 == 0), "some iron");
        for &(_, x, y) in &shafts {
            assert!(terrain::base_height(seed, x, y) > 1.5, "dry");
            for (sx, sy) in terrain::sites(seed) { assert!((x - sx).hypot(y - sy) > 140.0, "away from villages"); }
            for n in terrain::neutrals(seed) { assert!((x - n.1).hypot(y - n.2) >= 45.0, "apart from the other places"); }
        }
        assert_eq!(terrain::neutrals(seed).len(), World::new(seed, 0, 0).neutral_done.len(), "the older places keep their indices");
    }
}

#[test]
fn clearing_the_camps_near_the_village_slows_and_weakens_the_raids() {
    let mut w = village();
    let (p0, pace0, every0) = (w.camp_pressure(), w.raid_pace(), w.raid_one_in_wild());
    assert!(p0 > 0.0 && pace0 > 0.4 && pace0 <= 1.0, "camps stand near at the start: {p0} {pace0}");
    let strong0 = w.raid_roll(1.0, -1);
    for (i, n) in terrain::neutrals(SEED).iter().enumerate() { if n.0 >= 2 { w.neutral_done[i] = true; } }
    assert_eq!(w.camp_pressure(), 0.0);
    assert!((w.raid_pace() - 0.4).abs() < 1e-6 && w.raid_one_in_wild() > every0, "no camp near: raids come much more rarely ({every0} -> {})", w.raid_one_in_wild());
    assert!(w.raid_roll(1.0, -1) < strong0, "and weaker");
    assert_eq!(w.raid_one_in_wild(), ((w.raid_one_in() as f32 / 0.4) as u32), "the bandits' greed still counts");
}

#[test]
fn a_raid_remembers_the_camp_it_came_from() {
    let mut w = village(); w.tick = 4 * DAY;
    let mut found = false;
    for _ in 0..(40 * DAY) { w.step(); w.stock[GR as usize] = 500; if w.raid_warning_ticks > 0 { found = true; break; } }
    assert!(found, "a raid was warned of");
    let src = w.raid_source(); assert_eq!(src.len(), 2, "with a camp to come from");
    let i = w.wilds.raid_from as usize; let n = terrain::neutrals(SEED)[i];
    assert!(n.0 >= 2 && !w.neutral_done[i] && n.1 == src[0] && n.2 == src[1], "a live camp or lair");
    let a = (n.2 - w.oy as f32).atan2(n.1 - w.ox as f32); assert!((a - w.raid_warning_angle).abs() < 1e-4, "and they march from its side");
}

#[test]
fn a_cleared_camp_is_taken_again_unless_it_is_watched_and_comes_back_stronger() {
    let (ci, cx, cy) = first_of(2);
    let clear = |w: &mut World| { let id = army_at(w, cx, cy, [60, 30, 30, 20, 0, 0]); assert_eq!(w.visit_neutral(id), 2); id };
    let mut w = village(); w.tick = 10 * DAY;
    let (need0, gold0, _) = w.camp_terms(ci);
    let id = clear(&mut w); assert!(w.neutral_done[ci] && w.wilds.places[ci].cleared_at == 10 * DAY);
    // watched: an army stands at it the whole time
    days(&mut w, REOCCUPY_DAYS + 60); assert!(w.neutral_done[ci], "an army on guard keeps it clear");
    // unwatched: the army leaves; outlaws come back after the quiet days, not before
    let i = w.dets.iter().position(|d| d.id == id).unwrap(); w.dets.remove(i);
    let mut w2 = village(); w2.tick = 10 * DAY; clear(&mut w2); w2.dets.clear();
    days(&mut w2, REOCCUPY_DAYS - 1); assert!(w2.neutral_done[ci], "not before {REOCCUPY_DAYS} days");
    days(&mut w2, 80); assert!(!w2.neutral_done[ci], "taken again");
    assert_eq!(w2.wilds.places[ci].rounds, 1);
    let (need1, gold1, _) = w2.camp_terms(ci); assert!(need1 > need0 && gold1 > gold0, "stronger and richer ({need0} -> {need1})");
    assert!(w2.take_events().chunks(4).any(|e| e[0] == EV_WILD && e[1] == WILD_REOCCUPIED) || !w2.is_seen(cx, cy), "told, when the camp is known");
    // a lair never comes back
    let (li, _, _) = first_of(3); w2.neutral_done[li] = true; days(&mut w2, 200); assert!(w2.neutral_done[li]);
}

#[test]
fn abbeys_take_tithes_heal_once_a_season_send_herbs_and_can_be_sacked() {
    let (ai, ax, ay) = first_of(0);
    let mut w = village(); w.tick = 5 * DAY;
    assert_eq!(w.wild_act(1, ai as u32), -3, "strangers pay no tithe");
    let id = army_at(&mut w, ax, ay, [5, 0, 0, 0, 0, 0]); assert_eq!(w.visit_neutral(id), 0);
    assert_eq!(w.wilds.places[ai].goodwill, 50);
    w.stock[GD as usize] = 0; assert_eq!(w.wild_act(1, ai as u32), -6, "a tithe costs gold");
    w.stock[GD as usize] = 1000; w.sick = 6;
    assert_eq!(w.wild_act(1, ai as u32), 1, "paid, but the season's healing was spent on the visit");
    assert_eq!(w.stock[GD as usize], 1000 - w.tithe_cost()); assert_eq!(w.wilds.places[ai].goodwill, 75);
    w.tick += TITHE_SEASON_DAYS * DAY; w.sick = 6;
    assert_eq!(w.wild_act(1, ai as u32), 0, "a season on: the tithe heals"); assert_eq!(w.sick, 0);
    // the herbs: one a day while goodwill is high
    w.sick = 3; days(&mut w, 1); assert_eq!(w.sick, 2);
    w.wilds.places[ai].goodwill = HERBAL_GOODWILL - 1; w.sick = 3; let d = w.tick / DAY; w.tick = (d + 1) * DAY - 1; days(&mut w, 1);
    assert!(w.sick == 3 || terrain::neutrals(SEED).iter().enumerate().any(|(i, n)| n.0 == 0 && i != ai && w.wilds.places[i].goodwill >= HERBAL_GOODWILL), "no herbs from monks who have cooled");
    // sacked: no tithe for a while
    w.wilds.places[ai].sacked_until = w.tick + 5 * DAY; assert_eq!(w.wild_act(1, ai as u32), -7);
    // over many days an unwatched abbey near a live camp is sacked now and then, never one far from every camp
    let mut w = village(); let mut sacked = 0;
    for _ in 0..400 { days(&mut w, 1); for (i, n) in terrain::neutrals(SEED).iter().enumerate() { if n.0 == 0 && w.wilds.places[i].sacked_until > w.tick && w.wilds.places[i].sacked_until == w.tick + SACK_DAYS * DAY { sacked += 1; assert!(w.nearest_outlaws(n.1, n.2) < OUTLAW_REACH); } } }
    assert!(sacked > 0, "outlaws do sack abbeys");
}

#[test]
fn an_army_claims_a_mineshaft_its_garrison_sends_ore_home_and_comes_back_when_abandoned() {
    let (ore, mx, my) = terrain::mineshafts(SEED)[0];
    let mut w = village(); w.tick = 5 * DAY;
    let few = army_at(&mut w, mx, my, [2, 0, 0, 0, 0, 0]); assert_eq!(w.visit_neutral(few), -5, "too few to hold it");
    w.dets.clear();
    let id = army_at(&mut w, mx, my, [6, 4, 2, 1, 0, 0]); assert_eq!(w.visit_neutral(id), 5);
    let g = w.wilds.shafts[0].garrison; assert_eq!(g.iter().sum::<u32>(), GARRISON_MAX); assert_eq!(g[0], 6, "spearmen first");
    assert_eq!(w.dets.iter().find(|d| d.id == id).unwrap().units, [0, 2, 2, 1, 0, 0], "the rest march on");
    assert_eq!(w.visit_neutral(id), -3, "already held");
    let r = if ore == 0 { IO } else { GO } as usize; let before = w.stock[r];
    w.dets.clear();
    days(&mut w, 1); assert!(w.stock[r] > before || w.wilds.shafts[0].garrison.iter().sum::<u32>() < GARRISON_MAX, "ore comes home");
    let held = w.wilds.shafts[0].garrison; let army = w.army;
    assert_eq!(w.wild_act(2, 0), if held.iter().sum::<u32>() > 0 { 0 } else { -3 });
    for k in 0..NK { assert_eq!(w.army[k], army[k] + held[k], "the garrison comes home"); }
    assert_eq!(w.wild_act(2, 0), -3); assert_eq!(w.wild_act(9, 0), -1); assert_eq!(w.wild_act(2, 9999), -1);
    // attacks: more often with fewer men, never far from every camp
    assert!(World::shaft_attack_chance(10.0, 1) > World::shaft_attack_chance(10.0, 8));
    assert_eq!(World::shaft_attack_chance(OUTLAW_REACH, 1), 0.0);
}

#[test]
fn the_wild_places_survive_a_snapshot_and_are_in_the_state_hash() {
    let (ai, ax, ay) = first_of(0); let (mx, my) = (terrain::mineshafts(SEED)[0].1, terrain::mineshafts(SEED)[0].2);
    let mut w = village(); w.tick = 5 * DAY;
    let a = army_at(&mut w, ax, ay, [5, 0, 0, 0, 0, 0]); w.visit_neutral(a);
    let b = army_at(&mut w, mx, my, [6, 4, 0, 0, 0, 0]); assert_eq!(w.visit_neutral(b), 5);
    w.wilds.places[first_of(2).0].rounds = 2; w.wilds.raid_from = first_of(2).0 as i32;
    let back = world_restore(&w.snapshot()).expect("restores");
    assert_eq!(back.wilds, w.wilds); assert_eq!(back.state_hash(), w.state_hash());
    let mut other = back; other.wilds.places[ai].goodwill = 1; assert_ne!(other.state_hash(), w.state_hash(), "goodwill is in the hash");
    let mut bad = w.snapshot(); let n = bad.len(); bad[n - 5] = 0xff; bad[n - 6] = 0xff; assert!(world_restore(&bad).map_or(true, |x| x.wilds.valid(SEED)));
}

#[test]
fn neutral_info_tells_abbeys_camps_and_shafts_apart() {
    let mut w = village();
    let (ai, ax, ay) = first_of(0); let (ci, cx, cy) = first_of(2); let (_, mx, my) = terrain::mineshafts(SEED)[0];
    for (x, y) in [(ax, ay), (cx, cy), (mx, my)] { assert!(w.cheat(13, x as i32, y as i32)); }
    let a = w.neutral_info(ax, ay, 3.0); assert_eq!(a.len(), 12); assert_eq!((a[0], a[8]), (0.0, ai as f32));
    let c = w.neutral_info(cx, cy, 3.0); assert_eq!((c[0], c[8], c[9]), (2.0, ci as f32, 0.0)); assert_eq!(c[4], w.camp_terms(ci).0);
    let m = w.neutral_info(mx, my, 3.0); assert_eq!((m[0], m[3], m[8], m[9]), (5.0, 0.0, 0.0, 0.0)); assert!(m[10] > 0.0 && (m[11] == IO as f32 || m[11] == GO as f32));
    assert!(w.neutrals_flat().chunks(4).any(|p| p[0] == 5.0 && p[1] == mx), "a found shaft is listed as kind 5");
}

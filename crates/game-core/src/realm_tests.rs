//! How the village is ruled (see realm.rs): decrees, needs, growth and leaving, wages, titles and charters, the focus, the first raid.
use super::*;
use crate::realm::*;

fn village() -> World { let mut w = World::new(1337, 0, 0); w.stock = [500; N_RES]; w.population = 30; w.tick = 10 * DAY; w }
fn next_day(w: &mut World) { w.tick = (w.tick / DAY + 1) * DAY; w.realm_step(); }

#[test]
fn decrees_trade_gold_food_and_work_against_happiness() {
    let base = village(); let h0 = base.happiness(); let (_, eat0) = base.appetite();
    let mut w = village();
    assert_eq!(w.realm_act(1, 2), 0); assert_eq!(w.tax_pct(), 150); assert_eq!(w.happiness(), h0 - 8, "high taxes cost happiness");
    assert_eq!(w.realm_act(1, 1), 0); assert_eq!(w.tax_pct(), 50); assert_eq!(w.happiness(), h0 + 6);
    w.realm_act(1, 0);
    assert_eq!(w.realm_act(2, 1), 0); assert_eq!(w.appetite().1, eat0 * 80 / 100, "lean rations"); assert_eq!(w.happiness(), h0 - 6);
    w.realm_act(2, 0);
    let farm = w.place(FARM, 30, 0, 0); assert!(farm > 0);
    let pace0 = w.work_pace(farm as u32)[3];
    assert_eq!(w.realm_act(3, 1), 0); assert_eq!(w.work_pace(farm as u32)[3], pace0 * 115 / 100, "long hours"); assert_eq!(w.happiness(), h0 - 6);
    assert_eq!(w.realm_act(4, 1), 0); assert_eq!(w.militia_pct(), 200, "a muster doubles the militia");
    assert_eq!(w.realm_act(1, 3), -1); assert_eq!(w.realm_act(9, 0), -1);
}

#[test]
fn happiness_sets_the_pace_growth_and_whether_people_stay() {
    let w = village();
    assert_eq!(w.realm_pace(FARM, 10), 90); assert_eq!(w.realm_pace(FARM, 50), 100); assert_eq!(w.realm_pace(FARM, 80), 105);
    assert!(w.arrival_one_in(90) < w.arrival_one_in(40) && w.arrival_one_in(40) < w.arrival_one_in(10), "a happy village draws people faster");
    assert_eq!(w.arrival_one_in(40), (DAY as u32) / 6, "six a day at 40");
    // unrest: one leaves a day, but not while the village settles in
    let mut w = village(); w.realm.tax = TAX_HIGH; w.realm.rations = RATIONS_LEAN; w.realm.long_hours = true; for &(f, _) in FOODS.iter() { w.stock[f as usize] = 0; }
    assert!(w.happiness() < UNREST);
    let pop = w.population; next_day(&mut w); assert_eq!(w.population, pop - 1, "an unhappy villager leaves");
    let mut young = World::new(1337, 0, 0); young.realm.tax = TAX_HIGH; young.realm.rations = RATIONS_LEAN; young.realm.long_hours = true; young.population = 20;
    let p = young.population; next_day(&mut young); assert_eq!(young.population, p, "not in the first days");
}

#[test]
fn better_houses_need_more_of_the_village() {
    let mut w = village(); w.stock[TL as usize] = 0;
    for &r in &[BD, FI, SF, ME, SM] { w.stock[r as usize] = 0; }
    let h = w.place(HOUSE, 20, 10, 0); assert!(h > 0);
    assert_eq!(w.upgrade(h as u32), -31, "tier 1 wants a second food");
    w.stock[BD as usize] = 50; assert_eq!(w.upgrade(h as u32), 0);
    assert_eq!(w.upgrade(h as u32), -31, "tier 2 wants a market and a chapel");
    let before = w.happiness(); w.buildings[h as usize].tier = 2;
    assert!(w.happiness() < before, "a house whose needs are unmet costs happiness");
    assert_eq!(w.house_needs()[5..].to_vec(), vec![1, 0, 0, 0, 0]);
}

#[test]
fn soldiers_are_paid_and_desert_when_the_chest_is_empty() {
    let mut w = village(); w.army = [9, 0, 0, 0, 0, 0];
    assert_eq!(w.wages().2, 3, "one coin a day for three at home");
    let gold = w.stock[GD as usize]; next_day(&mut w); assert_eq!(w.stock[GD as usize], gold - 3);
    let id = w.det_form(&[6, 0, 0, 0, 0, 0]); assert!(id > 0); assert_eq!(w.wages().2, 1 + 3, "one for two in the field");
    w.stock[GD as usize] = 0; w.take_events(); next_day(&mut w);
    assert_eq!(w.army.iter().sum::<u32>() + w.dets.iter().map(|d| d.units.iter().sum::<u32>()).sum::<u32>(), 8, "one deserts");
    assert!(w.take_events().chunks(4).any(|e| e[0] == EV_REALM && e[1] == R_DESERTED));
}

#[test]
fn renown_raises_titles_that_grant_charters_and_harder_raids() {
    let mut w = village();
    assert_eq!(w.realm_act(5, CH_MINING as i32), -2, "a mere lord grants no charter");
    w.population = 200; next_day(&mut w);
    assert!(w.realm.title >= 1, "renown {} makes a baron", w.renown());
    assert_eq!(w.realm_act(5, CH_MINING as i32), 0); assert_eq!(w.realm_act(5, CH_MINING as i32), -1, "a charter once");
    w.population = 10; next_day(&mut w); assert!(w.realm.title >= 1, "a title is kept");
    assert_eq!(w.realm_pace(6, 50), 115, "the mining charter");
    w.realm.bandit_raids = 1; w.realm.title = 0; let plain: u32 = w.bandit_raid_force(0.5).iter().sum();
    w.realm.title = 3; let duke: u32 = w.bandit_raid_force(0.5).iter().sum();
    assert!(duke > plain, "a duke's village is raided harder ({plain} -> {duke})");
}

#[test]
fn the_first_bandit_raid_is_a_small_one() {
    let mut w = village();
    let first: u32 = w.bandit_raid_force(0.5).iter().sum(); let second: u32 = w.bandit_raid_force(0.5).iter().sum();
    assert!(first * 2 <= second + 2 && first > 0, "half strength the first time ({first} vs {second})");
}

#[test]
fn a_focus_is_proposed_costs_its_price_and_runs_out() {
    let mut w = World::new(1337, 0, 0); w.stock = [500; N_RES];
    w.tick = (FOCUS_FIRST_DAY - 1) * DAY; next_day(&mut w);
    let offer = w.focus_offer(); assert!((3..=4).contains(&offer.len()), "three or four areas on offer: {offer:?}");
    let mut seen = offer.clone(); seen.sort(); seen.dedup(); assert_eq!(seen.len(), offer.len(), "no area twice");
    assert_eq!(w.choice_flat()[1], offer.len() as i32 + 1, "and a way to turn them all down");
    let pick = offer[0]; let cost = realm::focus_cost(pick); let before: Vec<i32> = cost.iter().map(|&(r, _)| w.stock[r as usize]).collect();
    assert_eq!(w.choose(0), 0);
    for (k, &(r, n)) in cost.iter().enumerate() { assert_eq!(w.stock[r as usize], before[k] - n, "the focus is paid for"); }
    assert!(w.focus_on(pick) && w.focus_offer().is_empty());
    assert_eq!(w.realm_flat()[8], pick as i32); assert_eq!(w.realm_flat()[9], FOCUS_DAYS as i32);
    for _ in 0..FOCUS_DAYS { next_day(&mut w); }
    assert!(!w.focus_on(pick), "it runs out");
    // the next offer comes a while later; turning it down costs nothing
    while w.focus_offer().is_empty() { next_day(&mut w); assert!(w.tick < 100 * DAY); }
    let gold = w.stock; let none = w.focus_offer().len() as u8; assert_eq!(w.choose(none), 0); assert_eq!(w.stock, gold); assert_eq!(w.realm.focus, 0);
    // a focus too dear is refused
    while w.focus_offer().is_empty() { next_day(&mut w); }
    w.stock = [0; N_RES]; assert_eq!(w.choose(0), -6);
}

#[test]
fn each_focus_does_what_it_says() {
    let on = |f: u8| { let mut w = village(); w.realm.focus = f; w.realm.focus_until = w.tick + 5 * DAY; w };
    assert_eq!(on(F_FARMING).realm_pace(FARM, 50), 125);
    assert_eq!(on(F_MINING).realm_pace(6, 50), 130);
    assert_eq!(on(F_WAR).train_pct(), 150);
    assert_eq!(on(F_TRADE).tax_pct(), 125); assert!(on(F_TRADE).markup_pct() < market::MARKUP_PCT);
    let h = village().happiness(); assert_eq!(on(F_FAITH).happiness(), (h + 8).min(100));
    let mut d = on(F_DIPLOMACY); d.relations = vec![(3, 0)]; next_day(&mut d); assert_eq!(d.relations[0].1, 1);
}

#[test]
fn the_realm_survives_a_snapshot_and_is_in_the_hash() {
    let mut w = village(); w.realm_act(1, 2); w.realm_act(3, 1); w.realm.title = 2; w.realm_act(5, 0); w.realm.focus = F_WAR; w.realm.focus_until = w.tick + DAY;
    let back = world_restore(&w.snapshot()).expect("restores");
    assert_eq!(back.realm, w.realm); assert_eq!(back.state_hash(), w.state_hash());
    let mut other = back; other.realm.muster = true; assert_ne!(other.state_hash(), w.state_hash());
}

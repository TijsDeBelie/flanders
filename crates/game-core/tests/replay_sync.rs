//! The multiplayer promise: a copy of a village that replays the owner's command log arrives at exactly the owner's state, whatever else the copy's host
//! did in between (draw the village every tick, ask for routes, step in bursts, be built from the log in one go). These tests record a busy session in one
//! world and replay it in others with different habits, comparing `state_hash` tick by tick. The first tick at which two worlds differ names the culprit.
use game_core::World;

#[derive(Clone, Debug)]
enum C {
    Place(u8, i32, i32, u8), Upgrade(u32), Demolish(u32), Train(u8, u32), Cheat(u8, i32, i32), Form([u32; 5]), March(u32, f32, f32), Recall(u32), Halt(u32),
    Link(f32, f32), Bridge(u32, bool), Gate(u32, bool), Raid(f32, [u32; 5], i32), Batch(Vec<i32>), Split(u32, [u32; 5]), Defend(u32), Choose(u8),
    Rel(i32, i32), Journey(u8, i32, i32, f32), Caravan(u8, i32, i32, f32, u32),
}

fn apply(w: &mut World, c: &C) {
    match c {
        C::Place(k, x, y, r) => { w.place(*k, *x, *y, *r); }
        C::Upgrade(i) => { w.upgrade(*i); }
        C::Demolish(i) => { w.demolish(*i); }
        C::Train(k, n) => { w.train(*k, *n); }
        C::Cheat(a, b, d) => { w.cheat(*a, *b, *d); }
        C::Form(u) => { w.det_form(u); }
        C::March(id, x, y) => { w.det_march(*id, *x, *y, false, 0.0, 0.0); }
        C::Recall(id) => { w.det_recall(*id); }
        C::Halt(id) => { w.det_halt(*id); }
        C::Link(x, y) => { w.link_village(*x, *y); }
        C::Bridge(i, up) => { w.drawbridge_set(*i, *up); }
        C::Gate(i, s) => { w.gate_set(*i, *s); }
        C::Raid(a, u, t) => { w.start_raid(*a, u, *t); }
        C::Batch(v) => { w.place_batch(v); }
        C::Split(id, u) => { w.det_split(*id, u); }
        C::Defend(id) => { w.det_defend(*id); }
        C::Choose(o) => { w.choose(*o); }
        C::Rel(t, d) => { w.rel_add(*t, *d); }
        C::Journey(k, t, a, d) => { w.journey_start(*k, *t, *a, *d); }
        C::Caravan(r, a, t, d, e) => { w.caravan_send(*r, *a, *t, *d, *e); }
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
    fn range(&mut self, lo: i32, hi: i32) -> i32 { lo + self.below((hi - lo + 1) as u64) as i32 }
}

/// Everything a client's renderer asks the core every tick. These calls fill the core's caches (paths, overlays) at moments of the host's choosing.
fn look(w: &mut World) -> usize {
    let mut n = w.det_flat().len() + w.buildings_flat().len() + w.roads_flat().len() + w.road_paths_flat().len() + w.felled_flat().len() + w.bridges_flat().len();
    n += w.journeys_flat().len() + w.link_points(400.0, 0.0).len() + w.take_arrivals().len() + w.take_delivered().len();
    let f = w.det_flat(); for o in (0..f.len()).step_by(16) { n += w.det_path(f[o] as u32).len(); }
    n + w.net_route(-30.0, -30.0, 60.0, 40.0).len() + w.walk_route(10.0, 10.0, -50.0, 80.0).len()
}

/// A busy session on a live world: returns the log, with the tick each command was issued at, and the hash after each tick.
fn session(seed: u64, ox: i32, oy: i32, ticks: u64, mut rng: Rng, watch: bool) -> (Vec<(u64, C)>, Vec<u64>, Vec<f32>) {
    let mut w = World::new(seed, ox, oy);
    let mut log: Vec<(u64, C)> = vec![]; let mut hashes = vec![];
    let issue = |w: &mut World, log: &mut Vec<(u64, C)>, c: C| { apply(w, &c); log.push((w.tick(), c)); };
    issue(&mut w, &mut log, C::Cheat(3, 0, 0));
    for t in 0..ticks {
        if t % 25 == 0 { issue(&mut w, &mut log, C::Cheat(3, 0, 0)); }   // keep the store full: the test is about replay, not about the economy
        if t % 6 == 0 {
            let n = w.building_count().max(1) as u64;
            let c = match rng.below(30) {
                0..=5 => { let ang = rng.below(628) as f32 / 100.0; let r = rng.range(10, 70) as f32; C::Place([0u8, 1, 4, 0, 19, 18, 1, 25, 2, 3][rng.below(10) as usize], (ang.cos() * r) as i32, (ang.sin() * r) as i32, rng.below(8) as u8) }
                6 => C::Upgrade(rng.below(n) as u32),
                7 => C::Demolish(rng.below(n) as u32 + 1),
                8 => C::Train(rng.below(4) as u8, rng.range(1, 6) as u32),
                9 | 10 => { let u = [rng.range(0, 6) as u32, rng.range(0, 3) as u32, rng.range(0, 3) as u32, 0, 0]; C::Form(u) }
                11..=14 => { let ang = rng.below(628) as f32 / 100.0; let r = rng.range(80, 260) as f32; C::March(rng.range(1, 4) as u32, ox as f32 + ang.cos() * r, oy as f32 + ang.sin() * r) }
                15 => C::Recall(rng.range(1, 4) as u32),
                16 => C::Halt(rng.range(1, 4) as u32),
                17 => { let ang = rng.below(628) as f32 / 100.0; C::Link(ox as f32 + ang.cos() * 400.0, oy as f32 + ang.sin() * 400.0) }
                18 => C::Bridge(rng.below(n) as u32, rng.below(2) == 0),
                19 => C::Gate(rng.below(n) as u32, rng.below(2) == 0),
                20 => { let items: Vec<i32> = (0..rng.range(2, 8)).flat_map(|i| { let a = i as f32 * 0.9; [2, (a.cos() * 26.0) as i32, (a.sin() * 26.0) as i32, 0] }).collect(); C::Batch(items) }
                21 => C::Split(rng.range(1, 4) as u32, [rng.range(0, 2) as u32, 0, 0, 0, 0]),
                22 => C::Cheat(2, rng.range(0, 2), 12),
                24 | 25 => C::Rel(rng.range(5, 8), rng.range(10, 40)),
                26 | 27 => C::Journey(rng.below(6) as u8, rng.range(5, 8), 20, rng.range(20, 400) as f32),
                28 => C::Caravan(rng.range(0, 3) as u8, rng.range(10, 60), rng.range(5, 8), rng.range(20, 300) as f32, rng.range(0, 2) as u32),
                _ => C::Raid(rng.below(628) as f32 / 100.0, [3, 2, 1, 0, 0], 7),
            };
            issue(&mut w, &mut log, c);
        }
        w.step();
        if watch { let _ = look(&mut w); }
        hashes.push(w.state_hash());
    }
    if std::env::var("STATS").is_ok() { eprintln!("seed {seed}: {} commands, {} buildings, {} felled, {} armies, {} road paths, pop {}", log.len(), w.building_count(), w.felled_flat().len() / 3, w.det_flat().len() / 16, w.road_paths_flat().len(), w.population()); }
    (log, hashes, w.road_paths_flat())
}

/// Replay `log` into a fresh world; `habit` runs after every tick (the host doing whatever it does); returns the first tick whose hash differs from `want`.
fn replay(seed: u64, ox: i32, oy: i32, log: &[(u64, C)], want: &[u64], habit: &mut dyn FnMut(&mut World, u64)) -> Option<(usize, usize)> { replay_roads(seed, ox, oy, log, want, habit).0 }
/// Also returns the paths the replica ended with (derived data that is not in the hash but decides where soldiers walk).
fn replay_roads(seed: u64, ox: i32, oy: i32, log: &[(u64, C)], want: &[u64], habit: &mut dyn FnMut(&mut World, u64)) -> (Option<(usize, usize)>, Vec<f32>) {
    let mut w = World::new(seed, ox, oy); let mut i = 0;
    for t in 0..want.len() as u64 {
        while i < log.len() && log[i].0 <= w.tick() { apply(&mut w, &log[i].1); i += 1; }
        w.step(); habit(&mut w, t);
        if w.state_hash() != want[t as usize] { return (Some((t as usize + 1, i)), w.road_paths_flat()); }
    }
    (None, w.road_paths_flat())
}

fn check(seed: u64, ox: i32, oy: i32, ticks: u64) {
    let (log, hashes, roads) = session(seed, ox, oy, ticks, Rng(0x2545F4914F6CDD1D ^ seed), true);
    let say = |what: &str, r: Option<(usize, usize)>| if let Some((t, c)) = r { panic!("seed {seed} at {ox},{oy}: replay ({what}) diverged at tick {t} after {c} of {} commands", log.len()) };
    say("silent", replay(seed, ox, oy, &log, &hashes, &mut |_, _| {}));
    say("drawn every tick", replay(seed, ox, oy, &log, &hashes, &mut |w, _| { look(w); }));
    say("drawn now and then", replay(seed, ox, oy, &log, &hashes, &mut |w, t| if t % 7 == 3 { look(w); }));
    let (_, r2) = replay_roads(seed, ox, oy, &log, &hashes, &mut |_, _| {});
    assert!(r2 == roads, "seed {seed}: the replica ended with different paths from the owner's ({} against {} numbers)", r2.len(), roads.len());
    say("routes asked for only at the end", replay(seed, ox, oy, &log, &hashes, &mut |w, t| if t + 1 == hashes.len() as u64 { look(w); }));
}

#[test]
fn a_replay_with_other_habits_reaches_the_same_state() {
    game_core::warm_navigation(1337);
    for seed in [1337u64] { check(seed, 0, 0, 2500); }
}

#[test]
fn a_replay_far_from_the_origin_reaches_the_same_state() {
    game_core::warm_navigation(1337);
    check(1337, 220, -140, 2500);
}

/// The overlay and route caches are derived data: wiping them (as a fresh replica effectively does) must never change a result.
#[test]
fn a_world_rebuilt_from_its_log_matches_one_that_lived_it() {
    game_core::warm_navigation(1337);
    for k in 0..3u64 {
        let (log, hashes, _) = session(1337, 0, 0, 2000, Rng(0xDEADBEEF + k * 977), k % 2 == 0);
        let r = replay(1337, 0, 0, &log, &hashes, &mut |_, _| {});
        assert!(r.is_none(), "run {k}: diverged at {r:?}");
    }
}

#[test]
fn the_hash_is_the_fold_of_its_named_parts_and_a_difference_names_its_section() {
    let names: Vec<&str> = game_core::state_hash_part_names().leak().split(',').collect();
    let mut a = World::new(1337, 0, 0); a.cheat(3, 0, 0); a.place(0, 12, 4, 0);
    let b = { let mut b = World::new(1337, 0, 0); b.cheat(3, 0, 0); b.place(0, 12, 4, 0); b };
    assert_eq!(a.state_hash_parts().len(), names.len(), "one name for each part");
    assert_eq!(a.state_hash_parts(), b.state_hash_parts());
    assert_eq!(a.state_hash(), b.state_hash());
    let which = |x: &World, y: &World| -> Vec<&str> { x.state_hash_parts().iter().zip(y.state_hash_parts()).enumerate().filter(|(_, (p, q))| *p != q).map(|(i, _)| names[i]).collect() };
    let mut c = World::new(1337, 0, 0); c.cheat(3, 0, 0); c.place(0, 12, 4, 0); c.place(0, 18, 8, 0);
    assert!(which(&a, &c).contains(&"buildings"), "an extra building shows in the buildings part: {:?}", which(&a, &c));
    let mut d = World::new(1337, 0, 0); d.cheat(3, 0, 0); d.place(0, 12, 4, 0); d.cheat(2, 0, 5);
    assert_eq!(which(&a, &d), vec!["army"], "five more spearmen change only the army");
    let mut e = World::new(1337, 0, 0); e.cheat(3, 0, 0); e.place(0, 12, 4, 0); e.cheat(0, 3, -50);
    assert_eq!(which(&a, &e), vec!["stock"]);
    assert_ne!(a.state_hash(), c.state_hash());
}

#[test]
fn the_rules_fingerprint_is_stable_and_depends_on_the_map() {
    game_core::warm_navigation(1337);
    let f = game_core::rules_fingerprint(1337);
    assert_eq!(f, game_core::rules_fingerprint(1337), "the same build always gives the same fingerprint");
    assert_eq!(f.len(), 16);
}

/// A village inside a moat with a drawbridge and a field army that is sent out against raiders: the drawbridge is lowered and raised again by the rules of the core, the soldiers in the
/// fight walk to the deck, and a copy that replays the commands must agree tick by tick, however it is looked at.
#[test]
fn a_moat_a_lent_drawbridge_and_a_defending_army_replay_identically() {
    game_core::warm_navigation(1337);
    let mut w = World::new(1337, 0, 0);
    let mut log: Vec<(u64, C)> = vec![]; let mut hashes = vec![];
    let issue = |w: &mut World, log: &mut Vec<(u64, C)>, c: C| { apply(w, &c); log.push((w.tick(), c)); };
    issue(&mut w, &mut log, C::Cheat(3, 0, 0));
    for i in 0..52 { let a = i as f32 / 52.0 * std::f32::consts::TAU; issue(&mut w, &mut log, C::Place(24, (a.cos() * 24.0).round() as i32, (a.sin() * 24.0).round() as i32, 0)); }
        for (k, x, y) in [(0u8, 12, 4), (0, -12, 6)] { issue(&mut w, &mut log, C::Place(k, x, y, 0)); }
    let before = w.building_count();
    issue(&mut w, &mut log, C::Place(23, 0, 24, 0));
    let bridge = if w.building_count() > before { (w.building_count() - 1) as u32 } else { panic!("the drawbridge was not placed") };
    issue(&mut w, &mut log, C::Bridge(bridge, true));
    let mut lowered = 0; let mut raised_after = false; let mut seen_down = false;
    for t in 0..300u64 {
        if t == 3 { issue(&mut w, &mut log, C::Cheat(3, 0, 0)); }
        if t == 5 { issue(&mut w, &mut log, C::Cheat(2, 0, 10)); issue(&mut w, &mut log, C::Cheat(2, 1, 4)); }
        if t % 40 == 0 { issue(&mut w, &mut log, C::Cheat(3, 0, 0)); }
        if t == 60 { issue(&mut w, &mut log, C::Form([8, 4, 0, 0, 0])); }
        if t == 62 { issue(&mut w, &mut log, C::Raid(std::f32::consts::FRAC_PI_2, [8, 3, 0, 0, 0], 0)); }
        if t == 63 { let id = w.det_flat().first().copied().unwrap_or(0.0) as u32; if id > 0 { issue(&mut w, &mut log, C::Defend(id)); } }
        if t == 150 { issue(&mut w, &mut log, C::Cheat(2, 0, 6)); issue(&mut w, &mut log, C::Form([6, 0, 0, 0, 0])); }
        if t == 152 { let f = w.det_flat(); let id = f.chunks(17).last().map_or(0.0, |c| c[0]) as u32; if id > 0 { issue(&mut w, &mut log, C::March(id, 0.0, 50.0)); } }
        if t == 157 { issue(&mut w, &mut log, C::Bridge(bridge, true)); }   // the player raises it by hand while the army is crossing: a manual order wins
        if t == 230 { issue(&mut w, &mut log, C::Bridge(bridge, false)); }
        w.step(); hashes.push(w.state_hash());
        let status = w.buildings_flat()[bridge as usize * 10 + 6] as u8;
        if status == 6 || status == 7 { lowered += 1; seen_down = true; } else if seen_down && status == 5 { raised_after = true; }
    }
    eprintln!("drawbridge lent for {lowered} ticks, drawn up again after: {raised_after}, fight on at the end: {}", w.battle_active());
    assert!(lowered > 0 && raised_after, "the scenario really lowers and raises the drawbridge");
    let r = |name: &str, res: Option<(usize, usize)>| if let Some((t, c)) = res { panic!("replay ({name}) diverged at tick {t} after {c} of {} commands", log.len()) };
    r("silent", replay(1337, 0, 0, &log, &hashes, &mut |_, _| {}));
    r("drawn every tick", replay(1337, 0, 0, &log, &hashes, &mut |w, _| { look(w); }));
    r("drawn now and then", replay(1337, 0, 0, &log, &hashes, &mut |w, t| if t % 5 == 2 { look(w); }));
}

/// A plague runs for many days, so a copy that joins late or replays with other habits must follow it through every wave to the same village, tick by tick: the spread, the deaths,
/// the quarantine the owner chose and the end of it. (Plague deaths and the sick are in the hash.)
#[test]
fn a_plague_replays_to_the_same_state_through_every_wave() {
    game_core::warm_navigation(1337);
    let mut w = World::new(1337, 0, 0); let (mut log, mut hashes): (Vec<(u64, C)>, Vec<u64>) = (vec![], vec![]);
    let issue = |w: &mut World, log: &mut Vec<(u64, C)>, c: C| { apply(w, &c); log.push((w.tick(), c)); };
    issue(&mut w, &mut log, C::Cheat(3, 0, 0));
    for (i, (x, y)) in [(14, 4), (20, 8), (-14, 6), (-20, 12), (6, 26), (-6, 26), (26, -10), (-26, -10)].iter().enumerate() { issue(&mut w, &mut log, C::Place(if i == 4 { 1 } else { 0 }, *x, *y, 0)); }
    issue(&mut w, &mut log, C::Place(17, 4, 14, 0)); issue(&mut w, &mut log, C::Place(16, -4, 14, 0));
    issue(&mut w, &mut log, C::Cheat(1, 40, 0)); issue(&mut w, &mut log, C::Cheat(2, 0, 30));
    let mut seen_sick = 0;
    for t in 0..(14 * 240u64) {
        if t % 20 == 0 { issue(&mut w, &mut log, C::Cheat(3, 0, 0)); }
        if t == 60 { issue(&mut w, &mut log, C::Cheat(9, 0, 0)); }                    // the outbreak
        if t == 300 { issue(&mut w, &mut log, C::Choose(0)); }                        // quarantine, a few days late is still allowed
        if t == 1500 { issue(&mut w, &mut log, C::Cheat(6, 0, 0)); }                  // an abbey's cure ends it early on one copy of the story
        w.step(); hashes.push(w.state_hash()); seen_sick = seen_sick.max(w.sick());
    }
    assert!(seen_sick >= 3, "there was a plague to follow ({seen_sick} ill at most)");
    for (what, r) in [("silent", replay(1337, 0, 0, &log, &hashes, &mut |_, _| {})), ("drawn every tick", replay(1337, 0, 0, &log, &hashes, &mut |w, _| { look(w); })), ("drawn now and then", replay(1337, 0, 0, &log, &hashes, &mut |w, t| if t % 7 == 3 { look(w); }))] {
        if let Some((t, c)) = r { panic!("plague replay ({what}) diverged at tick {t} after {c} of {} commands", log.len()); }
    }
}

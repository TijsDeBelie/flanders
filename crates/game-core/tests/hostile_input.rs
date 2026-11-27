//! Every command a peer can send reaches the core with numbers the peer chose. None of them may panic: in the browser a panic traps the wasm
//! instance and leaves that replica unusable. This test throws extreme and random arguments at all of them, on a village that has something to act on.
use game_core::World;
use std::alloc::{GlobalAlloc, Layout, System};

/// Turns a runaway allocation (a hostile number used as a size) into a panic with a backtrace instead of an abort.
struct Capped;
unsafe impl GlobalAlloc for Capped {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { if l.size() > 1 << 30 { panic!("runaway allocation of {} bytes", l.size()); } System.alloc(l) }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { System.dealloc(p, l) }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { if n > 1 << 30 { panic!("runaway reallocation to {n} bytes"); } System.realloc(p, l, n) }
}
#[global_allocator]
static A: Capped = Capped;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn pick<T: Copy + std::fmt::Debug>(&mut self, v: &[T]) -> T { let x = v[(self.next() % v.len() as u64) as usize]; if std::env::var("TRACE").is_ok() { eprintln!("  = {x:?}"); } x }
    fn i(&mut self) -> i32 { self.pick(&[0, 1, 2, 3, 4, 5, 7, 9, 15, 20, 40, 100, 255, 256, 1000, 65_535, -1, -2, -100, i32::MAX, i32::MIN, i32::MAX - 1]) }
    fn u(&mut self) -> u32 { self.pick(&[0, 1, 2, 3, 4, 5, 6, 8, 10, 50, 200, 1000, 100_000, u32::MAX, u32::MAX - 1]) }
    fn b(&mut self) -> u8 { self.pick(&[0, 1, 2, 3, 4, 5, 8, 20, 30, 60, 64, 65, 80, 127, 128, 255]) }
    fn f(&mut self) -> f32 { self.pick(&[0.0, -0.0, 1.0, -1.0, 3.14, 1e9, -1e9, f32::NAN, f32::INFINITY, f32::NEG_INFINITY, f32::MAX, f32::MIN, 1e-30]) }
    fn units(&mut self) -> Vec<u32> { let n = self.pick(&[0usize, 1, 4, 5, 6, 12]); (0..n).map(|_| self.pick(&[0u32, 1, 3, 20, 300, u32::MAX])).collect() }
    fn flat(&mut self) -> Vec<i32> { let n = self.pick(&[0usize, 1, 3, 4, 5, 8, 40]); (0..n).map(|_| self.i()).collect() }
}

fn village() -> World {
    game_core::warm_navigation(7);
    let mut w = World::new(7, 0, 0);
    for (k, x, y) in [(0u8, 12, 4), (0, 18, 8), (1, -14, 6), (4, 20, -10), (19, -20, 16), (3, 30, 30)] { w.place(k, x, y, 0); }
    w.cheat(3, 0, 0); w.cheat(2, 0, 20); w.cheat(2, 1, 20); w.cheat(2, 2, 20);
    for _ in 0..200 { w.step(); }
    w
}

#[test]
fn no_command_panics_on_hostile_arguments() {
    for seed in 1..=std::env::var("SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(12u64) {
        let mut r = Rng(0x9E37_79B9_7F4A_7C15 ^ seed.wrapping_mul(0x1234_5678_9ABC_DEF1));
        let mut w = village();
        for round in 0..4000 {
            let op = r.next() % 47; if std::env::var("TRACE").is_ok() { eprintln!("seed {seed} round {round} op {op}"); }
            let t0 = std::time::Instant::now();
            match op {
                0 => { w.place(r.b(), r.i(), r.i(), r.b()); }
                1 => { w.upgrade(r.u()); }
                2 => { w.demolish(r.u()); }
                3 => { w.train(r.b(), r.u()); }
                4 => { w.send_army(&r.units()); }
                5 => { w.start_raid(r.f(), &r.units(), r.i()); }
                6 => { let (a, b, c) = (r.b(), r.i().clamp(-5, 100), r.i().clamp(-5, 100)); w.cheat(a, b, c); }   // (the testing tool is local only; keep its numbers small so the run stays fast)
                7 => { w.repair(r.u()); }
                8 => { w.garrison_set(r.u(), r.u()); }
                9 => { w.drawbridge_set(r.u(), r.next() % 2 == 0); }
                10 => { w.set_option(r.u(), r.b(), r.next() % 2 == 0); }
                11 => { let n = r.u(); w.flatten(n.min(400), 5.0); }
                12 => { w.place_batch(&r.flat()); }
                13 => { w.visit_neutral(r.u()); w.wild_act(r.b(), r.u()); let _ = (w.raid_source(), w.wild_pressure(), w.neutral_info(r.f(), r.f(), r.f()), w.neutrals_flat()); }
                14 => { w.hero_hire(); }
                15 => { w.set_style(r.u()); }
                16 => { w.receive_goods(r.b(), r.i()); }
                17 => { w.settle(r.b(), r.i(), r.i()); w.receive_goods_from(r.b(), r.i(), r.i()); w.caravan_returned(r.b(), r.i(), r.i()); w.caravan_welcome(r.i()); }
                18 => { w.choose(r.b()); }
                19 => { let (t, k, d) = (r.i(), r.b(), r.u()); w.treaty_set(t, k, d); }
                20 => { let (t, k) = (r.i(), r.b()); w.treaty_end(t, k); }
                21 => { w.envoy(r.i()); }
                43 => { w.buy(r.b(), r.i()); w.market_goods(); }
                22 => { w.marriage(r.i()); }
                23 => { w.declare_war(r.i()); }
                24 => { w.clear_deposit(r.u()); }
                25 => { w.caravan_send(r.b(), r.i(), r.i(), r.f(), r.u()); }
                26 => { w.rebuild(r.u()); }
                27 => { w.det_form(&r.units()); }
                28 => { w.det_march(r.u(), r.f(), r.f(), r.next() % 2 == 0, r.f(), r.f()); }
                29 => { w.det_recall(r.u()); }
                30 => { w.det_split(r.u(), &r.units()); }
                31 => { w.det_merge(r.u(), r.u()); }
                32 => { w.det_halt(r.u()); }
                33 => { w.det_send(r.u()); }
                34 => { w.return_army(&r.units(), &r.flat()); }
                35 => { w.gate_set(r.u(), r.next() % 2 == 0); }
                38 => { let (a, b, c, d) = (r.b() % 4, r.i(), r.i(), r.i()); w.demo(a, b, c, d); }
                39 => { w.forest_spot(r.f(), r.f(), r.f(), r.f()); }
                40 => { w.set_field_mode(r.u(), r.b()); }
                41 => { let _ = w.field_info(r.u()); }
                43 => { w.set_workers(r.u(), r.i()); let _ = w.staffing_flat(); let _ = w.staffing_totals(); }
                42 => { let hh = r.f(); w.level_ground(r.i(), r.i(), r.i(), hh); let _ = w.level_check(r.i(), r.i(), r.i(), r.f()); let _ = w.level_target(r.i(), r.i(), r.i(), f32::NAN); let _ = w.level_check(r.i(), r.i(), 6, -1.0e30); w.flatten(r.u(), r.f()); }
                46 => { let tag = r.i(); if r.next() % 2 == 0 { w.rel_add(tag, 90); w.treaty_set(tag, 1, 30); w.treaty_set(tag, 2, 30); } if r.next() % 3 == 0 { w.host_guests(tag, &r.units()); } else { let _ = w.release_guests(tag); let _ = w.det_ally_flat(); } }
                45 => { if r.next() % 3 == 0 { w.cheat(4, r.i().clamp(0, 600), r.i().clamp(0, 1000)); } w.bribe(); let _ = (w.bribe_price(), w.bribe_greed(), w.last_report_bought()); }
                _ => { let n = r.pick(&[1, 2, 5]); for _ in 0..n { w.step(); } }
            }
            if t0.elapsed().as_millis() > 5000 { eprintln!("SLOW op {op} seed {seed} round {round}: {:?}", t0.elapsed()); }
            if round % 97 == 0 { let _ = w.state_hash(); }
        }
    }
}

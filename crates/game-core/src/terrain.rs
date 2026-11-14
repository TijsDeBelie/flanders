//! Procedural terrain, deposits and trees. Pure functions of (seed, x, y): every peer derives the same map.

pub const HALF: f32 = 1200.0; // map spans [-HALF, HALF] on both axes
pub const SITE_SPACING: f32 = 300.0;

#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 { a + (b - a) * t }
#[inline]
pub fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

pub fn h01(seed: u64, x: i32, y: i32) -> f32 {
    let mut h = seed ^ (x as i64 as u64).wrapping_mul(0x9E3779B97F4A7C15) ^ (y as i64 as u64).wrapping_mul(0xC2B2AE3D27D4EB4F);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51AFD7ED558CCD);
    h ^= h >> 33;
    h = h.wrapping_mul(0xC4CEB9FE1A85EC53);
    h ^= h >> 33;
    ((h >> 40) as f32) / 16777216.0
}

#[inline]
fn fade(t: f32) -> f32 { t * t * t * (t * (t * 6.0 - 15.0) + 10.0) }

fn vnoise(seed: u64, x: f32, y: f32) -> f32 {
    let (xi, yi) = (x.floor(), y.floor());
    let (fx, fy) = (fade(x - xi), fade(y - yi));
    let (ix, iy) = (xi as i32, yi as i32);
    let a = lerp(h01(seed, ix, iy), h01(seed, ix + 1, iy), fx);
    let b = lerp(h01(seed, ix, iy + 1), h01(seed, ix + 1, iy + 1), fx);
    lerp(a, b, fy)
}

/// Fractal noise in 0..1; every octave is rotated to hide the value-noise grid.
pub fn fbm(seed: u64, x: f32, y: f32, oct: u32) -> f32 {
    let (mut a, mut f, mut s, mut n) = (0.5f32, 1.0f32, 0.0f32, 0.0f32);
    let (mut px, mut py) = (x, y);
    for o in 0..oct {
        s += a * vnoise(seed.wrapping_add(o as u64 * 131), px * f, py * f);
        n += a;
        a *= 0.5;
        f *= 2.03;
        let (nx, ny) = (px * 0.866 - py * 0.5 + 17.3, px * 0.5 + py * 0.866 - 9.1);
        px = nx;
        py = ny;
    }
    s / n
}

thread_local! { static SITES: std::cell::RefCell<Vec<(u64, Vec<(f32, f32)>)>> = const { std::cell::RefCell::new(Vec::new()) }; }

/// Village sites, worked out once per seed.
pub fn sites(seed: u64) -> Vec<(f32, f32)> {
    SITES.with(|c| {
        if let Some((_, v)) = c.borrow().iter().find(|(s, _)| *s == seed) { return v.clone(); }
        let v = sites_uncached(seed);
        let mut b = c.borrow_mut(); if b.len() > 8 { b.remove(0); } b.push((seed, v.clone()));
        v
    })
}

/// Is the land round (x, y) dry? The centre and rings at 30 and 60 units must be above water (the natural terrain, before any village flattening).
fn dry_round(seed: u64, x: f32, y: f32) -> bool {
    let mut dry = 0;
    let mut total = 0;
    for k in 0..17 {
        let (dx, dy) = if k == 0 { (0.0, 0.0) } else { let a = (k - 1) as f32 * std::f32::consts::FRAC_PI_4; let r = if k <= 8 { 30.0 } else { 60.0 }; ((a).cos() * r, (a).sin() * r) };
        total += 1; if base_height_s(seed, &[], x + dx, y + dy) > 1.5 { dry += 1; }
    }
    dry * 100 >= total * 88
}

/// Village sites (flat valleys): always (0,0) and (1,0), other grid points by hash. A village is never started on water: a candidate site with
/// lakes, sea or rivers round it is dropped.
fn sites_uncached(seed: u64) -> Vec<(f32, f32)> {
    let mut v = vec![];
    for j in -3i32..=3 {
        for i in -3i32..=3 {
            // villages sit on the inner land only: the outer ring of the map is coast and sea
            let (px, py) = (i as f32 * SITE_SPACING, j as f32 * SITE_SPACING);
            let inland = ((px / HALF).powi(4) + (py / HALF).powi(4)).powf(0.25) < 0.7;
            if inland && ((i == 0 && j == 0) || (i == 1 && j == 0) || (h01(seed ^ 0x51, i, j) < 0.55 && dry_round(seed, px, py))) {
                v.push((px, py));
            }
        }
    }
    v
}

fn site_dist(sites: &[(f32, f32)], x: f32, y: f32) -> f32 {
    let mut best = 1e9f32;
    for &(sx, sy) in sites {
        let d = ((x - sx).powi(2) + (y - sy).powi(2)).sqrt();
        if d < best { best = d; }
    }
    best
}

fn site_weight(sites: &[(f32, f32)], x: f32, y: f32) -> f32 { 1.0 - smoothstep(34.0, 78.0, site_dist(sites, x, y)) }

/// Terrain height in world units. Sea level is 0.
pub fn base_height_s(seed: u64, sites: &[(f32, f32)], x: f32, y: f32) -> f32 {
    let wx = x + 45.0 * (fbm(seed + 11, x * 0.006, y * 0.006, 2) - 0.5);
    let wy = y + 45.0 * (fbm(seed + 12, x * 0.006, y * 0.006, 2) - 0.5);
    let cont = fbm(seed + 1, wx * 0.0035, wy * 0.0035, 4);
    let hills = fbm(seed + 2, wx * 0.014, wy * 0.014, 5);
    let ridge = {
        let n = fbm(seed + 3, wx * 0.0065, wy * 0.0065, 5);
        let r = 1.0 - (2.0 * n - 1.0).abs();
        r * r
    };
    // fewer, lower mountains, and none near a village site
    let calm = 1.0 - smoothstep(190.0, 330.0, site_dist(sites, x, y));
    let mask = smoothstep(0.62, 0.86, cont) * (1.0 - calm);
    let mut h = (cont - 0.25) * 24.0 + (hills - 0.5) * (13.0 - 6.0 * calm) + mask * ridge * 50.0;
    // passes: narrow valleys cut through the mountains, the way through for roads and armies
    let pass = 1.0 - smoothstep(0.0, 0.014, (fbm(seed + 8, wx * 0.0048, wy * 0.0048, 3) - 0.5).abs());
    h = lerp(h, 14.0 + (hills - 0.5) * 6.0, pass * smoothstep(26.0, 44.0, h) * 0.9);
    // rivers carve into lowlands
    let rv = (fbm(seed + 4, wx * 0.0075, wy * 0.0075, 3) - 0.5).abs();
    let river = 1.0 - smoothstep(0.0, 0.012 + 0.02 * (1.0 - smoothstep(0.0, 40.0, h)), rv);   // rivers widen as they reach the lowlands
    let rmask = 1.0 - smoothstep(16.0, 38.0, h);
    h = lerp(h, -1.1, river * rmask * 0.95);   // shallow rivers: they do not cut deep gorges
    // a few broad lakes, big enough to sail on
    let lake = fbm(seed + 6, wx * 0.005, wy * 0.005, 3);
    h = lerp(h, -2.0, smoothstep(0.70, 0.78, lake) * (1.0 - smoothstep(10.0, 30.0, h)));
    // gentle valleys around village sites
    let sw = site_weight(sites, x, y);
    let target = 5.0 + (hills - 0.5) * 6.0;
    h = lerp(h, target, sw);
    h += (fbm(seed + 5, x * 0.09, y * 0.09, 3) - 0.5) * 1.4 * (1.0 - sw * 0.75);
    // gentle beaches: the ground just above and below sea level is eased towards a low shore instead of dropping off in a cliff
    let shore = smoothstep(-2.0, 0.0, h) * (1.0 - smoothstep(1.5, 4.5, h));
    h = lerp(h, 0.9, shore * 0.3);
    // an irregular coast: the land fades into the sea towards the edge of the map, with bays and headlands, so the map is not a square
    let (nx, ny) = (x / HALF, y / HALF);
    let round = (nx * nx + ny * ny).sqrt();
    let boxy = (nx.powi(4) + ny.powi(4)).powf(0.25);
    let d = 0.65 * round + 0.35 * boxy + (fbm(seed + 7, x * 0.0045, y * 0.0045, 3) - 0.5) * 0.42;   // mostly round, a little square, with bays and headlands
    let land = 1.0 - smoothstep(0.88, 1.12, d);
    lerp(-9.0, h, land)
}

/// Tunnels bored through mountain ridges: [x0, y0, x1, y1] per tunnel (the two portals). Worked out once per seed from the natural terrain: from a village
/// site, walk outwards in 24 directions; where the way climbs into a mountain and comes out the far side within a few hundred units, bore through it.
pub fn tunnels(seed: u64) -> Vec<[f32; 4]> {
    thread_local! { static T: std::cell::RefCell<Vec<(u64, Vec<[f32; 4]>)>> = const { std::cell::RefCell::new(Vec::new()) }; }
    T.with(|c| {
        if let Some((_, v)) = c.borrow().iter().find(|(s, _)| *s == seed) { return v.clone(); }
        let v = tunnels_uncached(seed);
        let mut b = c.borrow_mut(); if b.len() > 8 { b.remove(0); } b.push((seed, v.clone()));
        v
    })
}

fn tunnels_uncached(seed: u64) -> Vec<[f32; 4]> {
    let s = sites(seed);
    let hh = |x: f32, y: f32| base_height_s(seed, &s, x, y);
    let mut out: Vec<[f32; 4]> = vec![];
    for &(sx, sy) in &s {
        for k in 0..24 {
            let a = k as f32 * std::f32::consts::TAU / 24.0 + 0.13 * h01(seed ^ 0x7B, k, (sx as i32) / 50);
            let (ux, uy) = (a.cos(), a.sin());
            let mut t = 60.0f32;
            let mut enter: Option<f32> = None;
            while t < 520.0 {
                let (x, y) = (sx + ux * t, sy + uy * t);
                if x.abs() > HALF - 60.0 || y.abs() > HALF - 60.0 { break; }
                let h = hh(x, y);
                match enter {
                    None => { if h > 17.0 && hh(x - ux * 5.0, y - uy * 5.0) > 1.5 { enter = Some(t - 5.0); } else if h < 0.0 { break; } }
                    Some(e) => {
                        if h < 12.0 && h > 1.5 {
                            let len = t - e;
                            if (45.0..=300.0).contains(&len) {
                                let p = [sx + ux * e, sy + uy * e, x, y];
                                let far = |q: &[f32; 4]| ((q[0] - p[0]).hypot(q[1] - p[1])) < 160.0 || ((q[2] - p[0]).hypot(q[3] - p[1])) < 160.0;
                                if !out.iter().any(far) { out.push(p); }
                            }
                            break;
                        }
                        if h < 0.0 { break; }
                    }
                }
                t += 5.0;
            }
            if out.len() >= 10 { return out; }
        }
    }
    out
}

/// Neutral places scattered over the map: (kind, x, y). 0 abbey (heals), 1 ruined castle (loot), 2 bandit camp (to be cleared). Worked out from the natural terrain: on dry,
/// gentle ground, away from every village site, one candidate per 160-unit cell, chosen by hash.
pub fn neutrals(seed: u64) -> Vec<(u8, f32, f32)> {
    thread_local! { static N: std::cell::RefCell<Vec<(u64, Vec<(u8, f32, f32)>)>> = const { std::cell::RefCell::new(Vec::new()) }; }
    N.with(|c| {
        if let Some((_, v)) = c.borrow().iter().find(|(s, _)| *s == seed) { return v.clone(); }
        let v = neutrals_uncached(seed);
        let mut b = c.borrow_mut(); if b.len() > 8 { b.remove(0); } b.push((seed, v.clone()));
        v
    })
}

fn neutrals_uncached(seed: u64) -> Vec<(u8, f32, f32)> {
    let s = sites(seed); let mut out = vec![];
    let n = (HALF / 160.0) as i32;
    for cy in -n..n { for cx in -n..n {
        if h01(seed ^ 0x4E, cx, cy) > 0.38 { continue; }
        let x = (cx as f32 + 0.15 + 0.7 * h01(seed ^ 0x4F, cx, cy)) * 160.0;
        let y = (cy as f32 + 0.15 + 0.7 * h01(seed ^ 0x50, cx, cy)) * 160.0;
        if x.abs() > HALF - 80.0 || y.abs() > HALF - 80.0 { continue; }
        let h = base_height_s(seed, &s, x, y);
        if h < 2.0 || h > 40.0 || slope(seed, x, y) > 0.5 { continue; }
        if site_dist(&s, x, y) < 110.0 { continue; }
        let k = h01(seed ^ 0x51, cx, cy); let kind = if k < 0.3 { 0 } else if k < 0.6 { 1 } else { 2 };
        out.push((kind, x, y));
    } }
    out
}

pub fn base_height(seed: u64, x: f32, y: f32) -> f32 { base_height_s(seed, &sites(seed), x, y) }

/// Row-major grid of nx*ny heights starting at (x0,y0) with spacing `step`.
pub fn grid(seed: u64, x0: f32, y0: f32, nx: u32, ny: u32, step: f32) -> Vec<f32> {
    let s = sites(seed);
    let mut out = Vec::with_capacity((nx * ny) as usize);
    for j in 0..ny {
        for i in 0..nx {
            out.push(base_height_s(seed, &s, x0 + i as f32 * step, y0 + j as f32 * step));
        }
    }
    out
}

pub fn slope(seed: u64, x: f32, y: f32) -> f32 {
    let s = sites(seed);
    let hx = base_height_s(seed, &s, x + 1.0, y) - base_height_s(seed, &s, x - 1.0, y);
    let hy = base_height_s(seed, &s, x, y + 1.0) - base_height_s(seed, &s, x, y - 1.0);
    (hx * hx + hy * hy).sqrt() * 0.5
}

/// Forest density 0..1 at a point given its height and slope.
pub fn tree_density(seed: u64, x: f32, y: f32, h: f32, slope: f32, sites: &[(f32, f32)]) -> f32 {
    if h < 1.3 || h > 62.0 || slope > 0.85 { return 0.0; }
    let f = fbm(seed + 9, x * 0.018, y * 0.018, 3);
    let mut d = smoothstep(0.42, 0.62, f);
    d *= 1.0 - smoothstep(38.0, 62.0, h);
    d *= 1.0 - smoothstep(0.5, 0.85, slope);
    for &(sx, sy) in sites {
        let dd = ((x - sx).powi(2) + (y - sy).powi(2)).sqrt();
        if dd < 22.0 { d *= 0.25 + 0.75 * smoothstep(6.0, 22.0, dd); }
    }
    d
}

/// Trees in a rectangle: [x, y, type, scale, rotation] per tree (type 0 = conifer, 1 = oak, 2 = birch).
pub fn trees(seed: u64, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<f32> {
    let s = sites(seed);
    let cell = 2.6f32;
    let mut out = vec![];
    let (cx0, cx1) = ((x0 / cell).floor() as i32, (x1 / cell).ceil() as i32);
    let (cy0, cy1) = ((y0 / cell).floor() as i32, (y1 / cell).ceil() as i32);
    for cy in cy0..cy1 {
        for cx in cx0..cx1 {
            let x = (cx as f32 + h01(seed ^ 0xA1, cx, cy)) * cell;
            let y = (cy as f32 + h01(seed ^ 0xA2, cx, cy)) * cell;
            let h = base_height_s(seed, &s, x, y);
            if h < 1.3 { continue; }
            let sl = {
                let hx = base_height_s(seed, &s, x + 1.0, y) - base_height_s(seed, &s, x - 1.0, y);
                let hy = base_height_s(seed, &s, x, y + 1.0) - base_height_s(seed, &s, x, y - 1.0);
                (hx * hx + hy * hy).sqrt() * 0.5
            };
            let d = tree_density(seed, x, y, h, sl, &s);
            if h01(seed ^ 0xA3, cx, cy) > d * 0.9 { continue; }
            let pick = h01(seed ^ 0xA4, cx, cy);
            let conifer_bias = smoothstep(14.0, 34.0, h);
            let kind = if pick < conifer_bias * 0.9 + 0.1 { 0.0 } else if h01(seed ^ 0xA5, cx, cy) < 0.5 { 1.0 } else { 2.0 };
            let scale = 0.75 + 0.7 * h01(seed ^ 0xA6, cx, cy);
            out.extend_from_slice(&[x, y, kind, scale, h01(seed ^ 0xA7, cx, cy) * 6.2832]);
        }
    }
    out
}

/// Average forest density within `rad` of a point (9 samples).
pub fn forest_near(seed: u64, x: f32, y: f32, rad: f32) -> f32 {
    let s = sites(seed);
    let mut sum = 0.0;
    let mut n = 0.0;
    for k in 0..9 {
        let (dx, dy) = if k == 0 { (0.0, 0.0) } else {
            let a = k as f32 * 0.785;
            (a.cos() * rad * 0.7, a.sin() * rad * 0.7)
        };
        let (px, py) = (x + dx, y + dy);
        let h = base_height_s(seed, &s, px, py);
        let hx = base_height_s(seed, &s, px + 1.0, py) - base_height_s(seed, &s, px - 1.0, py);
        let hy = base_height_s(seed, &s, px, py + 1.0) - base_height_s(seed, &s, px, py - 1.0);
        // use the raw forest field (without village clearing) so woodcutters work near the village edge
        let f = {
            let sl = (hx * hx + hy * hy).sqrt() * 0.5;
            tree_density(seed, px, py, h, sl, &[])
        };
        sum += f;
        n += 1.0;
    }
    sum / n
}

#[derive(Clone, Copy)]
pub struct Deposit { pub kind: u8, pub x: f32, pub y: f32, pub rem: i32, pub max: i32 }

/// Deposit kinds: 0 stone, 1 clay, 2 iron ore, 3 gold ore.
/// Every village site gets all four nearby (stone/clay close, iron further, gold furthest) plus scattered ones.
pub fn deposits(seed: u64) -> Vec<Deposit> {
    let s = sites(seed);
    let mut out: Vec<Deposit> = vec![];
    let amount = |kind: u8, r: f32| -> i32 { match kind { 0 => 900 + (r * 900.0) as i32, 1 => 700 + (r * 700.0) as i32, 2 => 500 + (r * 500.0) as i32, _ => 160 + (r * 240.0) as i32 } };
    let dist_range = [(20.0f32, 30.0f32), (22.0, 34.0), (30.0, 42.0), (40.0, 52.0)];
    for (si, &(sx, sy)) in s.iter().enumerate() {
        for kind in 0..4u8 {
            for attempt in 0..40 {
                let a = h01(seed ^ 0xD0, si as i32 * 7 + kind as i32, attempt) * 6.2832;
                let (lo, hi) = dist_range[kind as usize];
                let d = lo + (hi - lo) * h01(seed ^ 0xD1, si as i32 * 7 + kind as i32, attempt);
                let (x, y) = (sx + a.cos() * d, sy + a.sin() * d);
                let h = base_height_s(seed, &s, x, y);
                if h < 1.5 { continue; }
                if slope(seed, x, y) > 0.55 { continue; }
                if out.iter().any(|o| (o.x - x).powi(2) + (o.y - y).powi(2) < 18.0 * 18.0) { continue; }
                let r = h01(seed ^ 0xD2, si as i32 * 7 + kind as i32, attempt);
                let m = amount(kind, r);
                out.push(Deposit { kind, x, y, rem: m, max: m });
                break;
            }
        }
    }
    // scattered deposits over the wider map, biased by elevation
    let cell = 36i32;
    let n = (HALF as i32) / cell + 1;
    for cy in -n..n {
        for cx in -n..n {
            if h01(seed ^ 0xD5, cx, cy) > 0.5 { continue; }
            let x = (cx as f32 + h01(seed ^ 0xD6, cx, cy)) * cell as f32;
            let y = (cy as f32 + h01(seed ^ 0xD7, cx, cy)) * cell as f32;
            if x.abs() > HALF - 6.0 || y.abs() > HALF - 6.0 { continue; }
            let h = base_height_s(seed, &s, x, y);
            if h < 1.5 || slope(seed, x, y) > 0.6 { continue; }
            if out.iter().any(|o| (o.x - x).powi(2) + (o.y - y).powi(2) < 18.0 * 18.0) { continue; }
            let p = h01(seed ^ 0xD8, cx, cy);
            let kind: u8 = if h > 28.0 { if p < 0.45 { 2 } else if p < 0.7 { 3 } else { 0 } } else if h < 8.0 { if p < 0.6 { 1 } else { 0 } } else if p < 0.4 { 0 } else if p < 0.7 { 2 } else { 1 };
            let r = h01(seed ^ 0xD9, cx, cy);
            let m = amount(kind, r);
            out.push(Deposit { kind, x, y, rem: m, max: m });
        }
    }
    out
}

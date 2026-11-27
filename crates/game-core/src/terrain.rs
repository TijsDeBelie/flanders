//! Procedural terrain, deposits and trees. Pure functions of (seed, x, y): every peer derives the same map.

pub const HALF: f32 = 1200.0; // map spans [-HALF, HALF] on both axes
pub const SITE_SPACING: f32 = 300.0;
pub const RIVER_LEVEL: f32 = 4.8;
const RIVER_STEP: f32 = 2.5; // spacing of the rendered terrain's vertices
const RIVER_VERTICES: usize = (2.0 * HALF / RIVER_STEP) as usize + 1;

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
        total += 1; if land_sample::<false>(seed, &[], x + dx, y + dy, false).0 > 1.5 { dry += 1; }
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
    land_sample::<false>(seed, sites, x, y, true).0
}

fn land_sample<const SURFACE: bool>(seed: u64, sites: &[(f32, f32)], x: f32, y: f32, fill_channels: bool) -> (f32, f32) {
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
    let uncut_height = h;
    let rv = (fbm(seed + 4, wx * 0.0075, wy * 0.0075, 3) - 0.5).abs();
    let river = 1.0 - smoothstep(0.0, 0.012 + 0.02 * (1.0 - smoothstep(0.0, 40.0, h)), rv);   // rivers widen as they reach the lowlands
    let rmask = 1.0 - smoothstep(16.0, 38.0, h);
    let incision = river * rmask;
    h = lerp(h, -1.1, incision * 0.95);   // shallow rivers: they do not cut deep gorges
    let channel = smoothstep(0.46, 0.80, incision);
    // a few broad lakes, big enough to sail on
    let lake = fbm(seed + 6, wx * 0.005, wy * 0.005, 3);
    let lake_cut = smoothstep(0.70, 0.78, lake) * (1.0 - smoothstep(10.0, 30.0, h));
    h = lerp(h, -2.0, lake_cut);
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
    let mut land = 1.0 - smoothstep(0.88, 1.12, d);
    if fill_channels {
        // Submerge the last stretch of terrain even where a headland reaches the square map edge.
        let edge = HALF - x.abs().max(y.abs());
        land *= smoothstep(0.0, 85.0, edge);
    }
    let height = lerp(-9.0, h, land);
    let inland = channel > 0.05 && sw < 0.45 && land > 0.75;
    // Deepen low beds and feather into the banks. Dry terrain at the height of deposits and neutral sites is unchanged.
    let strength = channel * (1.0 - smoothstep(0.35, 1.35, height));
    let height = if fill_channels && inland { lerp(height, height.min(-0.85), strength * 0.94) } else { height };
    // Keep the stage across the carved bed and its shallow shelves. Beyond them the mesh
    // meets the ground, so it cannot end in mid-air over low land outside the channel.
    let surface = if SURFACE {
        // Broad, low coastal bays can extend well inside the coast mask. Taper from the
        // height of the surrounding land before incision, so the bed itself does not lower the stage.
        let coastal_bank = lerp(-9.0, uncut_height, land);
        let stage = RIVER_LEVEL * smoothstep(0.85, 8.5, coastal_bank) * smoothstep(0.75, 0.97, land)
            * (1.0 - smoothstep(0.18, 0.78, lake_cut));
        let shelf = incision > 0.18 && height >= stage - 1.2 && height < stage;
        if (incision > 0.38 || shelf) && sw < 0.45 { stage } else { -stage.min(height.max(0.0)) }
    } else { 0.0 };
    (height, surface)
}

// The browser loads the surface grid along with the terrain. Headless games sample touched vertices lazily.
thread_local! { static RIVER_SURFACES: std::cell::RefCell<Option<(u64, Vec<f32>)>> = const { std::cell::RefCell::new(None) }; }

fn with_river_surfaces<T>(seed: u64, f: impl FnOnce(&mut [f32]) -> T) -> T {
    RIVER_SURFACES.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.as_ref().is_none_or(|(s, _)| *s != seed) {
            *cache = Some((seed, vec![f32::NAN; RIVER_VERTICES * RIVER_VERTICES]));
        }
        f(&mut cache.as_mut().unwrap().1)
    })
}

#[test]
fn river_mesh_stays_level_at_inland_banks_and_ends_at_ground_level() {
    let n = RIVER_VERTICES;
    let land = land_rows(1337, -HALF, -HALF, n as u32, RIVER_STEP, 0, n as u32);
    let mut flat_banks = 0;
    for vertex in land.chunks_exact(2) {
        let (ground, surface) = (vertex[0], vertex[1]);
        if surface < 0.0 { assert!(surface.abs() <= ground, "exposed river edge over {ground}"); }
    }
    for y in 0..n - 1 {
        for x in 0..n - 1 {
            let a = 2 * (y * n + x) + 1;
            if land[a] == RIVER_LEVEL && land[a + 2] == -RIVER_LEVEL && land[a + 2 * n].abs() == RIVER_LEVEL { flat_banks += 1; }
        }
    }
    assert!(flat_banks > 100);
}

#[test]
fn open_coastal_water_has_no_raised_river_ribbons() {
    for (seed, x, y) in [(1337, -1012.5, 457.5), (1084, -62.5, -1147.5), (1, -267.5, -882.5)] {
        let patch = land_rows(seed, x - 25.0, y - 25.0, 21, RIVER_STEP, 0, 21);
        assert!(patch.chunks_exact(2).all(|p| p[0] < 0.0), "fixture must be in open water");
        let stage = river_surface_at(seed, &sites(seed), x, y);
        assert_eq!(stage, 0.0, "raised coastal water at {seed}: ({x}, {y})");
    }
}

#[test]
fn terrain_reaches_the_sea_floor_on_all_four_map_edges() {
    let seed = 1337;
    let sites = sites(seed);
    for offset in (-10..=10).map(|i| i as f32 * HALF / 10.0) {
        for (x, y) in [(-HALF, offset), (HALF, offset), (offset, -HALF), (offset, HALF)] {
            let (height, stage) = land_sample::<true>(seed, &sites, x, y, true);
            assert_eq!(height, -9.0);
            assert_eq!(stage, 0.0);
        }
    }
}

/// Natural river surface at a point, using the same triangles as the renderer. Zero is open water or dry land outside the river profile.
pub fn river_surface_at(seed: u64, sites: &[(f32, f32)], x: f32, y: f32) -> f32 {
    if !(x.abs() < HALF && y.abs() < HALF) { return 0.0; }
    let (fx, fy) = ((x + HALF) / RIVER_STEP, (y + HALF) / RIVER_STEP);
    let (i, j) = ((fx as usize).min(RIVER_VERTICES - 2), (fy as usize).min(RIVER_VERTICES - 2));
    let (tx, ty) = (fx - i as f32, fy - j as f32);
    with_river_surfaces(seed, |grid| {
        let mut at = |i, j| {
            let stage: &mut f32 = &mut grid[j * RIVER_VERTICES + i];
            if stage.is_nan() { *stage = land_sample::<true>(seed, sites, -HALF + i as f32 * RIVER_STEP, -HALF + j as f32 * RIVER_STEP, true).1; }
            *stage
        };
        let interp = |a: f32, b: f32, c: f32, tx: f32, ty: f32| {
            if a <= 0.0 && b <= 0.0 && c <= 0.0 { return 0.0; }
            let (a, b, c) = (a.abs(), b.abs(), c.abs());
            a + (b - a) * tx + (c - a) * ty
        };
        let (b, c) = (at(i + 1, j), at(i, j + 1));
        if tx + ty <= 1.0 { interp(at(i, j), b, c, tx, ty) }
        else { interp(at(i + 1, j + 1), c, b, 1.0 - tx, 1.0 - ty) }
    })
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

/// Neutral places scattered over the map: (kind, x, y). 0 abbey (heals), 1 ruined castle (loot), 2 bandit camp (to be cleared), 3 lair (a boss and his escort: a real fight). Worked out from the natural terrain: on dry,
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

/// Abandoned mineshafts out in the wild: (ore, x, y) with ore 0 iron, 1 gold. A list of their own (the neutral places keep their indices):
/// on a coarser grid, on dry, gentle land well away from every village and from the other wild places.
pub fn mineshafts(seed: u64) -> Vec<(u8, f32, f32)> {
    thread_local! { static M: std::cell::RefCell<Vec<(u64, Vec<(u8, f32, f32)>)>> = const { std::cell::RefCell::new(Vec::new()) }; }
    M.with(|c| {
        if let Some((_, v)) = c.borrow().iter().find(|(s, _)| *s == seed) { return v.clone(); }
        let v = mineshafts_uncached(seed);
        let mut b = c.borrow_mut(); if b.len() > 8 { b.remove(0); } b.push((seed, v.clone()));
        v
    })
}

fn mineshafts_uncached(seed: u64) -> Vec<(u8, f32, f32)> {
    let s = sites(seed); let places = neutrals(seed); let mut out: Vec<(u8, f32, f32)> = vec![];
    let n = (HALF / 260.0) as i32;
    for cy in -n..n { for cx in -n..n {
        if h01(seed ^ 0x6A, cx, cy) > 0.45 { continue; }
        let x = (cx as f32 + 0.2 + 0.6 * h01(seed ^ 0x6B, cx, cy)) * 260.0;
        let y = (cy as f32 + 0.2 + 0.6 * h01(seed ^ 0x6C, cx, cy)) * 260.0;
        if x.abs() > HALF - 90.0 || y.abs() > HALF - 90.0 { continue; }
        let h = land_sample::<false>(seed, &s, x, y, false).0;
        if h < 2.5 || h > 40.0 || placement_slope(seed, &s, x, y) > 0.5 { continue; }
        if site_dist(&s, x, y) < 150.0 { continue; }
        if places.iter().any(|p| (p.1 - x).hypot(p.2 - y) < 45.0) || out.iter().any(|p| (p.1 - x).hypot(p.2 - y) < 120.0) { continue; }
        out.push((if h01(seed ^ 0x6D, cx, cy) < 0.7 { 0 } else { 1 }, x, y));
    } }
    out
}

fn neutrals_uncached(seed: u64) -> Vec<(u8, f32, f32)> {
    let s = sites(seed); let mut out = vec![];
    let n = (HALF / 160.0) as i32;
    for cy in -n..n { for cx in -n..n {
        if h01(seed ^ 0x4E, cx, cy) > 0.38 { continue; }
        let x = (cx as f32 + 0.15 + 0.7 * h01(seed ^ 0x4F, cx, cy)) * 160.0;
        let y = (cy as f32 + 0.15 + 0.7 * h01(seed ^ 0x50, cx, cy)) * 160.0;
        if x.abs() > HALF - 80.0 || y.abs() > HALF - 80.0 { continue; }
        let h = land_sample::<false>(seed, &s, x, y, false).0;
        if h < 2.0 || h > 40.0 || placement_slope(seed, &s, x, y) > 0.5 { continue; }
        if site_dist(&s, x, y) < 110.0 { continue; }
        let k = h01(seed ^ 0x51, cx, cy); let kind = if k < 0.3 { 0 } else if k < 0.6 { 1 } else if k < 0.86 { 2 } else { 3 };
        out.push((kind, x, y));
    } }
    out
}

#[allow(dead_code)]
pub fn base_height(seed: u64, x: f32, y: f32) -> f32 { base_height_s(seed, &sites(seed), x, y) }

/// Row-major grid of nx*ny heights starting at (x0,y0) with spacing `step`.
pub fn grid(seed: u64, x0: f32, y0: f32, nx: u32, ny: u32, step: f32) -> Vec<f32> { grid_rows(seed, x0, y0, nx, step, 0, ny) }

/// Rows `j0..j1` of `grid` (the same numbers, whatever the slicing), so a big grid can be built a few rows at a time.
pub fn grid_rows(seed: u64, x0: f32, y0: f32, nx: u32, step: f32, j0: u32, j1: u32) -> Vec<f32> {
    let s = sites(seed);
    let mut out = Vec::with_capacity(((j1 - j0) * nx) as usize);
    for j in j0..j1 {
        for i in 0..nx {
            out.push(base_height_s(seed, &s, x0 + i as f32 * step, y0 + j as f32 * step));
        }
    }
    out
}

/// Terrain rows with a signed river stage alongside each ground height. Positive stages mark the channel.
pub fn land_rows(seed: u64, x0: f32, y0: f32, nx: u32, step: f32, j0: u32, j1: u32) -> Vec<f32> {
    let s = sites(seed);
    let mut out = Vec::with_capacity((j1.saturating_sub(j0) * nx) as usize * 2);
    for j in j0..j1 {
        for i in 0..nx {
            let (ground, surface) = land_sample::<true>(seed, &s, x0 + i as f32 * step, y0 + j as f32 * step, true);
            out.extend([ground, surface]);
        }
    }
    if nx as usize == RIVER_VERTICES && x0 == -HALF && y0 == -HALF && step == RIVER_STEP && j0 <= j1 && j1 as usize <= RIVER_VERTICES {
        with_river_surfaces(seed, |grid| {
            let row_slice = &mut grid[j0 as usize * RIVER_VERTICES..j1 as usize * RIVER_VERTICES];
            for (stage, pair) in row_slice.iter_mut().zip(out.chunks_exact(2)) { *stage = pair[1]; }
        });
    }
    out
}

/// Deposits and neutral sites are addressed by their index in saved games. Leave their original generation criteria in place.
fn placement_slope(seed: u64, sites: &[(f32, f32)], x: f32, y: f32) -> f32 {
    let hh = |x, y| land_sample::<false>(seed, sites, x, y, false).0;
    let hx = hh(x + 1.0, y) - hh(x - 1.0, y);
    let hy = hh(x, y + 1.0) - hh(x, y - 1.0);
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
    let cell = TREE_CELL;
    let (cx0, cx1) = ((x0 / cell).floor() as i32, (x1 / cell).ceil() as i32);
    let (cy0, cy1) = ((y0 / cell).floor() as i32, (y1 / cell).ceil() as i32);
    trees_cells(seed, cx0, cx1, cy0, cy1)
}

pub const TREE_CELL: f32 = 2.6;

/// The trees of the cells `cx0..cx1` by `cy0..cy1` (cell indices, not coordinates), so the whole map can be done a strip of rows at a time.
pub fn trees_cells(seed: u64, cx0: i32, cx1: i32, cy0: i32, cy1: i32) -> Vec<f32> {
    let s = sites(seed);
    let cell = TREE_CELL;
    let mut out = vec![];
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
            if h < RIVER_LEVEL && h < river_surface_at(seed, &s, x, y) { continue; }
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
        n += 1.0;
        if h < 1.3 || (h < RIVER_LEVEL && h < river_surface_at(seed, &s, px, py)) { continue; }
        let hx = base_height_s(seed, &s, px + 1.0, py) - base_height_s(seed, &s, px - 1.0, py);
        let hy = base_height_s(seed, &s, px, py + 1.0) - base_height_s(seed, &s, px, py - 1.0);
        // use the raw forest field (without village clearing) so woodcutters work near the village edge
        let f = {
            let sl = (hx * hx + hy * hy).sqrt() * 0.5;
            tree_density(seed, px, py, h, sl, &[])
        };
        sum += f;
    }
    sum / n
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Deposit { pub kind: u8, pub x: f32, pub y: f32, pub rem: i32, pub max: i32, #[serde(default)] pub asleep: bool }

/// How much a deposit holds when the map is made: `(base, spread)` per kind (0 stone, 1 clay, 2 iron ore, 3 gold ore); a deposit holds `base + r * spread`, r in [0, 1).
/// Target: one tier-0 building of the matching kind at full staffing (stone 90, clay 160, iron 48, gold ~17 a day) takes at least `MIN_DAYS_TO_EMPTY` days to empty even the poorest deposit
/// (stone 66, clay 62, iron 83, gold 93 days), so a village lives off a deposit for a whole season of play, and a better tier still takes weeks. Tested in `deposit_tests`.
pub const DEPOSIT_SIZE: [(i32, i32); 4] = [(6000, 6000), (10000, 8000), (4000, 4000), (1600, 2400)];
#[allow(dead_code)]   // read by the tests
pub const MIN_DAYS_TO_EMPTY: i32 = 60;
/// A deposit that is used up goes dormant (it stays on the map, but nobody can work it) and regrows: each day by this share of its maximum (percent) when nobody works it,
/// by this many thousandths when a building does work it; it wakes up once it holds `WAKE_PCT` percent of its maximum again.
pub const REGROW_IDLE_PCT: i32 = 2;
pub const REGROW_WORKED_PERMILLE: i32 = 5;
pub const WAKE_PCT: i32 = 15;
impl Deposit {
    /// Clearance around the full cluster of rocks, including the wider clay piles.
    pub(crate) fn walk_radius(&self) -> f32 { if self.kind == 1 { 7.0 } else { 6.0 } }

    /// Can a building take ore from it right now?
    pub fn active(&self) -> bool { self.max > 0 && !self.asleep && self.rem > 0 }
    /// One day passes: regrow (never for a deposit the villagers cleared, `max == 0`), and wake when enough has come back.
    pub fn grow(&mut self, worked: bool) {
        if self.max <= 0 || self.rem >= self.max { return; }
        let add = if worked { self.max * REGROW_WORKED_PERMILLE / 1000 } else { self.max * REGROW_IDLE_PCT / 100 }.max(1);
        self.rem = (self.rem + add).min(self.max);
        if self.asleep && self.rem * 100 >= self.max * WAKE_PCT { self.asleep = false; }
    }
}

/// Deposit kinds: 0 stone, 1 clay, 2 iron ore, 3 gold ore.
/// Every village site gets all four nearby (stone/clay close, iron further, gold furthest) plus scattered ones.
pub fn deposits(seed: u64) -> Vec<Deposit> {
    let s = sites(seed);
    let mut out: Vec<Deposit> = vec![];
    let amount = |kind: u8, r: f32| -> i32 { let (b, sp) = DEPOSIT_SIZE[kind as usize]; b + (r * sp as f32) as i32 };
    let dist_range = [(20.0f32, 30.0f32), (22.0, 34.0), (30.0, 42.0), (40.0, 52.0)];
    for (si, &(sx, sy)) in s.iter().enumerate() {
        for kind in 0..4u8 {
            for attempt in 0..40 {
                let a = h01(seed ^ 0xD0, si as i32 * 7 + kind as i32, attempt) * 6.2832;
                let (lo, hi) = dist_range[kind as usize];
                let d = lo + (hi - lo) * h01(seed ^ 0xD1, si as i32 * 7 + kind as i32, attempt);
                let (x, y) = (sx + a.cos() * d, sy + a.sin() * d);
                let h = land_sample::<false>(seed, &s, x, y, false).0;
                if h < 1.5 { continue; }
                if placement_slope(seed, &s, x, y) > 0.55 { continue; }
                if out.iter().any(|o| (o.x - x).powi(2) + (o.y - y).powi(2) < 18.0 * 18.0) { continue; }
                let r = h01(seed ^ 0xD2, si as i32 * 7 + kind as i32, attempt);
                let m = amount(kind, r);
                out.push(Deposit { kind, x, y, rem: m, max: m, asleep: false });
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
            let h = land_sample::<false>(seed, &s, x, y, false).0;
            if h < 1.5 || placement_slope(seed, &s, x, y) > 0.6 { continue; }
            if out.iter().any(|o| (o.x - x).powi(2) + (o.y - y).powi(2) < 18.0 * 18.0) { continue; }
            let p = h01(seed ^ 0xD8, cx, cy);
            let kind: u8 = if h > 28.0 { if p < 0.45 { 2 } else if p < 0.7 { 3 } else { 0 } } else if h < 8.0 { if p < 0.6 { 1 } else { 0 } } else if p < 0.4 { 0 } else if p < 0.7 { 2 } else { 1 };
            let r = h01(seed ^ 0xD9, cx, cy);
            let m = amount(kind, r);
            out.push(Deposit { kind, x, y, rem: m, max: m, asleep: false });
        }
    }
    out
}

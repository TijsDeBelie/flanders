//! Unit types and battle state.
use crate::catalog::*;

pub const N_UNITS: usize = 6; // 0 spearman, 1 archer, 2 swordsman, 3 knight, 4 catapult, 5 militia (conscripts, not trainable)
pub const MILITIA: u8 = 5;

pub struct UnitDef {
    pub name: &'static str,
    pub hp: f32,
    pub dmg: f32,
    pub range: f32,
    pub speed: f32,
    pub cd: f32,
    pub armor: f32,
    pub cost: &'static [Amount],
    pub tier: u8, // barracks tier required
    pub time: u32, // training effort
    pub desc: &'static str,
}

pub static UNITS: [UnitDef; N_UNITS] = [
    UnitDef { name: "Spearman", hp: 70.0, dmg: 10.0, range: 2.6, speed: 3.2, cd: 1.2, armor: 1.0, cost: &[(W, 4), (TL, 1)], tier: 0, time: 12, desc: "Cheap line infantry. Holds the line against knights." },
    UnitDef { name: "Archer", hp: 45.0, dmg: 8.0, range: 22.0, speed: 3.4, cd: 1.6, armor: 0.0, cost: &[(PL, 3), (W, 2)], tier: 0, time: 12, desc: "Shoots from range; fire arrows set thatched roofs alight." },
    UnitDef { name: "Swordsman", hp: 115.0, dmg: 17.0, range: 2.4, speed: 3.0, cd: 1.0, armor: 3.0, cost: &[(IR, 2), (TL, 1), (CH, 1)], tier: 1, time: 18, desc: "Mail-clad heavy infantry." },
    UnitDef { name: "Knight", hp: 170.0, dmg: 24.0, range: 2.8, speed: 7.0, cd: 1.2, armor: 4.0, cost: &[(IR, 5), (GD, 3), (GR, 12)], tier: 2, time: 30, desc: "Mounted shock cavalry. Devastating charge." },
    UnitDef { name: "Catapult", hp: 130.0, dmg: 55.0, range: 38.0, speed: 1.6, cd: 5.0, armor: 0.0, cost: &[(PL, 20), (IR, 4), (TL, 3)], tier: 3, time: 45, desc: "Siege engine. Smashes walls, digs craters and starts fires." },
    UnitDef { name: "Militia", hp: 40.0, dmg: 6.0, range: 2.2, speed: 3.0, cd: 1.4, armor: 0.0, cost: &[], tier: 0, time: 0, desc: "Villagers who grab pitchforks when the village is attacked." },
];

pub fn units_json() -> String {
    let items: Vec<String> = UNITS.iter().enumerate().map(|(i, u)| {
        let cost = u.cost.iter().map(|(r, n)| format!("[{},{}]", r, n)).collect::<Vec<_>>().join(",");
        format!("{{\"id\":{},\"name\":\"{}\",\"hp\":{},\"dmg\":{},\"range\":{},\"speed\":{},\"armor\":{},\"cost\":[{}],\"tier\":{},\"time\":{},\"desc\":\"{}\"}}", i, u.name, u.hp, u.dmg, u.range, u.speed, u.armor, cost, u.tier, u.time, u.desc)
    }).collect();
    format!("[{}]", items.join(","))
}

#[derive(Clone)]
pub struct Unit {
    pub side: u8, // 0 defenders, 1 attackers
    pub kind: u8,
    pub x: f32,
    pub y: f32,
    pub hx: f32, // post (defenders hold position near it)
    pub hy: f32,
    pub hp: f32,
    pub cd: f32,
    pub alive: bool,
    pub from_army: bool, // counted against the village army when it dies
    pub charge: bool,
    pub anim: f32, // 0 idle/walk, >0 swinging (render hint)
    pub climb: f32, // seconds left climbing a wall or fence
    pub spot: i32,  // the ladder it is climbing, if any
    pub pelev: f32, // height of the post it was sent to (standing on a wall)
    pub elev: f32,  // height it stands at right now
    pub held: bool, // has a defensive post
    pub face: f32,
}

#[derive(Clone)]
pub struct Battle {
    pub units: Vec<Unit>,
    pub t: f32,
    pub pillage: f32,
    pub tag: i32, // 0 = bandits, otherwise id of the attacking player
    pub atk_start: [u32; 5],
    pub atk_dead: u32,
    pub def_dead: u32,
    pub militia_dead: u32,
    pub bld_lost: u32,
    pub ladders: u32,           // ladders the attackers brought
    pub ladders_used: u32,
    pub spots: Vec<[f32; 4]>,   // ladders standing against walls: x, y, angle, busy
    pub sites: Vec<[f32; 4]>,   // moat crossings being built: x, y, angle, work done
    pub bridges: Vec<[f32; 3]>, // finished crossings: x, y, angle
    pub rout: Vec<f32>,         // per unit: seconds left running away (0 = holding)
    pub start_side: [u32; 2],   // soldiers each side began with
    pub fled: [u32; 2],         // soldiers who ran off the field alive
    pub fled_kinds: [u32; 5],   // which attackers got away
}

#[derive(Clone, Copy)]
pub struct Wildfire { pub x: f32, pub y: f32, pub r: f32, pub life: f32, pub scorch: usize }

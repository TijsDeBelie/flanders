//! Static game data: resources and building definitions.

pub const W: u8 = 0; // wood
pub const PL: u8 = 1; // planks
pub const ST: u8 = 2; // stone
pub const CL: u8 = 3; // clay (dirt)
pub const BR: u8 = 4; // bricks
pub const IO: u8 = 5; // iron ore
pub const IR: u8 = 6; // iron ingots
pub const GO: u8 = 7; // gold ore
pub const GD: u8 = 8; // gold coins
pub const CH: u8 = 9; // charcoal
pub const GR: u8 = 10; // grain
pub const TL: u8 = 11; // tools
pub const N_RES: usize = 12;

pub type Amount = (u8, i32);

/// requirement: 0 none, 1 needs a deposit of `req_arg` kind nearby, 2 needs forest
pub struct Def {
    pub name: &'static str,
    pub cat: u8,
    pub r: f32,
    pub weight: u32,
    pub cost: &'static [Amount],
    pub jobs: u32,
    pub inputs: &'static [Amount],
    pub outputs: &'static [Amount],
    pub cycle: u32,
    pub req: u8,
    pub req_arg: u8,
    pub housing: u32,
    pub max_slope: f32,
    pub pad: bool,
    pub desc: &'static str,
}

pub const TOWN_HALL: u8 = 15;
pub const WELL: u8 = 16;
pub const CHAPEL: u8 = 17;
pub const WALL: u8 = 2;
pub const TOWER: u8 = 3;
pub const HOUSE: u8 = 0;
pub const FARM: u8 = 1;
pub const LODGE: u8 = 18;
pub const BARRACKS: u8 = 19;
pub const BUILDERS: u8 = 20;
pub const FENCE: u8 = 21;
pub const GATE: u8 = 22;
pub const DRAWBRIDGE: u8 = 23;
pub const MOAT: u8 = 24;
pub const STOREHOUSE: u8 = 25;
pub const KEEP: u8 = 26;
pub const COURTHOUSE: u8 = 27;
pub const MARKET: u8 = 28;
pub const WATERWHEEL: u8 = 29;
pub const GARDEN: u8 = 30;
pub const PARK: u8 = 31;
pub const RIVER: u8 = 32;
pub const RAISE: u8 = 33;
pub const LOWER: u8 = 34;
pub const PORT: u8 = 35;
pub const TOLL: u8 = 36;
pub const ROAD: u8 = 37;

/// Highest upgrade tier of a building: simple fences, drawbridges and moats do not upgrade.
pub fn max_tier(kind: u8) -> u8 { match kind { FENCE | DRAWBRIDGE | MOAT | RIVER | RAISE | LOWER | ROAD => 0, _ => 3 } }

/// Pieces that reshape the ground instead of standing on it.
pub fn is_edit(kind: u8) -> bool { matches!(kind, MOAT | RIVER | RAISE | LOWER) }

pub static DEFS: [Def; 38] = [
    Def { name: "House", cat: 0, r: 3.2, weight: 1, cost: &[(W, 12)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 5, max_slope: 0.35, pad: true, desc: "Homes for your villagers. Better tiers house more people." },
    Def { name: "Farm", cat: 1, r: 6.5, weight: 2, cost: &[(W, 25)], jobs: 2, inputs: &[], outputs: &[(GR, 10)], cycle: 8, req: 0, req_arg: 0, housing: 0, max_slope: 0.22, pad: true, desc: "Grows grain to feed the village. Needs flat ground." },
    Def { name: "Wall", cat: 4, r: 2.4, weight: 1, cost: &[(ST, 5)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 2.4, pad: true, desc: "A wall segment. Rotate with R and chain them into a curtain wall." },
    Def { name: "Watchtower", cat: 4, r: 3.2, weight: 3, cost: &[(ST, 25), (PL, 10)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.7, pad: true, desc: "Station archers inside to repel raids. Empty towers do not defend. Upgrade it into a stone tower." },
    Def { name: "Woodcutter", cat: 2, r: 3.2, weight: 1, cost: &[(W, 15)], jobs: 2, inputs: &[], outputs: &[(W, 5)], cycle: 6, req: 2, req_arg: 0, housing: 0, max_slope: 0.6, pad: true, desc: "Fells trees. Must stand near a forest." },
    Def { name: "Sawmill", cat: 3, r: 4.5, weight: 2, cost: &[(W, 30)], jobs: 2, inputs: &[(W, 3)], outputs: &[(PL, 2)], cycle: 6, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Saws logs into planks." },
    Def { name: "Quarry", cat: 2, r: 4.5, weight: 2, cost: &[(W, 25), (PL, 5)], jobs: 3, inputs: &[], outputs: &[(ST, 3)], cycle: 8, req: 1, req_arg: 0, housing: 0, max_slope: 0.8, pad: true, desc: "Cuts stone. Build it next to a stone outcrop." },
    Def { name: "Clay Pit", cat: 2, r: 4.0, weight: 1, cost: &[(W, 20)], jobs: 2, inputs: &[], outputs: &[(CL, 4)], cycle: 6, req: 1, req_arg: 1, housing: 0, max_slope: 0.5, pad: true, desc: "Digs clay (dirt) from a clay bank." },
    Def { name: "Brickworks", cat: 3, r: 4.0, weight: 2, cost: &[(W, 20), (ST, 15)], jobs: 2, inputs: &[(CL, 3), (CH, 1)], outputs: &[(BR, 3)], cycle: 10, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Fires clay and charcoal into bricks." },
    Def { name: "Iron Mine", cat: 2, r: 4.2, weight: 3, cost: &[(PL, 20), (W, 20), (TL, 2)], jobs: 4, inputs: &[], outputs: &[(IO, 2)], cycle: 10, req: 1, req_arg: 2, housing: 0, max_slope: 0.9, pad: true, desc: "Mines iron ore from a rich vein." },
    Def { name: "Gold Mine", cat: 2, r: 4.2, weight: 3, cost: &[(PL, 30), (ST, 10), (TL, 3)], jobs: 4, inputs: &[], outputs: &[(GO, 1)], cycle: 14, req: 1, req_arg: 3, housing: 0, max_slope: 0.9, pad: true, desc: "Mines gold ore. Veins are small and precious." },
    Def { name: "Charcoal Burner", cat: 3, r: 3.5, weight: 1, cost: &[(W, 15)], jobs: 1, inputs: &[(W, 4)], outputs: &[(CH, 2)], cycle: 10, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Smoulders wood into charcoal, the fuel of every furnace." },
    Def { name: "Smelter", cat: 3, r: 4.0, weight: 3, cost: &[(ST, 30), (W, 20)], jobs: 3, inputs: &[(IO, 2), (CH, 1)], outputs: &[(IR, 1)], cycle: 12, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "A bloomery furnace that turns ore and charcoal into iron." },
    Def { name: "Blacksmith", cat: 3, r: 4.0, weight: 2, cost: &[(PL, 15), (ST, 15)], jobs: 2, inputs: &[(IR, 1), (CH, 1)], outputs: &[(TL, 1)], cycle: 10, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Forges iron into tools and weapons." },
    Def { name: "Mint", cat: 3, r: 3.8, weight: 3, cost: &[(ST, 40), (BR, 10)], jobs: 2, inputs: &[(GO, 2), (CH, 1)], outputs: &[(GD, 2)], cycle: 14, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Refines gold ore into coin." },
    Def { name: "Town Hall", cat: 5, r: 6.0, weight: 6, cost: &[], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 8, max_slope: 9.0, pad: true, desc: "The heart of your settlement. Upgrade it into a manor, keep and castle." },
    Def { name: "Well", cat: 5, r: 2.0, weight: 1, cost: &[(ST, 8)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Clean water makes plague outbreaks rarer." },
    Def { name: "Chapel", cat: 5, r: 4.0, weight: 2, cost: &[(ST, 30), (PL, 10)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Prayer and healing. Greatly reduces plague. Grows into a cathedral." },
    Def { name: "Hunter's Lodge", cat: 1, r: 3.6, weight: 2, cost: &[(W, 25), (PL, 5)], jobs: 2, inputs: &[], outputs: &[(GR, 6)], cycle: 10, req: 2, req_arg: 0, housing: 0, max_slope: 0.6, pad: true, desc: "Hunters stalk deer and boar in the forest and bring back venison. Needs forest nearby." },
    Def { name: "Barracks", cat: 4, r: 5.0, weight: 4, cost: &[(PL, 25), (ST, 30), (TL, 2)], jobs: 2, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Trains spearmen, archers, swordsmen, knights and catapults. Upgrade it to train better troops." },
    Def { name: "Builders' Yard", cat: 5, r: 4.5, weight: 2, cost: &[(PL, 20), (ST, 10), (TL, 2)], jobs: 3, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Carpenters and masons who repair damaged buildings and rebuild ruins on their own, using your stores." },
    Def { name: "Spiked Logs", cat: 4, r: 1.8, weight: 1, cost: &[(W, 3)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 2.6, pad: true, desc: "The simplest barrier: a row of sharpened logs. Drag the wall pen to draw a long fence quickly." },
    Def { name: "Gate", cat: 4, r: 2.4, weight: 2, cost: &[(PL, 12), (ST, 6)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 2.2, pad: true, desc: "A gateway through your wall. Place it on a wall piece to turn that piece into a gate; your people and armies pass through." },
    Def { name: "Drawbridge", cat: 4, r: 3.2, weight: 2, cost: &[(PL, 30), (TL, 1)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 9.0, pad: false, desc: "Spans a moat. Your armies cross it freely. Raise or lower it from its pane; it is drawn up on its own when raiders attack. Rotate with R." },
    Def { name: "Moat", cat: 4, r: 2.0, weight: 1, cost: &[(W, 2)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 9.0, pad: false, desc: "A water-filled ditch. Attackers wade through slowly and armies need a bridge or boats to cross. Drag the pen to dig a long moat." },
    Def { name: "Storehouse", cat: 3, r: 4.2, weight: 2, cost: &[(W, 25), (PL, 15)], jobs: 1, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Carts bring goods here. Each storehouse raises how much of every resource you can keep." },
    Def { name: "Keep", cat: 4, r: 6.5, weight: 6, cost: &[(ST, 100), (PL, 40), (BR, 10)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.4, pad: true, desc: "A fortified stronghold on a mound. Station archers on its walls; it anchors a moat and wall ring." },
    Def { name: "Courthouse", cat: 5, r: 4.5, weight: 3, cost: &[(PL, 30), (ST, 25)], jobs: 2, inputs: &[], outputs: &[(GD, 2)], cycle: 30, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "The bailiff holds court and collects fines and taxes in coin." },
    Def { name: "Market", cat: 5, r: 5.5, weight: 2, cost: &[(W, 30), (PL, 10)], jobs: 2, inputs: &[(GR, 3)], outputs: &[(GD, 2)], cycle: 20, req: 0, req_arg: 0, housing: 0, max_slope: 0.25, pad: true, desc: "Traders buy surplus grain and pay in coin." },
    Def { name: "Waterwheel", cat: 3, r: 3.6, weight: 2, cost: &[(W, 25), (PL, 15), (TL, 1)], jobs: 1, inputs: &[(W, 3)], outputs: &[(PL, 3)], cycle: 6, req: 3, req_arg: 0, housing: 0, max_slope: 0.6, pad: true, desc: "A mill wheel turned by water drives a saw. Must stand beside a river, lake or moat." },
    Def { name: "Garden", cat: 1, r: 3.4, weight: 1, cost: &[(W, 10)], jobs: 1, inputs: &[], outputs: &[(GR, 4)], cycle: 9, req: 0, req_arg: 0, housing: 0, max_slope: 0.3, pad: true, desc: "Vegetable and herb beds tended by one villager." },
    Def { name: "Park", cat: 5, r: 4.0, weight: 1, cost: &[(W, 10), (ST, 4)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.4, pad: true, desc: "Trees, paths and benches. Fresh air makes plague outbreaks rarer." },
    Def { name: "River", cat: 6, r: 1.9, weight: 1, cost: &[(W, 2)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 9.0, pad: false, desc: "Digs a channel with flowing water, in the direction you draw. Drag the pen from high ground towards a lake or the sea." },
    Def { name: "Raise Ground", cat: 6, r: 1.9, weight: 1, cost: &[(W, 2)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 9.0, pad: false, desc: "Heaps earth into a mound or dike. Raise it in the water to make land." },
    Def { name: "Lower Ground", cat: 6, r: 1.9, weight: 1, cost: &[(W, 2)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 9.0, pad: false, desc: "Digs the ground away. Dig deep enough and it fills with water." },
    Def { name: "Port", cat: 5, r: 5.5, weight: 3, cost: &[(PL, 40), (ST, 20), (W, 30)], jobs: 3, inputs: &[], outputs: &[], cycle: 0, req: 3, req_arg: 0, housing: 0, max_slope: 0.5, pad: true, desc: "Merchant ships call here. Stock you have plenty of is sold for gold, and grain is bought when you run short. Must stand on the shore. Better tiers trade more." },
    Def { name: "Toll Post", cat: 5, r: 3.0, weight: 2, cost: &[(W, 20), (PL, 10)], jobs: 1, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 0.5, pad: true, desc: "A keeper and a barrier on the road: travellers pay a toll. The busier the roads round it, the more it earns. Place it beside a path." },
    Def { name: "Road", cat: 6, r: 1.0, weight: 0, cost: &[(W, 1)], jobs: 0, inputs: &[], outputs: &[], cycle: 0, req: 0, req_arg: 0, housing: 0, max_slope: 1.2, pad: false, desc: "A dirt road piece. Draw a path of them and they link up like the roads that grow between buildings: they level the ground, people walk them and they are paved in time. A road also pushes your border outwards." },
];

/// Resources needed to upgrade to `new_tier` (1..=3).
pub fn upgrade_cost(weight: u32, new_tier: u8) -> Vec<Amount> {
    let w = weight as i32;
    match new_tier {
        1 => vec![(PL, 8 * w), (ST, 4 * w)],
        2 => vec![(ST, 16 * w), (BR, 8 * w), (PL, 6 * w)],
        _ => vec![(ST, 30 * w), (IR, 8 * w), (GD, 6 * w), (BR, 12 * w)],
    }
}

/// An optional design upgrade: (name, what it adds, lowest tier it can be added at).
pub type Opt = (&'static str, &'static str, u8);

/// Optional upgrades that slightly change a building's look and use (at most four per building). Each one is drawn inside the footprint of the building itself, so it can never run into a neighbour.
pub fn options(kind: u8) -> &'static [Opt] {
    match kind {
        HOUSE => &[("Chimney", "A brick chimney with a curl of smoke.", 0), ("Flower boxes", "Shutters and window boxes full of flowers.", 0), ("Woodshed", "A lean-to for firewood against the wall.", 0), ("Dovecote", "A little tower for doves on the roof.", 1)],
        FARM => &[("Scarecrow", "Keeps the crows off the crop.", 0), ("Haystacks", "Golden stacks beside the field.", 0), ("Fenced yard", "A fence round the yard.", 0), ("Barn", "A small timber barn at the field's edge.", 1)],
        WALL => &[("Stairs", "A stone stair up to the wall walk, so guards can climb on to the wall.", 1), ("Banners", "Pennants on the parapet.", 0), ("Hoarding", "A timber gallery over the outer face. Pours boiling oil on anyone on a ladder against it.", 2), ("Braziers", "Iron fire baskets for the night watch.", 1)],
        TOWER => &[("Banner", "A pennant on a pole.", 0), ("Hoarding", "A timber gallery round the top. Pours boiling oil on anyone climbing the wall below.", 1), ("Roof cap", "A conical roof.", 1), ("Beacon", "A signal fire basket.", 0)],
        GATE => &[("Banners", "Pennants either side of the gate.", 0), ("Braziers", "Fire baskets on the pillars.", 0), ("Spikes", "Iron spikes along the lintel.", 1), ("Guard hut", "A little lean-to for the gate guard.", 1)],
        DRAWBRIDGE => &[("Banners", "Pennants on the bridge posts.", 0), ("Lanterns", "Lanterns at both ends.", 0)],
        BARRACKS => &[("Banner pole", "A tall standard.", 0), ("Training dummies", "Straw dummies in the yard.", 0), ("Armoury rack", "Racks of spears and shields.", 1), ("Stable", "A lean-to stable.", 1)],
        KEEP => &[("Banner", "The lord's standard.", 0), ("Hoarding", "Wooden galleries on the battlements. They pour boiling oil on ladders.", 1), ("Corner turrets", "Round turrets at the corners.", 2), ("Beacon", "A signal fire.", 0)],
        TOWN_HALL => &[("Banner", "The village standard.", 0), ("Bell turret", "A bell for alarms.", 1), ("Clock", "A clock face on the front.", 2), ("Garden court", "Hedges and flower beds.", 0)],
        CHAPEL => &[("Bell tower", "A small bell tower.", 0), ("Stained glass", "Coloured windows.", 1), ("Graveyard", "A walled burial ground.", 0), ("Lych gate", "A roofed gate at the churchyard.", 0)],
        WELL => &[("Roof", "A little roof over the well.", 0), ("Trough", "A stone trough beside it.", 0)],
        MOAT | RIVER | RAISE | LOWER | FENCE | ROAD => &[],
        _ => &[("Banner", "A pennant on a pole.", 0), ("Lanterns", "Lanterns at the door.", 0), ("Awning", "A cloth awning.", 0), ("Stone footing", "A stone plinth.", 1)],
    }
}

/// What one optional upgrade costs.
pub fn option_cost(weight: u32) -> Vec<Amount> { let w = weight as i32; vec![(PL, 4 + 4 * w), (ST, 3 + 3 * w)] }

fn options_json(kind: u8) -> String {
    options(kind).iter().map(|o| format!("{{\"n\":\"{}\",\"d\":\"{}\",\"t\":{}}}", o.0, o.1, o.2)).collect::<Vec<_>>().join(",")
}

pub fn catalog_json() -> String {
    let amt = |a: &[Amount]| a.iter().map(|(r, n)| format!("[{},{}]", r, n)).collect::<Vec<_>>().join(",");
    let items: Vec<String> = DEFS.iter().enumerate().map(|(i, d)| {
        format!(
            "{{\"id\":{},\"name\":\"{}\",\"cat\":{},\"r\":{},\"weight\":{},\"cost\":[{}],\"jobs\":{},\"inputs\":[{}],\"outputs\":[{}],\"cycle\":{},\"req\":{},\"reqArg\":{},\"housing\":{},\"maxTier\":{},\"opts\":[{}],\"desc\":\"{}\"}}",
            i, d.name, d.cat, d.r, d.weight, amt(d.cost), d.jobs, amt(d.inputs), amt(d.outputs), d.cycle, d.req, d.req_arg, d.housing, max_tier(i as u8), options_json(i as u8), d.desc
        )
    }).collect();
    format!("[{}]", items.join(","))
}

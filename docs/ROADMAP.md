# Flanders: ideas for what to add next

Written after reading the code (Rust core in `crates/game-core`, three.js client in `web/src`) and looking at what players praise in Banished, Manor Lords, Foundation and Stronghold ([roundup](https://www.gamesgraph.com/best/medieval/city-builder), [Manor Lords on burgage plots](https://www.pcgamer.com/games/city-builder/manor-lords-burgage-plot), [Manor Lords trade rework](https://www.pcgamesn.com/manor-lords/experimental-trade-rework)). The market research is thin (roundups and fan guides), so treat the "why" as a hypothesis, not proof.

## What the game already has

A deterministic core shared by every peer (no server), a production chain from ore to coin, plague, harvests and caravans, bandit raids, fire that spreads, field armies with real pathfinding, sieges (ladders, moat bridges), walls/gates/moats/drawbridges, ports, and a P2P layer with signed commands.
What is missing is mostly *reasons to care between fights*: people are a number, not families; trade is automatic; there is one kind of enemy; and nothing links villages except war.

## Plan, in order of value for effort

### 1. Make people matter (Banished / Manor Lords)
- **Families and ages.** Replace the single population number with households that grow up, marry and die. Houses get a "plot size" (Manor Lords' burgage plot idea: bigger plots hold more families or a workshop).
- **Professions and skills.** A woodcutter who has worked for a year is faster. Players see names on hover and can follow one villager.
- **Needs beyond food:** firewood in winter, clothing, ale, salt. A shortage costs happiness, not just stops growth.
- **Seasons that bite.** Winter halves farm output and raises fuel use; harvest day matters. The core already has day and season text.

### 2. Real trade between players (Manor Lords is reworking this now)
- **Market prices per village** that move with supply, so a village with iron and no grain trades with one that has the opposite.
- **Caravans you can send and escort** between two player villages, and that bandits can raid.
- **Treaties:** trade pacts, non-aggression, tribute. A shared world with only war is a short game.

### 3. Stronghold-style defence depth
- **Wall-walk fighting** now that guards patrol walls: archers on the wall walk, boiling oil, stakes in the moat, murder holes (the gate options already exist as design hooks).
- **Siege towers and rams** for attackers, and **sapping** (undermining a wall) as the answer to thick walls.
- **Morale and routing.** Armies that lose their leader or half their men flee; this keeps battles from being grinds.
- **Heroes/lords** with a name and a few abilities, so an army has a face.

### 4. A reason to explore the bigger map
- **Tunnels are in**; add **fords, passes and a road network** that caravans prefer, and **toll posts** that give the owner coin.
- **Neutral places:** abbeys that trade healing, ruined castles with loot, bandit camps to clear, mines that need a garrison.
- **Fog of war and scouts**, so the large map is not fully visible.

### 5. Events with choices (Banished's strength is hard choices)
- Replace "plague happens" with decisions: quarantine the sick quarter (lose output, save lives) or keep working.
- Famine, a bad winter, a travelling preacher, a noble's visit, heretics. Each offers 2-3 options with different costs.

### 6. Build-your-own-castle depth (what the user asked for)
- **Free-form roads and districts**: draw a road, get plots along it (Foundation's organic layout).
- **Wall editor improvements:** towers that snap onto wall corners, gatehouses with a tower either side, battlements that follow terrain, moat that fills from a river.
- **More option sets per building**: *done for the house, farm, market, chapel and barracks* (see below). Still to do: second-tier options for the remaining buildings (hospital, graveyard, keep, town hall, tower, gate, port, ...), and more village style (wall stone colour, window shutters).

### 7. Technical health
- **Performance:** the demo village takes about 8 s to place in the browser. Batch commands into one signed command, and move the road router to run once per batch.
- **Map streaming:** the terrain mesh is ~924 000 vertices. Add a distance LOD so a 2400-unit map stays smooth.
- **Replays and desync checks:** the core already has a state hash; show a warning when two peers disagree.
- **AI agent play:** the MCP server exists; add an `agent` scenario test that plays the first 20 minutes under the pace limit, as a regression check for the economy.

## Suggested order

1. Families + needs + seasons (changes the feel most, touches only the core)
2. Market prices + caravans (gives players a reason to talk)
3. Event choices
4. Wall-walk combat and siege towers
5. Neutral places, scouts and fog
6. Performance and LOD in parallel with any of the above

## Status of this plan

Done, each in its own pull request on top of the last: 1 families, ages, seasons and firewood; 2 market prices, caravans and treaties; 3 events with choices; 4 morale and routing; 5 neutral places and fog of war; 7 batch placement and an economy regression test. The follow-up pull request adds what those left open: a trade form (caravans, trade pact, peace), delivery and payment of caravans between players over the network (checked against the sender's copy, so nobody can push goods or print money), the "enter the place here" action for armies, and the wall pen on one batch command.

Added after that, each in its own pull request: heroes (a lord who leads the defence), boiling oil from hoardings, toll posts and scouts, and the pen with paths and figures. This last one adds streets of houses (the pen now works for houses, farms and gardens, so a path or a figure of houses is a district) and a village banner colour that every peer sees.

Still not done:
- 4 (done, see below): siege towers and sapping.
- 6: second-tier options for the buildings not yet done (house, farm, market, chapel and barracks have them), and free-form roads as a separate tool (paths still follow from the buildings).
- 7: terrain level of detail (needs a real browser), the demo village on the batch command, and an agent scenario test through the MCP server.
- Graphify's advisory remarks on `main.ts` (hubs `commit`, `updateHud`, `afterLocalChange`): `main.ts` is still one large file.

## Diplomacy, care and death (done)
Relations (−100..100) with every other village, envoys, marriage, alliances, declared war; chapels with weekly services and tithes; infirmary/hospital (beds, herb garden, quarantine ward); graveyards, burial plots and unburied dead (miasma); a population ledger (`population = 10 + arrived + born − enlisted − left − Σdied`) proven by a per-tick test.
**Done afterwards (2026-11):** gifts are a caravan flag (`GIFT_FLAG` added to the resource number: nothing is paid, both villages' feelings warm by the goods' worth, 2..12 points; the trade form has "Send as gift"); a village whose relation is at or below `HOSTILE_REL` (−40, which covers declared war) turns a caravan back (`receive_goods_from` refuses, the sender's `caravan_returned` brings the goods home; a gift to such a village is refused at send time); agent tools `relations`, `envoy`, `gift`, `alliance`, `marriage` and `declare_war` in the browser bridge (`mcp/browser-bridge.mjs`, `web/src/agent.ts`), with guardrails (marriage needs `confirm`, a gift carries at most 100, war needs `--allow-attack` and `confirm_attack`) tested in `mcp/test/guardrails.test.mjs`. The headless MCP server has no neighbours, so it has no diplomacy tools. Core tests cover gifts and refusals; the hostile-input fuzz and the replay-sync test send gift-flagged caravans.
Not done: the AI villages never send gifts of their own; relations are not shown as a number in the trade form.

## Footprints, deposits, test hall (done)
Buildings take more room as they are upgraded (`footprint(kind, tier)`: farms, keep, hall, chapel, barracks, court, market, store, hospital, graveyard); an upgrade is refused when neighbours are in the way, and hovering Upgrade outlines the bigger building and marks the blockers. Deposits can be cleared (40 wood, 10 tools); hand-drawn road pieces can be selected and demolished. The Test panel has a "Test hall" showing every building at every tier plus all design options.
Not done: the footprint is a circle (fields and courtyards are drawn inside it approximately); the demo village is only roomier, not redesigned.

## Production review and market research (2026-11)
**Research caveat:** a web search for what players want from comparable games returned mostly reviews and forum posts and no retention data, so these are hypotheses, not findings. Sources: [Farthest Frontier review](https://entertainium.co/2025/10/22/farthest-frontier-review/), [Manor Lords forum thread](https://www.rpgcodex.net/forums/threads/manor-lords-medieval-city-building-with-large-scale-battles.133844/page-12), [Manor Lords summary](https://vaporlens.app/app/1363080/manor_lords), [Farthest Frontier summary](https://vaporlens.app/app/1044720/farthest_frontier).

What the comparison suggests:
- **Production and farming depth** is what Farthest Frontier and Foundation are praised for (crop rotation, many resources); Manor Lords is criticised for thin production cycles and static animals. Flanders already has a long ore-to-coin chain; soil fertility and crop rotation are the cheapest depth to add.
- **Combat feel** is Manor Lords' strength and Farthest Frontier's weak spot (clumsy melee). Siege towers, rams and sapping (open above) matter more than more unit types.
- **No tutorial and late-game performance** recur as genre complaints. Flanders has gentle goals but no guided first ten minutes; a tutorial and a population soft-cap warning are worth doing.
- **Narrative** is missed in Manor Lords; events with choices and diplomacy put Flanders ahead. Naming and persisting notable villagers and lords builds on that.

Done in this review: save backup/restore, error and unsupported-browser screens, hardened multiplayer ([SECURITY.md](SECURITY.md)), a fuzz test of every network command, the first army no longer freezes the game (the navigation grid is built behind the loading screen), 14% smaller wasm, split bundle, CSP, CI audits and Dependabot.
**Done afterwards (2026-11, second pass):** a guided tutorial (`tutorial.ts`: 13 steps that complete from what the village has, outline the control to use, skippable, restartable from Help); replay and spectating (`replay.ts`: any signed history can be played, paused, rewound and scrubbed; your own from Display settings → Watch my history, other players from "Watch history" in the neighbours list; a test proves a replay reproduces the live village's state hash exactly); soil fertility and crop rotation (farms wear their soil down when sown every cycle, a fallow field recovers, Rotate rests and re-sows a field by itself; per-farm control in the selection panel); cross-checked battle loot (`ledger.ts`, see below); photo mode (F9: hides the interface, saves a PNG); an optional build-time TURN relay plus a hint when nobody connects; `main.ts` lost its command, goal and model-village code to `commands.ts`, `goals.ts` and `modelrunner.ts`.

**Still open:**
- Battle loot is checked only when a copy of the defender's village is held and its battle was played out live; a history loaded later (a late joiner's replay of an attacker's log) still takes the attacker's claim, limited by the core to what was sent and a raider's share of a full store. Closing that fully needs histories replayed together in lockstep.
- No TURN relay is configured by default (none that is safe to point every player at); set `VITE_TURN_*` at build time or per player.
- `main.ts` is still about 1 400 lines: the pen tool, trade/diplomacy handlers, selection panel and input still live there and share a lot of mutable state. The next cut would be a small `state.ts` holding that state so these can move out without long parameter lists.
- The replay UI was checked in a real browser by script, not by a person playing through.
- Tutorial (2026-11, third pass): 15 steps, one action each, in short sentences; defences (well, watchtower, barracks, archers) now come before the growth step, because raids can start on day 3. A scripted tutorial village: open `?world=tutorial` (fixed map, site 0); `web/src/tutorialvillage.ts` holds a build order, and `tests/tutorialvillage.wasm.test.mjs` (in `npm run test:demo`) replays it on the real core and checks the guide reaches its last step. That check runs the core headless; it is not a click-through in a browser. Soil is covered by one light step only.
- Next ideas: soil in the farm tooltip and a winter fallow bonus, replay of a battle from the defender's side.
- The tutorial and replay UIs were checked in a real browser by script, not by a person playing through; the tutorial text is a first draft.
- Next ideas: soil in the farm tooltip and a winter fallow bonus, replay of a battle from the defender's side, a scripted tutorial village.

**Second tier of building options and village roof style (2026-11):** the house, farm, market, chapel and barracks now have eight options each: bits 0-3 as before, bits 4-7 unlocked by the building's tier (tier 2, one at tier 3; `catalog.rs`, `OPT_BITS`). Each has a new drawing in `render/buildings.ts` (`addOption`) and a small effect in the core: loft room (+1 housing), kitchen garden (a grain a day), carved gable (+1 happiness), cellar (firewood); windmill (+10% speed), granary (+5%), orchard (+1 happiness), bee skeps (+5%); weigh house (+10%), striped canopies and market cross (+1 happiness each), guild sign (+5%); rose window and cloister (+1 happiness), almshouse (+2 housing), relic shrine (+2 happiness); archery butts (+15% training), forge shed (+2% defence), watch post (+2 militia), parade ground (+25% training). Effects live in `perks()` and `tier2_speed()` in `lib.rs`; the option bits were already in the state hash, so replication needed no change. The village's roof tile palette (8 choices, `ROOFS` in `flag.ts`) is chosen in the flag designer and stored in bits 25-27 of the flag number (`style`), so it travels in the signed `style` command, is part of the state hash, survives a restart, and every peer tints the tiled roofs of that village the same way (`roofTile` in `buildings.ts`). The Test hall has a second-tier options column, an all-options column (all eight bits) and a row of the eight roof palettes. Core tests: `option_tests.rs`; web tests: `options.test.mjs`, `flag.test.mjs`.

## Siege towers and sapping, more bosses (done)
Attackers' siege towers (a big raid brings one or two against stone walls; they dock, carry infantry over, are wrecked by defenders at the foot, catapults and oil, and are stopped by water) and sapping (infantry stopped by a stone wall with no ladder dig a shaft; the section falls after a delay; defenders sallying fill the shaft in, a moat floods it): `siege.rs`, models in `web/src/render/siegeworks.ts`, rules and numbers in the constants of `siege.rs`. They are battle-level engines like ladders, not trainable kinds, and are in the state hash and in snapshots. Bosses 3 and 4 (Plague Doctor with a plague camp, Ironclad Knight Captain): see "Second batch" in [BOSSES.md](BOSSES.md).
Not done: players cannot build towers or saps themselves (attackers in player-versus-player wars get them by army size like ladders); no ordered sally for defenders (the counter is automatic, by standing at the shaft); the 3D camp props and a look at all new models in a browser.

## Content and polish review (2026-11-27)
**Research caveat:** as before, a web search found news and store pages, not data on what players want. What it shows is where comparable games are going: Noble Legacy's December update spreads ruins, mineshafts and outlaw camps over its map as points of interest ([PCGamesN](https://www.pcgamesn.com/noble-legacy/december-update)); Medieval Adventure is built round discovering regional locations and points of interest ([Steam](https://store.steampowered.com/app/4066390)); Manor Lords' 2026 work is a trade rework, an advanced tier of buildings and modular stone castles ([PCGamesN](https://www.pcgamesn.com/manor-lords/experimental-trade-rework), [PCGamesN](https://www.pcgamesn.com/manor-lords/update-august-2026-beta)). Treat the ranking below as judgement, not evidence.

**What felt missing, from reading and running the game:** the map between villages was nearly empty. Abbeys and ruined castles existed only as minimap icons (no 3D model at all), a bandit camp was a ring of a dozen sticks round five cones, wild places could not be pointed at or selected, and the only way to enter one was a context-menu item on an army that had already been marched next to it by hand. Mines and quarries stood beside a pile of rocks rather than in it: the door frame read as a free-standing arch.

**Done in this pull request:** abbey and ruined-castle models; a redesigned bandit camp (stockade and gate, ridge tents, chief's yurt, spit, lookout, weapon rack, cage, loot), all static pieces merged per material; hover tips and a selection panel for every wild place (strength needed, reward, each army's strength against it, Send in / Enter buttons; armies sent in go in on arrival; right-click with armies selected sends them in); the forest keeps clear of found places; mines get a draped rocky hill with a sheer face behind the door (ore streaks, turf on top), quarries three benches of fresh stone, and rocks in the doorway or pit are hidden. Core: `neutral_info` and `det_power` (tested against what `visit_neutral` actually pays), and testing cheat 13 (lift the fog round a point).

### New things to add, best value first
*Items 1-5 below are done (second pull request of this review): see "Living wild places" further down.*
1. **Raids come from the camps.** Raiders now form up on a ring round the village (`raid_distance`); spawning them from the nearest uncleared camp and marching them along the ground would make clearing camps a strategy (fewer, later raids) rather than a one-off reward, and would show the threat on the map.
2. **Camps that come back.** A cleared camp is cleared for good. Let outlaws re-occupy an empty camp (or a looted ruin) after some weeks unless a watch post or toll stands within reach, so the wild keeps asking for attention.
3. **Abandoned mineshafts.** A wild place of a new kind: an old mine that can be claimed with a garrison and then works like a mine far outside the village radius, joined by a caravan road. This is the "mines that need a garrison" idea from section 4 and matches the genre trend above.
4. **Abbeys as lasting neighbours.** An abbey heals once and is done. Make it a place with a relation (like a village): tithes buy healing every season, a herbal or a scribe, and bandits may sack it if no one protects it.
5. **Life at the camps.** Use the crowd system to put a few outlaws round the fire and on the lookout (the bandit hat already exists), and smoke from the fire, so a camp looks held until it is cleared.
6. **Scouted strength.** The panel now shows a camp's exact strength once it is found. Showing a rough word until a scout or an army has been close, and the number after, would give scouts a second job.

### Existing functions worth updating
- `visit_neutral`: a bandit camp is still a dice-free strength check while lairs and the plague camp are real battles (`begin_lair_battle`). Using the battle for camps too (a plain band, no boss) would make the new camp model the battlefield and reuse the battle banner and report.
- `visit_neutral` for abbeys and ruins is one-shot and costs nothing; see 4 above.
- AI villages (`pve.ts`, `mcp`) never visit wild places; the agent bridge could get a `visit_place` tool now that `neutral_info` exists.
- `Deposits.raiseHill` builds the hill at its full size; it could sink with the deposit as it is mined out (the rocks already shrink), and a dormant deposit could grey the hill like it greys the rocks.
- The minimap's place icons could select the place on click (the selection now exists).
- `main.ts` is now over 4 400 lines; the wild-place code is a natural candidate for its own module once a small shared `state.ts` exists (see the review above).

### Not done / not checked
- The models were checked in a headless browser by script at a few camera angles (iron mine, quarry, every kind of place); the gold mine uses the same code with gold colours and was not looked at. Nobody has played through Send in end to end with a real march; the arrival handling (`checkVisits`) is untested beyond type checks.
- Places are drawn only once found; the hill is built only when a building stands at its deposit.

### Living wild places (done, 2026-11-27)
All rules live in `crates/game-core/src/wilds.rs` (constants at its top), are part of the state hash and travel in snapshot layout E (`FLWORLDE`); older snapshots restore with the wild places fresh. The daily rolls are hashes of the seed, place and day, so they never draw from the village's random stream.
- **Raids and camps.** Raids already set out from the direction of one of the three nearest live camps (`raid_camp_angle`); now that camp is remembered (`raid_source`) and the three nearest live camps within 600 set the pace (`camp_pressure` 0..3; `raid_pace` 0.4..1, 1 at a pressure of 1.5 or more, which is about what a new village has) and scale the strength roll (`raid_roll`, plus 10% per time the camp has come back). The warning names the camp; its model sends up a smoke beacon.
- **Camps come back** after `REOCCUPY_DAYS` (18) with a 20% chance a day, unless watched (an army within 30, a tower, keep or toll post within 160, or a garrisoned shaft within 150). Each return: +20% strength needed, +15% loot, up to 5 times. Lairs stay cleared.
- **Abbeys:** goodwill 50 after the first visit; `wild_act(1, i)` pays a tithe (30 gold + 1 per 2 villagers, +25 goodwill, heals all sick once every 30 days); goodwill ≥ 40 heals one sick villager a day; −1 every 2 days; an unwatched abbey within 240 of a live camp is sacked with a 3% chance a day (20 days, goodwill 0, visits and tithes refused).
- **Mineshafts:** `terrain::mineshafts(seed)` (a list of its own, so the older places keep their indices), kind 5 in `neutrals_flat`. Visiting with 3 or more foot soldiers claims it and leaves up to 8 (spearmen first); 6 iron ore or 2 gold ore a day; attacks from live camps within 240 (up to 30% a day at the camp, divided by 1 + garrison/2) kill half the garrison, and a shaft with none left is lost; `wild_act(2, j)` brings the garrison home to the barracks.
- **Network:** one new command, `wild` (kind = action, idx = place). **Client:** the place panel shows goodwill, tithe, healing countdown, sacking, a camp's returns and when outlaws may come back, a shaft's garrison, ore and attack risk; the people at the places are drawn with the crowd system near the camera.
- **Tests:** `wilds_tests.rs` (8 tests: pacing, raid source, re-occupation and watching, abbeys, shafts, snapshot and hash, `neutral_info`); the hostile-input fuzz calls the new command and queries. One older deposit test now keeps raids off (`calm`): with the new pacing a raid happened to burn its quarry down mid-test.
- **Food, roads and mule trains (follow-up):** the garrisons are counted in `appetite` and eat like every soldier; while the stores are empty one deserts a day (with the last the shaft is lost). Digging fills a pile at the mouth (at most 12 days' worth). A road piece of yours within 12 of the shaft and joined to the castle (`shaft_road`, via `road_reach`) brings the whole pile home daily; without one a mule train takes 2 days' digging at a time at 30 units a day (3 to 15 days on the road). `shaft_road_plan(j)` plans a road along the dry walking route from the castle's gate; the panel's *Lay a road* button sends it as ordinary `road` commands of up to 60 points. Attacks also take half the pile.
- **Computer villages** (`ai.rs`, `wild_places`): a second expedition beside raids, through the same `World` calls a player makes. Tithes when healing is due and someone is sick (or goodwill is falling below the herbs), three spearmen to meet unmet monks or loot a ruin within 420, a garrison of 8 (+2 to walk home) for the nearest free shaft away from outlaws from day 8 (one more shaft every 20 days), and from day 10-16 (by temperament) a band to clear the nearest camp it beats by 25%. It lays a road to each shaft it holds once, when it has the wood. Test: `the_computer_uses_the_wild_places`.
- **Not done:** the garrison is not shown on the Military tab (it comes back with Abandon); a mule train cannot be robbed on the way; the MCP tools do not use any of this; nobody has played a long game with the new raid pacing, so the numbers are a first guess.

## Core mechanics review (2026-11-28)
See [REVIEW-2026-11-28.md](REVIEW-2026-11-28.md): the opening now runs out of food on most sites with one farm, happiness has almost no effect on play, the goals end at the castle and soldiers cost nothing to keep. Ranked proposals: fix the opening, happiness with teeth (growth, leaving, work pace, needs by house tier), standing policies, soldiers' wages, renown and titles after the castle, raids an absent player can survive.
Implemented in the follow-up: proposals 1-6 (decrees, needs, growth and leaving, wages, renown, titles and charters, the first raid), a focus event, and a win-conditions proposal (a reign with a crown for the most renown, and conquest, concord and pacification victories): see the end of the review.

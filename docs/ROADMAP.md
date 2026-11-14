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
- **More option sets per building** (already four each): add a *second tier of options* unlocked by the building's tier, and a visible "style" per village (banner colours, roof tile palette).

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

Done, each in its own pull request on top of the last (see the PR list): 1 families, ages, seasons and firewood; 2 market prices, caravans and treaties (core only); 3 events with choices; 4 morale and routing (siege towers, rams, sapping and heroes are not done); 5 neutral places and fog of war (no button for visiting yet; scouts and toll posts not done); 7 the batch placement command and an economy regression test.

Not done: 6 (free-form roads and districts, second tier of building options, village styles), terrain level of detail (needs checking in a real browser, which was off the table for these PRs), and the user interface for caravans and treaties.

/** The release notes: the one place to edit when a version ships. Newest first. Add an entry at the top, bump `version` in web/package.json to match.
 *  Items are plain text (escaped when shown). Keep them about what a player sees, not about code. */
export interface Release { version: string; date: string; title: string; added: string[]; changed: string[]; fixed: string[] }

export const RELEASES: Release[] = [
  {
    version: '0.7.2', date: '2026-11-27', title: 'Mines in the hillside and wild places you can visit',
    added: [
      'Abbeys and ruined castles now stand on the map as buildings (they were only on the minimap): a stone church with a bell tower, a cloister and graves; a castle of broken walls and split towers on a heap of rubble with its hoard in the middle.',
      'Point at a wild place to see what it is; click it to select it. The panel tells what it holds, how strong a bandit camp is, what clearing it pays, and which of your armies is strong enough, with a Send in button for each army. An army sent in marches there and goes in by itself when it arrives. With armies selected, right-click a wild place to send them in.',
    ],
    changed: [
      'Bandit camps are redesigned: a stockade of sharpened stakes with a skull-topped gate, ridge tents with their doors to the fire, the chief\'s round tent and banner, a cooking spit, benches, a lookout tower, a weapon rack, a prisoner cage and the loot pile. Once cleared the tents slump, the fire dies and the loot is gone.',
      'Mines are cut into the deposit: a rocky hill rises over the ore, its face cut sheer behind the door frame, so the door opens into the rock. Quarries cut three benches of pale fresh stone into their deposit above the pit. Rocks no longer stand in the doorway.',
      'Trees no longer grow through the abbeys, ruins and camps you have found.',
    ],
    fixed: [],
  },
  {
    version: '0.7.1', date: '2026-11-25', title: 'Better house designs',
    added: [
      'House designs are rebuilt to fit each house: a second chimney on the ridge, flower boxes under the windows and pots at the door, a lean-to woodshed with a log stack, a dovecote on the ridge, a loft dormer growing out of the roof, a raised kitchen garden behind the house, a carved gable end with bargeboards and a sunburst, and a cellar hatch with stone cheeks. Textured soil, leaves, bark and straw.',
    ],
    changed: [
      'Every house design now has its own price (a chimney wants bricks, a loft room planks, bricks and tools, a carved gable some gold) and a stronger bonus: the loft room houses three, the dovecote brings in two grain a day, the kitchen garden three, each flower box lifts happiness by one (up to six), the carved gable by two, and a cellar also adds 25 to the storage limit. Second-tier designs of other buildings now cost bricks as well.',
    ],
    fixed: [
      'House designs no longer float in the air or overlap each other, whatever combination is chosen. The chapel\'s stained glass and rose window now sit on its walls.',
    ],
  },
  {
    version: '0.7.0', date: '2026-11-24', title: 'A tidier interface',
    added: [
      'One Settings page (the Settings button in the top bar) with tabs for Display, Sound, While away, Controls, Data & network and About. Everything that used to be spread over the Menu, Display settings, Help and Release notes is there.',
      'Map layers (Map, Reach, Deposits) now sit under the minimap.',
      'Fire Station (Village buildings): a staffed brigade that fights fires within reach with or without a well, puts them out faster and wets down neighbouring buildings so sparks take half as often. Two stations in reach work together.',
    ],
    changed: [
      'The Village steward is no longer a pop-up. Its report and recovery buttons are at the top of the Village tab, with Winter, Workers and Villagers as sections below. Food and stock breakdowns, and the reserves form, are sections of the Stock tab. Away policy moved to Settings → While away.',
      'The Army tab is now called Military, and mustering a new army sits with your field armies.',
      'Pop-ups now stack: Esc closes the top one, the Tab key stays inside it, and focus returns to what opened it.',
      'The selected-building panel keeps repair and upgrade together in one place and closes with a small cross; the battle headline joins the battle controls at the bottom of the screen.',
    ],
    fixed: [],
  },
  {
    version: '0.6.0', date: '2026-11-23', title: 'Better roads',
    added: [
      'Roads have four surfaces: dirt, gravel, cobbles and flagstones. Select a road and resurface the whole stretch up to the next junction; a road with a better surface looks different, and one surface runs softly into the next.',
      'Design options for roads: lime and oak trees along the verge, hedges and flower beds, stone benches and lanterns that light the road at night. They cover the whole stretch.',
      'Workplaces need a road to the castle: a building outside the castle\'s yard that no road joins to the castle works at half pace until one does. The panel and the road tool say whether a road reaches the castle.',
      'New textures for every road surface, with kerb stones, ruts, moss in the joints and a ragged verge where the grass meets the road.',
    ],
    changed: [
      'Roads are no longer paved all at once when the castle grows: you choose the surface of each stretch yourself.',
      'Textures blend where roads meet at corners and junctions, and where one surface runs into another.',
    ],
    fixed: [],
  },
  {
    version: '0.5.0', date: '2026-11-22', title: 'Steadier multiplayer',
    added: [
      'Commands no longer get lost: every command a player gives reaches everybody, complete and in order, even over a bad connection. Anything missing is noticed at once and sent again.',
      'The multiplayer panel shows the ping to each player and says when a connection is unstable.',
      'The game now checks for a newer version, and updates itself (after saving) when one is out or when another player is already on a newer one, so everybody plays the same version.',
      'Allies can help each other: send a selected army to an ally, who is asked to let it in. It then fights beside their defenders whenever they are raided, until it is sent home. You can also ask an ally for help.',
    ],
    changed: [
      'A connection that drops for a moment is picked up again where it left off, without sending whole villages again, and a short break no longer shows "has left the world".',
      'The game reopens the connection to the world by itself when nobody can be reached, when the network comes back and when the page is shown again.',
      'A player who sends bad data is shut out for five minutes instead of for the whole session, and one stray message is forgiven.',
      'A copy of another village that goes out of step keeps trying to mend itself, with longer pauses, instead of giving up.',
    ],
    fixed: [
      'Commands that arrived just before a player had been introduced were silently thrown away and left their village wrong for everybody else.',
    ],
  },
  {
    version: '0.4.0', date: '2026-11-22', title: 'Siege towers, new bosses, gifts and a guided tutorial',
    added: [
      'Siege towers and sapping: big raids bring towers against stone walls that dock and carry soldiers over, and infantry stopped by a wall dig a shaft that brings a wall section down. Defenders can wreck towers at the foot, flood shafts with a moat and fill them in by sallying out.',
      'Two new bosses: the Plague Doctor, who hides in a plague camp and re-infects the village until she is caught, and the Ironclad Knight Captain, whose plate only siege engines and heavy hits can hurt.',
      'Send a caravan as a gift to raise its opinion of you. Villages that are hostile or at war turn your caravans back at the gate.',
      'Agents can use diplomacy through the MCP server: envoys, marriage, alliances, war and gifts.',
      'Second-tier building options for the house, farm, market, chapel and barracks, unlocked by tier, each with its own drawing and a small bonus.',
      'Choose a roof tile palette for your village in the flag designer. Every player sees your village in those colours.',
      'A scripted tutorial village gives everyone the same first ten minutes.',
      'Select armies on the map to see what they are made of and halt them, send them home or split them from a new card.',
      'Armies that stop after a march pitch a camp: tents appear round the soldiers and a few guards stand watch, and it is struck when they move on.',
    ],
    changed: [
      'The tutorial has been rewritten as 15 short steps with one action each, and teaches defence before growth.',
      'A fallow field recovers its soil twice as fast in winter. Hover the soil bar to see how much grain the field gives at its current soil.',
      'The Iron Mine no longer needs tools to build, only to upgrade, so a village can start on iron without them. Bread now fills twice as much as raw grain.',
      'The battle alert can be closed, and command mode keeps the map clear of it.',
    ],
    fixed: [
      'Armies can march out past an embassy and a castle without getting stuck.',
      'Your own armies pass through a shut gate, and an army mustered at a castle comes out at the front gate instead of beside a wall.',
    ],
  },
  {
    version: '0.3.0', date: '2026-11-22', title: 'A new castle, embassies and computer rivals',
    added: [
      'Play against the computer: the start screen has a PVE mode with two computer-run villages that trade, send envoys and raid you through the same rules as other players.',
      'The Embassy is a new building for all diplomacy. Open it to trade, send envoys, declare war or march on rival villages, and upgrade it through four tiers.',
      'Plant trees with the Forester so your woodcutters never run dry.',
      'Select several buildings at once and act on them together.',
      'Fallen soldiers, villagers and animals leave corpses on the field and around the village.',
    ],
    changed: [
      'The castle has a redesigned look, with new walls, towers and gatehouse.',
      'Diplomacy has moved out of the Army tab into the Embassy. The Army tab now points you to it for trade, envoys and marching on other villages.',
    ],
    fixed: [],
  },
  {
    version: '0.2.3', date: '2026-11-20', title: 'Helping hands, happy livestock and clearer workshops',
    added: [
      'Workshops explain exactly what is holding up production, including missing materials, protected reserves, workers and full storage. Follow Show or Build links to the supplier from the building panel or work overview.',
      'Markets sell emergency tools for 15 gold each, with a village-wide stock of two and one replacement every three days. Reopen your Iron Mine when your own tool supply runs out.',
      'Touchscreen building uses a movable preview and a Build here button. Obstruction markers show what blocks placement, and demolition panels show the materials you will recover.',
      'Pigsties raise pigs for year-round meat using grain. Stables house visible horses, and the Caravan horses upgrade makes new caravans travel 50% faster.',
      'Set grain and firewood reserves to protect essential supplies from automatic processing, livestock feeding and trade.',
      'Turn on Googly Eyes in display options for a sillier herd. Switch it off to restore the usual animal appearance.',
    ],
    changed: [
      'Food rations scale more smoothly with population. Working pastures have herders, and named villagers can be followed around the village.',
      'Villagers have unique names, with numbered namesakes when needed. Special residents keep their assigned woodcutting, building and market jobs.',
      'Villager clothing, animal coats, roofs, timber and farm ground have richer textures, with less roof shimmer at a distance.',
      'Boats have improved hulls and seating. Villagers and troops sit inside their small boats while travelling.',
      'Port placement snaps more reliably to the bank, faces open water and keeps its boat afloat. Waterfront supports fit the ground beneath them.',
      'Rivers no longer show the animated flow effect. Connected moat water stays level, and shoreline rendering reduces water spikes and gaps.',
      'Building search includes stables, horses and caravan transport. Search all categories when the current category has no matches.',
      'Demolition controls show the exact refund before you demolish. Raid warnings can pause the countdown so you have time to respond.',
    ],
    fixed: [
      'Pause freezes villagers, farm animals, boats and their simulation animations.',
      'Touchscreen twisting rotates the camera in the expected direction, and camera gestures no longer accidentally place buildings.',
      'Successful placement no longer leaves a misleading Something is in the way warning. Placement previews and building confirmation use the same obstruction checks.',
      'Farmers hold their hoes the right way round.',
      'Choose your flag on the start screen. Inside the village it is display-only, and the town hall flies your chosen flag.',
    ],
  },
  {
    version: '0.2.2', date: '2026-11-19', title: 'Battlefield orders and safer villages',
    added: [
      'Your village pauses by default while you are away. You can leave the steward in charge for up to one village day of routine work. The steward pauses for trouble or decisions and gives you a report when you return.',
      'Give orders to individual troop types from the battle controls at the bottom of the screen. Hold a line, attack a point, flank the enemy or fall back. Markers on the battlefield show where your orders apply.',
      'Some raids ask you to hold a gate or protect a caravan. The raid banner shows the objective, the time left and how close the raiders are to taking it.',
      'Open Armory upgrades in the Army tab to equip fire arrows, better armor and other improvements for your troops and siege crews.',
      'The march preview shows estimated arrival times for armies and reinforcements, along with crossing costs and any supplies you are short of.',
    ],
    changed: [
      'Archers keep their distance, spearmen and swordsmen meet the enemy head-on, and knights circle for an opening. Attacks from behind deal more damage, and archers guarding towers and keeps can shoot up to 44 units.',
      'Soldiers find their own way onto village paths and spread out when they arrive, using nearby clear ground. Armies march faster at home and on roads. Click a soldier or siege engine in the field to select its army.',
      'Armies can build crossings when they cannot find a route around the water. Turn on Allow automatic bridge shortcuts in the Army tab to let them spend planks on a shorter route.',
      'Search the Build menu by building name or by what it produces. Smoked fish and smoked meat have separate stock entries, and the smokehouse explains the recipe you selected.',
      'The red raid banner shows the payoff offer and the raiders’ greed. Drawbridge controls show whether the bridge is up or down. If you lower it during a raid, it stays down until you raise it or a new raid begins.',
      'Raise and Lower Ground let you set a target height. Roads, bridges, moats and ports can be placed beyond city limits.',
      'Forests stay visible farther out as you move the camera, with less work spent drawing distant trees, shadows, fire and smoke.',
    ],
    fixed: [
      'Walking routes avoid resource deposits as well as buildings and water. Raiders can finish crossing moats, and catapults and rams have more room in the marching column and wheels that turn as they move.',
      'Rivers descend into a flat ocean, with smoother banks and map edges. Low shoreline patches stay steady as the tide changes.',
      'Fishing huts and waterwheels sit on the bank, and drawbridges stay clear of the water. Waterfront placement keeps the camera steady. The harbor’s stone footing fits under the warehouse and leaves the pier wooden.',
    ],
  },
  {
    version: '0.2.1', date: '2026-11-17', title: 'Soldiers keep to the paths',
    added: [],
    changed: [
      'Marching armies: every soldier, knight, catapult and ram now keeps strictly to the invisible path network of the village, one after another like the villagers, with no fanning out; it only leaves the path to get onto it from the crowd round the army and for the last stretch where no path reaches. They never walk through a building, wall, fence, field or water; gates, bridges and lowered drawbridges are crossed as the army crosses them.',
      'A soldier that gets stuck asks for a route of its own along the network and carries on. Knights and siege engines keep to the wider layer of the network that clears buildings, walls and fields.',
    ],
    fixed: [
      'Soldiers no longer cut through buildings and fields while marching in a crowd.',
      'Moat water stays solid right up to the bank instead of fading out, so no strip of bare ditch shows between the water and the land.',
    ],
  },
  {
    version: '0.2.0', date: '2026-11-16', title: 'Bosses, bridges and a proper food economy',
    added: [
      'Target height for the Level ground tool: in the bar at the bottom, next to the sizes, a slider and number box (1 to 24, in half steps) or Auto (the land round the patch, as before). The preview shows a flat disc at the height the patch would be levelled to, blue where earth is added and orange where it is cut away, with the ground height under the pointer and the cost in the hint.',
      'Buy off raiders: when a bandit raid (or a boss raid) forms up at your gates, a Pay them off button in the red banner shows the price (what the raiders are worth, more for a boss) and, once you pay, they turn and walk away: no fight, no loot, but no glory or prize either. It only works before the first blow, never against another player, and the Ogre will not take coin. The bandits get greedy: the next raids come sooner and stronger and ask more, until it fades over a few days.',
      'Assign villagers yourself: in a building\'s panel, a slider with + and − and an Auto button sets how many workers it has (0 pauses it). Buildings you set are filled first, the rest share what is left. Click the workforce figure in the top bar for the work overview: every workplace by kind with its workers, status and output, filters for problems, "Auto-assign all" and "Pause all" per kind.',
      'Hover the rate of a resource in the top bar to light up the buildings behind it: rings on every building that makes it (+) or uses it (−), green when working, orange when held up (no workers, short of materials, store full) and gold when it can be upgraded right now. The tooltip lists each kind with its count, tiers, upgrades possible and why some stand idle; click the rate to look at each building in turn. The breakdown panel has the same list with a Show on map button.',
      'Bosses: the Warlord and the Ogre of the Marches, with lairs in the wild to find and clear.',
      'Fishing hut, smokehouse and bakery. The smokehouse smokes fish or meat; the hunter\'s lodge now brings in meat.',
      'Food mix: your people eat grain, fish, bread, meat and their smoked versions together, shown as one Food pill in the top bar.',
      'Resource ledger: click a resource to see what makes it and what uses it, with a steady per-day rate and the days of supply left.',
      'Market stock: buy basic goods for gold at the market; the stalls are refilled every day.',
      'Town hall backup supplies of wood and grain, so a village that runs dry can recover.',
      'Soldiers\' bridges: design a bridge for your army from bank to bank.',
      'Level Ground tool (Land category): levels a round patch of ground to the land just outside it, so a pit that raising could not fill is mended and a bump is cut away. Any ditch or earthworks inside the patch is taken away with it. Costs wood and stone; refused where a building stands in the patch or the ground round it is water.',
      'Road anchors while you place a building: the ring where its road joins the village (the circle a road snaps to) is drawn at its exact place and turns as you rotate the building, with the short stretch of road from its door to it, green when you can build and red when you cannot; any node or road it would join lights up in gold, so you can line buildings up with your roads.',
      'Gates, toll houses, bridges and drawbridges now have two road anchors, one at each end (the doorways of a gate or toll house, the banks of a bridge or drawbridge), so a road you lay snaps to both ends and runs through. A gate and a toll house show dirt or stone road under them (by castle tier); bridges and drawbridges show only their deck.',
      'Plaza: a paved square with a connection node on each of its four sides, and design options (benches, trees, a fountain, lanterns).',
      'Out-of-sync detection and repair: when a copy of another player\'s village drifts, the game notices and repairs it by itself.',
      'Rules fingerprint and build marker (see the home page and The shared world panel) so players can check they run the same version.',
      'This version number and the release notes page.',
      'Restart village (Display settings, at the bottom): pulls your whole village down and starts again from nothing on the same ground: buildings, roads, terrain changes (raised, lowered and levelled ground, moats, felled trees), deposits, stock, people, army, treaties and the day count. A confirmation sheet lists exactly what is lost and asks you to type your village\'s name; you can download a backup first, and the old village is kept once in this browser so you can bring it back. Other players see your village start again. Refused during a battle or while armies are out.',
      'See how far wells and towers reach: select or point at a well, a builders\' yard or a tower (or pick one to build) and rings are drawn on the ground, blue for fire fighting (full and half strength, and how close a well halves the chance a spark takes), teal for the yard\'s carpenters, orange-red for how far its archers shoot, each with a label; the building\'s panel lists the same radii. The new Show coverage button (key C) shows every well and every tower with archers in it at once, marks buildings no well reaches in amber and wall pieces no manned tower covers in red. The numbers come straight from the game rules, so what is drawn is what counts.',
    ],
    changed: [
      'The sync protocol is now version 3 (commands and hashes carry the epoch of your village\'s history, which a restart starts anew): players on older builds see "different game version" until they reload. The rules fingerprint is unchanged.',
      'Winter is gentler: farms make 55% grain (85% with haystacks) instead of 25%, the village burns about a third less firewood, the town hall hearth keeps it warm while any wood is left, and the cold now takes unhappiness first, nobody for the first 3 cold days (5 with a staffed hospital), then a daily chance that grows. Fishing, hunting and smoked food are untouched by winter.',
      'New Winter panel (click the season in the top bar, or hover it): exactly what winter does, firewood per day and days left at the present size, and a warning toast a season ahead.',
      'The rules fingerprint changed again for the winter rules: villages on this version only sync with players on the same version.',
      'Deposits are far bigger (stone, clay, iron and gold last for months of mining) and are never gone for good: a used-up deposit goes dormant (greyed, no ore, its mine says "Deposit dormant") and slowly regrows, a little faster when nobody works it, waking again at 15%. Mine and quarry panels show what is left, how many days it lasts and how far a dormant deposit has recovered. Deposits you clear away stay cleared. Forests are unchanged.',
      'Armies cross water only by a bridge or a temporarily lowered drawbridge.',
      'Combat overhaul: defending, raiders, siege engines, fire and rams all behave more distinctly.',
      'Knights and siege engines march at their own pace.',
      'Roads are laid by you now: click the points of a road and it runs in a smooth curve through them. The automatic roads between buildings are gone (they caused too many tangles); the invisible paths people and soldiers walk are unchanged, and they prefer the roads you lay.',
      'Every building has its own short path from its door to a node at the edge of its plot; a road you lay snaps onto it. Roads that join the village widen the land you may build on and may lead out beyond its edge (within a limit).',
      'The rules fingerprint changed: villages on this version only sync with players on the same version. Old roads that were laid automatically simply disappear; road pieces you laid yourself stay and are joined to their neighbours.',
      'Roads are dirt tracks, dark and clearly visible against the grass, while your castle is in its first tiers, and cobbled stone from tier 2; every road in the village changes when the castle is upgraded.',
      'The ground is graded under every road: it follows the land smoothly, is level across its width and never climbs steeper than a walkable slope, eased into the hillside on each side, and it never fills in a river or moat beside it.',
      'Trade and diplomacy journeys between villages are shown as processions walking the road.',
      'Hand-drawn icons replace the emoji, including new resource icons and a redrawn charcoal burner.',
      'Raids come about once a week instead of more often.',
      'Staff go to food and wood workplaces first.',
      'Plagues last longer.',
    ],
    fixed: [
      'Levelled ground no longer misbehaves under later changes: a moat or river dug on ground levelled high now digs relative to it (the bed rises with the ground instead of a sheer shaft), the Level ground tool never half-fills a ditch beside its patch (only the pieces inside the patch are taken away), a later flatten wins over an earlier Level ground patch instead of the old patch bringing its height back, and flattening sets the buildings inside onto the new ground instead of leaving them on a pedestal or in a pit. The water of a moat follows the new ground. Old saves keep their terrain except where a ditch ran beside a Level ground patch, or a flatten was made over standing buildings.',
      'Road junctions are clean, in dirt and in stone: a road that ends on another (a T), crosses it (an X) or meets two others (a Y) now starts at the edge of the road it joins instead of from its middle, and the dark soft edge is drawn only along the outside of the joined roads, no longer as a seam across the junction. Works at any angle, for curved roads and for the short paths of buildings. The texture of the joint runs on from each road without a darker block.',
      'Moat water no longer floats: on a slope, at a hill or beside a lowered or levelled patch the water of a moat used to stand above the lower bank and hang in the air; it now never rises above the lowest ground round a moat piece and changes level only gently along the moat.',
      'Finished buildings no longer start rebuilding for no reason: when another building was pulled down, burnt or lost in a raid, every building after it in the list played its construction animation again.',
      'Waterwheels and watermills stand at the visible water level of a moat and sit on the bank, with the wheel dipping into the water.',
      'Fishing hut, gold mine and iron mine footings no longer glitch against the bank or the door pad.',
      'Drawbridges snap to face outward across the moat.',
      'Roads are no longer drawn across a moat or river or under a drawbridge: they stop at the bank. A road you lay shows the moment you lay it instead of growing in over the next day.',
      'A black beam over olive branches and scrolls.',
      'Jumping a moat, clicking mines, spires and upgrades that could only be added.',
    ],
  },
  {
    version: '0.1.0', date: '2026-11-14', title: 'The first playable world',
    added: [
      'A shared medieval world with no server: players\' browsers connect to each other, and a map link brings friends to the same world.',
      'Villages with families, ages, seasons and winter firewood; markets, caravans and treaties; diplomacy, churches, hospitals and graveyards.',
      'Armies, morale, heroes, hoardings that pour boiling oil, toll posts, scouts and fog of war.',
      'Player-drawn roads and bridges, gates and tunnels, wall walks with stairs, and a flag designer.',
      'Playable on GitHub Pages, straight in the browser.',
    ],
    changed: ['Better water with depth colour, shore foam and ripples, and a bigger map.', 'Much faster rendering.'],
    fixed: ['Gate and hoarding fixes, and a checked population counter.'],
  },
];

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** The notes page body as HTML: one section per version, newest first, each with its New / Changed / Fixed groups (empty groups are left out). */
export function renderNotes(releases: Release[] = RELEASES): string {
  const group = (name: string, items: string[]) => items.length ? `<h4>${name}</h4><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
  return releases.map(r => `<section class="release"><h3>${esc(r.version)} <small>${esc(r.date)}</small></h3><p class="muted">${esc(r.title)}</p>${group('New', r.added)}${group('Changed', r.changed)}${group('Fixed', r.fixed)}</section>`).join('');
}

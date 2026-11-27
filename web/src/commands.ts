// Applying commands to a World, and reading a saved history back. Shared by your own village, the replicas of other players and the replay.
import type { World } from './wasm/game_core.js';
import { parseCmd } from './net/validate.ts';
import type { Cmd, Signed } from './net/p2p.ts';

export function applyCmd(w: World, c: Cmd) {
  switch (c.op) {
    case 'place':
      if (c.h === undefined) w.place(c.kind!, c.x!, c.y!, c.rot ?? 0);
      else w.place_earthwork(c.kind!, c.x!, c.y!, c.rot ?? 0, c.h);
      break;
    case 'upgrade': if (c.kind === 2) w.upgrade_all_roads(c.idx!); else if (c.kind === 1) w.upgrade_road(c.idx!); else w.upgrade(c.idx!); break;   // kind 1: the whole stretch of road the piece is part of; kind 2: every road of the kingdom, idx the surface (roadnet.rs)
    case 'demolish': w.demolish(c.idx!); break;
    case 'train': w.train(c.kind!, c.x!); break;
    case 'untrain': w.train_cancel(c.kind!, c.x!); break;
    case 'attack': w.send_army(Uint32Array.from(c.units ?? [])); break;
    case 'raid': w.start_raid_equipped(c.angle ?? 0, Uint32Array.from(c.units ?? []), c.tag ?? 1, c.tech ?? 0); break;
    case 'research': w.military_research(c.kind!); break;
    case 'armybridge': w.army_set_bridge_shortcuts(c.kind === 1); break;
    case 'battleorder': if (!c.to) w.battle_order(c.tag ?? 0, c.idx!, c.kind!, c.x ?? 0, c.y ?? 0); break;
    case 'cheat': w.cheat(c.kind ?? 0, c.x ?? 0, c.y ?? 0); break;
    case 'repair': w.repair(c.idx!); break;
    case 'garrison': w.garrison_set(c.idx!, c.kind ?? 0); break;
    case 'bridge': w.drawbridge_set(c.idx!, (c.kind ?? 0) === 1); break;
    case 'option': if (c.y === 2) w.set_all_road_options(c.kind ?? 0, (c.x ?? 1) === 1); else if (c.y === 1) w.set_road_option(c.idx!, c.kind ?? 0, (c.x ?? 1) === 1); else w.set_option(c.idx!, c.kind ?? 0, (c.x ?? 1) === 1); break;   // y 1: along the whole stretch of road
    case 'level': w.level_ground(c.x!, c.y!, c.kind ?? 0, c.h ?? -1); break;   // x, y the middle, kind the radius, h the height (absent in older logs: Auto, the land round it)
    case 'plant': w.plant_trees(c.x!, c.y!, c.kind ?? 4); break;   // x, y the middle, kind the brush radius
    case 'rally': w.set_rally((c.kind ?? 0) & 1, c.x ?? 0, c.y ?? 0, (c.kind ?? 0) >= 2); break;   // kind 0 the barracks, 1 the castle; 2 and 3 clear the point the player chose
    case 'zone': w.set_plant_zone(c.idx!, c.x ?? 0, c.y ?? 0); break;   // idx a forester, x, y where it plants, from the forester itself
    case 'flatten': w.flatten(c.x ?? 60, c.y === undefined ? -1 : c.y / 10); break;
    case 'batch':
      if (c.h === undefined) w.place_batch(Int32Array.from(c.units ?? []));
      else w.place_batch_height(Int32Array.from(c.units ?? []), c.h);
      break;
    case 'road': w.lay_road(Int32Array.from(c.units ?? [])); break;   // [dx, dy] per point of a road the player drew: pieces joined into one curve, the ends snapped onto nodes
    case 'visit': w.visit_neutral(c.idx!); break;
    case 'wild': w.wild_act(c.kind ?? 0, c.idx!); break;   // a wild place: 1 tithe to an abbey, 2 abandon a mineshaft (see wilds.rs)
    case 'hero': w.hero_hire(); break;
    case 'field': w.set_field_mode(c.idx!, c.kind ?? 0); break;
    case 'workers': w.set_workers(c.idx!, c.kind ?? -1); break;   // idx the building, kind the workers wanted (-1 auto, 0 paused)
    case 'reserve': w.set_reserves(c.x!, c.y!); break;
    case 'style': w.set_style(c.kind ?? 0); break;
    case 'goods': break;   // a notice that a caravan arrived: the receiver acts on it (see onCmd), nothing to replay
    case 'accept': w.receive_goods_from(c.kind ?? 0, c.x ?? 0, c.idx ?? 0); break;   // idx the sender's tag: a hostile village's caravan is turned away by the core
    case 'carhome': w.caravan_returned(c.kind ?? 0, c.x ?? 0, c.idx ?? 0); break;   // our caravan was turned back: the goods come home
    case 'turnback': break;   // a notice that we turned a caravan back: the sender takes its goods home (see onTrade), nothing to replay
    case 'settle': w.settle(c.kind ?? 0, c.x ?? 0, c.idx ?? 0); break;
    case 'choose': w.choose(c.kind ?? 0); break;
    case 'bribe': w.bribe(); break;   // the raiders are paid to turn back (the core checks it is allowed and affordable at this tick)
    case 'treaty': if ((c.y ?? 1) === 0) w.treaty_end(c.idx!, c.kind ?? 0); else w.treaty_set(c.idx!, c.kind ?? 0, c.x ?? 10); break;
    case 'buy': w.buy(c.kind ?? 0, c.idx ?? 0); break;   // kind = the good, idx = how many
    case 'envoy': w.envoy(c.idx!); break;
    case 'marriage': w.marriage(c.idx!); break;
    case 'war': w.declare_war(c.idx!); break;
    case 'journey': w.journey_start(c.kind ?? 0, c.idx ?? 0, c.x ?? 0, c.y ?? 0); break;   // an errand sets out for another village: the treaty, gifts, wedding or war is done when it arrives
    case 'arrive': break;   // a notice that an errand reached its village: the receiver answers it (see onTrade), nothing to replay
    case 'clear': w.clear_deposit(c.idx!); break;
    case 'demo': w.demo(c.kind ?? 0, c.x ?? 0, c.y ?? 0, c.idx ?? 0); break;   // model-village testing tool
    case 'gate': w.gate_set(c.idx!, (c.kind ?? 0) === 1); break;
    case 'caravan': w.caravan_send(c.kind ?? 0, c.x ?? 0, c.idx ?? 0, c.y ?? 0, c.ax ?? 0); break;
    case 'rebuild': w.rebuild(c.idx!); break;
    case 'form': w.det_form(Uint32Array.from(c.units ?? [])); break;
    case 'march': w.det_march(c.idx!, c.x!, c.y!, !!c.to, c.ax ?? 0, c.ay ?? 0); break;
    case 'recall': w.det_recall(c.idx!); break;
    case 'split': w.det_split(c.idx!, Uint32Array.from(c.units ?? [])); break;
    case 'merge': w.det_merge(c.idx!, c.kind!); break;
    case 'halt': w.det_halt(c.idx!); break;
    case 'sendatk': w.det_send(c.idx!); break;
    case 'sendaid': w.det_send(c.idx!); break;   // our soldiers go to help an ally: they leave the field (and are counted as away until they come home)
    case 'host': w.host_guests(c.tag ?? 0, Uint32Array.from(c.units ?? [])); break;   // the host village took an ally's soldiers in (only the host's village and its copies run this)
    case 'unhost': w.release_guests(c.tag ?? 0); break;   // ...and sent them home
    case 'recallaid': case 'ask': break;   // requests between players: they change nothing in any village
    case 'defend': w.det_defend(c.idx!); break;   // a field army marches to the fight at home and joins the defenders
    case 'retreat': if (c.tag) w.battle_retreat(c.tag); break;   // (the attacker's own call has no `tag`: it is only a request, which the defender's village carries out and records with the tag)
    case 'reinforce': if (c.tag) w.battle_reinforce_equipped(c.tag, Uint32Array.from(c.units ?? []), c.tech ?? 0); break;
    case 'link': w.link_village(c.x ?? 0, c.y ?? 0); break;   // an invisible path chained out to another village's city
    case 'restart': w.restart(); if (c.kind === 1) w.set_reserves(0, 0); break;
    case 'return':
      if (c.kind === 1) w.return_refused_army(Uint32Array.from(c.units ?? []));
      else w.return_army(Uint32Array.from(c.units ?? []), Int32Array.from(c.loot ?? []));
      break;
    default: break; // 'refuse' has no effect on the issuer's own world
  }
}
/** Step a world to a tick. The ticks in a history are bounded by the checks in validate.ts, so this only guards against nonsense (a command must land on its own tick, never an earlier one). */
export const stepTo = (w: World, t: number) => { let n = 0; while (w.tick() < BigInt(t) && n++ < 2_000_000) w.step(); };


/** The saved history of your own village, read back carefully: a damaged or edited save must not crash the game. Testing-tool commands are your own and stay. */
export function validSavedLog(log: unknown): { signed: Signed; cmd: Cmd }[] {
  if (!Array.isArray(log)) return [];
  const out: { signed: Signed; cmd: Cmd }[] = []; let n = -1, t = 0, epoch = 0;
  for (const s of log.slice(0, 60000)) {
    if (!s || typeof s.cmd !== 'string' || typeof s.sig !== 'string') break;
    const cmd = parseCmd(s.cmd, true) as Cmd | null;
    if (!cmd || cmd.n <= n && out.length || cmd.tick < t) break;
    // a history is one epoch (see restart.ts): epoch 0 has no restart command, a later one starts with its own and nothing of another epoch follows
    if (!out.length) epoch = cmd.e ?? 0;
    if ((cmd.e ?? 0) !== epoch || (cmd.op === 'restart') !== (!out.length && epoch > 0)) break;
    n = cmd.n; t = cmd.tick; out.push({ signed: { cmd: s.cmd, sig: s.sig }, cmd });
  }
  return out;
}


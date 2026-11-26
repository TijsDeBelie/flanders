import { campSite } from './campsite';
import { NetView } from './render/netview';
import { drawnUp } from './defence';
import { settings } from './settings';
import { STEP, deck, type Deck } from './render/terrain';
import { MoatWater } from './render/moatwater';
import { freeze } from './render/static';
import { soldierSpansFlat } from './render/soldierspans';
import { WIDTH, deckHeight } from './render/spanplan';
import * as THREE from 'three';
import type { World } from './wasm/game_core.js';
import type { Terrain } from './render/terrain';
import { VillageView } from './render/buildings';
import { unpackFlag, flagColor } from './flag';
import { Paths } from './render/paths';
import { parseRoadLines, joinLines } from './render/roadmesh';
import { planRoadProps } from './render/roadplan';
import { RoadNodes } from './render/roadnodes';
import { Walls } from './render/walls';
import { Spans } from './render/spans';
import { Props } from './render/props';
import { FieldView, BridgesView } from './render/field';
import { People } from './render/people';
import { ArmyView } from './render/army';
import { pickFoe } from './render/fight';
import { Boats } from './render/boats';
import { Ruins, type Effects2 } from './render/fx';
import type { Wildlife } from './render/wildlife';
import type { Crowd } from './render/crowd';
import { WalkRouter } from './walkrouter';
import { PlantedTrees } from './render/plantedtrees';

/** Things every village shares. */
export interface Shared {
  scene: THREE.Scene; terrain: Terrain; wildlife: Wildlife; fx: Effects2; radii: number[]; forest: import('./render/trees').Forest;
  /** Ground shape changed (new pads, craters, scorch): refresh the mesh around this village. */
  terrainChanged(v: Village): void;
  /** Trees need to be recounted (a building, ruin or burn scar appeared). */
  forestDirty(): void;
  /** False on phones and tablets: villagers do not cast shadows there (see device.ts `touchLimits`). */
  crowdShadows?: boolean;
}

/** One village: its simulation plus everything that draws it. Used for your own village and for every rival replica. */
const NO_PATHS = new Float32Array(0);   // (nothing is linked automatically any more: villagers walk the path network of the core, see World.net_route)
export class Village {
  private defaultBanner = 0;
  private walker: WalkRouter;
  moats: MoatWater; nets: NetView; planted: PlantedTrees;
  view: VillageView; paths: Paths; nodes: RoadNodes; walls: Walls; spans: Spans; props: Props; field: FieldView; bridges: BridgesView; people: People; army: ArmyView; ruins: Ruins; boats: Boats;
  clear: { x: number; z: number; r: number }[] = [];
  /** Groves kept standing inside a big cleared area. */
  keep: { x: number; z: number; r: number }[] = [];
  clearLines: { ax: number; az: number; bx: number; bz: number; r: number }[] = [];
  private count = -1; private version = -1; private reportSeq = 0; private mapVersion = -1;
  hall = { x: 0, z: 0, tier: 0 };
  onReport?: (report: number[]) => void;
  /** A boss's slam (2) or horn (3) went off at (x, z): the page plays the sound. Set once, for every village. */
  static onBossFx: ((kind: number, x: number, z: number) => void) | null = null;
  fireData: Float32Array = new Float32Array(0);

  constructor(public world: World, public key: string, public name: string, public mine: boolean, private sh: Shared, color: number) {
    this.defaultBanner = color;
    this.view = new VillageView(color, (x, z, rot) => this.world.shore_water_height(x, z, rot), (x, z) => sh.terrain.heightAt(x, z, true));
    this.paths = new Paths(sh.terrain); this.nodes = new RoadNodes(sh.terrain); this.walls = new Walls(sh.terrain); this.spans = new Spans(sh.terrain); this.props = new Props(sh.terrain);
    this.moats = new MoatWater(sh.terrain, STEP); sh.scene.add(this.moats.group);
    this.planted = new PlantedTrees(sh.terrain); sh.scene.add(this.planted.group);
    this.nets = new NetView(sh.terrain); sh.scene.add(this.nets.group);
    this.field = new FieldView(sh.terrain); this.field.friend = color; this.field.site = campSite(() => this.world, sh.terrain, () => sh.forest); this.bridges = new BridgesView(sh.terrain); this.people = new People(sh.terrain);
    this.army = new ArmyView(sh.terrain); this.army.onDock = (x, z) => this.sh.fx.dock(x, z); this.ruins = new Ruins(sh.terrain);
    if (sh.crowdShadows === false) this.people.group.traverse((o: THREE.Object3D) => { o.castShadow = false; });
    const channel = (x: number, z: number) => this.moats.levelAt(x, z);
    this.army.channelLevelAt = this.field.channelLevelAt = channel;
    this.boats = new Boats(sh.terrain, channel);
    this.army.friend = color; this.army.radii = sh.radii; this.army.onHit = (x, z, y, k) => sh.fx.hit(x, y, z, k); this.army.onRage = (x, y, z) => sh.fx.rageSpark(x, y, z);
    // villagers' routes are planned off the main thread (walk-route.worker.ts): the page never waits for one
    this.walker = new WalkRouter(() => this.world, mine);   // (your own village: the worker starts and maps the ground while the page loads)
    this.people.router = (a, b, c, d) => this.walker.get(a, b, c, d);
    this.people.depositClear = (a, b, c, d) => this.world.deposit_leg_clear(a, b, c, d);
    this.army.plan = (ax, az, bx, bz) => {
      const route = this.world.walk_route(ax, az, bx, bz);
      if (route.length < 3) return null;
      const path = [ax, az, 0];
      for (let i = 1; i + 1 < route.length; i += 2) path.push(route[i], route[i + 1], 0);
      return path;
    };
    this.people.hooks = { wild: sh.wildlife, arrow: (a, b, c, d, e, f) => sh.fx.arrowAt(a, b, c, d, e, f), splash: (a, b, c, d, e, f) => sh.fx.waterThrow(a, b, c, d, e, f) };
    sh.scene.add(this.field.group, this.bridges.group, this.props.group, this.view.root, this.view.batchRoot, this.paths.group, this.nodes.group, this.walls.group, this.spans.group, this.army.group, this.ruins.group, this.people.group, this.boats.group);
    // these containers never move (everything in them is in world coordinates): frozen, they stop forcing every building, wall and prop below them to recompute its
    // world matrix every frame. Whatever inside them does move (a building popping up, a boat) still updates itself.
    freeze(this.field.group, this.bridges.group, this.props.group, this.view.root, this.view.batchRoot, this.paths.group, this.nodes.group, this.walls.group, this.spans.group, this.army.group, this.ruins.group, this.people.group, this.boats.group, this.moats.group, this.planted.group, this.nets.group);
  }

  /** Which building (index) is under the pointer? Walls are separate meshes. */
  pick(ray: THREE.Raycaster): number | null {
    // the nearest thing under the pointer wins: a wall in front of a house is the wall (it used to pick whatever was behind it)
    let best: { idx: number; d: number } | null = null;
    for (const h of [this.view.pickHit(ray), this.walls.pickHit(ray), this.spans.pickHit(ray)]) if (h && (!best || h.d < best.d)) best = h;
    return best ? best.idx : null;
  }

  get ox() { return this.world.origin_x(); }
  get oz() { return this.world.origin_y(); }
  get radius() { return this.world.build_radius(); }

  dispose() {
    this.walker.dispose();
    this.sh.scene.remove(this.field.group, this.bridges.group, this.props.group, this.view.root, this.view.batchRoot, this.paths.group, this.nodes.group, this.walls.group, this.spans.group, this.army.group, this.ruins.group, this.people.group, this.boats.group);
    this.view.root.traverse(o => (o as THREE.Mesh).geometry?.dispose());
    this.sh.scene.remove(this.moats.group, this.nets.group, this.planted.group); this.planted.dispose(); this.moats.dispose(); this.nets.dispose(); this.sh.terrain.setDecks(this, []);
    this.walls.dispose(); this.spans.dispose(); this.nodes.dispose(); this.paths.group.traverse(o => (o as THREE.Mesh).geometry?.dispose());
  }

  /** Swap in a fresh world (after moving to another site, or a rebuilt replica). */
  setWorld(w: World) { if (w !== this.world) { this.people.resetRoster(); this.walker.reset(); } this.world = w; this.count = -1; this.version = -1; this.reportSeq = 0; }

  /** The bridges the soldiers have built (or are building), as spans of the same kind the player's bridges are: bank to bank, at deck height, drawn by `spans` with the same deck and rails. */
  private soldierFlat: Float32Array = new Float32Array(0);
  private allSpans(w: World): Float32Array {
    const mine = w.bridge_spans_flat(), all: Float32Array = new Float32Array(mine.length + this.soldierFlat.length); all.set(mine); all.set(this.soldierFlat, mine.length); return all;
  }

  /** Register what can be walked on above the ground: lowered drawbridges and the footbridges, at the height of their decks, so walkers cross them instead of sinking into the water under. */
  private updateDecks(w: World, f: Float32Array) {
    const list: Deck[] = [];
    for (let i = 0; i + 9 < f.length; i += 10) {
      if (f[i] !== 23 || drawnUp(f[i + 6], this.view.raised)) continue;   // a drawbridge that is drawn up has no deck to cross (one lent to an army is down, in a fight too)
      const a = (f[i + 4] & 7) * Math.PI / 4, sx = Math.sin(a), sz = Math.cos(a), x = f[i + 2], z = f[i + 3], y = f[i + 5] + 0.02;   // (the top of the deck planks lies flush with the pad: see the model)
      list.push(deck(x - sx * 6.4, z - sz * 6.4, x + sx * 6.4, z + sz * 6.4, 1.5, y, y));
    }
    const sp = this.allSpans(w);
    for (let o = 0; o + 9 < sp.length; o += 10) {
      const cx = sp[o + 1], cz = sp[o + 2], ang = sp[o + 3], L = sp[o + 4], tier = sp[o + 5], ux = Math.cos(ang), uz = Math.sin(ang), n = 6;
      const input = { length: L, tier, hA: sp[o + 7], hB: sp[o + 8], bed: () => 0, options: 0 };
      for (let k = 0; k < n; k++) {   // the deck rises and falls along the span (stone ones hump), so it is walked as a few short strips
        const s0 = -L / 2 + (L * k) / n, s1 = -L / 2 + (L * (k + 1)) / n;
        list.push(deck(cx + ux * s0, cz + uz * s0, cx + ux * s1, cz + uz * s1, WIDTH[Math.min(3, Math.max(0, tier))] / 2, deckHeight(input, s0), deckHeight(input, s1)));
      }
    }
    this.sh.terrain.setDecks(this, list);
  }

  /** Rebuild everything that depends on the building list. */
  syncFull() {
    { const fl = unpackFlag(this.world.style()), col = fl ? flagColor(fl) : this.defaultBanner; this.view.setFlag(fl, col); this.field.friend = col; this.army.friend = col; }
    const w = this.world, f = w.buildings_flat(), roads = w.roads_flat();
    this.view.raised = w.battle_active();
    this.hall = { x: f[2], z: f[3], tier: f[1] };
    this.clear = this.view.sync(f, this.sh.radii, w.building_health(), w.options_flat());
    for (let i = 0; i < f.length; i += 10) { const k = f[i]; if (k === 24) this.clear.push({ x: f[i + 2], z: f[i + 3], r: 6.4 * (1 + 0.13 * (f[i + 4] & 7)) }); else if (k === 32 || k === 33 || k === 34) this.clear.push({ x: f[i + 2], z: f[i + 3], r: 5.6 }); }   // no trees on the banks of a moat or river or on earthworks
    this.paths.update(f, w.road_lines_flat(), this.sh.radii, w.birth_flat());
    this.nodes.update(w.road_nodes_flat());
    this.walls.update(f, w.terrain_version(), w.options_flat(), w.gates_shut_flat());
    const water = w.moat_water_flat();
    this.spans.update(this.allSpans(w)); this.updateDecks(w, f); this.moats.update(water, f);
    { // what the design options of the roads put along them (trees, hedges, benches, lanterns)
      const lines = joinLines(parseRoadLines(w.road_lines_flat())), laid: number[] = [];   // (the stretches between the pieces joined into the roads they make: a road is as long as it runs from end to end)
      for (const l of lines) if (l.kind === 1) for (let k = 2; k + 1 < l.pts.length; k += 2) laid.push(l.pts[k - 2], l.pts[k - 1], l.pts[k], l.pts[k + 1]);
      const planned = planRoadProps(lines, (x, z) => this.sh.terrain.heightAt(x, z) > 0.5);
      this.props.update(f, roads, this.sh.radii, { props: planned, laid, sig: lines.filter(l => l.kind === 1 && l.opts).map(l => `${l.opts}:${l.pts.length}:${l.pts[0].toFixed(1)}:${l.pts[1].toFixed(1)}:${l.pts[l.pts.length - 1].toFixed(1)}`).join(',') });
    }
    this.clearLines = []; for (let i = 0; i < roads.length; i += 6) this.clearLines.push({ ax: roads[i], az: roads[i + 1], bx: roads[i + 2], bz: roads[i + 3], r: 2.4 });
    this.people.setRoads(roads, w.road_tiers_flat()); this.people.sync(f, NO_PATHS, this.sh.radii, w.population(), w.terrain_version());
    this.boats.sync(f, w.terrain_version());
    this.army.syncPeace(f, Array.from(w.army()), w.guards(), Array.from(w.garrison_flat()));
    this.army.syncWalls(this.walls.walks);
    this.ruins.sync(w.ruins_flat(), w.terrain_version());
    this.sh.wildlife.syncDomestic(this.key, f);
    this.clearBase = this.clear.slice();   // (what clears the ground apart from felled trees and scorch marks, which change on their own)
    const fl = w.felled_flat(); for (let i = 0; i < fl.length; i += 3) this.clear.push({ x: fl[i], z: fl[i + 1], r: fl[i + 2] });
    this.keep = []; const gv = w.groves_flat(); for (let i = 0; i < gv.length; i += 3) this.keep.push({ x: gv[i], z: gv[i + 1], r: gv[i + 2] });
    this.mapVersion = w.map_version();
    const sc = w.scorch_flat(); for (let i = 0; i < sc.length; i += 3) this.clear.push({ x: sc[i], z: sc[i + 1], r: sc[i + 2] * 0.95 });
    this.count = w.building_count(); this.version = w.terrain_version();
    this.planted.set(w.planted_flat(), Number(w.tick()));
    this.sh.forestDirty();
  }

  private clearBase: { x: number; z: number; r: number }[] = []; private lastFelled = -Infinity;
  private refreshFelled(w: World) {
    this.lastFelled = performance.now();
    this.clear = this.clearBase.slice();
    const fl = w.felled_flat(); for (let i = 0; i < fl.length; i += 3) this.clear.push({ x: fl[i], z: fl[i + 1], r: fl[i + 2] });
    const sc = w.scorch_flat(); for (let i = 0; i < sc.length; i += 3) this.clear.push({ x: sc[i], z: sc[i + 1], r: sc[i + 2] * 0.95 });
    this.planted.set(w.planted_flat(), Number(w.tick()));
    this.mapVersion = w.map_version(); this.sh.forestDirty();
  }

  /** Cheap per-tick refresh: statuses, fire damage, battle positions, projectiles. */
  afterTick() {
    const w = this.world;
    const fighting = w.battle_active();
    this.view.raised = fighting;
    const f = w.buildings_flat(), hp = w.building_health();
    if (w.building_count() !== this.count || w.terrain_version() !== this.version) {
      if (w.terrain_version() !== this.version) this.sh.terrainChanged(this);
      this.syncFull();
    } else {
      if (w.map_version() !== this.mapVersion && performance.now() - this.lastFelled > 1200) this.refreshFelled(w);   // trees felled by marching soldiers: only the clearings are redone, and not more than about once a second
      const opts = w.options_flat();
      this.view.syncState(f, this.sh.radii, hp, opts);
      this.people.sync(f, NO_PATHS, this.sh.radii, w.population(), w.terrain_version());
      this.walls.update(f, w.terrain_version(), opts, w.gates_shut_flat()); this.spans.update(this.allSpans(w)); this.updateDecks(w, f); this.army.syncWalls(this.walls.walks);
      this.army.syncPeace(f, Array.from(w.army()), w.guards(), Array.from(w.garrison_flat()));
    }
    { const t = Number(w.tick()); if (!settings().showPaths) this.nets.update(null); else if (t - this.lastNet >= 8 || t < this.lastNet) { this.lastNet = t; this.nets.update(w.net_flat()); } }
    this.planted.refresh(Number(w.tick()));
    this.fireData = w.fires_flat(); this.people.setFires(this.fireData); this.paths.setTick(Number(w.tick()));
    { // work for builders: damaged buildings (not burning) and ruins
      const jobs: { x: number; z: number; r: number }[] = [];
      for (let i = 0; i < f.length / 10; i++) if (hp[i * 3 + 1] > 0 && hp[i * 3] / hp[i * 3 + 1] < 0.95 && hp[i * 3 + 2] <= 0) jobs.push({ x: f[i * 10 + 2], z: f[i * 10 + 3], r: this.sh.radii[f[i * 10]] });
      const ru = w.ruins_flat(); for (let i = 0; i < ru.length; i += 6) jobs.push({ x: ru[i], z: ru[i + 1], r: ru[i + 2] });
      // roads being paved: builders work at the paving front
      const rf = w.roads_flat(), born = w.birth_flat(), tick = Number(w.tick());
      for (let i = 0; i < rf.length; i += 6) {
        const p = (tick - Math.max(born[rf[i + 4]] ?? 0, born[rf[i + 5]] ?? 0) - 360) / 900;
        if (p > 0 && p < 1) jobs.push({ x: rf[i + 2] + (rf[i] - rf[i + 2]) * p, z: rf[i + 3] + (rf[i + 1] - rf[i + 3]) * p, r: 0.6 });
      }
      this.people.setJobs(jobs);
    }
    this.syncField();
    if (fighting) this.army.foe = pickFoe(this.army.friend, this.foeColor(w.battle_tag()) ?? 0x4a3a2a);
    if (!fighting) { const last = w.take_last_battle_frame(); if (this.army.battle && last.length) this.army.syncBattle(last); }
    this.army.syncBattle(fighting ? w.battle_units_flat() : new Float32Array(0), fighting ? w.battle_detachment_ids() : undefined);
    this.army.syncSiegeWorks(fighting ? w.battle_ladders_flat() : new Float32Array(0), fighting ? w.battle_bridges_flat() : new Float32Array(0), fighting ? w.battle_siege_flat() : new Float32Array(0));
    this.people.hidden = fighting;
    const tk = Number(w.tick()), jumped = tk - this.lastShotTick > 8; this.lastShotTick = tk;   // after loading or catching up, old shots must not fly again
    const s = w.take_shots();
    if (!jumped) for (let i = 0; i < s.length; i += 7) {
      if (s[i] === 2) { this.sh.fx.slam(s[i + 1], s[i + 2], 3.5); Village.onBossFx?.(2, s[i + 1], s[i + 2]); }   // a boss's slam
      else if (s[i] === 4) this.sh.fx.collapse(s[i + 1], s[i + 2], 5);   // a wall section falls to a sap, or a siege tower is wrecked
      else if (s[i] === 3) { this.sh.fx.hornBlast(s[i + 1], s[i + 2], 32); Village.onBossFx?.(3, s[i + 1], s[i + 2]); }   // a warlord's horn
      else this.sh.fx.shot(s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5] > 0.5, s[i] === 0 ? this.army.shooterHeight(s[i + 1], s[i + 2]) : 1.5);
    }
    const r = w.last_report();
    if (r.length && r[0] !== this.reportSeq) { this.reportSeq = r[0]; if (!this.fresh) this.onReport?.(Array.from(r)); }
  }
  /** The colour of the attacking army with this tag (0 = bandits), if known. Set by main.ts, which knows every player's flag. */
  foeColor: (tag: number) => number | null = () => null;
  /** Reports older than the moment we started watching are ignored. */
  private lastShotTick = -Infinity; private lastNet = -Infinity;
  fresh = true;
  markCaughtUp() { this.view.animateNew = true; this.fresh = false; const r = this.world.last_report(); if (r.length) this.reportSeq = r[0]; }

  /** Advance a replica to `tick`. Battle projectiles are dropped when catching up a long way. Returns whether it got there: it stops after 8000 steps (a command that far ahead
   *  is not applied, because it would land at the wrong tick). */
  advanceTo(tick: number): boolean {
    const w = this.world; let n = 0;
    while (w.tick() < BigInt(tick)) { w.step(); n++; if (n >= 8000) break; }
    if (n > 8) w.take_shots();
    if (n > 0) this.afterTick();
    return w.tick() >= BigInt(tick);
  }

  /** Field armies, bridges and the soldiers' progress. */
  syncField() {
    const w = this.world, flat = w.det_flat();
    this.field.sync(flat, id => w.det_path(id), w.det_files_flat(), w.det_approaches_flat());
    const br = Array.from(w.bridges_flat()), bf = w.buildings_flat();
    for (let i = 0; i < bf.length; i += 10) if (bf[i] === 23) { const a = bf[i + 4] * Math.PI / 4, sx = Math.sin(a) * 6.4, sz = Math.cos(a) * 6.4; br.push(bf[i + 2] - sx, bf[i + 3] - sz, bf[i + 2] + sx, bf[i + 3] + sz); }   // drawbridges carry soldiers too
    const partial: number[][] = [];
    for (let o = 0; o < flat.length; o += 17) if (flat[o + 8] === 3) { const p = w.det_path(flat[o]); if (p.length >= 6) partial.push([p[0], p[1], p[3], p[4], flat[o + 11]]); }
    // soldiers' bridges are laid like the player's: same design, bank to bank at deck height (not as planks on the bed of the moat)
    const sf = soldierSpansFlat(Array.from(w.bridges_flat()), partial, (x, z) => this.sh.terrain.heightAt(x, z));
    if (sf.length !== this.soldierFlat.length || sf.some((q, i) => Math.abs(q - this.soldierFlat[i]) > 0.01)) { this.soldierFlat = sf; this.spans.update(this.allSpans(w)); this.updateDecks(w, bf); }
    this.bridges.update([], []);
  }

  private farDt = 0;
  /** `near`: the village is close enough to the camera for its people to be drawn. A far one moves them about four times a second, with the time saved up. */
  frame(dt: number, speed: number, camera: THREE.Vector3, detailRange: number, crowds: boolean, near = true) {
    this.boats.update(dt);
    let cdt = dt;
    if (!near) { this.farDt += dt; if (this.farDt < 0.25) cdt = 0; else { cdt = this.farDt; this.farDt = 0; } }
    else if (this.farDt > 0) { cdt += this.farDt; this.farDt = 0; }
    if (cdt > 0 && crowds && !this.people.hidden) this.people.update(cdt, speed);
    if (cdt > 0) this.army.update(cdt);
    this.view.update(dt, camera, detailRange * 2.6); this.field.update(dt);
  }
  draw(crowd: Crowd, cx: number, cz: number, radius: number, camera: THREE.Vector3, detailRange: number) { this.field.draw(crowd, cx, cz, radius); this.boats.draw(crowd, cx, cz, radius); this.people.draw(crowd, cx, cz, radius, camera, detailRange); this.army.draw(crowd, { x: this.ox, z: this.oz }, cx, cz, radius); }
}

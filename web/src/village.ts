import * as THREE from 'three';
import type { World } from './wasm/game_core.js';
import type { Terrain } from './render/terrain';
import { VillageView } from './render/buildings';
import { BANNER_STYLES } from './data';
import { Paths } from './render/paths';
import { Walls } from './render/walls';
import { Props } from './render/props';
import { FieldView, BridgesView } from './render/field';
import { People } from './render/people';
import { ArmyView } from './render/army';
import { RiverFlow } from './render/rivers';
import { Boats } from './render/boats';
import { Ruins, type Effects2 } from './render/fx';
import type { Wildlife } from './render/wildlife';
import type { Crowd } from './render/crowd';

/** Things every village shares. */
export interface Shared {
  scene: THREE.Scene; terrain: Terrain; wildlife: Wildlife; fx: Effects2; radii: number[]; forest: import('./render/trees').Forest; obstacles: () => { x: number; z: number; r: number }[];
  /** Ground shape changed (new pads, craters, scorch): refresh the mesh around this village. */
  terrainChanged(v: Village): void;
  /** Trees need to be recounted (a building, ruin or burn scar appeared). */
  forestDirty(): void;
}

/** One village: its simulation plus everything that draws it. Used for your own village and for every rival replica. */
export class Village {
  private defaultBanner = 0;
  view: VillageView; paths: Paths; walls: Walls; props: Props; field: FieldView; bridges: BridgesView; people: People; army: ArmyView; ruins: Ruins; rivers: RiverFlow; boats: Boats;
  clear: { x: number; z: number; r: number }[] = [];
  clearLines: { ax: number; az: number; bx: number; bz: number; r: number }[] = [];
  /** Circles soldiers must walk round. */
  obstacles: { x: number; z: number; r: number }[] = [];
  private count = -1; private version = -1; private reportSeq = 0; private mapVersion = -1;
  onReport?: (report: number[]) => void;
  fireData: Float32Array = new Float32Array(0);

  constructor(public world: World, public key: string, public name: string, public mine: boolean, private sh: Shared, color: number) {
    this.defaultBanner = color; this.view = new VillageView(color); this.paths = new Paths(sh.terrain); this.walls = new Walls(sh.terrain); this.props = new Props(sh.terrain);
    this.field = new FieldView(sh.terrain, sh.forest); this.field.friend = color; this.field.obstacles = sh.obstacles; this.bridges = new BridgesView(sh.terrain); this.people = new People(sh.terrain);
    this.army = new ArmyView(sh.terrain); this.ruins = new Ruins(sh.terrain); this.rivers = new RiverFlow(sh.terrain); this.boats = new Boats(sh.terrain);
    this.army.friend = color; this.army.radii = sh.radii;
    this.army.plan = (ax, az, bx, bz) => { const p = this.world.plan_march(Uint32Array.from([1, 0, 0, 0, 0]), ax, az, bx, bz); return p[0] === 1 ? Array.from(p.slice(5)) : null; };
    this.people.hooks = { wild: sh.wildlife, arrow: (a, b, c, d, e, f) => sh.fx.arrowAt(a, b, c, d, e, f), splash: (a, b, c, d, e, f) => sh.fx.waterThrow(a, b, c, d, e, f) };
    sh.scene.add(this.field.group, this.bridges.group, this.props.group, this.view.root, this.view.batchRoot, this.paths.group, this.walls.group, this.army.group, this.ruins.group, this.rivers.group, this.people.group, this.boats.group);
  }

  /** Which building (index) is under the pointer? Walls are separate meshes. */
  pick(ray: THREE.Raycaster): number | null { return this.view.pick(ray) ?? this.walls.pick(ray); }

  get ox() { return this.world.origin_x(); }
  get oz() { return this.world.origin_y(); }
  get radius() { return this.world.build_radius(); }

  dispose() {
    this.sh.scene.remove(this.field.group, this.bridges.group, this.props.group, this.view.root, this.view.batchRoot, this.paths.group, this.walls.group, this.army.group, this.ruins.group, this.rivers.group, this.people.group, this.boats.group);
    this.view.root.traverse(o => (o as THREE.Mesh).geometry?.dispose());
    this.walls.dispose(); this.paths.group.traverse(o => (o as THREE.Mesh).geometry?.dispose());
  }

  /** Swap in a fresh world (after moving to another site, or a rebuilt replica). */
  setWorld(w: World) { this.world = w; this.count = -1; this.version = -1; this.reportSeq = 0; }

  /** Rebuild everything that depends on the building list. */
  syncFull() {
    { const st = this.world.style(); if (st === 0) this.view.setBanner(this.defaultBanner); else this.view.setBanner(BANNER_STYLES[st]); }
    const w = this.world, f = w.buildings_flat(), roads = w.roads_flat();
    this.clear = this.view.sync(f, this.sh.radii, w.building_health(), w.options_flat());
    for (let i = 0; i < f.length; i += 10) { const k = f[i]; if (k === 24) this.clear.push({ x: f[i + 2], z: f[i + 3], r: 6.4 * (1 + 0.13 * (f[i + 4] & 7)) }); else if (k === 32 || k === 33 || k === 34) this.clear.push({ x: f[i + 2], z: f[i + 3], r: 5.6 }); }   // no trees on the banks of a moat or river or on earthworks
    this.obstacles = []; for (let i = 0; i < f.length; i += 10) { const k = f[i]; if (k === 22 || k === 24 || k === 23 || k === 32 || k === 33 || k === 34) continue; this.obstacles.push({ x: f[i + 2], z: f[i + 3], r: k === 2 ? 3 : k === 21 ? 1.6 : this.sh.radii[k] + 0.3 }); }
    this.paths.update(f, roads, this.sh.radii, w.birth_flat());
    this.walls.update(f, w.terrain_version(), w.options_flat());
    this.props.update(f, roads, this.sh.radii);
    this.clearLines = []; for (let i = 0; i < roads.length; i += 6) this.clearLines.push({ ax: roads[i], az: roads[i + 1], bx: roads[i + 2], bz: roads[i + 3], r: 2.4 });
    this.people.sync(f, w.road_paths_flat(), this.sh.radii, w.population());
    this.rivers.sync(f); this.boats.sync(f);
    this.army.syncPeace(f, Array.from(w.army()), w.guards(), Array.from(w.garrison_flat()));
    this.army.syncWalls(this.walls.walks);
    this.ruins.sync(w.ruins_flat(), w.terrain_version());
    this.sh.wildlife.syncDomestic(this.key, f);
    const fl = w.felled_flat(); for (let i = 0; i < fl.length; i += 3) this.clear.push({ x: fl[i], z: fl[i + 1], r: fl[i + 2] });
    this.mapVersion = w.map_version();
    const sc = w.scorch_flat(); for (let i = 0; i < sc.length; i += 3) this.clear.push({ x: sc[i], z: sc[i + 1], r: sc[i + 2] * 0.95 });
    this.count = w.building_count(); this.version = w.terrain_version();
    this.sh.forestDirty();
  }

  /** Cheap per-tick refresh: statuses, fire damage, battle positions, projectiles. */
  afterTick() {
    const w = this.world;
    if (w.building_count() !== this.count || w.terrain_version() !== this.version || w.map_version() !== this.mapVersion) {
      if (w.terrain_version() !== this.version) this.sh.terrainChanged(this);
      this.syncFull();
    } else {
      const f = w.buildings_flat();
      this.view.sync(f, this.sh.radii, w.building_health(), w.options_flat());
      this.people.sync(f, w.road_paths_flat(), this.sh.radii, w.population());
      this.walls.update(f, w.terrain_version(), w.options_flat()); this.army.syncWalls(this.walls.walks);
      this.army.syncPeace(f, Array.from(w.army()), w.guards(), Array.from(w.garrison_flat()));
    }
    this.fireData = w.fires_flat(); this.people.setFires(this.fireData); this.paths.setTick(Number(w.tick()));
    { // work for builders: damaged buildings (not burning) and ruins
      const f = w.buildings_flat(), hp = w.building_health(), jobs: { x: number; z: number; r: number }[] = [];
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
    const fighting = w.battle_active();
    this.army.syncBattle(fighting ? w.battle_units_flat() : new Float32Array(0));
    this.army.syncSiegeWorks(fighting ? w.battle_ladders_flat() : new Float32Array(0), fighting ? w.battle_bridges_flat() : new Float32Array(0));
    this.people.hidden = fighting; this.view.raised = fighting;
    const tk = Number(w.tick()), jumped = tk - this.lastShotTick > 8; this.lastShotTick = tk;   // after loading or catching up, old shots must not fly again
    const s = w.take_shots();
    if (!jumped) for (let i = 0; i < s.length; i += 7) this.sh.fx.shot(s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5] > 0.5);
    const r = w.last_report();
    if (r.length && r[0] !== this.reportSeq) { this.reportSeq = r[0]; if (!this.fresh) this.onReport?.(Array.from(r)); }
  }
  /** Reports older than the moment we started watching are ignored. */
  private lastShotTick = -Infinity;
  fresh = true;
  markCaughtUp() { this.view.animateNew = true; this.fresh = false; const r = this.world.last_report(); if (r.length) this.reportSeq = r[0]; }

  /** Advance a replica to `tick`. Battle projectiles are dropped when catching up a long way. */
  advanceTo(tick: number) {
    const w = this.world; let n = 0;
    while (w.tick() < BigInt(tick)) { w.step(); n++; if (n > 4000) break; }
    if (n > 8) w.take_shots();
    if (n > 0) this.afterTick();
  }

  /** Field armies, bridges and the soldiers' progress. */
  syncField() {
    const w = this.world, flat = w.det_flat();
    this.field.sync(flat, id => w.det_path(id));
    const br = Array.from(w.bridges_flat()), bf = w.buildings_flat();
    for (let i = 0; i < bf.length; i += 10) if (bf[i] === 23) { const a = bf[i + 4] * Math.PI / 4, sx = Math.sin(a) * 6.4, sz = Math.cos(a) * 6.4; br.push(bf[i + 2] - sx, bf[i + 3] - sz, bf[i + 2] + sx, bf[i + 3] + sz); }   // drawbridges carry soldiers too
    this.field.setBridges(Float32Array.from(br));
    const partial: number[][] = [];
    for (let o = 0; o < flat.length; o += 16) if (flat[o + 8] === 3) { const p = w.det_path(flat[o]); if (p.length >= 6) partial.push([p[0], p[1], p[3], p[4], flat[o + 11]]); }
    this.bridges.update(Array.from(w.bridges_flat()), partial);
  }

  private clock = 0;
  frame(dt: number, speed: number) { this.clock += dt; this.rivers.update(this.clock); this.boats.update(dt); this.people.update(dt, speed); this.army.update(dt); this.view.update(dt); this.field.update(dt); }
  draw(crowd: Crowd, cx?: number, cz?: number, radius?: number) { this.field.draw(crowd, cx ?? 0, cz ?? 0, radius ?? 1e9); this.boats.draw(crowd, cx ?? 0, cz ?? 0, radius ?? 1e9); this.people.draw(crowd, cx, cz, radius); this.army.draw(crowd, { x: this.ox, z: this.oz }, cx, cz, radius); }
}

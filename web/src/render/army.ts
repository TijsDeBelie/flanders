import * as THREE from 'three';
import type { Terrain } from './terrain';
import { buildCatapult, buildRam, HAT, TOOL, type Crowd, type Draw } from './crowd';
import { smoothPath } from './field';
import { lunge, fallen, mix } from './fight';
import { moatLevelAt, standHeight, onWater, chase } from './wading';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const S = 10;
// where the archers stand on each tower tier: walkway height above the ground and radius of the ring they stand on (see the tower model)
const TOWER_TOP = [5.2, 4.6, 7.3, 9.1];
const TOWER_RING = [1.0, 1.35, 1.68, 2.02];
const KEEP_TOP = [6.4, 8.9, 11.5, 14.1];
const KEEP_RING = [1.9, 2.8, 3.3, 3.7];
const CIV = [0x8c3b2f, 0x3b5f8c, 0x5f7a3b, 0x8c7a3b, 0x6b4a7a, 0x7a5a3b];

interface Field {
  x: number; z: number; tx: number; tz: number; yaw: number; side: number; kind: number; alive: boolean; anim: number; hp: number; max: number;
  moving: boolean; seed: number; elev: number; telev: number; fireT: number; lastCore: number;   // height it stands at (on a wall) and where that is heading
  sx: number; sz: number; segT: number; segD: number; lastSync: number;   // glide from where it was drawn to where the core put it, over the time one tick takes
  gait: number; spd: number;   // gait angle (advances with distance walked) and smoothed ground speed
  gy: number; wade: boolean; wet: boolean;   // drawn height of the ground (or water) under its feet, chasing where that should be; wading (as the core says); out over the water on a raft
  flash: number; deadAt: number;   // seconds of hit flash left; when (army clock) the soldier fell, or -1 while standing
}
interface Post { kind: number; x: number; z: number; y: number; yaw: number; row: number; mode: 'drill' | 'tower' | 'patrol'; ring?: number; idx?: number; n?: number; R?: number;
  /** An archer on a tower walkway paces back and forth along an arc of the ring: centre, radius, middle angle, how far it strays, how fast, and when in the cycle it starts. */
  tw?: { cx: number; cz: number; R: number; a0: number; amp: number; w: number; ph: number; dist?: number; last?: number } }

interface Guard { idx: number; wps: { x: number; z: number }[]; wi: number; route: number[]; ri: number; x: number; z: number; yaw: number; wait: number; gait: number; spd: number }

/** A guard on a wall walk: climbs the stair, walks the top of the wall to its far end and back, and comes down again. */
interface WallGuard { pts: [number, number, number][]; i: number; dir: 1 | -1; x: number; z: number; y: number; yaw: number; wait: number; gait: number; spd: number; id: number }

/** Soldiers: the standing army drilling at the barracks, guards on patrol and in the towers, and the live battle. */
export class ArmyView {
  private field: Field[] = [];
  private posts: Post[] = [];
  private corpses: { f: Field; t: number }[] = [];
  /** Called when a soldier is struck (x, z, height above ground, killed?), so the scene can throw up a puff of dust and blood. */
  onHit: ((x: number, z: number, y: number, killed: boolean) => void) | null = null;
  private siege: THREE.Group[] = [];
  private rams: THREE.Group[] = [];
  group = new THREE.Group();
  /** Rafts for raiders crossing a moat or river (the core marks them as wading: slow, helpless, easy to hit): a few logs lashed together, one per soldier, drawn at the water's edge. */
  private rafts: THREE.Mesh[] = [];
  private raftGeo: THREE.BufferGeometry | null = null;
  private raftMat = new THREE.MeshStandardMaterial({ color: 0x8a6a46, roughness: 0.95 });
  private raftAt(i: number) {
    if (!this.raftGeo) {
      const parts: THREE.BufferGeometry[] = [];
      for (let k = -2; k <= 2; k++) { const g = new THREE.CylinderGeometry(0.17, 0.17, 1.7, 7); g.rotateX(Math.PI / 2); g.translate(k * 0.3, 0, 0); parts.push(g); }   // logs along z
      for (const z of [-0.55, 0.55]) { const g = new THREE.BoxGeometry(1.5, 0.1, 0.16); g.translate(0, 0.17, z); parts.push(g); }                                      // lashed cross-pieces
      this.raftGeo = mergeGeometries(parts)!;
    }
    let r = this.rafts[i];
    if (!r) { r = new THREE.Mesh(this.raftGeo, this.raftMat); r.castShadow = r.receiveShadow = true; this.rafts.push(r); this.group.add(r); }
    return r;
  }
  private t = 0;
  battle = false;
  friend = 0x2f5fa8;       // colour of this village's soldiers
  foe = 0x4a3a2a;          // colour of the attackers (bandits brown, players red)
  private sig = '';
  private shown = new Set<THREE.Group>();
  private quiet = 0;
  private guards: Guard[] = [];
  private wallGuards: WallGuard[] = [];
  private wallSig = '';
  private towers: { x: number; z: number; tier: number; keep?: boolean }[] = [];
  private legs = new Map<string, number[]>();
  /** Route finder from the village's pathfinding: [ax, az, bx, bz] -> [x, z, mode, ...] or null when there is no plain walking route. */
  plan: (ax: number, az: number, bx: number, bz: number) => number[] | null = () => null;
  radii: number[] = [];

  constructor(private terrain: Terrain) {}

  /** Standing army and guards, from the village state. */
  syncPeace(buildings: Float32Array, army: number[], guards: number, garrison: number[]) {
    const sig = [...army, guards, buildings.length, ...garrison].join(',');
    const barr: number[] = []; const towers: number[] = [];
    for (let i = 0; i < buildings.length; i += S) { if (buildings[i] === 19) barr.push(i); if (buildings[i] === 3 || buildings[i] === 26) towers.push(i); }
    const sig2 = sig + '|' + barr.concat(towers).join('.') + '|' + buildings[1] + '|' + towers.map(i => buildings[i + 1]).join('.');   // the hall and tower tiers change patrols and where archers stand
    if (sig2 === this.sig) return; this.sig = sig2;
    const posts: Post[] = [];
    const hall = { x: buildings[2], z: buildings[3] };
    // the standing army drills in front of the barracks (or beside the hall)
    let yx = hall.x + 11, yz = hall.z + 11, yaw = 0;
    if (barr.length) { const i = barr[0], rot = buildings[i + 4] * Math.PI / 4; yaw = rot; yx = buildings[i + 2] + Math.sin(rot) * 8; yz = buildings[i + 3] + Math.cos(rot) * 8; }
    let k = 0;
    // idle soldiers are shown as a representative squad: one figure stands for a few men, so a big army costs little to draw
    for (let kind = 0; kind < 5; kind++) for (let j = 0, shown = army[kind] <= 3 ? army[kind] : Math.min(10, Math.ceil(army[kind] / 4)); j < shown; j++, k++) {
      const row = Math.floor(k / 8), col = (k % 8) - 3.5;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      posts.push({ kind, x: yx + col * 1.6 * c + row * 1.7 * s, z: yz - col * 1.6 * s + row * 1.7 * c, y: 0, yaw, row, mode: 'drill' });
    }
    // tower archers
    this.towers = [];
    for (const i of towers) {
      const tier = buildings[i + 1], n = garrison[i / S] ?? 0, tx = buildings[i + 2], tz = buildings[i + 3], keep = buildings[i] === 26, ring = keep ? KEEP_RING : TOWER_RING, top = keep ? KEEP_TOP : TOWER_TOP;
      this.towers.push({ x: tx, z: tz, tier, keep });
      for (let j = 0; j < n; j++) { const a = (j / n) * Math.PI * 2 + 0.4; posts.push({ kind: 1, x: tx + Math.cos(a) * ring[tier], z: tz + Math.sin(a) * ring[tier], y: top[tier], yaw: Math.PI / 2 - a, row: 0, mode: 'tower', tw: { cx: tx, cz: tz, R: ring[tier], a0: a, amp: n > 1 ? Math.min(0.9, (Math.PI / n) * 0.7) : 1.4, w: 0.22 + 0.05 * ((j * 7) % 3), ph: j * 2.3 + tx * 0.1 } }); }
    }
    this.posts = posts;
    // the guard patrols a loop through the village: the outermost building in each direction, found with the village's pathfinding
    const hallTier = buildings[1], n = 2 * (hallTier + 1), nSec = 6, best: ({ d: number; x: number; z: number; k: number } | null)[] = Array(nSec).fill(null);
    // guards stay inside the walls: in a sector with a curtain wall, only buildings nearer the hall than the wall count (and walls, gates, fences and moats never do)
    const wallR: number[] = Array(nSec).fill(Infinity);
    for (let i = S; i < buildings.length; i += S) if (buildings[i] === 2 || buildings[i] === 22) { const a = Math.atan2(buildings[i + 3] - hall.z, buildings[i + 2] - hall.x), sec = ((Math.floor((a + Math.PI) / (Math.PI * 2) * nSec)) % nSec + nSec) % nSec; wallR[sec] = Math.min(wallR[sec], Math.hypot(buildings[i + 2] - hall.x, buildings[i + 3] - hall.z)); }
    for (let i = S; i < buildings.length; i += S) {
      const kind = buildings[i], x = buildings[i + 2], z = buildings[i + 3]; if (kind === 2 || kind === 21 || kind === 22 || kind === 23 || kind === 24 || kind === 32 || kind === 33 || kind === 34) continue;
      const a = Math.atan2(z - hall.z, x - hall.x), sec = ((Math.floor((a + Math.PI) / (Math.PI * 2) * nSec)) % nSec + nSec) % nSec, d = Math.hypot(x - hall.x, z - hall.z);
      if (d > wallR[sec] - 2.5) continue;
      if (d > 7 && (!best[sec] || d > best[sec]!.d)) best[sec] = { d, x, z, k: kind };
    }
    let pts = best.filter(Boolean).map(b => { const dx = hall.x - b!.x, dz = hall.z - b!.z, dl = Math.hypot(dx, dz) || 1, off = (this.radii[b!.k] ?? 3) + 2; return { x: b!.x + dx / dl * off, z: b!.z + dz / dl * off }; });
    const R = 9 + hallTier; if (pts.length < 2) pts = [0, 1, 2, 3].map(q => ({ x: hall.x + Math.cos(q * 1.57) * R, z: hall.z + Math.sin(q * 1.57) * R }));
    this.legs.clear();
    const old = this.guards; this.guards = [];
    for (let g = 0; g < n; g++) {
      const wps = pts.map((_, i) => pts[(i + g) % pts.length]); if (g % 2) wps.reverse();
      const prev = old[g], start = wps[0];
      this.guards.push({ idx: g, wps, wi: 0, route: [], ri: 0, x: prev ? prev.x : start.x + Math.sin(g) * 2, z: prev ? prev.z : start.z + Math.cos(g) * 2, yaw: prev ? prev.yaw : 0, wait: g * 1.3, gait: prev ? prev.gait : g, spd: 0 });
    }
  }

  /** Guards for the wall walks (see Walls.walks): two on each stretch of wall that has a stair, one walking each way. */
  syncWalls(walks: { stair: [number, number, number][]; walk: [number, number, number][] }[]) {
    const sig = walks.map(w => w.walk.length + ':' + w.stair[0].map(v => v.toFixed(1)).join(',') + ':' + w.walk[0]?.map(v => v.toFixed(1)).join(',')).join('|');
    if (sig === this.wallSig) return; this.wallSig = sig;
    const old = this.wallGuards; this.wallGuards = [];
    walks.forEach((w, k) => {
      const pts = [...w.stair, ...w.walk];
      for (let g = 0; g < (w.walk.length > 3 ? 2 : 1); g++) {
        const id = k * 2 + g, prev = old[id], i0 = g === 0 ? 0 : Math.floor(pts.length / 2), p0 = pts[i0];
        this.wallGuards.push({ pts, i: prev && prev.pts.length === pts.length ? prev.i : i0, dir: prev && prev.pts.length === pts.length ? prev.dir : (g === 0 ? 1 : -1), x: prev ? prev.x : p0[0], z: prev ? prev.z : p0[1], y: prev ? prev.y : p0[2], yaw: prev?.yaw ?? 0, wait: g * 3, gait: prev?.gait ?? id, spd: 0, id });
      }
    });
  }

  private patrolWalls(dt: number) {
    for (const g of this.wallGuards) {
      if (g.wait > 0) { g.wait -= dt; g.spd *= 0.8; continue; }
      const tgt = g.pts[Math.max(0, Math.min(g.pts.length - 1, g.i))], dx = tgt[0] - g.x, dz = tgt[1] - g.z, dy = tgt[2] - g.y, dist = Math.hypot(dx, dz), step = Math.min(dist, 1.5 * dt);
      if (dist < 0.12) {
        if (g.i + g.dir < 0 || g.i + g.dir >= g.pts.length) { g.dir = (g.dir === 1 ? -1 : 1); g.wait = 4 + (g.id * 1.3) % 3; } else g.i += g.dir;
        continue;
      }
      g.x += dx / dist * step; g.z += dz / dist * step; g.y += dy * Math.min(1, step / Math.max(dist, 0.001));
      let d = Math.atan2(dx, dz) - g.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; g.yaw += d * Math.min(1, dt * 6);
      g.spd += (step / Math.max(dt, 0.001) - g.spd) * Math.min(1, dt * 5); g.gait += Math.PI * step / (0.55 + 0.13 * g.spd);
    }
  }

  /** Live positions from a running battle (call whenever the world ticks). */
  syncBattle(flat: Float32Array) {
    const n = flat.length / 10;
    if (n === 0) {
      if (this.battle) { // battle over: the dead stay on the field for a while
        for (const f of this.field) if (!f.alive && f.hp <= 0) this.corpses.push({ f, t: f.deadAt >= 0 ? f.deadAt : this.t });
        this.field = [];
      }
      this.battle = false; return;
    }
    if (!this.battle) this.quiet = 2;   // a battle just appeared (or we just loaded): whatever was mid-swing in the core is not shown as a fresh attack
    this.battle = true;
    while (this.field.length < n) { const i = this.field.length; this.field.push({ x: flat[i * 10 + 2], z: flat[i * 10 + 3], elev: 0, telev: 0, fireT: 0, lastCore: 0, tx: 0, tz: 0, yaw: 0, side: 0, kind: 0, alive: true, anim: 0, hp: 1, max: 1, moving: false, gy: NaN, wade: false, wet: false, seed: i * 2.3, gait: i * 1.7, spd: 0, flash: 0, deadAt: -1, sx: flat[i * 10 + 2], sz: flat[i * 10 + 3], segT: 1, segD: 1, lastSync: this.t }); }
    for (let i = 0; i < n; i++) {
      const f = this.field[i], o = i * 10;
      f.side = flat[o]; f.kind = flat[o + 1];
      f.wade = f.side === 1 && flat[o + 9] > 0.02;   // (only attackers wade; the core's number for them is water depth, not a wall height: see update)
      f.telev = f.wade ? 0 : flat[o + 9];
      if (Math.hypot(flat[o + 2] - f.tx, flat[o + 3] - f.tz) > 1e-3) { f.sx = f.x; f.sz = f.z; f.segT = 0; f.segD = f.segD * 0.6 + Math.max(0.05, Math.min(3, this.t - f.lastSync)) * 0.4; f.lastSync = this.t; }
      const prevHp = f.hp, wasAlive = f.alive;
      f.tx = flat[o + 2]; f.tz = flat[o + 3]; f.hp = flat[o + 4]; f.max = flat[o + 5]; f.alive = flat[o + 6] > 0;
      if (this.quiet === 0 && f.kind !== 4) {
        const died = wasAlive && !f.alive && f.hp <= 0;
        if (died) f.deadAt = this.t;
        if (died || (f.alive && f.hp < prevHp - 0.01)) { f.flash = 0.3; this.onHit?.(f.tx, f.tz, this.terrain.walkAt(f.tx, f.tz) + 1.1 + Math.max(f.telev, f.wade ? moatLevelAt(this.moats, f.tx, f.tz) - this.terrain.walkAt(f.tx, f.tz) + 0.12 : 0), died); }
      } else if (!f.alive && f.hp <= 0 && f.deadAt < 0) f.deadAt = this.t - 5;   // already down when we first saw it
      if (this.quiet > 0) { f.anim = 0; f.fireT = 0; }
      else { f.anim = Math.max(f.anim, flat[o + 7]); if (f.kind === 4 && flat[o + 7] >= 0.3 && f.lastCore < 0.3) f.fireT = 1.0; }   // a catapult only swings its arm when it really has just fired
      f.lastCore = flat[o + 7]; f.yaw = Math.PI / 2 - flat[o + 8];
    }
    if (this.quiet > 0) this.quiet--;
  }

  private siegeWood = new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.9 });
  private ladderObjs: THREE.Group[] = []; private bridgeObjs: THREE.Group[] = [];
  /** Ladders against walls and bridges over moats that the attackers have built, from World.battle_ladders_flat / battle_bridges_flat. */
  syncSiegeWorks(ladders: Float32Array, bridges: Float32Array) {
    const wood = this.siegeWood;
    const mkLadder = () => {
      const g = new THREE.Group(), H = 3.8, L = Math.hypot(H, 0.9), tilt = -Math.atan2(0.9, H);
      for (const s of [-0.3, 0.3]) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.08, L, 0.08), wood); r.position.set(s, H / 2, -0.45); r.rotation.x = tilt; r.castShadow = true; g.add(r); }
      for (let k = 1; k < 9; k++) { const t = k / 9, q = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.06, 0.06), wood); q.position.set(0, H * t, -0.9 * t); g.add(q); }
      return g;
    };
    const mkBridge = () => { const g = new THREE.Group(); for (let k = 0; k < 11; k++) { const p = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.14, 0.42), wood); p.position.set(0, 0.0, -2.5 + k * 0.5); p.castShadow = true; g.add(p); } return g; };
    const nl = ladders.length / 4, nb = bridges.length / 4;
    while (this.ladderObjs.length < nl) { const g = mkLadder(); this.group.add(g); this.ladderObjs.push(g); }
    while (this.bridgeObjs.length < nb) { const g = mkBridge(); this.group.add(g); this.bridgeObjs.push(g); }
    this.ladderObjs.forEach((g, i) => { g.visible = i < nl; if (i < nl) { const x = ladders[i * 4], z = ladders[i * 4 + 1], a = ladders[i * 4 + 2]; g.position.set(x, this.terrain.walkAt(x, z), z); g.rotation.y = Math.PI / 2 - a; } });
    this.bridgeObjs.forEach((g, i) => { g.visible = i < nb; if (i < nb) { const x = bridges[i * 4], z = bridges[i * 4 + 1], a = bridges[i * 4 + 2], done = bridges[i * 4 + 3]; g.position.set(x, 0.2, z); g.rotation.y = Math.PI / 2 - a; g.children.forEach((c, k) => { c.visible = done >= 1 || k / 11 <= done; }); } });
  }

  positions() { return this.field.filter(f => f.alive).map(f => ({ x: f.x, z: f.z })); }

  /** The pathfound route for one leg of a patrol, with its corners rounded. */
  private leg(ax: number, az: number, bx: number, bz: number): number[] {
    const key = `${Math.round(ax / 3)},${Math.round(az / 3)}>${Math.round(bx / 3)},${Math.round(bz / 3)}`, hit = this.legs.get(key); if (hit) return hit;
    const p = this.plan(ax, az, bx, bz);
    if (!(p && p.length >= 6 && p.every((v, i) => i % 3 !== 2 || v === 0))) { this.legs.set(key, []); return []; }   // no way on foot (a moat in between): the guard does not wade, it stays on its side
    const route = smoothPath(p);
    const out: number[] = []; for (let i = 3; i < route.length; i += 3) out.push(route[i], route[i + 1]);   // the first point is where the guard already stands
    this.legs.set(key, out); return out;
  }

  private patrol(dt: number) {
    for (const g of this.guards) {
      if (g.wait > 0) { g.wait -= dt; g.spd *= 0.8; continue; }
      if (g.ri * 2 >= g.route.length) { const B = g.wps[(g.wi + 1) % g.wps.length]; g.route = this.leg(g.x, g.z, B.x, B.z); g.ri = 0; g.wi = (g.wi + 1) % g.wps.length; if (!g.route.length) { g.wait = 3; continue; } }
      const tx = g.route[g.ri * 2], tz = g.route[g.ri * 2 + 1], dx = tx - g.x, dz = tz - g.z, dist = Math.hypot(dx, dz), step = Math.min(dist, 1.7 * dt);
      if (dist < 0.15) { g.ri++; if (g.ri * 2 >= g.route.length) g.wait = 2 + (g.idx * 0.7) % 3; continue; }
      g.x += dx / dist * step; g.z += dz / dist * step;
      let dy = Math.atan2(dx, dz) - g.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI; g.yaw += dy * Math.min(1, dt * 6);
      g.spd += (step / Math.max(dt, 0.001) - g.spd) * Math.min(1, dt * 5); g.gait += Math.PI * step / (0.55 + 0.13 * g.spd);
    }
  }

  update(dt: number) {
    this.t += dt;
    if (!this.battle) { this.patrol(Math.min(dt, 0.2)); this.patrolWalls(Math.min(dt, 0.2)); }
    const lp = 1 - Math.exp(-dt * 12);
    for (const f of this.field) {
      f.segT += dt; const k = Math.min(1.25, f.segT / Math.max(0.05, f.segD));
      const gx = f.sx + (f.tx - f.sx) * k, gz = f.sz + (f.tz - f.sz) * k;
      const dx = f.tx - f.x, dz = f.tz - f.z; f.moving = (Math.hypot(dx, dz) > 0.12 || k < 1) && f.alive;
      const mx = (gx - f.x) * lp, mz = (gz - f.z) * lp, moved = Math.hypot(mx, mz);
      f.x += mx; f.z += mz; f.anim = Math.max(0, f.anim - dt); f.elev += (f.telev - f.elev) * Math.min(1, dt * 5); this.settle(f, dt); f.fireT = Math.max(0, f.fireT - dt); f.flash = Math.max(0, f.flash - dt);
      f.spd += ((moved / Math.max(dt, 0.001)) - f.spd) * Math.min(1, dt * 5);          // smoothed ground speed, so strides match how fast they really move
      f.gait += Math.PI * moved / (0.55 + 0.13 * f.spd);                               // one step per stride length: no sliding feet
    }
    this.corpses = this.corpses.filter(c => this.t - c.t < 40);
  }

  private height(f: Field) { return Number.isNaN(f.gy) ? this.terrain.walkAt(f.x, f.z) : f.gy; }

  /** The moat water levels, World.moat_water_flat(): wading raiders stand on that surface. */
  moats: Float32Array = new Float32Array(0);

  /** Work out the height of the ground (or water) under a soldier and move the drawn height toward it at a limited speed. */
  private settle(f: Field, dt: number) {
    const ground = this.terrain.walkAt(f.x, f.z), level = f.side === 1 ? moatLevelAt(this.moats, f.x, f.z) : 0, want = standHeight(ground, f.wade, level);
    f.gy = Number.isNaN(f.gy) ? want : chase(f.gy, want, dt);
    f.wet = onWater(ground, f.wade, level);
  }

  private look(side: number, kind: number, seed: number, mine: boolean): Partial<Draw> {
    const col = side === 1 ? this.foe : this.friend, bandit = side === 1 && this.foe === 0x4a3a2a;
    switch (kind) {
      case 0: return { body: col, hat: bandit ? HAT.BANDIT : HAT.KETTLE, tool: TOOL.SPEAR, shield: 0, shieldCol: bandit ? 0x5a4a3a : col, legs: 0x3a3a3a };
      case 1: return { body: bandit ? 0x3a3a2a : mix(0x3f5a30, col, 0.6), hat: bandit ? HAT.BANDIT : HAT.HOOD, tool: TOOL.BOW, legs: 0x3a3228 };
      case 2: return { body: mix(0x8a9098, col, 0.5), hat: bandit ? HAT.BANDIT : HAT.HELM, tool: bandit ? TOOL.AXE : TOOL.SWORD, shield: 1, shieldCol: bandit ? 0x4a3a2a : col, legs: 0x4a4a52, armor: true };
      case 3: return { body: mix(0xb8bec6, col, 0.5), hat: bandit ? HAT.BANDIT : HAT.GREAT, tool: TOOL.SWORD, shield: 1, shieldCol: col, mounted: true, legs: 0x5a5a62, armor: true };
      default: { void mine; return { body: CIV[Math.floor(Math.abs(Math.sin(seed)) * CIV.length)], hat: seed % 2 > 1 ? HAT.CAP : HAT.STRAW, tool: TOOL.FORK, legs: 0x4a3a2a }; }
    }
  }

  /** A soldier who has been killed: topples over, then lies where it fell. */
  private drawFallen(crowd: Crowd, f: Field) {
    if (f.kind === 4 || f.kind === 5) return;
    const l = this.look(f.side, f.kind, f.seed, false), since = f.deadAt >= 0 ? this.t - f.deadAt : 99;
    crowd.add({ x: f.x, y: this.height(f) + f.elev * (1 - fallen(since)), z: f.z, yaw: f.yaw, pose: 4, fall: fallen(since), phase: 0, skin: 0xd9a877, ...l, mounted: false, tool: undefined, shield: undefined } as Draw);
  }

  /** How high above the ground an archer shoots from at (x, z): up on the walkway if it stands in a tower. */
  shooterHeight(x: number, z: number): number {
    const tw = this.towers.find(q => (q.x - x) ** 2 + (q.z - z) ** 2 < 2.6 * 2.6);
    return tw ? (tw.keep ? KEEP_TOP : TOWER_TOP)[tw.tier] + 1.4 : 1.5;
  }

  /** Queue every soldier visible right now. */
  draw(crowd: Crowd, hallPos: { x: number; z: number }, cx = 0, cz = 0, radius = 1e9) {
    const t = this.t, r2 = radius * radius, near = (x: number, z: number) => (x - cx) ** 2 + (z - cz) ** 2 <= r2;
    const sg = new Set<THREE.Group>();
    const placeSiege = (x: number, z: number, yaw: number, fire: number, i: number) => {
      let g = this.siege[i]; if (!g) { g = buildCatapult(); g.visible = true; this.siege[i] = g; this.group.add(g); }
      g.position.set(x, this.terrain.walkAt(x, z), z); g.rotation.y = yaw; g.visible = true; sg.add(g);
      // fire = seconds of the throwing motion left (1 -> 0): a quick swing forward, then the arm is winched back
      const p = 1 - fire; (g.userData.arm as THREE.Object3D).rotation.x = fire <= 0 ? -0.9 : p < 0.25 ? -0.9 + (p / 0.25) * 2.1 : 1.2 - ((p - 0.25) / 0.75) * 2.1;
    };
    let ri = 0;
    const placeRam = (x: number, z: number, yaw: number, swing: number) => {
      let g = this.rams[ri]; if (!g) { g = buildRam(); this.rams[ri] = g; this.group.add(g); } ri++;
      g.position.set(x, this.terrain.walkAt(x, z), z); g.rotation.y = yaw; g.visible = true; sg.add(g);
      (g.userData.log as THREE.Object3D).position.z = swing > 0 ? Math.sin((1 - swing) * Math.PI) * 0.9 : 0;   // the log swings forward as it strikes
    };
    let si = 0, nr = 0; for (const r of this.rafts) r.visible = false;
    if (this.battle) {
      for (const f of this.field) {
        if (!f.alive && f.hp > 0) continue;   // ran off the field
        if (!near(f.x, f.z)) continue;
        if (!f.alive) { if (f.kind !== 4 && f.kind !== 5) this.drawFallen(crowd, f); continue; }
        if (f.wet && f.kind !== 4) { const r = this.raftAt(nr++); r.visible = true; r.position.set(f.x, this.height(f) - 0.28 + Math.sin(t * 3.1 + f.seed) * 0.07, f.z); r.rotation.y = f.yaw + Math.PI / 2 + Math.sin(t * 2 + f.seed) * 0.12; r.rotation.z = Math.sin(t * 2.3 + f.seed * 2) * 0.14; r.rotation.x = Math.sin(t * 1.7 + f.seed * 3) * 0.08; }   // (a raft wallows: the raiders on it are helpless, see the core's WADE_* numbers)
        if (f.kind === 5) { placeRam(f.x, f.z, f.yaw, Math.min(1, f.anim / 0.5)); continue; }
        if (f.kind === 4) { placeSiege(f.x, f.z, f.yaw, f.fireT, si++); continue; }
        const l = this.look(f.side, f.kind, f.seed, false);
        if (f.side === 1 && f.elev > 0.3 && l.body !== undefined) l.body = mix(l.body, 0x4a6a84, 0.4);   // soaked and struggling in the water: a cold, grey-blue tint
        if (f.flash > 0 && l.body !== undefined) l.body = mix(l.body, 0xff3a2a, Math.min(0.75, f.flash / 0.3 * 0.75));
        if (f.side === 0 && f.kind === 1) {   // archers stationed in a tower shoot from its walkway
          const tw = this.towers.find(q => (q.x - f.x) ** 2 + (q.z - f.z) ** 2 < 2.6 * 2.6);
          if (tw) { const a = Math.atan2(f.z - tw.z, f.x - tw.x), R = (tw.keep ? KEEP_RING : TOWER_RING)[tw.tier], x = tw.x + Math.cos(a) * R, z = tw.z + Math.sin(a) * R; crowd.add({ x, y: this.terrain.walkAt(tw.x, tw.z) + (tw.keep ? KEEP_TOP : TOWER_TOP)[tw.tier], z, yaw: f.anim > 0 ? f.yaw : Math.PI / 2 - a, pose: 3, phase: t + f.seed, swing: f.anim > 0 ? Math.min(1, f.anim / 0.4) : 0, skin: 0xd9a877, ...l } as Draw); continue; }
        }
        const lg = f.kind !== 1 && f.kind !== 4 ? lunge(f.anim) : 0;   // a melee soldier steps into the blow
        crowd.add({ x: f.x + Math.sin(f.yaw) * lg, y: this.height(f) + f.elev, z: f.z + Math.cos(f.yaw) * lg, yaw: f.yaw, pose: f.anim > 0 ? 3 : f.moving ? 1 : 3, phase: f.anim > 0 || !f.moving ? t + f.seed : f.gait, speed: f.moving ? f.spd : 0, swing: f.anim > 0 ? Math.min(1, f.anim / 0.4) : 0, skin: 0xd9a877, scale: 0.92, ...l } as Draw);
      }
      for (const c of this.corpses) if (near(c.f.x, c.f.z)) this.drawFallen(crowd, c.f);
    } else {
      for (const c of this.corpses) { const f = c.f; if (f.kind === 4 || f.kind === 5) continue; const l = this.look(f.side, f.kind, f.seed, false); crowd.add({ x: f.x, y: this.terrain.walkAt(f.x, f.z), z: f.z, yaw: f.yaw, pose: 4, phase: 0, skin: 0xd9a877, ...l, mounted: false, tool: undefined, shield: undefined } as Draw); }
      for (const p of this.posts) {
        if (p.mode !== 'patrol' && !near(p.x, p.z)) continue;
        const l = this.look(0, p.kind, p.x * 3.1 + p.z, true);
        if (p.kind === 4) { placeSiege(p.x, p.z, p.yaw, 0, si++); continue; }
        if (p.mode === 'drill') {
          const drilling = Math.sin(t * 0.35 + p.row * 0.9) > 0.88;
          crowd.add({ x: p.x, y: this.terrain.walkAt(p.x, p.z), z: p.z, yaw: p.yaw, pose: drilling ? 3 : 0, phase: t + p.x, swing: drilling ? (Math.sin(t * 5 + p.x) > 0 ? 0.6 : 0) : 0, skin: 0xd9a877, ...l } as Draw);
        } else if (p.mode === 'tower') {
          const w = p.tw;
          if (!w) { crowd.add({ x: p.x, y: this.terrain.walkAt(p.x, p.z) + p.y, z: p.z, yaw: p.yaw, pose: 0, phase: t + p.x, skin: 0xd9a877, ...l } as Draw); continue; }
          // pace an arc of the walkway: walk while the swing is fast, stop and look out over the wall near the ends of it. A walkway too cramped for a real stroll (a small tower,
          // or many archers sharing it) does not pace at all: its archers turn slowly on the spot, because a walking animation on a body that hardly moves looks like shaking.
          const ph = t * w.w + w.ph, roomy = w.amp * w.R >= 0.7;
          const a = roomy ? w.a0 + Math.sin(ph) * w.amp : w.a0, v = Math.cos(ph), walking = roomy && Math.abs(v) > 0.3, sg = v >= 0 ? 1 : -1;
          const x = w.cx + Math.cos(a) * w.R, z = w.cz + Math.sin(a) * w.R;
          const out = Math.PI / 2 - a, yaw = walking ? Math.atan2(-sg * Math.sin(a), sg * Math.cos(a)) : out + (roomy ? 0 : Math.sin(ph * 0.6) * 0.8);
          // the gait follows the distance actually walked (so the feet never move faster than the body)
          if (walking) { w.dist = (w.dist ?? 0) + Math.abs(a - (w.last ?? a)) * w.R; } w.last = a;
          crowd.add({ x, y: this.terrain.walkAt(x, z) + p.y, z, yaw, pose: walking ? 1 : 0, phase: walking ? (w.dist ?? 0) * 4.5 : t + p.x, speed: walking ? Math.min(1.1, w.amp * w.w * Math.abs(v) * w.R) : 0, skin: 0xd9a877, ...l } as Draw);
        }
      }
      for (const g of this.wallGuards) {
        if (!near(g.x, g.z)) continue;
        const moving = g.spd > 0.3;
        crowd.add({ x: g.x, y: g.y, z: g.z, yaw: g.yaw, pose: moving ? 1 : 0, phase: moving ? g.gait : t + g.id, speed: g.spd, skin: 0xd9a877, ...this.look(0, 0, g.id + 3, true) } as Draw);
      }
      for (const g of this.guards) {
        if (!near(g.x, g.z)) continue;
        const moving = g.spd > 0.3;
        crowd.add({ x: g.x, y: this.terrain.walkAt(g.x, g.z), z: g.z, yaw: g.yaw, pose: moving ? 1 : 0, phase: moving ? g.gait : t + g.idx, speed: g.spd, skin: 0xd9a877, ...this.look(0, 0, g.idx, true) } as Draw);
      }
    }
    for (const g of this.shown) if (!sg.has(g)) g.visible = false;
    this.shown = sg;
  }
}

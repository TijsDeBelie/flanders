import * as THREE from 'three';
import type { Terrain } from './terrain';
import { HAT, TOOL, type Crowd, type Draw } from './crowd';
import { JK, parseJourneys, progress, TickClock, makeRoad, pointAt, headingAt, trim, fade, party, spanOf, describe, type Journey, type Road, type Unit } from './journey';
import { RES } from '../data';

/** What the renderer needs of a village: where it is and the three calls on its world. (A wasm `World` has all of them.) */
export interface TVillage {
  key: string; tag: number; name: string; mine: boolean; x: number; z: number; radius: number; color: number;
  world: { tick(): bigint; journeys_flat(): ArrayLike<number>; link_points(x: number, y: number): ArrayLike<number>; walk_route(sx: number, sy: number, gx: number, gy: number): ArrayLike<number> };
}
export interface Label { id: string; x: number; y: number; z: number; text: string; kind: number }

/** The colour of each resource's load on a cart (by resource number). */
const GOODS = [0x7a5230, 0xc9a56a, 0x9a9a9a, 0xb5693a, 0xa4553b, 0x6a5a50, 0x8a8a90, 0xb0902a, 0xe0b030, 0x2a2a2a, 0xd9b95a, 0x777777];
const HORSES = [0x6b4a32, 0x4a3626, 0x8a6a4a, 0x5a4030, 0xb09878, 0x3c2c22];
const SKINS = [0xe8c4a0, 0xd9a877, 0xc68e63, 0xf0d2b4, 0xb98055];
const WOOD = 0x7a5a3a, DARK = 0x3a2a1c, GOLD = 0xe0b030, WHITE = 0xf4f4ee, RED = 0xb01c1c, ROSE = 0xe28aa8;
const lighter = (hex: number, f: number) => { const c = new THREE.Color(hex); c.lerp(new THREE.Color(0xffffff), f); return c.getHex(); };

interface Live {
  id: string; j: Journey; from: TVillage; to: TVillage; road: Road; units: Unit[]; span: number; p: number; lastP: number; lastTick: number;
  color: number; color2: number; speed: number; text: string; head: { x: number; y: number; z: number } | null;
}
interface Ghost { road: Road; units: Unit[]; sHead: number; color: number; color2: number; t0: number; j: Journey; seed: number }
interface Frame { x: number; y: number; z: number; yaw: number }

/** Every errand on the road between two villages, drawn as the procession that fits it, walking the invisible path chained between the two cities (see World.link_points): goods in carts, a rider with a scroll, white flags,
 *  two banners and a guard, a herald with gifts, a wedding carriage, a lone rider with a red banner. All of it is read from the core's list, which every copy of a village holds, so everybody sees the same journeys at the same time. */
export class Travellers {
  group = new THREE.Group();
  private lives = new Map<string, Live>();
  private ghosts: Ghost[] = [];
  private clocks = new Map<string, TickClock>();
  private roads = new Map<string, Road>();
  private lists = new Map<string, { tick: number; list: Journey[] }>();
  private t = 0;
  private pools: Record<'box' | 'cyl' | 'ball' | 'cloth' | 'cone', { mesh: THREE.InstancedMesh; n: number }>;
  private e = new THREE.Euler(); private q = new THREE.Quaternion(); private q2 = new THREE.Quaternion(); private v = new THREE.Vector3(); private sc = new THREE.Vector3(); private m = new THREE.Matrix4(); private col = new THREE.Color(); private up = new THREE.Vector3(0, 1, 0);
  /** What the last `update` made of everything on the road, for the label over each procession (see `labels`). */
  private shown: Label[] = [];

  constructor(private terrain: Terrain) {
    const mk = (g: THREE.BufferGeometry, cap = 900) => {
      const mesh = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.03 }), cap);
      mesh.castShadow = true; mesh.frustumCulled = false; mesh.count = 0; this.group.add(mesh); return { mesh, n: 0 };
    };
    const cloth = new THREE.PlaneGeometry(1, 1); cloth.translate(0.5, 0, 0);
    this.pools = { box: mk(new THREE.BoxGeometry(1, 1, 1)), cyl: mk(new THREE.CylinderGeometry(0.5, 0.5, 1, 10)), ball: mk(new THREE.SphereGeometry(0.5, 8, 6)), cloth: mk(cloth, 300), cone: mk(new THREE.ConeGeometry(0.5, 1, 8), 300) };
    (this.pools.cloth.mesh.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    this.pools.cloth.mesh.castShadow = false;
  }

  // ---------- keeping track of what is on the road ----------
  /** Read the lists of the villages in view and move every procession on. `now` is the real time in seconds. */
  update(dt: number, now: number, villages: TVillage[]) {
    this.t = now;
    const byTag = new Map<number, TVillage>(); for (const v of villages) byTag.set(v.tag, v);
    const seen = new Set<string>(); const tickNow = new Map<string, number>();
    for (const v of villages) {
      const tick = Number(v.world.tick());
      let clock = this.clocks.get(v.key); if (!clock) { clock = new TickClock(); this.clocks.set(v.key, clock); }
      const td = clock.update(tick, now, dt);
      let ent = this.lists.get(v.key);
      if (!ent || ent.tick !== tick) { ent = { tick, list: parseJourneys(v.world.journeys_flat()) }; this.lists.set(v.key, ent); }
      tickNow.set(v.key, tick);
      for (const j of ent.list) {
        const to = byTag.get(j.to); if (!to || to === v) continue;
        const id = `${v.key}|${j.kind}|${j.to}|${j.start}|${j.arrive}|${j.a}|${j.b}`; seen.add(id);
        let L = this.lives.get(id);
        if (!L) {
          const units = party(j), res = j.kind === JK.CARAVAN ? RES[j.a]?.name.toLowerCase() : undefined;
          L = { id, j, from: v, to, road: this.roadFor(v, to), units, span: spanOf(units), p: 0, lastP: 0, lastTick: tick, color: v.color, color2: to.color, speed: 1, text: describe(j, v.mine ? 'you' : v.name, to.mine ? 'you' : to.name, res), head: null };
          this.lives.set(id, L);
        }
        L.j = j; L.from = v; L.to = to; L.lastTick = tick; L.p = progress(j, td); L.lastP = L.p; L.color = v.color; L.color2 = to.color;
        const dur = Math.max(1, j.arrive - j.start); L.speed = Math.max(0.8, Math.min(6.5, (L.road.len + L.span) / dur * clock.rate));
      }
    }
    for (const [id, L] of [...this.lives]) {
      if (seen.has(id)) continue;
      this.lives.delete(id);
      // a caravan that vanishes before it arrived was waylaid: leave the carts where they stood, with robbers round them (but not when the copy was only rebuilt)
      const tk = tickNow.get(L.from.key); const stepped = tk !== undefined && tk >= L.lastTick && tk - L.lastTick <= 5;
      if (L.j.kind === JK.CARAVAN && L.lastP < 0.97 && L.lastP > 0.02 && stepped) this.ghosts.push({ road: L.road, units: L.units, sHead: L.lastP * (L.road.len + L.span), color: L.color, color2: L.color2, t0: this.t, j: L.j, seed: this.ghosts.length });
    }
    this.ghosts = this.ghosts.filter(g => this.t - g.t0 < 14);
    if (this.lives.size === 0) { this.shown = []; }
    for (const id of [...this.roads.keys()]) if (this.roads.size > 64) this.roads.delete(id);
  }

  /** The invisible path from one city to the other, trimmed to start where it leaves the one city and end where it reaches the other's border. */
  private roadFor(a: TVillage, b: TVillage): Road {
    const key = `${a.key}>${b.key}`;
    let r = this.roads.get(key);
    if (r && r.len > 0) return r;
    let pts: number[] = Array.from(a.world.link_points(b.x, b.z));
    if (pts.length < 4) { const back = Array.from(b.world.link_points(a.x, a.z)); if (back.length >= 4) { pts = []; for (let k = back.length - 2; k >= 0; k -= 2) pts.push(back[k], back[k + 1]); } }
    if (pts.length < 4) { const w = Array.from(a.world.walk_route(a.x, a.z, b.x, b.z)); if (w.length >= 5 && w[0] === 1) pts = w.slice(1); }
    if (pts.length < 4) pts = [a.x, a.z, b.x, b.z];
    // the figures stand clear of the city when they set out and when they arrive: the path leaves each city at its border
    const len = makeRoad(pts).len;
    r = makeRoad(trim(pts, Math.min(a.radius, len * 0.3), Math.min(b.radius, len * 0.3)));
    this.roads.set(key, r); return r;
  }

  /** Floating labels for the processions in view: where, and what to say. */
  labels(): Label[] { return this.shown; }

  /** The processions on the road now: what they are, where their heads are and how far along (for the tooltip and tests). */
  active() { return [...this.lives.values()].map(L => ({ id: L.id, kind: L.j.kind, p: L.p, text: L.text, head: L.head })); }

  // ---------- drawing ----------
  draw(crowd: Crowd, cx: number, cz: number, view: number) {
    for (const p of Object.values(this.pools)) p.n = 0;
    const labels: Label[] = [];
    for (const L of this.lives.values()) {
      const sHead = L.p * (L.road.len + L.span);
      const hs = Math.min(L.road.len, Math.max(0, sHead)), hp = pointAt(L.road, hs);
      L.head = { x: hp.x, y: this.terrain.walkAt(hp.x, hp.z), z: hp.z };
      if (L.p <= 0 || L.p >= 1) continue;
      const near = Math.hypot(hp.x - cx, hp.z - cz) < view + L.span;
      if (!near) continue;
      this.party(crowd, L.road, L.units, sHead, L.color, L.color2, L.speed, false, L.j, L.id.length);
      labels.push({ id: L.id, x: hp.x, y: L.head.y + (L.j.kind === JK.MARRIAGE ? 5.5 : 4.8), z: hp.z, text: L.text, kind: L.j.kind });
    }
    for (const g of this.ghosts) {
      const age = this.t - g.t0, hp = pointAt(g.road, Math.min(g.road.len, g.sHead));
      if (Math.hypot(hp.x - cx, hp.z - cz) > view + 30) continue;
      this.party(crowd, g.road, g.units, g.sHead, g.color, g.color2, 0, true, g.j, g.seed, age);
      const y = this.terrain.walkAt(hp.x, hp.z);
      labels.push({ id: `robbed${g.seed}|${g.t0}`, x: hp.x, y: y + 4.5, z: hp.z, text: 'Caravan waylaid by robbers!', kind: 99 });
    }
    this.shown = labels;
    for (const p of Object.values(this.pools)) { p.mesh.count = p.n; p.mesh.instanceMatrix.needsUpdate = true; if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true; }
  }

  /** Put a primitive in a pool: centre at (lx, ly, lz) in the frame `f` (turned by its yaw), size (sx, sy, sz), optional further turn. Everything is scaled by `k` so a figure grows out of the ground and shrinks back into it. */
  private prim(pool: 'box' | 'cyl' | 'ball' | 'cloth' | 'cone', f: Frame, k: number, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, hex: number, rx = 0, ry = 0, rz = 0) {
    const p = this.pools[pool]; if (p.n >= 880 || k < 0.04) return;
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    this.v.set(f.x + (lx * c + lz * s) * k, f.y + ly * k, f.z + (-lx * s + lz * c) * k);
    this.e.set(rx, ry, rz, 'YXZ'); this.q2.setFromEuler(this.e); this.q.setFromAxisAngle(this.up, f.yaw).multiply(this.q2);
    this.sc.set(sx * k, sy * k, sz * k); this.m.compose(this.v, this.q, this.sc);
    p.mesh.setMatrixAt(p.n, this.m); p.mesh.setColorAt(p.n, this.col.setHex(hex)); p.n++;
  }
  private pole(f: Frame, k: number, lx: number, lz: number, h: number, hex = DARK) { this.prim('cyl', f, k, lx, h / 2, lz, 0.09, h, 0.09, hex); }
  /** A flag on a pole of height `h`, streaming back from the pole, fluttering. */
  private flag(f: Frame, k: number, lx: number, lz: number, h: number, w: number, ht: number, hex: number, seed: number, trimHex?: number) {
    this.pole(f, k, lx, lz, h); this.prim('ball', f, k, lx, h + 0.05, lz, 0.2, 0.2, 0.2, GOLD);
    const fl = Math.sin(this.t * 4.5 + seed) * 0.3;
    this.prim('cloth', f, k, lx, h - ht * 0.5 - 0.1, lz, w, ht, 1, hex, 0, Math.PI / 2 + fl, 0);
    if (trimHex !== undefined) this.prim('cloth', f, k, lx, h - ht * 0.5 - 0.1, lz + 0.01, w * 0.98, ht * 0.22, 1, trimHex, 0, Math.PI / 2 + fl, 0);
  }

  private wheel(f: Frame, k: number, lx: number, lz: number, r: number, hex: number) { this.prim('cyl', f, k, lx, r, lz, r * 2, 0.14, r * 2, hex, 0, 0, Math.PI / 2); }

  /** The two-wheeled cart the caravan is made of, with its load piled in the colour of what it carries, under a strip of the sender's colour. */
  private cart(f: Frame, k: number, load: number, color: number) {
    this.prim('box', f, k, 0, 0.7, 0, 1.5, 0.28, 2.5, WOOD);
    for (const sx of [-0.72, 0.72]) this.prim('box', f, k, sx, 0.98, 0, 0.1, 0.5, 2.5, 0x6a4a2a);
    this.prim('box', f, k, 0, 0.98, -1.2, 1.5, 0.5, 0.1, 0x6a4a2a);
    for (const sz of [-0.75, 0.75]) for (const sx of [-0.9, 0.9]) this.wheel(f, k, sx, sz, 0.5, DARK);
    this.prim('box', f, k, 0, 1.3, 0, 1.3, 0.62, 2.1, load); this.prim('box', f, k, 0, 1.78, 0.1, 1.0, 0.4, 1.6, lighter(load, 0.25));
    this.prim('box', f, k, 0, 1.64, 0.55, 1.36, 0.1, 0.5, color);
    for (const sx of [-0.4, 0.4]) this.prim('box', f, k, sx, 0.9, 2.3, 0.08, 0.08, 2.3, DARK);
  }

  private person(crowd: Crowd, f: Frame, k: number, s: number, speed: number, still: boolean, extra: Partial<Draw>, seed: number) {
    if (k < 0.05) return;
    const ph = still ? this.t + seed : Math.PI * s / (0.55 + 0.13 * speed);
    crowd.add({ x: f.x, y: f.y, z: f.z, yaw: f.yaw, pose: still ? 0 : 1, phase: ph, speed: still ? 0 : speed, skin: SKINS[Math.abs(seed) % SKINS.length], body: 0x8c7a3b, scale: k, ...extra } as Draw);
  }

  /** One procession: its figures at their places `back` units behind the head, each fading in and out at the ends of the road. */
  private party(crowd: Crowd, road: Road, units: Unit[], sHead: number, color: number, color2: number, speed: number, still: boolean, j: Journey, seed: number, age = 0) {
    const len = road.len;
    let idx = 0;
    for (const u of units) {
      idx++;
      const s = sHead - u.back, k = fade(s, len), sd = seed * 7 + idx * 3 + (u.n ?? 0);
      if (k < 0.05) continue;
      const at = (ds: number, side: number): Frame => {
        const p = pointAt(road, s + ds), yaw = headingAt(road, s + ds), c = Math.cos(yaw), sn = Math.sin(yaw);
        const x = p.x + side * c, z = p.z - side * sn; return { x, y: this.terrain.walkAt(x, z), z, yaw };
      };
      const f = at(0, u.side), ph = Math.PI * s / (0.55 + 0.13 * Math.max(speed, 0.8));
      const p = (extra: Partial<Draw>, fr = f, ss = s) => this.person(crowd, fr, k, ss, speed, still, extra, sd);
      const horse = (fr: Frame, hex: number, blanket?: number) => {
        crowd.addHorse(fr.x, fr.y, fr.z, fr.yaw, still ? 0 : ph, still ? 0 : speed, hex, k);
        if (blanket !== undefined) this.prim('box', fr, k, 0, 1.26, 0.05, 0.56, 0.08, 0.95, blanket);
      };
      switch (u.role) {
        case 'guard-rider': p({ mounted: true, body: color, hat: HAT.HELM, tool: TOOL.SPEAR, shield: 0, shieldCol: color, legs: 0x5a5a62, armor: true }); break;
        case 'drover': p({ mounted: true, body: 0x7a5a3a, hat: HAT.STRAW }); break;
        case 'walker-staff': p({ body: 0x6a5a3a, hat: HAT.HOOD, tool: TOOL.STAFF }); break;
        case 'cart': {
          const n = u.n ?? 0, goods = j.kind === JK.CARAVAN ? GOODS[j.a] ?? 0x9a7a4a : 0x9a7a4a;
          this.cart(f, k, goods, color);
          const hf = at(3.9, u.side);
          horse(hf, HORSES[n % HORSES.length], color);
          p({ body: 0x7a5a3a, hat: n % 2 ? HAT.STRAW : HAT.CAP, tool: TOOL.STAFF }, at(3.9, u.side + 1.5), s + 3.9);
          break;
        }
        case 'courier': {   // a rider with a sealed scroll in his hand and the sender's banner behind him
          p({ mounted: true, body: color, hat: HAT.CAP, legs: 0x3a3a40 });
          this.prim('cyl', f, k, 0.42, 1.78, 0.5, 0.12, 0.6, 0.12, 0xf0e6c8, Math.PI / 2 - 0.2, 0, 0); this.prim('ball', f, k, 0.42, 1.77, 0.8, 0.17, 0.17, 0.17, RED);
          this.flag(f, k, -0.3, -0.7, 4.6, 1.6, 1.0, color, sd, GOLD);
          break;
        }
        case 'attendant': {
          p({ body: color, hat: HAT.CAP, legs: 0x4a3a2a }); this.prim('box', f, k, 0, 1.1, 0.38, 0.52, 0.34, 0.36, 0x6a3a22); this.prim('box', f, k, 0, 1.13, 0.57, 0.1, 0.1, 0.04, GOLD); break;
        }
        case 'white-flag': {
          p({ body: WHITE, hat: HAT.COIF, legs: 0xd8d4c8, tool: undefined });
          this.flag(f, k, 0.4, 0.15, 3.7, 2.1, 1.35, WHITE, sd); break;
        }
        case 'olive': {
          p({ body: 0xe8e4d4, hat: HAT.COIF, legs: 0xd8d4c8 });
          this.prim('cyl', f, k, 0.45, 1.1, 0.4, 0.05, 1.1, 0.05, 0x6a4a2a, 0.6, 0, 0);
          for (let q = 0; q < 7; q++) { const a = q / 6; this.prim('ball', f, k, 0.45 + (q % 2 ? 0.14 : -0.14), 1.2 + a * 0.55, 0.32 + a * 0.5, 0.2, 0.1, 0.34, q % 2 ? 0x8aa84a : 0x5f8a34, 0.5, 0, 0.3); }
          break;
        }
        case 'white': p({ body: 0xe8e4d4, hat: HAT.COIF, legs: 0xd8d4c8 }); break;
        case 'standard': {
          const own = (u.flag ?? 0) === 0 ? color : color2;
          p({ body: own, hat: HAT.CAP, legs: 0x3a3a40 });
          this.flag(f, k, 0.38, 0.1, 4.4, 1.7, 1.15, own, sd + (u.flag ?? 0) * 2, GOLD); break;
        }
        case 'guard': {
          const own = (u.side ?? 0) < 0 ? color : color2;
          p({ body: 0xb8bec6, hat: HAT.HELM, tool: TOOL.SPEAR, shield: 0, shieldCol: own, legs: 0x5a5a62, armor: true }); break;
        }
        case 'herald': p({ body: color, hat: HAT.CAP, tool: TOOL.STAFF, legs: 0xe0d8c0 }); this.prim('cloth', f, k, 0.1, 1.9, 0.15, 0.5, 0.35, 1, GOLD, 0, Math.PI / 2 + Math.sin(this.t * 5 + sd) * 0.3); break;
        case 'gift-horse': {
          horse(f, 0xb09878, color);
          for (const sx of [-0.62, 0.62]) { this.prim('box', f, k, sx, 1.1, 0, 0.42, 0.52, 0.85, 0x7a4a2a); this.prim('box', f, k, sx, 1.1, 0, 0.44, 0.08, 0.87, GOLD); }
          this.prim('box', f, k, 0, 1.62, -0.1, 0.72, 0.46, 0.95, 0x9a3a2a); this.prim('box', f, k, 0, 1.62, 0.38, 0.12, 0.14, 0.04, GOLD); this.prim('box', f, k, 0, 1.86, -0.1, 0.74, 0.07, 0.97, GOLD);
          this.prim('ball', f, k, 0.15, 1.95, -0.45, 0.5, 0.4, 0.5, 0xd9c9a0); this.prim('ball', f, k, -0.18, 1.62, -0.7, 0.22, 0.22, 0.22, color); break;
        }
        case 'outrider': p({ mounted: true, body: (idx % 2) ? ROSE : 0xf0e0c0, hat: HAT.CAP, legs: 0x4a3a50 }); this.flag(f, k, 0.45, -0.2, 2.9, 0.9, 0.5, idx % 2 ? WHITE : ROSE, sd); break;
        case 'carriage': {
          this.prim('box', f, k, 0, 0.95, 0, 1.9, 0.5, 3.1, 0xf3e6e6); this.prim('box', f, k, 0, 0.7, 0, 2.0, 0.1, 3.2, GOLD);
          for (const sz of [-1.0, 1.0]) for (const sx of [-1.05, 1.05]) this.wheel(f, k, sx, sz, 0.62, GOLD);
          for (const sz of [-1.3, 1.3]) for (const sx of [-0.85, 0.85]) this.prim('cyl', f, k, sx, 2.0, sz, 0.1, 2.2, 0.1, GOLD);
          this.prim('box', f, k, 0, 3.15, 0, 2.1, 0.14, 3.4, 0xfaf4ee); this.prim('cone', f, k, 0, 3.55, 0, 1.2, 0.8, 1.2, ROSE); this.prim('ball', f, k, 0, 4.0, 0, 0.3, 0.3, 0.3, GOLD);
          for (let q = 0; q < 9; q++) { const a = q / 8, z = -1.5 + a * 3.0, sag = Math.sin(a * Math.PI) * 0.35; for (const sx of [-1.0, 1.0]) this.prim('ball', f, k, sx, 2.95 - sag, z, 0.26, 0.26, 0.26, q % 2 ? 0xe86a9a : 0x5a9a4a); }
          for (const [sx, sz] of [[-1.05, -1.5], [1.05, -1.5], [-1.05, 1.5], [1.05, 1.5]]) this.flag(f, k, sx, sz, 3.6, 0.9, 0.35, (sx > 0) === (sz > 0) ? ROSE : WHITE, sd + sx + sz);
          this.prim('box', f, k, 0, 1.35, -0.2, 0.9, 0.5, 0.8, ROSE);
          this.person(crowd, { ...f, y: f.y + 0.95 }, k, s, speed, true, { body: 0xfaf4ee, dress: true, hat: HAT.COIF, skin: 0xf0d2b4 }, sd);
          for (const sx of [-0.7, 0.7]) { const hf = at(4.4, u.side + sx); horse(hf, 0xe8e4dc, sx > 0 ? ROSE : WHITE); }
          for (const sx of [-0.5, 0.5]) this.prim('box', f, k, sx, 0.9, 2.6, 0.08, 0.08, 2.6, DARK);
          break;
        }
        default: {   // war: a lone rider at a gallop with a red banner and a horn, nobody with him
          p({ mounted: true, body: 0x8a1c1c, hat: HAT.GREAT, legs: 0x2a2a30, armor: true, shield: 0, shieldCol: RED });
          this.flag(f, k, 0.4, -0.7, 4.9, 2.1, 1.4, RED, sd, 0x1a1a1a);
          this.prim('cone', f, k, -0.4, 1.95, 0.55, 0.3, 0.9, 0.3, GOLD, 1.1, 0, 0.2); break;
        }
      }
      void age;
    }
    if (still) this.robbers(crowd, road, units, sHead, seed, age);
  }

  /** Robbers fall on a caravan that was waylaid: they stand round the carts, swinging, and then slip away into the scenery (shrinking with the fade). */
  private robbers(crowd: Crowd, road: Road, units: Unit[], sHead: number, seed: number, age: number) {
    const k = age > 11 ? Math.max(0.05, 1 - (age - 11) / 3) : 1;
    const cart = units.find(u => u.role === 'cart') ?? units[0]; const s = sHead - cart.back;
    for (let i = 0; i < 4; i++) {
      const side = (i % 2 ? 1 : -1) * 2.0, ds = i < 2 ? 3 : -2.5, ps = pointAt(road, s + ds), yaw = headingAt(road, s + ds);
      const x = ps.x + side * Math.cos(yaw), z = ps.z - side * Math.sin(yaw), y = this.terrain.walkAt(x, z);
      crowd.add({ x, y, z, yaw: yaw + (i % 2 ? -Math.PI / 2 : Math.PI / 2), pose: 3, phase: this.t * 3 + i + seed, swing: (Math.sin(this.t * 4 + i * 1.7) + 1) / 2 * 0.9, body: 0x3a3a3a, skin: SKINS[i % 5], hat: HAT.BANDIT, tool: i % 2 ? TOOL.SWORD : TOOL.FORK, legs: 0x2f2a26, scale: k } as Draw);
    }
  }
}

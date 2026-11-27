import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Terrain } from './terrain';

/**
 * The neutral places of the map as models: an abbey (kind 0), a ruined castle (1), a bandit camp (2), a lair (3) and the plague doctor's camp (4).
 * Every piece stands on the ground right under it. The pieces that never move are merged into one mesh per material when the place is built, so a camp of
 * a few hundred pieces is drawn in a dozen calls; only the flames, flags and tents (which slump when the place is cleared) stay meshes of their own.
 */
const rand = (s: number) => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

const std = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true, ...extra });
const M = {
  wood: std(0x5a4128), darkWood: std(0x33261a), stake: std(0x4a3523), stone: std(0x6f6a63), paleStone: std(0xb3aa96), roof: std(0x4d5460), bone: std(0xd8d0b8), ash: std(0x2a2623),
  iron: std(0x3c3d42, { metalness: 0.5, roughness: 0.6 }), gold: std(0xe0b030, { metalness: 0.8, roughness: 0.35, emissive: 0x5a3c00, emissiveIntensity: 0.6 }),
  sack: std(0xa89268), hide: std(0x7b5a3c, { side: THREE.DoubleSide }), meat: std(0x8a3b2a), dark: std(0x0c0a08), leaf: std(0x46602f), ivy: std(0x3f5a2c),
  cloth: [std(0x7a2f26, { side: THREE.DoubleSide }), std(0x6b5a3a, { side: THREE.DoubleSide }), std(0x4c5a3a, { side: THREE.DoubleSide }), std(0x5a4a40, { side: THREE.DoubleSide })],
  banner: std(0x9c2a22, { side: THREE.DoubleSide }), sick: std(0x4a6b34, { side: THREE.DoubleSide }), abbeyBanner: std(0xe8e0c8, { side: THREE.DoubleSide }),
  ground: std(0x5b4a35, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), sickGround: std(0x4a4a30, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  path: std(0x8a7a5c, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  fire: new THREE.MeshBasicMaterial({ color: 0xff8a1e }), sickFire: new THREE.MeshBasicMaterial({ color: 0x7dff4a }),
};

/** A ridge tent: a triangular prism along x, open at the front (+x), with a dark opening inset there. */
function ridgeTentGeo(L: number, W: number, H: number) {
  const x0 = -L / 2, x1 = L / 2, w = W / 2;
  const p = [
    // left slope, right slope (two triangles each)
    x0, 0, -w, x1, 0, -w, x1, H, 0, x0, 0, -w, x1, H, 0, x0, H, 0,
    x1, 0, w, x0, 0, w, x0, H, 0, x1, 0, w, x0, H, 0, x1, H, 0,
    // back wall
    x0, 0, w, x0, 0, -w, x0, H, 0,
    // front flaps: two narrow triangles either side of the doorway
    x1, 0, -w, x1, 0, -w * 0.35, x1, H, 0, x1, 0, w * 0.35, x1, 0, w, x1, H, 0,
  ];
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.computeVertexNormals(); return g;
}
const G = {
  tent: ridgeTentGeo(3.2, 2.6, 1.9), doorway: (() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.5, 0, 0, 0.5, 0, 1.35, 0], 3)); g.computeVertexNormals(); return g; })(),
  cone: new THREE.ConeGeometry(2.1, 2.6, 7), yurtWall: new THREE.CylinderGeometry(2.6, 2.7, 1.5, 9, 1, true), yurtRoof: new THREE.ConeGeometry(3.0, 1.9, 9),
  stake: mergeGeometries([new THREE.CylinderGeometry(0.2, 0.22, 2.6, 6).translate(0, 1.3, 0), new THREE.ConeGeometry(0.2, 0.55, 6).translate(0, 2.87, 0)]),
  pole: new THREE.CylinderGeometry(0.1, 0.13, 6, 6).translate(0, 3, 0), post: new THREE.CylinderGeometry(0.12, 0.14, 1, 6).translate(0, 0.5, 0),
  flag: new THREE.PlaneGeometry(2.2, 1.4).translate(1.1, 0, 0),
  rock: new THREE.DodecahedronGeometry(1, 0), flame: new THREE.ConeGeometry(0.45, 1.3, 6).translate(0, 0.65, 0),
  log: new THREE.CylinderGeometry(0.14, 0.14, 1.3, 5).rotateZ(Math.PI / 2), bench: new THREE.CylinderGeometry(0.22, 0.24, 2.2, 6).rotateZ(Math.PI / 2),
  skull: new THREE.SphereGeometry(0.4, 6, 5), box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), barrel: new THREE.CylinderGeometry(0.38, 0.38, 0.95, 8).translate(0, 0.475, 0),
  sack: new THREE.SphereGeometry(0.42, 6, 5).scale(1, 0.75, 0.85).translate(0, 0.3, 0), bar: new THREE.CylinderGeometry(0.05, 0.05, 1, 4).translate(0, 0.5, 0),
  tower: new THREE.CylinderGeometry(2.2, 2.5, 1, 10).translate(0, 0.5, 0), spire: new THREE.ConeGeometry(1.4, 3.2, 4).rotateY(Math.PI / 4).translate(0, 1.6, 0),
  gable: (() => { const s = new THREE.Shape([new THREE.Vector2(-1, 0), new THREE.Vector2(1, 0), new THREE.Vector2(0, 0.8)]); return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5); })(),
  bush: new THREE.IcosahedronGeometry(1, 0),
};

interface Place { g: THREE.Group; kind: number; x: number; z: number; done: boolean; flames: THREE.Object3D[]; tents: THREE.Object3D[]; flags: THREE.Object3D[]; loot: THREE.Object3D[]; seed: number; statics: THREE.Mesh[] }
type Opt = { y?: number; s?: number | [number, number, number]; ry?: number; rx?: number; rz?: number; shadow?: boolean; live?: boolean };

/** How far from its centre each kind of place reaches (for picking and the selection ring). */
export const PLACE_RADIUS = [11, 12, 12, 9, 9];

export class Camps {
  group = new THREE.Group();
  private places = new Map<string, Place>();
  constructor(private terrain: Terrain) {}

  /** A piece of the place, standing on the ground at (x, z) (relative to the place); `live` keeps it a mesh of its own (it moves or changes later). */
  private mesh(p: Place, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, z: number, o: Opt = {}) {
    const m = new THREE.Mesh(geo, mat), g = p.g;
    m.position.set(x, (o.y ?? 0) + this.terrain.heightAt(g.position.x + x, g.position.z + z) - g.position.y, z);
    const s = o.s ?? 1; if (typeof s === 'number') m.scale.setScalar(s); else m.scale.set(...s);
    m.rotation.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, 'YXZ'); m.castShadow = o.shadow ?? true; m.receiveShadow = true; g.add(m);
    if (!o.live) p.statics.push(m);
    return m;
  }
  /** A disc of trampled ground draped over the terrain (radius r), a little above it so it never sinks in. */
  private ground(p: Place, r: number, mat: THREE.Material, stretch = 1) {
    const rings = 5, segs = 28, pos: number[] = [], idx: number[] = [];
    const h0 = p.g.position.y, gx = p.g.position.x, gz = p.g.position.z;
    pos.push(0, this.terrain.heightAt(gx, gz) - h0 + 0.06, 0);
    for (let i = 1; i <= rings; i++) for (let j = 0; j < segs; j++) {
      const a = j / segs * Math.PI * 2, rr = r * i / rings * (i === rings ? 0.85 + 0.3 * rand(p.seed + j) : 1), x = Math.cos(a) * rr * stretch, z = Math.sin(a) * rr;
      pos.push(x, this.terrain.heightAt(gx + x, gz + z) - h0 + 0.06, z);
    }
    for (let j = 0; j < segs; j++) idx.push(0, 1 + (j + 1) % segs, 1 + j);
    for (let i = 1; i < rings; i++) for (let j = 0; j < segs; j++) {
      const a = 1 + (i - 1) * segs + j, b = 1 + (i - 1) * segs + (j + 1) % segs, c = 1 + i * segs + j, d = 1 + i * segs + (j + 1) % segs;
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; p.g.add(m); p.statics.push(m);
  }
  private fire(p: Place, x: number, z: number, sick: boolean, spit = false) {
    for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283; this.mesh(p, G.rock, M.stone, x + Math.cos(a) * 0.95, z + Math.sin(a) * 0.95, { s: 0.3, y: 0.1, ry: a }); }
    for (let i = 0; i < 3; i++) this.mesh(p, G.log, M.darkWood, x, z, { y: 0.15 + i * 0.05, ry: i * 1.05, s: 0.8, shadow: false });
    this.mesh(p, G.rock, M.ash, x, z, { s: [0.7, 0.12, 0.7], y: 0.02, shadow: false });
    const f = this.mesh(p, G.flame, sick ? M.sickFire : M.fire, x, z, { y: 0.2, shadow: false, live: true });
    p.flames.push(f);
    if (spit) {   // a spit on two forked posts with a joint of meat
      for (const s of [-1, 1]) { this.mesh(p, G.post, M.wood, x + s * 1.3, z, { s: [1, 1.6, 1] }); this.mesh(p, G.post, M.wood, x + s * 1.3, z, { y: 1.4, s: [0.7, 0.4, 0.7], rz: s * 0.5 }); }
      this.mesh(p, G.bar, M.iron, x - 1.5, z, { y: 1.55, s: [1.2, 3, 1.2], rz: -Math.PI / 2, shadow: false });
      this.mesh(p, G.sack, M.meat, x, z, { y: 1.2, s: [1.5, 0.9, 0.9] });
    }
  }
  private tent(p: Place, x: number, z: number, i: number, mat: THREE.Material, ry: number) {
    const s = 0.9 + rand(p.seed + i * 3) * 0.3;
    const t = this.mesh(p, G.tent, mat, x, z, { ry, s, live: true });
    t.userData.y0 = t.position.y; t.userData.s0 = s; p.tents.push(t);
    const d = this.mesh(p, G.doorway, M.dark, x + Math.cos(ry) * 1.58 * s, z - Math.sin(ry) * 1.58 * s, { ry, s, shadow: false, live: true });   // the dark mouth of the tent
    d.userData.y0 = d.position.y; d.userData.s0 = s; p.tents.push(d);
    // guy ropes' pegs and the ridge pole sticking out at the front
    this.mesh(p, G.post, M.wood, x + Math.cos(ry) * 1.75 * s, z - Math.sin(ry) * 1.75 * s, { s: [0.6, 2.1 * s, 0.6] });
  }
  private yurt(p: Place, x: number, z: number, mat: THREE.Material) {
    const w = this.mesh(p, G.yurtWall, M.hide, x, z, { y: 0.75, live: true }); w.userData.y0 = w.position.y; w.userData.s0 = 1; p.tents.push(w);
    const r = this.mesh(p, G.yurtRoof, mat, x, z, { y: 2.45, live: true }); r.userData.y0 = r.position.y; r.userData.s0 = 1; p.tents.push(r);
    this.mesh(p, G.box, M.dark, x + 2.62, z, { s: [0.15, 1.2, 0.9] });
  }
  private flag(p: Place, x: number, z: number, mat: THREE.Material, h = 1) {
    this.mesh(p, G.pole, M.wood, x, z, { s: [1, h, 1] });
    const f = this.mesh(p, G.flag, mat, x, z, { y: 6 * h - 1, ry: rand(p.seed) * 6.28, shadow: false, live: true }); p.flags.push(f);
  }
  /** A ring of sharpened stakes, close set and leaning out, with a gateway at angle `gapAt` (two tall posts, a lintel and a skull). */
  private palisade(p: Place, r: number, gapAt: number, gate = true) {
    const n = Math.round(r * 6.283 / 0.48);
    for (let i = 0; i < n; i++) {
      const a = i / n * 6.283; let d = Math.abs(a - gapAt); d = Math.min(d, 6.283 - d); if (d < 0.2) continue;
      const lean = 0.12 + rand(p.seed + i * 5) * 0.08;
      this.mesh(p, G.stake, M.stake, Math.cos(a) * r, Math.sin(a) * r, { y: -0.3, s: [1, 0.8 + rand(p.seed + i) * 0.35, 1], ry: -a, rz: -lean, shadow: i % 2 === 0 });
    }
    if (!gate) return;
    const gx = Math.cos(gapAt) * r, gz = Math.sin(gapAt) * r, tx = -Math.sin(gapAt), tz = Math.cos(gapAt);
    for (const s of [-1, 1]) this.mesh(p, G.post, M.darkWood, gx + tx * s * 1.9, gz + tz * s * 1.9, { y: -0.3, s: [2.2, 4.4, 2.2] });
    this.mesh(p, G.box, M.darkWood, gx, gz, { y: 3.6, s: [0.4, 0.4, 4.6], ry: -gapAt });
    this.mesh(p, G.skull, M.bone, gx, gz, { y: 4.25, s: 0.75 });
    for (const s of [-1, 1]) this.mesh(p, G.skull, M.bone, gx + tx * s * 1.9, gz + tz * s * 1.9, { y: 4.35, s: 0.55 });
  }
  /** A lookout on four legs with a railing and a hide roof. */
  private lookout(p: Place, x: number, z: number) {
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.mesh(p, G.post, M.wood, x + dx, z + dz, { s: [1, 5, 1] });
    this.mesh(p, G.box, M.wood, x, z, { y: 4.8, s: [2.6, 0.2, 2.6] });
    for (const [dx, dz, ry] of [[0, -1.25, 0], [0, 1.25, 0], [-1.25, 0, Math.PI / 2], [1.25, 0, Math.PI / 2]]) this.mesh(p, G.box, M.darkWood, x + dx, z + dz, { y: 5.0, s: [2.6, 0.7, 0.12], ry });
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.mesh(p, G.post, M.wood, x + dx, z + dz, { y: 5, s: [0.8, 1.6, 0.8] });
    this.mesh(p, G.cone, M.hide, x, z, { y: 7.1, s: [0.85, 0.45, 0.85] });
    this.mesh(p, G.box, M.darkWood, x + 1.5, z, { y: 0, s: [0.12, 4.9, 0.7], rz: 0.25 });   // a ladder
  }
  private loot(p: Place, x: number, z: number) {
    const pieces: THREE.Object3D[] = [];
    for (let i = 0; i < 4; i++) pieces.push(this.mesh(p, G.box, M.wood, x + (i % 2) * 0.9 - 0.4, z + Math.floor(i / 2) * 0.9 - 0.4, { s: 0.8, ry: rand(p.seed + i) * 0.6, live: true }));
    pieces.push(this.mesh(p, G.box, M.wood, x, z, { y: 0.8, s: 0.75, ry: 0.4, live: true }));
    for (let i = 0; i < 3; i++) pieces.push(this.mesh(p, G.barrel, M.wood, x + 1.6, z - 0.9 + i * 0.85, { live: true }));
    for (let i = 0; i < 4; i++) pieces.push(this.mesh(p, G.sack, M.sack, x - 1.5 + rand(p.seed + i * 3) * 0.6, z - 0.8 + i * 0.6, { ry: i, live: true }));
    const chest = this.mesh(p, G.box, M.darkWood, x - 0.2, z + 1.5, { s: [1.1, 0.6, 0.7], live: true }); pieces.push(chest);
    pieces.push(this.mesh(p, G.box, M.gold, x - 0.2, z + 1.5, { y: 0.6, s: [0.9, 0.12, 0.55], live: true, shadow: false }));
    p.loot.push(...pieces);
  }
  private weaponRack(p: Place, x: number, z: number, ry: number) {
    const c = Math.cos(ry), s = Math.sin(ry);
    for (const k of [-1, 1]) this.mesh(p, G.post, M.wood, x + c * k * 1.1, z - s * k * 1.1, { s: [1, 1.5, 1] });
    this.mesh(p, G.bar, M.wood, x - c * 1.2, z + s * 1.2, { y: 1.3, s: [1.6, 2.4, 1.6], rz: -Math.PI / 2, ry });
    for (let i = 0; i < 5; i++) { const t = -0.9 + i * 0.45; this.mesh(p, G.bar, i % 2 ? M.iron : M.wood, x + c * t + s * 0.25, z - s * t + c * 0.25, { s: [1, 2.6, 1], rx: -0.3, ry, shadow: false }); }
  }
  private cage(p: Place, x: number, z: number) {
    this.mesh(p, G.box, M.darkWood, x, z, { s: [1.8, 0.15, 1.8] });
    this.mesh(p, G.box, M.darkWood, x, z, { y: 1.9, s: [1.8, 0.15, 1.8] });
    for (let i = 0; i < 16; i++) { const side = Math.floor(i / 4), t = (i % 4) / 3 * 1.6 - 0.8; const [dx, dz] = side === 0 ? [t, -0.85] : side === 1 ? [0.85, t] : side === 2 ? [-t, 0.85] : [-0.85, -t]; this.mesh(p, G.bar, M.iron, x + dx, z + dz, { s: [1, 1.95, 1], shadow: false }); }
  }

  private build(kind: number, x: number, z: number): Place {
    const g = new THREE.Group(); g.position.set(x, this.terrain.heightAt(x, z), z);
    const p: Place = { g, kind, x, z, done: false, flames: [], tents: [], flags: [], loot: [], seed: Math.floor(x * 7 + z * 13), statics: [] };
    const gap = rand(p.seed + 9) * 6.283;
    if (kind === 2) {   // bandit camp: a stockade of sharpened stakes round tents, a chief's yurt, a fire with a spit, loot, a lookout and a cage
      this.ground(p, 10, M.ground);
      this.palisade(p, 10, gap);
      this.fire(p, 0, 0, false, true);
      for (let i = 0; i < 4; i++) { const a = gap + Math.PI / 2 + i * 0.5 + 0.25; this.mesh(p, G.bench, M.wood, Math.cos(a) * 2.6, Math.sin(a) * 2.6, { y: 0.2, ry: -a + Math.PI / 2 }); }
      const n = 4 + Math.floor(rand(p.seed) * 2);
      for (let i = 0; i < n; i++) {   // the tents stand round the fire, their doors turned in to it, leaving the way from the gate clear
        const a = gap + 0.9 + i / (n - 1) * (6.283 - 1.8 - 1.4);
        this.tent(p, Math.cos(a) * 6.3, Math.sin(a) * 6.3, i, M.cloth[i % 4], Math.PI - a);
      }
      const back = gap + Math.PI;   // the chief's yurt at the far side from the gate, with the banner and the loot
      this.yurt(p, Math.cos(back + 1.1) * 5.6, Math.sin(back + 1.1) * 5.6, M.cloth[0]);
      this.flag(p, Math.cos(back + 0.55) * 4.4, Math.sin(back + 0.55) * 4.4, M.banner, 1.1);
      this.loot(p, Math.cos(back - 0.35) * 5.4, Math.sin(back - 0.35) * 5.4);
      this.lookout(p, Math.cos(gap - 0.55) * 7.6, Math.sin(gap - 0.55) * 7.6);
      this.weaponRack(p, Math.cos(gap + 0.6) * 6.4, Math.sin(gap + 0.6) * 6.4, -(gap + 0.6) + Math.PI / 2);
      this.cage(p, Math.cos(back - 1.3) * 6.6, Math.sin(back - 1.3) * 6.6);
      for (let i = 0; i < 3; i++) { const a = gap + (i - 1) * 0.35, r = 12 + rand(p.seed + i) * 1.5; this.mesh(p, G.post, M.wood, Math.cos(a) * r, Math.sin(a) * r, { s: [0.8, 2.2, 0.8], rz: 0.15 }); this.mesh(p, G.skull, M.bone, Math.cos(a) * r, Math.sin(a) * r, { y: 2.3, s: 0.55 }); }   // skulls on poles warn travellers off
    } else if (kind === 3) {   // lair: a heap of boulders with a dark mouth, a skull totem and two fires
      this.ground(p, 9, M.ground);
      for (let i = 0; i < 9; i++) { const a = i / 9 * 6.283, r = 4.5 + rand(p.seed + i) * 2; this.mesh(p, G.rock, M.stone, Math.cos(a) * r, Math.sin(a) * r, { s: [2.2 + rand(i) * 1.6, 1.8 + rand(i + 4) * 1.8, 2.2 + rand(i + 8) * 1.6], y: 0.8, ry: a }); }
      this.mesh(p, G.rock, M.ash, 0, -1, { s: [3, 2.2, 2.4], y: 1.0 });
      this.flag(p, 3, 3, M.banner, 1.3);
      for (let i = 0; i < 3; i++) this.mesh(p, G.skull, M.bone, 3, 3, { y: 1.1 + i * 0.9, s: 1.2 - i * 0.15 });
      this.fire(p, -3.5, 4, false); this.fire(p, 4.5, -3, false);
      for (let i = 0; i < 12; i++) { const a = rand(p.seed + i * 5) * 6.283, r = 6 + rand(i * 9) * 4; this.mesh(p, G.log, M.bone, Math.cos(a) * r, Math.sin(a) * r, { y: 0.1, ry: a, s: 0.7, shadow: false }); }
    } else if (kind === 4) {   // the plague doctor's camp: sickly green cloth, a green fire, a flag on a pole
      this.ground(p, 8.5, M.sickGround);
      for (let i = 0; i < 4; i++) { const a = i / 4 * 6.283 + 0.4; this.tent(p, Math.cos(a) * 4.8, Math.sin(a) * 4.8, i, M.sick, Math.PI - a); }
      this.fire(p, 0, 0, true); this.palisade(p, 8, gap, false); this.flag(p, 0, 6.6, M.sick, 1.1);
      this.cage(p, -2.5, -2.2);
    } else if (kind === 0) {   // abbey: a stone church with a bell tower, a walled cloister garth, a herb garden and a few graves
      this.ground(p, 11, M.path, 1.1);
      const ry = gap, c = Math.cos(ry), s = Math.sin(ry), at = (u: number, v: number): [number, number] => [c * u - s * v, s * u + c * v];
      const base = Math.min(...[[-5, -3], [5, -3], [-5, 3], [5, 3]].map(([u, v]) => { const [px, pz] = at(u, v); return this.terrain.heightAt(x + px, z + pz) - g.position.y; }));
      { const [px, pz] = at(0, 0); this.mesh(p, G.box, M.paleStone, px, pz, { y: base - 0.6 - (this.terrain.heightAt(x + px, z + pz) - g.position.y), s: [10, 4.6, 4.4], ry: -ry }); }   // the nave, on a footing level with the lowest corner
      { const [px, pz] = at(0, 0); this.mesh(p, G.gable, M.roof, px, pz, { y: base + 4 - (this.terrain.heightAt(x + px, z + pz) - g.position.y), s: [2.5, 2.4, 10.2], ry: -ry + Math.PI / 2 }); }
      { const [px, pz] = at(-6, 0); const y = base - 0.6 - (this.terrain.heightAt(x + px, z + pz) - g.position.y); this.mesh(p, G.box, M.paleStone, px, pz, { y, s: [3, 9, 3], ry: -ry }); this.mesh(p, G.spire, M.roof, px, pz, { y: y + 9, s: [1.2, 1.3, 1.2], ry: -ry }); this.mesh(p, G.box, M.dark, px, pz, { y: y + 6.6, s: [3.05, 1.1, 0.7], ry: -ry }); }
      for (let i = -2; i <= 2; i++) for (const side of [-1, 1]) { const [px, pz] = at(i * 1.8, side * 2.22); this.mesh(p, G.box, M.dark, px, pz, { y: base + 1.4 - (this.terrain.heightAt(x + px, z + pz) - g.position.y), s: [0.45, 1.4, 0.1], ry: -ry, shadow: false }); }   // tall windows, level with the nave's footing
      { const [px, pz] = at(5.02, 0); this.mesh(p, G.box, M.darkWood, px, pz, { y: base - 0.2 - (this.terrain.heightAt(x + px, z + pz) - g.position.y), s: [0.1, 2.4, 1.3], ry: -ry, shadow: false }); }   // the west door
      // the cloister: a low wall round a garth on the south side, with a well in the middle
      for (const [u0, v0, u1, v1] of [[-4, 2.3, -4, 9], [4, 2.3, 4, 9], [-4, 9, 4, 9]]) {
        const len = Math.hypot(u1 - u0, v1 - v0), [px, pz] = at((u0 + u1) / 2, (v0 + v1) / 2);
        this.mesh(p, G.box, M.paleStone, px, pz, { y: -0.3, s: u0 === u1 ? [0.5, 1.6, len] : [len, 1.6, 0.5], ry: -ry });
        if (u0 === u1) this.mesh(p, G.box, M.roof, px, pz, { y: 1.3, s: [1.6, 0.15, len], ry: -ry, rz: (u0 < 0 ? -1 : 1) * 0.25 });
      }
      { const [px, pz] = at(0, 6); this.mesh(p, G.barrel, M.stone, px, pz, { s: [1.3, 0.9, 1.3] }); this.mesh(p, G.box, M.dark, px, pz, { y: 0.86, s: [0.8, 0.05, 0.8], shadow: false }); }
      for (let i = 0; i < 6; i++) { const [px, pz] = at(-2.6 + (i % 3) * 2.6, 4.2 + Math.floor(i / 3) * 3.4); this.mesh(p, G.bush, M.leaf, px, pz, { s: [0.7, 0.45, 0.7], y: 0.15 }); }
      for (let i = 0; i < 5; i++) { const [px, pz] = at(-7.5 + i * 1.2, -4.6 - (i % 2) * 0.6); this.mesh(p, G.box, M.stone, px, pz, { s: [0.5, 0.8 + (i % 2) * 0.25, 0.14], ry: -ry, rz: (rand(p.seed + i) - 0.5) * 0.2 }); }   // graves
      { const [px, pz] = at(7.5, 1.5); this.flag(p, px, pz, M.abbeyBanner, 0.8); }
    } else {   // ruined castle: broken curtain walls on a mound of rubble, a split round tower, a fallen gate arch, ivy and the hoard's chests
      this.ground(p, 12, M.path);
      const pts: [number, number][] = [];
      for (let i = 0; i < 6; i++) { const a = gap + i / 6 * 6.283; pts.push([Math.cos(a) * 8.5, Math.sin(a) * 8.5]); }
      for (let i = 0; i < 6; i++) {
        if (i === 0) continue;   // the gate side is open: its arch has fallen
        const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % 6], segs = 4;
        for (let k = 0; k < segs; k++) {   // each wall is a run of blocks of uneven height: whole in some places, broken down to its footing in others
          const t = (k + 0.5) / segs, h = 0.6 + rand(p.seed + i * 7 + k) ** 1.6 * 5.2;
          if (rand(p.seed + i * 3 + k * 11) < 0.18) continue;
          const len = Math.hypot(bx - ax, bz - az) / segs + 0.05;
          this.mesh(p, G.box, M.stone, ax + (bx - ax) * t, az + (bz - az) * t, { y: -0.4, s: [len, h, 1.2], ry: -Math.atan2(bz - az, bx - ax) });
          if (h > 3 && rand(p.seed + k + i) > 0.4) this.mesh(p, G.box, M.ivy, ax + (bx - ax) * t, az + (bz - az) * t, { y: h * 0.35, s: [len * 0.6, h * 0.5, 1.3], ry: -Math.atan2(bz - az, bx - ax), shadow: false });
        }
      }
      for (const i of [2, 4]) {   // two round towers at the corners, one split open
        const [tx, tz] = pts[i], h = i === 2 ? 8 : 4.2;
        this.mesh(p, G.tower, M.stone, tx, tz, { y: -0.4, s: [1, h, 1] });
        for (let k = 0; k < 5; k++) { const a = k / 5 * 6.283; if (i === 4 && k < 2) continue; this.mesh(p, G.box, M.stone, tx + Math.cos(a) * 1.9, tz + Math.sin(a) * 1.9, { y: h - 0.4, s: [0.8, 0.5 + rand(k + i) * 0.9, 0.8], ry: a }); }
        this.mesh(p, G.box, M.dark, tx + Math.cos(gap) * 0.2, tz + Math.sin(gap) * 0.2, { y: h * 0.55, s: [0.35, 0.9, 4.6], ry: -gap + Math.PI / 2, shadow: false });
      }
      { const [ax, az] = pts[0], [bx, bz] = pts[1]; for (const t of [0.3, 0.7]) this.mesh(p, G.box, M.stone, ax + (bx - ax) * t, az + (bz - az) * t, { y: -0.3, s: [1.1, 3.6, 1.4], ry: -Math.atan2(bz - az, bx - ax) }); }   // the gate's two piers
      for (let i = 0; i < 26; i++) { const a = rand(p.seed + i * 17) * 6.283, r = 2 + rand(p.seed + i * 5) * 9; this.mesh(p, G.rock, M.stone, Math.cos(a) * r, Math.sin(a) * r, { s: [0.4 + rand(i) * 0.6, 0.3 + rand(i + 3) * 0.4, 0.4 + rand(i + 7) * 0.5], y: 0.05, ry: a }); }   // rubble
      for (let i = 0; i < 5; i++) { const a = rand(p.seed + i * 29) * 6.283, r = 3 + rand(i * 3) * 6; this.mesh(p, G.bush, M.leaf, Math.cos(a) * r, Math.sin(a) * r, { s: [0.9, 0.6, 0.9], y: 0.2 }); }
      this.loot(p, 0, 0);
    }
    this.merge(p);
    this.group.add(g);
    return p;
  }

  /** Merge the pieces that never change into one mesh per material (and shadow casting), so a place is a dozen draws, not hundreds. */
  private merge(p: Place) {
    const groups = new Map<string, { mat: THREE.Material; shadow: boolean; geos: THREE.BufferGeometry[] }>();
    p.g.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(p.g.matrixWorld).invert();
    for (const m of p.statics) {
      const mat = m.material as THREE.Material, key = `${mat.uuid}:${m.castShadow}`;
      let e = groups.get(key); if (!e) { e = { mat, shadow: m.castShadow, geos: [] }; groups.set(key, e); }
      let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      geo = geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      e.geos.push(geo); p.g.remove(m);
    }
    for (const e of groups.values()) {
      const merged = mergeGeometries(e.geos); for (const g of e.geos) g.dispose(); if (!merged) continue;
      const m = new THREE.Mesh(merged, e.mat); m.castShadow = e.shadow; m.receiveShadow = true; p.g.add(m);
    }
    p.statics = [];
  }

  /** neutrals_flat() (stride 4: kind, x, z, done): add the places that have been found, mark the cleared ones, drop the ones that are no longer listed. True when a place came or went (the forest makes room for it). */
  sync(flat: Float32Array): boolean {
    const seen = new Set<string>(); let changed = false;
    for (let i = 0; i + 3 < flat.length; i += 4) {
      const kind = flat[i];
      const x = flat[i + 1], z = flat[i + 2], key = `${kind}:${Math.round(x)}:${Math.round(z)}`; seen.add(key);
      let p = this.places.get(key); if (!p) { p = this.build(kind, x, z); this.places.set(key, p); changed = true; }
      const done = flat[i + 3] > 0;
      if (done !== p.done) {   // cleared: tents slump, flags come down, the fire dies, the loot is gone (an abbey that has healed you stays as it is)
        p.done = done;
        const drop = kind !== 0;
        for (const t of p.tents) { t.scale.set(t.userData.s0, done ? t.userData.s0 * 0.3 : t.userData.s0, t.userData.s0); t.position.y = t.userData.y0 - (done ? 0.5 : 0); }
        for (const f of p.flags) f.visible = !done || !drop;
        for (const f of p.flames) f.visible = !done;
        for (const l of p.loot) l.visible = !done;
      }
    }
    for (const [key, p] of this.places) if (!seen.has(key)) { this.group.remove(p.g); this.places.delete(key); changed = true; }
    return changed;
  }

  /** The place whose ground (x, z) is on, if any: its kind and centre. */
  placeAt(x: number, z: number): { kind: number; x: number; z: number; done: boolean } | null {
    let best: Place | null = null, bd = Infinity;
    for (const p of this.places.values()) { const d = Math.hypot(p.x - x, p.z - z); if (d < PLACE_RADIUS[p.kind] && d < bd) { bd = d; best = p; } }
    return best && { kind: best.kind, x: best.x, z: best.z, done: best.done };
  }

  /** Flicker the fires and stir the flags; `t` in seconds. Places far from (x, z) are hidden. */
  update(t: number, x: number, z: number) {
    for (const p of this.places.values()) {
      p.g.visible = Math.hypot(p.g.position.x - x, p.g.position.z - z) < 600;
      if (!p.g.visible) continue;
      for (const f of p.flames) {
        const k = 0.85 + 0.15 * Math.sin(t * 9 + p.seed) + 0.1 * Math.sin(t * 23 + p.seed * 2);
        f.scale.set(k, 0.8 + 0.4 * k, k);
      }
      for (const f of p.flags) f.rotation.y = 0.3 * Math.sin(t * 1.7 + p.seed) + (f.userData.r0 ??= f.rotation.y);
    }
  }
}

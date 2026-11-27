import * as THREE from 'three';
import type { Terrain } from './terrain';
import { deposit_near } from './depositcull';

const rand = (s: number) => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

function rockGeo(seed: number) {
  const g = new THREE.DodecahedronGeometry(1, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const k = 0.75 + rand(seed + Math.round(p.getX(i) * 10 + p.getY(i) * 7 + p.getZ(i) * 13)) * 0.5; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.75, p.getZ(i) * k); }
  g.computeVertexNormals();
  return g;
}
const mats = [
  new THREE.MeshStandardMaterial({ color: 0xa5a29b, roughness: 1, flatShading: true }),                       // stone
  new THREE.MeshStandardMaterial({ color: 0xb9663a, roughness: 0.7, flatShading: true }),                     // clay
  new THREE.MeshStandardMaterial({ color: 0x6d6560, roughness: 1, flatShading: true }),                       // iron host rock
  new THREE.MeshStandardMaterial({ color: 0x7c7770, roughness: 1, flatShading: true }),                       // gold host rock
  new THREE.MeshStandardMaterial({ color: 0x6e3b22, roughness: 0.25, flatShading: true }),                    // wet clay in the pit
];
const WET = 4;
const oreMats = [
  null, null,
  new THREE.MeshStandardMaterial({ color: 0xa8482a, roughness: 0.6, metalness: 0.3, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0xffd23a, roughness: 0.25, metalness: 0.9, emissive: 0x9a6a00, emissiveIntensity: 0.9, flatShading: true }),
];
const DORMANT = new THREE.Color(0x8a8782);   // dried up: grey rock
const WORKED = 0.72;                         // the rocks nearest a mine's door are darker: worked, weathered

/** Rock shapes: every rock is one of these, turned and scaled (each rock used to have a shape of its own, and so a mesh and a draw of its own). */
const VARIANTS = 12;
const rockShapes = Array.from({ length: VARIANTS }, (_, v) => rockGeo(9001 + v * 37));
const oreShape = new THREE.OctahedronGeometry(1, 0);
const WHITE = new THREE.Color(1, 1, 1);
/** Where a mine, quarry or clay pit stands at its deposit: its centre, the way from it into the deposit, and the deposit kind. */
type Work = { x: number; z: number; dx: number; dz: number; kind: number };

/**
 * The deposits of the map: about a thousand piles of five or six rocks with ore chips, about seven and a half thousand pieces.
 * Each piece used to be a mesh of its own, so the CPU walked, culled and drew them one by one every frame. Now each deposit keeps an invisible group of
 * positions (the same layout as before, so everything that moves, shrinks or seats them works as it did), and the pieces are drawn as instances of 50 meshes
 * (12 rock shapes for each of the 4 rocks, and the chips of the 2 ores): the GPU draws them in a few calls. Each instanced mesh holds only the pieces that are
 * shown (near the camera, above water, not cleared): it is packed afresh whenever one of its pieces changes. (Hidden pieces used to stay in the mesh at zero size,
 * so the GPU still drew all seven thousand of them, in the shadow map too, wherever the camera was.) The dried-up and worked shades are per-instance colours.
 */
export class Deposits {
  group = new THREE.Group();
  private groups: THREE.Group[] = [];
  private flat: Float32Array;
  /** Every rock with the ore chips on it, so each can be seated on the ground under it (a deposit on a slope would otherwise hang in the air on its downhill side). */
  private parts: { g: THREE.Group; rock: THREE.Object3D; ore: { o: THREE.Object3D; dy: number }[]; lift: number }[] = [];
  /** The instanced mesh that draws each piece, and the pieces each mesh draws (in a fixed order, so a packed mesh always lists its pieces the same way). */
  private meshOf = new Map<THREE.Object3D, THREE.InstancedMesh>();
  private members = new Map<THREE.InstancedMesh, THREE.Object3D[]>();
  /** Each shaded rock's colour factor (a rock not listed is drawn in its material's own colour). */
  private tints = new Map<THREE.Object3D, THREE.Color>();
  private dirty = new Set<THREE.InstancedMesh>();
  private m = new THREE.Matrix4();

  private show(g: THREE.Group) { g.visible = !g.userData.sub && !g.userData.gone && !g.userData.far; this.stamp(g); }
  /** One deposit moved, shrank, was seated, hidden or shown: its pieces' meshes are packed afresh at the next flush. */
  private stamp(g: THREE.Group) {
    g.updateMatrix();
    for (const c of g.children) {
      c.updateMatrix();
      const mesh = this.meshOf.get(c); if (mesh) this.dirty.add(mesh);
    }
  }
  /** A rock's shade: its own colour, the dried-up grey or the worked darkening, as a factor on its material's colour. */
  private shade(rock: THREE.Object3D) {
    const mesh = this.meshOf.get(rock); if (!mesh) return;
    const base = (mesh.material as THREE.MeshStandardMaterial).color;
    if (rock.userData.dormant) this.tints.set(rock, new THREE.Color(DORMANT.r / Math.max(base.r, 1e-3), DORMANT.g / Math.max(base.g, 1e-3), DORMANT.b / Math.max(base.b, 1e-3)));
    else if (rock.userData.worked) this.tints.set(rock, new THREE.Color().setScalar(WORKED));
    else this.tints.delete(rock);
    this.dirty.add(mesh);
  }
  /** Pack every changed mesh: only the pieces that are shown, one after the other, and draw just that many. */
  private flush() {
    for (const mesh of this.dirty) {
      let n = 0;
      for (const node of this.members.get(mesh)!) {
        const g = node.parent!;
        if (!g.visible || !node.visible) continue;
        mesh.setMatrixAt(n, this.m.multiplyMatrices(g.matrix, node.matrix));
        mesh.setColorAt(n, this.tints.get(node) ?? WHITE);
        n++;
      }
      mesh.count = n; mesh.visible = n > 0;
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, n * 16); mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) { mesh.instanceColor.clearUpdateRanges(); mesh.instanceColor.addUpdateRange(0, n * 3); mesh.instanceColor.needsUpdate = true; }
    }
    this.dirty.clear();
  }

  private cullAt = { x: NaN, z: NaN, r: 0 };
  /** Hide the deposits farther than `r` from (x, z) (they cannot be on screen); call a few times a second. */
  cull(x: number, z: number, r: number) {
    const c = this.cullAt; if (Math.abs(c.x - x) < 8 && Math.abs(c.z - z) < 8 && c.r === r) return;
    this.cullAt = { x, z, r };
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i], far = !deposit_near(this.flat[i * 5 + 1], this.flat[i * 5 + 2], x, z, r);
      if (!!g.userData.far !== far) { g.userData.far = far; this.show(g); }
    }
    this.flush();
  }

  /** Deposits that a mine, quarry or clay pit works. The pile stays at its map position. */
  private worked = new Map<number, { key: string; decal: THREE.Mesh; tinted: THREE.Object3D[]; hill: THREE.Mesh | null; buried: THREE.Object3D[]; at: Work }>();
  private hillMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  private decalMat = new THREE.MeshStandardMaterial({ color: 0x4a3f33, roughness: 1, transparent: true, opacity: 0.88, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  /** buildings_flat() (stride 10): connect every deposit that has a working building beside it. A mine's door looks away from the village, towards its deposit (see the models). */
  attach(buildings: Float32Array) {
    const want = new Map<number, { x: number; z: number; dx: number; dz: number }>();
    for (let i = 0; i + 9 < buildings.length; i += 10) {
      const k = buildings[i], dk = k === 6 ? 0 : k === 7 ? 1 : k === 9 ? 2 : k === 10 ? 3 : -1; if (dk < 0) continue;
      const x = buildings[i + 2], z = buildings[i + 3];
      let best = -1, bd = 10 * 10;
      for (let d = 0; d < this.groups.length; d++) {
        if (this.flat[d * 5] !== dk || this.groups[d].userData.gone) continue;
        const q = (this.flat[d * 5 + 1] - x) ** 2 + (this.flat[d * 5 + 2] - z) ** 2; if (q < bd) { bd = q; best = d; }
      }
      if (best < 0) continue;
      const a = (buildings[i + 4] & 7) * Math.PI / 4, ax = -Math.sin(a), az = -Math.cos(a);   // away from the village: where the deposit is
      want.set(best, { x, z, dx: ax, dz: az });
    }
    for (const [d, w] of want) {
      const key = `${w.x}:${w.z}:${w.dx.toFixed(2)}`, cur = this.worked.get(d);
      if (cur && cur.key === key) continue;
      if (cur) this.release(d);
      const g = this.groups[d], door = 2.0, dk = this.flat[d * 5];
      const decal = new THREE.Mesh(new THREE.CircleGeometry(2.7, 20).rotateX(-Math.PI / 2), this.decalMat);
      if (dk === 1) { decal.scale.set(1.35, 1, 0.8); decal.rotation.y = Math.atan2(w.dx, w.dz); }   // clay: a long muddy track, not a circle
      const dd = dk === 1 ? door + 0.4 : dk === 0 ? 0 : 0.5;   // (a mine's trodden ground lies in front of its door, not inside the hill)
      decal.position.set(w.x + w.dx * dd, this.terrain.heightAt(w.x + w.dx * dd, w.z + w.dz * dd) + 0.07, w.z + w.dz * dd); decal.renderOrder = 2; this.group.add(decal);
      const tinted: THREE.Object3D[] = [];
      for (const p of this.parts) {   // the rocks nearest the door are darker: worked, weathered
        if (p.g !== g) continue;
        const rx = g.position.x + p.rock.position.x, rz = g.position.z + p.rock.position.z;
        if (Math.hypot(rx - (w.x + w.dx * door), rz - (w.z + w.dz * door)) < 3.4) { tinted.push(p.rock); p.rock.userData.worked = true; this.shade(p.rock); }
      }
      const entry = { key, decal, tinted, hill: null as THREE.Mesh | null, buried: [] as THREE.Object3D[], at: { ...w, kind: dk } };
      this.worked.set(d, entry); this.raiseHill(d);
    }
    for (const d of [...this.worked.keys()]) if (!want.has(d)) this.release(d);
    this.flush();
  }

  private release(d: number) {
    const w = this.worked.get(d); if (!w) return;
    this.group.remove(w.decal); w.decal.geometry.dispose();
    for (const rock of w.tinted) { rock.userData.worked = false; this.shade(rock); }
    this.lowerHill(d);
    this.worked.delete(d);
  }

  constructor(flat: Float32Array, private terrain: Terrain) {
    this.flat = flat;
    // first the layout (as before), then one instanced mesh per rock shape and material, sized to what it holds
    const want: { node: THREE.Object3D; key: string; mat: THREE.MeshStandardMaterial; geo: THREE.BufferGeometry; shadow: boolean }[] = [];
    for (let i = 0; i < flat.length; i += 5) {
      const kind = flat[i], x = flat[i + 1], z = flat[i + 2], g = new THREE.Group();
      g.position.set(x, terrain.heightAt(x, z) - 0.15, z);
      const n = kind === 1 ? 8 : 6;
      for (let k = 0; k < n; k++) {
        // clay: a ring of low spoil heaps round a wet pit (k = 0), not a dome
        const pit = kind === 1 && k === 0, heap = kind === 1 && !pit;
        const s = pit ? 2.3 : heap ? 0.55 + rand(i * 3 + k) * 0.5 : 0.9 + rand(i * 3 + k) * 1.4;
        const a = heap ? ((k - 1) / (n - 1)) * 6.28 + rand(i + k) * 0.4 : rand(i + k * 7) * 6.28, d = pit ? 0 : heap ? 2.4 + rand(i + k * 11) * 0.7 : k === 0 ? 0 : 1.3 + rand(i + k * 11) * 1.6;
        const m = new THREE.Object3D(), v = (i + k) % VARIANTS;
        m.scale.setScalar(s); if (pit) m.scale.y = 0.1; else if (heap) m.scale.set(s * 1.5, s * 0.5, s * 1.1);
        m.position.set(Math.cos(a) * d, 0.35 * s, Math.sin(a) * d); m.rotation.y = a;
        g.add(m); want.push({ node: m, key: `r${kind}:${v}${pit ? 'w' : ''}`, mat: pit ? mats[WET] : mats[kind], geo: rockShapes[v], shadow: !pit });
        const part = { g, rock: m, ore: [] as { o: THREE.Object3D; dy: number }[], lift: 0.35 * (m.scale.y) };
        this.parts.push(part);
        const ore = oreMats[kind];
        if (ore) for (let vv = 0; vv < 3; vv++) {
          const o = new THREE.Object3D(); o.scale.setScalar(0.28 + rand(i + k + vv) * 0.2);
          const aa = a + (vv - 1) * 0.6; o.position.set(m.position.x + Math.cos(aa) * s * 0.7, m.position.y + 0.2 + vv * 0.18, m.position.z + Math.sin(aa) * s * 0.7);
          o.rotation.set(rand(vv) * 3, rand(vv + 3) * 3, 0); g.add(o); want.push({ node: o, key: `o${kind}`, mat: ore, geo: oreShape, shadow: false });
          part.ore.push({ o, dy: o.position.y - m.position.y });
        }
      }
      g.matrixAutoUpdate = false; for (const c of g.children) c.matrixAutoUpdate = false;
      this.groups.push(g);
    }
    const counts = new Map<string, number>(); for (const w of want) counts.set(w.key, (counts.get(w.key) ?? 0) + 1);
    const meshes = new Map<string, THREE.InstancedMesh>();
    for (const w of want) {
      let im = meshes.get(w.key);
      if (!im) {
        im = new THREE.InstancedMesh(w.geo, w.mat, counts.get(w.key)!);
        // (its instances span the map, so it is not culled as a whole; it only ever holds the pieces near the camera.) The ore chips are too small to cast a shadow.
        im.castShadow = w.shadow; im.receiveShadow = w.shadow; im.frustumCulled = false;
        im.matrixAutoUpdate = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        for (let j = 0; j < im.count; j++) im.setColorAt(j, WHITE);
        im.count = 0;
        meshes.set(w.key, im); this.members.set(im, []); this.group.add(im);
      }
      this.meshOf.set(w.node, im); this.members.get(im)!.push(w.node);
    }
    this.group.matrixAutoUpdate = false;
    for (const g of this.groups) this.stamp(g);
    this.flush();
  }

  /** A mine or quarry works its deposit as a hillside: the pile of rocks becomes the top of a rocky hill, draped on the ground, with a sheer face where the
   *  building stands. A mine's face is cut flush behind its door frame, so the door opens into the rock (an adit); a quarry's face is cut in three benches
   *  of fresh pale stone above its pit. Rocks of the pile that would stand in front of the face (in the doorway or the pit) are not drawn. */
  private raiseHill(d: number) {
    const e = this.worked.get(d); if (!e) return;
    this.lowerHill(d);
    const w = e.at, kind = w.kind; if (kind === 1) return;   // a clay pit digs down, it has no face
    const quarry = kind === 0, g = this.groups[d];
    const nx = w.dx, nz = w.dz, tx = -nz, tz = nx;                  // n: from the building into the deposit; t: across
    const faceD = quarry ? 3.3 : 2.05, fx = w.x + nx * faceD, fz = w.z + nz * faceD;
    const toDep = (g.position.x - fx) * nx + (g.position.z - fz) * nz;
    const L = Math.max(5, toDep + 4.2), W = quarry ? 5.2 : 4.6, H = quarry ? 3.7 : 4.3;
    // rows along n: (u, height share, cliff) — two rows at the same u make a sheer wall
    const rows: [number, number][] = quarry
      ? [[0, -1], [0, 1 / 3], [1.0, 1 / 3], [1.0, 2 / 3], [2.0, 2 / 3], [2.0, 1], [2.8, 1]]
      : [[0, -1], [0, 0.92], [0.7, 0.96], [1.4, 1]];
    const top = rows[rows.length - 1][0];
    for (let k = 1; k <= 5; k++) { const u = top + (L - top) * k / 5; rows.push([u, 0.5 + 0.5 * Math.cos(Math.PI * k / 5)]); }
    const NV = 14, pos: number[] = [], seed = d * 31;
    for (let r = 0; r < rows.length; r++) for (let j = 0; j <= NV; j++) {
      const v = (j / NV * 2 - 1) * W, vv = v / W, across = Math.pow(Math.max(0, 1 - vv * vv), 0.7);
      const [u0, share] = rows[r], back = (quarry ? 0.7 : 1.1) * vv * vv, u = back + u0 * (L - back) / L;   // the face curves back at its sides, so the hill wraps round the cut
      const inner = r > 1 && r < rows.length - 1 && j > 0 && j < NV;
      const jv = inner ? (rand(seed + r * 17 + j) - 0.5) * 0.5 : 0, ju = inner && r > (quarry ? 6 : 3) ? (rand(seed + r * 5 + j * 3) - 0.5) * 0.6 : 0;
      const px = fx + nx * (u + ju) + tx * (v + jv), pz = fz + nz * (u + ju) + tz * (v + jv), ground = this.terrain.heightAt(px, pz);
      const h = share < 0 ? -0.35 : H * share * across + (r === rows.length - 1 || j === 0 || j === NV ? -0.35 : inner ? (rand(seed + r * 7 + j * 11) - 0.5) * 0.5 : 0);
      pos.push(px, ground + Math.max(-0.35, h), pz);
    }
    const idx: number[] = [], cols = NV + 1;
    for (let r = 0; r + 1 < rows.length; r++) for (let j = 0; j < NV; j++) { const a = r * cols + j, b = a + 1, c = a + cols, dd = c + 1; idx.push(a, b, c, b, dd, c); }
    let geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    geo = geo.toNonIndexed(); geo.computeVertexNormals();
    // colours by facing: sheer faces are bare rock (fresh pale stone in a quarry, streaked with ore in a mine), gentle tops carry turf
    const N = geo.attributes.normal, P = geo.attributes.position, col = new Float32Array(P.count * 3), c = new THREE.Color();
    const rock = new THREE.Color(quarry ? 0x9b978f : kind === 3 ? 0x8a857d : 0x746c65), cut = new THREE.Color(quarry ? 0xc4baa2 : kind === 3 ? 0x8a8378 : 0x766c63);
    const turf = new THREE.Color(0x5d7436), ore = new THREE.Color(kind === 3 ? 0xc9a02c : 0x8e4a2b), bench = new THREE.Color(0xa8a090);
    for (let f = 0; f < P.count; f += 3) {
      const ny = N.getY(f), r = rand(seed + f * 0.37), hAbove = (P.getY(f) + P.getY(f + 1) + P.getY(f + 2)) / 3 - this.terrain.heightAt(P.getX(f), P.getZ(f));
      if (ny < 0.55) { c.copy(cut); if (!quarry && r < 0.16) c.lerp(ore, 0.75); }
      else if (quarry && ny > 0.9 && hAbove < H * 0.9) c.copy(bench);
      else if (ny > 0.8 && hAbove > 0.6) c.copy(turf).lerp(rock, r * 0.35);
      else c.copy(rock).lerp(turf, r * 0.3);
      c.multiplyScalar(0.92 + r * 0.16);
      for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (f + k) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const hill = new THREE.Mesh(geo, this.hillMat); hill.castShadow = hill.receiveShadow = true; hill.matrixAutoUpdate = false;
    this.group.add(hill); e.hill = hill;
    // rocks of the pile standing in front of the face, in the doorway or the pit, are left out
    const sc = g.scale.x;
    for (const p of this.parts) {
      if (p.g !== g) continue;
      const rx = g.position.x + p.rock.position.x * sc - fx, rz = g.position.z + p.rock.position.z * sc - fz, rr = p.rock.scale.x * sc;
      const u = rx * nx + rz * nz, v = Math.abs(rx * tx + rz * tz);
      if (u - rr * 0.6 < (quarry ? 1.2 : 0.5) && v < W * 0.8) { e.buried.push(p.rock); p.rock.visible = false; for (const o of p.ore) o.o.visible = false; }
    }
    this.stamp(g);
  }
  private lowerHill(d: number) {
    const e = this.worked.get(d); if (!e) return;
    if (e.hill) { this.group.remove(e.hill); e.hill.geometry.dispose(); e.hill = null; }
    if (e.buried.length) {
      const g = this.groups[d];
      for (const p of this.parts) if (e.buried.includes(p.rock)) { p.rock.visible = true; for (const o of p.ore) o.o.visible = !g.userData.dormant; }
      e.buried = []; this.stamp(g);
    }
  }

  /** Sit every deposit on the ground as it is now (villages level the ground, rivers and earthworks change it); one under water is hidden. */
  refit() {
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i], h = this.terrain.heightAt(g.position.x, g.position.z);
      g.position.y = h - 0.15; g.userData.sub = h < 0.3; g.visible = !g.userData.sub && !g.userData.gone && !g.userData.far;
    }
    for (const p of this.parts) {   // each rock rests on the ground right under it, sunk a little so no edge floats
      const gx = p.g.position.x + p.rock.position.x, gz = p.g.position.z + p.rock.position.z, r = p.rock.scale.x * 0.6;
      const ground = Math.min(this.terrain.heightAt(gx, gz), this.terrain.heightAt(gx + r, gz), this.terrain.heightAt(gx - r, gz), this.terrain.heightAt(gx, gz + r), this.terrain.heightAt(gx, gz - r));
      p.rock.position.y = ground - p.g.position.y + p.lift - 0.2;
      for (const c of p.ore) c.o.position.y = p.rock.position.y + c.dy;
    }
    for (const d of this.worked.keys()) this.raiseHill(d);   // the hills follow the ground too
    for (const g of this.groups) this.stamp(g);
    this.flush();
  }

  /** Shrink deposits as they are mined out. */
  sync(flat: Float32Array, asleep?: Uint8Array) {
    let moved = false;
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i];
      let touched = false;
      if (flat[i * 5 + 1] !== this.flat[i * 5 + 1] || flat[i * 5 + 2] !== this.flat[i * 5 + 2]) {   // the model village moves deposits to where its mines need them
        this.flat[i * 5 + 1] = flat[i * 5 + 1]; this.flat[i * 5 + 2] = flat[i * 5 + 2]; g.position.x = flat[i * 5 + 1]; g.position.z = flat[i * 5 + 2]; touched = true; moved = true; if (this.worked.has(i)) this.release(i);
      }
      const rem = flat[i * 5 + 3], max = flat[i * 5 + 4], f = max > 0 ? rem / max : 0;
      const dormant = asleep?.[i] === 1;
      { const sc = dormant ? 0.45 + 0.15 * Math.min(1, f / 0.15) : 0.55 + 0.45 * f; if (g.scale.x !== sc) { g.scale.setScalar(sc); touched = true; } }
      if (!!g.userData.dormant !== dormant) { this.setDormant(i, dormant); touched = true; }
      const gone = max <= 0;   // cleared by the villagers
      if (!!g.userData.gone !== gone) { g.userData.gone = gone; g.visible = !g.userData.sub && !g.userData.gone && !g.userData.far; touched = true; }
      if (touched) this.stamp(g);
    }
    if (moved) this.refit(); else this.flush();
  }

  /** A dormant deposit is drawn dried up: grey rock, no ore sparkle; it comes back to life when it wakes. */
  private setDormant(d: number, on: boolean) {
    const g = this.groups[d]; g.userData.dormant = on;
    if (this.worked.has(d)) this.release(d);   // (the worked tint is put back by the next attach)
    for (const p of this.parts) {
      if (p.g !== g) continue;
      p.rock.userData.dormant = on; this.shade(p.rock);
      for (const c of p.ore) c.o.visible = !on;
    }
  }

  get count() { return this.groups.length; }
  get raw() { return this.flat; }
}

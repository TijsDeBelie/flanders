import * as THREE from 'three';
import { terrain_land_rows, type World } from '../wasm/game_core.js';
import { patchWater, waterNormalTexture, type WaterSurface } from './water';
import { freeze } from './static';
import { groundDetailTexture, patchGround } from './groundtex';
import { renderedRiverAt, riverFootprint, riverGrid, riverStageAt, seaGrid, triangleHeight } from './rivergrid';

export const HALF = 1200;
export const STEP = 2.5;
export const NV = Math.round((HALF * 2) / STEP) + 1; // vertices per side

function waterGeometry({ positions, indices }: { positions: number[]; indices: number[] }) {
  const geometry = new THREE.BufferGeometry();
  const normals = new Float32Array(positions.length);
  const uv = new Float32Array(positions.length / 3 * 2);
  for (let i = 0, k = 0; i < positions.length; i += 3, k += 2) {
    normals[i + 1] = 1;
    uv[k] = positions[i];
    uv[k + 1] = positions[i + 2];
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  return geometry;
}

function grainTexture() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d')!, img = g.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const v = 190 + Math.random() * 65; // mostly bright; multiplies the vertex colour
    img.data.set([v, v, v, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  // soft blotches
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(${Math.random() > 0.5 ? '255,255,255' : '120,120,120'},0.06)`;
    g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 6 + Math.random() * 22, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

const C = (hex: number) => new THREE.Color(hex);
const char = C(0x15110e), ash = C(0x3a3430), sand = C(0xd9c58c), wet = C(0x8f8363), grassA = C(0x5f8a3a), grassB = C(0x7a9a45), grassDry = C(0x9a9a52), forest = C(0x3f6a33), dirt = C(0x8a6b45),
  rock = C(0x7d7872), rockDark = C(0x5d5a56), snow = C(0xf2f5f8), hillGrass = C(0x6f8446);

/** A walkable surface above the ground: a straight strip from (ax, az) to (bx, bz), `half` wide on each side, at height ya at the start and yb at the end. */
export interface Deck { ax: number; az: number; bx: number; bz: number; half: number; ya: number; yb: number; minx: number; maxx: number; minz: number; maxz: number }
export const deck = (ax: number, az: number, bx: number, bz: number, half: number, ya: number, yb: number): Deck => ({ ax, az, bx, bz, half, ya, yb, minx: Math.min(ax, bx) - half, maxx: Math.max(ax, bx) + half, minz: Math.min(az, bz) - half, maxz: Math.max(az, bz) + half });

export class Terrain {
  scorch: Float32Array = new Float32Array(0); // burnt ground discs [x, z, r, ...] from every village
  heights: Float32Array;       // current (with pads, with coast drop)
  private heightBits: Uint32Array;   // the same memory read as bits, for `heightsHash`
  base: Float32Array;          // base terrain
  private riverStages: Float32Array;
  private riverCells: Uint8Array;
  /** The ground, cut into square chunks that share one set of vertices: each chunk is culled on its own when it is off screen. */
  mesh: THREE.Group;
  private chunks: { mesh: THREE.Mesh; i0: number; j0: number; i1: number; j1: number; lods: THREE.BufferAttribute[]; lod: number; cx: number; cz: number }[] = [];
  water: THREE.Mesh;
  riverWater = new THREE.Group();
  riverMaterial: THREE.MeshPhysicalMaterial;
  geo: THREE.PlaneGeometry;
  /** Ground height, one texel per vertex (half floats): the water shader reads it to tell how deep the water is, so shallows are pale and the shore foams. */
  heightTex!: THREE.DataTexture; private heightData!: Uint16Array; private heightAt0 = -1;
  private dirtyHeightRows = new Map<number, [number, number]>();
  onHeightChange?: (x0: number, z0: number, x1: number, z1: number) => void;
  readonly waterTime = { value: 0 };
  private tide = { value: 0 };
  readonly waterTex = waterNormalTexture();
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private nor: THREE.BufferAttribute;

  /** `rawLand` interleaves ground heights and river surface levels from the core. */
  constructor(seed: bigint, rawLand?: Float32Array) {
    const raw = rawLand ?? terrain_land_rows(seed, -HALF, -HALF, NV, STEP, 0, NV);
    this.base = new Float32Array(NV * NV);
    this.heights = new Float32Array(NV * NV); this.heightBits = new Uint32Array(this.heights.buffer);
    this.riverStages = new Float32Array(NV * NV);
    for (let k = 0; k < this.base.length; k++) {
      this.base[k] = this.heights[k] = raw[k * 2];
      this.riverStages[k] = raw[k * 2 + 1];
    }
    this.geo = new THREE.PlaneGeometry(HALF * 2, HALF * 2, NV - 1, NV - 1);
    this.geo.rotateX(-Math.PI / 2);
    this.pos = this.geo.attributes.position as THREE.BufferAttribute;
    this.nor = this.geo.attributes.normal as THREE.BufferAttribute;
    this.col = new THREE.BufferAttribute(new Float32Array(NV * NV * 3), 3);
    for (const attr of [this.pos, this.nor, this.col]) attr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('color', this.col);
    const uv = this.geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (HALF * 0.4583), uv.getY(i) * (HALF * 0.4583));
    this.updateRegion(0, 0, NV - 1, NV - 1);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grainTexture(), roughness: 0.96, metalness: 0 });
    patchGround(mat, groundDetailTexture());
    this.mesh = new THREE.Group();
    const CH = 64;   // cells per chunk side
    for (let j0 = 0; j0 < NV - 1; j0 += CH) for (let i0 = 0; i0 < NV - 1; i0 += CH) {
      const i1 = Math.min(NV - 1, i0 + CH), j1 = Math.min(NV - 1, j0 + CH);
      // three index buffers over the same vertices: every cell, every second cell, every fourth cell (the far ground is drawn from the coarser ones, see `setLod`)
      const lods = [1, 2, 4].map(s => {
        const idx: number[] = [];
        for (let j = j0; j < j1; j += s) for (let i = i0; i < i1; i += s) {
          const i2 = Math.min(i1, i + s), j2 = Math.min(j1, j + s);
          const a = i + NV * j, b = i + NV * j2, c = i2 + NV * j2, d = i2 + NV * j; idx.push(a, b, d, b, c, d);
        }
        return new THREE.BufferAttribute(NV * NV > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1);
      });
      const g = new THREE.BufferGeometry(); for (const [name, attr] of Object.entries(this.geo.attributes)) g.setAttribute(name, attr);
      g.setIndex(lods[0]);
      const m = new THREE.Mesh(g, mat); m.receiveShadow = true; this.mesh.add(m);
      this.chunks.push({ mesh: m, i0, j0, i1, j1, lods, lod: 0, cx: -HALF + ((i0 + i1) / 2) * STEP, cz: -HALF + ((j0 + j1) / 2) * STEP });
    }
    this.fitChunks(0, 0, NV - 1, NV - 1);
    // The grid geometry only lends its vertex attributes to the chunks, which each draw from their own index buffers: its own index (5.5 million entries, 22 MB as
    // Uint32) is never drawn or read, and on an iPad that much memory counts (Safari takes WebGL away from a page that uses too much).
    this.geo.setIndex(null);

    this.heightData = new Uint16Array(NV * NV);
    this.heightTex = new THREE.DataTexture(this.heightData, NV, NV, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter; this.heightTex.generateMipmaps = false;
    this.uploadHeights();
    // The sea extends past the camera's far plane and leaves room for each river surface.
    const footprint = this.riverCells = riverFootprint(this.riverStages, NV);
    this.water = new THREE.Mesh(waterGeometry(seaGrid(footprint, NV, STEP, 6000)), this.makeWaterMaterial('sea'));
    this.riverMaterial = this.makeWaterMaterial('river');
    for (const { i0, j0, i1, j1 } of this.chunks) {
      const surface = riverGrid(this.riverStages, footprint, NV, STEP, i0, j0, i1, j1);
      if (surface.indices.length === 0) continue;
      const river = new THREE.Mesh(waterGeometry(surface), this.riverMaterial);
      river.renderOrder = this.water.renderOrder + 1;
      this.riverWater.add(freeze(river));
    }
    // none of the ground or river water moves (heights change in the vertex data, not the transforms): frozen, the 225 chunks no longer recompute their matrices every frame
    freeze(this.mesh, this.riverWater); for (const { mesh } of this.chunks) freeze(mesh);
  }

  /** A water surface material: shaded by how deep the water is over the ground (see water.ts). The sea and the water of the moats share it. Reflections are kept gentle: a
   *  full mirror coat turned every bridge and wall into a bright glare on the water. */
  makeWaterMaterial(surface: WaterSurface) {
    const solid = surface === 'channel';
    const wm = new THREE.MeshPhysicalMaterial({
      color: 0x2c6f86, roughness: 0.12, metalness: 0, transparent: !solid, opacity: 1, depthWrite: surface !== 'sea',
      depthFunc: solid ? THREE.LessEqualDepth : THREE.LessDepth,
      normalMap: this.waterTex, normalScale: new THREE.Vector2(0.7, 0.7), clearcoat: 0.35, clearcoatRoughness: 0.22, envMapIntensity: 0.8,
    });
    patchWater(wm, { heightTex: this.heightTex, half: HALF, step: STEP, nv: NV }, surface, this.waterTime, this.tide);
    return wm;
  }

  setTide(level: number) {
    this.water.position.y = this.tide.value = level;
  }

  /** Surfaces people and soldiers can stand on above the ground: the decks of bridges and lowered drawbridges. `owner` is whoever registers them (a village). */
  private decks = new Map<unknown, Deck[]>();
  private deckCells = new Map<number, Deck[]>();
  private deckKey(i: number, j: number) { return i * 4096 + j; }
  setDecks(owner: unknown, list: Deck[]) {
    const old = this.decks.get(owner);
    if (old?.length === list.length && old.every((d, i) => {
      const q = list[i];
      return d.ax === q.ax && d.az === q.az && d.bx === q.bx && d.bz === q.bz && d.half === q.half && d.ya === q.ya && d.yb === q.yb;
    })) return;
    if (list.length) this.decks.set(owner, list); else this.decks.delete(owner);
    this.deckCells.clear();
    for (const list of this.decks.values()) for (const d of list) {
      for (let i = Math.floor(d.minx / 16); i <= Math.floor(d.maxx / 16); i++) {
        for (let j = Math.floor(d.minz / 16); j <= Math.floor(d.maxz / 16); j++) {
          const k = this.deckKey(i, j);
          let cell = this.deckCells.get(k);
          if (!cell) this.deckCells.set(k, cell = []);
          cell.push(d);
        }
      }
    }
  }
  /** The height somebody standing at this spot stands at: the ground, or a deck if one is under their feet (a deck over water is far above the bed of the ditch under it). */
  walkAt(x: number, z: number): number {
    return this.deckHeight(x, z, this.heightAt(x, z));
  }

  private deckHeight(x: number, z: number, y: number) {
    if (!this.deckCells.size) return y;
    const list = this.deckCells.get(this.deckKey(Math.floor(x / 16), Math.floor(z / 16)));
    if (!list) return y;
    for (const d of list) {
      if (x < d.minx || x > d.maxx || z < d.minz || z > d.maxz) continue;
      const dx = d.bx - d.ax, dz = d.bz - d.az, l2 = dx * dx + dz * dz || 1, t = ((x - d.ax) * dx + (z - d.az) * dz) / l2;
      if (t < 0 || t > 1) continue;
      if ((x - (d.ax + dx * t)) ** 2 + (z - (d.az + dz * t)) ** 2 > d.half ** 2) continue;
      const dy = d.ya + (d.yb - d.ya) * t; if (dy > y) y = dy;
    }
    return y;
  }

  /** Somebody standing just beside a deck (on the bank that falls away to the water) is drawn onto the deck's edge: returns where, or null when no deck is within `margin` of them.
   *  Without this, the soft pushing between marching soldiers puts some of them on the slope beside the bridge, from which they pop up onto the deck. */
  snapToDeck(x: number, z: number, margin = 1.3): [number, number] | null {
    for (const list of this.decks.values()) for (const d of list) {
      if (x < d.minx - margin || x > d.maxx + margin || z < d.minz - margin || z > d.maxz + margin) continue;
      const dx = d.bx - d.ax, dz = d.bz - d.az, l2 = dx * dx + dz * dz || 1, t = ((x - d.ax) * dx + (z - d.az) * dz) / l2;
      if (t < 0.02 || t > 0.98) continue;
      const cx = d.ax + dx * t, cz = d.az + dz * t, off = Math.hypot(x - cx, z - cz);
      if (off <= d.half - 0.2 || off > d.half + margin) continue;
      const k = (d.half - 0.3) / off; return [cx + (x - cx) * k, cz + (z - cz) * k];
    }
    return null;
  }

  riverSurfaceAt(x: number, z: number) { return riverStageAt(this.riverStages, NV, STEP, x, z); }
  renderedWaterAt(x: number, z: number, tide = this.tide.value) {
    return renderedRiverAt(this.riverStages, this.riverCells, NV, STEP, x, z, tide);
  }

  /** Is this spot under water with no bridge or lowered drawbridge deck over it? */
  wetAt(x: number, z: number): boolean {
    const ground = this.heightAt(x, z);
    const surface = Math.max(0.25, this.riverSurfaceAt(x, z));
    return ground < surface && this.deckHeight(x, z, ground) < surface;
  }

  animate(t: number, realTime = t) {
    this.waterTime.value = t;
    if (this.dirtyHeightRows.size && realTime - this.heightAt0 > 0.4) this.uploadHeights(realTime);
  }

  /** Copy the current ground heights into the depth texture. */
  private uploadHeights(t = 0) {
    if (this.heightAt0 < 0) {
      for (let k = 0; k < this.heights.length; k++) this.heightData[k] = THREE.DataUtils.toHalfFloat(this.heights[k]);
    } else {
      for (const [row, [lo, hi]] of this.dirtyHeightRows) {
        for (let k = row * NV + lo; k <= row * NV + hi; k++) this.heightData[k] = THREE.DataUtils.toHalfFloat(this.heights[k]);
      }
    }
    this.dirtyHeightRows.clear(); this.heightTex.needsUpdate = true; this.heightAt0 = t;
  }

  /** Recompute vertices in grid index rectangle [i0,i1]x[j0,j1] from heights (and refresh colours/normals). */
  updateRegion(i0: number, j0: number, i1: number, j1: number) {
    i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(NV - 1, i1); j1 = Math.min(NV - 1, j1);
    const H = this.heights;
    const at = (i: number, j: number) => H[Math.min(NV - 1, Math.max(0, j)) * NV + Math.min(NV - 1, Math.max(0, i))];
    const col = new THREE.Color();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * NV + i, h = H[k];
      this.pos.setY(k, h);
      const nx = at(i - 1, j) - at(i + 1, j), nz = at(i, j - 1) - at(i, j + 1);
      const invLength = 1 / Math.sqrt(nx * nx + 4 * STEP * STEP + nz * nz), ny = 2 * STEP * invLength;
      this.nor.setXYZ(k, nx * invLength, ny, nz * invLength);
      const slope = 1 - ny; // 0 flat
      const x = -HALF + i * STEP, z = -HALF + j * STEP;
      const noise = Math.sin(x * 0.11) * Math.cos(z * 0.13) * 0.5 + Math.sin(x * 0.31 + z * 0.23) * 0.25 + Math.sin(x * 0.047 - z * 0.061) * 0.5;
      // base ground colour
      col.copy(grassA).lerp(grassB, THREE.MathUtils.clamp(0.5 + noise * 0.5, 0, 1));
      col.lerp(grassDry, THREE.MathUtils.smoothstep(noise, 0.2, 1) * 0.45);
      col.lerp(hillGrass, THREE.MathUtils.smoothstep(h, 10, 30) * 0.7);
      // meadows darken under forests (approximate with a noise band)
      col.lerp(forest, THREE.MathUtils.smoothstep(Math.sin(x * 0.018 + 1) * Math.cos(z * 0.021) + noise * 0.15, 0.25, 0.7) * 0.35 * (h > 1.5 ? 1 : 0));
      // shore
      col.lerp(sand, 1 - THREE.MathUtils.smoothstep(h, 0.5, 1.7));
      col.lerp(wet, (1 - THREE.MathUtils.smoothstep(h, -0.4, 0.5)) * 0.9);
      // rock on slopes and peaks
      const rockAmt = THREE.MathUtils.smoothstep(slope, 0.1, 0.24) + THREE.MathUtils.smoothstep(h, 40, 62) * 0.5;
      col.lerp(noise > 0.2 ? rock : rockDark, THREE.MathUtils.clamp(rockAmt, 0, 1) * 0.92);
      // snow
      col.lerp(snow, THREE.MathUtils.smoothstep(h + noise * 6 - slope * 30, 66, 82));
      // burnt ground
      for (let q = 0; q < this.scorch.length; q += 3) {
        const sx = x - this.scorch[q], sz = z - this.scorch[q + 1], sr = this.scorch[q + 2];
        if (Math.abs(sx) > sr || Math.abs(sz) > sr) continue;
        const d = Math.hypot(sx, sz), edge = sr * (0.8 + 0.2 * Math.sin(Math.atan2(sz, sx) * 5 + q));
        if (d < edge) { const a = 1 - THREE.MathUtils.smoothstep(d, edge * 0.45, edge); col.lerp(d < edge * 0.5 ? char : ash, Math.min(1, a * 1.3) * 0.92); }
      }
      // levelled building ground turns to packed earth
      const diff = Math.abs(h - this.base[k]);
      if (diff > 0.04) col.lerp(dirt, Math.min(1, diff * 0.9 + 0.35) * 0.8);
      this.col.setXYZ(k, col.r * 1.18, col.g * 1.18, col.b * 1.18);
    }
    this.pos.needsUpdate = this.nor.needsUpdate = this.col.needsUpdate = true;
    for (const attr of [this.pos, this.nor, this.col]) {
      if (i0 === 0 && i1 === NV - 1) attr.addUpdateRange(j0 * NV * 3, (j1 - j0 + 1) * NV * 3);
      else for (let j = j0; j <= j1; j++) attr.addUpdateRange((j * NV + i0) * 3, (i1 - i0 + 1) * 3);
    }
    if (this.chunks.length) this.fitChunks(i0, j0, i1, j1);
  }

  /** Far ground is drawn from coarser index buffers (every second or fourth cell): the triangles of a distant chunk are too small to see. Near the camera nothing changes. */
  setLod(x: number, z: number) {
    for (const c of this.chunks) {
      const d = Math.hypot(c.cx - x, c.cz - z), want = d < 380 ? 0 : d < 800 ? 1 : 2;
      if (want !== c.lod && (want > c.lod || d < (c.lod === 2 ? 760 : 350))) { c.lod = want; c.mesh.geometry.setIndex(c.lods[want]); }
    }
  }

  /** Re-measure the chunks touched by an edit so culling stays right (a sphere round the highest and lowest ground in the chunk). */
  private fitChunks(i0: number, j0: number, i1: number, j1: number) {
    for (const c of this.chunks) {
      if (c.i1 < i0 || c.i0 > i1 || c.j1 < j0 || c.j0 > j1) continue;
      let lo = 1e9, hi = -1e9; for (let j = c.j0; j <= c.j1; j++) for (let i = c.i0; i <= c.i1; i++) { const h = this.heights[j * NV + i]; if (h < lo) lo = h; if (h > hi) hi = h; }
      const w = (c.i1 - c.i0) * STEP, d = (c.j1 - c.j0) * STEP, cx = -HALF + (c.i0 + c.i1) / 2 * STEP, cz = -HALF + (c.j0 + c.j1) / 2 * STEP;
      c.mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, (lo + hi) / 2, cz), Math.hypot(w / 2, d / 2, (hi - lo) / 2) + 1);
    }
  }

  /** Apply core heights (with building pads) around a world-space disc. */
  refresh(world: World, cx: number, cz: number, radius: number, others: { x: number; z: number }[] = []) {
    this.refreshBox(world, cx - radius, cz - radius, cx + radius, cz + radius, cx, cz, others);
  }

  /** Re-read the ground from the core inside a rectangle of the world (x0, z0)-(x1, z1). `cx`, `cz` is the village it belongs to: where another village is nearer a point, that point is not ours. */
  refreshBox(world: World, x0: number, z0: number, x1: number, z1: number, cx: number, cz: number, others: { x: number; z: number }[] = []) {
    this.clearPreview();
    const i0 = Math.floor((x0 + HALF) / STEP), i1 = Math.ceil((x1 + HALF) / STEP);
    const j0 = Math.floor((z0 + HALF) / STEP), j1 = Math.ceil((z1 + HALF) / STEP);
    const a = Math.max(0, i0), b = Math.max(0, j0), c = Math.min(NV - 1, i1), d = Math.min(NV - 1, j1);
    if (c < a || d < b) return;
    const nx = c - a + 1, ny = d - b + 1;
    const out = world.terrain_region(-HALF + a * STEP, -HALF + b * STEP, nx, ny, STEP);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = (b + j) * NV + (a + i);
      const x = -HALF + (a + i) * STEP, z = -HALF + (b + j) * STEP;
      if (others.length) { const own = (x - cx) ** 2 + (z - cz) ** 2; if (others.some(o => (x - o.x) ** 2 + (z - o.z) ** 2 < own)) continue; }
      const height = out[j * nx + i];
      if (this.heights[k] === height) continue;
      this.heights[k] = height;
      minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
      const row = b + j, col = a + i, dirty = this.dirtyHeightRows.get(row);
      if (dirty) { dirty[0] = Math.min(dirty[0], col); dirty[1] = Math.max(dirty[1], col); }
      else this.dirtyHeightRows.set(row, [col, col]);
    }
    this.updateRegion(a - 1, b - 1, c + 1, d + 1);
    // A changed vertex affects neighbouring triangles and the forest's 1.5-unit slope probes.
    if (minX <= maxX) this.onHeightChange?.(minX - STEP - 1.5, minZ - STEP - 1.5, maxX + STEP, maxZ + STEP);
  }

  private preview: Map<number, number> | null = null;
  private previewBox: [number, number, number, number] | null = null;

  /** Temporarily level the ground where a building is about to be placed, exactly as the core will, so the ghost sits on it. */
  setPreview(x: number, z: number, inner: number, padH: number) {
    this.clearPreview();
    const outer = inner + 3.5;
    const i0 = Math.max(0, Math.floor((x - outer + HALF) / STEP)), i1 = Math.min(NV - 1, Math.ceil((x + outer + HALF) / STEP));
    const j0 = Math.max(0, Math.floor((z - outer + HALF) / STEP)), j1 = Math.min(NV - 1, Math.ceil((z + outer + HALF) / STEP));
    const saved = new Map<number, number>();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const vx = -HALF + i * STEP, vz = -HALF + j * STEP, d = Math.hypot(vx - x, vz - z);
      if (d >= outer) continue;
      const k = j * NV + i, t = Math.min(1, Math.max(0, (d - inner) / (outer - inner))), w = 1 - t * t * (3 - 2 * t);
      saved.set(k, this.heights[k]); this.heights[k] = this.heights[k] + (padH - this.heights[k]) * w;
    }
    this.preview = saved; this.previewBox = [i0, j0, i1, j1];
    this.updateRegion(i0, j0, i1, j1);
  }

  clearPreview() {
    if (!this.preview || !this.previewBox) return;
    for (const [k, h] of this.preview) this.heights[k] = h;
    const [a, b, c, d] = this.previewBox; this.preview = null; this.previewBox = null;
    this.updateRegion(a, b, c, d);
  }

  /** Drop all building pads (used when a village moves to a new origin). */
  /** The natural (unedited) height at a point: sea and lakes are where this is below zero. */
  baseAt(x: number, z: number) {
    const i = Math.min(NV - 1, Math.max(0, Math.round((x + HALF) / STEP))), j = Math.min(NV - 1, Math.max(0, Math.round((z + HALF) / STEP)));
    return this.base[j * NV + i];
  }

  resetPads() {
    this.preview = this.previewBox = null; this.heights.set(this.base); this.updateRegion(0, 0, NV - 1, NV - 1);
    for (let j = 0; j < NV; j++) this.dirtyHeightRows.set(j, [0, NV - 1]);
    this.onHeightChange?.(-HALF, -HALF, HALF, HALF);
  }

  /** Height on the same two triangles the renderer uses, optionally ignoring a temporary placement preview. */
  heightAt(x: number, z: number, committed = false) {
    const fx = (x + HALF) / STEP, fz = (z + HALF) / STEP;
    const i = Math.min(NV - 2, Math.max(0, Math.floor(fx))), j = Math.min(NV - 2, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j)), H = this.heights;
    const p = committed ? this.preview : null, k = j * NV + i;
    const a = p?.get(k) ?? H[k], b = p?.get(k + 1) ?? H[k + 1], c = p?.get(k + NV) ?? H[k + NV], d = p?.get(k + NV + 1) ?? H[k + NV + 1];
    return triangleHeight(a, b, c, d, tx, tz);
  }

  /** A fingerprint of the ground heights that `heightAt` reads for points in this rectangle: it is the same until some height there changes. */
  heightsHash(x0: number, z0: number, x1: number, z1: number): number {
    const i0 = Math.max(0, Math.floor((x0 + HALF) / STEP) - 1), i1 = Math.min(NV - 1, Math.floor((x1 + HALF) / STEP) + 2);
    const j0 = Math.max(0, Math.floor((z0 + HALF) / STEP) - 1), j1 = Math.min(NV - 1, Math.floor((z1 + HALF) / STEP) + 2);
    const bits = this.heightBits; let h = 0x811c9dc5;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) h = Math.imul(h ^ bits[j * NV + i], 0x01000193);
    return h >>> 0;
  }

  /** Pick committed terrain so a placement preview cannot move the ground under its own pointer. */
  pick(ray: THREE.Ray): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    let t = 0, prev = 0;
    const max = 900;
    let above = true;
    for (; t < max; t += 1.5) {
      ray.at(t, p);
      if (Math.abs(p.x) > HALF || Math.abs(p.z) > HALF) { prev = t; continue; }
      const h = this.heightAt(p.x, p.z, true);
      if (p.y < h) { above = false; break; }
      prev = t;
    }
    if (above) return null;
    let lo = prev, hi = t;
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) / 2; ray.at(m, p);
      if (p.y < this.heightAt(p.x, p.z, true)) hi = m; else lo = m;
    }
    ray.at(hi, p);
    return p.clone();
  }
}

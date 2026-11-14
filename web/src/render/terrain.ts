import * as THREE from 'three';
import { terrain_grid, type World } from '../wasm/game_core.js';
import { patchWater, waterNormalTexture } from './water';

export const HALF = 1200;
export const STEP = 2.5;
export const NV = Math.round((HALF * 2) / STEP) + 1; // vertices per side

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

export class Terrain {
  scorch: Float32Array = new Float32Array(0); // burnt ground discs [x, z, r, ...] from every village
  heights: Float32Array;       // current (with pads, with coast drop)
  base: Float32Array;          // base terrain
  mesh: THREE.Mesh;
  water: THREE.Mesh;
  geo: THREE.PlaneGeometry;
  /** Ground height, one texel per vertex (half floats): the water shader reads it to tell how deep the water is, so shallows are pale and the shore foams. */
  heightTex!: THREE.DataTexture; private heightData!: Uint16Array; private heightDirty = false; private heightAt0 = -1;
  readonly waterTime = { value: 0 };
  readonly waterTex = waterNormalTexture();
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private nor: THREE.BufferAttribute;

  constructor(seed: bigint) {
    const raw = terrain_grid(seed, -HALF, -HALF, NV, NV, STEP);
    this.base = new Float32Array(NV * NV);
    this.heights = new Float32Array(NV * NV);
    for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
      const k = j * NV + i, x = -HALF + i * STEP, z = -HALF + j * STEP;
      this.base[k] = this.heights[k] = raw[k];   // the core shapes the coast itself: what is drawn is exactly what the simulation sees
    }
    this.geo = new THREE.PlaneGeometry(HALF * 2, HALF * 2, NV - 1, NV - 1);
    this.geo.rotateX(-Math.PI / 2);
    this.pos = this.geo.attributes.position as THREE.BufferAttribute;
    this.nor = this.geo.attributes.normal as THREE.BufferAttribute;
    this.col = new THREE.BufferAttribute(new Float32Array(NV * NV * 3), 3);
    this.geo.setAttribute('color', this.col);
    const uv = this.geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (HALF * 0.4583), uv.getY(i) * (HALF * 0.4583));
    this.updateRegion(0, 0, NV - 1, NV - 1);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grainTexture(), roughness: 0.96, metalness: 0 });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.receiveShadow = true;

    this.heightData = new Uint16Array(NV * NV);
    this.heightTex = new THREE.DataTexture(this.heightData, NV, NV, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.LinearFilter; this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping; this.heightTex.generateMipmaps = false;
    this.uploadHeights();
    const wm = new THREE.MeshPhysicalMaterial({
      color: 0x2c6f86, roughness: 0.05, metalness: 0, transparent: true, opacity: 1, depthWrite: false,
      normalMap: this.waterTex, normalScale: new THREE.Vector2(0.7, 0.7), clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.8,
    });
    patchWater(wm, { heightTex: this.heightTex, half: HALF, step: STEP, nv: NV }, this.waterTime, false);
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), wm);
    this.water.position.y = 0;
  }

  animate(t: number) {
    this.waterTime.value = t;
    if (this.heightDirty && t - this.heightAt0 > 0.4) this.uploadHeights(t);   // building changes the ground; refresh the depth texture a few times a second at most
  }

  /** Copy the current ground heights into the depth texture. */
  private uploadHeights(t = 0) {
    for (let k = 0; k < this.heights.length; k++) this.heightData[k] = THREE.DataUtils.toHalfFloat(this.heights[k]);
    this.heightTex.needsUpdate = true; this.heightDirty = false; this.heightAt0 = t;
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
      const n = new THREE.Vector3(nx, 2 * STEP, nz).normalize();
      this.nor.setXYZ(k, n.x, n.y, n.z);
      const slope = 1 - n.y; // 0 flat
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
    if (i0 === 0 && j0 === 0 && i1 === NV - 1) { this.geo.computeBoundingSphere(); this.geo.computeBoundingBox(); }
  }

  /** Apply core heights (with building pads) around a world-space disc. */
  refresh(world: World, cx: number, cz: number, radius: number, others: { x: number; z: number }[] = []) {
    this.clearPreview();
    const i0 = Math.floor((cx - radius + HALF) / STEP), i1 = Math.ceil((cx + radius + HALF) / STEP);
    const j0 = Math.floor((cz - radius + HALF) / STEP), j1 = Math.ceil((cz + radius + HALF) / STEP);
    const a = Math.max(0, i0), b = Math.max(0, j0), c = Math.min(NV - 1, i1), d = Math.min(NV - 1, j1);
    const nx = c - a + 1, ny = d - b + 1;
    const out = world.terrain_region(-HALF + a * STEP, -HALF + b * STEP, nx, ny, STEP);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = (b + j) * NV + (a + i);
      const x = -HALF + (a + i) * STEP, z = -HALF + (b + j) * STEP;
      if (others.length) { const own = Math.hypot(x - cx, z - cz); if (others.some(o => Math.hypot(x - o.x, z - o.z) < own)) continue; } // belongs to a neighbouring village
      this.heights[k] = out[j * nx + i]; this.heightDirty = true;
    }
    this.updateRegion(a - 1, b - 1, c + 1, d + 1);
  }

  private preview: { k: number; h: number }[] | null = null;
  private previewBox: [number, number, number, number] | null = null;

  /** Temporarily level the ground where a building is about to be placed, exactly as the core will, so the ghost sits on it. */
  setPreview(x: number, z: number, inner: number, padH: number) {
    this.clearPreview();
    const outer = inner + 3.5;
    const i0 = Math.max(0, Math.floor((x - outer + HALF) / STEP)), i1 = Math.min(NV - 1, Math.ceil((x + outer + HALF) / STEP));
    const j0 = Math.max(0, Math.floor((z - outer + HALF) / STEP)), j1 = Math.min(NV - 1, Math.ceil((z + outer + HALF) / STEP));
    const saved: { k: number; h: number }[] = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const vx = -HALF + i * STEP, vz = -HALF + j * STEP, d = Math.hypot(vx - x, vz - z);
      if (d >= outer) continue;
      const k = j * NV + i, t = Math.min(1, Math.max(0, (d - inner) / (outer - inner))), w = 1 - t * t * (3 - 2 * t);
      saved.push({ k, h: this.heights[k] }); this.heights[k] = this.heights[k] + (padH - this.heights[k]) * w;
    }
    this.preview = saved; this.previewBox = [i0, j0, i1, j1];
    this.updateRegion(i0, j0, i1, j1);
  }

  clearPreview() {
    if (!this.preview || !this.previewBox) return;
    for (const p of this.preview) this.heights[p.k] = p.h;
    const [a, b, c, d] = this.previewBox; this.preview = null; this.previewBox = null;
    this.updateRegion(a, b, c, d);
  }

  /** Drop all building pads (used when a village moves to a new origin). */
  /** The natural (unedited) height at a point: sea and lakes are where this is below zero. */
  baseAt(x: number, z: number) {
    const i = Math.min(NV - 1, Math.max(0, Math.round((x + HALF) / STEP))), j = Math.min(NV - 1, Math.max(0, Math.round((z + HALF) / STEP)));
    return this.base[j * NV + i];
  }

  resetPads() { this.preview = null; this.heights.set(this.base); this.updateRegion(0, 0, NV - 1, NV - 1); }

  /** Bilinear visual height. */
  heightAt(x: number, z: number) {
    const fx = (x + HALF) / STEP, fz = (z + HALF) / STEP;
    const i = Math.min(NV - 2, Math.max(0, Math.floor(fx))), j = Math.min(NV - 2, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j)), H = this.heights;
    const a = H[j * NV + i], b = H[j * NV + i + 1], c = H[(j + 1) * NV + i], d = H[(j + 1) * NV + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** Ray vs heightfield by marching, then bisection. */
  pick(ray: THREE.Ray): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    let t = 0, prev = 0;
    const max = 900;
    let above = true;
    for (; t < max; t += 1.5) {
      ray.at(t, p);
      if (Math.abs(p.x) > HALF || Math.abs(p.z) > HALF) { prev = t; continue; }
      const h = this.heightAt(p.x, p.z);
      if (p.y < h) { above = false; break; }
      prev = t;
    }
    if (above) return null;
    let lo = prev, hi = t;
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) / 2; ray.at(m, p);
      if (p.y < this.heightAt(p.x, p.z)) hi = m; else lo = m;
    }
    ray.at(hi, p);
    return p.clone();
  }
}

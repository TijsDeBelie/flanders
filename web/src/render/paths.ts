import * as THREE from 'three';
import type { Terrain } from './terrain';

const S = 10; // buildings_flat stride

function dirtTexture() {
  const s = 128, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d')!;
  g.fillStyle = '#b9a07a'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 900; i++) { const v = Math.random(); g.fillStyle = v > 0.5 ? `rgba(255,240,210,${Math.random() * 0.25})` : `rgba(60,40,20,${Math.random() * 0.3})`; g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 2); }
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(110,100,90,${0.25 + Math.random() * 0.3})`; g.beginPath(); g.ellipse(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 2, Math.random() * 3, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

const TIER_COLOR = [new THREE.Color(0xb59468), new THREE.Color(0xbfb09a), new THREE.Color(0xb7b2a8), new THREE.Color(0xc2beb4)];

/** Dirt tracks between buildings, an apron under every building, and a paved square around the town hall. */
export class Paths {
  group = new THREE.Group();
  private tracks: THREE.Mesh;
  private mat = new THREE.MeshStandardMaterial({ map: dirtTexture(), vertexColors: true, transparent: true, roughness: 1, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });

  private uTick = { value: 1e9 };

  /** The game tick: roads grow in from the village centre over one day (240 ticks) and are paved, slowly, over the days after. */
  setTick(t: number) { this.uTick.value = t; }

  constructor(private terrain: Terrain) {
    this.mat.onBeforeCompile = sh => {
      sh.uniforms.uTick = this.uTick;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aRoad;\nvarying vec3 vRoad;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTick;\nvarying vec3 vRoad;').replace('#include <color_fragment>', `#include <color_fragment>
        float grow = clamp((uTick - vRoad.x) / 240.0, 0.0, 1.0);
        diffuseColor.a *= 1.0 - smoothstep(grow * 1.2 - 0.2, grow * 1.2, vRoad.y);
        float pv = clamp((uTick - vRoad.x - 360.0) / 900.0, 0.0, 1.0) * vRoad.z;
        float paved = (1.0 - smoothstep(pv * 1.15 - 0.15, pv * 1.15, vRoad.y)) * step(0.001, pv);
        vec2 cu = vMapUv * 5.0; float cob = step(0.1, fract(cu.x)) * step(0.1, fract(cu.y + floor(cu.x) * 0.5));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.64, 0.62, 0.58) * (0.78 + 0.22 * cob), paved * 0.92);`);
    };
    this.tracks = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.tracks.receiveShadow = true; this.tracks.renderOrder = 2; this.tracks.frustumCulled = false;
    this.group.add(this.tracks);
  }

  /** Rebuild from the world: buildings_flat (stride 10), roads_flat (stride 6), building radii, hall tier. */
  update(buildings: Float32Array, roads: Float32Array, radii: number[], born: ArrayLike<number> = []) {
    const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [], rd: number[] = [];
    let rb = -1e6, rs = 0, rp = 0;   // the road the next vertices belong to: birth tick, distance from the village end (0..1), paveable
    const hallTier = buildings[1] ?? 0, tone = TIER_COLOR[Math.min(3, hallTier)];
    const y = (x: number, z: number) => this.terrain.heightAt(x, z) + 0.09;
    const vert = (x: number, z: number, a: number, u: number, v: number) => {
      const n = 0.92 + 0.08 * Math.sin(x * 1.7 + z * 2.3);
      pos.push(x, y(x, z), z); col.push(tone.r * n, tone.g * n, tone.b * n, a); uv.push(u, v); rd.push(rb, rs, rp);
      return pos.length / 3 - 1;
    };
    // tracks: ribbons with soft edges, from doorstep to doorstep
    for (let s = 0; s < roads.length; s += 6) {
      const [ax, az, bx, bz] = [roads[s], roads[s + 1], roads[s + 2], roads[s + 3]], child = roads[s + 4], parent = roads[s + 5];
      const kc = buildings[child * S], kp = buildings[parent * S];   
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
      // a route has several stretches: only the first steps back from its child building and the last from its parent
      const atChild = Math.hypot(ax - buildings[child * S + 2], az - buildings[child * S + 3]) < radii[kc] + 1, atParent = Math.hypot(bx - buildings[parent * S + 2], bz - buildings[parent * S + 3]) < radii[kp] + 1;
      // a stretch steps back from a building's walls, but not from a piece of road (they must join up, with no gaps between them)
      const t0 = atChild && kc !== 37 ? radii[kc] * 0.6 : 0, t1 = len - (atParent && kp !== 37 ? radii[kp] * 0.6 : 0);
      if (t1 <= t0 + 0.5) continue;
      const half = hallTier >= 2 ? 1.45 : 1.15, steps = Math.max(2, Math.ceil((t1 - t0) / 1.0));
      rb = Math.max(born[child] ?? 0, born[parent] ?? 0); rp = 1;
      let prev: number[] | null = null;
      for (let i = 0; i <= steps; i++) {
        const t = t0 + ((t1 - t0) * i) / steps, w = 0.12 * Math.sin(t * 0.7 + s) , cx = ax + ux * t - uz * w, cz = az + uz * t + ux * w;
        const nx = -uz, nz = ux, cap = i === 0 || i === steps ? 0.0 : 1; rs = 1 - i / steps;
        const row = [vert(cx + nx * half * 1.6, cz + nz * half * 1.6, 0, 0, t * 0.25), vert(cx, cz, 0.95 * Math.max(cap, 0.85), 0.5, t * 0.25), vert(cx - nx * half * 1.6, cz - nz * half * 1.6, 0, 1, t * 0.25)];
        if (prev) for (let k = 0; k < 2; k++) { idx.push(prev[k], row[k], prev[k + 1], prev[k + 1], row[k], row[k + 1]); }
        prev = row;
      }
    }
    rb = -1e6; rs = 0; rp = 0;
    // aprons under buildings (and the plaza under the hall)
    for (let i = 0; i < buildings.length; i += S) {
      const kind = buildings[i], x = buildings[i + 2], z = buildings[i + 3];
      if (kind === 2 || kind === 21 || kind === 22 || kind === 24 || kind === 32 || kind === 33 || kind === 34 || kind === 37) continue; // walls, fences, gates and moats have no apron
      const isHall = kind === 15, R = isHall ? radii[kind] + 3.8 + hallTier * 0.8 : radii[kind] * 1.05 + 1.0, rings = 5, seg = 28;
      const base = pos.length / 3;
      vert(x, z, 0.95, 0.5, 0.5);
      for (let r = 1; r <= rings; r++) for (let k = 0; k < seg; k++) {
        const a = (k / seg) * Math.PI * 2, rr = (R * r) / rings, fade = r >= rings ? 0 : r === rings - 1 ? 0.55 : 0.95;
        vert(x + Math.cos(a) * rr, z + Math.sin(a) * rr, fade * (isHall ? 1 : 0.85), 0.5 + Math.cos(a) * (r / rings) * 0.5, 0.5 + Math.sin(a) * (r / rings) * 0.5);
      }
      for (let k = 0; k < seg; k++) idx.push(base, base + 1 + k, base + 1 + ((k + 1) % seg));
      for (let r = 1; r < rings; r++) for (let k = 0; k < seg; k++) {
        const a = base + 1 + (r - 1) * seg + k, b = base + 1 + (r - 1) * seg + ((k + 1) % seg), c = a + seg, d = b + seg;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(rd, 3));
    g.setIndex(idx);
    this.tracks.geometry.dispose(); this.tracks.geometry = g;
  }
}

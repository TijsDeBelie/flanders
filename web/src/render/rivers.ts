import * as THREE from 'three';
import { HALF, NV, STEP, type Terrain } from './terrain';
import { patchWater } from './water';

const S = 10, MOAT = 24, RIVER = 32, MAXP = 1500;
/** Radii of the flat bottom of a moat piece (before its width setting) and of a river piece: the same numbers as the core's. */
export const CHANNEL = { moatFloor: 3.0, riverFloor: 2.0, bank: 1.6 };

/** The water level for a sealed channel piece: just under the lowest of the highest ground round it, found on a ring outside the steep bank. Never below the sealed level. */
export function channelLevel(terrain: Terrain, x: number, z: number, floor: number): number {
  const r = floor + CHANNEL.bank + 0.9; let rim = -1e9;
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; rim = Math.max(rim, terrain.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r)); }
  return Math.max(SEALED_LEVEL, rim - 0.35);
}
/** Surface level of water that is sealed off from any sea or lake: it stays full whatever the tide does. */
export const SEALED_LEVEL = 0.04;

/** Is there natural open water (sea or lake) at or near this point? */
export function nearNaturalWater(terrain: Terrain, x: number, z: number, r = 9): boolean {
  if (terrain.baseAt(x, z) < -0.25) return true;
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; if (terrain.baseAt(x + Math.cos(a) * r, z + Math.sin(a) * r) < -0.25) return true; }
  return false;
}

/** Which moat and river pieces are connected to a body of open water? Neighbouring pieces form one channel; a channel that reaches a sea or lake is
 *  connected (its level follows the tide), any other is sealed (it just stays full). */
export function connectedFlags(terrain: Terrain, pts: { x: number; z: number }[]): boolean[] {
  const n = pts.length, parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if ((pts[i].x - pts[j].x) ** 2 + (pts[i].z - pts[j].z) ** 2 < 7.5 * 7.5) parent[find(i)] = find(j);
  const wet = new Map<number, boolean>();
  for (let i = 0; i < n; i++) { const r = find(i); if (!wet.get(r) && nearNaturalWater(terrain, pts[i].x, pts[i].z)) wet.set(r, true); }
  return pts.map((_, i) => !!wet.get(find(i)));
}

/** Flowing water: light ripples that run along every river piece in the direction it was dug, and a flat water surface over any moat or river that is
 *  sealed off from the sea (connected channels show the tidal sea itself). The channel is part of the terrain. */
export class RiverFlow {
  group = new THREE.Group();
  mesh: THREE.InstancedMesh;     // ripples
  private pond: THREE.InstancedMesh;
  private uTime = { value: 0 };
  private sig = '';
  private ripple: { x: number; z: number; connected: boolean; level: number }[] = [];
  private level = 0;

  constructor(private terrain: Terrain) {
    const geo = new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2);
    geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(new Float32Array(2 * MAXP), 2));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime }, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: `attribute vec2 aDir; varying vec2 vDir; varying vec2 vP; varying vec2 vL;
        void main() { vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0); vP = wp.xz; vDir = aDir; vL = position.xz / 3.0; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform float uTime; varying vec2 vDir; varying vec2 vP; varying vec2 vL;
        void main() {
          float along = dot(vP, vDir), across = dot(vP, vec2(-vDir.y, vDir.x));
          float a = smoothstep(0.55, 0.95, sin(along * 1.3 - uTime * 2.6 + sin(across * 0.9) * 1.6));
          float b = smoothstep(0.7, 1.0, sin(along * 2.9 - uTime * 4.1 + across * 1.7)) * 0.7;
          float fade = 1.0 - smoothstep(0.45, 1.0, length(vL));
          gl_FragColor = vec4(0.88, 0.96, 1.0, (a * 0.34 + b * 0.26) * fade);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAXP); this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;
    const pondGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    const pondMat = new THREE.MeshPhysicalMaterial({ color: 0x2f6f98, roughness: 0.05, metalness: 0, transparent: true, opacity: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, normalMap: terrain.waterTex, normalScale: new THREE.Vector2(0.7, 0.7), clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.8 });
    patchWater(pondMat, { heightTex: terrain.heightTex, half: HALF, step: STEP, nv: NV }, terrain.waterTime, true);
    this.pond = new THREE.InstancedMesh(pondGeo, pondMat, MAXP); this.pond.count = 0; this.pond.frustumCulled = false; this.pond.renderOrder = 2;
    this.group.add(this.pond, this.mesh);
  }

  /** From buildings_flat: every river and moat piece. */
  sync(f: Float32Array) {
    const items: { x: number; z: number; rot: number; kind: number }[] = [];
    for (let i = 0; i < f.length; i += S) if (f[i] === RIVER || f[i] === MOAT) items.push({ x: f[i + 2], z: f[i + 3], rot: f[i + 4], kind: f[i] });
    const sig = items.map(q => `${q.kind},${q.x},${q.z},${q.rot}`).join(';'); if (sig === this.sig) return; this.sig = sig;
    const flags = connectedFlags(this.terrain, items), dir = this.mesh.geometry.getAttribute('aDir') as THREE.InstancedBufferAttribute, m = new THREE.Matrix4(), sc = new THREE.Vector3();
    let nr = 0, np = 0; this.ripple = [];
    items.forEach((q, i) => {
      // a channel that is sealed off from the sea is a trench with its water close to the brim: the surface is the lowest of the surrounding land, less a hand's breadth, so the banks
      // are not left standing bare. Where the bank is a step the water sits behind it, and the terrain hides the rest, so it never spills over the edge.
      const floor = q.kind === MOAT ? CHANNEL.moatFloor * (1 + 0.13 * (q.rot & 7)) : CHANNEL.riverFloor, level = flags[i] ? SEALED_LEVEL : channelLevel(this.terrain, q.x, q.z, floor);
      if (q.kind === RIVER && nr < MAXP) { const a = q.rot * Math.PI / 4; dir.setXY(nr, Math.cos(a), -Math.sin(a)); this.ripple.push({ x: q.x, z: q.z, connected: flags[i], level }); nr++; }
      if (!flags[i] && np < MAXP) { const r = floor + 1.1; sc.set(r, 1, r); m.compose(new THREE.Vector3(q.x, level, q.z), new THREE.Quaternion(), sc); this.pond.setMatrixAt(np++, m); }
    });
    this.mesh.count = nr; this.pond.count = np; this.pond.instanceMatrix.needsUpdate = true; dir.needsUpdate = true;
    this.placeRipples(this.level, true);
  }

  private placeRipples(level: number, force = false) {
    if (!force && Math.abs(level - this.level) < 0.004) return; this.level = level;
    const m = new THREE.Matrix4();
    this.ripple.forEach((q, i) => { m.makeTranslation(q.x, (q.connected ? level : q.level) + 0.05, q.z); this.mesh.setMatrixAt(i, m); });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** The tide: connected channels rise and fall with it, sealed ones stay put. */
  setTide(level: number) { this.placeRipples(level); }

  update(t: number) { this.uTime.value = t; }
}

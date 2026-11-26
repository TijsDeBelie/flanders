import * as THREE from 'three';
import type { Terrain } from './terrain';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** A generous view check for emitters, leaving room for their particles to drift in. */
export class EffectView {
  private frustum = new THREE.Frustum();
  private projection = new THREE.Matrix4();
  private sphere = new THREE.Sphere();

  update(camera: THREE.Camera) {
    this.frustum.setFromProjectionMatrix(this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }

  includes(x: number, y: number, z: number, radius: number) {
    this.sphere.center.set(x, y, z); this.sphere.radius = radius;
    return this.frustum.intersectsSphere(this.sphere);
  }
}

/** A packed pool that updates and uploads only living particles. */
export class Particles {
  points: THREE.Points;
  private count = 0; private cursor = 0;
  private pos: Float32Array; private vel: Float32Array; private age: Float32Array; private life: Float32Array;
  private s0: Float32Array; private s1: Float32Array; private rgb: Float32Array; private a0: Float32Array;
  private aPos: THREE.BufferAttribute; private aSize: THREE.BufferAttribute; private aCol: THREE.BufferAttribute;

  constructor(private capacity: number, additive: boolean, private grav = 0, private drag = 0.5, projectionScale = 260) {
    const n = capacity;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.s0 = new Float32Array(n); this.s1 = new Float32Array(n); this.rgb = new Float32Array(n * 3); this.a0 = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aSize', this.aSize); g.setAttribute('aCol', this.aCol);
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { projectionScale: { value: projectionScale } },
      vertexShader: 'uniform float projectionScale; attribute float aSize; attribute vec4 aCol; varying vec4 vC; void main(){ vC=aCol; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=clamp(aSize*projectionScale/max(-mv.z,1.),1.,80.); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'varying vec4 vC; void main(){ float d=length(gl_PointCoord-.5)*2.; float a=smoothstep(1.,.15,d)*vC.a; if(a<.01) discard; gl_FragColor=vec4(vC.rgb,a); }',
    });
    this.points = new THREE.Points(g, mat); this.points.frustumCulled = false; this.points.renderOrder = 5; this.points.visible = false;
  }

  /** Show the (normally hidden) points so their shader is compiled before the first fire. */
  warm(on: boolean) { this.points.visible = on || this.count > 0; }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number) {
    const i = this.count < this.capacity ? this.count++ : this.cursor++ % this.capacity, j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.rgb[j] = r; this.rgb[j + 1] = g; this.rgb[j + 2] = b;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a;
  }

  update(dt: number) {
    if (!this.count) return;
    const drag = 1 - this.drag * dt, gravity = this.grav * dt;
    for (let i = 0; i < this.count;) {
      const a = this.age[i] + dt, j = i * 3;
      if (a >= this.life[i]) {
        const last = --this.count, tail = last * 3;
        if (i < last) {
          this.pos.copyWithin(j, tail, tail + 3);
          this.vel.copyWithin(j, tail, tail + 3);
          this.rgb.copyWithin(j, tail, tail + 3);
          this.age[i] = this.age[last]; this.life[i] = this.life[last];
          this.s0[i] = this.s0[last]; this.s1[i] = this.s1[last]; this.a0[i] = this.a0[last];
        }
        continue;
      }
      this.age[i] = a;
      const u = a / this.life[i];
      for (let k = j; k < j + 3; k++) { this.vel[k] *= drag; this.pos[k] += this.vel[k] * dt; }
      this.vel[j + 1] += gravity;
      this.aSize.setX(i, this.s0[i] + (this.s1[i] - this.s0[i]) * u);
      this.aCol.setXYZW(i, this.rgb[j], this.rgb[j + 1], this.rgb[j + 2], this.a0[i] * (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85));
      i++;
    }
    this.points.geometry.setDrawRange(0, this.count);
    this.points.visible = this.count > 0;
    if (!this.count) return;
    for (const attr of [this.aPos, this.aSize, this.aCol]) {
      attr.clearUpdateRanges(); attr.addUpdateRange(0, this.count * attr.itemSize); attr.needsUpdate = true;
    }
  }
}

/** A flying arrow or stone. Drawn as one instance of `Effects2.arrows` or `.stones` (it used to be a mesh of its own: one draw call per arrow in a volley). */
interface Shot { pos: THREE.Vector3; q: THREE.Quaternion; t: number; dur: number; a: THREE.Vector3; b: THREE.Vector3; arc: number; fire: boolean; stone: boolean; nextTrail: number }

/** Flames, smoke, arrows, stones, dust and fire light. */
export class Effects2 {
  group = new THREE.Group();
  private flames = new Particles(2600, true, 3.0, 0.8);
  private smoke = new Particles(1800, false, 0.8, 0.4);
  private dust = new Particles(500, false, -3, 1.4);
  private shots: Shot[] = [];
  /** The light of the nearest fire. Not in `group` (main.ts adds it to the scene): hiding the particles must not change how many lights the shaders were built for. */
  readonly light = new THREE.PointLight(0xff7a2a, 0, 34, 2);
  private shotPosition = new THREE.Vector3();
  private shotLook = new THREE.Vector3();
  private acc: number[] = [];
  private arrowGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.3, 5).rotateX(Math.PI / 2);
  private arrowMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a });
  private stoneGeo = new THREE.IcosahedronGeometry(0.32, 0);
  private stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a8782, roughness: 1 });
  private arrows = new THREE.InstancedMesh(this.arrowGeo, this.arrowMat, 1024);
  private stones = new THREE.InstancedMesh(this.stoneGeo, this.stoneMat, 128);
  private aim = new THREE.Object3D();
  private t = 0;

  constructor(private terrain: Terrain) {
    this.group.add(this.dust.points, this.smoke.points, this.flames.points);
    for (const m of [this.arrows, this.stones]) {
      m.count = 0; m.visible = false; m.frustumCulled = false; m.castShadow = false; m.matrixAutoUpdate = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(m);
    }
  }

  warm(on: boolean) { this.flames.warm(on); this.smoke.warm(on); this.dust.warm(on); }

  /** Spawn an arrow or a catapult stone flying from a to b. */
  shot(kind: number, x0: number, z0: number, x1: number, z1: number, fire: boolean, y0 = 1.5) {
    const stone = kind === 1;
    const a = new THREE.Vector3(x0, this.terrain.heightAt(x0, z0) + (stone ? 2.4 : y0), z0), b = new THREE.Vector3(x1, this.terrain.heightAt(x1, z1) + (stone ? 0.4 : 1.1), z1);
    const d = a.distanceTo(b);
    this.shots.push({ pos: a.clone(), q: new THREE.Quaternion(), t: 0, dur: Math.max(0.35, d / (stone ? 15 : 30)), a, b, arc: stone ? d * 0.35 : d * 0.08, fire, stone, nextTrail: 0 });
  }

  /** The ogre's slam: a ring of dust and small stones thrown outward from where he struck. */
  slam(x: number, z: number, reach = 3.5) {
    const y = this.terrain.heightAt(x, z) + 0.3;
    for (let i = 0; i < 44; i++) { const a = i / 44 * 6.283 + Math.random() * 0.1, s = reach * (1.2 + Math.random() * 0.8); this.dust.emit(x, y, z, Math.cos(a) * s, 0.6 + Math.random() * 1.4, Math.sin(a) * s, 0.7 + Math.random() * 0.5, 0.8, 2.6, 0.5, 0.42, 0.33, 0.8); }
    for (let i = 0; i < 8; i++) { const a = Math.random() * 6.283, s = 2 + Math.random() * 3; this.dust.emit(x, y, z, Math.cos(a) * s, 3 + Math.random() * 3, Math.sin(a) * s, 0.6, 0.3, 0.15, 0.4, 0.37, 0.33, 1); }
  }

  /** A wall section or siege tower comes down: a column of dust rises, chunks of stone and timber are thrown out, and a pall of smoke hangs over the rubble. */
  collapse(x: number, z: number, reach = 5) {
    const y = this.terrain.heightAt(x, z) + 0.4;
    for (let i = 0; i < 36; i++) { const a = Math.random() * 6.283, s = reach * (0.3 + Math.random() * 0.9); this.dust.emit(x + Math.cos(a) * 0.8, y, z + Math.sin(a) * 0.8, Math.cos(a) * s * 0.5, 3 + Math.random() * 4.5, Math.sin(a) * s * 0.5, 1.6 + Math.random() * 1.4, 0.9, 3.4, 0.5, 0.45, 0.38, 0.75); }
    for (let i = 0; i < 14; i++) { const a = Math.random() * 6.283, s = 2.5 + Math.random() * 4; this.dust.emit(x, y + 0.6, z, Math.cos(a) * s, 4 + Math.random() * 4, Math.sin(a) * s, 0.9 + Math.random() * 0.5, 0.35, 0.2, 0.42, 0.38, 0.33, 1); }
    for (let i = 0; i < 12; i++) this.smoke.emit(x + (Math.random() - 0.5) * 3, y + 0.5, z + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 0.8, 1.2 + Math.random() * 1.4, (Math.random() - 0.5) * 0.8, 3.2 + Math.random() * 1.6, 1.4, 4.2, 0.36, 0.34, 0.32, 0.5);
  }

  /** A siege tower's bridge slams down onto the wall: a short puff of dust along the wall top. */
  dock(x: number, z: number) {
    const y = this.terrain.heightAt(x, z) + 6.5;
    for (let i = 0; i < 16; i++) { const a = Math.random() * 6.283, s = 1 + Math.random() * 2.2; this.dust.emit(x + (Math.random() - 0.5) * 1.6, y, z + (Math.random() - 0.5) * 1.6, Math.cos(a) * s, 0.4 + Math.random() * 1.2, Math.sin(a) * s, 0.7 + Math.random() * 0.5, 0.5, 1.6, 0.55, 0.5, 0.42, 0.65); }
  }

  /** A war horn: a ring of gold light spreading out over the field as far as it spurs the escort on. */
  hornBlast(x: number, z: number, reach = 32) {
    const y = this.terrain.heightAt(x, z) + 1.6, life = 1.1;
    for (let i = 0; i < 70; i++) { const a = i / 70 * 6.283, s = reach / life; this.flames.emit(x, y, z, Math.cos(a) * s * 0.9, 0.2, Math.sin(a) * s * 0.9, life, 1.5, 0.7, 1, 0.78, 0.28, 0.55); }
  }

  /** Embers rising off an enraged boss (call a few times a second). */
  rageSpark(x: number, y: number, z: number) {
    for (let i = 0; i < 3; i++) this.flames.emit(x + (Math.random() - 0.5) * 1.6, y + Math.random() * 1.8, z + (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 0.6, 1.2 + Math.random() * 1.2, (Math.random() - 0.5) * 0.6, 0.7, 0.9, 0.2, 1, 0.18 + Math.random() * 0.2, 0.05, 0.8);
  }

  arrowAt(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y1, z1), d = a.distanceTo(b);
    this.shots.push({ pos: a.clone(), q: new THREE.Quaternion(), t: 0, dur: Math.max(0.3, d / 30), a, b, arc: d * 0.08, fire: false, stone: false, nextTrail: 0 });
  }

  /** A bucket of water thrown onto a burning building: droplets in an arc, then a hiss of steam. */
  waterThrow(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const T = 0.75, g = 3.0;
    for (let i = 0; i < 16; i++) {
      const j = () => (Math.random() - 0.5) * 1.4;
      this.dust.emit(x0, y0, z0, (x1 - x0 + j()) / T, (y1 - y0) / T + 0.5 * g * T + Math.random() * 0.8, (z1 - z0 + j()) / T, T + 0.1, 0.45, 0.25, 0.55, 0.75, 0.95, 0.85);
    }
    setTimeout(() => { for (let i = 0; i < 9; i++) this.smoke.emit(x1 + (Math.random() - 0.5) * 1.4, y1, z1 + (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 0.6, 1.2 + Math.random(), (Math.random() - 0.5) * 0.6, 1.6, 1.0, 3.6, 0.9, 0.92, 0.95, 0.5); }, T * 1000);
  }

  /** A blow landing on a soldier: a few specks of blood and dust at chest height (more when it kills). */
  hit(x: number, y: number, z: number, killed: boolean) {
    const n = killed ? 14 : 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = 0.6 + Math.random() * 1.6;
      this.dust.emit(x, y, z, Math.cos(a) * s, 0.8 + Math.random() * 1.6, Math.sin(a) * s, 0.5 + Math.random() * 0.4, 0.22, 0.5, i % 3 ? 0.6 : 0.5, i % 3 ? 0.08 : 0.4, i % 3 ? 0.06 : 0.3, 0.85);
    }
  }

  burst(x: number, z: number, big = true) {
    const y = this.terrain.heightAt(x, z) + 0.3, n = big ? 40 : 8;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = 1 + Math.random() * 4;
      this.dust.emit(x, y, z, Math.cos(a) * s, 2 + Math.random() * 4, Math.sin(a) * s, 1.2 + Math.random() * 1.2, 1.2, 3.2, 0.45, 0.38, 0.3, 0.7);
      if (big && i % 3 === 0) this.flames.emit(x, y, z, Math.cos(a) * s * 0.5, 2 + Math.random() * 3, Math.sin(a) * s * 0.5, 0.6, 1.4, 0.4, 1, 0.55, 0.15, 0.9);
    }
  }

  /** Update fires. `fires` is World.fires_flat(): [kind, x, y, r] per fire. `camera` picks which fires cast light. */
  update(dt: number, fires: Float32Array, camPos: THREE.Vector3, view?: EffectView) {
    this.t += dt;
    const enabled = this.group.visible, nf = enabled ? fires.length / 4 : 0;
    let closest = Infinity, lit = -1, litY = 0;
    this.acc.length = nf;
    for (let i = 0; i < nf; i++) {
      const kind = fires[i * 4], x = fires[i * 4 + 1], z = fires[i * 4 + 2], r = fires[i * 4 + 3];
      const gy = this.terrain.heightAt(x, z);
      if (view && !view.includes(x, gy + 5, z, r + 34)) { this.acc[i] = 0; continue; }
      const dist2 = (x - camPos.x) ** 2 + (gy - camPos.y) ** 2 + (z - camPos.z) ** 2;
      if (dist2 < closest) { closest = dist2; lit = i; litY = gy; }
      const rate = (kind === 0 ? 70 : 24 + r * 8) * Math.min(1, 150 / Math.sqrt(dist2));
      this.acc[i] = (this.acc[i] ?? 0) + rate * dt;
      while (this.acc[i] >= 1) {
        this.acc[i] -= 1;
        const ang = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * (kind === 0 ? r * 0.8 : r), px = x + Math.cos(ang) * rr, pz = z + Math.sin(ang) * rr;
        const py = (kind === 0 ? gy + 1.2 + Math.random() * 3.6 : this.terrain.heightAt(px, pz) + 0.3 + Math.random() * 1.2);
        const hot = Math.random();
        this.flames.emit(px, py, pz, (Math.random() - 0.5) * 0.7, 1.4 + Math.random() * 2.4, (Math.random() - 0.5) * 0.7, 0.55 + Math.random() * 0.6, kind === 0 ? 3.4 : 4.2, 0.6, 1, 0.35 + hot * 0.5, 0.05 + hot * 0.12, 0.85);
        if (Math.random() < 0.55) this.smoke.emit(px, py + 1.4, pz, 0.6 + Math.random() * 0.6, 1.6 + Math.random() * 1.2, (Math.random() - 0.5) * 0.7, 3 + Math.random() * 2.5, 3.2, 12, 0.16, 0.15, 0.15, 0.55);
        if (Math.random() < 0.05) this.flames.emit(px, py, pz, (Math.random() - 0.5) * 3, 3 + Math.random() * 3, (Math.random() - 0.5) * 3, 0.9, 0.35, 0.1, 1, 0.85, 0.3, 1);
      }
    }
    this.light.intensity = 0;
    if (lit >= 0) {
      this.light.position.set(fires[lit * 4 + 1], litY + 3.5, fires[lit * 4 + 2]);
      this.light.intensity = (90 + fires[lit * 4 + 3] * 25) * (0.8 + Math.sin(this.t * 17) * 0.12 + Math.sin(this.t * 31) * 0.08);
    }

    // projectiles
    const v = this.shotPosition, look = this.shotLook;
    let survivors = 0, nArrows = 0, nStones = 0;
    const aim = this.aim;
    for (const s of this.shots) {
      s.t += dt; const u = Math.min(1, s.t / s.dur);
      v.lerpVectors(s.a, s.b, u); v.y += s.arc * 4 * u * (1 - u);
      if (u < 1) {
        look.subVectors(v, s.pos); s.pos.copy(v);
        aim.position.copy(v); aim.quaternion.copy(s.q);
        if (look.lengthSq() > 1e-6) { aim.lookAt(look.add(v)); s.q.copy(aim.quaternion); }   // point along the flight path
        if (s.stone) aim.rotation.x += dt * 8;
        aim.updateMatrix();
        if (s.stone) { if (nStones < 128) this.stones.setMatrixAt(nStones++, aim.matrix); }
        else if (nArrows < 1024) this.arrows.setMatrixAt(nArrows++, aim.matrix);
        if (enabled && (s.stone || s.fire) && s.t >= s.nextTrail && (!view || view.includes(v.x, v.y, v.z, 6))) {
          s.nextTrail = s.t + 1 / 30 - 0.001;
          if (s.stone) this.smoke.emit(v.x, v.y, v.z, 0, 0.2, 0, 0.8, 0.5, 1.4, 0.3, 0.28, 0.26, 0.4);
          if (s.fire) { this.flames.emit(v.x, v.y, v.z, 0, 0.5, 0, 0.35, 0.6, 0.1, 1, 0.55, 0.15, 0.9); this.smoke.emit(v.x, v.y, v.z, 0, 0.4, 0, 1.2, 0.5, 2, 0.2, 0.2, 0.2, 0.3); }
        }
        this.shots[survivors++] = s;
      } else {
        if (!enabled || (view && !view.includes(s.b.x, s.b.y, s.b.z, 16))) continue;
        if (s.stone) this.burst(s.b.x, s.b.z, true);
        else if (s.fire) this.flames.emit(s.b.x, s.b.y, s.b.z, 0, 1, 0, 0.8, 1.2, 0.2, 1, 0.5, 0.1, 0.9);
      }
    }
    this.shots.length = survivors;
    for (const [m, n] of [[this.arrows, nArrows], [this.stones, nStones]] as const) {
      m.count = n; m.visible = n > 0;
      if (n) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, n * 16); m.instanceMatrix.needsUpdate = true; }
    }
    this.flames.update(dt); this.smoke.update(dt); this.dust.update(dt);
  }
}

/** Charred rubble where buildings stood. */
export class Ruins {
  group = new THREE.Group();
  private sig = '';
  private mats = [new THREE.MeshStandardMaterial({ color: 0x2b2622, roughness: 1 }), new THREE.MeshStandardMaterial({ color: 0x5a5650, roughness: 1 }), new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 1 })];
  private ray = new THREE.Raycaster();
  constructor(private terrain: Terrain) {}

  /** The invisible cylinder over each ruin that clicks find (never drawn: their material is invisible). */
  private hits = new THREE.Group();
  private hitMat = new THREE.MeshBasicMaterial({ visible: false });
  private hitGeo = new THREE.CylinderGeometry(1, 1, 2.4, 10);
  private box = new THREE.BoxGeometry(1, 1, 1);

  /** ruins = World.ruins_flat(): [x, y, r, kind, tier, rot] per ruin. Each ruin is a clickable pile of charred rubble.
   *  All the rubble is merged into one mesh per material (three draws for every ruin of the village: each block used to be a mesh, and so a draw, of its own, in the
   *  shadow map too; a late-game village with a few hundred ruins drew thousands of them). The piles are rebuilt only when the ruins or the ground change. */
  sync(ruins: Float32Array, terrainVersion = 0) {
    const sig = Array.from(ruins).join(',') + '#' + terrainVersion;   // refitted whenever the ground changes
    if (sig === this.sig) return;
    this.sig = sig;
    this.group.children.slice().forEach(c => { if (c === this.hits) return; this.group.remove(c); (c as THREE.Mesh).geometry?.dispose(); });
    this.hits.clear();
    if (!this.hits.parent) this.group.add(this.hits);
    const n = ruins.length / 6, parts: THREE.BufferGeometry[][] = [[], [], []], o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const x = ruins[i * 6], z = ruins[i * 6 + 1], r = ruins[i * 6 + 2], ground = this.terrain.heightAt(x, z);
      for (let k = 0; k < 14; k++) {
        const a = Math.sin(i * 12.9 + k * 7.1) * 43758.5453, rnd = (m: number) => { const q = Math.sin(a * m + k) * 43758.5453; return q - Math.floor(q); };
        const isBeam = k % 3 === 0, w = isBeam ? 0.18 : 0.5 + rnd(1) * 0.7, h = isBeam ? 0.15 : 0.3 + rnd(2) * 0.5, d = isBeam ? 1.4 + rnd(3) * 1.4 : 0.5 + rnd(4) * 0.7;
        const ang = rnd(5) * 6.28, rr = rnd(6) * r * 0.9;
        o.position.set(x + Math.cos(ang) * rr, ground + h * 0.35, z + Math.sin(ang) * rr); o.rotation.set((rnd(7) - 0.5) * 0.6, rnd(8) * 6.28, (rnd(9) - 0.5) * 0.6); o.scale.set(w, h, d);
        o.updateMatrix(); parts[isBeam ? 2 : k % 2].push(this.box.clone().applyMatrix4(o.matrix));
      }
      const hit = new THREE.Mesh(this.hitGeo, this.hitMat); hit.position.set(x, ground + 1.2, z); hit.scale.set(r + 0.8, 1, r + 0.8); hit.userData.ruinIdx = i;
      hit.updateMatrix(); hit.matrixAutoUpdate = false; this.hits.add(hit);
    }
    parts.forEach((geos, m) => {
      if (!geos.length) return;
      const geo = mergeGeometries(geos); geos.forEach(g => g.dispose()); if (!geo) return;
      const mesh = new THREE.Mesh(geo, this.mats[m]); mesh.castShadow = mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; this.group.add(mesh);
    });
  }

  /** Index of the ruin under the pointer, or null. */
  pick(ray: THREE.Raycaster): number | null {
    void this.ray;
    const hit = ray.intersectObjects(this.hits.children, false)[0];
    return hit ? hit.object.userData.ruinIdx as number : null;
  }
}

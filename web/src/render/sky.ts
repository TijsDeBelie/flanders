import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { dayPhase, sunElevation, nightFactor } from '../daycycle';
import { TREE_SHADOW_LAYER } from './trees';

/** Cache static shadows and limit refreshes from moving actors at wider zooms. */
export class ShadowRefresh {
  private time = -Infinity;
  private target = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private extent = -1;
  private dirty = true;
  private actors = false;
  /** Stretches the redraw interval for moving actors: 2 on phones and tablets, where villagers cast no shadow and the remaining movers (siege engines, boats) can
   *  trail their shadows a little longer. */
  actorScale = 1;

  invalidate() { this.dirty = true; }

  update(now: number, target: THREE.Vector3, direction: THREE.Vector3, zoom: number, actors: boolean, extent = 80) {
    const elapsed = now - this.time;
    const pan = target.distanceToSquared(this.target);
    const sunMoved = direction.distanceToSquared(this.direction) >= 0.025 ** 2;
    const actorInterval = (zoom < 105 ? 140 : zoom < 175 ? 200 : 275) * this.actorScale;
    // while the camera pans the shadow map is redrawn every 12 units (at most every 150 ms), not every 6 (at most every 100 ms): the shadowed square is 100-160 units
    // across, so it still covers the view, and a pan no longer pays for a full shadow redraw on most of its frames (a late-game village has hundreds of casters)
    const framingChanged = pan >= 12 ** 2 || Math.abs(extent - this.extent) >= 4;
    const stopped = this.actors && !actors;
    this.actors = actors;
    if (!this.dirty && !stopped && pan < 40 ** 2 && !(framingChanged && elapsed >= 150) && !(sunMoved && elapsed >= 150) && !(actors && elapsed >= actorInterval)) return false;
    this.dirty = false; this.time = now; this.target.copy(target); this.direction.copy(direction); this.extent = extent;
    return true;
  }
}

/** Physically based sky, sun light with shadows, image-based lighting and fog. */
// fixed colours used by setClock (allocated once rather than on every clock step)
/** Exposure by day, for the neutral tone curve and grade in look.ts (ACES wanted 0.72 and still greyed the colours). */
export const EXPOSURE = 0.92;
const MOON = new THREE.Color(0.5, 0.6, 1.0), NIGHT_SKY = new THREE.Color(0.35, 0.44, 0.72), NIGHT_FOG = new THREE.Color(0.04, 0.06, 0.13);

export class Atmosphere {
  sky = new Sky();
  sun = new THREE.DirectionalLight(0xffe8c8, 2.4);
  hemi = new THREE.HemisphereLight(0xa9c4ee, 0x4a5530, 0.42);
  /** Direction of the light that lights the world: the sun by day, a pale moon at night (never from below the horizon). */
  private sunDir = new THREE.Vector3();
  get lightDirection() { return this.sunDir; }
  private shadows = new ShadowRefresh();
  private skyDir = new THREE.Vector3();
  /** 0 in full day .. 1 at night: what lanterns and windows follow. */
  night = 0;
  private fogCol = new THREE.Color(0xb9cde0);

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    this.sky.scale.setScalar(5000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4.5; u.rayleigh.value = 1.7; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
    scene.add(this.sky, this.sun, this.sun.target, this.hemi);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);   // 4096 cost four times the fill for a barely sharper edge
    const c = this.sun.shadow.camera; c.left = -80; c.right = 80; c.top = 80; c.bottom = -80; c.near = 10; c.far = 500;
    c.layers.enable(TREE_SHADOW_LAYER);
    this.sun.shadow.bias = -0.0005; this.sun.shadow.normalBias = 0.4;

    scene.fog = new THREE.FogExp2(this.fogCol, 0.0016);
    this.setClock(dayPhase(0));
    this.bakeEnvironment();
  }

  /** t in 0..1 over a day; the sun stays above the horizon so the world is always readable. */
  setTime(t: number) {
    const elev = 14 + Math.sin(t * Math.PI) * 46;   // degrees: golden morning → noon → golden evening
    const az = 100 + t * 150;
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(az));
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const warm = 1 - Math.min(1, elev / 40);
    this.sun.color.setRGB(1, 0.93 - warm * 0.22, 0.82 - warm * 0.4);
    this.sun.intensity = 1.9 + (1 - warm) * 0.8;   // (was 2.6-3.8: with ACES tone mapping the lit grass and stone clipped towards white)
    this.fogCol.setRGB(0.58 + warm * 0.2, 0.67 + warm * 0.0 - warm * 0.1, 0.78 - warm * 0.2);
    (this.scene.fog as THREE.FogExp2).color.copy(this.fogCol);
  }

  /** The light for a time of day (see daycycle.ts): the sun crosses the sky, sets, and a dim blue moonlight takes over; the sky, fog, ambient light and exposure follow. */
  setClock(phase: number) {
    const elev = sunElevation(phase), n = nightFactor(phase), az = 90 + (phase - 0.25) * 360;
    this.night = n;
    this.skyDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(az));
    this.sky.material.uniforms.sunPosition.value.copy(this.skyDir);
    const lightElev = elev > 3 ? elev : 3 + (3 - elev) * 0.5;   // below the horizon the moon stands in, rising as the sun sinks
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - Math.min(lightElev, 70)), THREE.MathUtils.degToRad(az));
    const warm = 1 - Math.min(1, Math.max(0, elev) / 40);
    this.sun.color.setRGB(1, 0.965 - warm * 0.2, 0.9 - warm * 0.38).lerp(MOON, n);   // whiter than ACES needed: the neutral curve keeps the tint, and pale walls went yellow
    this.sun.intensity = (1.9 + (1 - warm) * 0.8) * (1 - n) + 0.55 * n;
    this.hemi.intensity = 0.42 * (1 - n) + 0.24 * n; this.hemi.color.setRGB(0.66, 0.77, 0.93).lerp(NIGHT_SKY, n);
    const f = this.fogCol.setRGB(0.58 + warm * 0.2, 0.67 - warm * 0.1, 0.78 - warm * 0.2).lerp(NIGHT_FOG, n);
    (this.scene.fog as THREE.FogExp2).color.copy(f);
    this.scene.environmentIntensity = 0.4 * (1 - n) + 0.12 * n;
    this.renderer.toneMappingExposure = EXPOSURE + 0.35 * n;   // a little brighter at night, so a dark scene stays readable
  }

  /** Shadow quality from the display settings: a map size, or 0 for no shadows at all. */
  setShadows(size: number) {
    if (this.sun.castShadow !== (size > 0) || this.sun.shadow.mapSize.x !== size) this.invalidateShadows();
    this.sun.castShadow = size > 0;
    if (size > 0 && this.sun.shadow.mapSize.x !== size) { this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; this.sun.shadow.mapSize.set(size, size); }
    if (size === 0) { this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
  }

  invalidateShadows() { this.shadows.invalidate(); }
  /** See `ShadowRefresh.actorScale`. */
  set shadowActorScale(k: number) { this.shadows.actorScale = k; }

  /** Returns true when the shadow map is redrawn this frame. */
  updateShadows(now: number, target: THREE.Vector3, zoom: number, movingActors: boolean): boolean {
    const extent = THREE.MathUtils.clamp(43 + zoom * 0.48, 50, 80);
    const redraw = this.sun.castShadow && this.shadows.update(now, target, this.sunDir, zoom, movingActors, extent);
    this.renderer.shadowMap.needsUpdate = redraw;
    const camera = this.sun.shadow.camera;
    if (redraw && camera.right !== extent) {
      camera.left = camera.bottom = -extent;
      camera.right = camera.top = extent;
      camera.updateProjectionMatrix();
    }
    return redraw;
  }

  /** Move the shadow frustum so it follows the camera focus. */
  follow(target: THREE.Vector3) {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, 220);
    this.sun.target.updateMatrixWorld();
  }

  private bakeEnvironment() {
    const pm = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene(); const s = new Sky(); s.scale.setScalar(5000);
    Object.entries(this.sky.material.uniforms).forEach(([k, v]) => { (s.material.uniforms as any)[k].value = (v as any).value; });
    env.add(s);
    this.scene.environment = pm.fromScene(env, 0.02).texture;
    this.scene.environmentIntensity = 0.4;
    pm.dispose();
  }
}

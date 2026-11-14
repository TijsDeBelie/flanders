import * as THREE from 'three';
import type { Terrain } from './terrain';
import { HALF } from './terrain';
import { keys } from '../keys';
import { DragCounter, grabShift, rayOnPlane, zoomAbout, type P2 } from './camerafx';

/** RTS camera. Keys come from the shared bindings (WASD, ZQSD and arrows move). Right-drag turns it, middle-drag or Shift-drag grabs the ground (the spot under the pointer stays
 *  under the pointer), and the wheel zooms towards the pointer. A right-click that wobbles a few pixels is still a click. */
export class CameraRig {
  cam: THREE.PerspectiveCamera;
  target = new THREE.Vector3(0, 0, 0);
  yaw = 0.7; pitch = 0.95; dist = 70;
  private goal = { x: 0, z: 0, yaw: 0.7, pitch: 0.95, dist: 70 };
  private drag: { x: number; y: number; mode: 'rot' | 'pan' } | null = null;
  private counter = new DragCounter();
  private grab: P2 | null = null; private grabY = 0;
  private ray = new THREE.Raycaster(); private ndc = new THREE.Vector2();
  /** Has the pointer been dragged (more than a few pixels in all) since the button went down? */
  get moved() { return this.counter.dragged; }
  private shakeAmt = 0;
  /** A short rumble, e.g. when a heavy building lands. */
  shake(a: number) { this.shakeAmt = Math.min(1.2, this.shakeAmt + a); }

  constructor(private dom: HTMLElement, private terrain: Terrain) {
    this.cam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 4000);
    dom.addEventListener('contextmenu', e => e.preventDefault());
    /** The ray under the pointer. */
    const aim = (e: { clientX: number; clientY: number }) => {
      const r = dom.getBoundingClientRect(); this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      this.cam.updateMatrixWorld(true); this.ray.setFromCamera(this.ndc, this.cam); return this.ray.ray;
    };
    dom.addEventListener('pointerdown', e => {
      this.counter.reset();
      if (e.button === 2) { this.drag = { x: e.clientX, y: e.clientY, mode: 'rot' }; dom.style.cursor = 'move'; }
      else if (e.button === 1 || e.shiftKey) {
        this.drag = { x: e.clientX, y: e.clientY, mode: 'pan' }; dom.style.cursor = 'grabbing';
        const ray = aim(e), hit = terrain.pick(ray); this.grabY = hit ? hit.y : this.target.y; this.grab = hit ? { x: hit.x, z: hit.z } : rayOnPlane(ray.origin, ray.direction, this.grabY);
      }
      if (this.drag) dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY; this.counter.add(dx, dy);
      if (this.drag.mode === 'rot') {
        this.goal.yaw -= dx * 0.006;
        this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.005, 0.18, 1.45);
      } else if (this.grab) {
        // grab the ground: move the camera so the spot that was under the pointer is under it again, at once (not eased), so the world sticks to the pointer
        const ray = aim(e), now = rayOnPlane(ray.origin, ray.direction, this.grabY);
        if (now) { const d = grabShift(this.grab, now); this.goal.x += d.x; this.goal.z += d.z; this.target.x += d.x; this.target.z += d.z; this.place(); }
      }
    });
    const end = () => { this.drag = null; this.grab = null; dom.style.cursor = ''; };
    dom.addEventListener('pointerup', end); dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', e => {
      e.preventDefault();
      const old = this.goal.dist, next = THREE.MathUtils.clamp(old * Math.exp(e.deltaY * 0.0012), 12, 260), ratio = next / old;
      const hit = terrain.pick(aim(e));   // zoom towards what is under the pointer, away from it when zooming out
      if (hit && ratio !== 1) { const t = zoomAbout({ x: this.goal.x, z: this.goal.z }, { x: hit.x, z: hit.z }, ratio); this.goal.x = t.x; this.goal.z = t.z; }
      this.goal.dist = next;
    }, { passive: false });
    addEventListener('resize', () => { this.cam.aspect = innerWidth / innerHeight; this.cam.updateProjectionMatrix(); });
  }

  focus(x: number, z: number, dist?: number) { this.goal.x = x; this.goal.z = z; if (dist) this.goal.dist = dist; }
  snap() { this.target.set(this.goal.x, 0, this.goal.z); this.yaw = this.goal.yaw; this.pitch = this.goal.pitch; this.dist = this.goal.dist; }

  private pan(right: number, forward: number) {
    const s = Math.sin(this.goal.yaw), c = Math.cos(this.goal.yaw);
    this.goal.x += right * c + forward * s;
    this.goal.z += -right * s + forward * c;
  }

  update(dt: number) {
    const sp = this.goal.dist * 0.9 * dt * (keys.isDown('panFast') ? 2.2 : 1);
    if (keys.isDown('panUp')) this.pan(0, -sp);
    if (keys.isDown('panDown')) this.pan(0, sp);
    if (keys.isDown('panLeft')) this.pan(-sp, 0);
    if (keys.isDown('panRight')) this.pan(sp, 0);
    if (keys.isDown('rotLeft')) this.goal.yaw += dt * 1.6;
    if (keys.isDown('rotRight')) this.goal.yaw -= dt * 1.6;
    if (keys.isDown('tiltUp')) this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dt * 0.9, 0.18, 1.45);
    if (keys.isDown('tiltDown')) this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch - dt * 0.9, 0.18, 1.45);
    if (keys.isDown('zoomIn')) this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * Math.exp(-dt * 1.4), 12, 260);
    if (keys.isDown('zoomOut')) this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * Math.exp(dt * 1.4), 12, 260);
    this.goal.x = THREE.MathUtils.clamp(this.goal.x, -HALF + 30, HALF - 30);
    this.goal.z = THREE.MathUtils.clamp(this.goal.z, -HALF + 30, HALF - 30);
    const a = 1 - Math.exp(-dt * 10);
    this.target.x += (this.goal.x - this.target.x) * a;
    this.target.z += (this.goal.z - this.target.z) * a;
    this.yaw += (this.goal.yaw - this.yaw) * a;
    this.pitch += (this.goal.pitch - this.pitch) * a;
    this.dist += (this.goal.dist - this.dist) * a;
    this.place(dt);
  }

  /** Put the camera where the target, distance and angles say. */
  private place(dt = 0) {
    this.target.y = Math.max(0, this.terrain.heightAt(this.target.x, this.target.z));
    const cp = Math.cos(this.pitch);
    this.cam.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    // keep the camera above the ground
    const g = this.terrain.heightAt(this.cam.position.x, this.cam.position.z) + 2.5;
    if (this.cam.position.y < g) this.cam.position.y = g;
    if (dt > 0 && this.shakeAmt > 0.002) { this.cam.position.x += (Math.random() - 0.5) * this.shakeAmt; this.cam.position.y += (Math.random() - 0.5) * this.shakeAmt * 0.6; this.cam.position.z += (Math.random() - 0.5) * this.shakeAmt; this.shakeAmt *= Math.exp(-dt * 9); }
    this.cam.lookAt(this.target);
  }
}

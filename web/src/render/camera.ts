import * as THREE from 'three';
import type { Terrain } from './terrain';
import { HALF } from './terrain';
import { keys } from '../keys';
import { settings } from '../settings';
import { cachedRect, DragCounter, Glide, grabShift, rayOnPlane, TOUCH_DRAG_PIXELS, touchFrame, TwistGate, twoFingerMode, zoomAbout, type P2, type TouchPoint } from './camerafx';

/** How far the camera draws. The scene's fog (`FogExp2`, density 0.0016 in sky.ts) leaves 1.3% of a surface's colour at 1,300 m and 0.14% at 1,600 m, so anything
 *  further away is drawn only to be painted over with fog: ground chunks, rivers and sea out there cost draw calls and pixels for nothing. The sky is drawn on the
 *  far plane itself (three's Sky shader puts it at depth 1), so it is not cut off. Was 4,000. */
export const VIEW_FAR = 1600;

/** RTS camera. Keys come from the shared bindings (WASD, ZQSD and arrows move). Right-drag turns it, middle-drag or Shift-drag grabs the ground (the spot under the pointer stays
 *  under the pointer), and the wheel zooms towards the pointer. A right-click that wobbles a few pixels is still a click.
 *  Touch: one finger drags the ground (and it glides on after a quick swipe); two fingers pinch to zoom, pan, and turn once twisted past about 10°; two fingers slid
 *  up or down together tilt the camera. A trackpad pinch on an iPad (Safari's gesture events) zooms. */
export class CameraRig {
  cam: THREE.PerspectiveCamera;
  target = new THREE.Vector3(0, 0, 0);
  yaw = 0.7; pitch = 0.95; dist = 70;
  private goal = { x: 0, z: 0, yaw: 0.7, pitch: 0.95, dist: 70 };
  private drag: { x: number; y: number; mode: 'rot' | 'pan' } | null = null;
  private counter = new DragCounter();
  private grab: P2 | null = null; private grabY = 0;
  private ray = new THREE.Raycaster(); private ndc = new THREE.Vector2();
  private tracked: { read: () => P2 | null; stop: () => void } | null = null;
  get following() { return this.tracked !== null; }
  /** Has the pointer been dragged (more than a few pixels in all) since the button went down? */
  get moved() { return this.counter.dragged; }
  touchConsumed = false;
  private shakeAmt = 0;
  private glide = new Glide();
  /** A short rumble, e.g. when a heavy building lands. */
  shake(a: number) { this.shakeAmt = Math.min(1.2, this.shakeAmt + a); }

  constructor(private dom: HTMLElement, private terrain: Terrain, touchDrawing: (e: { clientX: number; clientY: number }) => boolean = () => false) {
    this.cam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, VIEW_FAR);
    dom.addEventListener('contextmenu', e => e.preventDefault());
    /** The ray under the pointer. */
    const aim = (e: { clientX: number; clientY: number }) => {
      const r = cachedRect(dom); this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      this.cam.updateMatrixWorld(true); this.ray.setFromCamera(this.ndc, this.cam); return this.ray.ray;
    };
    const touches = new Map<number, TouchPoint>();
    let touchStart: TouchPoint, touchDrawingStroke = false;
    let touchGrab: P2 | null = null, touchY = 0;
    /** Where each finger was when the second came down, and what two fingers turned out to be doing (see `twoFingerMode`). */
    const twoStart = new Map<number, TouchPoint>(); let twoMode: 'tilt' | 'map' | null = null;
    const twist = new TwistGate();
    const startTwo = () => { twoStart.clear(); for (const [id, p] of touches) twoStart.set(id, { clientX: p.clientX, clientY: p.clientY }); twoMode = null; twist.reset(); };
    const startTouchPan = (point: TouchPoint) => {
      this.stopFollowing(); this.glide.stop();
      const ray = aim(point), hit = terrain.pick(ray);
      touchY = hit?.y ?? this.target.y;
      touchGrab = hit ? { x: hit.x, z: hit.z } : rayOnPlane(ray.origin, ray.direction, touchY);
    };
    dom.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') {
        if (!touches.size) {
          touchStart = e;
          this.touchConsumed = false;
          touchDrawingStroke = touchDrawing(e);
          this.glide.stop();   // a finger on the glass catches a gliding map
        }
        touches.set(e.pointerId, e);
        if (touches.size === 2) {
          this.touchConsumed = true;
          startTwo();
          startTouchPan(touchFrame([...touches.values()]).center);
        }
        dom.setPointerCapture(e.pointerId);
        return;
      }
      this.counter.reset();
      if (e.button === 2) { this.drag = { x: e.clientX, y: e.clientY, mode: 'rot' }; dom.style.cursor = 'move'; }
      else if (e.button === 1 || e.shiftKey) {
        this.stopFollowing();
        this.drag = { x: e.clientX, y: e.clientY, mode: 'pan' }; dom.style.cursor = 'grabbing';
        const ray = aim(e), hit = terrain.pick(ray); this.grabY = hit ? hit.y : this.target.y; this.grab = hit ? { x: hit.x, z: hit.z } : rayOnPlane(ray.origin, ray.direction, this.grabY);
      }
      if (this.drag) dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') {
        if (!touches.has(e.pointerId)) return;
        const before = touchFrame([...touches.values()]);
        touches.set(e.pointerId, e);
        const after = touchFrame([...touches.values()]);
        if (!this.touchConsumed && !touchDrawingStroke
          && Math.hypot(e.clientX - touchStart.clientX, e.clientY - touchStart.clientY) > TOUCH_DRAG_PIXELS) {
          this.touchConsumed = true;
          startTouchPan(touchStart);
        }
        if (!this.touchConsumed) return;
        if (after.distance && twoStart.size === 2 && twoMode === null) {
          const [a, b] = [...twoStart.entries()].map(([id, p]) => { const q = touches.get(id) ?? p; return { dx: q.clientX - p.clientX, dy: q.clientY - p.clientY }; });
          twoMode = a && b ? twoFingerMode(a, b) : 'map';
          if (twoMode === null) return;                                    // not decided yet: hold the map still rather than jolt it one way then the other
          if (twoMode === 'map') startTouchPan(after.center);            // the ground under the fingers now is what they hold
        }
        if (after.distance && twoMode === 'tilt') {
          // both fingers up or down together: tilt, the same way a right-drag tilts (fingers up = towards the horizon)
          this.goal.pitch = this.pitch = THREE.MathUtils.clamp(this.pitch + (after.center.clientY - before.center.clientY) * 0.005, 0.18, 1.45);
          this.place();
          return;
        }
        if (after.distance) {
          this.dist = this.goal.dist = THREE.MathUtils.clamp(this.dist * before.distance / after.distance, 12, 260);
          const turn = twist.step(Math.atan2(Math.sin(after.angle - before.angle), Math.cos(after.angle - before.angle)));
          this.yaw = this.goal.yaw = this.yaw + turn;
          this.place();
        }
        if (touchGrab) {
          const ray = aim(after.center), hit = rayOnPlane(ray.origin, ray.direction, touchY);
          if (hit) {
            const shift = grabShift(touchGrab, hit);
            this.goal.x = this.target.x += shift.x; this.goal.z = this.target.z += shift.z;
            this.glide.sample(shift.x, shift.z, e.timeStamp);
            this.place();
          }
        }
        return;
      }
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
    const end = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        if (!touches.delete(e.pointerId)) return;
        if (touches.size && this.touchConsumed) { startTouchPan(touchFrame([...touches.values()]).center); twoStart.clear(); twoMode = 'map'; }   // one finger left: it carries on panning
        else {
          touchGrab = null;
          if (!touches.size && this.touchConsumed && e.type === 'pointerup') this.glide.release(e.timeStamp); else this.glide.stop();
        }
        return;
      }
      this.drag = null; this.grab = null; dom.style.cursor = '';
    };
    dom.addEventListener('pointerup', end); dom.addEventListener('pointercancel', end);
    dom.addEventListener('lostpointercapture', end);
    dom.addEventListener('wheel', e => {
      e.preventDefault();
      const old = this.goal.dist, next = THREE.MathUtils.clamp(old * Math.exp(e.deltaY * 0.0012), 12, 260), ratio = next / old;
      const hit = this.tracked ? null : terrain.pick(aim(e));   // a tracked villager stays in the centre when zooming
      if (hit && ratio !== 1) { const t = zoomAbout({ x: this.goal.x, z: this.goal.z }, { x: hit.x, z: hit.z }, ratio); this.goal.x = t.x; this.goal.z = t.z; }
      this.goal.dist = next;
    }, { passive: false });
    // a pinch on an iPad's trackpad comes as Safari's own gesture events, not as wheel events (and unhandled it zoomed the whole page)
    let gestureScale = 1;
    dom.addEventListener('gesturestart', e => { e.preventDefault(); gestureScale = 1; });
    dom.addEventListener('gesturechange', e => {
      e.preventDefault();
      if (touches.size) return;   // fingers on the screen: the pointer handlers above already zoom
      const scale = (e as Event & { scale?: number }).scale ?? 1; if (!(scale > 0)) return;
      this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * gestureScale / scale, 12, 260); gestureScale = scale;
    });
    addEventListener('resize', () => { this.cam.aspect = innerWidth / innerHeight; this.cam.updateProjectionMatrix(); });
  }

  focus(x: number, z: number, dist?: number) { this.stopFollowing(); this.glide.stop(); this.goal.x = x; this.goal.z = z; if (dist) this.goal.dist = dist; }
  follow(read: () => P2 | null, stop: () => void, dist = 23) {
    const point = read();
    if (!point) return false;
    this.focus(point.x, point.z, dist);
    this.tracked = { read, stop };
    return true;
  }
  stopFollowing() {
    const tracked = this.tracked;
    this.tracked = null;
    tracked?.stop();
  }
  snap() { this.target.set(this.goal.x, 0, this.goal.z); this.yaw = this.goal.yaw; this.pitch = this.goal.pitch; this.dist = this.goal.dist; }

  private pan(right: number, forward: number) {
    this.stopFollowing();
    const s = Math.sin(this.goal.yaw), c = Math.cos(this.goal.yaw);
    this.goal.x += right * c + forward * s;
    this.goal.z += -right * s + forward * c;
  }

  update(dt: number) {
    const k = settings().cameraSpeed, sp = this.goal.dist * 0.9 * dt * k * (keys.isDown('panFast') ? 2.2 : 1);
    if (keys.isDown('panUp')) this.pan(0, -sp);
    if (keys.isDown('panDown')) this.pan(0, sp);
    if (keys.isDown('panLeft')) this.pan(-sp, 0);
    if (keys.isDown('panRight')) this.pan(sp, 0);
    if (keys.isDown('rotLeft')) this.goal.yaw += dt * 1.6 * k;
    if (keys.isDown('rotRight')) this.goal.yaw -= dt * 1.6 * k;
    if (keys.isDown('tiltUp')) this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dt * 0.9 * k, 0.18, 1.45);
    if (keys.isDown('tiltDown')) this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch - dt * 0.9 * k, 0.18, 1.45);
    if (keys.isDown('zoomIn')) this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * Math.exp(-dt * 1.4 * k), 12, 260);
    if (keys.isDown('zoomOut')) this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * Math.exp(dt * 1.4 * k), 12, 260);
    if (this.glide.moving) { const d = this.glide.advance(dt); this.goal.x += d.x; this.goal.z += d.z; this.target.x += d.x; this.target.z += d.z; }
    if (this.tracked) {
      const point = this.tracked.read();
      if (point) { this.goal.x = point.x; this.goal.z = point.z; }
      else this.stopFollowing();
    }
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
    this.target.y = Math.max(0, this.terrain.heightAt(this.target.x, this.target.z, true));
    const cp = Math.cos(this.pitch);
    this.cam.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    // keep the camera above the ground
    const g = this.terrain.heightAt(this.cam.position.x, this.cam.position.z, true) + 2.5;
    if (this.cam.position.y < g) this.cam.position.y = g;
    if (dt > 0 && this.shakeAmt > 0.002) { this.cam.position.x += (Math.random() - 0.5) * this.shakeAmt; this.cam.position.y += (Math.random() - 0.5) * this.shakeAmt * 0.6; this.cam.position.z += (Math.random() - 0.5) * this.shakeAmt; this.shakeAmt *= Math.exp(-dt * 9); }
    this.cam.lookAt(this.target);
  }
}

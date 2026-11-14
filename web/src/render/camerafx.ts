/** The maths behind the camera controls, with no drawing code, so it can be tested. Positions are on the ground plane: x east, z south. */
export interface P2 { x: number; z: number }

/** Zoom by `ratio` (below 1 is closer) so the point under the pointer stays under the pointer: the camera's target slides towards that point as you zoom in and away from it as you zoom out. */
export function zoomAbout(target: P2, point: P2, ratio: number): P2 {
  return { x: point.x + (target.x - point.x) * ratio, z: point.z + (target.z - point.z) * ratio };
}

/** Where a ray from `origin` along `dir` meets the horizontal plane at height `y`, or null if it never does (looking up) or only far beyond the map. */
export function rayOnPlane(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, y: number, far = 20000): P2 | null {
  if (dir.y >= -1e-6) return null; const t = (y - origin.y) / dir.y; if (t < 0 || t > far) return null;
  return { x: origin.x + dir.x * t, z: origin.z + dir.z * t };
}

/** Dragging the ground: the point that was under the pointer when the drag began (`grabbed`) must be under it now (`now`), so the target moves by the difference. */
export function grabShift(grabbed: P2, now: P2): P2 { return { x: grabbed.x - now.x, z: grabbed.z - now.z }; }

/** A drag is a drag, and not a click, once the pointer has travelled this far in pixels in total (not just since the last event). */
export const DRAG_PIXELS = 5;
export class DragCounter {
  private total = 0;
  add(dx: number, dy: number) { this.total += Math.hypot(dx, dy); }
  reset() { this.total = 0; }
  get dragged() { return this.total > DRAG_PIXELS; }
}

/** The nearest of some screen positions to the pointer, within `max` pixels (a forgiving click target for small things such as an army's banner). */
export function nearestWithin<T extends { sx: number; sy: number }>(items: T[], x: number, y: number, max: number): T | null {
  let best: T | null = null, bd = max * max;
  for (const it of items) { const d = (it.sx - x) ** 2 + (it.sy - y) ** 2; if (d <= bd) { bd = d; best = it; } }
  return best;
}

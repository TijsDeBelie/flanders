/** Heights of raiders crossing a moat, kept apart from three.js so a test can run it in Node.
 *
 *  The core reports `elev` for a wading raider as (water level - core ground height + 0.12), a number that only makes sense on top of the core's own ground. The client's ground
 *  (the height texture, plus decks) differs a little from that and moves with the soldier's drawn position, and the water in a moat stands at its own level (see moat_water_flat), so
 *  adding the two made a raider pop up as it stepped off the bank and drop again later. Instead the drawn height is worked out here from what the soldier stands on: the ground, or
 *  the surface of the water when the ground is below it, and then it chases that value at a limited vertical speed so nothing can jump. */

/** Vertical speed limit (units per second) for a soldier's drawn height: well above any walkable slope, far below a pop. */
export const MAX_RISE = 6;
/** How far above the water surface a raider is drawn (it stands on a raft, whose deck is a little above the logs). */
export const WADE_LIFT = 0.12;

/** The surface of the moat water at a point: the highest level of the pieces whose ditch covers it, or 0 (the sea). `flat` is World.moat_water_flat(): [x, z, reach, level] per piece. */
export function moatLevelAt(flat: ArrayLike<number>, x: number, z: number): number {
  let level = 0;
  for (let i = 0; i + 3 < flat.length; i += 4) if (Math.hypot(flat[i] - x, flat[i + 1] - z) < flat[i + 2] + 1 && flat[i + 3] > level) level = flat[i + 3];
  return level;
}

/** Where a soldier's feet want to be: on the ground, or on the water's surface where the ground is under it. `level` is the moat water here (0 outside moats), and counts when the
 *  soldier is in a moat (level > 0) or the core says it is wading (a river). The core flips the wading flag a little before or after the water is really reached, so the water is
 *  decided by what is under the feet, not by the flag, or the height would jump when it flips. Taking the higher of the two keeps it continuous across the bank. */
export function standHeight(ground: number, wading: boolean, level: number): number {
  return wading || level > 0 ? Math.max(ground, level + WADE_LIFT) : ground;
}

/** Is the soldier out over the water (rather than on the bank)? Then it rides a raft. */
export function onWater(ground: number, wading: boolean, level: number): boolean {
  return (wading || level > 0) && ground < level - 0.3;
}

/** Move `cur` toward `target` by at most `rate * dt`. */
export function chase(cur: number, target: number, dt: number, rate = MAX_RISE): number {
  const d = target - cur, m = rate * Math.max(0, dt);
  return Math.abs(d) <= m ? target : cur + Math.sign(d) * m;
}

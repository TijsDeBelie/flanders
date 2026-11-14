/** A planned model village laid out like a real concentric castle (Beaumaris, Caerphilly, Kerak): the keep and hall in a small inner ward behind a
 *  high curtain wall with its own gatehouse; round it a bigger outer ward (the bailey) with houses, workshops, market and church behind a lower outer wall;
 *  the two gates on opposite sides so an attacker who forces the outer gate must cross the whole bailey under fire; mural towers at the corners; and outside
 *  everything a moat of varying width, crossed by a drawbridge in front of the outer gate. The outlines are not circles: they swell and narrow like real walls
 *  following the ground. Coordinates are relative to the town hall (x east, y south). The plan only describes what to build; `api` does it. */
export interface ModelApi {
  /** Place a building near the wanted spot (searching a little around it, only at spots `ok` accepts); returns its index or -1. */
  place(kind: number, x: number, y: number, rot?: number, search?: number, ok?: (x: number, y: number) => boolean): number;
  upgrade(idx: number): boolean;
  /** Switch on an optional design upgrade of a building (after the building has reached the tier it needs). */
  option(idx: number, bit: number): boolean;
  garrison(idx: number, n: number): void;
  /** Where a placed building ended up (relative to the hall). */
  at(idx: number): [number, number];
  fill(): void;
  /** Is there water at this spot (relative to the hall)? */
  wet(x: number, y: number): boolean;
  soldiers(kind: number, n: number): void;
}

const HOUSE = 0, FARM = 1, WALL = 2, TOWER = 3, WOODCUTTER = 4, SAWMILL = 5, BLACKSMITH = 13, WELL = 16, CHAPEL = 17, BARRACKS = 19, BUILDERS = 20, GATE = 22, DRAWBRIDGE = 23, MOAT = 24,
  STOREHOUSE = 25, KEEP = 26, COURTHOUSE = 27, MARKET = 28, GARDEN = 30, PARK = 31;

/** An irregular outline: radius R swelling and narrowing with the angle. */
const shape = (R: number, a: number, phase = 0) => R * (1 + 0.05 * Math.sin(2 * a + 0.6 + phase) + 0.03 * Math.sin(3 * a + 1.9 + phase));
const pt = (R: number, a: number, phase = 0): [number, number] => { const r = shape(R, a, phase); return [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)]; };

/** Points along an outline, about `step` apart, starting at angle `from` and going once round. */
function outline(R: number, step: number, from: number, phase = 0): { x: number; y: number; a: number }[] {
  const out: { x: number; y: number; a: number }[] = []; let last: [number, number] | null = null;
  for (let d = 0; d <= 720; d++) {
    const a = from + (d / 720) * Math.PI * 2, p = pt(R, a, phase);
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= step) { out.push({ x: p[0], y: p[1], a }); last = p; }
  }
  // the last point may sit too close to the first: drop it
  if (out.length > 3 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < step * 0.7) out.pop();
  return out;
}

export function buildModelVillage(api: ModelApi, hallIdx = 0) {
  api.fill();
  for (let i = 0; i < 3; i++) { api.upgrade(hallIdx); api.fill(); }          // a grand castle hall widens the border for everything that follows

  const reserved: [number, number, number][] = [];                           // x, y, radius: spots houses must keep clear of
  const wallPts: [number, number][] = [];                                   // every wall piece and gate standing so far
  /** Spots that keep a building clear of the walls: its own radius, the wall piece's, and 3 units of room between them. */
  const clearOfWalls = (r: number) => (x: number, y: number) => wallPts.every(([wx, wy]) => Math.hypot(wx - x, wy - y) >= r + 2.4 + 3.0);
  const put = (kind: number, x: number, y: number, r: number, rot = 0, search = 4) => { const i = api.place(kind, x, y, rot, search, clearOfWalls(r)); if (i >= 0) { const [px, py] = api.at(i); reserved.push([px, py, r]); } return i; };
  reserved.push([0, 0, 6]);

  // 1. the inner ward: keep, church, court, barracks, well and a garden under the keep's walls
  const keep = put(KEEP, 0, -13, 6.5, 0, 3);
  const chapel = put(CHAPEL, -13, -2, 4, 0, 3);
  put(COURTHOUSE, 13, -10, 4.5, 0, 3); put(BARRACKS, 12, 11, 5, 0, 3); put(WELL, -2, 10, 2, 0, 2); put(GARDEN, -12, 12, 3.4, 0, 3);

  // 2. the mural towers of the inner and outer walls, standing a little inside the curtain
  const R1 = 27, R2 = 49, R3 = 65;
  const innerTowers: number[] = [], outerTowers: number[] = [];
  for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3, p = pt(R1 - 7.6, a); innerTowers.push(put(TOWER, p[0], p[1], 3.2, 0, 2)); }
  for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + (k * Math.PI) / 4, p = pt(R2 - 7.6, a); outerTowers.push(put(TOWER, p[0], p[1], 3.2, 0, 2)); }

  // 3. the curtain walls, built before anything stands in the bailey so that no wall is ever blocked by a building (the buildings give way to the walls, not the other way round): inner (with its gatehouse to the east) and outer (gate to the south)
  api.fill();
  const wallRing = (R: number, gateAngle: number, phase: number) => {
    const pieces: number[] = [], ring = outline(R, 5.6, gateAngle, phase), placed: ([number, number] | null)[] = [];
    ring.forEach((p, k) => {
      if (k === 0) { api.place(GATE, p.x, p.y, 0, 0); placed.push([p.x, p.y]); wallPts.push([p.x, p.y]); return; }
      const i = api.place(WALL, p.x, p.y, 0, 4); if (i >= 0) { pieces.push(i); placed.push(api.at(i)); wallPts.push(api.at(i)); } else placed.push(null);
    });
    // close any gap: where neighbours stand too far apart, put a piece between them (or retry the missing spot wider)
    for (let k = 0; k < ring.length; k++) {
      const a = placed[k], b = placed[(k + 1) % ring.length];
      if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 7.5) { const i = api.place(WALL, Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), 0, 3); if (i >= 0) { pieces.push(i); wallPts.push(api.at(i)); } }
      if (!placed[k]) { const i = api.place(WALL, ring[k].x, ring[k].y, 0, 7); if (i >= 0) { pieces.push(i); wallPts.push(api.at(i)); } }
    }
    return pieces;
  };
  const innerWall = wallRing(R1, 0, 0), outerWall = wallRing(R2, Math.PI / 2, 0.3);
  api.fill();

  // a spot in the bailey: halfway between the inner and outer curtain wall in this direction (the walls swell and narrow, so the bailey does too)
  const bail = (deg: number, off = 0): [number, number] => { const a = (deg * Math.PI) / 180, r = (shape(R1, a, 0) + shape(R2, a, 0.3)) / 2 + off; return [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)]; };
  // 4. the bailey: workshops, market, park and farms on the ring between the walls
  { const [x, y] = bail(-33); put(STOREHOUSE, x, y, 4.2, 0, 4); } { const [x, y] = bail(200); put(SAWMILL, x, y, 4.5, 0, 4); } { const [x, y] = bail(222); put(WOODCUTTER, x, y, 3.2, 0, 6); }
  { const [x, y] = bail(172); put(BLACKSMITH, x, y, 4, 0, 4); } { const [x, y] = bail(-62); put(BUILDERS, x, y, 4.5, 0, 4); }
  { const [x, y] = bail(122); put(MARKET, x, y, 5.5, 0, 4); } { const [x, y] = bail(58); put(PARK, x, y, 4, 0, 4); } { const [x, y] = bail(20); put(GARDEN, x, y, 3.4, 0, 4); }
  for (const deg of [215, 160, 285, 335, 100]) { const [x, y] = bail(deg + 8); put(FARM, x, y, 6.5, 0, 9); }

  // 4b. houses fill the bailey, leaving the roads between the two gates free
  const houses: number[] = [];
  for (const ring of [0, 1]) {
    // ring 0 hugs the inside of the inner wall, ring 1 the inside of the outer wall; both keep 8.5 units off the wall pieces
    const n = Math.floor((Math.PI * 2 * (ring ? R2 - 8.5 : R1 + 8.5)) / 7.6);
    for (let k = 0; k < n && houses.length < 38; k++) {
      const a = (k / n) * Math.PI * 2 + (ring ? 0.11 : 0), r = ring ? shape(R2, a, 0.3) - 8.5 : shape(R1, a, 0) + 8.5, p: [number, number] = [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)];
      if (Math.abs(p[1]) < 5 && p[0] > 18) continue;                          // from the inner gate (east) ...
      if (Math.abs(p[0]) < 5 && p[1] > 18) continue;                          // ... to the outer gate (south)
      if (reserved.some(([rx, ry, rr]) => Math.hypot(rx - p[0], ry - p[1]) < rr + 3.7)) continue;
      const i = api.place(HOUSE, p[0], p[1], 0, 2, clearOfWalls(3.2)); if (i >= 0) { houses.push(i); reserved.push([...api.at(i), 3.2]); }
    }
  }

  // 4c. infill: more houses between the two rings, wherever the bailey still has room (the walls are already standing, so this can only fill space, never break a wall)
  for (let deg = 0; deg < 360 && houses.length < 30; deg += 7) for (const off of [-6, 0, 6]) {
    const p = bail(deg + (off ? 3 : 0), off);
    if (Math.abs(p[1]) < 5 && p[0] > 18) continue; if (Math.abs(p[0]) < 5 && p[1] > 18) continue;
    if (reserved.some(([rx, ry, rr]) => Math.hypot(rx - p[0], ry - p[1]) < rr + 3.7)) continue;
    const i = api.place(HOUSE, p[0], p[1], 0, 1, clearOfWalls(3.2)); if (i >= 0) { houses.push(i); reserved.push([...api.at(i), 3.2]); }
  }

  // 6. the moat, outside the outer wall: pieces every ~4 units, broad in some places and thin in others, then any gap filled
  const moatPts = outline(R3, 3.9, Math.PI / 2, 0.3), wet: ([number, number] | null)[] = [];
  moatPts.forEach(p => {
    const dAng = Math.abs(((p.a - Math.PI / 2 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);   // distance from the gate
    const width = dAng < 0.32 ? 1 : Math.max(0, Math.min(4, Math.round(2.2 + 1.8 * Math.sin(p.a * 2.3 + 1.0))));   // narrow at the drawbridge, varied elsewhere
    const i = api.place(MOAT, p.x, p.y, width, 0); wet.push(i >= 0 ? api.at(i) : null);
  });
  for (let k = 0; k < wet.length; k++) {
    const a = wet[k], b = wet[(k + 1) % wet.length]; if (!a || !b) continue;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 5) api.place(MOAT, Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), 3, 0);
  }
  if (moatPts[0]) {
    const bx = moatPts[0].x, by = moatPts[0].y;
    // put the drawbridge in the middle of the water on the line out from the gate, so its deck reaches both banks
    let lo = 99, hi = -99; for (let k = -12; k <= 12; k += 0.5) if (api.wet(bx, by + k)) { lo = Math.min(lo, k); hi = Math.max(hi, k); }
    const mid = lo <= hi ? (lo + hi) / 2 : 0;
    api.place(DRAWBRIDGE, bx, Math.round(by + mid), 0, 0);
    // a little settlement on the far bank, so a road runs out from the gate and across the drawbridge
    const oy = by + (lo <= hi ? hi : 4) + 7; api.place(HOUSE, bx, oy, 0, 2); api.place(WELL, bx + 7, oy + 3, 0, 2); api.place(HOUSE, bx - 7, oy + 3, 0, 2);
  }

  // 7. improvements: stone walls (the inner ring battlemented), stone towers, the keep, nicer houses
  const up = (i: number, times: number) => { for (let t = 0; t < times; t++) { if (!api.upgrade(i)) { api.fill(); if (!api.upgrade(i)) break; } } };
  innerWall.forEach(i => up(i, 3)); api.fill();
  outerWall.forEach(i => up(i, 2)); api.fill();
  for (const i of innerTowers) if (i >= 0) up(i, 3);
  for (const i of outerTowers) if (i >= 0) up(i, 2);
  if (keep >= 0) up(keep, 3);
  if (chapel >= 0) up(chapel, 2);
  houses.forEach((i, k) => { if (k % 2 === 0) up(i, 1); });
  api.fill();

  // 7b. optional designs: stairs up to the wall walks (every few pieces, so the guards can climb), banners, braziers, hoardings, chimneys
  innerWall.forEach((i, k) => { if (k % 5 === 1) { api.option(i, 0); } if (k % 7 === 3) api.option(i, 3); if (k % 9 === 4) api.option(i, 1); });
  outerWall.forEach((i, k) => { if (k % 6 === 2) { api.option(i, 0); } if (k % 8 === 5) api.option(i, 2); if (k % 5 === 4) api.option(i, 1); });
  outerTowers.forEach((i, k) => { if (i >= 0) { api.option(i, k % 2 ? 0 : 3); if (k % 3 === 0) api.option(i, 1); } });
  innerTowers.forEach((i, k) => { if (i >= 0) api.option(i, k % 2 ? 2 : 0); });
  if (keep >= 0) { api.option(keep, 0); api.option(keep, 1); api.option(keep, 2); }
  houses.forEach((i, k) => { if (k % 3 === 0) api.option(i, 0); else if (k % 3 === 1) api.option(i, 1); });
  api.fill();

  // 8. a garrison to man it
  api.soldiers(1, 40); api.soldiers(0, 20); api.soldiers(2, 12);
  if (keep >= 0) api.garrison(keep, 8);
  for (const t of [...innerTowers, ...outerTowers]) if (t >= 0) api.garrison(t, 3);
}

void FARM; void BUILDERS; void WALL; void TOWER; void HOUSE;

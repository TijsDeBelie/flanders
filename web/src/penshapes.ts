/** Geometry for the building pen (walls, spiked logs, moats, rivers, earthworks): corners and ready-made figures turned into a row of pieces. No game or drawing code in here. */
export interface P { x: number; z: number }
export type Shape = 'line' | 'path' | 'rect' | 'square' | 'circle' | 'ellipse' | 'triangle' | 'hexagon' | 'octagon';

export const SHAPES: { id: Shape; icon: string; label: string; hint: string }[] = [
  { id: 'line', icon: '▬', label: 'Line', hint: 'click for one piece, or press and drag for a straight run' },
  { id: 'path', icon: '⌇', label: 'Path', hint: 'click to add corners · double-click or Enter to build · click the first point to close · Backspace removes the last corner' },
  { id: 'rect', icon: '▭', label: 'Rectangle', hint: 'press at one corner and drag to the opposite corner' },
  { id: 'square', icon: '◻', label: 'Square', hint: 'press at the centre and drag out: the corner follows the pointer, so you can turn it' },
  { id: 'circle', icon: '○', label: 'Circle', hint: 'press at the centre and drag out to the radius' },
  { id: 'ellipse', icon: '⬭', label: 'Ellipse', hint: 'press at one corner and drag to the opposite corner of its box' },
  { id: 'triangle', icon: '△', label: 'Triangle', hint: 'press at the centre and drag out: a corner follows the pointer' },
  { id: 'hexagon', icon: '⬡', label: 'Hexagon', hint: 'press at the centre and drag out: a corner follows the pointer' },
  { id: 'octagon', icon: '⯃', label: 'Octagon', hint: 'press at the centre and drag out: a corner follows the pointer' },
];

/** Figures drawn by dragging (the others are a line or built from clicked corners). */
export const isFigure = (s: Shape) => s !== 'line' && s !== 'path';

const SIDES: Partial<Record<Shape, number>> = { square: 4, triangle: 3, hexagon: 6, octagon: 8 };
const ROUND = 48;   // a circle or ellipse is a 48-sided figure, so its pieces follow the curve closely

/** Turn a segment from `a` towards `b` to the nearest multiple of 45 degrees (what the pen does unless Alt is held). */
export function snap45(a: P, b: P): P {
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz); if (l < 1e-6) return { x: b.x, z: b.z };
  const ang = Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: a.x + Math.cos(ang) * l, z: a.z + Math.sin(ang) * l };
}

/** The outline of a figure dragged from `a` to `b`: its corners in order, and that it is closed. Rectangles and ellipses use a and b as opposite corners of their box;
 *  the rest are regular figures centred on a, with one corner at b (so they turn as the pointer turns). */
export function figureOutline(shape: Shape, a: P, b: P): P[] {
  if (shape === 'rect') return [a, { x: b.x, z: a.z }, b, { x: a.x, z: b.z }];
  if (shape === 'ellipse') {
    const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2, rx = Math.abs(b.x - a.x) / 2, rz = Math.abs(b.z - a.z) / 2;
    return Array.from({ length: ROUND }, (_, i) => { const t = (i / ROUND) * Math.PI * 2; return { x: cx + Math.cos(t) * rx, z: cz + Math.sin(t) * rz }; });
  }
  const r = Math.hypot(b.x - a.x, b.z - a.z), a0 = Math.atan2(b.z - a.z, b.x - a.x);
  if (shape === 'circle') return Array.from({ length: ROUND }, (_, i) => { const t = a0 + (i / ROUND) * Math.PI * 2; return { x: a.x + Math.cos(t) * r, z: a.z + Math.sin(t) * r }; });
  const n = SIDES[shape] ?? 4;
  return Array.from({ length: n }, (_, i) => { const t = a0 + (i / n) * Math.PI * 2; return { x: a.x + Math.cos(t) * r, z: a.z + Math.sin(t) * r }; });
}

export interface Piece { x: number; z: number; heading: number }

/** Pieces along a path, `spacing` apart (measured along the path). There is always a piece on every corner, so walls close up at the bends: when the last piece
 *  before a corner is too far away a new one is put on the corner, and when it is close the piece is moved onto the corner. `heading` is the direction the path runs there. */
export function samplePath(pts: P[], closed: boolean, spacing: number): Piece[] {
  const v = closed && pts.length > 2 ? [...pts, pts[0]] : [...pts];
  if (v.length === 0) return [];
  const dir = (i: number) => Math.atan2(v[i + 1].z - v[i].z, v[i + 1].x - v[i].x);
  const out: Piece[] = [{ x: v[0].x, z: v[0].z, heading: v.length > 1 ? dir(0) : 0 }];
  let carry = 0;
  for (let i = 0; i + 1 < v.length; i++) {
    const a = v[i], b = v[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z); if (L < 1e-6) continue;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L, heading = Math.atan2(uz, ux);
    let pos = 0, onCorner = false;
    while (carry + (L - pos) >= spacing - 1e-6) {
      pos += spacing - carry; carry = 0;
      const q = Math.min(pos, L); out.push({ x: a.x + ux * q, z: a.z + uz * q, heading });
      if (pos >= L - 1e-6) { onCorner = true; break; }
    }
    if (onCorner) continue;
    carry += L - pos;
    // a bend sharper than 25 degrees (or the end of the path) needs a piece right on it; a gentle curve just carries on
    let turn = Math.PI; if (i + 2 < v.length) { turn = Math.abs(Math.atan2(Math.sin(dir(i + 1) - heading), Math.cos(dir(i + 1) - heading))); }
    if (turn < 0.44) continue;
    if (carry > spacing * 0.25) out.push({ x: b.x, z: b.z, heading }); else out[out.length - 1] = { x: b.x, z: b.z, heading };
    carry = 0;
  }
  if (closed && out.length > 2) {   // the last corner is the first one again
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(l.x - f.x, l.z - f.z) < spacing * 0.5) out.pop();
  }
  return out;
}

/** A wall piece's turn in 45-degree steps (0..7) for a heading in radians; the world's rotation counts the other way round on the z axis. */
export const rotOf = (heading: number) => ((Math.round(Math.atan2(-Math.sin(heading), Math.cos(heading)) / (Math.PI / 4)) % 8) + 8) % 8;

/** Where a corner click lands: on the first corner of an unfinished path (so the path closes) when it is near and there are at least three corners. */
export function closesPath(pts: P[], p: P, within: number): boolean { return pts.length >= 3 && Math.hypot(p.x - pts[0].x, p.z - pts[0].z) <= within; }

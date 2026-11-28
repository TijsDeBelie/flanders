import * as THREE from 'three';

/** A box with softened edges, for the chunky, toy-like look: each face is drawn a little smaller, with a narrow bevel strip along every edge and a small
 *  triangle at every corner. It has the same 24 vertices as a plain box (each face's four corners, with that face's normal), so the light blends across the
 *  bevel from one face's shade to the next, which reads as a rounded edge; 44 triangles instead of 12.
 *
 *  UVs follow the plain box's layout (one texture repeat per `tile` world units, starting at a face's corner), worked out from each vertex's position, so a
 *  texture runs across the bevel without a seam and the half-timber panels and stone courses line up with the edges as before. */
export function chamferBox(w: number, h: number, d: number, r: number, tile: number): THREE.BufferGeometry {
  const H = [w / 2, h / 2, d / 2];
  r = Math.max(0, Math.min(r, H[0] * 0.9, H[1] * 0.9, H[2] * 0.9));
  // the faces: axis, sign, and the axes of u and v with their directions (the same orientation as BoxGeometry's faces)
  const faces: { a: number; s: number; u: number; us: number; v: number; vs: number }[] = [
    { a: 0, s: 1, u: 2, us: -1, v: 1, vs: 1 }, { a: 0, s: -1, u: 2, us: 1, v: 1, vs: 1 },
    { a: 1, s: 1, u: 0, us: 1, v: 2, vs: -1 }, { a: 1, s: -1, u: 0, us: 1, v: 2, vs: 1 },
    { a: 2, s: 1, u: 0, us: 1, v: 1, vs: 1 }, { a: 2, s: -1, u: 0, us: -1, v: 1, vs: 1 },
  ];
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  /** vertex index of face f at the corner whose signs on the other two axes are given (key: face, then sign per axis) */
  const at = new Map<string, number>();
  faces.forEach((f, fi) => {
    for (const cu of [-1, 1]) for (const cv of [-1, 1]) {
      const p = [0, 0, 0]; p[f.a] = f.s * H[f.a]; p[f.u] = cu * (H[f.u] - r); p[f.v] = cv * (H[f.v] - r);
      const n = [0, 0, 0]; n[f.a] = f.s;
      pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]);
      uv.push((f.us * p[f.u] + H[f.u]) / tile, (f.vs * p[f.v] + H[f.v]) / tile);
      const sg = [0, 0, 0]; sg[f.a] = f.s; sg[f.u] = cu; sg[f.v] = cv;
      at.set(`${fi}:${sg.join(',')}`, pos.length / 3 - 1);
    }
  });
  const faceOf = (a: number, s: number) => faces.findIndex(f => f.a === a && f.s === s);
  const v = (a: number, s: number, sg: number[]) => at.get(`${faceOf(a, s)}:${sg.join(',')}`)!;
  const centre = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
  /** a triangle, wound to face outwards */
  const tri = (i: number, j: number, k: number) => {
    pa.fromArray(pos, i * 3); pb.fromArray(pos, j * 3); pc.fromArray(pos, k * 3);
    e1.subVectors(pb, pa); e2.subVectors(pc, pa); e1.cross(e2);
    centre.copy(pa).add(pb).add(pc);   // (the box is centred on the origin: outwards is away from it)
    if (e1.dot(centre) >= 0) idx.push(i, j, k); else idx.push(i, k, j);
  };
  const quad = (a: number, b: number, c: number, d: number) => { tri(a, b, c); tri(a, c, d); };
  // the six faces
  faces.forEach(f => {
    const sg = (cu: number, cv: number) => { const s = [0, 0, 0]; s[f.a] = f.s; s[f.u] = cu; s[f.v] = cv; return s; };
    quad(v(f.a, f.s, sg(-1, -1)), v(f.a, f.s, sg(1, -1)), v(f.a, f.s, sg(1, 1)), v(f.a, f.s, sg(-1, 1)));
  });
  if (r > 0) {
    // the twelve bevel strips: between face (a, sa) and face (b, sb), running along the third axis c
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      const c = 3 - a - b;
      for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
        const s = (sc: number) => { const g = [0, 0, 0]; g[a] = sa; g[b] = sb; g[c] = sc; return g; };
        quad(v(a, sa, s(-1)), v(a, sa, s(1)), v(b, sb, s(1)), v(b, sb, s(-1)));
      }
    }
    // the eight corners
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) { const g = [sx, sy, sz]; tri(v(0, sx, g), v(1, sy, g), v(2, sz, g)); }
  }
  const geo = new THREE.BufferGeometry();
  (geo as { type: string }).type = 'ChamferBoxGeometry';   // (a box to the model audit in buildings.ts, which lets boxes overlap)
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/** How round a box's edges are: a share of its smallest side, capped, so walls get a soft edge and beams a slight one. 0 for small trim, which is too small
 *  to show a bevel from the game's camera and too numerous to pay for one (quoins, joists, shutters, rafter tails). */
export function bevelFor(w: number, h: number, d: number): number {
  const small = Math.min(w, h, d);
  if (small < 0.12 || w * w + h * h + d * d < 1.2) return 0;
  return Math.min(0.24, small * 0.22);
}

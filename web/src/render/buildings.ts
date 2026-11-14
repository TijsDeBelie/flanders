import * as THREE from 'three';
import { packFlag, type Flag } from '../flag';
import { flagTexture } from './flagtex';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------- procedural textures & materials ----------
const TILE = 2; // one texture repeat covers 2 world units
function tex(paint: (g: CanvasRenderingContext2D, s: number) => void, s = 256) {
  const c = document.createElement('canvas'); c.width = c.height = s;
  paint(c.getContext('2d')!, s);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.userData.canvas = c;
  return t;
}
const speckle = (g: CanvasRenderingContext2D, s: number, n: number, a: number) => {
  for (let i = 0; i < n; i++) { const v = Math.random() > 0.5 ? 255 : 0; g.fillStyle = `rgba(${v},${v},${v},${Math.random() * a})`; g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2); }
};
function rows(g: CanvasRenderingContext2D, s: number, base: string, lines: string, rowsN: number, stagger: boolean, cols: number, jitter = 18) {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  const rh = s / rowsN, cw = s / cols;
  for (let r = 0; r < rowsN; r++) for (let c = -1; c < cols; c++) {
    const off = stagger && r % 2 ? cw / 2 : 0, v = Math.random() * jitter - jitter / 2;
    g.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 90})`;
    g.fillRect(c * cw + off, r * rh, cw, rh);
    g.strokeStyle = lines; g.lineWidth = 2; g.strokeRect(c * cw + off, r * rh, cw, rh);
  }
  speckle(g, s, 500, 0.12);
}
/** Derive a tangent-space normal map from a painted texture: dark mortar, grooves and gaps become recesses, light parts stand proud. */
function normalFrom(c: HTMLCanvasElement, strength: number) {
  const s = c.width, src = c.getContext('2d')!.getImageData(0, 0, s, s).data, h = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) h[i] = (src[i * 4] * 0.3 + src[i * 4 + 1] * 0.59 + src[i * 4 + 2] * 0.11) / 255;
  const out = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const l = h[y * s + ((x + s - 1) % s)], r = h[y * s + ((x + 1) % s)], u = h[((y + s - 1) % s) * s + x], d = h[((y + 1) % s) * s + x];
    let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1; const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    out.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255], (y * s + x) * 4);
  }
  const t = new THREE.DataTexture(out, s, s, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}
let _m: ReturnType<typeof makeMats> | null = null;
function makeMats() {
  const std = (map: THREE.Texture | null, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ map, normalMap: map ? normalFrom(map.userData.canvas, 3.2) : null, normalScale: new THREE.Vector2(1, 1), vertexColors: true, roughness: 0.92, metalness: 0, ...extra });
  const col = (c: number, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: c, vertexColors: true, roughness: 0.9, ...extra });
  return {
    wood: std(tex((g, s) => { g.fillStyle = '#7a5a3a'; g.fillRect(0, 0, s, s); for (let i = 0; i < 8; i++) { g.fillStyle = `rgba(${Math.random() > 0.5 ? '40,25,10' : '200,160,110'},0.25)`; g.fillRect(i * s / 8, 0, s / 8 - 2, s); g.fillStyle = 'rgba(30,18,8,.55)'; g.fillRect(i * s / 8 - 1, 0, 2, s); } speckle(g, s, 600, 0.2); })),
    darkwood: std(tex((g, s) => { g.fillStyle = '#4b3524'; g.fillRect(0, 0, s, s); for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(i * s / 6, 0, 2, s); } speckle(g, s, 500, 0.2); })),
    plaster: std(tex((g, s) => { g.fillStyle = '#e4d6b4'; g.fillRect(0, 0, s, s); speckle(g, s, 1400, 0.16); for (let i = 0; i < 20; i++) { g.fillStyle = 'rgba(120,100,60,.05)'; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 8 + Math.random() * 14, 0, 7); g.fill(); } })),
    // half-timbered panel: oak frame, diagonal brace and plaster infill (one panel per texture tile)
    timber: std(tex((g, s) => {
      g.fillStyle = '#e8dcbf'; g.fillRect(0, 0, s, s); speckle(g, s, 900, 0.14);
      g.strokeStyle = '#4a3220'; g.lineCap = 'square';
      g.lineWidth = 11; g.strokeRect(5, 5, s - 10, s - 10);
      g.lineWidth = 7; g.beginPath(); g.moveTo(s / 2, 4); g.lineTo(s / 2, s - 4); g.stroke();
      g.lineWidth = 6; g.beginPath(); g.moveTo(6, s - 6); g.lineTo(s / 2 - 3, s * 0.45); g.moveTo(s - 6, s - 6); g.lineTo(s / 2 + 3, s * 0.45); g.stroke();
    })),
    // Flemish brickwork with pale stone bands
    flemish: std(tex((g, s) => {
      rows(g, s, '#a8553a', 'rgba(60,30,22,.8)', 8, true, 5, 55);
      for (const y of [s * 0.25, s * 0.75]) { g.fillStyle = '#d8cfba'; g.fillRect(0, y - 4, s, 8); g.fillStyle = 'rgba(60,50,40,.35)'; g.fillRect(0, y + 4, s, 1.5); }
      speckle(g, s, 400, 0.12);
    })),
    mud: std(tex((g, s) => { g.fillStyle = '#a58a62'; g.fillRect(0, 0, s, s); speckle(g, s, 1800, 0.25); for (let i = 0; i < 14; i++) { g.fillStyle = 'rgba(80,60,35,.12)'; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 6 + Math.random() * 14, 0, 7); g.fill(); } })),
    cobble: std(tex((g, s) => { g.fillStyle = '#6f6b64'; g.fillRect(0, 0, s, s); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const v = 120 + Math.random() * 70; g.fillStyle = `rgb(${v},${v - 4},${v - 10})`; g.beginPath(); g.ellipse(x * s / 8 + s / 16 + (y % 2) * s / 16, y * s / 8 + s / 16, s / 18, s / 22, 0, 0, 7); g.fill(); } })),
    stoneMat: col(0xbdb4a0),
    shutter: col(0x3f6a4a), shutterRed: col(0x8a2f26), shutterBlue: col(0x2f4f7a),
    stone: std(tex((g, s) => rows(g, s, '#9a968d', 'rgba(50,48,44,.7)', 5, true, 4, 40))),
    darkstone: std(tex((g, s) => rows(g, s, '#6e6c68', 'rgba(25,25,25,.7)', 5, true, 4, 40))),
    brick: std(tex((g, s) => rows(g, s, '#a4553b', 'rgba(70,35,25,.8)', 8, true, 5, 50))),
    thatch: std(tex((g, s) => { g.fillStyle = '#b99a55'; g.fillRect(0, 0, s, s); for (let i = 0; i < 420; i++) { g.strokeStyle = `rgba(${Math.random() > 0.5 ? '90,66,30' : '230,200,120'},${0.2 + Math.random() * 0.3})`; g.lineWidth = 1 + Math.random(); const x = Math.random() * s; g.beginPath(); g.moveTo(x, Math.random() * s); g.lineTo(x + (Math.random() - 0.5) * 6, Math.random() * s); g.stroke(); } })),
    tile: std(tex((g, s) => rows(g, s, '#b4562f', 'rgba(70,25,10,.8)', 6, true, 6, 50))),
    slate: std(tex((g, s) => rows(g, s, '#4f5560', 'rgba(15,18,24,.8)', 6, true, 5, 40))),
    field: std(tex((g, s) => { g.fillStyle = '#7b8c3e'; g.fillRect(0, 0, s, s); for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? 'rgba(180,170,70,.55)' : 'rgba(80,60,30,.35)'; g.fillRect(0, i * s / 10, s, s / 10 - 3); } speckle(g, s, 500, 0.15); }), { roughness: 1 }),
    glass: col(0x203040, { roughness: 0.2, metalness: 0.3 }),
    door: col(0x3a2616),
    iron: col(0x2b2b2e, { metalness: 0.6, roughness: 0.5 }),
    gold: col(0xe9bb3a, { metalness: 0.9, roughness: 0.25, emissive: 0x6a4a00, emissiveIntensity: 0.5 }),
    goldPile: col(0xf5c518, { metalness: 0.8, roughness: 0.3, emissive: 0x8a6400, emissiveIntensity: 0.7 }),
    ironPile: col(0x8a4a30, { roughness: 0.8 }),
    clay: col(0xb5693a, { roughness: 0.75 }),
    earth: col(0x4a3a2a, { roughness: 1 }),
    mound: col(0x5a4630, { roughness: 1 }),
    glow: col(0xff8a2a, { emissive: 0xff6a10, emissiveIntensity: 2.4 }),
    hay: col(0xd9b95a),
    log: col(0x8a6842),
    rock: col(0x8d8a85, { roughness: 1 }),
    lead: col(0x7a8390, { metalness: 0.5 }),
    stained: col(0x4a7ad8, { emissive: 0x2244aa, emissiveIntensity: 0.9 }),
    stained2: col(0xd84a5a, { emissive: 0xaa2233, emissiveIntensity: 0.9 }),
  };
}
const M = () => (_m ??= makeMats());
/** Wall materials by tier: palisade, timber, stone, battlemented stone. */
/** Kinds drawn by something else (walls, fences and gates by the Walls mesh, moats by the terrain): an empty placeholder keeps the indices lined up. */
const PLAIN = new Set([2, 21, 22, 24, 32, 33, 34, 37, 38]);
export const wallMats = (): THREE.MeshStandardMaterial[] => [M().wood, M().timber, M().stone, M().stone];

// ---------- geometry helpers ----------
function uvBox(g: THREE.BoxGeometry, w: number, h: number, d: number) {
  const uv = g.attributes.uv, ext = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) { const i = f * 4 + v; uv.setXY(i, uv.getX(i) * ext[f][0] / TILE, uv.getY(i) * ext[f][1] / TILE); }
}

class B {
  g = new THREE.Group();
  smoke: THREE.Vector3[] = [];
  spin: THREE.Object3D[] = [];
  /** Parts that swing (a drawbridge deck): kept out of the merged mesh. */
  deck: THREE.Object3D[] = [];
  constructor(public t: number, public banner: number, public flagDesign?: Flag) {}
  /** Bake cheap ambient occlusion into vertex colours: darker near the ground and on undersides (eaves, overhangs), lighter on top. */
  private shade(geo: THREE.BufferGeometry, baseY: number) {
    if (geo.attributes.color || !geo.attributes.position) return;
    const p = geo.attributes.position, n = geo.attributes.normal, c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const wy = baseY + p.getY(i), t = Math.min(1, Math.max(0, wy / 1.6)), ny = n ? n.getY(i) : 0;
      let ao = 0.64 + 0.36 * t * t * (3 - 2 * t);
      if (ny < -0.45) ao *= 0.58; else if (ny > 0.6) ao *= 1.07;
      c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  private add<T extends THREE.Object3D>(o: T, x: number, y: number, z: number) { o.position.set(x, y, z); o.traverse(c => { const m = c as THREE.Mesh; m.castShadow = true; m.receiveShadow = true; if (m.isMesh) this.shade(m.geometry, y); }); this.g.add(o); return o; }
  box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, ry = 0) {
    const geo = new THREE.BoxGeometry(w, h, d); uvBox(geo, w, h, d);
    const m = this.add(new THREE.Mesh(geo, mat), x, y + h / 2, z); m.rotation.y = ry; return m;
  }
  /** Gable roof: ridge along local X, w = ridge length, d = span across. It has a thick lip at the eaves, rafter tails
   *  poking out underneath and a ridge beam that sticks out past the gable ends, so it reads as a real overhanging roof. */
  gable(w: number, d: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, o = 0.35) {
    const lip = mat === M().thatch ? 0.34 : 0.17, e = d / 2 + o;
    const sh = new THREE.Shape(); sh.moveTo(-e, -lip); sh.lineTo(e, -lip); sh.lineTo(e, 0); sh.lineTo(0, h); sh.lineTo(-e, 0); sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth: w + o * 2, bevelEnabled: false });
    geo.translate(0, 0, -(w + o * 2) / 2); geo.rotateY(Math.PI / 2);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / TILE, uv.getY(i) / TILE);
    const grp = new THREE.Group(), wood = M().darkwood;
    grp.add(new THREE.Mesh(geo, mat));
    if (o >= 0.3 && w >= 2) {
      const tail = new THREE.BoxGeometry(0.13, 0.17, 0.55);
      for (let k = -w / 2 + 0.35; k <= w / 2 - 0.3; k += 0.8) for (const sd of [-1, 1]) { const t = new THREE.Mesh(tail, wood); t.position.set(k, -lip - 0.06, sd * (e - 0.28)); t.rotation.x = sd * 0.25; grp.add(t); }
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(w + o * 2 + 0.7, 0.17, 0.17), wood); ridge.position.set(0, h + 0.03, 0); grp.add(ridge);
      for (const sd of [-1, 1]) { const knob = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), wood); knob.position.set(sd * (w / 2 + o + 0.38), h + 0.03, 0); grp.add(knob); }
    }
    return this.add(grp, x, y, z);
  }
  /** Gable roof whose ridge runs along local Z (gable ends face front and back). */
  gableZ(len: number, span: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, o = 0.35) {
    const m = this.gable(len, span, h, mat, x, y, z, o); m.rotation.y = Math.PI / 2; return m;
  }
  /** Flemish crow-stepped gable: a wall of stacked, narrowing blocks capped by a pinnacle. */
  stepGable(w: number, thick: number, y: number, pos: number, mat: THREE.Material, steps = 4, off = 0, ax: 'x' | 'z' = 'z') {
    const sh = 0.55;
    for (let i = 0; i < steps; i++) {
      const ww = w * (1 - (i + 0.6) / (steps + 0.8));
      if (ax === 'z') this.box(ww, sh, thick, mat, off, y + i * sh, pos); else this.box(thick, sh, ww, mat, pos, y + i * sh, off);
    }
    if (ax === 'z') this.box(0.28, 0.5, 0.28, M().stoneMat, off, y + steps * sh - 0.05, pos); else this.box(0.28, 0.5, 0.28, M().stoneMat, pos, y + steps * sh - 0.05, off);
  }
  stoneMat: THREE.Material = new THREE.MeshStandardMaterial({ color: 0xd8cfba, roughness: 0.9 });
  shutters(x: number, y: number, z: number, mat: THREE.Material, ry = 0, gap = 0.5) {
    for (const s of [-1, 1]) { const m = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.7, 0.06), mat), x + Math.cos(ry) * s * gap, y, z - Math.sin(ry) * s * gap); m.rotation.y = ry; }
  }
  /** A horizontal log lying along 'x' or 'z', centred at (x, y, z). `end` adds a lighter cut face at both ends. */
  logH(len: number, r: number, mat: THREE.Material, x: number, y: number, z: number, axis: 'x' | 'z' = 'x') {
    const geo = new THREE.CylinderGeometry(r, r, len, 9); const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * r * 3 / TILE, uv.getY(i) * len / TILE);
    const m = this.add(new THREE.Mesh(geo, mat), x, y, z); if (axis === 'x') m.rotation.z = Math.PI / 2; else m.rotation.x = Math.PI / 2; return m;
  }
  cyl(rt: number, rb: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 14) {
    const geo = new THREE.CylinderGeometry(rt, rb, h, seg); const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(rt, rb) * 3 / TILE, uv.getY(i) * h / TILE);
    return this.add(new THREE.Mesh(geo, mat), x, y + h / 2, z);
  }
  cone(r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 14) {
    const geo = new THREE.ConeGeometry(r, h, seg); const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * r * 3 / TILE, uv.getY(i) * h / TILE);
    return this.add(new THREE.Mesh(geo, mat), x, y + h / 2, z);
  }
  pyramid(w: number, d: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
    const geo = new THREE.ConeGeometry(1, h, 4); geo.rotateY(Math.PI / 4); geo.scale(w / 1.4142, 1, d / 1.4142);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / TILE, uv.getY(i) * h / TILE);
    return this.add(new THREE.Mesh(geo, mat), x, y + h / 2, z);
  }
  dome(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, sy = 1) {
    const geo = new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2); geo.scale(1, sy, 1);
    return this.add(new THREE.Mesh(geo, mat), x, y, z);
  }
  sphere(r: number, mat: THREE.Material, x = 0, y = 0, z = 0) { return this.add(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat), x, y, z); }
  window(x: number, y: number, z: number, ry = 0, w = 0.5, h = 0.65) {
    const m = this.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), M().glass), x, y, z); m.rotation.y = ry;
    const f = this.add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, h + 0.16, 0.08), M().darkwood), x, y, z); f.rotation.y = ry;
    f.translateZ(-0.02);
    const sill = this.add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.34, 0.08, 0.26), M().stoneMat), x, y - h / 2 - 0.12, z); sill.rotation.y = ry; sill.translateZ(0.07);
    const lintel = this.add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.26, 0.1, 0.16), M().darkwood), x, y + h / 2 + 0.13, z); lintel.rotation.y = ry; lintel.translateZ(0.03);
  }
  /** Beam ends sticking out of a wall at floor level, as on a jettied timber house. */
  joists(width: number, y: number, zFace: number, n = 5, side = 1) {
    for (let i = 0; i < n; i++) { const x = -width / 2 + (i + 0.5) * (width / n); this.box(0.17, 0.2, 0.6, M().darkwood, x, y, side * zFace); }
  }
  /** Stone quoins: corner blocks laid alternately long and short, standing slightly proud of the wall. */
  quoins(w: number, d: number, h: number, y0 = 0.4) {
    const mat = M().stoneMat;
    for (let k = 0; k < Math.floor(h / 0.62); k++) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const long = (k + (sx > 0 ? 1 : 0) + (sz > 0 ? 1 : 0)) % 2 === 0;
      this.box(long ? 0.78 : 0.42, 0.56, long ? 0.42 : 0.78, mat, sx * (w / 2 + 0.02), y0 + k * 0.62, sz * (d / 2 + 0.02));
    }
  }
  flag(x: number, y: number, z: number, h = 2.2) {
    this.cyl(0.05, 0.05, h, M().darkwood, x, y, z, 6);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), this.flagDesign ? new THREE.MeshStandardMaterial({ map: flagTexture(this.flagDesign), side: THREE.DoubleSide, roughness: 0.8 }) : new THREE.MeshStandardMaterial({ color: this.banner, side: THREE.DoubleSide, roughness: 0.8 }));
    cloth.userData.fixed = true; this.add(cloth, x + 0.55, y + h - 0.4, z);
    this.spin.push(cloth); // waves
  }
  chimney(x: number, y: number, z: number, h = 1.4, mat: THREE.Material = M().stone) { this.box(0.6, h, 0.6, mat, x, y, z); this.smoke.push(new THREE.Vector3(x, y + h + 0.1, z)); }
  battlements(w: number, d: number, y: number, mat: THREE.Material, h = 0.45, n = 6) {
    for (let i = 0; i < n; i++) { const x = -w / 2 + (i + 0.5) * (w / n); this.box(w / n * 0.55, h, 0.35, mat, x, y, d / 2 - 0.2); this.box(w / n * 0.55, h, 0.35, mat, x, y, -d / 2 + 0.2); }
    for (let i = 1; i < n - 1; i++) { const z = -d / 2 + (i + 0.5) * (d / n); this.box(0.35, h, d / n * 0.55, mat, w / 2 - 0.2, y, z); this.box(0.35, h, d / n * 0.55, mat, -w / 2 + 0.2, y, z); }
  }
}


// ---------- per-building variation and fire damage ----------
const variantCache = new Map<string, THREE.Material>();
const glows = (m: THREE.Mesh) => ((m.material as THREE.MeshStandardMaterial).emissiveIntensity ?? 0) >= 1.5;
function variantOf(mat: THREE.Material, v: number): THREE.Material {
  const key = mat.uuid + ':' + v; let c = variantCache.get(key);
  if (!c) {
    c = mat.clone(); const sm = c as THREE.MeshStandardMaterial;
    if (v === -1) { sm.color.multiplyScalar(0.22); sm.roughness = 1; if (sm.emissive) sm.emissive.setHex(0x1a0600); }
    else { const shade = 0.88 + v * 0.07; sm.color.multiplyScalar(shade); sm.color.offsetHSL((v - 1.5) * 0.012, 0, 0); }
    variantCache.set(key, c);
  }
  return c;
}
/** Give each building its own slight colour variation (v in 0..3) so villages do not look cloned. */
export function applyVariant(g: THREE.Object3D, v: number) {
  g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.fixed && !glows(m)) { if (!m.userData.base) m.userData.base = m.material; m.material = variantOf(m.userData.base, v); } });
}
/** Scorch a building (burning or burnt) or restore it. */
export function setCharred(g: THREE.Object3D, on: boolean, v = 0) {
  g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.fixed && !glows(m)) { if (!m.userData.base) m.userData.base = m.material; m.material = on ? variantOf(m.userData.base, -1) : variantOf(m.userData.base, v); } });
}

// ---------- building models (origin = pad level, +Z is the front) ----------
type Model = (b: B) => void;
const wallMat = (t: number) => [M().wood, M().plaster, M().stone, M().stone][t];
const roofMat = (t: number) => [M().thatch, M().tile, M().slate, M().slate][t];


const farm: Model = b => {
  const t = b.t, m = M();
  b.box(10.4, 0.1, 8.4, m.field, 0, 0.02, 1.4);
  const bm = t >= 2 ? m.stone : t >= 1 ? m.timber : m.wood;
  b.box(4, 2.4, 3, bm, -1.2, 0.2, -2.6); b.gable(4, 3, 1.8 + t * 0.2, t >= 1 ? m.tile : m.thatch, -1.2, 2.6, -2.6, 0.45);
  b.box(1.5, 1.7, 0.12, m.door, -1.2, 0.2, -1.05);
  b.cyl(0.8, 0.8, 0.9, m.hay, 3.2, 0.1, -3, 10); b.cyl(0.65, 0.65, 0.75, m.hay, 4.3, 0.1, -2.4, 10);
  if (t >= 1) { b.cyl(0.95, 1.0, 4.2, t >= 2 ? m.stone : m.wood, 2.8, 0.1, -3.4, 14); b.cone(1.1, 1.0, m.slate, 2.8, 4.3, -3.4, 14); }
  if (t >= 2) {
    b.cyl(0.4, 0.85, 4.2, m.plaster, -4.6, 0.1, 2.8, 12); b.cone(0.75, 1.1, m.thatch, -4.6, 4.3, 2.8, 12);
    const bl = new THREE.Group(); for (let i = 0; i < 4; i++) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.4, 0.05), m.wood); arm.position.y = 1.7; const w = new THREE.Group(); w.add(arm); w.rotation.z = i * Math.PI / 2; bl.add(w); }
    bl.position.set(-4.6, 4.2, 3.7); b.g.add(bl); b.spin.push(bl);
  }
  if (t === 3) b.flag(-1.2, 4.2, -2.6, 1.8);
};

const wall: Model = b => {
  const t = b.t, h = 2.3 + t * 1.0, L = 5.4, m = M();
  b.box(L, 3, 1.5, t >= 2 ? m.stone : m.earth, 0, -3, 0); // foundation hides uneven ground
  if (t === 0) {   // the basic wall: plain upright planks
    b.box(L, h, 1.0, m.wood, 0, 0, 0); b.box(L + 0.2, 0.2, 1.2, m.darkwood, 0, h, 0);
  } else if (t === 1) { b.box(L, h, 1.2, m.wood, 0, 0, 0); b.box(L + 0.3, 0.25, 1.5, m.darkwood, 0, h, 0); for (const x of [-L / 2, 0, L / 2]) b.box(0.4, h + 0.5, 0.5, m.darkwood, x, 0, 0); }
  else { b.box(L, h, 1.4, m.stone, 0, 0, 0); if (t === 3) { b.battlements(L, 1.4, h, m.stone, 0.55, 5); b.box(L + 0.2, 0.3, 1.6, m.darkstone, 0, h - 0.15, 0); } else b.box(L, 0.3, 1.7, m.darkstone, 0, h, 0); }
};

const tower: Model = b => {
  // every tier has an open walkway on top (archers stand on it: see TOWER_TOP / TOWER_RING in army.ts) and a door at the foot
  const t = b.t, m = M();
  const door = (z: number, w = 1.0, h = 1.9) => { b.box(w, h, 0.35, m.door, 0, 0, z); b.box(w + 0.35, 0.25, 0.45, m.darkstone, 0, h, z); for (const s of [-1, 1]) b.box(0.15, h, 0.42, m.darkstone, s * (w / 2 + 0.08), 0, z); };
  const parapet = (r: number, y: number, mat: THREE.Material, n = 10) => { for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; b.box(0.55, 0.6, 0.45, mat, Math.cos(a) * r, y, Math.sin(a) * r, -a); } };
  if (t === 0) {
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.3, 5.2, 0.3, m.log, x, -0.2, z);
    b.box(2.9, 0.3, 2.9, m.wood, 0, 4.9, 0);
    for (const [x, z, w, d] of [[0, 1.4, 2.9, 0.15], [0, -1.4, 2.9, 0.15], [1.4, 0, 0.15, 2.9], [-1.4, 0, 0.15, 2.9]]) b.box(w, 0.9, d, m.wood, x, 5.2, z);
    b.pyramid(3.6, 3.6, 1.6, m.thatch, 0, 6.8, 0);
    for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) b.box(0.15, 1.6, 0.15, m.log, x, 5.2, z);
    b.box(1.8, 1.9, 0.12, m.door, 0, 0, 0.98);                                            // boarded door between the front legs
    for (const s of [-0.35, 0.35]) b.box(0.08, 5.0, 0.08, m.darkwood, s, 0, 1.6);         // ladder up to the platform
    for (let y = 0.4; y < 4.9; y += 0.5) b.box(0.7, 0.06, 0.06, m.darkwood, 0, y, 1.6);
  } else if (t === 1) {
    b.cyl(1.7, 1.9, 4.6, m.stone, 0, -0.2, 0, 14); b.cyl(2.1, 2.1, 0.4, m.darkwood, 0, 4.2, 0, 14);
    parapet(1.95, 4.6, m.wood, 12);
    for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) b.box(0.16, 1.8, 0.16, m.log, x, 4.6, z);
    b.pyramid(4.4, 4.4, 1.7, m.tile, 0, 6.4, 0);
    door(2.0); b.window(0, 3.0, 1.74, 0, 0.3, 0.6);
  } else {
    const r = t === 2 ? 1.8 : 2.2, H = t === 2 ? 7.2 : 9;
    b.cyl(r, r + 0.35, H, m.stone, 0, -0.3, 0, 16); b.cyl(r + 0.35, r + 0.45, 0.5, m.darkstone, 0, H - 0.4, 0, 16);
    parapet(r + 0.3, H + 0.1, m.stone);
    b.cyl(r * 0.6, r * 0.7, 1.2, m.stone, 0, H, 0, 12); b.cone(r * 0.75, 2.2, m.slate, 0, H + 1.2, 0, 12);   // a stair turret in the middle; the ring round it is the walkway
    if (t === 3) b.flag(0, H + 3, 0, 2.2);
    door(r + 0.3, 1.1, 2.1);
    for (const y of [3.6, 5.2]) b.window(0, y, r + 0.12, 0, 0.35, 0.8);
  }
};

const woodcutter: Model = b => {
  const t = b.t, m = M();
  b.box(3.2, 2, 2.6, t >= 1 ? m.timber : m.wood, -0.2, 0, -0.3); b.gable(3.2, 2.6, 1.3 + t * 0.2, t >= 1 ? m.tile : m.thatch, -0.2, 2, -0.3, 0.35);
  b.box(0.8, 1.4, 0.12, m.door, 0, 0, 1.03);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3 - i; j++) { b.logH(2.2, 0.28, m.log, 2.1, 0.28 + i * 0.5, -1 + j * 0.58 + i * 0.29, 'x'); }
  b.cyl(0.55, 0.6, 0.7, m.log, -2.3, 0, 1.6, 10); b.box(0.12, 0.9, 0.12, m.darkwood, -2.2, 0.7, 1.6);
  if (t >= 2) b.chimney(0.8, 2.4, -0.8);
};

const sawmill: Model = b => {
  const t = b.t, m = M();
  for (const [x, z] of [[-2.4, -1.6], [2.4, -1.6], [-2.4, 1.6], [2.4, 1.6]]) b.box(0.35, 2.6, 0.35, m.darkwood, x, 0, z);
  b.gable(5.4, 4, 1.6, t >= 1 ? m.tile : m.thatch, 0, 2.6, 0, 0.5);
  b.box(4.4, 0.7, 1, m.wood, 0, 0, 0); b.box(0.2, 1.1, 1.3, m.iron, 0.4, 0.7, 0);
  for (let i = 0; i < 3; i++) { b.logH(3.4, 0.35, m.log, -3.2, 0.35 + (i % 2) * 0.62, -2 + i * 0.7, 'x'); }
  for (let i = 0; i < 5; i++) b.box(2.6, 0.12, 0.8, m.plaster, 3.2, 0.1 + i * 0.14, 2.2);
  if (t >= 1) { const wheel = new THREE.Group(); const rim = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.12, 6, 16), m.darkwood); wheel.add(rim); for (let i = 0; i < 6; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3, 0.1), m.darkwood); sp.rotation.z = i * Math.PI / 3; wheel.add(sp); } wheel.rotation.y = Math.PI / 2; wheel.position.set(3.8, 1.6, -1); b.g.add(wheel); b.spin.push(wheel); }
};

const quarry: Model = b => {
  const t = b.t, m = M();
  b.cyl(3.6, 3.9, 0.15, m.rock, 0, -0.05, 0, 18);
  for (const [x, z, s] of [[-2.2, 1.6, 1], [2, 2, 0.8], [-1, -2.4, 1.2], [2.6, -1.4, 0.9]] as const) b.box(1.4 * s, 1 * s, 1.1 * s, m.stone, x, 0.1, z, x);
  for (const sx of [-1, 1]) { const leg = b.box(0.22, 4.4, 0.22, m.darkwood, sx * 1.1, 0, 0); leg.rotation.z = -sx * 0.22; }
  b.box(2.8, 0.22, 0.22, m.darkwood, 0, 4.2, 0); b.box(0.04, 2.4, 0.04, m.darkwood, 0.3, 1.8, 0); b.box(0.7, 0.55, 0.7, m.stone, 0.3, 1.2, 0);
  b.box(1.4, 0.7, 0.9, m.wood, 3, 0.25, -2.2); for (const x of [2.5, 3.5]) b.cyl(0.28, 0.28, 0.1, m.iron, x, 0.15, -1.7, 10).rotation.x = Math.PI / 2;
  if (t >= 1) { b.box(2.6, 1.8, 2.2, t >= 2 ? m.stone : m.wood, -3, 0, -1.8); b.gable(2.6, 2.2, 1, m.tile, -3, 1.8, -1.8); }
};

const claypit: Model = b => {
  const m = M();
  b.cyl(3.2, 3.5, 0.12, m.clay, 0, -0.05, 0, 18); b.cyl(2.2, 2.2, 0.18, m.earth, 0.3, -0.08, 0.2, 16);
  for (const [x, z, r] of [[-2.2, -1.5, 1.2], [2.3, -0.8, 0.9], [-0.6, 2.4, 0.8]] as const) b.dome(r, m.clay, x, 0, z, 0.7);
  b.box(2.4, 1.8, 2, b.t >= 1 ? m.timber : m.wood, 2.4, 0, 2); b.gable(2.4, 2, 1.1, b.t >= 1 ? m.tile : m.thatch, 2.4, 1.8, 2, 0.3);
  b.box(0.9, 0.5, 0.7, m.wood, -2.6, 0.2, 1.4); b.box(0.12, 1.1, 0.12, m.darkwood, -1.2, 0.2, 0);
};

const brickworks: Model = b => {
  const t = b.t, m = M();
  b.dome(2.1, m.brick, -0.5, 0.2, -0.3, 1.0); b.box(1.2, 1.6, 0.9, m.brick, -0.5, 0.2, 1.8); b.box(0.8, 0.8, 0.2, m.glow, -0.5, 0.25, 2.3);
  b.cyl(0.5, 0.6, 4.6, m.brick, -0.5, 1.2, -1.6, 10); b.smoke.push(new THREE.Vector3(-0.5, 6.0, -1.6));
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) b.box(0.8, 0.3, 0.5, m.brick, 2.6 + (i % 2) * 0.2, 0.1 + j * 0.31, -1.6 + i * 0.6);
  b.box(2.6, 1.8, 1.8, t >= 1 ? m.stone : m.wood, 2.6, 0, 1.8); b.gable(2.6, 1.8, 1, t >= 1 ? m.tile : m.thatch, 2.6, 1.8, 1.8, 0.3);
};

const mine = (gold: boolean): Model => b => {
  const t = b.t, m = M();
  b.dome(4, m.rock, 0, -0.6, -1.2, 0.55);
  const post = t >= 2 ? m.stone : m.darkwood;
  b.box(0.45, 2.4, 0.45, post, -1.1, 0, 1.0); b.box(0.45, 2.4, 0.45, post, 1.1, 0, 1.0); b.box(3, 0.5, 0.6, post, 0, 2.2, 1.0);
  b.box(1.8, 1.9, 0.2, new THREE.MeshBasicMaterial({ color: 0x050505 }), 0, 0, 0.85);
  for (let i = 0; i < 3; i++) b.box(0.18, 0.18, 1.2, m.iron, -0.3 + i * 0.3, 0.02, 2.5 + i * 0.5).visible = false;
  b.box(1.3, 0.7, 0.9, m.wood, 2, 0.25, 2.4, 0.4); for (const dx of [-0.4, 0.4]) b.cyl(0.25, 0.25, 0.1, m.iron, 2 + dx, 0.15, 2.9, 10).rotation.x = Math.PI / 2;
  const pile = gold ? m.goldPile : m.ironPile;
  for (const [x, z, r] of [[-2.6, 2.4, 0.9], [-1.6, 3, 0.6], [3.2, 0.6, 0.7]] as const) b.cone(r, r * 1.1, pile, x, 0, z, 7);
  if (gold) { b.box(0.9, 0.6, 0.6, m.darkwood, 3.1, 0, 3); b.box(0.92, 0.1, 0.62, m.gold, 3.1, 0.6, 3); }
  if (t >= 1) b.gable(3.4, 2.2, 1.0, t >= 2 ? m.slate : m.tile, 0, 2.6, 1.0, 0.3);
};

const charcoal: Model = b => {
  const m = M();
  b.dome(2.6, m.mound, -0.6, 0, -0.4, 0.85); b.smoke.push(new THREE.Vector3(-0.6, 2.3, -0.4));
  for (let i = 0; i < 12; i++) { const a = i / 12 * 6.28; b.box(0.12, 0.12, 1.4, m.darkwood, -0.6 + Math.cos(a) * 1.9, 0.9 + (i % 3) * 0.2, -0.4 + Math.sin(a) * 1.9, -a).visible = false; }
  b.box(2.2, 1.6, 1.8, m.wood, 2.6, 0, 1.8); b.gable(2.2, 1.8, 1, b.t >= 1 ? m.tile : m.thatch, 2.6, 1.6, 1.8, 0.3);
  for (let i = 0; i < 3; i++) { b.logH(1.8, 0.25, m.log, -2.6, 0.25 + (i % 2) * 0.45, 2.3 + i * 0.35, 'x'); }
};

const smelter: Model = b => {
  const t = b.t, m = M();
  b.box(4, 3.2, 3.2, m.darkstone, 0, 0, 0); b.box(1.4, 1.6, 0.2, m.glow, 0, 0.3, 1.65); b.box(1.8, 0.4, 0.5, m.stone, 0, 1.9, 1.6);
  b.pyramid(4.6, 3.8, 1.5, t >= 1 ? m.slate : m.thatch, 0, 3.2, 0);
  b.cyl(0.55, 0.75, 4.2, m.stone, -1.2, 2.5, -0.6, 10); b.smoke.push(new THREE.Vector3(-1.2, 6.9, -0.6));
  for (const [x, z, r] of [[3, 1.4, 0.7], [2.5, 2.4, 0.5]] as const) b.cone(r, r, m.ironPile, x, 0, z, 6);
  b.box(1.1, 0.4, 0.6, m.iron, -2.6, 0, 2); b.box(0.7, 0.5, 0.7, m.darkwood, 2.8, 0, -1.6);
};

const blacksmith: Model = b => {
  const t = b.t, m = M();
  const wm = t >= 1 ? m.stone : m.wood; b.box(3.8, 2.4, 0.3, wm, 0, 0, -1.6); b.box(0.3, 2.4, 3.2, wm, -1.8, 0, 0); b.box(0.3, 2.4, 3.2, wm, 1.8, 0, 0);
  b.gable(3.8, 3.4, 1.4, t >= 1 ? m.slate : m.thatch, 0, 2.4, 0, 0.4);
  b.box(1.1, 1.1, 1.1, m.darkstone, -0.8, 0, -0.9); b.box(0.7, 0.2, 0.7, m.glow, -0.8, 1.1, -0.9);
  b.chimney(-0.8, 3.0, -0.9, 1.8, m.darkstone); b.box(0.6, 0.55, 0.4, m.iron, 0.8, 0.45, 0.2); b.box(0.3, 0.45, 0.3, m.log, 0.8, 0, 0.2);
  b.box(1.4, 0.15, 0.7, m.wood, 1.2, 0.9, -1.1);
  b.cyl(0.4, 0.4, 0.45, m.log, 2.6, 0, 1.4, 9); b.box(0.1, 1.6, 0.1, m.darkwood, -1.9, 0, 1.9); b.box(1.0, 0.1, 0.1, m.darkwood, -1.4, 1.5, 1.9); b.box(0.5, 0.6, 0.06, m.iron, -1.4, 0.85, 1.9);
};

const mint: Model = b => {
  const t = b.t, m = M();
  b.box(4.6, 0.4, 4, m.darkstone, 0, -0.1, 0); b.box(4, 3.2, 3.4, m.stone, 0, 0.3, 0);
  b.pyramid(5.2, 4.4, 1.9, t >= 1 ? m.gold : m.slate, 0, 3.5, 0);
  for (const x of [-1.4, 1.4]) b.cyl(0.28, 0.3, 3, m.plaster, x, 0.3, 2.0, 10);
  b.box(3.4, 0.35, 0.6, m.stone, 0, 3.0, 2.0); b.box(0.9, 1.6, 0.15, m.door, 0, 0.3, 1.75);
  b.window(-1.5, 1.9, 1.72); b.window(1.5, 1.9, 1.72);
  b.chimney(1.3, 4.4, -1, 1.2); b.flag(0, 5.2, 0, 1.6);
};


const well: Model = b => {
  const t = b.t, m = M();
  b.cyl(1.0, 1.1, 0.9, t >= 2 ? m.stone : m.stone, 0, 0, 0, 14); b.cyl(0.8, 0.8, 0.05, m.glass, 0, 0.8, 0, 14);
  b.box(0.18, 2.4, 0.18, m.darkwood, -1, 0, 0); b.box(0.18, 2.4, 0.18, m.darkwood, 1, 0, 0);
  b.gable(2.6, 2.4, 0.9, t >= 1 ? m.tile : m.thatch, 0, 2.4, 0, 0.25);
  b.logH(2.2, 0.09, m.log, 0, 2.05, 0, 'x'); b.box(0.35, 0.3, 0.35, m.wood, 0.4, 0.7, 0);
  if (t >= 2) { b.cyl(1.5, 1.6, 0.35, m.darkstone, 0, -0.05, 0, 18); }
};

const chapel: Model = b => {
  const t = b.t, m = M(), wm = t === 0 ? m.wood : t === 1 ? m.plaster : m.stone, rm = t >= 2 ? m.slate : t === 1 ? m.tile : m.thatch;
  const nave = 5 + t * 1.6, nw = 3.2 + t * 0.9, nh = 2.8 + t * 0.9;
  b.box(nave, nh, nw, wm, 0.4, 0, 0); b.gable(nave, nw, 1.6 + t * 0.6, rm, 0.4, nh, 0, 0.5);
  const tw = 2 + t * 0.4, th = 5 + t * 1.4, tx = -nave / 2 - tw / 2 + 0.4;
  b.box(tw, th, tw, t >= 1 ? m.stone : m.wood, tx, 0, 0); b.pyramid(tw + 0.5, tw + 0.5, 2.2 + t * 0.7, t >= 2 ? m.slate : m.tile, tx, th, 0);
  b.box(0.12, 0.9, 0.12, m.gold, tx, th + 2.2 + t * 0.7, 0); b.box(0.5, 0.12, 0.12, m.gold, tx, th + 2.65 + t * 0.7, 0);
  b.box(0.9, 1.6, 0.15, m.door, nave / 2 + 0.4 - 0.05, 0, 0).rotation.y = Math.PI / 2;
  for (let i = 0; i < 2 + t; i++) { const x = -nave / 2 + 1.6 + i * (nave - 2.4) / (1 + t); b.window(x, nh * 0.55, nw / 2 + 0.02, 0, 0.5, 1.1); b.window(x, nh * 0.55, -nw / 2 - 0.02, 0, 0.5, 1.1); }
  if (t >= 2) { for (let i = 0; i < 3; i++) b.box(0.4, nh + 0.8, 0.5, m.stone, -nave / 2 + 2 + i * 1.8, 0, nw / 2 + 0.3), b.box(0.4, nh + 0.8, 0.5, m.stone, -nave / 2 + 2 + i * 1.8, 0, -nw / 2 - 0.3); }
  if (t === 3) { b.box(tw, th, tw, m.stone, nave / 2 + 0.4 - 0.5 + tw / 2, 0, 0); b.pyramid(tw + 0.5, tw + 0.5, 3, m.slate, nave / 2 + 0.4 - 0.5 + tw / 2, th, 0); b.box(0.12, 0.9, 0.12, m.gold, nave / 2 - 0.1 + tw / 2, th + 3, 0); b.box(1.6, 1.6, 0.1, m.stained, 0.4, nh * 0.7, nw / 2 + 0.06); b.box(1.2, 1.2, 0.1, m.stained2, 0.4, nh * 0.7, -nw / 2 - 0.06); }
};

// A village house evolves through four regional styles: wattle-and-daub hut, jettied half-timber cottage,
// Flemish brick townhouse with a crow-stepped gable, and a patrician house with tower.
const house: Model = b => {
  const t = b.t, m = M(), w = [4.0, 4.3, 4.7, 5.3][t], d = [3.2, 3.4, 3.6, 3.8][t];
  if (t === 0) {
    b.box(w, 1.7, d, m.mud, 0, 0, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.2, 1.8, 0.2, m.log, sx * w / 2, 0, sz * d / 2);
    b.gable(w, d, 2.1, m.thatch, 0, 1.7, 0, 0.6);
    b.box(0.8, 1.35, 0.12, m.door, w * 0.2, 0, d / 2 + 0.03); b.window(-w * 0.22, 1.0, d / 2 + 0.03, 0, 0.4, 0.45);
    b.smoke.push(new THREE.Vector3(w * 0.15, 3.9, 0));
    for (let i = 0; i < 3; i++) { b.logH(1.4, 0.2, m.log, -w / 2 - 0.5, 0.2 + (i % 2) * 0.36, d / 2 - 0.5 + (i > 1 ? 0.2 : -i * 0.3), 'z'); }
  } else if (t === 1) {
    b.box(w + 0.3, 0.55, d + 0.3, m.stone, 0, -0.1, 0);
    b.box(w, 2.0, d, m.timber, 0, 0.45, 0);
    b.box(w + 0.8, 0.22, d + 0.8, m.darkwood, 0, 2.45, 0);          // jetty beam
    b.joists(w + 0.4, 2.22, d / 2 + 0.38, 5, 1); b.joists(w + 0.4, 2.22, d / 2 + 0.38, 5, -1);
    b.box(w + 0.7, 1.7, d + 0.7, m.timber, 0, 2.67, 0);              // overhanging upper floor
    b.gable(w + 0.7, d + 0.7, 2.0, m.tile, 0, 4.37, 0, 0.5);
    b.box(0.85, 1.55, 0.14, m.door, -w * 0.22, 0.45, d / 2 + 0.03);
    b.window(w * 0.2, 1.5, d / 2 + 0.05); b.shutters(w * 0.2, 1.5, d / 2 + 0.08, m.shutter, 0, 0.5);
    for (const x of [-w * 0.25, w * 0.25]) { b.window(x, 3.4, d / 2 + 0.4); b.shutters(x, 3.4, d / 2 + 0.43, m.shutterRed, 0, 0.5); }
    b.chimney(w * 0.28, 5.3, -d * 0.15, 1.5);
  } else if (t === 2) {
    b.box(w + 0.3, 0.55, d + 0.3, m.stone, 0, -0.1, 0);
    b.box(w, 4.1, d, m.flemish, 0, 0.45, 0);
    b.quoins(w, d, 4.0); b.gableZ(d, w, 2.2, m.slate, 0, 4.55, 0, 0.45);
    b.stepGable(w, 0.55, 4.55, d / 2 - 0.1, m.flemish, 4); b.stepGable(w, 0.55, 4.55, -d / 2 + 0.1, m.flemish, 4);
    b.box(1.0, 1.9, 0.16, m.door, 0, 0.45, d / 2 + 0.04); b.box(1.5, 0.28, 0.3, m.stoneMat, 0, 2.35, d / 2 + 0.05);
    for (const x of [-w * 0.3, w * 0.3]) for (const y of [1.6, 3.35]) { b.box(0.8, 1.05, 0.12, m.stoneMat, x, y - 0.05, d / 2 + 0.04); b.window(x, y + 0.3, d / 2 + 0.1, 0, 0.5, 0.75); b.shutters(x, y + 0.3, d / 2 + 0.12, m.shutterBlue, 0, 0.5); }
    b.chimney(w * 0.3, 6.2, 0, 1.6, m.stone);
  } else {
    b.box(w + 0.4, 0.6, d + 0.4, m.stone, 0, -0.1, 0);
    b.box(w, 4.9, d, m.flemish, 0, 0.5, 0);
    b.quoins(w, d, 4.8, 0.5); b.gableZ(d, w, 2.6, m.slate, 0, 5.4, 0, 0.5);
    b.stepGable(w, 0.6, 5.4, d / 2 - 0.1, m.flemish, 5); b.stepGable(w, 0.6, -0.0 + 5.4, -d / 2 + 0.1, m.flemish, 5);
    b.box(1.2, 2.2, 0.18, m.door, 0, 0.5, d / 2 + 0.05); b.box(1.9, 0.3, 0.34, m.stoneMat, 0, 2.7, d / 2 + 0.06);
    for (const x of [-w * 0.32, w * 0.32]) for (const y of [1.8, 3.6]) { b.box(0.9, 1.15, 0.12, m.stoneMat, x, y - 0.05, d / 2 + 0.04); b.window(x, y + 0.3, d / 2 + 0.1, 0, 0.55, 0.85); b.shutters(x, y + 0.3, d / 2 + 0.12, m.shutterRed, 0, 0.55); }
    b.box(1.8, 0.3, 0.9, m.stoneMat, 0, 3.9, d / 2 + 0.4); b.box(1.8, 0.5, 0.08, m.iron, 0, 4.2, d / 2 + 0.8);  // balcony
    b.cyl(0.95, 1.05, 6.6, m.flemish, -w / 2 - 0.3, 0.2, -d / 2 + 0.4, 14); b.cone(1.3, 2.4, m.slate, -w / 2 - 0.3, 6.8, -d / 2 + 0.4, 14);
    b.chimney(w * 0.3, 7.4, 0, 1.8, m.stone); b.flag(w * 0.1, 8.5, 0, 2.0);
  }
};

// The central hall is the heart of the village: a palisaded longhall, a timber manor, a Flemish cloth hall with belfry,
// and finally a castle.
const townhall: Model = b => {
  const t = b.t, m = M();
  if (t === 0) {
    b.box(9, 3, 5.4, m.wood, 0, 0, 0); b.gable(9, 5.4, 3.2, m.thatch, 0, 3, 0, 0.8);
    b.box(1.4, 2.2, 0.15, m.door, 0, 0, 2.75); for (const x of [-3, -1.5, 1.5, 3]) b.window(x, 1.8, 2.75);
    b.smoke.push(new THREE.Vector3(2.5, 6.2, -0.5)); b.smoke.push(new THREE.Vector3(-2.5, 6.2, -0.5));
    for (let i = 0; i < 34; i++) { const a = (i / 34) * Math.PI * 2 + 0.1; if (Math.abs(((a + Math.PI * 2) % (Math.PI * 2)) - Math.PI / 2) < 0.28) continue; b.cyl(0.2, 0.22, 2.3, m.log, Math.cos(a) * 6.3, 0, Math.sin(a) * 6.3, 6); b.cone(0.2, 0.5, m.log, Math.cos(a) * 6.3, 2.3, Math.sin(a) * 6.3, 6); }
    for (const x of [-5.3, 5.3]) b.cyl(0.7, 0.8, 0.9, m.hay, x, 0, -4.2, 10);
    b.flag(-4.8, 0, 3.4, 5.2);
  } else if (t === 1) {
    b.box(9.4, 3.6, 5.6, m.timber, 0, 0, 0); b.box(9.5, 0.25, 5.7, m.darkwood, 0, 3.4, 0); b.joists(9.4, 3.2, 2.95, 9, 1); b.joists(9.4, 3.2, 2.95, 9, -1); b.gable(9.4, 5.6, 3.1, m.tile, 0, 3.6, 0, 0.7);
    b.box(4, 3.1, 4.6, m.timber, 3.8, 0, 4.4); b.gable(4.6, 4, 2.4, m.tile, 3.8, 3.1, 4.4, 0.5);
    b.box(1.4, 2.3, 0.15, m.door, 0, 0, 2.85); for (const x of [-3.2, -1.6, 1.6]) { b.window(x, 2.0, 2.88); b.shutters(x, 2.0, 2.9, m.shutterBlue, 0, 0.5); }
    b.cyl(1.3, 1.4, 5.8, m.stone, -4.2, 0, 2.8, 14); b.cone(1.7, 2.7, m.slate, -4.2, 5.8, 2.8, 14);
    b.chimney(2.4, 5.6, -1.2, 1.6); b.flag(-4.2, 8.5, 2.8, 2.2);
    for (let i = 0; i < 22; i++) { const a = (i / 22) * Math.PI * 2; if (Math.abs(a - Math.PI / 2) < 0.4) continue; b.box(0.18, 1.1, 0.18, m.darkwood, Math.cos(a) * 6.6, 0, Math.sin(a) * 6.6); }
  } else if (t === 2) {
    // Flemish cloth hall: arcaded ground floor, stepped gables, central belfry
    b.box(12, 0.5, 6.4, m.stone, 0, -0.1, 0);
    b.box(11, 5.2, 5.4, m.flemish, 0, 0.4, -0.3);
    for (let i = 0; i < 7; i++) { const x = -4.5 + i * 1.5; b.cyl(0.26, 0.3, 3.2, m.stoneMat, x, 0.4, 2.8, 10); }
    b.box(11.2, 0.5, 1.2, m.stoneMat, 0, 3.6, 2.5); b.box(11.2, 0.3, 1.3, m.stoneMat, 0, 0.4, 2.55).visible = false;
    for (let i = 0; i < 6; i++) { const x = -3.75 + i * 1.5; b.window(x, 2.4, 2.35, 0, 0.7, 1.5); b.window(x, 4.6, 2.43, 0, 0.55, 1.0); }
    b.gable(11, 5.4, 2.8, m.slate, 0, 5.6, -0.3, 0.45);
    for (const sx of [-1, 1]) b.stepGable(5.4, 0.6, 5.6, sx * 5.4, m.flemish, 4, -0.3, 'x');
    // belfry
    b.box(3.2, 6.8, 3.2, m.flemish, 0, 4.0, -0.3); b.box(3.5, 0.4, 3.5, m.stoneMat, 0, 10.8, -0.3);
    b.box(2.7, 2.3, 2.7, m.stone, 0, 11.2, -0.3);
    for (const [x, z, ry] of [[0, 1.06, 0], [0, -1.66, 0], [1.36, -0.3, Math.PI / 2], [-1.36, -0.3, Math.PI / 2]] as const) b.box(0.9, 1.5, 0.16, m.iron, x, 11.5, z, ry);
    b.pyramid(3.2, 3.2, 3.8, m.slate, 0, 13.5, -0.3); b.box(0.16, 1.2, 0.16, m.gold, 0, 17.2, -0.3); b.sphere(0.32, m.gold, 0, 17.6, -0.3);
    for (const [x, z] of [[-1.3, 1.0], [1.3, 1.0], [-1.3, -1.6], [1.3, -1.6]]) b.cone(0.26, 1.1, m.slate, x, 13.5, z, 6);
    b.cyl(0.65, 0.65, 0.12, m.gold, 0, 8.6, 1.33, 16).rotation.x = Math.PI / 2;   // clock face
    b.flag(-5.2, 5.6, 1.0, 2.4); b.flag(5.2, 5.6, 1.0, 2.4);
  } else {
    const cs = 5.6, ch = 5.2;
    b.box(cs * 2 + 2, 3, cs * 2 + 2, m.darkstone, 0, -3, 0).scale.set(1, 1, 1);
    for (const s of [[0, cs, 11.6, 1.6], [0, -cs, 11.6, 1.6], [cs, 0, 1.6, 11.6], [-cs, 0, 1.6, 11.6]] as const) b.box(s[2], ch, s[3], m.stone, s[0], 0, s[1]);
    for (const x of [-4.4, 0, 4.4]) { b.box(1.2, 0.5, 1.8, m.darkstone, x, ch, cs); b.box(1.2, 0.5, 1.8, m.darkstone, x, ch, -cs); }
    for (const [x, z] of [[-cs, -cs], [cs, -cs], [cs, cs], [-cs, cs]]) { b.cyl(1.9, 2.1, ch + 3.8, m.stone, x, -0.2, z, 16); b.cyl(2.15, 2.15, 0.5, m.darkstone, x, ch + 3.4, z, 16); b.cone(2.25, 3, m.slate, x, ch + 3.9, z, 16); b.flag(x, ch + 6.5, z, 2); }
    b.box(5.4, 11, 5.4, m.stone, 0, 0, -0.4); b.box(6, 0.5, 6, m.darkstone, 0, 10.6, -0.4); b.battlements(6, 6, 11.1, m.stone, 0.8, 5);
    for (const [x, z] of [[-2.6, -3], [2.6, -3], [2.6, 2.2], [-2.6, 2.2]]) { b.cyl(0.9, 1, 3.2, m.stone, x, 11, z, 10); b.cone(1.15, 2.2, m.slate, x, 14.2, z, 10); }
    b.box(3.2, 4, 1.8, m.darkstone, 0, 0, cs + 0.6); b.box(1.9, 2.8, 0.25, new THREE.MeshBasicMaterial({ color: 0x0a0806 }), 0, 0, cs + 1.55);
    b.box(0.2, 3, 0.2, m.iron, -0.7, 0, cs + 1.6);
    for (const y of [3.5, 6.5, 9]) { b.window(-1.2, y, 2.32, 0, 0.5, 1.1); b.window(1.2, y, 2.32, 0, 0.5, 1.1); }
    // the keep's roof: a round slate spire on a drum, topped with a gilded ball
    b.cyl(2.6, 2.7, 1.2, m.darkstone, 0, 11.1, -0.4, 16); b.cone(2.7, 4.6, m.slate, 0, 12.3, -0.4, 16); b.sphere(0.4, m.gold, 0, 17.1, -0.4); b.flag(0, 17.4, -0.4, 3.0);
  }
};


// Hunter's lodge: log cabin with trophies; grows into a hunting manor.
const lodge: Model = b => {
  const t = b.t, m = M(), w = [4.2, 4.6, 5.0, 5.6][t], d = [3.4, 3.6, 3.8, 4.2][t];
  b.box(w + 0.3, 0.5, d + 0.3, t >= 2 ? m.stone : m.earth, 0, -0.1, 0);
  const courses = 5 + t;
  for (let i = 0; i < courses; i++) { const y = 0.4 + i * 0.4; for (const z of [-d / 2, d / 2]) b.logH(w + 0.5, 0.21, m.log, 0, y + 0.2, z, 'x'); for (const x of [-w / 2, w / 2]) b.logH(d + 0.5, 0.21, m.log, x, y + 0.4, 0, 'z'); }
  const wh = 0.4 + courses * 0.4 + 0.3;
  b.box(w - 0.2, wh - 0.4, d - 0.2, m.darkwood, 0, 0.4, 0);
  b.gable(w, d, 1.8 + t * 0.3, t >= 1 ? m.tile : m.thatch, 0, wh, 0, 0.55);
  b.box(0.85, 1.5, 0.12, m.door, 0, 0.4, d / 2 + 0.2); b.window(w * 0.3, 1.5, d / 2 + 0.2);
  // antlers over the door
  b.box(0.04, 0.6, 0.04, m.stoneMat, -0.15, wh + 0.3, d / 2 + 0.25).rotation.z = 0.5; b.box(0.04, 0.6, 0.04, m.stoneMat, 0.15, wh + 0.3, d / 2 + 0.25).rotation.z = -0.5;
  // drying rack with pelts and a hanging carcass
  b.box(0.1, 1.9, 0.1, m.darkwood, w / 2 + 1.0, 0, 0.5); b.box(0.1, 1.9, 0.1, m.darkwood, w / 2 + 1.0, 0, 1.9); b.box(0.1, 0.1, 1.5, m.darkwood, w / 2 + 1.0, 1.8, 1.2);
  b.box(0.05, 0.9, 0.5, new THREE.MeshStandardMaterial({ color: 0x8a6a4a }), w / 2 + 1.0, 0.8, 0.8); b.box(0.05, 0.7, 0.5, new THREE.MeshStandardMaterial({ color: 0xb09070 }), w / 2 + 1.0, 1.0, 1.6);
  b.cyl(0.5, 0.55, 0.3, m.log, -w / 2 - 1, 0, 1.3, 8); b.box(0.1, 0.5, 0.1, m.darkwood, -w / 2 - 1, 0.3, 1.3);
  b.chimney(-w * 0.3, wh + 0.8, -d * 0.1, 1.3, m.stone);
  if (t >= 2) { b.box(1.6, 0.9, 0.12, m.darkwood, 0, wh + 0.05, d / 2 + 0.22); b.sphere(0.28, new THREE.MeshStandardMaterial({ color: 0x8a6a4a }), 0, 2.4, d / 2 + 0.4); }
  if (t === 3) { b.cyl(0.8, 0.9, 5.4, m.stone, w / 2 + 0.3, 0, -d / 2 + 0.2, 12); b.cone(1.1, 1.8, m.slate, w / 2 + 0.3, 5.4, -d / 2 + 0.2, 12); b.flag(-w * 0.2, wh + 1.4, 0, 1.8); }
};

// Barracks: a timber drill yard that grows into a stone fortress.
const barracks: Model = b => {
  const t = b.t, m = M(), W = 8.2;
  const wall = t >= 2 ? m.stone : t >= 1 ? m.timber : m.wood;
  // drill yard with weapon racks and straw dummies
  b.box(W, 0.06, W, m.earth, 0, 0.02, 0.5);
  for (const [x, z, w, d] of [[0, -W / 2 + 0.5, W, 0.3], [-W / 2, 0.5, 0.3, W], [W / 2, 0.5, 0.3, W]] as const) b.box(w, 1.5 + t * 0.9, d, t >= 1 ? wall : m.wood, x, 0, z);
  for (const x of [-3.4, 3.4]) b.box(1.6, 1.3 + t * 0.9, 0.3, wall, x, 0, W / 2 + 0.5 - 0.2);
  b.box(0.3, 2.2 + t * 0.9, 0.3, m.darkwood, -1.5, 0, W / 2 + 0.3); b.box(0.3, 2.2 + t * 0.9, 0.3, m.darkwood, 1.5, 0, W / 2 + 0.3);
  // main hall at the back
  const hh = 2.6 + t * 0.7; b.box(6.2, hh, 3.2, wall, 0, 0.1, -2.6); b.gable(6.2, 3.2, 1.7 + t * 0.3, t >= 1 ? (t >= 2 ? m.slate : m.tile) : m.thatch, 0, hh + 0.1, -2.6, 0.5);
  b.box(1.1, 1.8, 0.14, m.door, 0, 0.1, -0.95); b.window(-2.0, 1.7, -0.95); b.window(2.0, 1.7, -0.95);
  for (let i = 0; i < 3; i++) { b.box(0.08, 1.4, 0.08, m.darkwood, -3.2 + i * 0.5, 0, 1.5); }
  b.box(1.6, 0.08, 0.08, m.darkwood, -2.7, 1.2, 1.5); for (let i = 0; i < 4; i++) b.cyl(0.03, 0.03, 1.8, m.wood, -3.3 + i * 0.35, 0.1, 1.2, 5);
  for (const x of [2.6, 3.4]) { b.cyl(0.04, 0.04, 1.4, m.darkwood, x, 0, 1.7, 6); b.cyl(0.26, 0.28, 0.6, m.hay, x, 0.8, 1.7, 8); b.sphere(0.2, m.hay, x, 1.6, 1.7); }
  b.flag(-W / 2 + 0.4, 0, W / 2 + 0.2, 4 + t * 0.5);
  if (t >= 1) b.chimney(2.2, hh + 1.2, -2.6, 1.4);
  if (t >= 2) { for (const x of [-W / 2, W / 2]) { b.cyl(1.1, 1.25, 4.4, m.stone, x, 0, -W / 2 + 0.5, 12); b.cone(1.35, 1.8, m.slate, x, 4.4, -W / 2 + 0.5, 12); } b.battlements(W, 0.8, 1.5 + t * 0.9, m.stone, 0.4, 7); }
  if (t === 3) { b.box(2.6, 7, 2.6, m.stone, 0, 0, -3.2); b.battlements(2.8, 2.8, 7, m.stone, 0.5, 4); b.flag(0, 7.5, -3.2, 2.8); }
};

// Builders' yard: an open carpentry shed with timber stacks and scaffolding; grows into a masons' lodge and guild hall.
const builders: Model = b => {
  const t = b.t, m = M(), wall = t >= 2 ? m.stone : m.wood;
  b.box(9, 0.06, 8, m.earth, 0, 0.02, 0);
  // open workshop shed on posts at the back
  const sw = 6 + t * 0.6, sh = 2.4 + t * 0.5;
  for (const x of [-sw / 2, sw / 2]) for (const z of [-3.4, -1]) b.box(0.28, sh, 0.28, m.darkwood, x, 0, z);
  if (t >= 1) b.box(sw, sh - 0.2, 0.25, wall, 0, 0, -3.4);
  b.gable(sw + 0.6, 2.9, 1.3 + t * 0.3, t >= 1 ? m.tile : m.thatch, 0, sh, -2.2, 0.5);
  b.box(sw - 0.6, 0.12, 1.2, m.darkwood, 0, 0.85, -2.6);          // workbench
  b.box(0.1, 0.5, 0.1, m.darkwood, -1, 0.9, -2.6); b.box(0.9, 0.06, 0.3, m.wood, 1.3, 0.97, -2.6);
  // plank stacks and logs
  for (let i = 0; i < 4 + t; i++) b.box(2.2, 0.14, 0.7, m.wood, -3.0, 0.1 + i * 0.16, 2.2);
  for (let i = 0; i < 3; i++) b.logH(2.4, 0.26, m.log, 3.0, 0.3 + (i === 2 ? 0.45 : 0), 2.0 + (i % 2) * 0.55, 'x');
  if (t >= 1) for (let i = 0; i < 5; i++) b.box(0.7, 0.3, 0.4, m.stoneMat, 3.2 + (i % 2) * 0.5, 0.15 + Math.floor(i / 2) * 0.3, -0.2 + (i % 2) * 0.4);
  // scaffold with a ladder
  b.box(0.12, 3.2, 0.12, m.darkwood, -1, 0, 1.2); b.box(0.12, 3.2, 0.12, m.darkwood, 1, 0, 1.2); b.box(2.2, 0.1, 0.14, m.darkwood, 0, 1.4, 1.2); b.box(2.2, 0.1, 0.14, m.darkwood, 0, 2.6, 1.2);
  b.box(0.1, 3.0, 0.5, m.wood, 1.35, 0, 1.4).rotation.z = 0.12;
  if (t >= 2) { b.cyl(0.18, 0.2, 5.2, m.darkwood, -3.6, 0, -0.4, 6); b.box(3.4, 0.2, 0.2, m.darkwood, -2.1, 5.0, -0.4); b.box(0.04, 1.8, 0.04, m.wood, -0.9, 3.2, -0.4); b.box(0.5, 0.5, 0.5, m.stoneMat, -0.9, 2.7, -0.4); }
  if (t === 3) { b.box(2.2, 3.2, 2.2, m.stone, 4.2, 0, -2.8); b.battlements(2.4, 2.4, 3.2, m.stone, 0.4, 4); b.flag(4.2, 3.6, -2.8, 2.2); }
  if (t >= 1) b.chimney(-sw * 0.3, sh + 1.2, -2.6, 1.2);
};

// Spiked logs: a short row of sharpened logs (the placed fence is drawn by the Walls renderer; this is the preview).
const fence: Model = b => {
  const m = M();
  for (let i = 0; i < 6; i++) { const x = -1.6 + i * 0.64, h = 2.0 + ((i * 37) % 7) * 0.1; b.cyl(0.23, 0.25, h, m.log, x, -0.3, 0, 7); b.cone(0.23, 0.6, m.log, x, h - 0.3, 0, 7); }
};
// Gate: two pillars and a lintel (preview; the placed gate is drawn by the Walls renderer in line with the wall).
const gate: Model = b => {
  const t = b.t, m = M(), wm = [m.wood, m.timber, m.stone, m.stone][t];
  for (const s of [-1, 1]) b.box(1.5, 4.2, 1.5, wm, s * 2.3, -0.4, 0);
  b.box(5.9, 1.0, 1.7, wm, 0, 3.2, 0);
  for (let k = -3; k <= 3; k++) b.box(0.08, 1.0, 0.08, m.iron, k * 0.38, 2.2, 0);
};
// Drawbridge: a plank deck hinged at the inner end, with a winch frame; it is drawn up (swung to the vertical) while raiders attack.
const drawbridge: Model = b => {
  const m = M();
  for (const s of [-1, 1]) { b.box(0.5, 3.6, 0.5, m.darkwood, s * 1.7, 0, -6.6); b.box(0.3, 0.3, 1.5, m.darkwood, s * 1.7, 3.4, -5.9); }
  b.box(4.0, 0.4, 0.4, m.darkwood, 0, 3.5, -6.6);
  const deck = new THREE.Group(); deck.position.set(0, 0.55, -6.4); deck.userData.deck = true;
  const plank = (w: number, d: number, x: number, z: number) => { const g = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), m.wood); g.position.set(x, 0, z); g.castShadow = g.receiveShadow = true; deck.add(g); };
  for (let i = 0; i < 29; i++) plank(3.0, 0.42, 0, 0.3 + i * 0.44);
  for (const s of [-1, 1]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 12.8), m.darkwood); rail.position.set(s * 1.6, 0.3, 6.4); rail.castShadow = true; deck.add(rail); }
  b.g.add(deck); b.deck.push(deck);
};
// Moat: a patch of water marks where a ditch will be dug (the ditch itself is part of the terrain).
const moat: Model = b => {
  const g = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.1, 18), new THREE.MeshStandardMaterial({ color: 0x3f7fa0, roughness: 0.2, metalness: 0.1 }));
  g.position.y = 0.06; b.g.add(g);
};

// Storehouse: a long timber warehouse with a loading door, crates and barrels; it grows into a stone warehouse with a hoist.
const storehouse: Model = b => {
  const t = b.t, m = M(), W = 6.4 + t * 0.7, D = 4.4 + t * 0.3, h = 2.3 + t * 0.4, wm = t >= 2 ? m.stone : t >= 1 ? m.timber : m.wood;
  b.box(W + 0.4, 0.4, D + 0.4, t >= 1 ? m.stone : m.earth, 0, -0.1, 0);
  b.box(W, h, D, wm, 0, 0.3, 0); b.gable(W, D, 1.7 + t * 0.3, t >= 1 ? m.tile : m.thatch, 0, h + 0.3, 0, 0.55);
  b.box(2.0, h - 0.4, 0.14, m.door, 0, 0.3, D / 2 + 0.03); b.box(0.12, h - 0.3, 0.2, m.darkwood, 0, 0.3, D / 2 + 0.05);
  b.box(2.5, 0.2, 0.3, m.darkwood, 0, h - 0.1, D / 2 + 0.1);
  for (const [x, z, s] of [[W / 2 + 0.9, 0.8, 0.9], [W / 2 + 1.0, -0.4, 0.7], [-W / 2 - 0.9, 1.0, 0.8]] as const) b.box(s, s, s, m.wood, x, 0, z);
  for (const [x, z] of [[-W / 2 - 0.8, -0.6], [-W / 2 - 1.5, 0.2]] as const) { b.cyl(0.45, 0.45, 0.9, m.wood, x, 0, z, 10); b.box(0.9, 0.08, 0.08, m.iron, x - 0.45, 0.45, z); }
  // a hand cart waiting at the door
  b.box(1.5, 0.3, 1.0, m.wood, -2.6, 0.5, D / 2 + 1.6); for (const z of [-0.55, 0.55]) b.cyl(0.4, 0.4, 0.12, m.darkwood, -2.6, 0.4, D / 2 + 1.6 + z, 10).rotation.x = Math.PI / 2;
  if (t >= 2) { b.box(0.22, h + 1.6, 0.22, m.darkwood, W / 2 - 0.4, 0.3, D / 2 + 0.5); b.box(2.0, 0.2, 0.2, m.darkwood, W / 2 - 1.3, h + 1.7, D / 2 + 0.5); b.box(0.05, 1.2, 0.05, m.iron, W / 2 - 2.1, h + 0.55, D / 2 + 0.5); }
  if (t === 3) b.flag(-W / 2 + 0.5, h + 1.6, 0, 2.2);
};
// Keep: a mound with a timber tower that grows into a great stone keep. Archers stand on the flat roof inside the parapet (see KEEP_TOP / KEEP_RING in army.ts).
const keep: Model = b => {
  const t = b.t, m = M(), parapet = (w: number, y: number, mat: THREE.Material) => b.battlements(w, w, y, mat, 0.7, 6);
  if (t === 0) {
    b.cone(6.4, 2.6, m.mound, 0, -0.3, 0, 18); b.box(4.6, 3.9, 4.6, m.wood, 0, 2.3, 0);
    b.box(5.2, 0.25, 5.2, m.darkwood, 0, 6.2, 0); for (const [x, z, w, d] of [[0, 2.5, 5.2, 0.2], [0, -2.5, 5.2, 0.2], [2.5, 0, 0.2, 5.2], [-2.5, 0, 0.2, 5.2]] as const) b.box(w, 0.9, d, m.wood, x, 6.4, z);
    b.box(1.0, 1.9, 0.2, m.door, 0, 2.3, 2.35); for (let i = 0; i < 4; i++) b.box(1.6 - i * 0.1, 0.18, 0.7, m.wood, 0, 0.5 + i * 0.5, 3.1 - i * 0.18);
  } else {
    const w = [0, 7.2, 8.4, 9.4][t], H = [0, 8.2, 10.6, 13.2][t];
    b.box(w + 1.6, 1.0, w + 1.6, m.darkstone, 0, -0.3, 0); b.box(w, H, w, t >= 3 ? m.stone : m.stone, 0, 0.4, 0);
    b.box(w + 0.8, 0.5, w + 0.8, m.darkstone, 0, H + 0.4, 0); parapet(w + 0.6, H + 0.9, m.stone);
    b.box(1.4, 2.6, 0.3, m.door, 0, 0.4, w / 2 + 0.05); b.box(2.0, 0.3, 0.5, m.darkstone, 0, 3.0, w / 2 + 0.05);
    for (let i = 0; i < 5; i++) b.box(2.4, 0.2, 0.7, m.stoneMat, 0, 0.2 + i * 0.2, w / 2 + 1.2 - i * 0.2);
    for (const y of [H * 0.35, H * 0.65]) for (const x of [-w / 4, w / 4]) b.window(x, y, w / 2 + 0.02, 0, 0.45, 1.0);
    if (t >= 2) for (const sx of [-1, 1]) for (const sz of [-1, 1]) { b.cyl(1.5, 1.7, H + 2.2, m.stone, sx * (w / 2), -0.3, sz * (w / 2), 14); b.cone(1.8, 2.4, m.slate, sx * (w / 2), H + 1.9, sz * (w / 2), 14); }
    if (t === 3) { b.box(3.0, 3.6, 3.0, m.stone, 0, H + 0.4, 0); b.cone(2.4, 3.2, m.slate, 0, H + 4.0, 0, 4).rotation.y = Math.PI / 4; b.flag(0, H + 7, 0, 3.0); }
  }
};
// Courthouse: a hall with a columned porch, steps and a bell, the scales of justice over the door.
const courthouse: Model = b => {
  const t = b.t, m = M(), W = 6.4 + t * 0.6, D = 5.0, h = 3.0 + t * 0.5, wm = t >= 2 ? m.stone : t >= 1 ? m.plaster : m.wood;
  b.box(W + 0.6, 0.5, D + 0.6, m.stoneMat, 0, -0.1, 0); b.box(W, h, D, wm, 0, 0.4, 0); b.gable(W, D, 1.8 + t * 0.3, t >= 1 ? m.slate : m.thatch, 0, h + 0.4, 0, 0.5);
  b.box(1.3, 2.2, 0.14, m.door, 0, 0.4, D / 2 + 0.03); b.window(-W * 0.3, 2.0, D / 2 + 0.02); b.window(W * 0.3, 2.0, D / 2 + 0.02);
  b.box(W * 0.62, 0.18, 1.5, m.darkwood, 0, h - 0.2, D / 2 + 0.75);
  for (const x of [-W * 0.27, -W * 0.09, W * 0.09, W * 0.27]) b.cyl(0.17, 0.2, h - 0.5, t >= 2 ? m.stoneMat : m.log, x, 0.4, D / 2 + 1.3, 8);
  for (let i = 0; i < 3; i++) b.box(W * 0.7, 0.18, 0.6, m.stoneMat, 0, 0.1 + i * 0.18, D / 2 + 1.8 - i * 0.2);
  b.box(0.9, 0.9, 0.9, m.wood, 0, h + 2.0, 0); b.pyramid(1.3, 1.3, 0.9, m.slate, 0, h + 2.9, 0); b.sphere(0.2, m.gold, 0, h + 2.4, 0.5);
  b.box(0.04, 0.5, 0.04, m.iron, 0, h - 0.1 + 0.9, D / 2 + 1.7); b.box(0.9, 0.05, 0.05, m.iron, 0, h + 0.5 + 0.7, D / 2 + 1.7);
  if (t >= 1) b.flag(W / 2 - 0.4, h + 1.6, 0, 2.2); b.chimney(-W * 0.3, h + 1.4, -0.6, 1.2, m.stone);
  if (t === 3) b.dome(1.4, m.gold, 0, h + 3.0, 0, 0.8);
};
// Market: stalls with striped awnings round a market cross and a well.
const market: Model = b => {
  const t = b.t, m = M(), awn = [0xb8402f, 0x2f6aa8, 0x4f8a3a, 0xd0a030].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })), n = 3 + t;
  b.cyl(5.2, 5.4, 0.12, t >= 1 ? m.cobble : m.earth, 0, -0.05, 0, 24);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.5, x = Math.cos(a) * 3.4, z = Math.sin(a) * 3.4, rot = -a + Math.PI / 2;
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, px: number, py: number, pz: number) => { const q = new THREE.Mesh(geo, mat); q.position.set(px, py, pz); q.castShadow = true; g.add(q); return q; };
    for (const sx of [-1, 1]) for (const sz of [-0.6, 0.6]) add(new THREE.BoxGeometry(0.12, 2.1, 0.12), m.darkwood, sx * 1.1, 1.05, sz);
    add(new THREE.BoxGeometry(2.6, 0.9, 0.12), m.wood, 0, 0.45, 0.6); add(new THREE.BoxGeometry(2.3, 0.1, 1.0), awn[i % 4], 0, 2.15, 0).rotation.x = 0.18;
    for (let k = 0; k < 4; k++) add(new THREE.SphereGeometry(0.2, 6, 5), awn[(i + k) % 4], -0.8 + k * 0.5, 1.0, 0.5);
    b.g.add(g);
  }
  b.cyl(0.35, 0.45, 1.6, m.stone, 0, 0, 0, 8); b.sphere(0.3, m.stone, 0, 1.8, 0);
  if (t >= 2) { b.cyl(0.9, 1.0, 0.7, m.stone, 0, 0, 0, 12); b.cyl(0.35, 0.45, 2.2, m.stone, 0, 0.7, 0, 8); b.flag(0, 2.6, 0, 1.6); }
};
// Waterwheel: a mill house with a big paddle wheel on its side, turning while it works.
const waterwheel: Model = b => {
  const t = b.t, m = M(), W = 4.2 + t * 0.5, D = 3.6, h = 2.5 + t * 0.4, wm = t >= 2 ? m.stone : t >= 1 ? m.timber : m.wood;
  b.box(W + 0.4, 0.4, D + 0.4, m.stone, 0, -0.1, 0); b.box(W, h, D, wm, 0, 0.3, 0); b.gable(W, D, 1.6 + t * 0.3, t >= 1 ? m.tile : m.thatch, 0, h + 0.3, 0, 0.5);
  b.box(0.9, 1.6, 0.14, m.door, 0, 0.3, D / 2 + 0.03); b.window(W * 0.28, 1.6, D / 2 + 0.02); b.chimney(-W * 0.3, h + 1.2, -0.4, 1.2);
  const R = 1.7 + t * 0.15, pivot = new THREE.Group(); pivot.position.set(W / 2 + 0.55, R + 0.2, 0); pivot.rotation.y = Math.PI / 2; b.g.add(pivot);
  const wheel = new THREE.Group(); pivot.add(wheel);
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material) => { const q = new THREE.Mesh(geo, mat); q.castShadow = true; return q; };
  for (const s of [-0.5, 0.5]) { const rim = part(new THREE.TorusGeometry(R, 0.1, 6, 20), m.darkwood); rim.position.z = s; wheel.add(rim); }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2, arm = part(new THREE.BoxGeometry(0.12, R * 2, 0.12), m.darkwood); arm.rotation.z = a; wheel.add(arm);
    const pad = part(new THREE.BoxGeometry(0.2, 0.5, 1.1), m.wood); pad.position.set(Math.cos(a) * R, Math.sin(a) * R, 0); pad.rotation.z = a; wheel.add(pad);
  }
  wheel.add(part(new THREE.CylinderGeometry(0.22, 0.22, 1.3, 8).rotateX(Math.PI / 2), m.iron));
  b.spin.push(wheel);
  b.box(0.8, 0.5, 2.6, new THREE.MeshStandardMaterial({ color: 0x4a7fa0, roughness: 0.2 }), W / 2 + 0.6, R * 2 + 0.3, 0);   // the flume that feeds the wheel
  b.box(0.1, R * 2 + 0.3, 0.1, m.darkwood, W / 2 + 0.6, 0, 1.4); b.box(0.1, R * 2 + 0.3, 0.1, m.darkwood, W / 2 + 0.6, 0, -1.4);
  b.box(0.6, 0.6, 0.6, m.wood, -W / 2 - 0.7, 0, 0.8); b.box(0.5, 0.5, 0.5, m.wood, -W / 2 - 0.6, 0, -0.4);
  if (t === 3) b.flag(-W / 2 + 0.4, h + 1.7, 0, 2.0);
};
// Garden: fenced beds of vegetables and herbs with a scarecrow, a tool shed, then trellises and a fountain.
const garden: Model = b => {
  const t = b.t, m = M(), veg = [0x4f8a2f, 0xc2532a, 0x7ab03a, 0xd9a02a, 0x8a3a6a].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })), soil = m.field;
  const R = 4.4;
  for (const [x, z, w, d] of [[0, -R, R * 2, 0.12], [0, R, R * 2, 0.12], [-R, 0, 0.12, R * 2], [R, 0, 0.12, R * 2]] as const) b.box(w, 0.7, d, m.wood, x, 0, z);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) {
    const x = -2.6 + r * 1.75, z = -2.3 + c * 3.4; b.box(1.3, 0.25, 2.6, m.earth, x, 0, z);
    for (let k = 0; k < 5; k++) b.sphere(0.24 + (k % 2) * 0.04, veg[(r + c + k) % 5], x, 0.45, z - 1.0 + k * 0.5);
  }
  b.box(0.08, 1.6, 0.08, m.darkwood, 0, 0, 0); b.box(1.0, 0.08, 0.08, m.darkwood, 0, 1.1, 0); b.sphere(0.2, m.hay, 0, 1.7, 0);
  b.box(1.6, 1.4, 1.3, m.wood, R - 1.2, 0, R - 1.0); b.gable(1.6, 1.3, 0.7, m.thatch, R - 1.2, 1.4, R - 1.0, 0.3);
  b.box(1.0, 0.4, 0.5, m.stoneMat, 0, 0, R - 0.3);
  if (t >= 1) for (const x of [-3, 0, 3]) { b.box(0.08, 1.8, 0.08, m.darkwood, x, 0, -R + 0.4); b.box(1.2, 0.06, 0.06, m.darkwood, x + 0.5, 1.8, -R + 0.4); }
  if (t >= 2) { b.cyl(0.9, 1.0, 0.6, m.stone, 0, 0, -1.6, 12); b.cyl(0.14, 0.2, 1.4, m.stone, 0, 0.6, -1.6, 8); }
};
// Park: gravel paths, trees, benches and a fountain.
const park: Model = b => {
  const t = b.t, m = M(), pale = new THREE.MeshStandardMaterial({ color: 0xcfc3a4, roughness: 1 }), leaf = [0x3f7a2f, 0x58903a, 0x2f6a3a].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
  b.cyl(4.6, 4.8, 0.06, new THREE.MeshStandardMaterial({ color: 0x6f9a4a, roughness: 1 }), 0, 0, 0, 24);
  b.box(8.6, 0.08, 1.1, pale, 0, 0.04, 0); b.box(1.1, 0.08, 8.6, pale, 0, 0.04, 0);
  for (const [x, z, k] of [[-2.8, -2.8, 0], [2.9, -2.6, 1], [-2.7, 2.9, 2], [3.0, 2.8, 0]] as const) { b.cyl(0.18, 0.26, 1.6 + (t > 0 ? 0.6 : 0), m.log, x, 0, z, 7); b.sphere(1.2 + t * 0.15, leaf[k], x, 2.0 + t * 0.4, z); }
  b.cyl(1.0, 1.1, 0.5, m.stone, 0, 0, 0, 14); b.cyl(0.9, 0.9, 0.1, new THREE.MeshStandardMaterial({ color: 0x4a8ab0, roughness: 0.15 }), 0, 0.5, 0, 14); b.cyl(0.14, 0.18, 1.2, m.stone, 0, 0.5, 0, 8); b.sphere(0.28, m.stone, 0, 1.8, 0);
  for (const [x, z, r] of [[0, 1.9, 0], [0, -1.9, Math.PI], [1.9, 0, Math.PI / 2], [-1.9, 0, -Math.PI / 2]] as const) { const bn = b.box(1.1, 0.12, 0.4, m.wood, x, 0.45, z); bn.rotation.y = r; b.box(1.1, 0.4, 0.08, m.wood, x, 0.55, z).rotation.y = r; }
  for (let i = 0; i < 6; i++) { const a = i * 1.05 + 0.3; b.sphere(0.16, [new THREE.MeshStandardMaterial({ color: 0xd9505a }), new THREE.MeshStandardMaterial({ color: 0xe8c04a }), new THREE.MeshStandardMaterial({ color: 0xb07ad0 })][i % 3], Math.cos(a) * 3.6, 0.2, Math.sin(a) * 3.6); }
  if (t >= 2) { for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(0.1, 0.1, 2.2, m.stoneMat, sx * 1.4 + 3.0, 0, sz * 1.4 + 0.0, 6); b.pyramid(3.6, 3.6, 1.0, m.tile, 3.0, 2.2, 0); }
};
// Previews for the terraforming pieces (the changed ground itself comes from the terrain).
const riverPiece: Model = b => {
  const g = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.1, 18), new THREE.MeshStandardMaterial({ color: 0x4f8fb0, roughness: 0.2 })); g.position.y = 0.06; b.g.add(g);
  b.box(0.3, 0.2, 2.2, M().iron, 0, 0.2, 0); b.cone(0.5, 0.7, M().iron, 0, 0.2, 1.4, 4).rotation.x = Math.PI / 2;
};
const moundPiece: Model = b => { b.cone(2.6, 1.8, M().mound, 0, 0, 0, 14); };
const pitPiece: Model = b => { const g = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 1.6, 0.4, 14), new THREE.MeshStandardMaterial({ color: 0x2f2a22, roughness: 1 })); g.position.y = 0.02; b.g.add(g); };

// Port: a quay with a warehouse, a crane and a merchant ship moored at the end of the pier. The pier runs out to the front (+Z): turn it with R so it reaches the water.
const port: Model = b => {
  const t = b.t, m = M(), W = 5.6 + t * 0.6, D = 3.8, h = 2.6 + t * 0.4, wm = t >= 2 ? m.stone : t >= 1 ? m.timber : m.wood;
  b.box(W + 0.6, 0.45, D + 0.6, t >= 1 ? m.stone : m.earth, -1.5, -0.1, -1.0);
  b.box(W, h, D, wm, -1.5, 0.35, -1.0); b.gable(W, D, 1.6 + t * 0.3, t >= 1 ? m.tile : m.thatch, -1.5, h + 0.35, -1.0, 0.5);
  b.box(1.8, h - 0.4, 0.14, m.door, -1.5, 0.35, D / 2 - 0.9); b.box(2.2, 0.2, 0.3, m.darkwood, -1.5, h - 0.05, D / 2 - 0.85);
  for (const [x, z, s] of [[1.8, -2.4, 0.9], [2.8, -1.4, 0.7], [-5.2, 0.4, 0.8]] as const) b.box(s, s, s, m.wood, x, 0, z);
  b.cyl(0.45, 0.45, 0.9, m.wood, 2.4, 0, 0.6, 10);
  // the pier: planks on posts, running out over the water
  const L = 11;
  b.box(2.8, 0.22, L, m.wood, 2.2, 0.5, 2.0 + L / 2);
  for (let z = 2.5; z < L + 2; z += 2.2) for (const x of [0.9, 3.5]) b.box(0.28, 2.6, 0.28, m.darkwood, x, -1.6, z);
  // a crane at the quayside
  b.box(0.3, 4.0 + t * 0.6, 0.3, m.darkwood, 3.2, 0.5, 2.6); b.box(3.0, 0.25, 0.25, m.darkwood, 1.9, 4.2 + t * 0.6, 2.6); b.box(0.05, 1.6, 0.05, m.iron, 0.6, 2.7 + t * 0.6, 2.6);
  // a merchant cog moored alongside the end of the pier
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.1, 7.0), m.wood); hull.position.set(5.2, 0.35, L - 1.0); hull.castShadow = true; b.g.add(hull);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.0, 4), m.wood); bow.rotation.x = Math.PI / 2; bow.rotation.y = Math.PI / 4; bow.position.set(5.2, 0.35, L + 3.4); b.g.add(bow);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 6.4, 7), m.darkwood); mast.position.set(5.2, 4.0, L - 1.2); b.g.add(mast);
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.2), new THREE.MeshStandardMaterial({ color: 0xeadfc2, side: THREE.DoubleSide, roughness: 0.95 })); sail.position.set(5.2, 4.4, L - 1.2); sail.rotation.y = 0.15; b.g.add(sail);
  for (let i = 0; i < 4; i++) b.box(0.7, 0.7, 0.7, m.wood, 4.7 + (i % 2) * 0.9, 1.0, L - 3.0 + i * 0.9);
  if (t >= 2) { b.cyl(1.0, 1.2, 5.5, m.stone, -4.8, -0.2, 1.4, 12); b.cone(1.3, 1.8, m.slate, -4.8, 5.3, 1.4, 12); b.flag(-4.8, 7.0, 1.4, 2.2); }
};

/** A toll post: a keeper's hut beside the road and a striped barrier pole across it; better tiers add a stone gatehouse and a flag. */
const toll: Model = b => {
  const t = b.t, m = M();
  b.box(2.2, 1.9, 1.8, t >= 2 ? m.stone : m.wood, 1.8, 0.1, -0.2); b.gable(2.4, 2.0, 0.9, t >= 1 ? m.tile : m.thatch, 1.8, 2.0, -0.2, 0.25);
  b.box(0.5, 1.0, 0.1, m.door, 1.8, 0.1, 0.72);
  b.box(0.3, 1.5, 0.3, m.darkwood, -0.6, 0, 0.6); b.box(0.3, 1.5, 0.3, m.darkwood, 0.2, 0, 0.6);
  for (let i = 0; i < 6; i++) b.box(0.6, 0.18, 0.18, i % 2 ? m.shutterRed : m.plaster, -0.6 + 0.1 + i * 0.12 - 0.3, 1.25, 0.6);
  b.cyl(0.07, 0.07, 1.8, m.darkwood, -2.0, 0, 0.6, 6);
  if (t >= 2) b.flag(2.9, 2.0, 0.5, 1.8);
};

/** The ghost shown while placing a bridge (the real bridge is drawn by spans.ts): ten units of deck with posts, stretched to the real length. */
/** The ghost of a road piece: a patch of beaten earth. */
const roadPiece: Model = b => { b.box(2.2, 0.12, 2.2, M().mud, 0, 0.02, 0); };

const bridgeGhost: Model = b => {
  const m = M();
  for (let s = -4.75; s <= 4.75; s += 0.5) b.box(0.46, 0.14, 2.4, m.wood, s, 0.55, 0);
  for (const side of [-1, 1]) for (let s = -4.8; s <= 4.81; s += 2.4) b.box(0.2, 1.1, 0.2, m.darkwood, s, 0.5, side * 1.1);
};

const MODELS: Model[] = [house, farm, wall, tower, woodcutter, sawmill, quarry, claypit, brickworks, mine(false), mine(true), charcoal, smelter, blacksmith, mint, townhall, well, chapel, lodge, barracks, builders, fence, gate, drawbridge, moat, storehouse, keep, courthouse, market, waterwheel, garden, park, riverPiece, moundPiece, pitPiece, port, toll, roadPiece, bridgeGhost];

/** Merge a finished building's static meshes into one mesh per material. A house is built from dozens of boxes, beams and
 *  roof pieces; drawn separately each one costs a draw call (and another in the shadow pass). Animated parts (flags, wheels,
 *  windmill sails) stay separate. */
function bake(g: THREE.Group, animated: Set<THREE.Object3D>) {
  g.updateMatrixWorld(true);
  const per = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; base: THREE.Material | undefined }>(), old: THREE.Mesh[] = [];
  g.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || animated.has(m) || !m.visible || Array.isArray(m.material)) return;
    let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) geo.deleteAttribute(name);
    const n = geo.attributes.position.count;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (!geo.attributes.color) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    geo.applyMatrix4(m.matrixWorld);
    let e = per.get(m.material); if (!e) { e = { geos: [], base: m.userData.base }; per.set(m.material, e); }
    e.geos.push(geo); old.push(m);
  });
  old.forEach(m => { m.parent?.remove(m); m.geometry.dispose(); });
  for (const [mat, e] of per) {
    const merged = mergeGeometries(e.geos); e.geos.forEach(x => x.dispose()); if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = mesh.receiveShadow = true; mesh.userData.baked = true; mesh.userData.base = e.base;
    g.add(mesh);
  }
}

export function buildModel(kind: number, tier: number, banner = 0x2f5fa8, seed = 0, opts = 0, flag?: Flag) {
  const b = new B(tier, banner, flag);
  MODELS[kind](b);
  addOptions(b, kind, opts, seed);
  if (seed >= 0) applyVariant(b.g, ((seed % 4) + 4) % 4);
  b.g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry.attributes.position && !m.geometry.attributes.color) { const n = m.geometry.attributes.position.count; m.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3)); } });
  const animated = new Set<THREE.Object3D>(); b.spin.forEach(o => o.traverse(c => animated.add(c))); b.deck.forEach(o => o.traverse(c => animated.add(c)));
  bake(b.g, animated);
  b.g.userData.smoke = b.smoke; b.g.userData.spin = b.spin.concat(b.deck);
  return b.g;
}

// ---------- optional design upgrades ----------
/** Each building can take up to four optional upgrades (see the catalog) that change its look a little: a chimney, a banner, a barn, hoardings, turrets. Every extra is placed
 *  on a spot that is checked against what the building already has, so an addition never grows through a wall, a roof or another addition. */
function addOptions(b: B, kind: number, opts: number, seed: number) {
  if (!opts) return;
  const m = M();
  b.g.updateMatrixWorld(true);
  const solid: THREE.Box3[] = [];
  b.g.traverse(o => { const me = o as THREE.Mesh; if (me.isMesh) { const bb = new THREE.Box3().setFromObject(me); if (bb.max.y - bb.min.y > 0.3) solid.push(bb); } });
  const all = new THREE.Box3(); solid.forEach(s => all.union(s));
  if (all.isEmpty()) return;
  const cx = (all.min.x + all.max.x) / 2, cz = (all.min.z + all.max.z) / 2, hw = (all.max.x - all.min.x) / 2, hd = (all.max.z - all.min.z) / 2, reach = Math.hypot(hw, hd);
  let top = all.max.y;
  /** A free spot (centre) for a w x d x h item standing on the ground at height y0: the first place on a widening spiral round the building that touches nothing. */
  const spot = (w: number, d: number, h: number, y0 = 0): [number, number] | null => {
    for (let k = 0; k < 90; k++) {
      const a = seed * 0.83 + k * 0.62, rad = Math.max(hw, hd) * 0.55 + k * 0.1;
      if (rad > reach * 1.25 + 2.2) break;
      const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad, bb = new THREE.Box3(new THREE.Vector3(x - w / 2 - 0.12, y0, z - d / 2 - 0.12), new THREE.Vector3(x + w / 2 + 0.12, y0 + h, z + d / 2 + 0.12));
      if (solid.some(s => s.intersectsBox(bb))) continue;
      solid.push(bb); return [x, z];
    }
    return null;
  };
  const pole = (h: number) => { const p = spot(0.5, 0.5, h); if (p) b.flag(p[0], 0, p[1], h); };
  const lantern = () => { const p = spot(0.4, 0.4, 1.7); if (p) { b.cyl(0.05, 0.06, 1.5, m.darkwood, p[0], 0, p[1], 6); b.box(0.24, 0.3, 0.24, m.glow, p[0], 1.45, p[1]); b.pyramid(0.34, 0.34, 0.2, m.iron, p[0], 1.75, p[1]); } };
  const awning = () => { const p = spot(2.2, 1.5, 2.2); if (p) { b.cyl(0.05, 0.05, 2.0, m.darkwood, p[0] - 1.0, 0, p[1] - 0.6, 6); b.cyl(0.05, 0.05, 2.0, m.darkwood, p[0] + 1.0, 0, p[1] - 0.6, 6); b.cyl(0.04, 0.04, 1.4, m.darkwood, p[0] - 1.0, 0, p[1] + 0.6, 6); b.cyl(0.04, 0.04, 1.4, m.darkwood, p[0] + 1.0, 0, p[1] + 0.6, 6); const c = b.box(2.3, 0.07, 1.5, m.shutterRed, p[0], 1.95, p[1]); c.rotation.x = 0.12; } };
  const footing = () => { b.box(hw * 2 + 0.5, 0.3, hd * 2 + 0.5, m.stone, cx, 0, cz); };
  const ring = (rad: number, y: number, h: number, mat: THREE.Material, n = 16) => { for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const p = b.box(2 * Math.PI * rad / n + 0.1, h, 0.35, mat, cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad); p.rotation.y = -a + Math.PI / 2; } };
  const generic = (bit: number) => { if (bit === 0) pole(2.8); else if (bit === 1) { lantern(); lantern(); } else if (bit === 2) awning(); else if (bit === 3) footing(); };
  const has = (bit: number) => (opts & (1 << bit)) !== 0;
  switch (kind) {
    case 0: // house
      if (has(0)) b.chimney(cx - hw * 0.45, Math.max(1.2, top - 1.1), cz, 1.7, m.stone);
      if (has(1)) { const p = spot(1.6, 0.4, 0.8); if (p) { b.box(1.6, 0.34, 0.4, m.darkwood, p[0], 0, p[1]); for (let i = 0; i < 6; i++) b.sphere(0.12, new THREE.MeshStandardMaterial({ color: [0xe04a5a, 0xf2c14e, 0xf0f0f0, 0xd070d0][i % 4] }), p[0] - 0.65 + i * 0.26, 0.5, p[1]); } }
      if (has(2)) { const p = spot(1.8, 1.2, 1.3); if (p) { for (let r = 0; r < 3; r++) for (let c = 0; c < 4 - r; c++) b.logH(1.5, 0.15, m.log, p[0], 0.18 + r * 0.3, p[1] - 0.4 + c * 0.3 + r * 0.15, 'x'); b.box(1.9, 0.07, 1.3, m.darkwood, p[0], 1.2, p[1]); } }
      if (has(3)) { b.box(0.7, 0.7, 0.7, m.plaster, cx + hw * 0.45, top - 0.35, cz); b.pyramid(0.95, 0.95, 0.5, m.tile, cx + hw * 0.45, top + 0.35, cz); b.box(0.12, 0.12, 0.05, m.door, cx + hw * 0.45, top - 0.1, cz + 0.36); }
      break;
    case 1: // farm
      if (has(0)) { const p = spot(1.2, 1.2, 2.1, 0); if (p) { b.cyl(0.05, 0.05, 1.9, m.darkwood, p[0], 0, p[1], 6); const arm = b.box(1.2, 0.07, 0.07, m.darkwood, p[0], 1.45, p[1]); arm.rotation.y = 0.4; b.sphere(0.2, m.hay, p[0], 1.95, p[1]); b.pyramid(0.6, 0.6, 0.3, m.darkwood, p[0], 2.1, p[1]); } }
      if (has(1)) for (let i = 0; i < 2; i++) { const p = spot(1.5, 1.5, 1.4); if (p) { b.dome(0.75, m.hay, p[0], 0, p[1], 1.3); b.cone(0.18, 0.5, m.hay, p[0], 0.95, p[1], 6); } }
      if (has(2)) { const n = Math.ceil((hw * 2) / 0.9); for (let i = 0; i <= n; i++) b.box(0.1, 0.9, 0.1, m.darkwood, all.min.x + i * (hw * 2) / n, 0, all.max.z + 0.5); b.box(hw * 2, 0.08, 0.06, m.wood, cx, 0.55, all.max.z + 0.5); b.box(hw * 2, 0.08, 0.06, m.wood, cx, 0.8, all.max.z + 0.5); }
      if (has(3)) { const p = spot(3.4, 2.6, 3.4); if (p) { b.box(3.2, 2.0, 2.4, m.wood, p[0], 0, p[1]); b.gable(3.4, 2.6, 1.4, m.thatch, p[0], 2.0, p[1], 0.3); b.box(1.2, 1.6, 0.1, m.door, p[0], 0, p[1] + 1.22); } }
      break;
    case 3: case 26: { // tower, keep
      const R = Math.max(hw, hd);
      const bit = (n: number) => has(n);
      if (bit(1)) { ring(R + 0.35, top - 1.6, 1.1, m.wood, 20); ring(R + 0.35, top - 0.5, 0.12, m.darkwood, 20); }
      if (kind === 3 && bit(2)) { b.cone(R + 0.5, R * 1.3 + 1.2, m.slate, cx, top, cz, 16); top += R * 1.3 + 1.2; }
      if (kind === 26 && bit(2)) for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const tx = cx + sx * (hw - 0.2), tz = cz + sz * (hd - 0.2); b.cyl(1.0, 1.1, top + 0.8, m.stone, tx, 0, tz, 12); b.cone(1.3, 1.9, m.slate, tx, top + 0.8, tz, 12); }
      if (bit(0)) b.flag(cx, top, cz, 2.6);
      if (bit(3)) { b.cyl(0.35, 0.22, 0.4, m.iron, cx + (bit(0) ? 1.0 : 0), top, cz, 8); b.cone(0.28, 0.6, m.glow, cx + (bit(0) ? 1.0 : 0), top + 0.4, cz, 8); }
      break;
    }
    case 19: // barracks
      if (has(0)) pole(4.2);
      if (has(1)) for (let i = 0; i < 2; i++) { const p = spot(1.2, 1.2, 2.0); if (p) { b.cyl(0.07, 0.07, 1.7, m.darkwood, p[0], 0, p[1], 6); b.box(1.0, 0.1, 0.1, m.darkwood, p[0], 1.35, p[1]); b.sphere(0.22, m.hay, p[0], 1.85, p[1]); } }
      if (has(2)) { const p = spot(2.4, 0.7, 2.0); if (p) { b.box(2.4, 0.08, 0.3, m.darkwood, p[0], 0.35, p[1]); b.box(2.4, 0.08, 0.3, m.darkwood, p[0], 1.2, p[1]); for (let i = 0; i < 6; i++) { b.cyl(0.03, 0.03, 2.0, m.darkwood, p[0] - 1.0 + i * 0.4, 0, p[1], 5); b.cone(0.07, 0.22, m.iron, p[0] - 1.0 + i * 0.4, 2.0, p[1], 5); } } }
      if (has(3)) { const p = spot(3.4, 2.2, 2.4); if (p) { b.box(3.2, 1.5, 2.0, m.wood, p[0], 0, p[1]); b.gable(3.4, 2.2, 1.0, m.thatch, p[0], 1.5, p[1], 0.3); b.box(0.9, 1.1, 0.1, m.darkwood, p[0], 0, p[1] + 1.02); } }
      break;
    case 15: // town hall
      if (has(0)) b.flag(cx, top, cz, 3.2);
      if (has(1)) { const x = cx + hw * 0.5; b.box(1.0, 1.0, 1.0, m.stone, x, top, cz); b.pyramid(1.3, 1.3, 1.0, m.slate, x, top + 1.0, cz); b.cyl(0.18, 0.2, 0.4, m.gold, x, top + 0.3, cz, 8); }
      if (has(2)) { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.1, 20), m.gold); d.rotation.x = Math.PI / 2; (b as unknown as { g: THREE.Group }).g.add(d); d.position.set(cx, Math.min(top - 0.8, 5.5), all.max.z + 0.04); d.castShadow = true; }
      if (has(3)) for (let i = 0; i < 4; i++) { const p = spot(2.6, 0.7, 0.7); if (p) { b.box(2.6, 0.7, 0.7, new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 1 }), p[0], 0, p[1]); b.sphere(0.12, new THREE.MeshStandardMaterial({ color: 0xe04a5a }), p[0], 0.8, p[1]); } }
      break;
    case 17: // chapel
      if (has(0)) { b.box(1.3, 3.0, 1.3, m.stone, all.max.x - 0.2, 0, cz); b.pyramid(1.8, 1.8, 1.5, m.slate, all.max.x - 0.2, 3.0, cz); }
      if (has(1)) for (const z of [-1, 1]) b.box(0.08, 1.1, 0.5, m.stained, cx, Math.min(top * 0.35, 1.4), cz + z * (hd + 0.02));
      if (has(2)) for (let i = 0; i < 5; i++) { const p = spot(0.5, 0.2, 0.8); if (p) b.box(0.45, 0.8, 0.14, m.stone, p[0], 0, p[1]); }
      if (has(3)) { const p = spot(2.2, 1.2, 2.3); if (p) { b.box(0.22, 2.0, 0.22, m.darkwood, p[0] - 1, 0, p[1]); b.box(0.22, 2.0, 0.22, m.darkwood, p[0] + 1, 0, p[1]); b.gable(2.4, 1.4, 0.8, m.tile, p[0], 2.0, p[1], 0.2); } }
      break;
    case 16: // well
      if (has(0)) { b.cyl(0.07, 0.07, 1.9, m.darkwood, cx - 0.7, 0, cz, 6); b.cyl(0.07, 0.07, 1.9, m.darkwood, cx + 0.7, 0, cz, 6); b.gable(1.8, 1.8, 0.7, m.thatch, cx, 1.9, cz, 0.2); }
      if (has(1)) { const p = spot(1.4, 0.6, 0.5); if (p) b.box(1.4, 0.45, 0.6, m.stone, p[0], 0, p[1]); }
      break;
    case 23: // drawbridge
      if (has(0)) for (const s of [-1, 1]) b.flag(cx + s * (hw - 0.4), 0, cz + hd + 0.5, 2.6);
      if (has(1)) for (const s of [-1, 1]) { b.cyl(0.05, 0.06, 1.5, m.darkwood, cx + s * (hw - 0.4), 0, cz - hd - 0.5, 6); b.box(0.24, 0.3, 0.24, m.glow, cx + s * (hw - 0.4), 1.45, cz - hd - 0.5); }
      break;
    default: for (let bit = 0; bit < 4; bit++) if (has(bit)) generic(bit);
  }
}

// ---------- smoke particles ----------
class Smoke {
  points: THREE.Points;
  private n = 700; private pos = new Float32Array(this.n * 3); private age = new Float32Array(this.n).fill(99); private vel = new Float32Array(this.n * 3);
  private attrs: { a: THREE.BufferAttribute; s: THREE.BufferAttribute }; private cursor = 0;
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const a = new THREE.BufferAttribute(new Float32Array(this.n), 1), s = new THREE.BufferAttribute(new Float32Array(this.n), 1);
    g.setAttribute('aAlpha', a); g.setAttribute('aSize', s); this.attrs = { a, s };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'attribute float aAlpha; attribute float aSize; varying float vA; void main(){ vA=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=aSize*(220./-mv.z); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'varying float vA; void main(){ float d=length(gl_PointCoord-.5)*2.; float a=smoothstep(1.,.2,d)*vA; gl_FragColor=vec4(vec3(.62,.6,.58),a); }',
    });
    this.points = new THREE.Points(g, mat); this.points.frustumCulled = false;
  }
  emit(x: number, y: number, z: number) {
    const i = this.cursor++ % this.n; this.age[i] = 0;
    this.pos.set([x + (Math.random() - 0.5) * 0.2, y, z + (Math.random() - 0.5) * 0.2], i * 3);
    this.vel.set([0.25 + Math.random() * 0.3, 0.9 + Math.random() * 0.5, (Math.random() - 0.5) * 0.3], i * 3);
  }
  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      const a = this.age[i] += dt;
      if (a > 5) { this.attrs.a.setX(i, 0); continue; }
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.attrs.a.setX(i, Math.min(1, a * 2) * (1 - a / 5) * 0.55); this.attrs.s.setX(i, 0.8 + a * 0.9);
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true; this.attrs.a.needsUpdate = this.attrs.s.needsUpdate = true;
  }
}

// ---------- scene sync ----------
interface Item { sig: string; group: THREE.Group; status: number; pop?: number }

export class VillageView {
  root = new THREE.Group();
  /** Once nothing has changed for a moment, all static building parts of the village are merged into a few big meshes. */
  batchRoot = new THREE.Group();
  /** Drawbridges are drawn up while a battle is on. */
  raised = false;
  private hiddenMeshes: THREE.Mesh[] = [];
  private batched = false; private dirty = true; private idle = 0;
  /** New buildings pop into place with a little overshoot once the village has finished loading. */
  animateNew = false;
  private items = new Map<number, Item>();
  get isBatched() { return this.batched; }
  constructor(private banner: number) {}
  private flag: Flag | undefined;
  /** Change the flag every banner flies (or go back to the plain colour with null): the buildings are rebuilt with it. */
  setFlag(f: Flag | null, color: number) { const key = f ? packFlag(f) : 0, old = this.flag ? packFlag(this.flag) : 0; if (key === old && color === this.banner) return; this.flag = f ?? undefined; this.banner = color; for (const it of this.items.values()) this.dispose(it.group); this.items.clear(); this.touch(); }
  get bannerColor() { return this.banner; }

  /** flat = World.buildings_flat() (stride 8). Returns discs [x, z, r] that should be cleared of trees. */
  sync(flat: Float32Array, radii: number[], health?: Float32Array, options?: ArrayLike<number>) {
    const n = flat.length / 10, clear: { x: number; z: number; r: number }[] = [];
    for (let i = 0; i < n; i++) {
      const [kind, tier, x, z, rot, pad, status] = [flat[i * 10], flat[i * 10 + 1], flat[i * 10 + 2], flat[i * 10 + 3], flat[i * 10 + 4], flat[i * 10 + 5], flat[i * 10 + 6]];
      const opt = options?.[i] ?? 0, sig = `${kind}:${tier}:${x}:${z}:${rot}:${opt}`;
      let it = this.items.get(i);
      if (!it || it.sig !== sig) {
        if (it) this.dispose(it.group);
        // walls are drawn by the Walls renderer as one connected structure; keep an empty placeholder so indices line up
        const g = PLAIN.has(kind) ? Object.assign(new THREE.Group(), { userData: { smoke: [], spin: [] } }) : buildModel(kind, tier, this.banner, Math.floor(Math.abs(x * 7.3 + z * 13.1)), opt, this.flag);
        g.userData.variant = Math.floor(Math.abs(x * 7.3 + z * 13.1)) % 4;
        g.position.set(x, pad, z); g.rotation.y = rot * Math.PI / 4;
        g.userData.idx = i; g.userData.kind = kind;
        this.root.add(g); it = { sig, group: g, status };
        this.items.set(i, it); this.touch();
        if (this.animateNew) { g.scale.setScalar(0.02); it.pop = 0; }
      }
      it.status = status; it.group.userData.status = status;
      if (health) {
        const burning = health[i * 3 + 2] > 0, hurt = health[i * 3 + 1] > 0 && health[i * 3] / health[i * 3 + 1] < 0.4, ch = burning || hurt;
        if (!!it.group.userData.charred !== ch) { it.group.userData.charred = ch; setCharred(it.group, ch, it.group.userData.variant ?? 0); this.touch(); }
      }
      clear.push({ x, z, r: radii[kind] * 1.15 + 3.5 });
    }
    for (const [i, it] of [...this.items]) if (i >= n) { this.dispose(it.group); this.items.delete(i); this.touch(); }
    return clear;
  }

  /** Something changed: go back to individual meshes and restart the idle timer. */
  private touch() { if (this.batched) this.unbatch(); this.dirty = true; this.idle = 0; }

  /** Call every frame. */
  update(dt: number) {
    for (const it of this.items.values()) {
      if (it.pop === undefined) continue;
      it.pop += dt / 0.6; const t = Math.min(1, it.pop), c1 = 1.70158, c3 = c1 + 1, k = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);   // ease-out-back
      it.group.scale.set(k, Math.max(0.02, k * (1 + 0.1 * Math.sin(t * Math.PI))), k);
      if (t >= 1) { it.group.scale.setScalar(1); it.pop = undefined; this.idle = Math.min(this.idle, 0.9); }
    }
    if (this.dirty && !this.batched) { this.idle += dt; if (this.idle > 1.5) this.batch(); }
  }

  private batch() {
    const per = new Map<THREE.Material, THREE.BufferGeometry[]>(); this.hiddenMeshes = [];
    for (const it of this.items.values()) {
      const g = it.group; if (PLAIN.has(g.userData.kind) || g.userData.charred) continue;
      g.updateMatrixWorld(true);
      g.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.userData.baked || !m.visible) return;
        const geo = m.geometry.clone(); geo.applyMatrix4(m.matrixWorld);
        let list = per.get(m.material as THREE.Material); if (!list) { list = []; per.set(m.material as THREE.Material, list); }
        list.push(geo); this.hiddenMeshes.push(m);
      });
    }
    for (const [mat, geos] of per) {
      const merged = mergeGeometries(geos); geos.forEach(x => x.dispose()); if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false; this.batchRoot.add(mesh);
    }
    this.hiddenMeshes.forEach(m => (m.visible = false));   // still pickable: raycasting ignores visibility
    this.batched = true; this.dirty = false;
  }

  private unbatch() {
    this.hiddenMeshes.forEach(m => (m.visible = true)); this.hiddenMeshes = [];
    for (const c of this.batchRoot.children.slice()) { this.batchRoot.remove(c); (c as THREE.Mesh).geometry.dispose(); }
    this.batched = false;
  }
  private dispose(g: THREE.Group) { this.root.remove(g); g.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  groupOf(i: number) { return this.items.get(i)?.group; }
  pick(ray: THREE.Raycaster): number | null {
    const hit = ray.intersectObjects(this.root.children, true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && o.userData.idx === undefined) o = o.parent;
    return o ? o.userData.idx : null;
  }
}

export class Effects {
  smoke = new Smoke();
  private acc = 0;
  private v = new THREE.Vector3();
  update(dt: number, t: number, views: VillageView[]) {
    this.acc += dt;
    const emit = this.acc > 0.28; if (emit) this.acc = 0;
    for (const view of views) for (const g of view.root.children) {
      const sp: THREE.Object3D[] = g.userData.spin;
      for (const o of sp) {
        if (o.parent === g || o.parent?.parent === g) {
          if (o.userData.deck) { o.rotation.x += (((view.raised || g.userData.status === 5) ? -1.3 : 0) - o.rotation.x) * (1 - Math.exp(-dt * 2)); continue; }
          if ((o as THREE.Mesh).geometry && (o as THREE.Mesh).geometry.type === 'PlaneGeometry') o.rotation.y = Math.sin(t * 3 + g.position.x) * 0.25;
          else o.rotation.z += dt * 0.5 * (g.userData.status === 0 || g.userData.kind === 1 ? 1 : 0.15);
        }
      }
      if (emit && g.userData.status === 0) {
        for (const s of g.userData.smoke as THREE.Vector3[]) { this.v.copy(s).applyEuler(g.rotation).add(g.position); this.smoke.emit(this.v.x, this.v.y, this.v.z); }
      }
    }
    this.smoke.update(dt);
  }
}

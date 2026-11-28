import * as THREE from 'three';
import { packFlag, ROOFS, type Flag } from '../flag';
import { flagTexture } from './flagtex';
import { drawnUp } from '../defence';
import { Particles, type EffectView } from './fx';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PEN_HALF_DEPTH, PEN_HALF_WIDTH } from '../pasture';
import { makeBoat } from './field';
import { tileableNoise } from './water';
import { painted, PAINTERS } from './painted';

// ---------- procedural textures & materials ----------
const TILE = 2; // one texture repeat covers 2 world units
function tex(paint: (g: CanvasRenderingContext2D, s: number) => void, s = 256) {
  const c = document.createElement('canvas'); c.width = c.height = s;
  paint(c.getContext('2d', { willReadFrequently: true })!, s);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.userData.canvas = c;
  return t;
}
const speckle = (g: CanvasRenderingContext2D, s: number, n: number, a: number) => {
  for (let i = 0; i < n; i++) { const v = Math.random() > 0.5 ? 255 : 0; g.fillStyle = `rgba(${v},${v},${v},${Math.random() * a})`; g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2); }
};
const wave = (n: number) => Math.cos(n * Math.PI * 2);
type Grain = (u: number, v: number, wear: number, grit: number) => number;

function grainTile(colour: [number, number, number], grain: Grain) {
  return tex((g, size) => {
    const weather = tileableNoise(size, [[4, 0.7, false], [12, 0.3, false]], 6151);
    const grit = tileableNoise(size, [[45, 0.7, false], [90, 0.3, false]], 7901);
    const image = g.getImageData(0, 0, size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const light = grain((x + 0.5) / size, (y + 0.5) / size, weather[i] - 0.5, grit[i] - 0.5);
      for (let c = 0; c < 3; c++) image.data[i * 4 + c] = colour[c] * light;
      image.data[i * 4 + 3] = 255;
    }
    g.putImageData(image, 0, 0);
  });
}

/** Derive a tangent-space normal map from a painted texture: dark mortar, grooves and gaps become recesses, light parts stand proud. */
function normalFrom(c: HTMLCanvasElement, strength: number) {
  const s = c.width, src = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, s, s).data, h = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) h[i] = (src[i * 4] * 0.3 + src[i * 4 + 1] * 0.59 + src[i * 4 + 2] * 0.11) / 255;
  const out = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const l = h[y * s + ((x + s - 1) % s)], r = h[y * s + ((x + 1) % s)], u = h[((y + s - 1) % s) * s + x], d = h[((y + 1) % s) * s + x];
    let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1; const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    out.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255], (y * s + x) * 4);
  }
  const t = new THREE.DataTexture(out, s, s, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}
let _m: ReturnType<typeof makeMats> | null = null;
function makeMats() {
  const std = (map: THREE.Texture | null, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ map, normalMap: map ? normalFrom(map.userData.canvas, 3.2) : null, normalScale: new THREE.Vector2(1, 1), vertexColors: true, roughness: 0.92, metalness: 0, ...extra });
  const col = (c: number, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: c, vertexColors: true, roughness: 0.9, ...extra });
  // the walls and roofs: hand-painted, piece by piece (see painted.ts)
  const pt = (name: keyof typeof PAINTERS, extra: THREE.MeshStandardMaterialParameters = {}) => { const t = painted(name); return new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(1, 1), vertexColors: true, roughness: 0.92, metalness: 0, ...extra }); };
  return {
    wood: pt('wood', { normalScale: new THREE.Vector2(0.8, 0.8) }),
    darkwood: pt('darkwood', { normalScale: new THREE.Vector2(0.8, 0.8) }),
    plaster: pt('plaster'),
    timber: pt('timber'),
    flemish: pt('flemish'),
    mud: pt('mud'),
    cobble: pt('cobble'),
    stoneMat: col(0xbdb4a0),
    shutter: col(0x3f6a4a), shutterRed: col(0x8a2f26), shutterBlue: col(0x2f4f7a),
    stone: pt('stone'),
    darkstone: pt('darkstone'),
    brick: pt('brick'),
    thatch: pt('thatch', { normalScale: new THREE.Vector2(0.75, 0.75) }),
    tile: pt('tile'),
    slate: pt('slate'),
    trampled: std(grainTile([96, 75, 56], (_u, _v, wear, grit) => 0.96 + 0.62 * wear + 0.25 * grit)),
    wallow: std(grainTile([85, 68, 54], (u, v, wear, grit) => 0.97 + 0.43 * wear + 0.10 * grit + 0.05 * wave(u * 2 - v * 3)), { roughness: 0.67 }),
    field: std(tex((g, s) => { g.fillStyle = '#7b8c3e'; g.fillRect(0, 0, s, s); for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? 'rgba(180,170,70,.55)' : 'rgba(80,60,30,.35)'; g.fillRect(0, i * s / 10, s, s / 10 - 3); } speckle(g, s, 500, 0.15); }), { roughness: 1 }),
    // garden and yard materials for the design options: furrowed soil, leafy foliage, straw and bark, so beds, bushes and stacks read as real things up close
    soil: std(tex((g, s) => { g.fillStyle = '#4b3523'; g.fillRect(0, 0, s, s); for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? 'rgba(15,8,4,.4)' : 'rgba(135,100,68,.32)'; g.fillRect(0, i * s / 8, s, s / 8 - 5); } speckle(g, s, 1600, 0.3); }), { roughness: 1 }),
    leaf: std(tex((g, s) => { g.fillStyle = '#4f8a3c'; g.fillRect(0, 0, s, s); for (let i = 0; i < 300; i++) { g.fillStyle = Math.random() > 0.5 ? `rgba(160,205,95,${0.16 + 0.22 * Math.random()})` : `rgba(18,58,24,${0.2 + 0.22 * Math.random()})`; g.beginPath(); g.ellipse(Math.random() * s, Math.random() * s, 2 + Math.random() * 7, 1 + Math.random() * 4, Math.random() * 3, 0, 7); g.fill(); } }), { roughness: 1 }),
    straw: std(tex((g, s) => { g.fillStyle = '#d4b258'; g.fillRect(0, 0, s, s); for (let i = 0; i < 420; i++) { g.strokeStyle = Math.random() > 0.5 ? 'rgba(255,235,150,.35)' : 'rgba(120,85,25,.3)'; g.lineWidth = 1.2; const x = Math.random() * s, y = Math.random() * s; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 10, y + 8 + Math.random() * 18); g.stroke(); } }), { roughness: 1 }),
    bark: std(tex((g, s) => { g.fillStyle = '#7d5a37'; g.fillRect(0, 0, s, s); for (let i = 0; i < 70; i++) { g.fillStyle = Math.random() > 0.5 ? 'rgba(40,24,10,.38)' : 'rgba(190,150,100,.22)'; g.fillRect(Math.random() * s, 0, 1 + Math.random() * 3, s); } speckle(g, s, 500, 0.2); })),
    dove: col(0xf4f1e8, { roughness: 0.8 }),
    bloom: [0xd9404f, 0xf2c14e, 0xf4f1e8, 0xc862b8].map(c => col(c, { roughness: 0.8 })),
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
  /** Named groups of parts that an optional upgrade may take the place of (the roof a spire replaces), each with what an upgrade needs to know about it. */
  slots = new Map<string, THREE.Group>();
  slot(name: string, info: Record<string, number | string>, build: () => void) {
    const outer = this.g, g = new THREE.Group(); g.userData.slot = name; g.userData.info = info;
    this.g = g; build(); this.g = outer; outer.add(g); this.slots.set(name, g);
  }
  /** The flags of the other cities (the embassy flies one for each). */
  foreign: Flag[] = [];
  constructor(public t: number, public banner: number, public flagDesign?: Flag, public roof = 0) {}
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
  private add<T extends THREE.Object3D>(o: T, x: number, y: number, z: number) { o.position.set(x, y, z); o.traverse(c => { const m = c as THREE.Mesh; m.castShadow = true; m.receiveShadow = true; if (m.isMesh) { this.shade(m.geometry, y); if (this.roof && m.material === M().tile) m.material = roofTile(this.roof); } }); this.g.add(o); return o; }
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
    const { uv, position, normal } = geo.attributes;
    const slopeLength = Math.hypot(e, h);
    for (let i = 0; i < uv.count; i++) {
      if (normal.getY(i) > 0.05) uv.setXY(i, position.getX(i) / TILE, position.getY(i) * slopeLength / (h * TILE));
      else uv.setXY(i, uv.getX(i) / TILE, uv.getY(i) / TILE);
    }
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
  flag(x: number, y: number, z: number, h = 2.2, width = 1.1) { this.flagOf(this.flagDesign, x, y, z, h, width); }
  /** A pole with a flag of the given design (the plain banner colour when there is none). */
  flagOf(design: Flag | undefined, x: number, y: number, z: number, h = 2.2, width = 1.1) {
    this.cyl(0.05, 0.05, h, M().darkwood, x, y, z, 6);
    const height = width * 2 / 3;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(width, height).translate(width * 0.5, 0, 0), design ? new THREE.MeshStandardMaterial({ map: flagTexture(design), side: THREE.DoubleSide, roughness: 0.8 }) : new THREE.MeshStandardMaterial({ color: this.banner, side: THREE.DoubleSide, roughness: 0.8 }));
    cloth.name = 'village-flag'; cloth.userData.fixed = true; this.add(cloth, x, y + h - height * 0.5 - 0.05, z);
    this.spin.push(cloth); // waves
  }
  chimney(x: number, y: number, z: number, h = 1.4, mat: THREE.Material = M().stone) { this.box(0.6, h, 0.6, mat, x, y, z); this.smoke.push(new THREE.Vector3(x, y + h + 0.1, z)); }
  battlements(w: number, d: number, y: number, mat: THREE.Material, h = 0.45, n = 6) {
    for (let i = 0; i < n; i++) { const x = -w / 2 + (i + 0.5) * (w / n); this.box(w / n * 0.55, h, 0.35, mat, x, y, d / 2 - 0.2); this.box(w / n * 0.55, h, 0.35, mat, x, y, -d / 2 + 0.2); }
    for (let i = 1; i < n - 1; i++) { const z = -d / 2 + (i + 0.5) * (d / n); this.box(0.35, h, d / n * 0.55, mat, w / 2 - 0.2, y, z); this.box(0.35, h, d / n * 0.55, mat, -w / 2 + 0.2, y, z); }
  }
}


// ---------- the village's roof tile palette ----------
const roofMats = new Map<number, THREE.Material>();
/** The terracotta tile material tinted to palette `r` of the village's roof style (see ROOFS in flag.ts): the same grain and bump, a different colour. One shared material per palette. */
export function roofTile(r: number): THREE.Material {
  let m = roofMats.get(r);
  if (!m) {
    const c = (M().tile as THREE.MeshStandardMaterial).clone(), t = ROOFS[r]?.rgb ?? ROOFS[0].rgb, base = ROOFS[0].rgb;
    c.color.setRGB(t[0] / base[0], t[1] / base[1], t[2] / base[2]); roofMats.set(r, c); m = c;
  }
  return m;
}

// ---------- per-building variation and fire damage ----------
const variantCache = new Map<string, THREE.Material>();
const glows = (m: THREE.Mesh) => ((m.material as THREE.MeshStandardMaterial).emissiveIntensity ?? 0) >= 1.5;
const glassVariants: THREE.MeshStandardMaterial[] = [];
let nightLevel = 0;
/** At night the windows glow a warm yellow: the glass material and its per-building colour variants. `n` is 0 by day, 1 at night. */
export function setNightLight(n: number) {
  nightLevel = n;
  for (const g of [M().glass as THREE.MeshStandardMaterial, ...glassVariants]) { g.emissive.setRGB(1, 0.72, 0.35); g.emissiveIntensity = n * 1.7; }
}
function variantOf(mat: THREE.Material, v: number): THREE.Material {
  const key = mat.uuid + ':' + v; let c = variantCache.get(key);
  if (!c) {
    c = mat.clone(); const sm = c as THREE.MeshStandardMaterial;
    if (mat === M().glass && v !== -1) { glassVariants.push(sm); sm.emissive.setRGB(1, 0.72, 0.35); sm.emissiveIntensity = nightLevel * 1.7; }
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
// ---------- batching by surface ----------
// A merged cell used one mesh (one draw call) per material object, and every building's colour variant is its own material. The variants differ only in their base
// colour, which the standard shader multiplies with the vertex colour, so the base colour is baked into the vertex colours and every part with the same surface (texture,
// roughness, metalness, glow, sides...) shares one material. The picture is the same; the CPU prepares far fewer draws each frame.
const foldIds = new WeakMap<object, number>(); let foldNext = 1;
const idOf = (o: object | null | undefined) => { if (!o) return 0; let n = foldIds.get(o); if (!n) { n = foldNext++; foldIds.set(o, n); } return n; };
const foldedMats = new Map<string, THREE.MeshStandardMaterial>();
/** The surface a material draws, without its base colour; null when its parts must keep their own material (anything that changes while the game runs: glass glows at night). */
function foldKey(mat: THREE.Material): string | null {
  const m = mat as THREE.MeshStandardMaterial;
  if (m.type !== 'MeshStandardMaterial' || m.transparent || m.alphaTest > 0 || glassVariants.includes(m) || m === M().glass || (m.emissiveIntensity ?? 0) >= 1.5) return null;
  return ['std', idOf(m.map), idOf(m.normalMap), idOf(m.roughnessMap), idOf(m.emissiveMap), idOf(m.aoMap), idOf(m.metalnessMap), idOf(m.bumpMap), idOf(m.alphaMap), idOf(m.lightMap),
    idOf(m.envMap), idOf(m.displacementMap), m.envMapIntensity, m.normalScale.x, m.normalScale.y, m.bumpScale, m.aoMapIntensity, m.wireframe ? 1 : 0, m.toneMapped ? 1 : 0, m.shadowSide ?? '',
    m.roughness, m.metalness, m.emissive.getHexString(), m.emissiveIntensity, m.side, m.flatShading ? 1 : 0,
    m.fog ? 1 : 0, m.depthWrite ? 1 : 0, m.depthTest ? 1 : 0, m.colorWrite ? 1 : 0, m.polygonOffset ? `${m.polygonOffsetFactor}/${m.polygonOffsetUnits}` : '', idOf(m.onBeforeCompile), m.customProgramCacheKey ? m.customProgramCacheKey() : ''].join('|');
}
/** One shared material per surface: the first material's settings with a white base colour, drawing the vertex colours. */
function foldedMaterial(key: string, like: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = foldedMats.get(key);
  if (!m) { m = like.clone(); m.color.setRGB(1, 1, 1); m.vertexColors = true; m.onBeforeCompile = like.onBeforeCompile; m.needsUpdate = true; foldedMats.set(key, m); }
  return m;
}
/** The part's vertex colours times the material's base colour (white vertex colours when the material drew none), as floats; null if the part cannot be baked. */
function bakeColour(geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial): THREE.BufferGeometry | null {
  const pos = geo.attributes.position; if (!pos) return null;
  const src = mat.vertexColors ? geo.attributes.color as THREE.BufferAttribute | undefined : undefined;
  const out = new Float32Array(pos.count * 3), c = mat.color;
  for (let i = 0; i < pos.count; i++) {
    const r = src ? src.getX(i) : 1, g = src ? src.getY(i) : 1, b = src ? src.getZ(i) : 1;
    out[i * 3] = r * c.r; out[i * 3 + 1] = g * c.g; out[i * 3 + 2] = b * c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
  return geo;
}
/** Give every geometry of a batch the same layout, which merging needs: all indexed or none, and the same attributes. A missing colour is filled with white (the
 *  material's own colour shows, as when the part had none), missing normals are computed, anything else missing is zeros. Folded batches always carry colours. */
function sameLayout(geos: THREE.BufferGeometry[], folded: boolean): THREE.BufferGeometry[] {
  if (geos.length < 2) return geos;
  const indexed = geos.every(g => g.index);
  const out = indexed ? geos : geos.map(g => { if (!g.index) return g; const n = g.toNonIndexed(); g.dispose(); return n; });
  const names = new Map<string, { size: number; normalized: boolean }>();
  for (const g of out) for (const [k, a] of Object.entries(g.attributes)) if (!names.has(k)) names.set(k, { size: a.itemSize, normalized: (a as THREE.BufferAttribute).normalized });
  if (folded) names.set('color', { size: 3, normalized: false });
  for (const g of out) {
    for (const [k, { size, normalized }] of names) {
      const a = g.attributes[k] as THREE.BufferAttribute | undefined;
      if (a && a.itemSize === size && a.normalized === normalized && a.array instanceof Float32Array && !(a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
      if (!a && k === 'normal') { g.computeVertexNormals(); continue; }
      const n = g.attributes.position.count, f = new Float32Array(n * size);
      if (a) {
        const read = [a.getX, a.getY, a.getZ, a.getW];   // (these denormalise, and also read interleaved attributes)
        for (let i = 0; i < n; i++) for (let j = 0; j < size; j++) f[i * size + j] = j < a.itemSize ? read[j].call(a, i) : 0;
      } else if (k === 'color') f.fill(1);
      g.setAttribute(k, new THREE.BufferAttribute(f, size, false));
    }
    g.morphAttributes = {};
    g.clearGroups();
  }
  return out;
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
  b.box(4, 2.4, 3, bm, -1.2, 0.2, -4.4); b.gable(4, 3, 1.8 + t * 0.2, t >= 1 ? m.tile : m.thatch, -1.2, 2.6, -4.4, 0.45);   // (behind the fields, which end at z = -2.8)
  b.box(1.5, 1.7, 0.12, m.door, -1.2, 0.2, -5.96);   // the door is in the back wall of the barn, away from the fields: the farm's road leaves from there (see doors.rs)
  if (t >= 1) { b.cyl(0.8, 0.8, 0.9, m.hay, 4.9, 0.1, -3.9, 10); b.cyl(0.65, 0.65, 0.75, m.hay, 4.9, 0.1, -5.4, 10); } else { b.cyl(0.8, 0.8, 0.9, m.hay, 3.2, 0.1, -4.0, 10); b.cyl(0.65, 0.65, 0.75, m.hay, 4.4, 0.1, -4.4, 10); }   // (from tier 1 the silo stands where the bales were, so they move beside it)
  if (t >= 1) { b.cyl(0.95, 1.0, 4.2, t >= 2 ? m.stone : m.wood, 2.8, 0.1, -4.2, 14); b.cone(1.1, 1.0, m.slate, 2.8, 4.3, -4.2, 14); }
  if (t >= 2) {
    b.cyl(0.4, 0.85, 4.2, m.plaster, -6.5, 0.1, 2.8, 12); b.cone(0.75, 1.1, m.thatch, -6.5, 4.3, 2.8, 12);   // (beside the fields, not on them)
    const bl = new THREE.Group(); for (let i = 0; i < 4; i++) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.4, 0.05), m.wood); arm.position.y = 1.7; const w = new THREE.Group(); w.add(arm); w.rotation.z = i * Math.PI / 2; bl.add(w); }
    bl.position.set(-6.5, 4.2, 3.7); b.g.add(bl); b.spin.push(bl);
  }
  if (t === 3) b.flag(-1.2, 4.2, -4.4, 1.8);
  // a bigger farm works more fields: a second beside the first, a third below it and a fourth in the corner (the farm's footprint grows to make room)
  const crop = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 });
  const extra: [number, number, number, number, number][] = [[5.0, 8.4, 7.9, 1.4, 0xc9a43b], [10.4, 4.6, 0, 8.0, 0x6f9a3a], [5.0, 4.6, 7.9, 8.0, 0x8a6a3a]];
  for (let i = 0; i < Math.min(3, t); i++) {
    const [w, d, x, z, c] = extra[i]; b.box(w, 0.1, d, crop(c), x, 0.02, z);
    for (let k = 0; k < Math.floor(d / 1.2); k++) b.box(w - 0.4, 0.06, 0.18, crop(c === 0xc9a43b ? 0xe0bc4a : c === 0x6f9a3a ? 0x4f8a2f : 0x6b4a28), x, 0.1, z - d / 2 + 0.7 + k * 1.2);   // crop rows
  }
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
    b.slot('roof', { shape: 'pyramid', w: 3.6, y: 6.8, h: 1.6 }, () => b.pyramid(3.6, 3.6, 1.6, m.thatch, 0, 6.8, 0));
    for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) b.box(0.15, 1.6, 0.15, m.log, x, 5.2, z);
    b.box(1.8, 1.9, 0.12, m.door, 0, 0, 0.98);                                            // boarded door between the front legs
    for (const s of [-0.35, 0.35]) b.box(0.08, 5.0, 0.08, m.darkwood, s, 0, 1.6);         // ladder up to the platform
    for (let y = 0.4; y < 4.9; y += 0.5) b.box(0.7, 0.06, 0.06, m.darkwood, 0, y, 1.6);
  } else if (t === 1) {
    b.cyl(1.7, 1.9, 4.6, m.stone, 0, -0.2, 0, 14); b.cyl(2.1, 2.1, 0.4, m.darkwood, 0, 4.2, 0, 14);
    parapet(1.95, 4.6, m.wood, 12);
    for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) b.box(0.16, 1.8, 0.16, m.log, x, 4.6, z);
    b.slot('roof', { shape: 'pyramid', w: 4.4, y: 6.4, h: 1.7 }, () => b.pyramid(4.4, 4.4, 1.7, m.tile, 0, 6.4, 0));
    door(2.0); b.window(0, 3.0, 1.74, 0, 0.3, 0.6);
  } else {
    const r = t === 2 ? 1.8 : 2.2, H = t === 2 ? 7.2 : 9;
    b.cyl(r, r + 0.35, H, m.stone, 0, -0.3, 0, 16); b.cyl(r + 0.35, r + 0.45, 0.5, m.darkstone, 0, H - 0.4, 0, 16);
    parapet(r + 0.3, H + 0.1, m.stone);
    b.cyl(r * 0.6, r * 0.7, 1.2, m.stone, 0, H, 0, 12);   // a stair turret in the middle; the ring round it is the walkway
    b.slot('roof', { shape: 'cone', r: r * 0.75, y: H + 1.2, h: 2.2, flag: t === 3 ? 1 : 0 }, () => { b.cone(r * 0.75, 2.2, m.slate, 0, H + 1.2, 0, 12); if (t === 3) b.flag(0, H + 3, 0, 2.2); });
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

/** A forester's hut: a small timber cabin with a sapling bed, a wheelbarrow and a few young trees. */
const forester: Model = b => {
  const t = b.t, m = M(), leaf = new THREE.MeshStandardMaterial({ color: 0x4c8c42, roughness: 0.9 });
  b.box(2.8, 1.8, 2.3, t >= 1 ? m.timber : m.wood, -0.3, 0, -0.4); b.gable(2.8, 2.3, 1.2 + t * 0.2, t >= 1 ? m.tile : m.thatch, -0.3, 1.8, -0.4, 0.35);
  b.box(0.7, 1.3, 0.12, m.door, -0.3, 0, 0.78);
  for (let i = 0; i < 4; i++) { b.cyl(0.05, 0.07, 0.7 + (i % 2) * 0.25, m.log, 1.9 + (i % 2) * 0.5, 0, -1 + i * 0.55, 5); b.sphere(0.3 + (i % 2) * 0.08, leaf, 1.9 + (i % 2) * 0.5, 0.95 + (i % 2) * 0.25, -1 + i * 0.55); }
  b.box(0.9, 0.35, 0.6, m.wood, -2.3, 0.3, 1.5); b.cyl(0.22, 0.22, 0.08, m.iron, -2.3, 0.22, 1.9, 10).rotation.x = Math.PI / 2; b.box(0.08, 0.08, 0.9, m.darkwood, -2.3, 0.5, 2.2);
  if (t >= 2) b.chimney(0.6, 2.2, -0.9);
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
  const m = M(), t = b.t;
  // a square-cut digging: a bank of earth round a wet clay floor, stepped clay faces behind it and a plank ramp down from the front
  b.box(4.6, 0.1, 3.4, m.earth, -0.5, -0.04, -0.6, 0.08);
  b.box(3.8, 0.16, 2.6, m.clay, -0.5, 0.0, -0.6, 0.08);
  for (const [w, d, x, z] of [[4.8, 0.7, -0.5, -2.5], [0.7, 3.2, -3.0, -0.6], [0.7, 3.2, 2.0, -0.6], [1.8, 0.7, -2.0, 1.2], [1.8, 0.7, 0.9, 1.2]] as const) b.box(w, 0.42, d, m.mud, x, 0, z);
  for (let i = 0; i < 3; i++) b.box(3.6 - i * 0.9, 0.34, 0.5, m.clay, -0.5, 0.3 + i * 0.34, -2.55 + i * 0.12);
  const ramp = b.box(0.9, 0.08, 1.9, m.darkwood, -0.7, 0.12, 1.1); ramp.rotation.x = -0.18;
  b.box(0.12, 1.1, 0.12, m.darkwood, 1.2, 0.2, -1.2); b.box(0.5, 0.1, 0.1, m.darkwood, 1.2, 1.2, -1.2);   // a shovel stuck in the clay
  // raw clay bricks drying on a rack under a lean-to roof
  for (const [x, z] of [[-3.4, 1.0], [-1.8, 1.0], [-3.4, 2.8], [-1.8, 2.8]] as const) b.box(0.14, 1.5, 0.14, m.darkwood, x, 0, z);
  b.box(2.0, 0.1, 2.1, m.thatch, -2.6, 1.5, 1.9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) b.box(0.55, 0.22, 0.34, m.clay, -2.9 + i * 0.6, 0.06 + (j % 2) * 0.25, 1.2 + Math.floor(j / 2) * 1.2);
  // a wheelbarrow and a puddling trough
  b.box(0.9, 0.3, 0.6, m.wood, -0.5, 0.35, 2.6); b.box(0.7, 0.1, 0.4, m.clay, -0.5, 0.65, 2.6);
  b.box(0.1, 0.35, 0.1, m.darkwood, -0.1, 0, 2.3); b.box(0.1, 0.35, 0.1, m.darkwood, -0.1, 0, 2.9); b.cyl(0.22, 0.22, 0.08, m.iron, -1.05, 0.22, 2.6, 8).rotation.x = Math.PI / 2;
  b.box(1.2, 0.5, 0.8, m.wood, 0.7, 0, 3.4); b.box(1.0, 0.1, 0.6, m.clay, 0.7, 0.5, 3.4);
  b.box(2.4, 1.8, 2, t >= 1 ? m.timber : m.wood, 2.4, 0, 2); b.gable(2.4, 2, 1.1, t >= 1 ? m.tile : m.thatch, 2.4, 1.8, 2, 0.3);
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
  // The mine is the entrance only: it is placed against the deposit (see depositSnap in main.ts), whose rocks stand just behind the door.
  const post = t >= 2 ? m.stone : m.darkwood;
  b.box(3.6, 0.6, 2.6, m.rock, 0, -0.2, -1.2);   // a shelf of spoil in front of the face, so the door is not left floating on a slope (its top, 0.4, stays clear of the stone footing option's top at 0.3: the same height z-fought)
  b.box(0.45, 2.4, 0.45, post, -1.1, 0, -1.9); b.box(0.45, 2.4, 0.45, post, 1.1, 0, -1.9); b.box(3, 0.5, 0.6, post, 0, 2.2, -1.9);
  b.box(1.8, 1.9, 0.2, new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 }), 0, 0, -2.0);
  for (let i = 0; i < 3; i++) b.box(0.18, 0.18, 1.2, m.iron, -0.3 + i * 0.3, 0.02, 2.5 + i * 0.5).visible = false;
  b.box(1.3, 0.7, 0.9, m.wood, 2, 0.25, 2.4, 0.4); for (const dx of [-0.4, 0.4]) b.cyl(0.25, 0.25, 0.1, m.iron, 2 + dx, 0.15, 2.9, 10).rotation.x = Math.PI / 2;
  const pile = gold ? m.goldPile : m.ironPile;
  for (const [x, z, r] of [[-2.6, 2.4, 0.9], [-1.6, 3, 0.6], [3.2, 0.6, 0.7]] as const) b.cone(r, r * 1.1, pile, x, 0, z, 7);
  if (gold) { b.box(0.9, 0.6, 0.6, m.darkwood, 3.1, 0, 3); b.box(0.92, 0.1, 0.62, m.gold, 3.1, 0.6, 3); }
  if (t >= 1) b.gable(3.4, 2.2, 1.0, t >= 2 ? m.slate : m.tile, 0, 2.6, -1.9, 0.3);
};

let _charTurf: THREE.MeshStandardMaterial | null = null, _charCoal: THREE.MeshStandardMaterial | null = null, _charHole: THREE.MeshStandardMaterial | null = null;
const charcoal: Model = b => {
  const t = b.t, m = M();
  const turf = (_charTurf ??= new THREE.MeshStandardMaterial({ color: 0x5f6e32, roughness: 1, vertexColors: true }));
  const coal = (_charCoal ??= new THREE.MeshStandardMaterial({ color: 0x2a2a2d, roughness: 0.95, vertexColors: true }));
  const hole = (_charHole ??= new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: 1, vertexColors: true }));
  let seed = 1234567;   // fixed seed: every client draws the same site
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  /** A charcoal clamp: upright billets stacked tight and leaning in, under stepped, faceted layers of turf and earth with a smoke vent on top. */
  const clamp = (cx: number, cz: number, R: number, base: number) => {
    const s = R / 1.9;
    if (base > 0) b.cyl(R + 0.3, R + 0.4, base, t >= 3 ? m.darkstone : m.stone, cx, 0, cz, 12);
    const n = Math.round(10 + R * 3);
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + rnd() * 0.12, rr = R - 0.12, h = (1.1 + rnd() * 0.4) * s, rad = (0.17 + rnd() * 0.05) * Math.max(s, 0.7);
      const bl = b.cyl(rad, rad, h, i % 3 ? m.log : m.darkwood, cx + Math.cos(a) * rr, base, cz + Math.sin(a) * rr, 5);
      bl.rotation.z = 0.28 * Math.cos(a); bl.rotation.x = -0.28 * Math.sin(a);
    }
    b.cyl(R * 0.7, R - 0.4, 0.95 * s, turf, cx, base + 0.2 * s, cz, 9);
    b.cyl(R * 0.5, R * 0.72, 0.75 * s, m.earth, cx, base + 1.1 * s, cz, 8);
    b.cyl(R * 0.3, R * 0.52, 0.6 * s, m.mound, cx, base + 1.8 * s, cz, 7);
    b.cyl(0.24 * s + 0.05, 0.34 * s + 0.05, 0.55 * s, m.iron, cx, base + 2.35 * s, cz, 7);
    b.smoke.push(new THREE.Vector3(cx, base + 3.1 * s, cz));
    for (let i = 0; i < 8; i++) {   // patches of earth on the turf and turf on the earth
      const a = rnd() * Math.PI * 2, low = i < 4, r = low ? R * 0.74 : R * 0.52;
      b.box(0.5 * s, 0.14, 0.38 * s, low ? m.earth : turf, cx + Math.cos(a) * r, base + (low ? 0.75 : 1.5) * s, cz + Math.sin(a) * r, -a);
    }
    for (let i = 0; i < 8; i++) { const a = (i + 0.5) / 8 * Math.PI * 2; b.box(0.2, 0.14, 0.2, hole, cx + Math.cos(a) * (R + 0.15), base, cz + Math.sin(a) * (R + 0.15), -a); }   // air holes round the foot
  };
  clamp(-0.6, -0.2, 1.9, t >= 2 ? 0.25 : 0);
  if (t >= 1) clamp(1.7, -2.4, 1.15, 0);
  if (t >= 2) clamp(-2.7, -2.1, 0.8, 0);

  // the burner's shelter: a lean-to at first, then a hut with a gabled roof
  if (t === 0) {
    for (const [x, z, h] of [[1.4, 0.9, 1.4], [3.1, 0.9, 1.4], [1.4, 2.5, 2.0], [3.1, 2.5, 2.0]]) b.box(0.18, h, 0.18, m.darkwood, x, 0, z);
    b.box(1.8, 1.9, 0.12, m.wood, 2.25, 0, 2.55);
    const roof = b.box(2.3, 0.18, 2.1, m.thatch, 2.25, 1.55, 1.7); roof.rotation.x = 0.3;
    b.box(0.9, 0.2, 0.5, m.wood, 2.2, 0.15, 2.1);   // a cot of boards
  } else {
    const w = t >= 2 ? 2.4 : 2.0, d = t >= 2 ? 2.0 : 1.8, hh = t >= 2 ? 1.9 : 1.6;
    b.box(w, hh, d, t >= 2 ? m.timber : m.wood, 2.3, 0, 1.6);
    b.gable(w, d, 1.0 + t * 0.15, t >= 2 ? m.tile : m.thatch, 2.3, hh, 1.6, 0.3);
    b.box(0.7, 1.3, 0.12, m.door, 2.0, 0, 1.6 - d / 2 - 0.04 + 0.0);
    if (t >= 2) b.chimney(3.2, hh, 1.0, 1.0);
    if (t >= 3) b.flag(1.2, hh, 2.2, 2.0);
  }
  // cut logs and split billets
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3 - i; j++) b.logH(1.7, 0.2, m.log, -2.9, 0.2 + i * 0.36, 0.9 + j * 0.42 + i * 0.21, 'x');
  for (const [x, z] of [[-3.2, 2.5], [-2.8, 2.6], [-3.0, 2.95], [-2.55, 2.95]]) b.cyl(0.16, 0.16, 0.7 + rnd() * 0.3, m.darkwood, x, 0, z, 6);
  for (let i = 0; i < 4; i++) b.box(0.55, 0.14, 0.14, m.wood, -2.1 + (i % 2) * 0.1, 0.07 + Math.floor(i / 2) * 0.14, 3.1);
  // finished charcoal: a heap and sacks
  b.cone(0.8, 0.65, coal, 3.4, 0, -0.7, 7);
  for (const [x, y, z, ry] of [[3.7, 0, 0.1, 0.3], [3.2, 0, 0.0, -0.2], [3.45, 0.55, 0.05, 0.1]] as const) b.box(0.55, 0.55, 0.4, m.hay, x, y, z, ry);
  b.box(0.3, 0.3, 0.3, coal, 3.0, 0, -0.35, 0.4);
  // wheelbarrow
  b.box(0.9, 0.3, 0.55, m.wood, -2.0, 0.35, 3.3); b.box(0.5, 0.2, 0.4, coal, -2.0, 0.65, 3.3);
  b.cyl(0.28, 0.28, 0.08, m.darkwood, -2.55, 0.0, 3.3, 10).rotation.z = Math.PI / 2;
  for (const dz of [-0.2, 0.2]) { b.box(0.08, 0.35, 0.08, m.darkwood, -1.5, 0, 3.3 + dz); b.box(1.2, 0.07, 0.07, m.darkwood, -2.3, 0.3, 3.3 + dz); }
  // axe in a stump
  b.cyl(0.38, 0.45, 0.5, m.log, 1.5, 0, 3.4, 9);
  const haft = b.box(0.07, 0.8, 0.07, m.darkwood, 1.5, 0.45, 3.4); haft.rotation.z = 0.35;
  b.box(0.3, 0.22, 0.05, m.iron, 1.22, 1.0, 3.4);
  // wattle windbreak
  for (let i = 0; i < 5; i++) {
    const z = -1.1 + i * 0.38;
    b.box(0.08, 1.0, 0.08, m.darkwood, -3.5, 0, z);
    for (let k = 0; k < 4; k++) b.box(0.07, 0.1, 0.46, k % 2 ? m.hay : m.wood, -3.5 + (k + i) % 2 * 0.09, 0.15 + k * 0.22, z + 0.19);
  }
  // a covered store for charcoal
  if (t >= 2) {
    for (const [x, z] of [[-1.0, 2.5], [0.6, 2.5], [-1.0, 3.6], [0.6, 3.6]]) b.box(0.15, 1.5, 0.15, m.darkwood, x, 0, z);
    b.gable(1.6, 1.1, 0.6, m.tile, -0.2, 1.5, 3.05, 0.3);
    for (const [x, y, z] of [[-0.6, 0, 3.0], [0.0, 0, 3.1], [-0.3, 0.55, 3.05]] as const) b.box(0.55, 0.55, 0.4, coal, x, y, z, x);
  }
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


/** A fire station: a brick engine house with a big red door, a hose tower and a water cart standing out front. */
const firestation: Model = b => {
  const t = b.t, m = M(), red = new THREE.MeshStandardMaterial({ color: 0xa8362a, roughness: 0.8 });
  b.box(4.2, 2.2, 3.0, t >= 1 ? m.stone : m.plaster, 0, 0, 0); b.gable(4.2, 3.0, 1.2 + t * 0.2, t >= 1 ? m.slate : m.tile, 0, 2.2, 0, 0.35);
  b.box(2.0, 1.7, 0.12, red, -0.5, 0, 1.52); b.box(0.12, 1.7, 0.14, m.darkwood, -0.5, 0, 1.55);
  b.box(1.1, 3.6, 1.1, m.stone, 1.7, 0, -0.9); b.pyramid(1.4, 1.4, 0.9, m.slate, 1.7, 3.6, -0.9);
  b.cyl(0.55, 0.55, 0.7, m.wood, -1.4, 0.55, 2.4, 10).rotation.z = Math.PI / 2; b.box(1.4, 0.15, 0.7, m.darkwood, -1.4, 0.35, 2.4);
  for (const dz of [-0.3, 0.3]) b.cyl(0.3, 0.3, 0.1, m.darkwood, -1.4, 0.3, 2.4 + dz * 1.2, 10).rotation.x = Math.PI / 2;
};

const well: Model = b => {
  const t = b.t, m = M();
  b.cyl(1.0, 1.1, 0.9, t >= 2 ? m.stone : m.stone, 0, 0, 0, 14); b.cyl(0.8, 0.8, 0.05, m.glass, 0, 0.8, 0, 14);
  b.box(0.18, 2.4, 0.18, m.darkwood, -1, 0, 0); b.box(0.18, 2.4, 0.18, m.darkwood, 1, 0, 0);
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
/** The wall round the town hall of the lower tiers, with an opening at the front (+z): a ring of sharpened stakes leaning outwards, tied with a rail (the first tier), planks (the second) and, at the
 *  top of the three, a low dressed-stone wall with iron-tipped railings. `r` is its radius; the stakes lean out by `lean` and their tips are sharpened. */
function hallWall(b: B, t: number, r: number) {
  const m = M(), gap = 2.3 / r, lean = 0.2, n = Math.round([30, 36, 40][t]), h = [2.2, 2.5, 1.1][t];
  const stake = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.07; if (Math.abs(((a + Math.PI * 2) % (Math.PI * 2)) - Math.PI / 2) < gap) continue;
    const c = Math.cos(a), s = Math.sin(a), tall = h * (0.9 + 0.2 * ((i * 7) % 5) / 4);
    if (t === 2) {   // the stone wall: a short piece of wall between every two railings, turned to follow the ring
      const w = (Math.PI * 2 * r) / n + 0.05;
      b.box(w, h, 0.55, m.stone, c * r, 0, s * r, -a + Math.PI / 2); b.box(w * 0.98, 0.2, 0.75, m.darkstone, c * r, h, s * r, -a + Math.PI / 2);
      if (i % 2 === 0) { b.box(0.14, 0.9, 0.14, m.iron, c * r, h + 0.2, s * r); b.cone(0.13, 0.3, m.iron, c * r, h + 1.1, s * r, 4); }
      continue;
    }
    const post = b.cyl(0.17, 0.22, tall, m.log, 0, 0, 0, 7), tip = b.cone(0.17, 0.55, m.log, 0, 0, 0, 7);
    stake.set(s, 0, -c);   // (the axis that tips the post towards the outside)
    for (const [o, y] of [[post, tall / 2], [tip, tall + 0.275]] as const) { o.quaternion.setFromAxisAngle(stake, lean); o.position.set(c * (r + Math.sin(lean) * y), Math.cos(lean) * y, s * (r + Math.sin(lean) * y)); }
  }
  if (t < 2) {   // a rail tying the stakes together, in straight pieces between them, and a taller post either side of the opening
    const rail = (a0: number, a1: number, y: number) => { const x0 = Math.cos(a0) * r, z0 = Math.sin(a0) * r, x1 = Math.cos(a1) * r, z1 = Math.sin(a1) * r; b.box(Math.hypot(x1 - x0, z1 - z0), 0.1, 0.12, m.darkwood, (x0 + x1) / 2, y, (z0 + z1) / 2, -Math.atan2(z1 - z0, x1 - x0)); };
    for (let k = 0; k < 28; k++) { const a0 = gap + Math.PI / 2 + (k / 28) * (Math.PI * 2 - 2 * gap), a1 = gap + Math.PI / 2 + ((k + 1) / 28) * (Math.PI * 2 - 2 * gap); rail(a0, a1, 0.9); if (t === 1) rail(a0, a1, 1.7); }
  }
  for (const sx of [-1, 1]) { const a = Math.PI / 2 + sx * (gap + 0.04); b.cyl(0.22, 0.26, [2.9, 3.2, 2.0][t], m.darkwood, Math.cos(a) * r, 0, Math.sin(a) * r, 8); b.sphere(0.2, m.iron, Math.cos(a) * r, [2.9, 3.2, 2.0][t] + 0.15, Math.sin(a) * r); }
}

const townhall: Model = b => {
  const t = b.t, m = M();
  if (t === 0) {
    b.box(9, 3, 5.4, m.wood, 0, 0, 0); b.gable(9, 5.4, 3.2, m.thatch, 0, 3, 0, 0.8);
    b.box(1.4, 2.2, 0.15, m.door, 0, 0, 2.75); for (const x of [-3, -1.5, 1.5, 3]) b.window(x, 1.8, 2.75);
    b.smoke.push(new THREE.Vector3(2.5, 6.2, -0.5)); b.smoke.push(new THREE.Vector3(-2.5, 6.2, -0.5));
    hallWall(b, 0, 7.0);
    for (const x of [-5.3, 5.3]) b.cyl(0.7, 0.8, 0.9, m.hay, x * 0.85, 0, -3.8, 10);
    b.flag(-2.8, 6.05, 0, 3.3, 2.3);
  } else if (t === 1) {
    b.box(9.4, 3.6, 5.6, m.timber, 0, 0, 0); b.box(9.5, 0.25, 5.7, m.darkwood, 0, 3.4, 0); b.joists(9.4, 3.2, 2.95, 9, 1); b.joists(9.4, 3.2, 2.95, 9, -1); b.gable(9.4, 5.6, 3.1, m.tile, 0, 3.6, 0, 0.7);
    b.box(4, 3.1, 4.6, m.timber, 3.8, 0, 4.4); b.gable(4.6, 4, 2.4, m.tile, 3.8, 3.1, 4.4, 0.5);
    b.box(1.4, 2.3, 0.15, m.door, 0, 0, 2.85); for (const x of [-3.2, -1.6, 1.6]) { b.window(x, 2.0, 2.88); b.shutters(x, 2.0, 2.9, m.shutterBlue, 0, 0.5); }
    b.cyl(1.3, 1.4, 5.8, m.stone, -4.2, 0, 2.8, 14); b.cone(1.7, 2.7, m.slate, -4.2, 5.8, 2.8, 14);
    b.chimney(2.4, 5.6, -1.2, 1.6); b.flag(-4.2, 8.5, 2.8, 2.8, 2.3);
    hallWall(b, 1, 9.2);
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
    b.flag(0, 17.9, -0.3, 3, 2.5);
    b.flag(-5.2, 5.6, 1.0, 2.4); b.flag(5.2, 5.6, 1.0, 2.4);
    hallWall(b, 2, 11.2);
  } else {
    // The Castle: a vast concentric fortress with a palace inside, in the manner of Harlech (curtain wall, drum towers, gatehouse, great hall, bakehouse, stables, wells and gardens
    // in the wards) and Blenheim (a palace of a great hall between two wings, corner pavilions, courts). Outer curtain 44 x 38 with sixteen towers; a barbican and a bridge in front (+z);
    // the outer ward holds stables, smithy, stalls, gardens and a training yard; an inner screen wall with its own gate opens on the palace court; the palace stands across the back
    // with a donjon rising behind its hall; the chapel, kitchens and granary stand in the side wards. Its footprint (30) is the largest of any building (see `footprint` in the core).
    const X = 22, Z = 19, wh = 6.2, Y = 0.2, black = new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: 1 });
    const lawn = new THREE.MeshStandardMaterial({ color: 0x6f8a45, roughness: 1 }), gravel = new THREE.MeshStandardMaterial({ color: 0xb9ab8a, roughness: 1 });
    const hedge = new THREE.MeshStandardMaterial({ color: 0x2f5a2f, roughness: 0.95 }), leaf = new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 1 });
    const bloom = [0xe04a5a, 0xf2c14e, 0xf0f0f0, 0xd070d0], sack = new THREE.MeshStandardMaterial({ color: 0xcdb98a, roughness: 1 });
    const awn = [new THREE.MeshStandardMaterial({ color: 0xb03a2e, roughness: 1 }), new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 1 })];
    const merlons = (x0: number, z0: number, x1: number, z1: number, y: number, step = 2.2) => { const n = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / step)); for (let i = 0; i < n; i++) { const f = (i + 0.5) / n; b.box(0.7, 0.8, 0.7, m.stone, x0 + (x1 - x0) * f, y, z0 + (z1 - z0) * f); } };
    // the doors of the two gates: two leaves hinged at the sides of the passage, standing open (swung in against the walls) and shutting while a battle is on (see `Effects.update`)
    const leaves = (hinge: number, z: number, h: number, th: number, mat: THREE.Material, bars: number[] = []) => {
      for (const s of [-1, 1]) {
        const leaf = new THREE.Group(); leaf.position.set(s * hinge, 0, z); leaf.userData.gate = true; leaf.userData.open = -s * Math.PI / 2; leaf.rotation.y = leaf.userData.open;
        const w = hinge, plank = new THREE.Mesh(new THREE.BoxGeometry(w, h, th), mat); plank.position.set(-s * w / 2, h / 2, 0); plank.castShadow = plank.receiveShadow = true; leaf.add(plank);
        for (const x of bars) if (Math.sign(x) === s || (x === 0 && s > 0)) { const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, h, 0.2), m.iron); bar.position.set(x - s * hinge, h / 2, 0.2); bar.castShadow = true; leaf.add(bar); }
        b.g.add(leaf); b.deck.push(leaf);
      }
    };
    const slit = (x: number, y: number, z: number, ry = 0) => { b.box(0.16, 0.9, 0.12, black, x, y, z, ry); };
    const round = (x: number, z: number, r: number, h: number, roof: number, flag = true) => {   // a drum tower: machicolated top, slate cone, arrow slits on the faces
      b.cyl(r, r + 0.2, h, m.stone, x, -0.2, z, 18); b.cyl(r + 0.3, r + 0.3, 0.55, m.darkstone, x, h - 0.6, z, 18); b.cone(r + 0.4, roof, m.slate, x, h - 0.05, z, 18);
      for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.4; slit(x + Math.cos(a) * (r + 0.02), h * 0.55, z + Math.sin(a) * (r + 0.02), -a + Math.PI / 2); }
      if (flag) b.flag(x, h + roof - 0.1, z, 2.2, 1.3);
    };
    // the ground: a stone plinth under the whole fortress, the lawn of the wards and a gravel way from the gate to the palace
    b.box(2 * X + 4, 3, 2 * Z + 4, m.darkstone, 0, -3, 0);
    b.box(2 * X + 4, 0.2, 2 * Z + 4, m.stone, 0, 0, 0);   // (as wide as the plinth: its top would otherwise lie in the ground beside the slab and flicker)
    b.box(2 * X - 1, 0.04, 2 * Z - 1, lawn, 0, Y, 0);
    b.box(4.4, 0.06, Z + 5.4 - 2.4, gravel, 0, Y, (Z + 5.4 + 2.4) / 2); b.box(2 * X - 3, 0.06, 2.4, gravel, 0, Y, 6.3);
    // ---- the outer curtain wall, with sixteen towers
    b.box(2 * X, wh, 1.4, m.stone, 0, 0, -Z); merlons(-X, -Z - 0.3, X, -Z - 0.3, wh, 2.2);
    for (const sx of [-1, 1]) {
      b.box(1.4, wh, 2 * Z, m.stone, sx * X, 0, 0); merlons(sx * (X + 0.3), -Z, sx * (X + 0.3), Z, wh, 2.2);
      const fw = X - 3.6; b.box(fw, wh, 1.4, m.stone, sx * (3.6 + fw / 2), 0, Z); merlons(sx * 3.6, Z + 0.3, sx * X, Z + 0.3, wh, 2.2);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) round(sx * X, sz * Z, 3.1, wh + 6.2, 4.4);                      // four great corner towers
    for (const sx of [-1, 1]) { for (const z of [-9.5, 0, 9.5]) round(sx * X, z, 1.9, wh + 3.0, 2.8, false); round(sx * 11, -Z, 1.9, wh + 3.0, 2.8, false); round(sx * 12, Z, 1.9, wh + 3.0, 2.8, false); }
    // the gatehouse: two big towers, a dark passage under a heavy lintel, a portcullis
    for (const sx of [-1, 1]) round(sx * 3.7, Z + 0.4, 2.1, wh + 4.6, 3.4);
    b.box(5.4, 2.6, 2.6, m.darkstone, 0, wh - 1.6, Z + 0.2); merlons(-2.6, Z + 1.4, 2.6, Z + 1.4, wh + 1.0, 1.8);
    b.box(3.2, 4.0, 0.3, black, 0, 0, Z + 1.55); for (const x of [-1.2, -0.4, 0.4, 1.2]) b.box(0.12, 4.0, 0.2, m.iron, x, 0, Z + 1.7);
    // ---- the barbican: two walls run out from the gate to an outer arch, and a plank bridge crosses the ditch in front
    for (const sx of [-1, 1]) { b.box(1.0, wh - 1.0, 5.2, m.stone, sx * 2.7, 0, Z + 3.0); merlons(sx * 2.7, Z + 0.6, sx * 2.7, Z + 5.4, wh - 1.0, 1.9); round(sx * 2.7, Z + 5.4, 1.2, wh + 1.0, 1.8, false); }
    b.box(5.4, 1.5, 1.0, m.darkstone, 0, wh - 2.0, Z + 5.4); leaves(1.6, Z + 5.1, 3.8, 0.3, m.door, [-1.2, 0, 1.2]);
    b.box(3.4, 0.25, 3.4, m.darkwood, 0, 0, Z + 7.3); for (const sx of [-1, 1]) b.box(0.16, 1.0, 3.4, m.darkwood, sx * 1.6, 0, Z + 7.3);
    // ---- the inner screen wall and its gate, between the outer ward and the palace court
    const iz = 2.6;
    b.box(30, 4.4, 1.0, m.stone, 0, 0, iz); merlons(-15, iz, 15, iz, 4.4, 2.0);
    for (const sx of [-1, 1]) { round(sx * 2.4, iz + 0.4, 1.3, 7.2, 2.6); round(sx * 15, iz, 1.7, 7.6, 3.0); }
    b.box(3.0, 2.8, 1.6, m.darkstone, 0, 3.6, iz); b.box(2.2, 3.0, 0.3, black, 0, 0, iz + 0.6); leaves(1.05, iz + 0.62, 2.8, 0.18, m.door);
    // ---- the palace: great hall pavilion between two wings, a back range, corner pavilions and a donjon behind
    b.box(28, 7, 6, m.stone, 0, 0, -14.2); b.gable(28, 6, 2.6, m.slate, 0, 7, -14.2, 0.5);
    for (const sx of [-1, 1]) { b.box(4.2, 5.6, 12.7, m.stone, sx * 11.9, 0, -4.85); b.gableZ(12.7, 4.2, 2.0, m.slate, sx * 11.9, 5.6, -4.85, 0.45); }
    b.box(10, 8.5, 3.6, m.stoneMat, 0, 0, -9.0); b.gableZ(3.6, 10, 3.0, m.slate, 0, 8.5, -9.0, 0.5);
    for (const x of [-3.6, -1.2, 1.2, 3.6]) { b.window(x, 3.4, -7.14, 0, 0.8, 2.6); b.window(x, 6.9, -7.14, 0, 0.6, 1.2); }
    b.box(3.4, 0.5, 1.8, m.stoneMat, 0, 0, -6.4); b.box(2.6, 0.4, 1.4, m.stoneMat, 0, 0.5, -6.3); b.box(1.5, 2.4, 0.12, m.door, 0, 0.9, -7.2);
    for (const x of [-1.8, 1.8]) b.box(0.4, 4.2, 0.4, m.stoneMat, x, 0, -6.2);
    b.box(4.4, 0.4, 2.0, m.stoneMat, 0, 4.2, -6.3); b.box(4.4, 0.7, 0.1, m.iron, 0, 4.6, -5.35);
    for (const sx of [-1, 1]) for (const z of [-9.5, -6.5, -3.5, -0.5]) for (const y of [1.6, 3.8]) b.window(sx * 9.76, y, z, -sx * Math.PI / 2, 0.55, 1.0);
    for (const x of [-12, -8, 8, 12]) { b.window(x, 2.2, -11.14, 0, 0.55, 1.3); b.window(x, 5.2, -11.14, 0, 0.5, 1.0); }
    // corner pavilions topped with cupolas (Blenheim's four towers)
    for (const sx of [-1, 1]) {
      b.box(5.2, 11.5, 5.2, m.stoneMat, sx * 14.9, 0, -14.2); b.box(5.8, 0.5, 5.8, m.darkstone, sx * 14.9, 11.5, -14.2); b.cyl(1.1, 1.3, 1.8, m.stone, sx * 14.9, 12.0, -14.2, 10); b.cone(1.5, 2.4, m.slate, sx * 14.9, 13.8, -14.2, 10); b.sphere(0.3, m.gold, sx * 14.9, 16.4, -14.2); b.flag(sx * 14.9, 16.6, -14.2, 2.4, 1.3);
      for (const y of [3.0, 6.0, 9.0]) b.window(sx * 14.9, y, -11.54, 0, 0.6, 1.2);
    }
    // the donjon: a tall square tower rising out of the back range, with corner turrets and a spire
    const dz = -14.2;
    b.box(7.2, 15.5, 7.0, m.stone, 0, 0, dz); b.box(8.0, 0.6, 7.8, m.darkstone, 0, 15.0, dz);
    merlons(-3.8, dz - 3.8, 3.8, dz - 3.8, 15.6, 1.8); merlons(-3.8, dz + 3.8, 3.8, dz + 3.8, 15.6, 1.8); merlons(-3.8, dz - 3.8, -3.8, dz + 3.8, 15.6, 1.8); merlons(3.8, dz - 3.8, 3.8, dz + 3.8, 15.6, 1.8);
    for (const [x, z] of [[-3.6, dz - 3.6], [3.6, dz - 3.6], [3.6, dz + 3.6], [-3.6, dz + 3.6]]) { b.cyl(1.0, 1.1, 3.6, m.stone, x, 15.2, z, 10); b.cone(1.3, 2.6, m.slate, x, 18.8, z, 10); }
    for (const y of [10, 12.6]) for (const x of [-1.6, 1.6]) b.window(x, y, dz + 3.56, 0, 0.5, 1.2);
    b.cyl(2.2, 2.3, 1.2, m.darkstone, 0, 15.2, dz, 14); b.cone(2.4, 5.6, m.slate, 0, 16.4, dz, 14); b.sphere(0.4, m.gold, 0, 22.2, dz); b.flag(0, 22.5, dz, 3.4, 2.5);
    // ---- the palace court: lawns, hedged flower beds, gravel paths and a fountain
    b.box(19, 0.05, 8.4, lawn, 0, Y, -2.3); b.box(2.4, 0.07, 8.4, gravel, 0, Y, -2.3); b.box(19, 0.07, 2.0, gravel, 0, Y, -2.3);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const cx = sx * 5.2, cz = -2.3 + sz * 3.0;
      for (const [w, d, x, z] of [[4.2, 0.4, 0, -1.2], [4.2, 0.4, 0, 1.2], [0.4, 2.0, -2.1, 0], [0.4, 2.0, 2.1, 0]] as const) b.box(w, 0.5, d, hedge, cx + x, Y, cz + z);
      for (let k = 0; k < 4; k++) b.sphere(0.2, new THREE.MeshStandardMaterial({ color: bloom[(k + (sx > 0 ? 1 : 0) + (sz > 0 ? 2 : 0)) % 4], roughness: 0.8 }), cx - 1.0 + (k % 2) * 2.0, Y + 0.3, cz - 0.4 + Math.floor(k / 2) * 0.8);
    }
    b.cyl(1.5, 1.6, 0.5, m.stone, 0, Y, -2.3, 16); b.cyl(1.2, 1.2, 0.2, m.glass, 0, Y + 0.45, -2.3, 16); b.cyl(0.22, 0.3, 1.5, m.stoneMat, 0, Y, -2.3, 8); b.sphere(0.3, m.stoneMat, 0, Y + 1.6, -2.3);
    // ---- the west ward: a chapel with its bell tower, and the granary
    b.box(4.4, 4.6, 9.0, m.stone, -18, 0, -11.5); b.gableZ(9.0, 4.4, 2.4, m.slate, -18, 4.6, -11.5, 0.3);
    for (const z of [-14.5, -11.5, -8.5]) for (const sx of [-1, 1]) b.box(0.1, 2.0, 0.6, m.stained, -18 + sx * 2.22, 1.4, z);
    b.box(2.6, 9.0, 2.6, m.stone, -18, 0, -5.4); b.box(2.9, 0.4, 2.9, m.darkstone, -18, 7.4, -5.4); b.pyramid(3.0, 3.0, 3.4, m.slate, -18, 9.0, -5.4); b.box(0.12, 1.0, 0.12, m.gold, -18, 12.3, -5.4); b.box(0.5, 0.1, 0.1, m.gold, -18, 12.8, -5.4);
    for (const y of [5.0, 7.0]) b.box(0.9, 1.1, 0.14, m.iron, -18, y, -4.05); b.box(1.2, 2.2, 0.12, m.door, -18, 0, -4.05);
    b.box(5.0, 3.2, 5.0, m.wood, -18, 0, -0.4); b.gable(5.0, 5.0, 1.8, m.thatch, -18, 3.2, -0.4, 0.4); b.box(1.2, 1.9, 0.1, m.door, -18, 0, 2.15);
    for (let k = 0; k < 5; k++) b.box(0.6, 0.45, 0.5, sack, -19.8 + k * 0.7, Y, 3.0);
    // ---- the east ward: the great kitchen, the pantry and the bakehouse with its oven
    b.box(5.0, 3.8, 6.4, m.plaster, 18, 0, -12.6); b.gableZ(6.4, 5.0, 2.0, m.tile, 18, 3.8, -12.6, 0.35); b.chimney(16.5, 3.8, -14.0, 2.4); b.chimney(19.5, 3.8, -11.0, 2.4); b.box(1.1, 2.0, 0.1, m.door, 18, 0, -9.35);
    b.box(5.0, 3.0, 4.2, m.timber, 18, 0, -5.4); b.gableZ(4.2, 5.0, 1.6, m.tile, 18, 3.0, -5.4, 0.35); b.box(1.0, 1.9, 0.1, m.door, 18, 0, -3.25);
    b.box(4.6, 2.8, 3.2, m.stone, 18, 0, -0.2); b.gableZ(3.2, 4.6, 1.5, m.tile, 18, 2.8, -0.2, 0.3); b.cyl(1.0, 1.2, 2.0, m.brick, 20.6, 0, -0.2, 10); b.cone(1.1, 0.9, m.brick, 20.6, 2.0, -0.2, 10); b.chimney(16.6, 2.8, 0.6, 1.8); b.box(0.9, 1.8, 0.1, m.door, 18, 0, 1.45);
    // ---- the outer ward, west: the stables with their paddock, the herb and vegetable garden, a haystack and an orchard
    b.box(9.5, 3.0, 4.2, m.wood, -14, 0, 7.6); b.gable(9.5, 4.2, 1.8, m.thatch, -14, 3.0, 7.6, 0.4);
    for (let k = 0; k < 4; k++) b.box(1.1, 1.9, 0.1, m.door, -17.4 + k * 2.3, 0, 9.74);
    for (let k = 0; k < 7; k++) b.box(0.12, 1.1, 0.12, m.darkwood, -17.8 + k * 1.2, Y, 12.4); b.box(7.2, 0.1, 0.1, m.darkwood, -14.2, 0.7, 12.4); b.box(7.2, 0.1, 0.1, m.darkwood, -14.2, 0.35, 12.4);
    b.cone(1.1, 1.5, m.hay, -20, Y, 5.4, 8); b.cone(0.9, 1.2, m.hay, -19.4, Y, 12.0, 8);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) b.box(3.0, 0.3, 1.1, m.field, -9 - c * 3.6, Y, 13.8 + r * 1.5);
    for (const [x, z] of [[-19.4, 16.4], [-16.4, 16.8], [-8.0, 17.4]]) { b.cyl(0.2, 0.28, 1.8, m.darkwood, x, Y, z, 6); b.sphere(1.2, leaf, x, Y + 2.5, z); }
    // ---- the outer ward, east: the smithy, a training yard and the well
    b.box(5.4, 3.2, 4.2, m.timber, 15, 0, 7.6); b.gable(5.4, 4.2, 1.7, m.tile, 15, 3.2, 7.6, 0.35); b.chimney(16.8, 4.0, 7.0, 2.0); b.box(1.1, 1.9, 0.1, m.door, 15, 0, 9.74); b.box(0.9, 0.5, 0.9, m.glow, 17.8, Y, 8.0);
    for (const x of [12.6, 14.4]) { b.cyl(0.04, 0.04, 1.6, m.darkwood, x, Y, 15.2, 6); b.cyl(0.3, 0.32, 0.7, m.hay, x, 0.95, 15.2, 8); b.sphere(0.22, m.hay, x, 1.8, 15.2); }
    for (let k = 0; k < 3; k++) { b.box(1.0, 1.0, 0.5, m.hay, 16 + k * 1.6, Y, 17.2); b.box(0.9, 0.9, 0.12, m.gold, 16 + k * 1.6, 0.4, 16.9); }
    b.cyl(0.9, 1.0, 1.0, m.stone, 9.0, Y, 11.0, 12); b.box(0.12, 1.7, 0.12, m.darkwood, 8.2, 0.9, 11.0); b.box(0.12, 1.7, 0.12, m.darkwood, 9.8, 0.9, 11.0); b.box(2.0, 0.12, 1.2, m.darkwood, 9.0, 2.5, 11.0); b.gable(2.0, 1.4, 0.5, m.tile, 9.0, 2.6, 11.0, 0.15);
    for (const x of [-7, 7]) { b.box(2.4, 0.9, 1.2, m.darkwood, x, Y, 15.2); for (const sx of [-1, 1]) b.box(0.1, 2.2, 0.1, m.darkwood, x + sx * 1.1, Y, 15.8); b.box(2.6, 0.12, 1.8, awn[x > 0 ? 0 : 1], x, 2.4, 15.3); b.box(0.5, 0.3, 0.4, sack, x - 0.5, 1.1, 15.2); }
    // a few barrels and a crate by the gate
    for (const x of [-5.6, -4.8]) b.cyl(0.35, 0.35, 0.8, m.darkwood, x, Y, Z - 2.2, 8);
    b.box(0.8, 0.7, 0.8, m.darkwood, 5.2, Y, Z - 2.0);
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
  const deck = new THREE.Group(); deck.position.set(0, -0.1, -6.4); deck.userData.deck = true;   // (its top lies flush with the levelled ground at both ends)
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
  // the stone footing only covers the land side: from behind the house to the bank (FOOT, as the core's WHEEL_FOOT); the wheel hangs beyond it over the water
  const FOOT = 3.2, back = -(W / 2 + 0.2), footing = b.box(FOOT - back, 0.4, D + 0.4, m.stone, (FOOT + back) / 2, -0.1, 0); footing.name = 'footing'; b.box(W, h, D, wm, 0, 0.3, 0); b.gable(W, D, 1.6 + t * 0.3, t >= 1 ? m.tile : m.thatch, 0, h + 0.3, 0, 0.5);
  b.box(0.9, 1.6, 0.14, m.door, 0, 0.3, D / 2 + 0.03); b.window(W * 0.28, 1.6, D / 2 + 0.02); b.chimney(-W * 0.3, h + 1.2, -0.4, 1.2);
  // the wheel hangs out over the water on a long axle (the core snaps the house to the bank so the point WHEEL_REACH out from its middle is over the water) and dips below the pad
  const R = 1.7 + t * 0.15, AX = 5.2, DIP = 0.9;
  b.slot('millrace', {}, () => {
    const pivot = new THREE.Group(); pivot.position.set(AX, R - DIP, 0); pivot.rotation.y = Math.PI / 2; pivot.name = 'wheel'; b.g.add(pivot);
    const wheel = new THREE.Group(); pivot.add(wheel);
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material) => { const q = new THREE.Mesh(geo, mat); q.castShadow = true; return q; };
    for (const s of [-0.5, 0.5]) { const rim = part(new THREE.TorusGeometry(R, 0.1, 6, 20), m.darkwood); rim.position.z = s; wheel.add(rim); }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, arm = part(new THREE.BoxGeometry(0.12, R * 2, 0.12), m.darkwood); arm.rotation.z = a; wheel.add(arm);
      const pad = part(new THREE.BoxGeometry(0.2, 0.5, 1.1), m.wood); pad.position.set(Math.cos(a) * R, Math.sin(a) * R, 0); pad.rotation.z = a; wheel.add(pad);
    }
    wheel.add(part(new THREE.CylinderGeometry(0.22, 0.22, 1.3, 8).rotateX(Math.PI / 2), m.iron));
    b.spin.push(wheel);
    b.box(AX - W / 2 + 0.2, 0.22, 0.22, m.iron, (AX + W / 2) / 2 - 0.1, R - DIP - 0.11, 0);   // the axle running back into the mill house
    b.box(0.8, 0.5, 2.6, new THREE.MeshStandardMaterial({ color: 0x4a7fa0, roughness: 0.2 }), AX - 0.3, R * 2 - DIP + 0.4, 0);   // the flume that feeds the wheel
    for (const z of [-1.4, 1.4]) { b.box(0.14, R * 2 + 0.6, 0.14, m.darkwood, AX, -DIP, z); b.box(0.14, R * 2 + 0.6, 0.14, m.darkwood, W / 2 + 0.3, -DIP, z); b.box(AX - W / 2 - 0.1, 0.12, 0.14, m.darkwood, (AX + W / 2) / 2 + 0.1, R * 2 - DIP + 0.1, z); }
  });
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

const portWarehouse = (tier: number) => ({ width: 5.6 + tier * 0.6, depth: 3.8, x: -1.5, z: -1.0 });
function portFooting(b: B, mat: THREE.Material, height = 0.45) {
  const { width, depth, x, z } = portWarehouse(b.t);
  b.box(width + 0.6, height, depth + 0.6, mat, x, 0.35 - height, z);
}
// The port snaps onto a shore with its pier extending along local +Z.
const port: Model = b => {
  const t = b.t, m = M(), { width: W, depth: D, x, z } = portWarehouse(t);
  const h = 2.6 + t * 0.4, wm = t >= 2 ? m.stone : t >= 1 ? m.timber : m.wood;
  b.slot('warehouseFooting', {}, () => portFooting(b, t >= 1 ? m.stone : m.earth));
  b.box(W, h, D, wm, x, 0.35, z); b.gable(W, D, 1.6 + t * 0.3, t >= 1 ? m.tile : m.thatch, x, h + 0.35, z, 0.5);
  b.box(1.8, h - 0.4, 0.14, m.door, -1.5, 0.35, D / 2 - 0.9); b.box(2.2, 0.2, 0.3, m.darkwood, -1.5, h - 0.05, D / 2 - 0.85);
  for (const [x, z, s] of [[1.8, -2.4, 0.9], [2.8, -1.4, 0.7], [-5.2, 0.4, 0.8]] as const) b.box(s, s, s, m.wood, x, 0, z);
  b.cyl(0.45, 0.45, 0.9, m.wood, 2.4, 0, 0.6, 10);
  // the pier: planks on posts, running out over the water
  const L = 11;
  for (let i = 0; i < 22; i++) b.box(2.8, 0.2, 0.49, i % 4 === 0 ? m.log : m.wood, 2.2, 0.5, 2.25 + i * 0.5);
  for (let z = 2.5; z < L + 2; z += 2.2) for (const x of [0.9, 3.5]) {
    b.slot(`port-pile-${x}-${z}`, { x, z }, () => b.box(0.28, 2.6, 0.28, m.darkwood, x, -2.1, z));
  }
  for (const x of [0.98, 3.42]) b.cyl(0.14, 0.17, 0.57, m.darkwood, x, 0.7, 12.65, 8);
  // a crane at the quayside
  b.box(0.3, 4.0 + t * 0.6, 0.3, m.darkwood, 3.2, 0.5, 2.6); b.box(3.0, 0.25, 0.25, m.darkwood, 1.9, 4.2 + t * 0.6, 2.6); b.box(0.05, 1.6, 0.05, m.iron, 0.6, 2.7 + t * 0.6, 2.6);
  if (t >= 2) { b.cyl(1.0, 1.2, 5.5, m.stone, -4.8, -0.2, 1.4, 12); b.cone(1.3, 1.8, m.slate, -4.8, 5.3, 1.4, 12); b.flag(-4.8, 7.0, 1.4, 2.2); }
};

/** A toll post: a keeper's hut beside the road and a striped barrier pole across it; better tiers add a stone gatehouse and a flag. */
// Toll post: the road runs through it. Two posts stand either side of the road (along the model's z axis; the core snaps the building onto a road so that this axis lies along it, see toll_snap),
// a striped barrier arm is swung up over the road, and the toll keeper's hut stands beside it. The ground between the posts is left bare: the road is drawn through (crates/game-core/src/lib.rs).
const toll: Model = b => {
  const t = b.t, m = M();
  b.box(1.8, 1.9, 1.6, t >= 2 ? m.stone : m.wood, 2.4, 0.1, -0.2); b.gable(2.0, 1.8, 0.9, t >= 1 ? m.tile : m.thatch, 2.4, 2.0, -0.2, 0.25);
  b.box(0.1, 1.4, 0.5, m.door, 1.5, 0.1, -0.2);   // the keeper's door looks onto the road
  for (const x of [-1.3, 1.3]) b.box(0.32, 1.7, 0.32, m.darkwood, x, 0, 0);
  b.box(0.1, 0.5, 0.5, m.plaster, 1.3, 1.0, 0.2);   // the board with the tariff
  // the barrier arm, swung up from the left post: striped red and white, with a counterweight behind the post
  const ang = 0.7;
  for (let i = 0; i < 6; i++) { const seg = b.box(0.5, 0.16, 0.16, i % 2 ? m.shutterRed : m.plaster, -1.3 + Math.cos(ang) * (0.3 + 0.5 * i), 1.45 + Math.sin(ang) * (0.3 + 0.5 * i), 0); seg.rotation.z = ang; }
  b.box(0.35, 0.35, 0.35, m.stone, -1.3 - 0.35, 1.3, 0);
  b.cyl(0.07, 0.07, 1.8, m.darkwood, 3.4, 0, 0.9, 6);
  if (t >= 2) b.flag(3.4, 2.0, 0.9, 1.8);
};

/** The ghost shown while placing a bridge (the real bridge is drawn by spans.ts): ten units of deck with posts, stretched to the real length. */
/** The ghost of a road piece: a patch of beaten earth. */
/** A plaza: a paved square with a node on each of its four sides (a post on either hand of each) where roads join it, and a medallion in the middle. Its benches, trees, fountain and lanterns are options. */
const plaza: Model = b => {
  const m = M(), paving = new THREE.MeshStandardMaterial({ color: 0xb9b2a0, roughness: 1 }), slab = new THREE.MeshStandardMaterial({ color: 0xcfc8b4, roughness: 1 });
  b.box(10.2, 0.12, 10.2, m.stone, 0, 0, 0);                               // the kerb all round
  b.box(9.6, 0.16, 9.6, paving, 0, 0, 0);
  b.box(2.6, 0.2, 9.6, slab, 0, 0, 0); b.box(9.6, 0.2, 2.6, slab, 0, 0, 0);   // the cross of lighter slabs between the nodes
  b.cyl(1.2, 1.2, 0.24, m.stone, 0, 0, 0, 24); b.cyl(0.9, 0.9, 0.28, slab, 0, 0, 0, 24);   // the medallion
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {   // the node of this side: a low post on either hand, where the road comes in
    const px = x ? x * 5.3 : 0, pz = z ? z * 5.3 : 0, sx = x ? 0 : 1.5, sz = z ? 1.5 : 0;
    for (const s of [-1, 1]) { b.box(0.5, 0.7, 0.5, m.stone, px + sx * s, 0, pz + sz * s); b.box(0.62, 0.12, 0.62, m.darkstone, px + sx * s, 0.7, pz + sz * s); }
  }
};
const pastureGrass = new THREE.MeshStandardMaterial({ color: 0x788d4b, roughness: 1, vertexColors: true });
const livestockPen = (pigs: boolean): Model => b => {
  const m = M(), x = PEN_HALF_WIDTH, z = PEN_HALF_DEPTH;
  const post = b.t === 2 ? m.stone : m.darkwood;
  b.box(2 * x, 0.07, 2 * z, pigs ? m.trampled : pastureGrass, 0, 0.025, 0);
  if (pigs) {
    const mud = b.cyl(1.51, 1.74, 0.05, m.wallow, 1.65, 0.095, 0.9, 13);
    mud.scale.z = 0.72;
    b.box(0.86, 0.36, 1.7, m.darkwood, -3.45, 0, 1.8);
    b.box(0.68, 0.08, 1.53, m.hay, -3.45, 0.31, 1.8);
  }
  for (const side of [-1, 1]) {
    for (const dz of [-z, 0, z]) b.box(0.22, 1.18, 0.22, post, side * x, 0, dz);
    b.box(0.22, 1.28, 0.22, post, side * 0.9, 0, z);
    b.box(0.22, 1.18, 0.22, post, side * x / 2, 0, -z);
    for (const y of [0.35, 0.75]) {
      b.box(0.12, 0.14, 2 * z, m.wood, side * x, y, 0);
      b.box(x - 0.9, 0.14, 0.12, m.wood, side * (x + 0.9) / 2, y, z);
    }
  }
  for (const y of [0.35, 0.75]) b.box(2 * x, 0.14, 0.12, m.wood, 0, y, -z);
  const shed = b.t > 0 ? 3.4 : 2.5;
  b.box(shed, 1.55, 0.18, m.wood, -2.5, 0.07, -3.95);
  for (const dx of [-1, 1]) b.box(0.19, 1.68, 0.2, m.darkwood, -2.5 + dx * (shed / 2 - 0.18), 0, -2.3);
  b.gable(shed + 0.4, 2.03, 0.65, b.t === 2 ? m.tile : m.thatch, -2.5, 1.65, -3.1, 0.24);
  b.box(2.5, 0.44, 0.67, m.wood, 2.51, 0, -3.73);
  b.box(2.27, 0.08, 0.44, m.hay, 2.51, 0.38, -3.73);
};
const stable: Model = b => {
  const m = M(), width = 7.2, depth = 5.3, top = 2.75;
  b.box(width, 0.16, depth, m.stone, 0, 0, 0);
  b.box(width, top, 0.22, m.timber, 0, 0, -depth / 2);
  for (const x of [-3.5, 3.5]) b.box(0.22, top, depth, m.timber, x, 0, 0);
  for (const x of [-3.5, -1.25, 1.25, 3.5]) b.box(0.24, top, 0.24, m.darkwood, x, 0, depth / 2);
  b.box(width, 0.25, 0.26, m.darkwood, 0, top - 0.25, depth / 2);
  b.gable(width, depth, 1.8, m.tile, 0, top, 0, 0.48);
  for (const x of [-2.32, 2.32]) {
    b.box(1.94, 1.06, 0.15, m.wood, x, 0.16, depth / 2);
    b.box(1.55, 0.56, 0.63, m.darkwood, x, 0.16, -1.8);
    b.box(1.31, 0.1, 0.48, m.hay, x, 0.65, -1.8);
    b.box(0.96, 0.36, 1.35, m.hay, x, 0.15, -0.45);
  }
};
/** Where the little halls of the other cities stand inside the embassy's wall, from the front outwards (x, z): four down each side of the courtyard, their doors to the middle. */
export const EMBASSY_HALL_SLOTS: [number, number][] = [[-12, 2.2], [12, 2.2], [-12, 6.6], [12, 6.6], [-12, -2.2], [12, -2.2], [-12, -6.6], [12, -6.6]];
/** The embassy: a very large walled rectangle in the manner of a castle (32 x 36). Across the back stand the keep's buildings: a granary, a chapel, the great hall with its porch and door, an armoury
 *  and a blacksmith. The courtyard in front has a gravel way from the gate to the hall, a garden either side of it and a well to one side. Down each side stands a row of little halls, one for every
 *  other city with that city's own flag on its roof (up to eight). By the gate stand two guard houses, with the archery range on one side and the dungeon on the other. Every building has its own
 *  plot, so nothing overlaps. Upgrades raise the walls, make the roofs slate and gild the great hall's dome. */
const embassy: Model = b => {
  const m = M(), t = b.t, X = 16, ZB = -18, ZF = 18, wh = 1.7 + 0.3 * t, roof = t >= 2 ? m.slate : m.tile;
  const lawn = new THREE.MeshStandardMaterial({ color: 0x6f8a45, roughness: 1 }), hedge = new THREE.MeshStandardMaterial({ color: 0x2f5a2f, roughness: 0.95 });
  const bloom = [0xe04a5a, 0xf2c14e, 0xf0f0f0, 0xd070d0], sack = new THREE.MeshStandardMaterial({ color: 0xcdb98a, roughness: 1 });
  b.box(2 * X + 1.4, 0.2, ZF - ZB + 1.4, lawn, 0, 0, 0);   // the ground of the compound: its top is at 0.2, and everything flat on it starts there
  // the wall: a back and two sides, and a front with the gate between two towers
  b.box(2 * X, wh, 0.6, m.stone, 0, 0, ZB); for (const sx of [-1, 1]) b.box(0.6, wh, ZF - ZB, m.stone, sx * X, 0, 0);
  for (const sx of [-1, 1]) b.box(X - 2.9, wh, 0.6, m.stone, sx * (X + 2.9) / 2, 0, ZF);
  for (const sx of [-1, 1]) for (const z of [ZB, ZF]) { b.cyl(1.4, 1.55, wh + 2.4, m.stone, sx * X, 0, z, 14); b.cone(1.7, 1.8, m.slate, sx * X, wh + 2.4, z, 14); }
  for (const sx of [-1, 1]) { b.cyl(1.0, 1.15, wh + 2.0, m.stone, sx * 1.9, 0, ZF, 12); b.cone(1.3, 1.5, m.slate, sx * 1.9, wh + 2.0, ZF, 12); }
  b.box(2.8, 0.35, 0.6, m.darkwood, 0, wh + 1.2, ZF);
  // the keep, across the back (each building 4.6 wide, 5.5 deep, 0.6 apart)
  const hz = -13.2, D = 5.5, Y = 0.2;
  const block = (x: number, w: number, h: number, wall: THREE.Material, rf: THREE.Material, rise = 1.7) => { b.box(w, h, D, wall, x, Y, hz); b.gable(w, D, rise, rf, x, Y + h, hz, 0.35); };
  // granary: timber, thatched, with sacks stacked at its door
  block(-11.8, 4.6, 2.8, m.wood, m.thatch); b.box(1.2, 1.7, 0.1, m.door, -11.8, Y, hz + D / 2 + 0.03);
  for (let k = 0; k < 4; k++) b.box(0.6, 0.45, 0.5, sack, -12.8 + k * 0.7, Y, hz + D / 2 + 0.6);
  // chapel: a stone nave with a bell tower and a cross
  block(-6.6, 4.6, 3.0, m.stone, m.slate); b.box(0.9, 1.7, 0.1, m.door, -6.6, Y, hz + D / 2 + 0.03);
  b.box(1.3, 3.0, 1.3, m.stone, -8.0, Y, hz - 1.4); b.box(1.3, 1.3, 1.3, m.stone, -8.0, Y + 3.0, hz - 1.4);
  b.pyramid(1.7, 1.7, 1.5, m.slate, -8.0, Y + 4.3, hz - 1.4); b.box(0.1, 0.7, 0.1, m.gold, -8.0, Y + 5.8, hz - 1.4); b.box(0.45, 0.1, 0.1, m.gold, -8.0, Y + 6.3, hz - 1.4);
  // the great hall, with its porch and the door that the road from the door leaves by
  b.box(7.0, 4.0, D, m.plaster, 0, Y, hz); b.gable(7.0, D, 2.0, roof, 0, Y + 4.0, hz, 0.45);
  for (const x of [-3.5, 3.5]) { b.box(0.3, 4.0, 0.3, m.darkwood, x, Y, hz + D / 2); b.box(0.3, 4.0, 0.3, m.darkwood, x, Y, hz - D / 2); }
  b.box(2.6, 2.6, 1.5, m.plaster, 0, Y, hz + D / 2 + 0.6); b.gable(2.6, 1.5, 0.9, roof, 0, Y + 2.6, hz + D / 2 + 0.6, 0.3);
  b.box(1.1, 1.9, 0.12, m.door, 0, Y, hz + D / 2 + 1.38);
  for (const x of [-2.6, -1.6, 1.6, 2.6]) b.box(0.6, 0.9, 0.06, m.glass, x, Y + 1.8, hz + D / 2 + 0.04);
  if (t >= 3) { b.cyl(1.4, 1.5, 0.8, m.stone, 0, Y + 6.0, hz, 14); b.sphere(1.1, m.gold, 0, Y + 6.9, hz); }
  b.flag(0, t >= 3 ? Y + 7.95 : Y + 6.0, hz, 2.4, 1.4);   // (on the middle of the roof, on top of the orb from the top tier: it used to stand behind it)
  // armoury: stone, with racks of spears and shields at the door
  block(6.6, 4.6, 3.0, m.stone, m.slate); b.box(1.2, 1.7, 0.1, m.door, 6.6, Y, hz + D / 2 + 0.03);
  for (const dx of [-1.6, 1.6]) { for (const k of [-0.4, 0, 0.4]) b.cyl(0.03, 0.03, 1.8, m.iron, 6.6 + dx + k, Y, hz + D / 2 + 0.7, 5); b.box(1.0, 0.12, 0.12, m.darkwood, 6.6 + dx, Y + 1.1, hz + D / 2 + 0.7); }
  for (const dx of [-0.9, 0.9]) b.box(0.5, 0.6, 0.08, new THREE.MeshStandardMaterial({ color: 0x9b2c22, roughness: 0.8 }), 6.6 + dx, Y + 1.6, hz + D / 2 + 0.06);
  // blacksmith: timber, with a chimney, a glowing forge and an anvil
  block(11.8, 4.6, 2.8, m.wood, m.tile); b.chimney(13.3, Y + 2.3, hz - 1.4, 2.2, m.stone); b.box(1.2, 1.7, 0.1, m.door, 11.8, Y, hz + D / 2 + 0.03);
  b.box(1.0, 0.8, 0.8, m.stone, 10.6, Y, hz + D / 2 + 0.7); b.box(0.7, 0.1, 0.5, m.glow, 10.6, Y + 0.8, hz + D / 2 + 0.7);
  b.box(0.4, 0.5, 0.4, m.darkwood, 12.8, Y, hz + D / 2 + 0.7); b.box(0.8, 0.2, 0.4, m.iron, 12.8, Y + 0.5, hz + D / 2 + 0.7);
  // the courtyard: a gravel way from the gate to the great hall (x -1..1), with a garden either side (x 2..7.5, z -7.5..1.5)
  const way0 = hz + D / 2 + 1.5, way1 = ZF - 0.6;
  b.box(2.0, 0.06, way1 - way0, m.stone, 0, Y, (way0 + way1) / 2);
  for (const sx of [-1, 1]) b.box(0.18, 0.1, way1 - way0, m.darkstone, sx * 1.09, Y, (way0 + way1) / 2);   // (the cobbled way, edged in dark stone)
  for (const sx of [-1, 1]) {
    const gx = sx * 4.75, gz = -3.0;
    b.box(5.5, 0.12, 9.0, m.earth, gx, Y, gz);
    b.box(5.5, 0.45, 0.25, hedge, gx, Y, gz - 4.5); b.box(5.5, 0.45, 0.25, hedge, gx, Y, gz + 4.5); b.box(0.25, 0.45, 9.0, hedge, sx * 2.0, Y, gz); b.box(0.25, 0.45, 9.0, hedge, sx * 7.5, Y, gz);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) b.sphere(0.13, new THREE.MeshStandardMaterial({ color: bloom[(r + c + (sx > 0 ? 1 : 0)) % 4] }), gx - 1.9 + c * 1.25, Y + 0.4, gz - 3.0 + r * 2.0);
  }
  // the well, to one side of the way, on a paved ring
  b.cyl(2.0, 2.0, 0.06, m.stone, -5.0, Y, 6.5, 20); b.cyl(0.9, 1.0, 0.8, m.stone, -5.0, Y + 0.06, 6.5, 14);
  for (const dx of [-0.7, 0.7]) b.cyl(0.08, 0.08, 1.6, m.darkwood, -5.0 + dx, Y + 0.86, 6.5, 6);
  b.box(2.0, 0.1, 0.5, m.darkwood, -5.0, Y + 2.46, 6.5); b.pyramid(2.2, 1.2, 0.7, m.tile, -5.0, Y + 2.56, 6.5);
  b.cyl(0.12, 0.2, 1.4, m.darkwood, 5.0, Y, 6.5, 8); b.box(0.4, 0.4, 0.4, m.glow, 5.0, Y + 1.4, 6.5);   // a lantern post on the other side
  // a little hall for each other city, with that city's flag on its roof (3.6 x 3.0, in the columns x = -12 and 12)
  b.foreign.slice(0, EMBASSY_HALL_SLOTS.length).forEach((f, i) => {
    const [x, z] = EMBASSY_HALL_SLOTS[i], inward = x < 0 ? 1 : -1;
    b.box(3.6, 1.8, 3.0, m.plaster, x, Y, z); b.gable(3.6, 3.0, 1.0, m.tile, x, Y + 1.8, z, 0.2); b.box(0.06, 1.2, 0.8, m.door, x + inward * 1.83, Y, z);
    b.flagOf(f, x, Y + 2.0, z, 1.7, 1.0);
  });
  // by the gate: a guard house either side (x 2.8..5.6, z 12.4..15.6)
  for (const sx of [-1, 1]) { b.box(2.8, 2.2, 3.2, m.plaster, sx * 4.2, Y, 14); b.gable(2.8, 3.2, 1.0, roof, sx * 4.2, Y + 2.2, 14, 0.25); b.box(0.7, 1.4, 0.06, m.door, sx * 4.2, Y, 15.63); }
  // the archery range (left of the gate, x -13.8..-7.4, z 11.5..16.4): a fenced lane with three targets and a shed
  {
    const cx = -10.6, cz = 13.95, w = 6.4, d = 4.9, paper = new THREE.MeshStandardMaterial({ color: 0xd9c9a0, roughness: 0.9 }), red = new THREE.MeshStandardMaterial({ color: 0xb02a2a, roughness: 0.9 });
    for (const dz of [-d / 2, d / 2]) b.box(w, 0.7, 0.12, m.wood, cx, Y, cz + dz);
    for (const dx of [-w / 2, w / 2]) b.box(0.12, 0.7, d, m.wood, cx + dx, Y, cz);
    for (const dx of [-2.0, 0, 2.0]) {
      b.box(0.16, 1.4, 0.16, m.darkwood, cx + dx, Y, cz - 1.8);
      b.cyl(0.55, 0.55, 0.1, paper, cx + dx, Y + 0.95, cz - 1.7, 16).rotation.x = Math.PI / 2;
      b.cyl(0.2, 0.2, 0.12, red, cx + dx, Y + 0.95, cz - 1.62, 12).rotation.x = Math.PI / 2;
    }
    b.box(1.6, 1.6, 1.2, m.wood, cx + 2.3, Y, cz + 1.4); b.gable(1.6, 1.2, 0.6, m.thatch, cx + 2.3, Y + 1.6, cz + 1.4, 0.2);
  }
  // the dungeon (right of the gate, x 7.4..13.8, z 11.5..16.4): low dark stone with barred slits and a heavy door
  {
    const cx = 10.6, cz = 13.95;
    b.box(6.4, 2.3, 4.9, m.darkstone, cx, Y, cz); for (let k = 0; k < 6; k++) for (const sz of [-1, 1]) b.box(0.6, 0.5, 0.4, m.darkstone, cx - 3.2 + (k + 0.5) * (6.4 / 6), Y + 2.3, cz + sz * 2.25);   // (battlements round the roof edge)
    for (const dx of [-2.2, -0.7, 0.7, 2.2]) b.box(0.4, 0.6, 0.06, m.iron, cx + dx, Y + 1.3, cz + 2.47);
    b.box(1.3, 1.7, 0.1, m.door, cx, Y, cz + 2.47);
    for (const k of [-0.4, 0, 0.4]) b.box(0.06, 0.5, 0.06, m.iron, cx + k, Y + 1.7, cz + 2.55);
  }
  // the guest house, where envoys stay (x 5.6..8.8, z 5.0..8.2): a two-storey timber house with a gabled roof, a chimney and lit windows
  {
    const cx = 7.2, cz = 6.6;
    b.box(3.2, 2.0, 3.2, m.plaster, cx, Y, cz); b.box(3.3, 1.8, 3.3, m.wood, cx, Y + 2.0, cz); b.gable(3.3, 3.3, 1.3, roof, cx, Y + 3.8, cz, 0.3);
    b.box(0.9, 1.5, 0.06, m.door, cx - 1.0, Y, cz + 1.63); for (const dx of [0.2, 1.1]) b.box(0.5, 0.6, 0.06, m.glow, cx + dx, Y + 1.0, cz + 1.63);
    for (const dx of [-0.9, 0, 0.9]) b.box(0.5, 0.6, 0.06, m.glow, cx + dx, Y + 2.7, cz + 1.68);
    b.chimney(cx + 1.2, Y + 3.2, cz - 0.9, 1.8, m.stone);
  }
  // the scriptorium, where the treaties are written (x -9.6..-7.2, z 8.8..11.2): a small stone house with a tall window, a lectern and a lamp
  {
    const cx = -8.4, cz = 10.0;
    b.box(2.4, 2.2, 2.4, m.stone, cx, Y, cz); b.gable(2.4, 2.4, 1.0, m.slate, cx, Y + 2.2, cz, 0.25);
    b.box(0.7, 1.5, 0.06, m.door, cx, Y, cz + 1.23); for (const dx of [-0.8, 0.8]) b.box(0.4, 0.9, 0.06, m.glow, cx + dx, Y + 1.0, cz + 1.23);
    b.box(0.1, 0.9, 0.1, m.darkwood, cx + 1.6, Y, cz + 0.9); b.box(0.6, 0.1, 0.45, m.darkwood, cx + 1.6, Y + 0.9, cz + 0.9);
  }
  // the treasury (x 6.0..8.8, z 8.7..11.1): a squat stone vault with an iron door and a gilded roof
  {
    const cx = 7.4, cz = 9.9;
    b.box(2.8, 2.0, 2.4, m.darkstone, cx, Y, cz); b.pyramid(3.0, 2.6, 1.0, m.gold, cx, Y + 2.0, cz); b.box(0.9, 1.4, 0.08, m.iron, cx, Y, cz + 1.23);
    for (const dx of [-0.9, 0.9]) b.box(0.18, 1.0, 0.18, m.stone, cx + dx, Y, cz + 1.3);
  }
  // cypress trees down the two strips between the gardens and the little halls
  for (const sx of [-1, 1]) for (const z of [-6, -2, 2]) { b.cyl(0.14, 0.2, 0.9, m.log, sx * 8.9, Y, z, 6); b.cone(0.75, 3.0, hedge, sx * 8.9, Y + 0.7, z, 8); }
  // lamp posts along the cobbled way, just off it
  for (const sx of [-1, 1]) for (const z of [-6, -1, 4, 9]) { b.cyl(0.07, 0.09, 1.6, m.iron, sx * 1.5, Y, z, 6); b.box(0.3, 0.32, 0.3, m.glow, sx * 1.5, Y + 1.6, z); }
  // the steps up to the great hall's porch
  b.box(2.8, 0.2, 0.9, m.stone, 0, Y, hz + D / 2 + 1.95); b.box(2.4, 0.2, 0.6, m.stone, 0, Y + 0.2, hz + D / 2 + 1.85);
  // the guards at the front gate: a spearman with a shield either side of it, outside the wall, and another pair inside, all facing out
  {
    const tabard = new THREE.MeshStandardMaterial({ color: b.banner, roughness: 0.8 }), skin = new THREE.MeshStandardMaterial({ color: 0xd9a77e, roughness: 0.9 });
    const guard = (gx: number, gz: number, y0: number) => {
      for (const dx of [-0.11, 0.11]) b.cyl(0.09, 0.1, 0.8, m.darkwood, gx + dx, y0, gz, 6);
      b.cyl(0.24, 0.2, 0.75, tabard, gx, y0 + 0.8, gz, 8); b.sphere(0.16, skin, gx, y0 + 1.72, gz); b.cyl(0.18, 0.2, 0.2, m.iron, gx, y0 + 1.78, gz, 8); b.cone(0.18, 0.2, m.iron, gx, y0 + 1.97, gz, 8);
      b.cyl(0.025, 0.025, 2.3, m.darkwood, gx + 0.34, y0, gz + 0.05, 5); b.cone(0.05, 0.22, m.iron, gx + 0.34, y0 + 2.3, gz + 0.05, 5);   // the spear
      b.box(0.1, 0.62, 0.42, m.iron, gx - 0.3, y0 + 0.85, gz + 0.1);                                                                     // the shield
    };
    for (const sx of [-1, 1]) { guard(sx * 3.7, ZF + 1.0, 0); guard(sx * 3.3, ZF - 1.2, Y); }
  }
  // the gate: its two doors thrown open, and a banner on each tower
  for (const sx of [-1, 1]) b.box(0.15, wh + 1.1, 1.0, m.darkwood, sx * 0.95, 0, ZF - 0.75);
  for (const sx of [-1, 1]) b.flag(sx * 1.9, wh + 2.0 + 1.3, ZF, 1.8, 1.0);
  // battlements along the wall (a merlon every 1.6) and, from the second tier, a flag on every corner tower
  for (let x = -X + 1.6; x < X - 1.0; x += 1.6) { b.box(0.7, 0.5, 0.6, m.stone, x, wh, ZB); if (Math.abs(x) > 3.1) b.box(0.7, 0.5, 0.6, m.stone, x, wh, ZF); }
  for (let z = ZB + 1.6; z < ZF - 1.0; z += 1.6) for (const sx of [-1, 1]) b.box(0.6, 0.5, 0.7, m.stone, sx * X, wh, z);
  if (t >= 2) for (const sx of [-1, 1]) for (const z of [ZB, ZF]) b.flag(sx * X, wh + 2.4 + 1.5, z, 1.8, 1.0);
};
const roadPiece: Model = b => { b.box(2.2, 0.12, 2.2, M().mud, 0, 0.02, 0); };

const bridgeGhost: Model = b => {
  const m = M();
  for (let s = -4.75; s <= 4.75; s += 0.5) b.box(0.46, 0.14, 2.4, m.wood, s, 0.55, 0);
  for (const side of [-1, 1]) for (let s = -4.8; s <= 4.81; s += 2.4) b.box(0.2, 1.1, 0.2, m.darkwood, s, 0.5, side * 1.1);
};

// Infirmary: a long ward with a gabled roof, a herb bed and a red cross over the door.
const hospital: Model = b => {
  const t = b.t, m = M(), wm = t === 0 ? m.wood : t === 1 ? m.plaster : m.stone, rm = t >= 2 ? m.slate : t === 1 ? m.tile : m.thatch;
  const len = 6 + t * 1.4, dep = 3.4 + t * 0.5, h = 2.4 + t * 0.5;
  b.box(len, h, dep, wm, 0, 0, 0); b.gable(len, dep, 1.5 + t * 0.4, rm, 0, h, 0, 0.5);
  b.box(dep, h, 2.6, wm, -len / 4, 0, dep / 2 + 1.0); b.gable(dep, 2.6, 1.2, rm, -len / 4, h, dep / 2 + 1.0, 0.4);
  b.box(1.0, 1.7, 0.1, m.darkwood, 0.6, 0, dep / 2 + 0.05);
  const red = new THREE.MeshStandardMaterial({ color: 0xb02a2a, roughness: 0.8 });
  b.box(0.2, 0.8, 0.06, red, 0.6, h - 0.1, dep / 2 + 0.1); b.box(0.8, 0.2, 0.06, red, 0.6, h + 0.2, dep / 2 + 0.1);
  for (let i = 0; i < 3; i++) b.box(0.6, 0.6, 0.06, m.glass, -len / 2 + 1.0 + i * 1.1, 1.0, dep / 2 + 0.04);
  const bed = new THREE.MeshStandardMaterial({ color: 0x4f8a2f, roughness: 0.9 });
  for (let i = 0; i < 3; i++) { b.box(1.8, 0.25, 0.7, m.earth, len / 2 - 0.2, 0, -1.2 + i * 1.0); b.sphere(0.25, bed, len / 2 - 0.2, 0.45, -1.2 + i * 1.0); }
  if (t >= 2) b.cyl(0.9, 1.0, 0.6, m.stone, len / 2 + 1.4, 0, -1.4, 12);
};
// Graveyard: a low wall round rows of headstones and crosses, a lych-gate and yew trees.
const graveyard: Model = b => {
  const t = b.t, m = M(), R = 4.2 + t * 0.8, leaf = new THREE.MeshStandardMaterial({ color: 0x2f5a2f, roughness: 0.9 });
  b.cyl(R + 0.4, R + 0.4, 0.05, new THREE.MeshStandardMaterial({ color: 0x5f7f40, roughness: 1 }), 0, 0, 0, 24);
  for (const [x, z, w, d] of [[0, -R, R * 2, 0.3], [0, R, R * 2, 0.3], [-R, 0, 0.3, R * 2], [R, 0, 0.3, R * 2]] as const) b.box(w, 0.7, d, t >= 1 ? m.stone : m.wood, x, 0, z);
  const rows = 3 + t;
  for (let r = 0; r < rows; r++) for (let c = 0; c < 4; c++) {
    const x = -R + 1.4 + c * ((R * 2 - 2.8) / 3), z = -R + 1.5 + r * ((R * 2 - 3) / Math.max(1, rows - 1));
    if (r % 2 === 0 && c % 2 === 0) { b.box(0.14, 1.0, 0.14, m.stone, x, 0, z); b.box(0.6, 0.14, 0.14, m.stone, x, 0.65, z); }
    else { b.box(0.55, 0.8, 0.14, m.stone, x, 0, z); b.cyl(0.275, 0.275, 0.14, m.stone, x, 0.8, z, 10).rotation.x = Math.PI / 2; }
    b.box(0.5, 0.1, 1.0, m.earth, x, 0, z + 0.7);
  }
  b.box(0.2, 2.2, 0.2, m.darkwood, -0.9, 0, R); b.box(0.2, 2.2, 0.2, m.darkwood, 0.9, 0, R); b.gable(2.4, 1.4, 0.7, t >= 1 ? m.tile : m.thatch, 0, 2.2, R, 0.25);
  for (const [x, z] of [[-R + 0.5, -R + 0.5], [R - 0.5, -R + 0.5]] as const) { b.cyl(0.2, 0.3, 1.8, m.log, x, 0, z, 7); b.cone(0.9, 2.6, leaf, x, 1.0, z, 8); }
  if (t >= 2) { b.box(0.5, 1.6, 0.5, m.stone, 0, 0, 0); b.box(1.1, 0.25, 0.25, m.stone, 0, 1.2, 0); }
};
let _fishSilver: THREE.MeshStandardMaterial | null = null, _fishNet: THREE.MeshStandardMaterial | null = null, _fishSmoked: THREE.MeshStandardMaterial | null = null;
const fishMats = () => ({
  silver: (_fishSilver ??= new THREE.MeshStandardMaterial({ color: 0xaab8be, roughness: 0.45, metalness: 0.15 })),
  net: (_fishNet ??= new THREE.MeshStandardMaterial({ color: 0x8c7d58, roughness: 1 })),
  smoked: (_fishSmoked ??= new THREE.MeshStandardMaterial({ color: 0x9a6a2e, roughness: 0.7 })),
});
/** A fish: a flat body with a tail, lying along local X. */
function fish(b: B, mat: THREE.Material, x: number, y: number, z: number, len = 0.5, ry = 0) {
  b.box(len, 0.1, 0.16, mat, x, y, z, ry);
  b.box(len * 0.28, 0.12, 0.2, mat, x - Math.cos(ry) * len * 0.62, y, z + Math.sin(ry) * len * 0.62, ry + 0.5);
}
// Fishing hut: a little timber house on the bank with a long jetty out over the water (+x: the core turns the house so the jetty's end is over water), a moored rowboat, nets drying on a frame and fish on a rack.
const fishingHut: Model = b => {
  const t = b.t, m = M(), f = fishMats();
  const W = 3.0 + t * 0.3, D = 2.6, h = 1.9 + t * 0.2, wm = t >= 2 ? m.timber : m.wood;
  b.box(W + 0.3, 0.3, D + 0.3, m.stone, -0.6, -0.12, 0).name = 'footing'; b.box(W, h, D, wm, -0.6, 0.18, 0);   // the footing ends at -0.6 + W/2 + 0.15 <= 1.5, well short of the bank (the core's HUT_FOOT = 3.8 from the middle)
  b.gable(W + 0.2, D, 1.3 + t * 0.2, t >= 1 ? m.tile : m.thatch, -0.6, h + 0.18, 0, 0.4);
  b.box(0.8, 1.5, 0.12, m.door, -0.6, 0.18, D / 2 + 0.04); b.window(-0.6 + W * 0.3, 1.1, D / 2 + 0.02);
  if (t >= 2) b.chimney(-1.5, h + 0.9, -0.5, 1.1);
  // the jetty: planks on piles, from the house out over the water
  const J0 = W / 2 - 0.45, J1 = 5.6, JW = 1.5, n = Math.round((J1 - J0) / 0.5);
  for (let i = 0; i < n; i++) b.box(0.44, 0.1, JW, i % 2 ? m.wood : m.log, J0 + 0.25 + i * 0.5, 0.0, 0);
  b.slot('jettyPosts', {}, () => {
    for (const x of [J0 + 0.5, J0 + 2.0, J0 + 3.5, J1 - 0.2]) for (const z of [-JW / 2 - 0.05, JW / 2 + 0.05]) b.cyl(0.11, 0.13, 2.0, m.darkwood, x, -2.0, z, 6);
  });
  for (const z of [-JW / 2, JW / 2]) b.box(J1 - J0, 0.1, 0.14, m.darkwood, (J0 + J1) / 2, -0.12, z);
  for (const z of [-JW / 2 - 0.05, JW / 2 + 0.05]) b.cyl(0.13, 0.14, 0.9, m.darkwood, J1 - 0.1, 0.1, z, 6);   // the mooring bollards
  // a rowboat tied alongside: a hull, thwarts, an oar and the catch
  b.slot('rowboat', {}, () => {
    const bx = J0 + 3.0, bz = JW / 2 + 1.0;
    const boat = makeBoat(); boat.position.set(bx, -0.55, bz); boat.scale.set(0.43, 0.55, 0.4);
    boat.traverse(o => { const mesh = o as THREE.Mesh; if (mesh.isMesh) mesh.geometry = mesh.geometry.clone(); });
    b.g.add(boat);
    b.box(0.5, 0.08, 0.3, f.silver, bx + 0.5, -0.46, bz); fish(b, f.silver, bx + 0.1, -0.45, bz + 0.15, 0.4, 0.3);
  });
  // nets drying on a frame beside the house, and a rack of fish
  const nx = -0.6 - W / 2 - 0.9;
  for (const z of [-2.3, -0.9]) b.cyl(0.07, 0.09, 2.2, m.darkwood, nx, 0, z, 6);
  b.box(0.1, 0.1, 1.7, m.darkwood, nx, 2.0, -1.6);
  for (let i = 0; i < 6; i++) b.box(0.05, 1.3 - (i % 3) * 0.2, 0.2, f.net, nx, 0.7 + (i % 3) * 0.1, -2.2 + i * 0.28);
  for (const x of [-2.6, -0.6]) b.cyl(0.06, 0.07, 1.5, m.darkwood, x, 0, D / 2 + 0.9, 6);   // the drying rack stands back by the house, well clear of the jetty and the water
  b.box(2.4, 0.07, 0.07, m.darkwood, -1.6, 1.35, D / 2 + 0.9);
  for (let i = 0; i < 6; i++) b.box(0.1, 0.3, 0.12, i % 2 ? f.silver : f.smoked, -2.4 + i * 0.34, 1.0, D / 2 + 0.9);
  // creels and a barrel
  b.box(0.5, 0.45, 0.5, m.hay, 1.0, 0.1, -D / 2 - 0.5); b.box(0.45, 0.4, 0.45, m.hay, 1.5, 0.1, -D / 2 - 0.4, 0.5);
  b.cyl(0.35, 0.35, 0.7, m.log, -3.2, 0, 0.6, 9);
  if (t >= 1) for (const z of [-0.3, 0.3]) b.cyl(0.05, 0.05, 1.4, m.darkwood, J1 - 1.4, 0.1, z * 3, 5).rotation.x = 0.35;   // rods leaning on the rail
  if (t >= 3) b.flag(-0.6 + W / 2 - 0.2, h + 1.0, -D / 2 + 0.3, 2.0);
};
// Smokehouse: a tall, windowless timber smoking shed with a vented roof and a glowing firebox, racks of fish hung to dry and wood stacked for the fire.
const smokehouse: Model = b => {
  const t = b.t, m = M(), f = fishMats();
  const W = 3.0 + t * 0.3, D = 3.0, h = 2.8 + t * 0.3;
  b.box(W + 0.4, 0.4, D + 0.4, m.stone, 0, -0.1, 0); b.box(W, h, D, t >= 2 ? m.timber : m.darkwood, 0, 0.3, 0);
  for (let i = 0; i < 5; i++) b.box(0.08, h, 0.06, m.wood, -W / 2 + 0.3 + i * (W - 0.6) / 4, 0.3, D / 2 + 0.03);   // board battens
  b.gable(W + 0.2, D, 1.6 + t * 0.2, t >= 1 ? m.slate : m.thatch, 0, h + 0.3, 0, 0.4);
  // the roof vent: a little louvred lantern on the ridge that lets the smoke out
  const top = h + 1.65 + t * 0.2;
  b.box(1.0, 0.5, 0.7, m.darkwood, 0, top, 0); b.gable(1.2, 0.8, 0.35, m.thatch, 0, top + 0.5, 0, 0.12);
  b.smoke.push(new THREE.Vector3(0, top + 1.2, 0));
  // the firebox: a low stone oven against the front with a glowing mouth and its own chimney
  b.box(1.6, 1.0, 0.9, m.stone, -W / 2 + 0.2, 0, D / 2 + 0.55); b.box(0.7, 0.45, 0.1, m.glow, -W / 2 + 0.2, 0.25, D / 2 + 1.03);
  b.chimney(-W / 2 + 0.2, 1.0, D / 2 + 0.55, 2.0, m.stone);
  b.box(0.9, 1.7, 0.12, m.door, W / 2 - 0.9, 0.3, D / 2 + 0.04);
  // hanging fish racks: frames with rows of fish on rails
  const racks: [number, number][] = [[W / 2 + 1.5, 0.6], [-W / 2 - 1.3, -1.0]]; if (t >= 1) racks.push([W / 2 + 1.5, -1.6]);
  for (const [x, z] of racks) {
    for (const dz of [-0.9, 0.9]) b.cyl(0.07, 0.09, 2.1, m.darkwood, x, 0, z + dz, 6);
    for (const y of [1.2, 1.7]) b.box(0.07, 0.07, 1.9, m.darkwood, x, y, z);
    for (let i = 0; i < 7; i++) { b.box(0.1, 0.42, 0.14, f.smoked, x + (i % 2) * 0.04, 0.95, z - 0.78 + i * 0.26); b.box(0.1, 0.42, 0.14, i % 2 ? f.silver : f.smoked, x + (i % 2) * 0.04, 1.45, z - 0.78 + i * 0.26); }
  }
  // firewood stacked under a lean-to, a chopping block with an axe, a basket of fish
  for (const z of [-D / 2 + 0.2, -D / 2 + 1.5]) b.cyl(0.07, 0.08, 1.3, m.darkwood, -W / 2 - 0.5, 0, z, 6);
  b.box(0.9, 0.08, 1.6, m.thatch, -W / 2 - 0.3, 1.25, -D / 2 + 0.85).rotation.z = -0.25;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3 - r; c++) b.logH(1.2, 0.14, m.log, -W / 2 - 0.45, 0.14 + r * 0.26, -D / 2 + 0.35 + c * 0.32 + r * 0.16, 'z');
  b.cyl(0.3, 0.36, 0.45, m.log, W / 2 + 0.9, 0, D / 2 + 1.1, 8); b.box(0.06, 0.55, 0.06, m.darkwood, W / 2 + 0.9, 0.45, D / 2 + 1.1).rotation.z = 0.5;
  b.box(0.5, 0.35, 0.5, m.hay, W / 2 + 0.2, 0, D / 2 + 1.6); fish(b, f.silver, W / 2 + 0.2, 0.38, D / 2 + 1.6, 0.35, 0.4);
  if (t >= 2) { b.box(0.9, 0.8, 0.9, m.stone, W / 2 + 0.2, 0, -D / 2 - 0.2); b.chimney(W / 2 + 0.2, 0.8, -D / 2 - 0.2, 1.6, m.stone); }
  if (t >= 3) b.flag(W / 2 - 0.2, h + 1.8, -D / 2 + 0.3, 2.0);
};
// Bakery: a plastered cottage with a big domed brick oven built against its side (glowing mouth, tall chimney), a table of loaves and sacks of flour at the door.
const bakery: Model = b => {
  const t = b.t, m = M();
  const W = 3.2 + t * 0.3, D = 2.8, h = 2.2 + t * 0.2;
  b.box(W + 0.4, 0.4, D + 0.4, m.stone, 0, -0.1, 0); b.box(W, h, D, t >= 1 ? m.timber : m.darkwood, 0, 0.3, 0);
  b.gable(W + 0.3, D + 0.2, 1.4 + t * 0.2, t >= 2 ? m.slate : m.thatch, 0, h + 0.3, 0, 0.35);
  b.box(0.9, 1.6, 0.12, m.door, -W / 2 + 0.8, 0.3, D / 2 + 0.04); b.box(0.7, 0.6, 0.1, m.glow, W / 2 - 0.9, h * 0.5, D / 2 + 0.05);
  // the oven: a brick dome on a stone base against the side wall, mouth glowing, with its own chimney
  const ox = W / 2 + 1.1;
  b.box(1.9, 0.7, 1.9, m.stone, ox, 0, 0); b.dome(1.0, m.brick, ox, 0.7, 0, 1.0); b.box(0.7, 0.5, 0.12, m.glow, ox, 0.8, 0.95);
  b.chimney(ox, 1.6, -0.2, 2.2, m.brick); b.smoke.push(new THREE.Vector3(ox, 4.0, -0.2));
  // a trestle table of loaves, sacks of flour and a peel leaning on the wall
  b.box(1.3, 0.1, 0.6, m.wood, -0.2, 0.75, D / 2 + 0.9); for (const x of [-0.7, 0.3]) b.box(0.08, 0.75, 0.5, m.darkwood, x, 0, D / 2 + 0.9);
  for (let i = 0; i < 4; i++) b.box(0.28, 0.16, 0.18, m.hay, -0.65 + i * 0.32, 0.85, D / 2 + 0.9);
  for (const [x, z] of [[-W / 2 - 0.5, 0.4], [-W / 2 - 0.5, -0.5]]) b.cyl(0.32, 0.38, 0.7, m.hay, x, 0, z, 8);
  b.box(0.06, 1.8, 0.06, m.darkwood, -W / 2 + 0.2, 0.1, D / 2 + 0.25).rotation.z = 0.12;
  if (t >= 2) b.box(W + 0.6, 0.2, 0.5, m.timber, 0, h + 0.1, D / 2 + 0.3);   // an awning over the counter
  if (t >= 3) b.flag(-W / 2 + 0.2, h + 1.8, -D / 2 + 0.3, 2.0);
};
const MODELS: Model[] = [house, farm, wall, tower, woodcutter, sawmill, quarry, claypit, brickworks, mine(false), mine(true), charcoal, smelter, blacksmith, mint, townhall, well, chapel, lodge, barracks, builders, fence, gate, drawbridge, moat, storehouse, keep, courthouse, market, waterwheel, garden, park, riverPiece, moundPiece, pitPiece, port, toll, roadPiece, bridgeGhost, hospital, graveyard, fishingHut, smokehouse, bakery, plaza, livestockPen(false), livestockPen(true), stable, forester, embassy, firestation];

/** Merge a finished building's static meshes into one mesh per material. A house is built from dozens of boxes, beams and
 *  roof pieces; drawn separately each one costs a draw call (and another in the shadow pass). Animated parts (flags, wheels,
 *  windmill sails) stay separate. */
function bake(g: THREE.Group, animated: Set<THREE.Object3D>) {
  g.updateMatrixWorld(true);
  const per = new Map<THREE.Material, { structure: THREE.BufferGeometry[]; details: THREE.BufferGeometry[]; base: THREE.Material | undefined }>(), old: THREE.Mesh[] = [];
  const size = new THREE.Vector3();
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
    geo.computeBoundingBox(); geo.boundingBox!.getSize(size);
    let e = per.get(m.material); if (!e) { e = { structure: [], details: [], base: m.userData.base }; per.set(m.material, e); }
    (size.lengthSq() <= 1.8 ? e.details : e.structure).push(geo);
    old.push(m);
  });
  old.forEach(m => { m.parent?.remove(m); m.geometry.dispose(); });
  for (const [mat, e] of per) for (const [parts, detail] of [[e.structure, false], [e.details, true]] as const) {
    if (!parts.length) continue;
    const merged = mergeGeometries(parts); parts.forEach(x => x.dispose()); if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = !detail; mesh.receiveShadow = true;
    mesh.userData.baked = true; mesh.userData.base = e.base; mesh.userData.detail = detail;
    g.add(mesh);
  }
}

/** A spinning part (a water wheel, windmill sails) is kept out of the village's merged meshes because it turns, but its pieces (rim, spokes, paddles, sails) never
 *  move against each other: merge them into one mesh per material inside the rotor, which still turns as one. A wheel was some twenty meshes, so twenty draws. */
function mergeRotor(rotor: THREE.Object3D) {
  if ((rotor as THREE.Mesh).isMesh) return;
  rotor.updateMatrixWorld(true);
  const inv = rotor.matrixWorld.clone().invert(), local = new THREE.Matrix4();
  const per = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; shadow: boolean; receive: boolean }>();
  const parts: THREE.Mesh[] = [];
  rotor.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || !m.visible) return;
    parts.push(m);
  });
  if (parts.length < 3) return;
  for (const m of parts) {
    let e = per.get(m.material as THREE.Material);
    if (!e) per.set(m.material as THREE.Material, e = { geos: [], shadow: false, receive: false });
    const g = m.geometry.clone().applyMatrix4(local.multiplyMatrices(inv, m.matrixWorld));
    e.geos.push(g.index ? g.toNonIndexed() : g); e.shadow ||= m.castShadow; e.receive ||= m.receiveShadow;
  }
  const merged: THREE.Mesh[] = [];
  for (const [mat, e] of per) {
    const geo = mergeGeometries(e.geos); e.geos.forEach(g => g.dispose());
    if (!geo) return;   // pieces that cannot be merged: leave the rotor as it was
    const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = e.shadow; mesh.receiveShadow = e.receive; merged.push(mesh);
  }
  for (const m of parts) { m.parent?.remove(m); m.geometry.dispose(); }
  rotor.add(...merged);
}

/** A building's model in parts: the bare building (`base`), and one group for each optional upgrade that is switched on. Switching an upgrade on builds only its group; switching it off
 *  removes only its group. An upgrade that changes the bare building (a spire takes the place of a tower's roof) swaps just the part it changes: the base keeps that part as a named slot
 *  and gets it back when the upgrade goes. The groups are merged per material (see `bake`) separately, so the base's meshes are the same objects before and after. */
export class BuildingModel {
  readonly group = new THREE.Group();
  readonly base: THREE.Group;
  /** The groups of the upgrades that are on, by option bit. */
  readonly parts = new Map<number, THREE.Group>();
  private slots = new Map<string, THREE.Group>();
  private detached = new Set<string>();
  private ctx: OptionCtx;
  private opts = 0;
  private variant: number;

  constructor(readonly kind: number, readonly tier: number, private banner = 0x2f5fa8, readonly seed = 0, private flag?: Flag, private baked = true, private foreign: Flag[] = [], private roof = 0) {
    const b = new B(tier, banner, flag, roof); b.foreign = foreign;
    MODELS[kind](b);
    b.g.updateMatrixWorld(true);
    const solid: THREE.Box3[] = [], all = new THREE.Box3();
    b.g.traverse(o => { const me = o as THREE.Mesh; if (me.isMesh) { const bb = new THREE.Box3().setFromObject(me); if (bb.max.y - bb.min.y > 0.3) solid.push(bb); } });
    solid.forEach(x => all.union(x));
    if (all.isEmpty()) all.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    this.variant = seed >= 0 ? ((seed % 4) + 4) % 4 : -1;
    this.slots = b.slots;
    this.ctx = { solid, all, cx: (all.min.x + all.max.x) / 2, cz: (all.min.z + all.max.z) / 2, hw: (all.max.x - all.min.x) / 2, hd: (all.max.z - all.min.z) / 2, reach: 0, top: all.max.y, seed, tier, opts: 0, slots: this.slots };
    this.ctx.reach = Math.hypot(this.ctx.hw, this.ctx.hd);
    for (const sl of this.slots.values()) b.g.remove(sl);   // each slot is merged on its own, so it can leave and come back
    this.seal(b.g, b); for (const sl of this.slots.values()) this.seal(sl, b);
    for (const sl of this.slots.values()) b.g.add(sl);
    this.base = b.g; this.base.userData.part = 'base'; this.group.add(this.base);
    this.group.userData.model = this;
    this.refresh();
  }

  /** Variation, vertex colours and merging for a freshly built group of parts. */
  private seal(g: THREE.Group, b: B) {
    if (this.variant >= 0) applyVariant(g, this.variant);
    g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry.attributes.position && !m.geometry.attributes.color) { const n = m.geometry.attributes.position.count; m.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3)); } });
    if (this.baked) { b.spin.forEach(mergeRotor); const animated = new Set<THREE.Object3D>(); b.spin.forEach(o => o.traverse(c => animated.add(c))); b.deck.forEach(o => o.traverse(c => animated.add(c))); bake(g, animated); }
    g.userData.smoke = b.smoke; g.userData.spin = b.spin.concat(b.deck);
  }

  private refresh() {
    const smoke: THREE.Vector3[] = [], spin: THREE.Object3D[] = [];
    for (const g of [this.base, ...this.parts.values()]) { smoke.push(...(g.userData.smoke as THREE.Vector3[])); spin.push(...(g.userData.spin as THREE.Object3D[])); }
    this.group.userData.smoke = smoke; this.group.userData.spin = spin;
  }

  get options() { return this.opts; }

  /** Fit the equipment to the water while the house and its foundation stay at bank height. */
  fitShore(clearance: number) {
    const millrace = this.slots.get('millrace'), boat = this.slots.get('rowboat'), posts = this.slots.get('jettyPosts');
    if (millrace) millrace.position.y = 0.7 - clearance;
    if (boat) boat.position.y = 0.55 - clearance;
    if (posts) posts.scale.y = Math.max(1, (clearance + 1.5) / 2);
  }

  /** Keep every pile against the terrain beneath it, with its head fixed to the deck. */
  fitPortPier(x: number, z: number, turn: number, pad: number, groundAt: (x: number, z: number) => number) {
    const angle = turn * Math.PI / 4, c = Math.cos(angle), s = Math.sin(angle);
    let changed = false;
    for (const [name, slot] of this.slots) {
      if (!name.startsWith('port-pile-')) continue;
      const { x: a, z: b } = slot.userData.info as { x: number; z: number };
      const ground = groundAt(x + a * c + b * s, z - a * s + b * c);
      const scale = Math.max(0.15, pad + 0.68 - ground) / 2.6;
      if (Math.abs(slot.scale.y - scale) < 0.001) continue;
      slot.scale.y = scale; slot.position.y = 0.5 * (1 - scale);
      changed = true;
    }
    return changed;
  }

  /** Make the upgrades that are on be exactly `next` (a bit mask). Returns the groups that were added (to be built up with the scaffold) and the ones taken away. */
  setOptions(next: number): { added: THREE.Group[]; removed: THREE.Group[] } {
    const added: THREE.Group[] = [], removed: THREE.Group[] = [], changed = this.opts ^ next, deps = DEPENDS[this.kind] ?? {}, repl = REPLACES[this.kind] ?? {};
    if (!changed) return { added, removed };
    let redo = changed;   // an upgrade whose look depends on one that changed is drawn again
    for (let bit = 0; bit < OPT_BITS; bit++) if ((next >> bit) & 1 && (deps[bit] ?? []).some(d => (changed >> d) & 1)) redo |= 1 << bit;
    this.opts = next; this.ctx.opts = next;
    for (let bit = 0; bit < OPT_BITS; bit++) {
      const g = this.parts.get(bit); if (!g || !((redo >> bit) & 1)) continue;
      this.group.remove(g); g.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); }); this.parts.delete(bit); removed.push(g);
    }
    for (const [bit, slot] of Object.entries(repl)) {   // the slot is back in the base unless an upgrade that is still on replaces it
      const on = Object.entries(repl).some(([k, sl]) => sl === slot && (next >> Number(k)) & 1), g = this.slots.get(slot)!;
      if (!on && this.detached.has(slot)) { this.base.add(g); this.detached.delete(slot); }
      void bit;
    }
    for (let bit = 0; bit < OPT_BITS; bit++) {
      if (!((next >> bit) & 1) || !((redo >> bit) & 1)) continue;
      const b = new B(this.tier, this.banner, this.flag, this.roof);
      addOption(b, this.kind, bit, { ...this.ctx, solid: this.roomFor(bit) });
      const g = b.g; g.userData.part = 'option'; g.userData.option = bit;
      this.seal(g, b);
      const slot = repl[bit]; if (slot && !this.detached.has(slot)) { this.base.remove(this.slots.get(slot)!); this.detached.add(slot); }
      if (this.group.userData.charred) setCharred(g, true, Math.max(0, this.variant));
      this.group.add(g); this.parts.set(bit, g); added.push(g);
    }
    this.refresh();
    return { added, removed };
  }

  /** What stands in the way of upgrade `bit`: the bare building, and the room that every lower-numbered upgrade takes up whether it is on or not, so that two upgrades never grow
   *  into each other and where an upgrade goes never depends on which others are on. */
  private reserved = new Map<number, THREE.Box3[]>();
  private roomFor(bit: number): THREE.Box3[] {
    const solid = this.ctx.solid.slice();
    for (let j = 0; j < bit; j++) {
      let boxes = this.reserved.get(j);
      if (!boxes) {
        const b = new B(this.tier, this.banner, this.flag, this.roof); b.foreign = this.foreign; addOption(b, this.kind, j, { ...this.ctx, solid: this.roomFor(j) }); b.g.updateMatrixWorld(true);
        boxes = []; b.g.traverse(o => { const me = o as THREE.Mesh; if (me.isMesh) { const bb = new THREE.Box3().setFromObject(me); if (bb.max.y - bb.min.y > 0.3) boxes!.push(bb); } });
        b.g.traverse(o => { (o as THREE.Mesh).geometry?.dispose(); });
        this.reserved.set(j, boxes);
      }
      solid.push(...boxes);
    }
    return solid;
  }

  /** Free what the model still holds that is not in the scene (the slots that upgrades have taken out). */
  dispose() { for (const slot of this.detached) this.slots.get(slot)?.traverse(o => { (o as THREE.Mesh).geometry?.dispose(); }); this.detached.clear(); }
}

export function buildModel(kind: number, tier: number, banner = 0x2f5fa8, seed = 0, opts = 0, flag?: Flag, baked = true, foreign: Flag[] = [], roof = 0) {
  const m = new BuildingModel(kind, tier, banner, seed, flag, baked, foreign, roof);
  m.setOptions(opts);
  return m.group;
}

// ---------- optional design upgrades ----------
/** Option bits per building: 0-3 are open early, 4-7 are the second tier that needs a better building tier (see catalog.rs). */
const OPT_BITS = 8;
/** Each building can take up to four optional upgrades (see the catalog) that change its look a little: a chimney, a banner, a barn, hoardings, turrets. Every extra is placed
 *  on a spot that is checked against what the building already has, so an addition never grows through a wall, a roof or another addition. */
/** One optional upgrade of a building, drawn into its own group `b` (see BuildingModel). Where it goes is worked out from the bare building, never from the other upgrades, so each can be
 *  added or taken away on its own and the result is the same whatever the order. */
interface OptionCtx { solid: THREE.Box3[]; all: THREE.Box3; cx: number; cz: number; hw: number; hd: number; reach: number; top: number; seed: number; tier: number; opts: number; slots: Map<string, THREE.Group> }
/** Which slot of the base model an option takes the place of, and which options an option's look depends on (it is drawn again when one of them is switched). */
const REPLACES: Record<number, Record<number, string>> = { 3: { 2: 'roof' }, 35: { 3: 'warehouseFooting' } };
const DEPENDS: Record<number, Record<number, number[]>> = { 3: { 0: [2] } };
/** Where the fishing hut's land ends in its model frame (+x is towards the water): the jetty starts here, so nothing but the jetty goes past it. */
const hutLandX = (tier: number) => (3.0 + tier * 0.3) / 2 - 0.45;
/** How far past its fields a farm's yard reaches: the footprint and the levelled ground (FARM_YARD in lib.rs) include it, so the extras stand on flat ground that is the farm's own. */
const FARM_YARD = 5.0;
/** The ground a farm's crop fields cover at a tier (a box round all of them, as in the `farm` model): the design extras stand outside it. */
const farmFields = (t: number) => new THREE.Box3(new THREE.Vector3(-5.2, 0, -2.8), new THREE.Vector3(t >= 1 ? 10.4 : 5.2, 1, t >= 2 ? 10.3 : 6.0));
/** Where the parts of a village house are at each tier (the numbers of the `house` model): what the design options attach to. The ridge runs along x for the two low tiers (the long eave side faces
 *  the front, +z) and along z for the two brick tiers (a gable end faces the front). `foot` is how far the stone footing sticks out past the wall; `eaveY` and `ridgeY` bound the roof and `e` is its half span
 *  (overhang included), so `roofY(u)` is the height of the roof surface at distance `u` from the ridge. */
function houseGeo(t: number) {
  const w = [4.0, 4.3, 4.7, 5.3][t], d = [3.2, 3.4, 3.6, 3.8][t], rx = t < 2;
  const eaveY = [1.7, 4.37, 4.55, 5.4][t], h = [2.1, 2.0, 2.2, 2.6][t], o = [0.6, 0.5, 0.45, 0.5][t];
  const len = rx ? (t === 1 ? w + 0.7 : w) : d, span = rx ? (t === 1 ? d + 0.7 : d) : w, e = span / 2 + o;
  return { w, d, rx, eaveY, h, o, len, e, ridgeY: eaveY + h, foot: [0.1, 0.15, 0.15, 0.2][t], roofY: (u: number) => eaveY + h * Math.max(0, 1 - Math.abs(u) / e) };
}

/** One design option of a village house. Every part is built against something real: a wall, the roof surface or the ground at the foot of the house, using the numbers of `houseGeo`, so nothing
 *  hangs in the air, and the options sit in places of their own (ridge: chimney and dovecote; front slope: loft; end of the roof: carved gable; side wall: woodshed and cellar; back: garden). */
function houseOption(b: B, bit: number, c: OptionCtx) {
  const m = M(), t = c.tier, g = houseGeo(t), { w, d, rx, eaveY, h, o, len, e, ridgeY, foot, roofY } = g;
  /** (along the ridge, across it) to (x, z), and a box laid out the same way. */
  const P = (s: number, u: number): [number, number] => rx ? [s, u] : [u, s];
  const bx = (ds: number, dh: number, du: number, mat: THREE.Material, s: number, y: number, u: number) => { const [x, z] = P(s, u); return rx ? b.box(ds, dh, du, mat, x, y, z) : b.box(du, dh, ds, mat, x, y, z); };
  const bloom = (x: number, y: number, z: number, r = 0.085, k = 0) => b.sphere(r, m.bloom[k % 4], x, y, z);
  /** A flower box hung under a front window: a trough with leaves and blooms. */
  const windowBox = (x: number, y: number, zFace: number, wid: number) => {
    const z = zFace + 0.16; b.box(wid, 0.2, 0.3, m.darkwood, x, y, z); b.box(wid - 0.08, 0.05, 0.22, m.soil, x, y + 0.2, z);
    const n = Math.round(wid / 0.19); for (let i = 0; i < n; i++) { const px = x - wid / 2 + 0.12 + i * ((wid - 0.24) / Math.max(1, n - 1)); b.dome(0.12, m.leaf, px, y + 0.2, z, 0.9); bloom(px + (i % 2 ? 0.03 : -0.03), y + 0.36 + (i % 2) * 0.05, z + 0.02, 0.075, i + (zFace > 2 ? 1 : 0)); }
  };
  const pot = (x: number, z: number, k: number) => { b.cyl(0.2, 0.15, 0.32, m.clay, x, 0, z, 10); b.dome(0.24, m.leaf, x, 0.3, z, 0.85); for (let i = 0; i < 3; i++) bloom(x + Math.cos(i * 2.1 + k) * 0.13, 0.55 + (i % 2) * 0.06, z + Math.sin(i * 2.1 + k) * 0.13, 0.08, k + i); };
  const roofMat = t === 0 ? m.thatch : t === 1 ? m.tile : m.slate, dormerRoof = t === 1 ? m.slate : m.tile;   // (a dormer roof never matches the roof it grows out of)
  switch (bit) {
    case 0: {   // a second chimney on the ridge, its foot sunk in the roof
      const [x, z] = P(-0.32 * len, 0), y = ridgeY - 0.55;
      b.chimney(x, y, z, 1.75, m.brick); b.box(0.8, 0.12, 0.8, m.darkstone, x, y + 1.75, z); b.box(0.9, 0.14, 0.9, m.darkstone, x, ridgeY - 0.12, z);
      b.cyl(0.1, 0.12, 0.32, m.clay, x - 0.12, y + 1.87, z - 0.12, 8); b.cyl(0.1, 0.12, 0.26, m.clay, x + 0.14, y + 1.87, z + 0.12, 8);
      break;
    }
    case 1: {   // window boxes under the front windows and pots by the door
      const wins = ([
        [[-0.22 * w, 0.42, d / 2 + 0.03, 0.72]],
        [[0.2 * w, 0.7, d / 2 + 0.05, 0.62], [-0.25 * w, 2.72, d / 2 + 0.4, 0.82], [0.25 * w, 2.72, d / 2 + 0.4, 0.82]],
        [[-0.3 * w, 1.13, d / 2 + 0.1, 0.95], [0.3 * w, 1.13, d / 2 + 0.1, 0.95], [-0.3 * w, 2.9, d / 2 + 0.1, 0.95], [0.3 * w, 2.9, d / 2 + 0.1, 0.95]],
        [[-0.32 * w, 1.27, d / 2 + 0.1, 1.05], [0.32 * w, 1.27, d / 2 + 0.1, 1.05], [-0.32 * w, 3.03, d / 2 + 0.1, 1.05], [0.32 * w, 3.03, d / 2 + 0.1, 1.05]],
      ] as [number, number, number, number][][])[t];
      for (const [x, y, zf, wid] of wins) windowBox(x, y, zf, wid);
      const door = [0.2 * w, -0.22 * w, 0, 0][t], pz = d / 2 + 0.35;
      if (t < 2) pot(door + (t === 0 ? 0.75 : 0.8), pz - 0.05, 1); else { pot(-(t === 2 ? 0.85 : 1.0), pz, 0); pot(t === 2 ? 0.85 : 1.0, pz, 2); }
      break;
    }
    case 2: {   // a lean-to against the end wall with a stack of logs under it
      const xw = w / 2 + foot, D = 1.35, hs = [1.3, 2.0, 2.0, 2.2][t], drop = 0.42, z0 = 0, W = 2.4, mat = t === 0 ? m.thatch : roofMat;
      const ang = Math.atan(drop / (D + 0.15));
      b.box(Math.hypot(D + 0.15, drop), 0.1, W + 0.2, mat, xw + (D + 0.15) / 2 - 0.05, hs - drop / 2 - 0.05, z0).rotation.z = -ang;
      for (const sz of [-1, 1]) b.box(0.12, hs - drop, 0.12, m.darkwood, xw + D, 0, z0 + sz * (W / 2 - 0.05));
      b.box(0.1, 0.1, W, m.darkwood, xw + D, hs - drop - 0.1, z0); b.box(0.1, 0.1, W, m.darkwood, xw + 0.05, hs - 0.15, z0);
      for (let row = 0; row < 3; row++) for (let k = 0; k < 4 - row; k++) b.logH(W - 0.3, 0.13, m.bark, xw + 0.2 + k * 0.28 + row * 0.14, 0.14 + row * 0.25, z0, 'z');
      b.cyl(0.22, 0.24, 0.34, m.bark, xw + 0.95, 0, z0 + W / 2 - 0.1, 10); b.box(0.06, 0.55, 0.06, m.darkwood, xw + 0.95, 0.34, z0 + W / 2 - 0.1);
      break;
    }
    case 3: {   // a dovecote on the ridge: a plastered box on the ridge beam under a tiled cap, doves on the ridge
      const s = [1.2, 0.48, 0.3 * len, 0.3 * len][t], [x, z] = P(s, 0), y = ridgeY - 0.5, sz = 0.8;
      b.box(sz, 1.2, sz, m.plaster, x, y, z); b.box(sz + 0.14, 0.1, sz + 0.14, m.darkwood, x, y + 1.2, z); b.pyramid(sz + 0.4, sz + 0.4, 0.55, m.tile, x, y + 1.3, z); b.sphere(0.08, m.gold, x, y + 1.9, z);
      for (const q of [1, -1]) { const [fx, fz] = rx ? [0, q * (sz / 2 + 0.03)] : [q * (sz / 2 + 0.03), 0]; const hole = b.box(rx ? 0.22 : 0.06, 0.26, rx ? 0.06 : 0.22, m.door, x + fx, y + 0.65, z + fz); void hole; b.box(rx ? 0.4 : 0.14, 0.05, rx ? 0.14 : 0.4, m.darkwood, x + fx * 1.8, y + 0.52, z + fz * 1.8); }
      for (const ds of [0.75, 1.15]) { const [dx, dz] = P(s + ds * (s > 0 ? 1 : 1), 0), dy = ridgeY + 0.1; b.sphere(0.12, m.dove, dx, dy, dz); b.box(rx ? 0.22 : 0.08, 0.06, rx ? 0.08 : 0.22, m.dove, dx + (rx ? 0.12 : 0), dy, dz + (rx ? 0 : 0.12)); }
      break;
    }
    case 4: {   // a loft dormer on the front slope: its foot is in the roof, so it grows out of it
      const s = [0, -0.5, -0.28 * len, -0.28 * len][t], uf = 0.62 * e, y = roofY(uf) - 0.15, hh = 1.0, depth = 0.95, wid = 1.1, uc = uf - depth / 2;
      bx(wid, hh, depth, m.plaster, s, y, uc);
      const [rx0, rz0] = P(s, uf + 0.035); if (rx) b.window(rx0, y + 0.55, rz0, 0, 0.4, 0.45); else b.window(rx0, y + 0.55, rz0, Math.PI / 2, 0.4, 0.45);
      const [gx, gz] = P(s, uc - 0.1), gabl = rx ? b.gableZ(1.3, wid + 0.1, 0.55, dormerRoof, gx, y + hh, gz, 0.15) : b.gable(1.3, wid + 0.1, 0.55, dormerRoof, gx, y + hh, gz, 0.15);
      void gabl; bx(wid + 0.3, 0.1, 0.22, m.stoneMat, s, y - 0.02, uf + 0.08);
      break;
    }
    case 5: {   // a kitchen garden behind the house: three raised beds of cabbages, beans and herbs
      const zc = -(d / 2 + foot + 0.85), xs = [-0.8, 0.35, 1.5];
      for (const [i, x] of xs.entries()) {
        b.box(1.0, 0.24, 1.1, m.soil, x, 0, zc);
        for (const sx of [-1, 1]) b.box(0.06, 0.34, 1.16, m.wood, x + sx * 0.52, 0, zc); for (const sz of [-1, 1]) b.box(1.04, 0.34, 0.06, m.wood, x, 0, zc + sz * 0.56);
        if (i === 0) for (const px of [-0.25, 0.25]) for (const pz of [-0.28, 0.28]) b.dome(0.23, m.leaf, x + px, 0.22, zc + pz, 0.8);
        if (i === 1) { for (const px of [-0.4, 0.4]) b.cyl(0.03, 0.03, 1.3, m.darkwood, x + px, 0.2, zc); b.box(0.9, 0.04, 0.04, m.darkwood, x, 1.42, zc); for (let k = 0; k < 6; k++) b.sphere(0.13, m.leaf, x - 0.4 + (k % 3) * 0.4, 0.55 + Math.floor(k / 3) * 0.5, zc + (k % 2 ? 0.1 : -0.1)); }
        if (i === 2) for (let k = 0; k < 5; k++) { const px = x + ((k % 3) - 1) * 0.3, pz = zc + (k < 3 ? -0.25 : 0.25); b.dome(0.15, m.leaf, px, 0.22, pz, 0.9); if (k % 2) bloom(px, 0.46, pz, 0.06, k); }
      }
      break;
    }
    case 6: {   // a carved and painted gable end on the front-facing end of the roof: bargeboards, a tie beam, a sunburst
      const end = len / 2 + o + 0.05, ang = Math.atan(h / e), L = Math.hypot(e, h) * 0.98;
      const face = (lat: number, y: number, tw: number, th: number, mat: THREE.Material, rot = 0) => rx ? (() => { const q = b.box(0.12, th, tw, mat, end, y - th / 2, lat); q.rotation.x = rot; return q; })() : (() => { const q = b.box(tw, th, 0.12, mat, lat, y - th / 2, end); q.rotation.z = rot; return q; })();
      for (const sd of [-1, 1]) { const lat = sd * e / 2, y = eaveY + h / 2 - 0.1; if (rx) face(lat, y, L, 0.2, m.shutterRed, sd * ang); else face(lat, y, L, 0.2, m.shutterRed, -sd * ang); }
      face(0, eaveY + h * 0.3, e * 1.3, 0.16, m.darkwood);
      for (const sd of [-1, 1]) face(sd * e * 0.65, eaveY + h * 0.3 + 0.03, 0.2, 0.22, m.gold);
      const disc = rx ? b.cyl(0.36, 0.36, 0.08, m.gold, end, eaveY + h * 0.62, 0, 16) : b.cyl(0.36, 0.36, 0.08, m.gold, 0, eaveY + h * 0.62, end, 16); if (rx) disc.rotation.z = Math.PI / 2; else disc.rotation.x = Math.PI / 2;
      face(0, eaveY + h * 0.62 + 0.14, 0.16, 0.28, m.shutterBlue); face(0, eaveY + h * 0.3 - 0.1, 0.1, 0.4, m.shutterRed);
      for (const q of [-1, 1]) face(q * 0.3, eaveY + h * 0.78, 0.1, 0.18, m.shutterBlue);
      break;
    }
    case 7: {   // a cellar hatch against the back-left wall: stepped stone cheeks, sloping doors and a barrel
      const xw = -(w / 2 + foot), z0 = t === 3 ? 0.95 : -0.55, step = [0.85, 0.6, 0.35];
      for (const sz of [-1, 1]) for (const [i, hh] of step.entries()) b.box(0.43, hh, 0.16, m.stone, xw - 0.215 - i * 0.43, 0, z0 + sz * 0.7);
      const ang = Math.atan(0.5 / 1.3);
      for (const sz of [-1, 1]) { const door = b.box(Math.hypot(1.3, 0.5), 0.07, 0.62, m.darkwood, xw - 0.65, 0.86 - 0.25 + 0.01, z0 + sz * 0.32); door.rotation.z = ang; b.box(0.5, 0.03, 0.08, m.iron, xw - 0.4, 0.74, z0 + sz * 0.32).rotation.z = ang; }
      const bz = z0 + (t === 3 ? 1.05 : -1.05); b.cyl(0.3, 0.3, 0.6, m.wood, xw - 0.5, 0, bz, 12); for (const y of [0.12, 0.42]) b.cyl(0.315, 0.315, 0.04, m.iron, xw - 0.5, y, bz, 12);
      break;
    }
  }
}

function addOption(b: B, kind: number, bit: number, c: OptionCtx) {
  const m = M(), { all, cx, cz, hw, hd, reach, seed } = c, solid = c.solid;
  const top = c.top;
  /** A free spot (centre) for a w x d x h item standing on the ground at height y0: the first place on a widening spiral round the building that touches nothing. */
  const ff = kind === 1 ? farmFields(c.tier) : null, fc = ff ? ff.getCenter(new THREE.Vector3()) : null, fr = ff ? Math.hypot((ff.max.x - ff.min.x) / 2, (ff.max.z - ff.min.z) / 2) : 0;
  const spot = (w: number, d: number, h: number, y0 = 0): [number, number] | null => {
    for (let k = 0; k < (kind === 1 ? 520 : 90); k++) {
      const a = seed * 0.83 + bit * 1.7 + k * 0.62, rad = kind === 49 ? 20 + k * 0.45 : kind === 1 ? fr * 0.7 + k * 0.05 : Math.max(hw, hd) * 0.55 + k * 0.1;   // (the embassy's extras stand outside its wall, never in the courtyard)
      if (rad > (kind === 1 ? fr + FARM_YARD + 1 : reach * 1.25 + 2.2)) break;
      const x = (kind === 1 ? fc!.x : cx) + Math.cos(a) * rad, z = (kind === 1 ? fc!.z : cz) + Math.sin(a) * rad, bb = new THREE.Box3(new THREE.Vector3(x - w / 2 - 0.12, y0, z - d / 2 - 0.12), new THREE.Vector3(x + w / 2 + 0.12, y0 + h, z + d / 2 + 0.12));
      if (kind === 1 && (bb.min.x < ff!.min.x - FARM_YARD || bb.max.x > ff!.max.x + FARM_YARD || bb.min.z < ff!.min.z - FARM_YARD || bb.max.z > ff!.max.z + FARM_YARD || (bb.max.x > ff!.min.x - 0.3 && bb.min.x < ff!.max.x + 0.3 && bb.max.z > ff!.min.z - 0.3 && bb.min.z < ff!.max.z + 0.3) || (bb.max.x > -2.6 && bb.min.x < 0.2 && bb.min.z < -5.5))) continue;   // a farm's extras stand in the yard round its fields, never on the fields, and never on the strip where its road leaves the barn
      if (kind === 49 && Math.abs(x) < 16 + w / 2 + 1.2 && Math.abs(z) < 18 + d / 2 + 1.2) continue;
      if (kind === 29 && x + w / 2 + 0.4 > 3.0) continue;   // the watermill's extras stay on the land side, never by the wheel
      if (kind === 41 && x + w / 2 + 1.0 > hutLandX(c.tier)) continue;   // the fishing hut's extras stay on the land side, behind the jetty's start (never on the jetty or over the water)
      if (solid.some(s => s.intersectsBox(bb))) continue;
      solid.push(bb); return [x, z];
    }
    return null;
  };
  /** The height of the highest broad part of the building at (x, z): where something can really stand (not on a flagpole or a chimney). */
  const surf = (x: number, z: number) => { let y = 0; for (const s of solid) if (s.max.x - s.min.x > 0.8 && s.max.z - s.min.z > 0.8 && x >= s.min.x && x <= s.max.x && z >= s.min.z && z <= s.max.z) y = Math.max(y, s.max.y); return y; };
  const pole = (h: number) => { const p = spot(0.5, 0.5, h); if (p) b.flag(p[0], 0, p[1], h); };
  const lantern = () => { const p = spot(0.4, 0.4, 1.7); if (p) { b.cyl(0.05, 0.06, 1.5, m.darkwood, p[0], 0, p[1], 6); b.box(0.24, 0.3, 0.24, m.glow, p[0], 1.45, p[1]); b.pyramid(0.34, 0.34, 0.2, m.iron, p[0], 1.75, p[1]); } };
  const awning = () => { const p = spot(2.2, 1.5, 2.2); if (p) { b.cyl(0.05, 0.05, 2.0, m.darkwood, p[0] - 1.0, 0, p[1] - 0.6, 6); b.cyl(0.05, 0.05, 2.0, m.darkwood, p[0] + 1.0, 0, p[1] - 0.6, 6); b.cyl(0.04, 0.04, 1.4, m.darkwood, p[0] - 1.0, 0, p[1] + 0.6, 6); b.cyl(0.04, 0.04, 1.4, m.darkwood, p[0] + 1.0, 0, p[1] + 0.6, 6); const c = b.box(2.3, 0.07, 1.5, m.shutterRed, p[0], 1.95, p[1]); c.rotation.x = 0.12; } };
  const footing = () => { if (kind === 29) { const W = 4.2 + c.tier * 0.5; b.box(W + 0.5, 0.3, 3.6 + 0.5, m.stone, 0, 0, 0).name = 'optfooting'; return; }   // the watermill's stone footing lies under the house only, never on towards the wheel
    if (kind === 41) { const W = 3.0 + c.tier * 0.3, back = -0.6 - (W + 0.7) / 2; b.box(hutLandX(c.tier) - back, 0.3, 2.6 + 0.7, m.stone, (hutLandX(c.tier) + back) / 2, 0, 0); return; } b.box(hw * 2 + 0.5, 0.3, hd * 2 + 0.5, m.stone, cx, 0, cz); };
  const ring = (rad: number, y: number, h: number, mat: THREE.Material, n = 16) => { for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const p = b.box(2 * Math.PI * rad / n + 0.1, h, 0.35, mat, cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad); p.rotation.y = -a + Math.PI / 2; } };
  const generic = (bit: number) => { if (bit === 0) pole(2.8); else if (bit === 1) { lantern(); lantern(); } else if (bit === 2) awning(); else if (bit === 3) footing(); };
  const has = (n: number) => n === bit;
  switch (kind) {
    case 47:
      if (bit === 0) {
        for (const x of [-2.32, 2.32]) {
          b.box(0.6, 0.46, 0.22, m.darkwood, x, 1.44, -2.45);
          b.box(0.76, 0.12, 0.31, m.wood, x, 1.84, -2.43);
          b.box(0.07, 0.8, 0.08, m.iron, x + 0.22, 0.96, -2.28);
        }
      }
      if (bit === 1) {   // swift horses: a gilded horse weathervane on the ridge and a golden horseshoe over the stalls
        b.cyl(0.04, 0.05, 1.3, m.iron, 0, 4.5, 0, 6); b.box(0.9, 0.22, 0.05, m.gold, 0.15, 5.45, 0); b.box(0.22, 0.4, 0.05, m.gold, 0.5, 5.35, 0); b.box(0.5, 0.1, 0.05, m.iron, -0.55, 5.5, 0);
        for (const s of [-1, 1]) b.box(0.12, 0.5, 0.06, m.gold, s * 0.28, 2.0, 2.72);
        b.box(0.68, 0.12, 0.06, m.gold, 0, 2.0, 2.72);
      }
      if (bit === 2) {   // courier horses: a hitching rail with saddles and a water bucket
        const p = spot(3.2, 0.7, 1.5);
        if (p) {
          for (const dx of [-1.4, 1.4]) b.box(0.14, 1.2, 0.14, m.darkwood, p[0] + dx, 0, p[1]);
          b.box(3.1, 0.12, 0.12, m.darkwood, p[0], 1.0, p[1]);
          const leather = new THREE.MeshStandardMaterial({ color: 0x7a4a26, roughness: 0.9 });
          for (const dx of [-0.7, 0.7]) { b.box(0.6, 0.12, 0.34, leather, p[0] + dx, 1.12, p[1]); b.box(0.5, 0.3, 0.3, leather, p[0] + dx, 0.7, p[1] + 0.25); }
          b.cyl(0.22, 0.17, 0.4, m.wood, p[0] + 1.0, 0, p[1] + 0.5, 10);
        }
      }
      if (bit === 3) {   // warhorses: a training ring with a post and a straw knight to charge at
        const p = spot(3.6, 3.6, 1.7);
        if (p) {
          const n = 12;
          for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, x = p[0] + Math.cos(a) * 1.7, z = p[1] + Math.sin(a) * 1.7; b.box(0.14, 1.1, 0.14, m.darkwood, x, 0, z); const r = b.box(2 * Math.PI * 1.7 / n + 0.05, 0.1, 0.1, m.wood, x, 0.8, z); r.rotation.y = -a - Math.PI / 2; }
          b.cyl(0.07, 0.09, 1.7, m.darkwood, p[0], 0, p[1], 6); b.box(0.8, 0.12, 0.12, m.darkwood, p[0], 1.2, p[1]); b.sphere(0.2, m.hay, p[0], 1.65, p[1]); b.box(0.35, 0.5, 0.2, m.hay, p[0], 0.8, p[1]);
        }
      }
      break;
    case 49:
      if (bit === 0) {   // merchants' hall: a timber hall with a thatched roof, crates and sacks at the door
        const p = spot(3.6, 2.6, 2.9);
        if (p) {
          b.box(3.4, 2.0, 2.4, m.wood, p[0], 0, p[1]); b.gable(3.6, 2.6, 1.1, m.thatch, p[0], 2.0, p[1], 0.3); b.box(1.0, 1.5, 0.1, m.door, p[0], 0, p[1] + 1.22);
          for (let i = 0; i < 3; i++) b.box(0.5, 0.45, 0.5, m.darkwood, p[0] - 1.2 + i * 0.6, 0, p[1] + 1.55);
          b.sphere(0.32, m.hay, p[0] + 1.2, 0.3, p[1] + 1.5);
        }
      }
      if (bit === 1) {   // herald's tower: a tall round tower with a balcony for the trumpeters, a pointed roof and a flag
        const p = spot(2.6, 2.6, 7.4);
        if (p) {
          b.cyl(1.0, 1.25, 6.0, m.stone, p[0], 0, p[1], 14); b.cyl(1.45, 1.45, 0.3, m.darkstone, p[0], 5.0, p[1], 14);
          b.cone(1.2, 2.2, m.slate, p[0], 6.0, p[1], 14); b.box(0.4, 0.8, 0.06, m.glass, p[0], 3.0, p[1] + 1.05);
          for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; b.box(0.12, 0.5, 0.12, m.stone, p[0] + Math.cos(a) * 1.4, 5.3, p[1] + Math.sin(a) * 1.4); }
          b.flag(p[0], 8.0, p[1], 1.8, 1.1);
        }
      }
      if (bit === 2) {   // chancery: a plaster office with a tiled roof, lit windows and a lectern
        const p = spot(3.4, 2.6, 3.0);
        if (p) {
          b.box(3.2, 2.2, 2.4, m.plaster, p[0], 0, p[1]); b.gable(3.2, 2.4, 1.2, m.tile, p[0], 2.2, p[1], 0.3); b.box(0.9, 1.5, 0.1, m.door, p[0], 0, p[1] + 1.22);
          for (const dx of [-1.1, 1.1]) b.box(0.55, 0.6, 0.06, m.glow, p[0] + dx, 1.0, p[1] + 1.23);
          b.box(0.6, 0.1, 0.4, m.darkwood, p[0] - 1.9, 0.9, p[1] + 1.0); b.box(0.1, 0.9, 0.1, m.darkwood, p[0] - 1.9, 0, p[1] + 1.0);
        }
      }
      if (bit === 3) {   // carriage house: an open shed with a garlanded wedding carriage under it
        const p = spot(3.6, 3.0, 2.8);
        if (p) {
          for (const [dx, dz] of [[-1.6, -1.2], [1.6, -1.2], [-1.6, 1.2], [1.6, 1.2]]) b.box(0.16, 2.3, 0.16, m.darkwood, p[0] + dx, 0, p[1] + dz);
          b.gable(3.6, 3.0, 0.9, m.tile, p[0], 2.3, p[1], 0.2);
          const body = new THREE.MeshStandardMaterial({ color: 0xe9e0c8, roughness: 0.7 }), rose = new THREE.MeshStandardMaterial({ color: 0xd9788a, roughness: 0.8 });
          b.box(1.5, 0.5, 0.7, m.darkwood, p[0], 0, p[1]); b.box(1.7, 0.7, 0.9, body, p[0], 0.5, p[1]); b.box(1.8, 0.1, 1.0, m.gold, p[0], 1.15, p[1]); b.box(1.7, 0.18, 0.12, rose, p[0], 0.95, p[1] + 0.48);
          for (const [dx, dz] of [[-0.65, 0.55], [0.65, 0.55], [-0.65, -0.55], [0.65, -0.55]]) { const w = b.cyl(0.3, 0.3, 0.1, m.darkwood, p[0] + dx, 0.3, p[1] + dz, 12); w.rotation.x = Math.PI / 2; }
        }
      }
      break;
    case 0: houseOption(b, bit, c); break;   // house: see houseOption
    case 1: // farm
      if (has(0)) { const p = spot(1.2, 1.2, 2.1, 0); if (p) { b.cyl(0.05, 0.05, 1.9, m.darkwood, p[0], 0, p[1], 6); const arm = b.box(1.2, 0.07, 0.07, m.darkwood, p[0], 1.45, p[1]); arm.rotation.y = 0.4; b.sphere(0.2, m.hay, p[0], 1.95, p[1]); b.pyramid(0.6, 0.6, 0.3, m.darkwood, p[0], 2.1, p[1]); } }
      if (has(1)) for (let i = 0; i < 2; i++) { const p = spot(1.5, 1.5, 1.4); if (p) { b.dome(0.75, m.hay, p[0], 0, p[1], 1.3); b.cone(0.18, 0.5, m.hay, p[0], 0.95, p[1], 6); } }
      if (has(2)) { const f = farmFields(c.tier), fw = f.max.x - f.min.x, fx = (f.min.x + f.max.x) / 2, fz = f.max.z + 0.5, n = Math.ceil(fw / 0.9); for (let i = 0; i <= n; i++) b.box(0.1, 0.9, 0.1, m.darkwood, f.min.x + i * fw / n, 0, fz); b.box(fw, 0.08, 0.06, m.wood, fx, 0.55, fz); b.box(fw, 0.08, 0.06, m.wood, fx, 0.8, fz); }   // (along the front edge of the fields)
      if (has(3)) { const p = spot(3.4, 2.6, 3.4); if (p) { b.box(3.2, 2.0, 2.4, m.wood, p[0], 0, p[1]); b.gable(3.4, 2.6, 1.4, m.thatch, p[0], 2.0, p[1], 0.3); b.box(1.2, 1.6, 0.1, m.door, p[0], 0, p[1] + 1.22); } }
      // second tier: windmill, granary, orchard, bee skeps
      if (has(4)) { const p = spot(2.6, 2.6, 5.4); if (p) { b.cyl(0.9, 1.3, 3.0, m.plaster, p[0], 0, p[1], 10); b.cone(1.1, 1.0, m.thatch, p[0], 3.0, p[1], 10); for (const a of [0.5, 0.5 + Math.PI / 2]) { const bl = b.box(0.22, 3.6, 0.05, m.wood, p[0], 2.6 - 1.8, p[1] + 1.15); bl.rotation.z = a; } b.cyl(0.1, 0.1, 0.4, m.darkwood, p[0], 2.5, p[1] + 1.0, 6).rotation.x = Math.PI / 2; b.box(0.7, 1.1, 0.1, m.door, p[0], 0, p[1] + 1.25); } }
      if (has(5)) { const p = spot(2.2, 1.8, 2.6); if (p) { for (const dx of [-0.8, 0.8]) for (const dz of [-0.55, 0.55]) b.cyl(0.18, 0.22, 0.45, m.stone, p[0] + dx, 0, p[1] + dz, 8); b.box(2.0, 1.2, 1.6, m.wood, p[0], 0.45, p[1]); b.gable(2.2, 1.8, 0.8, m.thatch, p[0], 1.65, p[1], 0.3); b.box(0.6, 0.8, 0.1, m.door, p[0], 0.45, p[1] + 0.82); } }
      if (has(6)) for (let i = 0; i < 3; i++) { const p = spot(1.5, 1.5, 2.6); if (p) { b.cyl(0.1, 0.15, 1.1, m.darkwood, p[0], 0, p[1], 6); b.sphere(0.85, new THREE.MeshStandardMaterial({ color: 0x4f8a3c, roughness: 1 }), p[0], 1.35, p[1]); for (let k = 0; k < 4; k++) b.sphere(0.1, new THREE.MeshStandardMaterial({ color: 0xd8402f }), p[0] + Math.cos(k * 1.6) * 0.7, 1.4 + (k % 2) * 0.35, p[1] + Math.sin(k * 1.6) * 0.7); } }
      if (has(7)) { const p = spot(1.9, 0.9, 1.3); if (p) { b.box(1.8, 0.1, 0.6, m.wood, p[0], 0.55, p[1]); for (const dx of [-0.8, 0.8]) b.box(0.1, 0.55, 0.5, m.darkwood, p[0] + dx, 0, p[1]); for (let k = 0; k < 3; k++) { b.dome(0.28, m.hay, p[0] - 0.55 + k * 0.55, 0.65, p[1], 1.1); b.cyl(0.1, 0.1, 0.1, m.hay, p[0] - 0.55 + k * 0.55, 0.9, p[1], 6); } } }
      break;
    case 3: case 26: { // tower, keep
      const R = Math.max(hw, hd);
      const bit = (n: number) => has(n);
      if (bit(1)) {   // wooden hoardings hang from the parapet, never above the roofs
        const wt = (kind === 26 ? [6.4, 8.9, 11.5, 14.1] : [5.2, 4.6, 7.3, 9.1])[b.t];
        if (kind === 3) { const rr = [1.9, 2.3, 2.3, 2.7][b.t]; ring(rr, wt - 1.7, 1.1, m.wood, 20); ring(rr, wt - 0.6, 0.12, m.darkwood, 20); }
        else { const half = b.t === 0 ? 2.5 : ([5.2, 7.2, 8.4, 9.4][b.t] + 0.8) / 2 + 0.3, len = half * 2 - 0.4; for (const [x, z, rot] of [[0, half, 0], [0, -half, 0], [half, 0, 1], [-half, 0, 1]] as const) { const p1 = b.box(len, 1.1, 0.35, m.wood, x, wt - 1.7, z), p2 = b.box(len, 0.12, 0.45, m.darkwood, x, wt - 0.6, z); if (rot) { p1.rotation.y = p2.rotation.y = Math.PI / 2; } } }
      }
      if (kind === 3 && bit(2)) {   // a spire takes the place of the roof: the same footing, but steep and tall, ending in a gilded tip
        const info = c.slots.get('roof')?.userData.info as { shape: string; w?: number; r?: number; y: number; h: number; flag?: number } | undefined;
        if (info) {
          const h2 = info.h * 2.4 + 1.2, apex = info.y + h2;
          if (info.shape === 'pyramid') b.pyramid(info.w!, info.w!, h2, m.slate, 0, info.y, 0); else b.cone(info.r!, h2, m.slate, 0, info.y, 0, 12);
          b.cone(0.1, 0.7, m.gold, 0, apex - 0.2, 0, 6); b.sphere(0.2, m.gold, 0, apex - 0.28, 0);
          if (info.flag) b.flag(0, apex + 0.3, 0, 2.2);   // (a great tower flies its flag from the spire)
        }
      }
      if (kind === 26 && bit(2)) {
        if (b.t < 2) for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const tx = cx + sx * (hw - 0.2), tz = cz + sz * (hd - 0.2); b.cyl(1.0, 1.1, top + 0.8, m.stone, tx, 0, tz, 12); b.cone(1.3, 1.9, m.slate, tx, top + 0.8, tz, 12); }
        else { const w = [5.2, 7.2, 8.4, 9.4][b.t], wt = [6.4, 8.9, 11.5, 14.1][b.t]; for (const [tx, tz] of [[w / 2 + 0.45, 0], [-w / 2 - 0.45, 0], [0, w / 2 + 0.45], [0, -w / 2 - 0.45]] as const) { b.cyl(0.75, 0.85, wt - 0.6, m.stone, tx, -0.3, tz, 10); b.cone(1.0, 1.5, m.slate, tx, wt - 0.9, tz, 10); } }   // the corners already have towers: these stand halfway along each wall
      }
      if (bit(0)) {
        if (kind === 3) {   // the standard flies from the highest point: the roof's apex, or the tip of the spire when there is one
          const info = c.slots.get('roof')?.userData.info as { y: number; h: number } | undefined, spire = (c.opts & 4) !== 0;
          if (info) b.flag(0, info.y + (spire ? info.h * 2.4 + 1.2 : info.h) - 0.1, 0, 2.6);
        } else b.flag(cx, top, cz, 2.6);
      }
      if (bit(3)) {
        if (kind === 3) {   // fire baskets on the walkway, under the eaves
          const wt = [5.2, 4.6, 7.3, 9.1][b.t], rho = [1.0, 1.5, 1.5, 1.85][b.t];
          for (const a of [0.9, 0.9 + Math.PI]) { const x = Math.cos(a) * rho, z = Math.sin(a) * rho; b.cyl(0.3, 0.2, 0.4, m.iron, x, wt, z, 8); b.cone(0.26, 0.55, m.glow, x, wt + 0.4, z, 8); }
        } else { b.cyl(0.35, 0.22, 0.4, m.iron, cx + 1.0, top, cz, 8); b.cone(0.28, 0.6, m.glow, cx + 1.0, top + 0.4, cz, 8); }
      }
      break;
    }
    case 19: // barracks
      if (has(0)) pole(4.2);
      if (has(1)) for (let i = 0; i < 2; i++) { const p = spot(1.2, 1.2, 2.0); if (p) { b.cyl(0.07, 0.07, 1.7, m.darkwood, p[0], 0, p[1], 6); b.box(1.0, 0.1, 0.1, m.darkwood, p[0], 1.35, p[1]); b.sphere(0.22, m.hay, p[0], 1.85, p[1]); } }
      if (has(2)) { const p = spot(2.4, 0.7, 2.0); if (p) { b.box(2.4, 0.08, 0.3, m.darkwood, p[0], 0.35, p[1]); b.box(2.4, 0.08, 0.3, m.darkwood, p[0], 1.2, p[1]); for (let i = 0; i < 6; i++) { b.cyl(0.03, 0.03, 2.0, m.darkwood, p[0] - 1.0 + i * 0.4, 0, p[1], 5); b.cone(0.07, 0.22, m.iron, p[0] - 1.0 + i * 0.4, 2.0, p[1], 5); } } }
      if (has(3)) { const p = spot(3.4, 2.2, 2.4); if (p) { b.box(3.2, 1.5, 2.0, m.wood, p[0], 0, p[1]); b.gable(3.4, 2.2, 1.0, m.thatch, p[0], 1.5, p[1], 0.3); b.box(0.9, 1.1, 0.1, m.darkwood, p[0], 0, p[1] + 1.02); } }
      // second tier: archery butts, forge shed, watch post, parade ground
      if (has(4)) { const p = spot(3.2, 1.0, 1.9); if (p) for (const dx of [-1.0, 1.0]) { b.box(0.1, 1.3, 0.1, m.darkwood, p[0] + dx - 0.35, 0, p[1]); b.box(0.1, 1.3, 0.1, m.darkwood, p[0] + dx + 0.35, 0, p[1]); b.cyl(0.62, 0.62, 0.14, m.hay, p[0] + dx, 1.0, p[1], 16).rotation.x = Math.PI / 2; b.cyl(0.3, 0.3, 0.16, new THREE.MeshStandardMaterial({ color: 0xc8302a }), p[0] + dx, 1.0, p[1], 16).rotation.x = Math.PI / 2; } }
      if (has(5)) { const p = spot(2.8, 2.2, 2.6); if (p) { for (const dx of [-1.2, 1.2]) for (const dz of [-0.9, 0.9]) b.cyl(0.07, 0.07, 2.0, m.darkwood, p[0] + dx, 0, p[1] + dz, 6); b.gable(2.8, 2.2, 0.7, m.tile, p[0], 2.0, p[1], 0.2); b.box(0.7, 0.5, 0.5, m.iron, p[0] - 0.4, 0, p[1]); b.box(0.5, 0.5, 0.5, m.stone, p[0] + 0.7, 0, p[1] - 0.3); b.chimney(p[0] + 1.0, 1.0, p[1] - 0.6, 1.9, m.stone); } }
      if (has(6)) { const p = spot(1.6, 1.6, 4.4); if (p) { for (const dx of [-0.6, 0.6]) for (const dz of [-0.6, 0.6]) b.cyl(0.07, 0.09, 3.0, m.darkwood, p[0] + dx, 0, p[1] + dz, 6); b.box(1.6, 0.14, 1.6, m.wood, p[0], 3.0, p[1]); b.box(1.6, 0.5, 0.06, m.darkwood, p[0], 3.14, p[1] + 0.77); b.box(1.6, 0.5, 0.06, m.darkwood, p[0], 3.14, p[1] - 0.77); b.pyramid(2.0, 2.0, 0.8, m.tile, p[0], 3.9, p[1]); b.box(0.12, 3.0, 0.4, m.wood, p[0] + 0.5, 0, p[1] + 0.95); } }
      if (has(7)) { const p = spot(3.6, 2.2, 2.4); if (p) { b.box(3.4, 0.5, 1.8, m.wood, p[0], 0, p[1]); for (const dx of [-1.5, 0, 1.5]) b.flag(p[0] + dx, 0.5, p[1] - 0.7, 2.2, 0.9); b.box(0.9, 0.7, 0.5, m.darkwood, p[0], 0.5, p[1] + 0.3); } }
      break;
    case 15: // town hall
      if (has(0)) b.flag(cx, top, cz, 3.2);
      if (has(1)) { const castle = c.tier >= 3, x = castle ? 0 : cx + hw * 0.5, z = castle ? -9.0 : cz, y = castle ? 11.4 : surf(x, cz) - 0.1; b.box(1.0, 1.0, 1.0, m.stone, x, y, z); b.pyramid(1.3, 1.3, 1.0, m.slate, x, y + 1.0, z); b.cyl(0.18, 0.2, 0.4, m.gold, x, y + 0.3, z, 8); }
      if (has(2)) { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.1, 20), m.gold); d.rotation.x = Math.PI / 2; (b as unknown as { g: THREE.Group }).g.add(d); if (c.tier >= 3) d.position.set(0, 5.0, 24.95); else d.position.set(cx, Math.min(top - 0.8, 5.5), all.max.z + 0.04); d.castShadow = true; }
      if (has(3)) for (let i = 0; i < 4; i++) { const p = spot(2.6, 0.7, 0.7); if (p) { b.box(2.6, 0.7, 0.7, new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 1 }), p[0], 0, p[1]); b.sphere(0.12, new THREE.MeshStandardMaterial({ color: 0xe04a5a }), p[0], 0.8, p[1]); } }
      break;
    case 17: // chapel
      if (has(0)) { const bz = c.tier < 3 ? cz + 3.2 / 2 + 0.45 * c.tier - 0.3 : cz; b.box(1.3, 3.0, 1.3, m.stone, all.max.x - 0.2, 0, bz); b.pyramid(1.8, 1.8, 1.5, m.slate, all.max.x - 0.2, 3.0, bz); }   // (a corner bell tower, so the round window has the end wall to itself)
      // (the chapel's own numbers: its nave, walls and gable, as in the `chapel` model - the whole-model box also holds the towers and would put these in the air)
      if (has(1)) { const t = c.tier, nave = 5 + t * 1.6, nw = 3.2 + t * 0.9, nh = 2.8 + t * 0.9, xm = -nave / 2 + 1.6 + 0.5 * (nave - 2.4) / (1 + t); for (const z of [-1, 1]) { b.box(0.5, 1.1, 0.1, m.stained, xm, nh * 0.55 - 0.55, z * (nw / 2 + 0.02)); b.box(0.74, 0.08, 0.2, m.stoneMat, xm, nh * 0.55 - 0.63, z * (nw / 2 + 0.06)); } }
      if (has(2)) for (let i = 0; i < 5; i++) { const p = spot(0.5, 0.2, 0.8); if (p) b.box(0.45, 0.8, 0.14, m.stone, p[0], 0, p[1]); }
      if (has(3)) { const p = spot(2.2, 1.2, 2.3); if (p) { b.box(0.22, 2.0, 0.22, m.darkwood, p[0] - 1, 0, p[1]); b.box(0.22, 2.0, 0.22, m.darkwood, p[0] + 1, 0, p[1]); b.gable(2.4, 1.4, 0.8, m.tile, p[0], 2.0, p[1], 0.2); } }
      // second tier: rose window, cloister, almshouse, relic shrine
      if (has(4)) {   // a great round window: on the roof's east end above the door, or on the front tower of the grandest chapel
        const t = c.tier, nave = 5 + t * 1.6, nh = 2.8 + t * 0.9, gh = 1.6 + t * 0.6, tw = 2 + t * 0.4, th = 5 + t * 1.4;
        const r = t === 3 ? 0.7 : Math.min(0.74, 0.3 * gh), x = t === 3 ? nave / 2 - 0.1 + tw + 0.04 : nave / 2 + 0.4 + 0.5 + 0.04, y = t === 3 ? th * 0.62 : nh + 0.4 * gh;
        b.cyl(r + 0.14, r + 0.14, 0.08, m.stone, x, y, 0, 20).rotation.z = Math.PI / 2; b.cyl(r, r, 0.12, m.stained, x + 0.02, y, 0, 20).rotation.z = Math.PI / 2;
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, sp = b.box(0.05, 0.05, r * 1.9, m.stone, x + 0.1, y, 0); sp.rotation.x = a; }
      }
      if (has(5)) { const p = spot(3.6, 1.6, 2.4); if (p) { for (const dx of [-1.6, -0.55, 0.55, 1.6]) b.cyl(0.1, 0.12, 1.9, m.stone, p[0] + dx, 0, p[1] + 0.6, 8); b.box(3.6, 0.2, 0.2, m.stone, p[0], 1.9, p[1] + 0.6); b.box(3.6, 0.5, 0.3, m.stone, p[0], 0, p[1] - 0.65); b.gable(3.6, 1.7, 0.6, m.tile, p[0], 2.1, p[1], 0.1); } }
      if (has(6)) { const p = spot(3.4, 2.2, 2.6); if (p) { b.box(3.2, 1.5, 2.0, m.plaster, p[0], 0, p[1]); b.gable(3.4, 2.2, 1.0, m.tile, p[0], 1.5, p[1], 0.3); b.box(0.7, 1.1, 0.1, m.door, p[0] - 0.8, 0, p[1] + 1.02); b.window(p[0] + 0.7, 0.85, p[1] + 1.03, 0, 0.5, 0.5); } }
      if (has(7)) { const p = spot(1.3, 1.3, 1.9); if (p) { b.box(1.2, 0.5, 1.2, m.stone, p[0], 0, p[1]); b.box(0.8, 0.45, 0.5, m.gold, p[0], 0.5, p[1]); b.pyramid(0.95, 0.65, 0.4, m.gold, p[0], 0.95, p[1]); b.box(0.12, 0.2, 0.12, m.glow, p[0] + 0.5, 0.5, p[1] + 0.4); } }
      break;
    case 16: // well
      if (has(0)) b.gable(2.6, 2.4, 0.9, b.t >= 1 ? m.tile : m.thatch, cx, 2.4, cz, 0.25);   // the roof over the well (the posts are already there)
      if (has(1)) { const p = spot(1.4, 0.6, 0.5); if (p) b.box(1.4, 0.45, 0.6, m.stone, p[0], 0, p[1]); }
      break;
    case 23: // drawbridge
      if (has(0)) for (const s of [-1, 1]) b.flag(cx + s * (hw - 0.4), 0, cz + hd + 0.5, 2.6);
      if (has(1)) for (const s of [-1, 1]) { b.cyl(0.05, 0.06, 1.5, m.darkwood, cx + s * (hw - 0.4), 0, cz - hd - 0.5, 6); b.box(0.24, 0.3, 0.24, m.glow, cx + s * (hw - 0.4), 1.45, cz - hd - 0.5); }
      break;
    case 35: // port
      if (has(3)) portFooting(b, m.stoneMat, 0.65);
      else generic(bit);
      break;
    case 39: { // hospital: herb garden, quarantine ward, chapel ward, banner
      if (has(0)) { const p = spot(4.2, 3.0, 1.0); if (p) { b.box(4.2, 0.45, 0.12, m.stone, p[0], 0, p[1] - 1.5); b.box(4.2, 0.45, 0.12, m.stone, p[0], 0, p[1] + 1.5); for (const x of [-2.1, 2.1]) b.box(0.12, 0.45, 3.1, m.stone, p[0] + x, 0, p[1]); const g2 = new THREE.MeshStandardMaterial({ color: 0x5a9a3a, roughness: 0.9 }); for (let i = 0; i < 3; i++) { b.box(1.0, 0.22, 2.4, m.earth, p[0] - 1.3 + i * 1.3, 0, p[1]); for (let k = 0; k < 4; k++) b.sphere(0.2, g2, p[0] - 1.3 + i * 1.3, 0.4, p[1] - 0.9 + k * 0.6); } } }
      if (has(1)) { const p = spot(3.4, 2.6, 2.4); if (p) { b.box(3.2, 1.9, 2.4, m.plaster, p[0], 0, p[1]); b.gable(3.4, 2.6, 1.1, m.tile, p[0], 1.9, p[1], 0.3); b.box(0.9, 1.4, 0.1, m.door, p[0], 0, p[1] + 1.22); for (let i = -1; i <= 1; i += 2) b.box(0.08, 1.0, 0.08, m.darkwood, p[0] + i * 1.9, 0, p[1] + 1.7); b.flag(p[0] - 1.5, 1.9, p[1] - 1.0, 1.4); } }
      if (has(2)) { const p = spot(2.4, 2.4, 3.0); if (p) { b.box(2.2, 2.0, 2.2, m.stone, p[0], 0, p[1]); b.pyramid(2.6, 2.6, 1.3, m.slate, p[0], 2.0, p[1]); b.box(0.12, 1.0, 0.12, m.gold, p[0], 3.3, p[1]); b.box(0.6, 0.12, 0.12, m.gold, p[0], 3.9, p[1]); } }
      if (has(3)) { const p = spot(0.5, 0.5, 3.4); if (p) b.flag(p[0], 0, p[1], 3.4); }
      break;
    }
    case 40: { // graveyard: chapel of rest, memorial cross, yews, charnel house
      if (has(0)) { const p = spot(3.0, 2.4, 2.8); if (p) { b.box(2.8, 1.8, 2.2, m.stone, p[0], 0, p[1]); b.gable(2.8, 2.2, 1.0, m.slate, p[0], 1.8, p[1], 0.25); b.box(0.8, 1.3, 0.1, m.door, p[0], 0, p[1] + 1.12); b.box(0.1, 0.9, 0.1, m.gold, p[0], 2.6, p[1]); b.box(0.5, 0.1, 0.1, m.gold, p[0], 3.05, p[1]); } }
      if (has(1)) { const p = spot(1.2, 1.2, 4.2); if (p) { b.box(1.2, 0.5, 1.2, m.stone, p[0], 0, p[1]); b.box(0.7, 0.5, 0.7, m.stone, p[0], 0.5, p[1]); b.box(0.28, 3.0, 0.28, m.stone, p[0], 1.0, p[1]); b.box(1.3, 0.28, 0.28, m.stone, p[0], 2.3, p[1]); } }
      if (has(2)) { const leaf = new THREE.MeshStandardMaterial({ color: 0x23472a, roughness: 0.95 }); for (let i = 0; i < 2; i++) { const p = spot(2.0, 2.0, 3.4); if (p) { b.cyl(0.2, 0.3, 1.6, m.log, p[0], 0, p[1], 7); b.cone(1.0, 3.0, leaf, p[0], 0.9, p[1], 9); } } }
      if (has(3)) { const p = spot(2.4, 1.8, 1.8); if (p) { b.box(2.2, 1.2, 1.6, m.darkstone, p[0], 0, p[1]); b.gable(2.4, 1.8, 0.7, m.slate, p[0], 1.2, p[1], 0.2); b.box(0.7, 0.9, 0.1, m.door, p[0], 0, p[1] + 0.84); }
      }
      break;
    }
    case 44: { // plaza: benches, trees, a fountain, lanterns (at fixed places, clear of the roads that come in at the middle of each side)
      const leaf = new THREE.MeshStandardMaterial({ color: 0x4a8a38, roughness: 0.95 });
      if (has(0)) for (const [x, z, r] of [[0, 4.3, 0], [0, -4.3, Math.PI], [4.3, 0, Math.PI / 2], [-4.3, 0, -Math.PI / 2]] as const) for (const o of [-2.6, 2.6]) { const px = x ? x : o, pz = z ? z : o; const bn = b.box(1.4, 0.12, 0.45, m.wood, px, 0.4, pz); bn.rotation.y = r; const bk = b.box(1.4, 0.4, 0.08, m.wood, px + (x ? Math.sign(x) * 0.2 : 0), 0.5, pz + (z ? Math.sign(z) * 0.2 : 0)); bk.rotation.y = r; b.box(0.12, 0.4, 0.12, m.stone, px, 0, pz); }
      if (has(1)) for (const sx of [-1, 1]) for (const sz of [-1, 1]) { b.cyl(0.2, 0.28, 1.8, m.log, sx * 3.9, 0, sz * 3.9, 7); b.sphere(1.3, leaf, sx * 3.9, 2.4, sz * 3.9); }
      if (has(2)) { b.cyl(1.7, 1.8, 0.45, m.stone, 0, 0.3, 0, 20); b.cyl(1.45, 1.45, 0.12, new THREE.MeshStandardMaterial({ color: 0x4a8ab0, roughness: 0.15 }), 0, 0.7, 0, 20); b.cyl(0.18, 0.24, 1.4, m.stone, 0, 0.7, 0, 8); b.sphere(0.34, m.stone, 0, 2.2, 0); }   // (it stands on the medallion, not through it)
      if (has(3)) for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const s of [-1, 1]) { const px = x ? x * 5.3 : s * 1.5, pz = z ? z * 5.3 : s * 1.5; b.cyl(0.05, 0.06, 1.5, m.darkwood, px, 0.8, pz, 6); b.box(0.24, 0.3, 0.24, m.glow, px, 2.3, pz); b.pyramid(0.34, 0.34, 0.2, m.iron, px, 2.6, pz); }
      break;
    }
    case 28: // market: the four common options, then (second tier) a weigh house, striped canopies, a market cross and a guild sign
      if (bit < 4) generic(bit);
      if (has(4)) { const p = spot(2.4, 1.9, 2.8); if (p) { b.box(2.2, 1.5, 1.7, m.plaster, p[0], 0, p[1]); b.gable(2.4, 1.9, 0.9, m.tile, p[0], 1.5, p[1], 0.25); b.cyl(0.05, 0.05, 1.6, m.darkwood, p[0], 0, p[1] + 1.05, 6); b.box(1.2, 0.07, 0.07, m.iron, p[0], 1.6, p[1] + 1.05); for (const dx of [-0.55, 0.55]) b.cyl(0.22, 0.22, 0.05, m.iron, p[0] + dx, 1.1, p[1] + 1.05, 10); } }
      if (has(5)) for (let i = 0; i < 2; i++) { const p = spot(2.2, 1.6, 2.2); if (p) { for (const dx of [-1.0, 1.0]) for (const dz of [-0.7, 0.7]) b.cyl(0.05, 0.05, 2.0, m.darkwood, p[0] + dx, 0, p[1] + dz, 6); for (let k = 0; k < 6; k++) b.box(0.36, 0.08, 1.6, new THREE.MeshStandardMaterial({ color: k % 2 ? 0xf0ead8 : (i ? 0x2f5fa8 : 0xc8302a), roughness: 0.9 }), p[0] - 0.9 + k * 0.36, 2.0, p[1]); b.box(1.8, 0.6, 0.5, m.wood, p[0], 0, p[1] + 0.3); } }
      if (has(6)) { const p = spot(1.5, 1.5, 2.8); if (p) { b.box(1.5, 0.25, 1.5, m.stone, p[0], 0, p[1]); b.box(1.1, 0.25, 1.1, m.stone, p[0], 0.25, p[1]); b.box(0.4, 1.8, 0.4, m.stone, p[0], 0.5, p[1]); b.box(1.2, 0.35, 0.35, m.stone, p[0], 1.7, p[1]); b.box(0.35, 0.9, 0.35, m.stone, p[0], 1.9, p[1]); } }
      if (has(7)) { const p = spot(1.4, 0.6, 3.0); if (p) { b.cyl(0.07, 0.09, 3.0, m.darkwood, p[0] - 0.6, 0, p[1], 6); b.box(1.3, 0.1, 0.1, m.darkwood, p[0], 2.8, p[1]); b.box(0.9, 0.6, 0.06, m.gold, p[0] + 0.1, 2.15, p[1]); b.box(0.1, 0.1, 0.1, m.iron, p[0] - 0.25, 2.75, p[1]); b.box(0.1, 0.1, 0.1, m.iron, p[0] + 0.45, 2.75, p[1]); } }
      break;
    default: for (let bit = 0; bit < OPT_BITS; bit++) if (has(bit)) generic(bit);
  }
}

// ---------- scene sync ----------
interface Item { sig: string; opt: number; tier: number; rotation: number; model?: BuildingModel; group: THREE.Group; status: number; pop?: number; cell: string; build?: Construction; shoreClearance?: number }
interface BuildingBatch {
  original: { mesh: THREE.Mesh; parent: THREE.Object3D; group: THREE.Group }[];
  merged: THREE.Mesh[];
  bounds: THREE.Box3;
  detail: boolean;
  /** Seen from far away: the houses of the square are drawn as the simple proxies of `farHouses` instead of their models. */
  far: boolean;
}

/** A building going up: it is cut into storeys that rise out of the ground one after another as the builders get to them, inside a scaffold that climbs with them. Purely visual: the
 *  building exists in the game at once. */
interface Construction {
  t: number; dur: number; top: number; scaffold: THREE.Group; w: number; d: number; level: number;
  bands: { holder: THREE.Group; y0: number; shown: boolean; grow: number }[];
  whole: { m: THREE.Object3D; y0: number }[];   // parts that are not cut (they move, or are single things), shown once the builders reach their foot
  original: THREE.Mesh[];                       // the real meshes, hidden while the storeys stand in for them
}
/** Cut a geometry into horizontal slices by the height of each triangle's middle: [slice index] -> geometry (in the same coordinates). */
function sliceByHeight(geo: THREE.BufferGeometry, bandOf: (y: number) => number, bands: number): (THREE.BufferGeometry | null)[] {
  const pos = geo.attributes.position, idx = geo.index, names = Object.keys(geo.attributes), tris = (idx ? idx.count : pos.count) / 3;
  const out: number[][][] = Array.from({ length: bands }, () => names.map(() => []));
  const get = (k: number) => (idx ? idx.getX(k) : k);
  for (let t = 0; t < tris; t++) {
    const i0 = get(t * 3), i1 = get(t * 3 + 1), i2 = get(t * 3 + 2), y = (pos.getY(i0) + pos.getY(i1) + pos.getY(i2)) / 3, b = bandOf(y), arrs = out[b];
    names.forEach((n, k) => { const at = geo.attributes[n]; for (const i of [i0, i1, i2]) for (let c = 0; c < at.itemSize; c++) arrs[k].push(at.array[i * at.itemSize + c]); });
  }
  return out.map(arrs => {
    if (!arrs[0].length) return null;
    const g = new THREE.BufferGeometry();
    names.forEach((n, k) => { const at = geo.attributes[n]; g.setAttribute(n, new THREE.BufferAttribute(new (at.array.constructor as new (a: number[]) => ArrayLike<number> & ArrayBufferView)(arrs[k]) as never, at.itemSize, at.normalized)); });
    return g;
  });
}
const SCAFFOLD_WOOD = new THREE.MeshStandardMaterial({ color: 0x8a6a3e, roughness: 0.95 });
const SCAFFOLD_POLE = new THREE.BoxGeometry(0.14, 1, 0.14), SCAFFOLD_PLANK = new THREE.BoxGeometry(1, 0.1, 0.5), SCAFFOLD_BEAM = new THREE.BoxGeometry(1, 0.1, 0.1);
/** Kinds that are put up piece by piece or are only ground work: no scaffold for these. */
const NO_SCAFFOLD = new Set([2, 21, 22, 24, 32, 33, 34, 37, 38, 23]);
/** Static parts are merged per square of this many units, so a change re-merges one square (not the whole village) and the GPU can skip squares that are off screen. */
const CELL = 36;
const cellOf = (x: number, z: number) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

/** Beyond this many times the detail range a square draws its houses as simple proxies (`farHouses`). */
const FAR_RANGE = 1.8;
/** What a house looks like from far away, as colours: the walls and the roof of each tier (the average of their textures). */
const FAR_HOUSE_COLOURS: [number, number][] = [[0xa58a62, 0xb89952], [0xcdbf9f, 0xaa5536], [0xa8553a, 0x515c6b], [0xa8553a, 0x515c6b]];
let farHouseMat: THREE.MeshStandardMaterial | undefined;
const farHouseGeos: (THREE.BufferGeometry | undefined)[] = [];
/** One house as walls (a box) and a gable roof (a prism): 18 triangles, in the model's own frame, with its colours in the vertices. */
function farHouseGeometry(t: number): THREE.BufferGeometry {
  let geo = farHouseGeos[t]; if (geo) return geo;
  const { w, d, rx, eaveY, h, e, len, ridgeY } = houseGeo(t), pos: number[] = [], col: number[] = [];
  const [wallHex, roofHex] = FAR_HOUSE_COLOURS[t] ?? FAR_HOUSE_COLOURS[0], wall = new THREE.Color(wallHex), roof = new THREE.Color(roofHex);
  const box = new THREE.BoxGeometry(w, eaveY, d).translate(0, eaveY / 2, 0).toNonIndexed(), bp = box.attributes.position;
  for (let i = 0; i < bp.count; i++) { pos.push(bp.getX(i), bp.getY(i), bp.getZ(i)); col.push(wall.r, wall.g, wall.b); }
  box.dispose();
  // the roof: the ridge runs along x (rx) or z, the eaves hang `e` to each side of it and the ends stand at the walls
  const L = len / 2, P = (a: number, y: number, c: number): [number, number, number] => rx ? [a, y, c] : [c, y, a];
  const [a0, a1, b0, b1, r0, r1] = [P(-L, eaveY, -e), P(L, eaveY, -e), P(-L, eaveY, e), P(L, eaveY, e), P(-L, ridgeY, 0), P(L, ridgeY, 0)];
  const mid: [number, number, number] = [0, eaveY + h / 3, 0];
  const tri = (a: number[], b: number[], c: number[]) => {   // wound so that it faces away from the middle of the roof
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const out = (a[0] - mid[0]) * n[0] + (a[1] - mid[1]) * n[1] + (a[2] - mid[2]) * n[2] >= 0;
    for (const q of out ? [a, b, c] : [a, c, b]) { pos.push(q[0], q[1], q[2]); col.push(roof.r, roof.g, roof.b); }
  };
  tri(a0, a1, r1); tri(a0, r1, r0);   // one slope
  tri(b0, b1, r1); tri(b0, r1, r0);   // the other
  tri(a0, b0, r0); tri(a1, b1, r1);   // the two gable ends
  geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return farHouseGeos[t] = geo;
}
/** The houses of one square as a single cheap mesh, for when the square is far away. Null when there are none. */
function farHouses(houses: { g: THREE.Group; tier: number }[]): THREE.Mesh | null {
  if (!houses.length) return null;
  const parts = houses.map(h => { const g = farHouseGeometry(Math.min(3, Math.max(0, h.tier))).clone(); g.applyMatrix4(h.g.matrixWorld); return g; });
  const geo = mergeGeometries(parts); parts.forEach(g => g.dispose()); if (!geo) return null;
  geo.computeBoundingSphere(); geo.computeBoundingBox();
  farHouseMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const mesh = new THREE.Mesh(geo, farHouseMat); mesh.receiveShadow = true;
  return mesh;
}

export class VillageView {
  root = new THREE.Group();
  /** Once nothing has changed for a moment, all static building parts of the village are merged into a few big meshes. */
  batchRoot = new THREE.Group();
  /** Drawbridges are drawn up while a battle is on. */
  raised = false;
  private cells = new Map<string, BuildingBatch>();
  private dirtyCells = new Map<string, { clock: number; real: number }>();
  private clock = 0;
  private animating = new Set<Item>();
  readonly effects = new Set<THREE.Group>();
  /** New buildings pop into place with a little overshoot once the village has finished loading. */
  animateNew = false;
  private items = new Map<number, Item>();
  get isBatched() { return this.dirtyCells.size === 0; }
  constructor(private banner: number, private shoreWater?: (x: number, z: number, rot: number) => number,
    private groundAt?: (x: number, z: number) => number) {}
  private flag: Flag | undefined; private roof = 0;
  private foreign: Flag[] = []; private foreignKey = '';
  private quiet = false;
  /** The flags of the other cities, which the embassy flies on its forecourt. When the set changes, the embassies are drawn again (without their building animation). */
  /** Returns true when an embassy was taken down: the caller must then run `sync` again (the next building change may be a long way off, and until then the embassy would be missing). */
  setForeignFlags(list: Flag[]): boolean {
    const key = list.map(packFlag).join(',');
    if (key === this.foreignKey) return false;
    this.foreignKey = key; this.foreign = list.slice();
    let removed = false;
    for (const [i, it] of [...this.items]) {
      if (it.group.userData.kind !== 49) continue;
      this.unbatch(it.cell); this.endBuild(it); this.dispose(it.group); this.animating.delete(it); this.items.delete(i); this.quiet = true; removed = true;
    }
    return removed;
  }
  /** Change the flag every banner flies (or go back to the plain colour with null): the buildings are rebuilt with it. */
  setFlag(f: Flag | null, color: number) {
    const key = f ? packFlag(f) : 0, old = this.flag ? packFlag(this.flag) : 0;
    if (key === old && color === this.banner) return;
    this.flag = f ?? undefined; this.banner = color; this.roof = f?.roof ?? 0;
    for (const c of this.cells.keys()) this.unbatch(c);
    for (const it of this.items.values()) { this.endBuild(it); this.dispose(it.group); }
    this.items.clear(); this.animating.clear(); this.dirtyCells.clear();
  }
  get bannerColor() { return this.banner; }

  /** flat = World.buildings_flat() (stride 8). Returns discs [x, z, r] that should be cleared of trees. */
  sync(flat: Float32Array, radii: number[], health?: Float32Array, options?: ArrayLike<number>) {
    const n = flat.length / 10, clear: { x: number; z: number; r: number }[] = [];
    // A building is told from the others by what it is (kind, tier, place, turn), not by its index: the core's list shifts when one is pulled down, burnt or lost in a raid, and every later
    // building would otherwise look new and play its build animation again. Each existing item is claimed by a building with the same signature (the one at its old index first).
    const sigAt = (i: number) => `${flat[i * 10]}:${flat[i * 10 + 1]}:${flat[i * 10 + 2]}:${flat[i * 10 + 3]}:${flat[i * 10 + 4]}`;
    const pool = new Map<string, number[]>(), claimed = new Map<number, Item>();
    for (const [j, it] of this.items) { const l = pool.get(it.sig); if (l) l.push(j); else pool.set(it.sig, [j]); }
    const taken = new Set<number>();
    for (let i = 0; i < n; i++) {
      const l = pool.get(sigAt(i)); if (!l?.length) continue;
      const k = l.includes(i) ? i : l[0]; l.splice(l.indexOf(k), 1); taken.add(k); claimed.set(i, this.items.get(k)!);
    }
    // what is left over at an index that still has a building (a changed tier: an upgrade) is rebuilt in place; the rest is gone
    for (const [j, it] of [...this.items]) if (!taken.has(j)) { if (j < n && !claimed.has(j)) claimed.set(j, it); else { this.touch(it.cell); this.endBuild(it); this.dispose(it.group); this.animating.delete(it); } }
    this.items = claimed;
    for (let i = 0; i < n; i++) {
      const [kind, tier, x, z, rot, pad, status] = [flat[i * 10], flat[i * 10 + 1], flat[i * 10 + 2], flat[i * 10 + 3], flat[i * 10 + 4], flat[i * 10 + 5], flat[i * 10 + 6]];
      const opt = options?.[i] ?? 0, sig = `${kind}:${tier}:${x}:${z}:${rot}`;
      const shoreClearance = this.shoreWater && (kind === 29 || kind === 41) ? pad - this.shoreWater(x, z, rot) : undefined;
      let it = this.items.get(i);
      if (it) it.group.userData.idx = i;
      const prevTier = it && it.sig.split(':')[0] === String(kind) && it.sig.split(':')[2] === String(x) ? 1 : 0;   // (same building, new tier: an upgrade, built a little quicker)
      if (it && it.sig === sig && it.opt !== opt && it.model) {
        // only the optional upgrades changed: the bare building stays as it is, and only the new item is built (and drawn up with its own scaffold)
        this.touch(it.cell); this.endBuild(it);
        const { added } = it.model.setOptions(opt); it.opt = opt;
        for (const g of added) if (this.animateNew && !NO_SCAFFOLD.has(kind)) { it.build = this.startBuild(it.group, radii[kind] ?? 3, tier, true, g); break; }
        this.updateEffects(it.group);
      } else if (!it || it.sig !== sig) {
        if (it) { this.touch(it.cell); this.endBuild(it); this.dispose(it.group); this.animating.delete(it); }
        // walls are drawn by the Walls renderer as one connected structure; keep an empty placeholder so indices line up
        const model = PLAIN.has(kind) ? undefined : new BuildingModel(kind, tier, this.banner, Math.floor(Math.abs(x * 7.3 + z * 13.1)), this.flag, true, kind === 49 ? this.foreign : [], this.roof);
        model?.setOptions(opt);
        if (kind === 35 && this.groundAt) model?.fitPortPier(x, z, rot, pad, this.groundAt);
        if (shoreClearance !== undefined) model?.fitShore(shoreClearance);
        const g = model ? model.group : Object.assign(new THREE.Group(), { userData: { smoke: [], spin: [] } });
        g.userData.variant = Math.floor(Math.abs(x * 7.3 + z * 13.1)) % 4;
        g.position.set(x, pad, z); g.rotation.y = rot * Math.PI / 4;
        g.userData.idx = i; g.userData.kind = kind;
        this.root.add(g); it = { sig, opt, tier, rotation: rot, model, group: g, status, cell: cellOf(x, z), shoreClearance };
        this.items.set(i, it); this.touch(it.cell);
        if (this.animateNew && !this.quiet) { if (NO_SCAFFOLD.has(kind) || PLAIN.has(kind)) { g.scale.setScalar(0.02); it.pop = 0; } else it.build = this.startBuild(g, radii[kind] ?? 3, tier, !!prevTier); }
        this.updateEffects(g);
      }
      if (shoreClearance !== undefined && it.shoreClearance !== shoreClearance) {
        this.touch(it.cell);
        this.endBuild(it);
        it.model?.fitShore(shoreClearance);
        it.shoreClearance = shoreClearance;
      }
      if (kind === 35 && this.groundAt && it.model?.fitPortPier(x, z, rot, pad, this.groundAt)) {
        this.touch(it.cell); this.endBuild(it);
      }
      if (it.build || it.pop !== undefined) this.animating.add(it);
      this.status(it, status, pad, health, i);
      clear.push({ x, z, r: kind === 15 ? (tier >= 3 ? 33 : radii[kind] * (1 + 0.2 * tier) * 1.15 + 3.5) : radii[kind] * 1.15 + 3.5 });
    }
    this.quiet = false;
    return clear;
  }

  private updateEffects(g: THREE.Group) {
    if (g.userData.spin.length || g.userData.smoke.length) this.effects.add(g); else this.effects.delete(g);
  }

  /** Most ticks change staffing and damage only, so avoid matching and rebuilding the building roster. */
  syncState(flat: Float32Array, radii: number[], health: Float32Array, options: ArrayLike<number>) {
    for (const [i, it] of this.items) {
      const o = i * 10, g = it.group;
      if (flat[o] !== g.userData.kind || flat[o + 1] !== it.tier || flat[o + 2] !== g.position.x || flat[o + 3] !== g.position.z || flat[o + 4] !== it.rotation || options[i] !== it.opt) {
        this.sync(flat, radii, health, options);
        return;
      }
      this.status(it, flat[o + 6], flat[o + 5], health, i);
    }
  }

  private status(it: Item, status: number, pad: number, health: Float32Array | undefined, i: number) {
    const g = it.group;
    it.status = status; g.userData.status = status;
    if (g.position.y !== pad) { this.touch(it.cell); g.position.y = pad; g.updateMatrix(); }
    if (health) {
      const charred = health[i * 3 + 2] > 0 || (health[i * 3 + 1] > 0 && health[i * 3] / health[i * 3 + 1] < 0.4);
      if (!!g.userData.charred !== charred) { this.touch(it.cell); g.userData.charred = charred; setCharred(g, charred, g.userData.variant ?? 0); }
    }
  }

  /** Cut a new model into storeys and put a scaffold round it: see `Construction`. */
  private startBuild(g: THREE.Group, r: number, tier: number, upgrade: boolean, scope: THREE.Object3D = g): Construction {
    g.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), box = new THREE.Box3(), all = new THREE.Box3(), meshes: THREE.Mesh[] = [];
    scope.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.visible) { box.setFromObject(m); if (!box.isEmpty()) { all.union(box); meshes.push(m); } } });
    const top = Math.max(1.5, all.max.y - g.position.y), w = Math.max(2.2, all.max.x - all.min.x), d = Math.max(2.2, all.max.z - all.min.z);
    const n = Math.max(3, Math.min(14, Math.ceil(top / 1.4))), bandH = top / n, bandOf = (y: number) => Math.max(0, Math.min(n - 1, Math.floor(y / bandH)));
    const bands = Array.from({ length: n }, (_, k) => ({ holder: new THREE.Group(), y0: k * bandH, shown: false, grow: 0 }));
    const whole: { m: THREE.Object3D; y0: number }[] = [], original: THREE.Mesh[] = [];
    for (const m of meshes) {
      box.setFromObject(m);
      if (!m.userData.baked || Array.isArray(m.material)) { m.visible = false; whole.push({ m, y0: box.min.y - g.position.y }); continue; }
      const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));   // into the building's own coordinates
      const slices = sliceByHeight(geo, bandOf, n); geo.dispose();
      slices.forEach((sg, k) => {
        if (!sg) return;
        sg.translate(0, -bands[k].y0, 0);   // each storey grows from its own floor
        const part = new THREE.Mesh(sg, m.material); part.castShadow = m.castShadow; part.receiveShadow = m.receiveShadow; bands[k].holder.add(part);
      });
      m.visible = false; original.push(m);
    }
    for (const b of bands) { b.holder.position.y = b.y0; b.holder.visible = false; b.holder.scale.y = 0.05; g.add(b.holder); }
    const dur = Math.min(9, 2.6 + r * 0.7 + tier * 0.6) * (upgrade ? 0.65 : 1);
    const scaffold = new THREE.Group(); scaffold.position.set((all.max.x + all.min.x) / 2, g.position.y, (all.max.z + all.min.z) / 2);
    this.batchRoot.add(scaffold);   // (not in `root`, whose children are buildings)
    return { t: 0, dur, top, scaffold, w: w + 0.8, d: d + 0.8, level: -1, bands, whole, original };
  }

  private stepBuild(it: Item, dt: number) {
    const b = it.build!; b.t += Math.min(dt, 0.1);
    const p = Math.min(1, b.t / b.dur), ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;   // builders get going, then settle into a pace, then finish off
    const level = ease * (b.top + 0.4);
    for (const q of b.whole) if (!q.m.visible && q.y0 <= level) q.m.visible = true;
    for (const k of b.bands) {
      if (!k.shown && k.y0 <= level) { k.shown = true; k.holder.visible = true; }
      if (k.shown && k.grow < 1) { k.grow = Math.min(1, k.grow + dt / 0.7); const t = k.grow, c1 = 1.2, c3 = c1 + 1; k.holder.scale.y = Math.max(0.05, 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)); }   // each storey rises into place
    }
    // the scaffold: four poles, and a plank walkway all round at every storey that has been reached
    const s = b.scaffold, want = Math.ceil((level + 1.2) / 1.7);
    if (b.level !== want) {
      b.level = want;
      while (s.children.length) { const c = s.children.pop()!; s.remove(c); }
      const h = want * 1.7 + 0.6;
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const pole = new THREE.Mesh(SCAFFOLD_POLE, SCAFFOLD_WOOD); pole.scale.y = h; pole.position.set(sx * b.w / 2, h / 2, sz * b.d / 2); pole.castShadow = true; s.add(pole); }
      for (let k = 1; k <= want; k++) {
        const y = k * 1.7 - 0.3;
        for (const sz of [-1, 1]) { const beam = new THREE.Mesh(SCAFFOLD_BEAM, SCAFFOLD_WOOD); beam.scale.x = b.w; beam.position.set(0, y + 0.55, sz * b.d / 2); s.add(beam); const pl = new THREE.Mesh(SCAFFOLD_PLANK, SCAFFOLD_WOOD); pl.scale.x = b.w; pl.position.set(0, y, sz * b.d / 2); pl.castShadow = true; s.add(pl); }
        for (const sx of [-1, 1]) { const beam = new THREE.Mesh(SCAFFOLD_BEAM, SCAFFOLD_WOOD); beam.scale.x = b.d; beam.rotation.y = Math.PI / 2; beam.position.set(sx * b.w / 2, y + 0.55, 0); s.add(beam); const pl = new THREE.Mesh(SCAFFOLD_PLANK, SCAFFOLD_WOOD); pl.scale.x = b.d; pl.rotation.y = Math.PI / 2; pl.position.set(sx * b.w / 2, y, 0); pl.castShadow = true; s.add(pl); }
      }
    }
    if (p >= 1 && b.bands.every(k => k.grow >= 1)) { this.endBuild(it); this.touch(it.cell); }
  }

  /** Finish (or abandon) a construction: every part shows, the scaffold comes down. */
  private endBuild(it: Item) {
    const b = it.build; if (!b) return;
    for (const q of b.whole) q.m.visible = true;
    for (const m of b.original) m.visible = true;
    for (const k of b.bands) { k.holder.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); k.holder.parent?.remove(k.holder); }
    this.batchRoot.remove(b.scaffold); it.build = undefined;
  }

  /** Something changed in this square: its merged meshes give way to the individual parts again, and it is merged afresh once things have been quiet for a moment. */
  // a cell is merged a moment after it changed: 0.15 s on the village's clock, or 150 ms of real time, whichever comes first (on the village's clock alone, a paused
  // village, or one shown while away, was never merged and drew every building part on its own)
  private touch(cell: string) { this.unbatch(cell); this.dirtyCells.set(cell, { clock: this.clock + 0.15, real: performance.now() + 150 }); }

  /** Call every frame. */
  update(dt: number, camera?: THREE.Vector3, detailRange = Infinity) {
    this.clock += dt;
    for (const it of this.animating) {
      if (it.pop !== undefined) {
        it.pop += dt / 0.6;
        const t = Math.min(1, it.pop), k = 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
        it.group.scale.set(k, Math.max(0.02, k * (1 + 0.1 * Math.sin(t * Math.PI))), k);
        if (t >= 1) { it.group.scale.setScalar(1); it.pop = undefined; this.touch(it.cell); }
      }
      if (it.build) this.stepBuild(it, dt);
      if (!it.build && it.pop === undefined) this.animating.delete(it);
    }
    const now = performance.now();
    for (const [cell, ready] of this.dirtyCells) {
      if (this.clock < ready.clock && now < ready.real) continue;
      this.dirtyCells.delete(cell);
      this.batchCell(cell);
      break;
    }
    if (!camera) return;
    for (const batch of this.cells.values()) {
      const dist = batch.bounds.distanceToPoint(camera);
      const detail = dist <= detailRange * (batch.detail ? 1.1 : 1);
      const far = dist > detailRange * (batch.far ? FAR_RANGE * 0.9 : FAR_RANGE);
      if (detail === batch.detail && far === batch.far) continue;
      batch.detail = detail; batch.far = far;
      for (const mesh of batch.merged) {
        if (mesh.userData.far) { mesh.visible = far; continue; }
        if (mesh.userData.house) mesh.visible = !far;
        mesh.geometry.setDrawRange(0, detail ? Infinity : mesh.userData.structure);
      }
    }
  }

  private batchCell(cell: string) {
    // parts are merged per surface (see foldKey), not per material object: the per-building colour variants differ only in their base colour, which is baked into the
    // vertex colours, so a cell is drawn with a handful of meshes instead of one per variant (469 draws became about 120 in a 287-building village)
    const per = new Map<string, { mat: THREE.Material; folded: boolean; house: boolean; structure: THREE.BufferGeometry[]; details: THREE.BufferGeometry[]; meshes: BuildingBatch['original'] }>();
    const original: BuildingBatch['original'] = [];
    const houses: { g: THREE.Group; tier: number }[] = [];
    for (const it of this.items.values()) {
      if (it.cell !== cell) continue;
      const g = it.group; if (PLAIN.has(g.userData.kind) || g.userData.charred || it.pop !== undefined || it.build) continue;
      g.updateMatrix(); g.matrixAutoUpdate = false; g.updateMatrixWorld(true);
      const isHouse = g.userData.kind === 0; if (isHouse) houses.push({ g, tier: it.tier });
      g.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.userData.baked || !m.visible || Array.isArray(m.material)) return;   // (a part with several materials keeps its own mesh)
        const geo = m.geometry.clone(); geo.applyMatrix4(m.matrixWorld);
        const mat = m.material as THREE.Material;
        const fold = foldKey(mat);
        const folded = fold && bakeColour(geo, mat as THREE.MeshStandardMaterial) ? fold : null;
        const key = (folded ?? mat.uuid) + (isHouse ? '|house' : '');   // (the parts of houses are merged apart from the rest: from afar they give way to `farHouses`)
        let parts = per.get(key);
        if (!parts) per.set(key, parts = { mat: folded ? foldedMaterial(folded, mat as THREE.MeshStandardMaterial) : mat, folded: !!folded, house: isHouse, structure: [], details: [], meshes: [] });
        (m.userData.detail ? parts.details : parts.structure).push(geo);
        const entry = { mesh: m, parent: m.parent!, group: g };
        parts.meshes.push(entry); original.push(entry);   // (`original` keeps the scene order: unbatching puts the parts back in it)
      });
    }
    if (!original.length) return;
    const unmerged = new Set<THREE.Mesh>(), merged: THREE.Mesh[] = [], bounds = new THREE.Box3();
    for (const parts of per.values()) {
      const mat = parts.mat;
      const geos = sameLayout([...parts.structure, ...parts.details], parts.folded);
      // the draw range that leaves the details out from afar: indices when the merged geometry is indexed, vertices when not
      const structure = geos.slice(0, parts.structure.length).reduce((count, g) => count + (g.index ? g.index.count : g.attributes.position.count), 0);
      // a batch that cannot be merged leaves its parts where they are (they used to be taken out with the rest and vanished)
      const geo = mergeGeometries(geos); geos.forEach(x => x.dispose());
      if (!geo) { for (const p of parts.meshes) unmerged.add(p.mesh); continue; }
      geo.computeBoundingSphere(); geo.computeBoundingBox(); bounds.union(geo.boundingBox!);
      const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true; mesh.castShadow = structure > 0;
      mesh.userData.structure = structure; mesh.matrixAutoUpdate = false; if (parts.house) mesh.userData.house = true;
      this.batchRoot.add(mesh); merged.push(mesh);
    }
    if (!merged.length) return;
    const proxy = farHouses(houses.filter(h => h.g.userData.kind === 0 && !unmerged.size));
    if (!proxy) for (const m of merged) delete m.userData.house;   // (no proxy to stand in for them: the houses stay drawn)
    if (proxy) { proxy.visible = false; proxy.matrixAutoUpdate = false; proxy.userData.far = true; this.batchRoot.add(proxy); merged.push(proxy); }
    const taken = unmerged.size ? original.filter(o => !unmerged.has(o.mesh)) : original;
    for (const { mesh, parent } of taken) parent.remove(mesh);
    this.cells.set(cell, { original: taken, merged, bounds, detail: true, far: false });
  }

  private unbatch(cell: string) {
    const c = this.cells.get(cell); if (!c) return;
    for (const { mesh, parent } of c.original) parent.add(mesh);
    for (const m of c.merged) { this.batchRoot.remove(m); m.geometry.dispose(); }
    this.cells.delete(cell);
  }
  private dispose(g: THREE.Group) { this.effects.delete(g); (g.userData.model as BuildingModel | undefined)?.dispose(); this.root.remove(g); g.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  groupOf(i: number) { return this.items.get(i)?.group; }
  pick(ray: THREE.Raycaster): number | null { return this.pickHit(ray)?.idx ?? null; }
  pickHit(ray: THREE.Raycaster): { idx: number; d: number } | null {
    let result: { idx: number; d: number } | null = null;
    for (const hit of ray.intersectObjects(this.root.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.idx === undefined) o = o.parent;
      if (o) { result = { idx: o.userData.idx, d: hit.distance }; break; }
    }
    const hits: THREE.Intersection[] = [];
    for (const { original, bounds } of this.cells.values()) {
      if (!ray.ray.intersectsBox(bounds)) continue;
      for (const { mesh, group } of original) {
        hits.length = 0;
        mesh.raycast(ray, hits);
        for (const hit of hits) if (!result || hit.distance < result.d) result = { idx: group.userData.idx, d: hit.distance };
      }
    }
    return result;
  }
}

export class Effects {
  group = new THREE.Group();
  private smoke = new Particles(700, false, 0, 0, 220);
  private acc = 0;
  private v = new THREE.Vector3();

  constructor() {
    this.smoke.points.renderOrder = 0;
    this.group.add(this.smoke.points);
  }

  warm(on: boolean) { this.smoke.warm(on); }

  update(dt: number, t: number, views: VillageView[], x: number, z: number, range: number, visible?: EffectView) {
    this.acc += dt;
    const emit = this.group.visible && this.acc >= 0.28;
    if (this.acc >= 0.28) this.acc %= 0.28;
    const range2 = range * range;
    for (const view of views) for (const g of view.effects) {
      if ((g.position.x - x) ** 2 + (g.position.z - z) ** 2 > range2) continue;
      const sp: THREE.Object3D[] = g.userData.spin;
      for (const o of sp) {
        if (o.parent === g || o.parent?.parent === g || o.parent?.parent?.parent === g) {
          if (o.userData.gate) { o.rotation.y += ((view.raised ? 0 : o.userData.open) - o.rotation.y) * (1 - Math.exp(-dt * 2)); continue; }   // the castle's gate doors: shut in a battle
          if (o.userData.deck) { o.rotation.x += ((drawnUp(g.userData.status, view.raised) ? -1.3 : 0) - o.rotation.x) * (1 - Math.exp(-dt * 2)); continue; }
          if ((o as THREE.Mesh).geometry && (o as THREE.Mesh).geometry.type === 'PlaneGeometry') o.rotation.y = Math.sin(t * 3 + g.position.x) * 0.25;
          else o.rotation.z += dt * 0.5 * (g.userData.status === 0 || g.userData.kind === 1 ? 1 : 0.15);
        }
      }
      if (emit && g.userData.status === 0) {
        for (const s of g.userData.smoke as THREE.Vector3[]) {
          this.v.copy(s).applyEuler(g.rotation).add(g.position);
          const { x, y, z } = this.v;
          if (visible && !visible.includes(x, y + 4, z, 10)) continue;
          this.smoke.emit(x + (Math.random() - 0.5) * 0.2, y, z + (Math.random() - 0.5) * 0.2,
            0.25 + Math.random() * 0.3, 0.9 + Math.random() * 0.5, (Math.random() - 0.5) * 0.3, 5, 0.8, 5.3, 0.62, 0.6, 0.58, 0.5);
        }
      }
    }
    this.smoke.update(dt);
  }
}

/** Look for parts that do not belong: a part hanging in the air (nothing under it) or one buried inside another of the same material (a roof drawn twice). Used by the test hall. */
export function auditModel(kind: number, tier: number, opts: number) {
  const g = buildModel(kind, tier, 0x2f5fa8, 1, opts, undefined, false); g.updateMatrixWorld(true);
  const parts: { box: THREE.Box3; mat: THREE.Material; type: string }[] = [];
  g.traverse(o => { const m = o as THREE.Mesh; if (!m.isMesh || Array.isArray(m.material)) return; const box = new THREE.Box3().setFromObject(m); if (!box.isEmpty()) parts.push({ box, mat: m.material, type: m.geometry.type.replace('Geometry', '') }); });
  const vol = (b: THREE.Box3) => Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
  const out: string[] = [], f = (b: THREE.Box3) => `[${b.min.x.toFixed(1)},${b.min.y.toFixed(1)},${b.min.z.toFixed(1)}..${b.max.x.toFixed(1)},${b.max.y.toFixed(1)},${b.max.z.toFixed(1)}]`;
  parts.forEach((p, i) => {
    const sz = p.box.getSize(new THREE.Vector3()); if (p.type === 'Plane' || sz.x * sz.y * sz.z < 0.9) return;   // flags, bars, shutters and the like hang from things on purpose
    if (p.box.min.y > 0.5) {   // is anything touching its underside?
      const under = parts.some((q, j) => j !== i && q.box.max.y >= p.box.min.y - 0.3 && q.box.min.y < p.box.min.y + 0.1 && q.box.max.x > p.box.min.x + 0.05 && q.box.min.x < p.box.max.x - 0.05 && q.box.max.z > p.box.min.z + 0.05 && q.box.min.z < p.box.max.z - 0.05);
      const leaning = parts.some((q, j) => j !== i && q.box.clone().expandByScalar(0.06).intersectsBox(p.box) && Math.min(q.box.max.y, p.box.max.y) - Math.max(q.box.min.y, p.box.min.y) > 0.4);   // hung on a wall
      if (!under && !leaning) out.push(`floats: ${p.type} ${f(p.box)}`);
    }
    if (p.type === 'Cone' || p.type === 'Extrude') parts.forEach((q, j) => {   // two roofs stacked on one spot
      if (j <= i || (q.type !== 'Cone' && q.type !== 'Extrude')) return;
      const pc = p.box.getCenter(new THREE.Vector3()), qc = q.box.getCenter(new THREE.Vector3()), oy = Math.min(p.box.max.y, q.box.max.y) - Math.max(p.box.min.y, q.box.min.y), hp = p.box.max.y - p.box.min.y, hq = q.box.max.y - q.box.min.y;
      if (Math.hypot(pc.x - qc.x, pc.z - qc.z) < 0.7 && oy > 0.35 * Math.min(hp, hq)) out.push(`stacked roofs: ${p.type} ${f(p.box)} and ${q.type} ${f(q.box)}`);
    });
    parts.forEach((q, j) => { if (j <= i || q.mat !== p.mat || vol(p.box) < 0.5 || vol(q.box) < 0.5) return; const x = p.box.clone().intersect(q.box); if (!x.isEmpty() && vol(x) > 0.7 * Math.min(vol(p.box), vol(q.box)) && p.type === q.type && p.type !== 'Box') out.push(`doubled: ${p.type} ${f(p.box)} with ${f(q.box)}`); });
  });
  return out;
}

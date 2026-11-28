import * as THREE from 'three';
import { addSnow } from './snow';
import { freeze, freezeSubtree } from './static';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { trees_in } from '../wasm/game_core.js';
import { HALF, type Terrain } from './terrain';

// ---------------------------------------------------------------------------------------------
// Trees are built the way stylised games do it (see e.g. "fluffy trees with Three.js", bent normals for foliage):
//  * foliage is a cluster of overlapping low-poly clumps, so the silhouette is lumpy and full;
//  * every clump gets *bent normals*, pointing away from the crown centre instead of away from its own faces, so the
//    whole crown shades like one soft, round mass instead of a pile of flat facets;
//  * colour is baked into vertices: dark deep inside and underneath (fake ambient occlusion), bright on top;
//  * near trees use richer geometry, far trees a cheaper version (swapped per tile as the camera moves).
// ---------------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Plain coloured geometry (non-indexed) with a face-axis-projected UV. */
function prep(geo: THREE.BufferGeometry, hex: number) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const p = g.attributes.position, nm = g.attributes.normal, k = 0.8;
  for (let i = 0; i < n; i++) {
    a.set([c.r, c.g, c.b], i * 3);
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), ax = Math.abs(nm.getX(i)), ay = Math.abs(nm.getY(i)), az = Math.abs(nm.getZ(i));
    if (ay >= ax && ay >= az) { uv[i * 2] = x * k; uv[i * 2 + 1] = z * k; } else if (ax >= az) { uv[i * 2] = z * k + 3.1; uv[i * 2 + 1] = y * k; } else { uv[i * 2] = x * k + 7.7; uv[i * 2 + 1] = y * k; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Same point, same wobble: neighbouring faces never tear apart. */
const wobble = (x: number, y: number, z: number, seed: number, amt = 0.17) => 1 + amt * Math.sin(Math.round(x * 40) * 12.9898 + Math.round(y * 40) * 78.233 + Math.round(z * 40) * 37.719 + seed);

/** A lumpy sphere of leaves. */
function clump(r: number, x: number, y: number, z: number, detail: number, sy = 0.88, seed = 0) {
  const g = new THREE.IcosahedronGeometry(r, detail), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const k = wobble(p.getX(i), p.getY(i), p.getZ(i), seed + x * 3.1 + z * 2.7, detail ? 0.2 : 0.16); p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * sy, p.getZ(i) * k); }
  g.translate(x, y, z); g.computeVertexNormals();
  return g;
}

/** Bend normals towards the crown and bake light into the colours: dark inside and below, bright on top. */
function finishFoliage(parts: { geo: THREE.BufferGeometry; color: number }[], centre: THREE.Vector3, R: number, yMin: number, yMax: number, soft = 0.72) {
  const out: THREE.BufferGeometry[] = [];
  for (const { geo, color } of parts) {
    const g = prep(geo, color), p = g.attributes.position, nm = g.attributes.normal as THREE.BufferAttribute, col = g.attributes.color as THREE.BufferAttribute;
    const base = new THREE.Color(color), v = new THREE.Vector3(), n = new THREE.Vector3(), f = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i)); f.set(nm.getX(i), nm.getY(i), nm.getZ(i));
      n.copy(v).sub(centre); const dist = n.length(); n.normalize().multiplyScalar(soft).addScaledVector(f, 1 - soft).normalize();
      nm.setXYZ(i, n.x, n.y, n.z);
      const t = clamp((v.y - yMin) / Math.max(0.01, yMax - yMin), 0, 1), inner = clamp(dist / R, 0, 1.15);
      const shade = (0.5 + 0.62 * t) * (0.62 + 0.5 * inner) * (0.9 + 0.1 * n.y);
      col.setXYZ(i, clamp(base.r * shade, 0, 1.4), clamp(base.g * shade, 0, 1.4), clamp(base.b * shade * 0.96, 0, 1.4));
    }
    out.push(g);
  }
  return out;
}

/** Trunk with a flared base, a little taper and vertical bark streaks. */
function trunk(h: number, r0: number, r1: number, hex: number, lean = 0) {
  const g = new THREE.CylinderGeometry(r1, r0, h, 8, 3, true), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + h / 2, t = y / h, flare = 1 + 0.55 * Math.pow(1 - t, 5), bark = 1 + 0.07 * Math.sin(Math.atan2(p.getZ(i), p.getX(i)) * 7);
    p.setXYZ(i, (p.getX(i) * flare * bark) + lean * t * t, y, p.getZ(i) * flare * bark);
  }
  g.computeVertexNormals();
  const out = prep(g, hex), col = out.attributes.color as THREE.BufferAttribute, pos = out.attributes.position;
  for (let i = 0; i < col.count; i++) { const s = 0.72 + 0.35 * (pos.getY(i) / h) + 0.12 * Math.sin(Math.atan2(pos.getZ(i), pos.getX(i)) * 7); col.setXYZ(i, col.getX(i) * s, col.getY(i) * s, col.getZ(i) * s); }
  return out;
}
const branch = (len: number, r: number, x: number, y: number, rz: number, hex: number) => { const g = new THREE.CylinderGeometry(r * 0.6, r, len, 5, 1, true); g.translate(0, len / 2, 0); g.rotateZ(rz); g.translate(x, y, 0); g.computeVertexNormals(); return prep(g, hex); };

const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts)!;

function oak() {
  const d = 1, centre = new THREE.Vector3(0, 4.0, 0), R = 2.7;
  const clumps = [
    { geo: clump(1.6, 0, 3.8, 0, d, 0.9, 1), color: 0x2f6a2a }, // dark core
    { geo: clump(2.0, 0, 3.95, 0, d, 0.88, 2), color: 0x4f8f3a }, { geo: clump(1.55, 1.3, 3.3, 0.7, d, 0.88, 3), color: 0x5a9a42 }, { geo: clump(1.45, -1.25, 3.4, -0.8, d, 0.88, 4), color: 0x468436 },
    { geo: clump(1.35, 0.2, 5.0, -0.4, d, 0.9, 5), color: 0x66a84c },
    { geo: clump(1.25, -0.5, 3.5, 1.4, d, 0.9, 6), color: 0x52923c }, { geo: clump(1.15, 1.0, 4.4, -1.2, d, 0.9, 7), color: 0x5c9c44 }, { geo: clump(1.0, -1.4, 4.5, 0.4, d, 0.9, 8), color: 0x57973f },
  ];
  return merge([trunk(3.0, 0.5, 0.26, 0x5e4128), branch(1.5, 0.12, 0.2, 2.6, -0.8, 0x5e4128), branch(1.3, 0.1, -0.2, 2.9, 0.9, 0x5e4128), ...finishFoliage(clumps, centre, R, 2.2, 6.0)]);
}

function birch() {
  const d = 1, centre = new THREE.Vector3(0, 4.2, 0), R = 1.9;
  const clumps = [
    { geo: clump(1.0, 0, 4.1, 0, d, 1.15, 1), color: 0x6aa03a },
    { geo: clump(1.3, 0, 4.2, 0, d, 1.1, 2), color: 0x8cbf4e }, { geo: clump(0.95, 0.7, 3.3, 0.3, d, 1.1, 3), color: 0x9acb58 }, { geo: clump(0.95, -0.6, 4.9, -0.2, d, 1.1, 4), color: 0x7fb246 },
    { geo: clump(0.85, -0.5, 3.4, 0.7, d, 1.1, 5), color: 0x93c455 },
  ];
  const stem = trunk(3.7, 0.24, 0.12, 0xe9e5da, 0.1);
  const bandsCol = stem.attributes.color as THREE.BufferAttribute, sp = stem.attributes.position;   // dark papery bark bands
  for (let i = 0; i < bandsCol.count; i++) { const band = Math.sin(sp.getY(i) * 9 + sp.getX(i) * 20) > 0.7 ? 0.35 : 1; bandsCol.setXYZ(i, bandsCol.getX(i) * band, bandsCol.getY(i) * band, bandsCol.getZ(i) * band); }
  return merge([stem, ...finishFoliage(clumps, centre, R, 3.0, 5.6)]);
}

/** Layered skirts with ragged, drooping hems. */
function conifer() {
  const centre = new THREE.Vector3(0, 3.3, 0), R = 2.4, seg = 11;
  const tiers = [[2.3, 2.6, 0.9, 0x2d5a34], [1.9, 2.4, 1.9, 0x346339], [1.5, 2.3, 3.0, 0x3b6c3e], [1.1, 2.1, 4.1, 0x42774a], [0.65, 1.8, 5.1, 0x4a8252]] as const;
  const parts: { geo: THREE.BufferGeometry; color: number }[] = [{ geo: new THREE.ConeGeometry(1.0, 5.0, 8).translate(0, 3.1, 0), color: 0x234a2c }];
  tiers.forEach(([r, h, y, c], ti) => {
    const g = new THREE.ConeGeometry(r, h, seg, 1, true), p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      if (p.getY(k) < 0) { const a = Math.atan2(p.getZ(k), p.getX(k)), wave = Math.sin(a * 5.5 + ti), spike = 1 + 0.2 * wave, droop = -0.28 * (0.5 + 0.5 * wave); p.setXYZ(k, p.getX(k) * spike, p.getY(k) + droop, p.getZ(k) * spike); }
    }
    g.translate(0, y + h / 2 - 0.4, 0); g.computeVertexNormals(); parts.push({ geo: g, color: c });
  });
  return merge([trunk(2.2, 0.36, 0.16, 0x4a3524), ...finishFoliage(parts, centre, R, 0.6, 6.0, 0.55)]);
}

/** Fine leaf-speckle luminance texture, only for close-up detail. */
function foliageTexture() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d')!;
  g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 1100; i++) {
    const x = Math.random() * s, y = Math.random() * s, l = 175 + Math.random() * 80, w = 4 + Math.random() * 6;
    g.fillStyle = `rgb(${l},${l},${l})`; g.save(); g.translate(x, y); g.rotate(Math.random() * 6.28); g.beginPath(); g.ellipse(0, 0, w, w * 0.42, 0, 0, 7); g.fill(); g.restore();
  }
  for (let i = 0; i < 160; i++) { g.fillStyle = 'rgba(15,22,10,0.16)'; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 3 + Math.random() * 6, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

const TILE = 60;
const SECTOR = TILE * 4;
const NEAR_ENTER = 82;
const NEAR_EXIT = 112;
const FAR_ENTER = 300;
const FAR_EXIT = 245;
const VIEW_MARGIN = 12;
export const TREE_SHADOW_LAYER = 1;

type Disc = { x: number; z: number; r: number };
type Trail = { ax: number; az: number; bx: number; bz: number; r: number };
type Bounds = { x0: number; z0: number; x1: number; z1: number };
type Mask = Bounds & { r: number; r2: number } & (
  { kind: 'clear' | 'keep'; x: number; z: number } |
  { kind: 'trail'; ax: number; az: number; dx: number; dz: number; len2: number }
);
type Tree = { x: number; y: number; z: number; type: number; s: number; rot: number; grows: boolean };
type Sector = { x: number; z: number; local: THREE.Group; distant: THREE.Group; batches: Batch[]; merged: Map<number, TreeMesh>; bounds: THREE.Box3; dirty: boolean };
type Tile = { x: number; z: number; sector: Sector; batches: Batch[]; masks: Set<Mask> };
type Batch = { tile: Tile; type: number; ids: number[]; mesh: TreeMesh; shadow: TreeMesh; lod: number; sampleGround: boolean };

/** Instances are already in world coordinates. A box avoids drawing tall tiles or large sectors just outside the view. */
class TreeMesh extends THREE.InstancedMesh {
  override boundingBox = new THREE.Box3();
  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, count: number) {
    super(geometry, material, count);
    this.matrixAutoUpdate = false;
  }
  override intersectsFrustum(frustum: THREE.Frustum) { return frustum.intersectsBox(this.boundingBox); }
}

/** Share smooth vertices in the crown tiers that use no foliage texture. */
function compactTree(parts: THREE.BufferGeometry[]) {
  const geometry = merge(parts);
  geometry.deleteAttribute('uv');
  const indexed = mergeVertices(geometry);
  geometry.dispose();
  parts.forEach(part => part.dispose());
  return indexed;
}

/** Distant crowns retain each species' outline with fewer vertices, no leaf texture and no vertex wind. */
function distantTree(type: number) {
  const shortTrunk = (h: number, r: number, color: number) => prep(new THREE.CylinderGeometry(r * 0.55, r, h, 5, 1, true).translate(0, h / 2, 0), color);
  if (type === 0) {
    const tiers = [[2.35, 3.25, 2.25, 0x2d5a34], [1.75, 3.05, 3.5, 0x38683c], [1.15, 2.55, 4.8, 0x4a8252]];
    const foliage = tiers.map(([r, h, y, color], i) => ({
      color, geo: new THREE.ConeGeometry(r, h, 6, 1, true).rotateY(i * 0.26).translate(0, y, 0),
    }));
    return compactTree([shortTrunk(2.1, 0.32, 0x4a3524), ...finishFoliage(foliage, new THREE.Vector3(0, 3.3, 0), 2.4, 0.6, 6.0, 1)]);
  }
  const oak = type === 1;
  const foliage = oak ? [
    { geo: clump(2.24, 0, 4.03, -0.15, 0, 0.87, 2), color: 0x4f8f3a },
    { geo: clump(1.59, 1.18, 3.52, 0.65, 0, 0.89, 3), color: 0x5a9a42 },
    { geo: clump(1.59, -1.22, 3.69, -0.48, 0, 0.92, 4), color: 0x468436 },
  ] : [
    { geo: clump(1.46, -0.12, 4.28, 0, 0, 1.20, 2), color: 0x8cbf4e },
    { geo: clump(1.08, 0.52, 3.61, 0.25, 0, 1.05, 3), color: 0x9acb58 },
  ];
  return compactTree([shortTrunk(oak ? 3.0 : 3.7, oak ? 0.50 : 0.24, oak ? 0x5e4128 : 0xe9e5da),
    ...finishFoliage(foliage, new THREE.Vector3(0, oak ? 4.0 : 4.2, 0), oak ? 2.7 : 1.9, oak ? 2.2 : 3.0, 6.0, 1)]);
}

/** The simplified silhouette used on the horizon and in the depth-only shadow pass. */
function treeSilhouette(type: number) {
  const oak = type === 1, pine = type === 0;
  const height = pine ? 2.1 : oak ? 3.0 : 3.7, r = pine ? 0.32 : oak ? 0.5 : 0.24;
  const trunk = prep(new THREE.CylinderGeometry(r * 0.6, r, height, 4, 1, true).translate(0, height / 2, 0), oak ? 0x5e4128 : pine ? 0x4a3524 : 0xe9e5da);
  const parts = pine ? [
    { color: 0x32633a, geo: new THREE.ConeGeometry(2.4, 4.5, 5, 1, true).translate(0, 2.7, 0) },
    { color: 0x45794a, geo: new THREE.ConeGeometry(1.45, 3.3, 5, 1, true).rotateY(0.3).translate(0, 4.15, 0) },
  ] : [{ color: oak ? 0x528d3e : 0x8cbc4c, geo: clump(oak ? 2.45 : 1.67, 0, 4.15, 0, 0, oak ? 0.8 : 1.12, 2) }];
  return compactTree([trunk, ...finishFoliage(parts, new THREE.Vector3(0, pine ? 3.3 : 4.15, 0), oak ? 2.7 : 2.3, pine ? 0.6 : 2.2, 6.0, 1)]);
}

export class Forest {
  group = new THREE.Group();
  private tiles = new Map<number, Tile>();
  private sectors = new Map<number, Sector>();
  private shadowGroup = new THREE.Group();
  private shadowTiles = new Set<Tile>();
  private shapes = new Map<string, Mask>();
  private dirty = new Set<Batch>();
  private geos: THREE.BufferGeometry[][];
  private mat: THREE.MeshLambertMaterial;
  private farMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private shadowMat = new THREE.MeshBasicMaterial();
  private uSun = { value: new THREE.Vector3(0, 1, 0) };
  private uDaylight = { value: new THREE.Color(1, 1, 1) };
  private uSkyLight = { value: new THREE.Color(0.2, 0.2, 0.2) };
  private trees: Tree[] = [];
  private uTime = { value: 0 };
  private hidden: Uint8Array;
  private grid = new Map<number, number[]>();
  private camera = new THREE.Vector3(Infinity, Infinity, Infinity);
  private shadowFocus = new THREE.Vector3(Infinity, Infinity, Infinity);
  private shadowRange = -1;
  private viewMatrix = new THREE.Matrix4();
  private viewFrustum = new THREE.Frustum();
  private viewCorner = new THREE.Vector3();
  private projection = new THREE.Matrix4();
  private useFrustum = false;
  private lastDistance = -1;
  private lastDetail = false;

  private static key(cx: number, cz: number) { return cx * 1024 + cz; }

  /** `rawTrees` is the core's tree list, usually built in slices during loading. */
  constructor(seed: bigint, private terrain: Terrain, rawTrees?: Float32Array) {
    const raw = rawTrees ?? trees_in(seed, -HALF, -HALF, HALF, HALF);
    const layouts = new Map<Tile, Map<number, number[]>>();
    for (let i = 0; i < raw.length; i += 5) {
      const x = raw[i], z = raw[i + 1], type = raw[i + 2];
      if (Math.max(Math.abs(x), Math.abs(z)) > HALF - 30) continue;
      const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE), key = Forest.key(tx, tz);
      let tile = this.tiles.get(key);
      if (!tile) {
        const sx = Math.floor(x / SECTOR), sz = Math.floor(z / SECTOR), id = Forest.key(sx, sz);
        let sector = this.sectors.get(id);
        if (!sector) {
          sector = { x: (sx + 0.5) * SECTOR, z: (sz + 0.5) * SECTOR, local: new THREE.Group(), distant: new THREE.Group(), batches: [], merged: new Map(), bounds: new THREE.Box3(), dirty: true };
          sector.distant.visible = false;
          freeze(sector.local, sector.distant);
          this.sectors.set(id, sector);
          this.group.add(sector.local, sector.distant);
        }
        tile = { x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE, sector, masks: new Set(), batches: [] };
        this.tiles.set(key, tile);
        layouts.set(tile, new Map());
      }
      const layout = layouts.get(tile)!;
      let ids = layout.get(type);
      if (!ids) { ids = []; layout.set(type, ids); }
      const id = this.trees.length;
      ids.push(id);
      this.trees.push({ x, z, y: 0, type, s: raw[i + 3], rot: raw[i + 4], grows: false });
      const cell = Forest.key(Math.floor(x / 4), Math.floor(z / 4));
      let treeIds = this.grid.get(cell);
      if (!treeIds) { treeIds = []; this.grid.set(cell, treeIds); }
      treeIds.push(id);
    }
    this.hidden = new Uint8Array(this.trees.length);
    this.geos = [
      [conifer(), distantTree(0), treeSilhouette(0)],
      [oak(), distantTree(1), treeSilhouette(1)],
      [birch(), distantTree(2), treeSilhouette(2)],
    ];
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: foliageTexture() });
    this.mat.onBeforeCompile = sh => {
      sh.uniforms.uTime = this.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        #ifdef USE_INSTANCING
          vec2 ip = instanceMatrix[3].xz;
          float sw = sin(uTime * 1.3 + ip.x * 0.21 + ip.y * 0.17) * 0.035 + sin(uTime * 2.7 + ip.x * 0.5) * 0.012;
          transformed.x += sw * position.y * position.y * 0.18;
          transformed.z += sw * position.y * position.y * 0.1;
        #endif`);
    };
    addSnow(this.mat);   // snow on the crowns in winter (snow.ts; the distant crowns are lit per vertex and stay green)
    // Distant crowns take the sun and sky into account per vertex, without the point-light loop of a lit material.
    this.farMat.onBeforeCompile = sh => {
      sh.uniforms.uForestSun = this.uSun; sh.uniforms.uForestDaylight = this.uDaylight; sh.uniforms.uForestSky = this.uSkyLight;
      sh.vertexShader = 'uniform vec3 uForestSun, uForestDaylight, uForestSky;\n' + sh.vertexShader.replace('#include <color_vertex>', `
        #include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vec3 n = normalize(mat3(instanceMatrix) * normal);
          float sun = max(dot(n, uForestSun), 0.0);
          vColor.rgb *= uForestSky + uForestDaylight * (0.22 + 0.66 * sun);
        #endif`);
    };
    // the forest's containers never move (every instance is in world coordinates): frozen, they no longer force thousands of tree meshes to recompute world matrices every frame
    freeze(this.group, this.shadowGroup);
    this.group.add(this.shadowGroup);
    for (const [tile, layoutsByType] of layouts) for (const [type, ids] of layoutsByType) {
      const mesh = new TreeMesh(this.geos[type][1], this.farMat, ids.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ids.length * 3), 3).setUsage(THREE.DynamicDrawUsage);
      mesh.boundingSphere = new THREE.Sphere();
      const shadow = new TreeMesh(this.geos[type][2], this.shadowMat, 0);
      shadow.instanceMatrix = mesh.instanceMatrix; shadow.boundingSphere = mesh.boundingSphere; shadow.boundingBox = mesh.boundingBox;
      shadow.layers.set(TREE_SHADOW_LAYER); shadow.castShadow = true; shadow.visible = false;
      const batch = { tile, type, ids, mesh, shadow, lod: 1, sampleGround: true };
      tile.batches.push(batch);
      tile.sector.batches.push(batch);
      this.dirty.add(batch);
      tile.sector.local.add(mesh);
    }
    this.terrain.onHeightChange = (x0, z0, x1, z1) => {
      this.eachTile({ x0, z0, x1, z1 }, tile => {
        for (const batch of tile.batches) { batch.sampleGround = true; this.dirty.add(batch); }
      });
    };
    this.rebuild([]);
    freezeSubtree(this.group);   // nothing in the forest ever moves: no need to walk its ~3,900 objects for matrices every frame
  }

  /** Display settings. */
  drawDistance = 1300;
  detail = true;
  shadowVersion = 0;

  setLight(direction: THREE.Vector3, sun: THREE.DirectionalLight, sky: THREE.HemisphereLight) {
    this.uSun.value.copy(direction);
    this.uDaylight.value.copy(sun.color).multiplyScalar(sun.intensity / Math.PI);
    this.uSkyLight.value.copy(sky.color).lerp(sky.groundColor, 0.25).multiplyScalar(sky.intensity / Math.PI);
  }

  tick(t: number, cam?: THREE.Vector3, focus = cam, shadowRange = 145, view?: THREE.Camera) {
    this.uTime.value = t;
    if (this.dirty.size) this.flush(performance.now() + 3);
    if (!cam || !this.group.visible) return;
    const distanceChanged = this.drawDistance !== this.lastDistance;
    const moved = cam.distanceToSquared(this.camera) >= 4;
    const turned = view?.matrixWorldInverse.elements.some((e, i) => i < 12 && Math.abs(e - this.viewMatrix.elements[i]) > 0.018);
    const frustumChanged = !!view !== this.useFrustum || !!view && (turned || !view.projectionMatrix.equals(this.projection));
    if (moved || frustumChanged || distanceChanged || this.detail !== this.lastDetail) {
      this.useFrustum = !!view;
      if (view) {
        this.viewMatrix.copy(view.matrixWorldInverse); this.projection.copy(view.projectionMatrix);
        this.viewFrustum.setFromProjectionMatrix(this.cameraProjection.multiplyMatrices(this.projection, this.viewMatrix));
      }
      this.camera.copy(cam); this.lastDistance = this.drawDistance; this.lastDetail = this.detail;
      for (const sector of this.sectors.values()) this.updateSector(sector);
    }
    if (focus && (focus.distanceToSquared(this.shadowFocus) >= 16 || shadowRange !== this.shadowRange || distanceChanged)) {
      if (shadowRange !== this.shadowRange) this.shadowVersion++;
      this.shadowFocus.copy(focus); this.shadowRange = shadowRange;
      this.shadowGroup.visible = shadowRange > 0;
      this.updateShadows();
    }
  }

  private cameraProjection = new THREE.Matrix4();

  private updateSector(sector: Sector) {
    if (sector.bounds.isEmpty() || !this.sectorInView(sector.bounds, false)) {
      sector.distant.visible = sector.local.visible = false;
      return;
    }
    const dx = Math.abs(sector.x - this.camera.x), dz = Math.abs(sector.z - this.camera.z), span = (SECTOR - TILE) / 2;
    const min = Math.max(0, dx - span) ** 2 + Math.max(0, dz - span) ** 2;
    const max = (dx + span) ** 2 + (dz + span) ** 2, limit = this.drawDistance ** 2;
    let distant = min >= (sector.distant.visible ? FAR_EXIT : FAR_ENTER) ** 2 && max < limit;
    // a far sector across the edge of the view: drawn merged when most of its tiles are on screen (one draw; the off-screen trees are the cheapest kind, a few dozen
    // triangles), tile by tile when most are off it (only the visible tiles are drawn). At a wide view hundreds of edge tiles used to be a draw each.
    if (distant && this.useFrustum && !this.sectorInView(sector.bounds, true)) {
      let shown = 0, total = 0;
      for (const { mesh } of sector.batches) if (mesh.count) { total++; if (this.viewFrustum.intersectsSphere(mesh.boundingSphere!)) shown++; }
      distant = shown * 2 >= total;
    }
    sector.distant.visible = distant;
    sector.local.visible = !distant && min < limit;
    if (distant && sector.dirty) this.mergeSector(sector);
    if (sector.local.visible) for (const batch of sector.batches) this.updateView(batch);
  }

  private sectorInView({ min, max }: THREE.Box3, inside: boolean) {
    if (!this.useFrustum) return true;
    return this.viewFrustum.planes.every(plane => {
      const n = plane.normal;
      this.viewCorner.set((n.x >= 0) === inside ? min.x : max.x, (n.y >= 0) === inside ? min.y : max.y, (n.z >= 0) === inside ? min.z : max.z);
      return plane.distanceToPoint(this.viewCorner) >= (inside ? 0 : -VIEW_MARGIN);
    });
  }

  private updateView(batch: Batch) {
    const { mesh, tile, type } = batch;
    const dx = tile.x - this.camera.x, dz = tile.z - this.camera.z, flat = dx * dx + dz * dz;
    mesh.visible = mesh.count > 0 && flat < this.drawDistance ** 2;
    if (!mesh.visible) return;
    const dy = mesh.boundingSphere!.center.y - this.camera.y, distance = flat + dy * dy;
    const near = this.detail && distance < (batch.lod === 0 ? NEAR_EXIT : NEAR_ENTER) ** 2;
    const far = distance >= (batch.lod === 2 ? FAR_EXIT : FAR_ENTER) ** 2;
    const lod = near ? 0 : far ? 2 : 1;
    if (batch.lod !== lod) {
      batch.lod = lod; mesh.geometry = this.geos[type][lod];
      mesh.material = lod === 0 ? this.mat : this.farMat;
    }
    mesh.receiveShadow = near;
  }

  private updateShadows() {
    const reach = Math.min(this.drawDistance, this.shadowRange);
    const { x, z } = this.shadowFocus, tiles = new Set<Tile>();
    if (reach > 0) this.eachTile({ x0: x - reach, z0: z - reach, x1: x + reach, z1: z + reach }, tile => {
      if ((tile.x - x) ** 2 + (tile.z - z) ** 2 >= reach ** 2) return;
      tiles.add(tile);
      if (!this.shadowTiles.has(tile)) for (const batch of tile.batches) {
        batch.shadow.visible = batch.shadow.count > 0;
        this.shadowGroup.add(batch.shadow);
      }
    });
    for (const tile of this.shadowTiles) if (!tiles.has(tile)) {
      for (const batch of tile.batches) this.shadowGroup.remove(batch.shadow);
    }
    this.shadowTiles = tiles;
  }

  private mergeSector(sector: Sector) {
    for (let type = 0; type < this.geos.length; type++) {
      const batches = sector.batches.filter(batch => batch.type === type);
      if (!batches.length) continue;
      let merged = sector.merged.get(type);
      if (!merged) {
        const capacity = batches.reduce((n, batch) => n + batch.ids.length, 0);
        merged = new TreeMesh(this.geos[type][2], this.farMat, capacity);
        merged.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        merged.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
        merged.boundingSphere = new THREE.Sphere();
        sector.merged.set(type, merged); sector.distant.add(merged);
      }
      let count = 0;
      merged.boundingSphere!.makeEmpty();
      merged.boundingBox.makeEmpty();
      for (const { mesh } of batches) {
        if (!mesh.count) continue;
        merged.instanceMatrix.array.set(mesh.instanceMatrix.array.subarray(0, mesh.count * 16), count * 16);
        merged.instanceColor!.array.set(mesh.instanceColor!.array.subarray(0, mesh.count * 3), count * 3);
        merged.boundingSphere!.union(mesh.boundingSphere!);
        merged.boundingBox.union(mesh.boundingBox);
        count += mesh.count;
      }
      merged.count = count; merged.visible = count > 0;
      this.updateInstances(merged);
    }
    sector.dirty = false;
  }

  /** Standing trees within r of a point (felled and cleared trees do not count). */
  nearTrees(x: number, z: number, r: number, out: { x: number; z: number }[]) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || r > 60) return;
    const c0 = Math.floor((x - r) / 4), c1 = Math.floor((x + r) / 4), d0 = Math.floor((z - r) / 4), d1 = Math.floor((z + r) / 4);
    for (let a = c0; a <= c1; a++) for (let b = d0; b <= d1; b++) {
      const ids = this.grid.get(Forest.key(a, b));
      if (!ids) continue;
      for (const i of ids) {
        if (this.hidden[i]) continue;
        const t = this.trees[i];
        if ((t.x - x) ** 2 + (t.z - z) ** 2 <= r * r) out.push(t);
      }
    }
  }
  countTrees(x: number, z: number, r: number) { const out: { x: number; z: number }[] = []; this.nearTrees(x, z, r, out); return out.length; }

  /** All tree positions, for locating wildlife. */
  get all() { return this.trees; }

  rebuild(clear: Disc[], lines: Trail[] = [], keep: Disc[] = []) {
    this.rebuildLater(clear, lines, keep);
    this.flush(Infinity);
  }

  /** Queue only tiles touched by additions or removals. Unfinished tiles keep their places in the queue. */
  rebuildLater(clear: Disc[], lines: Trail[] = [], keep: Disc[] = []) {
    const next = new Map<string, Mask>();
    const disc = ({ x, z, r }: Disc, kind: 'clear' | 'keep') => {
      const id = `${kind}:${x}:${z}:${r}`;
      next.set(id, this.shapes.get(id) ?? { kind, x, z, r, r2: r * r, x0: x - r, z0: z - r, x1: x + r, z1: z + r });
    };
    clear.forEach(c => disc(c, 'clear'));
    keep.forEach(c => disc(c, 'keep'));
    for (const { ax, az, bx, bz, r } of lines) {
      const id = `trail:${ax}:${az}:${bx}:${bz}:${r}`, dx = bx - ax, dz = bz - az;
      next.set(id, this.shapes.get(id) ?? { kind: 'trail', ax, az, dx, dz, r, r2: r * r, len2: dx * dx + dz * dz || 1,
        x0: Math.min(ax, bx) - r, z0: Math.min(az, bz) - r, x1: Math.max(ax, bx) + r, z1: Math.max(az, bz) + r });
    }
    for (const [id, mask] of this.shapes) if (!next.has(id)) this.updateMask(mask, false);
    for (const [id, mask] of next) if (!this.shapes.has(id)) this.updateMask(mask, true);
    this.shapes = next;
  }

  private eachTile({ x0, z0, x1, z1 }: Bounds, visit: (tile: Tile) => void) {
    const a0 = Math.max(-HALF / TILE, Math.floor(x0 / TILE)), a1 = Math.min(HALF / TILE - 1, Math.floor(x1 / TILE));
    const b0 = Math.max(-HALF / TILE, Math.floor(z0 / TILE)), b1 = Math.min(HALF / TILE - 1, Math.floor(z1 / TILE));
    for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) {
      const tile = this.tiles.get(Forest.key(a, b));
      if (tile) visit(tile);
    }
  }

  private updateMask(mask: Mask, add: boolean) {
    this.eachTile(mask, tile => {
      if (add) tile.masks.add(mask); else tile.masks.delete(mask);
      for (const batch of tile.batches) this.dirty.add(batch);
    });
  }

  private clipped(t: Tree, masks: Set<Mask>) {
    let cleared = false, kept = false;
    for (const m of masks) {
      if (t.x < m.x0 || t.x > m.x1 || t.z < m.z0 || t.z > m.z1) continue;
      if (m.kind === 'trail') {
        const p = clamp(((t.x - m.ax) * m.dx + (t.z - m.az) * m.dz) / m.len2, 0, 1);
        if ((t.x - m.ax - m.dx * p) ** 2 + (t.z - m.az - m.dz * p) ** 2 < m.r2) return true;
      } else if ((t.x - m.x) ** 2 + (t.z - m.z) ** 2 < m.r2) {
        if (m.kind === 'keep') kept = true;
        else if (m.r < 30) return true;
        else cleared = true;
      }
    }
    return cleared && !kept;
  }

  private matrix = new THREE.Matrix4();
  private rotation = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private color = new THREE.Color();

  private flush(deadline: number) {
    const changed = new Set<Sector>();
    for (const batch of this.dirty) {
      this.refit(batch);
      changed.add(batch.tile.sector);
      this.dirty.delete(batch);
      if (performance.now() >= deadline) break;
    }
    for (const sector of changed) {
      sector.bounds.makeEmpty();
      for (const { mesh } of sector.batches) if (mesh.count) sector.bounds.union(mesh.boundingBox);
      if (this.lastDistance >= 0) this.updateSector(sector);
    }
    if (changed.size) this.shadowVersion++;
  }

  private updateInstances(mesh: THREE.InstancedMesh) {
    if (!mesh.count) return;
    mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16); mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.clearUpdateRanges(); mesh.instanceColor!.addUpdateRange(0, mesh.count * 3); mesh.instanceColor!.needsUpdate = true;
  }

  private refit(batch: Batch) {
    const { mesh, shadow, tile, ids } = batch;
    let count = 0, low = Infinity, high = -Infinity;
    const box = mesh.boundingBox; box.makeEmpty();
    for (const i of ids) {
      const t = this.trees[i];
      if (batch.sampleGround) {
        const h = t.y = this.terrain.heightAt(t.x, t.z, true);
        t.grows = h >= 0.55 && Math.hypot(this.terrain.heightAt(t.x + 1.5, t.z, true) - h, this.terrain.heightAt(t.x, t.z + 1.5, true) - h) <= 1.5 * 1.25;
      }
      const hidden = !t.grows || this.clipped(t, tile.masks);
      this.hidden[i] = Number(hidden);
      if (hidden) continue;
      const width = t.s * (t.type === 0 ? 1.1 : 1), height = t.s * (1 + ((t.rot * 3.7) % 1) * 0.25);
      this.rotation.setFromAxisAngle(this.up, t.rot); this.pos.set(t.x, t.y - 0.1, t.z); this.scale.set(width, height, width);
      mesh.setMatrixAt(count, this.matrix.compose(this.pos, this.rotation, this.scale));
      const v = 0.88 + ((t.rot * 7.3) % 1) * 0.26, hue = (t.x * 0.13) % 0.12;
      mesh.setColorAt(count++, this.color.setRGB(v * (1 + hue * 0.6), v * (1 + hue * 0.2), v * (0.9 + hue)));
      low = Math.min(low, t.y - 0.1); high = Math.max(high, t.y + height * 7.2);
      const spread = width * 3.9;
      box.min.x = Math.min(box.min.x, t.x - spread); box.max.x = Math.max(box.max.x, t.x + spread);
      box.min.z = Math.min(box.min.z, t.z - spread); box.max.z = Math.max(box.max.z, t.z + spread);
    }
    batch.sampleGround = false; mesh.count = shadow.count = count; tile.sector.dirty = true;
    if (count) {
      this.updateInstances(mesh);
      box.min.y = low; box.max.y = high;
      // A conservative bound for all three geometries and the crown's wind motion.
      const span = TILE / 2 + 6;
      mesh.boundingSphere!.center.set(tile.x, (low + high) / 2, tile.z);
      mesh.boundingSphere!.radius = Math.hypot(span, span, (high - low) / 2);
    }
    mesh.visible = count > 0;
    shadow.visible = count > 0 && this.shadowTiles.has(tile);
  }
}

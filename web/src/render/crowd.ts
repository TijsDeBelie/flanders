import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shadeVertices, tint } from './geomutil';
import { eyes } from './animalmodels';
import { surfaceTexture, type Surface } from './surfaces';
import { freeze } from './static';

/** One person (or soldier) to draw this frame. */
export interface Draw {
  x: number; y: number; z: number; yaw: number;
  fall?: number;                      // pose 4 only: 0 standing .. 1 lying flat (default 1)
  pose: 0 | 1 | 2 | 3 | 4 | 5;       // idle, walk, work, fight, dead, seated
  phase: number;                      // walking: gait angle in radians (advances with distance walked); otherwise a clock in seconds
  speed?: number;                     // ground speed in units/s (drives stride length, knee bend, lean)
  swing?: number;                     // 0..1 remaining attack swing
  flinch?: number;                    // 0..1 recoil after a hit
  body: number; legs?: number; skin: number;
  hat?: number; tool?: number; shield?: number; shieldCol?: number;
  dress?: boolean; mounted?: boolean; scale?: number; armor?: boolean;
}

const MAX = 800;
/** Where a horse's legs hang from its body (x, z for each), and each gait's phase offsets per leg (constants, not new arrays per horse per frame). */
const HORSE_LEGS = [0.16, 0.45, -0.16, 0.45, 0.16, -0.45, -0.16, -0.45];
const GALLOP = [0, 0.25, 2.3, 2.55], TROT = [0, Math.PI, Math.PI, 0], WALK = [0, Math.PI, Math.PI * 0.5, Math.PI * 1.5];
const T = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);
const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts.map(p => (p.attributes.normal ? p : (p.computeVertexNormals(), p))))!;
const box = (w: number, h: number, d: number, hex: number, x = 0, y = 0, z = 0) => T(tint(new THREE.BoxGeometry(w, h, d), hex), x, y, z);
const cyl = (rt: number, rb: number, h: number, hex: number, x = 0, y = 0, z = 0, seg = 8) => T(tint(new THREE.CylinderGeometry(rt, rb, h, seg), hex), x, y, z);
const cone = (r: number, h: number, hex: number, x = 0, y = 0, z = 0, seg = 8) => T(tint(new THREE.ConeGeometry(r, h, seg), hex), x, y, z);
const WOOD = 0x6b4a2e, IRON = 0xaab0b8, DARK = 0x3a3a40, LEATHER = 0x5a3b22;

// ---- body parts (pivot at the joint) ----
/** The storybook proportions: a big head (and hats to fit it) on a slightly rounder body. The joints, gait and poses are unchanged; only the part shapes grow,
 *  about the neck, so everything that hangs on the head (hats, helmets) still sits on it. */
export const HEAD_SCALE = 1.38, HEAD_LIFT = 0.035, TORSO_ROUND = 1.12;
const clothFolds = (x: number, y: number, z: number) => {
  const around = Math.atan2(x, z);
  return 0.92 + 0.07 * Math.cos(around * 5 + y * 3) + 0.03 * Math.sin(y * 15 + around);
};
function geoTorso() {
  const tunic = new THREE.CylinderGeometry(0.205, 0.255, 0.62, 8, 6).scale(1, 1, 0.75).translate(0, 0.31, 0);
  const belt = new THREE.CylinderGeometry(0.249, 0.254, 0.062, 8).scale(1, 1, 0.78).translate(0, 0.12, 0);
  const collar = new THREE.CylinderGeometry(0.148, 0.165, 0.048, 8).scale(1, 1, 0.94).translate(0, 0.599, 0);
  return merge([
    shadeVertices(tint(tunic, 0xffffff), clothFolds), tint(belt, 0x868078), tint(collar, 0xe4d9c7),
    box(0.088, 0.074, 0.027, 0xba9b69, 0, 0.12, 0.194),
    box(0.04, 0.12, 0.018, 0xada395, 0, 0.53, 0.145),
  ]).scale(TORSO_ROUND, 1, TORSO_ROUND);
}
function geoHead() {
  const face = new THREE.SphereGeometry(0.155, 10, 7).scale(0.94, 1.13, 0.97).translate(0, 0.135, 0);
  return merge([
    shadeVertices(tint(face, 0xffffff), (_x, y, z) => z < -0.068 && y > 0.145 ? 0.44 : 0.88 + 0.12 * Math.min(1, y * 3.5)),
    box(0.038, 0.054, 0.042, 0xf8f1e6, 0, 0.13, 0.15),
    box(0.064, 0.012, 0.018, 0x95736c, 0, 0.07, 0.139),
    ...[-1, 1].flatMap(side => [
      box(0.033, 0.014, 0.025, 0x4e4036, side * 0.059, 0.158, 0.135),
      box(0.031, 0.065, 0.052, 0xe5cbb8, side * 0.143, 0.123, 0.003),
    ]),
  ]).scale(HEAD_SCALE, HEAD_SCALE, HEAD_SCALE).translate(0, HEAD_LIFT, 0);
}
const geoThigh = () => T(tint(new THREE.BoxGeometry(0.17, 0.4, 0.19), 0xffffff), 0, -0.2, 0);
const geoShin = () => merge([T(tint(new THREE.BoxGeometry(0.15, 0.38, 0.17), 0xffffff), 0, -0.19, 0), T(tint(new THREE.BoxGeometry(0.14, 0.09, 0.27), 0x2a2018), 0, -0.36, 0.05)]);
const geoUpperArm = () => T(tint(new THREE.BoxGeometry(0.12, 0.29, 0.13), 0xffffff), 0, -0.145, 0);
const geoFore = () => merge([T(tint(new THREE.BoxGeometry(0.105, 0.28, 0.115), 0xffffff), 0, -0.14, 0), T(tint(new THREE.SphereGeometry(0.06, 6, 5), 0xffffff), 0, -0.3, 0)]);
function geoDress() {
  const skirt = new THREE.CylinderGeometry(0.22, 0.37, 0.65, 10, 5).scale(1, 1, 0.8).translate(0, 0.453, 0);
  const apron = new THREE.CylinderGeometry(0.229, 0.367, 0.56, 4, 4, true, -0.59, 1.18)
    .scale(1, 1, 0.82).translate(0, 0.49, 0.016);
  return merge([
    shadeVertices(tint(skirt, 0xe2dbd0), (x, y, z) => y < 0.15 ? 0.54 : clothFolds(x, y, z)),
    shadeVertices(tint(apron, 0xffffff), clothFolds),
  ]);
}

// ---- hats (origin at the top of the neck) ----
const HATS: (() => THREE.BufferGeometry)[] = [
  () => merge([cyl(0.36, 0.36, 0.03, 0xd9bf6a, 0, 0.22, 0, 12), cone(0.19, 0.2, 0xcfb25a, 0, 0.33, 0, 10)]),                          // 0 straw hat
  () => merge([cone(0.2, 0.36, 0x4d6b3a, 0, 0.3, -0.02, 8), cyl(0.2, 0.2, 0.08, 0x4d6b3a, 0, 0.12, 0, 8)]),                           // 1 hood
  () => merge([T(tint(new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0x7a3b2f), 0, 0.14, 0), cyl(0.2, 0.2, 0.03, 0x4a2a20, 0, 0.14, 0, 10), box(0.03, 0.18, 0.03, 0xe8e0c8, 0.1, 0.3, -0.06)]), // 2 cap with feather
  () => merge([T(tint(new THREE.SphereGeometry(0.18, 10, 6, 0, Math.PI * 2, 0, Math.PI / 1.7), IRON), 0, 0.12, 0), box(0.03, 0.14, 0.03, IRON, 0, 0.1, 0.17)]),   // 3 helmet with nasal
  () => merge([T(tint(new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0x8a9098), 0, 0.14, 0), cyl(0.31, 0.31, 0.025, 0x7c828a, 0, 0.17, 0, 14)]),   // 4 kettle hat
  () => merge([box(0.33, 0.42, 0.32, 0x9aa0a8, 0, 0.1, 0), box(0.2, 0.03, 0.04, DARK, 0, 0.14, 0.17), cone(0.06, 0.2, 0xb03030, 0, 0.44, -0.02, 6)]),                     // 5 great helm with plume
  () => merge([cyl(0.2, 0.2, 0.06, 0xd8d4c8, 0, 0.12, 0, 10), cone(0.19, 0.28, 0xd8d4c8, 0, 0.3, -0.02, 8)]),                                                      // 6 white hood / coif
  () => merge([T(tint(new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0x30343a), 0, 0.15, 0), cyl(0.2, 0.2, 0.03, 0x1a1c20, 0, 0.14, 0, 10)]),           // 7 dark skullcap (bandit)
];
export const HAT = { STRAW: 0, HOOD: 1, CAP: 2, HELM: 3, KETTLE: 4, GREAT: 5, COIF: 6, BANDIT: 7 };

// ---- tools (origin at the grip, long axis +Y) ----
const TOOLS: (() => THREE.BufferGeometry)[] = [
  () => merge([cyl(0.03, 0.03, 0.9, WOOD, 0, 0.3), box(0.26, 0.2, 0.035, IRON, 0.13, 0.66, 0), box(0.06, 0.06, 0.05, IRON, 0.01, 0.6, 0)]),                    // 1 axe
  () => merge([cyl(0.03, 0.03, 0.95, WOOD, 0, 0.3), box(0.55, 0.06, 0.06, IRON, 0, 0.76, 0), cone(0.03, 0.12, IRON, 0.3, 0.76, 0, 4), cone(0.03, 0.12, IRON, -0.3, 0.76, 0, 4)]), // 2 pickaxe
  () => merge([cyl(0.03, 0.03, 0.55, WOOD, 0, 0.18), box(0.2, 0.13, 0.13, DARK, 0, 0.5, 0)]),                                                                 // 3 hammer
  () => merge([cyl(0.025, 0.025, 1.5, WOOD, 0, 0.5), box(0.28, 0.04, 0.04, IRON, 0, 1.25, 0), box(0.03, 0.22, 0.03, IRON, -0.12, 1.36, 0), box(0.03, 0.22, 0.03, IRON, 0, 1.36, 0), box(0.03, 0.22, 0.03, IRON, 0.12, 1.36, 0)]), // 4 pitchfork
  () => merge([cyl(0.025, 0.025, 1.9, WOOD, 0, 0.7), cone(0.05, 0.28, IRON, 0, 1.78, 0, 5)]),                                                              // 5 spear
  () => { const g = new THREE.TorusGeometry(0.46, 0.022, 5, 14, Math.PI); g.rotateZ(-Math.PI / 2); g.rotateY(Math.PI / 2); return merge([tint(g, WOOD), box(0.01, 0.9, 0.01, 0xd8d0b8, 0, 0, 0)]); }, // 6 bow
  () => merge([box(0.073, 0.71, 0.025, 0xd6dae0, 0, 0.48, 0), cone(0.043, 0.17, 0xd6dae0, 0, 0.91, 0, 4), box(0.26, 0.04, 0.055, 0xb49a59, 0, 0.1, 0), cyl(0.026, 0.026, 0.18, LEATHER, 0, 0, 0, 6), cyl(0.042, 0.038, 0.05, IRON, 0, -0.12, 0, 8)]), // 7 sword
  () => merge([cyl(0.025, 0.025, 1.7, WOOD, 0, 0.5), T(tint(new THREE.SphereGeometry(0.07, 6, 5), 0xc8b070), 0, 1.38, 0)]),                                // 8 staff
  () => merge([cyl(0.025, 0.025, 1.0, WOOD, 0, 0.3), T(tint(new THREE.SphereGeometry(0.09, 6, 5), 0xff9a2a), 0, 0.85, 0)]),                              // 9 torch (glowing head)
  () => merge([cyl(0.15, 0.11, 0.26, 0x6a4a2e, 0, -0.16, 0.12, 10), cyl(0.155, 0.155, 0.03, IRON, 0, -0.05, 0.12, 10), cyl(0.13, 0.13, 0.02, 0x4a8ac8, 0, -0.03, 0.12, 10), box(0.3, 0.025, 0.025, IRON, 0, 0.0, 0.12)]), // 10 water bucket
  () => merge([cyl(0.05, 0.05, 0.5, WOOD, 0, 0.1, 0, 7), cyl(0.2, 0.07, 0.62, 0x5a3b22, 0, 0.62, 0, 8), cone(0.04, 0.12, IRON, 0.18, 0.7, 0, 4), cone(0.04, 0.12, IRON, -0.18, 0.6, 0, 4), cone(0.04, 0.12, IRON, 0, 0.8, 0.17, 4)]),   // 11 ogre's club
  () => merge([cyl(0.03, 0.025, 1.45, WOOD, 0, 0.5), box(0.26, 0.065, 0.24, IRON, 0, 1.2, 0.105), box(0.07, 0.12, 0.08, DARK, 0, 1.17, 0)]), // 12 hoe
];
export const TOOL = { AXE: 1, PICK: 2, HAMMER: 3, FORK: 4, SPEAR: 5, BOW: 6, SWORD: 7, STAFF: 8, TORCH: 9, BUCKET: 10, CLUB: 11, HOE: 12 };
const TOOL_ROT = [0, -0.2, -0.2, -0.3, -0.1, -0.15, 0.0, -0.9, -0.1, -0.2, 0, -0.3];

// ---- shields ----
const SHIELDS: (() => THREE.BufferGeometry)[] = [
  () => { const g = new THREE.CylinderGeometry(0.32, 0.32, 0.05, 14); g.rotateX(Math.PI / 2); return merge([tint(g, 0xffffff), T(tint(new THREE.SphereGeometry(0.07, 6, 5), IRON), 0, 0, 0.05)]); },
  () => { const s = new THREE.Shape(); s.moveTo(-0.26, 0.3); s.lineTo(0.26, 0.3); s.lineTo(0.26, -0.05); s.quadraticCurveTo(0.22, -0.3, 0, -0.45); s.quadraticCurveTo(-0.22, -0.3, -0.26, -0.05); s.closePath(); const g = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false }); g.translate(0, 0, -0.025); return tint(g, 0xffffff); },
];

// ---- horse ----
const HORSE_COAT = 0x896044;
const HORSE_HIP = 0.83;
function horseGeo() {
  return merge([
    shadeVertices(tint(new THREE.IcosahedronGeometry(0.5, 1).scale(0.59, 0.61, 1.48).translate(0, 0.94, 0), 0xffffff),
      (_x, y, z) => 0.65 + 0.3 * Math.min(1, (y - 0.61) * 1.6) + 0.05 * Math.cos(z * 20)),
    tint(new THREE.CylinderGeometry(0.13, 0.22, 0.65, 7).rotateX(0.47).translate(0, 1.19, 0.56), 0xf5e8d6),
    tint(new THREE.IcosahedronGeometry(0.21, 1).scale(0.61, 0.69, 1.24).rotateX(0.25).translate(0, 1.44, 0.85), 0xffffff),
    box(0.12, 0.55, 0.1, 0x5e5247, 0, 0.88, -0.69),
    box(0.09, 0.38, 0.16, 0x766759, 0, 1.39, 0.48),
    ...[-1, 1].flatMap(side => [
      cone(0.055, 0.22, 0xdecbbb, side * 0.08, 1.65, 0.67, 5),
      box(0.028, 0.035, 0.05, 0x372c24, side * 0.109, 1.49, 0.87),
    ]),
    box(0.15, 0.14, 0.11, 0xb0a094, 0, 1.38, 1.06),
  ]);
}
const horseLegGeo = () => merge([
  cyl(0.069, 0.038, HORSE_HIP, 0xe8d9c0, 0, -HORSE_HIP / 2, 0, 6),
  box(0.116, 0.09, 0.16, 0x4a4037, 0, -HORSE_HIP + 0.045, 0.026),
]);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pos = (v: number) => (v > 0 ? v : 0);

/**
 * Instanced humanoids. Every part is its own InstancedMesh driven by a per-person pose, so hundreds of animated
 * people cost ~30 draw calls. Legs have thighs and shins with knees; arms have elbows. When walking, `phase` is the
 * gait angle: it advances with the distance walked, so feet never slide and fast walkers take longer, bouncier strides.
 */
export class Crowd {
  group = new THREE.Group();
  private torso: THREE.InstancedMesh; private head: THREE.InstancedMesh;
  private thighL: THREE.InstancedMesh; private thighR: THREE.InstancedMesh; private shinL: THREE.InstancedMesh; private shinR: THREE.InstancedMesh;
  private uArmL: THREE.InstancedMesh; private uArmR: THREE.InstancedMesh; private foreL: THREE.InstancedMesh; private foreR: THREE.InstancedMesh;
  private dress: THREE.InstancedMesh; private horse: THREE.InstancedMesh; private horseLeg: THREE.InstancedMesh;
  private horseEyes: THREE.InstancedMesh | null = null;
  private hats: THREE.InstancedMesh[]; private tools: THREE.InstancedMesh[]; private shields: THREE.InstancedMesh[];
  private distantBody: THREE.InstancedMesh; private distantHead: THREE.InstancedMesh;
  private distant = 0;
  private n = { torso: 0, leg: 0, arm: 0, dress: 0, horse: 0, hleg: 0, hats: [] as number[], tools: [] as number[], shields: [] as number[] };
  private e = new THREE.Euler(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private s = new THREE.Vector3(); private col = new THREE.Color();
  private t4 = new THREE.Matrix4(); private B = new THREE.Matrix4(); private Tm = new THREE.Matrix4(); private Pm = new THREE.Matrix4(); private Hm = new THREE.Matrix4();
  private m = new THREE.Matrix4(); private a1 = new THREE.Matrix4(); private a2 = new THREE.Matrix4(); private l1 = new THREE.Matrix4();

  constructor() {
    // One material per kind of part (surface texture, tinted per person or not) instead of one per part: three.js then skips re-uploading the material's
    // uniforms between consecutive parts. (Tinted and untinted parts use different shader versions, so they do not share: switching versions per draw costs more.)
    const mats = new Map<string, THREE.MeshStandardMaterial>();
    const mk = (g: THREE.BufferGeometry, max = MAX, surface?: Surface, tinted = true) => {
      const key = `${surface ?? ''}|${tinted}`;
      let mat = mats.get(key);
      if (!mat) { mat = new THREE.MeshStandardMaterial({ map: surface ? surfaceTexture(surface) : null, vertexColors: true, roughness: 0.85, metalness: 0.05 }); mats.set(key, mat); }
      const m = new THREE.InstancedMesh(g, mat, max); m.castShadow = true; m.frustumCulled = false; m.count = 0; this.group.add(m); return m;
    };
    this.torso = mk(geoTorso(), MAX, 'linen'); this.head = mk(geoHead());
    this.thighL = mk(geoThigh()); this.thighR = mk(geoThigh()); this.shinL = mk(geoShin()); this.shinR = mk(geoShin());
    this.uArmL = mk(geoUpperArm(), MAX, 'linen'); this.uArmR = mk(geoUpperArm(), MAX, 'linen'); this.foreL = mk(geoFore()); this.foreR = mk(geoFore());
    this.dress = mk(geoDress(), MAX, 'linen'); this.horse = mk(horseGeo(), MAX, 'fur'); this.horseLeg = mk(horseLegGeo(), MAX * 4);
    for (const m of [this.head, this.shinL, this.shinR, this.foreL, this.foreR]) m.castShadow = false;   // too small to matter in the shadow pass
    this.hats = HATS.map(h => mk(h().scale(HEAD_SCALE, HEAD_SCALE, HEAD_SCALE).translate(0, HEAD_LIFT, 0), MAX, undefined, false)); this.tools = TOOLS.map(t => mk(t(), MAX, undefined, false)); this.shields = SHIELDS.map(s => mk(s()));
    this.n.hats = new Array(this.hats.length).fill(0);
    this.n.tools = new Array(this.tools.length).fill(0);
    this.n.shields = new Array(this.shields.length).fill(0);
    this.distantBody = mk(merge([
      box(0.43 * TORSO_ROUND, 0.67, 0.27 * TORSO_ROUND, 0xffffff, 0, 1.04, 0),
      box(0.14, 0.68, 0.16, 0x6c6864, -0.11, 0.35, -0.045),
      box(0.14, 0.68, 0.16, 0x6c6864, 0.11, 0.35, 0.045),
    ]));
    this.distantHead = mk(cyl(0.14 * HEAD_SCALE, 0.15 * HEAD_SCALE, 0.27 * HEAD_SCALE, 0xffffff, 0, 1.51 + 0.04 + HEAD_LIFT, 0, 5));   // (the big head of the near figures)
    this.distantBody.castShadow = this.distantHead.castShadow = false;
    this.all = [this.torso, this.head, this.thighL, this.thighR, this.shinL, this.shinR, this.uArmL, this.uArmR, this.foreL, this.foreR, this.dress, this.horse, this.horseLeg, this.distantBody, this.distantHead, ...this.hats, ...this.tools, ...this.shields];
    this.counts = new Array(this.all.length).fill(0);
    freeze(...this.all);   // instances carry world matrices; the meshes themselves never move
    // the parts that are tinted per person get their colour buffer now (filled white, as setColorAt would), not on the first frame they are drawn: adding it
    // later changes their shader, which then had to be rebuilt after warm-up
    for (const m of [this.torso, this.head, this.thighL, this.thighR, this.shinL, this.shinR, this.uArmL, this.uArmR, this.foreL, this.foreR, this.dress, this.horse, this.horseLeg, this.distantBody, this.distantHead, ...this.shields])
      m.instanceColor ??= new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3).fill(1), 3);
  }
  /** Every instanced part, in the order `end()` fills `counts`. */
  private all: THREE.InstancedMesh[];
  private counts: number[];
  private googly = false;

  setGooglyEyes(on: boolean) {
    if (on && !this.horseEyes) {
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45 });
      this.horseEyes = new THREE.InstancedMesh(merge(eyes(0.109, 1.49, 0.87, 0.036, true)), material, MAX);
      this.horseEyes.instanceMatrix = this.horse.instanceMatrix;
      this.horseEyes.count = this.horse.count;
      this.horseEyes.frustumCulled = false;
      this.group.add(freeze(this.horseEyes));
    }
    this.googly = on;
    if (this.horseEyes) this.horseEyes.visible = on && this.horseEyes.count > 0;
  }

  begin() {
    this.n.torso = this.n.leg = this.n.arm = this.n.dress = this.n.horse = this.n.hleg = 0;
    this.distant = 0;
    this.n.hats.fill(0); this.n.tools.fill(0); this.n.shields.fill(0);
  }

  end() {
    const n = this.n, counts = this.counts;
    if (this.horseEyes) { this.horseEyes.count = n.horse; this.horseEyes.visible = this.googly && n.horse > 0; }
    counts[0] = counts[1] = n.torso; counts[2] = counts[3] = counts[4] = counts[5] = n.leg; counts[6] = counts[7] = counts[8] = counts[9] = n.arm;
    counts[10] = n.dress; counts[11] = n.horse; counts[12] = n.hleg; counts[13] = counts[14] = this.distant;
    let k = 15;
    for (const c of n.hats) counts[k++] = c;
    for (const c of n.tools) counts[k++] = c;
    for (const c of n.shields) counts[k++] = c;
    for (let i = 0; i < this.all.length; i++) {
      const mesh = this.all[i], c = counts[i];
      mesh.count = c;
      // An instanced mesh with no instances is not drawn, but three.js still binds its program, uploads its uniforms and sets up its buffers first, in the main
      // pass and again in the shadow pass (and none of that shows in renderer.info's draw calls). Most hats, tools and shields are unused most of the time.
      mesh.visible = c > 0;
      if (c === 0) continue;                                     // nothing to draw, nothing to upload
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, c * 16); mesh.instanceMatrix.needsUpdate = true;   // upload only the instances in use
      if (mesh.instanceColor) { mesh.instanceColor.clearUpdateRanges(); mesh.instanceColor.addUpdateRange(0, c * 3); mesh.instanceColor.needsUpdate = true; }
    }
  }

  /** Distant villagers are two rigid instances rather than a full joint rig. */
  addVillager(d: Draw, detailed: boolean) {
    if (detailed) { this.add(d); return; }
    if (this.distant >= MAX) return;
    const bob = d.pose === 1 ? Math.abs(Math.sin(d.phase)) * 0.075 : 0;
    this.v.set(d.x, d.y + bob, d.z); this.s.setScalar(d.scale ?? 1);
    this.e.set(d.pose === 1 ? 0.055 : 0, d.yaw, 0, 'YXZ'); this.q.setFromEuler(this.e);
    this.m.compose(this.v, this.q, this.s);
    this.put(this.distantBody, this.distant, this.m, d.body);
    this.put(this.distantHead, this.distant++, this.m, d.skin);
  }

  /** out = parent * translate(x,y,z) * rotate(rx, ry, rz) */
  /** out = parent × (translate(x, y, z) · rotate(rx, ry, rz in 'YXZ' order)): a joint `(x, y, z)` from its parent, turned by those angles.
   *  Written out by hand: it runs about twelve times per person per frame, and going through Euler → Quaternion → compose → a full 4×4 multiply cost several
   *  times as much. Every matrix here is affine (no projection), so the bottom row is skipped, and most joints only bend about x. */
  private frame(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
    let r00 = 1, r01 = 0, r02 = 0, r10 = 0, r11 = 1, r12 = 0, r20 = 0, r21 = 0, r22 = 1;
    if (ry === 0 && rz === 0) {
      if (rx !== 0) { const c = Math.cos(rx), sn = Math.sin(rx); r11 = c; r12 = -sn; r21 = sn; r22 = c; }
    } else {   // as Matrix4.makeRotationFromEuler for order 'YXZ'
      const a = Math.cos(rx), b = Math.sin(rx), c = Math.cos(ry), d = Math.sin(ry), e = Math.cos(rz), f = Math.sin(rz);
      const ce = c * e, cf = c * f, de = d * e, df = d * f;
      r00 = ce + df * b; r01 = de * b - cf; r02 = a * d;
      r10 = a * f; r11 = a * e; r12 = -b;
      r20 = cf * b - de; r21 = df + ce * b; r22 = a * c;
    }
    const p = parent.elements, o = out.elements;
    const p0 = p[0], p1 = p[1], p2 = p[2], p4 = p[4], p5 = p[5], p6 = p[6], p8 = p[8], p9 = p[9], p10 = p[10], p12 = p[12], p13 = p[13], p14 = p[14];
    o[0] = p0 * r00 + p4 * r10 + p8 * r20; o[1] = p1 * r00 + p5 * r10 + p9 * r20; o[2] = p2 * r00 + p6 * r10 + p10 * r20; o[3] = 0;
    o[4] = p0 * r01 + p4 * r11 + p8 * r21; o[5] = p1 * r01 + p5 * r11 + p9 * r21; o[6] = p2 * r01 + p6 * r11 + p10 * r21; o[7] = 0;
    o[8] = p0 * r02 + p4 * r12 + p8 * r22; o[9] = p1 * r02 + p5 * r12 + p9 * r22; o[10] = p2 * r02 + p6 * r12 + p10 * r22; o[11] = 0;
    o[12] = p0 * x + p4 * y + p8 * z + p12; o[13] = p1 * x + p5 * y + p9 * z + p13; o[14] = p2 * x + p6 * y + p10 * z + p14; o[15] = 1;
    return out;
  }
  /** Colours as hex → the linear colour the shader wants. Color.setHex converts from sRGB (three pow() calls) and ran for every body part of everyone, every
   *  frame, with only a few dozen distinct colours in play. */
  private linear = new Map<number, THREE.Color>();
  private put(mesh: THREE.InstancedMesh, i: number, m: THREE.Matrix4, hex?: number) {
    m.toArray(mesh.instanceMatrix.array as Float32Array, i * 16);
    if (hex !== undefined && mesh.instanceColor) {
      let c = this.linear.get(hex); if (!c) { c = new THREE.Color(hex); this.linear.set(hex, c); }
      const a = mesh.instanceColor.array as Float32Array, k = i * 3; a[k] = c.r; a[k + 1] = c.g; a[k + 2] = c.b;
    }
  }

  /** A horse with nobody on it (pulling a cart, carrying a pack): standing at (x, y, z) facing `yaw`. `phase` is the gait angle and `speed` the ground speed, as for a person. */
  addHorse(x: number, y: number, z: number, yaw: number, phase: number, speed: number, hex: number, scale = 1) {
    if (this.n.horse >= MAX - 1 || this.n.hleg > MAX * 4 - 5) return;
    const walk = speed > 0.35, gallop = speed > 5, trot = speed > 2.2;
    const hbob = walk ? Math.abs(Math.sin(phase * (gallop ? 1 : 2))) * (gallop ? 0.14 : trot ? 0.06 : 0.03) : 0;
    this.v.set(x, y, z); this.s.setScalar(scale); this.e.set(0, yaw, 0, 'YXZ'); this.q.setFromEuler(this.e); this.B.compose(this.v, this.q, this.s);
    this.frame(this.Hm, this.B, 0, hbob, 0, walk ? Math.sin(phase) * (gallop ? 0.07 : 0.03) : 0);
    this.Hm.scale(this.s.set(1.05, 1.05, 1.05));
    this.put(this.horse, this.n.horse++, this.Hm, hex);
    const off = gallop ? GALLOP : trot ? TROT : WALK;
    const amp = walk ? (gallop ? 0.95 : trot ? 0.6 : 0.42) : 0;
    for (let k = 0; k < 4; k++) {
      this.frame(this.l1, this.Hm, HORSE_LEGS[k * 2], HORSE_HIP, HORSE_LEGS[k * 2 + 1], -(amp * Math.sin(phase + off[k])));
      this.put(this.horseLeg, this.n.hleg++, this.l1, hex);
    }
  }

  add(d: Draw) {
    if (this.n.torso >= MAX - 1) return;
    const sc = d.scale ?? 1, ph = d.phase, sp = d.speed ?? 0, dead = d.pose === 4, walk = d.pose === 1 && !dead;
    const fast = clamp(sp / 4, 0, 1.3);
    // ---- the gait: s = leg swing, bob = two bounces per cycle
    const A = walk ? clamp(0.26 + 0.17 * sp, 0.3, 1.0) : 0;
    const s = walk ? Math.sin(ph) : 0;
    const bob = walk ? Math.abs(Math.sin(ph)) * (0.02 + 0.014 * clamp(sp, 0, 5)) : 0;
    const lean = (walk ? 0.03 + 0.13 * fast : 0) + (d.pose === 3 ? 0.1 : 0) + (d.pose === 2 ? 0.14 + 0.07 * Math.sin(ph * 6) : 0) + (d.flinch ?? 0) * 0.27;
    const twist = walk ? 0.12 * s * (0.6 + fast) : 0;
    const idle = d.pose === 0 ? Math.sin(ph * 1.5) : 0;

    // ---- root
    const lift = d.mounted ? 0.6 : 0;
    const fl = d.fall ?? 1;
    this.v.set(d.x, d.y + (dead ? 0.2 * fl : lift) * sc, d.z); this.s.setScalar(sc);
    this.e.set(dead ? -Math.PI / 2 * fl : 0, d.yaw, 0, 'YXZ'); this.q.setFromEuler(this.e); this.B.compose(this.v, this.q, this.s);

    // ---- horse under a rider
    if (d.mounted && !dead) {
      const gallop = sp > 5, trot = sp > 2.2, hbob = walk ? Math.abs(Math.sin(ph * (gallop ? 1 : 2))) * (gallop ? 0.14 : trot ? 0.06 : 0.03) : 0;
      this.frame(this.Hm, this.B, 0, -lift + hbob, 0, walk ? Math.sin(ph) * (gallop ? 0.07 : 0.03) : 0);
      this.Hm.scale(this.s.set(1.05, 1.05, 1.05));
      this.put(this.horse, this.n.horse++, this.Hm, HORSE_COAT);
      const off = gallop ? GALLOP : trot ? TROT : WALK;
      const amp = walk ? (gallop ? 0.95 : trot ? 0.6 : 0.42) : 0;
      for (let k = 0; k < 4; k++) {
        this.frame(this.l1, this.Hm, HORSE_LEGS[k * 2], HORSE_HIP, HORSE_LEGS[k * 2 + 1], -(amp * Math.sin(ph + off[k])));
        this.put(this.horseLeg, this.n.hleg++, this.l1, HORSE_COAT);
      }
    }

    // ---- pelvis and torso frames
    const hipY = d.pose === 5 ? 0.38 : 0.8;
    this.frame(this.Pm, this.B, 0, hipY + bob, 0, 0, -twist * 0.6);
    this.frame(this.Tm, this.B, 0, hipY + bob + idle * 0.012, 0, lean, twist);
    this.put(this.torso, this.n.torso, this.Tm, d.body);
    // head: turns to look around when idle, keeps level when walking
    this.frame(this.a1, this.Tm, 0, 0.62, 0, d.pose === 3 ? -0.08 : -lean * 0.5, d.pose === 0 ? 0.45 * Math.sin(ph * 0.5) : -twist * 0.8);
    this.put(this.head, this.n.torso, this.a1, d.skin); this.n.torso++;
    if (d.hat !== undefined) { this.hats[d.hat].setMatrixAt(this.n.hats[d.hat]++, this.a1); }
    if (d.dress) { this.frame(this.m, this.B, 0, 0, 0, 0); this.put(this.dress, this.n.dress++, this.m, d.body); }

    // ---- legs: thigh swings at the hip, shin folds at the knee
    const legsHex = d.legs ?? 0x4a3a2a, K = clamp(0.45 + 0.22 * sp, 0.4, 1.5);
    let fL: number, fR: number, kL: number, kR: number;
    if (d.pose === 5) { fL = fR = Math.PI / 2; kL = kR = Math.PI / 2; }
    else if (d.mounted) { fL = fR = 1.15; kL = kR = 1.25; }
    else if (walk) { fL = A * s; fR = -A * s; kL = K * Math.pow(pos(Math.cos(ph - 0.3)), 1.4) + 0.05; kR = K * Math.pow(pos(-Math.cos(ph - 0.3)), 1.4) + 0.05; }
    else if (d.pose === 3) { fL = 0.4; fR = -0.28; kL = 0.25; kR = 0.45; }
    else if (dead) { fL = -0.15; fR = 0.2; kL = 0.1; kR = 0.3; }
    else { const w = Math.sin(ph * 0.35) * 0.05; fL = w; fR = -w; kL = 0.04; kR = 0.04 + Math.max(0, Math.sin(ph * 0.35)) * 0.06; }
    const spread = d.mounted ? 0.25 : d.pose === 3 ? 0.08 : 0;
    this.frame(this.a2, this.Pm, 0.11, 0, 0, -fL, 0, spread); this.put(this.thighL, this.n.leg, this.a2, legsHex);
    this.frame(this.l1, this.a2, 0, -0.4, 0, kL); this.put(this.shinL, this.n.leg, this.l1, legsHex);
    this.frame(this.a2, this.Pm, -0.11, 0, 0, -fR, 0, -spread); this.put(this.thighR, this.n.leg, this.a2, legsHex);
    this.frame(this.l1, this.a2, 0, -0.4, 0, kR); this.put(this.shinR, this.n.leg++, this.l1, legsHex);

    // ---- arms: swing opposite to the leg on the same side; elbows flex
    const t = d.tool ?? 0;
    let uR = A * 0.85 * s, uL = -A * 0.85 * s, eR = -(0.2 + 0.1 * sp + 0.3 * pos(uR)), eL = -(0.2 + 0.1 * sp + 0.3 * pos(uL));
    if (d.pose === 0) { uR = 0.04 * idle; uL = -0.04 * idle; eR = eL = -0.12; }
    if (d.pose === 2) { const sw = Math.sin(ph * 6); uR = 0.9 + 0.7 * sw; eR = -(0.5 + 0.9 * pos(Math.sin(ph * 6 + 1))); uL = 0.5; eL = -0.6; }
    if (d.pose === 5) { uR = uL = 0.65 + 0.14 * Math.sin(ph * 2); eR = eL = -0.85; }
    if (d.pose === 3) {
      const sw = d.swing ?? 0;
      if (t === TOOL.SPEAR) { uR = 0.68 + 0.60 * Math.sin(sw * Math.PI); eR = -0.48; }
      else if (sw > 0) { const p = 1 - sw, k = Math.sin(p * Math.PI / 2); uR = 2.4 - 2.3 * k; eR = -0.9 * (1 - k); } else { uR = 1.0 + 0.1 * Math.sin(ph * 4); eR = -0.9; }
      uL = 0.8; eL = -0.8;
    }
    if (dead) { uR = -0.2; uL = 0.3; eR = eL = -0.2; }
    if (t === TOOL.SPEAR || t === TOOL.FORK || t === TOOL.STAFF) { if (d.pose !== 3) { uR = 0.25; eR = -0.9; } }
    if (t === TOOL.BOW) { uR = 1.45; uL = 1.45; eR = -0.1; eL = -0.1; }
    if (t === TOOL.BUCKET && d.pose !== 3) { uR = 0.75; eR = -0.85; uL = 0.35; eL = -0.5; }
    const armY = 0.56;
    this.frame(this.a1, this.Tm, 0.29, armY, 0, -uR); this.put(this.uArmR, this.n.arm, this.a1, d.body);
    this.frame(this.a2, this.a1, 0, -0.29, 0, eR); this.put(this.foreR, this.n.arm, this.a2, d.body);
    if (t > 0) {
      const swing = d.pose === 3 ? d.swing ?? 0 : 0;
      const wrist = t === TOOL.SPEAR ? uR - eR + (d.pose === 3 ? 1.25 + 0.30 * Math.sin(swing * Math.PI) : 0.18)
        : t === TOOL.SWORD ? uR - eR + (swing > 0 ? 1.85 - 2.5 * swing : 0.32)
        : t === TOOL.HOE ? uR - eR + (d.pose === 2 ? 2.3 + 0.26 * Math.sin(ph * 6) : 0.28)
        : TOOL_ROT[t] + (t === TOOL.AXE || t === TOOL.CLUB ? -0.6 : t === TOOL.FORK ? -0.9 : t === TOOL.BOW ? -1.2 : 0);
      this.frame(this.m, this.a2, 0, -0.3, 0.04, wrist);
      this.tools[t - 1].setMatrixAt(this.n.tools[t - 1]++, this.m);
    }
    this.frame(this.a1, this.Tm, -0.29, armY, 0, -uL); this.put(this.uArmL, this.n.arm, this.a1, d.body);
    this.frame(this.a2, this.a1, 0, -0.29, 0, eL); this.put(this.foreL, this.n.arm++, this.a2, d.body);
    if (d.shield !== undefined) {
      this.frame(this.m, this.a2, -0.08, -0.12, 0.2);
      this.put(this.shields[d.shield], this.n.shields[d.shield]++, this.m, d.shieldCol ?? 0xb03030);
    }
  }
}

// ---------- catapult ----------
/** A battering ram: a roofed timber shed on wheels with an iron-shod log hanging inside (`userData.log` swings when it strikes). */
/** The warlord's standard: a tall pole with a red banner and a gilt finial, carried behind him. `userData.cloth` is the banner (swayed by the caller). */
export function buildStandard(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x5a3b22, roughness: 0.9 }), gold = new THREE.MeshStandardMaterial({ color: 0xd9a93a, roughness: 0.5, metalness: 0.4 });
  const red = new THREE.MeshStandardMaterial({ color: 0x9b2c22, roughness: 0.85, side: THREE.DoubleSide }), dark = new THREE.MeshStandardMaterial({ color: 0x2a1a14, roughness: 0.9, side: THREE.DoubleSide });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 4.6, 6), wood); pole.position.y = 2.3; pole.castShadow = true; g.add(pole);
  const top = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.4, 6), gold); top.position.y = 4.8; g.add(top);
  const cloth = new THREE.Group(); cloth.position.set(0, 4.35, 0); g.add(cloth);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), red); flag.position.set(0.78, -0.5, 0); flag.castShadow = true; cloth.add(flag);
  const skull = new THREE.Mesh(new THREE.CircleGeometry(0.2, 10), dark); skull.position.set(0.78, -0.45, 0.01); cloth.add(skull);   // a dark disc on the banner: the warlord's mark
  const horn = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.05, 5, 10, Math.PI * 1.2), gold); horn.position.set(0.15, 1.7, 0.1); horn.rotation.set(0, 0.4, 0.4); g.add(horn);   // the war horn hanging from the pole
  g.userData.cloth = cloth;
  return g;
}

const BEAM = 0x815b36, STRAP = 0x51545a, ROPE = 0x9f8753, HIDE = 0x7d6545;
const siegeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 });
const between = (a: [number, number, number], b: [number, number, number], width: number, color: number) => {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), dir = end.clone().sub(start);
  const g = box(width, dir.length(), width, color);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  return g.translate(...start.lerp(end, 0.5).toArray());
};
const across = (r: number, length: number, color: number, x: number, y: number, z: number, segments = 12) => T(cyl(r, r, length, color, 0, 0, 0, segments).rotateZ(Math.PI / 2), x, y, z);

/** Both wheels on one axle rotate about the same local x axis and use one mesh. */
function wheelset(radius: number): THREE.BufferGeometry {
  const out = [across(0.08, 1.72, DARK, 0, 0, 0, 8)];
  for (const side of [-1, 1]) {
    const x = side * 0.82;
    out.push(T(tint(new THREE.TorusGeometry(radius - 0.05, 0.06, 5, 14).rotateY(Math.PI / 2), STRAP), x, 0, 0), across(0.12, 0.23, DARK, x, 0, 0, 10));
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3;
      out.push(between([x, 0, 0], [x, Math.cos(a) * (radius - 0.07), Math.sin(a) * (radius - 0.07)], 0.09, BEAM));
    }
  }
  return merge(out);
}

let ramFrame: THREE.BufferGeometry | undefined, ramLog: THREE.BufferGeometry | undefined, ramHead: THREE.BufferGeometry | undefined;
let catapultFrame: THREE.BufferGeometry | undefined, catapultArm: THREE.BufferGeometry | undefined, catapultStone: THREE.BufferGeometry | undefined;
let ramWheels: THREE.BufferGeometry | undefined, catapultWheels: THREE.BufferGeometry | undefined;
const RAM_WHEEL_RADIUS = 0.43, CATAPULT_WHEEL_RADIUS = 0.46;

const siegeMesh = (g: THREE.BufferGeometry) => { const m = new THREE.Mesh(g, siegeMaterial); m.castShadow = true; return m; };

function attachWheels(engine: THREE.Group, geometry: THREE.BufferGeometry, radius: number, back: number, front: number) {
  engine.userData.wheelRadius = radius;
  engine.userData.axles = [back, front].map(z => {
    const axle = siegeMesh(geometry);
    axle.position.set(0, radius, z);
    engine.add(axle);
    return axle;
  });
}

export function setSiegeWheelTravel(engine: THREE.Group, distance: number) {
  const angle = (distance / engine.userData.wheelRadius) % (2 * Math.PI);
  for (const axle of engine.userData.axles as THREE.Mesh[]) axle.rotation.x = angle;
}

export function buildRam(): THREE.Group {
  if (!ramFrame) {
    ramWheels = wheelset(RAM_WHEEL_RADIUS);
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const x = side * 0.63;
      parts.push(box(0.22, 0.24, 3.36, BEAM, x, 0.63, 0), box(0.15, 0.16, 3.32, WOOD, x, 1.86, 0));
      for (const z of [-1.36, 0, 1.36]) parts.push(box(0.16, 1.29, 0.17, WOOD, x, 1.24, z));
      for (const z of [-1, 1]) parts.push(between([x, 0.76, 0], [x, 1.82, z * 1.28], 0.12, BEAM));
      for (let z = -1.45; z <= 1.46; z += 0.29) {
        parts.push(T(box(0.98, 0.07, 0.31, HIDE + (Math.round((z + 1.45) * 3.45) % 2) * 0x090702).rotateZ(-side * 0.43), side * 0.42, 2.04, z));
      }
      parts.push(T(box(0.98, 0.10, 0.15, WOOD).rotateZ(-side * 0.43), side * 0.42, 2.00, 1.58));
    }
    parts.push(box(0.15, 0.14, 3.36, WOOD, 0, 2.25, 0));
    for (const z of [-1.36, 0, 1.36]) parts.push(box(1.48, 0.17, 0.17, WOOD, 0, 1.82, z));
    ramFrame = merge(parts);
    const log = [cyl(0.19, 0.22, 3.5, BEAM, 0, 0, 0, 10).rotateX(Math.PI / 2)];
    for (const z of [-0.82, 0.82]) {
      log.push(T(cyl(0.23, 0.23, 0.10, DARK).rotateX(Math.PI / 2), 0, 0, z));
      for (const x of [-0.13, 0.13]) log.push(between([x, 0.05, z], [x, 0.63, z * 0.85], 0.038, ROPE));
    }
    ramLog = merge(log);
    ramHead = merge([cyl(0.20, 0.26, 0.29, STRAP).rotateX(Math.PI / 2), T(cone(0.20, 0.32, IRON).rotateX(Math.PI / 2), 0, 0, 0.29)]);
  }
  const g = new THREE.Group(), log = new THREE.Group();
  log.position.y = 1.19;
  const head = siegeMesh(ramHead!); head.position.z = 1.84;
  log.add(siegeMesh(ramLog!), head); g.add(siegeMesh(ramFrame), log);
  attachWheels(g, ramWheels!, RAM_WHEEL_RADIUS, -1.08, 1.08);
  g.userData.log = log;
  return g;
}

/** Catapult arm angle about x: resting (cup low at the back) and at the top of the throw (cup up and forward of the pivot). */
export const ARM_REST = -0.68, ARM_THROW = 1.9;

export function buildCatapult(): THREE.Group {
  if (!catapultFrame) {
    catapultWheels = wheelset(CATAPULT_WHEEL_RADIUS);
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const x = side * 0.59;
      parts.push(box(0.23, 0.24, 3.13, BEAM, x, 0.63, 0));
      parts.push(between([x, 0.69, -0.98], [x, 1.84, 0.45], 0.17, WOOD), between([x, 0.69, 1.18], [x, 1.84, 0.45], 0.18, WOOD));
      parts.push(across(0.19, 0.11, STRAP, side * 0.72, 1.69, 0.45), across(0.14, 0.075, ROPE, side * 0.54, 0.92, -0.98));
      parts.push(between([side * 0.69, 0.92, -1], [side * 0.7, 1.25, -1.2], 0.082, DARK));
    }
    parts.push(box(1.44, 0.18, 0.24, BEAM, 0, 0.67, -1.3), box(1.45, 0.18, 0.24, BEAM, 0, 0.67, 1.36), across(0.12, 1.49, DARK, 0, 1.69, 0.45), across(0.10, 1.42, ROPE, 0, 0.92, -0.98));
    catapultFrame = merge(parts);
    catapultArm = merge([box(0.19, 0.20, 2.85, BEAM, 0, 0, -0.93), box(0.23, 0.24, 0.21, STRAP, 0, 0, -0.08), box(0.22, 0.21, 0.10, STRAP, 0, 0, -1.72), cyl(0.34, 0.26, 0.14, DARK, 0, 0.08, -2.30, 10), T(tint(new THREE.TorusGeometry(0.28, 0.035, 4, 12).rotateX(-Math.PI / 2), STRAP), 0, 0.15, -2.3)]);
    catapultStone = tint(new THREE.IcosahedronGeometry(0.28, 1), 0x969187);
  }
  const g = new THREE.Group(), arm = new THREE.Group();
  arm.position.set(0, 1.69, 0.45); g.add(siegeMesh(catapultFrame), arm);
  const stone = siegeMesh(catapultStone!); stone.position.set(0, 0.35, -2.3);
  arm.add(siegeMesh(catapultArm!), stone);
  attachWheels(g, catapultWheels!, CATAPULT_WHEEL_RADIUS, -1.06, 1.02);
  g.userData.arm = arm; g.userData.stone = stone;
  return g;
}

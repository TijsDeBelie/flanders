import * as THREE from 'three';

/** Stride of World.battle_siege_flat: kind (0 tower, 1 sap), x, z, facing, share (hull left / shaft dug), state, soldiers carried. */
export const SIEGE_STRIDE = 7;
export const TOWER_DOCKED = 1, TOWER_WRECK = 3, SAP_FALLEN = 1, SAP_FILLED = 2;

/** One entry of the flat array, decoded. */
export interface SiegeItem { kind: 'tower' | 'sap'; x: number; z: number; face: number; share: number; state: number; carried: number }
export function parseSiege(flat: ArrayLike<number>): SiegeItem[] {
  const out: SiegeItem[] = [];
  for (let i = 0; i + SIEGE_STRIDE <= flat.length; i += SIEGE_STRIDE) out.push({ kind: flat[i] === 0 ? 'tower' : 'sap', x: flat[i + 1], z: flat[i + 2], face: flat[i + 3], share: flat[i + 4], state: flat[i + 5], carried: flat[i + 6] });
  return out;
}

const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a36, roughness: 0.92 });
const darkWood = new THREE.MeshStandardMaterial({ color: 0x4c3822, roughness: 0.95 });
const hide = new THREE.MeshStandardMaterial({ color: 0x8c7a58, roughness: 1 });
const iron = new THREE.MeshStandardMaterial({ color: 0x40444a, roughness: 0.6, metalness: 0.5 });
const earth = new THREE.MeshStandardMaterial({ color: 0x5a4630, roughness: 1 });

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
}

/** A siege tower: a four-storey timber frame on wheels, covered with wet hides, with a bridge that drops onto the wall when it docks. Faces +z locally. */
function makeTower(): { g: THREE.Group; bridge: THREE.Mesh; hull: THREE.Group } {
  const g = new THREE.Group(), hull = new THREE.Group();
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    hull.add(box(0.28, 7.4, 0.28, wood, sx * 1.5, 4.1, sz * 1.5));
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 12), darkWood); wheel.rotation.z = Math.PI / 2; wheel.position.set(sx * 1.75, 0.55, sz * 1.2); wheel.castShadow = true; hull.add(wheel);
  }
  for (const y of [0.9, 3.0, 5.1, 7.3]) { hull.add(box(3.4, 0.2, 3.4, darkWood, 0, y, 0)); }
  hull.add(box(3.3, 6.2, 0.14, hide, 0, 4.0, 1.62)); hull.add(box(3.3, 6.2, 0.14, hide, 0, 4.0, -1.62));
  hull.add(box(0.14, 6.2, 3.3, hide, 1.62, 4.0, 0)); hull.add(box(0.14, 6.2, 3.3, hide, -1.62, 4.0, 0));
  hull.add(box(3.6, 0.5, 3.6, wood, 0, 7.7, 0));   // the fighting top
  for (const sx of [-1.5, -0.5, 0.5, 1.5]) hull.add(box(0.3, 0.45, 0.3, wood, sx, 8.1, 1.7));
  const flag = box(0.06, 1.1, 0.9, new THREE.MeshStandardMaterial({ color: 0x8a1c1c, roughness: 0.9, side: THREE.DoubleSide }), 0, 9.0, 0); hull.add(flag);
  hull.add(box(0.06, 1.8, 0.06, darkWood, 0, 8.6, -0.4));
  const bridge = box(1.8, 0.16, 2.6, wood, 0, 0, 0); bridge.position.set(0, 7.0, 3.0); hull.add(bridge);   // raised until docked: see sync
  g.add(hull);
  return { g, bridge, hull };
}

/** A sapping shed: a low timber roof under hides over the shaft, a spoil heap beside it and a few props. */
function makeSap(): { g: THREE.Group; heap: THREE.Mesh; shed: THREE.Group } {
  const g = new THREE.Group(), shed = new THREE.Group();
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 1.7, 1.2, 4, 1), hide); roof.rotation.y = Math.PI / 4; roof.scale.set(1.5, 1, 1); roof.position.y = 1.25; roof.castShadow = true; shed.add(roof);
  for (const sx of [-1.2, 1.2]) for (const sz of [-0.8, 0.8]) shed.add(box(0.16, 1.2, 0.16, wood, sx, 0.6, sz));
  shed.add(box(0.5, 0.4, 0.8, darkWood, 0.2, 0.2, 1.0)); shed.add(box(0.1, 0.9, 0.1, iron, -0.9, 0.5, 1.1));
  g.add(shed);
  const heap = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 10), earth); heap.position.set(2.0, 0.4, 0); heap.castShadow = true; g.add(heap);
  return { g, heap, shed };
}

/** The attackers' siege towers and saps, drawn from World.battle_siege_flat. Owns a group to add to the scene; `height(x, z)` gives the ground. */
export class SiegeWorks {
  readonly group = new THREE.Group();
  private towers: ReturnType<typeof makeTower>[] = [];
  private saps: ReturnType<typeof makeSap>[] = [];
  private height: (x: number, z: number) => number;
  /** Called once when a siege tower's bridge comes down on the wall (x, z of the tower). */
  onDock?: (x: number, z: number) => void;
  private docked = new Set<number>();
  constructor(height: (x: number, z: number) => number) { this.height = height; }

  sync(flat: ArrayLike<number>, t = 0) {
    const items = parseSiege(flat);
    const towers = items.filter(i => i.kind === 'tower'), saps = items.filter(i => i.kind === 'sap');
    while (this.towers.length < towers.length) { const m = makeTower(); this.group.add(m.g); this.towers.push(m); }
    while (this.saps.length < saps.length) { const m = makeSap(); this.group.add(m.g); this.saps.push(m); }
    this.towers.forEach((m, i) => {
      const it = towers[i]; m.g.visible = !!it;
      if (!it) return;
      m.g.position.set(it.x, this.height(it.x, it.z), it.z); m.g.rotation.y = Math.PI / 2 - it.face;
      const was = this.docked.has(i), now = it.state === TOWER_DOCKED;
      if (now && !was) { this.docked.add(i); if (t > 0) this.onDock?.(it.x, it.z); } else if (!now && was) this.docked.delete(i);
      const wreck = it.state === TOWER_WRECK;
      m.hull.rotation.z = wreck ? 0.35 : 0; m.hull.position.y = wreck ? -0.8 : 0; m.hull.scale.y = wreck ? 0.55 : 0.6 + 0.4 * Math.max(0.35, it.share);   // a battered tower sags
      m.bridge.position.y = it.state === TOWER_DOCKED ? 7.0 : 7.0; m.bridge.rotation.x = it.state === TOWER_DOCKED ? 0 : -1.25;   // the bridge drops when it docks
      m.bridge.position.z = it.state === TOWER_DOCKED ? 3.0 : 1.9;
      if (it.state !== TOWER_WRECK && it.state !== TOWER_DOCKED) m.hull.rotation.x = Math.sin(t * 3 + i) * 0.006;   // a slight roll as it trundles
    });
    this.saps.forEach((m, i) => {
      const it = saps[i]; m.g.visible = !!it && it.state !== SAP_FALLEN;
      if (!it) return;
      m.g.position.set(it.x, this.height(it.x, it.z), it.z); m.g.rotation.y = Math.PI / 2 - it.face;
      const dug = it.state === SAP_FILLED ? 0 : it.share;
      m.heap.scale.set(0.4 + 1.6 * dug, 0.3 + 1.2 * dug, 0.4 + 1.6 * dug);
      m.shed.visible = it.state !== SAP_FILLED;
    });
  }
}

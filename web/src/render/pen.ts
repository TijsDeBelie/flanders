import * as THREE from 'three';
import type { Terrain } from './terrain';

/** The wall pen's preview: a small post for every piece that would be laid, green where it can go and red where it cannot. */
export class PenPreview {
  mesh: THREE.InstancedMesh;
  line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe08a, depthTest: false, transparent: true, opacity: 0.9 }));
  private m = new THREE.Matrix4(); private c = new THREE.Color();

  constructor(private terrain: Terrain, max = 400) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 1.9, 0.7).translate(0, 0.95, 0), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 }), max);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 9;
    this.line.renderOrder = 10; this.line.frustumCulled = false; this.line.visible = false;
  }

  get objects() { return [this.mesh, this.line]; }

  /** `path` is the outline drawn as a line (a closed figure repeats its first point at the end). */
  set(pieces: { x: number; z: number; ok: boolean }[], path: { x: number; z: number }[]) {
    const n = Math.min(pieces.length, this.mesh.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      const p = pieces[i]; this.m.makeTranslation(p.x, Math.max(0, this.terrain.heightAt(p.x, p.z)), p.z); this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c.setHex(p.ok ? 0x55e07a : 0xe0503a));
    }
    this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    const y = (x: number, z: number) => Math.max(0, this.terrain.heightAt(x, z)) + 0.3;
    this.line.geometry.setFromPoints(path.map(q => new THREE.Vector3(q.x, y(q.x, q.z), q.z))); this.line.visible = path.length > 1;
  }

  clear() { this.mesh.count = 0; this.line.visible = false; }
}

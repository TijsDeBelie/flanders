import { HALF, NV, type Terrain } from '../render/terrain';
import { DEPOSIT } from '../data';

export interface MapVillage { x: number; z: number; r: number; color: string; name?: string; mine?: boolean; buildings: { x: number; z: number; r: number; kind: number }[] }

/** The realm seen from above: terrain, every village with a box for each of its buildings, field armies, deposits and where the camera looks.
 *  One class draws both the small corner map and the full-screen map (`size` is the canvas size in pixels). */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  /** The fog of war as a tiny image (one pixel per fog cell), redrawn only when the explored ground changes and stretched over the map in one drawImage. It used
   *  to be one fillRect per unexplored cell (up to 3600) on every draw, four times a second. */
  private fog = document.createElement('canvas');
  private fogSeen: Uint8Array | null = null;
  private static marks: Path2D[] | undefined;

  constructor(private canvas: HTMLCanvasElement, terrain: Terrain, private S = 190) {
    canvas.width = canvas.height = S;
    this.ctx = canvas.getContext('2d')!;
    this.bg = document.createElement('canvas'); this.bg.width = this.bg.height = S;
    this.paintBase(terrain);
  }

  paintBase(terrain: Terrain) {
    const S = this.S, g = this.bg.getContext('2d')!, img = g.createImageData(S, S), H = terrain.base;
    const at = (i: number, j: number) => H[Math.min(NV - 1, Math.max(0, j)) * NV + Math.min(NV - 1, Math.max(0, i))];
    const k2 = Math.max(1, Math.round(S / 190) * 2);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = Math.round((x / (S - 1)) * (NV - 1)), j = Math.round((y / (S - 1)) * (NV - 1)), h = at(i, j);
      const shade = Math.max(-1, Math.min(1, (at(i - k2, j - k2) - at(i + k2, j + k2)) * 0.12));
      let r: number, gr: number, b: number;
      if (h < 0) { const d = Math.min(1, -h / 4); r = 46 - d * 14; gr = 104 - d * 26; b = 140 - d * 26; }
      else if (h < 1.4) { r = 217; gr = 197; b = 140; }
      else if (h < 28) { const t = h / 28; r = 96 + t * 40; gr = 138 + t * -4; b = 62 + t * 14; }
      else if (h < 62) { const t = (h - 28) / 34; r = 128 + t * 20; gr = 128 + t * 12; b = 110 + t * 30; }
      else { r = gr = b = 236; }
      const k = 1 + shade * 0.35, o = (y * S + x) * 4;
      img.data[o] = Math.min(255, r * k); img.data[o + 1] = Math.min(255, gr * k); img.data[o + 2] = Math.min(255, b * k); img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  private paintFog(fog: Uint8Array) {
    const prev = this.fogSeen;
    if (prev && prev.length === fog.length) { let same = true; for (let i = 0; i < fog.length; i++) if (prev[i] !== fog[i]) { same = false; break; } if (same) return; }
    this.fogSeen = fog.slice();
    const N = Math.round(Math.sqrt(fog.length));
    if (this.fog.width !== N) this.fog.width = this.fog.height = N;
    const g = this.fog.getContext('2d')!, img = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) if (!fog[i]) { const o = i * 4; img.data[o] = 8; img.data[o + 1] = 10; img.data[o + 2] = 14; img.data[o + 3] = 158; }   // rgba(8,10,14,0.62)
    g.putImageData(img, 0, 0);
  }

  /** Mountain tunnels [x0, z0, x1, z1], drawn as short dashed lines. */
  tunnels: [number, number, number, number][] = [];

  private p(x: number, z: number): [number, number] { return [((x + HALF) / (HALF * 2)) * this.S, ((z + HALF) / (HALF * 2)) * this.S]; }

  private static tint(kind: number, base: string): string {
    if (kind === 15) return '#ffd34d';                       // town hall
    if (kind === 2 || kind === 3 || kind === 19 || kind === 26) return '#d4d4d4';   // walls, towers, barracks
    if (kind === 0) return '#f0e2bd';                        // houses
    return base;
  }

  draw(o: { fog?: Uint8Array; neutrals?: Float32Array; villages: MapVillage[]; armies?: { x: number; z: number; color: string }[]; deposits: Float32Array; showDeposits: boolean; view: { x: number; z: number }[] | null; target: { x: number; z: number } }) {
    const c = this.ctx, S = this.S, big = S > 400, f = S / (HALF * 2);
    c.drawImage(this.bg, 0, 0);
    if (o.showDeposits) for (let i = 0; i < o.deposits.length; i += 5) {
      const [x, y] = this.p(o.deposits[i + 1], o.deposits[i + 2]); const fill = o.deposits[i + 4] > 0 ? o.deposits[i + 3] / o.deposits[i + 4] : 0; c.globalAlpha = 0.3 + 0.7 * Math.min(1, fill * 1.5); c.fillStyle = DEPOSIT[o.deposits[i]].color; c.strokeStyle = '#000a'; c.beginPath(); c.arc(x, y, big ? 4 : 2.6, 0, 7); c.fill(); c.stroke();
    }
    c.globalAlpha = 1;
    c.strokeStyle = '#ffe9a8'; c.lineWidth = big ? 2.4 : 1.6; c.setLineDash([3, 2]);
    for (const t of this.tunnels) { const [a, b] = this.p(t[0], t[1]), [d, e] = this.p(t[2], t[3]); c.beginPath(); c.moveTo(a, b); c.lineTo(d, e); c.stroke(); }
    c.setLineDash([]);
    for (const v of o.villages) {
      const [x, y] = this.p(v.x, v.z);
      c.strokeStyle = v.color; c.lineWidth = big ? 2 : 1.2; c.globalAlpha = 0.8; c.beginPath(); c.arc(x, y, Math.max(3, v.r * f), 0, 7); c.stroke(); c.globalAlpha = 1;
      // a small box for every building, seen from above
      for (const b of v.buildings) {
        const [bx, by] = this.p(b.x, b.z), s = Math.max(big ? 3 : 2, b.r * 1.6 * f);
        c.fillStyle = Minimap.tint(b.kind, v.color); c.fillRect(bx - s / 2, by - s / 2, s, s);
        c.strokeStyle = '#000b'; c.lineWidth = 0.6; c.strokeRect(bx - s / 2, by - s / 2, s, s);
      }
      if (big && v.name) { c.font = '600 15px Georgia, serif'; c.textAlign = 'center'; c.lineWidth = 4; c.strokeStyle = '#000c'; c.fillStyle = '#fff'; const ty = y - Math.max(3, v.r * f) - 6; c.strokeText(v.name, x, ty); c.fillText(v.name, x, ty); }
    }
    for (const a of o.armies ?? []) {   // field armies: small diamonds
      const [x, y] = this.p(a.x, a.z), r = big ? 5 : 3.2;
      c.fillStyle = a.color; c.strokeStyle = '#000d'; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); c.fill(); c.stroke();
    }
    // neutral places you have found: abbey, ruined castle, bandit camp, lair, the plague camp, mineshafts
    // drawn as little shapes (no font): a cross for an abbey, a tower for a ruined castle, crossed blades for a bandit camp, a banner with a skull for a lair
    const marks = Minimap.marks ??= [new Path2D('M-1.2 -4 H1.2 V-1.2 H4 V1.2 H1.2 V4 H-1.2 V1.2 H-4 V-1.2 H-1.2Z'), new Path2D('M-3.5 4 V-1 H-2.2 V-3 H-0.8 V-1.6 H0.8 V-3 H2.2 V-1 H3.5 V4Z'), new Path2D('M-4 -4 L4 4 M4 -4 L-4 4'), new Path2D('M-3.6 4.5 V-4.5 M-3.6 -4 H4.2 V1 L0.3 3 L-3.6 1Z')];   // (the last is a pole with a banner: a lair);   // parsed once, not on every draw
    if (o.neutrals) for (let i = 0; i + 3 < o.neutrals.length; i += 4) {
      const [x, y] = this.p(o.neutrals[i + 1], o.neutrals[i + 2]), k = o.neutrals[i], sc = big ? 1.6 : 1.05;
      c.save(); c.translate(x, y); c.scale(sc, sc); c.globalAlpha = o.neutrals[i + 3] ? 0.45 : 1; c.fillStyle = '#ffe9a8'; c.strokeStyle = '#000c'; c.lineWidth = 1.6 / sc; c.lineJoin = 'round';
      if (k === 4) { c.fillStyle = '#6fbf4a'; c.beginPath(); c.arc(0, 0, 3.6, 0, 6.3); c.fill(); c.stroke(); c.strokeStyle = '#102010'; c.lineWidth = 1.1 / sc; c.beginPath(); c.moveTo(-1.8, 0); c.lineTo(1.8, 0); c.moveTo(0, -1.8); c.lineTo(0, 1.8); c.stroke(); }   // the plague doctor's camp: a green sickly disc with a cross
      else if (k === 5) { c.globalAlpha = 1; c.fillStyle = o.neutrals[i + 3] ? '#5b8fd8' : '#b9b0a0'; c.beginPath(); c.moveTo(-4, 3.5); c.lineTo(0, -3.5); c.lineTo(4, 3.5); c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#111'; c.fillRect(-1.2, 0.5, 2.4, 3); }   // an abandoned mineshaft: a knoll with a dark mouth (blue while you hold it)
      else if (k === 2) { c.stroke(marks[k]); c.strokeStyle = '#ffe9a8'; c.lineWidth = 0.9 / sc; c.stroke(marks[k]); }
      else if (k === 3) { c.fillStyle = '#c0392b'; c.stroke(marks[k]); c.fill(marks[k]); c.fillStyle = '#ffe9a8'; c.beginPath(); c.arc(0.3, -1.1, 1.3, 0, 6.3); c.fill(); }   // a lair: a red banner with a pale skull on it
      else { c.stroke(marks[k]); c.fill(marks[k]); }
      c.restore();
    }
    // the fog of war: ground nobody has seen is dimmed
    if (o.fog) { this.paintFog(o.fog); c.imageSmoothingEnabled = false; c.drawImage(this.fog, 0, 0, S, S); c.imageSmoothingEnabled = true; }
    if (o.view && o.view.length === 4) {
      c.strokeStyle = '#ffffffcc'; c.lineWidth = big ? 2 : 1.2; c.beginPath();
      o.view.forEach((q, i) => { const [x, y] = this.p(q.x, q.z); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); c.stroke();
    } else { const [x, y] = this.p(o.target.x, o.target.z); c.strokeStyle = '#fff'; c.strokeRect(x - 4, y - 4, 8, 8); }
  }
}

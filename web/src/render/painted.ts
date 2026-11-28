import * as THREE from 'three';
import { tileableNoise } from './water';

/** Hand-painted building textures. Each one is drawn piece by piece (every stone, brick, plank, roof tile and straw bundle is its own shape), with the light
 *  painted in the way a stylised game paints it: a lit upper edge, a darker lower edge, a dark gap around each piece and a little hue drift from piece to piece.
 *  A height picture is drawn alongside from the same shapes (pieces stand proud, bevelled at the edges; gaps sink), and the normal map comes from that,
 *  so the bump follows the real pieces rather than guessing from how dark a pixel is.
 *
 *  Each texture keeps the layout and the average colour of the one it replaces (rows, planks per tile, roof courses; terracotta stays terracotta so the
 *  village roof palettes, which tint it, come out as before), so building tiers stay as distinct as they were. Seeded: the same picture on every load. */

export interface Painted { map: THREE.CanvasTexture; normal: THREE.DataTexture }
type RGB = [number, number, number];

const SIZE = 512;

/** A small seeded random source (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const css = (c: RGB, a = 1) => `rgba(${Math.round(Math.min(255, Math.max(0, c[0])))},${Math.round(Math.min(255, Math.max(0, c[1])))},${Math.round(Math.min(255, Math.max(0, c[2])))},${a})`;
const grey = (v: number, a = 1) => css([v * 255, v * 255, v * 255], a);
const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** The two surfaces a painter draws on: colour, and height (grey: black is the deepest gap, white the most proud). */
class Paint {
  readonly col: CanvasRenderingContext2D;
  readonly hgt: CanvasRenderingContext2D;
  readonly colCanvas: HTMLCanvasElement;
  readonly hgtCanvas: HTMLCanvasElement;
  readonly rnd: () => number;
  constructor(readonly s: number, seed: number) {
    const mk = () => { const c = document.createElement('canvas'); c.width = c.height = s; return c; };
    this.colCanvas = mk(); this.hgtCanvas = mk();
    this.col = this.colCanvas.getContext('2d', { willReadFrequently: true })!;
    this.hgt = this.hgtCanvas.getContext('2d', { willReadFrequently: true })!;
    this.rnd = rng(seed);
  }
  r(a: number, b: number) { return a + (b - a) * this.rnd(); }
  /** A colour drifted a little from `c`: brightness by up to ±`v`, and towards warm or cool by up to `h`. */
  vary(c: RGB, v: number, h: number): RGB {
    const k = 1 + this.r(-v, v), w = this.r(-h, h);
    return [c[0] * k * (1 + w), c[1] * k * (1 + w * 0.25), c[2] * k * (1 - w)];
  }
  /** Draw at (x, y) and at every copy that wraps onto the tile, so pieces that cross an edge continue on the other side (seamless). */
  wrap(x: number, y: number, w: number, h: number, fn: (x: number, y: number) => void) {
    const s = this.s;
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) if (x + dx < s && x + dx + w > 0 && y + dy < s && y + dy + h > 0) fn(x + dx, y + dy);
  }
  fill(c: RGB, h: number) { this.col.fillStyle = css(c); this.col.fillRect(0, 0, this.s, this.s); this.hgt.fillStyle = grey(h); this.hgt.fillRect(0, 0, this.s, this.s); }
}

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

/** One rounded block (stone, brick, tile, cobble), painted and raised: dark rim, lit body with a soft top-to-bottom fall-off, a thin lit upper edge; on the
 *  height picture a bevel in four steps (smoothed afterwards). `top` is the height of its face (0..1). */
function block(p: Paint, x: number, y: number, w: number, h: number, r: number, c: RGB, bevel: number, top = 1) {
  p.wrap(x, y, w, h, (x, y) => {
    const g = p.col;
    rrect(g, x, y, w, h, r); g.fillStyle = css(mul(c, 0.66)); g.fill();
    const b = Math.min(bevel, w / 4, h / 4);
    rrect(g, x + b * 0.5, y + b * 0.35, w - b * 1.1, h - b * 1.15, r * 0.8);
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, css(mul(c, 1.13))); grad.addColorStop(0.45, css(c)); grad.addColorStop(1, css(mul(c, 0.86)));
    g.fillStyle = grad; g.fill();
    g.strokeStyle = css(mul(c, 1.32), 0.55); g.lineWidth = Math.max(1, b * 0.35);
    g.beginPath(); g.moveTo(x + r + b * 0.4, y + b * 0.55); g.lineTo(x + w - r - b * 0.4, y + b * 0.55); g.stroke();
    const hg = p.hgt;
    for (let k = 0; k < 4; k++) { const i = b * k / 3; rrect(hg, x + i, y + i, w - 2 * i, h - 2 * i, Math.max(1, r - i * 0.5)); hg.fillStyle = grey(top * (0.5 + 0.5 * (k + 1) / 4)); hg.fill(); }
  });
}

/** A few darker chips and pits on a block's face, and some lighter flecks. */
function chips(p: Paint, x: number, y: number, w: number, h: number, c: RGB, n: number) {
  for (let i = 0; i < n; i++) {
    const cx = x + p.r(0.15, 0.85) * w, cy = y + p.r(0.2, 0.85) * h, rr = p.r(1, 3.2);
    p.wrap(cx - rr, cy - rr, 2 * rr, 2 * rr, (px, py) => {
      const dark = p.rnd() < 0.7;
      p.col.fillStyle = css(mul(c, dark ? 0.78 : 1.18), 0.7); p.col.beginPath(); p.col.arc(px + rr, py + rr, rr, 0, 7); p.col.fill();
      if (dark) { p.hgt.fillStyle = grey(0.62, 0.8); p.hgt.beginPath(); p.hgt.arc(px + rr, py + rr, rr, 0, 7); p.hgt.fill(); }
    });
  }
}

/** Courses of stone blocks of uneven length. */
function stoneWall(p: Paint, base: RGB, mortar: RGB, rows: number, perRow: [number, number]) {
  const s = p.s, rh = s / rows, gap = s * 0.009;
  p.fill(mortar, 0.08);
  for (let r = 0; r < rows; r++) {
    let x = p.r(0, s / perRow[0]);
    const end = x + s;
    while (x < end - 1) {
      let w = s / p.r(perRow[0], perRow[1]);
      if (end - x < w * 1.45) w = end - x;   // the last stone of a course closes the loop exactly, so the course wraps
      const c = p.vary(base, 0.11, 0.06), y = r * rh + p.r(-1, 1);
      block(p, x + gap / 2, y + gap / 2, w - gap, rh - gap, s * 0.018, c, s * 0.017, p.r(0.86, 1));
      chips(p, x, y, w, rh, c, 3);
      x += w;
    }
  }
}

/** Bricks in staggered rows. */
function brickWall(p: Paint, base: RGB, mortar: RGB, rows: number, cols: number, skip: (y0: number, y1: number) => boolean = () => false) {
  const s = p.s, rh = s / rows, cw = s / cols, gap = s * 0.012;
  p.fill(mortar, 0.1);
  for (let r = 0; r < rows; r++) {
    if (skip(r * rh, (r + 1) * rh)) continue;
    const off = (r % 2) * cw / 2;
    for (let c = 0; c < cols; c++) {
      const col = p.vary(base, 0.12, 0.08);
      block(p, c * cw + off + gap / 2, r * rh + gap / 2, cw - gap, rh - gap, s * 0.008, col, s * 0.01, p.r(0.85, 1));
      chips(p, c * cw + off, r * rh, cw, rh, col, 1);
    }
  }
}

/** Wood grain along a plank: thin wavy darker and lighter lines, and now and then a knot. Vertical planks run along y. */
function grain(p: Paint, x: number, y: number, w: number, h: number, c: RGB, along: 'x' | 'y') {
  const g = p.col, n = Math.round((along === 'y' ? w : h) / 4);
  for (let i = 0; i < n; i++) {
    const t = p.r(0.08, 0.92), dark = p.rnd() < 0.6, amp = p.r(0.6, 2.2), freq = p.r(1.5, 4), ph = p.r(0, 6.3);
    g.strokeStyle = css(mul(c, dark ? p.r(0.72, 0.86) : p.r(1.1, 1.22)), p.r(0.35, 0.7)); g.lineWidth = p.r(0.7, 1.6);
    g.beginPath();
    const L = along === 'y' ? h : w;
    for (let k = 0; k <= 24; k++) {
      const a = k / 24, off = Math.sin(a * freq * Math.PI + ph) * amp;
      const px = along === 'y' ? x + t * w + off : x + a * L, py = along === 'y' ? y + a * L : y + t * h + off;
      if (k) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.stroke();
  }
  if (p.rnd() < 0.45) {
    const kx = along === 'y' ? x + p.r(0.3, 0.7) * w : x + p.r(0.15, 0.85) * w, ky = along === 'y' ? y + p.r(0.15, 0.85) * h : y + p.r(0.3, 0.7) * h, kr = Math.min(w, h) * p.r(0.08, 0.14);
    g.fillStyle = css(mul(c, 0.62), 0.8); g.beginPath(); g.ellipse(kx, ky, along === 'y' ? kr : kr * 1.6, along === 'y' ? kr * 1.6 : kr, 0, 0, 7); g.fill();
    g.strokeStyle = css(mul(c, 0.8), 0.6); g.lineWidth = 1.2; g.beginPath(); g.ellipse(kx, ky, (along === 'y' ? kr : kr * 1.6) * 1.7, (along === 'y' ? kr * 1.6 : kr) * 1.7, 0, 0, 7); g.stroke();
    p.hgt.fillStyle = grey(0.7, 0.6); p.hgt.beginPath(); p.hgt.ellipse(kx, ky, kr * 1.3, kr * 1.3, 0, 0, 7); p.hgt.fill();
  }
}

/** A plank or beam: lit along one long edge, shaded along the other, slightly crowned, with grain. */
function plank(p: Paint, x: number, y: number, w: number, h: number, c: RGB, along: 'x' | 'y', top = 1) {
  const g = p.col, b = Math.min(w, h) * 0.12;
  g.fillStyle = css(mul(c, 0.62)); g.fillRect(x, y, w, h);
  const grad = along === 'y' ? g.createLinearGradient(x, 0, x + w, 0) : g.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, css(mul(c, 1.18))); grad.addColorStop(0.18, css(mul(c, 1.04))); grad.addColorStop(0.8, css(mul(c, 0.95))); grad.addColorStop(1, css(mul(c, 0.8)));
  g.fillStyle = grad;
  if (along === 'y') g.fillRect(x + b * 0.4, y, w - b * 1.2, h); else g.fillRect(x, y + b * 0.4, w, h - b * 1.2);
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); grain(p, x, y, w, h, c, along); g.restore();
  const hg = p.hgt;
  const hgrad = along === 'y' ? hg.createLinearGradient(x, 0, x + w, 0) : hg.createLinearGradient(0, y, 0, y + h);
  hgrad.addColorStop(0, grey(top * 0.45)); hgrad.addColorStop(0.15, grey(top * 0.9)); hgrad.addColorStop(0.5, grey(top)); hgrad.addColorStop(0.85, grey(top * 0.9)); hgrad.addColorStop(1, grey(top * 0.45));
  hg.fillStyle = hgrad; hg.fillRect(x, y, w, h);
}

function planks(p: Paint, base: RGB, n: number) {
  const s = p.s, w = s / n;
  p.fill(mul(base, 0.45), 0.05);
  for (let i = 0; i < n; i++) {
    const c = p.vary(base, 0.1, 0.05), x = i * w;
    plank(p, x + 1.5, 0, w - 3, s, c, 'y', p.r(0.88, 1));
    // one board end per plank, at a different height in each: a dark joint across the plank
    const j = p.r(0.1, 0.9) * s;
    p.col.fillStyle = css(mul(base, 0.4)); p.col.fillRect(x + 1.5, j - 1.5, w - 3, 3);
    p.col.fillStyle = css(mul(c, 1.2), 0.6); p.col.fillRect(x + 1.5, j + 1.5, w - 3, 1.5);
    p.hgt.fillStyle = grey(0.15); p.hgt.fillRect(x + 1.5, j - 1.5, w - 3, 3);
  }
}

let mottleField: Float32Array | null = null;
/** Soft mottling over the whole colour picture (weathering, damp), at three sizes, without changing the average colour much. One noise field serves every
 *  texture, read from a different offset in each (it tiles, so any offset is seamless): making a fresh field per texture took about 30 ms each. */
function mottle(p: Paint, amount: number, seed: number) {
  const s = p.s, img = p.col.getImageData(0, 0, s, s), d = img.data;
  const n = mottleField ??= tileableNoise(s, [[3, 0.55, false], [9, 0.3, false], [40, 0.15, false]], 9001);
  const ox = (seed * 197) % s, oy = (seed * 331) % s;
  for (let y = 0; y < s; y++) {
    const row = ((y + oy) % s) * s;
    for (let x = 0; x < s; x++) { const i = y * s + x, k = 1 + (n[row + ((x + ox) % s)] - 0.5) * amount; d[i * 4] *= k; d[i * 4 + 1] *= k; d[i * 4 + 2] *= k; }
  }
  p.col.putImageData(img, 0, 0);
}

/** Lime plaster: pale, softly mottled, a few hairline cracks. */
function plasterPaint(p: Paint, base: RGB, x = 0, y = 0, w = p.s, h = p.s) {
  const g = p.col;
  g.fillStyle = css(base); g.fillRect(x, y, w, h);
  p.hgt.fillStyle = grey(0.55); p.hgt.fillRect(x, y, w, h);
  for (let i = 0; i < Math.round(w * h / 9000); i++) {
    const cx = x + p.r(0, w), cy = y + p.r(0, h), rr = p.r(10, 40), c = p.vary(base, 0.08, 0.05);
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, rr); rg.addColorStop(0, css(c, 0.5)); rg.addColorStop(1, css(c, 0));
    g.fillStyle = rg; g.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
    const hr = p.hgt.createRadialGradient(cx, cy, 0, cx, cy, rr); hr.addColorStop(0, grey(p.r(0.5, 0.62), 0.6)); hr.addColorStop(1, grey(0.55, 0));
    p.hgt.fillStyle = hr; p.hgt.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
  }
  for (let i = 0; i < Math.round(w * h / 60000); i++) {
    let cx = x + p.r(0.1, 0.9) * w, cy = y + p.r(0.1, 0.9) * h;
    g.strokeStyle = css(mul(base, 0.62), 0.45); g.lineWidth = 0.9; p.hgt.strokeStyle = grey(0.35, 0.7); p.hgt.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, cy); p.hgt.beginPath(); p.hgt.moveTo(cx, cy);
    for (let k = 0; k < 5; k++) { cx += p.r(-9, 9); cy += p.r(2, 10); g.lineTo(cx, cy); p.hgt.lineTo(cx, cy); }
    g.stroke(); p.hgt.stroke();
  }
}

/** Overlapping courses (roof tiles, slates): drawn from the eaves (bottom) up, each course lying over the top of the one below and casting a short shadow on it. */
function courses(p: Paint, base: RGB, rows: number, cols: number, shape: 'tile' | 'slate') {
  const s = p.s, rh = s / rows, cw = s / cols, gap = s * 0.006;
  p.fill(mul(base, 0.42), 0.05);
  for (let r = rows; r >= -1; r--) {
    const off = ((r % 2) + 2) % 2 * cw / 2 + (shape === 'slate' ? p.r(-cw * 0.08, cw * 0.08) : 0), y = r * rh;
    for (let c = -1; c <= cols; c++) {
      const col = p.vary(base, shape === 'tile' ? 0.12 : 0.1, shape === 'tile' ? 0.07 : 0.09), x = c * cw + off + gap / 2, w = cw - gap, h = rh * 1.32;
      p.wrap(x, y - rh * 0.32, w, h + 6, (x, yy) => {
        const g = p.col, top = yy, bot = yy + h, rad = shape === 'tile' ? w * 0.42 : w * 0.1;
        // the shadow this piece casts on the course below
        const sh = g.createLinearGradient(0, bot - 2, 0, bot + rh * 0.22); sh.addColorStop(0, 'rgba(0,0,0,0.38)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = sh; g.fillRect(x + 2, bot - 2, w - 4, rh * 0.22);
        g.beginPath(); g.moveTo(x, top); g.lineTo(x + w, top); g.lineTo(x + w, bot - rad); g.quadraticCurveTo(x + w, bot, x + w - rad, bot); g.lineTo(x + rad, bot); g.quadraticCurveTo(x, bot, x, bot - rad); g.closePath();
        g.fillStyle = css(mul(col, 0.7)); g.fill();
        const body = g.createLinearGradient(x, 0, x + w, 0);
        if (shape === 'tile') { body.addColorStop(0, css(mul(col, 0.82))); body.addColorStop(0.35, css(mul(col, 1.12))); body.addColorStop(0.7, css(col)); body.addColorStop(1, css(mul(col, 0.78))); }
        else { body.addColorStop(0, css(mul(col, 1.06))); body.addColorStop(1, css(mul(col, 0.92))); }
        g.save(); g.clip(); g.fillStyle = body; g.fillRect(x + 1.5, top, w - 3, h - 2.5);
        const fall = g.createLinearGradient(0, top, 0, bot); fall.addColorStop(0, 'rgba(0,0,0,0.22)'); fall.addColorStop(0.5, 'rgba(0,0,0,0)'); fall.addColorStop(1, 'rgba(255,255,255,0.08)');
        g.fillStyle = fall; g.fillRect(x, top, w, h);
        g.strokeStyle = css(mul(col, 1.35), 0.5); g.lineWidth = 1.6; g.beginPath(); g.moveTo(x + rad * 0.7, bot - 2.5); g.lineTo(x + w - rad * 0.7, bot - 2.5); g.stroke();
        g.restore();
        const hg = p.hgt, hgr = hg.createLinearGradient(0, top, 0, bot); hgr.addColorStop(0, grey(0.3)); hgr.addColorStop(0.85, grey(0.95)); hgr.addColorStop(1, grey(1));
        hg.beginPath(); hg.moveTo(x, top); hg.lineTo(x + w, top); hg.lineTo(x + w, bot - rad); hg.quadraticCurveTo(x + w, bot, x + w - rad, bot); hg.lineTo(x + rad, bot); hg.quadraticCurveTo(x, bot, x, bot - rad); hg.closePath();
        hg.fillStyle = hgr; hg.fill();
        if (shape === 'tile') { const across = hg.createLinearGradient(x, 0, x + w, 0); across.addColorStop(0, grey(0, 0.35)); across.addColorStop(0.4, grey(1, 0.15)); across.addColorStop(1, grey(0, 0.35)); hg.fillStyle = across; hg.fill(); }
      });
    }
  }
}

/** Thatch: shaggy courses of straw, each lying over the top of the one below, with its ragged lower edge in shadow. */
function thatchPaint(p: Paint, base: RGB, rows: number) {
  const s = p.s, rh = s / rows;
  p.fill(mul(base, 0.55), 0.2);
  for (let r = rows; r >= -1; r--) {
    const y0 = r * rh - rh * 0.15, y1 = (r + 1) * rh + rh * 0.1;
    const g = p.col, sh = g.createLinearGradient(0, y1 - 4, 0, y1 + rh * 0.3); sh.addColorStop(0, 'rgba(40,25,5,0.45)'); sh.addColorStop(1, 'rgba(40,25,5,0)');
    g.fillStyle = sh; g.fillRect(0, y1 - 4, s, rh * 0.3);
    if (y1 + rh * 0.3 > s) g.fillRect(0, y1 - 4 - s, s, rh * 0.3);
    const fall = g.createLinearGradient(0, y0, 0, y1); fall.addColorStop(0, css(mul(base, 0.72))); fall.addColorStop(0.7, css(base)); fall.addColorStop(1, css(mul(base, 1.08)));
    for (const dy of [0, -s, s]) { if (y0 + dy > s || y1 + dy < 0) continue; g.fillStyle = fall; g.save(); g.translate(0, dy); g.fillRect(0, y0, s, y1 - y0 - rh * 0.08); g.restore(); }
    const hg = p.hgt, hgr = hg.createLinearGradient(0, y0, 0, y1); hgr.addColorStop(0, grey(0.3)); hgr.addColorStop(1, grey(0.95));
    for (const dy of [0, -s, s]) { if (y0 + dy > s || y1 + dy < 0) continue; hg.fillStyle = hgr; hg.save(); hg.translate(0, dy); hg.fillRect(0, y0, s, y1 - y0 - rh * 0.08); hg.restore(); }
    // straw: many short strokes running down the slope, the lowest ones hanging over the edge in a ragged line
    const n = Math.round(s * 1.6);
    for (let i = 0; i < n; i++) {
      const x = p.r(0, s), len = p.r(rh * 0.35, rh * 0.95), yb = y1 + p.r(-rh * 0.12, rh * 0.08), ya = yb - len, lean = p.r(-3, 3);
      const c = p.vary(base, 0.2, 0.08), lit = p.rnd() < 0.35;
      p.wrap(x - 4, ya, 8, len, (px, py) => {
        g.strokeStyle = css(lit ? mul(c, 1.25) : c, p.r(0.45, 0.9)); g.lineWidth = p.r(0.8, 1.8);
        g.beginPath(); g.moveTo(px + 4, py); g.lineTo(px + 4 + lean, py + len); g.stroke();
        hg.strokeStyle = grey(p.r(0.75, 1), 0.5); hg.lineWidth = 1.2; hg.beginPath(); hg.moveTo(px + 4, py); hg.lineTo(px + 4 + lean, py + len); hg.stroke();
      });
    }
  }
}

function cobbles(p: Paint, base: RGB, dirt: RGB, n: number) {
  const s = p.s, cell = s / n;
  p.fill(dirt, 0.05);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const w = cell * p.r(0.78, 0.94), h = cell * p.r(0.72, 0.9), cx = x * cell + (y % 2) * cell / 2 + p.r(-cell, cell) * 0.06, cy = y * cell + p.r(-cell, cell) * 0.06;
    const c = p.vary(base, 0.14, 0.07);
    block(p, cx + (cell - w) / 2, cy + (cell - h) / 2, w, h, Math.min(w, h) * 0.45, c, cell * 0.16, p.r(0.8, 1));
  }
}

/** Rows of a crop across the field (along x), `rows` per tile: earth between them, the plants drawn as many small lit leaves or stalks. */
function cropRows(p: Paint, soil: RGB, plant: RGB, rows: number, kind: 'leaf' | 'stalk' | 'shoot') {
  const s = p.s, rh = s / rows;
  p.fill(soil, 0.25);
  // the earth: a darker furrow down the middle of each gap, a few clods
  for (let r = 0; r < rows; r++) {
    const y = r * rh, g = p.col.createLinearGradient(0, y, 0, y + rh);
    g.addColorStop(0, css(mul(soil, 1.08))); g.addColorStop(0.5, css(mul(soil, 0.8))); g.addColorStop(1, css(mul(soil, 1.08)));
    p.col.fillStyle = g; p.col.fillRect(0, y, s, rh);
  }
  for (let i = 0; i < s * 0.8; i++) { const x = p.r(0, s), y = p.r(0, s), rr = p.r(1, 2.5); p.col.fillStyle = css(mul(soil, p.r(0.7, 1.25)), 0.7); p.col.beginPath(); p.col.arc(x, y, rr, 0, 7); p.col.fill(); }
  for (let r = 0; r < rows; r++) {
    const cy = (r + 0.5) * rh, band = rh * (kind === 'shoot' ? 0.32 : kind === 'leaf' ? 0.62 : 0.78);
    const n = Math.round(s * (kind === 'stalk' ? 2.2 : kind === 'leaf' ? 0.55 : 0.5));
    for (let i = 0; i < n; i++) {
      const x = p.r(0, s), y = cy + p.r(-band / 2, band / 2), c = p.vary(plant, 0.16, 0.08), lit = p.rnd() < 0.3;
      if (kind === 'stalk') {
        const len = p.r(rh * 0.25, rh * 0.5);
        p.wrap(x - 2, y - len, 4, len, (px, py) => {
          p.col.strokeStyle = css(lit ? mul(c, 1.22) : c, 0.85); p.col.lineWidth = p.r(1, 2); p.col.beginPath(); p.col.moveTo(px + 2, py + len); p.col.lineTo(px + 2 + p.r(-1.5, 1.5), py); p.col.stroke();
          p.col.fillStyle = css(mul(c, 1.15), 0.9); p.col.beginPath(); p.col.ellipse(px + 2, py + 1, 1.4, 3, 0, 0, 7); p.col.fill();
          p.hgt.strokeStyle = grey(p.r(0.7, 1)); p.hgt.lineWidth = 1.5; p.hgt.beginPath(); p.hgt.moveTo(px + 2, py + len); p.hgt.lineTo(px + 2, py); p.hgt.stroke();
        });
      } else {
        const rx = kind === 'leaf' ? p.r(3, 7) : p.r(1.5, 3.5), ry = rx * p.r(0.5, 0.8), a = p.r(0, 3.14);
        p.wrap(x - rx, y - rx, rx * 2, rx * 2, (px, py) => {
          const cx = px + rx, cyy = py + rx;
          p.col.fillStyle = css(mul(c, 0.7), 0.8); p.col.beginPath(); p.col.ellipse(cx + 1, cyy + 1.5, rx, ry, a, 0, 7); p.col.fill();   // its shadow
          p.col.fillStyle = css(lit ? mul(c, 1.2) : c); p.col.beginPath(); p.col.ellipse(cx, cyy, rx, ry, a, 0, 7); p.col.fill();
          p.hgt.fillStyle = grey(p.r(0.75, 1)); p.hgt.beginPath(); p.hgt.ellipse(cx, cyy, rx, ry, a, 0, 7); p.hgt.fill();
        });
      }
    }
  }
}

/** Height picture → tangent-space normal map. Smoothed twice first (the bevels are drawn in steps). The rows are flipped to match the colour texture,
 *  which three uploads upside down (a canvas has its first row at the top, a texture at v = 0). */
function normalFromHeight(src: HTMLCanvasElement, strength: number) {
  const s = src.width, data = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, s, s).data;
  const h = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) h[i] = data[i * 4] / 255;
  // a 3×3 box blur, twice, done as separate passes across and down (wrapping at the edges)
  const tmp = new Float32Array(s * s);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < s; y++) { const row = y * s; for (let x = 0; x < s; x++) tmp[row + x] = (h[row + (x === 0 ? s - 1 : x - 1)] + h[row + x] + h[row + (x === s - 1 ? 0 : x + 1)]) / 3; }
    for (let y = 0; y < s; y++) { const up = (y === 0 ? s - 1 : y - 1) * s, row = y * s, dn = (y === s - 1 ? 0 : y + 1) * s; for (let x = 0; x < s; x++) h[row + x] = (tmp[up + x] + tmp[row + x] + tmp[dn + x]) / 3; }
  }
  const out = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const l = h[y * s + ((x + s - 1) % s)], r = h[y * s + ((x + 1) % s)], u = h[((y + s - 1) % s) * s + x], d = h[((y + 1) % s) * s + x];
    let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1; const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    out.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255], ((s - 1 - y) * s + x) * 4);
  }
  const t = new THREE.DataTexture(out, s, s, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

function finish(p: Paint, name: string, strength: number): Painted {
  const map = new THREE.CanvasTexture(p.colCanvas); map.wrapS = map.wrapT = THREE.RepeatWrapping; map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8; map.name = name;
  map.userData.canvas = p.colCanvas;
  const normal = normalFromHeight(p.hgtCanvas, strength); normal.name = name + ' normal';
  return { map, normal };
}

/** The painters, by material name in buildings.ts. Base colours are those of the textures they replace. */
export const PAINTERS: Record<string, () => Painted> = {
  stone: () => { const p = new Paint(SIZE, 11); stoneWall(p, [158, 152, 140], [92, 86, 78], 5, [3, 4.6]); mottle(p, 0.22, 101); return finish(p, 'stone', 9); },
  darkstone: () => { const p = new Paint(SIZE, 12); stoneWall(p, [112, 109, 104], [52, 50, 48], 5, [3, 4.6]); mottle(p, 0.22, 102); return finish(p, 'darkstone', 9); },
  brick: () => { const p = new Paint(SIZE, 13); brickWall(p, [160, 80, 58], [98, 84, 74], 8, 5); mottle(p, 0.2, 103); return finish(p, 'brick', 8); },
  flemish: () => {
    const p = new Paint(SIZE, 14), s = p.s, band = s * 0.035;
    const inBand = (y0: number, y1: number) => [0.25, 0.75].some(f => y1 > f * s - band && y0 < f * s + band);
    brickWall(p, [164, 82, 58], [98, 84, 74], 8, 5, inBand);
    for (const f of [0.25, 0.75]) { let x = p.r(0, s / 3); const end = x + s; while (x < end - 1) { let w = s / p.r(1.8, 2.8); if (end - x < w * 1.4) w = end - x; block(p, x + 2, f * s - band + 1, w - 4, band * 2 - 2, s * 0.01, p.vary([220, 210, 188], 0.06, 0.03), s * 0.012); x += w; } }
    mottle(p, 0.2, 104); return finish(p, 'flemish', 8);
  },
  cobble: () => { const p = new Paint(SIZE, 15); cobbles(p, [128, 124, 116], [86, 76, 64], 8); mottle(p, 0.18, 105); return finish(p, 'cobble', 9); },
  wood: () => { const p = new Paint(SIZE, 16); planks(p, [124, 86, 58], 6); mottle(p, 0.16, 106); return finish(p, 'wood', 7); },
  darkwood: () => { const p = new Paint(SIZE, 17); planks(p, [80, 56, 40], 6); mottle(p, 0.16, 107); return finish(p, 'darkwood', 7); },
  thatch: () => { const p = new Paint(SIZE, 18); thatchPaint(p, [190, 156, 82], 3); mottle(p, 0.2, 108); return finish(p, 'thatch', 6); },
  tile: () => { const p = new Paint(SIZE, 19); courses(p, [178, 88, 56], 6, 6, 'tile'); mottle(p, 0.16, 109); return finish(p, 'tile', 7); },
  slate: () => { const p = new Paint(SIZE, 20); courses(p, [84, 95, 112], 6, 5, 'slate'); mottle(p, 0.16, 110); return finish(p, 'slate', 6); },
  plaster: () => { const p = new Paint(SIZE, 21); plasterPaint(p, [232, 224, 204]); mottle(p, 0.12, 111); return finish(p, 'plaster', 5); },
  mud: () => {
    const p = new Paint(SIZE, 22), base: RGB = [168, 140, 100]; plasterPaint(p, base);
    for (let i = 0; i < 700; i++) { const x = p.r(0, p.s), y = p.r(0, p.s), a = p.r(0, 6.3), l = p.r(3, 9); p.col.strokeStyle = css(p.rnd() < 0.5 ? [214, 186, 110] : [98, 78, 50], p.r(0.3, 0.7)); p.col.lineWidth = 1; p.col.beginPath(); p.col.moveTo(x, y); p.col.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); p.col.stroke(); }
    mottle(p, 0.25, 112); return finish(p, 'mud', 6);
  },
  // the fields: young crop on the farm's first field, ripe wheat, leafy greens and ploughed earth on the fields a bigger farm adds
  field: () => { const p = new Paint(SIZE, 24); cropRows(p, [104, 80, 52], [104, 140, 56], 10, 'shoot'); mottle(p, 0.2, 114); return finish(p, 'field', 5); },
  wheat: () => { const p = new Paint(SIZE, 25); cropRows(p, [140, 112, 62], [204, 168, 76], 6, 'stalk'); mottle(p, 0.18, 115); return finish(p, 'wheat', 5); },
  greens: () => { const p = new Paint(SIZE, 26); cropRows(p, [96, 72, 46], [88, 132, 56], 6, 'leaf'); mottle(p, 0.18, 116); return finish(p, 'greens', 6); },
  furrows: () => { const p = new Paint(SIZE, 27); cropRows(p, [120, 90, 58], [120, 90, 58], 6, 'shoot'); mottle(p, 0.22, 117); return finish(p, 'furrows', 7); },
  // half-timbered panel: oak frame, middle post and two braces over plaster infill (one panel per tile, as before)
  timber: () => {
    const p = new Paint(SIZE, 23), s = p.s, oak: RGB = [84, 58, 36], fw = s * 0.045, pw = s * 0.03, bw = s * 0.026;
    plasterPaint(p, [236, 228, 208]);
    const brace = (x0: number, y0: number, x1: number, y1: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0), a = Math.atan2(y1 - y0, x1 - x0);
      for (const g of [p.col, p.hgt]) { g.save(); g.translate(x0, y0); g.rotate(a); g.fillStyle = g === p.col ? 'rgba(0,0,0,0.3)' : grey(0.3); g.fillRect(-2, -bw / 2 - 3, len + 4, bw + 6); g.restore(); }
      p.col.save(); p.hgt.save(); p.col.translate(x0, y0); p.hgt.translate(x0, y0); p.col.rotate(a); p.hgt.rotate(a);
      plank(p, 0, -bw / 2, len, bw, p.vary(oak, 0.08, 0.04), 'x'); p.col.restore(); p.hgt.restore();
    };
    brace(fw, s - fw, s / 2 - pw / 2, s * 0.45); brace(s - fw, s - fw, s / 2 + pw / 2, s * 0.45);
    // the frame: a shadow line inside it on the plaster, then the beams
    p.col.strokeStyle = 'rgba(0,0,0,0.28)'; p.col.lineWidth = 5; p.col.strokeRect(fw + 2, fw + 2, s - 2 * fw - 4, s - 2 * fw - 4);
    plank(p, s / 2 - pw / 2, 0, pw, s, p.vary(oak, 0.08, 0.04), 'y');
    plank(p, 0, 0, fw, s, p.vary(oak, 0.08, 0.04), 'y'); plank(p, s - fw, 0, fw, s, p.vary(oak, 0.08, 0.04), 'y');
    plank(p, 0, 0, s, fw, p.vary(oak, 0.08, 0.04), 'x'); plank(p, 0, s - fw, s, fw, p.vary(oak, 0.08, 0.04), 'x');
    mottle(p, 0.12, 113); return finish(p, 'timber', 7);
  },
};

const cache = new Map<string, Painted>();
/** A painted texture pair by name (made once, then shared). */
export function painted(name: keyof typeof PAINTERS): Painted {
  let t = cache.get(name);
  if (!t) { t = PAINTERS[name](); cache.set(name, t); }
  return t;
}

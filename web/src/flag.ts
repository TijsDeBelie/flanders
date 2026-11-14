/** A village's flag: a pattern in two colours with an emblem in a third. No game or drawing-library code in here: `drawFlag` paints onto any 2D canvas context. */
export const PALETTE = ['#b03030', '#c4572b', '#d9a21b', '#e8d44d', '#4a8a3a', '#2f7a6a', '#2f5fa8', '#4a3a8a', '#8a3a7a', '#e8e0cc', '#9a9a9a', '#2a2a2e', '#6a4a2a', '#d98aa0', '#7ac0d8', '#1f3f7a'];
export const PATTERNS = ['Plain', 'Top and bottom', 'Left and right', 'Cross', 'Saltire', 'Chevron', 'Diagonal band', 'Stripes', 'Quarters', 'Border'];
export const EMBLEMS = ['None', 'Circle', 'Star', 'Cross', 'Tower', 'Crown', 'Sword', 'Wheat'];

export interface Flag { pattern: number; c1: number; c2: number; c3: number; emblem: number }
export const DEFAULT_FLAG: Flag = { pattern: 2, c1: 6, c2: 9, c3: 2, emblem: 2 };

/** A flag as one whole number (it travels in a signed command and is part of the village's state): never 0, so 0 can mean "no flag chosen". */
export const packFlag = (f: Flag) => (1 << 24) | f.pattern | (f.c1 << 4) | (f.c2 << 8) | (f.c3 << 12) | (f.emblem << 16);
export function unpackFlag(n: number): Flag | null {
  if (!Number.isInteger(n) || n < (1 << 24) || n >= (1 << 25)) return null;
  const f = { pattern: n & 15, c1: (n >> 4) & 15, c2: (n >> 8) & 15, c3: (n >> 12) & 15, emblem: (n >> 16) & 15 };
  return f.pattern < PATTERNS.length && f.emblem < EMBLEMS.length ? f : null;
}
/** The flag's main colour as 0xRRGGBB (the village's soldiers and banners use it). */
export const flagColor = (f: Flag) => parseInt(PALETTE[f.c1].slice(1), 16);
export function randomFlag(rnd: () => number = Math.random): Flag {
  const c1 = Math.floor(rnd() * 16); let c2 = Math.floor(rnd() * 16); if (c2 === c1) c2 = (c2 + 5) % 16; let c3 = Math.floor(rnd() * 16); if (c3 === c1 || c3 === c2) c3 = (c3 + 3) % 16 === c1 || (c3 + 3) % 16 === c2 ? (c3 + 7) % 16 : (c3 + 3) % 16;
  return { pattern: Math.floor(rnd() * PATTERNS.length), c1, c2, c3, emblem: Math.floor(rnd() * EMBLEMS.length) };
}
export const sameFlag = (a: Flag, b: Flag) => packFlag(a) === packFlag(b);

const STORE = 'flanders:flag';
/** The flag chosen on the home screen (kept in this browser), or the default. */
export function loadFlag(): Flag { try { const n = Number(localStorage.getItem(STORE)); return unpackFlag(n) ?? DEFAULT_FLAG; } catch { return DEFAULT_FLAG; } }
export function saveFlag(f: Flag) { try { localStorage.setItem(STORE, String(packFlag(f))); } catch { /* storage blocked */ } }
export function hasSavedFlag(): boolean { try { return unpackFlag(Number(localStorage.getItem(STORE))) !== null; } catch { return false; } }

/** The minimal part of a 2D canvas context that `drawFlag` uses. */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern; strokeStyle: string | CanvasGradient | CanvasPattern; lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void; beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void;
  fill(): void; stroke(): void; arc(x: number, y: number, r: number, a0: number, a1: number): void; strokeRect(x: number, y: number, w: number, h: number): void;
}

/** Paint the flag into a w x h rectangle at the origin. */
export function drawFlag(g: Ctx2D, w: number, h: number, f: Flag) {
  const c1 = PALETTE[f.c1], c2 = PALETTE[f.c2], c3 = PALETTE[f.c3];
  const poly = (pts: number[][], col: string) => { g.fillStyle = col; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); };
  g.fillStyle = c1; g.fillRect(0, 0, w, h);
  switch (f.pattern) {
    case 1: g.fillStyle = c2; g.fillRect(0, h / 2, w, h / 2); break;
    case 2: g.fillStyle = c2; g.fillRect(w / 2, 0, w / 2, h); break;
    case 3: g.fillStyle = c2; g.fillRect(0, h * 0.4, w, h * 0.2); g.fillRect(w * 0.3, 0, w * 0.2, h); break;
    case 4: poly([[0, 0], [w * 0.12, 0], [w, h * 0.88], [w, h], [w * 0.88, h], [0, h * 0.12]], c2); poly([[w, 0], [w, h * 0.12], [w * 0.12, h], [0, h], [0, h * 0.88], [w * 0.88, 0]], c2); break;
    case 5: poly([[0, h * 0.25], [w / 2, h * 0.7], [w, h * 0.25], [w, h * 0.5], [w / 2, h * 0.95], [0, h * 0.5]], c2); break;
    case 6: poly([[0, h * 0.7], [0, h], [w * 0.35, h], [w, h * 0.3], [w, 0], [w * 0.65, 0]], c2); break;
    case 7: g.fillStyle = c2; for (let i = 0; i < 4; i++) g.fillRect(0, h * (0.1 + i * 0.25), w, h * 0.12); break;
    case 8: g.fillStyle = c2; g.fillRect(0, 0, w / 2, h / 2); g.fillRect(w / 2, h / 2, w / 2, h / 2); break;
    case 9: g.strokeStyle = c2; g.lineWidth = Math.max(2, h * 0.1); g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth); break;
    default: break;
  }
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.26;
  g.fillStyle = c3; g.strokeStyle = c3;
  switch (f.emblem) {
    case 1: g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); break;
    case 2: { const pts: number[][] = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r * 1.1; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); } poly(pts, c3); break; }
    case 3: g.fillRect(cx - r * 0.25, cy - r, r * 0.5, r * 2); g.fillRect(cx - r, cy - r * 0.25, r * 2, r * 0.5); break;
    case 4: g.fillRect(cx - r * 0.6, cy - r * 0.2, r * 1.2, r * 1.2); for (const dx of [-0.6, -0.15, 0.3]) g.fillRect(cx + r * dx, cy - r * 0.6, r * 0.3, r * 0.45); break;
    case 5: poly([[cx - r, cy + r * 0.6], [cx - r, cy - r * 0.5], [cx - r * 0.5, cy], [cx, cy - r * 0.8], [cx + r * 0.5, cy], [cx + r, cy - r * 0.5], [cx + r, cy + r * 0.6]], c3); break;
    case 6: poly([[cx - r * 0.12, cy - r], [cx + r * 0.12, cy - r], [cx + r * 0.12, cy + r * 0.5], [cx - r * 0.12, cy + r * 0.5]], c3); g.fillRect(cx - r * 0.5, cy + r * 0.3, r, r * 0.16); break;
    case 7: g.lineWidth = Math.max(1.5, r * 0.14); g.beginPath(); g.moveTo(cx, cy + r); g.lineTo(cx, cy - r * 0.6); g.stroke(); for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(cx, cy + r * (0.5 - i * 0.4)); g.lineTo(cx - r * 0.55, cy + r * (0.1 - i * 0.4)); g.moveTo(cx, cy + r * (0.5 - i * 0.4)); g.lineTo(cx + r * 0.55, cy + r * (0.1 - i * 0.4)); g.stroke(); } break;
    default: break;
  }
}

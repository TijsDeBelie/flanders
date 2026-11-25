/** Display settings: what the player can switch on and off to trade looks for speed. Saved in this browser. */
export type Quality = 'low' | 'medium' | 'high' | 'ultra' | 'custom';
export interface Settings {
  quality: Quality;
  shadows: 0 | 1024 | 2048 | 4096;   // shadow map size, 0 = off
  antialias: boolean;                // needs a reload: it is chosen when the canvas is created
  resolution: number;                // render scale, 0.5 .. 1.5 of the screen's native resolution
  adaptive: boolean;                 // lower the resolution by itself when frames run long
  pixelCap: number;                  // highest pixel ratio on high-density screens
  drawDistance: number;              // forests further away than this are not drawn
  treeDetail: boolean;               // rich trees near the camera
  trees: boolean;
  waterFx: boolean;                  // glossy water with reflections
  particles: boolean;                // fire, smoke, dust, arrows
  crowds: boolean;                   // villagers, soldiers, animals
  googlyEyes: boolean;
  fpsCap: 0 | 30 | 60;
  showFps: boolean;
  jumpToRaiders: boolean;            // when a raid starts on your village, move the camera to the attackers by itself
  pauseForRaids: boolean;            // gives the player time to respond to a local bandit warning
  uiScale: number;                   // 0.8 .. 1.3: size of the interface panels, buttons and text (the map itself is not scaled)
  cameraSpeed: number;               // 0.5 .. 2: how fast the keys move, turn and zoom the camera
  showPaths: boolean;                // draw the invisible path network (red lines), to see where soldiers and villagers may walk
}

type Preset = Omit<Settings, 'quality' | 'antialias' | 'fpsCap' | 'showFps' | 'showPaths' | 'cameraSpeed' | 'uiScale' | 'jumpToRaiders' | 'pauseForRaids' | 'adaptive' | 'resolution' | 'googlyEyes'>;
export const PRESETS: Record<Exclude<Quality, 'custom'>, Preset> = {
  low:    { shadows: 0,    pixelCap: 1,    drawDistance: 450,  treeDetail: false, trees: true, waterFx: false, particles: true, crowds: true },
  medium: { shadows: 1024, pixelCap: 1.25, drawDistance: 750,  treeDetail: false, trees: true, waterFx: true,  particles: true, crowds: true },
  high:   { shadows: 2048, pixelCap: 1.5,  drawDistance: 1300, treeDetail: true,  trees: true, waterFx: true,  particles: true, crowds: true },
  ultra:  { shadows: 4096, pixelCap: 2,    drawDistance: 2600, treeDetail: true,  trees: true, waterFx: true,  particles: true, crowds: true },
};
export const DEFAULTS: Settings = { quality: 'high', antialias: true, resolution: 1, adaptive: true, fpsCap: 0, showFps: false, showPaths: false, cameraSpeed: 1, uiScale: 1, jumpToRaiders: false, pauseForRaids: true, googlyEyes: false, ...PRESETS.high };

const KEY = 'flanders:display';
let current: Settings = load();
/** Did the player ever save display settings in this browser? (Automatic choices, such as low settings without a graphics card, never override theirs.) */
let saved = (() => { try { return localStorage.getItem(KEY) !== null; } catch { return false; } })();
export const playerChoseSettings = () => saved;
const listeners: ((s: Settings, changed: (keyof Settings)[]) => void)[] = [];

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>, s = { ...DEFAULTS, ...raw };
    // a preset means that preset as this version defines it (High now caps the pixel ratio at 1.5): saved values of an older version do not override it
    if (s.quality !== 'custom' && PRESETS[s.quality]) Object.assign(s, PRESETS[s.quality]);
    return s;
  } catch { return { ...DEFAULTS }; }
}
export const settings = () => current;
export function onSettings(fn: (s: Settings, changed: (keyof Settings)[]) => void) { listeners.push(fn); }

/** Change one or more settings (a preset fills in the others). `persist: false` applies them for this visit only: automatic choices (low settings without a
 *  graphics card) are not saved, so they are made afresh next time and never pass for the player's own. */
export function setSettings(patch: Partial<Settings>, persist = true) {
  const next: Settings = { ...current, ...patch };
  if (patch.quality && patch.quality !== 'custom') Object.assign(next, PRESETS[patch.quality]);
  else if (!patch.quality && Object.keys(PRESETS.high).some(k => k in patch)) next.quality = matchPreset(next);
  const changed = (Object.keys(next) as (keyof Settings)[]).filter(k => next[k] !== current[k]);
  current = next;
  if (persist) { saved = true; try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* storage blocked */ } }
  if (changed.length) listeners.forEach(f => f(current, changed));
}
export const resetSettings = () => setSettings({ ...DEFAULTS });

/** The preset these settings equal, or 'custom'. */
function matchPreset(s: Settings): Quality {
  for (const [name, p] of Object.entries(PRESETS)) if ((Object.keys(p) as (keyof Preset)[]).every(k => s[k] === p[k])) return name as Quality;
  return 'custom';
}

/** Whether to ask for a multisampled (antialiased) canvas. Above about 1.5 device pixels per CSS pixel the edges are already fine, and 4× multisampling at
 *  that many pixels costs the GPU a great deal of memory bandwidth for little visible difference. (Chosen when the canvas is created.) */
export const wantAntialias = (dpr: number) => current.antialias && Math.min(dpr, current.pixelCap) * current.resolution < 1.5;

/** The pixel ratio to render at, given the screen's own and what the adaptive scaler has taken off. */
export const pixelRatio = (dpr: number, adapt: number) => Math.max(0.4, Math.min(dpr, current.pixelCap) * current.resolution * (current.adaptive ? adapt : 1));

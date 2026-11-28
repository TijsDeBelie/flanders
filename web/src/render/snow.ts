import type * as THREE from 'three';

/** Snow on the village in winter: one shader patch, added to the shared materials (buildings, terrain, trees), whitens whatever faces up (roofs, the ground,
 *  the tops of walls, crowns and log piles) with a soft, uneven edge, and leaves walls and steep faces bare. One shared uniform says how much: it settles over
 *  the first day and a half of winter and melts over the last two days and the first day of spring. Nothing here is part of the game state: the season is. */

const SEASON_DAYS = 10;   // (the core's SEASON_DAYS)
const DAY_TICKS = 240;    // (daycycle.ts's; kept here so this module loads under plain node: tests/snow.test.mjs checks the two agree)
const YEAR = 4 * SEASON_DAYS * DAY_TICKS;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** How much snow lies (0..1) at a tick of the game clock. Seasons run spring, summer, autumn, winter, each SEASON_DAYS days. */
export function snowCover(tick: number): number {
  const y = (((tick % YEAR) + YEAR) % YEAR) / (SEASON_DAYS * DAY_TICKS);   // 0..4 through the year, in seasons (winter is 3..4)
  const w = y < 1 ? y + 4 : y;   // (spring's first day counts as the end of winter, so the melt runs on across the new year)
  return smooth(3.0, 3.15, w) * (1 - smooth(3.8, 4.1, w));
}

/** The shared amount of snow, as a uniform every patched material reads. */
export const snowUniform = { value: 0 };

const DECL = `uniform float uSnow; varying vec3 vSnowWP;
float snowHash(vec2 p) { p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
float snowNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(snowHash(i), snowHash(i + vec2(1.0, 0.0)), f.x), mix(snowHash(i + vec2(0.0, 1.0)), snowHash(i + vec2(1.0, 1.0)), f.x), f.y); }`;
const FRAG = `
  if (uSnow > 0.001) {
    vec3 snowN = inverseTransformDirection(normal, viewMatrix);
    float sn = snowNoise(vSnowWP.xz * 0.45) * 0.6 + snowNoise(vSnowWP.xz * 2.3 + 7.0) * 0.4;
    // a face takes snow up to about 55 degrees off flat (a steep roof holds it, a wall does not); the noise makes the edge ragged, thin snow (early, melting)
    // shows in patches first, and even deep snow lets a little ground through here and there
    float cover = smoothstep(0.38, 0.62, snowN.y + (sn - 0.5) * 0.3) * smoothstep(0.0, 0.35, uSnow - (1.0 - sn) * 0.45 + 0.2) * (0.86 + 0.14 * smoothstep(0.25, 0.5, sn));
    vec3 snowCol = vec3(0.95, 0.96, 0.98) * (0.93 + 0.09 * sn);
    #ifdef USE_COLOR
      snowCol *= mix(1.0, dot(vColor.rgb, vec3(0.333)), 0.55);   // (keeps the baked shade of eaves and corners)
    #endif
    diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, cover);
    #if defined( STANDARD )
      roughnessFactor = mix(roughnessFactor, 0.7, cover);
    #endif
  }`;
const VERT = `
  {
    vec4 snowP = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      snowP = instanceMatrix * snowP;
    #endif
    vSnowWP = (modelMatrix * snowP).xyz;
  }`;

type Patched = THREE.Material & { userData: { snowy?: boolean } };
/** Add the snow to a material, after whatever shader patch it already has. Safe to call twice (the second does nothing). */
export function addSnow(mat: THREE.Material) {
  const m = mat as Patched;
  if (m.userData.snowy) return;
  m.userData.snowy = true;
  const before = m.onBeforeCompile, key = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, renderer) => {
    before.call(m, sh, renderer);
    sh.uniforms.uSnow = snowUniform;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSnowWP;').replace('#include <project_vertex>', VERT + '\n#include <project_vertex>');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + DECL).replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG);
  };
  // three caches compiled shaders by this key: it must tell apart every combination of the earlier patch with the snow
  m.customProgramCacheKey = () => key + '|snow';
  m.needsUpdate = true;
}

/** A material cloned from a snowy one has lost the patch (clone does not copy it): give it the same. */
export function keepSnow(from: THREE.Material, to: THREE.Material) {
  if (!(from as Patched).userData.snowy) return;
  to.onBeforeCompile = from.onBeforeCompile; to.customProgramCacheKey = from.customProgramCacheKey; (to as Patched).userData.snowy = true; to.needsUpdate = true;
}

import * as THREE from 'three';
import { tileableNoise } from './water';

/** A small seamless detail texture for the ground: R is fine grain (grass blades, grit), G is mid-size patchiness, B is ridged cracks. R doubles as the bump height. */
export function groundDetailTexture(size = 512): THREE.DataTexture {
  const norm = (a: Float32Array) => { let lo = 1e9, hi = -1e9; for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; } const k = 1 / Math.max(1e-6, hi - lo); return a.map(v => (v - lo) * k); };
  const fine = norm(tileableNoise(size, [[64, 1, false], [128, 0.6, false], [256, 0.35, false]], 9151)), mid = norm(tileableNoise(size, [[6, 1, false], [12, 0.6, false], [24, 0.3, false]], 4421)), crack = norm(tileableNoise(size, [[10, 1, true], [20, 0.5, true]], 777));
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([fine[i] * 255, mid[i] * 255, crack[i] * 255, 255], i * 4);
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

/** Give the ground fine detail close up that fades out with distance: three layers of the detail texture sampled in world space (so there is no repeating grid and no seams between
 *  terrain chunks), grass blades on green ground, grit and cracks on dirt and rock, and a bump on the light so the surface catches the sun. Beyond about 150 units it is the
 *  plain ground colour again, so a zoomed-out view is not noisy and costs nothing extra to look at. */
export function patchGround(mat: THREE.MeshStandardMaterial, detail: THREE.Texture) {
  mat.bumpMap = detail; mat.bumpScale = 0.9;
  mat.onBeforeCompile = sh => {
    sh.uniforms.uDetail = { value: detail };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <begin_vertex>', '#include <begin_vertex>\n vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const bump = THREE.ShaderChunk.bumpmap_pars_fragment.replaceAll('vBumpMapUv', '(vWP.xz * 1.15)').replace('return vec2( dBx, dBy );', 'return vec2( dBx, dBy ) * (1.0 - smoothstep(30.0, 120.0, length(vViewPosition)));');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP; uniform sampler2D uDetail;')
      .replace('#include <bumpmap_pars_fragment>', bump)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float near = 1.0 - smoothstep(25.0, 150.0, length(vViewPosition));
          vec3 d1 = texture2D(uDetail, vWP.xz * 1.15).rgb;
          vec3 d2 = texture2D(uDetail, vWP.xz * 0.31 + vec2(0.37, 0.61)).rgb;
          vec3 d3 = texture2D(uDetail, vWP.xz * 0.065 + vec2(0.71, 0.13)).rgb;
          float blades = texture2D(uDetail, vec2(vWP.x * 3.4 + vWP.z * 0.5, vWP.z * 0.42)).r;
          vec3 c = diffuseColor.rgb;
          float grass = smoothstep(0.0, 0.05, c.g - max(c.r, c.b) + 0.02);
          // patchiness at three scales is always there (it breaks the flat look from far away); the fine grain only up close
          float broad = (0.9 + 0.2 * d3.g) * (0.94 + 0.12 * d2.g);
          float fineAmt = (0.84 + 0.32 * d1.r) * (0.9 + 0.2 * blades * grass);
          c *= broad * mix(1.0, fineAmt, near);
          // grass leans to yellow-green in dry patches and deep green in damp ones; bare ground gets grit and cracks
          c = mix(c, c * vec3(1.08, 1.04, 0.82), grass * smoothstep(0.55, 0.85, d2.g) * 0.6);
          c = mix(c, c * vec3(0.84, 0.95, 0.88), grass * smoothstep(0.45, 0.1, d2.g) * 0.5);
          c *= mix(1.0, 0.8 + 0.3 * d1.b, near * (1.0 - grass) * 0.7);
          diffuseColor.rgb = c;
        }`);
  };
  mat.needsUpdate = true;
}

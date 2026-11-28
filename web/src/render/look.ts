import * as THREE from 'three';

/** The game's colour grade, done inside the tone mapping step every material already runs (no extra pass, so it costs nothing and works with the effects chain
 *  switched off). A neutral tone curve, which keeps colours where ACES drained them towards grey, then a little more saturation in the mid-tones, pale surfaces eased back towards white (the
 *  ACES curve used to do that, and the walls and plaster were painted for it), warm highlights and slightly cool shadows: the bright, painted look of a toy village in the sun. `GRADE` holds the numbers; `grade()` below is the same sum in plain code, for the tests. */
export const GRADE = { highlightSaturation: 0.5, highlightFrom: 0.42, highlightTo: 0.95, saturation: 1.08, warm: [1.012, 1.0, 0.988] as const, cool: [0.985, 0.995, 1.02] as const, split: 0.6 };

const v3 = (a: readonly number[]) => `vec3(${a.map(n => n.toFixed(4)).join(', ')})`;
const GLSL = `vec3 CustomToneMapping( vec3 color ) {
	color = NeutralToneMapping( color );
	float l = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	color = mix( vec3( l ), color, mix( ${GRADE.saturation.toFixed(4)}, ${GRADE.highlightSaturation.toFixed(4)}, smoothstep( ${GRADE.highlightFrom.toFixed(4)}, ${GRADE.highlightTo.toFixed(4)}, l ) ) );
	color *= mix( ${v3(GRADE.cool)}, ${v3(GRADE.warm)}, smoothstep( 0.0, ${GRADE.split.toFixed(4)}, l ) );
	return clamp( color, 0.0, 1.0 );
}`;

const STOCK = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
let installed = false;
/** Put the grade into three's shader library. Must run before the first material compiles; the renderer then uses `THREE.CustomToneMapping`. */
export function installGrade() {
  if (installed) return;
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (!chunk.includes(STOCK)) { console.warn('colour grade: three changed its tone mapping chunk; using its neutral curve instead'); return; }
  (THREE.ShaderChunk as Record<string, string>).tonemapping_pars_fragment = chunk.replace(STOCK, GLSL);
  installed = true;
}
/** Whether the grade is in place (else the renderer should fall back to `NeutralToneMapping`). */
export const gradeInstalled = () => installed;

// ---- the same in plain code (tests) ----
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Khronos PBR Neutral, as three implements it. */
export function neutral(c: [number, number, number], exposure = 1): [number, number, number] {
  let [r, g, b] = c.map(v => v * exposure);
  const x = Math.min(r, g, b), off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= off; g -= off; b -= off;
  const peak = Math.max(r, g, b), start = 0.76, d = 1 - start;
  if (peak < start) return [r, g, b];
  const np = 1 - d * d / (peak + d - start), k = np / peak; r *= k; g *= k; b *= k;
  const m = 1 - 1 / (0.15 * (peak - np) + 1);
  return [r + (np - r) * m, g + (np - g) * m, b + (np - b) * m];
}
/** Linear scene colour in, linear display colour out: what the shader does. */
export function grade(c: [number, number, number], exposure = 1): [number, number, number] {
  const n = neutral(c, exposure), l = 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2], t = smooth(0, GRADE.split, l);
  const sat = GRADE.saturation + (GRADE.highlightSaturation - GRADE.saturation) * smooth(GRADE.highlightFrom, GRADE.highlightTo, l);
  return n.map((v, i) => Math.min(1, Math.max(0, (l + (v - l) * sat) * (GRADE.cool[i] + (GRADE.warm[i] - GRADE.cool[i]) * t)))) as [number, number, number];
}

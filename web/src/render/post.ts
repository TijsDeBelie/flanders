import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Ambient occlusion worked out at half the resolution: soft contact shadow is blurry by nature, and it costs a quarter as much. */
class HalfGTAO extends GTAOPass {
  override setSize(w: number, h: number) { super.setSize(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2))); }
}

/** Which effects are on. With both off the scene is drawn straight to the screen, exactly as before the chain existed. */
export interface PostOptions { ambientOcclusion: boolean; glow: boolean }

/** The optional image effects after the scene is drawn: soft contact shadow where things meet (ambient occlusion: under eaves, between houses, at the foot of
 *  walls and trees) and a gentle glow around the brightest light (lit windows, fires, sunlit snow). The tone curve and colour grade are not here: every material
 *  does those itself (see look.ts), and the last pass here applies the same ones when the chain is on.
 *
 *  The ambient occlusion reads the depth the scene pass already wrote, so it needs no second drawing of the scene: its cost is on the graphics card alone,
 *  and the adaptive resolution (main.ts) sees it like any other GPU work. */
export class PostChain {
  private composer: EffectComposer;
  private ao: HalfGTAO;
  private bloom: UnrealBloomPass;
  private size = new THREE.Vector2();
  private depth: THREE.Texture | null = null;
  private opts: PostOptions = { ambientOcclusion: false, glow: false };

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, samples: number) {
    renderer.getDrawingBufferSize(this.size);
    const w = this.size.x, h = this.size.y;
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthTexture: new THREE.DepthTexture(w, h) });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(1);   // sizes below are in drawing-buffer pixels already
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new HalfGTAO(scene, camera, w, h, { depthTexture: target.depthTexture ?? undefined });
    this.ao.blendIntensity = 0.85;
    this.ao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.4, thickness: 1.6, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.composer.addPass(this.ao);
    // only light well past full white glows: by day that is the sun on snow and pale stone, at night the windows and fires
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.14, 0.35, 3.2);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(w, h);
  }

  /** Switch effects on and off (from the display settings). */
  configure(o: PostOptions) { this.opts = { ...o }; this.ao.enabled = o.ambientOcclusion; this.bloom.enabled = o.glow; }
  /** Whether anything is on: if not, draw the scene straight to the screen. */
  get active() { return this.opts.ambientOcclusion || this.opts.glow; }

  render() {
    const size = this.renderer.getDrawingBufferSize(this.size);
    const rt = this.composer.readBuffer;
    if (rt.width !== size.x || rt.height !== size.y) this.composer.setSize(size.x, size.y);   // the resolution moves (window size, adaptive resolution)
    // the scene pass draws into whichever buffer is the read buffer this frame; the occlusion must read that one's depth
    const depth = this.composer.readBuffer.depthTexture;
    if (this.ao.enabled && depth && depth !== this.depth) { this.ao.setGBuffer(depth); this.depth = depth; }
    this.composer.render();
  }

  dispose() { this.composer.dispose(); this.ao.dispose(); this.bloom.dispose(); }
}

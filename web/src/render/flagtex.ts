import * as THREE from 'three';
import { drawFlag, packFlag, type Flag } from '../flag';

const cache = new Map<number, THREE.CanvasTexture>();
/** The cloth of a flag as a texture (made once per design, then shared by every flag of that design). */
export function flagTexture(f: Flag): THREE.CanvasTexture {
  const key = packFlag(f); let t = cache.get(key);
  if (!t) {
    const c = document.createElement('canvas'); c.width = 176; c.height = 112;
    drawFlag(c.getContext('2d')!, c.width, c.height, f);
    t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; cache.set(key, t);
  }
  return t;
}

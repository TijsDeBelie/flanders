// Loads the building models in Node (no browser): vite compiles the TypeScript, and a canvas that draws nothing stands in for the textures' painting surface.
import { createServer } from 'vite';
const noop = () => {};
const ctx = new Proxy({}, { get: (_, k) => k === 'getImageData' ? (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop, set: () => true });
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
globalThis.window ??= globalThis;
let server;
/** The module `src/render/buildings.ts` (buildModel, auditModel, ...) compiled for Node. Call `closeModels()` when done. */
export async function loadBuildings() {
  server ??= await createServer({ root: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), logLevel: 'silent', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  return server.ssrLoadModule('/src/render/buildings.ts');
}
export async function closeModels() { await server?.close(); server = undefined; }

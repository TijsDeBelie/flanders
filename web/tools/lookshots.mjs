// Look-development screenshots: the same village and the building test hall from fixed camera angles, so a change to materials or light can be compared
// before and after. Needs a running dev server (`npm run dev`, or `npx vite` once the wasm is built) and Playwright.
//
//   node tools/lookshots.mjs <out-dir> [url] [--fx=on|off]
//
// It starts a game in a fixed world, builds the model village, and saves village-*.png and hall-*.png into <out-dir>. The display settings are forced to High
// (a headless browser draws on the processor, which would otherwise start on Low); --fx=off turns the image effects off, for comparing their cost and look.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');   // (require: finds a globally installed Playwright too)

const args = process.argv.slice(2), flags = args.filter(a => a.startsWith('--')), pos = args.filter(a => !a.startsWith('--'));
const out = pos[0] ?? 'lookshots', url = pos[1] ?? 'http://localhost:5173/', fx = !flags.includes('--fx=off');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('page error:', e.message));
await page.addInitScript(fx => {
  sessionStorage.setItem('flanders:autostart', JSON.stringify({ world: 'lookdev', name: 'Painter' }));
  localStorage.setItem('flanders:display', JSON.stringify({ quality: fx ? 'high' : 'custom', antialias: true, adaptive: false, ambientOcclusion: fx, glow: fx }));
  localStorage.setItem('flanders:tutorial', 'done');
}, fx);
await page.goto(url + (url.includes('?') ? '&' : '?') + 'debug');
await page.waitForFunction(() => window.__game?.lv && window.__game.rig, null, { timeout: 240_000, polling: 500 });
await page.addStyleTag({ content: '#app > *:not(#stage), #stage .vignette, #stage #labels, .toast, .toasts, dialog { display: none !important; }' });
await page.evaluate(() => { const g = window.__game; g.setSpeed?.(0); g.runModelVillage(false); });
const settle = ms => page.waitForTimeout(ms);
await settle(4000);

const shot = async (name, x, z, dist, yaw, pitch) => {
  await page.evaluate(([x, z, dist, yaw, pitch]) => {
    const r = window.__game.rig; r.focus(x, z, dist);
    Object.assign(r, { yaw, pitch, dist }); Object.assign(r.goal ?? {}, { yaw, pitch, dist }); r.target?.set?.(x, r.target.y, z);
    window.__game.atmo.invalidateShadows();
  }, [x, z, dist, yaw, pitch]);
  await settle(2500);
  await page.screenshot({ path: join(out, name + '.png') });
  console.log('saved', join(out, name + '.png'));
};

const home = await page.evaluate(() => ({ x: window.__game.lv.ox, z: window.__game.lv.oz }));
await shot('village-wide', home.x, home.z, 110, 0.7, 0.95);
await shot('village-close', home.x, home.z, 50, 0.7, 0.8);
await shot('village-low', home.x + 10, home.z - 10, 38, 2.2, 0.6);
await shot('ground-close', home.x + 62, home.z + 30, 16, 0.9, 0.75);   // plain grass outside the village, close up

// the test hall: rows of buildings, tiers left to right (see src/render/showroom.ts)
await page.evaluate(() => window.__game.toggleShowroom());
await settle(3000);
const x0 = 960, z0 = -560, STEP = 30;
// each shot: one row, tiers 0-3 left to right
for (const [i, row] of [[0, 0], [1, 2], [2, 5], [3, 9], [4, 14]]) await shot(`hall-${i}`, x0 + 45, z0 + row * STEP, 46, 0, 0.72);
// close-ups: [row, tier] of the hall, to see the textures themselves
for (const [row, tier] of [[0, 0], [0, 1], [0, 2], [1, 3], [5, 2], [9, 3]]) await shot(`close-r${row}t${tier}`, x0 + tier * STEP, z0 + row * STEP, 16, 0.5, 0.55);
await browser.close();

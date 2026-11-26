// The size of the screen the game draws on. Usually `innerWidth` × `innerHeight`, but two iPhone bugs need help:
//  - A home-screen app (standalone) sometimes opens with the wrong size and sends no `resize` until the phone is turned, so the village is drawn squashed.
//    The size is checked again for a few seconds after loading, and on every `visualViewport` change, and a `resize` is sent when it differs.
//  - In a standalone app with the translucent status bar (`viewport-fit=cover`), `innerHeight` and `height: 100%` can come up short by the status bar's height,
//    leaving a dark strip under the bottom panel. The large viewport unit (`100lvh`) still measures the whole screen; the difference is the gap, published as
//    the CSS variable `--vp-gap` so the bottom sheet can reach the real bottom edge, and added to `viewH()` so the canvas does too.
// Everything that sizes the canvas or projects onto it reads `viewW()` / `viewH()` and listens for `resize`, as before.

let gap = 0, lastW = 0, lastH = 0, probe: HTMLElement | null = null;

const standalone = () => {
  try { return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches; }
  catch { return false; }
};

/** How much taller the screen is than `innerHeight` says: only in a standalone app, and never more than a status bar (a larger difference is not this bug). */
export function viewportGap(innerH: number, largeH: number, isStandalone: boolean): number {
  if (!isStandalone || !(largeH > innerH)) return 0;
  const d = Math.round(largeH - innerH);
  return d <= 64 ? d : 0;
}

function measureGap(): number {
  if (typeof document === 'undefined' || !document.body) return 0;
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:100vh;height:100lvh;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
  }
  return viewportGap(innerHeight, probe.offsetHeight, standalone());
}

export const viewW = () => innerWidth;
export const viewH = () => innerHeight + gap;

/** Measure again; when anything changed, publish the gap and send a `resize` so the renderer, the camera and the cached canvas position follow. */
function check(announce: boolean) {
  const g = measureGap();
  if (g !== gap) { gap = g; document.documentElement.style.setProperty('--vp-gap', g + 'px'); }
  const w = viewW(), h = viewH();
  if (w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  if (announce) dispatchEvent(new Event('resize'));
}

/** Call once, before the renderer is made. */
export function initViewport() {
  check(false);
  addEventListener('resize', () => check(false));   // the browser's own resize: everyone hears it already, only the gap needs updating
  const later = () => check(true);
  visualViewport?.addEventListener('resize', later);
  addEventListener('orientationchange', () => { later(); setTimeout(later, 300); });
  addEventListener('pageshow', later);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) later(); });
  // the first seconds after opening: the wrong size at launch is corrected by iOS without any event
  const until = performance.now() + 4000;
  const watch = () => { later(); if (performance.now() < until) requestAnimationFrame(watch); };
  requestAnimationFrame(watch);
}

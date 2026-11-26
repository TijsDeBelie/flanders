// Behaviour of the mobile interface (the layout itself is mobile.css). Only does anything on a touch device: `body.mobile` is set by device.ts.
// On a phone in portrait the ledger is a bottom sheet: its tab bar stays on screen, a tap on a tab opens the sheet, a tap on the open tab folds it, choosing a building
// or touching the village folds it too, so the sheet never hides the ground you are about to build on. In landscape it stays a side panel and none of this runs.

const portrait = () => matchMedia('(orientation: portrait)').matches;
/** Read each time: device.ts moves an iPad between `tablet` and `phone` when its window is resized (Split View, Stage Manager). */
const phone = () => document.body.classList.contains('phone');

/** First visit on a phone or tablet: start with the sheet folded, and the realm card and goals folded, so the village is what you see first. Run before the UI is built
 *  (it reads these preferences once); the player's own choices, once saved, are never overwritten. */
export function seedMobilePrefs(phone: boolean) {
  try {
    if (localStorage.getItem('flanders:ui') !== null) return;
    localStorage.setItem('flanders:ui', JSON.stringify({ ledger: phone, map: phone, goals: phone }));
  } catch { /* storage blocked: the defaults of the desktop layout apply */ }
}

export function initMobileUi() {
  if (!document.body.classList.contains('mobile')) return;
  // a pinch on a panel (not on the map, which handles its own) zoomed the whole page in Safari: `touch-action: manipulation` still allows pinch-zoom, and iOS ignores
  // `user-scalable=no`. Safari's own gesture events are the one way to stop it.
  document.addEventListener('gesturestart', e => e.preventDefault());
  const ledger = document.getElementById('ledger')!, fold = document.getElementById('ledger-min') as HTMLElement;
  const open = () => !ledger.classList.contains('min');
  const sheet = () => portrait() && phone();
  /** Where the panel covers the ground and so folds by itself: on a phone, as a sheet or a side panel (too narrow a screen to share). A tablet's side panel stays. */
  const covers = () => phone();

  const tabs = document.getElementById('tabs')!;

  // the grab handle: drag the tab bar up to open the sheet, down to fold it. The sheet follows the finger, and lands open or folded by where it was let go
  // (or by a quick flick). A drag is not a tap: the click that follows it is swallowed before the tabs see it.
  let drag: { id: number; y0: number; t0: number; base: number; span: number; pos: number; moved: boolean } | null = null, swallow = false;
  tabs.addEventListener('click', e => { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); } }, true);
  tabs.addEventListener('pointerdown', e => {
    if (!sheet() || e.pointerType === 'mouse' || drag) return;
    const peek = tabs.offsetHeight + (parseFloat(getComputedStyle(ledger).paddingBottom) || 0);
    const span = Math.max(0, ledger.offsetHeight - peek);
    drag = { id: e.pointerId, y0: e.clientY, t0: performance.now(), base: open() ? 0 : span, span, pos: open() ? 0 : span, moved: false };
    swallow = false;
  });
  tabs.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.abs(dy) < 8) return;
      drag.moved = true; ledger.classList.add('dragging');
      try { tabs.setPointerCapture(e.pointerId); } catch { /* the finger already left */ }
    }
    drag.pos = Math.min(drag.span, Math.max(0, drag.base + dy));
    ledger.style.transform = `translateY(${drag.pos}px)`;
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) return;
    const v = (d.pos - d.base) / Math.max(1, performance.now() - d.t0);   // px per ms; a flick decides even a short drag
    const wantOpen = e.type === 'pointercancel' ? d.base === 0 : v < -0.5 ? true : v > 0.5 ? false : d.pos < d.span / 2;
    ledger.classList.remove('dragging'); ledger.style.transform = '';
    if (wantOpen !== open()) fold.click();
    swallow = e.type !== 'pointercancel';
    setTimeout(() => { swallow = false; }, 400);   // in case no click follows (the finger ended outside a tab)
  };
  tabs.addEventListener('pointerup', endDrag);
  tabs.addEventListener('pointercancel', endDrag);

  // tabs: tapping one while the sheet is folded opens it; tapping the tab that is already open folds it
  let wasOn = false;
  tabs.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.tab');
    if (!t || !sheet()) return;
    wasOn = t.classList.contains('on');   // runs before the interface's own handler (capture): reads the state from before the tap
  }, true);
  tabs.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.tab');
    if (!t || !sheet()) return;
    if (!open() || wasOn) fold.click();
  });

  // choosing a building (a card in the Build list) folds the sheet to put the ground back in view
  document.getElementById('cards')!.addEventListener('click', e => {
    if (covers() && open() && (e.target as HTMLElement).closest('.card:not(.no):not(.unit):not(.det)')) setTimeout(() => open() && fold.click(), 0);
  });

  // touching the village while the sheet is open folds it (a building you select opens its own panel afterwards)
  document.getElementById('gl')!.addEventListener('pointerdown', e => { if (e.pointerType === 'touch' && covers() && open()) fold.click(); }, { passive: true });
}

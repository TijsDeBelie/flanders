// A guided first half hour. Unlike the goal list (which only ticks things off), the tutorial tells you what to do next, why, and where to click: the
// current step is explained in a small card and the control to use is outlined. A step with a condition completes by itself when the village has what it asks for;
// a step without one waits for "Next". It starts by itself in a brand-new village, can be skipped at any time, and can be restarted from the help sheet.
import type { Counts } from './goals.ts';

export interface Step {
  title: string;
  /** The explanation. `{action}` is replaced by the key that action is bound to right now (see Tutorial.setKeys), so the guide always shows the player's own keys. */
  text: string;
  /** Completes by itself when this is true of the village; without it the step waits for the Next button. */
  done?: (c: Counts) => boolean;
  /** What to outline: a CSS selector, optionally narrowed to elements whose text contains `has`. */
  point?: { sel: string; has?: string };
}

/** The default key for each action named in the step texts (used when no key lookup is set, and in tests). */
const DEFAULT_KEYS: Record<string, string> = { panUp: 'W', panLeft: 'A', panDown: 'S', panRight: 'D', rotLeft: 'X', rotRight: 'E', deposits: 'V', photo: 'F9' };

/** Fill the `{action}` placeholders of a text. */
export function fillKeys(text: string, label: (action: string) => string = a => DEFAULT_KEYS[a] ?? a): string {
  return text.replace(/\{(\w+)\}/g, (_, a: string) => label(a));
}

export const STEPS: Step[] = [
  { title: 'Welcome to Flanders', text: 'You rule a small village. This guide takes you from a few huts to a castle. Move the camera with {panUp} {panLeft} {panDown} {panRight}. Turn it with {rotLeft} and {rotRight}. Zoom with the wheel. Press Next to begin.' },
  { title: 'Grain for the table', text: 'Food comes first: your stores will not last. Build a Farm on flat ground. Farms give less grain in winter.', done: c => c.n(1) >= 1, point: { sel: '#cards .card', has: 'Farm' } },
  { title: 'A home for new villagers', text: 'Build a House on flat ground. New villagers move in while there is room. Pick House on the right, then click the ground.', done: c => c.n(0) >= 1, point: { sel: '#cards .card', has: 'House' } },
  { title: 'Wood', text: 'Almost everything starts as wood. Build a Woodcutter next to a forest.', done: c => c.n(4) >= 1, point: { sel: '#cards .card', has: 'Woodcutter' } },
  { title: 'Planks', text: 'Better buildings need planks. Build a Sawmill. It turns wood into planks.', done: c => c.n(5) >= 1, point: { sel: '#cards .card', has: 'Sawmill' } },
  { title: 'Watch your stores', text: 'Open Food in the top bar. It shows how long your meals will last. Check food and firewood before each winter. Press Next when you have looked.', point: { sel: '#treasury' } },
  { title: 'Stone', text: 'Press {deposits} to show the deposits on the map. Build a Quarry right beside a stone deposit.', done: c => c.n(6) >= 1, point: { sel: '#cards .card', has: 'Quarry' } },
  { title: 'Water against fire', text: 'Raiders and fires will come. Build a Well. Villagers use it to put fires out.', done: c => c.n(16) >= 1, point: { sel: '#cards .card', has: 'Well' } },
  { title: 'A watchtower', text: 'Build a Watchtower. Its archers shoot at raiders. It needs a garrison to fire.', done: c => c.n(3) >= 1, point: { sel: '#cards .card', has: 'Watchtower' } },
  { title: 'A barracks', text: 'Build a Barracks. This is where you train soldiers.', done: c => c.n(19) >= 1, point: { sel: '#cards .card', has: 'Barracks' } },
  { title: 'Train archers', text: 'Open the Military tab. Train at least 5 archers. They man the watchtower and defend the village.', done: c => c.army >= 5 },
  { title: 'A growing village', text: 'Keep building houses and farms. Reach 20 villagers. Gardens, parks and chapels keep them happy.', done: c => c.pop >= 20 },
  { title: 'Look after the soil', text: 'Click a farm to see its soil. A field sown every season wears out. Set it to Rotate to let it rest. Press Next when you have looked.', point: { sel: '#cards .card', has: 'Farm' } },
  { title: 'A grander hall', text: 'Click your town hall and upgrade it. A better hall widens your border. Keep the ground around it clear.', done: c => c.hall >= 1 },
  { title: 'Other players, and your village', text: 'The Players button shows who else is in your world. You can trade, make treaties, or fight. Press {photo} for photo mode. Your village is saved in this browser. Back it up under Display settings. Have a good reign!', point: { sel: '#btn-mp' } },
];

const KEY = 'flanders:tutorial';
export type Progress = { step: number } | 'done' | 'skipped';

export function loadProgress(storage: Pick<Storage, 'getItem'> = localStorage): Progress | null {
  try {
    const raw = storage.getItem(KEY); if (!raw) return null;
    if (raw === 'done' || raw === 'skipped') return raw;
    const n = Number(raw); return Number.isInteger(n) && n >= 0 && n < STEPS.length ? { step: n } : null;
  } catch { return null; }
}
const saveProgress = (p: Progress) => { try { localStorage.setItem(KEY, typeof p === 'string' ? p : String(p.step)); } catch { /* storage blocked */ } };

/** The step the tutorial should be on after the village changed: it moves on past every step whose condition is already met (one step at a time for steps that wait for Next). */
export function stepAfter(step: number, c: Counts): number {
  let s = step;
  while (s < STEPS.length && STEPS[s].done?.(c)) s++;
  return s;
}

const CSS = `
#tutorial { position: fixed; left: 12px; bottom: 80px; z-index: 55; width: 300px; padding: 12px 14px; border-radius: 8px; background: #1d150df2; border: 1px solid #c9a24a; color: #f1e4c3; font: 14px/1.45 system-ui, sans-serif; box-shadow: 0 6px 24px #0009; }
#tutorial h4 { margin: 0 0 4px; font: 600 16px Georgia, serif; color: #ffd98a; }
#tutorial p { margin: 0 0 8px; }
#tutorial .tb { display: flex; gap: 6px; align-items: center; }
#tutorial .tb span { margin-left: auto; opacity: .7; font-size: 12px; }
#tutorial button { cursor: pointer; padding: 4px 10px; border-radius: 6px; border: 1px solid #c9a24a; background: #3a2c18; color: #f1e4c3; font: inherit; }
.tut-hl { outline: 3px solid #ffd34d !important; outline-offset: 2px; animation: tutpulse 1.4s ease-in-out infinite; }
@keyframes tutpulse { 50% { outline-color: #ffd34d55; } }
@media (prefers-reduced-motion: reduce) { .tut-hl { animation: none; } }
`;

export class Tutorial {
  private step = 0;
  private active = false;
  private box: HTMLElement | null = null;
  private lit: Element | null = null;
  private lastCounts: Counts | null = null;
  private label: (action: string) => string = a => DEFAULT_KEYS[a] ?? a;

  /** Tell the guide how to name the key bound to an action; called again (via refresh) when the player rebinds keys. */
  setKeys(label: (action: string) => string) { this.label = label; this.refresh(); }
  /** Redraw the current step (its key names may have changed). */
  refresh() { if (this.active) this.render(); }

  /** Start for a brand-new village (nothing saved yet) or continue where the player left off. */
  begin(isNewVillage: boolean) {
    this.addHelpButton();
    const p = loadProgress();
    if (p === null) { if (isNewVillage) this.start(0); }
    else if (typeof p === 'object') this.start(p.step);
  }

  start(step = 0) {
    if (!document.getElementById('tutorial-style')) { const st = document.createElement('style'); st.id = 'tutorial-style'; st.textContent = CSS; document.head.appendChild(st); }
    this.step = step; this.active = true; this.render();
  }

  /** Call whenever the village changes. */
  update(c: Counts) {
    this.lastCounts = c;
    if (!this.active) return;
    const next = stepAfter(this.step, c);
    if (next !== this.step) { this.step = next; saveProgress(this.step >= STEPS.length ? 'done' : { step: this.step }); this.render(); }
    else this.point();
  }

  private finish(how: 'done' | 'skipped') { this.active = false; saveProgress(how); this.box?.remove(); this.box = null; this.unlight(); }

  private render() {
    if (this.step >= STEPS.length) { this.finish('done'); return; }
    const s = STEPS[this.step];
    if (!this.box) { this.box = document.createElement('div'); this.box.id = 'tutorial'; this.box.setAttribute('role', 'dialog'); this.box.setAttribute('aria-label', 'Guide'); document.body.appendChild(this.box); }
    this.box.textContent = '';
    const h = document.createElement('h4'); h.textContent = s.title;
    const p = document.createElement('p'); p.textContent = fillKeys(s.text, this.label);
    const tb = document.createElement('div'); tb.className = 'tb';
    if (!s.done) { const n = document.createElement('button'); n.textContent = this.step === STEPS.length - 1 ? 'Finish' : 'Next'; n.onclick = () => { this.step++; saveProgress(this.step >= STEPS.length ? 'done' : { step: this.step }); this.render(); if (this.lastCounts) this.update(this.lastCounts); }; tb.appendChild(n); }
    const skip = document.createElement('button'); skip.textContent = 'Skip guide'; skip.onclick = () => this.finish('skipped'); tb.appendChild(skip);
    const cnt = document.createElement('span'); cnt.textContent = `${this.step + 1} / ${STEPS.length}`; tb.appendChild(cnt);
    this.box.append(h, p, tb); this.point();
  }

  private unlight() { this.lit?.classList.remove('tut-hl'); this.lit = null; }
  private point() {
    const spec = this.active ? STEPS[this.step]?.point : undefined;
    if (!spec) { this.unlight(); return; }
    const el = Array.from(document.querySelectorAll(spec.sel)).find(e => !spec.has || (e.textContent ?? '').includes(spec.has)) ?? null;
    if (el === this.lit) return;
    this.unlight(); if (el) { el.classList.add('tut-hl'); this.lit = el; }
  }

  private addHelpButton() {
    const row = document.querySelector('#settings [data-sec="controls"] .btnrow'); if (!row || document.getElementById('tut-restart')) return;
    const b = document.createElement('button'); b.className = 'pbtn'; b.id = 'tut-restart'; b.textContent = 'Restart the guide';
    b.onclick = () => { document.getElementById('settings')!.hidden = true; this.start(0); if (this.lastCounts) this.update(this.lastCounts); };
    row.prepend(b);
  }
}

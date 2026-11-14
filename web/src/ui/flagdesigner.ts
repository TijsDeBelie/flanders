import { PALETTE, PATTERNS, EMBLEMS, drawFlag, randomFlag, type Flag } from '../flag';

/** Draw a flag onto a canvas element. */
export function paintFlag(canvas: HTMLCanvasElement, f: Flag) { const g = canvas.getContext('2d'); if (g) drawFlag(g, canvas.width, canvas.height, f); }

/** The flag designer: a preview, a pattern and an emblem to choose, three colours, and a dice for a random flag. `onChange` is called after every change. */
export function mountFlagDesigner(root: HTMLElement, initial: Flag, onChange: (f: Flag) => void) {
  let f: Flag = { ...initial };
  root.innerHTML = `
    <div class="flagdes">
      <canvas class="flagprev" width="168" height="108"></canvas>
      <div class="flagctl">
        <label>Pattern <select data-k="pattern">${PATTERNS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
        <label>Emblem <select data-k="emblem">${EMBLEMS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
        ${(['c1', 'c2', 'c3'] as const).map((k, n) => `<div class="swatches" data-k="${k}"><span>${['Main colour', 'Second colour', 'Emblem colour'][n]}</span>${PALETTE.map((c, i) => `<button type="button" data-i="${i}" title="${c}" style="background:${c}"></button>`).join('')}</div>`).join('')}
        <button type="button" class="pbtn flagdice">🎲 Random flag</button>
      </div>
    </div>`;
  const canvas = root.querySelector('canvas') as HTMLCanvasElement;
  const sync = () => {
    paintFlag(canvas, f);
    (root.querySelector('select[data-k="pattern"]') as HTMLSelectElement).value = String(f.pattern); (root.querySelector('select[data-k="emblem"]') as HTMLSelectElement).value = String(f.emblem);
    for (const k of ['c1', 'c2', 'c3'] as const) root.querySelectorAll<HTMLElement>(`.swatches[data-k="${k}"] button`).forEach(b => b.classList.toggle('on', Number(b.dataset.i) === f[k]));
  };
  const change = (n: Flag) => { f = n; sync(); onChange({ ...f }); };
  root.addEventListener('change', e => { const s = e.target as HTMLSelectElement; const k = s.dataset?.k as 'pattern' | 'emblem' | undefined; if (k) change({ ...f, [k]: Number(s.value) }); });
  root.addEventListener('click', e => {
    const t = e.target as HTMLElement, sw = t.closest<HTMLElement>('.swatches button');
    if (sw) { const k = (sw.parentElement as HTMLElement).dataset.k as 'c1' | 'c2' | 'c3'; change({ ...f, [k]: Number(sw.dataset.i) }); return; }
    if (t.closest('.flagdice')) change(randomFlag());
  });
  sync();
  return { set(n: Flag) { f = { ...n }; sync(); }, get value() { return { ...f }; } };
}

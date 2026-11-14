import type { World } from '../wasm/game_core.js';
import { CHOICES } from '../data';

/** The card for a decision waiting for the player (plague, preacher, noble, hard winter): one button per option. Kept out of main.ts so the game loop does not know how it looks. */
let shownKey = '';
export function showChoice(w: World, decide: (option: number) => void) {
  const c = w.choice_flat(), key = c.length ? `${c[0]}:${w.tick()}` : '';
  let box = document.getElementById('choicebox');
  if (!c.length) { box?.remove(); shownKey = ''; return; }
  if (key === shownKey && box) return;
  shownKey = key; box?.remove();
  const def = CHOICES[c[0]]; if (!def) return;
  box = document.createElement('div'); box.id = 'choicebox';
  box.style.cssText = 'position:fixed;left:50%;top:90px;transform:translateX(-50%);z-index:55;max-width:460px;background:#f3e8cc;color:#2a1d10;border:2px solid #7a5a22;border-radius:6px;padding:14px 16px;font:15px Georgia,serif;box-shadow:0 8px 30px #0008';
  box.innerHTML = `<b style="font-size:18px">${def.title}</b><p>${def.story} <i>(${c[2]} days to decide)</i></p>` + def.options.map((o, i) => `<button class="pbtn" data-opt="${i}" style="display:block;width:100%;margin:5px 0;text-align:left">${o}</button>`).join('');
  box.onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-opt]'); if (b) decide(Number(b.dataset.opt)); };
  document.body.appendChild(box);
}

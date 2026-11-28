import type { World } from '../wasm/game_core.js';
import { CHOICES, FOCI, RES } from '../data';

/** The card for a decision waiting for the player (plague, preacher, noble, hard winter): one button per option. Kept out of main.ts so the game loop does not know how it looks. */
let shownKey = '';
export function showChoice(w: World, decide: (option: number) => void) {
  const c = w.choice_flat(), key = c.length ? `${c[0]}:${w.tick()}` : '';
  let box = document.getElementById('choicebox');
  if (!c.length) { box?.remove(); shownKey = ''; return; }
  if (key === shownKey && box) return;
  shownKey = key; box?.remove();
  const def = CHOICES[c[0]]; if (!def) return;
  box = document.createElement('div'); box.id = 'choicebox'; box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-label', def.title);
  // a focus: the options are the areas the reeve proposes, each with its price (see realm.rs)
  const options = c[0] === 4 ? [...Array.from(w.focus_offer()).map((f, i) => { const cost = Array.from(w.choice_cost(i)), price: string[] = []; for (let k = 0; k + 1 < cost.length; k += 2) price.push(`${cost[k + 1]} ${RES[cost[k]].name.toLowerCase()}`); return `<b>${FOCI[f]?.name}</b>: ${FOCI[f]?.effect} (${price.join(', ')})`; }), 'None of them'] : def.options;
  box.innerHTML = `<b class="cb-title">${def.title}</b><p>${def.story} <i>(${c[2]} days to decide)</i></p>` + options.map((o, i) => `<button class="pbtn cb-opt" data-opt="${i}">${o}</button>`).join('');
  box.onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-opt]'); if (b) decide(Number(b.dataset.opt)); };
  document.body.appendChild(box);
}

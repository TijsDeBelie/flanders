import type { World } from '../wasm/game_core.js';

/** The tooltip on the population pill: the families behind the headcount, the year, the harvest and any freezing. */
export function showPopulationInfo(w: World) {
  const el = document.getElementById('v-pop'); if (!el) return;
  const d = w.demographics();
  el.title = `Villagers / housing. ${d[0]} children, ${d[1]} adults (they do the work), ${d[2]} elders, about ${d[3]} couples. Year ${w.year()}. Grain harvest now ${w.grain_percent()}% of usual${w.warmth() ? '' : '. It is freezing: no firewood!'}`;
}

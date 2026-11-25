import { settings, setSettings, resetSettings, onSettings, PRESETS, type Settings } from '../settings';
import { downloadBackup, restoreBackup } from '../backup';
import { icon } from './icons';

interface Row { key: keyof Settings; label: string; hint: string; kind: 'select' | 'toggle' | 'range'; options?: [string, string][]; min?: number; max?: number; step?: number }
const ROWS: { sec: 'display' | 'game' | 'controls'; title: string; rows: Row[] }[] = [
  { sec: 'display', title: 'Performance', rows: [
    { key: 'quality', label: 'Quality preset', hint: 'Sets most of the options below at once. Change any of them and it becomes Custom.', kind: 'select', options: [['low', 'Low: smooth on weak computers'], ['medium', 'Medium'], ['high', 'High (default)'], ['ultra', 'Ultra: for strong graphics cards'], ['custom', 'Custom']] },
    { key: 'fpsCap', label: 'Frame rate limit', hint: 'Lower limits save battery and keep a laptop cool.', kind: 'select', options: [['0', 'Unlimited (screen speed)'], ['60', '60 per second'], ['30', '30 per second']] },
  ] },
  { sec: 'display', title: 'Overlays', rows: [
    { key: 'showFps', label: 'Show frame rate', hint: 'The small counter in the corner (also F3 for details).', kind: 'toggle' },
    { key: 'showPaths', label: 'Show walking paths', hint: 'Draws the invisible path network as red lines (bright on roads): where soldiers and villagers may walk. For checking how they get about.', kind: 'toggle' },
  ] },
  { sec: 'display', title: 'Image', rows: [
    { key: 'resolution', label: 'Resolution', hint: 'How many pixels are drawn. Lower is much faster; above 100% is sharper but slow.', kind: 'range', min: 0.5, max: 1.5, step: 0.05 },
    { key: 'adaptive', label: 'Adjust resolution automatically', hint: 'Drops the resolution a little when the game runs slowly and brings it back when there is room.', kind: 'toggle' },
    { key: 'antialias', label: 'Smooth edges (anti-aliasing)', hint: 'Removes jagged edges. Changing it needs a reload of the page.', kind: 'toggle' },
    { key: 'shadows', label: 'Shadows', hint: 'Shadow quality. Off is the biggest single speed-up.', kind: 'select', options: [['0', 'Off'], ['1024', 'Low'], ['2048', 'Medium'], ['4096', 'High']] },
    { key: 'waterFx', label: 'Glossy water', hint: 'Reflective water surface.', kind: 'toggle' },
  ] },
  { sec: 'display', title: 'World', rows: [
    { key: 'trees', label: 'Trees', hint: 'Forests. Without them the land is bare but much faster.', kind: 'toggle' },
    { key: 'treeDetail', label: 'Detailed trees nearby', hint: 'Rich trees close to the camera, simple ones further away.', kind: 'toggle' },
    { key: 'drawDistance', label: 'Draw distance', hint: 'How far away forests are drawn.', kind: 'select', options: [['450', 'Short'], ['750', 'Medium'], ['1300', 'Long'], ['2600', 'Very long']] },
    { key: 'particles', label: 'Fire, smoke and dust', hint: 'Particle effects.', kind: 'toggle' },
    { key: 'crowds', label: 'People, soldiers and animals', hint: 'The moving figures. Turning them off does not change the game, only what you see.', kind: 'toggle' },
    { key: 'googlyEyes', label: 'Googly Eyes', hint: 'Give animals oversized eyes that seem to look in two directions at once.', kind: 'toggle' },
  ] },
  { sec: 'controls', title: 'Camera', rows: [
    { key: 'cameraSpeed', label: 'Camera speed', hint: 'How fast the keys move, turn, tilt and zoom the camera.', kind: 'range', min: 0.5, max: 2, step: 0.1 },
  ] },
  { sec: 'game', title: 'Raids', rows: [
    { key: 'jumpToRaiders', label: 'Jump to raiders', hint: 'When raiders attack your village, the camera moves to them by itself at the start of the fight (the red banner also takes you there when you click it).', kind: 'toggle' },
    { key: 'pauseForRaids', label: 'Pause at bandit warnings', hint: 'Pause your village when a bandit warning begins, giving you time to check defences and resume the countdown.', kind: 'toggle' },
  ] },
];

/** Build the display settings panel into `root`. It stays in step with the settings (a preset changes several controls at once). */
export function mountSettings(root: HTMLElement, askReload: () => void, watchOwn: () => void = () => {}, ask: (text: string) => Promise<boolean> = async () => true) {
  const group = (g: typeof ROWS[number]) => `<h3>${g.title}</h3>` + g.rows.map(r => {
    const id = `set-${r.key}`;
    const ctl = r.kind === 'select' ? `<select id="${id}">${r.options!.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`
      : r.kind === 'toggle' ? `<input type="checkbox" id="${id}">`
      : `<input type="range" id="${id}" min="${r.min}" max="${r.max}" step="${r.step}"><output id="${id}-v"></output>`;
    return `<label class="setrow" for="${id}"><span><b>${r.label}</b><small>${r.hint}</small></span>${ctl}</label>`;
  }).join('');
  root.innerHTML = '<section data-sec="display" hidden>' + ROWS.filter(g => g.sec === 'display').map(group).join('') + `<div class="btnrow"><button class="pbtn" id="set-reset">Back to defaults</button><button class="pbtn" id="set-reload" hidden>Reload now to apply</button></div></section><section data-sec="game" hidden>${ROWS.filter(g => g.sec === 'game').map(group).join('')}</section><section data-sec="controls" hidden>${ROWS.filter(g => g.sec === 'controls').map(group).join('')}</section><section data-sec="data" hidden><h3>Network</h3><p class="muted">Players connect directly to each other. If a friend cannot connect (strict office or mobile network), a TURN relay server helps. Optional; applies after a reload.</p>
    <label class="setrow"><span><b>TURN server</b><small>For example turn:turn.example.com:3478</small></span><input type="text" id="turn-urls" placeholder="turn:host:3478"></label>
    <label class="setrow"><span><b>User name</b></span><input type="text" id="turn-user" autocomplete="off"></label>
    <label class="setrow"><span><b>Password</b></span><input type="password" id="turn-cred" autocomplete="off"></label>` + `<h3>Your data</h3><p class="muted">Your village and your signing key live only in this browser: clearing site data or switching computers loses them. Save a backup file now and then. <b>The file holds your private key: keep it to yourself.</b></p>
    <div class="btnrow"><button class="pbtn" id="data-export">Save a backup file</button><button class="pbtn" id="data-import">Restore from a backup file…</button><button class="pbtn" id="data-replay" hidden title="Play your village's whole history back, from the first day">${icon('play', 14, { mono: true })} Watch my history</button><input type="file" id="data-file" accept="application/json,.json" hidden></div><p class="muted" id="data-msg" role="status"></p>` + '<hr><div id="restart-section"></div></section>';
  const el = <T extends HTMLElement>(k: string) => root.querySelector<T>(`#set-${k}`)!;
  const sync = () => {
    const s = settings() as unknown as Record<string, unknown>;
    for (const g of ROWS) for (const r of g.rows) {
      const c = el<HTMLInputElement | HTMLSelectElement>(r.key as string);
      if (r.kind === 'toggle') (c as HTMLInputElement).checked = !!s[r.key]; else c.value = String(s[r.key]);
      if (r.kind === 'range') root.querySelector<HTMLElement>(`#set-${r.key}-v`)!.textContent = `${Math.round(Number(s[r.key]) * 100)}%`;
    }
  };
  root.addEventListener('change', e => {
    if (!(e.target as HTMLElement).id.startsWith('set-')) return;
    const t = e.target as HTMLInputElement | HTMLSelectElement, key = t.id.replace(/^set-/, '') as keyof Settings, row = ROWS.flatMap(g => g.rows).find(r => r.key === key);
    if (!row) return;
    const v = row.kind === 'toggle' ? (t as HTMLInputElement).checked : row.kind === 'select' && key !== 'quality' ? Number(t.value) : row.kind === 'range' ? Number(t.value) : t.value;
    setSettings({ [key]: v } as Partial<Settings>);
    if (key === 'antialias') { root.querySelector<HTMLElement>('#set-reload')!.hidden = false; askReload(); }
  });
  root.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.type === 'range' && t.id.startsWith('set-')) root.querySelector<HTMLElement>(`#${t.id}-v`)!.textContent = `${Math.round(Number(t.value) * 100)}%`; });
  root.querySelector<HTMLElement>('#set-reset')!.onclick = () => resetSettings();
  root.querySelector<HTMLElement>('#set-reload')!.onclick = () => location.reload();
  // the TURN relay lives apart from the other settings: it is a secret of this browser
  const turnEls = ['turn-urls', 'turn-user', 'turn-cred'].map(id => root.querySelector<HTMLInputElement>(`#${id}`)!);
  try { const t = JSON.parse(localStorage.getItem('flanders:turn') ?? 'null'); if (t) { turnEls[0].value = t.urls ?? ''; turnEls[1].value = t.username ?? ''; turnEls[2].value = t.credential ?? ''; } } catch { /* none */ }
  turnEls.forEach(e => e.addEventListener('change', () => {
    const urls = turnEls[0].value.trim();
    try { if (urls) localStorage.setItem('flanders:turn', JSON.stringify({ urls, username: turnEls[1].value.trim(), credential: turnEls[2].value })); else localStorage.removeItem('flanders:turn'); } catch { /* blocked */ }
    root.querySelector<HTMLElement>('#set-reload')!.hidden = false;
  }));
  const msg = (t: string) => { root.querySelector<HTMLElement>('#data-msg')!.textContent = t; };
  root.querySelector<HTMLElement>('#data-export')!.onclick = () => { try { msg(`Backup saved (${downloadBackup()} items). Keep the file somewhere safe.`); } catch (e) { msg(`Could not save the backup: ${(e as Error).message}`); } };
  root.querySelector<HTMLElement>('#data-replay')!.onclick = () => watchOwn();
  const file = root.querySelector<HTMLInputElement>('#data-file')!;
  root.querySelector<HTMLElement>('#data-import')!.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0]; file.value = ''; if (!f) return;
    try {
      const n = await restoreBackup(f, count => ask(`This replaces ${count} saved item(s) in this browser (your village, key and name) with the ones in the file. Continue?`));
      if (n) { msg(`Restored ${n} items. Reloading…`); setTimeout(() => location.reload(), 800); } else msg('Nothing was changed.');
    } catch (e) { msg((e as Error).message); }
  };
  onSettings(sync); sync();
  void PRESETS;
}

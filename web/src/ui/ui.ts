import { HALF } from '../render/terrain';
import { CATS, KIND_ICON, RES, UNIT_ICON, defs, units, fmtCost, type BuildingDef } from '../data';
import { ACTIONS, keys, prettyKey, type Action } from '../keys';
import { mountFlagDesigner } from './flagdesigner';
import { loadFlag, saveFlag } from '../flag';

/** The keys bound to an action, as they are now (after any rebinding), e.g. "W / Z / ↑". */
export const keyNames = (a: Action) => keys.binds[a].map(k => `<kbd>${prettyKey(k).toUpperCase()}</kbd>`).join(' ');
/** What the controls are, written from the real bindings, so the home screen and the help screen can never disagree with the game. */
export function controlsHtml() {
  return `<b>Left-click</b> builds and selects · <b>left-drag</b> draws a box round armies · <b>right-click</b> sends the selected army there · <b>right-drag</b> turns the camera · <b>middle-drag</b> or <b>Shift-drag</b> grabs the ground · <b>wheel</b> zooms towards the pointer.<br>Move the camera: ${keyNames('panUp')} forward, ${keyNames('panLeft')} left, ${keyNames('panDown')} back, ${keyNames('panRight')} right · turn: ${keyNames('rotLeft')} ${keyNames('rotRight')} · tilt: ${keyNames('tiltUp')} ${keyNames('tiltDown')} · zoom: ${keyNames('zoomIn')} ${keyNames('zoomOut')} · cancel: ${keyNames('cancel')} · help: ${keyNames('help')}.`;
}

/** Names come from other players: never put them into HTML unescaped. */
export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.().catch(() => { /* refused: ignore */ });
}
export const WORLDS = ['flanders', 'brabant', 'hainaut', 'limburg', 'ardennes', 'zeeland', 'holland', 'friesland'];
const worldOptions = (cur: string) => [...new Set([...WORLDS, cur])].map(w => `<option value="${esc(w)}" ${w === cur ? 'selected' : ''}>${esc(w.charAt(0).toUpperCase() + w.slice(1))}</option>`).join('') + '<option value="__custom">Custom…</option>';

export interface Handlers {
  start(world: string, name: string): void;
  select(kind: number | null): void;
  act(name: string): void;
  speed(n: number): void;
  toggleResources(): void;
  minimapClick(x: number, z: number): void;
  train(kind: number, n: number): void;
  attack(peerKey: string, units: number[]): void;
  trade(peerKey: string, action: string, res: number, amount: number, escort: number): void;
  focusPeer(key: string): void;
  copyLink(): void;
  cheat(action: number, a: number, b: number): void;
  toggleMute(): void;
  muster(units: number[]): void;
  detAction(action: string, id: number): void;
}

export interface Hud {
  tick: number; stocks: number[]; rates: number[]; pop: number; cap: number; sick: number; joy: number; eff: number; jobs: number;
  radius: number; buildings: number; storage: number;
  vitals?: number[]; beds?: number; devotion?: number;
  army: number[]; queued: number[]; away: number[]; guards: number; barracks: number; wildlife: number;
}

export interface PeerRow { key: string; name: string; pop: number; buildings: number; sync: string; busy: boolean; rel?: number; married?: boolean; treaties?: number }
const relWord = (r: number) => r >= 80 ? 'devoted' : r >= 50 ? 'friendly' : r >= 20 ? 'warm' : r > -20 ? 'neutral' : r > -50 ? 'cool' : r > -80 ? 'hostile' : 'sworn enemies';

const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
const BUILDABLE = defs.filter(d => d.id !== 15).sort((a, b) => a.cat - b.cat || a.id - b.id);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class UI {
  canvas!: HTMLCanvasElement;
  minimap!: HTMLCanvasElement;
  private cards = new Map<number, HTMLElement>();
  private pills: HTMLElement[] = [];
  private filter = -1;
  private tab = 'build';
  private logCount = 0;
  private peers: PeerRow[] = [];
  private armyShown = '';

  constructor(private h: Handlers, world: string, name: string) {
    document.getElementById('app')!.innerHTML = this.template(world, name);
    this.canvas = $('gl') as HTMLCanvasElement;
    this.minimap = $('minimap') as HTMLCanvasElement;
    this.bind();
    this.buildCards();
    this.buildCheats();
    this.buildMuster();
    this.initPanels();
    this.buildKeyTable();
    keys.onChange(() => this.buildKeyTable());
    this.buildStock();
    this.buildPills();
    this.buildUnits();
  }

  private template(world: string, name: string) {
    return `
<div id="stage"><canvas id="gl"></canvas><div class="vignette"></div><div id="labels"></div></div>
<header class="topbar" hidden id="topbar">
  <div class="brand"><h1>Flanders</h1><span class="sub" id="sub">Day 1 · Spring</span></div>
  <div class="treasury" id="treasury"></div>
  <div class="vitals">
    <span class="pill" id="v-pop" title="Villagers / housing"><span class="ic">👥</span><b>0</b></span>
    <span class="pill" id="v-army" title="Soldiers in your army"><span class="ic">⚔️</span><b>0</b></span>
    <span class="pill" id="v-sick" title="Villagers sick with plague"><span class="ic">🤒</span><b>0</b></span>
    <span class="pill" id="v-joy" title="Happiness: gardens, parks, chapels, markets and courts lift it; hunger, plague and overcrowding lower it. Happy villages grow faster and pay more tax."><span class="ic">😊</span><b>50</b></span>
    <span class="pill" id="v-work" title="Workforce efficiency: jobs vs. available workers"><span class="ic">⚒️</span><b>100%</b></span>
  </div>
  <div class="spacer"></div>
  <div class="speed" id="speed">
    <button class="btn" data-s="0" title="Pause"><svg viewBox="0 0 16 16"><rect x="3" y="2" width="3.6" height="12" rx=".6"/><rect x="9.4" y="2" width="3.6" height="12" rx=".6"/></svg></button>
    <button class="btn on" data-s="1" title="Normal speed (calm)"><svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg></button>
    <button class="btn" data-s="2" title="Fast x2"><svg viewBox="0 0 16 16"><path d="M1 2l7 6-7 6zM8 2l7 6-7 6z"/></svg></button>
    <button class="btn" data-s="4" title="Very fast x4"><svg viewBox="0 0 16 16"><path d="M0 3l5.4 5L0 13zM5.3 3l5.4 5-5.4 5zM10.6 3L16 8l-5.4 5z"/></svg></button></div>
  <button class="btn" id="btn-sound" title="Sound on / off"><svg viewBox="0 0 16 16" id="snd-on"><path d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 5.2a4 4 0 0 1 0 5.6M12.8 3.6a6.3 6.3 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><svg viewBox="0 0 16 16" id="snd-off" hidden><path d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 6l4 4M15 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
  <button class="btn" id="btn-res" aria-pressed="false" title="Show ore and stone deposits (V)">⛏ Deposits</button>
  <button class="btn" id="btn-mp" title="Players in this world">🌍 <span id="mp-count">Online</span></button>
  <button class="btn" id="btn-cheat" hidden title="Testing tools">🛠 Test</button>
  <button class="btn" id="btn-map" title="Full-screen map (M)">🗺 Map</button>
  <button class="btn" id="btn-full" title="Full-screen mode (F11)">⛶</button>
  <button class="btn" id="btn-help">?</button>
</header>
<div id="battle" hidden></div>
<aside id="ledger" hidden>
  <div class="tabs" id="tabs">
    <button class="tab on" data-t="build">Build</button><button class="tab" data-t="army">Army</button><button class="tab" data-t="village">Village</button><button class="tab" data-t="stock">Stock</button><button class="tab" data-t="sel" id="tab-sel" hidden>Selected</button><button class="tabmin" id="ledger-min" title="Hide the panel (H)">▸</button>
  </div>
  <section class="pane on" id="pane-build">
    <div><div class="eyebrow">Construction</div><h2>Build</h2></div>
    <div class="chips" id="cats"></div>
    <div class="cards" id="cards"></div>
    <p class="muted">Pick a building, then click the ground. <b>R</b> rotates, <b>Esc</b> cancels. Buildings level the ground beneath them and clear the trees.</p>
  </section>
  <section class="pane" id="pane-army">
    <div><div class="eyebrow">Military</div><h2>Army</h2></div>
    <div class="stats five" id="army-stats"></div>
    <p class="muted" id="army-info"></p>
    <div class="cards" id="unit-cards"></div>
    <div id="muster-box"><h3>Field armies</h3>
      <p class="muted">Muster soldiers into a field army (or <b>everyone</b> with one click). <b>Click its banner</b> or press <b>Tab</b> to select it, then <b>right-click</b> the ground to march; <b>G</b> halts, <b>B</b> sends it home. Armies walk round buildings and trees, file through dense forest, fell trees for catapults and bridge or ferry over water.</p>
      <div class="atk-row" id="muster-row"></div><div class="btnrow"><button class="pbtn" id="muster-go">⚑ Muster</button><button class="pbtn primary" id="muster-all">Muster everyone <span class="key">F</span></button></div>
      <div id="det-list" class="cards"></div></div>
    <div id="attack-box"><h3>March on a rival village</h3><div id="attack-form"></div></div>
    <p class="muted">Towers, the hall and your standing army defend the village. Bandits raid from time to time: stone buildings resist fire, wells and walls help too.</p>
  </section>
  <section class="pane" id="pane-village">
    <div><div class="eyebrow" id="v-sub">Your settlement</div><h2>The Village</h2></div>
    <div class="stats"><div class="stat"><b id="s-pop">0</b><span>Villagers</span></div><div class="stat"><b id="s-cap">0</b><span>Housing</span></div><div class="stat"><b id="s-sick">0</b><span>Sick</span></div></div>
    <div class="stats"><div class="stat"><b id="s-eff">0%</b><span>Workforce</span></div><div class="stat"><b id="s-bld">0</b><span>Buildings</span></div><div class="stat"><b id="s-rad">0</b><span>Border radius</span></div></div>
    <div><h3>Health &amp; death care</h3><div class="stats" id="care-stats"></div><p class="muted" id="care-info"></p></div>
    <div><div class="eyebrow">Housing used</div><div class="bar"><i id="b-house" style="width:0"></i></div></div>
    <div><div class="eyebrow">Storage (per resource)</div><div class="bar"><i id="b-store" style="width:0"></i></div><p class="muted" id="t-store"></p></div>
    <div><h3>Your flag</h3><div id="flag-design"></div></div>
    <div><h3>Neighbours</h3><ul class="log" id="peer-list"><li class="muted">Nobody else is here yet.</li></ul></div>
    <div><h3>Chronicle</h3><ul class="log" id="log"><li><small>Day 1</small> Your people have arrived. Build houses and farms, and find stone, clay, iron and gold nearby.</li></ul></div>
  </section>
  <section class="pane" id="pane-stock">
    <div><div class="eyebrow">Warehouse</div><h2>Stock &amp; Industry</h2></div>
    <table class="res" id="restable"></table>
    <div><h3>Production chains</h3><div class="chain">
      🌳 Wood <span class="arrow">→</span> Sawmill <span class="arrow">→</span> 📏 Planks<br>
      🌳 Wood <span class="arrow">→</span> Charcoal Burner <span class="arrow">→</span> ⚫ Charcoal<br>
      🟤 Clay + ⚫ <span class="arrow">→</span> Brickworks <span class="arrow">→</span> 🧱 Bricks<br>
      🟠 Iron ore + ⚫ <span class="arrow">→</span> Smelter <span class="arrow">→</span> ⛓️ Iron<br>
      ⛓️ Iron + ⚫ <span class="arrow">→</span> Blacksmith <span class="arrow">→</span> 🔨 Tools<br>
      🟡 Gold ore + ⚫ <span class="arrow">→</span> Mint <span class="arrow">→</span> 🪙 Gold<br>
      🦌 Hunters <span class="arrow">→</span> Hunter's Lodge <span class="arrow">→</span> 🌾 Venison</div>
      <p class="muted" style="margin-top:6px">Mines and quarries must stand beside a deposit — press <b>V</b> to reveal them. Rates are per minute.</p></div>
  </section>
  <section class="pane" id="pane-sel"></section>
</aside>
<div id="minimap-card" hidden><div class="cap" id="mm-cap" title="Hide / show the minimap (M)"><span>REALM</span><span id="mm-hint">click to travel</span><i id="mm-full" title="Full-screen map (M)">⛶</i><b id="mm-chev">▾</b></div><canvas id="minimap" width="190" height="190"></canvas></div>
<div id="goals" hidden><div class="gh" id="goals-head" title="Collapse"><b>Goals</b><span id="goals-count"></span><b id="goals-chev">▾</b></div><ul id="goal-list"></ul></div>
<button id="ledger-open" hidden title="Show the panel (H)">◂</button>
<div class="overlay clear" id="worldmap" hidden><div class="mapwrap"><div class="maphead"><b>The Realm</b><span class="muted">Click anywhere to travel there · Esc to close</span><button class="btn" data-close="worldmap">✕</button></div><canvas id="bigmap" width="900" height="900"></canvas></div></div>
<div id="ctxmenu" hidden></div><div id="selbox" hidden></div>
<div id="toasts"></div>
<div id="hint" hidden></div>
<div id="tooltip" hidden></div>

<div class="overlay" id="loader" hidden>
  <div class="sheet loading"><h1>Flanders</h1><div class="tag" id="ltext">Preparing the world…</div><div class="lbar"><i id="lbar-i"></i></div><p class="muted" id="ltip"></p></div>
</div>
<div class="overlay" id="intro">
  <div class="sheet">
    <h1>Flanders</h1>
    <div class="tag">One shared medieval world. Found a village, raise a castle, defend it — or march on your neighbours.</div>
    <hr>
    <div class="userfield"><div><label for="username">Your name</label><input id="username" value="${esc(name)}" maxlength="20" spellcheck="false" autocomplete="off"></div><div><label for="world">World</label><select id="world">${worldOptions(world)}</select><input id="world-custom" placeholder="Name your world" maxlength="30" spellcheck="false" autocomplete="off" hidden></div></div>
    <p class="muted">Everyone who enters the same world shares the same lands. Other players see your name over your town hall.</p>
    <h3 style="margin:8px 0 2px">Your flag</h3><div id="intro-flag"></div>
    <div class="btnrow"><button class="pbtn primary" id="found">Enter the world</button></div>
    <p class="muted">There is no game server: every player runs a copy of the game and your browsers connect to each other. Your village is saved in this browser and keeps growing while you are away.</p>
    <p class="muted" id="home-keys"></p>
  </div>
</div>
<div class="overlay clear" id="help" hidden>
  <div class="sheet">
    <h2>How to rule</h2>
    <div class="keytable" id="keytable"></div>
    <p class="muted" id="help-mouse"></p>
    <div class="btnrow"><button class="pbtn" id="keys-reset">Reset keys to default</button></div>
    <p class="muted">Feed your people, then dig for stone, clay, iron and gold. Hunters keep the larder full. Build a barracks, train soldiers and man your towers: bandits will come, and fire spreads fast through thatch. Siege engines scar the land with craters; stone and wells keep fires small.</p>
    <div class="btnrow"><button class="pbtn primary" data-close="help">Back to the realm</button></div>
  </div>
</div>
<div class="overlay clear" id="cheats" hidden>
  <div class="sheet">
    <h2>Testing tools</h2>
    <p class="muted">For testing only. These actions are signed and sent to other players like any other command. They appear because you are running locally (or added <b>?cheats=1</b> to the address).</p>
    <div id="cheat-res" class="cheatgrid"></div>
    <div class="btnrow" style="flex-wrap:wrap">
      <button class="pbtn" data-ch="3,0,0">Fill every store</button><button class="pbtn" data-ch="1,10,0">+10 villagers</button><button class="pbtn" data-ch="6,0,0">Cure plague</button>
    </div>
    <h3>Soldiers</h3><div class="btnrow" style="flex-wrap:wrap" id="cheat-army"></div>
    <h3>Village</h3><div class="btnrow"><button class="pbtn primary" data-ch="100,0,0">🏘 Build a model village</button></div>
    <h3>Ground</h3><div class="btnrow" style="flex-wrap:wrap"><button class="pbtn" data-ch="102,30,0">▭ Level 30</button><button class="pbtn" data-ch="102,50,0">▭ Level 50</button><button class="pbtn" data-ch="102,72,0">▭ Level 72</button></div>
    <h3>Repair</h3><div class="btnrow" style="flex-wrap:wrap"><button class="pbtn" data-ch="7,0,0">🧯 Extinguish all fires</button><button class="pbtn" data-ch="8,0,0">⛰ Reset terrain</button><button class="pbtn danger" data-ch="101,0,0">♻ Full reset (all villages)</button></div>
    <h3>Trouble</h3>
    <div class="btnrow" style="flex-wrap:wrap"><button class="pbtn danger" data-ch="4,90,200">Small raid</button><button class="pbtn danger" data-ch="4,200,700">Big raid</button><button class="pbtn danger" data-ch="5,-1,0">Burn selected building</button></div>
    <div class="btnrow"><button class="pbtn primary" data-close="cheats">Close</button></div>
  </div>
</div>
<div class="overlay clear" id="mp" hidden>
  <div class="sheet">
    <h2>The shared world</h2>
    <p class="muted">Everyone who enters world <b id="mp-world"></b> lives on the same map. Your browser connects directly to the other players — nothing is stored on a server, and commands are signed so nobody can forge your moves.</p>
    <div class="netstat" id="net-status">Looking for other players…</div>
    <ul class="log" id="mp-peers"></ul>
    <div class="btnrow"><button class="pbtn" id="mp-copy">📋 Copy invite link</button><button class="pbtn primary" data-close="mp">Close</button></div>
    <p class="muted">To invite someone, send them the link. To keep a private world, enter a different world name on the title screen.</p>
  </div>
</div>`;
  }

  private bind() {
    const wsel = $('world') as HTMLSelectElement, wcus = $('world-custom') as HTMLInputElement;
    wsel.onchange = () => { wcus.hidden = wsel.value !== '__custom'; if (!wcus.hidden) wcus.focus(); };
    mountFlagDesigner($('intro-flag'), loadFlag(), saveFlag);   // the flag is chosen here, before the village exists, and flown as soon as it does
    const keyText = () => { $('home-keys').innerHTML = controlsHtml(); }; keyText(); keys.onChange(keyText);
    { const h = () => { $('help-mouse').innerHTML = controlsHtml() + ' Number keys <b>1-9</b> pick a building on any keyboard layout.'; }; h(); keys.onChange(h); }
    $('found').onclick = () => { const s = (wsel.value === '__custom' ? wcus.value.trim() : wsel.value) || 'flanders', n = ($('username') as HTMLInputElement).value.replace(/[<>]/g, '').trim().slice(0, 20) || 'Traveller'; this.h.start(s, n); };
    ($('username') as HTMLInputElement).onkeydown = wcus.onkeydown = e => { if (e.key === 'Enter') $('found').click(); };
    $('tabs').onclick = e => { const t = (e.target as HTMLElement).dataset.t; if (t) this.setTab(t); };
    $('cats').innerHTML = `<button class="chip on" data-c="-1">All</button>` + CATS.map((c, i) => `<button class="chip" data-c="${i}">${c.icon} ${c.name}</button>`).join('');
    $('cats').onclick = e => {
      const c = (e.target as HTMLElement).dataset.c; if (c === undefined) return;
      this.filter = Number(c);
      $('cats').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', (x as HTMLElement).dataset.c === c));
      this.cards.forEach((el, id) => { el.hidden = this.filter >= 0 && defs[id].cat !== this.filter; });
    };
    $('speed').onclick = e => { const s = (e.target as HTMLElement).dataset.s; if (s !== undefined) this.h.speed(Number(s)); };
    $('btn-res').onclick = () => this.h.toggleResources();
    $('btn-sound').onclick = () => this.h.toggleMute();
    $('btn-help').onclick = () => this.modal('help', true);
    $('btn-mp').onclick = () => this.modal('mp', true);
    document.querySelectorAll<HTMLElement>('[data-close]').forEach(b => b.onclick = () => this.modal(b.dataset.close!, false));
    $('mp-copy').onclick = () => { this.h.copyLink(); $('mp-copy').textContent = '✓ Copied'; setTimeout(() => ($('mp-copy').textContent = '📋 Copy invite link'), 1800); };
    $('pane-sel').onclick = e => { const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (a && !(a as HTMLButtonElement).disabled) this.h.act(a.dataset.act!); };
    $('btn-map').onclick = () => this.toggleMap(); $('btn-full').onclick = () => toggleFullscreen(); $('mm-full').onclick = e => { e.stopPropagation(); this.toggleMap(); };
    $('bigmap').onclick = e => { const r = $('bigmap').getBoundingClientRect(); this.h.minimapClick(((e.clientX - r.left) / r.width - 0.5) * HALF * 2, ((e.clientY - r.top) / r.height - 0.5) * HALF * 2); this.toggleMap(false); };
    // the browser's own context menu never shows: right-click belongs to the game
    addEventListener('contextmenu', e => e.preventDefault(), true);
    addEventListener('selectstart', e => { if (!(e.target as Node).parentElement?.closest('input,textarea')) e.preventDefault(); });
    addEventListener('dragstart', e => e.preventDefault());
    addEventListener('pointerdown', e => { if (!(e.target as HTMLElement).closest?.('#ctxmenu')) this.closeCtx(); }, true);
    addEventListener('wheel', () => this.closeCtx(), { passive: true }); addEventListener('blur', () => this.closeCtx());
    addEventListener('keydown', e => { if (e.key === 'Escape') this.closeCtx(); });
    document.addEventListener('fullscreenchange', () => { $('btn-full').textContent = document.fullscreenElement ? '🗗' : '⛶'; });
    $('minimap').onclick = e => {
      const r = this.minimap.getBoundingClientRect();
      this.h.minimapClick(((e.clientX - r.left) / r.width - 0.5) * HALF * 2, ((e.clientY - r.top) / r.height - 0.5) * HALF * 2);
    };
    $('pane-village').onclick = $('mp').onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-peer]'); if (b) { this.h.focusPeer(b.dataset.peer!); this.modal('mp', false); } };
    addEventListener('keydown', e => {
      if ((e.target as HTMLElement)?.matches?.('input,textarea')) return;
      if (e.key === 'Escape') { document.querySelectorAll('.overlay.clear').forEach(o => ((o as HTMLElement).hidden = true)); }
    });
  }

  // ---- loading screen ----
  private tips = ['Hunters keep the larder full if a forest is near.', 'Stone buildings shrug off fire; thatch does not.', 'Wells and chapels keep the plague away.', 'Paths appear on their own between your buildings.', 'Press V to reveal ore and stone deposits.', 'Your village keeps growing while you are away.', 'Walls link up by themselves when placed close together.'];
  beginLoading() { $('intro').hidden = true; $('loader').hidden = false; $('ltip').textContent = this.tips[Math.floor(Math.random() * this.tips.length)]; this.progress(1, 'Preparing the world…'); }
  progress(p: number, text: string) { ($('lbar-i') as HTMLElement).style.width = p + '%'; $('ltext').textContent = text; }
  private finishLoading() { ($('lbar-i') as HTMLElement).style.width = '100%'; const l = $('loader'); l.style.transition = 'opacity .5s'; l.style.opacity = '0'; setTimeout(() => { l.hidden = true; l.style.opacity = ''; l.style.transition = ''; }, 520); }

  // ---- collapsible panels (remembered between visits) ----
  private pref: { ledger?: boolean; map?: boolean; goals?: boolean } = {};
  private initPanels() {
    try { this.pref = JSON.parse(localStorage.getItem('flanders:ui') ?? '{}'); } catch { this.pref = {}; }
    $('ledger-min').onclick = () => this.toggleLedger(); $('ledger-open').onclick = () => this.toggleLedger();
    $('mm-cap').onclick = () => this.toggleMinimap(); $('goals-head').onclick = () => this.toggleGoals();
    this.applyPanels();
  }
  private savePrefs() { try { localStorage.setItem('flanders:ui', JSON.stringify(this.pref)); } catch { /* ignore */ } this.applyPanels(); }
  private applyPanels() {
    $('ledger').classList.toggle('min', !!this.pref.ledger); $('ledger-open').hidden = !this.pref.ledger || $('ledger').hidden;
    $('minimap-card').classList.toggle('min', !!this.pref.map); $('mm-chev').textContent = this.pref.map ? '▸' : '▾';
    $('goals').classList.toggle('min', !!this.pref.goals); $('goals-chev').textContent = this.pref.goals ? '▸' : '▾';
  }
  toggleLedger() { this.pref.ledger = !this.pref.ledger; this.savePrefs(); }
  toggleMinimap() { this.pref.map = !this.pref.map; this.savePrefs(); }
  get bigmap() { return $('bigmap') as HTMLCanvasElement; }
  mapOpen() { return !$('worldmap').hidden; }
  toggleMap(show = $('worldmap').hidden) { $('worldmap').hidden = !show; }

  /** The in-game right-click menu. `items` with no `run` are headings; '-' is a divider. */
  ctxMenu(x: number, y: number, title: string, items: ({ label: string; sub?: string; disabled?: boolean; run?: () => void } | '-')[]) {
    const m = $('ctxmenu');
    m.innerHTML = `<div class="ctx-title">${esc(title)}</div>` + items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}><span>${esc(it.label)}</span>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`).join('');
    m.hidden = false;
    m.onclick = e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-i]'); if (!b || b.disabled) return; const it = items[Number(b.dataset.i)]; this.closeCtx(); if (it !== '-') it.run?.(); };
    const w = m.offsetWidth, h = m.offsetHeight; m.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px'; m.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
  }
  closeCtx() { const m = document.getElementById('ctxmenu'); if (m) m.hidden = true; }
  ctxOpen() { return !$('ctxmenu').hidden; }

  /** The rubber band for drag-selecting armies (screen pixels), or null to hide it. */
  selBox(r: { x0: number; y0: number; x1: number; y1: number } | null) {
    const b = $('selbox'); b.hidden = !r; if (!r) return;
    b.style.left = Math.min(r.x0, r.x1) + 'px'; b.style.top = Math.min(r.y0, r.y1) + 'px'; b.style.width = Math.abs(r.x1 - r.x0) + 'px'; b.style.height = Math.abs(r.y1 - r.y0) + 'px';
  }

  toggleGoals() { this.pref.goals = !this.pref.goals; this.savePrefs(); }
  setMuteIcon(muted: boolean) { $('snd-on').hidden = muted; $('snd-off').hidden = !muted; }

  /** The "what next?" card. */
  setGoals(list: { text: string; done: boolean; detail?: string }[]) {
    const done = list.filter(g => g.done).length, open = list.filter(g => !g.done).slice(0, 3);
    $('goals').hidden = false; $('goals-count').textContent = `${done}/${list.length}`;
    const html = open.length ? open.map(g => `<li><span class="box"></span><div>${esc(g.text)}${g.detail ? `<small>${esc(g.detail)}</small>` : ''}</div></li>`).join('') : '<li class="all">All goals complete — rule well!</li>';
    if ($('goal-list').dataset.h !== html) { $('goal-list').dataset.h = html; $('goal-list').innerHTML = html; }
  }

  // ---- field armies ----
  private buildMuster() {
    $('muster-row').innerHTML = units.slice(0, 5).map(u => `<label title="${u.name}">${UNIT_ICON[u.id]}<input type="number" min="0" value="0" id="mus-${u.id}"></label>`).join('');
    $('muster-all').onclick = () => { const u = units.slice(0, 5).map(x => this.armyNow[x.id] ?? 0); if (u.some(n => n > 0)) this.h.muster(u); };
    $('muster-go').onclick = () => { const u = units.slice(0, 5).map(x => Number(($(`mus-${x.id}`) as HTMLInputElement).value) || 0); if (u.some(n => n > 0)) { this.h.muster(u); units.slice(0, 5).forEach(x => (($(`mus-${x.id}`) as HTMLInputElement).value = '0')); } };
    $('det-list').onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-da]'); if (b) this.h.detAction(b.dataset.da!, Number(b.dataset.id)); };
  }
  private detSig = '';
  /** The field armies of your village. */
  setDets(list: { id: number; units: number[]; text: string; selected: boolean; leftWp: number }[]) {
    const sig = JSON.stringify(list);
    if (sig === this.detSig) return; this.detSig = sig;
    $('det-list').innerHTML = list.length ? list.map(d => `<div class="card det ${d.selected ? 'sel' : ''}"><div class="ico">⚑</div><div><div class="nm"><span>Army ${d.id}</span><span class="key">${d.units.reduce((a, b) => a + b, 0)} soldiers</span></div>
      <div class="ds">${d.units.map((n, i) => (n ? `${UNIT_ICON[i]} ${n}` : '')).filter(Boolean).join(' &nbsp; ')}</div><div class="io">${esc(d.text)}</div>
      <div class="btnrow" style="margin-top:6px;flex-wrap:wrap"><button class="pbtn" data-da="select" data-id="${d.id}">Select</button><button class="pbtn" data-da="split" data-id="${d.id}">Split</button><button class="pbtn" data-da="merge" data-id="${d.id}">Merge</button><button class="pbtn" data-da="halt" data-id="${d.id}">Halt</button><button class="pbtn" data-da="recall" data-id="${d.id}">Recall</button></div></div></div>`).join('') : '<p class="muted">No field armies yet.</p>';
  }

  private listening: Action | null = null;
  private buildKeyTable() {
    const t = $('keytable'); let group = ''; let html = '';
    for (const a of ACTIONS) {
      if (a.group !== group) { group = a.group; html += `<div class="grp">${group}</div>`; }
      html += `<span>${a.label}</span><span>${keys.binds[a.id].map(k => `<kbd>${prettyKey(k)}</kbd>`).join('')}</span><button data-bind="${a.id}" class="${this.listening === a.id ? 'listening' : ''}">${this.listening === a.id ? 'Press a key…' : 'Change'}</button>`;
    }
    t.innerHTML = html;
    t.onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-bind]'); if (b) { this.listening = b.dataset.bind as Action; this.buildKeyTable(); } };
    $('keys-reset').onclick = () => { keys.reset(); };
  }

  /** While rebinding, the next key press becomes the binding. Returns true if the event was consumed. */
  captureKey(e: KeyboardEvent): boolean {
    if (!this.listening) return false;
    e.preventDefault(); e.stopPropagation();
    const k = e.key.toLowerCase(), a = this.listening; this.listening = null;
    if (k !== 'escape') { const cur = keys.binds[a]; keys.set(a, cur.includes(k) ? cur : [k, ...cur].slice(0, 3)); } else this.buildKeyTable();
    return true;
  }

  private buildCheats() {
    const enabled = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || new URLSearchParams(location.search).has('cheats');
    $('btn-cheat').hidden = !enabled; if (!enabled) return;
    $('btn-cheat').onclick = () => this.modal('cheats', true);
    $('cheat-res').innerHTML = RES.map((r, i) => `<span>${r.icon} ${r.name}</span><button class="pbtn" data-ch="0,${i},100">+100</button><button class="pbtn" data-ch="0,${i},1000">+1000</button>`).join('');
    $('cheat-army').innerHTML = units.slice(0, 5).map(u => `<button class="pbtn" data-ch="2,${u.id},10">${UNIT_ICON[u.id]} +10 ${u.name}</button>`).join('');
    $('cheats').onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ch]'); if (!b) return; const [a, x, y] = b.dataset.ch!.split(',').map(Number); this.h.cheat(a, x, y); };
  }

  modal(id: string, show: boolean) { $(id).hidden = !show; }

  enterGame() {
    $('intro').hidden = true; $('topbar').hidden = false; $('ledger').hidden = false; $('minimap-card').hidden = false; this.applyPanels(); this.finishLoading();
    // keep the ledger below the top bar however many rows the bar wraps to
    const bar = $('topbar'), set = () => document.documentElement.style.setProperty('--top-h', bar.offsetHeight + 'px');
    set(); new ResizeObserver(set).observe(bar);
  }
  private hoverPill = -1;
  private owner = '';
  setOwner(name: string) { this.owner = name; }

  setTab(t: string) {
    this.tab = t;
    $('tabs').querySelectorAll('.tab').forEach(x => x.classList.toggle('on', (x as HTMLElement).dataset.t === t));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + t));
  }

  private buildCards() {
    const el = $('cards');
    BUILDABLE.forEach((d, i) => {
      const c = document.createElement('div');
      c.className = 'card'; c.dataset.id = String(d.id);
      c.innerHTML = `<div class="ico">${KIND_ICON[d.id]}</div><div><div class="nm"><span>${d.name}</span>${i < 9 ? `<span class="key">${i + 1}</span>` : ''}</div>
        <div class="ds">${d.desc}</div><div class="cost">${d.cost.map(([r, n]) => `<span data-r="${r}" data-n="${n}">${RES[r].icon} ${n}</span>`).join('') || '<span>Free</span>'}</div>${this.io(d)}</div>`;
      c.onclick = () => this.h.select(d.id);
      el.appendChild(c); this.cards.set(d.id, c);
    });
  }

  private buildUnits() {
    const el = $('unit-cards');
    units.slice(0, 5).forEach(u => {
      const c = document.createElement('div'); c.className = 'card unit'; c.dataset.u = String(u.id);
      c.innerHTML = `<div class="ico">${UNIT_ICON[u.id]}</div><div><div class="nm"><span>${u.name}</span><span class="key">tier ${u.tier + 1}</span></div>
        <div class="ds">${u.desc}</div><div class="io">❤ ${u.hp} · ⚔ ${u.dmg} · 🏹 range ${u.range} · 🛡 ${u.armor}</div>
        <div class="cost">${u.cost.map(([r, n]) => `<span data-r="${r}" data-n="${n}">${RES[r].icon} ${n}</span>`).join('')}</div>
        <div class="btnrow" style="margin-top:6px"><button class="pbtn" data-train="1">Train 1</button><button class="pbtn" data-train="5">Train 5</button></div></div>`;
      c.onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-train]'); if (b) this.h.train(u.id, Number(b.dataset.train)); };
      el.appendChild(c);
    });
  }

  private io(d: BuildingDef) {
    if (!d.cycle) return d.housing ? `<div class="io">Houses ${d.housing} villagers</div>` : '';
    const f = (a: [number, number][]) => a.map(([r, n]) => `${RES[r].icon}${n}`).join(' ');
    return `<div class="io">${d.inputs.length ? f(d.inputs) + ' → ' : ''}${f(d.outputs)} every ${d.cycle}s · ${d.jobs} workers</div>`;
  }

  hotkeyKind(n: number): number | null { return BUILDABLE[n]?.id ?? null; }
  markSelected(kind: number | null) { this.cards.forEach((el, id) => el.classList.toggle('sel', id === kind)); }

  updateAffordability(stocks: number[]) {
    const mark = (el: HTMLElement) => {
      let no = false;
      el.querySelectorAll<HTMLElement>('.cost span[data-r]').forEach(s => { const short = stocks[Number(s.dataset.r)] < Number(s.dataset.n); s.classList.toggle('short', short); no ||= short; });
      el.classList.toggle('no', no);
    };
    this.cards.forEach(mark);
    document.querySelectorAll<HTMLElement>('#unit-cards .card').forEach(mark);
  }

  private buildPills() {
    const t = $('treasury');
    RES.forEach((r, i) => {
      const p = document.createElement('span'); p.className = 'pill'; p.dataset.i = String(i);
      p.innerHTML = `<span class="ic">${r.icon}</span><b>0</b><span class="d"></span>`;
      p.onmouseenter = () => { this.hoverPill = i; this.tipFor(i); };
      p.onmouseleave = () => { this.hoverPill = -1; this.lastTip = ''; $('tooltip').hidden = true; };
      t.appendChild(p); this.pills.push(p);
    });
  }
  private lastTip = '';
  private pillText: string[] = [];
  /** Show the resource tooltip under its pill. The DOM is only touched when the text really changed, so it never flickers. */
  private tipFor(i: number) {
    const el = $('tooltip'), html = this.pillText[i] ?? '';
    if (!html) return;
    if (html !== this.lastTip || el.hidden) { this.lastTip = html; el.innerHTML = html; el.hidden = false; }
    const r = this.pills[i].getBoundingClientRect(); el.style.left = Math.min(innerWidth - 280, r.left) + 'px'; el.style.top = (r.bottom + 6) + 'px';
  }

  private buildStock() {
    $('restable').innerHTML = RES.map((r, i) => `<tr title="${r.hint}"><td>${r.icon}</td><td>${r.name}</td><td class="r" id="rs-${i}">0</td><td class="r" id="rr-${i}"></td></tr>`).join('');
  }

  update(h: Hud) {
    const day = Math.floor(h.tick / 240) + 1, season = SEASONS[Math.floor((day - 1) / 10) % 4];
    $('sub').textContent = `${this.owner ? this.owner + ' · ' : ''}Day ${day} · ${season}`;
    h.stocks.forEach((v, i) => {
      const p = this.pills[i], rate = h.rates[i];
      p.querySelector('b')!.textContent = String(v);
      const d = p.querySelector('.d') as HTMLElement; d.textContent = Math.abs(rate) >= 1 ? (rate > 0 ? '+' : '') + Math.round(rate) : ''; d.classList.toggle('neg', rate < 0);
      p.classList.toggle('low', i === 10 && v < 25);
      p.classList.toggle('full', v >= h.storage);
      this.pillText[i] = `<b>${RES[i].icon} ${RES[i].name}</b><small>${v} / ${h.storage} stored</small><small>${rate >= 0 ? '+' : ''}${Math.round(rate)} per minute</small>${rate < -0.5 && v > 0 ? `<small class="warn">Runs out in about ${v / -rate < 1 ? 'a minute' : Math.round(v / -rate) + ' min'}</small>` : ''}<small>${RES[i].hint}</small>`;
      if (this.hoverPill === i) this.tipFor(i);
      $(`rs-${i}`).textContent = String(v);
      const rr = $(`rr-${i}`); rr.textContent = Math.abs(rate) >= 0.5 ? `${rate > 0 ? '+' : ''}${Math.round(rate)}/min` : '–'; rr.className = 'r ' + (rate > 0.5 ? 'pos' : rate < -0.5 ? 'neg' : '');
    });
    const soldiers = h.army.reduce((a, b) => a + b, 0);
    ($('v-pop').querySelector('b') as HTMLElement).textContent = `${h.pop}/${h.cap}`;
    ($('v-army').querySelector('b') as HTMLElement).textContent = String(soldiers + h.guards);
    ($('v-sick').querySelector('b') as HTMLElement).textContent = String(h.sick);
    ($('v-joy').querySelector('.ic') as HTMLElement).textContent = h.joy >= 70 ? '😊' : h.joy >= 40 ? '🙂' : h.joy >= 20 ? '😐' : '😟'; ($('v-joy').querySelector('b') as HTMLElement).textContent = String(h.joy);
    ($('v-work').querySelector('b') as HTMLElement).textContent = h.jobs ? `${h.eff}%` : '–';
    $('v-sick').style.opacity = h.sick ? '1' : '.5';
    $('s-pop').textContent = String(h.pop); $('s-cap').textContent = String(h.cap); $('s-sick').textContent = String(h.sick);
    $('s-eff').textContent = h.jobs ? `${h.eff}%` : '–'; $('s-bld').textContent = String(h.buildings); $('s-rad').textContent = String(h.radius);
    ($('b-house') as HTMLElement).style.width = `${Math.min(100, (h.pop / Math.max(1, h.cap)) * 100)}%`;
    const maxStock = Math.max(...h.stocks);
    ($('b-store') as HTMLElement).style.width = `${Math.min(100, (maxStock / h.storage) * 100)}%`;
    $('b-store').parentElement!.classList.toggle('red', maxStock >= h.storage * 0.95);
    $('t-store').textContent = `Each resource holds up to ${h.storage}. Upgrade the Town Hall to store more.`;
    if (h.vitals) {
      const v = h.vitals, died = v[4] + v[5] + v[6] + v[7] + v[8];
      $('care-stats').innerHTML = [[v[0], 'Born'], [v[1], 'Arrived'], [died, 'Died'], [v[9], 'Unburied'], [`${v[12]}/${v[11]}`, 'Grave plots'], [h.beds ?? 0, 'Hospital beds'], [h.devotion ?? 0, 'Devotion']].map(([n, l]) => `<div class="stat${l === 'Unburied' && v[9] >= 3 ? ' bad' : ''}"><b>${n}</b><span>${l}</span></div>`).join('');
      $('care-info').textContent = `Deaths: ${v[4]} of old age, ${v[5]} plague, ${v[6]} hunger, ${v[7]} cold, ${v[8]} in battle. ${v[10]} have been laid to rest. ` + (v[9] >= 3 ? 'Unburied dead spread sickness: build a Graveyard or a Chapel.' : v[11] === 0 ? 'No graveyard yet: only a few can be buried in the fields each day.' : 'A Hospital cures the sick; a Chapel holds a service every seventh day.');
    }
    this.updateAffordability(h.stocks);
    // army tab
    $('army-stats').innerHTML = h.army.map((n, i) => `<div class="stat"><b>${n}</b><span>${UNIT_ICON[i]} ${units[i].name}${h.queued[i] ? ` (+${h.queued[i]})` : ''}${h.away[i] ? ` · ${h.away[i]} away` : ''}</span></div>`).join('');
    $('army-info').innerHTML = `${h.guards} guards defend your towers and hall for free. ` + (h.barracks < 0 ? '<b>Build a Barracks to train soldiers.</b>' : `Your barracks is tier ${h.barracks + 1}.`) + ` Soldiers eat grain.`;
    document.querySelectorAll<HTMLElement>('#unit-cards .card').forEach(c => { const u = units[Number(c.dataset.u)]; c.classList.toggle('locked', h.barracks < u.tier); });
  }

  /** Rival villages in the shared world. */
  setPeers(rows: PeerRow[], world: string) {
    this.peers = rows;
    $('mp-count').textContent = rows.length ? `${rows.length + 1} players` : 'Online';
    $('mp-world').textContent = world;
    const list = rows.length ? rows.map(r => `<li><b>${esc(r.name)}</b> — ${r.pop} villagers, ${r.buildings} buildings · ${r.sync} <button class="chip" data-peer="${esc(r.key)}">Visit</button></li>`).join('') : '<li class="muted">Nobody else is here yet.</li>';
    $('peer-list').innerHTML = list; $('mp-peers').innerHTML = list;
    const form = $('attack-form');
    const sig = rows.map(r => r.key + r.busy).join(',');
    if (sig !== this.armyShown) {
      this.armyShown = sig;
      form.innerHTML = rows.length
        ? `<select id="atk-target">${rows.map(r => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join('')}</select>
           <div class="atk-row">${units.slice(0, 5).map(u => `<label title="${u.name}">${UNIT_ICON[u.id]}<input type="number" min="0" value="0" id="atk-${u.id}"></label>`).join('')}</div>
           <button class="pbtn danger" id="atk-go">⚔ March!</button>
           <h4>Trade</h4>
           <div class="atk-row"><select id="trd-res">${RES.map((r, i) => `<option value="${i}">${r.icon} ${r.name}</option>`).join('')}</select><label title="Amount">#<input type="number" min="1" max="500" value="50" id="trd-amt"></label><label title="Spearmen as escort">🛡<input type="number" min="0" value="0" id="trd-esc"></label></div>
           <div class="btnrow"><button class="pbtn" id="trd-send">🐴 Send caravan</button><button class="pbtn" id="trd-pact">🤝 Trade pact</button><button class="pbtn" id="trd-peace">🕊 Peace</button></div>
           <h4>Diplomacy</h4><p class="muted" id="dip-rel"></p>
           <div class="btnrow"><button class="pbtn" id="dip-envoy" title="Send an envoy with gifts (20 gold, once every 3 days)">📜 Envoy</button><button class="pbtn" id="dip-ally" title="An alliance needs a trade pact and warm relations">🛡 Alliance</button><button class="pbtn" id="dip-marry" title="Marry into their house: 150 gold, needs good relations">💍 Marriage</button><button class="pbtn danger" id="dip-war" title="Declare war: treaties end and relations collapse">🔥 Declare war</button></div>`
        : '<p class="muted">No other villages to attack yet — invite someone, or wait for neighbours to arrive.</p>';
      const trade = (action: string) => { const key = ($('atk-target') as HTMLSelectElement).value; this.h.trade(key, action, Number(($('trd-res') as HTMLSelectElement).value), Number(($('trd-amt') as HTMLInputElement).value) || 0, Number(($('trd-esc') as HTMLInputElement).value) || 0); };
      for (const [id, a] of [['trd-send', 'caravan'], ['trd-pact', 'pact'], ['trd-peace', 'peace'], ['dip-envoy', 'envoy'], ['dip-ally', 'alliance'], ['dip-marry', 'marriage'], ['dip-war', 'war']] as const) { const b = document.getElementById(id); if (b) b.onclick = () => trade(a); }
      const go = document.getElementById('atk-go');
      if (go) go.onclick = () => {
        const key = ($('atk-target') as HTMLSelectElement).value, u = units.slice(0, 5).map(x => Number(($(`atk-${x.id}`) as HTMLInputElement).value) || 0);
        if (u.some(n => n > 0)) this.h.attack(key, u);
      };
    }
    const sel = document.getElementById('atk-target') as HTMLSelectElement | null, rel = document.getElementById('dip-rel');
    if (sel && rel) {
      const show = () => { const r = rows.find(x => x.key === sel.value); rel.textContent = r ? `${r.name}: ${relWord(r.rel ?? 0)} (${r.rel ?? 0})${r.married ? ' · married into our house' : ''}${(r.treaties ?? 0) & 4 ? ' · allies' : ''}${(r.treaties ?? 0) & 2 ? ' · at peace' : ''}${(r.treaties ?? 0) & 1 ? ' · trade pact' : ''}` : ''; };
      sel.onchange = show; show();
    }
  }

  /** The red banner while a fight is on. */
  battle(text: string | null) { const b = $('battle'); b.hidden = !text; if (text) b.innerHTML = text; }
  private armyNow: number[] = [];
  maxAttack(army: number[]) { this.armyNow = army; units.slice(0, 5).forEach(u => { for (const p of ['atk', 'mus']) { const i = document.getElementById(`${p}-${u.id}`) as HTMLInputElement | null; if (i) i.max = String(army[u.id]); } }); }

  setSelectedPane(html: string | null) {
    const tab = $('tab-sel');
    if (html === null) { tab.hidden = true; if (this.tab === 'sel') this.setTab('build'); return; }
    $('pane-sel').innerHTML = html; tab.hidden = false;
  }
  showSelectedTab() { this.setTab('sel'); }
  get currentTab() { return this.tab; }

  log(text: string, tone: string, tick: number) {
    const li = document.createElement('li'); li.className = tone;
    li.innerHTML = `<small>Day ${Math.floor(tick / 240) + 1}</small> ${text}`;
    const ul = $('log'); ul.prepend(li); if (++this.logCount > 40) ul.lastElementChild?.remove();
  }
  toast(text: string, tone = 'info') {
    const t = document.createElement('div'); t.className = 'toast ' + tone; t.textContent = text; $('toasts').appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .5s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 500); }, 6000);
  }
  hint(text: string | null, bad = false) { const h = $('hint'); h.hidden = !text; if (text) { h.textContent = text; h.classList.toggle('bad', bad); } }
  tip(html: string | null, x = 0, y = 0) {
    const t = $('tooltip'); t.hidden = !html; if (!html) return;
    t.innerHTML = html; t.style.left = Math.min(innerWidth - 280, x + 16) + 'px'; t.style.top = (y + 18) + 'px';
  }
  setSpeed(n: number) { $('speed').querySelectorAll('.btn').forEach(b => b.classList.toggle('on', Number((b as HTMLElement).dataset.s) === n)); }
  setResourcesToggle(on: boolean) { $('btn-res').setAttribute('aria-pressed', String(on)); $('btn-res').classList.toggle('on', on); }
  netStatus(s: string) { $('net-status').textContent = s; }
  get labels() { return $('labels'); }
  costHtml(c: [number, number][], stocks: number[]) { return c.map(([r, n]) => `<span class="${stocks[r] < n ? 'short' : ''}">${RES[r].icon} ${n}</span>`).join(' '); }
  fmt = fmtCost;
}

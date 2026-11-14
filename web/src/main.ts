import '@fontsource/im-fell-english-sc';
import '@fontsource/im-fell-english';
import '@fontsource/im-fell-english/400-italic.css';
import '@fontsource/alegreya-sans/400.css';
import '@fontsource/alegreya-sans/500.css';
import '@fontsource/alegreya-sans/700.css';
import './ui/style.css';
import * as THREE from 'three';
import init, { World, upgrade_cost_flat, village_sites, tunnels_flat } from './wasm/game_core.js';
import { CATS, DEPOSIT, EVENT_TEXT, PLACE_ERRORS, RES, STATUS, defs, tierName, KIND_ICON, units, NOPAD, PEN_SPACING } from './data';
import { PenPreview } from './render/pen';
import { WorldShips } from './render/ships';
import { buildModelVillage, type ModelApi } from './modelvillage';
import { Terrain } from './render/terrain';
import { Atmosphere } from './render/sky';
import { CameraRig } from './render/camera';
import { Forest } from './render/trees';
import { buildModel, Effects } from './render/buildings';
import { Deposits } from './render/deposits';
import { Crowd } from './render/crowd';
import { Effects2 } from './render/fx';
import { Wildlife } from './render/wildlife';
import { UI, esc, toggleFullscreen } from './ui/ui';
import { keys, digitOf } from './keys';
import { Perf } from './perf';
import { Sound } from './audio';
import { Minimap, type MapVillage } from './ui/minimap';
import { Tunnels } from './render/tunnels';
import { startAgentBridge } from './agent';
import { Identity, Room, tagOf, type Cmd, type Signed, type Hello } from './net/p2p';
import { Village, type Shared } from './village';
import { PathLine, STATE_TEXT } from './render/field';

await init();

const radii = defs.map(d => d.r);
const sound = new Sound();
const nextFrame = () => new Promise<void>(r => setTimeout(r, 20));
/** Game ticks per real second at 1x. Half a tick per second keeps the pace of the village calm and readable. */
const TICK_RATE = 0.5;
const params = new URLSearchParams(location.search);
const NAMES = ['Aldric', 'Beatrix', 'Cedric', 'Dunstan', 'Eleanor', 'Fulk', 'Godric', 'Hawise', 'Isolde', 'Jocelin', 'Leofric', 'Matilda', 'Osric', 'Rowena', 'Wulfric'];

const ui: UI = new UI({
  start: (w, n) => startGame(w, n),
  select: k => selectKind(k === selectedKind ? null : k),
  act: a => onAct(a),
  speed: n => setSpeed(n),
  toggleResources: () => toggleResources(),
  muster: u => doMuster(u),
  detAction: (a, id) => detAction(a, id),
  toggleMute: () => { sound.setMuted(!sound.muted); ui.setMuteIcon(sound.muted); },
  minimapClick: (x, z) => rig?.focus(x, z),
  train: (k, n) => doTrain(k, n),
  attack: (key, u) => doAttack(key, u),
  focusPeer: key => { const r = rivals.get(key); if (r) rig.focus(r.village.ox, r.village.oz, 80); },
  cheat: (a, x, y) => doCheat(a, x, y),
  copyLink: () => navigator.clipboard?.writeText(`${location.origin}${location.pathname}?world=${encodeURIComponent(worldName)}`),
}, params.get('world') ?? 'flanders', localStorage.getItem('flanders:name') ?? NAMES[Math.floor(Math.random() * NAMES.length)]);

// interface sounds
document.addEventListener('click', e => { if ((e.target as HTMLElement)?.closest?.('button,.card,.chip,.tab')) sound.click(); });
let lastHover: Element | null = null;
document.addEventListener('mouseover', e => { const t = (e.target as HTMLElement)?.closest?.('.btn,.card,.tab,.chip,.pbtn'); if (t && t !== lastHover) { lastHover = t; sound.hover(); } else if (!t) lastHover = null; });

// ---------- game state ----------
let worldName = 'flanders', seedBig = 1n, started = false;
let renderer!: THREE.WebGLRenderer, scene!: THREE.Scene, terrain!: Terrain, forest!: Forest, atmo!: Atmosphere, rig!: CameraRig;
let bigMap!: Minimap;
let penPreview!: PenPreview;
let moatWidth = 0;   // 0..7: how broad the moat you dig is (the R key changes it)
let penStart: { x: number; z: number } | null = null;   // the wall pen: where the stroke began
let tunnels!: Tunnels;
let deposits!: Deposits, minimap!: Minimap, effects!: Effects, crowd!: Crowd, fx!: Effects2, wildlife!: Wildlife, shared!: Shared;
let lv!: Village;                           // your village
interface Rival { key: string; peerId: string; name: string; site: number; village: Village; online: boolean; sync: string; tick: number }
const rivals = new Map<string, Rival>();    // by public key
const byPeer = new Map<string, string>();   // peerId -> pub
let sites: { x: number; z: number }[] = [];
let mySite = 0, myName = 'Traveller';
const cleanName = (n: unknown) => String(n ?? '').replace(/[<>&"']/g, '').trim().slice(0, 20) || 'Traveller';
let perf!: Perf;
let selectedKind: number | null = null, rot = 0, ghost: THREE.Group | null = null, ghostCode = 99;
let selectedIdx: number | null = null;
const selRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.12, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.9, depthTest: false }));
const borderRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.012, 160).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.5 }));
let speed = 1, acc = 0, showDeposits = false;
const rates = new Array(RES.length).fill(0);
const depLabels: HTMLElement[] = [];
const hallLabels = new Map<string, HTMLElement>();
let pathLine!: PathLine;
let obstCache: { x: number; z: number; r: number }[] = [];
let selectedDet: number | null = null;
let selectedRuin: number | null = null;
const attackTargets = new Map<number, string>();   // field army id -> the rival it is marching on
let ghostRing!: THREE.Mesh, previewKey = '';

/** Bumped whenever the map generator changes: every world gets a fresh map and old saves are discarded. */
const MAP_VERSION = 7;
/** The map layout comes from the world name plus this salt. It stays at 3 (the layout of the earlier maps that players liked) even when MAP_VERSION moves on; change it only to deliberately roll new continents. */
const SEED_SALT = 3;
const hashSeed = (s: string) => { if (/^\d{1,15}$/.test(s)) return BigInt(s) + BigInt(SEED_SALT) * 1000003n; let h = 1469598103934665603n; for (const c of (s.toLowerCase() + '|map' + SEED_SALT)) h = ((h ^ BigInt(c.charCodeAt(0))) * 1099511628211n) & 0xffffffffffffn; return h; };

// ---------- commands, saving, networking ----------
let identity!: Identity;
let room: Room | null = null;
const myLog: Signed[] = [];
let cmdN = 0, sendChain: Promise<void> = Promise.resolve(), saveTimer = 0;
const myTag = () => tagOf(identity.pub);
const slot = params.get('player') ?? ''; // lets several players share one browser profile (testing)
let resetting = false;   // set while the full reset is wiping the saves, so nothing writes them back
const saveKey = () => `flanders:save:v${MAP_VERSION}:${worldName}${slot ? ':' + slot : ''}`;
// maps made by older generators are gone: their saved villages would not fit the new terrain, so they are removed
try { for (const k of Object.keys(localStorage)) if (k.startsWith('flanders:save:') && !k.startsWith(`flanders:save:v${MAP_VERSION}:`)) localStorage.removeItem(k); } catch { /* storage blocked */ }

function applyCmd(w: World, c: Cmd) {
  switch (c.op) {
    case 'place': w.place(c.kind!, c.x!, c.y!, c.rot ?? 0); break;
    case 'upgrade': w.upgrade(c.idx!); break;
    case 'demolish': w.demolish(c.idx!); break;
    case 'train': w.train(c.kind!, c.x!); break;
    case 'attack': w.send_army(Uint32Array.from(c.units ?? [])); break;
    case 'raid': w.start_raid(c.angle ?? 0, Uint32Array.from(c.units ?? []), c.tag ?? 1); break;
    case 'cheat': w.cheat(c.kind ?? 0, c.x ?? 0, c.y ?? 0); break;
    case 'repair': w.repair(c.idx!); break;
    case 'garrison': w.garrison_set(c.idx!, c.kind ?? 0); break;
    case 'bridge': w.drawbridge_set(c.idx!, (c.kind ?? 0) === 1); break;
    case 'option': w.set_option(c.idx!, c.kind ?? 0, (c.x ?? 1) === 1); break;
    case 'flatten': w.flatten(c.x ?? 60); break;
    case 'treaty': if ((c.y ?? 1) === 0) w.treaty_end(c.idx!, c.kind ?? 0); else w.treaty_set(c.idx!, c.kind ?? 0, c.x ?? 10); break;
    case 'caravan': w.caravan_send(c.kind ?? 0, c.x ?? 0, c.idx ?? 0, c.y ?? 0, c.ax ?? 0); break;
    case 'rebuild': w.rebuild(c.idx!); break;
    case 'form': w.det_form(Uint32Array.from(c.units ?? [])); break;
    case 'march': w.det_march(c.idx!, c.x!, c.y!, !!c.to, c.ax ?? 0, c.ay ?? 0); break;
    case 'recall': w.det_recall(c.idx!); break;
    case 'split': w.det_split(c.idx!, Uint32Array.from(c.units ?? [])); break;
    case 'merge': w.det_merge(c.idx!, c.kind!); break;
    case 'halt': w.det_halt(c.idx!); break;
    case 'sendatk': w.det_send(c.idx!); break;
    case 'return': w.return_army(Uint32Array.from(c.units ?? []), Int32Array.from(c.loot ?? [])); break;
    default: break; // 'refuse' has no effect on the issuer's own world
  }
}
const stepTo = (w: World, t: number) => { let n = 0; while (w.tick() < BigInt(t) && n++ < 20000) w.step(); };

/** Record a command that was already applied to your own village: sign it, save it and tell everyone. */
async function commit(cmd: Omit<Cmd, 'tick' | 'n'>) {
  const full: Cmd = { ...cmd, tick: Number(lv.world.tick()), n: cmdN++ };
  const signing = identity.sign(full);
  sendChain = sendChain.then(async () => { const s = await signing; myLog.push(s); room?.broadcastCmd(s); save(); });
  await sendChain;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (resetting) return;
    try { localStorage.setItem(saveKey(), JSON.stringify({ site: mySite, name: myName, log: myLog, savedAt: Date.now(), tick: Number(lv.world.tick()) })); } catch { /* storage full or blocked */ }
  }, 400);
}

const siteOrigin = (i: number) => ({ x: Math.round(sites[i].x), z: Math.round(sites[i].z) });
const claimedSites = () => new Set([...rivals.values()].map(r => r.site));

function pickSite() {
  const taken = claimedSites();
  for (let i = 0; i < sites.length; i++) if (!taken.has(i)) return i;
  return 0;
}

/** Rebuild your village at another site from your signed history (used when two players picked the same spot). */
function moveToSite(i: number) {
  mySite = i; const o = siteOrigin(i), keep = Number(lv.world.tick());
  const w = new World(seedBig, o.x, o.z);
  for (const s of myLog) { const c = JSON.parse(s.cmd) as Cmd; stepTo(w, c.tick); applyCmd(w, c); }
  stepTo(w, keep);
  lv.setWorld(w);
  terrain.resetPads(); for (const r of rivals.values()) refreshTerrain(r.village.world);
  refreshTerrain(w); lv.syncFull(); rig.focus(o.x, o.z); save(); room?.announce();
}

function connect() {
  room = new Room(worldName, (): Hello => ({ pub: identity.pub, site: mySite, name: myName, tick: Number(lv.world.tick()), world: worldName }), () => myLog, {
    onStatus: s => ui.netStatus(s),
    onHello: (peerId, h) => {
      if (h.world !== worldName) return;
      h.name = cleanName(h.name);
      byPeer.set(peerId, h.pub);
      if (h.site === mySite && h.pub !== identity.pub) {
        // two villages on one spot: the player with the larger key moves out
        if (identity.pub > h.pub) { const free = [...Array(sites.length).keys()].find(i => i !== h.site && !claimedSites().has(i)); if (free !== undefined) moveToSite(free); }
        else { const r = rivals.get(h.pub); if (!r) { /* they will move; wait for their next hello */ } }
      }
      let r = rivals.get(h.pub);
      if (!r) {
        const o = siteOrigin(h.site);
        const village = new Village(new World(seedBig, o.x, o.z), 'rival:' + h.pub, h.name, false, shared, 0xb03030);
        village.onReport = rep => onRivalReport(h.pub, rep);
        r = { key: h.pub, peerId, name: h.name, site: h.site, village, online: true, sync: 'syncing…', tick: 0 };
        rivals.set(h.pub, r); ui.toast(`${h.name} has joined the world.`, 'good');
        refreshTerrain(village.world); village.syncFull();
      } else if (r.site !== h.site) {
        // they moved to another site: rebuild their replica there once their log arrives
        const o = siteOrigin(h.site); r.site = h.site; r.village.setWorld(new World(seedBig, o.x, o.z)); terrain.resetPads(); refreshAll();
      }
      r.peerId = peerId; r.online = true; r.name = h.name; updatePeers();
    },
    onLog: (peerId, cmds) => {
      const r = rivals.get(byPeer.get(peerId) ?? ''); if (!r) return;
      const o = siteOrigin(r.site), w = new World(seedBig, o.x, o.z);
      for (const c of cmds) { stepTo(w, c.tick); applyCmd(w, c); }
      r.village.setWorld(w); r.tick = Number(w.tick());
      refreshTerrain(w); r.village.syncFull(); r.village.markCaughtUp(); r.village.afterTick(); r.village.markCaughtUp(); updatePeers();
    },
    onCmd: (peerId, c) => {
      const r = rivals.get(byPeer.get(peerId) ?? ''); if (!r) return;
      r.village.advanceTo(c.tick); applyCmd(r.village.world, c);
      if (c.op === 'place' || c.op === 'demolish' || c.op === 'rebuild' || c.op === 'cheat' || c.op === 'upgrade' || c.op === 'flatten') refreshTerrain(r.village.world);
      r.village.syncFull(); r.village.afterTick(); r.tick = c.tick;
      if ((c.op === 'attack' || c.op === 'sendatk') && c.to === identity.pub) defendAgainst(r, c);
      else if (c.op === 'refuse' && c.to === identity.pub) {
        lv.world.return_army(Uint32Array.from(c.units ?? []), new Int32Array(RES.length));
        commit({ op: 'return', units: c.units, loot: new Array(RES.length).fill(0) }); ui.toast('Your army was turned back — the village was already under attack.', 'info');
      }
      if (c.op === 'raid') ui.toast(`${r.name}'s village is under attack!`, 'info');
    },
    onHash: (peerId, tick, hash) => {
      const r = rivals.get(byPeer.get(peerId) ?? ''); if (!r) return;
      if (!Number.isFinite(tick) || tick > r.tick + 2 || tick < 0) return;   // a hash from the future would make us run the replica ahead on a stranger's say-so
      r.village.advanceTo(tick); r.tick = tick;
      r.sync = r.village.world.tick() === BigInt(tick) && r.village.world.state_hash().toString() === hash ? 'in sync ✓' : 'out of sync ⚠';
    },
    onLeave: peerId => { const r = rivals.get(byPeer.get(peerId) ?? ''); if (r) { r.online = false; r.sync = 'away'; ui.toast(`${r.name} has left the world.`, 'info'); } byPeer.delete(peerId); updatePeers(); },
  });
}

/** The thump, dust and shake when something is built; heavier buildings land harder. */
function placedFx(kind: number, x: number, z: number, upgrade = false) {
  const wgt = defs[kind].weight;
  if (!upgrade) sound.place(wgt);
  for (let i = 0; i < 1 + Math.floor(wgt / 2); i++) fx.burst(x + (Math.random() - 0.5) * defs[kind].r, z + (Math.random() - 0.5) * defs[kind].r, false);
  rig.shake(0.05 + wgt * 0.04);
  updateGoals();
}

// ---------- goals: gentle guidance for new players ----------
const GOALS: { text: string; detail?: string; ok: (c: Counts) => boolean }[] = [
  { text: 'Build 3 houses', detail: 'Press 1 and click the ground', ok: c => c.n(0) >= 3 },
  { text: 'Build a farm', detail: 'Your people need grain', ok: c => c.n(1) >= 1 },
  { text: 'Build a woodcutter near a forest', ok: c => c.n(4) >= 1 },
  { text: 'Build a sawmill for planks', ok: c => c.n(5) >= 1 },
  { text: 'Open a quarry at a stone outcrop', detail: 'Press V to find deposits', ok: c => c.n(6) >= 1 },
  { text: 'Build a hunter\'s lodge', detail: 'Venison feeds more people', ok: c => c.n(18) >= 1 },
  { text: 'Reach 20 villagers', ok: c => c.pop >= 20 },
  { text: 'Dig clay and fire bricks', detail: 'Clay pit + charcoal burner + brickworks', ok: c => c.n(7) >= 1 && c.n(8) >= 1 },
  { text: 'Dig an iron mine', detail: 'You need tools to build it', ok: c => c.n(9) >= 1 },
  { text: 'Raise a watchtower and a well', ok: c => c.n(3) >= 1 && c.n(16) >= 1 },
  { text: 'Upgrade the town hall to a manor', ok: c => c.hall >= 1 },
  { text: 'Build a barracks and train soldiers', ok: c => c.n(19) >= 1 && c.army >= 5 },
  { text: 'Build a mint and make gold', ok: c => c.n(14) >= 1 },
  { text: 'Upgrade the town hall to a keep', ok: c => c.hall >= 2 },
  { text: 'Join other players: see the globe button', ok: c => c.rivals >= 1 },
  { text: 'Raise your castle', ok: c => c.hall >= 3 },
];
interface Counts { n(kind: number): number; pop: number; hall: number; army: number; rivals: number }
function updateGoals() {
  if (!lv) return;
  const f = lv.world.buildings_flat(), cnt = new Map<number, number>();
  for (let i = 0; i < f.length; i += 10) cnt.set(f[i], (cnt.get(f[i]) ?? 0) + 1);
  const c: Counts = { n: k => cnt.get(k) ?? 0, pop: lv.world.population(), hall: f[1], army: Array.from(lv.world.army()).reduce((a, b) => a + b, 0), rivals: rivals.size };
  ui.setGoals(GOALS.map(g => ({ text: g.text, detail: g.detail, done: g.ok(c) })));
}

// ---------- testing tools ----------
/** Test tool: forget every saved village (all worlds) in this browser and start again from the empty map. Your identity and settings are kept. */
function fullReset() {
  if (!confirm('This deletes every saved village in this browser, in every world, and restarts from the empty map. Other players keep their own copies of your old village until they leave. Continue?')) return;
  resetting = true;
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('flanders:save:')) localStorage.removeItem(k); } catch { /* blocked */ }
  location.reload();
}

/** Clear every building except the town hall and build the planned model village (see modelvillage.ts). Everything goes through signed commands. */
const MODEL_FLAT_RADIUS = 72;
function runModelVillage(ask: boolean) {
  if (ask && !confirm('This clears every building except the town hall and builds a model village in its place. Continue?')) return;
  const w = lv.world;
  if (w.battle_active()) { ui.toast('Not during a battle.', 'bad'); return; }
  if (w.cheat(8, 0, 0)) commit({ op: 'cheat', kind: 8, x: 0, y: 0 });   // clear old earthworks, craters, scorch and ruins first
  w.cheat(7, 0, 0) && commit({ op: 'cheat', kind: 7, x: 0, y: 0 });
  for (let i = w.building_count() - 1; i >= 1; i--) if (w.demolish(i)) commit({ op: 'demolish', idx: i });
  // level the whole site first: the castle is only raised once the ground under it is flat
  if (w.flatten(MODEL_FLAT_RADIUS) === 0) commit({ op: 'flatten', x: MODEL_FLAT_RADIUS });
  afterLocalChange(); refreshTerrain(w);
  const fill = () => { if (w.cheat(3, 0, 0)) commit({ op: 'cheat', kind: 3, x: 0, y: 0 }); };
  const api: ModelApi = {
    place(kind, x, y, rot = 0, search = 8) {
      for (let r = 0; r <= search; r += 1.5) for (let k = 0; k < (r ? 8 : 1); k++) {
        const a = k * Math.PI / 4 + r, px = Math.round(x + Math.cos(a) * r), py = Math.round(y + Math.sin(a) * r);
        const st = Array.from(w.stocks()); if (defs[kind].cost.some(([res, n]) => st[res] < n)) fill();
        const i = w.place(kind, px, py, rot); if (i >= 0) { commit({ op: 'place', kind, x: px, y: py, rot }); return i; }
      }
      return -1;
    },
    upgrade(i) { let c = w.upgrade(i); if (c === -6) { fill(); c = w.upgrade(i); } if (c === 0) { commit({ op: 'upgrade', idx: i }); return true; } return false; },
    option(i, bit) { let c = w.set_option(i, bit, true); if (c === -6) { fill(); c = w.set_option(i, bit, true); } if (c === 0) { commit({ op: 'option', idx: i, kind: bit, x: 1 }); return true; } return false; },
    garrison(i, n) { if (w.garrison_set(i, n) === 0) commit({ op: 'garrison', idx: i, kind: n }); },
    wet(x, y) { return w.height_at(w.origin_x() + x, w.origin_y() + y) < 0; },
    at(i) { const f = w.buildings_flat(); return [f[i * 10 + 2] - w.origin_x(), f[i * 10 + 3] - w.origin_y()]; },
    fill,
    soldiers(kind, n) { if (w.cheat(2, kind, n)) commit({ op: 'cheat', kind: 2, x: kind, y: n }); },
  };
  buildModelVillage(api);
  afterLocalChange(); lv.afterTick(); updateHud(); updateSelection();
  const f = w.buildings_flat(); rig.focus(f[2], f[3], 90);
  ui.toast(`Your model village is ready: ${w.building_count()} buildings.`, 'good');
}

function doCheat(action: number, a: number, b: number) {
  if (action === 100) { runModelVillage(true); return; }
  if (action === 101) { fullReset(); return; }
  if (action === 102) { if (lv.world.flatten(a) === 0) { commit({ op: 'flatten', x: a }); afterLocalChange(); refreshTerrain(lv.world); ui.toast('The ground is levelled.', 'good'); } return; }
  if (action === 5) a = selectedIdx ?? -1;           // "burn selected building"
  if (action === 5 && a < 0) { ui.toast('Select a building first.', 'info'); return; }
  if (!lv.world.cheat(action, a, b)) return;
  commit({ op: 'cheat', kind: action, x: a, y: b });
  if (action === 8) { selectBuilding(null); afterLocalChange(); ui.toast('The terrain was reset.', 'good'); return; }
  if (action === 7) ui.toast('All fires are out.', 'good');
  lv.afterTick(); updateSelection(); updateHud();
}

// ---------- war between players ----------
function doTrain(kind: number, n: number) {
  const res = lv.world.train(kind, n);
  if (res !== 0) { ui.toast(PLACE_ERRORS[res] ?? 'Cannot train that', 'bad'); return; }
  commit({ op: 'train', kind, x: n }); sound.train(); ui.toast(`${n} × ${units[kind].name} queued at the barracks.`, 'good'); lv.afterTick(); updateHud();
}

function doAttack(key: string, u: number[]) {
  const r = rivals.get(key); if (!r || !r.online) { ui.toast('That village is not online right now.', 'bad'); return; }
  if (lv.world.battle_active()) { ui.toast('You cannot march while your own village is under attack.', 'bad'); return; }
  const id = lv.world.det_form(Uint32Array.from(u));
  if (!id) { ui.toast('You do not have that many soldiers.', 'bad'); return; }
  commit({ op: 'form', units: u });
  const dx = lv.ox - r.village.ox, dz = lv.oz - r.village.oz, dl = Math.hypot(dx, dz) || 1, stand = r.village.radius + 12;   // halt just outside their border, on our side
  const tx = r.village.ox + dx / dl * stand, tz = r.village.oz + dz / dl * stand;
  const res = lv.world.det_march(id, tx, tz, true, r.village.ox, r.village.oz);
  if (res !== 0) { ui.toast(MARCH_ERRORS[res] ?? 'No route there.', 'bad'); return; }
  attackTargets.set(id, key); commit({ op: 'march', idx: id, x: tx, y: tz, to: key, ax: r.village.ox, ay: r.village.oz });
  selectDet(id); ui.toast(`Your army sets out for ${r.name}. It attacks when it arrives.`, 'good'); updateHud();
}

// ---------- field armies: muster, select, order ----------
const MARCH_ERRORS: Record<number, string> = { [-1]: 'That army no longer exists.', [-2]: 'There is no way through to there.', [-3]: 'Catapults need spearmen or swordsmen with them to cut a way through the forest.', [-5]: 'That water is too wide to cross.' };

function doMuster(u: number[]) {
  const id = lv.world.det_form(Uint32Array.from(u));
  if (!id) { ui.toast('You do not have that many soldiers in the barracks.', 'bad'); return; }
  commit({ op: 'form', units: u }); lv.afterTick(); selectDet(id); updateHud(); ui.toast('Field army mustered. Right-click the ground to send it somewhere.', 'good');
}

let multiDets: number[] = [];   // every selected army; selectedDet is the first
function selectDet(id: number | null) { selectDets(id === null ? [] : [id]); }
function selectDets(ids: number[]) {
  multiDets = ids; selectedDet = ids[0] ?? null; lv.field.select(ids);
  if (ids.length) { selectKind(null); selectBuilding(null); selectRuin(null); ui.setTab('army'); }
  showRoute(); updateDets();
}

/** Armies whose banner is inside the dragged rectangle (screen pixels). */
function boxSelect(x0: number, y0: number, x1: number, y1: number) {
  const a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(y0, y1), d = Math.max(y0, y1), v = new THREE.Vector3();
  const ids = lv.field.ids().filter(id => { const p = lv.field.position(id)!; v.set(p.x, terrain.heightAt(p.x, p.z) + 2, p.z).project(rig.cam); const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight; return v.z < 1 && sx >= a && sx <= b && sy >= c && sy <= d; });
  if (ids.length) { selectDets(ids); ui.toast(ids.length > 1 ? `${ids.length} armies selected — right-click to march them all.` : 'Army selected.', 'info'); }
}

/** Draw the selected army's remaining route. */
function showRoute() {
  if (selectedDet === null) { pathLine?.set(null); return; }
  const p = lv.world.det_path(selectedDet);
  pathLine?.set(p.length >= 6 ? Array.from(p) : null);
}

function updateDets() {
  const f = lv.world.det_flat(), list: { id: number; units: number[]; text: string; selected: boolean; leftWp: number }[] = [];
  for (let o = 0; o < f.length; o += 16) {
    const st = f[o + 8], state = STATE_TEXT[st] + (st === 3 || st === 2 ? ` (${Math.round(f[o + 11] * 100)}%)` : '');
    list.push({ id: f[o], units: [f[o + 3], f[o + 4], f[o + 5], f[o + 6], f[o + 7]], text: state, selected: multiDets.includes(f[o]), leftWp: f[o + 10] });
  }
  ui.setDets(list);
  if (multiDets.some(id => !list.some(d => d.id === id))) { multiDets = multiDets.filter(id => list.some(d => d.id === id)); selectedDet = multiDets[0] ?? null; lv.field.select(multiDets); if (selectedDet === null) pathLine?.set(null); }
}

function detUnits(id: number): number[] | null {
  const f = lv.world.det_flat(); for (let o = 0; o < f.length; o += 16) if (f[o] === id) return [f[o + 3], f[o + 4], f[o + 5], f[o + 6], f[o + 7]]; return null;
}

function orderMarch(id: number, tx: number, tz: number) {
  const r = lv.world.det_march(id, tx, tz, false, 0, 0);
  if (r !== 0) { ui.toast(MARCH_ERRORS[r] ?? 'No route there.', 'bad'); sound.error(); return; }
  attackTargets.delete(id); commit({ op: 'march', idx: id, x: tx, y: tz }); sound.click(); fx.burst(tx, tz, false); showRoute(); lv.afterTick(); updateDets();
}

function detAction(a: string, id: number) {
  const w = lv.world, u = detUnits(id); if (!u) return;
  if (a === 'select') { selectDet(selectedDet === id && multiDets.length === 1 ? null : id); return; }
  if (a === 'halt') { w.det_halt(id); attackTargets.delete(id); commit({ op: 'halt', idx: id }); }
  else if (a === 'recall') { const r = w.det_recall(id); if (r !== 0) { ui.toast(MARCH_ERRORS[r] ?? 'No route home.', 'bad'); return; } attackTargets.delete(id); commit({ op: 'recall', idx: id }); ui.toast('The army is marching home.', 'info'); }
  else if (a === 'split') {
    const take = u.map(n => Math.floor(n / 2));
    if (take.every(n => n === 0)) { ui.toast('This army is too small to split.', 'info'); return; }
    const nid = w.det_split(id, Uint32Array.from(take)); if (!nid) { ui.toast('This army cannot be split like that.', 'bad'); return; }
    commit({ op: 'split', idx: id, units: take }); ui.toast('The army split in two. Select either half and give it its own orders.', 'good');
  } else if (a === 'merge') {
    const pos = lv.field.position(id); let best = 0, bd = 12;
    if (pos) for (const o of lv.field.ids()) { if (o === id) continue; const p = lv.field.position(o)!; const d = Math.hypot(p.x - pos.x, p.z - pos.z); if (d < bd) { bd = d; best = o; } }
    if (!best || !w.det_merge(id, best)) { ui.toast('No other army close enough to merge with.', 'info'); return; }
    commit({ op: 'merge', idx: id, kind: best });
  }
  lv.afterTick(); showRoute(); updateDets(); updateHud();
}

/** Marching armies that have reached an enemy village go in. */
function checkArrivals() {
  const f = lv.world.det_flat();
  for (let o = 0; o < f.length; o += 16) {
    if (f[o + 8] !== 5) continue;
    const id = f[o], key = attackTargets.get(id), r = key ? rivals.get(key) : null;
    if (!key || !r || !r.online) { lv.world.det_halt(id); commit({ op: 'halt', idx: id }); attackTargets.delete(id); ui.toast('The village you marched on is no longer there.', 'info'); continue; }
    const u = detUnits(id)!, sent = lv.world.det_send(id);
    if (sent.length) { attackTargets.delete(id); commit({ op: 'sendatk', idx: id, to: key, units: u }); ui.toast(`Your army attacks ${r.name}!`, 'good'); }
  }
}

/** A rival sent soldiers against us: start the fight in our own (authoritative) village. */
function defendAgainst(att: Rival, c: Cmd) {
  const u = c.units ?? [], angle = Math.atan2(att.village.oz - lv.oz, att.village.ox - lv.ox), tag = tagOf(att.key);
  if (lv.world.start_raid(angle, Uint32Array.from(u), tag)) { commit({ op: 'raid', from: att.key, units: u, angle, tag }); ui.toast(`${att.name} attacks your village!`, 'bad'); lv.afterTick(); }
  else commit({ op: 'refuse', to: att.key, units: u });
}

/** A battle finished in a rival's village. If we were the attacker, our survivors come home with the loot. */
function onRivalReport(key: string, rep: number[]) {
  const [, won, tag, left, , , , ] = rep;
  void won; void left;
  if (tag !== myTag()) return;
  const surv = rep.slice(6, 11), loot = rep.slice(11, 11 + RES.length), r = rivals.get(key);
  lv.world.return_army(Uint32Array.from(surv), Int32Array.from(loot));
  commit({ op: 'return', units: surv, loot });
  const gold = loot[8];
  ui.toast(rep[1] ? `Your army was destroyed at ${r?.name ?? 'the enemy village'}.` : `Victory! Your army returns from ${r?.name ?? 'battle'} with ${gold} gold and other spoils.`, rep[1] ? 'bad' : 'good');
  updateHud();
}

function onLocalReport(rep: number[]) {
  const [, won, tag, , dead, lost] = rep;
  const who = tag === 0 ? 'The bandits' : 'The invaders';
  ui.log(won ? `${who} were driven off. ${dead} defenders fell.` : `${who} plundered the village. ${lost} buildings were lost.`, won ? 'good' : 'bad', Number(lv.world.tick()));
  if (tag !== 0 && !won) ui.toast('Your village was sacked!', 'bad');
}

function updatePeers() {
  ui.setPeers([...rivals.values()].map(r => ({ key: r.key, name: r.name + (r.online ? '' : ' (away)'), pop: r.village.world.population(), buildings: r.village.world.building_count(), sync: r.sync, busy: r.village.world.battle_active() })), worldName);
}

// ---------- start ----------
async function startGame(name: string, username: string) {
  if (started) return; started = true;
  worldName = name; seedBig = hashSeed(name); myName = cleanName(username);
  try { localStorage.setItem('flanders:name', myName); } catch { /* ignore */ }
  ui.setOwner(myName);
  sound.start(); ui.setMuteIcon(sound.muted);
  ui.beginLoading(); await nextFrame();
  identity = await Identity.load(slot);
  const flat = village_sites(seedBig); sites = [];
  for (let i = 0; i < flat.length; i += 2) sites.push({ x: flat[i], z: flat[i + 1] });
  sites.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));

  renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.78;
  scene = new THREE.Scene();
  ui.progress(10, 'Painting the sky…'); await nextFrame();
  atmo = new Atmosphere(scene, renderer);
  ui.progress(22, 'Raising the mountains…'); await nextFrame();
  terrain = new Terrain(seedBig);
  scene.add(terrain.mesh, terrain.water);
  tunnels = new Tunnels(terrain, tunnels_flat(seedBig)); scene.add(tunnels.group);
  rig = new CameraRig(ui.canvas, terrain);
  ui.progress(38, 'Planting the forests…'); await nextFrame();
  forest = new Forest(seedBig, terrain); scene.add(forest.group);
  ui.progress(50, 'Waking the animals…'); await nextFrame();
  wildlife = new Wildlife(seedBig, terrain, forest.all, Array.from(village_sites(seedBig))); scene.add(wildlife.group);
  crowd = new Crowd(); scene.add(crowd.group);
  fx = new Effects2(terrain); scene.add(fx.group);
  effects = new Effects(); scene.add(effects.smoke.points);
  scene.add(selRing, borderRing); selRing.visible = false; selRing.renderOrder = 10;
  pathLine = new PathLine(terrain); scene.add(pathLine.mesh);
  penPreview = new PenPreview(terrain); scene.add(...penPreview.objects);
  worldShips = new WorldShips(terrain); scene.add(worldShips.group);
  minimap = new Minimap(ui.minimap, terrain); bigMap = new Minimap(ui.bigmap, terrain, 900); minimap.tunnels = bigMap.tunnels = tunnels.list;
  ghostRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 56).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  ghostRing.visible = false; ghostRing.renderOrder = 9; scene.add(ghostRing);

  shared = {
    scene, terrain, wildlife, fx, radii, forest, obstacles: () => obstCache,
    terrainChanged: v => { refreshTerrain(v.world); },
    forestDirty: () => { forestDirtyFlag = true; },
  };

  ui.progress(60, 'Gathering your villagers…'); await nextFrame();
  // your village: restore from the last visit, or found a new one
  let saved: { site: number; name: string; log: Signed[]; savedAt: number; tick: number } | null = null;
  try { saved = JSON.parse(localStorage.getItem(saveKey()) ?? 'null'); } catch { /* ignore */ }
  mySite = saved && saved.site < sites.length ? saved.site : 0;
  const o = siteOrigin(mySite), w = new World(seedBig, o.x, o.z);
  let away = 0;
  if (saved) {
    for (const s of saved.log) { myLog.push(s); const c = JSON.parse(s.cmd) as Cmd; stepTo(w, c.tick); applyCmd(w, c); cmdN = Math.max(cmdN, c.n + 1); }
    stepTo(w, saved.tick);
    away = Math.min(1800, Math.floor(((Date.now() - saved.savedAt) / 1000) * TICK_RATE));
    for (let i = 0; i < away; i++) w.step();   // the world kept turning while you were away
  }
  lv = new Village(w, 'me', myName, true, shared, 0x2f5fa8);
  lv.onReport = onLocalReport;
  deposits = new Deposits(w.deposits_flat(), terrain); scene.add(deposits.group); deposits.refit();
  buildDepositLabels();
  refreshTerrain(w); lv.syncFull(); lv.markCaughtUp();
  const ev = w.take_events();
  if (away > 60 && ev.length) ui.toast(`While you were away (${Math.round(away / 60)} min): ${ev.length / 4} things happened — see the Chronicle.`, 'info');
  for (let i = 0; i < ev.length; i += 4) { const e = EVENT_TEXT(ev[i], ev[i + 1], ev[i + 2]); ui.log(e.text, e.tone, ev[i + 3]); }
  rebuildForest(); updateHud();
  rig.focus(o.x, o.z, 75); rig.snap();
  await warmUp();
  ui.setTab('build');
  ui.hint('Choose a building on the right, then click the ground. Start with houses and a farm.');
  setTimeout(() => ui.hint(null), 7000);
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); });
  bindInput();
  connect();
  setupPerf();
  const agentPort = Number(params.get('agent') ?? ''), agentToken = params.get('token') ?? '';
  if (agentPort > 0 && agentToken) startAgentBridge({
    world: () => lv.world, commit: c => commit(c as Omit<Cmd, 'tick' | 'n'>), afterChange: () => { afterLocalChange(); },
    toast: (m, k) => ui.toast(m, k ?? 'info'),
    rivals: () => [...rivals.entries()].map(([key, r]) => ({ key, name: r.name, x: r.village.ox, z: r.village.oz, online: r.online })),
    attack: (key, u) => { const r = rivals.get(key); if (!r || !r.online) return false; doAttack(key, u); return true; },
  }, agentPort, agentToken);
  setInterval(() => { save(); updatePeers(); }, 8000);
  updateGoals();
  ui.enterGame();                       // everything is ready: reveal the game
  (window as unknown as { __dbg: unknown }).__dbg = { get lv() { return lv; }, rig, get terrain() { return terrain; }, view: (x: number, z: number, dist: number, yaw: number, pitch: number) => { const g = (rig as unknown as { goal: Record<string, number> }).goal; Object.assign(g, { x, z, dist, yaw, pitch }); rig.snap(); }, cheat: (a: number, x: number, y: number) => doCheat(a, x, y), select: (i: number | null) => selectBuilding(i) };
  last = performance.now(); requestAnimationFrame(frame);
}

/** Compile every shader and draw a few real frames (shadow map, textures, trees) behind the loading screen,
 *  so nothing pops in or stalls once the player sees the world. */
async function warmUp() {
  ui.progress(74, 'Compiling shaders…'); await nextFrame();
  fx.warm(true); effects.smoke.points.visible = true;
  try { await renderer.compileAsync(scene, rig.cam); } catch { /* older drivers: the warm-up frames below compile instead */ }
  fx.warm(false);
  ui.progress(86, 'Baking shadows…'); await nextFrame();
  const view = Math.max(90, rig.dist * 1.7 + 50);
  for (let i = 0; i < 4; i++) {
    rig.update(0.016); atmo.follow(rig.target); forest.tick(0, rig.cam.position);
    crowd.begin(); lv.draw(crowd, rig.target.x, rig.target.z, view); crowd.end();
    renderer.render(scene, rig.cam);                              // the first frames compile and fill the shadow map
    (renderer.getContext() as WebGL2RenderingContext).finish();
    ui.progress(86 + i * 3, i < 3 ? 'Baking shadows…' : 'Almost ready…'); await nextFrame();
  }
  ui.progress(100, 'Welcome.'); await nextFrame();
}

// ---------- scene sync ----------
let forestDirtyFlag = false;
function rebuildForest() {
  const all = [lv, ...[...rivals.values()].map(r => r.village)];
  forest.rebuild(all.flatMap(v => v.clear), all.flatMap(v => v.clearLines)); forestDirtyFlag = false;
  obstCache = all.flatMap(v => v.obstacles);
}

function allScorch() {
  const parts = [lv, ...[...rivals.values()].map(r => r.village)].map(v => v.world.scorch_flat()), n = parts.reduce((a, p) => a + p.length, 0), out = new Float32Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

/** Re-level the ground of a whole village: pads, graded paths, craters and burn scars. */
function refreshTerrain(w: World) {
  terrain.scorch = allScorch();
  const ox = w.origin_x(), oz = w.origin_y();
  const others = [...rivals.values()].map(r => ({ x: r.village.ox, z: r.village.oz })).concat(lv ? [{ x: lv.ox, z: lv.oz }] : []).filter(p => Math.hypot(p.x - ox, p.z - oz) > 1);
  terrain.refresh(w, ox, oz, w.build_radius() + 12, others);
  deposits?.refit();
}
function refreshAll() { refreshTerrain(lv.world); for (const r of rivals.values()) refreshTerrain(r.village.world); lv.syncFull(); for (const r of rivals.values()) r.village.syncFull(); }

function afterLocalChange() { refreshTerrain(lv.world); lv.syncFull(); lv.afterTick(); if (forestDirtyFlag) rebuildForest(); updateSelection(); updateHud(); }

function updateHud() {
  const w = lv.world;
  let barracks = -1; const f = w.buildings_flat(); for (let i = 0; i < f.length; i += 10) if (f[i] === 19) barracks = Math.max(barracks, f[i + 1]);
  { const d = w.demographics(), el = document.getElementById('v-pop'); if (el) el.title = `Villagers / housing. ${d[0]} children, ${d[1]} adults (they do the work), ${d[2]} elders, about ${d[3]} couples. Year ${w.year()}. Grain harvest now ${w.grain_percent()}% of usual${w.warmth() ? '' : '. It is freezing: no firewood!'}`; }
  ui.update({
    tick: Number(w.tick()), stocks: Array.from(w.stocks()), rates, pop: w.population(), cap: w.capacity(), sick: w.sick(),
    joy: w.happiness(), eff: w.efficiency(), jobs: w.jobs(), radius: w.build_radius(), buildings: w.building_count(), storage: w.storage(),
    army: Array.from(w.army()), queued: Array.from(w.queued()), away: Array.from(w.away()), guards: w.guards(), barracks, wildlife: wildlife.count,
  });
  ui.maxAttack(Array.from(w.army())); updateDets();
  const r = borderRing; const rad = w.build_radius(); r.scale.set(rad, 1, rad); r.position.set(lv.ox, terrain.heightAt(lv.ox, lv.oz) + 0.6, lv.oz);
}

function battleBanner() {
  const list: { w: World; who: string }[] = [{ w: lv.world, who: 'your village' }, ...[...rivals.values()].map(r => ({ w: r.village.world, who: r.name + "'s village" }))];
  for (const { w, who } of list) {
    if (!w.battle_active()) continue;
    const u = w.battle_units_flat(); let d = 0, a = 0;
    for (let i = 0; i < u.length; i += 10) if (u[i + 6] > 0) { if (u[i] === 0) d++; else a++; }
    ui.battle(`⚔ Battle at ${who}<small>Defenders ${d} · Attackers ${a} · ${Math.round(w.battle_time())}s</small>`); return;
  }
  ui.battle(null);
}

function stepLocal() {
  const w = lv.world;
  w.step();
  const f = w.flows();
  for (let i = 0; i < rates.length; i++) rates[i] = rates[i] * 0.9 + f[i] * 60 * 0.1;
  const ev = w.take_events();
  for (let i = 0; i < ev.length; i += 4) { const e = EVENT_TEXT(ev[i], ev[i + 1], ev[i + 2]); ui.toast(e.text, e.tone); ui.log(e.text, e.tone, ev[i + 3]); if (e.tone === 'bad') sound.alert(); else if (e.tone === 'good') sound.coin(); }
  const t = Number(w.tick());
  if (t % 4 === 0) updateGoals();
  checkArrivals(); updateDets(); if (selectedDet !== null) showRoute();
  room?.broadcastHash(t, w.state_hash().toString());
  if (t % 3 === 0) deposits.sync(w.deposits_flat());
  if (t % 20 === 0) atmo.setTime(0.12 + 0.76 * ((t / 1200) % 1)); // morning to evening, never dark
  lv.afterTick();
  updateSelection(); updateHud(); battleBanner();
  if (forestDirtyFlag) rebuildForest();
}

function setSpeed(n: number) { if (rivals.size && [...rivals.values()].some(r => r.online)) n = Math.min(n, 1); speed = n; ui.setSpeed(n); }

// ---------- selection & placement ----------
function selectKind(k: number | null) {
  selectedKind = k; ui.markSelected(k); penStart = null; penPreview?.clear();
  if (ghost) { scene.remove(ghost); ghost.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | undefined; if (mat && m.userData.ghostMat) mat.dispose(); }); ghost = null; }
  terrain.clearPreview(); previewKey = ''; if (ghostRing) ghostRing.visible = false;
  if (k !== null) {
    selectedIdx = null; updateSelection();
    // the ghost is the real building (same textures and shape), tinted green or red, so what you see is what you get
    ghost = buildModel(k, 0, 0x2f5fa8, 0); ghost.visible = false;
    ghost.traverse(o => { const m = o as THREE.Mesh; if (!m.isMesh) return; const c = (m.material as THREE.MeshStandardMaterial).clone(); m.userData.ghostMat = true; c.transparent = true; c.opacity = 0.86; c.emissive = new THREE.Color(0x22cc55); c.emissiveIntensity = 0.32; m.material = c; m.castShadow = false; m.receiveShadow = false; });
    scene.add(ghost); ghostCode = 99; previewKey = '';
    ui.hint(placeHint(k));
  } else ui.hint(null);
}

/** Better buildings employ more people and make more: x1, x2.25, x3.5, x4.75. */
function scaled(a: [number, number][], tier: number): [number, number][] { return a.map(([r, n]) => [r, Math.max(n, Math.floor((n * (4 + 5 * tier) + 2) / 4))]); }

function placeHint(k: number) {
  if (k === 24) return `Moat ${(1 + 0.13 * moatWidth).toFixed(1)}× wide — press R to make it thinner or broader · click for one piece, or drag to dig a run · Alt = any angle · Esc cancels`;
  if (PEN_SPACING[k]) return `${defs[k].name} — click for one piece, or press and drag to draw a straight run · hold Alt for any angle · Esc cancels`;
  if (k === 22) return 'Gate — click a wall piece to turn it into a gate · Esc cancels';
  if (k === 23) return 'Drawbridge — place it across a moat · R rotates · Esc cancels';
  return `${defs[k].name} — click to place · R rotates · Esc cancels`;
}

/** A gate beside a moat gets a drawbridge across the water in front of it (the way out of the village). */
function autoBridge(gx: number, gy: number) {
  const w = lv.world, f = w.buildings_flat(), l = Math.hypot(gx, gy) || 1, ux = gx / l, uz = gy / l, ox = w.origin_x(), oy = w.origin_y();
  let best: { x: number; y: number; d: number } | null = null;
  for (let i = 0; i < f.length; i += 10) if (f[i] === 24 || f[i] === 32 || f[i] === 23) {
    if (f[i] === 23) return;                                                       // there is one already
    const px = f[i + 2] - ox, py = f[i + 3] - oy, d = Math.hypot(px - gx, py - gy);
    if (d < 11 && ((px - gx) * ux + (py - gy) * uz) > d * 0.6 && (!best || d < best.d)) best = { x: px, y: py, d };
  }
  if (!best) return;
  const rot = ((Math.round(Math.atan2(ux, uz) / (Math.PI / 4)) % 8) + 8) % 8, bx = Math.round(best.x), by = Math.round(best.y);
  if (w.place(23, bx, by, rot) >= 0) { commit({ op: 'place', kind: 23, x: bx, y: by, rot }); ui.toast('A drawbridge now spans the moat in front of the gate.', 'good'); }
}

/** The wall piece (building index and position) a gate would replace, if the pointer is on one. */
function gateTarget(x: number, z: number): { idx: number; x: number; z: number; rot: number } | null {
  const f = lv.world.buildings_flat(); let best: { idx: number; d: number } | null = null;
  for (let i = 0; i < f.length; i += 10) if (f[i] === 2) { const d = Math.hypot(f[i + 2] - x, f[i + 3] - z); if (d < 3 && (!best || d < best.d)) best = { idx: i / 10, d }; }
  if (!best) return null;
  const o = best.idx * 10, px = f[o + 2], pz = f[o + 3]; let ang = 0, nd = 9;
  for (let i = 0; i < f.length; i += 10) if ((f[i] === 2 || f[i] === 22) && i !== o) { const d = Math.hypot(f[i + 2] - px, f[i + 3] - pz); if (d < nd) { nd = d; ang = Math.atan2(-(f[i + 3] - pz), f[i + 2] - px); } }
  return { idx: best.idx, x: px, z: pz, rot: ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8 };
}

/** The pieces a pen stroke would lay from `a` towards `b`: a straight run (square to the world unless `free`), spaced for the kind. */
function penPieces(kind: number, a: { x: number; z: number }, b: { x: number; z: number }, free: boolean) {
  let x1 = b.x, z1 = b.z;
  if (!free) { if (Math.abs(x1 - a.x) >= Math.abs(z1 - a.z)) z1 = a.z; else x1 = a.x; }
  const sp = PEN_SPACING[kind], L = Math.hypot(x1 - a.x, z1 - a.z), ux = L > 0 ? (x1 - a.x) / L : 1, uz = L > 0 ? (z1 - a.z) / L : 0;
  const rot = kind === 24 ? moatWidth : ((Math.round(Math.atan2(-uz, ux) / (Math.PI / 4)) % 8) + 8) % 8, out: { dx: number; dy: number; x: number; z: number }[] = [], seen = new Set<string>();
  const add = (x: number, z: number) => { const dx = Math.round(x - lv.ox), dy = Math.round(z - lv.oz), key = `${dx},${dy}`; if (!seen.has(key)) { seen.add(key); out.push({ dx, dy, x: lv.ox + dx, z: lv.oz + dy }); } };
  for (let s = 0; s <= L + 1e-6; s += sp) add(a.x + ux * s, a.z + uz * s);
  if (L % sp > sp * 0.4) add(x1, z1);
  return { pieces: out, end: { x: x1, z: z1 }, rot };
}

function penPreviewUpdate(kind: number, a: { x: number; z: number }, b: { x: number; z: number }, free: boolean) {
  const { pieces, end } = penPieces(kind, a, b, free), w = lv.world, stocks = Array.from(w.stocks());
  const afford = Math.min(...defs[kind].cost.map(([r, n]) => Math.floor(stocks[r] / Math.max(1, n))), 9999);
  let good = 0; const view = pieces.map((p, i) => { const ok = i < afford && w.can_place(kind, p.dx, p.dy) === 0; if (ok) good++; return { x: p.x, z: p.z, ok }; });
  penPreview.set(view, a, end);
  const cost = defs[kind].cost.map(([r, n]) => `${n * good} ${RES[r].name.toLowerCase()}`).join(', ');
  ui.hint(`${defs[kind].name}: ${good} of ${pieces.length} pieces can be laid${good ? ' · ' + cost : ''} · release to build · Alt = any angle`, good === 0);
}

function penCommit(kind: number, a: { x: number; z: number }, b: { x: number; z: number }, free: boolean) {
  const { pieces: all, rot } = penPieces(kind, a, b, free), pieces = all.slice(0, 400); let placed = 0, blocked = 0, broke = false;   // one stroke lays at most 400 pieces
  for (const p of pieces) {
    const code = lv.world.place(kind, p.dx, p.dy, rot);
    if (code >= 0) { commit({ op: 'place', kind, x: p.dx, y: p.dy, rot }); placed++; } else if (code === -6) { broke = true; break; } else blocked++;
  }
  if (placed) { afterLocalChange(); sound.place(2); const last = pieces[pieces.length - 1]; placedFx(kind, last.x, last.z); updateHud(); }
  ui.toast(placed ? `${placed} × ${defs[kind].name.toLowerCase()} built${broke ? ' — you ran out of materials' : blocked ? ` (${blocked} blocked)` : ''}.` : broke ? 'Not enough resources.' : 'Nothing could be built there.', placed ? 'good' : 'bad');
}

function selectBuilding(i: number | null) { selectedIdx = i; if (i !== null) { selectedRuin = null; selectKind(null); ui.showSelectedTab(); } updateSelection(); }

function selectRuin(i: number | null) { selectedRuin = i; if (i !== null) { selectedIdx = null; selectKind(null); ui.showSelectedTab(); } updateSelection(); }

function updateSelection() {
  const w = lv.world;
  if (selectedRuin !== null) {   // a ruined building: offer to rebuild it
    const ru = w.ruins_flat();
    if (selectedRuin * 6 >= ru.length) { selectedRuin = null; selRing.visible = false; ui.setSelectedPane(null); return; }
    const o = selectedRuin * 6, x = ru[o], z = ru[o + 1], kind = ru[o + 3], tier = ru[o + 4], cc = w.rebuild_cost_of(selectedRuin), cost: [number, number][] = [], stocks = Array.from(w.stocks());
    for (let i = 0; i < cc.length; i += 2) cost.push([cc[i], cc[i + 1]]);
    const ok = cost.every(([r, n]) => stocks[r] >= n);
    selRing.visible = true; selRing.position.set(x, terrain.heightAt(x, z) + 0.25, z); selRing.scale.setScalar(ru[o + 2] + 1.1);
    ui.setSelectedPane(`<div><div class="eyebrow">Ruins</div><h2>${tierName(kind, tier)}</h2><p class="muted">${defs[kind].name} — burnt or smashed down</p></div><p>Rebuild it as it was, for less than a new one.</p>
      <div><h3>Rebuild cost</h3><div class="cost">${ui.costHtml(cost, stocks)}</div></div>
      <button class="pbtn primary" data-act="rebuild" ${ok ? '' : 'disabled'}>${ok ? 'Rebuild' : 'Not enough resources'}</button>
      <p class="muted">A Builders' Yard will rebuild ruins and mend damaged buildings on its own while you have the materials.</p>
      <div class="btnrow"><button class="pbtn" data-act="deselect">Close</button></div>`);
    return;
  }
  if (selectedIdx === null || selectedIdx >= w.building_count()) { selectedIdx = null; selRing.visible = false; ui.setSelectedPane(null); return; }
  const f = w.buildings_flat(), o = selectedIdx * 10, hp = w.building_health();
  const kind = f[o], tier = f[o + 1], x = f[o + 2], z = f[o + 3], status = f[o + 6], pct = f[o + 7];
  const d = defs[kind];
  selRing.visible = true; selRing.position.set(x, terrain.heightAt(x, z) + 0.25, z); selRing.scale.setScalar(d.r + 1.1);
  const stocks = Array.from(w.stocks());
  const io = (a: [number, number][]) => a.map(([r, n]) => `${RES[r].icon} ${n} ${RES[r].name}`).join(', ');
  const health = hp[selectedIdx * 3] / hp[selectedIdx * 3 + 1], burning = hp[selectedIdx * 3 + 2] > 0;
  let html = `<div><div class="eyebrow">${CATS[d.cat].name} · Tier ${tier + 1} of 4</div><h2>${tierName(kind, tier)}</h2><p class="muted">${d.name}</p></div><p>${d.desc}</p>`;
  html += `<div><div class="eyebrow">${burning ? '🔥 On fire!' : 'Condition'}</div><div class="bar ${health < 0.4 || burning ? 'red' : ''}"><i style="width:${Math.round(health * 100)}%"></i></div></div>`;
  if (health < 0.995 && !burning) {   // damaged: offer repairs
    const rc = w.repair_cost(selectedIdx), rcost: [number, number][] = []; for (let i = 0; i < rc.length; i += 2) rcost.push([rc[i], rc[i + 1]]);
    const rok = rcost.every(([r, n]) => stocks[r] >= n);
    html += `<div><h3>Repair</h3><div class="cost">${ui.costHtml(rcost, stocks)}</div></div><button class="pbtn primary" data-act="repair" ${rok ? '' : 'disabled'}>${rok ? 'Repair' : 'Not enough resources'}</button>`;
  }
  if (kind === 3 || kind === 26) {   // towers and keeps need archers stationed inside to defend
    const cap = w.garrison_cap(selectedIdx), cur = w.garrison_flat()[selectedIdx] ?? 0, avail = w.army()[1];
    html += `<div><h3>Garrison</h3><div class="stats"><div class="stat"><b>${cur} / ${cap}</b><span>archers inside</span></div><div class="stat"><b>${avail}</b><span>archers free in the barracks</span></div></div>
      <div class="btnrow" style="flex-wrap:wrap"><button class="pbtn" data-act="gar+" ${cur >= cap || avail < 1 ? 'disabled' : ''}>+ Archer</button><button class="pbtn" data-act="gar-" ${cur < 1 ? 'disabled' : ''}>− Archer</button><button class="pbtn" data-act="garfill" ${cur >= cap || avail < 1 ? 'disabled' : ''}>Fill</button><button class="pbtn" data-act="garempty" ${cur < 1 ? 'disabled' : ''}>Empty</button></div>
      <p class="muted">${cur === 0 ? 'The tower is empty — it only defends once you station archers in it. Train archers at a barracks.' : 'Archers fire from the walkway at the top. They come from the barracks and go back when you empty the tower.'}</p></div>`;
  }
  if (kind === 23) {
    const up = f[o + 6] === 5;
    html += `<div><h3>Drawbridge</h3><div class="stats"><div class="stat"><b>${up ? 'Drawn up' : 'Lowered'}</b><span>State</span></div></div>
      <div class="btnrow"><button class="pbtn primary" data-act="bridge">${up ? 'Lower the drawbridge' : 'Draw it up'}</button></div>
      <p class="muted">${up ? 'Nobody crosses while it is up, your own armies included.' : 'Your people and armies cross freely.'} It is drawn up automatically when raiders attack, and lowered again afterwards.</p></div>`;
  }
  if (kind === 20) html += `<p class="muted">Sends builders to damaged buildings and ruins within 70 units, using your stores. Higher tiers work faster.</p>`;
  if (d.cycle) {
    html += `<div class="stats"><div class="stat"><b>${STATUS[status]}</b><span>Status</span></div><div class="stat"><b>👷 ${f[o + 8]} / ${d.jobs * (tier + 1)}</b><span>Workers</span></div></div>
      <div><div class="eyebrow">Production cycle</div><div class="bar"><i style="width:${pct}%"></i></div></div>
      <p class="muted">${d.inputs.length ? `Uses ${io(scaled(d.inputs, tier))}<br>` : ''}Makes ${io(scaled(d.outputs, tier))} every ${d.cycle}s at full staffing. Needs ${d.jobs * (tier + 1)} workers (village workforce ${w.efficiency()}%).${tier < defs[kind].maxTier ? ` Upgrading needs ${d.jobs * (tier + 2)} workers and makes ${io(scaled(d.outputs, tier + 1))}.` : ''}</p>`;
  } else if (d.housing) html += `<div class="stats"><div class="stat"><b>🏠 ${f[o + 9]} / ${d.housing * (tier + 1)}</b><span>Residents</span></div></div><p class="muted">Residents walk the village paths to their workplaces each day.</p>`;
  if (kind === 15) html += `<p class="muted">Raises storage to ${600 + 200 * tier} per resource and expands your border.</p>`;
  if (kind === 19) html += `<p class="muted">Tier ${tier + 1}: ${['spearmen and archers', '+ swordsmen', '+ knights', '+ catapults'][tier]}. Open the Army tab to recruit.</p>`;
  if (tier < defs[kind].maxTier) {
    const uc = upgrade_cost_flat(kind, tier + 1), cost: [number, number][] = []; for (let i = 0; i < uc.length; i += 2) cost.push([uc[i], uc[i + 1]]);
    const ok = cost.every(([r, n]) => stocks[r] >= n);
    html += `<div><h3>Upgrade to ${tierName(kind, tier + 1)}</h3><div class="cost">${ui.costHtml(cost, stocks)}</div></div><button class="pbtn primary" data-act="upgrade" ${ok ? '' : 'disabled'}>${ok ? 'Upgrade' : 'Not enough resources'}</button>`;
  } else html += `<p><b>Fully upgraded.</b></p>`;
  const opts = d.opts ?? [];
  if (opts.length) {   // optional designs: small changes to the look and use of this one building
    const have = w.options_flat()[selectedIdx] ?? 0, oc = World.option_cost_flat(kind), ocost: [number, number][] = []; for (let i = 0; i < oc.length; i += 2) ocost.push([oc[i], oc[i + 1]]);
    const afford = ocost.every(([r, n]) => stocks[r] >= n);
    html += `<div><h3>Design options</h3><div class="optlist">` + opts.map((op, i) => {
      const on = (have & (1 << i)) !== 0, locked = tier < op.t;
      return `<button class="pbtn opt ${on ? 'on' : ''}" data-act="opt:${i}" ${locked || (!on && !afford) ? 'disabled' : ''} title="${op.d}"><span>${on ? '☑' : '☐'} <b>${op.n}</b></span><small>${locked ? `needs ${tierName(kind, op.t)}` : on ? 'built — click to remove' : ui.costHtml(ocost, stocks)}</small></button>`;
    }).join('') + `</div></div>`;
  }
  html += `<div class="btnrow">${kind !== 15 ? '<button class="pbtn danger" data-act="demolish">Demolish (50% refund)</button>' : ''}<button class="pbtn" data-act="deselect">Close</button></div>`;
  ui.setSelectedPane(html);
}

function onAct(a: string) {
  if (selectedRuin !== null) {
    if (a === 'deselect') { selectRuin(null); return; }
    if (a === 'rebuild') {
      const code = lv.world.rebuild(selectedRuin);
      if (code === 0) { commit({ op: 'rebuild', idx: selectedRuin }); const ru = selectedRuin; void ru; selectedRuin = null; sound.place(2); ui.toast('The building is rising again.', 'good'); afterLocalChange(); rig.shake(0.1); }
      else ui.toast(code === -3 ? 'Something has been built there since.' : 'Not enough resources.', 'bad');
    }
    return;
  }
  if (selectedIdx === null) return;
  if (a === 'gar+' || a === 'gar-' || a === 'garfill' || a === 'garempty') {
    const cap = lv.world.garrison_cap(selectedIdx), cur = lv.world.garrison_flat()[selectedIdx] ?? 0, avail = lv.world.army()[1];
    const want = a === 'gar+' ? cur + 1 : a === 'gar-' ? Math.max(0, cur - 1) : a === 'garempty' ? 0 : Math.min(cap, cur + avail);
    const code = lv.world.garrison_set(selectedIdx, want);
    if (code === 0) { commit({ op: 'garrison', idx: selectedIdx, kind: want }); sound.click(); afterLocalChange(); updateHud(); }
    else ui.toast(code === -2 ? 'There are no more archers in the barracks. Train some first.' : code === -3 ? 'The tower is full.' : PLACE_ERRORS[-100 + code] ?? 'Cannot do that now.', 'bad');
    return;
  }
  if (a === 'repair') {
    const code = lv.world.repair(selectedIdx);
    if (code === 0) { commit({ op: 'repair', idx: selectedIdx }); sound.upgrade(); ui.toast('Repaired.', 'good'); afterLocalChange(); } else ui.toast(PLACE_ERRORS[code] ?? 'Cannot repair that.', 'bad');
    return;
  }
  if (a === 'bridge') {
    const up = lv.world.buildings_flat()[selectedIdx * 10 + 6] === 5;   // status 5 = drawn up
    if (lv.world.drawbridge_set(selectedIdx, !up) === 0) { commit({ op: 'bridge', idx: selectedIdx, kind: up ? 0 : 1 }); sound.click(); ui.toast(up ? 'The drawbridge is lowered.' : 'The drawbridge is drawn up.', 'info'); afterLocalChange(); }
    return;
  }
  if (a.startsWith('opt:')) {
    const bit = Number(a.slice(4)), on = ((lv.world.options_flat()[selectedIdx] ?? 0) & (1 << bit)) === 0;
    const code = lv.world.set_option(selectedIdx, bit, on);
    if (code === 0) { commit({ op: 'option', idx: selectedIdx, kind: bit, x: on ? 1 : 0 }); sound.upgrade(); afterLocalChange(); } else ui.toast(code === -6 ? 'Not enough resources.' : code === -10 ? 'This building needs a better tier first.' : 'Cannot do that.', 'bad');
    return;
  }
  if (a === 'deselect') { selectBuilding(null); return; }
  const w = lv.world;
  if (a === 'upgrade') {
    if (w.upgrade(selectedIdx) === 0) { const f = w.buildings_flat(), o = selectedIdx * 10; commit({ op: 'upgrade', idx: selectedIdx }); ui.toast('Building upgraded.', 'good'); sound.upgrade(); placedFx(f[o], f[o + 2], f[o + 3], true); }
    afterLocalChange();
  } else if (a === 'demolish') {
    if (w.demolish(selectedIdx)) { const f = w.buildings_flat(); void f; commit({ op: 'demolish', idx: selectedIdx }); sound.demolish(); selectedIdx = null; afterLocalChange(); rig.shake(0.25); }
  }
}

// ---------- input ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
/** The in-game right-click menu: what it offers depends on what is under the pointer. */
function openContext(e: PointerEvent) {
  const r = pointerRay(e), hit = terrain.pick(r.ray), items: Parameters<UI['ctxMenu']>[3] = [];
  const det = lv.field.pick(r), idx = det === null ? lv.pick(r) : null, ruin = det === null && idx === null ? lv.ruins.pick(r) : null;
  let title = 'The land';
  if (det !== null) {
    selectDet(det); title = `Army ${det}`;
    items.push({ label: 'Halt', sub: 'G', run: () => detAction('halt', det) }, { label: 'Send home', sub: 'B', run: () => detAction('recall', det) }, '-', { label: 'Split in two', run: () => detAction('split', det) }, { label: 'Merge with nearest', run: () => detAction('merge', det) });
  } else if (idx !== null) {
    selectBuilding(idx);
    const f = lv.world.buildings_flat(), o = idx * 10, kind = f[o], tier = f[o + 1], hp = lv.world.building_health(), hurt = hp[idx * 3 + 1] > 0 && hp[idx * 3] / hp[idx * 3 + 1] < 0.995 && hp[idx * 3 + 2] <= 0;
    title = tierName(kind, tier);
    if (tier < defs[kind].maxTier) items.push({ label: 'Upgrade', run: () => { selectBuilding(idx); onAct('upgrade'); } });
    if (hurt) items.push({ label: 'Repair', run: () => { selectBuilding(idx); onAct('repair'); } });
    if (kind === 23) items.push({ label: f[o + 6] === 5 ? 'Lower the drawbridge' : 'Draw up the drawbridge', run: () => { selectBuilding(idx); onAct('bridge'); } });
    if (kind === 3 || kind === 26) items.push({ label: 'Fill with archers', run: () => { selectBuilding(idx); onAct('garfill'); } }, { label: 'Empty the tower', run: () => { selectBuilding(idx); onAct('garempty'); } });
    if (kind !== 15) items.push('-', { label: 'Demolish', run: () => { selectBuilding(idx); onAct('demolish'); } });
    if (items.length === 0) items.push({ label: 'Nothing to do here', disabled: true });
  } else if (ruin !== null) {
    selectRuin(ruin); const ru = lv.world.ruins_flat(); title = 'Ruins'; void ru;
    items.push({ label: 'Rebuild', run: () => { selectRuin(ruin); onAct('rebuild'); } });
  } else {
    let rival: Rival | null = null; for (const rv of rivals.values()) if (rv.village.pick(r) !== null) { rival = rv; break; }
    if (rival) { const rv = rival; title = `${rv.name}'s village`; items.push({ label: 'March on this village…', run: () => ui.setTab('army') }, '-'); }
    if (hit) {
      items.push({ label: 'Look here', run: () => rig.focus(hit.x, hit.z) }, { label: 'Build here…', run: () => ui.setTab('build') });
      for (const id of lv.field.ids()) items.push({ label: `March Army ${id} here`, run: () => { selectDet(id); orderMarch(id, hit.x, hit.z); } });
    }
    const soldiers = Array.from(lv.world.army()).slice(0, 5);
    if (soldiers.some(n => n > 0)) items.push('-', { label: 'Muster every soldier', sub: 'F', run: () => doMuster(soldiers) });
  }
  // the world may change while the menu is open (a fire, a raid): then the building indices have moved, so do nothing rather than act on the wrong one
  const cnt = lv.world.building_count();
  for (const it of items) if (it !== '-' && it.run) { const run = it.run; it.run = () => { if (lv.world.building_count() !== cnt) { ui.toast('Things changed while the menu was open — try again.', 'info'); return; } run(); }; }
  ui.ctxMenu(e.clientX, e.clientY, title, items);
}

function pointerRay(e: { clientX: number; clientY: number }) { ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, rig.cam); return ray; }

function updateGhost(e: { clientX: number; clientY: number }) {
  if (selectedKind === null || !ghost) return;
  const hit = terrain.pick(pointerRay(e).ray);
  if (!hit) { ghost.visible = false; return; }
  const w = lv.world, dx = Math.round(hit.x - lv.ox), dy = Math.round(hit.z - lv.oz);
  let code = w.can_place(selectedKind, dx, dy), gx = dx, gy = dy, grot = rot;
  if (selectedKind === 22) {   // a gate takes the place of a wall piece and lines up with the wall
    const t = gateTarget(hit.x, hit.z);
    if (t) { gx = Math.round(t.x - lv.ox); gy = Math.round(t.z - lv.oz); grot = t.rot; const st = Array.from(w.stocks()); code = defs[22].cost.every(([r, n]) => st[r] >= n) ? 0 : -6; } else code = -3;
  }
  const x = lv.ox + gx, z = lv.oz + gy, d = defs[selectedKind];
  // the core levels the ground to the average of five samples: show the same levelling under the ghost so it never clips the terrain
  const fr = d.r * 0.8; let h = w.height_at(x, z); for (const [px, pz] of [[fr, 0], [-fr, 0], [0, fr], [0, -fr]]) h += w.height_at(x + px, z + pz); h /= 5;
  const pad = !NOPAD.has(selectedKind), key = `${selectedKind}:${x}:${z}`;
  if (key !== previewKey) { previewKey = key; if (pad) terrain.setPreview(x, z, d.r * 1.15 + 0.5, h); else terrain.clearPreview(); }
  if (!pad) h = terrain.heightAt(x, z);
  ghost.visible = true; ghost.position.set(x, h, z); ghost.rotation.y = grot * Math.PI / 4;
  ghostRing.visible = true; ghostRing.position.set(x, h + 0.14, z); ghostRing.scale.setScalar(d.r * 1.05);
  if (code !== ghostCode) {
    ghostCode = code;
    ghost.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { const mm = m.material as THREE.MeshStandardMaterial; mm.emissive.setHex(code === 0 ? 0x22cc55 : 0xdd2a1a); mm.emissiveIntensity = code === 0 ? 0.32 : 0.55; } });
    (ghostRing.material as THREE.MeshBasicMaterial).color.setHex(code === 0 ? 0x66ff88 : 0xff6655);
    ui.hint(code === 0 ? placeHint(selectedKind) : PLACE_ERRORS[code] ?? 'Cannot build here', code !== 0);
  }
}

function bindInput() {
  const cv = ui.canvas;
  let down: { x: number; y: number } | null = null, hoverT = 0, routeT = 0;
  const dropStroke = () => { down = null; penStart = null; penPreview.clear(); ui.selBox(null); };
  cv.addEventListener('pointercancel', dropStroke); cv.addEventListener('lostpointercapture', () => { if (down) dropStroke(); });
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY };
    try { cv.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (!e.shiftKey && selectedKind !== null && PEN_SPACING[selectedKind]) { const h = terrain.pick(pointerRay(e).ray); penStart = h ? { x: h.x, z: h.z } : null; }
  });
  cv.addEventListener('pointermove', e => {
    if (down && (e.buttons & 1) && selectedKind === null && !e.shiftKey && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) ui.selBox({ x0: down.x, y0: down.y, x1: e.clientX, y1: e.clientY });
    updateGhost(e);
    if (penStart && selectedKind !== null && (e.buttons & 1) && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { const h = terrain.pick(pointerRay(e).ray); if (h) { penPreviewUpdate(selectedKind, penStart, { x: h.x, z: h.z }, e.altKey); if (ghost) ghost.visible = false; if (ghostRing) ghostRing.visible = false; } }
    if (selectedDet !== null && selectedKind === null && performance.now() - routeT > 140 && !e.buttons) {   // preview the route under the cursor
      routeT = performance.now(); const hit = terrain.pick(pointerRay(e).ray), u = detUnits(selectedDet), pos = lv.field.position(selectedDet);
      if (hit && u && pos) {
        const plan = lv.world.plan_march(Uint32Array.from(u), pos.x, pos.z, hit.x, hit.z);
        if (plan[0] === 1) { pathLine.set(Array.from(plan.slice(5)), true); const bits = [`${Math.round(plan[1])}s`]; if (plan[2]) bits.push(`${plan[2]} planks for a bridge`); if (plan[3]) bits.push(`${plan[3]} wood for boats`); if (Array.from(plan.slice(5)).some((v, i) => i % 3 === 2 && v === 1)) bits.push('cuts through forest'); ui.hint(`Right-click to march · ${bits.join(' · ')}`); }
        else { pathLine.set([pos.x, pos.z, 0, hit.x, hit.z, 0], false); ui.hint(MARCH_ERRORS[plan[0]] ?? 'No way through to there.', true); }
      }
    }
    if (selectedKind === null && performance.now() - hoverT > 90 && !e.buttons) {
      hoverT = performance.now();
      const idx = lv.pick(pointerRay(e));
      let hit: { r: Rival; i: number } | null = null;
      if (idx === null) for (const r of rivals.values()) { const i = r.village.pick(ray); if (i !== null) { hit = { r, i }; break; } }
      if (idx !== null) { const f = lv.world.buildings_flat(), o = idx * 10; ui.tip(`<b>${tierName(f[o], f[o + 1])}</b><small>${defs[f[o]].name} · ${STATUS[f[o + 6]]}</small>`, e.clientX, e.clientY); cv.style.cursor = 'pointer'; }
      else if (hit) { const f = hit.r.village.world.buildings_flat(), o = hit.i * 10; ui.tip(`<b>${esc(hit.r.name)}: ${tierName(f[o], f[o + 1])}</b><small>${defs[f[o]].name} · click to open the Army tab</small>`, e.clientX, e.clientY); cv.style.cursor = 'pointer'; }
      else { ui.tip(null); cv.style.cursor = 'default'; }
    }
  });
  cv.addEventListener('pointerleave', () => ui.tip(null));
  cv.addEventListener('pointerup', e => {
    if (e.button !== 0 || !down) return;
    const d0 = down, moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    if (penStart && selectedKind !== null) {
      const a = penStart; penStart = null; penPreview.clear();
      if (moved > 8) { const h = terrain.pick(pointerRay(e).ray); if (h) penCommit(selectedKind, a, { x: h.x, z: h.z }, e.altKey); ghostCode = 99; previewKey = ''; ui.hint(placeHint(selectedKind)); return; }
    }
    if (moved > 5) { ui.selBox(null); if (moved > 8 && selectedKind === null && !e.shiftKey) boxSelect(d0.x, d0.y, e.clientX, e.clientY); return; }
    if (selectedKind !== null) {
      const hit = terrain.pick(pointerRay(e).ray); if (!hit) return;
      const dx = Math.round(hit.x - lv.ox), dy = Math.round(hit.z - lv.oz), kind = selectedKind;
      if (kind === 22) {   // gate: replaces the wall piece under the pointer
        const t = gateTarget(hit.x, hit.z); if (!t) { ui.hint('Click a wall piece to put the gate in', true); sound.error(); return; }
        const gx = Math.round(t.x - lv.ox), gy = Math.round(t.z - lv.oz), st = Array.from(lv.world.stocks());
        if (!defs[22].cost.every(([r, n]) => st[r] >= n)) { ui.hint(PLACE_ERRORS[-6], true); sound.error(); return; }
        lv.world.demolish(t.idx); commit({ op: 'demolish', idx: t.idx });
        const gres = lv.world.place(22, gx, gy, t.rot);
        if (gres >= 0) { commit({ op: 'place', kind: 22, x: gx, y: gy, rot: t.rot }); autoBridge(gx, gy); } else if (lv.world.place(2, gx, gy, t.rot) >= 0) commit({ op: 'place', kind: 2, x: gx, y: gy, rot: t.rot });
        ghostCode = 99; previewKey = ''; afterLocalChange(); if (gres >= 0) placedFx(22, lv.ox + gx, lv.oz + gy); else ui.hint(PLACE_ERRORS[gres] ?? 'Cannot build a gate here', true);
        return;
      }
      const res = lv.world.place(kind, dx, dy, rot);
      if (res >= 0) { commit({ op: 'place', kind, x: dx, y: dy, rot }); ghostCode = 99; previewKey = ''; afterLocalChange(); placedFx(kind, lv.ox + dx, lv.oz + dy); updateGhost(e); }
      else { ui.hint(PLACE_ERRORS[res] ?? 'Cannot build here', true); sound.error(); }
    } else {
      const det = lv.field.pick(pointerRay(e));
      if (det !== null) { selectDet(det); return; }
      const idx = lv.pick(pointerRay(e));
      if (idx === null) { const ri = lv.ruins.pick(pointerRay(e)); if (ri !== null) { selectRuin(ri); return; } }
      if (idx !== null) selectBuilding(idx);
      else for (const r of rivals.values()) if (r.village.pick(ray) !== null) { ui.setTab('army'); ui.toast(`${r.name}'s village — choose an army in the Army tab to march on it.`, 'info'); return; }
      if (idx === null) { selectBuilding(null); selectRuin(null); if (selectedDet !== null) selectDet(null); }
    }
  });
  // right click without dragging: send the selected army there
  cv.addEventListener('pointerup', e => {
    if (e.button !== 2 || rig.moved) return;
    if (selectedKind !== null) { selectKind(null); return; }                // right-click puts the building down again
    if (multiDets.length) {                                                 // armies selected: send them there, spread out a little
      const hit = terrain.pick(pointerRay(e).ray);
      if (hit) multiDets.slice().forEach((id, k) => { const a = k * 2.4, r = k ? 3 + 2 * Math.sqrt(k) : 0; orderMarch(id, hit.x + Math.cos(a) * r, hit.z + Math.sin(a) * r); });
      return;
    }
    openContext(e);
  });
  addEventListener('keydown', e => {
    if (ui.captureKey(e)) return;                                   // rebinding a key in the help screen
    if (e.ctrlKey || e.metaKey || e.altKey) return;                 // browser shortcuts (Ctrl+F, Ctrl+R...) are not game commands
    if ((e.target as HTMLElement)?.matches?.('input,textarea,select')) return;
    const n = digitOf(e);
    if (n !== null) { const kind = ui.hotkeyKind(n - 1); if (kind !== null) { ui.setTab('build'); selectKind(kind); } return; }
    switch (keys.actionOf(e)) {
      case 'cancel': if (selectedKind !== null) selectKind(null); else if (selectedDet !== null) selectDet(null); else selectBuilding(null); break;
      case 'rotateBuilding': rot = (rot + 1) % 8; if (selectedKind === 24) { moatWidth = rot; ui.hint(placeHint(24)); } ghostCode = 99; previewKey = ''; break;
      case 'deposits': toggleResources(); break;
      case 'pause': e.preventDefault(); setSpeed(speed === 0 ? 1 : 0); break;
      case 'perf': e.preventDefault(); perf.toggle(); break;
      case 'help': e.preventDefault(); ui.modal('help', true); break;
      case 'toggleLedger': ui.toggleLedger(); break;
      case 'nextArmy': { e.preventDefault(); const ids = lv.field.ids(); if (ids.length) { const i = ids.indexOf(selectedDet ?? -1); const id = ids[(i + 1) % ids.length], p = lv.field.position(id); selectDet(id); if (p) rig.focus(p.x, p.z); } break; }
      case 'haltArmy': multiDets.slice().forEach(id => detAction('halt', id)); break;
      case 'recallArmy': multiDets.slice().forEach(id => detAction('recall', id)); break;
      case 'fullMap': ui.toggleMap(); break;
      case 'fullscreen': e.preventDefault(); toggleFullscreen(); break;
      case 'musterAll': { const a = Array.from(lv.world.army()).slice(0, 5); if (a.some(n => n > 0)) doMuster(a); else ui.toast('There are no soldiers in the barracks.', 'info'); break; }
      case 'toggleMinimap': ui.toggleMinimap(); break;
      default: break;
    }
  });
}

// ---------- deposits overlay ----------
function buildDepositLabels() {
  const raw = deposits.raw;
  for (let i = 0; i < raw.length; i += 5) {
    const el = document.createElement('div'); el.className = 'lbl'; el.hidden = true;
    el.innerHTML = `${DEPOSIT[raw[i]].icon}<span>${DEPOSIT[raw[i]].name}</span>`; ui.labels.appendChild(el); depLabels.push(el);
  }
}
function toggleResources() { showDeposits = !showDeposits; ui.setResourcesToggle(showDeposits); if (!showDeposits) depLabels.forEach(l => (l.hidden = true)); }
const vtmp = new THREE.Vector3();
function updateLabels() {
  if (!showDeposits) return;
  const flat = lv.world.deposits_flat();
  for (let i = 0; i < Math.min(depLabels.length, flat.length / 5); i++) {
    const x = flat[i * 5 + 1], z = flat[i * 5 + 2], rem = flat[i * 5 + 3];
    vtmp.set(x, terrain.heightAt(x, z) + 3.2, z).project(rig.cam);
    const on = vtmp.z < 1 && Math.abs(vtmp.x) < 1.05 && Math.abs(vtmp.y) < 1.05 && Math.hypot(x - rig.target.x, z - rig.target.z) < 210;
    const el = depLabels[i]; el.hidden = !on; if (!on) continue;
    el.style.left = ((vtmp.x * 0.5 + 0.5) * innerWidth) + 'px'; el.style.top = ((-vtmp.y * 0.5 + 0.5) * innerHeight) + 'px';
    (el.firstElementChild as HTMLElement).textContent = `${DEPOSIT[flat[i * 5]].name} · ${Math.round(rem)}`;
  }
}

// ---------- performance monitor ----------
function allVillages() { return [lv, ...[...rivals.values()].map(r => r.village)]; }
function setupPerf() {
  perf = new Perf(document.body);
  perf.attachGpu(renderer.getContext() as WebGL2RenderingContext);
  const vis = (get: () => THREE.Object3D[]) => (on: boolean) => get().forEach(o => (o.visible = on));
  perf.setLayers([
    { name: 'Terrain', set: vis(() => [terrain.mesh]) },
    { name: 'Water', set: vis(() => [terrain.water]) },
    { name: 'Trees', set: vis(() => [forest.group]) },
    { name: 'Buildings', set: vis(() => allVillages().flatMap(v => [v.view.root, v.view.batchRoot, v.walls.group, v.ruins.group])) },
    { name: 'Village paths', set: vis(() => allVillages().map(v => v.paths.group)) },
    { name: 'People and soldiers', set: vis(() => [crowd.group, ...allVillages().map(v => v.army.group)]) },
    { name: 'Animals', set: vis(() => [wildlife.group]) },
    { name: 'Fire, smoke and arrows', set: vis(() => [fx.group, effects.smoke.points]) },
    { name: 'Shadows', set: on => { atmo.sun.castShadow = on; } },
    { name: 'Sky', set: vis(() => [atmo.sky]) },
  ]);
}

/** A title over every town hall: whose it is, and how grand it has grown. */
function updateHallLabels(all: Village[]) {
  for (const v of all) {
    let el = hallLabels.get(v.key);
    if (!el) { el = document.createElement('div'); el.className = 'lbl hall'; ui.labels.appendChild(el); hallLabels.set(v.key, el); }
    const hf = v.world.buildings_flat(), hx = hf[2], hz = hf[3], tier = hf[1];
    vtmp.set(hx, terrain.heightAt(hx, hz) + 7 + tier * 3.5, hz).project(rig.cam);
    const on = vtmp.z < 1 && Math.abs(vtmp.x) < 1 && Math.abs(vtmp.y) < 1 && rig.dist > 28;
    el.hidden = !on; if (!on) continue;
    el.style.transform = `translate(${Math.round((vtmp.x * 0.5 + 0.5) * innerWidth)}px, ${Math.round((-vtmp.y * 0.5 + 0.5) * innerHeight)}px) translate(-50%, -100%)`;
    const html = `${v.mine ? '🏰' : '⚔️'}<b>${esc(v.name)}</b><span>${tierName(15, tier).toUpperCase()}</span>`;
    if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
  }
}

// ---------- main loop ----------
let worldShips: WorldShips | null = null;
let tideLevel = 0;   // the water rises and falls a little, slowly
let sCount = 0, sT = 0, fireBuf = new Float32Array(256);
let last = 0, miniT = 0, scareT = 0, scares: { x: number; z: number }[] = [];
function frame(now: number) {
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;   // never negative, never a big jump
  perf.start('simulation');
  if (speed > 0) { acc += dt * speed * TICK_RATE; let n = 0; while (acc >= 1 && n++ < 8) { acc -= 1; stepLocal(); } if (n >= 8) acc = 0; }
  perf.stop('simulation');
  const all = allVillages();
  perf.start('camera + world'); rig.update(dt); rig.cam.updateMatrixWorld(true); atmo.follow(rig.target); terrain.animate(now / 1000); tideLevel = -0.25 + Math.sin(now / 1000 * 0.09) * 0.19 + Math.sin(now / 1000 * 0.031) * 0.07; terrain.water.position.y = tideLevel; worldShips?.update(dt, tideLevel); for (const v of all) { v.boats.level = tideLevel; v.rivers.setTide(tideLevel); }   // open water ebbs and flows; sealed moats stay full forest.tick(now / 1000, rig.cam.position); perf.stop('camera + world');
  perf.start('villages (people, army)'); all.forEach(v => v.frame(dt, v === lv ? speed : 1)); perf.stop('villages (people, army)');
  perf.start('animals');
  if (now - scareT > 250) { scareT = now; scares = all.flatMap(v => [...v.people.positions(), ...v.army.positions()]); }
  const view = Math.max(90, rig.dist * 1.7 + 50);        // simulate and draw crowds and animals only around the camera
  wildlife.update(dt, scares, rig.target.x, rig.target.z, view);
  perf.stop('animals');
  perf.start('crowd upload'); crowd.begin(); all.forEach(v => v.draw(crowd, rig.target.x, rig.target.z, view)); worldShips?.draw(crowd, rig.target.x, rig.target.z, view); crowd.end(); perf.stop('crowd upload');
  perf.start('fire + particles');
  let nf = 0; for (const v of all) nf += v.fireData.length;
  if (fireBuf.length < nf) fireBuf = new Float32Array(Math.max(nf, fireBuf.length * 2));   // one buffer reused every frame
  { let o = 0; for (const v of all) { fireBuf.set(v.fireData, o); o += v.fireData.length; } }
  const fires = fireBuf.subarray(0, nf);
  fx.update(dt, fires, rig.cam.position);
  effects.update(dt, now / 1000, all.map(v => v.view));
  perf.stop('fire + particles');
  if (selRing.visible) (selRing.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(now / 250) * 0.25;
  perf.start('labels + minimap');
  updateHallLabels(all);
  updateLabels();
  sound.update(dt, all.reduce((a, v) => a + v.fireData.length / 4, 0), all.some(v => v.world.battle_active()));
  if (now - miniT > 250) {
    miniT = now;
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => { ndc.set(u * 2 - 1, -(v * 2 - 1)); ray.setFromCamera(ndc, rig.cam); const p = terrain.pick(ray.ray); return p ? { x: p.x, z: p.z } : null; });
    const view = corners.every(c => c) ? (corners as { x: number; z: number }[]) : null;
    const mapV = (v: Village, color: string, name: string): MapVillage => { const f = v.world.buildings_flat(), b: MapVillage['buildings'] = []; for (let i = 0; i < f.length; i += 10) b.push({ x: f[i + 2], z: f[i + 3], r: shared.radii[f[i]], kind: f[i] }); return { x: v.ox, z: v.oz, r: v.radius, color, name, buildings: b }; };
    const villages = [mapV(lv, '#5f8fe0', myName), ...[...rivals.values()].map(r => mapV(r.village, '#e05f5f', r.name))];
    const armies = [lv, ...[...rivals.values()].map(r => r.village)].flatMap((v, k) => v.field.ids().map(id => ({ ...v.field.position(id)!, color: k ? '#ff8a7a' : '#8fb8ff' })));
    const mo = { villages, armies, deposits: lv.world.deposits_flat(), showDeposits, view, target: { x: rig.target.x, z: rig.target.z } };
    minimap.draw(mo); if (ui.mapOpen()) bigMap.draw(mo);
  }
  perf.stop('labels + minimap');
  perf.start('render (CPU side)');
  perf.render(renderer, scene, rig.cam);
  perf.stop('render (CPU side)');
  perf.counts({ Villagers: lv.people.count, Animals: wildlife.visible, Buildings: lv.world.building_count(), Soldiers: (now - sT > 500 ? (sT = now, sCount = lv.army.positions().length) : sCount) });
  perf.frame(now, { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures });
  requestAnimationFrame(frame);
}

// ---------- debugging / automated checks ----------
function debugPlace(kind: number, dx: number, dy: number, r = 0) {
  const res = lv.world.place(kind, dx, dy, r);
  if (res >= 0) { commit({ op: 'place', kind, x: dx, y: dy, rot: r }); afterLocalChange(); }
  return res;
}
(window as any).__game = {
  get worldShips() { return worldShips; }, debugPlace, runModelVillage, selectBuilding, selectRuin, KIND_ICON, setSpeed, selectKind, frame, updateGhost,
  get renderer() { return renderer; }, get forest() { return forest; }, get atmo() { return atmo; }, get scene() { return scene; }, get terrain() { return terrain; }, get rig() { return rig; },
  get perf() { return perf; }, get world() { return lv.world; }, get lv() { return lv; }, get rivals() { return rivals; }, get wildlife() { return wildlife; }, get fx() { return fx; }, get crowd() { return crowd; }, ui, afterLocalChange, refreshTerrain,
  raid(angle = 0.6, u = [8, 4, 2, 0, 0]) { const ok = lv.world.start_raid(angle, Uint32Array.from(u), 0); lv.afterTick(); return ok; },
};

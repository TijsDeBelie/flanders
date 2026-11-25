import { joinLines, parseRoadLines } from './render/roadmesh';
import './boot';
import '@fontsource/im-fell-english-sc';
import '@fontsource/im-fell-english';
import '@fontsource/im-fell-english/400-italic.css';
import '@fontsource/alegreya-sans/400.css';
import '@fontsource/alegreya-sans/500.css';
import '@fontsource/alegreya-sans/700.css';
import './ui/style.css';
import './ui/mobile.css';
import { sceneIsStill, skipFrame } from './idle';
import { initDevice, deviceClass, touchDefaults, touchLimits, isTouchDevice } from './device';
import { seedMobilePrefs, initMobileUi } from './ui/mobile';
{ const c = initDevice(); if (c !== 'desktop') seedMobilePrefs(c === 'phone'); }   // marks <body> as mobile/phone/tablet before the interface is built (the stylesheet follows those classes)
import * as THREE from 'three';
import init, { World, Ai, effect_radii, flammability_of, upgrade_cost_flat, road_resurface_cost_flat, village_sites, tunnels_flat, footprint_of, door_info, warm_navigation_step, world_restore, terrain_land_rows, trees_in_rows, trees_in_row_count, state_hash_part_names, rules_fingerprint, ledger_extra_names, military_upgrades } from './wasm/game_core.js';
import { icon, unitIcon, type IconName } from './ui/icons';
import { CommandScreen } from './ui/commandscreen';
import { parseLedger, steadyRate, EXTRA_INFO, fmtRate } from './flowrate';
import { parseRows, parseTotals, stepWant, parseProductionProblems, productionProblemText } from './workview';
import { HighlightState, addCatalogKinds, stockSources, mergeSources, summarize, kindLine, tierText, STRIDE, ST_WAIT, ST_EXHAUSTED, ST_FULL, ST_RESERVE } from './stockhighlight';
import { CATS, DEPOSIT, EVENT_TEXT, PLACE_ERRORS, RES, resIcon, STATUS, defs, tierName, KIND_ICON, units, NOPAD, PEN_SPACING, bosses, LEVEL_TOOL, PLANT_TOOL } from './data';
import { BATTLE_STRIDE, parseBoss, bossLine, bossTitle, hpFraction, raidAnnouncement, lairAnnouncement, reportBoss, reportLine } from './bosses';
import { PenPreview } from './render/pen';
import { AnchorGhost, anchorShape, doorInWorld } from './render/anchorghost';
import { SelectionMark } from './render/selection';
import { connectedWalls, planUpgrade } from './multiselect';
import { RadiusRings } from './render/coverage';
import { parseRadii, describe as describeRadii, uncoveredByWells, wallsOutOfReach, FX_FIRE_FULL, FX_FIRE_HALF, FX_SHOOT, type Radius } from './coverage';
import { OVER_WATER_KINDS } from './render/ringheight';
import { buildShowroom } from './render/showroom';
import { settings, onSettings, pixelRatio, wantAntialias, setSettings, playerChoseSettings, type Settings } from './settings';
import { rendererName, isSoftwareRenderer, isIntegratedGpu } from './gpucheck';
import { auditModel, setNightLight } from './render/buildings';
import { subdivide, curve, type Pt } from './roadtool';
import { LEVEL_SIZES, DEFAULT_LEVEL_SIZE, nextLevelSize, LEVEL_AUTO, LEVEL_HEIGHT_STEP, clampLevelHeight, levelHeightLabel, levelWork, isEarthwork } from './leveltool';
import { LEVEL_HEIGHT } from './net/validate';
import { SHAPES, isFigure, figureOutline, samplePath, snap45, rotOf, closesPath, type Shape, type P } from './penshapes';
import { WorldShips } from './render/ships';
import { Terrain, HALF, STEP, NV } from './render/terrain';
import { Atmosphere } from './render/sky';
import { CameraRig } from './render/camera';
import { Forest } from './render/trees';
import { buildModel, Effects, type BuildingModel, type VillageView } from './render/buildings';
import { Deposits } from './render/deposits';
import { Camps } from './render/camps';
import { depositLabel, depositPanel, parseBuildingDeposit } from './depositinfo';
import { Crowd } from './render/crowd';
import { Travellers, type TVillage } from './render/travellers';
import { JK, GIFT, arrivedText } from './render/journey';
import { Effects2, EffectView } from './render/fx';
import { freeze } from './render/static';
import { Wildlife } from './render/wildlife';
import { UI, esc, toggleFullscreen } from './ui/ui';
import { keys, digitOf, prettyKey, type Action } from './keys';
import { Perf } from './perf';
import { VERSION } from './version';
import type { ArmyRouteRequest, MarchPreviewRequest } from './march-planner.worker';
import { Sound } from './audio';
import { Minimap, type MapVillage } from './ui/minimap';
import { Tunnels } from './render/tunnels';
import { startAgentBridge } from './agent';
import { cachedRect, nearestWithin, TOUCH_DRAG_PIXELS } from './render/camerafx';
import { paintFlag } from './ui/flagdesigner';
import { keyNames } from './ui/ui';
import { loadFlag, packFlag, unpackFlag, randomFlag, hasSavedFlag, drawFlag, type Flag } from './flag';
import { territoryOutline } from './render/border';
import { showChoice } from './ui/choicebox';
import { showPopulationInfo } from './ui/hudinfo';
import { applyCmd, stepTo, validSavedLog } from './commands';
import { replayInSlices, warmNavigationInSlices, collectInSlices } from './loader';
import { resumeFromCheckpoint, checksum, loadCheckpoint, saveCheckpoint, deleteCheckpoint, type Checkpoint } from './checkpoint';
import type { ReplicaReplayReply, ReplicaReplayRequest } from './replica-replay.worker';
import { GOALS, countsOf } from './goals';
import { togglePhotoMode } from './photo';
import { Ledger } from './ledger';
import { dayPhase, DAY_TICKS } from './daycycle';
import { cleanWorld, hashSeed, inviteLink, withWorld } from './worldname';
import { VillageWatch, stewardRisks, type StewardAction, type StewardMode } from './steward';
import { Tutorial } from './tutorial';
import { Replay } from './replay';
import { ReplicaTrack, ResyncPolicy, SYNC_PROTOCOL, describe, sameBuild, isNewerBuild, type Verdict } from './net/sync';
import { APP_ID, BUILD_TIME, deployedBuild, isOutdated, mayReload, reloadUrl } from './update';
import { showReplayBar, type ReplayBar } from './replayui';
import { runModelVillageIn } from './modelrunner';
import { compassWord } from './ui/compass';
const GOLD = 8;   // the gold store (catalog GD)
import { bribeOffer, bribeToast, bribeRefusal, BRIBE_CONSEQUENCE } from './bribe';
import { roleOf, actionsFor, foeFocus, foeTarget, foeCentroid, edgeArrow, shouldAutoJump, foeNear, sallyUnits, newlyLent, drawnUp, isLent, DB_UP, DB_MANUAL_DOWN } from './defence';
import { arrivalTime, crossingSummary, FIRST_STANCE, objectiveName, orderPins, parseRaidObjective, type BattlePin, type RaidObjective } from './battlefield';
import { Identity, Room, tagOf, type Cmd, type Signed, type Hello } from './net/p2p';
import { aiKey, aiName, pickLayouts, pickSites, raidRequests } from './pve';
import { cleanName, parseCmd, Sequence } from './net/validate';
import { restartCmd, rebaseLog, restartBlocker, validArchive, type Archive, type Facts } from './restart';
import { saveKept, loadKept, deleteKept } from './checkpoint';
import { Village, type Shared } from './village';
import { PathLine, STATE_TEXT } from './render/field';
import { ArmyPicker } from './render/armypick';
import { PIGSTY, isLivestockPen } from './pasture';

await init();

const radii = defs.map(d => d.r);
/** How much room a building takes at a tier (the core's rule: grander buildings spread out as they are upgraded). */
const footprint = (kind: number, tier: number) => footprint_of(kind, tier);
const sound = new Sound();
const nextFrame = () => new Promise<void>(r => setTimeout(r, 20));
/** Game ticks per real second at 1x. Half a tick per second keeps the pace of the village calm and readable. */
const TICK_RATE = 0.5;
const watch = new VillageWatch();
const params = new URLSearchParams(location.search);
/** Handles for tests and the browser console (window.__game): only on this computer or with ?debug=1, never in a shared build by default. */
const DEBUG_HOOKS = import.meta.env.DEV || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || params.has('debug');
const NAMES = ['Aldric', 'Beatrix', 'Cedric', 'Dunstan', 'Eleanor', 'Fulk', 'Godric', 'Hawise', 'Isolde', 'Jocelin', 'Leofric', 'Matilda', 'Osric', 'Rowena', 'Wulfric'];

const ui: UI = new UI({
  restartInfo: () => restartInfo(), restartRun: () => restartVillage(), restartRestore: () => restoreArchivedVillage(),
  start: (w, n, pve) => startGame(w, n, !!pve),
  select: k => selectKind(k === selectedKind ? null : k),
  act: a => onAct(a),
  upgradeHover: on => showUpgradeOutline(on),
  stockHover: (res, sign) => stockHover(res, sign),
  stockInfo: (res, sign) => stockInfo(res, sign),
  stockGo: (res, sign, kind) => stockGo(res, sign, kind),
  setWorkers: (idx, n) => setWorkers(idx, n),
  workAll: a => workAll(a),
  setReserves: (grain, wood) => setReserves(grain, wood),
  villagers: () => ({ rows: lv.people.roster(), sheltering: lv.people.hidden }),
  followVillager: id => followVillager(id),
  goBuilding: i => { const f = lv.world.buildings_flat(); rig.focus(f[i * STRIDE + 2], f[i * STRIDE + 3]); selectBuilding(i); },
  goHome: () => { if (showroom) toggleShowroom(); rig.stopFollowing(); rig.focus(lv.ox, lv.oz, 75); },
  speed: n => setSpeed(n),
  steward: action => stewardAction(action),
  toggleResources: () => toggleResources(),
  toggleCoverage: () => toggleCoverage(),
  muster: u => doMuster(u, true),
  detAction: (a, id) => detAction(a, id),
  toggleMute: () => { sound.setMuted(!sound.muted); ui.setMuteIcon(sound.muted); },
  setVolume: v => sound.setVolume(v),
  muteHidden: on => sound.setMuteHidden(on),
  audioPrefs: () => ({ volume: sound.volume, muteHidden: sound.muteHidden }),
  minimapClick: (x, z) => rig?.focus(x, z),
  train: (k, n) => doTrain(k, n),
  untrain: (k, n) => doUntrain(k, n),
  research: id => doResearch(id),
  bridgeShortcuts: on => { if (replay?.target === lv) { updateHud(); return; } lv.world.army_set_bridge_shortcuts(on); void commit({ op: 'armybridge', kind: Number(on) }); },
  attack: (key, u) => doAttack(key, u),
  attackSelected: key => doAttackSelected(key),
  assistSelected: key => void doAssistSelected(key),
  askHelp: key => askForHelp(key),
  recallAid: key => recallAid(key),
  guestsHome: key => { const r = rivals.get(key); if (r) sendGuestsHome(r, false); },
  trade: (key, action, res, amount, escort) => doTrade(key, action, res, amount, escort),
  watch: key => startReplay(key),
  focusPeer: key => { const r = rivals.get(key); if (r) rig.focus(r.village.ox, r.village.oz, 80); },
  cheat: (a, x, y) => doCheat(a, x, y),
  copyLink: () => navigator.clipboard?.writeText(inviteLink(location.href, worldName)),
}, cleanWorld(params.get('world')), localStorage.getItem('flanders:name') ?? NAMES[Math.floor(Math.random() * NAMES.length)]);

// interface sounds
document.addEventListener('click', e => { if ((e.target as HTMLElement)?.closest?.('button,.card,.chip,.tab')) sound.click(); });
let lastHover: Element | null = null;
// a mouse or trackpad only: Safari fires mouseover for every tap as well, which played the hover blip on top of the click sound on phones and tablets
document.addEventListener('pointerover', e => { if (e.pointerType !== 'mouse') return; const t = (e.target as HTMLElement)?.closest?.('.btn,.card,.tab,.chip,.pbtn'); if (t && t !== lastHover) { lastHover = t; sound.hover(); } else if (!t) lastHover = null; });

// ---------- game state ----------
let worldName = 'flanders', seedBig = 1n, started = false;
/** A PVE game: two villages run by the computer instead of other players (see docs/PVE.md, web/src/pve.ts). It has its own save and never joins the shared room. */
let pveMode = false;
/** Computer villages are present in every game, shared worlds included (they are simulated on this computer only; other players do not see them). */
let computerVillages = false;
let renderer!: THREE.WebGLRenderer, scene!: THREE.Scene, terrain!: Terrain, forest!: Forest, atmo!: Atmosphere, rig!: CameraRig;
let bigMap!: Minimap;
let penPreview!: PenPreview;
let moatWidth = 0;   // 0..7: how broad the moat you dig is (the R key changes it)
let penStart: { x: number; z: number } | null = null;   // the wall pen: where the stroke began
let penShape: Shape = 'line';                            // what the pen draws: a line, a path of corners, or a ready-made figure
let roadPts: P[] = [], roadLastClick = 0;                  // the road tool: the points clicked so far
let penPath: P[] = [];                                   // the corners clicked so far in path mode
let penLastClick = 0;                                    // when the last corner was clicked (a quick second click finishes the path)
let tunnels!: Tunnels;
let camps!: Camps, deposits!: Deposits, minimap!: Minimap, effects!: Effects, crowd!: Crowd, fx!: Effects2, wildlife!: Wildlife, shared!: Shared;
let lv!: Village;                           // your village
interface Rival {
  key: string; peerId: string; name: string; site: number; village: Village; online: boolean; sync: string; tick: number; broken?: boolean; log: Cmd[];
  /** A village run by the computer (PVE): its world is stepped here every tick, together with the controller that plays it. */
  ai?: Ai;
  /** The bookkeeping that tells whether this copy still matches the owner's village (net/sync.ts), and what the game is doing about it. */
  track: ReplicaTrack; policy: ResyncPolicy;
  versionOk: boolean;                          // false: they run other simulation rules, so their history cannot be judged here
  state: 'ok' | 'resyncing' | 'failed';
  confirming: boolean;                         // their history was just asked for and replayed: the next comparison says whether that helped
  forked: boolean;                             // our own army fought in this copy (an away village): it no longer follows their history
  liar: boolean;                               // we corrected the loot they claimed, so this copy differs from theirs on purpose
  desyncs: number; resyncs: number; lastDiag: string; bigJumpAt: number; failedAt: number;
  loadSeq?: number; loading?: boolean;         // a history is being replayed into a fresh copy in slices (newest wins); the old copy waits meanwhile
  /** Their commands changed the village (and its ground) since its scene was last refreshed: see flushRivals. */
  dirty?: boolean; dirtyTerrain?: boolean; flushedAt?: number; groundAt?: number;
  /** A command since the last flush may have changed what syncFull rebuilds (buildings, roads, walls, the flag): see LIGHT_OPS. */
  dirtyFull?: boolean;
  cacheDue?: boolean;                          // a rebuilt copy that is kept in this browser once a hash confirms it
  /** The connection to them: the round trip in ms, how it is doing, and (while they are gone) the timer that tells the player they left (a short break is not worth a message). */
  ping?: number | null; link?: 'good' | 'weak' | 'lost'; leftTimer?: number; leftTold?: boolean;
}
const tutorial = new Tutorial();
tutorial.setKeys(a => { const b = keys.binds[a as Action]; return b && b.length ? b.slice(0, 2).map(k => prettyKey(k)).join(' / ') : a; });
keys.onChange(() => tutorial.refresh());
const ledger = new Ledger();               // what battles really gave (see ledger.ts)
const rivals = new Map<string, Rival>();    // by public key
const byPeer = new Map<string, string>();   // peerId -> pub
let sites: { x: number; z: number }[] = [];
let mySite = 0, myName = 'Traveller';
let perf!: Perf;
/** The planting brush: its radius (the R key cycles it); and the forester whose planting zone is being picked on the map. */
let plantR = 4, zoneIdx: number | null = null;
/** The building whose rally point is being picked on the map: 0 the barracks, 1 the castle. */
let rallyPick: number | null = null;
let levelR = DEFAULT_LEVEL_SIZE, levelCode = 99, levelH = LEVEL_AUTO, earthworkH = LEVEL_AUTO, levelHintKey = '', levelDisc!: THREE.Mesh;
let selectedKind: number | null = null, rot = 0, ghost: THREE.Group | null = null, ghostCode = 99;
let selectedIdx: number | null = null;
let selRing!: SelectionMark, growRing!: SelectionMark; const blockRings: SelectionMark[] = [];
/** The border of the land you hold: the outline of the union of a patch round every building (not a circle). */
const borderRing = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.6 }));
borderRing.frustumCulled = false; let borderKey = '';
let speed = 1, acc = 0, showDeposits = false;
const rates = new Array(RES.length).fill(0);   // steady net rate of each resource per day (from the core's ledger: see flowrate.ts)
let LEDGER_EXTRAS: string[] = [];
const depLabels: HTMLElement[] = [];
/** A copy out of the core that changes only when the world ticks, read at most once per tick (and at least every quarter second, so a command applied while
 *  paused still shows) per world, however many labels, arrows and maps ask for it in a frame. Each call into the core copies the whole array. */
function perTick<T>(read: (w: World) => T) {
  const cache = new WeakMap<World, { tick: bigint; at: number; v: T }>();
  return (w: World): T => {
    const tick = w.tick(), now = performance.now(), c = cache.get(w);
    if (c && c.tick === tick && now - c.at < 250) return c.v;
    const v = read(w); cache.set(w, { tick, at: now, v }); return v;
  };
}
const battleUnits = perTick(w => w.battle_units_flat());
const depositsNow = perTick(w => ({ flat: w.deposits_flat(), asleep: w.deposits_asleep() }));
const buildingsNow = perTick(w => w.buildings_flat());
const hallLabels = new Map<string, HTMLElement>();
let pathLine!: PathLine;
let selectedDet: number | null = null;
let selectedRuin: number | null = null;
const attackTargets = new Map<number, string>();   // field army id -> the rival it is marching on
let ghostRing!: THREE.Mesh, builderRangeRing!: THREE.Mesh, previewKey = '', previewKey2 = '', anchorGhost: AnchorGhost | null = null, anchorKey = '', lastGhostE: { clientX: number; clientY: number } | null = null;
let placedPointer: { dx: number; dy: number } | null = null;
let touchPlacement: { x: number; z: number } | null = null;
let touchInput = document.body.classList.contains('mobile');   // on a phone or tablet the hints talk about taps from the start, not after the first touch

/** Bumped whenever the map generator changes: every world gets a fresh map and old saves are discarded. */
const MAP_VERSION = 7;
/** The map layout comes from the world name plus this salt. It stays at 3 (the layout of the earlier maps that players liked) even when MAP_VERSION moves on; change it only to deliberately roll new continents. */

// ---------- commands, saving, networking ----------
let identity!: Identity;
let room: Room | null = null;
const myLog: Signed[] = [];
let cmdN = 0, sendChain: Promise<void> = Promise.resolve(), saveTimer = 0;
/** How many commands of our history other players replay, and whether we have used testing tools (their effects cannot be replayed). Both go out with every hash so copies can tell what to expect. */
let sharedCount = 0, usedTools = false, myRules = '';
/** How many times this village was restarted (the epoch of the history we hold: see restart.ts) and when the last time was (wall clock, for the cooldown). */
let myEpoch = 0, lastRestartAt: number | null = null, restarting = false;
const isTool = (op: string) => op === 'cheat' || op === 'flatten' || op === 'demo';
/** What the saved history looks like to the others. */
const countShared = (log: { cmd: Cmd }[]) => { let n = 0; for (const e of log) if (isTool(e.cmd.op)) usedTools = true; else n++; return n; };
const myTag = () => tagOf(identity.pub);
const slot = params.get('player') ?? ''; // lets several players share one browser profile (testing)
let resetting = false;   // set while the full reset is wiping the saves, so nothing writes them back
const saveKey = () => `flanders:save:v${MAP_VERSION}:${worldName}${pveMode ? ':pve' : ''}${slot ? ':' + slot : ''}`;
const checkpointKey = () => saveKey() + ':checkpoint';
let commitsInFlight = 0;   // commands applied to the world that are not in the saved history yet (they wait for their signature): no checkpoint while there are any
let lastCheckpointAt = 0;

/** Keep the whole state of your village, so that the next visit does not replay a long history (see checkpoint.ts). Only when the world is exactly what the saved history gives. */
function checkpoint(force = false) {
  if (resetting || !lv || replay?.target === lv || commitsInFlight > 0 || !myLog.length || !myRules) return;
  const now = performance.now();
  if (!force && now - lastCheckpointAt < 45_000) return;
  lastCheckpointAt = now;
  try { const bytes = lv.world.snapshot(); saveCheckpoint(checkpointKey(), { meta: { rules: myRules, v: SYNC_PROTOCOL, site: mySite, epoch: myEpoch, cmds: myLog.length, lastCmd: myLog[myLog.length - 1].cmd, tick: Number(lv.world.tick()), savedAt: Date.now(), hash: String(lv.world.state_hash()), sum: checksum(bytes) }, bytes }); } catch (e) { console.warn('Could not write a checkpoint.', e); }
}
// maps made by older generators are gone: their saved villages would not fit the new terrain, so they are removed
try { for (const k of Object.keys(localStorage)) if (k.startsWith('flanders:save:') && !k.startsWith(`flanders:save:v${MAP_VERSION}:`)) localStorage.removeItem(k); } catch { /* storage blocked */ }

/** Record a command that was already applied to your own village: sign it, save it and tell everyone. */
async function commit(cmd: Omit<Cmd, 'tick' | 'n'>) {
  if (replay?.target === lv) return;   // watching your own history: the village on screen is a replay, not the game
  const full: Cmd = { ...cmd, tick: Number(lv.world.tick()), n: cmdN++, ...(myEpoch > 0 ? { e: myEpoch } : {}) };
  if (isTool(cmd.op)) usedTools = true; else sharedCount++;
  const signing = identity.sign(full);
  commitsInFlight++;
  sendChain = sendChain.then(async () => {
    try {
      const s = await signing;
      myLog.push(s);
      room?.broadcastCmd(s);
      save();
    } finally {
      commitsInFlight--;
      if (document.hidden && commitsInFlight === 0) { clearTimeout(saveTimer); writeSave(); }
    }
  });
  await sendChain;
}

function save() {
  if (replay?.target === lv) return;   // the village on screen is a replay: never write it over the real save
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(writeSave, 400);
}
function writeSave() {
  if (resetting || replay?.target === lv || commitsInFlight > 0) return;
  try { localStorage.setItem(saveKey(), JSON.stringify({ site: mySite, name: myName, log: myLog, savedAt: Date.now(), tick: Number(lv.world.tick()), steward: watch.mode, paused: speed === 0, v: SYNC_PROTOCOL, rules: myRules, epoch: myEpoch, restartedAt: lastRestartAt })); } catch { /* storage full or blocked */ }
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
  const w = World.new_legacy(seedBig, o.x, o.z);
  for (const s of myLog) { const c = JSON.parse(s.cmd) as Cmd; stepTo(w, c.tick); applyCmd(w, c); }
  stepTo(w, keep);
  lv.setWorld(w);
  terrain.resetPads(); for (const r of rivals.values()) refreshTerrain(r.village.world);
  refreshTerrain(w); lv.syncFull(); rig.focus(o.x, o.z); save(); room?.announce();
}

/** A replica of another player's village threw while applying their commands. A trap inside the wasm core leaves that copy unusable, so stop listening to it
 *  (it is rebuilt from their next history) instead of letting a bad message break the whole game. */
function quarantine(r: Rival, e: unknown) {
  console.warn('A rival village could not be replayed; ignoring it until it sends a fresh history.', e);
  r.broken = true; r.sync = 'broken';
  try { r.village.setWorld(World.new_legacy(seedBig, siteOrigin(r.site).x, siteOrigin(r.site).z)); r.village.syncFull(); } catch { /* keep the old copy */ }
  startResync(r, 'the copy could not be replayed'); updatePeers();
}

// ---------- keeping the copies of other villages in step (the rules are in net/sync.ts) ----------
let PART_NAMES: string[] = [];

// ---------- copies of other villages kept in this browser between visits ----------
// Replaying another player's whole history from the first day takes a long while for a big village. The last copy we built is kept in IndexedDB as a checkpoint,
// with the same safety checks as your own (same rules, site and epoch, the same command at the same place in their history, the bytes and the state hash intact),
// so next time their village shows up at once and only the commands since are replayed. Their history stays the truth: a copy that does not fit is thrown away.
const rivalCacheKey = (pub: string) => 'flanders:rival:' + worldName + ':' + pub;
const cmdText = (c: Cmd) => JSON.stringify(c);
const rivalNow = (r: Rival, cmds: Cmd[]) => ({ rules: myRules, v: SYNC_PROTOCOL, site: r.site, epoch: Sequence.epochOf(cmds) });
/** The cached copy as a world, when it belongs to (a start of) this history; null otherwise. */
function restoreRivalCopy(cp: Checkpoint | null, r: Rival, cmds: Cmd[]): World | null {
  const k = cp?.meta.cmds ?? 0;
  if (!cp || !Number.isInteger(k) || k < 1 || k > cmds.length) return null;
  const history: { cmd: string; tick: number }[] = new Array(k);
  history[k - 1] = { cmd: cmdText(cmds[k - 1]), tick: cmds[k - 1].tick };   // (only the last command it applied is compared)
  return resumeFromCheckpoint(cp, rivalNow(r, cmds), history, b => world_restore(b));
}
/** Keep this copy for next time. Only a copy their own hash has confirmed ("in sync"): not one being rebuilt, broken, fought in, corrected, or not yet compared. */
function saveRivalCopy(r: Rival) {
  if (r.loading || r.broken || r.forked || r.liar || r.state !== 'ok' || r.sync !== 'in sync ✓' || !r.versionOk || !r.log.length || replay?.target === r.village) return;
  try {
    const w = r.village.world, last = r.log[r.log.length - 1];
    if (Number(w.tick()) < last.tick || r.track.count !== r.log.length) return;   // (a command in the log that the copy has not applied)
    const bytes = w.snapshot();
    r.cacheDue = false;
    void saveCheckpoint(rivalCacheKey(r.key), { meta: { ...rivalNow(r, r.log), cmds: r.log.length, lastCmd: cmdText(last), tick: Number(w.tick()), savedAt: Date.now(), hash: String(w.state_hash()), sum: checksum(bytes) }, bytes });
  } catch { /* storage full or blocked: the history alone still works, only slower */ }
}

/** Replay `cmds` onto a world (a snapshot, or a fresh village) in a worker: the snapshot bytes of the result. Null when the worker could not run; throws when the replay failed. */
function replayInWorker(o: { x: number; z: number }, snapshot: Uint8Array | undefined, cmds: Cmd[], cancelled: () => boolean): Promise<Uint8Array | null> {
  let worker: Worker;
  try { worker = new Worker(new URL('./replica-replay.worker.ts', import.meta.url), { type: 'module' }); } catch { return Promise.resolve(null); }
  return new Promise((resolve, reject) => {
    const done = () => { clearInterval(poll); worker.terminate(); };
    const poll = setInterval(() => { if (cancelled()) { done(); resolve(null); } }, 250);   // (a newer history arrived: stop this one; the caller sees it is cancelled)
    worker.onmessage = ({ data }: MessageEvent<ReplicaReplayReply>) => { done(); if (data.ok) resolve(data.bytes); else reject(new Error(data.error)); };
    worker.onerror = e => { e.preventDefault(); done(); resolve(null); };   // (the worker could not start: replay here instead)
    const msg: ReplicaReplayRequest = { seed: seedBig, ox: o.x, oz: o.z, snapshot: snapshot?.slice(), cmds };
    worker.postMessage(msg);
  });
}

/** Rebuild a copy from a history (theirs, as they sent it or as we kept it). */
async function loadReplica(r: Rival, cmds: Cmd[]) {
  r.log = cmds.slice();
  if (replay?.target === r.village) return;   // being watched: the replay shows their history; it is rebuilt from r.log when you leave
  const seq = r.loadSeq = (r.loadSeq ?? 0) + 1, n = cmds.length;
  const cancelled = () => r.loadSeq !== seq || replay?.target === r.village;
  const stop = () => { if (r.loadSeq === seq) r.loading = false; };
  r.loading = true;
  try {
    const o = siteOrigin(r.site);
    // a copy kept from an earlier visit: show it at once (their village as it was then) while the commands since are replayed
    // (not when re-syncing: the copy went wrong, and the kept one may be where it went wrong. Then it is thrown away and their history is replayed from the first day.)
    let start: Uint8Array | undefined, from = 0;
    const resync = r.state !== 'ok' || r.confirming;
    if (resync) await deleteCheckpoint(rivalCacheKey(r.key));
    const cp = resync ? null : await loadCheckpoint(rivalCacheKey(r.key));
    if (cancelled()) return stop();
    const shown = restoreRivalCopy(cp, r, cmds);
    if (shown) {
      start = cp!.bytes; from = cp!.meta.cmds;
      shown.take_shots(); shown.take_events();
      r.village.setWorld(shown); refreshTerrain(shown); r.village.syncFull(); r.village.markCaughtUp(); r.village.afterTick(); r.village.markCaughtUp();
      console.info(`${r.name}'s village was restored from this browser (${from} of ${n} commands); replaying the rest.`);
    }
    // the replay runs in a worker, at full speed and without slowing the game down; if no worker can run, here, a few milliseconds at a time
    const bytes = await replayInWorker(o, start, cmds.slice(from), cancelled);
    if (cancelled()) return stop();
    let w = bytes ? world_restore(bytes) : undefined;
    if (!w) {
      w = (start && world_restore(start)) || undefined;
      if (!w) { w = World.new_legacy(seedBig, o.x, o.z); from = 0; }
      const res = await replayInSlices(w, cmds.slice(from), applyCmd, 0, { cancelled });
      if (!res.ok) return stop();
    }
    w.take_shots(); w.take_events();
    for (const c of r.log.slice(n)) { stepTo(w, c.tick); applyCmd(w, c); }   // (commands that arrived while it was replaying)
    r.loading = false;
    r.village.setWorld(w); r.tick = Number(w.tick()); r.broken = false; r.forked = false; r.liar = false;
    r.track.reset(r.log.map(c => c.op), Sequence.epochOf(r.log)); if (r.versionOk && r.state === 'ok' && r.sync !== 'in sync ✓') r.sync = 'syncing…';
    refreshTerrain(w); r.village.syncFull(); r.village.markCaughtUp(); r.village.afterTick(); r.village.markCaughtUp(); updatePeers();
    r.cacheDue = true;   // kept once their next hash confirms it (see judged)
  } catch (e) { if (r.loadSeq === seq) r.loading = false; quarantine(r, e); }
}

/** Bring a copy to a tick for a comparison. A stranger's hash must not be able to make us run a copy far ahead over and over, so big jumps are rationed. */
function advanceReplica(r: Rival, tick: number): boolean {
  if (tick - Number(r.village.world.tick()) > 300) { const now = performance.now(); if (now - r.bigJumpAt < 3000) return false; r.bigJumpAt = now; }
  return r.village.advanceTo(tick);
}

/** Bring the scenes of other villages up to date after their commands: at most every 400 ms per village, and their ground at most once a second. */
/** Rival commands that change nothing syncFull rebuilds (trade, diplomacy, armies on the move, training, research): the per-tick afterTick() covers what they
 *  do show. Any op not listed here (including new ones) still gets the full rebuild. */
const LIGHT_OPS: ReadonlySet<string> = new Set(['accept', 'arrive', 'ask', 'attack', 'battleorder', 'bribe', 'buy', 'caravan', 'carhome', 'choose', 'envoy', 'form', 'goods', 'halt', 'journey', 'march', 'marriage', 'merge', 'raid', 'rally', 'recall', 'recallaid', 'reinforce', 'research', 'reserve', 'retreat', 'return', 'sendaid', 'sendatk', 'split', 'train', 'treaty', 'turnback', 'untrain', 'visit', 'war', 'workers']);
function flushRivals(now: number) {
  for (const r of rivals.values()) {
    if (!r.dirty || r.loading || r.broken || replay?.target === r.village || now - (r.flushedAt ?? -1e9) < 400) continue;
    const ground = !!r.dirtyTerrain;
    if (ground && now - (r.groundAt ?? -1e9) < 1000) continue;
    r.dirty = false; r.flushedAt = now;
    try {
      if (ground) { r.dirtyTerrain = false; r.groundAt = now; refreshTerrain(r.village.world); }
      // the full rebuild (roads, road props, walls, props, the forest's clearings) only after a command that can change them; afterTick() refreshes the rest,
      // and itself rebuilds in full when the building count or the ground changed
      if (r.dirtyFull || ground) { r.dirtyFull = false; r.village.syncFull(); }
      r.village.afterTick();
    } catch (e) { quarantine(r, e); }
  }
}

function judged(r: Rival, v: Verdict | null) {
  if (!v) return;
  const before = r.sync;
  switch (v.kind) {
    case 'match':
      r.tick = Number(r.village.world.tick()); r.confirming = false; r.sync = 'in sync ✓';
      if (r.cacheDue) saveRivalCopy(r);
      if (r.state !== 'ok') { r.state = 'ok'; r.policy.reset(); ui.toast(`Back in sync with ${r.name}.`, 'good'); console.info(`Back in sync with ${r.name} at tick ${r.tick}.`); }
      break;
    case 'wait': if (r.sync !== 'in sync ✓') r.sync = 'syncing…'; break;
    case 'tools': r.sync = 'testing tools in use'; break;
    case 'mismatch': case 'lost': desynced(r, v); break;
    default: break;
  }
  if (r.sync !== before) updatePeers();
}

/** A copy disagrees with its owner. The owner is right (their village is the real one); ours is rebuilt from their history. */
function desynced(r: Rival, v: Verdict & { kind: 'mismatch' | 'lost' }) {
  const what = v.kind === 'mismatch' ? describe(v.diag) : `${v.missing} command${v.missing === 1 ? '' : 's'} never arrived`;
  if (r.state === 'ok') { r.desyncs++; console.warn(`Out of sync with ${r.name}: ${what}`, v); }
  r.lastDiag = what;
  if (r.state === 'failed') { if (performance.now() - r.failedAt > 300_000) { r.state = 'ok'; r.policy.reset(); } else return; }   // (told already; tries again every five minutes)
  if (r.confirming) { failSync(r, 'their history plays out differently here, so they are probably on another version of the game or using testing tools'); return; }
  startResync(r, what);
}

function startResync(r: Rival, why: string) {
  if (r.state === 'failed') return;
  const go = r.policy.ask(performance.now());
  if (go === 'stop') { failSync(r, 'it keeps going wrong'); return; }
  if (r.state === 'ok') ui.toast(`Re-syncing with ${r.name}…`, 'info');
  r.state = 'resyncing'; r.sync = 're-syncing…'; updatePeers();
  if (go === 'go') { r.resyncs++; console.info(`Re-syncing with ${r.name} (${why}).`); room?.requestLog(r.peerId); }
}

function failSync(r: Rival, why: string) {
  r.state = 'failed'; r.confirming = false; r.failedAt = performance.now(); r.sync = 'could not sync';
  ui.toast(`Could not sync with ${r.name}: ${why}. Their village may look a little different here.`, 'info');
  console.warn(`Could not sync with ${r.name}: ${why}. ${r.lastDiag}`); updatePeers();
}

/** The lines the performance panel (F3) shows about the sync with each player. */
function syncNotes(): string[] {
  const out = [`You: ${sharedCount} commands shared · build ${SYNC_PROTOCOL}/${myRules || '?'}${usedTools ? ' · testing tools used: others cannot replay those changes' : ''}`];
  for (const r of rivals.values()) {
    out.push(`${r.name}: ${r.sync}${r.ping != null ? ` · ${r.ping} ms` : ''}${r.link && r.link !== 'good' ? ` · link ${r.link}` : ''} · ${r.desyncs} desync${r.desyncs === 1 ? '' : 's'} · ${r.resyncs} re-sync${r.resyncs === 1 ? '' : 's'} · tick ${Number(r.village.world.tick())} · ${r.track.count} commands`);
    if (r.lastDiag) out.push(`  last: ${r.lastDiag}`);
  }
  return out;
}

let yielding = false;
/** Two tabs of one browser share a key and a saved village, so the game saw "Matilda 2" as the same player and put them on the same spot. One of the two tabs (the one with the larger
 *  connection id; both can tell) starts again with its own key and village (`?player=`) and joins by itself under the same name. */
function giveWayToOtherTab(otherPeer: string) {
  if (yielding || !room || !room.self || room.self < otherPeer) return;   // the other tab is the one that moves
  yielding = true;
  try { sessionStorage.setItem('flanders:autostart', JSON.stringify({ world: worldName, name: myName })); } catch { /* storage blocked: the player will press Enter again */ }
  ui.toast('Another tab in this browser is already playing as you. This tab starts its own village…', 'info');
  const u = new URL(location.href); u.searchParams.set('player', 'tab' + Math.random().toString(36).slice(2, 8));
  setTimeout(() => location.replace(u.toString()), 1800);
}

let updating = false;
/** A newer build exists (the site says so, or another player runs it): save, tell the player, and load it. A reload that did not help is not repeated (see update.ts). */
async function updateNow(why: string) {
  if (updating) return;
  updating = true;
  const d = await deployedBuild(fetch);
  let allowed = false;
  try { allowed = !!d && isOutdated(APP_ID, d) && mayReload(sessionStorage, d.id, Date.now()); } catch { allowed = !!d && isOutdated(APP_ID, d); }
  if (!allowed || !d) { updating = false; if (!d || !isOutdated(APP_ID, d)) ui.toast(`${why} Reload the page to get the latest version.`, 'info'); return; }
  ui.toast(`${why} Updating to the latest version in a few seconds…`, 'info');
  clearTimeout(saveTimer); try { writeSave(); checkpoint(true); } catch { /* the reload keeps what was saved before */ }
  setTimeout(() => location.replace(reloadUrl(location.href, d.id)), 4000);
}

/** Now and then (and whenever the page is shown again) ask the site which build is deployed. */
function startUpdateWatch() {
  const check = async () => { if (updating || document.hidden) return; if (isOutdated(APP_ID, await deployedBuild(fetch))) void updateNow('A newer version of the game is out.'); };
  setInterval(check, 5 * 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
  setTimeout(check, 20_000);
}

function connect() {
  (window as unknown as { flandersSync: () => string[] }).flandersSync = syncNotes;   // for the console: how every copy of another village stands
  room = new Room(worldName, identity, (): Hello => ({ pub: identity.pub, site: mySite, name: myName, tick: Number(lv.world.tick()), world: worldName, v: SYNC_PROTOCOL, rules: myRules, b: BUILD_TIME }), () => myLog, {
    onStatus: s => ui.netStatus(s),
    onHello: (peerId, h) => {
      if (h.world !== worldName || h.site >= sites.length) return;
      if (h.pub === identity.pub) { giveWayToOtherTab(peerId); return; }   // another tab of this same browser: same key, same village, not a neighbour
      byPeer.set(peerId, h.pub);
      if (h.site === mySite && h.pub !== identity.pub) {
        // two villages on one spot: the player with the larger key moves out
        if (identity.pub > h.pub) { const free = [...Array(sites.length).keys()].find(i => i !== h.site && !claimedSites().has(i)); if (free !== undefined) moveToSite(free); }
        else { const r = rivals.get(h.pub); if (!r) { /* they will move; wait for their next hello */ } }
      }
      let r = rivals.get(h.pub);
      if (!r) {
        const o = siteOrigin(h.site);
        const village = new Village(World.new_legacy(seedBig, o.x, o.z), 'rival:' + h.pub, h.name, false, shared, 0xb03030); village.foeColor = foeColorOf;
        village.onReport = rep => onRivalReport(h.pub, rep);
        r = { key: h.pub, peerId, name: h.name, site: h.site, village, online: true, sync: 'syncing…', tick: 0, log: [], track: new ReplicaTrack(), policy: new ResyncPolicy(), versionOk: true, state: 'ok', confirming: false, forked: false, liar: false, desyncs: 0, resyncs: 0, lastDiag: '', bigJumpAt: 0, failedAt: 0 };
        rivals.set(h.pub, r); villagesChanged(); ui.toast(`${h.name} has joined the world.`, 'good');
        refreshTerrain(village.world); village.syncFull();
        chainTo(r);
      } else if (r.site !== h.site) {
        // they moved to another site: rebuild their replica there once their log arrives
        // (their history is the same, only the ground it stands on moved: replay what we have, and ask for it again to be sure)
        r.site = h.site; loadReplica(r, r.log); terrain.resetPads(); refreshAll(); room?.requestLog(peerId);
      }
      const wasAway = !r.online;
      r.peerId = peerId; r.online = true; r.name = h.name;
      if (r.leftTimer) { clearTimeout(r.leftTimer); r.leftTimer = 0; }   // a short break: nobody was told they had left, nobody needs telling they are back
      else if (r.leftTold) { r.leftTold = false; ui.toast(`${h.name} is back.`, 'good'); }
      if (wasAway && r.sync === 'away') r.sync = 'syncing…';
      const same = sameBuild({ v: h.v, rules: h.rules }, { v: SYNC_PROTOCOL, rules: myRules });
      const theirs = { v: h.v, rules: h.rules, b: h.b }, ours = { v: SYNC_PROTOCOL, rules: myRules, b: BUILD_TIME };
      if (!same && isNewerBuild(theirs, ours)) void updateNow(`${h.name} plays a newer version of the game.`);   // we are the one that is behind: everybody plays the latest
      if (!same && r.versionOk) { ui.toast(isNewerBuild(theirs, ours) ? `${h.name} plays a newer version of the game.` : `${h.name} plays an older version of the game and has been asked to update; their village may not look the same here until they do.`, 'info'); console.warn(`${h.name} runs another build (protocol ${h.v ?? 0}, rules ${h.rules || 'unknown'}; ours ${SYNC_PROTOCOL}, ${myRules}).`); }
      if (!same) r.sync = 'different game version'; else if (!r.versionOk) { r.sync = 'syncing…'; r.state = 'ok'; r.policy.reset(); }
      r.versionOk = same; updatePeers();
    },
    onLog: (peerId, cmds) => {
      const r = rivals.get(byPeer.get(peerId) ?? ''); if (!r) return;
      r.log = cmds.slice();
      if (replay?.target === r.village) return;   // being watched: the replay shows their history; it is rebuilt from r.log when you leave
      loadReplica(r, cmds);
      if (r.state === 'resyncing') r.confirming = true;   // we asked for this: the next comparison tells whether it helped
    },
    onCmd: (peerId, c) => {
      const r = rivals.get(byPeer.get(peerId) ?? ''); if (!r || r.broken) return;
      if (c.op === 'restart') { onRivalRestart(r, c); return; }
      if (r.log.length < 60000) r.log.push(c);
      if (replay?.target === r.village || r.loading) return;   // (while a copy is being rebuilt the new command waits in the log: the rebuilt copy plays it last)
      try {
        if (c.op === 'return' && c.kind !== 1) {   // check an actual battle result against the defender's copy
          for (const o of rivals.values()) if (o !== r) o.village.advanceTo(c.tick);   // (your own village is live: it is already as far as it will get)
          const v = ledger.claim(tagOf(r.key), c.units, c.loot); c = { ...c, units: v.units, loot: v.loot };
          if (v.lied) { r.liar = true; r.sync = 'claimed false loot'; console.warn(`${r.name} reported loot or survivors that the battle did not give; the real result was used.`); }
        }
        if (!r.village.advanceTo(c.tick)) { startResync(r, 'a command far ahead of the copy'); return; }   // (never apply a command at the wrong tick)
        applyCmd(r.village.world, c); r.track.applied(c.op);
        // the scene of their village is brought up to date at most a few times a second (flushRivals), not after every command: an autopilot sends many, and each
        // full refresh re-levels the whole village's ground and rebuilds its buildings and the forest. Every player paid that for every other village.
        r.dirty = true;
        if (c.op === 'place' || c.op === 'level' || c.op === 'demolish' || c.op === 'rebuild' || c.op === 'upgrade') r.dirtyTerrain = true;
        if (!LIGHT_OPS.has(c.op)) r.dirtyFull = true;
        r.tick = c.tick;
        if (c.op === 'battleorder') battleBanner();
      } catch (e) { quarantine(r, e); return; }
      judged(r, r.track.recheck(r.village.world, PART_NAMES, t => advanceReplica(r, t), performance.now()));   // a hash that was waiting for this command can be judged now
      if ((c.op === 'attack' || c.op === 'sendatk') && c.to === identity.pub) defendAgainst(r, c);
      else if (c.op === 'refuse' && c.to === identity.pub) {
        if (returnRefusedArmy(c.units ?? [])) ui.toast('Your army returned. The village is away or already under attack.', 'info');
      }
      if (c.op === 'retreat' && c.to === identity.pub && lv.world.battle_retreat(tagOf(r.key))) { commit({ op: 'retreat', from: r.key, tag: tagOf(r.key) }); ui.toast(`${r.name} calls off the attack: the raiders are running.`, 'good'); lv.afterTick(); }
      if (c.op === 'battleorder' && c.to === identity.pub) {
        const tag = tagOf(r.key);
        if (lv.world.battle_order(tag, c.idx!, c.kind!, c.x ?? 0, c.y ?? 0)) void commit({ op: 'battleorder', from: r.key, tag, idx: c.idx, kind: c.kind, x: c.x, y: c.y });
      }
      if (c.op === 'sendaid' && c.to === identity.pub) void receiveAid(r, c);
      else if (c.op === 'recallaid' && c.to === identity.pub) sendGuestsHome(r, true);
      else if (c.op === 'ask' && c.to === identity.pub) { ui.toast(`${r.name} asks you for help. Send soldiers to their village from the village list.`, 'info'); sound.alert(); }
      else if (c.op === 'host' && c.from === identity.pub) ui.toast(`${r.name} let your soldiers in. They fight beside the defenders there.`, 'good');
      else if (c.op === 'unhost' && c.to === identity.pub) { if (returnRefusedArmy(c.units ?? [])) ui.toast(`Your soldiers are home from ${r.name}.`, 'good'); }
      if (c.op === 'raid') ui.toast(`${r.name}'s village is under attack!`, 'info');
      if (c.to === identity.pub) onTrade(r, c);
    },
    onHash: (peerId, msg) => {
      const r = rivals.get(byPeer.get(peerId) ?? ''); if (!r || r.broken || r.loading || replay?.target === r.village) return;
      if (!r.versionOk || r.forked || r.liar) return;   // these copies differ from theirs for a known reason: there is nothing to judge
      judged(r, r.track.judge(msg, r.village.world, PART_NAMES, t => advanceReplica(r, t), performance.now()));
    },
    onLeave: peerId => {
      const r = rivals.get(byPeer.get(peerId) ?? '');
      // (they may already be back on a new connection: only the connection they are on now counts)
      if (r && r.peerId === peerId) {
        r.online = false; r.sync = 'away'; r.ping = null;
        clearTimeout(r.leftTimer);
        r.leftTimer = window.setTimeout(() => { r.leftTimer = 0; r.leftTold = true; ui.toast(`${r.name} has left the world.`, 'info'); }, 8000);
      }
      byPeer.delete(peerId); updatePeers();
    },
    onLinks: links => {
      let changed = false;
      for (const l of links) {
        const r = l.pub ? rivals.get(l.pub) : undefined; if (!r || r.peerId !== l.peerId) continue;
        const ping = l.rtt === null ? null : Math.round(l.rtt);
        if (r.link !== l.state || Math.abs((r.ping ?? 0) - (ping ?? 0)) >= 20 || (r.ping == null) !== (ping == null)) { r.link = l.state; r.ping = ping; changed = true; }
      }
      if (changed) updatePeers();
    },
  });
}

/** The thump, dust and shake when something is built; heavier buildings land harder. */
function placedFx(kind: number, x: number, z: number, upgrade = false) {
  const wgt = defs[kind].weight;
  if (!upgrade) sound.place(wgt);
  for (let i = 0; i < 1 + Math.floor(wgt / 2); i++) fx.burst(x + (Math.random() - 0.5) * defs[kind].r, z + (Math.random() - 0.5) * defs[kind].r, false);
  if (!OVER_WATER_KINDS.has(kind) && kind !== 38) rig.shake(0.05 + wgt * 0.04);
  updateGoals();
}

// ---------- goals ----------
function updateGoals() {
  if (!lv) return;
  const c = countsOf(lv.world, rivals.size);
  ui.setGoals(GOALS.map(g => ({ text: g.text, detail: g.detail, done: g.ok(c) })));
  tutorial.update(c);
}

// ---------- restart: start the village again (the protocol is in docs/RESTART.md, the rules in restart.ts) ----------
const archiveKey = () => saveKey() + ':archive';
const soldiersOf = (w: World) => Array.from(w.army()).reduce((a, n) => a + n, 0);

/** What the restart dialog needs to know about the village as it stands. */
function restartFacts(): Facts {
  const w = lv.world, f = w.buildings_flat(); let edits = 0;
  for (let i = 0; i < f.length; i += 10) { const k = f[i]; if (k === 24 || k === 32 || k === 33 || k === 34) edits++; }
  return {
    replaying: replay?.target === lv, busy: commitsInFlight > 0 || restarting, battle: w.battle_active(),
    armiesAway: w.det_flat().length > 0 || Array.from(w.away()).some(n => n > 0),
    lastRestartAt, now: Date.now(),
    days: Math.floor(Number(w.tick()) / DAY_TICKS) + 1, buildings: w.building_count(), population: w.population(), soldiers: soldiersOf(w), terrainEdits: edits + (w.felled_flat().length > 0 ? 1 : 0),
  };
}

async function restartInfo() {
  const a = validArchive(await loadKept(archiveKey()));
  return { facts: restartFacts(), name: myName, archive: a ? { archivedAt: a.archivedAt, days: a.days, buildings: a.buildings } : null };
}

/** Put the screen back in step with a village that was just replaced from the inside (the same world object, a new life). */
function showFreshVillage() {
  lv.people.resetRoster();
  rig.stopFollowing();
  const o = siteOrigin(mySite);
  showWorld(lv, lv.world, true);
  deposits.sync(lv.world.deposits_flat(), lv.world.deposits_asleep()); deposits.attach(lv.world.buildings_flat());
  selectedIdx = null; selectedDet = null; selectedRuin = null; selectKind(null); attackTargets.clear(); lentBridges = new Set();
  updateSelection(); updateHud(); updateGoals(); refreshAll();
  rig.focus(o.x, o.z, 75);
  for (const r of rivals.values()) chainTo(r);   // the invisible roads to the other villages went with the old village
}

/** The player pressed the red button. Resolves to null when the village has started again, or to what stopped it (nothing has changed then). */
async function restartVillage(): Promise<string | null> {
  const why = restartBlocker(restartFacts()); if (why) return why;
  restarting = true;
  try {
    await sendChain;
    if (commitsInFlight > 0) return 'Your village is still saving. Try again in a moment.';
    const w = lv.world, now = Date.now();
    // 1. keep the village that is about to go (one life: it replaces the one kept before). If it cannot be kept, nothing is done.
    const arch: Archive = { format: 'flanders-archive', version: 1, epoch: myEpoch, log: myLog.slice(), site: mySite, name: myName, savedAt: now, tick: Number(w.tick()), archivedAt: now, days: Math.floor(Number(w.tick()) / DAY_TICKS) + 1, buildings: w.building_count(), v: SYNC_PROTOCOL, rules: myRules };
    if (!(await saveKept(archiveKey(), arch))) return 'This browser would not keep a copy of your village (storage is full or blocked), so nothing was changed. Download a backup file first, or free some space.';
    // 2. the first command of the new epoch, signed; after this nothing can fail
    const epoch = myEpoch + 1, cmd: Cmd = { ...restartCmd(epoch), kind: 1 }, signed = await identity.sign(cmd);
    clearTimeout(saveTimer);
    myLog.length = 0; myLog.push(signed); cmdN = 1; sharedCount = 1; usedTools = false; myEpoch = epoch; lastRestartAt = now;
    applyCmd(w, cmd);   // the core starts the village again (World::restart)
    writeSave(); await deleteCheckpoint(checkpointKey());   // the checkpoint belonged to the old epoch
    room?.broadcastCmd(signed); room?.announce();
    showFreshVillage();
    tutorial.start(0); updateGoals();
    ui.toast('Your village was pulled down. A new one begins on the same ground.', 'good');
    ui.log('You started the village again.', 'info', 0);
    return null;
  } finally { restarting = false; }
}

/** Bring back the village the last restart archived: it becomes the new epoch (re-signed with a fresh number), the village you have now is lost. */
async function restoreArchivedVillage(): Promise<string | null> {
  if (restarting) return 'Wait a moment.';
  const a = validArchive(await loadKept(archiveKey())); if (!a) return 'There is no archived village to bring back.';
  const why = restartBlocker({ ...restartFacts(), lastRestartAt: null }); if (why) return why;
  if (a.site !== mySite) return 'The archived village stood somewhere else on the map and cannot be brought back here.';
  if (!(await ui.confirm(`This brings back the village you pulled down (day ${a.days}, ${a.buildings} buildings). The village you have now is lost, and cannot be brought back. Other players see it replaced.`, 'Bring it back', 'Bring back the old village?'))) return 'Nothing was changed.';
  restarting = true;
  try {
    await sendChain;
    const old = validSavedLog(a.log).map(x => x.cmd);
    if (!old.length) return 'The archived history is damaged.';
    const cmds = rebaseLog(old, myEpoch + 1), signed: Signed[] = [];
    for (const c of cmds) signed.push(await identity.sign(c));
    // build it first, so that a village that cannot be played never replaces the one we have
    const o = siteOrigin(mySite), w = World.new_legacy(seedBig, o.x, o.z);
    const res = await replayInSlices(w, cmds, applyCmd, a.tick, {});
    if (!res.ok) return 'The archived village could not be rebuilt.';
    if (!w.estate_active()) {
      const rules: Cmd = { op: 'reserve', x: 0, y: 0, tick: Number(w.tick()), n: cmds.length, e: myEpoch + 1 };
      applyCmd(w, rules); cmds.push(rules); signed.push(await identity.sign(rules));
    }
    clearTimeout(saveTimer);
    myEpoch += 1; myLog.length = 0; myLog.push(...signed); cmdN = cmds.length; sharedCount = countShared(cmds.map(cmd => ({ cmd }))); lastRestartAt = null;
    lv.setWorld(w);
    writeSave(); await deleteCheckpoint(checkpointKey()); await deleteKept(archiveKey());
    room?.broadcastCmd(signed[0]); room?.announce(); room?.pushLog();
    showFreshVillage();
    ui.toast('The old village is back.', 'good');
    return null;
  } finally { restarting = false; }
}

/** Another player started their village again: our copy of it becomes a new village too, and what we had agreed with the old one is over. */
function onRivalRestart(r: Rival, c: Cmd) {
  ui.toast(`${r.name} pulled their village down and started again.`, 'info');
  r.forked = false; r.liar = false;
  void loadReplica(r, [c]).then(() => { terrain.resetPads(); refreshAll(); forestDirtyFlag = true; rebuildForest(true); updatePeers(); });
  const tag = tagOf(r.key);
  for (const kind of [0, 1, 2]) if (lv.world.has_treaty(tag, kind)) { lv.world.treaty_end(tag, kind); commit({ op: 'treaty', idx: tag, kind, y: 0 }); }
  attackTargets.forEach((k, id) => { if (k === r.key) attackTargets.delete(id); });
  updateHud();
}

// ---------- testing tools ----------
/** Test tool: forget every saved village (all worlds) in this browser and start again from the empty map. Your identity and settings are kept. */
async function fullReset() {
  if (!(await ui.confirm('This deletes every saved village in this browser, in every world, and restarts from the empty map. Other players keep their own copies of your old village until they leave.', 'Delete everything', 'Reset the whole map?'))) return;
  resetting = true;
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('flanders:save:')) localStorage.removeItem(k); } catch { /* blocked */ }
  await deleteCheckpoint(checkpointKey()); try { indexedDB.deleteDatabase('flanders'); } catch { /* blocked */ }
  location.reload();
}

/** Test hall (off the map's east coast): every building at every tier in rows, and the top tier with all its design options. Press again to go home. */
let showroom: THREE.Group | null = null;
function toggleShowroom() {
  const hide = (on: boolean) => { terrain.mesh.visible = on; deposits.group.visible = on; forest.group.visible = on && settings().trees; wildlife.group.visible = on && settings().crowds; atmo.invalidateShadows(); };   // the hall stands on its own platform: the land and its trees would clip through it
  if (showroom) { scene.remove(showroom); showroom = null; hide(true); ui.hallExit(false, toggleShowroom); rig.focus(lv.ox, lv.oz, 75); ui.toast('Back at your village.', 'info'); return; }
  const x0 = 960, z0 = -560, sr = buildShowroom(defs.map(d => ({ id: d.id, name: d.name, maxTier: d.maxTier })), tierName, x0, z0);
  showroom = sr.group; showroom.position.y = Math.max(1, terrain.heightAt(sr.spawn.x, sr.spawn.z)); scene.add(showroom); hide(false); rig.focus(sr.spawn.x, sr.spawn.z, 70);
  ui.hallExit(true, toggleShowroom);
  ui.toast('Test hall: one row per building, tiers left to right, then tier 2 and the top tier with every design option (the second-tier options and the village roof palettes have their own columns and row). Pan along the rows; press the button again to leave.', 'info');
}

async function runModelVillage(ask: boolean) {
  if (ask && !(await ui.confirm('This clears every building except the town hall and builds a model village in its place.', 'Build it', 'Build the model village?'))) return;
  const w = lv.world;
  if (!runModelVillageIn({ world: w, commit: c => commit(c), changed: () => { deposits.sync(w.deposits_flat(), w.deposits_asleep()); deposits.refit(); forestDirtyFlag = true; afterLocalChange(); refreshTerrain(w); } })) { ui.toast('Not during a battle.', 'bad'); return; }
  lv.afterTick(); updateHud(); updateSelection();
  const f = w.buildings_flat(); rig.focus(f[2], f[3], 90);
  ui.toast(`Your model village is ready: ${w.building_count()} buildings.`, 'good');
}

function doCheat(action: number, a: number, b: number) {
  if (action === 103) { toggleShowroom(); return; }
  if (showroom) toggleShowroom();   // any other test action takes you back to your village first (the hall is only a drawing)
  if (action === 100) { runModelVillage(true); return; }
  if (action === 101) { fullReset(); return; }
  if (action === 102) { const height = b > 0 ? b / 10 : 5; if (lv.world.flatten(a, height) === 0) { commit({ op: 'flatten', x: a, y: height * 10 }); afterLocalChange(); refreshTerrain(lv.world); ui.toast('The ground is levelled.', 'good'); } return; }
  if (action === 5) a = selectedIdx ?? -1;           // "burn selected building"
  if (action === 5 && a < 0) { ui.toast('Select a building first.', 'info'); return; }
  if (!lv.world.cheat(action, a, b)) return;
  commit({ op: 'cheat', kind: action, x: a, y: b });
  if (action === 8) { selectBuilding(null); afterLocalChange(); ui.toast('The terrain was reset.', 'good'); return; }
  if (action === 7) ui.toast('All fires are out.', 'good');
  lv.afterTick(); updateSelection(); updateHud();
}

// ---------- trade and treaties ----------
const doDecide = (option: number) => {
  const code = lv.world.choose(option);
  if (code === 0) { commit({ op: 'choose', kind: option }); sound.click(); afterLocalChange(); } else ui.toast(code === -6 ? 'You cannot afford that.' : 'Cannot do that.', 'bad');
};

/** Another village is dealing with us: take the goods they sent, settle a caravan we sent, or answer a treaty (agreeing to a pact or peace costs us nothing). */
function onTrade(r: Rival, c: Cmd) {
  const w = lv.world, their = tagOf(r.key);
  if (c.op === 'goods') {   // their caravan reached us (we check on their copy of their village that it really did, so nobody can push goods on us)
    if (!r.village.world.is_awaiting(c.kind ?? 0, c.x ?? 0, myTag())) return;
    const kind = c.kind ?? 0, name = RES[kind & ~GIFT]?.name.toLowerCase() ?? 'goods';
    const paid = w.receive_goods_from(kind, c.x ?? 0, their);
    if (paid < 0) { commit({ op: 'turnback', kind: c.kind, x: c.x, to: r.key }); ui.toast(`${r.name}'s caravan was turned back: we want nothing from a hostile village.`, 'info'); return; }
    commit({ op: 'accept', kind: c.kind, x: c.x, idx: their, to: r.key });
    ui.toast(kind & GIFT ? `${r.name} sends us a gift: ${c.x} ${name}.` : `${r.name}'s caravan arrived: ${c.x} ${name}${paid ? `, we paid ${paid} gold` : ''}.`, 'good'); afterLocalChange();
  } else if (c.op === 'accept') {   // they took what our caravan carried
    const kind = c.kind ?? 0, gift = (kind & GIFT) !== 0, was = gift && w.is_awaiting(kind, c.x ?? 0, their);
    const got = w.settle(kind, c.x ?? 0, their);
    if (was) { commit({ op: 'settle', kind: c.kind, x: c.x, idx: their }); ui.toast(`${r.name} accepted your gift.`, 'good'); updateHud(); }
    else if (got > 0) { commit({ op: 'settle', kind: c.kind, x: c.x, idx: their }); ui.toast(`${r.name} paid ${got} gold for the goods.`, 'good'); updateHud(); }
  } else if (c.op === 'turnback') {   // they turned our caravan back: the goods come home
    if (w.caravan_returned(c.kind ?? 0, c.x ?? 0, their)) { commit({ op: 'carhome', kind: c.kind, x: c.x, idx: their }); ui.toast(`${r.name} turned your caravan back. The goods are home again.`, 'bad'); updateHud(); }
  } else if (c.op === 'treaty' && (c.y ?? 1) !== 0) {   // an offer: we agree, and tell them with our own signed copy (without `to`, so it is not answered again)
    const what = c.kind === 2 ? 'an alliance' : c.kind === 1 ? 'peace' : 'a trade pact';
    if (w.treaty_acceptable(their, c.kind ?? 0) && w.treaty_set(their, c.kind ?? 0, c.x ?? 10)) { commit({ op: 'treaty', idx: their, kind: c.kind, x: c.x }); ui.toast(`${r.name} offers ${what} for ${c.x} days. Agreed.`, 'good'); }
    else { commit({ op: 'treaty', idx: their, kind: c.kind, y: 0, to: r.key }); ui.toast(`${r.name} offers ${what}, but we do not trust them enough. Refused.`, 'info'); }
  } else if (c.op === 'treaty' && c.y === 0) {   // they turned our offer down: it is void on our side too
    w.treaty_end(their, c.kind ?? 0); commit({ op: 'treaty', idx: their, kind: c.kind, y: 0 }); ui.toast(`${r.name} refused your offer.`, 'info'); afterLocalChange();
  } else if (c.op === 'arrive') {   // their errand reached us: an offer is answered, the rest is only news
    const kind = c.kind ?? 0;
    if (kind <= 2) answerOffer(r, kind, c.x ?? 10); else ui.toast(arrivedText(kind, r.name, 'you', false), kind === JK.WAR ? 'bad' : 'good');
  } else if (c.op === 'war') {
    ui.toast(`${r.name} has declared war on you!`, 'bad');
  }
}

/** How far the way to a village is: the length of the invisible path chained to its city (or the straight line while there is none). */
function roadTo(r: Rival): number {
  const p = lv.world.link_points(r.village.ox, r.village.oz); let d = 0;
  for (let k = 2; k < p.length; k += 2) d += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
  return Math.min(2900, d > 1 ? d : Math.hypot(r.village.ox - lv.ox, r.village.oz - lv.oz));
}
/** A neighbour answers an offer that has reached it: it agrees when it trusts us enough (and tells us with its own signed copy), otherwise the offer is void. */
function answerOffer(r: Rival, kind: number, days: number) {
  const w = lv.world, their = tagOf(r.key), what = kind === 2 ? 'an alliance' : kind === 1 ? 'peace' : 'a trade pact';
  if (w.treaty_acceptable(their, kind) && w.treaty_set(their, kind, days)) { commit({ op: 'treaty', idx: their, kind, x: days }); ui.toast(`${r.name} offers ${what} for ${days} days. Agreed.`, 'good'); }
  else { commit({ op: 'treaty', idx: their, kind, y: 0, to: r.key }); ui.toast(`${r.name} offers ${what}, but we do not trust them enough. Refused.`, 'info'); }
}

/** What the trade form in the peers pane asks for. Nothing happens at once: a caravan, an offer, an envoy, a wedding party or a herald sets out along the path to the other city and does its work on arrival. */
function doTrade(key: string, action: string, res: number, amount: number, escort: number): boolean {
  const r = rivals.get(key); if (!r) { ui.toast('That village is not in this world.', 'bad'); return false; }
  const gift = action === 'gift'; if (gift) { action = 'caravan'; res += GIFT; }
  if (action === 'caravan' && !r.online && !r.ai) { ui.toast('That village is not online right now: caravans need somebody to take the goods.', 'bad'); return false; }
  const w = lv.world, their = tagOf(key), dist = roadTo(r);
  if (action === 'caravan') {
    const code = w.caravan_send(res, amount, their, dist, escort);
    if (code !== 0) { ui.toast(code === -2 ? 'You do not have that much to send.' : code === -3 ? 'Not enough spearmen for the escort.' : code === -4 ? 'The embassy has all its caravans out: upgrade it to send more at once.' : code === -5 ? 'They loathe you too much to take a gift.' : 'Cannot send that.', 'bad'); return false; }
    commit({ op: 'caravan', kind: res, x: amount, idx: their, y: dist, ax: escort }); sound.click(); ui.toast(`A ${gift ? 'gift caravan' : 'caravan'} of ${amount} ${RES[res & ~GIFT].name.toLowerCase()} sets out for ${r.name}.`, 'good'); updateHud(); return true;
  }
  const kind = action === 'alliance' ? JK.ALLIANCE : action === 'peace' ? JK.PEACE : action === 'envoy' ? JK.ENVOY : action === 'marriage' ? JK.MARRIAGE : action === 'war' ? JK.WAR : JK.TRADE, days = kind <= 2 ? 30 : 0;
  const code = w.journey_start(kind, their, days, dist);
  if (code !== 0) {
    ui.toast(code === -8 ? 'The embassy has all its parties out: wait for one to arrive, or upgrade the embassy.' : code === -7 ? 'One of those is already on its way.' : code === -20 ? 'An envoy went recently: wait a few days.' : code === -21 ? 'They do not like you enough yet. Send envoys first.' : code === -6 ? (kind === JK.ENVOY ? 'An envoy costs 20 gold.' : 'A wedding costs 150 gold.') : code === -1 && kind === JK.MARRIAGE ? 'You are already married into that house.' : code === -22 ? (kind === 2 ? 'They will not ally with you yet: you need a trade pact and warm relations.' : kind === 0 ? 'They do not like you enough for a trade pact yet. Send an envoy.' : 'They will not make peace with you.') : 'Cannot send that now.', 'bad'); return false;
  }
  commit({ op: 'journey', kind, idx: their, x: days, y: dist }); sound.click(); updateHud();
  ui.toast(kind === JK.ENVOY ? `An envoy with gifts sets out for ${r.name}.` : kind === JK.MARRIAGE ? `A wedding party sets out for ${r.name}.` : kind === JK.WAR ? `A herald with your declaration of war rides for ${r.name}.` : `Envoys set out for ${r.name} to offer ${kind === 2 ? 'an alliance' : kind === 1 ? 'peace' : 'a trade pact'} for ${days} days.`, kind === JK.WAR ? 'bad' : 'info');
  return true;
}

/** Caravans that arrived: tell the village they were sent to, so it can take them and pay. */
function pollTrade() {
  const d = lv.world.take_delivered();
  for (let i = 0; i + 2 < d.length; i += 3) { for (const [key, rv] of rivals) if (tagOf(key) === d[i + 2]) { if (rv.ai) aiTakesGoods(rv, d[i], d[i + 1]); else commit({ op: 'goods', kind: d[i], x: d[i + 1], to: key }); break; } }
  // errands of ours that reached their village: the core did the deed on this very tick; now the village hears of it and answers
  const a = lv.world.take_arrivals(), now = Number(lv.world.tick());
  for (let i = 0; i + 3 < a.length; i += 4) {
    const kind = a[i], tag = a[i + 1], days = a[i + 2];
    if (now - a[i + 3] > 40) continue;   // (an old arrival from a history that was just replayed)
    const r = [...rivals.values()].find(x => tagOf(x.key) === tag); if (!r) continue;
    ui.toast(arrivedText(kind, 'you', r.name, true), kind === JK.WAR ? 'bad' : 'good'); updateHud();
    if (r.ai) aiAnswers(r, kind, days);
    else if (r.online) commit({ op: 'arrive', kind, x: days, to: r.key });
    else if (kind <= 2 && !r.village.world.treaty_acceptable(myTag(), kind)) { lv.world.treaty_end(tag, kind); commit({ op: 'treaty', idx: tag, kind, y: 0 }); ui.toast(`${r.name} turned the offer down.`, 'info'); }
  }
}

/** An army that has stopped beside an abbey, a ruin or a bandit camp goes in. */
function visitPlace(id: number) {
  const code = lv.world.visit_neutral(id);
  if (code === -2) { ui.toast('There is no place here to enter. March the army right up to an abbey, a ruin, a camp or a lair.', 'info'); return; }
  if (code === -3) { ui.toast('This place has already been used.', 'info'); return; }
  if (code === -4) { ui.toast('A fight is already on: finish it first.', 'info'); return; }
  if (code < 0) return;
  pendingArmyOrders.delete(id);
  commit({ op: 'visit', idx: id }); afterLocalChange(); updateDets();
  if (code === 3 || code === 4) return;   // a lair or the plague doctor's camp: the fight is on and the banner tells the story (the report says how it ended)
  ui.toast(code === 0 ? 'The monks heal your sick.' : code === 1 ? 'The ruin gives up its hoard.' : code === 2 ? 'The bandit camp is cleared and its coin is yours (stronger camps and bigger villages pay more).' : 'The camp was too strong: half your army fell. Try again with more men.', code >= 100 ? 'bad' : 'good');
}

// ---------- war between players ----------
function doTrain(kind: number, n: number) {
  const res = lv.world.train(kind, n);
  if (res !== 0) { ui.toast(PLACE_ERRORS[res] ?? 'Cannot train that', 'bad'); return; }
  commit({ op: 'train', kind, x: n }); sound.train(); ui.toast(`${n} × ${units[kind].name} queued at the barracks.`, 'good'); lv.afterTick(); updateHud();
}

function doUntrain(kind: number, n: number) {
  if (replay?.target === lv) return;
  const n2 = Math.min(n, lv.world.queued()[kind] ?? 0);
  if (n2 <= 0 || lv.world.train_cancel(kind, n2) !== 0) { ui.toast('Nothing of that kind is queued.', 'bad'); return; }
  commit({ op: 'untrain', kind, x: n2 }); ui.toast(`${n2} × ${units[kind].name} taken out of the queue and refunded.`, 'info'); lv.afterTick(); updateHud();
}

function doResearch(id: number) {
  if (replay?.target === lv) return;
  const code = lv.world.military_research(id);
  if (code !== 0) { ui.toast(code === -2 ? 'Upgrade your Barracks first.' : code === -3 ? 'Research Padded armor first.' : code === -6 ? 'Insufficient supplies.' : 'This upgrade is already equipped.', 'bad'); return; }
  void commit({ op: 'research', kind: id });
  ui.toast('Army upgrade equipped.', 'good'); updateHud();
}

/** Send a field army against a rival village: it halts just outside their border (on our side) and attacks once it gets there. */
async function marchOn(id: number, key: string, r: Rival): Promise<boolean> {
  const dx = lv.ox - r.village.ox, dz = lv.oz - r.village.oz, dl = Math.hypot(dx, dz) || 1, stand = r.village.radius + 12;
  const tx = r.village.ox + dx / dl * stand, tz = r.village.oz + dz / dl * stand;
  const ax = r.village.ox, az = r.village.oz;
  const res = await plannedArmyOrder(id, tx, tz, 2, ax, az, () => rivals.get(key) === r && !lv.world.battle_active());
  if (res === null) return false;
  if (res !== 0) { ui.toast(MARCH_ERRORS[res] ?? 'No route there.', 'bad'); return false; }
  attackTargets.set(id, key); commit({ op: 'march', idx: id, x: tx, y: tz, to: key, ax, ay: az });
  return true;
}

async function doAttack(key: string, u: number[]) {
  const r = rivals.get(key); if (!r) { ui.toast('That village is not in this world.', 'bad'); return; }
  if (!atWarWith(key)) { ui.toast(NOT_AT_WAR(r.name), 'bad'); return; }
  if (lv.world.battle_active()) { ui.toast('You cannot march while your own village is under attack.', 'bad'); return; }
  const id = lv.world.det_form(Uint32Array.from(u));
  if (!id) { ui.toast('You do not have that many soldiers in the barracks. To send an army you already have in the field, select it on the map first.', 'bad'); return; }
  commit({ op: 'form', units: u }); lv.afterTick(); selectDet(id); updateHud();
  if (await orderArmies([id], () => marchOn(id, key, r))) ui.toast(`Your army sets out for ${r.name}. It attacks when it arrives.`, 'good');
}

/** The armies you have selected march to an ally's village to help: when they arrive the ally is asked to let them in. */
async function doAssistSelected(key: string) {
  const r = rivals.get(key); if (!r || r.ai) { ui.toast('That village is not in this world.', 'bad'); return; }
  if (!isAlly(key)) { ui.toast(`You are not allied with ${r.name}.`, 'bad'); return; }
  if (!r.online) { ui.toast(`${r.name} is away: only a player who is here can let soldiers in.`, 'info'); return; }
  if (lv.world.battle_active()) { ui.toast('You cannot march while your own village is under attack.', 'bad'); return; }
  const ids = multiDets.length ? multiDets : selectedDet !== null ? [selectedDet] : [];
  if (!ids.length) { ui.toast('Select an army first.', 'info'); return; }
  const sent = await orderArmies(ids, id => marchOn(id, key, r));
  if (sent) ui.toast(sent > 1 ? `${sent} armies set out to help ${r.name}.` : `Your army sets out to help ${r.name}. ${r.name} is asked to let it in when it arrives.`, 'good');
}

/** An ally's soldiers have reached our village: let them in (they fight beside our defenders until they are sent home) or send them back. */
async function receiveAid(from: Rival, c: Cmd) {
  const soldiers = c.units ?? [], tag = tagOf(from.key), n = soldiers.reduce((a, b) => a + b, 0);
  const refuse = () => { void commit({ op: 'refuse', to: from.key, units: soldiers }); };
  if (!isAlly(from.key) || watch.away || replay?.target === lv) { refuse(); return; }
  const names = soldiers.map((k, i) => k > 0 ? `${k} ${(units[i]?.name ?? 'soldiers').toLowerCase()}` : '').filter(Boolean).join(', ');
  const yes = await Promise.race([ui.confirm(`${from.name} sends ${n} soldiers (${names}) to stand with your defenders. They eat from your stores and fight beside your soldiers whenever you are attacked, until you send them home.`, 'Let them in', `${from.name} offers help`, 'Send them back'), new Promise<boolean>(res => setTimeout(() => res(false), 90_000))]);
  if (yes && lv.world.host_guests(tag, Uint32Array.from(soldiers))) {
    void commit({ op: 'host', from: from.key, tag, units: soldiers });
    ui.toast(`${from.name}'s soldiers are in your village. They fight beside your defenders.`, 'good'); lv.afterTick(); updateHud(); return;
  }
  if (yes) ui.toast(`${from.name}'s soldiers cannot be taken in just now (too many guests, or the alliance has ended).`, 'info');
  refuse();
}

/** Send an ally's soldiers who are guests here home (`asked`: they asked to go). Those still in a fight stay until it is over. */
function sendGuestsHome(r: Rival, asked: boolean) {
  const tag = tagOf(r.key), back = Array.from(lv.world.release_guests(tag));
  if (back.reduce((a, b) => a + b, 0) > 0) { void commit({ op: 'unhost', to: r.key, tag, units: back }); ui.toast(`${r.name}'s soldiers are on their way home.`, 'info'); lv.afterTick(); updateHud(); }
  else if (!asked || lv.world.battle_active()) ui.toast(lv.world.battle_active() ? `${r.name}'s soldiers are fighting: they can leave when it is over.` : `${r.name} has no soldiers in your village.`, 'info');
}

/** Ask an ally for help: a message, nothing more (they decide what to send). */
function askForHelp(key: string) {
  const r = rivals.get(key); if (!r || !isAlly(key)) { ui.toast('Only an ally can be asked for help.', 'info'); return; }
  void commit({ op: 'ask', to: key, kind: 1 }); ui.toast(`You ask ${r.name} for help.`, 'good');
}

/** Ask an ally to send our soldiers, who are guests in their village, home. */
function recallAid(key: string) {
  const r = rivals.get(key); if (!r) return;
  void commit({ op: 'recallaid', to: key }); ui.toast(`You ask ${r.name} to send your soldiers home.`, 'info');
}

/** The armies you have selected march on the village. */
async function doAttackSelected(key: string) {
  const r = rivals.get(key); if (!r) { ui.toast('That village is not in this world.', 'bad'); return; }
  if (!atWarWith(key)) { ui.toast(NOT_AT_WAR(r.name), 'bad'); return; }
  if (lv.world.battle_active()) { ui.toast('You cannot march while your own village is under attack.', 'bad'); return; }
  const ids = multiDets.length ? multiDets : selectedDet !== null ? [selectedDet] : [];
  if (!ids.length) { ui.toast('Select an army first.', 'info'); return; }
  const sent = await orderArmies(ids, id => marchOn(id, key, r));
  if (sent) ui.toast(sent > 1 ? `${sent} armies set out for ${r.name}. They attack when they arrive.` : `Your army sets out for ${r.name}. It attacks when it arrives.`, 'good');
}

// ---------- field armies: muster, select, order ----------
const MARCH_ERRORS: Record<number, string> = { [-1]: 'That army no longer exists.', [-2]: 'There is no way through to there.', [-3]: 'Catapults need spearmen or swordsmen with them to cut a way through the forest.', [-5]: 'That water is too wide to cross.' };

function doMuster(u: number[], selectAllArmies = false) {
  const id = lv.world.det_form(Uint32Array.from(u));
  if (!id) { ui.toast('You do not have that many soldiers in the barracks.', 'bad'); return; }
  commit({ op: 'form', units: u }); lv.afterTick(); if (selectAllArmies) selectDets(lv.field.ids()); else selectDet(id); updateHud(); ui.toast(selectAllArmies ? 'Field army mustered. All field armies are selected.' : 'Field army mustered. Right-click the ground to send it somewhere.', 'good');
}

let multiDets: number[] = [];   // every selected army; selectedDet is the first
function selectDet(id: number | null) { selectDets(id === null ? [] : [id]); }
function selectDets(ids: number[]) {
  cancelMarchPreview();
  if (ids.length) { const guests = guestIds(); if (ids.some(id => guests.has(id))) { ids = ids.filter(id => !guests.has(id)); if (!ids.length) ui.toast('Soldiers sent by an ally are not yours to command: they fight beside your defenders by themselves. Send them home from the village list.', 'info'); } }
  multiDets = ids; selectedDet = ids[0] ?? null; lv.field.select(ids); ui.setSelectedArmies(ids.length);
  if (ids.length) { selectKind(null); selectBuilding(null); selectRuin(null); ui.setTab('army'); ui.hint(`${ids.length > 1 ? ids.length + ' armies' : 'Army ' + ids[0]} selected · right-click the ground to march · Shift+click adds or removes one · drag a box to select several · ${keyNames('haltArmy')} halt · ${keyNames('recallArmy')} send home · ${keyNames('cancel')} deselect`); }
  else if (selectedKind === null) ui.hint(null);
  showRoute(); updateDets();
}

/** Armies whose banner is inside the dragged rectangle (screen pixels). */
function boxSelect(x0: number, y0: number, x1: number, y1: number, add = false) {
  const a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(y0, y1), d = Math.max(y0, y1), v = new THREE.Vector3();
  const ids = lv.field.ids().filter(id => { const p = lv.field.position(id)!; v.set(p.x, terrain.heightAt(p.x, p.z) + 2, p.z).project(rig.cam); const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight; return v.z < 1 && sx >= a && sx <= b && sy >= c && sy <= d; });
  if (ids.length) { const all = add ? [...new Set([...multiDets, ...ids])] : ids; selectDets(all); ui.toast(all.length > 1 ? `${all.length} armies selected — right-click to march them all.` : 'Army selected.', 'info'); }
  else if (!add && multiDets.length) selectDets([]);   // a box round nothing lets go of the selection
}

/** Armies shown on the screen, with where. */
function armiesOnScreen() {
  const v = new THREE.Vector3(), out: { id: number; sx: number; sy: number }[] = [];
  for (const id of lv.field.ids()) { const p = lv.field.position(id); if (!p) continue; v.set(p.x, terrain.heightAt(p.x, p.z) + 1.5, p.z).project(rig.cam); if (v.z < 1) out.push({ id, sx: (v.x * 0.5 + 0.5) * innerWidth, sy: (-v.y * 0.5 + 0.5) * innerHeight }); }
  return out;
}
/** Troops and the banner select their army. A small screen-space margin also helps with distant banners. */
function pickArmy(e: { clientX: number; clientY: number }, r = pointerRay(e), ground?: THREE.Vector3 | null): number | null {
  const picker = new ArmyPicker(r.ray);
  const troops = settings().crowds && crowd.group.visible && !showroom;
  lv.field.pick(picker, troops);
  if (troops) lv.army.pick(picker);
  pickedPart = '';
  if (picker.hit) {
    const land = ground === undefined ? terrain.pick(r.ray) : ground;
    if (!land || r.ray.origin.distanceTo(land) + 0.2 >= picker.hit.distance) { pickedPart = picker.hit.part; return picker.hit.id; }
    return null;
  }
  return nearestWithin(armiesOnScreen(), e.clientX, e.clientY, 34)?.id ?? null;
}
let lastArmyClick = { t: 0, id: -1 };
let pickedPart = '';   // what pickArmy last hit of the army: 'tent' and 'trough' are the camp itself

const CAMP_UNITS = ['spearmen', 'archers', 'swordsmen', 'knights', 'catapults', 'rams'];
/** "8 spearmen, 4 archers": what is in an army (the siege engines are left out when `soldiersOnly`). */
function unitsText(units: number[], soldiersOnly = false) { return units.map((n, k) => n > 0 && (!soldiersOnly || k < 4) ? `${n} ${CAMP_UNITS[k]}` : '').filter(Boolean).join(', '); }
/** What a camp tells the player: how many troops are in it (of the whole army if some are still on the road), what kinds, and the engines beside it; null if the army has no camp up. */
function campText(id: number): string | null {
  const c = lv.field.campTroops(id), u = detUnits(id);
  if (!c || !u) return null;
  const kinds = unitsText(u, true), engines = unitsText(u.map((n, k) => k >= 4 ? n : 0));
  const head = c.here >= c.of ? `${c.of} troops in camp` : `${c.here} of ${c.of} troops in camp (the rest are on the way)`;
  return `${head}${kinds ? ` · ${kinds}` : ''}${engines ? ` · ${engines} parked outside` : ''}`;
}

/** Draw the selected army's remaining route. */
function showRoute() {
  if (selectedDet === null) { pathLine?.set(null); return; }
  const p = lv.world.det_path(selectedDet);
  pathLine?.set(p.length >= 6 ? Array.from(p) : null);
}

interface MarchPreview { id: number; world: World; revision: bigint; battleTick: bigint | null; request: MarchPreviewRequest }
interface ArmyRouteJob {
  world: World;
  request: Omit<ArmyRouteRequest, 'snapshot'>;
  current(): boolean;
  done(routes: Uint8Array | null): void;
}
let marchPreviewWorker: Worker | null = null;
let marchPreviewUnavailable = false;
let previewInFlight: MarchPreview | null = null, previewWanted: MarchPreview | null = null;
let previewWorld: World | null = null, previewRevision: bigint | null = null;
let previewBattleTick: bigint | null = null, previewShown: MarchPreview | null = null;
let armyRouteInFlight: ArmyRouteJob | null = null;
const armyRouteQueue: ArmyRouteJob[] = [];
const pendingArmyOrders = new Map<number, symbol>();

function cancelMarchPreview() {
  previewWanted = null;
  if (!previewShown) return;
  previewShown = null;
  showRoute();
  ui.hint(null);
}

function reinforcementPoint(x: number, z: number) {
  return lv.world.battle_active() && foeNear(lv.world.battle_units_flat(), x, z, 18);
}

function queueMarchPreview(id: number, x: number, z: number) {
  if (marchPreviewUnavailable) return;
  const world = lv.world, revision = world.march_revision();
  const reinforce = reinforcementPoint(x, z) ? id : undefined;
  const battleTick = reinforce === undefined ? null : world.tick();
  const previous = previewWanted ?? previewShown;
  if (previous?.id === id && previous.world === world && previous.revision === revision
      && previous.battleTick === battleTick && previous.request.reinforce === reinforce
      && Math.hypot(previous.request.to[0] - x, previous.request.to[1] - z) < 1) return;
  const units = detUnits(id), pos = lv.field.position(id);
  if (!units || !pos) return;
  previewWanted = { id, world, revision, battleTick, request: { seed: seedBig, units: Uint32Array.from(units), from: [pos.x, pos.z], to: [x, z], reinforce } };
  pumpMarchPreview();
}

function getMarchWorker() {
  if (!marchPreviewWorker) {
    marchPreviewWorker = new Worker(new URL('./march-planner.worker.ts', import.meta.url), { type: 'module' });
    marchPreviewWorker.onmessage = ({ data }: MessageEvent<Float32Array | Uint8Array | null>) => {
      if (armyRouteInFlight) {
        const finished = armyRouteInFlight;
        armyRouteInFlight = null;
        finished.done(data instanceof Uint8Array ? data : null);
        queueMicrotask(pumpMarchPreview);
        return;
      }
      const finished = previewInFlight;
      previewInFlight = null;
      if (!(data instanceof Float32Array)) { stopMarchPreviewWorker(); return; }
      if (finished && previewWanted === finished) {
        previewWanted = null;
        if (finished.id === selectedDet && lv.world === finished.world && selectedKind === null && !pendingBattleOrder) {
          if (finished.revision === finished.world.march_revision() && (finished.request.reinforce === undefined || lv.world.battle_active())) {
            previewShown = finished;
            drawMarchPreview(finished.request, data);
          }
          else queueMarchPreview(finished.id, ...finished.request.to);
        }
      }
      pumpMarchPreview();
    };
    marchPreviewWorker.onerror = stopMarchPreviewWorker;
  }
  return marchPreviewWorker;
}

function pumpMarchPreview() {
  if (armyRouteInFlight || previewInFlight || marchPreviewUnavailable) return;
  while (armyRouteQueue.length && !armyRouteQueue[0].current()) armyRouteQueue.shift()!.done(null);
  const order = armyRouteQueue.shift(), preview = previewWanted;
  if (!order && !preview) return;
  armyRouteInFlight = order ?? null;
  try {
    const worker = getMarchWorker();
    if (order) {
      const snapshot = order.world.snapshot();
      worker.postMessage({ ...order.request, snapshot }, [snapshot.buffer]);
      return;
    }
    if (!preview || selectedDet !== preview.id || lv.world !== preview.world || selectedKind !== null || pendingBattleOrder) { cancelMarchPreview(); return; }
    if (preview.revision !== preview.world.march_revision()) { cancelMarchPreview(); queueMarchPreview(preview.id, ...preview.request.to); return; }
    previewInFlight = preview;
    if (previewWorld !== preview.world || previewRevision !== preview.revision
        || (preview.battleTick !== null && preview.battleTick !== previewBattleTick)) {
      const snapshot = preview.world.snapshot();
      worker.postMessage({ ...preview.request, snapshot }, [snapshot.buffer]);
      previewWorld = preview.world;
      previewRevision = preview.revision;
      previewBattleTick = preview.battleTick;
    } else worker.postMessage(preview.request);
  } catch { stopMarchPreviewWorker(); }
}

function stopMarchPreviewWorker() {
  marchPreviewWorker?.terminate(); marchPreviewWorker = null;
  marchPreviewUnavailable = true; previewInFlight = previewWanted = null; previewWorld = null;
  cancelMarchPreview();
  armyRouteInFlight?.done(null); armyRouteInFlight = null;
  for (const order of armyRouteQueue.splice(0)) order.done(null);
}

function drawMarchPreview(request: MarchPreviewRequest, plan: Float32Array) {
  const [x, z] = request.from, [tx, tz] = request.to;
  const reinforce = request.reinforce !== undefined;
  if (plan[0] !== 1) {
    pathLine.set([x, z, 0, tx, tz, 0], false);
    ui.hint(plan[0] === -10 ? 'There is no fight to reinforce.' : (MARCH_ERRORS[plan[0]] ?? 'No way through to there.'), true);
    return;
  }
  const path = [x, z, 0, ...plan.subarray(5)];
  const stores = lv.world.stocks();
  const { costs, shortage } = crossingSummary(plan[2], plan[3], stores[1], stores[0]);
  pathLine.set(path, !shortage);
  const eta = reinforce && plan[1] === 0 ? 'Joins now' : `ETA ~${arrivalTime(plan[1], TICK_RATE)} at 1×`;
  const order = reinforce ? 'Right-click to reinforce' : 'Right-click to march';
  const bits = [multiDets.length > 1 ? `Army ${selectedDet} · ${order}` : order, eta, costs];
  if (shortage) bits.push(`${shortage} · may wait for supplies`);
  if (path.some((v, i) => i % 3 === 2 && v === 1)) bits.push('Fells trees');
  ui.hint(bits.join(' · '), !!shortage);
}

function updateDets() {
  const f = lv.world.det_flat(), list: { id: number; units: number[]; text: string; selected: boolean; leftWp: number }[] = [];
  for (let o = 0; o < f.length; o += 17) {
    const st = f[o + 8], state = STATE_TEXT[st] + (st === 3 || st === 2 ? ` (${Math.round(f[o + 11] * 100)}%)` : '');
    list.push({ id: f[o], units: [f[o + 3], f[o + 4], f[o + 5], f[o + 6], f[o + 7], f[o + 16]], text: state, selected: multiDets.includes(f[o]), leftWp: f[o + 10] });
  }
  ui.setDets(list);
  const picked = list.filter(d => d.selected);
  if (picked.length && !lv.world.battle_active()) {
    const units = [0, 0, 0, 0, 0, 0]; for (const d of picked) d.units.forEach((n, k) => { units[k] += n; });
    commandScreen().setSelection({ title: picked.length > 1 ? `${picked.length} armies` : `Army ${picked[0].id}`, units, state: picked.length > 1 ? '' : picked[0].text, armies: picked.length },
      act => { const ids = multiDets.slice(); if (act === 'recall') void orderArmies(ids, orderRecall); else ids.forEach(id => detAction(act, id)); });
  } else cmdScreen?.setSelection(null, () => {});
  if (multiDets.some(id => !list.some(d => d.id === id))) { multiDets = multiDets.filter(id => list.some(d => d.id === id)); selectedDet = multiDets[0] ?? null; lv.field.select(multiDets); if (selectedDet === null) pathLine?.set(null); }
}

function detUnits(id: number): number[] | null {
  const f = lv.world.det_flat(); for (let o = 0; o < f.length; o += 17) if (f[o] === id) return [f[o + 3], f[o + 4], f[o + 5], f[o + 6], f[o + 7], f[o + 16]]; return null;
}

async function plannedArmyOrder(id: number, x: number, z: number, mode: ArmyRouteRequest['mode'], ax = 0, az = 0, valid = () => true): Promise<number | null> {
  const world = lv.world, token = Symbol();
  pendingArmyOrders.set(id, token);
  const current = () => lv.world === world && replay?.target !== lv && pendingArmyOrders.get(id) === token && valid();
  try {
    if (!current()) return null;
    for (let attempt = 0; attempt < 2 && !marchPreviewUnavailable; attempt++) {
      const routes = await new Promise<Uint8Array | null>(done => {
        armyRouteQueue.push({ world, request: { id, x, z, mode, seed: seedBig }, current, done });
        pumpMarchPreview();
      });
      if (!current()) return null;
      if (!routes) break;
      const code = world.apply_prepared_army_order(routes, id, x, z, mode, ax, az);
      if (code !== -11) return code;
    }
    if (mode === 1) return world.det_defend(id);
    if (mode === 3) return world.det_recall(id);
    return world.det_march(id, x, z, mode === 2, ax, az);
  } finally {
    if (pendingArmyOrders.get(id) === token) pendingArmyOrders.delete(id);
  }
}

async function orderArmies(ids: number[], order: (id: number, index: number) => Promise<boolean>) {
  if (!ids.length) return 0;
  cancelMarchPreview();
  const world = lv.world;
  const status = window.setTimeout(() => ui.toast(ids.length === 1 ? 'Planning the march…' : 'Planning the marches…', 'info'), 350);
  try {
    const sent = (await Promise.all(ids.map(order))).filter(Boolean).length;
    if (sent && lv.world === world) { lv.afterTick(); showRoute(); updateDets(); updateHud(); }
    return sent;
  } finally { clearTimeout(status); }
}

async function orderMarch(id: number, tx: number, tz: number) {
  const r = await plannedArmyOrder(id, tx, tz, 0);
  if (r === null) return false;
  if (r !== 0) { ui.toast(MARCH_ERRORS[r] ?? 'No route there.', 'bad'); sound.error(); return false; }
  attackTargets.delete(id); commit({ op: 'march', idx: id, x: tx, y: tz }); sound.click(); fx.burst(tx, tz, false);
  return true;
}

function detAction(a: string, id: number) {
  const w = lv.world, u = detUnits(id); if (!u) return;
  if (a === 'select') { selectDet(selectedDet === id && multiDets.length === 1 ? null : id); return; }
  pendingArmyOrders.delete(id);
  if (a === 'halt') { w.det_halt(id); attackTargets.delete(id); commit({ op: 'halt', idx: id }); }
  else if (a === 'recall') { void orderArmies([id], orderRecall); return; }
  else if (a === 'split') {
    if (u.reduce((s, n) => s + n, 0) < 2) { ui.toast('This army is too small to split.', 'info'); return; }
    ui.openSplit(u, take => {
      const world = lv.world;
      if (world !== w || !detUnits(id)) return true;
      const nid = world.det_split(id, Uint32Array.from(take)); if (!nid) { ui.toast('This army cannot be split like that.', 'bad'); return false; }
      commit({ op: 'split', idx: id, units: take }); ui.toast('The army split in two. Select either half and give it its own orders.', 'good');
      lv.afterTick(); showRoute(); updateDets(); updateHud();
      return true;
    });
    return;
  } else if (a === 'merge') {
    const pos = lv.field.position(id); let best = 0, bd = 12;
    if (pos) for (const o of lv.field.ids()) { if (o === id) continue; const p = lv.field.position(o)!; const d = Math.hypot(p.x - pos.x, p.z - pos.z); if (d < bd) { bd = d; best = o; } }
    if (!best || !w.det_merge(id, best)) { ui.toast('No other army close enough to merge with.', 'info'); return; }
    pendingArmyOrders.delete(best);
    commit({ op: 'merge', idx: id, kind: best });
  }
  lv.afterTick(); showRoute(); updateDets(); updateHud();
}

async function orderRecall(id: number) {
  const code = await plannedArmyOrder(id, 0, 0, 3);
  if (code === null) return false;
  if (code !== 0) { ui.toast(MARCH_ERRORS[code] ?? 'No route home.', 'bad'); return false; }
  attackTargets.delete(id); commit({ op: 'recall', idx: id }); ui.toast('The army is marching home.', 'info');
  return true;
}

/** Marching armies that have reached an enemy village go in. */
function checkArrivals() {
  const f = lv.world.det_flat();
  for (let o = 0; o < f.length; o += 17) {
    if (f[o + 8] !== 5) continue;
    const id = f[o], key = attackTargets.get(id), r = key ? rivals.get(key) : null;
    if (pendingArmyOrders.has(id)) continue;
    if (!key || !r) { lv.world.det_halt(id); commit({ op: 'halt', idx: id }); attackTargets.delete(id); ui.toast('The village you marched on is no longer in this world.', 'info'); continue; }
    const u = detUnits(id)!, sent = lv.world.det_send(id);
    if (sent.length && isAlly(key)) {   // an army that marched to an ally comes to help, not to attack: the ally decides whether to let it in (see receiveAid)
      attackTargets.delete(id);
      if (!r.online || r.ai) { returnRefusedArmy(u); ui.toast(`${r.name} is away and cannot take your soldiers in. They come home.`, 'info'); continue; }
      commit({ op: 'sendaid', idx: id, to: key, units: u }); ui.toast(`Your soldiers reach ${r.name} and wait to be let in.`, 'good');
    } else if (sent.length) {
      attackTargets.delete(id); commit({ op: 'sendatk', idx: id, to: key, units: u });
      if (r.online) ui.toast(`Your army attacks ${r.name}!`, 'good');
      else attackAway(r, u);
    }
  }
}

/** Villages whose owner has left but whose village stays in the world are fought over here, on our copy of it: the fight is against their towers, walls and soldiers as they stood
 *  when they left. The battle runs a tick at a time (see `stepLocal`), and the report that ends it brings our survivors home with the loot, as with an online defender. */
const awayFights = new Set<string>();
function returnRefusedArmy(units: number[]) {
  if (units.length > 6 || units.some(n => n < 0) || !units.some(n => n > 0)) return false;
  lv.world.return_refused_army(Uint32Array.from(units));
  void commit({ op: 'return', kind: 1, units });
  updateHud();
  return true;
}

function attackAway(r: Rival, u: number[]) {
  const angle = Math.atan2(lv.oz - r.village.oz, lv.ox - r.village.ox);
  const tech = lv.world.military_tech();
  if (r.village.world.start_raid_equipped(angle, Uint32Array.from(u), myTag(), tech)) { if (!r.ai) { awayFights.add(r.key); r.forked = true; r.sync = 'under your attack'; } r.village.afterTick(); ui.toast(r.ai ? `Your army attacks ${r.name}'s village and its defences!` : `${r.name} is away. Your army attacks their village and its defences!`, 'good'); }
  else if (r.village.world.battle_active() && r.village.world.battle_tag() === myTag() && r.village.world.battle_reinforce_equipped(myTag(), Uint32Array.from(u), tech)) { if (!r.ai) { awayFights.add(r.key); r.forked = true; r.sync = 'under your attack'; } r.village.afterTick(); ui.toast(`More of your soldiers join the fight at ${r.name}'s village.`, 'good'); }
  else { returnRefusedArmy(u); ui.toast(`${r.name}'s village cannot be attacked just now. Your army comes home.`, 'info'); }
}

/** A rival sent soldiers against us: start the fight in our own (authoritative) village. */
function defendAgainst(att: Rival, c: Cmd): 'raid' | 'reinforce' | 'refuse' {
  const u = c.units ?? [], angle = Math.atan2(att.village.oz - lv.oz, att.village.ox - lv.ox), tag = tagOf(att.key), tech = att.village.world.military_tech();
  watch.observe(performance.now(), document.hidden);
  if (!watch.away && lv.world.start_raid_equipped(angle, Uint32Array.from(u), tag, tech)) { commit({ op: 'raid', from: att.key, units: u, angle, tag, tech }); ui.toast(`${att.name} attacks your village!`, 'bad'); lv.afterTick(); return 'raid'; }
  else if (lv.world.battle_active() && lv.world.battle_tag() === tag && lv.world.battle_reinforce_equipped(tag, Uint32Array.from(u), tech)) { commit({ op: 'reinforce', from: att.key, units: u, tag, tech }); ui.toast(`${att.name} sends more soldiers into the fight!`, 'bad'); lv.afterTick(); return 'reinforce'; }
  commit({ op: 'refuse', to: att.key, units: u });
  return 'refuse';
}

/** A battle finished in a rival's village. If we were the attacker, our survivors come home with the loot. */
function onRivalReport(key: string, rep: number[]) {
  if (rep[2]) ledger.record(rep[2], rep.slice(6, 12), rep.slice(12, 12 + RES.length));
  const [, won, tag, left, , , , ] = rep;
  void won; void left;
  if (tag !== myTag()) return;
  const surv = rep.slice(6, 12), loot = rep.slice(12, 12 + RES.length), r = rivals.get(key);
  lv.world.return_army(Uint32Array.from(surv), Int32Array.from(loot));
  commit({ op: 'return', units: surv, loot });
  const gold = loot[8];
  ui.toast(rep[1] ? `Your army was destroyed at ${r?.name ?? 'the enemy village'}.` : `Victory! Your army returns from ${r?.name ?? 'battle'} with ${gold} gold and other spoils.`, rep[1] ? 'bad' : 'good');
  updateHud();
}

function onLocalReport(rep: number[]) {
  if (rep[2]) ledger.record(rep[2], rep.slice(6, 12), rep.slice(12, 12 + RES.length));
  aiReport(rep);
  if (lv.world.last_report_bought()) return;   // paid off: the purchase was reported when it happened (see EV_BRIBED), nothing was won or lost
  const [, won, tag, , dead, lost] = rep;
  const br = reportBoss(rep);
  if (br) { const line = reportLine(bosses, br, !!won), good = br.fell || (won && !br.lair); ui.log(line, good ? 'good' : 'bad', Number(lv.world.tick())); ui.toast(line, good ? 'good' : 'bad'); if (br.lair) { updateHud(); return; } }
  const who = tag === 0 ? 'The bandits' : 'The invaders';
  ui.log(won ? `${who} were driven off. ${dead} defenders fell.` : `${who} plundered the village. ${lost} buildings were lost.`, won ? 'good' : 'bad', Number(lv.world.tick()));
  if (tag !== 0 && !won) ui.toast('Your village was sacked!', 'bad');
}

/** Villages whose owner left stay in the world, but only one village can stand on a site: when somebody (the same player under a new key, or a newcomer) settles where an away village
 *  is, or two away villages share a site, the old copies are dropped and the one that is lived in (or the most built) stays. */
function pruneGhosts() {
  const bySite = new Map<number, Rival[]>();
  for (const r of rivals.values()) { const l = bySite.get(r.site); if (l) l.push(r); else bySite.set(r.site, [r]); }
  for (const list of bySite.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => Number(b.online) - Number(a.online) || b.village.world.building_count() - a.village.world.building_count() || b.tick - a.tick);
    for (const r of list.slice(1)) {
      if (r.online) continue;   // never drop somebody who is here
      r.village.dispose(); rivals.delete(r.key); villagesChanged(); awayFights.delete(r.key); room?.forget(r.key);
      for (const [peer, key] of [...byPeer]) if (key === r.key) byPeer.delete(peer);
    }
  }
}

/** A new neighbour: an invisible path is chained from the edge of our city to theirs, which armies then march along (the core works it out from our own paths and the land between). */
function chainTo(r: Rival) {
  const x = r.village.ox, z = r.village.oz;
  if (lv.world.link_exists(x, z)) return;
  if (lv.world.link_village(x, z) === 0) commit({ op: 'link', x, y: z });
}

function updatePeers() {
  pruneGhosts();
  const compass = (dx: number, dz: number) => ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'][((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8];
  const rows = [...rivals.values()].map(r => {
    const dx = r.village.ox - lv.ox, dz = r.village.oz - lv.oz, dist = Math.hypot(dx, dz);
    return { dist, row: { key: r.key, name: r.name + (r.online ? '' : r.ai ? ' (computer)' : ' (away)'), where: `${compass(dx, dz)} ${Math.round(dist / 10) * 10}`, pop: r.village.world.population(), buildings: r.village.world.building_count(), sync: r.sync + (r.online && r.link && r.link !== 'good' ? ' · connection unstable' : r.online && r.ping != null ? ` · ${r.ping} ms` : ''), busy: r.village.world.battle_active(), online: r.online, ...relOf(r.key) } };
  });
  rows.sort((a, b) => Number(b.row.online) - Number(a.row.online) || a.dist - b.dist);   // villages with somebody at home first, then by distance
  ui.setPeers(rows.map(x => x.row), worldName);
  if (lv.view.setForeignFlags(foreignFlags().map(x => x.flag))) lv.syncFull();   // (the embassies were taken down to be drawn with the new flags: draw them now)
}
/** A computer city has no flag of its own design: it flies one made from its name, the same on every screen and in every session. */
const computerFlags = new Map<string, Flag>();
function computerFlag(key: string): Flag {
  let f = computerFlags.get(key);
  if (!f) { let h = 2166136261; for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; f = randomFlag(() => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; }); computerFlags.set(key, f); }
  return f;
}
/** The flags of the other cities, nearest first (their villages' own flags: the embassy flies them). */
function foreignFlags(): { name: string; flag: Flag }[] {
  const out: { name: string; flag: Flag; dist: number }[] = [];
  for (const r of rivals.values()) { const flag = unpackFlag(r.village.world.style()) ?? (r.ai ? computerFlag(r.key) : null); if (flag) out.push({ name: r.name, flag, dist: Math.hypot(r.village.ox - lv.ox, r.village.oz - lv.oz) }); }
  return out.sort((a, b) => a.dist - b.dist);
}


// ---------- replay and spectating ----------
interface ReplaySession { r: Replay<Cmd>; target: Village; key: string; playing: boolean; rate: number; goal: number; bar: ReplayBar; label: string }
let replay: ReplaySession | null = null;

/** Show a world on a village's screen representation, the way a loaded history is shown. */
function showWorld(v: Village, w: World, resetTerrain = false) {
  v.setWorld(w);
  if (resetTerrain) { terrain.resetPads(); for (const x of allVillages()) if (x !== v) refreshTerrain(x.world); }
  refreshTerrain(w); v.syncFull(); v.markCaughtUp(); v.afterTick(); v.markCaughtUp(); forestDirtyFlag = true; rebuildForest();
}

/** Watch a history: your own (key '') or another player's, as we hold it. */
function startReplay(key: string) {
  if (replay) return;
  const own = key === '', r = own ? null : rivals.get(key);
  if (!own && !r) return;
  if (r?.ai) { ui.toast(`${r.name}'s village is run by the computer: there is no history to replay.`, 'info'); return; }
  if (own && [...rivals.values()].some(x => x.online)) { ui.toast("To replay your own history you need to be alone in the world: your village is paused while you watch. You can watch another player's history at any time.", 'info'); return; }
  const cmds: Cmd[] = own ? validSavedLog(myLog).map(x => x.cmd) : r!.log.slice();
  if (!cmds.length) { ui.toast('There is no history to watch yet.', 'info'); return; }
  const target = own ? lv : r!.village, o = siteOrigin(own ? mySite : r!.site);
  const src = { make: () => World.new_legacy(seedBig, o.x, o.z), apply: applyCmd, cmds };
  const end = own ? Number(lv.world.tick()) : r!.tick;
  const rp = new Replay<Cmd>(src, end);
  rp.onWorld = w => showWorld(target, w, true);
  const label = own ? 'Your village' : r!.name;
  const sess: ReplaySession = { r: rp, target, key, playing: true, rate: 120, goal: 0, label, bar: null as unknown as ReplayBar };
  sess.bar = showReplayBar(label, rp.end, {
    toggle: () => { if (sess.goal >= rp.end) sess.goal = 0; sess.playing = !sess.playing; },
    seek: t => { sess.goal = t; sess.playing = false; },
    rate: v => { sess.rate = v; },
    exit: () => stopReplay(),
  });
  replay = sess; selectBuilding(null); showWorld(target, rp.world, true);
  ui.toast(own ? 'Replaying your village from the first day. Your village is paused; leave the replay to carry on.' : `Watching ${label}'s history. Your own village keeps running.`, 'info');
}

function stopReplay() {
  const s = replay; if (!s) return; replay = null; s.bar.remove();
  // rebuild the live village from its whole history, exactly as loading a save does
  const own = s.key === '', r = own ? null : rivals.get(s.key);
  const o = siteOrigin(own ? mySite : r?.site ?? mySite);
  const cmds: Cmd[] = own ? validSavedLog(myLog).map(x => x.cmd) : (r?.log ?? []);
  const to = own ? s.r.end : r?.tick ?? 0;
  const live = new Replay<Cmd>({ make: () => World.new_legacy(seedBig, o.x, o.z), apply: applyCmd, cmds }, to);
  live.advanceTo(to);
  showWorld(s.target, live.world, true);
  if (r) { r.track.reset(cmds.map(c => c.op)); r.forked = false; }
  if (own) acc = 0;
  ui.toast('Back in the game.', 'good'); updateHud(); updatePeers();
}

function tickReplay(dt: number) {
  const s = replay!;
  if (s.playing) { s.goal = Math.min(s.r.end, s.goal + s.rate * dt); if (s.goal >= s.r.end) s.playing = false; }
  const out = s.r.advanceTo(s.goal, 10);
  if (out.applied) { refreshTerrain(s.r.world); s.target.syncFull(); }
  s.target.afterTick();
  s.bar.update(s.r.tick, s.r.end, s.playing);
}

/** Running as a Home Screen app on iPhone or iPad (`navigator.standalone` exists only there). Elsewhere an installed app shares the browser's storage. */
const isInstalledApp = () => (navigator as unknown as { standalone?: boolean }).standalone === true;

// ---------- start ----------
async function startGame(name: string, username: string, pve = false) {
  const openedAt = Date.now();
  ui.setMilitaryUpgrades(JSON.parse(military_upgrades()));
  if (started) return; started = true; pveMode = pve; computerVillages = true;
  worldName = cleanWorld(name); seedBig = hashSeed(worldName); history.replaceState(null, '', withWorld(location.href, worldName)); myName = cleanName(username);
  try { localStorage.setItem('flanders:name', myName); } catch { /* ignore */ }
  ui.setOwner(myName);
  sound.start(); ui.setMuteIcon(sound.muted);
  ui.beginLoading(); await nextFrame();
  identity = await Identity.load(slot);
  const flat = village_sites(seedBig); sites = [];
  for (let i = 0; i < flat.length; i += 2) sites.push({ x: flat[i], z: flat[i + 1] });
  sites.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));

  // no real graphics card (the browser draws on the CPU): start on the low preset, without antialiasing, unless the player has chosen settings of their own
  const gpuName = rendererName(), softwareGpu = isSoftwareRenderer(gpuName); softwareRendering = softwareGpu;
  const autoLow = softwareGpu && !playerChoseSettings();
  if (autoLow) setSettings({ quality: 'low', antialias: false }, false);   // for this visit only: not saved as the player's choice
  // graphics built into the processor start on Medium (shorter tree distance, smaller shadows, no rich near trees), also for this visit only
  else if (isIntegratedGpu(gpuName) && !playerChoseSettings()) setSettings({ quality: 'medium' }, false);
  // a phone or tablet: fewer pixels, no multisampling, a frame rate limit (see device.ts); the player's own settings still win
  const touch = touchDefaults(deviceClass());
  if (touch && !softwareGpu && !playerChoseSettings()) { const { quality, ...rest } = touch; setSettings({ quality }, false); setSettings(rest, false); }   // two steps: a preset would overwrite the pixel cap
  renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: wantAntialias(devicePixelRatio), powerPreference: 'high-performance' });
  if (softwareGpu) ui.toast(!autoLow ?'No graphics card is drawing the game (the browser draws it on the processor): the Low display preset runs much faster.' : 'No graphics card is drawing the game, so it starts on Low display settings. Change them under Settings.', 'info');
  renderer.setPixelRatio(pixelRatio(devicePixelRatio, 1)); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;   // Atmosphere schedules shadow redraws
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.72;
  scene = new THREE.Scene(); scene.matrixAutoUpdate = false;   // the scene itself never moves: with its matrix 'dirty' every frame, every object below was re-multiplied every frame
  ui.progress(10, 'Painting the sky…'); await nextFrame();
  atmo = new Atmosphere(scene, renderer);
  ui.progress(22, 'Raising the mountains…'); await nextFrame();
  // the core's heights and trees are the heavy part of the ground and the forest: fetched a few rows at a time so the page keeps painting
  const land = await collectInSlices(NV, (a, b) => terrain_land_rows(seedBig, -HALF, -HALF, NV, STEP, a, b), 4, { onProgress: f => ui.progress(22 + Math.round(f * 8), 'Raising the mountains…') });
  terrain = new Terrain(seedBig, land);
  scene.add(terrain.mesh, terrain.water, terrain.riverWater);
  tunnels = new Tunnels(terrain, tunnels_flat(seedBig)); scene.add(tunnels.group);
  rig = new CameraRig(ui.canvas, terrain, e => touchPreviewHit(e) || (selectedKind !== null && !!PEN_SPACING[selectedKind] && penShape !== 'path'));
  ui.progress(38, 'Planting the forests…'); await nextFrame();
  const treeRows = trees_in_row_count(-HALF, HALF);
  const treeData = await collectInSlices(treeRows, (a, b) => trees_in_rows(seedBig, -HALF, -HALF, HALF, a, b), 4, { onProgress: f => ui.progress(38 + Math.round(f * 8), 'Planting the forests…') });
  forest = new Forest(seedBig, terrain, treeData); scene.add(forest.group);
  ui.progress(50, 'Waking the animals…'); await nextFrame();
  wildlife = new Wildlife(seedBig, terrain, forest.all, Array.from(village_sites(seedBig))); scene.add(wildlife.group);
  crowd = new Crowd(); scene.add(crowd.group);
  travellers = new Travellers(terrain); scene.add(travellers.group);
  // phones and tablets: the moving crowds cast no shadows, and the shadow map follows the remaining movers less often (see device.ts `touchLimits`)
  const limits = touchLimits(deviceClass());
  if (!limits.crowdShadows) { for (const g of [crowd.group, wildlife.group, travellers.group]) g.traverse((o: THREE.Object3D) => { o.castShadow = false; }); atmo.shadowActorScale = 2; }
  fx = new Effects2(terrain); scene.add(fx.group, fx.light); addLampLights();
  effects = new Effects(); scene.add(effects.group);
  covInit(); selRing = new SelectionMark(terrain); growRing = new SelectionMark(terrain, 0x9dffb0); scene.add(selRing, growRing, borderRing);
  for (let i = 0; i < 8; i++) { const r = new SelectionMark(terrain, 0xff6a5a); blockRings.push(r); scene.add(r); }
  pathLine = new PathLine(terrain); scene.add(pathLine.mesh);
  penPreview = new PenPreview(terrain); scene.add(...penPreview.objects);
  worldShips = new WorldShips(terrain); scene.add(worldShips.group);
  // containers that never move: computed once instead of every frame (see render/static.ts)
  freeze(tunnels.group, wildlife.group, crowd.group, travellers.group, fx.group, effects.group, worldShips.group);
  minimap = new Minimap(ui.minimap, terrain); bigMap = new Minimap(ui.bigmap, terrain, 900); minimap.tunnels = bigMap.tunnels = tunnels.list;
  ghostRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 56).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  ghostRing.visible = false; ghostRing.renderOrder = 9; scene.add(ghostRing);
  // the level-ground tool's preview: a flat disc at the height the patch would be levelled to, blue where earth is added and orange where it is cut away
  levelDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 56).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5fb3ff, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  levelDisc.visible = false; levelDisc.renderOrder = 8; scene.add(levelDisc);
  builderRangeRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8fd6ff, transparent: true, opacity: 0.58, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  builderRangeRing.visible = false; builderRangeRing.renderOrder = 8; scene.add(builderRangeRing);
  anchorGhost = new AnchorGhost(terrain); scene.add(anchorGhost.group);

  shared = {
    scene, terrain, wildlife, fx, radii, forest,
    terrainChanged: v => { refreshTerrain(v.world); },
    forestDirty: () => { forestDirtyFlag = true; },
    crowdShadows: limits.crowdShadows,
  };

  ui.progress(50, 'Mapping the roads…'); await nextFrame();
  // The army navigation grid (a few seconds of work) is needed by the first road link or field army, and so by the first command a history replays: build it first,
  // a slice at a time so the page keeps painting. (Left to the first command, it froze the whole page for seconds and Chrome offered to kill the tab.)
  try { getMarchWorker().postMessage({ warm: seedBig }); } catch { stopMarchPreviewWorker(); }
  await warmNavigationInSlices(warm_navigation_step, seedBig, { onProgress: f => ui.progress(50 + Math.round(f * 9), 'Mapping the roads…') });
  ui.progress(60, 'Gathering your villagers…'); await nextFrame();
  // your village: restore from the last visit, or found a new one
  let saved: { site: number; name: string; log: Signed[]; savedAt: number; tick: number; steward?: StewardMode; paused?: boolean; v?: number; rules?: string; epoch?: number; restartedAt?: number | null } | null = null;
  try { saved = JSON.parse(localStorage.getItem(saveKey()) ?? 'null'); } catch { /* ignore */ }
  mySite = saved && saved.site < sites.length ? saved.site : 0;
  try { myRules = rules_fingerprint(seedBig); ui.setRules(myRules); } catch { /* without a fingerprint other players cannot tell our build */ }
  const o = siteOrigin(mySite);
  let w = World.new_legacy(seedBig, o.x, o.z);
  if (saved) {
    const entries = validSavedLog(saved.log);
    for (const s of entries) { myLog.push(s.signed); cmdN = Math.max(cmdN, s.cmd.n + 1); }
    myEpoch = entries.length ? entries[0].cmd.e ?? 0 : 0; lastRestartAt = typeof saved.restartedAt === 'number' ? saved.restartedAt : null;
    sharedCount = countShared(entries);
    // Reproduce the village at its last saved tick. Wall-clock time is never owed to the simulation.
    const prog = (f: number) => ui.progress(60 + Math.round(f * 8), `Gathering your villagers… ${Math.round(f * 100)}%`);
    // a checkpoint of the world (if it belongs to this very history) saves replaying most of it
    let from = 0; const cp = await loadCheckpoint(checkpointKey());
    const restored = cp && cp.meta.tick <= saved.tick ? resumeFromCheckpoint(cp, { rules: myRules, v: SYNC_PROTOCOL, site: mySite, epoch: myEpoch }, entries.map(e => ({ cmd: e.signed.cmd, tick: e.cmd.tick })), world_restore) : null;
    if (restored && cp) { w.free(); w = restored; from = cp.meta.cmds; console.info(`Resumed from a checkpoint at tick ${cp.meta.tick} (${from} of ${entries.length} commands already in it).`); }
    else if (cp) { console.info('The saved checkpoint does not belong to this history or is damaged: replaying the whole history.'); void deleteCheckpoint(checkpointKey()); }
    const rep = await replayInSlices(w, entries.slice(from).map(e => e.cmd), applyCmd, saved.tick, { onProgress: prog });
    const slow = Object.entries(rep.timing.byOp).sort((p, q) => q[1].ms - p[1].ms).slice(0, 4).map(([op, v]) => `${op} ×${v.n}: ${Math.round(v.ms)} ms`).join(', ');
    console.info(`Replayed your history: ${rep.timing.commands} commands and ${rep.timing.ticks} ticks in ${Math.round(rep.timing.totalMs)} ms (ticks alone ${Math.round(rep.timing.stepMs)} ms; slowest commands: ${slow || 'none'}).`);
  }
  lv = new Village(w, 'me', myName, true, shared, 0x2f5fa8); lv.foeColor = foeColorOf; villagesChanged();
  if (saved?.paused === true) speed = 0;
  watch.mode = saved?.steward === 'steward' ? 'steward' : 'pause';
  if (!w.estate_active()) {
    w.set_reserves(0, 0);
    await commit({ op: 'reserve', x: 0, y: 0 });
  }
  lv.onReport = onLocalReport;
  Village.onBossFx = (k, x, z) => { if (Math.hypot(x - rig.target.x, z - rig.target.z) < 200) { if (k === 3) sound.warhorn(); else sound.slam(); } };   // a horn or a slam near the camera is heard
  deposits = new Deposits(w.deposits_flat(), terrain); scene.add(deposits.group); deposits.refit();
  camps = new Camps(terrain); scene.add(freeze(camps.group)); camps.sync(w.neutrals_flat());
  buildDepositLabels();
  refreshTerrain(w); lv.syncFull(); lv.markCaughtUp();
  const ev = w.take_events();
  for (let i = 0; i < ev.length; i += 4) { const e = EVENT_TEXT(ev[i], ev[i + 1], ev[i + 2]); ui.log(e.text, e.tone, ev[i + 3]); }
  rebuildForest(); updateHud();
  rig.focus(o.x, o.z, 75); rig.snap();
  await warmUp();
  PART_NAMES = state_hash_part_names().split(','); LEDGER_EXTRAS = ledger_extra_names().split(',');
  try { myRules = rules_fingerprint(seedBig); ui.setRules(myRules); } catch { /* without a fingerprint other players cannot tell our build */ }
  if (saved && (saved.v !== SYNC_PROTOCOL || saved.rules !== myRules)) console.info('This village was saved by an older build. Its history was restored before applying the current ration rules.');
  ui.setTab('build');
  ui.hint('Choose a building on the right, then click the ground. Start with houses and a farm.');
  setTimeout(() => ui.hint(null), 7000);
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); });
  bindInput();
  watch.openSave(performance.now(), saved ? openedAt - saved.savedAt : 0);
  startVillageWatch();
  if (computerVillages) await setupPve();
  if (!pveMode) connect();
  startUpdateWatch();
  setupPerf(); applySettings(settings()); onSettings(applySettings);
  const agentPort = Number(params.get('agent') ?? ''), agentToken = params.get('token') ?? '';
  if (Number.isInteger(agentPort) && agentPort >= 1024 && agentPort <= 65535 && /^[A-Za-z0-9_-]{8,128}$/.test(agentToken)) startAgentBridge({
    world: () => lv.world, commit: c => commit(c as Omit<Cmd, 'tick' | 'n'>), afterChange: () => { playerPresent(); afterLocalChange(); },
    toast: (m, k) => ui.toast(m, k ?? 'info'),
    rivals: () => [...rivals.entries()].map(([key, r]) => ({ key, name: r.name, x: r.village.ox, z: r.village.oz, online: r.online })),
    attack: (key, u) => { const r = rivals.get(key); if (!r || !r.online) return false; doAttack(key, u); return true; },
    relations: () => {
      const f = Array.from(lv.world.relations_flat()), rel = new Map<number, number[]>(); for (let i = 0; i + 3 < f.length; i += 4) rel.set(f[i], [f[i + 1], f[i + 2], f[i + 3]]);
      return [...rivals.entries()].map(([key, r]) => { const [v, m, bits] = rel.get(tagOf(key)) ?? [0, 0, 0]; return { key, name: r.name, relation: v, married: m === 1, trade: (bits & 1) !== 0, peace: (bits & 2) !== 0, alliance: (bits & 4) !== 0 }; });
    },
    diplomacy: (key, action, res, amount) => doTrade(key, action, res, amount, 0),
  }, agentPort, agentToken);
  setInterval(() => { save(); updatePeers(); checkpoint(); }, 8000);
  tutorial.begin(!saved); updateGoals();
  // A Home Screen app on iPhone and iPad keeps its own storage, apart from Safari's: a player who started in Safari finds an empty village here at first.
  if (!saved && isInstalledApp()) ui.toast('Playing from the Home Screen keeps its own save. To bring a village over from the browser, save a backup there and restore it here (Settings → Data & network).', 'info');
  if (hasSavedFlag() || !lv.world.style()) applyFlag(loadFlag());
  ui.enterGame();                       // everything is ready: reveal the game
  initMobileUi();
  if (watch.review && !document.hidden) ui.openSteward();
  renderWatch();
  battleBanner();
  if (DEBUG_HOOKS) (window as unknown as { __dbg: unknown }).__dbg = { get lv() { return lv; }, rig, get terrain() { return terrain; }, view: (x: number, z: number, dist: number, yaw: number, pitch: number) => { const g = (rig as unknown as { goal: Record<string, number> }).goal; Object.assign(g, { x, z, dist, yaw, pitch }); rig.snap(); }, cheat: (a: number, x: number, y: number) => (a === 100 ? runModelVillage(false) : doCheat(a, x, y)), select: (i: number | null) => selectBuilding(i), kind: (k: number | null) => selectKind(k), after: () => afterLocalChange(), get tunnels() { return tunnels; }, get renderer() { return renderer; }, get scene() { return scene; }, get perf() { return perf; }, audit: auditModel };
  last = performance.now(); startBackgroundClock(); requestAnimationFrame(frame);
}

/** Compile every shader and draw a few real frames (shadow map, textures, trees) behind the loading screen,
 *  so nothing pops in or stalls once the player sees the world. */
async function warmUp() {
  ui.progress(72, 'Compiling shaders…'); await nextFrame();
  fx.warm(true); effects.warm(true);
  // both versions of every shader: with the lamps and fire light (night, fires) and without them (day); see lightLamps()
  try { setPointLights(true); await renderer.compileAsync(scene, rig.cam); setPointLights(false); await renderer.compileAsync(scene, rig.cam); } catch { /* older drivers: the warm-up frames below compile instead */ }
  fx.warm(false); effects.warm(false);
  ui.progress(86, 'Baking shadows…'); await nextFrame();
  const view = Math.max(90, rig.dist * 1.7 + 50);
  for (let i = 0; i < 4; i++) {
    rig.update(0.016); rig.cam.updateMatrixWorld(true); atmo.follow(rig.target); forest.setLight(atmo.lightDirection, atmo.sun, atmo.hemi); forest.tick(0, rig.cam.position, rig.target, settings().shadows ? 135 : 0, rig.cam);
    crowd.begin(); lv.draw(crowd, rig.target.x, rig.target.z, view, rig.cam.position, Infinity); crowd.end();
    renderer.shadowMap.needsUpdate = true; renderer.render(scene, rig.cam);   // the first frames compile and fill the shadow map
    (renderer.getContext() as WebGL2RenderingContext).finish();
    ui.progress(86 + i * 3, i < 3 ? 'Baking shadows…' : 'Almost ready…'); await nextFrame();
  }
  ui.progress(100, 'Welcome.'); await nextFrame();
}

// ---------- scene sync ----------
let forestDirtyFlag = false;
function rebuildForest(later = false) {
  const all = [lv, ...[...rivals.values()].map(r => r.village)];
  const rocks: { x: number; z: number; r: number }[] = []; { const d = lv.world.deposits_flat(); for (let i = 0; i + 4 < d.length; i += 5) if (d[i + 4] > 0) rocks.push({ x: d[i + 1], z: d[i + 2], r: 5 }); }   // trees do not grow through ore and rock
  const clear = [...all.flatMap(v => v.clear), ...rocks], lines = all.flatMap(v => v.clearLines), keep = all.flatMap(v => v.keep);
  if (later) forest.rebuildLater(clear, lines, keep); else forest.rebuild(clear, lines, keep);
  forestDirtyFlag = false;
}

function allScorch() {
  const parts = [lv, ...[...rivals.values()].map(r => r.village)].map(v => v.world.scorch_flat()), n = parts.reduce((a, p) => a + p.length, 0), out = new Float32Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

// Remote terrain edits are refreshed in local tiles. Remember old tiles so demolition also restores the ground.
const remoteTerrainTiles = new WeakMap<World, Set<string>>();
const REMOTE_TILE = 32;

/** Re-level the ground of a whole village: pads, graded paths, craters and burn scars. */
/** How far from the hall the ground is read: the village's border, and the levelled ground of an embassy that stands near it, which reaches far past it. */
function terrainReach(w: World): number {
  const ox = w.origin_x(), oz = w.origin_y(), f = w.buildings_flat(); let reach = w.build_radius() + 12;
  for (let i = 0; i + 9 < f.length; i += 10) if (f[i] === 49) reach = Math.max(reach, Math.hypot(f[i + 2] - ox, f[i + 3] - oz) + (radii[49] ?? 24) * 1.15 + 5);
  return reach;
}
function refreshTerrain(w: World, box: [number, number, number, number] | null = null) {
  atmo.invalidateShadows();
  terrain.scorch = allScorch();
  const ox = w.origin_x(), oz = w.origin_y();
  const others = [...rivals.values()].map(r => ({ x: r.village.ox, z: r.village.oz })).concat(lv ? [{ x: lv.ox, z: lv.oz }] : []).filter(p => Math.hypot(p.x - ox, p.z - oz) > 1);
  if (box) terrain.refreshBox(w, box[0], box[1], box[2], box[3], ox, oz, others);
  else terrain.refresh(w, ox, oz, terrainReach(w), others);
  const city = w.build_radius() + 12, old = remoteTerrainTiles.get(w), remote = new Set<string>();
  const buildings = w.buildings_flat();
  for (let i = 0; i + 9 < buildings.length; i += 10) {
    const kind = buildings[i], x = buildings[i + 2], z = buildings[i + 3];
    if (kind !== 23 && kind !== 24 && kind !== 35 && kind !== 37 && kind !== 38) continue;
    const reach = kind === 38 ? 38 : kind === 23 ? 25 : 16;
    if (Math.max(Math.abs(x - ox), Math.abs(z - oz)) + reach <= city) continue;
    for (let ix = Math.floor((x - reach) / REMOTE_TILE); ix <= Math.floor((x + reach) / REMOTE_TILE); ix++) {
      for (let iz = Math.floor((z - reach) / REMOTE_TILE); iz <= Math.floor((z + reach) / REMOTE_TILE); iz++) remote.add(ix + ',' + iz);
    }
  }
  for (const key of new Set([...remote, ...(old ?? [])])) {
    const [ix, iz] = key.split(',').map(Number), x = ix * REMOTE_TILE, z = iz * REMOTE_TILE;
    terrain.refreshBox(w, x, z, x + REMOTE_TILE, z + REMOTE_TILE, ox, oz, others);
  }
  remoteTerrainTiles.set(w, remote);
  deposits?.refit();
}
/** The ground that changes when this building is put up or upgraded: the building and its levelled pad, and the paths that run to it. (Everything else is brought up to date a moment later: see `settleTerrain`.) */
function focusBox(idx: number): [number, number, number, number] | null {
  const w = lv.world, f = w.buildings_flat(), o = idx * 10; if (idx < 0 || o + 3 >= f.length) return null;
  const kind = f[o]; if (kind === 24 || kind === 32 || kind === 33 || kind === 34 || kind === 2 || kind === 21 || kind === 22) return null;   // earthworks and walls reshape more ground than that
  const r = (shared.radii[kind] ?? 4) * 1.4 + 10; let x0 = f[o + 2] - r, x1 = f[o + 2] + r, z0 = f[o + 3] - r, z1 = f[o + 3] + r;
  const rd = w.roads_flat();
  for (let i = 0; i + 5 < rd.length; i += 6) if (rd[i + 4] === idx || rd[i + 5] === idx) { x0 = Math.min(x0, rd[i] - 7, rd[i + 2] - 7); x1 = Math.max(x1, rd[i] + 7, rd[i + 2] + 7); z0 = Math.min(z0, rd[i + 1] - 7, rd[i + 3] - 7); z1 = Math.max(z1, rd[i + 1] + 7, rd[i + 3] + 7); }
  return [x0, z0, x1, z1];
}
/** After a local refresh, the rest of the village's ground is re-read in a few slices over the next moments (in case a path elsewhere was re-routed), not all in one frame. */
let settleTimer: number | undefined;
function settleTerrain() {
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    const w = lv.world, R = terrainReach(w), ox = w.origin_x(), oz = w.origin_y();
    for (let k = 0; k < 4; k++) window.setTimeout(() => { if (lv.world === w) refreshTerrain(w, [ox - R, oz - R + (2 * R * k) / 4, ox + R, oz - R + (2 * R * (k + 1)) / 4]); }, 70 * k);
  }, 1500);
}
function refreshAll() { refreshTerrain(lv.world); for (const r of rivals.values()) refreshTerrain(r.village.world); lv.syncFull(); for (const r of rivals.values()) r.village.syncFull(); }

function showVillageFlag() {
  const canvas = document.querySelector<HTMLCanvasElement>('#village-flag'); if (!canvas) return;
  const flag = unpackFlag(lv.world.style()) ?? loadFlag(), style = String(packFlag(flag));
  if (canvas.dataset.style === style) return;
  paintFlag(canvas, flag); canvas.dataset.style = style;
}
/** Fly this flag from now on: part of the village's state, so everyone sees it. */
function applyFlag(f: Flag) {
  const n = packFlag(f); if (lv.world.style() === n) return;
  if (lv.world.set_style(n)) { commit({ op: 'style', kind: n }); lv.syncFull(); }
}

function afterLocalChange(focus?: number) {
  const box = focus !== undefined ? focusBox(focus) : null;
  refreshTerrain(lv.world, box); if (box) settleTerrain(); lv.syncFull(); deposits?.attach(lv.world.buildings_flat()); lv.afterTick(); if (forestDirtyFlag) rebuildForest(true); updateSelection(); updateHud(); }

/** How we stand with another village: feeling, marriage and treaties (1 trade pact, 2 peace, 4 alliance). */
/** Armies may march only on a village we are at war with: declaring war drops the feeling to -80 or lower and ends every treaty. */
const WAR_BELOW = -60;
function atWarWith(key: string) { return relOf(key).rel <= WAR_BELOW; }
/** An alliance is in force with this village (treaty bit 4): allies cannot attack each other, and can send soldiers to help (docs/ALLIES.md). */
function isAlly(key: string) { return (relOf(key).treaties & 4) !== 0; }
/** Field armies that are guests of an ally (not ours to order). */
function guestIds(): Set<number> { const f = lv.world.det_flat(), al = lv.world.det_ally_flat(), out = new Set<number>(); for (let i = 0; i < al.length; i++) if (al[i] !== 0) out.add(f[i * 17]); return out; }
const NOT_AT_WAR = (name: string) => `You are not at war with ${name}. Declare war on them in the Embassy first.`;
function relOf(key: string) {
  const tag = tagOf(key), f = lv.world.relations_flat();
  for (let i = 0; i + 3 < f.length; i += 4) if (f[i] === tag) return { rel: f[i + 1], married: f[i + 2] === 1, treaties: f[i + 3] };
  return { rel: 0, married: false, treaties: 0 };
}

let raidersBrokenSeen = false;
/** Victory: every bandit camp and lair of the world has been cleared. The game carries on (raids still come by sea and land): this only says so once. */
let brokenCheck = 0;
function checkRaidersBroken() {
  if (brokenCheck++ % 120 !== 0) return;
  const broken = lv.world.raiders_broken();
  if (broken && !raidersBrokenSeen) { const t = 'Every bandit camp and lair is cleared: the raiders are broken. You have won — but raiders still come, and the village carries on.'; ui.toast(t, 'good'); ui.log(t, 'good', Number(lv.world.tick())); }
  raidersBrokenSeen = broken;
}
function updateHud() {
  checkRaidersBroken();
  const w = lv.world;
  let barracks = -1; const f = w.buildings_flat(); for (let i = 0; i < f.length; i += 10) if (f[i] === 19) barracks = Math.max(barracks, f[i + 1]);
  const flow = parseLedger(w.ledger_flat(), LEDGER_EXTRAS); for (let i = 0; i < rates.length; i++) rates[i] = steadyRate(flow, i);
  const workRows = ui.workOpen ? parseRows(w.staffing_flat(), f) : undefined;
  const workProblems = workRows?.filter(r => r.want === 0 || r.staff === 0 || [1, 2, 3, 7, 8].includes(r.status))
    .map(r => [r.idx, productionProblemsHtml(r.idx)]);
  const kinds = new Array(defs.length).fill(0); for (let i = 0; i < f.length; i += 10) kinds[f[i]]++;
  showPopulationInfo(w); showVillageFlag();
  showChoice(w, doDecide);
  ui.update({
    tick: Number(w.tick()), stocks: Array.from(w.stocks()), rates, flow, kinds, food: Array.from(World.food_table()), foodReserveDays: w.food_reserve_days(), pop: w.population(), cap: w.capacity(), sick: w.sick(),
    reserves: Array.from(w.reserves()), canSetReserves: replay?.target !== lv,
    joy: w.happiness(), eff: w.efficiency(), jobs: w.jobs(), radius: w.build_radius(), buildings: w.building_count(), storage: w.storage(),
    army: Array.from(w.army()), vets: Array.from(w.army_veterans()), queued: Array.from(w.queued()), away: Array.from(w.away()), guards: w.guards(), barracks, wildlife: wildlife.count,
    militaryTech: w.military_tech(), bridgeShortcuts: w.army_bridge_shortcuts(),
    vitals: Array.from(w.vitals()), beds: w.hospital_beds(), devotion: w.devotion(), winter: Array.from(w.winter_numbers()),
    work: workRows ? { rows: workRows, totals: parseTotals(w.staffing_totals()), problems: Object.fromEntries(workProblems ?? []) } : undefined,
  });
  ui.maxAttack(Array.from(w.army())); updateDets();
  { // the border follows what has been built; redrawn only when the land changed
    const key = `${w.building_count()}:${w.build_radius()}:${w.terrain_version()}`;
    if (key !== borderKey) {
      borderKey = key; const segs = territoryOutline(w.territory_flat()), pos = new Float32Array((segs.length / 2) * 3);
      for (let i = 0; i < segs.length; i += 2) { pos[(i / 2) * 3] = segs[i]; pos[(i / 2) * 3 + 1] = terrain.heightAt(segs[i], segs[i + 1]) + 0.5; pos[(i / 2) * 3 + 2] = segs[i + 1]; }
      borderRing.geometry.dispose(); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); borderRing.geometry = g;
    }
  }
}

function setReserves(grain: number, wood: number): boolean {
  if (replay?.target === lv || !Number.isInteger(grain) || !Number.isInteger(wood)) return false;
  const w = lv.world, current = w.reserves();
  if (current[0] === grain && current[1] === wood) return true;
  if (!w.set_reserves(grain, wood)) return false;
  void commit({ op: 'reserve', x: grain, y: wood });
  updateHud();
  ui.toast('Stock reserves saved.', 'good');
  return true;
}

let followedVillager: number | null = null;
function followVillager(id: number | null): boolean {
  if (id === null) { rig.stopFollowing(); return true; }
  const w = lv.world, person = lv.people.villager(id);
  if (!person || lv.people.hidden) return false;
  const started = rig.follow(() => lv.world === w && !lv.people.hidden ? lv.people.villager(id) ?? null : null, () => {
    followedVillager = null;
    ui.setFollowing(null);
  });
  if (started) {
    followedVillager = id;
    ui.setFollowing(person.name);
  }
  return started;
}

/** Was a fight going on in each village at the last look (to notice the start of one). */
const fightSeen = new Map<string, boolean>();
const raidWarningSeen = new Map<string, boolean>();

interface BattleOrder { village: Village; peer: string | null; group: number; mode: number }
let pendingBattleOrder: BattleOrder | null = null;
let raidWagon: { x: number; z: number; yaw: number } | null = null;
let visibleBattlePins: { pin: BattlePin; el: HTMLElement }[] = [];

function setBattlefield(orders: BattlePin[], objective: RaidObjective | null, angle = 0) {
  raidWagon = objective?.kind === 'caravan' && !objective.lost ? { x: objective.x, z: objective.z, yaw: -angle - Math.PI / 2 } : null;
  const points = objective && !objective.lost
    ? [...orders, { x: objective.x, z: objective.z, text: objectiveName(objective), objective: true }] : orders;
  while (visibleBattlePins.length > points.length) visibleBattlePins.pop()!.el.remove();
  points.forEach((pin, i) => {
    let entry = visibleBattlePins[i];
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'lbl battle-pin';
      ui.labels.append(el);
      entry = visibleBattlePins[i] = { pin, el };
    }
    entry.pin = pin;
    entry.el.classList.toggle('objective', !!pin.objective);
    if (entry.el.textContent !== pin.text) entry.el.textContent = pin.text;
  });
}

function drawBattlefieldPins() {
  for (const { pin, el } of visibleBattlePins) {
    const y = terrain.walkAt(pin.x, pin.z) + (pin.objective ? 5.8 : 0.85);
    vtmp.set(pin.x, y, pin.z).project(rig.cam);
    const visible = !showroom && vtmp.z >= -1 && vtmp.z <= 1 && Math.abs(vtmp.x) < 1 && Math.abs(vtmp.y) < 1;
    el.hidden = !visible;
    if (visible) el.style.transform = `translate(${Math.round((vtmp.x * 0.5 + 0.5) * innerWidth)}px,${Math.round((-vtmp.y * 0.5 + 0.5) * innerHeight)}px) translate(-50%,-100%)`;
  }
}

function setPendingBattleOrder(order: BattleOrder | null) {
  pendingBattleOrder = order;
  ui.setBattleTarget(order?.mode ?? null);
}

function chooseBattleOrder(village: Village, peer: string | null, group: number, mode: number) {
  if (replay?.target === village) return;
  const order = { village, peer, group, mode };
  if (mode === 0 || mode >= FIRST_STANCE) { setPendingBattleOrder(null); sendBattleOrder(order, 0, 0); return; }
  if (selectedKind !== null) selectKind(null);
  cancelMarchPreview();
  showRoute();
  ui.hint(null);
  ui.tip(null);
  setPendingBattleOrder(order);
}

function sendBattleOrder(order: BattleOrder, x: number, y: number) {
  const { village, peer, group, mode } = order;
  if (!village.world.battle_active() || replay?.target === village) return false;
  const r = peer === null ? null : rivals.get(peer);
  const command = { op: 'battleorder' as const, idx: group, kind: mode, x, y };
  if (peer !== null && !r) return false;
  if (r?.online) void commit({ ...command, to: r.key });
  else {
    if (!village.world.battle_order(r ? myTag() : 0, group, mode, x, y)) return false;
    if (peer === null) void commit(command);
    battleBanner();
  }
  if (mode !== 0 && mode < FIRST_STANCE) fx.burst(x, y, false);
  ui.toast(mode === 0 ? 'Order cleared.' : 'Battle order issued.', 'info');
  return true;
}

/** The red banner while a fight is on, for the first village with one: who attacks from where, which side you are on, a click to look at the attackers, and what you can do about it. The same
 *  options exist for both sides (see defence.ts). A raid on your own village also takes the camera there at once when "Jump to raiders" is on. */
/** The army view over a battle (key K, or the Command screen button): made when first wanted. */
let cmdScreen: CommandScreen | null = null;
const commandScreen = () => cmdScreen ??= new CommandScreen(k => unitIcon(k, 16));

function battleBanner() {
  const list: { v: Village; who: string; mine: boolean; key: string }[] = [{ v: lv, who: 'your village', mine: true, key: 'me' }, ...[...rivals.values()].map(r => ({ v: r.village, who: r.name + "'s village", mine: false, key: r.key }))];
  for (const { v, mine, key } of list) {   // every village is watched, including during the warning period
    const on = v.world.battle_active(), was = fightSeen.get(key) ?? false; fightSeen.set(key, on);
    const warning = v.world.raid_warning_ticks() > 0, warned = raidWarningSeen.get(key) ?? false; raidWarningSeen.set(key, warning);
    if (warning && !warned && (!mine || v.world.raid_spotted())) {
      const dir = compassWord(Math.cos(v.world.raid_warning_angle()), Math.sin(v.world.raid_warning_angle()));
      const msg = `${mine ? 'Your watchtower sights' : 'Lookouts sight'} bandits gathering to attack ${mine ? 'your village' : (rivals.get(key)?.name ?? 'a village') + "'s village"} from the ${dir}.`;
      ui.toast(msg, 'bad'); ui.log(msg, 'bad', Number(v.world.tick()));
      if (mine && replay?.target !== v) {
        sound.warhorn();
        if (settings().pauseForRaids && speed > 0 && !watch.away && !document.hidden) setSpeed(0);
      }
    }
    if (shouldAutoJump(was, on, settings().jumpToRaiders, roleOf(mine, v.world.battle_tag(), myTag()))) lookAtAttackers(v);
    if (on && !was) announceBoss(v, mine, key);
  }
  const controllable = list.find(({ v, mine }) => v.world.battle_active() && (mine || v.world.battle_tag() === myTag()));
  if (pendingBattleOrder && (pendingBattleOrder.village !== controllable?.v || replay?.target === pendingBattleOrder.village)) setPendingBattleOrder(null);
  for (const { v, who, mine, key } of controllable ? [controllable] : list) {
    const w = v.world;
    if (!w.battle_active() && w.raid_warning_ticks() > 0 && (!mine || w.raid_spotted())) {
      const seconds = arrivalTime(w.raid_warning_ticks(), TICK_RATE);
      const dir = compassWord(Math.cos(w.raid_warning_angle()), Math.sin(w.raid_warning_angle()));
      const bossWarning = w.raid_warning_boss() ? ' A warlord leads them.' : '';
      const objective = parseRaidObjective(w.raid_objective());
      const text = `Raid approaching from the ${dir} in about ${seconds} at 1×.${bossWarning}`;
      const f = foeFocus(w.raid_warning_angle(), v.ox, v.oz, w.build_radius(), w.raid_distance(w.raid_warning_angle()));
      setBattlefield([], objective, w.raid_warning_angle());
      const preparing = mine && replay?.target !== v;
      const towers = preparing ? openGarrisons(w, objective ?? f) : [];
      const ready = preparing ? Math.min(w.army()[1], towers.reduce((n, tower) => n + tower.slots, 0)) : 0;
      const paused = preparing && (speed === 0 || !!watch.review);
      const briefing = objective
        ? `<small class="raid-goal">${objectiveName(objective)} · ${objective.kind === 'gate' ? 'Keep it standing until the raiders break.' : 'Keep soldiers near the wagon until it can leave.'} Click to locate it.</small>`
        : '<small>Muster troops and man your towers.</small>';
      ui.battle(`${icon('attack', 18, { mono: true })} Raiders approaching<small>${esc(text)}${paused ? ' Countdown paused.' : ''}</small>${briefing}`,
        () => rig.focus(objective?.x ?? f.x, objective?.z ?? f.z, 65), mine ? { greed: w.bribe_greed() } : undefined);
      const actions: Parameters<UI['battleControls']>[0] = [];
      if (preparing) {
        actions.push({ label: 'Military', icon: 'army', title: 'Check your standing army and training queue', run: () => ui.setTab('army') });
        if (ready > 0) actions.push({ label: `Man towers (${ready})`, icon: 'watchtower', title: 'Station available archers at towers and keeps nearest the raid', run: () => manRaidTowers(w, objective ?? f) });
        if (paused) actions.push({ label: 'Resume countdown', icon: 'play', title: 'Let the raid countdown continue at normal speed', run: () => { playerPresent(); setSpeed(1); battleBanner(); } });
      }
      ui.battleControls(actions);
      return;
    }
    if (!w.battle_active()) continue;
    const u = w.battle_units_flat(); let d = 0, a = 0;
    for (let i = 0; i < u.length; i += BATTLE_STRIDE) if (u[i + 6] > 0) { if (u[i] === 0) d++; else a++; }
    const ang = w.battle_angle(), tag = w.battle_tag(), dir = compassWord(Math.cos(ang), Math.sin(ang));
    const boss = parseBoss(w.battle_boss()), lair = w.battle_lair().length > 0;
    const strip = boss ? `<span class="bossstrip" title="${esc(bosses[boss.kind - 1]?.desc ?? '')}">${icon(lair ? 'lair' : boss.kind === 1 ? 'horn' : 'boss', 16, { mono: true })} ${esc(bossLine(bosses, boss))}<i><b class="${boss.phase > 0 ? 'rage' : ''}" style="width:${Math.round(hpFraction(boss) * 100)}%"></b></i></span>` : '';
    const role = roleOf(mine, tag, myTag());
    const objective = parseRaidObjective(w.raid_objective());
    const canOrder = (mine || role === 'attack') && replay?.target !== v;
    setBattlefield(canOrder ? orderPins(w.battle_order_points(mine ? 0 : myTag())) : [], objective, ang);
    const attacker = tag === 0 ? 'Bandits' : (tag === myTag() ? 'Your army' : rivalName(tag));
    const text = lair ? `Your army fights in the lair. March it away to break off.`
      : role === 'defend' ? `${attacker} attack${tag === 0 ? '' : 's'} from the ${dir}. You defend.`
      : role === 'attack' ? `Your army attacks from the ${dir}. You are the attacker.` : `${attacker} attack${tag === 0 ? '' : 's'} from the ${dir}. You are watching.`;
    const armies = fieldArmiesFree(), standing = w.battle_standing().reduce((x: number, y: number) => x + y, 0);
    const acts: { label: string; title: string; run: () => void; icon?: string; disabled?: boolean }[] = [];
    if (objective && !objective.lost) acts.push({ icon: objective.kind, label: 'Find objective', title: objectiveName(objective), run: () => rig.focus(objective.x, objective.z, 55) });
    for (const act of actionsFor(role, { armies, standing, reserve: 0 })) {
      if (lair) continue;
      if (act === 'send-armies') acts.push({ icon: 'army', label: `Send armies out (${armies})`, title: 'Your field armies march to the raiders and join the defence', run: () => { void orderArmies(freeArmyIds(), orderDefend); } });
      else if (act === 'sally') acts.push({ icon: 'attack', label: `Sally out (${standing})`, title: 'The soldiers at their posts leave them and march out to meet the raiders as a field army', run: () => doSally() });
      else if (act === 'retreat') acts.push({ icon: 'halt', label: 'Retreat', title: 'Call off the attack: your soldiers break off and run for home', run: () => doRetreat(key) });
    }
    const greed = role === 'defend' && !lair && tag === 0 ? w.bribe_greed() : undefined;
    const offer = greed !== undefined && replay?.target !== v ? bribeOffer(w.bribe_price(), w.stocks()[GOLD], greed) : undefined;
    const bribeLine = offer?.show ? `<small class="bribe">The raiders will turn back for coin before the first blow. ${esc(offer.disabled ? offer.reason : BRIBE_CONSEQUENCE)}</small>` : '';
    const deployment = w.battle_deploy_remaining();
    const objectiveLine = objective ? `<small class="raid-goal">${objectiveName(objective)} · ${objective.lost
      ? 'Lost. Drive off the raiders.'
      : objective.left > 0
        ? `${arrivalTime(objective.left, TICK_RATE)} ${deployment > 0 ? 'after deployment' : 'remaining'} at 1×${objective.capture > 0 ? ` · Capture ${Math.round(objective.capture * 100)}%` : ''}`
        : `Clear the wagon’s escape route · Capture ${Math.round(objective.capture * 100)}%`}</small>` : '';
    const elapsed = (deployment > 0 ? `Forming up · ${Math.ceil(deployment)}s` : `${Math.round(w.battle_time())}s`)
      + (speed > 1 && role !== 'watch' ? ' · Normal speed during battle' : '');
    ui.battle(`${icon('attack', 18, { mono: true })} ${lair ? 'Battle at the lair' : `Battle at ${who}`}<small>${text}</small>${strip}${objectiveLine}${bribeLine}<small>${lair ? 'Your army' : 'Defenders'} ${d} · ${lair ? 'The lair' : 'Attackers'} ${a} · ${elapsed} · click to look at the ${lair ? 'fight' : 'attackers'}${role === 'defend' && !lair ? ' · right-click the raiders with an army selected to send it' : ''}</small>`,
      () => lookAtAttackers(v), greed === undefined ? undefined : { greed, offer, pay: doBribe });
    if (role !== 'watch' && !lair) acts.push({ icon: 'army', label: cmdScreen?.active ? 'Village view' : 'Command screen', title: 'Swap the interface for an army view: both sides, health, morale and orders (K)', run: () => { commandScreen().toggle(); battleBanner(); } });
    if (cmdScreen?.active) cmdScreen.update(w.battle_roster(), role === 'attack' ? 1 : 0, { mine: role === 'attack' ? 'Your army' : lair ? 'Your army' : 'Defenders', theirs: esc(lair ? 'The lair' : attacker) });
    const order = canOrder ? (group: number, mode: number) => chooseBattleOrder(v, mine ? null : key, group, mode) : undefined;
    ui.battleControls(acts, order, order ? w.battle_orders(mine ? 0 : myTag()) : undefined);
    return;
  }
  ui.battle(null);
  ui.battleControls();
  cmdScreen?.set(false);
  setBattlefield([], null);
}

function openGarrisons(w: World, target: { x: number; z: number }) {
  const buildings = w.buildings_flat(), garrison = w.garrison_flat();
  const towers: { idx: number; slots: number; occupied: number; distance: number }[] = [];
  for (let i = 0; i < buildings.length; i += STRIDE) {
    const idx = i / STRIDE, occupied = garrison[idx], slots = w.garrison_cap(idx) - occupied;
    if (slots > 0) towers.push({ idx, slots, occupied, distance: (buildings[i + 2] - target.x) ** 2 + (buildings[i + 3] - target.z) ** 2 });
  }
  return towers.sort((a, b) => a.distance - b.distance || a.idx - b.idx);
}

function manRaidTowers(w: World, target: { x: number; z: number }) {
  if (lv.world !== w || replay?.target === lv || w.raid_warning_ticks() === 0 || w.battle_active()) return;
  playerPresent();
  let available = w.army()[1], stationed = 0;
  for (const tower of openGarrisons(w, target)) {
    const add = Math.min(tower.slots, available);
    if (!add) break;
    const count = tower.occupied + add;
    if (w.garrison_set(tower.idx, count) !== 0) continue;
    void commit({ op: 'garrison', idx: tower.idx, kind: count });
    stationed += add; available -= add;
  }
  if (stationed > 0) {
    afterLocalChange();
    ui.toast(`${stationed} ${stationed === 1 ? 'archer has' : 'archers have'} taken up a post.`, 'good');
  }
  battleBanner();
}

/** A fight has just begun in this village: if a boss leads it, say so (who, from where) and, for a lair, take the camera there. */
function announceBoss(v: Village, mine: boolean, key: string) {
  const w = v.world, boss = parseBoss(w.battle_boss()); if (!boss) return;
  if (w.battle_lair().length) { const t = lairAnnouncement(bosses, boss); ui.toast(t, 'info'); ui.log(t, 'info', Number(w.tick())); if (mine) lookAtAttackers(v); return; }
  const dir = compassWord(Math.cos(w.battle_angle()), Math.sin(w.battle_angle())), who = mine ? 'your village' : (rivals.get(key)?.name ?? 'a village') + "'s village";
  const t = raidAnnouncement(bosses, boss, dir, mine, who); ui.toast(t, 'bad'); ui.log(t, 'bad', Number(w.tick())); if (mine) sound.warhorn();
}

/** The health bar that floats over the boss while he stands: follows him on the screen (a thin bar and his name). */
let bossBarEl: HTMLDivElement | null = null; let bossFill: HTMLElement | null = null;
function updateBossBar() {
  let b: ReturnType<Village['army']['bossAt']> = null;
  for (const v of allVillages()) { if (v.world.battle_active()) { b = v.army.bossAt(); if (b) break; } }
  if (!b) { if (bossBarEl) bossBarEl.hidden = true; return; }
  if (!bossBarEl) { bossBarEl = document.createElement('div'); bossBarEl.id = 'bossbar'; bossBarEl.innerHTML = '<span></span><i><b></b></i>'; document.body.appendChild(bossBarEl); }
  vtmp.set(b.x, b.y, b.z).project(rig.cam);
  const on = vtmp.z < 1 && Math.abs(vtmp.x) < 1.1 && Math.abs(vtmp.y) < 1.1;
  if (bossBarEl.hidden === on) bossBarEl.hidden = !on; if (!on) return;
  bossBarEl.style.transform = `translate(${Math.round((vtmp.x * 0.5 + 0.5) * innerWidth)}px, ${Math.round((-vtmp.y * 0.5 + 0.5) * innerHeight)}px) translate(-50%, -100%)`;
  const title = bossTitle(bosses, b.boss, b.name), name = bossBarEl.firstElementChild as HTMLElement; if (name.textContent !== title) name.textContent = title;
  bossFill ??= bossBarEl.querySelector('b') as HTMLElement;
  const w = Math.round(Math.max(0, Math.min(1, b.hp / b.max)) * 100) + '%'; if (bossFill.style.width !== w) bossFill.style.width = w;
  const rage = b.phase > 0; if (bossFill.classList.contains('rage') !== rage) bossFill.classList.toggle('rage', rage);
}

/** Small health bars over wounded soldiers in a fight (friend green, foe red), nearest few only. */
const unitBarEls: HTMLDivElement[] = [];
const woundedList: { x: number; y: number; z: number; hp: number; max: number; side: number; d: number }[] = [];
function updateUnitBars() {
  const list = woundedList; list.length = 0;
  const cx = rig.cam.position.x, cy = rig.cam.position.y, cz = rig.cam.position.z;
  for (const v of allVillages()) { if (v.world.battle_active()) for (const u of v.army.woundedAt() as typeof list) { u.d = (u.x - cx) ** 2 + (u.y - cy) ** 2 + (u.z - cz) ** 2; list.push(u); } }
  list.sort((a, b) => a.d - b.d);   // (the distance is worked out once per soldier, not twice per comparison)
  let n = 0;
  for (const u of list) {
    if (n >= 60) break;
    vtmp.set(u.x, u.y, u.z).project(rig.cam);
    if (vtmp.z >= 1 || Math.abs(vtmp.x) > 1.05 || Math.abs(vtmp.y) > 1.05) continue;
    let el = unitBarEls[n];
    if (!el) { el = document.createElement('div'); el.className = 'unitbar'; el.innerHTML = '<b></b>'; document.body.appendChild(el); unitBarEls[n] = el; }
    if (el.hidden) el.hidden = false;
    const foe = u.side === 1, w = Math.round(Math.max(0, Math.min(1, u.hp / u.max)) * 100) + '%';
    if (el.dataset.f !== String(foe)) { el.dataset.f = String(foe); el.classList.toggle('foe', foe); }
    el.style.transform = `translate(${Math.round((vtmp.x * 0.5 + 0.5) * innerWidth)}px, ${Math.round((-vtmp.y * 0.5 + 0.5) * innerHeight)}px) translate(-50%, -100%)`;   // a transform: no layout
    const fill = el.firstElementChild as HTMLElement; if (fill.style.width !== w) fill.style.width = w;
    n++;
  }
  for (let i = n; i < unitBarEls.length; i++) if (!unitBarEls[i].hidden) unitBarEls[i].hidden = true;
}

/** Move the camera to where the attackers stand. */
function lookAtAttackers(v: Village) {
  const w = v.world, lair = w.battle_lair();
  if (lair.length) { rig.focus(lair[0], lair[1], 55); return; }   // a lair fight is out in the country
  const f = foeTarget(w.battle_units_flat(), w.battle_spawn(), w.battle_angle(), v.ox, v.oz, w.build_radius());   // where they stand now (they march on from where they formed up)
  rig.focus(f.x, f.z, 70);
  trackFoe = { v, until: performance.now() + 5000 };   // and stay with them for a few seconds, unless the player takes the camera
}

/** The camera follows the attackers for a few seconds after a jump to them. Any move of the player's own (mouse, key, wheel) ends it. */
let trackFoe: { v: Village; until: number } | null = null;
for (const ev of ['pointerdown', 'keydown', 'wheel']) addEventListener(ev, () => { trackFoe = null; }, { capture: true, passive: true });
function updateFoeTrack(now: number) {
  if (!trackFoe) return;
  if (now > trackFoe.until || !trackFoe.v.world.battle_active()) { trackFoe = null; return; }
  const c = foeCentroid(battleUnits(trackFoe.v.world));
  if (c) rig.focus(c.x, c.z);
}

/** An arrow at the edge of the screen that points to the attackers while they are out of sight (click it to go there). */
let foeArrowEl: HTMLDivElement | null = null; let foeArrowVillage: Village | null = null;
function updateFoeArrow() {
  let target: { v: Village; x: number; z: number } | null = null;
  for (const v of allVillages()) { if (!v.world.battle_active() || v.world.battle_lair().length) continue; const c = foeCentroid(battleUnits(v.world)); if (c) { target = { v, x: c.x, z: c.z }; break; } }
  if (!target) { if (foeArrowEl) foeArrowEl.hidden = true; return; }
  vtmp.set(target.x, terrain.heightAt(target.x, target.z), target.z).project(rig.cam);
  const e = edgeArrow((vtmp.x * 0.5 + 0.5) * innerWidth, (-vtmp.y * 0.5 + 0.5) * innerHeight, innerWidth, innerHeight, vtmp.z > 1);
  if (!foeArrowEl) { foeArrowEl = document.createElement('div'); foeArrowEl.id = 'foearrow'; foeArrowEl.title = 'The attackers are this way: click to look at them'; foeArrowEl.textContent = '➤'; document.body.appendChild(foeArrowEl); foeArrowEl.onclick = () => { if (foeArrowVillage) lookAtAttackers(foeArrowVillage); }; }
  foeArrowVillage = target.v;   // (the click handler reads this: no new closure every frame)
  foeArrowEl.hidden = !e; if (!e) return;
  foeArrowEl.style.transform = `translate(${Math.round(e.x)}px, ${Math.round(e.y)}px) translate(-50%, -50%) rotate(${e.angle}rad)`;   // left/top would make the browser redo the layout every frame
}

/** Field armies that are free to be sent to the fight (not already in it). */
function freeArmyIds(): number[] {
  const f = lv.world.det_flat(), out: number[] = [], guests = guestIds();
  for (let o = 0; o < f.length; o += 17) if (!guests.has(f[o]) && f[o + 8] !== 8 && f[o + 3] + f[o + 4] + f[o + 5] + f[o + 6] + f[o + 7] + f[o + 16] > 0) out.push(f[o]);
  return out;
}
const fieldArmiesFree = () => freeArmyIds().length;

/** Send a field army to the fight at home: it marches to the raiders and joins the defenders. */
async function orderDefend(id: number) {
  const r = await plannedArmyOrder(id, 0, 0, 1);
  if (r === null) return false;
  if (r !== 0) { ui.toast(r === -10 ? 'There is no fight to send them to.' : (MARCH_ERRORS[r] ?? 'No way through to the raiders.'), 'bad'); sound.error(); return false; }
  attackTargets.delete(id); commit({ op: 'defend', idx: id }); sound.click();
  ui.toast('The army marches out to meet the raiders.', 'good');
  return true;
}

/** The standing army leaves its posts and marches out as a field army. */
function doSally() {
  const u = sallyUnits(lv.world.battle_standing());
  if (u.every(n => n === 0)) { ui.toast('Nobody is standing at their post.', 'info'); return; }
  const id = lv.world.det_form(Uint32Array.from(u));
  if (!id) { ui.toast('The soldiers cannot leave their posts just now.', 'bad'); return; }
  commit({ op: 'form', units: u }); lv.afterTick(); selectDet(id); updateHud(); void orderArmies([id], orderDefend);
}

/** The attacker calls off the attack. In a village whose owner is here the owner's own copy carries it out (and tells everybody); in an away village the fight is local. */
/** Pay the raiders at the gates to turn back (a bandit raid on your own village that has not struck yet). The core decides whether it is allowed and affordable; the command lets every copy of the village do the same at this tick. */
function doBribe() {
  if (replay?.target === lv) return;
  const w = lv.world, price = w.bribe_price(), boss = parseBoss(w.battle_boss())?.kind ?? 0, code = w.bribe();
  if (code !== 0) { ui.toast(bribeRefusal(code, price, w.stocks()[GOLD]), 'bad'); return; }
  commit({ op: 'bribe' }); sound.coin(); ui.toast(bribeToast(price, boss), 'info'); afterLocalChange(); battleBanner();
}

function doRetreat(key: string) {
  const r = rivals.get(key); if (!r) return;
  if (r.online) { commit({ op: 'retreat', to: key }); ui.toast('You sound the retreat. Your soldiers fall back.', 'info'); }
  else if (r.village.world.battle_retreat(myTag())) { r.village.afterTick(); ui.toast('You sound the retreat. Your soldiers fall back.', 'info'); }
}

/** Attackers wear their own village's colour (bandits are brown). */
const foeColorOf = (tag: number): number | null => { if (tag === 0) return null; if (tag === myTag()) return lv.army.friend; for (const r of rivals.values()) if (tagOf(r.key) === tag) return r.village.army.friend; return 0xb02a2a; };

function rivalName(tag: number): string { for (const r of rivals.values()) if (tagOf(r.key) === tag) return r.name; return 'Another village'; }

// ---------- PVE: the computer's villages (docs/PVE.md) ----------
/** Make the two computer villages of a PVE game: each on a site near yours, each with a layout picked at random from the demo layouts, each run by an `Ai` that plays by the player's rules. */
async function setupPve() {
  const layouts = pickLayouts(worldName, myName, Ai.layout_count()), picks = pickSites(sites, mySite);
  picks.forEach((site, n) => {
    const o = siteOrigin(site), key = aiKey(n), name = aiName(worldName, n);
    const village = new Village(new World(seedBig, o.x, o.z), 'rival:' + key, name, false, shared, n ? 0xb08030 : 0xb03030); village.foeColor = foeColorOf;
    village.onReport = rep => onRivalReport(key, rep);
    const ai = new Ai(seedBig, n, layouts[n] ?? n, tagOf(key));
    villagesChanged(); rivals.set(key, { key, peerId: '', name, site, village, online: false, sync: 'computer', tick: 0, log: [], track: new ReplicaTrack(), policy: new ResyncPolicy(), versionOk: true, state: 'ok', confirming: false, forked: false, liar: false, desyncs: 0, resyncs: 0, lastDiag: '', bigJumpAt: 0, failedAt: 0, ai });
    village.setWorld(village.world); refreshTerrain(village.world); village.syncFull(); village.markCaughtUp();
    chainTo(rivals.get(key)!);                 // the road between the two cities, for our armies...
    village.world.link_village(lv.ox, lv.oz);  // ... and for theirs
  });
  // a saved game comes back at its own tick: the computer's villages grow up to it (they are not part of the player's history)
  const goal = Number(lv.world.tick());
  if (goal > 0) {
    ui.progress(90, 'The neighbours are building…');
    for (const r of rivals.values()) {
      while (Number(r.village.world.tick()) < goal) {
        for (let i = 0; i < 400 && Number(r.village.world.tick()) < goal; i++) tickAi(r, false);
        ui.progress(90 + Math.round(8 * Number(r.village.world.tick()) / goal), 'The neighbours are building…'); await nextFrame();
      }
      r.village.syncFull(); r.village.markCaughtUp();
    }
    refreshAll();
  }
  ui.toast(`Two villages near you are run by the computer: ${[...rivals.values()].filter(r => r.ai).map(r => r.name).join(' and ')}. They grow, trade and raid like real players.`, 'info');
  updatePeers();
}

/** One tick of a computer village: its world steps, its controller thinks, and what the controller asks of the page (an army at the border) is carried out. */
function tickAi(r: Rival, live = true) {
  const ai = r.ai!, w = r.village.world, t = Number(w.tick());
  if (t % 60 === 0) {   // tell it where its enemy is and what can be seen of it
    const d = Math.min(2900, Math.hypot(lv.ox - r.village.ox, lv.oz - r.village.oz) * 1.15);
    ai.set_target(lv.ox, lv.oz, lv.radius, myTag(), d);
    ai.observe(lv.world.army().reduce((a, n) => a + n, 0) + lv.world.guards());
  }
  w.step(); w.take_events();
  const req = ai.step(w);
  if (!live) return;
  if (req.length) for (const u of raidRequests(req)) aiRaid(r, u);
}

/** The computer's army stands at our border: it attacks the way a player's army does (the same path as another player's `sendatk`). */
function aiRaid(r: Rival, units: number[]) {
  if (replay?.target === lv) { r.ai!.refused(r.village.world, Uint32Array.from(units)); return; }
  const outcome = defendAgainst(r, { op: 'sendatk', tick: Number(lv.world.tick()), n: 0, units, to: identity.pub });
  if (outcome === 'refuse') r.ai!.refused(r.village.world, Uint32Array.from(units));
}

/** A battle at our village ended: if the attackers were a computer village's army, its survivors go home with the loot. */
function aiReport(rep: number[]) {
  if (!computerVillages || !rep[2]) return;
  for (const r of rivals.values()) if (r.ai && tagOf(r.key) === rep[2]) { r.ai.returned(r.village.world, Uint32Array.from(rep.slice(6, 12)), Int32Array.from(rep.slice(12, 12 + RES.length))); break; }
}

let aiFrame = 0;
function stepAis() {
  if (!computerVillages || replay?.target === lv) return;
  aiFrame++;
  for (const r of rivals.values()) {
    if (!r.ai) continue;
    tickAi(r);
    const w = r.village.world;
    // what the computer's villages send us
    const tag = myTag(), now = Number(lv.world.tick());
    const arrived = w.take_arrivals();
    for (let i = 0; i + 3 < arrived.length; i += 4) {
      if (arrived[i + 1] !== tag || now - arrived[i + 3] > 40) continue;
      const kind = arrived[i], days = arrived[i + 2];
      if (kind <= 2) { answerOffer(r, kind, days); if (!lv.world.has_treaty(tagOf(r.key), kind)) w.treaty_end(tag, kind); }
      else ui.toast(arrivedText(kind, r.name, 'you', false), kind === JK.WAR ? 'bad' : 'good');
    }
    const delivered = w.take_delivered();
    for (let i = 0; i + 2 < delivered.length; i += 3) if (delivered[i + 2] === tag) { onTrade(r, { op: 'goods', kind: delivered[i], x: delivered[i + 1], tick: now, n: 0 }); if (lv.world.caravan_welcome(tagOf(r.key))) w.settle(delivered[i], delivered[i + 1], tag); else w.caravan_returned(delivered[i], delivered[i + 1], tag); }   // (its own copy settles the sale or gift; a hostile us turns it back)
    if (w.battle_active() || aiFrame % 3 === 0) r.village.afterTick();
  }
}

/** Our caravan reached a computer village: it pays for the goods (or takes them as a gift when it cannot) and we collect what it paid. */
function aiTakesGoods(r: Rival, res: number, amount: number) {
  const their = tagOf(r.key), gift = (res & GIFT) !== 0;
  if (r.village.world.receive_goods_from(res, amount, myTag()) < 0) {   // it will not have goods from somebody it loathes: they come home
    if (lv.world.caravan_returned(res, amount, their)) { void commit({ op: 'carhome', kind: res, x: amount, idx: their }); ui.toast(`${r.name} turned your caravan back. The goods are home again.`, 'bad'); updateHud(); }
    return;
  }
  const was = gift && lv.world.is_awaiting(res, amount, their);
  const got = lv.world.settle(res, amount, their);
  if (was) { void commit({ op: 'settle', kind: res, x: amount, idx: their }); ui.toast(`${r.name} accepted your gift.`, 'good'); updateHud(); }
  else if (got > 0) { void commit({ op: 'settle', kind: res, x: amount, idx: tagOf(r.key) }); ui.toast(`${r.name} paid ${got} gold for the goods.`, 'good'); updateHud(); }
}

/** An errand of ours reached a computer village: it answers an offer, welcomes an envoy, takes our wedding party or our declaration of war. */
function aiAnswers(r: Rival, kind: number, days: number) {
  const w = r.village.world, mine = myTag(), tag = tagOf(r.key);
  if (kind <= 2) {
    if (w.treaty_acceptable(mine, kind) && w.treaty_set(mine, kind, days)) ui.toast(`${r.name} accepts.`, 'good');
    else { lv.world.treaty_end(tag, kind); void commit({ op: 'treaty', idx: tag, kind, y: 0 }); ui.toast(`${r.name} turned the offer down.`, 'info'); }
  } else if (kind === JK.ENVOY) w.rel_add(mine, 8);
  else if (kind === JK.MARRIAGE) { w.rel_add(mine, 30); }
  else if (kind === JK.WAR) w.declare_war(mine);
}

function stepAwayFights() {
  for (const key of [...awayFights]) {
    const r = rivals.get(key); if (!r || r.online || r.ai) { awayFights.delete(key); continue; }   // (an owner who comes back takes the village over again; a computer village steps by itself, see stepAis)
    const w = r.village.world;
    if (w.battle_active()) { w.step(); r.village.afterTick(); if (!w.battle_active()) { awayFights.delete(key); r.village.afterTick(); } } else { awayFights.delete(key); r.village.afterTick(); }
  }
}

let lentBridges: Set<number> = new Set();   // the drawbridges that are down for an army right now (announced when they go down)
function stepLocal() {
  const w = lv.world;
  w.step();
  const ev = w.take_events();
  for (let i = 0; i < ev.length; i += 4) {
    const e = EVENT_TEXT(ev[i], ev[i + 1], ev[i + 2]);
    ui.log(e.text, e.tone, ev[i + 3]);
    if (!watch.away) {
      ui.toast(e.text, e.tone);
      if (e.tone === 'bad') sound.alert(); else if (e.tone === 'good') sound.coin();
    }
  }
  const t = Number(w.tick());
  if (t % 4 === 0) updateGoals();
  { const l = newlyLent(w.buildings_flat(), lentBridges); lentBridges = l.now; if (l.fresh.length) ui.toast('Lowering the drawbridge for the army', 'info', 'drawbridge'); }
  pollTrade(); checkArrivals(); stepAwayFights(); stepAis(); updateDets();
  if (previewShown?.request.reinforce !== undefined && !previewWanted) {
    if (selectedDet !== previewShown.id || !w.battle_active()) cancelMarchPreview();
    else queueMarchPreview(previewShown.id, ...previewShown.request.to);
  }
  if (selectedDet !== null && !previewShown) showRoute();
  if (room && room.peers.size) { const hp = w.state_hash_and_parts(); room.broadcastHash({ tick: t, hash: hp[0].toString(), c: sharedCount, p: Array.from(hp.subarray(1), x => x.toString()), tools: usedTools, e: myEpoch }); }   // (one pass over the world, not two)
  if (t % 15 === 0) { if (covOn) covOverlay(); if (covB !== null || covG) covRefocus(); }
  if (hlShown && t % 15 === 0 || (hlRes.length && !hlOn())) applyHighlight();
  if (t % 3 === 0) { deposits.sync(w.deposits_flat(), w.deposits_asleep()); if (t % 15 === 0) { deposits.attach(w.buildings_flat()); camps.sync(w.neutrals_flat()); } }
  tickShown = false;   // the scene and the HUD follow once all of this frame's ticks are done (see showTicks)
  if (touchPlacement) { const e = touchPlacementEvent(); if (e) updateGhost(e); showTouchTools(); }
  if (ui.stewardOpen() || watch.review) renderWatch();
  if (forestDirtyFlag) rebuildForest(true);
}

function setSpeed(n: number) {
  if ([...rivals.values()].some(r => r.online)) n = Math.min(n, 1);
  if (n > 0 && watch.review && !document.hidden) watch.resume(performance.now());
  speed = n;
  renderWatch();
  save();
}

const livePlayerBattle = () => lv.world.battle_active() && lv.world.battle_tag() !== 0;
const watchRisk = () => stewardRisks(lv.world.steward_status()[0])[0];

function renderWatch() {
  const playerBattle = livePlayerBattle(), working = watch.working && speed > 0;
  const paused = !!watch.review || (watch.away && !working) || speed === 0;
  ui.setSpeed(playerBattle || working ? 1 : paused ? 0 : speed);
  const status = ui.stewardOpen() ? lv.world.steward_status() : undefined;
  ui.setSteward({ mode: watch.mode, report: watch.review, paused, playerBattle, status, market: !!status && lv.world.market_goods().length > 0 });
}

function stewardAction(action: StewardAction) {
  if (replay?.target === lv) return;
  if (action === 'open') { ui.openSteward(); renderWatch(); return; }
  if (action === 'pause' || action === 'steward') { watch.mode = action; renderWatch(); writeSave(); return; }
  switch (action) {
    case 'resume': setSpeed(speed || 1); break;
    case 'food': ui.openFlow(-2); break;
    case 'wood': ui.openWinter(); updateHud(); break;
    case 'work': ui.openWork(); break;
    case 'ruins': {
      const index = lv.world.recovery_ruin();
      if (index < 0) break;
      const ruin = lv.world.ruins_flat(), x = ruin[index * 6], z = ruin[index * 6 + 1];
      rig.focus(x, z, 42); selectRuin(index);
      break;
    }
    case 'market': {
      const f = lv.world.buildings_flat();
      for (let i = 0; i < f.length; i += STRIDE) if (f[i] === 28) {
        rig.focus(f[i + 2], f[i + 3], 45); selectBuilding(i / STRIDE);
        break;
      }
      break;
    }
  }
}

function playerPresent() {
  if (document.hidden) return;
  const now = performance.now(), before = watch.review;
  watch.observe(now, false);
  const wasAway = watch.away;
  watch.present(now);
  if (watch.review !== before) {
    if (watch.review && replay?.target !== lv) ui.openSteward();
  }
  if (wasAway) renderWatch();
}

function startVillageWatch() {
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
    addEventListener(type, playerPresent, { passive: true, capture: true });
  }
  const persist = () => { clearTimeout(saveTimer); writeSave(); checkpoint(true); for (const r of rivals.values()) saveRivalCopy(r); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { watch.observe(performance.now(), true); persist(); }
    else playerPresent();
  });
  addEventListener('pagehide', () => { watch.observe(performance.now(), true); persist(); });
  addEventListener('pageshow', e => { if (e.persisted) playerPresent(); });
}

// ---------- selection & placement ----------
function selectKind(k: number | null) {
  touchPlacement = null;
  blockRings.forEach(r => (r.visible = false));
  placedPointer = null;
  if (k !== null) cancelMarchPreview();
  if (k !== null && pendingBattleOrder) setPendingBattleOrder(null);
  zoneIdx = null; rallyPick = null; selectedKind = k; ui.markSelected(k); penReset(); roadReset(); drawPenBar(); drawLevelBar(); lv?.nodes.setActive(k === 37); levelCode = 99;
  showTouchTools();
  if (ghost) { scene.remove(ghost); ghost.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | undefined; if (mat && m.userData.ghostMat) mat.dispose(); }); ghost = null; }
  terrain.clearPreview(); previewKey = ''; if (ghostRing) ghostRing.visible = false; if (levelDisc) levelDisc.visible = false; anchorGhost?.hide(); anchorKey = ''; covGhost(null); if (builderRangeRing) builderRangeRing.visible = false;
  if (k === PLANT_TOOL) { selectedIdx = null; updateSelection(); ui.hint(placeHint(k)); }
  else if (k === LEVEL_TOOL) { selectedIdx = null; updateSelection(); ui.setLevelCost(Array.from(World.level_cost_flat(levelR))); ui.hint(placeHint(k)); }
  else if (k !== null) {
    selectedIdx = null; updateSelection();
    // the ghost is the real building (same textures and shape), tinted green or red, so what you see is what you get
    ghost = buildModel(k, 0, 0x2f5fa8, 0); ghost.visible = false;
    ghost.traverse(o => { const m = o as THREE.Mesh; if (!m.isMesh) return; const c = (m.material as THREE.MeshStandardMaterial).clone(); m.userData.ghostMat = true; c.transparent = true; c.opacity = 0.86; c.emissive = new THREE.Color(0x22cc55); c.emissiveIntensity = 0.32; m.material = c; m.castShadow = false; m.receiveShadow = false; });
    scene.add(ghost); ghostCode = 99; previewKey = '';
    ui.hint(placeHint(k));
  } else ui.hint(null);
}

/** Better buildings employ more people and make more: x1, x2.25, x3.5, x4.75. */
/** Amounts per day at full staffing (a cycle is `cycle` ticks, a day 240). */
function perDay(d: { cycle: number }, a: [number, number][], tier: number): [number, number][] { return scaled(a, tier).map(([r, n]) => [r, Math.round(n * 240 / d.cycle)]); }
/** What a producer makes and uses per day at its present tier, and the same at the next one. */
function perDayHtml(d: { cycle: number; maxTier: number; jobs: number }, tier: number, recipe: { inputs: [number, number][]; outputs: [number, number][] }): string {
  const cell = (a: [number, number][], sign: string) => a.map(([r, n]) => `${resIcon(r)} ${sign}${n}`).join(' ');
  const stat = (label: string, now: [number, number][], next: [number, number][] | null, sign: string) =>
    `<div class="stat"><b>${cell(now, sign)}</b><span>${label}</span>${next ? `<small class="muted">Next tier: ${cell(next, sign)}</small>` : ''}</div>`;
  const up = tier < d.maxTier;
  return `<div class="stats">${stat('Makes per day', perDay(d, recipe.outputs, tier), up ? perDay(d, recipe.outputs, tier + 1) : null, '+')}${recipe.inputs.length ? stat('Uses per day', perDay(d, recipe.inputs, tier), up ? perDay(d, recipe.inputs, tier + 1) : null, '−') : ''}</div>`;
}
function scaled(a: [number, number][], tier: number): [number, number][] { return a.map(([r, n]) => [r, Math.max(n, Math.floor((n * (4 + 5 * tier) + 2) / 4))]); }

function placeHint(k: number) {
  if (k === PLANT_TOOL) return `Plant trees, ${plantR} wide — click to plant (1 wood a tree, young trees take a day and a half to grow) · R changes the size · Esc stops`;
  if (touchInput && k !== LEVEL_TOOL && k !== 37 && (!PEN_SPACING[k] || penShape === 'line')) return `${defs[k].name} · Tap to position, drag the preview to move it, then choose Build here.${k === 35 ? ' The pier turns toward open water.' : ''}`;
  if (k === 35) return 'Port · Choose a shoreline. The pier turns toward open water automatically.';
  if (k === LEVEL_TOOL) return `Level ground, ${levelR} wide, to ${levelH < 0 ? 'the land round it (Auto)' : 'height ' + levelH.toFixed(1)} — click to level the patch: pits are filled, bumps cut, ditches and earthworks inside taken away · set the Target height in the bar · R changes the size · Esc cancels`;
  if (k === 24) return `Moat ${(1 + 0.13 * moatWidth).toFixed(1)}× wide — press R to make it thinner or broader · ${SHAPES.find(x => x.id === penShape)?.hint ?? ''} · Alt = any angle · Esc cancels`;
  if (isEarthwork(k)) return `${defs[k].name} · ${earthworkH < 0 ? 'Auto (' + (k === 33 ? '+2.2' : '−2.2') + ')' : 'target height ' + levelHeightLabel(earthworkH)} · ${SHAPES.find(x => x.id === penShape)?.hint ?? ''} · Esc cancels`;
  if (PEN_SPACING[k]) return `${defs[k].name} · ${SHAPES.find(x => x.id === penShape)?.hint ?? ''} · hold Alt for any angle · Esc cancels`;
  if (k === 37) return 'Road — click the points of the road: it runs in a smooth curve through them · lay it from the ring of a building to the castle: workplaces need a road to the castle (or stand in its yard) to work at full pace · its ends snap onto nodes (the rings at the edge of a building, the four sides of a plaza) and onto other roads · double-click or Enter to build · right-click takes the last point back · Esc cancels';
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

/** The pieces a pen stroke lays along an outline (corners in order, closed or not): spaced for the kind, one on every corner, each turned along the way it runs. */
function penBuild(kind: number, pts: P[], closed: boolean) {
  const sp = PEN_SPACING[kind], out: { dx: number; dy: number; x: number; z: number; rot: number }[] = [], seen = new Set<string>();
  for (const q of samplePath(pts, closed, sp)) {
    const dx = Math.round(q.x - lv.ox), dy = Math.round(q.z - lv.oz), key = `${dx},${dy}`; if (seen.has(key)) continue; seen.add(key);
    out.push({ dx, dy, x: lv.ox + dx, z: lv.oz + dy, rot: kind === 24 ? moatWidth : rotOf(q.heading) });
  }
  return out;
}

/** The outline the pen would draw right now: a straight run, the clicked corners plus the pointer, or a figure dragged out. Null when there is nothing to draw yet. */
function penOutline(a: P | null, to: P, free: boolean): { pts: P[]; closed: boolean } | null {
  if (penShape === 'path') {
    if (!penPath.length) return null;
    const last = penPath[penPath.length - 1], next = free ? to : snap45(last, to);
    if (closesPath(penPath, to, 3.5)) return { pts: [...penPath], closed: true };
    return { pts: [...penPath, next], closed: false };
  }
  if (!a) return null;
  if (isFigure(penShape)) return { pts: figureOutline(penShape, a, to), closed: true };
  return { pts: [a, free ? to : snap45(a, to)], closed: false };
}

function penPreviewUpdate(kind: number, o: { pts: P[]; closed: boolean }) {
  const pieces = penBuild(kind, o.pts, o.closed).slice(0, 400), w = lv.world, stocks = Array.from(w.stocks());
  const afford = Math.min(...defs[kind].cost.map(([r, n]) => Math.floor(stocks[r] / Math.max(1, n))), 9999);
  let good = 0; const view = pieces.map((p, i) => { const ok = i < afford && placementCheck(w, kind, p.dx, p.dy) === 0; if (ok) good++; return { x: p.x, z: p.z, ok }; });
  penPreview.set(view, o.closed ? [...o.pts, o.pts[0]] : o.pts);
  const cost = defs[kind].cost.map(([r, n]) => `${n * good} ${RES[r].name.toLowerCase()}`).join(', ');
  ui.hint(`${defs[kind].name}: ${good} of ${pieces.length} pieces can be laid${good ? ' · ' + cost : ''} · ${penShape === 'path' ? 'double-click or Enter to build' : 'release to build'} · Alt = any angle`, good === 0);
}

function penCommit(kind: number, o: { pts: P[]; closed: boolean }) {
  const pieces = penBuild(kind, o.pts, o.closed).slice(0, 400); let placed = 0, blocked = 0, broke = false;   // one stroke lays at most 400 pieces
  // the whole stroke is one batch: the paths are worked out once at the end, and it is sent as one signed command
  const items = pieces.flatMap(p => [kind, p.dx, p.dy, p.rot]), flat = Int32Array.from(items);
  const manual = isEarthwork(kind) && earthworkH >= 0;
  const codes = manual ? lv.world.place_batch_height(flat, earthworkH) : lv.world.place_batch(flat);
  for (const code of codes) { if (code >= 0) placed++; else if (code === -6) broke = true; else blocked++; }
  if (placed) commit(manual ? { op: 'batch', units: items, h: earthworkH } : { op: 'batch', units: items });
  if (placed) { afterLocalChange(); sound.place(2); const last = pieces[pieces.length - 1]; placedFx(kind, last.x, last.z); updateHud(); }
  ui.toast(placed ? `${placed} × ${defs[kind].name.toLowerCase()} built${broke ? ' — you ran out of materials' : blocked ? ` (${blocked} blocked)` : ''}.` : broke ? 'Not enough resources.' : 'Nothing could be built there.', placed ? 'good' : 'bad');
}

/** Stop drawing: forget the corners and the preview. */
function penReset() { penStart = null; penPath = []; penPreview?.clear(); }

/** The row of drawing modes shown while a wall, fence, moat or earthwork is selected: line, path of corners, and ready-made figures. */
function setPenShape(sh: Shape) { penShape = sh; penReset(); drawPenBar(); showTouchTools(); if (selectedKind !== null) ui.hint(placeHint(selectedKind)); }
function drawPenBar() {
  let bar = document.getElementById('penbar');
  if (selectedKind === null || !PEN_SPACING[selectedKind]) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'penbar'; bar.className = 'tool-panel';
    bar.onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-shape]'); if (b) setPenShape(b.dataset.shape as Shape); };
    document.getElementById('tool-dock')!.appendChild(bar);
  }
  bar.innerHTML = SHAPES.map(sh => `<button data-shape="${sh.id}" title="${sh.label}: ${sh.hint}" style="cursor:pointer;min-width:44px;padding:5px 6px;border-radius:5px;border:1px solid ${sh.id === penShape ? '#ffe08a' : '#6d5a38'};background:${sh.id === penShape ? '#7a5a22' : '#2a2014'};color:#f1e4c3;font:16px system-ui,sans-serif"><span style="display:block;line-height:0;height:24px">${icon(sh.icon, 24, { mono: true })}</span><span style="font-size:10px">${sh.label}</span></button>`).join('');
}

/** While the pointer is on the Upgrade button: an outline of the bigger building (green when there is room, red with the neighbours in the way marked red too). */
function showUpgradeOutline(on: boolean) {
  if (growRing.visible) ui.hint(null);
  growRing.visible = false; blockRings.forEach(r => (r.visible = false));
  if (!on || selectedIdx === null) return;
  const w = lv.world, f = w.buildings_flat(), o = selectedIdx * 10; if (o >= f.length) return;
  const kind = f[o], tier = f[o + 1]; if (tier >= defs[kind].maxTier) return;
  const fa = footprint(kind, tier), fb = footprint(kind, tier + 1); if (fb <= fa + 0.01) return;
  const blockers = Array.from(w.upgrade_blockers(selectedIdx));
  growRing.set(f[o + 2], f[o + 3], fb + 1.1); growRing.visible = true;
  (growRing.material as THREE.MeshBasicMaterial).color.setHex(blockers.length ? 0xff8a5a : 0x9dffb0);
  blockers.slice(0, blockRings.length).forEach((b, i) => { const q = b * 10; blockRings[i].set(f[q + 2], f[q + 3], footprint(f[q], f[q + 1]) + 1.1); blockRings[i].visible = true; });
  if (blockers.length) ui.hint(`Not enough room: ${blockers.length} building${blockers.length > 1 ? 's' : ''} in the way (marked red). Demolish ${blockers.length > 1 ? 'them' : 'it'} to upgrade.`, true);
}
// --- Coverage: how far wells, builders' yards and towers reach. Every number comes from the core (`effect_radii`, radii.rs); nothing here repeats one. ---
const K_WELL = 16, K_TOWER = 3, K_KEEP = 26, K_YARD = 20, WALL_KINDS: ReadonlySet<number> = new Set([2, 22]), NO_FIRE_CHECK: ReadonlySet<number> = new Set([2, 21, 22, 23, 37, 38, 44]);
const radiiCache = new Map<number, Radius[]>();
const radiiOf = (kind: number, tier: number): Radius[] => { const key = kind * 8 + Math.min(tier, 7); let r = radiiCache.get(key); if (!r) { r = parseRadii(effect_radii(kind, tier)); radiiCache.set(key, r); } return r; };
let covOn = false, covB: number | null = null, covG: { x: number; z: number } | null = null;
let covFocus!: RadiusRings, covAll!: RadiusRings; const covTints: SelectionMark[] = [], COV_TINT_MAX = 120;
const covLabels: { el: HTMLElement; x: number; z: number; on: boolean }[] = [];
function covInit() { covFocus = new RadiusRings(terrain, 12); covAll = new RadiusRings(terrain, 160); scene.add(covFocus.group, covAll.group); }
function covLabel(n: number, text: string, x: number, z: number) {
  const l = covLabels[n] ?? (covLabels[n] = (() => { const el = document.createElement('div'); el.className = 'lbl cov'; el.hidden = true; ui.labels.appendChild(el); return { el, x: 0, z: 0, on: false }; })());
  if (l.el.textContent !== text) l.el.textContent = text;
  l.x = x; l.z = z; l.on = true;
}
/** Rings (and their words) for what is being placed, selected or hovered: only on a change, never per frame. */
function covRefocus() {
  if (!covFocus || !lv) return;
  covFocus.begin(); for (const l of covLabels) l.on = false;
  let nl = 0;
  const show = (x: number, z: number, radii: Radius[], note = '') => {
    for (const e of radii) covFocus.add(x, z, e.r, e.fx);
    for (const d of describeRadii(radii)) { const anchor = Math.max(...radii.filter(e => d.fx.includes(e.fx)).map(e => e.r)); covLabel(nl++, d.text + (d.fx.includes(FX_SHOOT) ? note : ''), x, z - anchor); }
  };
  if (selectedKind !== null) { if (covG) show(covG.x, covG.z, radiiOf(selectedKind, 0)); }
  else {
    const w = lv.world, n = w.building_count(), f = w.buildings_flat(), gar = w.garrison_flat();
    for (const i of covB === selectedIdx ? [selectedIdx] : [selectedIdx, covB]) {
      if (i === null || i >= n) continue;
      const o = i * STRIDE, kind = f[o], tier = f[o + 1];
      show(f[o + 2], f[o + 3], radiiOf(kind, tier), (kind === K_TOWER || kind === K_KEEP) && gar[i] === 0 ? ' · no archers inside yet' : '');
    }
  }
  covFocus.end();
}
function covHover(i: number | null) { if (i === covB) return; covB = i; covRefocus(); }
function covGhost(p: { x: number; z: number } | null) { if (!p) { if (!covG) return; covG = null; covRefocus(); return; } if (covG && covG.x === p.x && covG.z === p.z) return; covG = p; covRefocus(); }
/** The "Show coverage" overlay: every well's and manned tower's rings, an amber mark on buildings no well reaches, a red one on wall pieces no manned tower covers. Rebuilt on a change and every few ticks. */
function covOverlay(announce = false) {
  if (!covAll || !lv) return;
  covAll.begin(); let nt = 0;
  const tint = (x: number, z: number, r: number, kind: number, padH: number, color: number) => {
    if (nt >= COV_TINT_MAX) return;
    const m = covTints[nt] ?? (covTints[nt] = (() => { const k = new SelectionMark(terrain); scene.add(k); return k; })());
    m.set(x, z, r, kind, padH); (m.material as THREE.MeshBasicMaterial).color.setHex(color); m.visible = true; nt++;
  };
  let unwelled = 0, bare = 0, towers = 0;
  if (covOn) {
    const w = lv.world, f = w.buildings_flat(), gar = w.garrison_flat(), n = f.length / STRIDE, manned: { x: number; z: number; r: number }[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE, kind = f[o], tier = f[o + 1];
      if (kind === K_WELL) { for (const e of radiiOf(kind, tier)) if (e.fx === FX_FIRE_FULL || e.fx === FX_FIRE_HALF) covAll.add(f[o + 2], f[o + 3], e.r, e.fx); }
      else if (kind === K_YARD && f[o + 8] > 0) { for (const e of radiiOf(kind, tier)) covAll.add(f[o + 2], f[o + 3], e.r, e.fx); }
      else if ((kind === K_TOWER || kind === K_KEEP) && gar[i] > 0) { const e = radiiOf(kind, tier).find(q => q.fx === FX_SHOOT); if (e) { covAll.add(f[o + 2], f[o + 3], e.r, e.fx); manned.push({ x: f[o + 2], z: f[o + 3], r: e.r }); towers++; } }
    }
    const wr = radiiOf(K_WELL, 0), full = wr.find(e => e.fx === FX_FIRE_FULL)?.r ?? 0, half = wr.find(e => e.fx === FX_FIRE_HALF)?.r ?? 0;
    const open = uncoveredByWells(f, K_WELL, full, half, (k, t) => !NO_FIRE_CHECK.has(k) && flammability_of(k, t) >= 0.1);
    for (const i of open) { const o = i * STRIDE; tint(f[o + 2], f[o + 3], footprint(f[o], f[o + 1]) + 1.1, f[o], f[o + 5], 0xffb23a); }
    unwelled = open.length;
    if (towers) { const gaps = wallsOutOfReach(f, WALL_KINDS, manned); for (const i of gaps) { const o = i * STRIDE; tint(f[o + 2], f[o + 3], footprint(f[o], f[o + 1]) + 0.9, f[o], f[o + 5], 0xff4a3a); } bare = gaps.length; }
  }
  covAll.end(); for (let i = nt; i < covTints.length; i++) covTints[i].visible = false;
  if (announce && covOn) ui.toast(`Coverage: ${unwelled ? `${unwelled} building${unwelled > 1 ? 's' : ''} no well reaches (amber)` : 'every building that can burn has a well within reach'}${towers ? ` · ${bare ? `${bare} wall piece${bare > 1 ? 's' : ''} no manned tower covers (red)` : 'every wall piece is covered by an archer tower'}` : ' · no tower has archers stationed in it'}.`, unwelled || bare ? 'info' : 'good');
}
function toggleCoverage() { covOn = !covOn; ui.setCoverageToggle(covOn); covOverlay(true); }
const cvec = new THREE.Vector3();
/** Move the few labels beside the focus rings to where their ground points are on the screen. */
function updateCovLabels() {
  for (const l of covLabels) {
    if (!l.on) { if (!l.el.hidden) l.el.hidden = true; continue; }
    cvec.set(l.x, terrain.heightAt(l.x, l.z) + 1, l.z).project(rig.cam);
    const on = cvec.z < 1 && Math.abs(cvec.x) < 1 && Math.abs(cvec.y) < 1; l.el.hidden = !on; if (!on) continue;
    l.el.style.left = Math.round((cvec.x * 0.5 + 0.5) * innerWidth) + 'px'; l.el.style.top = Math.round((-cvec.y * 0.5 + 0.5) * innerHeight) + 'px';
  }
}
/** The radii of a building as lines with icons, for its panel. */
function reachHtml(kind: number, tier: number): string {
  const lines = describeRadii(radiiOf(kind, tier)); if (!lines.length) return '';
  return `<div><h3>Reach</h3>${lines.map(l => `<div class="reach">${icon(l.icon as IconName, 16)} ${esc(l.text)}</div>`).join('')}<small class="muted">Drawn on the ground while it is selected or pointed at; ${keyNames('coverage')} shows every well and tower at once.</small></div>`;
}
// --- Hovering a resource's rate in the top bar: ring every building that makes (+) or uses (-) it ---
const hlState = new HighlightState(), goState = new HighlightState(), hlRings: SelectionMark[] = [], HL_MAX = 96;
let hlRes: number[] = [], hlSign = 0, hlPinUntil = 0, hlShown = 0;
const hlOn = () => hlState.active !== null || performance.now() < hlPinUntil;
/** `sign` 1 = what makes the resources, -1 = what uses them, 2 = both. */
function stockSummary(res: number[], sign: number) {
  const w = lv.world, flow = parseLedger(w.ledger_flat(), LEDGER_EXTRAS);
  const winter = w.season() === 3;
  const side = (sg: number) => mergeSources(res.map(r => addCatalogKinds(stockSources(flow, r, sg), defs, r, sg, winter)));
  const src = side(sign === 2 ? 1 : sign);
  if (sign === 2) { const b = side(-1); src.kinds.push(...b.kinds.filter(k => !src.kinds.some(x => x.kind === k.kind))); }
  const stocks = w.stocks(), afford = new Map<number, boolean>();
  const can = (kind: number, tier: number) => {
    const key = kind * 32 + tier; let ok = afford.get(key);
    if (ok === undefined) { const uc = upgrade_cost_flat(kind, tier + 1); ok = true; for (let i = 0; i < uc.length; i += 2) if (stocks[uc[i]] < uc[i + 1]) ok = false; afford.set(key, ok); }
    return ok;
  };
  const sums = summarize(w.buildings_flat(), src.kinds, k => ({ maxTier: defs[k].maxTier, jobs: defs[k].jobs }), can, (idx, kind) => {
    const d = defs[kind];
    if (!d.alternateRecipe && !d.winterRecipe) return true;
    const recipe = d.alternateRecipe && w.smoke_mode(idx) === 1 ? d.alternateRecipe : winter ? d.winterRecipe ?? d : d;
    const has = (side: [number, number][]) => side.some(([r]) => res.includes(r));
    return sign === 2 ? has(recipe.inputs) || has(recipe.outputs) : has(sign > 0 ? recipe.outputs : recipe.inputs);
  });
  return { src, sums };
}
function stockInfo(res: number[], sign: number): { kind: number; html: string }[] {
  if (!res.length || !lv) return [];
  const { src, sums } = stockSummary(res, sign), out: { kind: number; html: string }[] = [];
  for (const k of sums) out.push({ kind: k.kind, html: `${icon(KIND_ICON[k.kind] as IconName, 14)} ${esc(kindLine(defs[k.kind].name, k, sign))} <span class="muted">(${esc(tierText(k))})</span>` });
  for (const e of src.extras) { const x = EXTRA_INFO[e.key]; if (x) out.push({ kind: -1, html: `${icon(x.icon as IconName, 14)} ${esc(x.label)}: ${esc(fmtRate(sign * e.perDay))}` }); }
  return out;
}
/** Place a ring on every highlighted building (green: working; orange: held up; gold: can be upgraded now). Runs on hover and every few ticks, never per frame. */
function applyHighlight() {
  if (!hlOn() || !hlRes.length) { hlRings.forEach(r => (r.visible = false)); hlShown = 0; return; }
  const w = lv.world, f = w.buildings_flat(), { sums } = stockSummary(hlRes, hlSign), stocks = w.stocks();
  let n = 0;
  for (const k of sums) for (const i of k.idx) {
    if (n >= HL_MAX) break;
    if (hlState.active ? !hlState.ringed(i, selectedIdx) : i === selectedIdx) continue;   // the selected building keeps its own ring
    const o = i * STRIDE, tier = f[o + 1], status = f[o + 6], held = (defs[k.kind].jobs > 0 && f[o + 8] === 0) || status === ST_WAIT || status === ST_EXHAUSTED || status === ST_FULL || status === ST_RESERVE;
    let up = false; if (tier < defs[k.kind].maxTier) { const uc = upgrade_cost_flat(k.kind, tier + 1); up = true; for (let c = 0; c < uc.length; c += 2) if (stocks[uc[c]] < uc[c + 1]) up = false; }
    const r = hlRings[n] ?? (hlRings[n] = (() => { const m = new SelectionMark(terrain); scene.add(m); return m; })());
    r.set(f[o + 2], f[o + 3], footprint(f[o], tier) + 1.1, f[o], f[o + 5]);
    (r.material as THREE.MeshBasicMaterial).color.setHex(held ? 0xff6a3a : up ? 0xffffff : 0x9dffb0); r.visible = true; n++;
  }
  for (let i = n; i < hlRings.length; i++) hlRings[i].visible = false;
  hlShown = n;
}
function stockHover(res: number[], sign: number) {
  if (!sign || !res.length || !lv) { hlState.leave(); if (performance.now() >= hlPinUntil) { hlRes = []; hlSign = 0; } applyHighlight(); return; }
  hlRes = res; hlSign = sign; hlState.enter(res[0], sign); applyHighlight();
}
/** Look at the next building behind a rate (of one kind, or of any), selecting it; the rings stay lit for a few seconds when it was not a hover. */
function stockGo(res: number[], sign: number, kind?: number): boolean {
  const { sums } = stockSummary(res, sign), idx: number[] = [];
  for (const k of sums) if (kind === undefined || kind < 0 || k.kind === kind) idx.push(...k.idx);
  idx.sort((a, b) => a - b);
  goState.enter(res[0] * 1000 + (kind ?? -1) + 1, sign);
  const i = goState.next(idx); if (i < 0) return false;
  const f = lv.world.buildings_flat();
  rig.focus(f[i * STRIDE + 2], f[i * STRIDE + 3]);
  if (!hlState.active) { hlRes = res; hlSign = sign; hlPinUntil = performance.now() + 6000; }
  selectBuilding(i); applyHighlight();
  return true;
}

/** Buildings picked together (Shift+click, or "Select connected walls"): two or more switch the side pane to the group view. */
let multiSel: number[] = []; const multiRings: SelectionMark[] = [];
function setMulti(ids: number[]) {
  multiSel = ids;
  while (multiRings.length < ids.length - 1) { const m = new SelectionMark(terrain, 0xffd34d); m.visible = false; scene.add(m); multiRings.push(m); }
  multiRings.forEach(m => { m.visible = false; });
}
function toggleMulti(i: number) {
  const base = multiSel.length ? multiSel : selectedIdx !== null ? [selectedIdx] : [];
  const next = base.includes(i) ? base.filter(k => k !== i) : [...base, i];
  if (next.length <= 1) { selectBuilding(next[0] ?? null); return; }
  showUpgradeOutline(false); setMulti(next); selectedIdx = next[0]; selectedRuin = null; selectKind(null); ui.showSelectedTab(); updateSelection();
}
function selectWallRun(i: number) {
  const run = connectedWalls(lv.world.buildings_flat(), i);
  if (run.length < 2) { selectBuilding(i); return; }
  showUpgradeOutline(false); setMulti(run); selectedIdx = run[0]; selectedRuin = null; selectKind(null); ui.showSelectedTab(); updateSelection();
  ui.toast(`${run.length} connected wall pieces selected.`, 'info');
}
/** The side pane for a group: how many, what they are, what upgrading them all costs, and who cannot be upgraded. */
function multiPane() {
  const w = lv.world, f = w.buildings_flat(), stocks = Array.from(w.stocks());
  multiSel = multiSel.filter(i => i * STRIDE < f.length);
  if (multiSel.length < 2) { setMulti([]); return false; }
  const plan = planUpgrade(multiSel, f, k => defs[k].maxTier, upgrade_cost_flat, stocks);
  multiSel.forEach((i, n) => { const o = i * STRIDE, x = f[o + 2], z = f[o + 3], r = footprint(f[o], f[o + 1]) + 1.1; if (n === 0) selRing.set(x, z, r, f[o], f[o + 5]); else { const m = multiRings[n - 1]; m.visible = true; m.set(x, z, r, f[o], f[o + 5]); } });
  selRing.visible = true;
  const counts = new Map<number, number>(); for (const i of multiSel) counts.set(f[i * STRIDE], (counts.get(f[i * STRIDE]) ?? 0) + 1);
  const names = [...counts].map(([k, n]) => `${n} ${defs[k].name.toLowerCase()}`).join(', ');
  const notes = [plan.full.length ? `${plan.full.length} already fully upgraded.` : '', plan.poor.length ? `${plan.poor.length} cannot be paid for with the current stock.` : ''].filter(Boolean).join(' ');
  ui.setSelectedPane(`<div><div class="eyebrow">Selection</div><h2>${multiSel.length} buildings</h2><p class="muted">${names}</p></div>
    ${plan.go.length ? `<div><h3>Upgrade ${plan.go.length} of ${multiSel.length}</h3><div class="cost">${ui.costHtml(plan.total, stocks)}</div></div><button class="pbtn primary" data-act="multi:upgrade">Upgrade ${plan.go.length}</button>` : `<p><b>Nothing here can be upgraded right now.</b></p>`}
    ${notes ? `<p class="muted">${notes}</p>` : ''}
    <p class="muted">${isTouchDevice() ? 'With Select more on, a tap adds or removes a building.' : 'Shift+click adds or removes a building.'}</p>
    <div class="btnrow"><button class="pbtn" data-act="deselect">Clear selection</button></div>`, '');
  return true;
}
/** Upgrade every selected building that can be: one ordinary upgrade command each (the same ones a single click records), in index order, so replays agree. */
function multiUpgrade() {
  const w = lv.world, plan = planUpgrade(multiSel, w.buildings_flat(), k => defs[k].maxTier, upgrade_cost_flat, Array.from(w.stocks()));
  let done = 0, room = 0, poor = plan.poor.length; const fxAt: number[] = [];
  for (const i of plan.go) {
    const code = w.upgrade(i);
    if (code === 0) { done++; commit({ op: 'upgrade', idx: i }); fxAt.push(i); } else if (code === -3) room++; else poor++;
  }
  const f = w.buildings_flat(); for (const i of fxAt.slice(0, 6)) placedFx(f[i * STRIDE], f[i * STRIDE + 2], f[i * STRIDE + 3], true);
  const skipped = [plan.full.length ? `${plan.full.length} already at the top` : '', room ? `${room} without room to grow` : '', poor ? `${poor} unaffordable` : ''].filter(Boolean);
  if (done) { sound.upgrade(); ui.toast(skipped.length ? `${done} of ${multiSel.length} upgraded; skipped: ${skipped.join(', ')}.` : `${done} buildings upgraded.`, skipped.length ? 'info' : 'good'); }
  else { sound.error(); ui.toast(`Nothing was upgraded (${skipped.join(', ') || 'nothing selected'}).`, 'bad'); }
  afterLocalChange(); updateSelection();
}

function selectBuilding(i: number | null) { setMulti([]); showUpgradeOutline(false); selectedIdx = i; covRefocus(); if (hlOn()) applyHighlight(); if (i !== null) { selectedRuin = null; selectKind(null); ui.showSelectedTab(); } updateSelection(); }

function selectRuin(i: number | null) { selectedRuin = i; if (i !== null) { selectedIdx = null; selectKind(null); ui.showSelectedTab(); } updateSelection(); }

function demolitionTip(world: World, idx: number) {
  const refund = world.demolition_refund_flat(idx), materials: string[] = [];
  for (let i = 0; i < refund.length; i += 2) materials.push(`${refund[i + 1]} ${RES[refund[i]].name.toLowerCase()}`);
  return materials.length ? `Returns ${materials.join(', ')} to your stock.` : '0 materials recovered.';
}

function productionProblemsHtml(idx: number): string {
  const w = lv.world, f = w.buildings_flat(), kind = f[idx * 10], status = f[idx * 10 + 6];
  if (!defs[kind]?.cycle) return '';
  const problems = parseProductionProblems(w.production_problems_flat(idx));
  if (!problems.length) return status === 1 || status === 8 ? '<p class="muted">Inputs ready. Production resumes on the next cycle.</p>' : '';
  const present = new Set<number>();
  for (let i = 0; i < f.length; i += 10) present.add(f[i]);
  const lines = problems.map(p => {
    const text = productionProblemText(p, RES[p.resource]?.name.toLowerCase());
    const buttons: string[] = [];
    if (p.reason === 1 || p.reason === 2) {
      const suppliers = defs.filter(d => [...d.outputs, ...(d.alternateRecipe?.outputs ?? [])].some(([r]) => r === p.resource));
      for (const d of suppliers) {
        const exists = present.has(d.id);
        buttons.push(`<button class="pbtn" data-act="supply:${p.resource}:${d.id}">${exists ? 'Show' : 'Build'} ${esc(d.name)}</button>`);
      }
      if (p.reason === 2) buttons.push('<button class="pbtn" data-act="supply:reserves">Adjust reserves</button>');
    }
    if (p.reason === 3) buttons.push(`<button class="pbtn" data-act="supply:storage:${p.resource}">Show ${esc(RES[p.resource].name.toLowerCase())} use</button><button class="pbtn" data-act="supply:-1:25">Build Storehouse</button>`);
    if (p.reason === 4 || p.reason === 5) buttons.push('<button class="pbtn" data-act="wk:overview">Work overview</button>');
    return `<p>${esc(text)}</p>${buttons.length ? `<div class="btnrow wrap">${buttons.join('')}</div>` : ''}`;
  });
  return `<div class="production-problem"><h3>${status === 0 ? 'Next production batch' : 'Production'}</h3>${lines.join('')}</div>`;
}

function updateSelection() {
  const w = lv.world;
  if (selectedRuin !== null) {   // a ruined building: offer to rebuild it
    const ru = w.ruins_flat();
    if (selectedRuin * 6 >= ru.length) { selectedRuin = null; selRing.visible = false; ui.setSelectedPane(null); return; }
    const o = selectedRuin * 6, x = ru[o], z = ru[o + 1], kind = ru[o + 3], tier = ru[o + 4], cc = w.rebuild_cost_of(selectedRuin), cost: [number, number][] = [], stocks = Array.from(w.stocks());
    for (let i = 0; i < cc.length; i += 2) cost.push([cc[i], cc[i + 1]]);
    const ok = cost.every(([r, n]) => stocks[r] >= n);
    selRing.visible = true; selRing.set(x, z, ru[o + 2] + 1.1);
    ui.setSelectedPane(`<div><div class="eyebrow">Ruins</div><h2>${tierName(kind, tier)}</h2><p class="muted">${defs[kind].name} — burnt or smashed down</p></div><p>Rebuild it as it was, for less than a new one.</p>
      <div><h3>Rebuild cost</h3><div class="cost">${ui.costHtml(cost, stocks)}</div></div>
      <button class="pbtn primary" data-act="rebuild" ${ok ? '' : 'disabled'}>${ok ? 'Rebuild' : 'Not enough resources'}</button>
      <p class="muted">A Builders' Yard will rebuild ruins and mend damaged buildings on its own while you have the materials.</p>`);
    return;
  }
  if (multiSel.length >= 2 && multiPane()) return;
  if (selectedIdx === null || selectedIdx >= w.building_count()) { selectedIdx = null; selRing.visible = false; ui.setSelectedPane(null); return; }
  const f = w.buildings_flat(), o = selectedIdx * 10, hp = w.building_health();
  const kind = f[o], tier = f[o + 1], x = f[o + 2], z = f[o + 3], status = f[o + 6], pct = f[o + 7];
  const d = defs[kind];
  const smokeMode = kind === 42 ? w.smoke_mode(selectedIdx) : -1;
  const recipe = smokeMode === 1 ? d.alternateRecipe ?? d : w.season() === 3 ? d.winterRecipe ?? d : d;
  selRing.visible = true; selRing.set(x, z, footprint(kind, tier) + 1.1, kind, f[o + 5]);
  const stocks = Array.from(w.stocks());
  const io = (a: [number, number][]) => a.map(([r, n]) => `${resIcon(r)} ${n} ${RES[r].name}`).join(', ');
  const health = hp[selectedIdx * 3] / hp[selectedIdx * 3 + 1], burning = hp[selectedIdx * 3 + 2] > 0;
  let html = `<div><div class="eyebrow">${CATS[d.cat].name} · Tier ${tier + 1} of ${d.maxTier + 1}</div><h2>${tierName(kind, tier)}</h2><p class="muted">${d.name}</p></div><p>${d.desc}</p>`;
  html += `<div><div class="eyebrow">${burning ? `${icon('fire', 16)} On fire!` : 'Condition'} · <b>${Math.ceil(hp[selectedIdx * 3])} / ${Math.round(hp[selectedIdx * 3 + 1])} hp</b></div><div class="bar ${health < 0.4 || burning ? 'red' : ''}"><i style="width:${Math.round(health * 100)}%"></i></div></div>`;
  html += reachHtml(kind, tier);
  html += productionProblemsHtml(selectedIdx);
  let repairHtml = '';   // damaged: offer repairs (shown with the other actions, below what the building does)
  if (health < 0.995 && !burning) {
    const rc = w.repair_cost(selectedIdx), rcost: [number, number][] = []; for (let i = 0; i < rc.length; i += 2) rcost.push([rc[i], rc[i + 1]]);
    const rok = rcost.every(([r, n]) => stocks[r] >= n);
    repairHtml = `<div class="act-sec"><h3>Repair</h3><div class="cost">${ui.costHtml(rcost, stocks)}</div></div><button class="pbtn primary" data-act="repair" ${rok ? '' : 'disabled'}>${rok ? 'Repair' : 'Not enough resources'}</button></div>`;
  }
  if (kind === 49) { html += embassyHtml(selectedIdx, tier, stocks) + (repairHtml ? `<div class="actbar">${repairHtml}</div>` : ''); ui.setSelectedPane(html, demolitionTip(w, selectedIdx)); return; }
  if (kind === 3 || kind === 26) {   // towers and keeps need archers stationed inside to defend
    const cap = w.garrison_cap(selectedIdx), cur = w.garrison_flat()[selectedIdx] ?? 0, avail = w.army()[1];
    html += `<div><h3>Garrison</h3><div class="stats"><div class="stat"><b>${cur} / ${cap}</b><span>archers inside</span></div><div class="stat"><b>${avail}</b><span>archers free in the barracks</span></div></div>
      <div class="btnrow" style="flex-wrap:wrap"><button class="pbtn" data-act="gar+" ${cur >= cap || avail < 1 ? 'disabled' : ''}>+ Archer</button><button class="pbtn" data-act="gar-" ${cur < 1 ? 'disabled' : ''}>− Archer</button><button class="pbtn" data-act="garfill" ${cur >= cap || avail < 1 ? 'disabled' : ''}>Fill</button><button class="pbtn" data-act="garempty" ${cur < 1 ? 'disabled' : ''}>Empty</button></div>
      <p class="muted">${cur === 0 ? 'The tower is empty — it only defends once you station archers in it. Train archers at a barracks.' : 'Archers fire from the walkway at the top. They come from the barracks and go back when you empty the tower.'}</p></div>`;
  }
  if (kind === 28) { const mg = w.market_goods(); if (mg.length) html += ui.marketHtml(mg, stocks, Number(w.tick()), DAY_TICKS, w.storage_limit()); }
  if (kind === 38) { const sp = w.bridge_spans_flat(); for (let i = 0; i + 9 < sp.length; i += 10) if (sp[i] === selectedIdx) html += `<p class="muted">${sp[i + 4].toFixed(0)} units long. A footbridge spans up to 14 units of water, a timber bridge 22, a stone bridge 34 and a great bridge 50. Supports stand in the middle wherever the water is wide.</p>`; }
  if (kind === 23) {
    const up = drawnUp(status, w.battle_active());
    const state = up ? (status === DB_UP ? 'Raised' : 'Raised for the raid')
      : status === DB_MANUAL_DOWN ? 'Lowered by your order' : isLent(status) ? 'Lowered for the army' : 'Lowered';
    html += `<div><h3>Drawbridge</h3><div class="stats"><div class="stat"><b>${state}</b><span>State</span></div></div>
      <div class="btnrow"><button class="pbtn primary" data-act="bridge">${up ? 'Lower the drawbridge' : 'Raise the drawbridge'}</button></div>
      <p class="muted">A raid raises the drawbridge automatically. If you lower it yourself, it stays down until you raise it or another raid begins.</p></div>`;
  }
  if (kind === 22) {
    if (tier >= 2) {
      const shut = f[o + 6] === 5, inBattle = lv.world.battle_active();
      html += `<div><h3>Gate doors</h3><div class="stats"><div class="stat"><b>${shut || inBattle ? 'Shut' : 'Open'}</b><span>State</span></div></div>
        <div class="btnrow"><button class="pbtn primary" data-act="gate">${shut ? 'Open the gate' : 'Close the gate'}</button></div>
        <p class="muted">${shut ? 'Barred: nobody marches through, your own armies included.' : 'People and armies pass freely.'} The doors shut by themselves when raiders attack, and open again afterwards (unless you closed them).</p></div>`;
    } else html += `<p class="muted">A wooden gate has no doors. Upgrade it to a stone gatehouse to get doors that can be closed.</p>`;
  }
  if (kind === 1) {   // soil: sowing wears it down, a resting field recovers
    const fi = w.field_info(selectedIdx);
    if (fi.length) {
      const soil = Math.round(fi[0] / 100), mode = fi[1], resting = fi[2] === 1;
      html += `<div><h3>The field</h3><div class="eyebrow">Soil ${soil}% rich · ${resting ? 'resting' : 'sown'}</div><div class="bar ${soil < 50 ? 'red' : ''}" title="Harvest at this soil: ${50 + Math.round(soil / 2)}% of a rich field. A resting field recovers${w.season() === 3 ? ' twice as fast in this winter frost' : ', twice as fast in winter'}."><i style="width:${soil}%"></i></div>
        <div class="btnrow" style="flex-wrap:wrap">${[['Always sow', 0], ['Fallow', 1], ['Rotate', 2]].map(([t, m]) => `<button class="pbtn ${mode === m ? 'on' : ''}" data-act="field:${m}">${mode === m ? '● ' : ''}${t}</button>`).join('')}</div>
        <p class="muted">Sowing every season wears the soil down and the harvest shrinks (to half at worst). A fallow field makes no grain but recovers, twice as fast in winter. <b>Rotate</b> rests the field by itself when the soil is worn and sows it again when it is restored.${soil < 60 && mode === 0 ? ' <b>This soil is tired: try rotating.</b>' : ''}</p></div>`;
    }
  }
  if (smokeMode >= 0) {
    const meat = smokeMode === 1;
    html += `<div><h3>${meat ? 'Smoking meat' : 'Smoking fish'}</h3><div class="btnrow" style="flex-wrap:wrap">${['Fish', 'Meat'].map((label, mode) => `<button class="pbtn ${smokeMode === mode ? 'on' : ''}" data-act="field:${mode}" aria-pressed="${smokeMode === mode}">${label}</button>`).join('')}</div>
      <p class="muted">${meat ? 'Uses wood to smoke meat from pigsties, pastures and hunting lodges.' : 'Turns raw fish from the Fishing Hut into smoked fish using wood.'}</p></div>`;
  }
  if (isLivestockPen(kind)) html += `<div class="btnrow"><button class="pbtn" data-act="people:work">${icon('pop', 16)} ${kind === PIGSTY ? 'Find pig keepers' : 'Find herders'}</button></div>`;
  if (kind === 48) html += `<div class="btnrow" style="flex-wrap:wrap"><button class="pbtn" data-act="zone">Plant zone…</button><button class="pbtn" data-act="zone:reset">Plant round the hut</button></div><p class="muted">Plants two young trees every cycle within 10 of the chosen spot (by default round the hut). Trees take a day and a half to grow, then count as forest for woodcutters and hunters. A woodcutter fells grown planted trees before wild ones.</p>`;
  if (kind === 20) html += `<p class="muted">Sends builders to damaged buildings and ruins within 70 units, using your stores. Higher tiers work faster.</p>`;
  if (d.jobs > 0) html += workersHtml(selectedIdx);
  if (d.cycle) {
    html += `<div class="stats"><div class="stat"><b>${STATUS[status]}</b><span>Status</span></div><div class="stat"><b>${icon('worker', 20)} ${f[o + 8]} / ${d.jobs * (tier + 1)}</b><span>Workers</span></div></div>
      <div><div class="eyebrow">Production cycle</div><div class="bar"><i style="width:${pct}%"></i></div></div>${depositHtml(selectedIdx)}
${perDayHtml(d, tier, recipe)}`;
  } else if (d.housing) html += `<div class="stats"><div class="stat"><b>${icon('house', 20)} ${f[o + 9]} / ${d.housing * (tier + 1)}</b><span>Residents</span></div></div><p class="muted">Residents walk the village paths to their workplaces each day.</p>`;
  if (kind === 15) html += `<p class="muted">Raises storage to ${600 + 200 * tier} per resource and expands your border.</p><h3>Diplomacy</h3><p class="muted">Envoys, treaties, trade and war are handled from the town hall.</p><button class="pbtn primary" data-act="diplomacy">Open diplomacy</button>`;
  if (kind === 15) html += kingdomRoadsHtml(stocks);
  if (kind === 47) {
    const equipped = ((w.options_flat()[selectedIdx] ?? 0) & 1) !== 0;
    html += `<p>${burning ? 'The stable is burning: its horses give no bonus until the fire is out.' : 'Its upgrades are the village\'s horses: each counts once, however many stables you build.'}${equipped && !burning ? ' Caravan horses ready: newly dispatched caravans travel twice as fast.' : ''} Loading a caravan takes 60 seconds.</p>
      <div class="stats"><div class="stat"><b>${w.caravan_speed_percent()}%</b><span>Caravans</span></div><div class="stat"><b>${w.journey_speed_percent(3)}%</b><span>Riders</span></div><div class="stat"><b>${w.cavalry_speed_percent()}%</b><span>Knights</span></div></div>`;
  }
  if (kind === 19) {   // the lord who leads the defence
    const h = w.hero_flat();
    html += h.length ? `<div><h3>${w.hero_name()}</h3><div class="stats"><div class="stat"><b>Level ${h[1]}</b><span>lord</span></div><div class="stat"><b>${h[2]}${h[3] ? ' / ' + h[3] : ''}</b><span>experience</span></div></div><p class="muted">Defenders hit harder and break less easily under a lord. He learns with every defence won, and may fall in a defeat.</p></div>`
      : `<div><h3>A lord to lead you</h3><p class="muted">A lord or lady in command makes every defender hit harder and keeps them from breaking. 150 coins.</p></div><button class="pbtn primary" data-act="hero" ${stocks[8] >= 150 ? '' : 'disabled'}>Take a lord into service</button>`;
  }
  if (kind === 19) html += rallyHtml(0);
  if (kind === 15 && tier >= 3) html += rallyHtml(1);
  if (kind === 19) html += `<p class="muted">Tier ${tier + 1}: ${['spearmen and archers', '+ swordsmen', '+ knights', '+ catapults'][tier]}. Open the Army tab to recruit.</p>`;
  if (kind === 2 || kind === 21 || kind === 22) html += `<div class="btnrow"><button class="pbtn" data-act="selwalls">Select connected walls</button></div>`;
  if (kind === 37) { html += roadPanelHtml(selectedIdx, tier, stocks) + (repairHtml ? `<div class="actbar">${repairHtml}</div>` : ''); ui.setSelectedPane(html, demolitionTip(w, selectedIdx)); return; }
  if (d.cycle && (w.road_access_flat()[selectedIdx] ?? 1) === 0) html += `<p class="muted road-warn">${icon('road', 16)} No road to the castle: this workplace works at half pace. Lay a road from its ring to the castle.</p>`;
  if (tier < defs[kind].maxTier) {
    const uc = upgrade_cost_flat(kind, tier + 1), cost: [number, number][] = []; for (let i = 0; i < uc.length; i += 2) cost.push([uc[i], uc[i + 1]]);
    const ok = cost.every(([r, n]) => stocks[r] >= n);
    html += `<div class="actbar">${repairHtml}<div class="act-sec"><h3>Upgrade to ${tierName(kind, tier + 1)}</h3><div class="cost">${ui.costHtml(cost, stocks)}</div>${upgradeGainsHtml(kind, tier, hp[selectedIdx * 3 + 1], recipe)}<button class="pbtn primary" data-act="upgrade" ${ok ? '' : 'disabled'}>${ok ? 'Upgrade' : 'Not enough resources'}</button></div></div>`;
  } else html += `<div class="actbar">${repairHtml}<p><b>Fully upgraded.</b></p></div>`;
  html += optionsHtml(selectedIdx, kind, tier, stocks, kind === 47 ? 'Upgrades' : 'Design options');
  ui.setSelectedPane(html, kind !== 15 ? demolitionTip(w, selectedIdx) : '');
}

/** What pressing Upgrade on a building would change: each line is "what: now → after", so the player knows exactly what the cost buys. Mirrors the tier rules of the core (see `staffing`, `max_hp`, `storage_cap`). */
function upgradeGainsHtml(kind: number, tier: number, maxHp: number, recipe: { inputs: [number, number][]; outputs: [number, number][] }): string {
  const d = defs[kind], t1 = tier + 1;
  const rows: [string, string, string][] = [];
  const io = (a: [number, number][]) => a.map(([r, n]) => `${resIcon(r)} ${n}`).join(' ');
  const hp1 = maxHp * (1 + 0.8 * t1) / (1 + 0.8 * tier);
  rows.push(['Health', `${Math.round(maxHp)}`, `${Math.round(hp1)}`]);
  if (d.cycle && recipe.outputs.length) {
    rows.push(['Makes per day', io(perDay(d, recipe.outputs, tier)), io(perDay(d, recipe.outputs, t1))]);
    if (recipe.inputs.length) rows.push(['Uses per day', io(perDay(d, recipe.inputs, tier)), io(perDay(d, recipe.inputs, t1))]);
  }
  if (d.jobs > 0) rows.push(['Workers', `${d.jobs * (tier + 1)}`, `${d.jobs * (tier + 2)}`]);
  if (d.housing > 0) rows.push(['Housing', `${d.housing * (tier + 1)} people`, `${d.housing * (tier + 2)} people`]);
  if (kind === 15) {
    rows.push(['Storage per resource', `${600 + 200 * tier}`, `${600 + 200 * t1}`]);
    rows.push(['Guards', `${2 * (tier + 1)}`, `${2 * (tier + 2)}`]);
  }
  if (d.name === 'Storehouse') rows.push(['Storage per resource', `+${250 * (tier + 1)}`, `+${250 * (tier + 2)}`]);
  if (kind === 3) rows.push(['Garrison', `${2 * (tier + 1) + 2}`, `${2 * (tier + 2) + 2}`]);
  if (kind === 26) rows.push(['Garrison', `${4 * (tier + 1) + 4}`, `${4 * (tier + 2) + 4}`]);
  if (d.name === 'Chapel') rows.push(['Burial plots', `${6 * (tier + 1)}`, `${6 * (tier + 2)}`]);
  if (d.name === 'Graveyard') rows.push(['Burial plots', `${20 * (tier + 1)}`, `${20 * (tier + 2)}`]);
  if (d.name === 'Infirmary') rows.push(['Beds', `${4 * (tier + 1)}`, `${4 * (tier + 2)}`]);
  if (kind === 19) rows.push(['Trains', ['spearmen, archers', '+ swordsmen', '+ knights', '+ catapults'][tier], ['+ swordsmen', '+ knights', '+ catapults', ''][tier]]);
  if (d.name === 'Gate' && tier === 1) rows.push(['Gate', 'open', 'can be shut against raiders']);
  const fp0 = footprint(kind, tier), fp1 = footprint(kind, t1);
  if (fp1 > fp0 + 0.05) rows.push(['Room it takes', `${fp0.toFixed(1)}`, `${fp1.toFixed(1)}`]);
  const fl0 = flammability_of(kind, tier), fl1 = flammability_of(kind, t1);
  if (fl1 < fl0 - 0.005) rows.push(['Fire risk', `${Math.round(fl0 * 100)}%`, `${Math.round(fl1 * 100)}%`]);
  return `<div class="upgain"><div class="eyebrow">After the upgrade</div><table class="gains">${rows.map(([k, a, b]) => `<tr><td>${k}</td><td>${a}</td><td>→</td><td><b>${b}</b></td></tr>`).join('')}</table></div>`;
}

/** The castle's road works: every road of the kingdom at once. The surfaces and designs of all the village's roads in numbers, and what it costs to resurface or style them all. */
function kingdomRoadsHtml(stocks: number[]): string {
  const sum = Array.from(lv.world.road_summary_flat()), total = sum[9];
  if (!total) return `<div><h3>Roads</h3><p class="muted">No roads yet. Lay roads from the castle to your workplaces: a workplace with no road to the castle works at half pace, and roads can be resurfaced here, all at once.</p></div>`;
  const names = ['dirt', 'gravel', 'cobbles', 'flagstones'], stat = (n: number | string, label: string) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  let html = `<div><h3>Roads of the kingdom</h3><div class="stats">${stat(total, 'road pieces')}${stat(sum[8] === total ? 'all' : `${sum[8]} / ${total}`, 'reach the castle')}</div>`;
  html += `<p class="muted">${names.map((nm, t) => sum[t] ? `${sum[t]} ${nm}` : '').filter(Boolean).join(' · ')}. Each better surface is walked 8% faster, by villagers and armies alike.</p>`;
  const bf = lv.world.buildings_flat(), tiers: number[] = []; for (let i = 0; i < bf.length; i += 10) if (bf[i] === 37) tiers.push(bf[i + 1]);
  const low = Math.min(...tiers);
  for (let target = low + 1; target <= 3; target++) {
    const cost = new Map<number, number>();
    for (const t of tiers) if (t < target) { const c = road_resurface_cost_flat(t, target); for (let i = 0; i < c.length; i += 2) cost.set(c[i], (cost.get(c[i]) ?? 0) + c[i + 1]); }
    const list: [number, number][] = [...cost.entries()], ok = list.every(([r, n]) => stocks[r] >= n);
    html += `<div class="roadrow"><div class="cost">${ui.costHtml(list, stocks)}</div><button class="pbtn primary" data-act="roads:up:${target}" ${ok ? '' : 'disabled'}>Resurface every road as ${names[target]}</button></div>`;
  }
  const opts = defs[37].opts ?? [], oc = World.option_cost_flat(37);
  html += `<h3>Design, along every road</h3><div class="optlist">` + opts.map((op, i) => {
    const have = sum[4 + i], all = have >= total, eligible = tiers.filter(t => t >= op.t).length;
    const cost: [number, number][] = []; for (let k = 0; k < oc.length; k += 2) cost.push([oc[k], oc[k + 1] * Math.max(1, eligible - have)]);
    const afford = cost.every(([r, n]) => stocks[r] >= n), locked = eligible === 0;
    return `<button class="pbtn opt ${all ? 'on' : ''}" data-act="roads:opt:${i}" ${locked || (!all && !afford && have === 0) ? 'disabled' : ''} title="${op.d}"><span>${icon(have ? 'check' : 'cross', 13, { mono: true })} <b>${op.n}</b></span><small>${locked ? `needs ${esc(tierName(37, op.t).toLowerCase())}` : all ? `on every road — click to remove` : `${have}/${total} roads · ${ui.costHtml(cost, stocks)}`}</small></button>`;
  }).join('') + `</div></div>`;
  return html;
}

/** The panel of a road piece: the stretch it belongs to, whether it reaches the castle, its surface (upgraded along the whole stretch) and its design (trees, hedges, benches, lanterns). */
function roadPanelHtml(idx: number, tier: number, stocks: number[]): string {
  const w = lv.world, stretch = Array.from(w.road_stretch(idx)), n = Math.max(1, stretch.length), bf = w.buildings_flat();
  const tiers = stretch.map(i => bf[i * 10 + 1]), low = Math.min(...tiers), joined = (w.road_joined_flat()[idx] ?? 0) === 1;
  let html = `<div class="stats"><div class="stat"><b>${n}</b><span>pieces in this stretch</span></div><div class="stat"><b>${joined ? 'Yes' : 'No'}</b><span>reaches the castle</span></div></div>`;
  if (!joined) html += `<p class="muted road-warn">${icon('road', 16)} This road is not joined to the castle. Workplaces on it work at half pace until a road runs on to the castle's own node.</p>`;
  if (low !== tier) html += `<p class="muted">Part of this stretch is still ${esc(tierName(37, low).toLowerCase())}.</p>`;
  if (tier < defs[37].maxTier) {
    const sum = new Map<number, number>(), cost: [number, number][] = [];
    for (const t of tiers) if (t < tier + 1) { const c = road_resurface_cost_flat(t, tier + 1); for (let i = 0; i < c.length; i += 2) sum.set(c[i], (sum.get(c[i]) ?? 0) + c[i + 1]); }
    for (const e of sum) cost.push(e);
    const ok = cost.every(([r, c]) => stocks[r] >= c);
    html += `<div><h3>Resurface as ${esc(tierName(37, tier + 1).toLowerCase())}</h3><div class="cost">${ui.costHtml(cost, stocks)}</div></div><button class="pbtn primary" data-act="upgrade" ${ok ? '' : 'disabled'}>${ok ? 'Resurface the stretch' : 'Not enough resources'}</button>`;
  } else html += `<p><b>Flagstones: the finest road there is.</b></p>`;
  const opts = defs[37].opts ?? [], have = w.options_flat()[idx] ?? 0, oc = World.option_cost_flat(37), ocost: [number, number][] = [];
  for (let i = 0; i < oc.length; i += 2) ocost.push([oc[i], oc[i + 1] * n]);
  const afford = ocost.every(([r, c]) => stocks[r] >= c);
  html += `<div><h3>Design</h3><div class="optlist">` + opts.map((op, i) => {
    const on = (have & (1 << i)) !== 0, locked = low < op.t;
    return `<button class="pbtn opt ${on ? 'on' : ''}" data-act="opt:${i}" ${locked || (!on && !afford) ? 'disabled' : ''} title="${op.d}"><span>${icon(on ? 'check' : 'cross', 13, { mono: true })} <b>${op.n}</b></span><small>${locked ? `needs ${esc(tierName(37, op.t).toLowerCase())}` : on ? 'along the stretch — click to remove' : ui.costHtml(ocost, stocks)}</small></button>`;
  }).join('') + `</div></div><p class="muted">Upgrades and design cover the whole stretch up to the next junction. To change every road of the kingdom at once, use the castle.</p><button class="pbtn" data-act="roads:castle">Go to the castle</button>`;
  return html;
}

/** The optional designs of a building: small changes to its look and use, each with what it does, what it costs, and a click to build or remove it. */
function optionsHtml(idx: number, kind: number, tier: number, stocks: number[], title: string): string {
  const opts = defs[kind].opts ?? [];
  if (!opts.length) return '';
  const w = lv.world, have = w.options_flat()[idx] ?? 0;
  /** Each option has its own price. */
  const priced = (bit: number) => { const oc = World.option_cost_for_flat(kind, bit), c: [number, number][] = []; for (let i = 0; i < oc.length; i += 2) c.push([oc[i], oc[i + 1]]); return c; };
  return `<div><h3>${title}</h3><div class="optlist">` + opts.map((op, i) => {
    const on = (have & (1 << i)) !== 0, locked = tier < op.t, ocost = priced(i), afford = ocost.every(([r, n]) => stocks[r] >= n);
    return `<button class="pbtn opt ${on ? 'on' : ''}" data-act="opt:${i}" ${locked || (!on && !afford) ? 'disabled' : ''} title="${op.d}"><span>${icon(on ? 'check' : 'cross', 13, { mono: true })} <b>${op.n}</b></span><small>${locked ? `needs ${tierName(kind, op.t)}` : on ? 'built — click to remove' : ui.costHtml(ocost, stocks)}</small>${kind === 47 || kind === 49 ? `<small class="muted">${op.d}</small>` : ''}</button>`;
  }).join('') + `</div></div>`;
}

// ---------- the embassy ----------
type EmbassyTab = 'building' | 'dip';
let embassyTab: EmbassyTab = 'building';
const flagImages = new Map<number, string>();
/** A small picture of a flag, for the pane (made once per design). */
function flagImage(f: Flag): string {
  const key = packFlag(f); let url = flagImages.get(key);
  if (!url) { const c = document.createElement('canvas'); c.width = 66; c.height = 42; drawFlag(c.getContext('2d')!, c.width, c.height, f); url = c.toDataURL(); flagImages.set(key, url); }
  return url;
}
/** Select the first embassy, on its Diplomacy tab; with none yet, point the way to building one. */
function openEmbassy(tab: EmbassyTab = 'dip') {
  const f = lv.world.buildings_flat();
  for (let i = 0; i * 10 < f.length; i++) if (f[i * 10] === 49) { embassyTab = tab; selectBuilding(i); return; }
  ui.toast('Build an Embassy first: it sends the caravans, envoys, treaties and armies to other villages.', 'info'); ui.setTab('build'); ui.showBuildKind(49);
}
/** The embassy's pane: a Building tab (the flags flown on its forecourt, how fast each kind of party travels, and its four upgrades) and a Diplomacy tab (the trade, treaty and attack form). */
function embassyHtml(idx: number, tier: number, stocks: number[]): string {
  const w = lv.world, tabs = (['building', 'dip'] as const).map(t => `<button class="pbtn ${embassyTab === t ? 'on' : ''}" data-act="etab:${t}" aria-pressed="${embassyTab === t}">${t === 'dip' ? 'Diplomacy' : 'Building'}</button>`).join('');
  let html = `<div class="btnrow" role="tablist">${tabs}</div>`;
  if (embassyTab === 'dip') return html + `<div id="embassy-slot"></div>`;
  const flags = foreignFlags();
  html += `<div><h3>Halls of the other cities</h3>` + (flags.length
    ? `<div class="flagrow" style="display:flex;flex-wrap:wrap;gap:6px">${flags.map(x => `<figure style="margin:0;text-align:center"><img src="${flagImage(x.flag)}" width="44" height="28" alt="${esc(x.name)}'s flag"><figcaption class="tiny muted">${esc(x.name)}</figcaption></figure>`).join('')}</div><p class="muted">Each city has its own little hall in the courtyard, with its flag on the roof${flags.length > 8 ? ' (the eight nearest cities)' : ''}.</p>`
    : `<p class="muted">No other city yet: a hall with its flag is raised here for every city that settles near you.</p>`) + `</div>`;
  const lim = w.party_limits();
  html += `<div><h3>Parties at once</h3><div class="stats"><div class="stat"><b>${lim[0]} / ${lim[1]}</b><span>${icon('envoy', 14)} Envoys, riders, heralds</span></div><div class="stat"><b>${lim[2]} / ${lim[3]}</b><span>${icon('caravan', 14)} Caravans</span></div></div><p class="muted">A higher tier lets the embassy send more out at once.</p></div>`;
  const rows: [string, number, string][] = [['caravan', 6, 'Caravans'], ['envoy', 3, 'Envoys'], ['pact', 0, 'Treaty riders'], ['marriage', 4, 'Wedding parties'], ['war', 5, 'War heralds']];
  html += `<div><h3>Speed of your parties</h3><div class="stats five">${rows.map(([ic, k, name]) => `<div class="stat"><b>${w.journey_speed_percent(k)}%</b><span>${icon(ic, 14)} ${name}</span></div>`).join('')}</div><p class="muted">The stables' horses and these upgrades both count. Parties already on the road keep their pace.</p></div>`;
  if (tier < defs[49].maxTier) {
    const uc = upgrade_cost_flat(49, tier + 1), cost: [number, number][] = []; for (let i = 0; i < uc.length; i += 2) cost.push([uc[i], uc[i + 1]]);
    const ok = cost.every(([r, n]) => stocks[r] >= n);
    html += `<div><h3>Upgrade to ${tierName(49, tier + 1)}</h3><div class="cost">${ui.costHtml(cost, stocks)}</div><p class="muted">Sends ${4 * (tier + 2)} parties and ${2 * (tier + 2)} caravans out at once, and grows the compound.</p></div><button class="pbtn primary" data-act="upgrade" ${ok ? '' : 'disabled'}>${ok ? 'Upgrade' : 'Not enough resources'}</button>`;
  } else html += `<p><b>Fully upgraded.</b></p>`;
  html += optionsHtml(idx, 49, tier, stocks, 'Upgrades');
  return html;
}

/** Give a building a number of workers (-1 auto, 0 paused). Returns true when the core took it. */
function setWorkers(idx: number, n: number, quiet = false): boolean {
  if (lv.world.set_workers(idx, n) !== 0) return false;
  commit({ op: 'workers', idx, kind: n });
  if (!quiet) { sound.click(); afterLocalChange(); updateHud(); }
  return true;
}
/** Bulk changes from the work overview: 'auto' every building, 'auto:K' or 'pause:K' every building of kind K. */
function workAll(action: string) {
  const [what, k] = action.split(':'), kind = k === undefined ? -1 : Number(k);
  const sf = lv.world.staffing_flat(); let n = 0;
  for (let i = 0; i * 5 + 4 < sf.length; i++) {
    const max = sf[i * 5 + 1], bk = sf[i * 5]; if (max <= 0 || (kind >= 0 && bk !== kind)) continue;
    const to = what === 'pause' ? 0 : -1; if (sf[i * 5 + 2] !== to && setWorkers(i, to, true)) n++;
  }
  if (n) { sound.click(); afterLocalChange(); updateHud(); }
}
/** The workers control of the selected building: assigned / wanted / max, a slider with + and − and Auto, and a note when the village is short of hands. */
function workersHtml(idx: number): string {
  const w = lv.world, sf = w.staffing_flat(), o = idx * 5, kind = sf[o], max = sf[o + 1], want = sf[o + 2], staff = sf[o + 3], scaled = sf[o + 4] === 1;
  if (!(max > 0)) return '';
  const t = parseTotals(w.staffing_totals()), shown = want < 0 ? max : Math.min(want, max);
  const note = want === 0 ? 'Paused: nobody works here, so it makes nothing. Villagers go to other buildings.'
    : scaled ? `The village has only ${t.workers} workers for the ${t.promised} you asked for by hand, so every building you set got fewer.`
    : want < 0 && staff < max ? `Short of hands: the village has ${t.workers} workers for ${t.jobs} jobs.` : want < 0 ? 'Automatic: the village shares its workers out, food and wood first.' : 'Set by you; the rest of the workers are shared out by the village.';
  return `<div><h3>Workers</h3><div class="stats"><div class="stat"><b>${icon('worker', 20)} ${staff} / ${shown}${want >= 0 ? ` <small>of ${max}</small>` : ''}</b><span>${want < 0 ? 'Auto' : want === 0 ? 'Paused' : 'Set by hand'}</span></div></div>
    <div class="btnrow wkrow"><button class="pbtn" data-act="wk:-1" ${shown <= 0 ? 'disabled' : ''} aria-label="One worker fewer">−</button>
      <span class="wkslide"><input type="range" min="0" max="${max}" value="${shown}" data-wk="1" aria-label="Workers"><b class="wkval">${shown}</b></span>
      <button class="pbtn" data-act="wk:+1" ${shown >= max ? 'disabled' : ''} aria-label="One worker more">+</button></div>
    <div class="btnrow wrap"><button class="pbtn ${want < 0 ? 'on' : ''}" data-act="wk:auto" title="Let the village decide again">Auto</button><button class="pbtn" data-act="wk:set:0">Pause</button><button class="pbtn" data-act="wk:kind" title="Give every ${esc(defs[kind].name)} this setting">Same for all ${esc(defs[kind].name)}</button></div>
    <p class="muted ${scaled || (want < 0 && staff < max) ? 'neg' : ''}">${note} <button class="pbtn" data-act="wk:overview">Work overview</button></p></div>`;
}

function onAct(a: string) {
  if (a.startsWith('supply:')) {
    const [, resource, kindText] = a.split(':');
    if (resource === 'reserves') { ui.openReserves(); return; }
    if (resource === 'storage') { ui.openFlow(Number(kindText)); return; }
    const kind = Number(kindText), res = Number(resource);
    const f = lv.world.buildings_flat(), suppliers: number[] = [];
    for (let i = 0; i < f.length; i += 10) if (f[i] === kind) suppliers.push(i / 10);
    if (res >= 0 && suppliers.length) {
      if (!stockGo([res], 1, kind)) { const idx = suppliers[0]; rig.focus(f[idx * 10 + 2], f[idx * 10 + 3]); selectBuilding(idx); }
    } else { selectKind(kind); ui.showBuildKind(kind); }
    return;
  }
  if (a === 'wk:refresh') { updateHud(); return; }
  if (a === 'wk:overview') { ui.openWork(); return; }
  if (a === 'people:work' && selectedIdx !== null) { ui.openVillagers(selectedIdx); return; }
  if (selectedRuin !== null) {
    if (a === 'deselect') { selectRuin(null); return; }
    if (a === 'rebuild') {
      const code = lv.world.rebuild(selectedRuin);
      if (code === 0) { commit({ op: 'rebuild', idx: selectedRuin }); const ru = selectedRuin; void ru; selectedRuin = null; sound.place(2); ui.toast('The building is rising again.', 'good'); afterLocalChange(); rig.shake(0.1); }
      else ui.toast(code === -3 ? 'Something has been built there since.' : 'Not enough resources.', 'bad');
    }
    return;
  }
  if (a === 'multi:upgrade') { multiUpgrade(); return; }
  if (a === 'roads:castle') { selectBuilding(0); return; }
  if (a.startsWith('roads:up:')) {
    const target = Number(a.slice(9)), code = lv.world.upgrade_all_roads(target);
    if (code === 0) { commit({ op: 'upgrade', idx: target, kind: 2 }); sound.upgrade(); ui.toast(`Every road is now ${tierName(37, target).toLowerCase()} or better.`, 'good'); afterLocalChange(); }
    else ui.toast(code === -6 ? 'Not enough resources.' : 'Nothing to resurface.', 'bad');
    return;
  }
  if (a.startsWith('roads:opt:')) {
    const bit = Number(a.slice(10)), s0 = Array.from(lv.world.road_summary_flat()), on = s0[4 + bit] < s0[9], code = lv.world.set_all_road_options(bit, on);
    if (code === 0) { commit({ op: 'option', idx: 0, kind: bit, x: on ? 1 : 0, y: 2 }); sound.upgrade(); afterLocalChange(); }
    else ui.toast(code === -6 ? 'Not enough resources.' : code === -10 ? 'No road is good enough for that yet: resurface them first.' : 'Cannot do that.', 'bad');
    return;
  }
  if (a === 'embassy:open') { openEmbassy(); return; }   // from the Army tab, where no building is selected
  if (selectedIdx === null) return;
  if (a === 'selwalls') { selectWallRun(selectedIdx); return; }
  if (a.startsWith('wk:')) {
    const sf = lv.world.staffing_flat(), o = selectedIdx * 5, row = { max: sf[o + 1], want: sf[o + 2], staff: sf[o + 3] };
    let n = row.want;
    if (a === 'wk:auto') n = -1; else if (a === 'wk:-1') n = stepWant(row, -1); else if (a === 'wk:+1') n = stepWant(row, 1);
    else if (a.startsWith('wk:set:')) n = Math.max(0, Math.min(row.max, Number(a.slice(7)) | 0));
    else if (a === 'wk:kind') { let c = 0; for (let i = 0; i * 5 + 4 < sf.length; i++) if (sf[i * 5] === sf[o] && sf[i * 5 + 1] > 0 && i !== selectedIdx) { if (setWorkers(i, row.want < 0 ? -1 : Math.min(row.want, sf[i * 5 + 1]), true)) c++; } sound.click(); afterLocalChange(); updateHud(); ui.toast(`${c + 1} ${defs[sf[o]].name.toLowerCase()} buildings set alike.`, 'info'); return; }
    if (n !== row.want) setWorkers(selectedIdx, n);
    return;
  }
  if (a === 'diplomacy') { ui.setTab('army'); document.getElementById('attack-box')?.scrollIntoView({ block: 'start' }); return; }
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
  if (a.startsWith('buy:')) {
    const [, rs, ns] = a.split(':'), res = Number(rs), n = Number(ns), code = lv.world.buy(res, n);
    if (code === 0) { commit({ op: 'buy', kind: res, idx: n }); sound.click(); ui.toast(`Bought ${n} ${RES[res].name.toLowerCase()}.`, 'good'); afterLocalChange(); updateHud(); }
    else ui.toast(code === -2 ? 'The stalls have not that much left.' : code === -6 ? 'You cannot pay for that.' : code === -7 ? 'The stores have no room for that.' : 'That is not for sale.', 'bad');
    return;
  }
  if (a === 'rally:0' || a === 'rally:1') { rallyPick = Number(a.slice(6)); ui.hint('Click the ground where new armies should gather.'); return; }
  if (a === 'rally:reset0' || a === 'rally:reset1') {
    const which = Number(a.slice(11));
    if (lv.world.set_rally(which, 0, 0, true) === 0) { commit({ op: 'rally', kind: 2 + which }); sound.click(); ui.toast('New armies gather at the default spot again.', 'good'); updateSelection(); }
    return;
  }
  if (a === 'zone' || a === 'zone:reset') {
    if (a === 'zone') { zoneIdx = selectedIdx; ui.hint('Click the ground where the forester should plant (within 60 of it).'); return; }
    if (lv.world.set_plant_zone(selectedIdx, -2147483648, 0) === 0) { commit({ op: 'zone', idx: selectedIdx, x: 0, y: 0 }); sound.click(); }
    return;
  }
  if (a.startsWith('field:')) {
    const mode = Number(a.slice(6));
    if (lv.world.set_field_mode(selectedIdx, mode) === 0) { commit({ op: 'field', idx: selectedIdx, kind: mode }); sound.click(); afterLocalChange(); }
    return;
  }
  if (a === 'gate') {
    const closed = lv.world.buildings_flat()[selectedIdx * 10 + 6] === 5, code = lv.world.gate_set(selectedIdx, !closed);
    if (code === 0) { commit({ op: 'gate', idx: selectedIdx, kind: closed ? 0 : 1 }); sound.click(); ui.toast(closed ? 'The gate is opened.' : 'The gate is shut and barred.', 'info'); afterLocalChange(); }
    else if (code === -2) ui.toast('Only a stone gatehouse has doors: upgrade the gate.', 'bad');
    return;
  }
  if (a === 'bridge') {
    const up = drawnUp(lv.world.buildings_flat()[selectedIdx * 10 + 6], lv.world.battle_active());
    const code = lv.world.drawbridge_set(selectedIdx, !up);
    if (code === 0) { commit({ op: 'bridge', idx: selectedIdx, kind: up ? 0 : 1 }); sound.click(); ui.toast(up ? 'The drawbridge is lowered.' : 'The drawbridge is drawn up.', 'info'); afterLocalChange(); }
    else if (code === -3) ui.toast('Soldiers are still crossing the drawbridge.', 'bad');
    return;
  }
  if (a === 'embassy:open') { openEmbassy(); return; }
  if (a.startsWith('etab:')) { embassyTab = a.slice(5) === 'dip' ? 'dip' : 'building'; updateSelection(); return; }
  if (a.startsWith('opt:')) {
    const bit = Number(a.slice(4)), on = ((lv.world.options_flat()[selectedIdx] ?? 0) & (1 << bit)) === 0, isRoad = lv.world.buildings_flat()[selectedIdx * 10] === 37;
    const code = isRoad ? lv.world.set_road_option(selectedIdx, bit, on) : lv.world.set_option(selectedIdx, bit, on);
    if (code === 0) { commit(isRoad ? { op: 'option', idx: selectedIdx, kind: bit, x: on ? 1 : 0, y: 1 } : { op: 'option', idx: selectedIdx, kind: bit, x: on ? 1 : 0 }); sound.upgrade(); afterLocalChange(); } else ui.toast(code === -6 ? 'Not enough resources.' : code === -10 ? 'This building needs a better tier first.' : 'Cannot do that.', 'bad');
    return;
  }
  if (a === 'hero') { const code = lv.world.hero_hire(); if (code === 0) { commit({ op: 'hero' }); sound.upgrade(); afterLocalChange(); } else ui.toast(code === -6 ? 'Not enough coin (150).' : code === -4 ? 'You already have a lord.' : 'Cannot do that.', 'bad'); return; }
  if (a === 'deselect') { selectBuilding(null); return; }
  const w = lv.world;
  if (a === 'upgrade') {
    const road = w.buildings_flat()[selectedIdx * 10] === 37, code = road ? w.upgrade_road(selectedIdx) : w.upgrade(selectedIdx);
    if (code === 0) { const f = w.buildings_flat(), o = selectedIdx * 10; commit(road ? { op: 'upgrade', idx: selectedIdx, kind: 1 } : { op: 'upgrade', idx: selectedIdx }); ui.toast('Building upgraded.', 'good'); sound.upgrade(); placedFx(f[o], f[o + 2], f[o + 3], true); }
    else if (code === -3) { ui.toast('Not enough room to grow: demolish the buildings in the way (hover Upgrade to see them).', 'bad'); sound.error(); }
    afterLocalChange(selectedIdx ?? undefined);
  } else if (a === 'demolish') {
    if (w.demolish(selectedIdx)) { const f = w.buildings_flat(); void f; commit({ op: 'demolish', idx: selectedIdx }); sound.demolish(); selectedIdx = null; afterLocalChange(); rig.shake(0.25); }
  }
}

// ---------- input ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
/** The in-game right-click menu: what it offers depends on what is under the pointer. */
function openContext(e: PointerEvent) {
  const r = pointerRay(e), hit = terrain.pick(r.ray), items: Parameters<UI['ctxMenu']>[3] = [];
  const det = pickArmy(e, r, hit), idx = det === null ? pickBuilding(r) : null, ruin = det === null && idx === null ? lv.ruins.pick(r) : null;
  let title = 'The land';
  if (det !== null) {
    selectDet(det); title = `Army ${det}`;
    items.push({ label: 'Halt', sub: 'G', run: () => detAction('halt', det) }, { label: 'Send home', sub: 'B', run: () => detAction('recall', det) }, '-', { label: 'Split in two', run: () => detAction('split', det) }, { label: 'Merge with nearest', run: () => detAction('merge', det) }, '-', { label: 'Enter the place here', run: () => visitPlace(det) });
  } else if (idx !== null) {
    selectBuilding(idx);
    const f = lv.world.buildings_flat(), o = idx * 10, kind = f[o], tier = f[o + 1], hp = lv.world.building_health(), hurt = hp[idx * 3 + 1] > 0 && hp[idx * 3] / hp[idx * 3 + 1] < 0.995 && hp[idx * 3 + 2] <= 0;
    title = tierName(kind, tier);
    if (tier < defs[kind].maxTier) items.push({ label: 'Upgrade', run: () => { selectBuilding(idx); onAct('upgrade'); } });
    if (hurt) items.push({ label: 'Repair', run: () => { selectBuilding(idx); onAct('repair'); } });
    if (kind === 22 && tier >= 2) items.push({ label: f[o + 6] === 5 ? 'Open the gate' : 'Close the gate', run: () => { selectBuilding(idx); onAct('gate'); } });
    if (kind === 23) items.push({ label: drawnUp(f[o + 6], lv.world.battle_active()) ? 'Lower the drawbridge' : 'Raise the drawbridge', run: () => { selectBuilding(idx); onAct('bridge'); } });
    if (kind === 3 || kind === 26) items.push({ label: 'Fill with archers', run: () => { selectBuilding(idx); onAct('garfill'); } }, { label: 'Empty the tower', run: () => { selectBuilding(idx); onAct('garempty'); } });
    if (kind === 15 || kind === 49) items.push({ label: 'Diplomacy…', run: () => onAct('diplomacy') });
    if (kind !== 15) items.push('-', { label: 'Demolish', tip: demolitionTip(lv.world, idx), run: () => { selectBuilding(idx); onAct('demolish'); } });
    if (items.length === 0) items.push({ label: 'Nothing to do here', disabled: true });
  } else if (ruin !== null) {
    selectRuin(ruin); const ru = lv.world.ruins_flat(); title = 'Ruins'; void ru;
    items.push({ label: 'Rebuild', run: () => { selectRuin(ruin); onAct('rebuild'); } });
  } else {
    let rival: Rival | null = null; for (const rv of rivals.values()) if (rv.village.pick(r) !== null) { rival = rv; break; }
    if (rival) { const rv = rival; title = `${rv.name}'s village`; items.push({ label: 'March on this village…', run: () => openEmbassy() }, '-'); }
    if (hit) {
      items.push({ label: 'Look here', run: () => rig.focus(hit.x, hit.z) }, { label: 'Build here…', run: () => ui.setTab('build') });
      for (const id of lv.field.ids()) items.push({ label: `March Army ${id} here`, run: () => { selectDet(id); void orderArmies([id], () => orderMarch(id, hit.x, hit.z)); } });
    }
    const soldiers = Array.from(lv.world.army()).slice(0, 6);
    if (soldiers.some(n => n > 0)) items.push('-', { label: 'Muster every soldier', sub: 'F', run: () => doMuster(soldiers, true) });
  }
  // the world may change while the menu is open (a fire, a raid): then the building indices have moved, so do nothing rather than act on the wrong one
  const cnt = lv.world.building_count();
  for (const it of items) if (it !== '-' && it.run) { const run = it.run; it.run = () => { if (lv.world.building_count() !== cnt) { ui.toast('Things changed while the menu was open — try again.', 'info'); return; } run(); }; }
  ui.ctxMenu(e.clientX, e.clientY, title, items);
}

/** The building under the pointer. A hand-drawn road piece has no model to hit, so it is found by the ground under the pointer: that way it can be selected and taken away again. */
/** The road piece nearest to a spot on the ground if the spot is on or beside a road (within the road's width and a bit more): the roads are long thin strips, so a click anywhere on one picks the
 *  piece of that stretch nearest to the click, not only a click right on a piece (they stand up to nine units apart). */
let roadLinesCache: { w: World; key: string; lines: ReturnType<typeof parseRoadLines> } | null = null;
function roadAt(x: number, z: number): number | null {
  const w = lv.world, f = w.buildings_flat(), key = `${w.building_count()}:${w.terrain_version()}`;
  if (roadLinesCache?.w !== w || roadLinesCache.key !== key) roadLinesCache = { w, key, lines: joinLines(parseRoadLines(w.road_lines_flat())) };
  const lines = roadLinesCache.lines;
  let near = false;
  for (const l of lines) {
    if (l.kind !== 1) continue;
    for (let k = 2; k + 1 < l.pts.length && !near; k += 2) {
      const ax = l.pts[k - 2], az = l.pts[k - 1], dx = l.pts[k] - ax, dz = l.pts[k + 1] - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) <= 2.6) near = true;
    }
    if (near) break;
  }
  let best = -1, bd = near ? 12 : 3.2;
  for (let k = 0; k < f.length; k += 10) if (f[k] === 37) { const d = Math.hypot(f[k + 2] - x, f[k + 3] - z); if (d < bd) { bd = d; best = k / 10; } }
  return best >= 0 ? best : null;
}
function pickBuilding(r: THREE.Raycaster): number | null {
  const i = lv.pick(r); if (i !== null) return i;
  const hit = terrain.pick(r.ray); if (!hit) return null;
  return roadAt(hit.x, hit.z);
}
function pointerRay(e: { clientX: number; clientY: number }) {
  const rect = cachedRect(ui.canvas);
  ndc.set(2 * (e.clientX - rect.left) / rect.width - 1, 1 - 2 * (e.clientY - rect.top) / rect.height);
  ray.setFromCamera(ndc, rig.cam);
  return ray;
}

/** Mines, quarries and clay pits stand against the deposit they work: the building snaps to the nearest matching deposit under the pointer, a few units in front of it on the side
 *  the pointer is on (anywhere round it), turned so its door faces away from the deposit. Returns where to build (relative to the hall) and the turn, or null when there is no such deposit near the pointer. */
const SHORE_KINDS = new Set([29, 35, 41]);
let lastPortSnap: { world: World; key: string; spot: Float32Array } | undefined;
function buildingSnap(kind: number, dx: number, dy: number): { dx: number; dy: number; rot: number } | null {
  if (SHORE_KINDS.has(kind)) {
    const w = lv.world;
    let s: Float32Array;
    if (kind === 35) {
      const key = `${dx}:${dy}:${w.terrain_version()}:${w.building_count()}:${w.tick()}`;
      if (lastPortSnap?.world !== w || lastPortSnap.key !== key) lastPortSnap = { world: w, key, spot: w.port_snap(dx, dy) };
      s = lastPortSnap.spot;
    } else s = kind === 29 ? w.waterwheel_snap(dx, dy) : w.fishing_hut_snap(dx, dy);
    return s.length ? { dx: s[0], dy: s[1], rot: s[2] } : null;
  }
  if (kind === 23) { const s = lv.world.drawbridge_snap(dx, dy); return s.length ? { dx: s[0], dy: s[1], rot: s[2] } : null; }   // a drawbridge snaps onto the moat and lies square across it
  if (kind === 36) { const s = lv.world.toll_snap(dx, dy); return s.length ? { dx: s[0], dy: s[1], rot: s[2] } : null; }   // a toll post snaps onto the nearest road, its gate along it, so the road runs through the gate
  const d = defs[kind]; if (d.req !== 1) return null;
  const f = lv.world.deposits_flat(), px = lv.ox + dx, pz = lv.oz + dy;
  let best = -1, bd = 18 * 18;
  for (let i = 0; i + 4 < f.length; i += 5) {
    if (f[i] !== d.reqArg || f[i + 3] <= 0 || terrain.heightAt(f[i + 1], f[i + 2]) < 0.3) continue;
    const q = (f[i + 1] - px) ** 2 + (f[i + 2] - pz) ** 2; if (q < bd) { bd = q; best = i; }
  }
  if (best < 0) return null;
  const nx = f[best + 1], nz = f[best + 2];
  // it stands on the side of the deposit the pointer is on (in 24 steps all the way round), not just the side facing the village
  let ux = px - nx, uz = pz - nz; if (Math.hypot(ux, uz) < 0.8) { ux = lv.ox - nx; uz = lv.oz - nz; }
  const ang = Math.round(Math.atan2(uz, ux) / (Math.PI / 12)) * (Math.PI / 12); ux = Math.cos(ang); uz = Math.sin(ang);
  const off = kind === 6 ? 4.6 : 3.8, a = Math.atan2(ux, uz);   // (the model's door looks along +z; a turn of r steps points it at (sin, cos) of r * 45 degrees)
  return { dx: Math.round(nx + ux * off - lv.ox), dy: Math.round(nz + uz * off - lv.oz), rot: ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8 };
}

/** Where a road point clicked at (x, z) goes: onto the node or piece of road within reach, or where it was clicked. */
function roadPoint(x: number, z: number): { x: number; z: number; snapped: boolean } {
  const sn = lv.world.road_snap(Math.round(x - lv.ox), Math.round(z - lv.oz));
  return sn.length ? { x: lv.ox + sn[0], z: lv.oz + sn[1], snapped: true } : { x, z, snapped: false };
}
function roadReset() { roadPts = []; roadSnapped = [false, false]; if (typeof penPreview !== 'undefined') penPreview?.clear(); lv?.nodes.highlight(null); }
let roadSnapped: [boolean, boolean] = [false, false];   // whether the first and the last point clicked snapped onto something
/** Show the road the clicks and the pointer would make: a post at every piece (green where it can go, red where not) and the curve through them. */
function roadPreview(hover: { x: number; z: number; snapped: boolean } | null) {
  const w = lv.world, ctrl: Pt[] = [...roadPts]; if (hover) ctrl.push(hover);
  if (!ctrl.length) { penPreview.clear(); return; }
  const pieces = subdivide(ctrl), line = curve(pieces), stocks = Array.from(w.stocks());
  const snappedAt = (i: number) => (i === 0 && roadSnapped[0]) || (hover?.snapped && i === pieces.length - 1);
  let bad = 0; const posts = pieces.map((q, i) => { const ok = snappedAt(i) || w.road_can(Math.round(q.x - lv.ox), Math.round(q.z - lv.oz)) === 0; if (!ok) bad++; return { x: q.x, z: q.z, ok }; });
  penPreview.set(posts, line);
  const wood = Math.max(0, pieces.length - (roadSnapped[0] ? 1 : 0) - (hover?.snapped ? 1 : 0));
  ui.hint(ctrl.length < 2 ? placeHint(37) : `Road: ${pieces.length} points, ${wood} wood${stocks[0] < wood ? ' — not enough wood' : ''}${bad ? ` · ${bad} of the points cannot be laid (check the map edge, water and obstructions)` : ''} · double-click or Enter to build`, bad > 0 || stocks[0] < wood);
}
function roadHover(e: { clientX: number; clientY: number }) {
  if (ghost) ghost.visible = false; if (ghostRing) ghostRing.visible = false; if (levelDisc) levelDisc.visible = false; anchorGhost?.hide(); anchorKey = ''; covGhost(null);
  const hit = terrain.pick(pointerRay(e).ray); if (!hit) { lv.nodes.highlight(null); return; }
  const p = roadPoint(hit.x, hit.z); lv.nodes.highlight(p.snapped ? p : null); roadPreview(p);
}
/** Click: add a point. A click on a node or a road ends it (when there is a start), a quick second click on the same point ends it too. */
function roadClick(hx: number, hz: number) {
  const p = roadPoint(hx, hz), now = performance.now(), last = roadPts[roadPts.length - 1];
  if (!roadPts.length) { roadPts.push({ x: p.x, z: p.z }); roadSnapped = [p.snapped, false]; roadLastClick = now; roadPreview(null); return; }
  if (last && now - roadLastClick < 350 && Math.hypot(p.x - last.x, p.z - last.z) < 4) { roadCommit(); return; }
  roadPts.push({ x: p.x, z: p.z }); roadLastClick = now;
  if (p.snapped && roadPts.length >= 2) { roadSnapped[1] = true; roadCommit(); return; }
  roadPreview(null);
}
function roadCommit() {
  const picked = [...roadPts]; roadPts = [];
  if (picked.length < 2) { roadReset(); return; }
  const pts = subdivide(picked); if (pts.length > 64) { ui.toast('That road is too long for one go: lay it in stretches.', 'bad'); roadReset(); return; }
  const flat = pts.flatMap(q => [Math.round(q.x - lv.ox), Math.round(q.z - lv.oz)]), before = lv.world.building_count();
  const code = lv.world.lay_road(Int32Array.from(flat)), made = lv.world.building_count() - before;
  if (made > 0) { commit({ op: 'road', units: flat }); afterLocalChange(); sound.place(2); updateHud(); const reaches = (lv.world.road_joined_flat()[lv.world.building_count() - 1] ?? 0) === 1;
    ui.toast(code < 0 ? `${made} points of the road laid — ${PLACE_ERRORS[code] ?? 'then something was in the way'}.` : reaches ? 'Road laid — it reaches the castle.' : 'Road laid — it does not reach the castle yet: workplaces on it still work at half pace.', code < 0 || !reaches ? 'info' : 'good'); }
  else { ui.toast(PLACE_ERRORS[code] ?? 'Nothing could be laid there.', 'bad'); sound.error(); }
  roadReset(); lv.nodes.setActive(selectedKind === 37);
}

function setLevelRadius(r: number) { levelR = r; levelCode = 99; levelHintKey = ''; ui.setLevelCost(Array.from(World.level_cost_flat(r))); drawLevelBar(); ui.hint(placeHint(LEVEL_TOOL)); updateHud(); }
/** Choose the height the level-ground tool levels to: a number (kept to half-unit steps) or Auto (the land round the patch). */
function setLevelHeight(h: number) {
  const value = h < 0 ? LEVEL_AUTO : clampLevelHeight(h), kind = selectedKind;
  if (isEarthwork(kind)) earthworkH = value;
  else if (kind === LEVEL_TOOL) levelH = value;
  else return;
  levelCode = 99; levelHintKey = ''; ghostCode = 99;
  drawLevelBar(); ui.hint(placeHint(kind)); if (lastGhostE) updateGhost(lastGhostE);
}

function placementCheck(w: World, kind: number, dx: number, dy: number) {
  return isEarthwork(kind) && earthworkH >= 0 ? w.earthwork_check(kind, dx, dy, earthworkH) : w.can_place(kind, dx, dy);
}

function buildingTarget(kind: number, dx: number, dy: number) {
  const snap = buildingSnap(kind, dx, dy);
  if (!snap && SHORE_KINDS.has(kind)) return { dx, dy, rot, code: -16 };
  const target = snap ?? { dx, dy, rot };
  return { ...target, code: placementCheck(lv.world, kind, target.dx, target.dy) };
}
/** The level-ground tool's bar at the bottom: the patch sizes and the Target height (Auto or a number, with the ground height under the pointer). */
function drawLevelBar() {
  let bar = document.getElementById('levelbar');
  const raisingOrLowering = isEarthwork(selectedKind);
  if (!raisingOrLowering && selectedKind !== LEVEL_TOOL) { bar?.remove(); return; }
  const btn = 'cursor:pointer;border-radius:5px;border:1px solid #6d5a38;background:#2a2014;color:#f1e4c3;font:12px system-ui,sans-serif';
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'levelbar'; bar.className = 'tool-panel';
    bar.innerHTML = `<div id="level-sizes" style="display:flex;gap:4px"></div>
      <div id="level-height" style="display:flex;flex-direction:column;gap:3px;justify-content:center;min-width:230px;border-left:1px solid #6d5a38;padding-left:10px">
        <div style="display:flex;gap:6px;align-items:center"><b>Target height</b><span id="lh-val" style="color:#ffe08a"></span><button id="lh-auto" title="Level to the land just outside the patch" style="${btn};margin-left:auto;padding:2px 8px">Auto</button></div>
        <div style="display:flex;gap:6px;align-items:center"><input id="lh-range" aria-label="Target height" type="range" min="${LEVEL_HEIGHT.min}" max="${LEVEL_HEIGHT.max}" step="${LEVEL_HEIGHT_STEP}" style="flex:1"><input id="lh-num" aria-label="Target height in units" type="number" min="${LEVEL_HEIGHT.min}" max="${LEVEL_HEIGHT.max}" step="${LEVEL_HEIGHT_STEP}" style="width:56px"></div>
        <div id="lh-ground" style="opacity:.8"></div></div>`;
    bar.onclick = e => {
      const t = e.target as HTMLElement; const b = t.closest<HTMLElement>('[data-r]'); if (b) { setLevelRadius(Number(b.dataset.r)); return; }
      if (t.id === 'lh-auto') setLevelHeight(LEVEL_AUTO);
    };
    const range = bar.querySelector<HTMLInputElement>('#lh-range')!, num = bar.querySelector<HTMLInputElement>('#lh-num')!;
    range.oninput = () => setLevelHeight(Number(range.value));
    num.onchange = () => { const v = Number(num.value); if (num.value !== '' && Number.isFinite(v)) setLevelHeight(v); else drawLevelBar(); };
    num.onkeydown = e => e.stopPropagation(); num.onkeyup = e => e.stopPropagation();   // (typing a height must not trigger the game's keys)
    document.getElementById('tool-dock')!.appendChild(bar);
  }
  bar.querySelector<HTMLElement>('#level-height')!.style.borderLeftWidth = raisingOrLowering ? '0' : '1px';
  bar.querySelector<HTMLElement>('#level-height')!.style.paddingLeft = raisingOrLowering ? '0' : '10px';
  bar.querySelector('#level-sizes')!.innerHTML = raisingOrLowering ? '' : LEVEL_SIZES.map(r => `<button data-r="${r}" title="Level a patch ${r} wide" style="cursor:pointer;min-width:44px;padding:5px 6px;border-radius:5px;border:1px solid ${r === levelR ? '#ffe08a' : '#6d5a38'};background:${r === levelR ? '#7a5a22' : '#2a2014'};color:#f1e4c3;font:16px system-ui,sans-serif"><span style="display:block;line-height:0;height:24px">${icon('levelground', 24, { mono: true })}</span><span style="font-size:10px">${r}</span></button>`).join('');
  const height = raisingOrLowering ? earthworkH : levelH, auto = height < 0;
  const autoText = raisingOrLowering ? `Auto (${selectedKind === 33 ? '+2.2' : '−2.2'})` : 'Auto (the land round it)';
  bar.querySelector('#lh-val')!.textContent = auto ? autoText : levelHeightLabel(height);
  bar.querySelector('#lh-ground')!.textContent = '';
  const range = bar.querySelector<HTMLInputElement>('#lh-range')!, num = bar.querySelector<HTMLInputElement>('#lh-num')!, ab = bar.querySelector<HTMLElement>('#lh-auto')!;
  if (document.activeElement !== num) num.value = auto ? '' : String(height);
  num.placeholder = 'Auto'; ab.title = autoText; range.value = String(auto ? 5 : height); range.style.opacity = auto ? '.55' : '1';
  ab.style.background = auto ? '#7a5a22' : '#2a2014'; ab.style.borderColor = auto ? '#ffe08a' : '#6d5a38';
}

function placementError(kind: number, code: number) {
  if (kind === 35 && code === -16) return 'Choose a shore with enough open water for the pier.';
  if (code === -2 && [23, 24, 35, 37, 38].includes(kind)) return 'Outside the buildable map';
  return PLACE_ERRORS[code] ?? 'Cannot build here';
}
/** Hover with the level-ground tool: a ring and a flat disc at the height the patch would be levelled to (ring green when it can be done, red with the reason when not; disc blue where
 *  earth is added, orange where it is cut away), and what it costs. */
function levelHover(e: { clientX: number; clientY: number }) {
  lastGhostE = e;
  if (ghost) ghost.visible = false; covGhost(null);
  const hit = terrain.pick(pointerRay(e).ray); if (!hit) { ghostRing.visible = false; levelDisc.visible = false; anchorGhost?.hide(); anchorKey = ''; return; }
  const w = lv.world, dx = Math.round(hit.x - lv.ox), dy = Math.round(hit.z - lv.oz), code = w.level_check(dx, dy, levelR, levelH);
  const ground = w.height_at(hit.x, hit.z);
  const planned = code === 0 || code === -6 || code === -26;
  const h = planned ? w.level_target(dx, dy, levelR, levelH) : ground;
  // the mean of the ground inside the patch tells filling from cutting
  let sum = 0, n = 0; for (let k = 0; k < 13; k++) { const a = k === 0 ? 0 : (k - 1) * Math.PI / 6, r = k === 0 ? 0 : levelR * (k % 2 ? 0.45 : 0.9); sum += w.height_at(lv.ox + dx + Math.cos(a) * r, lv.oz + dy + Math.sin(a) * r); n++; }
  const work = levelWork(sum / n, h);
  const y = (h > -100 ? h : 0);
  ghostRing.visible = true; ghostRing.position.set(lv.ox + dx, y + 0.14, lv.oz + dy); ghostRing.scale.setScalar(levelR); ghostRing.rotation.y = 0;
  (ghostRing.material as THREE.MeshBasicMaterial).color.setHex(code === 0 ? 0x66ff88 : 0xff6655);
  levelDisc.visible = planned; levelDisc.position.set(lv.ox + dx, y + 0.08, lv.oz + dy); levelDisc.scale.setScalar(levelR);
  (levelDisc.material as THREE.MeshBasicMaterial).color.setHex(work.kind === 'cut' ? 0xffa940 : work.kind === 'fill' ? 0x5fb3ff : 0xd8d8d8);
  const gl = document.getElementById('lh-ground'); if (gl) gl.textContent = `Ground here: ${ground.toFixed(1)}` + (planned ? ` · patch to ${h.toFixed(1)}` : '');
  const cost = Array.from(World.level_cost_flat(levelR)); const costText = cost.length ? ' · costs ' + Array.from({ length: cost.length / 2 }, (_, i) => `${cost[2 * i + 1]} ${RES[cost[2 * i]].name.toLowerCase()}`).join(', ') : '';
  const text = code === 0 ? `Level ${levelR} wide to ${h.toFixed(1)}${levelH < 0 ? ' (Auto)' : ''}: ${work.kind === 'even' ? 'the ground is already about that height' : work.kind === 'fill' ? `earth added, about ${work.by.toFixed(1)} on average` : `earth cut away, about ${work.by.toFixed(1)} on average`}${costText} — click to level · R changes the size`
    : code === -6 ? `${PLACE_ERRORS[code]}${costText}` : PLACE_ERRORS[code] ?? 'Cannot level here';
  const key = `${code}|${text}`; if (key !== levelHintKey) { levelHintKey = key; levelCode = code; ui.hint(text, code !== 0); }
}
/** Hover with the planting brush: a ring the size of the brush. */
function plantHover(e: { clientX: number; clientY: number }) {
  lastGhostE = e;
  if (ghost) ghost.visible = false; covGhost(null);
  const hit = terrain.pick(pointerRay(e).ray); if (!hit) { ghostRing.visible = false; return; }
  ghostRing.visible = true; ghostRing.position.set(hit.x, hit.y + 0.14, hit.z); ghostRing.scale.setScalar(plantR); ghostRing.rotation.y = 0;
  (ghostRing.material as THREE.MeshBasicMaterial).color.setHex(0x66ff88);
}
/** Click with the planting brush: the core plants what fits (trees keep their distance, stay off buildings and water and inside your land) for a wood each. */
function plantClick(e: { clientX: number; clientY: number }) {
  const hit = terrain.pick(pointerRay(e).ray); if (!hit) return;
  const dx = Math.round(hit.x - lv.ox), dy = Math.round(hit.z - lv.oz), n = lv.world.plant_trees(dx, dy, plantR);
  if (n > 0) { commit({ op: 'plant', x: dx, y: dy, kind: plantR }); afterLocalChange(); sound.place(3); updateHud(); ui.hint(`Planted ${n} tree${n === 1 ? '' : 's'}. ${placeHint(PLANT_TOOL)}`); }
  else { const msg = lv.world.stocks()[0] < 1 ? 'No wood to plant with.' : 'No room to plant here: trees need free ground inside your land.'; ui.hint(msg, true); ui.toast(msg, 'bad'); sound.error(); }
}
/** The rally point of the barracks (0) or the castle (1): where a new army stands. By default it is outside, at the road node in front of the building. */
function rallyHtml(which: number) {
  const r = lv.world.rally_flat(which), mine = r[2] === 1, name = which === 0 ? 'barracks' : 'castle';
  return `<div><h3>Rally point</h3><p class="muted">New armies from the ${name} gather ${mine ? 'at the spot you chose' : 'outside, at the road in front of it'} (${Math.round(r[0])}, ${Math.round(r[1])}).</p><div class="btnrow" style="flex-wrap:wrap"><button class="pbtn" data-act="rally:${which}">Set rally point…</button>${mine ? `<button class="pbtn" data-act="rally:reset${which}">Back to the default</button>` : ''}</div></div>`;
}
/** A click on the ground while a rally point is being chosen. */
function rallyClick(e: { clientX: number; clientY: number }) {
  const which = rallyPick; rallyPick = null; if (which === null) return;
  const hit = terrain.pick(pointerRay(e).ray); if (!hit) return;
  const x = Math.round(hit.x), y = Math.round(hit.z);
  if (lv.world.set_rally(which, x, y, false) === 0) { commit({ op: 'rally', kind: which, x, y }); sound.click(); ui.toast('New armies will gather there.', 'good'); updateSelection(); }
  else ui.toast('Armies cannot gather there: pick open ground within the village.', 'bad');
  ui.hint('');
}
/** A click on the ground while a forester's zone is being chosen: it plants round that spot from now on. */
function zoneClick(e: { clientX: number; clientY: number }) {
  const idx = zoneIdx; zoneIdx = null; if (idx === null) return;
  const hit = terrain.pick(pointerRay(e).ray); if (!hit) return;
  const f = lv.world.buildings_flat(), o = idx * 10, dx = Math.round(hit.x - f[o + 2]), dy = Math.round(hit.z - f[o + 3]);
  if (lv.world.set_plant_zone(idx, dx, dy) === 0) { commit({ op: 'zone', idx, x: dx, y: dy }); sound.click(); ui.toast('The forester will plant there.', 'good'); }
  else ui.toast('Too far from the forester: the planting zone must be within 60 of it.', 'bad');
  ui.hint('');
}

/** Click with the level-ground tool. */
function levelClick(e: { clientX: number; clientY: number }) {
  const hit = terrain.pick(pointerRay(e).ray); if (!hit) return;
  const dx = Math.round(hit.x - lv.ox), dy = Math.round(hit.z - lv.oz), code = lv.world.level_ground(dx, dy, levelR, levelH);
  if (code === 0) { commit(levelH < 0 ? { op: 'level', x: dx, y: dy, kind: levelR } : { op: 'level', x: dx, y: dy, kind: levelR, h: levelH }); levelCode = 99; levelHintKey = ''; afterLocalChange(); sound.place(3); ui.toast('The ground is levelled.', 'good'); levelHover(e); }
  else { ui.hint(PLACE_ERRORS[code] ?? 'Cannot level here', true); ui.toast(PLACE_ERRORS[code] ?? 'Cannot level here', 'bad'); sound.error(); }
}

/** The road anchors of the building being placed (see render/anchorghost.ts): its node rings (and stub from the door) from the core's own node computation, and the nodes or roads they would join. */
function showAnchors(key: string, nodes: number[], door: { x: number; z: number } | null, ok: boolean) {
  if (!anchorGhost || key === anchorKey) return;
  anchorKey = key;
  const shape = anchorShape(nodes, nodes.length === 2 ? door : null), w = lv.world;
  const joins = shape.rings.map(r => { const s = w.road_snap(Math.round(r.x - lv.ox), Math.round(r.z - lv.oz)); return s.length === 4 ? { x: lv.ox + s[0], z: lv.oz + s[1] } : null; });
  anchorGhost.show(shape, joins, ok);
}

function hidePlacementGhost() {
  blockRings.forEach(r => (r.visible = false));
  terrain.clearPreview(); previewKey = ''; previewKey2 = ''; ghostCode = 99;
  if (ghost) ghost.visible = false;
  ghostRing.visible = false; builderRangeRing.visible = false;
  if (levelDisc) levelDisc.visible = false;
  anchorGhost?.hide(); anchorKey = ''; covGhost(null);
}

function updateGhost(e: { clientX: number; clientY: number }) {
  lastGhostE = e;
  if (selectedKind === PLANT_TOOL) { plantHover(e); return; }
  if (selectedKind === LEVEL_TOOL) { levelHover(e); return; }
  if (selectedKind === 37) { roadHover(e); return; }
  if (selectedKind === null || !ghost) return;
  const hit = terrain.pick(pointerRay(e).ray);
  if (!hit) { placedPointer = null; hidePlacementGhost(); return; }
  const w = lv.world, dx = Math.round(hit.x - lv.ox), dy = Math.round(hit.z - lv.oz);
  if (placedPointer?.dx === dx && placedPointer.dy === dy) return;
  placedPointer = null;
  if (selectedKind === 38) {   // a bridge snaps to the water: the ghost shows the crossing it would make, stretched to its real length
    const bp = w.bridge_preview(dx, dy), code = bp[0];
    if (bp.length < 8) { ghost.visible = false; ghostRing.visible = false; if (levelDisc) levelDisc.visible = false; anchorGhost?.hide(); anchorKey = ''; builderRangeRing.visible = false; if (code !== ghostCode) { ghostCode = code; ui.hint(placementError(38, code), true); } return; }
    const [, cx, cz, ang, len, span, planks, wood] = Array.from(bp), ux = Math.cos(ang), uz = Math.sin(ang), hA = terrain.heightAt(cx - ux * len / 2, cz - uz * len / 2), hB = terrain.heightAt(cx + ux * len / 2, cz + uz * len / 2);
    terrain.clearPreview(); previewKey = '';
    ghost.visible = true; ghostRing.visible = false; if (levelDisc) levelDisc.visible = false; showAnchors(`38:${cx.toFixed(1)}:${cz.toFixed(1)}:${code}`, Array.from(bp).slice(8, 12), null, code === 0); ghost.position.set(cx, (hA + hB) / 2, cz); ghost.rotation.set(0, -ang, 0); ghost.scale.set(len / 10, 1, 1);
    const key = `${code}:${cx.toFixed(1)}:${cz.toFixed(1)}`;
    if (key !== previewKey2) {
      previewKey2 = key; ghostCode = code;
      ghost.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { const mm = m.material as THREE.MeshStandardMaterial; mm.emissive.setHex(code === 0 ? 0x22cc55 : 0xdd2a1a); mm.emissiveIntensity = code === 0 ? 0.32 : 0.5; } });
      ui.hint(code === 0 ? `Bridge · ${span.toFixed(0)} units of water, ${len.toFixed(0)} long · ${planks} planks, ${wood} wood · supports go in the middle where needed · click to build` : PLACE_ERRORS[code] ?? 'Cannot build here', code !== 0);
    }
    return;
  }
  if (ghost.scale.x !== 1) ghost.scale.set(1, 1, 1);
  let { code, dx: gx, dy: gy, rot: grot } = buildingTarget(selectedKind, dx, dy);
  const shore = SHORE_KINDS.has(selectedKind);
  if (selectedKind === 22) {   // a gate takes the place of a wall piece and lines up with the wall
    const t = gateTarget(hit.x, hit.z);
    if (t) { gx = Math.round(t.x - lv.ox); gy = Math.round(t.z - lv.oz); grot = t.rot; const st = Array.from(w.stocks()); code = defs[22].cost.every(([r, n]) => st[r] >= n) ? 0 : -6; } else code = -3;
  }
  const x = lv.ox + gx, z = lv.oz + gy, d = defs[selectedKind];
  blockRings.forEach(r => (r.visible = false));
  if (code === -3 || code === -17) {
    const blockers = w.placement_obstructions(selectedKind, gx, gy);
    for (let i = 0; i < blockers.length && i / 3 < blockRings.length; i += 3) {
      const ring = blockRings[i / 3]; ring.set(blockers[i], blockers[i + 1], blockers[i + 2]); ring.visible = true;
    }
  }
  const pad = !NOPAD.has(selectedKind) && !shore;
  const h = pad || shore || OVER_WATER_KINDS.has(selectedKind)
    ? w.placement_height(selectedKind, x, z, grot)
    : terrain.heightAt(x, z, true);
  const showPad = pad && (code === 0 || code === -6);
  const key = `${selectedKind}:${x}:${z}:${h}:${showPad}`;
  if (key !== previewKey) { previewKey = key; if (showPad) terrain.setPreview(x, z, d.r * 1.15 + 0.5, h); else terrain.clearPreview(); }
  if (selectedKind === 35) (ghost.userData.model as BuildingModel).fitPortPier(x, z, grot, h, (x, z) => terrain.heightAt(x, z, true));
  else if (shore) (ghost.userData.model as BuildingModel).fitShore(h - w.shore_water_height(x, z, grot));
  if (isEarthwork(selectedKind)) {
    const ground = document.getElementById('lh-ground');
    if (ground) ground.textContent = `Ground here: ${w.height_at(x, z).toFixed(1)}`;
    levelDisc.visible = earthworkH >= 0 && code === 0;
    if (levelDisc.visible) {
      levelDisc.position.set(x, earthworkH + 0.08, z); levelDisc.scale.setScalar(1.2);
      (levelDisc.material as THREE.MeshBasicMaterial).color.setHex(selectedKind === 33 ? 0x5fb3ff : 0xffa940);
    }
  }
  ghost.visible = true; ghost.position.set(x, h, z); ghost.rotation.y = grot * Math.PI / 4; covGhost({ x, z });
  { const di = selectedKind !== 23 ? door_info(selectedKind, 0) : null; showAnchors(`${selectedKind}:${x}:${z}:${grot}:${code}`, Array.from(w.node_preview(selectedKind, 0, x, z, grot & 7)), di ? doorInWorld(di, x, z, grot) : null, code === 0); }
  ghostRing.visible = true; ghostRing.position.set(x, h + 0.14, z); if (selectedKind === 23) { ghostRing.scale.set(2.4, 1, 7.4); ghostRing.rotation.y = grot * Math.PI / 4; } else { ghostRing.scale.setScalar(d.r * 1.05); ghostRing.rotation.y = 0; }   // (a drawbridge's outline is long: it covers the whole deck)
  builderRangeRing.visible = selectedKind === 20; builderRangeRing.position.set(x, h + 0.12, z); builderRangeRing.scale.setScalar(70);
  if (code !== ghostCode) {
    ghostCode = code;
    ghost.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { const mm = m.material as THREE.MeshStandardMaterial; mm.emissive.setHex(code === 0 ? 0x22cc55 : 0xdd2a1a); mm.emissiveIntensity = code === 0 ? 0.32 : 0.55; } });
    (ghostRing.material as THREE.MeshBasicMaterial).color.setHex(code === 0 ? 0x66ff88 : 0xff6655);
    ui.hint(code === 0 ? placeHint(selectedKind) : placementError(selectedKind, code), code !== 0);
  }
}

/** Touch has no Shift or Ctrl: while this is on, a tap adds a building or an army to the selection (or takes it out) instead of replacing it. */
let touchMulti = false;
function setTouchMulti(on: boolean) { touchMulti = on; document.getElementById('touch-multi')!.setAttribute('aria-pressed', String(on)); }
function showTouchTools() {
  document.getElementById('touch-tools')!.hidden = selectedKind === null;
  const somethingSelected = selectedIdx !== null || multiSel.length > 0 || selectedDet !== null;
  document.getElementById('touch-select')!.hidden = !touchInput || selectedKind !== null || (!somethingSelected && !touchMulti);
  if (selectedKind !== null && touchMulti) setTouchMulti(false);
  document.getElementById('touch-tools')!.classList.toggle('touch-active', touchInput);
  const path = selectedKind === 37 || (selectedKind !== null && !!PEN_SPACING[selectedKind] && penShape === 'path');
  document.getElementById('touch-finish')!.hidden = !path;
  document.getElementById('touch-undo')!.hidden = !path;
  const rotate = document.getElementById('touch-rotate')!;
  const build = document.getElementById('touch-build') as HTMLButtonElement;
  build.hidden = !touchInput || path || (selectedKind !== null && !!PEN_SPACING[selectedKind] && isFigure(penShape));
  build.disabled = !touchPlacement || (selectedKind === PLANT_TOOL ? false : selectedKind === LEVEL_TOOL ? levelCode !== 0 : ghostCode !== 0);
  rotate.hidden = path && selectedKind !== 24;
  rotate.textContent = selectedKind === LEVEL_TOOL || selectedKind === PLANT_TOOL ? 'Size' : selectedKind === 24 ? 'Width' : 'Rotate';
}

function touchPlacementEvent() {
  if (!touchPlacement) return null;
  const { x, z } = touchPlacement;
  const p = new THREE.Vector3(x, terrain.heightAt(x, z, true), z).project(rig.cam);
  const rect = cachedRect(ui.canvas);
  return { clientX: rect.left + (p.x + 1) * rect.width / 2, clientY: rect.top + (1 - p.y) * rect.height / 2 };
}

function touchPreviewHit(e: { clientX: number; clientY: number }) {
  let p = touchPlacementEvent();
  if (p && ghost?.visible) {
    const at = ghost.position.clone().project(rig.cam), rect = cachedRect(ui.canvas);
    p = { clientX: rect.left + (at.x + 1) * rect.width / 2, clientY: rect.top + (1 - at.y) * rect.height / 2 };
  }
  return p !== null && Math.hypot(p.clientX - e.clientX, p.clientY - e.clientY) < 48;
}

function previewTouchPlacement(e: { clientX: number; clientY: number }) {
  const hit = terrain.pick(pointerRay(e).ray);
  if (!hit) return;
  touchPlacement = { x: hit.x, z: hit.z };
  placedPointer = null;
  updateGhost(e); showTouchTools();
}

function finishStroke() {
  if (selectedKind === 37 && roadPts.length >= 2) { roadCommit(); return true; }
  if (selectedKind !== null && penShape === 'path' && penPath.length >= 2) {
    penCommit(selectedKind, { pts: [...penPath], closed: false }); penReset(); return true;
  }
  return false;
}

function undoStroke() {
  if (selectedKind === 37 && roadPts.length) { roadPts.pop(); if (!roadPts.length) roadSnapped = [false, false]; roadPreview(null); return true; }
  if (penShape === 'path' && penPath.length) { penPath.pop(); if (!penPath.length) penPreview.clear(); return true; }
  return false;
}

/** Rotate goes round in 8 steps one way; held down, it steps back the other way (so one step too far costs a hold, not seven taps). */
function rotateTool(dir: 1 | -1 = 1) {
  if (selectedKind === PLANT_TOOL) { plantR = plantR >= 8 ? 2 : plantR + 2; ui.hint(placeHint(PLANT_TOOL)); const e = touchPlacementEvent(); if (e) updateGhost(e); return; }
  if (selectedKind === LEVEL_TOOL) { setLevelRadius(nextLevelSize(levelR)); const e = touchPlacementEvent(); if (e) updateGhost(e); showTouchTools(); return; }
  rot = (rot + dir + 8) % 8;
  if (selectedKind === 24) { moatWidth = rot; ui.hint(placeHint(24)); }
  ghostCode = 99; previewKey = '';
  const e = touchPlacementEvent() ?? lastGhostE;
  if (e && selectedKind !== null) updateGhost(e);
  showTouchTools();
}

function buildAtPointer(e: { clientX: number; clientY: number }) {
  if (selectedKind === null) return;
  const hit = terrain.pick(pointerRay(e).ray); if (!hit) return;
  const dx = Math.round(hit.x - lv.ox), dy = Math.round(hit.z - lv.oz), kind = selectedKind;
  if (kind === 22) {   // gate: replaces the wall piece under the pointer
    const t = gateTarget(hit.x, hit.z); if (!t) { ui.hint('Click a wall piece to put the gate in', true); sound.error(); return; }
    const gx = Math.round(t.x - lv.ox), gy = Math.round(t.z - lv.oz), st = Array.from(lv.world.stocks());
    if (!defs[22].cost.every(([r, n]) => st[r] >= n)) { ui.hint(PLACE_ERRORS[-6], true); sound.error(); return; }
    lv.world.demolish(t.idx); commit({ op: 'demolish', idx: t.idx });
    const gres = lv.world.place(22, gx, gy, t.rot);
    if (gres >= 0) { commit({ op: 'place', kind: 22, x: gx, y: gy, rot: t.rot }); autoBridge(gx, gy); } else if (lv.world.place(2, gx, gy, t.rot) >= 0) commit({ op: 'place', kind: 2, x: gx, y: gy, rot: t.rot });
    ghostCode = 99; previewKey = ''; afterLocalChange(); if (gres >= 0) { touchPlacement = null; hidePlacementGhost(); placedFx(22, lv.ox + gx, lv.oz + gy); } else ui.hint(PLACE_ERRORS[gres] ?? 'Cannot build a gate here', true);
    return;
  }
  const { code, dx: px, dy: py, rot: prot } = buildingTarget(kind, dx, dy);
  const manual = isEarthwork(kind) && earthworkH >= 0;
  const res = code !== 0 ? code : manual ? lv.world.place_earthwork(kind, px, py, prot, earthworkH) : lv.world.place(kind, px, py, prot);
  if (res >= 0) {
    const cmd = { op: 'place' as const, kind, x: px, y: py, rot: prot };
    commit(manual ? { ...cmd, h: earthworkH } : cmd);
    touchPlacement = null; placedPointer = { dx, dy }; hidePlacementGhost(); ui.hint(placeHint(kind));
    afterLocalChange(res); placedFx(kind, lv.ox + px, lv.oz + py); showTouchTools();
  }
  else { placedPointer = null; ghostCode = 99; updateGhost(e); ui.hint(placementError(kind, res), true); sound.error(); }

}

/** A fingertip covers about 40 CSS pixels: when the exact ray misses, a tap still picks the building whose centre is drawn within this many pixels of it. */
const TOUCH_PICK_PIXELS = 28;
function buildingNearTap(e: { clientX: number; clientY: number }): number | null {
  const f = lv.world.buildings_flat(), v = new THREE.Vector3(), rect = cachedRect(ui.canvas), out: { i: number; sx: number; sy: number }[] = [];
  for (let o = 0; o + 9 < f.length; o += 10) {
    v.set(f[o + 2], terrain.heightAt(f[o + 2], f[o + 3], true) + 1.5, f[o + 3]).project(rig.cam);
    if (v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) out.push({ i: o / 10, sx: rect.left + (v.x + 1) * rect.width / 2, sy: rect.top + (1 - v.y) * rect.height / 2 });
  }
  return nearestWithin(out, e.clientX, e.clientY, TOUCH_PICK_PIXELS)?.i ?? null;
}

function bindInput() {
  const cv = ui.canvas;
  // touch: hold a finger still for half a second to open the action menu (or send the selected armies). A ring fills under the finger meanwhile, and the menu
  // opens while the finger is still down, so a hold is never mistaken for a slow tap.
  let pressRing: HTMLElement | null = null;   // made on the first hold, so nothing is added to the page for mouse players
  let press: { timer: ReturnType<typeof setTimeout>; id: number; x: number; y: number } | null = null;
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } if (pressRing) { pressRing.hidden = true; pressRing.classList.remove('go'); } };
  const startPress = (e: PointerEvent) => {
    cancelPress();
    if (!pressRing) { pressRing = document.createElement('div'); pressRing.id = 'press-ring'; pressRing.hidden = true; document.body.appendChild(pressRing); }
    pressRing.style.left = `${e.clientX}px`; pressRing.style.top = `${e.clientY}px`; pressRing.hidden = false;
    void pressRing.offsetWidth; pressRing.classList.add('go');   // (re)start the fill animation
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      const ok = press?.id === e.pointerId && down?.id === e.pointerId && !rig.touchConsumed;
      cancelPress();
      if (!ok) return;
      try { navigator.vibrate?.(12); } catch { /* no vibration (iPhone, iPad) */ }
      dropStroke(); contextAction(e);
    }, 500) };
  };
  document.getElementById('touch-multi')!.onclick = () => { setTouchMulti(!touchMulti); showTouchTools(); };
  let movingTouchPreview = false;
  let down: { x: number; y: number; id: number; at: number } | null = null, hoverT = 0, routeT = 0;
  { // Rotate: a tap turns one way, a hold (400 ms) turns back the other way
    const btn = document.getElementById('touch-rotate')!;
    let held: ReturnType<typeof setTimeout> | null = null, fired = false;
    btn.onpointerdown = () => { fired = false; if (held) clearTimeout(held); held = setTimeout(() => { held = null; fired = true; rotateTool(-1); }, 400); };
    btn.onpointerup = btn.onpointercancel = btn.onpointerleave = () => { if (held) { clearTimeout(held); held = null; } };
    btn.onclick = () => { if (fired) { fired = false; return; } rotateTool(1); };
  }
  document.getElementById('touch-build')!.onclick = () => {
    const e = touchPlacementEvent();
    if (!e || selectedKind === null) return;
    updateGhost(e);
    if (selectedKind === PLANT_TOOL) { plantClick(e); touchPlacement = null; hidePlacementGhost(); }
    else if (selectedKind === LEVEL_TOOL) { levelClick(e); touchPlacement = null; hidePlacementGhost(); }
    else buildAtPointer(e);
    showTouchTools();
  };
  document.getElementById('touch-finish')!.onclick = () => { if (!finishStroke()) ui.hint('Tap at least two points to finish the path.', true); };
  document.getElementById('touch-undo')!.onclick = undoStroke;
  document.getElementById('touch-cancel')!.onclick = () => selectKind(null);
  const dropStroke = () => { down = null; penStart = null; if (penShape !== 'path') penPreview.clear(); ui.selBox(null); };
  const cancelPointer = (e: PointerEvent) => { if (press?.id === e.pointerId) cancelPress(); if (down?.id === e.pointerId) dropStroke(); };
  cv.addEventListener('pointercancel', cancelPointer); cv.addEventListener('lostpointercapture', cancelPointer);
  cv.addEventListener('pointerleave', cancelMarchPreview);
  cv.addEventListener('pointerdown', e => {
    movingTouchPreview = e.pointerType === 'touch' && touchPreviewHit(e);
    touchInput = e.pointerType === 'touch'; showTouchTools();
    cancelMarchPreview();
    if (e.pointerType === 'touch' && rig.touchConsumed) { cancelPress(); dropStroke(); return; }
    if (e.button !== 0) { dropStroke(); return; }   // any other button (the right one turns the camera) abandons a selection or pen stroke: it must never carry on under a camera drag
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, at: performance.now() };
    if (e.pointerType === 'touch' && selectedKind === null && !pendingBattleOrder && !movingTouchPreview) startPress(e);
    try { cv.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (!e.shiftKey && selectedKind !== null && PEN_SPACING[selectedKind] && penShape !== 'path') { const h = terrain.pick(pointerRay(e).ray); penStart = h ? { x: h.x, z: h.z } : null; }
  });
  cv.addEventListener('pointermove', e => {
    if (press && (e.pointerId !== press.id || rig.touchConsumed || Math.hypot(e.clientX - press.x, e.clientY - press.y) > TOUCH_DRAG_PIXELS)) cancelPress();
    if (e.pointerType === 'touch' && rig.touchConsumed) { if (down) dropStroke(); return; }
    if (movingTouchPreview && down && e.pointerType === 'touch') { previewTouchPlacement(e); return; }
    if (e.pointerType !== 'touch' && down && e.buttons === 1 && selectedKind === null && !e.shiftKey && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) ui.selBox({ x0: down.x, y0: down.y, x1: e.clientX, y1: e.clientY });
    if (pendingBattleOrder) { cv.style.cursor = 'crosshair'; return; }
    updateGhost(e);
    if (selectedKind !== null && PEN_SPACING[selectedKind]) {   // the pen: preview a stroke being dragged, or the next stretch of a path
      const dragging = penStart && (e.buttons & 1) && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8, walking = penShape === 'path' && penPath.length > 0 && !e.buttons;
      if (dragging || walking) {
        const h = terrain.pick(pointerRay(e).ray), o = h ? penOutline(penStart, { x: h.x, z: h.z }, e.altKey) : null;
        if (o) { penPreviewUpdate(selectedKind, o); if (ghost) ghost.visible = false; if (ghostRing) ghostRing.visible = false; if (levelDisc) levelDisc.visible = false; anchorGhost?.hide(); anchorKey = ''; }
      }
    }
    if (selectedDet !== null && selectedKind === null && performance.now() - routeT > 140 && !e.buttons) {   // preview the route under the cursor
      routeT = performance.now(); const hit = terrain.pick(pointerRay(e).ray);
      if (hit) queueMarchPreview(selectedDet, hit.x, hit.z);
      else cancelMarchPreview();
    }
    if (selectedKind === null && performance.now() - hoverT > 90 && !e.buttons) {
      hoverT = performance.now();
      const r = pointerRay(e), armyId = pickArmy(e, r);
      const idx = armyId === null ? pickBuilding(r) : null; covHover(idx);
      let hit: { r: Rival; i: number } | null = null;
      if (idx === null && armyId === null) for (const rival of rivals.values()) { const i = rival.village.pick(r); if (i !== null) { hit = { r: rival, i }; break; } }
      const campInfo = armyId !== null ? campText(armyId) : null;
      if (armyId !== null && campInfo) { ui.tip(`<b>Camp of Army ${armyId}</b><small>${campInfo} · click to select the army</small>`, e.clientX, e.clientY); cv.style.cursor = 'pointer'; }
      else if (armyId !== null) { const u = detUnits(armyId), n = u ? u.reduce((a, b) => a + b, 0) : 0; ui.tip(`<b>Army ${armyId}</b><small>${n} soldiers · click to select · Shift+click adds · double-click selects every army in view</small>`, e.clientX, e.clientY); cv.style.cursor = 'pointer'; }
      else if (idx !== null) { const f = lv.world.buildings_flat(), o = idx * 10; ui.tip(`<b>${tierName(f[o], f[o + 1])}</b><small>${defs[f[o]].name} · ${STATUS[f[o + 6]]}</small>`, e.clientX, e.clientY); cv.style.cursor = 'pointer'; }
      else if (hit) { const f = hit.r.village.world.buildings_flat(), o = hit.i * 10; ui.tip(`<b>${esc(hit.r.name)}: ${tierName(f[o], f[o + 1])}</b><small>${defs[f[o]].name} · click to open the Army tab</small>`, e.clientX, e.clientY); cv.style.cursor = 'pointer'; }
      else { ui.tip(null); cv.style.cursor = multiDets.length ? 'crosshair' : 'default'; }   // with armies selected the ground is where they are sent
    }
  });
  cv.addEventListener('pointerleave', () => { ui.tip(null); covHover(null); });
  cv.addEventListener('pointerup', e => {
    if (press?.id === e.pointerId) cancelPress();
    if (e.button !== 0 || down?.id !== e.pointerId) return;
    const touch = e.pointerType === 'touch';
    if (touch && rig.touchConsumed) { dropStroke(); return; }
    const d0 = down, moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    const tap = moved <= (touch ? TOUCH_DRAG_PIXELS : 5);
    if (touch && movingTouchPreview && !tap) { penStart = null; penPreview.clear(); showTouchTools(); return; }
    if (touch && tap && (pendingBattleOrder || (selectedKind === null && performance.now() - d0.at >= 500))) { dropStroke(); contextAction(e); return; }
    if (penStart && selectedKind !== null) {
      const a = penStart; penStart = null; penPreview.clear();
      if (moved > 8) { const h = terrain.pick(pointerRay(e).ray), o = h ? penOutline(a, { x: h.x, z: h.z }, e.altKey) : null; if (o) penCommit(selectedKind, o); ghostCode = 99; previewKey = ''; ui.hint(placeHint(selectedKind)); return; }
      if (isFigure(penShape)) { ui.hint('Press and drag to draw the figure', true); return; }
    }
    if (zoneIdx !== null && tap) { zoneClick(e); return; }
    if (rallyPick !== null && tap) { rallyClick(e); return; }
    if (selectedKind === PLANT_TOOL && tap) { if (touch) previewTouchPlacement(e); else plantClick(e); return; }
    if (selectedKind === LEVEL_TOOL && tap) { if (touch) previewTouchPlacement(e); else levelClick(e); return; }
    if (selectedKind === 37 && tap) { const h = terrain.pick(pointerRay(e).ray); if (h) roadClick(h.x, h.z); return; }
    if (selectedKind !== null && PEN_SPACING[selectedKind] && penShape === 'path' && tap) {   // a click adds a corner; a quick second click, or a click on the first corner, builds
      const h = terrain.pick(pointerRay(e).ray); if (!h) return;
      const p = { x: h.x, z: h.z }, now = performance.now(), last = penPath[penPath.length - 1];
      if (closesPath(penPath, p, 3.5)) { penCommit(selectedKind, { pts: [...penPath], closed: true }); penReset(); }
      else if (last && now - penLastClick < 350 && Math.hypot(p.x - last.x, p.z - last.z) < 4) { if (penPath.length >= 2) penCommit(selectedKind, { pts: [...penPath], closed: false }); penReset(); }
      else penPath.push(penPath.length && !e.altKey ? snap45(last, p) : p);
      penLastClick = now; ui.hint(placeHint(selectedKind)); return;
    }
    if (!tap) { ui.selBox(null); if (!touch && moved > 8 && selectedKind === null && !e.shiftKey) boxSelect(d0.x, d0.y, e.clientX, e.clientY, e.ctrlKey); return; }
    if (selectedKind !== null) {
      if (touch) { previewTouchPlacement(e); return; }
      buildAtPointer(e);
    } else {
      const det = pickArmy(e);
      if (det !== null) {
        const now = performance.now();
        if (now - lastArmyClick.t < 350 && lastArmyClick.id === det) { const all = [...new Set([det, ...armiesOnScreen().map(a => a.id)])]; selectDets(all); ui.toast(`${all.length} armies selected.`, 'info'); lastArmyClick = { t: 0, id: -1 }; return; }   // double-click: every army on the screen
        lastArmyClick = { t: now, id: det };
        const camp = pickedPart === 'tent' || pickedPart === 'trough' ? campText(det) : null;
        if (e.shiftKey || e.ctrlKey || (touch && touchMulti)) selectDets(multiDets.includes(det) ? multiDets.filter(i => i !== det) : [...multiDets, det]); else selectDet(det);   // Shift or Ctrl (or Select more on touch): add to the selection, or take out
        showTouchTools();
        if (camp) ui.toast(`Camp of Army ${det}: ${camp}.`, 'info');
        return;
      }
      let idx = pickBuilding(pointerRay(e));
      if (idx === null) { const ri = lv.ruins.pick(pointerRay(e)); if (ri !== null) { selectRuin(ri); return; } }
      if (idx === null && touch) idx = buildingNearTap(e);   // a fingertip that just missed a small building
      if (idx !== null) { if (e.shiftKey || e.ctrlKey || (touch && touchMulti)) toggleMulti(idx); else selectBuilding(idx); showTouchTools(); return; }
      else for (const r of rivals.values()) if (r.village.pick(ray) !== null) { openEmbassy(); ui.toast(`${r.name}'s village — pick it in the Embassy's Diplomacy tab to trade, talk or march on it.`, 'info'); return; }
      if (idx === null && !(touch && touchMulti)) { selectBuilding(null); selectRuin(null); if (selectedDet !== null) selectDet(null); }   // (while Select more is on, a tap on empty ground keeps the selection)
      showTouchTools();
    }
  });
  function contextAction(e: PointerEvent) {
    if (pendingBattleOrder) {
      const hit = terrain.pick(pointerRay(e).ray);
      if (!hit) return;
      const order = pendingBattleOrder;
      setPendingBattleOrder(null);
      if (!sendBattleOrder(order, hit.x, hit.z)) ui.toast('The order could not be issued.', 'bad');
      return;
    }
    if (selectedKind === 37 && roadPts.length) { roadPts.pop(); if (roadPts.length === 0) roadSnapped = [false, false]; roadHover(e); return; }   // right-click takes the last road point back
    if (selectedKind !== null) { selectKind(null); return; }                // right-click puts the building down again
    if (multiDets.length) {                                                 // armies selected: send them there, spread out a little
      const hit = terrain.pick(pointerRay(e).ray);
      if (hit && reinforcementPoint(hit.x, hit.z)) void orderArmies(multiDets.slice(), orderDefend);   // right-click on the raiders: the army goes to meet them
      else if (hit) void orderArmies(multiDets.slice(), (id, k) => { const a = k * 2.4, r = k ? 3 + 2 * Math.sqrt(k) : 0; return orderMarch(id, hit.x + Math.cos(a) * r, hit.z + Math.sin(a) * r); });
      return;
    }
    openContext(e);
  }
  cv.addEventListener('pointerup', e => { if (e.pointerType !== 'touch' && e.button === 2 && !rig.moved) contextAction(e); });
  addEventListener('keydown', e => {
    if (ui.captureKey(e)) return;                                   // rebinding a key in the help screen
    if (e.ctrlKey || e.metaKey || e.altKey) return;                 // browser shortcuts (Ctrl+F, Ctrl+R...) are not game commands
    if (pendingBattleOrder && !e.defaultPrevented && keys.actionOf(e) === 'cancel' && (e.target as HTMLElement)?.id === 'battle-group') { setPendingBattleOrder(null); return; }
    const target = e.target as HTMLElement;
    if (e.defaultPrevented || target?.matches?.('input,textarea,select')) return;
    if (target?.closest?.('#pane-build') && ['Tab', 'Enter', ' '].includes(e.key)) return;
    const n = digitOf(e);
    if (n !== null) { const kind = ui.hotkeyKind(n - 1); if (kind !== null) { ui.setTab('build'); selectKind(kind); } return; }
    switch (keys.actionOf(e)) {
      case 'penFinish': if (finishStroke()) e.preventDefault(); break;
      case 'penUndo': if (undoStroke()) e.preventDefault(); break;
      case 'cancel': if (rig.following) rig.stopFollowing(); else if (pendingBattleOrder) setPendingBattleOrder(null); else if (roadPts.length) roadReset(); else if (penPath.length) penReset(); else if (selectedKind !== null) selectKind(null); else if (selectedDet !== null) selectDet(null); else selectBuilding(null); break;
      case 'rotateBuilding': rotateTool(); break;
      case 'focusBuild': if (ui.focusBuildSearch()) e.preventDefault(); break;
      case 'deposits': toggleResources(); break;
      case 'coverage': toggleCoverage(); break;
      case 'pause': e.preventDefault(); setSpeed(speed === 0 || watch.review ? 1 : 0); break;
      case 'perf': e.preventDefault(); perf.toggle(); break;
      case 'help': e.preventDefault(); ui.openSettings('controls'); break;
      case 'toggleLedger': ui.toggleLedger(); break;
      case 'nextArmy': { e.preventDefault(); const ids = lv.field.ids(); if (ids.length) { const i = ids.indexOf(selectedDet ?? -1); const id = ids[(i + 1) % ids.length], p = lv.field.position(id); selectDet(id); if (p) rig.focus(p.x, p.z); } break; }
      case 'haltArmy': multiDets.slice().forEach(id => detAction('halt', id)); break;
      case 'recallArmy': void orderArmies(multiDets.slice(), orderRecall); break;
      case 'commandScreen': if (lv.world.battle_active()) { commandScreen().toggle(); battleBanner(); } break;
      case 'fullMap': ui.toggleMap(); break;
      case 'fullscreen': e.preventDefault(); toggleFullscreen(); break;
      case 'photo': e.preventDefault(); togglePhotoMode(renderer.domElement, () => perf.render(renderer, scene, rig.cam), t => ui.toast(t, 'info')); break;
      case 'musterAll': { const a = Array.from(lv.world.army()).slice(0, 6); if (a.some(n => n > 0)) doMuster(a, true); else if (lv.field.ids().length) selectDets(lv.field.ids()); else ui.toast('There are no soldiers available to muster.', 'info'); break; }
      case 'toggleMinimap': ui.toggleMinimap(); break;
      default: break;
    }
  });
}

/** The deposit a mine, quarry or clay pit works: how much is left, how long it lasts at this rate, or that it lies dormant and how far it has regrown. */
function depositHtml(idx: number): string {
  const bd = parseBuildingDeposit(lv.world.building_deposit(idx)); if (!bd) return '';
  const p = depositPanel(bd);
  return `<div><div class="eyebrow">Deposit · ${p.headline}</div><div class="bar ${bd.asleep ? 'red' : ''}"><i style="width:${p.fill}%"></i></div><p class="muted">${p.detail}</p></div>`;
}
// ---------- deposits overlay ----------
function buildDepositLabels() {
  const raw = deposits.raw;
  for (let i = 0; i < raw.length; i += 5) {
    const el = document.createElement('div'); el.className = 'lbl dep'; el.hidden = true;
    el.innerHTML = `${icon(DEPOSIT[raw[i]].icon, 18)}<span>${DEPOSIT[raw[i]].name}</span>`; ui.labels.appendChild(el); depLabels.push(el);
    el.style.pointerEvents = 'auto'; el.style.cursor = 'pointer'; el.title = 'Click twice to clear this deposit off the land (40 wood, 10 tools)';
    const idx = i / 5; let armed = 0;
    el.onclick = e => {   // the first click asks, the second (within 4 seconds) clears it
      e.stopPropagation();
      if (performance.now() - armed > 4000) { armed = performance.now(); ui.toast('Click the label again to clear this deposit (40 wood, 10 tools).', 'info'); return; }
      armed = 0; const code = lv.world.clear_deposit(idx);
      if (code === 0) {
        commit({ op: 'clear', idx }); sound.click(); ui.toast('The deposit is cleared away.', 'good');
        deposits.sync(lv.world.deposits_flat(), lv.world.deposits_asleep());
        forestDirtyFlag = true; afterLocalChange();
      }
      else ui.toast(code === -6 ? 'Clearing takes 40 wood and 10 tools.' : code === -4 ? 'A mine or quarry is working it.' : code === -2 ? 'It lies outside your border.' : 'Nothing to clear.', 'bad');
    };
  }
}
function toggleResources() { showDeposits = !showDeposits; ui.setResourcesToggle(showDeposits); if (!showDeposits) depLabels.forEach(l => (l.hidden = true)); }
const vtmp = new THREE.Vector3();
function updateLabels() {
  if (followedVillager !== null) {
    const person = lv.people.villager(followedVillager);
    if (person && !lv.people.hidden) {
      vtmp.set(person.x, terrain.walkAt(person.x, person.z) + 2 * person.scale, person.z).project(rig.cam);
      ui.moveFollowMarker((vtmp.x + 1) * innerWidth / 2, (1 - vtmp.y) * innerHeight / 2, vtmp.z < 1 && Math.abs(vtmp.x) < 1 && Math.abs(vtmp.y) < 1);
    } else ui.moveFollowMarker(0, 0, false);
  }
  if (!showDeposits) return;
  const { flat, asleep } = depositsNow(lv.world);
  for (let i = 0; i < Math.min(depLabels.length, flat.length / 5); i++) {
    const x = flat[i * 5 + 1], z = flat[i * 5 + 2], rem = flat[i * 5 + 3];
    vtmp.set(x, terrain.heightAt(x, z) + 3.2, z).project(rig.cam);
    const on = vtmp.z < 1 && Math.abs(vtmp.x) < 1.05 && Math.abs(vtmp.y) < 1.05 && Math.hypot(x - rig.target.x, z - rig.target.z) < 210;
    const el = depLabels[i], hide = !on || flat[i * 5 + 4] <= 0;
    if (el.hidden !== hide) el.hidden = hide;
    if (hide) continue;
    // moved with a transform (no layout), and the text, class and tooltip are written only when they change, not every frame
    el.style.transform = `translate(${Math.round((vtmp.x * 0.5 + 0.5) * innerWidth)}px, ${Math.round((-vtmp.y * 0.5 + 0.5) * innerHeight)}px) translate(-50%, -100%)`;
    const dormant = asleep[i] === 1, text = depositLabel(DEPOSIT[flat[i * 5]].name, { rem, max: flat[i * 5 + 4], asleep: dormant });
    if (el.dataset.t !== text) { el.dataset.t = text; (el.firstElementChild as HTMLElement).textContent = text; }
    if (el.dataset.a !== String(dormant)) {
      el.dataset.a = String(dormant); el.classList.toggle('dormant', dormant);
      el.title = dormant ? 'Dormant, recovering. It wakes by itself once it has regrown. Click twice to clear it off the land (40 wood, 10 tools)' : 'Click twice to clear this deposit off the land (40 wood, 10 tools)';
    }
  }
}

// ---------- performance monitor ----------
/** Every village in the world, yours first. The array is reused between calls (it was rebuilt several times a frame): `villagesChanged()` drops it when a rival joins or leaves. */
let villageList: Village[] | null = null, villageViews: VillageView[] | null = null;
function allVillages() { return villageList ??= [lv, ...[...rivals.values()].map(r => r.village)]; }
const villagesChanged = () => { villageList = null; villageViews = null; };
const allViews = () => villageViews ??= allVillages().map(v => v.view);
function setupPerf() {
  perf = new Perf(document.body);
  perf.attachGpu(renderer.getContext() as WebGL2RenderingContext);
  const vis = (get: () => THREE.Object3D[]) => (on: boolean) => get().forEach(o => (o.visible = on));
  perf.setContext(() => { const s = settings(); return { version: VERSION, gpu: rendererName(), softwareRendering, quality: s.quality, shadows: s.shadows, pixelCap: s.pixelCap, drawDistance: s.drawDistance, antialias: s.antialias, fpsCap: effectiveFpsCap(), fpsCapChosen: s.fpsCap, autoCap30, adaptive: s.adaptive, resolutionScale: +resScale.toFixed(2), pixelRatio: renderer.getPixelRatio() }; });
  perf.setLayers([
    { name: 'Terrain', set: vis(() => [terrain.mesh]) },
    { name: 'Water', set: vis(() => [terrain.water, terrain.riverWater]) },
    { name: 'Trees', set: on => { forest.group.visible = on && settings().trees && !showroom; atmo.invalidateShadows(); } },
    { name: 'Buildings', set: vis(() => allVillages().flatMap(v => [v.view.root, v.view.batchRoot, v.walls.group, v.ruins.group])) },
    { name: 'Village paths', set: vis(() => allVillages().map(v => v.paths.group)) },
    { name: 'People and soldiers', set: vis(() => [crowd.group, ...allVillages().map(v => v.army.group)]) },
    { name: 'Animals', set: vis(() => [wildlife.group]) },
    { name: 'Fire, smoke and arrows', set: on => { fx.group.visible = effects.group.visible = on && settings().particles; } },
    { name: 'Shadows', set: on => { atmo.sun.castShadow = on && settings().shadows > 0; atmo.invalidateShadows(); } },
    { name: 'Sky', set: vis(() => [atmo.sky]) },
  ]);
}

/** A title over every town hall: whose it is, and how grand it has grown. */
function updateHallLabels(all: Village[]) {
  for (const v of all) {
    let el = hallLabels.get(v.key);
    if (!el) { el = document.createElement('div'); el.className = 'lbl hall'; ui.labels.appendChild(el); hallLabels.set(v.key, el); }
    const { x: hx, z: hz, tier } = v.hall;
    vtmp.set(hx, terrain.heightAt(hx, hz) + 7 + tier * 3.5, hz).project(rig.cam);
    const on = vtmp.z < 1 && Math.abs(vtmp.x) < 1 && Math.abs(vtmp.y) < 1 && rig.dist > 28;
    el.hidden = !on; if (!on) continue;
    el.style.transform = `translate(${Math.round((vtmp.x * 0.5 + 0.5) * innerWidth)}px, ${Math.round((-vtmp.y * 0.5 + 0.5) * innerHeight)}px) translate(-50%, -100%)`;
    const key = `${v.mine}|${tier}|${v.name}`;   // the label's HTML (icon included) is rebuilt only when one of these changes, not every frame
    if (el.dataset.k !== key) { el.dataset.k = key; el.innerHTML = `${icon(v.mine ? 'castle' : 'attack', 18)}<b>${esc(v.name)}</b><span>${tierName(15, tier).toUpperCase()}</span>`; }
  }
}

/** Every village in view as the procession renderer wants it. */
function travellerVillages(): TVillage[] {
  const mk = (v: Village, key: string, tag: number, name: string, mine: boolean): TVillage => ({ key, tag, name, mine, x: v.ox, z: v.oz, radius: v.radius, color: v.army.friend, world: v.world });
  return [mk(lv, 'me', myTag(), myName, true), ...[...rivals.values()].map(r => mk(r.village, r.key, tagOf(r.key), r.name, false))];
}

/** A small caption floating over each procession on the road: what it is and between whom. */
const journeyLabels = new Map<string, HTMLElement>();
function updateJourneyLabels() {
  const live = new Set<string>();
  for (const l of travellers.labels()) {
    let el = journeyLabels.get(l.id);
    if (!el) { el = document.createElement('div'); el.className = 'lbl jr'; ui.labels.appendChild(el); journeyLabels.set(l.id, el); }
    live.add(l.id);
    vtmp.set(l.x, l.y, l.z).project(rig.cam);
    const on = vtmp.z < 1 && Math.abs(vtmp.x) < 1 && Math.abs(vtmp.y) < 1 && rig.dist < 220;
    el.hidden = !on; if (!on) continue;
    el.style.transform = `translate(${Math.round((vtmp.x * 0.5 + 0.5) * innerWidth)}px, ${Math.round((-vtmp.y * 0.5 + 0.5) * innerHeight)}px) translate(-50%, -100%)`;
    if (el.textContent !== l.text) { el.textContent = l.text; el.dataset.kind = String(l.kind); }
  }
  for (const [id, el] of [...journeyLabels]) if (!live.has(id)) { el.remove(); journeyLabels.delete(id); }
}

// ---------- main loop ----------
let worldShips: WorldShips | null = null;
let travellers!: Travellers;
let tideLevel = 0;   // the water rises and falls a little, slowly
let noteT = 0, sCount = 0, sT = 0, fireBuf = new Float32Array(256);
const effectView = new EffectView();
let lastPhase = -1;   // the day phase the light was last set for
let last = 0, miniT = 0, scareT = 0, scares: { x: number; z: number }[] = [];
let forestShadowVersion = -1;
/** Put the display settings into effect (at start, and whenever one changes). */
function applySettings(s: Settings) {
  renderer.setPixelRatio(pixelRatio(devicePixelRatio, resScale));
  atmo.setShadows(s.shadows);
  forest.drawDistance = s.drawDistance; forest.detail = s.treeDetail; forest.group.visible = s.trees && !showroom;
  atmo.invalidateShadows();
  for (const wm of [terrain.water.material as THREE.MeshPhysicalMaterial, terrain.riverMaterial]) { const gloss = s.waterFx ? 1 : 0; if (wm.clearcoat !== gloss) { wm.clearcoat = gloss; wm.envMapIntensity = s.waterFx ? 1.8 : 0.6; wm.needsUpdate = true; } }
  fx.group.visible = effects.group.visible = s.particles;
  wildlife.group.visible = crowd.group.visible = s.crowds && !showroom;
  wildlife.setGooglyEyes(s.googlyEyes); crowd.setGooglyEyes(s.googlyEyes);
  perf.setBadge(s.showFps || perf.open);
}

// ---------- adaptive resolution: when frames run long, draw fewer pixels; when there is room again, win them back ----------
/** The browser draws WebGL on the processor (no usable graphics card): see gpucheck.ts. */
let softwareRendering = false;
let resScale = 1, slowMs = 0, busyMs = 0, resStart = -1, resLast = 0;
/** How long the main thread worked on the last frame (simulation, scripts, issuing the draws), measured at the end of `frame()`. */
let lastBusyMs = 0;
function adaptResolution(frameMs: number, now: number) {
  if (!settings().adaptive || perf.profiling) return;   // (the resolution stays put while the cost test measures)
  // smoothed over about a second of real time, whatever the frame rate: counted in frames, a computer drawing 2 frames a second took a minute to start
  // adjusting and several minutes to reach the lowest resolution, which is exactly the computer that needs it
  const k = 1 - Math.exp(-Math.min(frameMs, 1000) / 900);
  slowMs += (frameMs - slowMs) * k; busyMs += (lastBusyMs - busyMs) * k;
  if (resStart < 0) resStart = now;
  if (now - resStart < 2500 || now - resLast < 900) return;   // let things settle after loading, then adjust a little at a time
  resLast = now;
  const was = resScale;
  const budget = effectiveFpsCap() === 30 ? 34 : 17.5;
  // Fewer pixels only help when the graphics card (or, without one, the browser's software renderer) is what holds the frame back. Where the browser can time
  // the GPU, that decides. Where it cannot (Safari and so every browser on iPad and iPhone, Firefox, a software renderer), the main thread's own work tells:
  // if scripts and draw calls alone take most of the frame, it is CPU-bound and lowering the resolution only blurs the picture.
  const gpu = perf.gpuTime;
  const gpuBound = gpu !== null ? gpu > budget * 0.8 : busyMs < slowMs * 0.6;
  const gpuRoom = gpu !== null ? gpu < budget * 0.55 : false;
  const floor = softwareRendering ? 0.4 : 0.55;   // drawing on the processor, every pixel is expensive: allow a lower resolution
  const step = slowMs > budget * 2.5 ? 0.15 : 0.1;   // far too slow: come down faster
  if (slowMs > budget && gpuBound && resScale > floor) resScale = Math.max(floor, resScale - step);
  else if ((slowMs < 13 || gpuRoom) && resScale < 1) resScale = Math.min(1, resScale + 0.1);
  if (resScale !== was) renderer.setPixelRatio(pixelRatio(devicePixelRatio, resScale));
  // Frames that keep missing 60 fps arrive unevenly (16, 33, 16, 50 ms), which looks worse than a steady 30 and does twice the work. On a touch device that cannot hold
  // 60 even at the lowest resolution it can reach, or is held back by the processor (where fewer pixels do not help), settle on 30 (and try 60 again after a quiet spell, see below).
  if (!autoCap30 && isTouchDevice() && settings().fpsCap !== 30 && slowMs > 24 && (resScale <= floor + 0.001 || !gpuBound)) { slowSince ||= now; if (now - slowSince > 4000) { autoCap30 = true; slowMs = 33; slowSince = 0; capProbeAt = now + capBackoff; if (capProbing) { capBackoff = Math.min(capBackoff * 2, 300_000); capProbeAt = now + capBackoff; capProbing = false; } } }
  else if (slowMs <= 22) slowSince = 0;
  // The 30 fps limit is not for good: a slow moment (loading, a burst of building, a shadow redraw) can set it, and a device that has plenty of room afterwards deserves 60 again.
  // After a quiet spell the limit is lifted to try; if the frames are slow again it comes back, and the next try waits twice as long (up to five minutes).
  if (autoCap30 && capProbeAt && now >= capProbeAt && busyMs < 13 && slowMs < 36) { autoCap30 = false; capProbing = true; capProbeAt = 0; slowSince = 0; slowMs = 17; }
}
/** The frame rate limit in force: the player's, or 30 when the device could not keep up with 60 (see adaptResolution). */
let autoCap30 = false, slowSince = 0, capProbeAt = 0, capBackoff = 15_000, capProbing = false;
const effectiveFpsCap = () => perf.profiling ? 0 : autoCap30 ? 30 : settings().fpsCap;   // (no limit while the cost test measures the frames)

/** A handful of real point lights, moved each moment to the lanterns nearest the camera: at night they throw warm pools of light on the street.
 *
 *  Every lit material pays for every point light on every pixel, even a light at intensity 0, so the lamps and the fire light are hidden while none of them gives
 *  any light (all day, unless something burns). Hiding them changes the shaders three.js uses, so `warmUp()` compiles both versions behind the loading screen
 *  (three.js keeps every version a material has used), and switching between them later costs nothing. They are created before `warmUp()` for the same reason:
 *  created on the first frame, they forced every shader to be rebuilt just after loading. */
const lampLights: THREE.PointLight[] = [];
let lampT = 0, pointLightsOn = true, pointLightsIdle = 0;
function addLampLights() {
  if (!lampLights.length) for (let i = 0; i < touchLimits(deviceClass()).lampLights; i++) { const l = new THREE.PointLight(0xffb464, 0, 17, 1.5); scene.add(l); lampLights.push(l); }
}
function setPointLights(on: boolean) {
  pointLightsOn = on;
  for (const l of lampLights) l.visible = on;
  fx.light.visible = on;
}
/** After the lamps and fires have set their intensities for this frame: show the point lights while any of them shines, hide them once all have been dark for a
 *  couple of seconds (so a fire that flickers out and back does not switch them every frame). */
function updatePointLights(dt: number) {
  const lit = fx.light.intensity > 0 || lampLights.some(l => l.intensity > 0);
  pointLightsIdle = lit ? 0 : pointLightsIdle + dt;
  if (lit && !pointLightsOn) setPointLights(true);
  else if (!lit && pointLightsOn && pointLightsIdle > 2) setPointLights(false);
}
function lightLamps(all: Village[], now: number) {
  addLampLights();
  const k = atmo.night;
  if (k < 0.02) { for (const l of lampLights) l.intensity = 0; return; }
  if (now - lampT > 150) {   // pick the nearest lanterns a few times a second, not every frame
    lampT = now;
    const near: { x: number; z: number; d: number }[] = [];
    for (const v of all) for (const [x, z] of v.props.lamps) { const d = (x - rig.target.x) ** 2 + (z - rig.target.z) ** 2; if (d < 70 * 70) near.push({ x, z, d }); }
    near.sort((a, b) => a.d - b.d);
    lampLights.forEach((l, i) => { const q = near[i]; if (q) l.position.set(q.x, terrain.heightAt(q.x, q.z) + 2.8, q.z); l.userData.on = !!q; });
  }
  for (const l of lampLights) l.intensity = l.userData.on ? k * 26 : 0;
}

/** Animation and background timers use the same watch. A battle already committed by two players
 *  keeps running, even if one player switches tabs or tries to pause the clock. */
let bgLast = 0, frameAt = 0, sceneTime = 0, tickShown = true;
/** Bring the scene, the selection and the HUD up to the village after the ticks of one frame: once per frame, not once per tick. At high speed a frame runs several
 *  ticks, and each of these reads the whole village (buildings, health, people, walls, soldiers, the ledger); only the last state is ever shown. */
function showTicks() {
  if (tickShown) return;
  tickShown = true;
  lv.afterTick();
  updateSelection(); updateHud(); battleBanner();
}
const liveSpeed = () => lv.world.battle_active() || awayFights.size > 0 ? Math.min(speed, 1) : speed;
function runClock(dt: number, now: number) {
  if (replay?.target === lv) { acc = 0; return; }
  const wasAway = watch.away;
  watch.observe(now, document.hidden);
  if (wasAway !== watch.away) { acc = 0; renderWatch(); }
  const pace = watch.pace(liveSpeed(), livePlayerBattle());
  if (pace <= 0) { acc = 0; return; }
  acc += dt * pace * TICK_RATE;
  while (acc >= 1) {
    const playerBattle = livePlayerBattle();
    const wasWorking = watch.working;
    if (!playerBattle && !watch.allowStep(watchRisk)) {
      if (wasWorking) renderWatch();
      acc = 0;
      break;
    }
    acc -= 1;
    stepLocal();
    if (speed === 0 && !playerBattle) { acc = 0; break; }
    if (watch.away && !playerBattle) {
      watch.afterStep(watchRisk);
      if (!watch.working) renderWatch();
    }
    if (playerBattle && !livePlayerBattle()) { acc = 0; renderWatch(); break; }
  }
  showTicks();
}

function startBackgroundClock() {
  try {
    const src = 'setInterval(() => postMessage(0), 200);';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    let w: Worker;
    try { w = new Worker(url); } finally { URL.revokeObjectURL(url); }
    w.onmessage = () => {
      const now = performance.now();
      if (now - frameAt < 400 || !lv) { bgLast = now; return; }   // frames are coming (the page is on screen): they run the clock
      const dt = Math.max(0, Math.min(0.5, (now - (bgLast || now)) / 1000)); bgLast = now;
      runClock(dt, now);
    };
  } catch { /* no workers (a locked-down browser): the village simply waits while its tab is hidden, as before */ }
}

// ---------- render on demand ----------
/** While the village is paused and nobody has touched anything for a moment, the picture cannot change (the water, the trees' sway, the people and the fires all run on
 *  the game clock, which is stopped), so drawing it 60 times a second only heats the device. Such a still scene is drawn a few times a second instead: enough to keep
 *  the selection ring pulsing, and an input brings the full rate back on the very next frame. */
let lastInputAt = 0, wasStill = false;
const perfInfo = { calls: 0, triangles: 0, geometries: 0, textures: 0 };   // one object, filled in every frame
for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'keyup', 'wheel', 'touchstart', 'touchmove']) addEventListener(ev, () => { lastInputAt = performance.now(); }, { capture: true, passive: true });
const stillNow = (now: number) => sceneIsStill({
  paused: speed === 0 && watch.pace(liveSpeed(), livePlayerBattle()) <= 0, msSinceInput: now - lastInputAt,
  animating: !!replay || !!showroom || rig.following || followedVillager !== null || !!trackFoe || perf.profiling,
});

function frame(now: number) {
  frameAt = performance.now();
  { const cap = effectiveFpsCap(); if (cap && now - last < 1000 / cap - 2) { requestAnimationFrame(frame); return; } }   // frame rate limit
  const still = stillNow(frameAt);
  if (skipFrame(still, now - last)) { requestAnimationFrame(frame); return; }   // a still scene: skip most frames (see above)
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
  // frames spaced out on purpose say nothing about how fast the device is: they must not lower the resolution
  adaptResolution(still || wasStill ? 16 : now - last, now); wasStill = still; last = now;   // never negative, never a big jump
  perf.start('simulation');
  if (replay) tickReplay(dt);
  runClock(dt, frameAt);
  flushRivals(frameAt);
  const replayDt = replay?.playing ? dt : 0;
  const liveDt = watch.pace(liveSpeed(), livePlayerBattle()) > 0 ? dt : 0;
  const worldDt = replay?.target === lv ? replayDt : liveDt;
  sceneTime += worldDt;
  perf.stop('simulation');
  const all = allVillages();
  const s = settings(), drawCrowd = (s.crowds || rig.following) && !showroom;
  { // the time of day: the light follows the village clock, smoothly between ticks
    const ph = dayPhase(Number(lv.world.tick()) + (replay ? 0 : acc));
    if (Math.abs(ph - lastPhase) > 0.0008 || lastPhase < 0) { lastPhase = ph; atmo.setClock(ph); forest.setLight(atmo.lightDirection, atmo.sun, atmo.hemi); setNightLight(atmo.night); for (const v of all) v.props.setNight(atmo.night); }
  }
  lightLamps(all, now);
  for (const v of all) v.people.group.visible = v.army.group.visible = drawCrowd;
  perf.start('camera + world'); rig.update(dt); rig.cam.updateMatrixWorld(true); atmo.follow(rig.target);
  terrain.animate(sceneTime, now / 1000); terrain.setLod(rig.cam.position.x, rig.cam.position.z);
  tideLevel = -0.25 + Math.sin(sceneTime * 0.09) * 0.19 + Math.sin(sceneTime * 0.031) * 0.07;
  terrain.setTide(tideLevel); worldShips?.update(worldDt, tideLevel);
  perf.stop('camera + world');
  const treeShadowRange = !s.shadows ? 0 : rig.dist <= 175 ? 135 : rig.pitch < 0.5 ? 65 : 85;
  perf.start('forest'); forest.tick(sceneTime, rig.cam.position, rig.target, treeShadowRange, rig.cam); perf.stop('forest');
  if (forestShadowVersion !== forest.shadowVersion) { forestShadowVersion = forest.shadowVersion; if (forest.group.visible) atmo.invalidateShadows(); }
  const detailRange = innerHeight * 1.65 / (2 * Math.tan(THREE.MathUtils.degToRad(rig.cam.fov / 2)) * 36);
  // villagers and soldiers are only drawn near the camera target (`view` below): a village whose edge is well beyond that moves its people a few times a second, not every frame
  const crowdView = Math.max(90, rig.dist * 1.7 + 50) + 60;
  perf.start('villages (people, army)'); all.forEach(v => v.frame(v === replay?.target ? replayDt : worldDt, v === lv ? speed : 1, rig.cam.position, detailRange, drawCrowd, Math.hypot(v.ox - rig.target.x, v.oz - rig.target.z) - v.radius < crowdView)); perf.stop('villages (people, army)');
  perf.start('animals');
  camps.update(now / 1000, rig.target.x, rig.target.z);
  deposits.cull(rig.target.x, rig.target.z, Math.max(160, rig.dist * 1.7 + 120));   // deposits far from the camera are not drawn or traversed
  if (now - scareT > 250) { scareT = now; scares = all.flatMap(v => [...v.people.positions(), ...v.army.positions()]); }
  const view = Math.max(90, rig.dist * 1.7 + 50);        // simulate and draw crowds and animals only around the camera
  wildlife.update(worldDt, scares, rig.target.x, rig.target.z, view);
  perf.stop('animals');
  perf.start('crowd upload');
  travellers.update(worldDt, sceneTime, travellerVillages());
  if (drawCrowd && crowd.group.visible) {
    crowd.begin();
    all.forEach(v => v.draw(crowd, rig.target.x, rig.target.z, view, rig.cam.position, detailRange));
    worldShips?.draw(crowd, rig.target.x, rig.target.z, view);
    travellers.draw(crowd, rig.target.x, rig.target.z, view, raidWagon); crowd.end();
  } else travellers.draw(null, rig.target.x, rig.target.z, view, showroom ? null : raidWagon);
  perf.stop('crowd upload');
  perf.start('fire + particles');
  let nf = 0; if (fx.group.visible) for (const v of all) nf += v.fireData.length;
  if (fireBuf.length < nf) fireBuf = new Float32Array(Math.max(nf, fireBuf.length * 2));   // one buffer reused every frame
  if (nf) { let o = 0; for (const v of all) { fireBuf.set(v.fireData, o); o += v.fireData.length; } }
  const fires = fireBuf.subarray(0, nf);
  if (fx.group.visible || effects.group.visible) effectView.update(rig.cam);
  fx.update(worldDt, fires, rig.cam.position, effectView);
  updatePointLights(dt);
  effects.update(worldDt, sceneTime, allViews(), rig.target.x, rig.target.z, view, effectView);
  perf.stop('fire + particles');
  if (selRing.visible) (selRing.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(now / 250) * 0.25;
  if (hlShown) { const o = 0.55 + Math.sin(now / 300) * 0.3; for (let i = 0; i < hlShown; i++) (hlRings[i].material as THREE.MeshBasicMaterial).opacity = o; }
  perf.start('labels + minimap');
  updateHallLabels(all); updateJourneyLabels();
  updateLabels(); updateCovLabels(); drawBattlefieldPins(); updateBossBar(); updateUnitBars(); updateFoeTrack(now); updateFoeArrow();
  let fireCount = 0, anyBattle = false;   // (plain loops: no closures or arrays built every frame)
  for (let i = 0; i < all.length; i++) { fireCount += all[i].fireData.length / 4; if (!anyBattle && all[i].world.battle_active()) anyBattle = true; }
  sound.update(dt, fireCount, anyBattle);
  if (now - miniT > 250) {
    miniT = now;
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => { ndc.set(u * 2 - 1, -(v * 2 - 1)); ray.setFromCamera(ndc, rig.cam); const p = terrain.pick(ray.ray); return p ? { x: p.x, z: p.z } : null; });
    const view = corners.every(c => c) ? (corners as { x: number; z: number }[]) : null;
    const mapV = (v: Village, color: string, name: string): MapVillage => { const f = buildingsNow(v.world), b: MapVillage['buildings'] = []; for (let i = 0; i < f.length; i += 10) b.push({ x: f[i + 2], z: f[i + 3], r: shared.radii[f[i]], kind: f[i] }); return { x: v.ox, z: v.oz, r: v.radius, color, name, buildings: b }; };
    const villages = [mapV(lv, '#5f8fe0', myName), ...[...rivals.values()].map(r => mapV(r.village, '#e05f5f', r.name))];
    const armies = [lv, ...[...rivals.values()].map(r => r.village)].flatMap((v, k) => v.field.ids().map(id => ({ ...v.field.position(id)!, color: k ? '#ff8a7a' : '#8fb8ff' })));
    for (const v of allVillages()) { if (!v.world.battle_active() || v.world.battle_lair().length) continue; const c = foeCentroid(battleUnits(v.world)); if (c) armies.push({ x: c.x, z: c.z, color: '#ff2d1a' }); }   // the raiders, wherever they are
    const mo = { fog: lv.world.explored_flat(), neutrals: lv.world.neutrals_flat(), villages, armies, deposits: depositsNow(lv.world).flat, showDeposits, view, target: { x: rig.target.x, z: rig.target.z } };
    minimap.draw(mo); if (ui.mapOpen()) bigMap.draw(mo);
  }
  perf.stop('labels + minimap');
  perf.start('render (CPU side)');
  if (atmo.updateShadows(now, rig.target, rig.dist, drawCrowd && (speed > 0 || wildlife.visible > 0))) perf.tally('shadow redraws');
  perf.render(renderer, scene, rig.cam);
  perf.stop('render (CPU side)');
  lastBusyMs = performance.now() - frameAt;
  if (perf.open && now - noteT > 500) { noteT = now; perf.netNotes(syncNotes()); }
  if (perf.open) perf.counts({ Villagers: lv.people.count, Animals: wildlife.visible, Buildings: lv.world.building_count(), Soldiers: (now - sT > 500 ? (sT = now, sCount = lv.army.positions().length) : sCount) });   // (shown only in the open panel)
  perfInfo.calls = renderer.info.render.calls; perfInfo.triangles = renderer.info.render.triangles; perfInfo.geometries = renderer.info.memory.geometries; perfInfo.textures = renderer.info.memory.textures;
  perf.frame(now, perfInfo);
  requestAnimationFrame(frame);
}

// ---------- debugging / automated checks ----------
function debugPlace(kind: number, dx: number, dy: number, r = 0) {
  const res = lv.world.place(kind, dx, dy, r);
  if (res >= 0) { commit({ op: 'place', kind, x: dx, y: dy, rot: r }); afterLocalChange(); }
  return res;
}
if (DEBUG_HOOKS) (window as any).__game = {
  get worldShips() { return worldShips; }, startReplay, stopReplay, get replay() { return replay; }, debugPlace, runModelVillage, selectBuilding, toggleMulti, selectWallRun, selectRuin, KIND_ICON, setSpeed, selectKind, frame, updateGhost,
  get renderer() { return renderer; }, get forest() { return forest; }, get atmo() { return atmo; }, get scene() { return scene; }, get terrain() { return terrain; }, get rig() { return rig; },
  get perf() { return perf; }, get world() { return lv.world; }, get lv() { return lv; }, get rivals() { return rivals; }, get wildlife() { return wildlife; }, get fx() { return fx; }, get crowd() { return crowd; }, ui, afterLocalChange, refreshTerrain,
  /** (testing) run n whole ticks of the live game at once: your village and, in a PVE game, the computer's. */
  stepTicks(n: number) { for (let i = 0; i < n; i++) stepLocal(); lv.afterTick(); },
  raid(angle = 0.6, u = [8, 4, 2, 0, 0]) { const ok = lv.world.start_raid(angle, Uint32Array.from(u), 0); lv.afterTick(); return ok; },
  /** (benchmarks) Swap in a village from World.snapshot bytes, e.g. a late-game save grown by harness/latebuild.mjs. Not shared with other players. */
  loadSnapshot(bytes: Uint8Array) { const w = world_restore(bytes); if (!w) return false; w.take_shots(); w.take_events(); lv.setWorld(w); refreshTerrain(w); lv.syncFull(); lv.afterTick(); deposits.sync(w.deposits_flat(), w.deposits_asleep()); deposits.refit(); deposits.attach(w.buildings_flat()); forestDirtyFlag = true; rig.focus(w.origin_x(), w.origin_y(), 120); return true; },
};

// a tab that gave way to another tab of this browser (see giveWayToOtherTab) joins again by itself, under the same name
try {
  const resume = sessionStorage.getItem('flanders:autostart');
  if (resume) { sessionStorage.removeItem('flanders:autostart'); const r = JSON.parse(resume) as { world?: string; name?: string }; void startGame(cleanWorld(r.world), cleanName(r.name)); }
} catch { /* nothing to resume */ }

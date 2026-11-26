#!/usr/bin/env node
// MCP server for Flanders. An AI agent plays through a normal browser tab: this server talks to the agent over MCP (stdio) and to the game page over a local WebSocket.
// The page applies every action with the same rules as a human click, and both sides enforce the guardrails (see guardrails.mjs and web/src/agent.ts).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { Guard } from './guardrails.mjs';

const args = process.argv.slice(2), flag = n => args.includes(`--${n}`), opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(opt('port', process.env.FLANDERS_AGENT_PORT ?? '8765')), GAME = opt('game', process.env.FLANDERS_URL ?? 'http://localhost:5173');
const TOKEN = process.env.FLANDERS_AGENT_TOKEN || randomBytes(24).toString('hex');
if (!/^[A-Za-z0-9_-]{8,128}$/.test(TOKEN)) { process.stderr.write('FLANDERS_AGENT_TOKEN must be 8-128 letters, digits, - or _.\n'); process.exit(1); }
const guard = new Guard({ allowAttack: flag('allow-attack'), gapMs: Number(opt('gap-ms', '2500')), perMinute: Number(opt('per-minute', '15')) });

// ---- the game page ----
let page = null, nextId = 1; const pending = new Map();
// Only the local game page may talk to this server: it listens on the loopback address only, wants an Origin that is this machine (or one you list in FLANDERS_ORIGINS),
// a secret token in the first message, and refuses big messages and many connections.
const ORIGIN_OK = o => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o) || (process.env.FLANDERS_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean).includes(o);
const sameToken = t => typeof t === 'string' && t.length === TOKEN.length && timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: 256 * 1024, verifyClient: ({ origin }) => !origin || ORIGIN_OK(origin) });
wss.on('connection', ws => {
  if (wss.clients.size > 4) { ws.close(1013); return; }
  let authed = false;
  const deadline = setTimeout(() => { if (!authed) ws.close(1008); }, 5000);   // whoever connects must prove they know the token within five seconds
  ws.on('message', raw => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!authed) { if (m.hello === 'flanders-game' && sameToken(m.token)) { authed = true; clearTimeout(deadline); page?.close(); page = ws; ws.send(JSON.stringify({ hello: 'ok' })); } else ws.close(1008); return; }
    const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
  });
  ws.on('close', () => { clearTimeout(deadline); if (page === ws) page = null; });
  ws.on('error', () => { /* a broken socket is just closed */ });
});
const link = `${GAME}/?agent=${PORT}&token=${TOKEN}&player=agent${flag('allow-attack') ? '&allow_attack=1' : ''}`;
process.stderr.write(`Flanders MCP server. Open this link in a browser tab so the agent can play:\n  ${link}\n`);

function callGame(tool, a) {
  return new Promise(resolve => {
    if (!page) return resolve({ ok: false, error: `no game page is connected. Ask the human to open ${link}` });
    const id = nextId++, timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'the game did not answer in time' }); }, 15000);
    pending.set(id, { resolve, timer }); page.send(JSON.stringify({ id, tool, args: a }));
  });
}

async function run(tool, a = {}) {
  const refused = guard.check(tool, a);
  const text = refused ? { ok: false, ...refused } : await callGame(tool, a);
  const body = text.ok === false ? { ok: false, error: text.error, retry_after_ms: text.retry_after_ms } : text.result;
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: text.ok === false };
}

const RULES = `You are playing Flanders, a medieval village builder, in a browser tab, under exactly the rules a human player has: you pay for everything, buildings must stand on land inside your build radius, and villagers need food, homes and workplaces.
Guardrails: you play at human pace (about one action every ${guard.o.gapMs / 1000}s, at most ${guard.o.perMinute} actions a minute); demolishing needs confirm; attacking other players is ${guard.o.allowAttack ? 'allowed only with confirm_attack' : 'switched off'}; the human can pause or disconnect you at any time.
There are no testing tools: no cheats, no free resources, no changing game speed.
Tips: call observe first, then catalog. Use probe to look at the land, can_place before place. Build houses and a farm first, then a woodcutter near forest, sawmill, quarry by stone, storehouse. Coordinates are relative to the town hall (x east, y south).`;

const server = new McpServer({ name: 'flanders', version: '0.1.0' }, { instructions: RULES });
const tool = (name, description, shape, fn) => server.tool(name, description, shape, async a => run(name, fn ? fn(a) : a));
server.tool('game_rules', 'The rules and guardrails of this game session. Read this first.', {}, async () => ({ content: [{ type: 'text', text: RULES }] }));
tool('observe', 'Summary of your village: resources, population, happiness, army, whether you are under attack.', {});
tool('catalog', 'Everything that can be built: costs, sizes, what it makes, and its optional design options.', {});
tool('buildings', 'List your buildings with positions relative to the town hall (optionally only one kind).', { kind: z.number().int().min(0).max(60).optional() });
tool('probe', 'Look at the land: a small map of heights (water ~), plus nearby ore/stone/clay deposits.', { dx: z.number().int().min(-200).max(200).optional(), dy: z.number().int().min(-200).max(200).optional(), half: z.number().int().min(4).max(40).optional(), step: z.number().int().min(2).max(10).optional() });
tool('can_place', 'Ask whether a building could be placed here (no cost, no change).', { kind: z.number().int(), dx: z.number().int(), dy: z.number().int() });
tool('place', 'Place a building (costs resources). rot 0..7 turns it in 45 degree steps.', { kind: z.number().int(), dx: z.number().int(), dy: z.number().int(), rot: z.number().int().min(0).max(7).optional() });
tool('upgrade', 'Upgrade a building to its next tier.', { idx: z.number().int().min(0) });
tool('option', 'Switch an optional design upgrade (see catalog options) on or off for one building.', { idx: z.number().int().min(0), bit: z.number().int().min(0).max(3), on: z.boolean().optional() });
tool('demolish', 'Demolish a building (half the cost back). Needs confirm: true.', { idx: z.number().int().min(1), confirm: z.boolean() });
tool('repair', 'Repair a damaged building.', { idx: z.number().int().min(0) });
tool('train', 'Train soldiers at the barracks. kind: 0 spearmen, 1 archers, 2 swordsmen, 3 knights, 4 catapults.', { kind: z.number().int().min(0).max(4), count: z.number().int().min(1).max(50) });
tool('garrison', 'Station archers in a tower or keep.', { idx: z.number().int().min(0), archers: z.number().int().min(0).max(20) });
tool('drawbridge', 'Raise (up: true) or lower a drawbridge.', { idx: z.number().int().min(0), up: z.boolean() });
tool('form_army', 'Take soldiers out of the barracks into a field army: units = [spearmen, archers, swordsmen, knights, catapults].', { units: z.array(z.number().int().min(0).max(300)).length(5) });
tool('march_army', 'March a field army to a place (relative to the town hall).', { army_id: z.number().int().min(1), dx: z.number().int(), dy: z.number().int() });
tool('recall_army', 'Send a field army home.', { army_id: z.number().int().min(1) });
tool('defend_army', 'Send a field army to join the defence while raiders are attacking (see observe.attack). It marches out to meet them.', { army_id: z.number().int().min(1) });
tool('prices', 'What each resource is worth in coins right now (scarce goods cost more).', {});
tool('choice', 'Is a decision waiting for you (plague, preacher, noble, hard winter)?', {});
tool('decide', 'Answer the waiting decision with option 0, 1 or 2 (see the game for what each means).', { option: z.number().int().min(0).max(2) });
tool('bribe', 'Pay a bandit raid to turn back before it strikes (price in observe.attack_price when one is on). They return sooner and stronger if you pay often. Not for players.', {});
tool('rivals', 'Other players\' villages that are online, with their positions relative to your hall.', {});
tool('relations', 'How each other village feels about you (-100 hostile .. 100 devoted), and your marriages and treaties with them. Read this before sending anything.', {});
tool('envoy', 'Send an envoy with gifts to a village (20 gold, once every 3 days each): relations improve when he arrives.', { key: z.string().max(200) });
tool('gift', 'Send goods to a village as a gift (nothing is paid, relations improve). resource is a key such as grain, wood, iron; amount 1-100. A village that loathes you turns it back.', { key: z.string().max(200), resource: z.string().max(20), amount: z.number().int().min(1).max(100) });
tool('alliance', 'Propose an alliance (needs a trade pact and warm relations; they may refuse).', { key: z.string().max(200) });
tool('marriage', 'Marry into a village house: 150 gold, needs relations of 30, lasting. Needs confirm: true.', { key: z.string().max(200), confirm: z.boolean() });
if (guard.o.allowAttack) tool('declare_war', 'Declare war on another player village: treaties and marriage end, relations collapse. Only with confirm_attack: true.', { key: z.string().max(200), confirm_attack: z.boolean() });
if (guard.o.allowAttack) tool('attack', 'Attack another player\'s village with a field army. Real people play there: only with confirm_attack: true.', { key: z.string(), units: z.array(z.number().int().min(0).max(300)).length(5), confirm_attack: z.boolean() });
server.tool('wait', 'Let the game run for a few real seconds (the agent cannot speed it up).', { seconds: z.number().min(1).max(30) }, async ({ seconds }) => { await new Promise(r => setTimeout(r, seconds * 1000)); return { content: [{ type: 'text', text: 'waited' }] }; });

await server.connect(new StdioServerTransport());

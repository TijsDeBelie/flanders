#!/usr/bin/env node
// Flanders MCP server, headless: the game's Rust core runs inside this process, so an agent plays with no browser and no UI at all.
//   node server.mjs [--world flanders] [--save game.json]
// It plays by the game's own rules (every action is a call into the core) and has no cheat tools. The village is deterministic, so --save keeps the game as a short list of actions
// and a later run continues exactly where it stopped. Replies are deliberately tiny: arrays and numbers instead of prose, actions in batches, static data only on request.
// (The old tool that drives a game in a browser tab is browser-bridge.mjs.)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Game, cleanWorld } from './engine.mjs';

const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const game = new Game({ world: opt('world', process.env.FLANDERS_WORLD ?? 'flanders'), save: opt('save', process.env.FLANDERS_SAVE ?? null) });

/** Every reply is one line of JSON with no spaces. */
const reply = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const MAX_TICKS = 1200;

// Kept short on purpose: these words are in the agent's context for the whole game.
const RULES = `Flanders, a medieval village builder. The game's own rules apply (costs, terrain, workers); nothing can be cheated. Coordinates are relative to your town hall: x east, y south.
Resource arrays always run: wood, planks, stone, clay, bricks, iron ore, iron, gold ore, gold, charcoal, grain, tools, fish, smoked fish, bread, meat, smoked meat (w pl st cl br io ir go gd ch gr tl fi sf bd me sm).
Tools: status (state + next goals), info (building table, or info kind for one), look (buildings, land, deposits, armies, prices), act (a batch of actions), advance (run ticks; pauses at raids, fires, famine, plague, decisions).
Actions, each an array: ["place",kind,dx,dy,rot?,search?] build (mines/quarries snap to the nearest deposit; search 0-12 tries nearby spots) | ["up",idx] | ["opt",idx,bit,on?] | ["demo",idx,true] | ["fix",idx] | ["gar",idx,archers] | ["draw",idx,up] | ["gate",idx,closed] | ["field",idx,0 sow|1 fallow|2 rotate] | ["train",kind,n] | ["hero"] | ["form",s,a,w,k,c,ram?] | ["march",id,dx,dy] | ["recall",id] | ["defend",id] (a field army marches out to join the fight at home) | ["visit",id] | ["bribe"] pay the raiders to leave (price in status.attack_price, bandit raids only, before the first blow; they come back sooner and stronger if you do it often) | ["decide",n].
Reserves: ["reserve",grain,wood] sets both minimum stocks for automatic spending. Direct orders, villagers eating, and winter heating may use them.
Replies: place gives [idx,dx,dy]; other successes give 1; a refusal is a short reason string.
Play: status, info, look land; then act in batches, advance 60-300 ticks, repeat. A day is 240 ticks. Build houses and a farm first, then wood, planks, stone; keep grain positive; raise a tower and train archers before raids.`;

const server = new McpServer({ name: 'flanders', version: '0.2.0' }, { instructions: RULES });

server.tool('status', 'Village state in one small object, plus the next goals.', {}, async () => reply(game.status()));

server.tool('info', 'Building table (id name radius cost), or details of one kind. units:true lists trainable soldiers.',
  { kind: z.number().int().min(0).max(60).optional(), opts: z.boolean().optional(), units: z.boolean().optional() },
  async ({ kind, opts, units }) => reply(units ? game.unitTable() : game.info(kind, opts)));

server.tool('look', 'Read the world. what: buildings {kind?, near?:[dx,dy,r], limit?, offset?} | land {dx?,dy?,half?,step?} | deposits {near?:[dx,dy,r]} | armies | prices.',
  {
    what: z.enum(['buildings', 'land', 'deposits', 'armies', 'prices']),
    kind: z.number().int().optional(), near: z.array(z.number()).length(3).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(),
    dx: z.number().int().min(-300).max(300).optional(), dy: z.number().int().min(-300).max(300).optional(), half: z.number().int().min(4).max(40).optional(), step: z.number().int().min(2).max(10).optional(),
  },
  async a => {
    switch (a.what) {
      case 'buildings': return reply(game.buildings(a));
      case 'land': return reply(game.land(a));
      case 'deposits': return reply(game.deposits({ near: a.near, limit: a.limit }));
      case 'armies': return reply(game.armies());
      default: return reply(game.prices());
    }
  });

server.tool('act', 'A batch of actions (see the rules), done in order. Returns one result per action.',
  { a: z.array(z.array(z.union([z.string(), z.number(), z.boolean()])).min(1)).min(1).max(40) },
  async ({ a }) => {
    const out = a.map(x => { const r = game.act(x); return r.ok ? (r.i !== undefined ? [r.i, ...r.at] : r.id !== undefined ? r.id : 1) : r.e; });
    game.save();
    return reply(out);
  });

server.tool('advance', `Run the village forward (1-${MAX_TICKS} ticks, default 60). Pauses early at raids, fires, famine, plague or a decision unless stop is false. Returns time, events and the main numbers.`,
  { ticks: z.number().int().min(1).max(MAX_TICKS).optional(), stop: z.boolean().optional() },
  async ({ ticks = 60, stop = true }) => {
    const r = game.advance(ticks, stop), w = game.world;
    game.save();
    return reply({ t: game.tick, ran: r.ticks, ev: r.events.length ? r.events : undefined, pop: w.population(), happy: w.happiness(), gr: Array.from(w.stocks())[10], gd: Array.from(w.stocks())[8], attack: w.battle_active() ? 1 : undefined });
  });

await server.connect(new StdioServerTransport());
process.stderr.write(`Flanders (headless) world "${cleanWorld(game.name)}"${game.savePath ? `, save ${game.savePath}` : ', no save file (use --save game.json to keep the game)'}\n`);

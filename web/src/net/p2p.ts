// Serverless multiplayer: every player runs a copy of the game and joins one shared "world" room.
// Rooms rendezvous through public Nostr relays (via Trystero) and then talk directly over WebRTC.
// Commands are signed with an ed25519 key that lives only in this browser.
import { joinRoom } from 'trystero';

export interface Cmd {
  op: 'place' | 'upgrade' | 'demolish' | 'train' | 'attack' | 'raid' | 'refuse' | 'return' | 'cheat' | 'form' | 'march' | 'recall' | 'split' | 'merge' | 'halt' | 'sendatk' | 'repair' | 'rebuild' | 'garrison' | 'bridge' | 'option' | 'flatten' | 'treaty' | 'caravan' | 'choose' | 'visit';
  tick: number; n: number;
  kind?: number; x?: number; y?: number; rot?: number; idx?: number;
  to?: string;            // attack/refuse: pub key of the village concerned
  from?: string;          // raid/return: pub key of the attacking village
  units?: number[]; loot?: number[]; angle?: number; tag?: number;
  ax?: number; ay?: number;   // march: position of the village being attacked
}
export interface Signed { cmd: string; sig: string }

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const enc = new TextEncoder();

export class Identity {
  private constructor(private priv: CryptoKey, public pub: string) {}
  /** Load the key saved in this browser, or make a new one. */
  static async load(slot = '') {
    const store = 'flanders:identity' + (slot ? ':' + slot : '');
    try {
      const saved = localStorage.getItem(store);
      if (saved) {
        const { priv, pub } = JSON.parse(saved);
        return new Identity(await crypto.subtle.importKey('jwk', priv, 'Ed25519', true, ['sign']), pub);
      }
    } catch { /* fall through to a fresh identity */ }
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const pub = b64(await crypto.subtle.exportKey('raw', kp.publicKey));
    try { localStorage.setItem(store, JSON.stringify({ priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub })); } catch { /* private mode */ }
    return new Identity(kp.privateKey, pub);
  }
  async sign(cmd: Cmd): Promise<Signed> {
    const s = JSON.stringify(cmd);
    return { cmd: s, sig: b64(await crypto.subtle.sign('Ed25519', this.priv, enc.encode(s))) };
  }
}

export async function verify(pub: string, m: Signed): Promise<Cmd | null> {
  try {
    const key = await crypto.subtle.importKey('raw', unb64(pub), 'Ed25519', false, ['verify']);
    const ok = await crypto.subtle.verify('Ed25519', key, unb64(m.sig), enc.encode(m.cmd));
    return ok ? JSON.parse(m.cmd) as Cmd : null;
  } catch { return null; }
}

/** Short stable number for a public key, used to tag attackers inside the simulation. */
export function tagOf(pub: string): number { let h = 7; for (let i = 0; i < pub.length; i++) h = (h * 31 + pub.charCodeAt(i)) % 2147483000; return h + 1; }

export interface Hello { pub: string; site: number; name: string; tick: number; world: string }

export interface RoomHandlers {
  onHello(peerId: string, h: Hello): void;
  onCmd(peerId: string, c: Cmd): void;
  onLog(peerId: string, cmds: Cmd[]): void;
  onHash(peerId: string, tick: number, hash: string): void;
  onLeave(peerId: string): void;
  onStatus(s: string): void;
}

export class Room {
  private room: ReturnType<typeof joinRoom>;
  private sendHello: (d: Hello, o?: { target?: string }) => Promise<void>;
  private sendCmd: (d: Signed, o?: { target?: string }) => Promise<void>;
  private sendLog: (d: Signed[], o?: { target?: string }) => Promise<void>;
  private sendHash: (d: { tick: number; hash: string }, o?: { target?: string }) => Promise<void>;
  private pubs = new Map<string, string>();
  peers = new Set<string>();

  constructor(world: string, private hello: () => Hello, private log: () => Signed[], private h: RoomHandlers) {
    this.room = joinRoom({ appId: 'flanders-medieval-p2p-v6' }, world);
    const hello_ = this.room.makeAction('hello'), cmd_ = this.room.makeAction('cmd'), log_ = this.room.makeAction('log'), hash_ = this.room.makeAction('hash');
    this.sendHello = (d, o) => hello_.send(d as never, o); this.sendCmd = (d, o) => cmd_.send(d as never, o);
    this.sendLog = (d, o) => log_.send(d as never, o); this.sendHash = (d, o) => hash_.send(d as never, o);
    h.onStatus('Looking for other players in this world…');
    this.room.onPeerJoin(({ peerId }) => {
      this.peers.add(peerId); h.onStatus(`${this.peers.size} other player${this.peers.size === 1 ? '' : 's'} nearby`);
      this.sendHello(this.hello(), { target: peerId }); this.sendLog(this.log(), { target: peerId });
    });
    this.room.onPeerLeave(({ peerId }) => { this.peers.delete(peerId); this.pubs.delete(peerId); h.onLeave(peerId); h.onStatus(this.peers.size ? `${this.peers.size} other player${this.peers.size === 1 ? '' : 's'} nearby` : 'Alone in the world — share the link to invite others'); });
    hello_.onMessage((d, { peerId }) => { const x = d as unknown as Hello; if (x && typeof x.pub === 'string' && /^[A-Za-z0-9+/_=-]{20,100}$/.test(x.pub) && Number.isInteger(x.site) && x.site >= 0) { this.pubs.set(peerId, x.pub); h.onHello(peerId, x); } });
    // signatures are checked asynchronously: run each peer's messages through one queue so commands are applied in the order they arrived
    const queue = (peerId: string, job: () => Promise<void>) => { const next = (this.chains.get(peerId) ?? Promise.resolve()).then(job).catch(() => { /* a bad message must not stall the queue */ }); this.chains.set(peerId, next); };
    cmd_.onMessage((d, { peerId }) => queue(peerId, async () => { const c = await this.check(peerId, d as unknown as Signed); if (c) h.onCmd(peerId, c); }));
    log_.onMessage((d, { peerId }) => queue(peerId, async () => { const out: Cmd[] = []; for (const s of d as unknown as Signed[]) { const c = await this.check(peerId, s); if (c) out.push(c); } h.onLog(peerId, out); }));
    hash_.onMessage((d, { peerId }) => { const x = d as unknown as { tick: number; hash: string }; h.onHash(peerId, x.tick, x.hash); });
  }

  private chains = new Map<string, Promise<void>>();

  private async check(peerId: string, s: Signed) {
    const pub = this.pubs.get(peerId); if (!pub) return null;
    const c = await verify(pub, s); if (!c) this.h.onStatus('Ignored a command with a bad signature.');
    return c;
  }
  announce() { if (this.peers.size) this.sendHello(this.hello()); }
  broadcastCmd(s: Signed) { if (this.peers.size) this.sendCmd(s); }
  broadcastHash(tick: number, hash: string) { if (this.peers.size) this.sendHash({ tick, hash }); }
  pubOf(peerId: string) { return this.pubs.get(peerId); }
  leave() { this.room.leave(); }
}

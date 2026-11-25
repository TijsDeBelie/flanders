// Procedural sound: no audio files, everything is synthesised with the Web Audio API.
// Layered, restrained and quiet by default: soft wood knocks and chimes for building, a wind bed with the odd bird,
// crackling for fires and metallic clashes for battles.
export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode; private noiseBuf!: AudioBuffer;
  private fireGain: GainNode | null = null; private fireLevel = 0;
  private battleOn = false; private battleT = 0; private birdT = 0;
  muted = localStorage.getItem('flanders:muted') === '1';
  volume = Math.min(1, Math.max(0, Number(localStorage.getItem('flanders:volume') ?? 0.7)));
  /** Silence the game while its tab is in the background. */
  muteHidden = localStorage.getItem('flanders:mutehidden') === '1';
  private hidden = false;

  /** Must be called from a user gesture (a click) the first time. */
  start() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext; if (!AC) return;
    this.ctx = new AC(); this.master = this.ctx.createGain(); this.master.gain.value = this.level(); this.master.connect(this.ctx.destination);
    const n = this.ctx.sampleRate * 2, buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0); let last = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } // brown-ish noise
    this.noiseBuf = buf;
    this.wind(); this.fireBed();
  }

  private level() { return this.muted || (this.muteHidden && this.hidden) ? 0 : this.volume * 0.5; }
  private apply() { if (this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05); }
  setMuted(m: boolean) { this.muted = m; localStorage.setItem('flanders:muted', m ? '1' : '0'); this.apply(); }
  setVolume(v: number) { this.volume = Math.min(1, Math.max(0, v)); localStorage.setItem('flanders:volume', String(this.volume)); this.apply(); }
  setMuteHidden(on: boolean) {
    this.muteHidden = on; localStorage.setItem('flanders:mutehidden', on ? '1' : '0');
    if (!this.watching) { this.watching = true; document.addEventListener('visibilitychange', () => { this.hidden = document.hidden; this.apply(); }); }
    this.hidden = document.hidden; this.apply();
  }
  private watching = false;

  private noise(loop = true) { const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf; s.loop = loop; return s; }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, when = 0, slideTo?: number) {
    const c = this.ctx; if (!c) return; const t = c.currentTime + when, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  private burst(dur: number, freq: number, q: number, gain: number, when = 0, type: BiquadFilterType = 'bandpass') {
    const c = this.ctx; if (!c) return; const t = c.currentTime + when, s = this.noise(false), f = c.createBiquadFilter(), g = c.createGain();
    f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }

  // ---- interface ----
  click() { this.tone(520, 0.06, 'triangle', 0.1); }
  hover() { this.tone(900, 0.025, 'sine', 0.025); }
  error() { this.tone(160, 0.16, 'sawtooth', 0.07, 0, 110); }
  /** Building placed: a wooden thud whose weight grows with the size of the building. */
  place(weight = 1) {
    const w = Math.min(6, weight);
    this.tone(110 - w * 6, 0.22 + w * 0.03, 'sine', 0.22 + w * 0.03, 0, 45);
    this.burst(0.12 + w * 0.02, 320 + (6 - w) * 90, 1.4, 0.35 + w * 0.05);
    if (w >= 3) this.burst(0.32, 120, 0.8, 0.3, 0.04);
    this.tone(660, 0.1, 'triangle', 0.05, 0.03);
  }
  upgrade() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.09, i * 0.07)); this.burst(0.25, 500, 1, 0.15); }
  demolish() { this.burst(0.5, 220, 0.7, 0.5); this.tone(70, 0.4, 'sine', 0.2, 0, 35); }
  coin() { this.tone(1318.5, 0.18, 'sine', 0.07); this.tone(1760, 0.3, 'sine', 0.06, 0.07); }
  alert() { this.tone(220, 0.35, 'sawtooth', 0.07, 0, 170); this.tone(220, 0.35, 'sawtooth', 0.07, 0.4, 170); }
  horn() { this.tone(120, 1.2, 'sawtooth', 0.12, 0, 150); this.tone(180, 1.2, 'sawtooth', 0.06, 0, 225); }
  /** The warlord's horn: a long, low blast with a rising second voice. */
  warhorn() { this.tone(98, 1.6, 'sawtooth', 0.16, 0, 130); this.tone(147, 1.6, 'sawtooth', 0.08, 0.05, 190); this.tone(196, 1.2, 'triangle', 0.05, 0.3, 240); }
  /** The ogre's slam: a deep thump and a spray of grit. */
  slam() { this.tone(70, 0.5, 'sine', 0.32, 0, 32); this.burst(0.35, 160, 0.7, 0.45); this.burst(0.2, 900, 1.2, 0.18, 0.05); }
  train() { this.tone(392, 0.2, 'triangle', 0.08); this.tone(587, 0.25, 'triangle', 0.08, 0.1); }

  // ---- ambience ----
  private wind() {
    const c = this.ctx!, s = this.noise(), f = c.createBiquadFilter(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    f.type = 'lowpass'; f.frequency.value = 420; g.gain.value = 0.07; lfo.frequency.value = 0.07; lg.gain.value = 0.035;
    lfo.connect(lg); lg.connect(g.gain); s.connect(f); f.connect(g); g.connect(this.master); s.start(); lfo.start();
  }
  private fireBed() {
    const c = this.ctx!, s = this.noise(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'highpass'; f.frequency.value = 1400; g.gain.value = 0; s.connect(f); f.connect(g); g.connect(this.master); s.start(); this.fireGain = g;
  }
  private bird() {
    const base = 2200 + Math.random() * 1600, n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this.tone(base, 0.09, 'sine', 0.025, i * 0.13, base * (1.25 + Math.random() * 0.4));
  }

  /** Call every frame with the time step, the number of fires, and whether a battle is under way. */
  update(dt: number, fires: number, battle: boolean) {
    const c = this.ctx; if (!c || this.muted) return;
    const target = Math.min(0.14, fires * 0.025); this.fireLevel += (target - this.fireLevel) * Math.min(1, dt * 2); this.fireGain!.gain.setTargetAtTime(this.fireLevel, c.currentTime, 0.1);
    if (fires > 0 && Math.random() < dt * 14) this.burst(0.05, 2500 + Math.random() * 2500, 3, 0.12 * Math.min(1, fires * 0.4));
    this.birdT -= dt; if (this.birdT <= 0) { this.birdT = 4 + Math.random() * 9; if (!battle && fires === 0) this.bird(); }
    if (battle && !this.battleOn) this.horn();
    this.battleOn = battle; this.battleT -= dt;
    if (battle && this.battleT <= 0) { this.battleT = 0.12 + Math.random() * 0.35; const f = 1400 + Math.random() * 2600; this.burst(0.09, f, 8, 0.16); this.tone(f * 0.6, 0.14, 'triangle', 0.025); if (Math.random() < 0.2) this.tone(80 + Math.random() * 40, 0.2, 'sine', 0.1, 0, 50); }
  }
}

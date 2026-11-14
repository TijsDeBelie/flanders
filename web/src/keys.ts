// Keyboard bindings. Bindings use the character a key produces (event.key), so the same default
// set works on QWERTY and AZERTY: W/Z move forward, A/Q left. Digits use physical positions (event.code).
export type Action =
  | 'panUp' | 'panDown' | 'panLeft' | 'panRight' | 'panFast'
  | 'rotLeft' | 'rotRight' | 'tiltUp' | 'tiltDown' | 'zoomIn' | 'zoomOut'
  | 'rotateBuilding' | 'deposits' | 'pause' | 'cancel' | 'perf' | 'help' | 'toggleLedger' | 'toggleMinimap' | 'fullMap' | 'fullscreen' | 'nextArmy' | 'haltArmy' | 'recallArmy' | 'musterAll' | 'penFinish' | 'penUndo';

export const ACTIONS: { id: Action; label: string; group: string; defaults: string[] }[] = [
  { id: 'panUp', label: 'Move forward', group: 'Camera', defaults: ['w', 'z', 'arrowup'] },
  { id: 'panDown', label: 'Move back', group: 'Camera', defaults: ['s', 'arrowdown'] },
  { id: 'panLeft', label: 'Move left', group: 'Camera', defaults: ['a', 'q', 'arrowleft'] },
  { id: 'panRight', label: 'Move right', group: 'Camera', defaults: ['d', 'arrowright'] },
  { id: 'panFast', label: 'Move faster (hold)', group: 'Camera', defaults: ['shift'] },
  { id: 'rotLeft', label: 'Turn camera left', group: 'Camera', defaults: ['x', 'home'] },
  { id: 'rotRight', label: 'Turn camera right', group: 'Camera', defaults: ['e', 'end'] },
  { id: 'tiltUp', label: 'Tilt camera up', group: 'Camera', defaults: ['pageup'] },
  { id: 'tiltDown', label: 'Tilt camera down', group: 'Camera', defaults: ['pagedown'] },
  { id: 'zoomIn', label: 'Zoom in', group: 'Camera', defaults: ['+', '='] },
  { id: 'zoomOut', label: 'Zoom out', group: 'Camera', defaults: ['-', '_'] },
  { id: 'rotateBuilding', label: 'Rotate the building you place', group: 'Building', defaults: ['r'] },
  { id: 'penFinish', label: 'Pen: build the path you have drawn', group: 'Building', defaults: ['enter'] },
  { id: 'penUndo', label: 'Pen: remove the last corner', group: 'Building', defaults: ['backspace'] },
  { id: 'cancel', label: 'Cancel / close', group: 'Game', defaults: ['escape'] },
  { id: 'pause', label: 'Pause / resume', group: 'Game', defaults: [' '] },
  { id: 'deposits', label: 'Show ore deposits', group: 'Game', defaults: ['v'] },
  { id: 'perf', label: 'Performance monitor', group: 'Game', defaults: ['f3', 'p'] },
  { id: 'help', label: 'Help', group: 'Game', defaults: ['f1'] },
  { id: 'nextArmy', label: 'Select next field army', group: 'Armies', defaults: ['tab'] },
  { id: 'haltArmy', label: 'Halt the selected army', group: 'Armies', defaults: ['g'] },
  { id: 'recallArmy', label: 'Send the selected army home', group: 'Armies', defaults: ['b'] },
  { id: 'musterAll', label: 'Muster every soldier into a field army', group: 'Armies', defaults: ['f'] },
  { id: 'toggleLedger', label: 'Hide / show the side panel', group: 'Interface', defaults: ['h'] },
  { id: 'fullMap', label: 'Full-screen map', group: 'Interface', defaults: ['m'] },
  { id: 'toggleMinimap', label: 'Hide / show the minimap', group: 'Interface', defaults: ['n'] },
  { id: 'fullscreen', label: 'Full-screen mode', group: 'Interface', defaults: ['f11'] },
];

const STORE = 'flanders:keys';

export const prettyKey = (k: string) => ({ ' ': 'Space', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', escape: 'Esc', pageup: 'PgUp', pagedown: 'PgDn' } as Record<string, string>)[k] ?? (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1));

class Keys {
  binds = {} as Record<Action, string[]>;
  private down = new Set<string>();
  private listeners: (() => void)[] = [];

  constructor() {
    this.reset(false);
    try { const s = JSON.parse(localStorage.getItem(STORE) ?? 'null'); if (s) for (const a of ACTIONS) if (Array.isArray(s[a.id])) this.binds[a.id] = s[a.id]; } catch { /* ignore */ }
    if (this.binds.toggleMinimap.length === 1 && this.binds.toggleMinimap[0] === 'm') this.binds.toggleMinimap = ['n'];   // M now opens the full map
    addEventListener('keydown', e => { if (!this.typing(e)) this.down.add(e.key.toLowerCase()); });
    addEventListener('keyup', e => this.down.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.down.clear());
  }

  private typing(e: Event) { return !!(e.target as HTMLElement)?.matches?.('input,textarea,select'); }

  /** Is any key bound to this action held down right now? */
  isDown(a: Action) { return this.binds[a].some(k => this.down.has(k)); }

  /** Does this key event trigger the action? */
  matches(e: KeyboardEvent, a: Action) { return this.binds[a].includes(e.key.toLowerCase()); }

  /** Which action (if any) does this event trigger? */
  actionOf(e: KeyboardEvent): Action | null { const k = e.key.toLowerCase(); for (const a of ACTIONS) if (this.binds[a.id].includes(k)) return a.id; return null; }

  set(a: Action, keys: string[]) {
    // a key can only do one thing: take it away from other actions
    for (const o of ACTIONS) if (o.id !== a) this.binds[o.id] = this.binds[o.id].filter(k => !keys.includes(k));
    this.binds[a] = keys; this.save();
  }
  reset(save = true) { for (const a of ACTIONS) this.binds[a.id] = [...a.defaults]; if (save) this.save(); }
  private save() { try { localStorage.setItem(STORE, JSON.stringify(this.binds)); } catch { /* ignore */ } this.listeners.forEach(l => l()); }
  onChange(l: () => void) { this.listeners.push(l); }
}

export const keys = new Keys();

/** Number-row / numpad digit pressed (1-9), independent of keyboard layout. */
export function digitOf(e: KeyboardEvent): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code); return m ? Number(m[1]) : null;
}

// Pixel art for the office: one desk per member, drawn on a small canvas that
// the page scales up without smoothing. Pure drawing, no React and no data
// fetching: Office.tsx turns a run into a Scene and calls drawScene each frame.

/** What a member is doing, as the office shows it. */
export type DeskState = 'sleeping' | 'working' | 'asking' | 'needs' | 'held' | 'done' | 'stopped';

/** Decides the desk props and what the screen shows. */
export type Kind = 'lead' | 'frontend' | 'backend' | 'review' | 'test' | 'docs' | 'general';

export interface Figure {
  name: string;
  /** The member's color (its avatar color). */
  color: string;
  kind: Kind;
  skin: string;
  hair: string;
  hat: string;
  style: 'short' | 'long' | 'beanie' | 'curly' | 'bun';
  glasses: boolean;
}

export interface Desk {
  fig: Figure;
  state: DeskState;
  cx: number;
  /** Top of the desk surface. */
  by: number;
}

export type BoardStep = { label: string; status: 'done' | 'now' | 'failed' | 'next' };

export interface Scene {
  w: number;
  h: number;
  desks: Desk[];
  board: { status: string; statusTone: 'ink' | 'warn' | 'good' | 'bad'; steps: BoardStep[]; cost: string; footLeft: string; footRight: string; footTone: 'ink' | 'warn' | 'good' };
  selected?: string;
  hovered?: string;
  dark: boolean;
}

// ------------------------------------------------------------------ layout

export const W = 320;
const WALL = 64;
const ROW = 62;
const COLS = 3;
const COL = 104;

/** Desk positions for a team: rows of up to three, each row centred. */
export function layout(n: number): { h: number; spots: { cx: number; by: number }[] } {
  const rows = Math.max(1, Math.ceil(n / COLS));
  const spots: { cx: number; by: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const k = Math.min(COLS, n - r * COLS);
    for (let i = 0; i < k; i++) spots.push({ cx: Math.round(W / 2 + (i - (k - 1) / 2) * COL), by: WALL + 26 + r * ROW });
  }
  return { h: WALL + 26 + (rows - 1) * ROW + 38, spots };
}

/** Where the clickable area of a desk is, in canvas pixels (the plate sits at plateTop). */
export function spotBox(cx: number, by: number) {
  return { x: cx - 40, y: by - 31, w: 80, h: 62, plateTop: by + 12 };
}

// ------------------------------------------------------------------ people

function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const SKINS = ['#f1c7a0', '#e0ac85', '#c58a5c', '#8d5a3b', '#f3d2b5', '#e8b890', '#6b4029'];
const HAIRS = ['#2b2118', '#14110f', '#7a4a21', '#c9c9d4', '#b53a78', '#d9a441', '#3b2a20', '#5a3214'];
const HATS = ['#2f4a7a', '#7a2f3f', '#2f6b4a', '#5b4a8a'];
const STYLES: Figure['style'][] = ['short', 'long', 'beanie', 'curly', 'bun'];

const KIND_RULES: [Kind, RegExp][] = [
  ['test', /test/],
  ['review', /review|\bqa\b|audit/],
  ['frontend', /front|\bui\b|web|design|css|ux/],
  ['backend', /back|api|server|\bdb\b|database|infra|ops/],
  ['docs', /doc|writ|curat|brain/],
  ['lead', /manag|lead|plan|architect/],
];

/** A role from the member's name (first) or description, for its desk props and screen. */
export function kindOf(name: string, description = '', lead = false): Kind {
  if (lead) return 'lead';
  for (const text of [name.toLowerCase(), description.toLowerCase()]) for (const [kind, re] of KIND_RULES) if (re.test(text)) return kind;
  return 'general';
}

/** The same member always looks the same. */
export function figureFor(name: string, color: string, kind: Kind): Figure {
  const h = hashOf(name);
  return {
    name,
    color,
    kind,
    skin: SKINS[h % SKINS.length]!,
    hair: HAIRS[(h >>> 4) % HAIRS.length]!,
    hat: HATS[(h >>> 8) % HATS.length]!,
    style: STYLES[(h >>> 12) % STYLES.length]!,
    glasses: (h >>> 16) % 10 < 3,
  };
}

// ------------------------------------------------------------------ palettes

interface Palette {
  wall: string; wallLine: string; wain: string; wainTop: string; base: string; floorA: string; floorB: string; floorLine: string;
  deskTop: string; deskFront: string; deskEdge: string; chair: string; sky: string; frame: string; frameD: string;
  board: string; boardFrame: string; ink: string; inkSoft: string; plant: string; plantD: string; pot: string;
  arrow: string; z: string; bubble: string; bubbleLine: string; kb: string; glow: boolean;
}

/** Light theme: the office by day. Dark theme: the same office at night, lit by the screens. */
const DAY: Palette = {
  wall: '#c8d4e4', wallLine: '#bac8dc', wain: '#97abc6', wainTop: '#adbdd4', base: '#6f84a3', floorA: '#d8b98f', floorB: '#d0b087', floorLine: '#bf9c70',
  deskTop: '#d6a26a', deskFront: '#a8723f', deskEdge: '#7f5330', chair: '#4b5873', sky: '#8ec5f2', frame: '#f4f6fa', frameD: '#c5cee0',
  board: '#fbfcfd', boardFrame: '#8d9ab0', ink: '#2b3347', inkSoft: '#9aa4b8', plant: '#3f9a52', plantD: '#2d7a3e', pot: '#b4573c',
  arrow: '#0a6cff', z: '#40507a', bubble: '#ffffff', bubbleLine: '#2b3347', kb: '#e4e8f0', glow: false,
};
const NIGHT: Palette = {
  wall: '#2b3550', wallLine: '#262f48', wain: '#1f2740', wainTop: '#34406a', base: '#141a2c', floorA: '#3a3a52', floorB: '#35354c', floorLine: '#2a2a40',
  deskTop: '#a8764a', deskFront: '#7b5233', deskEdge: '#573823', chair: '#222a40', sky: '#0f1630', frame: '#56648c', frameD: '#3e4a6e',
  board: '#dfe5ee', boardFrame: '#5a6784', ink: '#232a3c', inkSoft: '#8c97ad', plant: '#2f7d44', plantD: '#235f34', pot: '#8e4430',
  arrow: '#8fc2ff', z: '#a9bcff', bubble: '#ecf0fa', bubbleLine: '#0b0f1d', kb: '#8d96ad', glow: true,
};

// ------------------------------------------------------------------ helpers

type Ctx = CanvasRenderingContext2D;

function rect(c: Ctx, x: number, y: number, w: number, h: number, col: string) {
  c.fillStyle = col;
  c.fillRect(x, y, w, h);
}

export function shade(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  if (f < 0) {
    const k = 1 + f;
    r *= k; g *= k; b *= k;
  } else {
    r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f;
  }
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

const noise = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** 3×5 bitmap font for the whiteboard. */
const GLYPHS: Record<string, string> = {
  A: '010/101/111/101/101', B: '110/101/110/101/110', C: '011/100/100/100/011', D: '110/101/101/101/110', E: '111/100/110/100/111',
  F: '111/100/110/100/100', G: '011/100/101/101/011', H: '101/101/111/101/101', I: '111/010/010/010/111', J: '001/001/001/101/010',
  K: '101/101/110/101/101', L: '100/100/100/100/111', M: '101/111/111/101/101', N: '110/101/101/101/101', O: '010/101/101/101/010',
  P: '110/101/110/100/100', Q: '010/101/101/110/011', R: '110/101/110/101/101', S: '011/100/010/001/110', T: '111/010/010/010/010',
  U: '101/101/101/101/111', V: '101/101/101/101/010', W: '101/101/111/111/101', X: '101/101/010/101/101', Y: '101/101/010/010/010',
  Z: '111/001/010/100/111', '0': '111/101/101/101/111', '1': '010/110/010/010/111', '2': '110/001/010/100/111', '3': '110/001/010/001/110',
  '4': '101/101/111/001/001', '5': '111/100/110/001/110', '6': '011/100/111/101/111', '7': '111/001/010/010/010', '8': '111/101/111/101/111',
  '9': '111/101/111/001/110', '/': '001/001/010/100/100', '.': '000/000/000/000/010', '-': '000/000/111/000/000', $: '011/110/010/011/110',
  '?': '110/001/010/000/010', '!': '010/010/010/000/010', ':': '000/010/000/010/000', '+': '000/010/111/010/000', ' ': '000/000/000/000/000',
};
const ROWS: Record<string, string[]> = Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [k, v.split('/')]));

/** Upper-case and drop what the font cannot draw. */
export function boardText(s: string): string {
  return s.toUpperCase().replace(/[_]/g, '-').replace(/[^A-Z0-9/.\-$?!:+ ]/g, '');
}

function text(c: Ctx, s: string, x: number, y: number, col: string) {
  c.fillStyle = col;
  for (const ch of s) {
    const g = ROWS[ch];
    if (g) for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j]![i] === '1') c.fillRect(x + i, y + j, 1, 1);
    x += 4;
  }
}
const textW = (s: string) => s.length * 4 - 1;
const fit = (s: string, px: number) => s.slice(0, Math.max(1, Math.floor((px + 1) / 4)));

// ------------------------------------------------------------------ room

const backgrounds = new Map<string, HTMLCanvasElement>();

function room(w: number, h: number, dark: boolean): HTMLCanvasElement {
  const key = `${w}x${h}:${dark}`;
  const cached = backgrounds.get(key);
  if (cached) return cached;
  const P = dark ? NIGHT : DAY;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const r = (x: number, y: number, ww: number, hh: number, col: string) => rect(g, x, y, ww, hh, col);
  r(0, 0, w, WALL, P.wall);
  for (let x = 0; x < w; x += 16) r(x, 0, 1, 46, P.wallLine);
  r(0, 46, w, 16, P.wain); r(0, 46, w, 1, P.wainTop); r(0, 62, w, 2, P.base);
  for (let y = WALL, row = 0; y < h; y += 8, row++) {
    r(0, y, w, 8, row % 2 ? P.floorA : P.floorB); r(0, y, w, 1, P.floorLine);
    for (let x = (row % 2) * 20 + 8; x < w; x += 40) r(x, y, 1, 8, P.floorLine);
  }
  // window
  r(11, 6, 50, 38, P.frameD); r(13, 6, 46, 36, P.frame); r(15, 8, 42, 30, P.sky);
  if (dark) {
    for (const [x, y] of [[20, 12], [29, 18], [44, 11], [50, 24], [24, 30], [38, 28]] as const) r(x, y, 1, 1, '#dbe4ff');
    r(46, 13, 6, 6, '#f4f1d4'); r(48, 12, 3, 1, '#f4f1d4'); r(49, 14, 4, 4, P.sky); r(50, 14, 3, 1, P.sky);
  } else {
    r(20, 14, 12, 3, '#fff'); r(23, 12, 7, 2, '#fff'); r(40, 24, 13, 3, '#fff'); r(43, 22, 7, 2, '#fff');
    r(15, 34, 42, 4, '#7fb47a'); r(30, 32, 10, 2, '#7fb47a');
  }
  r(35, 8, 2, 30, P.frame); r(15, 22, 42, 2, P.frame); r(9, 43, 54, 3, P.frameD);
  // shelf with books
  r(264, 38, 34, 3, P.deskEdge);
  let bx = 266;
  ['#e7609e', '#3a86f0', '#f08a2c', '#1fb5a3', '#8a6cf0', '#9bbd2f', '#f2c14e'].forEach((col, i) => {
    const bh = 8 + ((i * 5) % 6);
    r(bx, 38 - bh, 3, bh, col); r(bx, 38 - bh, 3, 1, shade(col, 0.3));
    bx += 4;
  });
  r(284, 30, 10, 8, P.pot); r(286, 24, 6, 7, P.plant); r(284, 27, 3, 4, P.plantD);
  // corner plant
  r(302, 34, 14, 22, P.plantD); r(298, 40, 22, 12, P.plant); r(304, 30, 8, 8, P.plant); r(301, 36, 4, 10, P.plantD); r(313, 38, 4, 10, P.plantD);
  r(304, 54, 12, 10, P.pot); r(304, 54, 12, 2, shade(P.pot, 0.25));
  // coffee machine (bottom left) and water cooler (bottom right)
  const cy = h - 40;
  r(2, cy, 14, 3, '#5a6684'); r(3, cy + 2, 12, 18, '#414b64'); r(5, cy + 6, 8, 2, '#1c2234'); r(6, cy + 11, 6, 7, '#181d2d'); r(7, cy + 15, 4, 3, '#fff'); r(11, cy + 4, 2, 2, '#4ade80'); r(2, cy + 20, 14, 2, '#2b3248');
  const wy = h - 44;
  r(306, wy, 8, 11, dark ? '#6aa6dd' : '#9ed3ff'); r(307, wy + 1, 2, 8, '#fff'); r(305, wy + 11, 10, 20, dark ? '#9aa6bd' : '#dfe6f0'); r(309, wy + 17, 3, 2, '#2b6cb0'); r(307, wy + 24, 6, 3, dark ? '#6c768c' : '#b8c3d6');
  backgrounds.set(key, c);
  return c;
}

// ------------------------------------------------------------------ figures

type Mood = 'open' | 'closed' | 'happy' | 'surprised' | 'grumpy' | 'curious';
const MOOD: Record<DeskState, Mood> = { sleeping: 'closed', working: 'open', asking: 'curious', needs: 'surprised', held: 'open', done: 'happy', stopped: 'grumpy' };

function head(c: Ctx, f: Figure, cx: number, hy: number, mood: Mood, tk: number) {
  const r = (x: number, y: number, w: number, h: number, col: string) => rect(c, x, y, w, h, col);
  const ink = '#1b1b24';
  r(cx - 4, hy + 1, 8, 8, f.skin);
  const ey = hy + 4;
  const blink = tk % 31 === 0;
  if (mood === 'closed') {
    r(cx - 4, ey + 1, 2, 1, ink); r(cx + 1, ey + 1, 2, 1, ink);
  } else if (mood === 'happy') {
    for (const [x, y] of [[cx - 4, ey + 1], [cx - 3, ey], [cx - 2, ey + 1], [cx + 1, ey + 1], [cx + 2, ey], [cx + 3, ey + 1]] as const) r(x, y, 1, 1, ink);
  } else {
    const hh = blink ? 1 : f.glasses ? 1 : 2;
    const yy = blink ? ey + 1 : ey;
    r(cx - 3, yy, 1, hh, ink); r(cx + 2, yy, 1, hh, ink);
    if (mood === 'grumpy') { r(cx - 4, ey - 1, 2, 1, ink); r(cx + 1, ey - 1, 2, 1, ink); }
    if (mood === 'curious') r(cx + 1, ey - 2, 2, 1, ink);
  }
  if (f.glasses && mood !== 'closed') {
    const fr = '#2a2f45';
    for (const x of [cx - 4, cx + 1]) { r(x, ey - 1, 3, 1, fr); r(x, ey + 1, 3, 1, fr); r(x, ey, 1, 1, fr); r(x + 2, ey, 1, 1, fr); }
    r(cx - 1, ey, 2, 1, fr);
  }
  const md = shade(f.skin, -0.3);
  if (mood === 'happy') { r(cx - 2, hy + 6, 1, 1, md); r(cx + 1, hy + 6, 1, 1, md); r(cx - 1, hy + 7, 2, 1, md); }
  else if (mood === 'surprised') r(cx - 1, hy + 6, 2, 2, '#7a2e2e');
  else if (mood === 'grumpy') { r(cx - 1, hy + 7, 2, 1, md); r(cx - 2, hy + 8, 1, 1, md); r(cx + 1, hy + 8, 1, 1, md); }
  else r(cx - 1, hy + 7, 2, 1, md);
  const hr = f.hair;
  switch (f.style) {
    case 'long': r(cx - 4, hy, 8, 3, hr); r(cx - 5, hy + 1, 1, 9, hr); r(cx + 4, hy + 1, 1, 9, hr); r(cx - 4, hy + 3, 1, 5, hr); r(cx + 3, hy + 3, 1, 5, hr); break;
    case 'beanie': r(cx - 5, hy - 1, 10, 4, f.hat); r(cx - 5, hy + 2, 10, 1, shade(f.hat, -0.3)); break;
    case 'curly': r(cx - 5, hy - 1, 10, 4, hr); r(cx - 5, hy + 3, 2, 3, hr); r(cx + 3, hy + 3, 2, 3, hr); r(cx - 3, hy - 2, 2, 1, hr); r(cx + 1, hy - 2, 2, 1, hr); break;
    case 'bun': r(cx - 4, hy, 8, 3, hr); r(cx - 4, hy + 3, 1, 2, hr); r(cx + 3, hy + 3, 1, 2, hr); r(cx - 2, hy - 3, 4, 3, hr); break;
    default: r(cx - 4, hy, 8, 3, hr); r(cx - 4, hy + 3, 1, 2, hr); r(cx + 3, hy + 3, 1, 2, hr);
  }
}

/** Chair, body and head: everything behind the desk. */
function figureBack(c: Ctx, P: Palette, f: Figure, st: DeskState, t: number, cx: number, hy: number, by: number) {
  const r = (x: number, y: number, w: number, h: number, col: string) => rect(c, x, y, w, h, col);
  r(cx - 9, hy + 7, 18, by - hy - 7, P.chair); r(cx - 8, hy + 6, 16, 1, P.chair);
  const tk = Math.floor(t / 130);
  const sh = shade(f.color, -0.22);
  if (st === 'sleeping') {
    const bob = Math.floor(t / 1000) % 2;
    r(cx - 7, by - 8 + bob, 14, 9, f.color); r(cx - 7, by - 8 + bob, 14, 1, sh);
    return;
  }
  r(cx - 6, hy + 9, 12, by - hy - 9, f.color); r(cx - 6, hy + 9, 12, 1, sh); r(cx - 2, hy + 9, 4, 1, shade(f.skin, -0.2));
  if (st !== 'stopped') {
    r(cx - 8, hy + 10, 2, by - hy - 10, f.color);
    if (st === 'needs' || st === 'asking') {
      // A raised hand: waving for the human, held still for the lead.
      const wave = st === 'needs' && tk % 4 >= 2 ? 1 : 0;
      r(cx + 6, hy + 9, 2, 2, f.color); r(cx + 8, hy + 3, 2, 8, f.color); r(cx + 8 + wave, hy + 1, 2, 2, f.skin);
    } else r(cx + 6, hy + 10, 2, by - hy - 10, f.color);
  }
  head(c, f, cx, hy, MOOD[st], tk);
  if (st === 'stopped') { r(cx - 7, hy + 13, 14, 3, sh); r(cx - 8, hy + 13, 2, 2, f.skin); r(cx + 6, hy + 14, 2, 2, f.skin); }
}

/** Hands, keyboard and mug: everything in front of the desk. */
function figureFront(c: Ctx, P: Palette, f: Figure, st: DeskState, t: number, cx: number, hy: number, by: number) {
  const r = (x: number, y: number, w: number, h: number, col: string) => rect(c, x, y, w, h, col);
  const tk = Math.floor(t / 130);
  const sh = shade(f.color, -0.22);
  if (st === 'sleeping') {
    const bob = Math.floor(t / 1000) % 2;
    head(c, f, cx, by - 14 + bob, 'closed', 1);
    r(cx - 9, by - 4 + bob, 18, 5, f.color); r(cx - 9, by - 4 + bob, 18, 1, sh); r(cx - 10, by - 2 + bob, 2, 3, f.skin); r(cx + 8, by - 2 + bob, 2, 3, f.skin);
    return;
  }
  r(cx - 7, by + 1, 14, 3, P.kb);
  if (st === 'working') {
    for (let i = 0; i < 3; i++) if (noise(tk + i) > 0.55) r(cx - 6 + Math.floor(noise(tk * 3 + i) * 12), by + 2, 1, 1, '#fff');
    r(cx - 6, by + (tk % 2 ? 0 : 1), 3, 2, f.skin); r(cx + 3, by + (tk % 2 ? 1 : 0), 3, 2, f.skin);
  } else {
    r(cx - 6, by + 1, 3, 2, f.skin);
    if (st !== 'stopped' && st !== 'needs' && st !== 'asking') r(cx + 3, by + 1, 3, 2, f.skin);
  }
  if (st === 'done') {
    const lift = Math.floor(t / 400) % 12 < 4;
    const mx = lift ? cx + 1 : cx + 20, my = lift ? hy + 8 : by - 4;
    r(mx, my, 5, 5, '#fdfdfd'); r(mx + 5, my + 1, 1, 3, '#fdfdfd'); r(mx + 1, my + 1, 3, 1, '#7a4a21');
    r(mx + (Math.floor(t / 300) % 2 ? 1 : 3), my - 3, 1, 2, lift ? '#ffffffcc' : '#ffffff88');
  }
}

function drawDesk(c: Ctx, P: Palette, cx: number, by: number) {
  const r = (x: number, y: number, w: number, h: number, col: string) => rect(c, x, y, w, h, col);
  r(cx - 36, by + 16, 3, 4, P.deskEdge); r(cx + 33, by + 16, 3, 4, P.deskEdge);
  r(cx - 37, by, 74, 4, P.deskTop); r(cx - 37, by, 74, 1, shade(P.deskTop, 0.25));
  r(cx - 37, by + 4, 74, 12, P.deskFront); r(cx - 37, by + 15, 74, 1, P.deskEdge);
  r(cx + 18, by + 6, 15, 8, shade(P.deskFront, -0.12)); r(cx + 24, by + 9, 3, 1, '#e9c46a');
}

/** Something on the desk that says what the member does. */
function prop(c: Ctx, f: Figure, cx: number, by: number, t: number, dark: boolean) {
  const r = (x: number, y: number, w: number, h: number, col: string) => rect(c, x, y, w, h, col);
  const x = cx - 33;
  switch (f.kind) {
    case 'lead': r(x, by - 9, 9, 10, '#7b86a3'); r(x + 1, by - 8, 7, 8, '#fff'); r(x + 3, by - 10, 3, 2, '#7b86a3'); r(x + 2, by - 6, 5, 1, '#9aa4b8'); r(x + 2, by - 4, 4, 1, '#9aa4b8'); r(x + 10, by - 5, 5, 5, '#ffe066'); r(x + 12, by - 8, 5, 5, '#ff9ec7'); break;
    case 'frontend': ['#e7609e', '#3a86f0', '#f2c14e', '#1fb5a3'].forEach((col, i) => r(x + i * 4, by - 4 + (i % 2), 3, 5 - (i % 2), col)); r(x, by - 8, 14, 3, '#f4f6fa'); r(x + 1, by - 7, 6, 1, '#e7609e'); break;
    case 'backend': {
      const on = Math.floor(t / 400) % 2;
      r(x, by - 11, 11, 5, '#3b4560'); r(x, by - 6, 11, 6, '#323b52'); r(x + 1, by - 9, 5, 1, '#1b2030'); r(x + 1, by - 4, 5, 1, '#1b2030');
      r(x + 8, by - 9, 2, 1, on ? '#4ade80' : '#1f5a37'); r(x + 8, by - 4, 2, 1, on ? '#1f5a37' : '#4ade80');
      break;
    }
    case 'review': r(x, by - 2, 9, 2, '#9aa4b8'); r(x + 1, by - 9, 6, 7, dark ? '#40506e' : '#cfe0f4'); r(x + 2, by - 11, 4, 2, '#9aa4b8'); r(x + 3, by - 6, 3, 3, '#4ade80'); r(x + 2, by - 5, 1, 1, '#4ade80'); r(x + 6, by - 5, 1, 1, '#4ade80'); r(x + 11, by - 8, 5, 5, '#7b86a3'); r(x + 12, by - 7, 3, 3, dark ? '#9bd1ff' : '#dff0ff'); r(x + 15, by - 3, 3, 3, '#7b86a3'); break;
    case 'test': r(x, by - 3, 15, 3, '#7b86a3'); ([['#4ade80', 8], ['#4ade80', 6], ['#ff6b6b', 7]] as const).forEach(([col, h], i) => { r(x + 1 + i * 5, by - 3 - h, 3, h, dark ? '#a9bcff55' : '#ffffffaa'); r(x + 1 + i * 5, by - h, 3, h - 3, col); }); break;
    case 'docs': r(x, by - 3, 15, 3, '#8a6cf0'); r(x + 1, by - 6, 13, 3, '#e7609e'); r(x, by - 9, 14, 3, '#3a86f0'); r(x + 2, by - 8, 6, 1, '#fff'); r(x + 3, by - 5, 6, 1, '#fff'); r(x + 2, by - 2, 7, 1, '#fff'); break;
    default: r(x + 2, by - 6, 5, 6, '#fdfdfd'); r(x + 7, by - 5, 1, 3, '#fdfdfd'); r(x + 3, by - 5, 3, 1, '#7a4a21'); r(x + 10, by - 4, 6, 4, '#b4573c'); r(x + 11, by - 9, 4, 5, '#3f9a52');
  }
}

/** The monitor, showing the member's state (and its kind of work while it works). */
function screen(c: Ctx, f: Figure, st: DeskState, t: number, mx: number, my: number) {
  const r = (x: number, y: number, w: number, h: number, col: string) => rect(c, x, y, w, h, col);
  const sx = mx + 2, sy = my + 2, tk = Math.floor(t / 260);
  const blink = Math.floor(t / 400) % 2 === 1;
  r(mx, my, 22, 16, '#2a3042'); r(mx, my + 14, 22, 2, '#222839');
  const led = (col: string) => r(mx + 10, my + 14, 2, 1, col);
  switch (st) {
    case 'sleeping': r(sx, sy, 18, 10, '#161b28'); led(Math.floor(t / 900) % 2 ? '#ff9d3c' : '#5a4630'); return;
    case 'needs':
      r(sx, sy, 18, 10, '#161b28');
      if (blink) { r(sx + 3, sy + 2, 12, 5, '#ffb020'); r(sx + 4, sy + 7, 2, 2, '#ffb020'); r(sx + 5, sy + 4, 8, 1, '#7a4a00'); }
      led('#ffb020');
      return;
    case 'asking': r(sx, sy, 18, 10, '#101a2e'); text(c, '?', sx + 8, sy + 3, blink ? '#8fc2ff' : '#3b6fb8'); led('#4a9dff'); return;
    case 'held': r(sx, sy, 18, 10, '#1d1a12'); r(sx + 6, sy + 2, 2, 6, '#e0a030'); r(sx + 10, sy + 2, 2, 6, '#e0a030'); led('#e0a030'); return;
    case 'done': r(sx, sy, 18, 10, '#0f2418'); for (const [x, y] of [[5, 5], [6, 6], [7, 7], [8, 6], [9, 5], [10, 4], [11, 3], [12, 2]] as const) r(sx + x, sy + y, 1, 2, '#4ade80'); led('#4ade80'); return;
    case 'stopped': r(sx, sy, 18, 10, '#2a1416'); r(sx + 4, sy + 2, 2, 2, '#ff6b6b'); r(sx + 6, sy + 4, 6, 2, '#ff6b6b'); r(sx + 12, sy + 2, 2, 2, '#ff6b6b'); r(sx + 4, sy + 6, 2, 2, '#ff6b6b'); r(sx + 12, sy + 6, 2, 2, '#ff6b6b'); led('#ff6b6b'); return;
  }
  r(sx, sy, 18, 10, '#0e1420'); led('#4a9dff');
  switch (f.kind) {
    case 'frontend': {
      r(sx, sy, 18, 2, '#e7609e');
      const hi = tk % 3;
      for (let i = 0; i < 3; i++) { r(sx + 1 + i * 6, sy + 3, 5, 6, i === hi ? '#ffffff' : '#8fb4ff'); r(sx + 2 + i * 6, sy + 4, 3, 1, '#0e1420'); }
      break;
    }
    case 'backend':
      r(sx, sy, 18, 10, '#07140d');
      for (let i = 0; i < 4; i++) {
        const row = i + tk;
        r(sx + 1, sy + 1 + i * 2, 1, 1, '#4ade80');
        if (i < 3 || tk % 2) r(sx + 3, sy + 1 + i * 2, 2 + Math.floor(noise(row) * 10), 1, noise(row + 5) > 0.7 ? '#facc15' : '#86efac');
      }
      break;
    case 'review': {
      const prog = Math.min(4, Math.floor(t / 700) % 6);
      for (let i = 0; i < 4; i++) { r(sx + 1, sy + 1 + i * 2, 2, 2, i < prog ? (i === 2 ? '#ff6b6b' : '#4ade80') : '#3a4258'); r(sx + 4, sy + 1 + i * 2, 9 - (i % 2) * 3, 1, '#7d89a8'); }
      break;
    }
    case 'test': {
      const prog = Math.floor(t / 350) % 10;
      for (let i = 0; i < 8; i++) r(sx + 1 + (i % 4) * 4, sy + 1 + Math.floor(i / 4) * 4, 3, 3, i < prog ? (i === 5 ? '#ff6b6b' : '#4ade80') : '#3a4258');
      r(sx + 1, sy + 9, Math.min(16, prog * 2), 1, '#4a9dff');
      break;
    }
    case 'lead': {
      for (let i = 0; i < 3; i++) r(sx + 1 + i * 6, sy + 1, 5, 1, '#8a6cf0');
      const m = Math.floor(t / 900) % 3;
      for (let i = 0; i < 3; i++) for (let j = 0; j < (i === 0 ? 3 : 2); j++) r(sx + 1 + i * 6, sy + 3 + j * 3, 5, 2, i === m && j === 0 ? '#ffe066' : '#5b6786');
      break;
    }
    default:
      r(sx + 1, sy + 1, 10, 1, '#ffffff');
      for (let i = 1; i < 5; i++) { const row = i + tk; r(sx + 1, sy + 1 + i * 2, 3 + Math.floor(noise(row) * 12), 1, noise(row + 3) > 0.8 ? '#facc15' : '#7d89a8'); }
  }
}

function bubble(c: Ctx, x: number, y: number, w: number, h: number, fill: string, line: string) {
  const r = (xx: number, yy: number, ww: number, hh: number, col: string) => rect(c, xx, yy, ww, hh, col);
  r(x + 1, y, w - 2, 1, line); r(x + 1, y + h - 1, w - 2, 1, line); r(x, y + 1, 1, h - 2, line); r(x + w - 1, y + 1, 1, h - 2, line); r(x + 1, y + 1, w - 2, h - 2, fill);
  r(x + w - 4, y + h, 2, 1, line); r(x + w - 3, y + h + 1, 1, 1, line);
}

/** The thought bubble beside a member's head (or its z's). */
function stateBubble(c: Ctx, P: Palette, st: DeskState, t: number, cx: number, hy: number) {
  const tk = Math.floor(t / 300);
  const bx = cx - 24, bw = 14, bh = 10;
  const r = (x: number, y: number, w: number, h: number, col: string) => rect(c, x, y, w, h, col);
  switch (st) {
    case 'sleeping':
      for (let k = 0; k < 3; k++) {
        const ph = (t / 2400 + k / 3) % 1;
        const x = Math.round(cx + 10 + ph * 8), y = Math.round(hy + 2 - ph * 18);
        c.globalAlpha = Math.min(1, (1 - ph) * 1.5);
        text(c, 'Z', x, y, P.z);
        if (k === 2) text(c, 'Z', x + 3, y - 4, P.z);
        c.globalAlpha = 1;
      }
      return;
    case 'working':
      bubble(c, bx, hy - 8, bw, bh, P.bubble, P.bubbleLine);
      for (let i = 0; i < 3; i++) r(bx + 3 + i * 3, hy - 4 - (tk % 3 === i ? 1 : 0), 2, 2, tk % 3 === i ? '#0a6cff' : '#8a93a8');
      return;
    case 'asking':
      bubble(c, bx, hy - 8, bw, bh, '#4a9dff', P.bubbleLine);
      text(c, '?', bx + 5, hy - 6, '#ffffff');
      return;
    case 'needs': {
      const wob = tk % 2 ? 0 : -1;
      bubble(c, bx, hy - 8 + wob, bw, bh, '#ffb020', P.bubbleLine);
      r(bx + 6, hy - 6 + wob, 2, 4, '#4a2a00'); r(bx + 6, hy - 1 + wob, 2, 1, '#4a2a00');
      return;
    }
    case 'held':
      bubble(c, bx, hy - 8, bw, bh, '#e9edf5', P.bubbleLine);
      r(bx + 4, hy - 6, 2, 6, '#7b86a3'); r(bx + 8, hy - 6, 2, 6, '#7b86a3');
      return;
    case 'done':
      bubble(c, bx, hy - 8, bw, bh, '#4ade80', P.bubbleLine);
      for (const [x, y] of [[3, 4], [4, 5], [5, 6], [6, 5], [7, 4], [8, 3], [9, 2]] as const) r(bx + x, hy - 8 + y, 1, 2, '#0b3d1e');
      return;
    case 'stopped':
      bubble(c, bx, hy - 8, bw, bh, '#ff6b6b', P.bubbleLine);
      r(bx + 4, hy - 6, 6, 6, '#fff');
  }
}

function glow(c: Ctx, x: number, y: number) {
  c.globalAlpha = 0.07;
  for (const [w, h] of [[44, 34], [32, 24], [22, 16]] as const) rect(c, x - w / 2, y - h / 2, w, h, '#7fb4ff');
  c.globalAlpha = 1;
}

// ------------------------------------------------------------------ whiteboard and clock

function whiteboard(c: Ctx, P: Palette, b: Scene['board'], t: number) {
  const x = 88, y = 8, w = 144, h = 44;
  const r = (xx: number, yy: number, ww: number, hh: number, col: string) => rect(c, xx, yy, ww, hh, col);
  const tone = { ink: P.ink, warn: '#b36b00', good: '#2f9e44', bad: '#c43c3c' };
  r(x - 1, y - 1, w + 2, h + 2, P.boardFrame); r(x, y, w, h, P.board); r(x + 10, y + h + 1, w - 20, 2, P.boardFrame);
  const cost = boardText(b.cost);
  text(c, cost, x + w - 5 - textW(cost), y + 4, P.ink);
  text(c, fit(boardText(b.status), w - 14 - textW(cost)), x + 5, y + 4, tone[b.statusTone]);
  const n = Math.max(1, b.steps.length);
  const gap = n > 4 ? 2 : n > 1 ? 5 : 0;
  const bw = Math.min(30, Math.floor((w - 8 - gap * (n - 1)) / n));
  const left = x + Math.floor((w - (bw * n + gap * (n - 1))) / 2);
  const pulse = Math.floor(t / 500) % 2;
  b.steps.forEach((s, i) => {
    const bx = left + i * (bw + gap), by = y + 15;
    const fill = s.status === 'done' ? '#2f9e44' : s.status === 'failed' ? '#c43c3c' : s.status === 'now' ? (pulse ? '#0a6cff' : '#3b8cff') : P.board;
    r(bx, by, bw, 13, fill);
    if (s.status === 'next') { r(bx, by, bw, 1, P.inkSoft); r(bx, by + 12, bw, 1, P.inkSoft); r(bx, by, 1, 13, P.inkSoft); r(bx + bw - 1, by, 1, 13, P.inkSoft); }
    const label = fit(boardText(s.label), bw - 2);
    text(c, label, bx + Math.floor((bw - textW(label)) / 2), by + 4, s.status === 'next' ? P.inkSoft : '#fff');
    if (i < n - 1 && gap >= 4) { r(bx + bw + 1, by + 6, gap - 2, 1, P.inkSoft); r(bx + bw + gap - 2, by + 5, 1, 3, P.inkSoft); }
  });
  text(c, fit(boardText(b.footLeft), 60), x + 5, y + 36, b.footLeft.startsWith('LOOP 0') ? P.inkSoft : '#b36b00');
  const right = fit(boardText(b.footRight), 76);
  text(c, right, x + w - 5 - textW(right), y + 36, tone[b.footTone]);
}

function wallClock(c: Ctx, P: Palette) {
  const cx = 246, cy = 24, d = new Date();
  for (let dy = -9; dy <= 9; dy++) for (let dx = -9; dx <= 9; dx++) {
    const q = dx * dx + dy * dy;
    if (q <= 81) rect(c, cx + dx, cy + dy, 1, 1, q > 64 ? P.frameD : P.board);
  }
  const m = d.getMinutes(), hh = (d.getHours() % 12) + m / 60;
  const hand = (ang: number, len: number) => { for (let i = 0; i <= len; i++) rect(c, Math.round(cx + Math.sin(ang) * i), Math.round(cy - Math.cos(ang) * i), 1, 1, P.ink); };
  hand((hh / 12) * Math.PI * 2, 4); hand((m / 60) * Math.PI * 2, 6); rect(c, cx, cy, 1, 1, '#d03b3b');
}

// ------------------------------------------------------------------ public drawing

/** Draw the whole office for time t (ms; pass 0 to keep everything still). */
export function drawScene(c: Ctx, s: Scene, t: number) {
  const P = s.dark ? NIGHT : DAY;
  c.drawImage(room(s.w, s.h, s.dark), 0, 0);
  whiteboard(c, P, s.board, t);
  wallClock(c, P);
  if (t) {
    const k = Math.floor(t / 400) % 3;
    rect(c, 8 + k, s.h - 46, 1, 2, '#ffffff66'); rect(c, 10 - (k % 2), s.h - 49, 1, 2, '#ffffff44');
  }
  for (const d of s.desks) {
    const { fig, state, cx, by } = d;
    const hy = by - 20;
    figureBack(c, P, fig, state, t, cx, hy, by);
    drawDesk(c, P, cx, by);
    prop(c, fig, cx, by, t, s.dark);
    const mx = cx + 8, my = by - 15;
    if (state === 'working' && P.glow) glow(c, mx + 11, my + 8);
    screen(c, fig, state, t, mx, my);
    rect(c, mx + 9, by + 1, 4, 2, '#222839'); rect(c, mx + 6, by + 3, 10, 1, '#222839');
    figureFront(c, P, fig, state, t, cx, hy, by);
  }
  for (const d of s.desks) {
    const hy = d.by - 20;
    stateBubble(c, P, d.state, t, d.cx, hy);
    if (s.hovered === d.fig.name) {
      const x0 = d.cx - 40, x1 = d.cx + 39, y0 = hy - 10, y1 = d.by + 20;
      for (const [x, y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
        rect(c, sx > 0 ? x : x - 4, y, 5, 1, P.arrow);
        rect(c, x, sy > 0 ? y : y - 4, 1, 5, P.arrow);
      }
    }
    if (s.selected === d.fig.name) {
      const ax = d.cx - 3 + (t ? Math.floor(t / 350) % 2 : 0), ay = hy - 12;
      rect(c, ax, ay, 7, 1, P.arrow); rect(c, ax + 1, ay + 1, 5, 1, P.arrow); rect(c, ax + 2, ay + 2, 3, 1, P.arrow); rect(c, ax + 3, ay + 3, 1, 1, P.arrow);
    }
  }
}

/** A member at its desk, head and shoulders, for the details panel and the legend (44×34). */
export function drawPortrait(c: Ctx, f: Figure, st: DeskState, t: number, dark: boolean) {
  const P = dark ? NIGHT : DAY;
  const cx = 26, hy = 7, by = 27;
  rect(c, 0, 0, 44, 34, P.wall); rect(c, 0, 24, 44, 10, P.wain);
  figureBack(c, P, f, st, t, cx, hy, by);
  rect(c, 0, by, 44, 7, P.deskTop); rect(c, 0, by, 44, 1, shade(P.deskTop, 0.25)); rect(c, 0, by + 4, 44, 3, P.deskFront);
  figureFront(c, P, f, st, t, cx, hy, by);
  stateBubble(c, P, st, t, cx, hy + 1);
}

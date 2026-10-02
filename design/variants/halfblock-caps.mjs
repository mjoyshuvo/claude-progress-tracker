// halfblock-caps: one-row bar with half-block round caps and a braille dot field
// that grows denser and brighter toward a rounded pill thumb.
export const ROWS = 1;

const DEF = 0x01000000;
const LEFT_HALF = 0x258c; // ▌
const RIGHT_HALF = 0x2590; // ▐
const TICK = 0x2502; // │
const SPACE = 0x20;
const LEVELS = 7;

const PALETTES = {
  working: {
    dotLo: 0x4a4472, dotHi: 0xf2eeff,
    bg: [0x27262f, 0x2d2a3e, 0x363152],
    track: 0x242428, tickOff: 0x56565f, tickOn: 0xcfc8ff,
    pill: 0xa99cf5, pillText: 0x17142b,
  },
  failed: {
    dotLo: 0x5c3431, dotHi: 0xffd6cc,
    bg: [0x2a2425, 0x33292a, 0x3f2d2c],
    track: 0x242428, tickOff: 0x56565f, tickOn: 0xffc2b8,
    pill: 0xd4493d, pillText: 0xffffff,
  },
  done: {
    dotLo: 0x2f5238, dotHi: 0xd8ffe2,
    bg: [0x232a25, 0x27322a, 0x2c3b30],
    track: 0x242428, tickOff: 0x56565f, tickOn: 0xbff0cb,
    pill: 0x86d49b, pillText: 0x0f2416,
  },
};

// Order in which braille dots switch on, so dense cells read as a grid.
const DOT_BITS = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80];

function hash(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function lerpColor(a, b, k) {
  const ch = (s) => {
    const x = (a >> s) & 255, y = (b >> s) & 255;
    return Math.round(x + (y - x) * k) << s;
  };
  return ch(16) | ch(8) | ch(0);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function dotGlyph(count, seed) {
  if (count <= 0) return SPACE;
  // shuffle the dot order a little per cell so sparse cells vary
  let bits = 0;
  const start = Math.floor(seed * 8);
  for (let k = 0; k < count && k < 8; k++) bits |= DOT_BITS[(start + k * 3) % 8];
  return 0x2800 + bits;
}

export function barCells({ width, done, total, status, pill, t }) {
  const pal = PALETTES[status] || PALETTES.working;
  const dotColors = [];
  for (let l = 0; l < LEVELS; l++) dotColors.push(lerpColor(pal.dotLo, pal.dotHi, l / (LEVELS - 1)));

  const inner = width - 2; // columns 1..width-2 are the track body
  const col = (f) => 1 + Math.round(clamp01(f) * (inner - 1));
  const frac = total > 0 ? done / total : 0;
  const edge = status === "done" ? width - 2 : col(frac);

  // pill: ▐ + " text " + ▌, centred on the fill edge, clamped inside the bar
  // whole code points only; anything not a safe width-1 BMP char becomes "?"
  let label = [...String(pill ?? "")].map((c) => {
    const cp = c.codePointAt(0);
    return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp > 0xffff || (cp >= 0xe000 && cp <= 0xf8ff) ||
      (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
      ? 0x3f : cp;
  });
  // keep the whole pill on screen: drop the padding first, then trailing chars
  const pad = label.length + 4 <= width;
  if (!pad) label = label.slice(0, Math.max(0, width - 2));
  const text = pad ? [SPACE, ...label, SPACE] : label;
  const pw = text.length + 2;
  let ps = edge - Math.floor(pw / 2);
  if (ps < 0) ps = 0;
  if (ps > width - pw) ps = width - pw;
  const pe = ps + pw - 1;

  const ticks = new Set();
  for (let k = 1; k < total; k++) ticks.add(col(k / total));

  // motion parameters per status
  const calm = status === "failed";
  const settled = status === "done";
  const epochLen = settled ? Infinity : calm ? 1584 : 462;
  const twAmp = settled ? 0 : calm ? 0.07 : 0.16;
  const twSpeed = calm ? 0.0016 : 0.0042;
  const breathe = settled ? 0.07 * Math.sin((2 * Math.PI * t) / 3200) : 0;
  const shimPeriod = 1900;
  const shimPos = ((t % shimPeriod) / shimPeriod) * 1.4 - 0.2;

  const filledBg = (c) => {
    const p = (c - 1) / Math.max(1, edge - 1);
    return pal.bg[p < 0.45 ? 0 : p < 0.82 ? 1 : 2];
  };
  const bgAt = (c) => (c >= 1 && c <= edge ? filledBg(c) : pal.track);

  const cells = new Array(width);
  for (let c = 0; c < width; c++) {
    // pill
    if (c >= ps && c <= pe) {
      // caps: the outer half is a soft blend of track and pill (anti-aliased corner)
      if (c === ps) cells[c] = [RIGHT_HALF, pal.pill, c === 0 ? DEF : lerpColor(bgAt(c), pal.pill, 0.2)];
      else if (c === pe) cells[c] = [LEFT_HALF, pal.pill, c === width - 1 ? DEF : lerpColor(bgAt(c), pal.pill, 0.2)];
      else cells[c] = [text[c - ps - 1], pal.pillText, pal.pill];
      continue;
    }
    // rounded track caps
    if (c === 0) { cells[c] = [RIGHT_HALF, bgAt(1), DEF]; continue; }
    if (c === width - 1) { cells[c] = [LEFT_HALF, bgAt(width - 2), DEF]; continue; }

    const filled = c <= edge;
    if (!filled) {
      cells[c] = ticks.has(c) ? [TICK, pal.tickOff, pal.track] : [SPACE, pal.track, pal.track];
      continue;
    }
    const bg = filledBg(c);
    if (ticks.has(c)) { cells[c] = [TICK, pal.tickOn, bg]; continue; }

    const p = (c - 1) / Math.max(1, edge - 1);
    const h1 = hash(c, 17), h2 = hash(c, 91);
    let I = 0.06 + 0.86 * Math.pow(p, 1.5);
    I += twAmp * (0.4 + 0.6 * p) * Math.sin(t * twSpeed + h1 * 6.283);
    if (!settled && !calm) {
      const d = (p - shimPos) / 0.09;
      I += 0.32 * Math.exp(-d * d);
    }
    I += breathe;
    if (c < ps && ps - c <= 2) I += 0.12; // glow right behind the thumb
    I = clamp01(I);

    const epoch = epochLen === Infinity ? 0 : Math.floor((t + h2 * epochLen) / epochLen);
    const seed = hash(c, epoch * 7 + 3);
    const count = Math.max(0, Math.min(8, Math.floor(I * 8.6 + (seed - 0.5) * 1.6)));
    const level = Math.min(LEVELS - 1, Math.round(I * (LEVELS - 1)));
    cells[c] = [dotGlyph(count, seed), dotColors[level], bg];
  }
  return cells;
}

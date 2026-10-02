// glow-thumb: one-row slider. Rounded track (half-block caps), braille dot field that
// grows denser and brighter toward a near-white rounded thumb that holds the pill text.
export const ROWS = 1;

// One cap glyph for both ends: U+2590 (right half block, East-Asian width N). The right cap is
// drawn as the same glyph with fg/bg swapped, because U+258C (left half block) is ambiguous-width.
const CAP = 0x2590; // ▐
const TICK = 0x2502; // │
const SPACE = 0x20;
const TAU = Math.PI * 2;
const TERM_BG = 0x1a1a1c; // terminal background, used only to blend anti-aliased caps
const AA = 0.45; // share of the cap colour on the outer half of a cap cell (round-end coverage)

const PAL = {
  working: {
    track: 0x2a2a31, fillBg: 0x26252f, glowBg: 0x4b4382,
    dotDim: 0x3e3961, dotBright: 0xf0edff,
    tickOn: 0xd9d3ff, tickOff: 0x55555f,
    thumb: 0xf4f2ff, text: 0x221d38, mark: 0x6c5ce0,
    twinkle: 0.2, density: 0.12, shimmer: 0.5, breathe: 0, twP: 1320, twP2: 990,
  },
  failed: {
    track: 0x2c2a2b, fillBg: 0x2b2324, glowBg: 0x6b2f2a,
    dotDim: 0x56302b, dotBright: 0xffd9d2,
    tickOn: 0xffc3b8, tickOff: 0x58545a,
    thumb: 0xfff1ee, text: 0x33201d, mark: 0xd8432f,
    twinkle: 0.1, density: 0.06, shimmer: 0, breathe: 0, twP: 3960, twP2: 1980,
  },
  done: {
    track: 0x2a2c2b, fillBg: 0x232a26, glowBg: 0x2f5a3b,
    dotDim: 0x2f4a36, dotBright: 0xdff7e4,
    tickOn: 0xc4ecce, tickOff: 0x535a56,
    thumb: 0xeffaf1, text: 0x1b2b20, mark: 0x2f9e52,
    twinkle: 0.04, density: 0, shimmer: 0, breathe: 0.1, twP: 3960, twP2: 3960,
  },
};

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const q = (v, n) => Math.round(clamp(v) * (n - 1)) / (n - 1);
function mix(a, b, k) {
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * k;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}
function hash(a, b, c) {
  let x = Math.imul(a + 0x9e37, 374761393) ^ Math.imul(b + 0x7f4a, 668265263) ^ Math.imul(c + 0x3c6e, 1274126177);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function barCells({ width, done, total, status, pill, t }) {
  const W = width;
  const P = PAL[status] || PAL.working;
  const frac = clamp(done / Math.max(1, total));

  // keep only printable BMP code points from the caller's label (no controls, astral, PUA)
  let text = [...String(pill)].map((ch) => {
    const c = ch.codePointAt(0);
    return c < 0x20 || (c >= 0x7f && c < 0xa0) || c > 0xffff || (c >= 0xe000 && c <= 0xf8ff) ? 0x3f : c;
  });
  if (text.length > W - 4) text = text.slice(0, Math.max(0, W - 4));
  const pw = text.length + 4; // cap + space + text + space + cap
  let p0 = Math.round(frac * W - pw / 2);
  p0 = Math.max(0, Math.min(W - pw, p0));
  const p1 = p0 + pw;

  const ticks = new Set();
  for (let k = 1; k < total; k++) ticks.add(Math.round((k * W) / total));

  const breathe = P.breathe * Math.sin((TAU * t) / 3960);
  const shPeriod = 1980;
  const shHead = ((t % shPeriod) / shPeriod) * (p0 + 8) - 4;

  // fill background at x (shared by fill cells and the thumb's left cap)
  const fillBgAt = (x) => {
    const u = p0 > 1 ? x / (p0 - 1) : 1;
    const g = Math.exp(-(p0 - x - 1) / 3);
    return mix(P.fillBg, P.glowBg, q(0.3 * u + 0.75 * g + breathe * 0.5, 5));
  };
  const trackBgAt = (x) => {
    const d = x - p1;
    if (p0 === 0 && done === 0) return P.track;
    return d < 2 ? mix(P.track, P.glowBg, d === 0 ? 0.4 : 0.2) : P.track;
  };

  const out = new Array(W);
  for (let x = 0; x < W; x++) {
    if (x >= p0 && x < p1) {
      // thumb / pill
      if (x === p0) out[x] = [CAP, P.thumb, mix(x === 0 ? TERM_BG : fillBgAt(x), P.thumb, AA)];
      else if (x === p1 - 1) out[x] = [CAP, mix(x === W - 1 ? TERM_BG : trackBgAt(x + 1), P.thumb, AA), P.thumb];
      else {
        const i = x - p0 - 2;
        const cp = i >= 0 && i < text.length ? text[i] : SPACE;
        const isMark = cp === 0x2715 || cp === 0x2713 || cp === 0x2717 || cp === 0x2714;
        out[x] = [cp, isMark ? P.mark : P.text, P.thumb];
      }
      continue;
    }
    if (x < p0) {
      // filled dot field
      const bg = fillBgAt(x);
      if (x === 0) { out[x] = [CAP, bg, mix(TERM_BG, bg, AA)]; continue; }
      if (ticks.has(x)) { out[x] = [TICK, P.tickOn, bg]; continue; }
      const u = p0 > 1 ? x / (p0 - 1) : 1;
      const d = p0 - x - 1;
      const g = Math.exp(-d / 2.5);
      const density = 0.05 + 0.95 * Math.pow(u, 1.7) + 0.3 * g;
      let bits = 0;
      for (let i = 0; i < 8; i++) {
        const wob = P.density * Math.sin(TAU * (t / P.twP + hash(x, i, 9)));
        if (hash(x, i, 7) < density + wob) bits |= 1 << i;
      }
      const tw = P.twinkle * Math.sin(TAU * (t / P.twP2 + hash(x, 3, 5)));
      const sh = P.shimmer * Math.exp(-(((x - shHead) / 2.2) ** 2));
      const b = 0.2 + 0.5 * Math.pow(u, 1.3) + 0.35 * g + tw + sh + breathe;
      out[x] = [bits ? 0x2800 + bits : SPACE, mix(P.dotDim, P.dotBright, q(b, 7)), bg];
      continue;
    }
    // empty track
    const bg = trackBgAt(x);
    if (x === W - 1) out[x] = [CAP, mix(TERM_BG, P.track, AA), P.track];
    else if (ticks.has(x)) out[x] = [TICK, P.tickOff, bg];
    else out[x] = [SPACE, bg, bg];
  }
  return out;
}

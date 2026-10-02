// two-row-smooth: a 2-row slider drawn on a 4-pixel-tall canvas.
// Each cell is split into 2x2 quadrants (▀ ▄ ▌ ▐ ▖ ▗ ▘ ▝ ▙ ▛ ▜ ▟), so the track and
// the pill are capsules with round ends at half-cell horizontal resolution. Edge
// cells take an averaged fg/bg colour pair, which anti-aliases the curve. Inside
// the filled part, plain cells switch to braille so the dot field has real gaps:
// sparse and dim on the left, dense and bright at the pill, twinkling over time.
export const ROWS = 2;

const DEF = 0x01000000;
const TERM_BG = 0x1a1a1c;
const SPACE = 0x20;
const TICK_TOP = 0x2577; // ╷  row 0: lower half of a line
const TICK_BOT = 0x2575; // ╵  row 1: upper half of a line
const H = 4; // pixel rows (2 per terminal row)
const R = 2; // vertical capsule radius in pixels
const RX_TRACK = 2; // horizontal cap radius in cells (circle: a half-cell pixel is ~square)
const RX_PILL = 2;
const LEVELS = 8; // dot brightness steps
const COV_STEPS = 7; // anti-alias coverage steps

// quadrant mask (TL=1, TR=2, BL=4, BR=8) → glyph drawn in fg
const QUAD = [
  0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b,
  0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588,
];

const PAL = {
  working: {
    empty: 0x29292f, fill: 0x2b2740, dotLo: 0x4a436e, dotHi: 0xe8e3ff,
    tickFill: 0xb3a8f7, tickEmpty: 0x56555f,
    pill: 0xaa9df6, pillMid: 0x988aea, pillLip: 0x7a6bd0, ink: 0x15112b,
    twP: 540, shimmer: true, breathe: 0, twinkle: 0.18,
  },
  failed: {
    empty: 0x29292f, fill: 0x36242a, dotLo: 0x67393b, dotHi: 0xffc4ba,
    tickFill: 0xf59a8c, tickEmpty: 0x56555f,
    pill: 0xd04636, pillMid: 0xbb3d2e, pillLip: 0x972e22, ink: 0xffffff,
    twP: 1600, shimmer: false, breathe: 0, twinkle: 0.08,
  },
  done: {
    empty: 0x29292f, fill: 0x22322a, dotLo: 0x3b5e47, dotHi: 0xd2f6da,
    tickFill: 0x95dca8, tickEmpty: 0x56555f,
    pill: 0x8fd19e, pillMid: 0x7cc08c, pillLip: 0x5c9f6d, ink: 0x0e2414,
    twP: 0, shimmer: false, breathe: 1, twinkle: 0,
  },
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const qcov = (v) => Math.round(clamp01(v) * (COV_STEPS - 1)) / (COV_STEPS - 1);
function mix(a, b, k) {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const ch = (s) => {
    const x = (a >> s) & 255, y = (b >> s) & 255;
    return Math.round(x + (y - x) * k) & 255;
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
function hash(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Coverage of the box [x, x+w] x [y, y+1] by a capsule spanning x0..x1, 0..H
// with elliptical ends (horizontal radius rx, vertical radius R).
function capsuleCov(x, y, w, x0, x1, rx) {
  if (x + w <= x0 || x >= x1) return 0;
  let hit = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + ((sx + 0.5) / 4) * w, py = y + (sy + 0.5) / 4;
      if (px < x0 || px > x1) continue;
      const cx = px < x0 + rx ? x0 + rx : px > x1 - rx ? x1 - rx : px;
      const dx = (px - cx) / rx, dy = (py - R) / R;
      if (dx * dx + dy * dy <= 1) hit++;
    }
  }
  return hit / 16;
}

// Braille dot bits: [dotRow][dotCol]
const BR = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

export function barCells({ width, done, total, status, pill, t }) {
  const W = width;
  const P = PAL[status] || PAL.working;
  const text = Array.from(String(pill ?? "")).slice(0, Math.max(1, W - 4));
  const pillW = text.length + 4; // cap + pad + text + pad + cap
  const frac = clamp01(total > 0 ? done / total : 0);
  const fillEnd = status === "done" ? W : frac * W;
  let pillX = Math.round(fillEnd - pillW / 2);
  if (pillX > W - pillW) pillX = W - pillW;
  if (pillX < 0) pillX = 0;
  const pillEnd = pillX + pillW;
  const textX = pillX + 2;

  const breathe = P.breathe ? Math.round(0.5 + 0.5 * Math.sin((t / 3600) * Math.PI * 2)) : 0;
  const span = Math.max(1, pillX);
  const shimmerPos = P.shimmer ? ((t % 2200) / 2200) * (span + 8) - 4 : -99;

  const ticks = new Set();
  for (let i = 1; i < total; i++) ticks.add(Math.round((i / total) * W));

  const out = new Array(W * 2);
  for (let r = 0; r < 2; r++) {
    for (let x = 0; x < W; x++) {
      const trackCol = x < pillX + pillW / 2 ? P.fill : P.empty;
      const inPill = x >= pillX && x < pillEnd;
      let cell;
      if (r === 0 && x >= textX && x < textX + text.length) {
        cell = [text[x - textX].codePointAt(0), P.ink, P.pill];
      } else {
        // four quadrant samples: TL, TR, BL, BR
        const ct = [], cp = [], pc = [];
        for (let q = 0; q < 4; q++) {
          const qx = x + (q & 1) * 0.5, qy = 2 * r + (q >> 1);
          ct.push(capsuleCov(qx, qy, 0.5, 0, W, RX_TRACK));
          cp.push(inPill ? capsuleCov(qx, qy, 0.5, pillX, pillEnd, RX_PILL) : 0);
          pc.push(qy === 0 || qy === 1 ? P.pill : qy === 2 ? P.pillMid : P.pillLip);
        }
        const solidTrack = ct.every((v) => v === 1) && cp.every((v) => v === 0);
        if (solidTrack && !inPill && ticks.has(x) && x > 2 && x < W - 3) {
          cell = [r === 0 ? TICK_TOP : TICK_BOT, x < pillX ? P.tickFill : P.tickEmpty, trackCol];
        } else if (solidTrack && x < pillX) {
          cell = dotCell(x, r, pillX, span, shimmerPos, breathe, t, P);
        } else {
          cell = shapeCell(ct, cp, pc, trackCol);
        }
      }
      out[r * W + x] = cell;
    }
  }
  return out;
}

// Split the 4 quadrants into inside/outside of the top-most edge, average each
// group's coverage (quantized), and draw the matching quadrant glyph.
function shapeCell(ct, cp, pc, trackCol) {
  const pillEdge = cp.some((v) => v > 0);
  const cov = pillEdge ? cp : ct;
  let mask = 0;
  for (let q = 0; q < 4; q++) if (cov[q] >= 0.5) mask |= 1 << q;
  const group = (inside) => {
    let n = 0, sct = 0, scp = 0, lip = 0;
    for (let q = 0; q < 4; q++) {
      if (((mask >> q) & 1) !== (inside ? 1 : 0)) continue;
      n++; sct += ct[q]; scp += cp[q];
      lip += q >> 1; // bottom quadrants carry the darker pill rows
    }
    if (!n) return null;
    const t = qcov(sct / n), p = qcov(scp / n);
    if (t === 0 && p === 0) return -1; // terminal background
    let c = mix(TERM_BG, trackCol, t);
    if (p > 0) {
      const top = pc[0], bot = pc[2];
      c = mix(c, lip === 0 ? top : lip === n ? bot : mix(top, bot, 0.5), p);
    }
    return c;
  };
  let fg = group(true), bg = group(false);
  // full pill cell on the lower row: show the face/lip bevel with ▀
  if (mask === 15 && pillEdge && pc[0] !== pc[2]) {
    return [0x2580, pc[0], pc[2]];
  }
  if (fg === null) return bg === -1 ? [SPACE, TERM_BG, DEF] : [SPACE, bg, bg];
  if (bg === null || fg === bg) return fg === -1 ? [SPACE, TERM_BG, DEF] : [SPACE, fg, fg];
  if (fg === -1) { // draw the visible part as fg instead
    return [QUAD[15 - mask], bg, DEF];
  }
  return [QUAD[mask], fg, bg === -1 ? DEF : bg];
}

function dotCell(x, r, pillX, span, shimmerPos, breathe, t, P) {
  const u = clamp01((x + 1) / span); // 0 at the left cap, 1 next to the pill
  const near = pillX - x; // 1 = cell touching the pill
  const sh = shimmerPos > -50 ? Math.max(0, 1 - Math.abs(x - shimmerPos) / 3.5) : 0;
  let density = 0.1 + 0.8 * Math.pow(u, 1.6) + 0.35 * sh;
  if (near <= 2) density = Math.max(density, near === 1 ? 0.97 : 0.88);

  let bits = 0;
  // row 0 uses dot rows 1..3, row 1 uses dot rows 0..2 → one dot of margin top and bottom
  for (let dr = r === 0 ? 1 : 0; dr < (r === 0 ? 4 : 3); dr++) {
    for (let dc = 0; dc < 2; dc++) {
      const id = (r * 4 + dr) * 2 + dc;
      let v = hash(x, id, 1);
      if (P.twP) {
        // most dots keep their seat; a few re-roll each staggered epoch → twinkle
        const epoch = Math.floor((t + hash(x, id, 7) * P.twP) / P.twP);
        if (hash(x, id, 1000 + epoch) < P.twinkle) v = hash(x, id, 2000 + epoch);
      }
      if (v < density) bits |= BR[dr][dc];
    }
  }
  if (!bits) return [SPACE, P.dotLo, P.fill];

  let lvl = Math.round(1 + 4.6 * Math.pow(u, 1.3));
  if (near <= 2) lvl = near === 1 ? 7 : 6;
  if (P.twP) {
    const e = Math.floor((t + hash(x, r, 9) * P.twP * 2) / (P.twP * 2));
    if (hash(x, r, 3000 + e) < P.twinkle * 0.9) lvl += 1;
  }
  lvl += Math.round(2.2 * sh) + breathe;
  if (lvl > LEVELS - 1) lvl = LEVELS - 1;
  return [0x2800 + bits, mix(P.dotLo, P.dotHi, lvl / (LEVELS - 1)), P.fill];
}

// The desktop bar: one SVG, like the Ultracode effort slider. A rounded track,
// a grid of square dots that grows denser and brighter toward a rounded pill
// riding the fill edge, and tick marks between tasks. With `isMoving`, SMIL
// makes the dots twinkle and a soft shine sweep toward the pill; otherwise the
// same picture holds still.

export const SVG_HEIGHT = 24;

const DOT = 3;
const PITCH = 4;
const DOT_ROWS = 4;
const MAX_COLUMNS = 150;
const PILL_FONT = 11;
const PILL_CHAR = 6.7;

const PALETTE = {
  working: { track: "#2a2838", dot: "#b9adff", tick: "#e6e1ff", pill: "#a99cf5", ink: "#1d1a2e" },
  failed: { track: "#33242a", dot: "#ff9a8a", tick: "#ffe1db", pill: "#e5604f", ink: "#ffffff" },
  waiting: { track: "#332b1f", dot: "#ffd27a", tick: "#fff0d1", pill: "#f0b34a", ink: "#2a1c05" },
  done: { track: "#22302a", dot: "#9fe0ad", tick: "#e3f7e7", pill: "#7cc68a", ink: "#14261a" },
};
const EMPTY_TICK = "#55545e";
const BAND_DARK = "#212121";

export function barSvg({ width, done, total, status, pill, isMoving }) {
  const p = PALETTE[status];
  const h = SVG_HEIGHT;
  const r = h / 2;
  const pillW = Math.min(width, Math.ceil(pill.length * PILL_CHAR) + 22);
  const fillX = Math.round((done / total) * width);
  const pillX = Math.max(0, Math.min(width - pillW, fillX - pillW / 2));
  const fillEnd = Math.max(pillX + r, fillX);

  const parts = [
    // A moving bar is drawn in a sandboxed frame whose page is white; paint the
    // corners outside the rounded track in the band's colour when the app is dark.
    isMoving ? `<style>.bd{fill:none}@media (prefers-color-scheme:dark){.bd{fill:${BAND_DARK}}}</style><rect class="bd" width="${width}" height="${h}"/>` : "",
    `<defs><clipPath id="track"><rect width="${width}" height="${h}" rx="${r}"/></clipPath>`,
    `<clipPath id="fill"><rect width="${fillEnd}" height="${h}"/></clipPath>`,
    `<linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>`,
    `<stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`,
    `<rect width="${width}" height="${h}" rx="${r}" fill="${p.track}"/>`,
    `<g clip-path="url(#track)"><g clip-path="url(#fill)">`,
    dots(p, fillEnd, h, status, isMoving),
  ];
  if (isMoving && status === "working" && fillEnd > 40) {
    const band = Math.max(40, fillEnd * 0.25);
    parts.push(
      `<rect x="${-band}" width="${band}" height="${h}" fill="url(#shine)">`,
      `<animate attributeName="x" from="${-band}" to="${fillEnd}" dur="1.1s" repeatCount="indefinite"/></rect>`,
    );
  }
  parts.push(`</g>`);
  for (let k = 1; k < total; k++) {
    const x = Math.round((k / total) * width);
    if (x > pillX - 2 && x < pillX + pillW + 2) continue;
    const isFilled = x < fillX;
    parts.push(
      `<rect x="${x - 0.5}" y="${h * 0.25}" width="1" height="${h * 0.5}" rx=".5" fill="${isFilled ? p.tick : EMPTY_TICK}" fill-opacity="${isFilled ? 0.9 : 0.8}"/>`,
    );
  }
  parts.push(`</g>`);
  parts.push(
    `<rect x="${pillX}" y="1" width="${pillW}" height="${h - 2}" rx="${(h - 2) / 2}" fill="${p.pill}"/>`,
    `<text x="${pillX + pillW / 2}" y="${h / 2}" fill="${p.ink}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="${PILL_FONT}" font-weight="600" text-anchor="middle" dominant-baseline="central">${escape(pill)}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${parts.join("")}</svg>`;
}

// Square dots on a grid: sparse and faint at the left, dense and bright at the
// fill edge. Which dots show and how they twinkle come from a hash of their
// place, so the same bar always draws the same field.
function dots(p, fillEnd, h, status, isMoving) {
  const top = (h - (DOT_ROWS - 1) * PITCH - DOT) / 2;
  // At most MAX_COLUMNS dot columns, so a wide bar stays under the SVG size cap.
  const step = Math.max(PITCH, fillEnd / MAX_COLUMNS);
  const out = [];
  for (let x = PITCH; x < fillEnd - 2; x += step) {
    const ramp = Math.pow(x / Math.max(1, fillEnd), 1.6);
    for (let row = 0; row < DOT_ROWS; row++) {
      const seed = hash(x * 31 + row * 7);
      if (seed > 0.3 + ramp * 0.7) continue;
      const opacity = Math.min(1, (0.3 + ramp * 0.8) * (0.75 + 0.35 * hash(seed * 997)));
      const y = top + row * PITCH;
      const rect = `<rect x="${Math.round(x)}" y="${y}" width="${DOT}" height="${DOT}" rx=".4" fill="${p.dot}" fill-opacity="${opacity.toFixed(2)}"`;
      if (!isMoving || status === "done") {
        out.push(`${rect}/>`);
        continue;
      }
      const slow = status === "failed" ? 1.8 : 1;
      const dur = ((0.35 + hash(seed * 13) * 0.55) * slow).toFixed(2);
      const begin = (-hash(seed * 29) * Number(dur)).toFixed(2);
      const dim = (opacity * 0.15).toFixed(2);
      const twinkle = `<animate attributeName="fill-opacity" values="${opacity.toFixed(2)};${dim};${opacity.toFixed(2)}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`;
      // Glitter: some dots, more of them near the pill, flash white for a blink.
      const isSparkle = status === "working" && hash(seed * 53) < 0.08 + ramp * 0.22;
      const flashDur = (0.9 + hash(seed * 71) * 1.3).toFixed(2);
      const flashBegin = (-hash(seed * 89) * Number(flashDur)).toFixed(2);
      const sparkle = isSparkle
        ? `<animate attributeName="fill" values="${p.dot};#ffffff;${p.dot};${p.dot}" keyTimes="0;.06;.16;1" dur="${flashDur}s" begin="${flashBegin}s" repeatCount="indefinite"/>`
        : "";
      out.push(`${rect}>${twinkle}${sparkle}</rect>`);
    }
  }
  return out.join("");
}

function hash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

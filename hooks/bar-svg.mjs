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

// Each state's colours. The track is the dot colour at low opacity, so it tints whatever
// band sits behind it (the app's dark or light look, or a custom theme) instead of
// painting a fixed dark slab over it.
const PALETTE = {
  working: { dot: "#b9adff", tick: "#e6e1ff", pill: "#a99cf5", ink: "#1d1a2e" },
  failed: { dot: "#ff9a8a", tick: "#ffe1db", pill: "#ef6f5c", ink: "#2a0a05" },
  waiting: { dot: "#ffd27a", tick: "#fff0d1", pill: "#f0b34a", ink: "#2a1c05" },
  done: { dot: "#9fe0ad", tick: "#e3f7e7", pill: "#7cc68a", ink: "#14261a" },
};
// The same states on a light band: deeper dots and ticks, white text on the stronger pills.
const PALETTE_LIGHT = {
  working: { dot: "#6b5bd6", tick: "#3f3196", pill: "#7a6ae0", ink: "#ffffff" },
  failed: { dot: "#d0503c", tick: "#8f2617", pill: "#d9553f", ink: "#ffffff" },
  waiting: { dot: "#b67c0f", tick: "#6e4906", pill: "#e3a234", ink: "#2a1c05" },
  done: { dot: "#3d9752", tick: "#1f5c33", pill: "#45a35b", ink: "#ffffff" },
};

// Colours go on classes, not attributes, so one picture follows the app's light or dark
// mode: the image or sandboxed frame takes the embedder's colour scheme. Dark is the base.
// Empty ticks are white or black at low opacity, so they too sit on any band.
function schemeStyle(status) {
  const rules = (p, empty, trackOpacity) =>
    `.tr{fill:${p.dot};fill-opacity:${trackOpacity}}.dt{fill:${p.dot}}.tk{fill:${p.tick}}` +
    `.et{fill:${empty};fill-opacity:.3}.pl{fill:${p.pill}}.ik{fill:${p.ink}}`;
  return [
    `<style>:root{color-scheme:light dark}`,
    rules(PALETTE[status], "#fff", 0.16),
    `@media (prefers-color-scheme:light){${rules(PALETTE_LIGHT[status], "#000", 0.14)}}</style>`,
  ].join("");
}

export function barSvg({ width, done, total, status, pill, isMoving, skipped = [] }) {
  const h = SVG_HEIGHT;
  const r = h / 2;
  const pillW = Math.min(width, Math.ceil(pill.length * PILL_CHAR) + 22);
  const fillX = Math.round((done / total) * width);
  const pillX = Math.max(0, Math.min(width - pillW, fillX - pillW / 2));
  const fillEnd = Math.max(pillX + r, fillX);

  // A skipped task's slice dims its dots through a mask, so nothing paints over the band.
  const veils = skipped.map((i) => {
    const x0 = Math.round((i / total) * width);
    const x1 = Math.round(((i + 1) / total) * width);
    return `<rect class="skip" x="${x0}" width="${x1 - x0}" height="${h}" fill="#000" fill-opacity=".65"/>`;
  });
  const parts = [
    // A moving bar is drawn in a sandboxed frame; the matching color-scheme keeps the
    // browser from painting an opaque backdrop behind it, so the band shows through.
    schemeStyle(status),
    `<defs><clipPath id="track"><rect width="${width}" height="${h}" rx="${r}"/></clipPath>`,
    `<clipPath id="fill"><rect width="${fillEnd}" height="${h}"/></clipPath>`,
    veils.length ? `<mask id="veil" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${h}"><rect width="${width}" height="${h}" fill="#fff"/>${veils.join("")}</mask>` : "",
    `<linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>`,
    `<stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`,
    `<rect class="tr" width="${width}" height="${h}" rx="${r}"/>`,
    `<g clip-path="url(#track)"><g clip-path="url(#fill)"${veils.length ? ` mask="url(#veil)"` : ""}>`,
    dots(fillEnd, h, status, isMoving),
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
      `<rect class="${isFilled ? "tk" : "et"}" x="${x - 0.5}" y="${h * 0.25}" width="1" height="${h * 0.5}" rx=".5"${isFilled ? ` fill-opacity=".9"` : ""}/>`,
    );
  }
  parts.push(`</g>`);
  parts.push(
    `<rect class="pl" x="${pillX}" y="1" width="${pillW}" height="${h - 2}" rx="${(h - 2) / 2}"/>`,
    `<text class="ik" x="${pillX + pillW / 2}" y="${h / 2}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="${PILL_FONT}" font-weight="600" text-anchor="middle" dominant-baseline="central">${escape(pill)}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${parts.join("")}</svg>`;
}

// Square dots on a grid: sparse and faint at the left, dense and bright at the
// fill edge. Which dots show and how they twinkle come from a hash of their
// place, so the same bar always draws the same field.
//
// A moving bar animates groups, not dots: each dot joins one of TWINKLE_GROUPS
// groups and each group fades as one, and the glitter is a white copy of some
// dots in SPARKLE_GROUPS groups. About a dozen animations in all, where one per
// dot came to several hundred and made the frame stutter. A finished bar glitters
// hardest: more dots, more groups, so the whole fill keeps catching the light.
const TWINKLE_GROUPS = 8;
const SPARKLE_GROUPS = { working: 5, done: 8 };

function dots(fillEnd, h, status, isMoving) {
  const top = (h - (DOT_ROWS - 1) * PITCH - DOT) / 2;
  // At most MAX_COLUMNS dot columns, so a wide bar stays under the SVG size cap.
  const step = Math.max(PITCH, fillEnd / MAX_COLUMNS);
  const twinkles = Array.from({ length: TWINKLE_GROUPS }, () => []);
  const sparkleGroups = SPARKLE_GROUPS[status] ?? 0;
  const sparkles = Array.from({ length: sparkleGroups }, () => []);
  for (let x = PITCH; x < fillEnd - 2; x += step) {
    const ramp = Math.pow(x / Math.max(1, fillEnd), 1.6);
    for (let row = 0; row < DOT_ROWS; row++) {
      const seed = hash(x * 31 + row * 7);
      if (seed > 0.3 + ramp * 0.7) continue;
      const opacity = Math.min(1, (0.3 + ramp * 0.8) * (0.75 + 0.35 * hash(seed * 997)));
      const at = `x="${Math.round(x)}" y="${top + row * PITCH}" width="${DOT}" height="${DOT}" rx=".4"`;
      twinkles[Math.floor(hash(seed * 13) * TWINKLE_GROUPS)].push(`<rect ${at} fill-opacity="${opacity.toFixed(2)}"/>`);
      // Glitter: some dots, more of them near the pill, flash white for a blink.
      const glitter = status === "done" ? 0.22 + ramp * 0.3 : 0.08 + ramp * 0.22;
      if (isMoving && sparkleGroups > 0 && hash(seed * 53) < glitter) {
        sparkles[Math.floor(hash(seed * 71) * sparkleGroups)].push(`<rect ${at}/>`);
      }
    }
  }
  if (!isMoving) return `<g class="dt">${twinkles.flat().join("")}</g>`;
  const slow = status === "failed" ? 1.8 : status === "done" ? 1.5 : 1;
  const out = twinkles.map((group, i) => {
    if (group.length === 0) return "";
    const dur = ((0.35 + (i / TWINKLE_GROUPS) * 0.55) * slow).toFixed(2);
    const begin = (-hash(i * 29 + 1) * Number(dur)).toFixed(2);
    const fade = `<animate attributeName="opacity" values="1;.15;1" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`;
    return `<g class="dt">${fade}${group.join("")}</g>`;
  });
  sparkles.forEach((group, i) => {
    if (group.length === 0) return;
    const dur = (0.9 + (i / sparkleGroups) * 1.3).toFixed(2);
    const begin = (-hash(i * 89 + 3) * Number(dur)).toFixed(2);
    const flash = `<animate attributeName="opacity" values="0;1;0;0" keyTimes="0;.06;.16;1" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`;
    out.push(`<g fill="#ffffff" opacity="0">${flash}${group.join("")}</g>`);
  });
  return out.join("");
}

function hash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A status pill on its own, for the Progress pane's header: a rounded capsule in the
// state's colour. Drawn as a still image; returns its source and size.
export function pillSvg({ status, text }) {
  const h = 22;
  const w = Math.ceil(text.length * 6.9) + 22;
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    schemeStyle(status),
    `<rect class="pl" width="${w}" height="${h}" rx="${h / 2}"/>`,
    `<text class="ik" x="${w / 2}" y="${h / 2}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" font-weight="700" text-anchor="middle" dominant-baseline="central">${escape(text)}</text>`,
    `</svg>`,
  ].join("");
  return { source, width: w, height: h };
}

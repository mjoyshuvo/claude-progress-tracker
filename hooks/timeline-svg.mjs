// The gutter of a finished bar's task list: one small SVG per row that together draw a
// connected timeline. Steps that ran at the same time leave the main line on a branch
// (fork, run, join); a sub-agent's row carries a robot head instead of a dot.
//
// SMIL moves it: on opening, the line draws itself down and the dots pop in row by row;
// then a light pulse runs down the line on a loop, splitting into branches, and each dot
// rings as it passes. Every row times its part by its index, so the rows act as one.

export const ROW_HEIGHT = 22;
export const GUTTER_WIDTH = 30;

const MAIN_X = 7;
const BRANCH_X = 21;
const LINE = "#5d5c68";
const DONE = "#7cc68a";
const AGENT = "#a99cf5";
const BAND_DARK = "#212121";

const STAGGER = 0.07; // seconds between rows as the line draws in
const DRAW = 0.18;
const SLOT = 0.28; // seconds the pulse spends crossing one row
const PAUSE = 1.6; // seconds between pulses

// pos: "main" | "start" | "middle" | "end" | "only" (the last four are rows on the branch).
export function timelineSvg({ pos, isFirst, isLast, isAgent, isSkipped, index = 0, count = 1 }) {
  const h = ROW_HEIGHT;
  const mid = h / 2;
  const isBranch = pos !== "main";
  const x = isBranch ? BRANCH_X : MAIN_X;
  const drawAt = index * STAGGER;
  const pulse = pulseTiming(index, count);
  const parts = [
    // Drawn in a sandboxed frame; without a matching color-scheme the browser paints an
    // opaque white backdrop. Dark, the corners take the band's colour.
    `<style>:root{color-scheme:light dark}.bd{fill:none}@media (prefers-color-scheme:dark){.bd{fill:${BAND_DARK}}}</style>`,
    `<rect class="bd" width="${GUTTER_WIDTH}" height="${h}"/>`,
  ];
  const draw = `<animate attributeName="stroke-dashoffset" from="1" to="0" begin="${drawAt}s" dur="${DRAW}s" fill="freeze"/>`;
  const stroke = (shape) =>
    parts.push(`${shape} fill="none" stroke="${LINE}" stroke-width="1.5" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1">${draw}</path>`);
  const line = (x1, y1, x2, y2) => stroke(`<path d="M${x1} ${y1} L${x2} ${y2}"`);
  const curve = (d) => stroke(`<path d="${d}"`);

  // The main line runs through every row; it starts at the first dot and ends at the last.
  const top = isFirst && !isBranch ? mid : 0;
  const bottom = isLast && !isBranch ? mid : h;
  line(MAIN_X, top, MAIN_X, bottom);
  parts.push(runner(MAIN_X, top, bottom, pulse));

  if (pos === "start" || pos === "only") curve(`M${MAIN_X} 1 Q${BRANCH_X} 1 ${BRANCH_X} ${mid}`);
  if (pos === "middle" || pos === "end") line(BRANCH_X, 0, BRANCH_X, mid);
  if (pos === "start" || pos === "middle") line(BRANCH_X, mid, BRANCH_X, h);
  if (pos === "end" || pos === "only") curve(`M${BRANCH_X} ${mid} Q${BRANCH_X} ${h - 1} ${MAIN_X} ${h - 1}`);
  if (isBranch) {
    const branchTop = pos === "start" || pos === "only" ? mid : 0;
    const branchBottom = pos === "end" || pos === "only" ? mid : h;
    parts.push(runner(BRANCH_X, branchTop, branchBottom, pulse));
  }

  const popAt = drawAt + DRAW * 0.6;
  if (isAgent) parts.push(robot(x, mid, popAt, index));
  else parts.push(dot(x, mid, isSkipped, popAt, pulse));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GUTTER_WIDTH}" height="${h}" viewBox="0 0 ${GUTTER_WIDTH} ${h}">${parts.join("")}</svg>`;
}

// One pulse cycle covers every row in turn, then rests. Rows share the cycle length and
// start, and each moves its pulse only inside its own slot of it.
function pulseTiming(index, count) {
  const cycle = count * SLOT + PAUSE;
  const begin = count * STAGGER + DRAW + 0.3;
  const at = (seconds) => Math.min(1, Math.max(0, seconds / cycle)).toFixed(4);
  return { cycle, begin, from: at(index * SLOT), middle: at((index + 0.5) * SLOT), to: at((index + 1) * SLOT), ring: at((index + 0.5) * SLOT + 0.5) };
}

// A bright bead with a soft halo that crosses the row in its slot and waits off-canvas otherwise.
function runner(x, y1, y2, p) {
  const out = -6;
  const end = ROW_HEIGHT + 6;
  const values = `${out};${out};${y1};${y2};${end};${end}`;
  const keyTimes = `0;${p.from};${p.from};${p.to};${p.to};1`;
  const move = `<animate attributeName="cy" values="${values}" keyTimes="${keyTimes}" dur="${p.cycle}s" begin="${p.begin}s" repeatCount="indefinite"/>`;
  return [
    `<circle cx="${x}" cy="${out}" r="4" fill="${DONE}" fill-opacity=".35">${move}</circle>`,
    `<circle cx="${x}" cy="${out}" r="1.8" fill="#ffffff">${move}</circle>`,
  ].join("");
}

function dot(x, y, isSkipped, popAt, p) {
  const pop = `<animate attributeName="r" values="0;5;4" keyTimes="0;.7;1" begin="${popAt}s" dur=".25s" fill="freeze"/>`;
  if (isSkipped) {
    return `<circle cx="${x}" cy="${y}" r="0" fill="${BAND_DARK}" stroke="${DONE}" stroke-opacity=".6" stroke-width="1.5">${pop}</circle>`;
  }
  const ringTimes = `0;${p.middle};${p.middle};${p.ring};1`;
  const ring = [
    `<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="${DONE}" stroke-width="1.2" stroke-opacity="0">`,
    `<animate attributeName="r" values="4;4;4;9;9" keyTimes="${ringTimes}" dur="${p.cycle}s" begin="${p.begin}s" repeatCount="indefinite"/>`,
    `<animate attributeName="stroke-opacity" values="0;0;.8;0;0" keyTimes="${ringTimes}" dur="${p.cycle}s" begin="${p.begin}s" repeatCount="indefinite"/>`,
    `</circle>`,
  ].join("");
  return `${ring}<circle cx="${x}" cy="${y}" r="0" fill="${DONE}">${pop}</circle>`;
}

// A robot head: antenna with a blinking light, rounded face, two eyes that blink.
function robot(x, y, popAt, index) {
  const blinkAt = (index * 0.37) % 2.8;
  const eye = (ex) =>
    `<circle cx="${ex}" cy="${y}" r="1.4" fill="#1d1a2e"><animate attributeName="r" values="1.4;1.4;.25;1.4" keyTimes="0;.9;.95;1" dur="2.8s" begin="${blinkAt}s" repeatCount="indefinite"/></circle>`;
  return [
    `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${popAt}s" dur=".25s" fill="freeze"/>`,
    `<line x1="${x}" y1="${y - 8}" x2="${x}" y2="${y - 5}" stroke="${AGENT}" stroke-width="1.5"/>`,
    `<circle cx="${x}" cy="${y - 8.5}" r="1.4" fill="${AGENT}"><animate attributeName="fill-opacity" values="1;.25;1" dur="1.2s" repeatCount="indefinite"/></circle>`,
    `<rect x="${x - 6}" y="${y - 5}" width="12" height="10" rx="3" fill="${AGENT}"/>`,
    eye(x - 2.5),
    eye(x + 2.5),
    `</g>`,
  ].join("");
}

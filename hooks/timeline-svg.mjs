// The gutter of a bar's task list: one small SVG per row that together draw one
// connected timeline. Each row draws its own part of the line, edge to edge, so the rows
// join up. Steps that ran at the same time take two lanes: the first stays on the main
// line and the line forks from its dot; the rest run on the branch and the last one
// joins back. A sub-agent's row hangs on the branch with a robot head instead of a dot.
//
// SMIL moves it once: on opening, the line draws itself down and the dots pop in row by
// row, each with one ring. Then it holds still. Each row is its own frame with its own
// clock, so a pulse looping across rows drifted out of step and kept every frame busy.

export const ROW_HEIGHT = 22;
export const GUTTER_WIDTH = 30;

const MAIN_X = 7;
const BRANCH_X = 21;
const LINE = "#3b5e47";
const PENDING = "#5d5c68";
const ACTIVE = "#a99cf5";
const FAILED = "#ef6f5c";
const DONE = "#7cc68a";
const AGENT = "#a99cf5";
const BAND_DARK = "#212121";

const STAGGER = 0.07; // seconds between rows as the line draws in
const DRAW = 0.18;

// pos: "main" | "fork" (both on the main line; the branch leaves a fork row's dot) |
// "start" | "middle" | "end" | "only" (rows on the branch).
export function timelineSvg({ pos, isFirst, isLast, isAgent, isSkipped, status = "completed", failures = 0, index = 0 }) {
  const h = ROW_HEIGHT;
  const mid = h / 2;
  const isBranch = pos !== "main" && pos !== "fork";
  const x = isBranch ? BRANCH_X : MAIN_X;
  const drawAt = index * STAGGER;
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

  if (pos === "fork") curve(`M${MAIN_X} ${mid} Q${BRANCH_X} ${mid} ${BRANCH_X} ${h}`);
  if (pos === "start" || pos === "only") curve(`M${MAIN_X} 1 Q${BRANCH_X} 1 ${BRANCH_X} ${mid}`);
  if (pos === "middle" || pos === "end") line(BRANCH_X, 0, BRANCH_X, mid);
  if (pos === "start" || pos === "middle") line(BRANCH_X, mid, BRANCH_X, h);
  if (pos === "end" || pos === "only") curve(`M${BRANCH_X} ${mid} Q${BRANCH_X} ${h - 1} ${MAIN_X} ${h - 1}`);

  const popAt = drawAt + DRAW * 0.6;
  if (isAgent) parts.push(robot(x, mid, popAt, index));
  else parts.push(dot(x, mid, { isSkipped, status, failures }, popAt));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GUTTER_WIDTH}" height="${h}" viewBox="0 0 ${GUTTER_WIDTH} ${h}">${parts.join("")}</svg>`;
}

// Done: a green dot that rings once. A step that failed on the way keeps a coral ring;
// the running step is purple; pending and skipped steps are hollow.
function dot(x, y, { isSkipped, status, failures }, popAt) {
  const pop = `<animate attributeName="r" values="0;5;4" keyTimes="0;.7;1" begin="${popAt}s" dur=".25s" fill="freeze"/>`;
  if (isSkipped || status === "pending") {
    const edge = isSkipped ? DONE : PENDING;
    return `<circle cx="${x}" cy="${y}" r="0" fill="${BAND_DARK}" stroke="${edge}" stroke-opacity=".7" stroke-width="1.5">${pop}</circle>`;
  }
  const fill = status === "in_progress" ? ACTIVE : DONE;
  const scar = failures > 0 ? `<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${FAILED}" stroke-width="1.5" stroke-opacity=".75"/>` : "";
  const ring = [
    `<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="${fill}" stroke-width="1.2" stroke-opacity="0">`,
    `<animate attributeName="r" values="4;9" begin="${popAt}s" dur=".6s" fill="freeze"/>`,
    `<animate attributeName="stroke-opacity" values=".8;0" begin="${popAt}s" dur=".6s" fill="freeze"/>`,
    `</circle>`,
  ].join("");
  return `${scar}${ring}<circle cx="${x}" cy="${y}" r="0" fill="${fill}">${pop}</circle>`;
}

// A robot head: antenna with a blinking light, rounded face, two eyes that blink.
function robot(x, y, popAt, index) {
  const blinkAt = (index * 0.37) % 2.8;
  const eye = (ex) =>
    `<circle cx="${ex}" cy="${y}" r="1.4" fill="#1d1a2e"><animate attributeName="r" values="1.4;1.4;.25;1.4" keyTimes="0;.9;.95;1" dur="2.8s" begin="${blinkAt}s" repeatCount="3"/></circle>`;
  return [
    `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${popAt}s" dur=".25s" fill="freeze"/>`,
    `<line x1="${x}" y1="${y - 8}" x2="${x}" y2="${y - 5}" stroke="${AGENT}" stroke-width="1.5"/>`,
    `<circle cx="${x}" cy="${y - 8.5}" r="1.4" fill="${AGENT}"><animate attributeName="fill-opacity" values="1;.25;1" dur="1.2s" repeatCount="5"/></circle>`,
    `<rect x="${x - 6}" y="${y - 5}" width="12" height="10" rx="3" fill="${AGENT}"/>`,
    eye(x - 2.5),
    eye(x + 2.5),
    `</g>`,
  ].join("");
}

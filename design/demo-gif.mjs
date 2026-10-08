// Draws docs/demo.gif: a mock of the desktop Code tab with the mod's own bar and timeline
// SVGs, the Progress pane beside the chat, and toasts. Headless Chrome screenshots each
// frame with the SVG animation clock set to the frame's time; design/frames-to-gif.py
// joins the frames.
//
//   node design/demo-gif.mjs
//
// Needs Google Chrome in /Applications and Python 3 with Pillow.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { barSvg } from "../hooks/bar-svg.mjs";
import { timelineSvg, ROW_HEIGHT, GUTTER_WIDTH } from "../hooks/timeline-svg.mjs";

const WIDTH = 1200;
const HEIGHT = 600;
const FRAME_MS = 100;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// A port of its own per run, so a Chrome still closing from the last run does not clash.
const PORT = 9300 + Math.floor(Math.random() * 600);
const OUT = fileURLToPath(new URL("../docs/demo.gif", import.meta.url));

const COLOR = { working: "#a99cf5", failed: "#e5604f", done: "#7cc68a", waiting: "#f0b34a" };
const INK = { working: "#1d1a2e", failed: "#ffffff", done: "#14261a", waiting: "#2a1c05" };

// ---- the story: one scene per state the mod shows ----

const TASKS = ["Find bug", "Fix refresh", "Test", "Docs", "Ship"];

const SCENES = [
  {
    seconds: 1.8,
    chat: ["Read src/auth.ts", "Grep refreshToken", "Read src/session.ts"],
    band: { label: "Working", status: "working", pill: "Working · 3 steps", isCounter: true, stats: "14s work · 61.2k in · 0.9k out" },
    pane: {
      header: { label: "Working", status: "working", pill: "Working · 3 steps" },
      tiles: [["PROGRESS", "3 steps", "total unknown"], ["THIS TASK", "2s"], ["WORKED", "14s"], ["WAITED ON YOU", "none"], ["TOKENS IN", "61.2k", "88% cached"], ["TOKENS OUT", "0.9k"], ["MODEL CALLS", "3"], ["CONTEXT", "22%"]],
      tab: "blocked",
      counts: { blocked: 0, found: 0 },
      body: "empty-blocked",
    },
  },
  {
    seconds: 2.2,
    chat: ["Read src/auth.ts", "Grep refreshToken", "Read src/session.ts", "progress_tracker  Fix login, 5 tasks", "Edit src/session.ts"],
    band: { label: "Fix login", status: "working", pill: "Fix refresh 2/5", done: 1, total: 5, stats: "20% · 1m 05s work · 182k in · 3.1k out" },
    pane: {
      header: { label: "Fix login", status: "working", pill: "Fix refresh 2/5" },
      tiles: [["PROGRESS", "20%", "1 of 5"], ["THIS TASK", "27s"], ["WORKED", "1m 05s"], ["WAITED ON YOU", "none"], ["TOKENS IN", "182k", "91% cached"], ["TOKENS OUT", "3.1k"], ["MODEL CALLS", "9"], ["CONTEXT", "31%"]],
      tab: "found",
      counts: { blocked: 0, found: 1 },
      body: "found-one",
    },
  },
  {
    seconds: 2.6,
    chat: ["Edit src/session.ts", "Bash npm test", "Edit src/session.ts", "Bash npm test"],
    band: { label: "Fix login", status: "failed", pill: "✕ Test 3/5 ×2", done: 2, total: 5, stats: "40% · 1m 48s work · 264k in · 4.4k out" },
    pane: {
      header: { label: "Fix login", status: "failed", pill: "✕ Test 3/5 ×2" },
      tiles: [["PROGRESS", "40%", "2 of 5"], ["THIS TASK", "31s"], ["WORKED", "1m 48s"], ["WAITED ON YOU", "none"], ["TOKENS IN", "264k", "92% cached"], ["TOKENS OUT", "4.4k"], ["MODEL CALLS", "14"], ["CONTEXT", "35%"]],
      tab: "found",
      counts: { blocked: 0, found: 2 },
      body: "found-open",
    },
  },
  {
    seconds: 2.4,
    chat: ["Bash npm test", "Edit README.md", "Bash npm publish --tag next"],
    band: { label: "Fix login", status: "waiting", pill: "Waiting for you", done: 4, total: 5, stats: "80% · 2m 31s work · 4s wait · 351k in · 5.9k out" },
    pane: {
      header: { label: "Fix login", status: "waiting", pill: "Waiting for you" },
      tiles: [["PROGRESS", "80%", "4 of 5"], ["THIS TASK", "9s"], ["WORKED", "2m 31s"], ["WAITED ON YOU", "4s"], ["TOKENS IN", "351k", "93% cached"], ["TOKENS OUT", "5.9k"], ["MODEL CALLS", "19"], ["CONTEXT", "39%"]],
      tab: "blocked",
      counts: { blocked: 1, found: 2 },
      body: "blocked-open",
    },
    toast: "progress-tracker: Waiting for you · Fix login",
  },
  {
    seconds: 3.4,
    chat: ["Bash npm publish --tag next", "Done. The refresh token now rotates, and the fix is published."],
    band: { label: "Fix login", status: "done", pill: "✓ Done 5/5", done: 5, total: 5, stats: "100% · 2m 40s work · 12s wait · 411k in · 6.8k out", timeline: true },
    pane: {
      header: { label: "Fix login", status: "done", pill: "✓ Done 5/5" },
      tiles: [["PROGRESS", "100%", "5 of 5"], ["WORKED", "2m 40s"], ["WAITED ON YOU", "12s"], ["TOKENS IN", "411k", "93% cached"], ["TOKENS OUT", "6.8k"], ["MODEL CALLS", "21"], ["CONTEXT", "41%"]],
      tab: "blocked",
      counts: { blocked: 0, found: 2 },
      body: "blocked-answered",
    },
    toast: "progress-tracker: ✓ Fix login done in 2m 52s · 2 retries",
  },
];

const TIMELINE = [
  ["Find bug", "32.1s"],
  ["Fix refresh", "48.4s"],
  ["Test", "56.0s", "· failed ×2"],
  ["Docs", "16.8s"],
  ["Ship", "18.7s"],
];

// ---- drawing ----

let svgCount = 0;

// Inline SVGs share one document, so each one's ids get a suffix of their own.
function own(svg) {
  const n = svgCount++;
  return svg.replace(/id="([^"]+)"/g, `id="$1_${n}"`).replace(/url\(#([^)]+)\)/g, `url(#$1_${n})`);
}

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function bandOf(b) {
  const done = b.isCounter ? 1 : b.done;
  const total = b.isCounter ? 1 : b.total;
  const bar = own(barSvg({ width: 230, done, total, status: b.status, pill: b.pill, isMoving: true }));
  const dot = b.status === "failed" ? "!" : "●";
  const head = `<div class="row"><span class="dot" style="color:${COLOR[b.status]}">${dot}</span><span class="label">${esc(b.label)}</span><span class="grow"></span>${bar}<span class="stats">${esc(b.stats)}</span><span class="btn">${b.timeline ? "▼" : "▶"} Tasks</span><span class="btn dim">☰</span><span class="btn dim">✕</span></div>`;
  if (!b.timeline) return head;
  const rows = TIMELINE.map(([subject, time, note], i) => {
    const gutter = own(timelineSvg({ pos: "main", isFirst: i === 0, isLast: i === TIMELINE.length - 1, index: i, count: TIMELINE.length }));
    return `<div class="trow">${gutter}<span>${esc(subject)}</span>${note ? `<span class="dim">${esc(note)}</span>` : ""}<span class="grow"></span><span class="dim">${time}</span></div>`;
  }).join("");
  return head + `<div class="timeline">${rows}</div>`;
}

function tilesOf(tiles) {
  return `<div class="tiles">${tiles
    .map(([label, value, note]) => `<div class="tile"><div class="tlabel">${label}</div><div><b>${esc(value)}</b>${note ? ` <span class="dim">${esc(note)}</span>` : ""}</div></div>`)
    .join("")}</div>`;
}

function card(color, mark, title, time, detail, details) {
  const rows = details
    ? `<div class="details">${details
        .map(([label, value]) => (label === "│" ? `<div class="out">│ ${esc(value)}</div>` : `<div class="drow"><span class="dlabel">${label}</span><span>${esc(value)}</span></div>`))
        .join("")}</div>`
    : "";
  return `<div class="card" style="border-color:${color}"><div class="crow"><span style="color:${color}"><b>${mark}</b></span><span class="link"><b>${details ? "▾" : "▸"} ${esc(title)}</b></span><span class="grow"></span><span class="dim">${time}</span></div><div class="dim">&nbsp; ${esc(detail)}</div>${rows}</div>`;
}

const BODIES = {
  "empty-blocked": `<div class="empty"><div><span style="color:${COLOR.done}"><b>✓</b></span> <b>Nothing waits on you.</b></div><div class="dim">&nbsp; Permission prompts, questions and plan approvals show up here.</div></div>`,
  "found-one": card(COLOR.working, "◆", "Refresh token is never rotated", "14:29", "Finding · Find bug"),
  "found-open":
    card(COLOR.failed, "✕", "FAIL refresh keeps the session", "14:31", "Check failed · Test", [
      ["Check", "npm test"],
      ["│", "FAIL src/auth.test.ts > refresh keeps the session"],
      ["│", "AssertionError: expected 401 to be 200"],
      ["Task", "Test"],
      ["At", "14:31"],
    ]) + card(COLOR.working, "◆", "Refresh token is never rotated", "14:29", "Finding · Find bug"),
  "blocked-open": `<div class="section">WAITING NOW</div>${card(COLOR.waiting, "●", "Allow npm publish --tag next", "14:33", "Permission · Ship · waiting 4s")}`,
  "blocked-answered": `<div class="section">ANSWERED</div><div class="line"><span style="color:${COLOR.done}">✓</span> <span class="link">▾ Allow npm publish --tag next</span> <span class="dim">· waited 12s · Ship</span><span class="grow"></span><span class="dim">14:33</span></div><div class="details" style="margin-left:22px">${[
    ["Tool", "Bash"],
    ["Asked to", "npm publish --tag next"],
    ["Result", "It ran"],
    ["Task", "Ship"],
    ["Waited", "12s"],
  ]
    .map(([label, value]) => `<div class="drow"><span class="dlabel">${label}</span><span>${esc(value)}</span></div>`)
    .join("")}</div>`,
};

function paneOf(p) {
  const h = p.header;
  const dot = h.status === "failed" ? "!" : "●";
  const tab = (id, n, label) =>
    `<span class="tab ${p.tab === id ? "on" : ""}">${label}&nbsp; ${p.counts[id]} <span class="key">${n}</span></span>`;
  return `<div class="phead"><span style="color:${COLOR[h.status]}">${dot}</span> <b>${esc(h.label)}</b><span class="grow"></span><span class="pill" style="background:${COLOR[h.status]};color:${INK[h.status]}">${esc(h.pill)}</span></div>${tilesOf(p.tiles)}<div class="tabs">${tab("blocked", 1, "Blocked on me")}${tab("found", 2, "Found")}</div>${BODIES[p.body]}`;
}

function chatOf(lines) {
  return lines
    .map((line) => (line.startsWith("Done.") ? `<div class="reply">${esc(line)}</div>` : `<div class="tool"><span class="dim">●</span> ${esc(line)}</div>`))
    .join("");
}

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#1a1a1a;color:#e6e6e6;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
#app{display:flex;height:100%}
#chat{flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:18px 18px 16px}
#pane{width:430px;border-left:1px solid #2c2c2c;background:#1c1c1c;padding:14px 16px;position:relative}
.ask{align-self:flex-end;background:#2a2a2a;border-radius:12px;padding:8px 12px;margin-bottom:12px}
.tool{color:#bdbdbd;margin:4px 0 4px 4px}.reply{margin:10px 0 4px 4px}
#band{background:#232323;border-radius:12px;padding:10px 12px;margin:14px 0 10px}
.row{display:flex;align-items:center;gap:8px}.label{font-size:14px;white-space:nowrap}.stats{color:#9a9a9a;font-size:12px;white-space:nowrap}
.btn{font-size:12px;white-space:nowrap}.dim{color:#8f8f8f}.grow{flex:1}.dot{font-size:12px}
.timeline{margin-top:4px}.trow{display:flex;align-items:center;gap:8px;height:${ROW_HEIGHT}px}.trow svg{width:${GUTTER_WIDTH}px;flex-shrink:0}
#prompt{border:1px solid #3a3a3a;border-radius:12px;padding:11px 14px;color:#777}
.ptitle{display:flex;color:#bdbdbd;margin-bottom:14px}.ptitle .grow{flex:1}
.phead{display:flex;align-items:center;gap:6px;font-size:14px}.pill{border-radius:3px;padding:1px 6px;font-weight:600;font-size:13px}
.tiles{display:flex;flex-wrap:wrap;gap:8px 22px;margin:12px 0 14px}.tlabel{color:#8f8f8f;font-size:10.5px;letter-spacing:.04em;margin-bottom:1px}.tile b{font-size:14px}
.tabs{display:flex;gap:8px;margin-bottom:12px}.tab{border-radius:7px;padding:5px 9px;background:#2b2b2b;color:#bdbdbd}.tab.on{background:#ececec;color:#141414}
.key{display:inline-block;border:1px solid #555;border-radius:4px;padding:0 4px;font-size:10px;margin-left:4px;color:#999}.tab.on .key{border-color:#bbb;color:#555}
.section{color:#8f8f8f;font-weight:600;font-size:11px;letter-spacing:.04em;margin:4px 0 6px}
.card{border:1px solid;border-radius:9px;padding:8px 10px;margin-bottom:8px}.crow{display:flex;gap:6px}
.link{text-decoration:underline;text-decoration-color:#666}
.details{margin-top:6px}.drow{display:flex;gap:8px;margin:2px 0}.dlabel{width:72px;color:#8f8f8f;flex-shrink:0}.out{font:12px ui-monospace,Menlo,monospace;color:#e0b0a8;margin:2px 0 2px 2px}
.line{display:flex;gap:6px;align-items:center}
.empty{margin-top:6px}
#toast{position:absolute;right:16px;bottom:16px;width:398px;background:#202020;border:1px solid #3a3a3a;border-radius:12px;padding:12px 14px;display:none;gap:10px;color:#e6e6e6}
`;

function pageOf() {
  const scenes = SCENES.map((s) => ({
    chat: `<div class="ask">Fix the login refresh bug and ship it</div>${chatOf(s.chat)}`,
    band: bandOf(s.band),
    pane: paneOf(s.pane),
    toast: s.toast ?? null,
  }));
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><div id="app"><div id="chat"><div id="log"></div><div id="band"></div><div id="prompt">Type / for commands</div></div><div id="pane"><div class="ptitle"><span>Progress</span><span class="grow"></span><span>⤢ &nbsp;✕</span></div><div id="pbody"></div><div id="toast"></div></div></div>
<script>
const SCENES = ${JSON.stringify(scenes)};
let shown = -1;
function show(i, t) {
  if (i !== shown) {
    shown = i;
    const s = SCENES[i];
    document.getElementById("log").innerHTML = s.chat;
    document.getElementById("band").innerHTML = s.band;
    document.getElementById("pbody").innerHTML = s.pane;
    const toast = document.getElementById("toast");
    toast.style.display = s.toast ? "flex" : "none";
    toast.innerHTML = s.toast ? '<span>ⓘ</span><span style="flex:1;white-space:nowrap">' + s.toast + '</span><span>✕</span>' : "";
  }
  for (const svg of document.querySelectorAll("svg")) { svg.pauseAnimations(); svg.setCurrentTime(t); }
}
</script>`;
}

// ---- capture ----

async function capture(htmlPath, framesDir) {
  const profile = mkdtempSync(join(tmpdir(), "chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await new Promise((r) => setTimeout(r, 200));
      target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((list) => list.find((t) => t.type === "page")).catch(() => null);
    }
    if (!target) throw new Error("Chrome did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const waiting = new Map();
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send("Page.enable");
    await send("Page.navigate", { url: `file://${htmlPath}` });
    await new Promise((r) => setTimeout(r, 1500));
    const durations = [];
    let n = 0;
    for (const [i, scene] of SCENES.entries()) {
      for (let t = 0; t < scene.seconds - 1e-6; t += FRAME_MS / 1000) {
        await send("Runtime.evaluate", { expression: `show(${i}, ${t.toFixed(3)})` });
        const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } });
        writeFileSync(join(framesDir, `${String(n++).padStart(4, "0")}.png`), Buffer.from(data, "base64"));
        durations.push(FRAME_MS);
      }
    }
    ws.close();
    return durations;
  } finally {
    chrome.kill();
    // Chrome may still be writing its profile as it exits.
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const work = mkdtempSync(join(tmpdir(), "demo-gif-"));
const framesDir = join(work, "frames");
mkdirSync(framesDir);
const htmlPath = join(work, "demo.html");
writeFileSync(htmlPath, pageOf());
const durations = await capture(htmlPath, framesDir);
writeFileSync(join(framesDir, "durations.json"), JSON.stringify(durations));
execFileSync("python3", [fileURLToPath(new URL("./frames-to-gif.py", import.meta.url)), framesDir, OUT], { stdio: "inherit" });
console.log(`wrote ${OUT} from ${durations.length} frames (work files in ${work})`);

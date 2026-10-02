import { pathToFileURL, fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
const mod = await import(pathToFileURL(join(here, "variants", name + ".mjs")).href);
const SCENARIOS = [
  { label: "Start at zero, tick marks", done: 2, total: 5, status: "working", pill: "Tasks 3/5", pct: "40%" },
  { label: "Release pipeline", done: 3, total: 4, status: "failed", pill: "✕ Verify 4/4", pct: "75%" },
  { label: "Ship the docs", done: 5, total: 5, status: "done", pill: "✓ Done 5/5", pct: "100%" },
];
const WIDTH = Number(process.argv[3] ?? 64), FRAMES = 60, STEP = 66;
const hex = (c) => (c & 0x01000000 ? null : "#" + c.toString(16).padStart(6, "0"));
const problems = new Set();
const frames = [];
for (let f = 0; f < FRAMES; f++) {
  frames.push(SCENARIOS.map((s) => {
    const cells = mod.barCells({ width: WIDTH, done: s.done, total: s.total, status: s.status, pill: s.pill, t: f * STEP });
    if (cells.length !== WIDTH * mod.ROWS) problems.add(`cell count ${cells.length} != ${WIDTH * mod.ROWS}`);
    const pairs = new Set(cells.map(([, fg, bg]) => fg + ":" + bg));
    if (pairs.size > 300) problems.add(`many color pairs in one bar: ${pairs.size}`);
    const rows = [];
    for (let r = 0; r < mod.ROWS; r++) {
      rows.push(cells.slice(r * WIDTH, (r + 1) * WIDTH).map(([cp, fg, bg]) => {
        if (cp > 0xffff || (cp >= 0xe000 && cp <= 0xf8ff) || cp < 0x20) problems.add(`bad code point U+${cp.toString(16)}`);
        return [String.fromCodePoint(cp), hex(fg), hex(bg)];
      }));
    }
    return rows;
  }));
}
const html = `<!doctype html><meta charset="utf-8"><title>${name}</title>
<body style="background:#1a1a1c;color:#ddd;font:16px/1 Menlo,'SF Mono',monospace;padding:20px;margin:0">
<div style="color:#888;margin-bottom:12px">variant: ${name} — width ${WIDTH} — ${[...problems].join("; ") || "no contract problems"}</div>
<pre id=out style="margin:0"></pre>
<script>
const S=${JSON.stringify(SCENARIOS)},F=${JSON.stringify(frames)};
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
let i=0;function draw(){const html=F[i].map((rows,k)=>rows.map((row,r)=>{
 const head=r===0?(S[k].status==='failed'?'<span style="color:#e5604f;font-weight:700">! </span>':'<span style="color:#a99cf5">● </span>')+esc(S[k].label.padEnd(28).slice(0,28))+'  ':' '.repeat(32);
 const bar=row.map(([ch,fg,bg])=>'<span style="'+(fg?'color:'+fg+';':'')+(bg?'background:'+bg+';':'')+'">'+esc(ch)+'</span>').join('');
 const tail=r===0?'<span style="opacity:.55">  '+S[k].pct.padStart(4)+'  ✕</span>':'';
 return head+bar+tail;}).join('\\n')).join('\\n\\n');
 document.getElementById('out').innerHTML=html;i=(i+1)%F.length;}
draw();setInterval(draw,${STEP});
</script>`;
writeFileSync(join(here, `preview-${name}.html`), html);
console.log(`wrote design/preview-${name}.html`, problems.size ? [...problems] : "ok");

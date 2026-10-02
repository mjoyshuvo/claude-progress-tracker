import { writeFileSync } from "node:fs";
import { barSvg } from "../hooks/bar-svg.mjs";
const rows = [
  { label: "Start at zero, tick marks", done: 2, total: 5, status: "working", pill: "Tasks 3/5", pct: 40 },
  { label: "Release pipeline", done: 3, total: 4, status: "failed", pill: "✕ Verify 4/4", pct: 75 },
  { label: "Ship the docs", done: 5, total: 5, status: "done", pill: "✓ Done 5/5", pct: 100 },
];
const html = `<!doctype html><meta charset="utf-8"><body style="background:#1f1f1f;color:#ddd;font:13px -apple-system,sans-serif;padding:24px">` +
  rows.map((r) => `<div style="display:flex;align-items:center;gap:10px;margin:10px 0"><span style="width:200px">${r.status === "failed" ? "!" : "●"} ${r.label}</span>${barSvg({ width: 520, ...r, isMoving: true })}<span style="opacity:.55">${r.pct}%  ✕</span></div>`).join("");
writeFileSync(new URL("./preview-desktop.html", import.meta.url), html);
console.log("wrote design/preview-desktop.html", html.length, "chars");

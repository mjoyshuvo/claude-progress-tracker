import { register } from "../hooks/progress-tracker.mjs";
import assert from "node:assert/strict";

const hooks = [];
register((ev, m, fn) => hooks.push({ ev, m: fn ? m : {}, fn: fn ?? m }));
const store = {};
let id = 1, fail = false;
const timers = [];
const blits = [];
const presses = {};
const el = (type) => (props) => ({ type, props });
const $ = {
  state: { get: async (k) => ({ value: store[k.key] }), set: async (k, v) => { store[k.key] = v; } },
  clock: { every: (ms, fn) => { const t = { ms, fn, live: true, cancel() { this.live = false; } }; timers.push(t); return t; } },
  ui: {
    resolve: () => ({ Box: el("Box"), Text: el("Text"), Raster: el("Raster"),
      Button: (p) => { presses[p.key] = p.onPress; return { type: "Button", props: p }; } }),
    blit: async (a) => { blits.push(a); return {}; },
  },
};
const core = (e) => e.tool === "TaskCreate" ? { result: { task: { id: String(id++) } } }
  : e.tool === "Bash" && fail ? { result: {}, isError: true } : { result: {} };
async function call(e) {
  let r = core(e);
  for (const h of hooks.filter((h) => h.ev === "tool.call" && h.m.tool === e.tool)) r = await h.fn($, e, async () => r);
  return r;
}
const decode = (b64) => {
  const u = new Uint32Array(new Uint8Array(Buffer.from(b64, "base64")).buffer);
  let s = ""; for (let i = 0; i < u.length; i += 3) s += String.fromCodePoint(u[i]); return s;
};
const find = (n, type, out = []) => {
  if (!n || typeof n === "string") return out;
  if (n.type === type) out.push(n);
  [n.props?.children ?? []].flat().forEach((c) => find(c, type, out));
  return out;
};
const render = async (props = {}) => {
  const h = hooks.find((h) => h.ev === "ui.render");
  return h.fn($, { surface: "terminal", requestId: "band", props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 110, ...props } }, async () => null);
};
const live = () => timers.filter((t) => t.live);

assert.equal(await render(), null, "nothing drawn without tasks");
assert.equal(live().length, 0, "no timer without tasks");

for (const s of ["Build", "Lint", "Test", "Package", "Ship"]) await call({ tool: "TaskCreate", subject: s });
await call({ tool: "TaskUpdate", taskId: "1", status: "completed" });
await call({ tool: "TaskUpdate", taskId: "2", status: "completed" });
await call({ tool: "TaskUpdate", taskId: "3", status: "in_progress" });

let tree = await render();
let [raster] = find(tree, "Raster");
assert.equal(raster.props.rows, 2);
assert.equal(decode(raster.props.cells).length, raster.props.columns * 2);
assert.match(decode(raster.props.cells), /Test 3\/5/);
assert.equal(live().length, 1, "timer runs while working");

live()[0].fn(); live()[0].fn();
await new Promise((r) => setTimeout(r, 5));
assert.equal(blits.length, 2);
assert.equal(blits[0].key, raster.props.key);
assert.equal(blits[0].requestId, "band");
assert.notEqual(blits[0].cells, blits[1].cells, "frames differ (animation)");

await render();
assert.equal(live().length, 1, "re-render keeps one timer");

fail = true; await call({ tool: "Bash", command: "npm test" });
tree = await render();
assert.match(decode(find(tree, "Raster")[0].props.cells), /✕ Test 3\/5/);
assert.equal(find(tree, "Text")[0].props.children, "! ");

await render({ isWorking: false });
assert.equal(live().length, 0, "timer stops when idle");
await render({ isWorking: true });
await render({ hasSurvey: true });
assert.equal(live().length, 0, "timer stops under a survey");

tree = await render({ bodyColumns: 40 });
assert.equal(find(tree, "Raster").length, 0, "narrow: pill only");

for (const t of ["3", "4", "5"]) await call({ tool: "TaskUpdate", taskId: t, status: "completed" });
tree = await render();
assert.match(decode(find(tree, "Raster")[0].props.cells), /Done 5\/5/);
assert.equal(live().length, 0, "done bars do not animate");

presses[Object.keys(presses).at(-1)]();
await new Promise((r) => setTimeout(r, 5));
assert.equal(await render(), null, "dismissed");
console.log("all integration checks passed");

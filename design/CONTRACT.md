# Bar variant contract

A variant is one ES module in `design/variants/<name>.mjs`. Plain JS, no imports, no Node APIs
(it will run inside the Claude Code mod sandbox). It exports:

```js
export const ROWS = 1;          // terminal rows the bar uses (1 or 2)
export function barCells({ width, done, total, status, pill, t }) {
  // width:  terminal columns for the bar (30..120)
  // done:   finished tasks, total: all tasks (total >= 1)
  // status: "working" | "failed" | "done"
  // pill:   label text for the thumb, e.g. "Tasks 3/5", "✕ Verify 1/2", "✓ Done 5/5"
  // t:      animation time in ms (0, 66, 132, ...). Same t => same output (deterministic, no Math.random).
  // return: array of width*ROWS cells, row-major, each [codePoint, fg, bg]
  //         colors are 0xRRGGBB ints, or 0x01000000 for the terminal default background.
}
```

Raster rules (from the Claude Code mod API):
- each code point must be ONE printable, width-1 BMP character (blocks, box drawing, braille OK).
  Avoid East-Asian-ambiguous-width glyphs and Private Use Area (Nerd Font) glyphs.
- at most ~1024 distinct (fg,bg) pairs on screen at once — keep palettes small (quantize).
- the terminal background is dark (#1a1a1c).

Run the preview: `node design/harness.mjs <name>` → writes `design/preview-<name>.html`
(animated, three scenarios: working 2/5, failed 3/4, done 5/5).

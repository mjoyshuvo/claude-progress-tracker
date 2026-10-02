# progress-tracker

A Claude Code mod that draws a live progress bar for your task list and plan in the band above the prompt.

## Install

Run these two commands inside Claude Code (terminal or desktop app):

```
/plugin marketplace add mjoyshuvo/progress-tracker
/plugin install progress-tracker@mjoyshuvo-mods
```

Start a new session, then type `/progress-tracker-demo` to check that it works. Mods are an early-access Claude Code feature: they need Claude Code 2.1.287 or later, with function hooks switched on for your account.

- One row per task list. The label is the approved plan's title, or the first task.
- The bar is a rounded capsule, 2 terminal rows tall (drawn with quadrant blocks as a 4-pixel-high canvas). Its dot field is sparse on the left and denser toward the pill, and it twinkles and shimmers while Claude works. It holds still when idle or done.
- The pill shows the current task and step (`Write tests 3/5`). The percent counts finished tasks; the time since the list started sits next to it.
- A failing check (test, build, lint, typecheck) while a task is in progress turns the row red (`! … ✕ Verify 1/2`). Other commands that exit 1, like `grep` with no match, do not. The row turns back when the same check passes (other flags are fine), or when a task changes status.
- A finished list turns green and hides itself after a minute. New tasks after it start a new row. `✕` hides a row. Unfinished rows older than 12 hours go away at the next session start.
- Only the main conversation counts. Subagent task calls are skipped.

The bar design lives in `hooks/bar.mjs` (`barCells`), drawn through a `Raster` and repainted with `$.ui.blit` about 15 times a second.

Data comes from the `TaskCreate`, `TaskUpdate`, `TodoWrite`, `ExitPlanMode` and `Bash` tool calls.

## Desktop app

In the desktop Code tab the bar is an SVG: a rounded track, a square dot grid that grows brighter toward the pill, fast twinkle, white sparkles and a shine that sweeps toward the pill while Claude works (SMIL, no timer). The desktop has no `TaskCreate` / `TodoWrite`, so the mod registers its own `progress_tracker` tool and tells Claude how to use it.

The desktop app loads the mod from `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Plan mode

In plan mode a "Planning" bar shows three steps: Explore, Write plan, Approval. It moves to "Write plan" when Claude writes the plan, and turns amber ("Waiting for approval") while Claude asks you to approve. Approved, the bar takes the plan's title and its numbered (or bulleted) steps, and Claude's first task list replaces those steps on the same bar. Rejected, it goes back to "Write plan".

Colours: purple = working, red = a step failed, amber = waiting for you, green = done.

## Demo

Type `/progress-tracker-demo` in a session with the mod loaded. A sample 5-step job fills one task at a time, fails at "Test" (red), recovers, finishes green, and clears itself after about 15 seconds. The demo bar animates even while Claude is idle.

## Run

```bash
claude --plugin-dir ./progress-tracker
```

```bash
claude plugin validate ./progress-tracker
```

```bash
claude plugin test ./progress-tracker
```

Mods need Claude Code 2.1.287 or later, and function hooks must be switched on for your account.

## Develop without Claude Code

```bash
node dev/simulate.mjs
```

```bash
node design/harness.mjs two-row-smooth
```

The first runs the mod against a stand-in for Claude Code. The second writes an animated preview to `design/preview-two-row-smooth.html`. `design/variants/` holds the other bar designs; copy one over `hooks/bar.mjs` to switch.

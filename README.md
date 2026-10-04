# progress-tracker

progress-tracker is a Claude Code mod that draws a live progress bar for Claude's work in the band above the prompt. It works in the terminal and in the desktop Code tab, and it tracks task lists, plans, and plain tool calls.

## Install the mod

Mods are an early-access Claude Code feature. You need Claude Code 2.1.287 or later, with function hooks switched on for your account.

1. In Claude Code, add the marketplace:

	```
	/plugin marketplace add mjoyshuvo/claude-progress-tracker
	```

2. Install the mod:

	```
	/plugin install progress-tracker@mjoyshuvo-mods
	```

3. Start a new session.
4. Type `/progress-tracker-demo`. A sample bar plays above the prompt for about 25 seconds.

Only one mod can draw in the band above the prompt. If you also use `plan-progress`, turn it off:

```bash
claude plugin disable plan-progress@zycck-mods
```

The desktop app loads mods from the `CLAUDE_CODE_PLUGIN_DIRS` variable in the `env` block of `~/.claude/settings.json`. To load a local copy there, set that variable to the mod's folder, for example `~/.claude/progress-tracker`.

## Watch the demo

`/progress-tracker-demo` plays a 7-step job on its own row. The demo shows every feature in order:

1. Three file reads run in parallel.
2. A sub-agent runs, and the pill shows `· 1 agent`.
3. The "Test" step fails, and the row turns red.
4. The step recovers, and the bar finishes green.
5. The task timeline opens on its own. The row clears about 12 seconds later.

The demo bar moves even while Claude is idle.

## What the bar shows

Each task list gets one row, and the mod shows at most 3 rows. A row has a label, the bar, a percent, the time since the list started, and buttons.

- The label is the approved plan's title, the title Claude gave the list, or the first task.
- The pill on the bar names the current task and its step, for example `Write tests 3/5`.
- The percent counts finished tasks.
- After two tasks finish, the row also shows the time left, for example `~3m left`. The mod takes the mean time of the finished tasks and multiplies it by the number of tasks left.
- `✕` hides the row. On a finished row, `▶ Tasks` opens the task timeline.

The colour of a row tells you its state:

| Colour | State | Pill text |
| --- | --- | --- |
| Purple | Claude is working | `Build 2/5` |
| Red | A check failed in the current step | `✕ Verify 1/2` |
| Amber | Claude waits for you | `Waiting for you` or `Waiting for approval` |
| Green | Every task is done | `✓ Done 5/5` |

The bar moves while Claude works, on purple and red rows. It holds still when Claude is idle, waiting, or done. In the terminal, the mod draws the bar with block characters and repaints it about 15 times a second. In the desktop app, the bar is an SVG that animates itself.

A finished row hides itself after a minute. New tasks after a finished list start a new row. At the next session start, the mod drops rows that are finished, hidden, or older than 12 hours.

## Where the tasks come from

The mod reads only the main conversation. It ignores task calls that sub-agents make.

### Claude's task tools

In the terminal, Claude's `TaskCreate`, `TaskUpdate`, and `TodoWrite` calls fill the bar. When you approve a plan in plan mode, the plan gets its own row, with the plan's title and its numbered or bulleted steps. Claude's first task list then replaces those steps.

### The `progress_tracker` tool

The desktop app has no `TaskCreate` or `TodoWrite`, so the mod adds its own tool, `mcp__progress-tracker__progress_tracker`. The mod also adds a short rule to the system prompt that tells Claude to use the tool for work of more than about 3 edits or commands.

| Field | Type | Effect |
| --- | --- | --- |
| `title` | string | Names the row. Use it only with `tasks`. |
| `tasks` | string list | Creates a row with these tasks. The first task starts. |
| `next` | boolean | Finishes the current task and starts the next one. |
| `active` | string | Makes the task with this name the current one. Part of the name is enough. |
| `add` | string list | Adds tasks found during the work to the end of the list. |
| `skip` | boolean | Closes the current task as not needed. Its part of the bar is drawn dimmer. |
| `failed` | string | Turns the row red with this reason. |
| `fixed` | boolean | Clears the red state. |

The tool replies with the state of the row, for example `2/5, running, active "Write tests", next "Docs"`. If Claude names a task that does not exist, the tool refuses the call and lists the task names.

If Claude makes 12 tool calls without moving the bar, the mod adds one note to a tool result that tells Claude to update it. Only Claude sees the note.

### The Working bar

Outside plan mode, the mod starts a row named "Working" on the 3rd tool call of a turn, if no other row is still open. Each tool call becomes a finished step, named after the call's description or file, for example "Read config.ts". When the turn ends, the open step becomes "Write reply", and the row turns green. If Claude sends its own list with `progress_tracker`, that list replaces the automatic steps.

### Plan mode

In plan mode, a row named "Planning" appears. Each tool call becomes a finished step, until Claude sends its own planning steps with `progress_tracker`. The row turns amber while Claude asks you to approve the plan. Whether you approve or reject the plan, the Planning row turns green. If you leave plan mode without an answer to a plan, the mod removes the Planning row.

### Waits, failures, and sub-agents

- When Claude asks you a question with `AskUserQuestion`, the row turns amber until you answer.
- When a check command fails during a task, the row turns red and shows the first error line of the output. A check is a test, build, lint, or typecheck command. The command's first words decide: `pytest`, `tsc`, `ruff`, `make`, `npm test`, `cargo build`, `go test`, and `.venv/bin/pytest` all count. Commands such as `grep`, `go run`, `npm run dev`, and `test -f` do not count, even when they exit with code 1.
- The row turns back from red when the same check passes, with any flags, or when a task changes state.
- While sub-agents run, the pill shows how many, for example `Search 1/3 · 2 agents`.

## Read the task timeline

In the desktop app, press `▶ Tasks` on a finished row to open its timeline. A line connects the steps, and each row shows how long its step took.

- For an automatic step, the time is how long the tool call ran. For one of Claude's own tasks, the time runs from the task's start to its finish.
- Steps whose run times overlap leave the line on a branch and join it again. The first of them says `· 3 in parallel`.
- A sub-agent row has a robot icon and the agent type, for example `· Explore agent`. A sub-agent that starts during one of Claude's own tasks appears under that task, on a branch.
- A sub-agent that runs in the background shows `background` instead of a time.

The timeline moves. When it opens, the line draws itself from the top, and the dots appear one by one. Then a light pulse runs down the line on a loop and splits into the branches. Each dot gives a ring as the pulse passes, and the robot heads blink.

## Known limits

- Only steps that overlap in time count as parallel. Claude Code runs file reads at the same time, but it often runs shell commands one after another. So Bash calls that Claude sends together can still appear in a straight line.
- Each timeline row is a small sandboxed frame. A long task list runs many animated frames at once.
- The timeline colours are tuned for the dark theme.

## Develop the mod

Run these commands from the mod's folder.

To start Claude Code with your local copy of the mod:

```bash
claude --plugin-dir .
```

To check the manifest and the hooks the way Claude Code loads them:

```bash
claude plugin validate .
```

To run the tests in `tests/progress-tracker.test.ts`:

```bash
claude plugin test .
```

To run the mod against a stand-in for Claude Code, without Claude Code:

```bash
node dev/simulate.mjs
```

To write an animated preview of a terminal bar design to `design/preview-two-row-smooth.html`:

```bash
node design/harness.mjs two-row-smooth
```

`design/variants/` holds three terminal bar designs: `glow-thumb.mjs`, `halfblock-caps.mjs`, and `two-row-smooth.mjs`. To switch designs, copy one over `hooks/bar.mjs`. `design/CONTRACT.md` describes what a design module must export.

## Project layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/plugin.json` | The plugin manifest. |
| `.claude-plugin/marketplace.json` | The `mjoyshuvo-mods` marketplace entry. |
| `hooks/progress-tracker.mjs` | The hooks: task tracking, plan mode, the Working bar, the `progress_tracker` tool, and drawing. |
| `hooks/bar.mjs` | The terminal bar (`barCells`). |
| `hooks/bar-svg.mjs` | The desktop bar (`barSvg`). |
| `hooks/timeline-svg.mjs` | The task timeline rows (`timelineSvg`). |
| `types/index.d.ts` | The type of the stored rows. |
| `tests/progress-tracker.test.ts` | The tests. |
| `dev/simulate.mjs` | The stand-in run. |
| `design/` | Bar design previews and variants. |

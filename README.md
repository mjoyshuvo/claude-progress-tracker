# progress-tracker

progress-tracker is a Claude Code mod made for the **Code** tab of the Claude desktop app. It shows what Claude is doing while it works. It draws a live progress bar in the band above the prompt, and it adds a Progress pane that lists what waits on you and what Claude found.

The mod also runs in the terminal. There, the bar is drawn in text characters, and the task list has no timeline graph.

![A desktop session: a Working bar counts steps, Claude's own list takes over with a real total, a test fails twice and turns the row red, a permission prompt turns it amber, and the list finishes green with its timeline open. The Progress pane beside the chat shows the measured numbers, the failing check's error lines, and the answered permission prompt.](docs/demo.gif)

## Install the mod

Mods are on by default in current versions of Claude Code. The desktop app runs its own copy of Claude Code, and mods work there from version 2.1.286. In the terminal, you need version 2.1.287 or later.

### Check the desktop app's version

1. In the **Code** tab, start a local session.
2. Type `/status`, and read the **Claude Code** row.
3. If the version is lower than 2.1.286, update the app. On macOS, select **Claude > Check for Updates**. On Windows, select **Help > Check for Updates**. Then start a new session.

### Install in the desktop app

The desktop app's plugin browser lists plugins only from the marketplaces you added. You add this mod's marketplace once, from a terminal. That step needs the `claude` command. If you don't have it, [install Claude Code for the terminal](https://code.claude.com/docs/en/quickstart) first, or [load a local copy](#load-a-local-copy) instead.

1. In a terminal, add the marketplace:

	```bash
	claude plugin marketplace add mjoyshuvo/claude-progress-tracker
	```

2. Install the mod in the desktop app:
	1. In a local session of the **Code** tab, click the **+** button next to the prompt box.
	2. Select **Plugins**, then **Add plugin**.
	3. Select **progress-tracker**.
	4. For the scope, choose your user account.

	You can also install it from the terminal instead:

	```bash
	claude plugin install progress-tracker@mjoyshuvo-mods
	```

	The terminal and the desktop app's local sessions read the same settings files, so either way installs the mod for both.

3. Start a new session in the **Code** tab. To load the mod in a session that is already open, type `/reload-plugins`.
4. Type `/progress-tracker-demo`. A sample run plays above the prompt for about 30 seconds.

To turn the mod off or uninstall it, click **+**, then select **Plugins > Manage plugins**.

The mod runs in local sessions only. Cloud sessions and WSL sessions do not load plugins.

### Install in the terminal

1. In a Claude Code session, add the marketplace:

	```
	/plugin marketplace add mjoyshuvo/claude-progress-tracker
	```

2. Install the mod:

	```
	/plugin install progress-tracker@mjoyshuvo-mods
	```

3. Start a new session.
4. Type `/progress-tracker-demo`.

### Load a local copy

To run the mod from a folder on your computer, for example to change its code, load a local copy instead of installing it. Use one way only: install the mod, or load a local copy.

1. Clone the repository:

	```bash
	git clone https://github.com/mjoyshuvo/claude-progress-tracker.git ~/.claude/progress-tracker
	```

2. Open `~/.claude/settings.json`, and set `CLAUDE_CODE_PLUGIN_DIRS` in its `env` block to the folder:

	```json
	{
		"env": {
			"CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/progress-tracker"
		}
	}
	```

	If the file already has an `env` block, add the line to it. To load more than one folder, separate the paths with `:` on macOS and Linux, or with `;` on Windows. Each path must be absolute or start with `~`.

3. Start a new session in the **Code** tab.

To update a local copy, run `git pull` in its folder, then start a new session.

### Turn off other progress bar mods

Only one mod can draw in the band above the prompt. If you also use `plan-progress`, turn it off in **+ > Plugins > Manage plugins**, or run this command:

```bash
claude plugin disable plan-progress@zycck-mods
```

## Features

- **Live bar.** Each task list gets a row with a moving bar. The pill names the current task and its step, for example `Write tests 3/5`.
- **Real totals only.** A list that Claude declares shows `3/5` and a percent. Work without a list shows a step count, for example `Working · 12 steps`, because its total is not known.
- **Early task list.** On the 3rd tool call of a turn with no list, the mod asks Claude for its task list, so most work gets a real total.
- **Waits on you.** A question, a permission prompt, or a plan approval turns the row amber. A question or a permission prompt also shows a toast.
- **Failing checks.** A failing test, build, lint, or typecheck turns the row red and shows the first error line. The pill counts repeated failures, for example `×3`.
- **Measured numbers.** The row shows the time Claude worked, the time it waited on you, and the input and output tokens that the API reported. It does not guess the time left.
- **Context warning.** From 80% full, the row shows the context fill.
- **Progress pane.** `/progress` opens a pane with the numbers as labelled tiles and two tabs: **Blocked on me** and **Found**. Press an entry to open its details.
- **Task timeline.** Each row expands to list its tasks with their times. On desktop, parallel steps and sub-agents appear on a branch.
- **Sub-agent count.** While sub-agents that Claude started run, the pill shows how many.
- **Plan mode.** Planning gets its own row, and an approved plan becomes a row with the plan's steps.

## Watch the demo

`/progress-tracker-demo` plays a 7-step job on its own row:

1. The Progress pane opens, and the row expands to list its tasks.
2. Three file reads run in parallel.
3. A sub-agent runs, and the pill shows `· 1 agent`.
4. The "Test" step fails twice. The row turns red, the pill shows `×2`, and the **Found** tab lists the failure and a finding.
5. The step recovers. Then the row turns amber, and **Blocked on me** lists `Allow npm publish` until it is answered.
6. The bar finishes green. About 12 seconds later, the row and its pane entries clear.

The demo bar moves even while Claude is idle.

## Read the bar

Each task list gets one row, and the band shows at most 3 rows. A row has a label, the bar, its numbers, and buttons.

The label is the approved plan's title, the title Claude gave the list, or the first task.

The colour of a row tells you its state:

| Colour | State | Pill text |
| --- | --- | --- |
| Purple | Claude is working. | `Build 2/5` or `Working · 12 steps` |
| Red | A check failed in the current task. | `✕ Verify 1/2` or `✕ Test 3/5 ×3` |
| Amber | Claude waits for you. | `Waiting for you` or `Waiting for approval` |
| Green | Every task is done. | `✓ Done 5/5` or `✓ Done · 12 steps` |

The numbers after the bar are all measured:

| Number | Meaning |
| --- | --- |
| `60%` | The finished tasks of a list that Claude declared. An automatic bar has no percent. |
| `4m 10s work` | The time inside Claude's turns while the list ran, less the time it waited on you. Idle time between your messages does not count. |
| `1m 05s wait` | The time the row was amber. |
| `1.2M in · 14k out` | The tokens that each model response reported while the list ran, sub-agents included. |
| `context 85%` | The context window's fill. It appears from 80%. |

Input counts every prompt token the model read: uncached tokens, tokens read from the prompt cache, and tokens written to it. Each model call reads the whole conversation again, so input grows much faster than output, and most of it comes from the cache.

The buttons on a row:

| Button | Action |
| --- | --- |
| `▸` in the terminal, `▶ Tasks` on desktop | Lists every task with its time. |
| `☰` | Opens the Progress pane. |
| `✕` | Hides the row. |

A toast appears when a row starts to wait for your answer or permission, and when a task list finishes, for example `✓ Fix login done in 12m 03s · 2 retries`.

A finished row hides itself after a minute. New tasks after a finished list start a new row. At the next session start, the mod drops rows that are finished, hidden, or older than 12 hours.

The bar moves while Claude works on a purple or red row. It holds still while the row is amber. In the terminal, the mod draws the bar with block characters and repaints it about 15 times a second. On desktop, the bar is an SVG that animates itself, and a finished bar keeps a slow twinkle.

## Use the Progress pane

To open the pane, type `/progress` or press `☰` on a row.

The top of the pane names the current list and shows its numbers as tiles: progress, this task's time, time worked, time waited on you, tokens in with the cached share, tokens out, model calls, and context. The tiles wrap when the pane is narrow.

The pane has two tabs. Press `1` or `2` to switch.

| Tab | Shows |
| --- | --- |
| Blocked on me | Permission prompts, questions, and plan approvals. Open ones come first. Answered ones say how long they waited. |
| Found | Each failing check, once per red spell, and the findings Claude logged with `found`. |

To open an entry's details, press its title (`▸`). To close them, press it again. The details depend on the kind of entry:

- A question shows each question, its options, and the answer you gave.
- A permission prompt shows the tool, the full request, and how the call ended: it ran, it ran and ended with an error, or it did not run.
- A plan approval shows the plan's title, its number of steps, and whether you approved it.
- A failing check shows the command and up to 8 output lines that name the problem.
- A finding shows its full text.

Every entry also shows its task, how long it waited, and the time. The pane keeps the last 50 entries of each kind.

## Where the tasks come from

The mod reads only the main conversation. It ignores task calls that sub-agents make.

### Claude's task tools

In the terminal, Claude's `TaskCreate`, `TaskUpdate`, and `TodoWrite` calls fill the bar. When you approve a plan in plan mode, the plan gets its own row with the plan's title and its numbered or bulleted steps. Claude's first task list then replaces those steps.

### The `progress_tracker` tool

The desktop app has no `TaskCreate` or `TodoWrite`, so the mod adds its own tool, `mcp__progress-tracker__progress_tracker`. The mod also adds a short rule to the system prompt. The rule tells Claude to use the tool for work of more than about 3 edits or commands.

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
| `found` | string | Adds a finding, such as a bug, a root cause, or a decision, to the **Found** tab. It works without a row. |

The tool replies with the state of the row, for example `2/5, running, active "Write tests", next "Docs"`. If Claude names a task that does not exist, the tool refuses the call and lists the task names.

If Claude makes 12 tool calls without moving the bar, the mod adds one note to a tool result that tells Claude to update it. Only Claude sees the note.

### The Working bar

Outside plan mode, the mod starts a row named "Working" on the 3rd tool call of a turn, if no other row is still open. Each tool call becomes a finished step, named after the call's description or file, for example "Read config.ts". The pill counts the steps, because the total is not known. When the turn ends, the open step becomes "Write reply", and the row turns green.

On that 3rd tool call, Claude also gets a note that only it reads. The note asks Claude to send its task list if more steps are coming. When Claude sends a list with `progress_tracker`, `TaskCreate`, or `TodoWrite`, the list replaces the automatic steps, and the row shows a real total.

### Plan mode

In plan mode, a row named "Planning" appears. Each tool call becomes a finished step until Claude sends its own planning steps with `progress_tracker`. The row turns amber while Claude asks you to approve the plan. Whether you approve or reject the plan, the Planning row turns green. If you leave plan mode without an answer to a plan, the mod removes the Planning row.

### Waits, failures, and sub-agents

- When Claude asks you a question with `AskUserQuestion`, or when a permission prompt waits for you, the row turns amber until you answer.
- When a check command fails during a task, the row turns red and shows the first error line of the output. A check is a test, build, lint, or typecheck command. The command's first words decide: `pytest`, `tsc`, `ruff`, `make`, `npm test`, `cargo build`, `go test`, and `.venv/bin/pytest` all count. Commands such as `grep`, `go run`, `npm run dev`, and `test -f` do not count, even when they exit with code 1.
- The row turns back from red when the same check passes with any flags, or when a task changes state.
- While sub-agents that Claude started in this conversation run, the pill shows how many, for example `Search 1/3 · 2 agents`. Agents from other places do not count.

## Read the task timeline

On desktop, press `▶ Tasks` on a row to open its timeline. A line connects the steps, and each step shows how long it took. A running task shows its time so far.

- For an automatic step, the time is how long the tool call ran. For one of Claude's own tasks, the time runs from the task's start to its finish.
- Steps whose run times overlap leave the line on a branch and join it again. The first of them says `· 3 in parallel`.
- A sub-agent step has a robot icon and the agent type, for example `· Explore agent`. A sub-agent that starts during one of Claude's own tasks appears under that task, on a branch.
- A sub-agent that runs in the background shows `background` instead of a time.
- A task that failed shows how many times, for example `· failed ×2`.

When the timeline opens, the line draws itself from the top, and the dots appear one by one. Then a light pulse runs down the line on a loop and splits into the branches.

## Known limits

- Only steps that overlap in time count as parallel. Claude Code runs file reads at the same time, but it often runs shell commands one after another. So Bash calls that Claude sends together can still appear in a straight line.
- Work time and tokens count from when the mod loaded. A row that was open before a reload shows only what happened after it.
- A permission entry says how the call ended, not who decided. A hook or a settings rule can also stop a call.
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

To redraw `docs/demo.gif` from the mod's own bar and timeline SVGs, you need Google Chrome in `/Applications` and Python 3 with Pillow:

```bash
node design/demo-gif.mjs
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
| `hooks/progress-tracker.mjs` | The hooks: task tracking, plan mode, the Working bar, the `progress_tracker` tool, the Progress pane, and drawing. |
| `hooks/bar.mjs` | The terminal bar (`barCells`). |
| `hooks/bar-svg.mjs` | The desktop bar (`barSvg`). |
| `hooks/timeline-svg.mjs` | The task timeline rows (`timelineSvg`). |
| `types/index.d.ts` | The types of the stored rows and the pane's log. |
| `tests/progress-tracker.test.ts` | The tests. |
| `dev/simulate.mjs` | The stand-in run. |
| `design/demo-gif.mjs` | Draws `docs/demo.gif`. `design/frames-to-gif.py` joins its frames. |
| `design/` | Bar design previews and variants. |

## Why I built it

I found a Claude Code mod that shows a progress bar above the prompt, [zycck/claude-mods](https://github.com/zycck/claude-mods), but I couldn't get it working on my machine. So I built my own version to learn how mods work.

## License

MIT. See [LICENSE](LICENSE).

If the mod helps you, a star on GitHub helps other people find it.

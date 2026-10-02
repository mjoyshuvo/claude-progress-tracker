// Progress tracker: one live bar per task list, in the band above the prompt.
//
// A "track" is one task list. TaskCreate / TaskUpdate / TodoWrite fill the
// newest track; an approved plan, or new tasks after a finished list, start a
// fresh one. Only the main loop counts: subagent calls (e.agentId) are skipped.

import { barCells, ROWS as BAR_ROWS } from "./bar.mjs";
import { barSvg, SVG_HEIGHT } from "./bar-svg.mjs";

const MAX_ROWS = 3;
const MIN_BAR_COLUMNS = 16;
const FRAME_MS = 66;
const STALE_MS = 12 * 60 * 60 * 1000;
// A finished bar stays this long, then hides itself.
const DONE_LINGER_MS = 60 * 1000;

const DOT = { working: "#a99cf5", failed: "#e5604f", done: "#7cc68a", waiting: "#f0b34a" };
const PILL = {
  working: { bg: "#a99cf5", fg: "#1d1a2e" },
  failed: { bg: "#e5604f", fg: "#ffffff" },
  done: { bg: "#7cc68a", fg: "#14261a" },
  waiting: { bg: "#f0b34a", fg: "#2a1c05" },
};

// The running animation: one timer repaints every moving bar with $.ui.blit.
// Timers die with a hot reload, so this holds no data worth keeping.
const animation = { timer: null, requestId: null, bars: [], t: 0 };

// Held by the host, so tracks survive a hot reload of this file.
const TRACKS = { plugin: "progress-tracker", key: "tracks" };

// Parallel tool calls each read-modify-write the tracks; run them one by one.
let queue = Promise.resolve();

// The mod's own tool, for sessions without TaskCreate / TodoWrite (the desktop app).
const TOOL_NAME = "progress_tracker";
const TOOL = `mcp__progress-tracker__${TOOL_NAME}`;
const RULES = `# Progress bar
Work over ~3 edits/commands: call ${TOOL} with {title, tasks:[3-8 short names]}, then {next:true} per finished task, {active:"name"}, {failed:"why"}, {fixed:true}. Don't mention the bar.`;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    // Finished, dismissed and abandoned (over 12 h old) tracks go away.
    const cutoff = Date.now() - STALE_MS;
    await update($, (tracks) =>
      tracks.filter((t) => !t.isDismissed && !isComplete(t) && (t.startedAt ?? Date.now()) > cutoff),
    );
    await $.tool.register({
      name: TOOL_NAME,
      description:
        "Live progress bar above the prompt. Create with title + tasks; update with next, active, failed or fixed.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short name of the whole job; only when creating" },
          tasks: { type: "array", items: { type: "string" }, description: "Every task in order; only when creating" },
          next: { type: "boolean", description: "Current task finished, start the next one" },
          active: { type: "string", description: "Task now in progress" },
          failed: { type: "string", description: "What broke, one line" },
          fixed: { type: "boolean", description: "The failure is resolved" },
        },
      },
    });
    await $.command.register({ name: "progress-tracker-demo", description: "Play a sample run of the progress bar" });
    return result;
  });

  on("command.run", { command: "progress-tracker-demo" }, async ($) => {
    await playDemo($);
    return { text: "Playing a progress-tracker demo above the prompt (about 15 seconds)." };
  });

  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    return { sections: [...result.sections, { id: "progress-tracker:rules", text: RULES, scope: "session" }] };
  });

  on("tool.call", { tool: TOOL }, async ($, e) => {
    if (Array.isArray(e.tasks) && e.tasks.length > 0) {
      const tasks = e.tasks.map((subject, i) => ({
        id: `step${i + 1}`,
        subject: String(subject),
        status: i === 0 ? "in_progress" : "pending",
      }));
      await update($, (tracks) => {
        // A just-approved plan's bar takes Claude's list instead of a second bar.
        const active = activeOf(tracks);
        const isFreshPlan = active?.isFromPlan && !active.tasks.some((t) => t.status === "completed");
        if (isFreshPlan) return replace(tracks, { ...active, tasks, failedCommand: null, isFromPlan: false });
        return [...tracks, { ...newTrack(tracks, e.title ? String(e.title) : null), tasks }];
      });
    } else {
      await update($, (tracks) => {
        const active = activeOf(tracks);
        return active ? replace(tracks, applyOps(active, e)) : tracks;
      });
    }
    const { value: tracks = [] } = await $.state.get(TRACKS);
    const active = activeOf(tracks);
    if (!active || active.tasks.length === 0) {
      return { deny: `${TOOL_NAME}: no bar yet; create one with title and tasks.` };
    }
    if (typeof e.active === "string" && findTask(active.tasks, e.active) === -1) {
      const names = active.tasks.map((t) => `"${t.subject}"`).join(", ");
      return { deny: `${TOOL_NAME}: no task named "${e.active}"; tasks are ${names}.` };
    }
    const done = active.tasks.filter((t) => t.status === "completed").length;
    const current = active.tasks.find((t) => t.status === "in_progress");
    const state = isComplete(active) ? "done" : active.failedCommand ? "failed" : "running";
    return {
      result: `${done}/${active.tasks.length}, ${state}${current ? `, active "${current.subject}"` : ""}`,
    };
  });

  // Plan mode: a "Planning" bar (Explore → Write plan → Approval) from the first
  // prompt or tool call made in plan mode; a Write or Edit there is the plan.
  // The engine attaches a plan_mode note to every turn in plan mode: the surest sign.
  on("prompt.attachment", { type: "plan_mode" }, async ($, e, next) => {
    await startPlanning($);
    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    if (e.permissionMode === "plan" && !e.parentAgentId) await startPlanning($);
    return next(e);
  });

  on("classic.UserPromptSubmit", async ($, e, next) => {
    if (e.permission_mode === "plan") await startPlanning($);
    return next(e);
  });

  on("classic.PreToolUse", async ($, e, next) => {
    if (e.permission_mode === "plan" && !e.agent_id) {
      await startPlanning($);
      if (e.tool_name === "Write" || e.tool_name === "Edit") await onPlanning($, (t) => toStep(t, 1));
    }
    return next(e);
  });

  // Asking for approval turns the bar amber until the person answers. Approved,
  // the plan's own steps become the bar's tasks; rejected, it goes back to writing.
  on("tool.call", { tool: "ExitPlanMode" }, async ($, e, next) => {
    if (e.agentId) return next(e);
    await startPlanning($);
    await onPlanning($, (t) => ({ ...toStep(t, 2), isWaiting: true }));
    const r = await next(e);
    if (!isAnswered(r)) {
      await onPlanning($, (t) => ({ ...toStep(t, 1), isWaiting: false }));
      return r;
    }
    const plan = typeof e.plan === "string" ? e.plan : r.result?.plan;
    await onPlanning($, (t) => ({
      ...t,
      label: planTitleOf(plan),
      tasks: planStepsOf(plan),
      isPlanning: false,
      isWaiting: false,
      isFromPlan: true,
    }));
    return r;
  });

  on("tool.call", { tool: "TaskCreate" }, async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || !isAnswered(r)) return r;
    const id = String(r.result?.task?.id ?? e.tool_use_id);
    const task = { id, subject: String(e.subject ?? ""), status: "pending" };
    await update($, (tracks) => {
      // Claude's first task after an approved plan replaces the plan's own steps.
      const active = activeOf(tracks);
      if (active?.isFromPlan) return replace(tracks, { ...active, tasks: [task], isFromPlan: false });
      return withActive(tracks, (t) => ({ ...t, tasks: [...t.tasks, task] }));
    });
    return r;
  });

  on("tool.call", { tool: "TaskUpdate" }, async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || !isAnswered(r)) return r;
    const id = String(e.taskId);
    await update($, (tracks) =>
      tracks.map((t) => {
        if (!t.tasks.some((task) => task.id === id)) return t;
        const tasks =
          e.status === "deleted"
            ? t.tasks.filter((task) => task.id !== id)
            : t.tasks.map((task) =>
                task.id === id
                  ? { ...task, subject: e.subject ?? task.subject, status: e.status ?? task.status }
                  : task,
              );
        const isStatusChange = e.status !== undefined;
        return { ...t, tasks, failedCommand: isStatusChange ? null : t.failedCommand };
      }),
    );
    return r;
  });

  on("tool.call", { tool: "TodoWrite" }, async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || !isAnswered(r) || !Array.isArray(e.todos)) return r;
    const tasks = e.todos.map((todo, i) => ({
      id: `todo${i}`,
      subject: String(todo.content ?? ""),
      status: todo.status,
    }));
    await update($, (tracks) => withActive(tracks, (t) => ({ ...t, tasks, isFromPlan: false }), tasks));
    return r;
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || r.deny !== undefined) return r;
    const command = String(e.command ?? "");
    await update($, (tracks) => {
      const active = activeOf(tracks);
      if (!active || isComplete(active)) return tracks;
      if (r.isError && isCheck(command)) return replace(tracks, { ...active, failedCommand: command });
      if (!r.isError && active.failedCommand && sameCheck(active.failedCommand, command)) {
        return replace(tracks, { ...active, failedCommand: null });
      }
      return tracks;
    });
    return r;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      animate($, null, []);
      return next(e);
    }
    const { value: tracks = [] } = await $.state.get(TRACKS);
    const shown = tracks.filter((t) => !t.isDismissed && t.tasks.length > 0);
    const ui = $.ui.resolve(e);
    const dismiss = (id) => () =>
      void update($, (all) => all.map((t) => (t.id === id ? { ...t, isDismissed: true } : t)));

    // Off the terminal there is no Raster: an SVG draws the bar and SMIL moves it.
    if (e.surface !== "terminal") {
      animate($, null, []);
      if (shown.length === 0) return next(e);
      return drawDesktop(ui, shown.slice(-MAX_ROWS), e.props, dismiss);
    }

    const rows = shown
      .slice(-Math.max(1, Math.min(MAX_ROWS, Math.floor(e.props.maxRows / BAR_ROWS))))
      .map((t) => rowOf(t, e.props.bodyColumns - 2));
    animate($, e.requestId, rows.filter((r) => r.bar && isLive(r.status) && (e.props.isWorking || r.isDemo)));
    if (rows.length === 0) return next(e);

    return ui.Box({
      flexDirection: "column",
      paddingX: 1,
      children: rows.map((r) => draw(ui, r, dismiss(r.id))),
    });
  });
}

// ---- state ----

function update($, change) {
  queue = queue
    .then(async () => {
      const { value: tracks = [] } = await $.state.get(TRACKS);
      let changed = change(tracks);
      if (changed === tracks) return;
      changed = changed.map((t) => stampDone($, t));
      await $.state.set(TRACKS, changed);
    })
    .catch(() => undefined);
  return queue;
}

// Notes when a track finishes (to freeze its clock) and hides it a minute later.
// A track that starts again (new tasks, a reopened task) loses the stamp.
function stampDone($, track) {
  const isDone = isComplete(track);
  if (isDone === (track.doneAt != null)) return track;
  if (!isDone) return { ...track, doneAt: null };
  const doneAt = Date.now();
  if (!track.isDemo) {
    try {
      $.clock.after(DONE_LINGER_MS, () =>
        void update($, (all) =>
          all.map((t) => (t.id === track.id && t.doneAt === doneAt ? { ...t, isDismissed: true } : t)),
        ),
      );
    } catch {
      // No timer: the finished bar stays until ✕ or the next session.
    }
  }
  return { ...track, doneAt };
}

// Ids count up from the highest one still held, so two tracks never share a Raster key.
function newTrack(tracks, label) {
  const highest = Math.max(0, ...tracks.map((t) => Number(t.id.replace(/^track/, "")) || 0));
  return {
    id: `track${highest + 1}`,
    label,
    tasks: [],
    failedCommand: null,
    isDismissed: false,
    startedAt: Date.now(),
    doneAt: null,
  };
}

function activeOf(tracks) {
  return tracks.findLast((t) => !t.isDismissed);
}

function replace(tracks, track) {
  return tracks.map((t) => (t.id === track.id ? track : t));
}

// Applies `change` to the newest track. A finished list (or none) gets a fresh
// track first, unless `incoming` (a TodoWrite list) still names one of its tasks.
function withActive(tracks, change, incoming) {
  const active = activeOf(tracks);
  const isSameList =
    incoming !== undefined &&
    active !== undefined &&
    incoming.some((task) => active.tasks.some((old) => old.subject === task.subject));
  if (active && (!isComplete(active) || active.tasks.length === 0 || isSameList)) {
    return replace(tracks, change(active));
  }
  return [...tracks, change(newTrack(tracks, null))];
}

// /progress-tracker-demo: a scripted run on its own track. Five tasks fill one by one,
// the third fails and recovers, the bar turns green, then the track goes away.
const DEMO_STEPS = [
  [1400, { next: true }],
  [1400, { next: true }],
  [1200, { failed: "2 tests failing" }],
  [2200, { fixed: true }],
  [900, { next: true }],
  [1400, { next: true }],
  [1400, { next: true }],
];
const DEMO_LINGER_MS = 3500;

async function playDemo($) {
  let id = null;
  await update($, (tracks) => {
    const track = newTrack(tracks, "Demo: ship a feature");
    id = track.id;
    const tasks = ["Plan", "Build", "Test", "Review", "Ship"].map((subject, i) => ({
      id: `demo${i + 1}`,
      subject,
      status: i === 0 ? "in_progress" : "pending",
    }));
    return [...tracks, { ...track, tasks, isDemo: true }];
  });
  const onDemo = (change) => update($, (tracks) => tracks.map((t) => (t.id === id ? change(t) : t)));
  let at = 0;
  for (const [delay, ops] of DEMO_STEPS) {
    at += delay;
    $.clock.after(at, () => void onDemo((t) => applyOps(t, ops)));
  }
  $.clock.after(at + DEMO_LINGER_MS, () => void update($, (tracks) => tracks.filter((t) => t.id !== id)));
}

// Done and waiting-for-approval bars hold still; the rest move while Claude works.
function isLive(status) {
  return status === "working" || status === "failed";
}

// ---- plan mode ----

const PLANNING_STEPS = ["Explore", "Write plan", "Approval"];

async function startPlanning($) {
  await update($, (tracks) => {
    if (tracks.some((t) => t.isPlanning && !t.isDismissed)) return tracks;
    const tasks = PLANNING_STEPS.map((subject, i) => ({
      id: `plan${i + 1}`,
      subject,
      status: i === 0 ? "in_progress" : "pending",
    }));
    return [...tracks, { ...newTrack(tracks, "Planning"), tasks, isPlanning: true }];
  });
}

function onPlanning($, change) {
  return update($, (tracks) => tracks.map((t) => (t.isPlanning && !t.isDismissed ? change(t) : t)));
}

// Steps before `at` done, `at` in progress, the rest pending.
function toStep(track, at) {
  const tasks = track.tasks.map((t, i) => ({
    ...t,
    status: i < at ? "completed" : i === at ? "in_progress" : "pending",
  }));
  return { ...track, tasks };
}

// A plan's numbered steps, else its bullets, as tasks: at most 8, short titles.
function planStepsOf(plan) {
  const all = typeof plan === "string" ? plan.split("\n") : [];
  // Steps live under the work headings; Context and Verification lists are not tasks.
  const SKIP = /^#{1,4}\s+.*\b(context|background|verif\w*|testing|test plan|risks?|notes?|files?|out of scope)\b/i;
  const WORK = /^#{1,4}\s+.*\b(steps?|implementation|phases?|changes?|approach|plan|tasks?)\b/i;
  const sections = [];
  for (const line of all) {
    if (/^#{1,4}\s/.test(line)) sections.push({ heading: line, lines: [] });
    else (sections.at(-1) ?? sections[sections.push({ heading: "", lines: [] }) - 1]).lines.push(line);
  }
  const kept = sections.filter((s) => !SKIP.test(s.heading));
  const work = kept.filter((s) => WORK.test(s.heading));
  const lines = (work.length > 0 ? work : kept).flatMap((s) => s.lines);
  const pick = (pattern) =>
    lines.map((line) => line.match(pattern)?.[1]).filter((text) => text && text.trim().length > 0);
  const numbered = pick(/^\s{0,3}\d+[.)]\s+(.+)/);
  const steps = (numbered.length > 0 ? numbered : pick(/^\s{0,1}[-*]\s+(.+)/)).slice(0, 8);
  const titles = steps.length > 0 ? steps : ["Carry out the plan"];
  return titles.map((text, i) => ({
    id: `step${i + 1}`,
    subject: shorten(text.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim(), 40),
    status: i === 0 ? "in_progress" : "pending",
  }));
}

// The tool's short updates against the newest track.
function applyOps(track, ops) {
  let tasks = track.tasks;
  let failedCommand = track.failedCommand;
  if (ops.next === true) {
    const at = tasks.findIndex((t) => t.status === "in_progress");
    const upTo = at === -1 ? tasks.findIndex((t) => t.status !== "completed") : at;
    tasks = tasks.map((t, i) =>
      i === upTo ? { ...t, status: "completed" } : i === upTo + 1 && t.status === "pending" ? { ...t, status: "in_progress" } : t,
    );
    failedCommand = null;
  }
  if (typeof ops.active === "string") {
    const at = findTask(tasks, ops.active);
    if (at !== -1) {
      tasks = tasks.map((t, i) =>
        i < at ? { ...t, status: "completed" } : i === at ? { ...t, status: "in_progress" } : t.status === "in_progress" ? { ...t, status: "pending" } : t,
      );
    }
  }
  if (typeof ops.failed === "string") failedCommand = ops.failed || "failed";
  if (ops.fixed === true) failedCommand = null;
  return { ...track, tasks, failedCommand };
}

// Exact name first, then a prefix, then a part of the name; -1 when none fits.
export function findTask(tasks, name) {
  const want = String(name).trim().toLowerCase();
  const names = tasks.map((t) => t.subject.trim().toLowerCase());
  const exact = names.indexOf(want);
  if (exact !== -1 || want === "") return exact;
  const prefix = names.findIndex((n) => n.startsWith(want));
  return prefix !== -1 ? prefix : names.findIndex((n) => n.includes(want) || want.includes(n));
}

function isComplete(track) {
  return track.tasks.length > 0 && track.tasks.every((t) => t.status === "completed");
}

// Only a failing test, build, lint or typecheck turns a row red: grep, diff and
// test -f exit 1 as an answer, not a failure.
const CHECK = /\b(test|tests|spec|build|lint|check|typecheck|tsc|pytest|jest|vitest|mocha|cargo|go|make|gradle|mvn|eslint|ruff|mypy|rspec|phpunit|dotnet|swift|xcodebuild)\b/;

export function isCheck(command) {
  return command.split(/&&|\|\||;|\|/).some((part) => CHECK.test(part.replace(/^\s*(cd\s+\S+|\w+=\S+)\s*/, "")));
}

// A re-run with other flags or paths still counts as the same check.
export function sameCheck(a, b) {
  const head = (c) => c.trim().split(/\s+/).filter((w) => !w.startsWith("-")).slice(0, 2).join(" ");
  return a === b || head(a) === head(b);
}

function isAnswered(r) {
  return r.deny === undefined && !r.isError;
}

function planTitleOf(plan) {
  if (typeof plan !== "string") return "Plan";
  const heading = plan.split("\n").find((line) => /^#{1,3}\s+\S/.test(line));
  const title = (heading ?? plan.split("\n").find((line) => line.trim()) ?? "")
    .replace(/^#+\s*/, "")
    .replace(/^plan:\s*/i, "")
    .trim();
  return title || "Plan";
}

// ---- drawing ----

function rowOf(track, columns) {
  const total = track.tasks.length;
  const done = track.tasks.filter((t) => t.status === "completed").length;
  const current =
    track.tasks.find((t) => t.status === "in_progress") ?? track.tasks.find((t) => t.status !== "completed");
  const isDone = done === total;
  const status = isDone ? "done" : track.isWaiting ? "waiting" : track.failedCommand !== null ? "failed" : "working";
  const step = isDone ? total : Math.min(total, done + 1);
  const pill =
    status === "waiting"
      ? "Waiting for approval"
      : status === "failed"
        ? `✕ ${shorten(current?.subject ?? "Failed", 18)} ${step}/${total}`
        : track.isPlanning
          ? `${current?.subject ?? "Planning"} ${step}/${total}`
          : isDone
            ? `✓ Done ${step}/${total}`
            : `${shorten(current?.subject ?? "Tasks", 18)} ${step}/${total}`;
  const labelColumns = Math.max(12, Math.min(32, Math.floor(columns * 0.28)));
  const width = columns - labelColumns - 2 - 2 - 4 - 7 - 2 - 1 - 2;
  const hasRoom = width >= Math.max(MIN_BAR_COLUMNS, pill.length + 6);
  return {
    id: track.id,
    label: track.label ?? track.tasks[0].subject,
    labelColumns,
    status,
    pill,
    percent: Math.round((done / total) * 100),
    done,
    total,
    isDemo: track.isDemo === true,
    elapsed: track.startedAt ? durationOf((track.doneAt ?? Date.now()) - track.startedAt) : "",
    reason: track.failedCommand ? shorten(track.failedCommand, 60) : null,
    bar: hasRoom ? { key: `bar:${track.id}`, width, done, total, status, pill } : null,
  };
}

function draw({ Box, Text, Button, Raster }, row, onDismiss) {
  const isFailed = row.status === "failed";
  const pill = PILL[row.status];
  const middle = row.bar
    ? Raster({ key: row.bar.key, columns: row.bar.width, rows: BAR_ROWS, cells: cellsOf(row.bar, animation.t) })
    : Box({
        flexDirection: "row",
        children: [
          Text({ color: pill.bg, children: "▐" }),
          Text({ color: pill.fg, backgroundColor: pill.bg, bold: true, children: row.pill }),
          Text({ color: pill.bg, children: "▌" }),
        ],
      });
  return Box({
    key: row.id,
    flexDirection: "row",
    children: [
      Text({ color: DOT[row.status], bold: isFailed, children: isFailed ? "! " : "● " }),
      Box({ width: row.labelColumns, children: [Text({ wrap: "truncate-end", children: row.label })] }),
      Text({ children: "  " }),
      middle,
      Text({ dimColor: true, children: `  ${String(row.percent).padStart(3)}%${row.elapsed ? ` ${row.elapsed.padStart(6)}` : ""}  ` }),
      Button({ key: `dismiss:${row.id}`, label: "✕", plain: true, dimColor: true, onPress: onDismiss }),
    ],
  });
}

// The desktop band: every bar the same width, pinned right so rows line up.
// The desktop reports about 8 CSS px per column.
function drawDesktop({ Box, Text, Button, Svg }, tracks, props, dismiss) {
  const rows = tracks.map((t) => rowOf(t, 200));
  const total = Math.max(320, (props.bodyColumns || 100) * 8);
  const titleWidth = Math.min(Math.round(total * 0.3), Math.max(...rows.map((r) => r.label.length * 6.4)));
  const width = Math.max(140, Math.min(1400, Math.round(total - titleWidth - 140)));
  return Box({
    flexDirection: "column",
    gap: 1,
    children: rows.map((r) => {
      const isMoving = (props.isWorking || r.isDemo) && isLive(r.status);
      const bar = Svg
        ? Svg({
            source: barSvg({ width, done: r.done, total: r.total, status: r.status, pill: r.pill, isMoving }),
            alt: `${r.label}: ${r.pill}, ${r.percent}%${r.reason ? ` (${r.reason})` : ""}`,
            width,
            height: SVG_HEIGHT,
            isInteractive: isMoving || undefined,
          })
        : Text({ color: PILL[r.status].bg, children: r.pill });
      return Box({
        key: r.id,
        flexDirection: "row",
        alignItems: "center",
        gap: 1,
        children: [
          Text({ color: DOT[r.status], bold: r.status === "failed", children: r.status === "failed" ? "!" : "●" }),
          Text({ wrap: "truncate", children: r.label }),
          Box({ flexGrow: 1 }),
          bar,
          Text({ dimColor: true, children: `${String(r.percent).padStart(3, " ")}%${r.elapsed ? ` ${r.elapsed}` : ""}` }),
          Button({ key: `dismiss:${r.id}`, label: "✕", plain: true, dimColor: true, onPress: dismiss(r.id) }),
        ],
      });
    }),
  });
}

// Starts, retargets or stops the one timer that repaints the moving bars.
function animate($, requestId, rows) {
  animation.requestId = requestId;
  animation.bars = rows.map((r) => r.bar);
  if (animation.bars.length === 0) {
    animation.timer?.cancel();
    animation.timer = null;
    return;
  }
  if (animation.timer) return;
  try {
    animation.timer = $.clock.every(FRAME_MS, () => {
      animation.t += FRAME_MS;
      for (const bar of animation.bars) {
        $.ui
          .blit({ requestId: animation.requestId, key: bar.key, cells: cellsOf(bar, animation.t) })
          .catch(() => undefined);
      }
    });
  } catch {
    // No timer: the bars still draw, just without motion.
  }
}

// Packs the bar's cells as Raster wants them: base64 of little-endian u32
// triplets [codePoint, foreground, background].
function cellsOf(bar, t) {
  const cells = barCells({ ...bar, t });
  const words = new Uint32Array(cells.length * 3);
  cells.forEach(([codePoint, fg, bg], i) => words.set([codePoint, fg, bg], i * 3));
  return base64Of(new Uint8Array(words.buffer));
}

function base64Of(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
  }
  return out;
}

// 45s, 2m 14s, 1h 05m.
function durationOf(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function shorten(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

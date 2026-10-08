// Progress tracker: one live bar per task list, in the band above the prompt.
//
// A "track" is one task list. TaskCreate / TaskUpdate / TodoWrite fill the
// newest track; an approved plan, or new tasks after a finished list, start a
// fresh one. Only the main loop counts: subagent calls (e.agentId) are skipped.

import { barCells, ROWS as BAR_ROWS } from "./bar.mjs";
import { barSvg, SVG_HEIGHT } from "./bar-svg.mjs";
import { timelineSvg, ROW_HEIGHT, GUTTER_WIDTH } from "./timeline-svg.mjs";

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
// The session's log for the Progress pane: what waited on the person, and what Claude
// found. Kept apart from the tracks, so it outlives them.
const LOG = { plugin: "progress-tracker", key: "log" };
const LOG_CAP = 50;
// The Progress pane and its selected tab.
const PANE = "progress";
const TAB = { plugin: "progress-tracker", key: "tab" };
// The pane entry whose details are open, by id; null when none is.
const OPEN = { plugin: "progress-tracker", key: "open" };
const TABS = [
  { id: "blocked", label: "Blocked on me", hotkey: "1" },
  { id: "found", label: "Found", hotkey: "2" },
];
// When the main loop's running turn began, or null between turns: work time counts only inside turns.
const TURN = { plugin: "progress-tracker", key: "turn" };
// The progress_tracker inputs that move the bar; a call with none of them only logs a finding.
const TOOL_OPS = new Set(["title", "tasks", "next", "active", "add", "skip", "failed", "fixed"]);

// Parallel tool calls each read-modify-write the tracks; run them one by one.
let queue = Promise.resolve();

// Outside plan mode a turn's first tool calls wait here; the AUTO_BAR_CALLS-th starts
// a "Working" bar from them when Claude has no bar running. Reset on each turn.
const AUTO_BAR_CALLS = 3;
let turnSteps = [];
let hasTurnBar = false;
let lastMode = null;
// Tokens the running turn's model calls used so far, so a Working bar that starts on the
// turn's 3rd tool call still counts the calls before it.
let turnTokens = emptyTokens();

// The sub-agents the main loop started, by the Agent call that started each one.
// The pill counts these alone; the timeline marks the call's step as a sub-agent.
const spawned = new Map();

// The mod's own tool, for sessions without TaskCreate / TodoWrite (the desktop app).
const TOOL_NAME = "progress_tracker";
const TOOL = `mcp__progress-tracker__${TOOL_NAME}`;
const RULES = `# Progress bar
Work over ~3 edits/commands, plan mode included: call ${TOOL} with {title, tasks:[3-8 short names]}, then {next:true} per finished task, {active:"name"}, {add:["found work"]}, {skip:true}, {failed:"why"}, {fixed:true}, {found:"a bug, root cause or decision worth keeping"}. Don't mention the bar.`;

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
        "Live progress bar above the prompt. Use it for any work over ~3 edits/commands, plan mode included: create with title + 3-8 short tasks, then call with next per finished task, active, add, skip, failed or fixed; found logs a finding. Don't mention the bar.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short name of the whole job; only when creating" },
          tasks: { type: "array", items: { type: "string" }, description: "Every task in order; only when creating" },
          next: { type: "boolean", description: "Current task finished, start the next one" },
          active: { type: "string", description: "Task now in progress" },
          add: { type: "array", items: { type: "string" }, description: "Tasks found mid-run, appended to the list" },
          skip: { type: "boolean", description: "Current task is not needed; close it and start the next" },
          failed: { type: "string", description: "What broke, one line" },
          fixed: { type: "boolean", description: "The failure is resolved" },
          found: { type: "string", description: "A bug, root cause or decision worth keeping, one line" },
        },
      },
    });
    await $.command.register({ name: "progress-tracker-demo", description: "Play a sample run of the progress bar" });
    await $.command.register({ name: "progress", description: "Show what waits on you and what was found" });
    return result;
  });

  on("command.run", { command: "progress" }, async ($) => {
    await openPane($);
    return { text: "Opened the Progress pane." };
  });

  on("command.run", { command: "progress-tracker-demo" }, async ($) => {
    await playDemo($);
    return { text: "Playing a progress-tracker demo above the prompt (about 30 seconds)." };
  });

  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    return { sections: [...result.sections, { id: "progress-tracker:rules", text: RULES, scope: "session" }] };
  });

  // Org security mods can bypass user-tier prompt.compose, so the tool carries its own rule and stays loaded.
  on("tool.describe", { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }));

  on("tool.call", { tool: TOOL }, async ($, e) => {
    if (typeof e.found === "string" && e.found.trim()) await logFinding($, "found", e.found.trim(), e.tool_use_id);
    if (typeof e.found === "string" && !Object.keys(e).some((k) => TOOL_OPS.has(k))) return { result: "noted" };
    if (Array.isArray(e.tasks) && e.tasks.length > 0) {
      const tasks = e.tasks.map((subject, i) => ({
        id: `step${i + 1}`,
        subject: String(subject),
        status: i === 0 ? "in_progress" : "pending",
      }));
      await update($, (tracks) => {
        // A just-approved plan's bar, or a planning bar still guessing its steps, takes Claude's list.
        const active = activeOf(tracks);
        const isFreshPlan = active?.isFromPlan && !active.tasks.some((t) => t.status === "completed");
        if (isFreshPlan || active?.isAutoSteps) {
          const label = active.isAutoSteps && e.title ? String(e.title) : active.label;
          return replace(tracks, { ...active, ...declared(active), label, tasks, failedCommand: null });
        }
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
    const at = active.tasks.findIndex((t) => t.status === "in_progress");
    const upcoming = active.tasks.slice(at + 1).find((t) => t.status === "pending");
    const state = isComplete(active) ? "done" : active.failedCommand ? "failed" : "running";
    const parts = [`${done}/${active.tasks.length}`, state];
    if (at !== -1) parts.push(`active "${active.tasks[at].subject}"`);
    if (at !== -1 && upcoming) parts.push(`next "${upcoming.subject}"`);
    return { result: parts.join(", ") };
  });

  // Plan mode: a "Planning" bar from the first prompt or tool call made in plan mode.
  // Claude's own progress_tracker list replaces its steps; until then each tool call
  // becomes a done step, so the bar moves. The plan_mode note on every plan-mode
  // turn is the surest sign.
  on("prompt.attachment", { type: "plan_mode" }, async ($, e, next) => {
    await followMode($, "plan");
    return next(e);
  });

  // A reload asks again for every note in the transcript, old ones included, in order.
  // The exit note that followed an old plan_mode note drops the bar that note just started.
  for (const type of ["plan_mode_exit", "auto_mode"]) {
    on("prompt.attachment", { type }, async ($, e, next) => {
      await followMode($, type === "auto_mode" ? "auto" : "default");
      return next(e);
    });
  }

  on("agent.spawn", async ($, e, next) => {
    if (e.parentAgentId) return next(e);
    await followMode($, e.permissionMode);
    const r = await next(e);
    if (r.agentId) {
      spawned.set(e.tool_use_id, { id: r.agentId, type: e.subagentType, isBackground: e.background === true });
    }
    return r;
  });

  on("classic.UserPromptSubmit", async ($, e, next) => {
    await followMode($, e.permission_mode);
    return next(e);
  });

  // A permission dialog waits on the person: the bar turns amber and the pane lists it.
  on("classic.PermissionRequest", async ($, e, next) => {
    if (!e.agent_id) {
      const input = typeof e.tool_input === "object" && e.tool_input ? e.tool_input : {};
      const what = e.tool_name === "Bash" && input.command ? String(input.command).trim() : stepNameOf({ ...input, tool: e.tool_name });
      await openBlock($, "permission", `Allow ${what}`, { details: { tool: String(e.tool_name ?? ""), request: requestOf(e.tool_name, input) } });
    }
    return next(e);
  });

  // Where no PermissionRequest fires, the permission notification stands in for it.
  on("classic.Notification", async ($, e, next) => {
    if (!e.agent_id && e.notification_type === "permission_prompt") {
      await openBlock($, "permission", String(e.message ?? "Needs your permission"), { isFallback: true });
    }
    return next(e);
  });

  on("classic.PreToolUse", async ($, e, next) => {
    if (!e.agent_id) await followMode($, e.permission_mode);
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    const startedAt = Date.now();
    const r = await next(e);
    if (e.agentId) return r;
    // The call ran or was refused: whatever it asked of the person is answered.
    await noteBlock($, (b) => b.kind === "permission" && b.outcome == null && (b.answeredAt == null || b.toolUseId === e.tool_use_id), {
      outcome: outcomeOf(r),
    });
    await closeBlocks($, e.tool_use_id);
    if (NOT_A_STEP.has(e.tool)) return r;
    const step = stepOf(e, startedAt);
    await onPlanning($, (t) => (t.isAutoSteps && !t.isWaiting ? autoStep(t, step) : t));
    const listNudge = await autoWork($, step);
    if (step.agent) await noteAgentRun($, step);
    const nudges = [listNudge, await countWork($)].filter(Boolean);
    return nudges.length > 0 && r.deny === undefined ? { ...r, context: [...(r.context ?? []), ...nudges] } : r;
  });

  // Every model response reports its tokens; they count toward the list that is running.
  // Sub-agents' responses count too: their work is part of the list's work.
  // turn.step streams, so its hook is an async generator that forwards the stream untouched.
  on("turn.step", async function* ($, e, next) {
    const r = yield* next(e);
    const tokens = tokensOfUsage(r?.usage);
    if (!tokens) return r;
    if (!e.agentId) turnTokens = addTokens(turnTokens, tokens);
    await update($, (tracks) => {
      const active = activeOf(tracks);
      if (!active || isComplete(active) || active.isDemo) return tracks;
      return replace(tracks, { ...active, tokens: addTokens(active.tokens, tokens) });
    });
    return r;
  });

  on("turn.start", async ($, e, next) => {
    if (!e.agentId) {
      turnSteps = [];
      turnTokens = emptyTokens();
      hasTurnBar = false;
      await $.state.set(TURN, Date.now());
    }
    return next(e);
  });

  // The turn's "Working" bar ends with the turn and turns green; its open step becomes
  // "Write reply", timed from the last tool call to the end of the turn.
  on("turn.complete", async ($, e, next) => {
    if (!e.agentId) {
      await update($, (tracks) => tracks.map((t) => (t.isWorkBar && t.isAutoSteps ? closeWorkBar(t) : t)));
      await closeBlocks($);
      const { value: turnStartedAt = null } = await $.state.get(TURN);
      await $.state.set(TURN, null);
      if (turnStartedAt != null) await update($, (tracks) => tracks.map((t) => addTurn(t, turnStartedAt, Date.now())));
    }
    return next(e);
  });

  // Asking for approval turns the bar amber until the person answers. Either answer
  // ends this round of planning (green); approved, the plan's steps get a bar of their own.
  on("tool.call", { tool: "ExitPlanMode" }, async ($, e, next) => {
    if (e.agentId) return next(e);
    await onPlanning($, (t) => ({ ...toStep(t, t.tasks.length - 1), isWaiting: true }));
    await openBlock($, "approval", "Approve the plan", { keepsBar: true, toolUseId: e.tool_use_id });
    const r = await next(e);
    const approved = typeof e.plan === "string" ? e.plan : r.result?.plan;
    await noteBlock($, (b) => b.kind === "approval" && b.toolUseId === e.tool_use_id, {
      outcome: isAnswered(r) ? "Approved" : "Not approved",
      details: { plan: planTitleOf(approved), steps: planStepsOf(approved).length },
    });
    await closeBlocks($);
    await onPlanning($, (t) => ({
      ...toStep(t, t.tasks.length),
      isPlanning: false,
      isWaiting: false,
      isAutoSteps: false,
    }));
    if (!isAnswered(r)) return r;
    const plan = typeof e.plan === "string" ? e.plan : r.result?.plan;
    await update($, (tracks) => [
      ...tracks,
      { ...newTrack(tracks, planTitleOf(plan)), tasks: planStepsOf(plan), isFromPlan: true },
    ]);
    return r;
  });

  // A question to the person turns the working bar amber until it is answered.
  on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
    if (e.agentId) return next(e);
    const questions = (Array.isArray(e.questions) ? e.questions : []).map((q) => ({
      question: String(q?.question ?? ""),
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => String(o?.label ?? o)),
    }));
    await openBlock($, "question", questions[0]?.question || "A question for you", { toolUseId: e.tool_use_id, details: { questions } });
    let r;
    try {
      r = await next(e);
      return r;
    } finally {
      // The answers come back keyed by the question's text.
      const answers = isAnswered(r ?? {}) && r.result && typeof r.result.answers === "object" ? r.result.answers : null;
      await noteBlock($, (b) => b.kind === "question" && b.toolUseId === e.tool_use_id, {
        outcome: answers ? "Answered" : "Not answered",
        answers: answers ? Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, String(a)])) : null,
      });
      await closeBlocks($);
    }
  });

  on("tool.call", { tool: "TaskCreate" }, async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || !isAnswered(r)) return r;
    const id = String(r.result?.task?.id ?? e.tool_use_id);
    const task = { id, subject: String(e.subject ?? ""), status: "pending" };
    await update($, (tracks) => {
      // Claude's first task after an approved plan, or on an automatic bar, replaces its steps.
      const active = activeOf(tracks);
      if (active?.isFromPlan || (active?.isCounter && !isComplete(active))) {
        return replace(tracks, { ...active, ...declared(active), tasks: [task] });
      }
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
    await update($, (tracks) => withActive(tracks, (t) => ({ ...t, ...declared(t), tasks }), tasks));
    return r;
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || r.deny !== undefined) return r;
    const command = String(e.command ?? "");
    await update($, (tracks) => {
      const active = activeOf(tracks);
      if (!active || isComplete(active)) return tracks;
      if (r.isError && isCheck(command)) {
        return replace(tracks, { ...active, failedCommand: command, failedReason: errorLineOf(r.result), failedLines: errorLinesOf(r.result), failedRuns: (active.failedRuns ?? 0) + 1, failedToolUseId: e.tool_use_id });
      }
      if (!r.isError && active.failedCommand && sameCheck(active.failedCommand, command)) {
        return replace(tracks, { ...active, failedCommand: null, failedReason: null });
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
    const agents = await runningAgentsOf($);
    const shown = tracks
      .filter((t) => !t.isDismissed && t.tasks.length > 0)
      .map((t, i, all) => (i === all.length - 1 ? { ...t, agents: t.isDemo ? (t.demoAgents ?? 0) : agents } : t));
    const ui = $.ui.resolve(e);
    const ctx = await contextOf($);
    const dismiss = (id) => () =>
      void update($, (all) => all.map((t) => (t.id === id ? { ...t, isDismissed: true } : t)));
    const toggle = (id) => () =>
      void update($, (all) => all.map((t) => (t.id === id ? { ...t, isExpanded: !t.isExpanded } : t)));

    // Off the terminal there is no Raster: an SVG draws the bar and SMIL moves it.
    if (e.surface !== "terminal") {
      animate($, null, []);
      if (shown.length === 0) return next(e);
      return drawDesktop(ui, shown.slice(-MAX_ROWS), e.props, { dismiss, toggle, pane: () => void openPane($) }, ctx);
    }

    const rows = shown
      .slice(-Math.max(1, Math.min(MAX_ROWS, Math.floor(e.props.maxRows / BAR_ROWS))))
      .map((t) => rowOf(t, e.props.bodyColumns - 2, ctx));
    animate($, e.requestId, rows.filter((r) => r.bar && isLive(r.status) && (e.props.isWorking || r.isDemo)));
    if (rows.length === 0) return next(e);

    // Expanded rows share the rows the bars leave free, in order.
    let spare = e.props.maxRows - rows.length * BAR_ROWS;
    const actions = { dismiss, toggle, pane: () => void openPane($) };
    return ui.Box({
      flexDirection: "column",
      paddingX: 1,
      children: rows.map((r) => {
        const lines = r.isExpanded ? Math.max(0, spare) : 0;
        spare -= lines;
        return draw(ui, r, actions, lines);
      }),
    });
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { value: log = emptyLog() } = await $.state.get(LOG);
    const { value: saved = "blocked" } = await $.state.get(TAB);
    const tab = TABS.some((t) => t.id === saved) ? saved : "blocked";
    const { value: tracks = [] } = await $.state.get(TRACKS);
    const active = activeOf(tracks.filter((t) => t.tasks.length > 0));
    const { value: openId = null } = await $.state.get(OPEN);
    const kit = { ...$.ui.resolve(e), openId, toggle: (id) => () => void $.state.set(OPEN, openId === id ? null : id) };
    return drawPane(kit, { log, tab, track: active, ctx: await contextOf($) }, (id) => () => void $.state.set(TAB, id));
  });
}

// ---- state ----

function update($, change) {
  queue = queue
    .then(async () => {
      const { value: tracks = [] } = await $.state.get(TRACKS);
      let changed = change(tracks);
      if (changed === tracks) return;
      const before = new Map(tracks.map((t) => [t.id, t]));
      changed = changed.map((t) => stampWait(before.get(t.id), stampDone($, stampFailure(before.get(t.id), stampTasks(t)))));
      await $.state.set(TRACKS, changed);
      for (const t of changed) notify($, before.get(t.id), t);
      const failures = changed.filter((t) => t.failureToLog && t.failureToLog !== before.get(t.id)?.failureToLog);
      if (failures.length > 0) {
        await writeLog($, (log) => ({
          ...log,
          findings: capped([...log.findings, ...failures.map((t, i) => ({ kind: "failed", ...t.failureToLog, id: entryId("failed", log.findings.length + i), at: Date.now(), isDemo: t.isDemo }))]),
        }));
      }
    })
    .catch(() => undefined);
  return queue;
}

// ---- measured numbers: work, wait, tokens, context ----

// A list Claude declared itself: its total is real, so the bar counts x/y again.
function declared(track) {
  return {
    isFromPlan: false,
    isAutoSteps: false,
    isCounter: false,
    isWorkBar: false,
    label: track.isWorkBar ? null : track.label,
  };
}

// Time spent waiting on the person: from the moment the bar turns amber until it turns back.
function stampWait(old, track) {
  const now = Date.now();
  if (track.isWaiting && !old?.isWaiting) return { ...track, waitingSince: now };
  if (!track.isWaiting && old?.isWaiting && track.waitingSince != null) {
    return { ...track, waitMs: (track.waitMs ?? 0) + (now - track.waitingSince), waitingSince: null };
  }
  return track;
}

// A finished turn adds the part of it that overlaps the track's own life.
function addTurn(track, turnStart, turnEnd) {
  if (track.isDemo) return track;
  const overlap = Math.min(turnEnd, track.doneAt ?? turnEnd) - Math.max(turnStart, track.startedAt ?? turnStart);
  return overlap > 0 ? { ...track, turnMs: (track.turnMs ?? 0) + overlap } : track;
}

// Work: the time Claude was in a turn while the track ran, less the time it waited on the
// person. Idle time between turns counts as neither. The demo runs outside any turn.
export function workOf(track, now, turnStartedAt) {
  const end = Math.min(now, track.doneAt ?? now);
  const start = track.isDemo ? track.startedAt : turnStartedAt;
  const live = start != null ? Math.max(0, end - Math.max(start, track.startedAt ?? start)) : 0;
  return Math.max(0, (track.turnMs ?? 0) + live - waitOf(track, now));
}

export function waitOf(track, now) {
  return (track.waitMs ?? 0) + (track.waitingSince != null ? now - track.waitingSince : 0);
}

// The context window's fill as the engine reports it; null where it reports none.
async function usageOf($) {
  try {
    const usage = await $.session.usage();
    return { contextPercent: usage.context?.percent ?? null };
  } catch {
    return { contextPercent: null };
  }
}

async function contextOf($) {
  const { value: turnStartedAt = null } = await $.state.get(TURN);
  return { now: Date.now(), turnStartedAt, ...(await usageOf($)) };
}

// Tokens as the API reports them per response. Input is every prompt token the model
// read: uncached, read from the cache, and written to it. Each call re-reads the whole
// conversation, so input grows much faster than output, and most of it comes from the cache.
function emptyTokens() {
  return { input: 0, cached: 0, output: 0, calls: 0 };
}

function tokensOfUsage(usage) {
  if (!usage) return null;
  const cached = usage.cache_read_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0);
  return { input, cached, output: usage.output_tokens ?? 0, calls: 1 };
}

function addTokens(a = emptyTokens(), b) {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, calls: a.calls + b.calls };
}

// 820, 14.2k, 142k, 1.23M.
export function countOf(n) {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Notes when each task starts and finishes. A reopened task loses its finish.
function stampTasks(track) {
  const now = Date.now();
  const tasks = track.tasks.map((t) => {
    if (t.status === "in_progress" && (t.startedAt == null || t.doneAt != null)) {
      return { ...t, startedAt: t.startedAt ?? now, doneAt: null };
    }
    if (t.status === "completed" && t.doneAt == null) return { ...t, doneAt: now };
    return t;
  });
  return tasks.every((t, i) => t === track.tasks[i]) ? track : { ...track, tasks };
}

// ---- the session log (Progress pane) ----

function emptyLog() {
  return { blocks: [], findings: [] };
}

function capped(list) {
  return list.slice(-LOG_CAP);
}

// Unqueued: for use inside a queued job. Everything else goes through changeLog.
async function writeLog($, change) {
  const { value: log = emptyLog() } = await $.state.get(LOG);
  const changed = change(log);
  if (changed !== log) await $.state.set(LOG, changed);
}

function changeLog($, change) {
  queue = queue.then(() => writeLog($, change)).catch(() => undefined);
  return queue;
}

async function currentTaskOf($) {
  const { value: tracks = [] } = await $.state.get(TRACKS);
  const active = activeOf(tracks);
  return active?.isAutoSteps ? null : (active?.tasks.find((t) => t.status === "in_progress")?.subject ?? null);
}

// Something waits on the person: the bar turns amber and the pane lists it. A plan
// approval keeps its own Planning bar; a fallback adds nothing when one is already open.
async function openBlock($, kind, text, { isFallback = false, keepsBar = false, toolUseId = null, details = null } = {}) {
  const task = await currentTaskOf($);
  if (!keepsBar) {
    await update($, (tracks) => {
      const active = activeOf(tracks);
      return active && !isComplete(active) && !active.isWaiting ? replace(tracks, { ...active, isWaiting: true }) : tracks;
    });
  }
  await changeLog($, (log) => {
    if (isFallback && log.blocks.some((b) => b.kind === kind && b.answeredAt == null)) return log;
    const block = { id: entryId(kind, log.blocks.length), kind, text: shorten(text, 120), task, at: Date.now(), answeredAt: null, toolUseId, details };
    return { ...log, blocks: capped([...log.blocks, block]) };
  });
}

// Adds what happened to the newest block that matches: the answer, how the call ended.
function noteBlock($, isTarget, fields) {
  return changeLog($, (log) => {
    const at = log.blocks.findLastIndex(isTarget);
    if (at === -1) return log;
    return { ...log, blocks: log.blocks.map((b, i) => (i === at ? { ...b, ...fields } : b)) };
  });
}

// How a call ended, as its result says. A refusal is not said to be the person's: a hook
// or a rule can refuse a call too.
function outcomeOf(r) {
  if (r.deny !== undefined) return "It did not run";
  return r.isError ? "It ran and ended with an error" : "It ran";
}

// What a permission prompt asked to do, in full: the command, else the file, else the input.
function requestOf(tool, input) {
  if (input.command) return String(input.command);
  if (input.file_path || input.notebook_path) return String(input.file_path ?? input.notebook_path);
  if (input.url) return String(input.url);
  const text = JSON.stringify(input);
  return text === "{}" ? String(tool ?? "") : shorten(text, 400);
}

// A log entry's id: stable while the entry lives, so its details stay open across renders.
function entryId(kind, n) {
  return `${kind}-${Date.now().toString(36)}-${n}`;
}

// A permission prompt learns which call it belonged to when that call ends.
async function closeBlocks($, toolUseId = null) {
  await changeLog($, (log) => {
    if (!log.blocks.some((b) => b.answeredAt == null)) return log;
    const now = Date.now();
    const close = (b) => ({ ...b, answeredAt: now, toolUseId: b.toolUseId ?? toolUseId });
    return { ...log, blocks: log.blocks.map((b) => (b.answeredAt == null ? close(b) : b)) };
  });
  await update($, (tracks) => {
    const active = activeOf(tracks);
    return active?.isWaiting && !active.isPlanning ? replace(tracks, { ...active, isWaiting: false }) : tracks;
  });
}

async function logFinding($, kind, text, toolUseId = null) {
  const task = await currentTaskOf($);
  await changeLog($, (log) => ({
    ...log,
    findings: capped([...log.findings, { id: entryId(kind, log.findings.length), kind, text: shorten(text, 1000), task, at: Date.now(), toolUseId }]),
  }));
}

async function openPane($) {
  try {
    const opened = await $.ui.open({ id: PANE, title: "Progress" });
    if (!opened.isPlaced) $.ui.toast(`Progress pane waits: ${opened.reason ?? "this window shows no panes"}`);
  } catch {
    // No panes on this surface.
  }
}

// Each new failing run counts against the task in progress; the first of a red spell
// also goes to the Found tab.
function stampFailure(old, track) {
  if (!track.failedRuns || track.failedRuns === old?.failedRuns) return track;
  const at = track.tasks.findIndex((t) => t.status === "in_progress");
  if (at === -1) return track;
  const tasks = track.tasks.map((t, i) => (i === at ? { ...t, failures: (t.failures ?? 0) + 1 } : t));
  const isNewSpell = old?.failedCommand == null;
  return {
    ...track,
    tasks,
    failureToLog: isNewSpell
      ? {
          text: track.failedReason ?? track.failedCommand,
          task: tasks[at].subject,
          toolUseId: track.failedToolUseId ?? null,
          command: track.failedCommand,
          lines: track.failedLines ?? [],
        }
      : null,
  };
}

// A toast when a bar starts waiting on the person, and when a real task list finishes.
function notify($, old, track) {
  try {
    if (track.isWaiting && !old?.isWaiting && !track.isPlanning) {
      $.ui.toast(`Waiting for you · ${track.label ?? track.tasks[0]?.subject ?? "Claude"}`);
    }
    const isAuto = track.isWorkBar || track.isPlanning || track.isAutoSteps;
    if (track.doneAt != null && old?.doneAt == null && old !== undefined && !isAuto) {
      const retries = track.tasks.reduce((sum, t) => sum + (t.failures ?? 0), 0);
      const time = track.startedAt ? ` in ${durationOf(track.doneAt - track.startedAt)}` : "";
      $.ui.toast(`✓ ${track.label ?? track.tasks[0]?.subject ?? "Tasks"} done${time}${retries ? ` · ${retries} ${retries === 1 ? "retry" : "retries"}` : ""}`);
    }
  } catch {
    // No toasts on this surface.
  }
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
          all.map((t) => (t.id === track.id && t.doneAt === doneAt && !t.isExpanded ? { ...t, isDismissed: true } : t)),
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

// /progress-tracker-demo: a scripted run on its own track that shows every feature: three
// reads in parallel, a sub-agent, a failing check that recovers, time left, and the
// finished timeline opened on its own. The track goes away a while after it finishes.
const DEMO_TASKS = ["Plan", "Read config.ts", "Read api.ts", "Read db.ts", "Build", "Test", "Ship"];
// Each step: [delay, change to the demo track, change to the pane's log]. Demo log
// entries carry isDemo and go when the demo does.
const DEMO_STEPS = [
  [1400, (t) => applyOps(t, { next: true })],
  [1600, demoParallelReads],
  [700, (t) => ({ ...t, demoAgents: 1, isExpanded: true })],
  [1600, demoAgentDone],
  [600, (t) => applyOps(t, { next: true })],
  [1200, (t) => applyOps(t, { failed: "2 tests failing" })],
  [1300, (t) => applyOps(t, { failed: "1 test failing" }), demoFinding("Retry loop in api.ts drops the auth header", "Test")],
  [1600, (t) => applyOps(t, { fixed: true })],
  [500, (t) => ({ ...t, isWaiting: true }), demoBlock("Allow npm publish", "Ship")],
  [1800, (t) => ({ ...t, isWaiting: false }), demoAnswer],
  [900, (t) => applyOps(t, { next: true })],
  [1400, (t) => applyOps(t, { next: true })],
];
const DEMO_LINGER_MS = 12000;

function demoFinding(text, task) {
  return (log) => ({ ...log, findings: [...log.findings, { id: entryId("found", log.findings.length), kind: "found", text, task, at: Date.now(), isDemo: true }] });
}

function demoBlock(text, task) {
  return (log) => ({
    ...log,
    blocks: [
      ...log.blocks,
      {
        id: entryId("permission", log.blocks.length),
        kind: "permission",
        text,
        task,
        at: Date.now(),
        answeredAt: null,
        isDemo: true,
        details: { tool: "Bash", request: text.replace(/^Allow /, "") },
      },
    ],
  });
}

function demoAnswer(log) {
  return {
    ...log,
    blocks: log.blocks.map((b) => (b.isDemo && b.answeredAt == null ? { ...b, answeredAt: Date.now(), outcome: "It ran" } : b)),
  };
}

function dropDemoLog(log) {
  const keep = (list) => list.filter((entry) => !entry.isDemo);
  return { blocks: keep(log.blocks), findings: keep(log.findings) };
}

async function playDemo($) {
  let id = null;
  await update($, (tracks) => {
    const track = newTrack(tracks, "Demo: ship a feature");
    id = track.id;
    const tasks = DEMO_TASKS.map((subject, i) => ({
      id: `demo${i + 1}`,
      subject,
      status: i === 0 ? "in_progress" : "pending",
    }));
    return [...tracks, { ...track, tasks, isDemo: true }];
  });
  const onDemo = (change) => update($, (tracks) => tracks.map((t) => (t.id === id ? change(t) : t)));
  await openPane($);
  let at = 0;
  for (const [delay, change, logChange] of DEMO_STEPS) {
    at += delay;
    $.clock.after(at, () => {
      void onDemo(change);
      if (logChange) void changeLog($, logChange);
    });
  }
  $.clock.after(at + DEMO_LINGER_MS, () => {
    void update($, (tracks) => tracks.filter((t) => t.id !== id));
    void changeLog($, dropDemoLog);
  });
}

// The three reads all start when Plan finishes and end at different times.
function demoParallelReads(track) {
  const now = Date.now();
  const start = track.tasks[0].doneAt ?? now - 1600;
  const lengths = [900, 1300, 1600];
  const tasks = track.tasks.map((task, i) => {
    if (i >= 1 && i <= 3) return { ...task, status: "completed", startedAt: start, doneAt: start + lengths[i - 1] };
    return i === 4 ? { ...task, status: "in_progress", startedAt: start + Math.max(...lengths) } : task;
  });
  return { ...track, tasks };
}

function demoAgentDone(track) {
  const now = Date.now();
  const run = {
    taskId: "demo5",
    subject: "Map the routes",
    agent: { type: "Explore", isBackground: false },
    startedAt: now - 1600,
    doneAt: now,
  };
  return { ...track, demoAgents: 0, agentRuns: [...(track.agentRuns ?? []), run] };
}

// Done and waiting-for-approval bars hold still; the rest move while Claude works.
function isLive(status) {
  return status === "working" || status === "failed";
}

// ---- plan mode ----

// Counts work calls since the bar last moved. After NUDGE_AFTER of them Claude gets one
// note it alone reads, so a forgotten {next:true} does not freeze the bar.
const NUDGE_AFTER = 12;

async function countWork($) {
  let nudge = null;
  await update($, (tracks) => {
    const active = activeOf(tracks);
    if (!active || active.isAutoSteps || isComplete(active)) return tracks;
    const key = active.tasks.map((t) => t.status).join(",");
    const calls = key === active.statusKey ? (active.callsSinceMove ?? 0) + 1 : 1;
    if (calls >= NUDGE_AFTER) {
      const current = active.tasks.find((t) => t.status === "in_progress");
      const done = active.tasks.filter((t) => t.status === "completed").length;
      nudge = `The progress bar still shows "${current?.subject ?? "nothing"}" in progress (${done}/${active.tasks.length}). If that task is done, update it now (${TOOL_NAME} next/active, or TaskUpdate). Don't mention this note.`;
    }
    return replace(tracks, { ...active, statusKey: key, callsSinceMove: nudge ? 0 : calls });
  });
  return nudge;
}

// Tools that are bookkeeping, not work: they never become a planning step.
const NOT_A_STEP = new Set([TOOL, "ExitPlanMode", "AskUserQuestion", "ToolSearch", "TaskCreate", "TaskUpdate", "TodoWrite"]);

// In plan mode a Planning bar starts. Out of it, a Planning bar that never reached
// ExitPlanMode (the person left plan mode by hand) is dropped.
async function followMode($, mode) {
  if (mode) lastMode = mode;
  if (mode === "plan") return startPlanning($);
  if (mode) await update($, (tracks) => (tracks.some((t) => t.isPlanning) ? tracks.filter((t) => !t.isPlanning) : tracks));
}

async function startPlanning($) {
  await update($, (tracks) => {
    if (tracks.some((t) => t.isPlanning && !t.isDismissed)) return tracks;
    const tasks = [
      { id: "plan1", subject: "Explore", status: "in_progress" },
      { id: "approval", subject: "Approval", status: "pending" },
    ];
    return [...tracks, { ...newTrack(tracks, "Planning"), tasks, isPlanning: true, isAutoSteps: true, isCounter: true }];
  });
}

// The step in progress is done and named after the call; a new one starts before Approval.
function autoStep(track, step) {
  const at = track.tasks.findIndex((t) => t.status === "in_progress");
  if (at === -1) return track;
  const done = { ...track.tasks[at], ...taskOf(step), status: "completed" };
  const subject = track.isWorkBar ? "Working" : step.isWrite ? "Write plan" : "Explore";
  const following = { id: `plan${at + 2}`, subject, status: "in_progress" };
  return { ...track, tasks: [...track.tasks.slice(0, at), done, following, ...track.tasks.slice(at + 1)] };
}

function closeWorkBar(track) {
  const steps = track.tasks.filter((task) => task.status === "completed");
  const open = track.tasks.find((task) => task.status === "in_progress");
  const lastEnd = Math.max(0, ...steps.map((task) => task.doneAt ?? 0));
  const reply = open
    ? [{ ...open, subject: "Write reply", status: "completed", startedAt: lastEnd || open.startedAt, doneAt: Date.now() }]
    : [];
  return { ...track, tasks: [...steps, ...reply], isAutoSteps: false };
}

// One finished tool call, timed by the hook that ran it.
function stepOf(call, startedAt) {
  const run =
    spawned.get(call.tool_use_id) ??
    (call.tool === "Agent"
      ? { type: String(call.subagent_type ?? "general-purpose"), isBackground: call.run_in_background === true }
      : undefined);
  const agent = run ? { type: run.type, isBackground: run.isBackground } : undefined;
  return { subject: stepNameOf(call), startedAt, doneAt: Date.now(), isWrite: call.tool === "Write" || call.tool === "Edit", agent };
}

function taskOf(step) {
  return { subject: step.subject, startedAt: step.startedAt, doneAt: step.doneAt, agent: step.agent };
}

// A sub-agent run during one of Claude's own tasks is listed under that task.
async function noteAgentRun($, step) {
  await update($, (tracks) => {
    const active = activeOf(tracks);
    const task = active?.tasks.find((t) => t.status === "in_progress");
    if (!task || active.isAutoSteps) return tracks;
    const run = { taskId: task.id, ...taskOf(step) };
    return replace(tracks, { ...active, agentRuns: [...(active.agentRuns ?? []), run] });
  });
}

// The note Claude gets when a turn's work starts without a list: the bar can only count
// steps until Claude says how many there are.
const LIST_NUDGE = `This work has no task list yet, so the progress bar can only count steps. If more steps are coming, call ${TOOL} now with {title, tasks:[every step you plan]} so the bar shows a real total. Don't mention this note.`;

// Returns the note for Claude when this call starts a Working bar.
async function autoWork($, step) {
  if (lastMode === "plan") return null;
  turnSteps.push(step);
  let nudge = null;
  await update($, (tracks) => {
    const active = activeOf(tracks);
    if (active?.isWorkBar && active.isAutoSteps) return replace(tracks, autoStep(active, step));
    if (hasTurnBar || turnSteps.length < AUTO_BAR_CALLS || (active && !isComplete(active))) return tracks;
    hasTurnBar = true;
    nudge = LIST_NUDGE;
    const done = turnSteps.map((s, i) => ({ id: `plan${i + 1}`, ...taskOf(s), status: "completed" }));
    const tasks = [...done, { id: `plan${done.length + 1}`, subject: "Working", status: "in_progress" }];
    const track = { ...newTrack(tracks, "Working"), startedAt: turnSteps[0].startedAt, tokens: turnTokens };
    return [...tracks, { ...track, tasks, isWorkBar: true, isAutoSteps: true, isCounter: true }];
  });
  return nudge;
}

export function stepNameOf(call) {
  const file = String(call.file_path ?? call.path ?? "").split("/").filter(Boolean).at(-1);
  const name =
    call.description ??
    (call.tool === "Read" && file ? `Read ${file}` : null) ??
    (call.tool === "Write" && file ? `Write ${file}` : null) ??
    (call.tool === "Edit" && file ? `Edit ${file}` : null) ??
    (call.pattern ? `Search ${call.pattern}` : null) ??
    (call.tool === "Bash" ? String(call.command ?? "").trim().split(/\s+/)[0] || "Run a command" : null) ??
    String(call.tool ?? "Step").replace(/^mcp__.*__/, "");
  return shorten(String(name).replace(/\s+/g, " ").trim(), 40);
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
  if (Array.isArray(ops.add) && ops.add.length > 0) {
    const added = ops.add.map((subject, i) => ({ id: `add${tasks.length + i + 1}`, subject: String(subject), status: "pending" }));
    tasks = [...tasks, ...added];
    if (!tasks.some((t) => t.status === "in_progress")) {
      const first = tasks.findIndex((t) => t.status === "pending");
      tasks = tasks.map((t, i) => (i === first ? { ...t, status: "in_progress" } : t));
    }
  }
  if (ops.next === true || ops.skip === true) {
    const at = tasks.findIndex((t) => t.status === "in_progress");
    const upTo = at === -1 ? tasks.findIndex((t) => t.status !== "completed") : at;
    const closed = ops.skip === true ? { status: "completed", isSkipped: true } : { status: "completed" };
    tasks = tasks.map((t, i) =>
      i === upTo ? { ...t, ...closed } : i === upTo + 1 && t.status === "pending" ? { ...t, status: "in_progress" } : t,
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
  let failedRuns = track.failedRuns;
  if (typeof ops.failed === "string") {
    failedCommand = ops.failed || "failed";
    failedRuns = (failedRuns ?? 0) + 1;
  }
  if (ops.fixed === true) failedCommand = null;
  const isSameFailure = failedCommand === track.failedCommand;
  return {
    ...track,
    tasks,
    failedCommand,
    failedRuns,
    failedReason: isSameFailure ? track.failedReason : null,
    failedLines: isSameFailure ? track.failedLines : null,
  };
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
// test -f exit 1 as an answer, not a failure. The command's head decides, not any word in it.
const RUNNERS = /^(pytest|py\.test|tox|nox|jest|vitest|mocha|tsc|eslint|ruff|mypy|flake8|pylint|black|isort|pre-commit|rspec|phpunit|xcodebuild|gradle|gradlew|mvn|make|bazel|ctest)$/;

export function isCheck(command) {
  return command.split(/&&|\|\||;|\|/).some((part) => {
    const words = part.trim().split(/\s+/).filter((w) => w && !w.startsWith("-"));
    while (words.length > 0 && (/^\w+=/.test(words[0]) || words[0] === "cd" || words[0] === "time")) {
      words.splice(0, words[0] === "cd" ? 2 : 1);
    }
    return isCheckWords(words);
  });
}

function isCheckWords([first = "", ...rest]) {
  const head = first.split("/").at(-1);
  const [a = "", b = ""] = rest;
  if (RUNNERS.test(head)) return true;
  if (/^(npx|bunx|pnpx|uv|poetry|pipx)$/.test(head)) return isCheckWords(a === "run" || a === "exec" ? rest.slice(1) : rest);
  if (/^python[\d.]*$/.test(head)) return isCheckWords(rest);
  if (/^(npm|pnpm|yarn|bun)$/.test(head)) {
    return /^(test|t|build|lint|typecheck|check)$/.test(a) || (a === "run" && /^(test|build|lint|typecheck|type-check|check)(:|$)/.test(b));
  }
  if (head === "cargo") return /^(test|build|check|clippy|nextest)$/.test(a);
  if (head === "go") return /^(test|build|vet)$/.test(a);
  if (head === "dotnet" || head === "swift") return /^(test|build)$/.test(a);
  if (head === "claude") return a === "plugin" && /^(test|validate)$/.test(b);
  return false;
}

const ERROR_LINE = /\b(error|errors|failed|failure|FAIL|assert\w*)\b|✕/i;

// Up to 8 lines of a failed check's output for the pane: the lines that name a problem,
// else the last lines of the output.
function errorLinesOf(result) {
  const text = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) => ERROR_LINE.test(l));
  return (hits.length > 0 ? hits.slice(0, 8) : lines.slice(-8)).map((l) => shorten(l, 200));
}

// The first line of a failed check's output that names the problem.
function errorLineOf(result) {
  const text = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const line = text.split("\n").find((l) => /\b(error|errors|failed|failure|FAIL|assert\w*)\b|✕/i.test(l));
  return line ? line.trim() : null;
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

// Sub-agents the main loop started that are still running; 0 where the engine cannot list them.
async function runningAgentsOf($) {
  if (spawned.size === 0) return 0;
  try {
    const ours = new Set([...spawned.values()].map((run) => run.id));
    const agents = await $.agent.list();
    return agents.filter((a) => a.status === "running" && ours.has(a.id)).length;
  } catch {
    return 0;
  }
}

function agentsOf(count = 0) {
  return count === 0 ? "" : ` · ${count} agent${count === 1 ? "" : "s"}`;
}

// What a row shows. Only measured numbers: x/y and the percent only for a list Claude
// declared (an automatic bar counts steps, its total unknown); time worked and waited;
// the tokens the API reported while it ran; the context fill once it is high.
function rowOf(track, columns, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const total = track.tasks.length;
  const done = track.tasks.filter((t) => t.status === "completed").length;
  const current =
    track.tasks.find((t) => t.status === "in_progress") ?? track.tasks.find((t) => t.status !== "completed");
  const isDone = done === total;
  const isCounter = track.isCounter === true;
  const status = isDone ? "done" : track.isWaiting ? "waiting" : track.failedCommand !== null ? "failed" : "working";
  const step = isDone ? total : Math.min(total, done + 1);
  const where = isCounter ? ` · ${done} ${done === 1 ? "step" : "steps"}` : ` ${step}/${total}`;
  const tries = (current?.failures ?? 0) >= 2 ? ` ×${current.failures}` : "";
  const pill =
    status === "waiting"
      ? track.isPlanning ? "Waiting for approval" : "Waiting for you"
      : status === "failed"
        ? `✕ ${shorten(current?.subject ?? "Failed", 18)}${where}${tries}`
        : isDone
          ? `✓ Done${where}`
          : `${shorten(current?.subject ?? "Tasks", 18)}${where}${agentsOf(track.agents)}`;
  const percent = isCounter ? null : Math.round((done / total) * 100);
  const workMs = workOf(track, now, ctx.turnStartedAt ?? null);
  const waitMs = waitOf(track, now);
  const tokens = track.tokens?.calls ? track.tokens : null;
  const stats = [
    percent != null ? `${percent}%` : null,
    `${durationOf(workMs)} work`,
    waitMs >= 1000 ? `${durationOf(waitMs)} wait` : null,
    tokens ? `${countOf(tokens.input)} in · ${countOf(tokens.output)} out` : null,
    (ctx.contextPercent ?? 0) >= 80 ? `context ${ctx.contextPercent}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const skipped = track.tasks.flatMap((t, i) => (t.isSkipped ? [i] : []));
  const labelColumns = Math.max(12, Math.min(32, Math.floor(columns * 0.28)));
  // dot 2, gap 2, stats + 4, buttons 5
  const width = columns - labelColumns - 13 - stats.length;
  const hasRoom = width >= Math.max(MIN_BAR_COLUMNS, pill.length + 6);
  // An automatic bar has no total: its bar is full and moving, with no ticks.
  const barDone = isCounter ? 1 : done;
  const barTotal = isCounter ? 1 : total;
  const taskMs = current?.status === "in_progress" && current.startedAt != null ? now - current.startedAt : null;
  return {
    id: track.id,
    label: track.label ?? track.tasks[0].subject,
    labelColumns,
    status,
    pill,
    percent,
    isCounter,
    done,
    total,
    barDone,
    barTotal,
    stats,
    workMs,
    waitMs,
    tokens,
    taskMs,
    isDemo: track.isDemo === true,
    isExpanded: track.isExpanded === true,
    tasks: track.tasks,
    track,
    reason: track.failedCommand ? shorten(track.failedReason ?? track.failedCommand, 60) : null,
    skipped,
    bar: hasRoom ? { key: `bar:${track.id}`, width, done: barDone, total: barTotal, status, pill, skipped: isCounter ? [] : skipped } : null,
  };
}

function draw({ Box, Text, Button, Raster }, row, actions, lines) {
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
  const line = Box({
    flexDirection: "row",
    children: [
      Text({ color: DOT[row.status], bold: isFailed, children: isFailed ? "! " : "● " }),
      Box({ width: row.labelColumns, children: [Text({ wrap: "truncate-end", children: row.label })] }),
      Text({ children: "  " }),
      middle,
      Text({ dimColor: true, children: `  ${row.stats}  ` }),
      Button({ key: `expand:${row.id}`, label: row.isExpanded ? "▾" : "▸", plain: true, dimColor: true, onPress: actions.toggle(row.id) }),
      Text({ children: " " }),
      Button({ key: `pane:${row.id}`, label: "☰", plain: true, dimColor: true, onPress: actions.pane }),
      Text({ children: " " }),
      Button({ key: `dismiss:${row.id}`, label: "✕", plain: true, dimColor: true, onPress: actions.dismiss(row.id) }),
    ],
  });
  if (!row.isExpanded || lines === 0) return Box({ key: row.id, children: [line] });
  const all = taskLinesOf(row.track);
  const shown = all.length <= lines ? all : [...all.slice(0, lines - 1), { text: `+${all.length - lines + 1} more`, isDim: true }];
  return Box({
    key: row.id,
    flexDirection: "column",
    children: [line, ...shown.map((l, i) => Text({ key: `${row.id}:${i}`, dimColor: l.isDim, children: `    ${l.text}` }))],
  });
}

// One line per task for an expanded terminal row: ✓ Build 1.2s, ▸ Test 40s ×2, ○ Ship.
function taskLinesOf(track) {
  const now = Date.now();
  return track.tasks.map((t) => {
    const mark = t.isSkipped ? "–" : t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○";
    const end = t.status === "completed" ? t.doneAt : t.status === "in_progress" ? now : null;
    const time = t.startedAt != null && end != null ? `  ${timeOf(end - t.startedAt)}` : "";
    const tries = t.failures ? ` ×${t.failures}` : "";
    return { text: `${mark} ${t.subject}${time}${tries}`, isDim: t.status !== "in_progress" };
  });
}

// The desktop band: every bar the same width, pinned right so rows line up.
// The desktop reports about 8 CSS px per column.
function drawDesktop({ Box, Text, Button, Svg }, tracks, props, { dismiss, toggle, pane }, ctx) {
  const rows = tracks.map((t) => rowOf(t, 200, ctx));
  const total = Math.max(320, (props.bodyColumns || 100) * 8);
  const titleWidth = Math.min(Math.round(total * 0.3), Math.max(...rows.map((r) => r.label.length * 6.4)));
  const width = Math.max(140, Math.min(1400, Math.round(total - titleWidth - 210)));
  return Box({
    flexDirection: "column",
    gap: 1,
    children: rows.map((r) => {
      const isMoving = ((props.isWorking || r.isDemo) && isLive(r.status)) || r.status === "done";
      const bar = Svg
        ? Svg({
            source: barSvg({ width, done: r.barDone, total: r.barTotal, status: r.status, pill: r.pill, isMoving, skipped: r.isCounter ? [] : r.skipped }),
            alt: `${r.label}: ${r.pill}, ${r.stats}${r.reason ? ` (${r.reason})` : ""}`,
            width,
            height: SVG_HEIGHT,
            isInteractive: isMoving || undefined,
          })
        : Text({ color: PILL[r.status].bg, children: r.pill });
      const line = Box({
        flexDirection: "row",
        alignItems: "center",
        gap: 1,
        children: [
          Text({ color: DOT[r.status], bold: r.status === "failed", children: r.status === "failed" ? "!" : "●" }),
          Text({ wrap: "truncate", children: r.label }),
          Box({ flexGrow: 1 }),
          bar,
          Box({
            flexShrink: 0,
            children: [Text({ dimColor: true, wrap: "truncate", children: r.stats })],
          }),
          Button({ key: `expand:${r.id}`, label: r.isExpanded ? "▼ Tasks" : "▶ Tasks", plain: true, onPress: toggle(r.id) }),
          Button({ key: `pane:${r.id}`, label: "☰", plain: true, dimColor: true, onPress: pane }),
          Button({ key: `dismiss:${r.id}`, label: "✕", plain: true, dimColor: true, onPress: dismiss(r.id) }),
        ].filter(Boolean),
      });
      if (!r.isExpanded) return Box({ key: r.id, children: [line] });
      return Box({
        key: r.id,
        flexDirection: "column",
        children: [
          line,
          ...timelineOf(r.track).map((entry, i, all) =>
            Box({
              key: `${r.id}:${i}`,
              flexDirection: "row",
              alignItems: "center",
              gap: 1,
              children: [
                Svg
                  ? Svg({
                      source: timelineSvg({ ...entry, isFirst: i === 0, isLast: i === all.length - 1, index: i, count: all.length }),
                      alt: entry.isAgent ? "sub-agent" : entry.pos === "main" ? "step" : "parallel step",
                      width: GUTTER_WIDTH,
                      height: ROW_HEIGHT,
                      isInteractive: true,
                    })
                  : Text({ color: entry.isAgent ? DOT.working : DOT.done, children: entry.pos === "main" ? " ●" : " ┆●" }),
                Text({ wrap: "truncate", dimColor: entry.isSkipped || entry.status === "pending", children: entry.subject }),
                entry.note ? Text({ dimColor: true, wrap: "truncate", children: entry.note }) : null,
                Box({ flexGrow: 1 }),
                Text({ dimColor: true, children: entry.time }),
              ].filter(Boolean),
            }),
          ),
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
// The finished list as timeline rows: each task, then the sub-agents it ran on a branch.
// Steps whose run times overlap ran in parallel and share a branch too.
function timelineOf(track) {
  const rows = [];
  for (const task of track.tasks) {
    rows.push(entryOf(task));
    for (const run of track.agentRuns ?? []) {
      if (run.taskId === task.id) rows.push({ ...entryOf(run), isSubAgent: true });
    }
  }
  let i = 0;
  while (i < rows.length) {
    let j = i;
    if (rows[i].isSubAgent) {
      while (rows[j + 1]?.isSubAgent) j++;
    } else {
      let end = rows[i].doneAt ?? 0;
      while (rows[j + 1] && !rows[j + 1].isSubAgent && rows[j + 1].startedAt != null && rows[j + 1].startedAt < end) {
        j++;
        end = Math.max(end, rows[j].doneAt ?? 0);
      }
      if (j > i) rows[i].notes.push(`${j - i + 1} in parallel`);
    }
    if (j > i || rows[i].isSubAgent) {
      for (let k = i; k <= j; k++) rows[k].pos = i === j ? "only" : k === i ? "start" : k === j ? "end" : "middle";
    }
    i = j + 1;
  }
  return rows.map((row) => ({ ...row, note: row.notes.length > 0 ? `· ${row.notes.join(" · ")}` : null }));
}

function entryOf(item) {
  const agent = item.agent;
  const isTimed = item.startedAt != null && item.doneAt != null;
  const isRunning = item.status === "in_progress" && item.startedAt != null;
  const notes = agent ? [`${agent.type} agent`] : [];
  if (item.failures) notes.push(`failed ×${item.failures}`);
  return {
    subject: item.subject,
    status: item.status,
    startedAt: item.startedAt,
    doneAt: item.doneAt,
    pos: "main",
    isAgent: agent !== undefined,
    isSkipped: item.isSkipped === true,
    notes,
    time: agent?.isBackground
      ? "background"
      : isTimed
        ? timeOf(item.doneAt - item.startedAt)
        : isRunning
          ? `${timeOf(Date.now() - item.startedAt)} so far`
          : "—",
  };
}

// Tenths of a second below a minute: most tool calls take well under one.
function timeOf(ms) {
  return ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : durationOf(ms);
}

function durationOf(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function shorten(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---- the Progress pane ----


// Header (the current list), a strip of tab chips with counts, then the tab's entries:
// open items as bordered cards, older ones as quiet rows. Pressing an entry's title opens
// its details under it.
function drawPane(ui, { log, tab, track, ctx }, select) {
  const { Box } = ui;
  const counts = {
    blocked: log.blocks.filter((b) => b.answeredAt == null).length,
    found: log.findings.length,
  };
  const body = tab === "found" ? foundOf(ui, log) : blockedOf(ui, log);
  return Box({
    flexDirection: "column",
    paddingX: 1,
    children: [
      headerOf(ui, track, ctx),
      Box({ flexDirection: "row", gap: 1, marginTop: 1, marginBottom: 1, children: TABS.map((t) => tabChipOf(ui, t, t.id === tab, counts[t.id], select)) }),
      ...(body.length > 0 ? body : [emptyOf(ui, tab)]),
    ],
  });
}

// The current list, then its measured numbers as labelled tiles: progress, this task's
// time, work, wait, the list's tokens, and the session's context fill.
function headerOf(ui, track, ctx = {}) {
  const { Box, Text } = ui;
  const context = contextTileOf(ctx);
  if (!track) {
    return Box({
      flexDirection: "column",
      children: [Text({ dimColor: true, children: "No task list running." }), context ? tilesOf(ui, [context]) : null].filter(Boolean),
    });
  }
  const row = rowOf(track, 200, ctx);
  const pill = PILL[row.status];
  const tokens = row.tokens;
  const tiles = [
    row.percent != null
      ? { label: "PROGRESS", value: `${row.percent}%`, note: `${row.done} of ${row.total}` }
      : { label: "PROGRESS", value: `${row.done} ${row.done === 1 ? "step" : "steps"}`, note: "total unknown" },
    row.taskMs != null ? { label: "THIS TASK", value: durationOf(row.taskMs) } : null,
    { label: "WORKED", value: durationOf(row.workMs) },
    { label: "WAITED ON YOU", value: row.waitMs >= 1000 ? durationOf(row.waitMs) : "none" },
    tokens
      ? { label: "TOKENS IN", value: countOf(tokens.input), note: `${Math.round((tokens.cached / Math.max(1, tokens.input)) * 100)}% cached` }
      : null,
    tokens ? { label: "TOKENS OUT", value: countOf(tokens.output) } : null,
    tokens ? { label: "MODEL CALLS", value: String(tokens.calls) } : null,
    context,
  ].filter(Boolean);
  return Box({
    flexDirection: "column",
    children: [
      Box({
        flexDirection: "row",
        alignItems: "center",
        gap: 1,
        children: [
          Text({ color: DOT[row.status], children: row.status === "failed" ? "!" : "●" }),
          Text({ bold: true, wrap: "truncate", children: row.label }),
          Box({ flexGrow: 1 }),
          Text({ color: pill.fg, backgroundColor: pill.bg, bold: true, children: ` ${row.pill} ` }),
        ],
      }),
      tilesOf(ui, tiles),
    ],
  });
}

// The context fill as a tile, amber from 80%, when the engine reports it.
function contextTileOf(ctx) {
  if (ctx.contextPercent == null) return null;
  return { label: "CONTEXT", value: `${ctx.contextPercent}%`, color: ctx.contextPercent >= 80 ? DOT.waiting : undefined };
}

// Stat tiles in a row that wraps on a narrow pane: a dim label over a bold value, with an
// optional dim note beside the value.
function tilesOf({ Box, Text }, tiles) {
  return Box({
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 3,
    rowGap: 1,
    marginTop: 1,
    children: tiles.map((tile) =>
      Box({
        key: `tile:${tile.label}`,
        flexDirection: "column",
        flexShrink: 0,
        children: [
          Text({ dimColor: true, children: tile.label }),
          Box({
            flexDirection: "row",
            gap: 1,
            children: [
              Text({ bold: true, color: tile.color, children: tile.value }),
              tile.note ? Text({ dimColor: true, children: tile.note }) : null,
            ].filter(Boolean),
          }),
        ],
      }),
    ),
  });
}

// Each tab is the surface's own button, so its border, hover and focus cover the whole tab.
// A bordered Box around a Button pads it, and the hover highlight never reaches the border.
function tabChipOf({ Button }, t, isSelected, count, select) {
  return Button({
    key: `tab:${t.id}`,
    label: `${t.label}  ${count}`,
    hotkey: t.hotkey,
    variant: isSelected ? "primary" : "secondary",
    dimColor: !isSelected,
    onPress: select(t.id),
  });
}

// An entry's title: a button that opens or closes its details.
function titleOf({ Button, openId, toggle }, id, text, { isDim = false } = {}) {
  const isOpen = openId === id;
  return Button({
    key: `more:${id}`,
    label: `${isOpen ? "▾" : "▸"} ${shorten(text, 90)}`,
    plain: true,
    dimColor: isDim && !isOpen,
    hover: { underline: true },
    onPress: toggle(id),
  });
}

// The open entry's details: one row per fact, label on the left; output lines indented.
function detailsOf({ Box, Text }, id, rows) {
  return Box({
    key: `details:${id}`,
    flexDirection: "column",
    marginTop: 1,
    marginLeft: 2,
    children: rows.map((row, i) =>
      row.isOutput
        ? Text({ key: `${id}:${i}`, wrap: "truncate", children: `│ ${row.value}` })
        : Box({
            key: `${id}:${i}`,
            flexDirection: "row",
            gap: 1,
            children: [
              Box({ width: 12, flexShrink: 0, children: [Text({ dimColor: true, children: row.label })] }),
              Text({ wrap: "wrap", children: row.value }),
            ],
          }),
    ),
  });
}

// What an entry's details say, from what the log recorded. Older entries may lack some.
function detailRowsOf(entry) {
  const rows = [];
  const add = (label, value) => value != null && value !== "" && rows.push({ label, value: String(value) });
  const d = entry.details ?? {};
  if (entry.kind === "question") {
    for (const q of d.questions ?? [{ question: entry.text, options: [] }]) {
      add("Question", q.question);
      if (q.options?.length) add("Options", q.options.join(" · "));
      add("Your answer", entry.answers?.[q.question] ?? (entry.answeredAt == null ? "Waiting for you" : "Not recorded"));
    }
  } else if (entry.kind === "permission") {
    add("Tool", d.tool);
    add("Asked to", d.request ?? entry.text);
    add("Result", entry.outcome ?? (entry.answeredAt == null ? "Waiting for you" : null));
  } else if (entry.kind === "approval") {
    add("Plan", d.plan);
    if (d.steps) add("Steps", d.steps);
    add("Answer", entry.outcome ?? (entry.answeredAt == null ? "Waiting for you" : null));
  } else if (entry.kind === "failed") {
    add("Check", entry.command ?? entry.text);
    for (const line of entry.lines ?? []) rows.push({ isOutput: true, value: line });
  } else {
    add("Finding", entry.text);
  }
  add("Task", entry.task);
  if (entry.answeredAt != null) add("Waited", durationOf(entry.answeredAt - entry.at));
  add("At", clockOf(entry.at));
  return rows;
}

// Old entries saved before ids existed get one from their kind and time.
function idOf(entry) {
  return entry.id ?? `${entry.kind}-${entry.at}`;
}

// A card: coloured border, a bold first line with the time on the right, a quiet second line.
function cardOf(ui, key, { mark, color, title, time, detail, entry }) {
  const { Box, Text } = ui;
  const id = idOf(entry);
  return Box({
    key,
    flexDirection: "column",
    borderStyle: "round",
    borderColor: color,
    paddingX: 1,
    marginTop: 1,
    children: [
      Box({
        flexDirection: "row",
        gap: 1,
        children: [
          Text({ color, bold: true, children: mark }),
          titleOf(ui, id, title),
          Box({ flexGrow: 1 }),
          Text({ dimColor: true, children: time }),
        ],
      }),
      detail ? Text({ dimColor: true, wrap: "truncate", children: `  ${detail}` }) : null,
      ui.openId === id ? detailsOf(ui, id, detailRowsOf(entry)) : null,
    ].filter(Boolean),
  });
}

// A quiet row for answered, older or plain entries.
function lineOf(ui, key, { mark, color, title, note, time, isDim, entry }) {
  const { Box, Text } = ui;
  const id = idOf(entry);
  const line = Box({
    flexDirection: "row",
    gap: 1,
    paddingX: 1,
    children: [
      Text({ color, dimColor: isDim, children: mark }),
      titleOf(ui, id, title, { isDim }),
      note ? Text({ dimColor: true, wrap: "truncate", children: note }) : null,
      Box({ flexGrow: 1 }),
      Text({ dimColor: true, children: time }),
    ].filter(Boolean),
  });
  if (ui.openId !== id) return Box({ key, children: [line] });
  return Box({ key, flexDirection: "column", marginBottom: 1, children: [line, detailsOf(ui, id, detailRowsOf(entry))] });
}

function sectionOf({ Text }, key, title) {
  return Text({ key, dimColor: true, bold: true, children: title });
}

const BLOCK_KIND = { permission: "Permission", question: "Question", approval: "Plan approval" };

// Waiting now as cards, then the answered ones as quiet rows; newest first.
function blockedOf(ui, log) {
  const open = log.blocks.filter((b) => b.answeredAt == null).reverse();
  const answered = log.blocks.filter((b) => b.answeredAt != null).reverse();
  const now = Date.now();
  const out = [];
  if (open.length > 0) {
    out.push(sectionOf(ui, "s:open", "WAITING NOW"));
    open.forEach((b, i) =>
      out.push(
        cardOf(ui, `open:${i}`, {
          mark: "●",
          color: DOT.waiting,
          title: b.text,
          time: clockOf(b.at),
          entry: b,
          detail: [BLOCK_KIND[b.kind], b.task, `waiting ${durationOf(now - b.at)}`].filter(Boolean).join(" · "),
        }),
      ),
    );
  }
  if (answered.length > 0) {
    out.push(sectionOf(ui, "s:answered", open.length > 0 ? " ANSWERED" : "ANSWERED"));
    answered.forEach((b, i) =>
      out.push(
        lineOf(ui, `done:${i}`, {
          mark: "✓",
          color: DOT.done,
          title: b.text,
          note: `· waited ${durationOf(b.answeredAt - b.at)}${b.task ? ` · ${b.task}` : ""}`,
          time: clockOf(b.at),
          isDim: true,
          entry: b,
        }),
      ),
    );
  }
  return out;
}

// Newest first, each as a card: red for a failing check, purple for a finding.
function foundOf(ui, log) {
  return [...log.findings].reverse().map((f, i) =>
    cardOf(ui, `found:${i}`, {
      mark: f.kind === "failed" ? "✕" : "◆",
      color: f.kind === "failed" ? DOT.failed : DOT.working,
      title: f.text,
      time: clockOf(f.at),
      entry: f,
      detail: [f.kind === "failed" ? "Check failed" : "Finding", f.task].filter(Boolean).join(" · "),
    }),
  );
}

const EMPTY = {
  blocked: ["✓", DOT.done, "Nothing waits on you.", "Permission prompts, questions and plan approvals show up here."],
  found: ["◆", DOT.working, "Nothing found yet.", "Failing checks and Claude's findings show up here."],
};

function emptyOf({ Box, Text }, tab) {
  const [mark, color, title, hint] = EMPTY[tab] ?? EMPTY.blocked;
  return Box({
    key: "empty",
    flexDirection: "column",
    marginTop: 1,
    paddingX: 1,
    children: [
      Box({ flexDirection: "row", gap: 1, children: [Text({ color, bold: true, children: mark }), Text({ bold: true, children: title })] }),
      Text({ dimColor: true, children: `  ${hint}` }),
    ],
  });
}

function clockOf(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

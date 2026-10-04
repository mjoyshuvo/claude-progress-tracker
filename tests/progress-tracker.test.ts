import { describe, expect, mock, test } from "claude-code/testing";
import { timeLeftOf } from "../hooks/progress-tracker.mjs";

const BAND = {
  surface: "terminal",
  component: "AbovePrompt",
  requestId: "band",
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as any;

// Decodes a Raster's base64 [codePoint, fg, bg] u32 triplets to its glyphs.
function rasterText(cells: string): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  for (let i = 0; i < cells.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, ALPHABET.indexOf(cells[i + k] ?? "=")), 0);
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  let text = "";
  for (let i = 0; i + 3 < bytes.length; i += 12) {
    text += String.fromCodePoint(bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16));
  }
  return text;
}

const kidsOf = (node: any): any[] => [node?.props?.children ?? node?.children ?? []].flat();

// Flattens a render tree to its text, one line per column Box child.
function textOf(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node.type === "Button") return node.props?.label ?? node.label ?? "";
  if (node.type === "Svg") return node.props?.alt ?? node.alt ?? "";
  if (node.type === "Raster") return rasterText(node.props?.cells ?? node.cells ?? "");
  const kids = kidsOf(node).map(textOf);
  const isColumn = (node.props?.flexDirection ?? node.flexDirection) === "column";
  return isColumn ? kids.join("\n") : kids.join("");
}

function svgsOf(node: any): any[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(svgsOf);
  if (node.type === "Svg") return [node.props ?? node];
  return kidsOf(node).flatMap(svgsOf);
}

function keysOf(node: any): string[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(keysOf);
  if (node.type === "Button") return [node.props?.key ?? node.key];
  return kidsOf(node).flatMap(keysOf);
}

function world(on: any) {
  let nextId = 1;
  const clock = mock.clock(on);
  on("session.start", ($: any, e: any) => ({ cwd: e.cwd }));
  on("tool.register", ($: any, e: any) => ({ value: { tool: `mcp__progress-tracker__${e.name}` } }));
  on("command.register", ($: any, e: any) => ({ value: { command: e.name } }));
  on("classic.UserPromptSubmit", () => ({}));
  on("tool.call", ($: any, e: any) => {
    if (e.tool === "TaskCreate") return { result: { task: { id: String(nextId++), subject: e.subject } } };
    if (e.tool === "Bash" && e.command === "npm test" && failing.value) {
      return { result: { stdout: "", stderr: "1 failed", interrupted: false }, isError: true };
    }
    return { result: {} };
  });
  const failing = { value: false };
  return { failing, clock };
}

async function tasks($: any, subjects: string[]) {
  for (const subject of subjects) {
    await $.tool.call({ tool: "TaskCreate", subject, description: subject });
  }
}

describe("progress-tracker", () => {
  test("draws nothing until there are tasks", async ($, on) => {
    world(on);
    on("ui.render", () => ({ type: "Box", props: { children: [] } }));
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    expect(textOf(await $.ui.render(BAND))).toBe("");
  });

  test("shows the step, the percent and the plan title", async ($, on) => {
    world(on);
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    await $.tool.call({ tool: "ExitPlanMode", plan: "# Release pipeline\n\n1. Build\n2. Verify" } as any);
    await tasks($, ["Build", "Lint", "Test", "Package", "Ship"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" } as any);
    await $.tool.call({ tool: "TaskUpdate", taskId: "2", status: "completed" } as any);
    await $.tool.call({ tool: "TaskUpdate", taskId: "3", status: "in_progress" } as any);

    const drawn = textOf(await $.ui.render(BAND));
    expect(drawn).toContain("Release pipeline");
    expect(drawn).toContain("Test 3/5");
    expect(drawn).toContain(" 40%");
    expect(drawn).toContain("✕");
  });

  test("a failing command turns the row red until it passes", async ($, on) => {
    const { failing } = world(on);
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    await tasks($, ["Verify build", "Ship"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "in_progress" } as any);

    failing.value = true;
    await $.tool.call({ tool: "Bash", command: "npm test" } as any);
    let drawn = textOf(await $.ui.render(BAND));
    expect(drawn).toContain("! ");
    expect(drawn).toContain("✕ Verify build 1/2");

    failing.value = false;
    await $.tool.call({ tool: "Bash", command: "npm test" } as any);
    drawn = textOf(await $.ui.render(BAND));
    expect(drawn).toContain("Verify build 1/2");
  });

  test("new tasks after a finished list start a second row", async ($, on) => {
    world(on);
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    await tasks($, ["First"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" } as any);
    await tasks($, ["Second", "Third"]);

    const lines = textOf(await $.ui.render(BAND)).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("✓ Done 1/1");
    expect(lines[0]).toContain("100%");
    expect(lines[1]).toContain("Second 1/2");
  });

  test("a working bar repaints itself, an idle one holds still", async ($, on) => {
    const { clock } = world(on);
    const blits: string[] = [];
    on("ui.blit", ($: any, e: any) => {
      blits.push(e.cells);
      return { value: {} };
    });
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    await tasks($, ["Build", "Lint", "Ship"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" } as any);

    await $.ui.render(BAND);
    await clock.advance(66 * 3);
    expect(blits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(blits).size).toBeGreaterThan(1);

    await $.ui.render({ ...BAND, props: { ...BAND.props, isWorking: false } });
    const before = blits.length;
    await clock.advance(66 * 3);
    expect(blits.length).toBe(before);
  });

  test("the ✕ button dismisses a row", async ($, on) => {
    world(on);
    on("ui.render", () => ({ type: "Box", props: { children: [] } }));
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    await tasks($, ["Only"]);

    const [key] = keysOf(await $.ui.render(BAND));
    await $.ui.press({ plugin: "progress-tracker", key } as any);
    expect(textOf(await $.ui.render(BAND))).toBe("");
  });
  test("a finished desktop bar expands to show each task's tokens", async ($, on) => {
    world(on);
    const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "m" };
    on("turn.step", async function* (_$: any, e: any) {
      return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage };
    });
    const DESK = { ...BAND, surface: "desktop" } as any;
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    await tasks($, ["Build", "Ship"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "in_progress" } as any);
    const step = $.turn.step({ turnId: "t", index: 0, model: "m", messageCount: 1 } as any);
    for await (const _ of step);
    await step.result;
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" } as any);
    await $.tool.call({ tool: "TaskUpdate", taskId: "2", status: "completed" } as any);

    const key = keysOf(await $.ui.render(DESK)).find((k: string) => k.startsWith("expand:"));
    await $.ui.press({ plugin: "progress-tracker", key } as any);
    const text = textOf(await $.ui.render(DESK));
    expect(text).toContain("Build");
    expect(text).toContain("1.5k tokens");
  });
  test("on desktop an SVG draws the bar, moving only while working", async ($, on) => {
    world(on);
    const DESK = { ...BAND, surface: "desktop" } as any;
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    await tasks($, ["Build", "Lint", "Ship"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" } as any);

    let [svg] = svgsOf(await $.ui.render(DESK));
    expect(svg.alt).toContain("Lint 2/3");
    expect(svg.source).toContain("<animate");
    expect(svg.isInteractive).toBe(true);
    expect(svg.source.length).toBeLessThan(131072);

    [svg] = svgsOf(await $.ui.render({ ...DESK, props: { ...DESK.props, isWorking: false } }));
    expect(svg.source).not.toContain("<animate");
  });
  test("the progress_tracker tool drives the bar where no task tools exist", async ($, on) => {
    world(on);
    const TOOL = "mcp__progress-tracker__progress_tracker";
    const DESK = { ...BAND, surface: "desktop" } as any;
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);

    const created: any = await $.tool.call({ tool: TOOL, title: "Ship docs", tasks: ["Draft", "Review", "Publish"] } as any);
    expect(created.result).toBe('0/3, running, active "Draft", next "Review"');
    expect(textOf(await $.ui.render(DESK))).toContain("Ship docs: Draft 1/3, 0%");

    await $.tool.call({ tool: TOOL, next: true } as any);
    await $.tool.call({ tool: TOOL, failed: "lint errors" } as any);
    expect(textOf(await $.ui.render(DESK))).toContain("✕ Review 2/3");

    const fixed: any = await $.tool.call({ tool: TOOL, fixed: true } as any);
    expect(fixed.result).toBe('1/3, running, active "Review", next "Publish"');
    await $.tool.call({ tool: TOOL, next: true } as any);
    const last: any = await $.tool.call({ tool: TOOL, next: true } as any);
    expect(last.result).toBe("3/3, done");
  });
  test("the progress_tracker tool is always loaded", async ($, on) => {
    world(on);
    on("tool.describe", (_$: any, e: any) => ({ description: e.description, isDeferred: true }));
    const described: any = await $.tool.describe({ tool: "mcp__progress-tracker__progress_tracker", description: "d" } as any);
    expect(described.isDeferred).toBe(false);
  });
  test("/progress-tracker-demo plays a run that fails, recovers, finishes and clears", async ($, on) => {
    const { clock } = world(on);
    on("ui.blit", () => ({ value: {} }));
    on("ui.render", () => ({ type: "Box", props: { children: [] } }));
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);

    const { text } = await $.command.run({ command: "progress-tracker-demo", args: "", origin: { kind: "composer" } } as any);
    expect(text).toContain("demo");
    expect(textOf(await $.ui.render(BAND))).toContain("Demo: ship a feature");
    expect(textOf(await $.ui.render(BAND))).toContain("Plan 1/5");

    await clock.advance(1400 + 1400 + 1200);
    expect(textOf(await $.ui.render(BAND))).toContain("✕ Test 3/5");

    await clock.advance(2200 + 900 + 1400 + 1400);
    expect(textOf(await $.ui.render(BAND))).toContain("✓ Done 5/5");

    await clock.advance(3500);
    expect(textOf(await $.ui.render(BAND))).toBe("");
  });
  test("plan mode shows Planning, waits amber, finishes green, and the plan gets its own bar", async ($, on) => {
    const PLAN = "# Add dark mode\n\n1. Add theme tokens\n2. Wire the toggle\n3. Test both themes";
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    on("tool.call", { tool: "ExitPlanMode" }, async () => {
      await held;
      return { result: { plan: PLAN } };
    });
    world(on);
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    const DESK = { ...BAND, surface: "desktop" } as any;

    await $.classic.UserPromptSubmit({ prompt: "plan dark mode", permission_mode: "plan" } as any);
    let drawn = textOf(await $.ui.render(DESK));
    expect(drawn).toContain("Planning");
    expect(drawn).toContain("Explore 1/2");

    const asking = $.tool.call({ tool: "ExitPlanMode", plan: PLAN } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(await $.ui.render(DESK))).toContain("Waiting for approval");

    release();
    await asking;
    let lines = textOf(await $.ui.render(DESK)).split("\n").filter(Boolean);
    expect(lines[0]).toContain("Planning: ✓ Done");
    expect(lines[1]).toContain("Add dark mode: Add theme tokens 1/3");

    const TOOL = "mcp__progress-tracker__progress_tracker";
    await $.tool.call({ tool: TOOL, title: "x", tasks: ["Tokens", "Toggle", "Test"] } as any);
    lines = textOf(await $.ui.render(DESK)).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Add dark mode: Tokens 1/3");
  });

  test("a rejected plan still finishes the planning bar", async ($, on) => {
    on("tool.call", { tool: "ExitPlanMode" }, () => ({ deny: "not yet" }));
    world(on);
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    const DESK = { ...BAND, surface: "desktop" } as any;
    await $.classic.UserPromptSubmit({ prompt: "plan", permission_mode: "plan" } as any);
    await $.tool.call({ tool: "ExitPlanMode", plan: "1. a" } as any);
    const lines = textOf(await $.ui.render(DESK)).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Planning: ✓ Done");
  });

  test("in plan mode each tool call becomes a step, until Claude sends its own list", async ($, on) => {
    world(on);
    const DESK = { ...BAND, surface: "desktop" } as any;
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    await $.classic.UserPromptSubmit({ prompt: "plan", permission_mode: "plan" } as any);
    await $.tool.call({ tool: "Bash", command: "grep -r x .", description: "Find plugin files" } as any);
    await $.tool.call({ tool: "Read", file_path: "/a/b/source.mjs" } as any);
    expect(textOf(await $.ui.render(DESK))).toContain("Planning: Explore 3/4, 50%");
    await $.tool.call({ tool: "Write", file_path: "/plans/plan.md", content: "x" } as any);
    expect(textOf(await $.ui.render(DESK))).toContain("Write plan 4/5");

    const TOOL = "mcp__progress-tracker__progress_tracker";
    await $.tool.call({ tool: TOOL, title: "Plan the fix", tasks: ["Read code", "Write plan"] } as any);
    await $.tool.call({ tool: "Read", file_path: "/a/c.mjs" } as any);
    const lines = textOf(await $.ui.render(DESK)).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Plan the fix: Read code 1/2");
  });

  test("add appends found work and skip closes the current task", async ($, on) => {
    world(on);
    const TOOL = "mcp__progress-tracker__progress_tracker";
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    await $.tool.call({ tool: TOOL, title: "Job", tasks: ["One", "Two"] } as any);
    const added: any = await $.tool.call({ tool: TOOL, add: ["Three"] } as any);
    expect(added.result).toBe('0/3, running, active "One", next "Two"');
    const skipped: any = await $.tool.call({ tool: TOOL, skip: true } as any);
    expect(skipped.result).toBe('1/3, running, active "Two", next "Three"');
  });

  test("a question to the person turns the bar amber until it is answered", async ($, on) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    on("tool.call", { tool: "AskUserQuestion" }, async () => {
      await held;
      return { result: {} };
    });
    world(on);
    const DESK = { ...BAND, surface: "desktop" } as any;
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    await $.tool.call({ tool: "mcp__progress-tracker__progress_tracker", title: "Job", tasks: ["One", "Two"] } as any);
    const asking = $.tool.call({ tool: "AskUserQuestion", questions: [] } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(textOf(await $.ui.render(DESK))).toContain("Waiting for you");
    release();
    await asking;
    expect(textOf(await $.ui.render(DESK))).toContain("One 1/2");
  });

  test("time left is the mean finished-task time times the tasks left, from two timed tasks", () => {
    const done = (min: number) => ({ id: "x", subject: "x", status: "completed", startedAt: 0, doneAt: min * 60_000 });
    const open = { id: "y", subject: "y", status: "pending" };
    expect(timeLeftOf([done(1), open, open] as any)).toBe("");
    expect(timeLeftOf([done(1), done(2), open, open] as any)).toBe("~3m left");
    expect(timeLeftOf([done(1), done(2)] as any)).toBe("");
  });

  test("a long run of work with no bar update gets one quiet nudge", async ($, on) => {
    world(on);
    const TOOL = "mcp__progress-tracker__progress_tracker";
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    await $.tool.call({ tool: TOOL, title: "Job", tasks: ["One", "Two"] } as any);
    const results: any[] = [];
    for (let i = 0; i < 12; i++) results.push(await $.tool.call({ tool: "Read", file_path: `/f${i}` } as any));
    expect(results.slice(0, 11).every((r) => !r.context)).toBe(true);
    expect(results[11].context.join("")).toContain('"One"');
    await $.tool.call({ tool: TOOL, next: true } as any);
    const after: any = await $.tool.call({ tool: "Read", file_path: "/g" } as any);
    expect(after.context).toBeUndefined();
  });

  test("a failing check shows its error line, and only real checks count", async ($, on) => {
    on("tool.call", { tool: "Bash" }, () => ({ result: { stdout: "collected 3\nFAILED tests/a.py::t - boom\n" }, isError: true }));
    world(on);
    const DESK = { ...BAND, surface: "desktop" } as any;
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    await $.tool.call({ tool: "mcp__progress-tracker__progress_tracker", title: "Job", tasks: ["Fix", "Ship"] } as any);
    for (const command of ["go run main.go", "git checkout main", "npm run dev", "test -f x"]) {
      await $.tool.call({ tool: "Bash", command } as any);
    }
    expect(textOf(await $.ui.render(DESK))).not.toContain("✕ Fix");
    await $.tool.call({ tool: "Bash", command: "FOO=1 .venv/bin/pytest tests -x" } as any);
    expect(textOf(await $.ui.render(DESK))).toContain("(FAILED tests/a.py::t - boom)");
  });
  test("a non-check command that exits 1 does not turn the row red", async ($, on) => {
    on("tool.call", { tool: "Bash" }, () => ({ result: {}, isError: true }));
    world(on);
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    await tasks($, ["Find usages", "Ship"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "in_progress" } as any);
    await $.tool.call({ tool: "Bash", command: "grep -rn foo src" } as any);
    expect(textOf(await $.ui.render(BAND))).not.toContain("! ");
    await $.tool.call({ tool: "Bash", command: "cd app && npm test" } as any);
    expect(textOf(await $.ui.render(BAND))).toContain("! ");
  });

  test("a re-run of the same check with other flags clears the red", async ($, on) => {
    let fail = true;
    on("tool.call", { tool: "Bash" }, () => (fail ? { result: {}, isError: true } : { result: {} }));
    world(on);
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    await tasks($, ["Verify", "Ship"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "in_progress" } as any);
    await $.tool.call({ tool: "Bash", command: "pytest tests/ -x" } as any);
    expect(textOf(await $.ui.render(BAND))).toContain("! ");
    fail = false;
    await $.tool.call({ tool: "Bash", command: "pytest tests/ -q --lf" } as any);
    expect(textOf(await $.ui.render(BAND))).not.toContain("! ");
  });

  test("an approved plan takes its steps, not its verification list", async ($, on) => {
    world(on);
    const DESK = { ...BAND, surface: "desktop" } as any;
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    const PLAN = "# Fix login\n\n## Context\n1. Users get logged out\n\n## Steps\n1. Read the token code\n2. Fix expiry\n\n## Verification\n1. Run the auth tests\n2. Log in by hand";
    await $.tool.call({ tool: "ExitPlanMode", plan: PLAN } as any);
    const drawn = textOf(await $.ui.render(DESK));
    expect(drawn).toContain("Fix login: Read the token co… 1/2");
  });

  test("active matches part of a name, and an unknown name is refused", async ($, on) => {
    world(on);
    const TOOL = "mcp__progress-tracker__progress_tracker";
    await $.session.start({ surface: "desktop", cwd: "/work" } as any);
    await $.tool.call({ tool: TOOL, title: "Job", tasks: ["Write the parser", "Write tests", "Ship"] } as any);
    const moved: any = await $.tool.call({ tool: TOOL, active: "tests" } as any);
    expect(moved.result).toBe('1/3, running, active "Write tests", next "Ship"');
    const missing: any = await $.tool.call({ tool: TOOL, active: "deploy" } as any);
    expect(missing.deny).toContain('no task named "deploy"');
  });

  test("a finished bar hides itself after a minute", async ($, on) => {
    const { clock } = world(on);
    on("ui.render", () => ({ type: "Box", props: { children: [] } }));
    await $.session.start({ surface: "terminal", cwd: "/work" } as any);
    await tasks($, ["Only"]);
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" } as any);
    expect(textOf(await $.ui.render(BAND))).toContain("✓ Done 1/1");
    await clock.advance(60_000);
    expect(textOf(await $.ui.render(BAND))).toBe("");
  });
});

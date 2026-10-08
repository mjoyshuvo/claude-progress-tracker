export type ProgressTask = {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  startedAt?: number | null;
  doneAt?: number | null;
  isSkipped?: boolean;
  tokens?: number;
  failures?: number;
};

export type ProgressTrack = {
  id: string;
  label: string | null;
  tasks: ProgressTask[];
  failedCommand: string | null;
  failedRuns?: number;
  isDismissed: boolean;
  isWaiting?: boolean;
  isExpanded?: boolean;
  // An automatic bar (Working, Planning): it counts steps, its total unknown.
  isCounter?: boolean;
  // Measured time: turns that overlapped the track, and waits on the person.
  turnMs?: number;
  waitMs?: number;
  waitingSince?: number | null;
  // Tokens the API reported for the model calls made while the track ran. input counts
  // every prompt token read (uncached, cache reads and cache writes); cached is the reads.
  tokens?: { input: number; cached: number; output: number; calls: number };
};

// The Progress pane's log: what waited on the person, and findings.
export type ProgressBlock = {
  id?: string;
  kind: "permission" | "question" | "approval";
  text: string;
  task: string | null;
  at: number;
  answeredAt: number | null;
  toolUseId?: string | null;
  // How it ended: the call's outcome, the plan's answer, or whether a question was answered.
  outcome?: string;
  // A question's answers, keyed by the question's text.
  answers?: Record<string, string> | null;
  details?: {
    tool?: string;
    request?: string;
    questions?: { question: string; options: string[] }[];
    plan?: string;
    steps?: number;
  } | null;
  isDemo?: boolean;
};

export type ProgressFinding = {
  id?: string;
  kind: "found" | "failed";
  text: string;
  task: string | null;
  at: number;
  toolUseId?: string | null;
  // A failing check: its command and the output lines that name the problem.
  command?: string;
  lines?: string[];
  isDemo?: boolean;
};

export type ProgressLog = { blocks: ProgressBlock[]; findings: ProgressFinding[] };

declare module "claude-code" {
  interface PluginState {
    "progress-tracker": {
      tracks: ProgressTrack[];
      log: ProgressLog;
      tab: "blocked" | "found";
      turn: number | null;
      open: string | null;
    };
  }
}

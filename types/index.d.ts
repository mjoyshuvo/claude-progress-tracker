export type ProgressTask = {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
};

export type ProgressTrack = {
  id: string;
  label: string | null;
  tasks: ProgressTask[];
  failedCommand: string | null;
  isDismissed: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "progress-tracker": { tracks: ProgressTrack[] };
  }
}

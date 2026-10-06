export const PLATFORMS = ["chatgpt", "gemini", "claude"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(v: string): v is Platform {
  return (PLATFORMS as readonly string[]).includes(v);
}

export type JobStatus = "queued" | "claimed" | "completed" | "failed";
export type ResultStatus = "pending" | "completed" | "failed";
export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface ClaimedJob {
  id: string;
  runId: string;
  promptId: string;
  platform: Platform;
  sampleIndex: number;
  attempts: number;
  maxAttempts: number;
  promptText: string;
}

export interface ScrapeOutput {
  text: string;
  modelVersion: string | null;
}

/// Google Search is a surface in Gary's grid but a different kind of scrape:
/// it reports AI Overview presence and organic rank rather than a chat answer.
export const PLATFORMS = ["chatgpt", "gemini", "claude", "google"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(v: string): v is Platform {
  return (PLATFORMS as readonly string[]).includes(v);
}

/// How each platform appears in the "Surfaces & runs" column of Sheet 1.
export const SURFACE_LABELS: Record<Platform, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  google: "Google Search",
};

export type JobStatus = "queued" | "claimed" | "completed" | "failed";
export type ResultStatus = "pending" | "completed" | "failed";
export type AuditStatus = "pending" | "running" | "completed" | "failed";

export interface ClaimedJob {
  id: string;
  auditId: string;
  promptId: string;
  resultId: string;
  platform: Platform;
  runNumber: number;
  attempts: number;
  maxAttempts: number;
  promptText: string;
}

export interface ScrapeOutput {
  text: string;
  modelVersion: string | null;
  /// Conversation or SERP URL, recorded as proof in the grid.
  resultUrl?: string | null;
  screenshotPath?: string | null;
  /// Google Search only — the chat platforms leave these undefined.
  aiOverviewPresent?: boolean;
  brandOrganicRank?: number | null;
}

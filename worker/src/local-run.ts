import { randomUUID } from "node:crypto";
import type { BrowserContext } from "playwright";
import type { ScrapeOutput } from "./types.js";

export const CHAT_PLATFORMS = ["chatgpt", "gemini", "claude"] as const;
export type ChatPlatform = typeof CHAT_PLATFORMS[number];
export interface LocalResult {
  promptId: string;
  prompt: string;
  platform: ChatPlatform;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  output: ScrapeOutput | null;
  error: string | null;
}
export interface LocalRun {
  version: 1;
  id: string;
  createdAt: string;
  results: LocalResult[];
}

export function createRun(prompts: string[], platforms: ChatPlatform[]): LocalRun {
  if (!prompts.length || prompts.some((p) => !p.trim())) throw new Error("At least one nonempty prompt is required.");
  if (!platforms.length || new Set(platforms).size !== platforms.length || platforms.some((p) => !CHAT_PLATFORMS.includes(p))) {
    throw new Error("Select chatgpt, gemini, claude, or all.");
  }
  return {
    version: 1, id: `DISCO-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    results: prompts.flatMap((prompt, i) => platforms.map((platform) => ({
      promptId: `PROMPT-${String(i + 1).padStart(4, "0")}`, prompt, platform,
      status: "pending", startedAt: null, finishedAt: null, output: null, error: null,
    }))),
  };
}

// These flags take effect between prompt rounds; in-flight captures always finish.
export class RunControl {
  paused = false;
  stopped = false;
  async ready(): Promise<boolean> {
    while (this.paused && !this.stopped) await new Promise((r) => setTimeout(r, 100));
    return !this.stopped;
  }
  async gap(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (!this.stopped && !this.paused && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())));
    }
  }
}

export interface RunDependencies {
  launch: (platform: ChatPlatform) => Promise<BrowserContext>;
  scrape: Record<ChatPlatform, (context: BrowserContext, prompt: string) => Promise<ScrapeOutput>>;
  save: (run: LocalRun) => void;
  update?: (result: LocalResult) => void;
  gapMs: () => number;
  promptBudget?: number;
}

export async function executeRun(run: LocalRun, control: RunControl, deps: RunDependencies): Promise<void> {
  const contexts = new Map<ChatPlatform, BrowserContext>();
  // A launch failure is held for this invocation, so subsequent rounds cannot
  // repeatedly launch a locked or unavailable profile.
  const launches = new Map<ChatPlatform, Promise<BrowserContext>>();
  let rounds = 0;
  try {
    for (const promptId of new Set(run.results.map((r) => r.promptId))) {
      const entries = run.results.filter((r) => r.promptId === promptId && r.status === "pending");
      if (!entries.length) continue;
      if (deps.promptBudget && rounds >= deps.promptBudget) break;
      if (!await control.ready()) break;
      const settled = await Promise.allSettled(entries.map(async (entry) => {
        entry.status = "running";
        entry.startedAt = new Date().toISOString();
        deps.save(run);
        deps.update?.(entry);
        try {
          let launched = launches.get(entry.platform);
          if (!launched) {
            launched = deps.launch(entry.platform).then((ctx) => {
              contexts.set(entry.platform, ctx);
              return ctx;
            });
            launches.set(entry.platform, launched);
          }
          const output = await deps.scrape[entry.platform](await launched, entry.prompt);
          if (!output.text.trim()) throw new Error("Empty response returned by platform.");
          entry.output = output;
          entry.error = null;
          entry.status = "completed";
        } catch (error) {
          entry.output = null;
          // Keep useful diagnostics without persisting credentials in URLs.
          entry.error = (error instanceof Error ? error.message : String(error))
            .replace(/https?:\/\/\S+/g, "[connection URL]").slice(0, 2000);
          entry.status = "failed";
          control.stopped = true;
        }
        entry.finishedAt = new Date().toISOString();
        // Persistence errors must fail the run, never masquerade as scrape errors.
        deps.save(run);
        deps.update?.(entry);
      }));
      const fatal = settled.find((r) => r.status === "rejected");
      if (fatal?.status === "rejected") throw fatal.reason;
      rounds++;
      if (run.results.some((r) => r.status === "pending") && !(deps.promptBudget && rounds >= deps.promptBudget)) {
        await control.gap(deps.gapMs());
      }
    }
  } finally {
    await Promise.allSettled([...contexts.values()].map((ctx) => ctx.close()));
  }
}

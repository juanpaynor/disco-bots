import type { BrowserContext } from "playwright";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { launchContext, sleep, jitter } from "./browser.js";
import { bots } from "./bots/index.js";
import { claimJob, completeJob, failJob, reclaimStaleJobs } from "./queue.js";
import { isPlatform, type Platform } from "./types.js";

let shuttingDown = false;

/**
 * One persistent context per platform, shared by all concurrent loops.
 * Chromium locks a user-data-dir, so launching the same profile twice fails —
 * concurrency has to come from multiple pages in one context, not multiple contexts.
 */
const contexts = new Map<Platform, BrowserContext>();

async function contextFor(platform: Platform): Promise<BrowserContext> {
  let ctx = contexts.get(platform);
  if (!ctx) {
    console.log(`[${config.workerId}] launching ${platform} profile`);
    ctx = await launchContext(platform);
    contexts.set(platform, ctx);
  }
  return ctx;
}

let consecutiveFailures = 0;
let promptsThisSession = 0;

async function runLoop(loopId: number): Promise<void> {
  while (!shuttingDown) {
    if (config.sessionBudget > 0 && promptsThisSession >= config.sessionBudget) {
      console.log(`[loop ${loopId}] session budget reached (${config.sessionBudget}) — stopping cleanly`);
      shuttingDown = true;
      break;
    }
    let job;
    try {
      job = await claimJob(config.workerId);
    } catch (err) {
      console.error(`[loop ${loopId}] claim failed:`, err);
      await sleep(config.pollIntervalMs);
      continue;
    }

    if (!job) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    if (!isPlatform(job.platform)) {
      await failJob(job, new Error(`unknown platform: ${job.platform}`));
      continue;
    }

    const label = `${job.platform} ${job.promptText.slice(0, 50)}…`;
    console.log(`[loop ${loopId}] claimed ${job.id} — ${label} (attempt ${job.attempts}/${job.maxAttempts})`);

    try {
      const ctx = await contextFor(job.platform);
      const output = await bots[job.platform](ctx, job.promptText);

      if (!output.text.trim()) throw new Error("empty response");

      await completeJob(job, output, config.workerId);
      consecutiveFailures = 0;
      promptsThisSession += 1;
      console.log(`[loop ${loopId}] done ${job.id} — ${output.text.length} chars (${promptsThisSession}/${config.sessionBudget || "∞"} this session)`);
    } catch (err) {
      console.error(`[loop ${loopId}] failed ${job.id}:`, err instanceof Error ? err.message : err);
      await failJob(job, err);
      promptsThisSession += 1;
      consecutiveFailures += 1;

      if (consecutiveFailures >= config.maxConsecutiveFailures) {
        console.error(
          `[loop ${loopId}] CIRCUIT BREAKER — ${consecutiveFailures} consecutive failures. ` +
          `Stopping rather than retrying into whatever is refusing us.`
        );
        shuttingDown = true;
        break;
      }
    }

    // Never fire prompts back-to-back at a fixed cadence.
    await jitter(config.gapMinMs, config.gapMaxMs);
  }
  console.log(`[loop ${loopId}] stopped`);
}

async function reclaimLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const n = await reclaimStaleJobs();
      if (n > 0) console.log(`[${config.workerId}] reclaimed ${n} stale job(s)`);
    } catch (err) {
      console.error("reclaim failed:", err);
    }
    await sleep(60_000);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${config.workerId}] ${signal} — finishing current jobs, then exiting`);

  // Give in-flight loops a moment to notice the flag and return their jobs cleanly.
  await sleep(2000);
  for (const ctx of contexts.values()) await ctx.close().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
}

async function main(): Promise<void> {
  console.log(`[${config.workerId}] starting — concurrency=${config.concurrency}, headless=${config.headless}`);
  console.log(`[${config.workerId}] profiles at ${config.profileDir}`);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await prisma.$queryRaw`SELECT 1`;
  console.log(`[${config.workerId}] database reachable`);

  void reclaimLoop();

  const loops = Array.from({ length: config.concurrency }, (_, i) => runLoop(i + 1));
  await Promise.all(loops);
}

main().catch(async (err) => {
  console.error("fatal:", err);
  await prisma.$disconnect();
  process.exit(1);
});

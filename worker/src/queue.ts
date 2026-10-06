import { Prisma } from "./generated/prisma/index.js";
import { prisma } from "./db.js";
import { config } from "./config.js";
import type { ClaimedJob, Platform } from "./types.js";

/**
 * Atomically claim one queued job.
 *
 * The whole concurrency story lives in this query. FOR UPDATE SKIP LOCKED lets N
 * workers hammer the same table without ever handing the same row to two of them
 * and without blocking each other — the losers skip locked rows instead of
 * queueing behind them. This is why there's no Redis in this stack.
 *
 * The UPDATE targets a single id chosen by the inner SELECT; the lock is taken
 * inside that subquery, so the row is reserved before we write to it.
 */
export async function claimJob(workerId: string): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<Array<{
    id: string;
    run_id: string;
    prompt_id: string;
    platform: string;
    sample_index: number;
    attempts: number;
    max_attempts: number;
    prompt_text: string;
  }>>(Prisma.sql`
    WITH claimed AS (
      UPDATE jobs
      SET status      = 'claimed',
          worker_id   = ${workerId},
          claimed_at  = NOW(),
          attempts    = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'queued'
          AND attempts < max_attempts
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, run_id, prompt_id, platform, sample_index, attempts, max_attempts
    )
    SELECT c.id, c.run_id, c.prompt_id, c.platform, c.sample_index,
           c.attempts, c.max_attempts, p.text AS prompt_text
    FROM claimed c
    JOIN prompts p ON p.id = c.prompt_id
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    runId: row.run_id,
    promptId: row.prompt_id,
    platform: row.platform as Platform,
    sampleIndex: row.sample_index,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    promptText: row.prompt_text,
  };
}

/**
 * Return jobs whose worker died mid-flight back to the queue.
 *
 * A worker that crashes (or gets OOM-killed, which Playwright makes likely)
 * leaves its job stuck in 'claimed' forever. Nothing else will ever pick it up,
 * so without this a run silently never finishes. Jobs that have burned all their
 * attempts go to 'failed' instead of looping.
 */
export async function reclaimStaleJobs(): Promise<number> {
  const result = await prisma.$executeRaw(Prisma.sql`
    UPDATE jobs
    SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        worker_id = NULL,
        last_error = COALESCE(last_error, 'reclaimed: worker went away mid-job')
    WHERE status = 'claimed'
      AND claimed_at < NOW() - make_interval(secs => ${config.staleJobSeconds}::int)
  `);
  return result;
}

/** Record a successful scrape and close out the job, in one transaction. */
export async function completeJob(
  job: ClaimedJob,
  output: { text: string; modelVersion: string | null },
  workerId: string
): Promise<void> {
  await prisma.$transaction([
    prisma.result.upsert({
      where: {
        runId_promptId_platform_sampleIndex: {
          runId: job.runId,
          promptId: job.promptId,
          platform: job.platform,
          sampleIndex: job.sampleIndex,
        },
      },
      create: {
        runId: job.runId,
        promptId: job.promptId,
        platform: job.platform,
        sampleIndex: job.sampleIndex,
        rawResponse: output.text,
        modelVersion: output.modelVersion,
        workerId,
        status: "completed",
        scrapedAt: new Date(),
      },
      update: {
        rawResponse: output.text,
        modelVersion: output.modelVersion,
        workerId,
        status: "completed",
        errorMessage: null,
        scrapedAt: new Date(),
      },
    }),
    prisma.job.update({
      where: { id: job.id },
      data: { status: "completed", completedAt: new Date(), lastError: null },
    }),
    prisma.run.update({
      where: { id: job.runId },
      data: { completedPrompts: { increment: 1 } },
    }),
  ]);

  await closeRunIfDone(job.runId);
}

/** Requeue a failed job, or bury it once it's out of attempts. */
export async function failJob(job: ClaimedJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: exhausted ? "failed" : "queued",
      workerId: null,
      lastError: message.slice(0, 2000),
      ...(exhausted ? { completedAt: new Date() } : {}),
    },
  });

  if (exhausted) {
    await prisma.result.upsert({
      where: {
        runId_promptId_platform_sampleIndex: {
          runId: job.runId,
          promptId: job.promptId,
          platform: job.platform,
          sampleIndex: job.sampleIndex,
        },
      },
      create: {
        runId: job.runId,
        promptId: job.promptId,
        platform: job.platform,
        sampleIndex: job.sampleIndex,
        status: "failed",
        errorMessage: message.slice(0, 2000),
      },
      update: { status: "failed", errorMessage: message.slice(0, 2000) },
    });
    await closeRunIfDone(job.runId);
  }
}

/** Mark the run finished once no job in it is still outstanding. */
async function closeRunIfDone(runId: string): Promise<void> {
  const outstanding = await prisma.job.count({
    where: { runId, status: { in: ["queued", "claimed"] } },
  });
  if (outstanding > 0) return;

  const failed = await prisma.job.count({ where: { runId, status: "failed" } });
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: failed > 0 ? "failed" : "completed",
      completedAt: new Date(),
    },
  });
}

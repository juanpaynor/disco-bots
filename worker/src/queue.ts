import { Prisma } from "./generated/prisma/index.js";
import { prisma } from "./db.js";
import { config } from "./config.js";
import type { ClaimedJob, Platform, ScrapeOutput } from "./types.js";

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
  // Empty list means "any platform"; otherwise restrict the claim.
  const platformFilter = config.platforms.length
    ? Prisma.sql`AND platform = ANY(${config.platforms})`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<{
    id: string;
    audit_id: string;
    prompt_id: string;
    result_id: string;
    platform: string;
    run_number: number;
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
          ${platformFilter}
        -- run_number FIRST, then creation order.
        --
        -- Gary's sheet asks each prompt twice per surface. Draining them in
        -- insert order means asking the identical question twice ~45s apart,
        -- which is both the loudest bot signal in the whole run and poor
        -- sampling: two hits on the same session state measure nothing. Taking
        -- every run 1 before any run 2 puts repeats an entire pass apart, so
        -- the x2 captures real variance instead of an echo.
        ORDER BY run_number, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, audit_id, prompt_id, result_id, platform, run_number, attempts, max_attempts
    )
    SELECT c.id, c.audit_id, c.prompt_id, c.result_id, c.platform, c.run_number,
           c.attempts, c.max_attempts, p.text AS prompt_text
    FROM claimed c
    JOIN prompts p ON p.id = c.prompt_id
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    auditId: row.audit_id,
    promptId: row.prompt_id,
    resultId: row.result_id,
    platform: row.platform as Platform,
    runNumber: row.run_number,
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
 * so without this an audit silently never finishes. Jobs that have burned all
 * their attempts go to 'failed' instead of looping.
 */
export async function reclaimStaleJobs(): Promise<number> {
  return prisma.$executeRaw(Prisma.sql`
    UPDATE jobs
    SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        worker_id = NULL,
        last_error = COALESCE(last_error, 'reclaimed: worker went away mid-job')
    WHERE status = 'claimed'
      AND claimed_at < NOW() - make_interval(secs => ${config.staleJobSeconds}::int)
  `);
}

/**
 * Fill the grid row and close out the job, in one transaction.
 *
 * Extraction fields are deliberately left null here. Scrape and extract are
 * separate passes so extraction can be re-run over stored text — changing how
 * "recommended" is judged must never require re-scraping 280 pages.
 */
export async function completeJob(
  job: ClaimedJob,
  output: ScrapeOutput,
  workerId: string
): Promise<void> {
  await prisma.$transaction([
    prisma.result.update({
      where: { id: job.resultId },
      data: {
        rawResponse: output.text,
        modelVersion: output.modelVersion,
        resultUrl: output.resultUrl ?? null,
        screenshotPath: output.screenshotPath ?? null,
        freshSearch: true, // every scrape opens a new conversation
        ...(output.aiOverviewPresent !== undefined
          ? { aiOverviewPresent: output.aiOverviewPresent }
          : {}),
        ...(output.brandOrganicRank !== undefined
          ? { brandOrganicRank: output.brandOrganicRank }
          : {}),
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
    prisma.audit.update({
      where: { id: job.auditId },
      data: { completedRuns: { increment: 1 } },
    }),
  ]);

  await closeAuditIfDone(job.auditId);
}

/** Requeue a failed job, or bury it once it's out of attempts. */
export async function failJob(job: ClaimedJob, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const exhausted = job.attempts >= job.maxAttempts;

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: exhausted ? "failed" : "queued",
      workerId: null,
      lastError: message,
      ...(exhausted ? { completedAt: new Date() } : {}),
    },
  });

  if (exhausted) {
    await prisma.result.update({
      where: { id: job.resultId },
      data: { status: "failed", errorMessage: message },
    });
    await closeAuditIfDone(job.auditId);
  }
}

/** Mark the audit finished once no job in it is still outstanding. */
async function closeAuditIfDone(auditId: string): Promise<void> {
  const outstanding = await prisma.job.count({
    where: { auditId, status: { in: ["queued", "claimed"] } },
  });
  if (outstanding > 0) return;

  const failed = await prisma.job.count({ where: { auditId, status: "failed" } });
  await prisma.audit.update({
    where: { id: auditId },
    data: { status: failed > 0 ? "failed" : "completed", completedAt: new Date() },
  });
}

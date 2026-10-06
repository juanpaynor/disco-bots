import { prisma } from "./db.js";
import { claimJob, completeJob, failJob } from "./queue.js";

const runId = process.argv[2];
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// 1. The core property: N concurrent workers, zero double-handed rows.
console.log("\n1. concurrent claim (4 workers racing 4 jobs)");
const claims = await Promise.all(
  ["w1", "w2", "w3", "w4"].map((w) => claimJob(w))
);
const got = claims.filter((c) => c !== null);
const ids = new Set(got.map((c) => c!.id));
check("all 4 jobs claimed", got.length === 4, `got ${got.length}`);
check("no job handed to two workers", ids.size === got.length, `${ids.size} unique of ${got.length}`);
check("queue now empty", (await claimJob("w5")) === null);

// 2. Completing a job writes the raw result and advances the run.
console.log("\n2. completeJob");
const j0 = got[0]!;
await completeJob(j0, { text: "A fake scraped answer.", modelVersion: "gpt-5-test" }, "w1");
const r = await prisma.result.findFirst({
  where: { runId: j0.runId, promptId: j0.promptId, platform: j0.platform },
});
check("result row written", r?.status === "completed", r?.status);
check("raw_response stored", r?.rawResponse === "A fake scraped answer.");
check("job marked completed",
  (await prisma.job.findUnique({ where: { id: j0.id } }))?.status === "completed");
check("run counter incremented",
  (await prisma.run.findUnique({ where: { id: runId } }))?.completedPrompts === 1);

// 3. Retry path: a failure under max_attempts goes back to the queue.
console.log("\n3. failJob — retry");
const j1 = got[1]!;
await failJob(j1, new Error("selector not found"));
const requeued = await prisma.job.findUnique({ where: { id: j1.id } });
check("requeued, not buried", requeued?.status === "queued", requeued?.status);
check("error recorded", requeued?.lastError === "selector not found");
check("reclaimable by another worker", (await claimJob("w6"))?.id === j1.id);

// 4. Exhausted attempts get buried, not looped forever.
console.log("\n4. failJob — attempts exhausted");
const j2 = { ...got[2]!, attempts: 3, maxAttempts: 3 };
await failJob(j2, new Error("banned"));
const buried = await prisma.job.findUnique({ where: { id: j2.id } });
check("job failed", buried?.status === "failed", buried?.status);
const failedResult = await prisma.result.findFirst({
  where: { runId: j2.runId, promptId: j2.promptId, platform: j2.platform },
});
check("failure recorded as a result row", failedResult?.status === "failed");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);

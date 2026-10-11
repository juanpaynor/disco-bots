/**
 * Exercise the queue against the real database without touching a browser.
 *   npm run smoke -- <auditId>
 */
import { prisma } from "./db.js";
import { claimJob, completeJob, failJob } from "./queue.js";

const auditId = process.argv[2];
if (!auditId) { console.error("usage: npm run smoke -- <auditId>"); process.exit(1); }

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

console.log("\n1. concurrent claim (4 workers racing)");
const claims = await Promise.all(["w1", "w2", "w3", "w4"].map((w) => claimJob(w)));
const got = claims.filter((c) => c !== null);
const ids = new Set(got.map((c) => c!.id));
check("4 jobs claimed", got.length === 4, `got ${got.length}`);
check("no job handed to two workers", ids.size === got.length, `${ids.size} unique of ${got.length}`);

console.log("\n2. completeJob fills the grid row");
const j0 = got[0]!;
await completeJob(j0, { text: "A fake scraped answer.", modelVersion: "test", resultUrl: "https://example.com/c/1" }, "w1");
const r = await prisma.result.findUnique({ where: { id: j0.resultId } });
check("row completed", r?.status === "completed", r?.status);
check("raw_response stored", r?.rawResponse === "A fake scraped answer.");
check("result_url stored", r?.resultUrl === "https://example.com/c/1");
check("fresh_search recorded", r?.freshSearch === true);
check("extraction left null", r?.brandMentioned === null);
check("audit counter advanced",
  (await prisma.audit.findUnique({ where: { id: auditId } }))?.completedRuns === 1);

console.log("\n3. failJob — retry");
const j1 = got[1]!;
await failJob(j1, new Error("selector not found"));
const requeued = await prisma.job.findUnique({ where: { id: j1.id } });
check("requeued, not buried", requeued?.status === "queued", requeued?.status);
check("error recorded", requeued?.lastError === "selector not found");

console.log("\n4. failJob — attempts exhausted");
const j2 = { ...got[2]!, attempts: 3, maxAttempts: 3 };
await failJob(j2, new Error("banned"));
check("job failed", (await prisma.job.findUnique({ where: { id: j2.id } }))?.status === "failed");
check("grid row marked failed",
  (await prisma.result.findUnique({ where: { id: j2.resultId } }))?.status === "failed");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);

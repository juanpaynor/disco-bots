import { prisma } from "./db.js";
const runId = process.argv[2];
const run = await prisma.run.findUnique({ where: { id: runId } });
console.log(`run: ${run?.name} | status=${run?.status} | ${run?.completedPrompts}/${run?.totalPrompts}`);
const jobs = await prisma.job.findMany({ where: { runId }, include: { prompt: true } });
for (const j of jobs) console.log(`  job ${j.status.padEnd(9)} attempts=${j.attempts} ${j.prompt.text.slice(0,45)}`);
const results = await prisma.result.findMany({ where: { runId }, include: { prompt: true } });
for (const r of results) {
  console.log(`\n--- ${r.platform} | ${r.status} | model=${r.modelVersion} | ${r.rawResponse?.length ?? 0} chars`);
  console.log(`    prompt: ${r.prompt.text}`);
  console.log(`    response:\n${r.rawResponse}`);
}
await prisma.$disconnect();

// Delete a run and everything hanging off it (prompts, jobs, results cascade).
import { prisma } from "./db.js";
const runId = process.argv[2];
if (!runId) { console.error("usage: npm run cleanup -- <runId>"); process.exit(1); }
const run = await prisma.run.delete({ where: { id: runId } });
console.log(`deleted run "${run.name}" (${run.id})`);
await prisma.$disconnect();

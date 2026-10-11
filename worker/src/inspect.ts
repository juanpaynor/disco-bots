// Print an audit's Run Grid as it currently stands.
import { prisma } from "./db.js";
const auditId = process.argv[2];
if (!auditId) { console.error("usage: npm run inspect -- <auditId>"); process.exit(1); }

const audit = await prisma.audit.findUnique({
  where: { id: auditId },
  include: { client: true },
});
if (!audit) { console.error("no such audit"); process.exit(1); }

console.log(`${audit.name} — ${audit.client.name} | ${audit.status} | ${audit.completedRuns}/${audit.totalRuns}`);

const results = await prisma.result.findMany({
  where: { auditId },
  include: { prompt: true },
  orderBy: { runLabel: "asc" },
});

const byStatus = results.reduce<Record<string, number>>((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});
console.log("grid:", JSON.stringify(byStatus));

for (const r of results.filter((x) => x.status === "completed")) {
  console.log(`\n${r.runLabel} | ${r.platform} run ${r.runNumber} | ${r.prompt.externalId} | ${r.rawResponse?.length ?? 0} chars`);
  console.log(`  prompt: ${r.prompt.text}`);
  console.log(`  mentioned=${r.brandMentioned} recommended=${r.brandRecommended} pos=${r.recommendationPosition}`);
  console.log(`  named: ${r.businessesNamed.join(", ") || "(not extracted)"}`);
}
await prisma.$disconnect();

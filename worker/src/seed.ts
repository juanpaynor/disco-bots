/**
 * Create a run from a CSV and fan it out into jobs — the dashboard's job, done
 * from the CLI so the scraper can be exercised before any UI exists.
 *
 *   npm run seed -- prompts.csv "Acme Q4 Audit" "Acme Corp" chatgpt,claude
 *
 * CSV: one prompt per line, or columns text,category,funnel_stage,search_volume
 */
import fs from "node:fs";
import { prisma } from "./db.js";
import { isPlatform, type Platform } from "./types.js";

const [file, runName, clientName, platformArg, samplesArg] = process.argv.slice(2);

if (!file || !runName || !clientName) {
  console.error('usage: npm run seed -- <file.csv> "<run name>" "<client>" [platforms] [samples]');
  process.exit(1);
}

const platforms = (platformArg ?? "chatgpt,gemini,claude").split(",").map((p) => p.trim());
for (const p of platforms) {
  if (!isPlatform(p)) throw new Error(`unknown platform: ${p}`);
}
const samples = Number(samplesArg ?? 1);

function splitCsvLine(line: string): string[] {
  // Handles quoted fields containing commas — prompts frequently have them.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
if (/^\s*"?text"?\s*(,|$)/i.test(lines[0] ?? "")) lines.shift(); // drop header

const parsed = lines.map((line) => {
  const [text, category, funnelStage, searchVolume] = splitCsvLine(line);
  return {
    text,
    category: category || null,
    funnelStage: funnelStage || null,
    searchVolume: searchVolume ? Number(searchVolume) : null,
  };
}).filter((p) => p.text);

const run = await prisma.run.create({
  data: {
    name: runName,
    clientName,
    status: "running",
    totalPrompts: parsed.length * platforms.length * samples,
    prompts: { create: parsed },
  },
  include: { prompts: true },
});

const jobs = run.prompts.flatMap((prompt) =>
  platforms.flatMap((platform) =>
    Array.from({ length: samples }, (_, sampleIndex) => ({
      runId: run.id,
      promptId: prompt.id,
      platform: platform as Platform,
      sampleIndex,
    }))
  )
);

await prisma.job.createMany({ data: jobs });

console.log(`Run ${run.id}`);
console.log(`  ${parsed.length} prompts x ${platforms.length} platforms x ${samples} sample(s) = ${jobs.length} jobs queued`);
await prisma.$disconnect();

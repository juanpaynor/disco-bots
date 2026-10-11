/**
 * Build an audit from Gary's Sheet 1 (Prompts & Conditions) export.
 *
 *   npm run seed -- --csv bangtao.csv --client clients/bangtao.json \
 *                   --audit "Bangtao Oct 2026" --prefix BL
 *
 * Creates the full Run Grid up front — all 280 rows in `pending` — so the grid
 * exists complete from the start, the way Gary's sheet looks when partly filled.
 * The worker fills rows in place rather than inserting as it goes.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import { PLATFORMS, SURFACE_LABELS, type Platform } from "./types.js";

interface ClientConfig {
  name: string;
  domains: string[];
  aliases: string[];
  rivals?: string[];
}

// --- args -------------------------------------------------------------------

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const csvPath = arg("--csv");
const clientPath = arg("--client");
const auditName = arg("--audit");
const prefix = arg("--prefix") ?? "RUN";
/// Surfaces to build grid rows for but NOT queue work against — e.g. Google
/// Search, which has no scraper yet. The rows still exist (the grid is 280 rows
/// regardless) but nothing tries to fill them, so no attempts are burned and no
/// row gets a fake negative.
const skip = new Set((arg("--skip") ?? "").split(",").map((s) => s.trim()).filter(Boolean));

if (!csvPath || !clientPath || !auditName) {
  console.error(
    'usage: npm run seed -- --csv <sheet1.csv> --client <client.json> --audit "<name>" [--prefix BL]'
  );
  process.exit(1);
}

// --- csv --------------------------------------------------------------------

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

/// Header names drift between exports ("Prompt (ask verbatim)" vs "prompt"), so
/// match on a squashed form rather than demanding exact strings.
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function columnFinder(headers: string[]) {
  const squashed = headers.map(squash);
  return (...candidates: string[]): number => {
    for (const c of candidates) {
      const i = squashed.findIndex((h) => h === squash(c) || h.includes(squash(c)));
      if (i >= 0) return i;
    }
    return -1;
  };
}

/// "High: ~100-300/mo" -> 200. Sorting and weighting want a number; the band
/// text is kept verbatim alongside because that is what the client sees.
function volumeMidpoint(band: string): number | null {
  const nums = band.match(/\d+/g)?.map(Number) ?? [];
  if (nums.length >= 2) return Math.round((nums[0]! + nums[1]!) / 2);
  if (nums.length === 1) return nums[0]!;
  return null;
}

/// "ChatGPT x2 · Gemini x2 · Claude x2 · Google Search x1"
///   -> { chatgpt: 2, gemini: 2, claude: 2, google: 1 }
function parseSurfaces(spec: string): Partial<Record<Platform, number>> {
  const out: Partial<Record<Platform, number>> = {};
  for (const platform of PLATFORMS) {
    const label = SURFACE_LABELS[platform];
    const re = new RegExp(`${label}\\s*[x×]\\s*(\\d+)`, "i");
    const m = spec.match(re);
    if (m) out[platform] = Number(m[1]);
  }
  return out;
}

// --- parse ------------------------------------------------------------------

const client: ClientConfig = JSON.parse(fs.readFileSync(clientPath, "utf8"));

const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
const headers = splitCsvLine(lines.shift() ?? "");
const col = columnFinder(headers);

const idx = {
  rank: col("rank"),
  kpi: col("kpipriority", "kpi"),
  promptId: col("promptid"),
  text: col("promptaskverbatim", "prompt"),
  theme: col("theme"),
  cluster: col("cluster"),
  volume: col("monthlysearchvolume", "searchvolume", "volume"),
  rationale: col("rankingrationale", "rationale"),
  framing: col("setframing", "framing"),
  market: col("marketcondition"),
  locale: col("locale"),
  surfaces: col("surfacesruns", "surfaces"),
};

if (idx.text < 0 || idx.promptId < 0) {
  console.error("CSV must contain at least 'Prompt ID' and 'Prompt' columns.");
  console.error("Found headers:", headers.join(" | "));
  process.exit(1);
}

const get = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");

const rows = lines.map((line, n) => {
  const c = splitCsvLine(line);
  const surfaceSpec = get(c, idx.surfaces);
  const surfaces = surfaceSpec
    ? parseSurfaces(surfaceSpec)
    : { chatgpt: 2, gemini: 2, claude: 2, google: 1 }; // Gary's default mix
  const band = get(c, idx.volume);

  return {
    externalId: get(c, idx.promptId),
    rank: Number(get(c, idx.rank)) || n + 1,
    kpiPriority: get(c, idx.kpi) || "unspecified",
    text: get(c, idx.text),
    theme: get(c, idx.theme) || null,
    cluster: get(c, idx.cluster) || null,
    volumeBand: band || null,
    volumeMidpoint: band ? volumeMidpoint(band) : null,
    rankingRationale: get(c, idx.rationale) || null,
    framing: get(c, idx.framing) || "Brand-blind",
    marketCondition: get(c, idx.market) || "Neutral",
    locale: get(c, idx.locale) || "en",
    surfaces,
  };
}).filter((r) => r.text && r.externalId);

if (!rows.length) {
  console.error("No usable rows parsed from the CSV.");
  process.exit(1);
}

// --- write ------------------------------------------------------------------

// Reuse the client across audits rather than creating a duplicate each run —
// visibility over time is the product, and that means many audits, one client.
const existing = await prisma.client.findFirst({ where: { name: client.name } });
const clientRow = existing
  ? await prisma.client.update({
      where: { id: existing.id },
      data: {
        domains: client.domains,
        aliases: client.aliases,
        rivals: client.rivals ?? [],
      },
    })
  : await prisma.client.create({
      data: {
        name: client.name,
        domains: client.domains,
        aliases: client.aliases,
        rivals: client.rivals ?? [],
      },
    });

const totalRuns = rows.reduce(
  (sum, r) => sum + Object.values(r.surfaces).reduce((a, b) => a + (b ?? 0), 0),
  0
);

const audit = await prisma.audit.create({
  data: {
    name: auditName,
    clientId: clientRow.id,
    runIdPrefix: prefix,
    status: "running",
    totalRuns,
  },
});

// Batched inserts, not row-at-a-time. 280 sequential round-trips to Railway over
// the public proxy takes minutes; three createMany calls take under a second.
// Result ids are generated here so jobs can reference them without reading back.
const promptRows = rows.map(({ surfaces, ...p }) => ({
  ...p,
  id: randomUUID(),
  auditId: audit.id,
}));
await prisma.prompt.createMany({ data: promptRows });

const resultRows: Array<{
  id: string; auditId: string; promptId: string; runLabel: string;
  platform: Platform; runNumber: number; status: string;
}> = [];
const jobRows: Array<{
  auditId: string; promptId: string; resultId: string;
  platform: Platform; runNumber: number;
}> = [];

let seq = 0;

for (let i = 0; i < rows.length; i++) {
  const { surfaces } = rows[i]!;
  const promptId = promptRows[i]!.id;

  for (const platform of PLATFORMS) {
    const runs = surfaces[platform] ?? 0;
    for (let runNumber = 1; runNumber <= runs; runNumber++) {
      seq += 1;
      const resultId = randomUUID();
      resultRows.push({
        id: resultId,
        auditId: audit.id,
        promptId,
        runLabel: `${prefix}-${String(seq).padStart(4, "0")}`,
        platform,
        runNumber,
        status: "pending",
      });
      if (!skip.has(platform)) {
        jobRows.push({ auditId: audit.id, promptId, resultId, platform, runNumber });
      }
    }
  }
}

await prisma.result.createMany({ data: resultRows });
await prisma.job.createMany({ data: jobRows });

const bySurface = PLATFORMS.map((p) => {
  const n = rows.reduce((sum, r) => sum + (r.surfaces[p] ?? 0), 0);
  return n ? `${SURFACE_LABELS[p]} ${n}` : null;
}).filter(Boolean).join(" · ");

console.log(`Audit ${audit.id} — "${auditName}" for ${client.name}`);
console.log(`  ${rows.length} prompts -> ${resultRows.length} grid rows (${prefix}-0001 … ${prefix}-${String(seq).padStart(4, "0")})`);
console.log(`  ${bySurface}`);
console.log(`  ${jobRows.length} jobs queued${skip.size ? ` (skipped: ${[...skip].join(", ")})` : ""}`);
await prisma.$disconnect();

/**
 * Export an audit as Gary's Sheet 2 (Run Grid) CSV.
 *
 *   npm run export -- --audit <auditId>                 -> ./exports/<name>-run-grid.csv
 *   npm run export -- --audit <auditId> --out grid.csv
 *   npm run export -- --audit <auditId> --raw           -> also writes the raw answers
 *
 * Column order matches the workbook exactly so the file pastes straight in.
 * Rows that have not been scraped yet export blank rather than being dropped —
 * the grid is 280 rows whether or not they are filled, which is how Gary's own
 * partly-complete sheet reads.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "./db.js";
import { SURFACE_LABELS, type Platform } from "./types.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const auditId = arg("--audit");
const includeRaw = process.argv.includes("--raw");

if (!auditId) {
  console.error("usage: npm run export -- --audit <auditId> [--out <file.csv>] [--raw]");
  process.exit(1);
}

const audit = await prisma.audit.findUnique({
  where: { id: auditId },
  include: { client: true },
});
if (!audit) {
  console.error(`no audit with id ${auditId}`);
  process.exit(1);
}

const results = await prisma.result.findMany({
  where: { auditId },
  include: { prompt: true },
  orderBy: { runLabel: "asc" },
});

/// Y / N / blank. Blank (not "N") for un-run rows: "no" and "not measured yet"
/// are different claims, and collapsing them would invent data.
const yn = (v: boolean | null | undefined) => (v === null || v === undefined ? "" : v ? "Y" : "N");

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
};

const brand = audit.client.name;

const HEADERS = [
  "Run ID", "Rank", "KPI Priority", "Prompt ID", "Prompt", "Surface", "Run #",
  "Market condition", "Locale", "Date", "Model / result page", "Fresh search? (Y/N)",
  `${brand} mentioned? (Y/N)`, `${brand} recommended? (Y/N)`, "Recommendation position",
  "Businesses named (in order)", "Competitors recommended", "Cited sources / domains",
  "AI Overview present?", `${brand} in AI Overview?`, `${brand} organic rank`,
];

const lines = [HEADERS.map(csvCell).join(",")];

for (const r of results) {
  const isGoogle = r.platform === "google";
  lines.push([
    r.runLabel,
    r.prompt.rank,
    r.prompt.kpiPriority,
    r.prompt.externalId,
    r.prompt.text,
    SURFACE_LABELS[r.platform as Platform] ?? r.platform,
    r.runNumber,
    r.prompt.marketCondition,
    r.prompt.locale,
    r.scrapedAt ? r.scrapedAt.toISOString().slice(0, 10) : "",
    r.resultUrl ?? "",
    yn(r.freshSearch),
    yn(r.brandMentioned),
    yn(r.brandRecommended),
    r.recommendationPosition ?? "",
    r.businessesNamed.join(", "),
    r.competitorsNamed.join(", "),
    r.citedSources.join(", "),
    // The AI Overview columns only mean anything on a Google row.
    isGoogle ? yn(r.aiOverviewPresent) : "n/a",
    isGoogle ? yn(r.brandInAiOverview) : "n/a",
    isGoogle ? (r.brandOrganicRank ?? "") : "n/a",
  ].map(csvCell).join(","));
}

const slug = audit.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outPath = arg("--out") ?? path.join("exports", `${slug}-run-grid.csv`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join("\n"), "utf8");

const filled = results.filter((r) => r.status === "completed").length;
const extracted = results.filter((r) => r.brandMentioned !== null).length;

console.log(`${outPath}`);
console.log(`  ${results.length} rows | ${filled} scraped | ${extracted} extracted`);

if (includeRaw) {
  const rawPath = outPath.replace(/\.csv$/, "-raw.csv");
  const rawLines = [["Run ID", "Prompt ID", "Surface", "Run #", "Chars", "Raw response"].map(csvCell).join(",")];
  for (const r of results.filter((x) => x.rawResponse)) {
    rawLines.push([
      r.runLabel, r.prompt.externalId, SURFACE_LABELS[r.platform as Platform] ?? r.platform,
      r.runNumber, r.rawResponse?.length ?? 0, r.rawResponse ?? "",
    ].map(csvCell).join(","));
  }
  fs.writeFileSync(rawPath, rawLines.join("\n"), "utf8");
  console.log(`${rawPath}`);
  console.log(`  ${rawLines.length - 1} raw answers`);
}

if (extracted === 0 && filled > 0) {
  console.log(`\nNote: ${filled} rows have raw text but no extraction, so the`);
  console.log(`mentioned / recommended / businesses-named columns are blank.`);
  console.log(`Those are filled by the extraction pass, which is not built yet.`);
}

await prisma.$disconnect();

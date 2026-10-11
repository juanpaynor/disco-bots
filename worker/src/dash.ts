/**
 * Live terminal dashboard for an audit.
 *
 *   npm run dash                      -> most recent audit
 *   npm run dash -- --audit <id>      -> a specific one
 *
 * Polls Postgres every 2s. Deliberately dependency-free: this is a read-only
 * view of state the worker already owns, so pulling in a TUI framework would
 * add a build surface for no benefit.
 */
import { prisma } from "./db.js";
import { PLATFORMS, SURFACE_LABELS, type Platform } from "./types.js";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", grey: "\x1b[90m",
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const width = () => Math.min(process.stdout.columns ?? 96, 110);

/// "Google Search" is 13 chars and overflowed a hardcoded 9, knocking the bars
/// out of alignment. Derive the column width from the labels themselves.
const LABEL_W = Math.max(...Object.values(SURFACE_LABELS).map((l) => l.length));

function bar(done: number, total: number, cells = 28): string {
  if (total === 0) return C.grey + "░".repeat(cells) + C.reset;
  const filled = Math.round((done / total) * cells);
  const colour = done === total ? C.green : done > 0 ? C.cyan : C.grey;
  return colour + "█".repeat(filled) + C.grey + "░".repeat(cells - filled) + C.reset;
}

const pct = (d: number, t: number) => (t === 0 ? "  —" : `${String(Math.round((d / t) * 100)).padStart(3)}%`);

function truncate(s: string, n: number): string {
  // Playwright errors carry multi-line "Call log:" tails that wreck the layout.
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}

/// Relative time reads better than a clock when you are watching a queue drain.
function ago(d: Date | null): string {
  if (!d) return "";
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

async function render(auditId: string | undefined): Promise<void> {
  const audit = auditId
    ? await prisma.audit.findUnique({ where: { id: auditId }, include: { client: true } })
    : await prisma.audit.findFirst({ orderBy: { createdAt: "desc" }, include: { client: true } });

  if (!audit) {
    process.stdout.write("\x1b[H\x1b[J no audits found\n");
    return;
  }

  const [rows, jobs, recent, failures] = await Promise.all([
    prisma.result.findMany({
      where: { auditId: audit.id },
      select: { platform: true, status: true, rawResponse: true, brandMentioned: true },
    }),
    prisma.job.findMany({
      where: { auditId: audit.id },
      select: { status: true, platform: true, attempts: true, lastError: true, claimedAt: true, workerId: true },
    }),
    prisma.result.findMany({
      where: { auditId: audit.id, status: "completed" },
      include: { prompt: true }, orderBy: { scrapedAt: "desc" }, take: 6,
    }),
    prisma.job.findMany({
      where: { auditId: audit.id, lastError: { not: null } },
      include: { prompt: true }, orderBy: { claimedAt: "desc" }, take: 3,
    }),
  ]);

  const w = width();
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const rule = (ch = "─") => line(C.grey + ch.repeat(w) + C.reset);

  const statusColour =
    audit.status === "completed" ? C.green : audit.status === "failed" ? C.red : C.yellow;

  line();
  line(`  ${C.bold}${audit.name}${C.reset}  ${C.grey}·${C.reset}  ${audit.client.name}  ${C.grey}·${C.reset}  ${statusColour}${audit.status}${C.reset}`);
  line(`  ${C.grey}${audit.id}${C.reset}`);
  line();

  const done = rows.filter((r) => r.status === "completed").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  line(`  ${C.bold}Overall${C.reset}   ${bar(done, rows.length)}  ${String(done).padStart(3)}/${rows.length}  ${pct(done, rows.length)}`);
  line();

  for (const p of PLATFORMS) {
    const pr = rows.filter((r) => r.platform === p);
    if (!pr.length) continue;
    const d = pr.filter((r) => r.status === "completed").length;
    const f = pr.filter((r) => r.status === "failed").length;
    const queued = jobs.filter((j) => j.platform === p && j.status === "queued").length;
    const hasJobs = jobs.some((j) => j.platform === p);

    const note = !hasJobs
      ? `${C.grey}deferred — no scraper${C.reset}`
      : f > 0
      ? `${C.red}${f} failed${C.reset}  ${C.grey}${queued} queued${C.reset}`
      : `${C.grey}${queued} queued${C.reset}`;

    line(`  ${SURFACE_LABELS[p].padEnd(LABEL_W)} ${bar(d, pr.length)}  ${String(d).padStart(3)}/${String(pr.length).padEnd(3)} ${pct(d, pr.length)}  ${note}`);
  }

  line();
  rule();

  // --- queue + capture health ----------------------------------------------
  const inFlight = jobs.filter((j) => j.status === "claimed");
  const queuedAll = jobs.filter((j) => j.status === "queued").length;
  const buried = jobs.filter((j) => j.status === "failed").length;
  const retried = jobs.filter((j) => j.attempts > 1).length;

  line(`  ${C.bold}Queue${C.reset}     ${queuedAll} queued ${C.grey}·${C.reset} ${inFlight.length} in flight ${C.grey}·${C.reset} ${buried > 0 ? C.red : ""}${buried} buried${C.reset} ${C.grey}·${C.reset} ${retried} retried`);

  const lens = rows.filter((r) => r.rawResponse).map((r) => r.rawResponse!.length);
  if (lens.length) {
    const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
    // Short answers are the signature of captured error banners and truncated
    // preambles — both of which look like valid "brand not mentioned" rows.
    const short = lens.filter((n) => n < 250).length;
    line(`  ${C.bold}Capture${C.reset}   avg ${avg} chars ${C.grey}·${C.reset} min ${Math.min(...lens)} ${C.grey}·${C.reset} max ${Math.max(...lens)} ${C.grey}·${C.reset} ${short > 0 ? C.red : C.green}${short} suspiciously short${C.reset}`);
  }

  const extracted = rows.filter((r) => r.brandMentioned !== null).length;
  const extColour = extracted === 0 ? C.yellow : C.green;
  line(`  ${C.bold}Extract${C.reset}   ${extColour}${extracted}/${done} scored${C.reset} ${extracted === 0 ? C.grey + "— extraction pass not built; Y/N columns empty" + C.reset : ""}`);

  if (inFlight.length) {
    line();
    for (const j of inFlight) {
      line(`  ${C.cyan}▸ in flight${C.reset}  ${SURFACE_LABELS[j.platform as Platform] ?? j.platform}  ${C.grey}${j.workerId ?? ""} · ${ago(j.claimedAt)}${C.reset}`);
    }
  }

  // --- recent --------------------------------------------------------------
  if (recent.length) {
    line();
    rule();
    line(`  ${C.bold}Recent${C.reset}`);
    for (const r of recent) {
      const n = r.rawResponse?.length ?? 0;
      const health = n < 250 ? C.red : n < 800 ? C.yellow : C.green;
      line(
        `    ${C.grey}${r.runLabel}${C.reset}  ${r.prompt.externalId} r${r.runNumber}  ` +
        `${(SURFACE_LABELS[r.platform as Platform] ?? r.platform).padEnd(8)} ` +
        `${health}${String(n).padStart(5)}${C.reset}  ` +
        `${C.grey}${truncate(r.prompt.text, Math.max(20, w - 52))}${C.reset}`
      );
    }
  }

  if (failures.length) {
    line();
    line(`  ${C.bold}${C.red}Failures${C.reset}`);
    for (const f of failures) {
      line(`    ${C.grey}${f.prompt.externalId} r${f.runNumber}${C.reset}  ${f.status} ${C.grey}${f.attempts}/${f.maxAttempts}${C.reset}  ${C.red}${truncate(f.lastError ?? "", Math.max(20, w - 40))}${C.reset}`);
    }
  }

  line();
  rule();
  line(`  ${C.grey}refreshing every 2s · ctrl-c to exit · ${new Date().toLocaleTimeString()}${C.reset}`);
  line();

  // Home the cursor and clear downward rather than wiping the screen: a full
  // clear flickers badly at a 2s cadence.
  process.stdout.write("\x1b[H\x1b[J" + out.join("\n"));
}

const auditId = arg("--audit");
/// Single frame, no loop, no cursor tricks — for piping into a file or a log.
const once = process.argv.includes("--once");

if (once) {
  await render(auditId);
  process.stdout.write("\n");
  await prisma.$disconnect();
  process.exit(0);
}

let stopping = false;

process.stdout.write("\x1b[?25l"); // hide cursor
const cleanup = () => {
  if (stopping) return;
  stopping = true;
  process.stdout.write("\x1b[?25h\n"); // restore cursor
  void prisma.$disconnect().finally(() => process.exit(0));
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

while (!stopping) {
  try {
    await render(auditId);
  } catch (err) {
    process.stdout.write(`\x1b[H\x1b[J  ${C.red}dashboard error:${C.reset} ${err instanceof Error ? err.message : err}\n`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

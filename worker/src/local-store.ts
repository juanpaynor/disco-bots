import fs from "node:fs";
import path from "node:path";
import { CHAT_PLATFORMS, type LocalRun } from "./local-run.js";

// Parse CSV records, including quoted commas, escaped quotes and multiline prompts.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else cell += ch;
    } else if (!quoted && (ch === "," || ch === "\n" || ch === "\r")) {
      row.push(cell); cell = "";
      if (ch !== ",") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        rows.push(row); row = [];
      }
    } else cell += ch;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function promptsFromFile(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  if (!/\.csv$/i.test(file)) return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const column = rows[0].findIndex((c) => /^(prompt|prompt text|prompt_text|text|question)$/i.test(c.trim()));
  if (column < 0 && rows[0].length > 1) throw new Error("CSV needs a Prompt or Text column, or a single prompt column without a header.");
  return (column < 0 ? rows : rows.slice(1)).map((r) => r[column < 0 ? 0 : column]?.trim() ?? "").filter(Boolean);
}

export function readRun(file: string, retryFailed = false): LocalRun {
  const run = JSON.parse(fs.readFileSync(file, "utf8")) as LocalRun;
  if (run.version !== 1 || typeof run.id !== "string" || !Array.isArray(run.results) || !run.results.length ||
      run.results.some((r) => !r || !CHAT_PLATFORMS.includes(r.platform) || typeof r.prompt !== "string" || !r.prompt.trim() ||
        typeof r.promptId !== "string" || !["pending", "running", "completed", "failed"].includes(r.status) ||
        (r.status === "completed" && (typeof r.output?.text !== "string" || !r.output.text.trim())))) {
    throw new Error("Unsupported or invalid AiDisco run file.");
  }
  const keys = run.results.map((r) => `${r.promptId}/${r.platform}`);
  if (new Set(keys).size !== keys.length) throw new Error("Run file contains duplicate prompt/platform entries.");
  for (const r of run.results) {
    if (r.status === "running" || (retryFailed && r.status === "failed")) {
      r.status = "pending"; r.startedAt = null; r.finishedAt = null; r.output = null; r.error = null;
    }
  }
  return run;
}

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
export function resultsCsv(run: LocalRun): string {
  const rows: unknown[][] = [["Run ID", "Prompt ID", "Prompt", "Platform", "Status", "Model", "Started At", "Finished At", "Response", "Result URL", "Screenshot Path", "Error"]];
  for (const r of run.results) rows.push([
    run.id, r.promptId, r.prompt, r.platform, r.status, r.output?.modelVersion,
    r.startedAt, r.finishedAt, r.output?.text, r.output?.resultUrl, r.output?.screenshotPath, r.error,
  ]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function saveRun(file: string, run: LocalRun): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // State is authoritative. Both files are individually replaced atomically;
  // resuming regenerates the CSV if a crash occurred between these writes.
  for (const [target, contents] of [[file, JSON.stringify(run, null, 2) + "\n"], [path.join(path.dirname(file), "results.csv"), resultsCsv(run)]]) {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
}

export function lockRun(file: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => fs.unlinkSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(fs.readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid run lock; check whether this run is already active.");
      try { process.kill(pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") { fs.unlinkSync(lock); continue; }
        throw probe;
      }
      throw new Error("This run is already active in another terminal.");
    }
  }
  throw new Error("Could not acquire the run lock.");
}

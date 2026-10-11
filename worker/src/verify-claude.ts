/** Standalone browser verification: no Prisma imports or audit/queue writes. */
import path from "node:path";
import { launchContext, sleep } from "./browser.js";
import { scrape, ClaudeScrapeError } from "./bots/claude.js";

const usage = `Usage: npm run verify:claude -- [options]
  --prompt <text>       Prompt to submit (default: a short factual question)
  --count <1-5>         Fresh conversations to verify (default: 1)
  --timeout-ms <ms>     Response deadline (default: configured timeout)
  --out <directory>    Evidence directory (default: captures/claude)
  --help               Show help

Uses the same browser profile/settings as the worker. Requires Claude login.
Writes full answers, capture status and screenshots locally; never touches jobs.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log(usage); return; }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    if (!["--prompt", "--count", "--timeout-ms", "--out"].includes(flag) || !args[i + 1] || args[i + 1]!.startsWith("--")) {
      throw new Error(`Invalid option: ${flag}\n${usage}`);
    }
    values.set(flag, args[i + 1]!);
  }
  const prompt = values.get("--prompt") ?? "What are three factors to consider when choosing a Muay Thai training camp?";
  if (!prompt.trim()) throw new Error("Prompt must not be empty");
  const count = Number(values.get("--count") ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error("--count must be an integer from 1 to 5");
  const timeoutMs = values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("--timeout-ms must be positive");
  const evidenceDir = path.resolve(values.get("--out") ?? path.join(process.env.CAPTURE_DIR ?? "captures", "claude"));
  console.log(`Verifying Claude: ${count} fresh conversation(s). Evidence: ${evidenceDir}`);
  const context = await launchContext("claude");
  try {
    // Keep the completed conversation visible between runs. Reuse the initial
    // blank local tab, but leave existing hosted-browser conversations alone.
    const page = context.pages().find((tab) => tab.url() === "about:blank") ?? await context.newPage();
    for (let i = 0; i < count; i++) {
      console.log(`\n[${i + 1}/${count}] Opening https://claude.ai/new in the same tab…`);
      const result = await scrape(context, prompt, { timeoutMs, evidenceDir, page });
      console.log(`\n[${i + 1}/${count}] COMPLETED | ${result.text.length} chars | model: ${result.modelVersion ?? "unknown"}`);
      console.log(`Conversation: ${result.resultUrl}\nScreenshot: ${result.screenshotPath}\nMetadata: ${result.screenshotPath?.replace(/\.png$/, ".json")}\n\n${result.text}`);
      if (i + 1 < count) {
        const pauseSeconds = Math.ceil(20 + Math.random() * 40);
        console.log(`\nWaiting ${pauseSeconds}s before conversation ${i + 2}/${count}. The browser will stay open.`);
        await sleep(pauseSeconds * 1000);
      }
    }
    console.log(`\nVerified ${count}/${count} Claude conversations. Closing the verification browser.`);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ClaudeScrapeError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.evidencePath) console.error(`Evidence: ${error.evidencePath}`);
  } else {
    console.error(error instanceof Error && !/browserType\.|launchPersistentContext|connectOverCDP/i.test(error.message)
      ? error.message : "Browser launch failed. Check profile locks, browser installation and connection settings.");
  }
  process.exitCode = 1;
});

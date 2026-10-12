import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { launchContext } from "./browser.js";
import { config } from "./config.js";
import { bots } from "./bots/index.js";
import { scrape as scrapeChatgpt } from "./bots/chatgpt.js";
import { SURFACE_LABELS } from "./types.js";
import { CHAT_PLATFORMS, createRun, executeRun, RunControl, type ChatPlatform, type LocalRun } from "./local-run.js";
import { lockRun, promptsFromFile, readRun, saveRun } from "./local-store.js";
import { choosePlatforms } from "./disco-wizard.js";
import { ensureAccounts } from "./disco-accounts.js";
import { installManagedBrowser } from "./browser-install.js";

const help = `AiDisco — send prompts to ChatGPT, Gemini and Claude

  disco                              Choose AI models, then paste prompts
  disco --prompt "Your question"      One prompt, all three platforms in parallel
  disco --file prompts.csv            CSV with a Prompt/Text column, or .txt lines
  disco --platforms chatgpt,claude     Skip model picker; use these platforms
  disco --login                      Set up or refresh selected account logins
  disco --install-browser            Download the managed browser without logging in
  disco --version                    Show the installed version
  disco --browser minimized          Minimize Chrome windows (default)
  disco --browser visible            Show browser windows for troubleshooting
  disco --browser headless           Run without browser windows
  disco --out /path/to/run-folder     Choose the output folder
  disco --open /path/to/run-folder    Open saved results in your file manager
  disco --resume /path/to/run-folder  Continue pending work; retain saved answers
  disco --resume /path/to/run-folder --retry-failed

During a run: p pause/resume · s stop after current prompt · l show/hide logs · o open output folder
Model picker: arrows move · Space toggle · a toggle all · Enter continue
Piped input defaults to all three platforms. --resume keeps saved selections.
Ctrl+C also finishes current captures before stopping.
Results and resume state are saved after each platform completes.
`;

function options(args: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (out.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    if (["--help", "-h", "--version", "-v", "--install-browser", "--retry-failed", "--login"].includes(flag)) out.set(flag, "true");
    else if (["--prompt", "--file", "--platforms", "--browser", "--out", "--resume", "--open"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      out.set(flag, value);
    } else throw new Error(`Unknown option: ${flag}. Run disco --help.`);
  }
  if (out.has("--open") && [...out.keys()].some((k) => !["--open", "--help", "-h"].includes(k))) {
    throw new Error("Use --open on its own to open an existing output folder.");
  }
  if (out.has("--login") && [...out.keys()].some((k) => !["--login", "--platforms", "--help", "-h"].includes(k))) {
    throw new Error("Use --login on its own or with --platforms to set up accounts without starting a run.");
  }
  if (out.has("--install-browser") && [...out.keys()].some((k) => !["--install-browser", "--help", "-h"].includes(k))) {
    throw new Error("Use --install-browser on its own to download Chromium without starting a run.");
  }
  if (out.has("--prompt") && out.has("--file")) throw new Error("Choose either --prompt or --file.");
  if (out.has("--resume") && ["--prompt", "--file", "--platforms", "--out"].some((k) => out.has(k))) {
    throw new Error("--resume uses the prompts, platforms and folder from the saved run.");
  }
  if (out.has("--retry-failed") && !out.has("--resume")) throw new Error("--retry-failed requires --resume.");
  if (out.has("--browser") && !["minimized", "visible", "headless"].includes(out.get("--browser")!)) {
    throw new Error("Choose --browser minimized, visible, or headless.");
  }
  return out;
}

const inputRoot = process.env.DISCO_INPUT_CWD ?? process.cwd();
const inputPath = (p: string) => path.resolve(inputRoot, p);
const plain = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const execFileAsync = promisify(execFile);

async function openOutputFolder(folder: string): Promise<void> {
  if (!fs.statSync(folder).isDirectory()) throw new Error(`Not a folder: ${folder}`);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    await execFileAsync(command, [folder]);
  } catch (error) {
    throw new Error(`Could not open folder ${folder}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function showStartupArt(): void {
  if (!process.stdout.isTTY) return;
  const cyan = "\x1b[96m", magenta = "\x1b[95m", reset = "\x1b[0m";
  const bot = [
    "       \\ | /",
    "     .-------.",
    "     | o   o |",
    "     |  ===  |",
    "  .--'-------'--.",
    "  |  [*] [*]   |",
    "  '---|-----|---'",
    "     _|_   _|_",
  ];
  const title = (process.stdout.columns ?? 80) >= 70 ? [
    "",
    "█████ ███   ████  ███ █████ █████ █████",
    "█   █  █    █   █  █  █     █     █   █",
    "█████  █    █   █  █  █████ █     █   █",
    "█   █  █    █   █  █      █ █     █   █",
    "█   █ ███   ████  ███ █████ █████ █████",
    "",
    "bot by Johnny P",
  ] : ["", "AI DISCO", "", "bot by Johnny P"];
  console.log("\n" + bot.map((line, i) => `${cyan}${line.padEnd(21)}${magenta}${title[i] ?? ""}${reset}`).join("\n") + "\n");
}

async function readPrompts(platforms: ChatPlatform[]): Promise<string[]> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompts: string[] = [];
  console.log(`\nSelected: ${platforms.map((p) => SURFACE_LABELS[p]).join(", ")}`);
  console.log("Paste prompts, one per line. Enter a blank line to start.");
  try {
    // Consume lines as a stream so a multiline paste cannot lose buffered lines.
    rl.setPrompt("> "); rl.prompt();
    for await (const line of rl) {
      if (!line.trim()) break;
      prompts.push(line.trim()); rl.prompt();
    }
  } finally { rl.close(); }
  return prompts;
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  if (opts.has("--help") || opts.has("-h")) { console.log(help); return; }
  if (opts.has("--version") || opts.has("-v")) { console.log(`AiDisco ${process.env.DISCO_VERSION ?? "development"}`); return; }
  if (opts.has("--install-browser")) {
    await installManagedBrowser();
    console.log("Disco's browser is ready.");
    return;
  }
  if (opts.has("--open")) {
    const folder = inputPath(opts.get("--open")!);
    await openOutputFolder(folder);
    console.log(`Opened output folder: ${folder}`);
    return;
  }
  showStartupArt();
  const browserMode = opts.get("--browser") ?? "minimized";
  const interactive = !!process.stdout.isTTY && !!process.stdin.isTTY;
  const selected = opts.get("--platforms") ?? "all";
  let platforms = (selected === "all" ? [...CHAT_PLATFORMS] : selected.split(",").map((p) => p.trim())) as ChatPlatform[];
  if (platforms.some((p) => !CHAT_PLATFORMS.includes(p)) || !platforms.length || new Set(platforms).size !== platforms.length) {
    throw new Error("Select chatgpt, gemini, claude, or all.");
  }
  if (interactive && !opts.has("--platforms") && !opts.has("--resume")) {
    const chosen = await choosePlatforms();
    if (!chosen) { console.log("\nSetup cancelled."); return; }
    platforms = chosen;
  }
  if (!opts.has("--resume")) {
    if (!await ensureAccounts(platforms, { interactive, force: opts.has("--login") })) {
      console.log("\nAccount setup cancelled. No prompts were submitted.");
      return;
    }
    if (opts.has("--login")) return;
  }
  let stateFile: string;
  let run: LocalRun;
  let release: (() => void) | undefined;
  try {
    if (opts.has("--resume")) {
      const target = inputPath(opts.get("--resume")!);
      stateFile = fs.statSync(target).isDirectory() ? path.join(target, "run.json") : target;
      if (path.basename(stateFile) !== "run.json") throw new Error("Resume a run folder or its run.json file.");
      release = lockRun(stateFile);
      run = readRun(stateFile, opts.has("--retry-failed"));
      const pendingPlatforms = [...new Set(run.results.filter((result) => result.status === "pending").map((result) => result.platform))];
      if (!await ensureAccounts(pendingPlatforms, { interactive })) {
        console.log("\nAccount setup cancelled. No prompts were submitted.");
        return;
      }
    } else {
      const prompts = opts.has("--prompt") ? [opts.get("--prompt")!] : opts.has("--file")
        ? promptsFromFile(inputPath(opts.get("--file")!)) : await readPrompts(platforms);
      run = createRun(prompts, platforms);
      const folder = opts.has("--out") ? inputPath(opts.get("--out")!)
        : path.resolve(process.env.DISCO_DATA_DIR ?? ".", "exports", "disco", run.id);
      stateFile = path.join(folder, "run.json");
      release = lockRun(stateFile);
      if (fs.existsSync(stateFile) || fs.existsSync(path.join(folder, "results.csv"))) {
        throw new Error("Output already exists. Use --resume or choose another --out folder.");
      }
    }
    saveRun(stateFile, run);
    const outputFolder = path.dirname(stateFile);
    const control = new RunControl();
    const cyan = interactive ? "\x1b[36m" : "", magenta = interactive ? "\x1b[35m" : "", reset = interactive ? "\x1b[0m" : "";
    const started = Date.now();
    const logs: string[] = [];
    let showLogs = false;
    let openingFolder = false;
    let folderNotice = "";
    const render = () => {
      if (!interactive) return;
      const done = run.results.filter((r) => r.status === "completed").length;
      const failed = run.results.filter((r) => r.status === "failed").length;
      const finished = done + failed;
      const filled = Math.round(finished / run.results.length * 24);
      const width = Math.max(20, (process.stdout.columns ?? 90) - 4);
      const lines = [
        `${cyan}AiDisco${reset} · by Johnny P  ${magenta}${control.stopped ? "Stopping after current prompt" : control.paused ? "Paused after current prompt" : "Running"}${reset} · browser: ${browserMode}`,
        "", `${cyan}${"━".repeat(filled)}${reset}${"─".repeat(24 - filled)}  ${finished}/${run.results.length} · ${done} saved · ${failed} failed · ${Math.floor((Date.now() - started) / 1000)}s`, "",
      ];
      for (const platform of CHAT_PLATFORMS) {
        const rows = run.results.filter((r) => r.platform === platform);
        if (!rows.length) continue;
        const active = rows.find((r) => r.status === "running");
        const last = [...rows].reverse().find((r) => r.status !== "pending");
        const current = active ?? last;
        lines.push(`${cyan}${SURFACE_LABELS[platform].padEnd(9)}${reset} ${current?.status ?? "ready"} · ${rows.filter((r) => r.status === "completed").length}/${rows.length} saved`);
        if (current) lines.push(`  ${plain(`${current.promptId}: ${current.prompt}`).slice(0, width)}`);
        if (current?.output) lines.push(`  ${plain(current.output.text).slice(0, width)}`);
        if (current?.error) lines.push(`  ${plain(current.error).slice(0, width)}`);
        lines.push("");
      }
      lines.push("p pause/resume · s stop after current · l logs · o open folder", `Folder: ${outputFolder}`, `CSV: ${path.join(outputFolder, "results.csv")}`);
      if (folderNotice) lines.push(plain(folderNotice));
      if (showLogs) lines.push("", ...logs.slice(-6).map((s) => plain(s).slice(0, width)));
      process.stdout.write("\x1b[H\x1b[J" + lines.join("\n") + "\n");
    };
    const stop = () => { control.stopped = true; if (!interactive) console.log("Finishing current captures, then stopping…"); render(); };
    const keypress = (text: string, key: readline.Key) => {
      if ((key.ctrl && key.name === "c") || text === "s") stop();
      else if (text === "p") { control.paused = !control.paused; render(); }
      else if (text === "l") { showLogs = !showLogs; render(); }
      else if (text === "o" && !openingFolder) {
        openingFolder = true;
        folderNotice = "Opening output folder…";
        render();
        void openOutputFolder(outputFolder).then(() => {
          folderNotice = "Output folder opened.";
        }).catch((error) => {
          folderNotice = error instanceof Error ? error.message : String(error);
        }).finally(() => { openingFolder = false; });
      }
    };
    const wasRaw = process.stdin.isRaw;
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    let refresh: NodeJS.Timeout | undefined;
    try {
      if (interactive) {
        process.stdout.write("\x1b[?1049h\x1b[?25l");
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("keypress", keypress);
        refresh = setInterval(render, 250); render();
      } else console.log(`AiDisco · ${run.id} · ${run.results.length} captures · browser: ${browserMode}`);
      await executeRun(run, control, {
        launch: (platform) => launchContext(platform, {
          headless: browserMode === "headless",
          minimized: browserMode === "minimized",
          viewport: browserMode === "headless" ? { width: 1440, height: 900 } : null,
        }),
        // The database audit adapter retains its long-answer floor. A local
        // prompt may legitimately ask for a number or a one-word answer.
        scrape: { ...bots, chatgpt: (ctx, prompt) => scrapeChatgpt(ctx, prompt, { minAnswerChars: 1 }) },
        save: (state) => saveRun(stateFile, state),
        update: (result) => {
          const note = `${SURFACE_LABELS[result.platform]} · ${result.promptId} · ${result.status}${result.error ? ` · ${plain(result.error)}` : ""}`;
          logs.push(note);
          if (interactive) render(); else console.log(note);
        },
        gapMs: () => config.gapMinMs + Math.random() * (config.gapMaxMs - config.gapMinMs),
        promptBudget: config.sessionBudget,
      });
    } finally {
      if (refresh) clearInterval(refresh);
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      if (interactive) {
        process.stdin.off("keypress", keypress); process.stdin.setRawMode(wasRaw ?? false); process.stdin.pause();
        process.stdout.write("\x1b[?25h\x1b[?1049l");
      }
    }
    const completed = run.results.filter((r) => r.status === "completed").length;
    const failed = run.results.filter((r) => r.status === "failed").length;
    const pending = run.results.filter((r) => r.status === "pending").length;
    console.log(`\nAiDisco · ${completed} saved · ${failed} failed · ${pending} pending`);
    console.log(`Folder: ${outputFolder}`);
    console.log(`CSV: ${path.join(outputFolder, "results.csv")}`);
    console.log(`Open folder: disco --open ${shellQuote(outputFolder)}`);
    if (pending || failed) console.log(`Resume: disco --resume ${shellQuote(path.dirname(stateFile))}${failed ? " --retry-failed" : ""}`);
    if (failed) process.exitCode = 1;
  } finally { release?.(); }
}

main().catch((error) => {
  console.error(`AiDisco: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

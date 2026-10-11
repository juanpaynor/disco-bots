import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BrowserContext } from "playwright";
import { CHAT_PLATFORMS, createRun, executeRun, RunControl, type ChatPlatform, type RunDependencies } from "./local-run.js";
import { lockRun, parseCsv, promptsFromFile, readRun, resultsCsv, saveRun } from "./local-store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function fakeDeps(scrape: RunDependencies["scrape"], closed: ChatPlatform[] = []): RunDependencies {
  return {
    launch: async (platform) => ({ close: async () => { closed.push(platform); } }) as unknown as BrowserContext,
    scrape, save: () => {}, gapMs: () => 0,
  };
}
const answer = async () => ({ text: "Complete answer", modelVersion: "fixture" });
const allAnswers = { chatgpt: answer, gemini: answer, claude: answer };

test("all three start together; each next prompt waits for the current round", async () => {
  const gate = deferred(), allStarted = deferred();
  const started: string[] = [], closed: ChatPlatform[] = [];
  const launched: ChatPlatform[] = [];
  const scrape = Object.fromEntries(CHAT_PLATFORMS.map((p) => [p, async (_: BrowserContext, prompt: string) => {
    started.push(`${p}/${prompt}`);
    if (started.length === 3) allStarted.resolve();
    await gate.promise;
    return { text: `${p}: ${prompt}`, modelVersion: p };
  }])) as RunDependencies["scrape"];
  const deps = fakeDeps(scrape, closed);
  const originalLaunch = deps.launch;
  deps.launch = async (p) => { launched.push(p); return originalLaunch(p); };
  const run = createRun(["first", "second"], [...CHAT_PLATFORMS]);
  const running = executeRun(run, new RunControl(), deps);
  await allStarted.promise;
  assert.deepEqual(new Set(started), new Set(CHAT_PLATFORMS.map((p) => `${p}/first`)));
  gate.resolve(); await running;
  assert.equal(started.length, 6);
  assert.equal(run.results.filter((r) => r.status === "completed").length, 6);
  assert.deepEqual(launched.sort(), [...CHAT_PLATFORMS].sort());
  assert.deepEqual(closed.sort(), [...CHAT_PLATFORMS].sort());
});

test("one failed platform retains the other answers and stops the next round", async () => {
  const run = createRun(["first", "second"], [...CHAT_PLATFORMS]);
  await executeRun(run, new RunControl(), fakeDeps({ ...allAnswers, gemini: async () => { throw new Error("login required"); } }));
  assert.equal(run.results.filter((r) => r.status === "completed").length, 2);
  assert.equal(run.results.filter((r) => r.status === "failed").length, 1);
  assert.equal(run.results.filter((r) => r.status === "pending").length, 3);
  assert.equal(run.results.find((r) => r.status === "failed")?.error, "login required");
});

test("launch failures and empty responses are recorded; other browsers close", async () => {
  const run = createRun(["first"], [...CHAT_PLATFORMS]);
  const closed: ChatPlatform[] = [];
  const deps = fakeDeps({ ...allAnswers, claude: async () => ({ text: " ", modelVersion: null }) }, closed);
  const originalLaunch = deps.launch;
  deps.launch = async (p) => { if (p === "gemini") throw new Error("profile locked"); return originalLaunch(p); };
  await executeRun(run, new RunControl(), deps);
  assert.deepEqual(run.results.map((r) => r.status), ["completed", "failed", "failed"]);
  assert.deepEqual(closed.sort(), ["chatgpt", "claude"]);
});

test("pause waits between rounds, resume proceeds, and stop finishes current captures", async () => {
  const firstGate = deferred(), secondGate = deferred(), firstStarted = deferred(), secondStarted = deferred();
  const control = new RunControl();
  const pausedBoundary = deferred();
  const originalReady = control.ready.bind(control);
  control.ready = async () => {
    if (control.paused) pausedBoundary.resolve();
    return originalReady();
  };
  const run = createRun(["first", "second", "third"], ["chatgpt"]);
  const deps = fakeDeps({ ...allAnswers, chatgpt: async (_, prompt) => {
    if (prompt === "first") { firstStarted.resolve(); await firstGate.promise; }
    if (prompt === "second") { secondStarted.resolve(); await secondGate.promise; }
    return answer();
  } });
  const firstSaved = deferred();
  deps.save = (state) => { if (state.results[0].status === "completed") firstSaved.resolve(); };
  const running = executeRun(run, control, deps);
  await firstStarted.promise;
  control.paused = true; firstGate.resolve(); await firstSaved.promise; await pausedBoundary.promise;
  assert.equal(run.results[1].status, "pending");
  control.paused = false; await secondStarted.promise;
  control.stopped = true; secondGate.resolve(); await running;
  assert.deepEqual(run.results.map((r) => r.status), ["completed", "completed", "pending"]);
});

test("save errors propagate after all in-flight captures finish and cleanup runs", async () => {
  const closed: ChatPlatform[] = [];
  const run = createRun(["first"], [...CHAT_PLATFORMS]);
  const deps = fakeDeps(allAnswers, closed);
  deps.save = (state) => { if (state.results.some((r) => r.status === "completed")) throw new Error("disk full"); };
  await assert.rejects(executeRun(run, new RunControl(), deps), /disk full/);
  assert.equal(run.results.filter((r) => r.status === "completed").length, 3);
  assert.equal(closed.length, 3);
});

test("budget leaves remaining prompts resumable", async () => {
  const run = createRun(["first", "second"], [...CHAT_PLATFORMS]);
  await executeRun(run, new RunControl(), { ...fakeDeps(allAnswers), promptBudget: 1 });
  assert.equal(run.results.filter((r) => r.status === "pending").length, 3);
});

test("CSV preserves multiline quoted responses and finds Prompt column", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disco-csv-"));
  try {
    const file = path.join(dir, "prompts.csv");
    fs.writeFileSync(file, '\uFEFF"Run ID","Prompt","Category"\r\n"one","Which, \"\"gym\"\"?\nExplain.","training"\r\n');
    const prompts = promptsFromFile(file);
    assert.deepEqual(prompts, ['Which, "gym"?\nExplain.']);
    const run = createRun(prompts, ["chatgpt"]);
    run.results[0].output = { text: 'First, "quoted"\nSecond line ไทย', modelVersion: null };
    const csv = parseCsv(resultsCsv(run));
    assert.equal(csv.length, 2);
    assert.equal(csv[1][2], prompts[0]);
    assert.equal(csv[1][8], run.results[0].output.text);
    assert.equal(csv[1][5], "");
    assert.throws(() => parseCsv('"unclosed'), /unclosed/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("resume retains completed and failed entries; retry resets only failed and interrupted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disco-resume-"));
  try {
    const file = path.join(dir, "run.json");
    const run = createRun(["first"], [...CHAT_PLATFORMS]);
    run.results[0].status = "completed"; run.results[0].output = await answer();
    run.results[1].status = "failed"; run.results[1].error = "login required";
    run.results[2].status = "running";
    saveRun(file, run);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const resumed = readRun(file);
    assert.deepEqual(resumed.results.map((r) => r.status), ["completed", "failed", "pending"]);
    const calls: string[] = [];
    const deps = fakeDeps({ ...allAnswers, claude: async () => { calls.push("claude"); return answer(); } });
    await executeRun(resumed, new RunControl(), deps);
    assert.deepEqual(calls, ["claude"]);
    assert.deepEqual(readRun(file, true).results.map((r) => r.status), ["completed", "pending", "pending"]);
    const release = lockRun(file);
    assert.throws(() => lockRun(file), /already active/);
    release();
  } finally { fs.rmSync(dir, { recursive: true }); }
});

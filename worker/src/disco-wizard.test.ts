import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { choosePlatforms } from "./disco-wizard.js";
import { createRun } from "./local-run.js";

function terminal(initialRaw = false, paused = true) {
  const stream = new PassThrough();
  const input = Object.assign(stream, {
    isRaw: initialRaw,
    setRawMode(raw: boolean) { this.isRaw = raw; return this; },
  }) as unknown as NodeJS.ReadStream;
  const output = new PassThrough();
  if (paused) input.pause();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  return { input, output: output as unknown as NodeJS.WriteStream, text: () => text };
}

test("Enter accepts all platforms and restores terminal state", async () => {
  const tty = terminal();
  const pending = choosePlatforms(tty.input, tty.output);
  tty.input.emit("data", Buffer.from("\r"));
  assert.deepEqual(await pending, ["chatgpt", "gemini", "claude"]);
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.isPaused(), true);
  assert.equal(tty.input.listenerCount("keypress"), 0);
  assert.ok(tty.text().endsWith("\x1b[?25h"));
});

test("empty selection stays in picker; one AI produces only its capture", async () => {
  const tty = terminal();
  const pending = choosePlatforms(tty.input, tty.output);
  tty.input.emit("data", Buffer.from("a\r"));
  assert.match(tty.text(), /Select at least one AI model/);
  tty.input.emit("data", Buffer.from("\x1b[B \r"));
  const selected = await pending;
  assert.deepEqual(selected, ["gemini"]);
  assert.deepEqual(createRun(["Example prompt"], selected!).results.map((r) => r.platform), ["gemini"]);
});

test("checkboxes support multiple AIs and wrap arrow navigation", async () => {
  const tty = terminal();
  const pending = choosePlatforms(tty.input, tty.output);
  // Clear all, select ChatGPT, wrap upward to Claude, and select it.
  tty.input.emit("data", Buffer.from("a \x1b[A \r"));
  assert.deepEqual(await pending, ["chatgpt", "claude"]);
});

test("Esc and Ctrl+C cancel without creating a run and preserve raw mode", async () => {
  for (const key of [{ name: "escape" }, { name: "c", ctrl: true }]) {
    const tty = terminal(true);
    const pending = choosePlatforms(tty.input, tty.output);
    tty.input.emit("keypress", "", key);
    assert.equal(await pending, null);
    assert.equal(tty.input.isRaw, true);
    assert.equal(tty.input.listenerCount("end"), 0);
    assert.ok(tty.text().endsWith("\x1b[?25h"));
  }
});

test("cancelling idle stdin pauses it so the CLI can exit", async () => {
  const tty = terminal(false, false);
  assert.equal(tty.input.readableFlowing, null);
  const pending = choosePlatforms(tty.input, tty.output);
  tty.input.emit("keypress", "", { name: "c", ctrl: true });
  assert.equal(await pending, null);
  assert.equal(tty.input.isPaused(), true);
});

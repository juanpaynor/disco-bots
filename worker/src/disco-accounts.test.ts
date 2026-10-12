import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { accountIsConfigured, ensureAccounts, saveAccountSetup } from "./disco-accounts.js";
import type { ChatPlatform } from "./local-run.js";

test("setup records are private, scoped to a profile and contain no credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disco-accounts-"));
  try {
    assert.equal(accountIsConfigured("claude", dir), false);
    saveAccountSetup("claude", dir);
    assert.equal(accountIsConfigured("claude", dir), true);
    assert.equal(accountIsConfigured("gemini", dir), false);
    const file = path.join(dir, "claude", ".disco-account.json");
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort(), ["configuredAt", "platform", "version"]);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{"version":1,"platform":"gemini","configuredAt":"2026-10-12"}');
    assert.equal(accountIsConfigured("claude", dir), false);
    fs.writeFileSync(file, "broken JSON");
    assert.equal(accountIsConfigured("claude", dir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("first run sets up only selected missing accounts in sequence; later runs skip login", async () => {
  const configured = new Set<ChatPlatform>(["chatgpt"]);
  const opened: ChatPlatform[] = [];
  const options = {
    interactive: true,
    configured: (platform: ChatPlatform) => configured.has(platform),
    remote: () => false,
    login: async (platform: ChatPlatform) => { opened.push(platform); configured.add(platform); return true; },
  };
  assert.equal(await ensureAccounts(["chatgpt", "claude"], options), true);
  assert.deepEqual(opened, ["claude"]);
  assert.equal(await ensureAccounts(["chatgpt", "claude"], options), true);
  assert.deepEqual(opened, ["claude"]);
});

test("cancelling setup stops before opening subsequent accounts", async () => {
  const opened: ChatPlatform[] = [];
  assert.equal(await ensureAccounts(["claude", "gemini"], {
    interactive: true, configured: () => false, remote: () => false,
    login: async (platform) => { opened.push(platform); return false; },
  }), false);
  assert.deepEqual(opened, ["claude"]);
});

test("piped first runs explain login without opening browsers or consuming prompts", async () => {
  let opened = false;
  await assert.rejects(ensureAccounts(["chatgpt", "gemini"], {
    interactive: false, configured: (platform) => platform === "chatgpt", remote: () => false,
    login: async () => { opened = true; return true; },
  }), /disco --login --platforms gemini/);
  assert.equal(opened, false);
  assert.equal(await ensureAccounts(["chatgpt"], { interactive: false, configured: () => true, remote: () => false }), true);
  assert.equal(await ensureAccounts([], { interactive: false }), true);
});

test("hosted sessions stay provider-managed unless login is explicitly requested", async () => {
  const opened: ChatPlatform[] = [];
  const options = {
    interactive: true, configured: () => false, remote: () => true,
    login: async (platform: ChatPlatform) => { opened.push(platform); return true; },
  };
  assert.equal(await ensureAccounts(["chatgpt", "claude"], options), true);
  assert.deepEqual(opened, []);
  assert.equal(await ensureAccounts(["claude"], { ...options, force: true }), true);
  assert.deepEqual(opened, ["claude"]);
});

test("explicit login rechecks accounts even after setup was recorded", async () => {
  const opened: ChatPlatform[] = [];
  await ensureAccounts(["gemini"], {
    interactive: true, force: true, configured: () => true, remote: () => false,
    login: async (platform) => { opened.push(platform); return true; },
  });
  assert.deepEqual(opened, ["gemini"]);
});

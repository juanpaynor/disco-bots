import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { accountIsConfigured, accountIsReady, ACCOUNT_URLS, loginAccount } from "./disco-accounts.js";
import { sleep } from "./browser.js";
import type { ChatPlatform } from "./local-run.js";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false }); });
after(async () => { await browser?.close(); });

const chatgptComposer = '<div data-composer-markdown contenteditable="true" role="textbox">Ask ChatGPT</div>';
const claudeComposer = '<div class="ProseMirror" contenteditable="true">Ask Claude</div>';

async function fixture(platform: ChatPlatform, html: string, check: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  const page = await context.newPage();
  try { await page.goto(ACCOUNT_URLS[platform]); await check(page); }
  finally { await context.close(); }
}

test("ChatGPT guest access is rejected even with an editable composer", async () => {
  await fixture("chatgpt", chatgptComposer, async (page) => {
    assert.equal(await accountIsReady(page, "chatgpt"), false);
    await page.context().addCookies([{
      name: "__Secure-next-auth.session-token", value: "fixture-session", url: ACCOUNT_URLS.chatgpt,
      secure: true, httpOnly: true,
    }]);
    assert.equal(await accountIsReady(page, "chatgpt"), true);
    await page.setContent(chatgptComposer + '<button>Log in</button>');
    assert.equal(await accountIsReady(page, "chatgpt"), false);
  });
});

test("account menu identifies signed-in ChatGPT without requiring a specific cookie name", async () => {
  await fixture("chatgpt", chatgptComposer + '<button data-testid="accounts-profile-button">Profile</button>', async (page) => {
    assert.equal(await accountIsReady(page, "chatgpt"), true);
  });
});

test("Gemini and Claude require the correct site, a visible composer and no login wall", async () => {
  for (const [platform, composer] of [["gemini", '<rich-textarea><div contenteditable="true"></div></rich-textarea>'], ["claude", claudeComposer]] as const) {
    await fixture(platform, composer, async (page) => {
      assert.equal(await accountIsReady(page, platform), true);
      await page.setContent(composer + '<a href="/login">Sign in with Google</a>');
      assert.equal(await accountIsReady(page, platform), false);
      await page.setContent('<div hidden>' + composer + '</div>');
      assert.equal(await accountIsReady(page, platform), false);
      await page.setContent(composer + '<h1>Verify you are human</h1>');
      assert.equal(await accountIsReady(page, platform), false);
      await page.goto(ACCOUNT_URLS[platform] + "/login");
      assert.equal(await accountIsReady(page, platform), false);
      await page.goto("https://accounts.google.com/");
      assert.equal(await accountIsReady(page, platform), false);
    });
  }
});

async function loginFixture(check: (fixture: {
  context: BrowserContext; page: Page; input: PassThrough; text: () => string;
  dir: string; pending: Promise<boolean>;
}) => Promise<void>, signedIn = false): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disco-login-"));
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.fulfill({
    contentType: "text/html", body: signedIn ? claudeComposer : '<a href="/login">Sign in</a>',
  }));
  const page = await context.newPage();
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const pending = loginAccount("claude", {
    launch: async (platform, options) => {
      assert.equal(platform, "claude");
      assert.deepEqual(options, { headless: false, viewport: null, handleSIGINT: false, handleSIGTERM: false });
      return context;
    },
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    profileDir: dir,
  });
  try { await check({ context, page, input, text: () => text, dir, pending }); }
  finally {
    await context.close();
    input.end();
    await pending;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Fixture did not reach expected state");
    await sleep(25);
  }
}

test("Enter before login cannot save setup; verified login saves it and closes the browser", async () => {
  await loginFixture(async ({ page, input, text, dir, pending }) => {
    await until(() => text().includes("Press Enter"));
    assert.equal(accountIsConfigured("claude", dir), false);
    input.write("\n");
    await until(() => text().split("Press Enter").length === 3);
    assert.equal(accountIsConfigured("claude", dir), false);
    await page.setContent(claudeComposer);
    input.write("\n");
    assert.equal(await pending, true);
    assert.equal(accountIsConfigured("claude", dir), true);
    assert.equal(page.isClosed(), true);
  });
});

test("closing setup input cancels, closes the browser and leaves no setup record", async () => {
  await loginFixture(async ({ page, input, text, dir, pending }) => {
    await until(() => text().includes("Press Enter"));
    input.end();
    assert.equal(await pending, false);
    assert.equal(page.isClosed(), true);
    assert.equal(accountIsConfigured("claude", dir), false);
  });
});

test("Ctrl+C during startup closes the browser without recording setup", async () => {
  await loginFixture(async ({ page, text, dir, pending }) => {
    await until(() => page.url() === ACCOUNT_URLS.claude);
    process.emit("SIGINT");
    assert.equal(await pending, false);
    assert.equal(page.isClosed(), true);
    assert.equal(text(), "");
    assert.equal(accountIsConfigured("claude", dir), false);
  });
});

test("existing signed-in profiles complete setup without requesting terminal input", async () => {
  await loginFixture(async ({ page, text, dir, pending }) => {
    assert.equal(await pending, true);
    assert.equal(text(), "");
    assert.equal(page.isClosed(), true);
    assert.equal(accountIsConfigured("claude", dir), true);
  }, true);
});

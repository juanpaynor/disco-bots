import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { assertClaudeReady, ClaudeScrapeError, readClaudeSnapshot, scrape, waitForClaudeAnswer } from "./claude.js";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(html: string, check: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try { await page.setContent(html); await check(page); }
  finally { await page.close(); }
}

const timing = { timeoutMs: 1200, stableMs: 100, intervalMs: 20 };
const hasCode = (code: string) => (error: unknown) => error instanceof ClaudeScrapeError && error.code === code;

test("captures assistant blocks in order without nested duplicates or hidden text", async () => {
  await fixture(`<div data-testid="user-message">User prompt</div>
    <div data-testid="assistant-message"><div class="font-claude-message">First</div></div>
    <div class="font-claude-message" style="display:none">Hidden</div>
    <div class="font-claude-message">Second</div>`, async (page) => {
    assert.equal((await readClaudeSnapshot(page)).text, "First\n\nSecond");
  });
});

test("excludes the accessibility answer preview from current message wrappers", async () => {
  await fixture(`<div data-testid="assistant-message">
    <h2 class="sr-only">Claude responded: 391</h2>
    <div class="font-claude-response"><p>391</p></div>
  </div><button aria-label="Copy response">Copy</button>`, async (page) => {
    assert.equal((await readClaudeSnapshot(page)).text, "391");
  });
});

test("does not finish during a long streaming pause, even with copy controls", async () => {
  await fixture(`<div class="font-claude-message">Preamble</div>
    <button aria-label="Stop response">Stop</button><button aria-label="Copy">Copy</button>`, async (page) => {
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector(".font-claude-message")!.textContent = "Complete response";
        document.querySelector('[aria-label="Stop response"]')!.remove();
      }, 350);
    });
    assert.equal(await waitForClaudeAnswer(page, timing), "Complete response");
  });
});

test("accepts a fast completed answer without observing a stop button", async () => {
  await fixture('<div class="font-claude-message">Yes.</div><button aria-label="Copy response">Copy</button>', async (page) => {
    assert.equal(await waitForClaudeAnswer(page, timing), "Yes.");
  });
});

test("rejects stable partial text without completion evidence", async () => {
  await fixture('<div class="font-claude-message">Partial text</div>', async (page) => {
    await assert.rejects(waitForClaudeAnswer(page, { ...timing, timeoutMs: 250 }), hasCode("INCOMPLETE"));
  });
});

test("retry buttons and code copy buttons do not prove answer completion", async () => {
  await fixture(`<div class="font-claude-message">Partial text<pre><code>example</code><button aria-label="Copy">Copy</button></pre></div>
    <button aria-label="Retry">Retry</button>`, async (page) => {
    await assert.rejects(waitForClaudeAnswer(page, { ...timing, timeoutMs: 250 }), hasCode("INCOMPLETE"));
  });
});

test("recognizes login, access challenges, usage limits and platform errors", async () => {
  for (const [html, code] of [
    ['<a href="/login">Sign in</a>', "LOGIN_REQUIRED"],
    ["<title>Just a moment...</title>", "BLOCKED"],
    ['<div role="alert">Message limit reached. Try again after 5pm.</div>', "RATE_LIMITED"],
    ['<div role="alert">You have reached your free message limit.</div>', "RATE_LIMITED"],
    ['<div role="alert">Something went wrong</div>', "PLATFORM_ERROR"],
    ['<div class="font-claude-message">Something went wrong. Retry</div>', "PLATFORM_ERROR"],
  ]) {
    await fixture(html!, async (page) => {
      await assert.rejects(waitForClaudeAnswer(page, timing), hasCode(code!));
    });
  }
});

test("does not classify an answer about rate limits as an interface failure", async () => {
  await fixture(`<div class="font-claude-message">The phrase 'something went wrong' describes an error. A rate limit restricts usage.</div>
    <button aria-label="Copy response">Copy</button>`, async (page) => {
    assertClaudeReady(await readClaudeSnapshot(page));
    assert.match(await waitForClaudeAnswer(page, timing), /restricts usage/);
  });
});

test("declines the Pro promotion without treating higher usage limits as an exhausted allowance", async () => {
  await fixture(`<div class="font-claude-message">Complete response</div><button aria-label="Copy response">Copy</button>
    <div role="dialog"><h2>Use Opus 5.5 with Claude Pro</h2><p>Higher usage limits</p>
      <button>Upgrade to Pro</button><button onclick="this.closest('[role=dialog]').remove()">Not now</button></div>`, async (page) => {
    assertClaudeReady(await readClaudeSnapshot(page));
    assert.equal(await waitForClaudeAnswer(page, timing), "Complete response");
    assert.equal(await page.getByRole("dialog").count(), 0);
  });
});

test("late interface failure interrupts generation instead of completing", async () => {
  await fixture('<div class="font-claude-message">Working...</div><button aria-label="Stop response">Stop</button>', async (page) => {
    await page.evaluate(() => setTimeout(() => {
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = "Usage limit exceeded";
      document.body.append(alert);
    }, 100));
    await assert.rejects(waitForClaudeAnswer(page, timing), hasCode("RATE_LIMITED"));
  });
});

test("full adapter saves successful evidence, metadata and conversation URL", async () => {
  const context = await browser.newContext();
  const dir = await mkdtemp(path.join(tmpdir(), "aidisco-claude-success-"));
  try {
    await context.route("https://claude.ai/**", (route) => route.fulfill({ contentType: "text/html", body: `
      <div class="ProseMirror" contenteditable="true"></div>
      <button data-testid="model-selector-dropdown">Fixture model</button>
      <script>document.querySelector('.ProseMirror').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        history.pushState({}, '', '/chat/fixture');
        document.body.insertAdjacentHTML('beforeend', '<div data-testid="assistant-message"><div class="font-claude-message">A full fixture answer.</div></div><button aria-label="Copy response">Copy</button>');
      });</script>` }));
    const result = await scrape(context, "Hi", { evidenceDir: dir, timeoutMs: 5000 });
    assert.equal(result.text, "A full fixture answer.");
    assert.equal(result.modelVersion, "Fixture model");
    assert.equal(result.resultUrl, "https://claude.ai/chat/fixture");
    assert.equal(context.pages().length, 0);
    assert.ok((await stat(result.screenshotPath!)).size > 0);
    const json = JSON.parse(await readFile(result.screenshotPath!.replace(/\.png$/, ".json"), "utf8"));
    assert.equal(json.status, "completed");
    assert.equal(json.rawResponse, result.text);
    assert.equal(json.freshSearch, true);
    assert.match(json.completionEvidence, /generation inactive/);
  } finally { await context.close(); }
});

test("full adapter saves partial failure evidence and closes the tab", async () => {
  const context = await browser.newContext();
  const dir = await mkdtemp(path.join(tmpdir(), "aidisco-claude-partial-"));
  try {
    await context.route("https://claude.ai/**", (route) => route.fulfill({ contentType: "text/html", body: `
      <div class="ProseMirror" contenteditable="true"></div>
      <script>document.querySelector('.ProseMirror').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        document.body.insertAdjacentHTML('beforeend', '<div class="font-claude-message">Unfinished answer</div><button aria-label="Stop response">Stop</button>');
      });</script>` }));
    await assert.rejects(scrape(context, "Hi", { evidenceDir: dir, timeoutMs: 250 }), hasCode("INCOMPLETE"));
    assert.equal(context.pages().length, 0);
    const file = (await readdir(dir)).find((name) => name.endsWith(".json"))!;
    const json = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    assert.equal(json.status, "failed");
    assert.equal(json.errorCode, "INCOMPLETE");
    assert.equal(json.rawResponse, "Unfinished answer");
    assert.equal(json.completionEvidence, null);
  } finally { await context.close(); }
});

test("three sequential captures reuse the caller's tab and start fresh conversations", async () => {
  const context = await browser.newContext();
  const dir = await mkdtemp(path.join(tmpdir(), "aidisco-claude-batch-"));
  const page = await context.newPage();
  let navigations = 0;
  try {
    await context.route("https://claude.ai/**", (route) => {
      const run = ++navigations;
      return route.fulfill({ contentType: "text/html", body: `
        <div class="ProseMirror" contenteditable="true"></div>
        <script>document.querySelector('.ProseMirror').addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          history.pushState({}, '', '/chat/fixture-${run}');
          document.body.insertAdjacentHTML('beforeend', '<div class="font-claude-message">Answer ${run}</div><button aria-label="Copy response">Copy</button>');
        });</script>` });
    });
    const evidencePaths = new Set<string>();
    for (let i = 1; i <= 3; i++) {
      const result = await scrape(context, "Hi", { evidenceDir: dir, timeoutMs: 5000, page });
      assert.equal(result.text, `Answer ${i}`);
      assert.equal(result.resultUrl, `https://claude.ai/chat/fixture-${i}`);
      assert.deepEqual(context.pages(), [page]);
      assert.equal(page.isClosed(), false);
      evidencePaths.add(result.screenshotPath!);
      const json = JSON.parse(await readFile(result.screenshotPath!.replace(/\.png$/, ".json"), "utf8"));
      assert.equal(json.status, "completed");
      assert.equal(json.freshSearch, true);
    }
    assert.equal(navigations, 3);
    assert.equal(evidencePaths.size, 3);
  } finally { await context.close(); }
});

test("rejects a restored conversation before submitting another prompt", async () => {
  const context = await browser.newContext();
  const dir = await mkdtemp(path.join(tmpdir(), "aidisco-claude-restored-"));
  try {
    await context.route("https://claude.ai/**", (route) => route.fulfill({ contentType: "text/html", body:
      '<div class="ProseMirror" contenteditable="true"></div><div class="font-claude-message">Previous answer</div>' }));
    await assert.rejects(scrape(context, "Hi", { evidenceDir: dir }), hasCode("PLATFORM_ERROR"));
    assert.equal(context.pages().length, 0);
    const file = (await readdir(dir)).find((name) => name.endsWith(".json"))!;
    const json = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    assert.equal(json.freshSearch, false);
  } finally { await context.close(); }
});

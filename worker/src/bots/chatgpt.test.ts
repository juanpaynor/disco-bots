import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { readChatgptSnapshot, SEL, waitForAnswer } from "./chatgpt.js";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(html: string, check: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try { await page.setContent(html); await check(page); }
  finally { await page.close(); }
}

test("finds current editor when a legacy textarea is hidden", async () => {
  await fixture('<textarea name="prompt" hidden></textarea><div data-composer-markdown contenteditable="true" role="textbox" aria-label="Ask ChatGPT"></div>', async (page) => {
    assert.equal(await page.locator(SEL.composer).filter({ visible: true }).first().getAttribute("role"), "textbox");
  });
});

test("captures current assistant prose, excludes user content and nested duplicates", async () => {
  await fixture(`<div data-chatgpt-search-unit-key="turn:0:user">User prompt<button aria-label="Copy message"></button></div>
    <div data-chatgpt-search-unit-key="turn:1:assistant"><div data-message-author-role="assistant"><div data-markdown-text-style="assistant-message">391</div></div><button aria-label="Copy"></button></div>`, async (page) => {
    assert.deepEqual(await readChatgptSnapshot(page), { text: "391", generating: false, completionAction: true });
    await waitForAnswer(page, 5000);
  });
});

test("user copy and code copy controls do not confirm an assistant answer", async () => {
  await fixture(`<div data-chatgpt-search-unit-key="turn:0:user"><button aria-label="Copy message"></button></div>
    <div data-chatgpt-search-unit-key="turn:1:assistant"><div data-markdown-text-style="assistant-message">Partial<pre><code>code</code><button aria-label="Copy"></button></pre></div></div>`, async (page) => {
    assert.equal((await readChatgptSnapshot(page)).completionAction, false);
    await assert.rejects(waitForAnswer(page, 100), /timed out/);
  });
});

test("active generation never returns a partial answer, including on timeout", async () => {
  await fixture(`<article><div data-markdown-text-style="assistant-message">Partial response</div><button aria-label="Copy"></button></article><button aria-label="Stop"></button>`, async (page) => {
    assert.equal((await readChatgptSnapshot(page)).generating, true);
    await assert.rejects(waitForAnswer(page, 100), /timed out/);
  });
});

test("legacy message and response controls remain supported", async () => {
  await fixture('<article><div data-message-author-role="assistant">Legacy answer</div><button data-testid="copy-turn-action-button"></button></article>', async (page) => {
    assert.deepEqual(await readChatgptSnapshot(page), { text: "Legacy answer", generating: false, completionAction: true });
  });
});

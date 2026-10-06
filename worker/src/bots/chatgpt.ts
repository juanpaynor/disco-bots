import type { BrowserContext } from "playwright";
import { humanType, jitter, waitForSettledText } from "../browser.js";
import type { ScrapeOutput } from "../types.js";

// Selectors WILL rot — these UIs redesign often. Keep them in one place so a
// break is a one-line fix rather than an archaeology session.
const SEL = {
  composer: '#prompt-textarea, div[contenteditable="true"]',
  send: '[data-testid="send-button"], button[aria-label*="Send"]',
  message: '[data-message-author-role="assistant"]',
  model: '[data-testid="model-switcher-dropdown-button"]',
  loginWall: '[data-testid="login-button"], a[href*="/auth/login"]',
};

export async function scrape(context: BrowserContext, prompt: string): Promise<ScrapeOutput> {
  const page = await context.newPage();
  try {
    // Fresh chat per prompt: prior turns in the same thread contaminate the answer.
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
    await jitter();

    if (await page.locator(SEL.loginWall).first().isVisible().catch(() => false)) {
      throw new Error("chatgpt: not logged in — run `npm run login -- chatgpt`");
    }

    await page.waitForSelector(SEL.composer, { timeout: 30_000 });
    await humanType(page, SEL.composer, prompt);
    await jitter(600, 1500);
    await page.keyboard.press("Enter");

    const text = await waitForSettledText(page, SEL.message);
    const modelVersion = await page
      .locator(SEL.model)
      .first()
      .innerText()
      .catch(() => null);

    return { text, modelVersion: modelVersion?.trim() ?? null };
  } finally {
    await page.close();
  }
}

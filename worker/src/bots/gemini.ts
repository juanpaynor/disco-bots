import type { BrowserContext } from "playwright";
import { humanType, jitter, waitForSettledText } from "../browser.js";
import type { ScrapeOutput } from "../types.js";

const SEL = {
  composer: 'rich-textarea div[contenteditable="true"], .ql-editor',
  message: "message-content, .model-response-text",
  model: "bard-mode-switcher button, [data-test-id='bard-mode-menu-button']",
  loginWall: 'a[href*="accounts.google.com"]',
};

export async function scrape(context: BrowserContext, prompt: string): Promise<ScrapeOutput> {
  const page = await context.newPage();
  try {
    await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
    await jitter();

    if (await page.locator(SEL.loginWall).first().isVisible().catch(() => false)) {
      throw new Error("gemini: not logged in — run `npm run login -- gemini`");
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

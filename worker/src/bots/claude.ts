import type { BrowserContext } from "playwright";
import { humanType, jitter, waitForSettledText } from "../browser.js";
import type { ScrapeOutput } from "../types.js";

const SEL = {
  composer: 'div[contenteditable="true"].ProseMirror, fieldset div[contenteditable="true"]',
  message: '[data-testid="assistant-message"], .font-claude-message',
  model: '[data-testid="model-selector-dropdown"]',
  loginWall: 'a[href*="/login"], button:has-text("Sign in")',
};

export async function scrape(context: BrowserContext, prompt: string): Promise<ScrapeOutput> {
  const page = await context.newPage();
  try {
    await page.goto("https://claude.ai/new", { waitUntil: "domcontentloaded" });
    await jitter();

    if (await page.locator(SEL.loginWall).first().isVisible().catch(() => false)) {
      throw new Error("claude: not logged in — run `npm run login -- claude`");
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

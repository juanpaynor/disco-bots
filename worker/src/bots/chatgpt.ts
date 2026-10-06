import type { BrowserContext } from "playwright";
import type { Page } from "playwright";
import { jitter, sleep } from "../browser.js";
import { config } from "../config.js";
import type { ScrapeOutput } from "../types.js";

/**
 * Selectors verified live against chatgpt.com.
 *
 * ChatGPT no longer uses the data-testid-rich markup older scrapers target, and
 * its class names are obfuscated atomic CSS (x1heor9g, xu4ur08…) which are
 * useless as anchors. What it does expose is a set of semantic data-attributes
 * on the transcript — those are what we key off.
 */
const SEL = {
  composer: 'textarea[name="prompt"]',
  transcript: "ol[data-conversation-transcript]",
  assistantTurn: 'li[data-message-role="assistant"]',
  markdown: "[data-assistant-markdown]",
};

// Anonymous sessions get rate-limited by IP. Worth retrying later, not burning
// an attempt on a dead selector hunt.
const RATE_LIMIT_PATTERNS = [
  /reached our limit of messages/i,
  /you've hit the free plan limit/i,
  /please try again later/i,
];

/**
 * Wait for the answer to actually finish.
 *
 * Two signals, and BOTH are required:
 *  - every assistant turn carries data-message-complete
 *  - the joined text has stopped growing
 *
 * Neither is sufficient alone. data-message-complete fires on the first turn
 * while ChatGPT is still running a research step and about to emit more, so
 * trusting it alone truncates answers to the preamble. Text-stability alone
 * fires during the pause before streaming starts.
 */
async function waitForAnswer(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const requiredStable = 6; // 6 x 500ms = 3s unchanged
  let prev = -1;
  let stable = 0;
  let sawGeneration = false;

  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const turns = [...document.querySelectorAll('li[data-message-role="assistant"]')];
      // The composer button is the clearest generating/idle signal the UI gives:
      // it reads "Stop generating" while a response is in flight and flips back
      // to "Send message" the moment it is not.
      const generating = [...document.querySelectorAll("button")].some((b) =>
        /stop generating/i.test(b.getAttribute("aria-label") ?? "")
      );
      return {
        generating,
        // Elements carry data-streaming-stylex-tokens only while tokens land.
        streamingEls: document.querySelectorAll("[data-streaming-stylex-tokens]").length,
        allComplete: turns.length > 0 && turns.every((t) => t.hasAttribute("data-message-complete")),
        total: turns.map((t) => (t as HTMLElement).innerText).join("\n").length,
      };
    });

    if (s.generating || s.streamingEls > 0) sawGeneration = true;

    if (s.total === prev) stable++;
    else { stable = 0; prev = s.total; }

    const idle = !s.generating && s.streamingEls === 0;
    if (sawGeneration && idle && s.allComplete && stable >= requiredStable && s.total > 0) return;
    await sleep(500);
  }
  if (prev > 0) return; // partial answer beats no answer
  throw new Error(`timed out after ${timeoutMs}ms waiting for an answer`);
}

export async function scrape(context: BrowserContext, prompt: string): Promise<ScrapeOutput> {
  const page = await context.newPage();
  try {
    // Fresh conversation each time — earlier turns in a thread skew the answer.
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });

    const composer = page.locator(SEL.composer).first();
    await composer.waitFor({ state: "visible", timeout: 45_000 });
    await jitter(1500, 3000);

    await composer.click();
    await composer.type(prompt, { delay: 20 + Math.random() * 50 });
    await jitter(700, 1600);
    await page.keyboard.press("Enter");

    await waitForAnswer(page, config.responseTimeoutMs);

    // Prefer the markdown body: it is the prose answer, without the
    // "ChatGPT said:" screen-reader prefix or the duplicated text that rich
    // widgets (local business cards, etc.) inject into the turn's innerText.
    const mdParts = await page.locator(SEL.markdown).allInnerTexts();
    let text = mdParts.join("\n\n").trim();

    if (!text) {
      const turns = await page.locator(SEL.assistantTurn).allInnerTexts();
      text = turns.join("\n\n").replace(/^ChatGPT said:\s*/i, "").trim();
    }

    if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) {
      throw new Error(`rate limited: ${text.slice(0, 120)}`);
    }
    if (!text) throw new Error("no answer text found — selectors may have rotted");

    // Anonymous sessions expose no model switcher, so there is nothing to read.
    const modelVersion = await page
      .locator('[data-testid="model-switcher-dropdown-button"]')
      .first()
      .innerText()
      .catch(() => null);

    return {
      text,
      modelVersion: modelVersion?.trim() || "anonymous",
    };
  } finally {
    await page.close();
  }
}

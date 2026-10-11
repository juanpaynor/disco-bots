import type { BrowserContext } from "playwright";
import type { ScrapeOutput } from "../types.js";

/**
 * Google Search surface — NOT YET IMPLEMENTED.
 *
 * This is a genuinely different scrape from the chat platforms. Gary's grid
 * wants three Google-only columns:
 *   - AI Overview present?      (is the AIO box rendered at all)
 *   - Brand in AI Overview?     (named inside that box specifically)
 *   - Brand organic rank        (position in the blue links, separately)
 *
 * So it needs SERP parsing, not answer capture, and the AI Overview box is
 * inconsistently served — it varies by query, account, geo and session. Needs
 * the same live DOM probing the ChatGPT selectors got before it can be trusted.
 *
 * Failing loudly here is deliberate: a stub that returned empty strings would
 * silently fill 40 grid rows with "not mentioned", which is indistinguishable
 * from a real negative result and would quietly corrupt the audit.
 */
export async function scrape(_context: BrowserContext, _prompt: string): Promise<ScrapeOutput> {
  throw new Error(
    "google: scraper not implemented — SERP + AI Overview parsing still to be built"
  );
}

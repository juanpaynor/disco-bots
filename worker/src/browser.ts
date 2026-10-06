import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import { config } from "./config.js";
import type { Platform } from "./types.js";

/**
 * One persistent profile per platform. Cookies and local storage live on disk,
 * so a login survives both process restarts and Railway deploys — provided
 * PROFILE_DIR points at a mounted volume in production.
 */
export async function launchContext(platform: Platform): Promise<BrowserContext> {
  const userDataDir = path.join(config.profileDir, platform);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: config.headless,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "Asia/Manila",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage", // containers give /dev/shm 64MB; Chromium needs more
    ],
  });

  // navigator.webdriver is the single most-checked automation tell.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return context;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Random pause, so inter-action timing isn't machine-regular. */
export function jitter(minMs = 1200, maxMs = 3500): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

/** Type with variable per-character delay rather than pasting the whole string. */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.click();
  for (const ch of text) {
    await el.type(ch, { delay: 15 + Math.random() * 65 });
  }
}

/**
 * Wait for a streaming answer to settle.
 *
 * Every one of these UIs streams tokens in, and none exposes a reliable "done"
 * signal that survives a redesign. Polling for the text to stop growing is ugly
 * but it is the one approach that doesn't break every time they ship a new
 * stop-button class name.
 *
 * Returns the settled text. Throws if nothing ever appears.
 */
export async function waitForSettledText(
  page: Page,
  selector: string,
  opts: { timeoutMs?: number; stableChecks?: number; intervalMs?: number } = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? config.responseTimeoutMs;
  const stableChecks = opts.stableChecks ?? 4; // 4 x 750ms = 3s unchanged
  const intervalMs = opts.intervalMs ?? 750;

  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stable = 0;

  while (Date.now() < deadline) {
    const current = await page
      .locator(selector)
      .last()
      .innerText()
      .catch(() => "");

    if (current && current === last) {
      stable += 1;
      if (stable >= stableChecks) return current.trim();
    } else {
      stable = 0;
      last = current;
    }
    await sleep(intervalMs);
  }

  if (last.trim()) {
    // Timed out but we have partial text — better to keep it and flag than lose it.
    return last.trim();
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a response at "${selector}"`);
}

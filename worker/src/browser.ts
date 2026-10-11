import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import { config } from "./config.js";
import type { Platform } from "./types.js";

/**
 * One persistent profile per platform. Cookies and local storage live on disk,
 * so a login survives both process restarts and Railway deploys — provided
 * PROFILE_DIR points at a mounted volume in production.
 */
export async function launchContext(
  platform: Platform,
  options: { headless?: boolean; viewport?: { width: number; height: number } | null } = {}
): Promise<BrowserContext> {
  // --- Hosted browser path -------------------------------------------------
  // When BROWSER_CDP_URL is set we do not run a browser at all: we attach to one
  // running at a provider (Browserbase, Steel, Browserless, or any Chrome started
  // with --remote-debugging-port). That provider owns stealth, proxies and the
  // display, so xvfb and the proxy config below are all bypassed.
  //
  // Session persistence is the provider's job here, NOT the local profile dir.
  // Each provider keeps logins in its own construct (Browserbase "contexts",
  // Steel sessions); pass that id through the URL so the same account comes back.
  const cdpUrl = config.cdpUrlFor(platform);
  if (cdpUrl) {
    console.log(`[${platform}] attaching to hosted browser`);
    const browser = await chromium.connectOverCDP(cdpUrl);
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error(`${platform}: hosted browser returned no context`);
    return ctx;
  }

  // --- Local browser path --------------------------------------------------
  const userDataDir = path.join(config.profileDir, platform);
  const proxy = config.proxyFor(platform);
  if (proxy) console.log(`[${platform}] routing via proxy ${proxy.server}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless ?? config.headless,
    ...(config.browserChannel ? { channel: config.browserChannel } : {}),
    ...(proxy ? { proxy } : {}),
    viewport: options.viewport === undefined ? { width: 1440, height: 900 } : options.viewport,
    // Geo-neutral by default: the prompt sheet specifies "Neutral (no location
    // set)", so the browser must not volunteer a locale or timezone that skews
    // answers. UTC and en-US are the neutral baseline.
    locale: config.locale,
    timezoneId: config.timezone,
    // Grant NO permissions. An empty list means a site asking for precise
    // location is denied rather than prompted — a prompt left hanging can block
    // the page, and a grant would defeat the neutral market condition outright.
    permissions: [],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage", // containers give /dev/shm 64MB; Chromium needs more
    ],
  });

  // navigator.webdriver is the single most-checked automation tell.
  // Keep this as browser-native source: tsx can inject a Node-only __name
  // helper into nested functions when serializing an init-script callback.
  await context.addInitScript({ content:
    'Object.defineProperty(navigator, "webdriver", { get: () => undefined });'
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

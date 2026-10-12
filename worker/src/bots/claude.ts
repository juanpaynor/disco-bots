import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { captureScreenshot, humanType, jitter, sleep } from "../browser.js";
import { config } from "../config.js";
import type { ScrapeOutput } from "../types.js";

// UI-dependent selectors need signed-in live verification after redesigns.
export const SEL = {
  composer: 'div[contenteditable="true"].ProseMirror, fieldset div[contenteditable="true"]',
  message: '[data-testid="assistant-message"], [data-testid="assistant-response"], .font-claude-message',
  model: '[data-testid="model-selector-dropdown"], [data-testid="model-selector"]',
  loginWall: 'a[href*="/login"], button:has-text("Sign in"), button:has-text("Log in")',
};

export type ClaudeErrorCode = "LOGIN_REQUIRED" | "RATE_LIMITED" | "PLATFORM_ERROR" | "BLOCKED" | "INCOMPLETE";

export class ClaudeScrapeError extends Error {
  evidencePath?: string;
  constructor(readonly code: ClaudeErrorCode, message: string) {
    super(`claude: ${message}`);
    this.name = "ClaudeScrapeError";
  }
}

export interface ClaudeSnapshot {
  text: string;
  generating: boolean;
  completionAction: boolean;
  uiError: string;
  loginRequired: boolean;
  blocked: boolean;
}

export async function readClaudeSnapshot(page: Page): Promise<ClaudeSnapshot> {
  const state = await page.evaluate(({ message }) => {
    // Method syntax avoids tsx injecting name helpers into browser-side code.
    const dom = {
      visible(el: Element) {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
      },
      label(el: Element) {
        return (el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText).trim();
      },
    };
    const messages = [...document.querySelectorAll(message)].filter(dom.visible);
    // An outer test-id and inner typography class can match the same response.
    const roots = messages.filter((el) => !messages.some((other) => other !== el && other.contains(el)));
    const buttons = [...document.querySelectorAll("button")].filter(dom.visible);
    const generating = buttons.some((b) =>
      /^stop(?:\s+(?:response|generating|generation|streaming))?$/i.test(dom.label(b)) ||
      /stop-(?:response|generating)/i.test(b.getAttribute("data-testid") ?? "")
    ) || [...document.querySelectorAll('[data-is-streaming="true"], [data-testid="assistant-message"][aria-busy="true"]')].some(dom.visible);
    const completionAction = buttons.some((b) =>
      !b.closest('pre, code, [data-testid*="code"]') && (
        /^copy(?: response| message)?$/i.test(dom.label(b)) ||
        b.getAttribute("data-testid") === "action-bar-copy"
      )
    );
    // Read UI errors separately from prose, which can discuss the same phrases.
    const uiError = [...document.querySelectorAll('[role="alert"], [role="dialog"], [data-testid*="error"], [data-testid*="limit"], [data-testid="toast"]')]
      .filter((el) => dom.visible(el) && !roots.some((root) => root.contains(el)))
      .map((el) => (el as HTMLElement).innerText).join("\n");
    return {
      // Current message wrappers also contain a screen-reader heading that
      // repeats the answer preview. Read the prose body when it is available.
      text: roots.map((el) => ((el.querySelector(".font-claude-response, .font-claude-message") ?? el) as HTMLElement).innerText.trim()).filter(Boolean).join("\n\n"),
      generating, completionAction, uiError,
      blocked: /just a moment|attention required|access denied/i.test(document.title) ||
        [...document.querySelectorAll("h1, h2")].filter(dom.visible).some((el) => /verify you are human/i.test(el.textContent ?? "")),
    };
  }, { message: SEL.message });
  const loginRequired = /\/(?:login|signup)(?:[/?#]|$)/i.test(page.url()) ||
    await page.locator(SEL.loginWall).filter({ visible: true }).count() > 0;
  return { ...state, loginRequired };
}

export function assertClaudeReady(state: ClaudeSnapshot): void {
  if (state.blocked) throw new ClaudeScrapeError("BLOCKED", "browser verification or access block requires manual attention");
  if (state.loginRequired) throw new ClaudeScrapeError("LOGIN_REQUIRED", "not logged in — run `npm run login -- claude`");
  if (/\b(?:(?:usage|messages?|rate) limits?\s+(?:reached|exceeded)|(?:reached|exceeded|hit)(?:\s+\w+){0,5}\s+limits?|rate[- ]limited|out of (?:messages|usage)|too many requests|try again (?:in|after)|resets? (?:at|in))\b/i.test(state.uiError)) {
    throw new ClaudeScrapeError("RATE_LIMITED", "usage limit reported by the interface; pause this platform");
  }
  if (/something went wrong|(?:network|connection|server|unexpected) error|unable to (?:complete|respond)|temporarily unavailable|overloaded|failed to (?:fetch|generate)/i.test(state.uiError)) {
    throw new ClaudeScrapeError("PLATFORM_ERROR", "the interface reported a response error");
  }
  if (/^(?:something went wrong|network error|error generating (?:a |the )?response)[.!]?(?:\s+(?:please )?(?:try again|retry)[.!]?)?$/i.test(state.text.trim())) {
    throw new ClaudeScrapeError("PLATFORM_ERROR", "error banner captured instead of an answer");
  }
}

async function dismissClaudePromotion(page: Page): Promise<void> {
  // Claude can show this upsell after a completed answer. Dismiss only its
  // explicit decline action; other dialogs (including real limits) stay intact.
  const promotion = page.getByRole("dialog").filter({ hasText: "Upgrade to Pro" }).filter({ visible: true });
  const notNow = promotion.getByText("Not now", { exact: true }).first();
  if (await notNow.isVisible()) await notNow.click({ timeout: 1000 });
}

export async function waitForClaudeAnswer(
  page: Page,
  options: { timeoutMs?: number; stableMs?: number; intervalMs?: number } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? config.responseTimeoutMs;
  const stableMs = options.stableMs ?? 3000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await dismissClaudePromotion(page);
    const state = await readClaudeSnapshot(page);
    assertClaudeReady(state);
    // Restart stability while generation is active, even if text is paused.
    if (state.text !== previous || state.generating || !state.completionAction) stableSince = Date.now();
    previous = state.text;
    if (state.text && !state.generating && state.completionAction && Date.now() - stableSince >= stableMs) return state.text;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  // scrape() retains partial text in diagnostics, never as a completed result.
  throw new ClaudeScrapeError("INCOMPLETE", `no confirmed completed response within ${timeoutMs}ms`);
}

export interface ClaudeOptions {
  timeoutMs?: number;
  evidenceDir?: string;
  /** Optional caller-owned tab for sequential verification; jobs get their own. */
  page?: Page;
}

export async function scrape(context: BrowserContext, prompt: string, options: ClaudeOptions = {}): Promise<ScrapeOutput> {
  if (!prompt.trim()) throw new Error("claude: prompt must not be empty");
  const timeoutMs = options.timeoutMs ?? config.responseTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("claude: timeout must be positive");
  const page = options.page ?? await context.newPage();
  const dir = path.resolve(options.evidenceDir ?? path.join(process.env.CAPTURE_DIR ?? "captures", "claude"));
  const stem = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  const evidencePath = `${stem}.json`;
  const screenshotPath = `${stem}.png`;
  let modelVersion: string | null = null;
  let text = "";
  let stage = "navigation";
  let freshSearch = false;

  async function evidence(error?: unknown): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let screenshotError: string | undefined;
    try {
      await captureScreenshot(page, { path: screenshotPath, fullPage: true, animations: "disabled", timeout: 10_000 });
      await chmod(screenshotPath, 0o600);
    } catch {
      screenshotError = "Screenshot unavailable (page may have closed or crashed)";
    }
    if (!text) text = (await readClaudeSnapshot(page).catch(() => null))?.text ?? "";
    await writeFile(evidencePath, JSON.stringify({
      platform: "claude", capturedAt: new Date().toISOString(), status: error ? "failed" : "completed",
      stage, prompt, rawResponse: text, modelVersion, resultUrl: page.url(), freshSearch,
      completionEvidence: error ? null : "response actions visible, generation inactive, text stable for 3s",
      // Remote providers own these settings; don't claim local defaults apply.
      browserSettings: config.cdpUrlFor("claude")
        ? { mode: "remote", locale: null, timezone: null, channel: null }
        : { mode: "local", locale: config.locale, timezone: config.timezone, channel: config.browserChannel ?? "chromium" },
      screenshotPath: screenshotError ? null : screenshotPath, screenshotError,
      errorCode: error instanceof ClaudeScrapeError ? error.code : error ? "CAPTURE_ERROR" : null,
      // Raw Playwright errors may contain credential-bearing connection URLs.
      error: error instanceof ClaudeScrapeError ? error.message : error ? "Browser capture failed" : null,
    }, null, 2), { mode: 0o600 });
    if (!error && screenshotError) throw new Error("claude: response captured but evidence screenshot failed");
  }

  try {
    const response = await page.goto("https://claude.ai/new", { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 60_000) });
    if (response && [403, 429].includes(response.status())) {
      throw new ClaudeScrapeError(response.status() === 429 ? "RATE_LIMITED" : "BLOCKED", `navigation returned HTTP ${response.status()}`);
    }
    stage = "login/composer";
    const composerDeadline = Date.now() + Math.min(timeoutMs, 30_000);
    while (true) {
      await dismissClaudePromotion(page);
      assertClaudeReady(await readClaudeSnapshot(page));
      if (await page.locator(SEL.composer).filter({ visible: true }).count()) break;
      if (Date.now() >= composerDeadline) throw new ClaudeScrapeError("INCOMPLETE", "composer unavailable; login or selectors need checking");
      await sleep(250);
    }
    if ((await readClaudeSnapshot(page)).text || /\/chat\//.test(new URL(page.url()).pathname)) {
      throw new ClaudeScrapeError("PLATFORM_ERROR", "new-chat navigation restored an existing conversation");
    }
    freshSearch = true;
    await jitter();
    stage = "submission";
    const visibleComposer = SEL.composer.split(",").map((s) => `${s.trim()}:visible`).join(", ");
    await humanType(page, visibleComposer, prompt);
    await jitter(600, 1500);
    await page.keyboard.press("Enter");
    stage = "response";
    text = await waitForClaudeAnswer(page, { timeoutMs });
    modelVersion = await page.locator(SEL.model).filter({ visible: true }).first().innerText({ timeout: 1000 }).catch(() => null);
    modelVersion = modelVersion?.trim() || null;
    stage = "evidence";
    await evidence();
    return { text, modelVersion, resultUrl: page.url(), screenshotPath };
  } catch (cause) {
    const error = cause instanceof ClaudeScrapeError ? cause : new ClaudeScrapeError(
      "INCOMPLETE", `${stage} failed; check browser connectivity/settings and diagnostic evidence`
    );
    try {
      await evidence(error);
      error.evidencePath = evidencePath;
      console.error(`[claude] capture failed; diagnostics: ${evidencePath}`);
    } catch {
      console.error("[claude] could not save diagnostic evidence");
    }
    throw error;
  } finally {
    if (!options.page) await page.close().catch(() => {});
  }
}

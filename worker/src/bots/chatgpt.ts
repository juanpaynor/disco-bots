import type { BrowserContext, Page } from "playwright";
import { jitter, sleep } from "../browser.js";
import { config } from "../config.js";
import type { ScrapeOutput } from "../types.js";

/**
 * Selectors verified live against the SIGNED-IN chatgpt.com.
 *
 * The current signed-in composer uses data-composer-markdown and role=textbox;
 * older layouts used #prompt-textarea. Hidden textarea fallbacks can coexist
 * with the editor, so select a visible editable element before typing.
 *
 * Class names are obfuscated atomic CSS and useless as anchors; the stable
 * handles are semantic data-attributes on the transcript.
 */
export const SEL = {
  composer: '[data-composer-markdown][contenteditable="true"], [contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"], #prompt-textarea[contenteditable="true"], textarea[name="prompt"]',
  assistantTurn: '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]',
  stopButton: '[data-testid="stop-button"]',
};

const RATE_LIMIT_PATTERNS = [
  /reached our limit of messages/i,
  /you've hit the (free |plus )?plan limit/i,
  /please try again later/i,
  /you've reached your limit/i,
];

/// ChatGPT renders failures as ordinary message content, so a broken stream
/// looks exactly like a successful short answer to a scraper. Observed live:
/// "Error in message stream\n\nRetry" was captured and stored as a completed
/// row. Left alone that lands in the client grid as a genuine "brand not
/// mentioned" — a wrong answer is worse than a missing one.
const ERROR_PATTERNS = [
  /error in message stream/i,
  /something went wrong/i,
  /network error/i,
  /unable to load conversation/i,
  /conversation not found/i,
];

/// Below this, an answer to a "what are the best X" prompt is not an answer.
/// Real ones run 1,100-3,400 chars; the error banner was 30. A floor turns
/// silent corruption into a loud retry.
const MIN_ANSWER_CHARS = Number(process.env.MIN_ANSWER_CHARS ?? 250);

/**
 * Wait for the answer to actually finish.
 *
 * Requires stable text and no generation, plus response actions or observed
 * generation. Response actions cover fast answers whose stop button was missed.
 *
 * No single signal is enough. ChatGPT answers in multiple turns with a search
 * step in between, so a completion flag on the first turn fires while it is
 * still working — trusting it truncates the answer to the preamble. Text
 * stability alone fires during the pause before streaming begins.
 */
export async function readChatgptSnapshot(page: Page): Promise<{ text: string; generating: boolean; completionAction: boolean }> {
  return page.evaluate(({ assistantTurn, stopButton }) => {
    const dom = {
      visible(el: Element) { return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"; },
    };
    const matches = [...document.querySelectorAll(assistantTurn)].filter(dom.visible);
    const roots = matches.filter((el) => !matches.some((other) => other !== el && other.contains(el)));
    const buttons = [...document.querySelectorAll("button")].filter(dom.visible);
    const generating = [...document.querySelectorAll(`${stopButton}, [data-is-streaming="true"]`)].some(dom.visible) ||
      buttons.some((b) => /^stop(?:\s+(?:generating|streaming|response))?$/i.test(b.getAttribute("aria-label") ?? ""));
    const last = roots.at(-1);
    const turn = last?.closest('[data-chatgpt-search-unit-key$=":assistant"], article') ?? last;
    const completionAction = !!turn && [...turn.querySelectorAll("button")].filter(dom.visible).some((b) =>
      !b.closest("pre, code") && (/^(?:Copy(?: response| message)?|Regenerate response)$/i.test(b.getAttribute("aria-label") ?? "") ||
        b.getAttribute("data-testid") === "copy-turn-action-button")
    );
    return { text: roots.map((el) => (el as HTMLElement).innerText.trim()).filter(Boolean).join("\n\n"), generating, completionAction };
  }, { assistantTurn: SEL.assistantTurn, stopButton: SEL.stopButton });
}

export async function waitForAnswer(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const requiredStable = 6; // 6 x 500ms = 3s unchanged
  let prev = "";
  let stable = 0;
  let sawGeneration = false;

  while (Date.now() < deadline) {
    const s = await readChatgptSnapshot(page);

    if (s.generating) sawGeneration = true;

    if (!s.generating && s.text === prev) stable++;
    else { stable = 0; prev = s.text; }

    if ((sawGeneration || s.completionAction) && !s.generating && stable >= requiredStable && s.text) return;
    await sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for an answer`);
}

/**
 * Reuse one tab for the whole run.
 *
 * A person works in a single window and starts a new chat; they do not open and
 * close 80 tabs. Keeping one page alive is both less conspicuous and cheaper —
 * no renderer teardown per prompt.
 */
async function pageFor(context: BrowserContext): Promise<Page> {
  const open = context.pages().find((p) => !p.isClosed());
  if (!open) return context.newPage();
  // A reused tab carries its state forward, including a crashed renderer.
  // Observed live as "page.goto: Page crashed" on the job after a failure, so
  // prove the page still responds before trusting it.
  try {
    await open.evaluate(() => 1);
    return open;
  } catch {
    await open.close().catch(() => {});
    return context.newPage();
  }
}

export async function scrape(context: BrowserContext, prompt: string, options: { minAnswerChars?: number } = {}): Promise<ScrapeOutput> {
  const page = await pageFor(context);
  try {
    // A FRESH CONVERSATION per prompt is non-negotiable, even though the tab
    // persists. Continuing a thread lets the previous answer condition the next
    // one — the model stays loyal to brands it already named — which collapses N
    // independent measurements into a single conversation. Gary's grid tracks
    // this explicitly as "Fresh search? (Y/N)" and his manual rows are all Y.
    // Navigating to the root starts a new chat without touching the UI.
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });

    const composer = page.locator(SEL.composer).filter({ visible: true }).first();
    await composer.waitFor({ state: "visible", timeout: 45_000 });
    await jitter(1500, 3000);

    await composer.click();
    await composer.type(prompt, { delay: 20 + Math.random() * 50 });
    await jitter(700, 1600);
    await page.keyboard.press("Enter");

    await waitForAnswer(page, config.responseTimeoutMs);

    const text = (await readChatgptSnapshot(page)).text.replace(/^ChatGPT said:\s*/i, "").trim();

    if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) {
      throw new Error(`rate limited: ${text.slice(0, 120)}`);
    }
    if (ERROR_PATTERNS.some((re) => re.test(text))) {
      throw new Error(`platform error surfaced as content: ${text.slice(0, 120)}`);
    }
    if (!text) throw new Error("no answer text found — selectors may have rotted");
    if (text.length < (options.minAnswerChars ?? MIN_ANSWER_CHARS)) {
      throw new Error(`answer too short (${text.length} chars) to be real: ${text.slice(0, 120)}`);
    }

    // data-message-model-slug carries the exact model ("gpt-5-…"), which beats
    // scraping the model-switcher label: it is per-message and machine-readable.
    const modelVersion = await page.evaluate(() =>
      [...document.querySelectorAll("[data-message-model-slug]")].at(-1)?.getAttribute("data-message-model-slug") ?? null
    );

    return {
      text,
      modelVersion,
      // /c/<uuid> — the conversation page, for the grid's proof column. Visible
      // only to this account; a public share link would need an extra UI step.
      resultUrl: page.url(),
    };
  } catch (err) {
    // Discard the tab on any failure. Whatever broke — crashed renderer, stuck
    // modal, half-rendered error state — would otherwise be inherited by the
    // next prompt and turn one bad row into a run of them.
    await page.close().catch(() => {});
    throw err;
  }
}

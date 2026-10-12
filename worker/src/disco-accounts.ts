import fs from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import type { Page } from "playwright";
import { launchContext, sleep } from "./browser.js";
import { config } from "./config.js";
import { SEL as chatgptSelectors } from "./bots/chatgpt.js";
import { SEL as claudeSelectors } from "./bots/claude.js";
import type { ChatPlatform } from "./local-run.js";
import { SURFACE_LABELS } from "./types.js";

export const ACCOUNT_URLS = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app",
  claude: "https://claude.ai/new",
};

const COMPOSERS = {
  chatgpt: chatgptSelectors.composer,
  gemini: 'rich-textarea div[contenteditable="true"], .ql-editor',
  claude: claudeSelectors.composer,
};

const markerPath = (profileDir: string, platform: ChatPlatform) => path.join(profileDir, platform, ".disco-account.json");

/** Records completed setup, not a promise that the session never expires. */
export function accountIsConfigured(platform: ChatPlatform, profileDir = config.profileDir): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(profileDir, platform), "utf8"));
    return marker.version === 1 && marker.platform === platform &&
      typeof marker.configuredAt === "string" && Number.isFinite(Date.parse(marker.configuredAt));
  } catch { return false; }
}

export function saveAccountSetup(platform: ChatPlatform, profileDir = config.profileDir): void {
  const file = markerPath(profileDir, platform);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, platform, configuredAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
}

/** A guest ChatGPT composer must not count as a signed-in account. */
export async function accountIsReady(page: Page, platform: ChatPlatform): Promise<boolean> {
  const current = new URL(page.url());
  if (current.origin !== new URL(ACCOUNT_URLS[platform]).origin || /\/(?:login|signup|auth)(?:[/?#]|$)/i.test(current.pathname)) return false;
  if (/just a moment|attention required|access denied/i.test(await page.title())) return false;
  if (await page.getByRole("heading", { name: /verify you are human/i }).filter({ visible: true }).count()) return false;
  if (!await page.locator(COMPOSERS[platform]).filter({ visible: true }).count()) return false;
  const signIn = page.getByRole("button", { name: /^(?:log\s?in|sign\s?in)(?:\b.*)?$/i })
    .or(page.getByRole("link", { name: /^(?:log\s?in|sign\s?in)(?:\b.*)?$/i }));
  if (await signIn.filter({ visible: true }).count()) return false;
  if (platform !== "chatgpt") return true;
  if (await page.locator('[data-testid="accounts-profile-button"], [data-testid="profile-button"]')
    .filter({ visible: true }).count()) return true;
  // Some layouts hide the account menu in a collapsed sidebar. Only inspect
  // cookie metadata here; credentials stay in the browser's persistent profile.
  const now = Date.now() / 1000;
  return (await page.context().cookies(page.url())).some((cookie) =>
    /^__Secure-(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name) &&
    (cookie.expires === -1 || cookie.expires > now));
}

async function waitForAccount(page: Page, platform: ChatPlatform, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (!signal.aborted && !page.isClosed()) {
    if (await accountIsReady(page, platform).catch(() => false)) return true;
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  return false;
}

interface LoginOptions {
  launch?: typeof launchContext;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  profileDir?: string;
}

/** Visible, sequential login. Never submits an AI prompt. */
export async function loginAccount(platform: ChatPlatform, options: LoginOptions = {}): Promise<boolean> {
  const label = SURFACE_LABELS[platform];
  console.log(`\nOpening ${label} for account setup…`);
  // Setup owns cancellation so it can release the profile and return to the
  // caller; Playwright's default SIGINT handler exits the entire process.
  const context = await (options.launch ?? launchContext)(platform, {
    headless: false, viewport: null, handleSIGINT: false, handleSIGTERM: false,
  });
  const controller = new AbortController();
  let rl: Interface | undefined;
  let ready = false;
  // Await the same close operation after cancellation: a second close() call
  // can return before the first finishes releasing the profile lock.
  let closing: Promise<void> | undefined;
  const close = () => closing ??= context.close();
  const cancel = () => {
    controller.abort();
    void close().catch(() => {});
  };
  context.once("close", cancel);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(ACCOUNT_URLS[platform], { waitUntil: "domcontentloaded", timeout: 60_000 });
    ready = await waitForAccount(page, platform, controller.signal);
    if (controller.signal.aborted) return false;
    if (ready) console.log(`${label}: existing signed-in session found.`);
    else {
      console.log(`Sign in to ${label} in the browser and finish any verification steps.`);
      console.log("For consistent audit results, disable memory and clear custom instructions in your account settings.");
      rl = createInterface({ input: options.input ?? process.stdin, output: options.output ?? process.stdout });
      rl.on("SIGINT", cancel);
      rl.on("close", cancel);
      while (!controller.signal.aborted && !ready) {
        await rl.question(`Press Enter when ${label} is ready, or Ctrl+C to cancel… `, { signal: controller.signal });
        ready = await waitForAccount(page, platform, controller.signal);
        if (!ready && !controller.signal.aborted) console.log(`${label} is not ready yet. Finish signing in and make sure the new-chat screen is open.`);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    context.off("close", cancel);
    rl?.off("close", cancel);
    rl?.close();
    await close();
  }
  if (!ready || controller.signal.aborted) return false;
  if (!config.cdpUrlFor(platform)) saveAccountSetup(platform, options.profileDir);
  console.log(`${label}: account setup saved.`);
  return true;
}

interface SetupOptions {
  interactive: boolean;
  force?: boolean;
  configured?: (platform: ChatPlatform) => boolean;
  remote?: (platform: ChatPlatform) => boolean;
  login?: (platform: ChatPlatform) => Promise<boolean>;
}

export async function ensureAccounts(platforms: ChatPlatform[], options: SetupOptions): Promise<boolean> {
  const configured = options.configured ?? accountIsConfigured;
  const remote = options.remote ?? ((platform) => !!config.cdpUrlFor(platform));
  const needed = platforms.filter((platform) => options.force || (!remote(platform) && !configured(platform)));
  if (!needed.length) return true;
  if (!options.interactive) {
    throw new Error(`Account setup needs an interactive terminal. Run disco --login --platforms ${needed.join(",")} first, then rerun this command.`);
  }
  console.log(`\nAccount setup: ${needed.map((platform) => SURFACE_LABELS[platform]).join(", ")}`);
  console.log("Your browser saves each login for future runs. Setup opens one visible browser at a time.");
  for (const platform of needed) {
    if (!await (options.login ?? loginAccount)(platform)) return false;
  }
  return true;
}

/**
 * One-time interactive login, so the persistent profile picks up session cookies.
 *
 *   npm run login -- chatgpt
 *
 * Opens a real browser window, you sign in by hand, press Enter here, and the
 * cookies persist in PROFILE_DIR for every later headless run.
 *
 * Before signing in, turn OFF chat history/memory and clear any custom
 * instructions on the account. A personalised account answers differently from a
 * clean one, which quietly makes your audit unreproducible.
 */
import path from "node:path";
import readline from "node:readline/promises";
import { config } from "./config.js";
import { launchContext } from "./browser.js";
import { isPlatform } from "./types.js";

const URLS: Record<string, string> = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app",
  claude: "https://claude.ai/login",
  // Google Search needs no login, but a warmed profile (consent dialogs
  // dismissed, region settled) still behaves more like a real user.
  google: "https://www.google.com/",
};

const platform = process.argv[2];
if (!platform || !isPlatform(platform)) {
  console.error("usage: npm run login -- <chatgpt|gemini|claude|google>");
  process.exit(1);
}

const userDataDir = path.join(config.profileDir, platform);
console.log(`Opening ${platform}. Profile: ${userDataDir}`);

// The login must use the same channel, proxy, locale and remote session as jobs.
// Follow the real window dimensions so account controls stay on screen when
// the user resizes the browser on a smaller display.
const context = await launchContext(platform, { headless: false, viewport: null });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(URLS[platform]);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("\nSign in, disable memory/custom instructions, then press Enter here…");
  } finally {
    rl.close();
  }
} finally {
  await context.close();
}
console.log(`Session saved. Run a verification before queueing ${platform} jobs.`);

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
import { chromium } from "playwright";
import path from "node:path";
import readline from "node:readline/promises";
import { config } from "./config.js";
import { isPlatform } from "./types.js";

const URLS = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app",
  claude: "https://claude.ai/login",
};

const platform = process.argv[2];
if (!platform || !isPlatform(platform)) {
  console.error("usage: npm run login -- <chatgpt|gemini|claude>");
  process.exit(1);
}

const userDataDir = path.join(config.profileDir, platform);
console.log(`Opening ${platform}. Profile: ${userDataDir}`);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false, // always headed — you need to actually type a password
  viewport: { width: 1440, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(URLS[platform]);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("\nSign in, disable memory/custom instructions, then press Enter here…");
rl.close();

await context.close();
console.log(`Saved. ${platform} profile is ready.`);

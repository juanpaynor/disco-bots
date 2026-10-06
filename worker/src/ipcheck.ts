/**
 * Verify what IP a platform's browser actually exits from, and whether the
 * target serves us or walls us.
 *
 *   npm run ipcheck -- chatgpt
 */
import { launchContext, sleep } from "./browser.js";
import { isPlatform } from "./types.js";

const platform = process.argv[2];
if (!platform || !isPlatform(platform)) {
  console.error("usage: npm run ipcheck -- <chatgpt|gemini|claude>");
  process.exit(1);
}

const ctx = await launchContext(platform);
const page = await ctx.newPage();

await page.goto("https://api.ipify.org?format=json", { timeout: 45_000 });
const ip = await page.locator("body").innerText();
console.log("exit IP :", ip.trim());

const resp = await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(5000);
const status = resp?.status();
const title = await page.title();
const composer = await page.locator('textarea[name="prompt"]').count();

console.log("status  :", status);
console.log("title   :", title);
console.log("composer:", composer > 0 ? "present — we're through" : "absent");
if (title.includes("Just a moment") || status === 403) {
  console.log("\n>>> BLOCKED at the Cloudflare edge. Headed+xvfb and/or a residential proxy needed.");
}
await ctx.close();

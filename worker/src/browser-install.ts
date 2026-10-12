import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const resolveDependency = createRequire(import.meta.url);

interface InstallerDependencies {
  available: () => boolean;
  download: () => Promise<void>;
}

/** Share one download when multiple platforms start together. Retry on failure. */
export function browserInstaller(deps: InstallerDependencies): () => Promise<void> {
  let installing: Promise<void> | undefined;
  return async () => {
    if (deps.available()) return;
    if (!installing) {
      installing = deps.download().then(() => {
        if (!deps.available()) throw new Error("Browser download finished, but Chromium is still unavailable.");
      }).finally(() => { installing = undefined; });
    }
    await installing;
  };
}

export const installManagedBrowser = browserInstaller({
  available: () => fs.existsSync(chromium.executablePath()),
  download: async () => {
    if (/^(?:1|true)$/i.test(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? "")) {
      throw new Error("Browser download is disabled. Unset PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, then run disco --install-browser.");
    }
    console.log("Installing Disco's Chromium browser. This is only needed on first use or after a browser update…");
    const cli = path.join(path.dirname(resolveDependency.resolve("playwright/package.json")), "cli.js");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Browser installation failed (${signal ?? code}). Check your connection, then run disco --install-browser.`));
      });
    });
  },
});

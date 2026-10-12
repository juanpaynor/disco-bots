import assert from "node:assert/strict";
import { test } from "node:test";
import { browserInstaller } from "./browser-install.js";

test("an installed browser needs no network or installer process", async () => {
  const ensure = browserInstaller({ available: () => true, download: async () => { throw new Error("Unexpected download"); } });
  await ensure();
});

test("parallel platform launches share a single browser download", async () => {
  let available = false;
  let downloads = 0;
  let finish!: () => void;
  const ensure = browserInstaller({
    available: () => available,
    download: () => { downloads++; return new Promise((resolve) => { finish = () => { available = true; resolve(); }; }); },
  });
  const platforms = [ensure(), ensure(), ensure()];
  assert.equal(downloads, 1);
  finish();
  await Promise.all(platforms);
  await ensure();
  assert.equal(downloads, 1);
});

test("failed and incomplete browser downloads remain retryable", async () => {
  let available = false;
  let downloads = 0;
  const ensure = browserInstaller({
    available: () => available,
    download: async () => {
      downloads++;
      if (downloads === 1) throw new Error("Offline");
      if (downloads === 3) available = true;
    },
  });
  await assert.rejects(ensure(), /Offline/);
  await assert.rejects(ensure(), /still unavailable/);
  await ensure();
  assert.equal(downloads, 3);
});

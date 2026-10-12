#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("AiDisco requires Node.js 22 or newer.");
  process.exit(1);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const data = path.resolve(process.env.DISCO_DATA_DIR ?? path.join(os.homedir(), ".aidisco"));
process.env.DISCO_VERSION = version;
process.env.DISCO_DATA_DIR = data;
process.env.PROFILE_DIR ??= path.join(data, "profiles");
process.env.CAPTURE_DIR ??= path.join(data, "captures");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(data, "browsers");
process.env.DISCO_AUTO_INSTALL_BROWSER ??= "1";
// Stay in the caller's directory so relative prompt and output paths work.
await import("../lib/disco.mjs");

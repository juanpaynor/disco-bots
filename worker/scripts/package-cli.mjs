import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const worker = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.dirname(worker);
const require = createRequire(import.meta.url);
const metadata = JSON.parse(await fs.readFile(path.join(worker, "package.json"), "utf8"));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--repository")) {
  throw new Error("Usage: npm run package:disco -- [--repository owner/repo]");
}
let repository = args[1];
if (!repository) {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  repository = remote.match(/github\.com[:/]([^/?#\s]+\/[^/?#\s]+?)(?:\.git)?$/)?.[1];
}
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("Provide the GitHub release repository: npm run package:disco -- --repository owner/repo");
}
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)) throw new Error("Use a semantic package version.");
if (!process.env.npm_execpath) throw new Error("Run this builder through npm run package:disco.");

const out = path.join(project, "release");
const stage = path.join(out, "package");
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(path.join(stage, "bin"), { recursive: true });
await fs.mkdir(path.join(stage, "lib"), { recursive: true });
await fs.copyFile(path.join(project, "packaging/bin/disco.mjs"), path.join(stage, "bin/disco.mjs"));
await fs.chmod(path.join(stage, "bin/disco.mjs"), 0o755);
await build({
  entryPoints: [path.join(worker, "src/disco.ts")],
  outfile: path.join(stage, "lib/disco.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["playwright"],
  // dotenv is CommonJS; its bundled requires need Node's real require in ESM.
  banner: { js: 'import { createRequire as __discoRequire } from "node:module"; const require = __discoRequire(import.meta.url);' },
});

const playwright = JSON.parse(await fs.readFile(require.resolve("playwright/package.json"), "utf8"));
if (playwright.version !== metadata.dependencies.playwright) {
  throw new Error("Installed Playwright differs from package.json. Run npm ci before packaging.");
}
// Bundle only the CLI's browser runtime, including its third-party notices.
// No profiles, client data, .env, captures, database client or development tools.
const copied = new Set();
async function copyDependency(name, resolver) {
  if (copied.has(name)) return;
  copied.add(name);
  const manifest = resolver.resolve(`${name}/package.json`);
  const info = JSON.parse(await fs.readFile(manifest, "utf8"));
  await fs.cp(path.dirname(manifest), path.join(stage, "node_modules", name), {
    recursive: true, dereference: true,
    filter: (file) => path.basename(file) !== ".local-browsers" && path.basename(file) !== "node_modules",
  });
  for (const dependency of Object.keys(info.dependencies ?? {})) {
    await copyDependency(dependency, createRequire(manifest));
  }
}
await copyDependency("playwright", require);
await fs.writeFile(path.join(stage, "package.json"), JSON.stringify({
  name: "aidisco-cli", version: metadata.version, private: true,
  description: "AiDisco — capture responses from ChatGPT, Gemini and Claude",
  type: "module", license: "UNLICENSED", engines: { node: ">=22" },
  bin: { disco: "bin/disco.mjs" }, files: ["bin/", "lib/", "README.md"],
  repository: { type: "git", url: `https://github.com/${repository}.git` },
  dependencies: { playwright: playwright.version }, bundledDependencies: ["playwright"],
}, null, 2) + "\n");
await fs.copyFile(path.join(project, "packaging/README.md"), path.join(stage, "README.md"));

const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", out, "--cache", path.join(out, ".npm-cache")], {
  cwd: stage, encoding: "utf8",
}));
const archive = path.join(out, packed[0].filename);
const sha256 = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
await fs.writeFile(path.join(out, "SHA256SUMS"), `${sha256}  ${path.basename(archive)}\n`);

const formulaDir = path.join(project, "packaging/homebrew/Formula");
await fs.mkdir(formulaDir, { recursive: true });
await fs.writeFile(path.join(formulaDir, "disco.rb"), `class Disco < Formula
  desc "Capture responses from ChatGPT, Gemini and Claude"
  homepage "https://github.com/${repository}"
  url "https://github.com/${repository}/releases/download/v${metadata.version}/${path.basename(archive)}"
  sha256 "${sha256}"
  version "${metadata.version}"

  depends_on macos: :sonoma
  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"disco").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/disco.mjs" "$@"
    SH
    (bin/"disco").chmod 0755
  end

  def caveats
    <<~EOS
      Run disco to start. The first launch downloads Chromium automatically
      and guides you through account login. Saved logins and results stay
      in ~/.aidisco across upgrades. Use disco --install-browser to prefetch.
    EOS
  end

  test do
    assert_match "AiDisco #{version}", shell_output("#{bin}/disco --version")
    assert_match "--login", shell_output("#{bin}/disco --help")
  end
end
`);
console.log(`Archive: ${archive}\nSHA256: ${sha256}\nHomebrew formula: ${path.join(formulaDir, "disco.rb")}`);
console.log("Local install: npm install --global " + archive);
console.log("The archive and formula are prepared locally. No release or tap has been published.");

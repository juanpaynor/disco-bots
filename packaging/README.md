# Install AiDisco

AiDisco captures answers from ChatGPT, Gemini and Claude. It needs no database
or API keys. Each person signs in using their own accounts on first use.

## macOS with Homebrew

Once the release and tap are published:

```sh
brew install juanpaynor/disco/disco
disco
```

Homebrew installs Node. The release includes the CLI's JavaScript dependencies.
Disco downloads Chromium automatically on first use, then guides you through
login. macOS 14 or newer is required by the browser runtime.

## Windows or macOS with Node

Install Node.js 22 or newer. Download the `aidisco-cli-VERSION.tgz` release asset,
then install it (replace VERSION with the downloaded version):

```sh
npm install --global ./aidisco-cli-VERSION.tgz
disco
```

npm creates the `disco` command, including a Windows command launcher. The first
launch downloads the browser automatically. On Windows, `disco.cmd` also works.

## Usage

```sh
disco --login --platforms claude
disco --browser headless
disco --install-browser
disco --version
```

Account setup always uses a visible browser. Captures minimize by default;
headless mode avoids browser windows. An expired login can be refreshed with
`disco --login`. Browser binaries, profiles, evidence and saved results live in
`~/.aidisco`, so upgrading the app preserves them. `--out` changes a run's output
folder. `DISCO_DATA_DIR` changes the default data location; existing PROFILE_DIR,
CAPTURE_DIR and PLAYWRIGHT_BROWSERS_PATH settings are respected.

Help and version checks do not download a browser. Browser downloads need an
internet connection; retry with `disco --install-browser` if interrupted. Linux
users may also need Playwright's system libraries installed by an administrator.

## Build and distribute a release

From `worker/`:

```sh
npm ci
npm run package:disco -- --repository juanpaynor/disco-bots
```

The builder creates `release/aidisco-cli-VERSION.tgz`, `release/SHA256SUMS`, and
`packaging/homebrew/Formula/disco.rb` with the exact archive checksum. The archive
bundles Playwright and its runtime dependencies; it excludes account profiles,
client files, credentials, captures, development tools and the database client.

Publish the archive and checksum as assets of the matching `vVERSION` GitHub
release. Copy `packaging/homebrew/Formula/disco.rb` into a `Formula/` directory
in the `juanpaynor/homebrew-disco` repository. The tap must be accessible to the
people installing it, and the release URL must be accessible to Homebrew.
An authenticated private tap and release need additional access setup.

The package is marked private to prevent accidental npm registry publishing.
It can still be installed directly from its tarball. The builder does not
publish, create repositories, or upload anything. Rebuild the archive and
formula together for every version so their checksums match.

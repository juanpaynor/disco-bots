# AiDisco

AiDisco is a CLI that sends prompts to ChatGPT, Gemini and Claude, then saves
their answers for comparison and brand visibility research.

## Install and run

With Node.js 22 or newer installed on Windows, macOS or Linux:

```sh
npm install -g aidisco-cli
disco
```

On first use, Disco downloads Chromium and guides you through signing in to your
selected AI accounts. Later runs reuse the saved logins. The CLI needs no
database or API keys; it uses your signed-in browser accounts. Some Linux systems
also require Playwright's browser system libraries.

## What the CLI does

- **Choose platforms:** run one AI or several in parallel.
- **Submit prompts:** type or paste questions, load CSV/TXT files, pipe input,
  or pass a single prompt with `--prompt`.
- **Set up accounts once:** guided browser login with saved sessions; refresh
  expired sessions with `disco --login`.
- **Control browser visibility:** minimized by default, visible for
  troubleshooting, or headless with no browser windows.
- **Monitor runs:** see progress and response previews; pause, resume or stop
  from the terminal.
- **Export results:** save full answers, platform, model label when available,
  timestamps, evidence paths and errors.
- **Recover interrupted work:** resume pending prompts and explicitly retry
  failed captures while retaining completed answers.
- **Open saved results:** open the output folder directly from the terminal.

Installed versions keep logins, browsers, evidence and results in `~/.aidisco`,
separate from the app so upgrades preserve them. Each run saves `results.csv`
and a resumable `run.json` file. Use `--out` to choose a different output folder.

```sh
disco --prompt "What are the best Muay Thai gyms in Phuket?"
disco --platforms chatgpt,claude --file prompts.csv
disco --browser headless
disco --resume /path/to/run-folder
disco --resume /path/to/run-folder --retry-failed
disco --open /path/to/run-folder
disco --help
```

**Current scope: collecting raw AI responses.** Disco does not yet calculate
brand visibility scores or generate analysis reports. Stored responses can be
analyzed later without repeating the capture.

## Layout

```
prisma/schema.prisma   Shared schema (runs, prompts, results, jobs)
worker/                Playwright bot pool — claims jobs, scrapes, stores raw text
dashboard/             Next.js UI (not built yet)
```

## Setup

### Local terminal workflow

With worker dependencies installed, run `./disco` from this repository, or
`disco` when the launcher is on your PATH.
No database is needed for this workflow.

Opening `disco` starts a model selection wizard. Use ↑/↓ to move, Space to
toggle a checkbox, `a` to select or clear all, and Enter to continue. Choose
one AI or any combination of ChatGPT, Gemini and Claude. On first use, Disco
opens a visible browser for each selected account that needs setup. Sign in,
finish verification, then return to the terminal and press Enter. Disco checks
that the chat screen is ready before saving setup; an existing signed-in session
is recognized automatically. Then paste prompts (one per line) and enter a blank
line to start. Esc cancels the picker; Ctrl+C cancels account setup.
`--platforms` skips the picker; piped input defaults to all three platforms.
Resuming a run retains its saved platform selections.

```bash
./disco --prompt "What should a beginner look for in a Muay Thai gym?"
./disco --file prompts.csv
./disco --platforms chatgpt,claude --prompt "Compare training options in Phuket."
./disco --browser visible
./disco --browser headless
./disco --login --platforms claude
./disco --resume /path/to/run-folder
./disco --open /path/to/run-folder
```

Selected platforms run in separate, minimized Chrome windows and receive the same
prompt in parallel. Each platform processes one prompt at a time in a fresh chat;
the next prompt round starts after the current captures finish and the configured
pause. Default batch pauses are 20–60 seconds, with `SESSION_BUDGET` limiting each
invocation to 30 prompt rounds (0 means unlimited).

Browser windows minimize automatically, including new windows created during a
run. On macOS a window may appear briefly before minimizing; restore it from the
Dock whenever you want to inspect it. Use `--browser visible` for troubleshooting,
or `--browser headless` to run with no windows. All modes reuse the saved logins.
Claude's evidence screenshot briefly restores its window, then minimizes it again;
headless mode avoids this too.

Account setup is saved per browser profile, and later runs skip it. Setup always
uses visible windows, even when captures use headless or minimized mode. If a
session expires or needs verification, run `disco --login` (optionally with
`--platforms claude`, for example), then resume your run. This command only sets
up accounts and submits no prompts. Piped and unattended commands require setup
in an interactive terminal first; they fail with the setup command if needed.
The existing `npm run login -- <platform>` command also records completed setup.
Browser mode can also be set when resuming. Hosted browsers configured through
`BROWSER_CDP_URL` retain their provider's display behavior.

The terminal shows platform progress and response previews. Press `p` to pause or
resume, `s` to stop after current captures, `l` to show logs, or `o` to open the
output folder in Finder (or your system file manager). Ctrl+C also finishes
current captures. Browser windows close when the invocation ends; logins persist.
A capture failure stops the batch after the current round while preserving the
other platforms' results. Use `--resume ... --retry-failed` to explicitly retry
failed entries; ordinary resume runs pending entries only.

Each completed capture updates `worker/exports/disco/<run-id>/run.json` and
`results.csv`. The CSV includes the full response, platform, model label when
available, timestamps, evidence paths and errors. Interrupted entries can be
resumed; completed entries are retained. A prompt submitted just before a crash
may need to be sent again if its response was not yet saved.
The final summary shows the output folder, CSV path and a copyable
`disco --open '…'` command to reopen the folder after the run exits.
`--out` selects a new output folder. Paths passed through `./disco` resolve from
your current directory. CSV input accepts a `Prompt` or `Text` column, including
quoted multiline text; `.txt` input and interactive pastes use one prompt per line.
Use `npm run test:disco` in `worker/` for runner, resume, export and account setup
regression tests; `npm run test:accounts` also checks login using browser fixtures.

### Installable CLI and Homebrew

From `worker/`, `npm run package:disco` builds an installable
`release/aidisco-cli-<version>.tgz` archive and a Homebrew formula with its checksum.
The CLI is published on npm as `aidisco-cli`. The Homebrew tap and matching
GitHub release are prepared locally and must be published before the brew
command is available.

The packaged CLI includes its JavaScript dependencies and installs Chromium
automatically on first use. Homebrew also installs Node. Windows users can
install the same archive with npm once Node is installed. Packaged installations
store logins, browsers, evidence and results in `~/.aidisco`, separate from the
application, so upgrades preserve them. `disco --install-browser` downloads the
browser without logging in; `disco --version` reports the installed version.
The existing source checkout keeps its current profile and output locations.

### Database worker setup

```bash
cp .env.example .env         # fill in DATABASE_URL from Railway
cd worker
npm install
npx playwright install chromium
npm run generate             # prisma client
npm run db:push              # create tables
```

### Log the bots in (once per platform)

```bash
npm run login -- chatgpt
npm run login -- gemini
npm run login -- claude
```

A real browser opens. Sign in, then **turn off chat history/memory and clear
custom instructions** — a personalised account answers differently from a clean
one, which makes audits unreproducible. Cookies persist in `PROFILE_DIR`.

### Verify Claude before queueing work

The Claude adapter uses the same browser channel, proxy and persistent session
as the worker. Login and verification do not require a database connection.
From `worker/`:

```bash
npm run login -- claude
npm run verify:claude -- --prompt "What should I consider when choosing a Muay Thai camp?"
npm run verify:claude -- --count 3
```

Each verification starts a fresh conversation without reading or changing the
audit queue. Full answers and completion evidence are saved as JSON alongside
screenshots under `captures/claude/` (override with `--out` or `CAPTURE_DIR`).
`--count 3` uses one browser tab for all three fresh conversations, logs the
20–60 second pauses between them, and closes the browser when the batch ends.
Without `--count`, verification runs once.
These artifacts contain private conversation data and are ignored by Git.
The command stops on the first failure and exits nonzero. Failed captures retain
partial text for diagnosis; they are never reported as completed answers.

Claude completion requires visible response actions, no active generation, and
three seconds of stable text. Login walls, access challenges, usage-limit alerts
and platform errors fail explicitly. A missing model label is stored as unknown.
The selectors still require a signed-in live verification after UI changes;
local fixtures alone do not establish that the live platform works.

After successful verification, scope a worker to Claude with
`WORKER_PLATFORMS=claude npm run dev`. This consumes existing queued Claude jobs.
Run `npm run test:claude` for the local browser fixture regression tests.

### Queue a run

```bash
npm run seed -- prompts.csv "Acme Q4" "Acme Corp" chatgpt,claude 1
```

CSV is one prompt per line, or `text,category,funnel_stage,search_volume`.

### Run the worker

```bash
npm run dev
```

## How the queue works

Postgres is the queue — no Redis, no BullMQ. Workers claim jobs with
`FOR UPDATE SKIP LOCKED`, so N workers can poll the same table without ever
being handed the same row and without blocking one another.

A worker that dies mid-job leaves its row stuck in `claimed`. `reclaimStaleJobs`
runs every 60s and returns anything older than `STALE_JOB_SECONDS` to the queue,
or buries it once `max_attempts` is spent.

## Known fragility

The per-platform selectors in `worker/src/bots/*.ts` break whenever those UIs
redesign. They are isolated at the top of each file as a `SEL` object so a fix is
one line. ChatGPT and Claude combine generation controls with stable text to
detect completion; Gemini currently relies on text stability alone. These
signals still depend on platform UI behavior and need periodic live checks.

Scraping these platforms is against their terms of service. Expect account bans,
and keep `max_attempts` and the stale-job reaper doing their jobs.

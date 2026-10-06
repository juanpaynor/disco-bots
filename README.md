# AiDisco Engine

Headless-browser scraper pool that captures how brands appear in AI-generated
answers across ChatGPT, Gemini and Claude.

**Current scope: scraping only.** `results.raw_response` is the source of truth.
No scoring runs anywhere in this repo — that is deliberate, so scoring can be
applied later as a pure function over stored text without re-scraping anything.

## Layout

```
prisma/schema.prisma   Shared schema (runs, prompts, results, jobs)
worker/                Playwright bot pool — claims jobs, scrapes, stores raw text
dashboard/             Next.js UI (not built yet)
```

## Setup

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
one line. Response completion is detected by polling until the text stops
growing rather than by watching for a "done" indicator — uglier, but it survives
redesigns that rename every class.

Scraping these platforms is against their terms of service. Expect account bans,
and keep `max_attempts` and the stale-job reaper doing their jobs.

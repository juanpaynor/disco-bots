import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  // Browser-only commands (login/verify) must work without a database.
  get databaseUrl(): string { return required("DATABASE_URL"); },
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,

  /**
   * Platforms this worker will claim jobs for. Empty = all.
   *
   * Jobs interleave surfaces per prompt, so an unrestricted worker hops between
   * platforms every row. That matters because each platform is a separate
   * identity (own profile, own account, own exit IP) and because a platform
   * whose selectors are unverified will fail every job it touches. Scoping a
   * worker to one surface keeps a broken scraper from draining a whole audit.
   */
  platforms: (process.env.WORKER_PLATFORMS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
  profileDir: path.resolve(process.env.PROFILE_DIR ?? "./profiles"),
  headless: process.env.HEADLESS === "true",

  /**
   * Market condition: the Bangtao sheet specifies "Neutral (no location set)".
   *
   * These settle what the BROWSER volunteers. They do NOT change what the
   * platform infers from the exit IP — that still reads as wherever the worker
   * physically runs. Full geo neutrality needs a proxy exit in the target
   * locale; this is the half we can control for free.
   */
  locale: process.env.LOCALE ?? "en-US",
  timezone: process.env.TIMEZONE ?? "UTC",

  /**
   * Which browser binary to drive.
   *
   * "chrome" uses the real Google Chrome installed on the machine rather than
   * Playwright's bundled Chromium. They are not the same fingerprint: stock
   * Chromium is missing Chrome branding, proprietary codecs and Widevine, and
   * anti-bot scoring notices. Real Chrome is the single cheapest credibility
   * win available, and costs one env var.
   *
   * Leave unset in Docker — the Playwright image ships Chromium, not Chrome.
   */
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
  staleJobSeconds: Number(process.env.STALE_JOB_SECONDS ?? 900),
  // How long to wait for a single answer to finish streaming before giving up.
  responseTimeoutMs: Number(process.env.RESPONSE_TIMEOUT_MS ?? 180_000),
  // Idle backoff when the queue is empty.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5_000),

  /**
   * Gap between finishing one prompt and starting the next.
   *
   * Defaults to 20-60s, not seconds. A sustained ~1 prompt/minute for an hour is
   * a volume no person produces, and it is the loudest pattern in the whole run
   * — louder than any browser fingerprint. At this pace 80 prompts takes a few
   * hours and reads as someone genuinely working through research.
   */
  gapMinMs: Number(process.env.PROMPT_GAP_MIN_MS ?? 20_000),
  gapMaxMs: Number(process.env.PROMPT_GAP_MAX_MS ?? 60_000),

  /**
   * Circuit breaker: stop after this many consecutive failures.
   *
   * When a platform starts refusing us, every further request makes it worse.
   * Without this the worker would spend the night retrying into a wall and
   * turn a soft throttle into a banned account.
   */
  maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES ?? 3),

  /**
   * Stop cleanly after this many prompts in one session, then exit.
   *
   * An account that asks 40 questions and stops looks like a person who did
   * some research. One that asks 240 without a break does not. 0 = no limit.
   */
  sessionBudget: Number(process.env.SESSION_BUDGET ?? 30),

  /**
   * Outbound proxy, applied per platform.
   *
   * Use a STICKY residential endpoint, not a rotating one. These are logged-in
   * accounts: an account whose IP changes every request looks like a stolen
   * credential and gets banned faster than one that stays put. Scale by adding
   * identities (account + profile + pinned IP), never by rotating addresses
   * under a single account.
   *
   * PROXY_SERVER sets a default; PROXY_SERVER_CHATGPT etc. override per platform
   * so each identity can hold its own exit IP.
   */
  /**
   * Hosted-browser CDP endpoint, per platform.
   *
   * Set BROWSER_CDP_URL_CHATGPT (etc.) so each account attaches to its own
   * persistent remote session — the hosted equivalent of one profile per
   * identity. BROWSER_CDP_URL is the shared fallback.
   */
  cdpUrlFor(platform: string): string | undefined {
    const up = platform.toUpperCase();
    return process.env[`BROWSER_CDP_URL_${up}`] ?? process.env.BROWSER_CDP_URL ?? undefined;
  },

  proxyFor(platform: string): { server: string; username?: string; password?: string } | undefined {
    const up = platform.toUpperCase();
    const server = process.env[`PROXY_SERVER_${up}`] ?? process.env.PROXY_SERVER;
    if (!server) return undefined;
    const username = process.env[`PROXY_USERNAME_${up}`] ?? process.env.PROXY_USERNAME;
    const password = process.env[`PROXY_PASSWORD_${up}`] ?? process.env.PROXY_PASSWORD;
    return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
  },
};

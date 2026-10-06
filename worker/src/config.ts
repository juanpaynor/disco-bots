import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
  profileDir: path.resolve(process.env.PROFILE_DIR ?? "./profiles"),
  headless: process.env.HEADLESS === "true",
  staleJobSeconds: Number(process.env.STALE_JOB_SECONDS ?? 900),
  // How long to wait for a single answer to finish streaming before giving up.
  responseTimeoutMs: Number(process.env.RESPONSE_TIMEOUT_MS ?? 180_000),
  // Idle backoff when the queue is empty.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5_000),

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
  proxyFor(platform: string): { server: string; username?: string; password?: string } | undefined {
    const up = platform.toUpperCase();
    const server = process.env[`PROXY_SERVER_${up}`] ?? process.env.PROXY_SERVER;
    if (!server) return undefined;
    const username = process.env[`PROXY_USERNAME_${up}`] ?? process.env.PROXY_USERNAME;
    const password = process.env[`PROXY_PASSWORD_${up}`] ?? process.env.PROXY_PASSWORD;
    return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
  },
};

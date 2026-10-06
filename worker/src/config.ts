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
};

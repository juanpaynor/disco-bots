import { PrismaClient } from "./generated/prisma/index.js";

export const prisma = new PrismaClient({
  log: process.env.PRISMA_DEBUG === "true" ? ["query", "warn", "error"] : ["warn", "error"],
});

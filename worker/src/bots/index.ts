import type { BrowserContext } from "playwright";
import type { Platform, ScrapeOutput } from "../types.js";
import * as chatgpt from "./chatgpt.js";
import * as gemini from "./gemini.js";
import * as claude from "./claude.js";

type Bot = (context: BrowserContext, prompt: string) => Promise<ScrapeOutput>;

export const bots: Record<Platform, Bot> = {
  chatgpt: chatgpt.scrape,
  gemini: gemini.scrape,
  claude: claude.scrape,
};

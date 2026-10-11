import readline from "node:readline";
import { CHAT_PLATFORMS, type ChatPlatform } from "./local-run.js";
import { SURFACE_LABELS } from "./types.js";

export async function choosePlatforms(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<ChatPlatform[] | null> {
  const selected = new Set<ChatPlatform>(CHAT_PLATFORMS);
  let cursor = 0;
  let rendered = false;
  let warning = "";
  const render = () => {
    const lines = [
      "\x1b[96mChoose your AI models\x1b[0m · select one or several",
      "↑/↓ move · Space toggle · a toggle all · Enter continue · Esc cancel",
      ...CHAT_PLATFORMS.map((platform, i) =>
        `${i === cursor ? "\x1b[95m❯" : " "} [${selected.has(platform) ? "x" : " "}] ${SURFACE_LABELS[platform]}\x1b[0m`),
      warning || `${selected.size} selected`,
    ];
    if (rendered) output.write(`\x1b[${lines.length}A`);
    output.write(lines.map((line) => `\r\x1b[2K${line}\n`).join(""));
    rendered = true;
  };
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  readline.emitKeypressEvents(input);
  let onKey!: (text: string, key: readline.Key) => void;
  let cancel!: () => void;
  try {
    input.setRawMode(true);
    output.write("\x1b[?25l");
    return await new Promise<ChatPlatform[] | null>((resolve) => {
      cancel = () => resolve(null);
      onKey = (text, key) => {
        if ((key.ctrl && key.name === "c") || key.name === "escape") return cancel();
        warning = "";
        if (key.name === "up") cursor = (cursor + CHAT_PLATFORMS.length - 1) % CHAT_PLATFORMS.length;
        else if (key.name === "down") cursor = (cursor + 1) % CHAT_PLATFORMS.length;
        else if (key.name === "space") {
          const platform = CHAT_PLATFORMS[cursor];
          if (selected.has(platform)) selected.delete(platform); else selected.add(platform);
        } else if (text === "a") {
          if (selected.size === CHAT_PLATFORMS.length) selected.clear();
          else CHAT_PLATFORMS.forEach((platform) => selected.add(platform));
        } else if (key.name === "return") {
          if (selected.size) return resolve(CHAT_PLATFORMS.filter((platform) => selected.has(platform)));
          warning = "\x1b[95mSelect at least one AI model to continue.\x1b[0m";
        } else return;
        render();
      };
      input.on("keypress", onKey);
      input.once("end", cancel);
      process.once("SIGTERM", cancel);
      render();
      input.resume();
    });
  } finally {
    if (onKey) input.off("keypress", onKey);
    if (cancel) {
      input.off("end", cancel);
      process.off("SIGTERM", cancel);
    }
    input.setRawMode(wasRaw ?? false);
    if (!wasFlowing) input.pause();
    output.write("\x1b[?25h");
  }
}

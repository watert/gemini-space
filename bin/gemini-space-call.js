#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runEntrypoint } from "./run-entrypoint.js";

// 工具调用器：stdout 只留给结果，日志统一走 stderr。
console.log = (...args) => console.error(...args);

if (!process.env.GEMINI_SPACE_LOG_FILE && process.env.HOME) {
  const logPath = `${process.env.HOME}/Library/Logs/gemini-space-stdio.log`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    process.env.GEMINI_SPACE_LOG_FILE = logPath;
  } catch {
    // 忽略：日志不是必需能力。
  }
}

await runEntrypoint("../src/tool-cli.ts", "../dist/tool-cli.js");

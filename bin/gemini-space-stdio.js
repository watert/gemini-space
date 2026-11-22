#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runEntrypoint } from "./run-entrypoint.js";

// stdio 的 stdout 只承载 JSON-RPC；在进入入口模块前先把 console.log 改道 stderr。
console.log = (...args) => console.error(...args);

// 有些 MCP 客户端（如 Gemini 桌面 app）不解析 `env VAR=value cmd` 前缀，
// 因此日志路径由 wrapper 兜底，而不是依赖调用方注入环境变量。
if (!process.env.GEMINI_SPACE_LOG_FILE && process.env.HOME) {
  const logPath = `${process.env.HOME}/Library/Logs/gemini-space-stdio.log`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    process.env.GEMINI_SPACE_LOG_FILE = logPath;
  } catch {
    // 建目录失败时退回 stderr，不影响协议。
  }
}

await runEntrypoint("../src/stdio-main.ts", "../dist/stdio-main.js");
